import { randomUUID } from "node:crypto";

import { getDb } from "@/lib/db";
import { validatePromptBank } from "@/lib/prompt-bank";
import type { ProductProfile, PromptBank, SavedProduct } from "@/lib/types";
import { normalizeUrl, normalizeWhitespace } from "@/lib/utils";

declare global {
  // eslint-disable-next-line no-var
  var __iaProductAuditProductRepairPromise__: Promise<void> | undefined;
}

export async function getProductRecord(productId: string): Promise<SavedProduct | null> {
  await ensureProductDataHealth();
  const db = await getDb();
  const result = await db.execute({ sql: `SELECT * FROM products WHERE product_id = ? LIMIT 1`, args: [productId] });
  const row = result.rows[0];
  return row ? mapProductRow(row) : null;
}

export async function listProductRecords(): Promise<SavedProduct[]> {
  await ensureProductDataHealth();
  const db = await getDb();
  const result = await db.execute(`SELECT * FROM products ORDER BY updated_at DESC`);
  return result.rows.map(mapProductRow);
}

export async function upsertProductRecord({
  profile,
  language,
  market,
  promptBank,
}: {
  profile: ProductProfile;
  language: string;
  market: string;
  promptBank?: PromptBank | null;
}): Promise<SavedProduct> {
  await ensureProductDataHealth();
  const db = await getDb();
  const targetCanonical = normalizeUrl(profile.canonicalUrl);
  const targetSource = normalizeUrl(profile.sourceUrl);

  const existingResult = await db.execute({
    sql: `SELECT product_id, created_at, latest_run_id, prompt_bank_json FROM products WHERE canonical_url = ? OR source_url = ? LIMIT 1`,
    args: [targetCanonical, targetSource],
  });
  const existing = existingResult.rows[0];

  const timestamp = new Date().toISOString();
  const nextPromptBank = promptBank ?? parseJson<PromptBank | null>(existing?.prompt_bank_json, null);
  const productId = asNonEmptyString(existing?.product_id) ?? randomUUID();
  const createdAt = asNonEmptyString(existing?.created_at) ?? timestamp;
  const latestRunId = asNullableString(existing?.latest_run_id);

  await db.execute({
    sql: `
      INSERT OR REPLACE INTO products (
        product_id, created_at, updated_at, language, market, latest_run_id,
        source_url, canonical_url, domain, product_name, brand_name, store_name,
        category, page_title, meta_description, aliases_json, vendor_aliases_json,
        competitor_names_json, extraction_notes_json, prompt_bank_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    args: [
      productId,
      createdAt,
      timestamp,
      language,
      market,
      latestRunId,
      targetSource,
      targetCanonical,
      profile.domain,
      profile.productName,
      profile.brandName ?? null,
      profile.storeName ?? null,
      profile.category ?? null,
      profile.pageTitle ?? null,
      profile.metaDescription ?? null,
      JSON.stringify(profile.aliases ?? []),
      JSON.stringify(profile.vendorAliases ?? []),
      JSON.stringify(profile.competitorNames ?? []),
      JSON.stringify(profile.extractionNotes ?? []),
      nextPromptBank ? JSON.stringify(nextPromptBank) : null,
    ],
  });

  const saved = await getProductRecord(productId);
  if (!saved) {
    throw new Error("Could not save product");
  }
  return saved;
}

export async function updateProductPromptBank(productId: string, promptBank: PromptBank): Promise<SavedProduct> {
  await ensureProductDataHealth();
  const db = await getDb();
  const nextPromptBank = validatePromptBank(promptBank);
  const result = await db.execute({
    sql: `UPDATE products SET updated_at = ?, prompt_bank_json = ? WHERE product_id = ?`,
    args: [new Date().toISOString(), JSON.stringify(nextPromptBank), productId],
  });

  if (Number(result.rowsAffected) === 0) {
    throw new Error("Product not found");
  }

  const saved = await getProductRecord(productId);
  if (!saved) {
    throw new Error("Product not found");
  }
  return saved;
}

export async function updateProductPrompt(productId: string, promptId: string, prompt: string): Promise<SavedProduct> {
  await ensureProductDataHealth();
  const product = await getProductRecord(productId);
  if (!product) {
    throw new Error("Product not found");
  }
  if (!product.promptBank) {
    throw new Error("This product does not have a prompt bank yet");
  }

  const normalizedPrompt = normalizeWhitespace(prompt);
  if (!normalizedPrompt) {
    throw new Error("Prompt cannot be empty");
  }

  const promptExists = product.promptBank.prompts.some((item) => item.id === promptId);
  if (!promptExists) {
    throw new Error("Prompt not found");
  }

  const nextPromptBank = validatePromptBank({
    ...product.promptBank,
    prompts: product.promptBank.prompts.map((item) =>
      item.id === promptId
        ? {
            ...item,
            prompt: normalizedPrompt,
          }
        : item,
    ),
  });

  return updateProductPromptBank(productId, nextPromptBank);
}

export async function updateProductLatestRun(productId: string, latestRunId: string): Promise<SavedProduct> {
  await ensureProductDataHealth();
  const db = await getDb();
  const result = await db.execute({
    sql: `UPDATE products SET updated_at = ?, latest_run_id = ? WHERE product_id = ?`,
    args: [new Date().toISOString(), latestRunId, productId],
  });

  if (Number(result.rowsAffected) === 0) {
    throw new Error("Product not found");
  }

  const saved = await getProductRecord(productId);
  if (!saved) {
    throw new Error("Product not found");
  }
  return saved;
}

async function ensureProductDataHealth(): Promise<void> {
  if (!globalThis.__iaProductAuditProductRepairPromise__) {
    globalThis.__iaProductAuditProductRepairPromise__ = repairInvalidProductIds();
  }

  await globalThis.__iaProductAuditProductRepairPromise__;
}

async function repairInvalidProductIds(): Promise<void> {
  const db = await getDb();
  const invalidProducts = await db.execute(`SELECT product_id FROM products WHERE product_id IS NULL OR TRIM(product_id) = ''`);

  for (const row of invalidProducts.rows) {
    const currentId = typeof row.product_id === "string" ? row.product_id : String(row.product_id ?? "");
    const nextId = randomUUID();

    if (currentId) {
      await db.batch(
        [
          { sql: `UPDATE products SET product_id = ? WHERE product_id = ?`, args: [nextId, currentId] },
          { sql: `UPDATE runs SET product_id = ? WHERE product_id = ?`, args: [nextId, currentId] },
        ],
        "write",
      );
    } else {
      await db.batch(
        [
          { sql: `UPDATE products SET product_id = ? WHERE product_id IS NULL OR TRIM(product_id) = ''`, args: [nextId] },
          { sql: `UPDATE runs SET product_id = ? WHERE product_id IS NULL OR TRIM(product_id) = ''`, args: [nextId] },
        ],
        "write",
      );
    }
  }

  await db.execute(`UPDATE products SET created_at = updated_at WHERE created_at IS NULL OR TRIM(created_at) = ''`);
}

function mapProductRow(row: Record<string, unknown>): SavedProduct {
  return {
    productId: asString(row.product_id),
    createdAt: asString(row.created_at),
    updatedAt: asString(row.updated_at),
    language: asString(row.language),
    market: asString(row.market),
    latestRunId: asNullableString(row.latest_run_id),
    profile: {
      sourceUrl: asString(row.source_url),
      canonicalUrl: asString(row.canonical_url),
      domain: asString(row.domain),
      productName: asString(row.product_name),
      brandName: asNullableString(row.brand_name),
      storeName: asNullableString(row.store_name),
      category: asNullableString(row.category),
      pageTitle: asNullableString(row.page_title),
      metaDescription: asNullableString(row.meta_description),
      aliases: parseJson<string[]>(row.aliases_json, []),
      vendorAliases: parseJson<string[]>(row.vendor_aliases_json, []),
      competitorNames: parseJson<string[]>(row.competitor_names_json, []),
      extractionNotes: parseJson<string[]>(row.extraction_notes_json, []),
    },
    promptBank: parseJson<PromptBank | null>(row.prompt_bank_json, null),
  };
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

function asString(value: unknown): string {
  return String(value ?? "");
}

function asNonEmptyString(value: unknown): string | null {
  if (value === null || value === undefined) {
    return null;
  }

  const normalized = String(value).trim();
  return normalized ? normalized : null;
}

function asNullableString(value: unknown): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  const normalized = String(value);
  return normalized ? normalized : null;
}
