import { getDb } from "@/lib/db";
import { normalizeWhitespace } from "@/lib/utils";

interface CatalogRow {
  sku: string;
  name: string;
  normalized_name: string;
  brand: string | null;
  family_tokens_json: string;
}

export interface ClassifiedAlternatives {
  internalAlternatives: number;
  externalCompetitors: number;
}

let cache: { loadedAt: number; rows: CatalogRow[] } | null = null;
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
  const seenInternal = new Set<string>();
  let external = 0;

  for (const mentionRaw of mentions) {
    const mention = normalize(mentionRaw);
    if (!mention) {
      continue;
    }

    if (isPrincipalMention(mention, principalSet)) {
      continue;
    }

    const match = findCatalogMatch(mention, catalog);
    if (match) {
      seenInternal.add(match.sku);
    } else {
      external += 1;
    }
  }

  return {
    internalAlternatives: seenInternal.size,
    externalCompetitors: external,
  };
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

function findCatalogMatch(mention: string, catalog: CatalogRow[]): CatalogRow | null {
  const tokens = mention.split(" ").filter(Boolean);
  if (!tokens.length) {
    return null;
  }

  // Rule: brand-only mentions do not count.
  if (tokens.length === 1) {
    return null;
  }

  for (const row of catalog) {
    const normalized = row.normalized_name;
    if (!normalized) {
      continue;
    }

    if (normalized.includes(mention) || mention.includes(normalized)) {
      return row;
    }

    const familyTokens = parseTokens(row.family_tokens_json);
    if (familyTokens.length >= 2) {
      const matches = familyTokens.filter((token) => mention.includes(token));
      if (matches.length >= 2) {
        return row;
      }
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
