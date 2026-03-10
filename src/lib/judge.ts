import { classifyAlternativeMentions } from "@/lib/catalog";
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
- Extract alternative product mentions as short product-like strings in alternativeMentions.
- Ignore generic brand-only mentions in alternativeMentions.
- Do not guess missing facts.

JSON schema:
{
  "productHit": 0,
  "rank": 0,
  "alternativeMentions": ["string"],
  "evidenceSnippet": "short quote or null",
  "judgeNotes": "brief note"
}`;

interface JudgePayload {
  productHit?: number;
  rank?: number;
  alternativeMentions?: string[];
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
  const heuristicHit = computeHeuristicProductHit(profile, execution.rawResponse);
  const heuristicRank = estimateRank(execution.rawResponse, [profile.productName, ...profile.aliases]);
  const productHit = Math.max(Number(llmMetrics.productHit ?? 0), heuristicHit);
  const rank = Math.max(Number(llmMetrics.rank ?? 0), heuristicRank);
  const evidenceSnippet = llmMetrics.evidenceSnippet ?? extractEvidence(profile, execution.rawResponse);

  const mentions = uniquePreserveOrder((llmMetrics.alternativeMentions ?? []).map((item) => normalizeWhitespace(item)).filter(Boolean));
  const alternatives = await classifyAlternativeMentions({
    mentions,
    principalAliases: [profile.productName, ...(profile.aliases ?? [])],
  });

  const vendorHit = productHit ? computeVendorHit(profile, execution.rawResponse) : 0;
  const exactUrlAccuracy = productHit ? await computeExactUrlAccuracy(profile, execution.detectedUrls, verifyDetectedUrls) : 0;

  return {
    productHit: Math.max(productHit, 0),
    vendorHit,
    exactUrlAccuracy,
    internalAlternatives: Math.max(alternatives.internalAlternatives, 0),
    externalCompetitors: Math.max(alternatives.externalCompetitors, 0),
    rank: Math.max(rank, 0),
    alternativeMentions: mentions,
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
  const productHit = computeHeuristicProductHit(profile, execution.rawResponse);

  return {
    productHit,
    rank: productHit ? estimateRank(execution.rawResponse, aliases) : 0,
    alternativeMentions: estimateAlternativeMentions(execution.rawResponse, aliases),
    evidenceSnippet: extractEvidence(profile, execution.rawResponse),
    judgeNotes: "Heuristic judge used because OpenRouter judge was unavailable or invalid.",
  };
}

function computeVendorHit(profile: ProductProfile, responseText: string): number {
  const normalizedText = normalizeForMatch(responseText);
  const compactText = compactForMatch(normalizedText);
  const aliases = uniquePreserveOrder([...(profile.vendorAliases ?? []), profile.storeName ?? ""]);
  return aliases.some((alias) => aliasMatchesText(alias, normalizedText, compactText)) ? 1 : 0;
}

async function computeExactUrlAccuracy(profile: ProductProfile, detectedUrls: string[], verifyDetectedUrls: boolean): Promise<number> {
  const target = normalizeUrl(profile.canonicalUrl);
  if (!target) {
    return 0;
  }

  const candidates = uniquePreserveOrder(detectedUrls);
  const maxToVerify = Math.max(1, Number.isFinite(env.maxVerifiedUrlsPerPrompt) ? env.maxVerifiedUrlsPerPrompt : 3);

  for (const candidate of candidates) {
    const normalizedCandidate = normalizeUrl(candidate);
    if (normalizedCandidate === target) {
      return 1;
    }
  }

  if (!verifyDetectedUrls) {
    return 0;
  }

  for (const candidate of candidates.slice(0, maxToVerify)) {
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
  const timeoutSeconds = Math.max(2, Number.isFinite(env.urlResolveTimeoutSeconds) ? env.urlResolveTimeoutSeconds : 8);
  const timeoutMs = timeoutSeconds * 1000;
  const timeoutController = new AbortController();
  const timeoutHandle = setTimeout(() => timeoutController.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      redirect: "follow",
      cache: "no-store",
      signal: timeoutController.signal,
    });
    return response.url;
  } catch {
    return url;
  } finally {
    clearTimeout(timeoutHandle);
  }
}

function estimateRank(responseText: string, aliases: string[]): number {
  const normalizedAliases = aliases.map((alias) => normalizeForMatch(alias)).filter(Boolean);
  const compactAliases = normalizedAliases.map((alias) => compactForMatch(alias));

  const bulletLines = responseText
    .split(/\r?\n/)
    .map((line) => line.match(LIST_PATTERN)?.groups?.text)
    .filter((line): line is string => Boolean(line));

  if (bulletLines.length) {
    for (const [index, line] of bulletLines.entries()) {
      const normalizedLine = normalizeForMatch(line);
      const compactLine = compactForMatch(normalizedLine);
      if (normalizedAliases.some((alias, aliasIndex) => aliasMatchesText(alias, normalizedLine, compactLine, compactAliases[aliasIndex]))) {
        return index + 1;
      }
    }
    return 0;
  }

  const sentences = responseText.split(/(?<=[.!?])\s+/).slice(0, 10);
  for (const [index, sentence] of sentences.entries()) {
    const normalizedSentence = normalizeForMatch(sentence);
    const compactSentence = compactForMatch(normalizedSentence);
    if (normalizedAliases.some((alias, aliasIndex) => aliasMatchesText(alias, normalizedSentence, compactSentence, compactAliases[aliasIndex]))) {
      return index + 1;
    }
  }
  return 1;
}

function estimateAlternativeMentions(responseText: string, aliases: string[]): string[] {
  const mentions: string[] = [];
  for (const line of responseText.split(/\r?\n/)) {
    const match = line.match(LIST_PATTERN);
    if (!match?.groups?.text) {
      continue;
    }
    const text = normalizeWhitespace(match.groups.text);
    const lowered = text.toLowerCase();
    if (aliases.some((alias) => lowered.includes(alias.toLowerCase()))) {
      continue;
    }
    mentions.push(text);
  }
  return uniquePreserveOrder(mentions);
}

function extractEvidence(profile: ProductProfile, responseText: string): string | null {
  const aliases = uniquePreserveOrder([profile.productName, ...profile.aliases]);
  const normalizedAliases = aliases.map((alias) => normalizeForMatch(alias)).filter(Boolean);
  const compactAliases = normalizedAliases.map((alias) => compactForMatch(alias));
  for (const line of responseText.split(/\r?\n/)) {
    const cleaned = normalizeWhitespace(line);
    const normalizedLine = normalizeForMatch(cleaned);
    const compactLine = compactForMatch(normalizedLine);
    if (normalizedAliases.some((alias, aliasIndex) => aliasMatchesText(alias, normalizedLine, compactLine, compactAliases[aliasIndex]))) {
      return clip(cleaned, 280);
    }
  }
  return null;
}

function computeHeuristicProductHit(profile: ProductProfile, responseText: string): number {
  const aliases = uniquePreserveOrder([profile.productName, ...profile.aliases]);
  const normalizedText = normalizeForMatch(responseText);
  const compactText = compactForMatch(normalizedText);
  return aliases.some((alias) => aliasMatchesText(alias, normalizedText, compactText)) ? 1 : 0;
}

function aliasMatchesText(alias: string, normalizedText: string, compactText: string, precomputedCompactAlias?: string): boolean {
  const normalizedAlias = normalizeForMatch(alias);
  if (!normalizedAlias) {
    return false;
  }
  const compactAlias = precomputedCompactAlias ?? compactForMatch(normalizedAlias);
  return normalizedText.includes(normalizedAlias) || (compactAlias.length >= 5 && compactText.includes(compactAlias));
}

function normalizeForMatch(value: string): string {
  return normalizeWhitespace(value)
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function compactForMatch(value: string): string {
  return value.replace(/\s+/g, "");
}
