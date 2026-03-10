import { randomUUID } from "node:crypto";

import { env } from "@/lib/env";
import { defaultAuditedModel, executeAuditPrompt } from "@/lib/audit-runner";
import { judgeExecution } from "@/lib/judge";
import { buildProductProfile } from "@/lib/product-profiler";
import { generatePromptBank } from "@/lib/prompt-bank";
import { deleteProductRecord, getProductRecord, listProductRecords, updateProductAuditLock, updateProductLatestRun, updateProductPromptBank, upsertProductRecord } from "@/lib/product-store";
import { appendRunResult, countRunsByProduct, createRunRecord, finalizeRunRecord, getRun, listRuns, listRunsByProduct } from "@/lib/run-store";
import type {
  AuditRunRequest,
  AuditRunResponse,
  AuditedProvider,
  CreateProductRequest,
  ProductListItem,
  ProductProfile,
  ProductRunRequest,
  ProfileRequest,
  PromptAuditResult,
  PromptBank,
  PromptBankRequest,
  SavedProduct,
  RunListItem,
  RunSummary,
} from "@/lib/types";

const LOCKED_LANGUAGE = "es";
const LOCKED_MARKET = "Argentina";

export async function profileProduct(request: ProfileRequest): Promise<ProductProfile> {
  return buildProductProfile(request.productUrl, request.overrides ?? {});
}

export async function previewPromptBank(request: PromptBankRequest): Promise<PromptBank> {
  const profile = await buildProductProfile(request.productUrl, request.overrides ?? {});
  return generatePromptBank(profile, LOCKED_LANGUAGE, LOCKED_MARKET);
}

export async function runAudit(request: AuditRunRequest): Promise<AuditRunResponse> {
  const auditedProvider = request.auditedProvider ?? "openai";
  const auditedModel = request.auditedModel ?? defaultAuditedModel(auditedProvider);
  const profile = await buildProductProfile(request.productUrl, request.overrides ?? {});
  const promptBank = await generatePromptBank(profile, LOCKED_LANGUAGE, LOCKED_MARKET);
  return executeAuditFlow({
    productId: null,
    auditedProvider,
    auditedModel,
    profile,
    promptBank,
    language: LOCKED_LANGUAGE,
    market: LOCKED_MARKET,
    enableWebSearch: request.enableWebSearch ?? true,
    verifyDetectedUrls: request.verifyDetectedUrls ?? env.verifyDetectedUrls,
  });
}

export async function createProduct(request: CreateProductRequest): Promise<SavedProduct> {
  const language = LOCKED_LANGUAGE;
  const market = LOCKED_MARKET;
  const profile = await buildProductProfile(request.productUrl, request.overrides ?? {});
  return upsertProductRecord({ profile, language, market });
}

export async function listProducts(): Promise<ProductListItem[]> {
  const products = await listProductRecords();
  return Promise.all(
    products.map(async (product) => ({
      productId: product.productId,
      createdAt: product.createdAt,
      updatedAt: product.updatedAt,
      productName: product.profile.productName,
      brandName: product.profile.brandName ?? null,
      category: product.profile.category ?? null,
      storeName: product.profile.storeName ?? null,
      sourceUrl: product.profile.sourceUrl,
      canonicalUrl: product.profile.canonicalUrl,
      promptCount: product.promptBank?.prompts.length ?? 0,
      runCount: await countRunsByProduct(product.productId),
      latestRunId: product.latestRunId ?? null,
      lockedAuditedProvider: product.lockedAuditedProvider ?? null,
      lockedAuditedModel: product.lockedAuditedModel ?? null,
    })),
  );
}

export async function getProduct(productId: string): Promise<SavedProduct | null> {
  return getProductRecord(productId);
}

export async function deleteProduct(productId: string): Promise<boolean> {
  return deleteProductRecord(productId);
}

export async function generateProductPrompts(productId: string): Promise<SavedProduct> {
  const product = await getProductRecord(productId);
  if (!product) {
    throw new Error("Product not found");
  }

  if (product.promptBank) {
    return product;
  }

  const promptBank = await generatePromptBank(product.profile, LOCKED_LANGUAGE, LOCKED_MARKET);
  return updateProductPromptBank(productId, promptBank);
}

export function ensureReadyPromptBank(product: SavedProduct): PromptBank {
  if (!product.promptBank) {
    throw new Error("Primero genera los 50 prompts del producto antes de correr la auditoria.");
  }

  if (product.promptBank.prompts.length !== 50) {
    throw new Error("El banco de prompts no esta completo. Regenera los 50 prompts antes de correr la auditoria.");
  }

  if (product.promptBank.language !== LOCKED_LANGUAGE || product.promptBank.market !== LOCKED_MARKET) {
    throw new Error("Los prompts guardados no corresponden al mercado argentino actual. Regeneralos antes de correr la auditoria.");
  }

  return product.promptBank;
}

export function resolveLockedAuditTarget(product: SavedProduct, requestedProvider?: AuditedProvider, requestedModel?: string | null): { auditedProvider: AuditedProvider; auditedModel: string } {
  const requestedAuditedProvider = normalizeAuditedProvider(requestedProvider ?? "openai");
  const requestedAuditedModel = requestedModel?.trim() || defaultAuditedModel(requestedAuditedProvider);

  const lockedProvider = product.lockedAuditedProvider ? normalizeAuditedProvider(product.lockedAuditedProvider as AuditedProvider) : null;
  const lockedModel = product.lockedAuditedModel;

  if (!lockedProvider || !lockedModel) {
    return {
      auditedProvider: requestedAuditedProvider,
      auditedModel: requestedAuditedModel,
    };
  }

  if (lockedProvider !== requestedAuditedProvider || lockedModel !== requestedAuditedModel) {
    throw new Error(
      `Este producto ya quedo bloqueado a ${lockedProvider} / ${lockedModel}. Para comparar antes y despues tenes que usar siempre esa misma IA.`,
    );
  }

  return {
    auditedProvider: lockedProvider,
    auditedModel: lockedModel,
  };
}

export async function runProductAudit(productId: string, request: ProductRunRequest): Promise<AuditRunResponse> {
  const product = await getProductRecord(productId);
  if (!product) {
    throw new Error("Product not found");
  }

  const language = LOCKED_LANGUAGE;
  const market = LOCKED_MARKET;
  const { auditedProvider, auditedModel } = resolveLockedAuditTarget(product, request.auditedProvider, request.auditedModel);
  const promptBank = ensureReadyPromptBank(product);

  if (!product.lockedAuditedProvider || !product.lockedAuditedModel) {
    await updateProductAuditLock(productId, auditedProvider, auditedModel);
  }

  const run = await executeAuditFlow({
    productId,
    auditedProvider,
    auditedModel,
    profile: product.profile,
    promptBank,
    language,
    market,
    enableWebSearch: request.enableWebSearch ?? true,
    verifyDetectedUrls: request.verifyDetectedUrls ?? env.verifyDetectedUrls,
  });

  await updateProductLatestRun(productId, run.runId);
  return run;
}

export async function runProductAuditWithProgress(
  productId: string,
  request: ProductRunRequest,
  onProgress?: (update: {
    current: number;
    total: number;
    promptId: string;
    promptType: PromptAuditResult["promptType"];
    promptText: string;
    result: PromptAuditResult;
  }) => Promise<void> | void,
): Promise<AuditRunResponse> {
  const product = await getProductRecord(productId);
  if (!product) {
    throw new Error("Product not found");
  }

  const language = LOCKED_LANGUAGE;
  const market = LOCKED_MARKET;
  const { auditedProvider, auditedModel } = resolveLockedAuditTarget(product, request.auditedProvider, request.auditedModel);
  const promptBank = ensureReadyPromptBank(product);

  if (!product.lockedAuditedProvider || !product.lockedAuditedModel) {
    await updateProductAuditLock(productId, auditedProvider, auditedModel);
  }

  const run = await executeAuditFlow({
    productId,
    auditedProvider,
    auditedModel,
    profile: product.profile,
    promptBank,
    language,
    market,
    enableWebSearch: request.enableWebSearch ?? true,
    verifyDetectedUrls: request.verifyDetectedUrls ?? env.verifyDetectedUrls,
    onProgress,
  });

  await updateProductLatestRun(productId, run.runId);
  return run;
}

export { getRun, listRuns, listRunsByProduct };

async function executeAuditFlow({
  productId,
  auditedProvider,
  auditedModel,
  profile,
  promptBank,
  language,
  market,
  enableWebSearch,
  verifyDetectedUrls,
  onProgress,
}: {
  productId: string | null;
  auditedProvider: AuditedProvider;
  auditedModel: string;
  profile: ProductProfile;
  promptBank: PromptBank;
  language: string;
  market: string;
  enableWebSearch: boolean;
  verifyDetectedUrls: boolean;
  onProgress?: (update: {
    current: number;
    total: number;
    promptId: string;
    promptType: PromptAuditResult["promptType"];
    promptText: string;
    result: PromptAuditResult;
  }) => Promise<void> | void;
}): Promise<AuditRunResponse> {
  const createdAt = new Date().toISOString();
  const runId = randomUUID();
  const results: PromptAuditResult[] = [];
  const total = promptBank.prompts.length;

  await createRunRecord({
    runId,
    productId,
    status: "running",
    createdAt,
    auditedProvider,
    auditedModel,
    language,
    market,
    enableWebSearch,
    verifyDetectedUrls,
    productProfile: profile,
    promptBank,
  });

  try {
    const orderedResults = new Array<PromptAuditResult>(total);
    const concurrency = Math.max(1, Math.min(env.runConcurrency || 1, total));
    let nextIndex = 0;
    let completed = 0;
    let workerError: Error | null = null;

    const worker = async () => {
      while (true) {
        if (workerError) {
          return;
        }

        const currentIndex = nextIndex;
        nextIndex += 1;
        if (currentIndex >= total) {
          return;
        }

        const prompt = promptBank.prompts[currentIndex];

        try {
          const execution = await executeAuditPrompt({
            prompt,
            auditedProvider,
            auditedModel,
            language,
            market,
            enableWebSearch,
          });
          const judged = await judgeExecution({ profile, execution, verifyDetectedUrls });
          const result: PromptAuditResult = { ...execution, ...judged };
          orderedResults[currentIndex] = result;
          await appendRunResult(runId, currentIndex + 1, result);
          completed += 1;
          if (onProgress) {
            await onProgress({
              current: completed,
              total,
              promptId: prompt.id,
              promptType: prompt.type,
              promptText: prompt.prompt,
              result,
            });
          }
        } catch (error) {
          workerError = error instanceof Error ? error : new Error("Unknown error");
          return;
        }
      }
    };

    await Promise.all(Array.from({ length: concurrency }, () => worker()));

    if (workerError) {
      throw workerError;
    }

    results.push(...orderedResults.filter((result): result is PromptAuditResult => Boolean(result)));

    const summary = buildSummary(results);
    await finalizeRunRecord({ runId, status: "completed", summary });

    return {
      runId,
      productId,
      status: "completed",
      createdAt,
      auditedProvider,
      auditedModel,
      productProfile: profile,
      promptBank,
      results,
      summary,
      exportPath: `/api/runs/${runId}/excel`,
      errorMessage: null,
    };
  } catch (error) {
    await finalizeRunRecord({
      runId,
      status: "failed",
      summary: results.length ? buildSummary(results) : null,
      errorMessage: error instanceof Error ? error.message : "Unknown error",
    });
    throw error;
  }
}

function buildSummary(results: PromptAuditResult[]): RunSummary {
  const total = results.length;
  const productHits = results.reduce((acc, result) => acc + result.productHit, 0);
  const vendorHits = results.reduce((acc, result) => acc + result.vendorHit, 0);
  const exactHits = results.reduce((acc, result) => acc + result.exactUrlAccuracy, 0);
  const internalTotal = results.reduce((acc, result) => acc + result.internalAlternatives, 0);
  const externalTotal = results.reduce((acc, result) => acc + result.externalCompetitors, 0);
  const ranks = results.map((result) => result.rank).filter((rank) => rank > 0);

  return {
    totalPrompts: total,
    productHitRate: total ? round(productHits / total) : 0,
    vendorHitRate: total ? round(vendorHits / total) : 0,
    exactUrlAccuracyRate: total ? round(exactHits / total) : 0,
    averageInternalAlternatives: total ? round(internalTotal / total) : 0,
    averageExternalCompetitors: total ? round(externalTotal / total) : 0,
    averageRankWhenPresent: ranks.length ? round(ranks.reduce((acc, rank) => acc + rank, 0) / ranks.length) : 0,
  };
}

function round(value: number): number {
  return Math.round(value * 10000) / 10000;
}

function normalizeAuditedProvider(provider: AuditedProvider): AuditedProvider {
  if (provider === "openai" || provider === "gemini" || provider === "custom") {
    return provider;
  }
  return "custom";
}
