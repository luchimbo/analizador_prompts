import type { PromptAuditResult, PromptBank, PromptType, RunScoreBreakdown, RunSummary } from "@/lib/types";

export const STANDARD_PROMPT_COUNT = 25;
export const LEGACY_PROMPT_COUNT = 50;

export const STANDARD_TYPE_COUNTS: Record<PromptType, number> = {
  problem: 9,
  discovery: 5,
  comparison: 5,
  transactional: 3,
  branded: 3,
};

export const LEGACY_TYPE_COUNTS: Record<PromptType, number> = {
  problem: 20,
  discovery: 10,
  comparison: 10,
  transactional: 5,
  branded: 5,
};

export function isSupportedPromptCount(count: number): boolean {
  return count === STANDARD_PROMPT_COUNT || count === LEGACY_PROMPT_COUNT;
}

export function isLegacyPromptCount(count: number): boolean {
  return count === LEGACY_PROMPT_COUNT;
}

export function inferPromptCount(bank?: Pick<PromptBank, "prompts"> | null): number {
  return bank?.prompts.length ?? 0;
}

export function getPromptPlanLabel(count: number): string {
  if (count === LEGACY_PROMPT_COUNT) {
    return `${count} prompts legacy`;
  }
  if (count === STANDARD_PROMPT_COUNT) {
    return `${count} prompts`;
  }
  return `${count} prompts`;
}

export function getPromptPlanDescription(count: number): string {
  if (count === LEGACY_PROMPT_COUNT) {
    return `${count} prompts legacy`;
  }
  return `${STANDARD_PROMPT_COUNT} prompts nuevos`;
}

export function getExpectedTypeCounts(count: number): Record<PromptType, number> | null {
  if (count === STANDARD_PROMPT_COUNT) {
    return STANDARD_TYPE_COUNTS;
  }
  if (count === LEGACY_PROMPT_COUNT) {
    return LEGACY_TYPE_COUNTS;
  }
  return null;
}

export function buildRunSummary(results: PromptAuditResult[]): RunSummary {
  const total = results.length;
  const productHits = results.reduce((acc, result) => acc + result.productHit, 0);
  const vendorHits = results.reduce((acc, result) => acc + result.vendorHit, 0);
  const exactHits = results.reduce((acc, result) => acc + result.exactUrlAccuracy, 0);
  const internalTotal = results.reduce((acc, result) => acc + result.internalAlternatives, 0);
  const externalTotal = results.reduce((acc, result) => acc + result.externalCompetitors, 0);
  const ranks = results.map((result) => result.rank).filter((rank) => rank > 0);

  const productHitRate = total ? round(productHits / total) : 0;
  const vendorHitRate = total ? round(vendorHits / total) : 0;
  const exactUrlAccuracyRate = total ? round(exactHits / total) : 0;
  const averageInternalAlternatives = total ? round(internalTotal / total) : 0;
  const averageExternalCompetitors = total ? round(externalTotal / total) : 0;
  const averageRankWhenPresent = ranks.length ? round(ranks.reduce((acc, rank) => acc + rank, 0) / ranks.length) : 0;
  const rankQualityRate = total ? round(results.reduce((acc, result) => acc + normalizeRank(result.rank), 0) / total) : 0;
  const externalPressureRate = clamp01(1 - averageExternalCompetitors / 4);
  const internalPressureRate = clamp01(1 - averageInternalAlternatives / 4);

  const scoreBreakdown: RunScoreBreakdown = {
    productHitPoints: round(productHitRate * 40),
    rankPoints: round(rankQualityRate * 20),
    exactUrlPoints: round(exactUrlAccuracyRate * 15),
    vendorPoints: round(vendorHitRate * 10),
    externalPressurePoints: round(externalPressureRate * 10),
    internalPressurePoints: round(internalPressureRate * 5),
  };

  const overallScore = round(
    scoreBreakdown.productHitPoints +
      scoreBreakdown.rankPoints +
      scoreBreakdown.exactUrlPoints +
      scoreBreakdown.vendorPoints +
      scoreBreakdown.externalPressurePoints +
      scoreBreakdown.internalPressurePoints,
  );

  return {
    totalPrompts: total,
    productHitRate,
    vendorHitRate,
    exactUrlAccuracyRate,
    averageInternalAlternatives,
    averageExternalCompetitors,
    averageRankWhenPresent,
    overallScore,
    scoreLabel: classifyScore(overallScore),
    scoreBreakdown,
  };
}

export function ensureRunSummary(summary: RunSummary | null | undefined, results: PromptAuditResult[]): RunSummary | null {
  if (!summary) {
    return results.length ? buildRunSummary(results) : null;
  }
  if (typeof summary.overallScore !== "number" || !summary.scoreBreakdown) {
    return results.length ? buildRunSummary(results) : { ...summary, overallScore: 0, scoreLabel: classifyScore(0), scoreBreakdown: emptyBreakdown() };
  }
  return summary;
}

function normalizeRank(rank: number): number {
  if (!Number.isFinite(rank) || rank <= 0) {
    return 0;
  }
  const bounded = Math.min(Math.round(rank), 10);
  return round((11 - bounded) / 10);
}

function classifyScore(score: number): string {
  if (score >= 90) {
    return "excelente";
  }
  if (score >= 70) {
    return "fuerte";
  }
  if (score >= 50) {
    return "media";
  }
  if (score >= 30) {
    return "debil";
  }
  return "muy baja";
}

function emptyBreakdown(): RunScoreBreakdown {
  return {
    productHitPoints: 0,
    rankPoints: 0,
    exactUrlPoints: 0,
    vendorPoints: 0,
    externalPressurePoints: 0,
    internalPressurePoints: 0,
  };
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
