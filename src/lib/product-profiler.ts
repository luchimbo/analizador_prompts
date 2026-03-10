import * as cheerio from "cheerio";

import type { ProductProfile, ProductProfileOverrides } from "@/lib/types";
import { hostToStoreName, normalizeUrl, normalizeWhitespace, uniquePreserveOrder } from "@/lib/utils";

export async function buildProductProfile(productUrl: string, overrides: ProductProfileOverrides = {}): Promise<ProductProfile> {
  const response = await fetch(productUrl, {
    headers: {
      "user-agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
      "accept-language": "es-AR,es;q=0.9,en;q=0.8",
    },
    cache: "no-store",
    redirect: "follow",
  });

  if (!response.ok) {
    throw new Error(`No se pudo leer la URL del producto (${response.status})`);
  }

  const html = await response.text();
  const finalUrl = response.url;
  const url = new URL(finalUrl);
  const domain = url.hostname.toLowerCase();
  const $ = cheerio.load(html);
  const extractionNotes: string[] = [];

  const pageTitle = normalizeWhitespace($("title").first().text()) || null;
  const h1 = normalizeWhitespace($("h1").first().text()) || null;
  const canonicalUrl = $("link[rel='canonical']").attr("href") || finalUrl;
  const metaDescription = normalizeWhitespace($("meta[name='description']").attr("content")) || null;
  const ogTitle = normalizeWhitespace($("meta[property='og:title']").attr("content")) || null;

  const productSchema = extractBestProductSchema($, [h1, ogTitle, pageTitle]);
  const organizationSchema = extractSchemaObject($, "Organization");

  const productName = firstNonEmpty(
    overrides.productName,
    h1,
    ogTitle,
    schemaValue(productSchema, "name"),
    pageTitle,
  );

  if (!productName) {
    throw new Error("No se pudo extraer un nombre de producto util desde la URL");
  }

  const brandName = firstNonEmpty(overrides.brandName, extractBrandName(productSchema), $("meta[property='product:brand']").attr("content"));
  const storeName = firstNonEmpty(overrides.storeName, schemaValue(organizationSchema, "name"), hostToStoreName(domain));
  const category = firstNonEmpty(overrides.category, schemaValue(productSchema, "category"), extractBreadcrumbCategory($));

  const aliases = buildAliases(productName, brandName ?? undefined, overrides.aliases ?? []);
  const vendorAliases = uniquePreserveOrder([...(overrides.vendorAliases ?? []), storeName ?? "", brandName ?? ""]);
  const competitorNames = uniquePreserveOrder(overrides.competitorNames ?? []);

  if (productSchema) extractionNotes.push("Product schema detected");
  if (organizationSchema) extractionNotes.push("Organization schema detected");
  if (Object.keys(overrides).length > 0) extractionNotes.push("Manual overrides applied");

  return {
    sourceUrl: productUrl,
    canonicalUrl: normalizeUrl(overrides.canonicalUrl ?? canonicalUrl),
    domain,
    productName,
    brandName: brandName ?? inferBrandFromProductName(productName) ?? null,
    storeName: storeName ?? null,
    category: category ?? null,
    pageTitle,
    metaDescription,
    aliases,
    vendorAliases,
    competitorNames,
    extractionNotes,
  };
}

function extractBestProductSchema($: cheerio.CheerioAPI, references: Array<string | null | undefined>): Record<string, unknown> | null {
  const candidates = extractSchemaObjects($, "Product");
  if (!candidates.length) {
    return null;
  }

  const referenceTokens = tokenizeForMatch(references.join(" "));
  if (!referenceTokens.length) {
    return candidates[0];
  }

  let best = candidates[0];
  let bestScore = -1;
  for (const candidate of candidates) {
    const candidateName = schemaValue(candidate, "name") || "";
    const candidateTokens = tokenizeForMatch(candidateName);
    if (!candidateTokens.length) {
      continue;
    }

    let score = 0;
    for (const token of candidateTokens) {
      if (referenceTokens.includes(token)) {
        score += 1;
      }
    }

    if (score > bestScore) {
      best = candidate;
      bestScore = score;
    }
  }

  return best;
}

function extractSchemaObject($: cheerio.CheerioAPI, schemaType: string): Record<string, unknown> | null {
  const candidates = extractSchemaObjects($, schemaType);
  return candidates[0] ?? null;
}

function extractSchemaObjects($: cheerio.CheerioAPI, schemaType: string): Record<string, unknown>[] {
  const scripts = $("script[type='application/ld+json']")
    .toArray()
    .map((element) => $(element).contents().text())
    .filter(Boolean);

  const candidates: Record<string, unknown>[] = [];
  for (const raw of scripts) {
    try {
      const payload = JSON.parse(raw) as unknown;
      for (const candidate of iterateSchemaItems(payload)) {
        const candidateType = candidate["@type"];
        if (Array.isArray(candidateType) && candidateType.includes(schemaType)) {
          candidates.push(candidate);
        }
        if (candidateType === schemaType) {
          candidates.push(candidate);
        }
      }
    } catch {
      continue;
    }
  }

  return candidates;
}

function* iterateSchemaItems(payload: unknown): Generator<Record<string, unknown>> {
  if (Array.isArray(payload)) {
    for (const item of payload) {
      yield* iterateSchemaItems(item);
    }
    return;
  }

  if (!payload || typeof payload !== "object") {
    return;
  }

  const record = payload as Record<string, unknown>;
  const graph = record["@graph"];
  if (Array.isArray(graph)) {
    for (const item of graph) {
      yield* iterateSchemaItems(item);
    }
    return;
  }

  yield record;
}

function schemaValue(schema: Record<string, unknown> | null, key: string): string | undefined {
  if (!schema) {
    return undefined;
  }

  const value = schema[key];
  if (typeof value === "string") {
    return normalizeWhitespace(value);
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (typeof record.name === "string") {
      return normalizeWhitespace(record.name);
    }
  }
  return undefined;
}

function extractBrandName(schema: Record<string, unknown> | null): string | undefined {
  if (!schema) {
    return undefined;
  }
  const brand = schema.brand;
  if (typeof brand === "string") {
    return normalizeWhitespace(brand);
  }
  if (brand && typeof brand === "object") {
    const record = brand as Record<string, unknown>;
    if (typeof record.name === "string") {
      return normalizeWhitespace(record.name);
    }
  }
  return undefined;
}

function extractBreadcrumbCategory($: cheerio.CheerioAPI): string | undefined {
  const items = $("nav[aria-label*='breadcrumb'] a, .breadcrumb a")
    .toArray()
    .map((element) => normalizeWhitespace($(element).text()))
    .filter(Boolean);

  return items.length >= 2 ? items[items.length - 2] : undefined;
}

function buildAliases(productName: string, brandName: string | undefined, manualAliases: string[]): string[] {
  const candidates = [productName];
  if (brandName && productName.toLowerCase().startsWith(brandName.toLowerCase())) {
    candidates.push(productName.slice(brandName.length).trim().replace(/^[-\s]+/, ""));
  }
  candidates.push(productName.replace(/-/g, " "));
  candidates.push(...manualAliases);
  return uniquePreserveOrder(candidates);
}

function firstNonEmpty(...values: Array<string | null | undefined>): string | undefined {
  for (const value of values) {
    const cleaned = normalizeWhitespace(value);
    if (cleaned) {
      return cleaned;
    }
  }
  return undefined;
}

function tokenizeForMatch(value: string): string[] {
  const normalized = normalizeWhitespace(value)
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (!normalized) {
    return [];
  }

  return normalized.split(" ").filter((token) => token.length > 1);
}

function inferBrandFromProductName(productName: string): string | undefined {
  const cleaned = normalizeWhitespace(productName);
  if (!cleaned) {
    return undefined;
  }

  const firstToken = cleaned.split(" ")[0];
  if (!firstToken) {
    return undefined;
  }

  // Ignore purely numeric tokens.
  if (/^\d+$/.test(firstToken)) {
    return undefined;
  }

  return firstToken;
}
