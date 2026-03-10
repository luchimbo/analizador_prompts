import { mkdirSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { createClient, type Client } from "@libsql/client";

import { env } from "@/lib/env";

declare global {
  // eslint-disable-next-line no-var
  var __iaProductAuditDbClient__: Client | undefined;
  // eslint-disable-next-line no-var
  var __iaProductAuditSchemaPromise__: Promise<void> | undefined;
}

const databaseUrl = resolveDatabaseUrl(env.tursoDatabaseUrl);

const client = globalThis.__iaProductAuditDbClient__ ?? createClient({
  url: databaseUrl,
  authToken: env.tursoAuthToken || undefined,
});

if (!globalThis.__iaProductAuditDbClient__) {
  globalThis.__iaProductAuditDbClient__ = client;
}

export async function getDb(): Promise<Client> {
  await ensureDatabaseSchema();
  return client;
}

export async function ensureDatabaseSchema(): Promise<void> {
  if (!globalThis.__iaProductAuditSchemaPromise__) {
    globalThis.__iaProductAuditSchemaPromise__ = client
      .batch(
        [
          `
          CREATE TABLE IF NOT EXISTS products (
            product_id TEXT PRIMARY KEY,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            language TEXT NOT NULL,
            market TEXT NOT NULL,
            latest_run_id TEXT,
            locked_audited_provider TEXT,
            locked_audited_model TEXT,
            source_url TEXT NOT NULL,
            canonical_url TEXT NOT NULL,
            domain TEXT NOT NULL,
            product_name TEXT NOT NULL,
            brand_name TEXT,
            store_name TEXT,
            category TEXT,
            page_title TEXT,
            meta_description TEXT,
            aliases_json TEXT NOT NULL,
            vendor_aliases_json TEXT NOT NULL,
            competitor_names_json TEXT NOT NULL,
            extraction_notes_json TEXT NOT NULL,
            prompt_bank_json TEXT
          )
          `,
          `CREATE INDEX IF NOT EXISTS idx_products_updated_at ON products(updated_at DESC)`,
          `CREATE INDEX IF NOT EXISTS idx_products_canonical_url ON products(canonical_url)`,
          `CREATE INDEX IF NOT EXISTS idx_products_source_url ON products(source_url)`,
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
          `
          CREATE TABLE IF NOT EXISTS catalog_brand_overrides (
            brand TEXT PRIMARY KEY,
            classification TEXT NOT NULL,
            updated_at TEXT NOT NULL
          )
          `,
          `CREATE INDEX IF NOT EXISTS idx_catalog_brand_overrides_classification ON catalog_brand_overrides(classification)`,
          `
          CREATE TABLE IF NOT EXISTS runs (
            run_id TEXT PRIMARY KEY,
            product_id TEXT,
            status TEXT NOT NULL,
            created_at TEXT NOT NULL,
            audited_provider TEXT NOT NULL,
            audited_model TEXT NOT NULL,
            language TEXT NOT NULL,
            market TEXT NOT NULL,
            enable_web_search INTEGER NOT NULL,
            verify_detected_urls INTEGER NOT NULL,
            product_name TEXT NOT NULL,
            product_profile_json TEXT NOT NULL,
            prompt_bank_json TEXT NOT NULL,
            summary_json TEXT,
            export_path TEXT,
            error_message TEXT
          )
          `,
          `CREATE INDEX IF NOT EXISTS idx_runs_created_at ON runs(created_at DESC)`,
          `CREATE INDEX IF NOT EXISTS idx_runs_product_id ON runs(product_id, created_at DESC)`,
          `
          CREATE TABLE IF NOT EXISTS run_results (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            run_id TEXT NOT NULL,
            prompt_order INTEGER NOT NULL,
            request_id TEXT,
            prompt_id TEXT NOT NULL,
            prompt_type TEXT NOT NULL,
            prompt_text TEXT NOT NULL,
            raw_response TEXT NOT NULL,
            detected_urls_json TEXT NOT NULL,
            cited_urls_json TEXT NOT NULL,
            model_provider TEXT NOT NULL,
            model_name TEXT NOT NULL,
            latency_ms INTEGER NOT NULL,
            created_at TEXT NOT NULL,
            product_hit INTEGER NOT NULL,
            vendor_hit INTEGER NOT NULL,
            exact_url_accuracy INTEGER NOT NULL,
            internal_alternatives INTEGER NOT NULL DEFAULT 0,
            external_competitors INTEGER NOT NULL DEFAULT 0,
            alternative_mentions_json TEXT,
            product_competitors INTEGER NOT NULL,
            rank INTEGER NOT NULL,
            evidence_snippet TEXT,
            judge_provider TEXT,
            judge_model TEXT,
            judge_notes TEXT,
            FOREIGN KEY(run_id) REFERENCES runs(run_id)
          )
          `,
          `CREATE INDEX IF NOT EXISTS idx_run_results_run_id ON run_results(run_id, prompt_order ASC)`,
        ],
        "write",
      )
      .then(async () => {
        await ensureColumn("run_results", "request_id", `ALTER TABLE run_results ADD COLUMN request_id TEXT`);
        await ensureColumn("run_results", "internal_alternatives", `ALTER TABLE run_results ADD COLUMN internal_alternatives INTEGER NOT NULL DEFAULT 0`);
        await ensureColumn("run_results", "external_competitors", `ALTER TABLE run_results ADD COLUMN external_competitors INTEGER NOT NULL DEFAULT 0`);
        await ensureColumn("run_results", "alternative_mentions_json", `ALTER TABLE run_results ADD COLUMN alternative_mentions_json TEXT`);
        await ensureColumn("products", "locked_audited_provider", `ALTER TABLE products ADD COLUMN locked_audited_provider TEXT`);
        await ensureColumn("products", "locked_audited_model", `ALTER TABLE products ADD COLUMN locked_audited_model TEXT`);
        await client.execute(`CREATE INDEX IF NOT EXISTS idx_run_results_request_id ON run_results(request_id)`);
      })
      .then(() => undefined);
  }

  await globalThis.__iaProductAuditSchemaPromise__;
}

async function ensureColumn(tableName: string, columnName: string, statement: string): Promise<void> {
  try {
    await client.execute(statement);
  } catch (error) {
    if (isDuplicateColumnError(error, columnName)) {
      return;
    }
    throw error;
  }
}

function isDuplicateColumnError(error: unknown, columnName: string): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  const message = error.message.toLowerCase();
  return message.includes(`duplicate column name: ${columnName}`.toLowerCase());
}

function resolveDatabaseUrl(rawUrl: string): string {
  if (!rawUrl.startsWith("file:")) {
    return rawUrl;
  }

  const relativePath = rawUrl.slice("file:".length) || "./data/ia-product-audit.db";
  const resolvedPath = path.resolve(process.cwd(), relativePath);
  mkdirSync(path.dirname(resolvedPath), { recursive: true });
  return pathToFileURL(resolvedPath).toString();
}
