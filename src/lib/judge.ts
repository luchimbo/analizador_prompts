import { env } from "@/lib/env";
import { openRouterChatJson } from "@/lib/openrouter";
import type { JudgedMetrics, ProductProfile, PromptExecutionResult } from "@/lib/types";
import { clip, normalizeUrl, normalizeWhitespace, uniquePreserveOrder } from "@/lib/utils";

const LIST_PATTERN = /^\s*(?:[-*]|\d+[).])\s+(?<text>.+)$/;

const JUDGE_SYSTEM_PROMPT = `You are a strict evaluator for a product visibility audit.
You analyze one AI response at a time and return strict JSON only.

Rules:
- Product_Hit is 1 only if the target product is positively recommended.
- Rank is the positive recommendation position of the target product. Use 0 if absent.
- Product_Competitors is the number of distinct alternative products also recommended positively.
- Do not guess missing facts.
- Keep explanations short.

JSON schema:
{
  "productHit": 0,
  "productCompetitors": 0,
  "rank": 0,
  "evidenceSnippet": "short quote or null",
  "judgeNotes": "brief note"
}`;

interface JudgePayload {
  productHit?: number;
  productCompetitors?: number;
  rank?: number;
  evidenceSnippet?: string | null;
  judgeNotes?: string | null;
}

export async function judgeExecution({
  profile,
  execution,
  verifyDetectedUrls = false,
}: {
  profile: ProductProfile;
  execution: PromptExecutionResult;
  verifyDetectedUrls?: boolean;
}): Promise<JudgedMetrics> {
  const llmMetrics = await judgeWithModel(profile, execution);
  const productHit = Number(llmMetrics.productHit ?? 0);
  const rank = Number(llmMetrics.rank ?? 0);
  const productCompetitors = Number(llmMetrics.productCompetitors ?? 0);
  const evidenceSnippet = llmMetrics.evidenceSnippet ?? extractEvidence(profile, execution.rawResponse);

  const vendorHit = productHit ? computeVendorHit(profile, execution.rawResponse) : 0;
  const exactUrlAccuracy = productHit ? await computeExactUrlAccuracy(profile, execution.detectedUrls, verifyDetectedUrls) : 0;

  return {
    productHit: Math.max(productHit, 0),
    vendorHit,
    exactUrlAccuracy,
    productCompetitors: Math.max(productCompetitors, 0),
    rank: Math.max(rank, 0),
    evidenceSnippet,
    judgeProvider: env.openRouterApiKey ? "openrouter" : "heuristic",
    judgeModel: env.openRouterApiKey ? env.openRouterJudgeModel : "rules",
    judgeNotes: llmMetrics.judgeNotes ?? null,
  };
}

async function judgeWithModel(profile: ProductProfile, execution: PromptExecutionResult): Promise<JudgePayload> {
  if (!env.openRouterApiKey) {
    return judgeWithHeuristics(profile, execution);
  }

  try {
    return await openRouterChatJson<JudgePayload>({
      model: env.openRouterJudgeModel,
      systemPrompt: JUDGE_SYSTEM_PROMPT,
      userPrompt: JSON.stringify(
        {
          productName: profile.productName,
          brandName: profile.brandName,
          storeName: profile.storeName,
          aliases: profile.aliases,
          vendorAliases: profile.vendorAliases,
          prompt: execution.promptText,
          response: execution.rawResponse,
        },
        null,
        2,
      ),
      temperature: 0,
      maxTokens: 1500,
    });
  } catch {
    return judgeWithHeuristics(profile, execution);
  }
}

function judgeWithHeuristics(profile: ProductProfile, execution: PromptExecutionResult): JudgePayload {
  const aliases = uniquePreserveOrder([profile.productName, ...profile.aliases]);
  const lowered = execution.rawResponse.toLowerCase();
  const productHit = aliases.some((alias) => alias && lowered.includes(alias.toLowerCase())) ? 1 : 0;

  return {
    productHit,
    productCompetitors: estimateCompetitors(execution.rawResponse, productHit),
    rank: productHit ? estimateRank(execution.rawResponse, aliases) : 0,
    evidenceSnippet: extractEvidence(profile, execution.rawResponse),
    judgeNotes: "Heuristic judge used because OpenRouter judge was unavailable or invalid.",
  };
}

function computeVendorHit(profile: ProductProfile, responseText: string): number {
  const lowered = responseText.toLowerCase();
  const aliases = uniquePreserveOrder([...(profile.vendorAliases ?? []), profile.storeName ?? ""]);
  return aliases.some((alias) => alias && lowered.includes(alias.toLowerCase())) ? 1 : 0;
}

async function computeExactUrlAccuracy(profile: ProductProfile, detectedUrls: string[], verifyDetectedUrls: boolean): Promise<number> {
  const target = normalizeUrl(profile.canonicalUrl);
  if (!target) {
    return 0;
  }

  for (const candidate of uniquePreserveOrder(detectedUrls)) {
    const normalizedCandidate = normalizeUrl(candidate);
    if (normalizedCandidate === target) {
      return 1;
    }
    if (verifyDetectedUrls) {
      const resolved = await resolveUrl(candidate);
      if (normalizeUrl(resolved) === target) {
        return 1;
      }
    }
  }
  return 0;
}

async function resolveUrl(url: string): Promise<string> {
  try {
    const response = await fetch(url, { redirect: "follow", cache: "no-store" });
    return response.url;
  } catch {
    return url;
  }
}

function estimateRank(responseText: string, aliases: string[]): number {
  const bulletLines = responseText
    .split(/\r?\n/)
    .map((line) => line.match(LIST_PATTERN)?.groups?.text)
    .filter((line): line is string => Boolean(line));

  if (bulletLines.length) {
    for (const [index, line] of bulletLines.entries()) {
      const lowered = line.toLowerCase();
      if (aliases.some((alias) => lowered.includes(alias.toLowerCase()))) {
        return index + 1;
      }
    }
    return 0;
  }

  const sentences = responseText.split(/(?<=[.!?])\s+/).slice(0, 10);
  for (const [index, sentence] of sentences.entries()) {
    const lowered = sentence.toLowerCase();
    if (aliases.some((alias) => lowered.includes(alias.toLowerCase()))) {
      return index + 1;
    }
  }
  return 1;
}

function estimateCompetitors(responseText: string, productHit: number): number {
  const bullets = responseText.split(/\r?\n/).filter((line) => LIST_PATTERN.test(line));
  return bullets.length ? Math.max(bullets.length - productHit, 0) : 0;
}

function extractEvidence(profile: ProductProfile, responseText: string): string | null {
  const aliases = uniquePreserveOrder([profile.productName, ...profile.aliases]);
  for (const line of responseText.split(/\r?\n/)) {
    const cleaned = normalizeWhitespace(line);
    const lowered = cleaned.toLowerCase();
    if (aliases.some((alias) => alias && lowered.includes(alias.toLowerCase()))) {
      return clip(cleaned, 280);
    }
  }
  return null;
}
