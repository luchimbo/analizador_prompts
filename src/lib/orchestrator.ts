import { randomUUID } from "node:crypto";

import { buildRunSummary, isSupportedPromptCount, STANDARD_PROMPT_COUNT } from "@/lib/audit-metrics";
import { resolveConfiguredAuditedModel } from "@/lib/audit-models";
import { env } from "@/lib/env";
import { defaultAuditedModel, executeAuditPrompt } from "@/lib/audit-runner";
import { judgeExecution } from "@/lib/judge";
import { buildProductProfile } from "@/lib/product-profiler";
import { generatePromptBank } from "@/lib/prompt-bank";
import { deleteProductRecord, getProductRecord, listProductRecords, updateProductAuditLock, updateProductDescriptionImprovement, updateProductImprovementCheckpoints, updateProductLatestRun, updateProductPromptBank, upsertProductRecord } from "@/lib/product-store";
import {
  appendRunResult,
  createRunRecord,
  finalizeRunRecord,
  findResumableRun,
  getRunMilestonesByProduct,
  getRun,
  getRunPromptStates,
  listRuns,
  listRunsByProduct,
  markPromptStateCompleted,
  markPromptStateFailed,
  markPromptStateRunning,
  markRunAsRunning,
  seedRunPromptStates,
} from "@/lib/run-store";
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
  const auditedModel = resolveConfiguredAuditedModel(auditedProvider, request.auditedModel) ?? defaultAuditedModel(auditedProvider);
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
    products.map(async (product) => {
      const milestones = await getRunMilestonesByProduct(product.productId);
      const checkpointOverrides = product.improvementCheckpoints ?? {};
      const firstRunAt = Object.prototype.hasOwnProperty.call(checkpointOverrides, "firstRunAt") ? checkpointOverrides.firstRunAt ?? null : milestones.firstRunAt;
      const secondRunAt = Object.prototype.hasOwnProperty.call(checkpointOverrides, "secondRunAt") ? checkpointOverrides.secondRunAt ?? null : milestones.secondRunAt;
      return {
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
        runCount: milestones.runCount,
        firstRunAt,
        secondRunAt,
        descriptionImproved: product.descriptionImproved,
        descriptionImprovedAt: product.descriptionImprovedAt ?? null,
        latestRunId: product.latestRunId ?? null,
        lockedAuditedProvider: product.lockedAuditedProvider ?? null,
        lockedAuditedModel: product.lockedAuditedModel ?? null,
      };
    }),
  );
}

export async function getProduct(productId: string): Promise<SavedProduct | null> {
  return getProductRecord(productId);
}

export async function deleteProduct(productId: string): Promise<boolean> {
  return deleteProductRecord(productId);
}

export async function setProductDescriptionImproved(productId: string, descriptionImproved: boolean): Promise<SavedProduct> {
  return updateProductDescriptionImprovement(productId, descriptionImproved);
}

export async function setProductImprovementCheckpoints(
  productId: string,
  checkpoints: { firstRunAt?: string | null; secondRunAt?: string | null },
): Promise<SavedProduct> {
  return updateProductImprovementCheckpoints(productId, checkpoints);
}

export async function generateProductPrompts(productId: string): Promise<SavedProduct> {
  const product = await getProductRecord(productId);
  if (!product) {
    throw new Error("Product not found");
  }

  if (
    product.promptBank &&
    product.promptBank.prompts.length === STANDARD_PROMPT_COUNT &&
    product.promptBank.language === LOCKED_LANGUAGE &&
    product.promptBank.market === LOCKED_MARKET
  ) {
    return product;
  }

  const promptBank = await generatePromptBank(product.profile, LOCKED_LANGUAGE, LOCKED_MARKET);
  return updateProductPromptBank(productId, promptBank);
}

export function ensureReadyPromptBank(product: SavedProduct): PromptBank {
  if (!product.promptBank) {
    throw new Error(`Primero genera los ${STANDARD_PROMPT_COUNT} prompts del producto antes de correr la auditoria.`);
  }

  if (!isSupportedPromptCount(product.promptBank.prompts.length)) {
    throw new Error("El banco de prompts no esta completo. Regeneralo con un formato soportado antes de correr la auditoria.");
  }

  if (product.promptBank.language !== LOCKED_LANGUAGE || product.promptBank.market !== LOCKED_MARKET) {
    throw new Error("Los prompts guardados no corresponden al mercado argentino actual. Regeneralos antes de correr la auditoria.");
  }

  return product.promptBank;
}

export function resolveLockedAuditTarget(product: SavedProduct, requestedProvider?: AuditedProvider, requestedModel?: string | null): { auditedProvider: AuditedProvider; auditedModel: string } {
  const requestedAuditedProvider = normalizeAuditedProvider(requestedProvider ?? "openai");
  const requestedAuditedModel = resolveConfiguredAuditedModel(requestedAuditedProvider, requestedModel?.trim() || defaultAuditedModel(requestedAuditedProvider)) || defaultAuditedModel(requestedAuditedProvider);

  const lockedProvider = product.lockedAuditedProvider ? normalizeAuditedProvider(product.lockedAuditedProvider as AuditedProvider) : null;
  const lockedModel = resolveConfiguredAuditedModel(lockedProvider, product.lockedAuditedModel);

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
    resumeRunId: request.resumeRunId,
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
    resumeRunId: request.resumeRunId,
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
  resumeRunId,
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
  resumeRunId?: string;
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
  const existingRun =
    productId && resumeRunId
      ? await getRun(resumeRunId)
      : productId
        ? await findResumableRun(productId, auditedProvider, auditedModel)
        : null;

  const canResume =
    Boolean(existingRun) &&
    existingRun?.productId === productId &&
    existingRun.auditedProvider === auditedProvider &&
    existingRun.auditedModel === auditedModel &&
    existingRun.promptBank?.prompts?.length === promptBank.prompts.length;

  const runId = canResume && existingRun ? existingRun.runId : randomUUID();
  const runCreatedAt = canResume && existingRun ? existingRun.createdAt : createdAt;
  const results: PromptAuditResult[] = [];
  const total = promptBank.prompts.length;

  if (!canResume) {
    await createRunRecord({
      runId,
      productId,
      status: "running",
      createdAt: runCreatedAt,
      auditedProvider,
      auditedModel,
      language,
      market,
      enableWebSearch,
      verifyDetectedUrls,
      productProfile: profile,
      promptBank,
    });
    await seedRunPromptStates(runId, promptBank);
  }

  try {
    const orderedResults = new Array<PromptAuditResult>(total);
    if (canResume && existingRun) {
      for (const result of existingRun.results) {
        const index = promptBank.prompts.findIndex((item) => item.id === result.promptId);
        if (index >= 0) {
          orderedResults[index] = result;
        }
      }
      await markRunAsRunning(runId, existingRun.results.length);
    }

    const concurrency = Math.max(1, Math.min(env.runConcurrency || 1, total));
    const promptStates = await getRunPromptStates(runId);
    const completedPromptIds = new Set(
      promptStates.filter((state) => state.status === "completed").map((state) => state.promptId),
    );
    for (const result of orderedResults.filter((item): item is PromptAuditResult => Boolean(item))) {
      completedPromptIds.add(result.promptId);
    }
    const remainingIndexes = promptBank.prompts
      .map((prompt, index) => ({ prompt, index }))
      .filter(({ prompt }) => !completedPromptIds.has(prompt.id))
      .map(({ index }) => index);

    let remainingPointer = 0;
    let completed = canResume && existingRun ? existingRun.results.length : 0;
    let workerError: Error | null = null;
    let workerErrorStage: string | null = null;
    let workerFailedPromptId: string | null = null;
    let workerFailedPromptText: string | null = null;

    const worker = async () => {
      while (true) {
        if (workerError) {
          return;
        }

        const currentIndex = remainingIndexes[remainingPointer];
        remainingPointer += 1;
        if (currentIndex === undefined) {
          return;
        }

        const prompt = promptBank.prompts[currentIndex];

        try {
          await markPromptStateRunning({
            runId,
            promptOrder: currentIndex + 1,
            promptId: prompt.id,
            promptType: prompt.type,
            promptText: prompt.prompt,
          });

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
          await markPromptStateCompleted(runId, prompt.id, result.requestId);
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
          workerErrorStage = inferErrorStage(workerError.message);
          workerFailedPromptId = prompt.id;
          workerFailedPromptText = prompt.prompt;
          await markPromptStateFailed({
            runId,
            promptId: prompt.id,
            errorStage: workerErrorStage,
            errorMessage: workerError.message,
          });
          return;
        }
      }
    };

    await Promise.all(Array.from({ length: concurrency }, () => worker()));

    if (workerError !== null) {
      const failedError: Error = workerError;
      const partialResults = orderedResults.filter((result): result is PromptAuditResult => Boolean(result));
      await finalizeRunRecord({
        runId,
        status: "failed",
        summary: partialResults.length ? buildRunSummary(partialResults) : null,
        errorMessage: failedError.message,
        errorStage: workerErrorStage ?? inferErrorStage(failedError.message),
        failedPromptId: workerFailedPromptId,
        failedPromptText: workerFailedPromptText,
        completedPrompts: partialResults.length,
      });
      throw failedError;
    }

    results.push(...orderedResults.filter((result): result is PromptAuditResult => Boolean(result)));

    const summary = buildRunSummary(results);
    await finalizeRunRecord({ runId, status: "completed", summary, completedPrompts: results.length });

    return {
      runId,
      productId,
      status: "completed",
      createdAt: runCreatedAt,
      auditedProvider,
      auditedModel,
      productProfile: profile,
      promptBank,
      results,
      summary,
      exportPath: `/api/runs/${runId}/excel`,
      errorMessage: null,
      errorStage: null,
      failedPromptId: null,
      failedPromptText: null,
      completedPrompts: results.length,
      resumable: false,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    const currentRun = await getRun(runId);
    if (!currentRun || currentRun.status !== "failed") {
      await finalizeRunRecord({
        runId,
        status: "failed",
        summary: results.length ? buildRunSummary(results) : null,
        errorMessage,
        errorStage: inferErrorStage(errorMessage),
        failedPromptId: null,
        failedPromptText: null,
        completedPrompts: results.length,
      });
    }
    throw error;
  }
}

function inferErrorStage(message: string): string {
  const lowered = message.toLowerCase();
  if (lowered.includes("openrouter") || lowered.includes("timeout") || lowered.includes("429")) {
    return "audit_model";
  }
  if (lowered.includes("judge")) {
    return "judge";
  }
  if (lowered.includes("url") || lowered.includes("redirect")) {
    return "url_verify";
  }
  if (lowered.includes("sql") || lowered.includes("db") || lowered.includes("database")) {
    return "db_write";
  }
  return "unknown";
}

function normalizeAuditedProvider(provider: AuditedProvider): AuditedProvider {
  if (provider === "openai" || provider === "gemini" || provider === "custom") {
    return provider;
  }
  return "custom";
}
