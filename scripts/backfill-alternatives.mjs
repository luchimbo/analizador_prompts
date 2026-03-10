import fs from "node:fs";

import { createClient } from "@libsql/client";

function parseEnv(filePath) {
  const raw = fs.readFileSync(filePath, "utf8");
  const pairs = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"))
    .map((line) => {
      const idx = line.indexOf("=");
      if (idx === -1) return null;
      return [line.slice(0, idx).trim(), line.slice(idx + 1).trim()];
    })
    .filter(Boolean);
  return Object.fromEntries(pairs);
}

function normalize(value) {
  return String(value || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function unique(values) {
  const seen = new Set();
  const output = [];
  for (const value of values) {
    const cleaned = String(value || "").trim();
    if (!cleaned) continue;
    const key = cleaned.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(cleaned);
  }
  return output;
}

function parseJson(value, fallback) {
  if (value === null || value === undefined) return fallback;
  try {
    return JSON.parse(String(value));
  } catch {
    return fallback;
  }
}

function extractAlternativeMentions(responseText, principalAliases) {
  const lines = String(responseText || "").split(/\r?\n/);
  const mentions = [];
  const pattern = /^\s*(?:[-*]|\d+[).])\s+(?<text>.+)$/;
  const normalizedPrincipal = principalAliases.map(normalize).filter(Boolean);

  for (const line of lines) {
    const match = line.match(pattern);
    if (!match?.groups?.text) continue;
    const text = match.groups.text.trim();
    const n = normalize(text);
    if (!n) continue;
    if (normalizedPrincipal.some((alias) => n.includes(alias) || alias.includes(n))) continue;
    mentions.push(text);
  }
  return unique(mentions);
}

function findCatalogMatch(mention, catalogRows) {
  const normalizedMention = normalize(mention);
  const tokens = normalizedMention.split(" ").filter(Boolean);
  if (tokens.length <= 1) return null; // brand-only ignored

  for (const row of catalogRows) {
    const normalizedName = row.normalized_name;
    if (!normalizedName) continue;
    if (normalizedName.includes(normalizedMention) || normalizedMention.includes(normalizedName)) return row;

    const familyTokens = parseJson(row.family_tokens_json, []).map(normalize).filter(Boolean);
    if (familyTokens.length >= 2) {
      const matches = familyTokens.filter((token) => normalizedMention.includes(token));
      if (matches.length >= 2) return row;
    }
  }
  return null;
}

async function ensureColumns(client) {
  const alters = [
    "ALTER TABLE run_results ADD COLUMN internal_alternatives INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE run_results ADD COLUMN external_competitors INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE run_results ADD COLUMN alternative_mentions_json TEXT",
  ];
  for (const sql of alters) {
    try {
      await client.execute(sql);
    } catch (error) {
      if (!String(error?.message || "").toLowerCase().includes("duplicate column name")) throw error;
    }
  }
}

async function main() {
  const env = parseEnv(".env");
  const client = createClient({
    url: env.TURSO_DATABASE_URL || "file:./data/ia-product-audit.db",
    authToken: env.TURSO_AUTH_TOKEN || undefined,
  });

  await ensureColumns(client);

  const catalogResult = await client.execute(
    "SELECT sku, normalized_name, family_tokens_json FROM catalog_products WHERE is_active = 1",
  );
  const catalogRows = catalogResult.rows.map((row) => ({
    sku: String(row.sku || ""),
    normalized_name: normalize(row.normalized_name),
    family_tokens_json: String(row.family_tokens_json || "[]"),
  }));

  const result = await client.execute(`
    SELECT rr.id, rr.raw_response, rr.product_hit, rr.product_competitors, r.product_profile_json
    FROM run_results rr
    JOIN runs r ON r.run_id = rr.run_id
  `);

  let updated = 0;
  for (const row of result.rows) {
    const id = Number(row.id);
    const productHit = Number(row.product_hit || 0);
    const profile = parseJson(row.product_profile_json, {});
    const principalAliases = unique([profile.productName, ...(Array.isArray(profile.aliases) ? profile.aliases : [])]);
    const mentions = extractAlternativeMentions(row.raw_response, principalAliases);

    let internalAlternatives = 0;
    let externalCompetitors = 0;

    if (productHit) {
      const seenInternalSku = new Set();
      for (const mention of mentions) {
        const match = findCatalogMatch(mention, catalogRows);
        if (match) {
          seenInternalSku.add(match.sku);
        } else {
          externalCompetitors += 1;
        }
      }
      internalAlternatives = seenInternalSku.size;
    } else {
      // preserve old behavior as external fallback when no hit and no mentions
      externalCompetitors = mentions.length ? mentions.length : Number(row.product_competitors || 0);
    }

    await client.execute({
      sql: `
        UPDATE run_results
        SET internal_alternatives = ?,
            external_competitors = ?,
            alternative_mentions_json = ?
        WHERE id = ?
      `,
      args: [internalAlternatives, externalCompetitors, JSON.stringify(mentions), id],
    });
    updated += 1;
  }

  console.log(`Backfill completed. Rows updated: ${updated}`);
  await client.close();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
