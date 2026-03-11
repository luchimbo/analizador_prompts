import { randomUUID } from "node:crypto";

import { resolveConfiguredAuditedModel } from "@/lib/audit-models";
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
    sql: `SELECT product_id, created_at, latest_run_id, locked_audited_provider, locked_audited_model, prompt_bank_json FROM products WHERE canonical_url = ? OR source_url = ? LIMIT 1`,
    args: [targetCanonical, targetSource],
  });
  const existing = existingResult.rows[0];

  const timestamp = new Date().toISOString();
  const nextPromptBank = promptBank ?? parseJson<PromptBank | null>(existing?.prompt_bank_json, null);
  const productId = asNonEmptyString(existing?.product_id) ?? randomUUID();
  const createdAt = asNonEmptyString(existing?.created_at) ?? timestamp;
  const latestRunId = asNullableString(existing?.latest_run_id);
  const lockedAuditedProvider = asNullableString(existing?.locked_audited_provider);
  const lockedAuditedModel = asNullableString(existing?.locked_audited_model);

  await db.execute({
    sql: `
      INSERT OR REPLACE INTO products (
        product_id, created_at, updated_at, language, market, latest_run_id,
        locked_audited_provider, locked_audited_model,
        source_url, canonical_url, domain, product_name, brand_name, store_name,
        category, page_title, meta_description, aliases_json, vendor_aliases_json,
        competitor_names_json, extraction_notes_json, prompt_bank_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    args: [
      productId,
      createdAt,
      timestamp,
      language,
      market,
      latestRunId,
      lockedAuditedProvider,
      lockedAuditedModel,
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

export async function updateProductAuditLock(productId: string, auditedProvider: string, auditedModel: string): Promise<SavedProduct> {
  await ensureProductDataHealth();
  const db = await getDb();
  const result = await db.execute({
    sql: `UPDATE products SET updated_at = ?, locked_audited_provider = ?, locked_audited_model = ? WHERE product_id = ?`,
    args: [new Date().toISOString(), auditedProvider, auditedModel, productId],
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

export async function deleteProductRecord(productId: string): Promise<boolean> {
  await ensureProductDataHealth();
  const db = await getDb();

  const existing = await db.execute({
    sql: `SELECT product_id FROM products WHERE product_id = ? LIMIT 1`,
    args: [productId],
  });

  if (!existing.rows.length) {
    return false;
  }

  await db.batch(
    [
      {
        sql: `DELETE FROM run_results WHERE run_id IN (SELECT run_id FROM runs WHERE product_id = ?)`,
        args: [productId],
      },
      {
        sql: `DELETE FROM runs WHERE product_id = ?`,
        args: [productId],
      },
      {
        sql: `DELETE FROM products WHERE product_id = ?`,
        args: [productId],
      },
    ],
    "write",
  );

  return true;
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

  const unlockedProducts = await db.execute(`
    SELECT p.product_id, first_run.audited_provider, first_run.audited_model
    FROM products p
    JOIN (
      SELECT r.product_id, r.audited_provider, r.audited_model
      FROM runs r
      JOIN (
        SELECT product_id, MIN(created_at) AS first_created_at
        FROM runs
        WHERE product_id IS NOT NULL
        GROUP BY product_id
      ) firsts
      ON r.product_id = firsts.product_id AND r.created_at = firsts.first_created_at
    ) first_run
    ON p.product_id = first_run.product_id
    WHERE (p.locked_audited_provider IS NULL OR TRIM(p.locked_audited_provider) = '')
      AND (p.locked_audited_model IS NULL OR TRIM(p.locked_audited_model) = '')
  `);

  for (const row of unlockedProducts.rows) {
    const productId = asNonEmptyString(row.product_id);
    const auditedProvider = asNonEmptyString(row.audited_provider);
    const auditedModel = asNonEmptyString(row.audited_model);
    if (!productId || !auditedProvider || !auditedModel) {
      continue;
    }

    await db.execute({
      sql: `UPDATE products SET locked_audited_provider = ?, locked_audited_model = ? WHERE product_id = ?`,
      args: [auditedProvider, auditedModel, productId],
    });
  }
}

function mapProductRow(row: Record<string, unknown>): SavedProduct {
  const lockedAuditedProvider = normalizeProvider(asNullableString(row.locked_audited_provider));
  return {
    productId: asString(row.product_id),
    createdAt: asString(row.created_at),
    updatedAt: asString(row.updated_at),
    language: asString(row.language),
    market: asString(row.market),
    lockedAuditedProvider,
    lockedAuditedModel: resolveConfiguredAuditedModel(lockedAuditedProvider, asNullableString(row.locked_audited_model)),
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

function normalizeProvider(value: string | null): string | null {
  if (!value) {
    return value;
  }
  if (value === "openai" || value === "gemini" || value === "custom") {
    return value;
  }
  return "custom";
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
