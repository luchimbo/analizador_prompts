import fs from "node:fs";
import path from "node:path";
import process from "node:process";

import { createClient } from "@libsql/client";
import XLSX from "xlsx";

function parseEnv(filePath) {
  const raw = fs.readFileSync(filePath, "utf8");
  const entries = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"))
    .map((line) => {
      const separator = line.indexOf("=");
      if (separator === -1) {
        return null;
      }
      return [line.slice(0, separator).trim(), line.slice(separator + 1).trim()];
    })
    .filter(Boolean);

  return Object.fromEntries(entries);
}

function normalizeText(value) {
  if (!value) {
    return "";
  }
  return String(value)
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const BRAND_ALIASES = [
  ["midiplus", ["midiplus", "midi plus"]],
  ["arturia", ["arturia"]],
  ["meike", ["meike"]],
  ["korg", ["korg"]],
  ["novation", ["novation"]],
  ["akai", ["akai", "akai professional"]],
  ["behringer", ["behringer"]],
  ["m-audio", ["m-audio", "maudio"]],
  ["focusrite", ["focusrite"]],
  ["alesis", ["alesis"]],
  ["casio", ["casio"]],
  ["yamaha", ["yamaha"]],
  ["roland", ["roland"]],
  ["nux", ["nux"]],
  ["mooer", ["mooer"]],
  ["fender", ["fender"]],
  ["marshall", ["marshall"]],
  ["shure", ["shure"]],
  ["audio-technica", ["audio technica", "audio-technica"]],
  ["sennheiser", ["sennheiser"]],
  ["jbl", ["jbl"]],
  ["krk", ["krk"]],
];

const GENERIC_TOKENS = new Set([
  "auriculares",
  "auricular",
  "teclado",
  "teclados",
  "controlador",
  "midi",
  "musical",
  "microfono",
  "microfonos",
  "monitor",
  "monitores",
  "parlante",
  "parlantes",
  "interfaz",
  "interface",
  "cable",
  "pedal",
  "guitarra",
  "bajo",
  "bateria",
  "drum",
  "audio",
  "usb",
  "linea",
  "activo",
  "activa",
  "combo",
  "kit",
  "pack",
  "nvo",
  "nuevo",
  "black",
  "white",
  "pro",
  "mini",
]);

function inferBrand(name) {
  const normalized = normalizeText(name);
  if (!normalized) {
    return null;
  }

  let bestMatch = null;
  for (const [brand, aliases] of BRAND_ALIASES) {
    for (const alias of aliases) {
      const normalizedAlias = normalizeText(alias);
      if (!normalizedAlias) continue;
      const padded = ` ${normalized} `;
      if (padded.includes(` ${normalizedAlias} `)) {
        if (!bestMatch || normalizedAlias.length > bestMatch.aliasLength) {
          bestMatch = { brand, aliasLength: normalizedAlias.length };
        }
      }
    }
  }

  if (bestMatch) {
    return bestMatch.brand;
  }

  const tokens = normalized.split(" ").filter(Boolean);
  for (const token of tokens.slice(0, 3)) {
    if (token.length < 3) continue;
    if (GENERIC_TOKENS.has(token)) continue;
    return token;
  }

  return null;
}

function buildFamilyTokens(name) {
  const normalized = normalizeText(name);
  const tokens = normalized.split(" ").filter(Boolean);
  if (!tokens.length) {
    return [];
  }

  const meaningful = tokens.filter((token) => token.length >= 3 && !/^\d+$/.test(token));
  const unique = Array.from(new Set(meaningful));
  return unique.slice(0, 8);
}

async function main() {
  const workbookPathArg = process.argv[2];
  if (!workbookPathArg) {
    throw new Error("Usage: npm run import:catalog -- \"path/to/catalog.xlsx\"");
  }

  const workbookPath = path.resolve(process.cwd(), workbookPathArg);
  if (!fs.existsSync(workbookPath)) {
    throw new Error(`Catalog file not found: ${workbookPath}`);
  }

  const envPath = path.resolve(process.cwd(), ".env");
  if (!fs.existsSync(envPath)) {
    throw new Error(".env file not found");
  }
  const env = parseEnv(envPath);

  const dbUrl = env.TURSO_DATABASE_URL || "file:./data/ia-product-audit.db";
  const dbToken = env.TURSO_AUTH_TOKEN || undefined;
  const client = createClient({ url: dbUrl, authToken: dbToken });

  await client.batch(
    [
      `
      CREATE TABLE IF NOT EXISTS catalog_products (
        sku TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        normalized_name TEXT NOT NULL,
        brand TEXT,
        family_tokens_json TEXT NOT NULL,
        source_sheet TEXT,
        is_active INTEGER NOT NULL DEFAULT 1,
        updated_at TEXT NOT NULL
      )
      `,
      `CREATE INDEX IF NOT EXISTS idx_catalog_normalized_name ON catalog_products(normalized_name)`,
      `CREATE INDEX IF NOT EXISTS idx_catalog_brand ON catalog_products(brand)`,
    ],
    "write",
  );

  const workbook = XLSX.readFile(workbookPath, { cellDates: false });
  const firstSheetName = workbook.SheetNames[0];
  const sheet = workbook.Sheets[firstSheetName];
  const rows = XLSX.utils.sheet_to_json(sheet, { defval: "" });

  const now = new Date().toISOString();
  let imported = 0;

  for (const row of rows) {
    const sku = String(row.SKU || "").trim();
    const name = String(row.Nombre || "").trim();
    if (!sku || !name) {
      continue;
    }

    const normalizedName = normalizeText(name);
    const brand = inferBrand(name);
    const familyTokens = buildFamilyTokens(name);

    await client.execute({
      sql: `
        INSERT INTO catalog_products (
          sku, name, normalized_name, brand, family_tokens_json, source_sheet, is_active, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, 1, ?)
        ON CONFLICT(sku) DO UPDATE SET
          name = excluded.name,
          normalized_name = excluded.normalized_name,
          brand = excluded.brand,
          family_tokens_json = excluded.family_tokens_json,
          source_sheet = excluded.source_sheet,
          is_active = 1,
          updated_at = excluded.updated_at
      `,
      args: [sku, name, normalizedName, brand, JSON.stringify(familyTokens), firstSheetName, now],
    });
    imported += 1;
  }

  console.log(`Catalog import completed. Rows imported: ${imported}`);
  await client.close();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
