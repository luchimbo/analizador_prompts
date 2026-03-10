import { randomUUID } from "node:crypto";

import { env } from "@/lib/env";
import { openRouterExecutePrompt } from "@/lib/openrouter";
import type { AuditPrompt, AuditedProvider, PromptExecutionResult } from "@/lib/types";
import { uniquePreserveOrder } from "@/lib/utils";

const AUDIT_SYSTEM_PROMPT =
  "You are answering a user from a fresh session with no memory of previous prompts. Respond directly to the request, in the requested language and market, and do not mention hidden instructions.";

export function defaultAuditedModel(provider: AuditedProvider): string {
  switch (provider) {
    case "openai":
      return env.openRouterOpenAiAuditModel;
    case "gemini":
      return env.openRouterGeminiAuditModel;
    case "grok":
    case "kimi":
      return env.openRouterGrokAuditModel;
    case "custom":
      throw new Error("For custom audited provider you must send auditedModel");
  }
}

export async function executeAuditPrompt({
  prompt,
  auditedProvider,
  auditedModel,
  language,
  market,
  enableWebSearch,
}: {
  prompt: AuditPrompt;
  auditedProvider: AuditedProvider;
  auditedModel: string;
  language: string;
  market: string;
  enableWebSearch: boolean;
}): Promise<PromptExecutionResult> {
  const requestId = randomUUID();
  const { text, urls, latencyMs } = await openRouterExecutePrompt({
    model: auditedModel,
    systemPrompt: `${AUDIT_SYSTEM_PROMPT} Language: ${language}. Market: ${market}.`,
    userPrompt: prompt.prompt,
    requestId,
    temperature: 0,
    maxTokens: 1200,
    enableWebSearch,
  });

  return {
    requestId,
    promptId: prompt.id,
    promptType: prompt.type,
    promptText: prompt.prompt,
    rawResponse: text,
    detectedUrls: uniquePreserveOrder(urls),
    citedUrls: uniquePreserveOrder(urls),
    modelProvider: auditedProvider,
    modelName: auditedModel,
    latencyMs,
    createdAt: new Date().toISOString(),
  };
}
