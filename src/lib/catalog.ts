import { getDb } from "@/lib/db";
import { buildProductAliases } from "@/lib/product-aliases";
import type { AlternativeClassification } from "@/lib/types";
import { normalizeWhitespace } from "@/lib/utils";

interface CatalogRow {
  sku: string;
  name: string;
  normalized_name: string;
  brand: string | null;
  family_tokens_json: string;
}

type BrandClassification = "internal" | "external";

interface BrandOverrideRow {
  brand: string;
  classification: BrandClassification;
}

export interface CatalogBrandRule {
  brand: string;
  skuCount: number;
  classification: BrandClassification;
  source: "default" | "override";
}

const LIST_PATTERN = /^\s*(?:[-*]|\d+[).])\s+(?<text>.+)$/;

export interface ClassifiedAlternatives {
  internalAlternatives: number;
  externalCompetitors: number;
  classifications: AlternativeClassification[];
}

const GENERIC_BRAND_STOPWORDS = new Set([
  "accesorio",
  "accesorios",
  "activo",
  "activa",
  "argentina",
  "atril",
  "audio",
  "basico",
  "bateria",
  "black",
  "bluetooth",
  "brazo",
  "busca",
  "busca",
  "camara",
  "canciones",
  "categoria",
  "combo",
  "comparativa",
  "condensador",
  "consejos",
  "controlador",
  "criolla",
  "cuotas",
  "digital",
  "drum",
  "economica",
  "ejemplo",
  "enlace",
  "envios",
  "estudio",
  "funda",
  "gama",
  "gamer",
  "grabador",
  "ideal",
  "interfaz",
  "kit",
  "libre",
  "linea",
  "lista",
  "mercado",
  "microfono",
  "microfonos",
  "midi",
  "mini",
  "mochila",
  "modelo",
  "monitor",
  "monitores",
  "mouse",
  "mousepad",
  "musical",
  "musicamia",
  "notas",
  "nuevo",
  "nvo",
  "opciones",
  "organo",
  "pack",
  "parlante",
  "parlantes",
  "pedal",
  "piano",
  "pie",
  "placa",
  "precio",
  "precios",
  "principiante",
  "pro",
  "recomendada",
  "recomendado",
  "reproducir",
  "sampler",
  "secuenciador",
  "sentitivo",
  "shop",
  "soporte",
  "song",
  "store",
  "teclado",
  "teclados",
  "tienda",
  "tiendas",
  "todomusica",
  "usb",
  "verifica",
  "white",
]);

let cache: { loadedAt: number; rows: CatalogRow[] } | null = null;
let overrideCache: { loadedAt: number; rows: BrandOverrideRow[] } | null = null;
const CACHE_TTL_MS = 5 * 60 * 1000;

export async function classifyAlternativeMentions({
  mentions,
  principalAliases,
  ignoredAliases = [],
  responseText,
}: {
  mentions: string[];
  principalAliases: string[];
  ignoredAliases?: string[];
  responseText?: string;
}): Promise<ClassifiedAlternatives> {
  const catalog = await getCatalogRows();
  const principalSet = new Set(principalAliases.map((alias) => normalize(alias)).filter(Boolean));
  const ignoredSet = new Set(ignoredAliases.map((alias) => normalize(alias)).filter(Boolean));
  const brandRules = await getBrandOverrides();
  const knownBrandMap = buildKnownBrandMap(catalog, brandRules);
  const brandRuleMap = new Map(brandRules.map((rule) => [rule.brand, rule.classification]));
  const heuristicBrandCandidates = responseText
    ? extractKnownBrandCandidatesFromResponse(responseText, knownBrandMap, principalSet, ignoredSet)
    : [];
  const mentionInputs = uniquePreserveOrder([...mentions, ...heuristicBrandCandidates]).sort((left, right) => {
    const tokenDelta = tokenize(right).length - tokenize(left).length;
    if (tokenDelta !== 0) {
      return tokenDelta;
    }
    return right.length - left.length;
  });
  const seenInternal = new Set<string>();
  const seenCoveredBrands = new Set<string>();
  const classifications: AlternativeClassification[] = [];
  let external = 0;

  for (const mentionRaw of mentionInputs) {
    const mention = normalize(mentionRaw);
    if (!mention) {
      continue;
    }

    if (isIgnoredEntityMention(mention, ignoredSet)) {
      classifications.push({
        mention: mentionRaw,
        normalizedMention: mention,
        classification: "ignored",
        reason: "ignored_entity",
      });
      continue;
    }

    if (isPrincipalMention(mention, principalSet)) {
      classifications.push({
        mention: mentionRaw,
        normalizedMention: mention,
        classification: "ignored",
        reason: "principal_mention",
      });
      continue;
    }

    if (tokenize(mention).length === 1) {
      const singleTokenClassification = classifySingleTokenMention({
        mentionRaw,
        mention,
        knownBrandMap,
        brandRuleMap,
        coveredBrands: seenCoveredBrands,
      });
      classifications.push(singleTokenClassification.classification);
      if (singleTokenClassification.isExternal) {
        external += 1;
      }
      continue;
    }

    const match = findCatalogMatch(mention, catalog);
    if (match) {
      const normalizedBrand = normalize(match.brand ?? "");
      if (normalizedBrand) {
        seenCoveredBrands.add(normalizedBrand);
      }
      const classification = normalizedBrand ? brandRuleMap.get(normalizedBrand) ?? "internal" : "internal";
      if (classification === "external") {
        external += 1;
        classifications.push({
          mention: mentionRaw,
          normalizedMention: mention,
          classification: "external",
          reason: normalizedBrand ? "brand_override" : "catalog_match",
          matchedSku: match.sku,
          matchedName: match.name,
          matchedBrand: match.brand,
        });
      } else {
        seenInternal.add(match.sku);
        classifications.push({
          mention: mentionRaw,
          normalizedMention: mention,
          classification: "internal",
          reason: "catalog_match",
          matchedSku: match.sku,
          matchedName: match.name,
          matchedBrand: match.brand,
        });
      }
    } else {
      const unmatchedClassification = classifyUnmatchedMention({
        mentionRaw,
        mention,
        knownBrandMap,
        coveredBrands: seenCoveredBrands,
        principalSet,
        ignoredSet,
      });
      classifications.push(unmatchedClassification.classification);
      if (unmatchedClassification.isExternal) {
        external += 1;
      }
    }
  }

  return {
    internalAlternatives: seenInternal.size,
    externalCompetitors: external,
    classifications,
  };
}

export async function listCatalogBrandRules(): Promise<CatalogBrandRule[]> {
  const db = await getDb();
  const [brandsResult, overrides] = await Promise.all([
    db.execute(`
      SELECT brand, COUNT(*) AS sku_count
      FROM catalog_products
      WHERE is_active = 1
        AND brand IS NOT NULL
        AND TRIM(brand) <> ''
      GROUP BY brand
      ORDER BY sku_count DESC, brand ASC
    `),
    getBrandOverrides(),
  ]);

  const overrideMap = new Map(overrides.map((row) => [row.brand, row.classification]));
  const items: CatalogBrandRule[] = [];

  for (const row of brandsResult.rows) {
    const rawBrand = String(row.brand ?? "").trim();
    if (!rawBrand) {
      continue;
    }
    const normalizedBrand = normalize(rawBrand);
    const override = overrideMap.get(normalizedBrand);
    items.push({
      brand: rawBrand,
      skuCount: Number(row.sku_count ?? 0),
      classification: override ?? "internal",
      source: override ? "override" : "default",
    });
  }

  return items;
}

export async function setCatalogBrandRule(brand: string, classification: BrandClassification): Promise<void> {
  const normalizedBrand = normalize(brand);
  if (!normalizedBrand) {
    throw new Error("Brand is required");
  }

  const db = await getDb();

  if (classification === "internal") {
    await db.execute({
      sql: `DELETE FROM catalog_brand_overrides WHERE brand = ?`,
      args: [normalizedBrand],
    });
  } else {
    await db.execute({
      sql: `
        INSERT INTO catalog_brand_overrides (brand, classification, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(brand) DO UPDATE SET
          classification = excluded.classification,
          updated_at = excluded.updated_at
      `,
      args: [normalizedBrand, classification, new Date().toISOString()],
    });
  }

  clearCatalogCaches();
}

export function clearCatalogCaches(): void {
  cache = null;
  overrideCache = null;
}

export async function reclassifyHistoricalRunResults(): Promise<{ updated: number }> {
  const db = await getDb();
  const result = await db.execute(`
    SELECT rr.id, rr.raw_response, rr.alternative_mentions_json, rr.product_competitors, r.product_profile_json
    FROM run_results rr
    JOIN runs r ON r.run_id = rr.run_id
  `);

  let updated = 0;

  for (const row of result.rows) {
    const id = Number(row.id ?? 0);
    if (!id) {
      continue;
    }

    const profile = parseJson<{ productName?: string; brandName?: string; aliases?: string[]; storeName?: string; vendorAliases?: string[] }>(row.product_profile_json, {});
    const principalAliases = buildProductAliases(profile.productName ?? "", profile.brandName ?? null, Array.isArray(profile.aliases) ? profile.aliases : []);
    const ignoredAliases = [profile.storeName ?? "", ...(Array.isArray(profile.vendorAliases) ? profile.vendorAliases : []), "Mercado Libre", "Musicamia", "TodoMusica", "MasMusica"].filter(Boolean);

    const parsedMentions = parseJson<string[]>(row.alternative_mentions_json, [])
      .map((item) => normalizeWhitespace(item))
      .filter(Boolean);
    const mentions = parsedMentions.length ? uniquePreserveOrder(parsedMentions) : extractAlternativeMentions(String(row.raw_response ?? ""), principalAliases);

    const alternatives = await classifyAlternativeMentions({
      mentions,
      principalAliases,
      ignoredAliases,
      responseText: String(row.raw_response ?? ""),
    });

    const productCompetitors = alternatives.internalAlternatives + alternatives.externalCompetitors;
    const fallbackProductCompetitors = Number(row.product_competitors ?? 0);

    await db.execute({
      sql: `
        UPDATE run_results
        SET internal_alternatives = ?,
            external_competitors = ?,
            alternative_mentions_json = ?,
            alternative_classifications_json = ?,
            product_competitors = ?
        WHERE id = ?
      `,
      args: [
        alternatives.internalAlternatives,
        alternatives.externalCompetitors,
        JSON.stringify(mentions),
        JSON.stringify(alternatives.classifications),
        productCompetitors || fallbackProductCompetitors,
        id,
      ],
    });
    updated += 1;
  }

  return { updated };
}

async function getCatalogRows(): Promise<CatalogRow[]> {
  if (cache && Date.now() - cache.loadedAt < CACHE_TTL_MS) {
    return cache.rows;
  }

  const db = await getDb();
  const result = await db.execute(`
    SELECT sku, name, normalized_name, brand, family_tokens_json
    FROM catalog_products
    WHERE is_active = 1
  `);

  const rows = result.rows.map((row) => ({
    sku: String(row.sku ?? ""),
    name: String(row.name ?? ""),
    normalized_name: String(row.normalized_name ?? ""),
    brand: row.brand ? String(row.brand) : null,
    family_tokens_json: String(row.family_tokens_json ?? "[]"),
  }));

  cache = { loadedAt: Date.now(), rows };
  return rows;
}

async function getBrandOverrides(): Promise<BrandOverrideRow[]> {
  if (overrideCache && Date.now() - overrideCache.loadedAt < CACHE_TTL_MS) {
    return overrideCache.rows;
  }

  const db = await getDb();
  const result = await db.execute(`
    SELECT brand, classification
    FROM catalog_brand_overrides
  `);

  const rows = result.rows
    .map((row) => ({
      brand: normalize(String(row.brand ?? "")),
      classification: (String(row.classification ?? "") === "external" ? "external" : "internal") as BrandClassification,
    }))
    .filter((row) => Boolean(row.brand));

  overrideCache = { loadedAt: Date.now(), rows };
  return rows;
}

function buildKnownBrandMap(catalog: CatalogRow[], overrides: BrandOverrideRow[]): Map<string, string> {
  const brands = new Map<string, string>();

  for (const row of catalog) {
    const normalizedBrand = normalize(row.brand ?? "");
    if (!normalizedBrand || brands.has(normalizedBrand)) {
      continue;
    }
    brands.set(normalizedBrand, row.brand ?? normalizedBrand);
  }

  for (const override of overrides) {
    if (!override.brand || brands.has(override.brand)) {
      continue;
    }
    brands.set(override.brand, override.brand);
  }

  return brands;
}

function extractKnownBrandCandidatesFromResponse(
  responseText: string,
  knownBrandMap: Map<string, string>,
  principalSet: Set<string>,
  ignoredSet: Set<string>,
): string[] {
  const candidates: string[] = [];
  const segments = collectCandidateSegments(responseText);

  for (const segment of segments) {
    const normalizedSegment = normalize(segment);
    if (!normalizedSegment) {
      continue;
    }

    for (const [normalizedBrand, displayBrand] of knownBrandMap.entries()) {
      if (containsPhrase(normalizedSegment, normalizedBrand) && !isPrincipalMention(normalizedBrand, principalSet) && !isIgnoredEntityMention(normalizedBrand, ignoredSet)) {
        candidates.push(displayBrand);
      }
    }
  }

  return uniquePreserveOrder(candidates);
}

function classifySingleTokenMention({
  mentionRaw,
  mention,
  knownBrandMap,
  brandRuleMap,
  coveredBrands,
}: {
  mentionRaw: string;
  mention: string;
  knownBrandMap: Map<string, string>;
  brandRuleMap: Map<string, BrandClassification>;
  coveredBrands: Set<string>;
}): { classification: AlternativeClassification; isExternal: boolean } {
  const knownBrand = knownBrandMap.get(mention);
  if (coveredBrands.has(mention)) {
    return {
      classification: {
        mention: mentionRaw,
        normalizedMention: mention,
        classification: "ignored",
        reason: "duplicate_brand",
        matchedBrand: knownBrand ?? mentionRaw,
      },
      isExternal: false,
    };
  }

  if (knownBrand) {
    const classification = brandRuleMap.get(mention) ?? "internal";
    if (classification === "external") {
      return {
        classification: {
          mention: mentionRaw,
          normalizedMention: mention,
          classification: "external",
          reason: "brand_override",
          matchedBrand: knownBrand,
        },
        isExternal: true,
      };
    }

    return {
      classification: {
        mention: mentionRaw,
        normalizedMention: mention,
        classification: "ignored",
        reason: "brand_only",
        matchedBrand: knownBrand,
      },
      isExternal: false,
    };
  }

  return {
    classification: {
      mention: mentionRaw,
      normalizedMention: mention,
      classification: "ignored",
      reason: "brand_only",
    },
    isExternal: false,
  };
}

function classifyUnmatchedMention({
  mentionRaw,
  mention,
  knownBrandMap,
  coveredBrands,
  principalSet,
  ignoredSet,
}: {
  mentionRaw: string;
  mention: string;
  knownBrandMap: Map<string, string>;
  coveredBrands: Set<string>;
  principalSet: Set<string>;
  ignoredSet: Set<string>;
}): { classification: AlternativeClassification; isExternal: boolean } {
  const inferredBrand = inferBrandFromMention(mentionRaw, mention, knownBrandMap, principalSet, ignoredSet);
  if (!isLikelyProductLikeMention(mentionRaw, mention, knownBrandMap, principalSet, ignoredSet)) {
    return {
      classification: {
        mention: mentionRaw,
        normalizedMention: mention,
        classification: "ignored",
        reason: "ignored_entity",
        matchedBrand: inferredBrand ? knownBrandMap.get(inferredBrand) ?? inferredBrand : null,
      },
      isExternal: false,
    };
  }

  if (inferredBrand) {
    coveredBrands.add(inferredBrand);
  }

  return {
    classification: {
      mention: mentionRaw,
      normalizedMention: mention,
      classification: "external",
      reason: knownBrandMap.has(inferredBrand ?? "") ? "unmatched" : "unknown_brand",
      matchedBrand: inferredBrand ? knownBrandMap.get(inferredBrand) ?? mentionRaw.split(/\s+/)[0] ?? null : null,
    },
    isExternal: true,
  };
}

function findCatalogMatch(mention: string, catalog: CatalogRow[]): CatalogRow | null {
  const mentionTokens = tokenize(mention);
  if (!mentionTokens.length) {
    return null;
  }

  // Rule: brand-only mentions do not count.
  if (mentionTokens.length === 1) {
    return null;
  }

  const mentionExpanded = expandMatchTokens(mentionTokens);
  const mentionCompact = compact(mention);

  for (const row of catalog) {
    const normalized = row.normalized_name;
    if (!normalized) {
      continue;
    }

    const normalizedCompact = compact(normalized);

    if (normalized.includes(mention) || mention.includes(normalized)) {
      return row;
    }

    if (mentionCompact && normalizedCompact && (normalizedCompact.includes(mentionCompact) || mentionCompact.includes(normalizedCompact))) {
      return row;
    }

    const rowTokens = expandMatchTokens(tokenize(normalized));
    const familyTokens = expandMatchTokens(parseTokens(row.family_tokens_json));
    const rowTokenSet = new Set<string>([...rowTokens, ...familyTokens]);
    const overlap = Array.from(mentionExpanded).filter((token) => token.length >= 3 && rowTokenSet.has(token));
    if (overlap.length >= 2) {
      return row;
    }

  }

  return null;
}

function isPrincipalMention(mention: string, principalSet: Set<string>): boolean {
  for (const principal of principalSet) {
    if (!principal) {
      continue;
    }
    if (mention.includes(principal) || principal.includes(mention)) {
      return true;
    }
  }
  return false;
}

function isIgnoredEntityMention(mention: string, ignoredSet: Set<string>): boolean {
  for (const ignored of ignoredSet) {
    if (!ignored) {
      continue;
    }
    if (mention === ignored || mention.includes(ignored) || ignored.includes(mention)) {
      return true;
    }
  }
  return false;
}

function parseTokens(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as string[];
    return Array.isArray(parsed) ? parsed.map((item) => normalize(item)).filter(Boolean) : [];
  } catch {
    return [];
  }
}

function normalize(value: string): string {
  return normalizeWhitespace(value)
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenize(value: string): string[] {
  return normalize(value).split(" ").filter(Boolean);
}

function expandMatchTokens(tokens: string[]): Set<string> {
  const expanded = new Set<string>();
  for (const token of tokens) {
    expanded.add(token);
    expanded.add(compact(token));
  }

  for (let index = 0; index < tokens.length - 1; index += 1) {
    const current = tokens[index];
    const next = tokens[index + 1];
    if (!current || !next) {
      continue;
    }
    if ((/^[a-z]+$/.test(current) && /^\d+[a-z]*$/.test(next)) || (/^\d+[a-z]*$/.test(current) && /^[a-z]+$/.test(next))) {
      expanded.add(`${current}${next}`);
      expanded.add(`${next}${current}`);
    }
  }

  return expanded;
}

function compact(value: string): string {
  return normalize(value).replace(/\s+/g, "");
}

function containsPhrase(haystack: string, needle: string): boolean {
  return Boolean(haystack && needle && ` ${haystack} `.includes(` ${needle} `));
}

function collectCandidateSegments(responseText: string): string[] {
  const segments: string[] = [];

  for (const line of responseText.split(/\r?\n/)) {
    const listText = line.match(LIST_PATTERN)?.groups?.text;
    if (!listText) {
      continue;
    }
    segments.push(normalizeWhitespace(listText));
  }

  return uniquePreserveOrder(segments);
}

function stripOuterPunctuation(value: string): string {
  return value.replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, "");
}

function hasUppercase(value: string): boolean {
  return /[A-ZÁÉÍÓÚÑ]/.test(value);
}

function looksLikeModelToken(value: string): boolean {
  const cleaned = stripOuterPunctuation(value);
  if (!cleaned) {
    return false;
  }
  return /\d/.test(cleaned);
}

function inferBrandFromMention(
  mentionRaw: string,
  mention: string,
  knownBrandMap: Map<string, string>,
  principalSet: Set<string>,
  ignoredSet: Set<string>,
): string | null {
  for (const knownBrand of knownBrandMap.keys()) {
    if (containsPhrase(mention, knownBrand)) {
      return knownBrand;
    }
  }

  const rawTokens = mentionRaw.split(/\s+/).map(stripOuterPunctuation).filter(Boolean);
  const firstToken = rawTokens[0];
  if (!firstToken) {
    return null;
  }

  const normalizedFirst = normalize(firstToken);
  if (!normalizedFirst || GENERIC_BRAND_STOPWORDS.has(normalizedFirst)) {
    return null;
  }
  if (isPrincipalMention(normalizedFirst, principalSet) || isIgnoredEntityMention(normalizedFirst, ignoredSet)) {
    return null;
  }
  if (!hasUppercase(firstToken)) {
    return null;
  }

  return normalizedFirst;
}

function isLikelyProductLikeMention(
  mentionRaw: string,
  mention: string,
  knownBrandMap: Map<string, string>,
  principalSet: Set<string>,
  ignoredSet: Set<string>,
): boolean {
  const tokens = tokenize(mention);
  if (tokens.length < 2) {
    return false;
  }
  if (isIgnoredEntityMention(mention, ignoredSet) || isPrincipalMention(mention, principalSet)) {
    return false;
  }

  const inferredBrand = inferBrandFromMention(mentionRaw, mention, knownBrandMap, principalSet, ignoredSet);
  const rawTokens = mentionRaw.split(/\s+/).map(stripOuterPunctuation).filter(Boolean);
  const hasModelSignal = rawTokens.slice(1).some(looksLikeModelToken);
  if (inferredBrand && hasModelSignal) {
    return true;
  }

  return tokens.length >= 3 && hasModelSignal;
}

function parseJson<T>(value: unknown, fallback: T): T {
  if (value === null || value === undefined) {
    return fallback;
  }

  try {
    return JSON.parse(String(value)) as T;
  } catch {
    return fallback;
  }
}

function extractAlternativeMentions(responseText: string, principalAliases: string[]): string[] {
  const normalizedPrincipal = principalAliases.map((alias) => normalize(alias)).filter(Boolean);
  const mentions: string[] = [];

  for (const line of responseText.split(/\r?\n/)) {
    const matched = line.match(LIST_PATTERN)?.groups?.text;
    if (!matched) {
      continue;
    }

    const mention = normalizeWhitespace(matched);
    const normalizedMention = normalize(mention);
    if (!normalizedMention) {
      continue;
    }
    if (normalizedPrincipal.some((alias) => normalizedMention.includes(alias) || alias.includes(normalizedMention))) {
      continue;
    }

    mentions.push(mention);
  }

  return uniquePreserveOrder(mentions);
}

function uniquePreserveOrder(values: string[]): string[] {
  const output: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const key = value.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    output.push(value);
  }
  return output;
}
