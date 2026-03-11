import { classifyAlternativeMentions } from "@/lib/catalog";
import { env } from "@/lib/env";
import { openRouterChatJson } from "@/lib/openrouter";
import { buildProductAliases, extractProductModelTokens } from "@/lib/product-aliases";
import type { JudgedMetrics, ProductProfile, PromptExecutionResult, ScoringReasons } from "@/lib/types";
import { clip, normalizeUrl, normalizeWhitespace, uniquePreserveOrder } from "@/lib/utils";

const LIST_PATTERN = /^\s*(?:[-*]|\d+[).])\s+(?<text>.+)$/;

const JUDGE_SYSTEM_PROMPT = `You are a strict evaluator for a product visibility audit.
You analyze one AI response at a time and return strict JSON only.

Rules:
- Product_Hit is 1 if the target product is explicitly mentioned as a relevant answer.
- A direct descriptive answer about the exact target product also counts, even without explicit recommendation wording.
- targetProductMentioned is 1 if the response is clearly talking about the target product.
- exactModelMatch is 1 only when the response refers to the exact same model or variant as the target product, not sibling models from the same brand.
- Rank is the first position where the target product appears as a relevant answer. Use 0 if absent.
- Extract alternative product mentions as short product-like strings in alternativeMentions.
- Extract explicit alternative brand mentions in brandMentions, including brand-only mentions when they refer to competing or alternative brands.
- Exclude stores, marketplaces, retailers, and generic product categories from brandMentions.
- Do not guess missing facts.

JSON schema:
{
  "productHit": 0,
  "targetProductMentioned": 0,
  "exactModelMatch": 0,
  "rank": 0,
  "alternativeMentions": ["string"],
  "brandMentions": ["string"],
  "evidenceSnippet": "short quote or null",
  "judgeNotes": "brief note",
  "confidence": 0
}`;

interface JudgePayload {
  productHit?: number;
  targetProductMentioned?: number;
  exactModelMatch?: number;
  rank?: number;
  alternativeMentions?: string[];
  brandMentions?: string[];
  evidenceSnippet?: string | null;
  judgeNotes?: string | null;
  confidence?: number;
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
  const principalAliases = getPrincipalAliases(profile);
  const modelTokens = getPrincipalModelTokens(profile, principalAliases);
  const heuristicHit = computeHeuristicProductHit(principalAliases, execution.rawResponse);
  const heuristicCoverageHit = heuristicHit ? computeHeuristicProductCoverage(principalAliases, execution.rawResponse) : 0;
  const heuristicExactModelMatch = computeHeuristicExactModelMatch(modelTokens, principalAliases, execution.rawResponse);
  const heuristicRank = heuristicHit ? estimateRank(execution.rawResponse, principalAliases) : 0;
  const llmHit = Number(llmMetrics.productHit ?? 0);
  const llmTargetMention = Number(llmMetrics.targetProductMentioned ?? llmMetrics.productHit ?? 0);
  const llmExactModelMatch = Number(llmMetrics.exactModelMatch ?? 0);
  const llmRank = Number(llmMetrics.rank ?? 0);
  const productHit = resolveProductHit({
    heuristicHit,
    heuristicCoverageHit,
    heuristicExactModelMatch,
    llmHit,
    llmTargetMention,
    llmExactModelMatch,
    modelTokens,
  });
  const rank = productHit ? clampRank(llmRank || heuristicRank || 1, 1, 50) : 0;
  const evidenceSnippet = llmMetrics.evidenceSnippet ?? extractEvidence(profile, execution.rawResponse);

  const mentions = uniquePreserveOrder((llmMetrics.alternativeMentions ?? []).map((item) => normalizeWhitespace(item)).filter(Boolean));
  const brandMentions = uniquePreserveOrder((llmMetrics.brandMentions ?? []).map((item) => normalizeWhitespace(item)).filter(Boolean));
  const alternatives = await classifyAlternativeMentions({
    mentions: uniquePreserveOrder([...mentions, ...brandMentions]),
    principalAliases,
    ignoredAliases: [profile.storeName ?? "", ...(profile.vendorAliases ?? []), "Mercado Libre", "Musicamia", "TodoMusica", "MasMusica"],
    responseText: execution.rawResponse,
  });

  const vendorHit = productHit ? computeVendorHit(profile, execution.rawResponse) : 0;
  const exactUrlAccuracy = productHit ? await computeExactUrlAccuracy(profile, execution.detectedUrls, verifyDetectedUrls) : 0;
  const scoringReasons: ScoringReasons = {
    productHitReason:
      productHit === 1
        ? llmTargetMention === 1 && (llmExactModelMatch === 1 || heuristicExactModelMatch === 1)
          ? "La IA juez y las validaciones locales coinciden en que la respuesta habla del modelo exacto del producto objetivo."
          : "Las validaciones locales detectaron una mencion sustantiva del producto objetivo con coincidencia suficiente de modelo."
        : "No se detecto una aparicion valida del producto objetivo en la respuesta.",
    rankReason:
      rank > 0
        ? `Rank asignado por primera aparicion valida del producto objetivo: ${rank}.`
        : "Sin aparicion valida del producto objetivo, rank se fija en 0.",
    vendorHitReason:
      vendorHit === 1
        ? "Se detecto una referencia explicita a la tienda/proveedor junto con recomendacion valida del producto."
        : "No se detecto referencia valida a tienda/proveedor o no hubo product hit.",
    exactUrlReason:
      exactUrlAccuracy === 1
        ? "Se encontro URL canonica exacta (directa o resuelta)."
        : "No se encontro URL canonica exacta para esta respuesta.",
  };

  return {
    productHit: Math.max(productHit, 0),
    vendorHit,
    exactUrlAccuracy,
    internalAlternatives: Math.max(alternatives.internalAlternatives, 0),
    externalCompetitors: Math.max(alternatives.externalCompetitors, 0),
    rank: Math.max(rank, 0),
    scoringReasons,
    alternativeMentions: mentions,
    alternativeClassifications: alternatives.classifications,
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
          aliases: getPrincipalAliases(profile),
          modelTokens: getPrincipalModelTokens(profile, getPrincipalAliases(profile)),
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
  const aliases = getPrincipalAliases(profile);
  const modelTokens = getPrincipalModelTokens(profile, aliases);
  const productHit = computeHeuristicProductHit(aliases, execution.rawResponse);
  const exactModelMatch = computeHeuristicExactModelMatch(modelTokens, aliases, execution.rawResponse);

  return {
    productHit,
    targetProductMentioned: productHit,
    exactModelMatch,
    rank: productHit ? estimateRank(execution.rawResponse, aliases) : 0,
    alternativeMentions: estimateAlternativeMentions(execution.rawResponse, aliases),
    brandMentions: [],
    evidenceSnippet: extractEvidence(profile, execution.rawResponse),
    judgeNotes: "Heuristic judge used because OpenRouter judge was unavailable or invalid.",
    confidence: exactModelMatch ? 0.75 : productHit ? 0.55 : 0.25,
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
  return 0;
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
  const aliases = getPrincipalAliases(profile);
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

function computeHeuristicProductHit(aliases: string[], responseText: string): number {
  const normalizedText = normalizeForMatch(responseText);
  const compactText = compactForMatch(normalizedText);
  return aliases.some((alias) => aliasMatchesText(alias, normalizedText, compactText)) ? 1 : 0;
}

function computeHeuristicProductCoverage(aliases: string[], responseText: string): number {
  const segments = responseText
    .split(/\r?\n|(?<=[.!?])\s+/)
    .map((item) => normalizeWhitespace(item))
    .filter(Boolean);

  for (const segment of segments) {
    const normalizedSegment = normalizeForMatch(segment);
    const compactSegment = compactForMatch(normalizedSegment);
    if (!aliases.some((alias) => aliasMatchesText(alias, normalizedSegment, compactSegment))) {
      continue;
    }

    if (isSubstantiveProductSegment(normalizedSegment)) {
      return 1;
    }
  }

  return 0;
}

function getPrincipalAliases(profile: ProductProfile): string[] {
  return buildProductAliases(profile.productName, profile.brandName, profile.aliases ?? []);
}

function getPrincipalModelTokens(profile: ProductProfile, aliases: string[]): string[] {
  return extractProductModelTokens(profile.productName, aliases);
}

function computeHeuristicExactModelMatch(modelTokens: string[], aliases: string[], responseText: string): number {
  if (!modelTokens.length) {
    return computeHeuristicProductHit(aliases, responseText);
  }

  const normalizedText = normalizeForMatch(responseText);
  const compactText = compactForMatch(normalizedText);
  return modelTokens.some((token) => aliasMatchesText(token, normalizedText, compactText)) ? 1 : 0;
}

function resolveProductHit({
  heuristicHit,
  heuristicCoverageHit,
  heuristicExactModelMatch,
  llmHit,
  llmTargetMention,
  llmExactModelMatch,
  modelTokens,
}: {
  heuristicHit: number;
  heuristicCoverageHit: number;
  heuristicExactModelMatch: number;
  llmHit: number;
  llmTargetMention: number;
  llmExactModelMatch: number;
  modelTokens: string[];
}): number {
  if (heuristicHit !== 1) {
    return 0;
  }

  const exactModelConfirmed = modelTokens.length === 0 ? 1 : Number(llmExactModelMatch === 1 || heuristicExactModelMatch === 1);
  const relevantMentionConfirmed = Number(llmHit === 1 || llmTargetMention === 1 || heuristicCoverageHit === 1);
  return exactModelConfirmed === 1 && relevantMentionConfirmed === 1 ? 1 : 0;
}

function isSubstantiveProductSegment(normalizedSegment: string): boolean {
  if (!normalizedSegment) {
    return false;
  }

  const negativePatterns = [
    /\bno (?:encontre|encontramos|encontro|hay|hubo|tengo|tenemos|cuento con|dispongo de|se encontro|se encontraron|se hallaron)\b/,
    /\bsin (?:informacion|datos|detalle|detalles|resenas|evidencia)\b/,
    /\bdesconozco\b/,
    /\bno puedo (?:confirmar|asegurar|validar)\b/,
  ];
  if (negativePatterns.some((pattern) => pattern.test(normalizedSegment))) {
    return false;
  }

  const descriptivePattern = /\b(?:es|son|incluye|incluyen|cuenta|cuentan|tiene|tienen|ofrece|ofrecen|permite|permiten|sirve|sirven|destaca|destacan|viene|vienen|funciona|funcionan|ideal|recomendado|recomendada|recomendable)\b/;
  if (descriptivePattern.test(normalizedSegment)) {
    return true;
  }

  return normalizedSegment.split(" ").filter(Boolean).length >= 8;
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

function clampRank(value: number, min: number, max: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    return 0;
  }
  return Math.max(min, Math.min(max, Math.round(value)));
}
