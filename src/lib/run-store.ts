import { getDb } from "@/lib/db";
import type { AuditRunResponse, PromptAuditResult, ProductProfile, PromptBank, RunListItem, RunSummary, RunStatus } from "@/lib/types";

export async function createRunRecord({
  runId,
  productId,
  status,
  createdAt,
  auditedProvider,
  auditedModel,
  language,
  market,
  enableWebSearch,
  verifyDetectedUrls,
  productProfile,
  promptBank,
  errorMessage,
}: {
  runId: string;
  productId: string | null;
  status: RunStatus;
  createdAt: string;
  auditedProvider: string;
  auditedModel: string;
  language: string;
  market: string;
  enableWebSearch: boolean;
  verifyDetectedUrls: boolean;
  productProfile: ProductProfile;
  promptBank: PromptBank;
  errorMessage?: string | null;
}): Promise<void> {
  const db = await getDb();
  await db.execute({
    sql: `
      INSERT INTO runs (
        run_id, product_id, status, created_at, audited_provider, audited_model,
        language, market, enable_web_search, verify_detected_urls,
        product_name, product_profile_json, prompt_bank_json, summary_json,
        export_path, error_message
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    args: [
      runId,
      productId,
      status,
      createdAt,
      auditedProvider,
      auditedModel,
      language,
      market,
      enableWebSearch ? 1 : 0,
      verifyDetectedUrls ? 1 : 0,
      productProfile.productName,
      JSON.stringify(productProfile),
      JSON.stringify(promptBank),
      null,
      `/api/runs/${runId}/excel`,
      errorMessage ?? null,
    ],
  });
}

export async function appendRunResult(runId: string, promptOrder: number, result: PromptAuditResult): Promise<void> {
  const db = await getDb();
  await db.execute({
    sql: `
      INSERT INTO run_results (
        run_id, prompt_order, request_id, prompt_id, prompt_type, prompt_text, raw_response,
        detected_urls_json, cited_urls_json, model_provider, model_name,
        latency_ms, created_at, product_hit, vendor_hit, exact_url_accuracy,
        product_competitors, rank, evidence_snippet, judge_provider,
        judge_model, judge_notes
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    args: [
      runId,
      promptOrder,
      result.requestId,
      result.promptId,
      result.promptType,
      result.promptText,
      result.rawResponse,
      JSON.stringify(result.detectedUrls ?? []),
      JSON.stringify(result.citedUrls ?? []),
      result.modelProvider,
      result.modelName,
      result.latencyMs,
      result.createdAt,
      result.productHit,
      result.vendorHit,
      result.exactUrlAccuracy,
      result.productCompetitors,
      result.rank,
      result.evidenceSnippet ?? null,
      result.judgeProvider ?? null,
      result.judgeModel ?? null,
      result.judgeNotes ?? null,
    ],
  });
}

export async function finalizeRunRecord({
  runId,
  status,
  summary,
  errorMessage,
}: {
  runId: string;
  status: RunStatus;
  summary?: RunSummary | null;
  errorMessage?: string | null;
}): Promise<void> {
  const db = await getDb();
  await db.execute({
    sql: `UPDATE runs SET status = ?, summary_json = ?, error_message = ?, export_path = ? WHERE run_id = ?`,
    args: [status, summary ? JSON.stringify(summary) : null, errorMessage ?? null, `/api/runs/${runId}/excel`, runId],
  });
}

export async function getRun(runId: string): Promise<AuditRunResponse | null> {
  const db = await getDb();
  const runResult = await db.execute({ sql: `SELECT * FROM runs WHERE run_id = ? LIMIT 1`, args: [runId] });
  const runRow = runResult.rows[0];
  if (!runRow) {
    return null;
  }

  const resultsResult = await db.execute({ sql: `SELECT * FROM run_results WHERE run_id = ? ORDER BY prompt_order ASC`, args: [runId] });
  return mapRunRow(runRow, resultsResult.rows);
}

export async function listRuns(limit = 20): Promise<RunListItem[]> {
  const db = await getDb();
  const result = await db.execute({
    sql: `SELECT run_id, product_id, status, created_at, audited_provider, audited_model, product_name, export_path FROM runs ORDER BY created_at DESC LIMIT ?`,
    args: [limit],
  });
  return result.rows.map(mapRunListRow);
}

export async function listRunsByProduct(productId: string, limit = 20): Promise<RunListItem[]> {
  const db = await getDb();
  const result = await db.execute({
    sql: `SELECT run_id, product_id, status, created_at, audited_provider, audited_model, product_name, export_path FROM runs WHERE product_id = ? ORDER BY created_at DESC LIMIT ?`,
    args: [productId, limit],
  });
  return result.rows.map(mapRunListRow);
}

export async function countRunsByProduct(productId: string): Promise<number> {
  const db = await getDb();
  const result = await db.execute({ sql: `SELECT COUNT(*) AS total FROM runs WHERE product_id = ?`, args: [productId] });
  return Number(result.rows[0]?.total ?? 0);
}

function mapRunRow(runRow: Record<string, unknown>, resultRows: Array<Record<string, unknown>>): AuditRunResponse {
  return {
    runId: asString(runRow.run_id),
    productId: asNullableString(runRow.product_id),
    status: asString(runRow.status) as RunStatus,
    createdAt: asString(runRow.created_at),
    auditedProvider: asString(runRow.audited_provider),
    auditedModel: asString(runRow.audited_model),
    productProfile: parseJson<ProductProfile>(runRow.product_profile_json, {} as ProductProfile),
    promptBank: parseJson<PromptBank>(runRow.prompt_bank_json, {} as PromptBank),
    results: resultRows.map(mapRunResultRow),
    summary: parseJson<RunSummary | null>(runRow.summary_json, null),
    exportPath: asNullableString(runRow.export_path),
    errorMessage: asNullableString(runRow.error_message),
  };
}

function mapRunResultRow(row: Record<string, unknown>): PromptAuditResult {
  return {
    requestId: asString(row.request_id),
    promptId: asString(row.prompt_id),
    promptType: asString(row.prompt_type) as PromptAuditResult["promptType"],
    promptText: asString(row.prompt_text),
    rawResponse: asString(row.raw_response),
    detectedUrls: parseJson<string[]>(row.detected_urls_json, []),
    citedUrls: parseJson<string[]>(row.cited_urls_json, []),
    modelProvider: asString(row.model_provider),
    modelName: asString(row.model_name),
    latencyMs: Number(row.latency_ms ?? 0),
    createdAt: asString(row.created_at),
    productHit: Number(row.product_hit ?? 0),
    vendorHit: Number(row.vendor_hit ?? 0),
    exactUrlAccuracy: Number(row.exact_url_accuracy ?? 0),
    productCompetitors: Number(row.product_competitors ?? 0),
    rank: Number(row.rank ?? 0),
    evidenceSnippet: asNullableString(row.evidence_snippet),
    judgeProvider: asNullableString(row.judge_provider),
    judgeModel: asNullableString(row.judge_model),
    judgeNotes: asNullableString(row.judge_notes),
  };
}

function mapRunListRow(row: Record<string, unknown>): RunListItem {
  return {
    runId: asString(row.run_id),
    productId: asNullableString(row.product_id),
    status: asString(row.status) as RunStatus,
    createdAt: asString(row.created_at),
    auditedProvider: asString(row.audited_provider),
    auditedModel: asString(row.audited_model),
    productName: asNullableString(row.product_name),
    exportPath: asNullableString(row.export_path),
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

function asNullableString(value: unknown): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  return String(value);
}
