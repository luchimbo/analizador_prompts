import { getDb } from "@/lib/db";
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

let cache: { loadedAt: number; rows: CatalogRow[] } | null = null;
let overrideCache: { loadedAt: number; rows: BrandOverrideRow[] } | null = null;
const CACHE_TTL_MS = 5 * 60 * 1000;

export async function classifyAlternativeMentions({
  mentions,
  principalAliases,
}: {
  mentions: string[];
  principalAliases: string[];
}): Promise<ClassifiedAlternatives> {
  const catalog = await getCatalogRows();
  const principalSet = new Set(principalAliases.map((alias) => normalize(alias)).filter(Boolean));
  const brandRules = await getBrandOverrides();
  const brandRuleMap = new Map(brandRules.map((rule) => [rule.brand, rule.classification]));
  const seenInternal = new Set<string>();
  const classifications: AlternativeClassification[] = [];
  let external = 0;

  for (const mentionRaw of mentions) {
    const mention = normalize(mentionRaw);
    if (!mention) {
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
      classifications.push({
        mention: mentionRaw,
        normalizedMention: mention,
        classification: "ignored",
        reason: "brand_only",
      });
      continue;
    }

    const match = findCatalogMatch(mention, catalog);
    if (match) {
      const normalizedBrand = normalize(match.brand ?? "");
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
      external += 1;
      classifications.push({
        mention: mentionRaw,
        normalizedMention: mention,
        classification: "external",
        reason: "unmatched",
      });
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

    const profile = parseJson<{ productName?: string; aliases?: string[] }>(row.product_profile_json, {});
    const principalAliases = [profile.productName ?? "", ...(Array.isArray(profile.aliases) ? profile.aliases : [])].filter(Boolean);

    const parsedMentions = parseJson<string[]>(row.alternative_mentions_json, [])
      .map((item) => normalizeWhitespace(item))
      .filter(Boolean);
    const mentions = parsedMentions.length ? uniquePreserveOrder(parsedMentions) : extractAlternativeMentions(String(row.raw_response ?? ""), principalAliases);

    const alternatives = await classifyAlternativeMentions({
      mentions,
      principalAliases,
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
