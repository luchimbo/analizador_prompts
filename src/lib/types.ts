export type PromptType = "problem" | "discovery" | "comparison" | "transactional" | "branded";
export type AuditedProvider = "openai" | "gemini" | "custom";
export type RunStatus = "pending" | "running" | "completed" | "failed";

export interface ProductProfileOverrides {
  productName?: string;
  brandName?: string;
  storeName?: string;
  canonicalUrl?: string;
  category?: string;
  aliases?: string[];
  vendorAliases?: string[];
  competitorNames?: string[];
}

export interface ProductProfile {
  sourceUrl: string;
  canonicalUrl: string;
  domain: string;
  productName: string;
  brandName?: string | null;
  storeName?: string | null;
  category?: string | null;
  pageTitle?: string | null;
  metaDescription?: string | null;
  aliases: string[];
  vendorAliases: string[];
  competitorNames: string[];
  extractionNotes: string[];
}

export interface ProfileRequest {
  productUrl: string;
  overrides?: ProductProfileOverrides;
}

export interface AuditPrompt {
  id: string;
  type: PromptType;
  prompt: string;
}

export interface PromptBank {
  productName: string;
  brandName?: string | null;
  category?: string | null;
  language: string;
  market: string;
  prompts: AuditPrompt[];
}

export interface PromptBankRequest {
  productUrl: string;
  language?: string;
  market?: string;
  overrides?: ProductProfileOverrides;
}

export interface PromptExecutionResult {
  requestId: string;
  promptId: string;
  promptType: PromptType;
  promptText: string;
  rawResponse: string;
  detectedUrls: string[];
  citedUrls: string[];
  modelProvider: string;
  modelName: string;
  latencyMs: number;
  createdAt: string;
}

export interface JudgedMetrics {
  productHit: number;
  vendorHit: number;
  exactUrlAccuracy: number;
  internalAlternatives: number;
  externalCompetitors: number;
  rank: number;
  scoringReasons?: ScoringReasons;
  alternativeMentions?: string[];
  alternativeClassifications?: AlternativeClassification[];
  evidenceSnippet?: string | null;
  judgeProvider?: string | null;
  judgeModel?: string | null;
  judgeNotes?: string | null;
}

export interface ScoringReasons {
  productHitReason: string;
  rankReason: string;
  vendorHitReason: string;
  exactUrlReason: string;
}

export interface AlternativeClassification {
  mention: string;
  normalizedMention: string;
  classification: "internal" | "external" | "ignored";
  reason: "principal_mention" | "ignored_entity" | "brand_only" | "duplicate_brand" | "catalog_match" | "brand_override" | "unmatched" | "unknown_brand";
  matchedSku?: string | null;
  matchedName?: string | null;
  matchedBrand?: string | null;
}

export interface PromptAuditResult extends PromptExecutionResult, JudgedMetrics {}

export interface RunScoreBreakdown {
  productHitPoints: number;
  rankPoints: number;
  exactUrlPoints: number;
  vendorPoints: number;
  externalPenaltyPoints: number;
  internalBonusPoints: number;
}

export interface RunSummary {
  totalPrompts: number;
  productHitRate: number;
  vendorHitRate: number;
  exactUrlAccuracyRate: number;
  averageInternalAlternatives: number;
  averageExternalCompetitors: number;
  averageRankWhenPresent: number;
  overallScore: number;
  scoreLabel: string;
  scoreBreakdown: RunScoreBreakdown;
}

export interface AuditRunRequest {
  productUrl: string;
  auditedProvider?: AuditedProvider;
  auditedModel?: string;
  language?: string;
  market?: string;
  enableWebSearch?: boolean;
  verifyDetectedUrls?: boolean;
  overrides?: ProductProfileOverrides;
}

export interface AuditRunResponse {
  runId: string;
  productId?: string | null;
  status: RunStatus;
  createdAt: string;
  auditedProvider: string;
  auditedModel: string;
  productProfile: ProductProfile;
  promptBank: PromptBank;
  results: PromptAuditResult[];
  summary?: RunSummary | null;
  exportPath?: string | null;
  errorMessage?: string | null;
  errorStage?: string | null;
  failedPromptId?: string | null;
  failedPromptText?: string | null;
  completedPrompts?: number;
  resumable?: boolean;
}

export interface RunListItem {
  runId: string;
  productId?: string | null;
  status: RunStatus;
  createdAt: string;
  auditedProvider: string;
  auditedModel: string;
  productName?: string | null;
  exportPath?: string | null;
}

export interface SavedProduct {
  productId: string;
  createdAt: string;
  updatedAt: string;
  language: string;
  market: string;
  lockedAuditedProvider?: string | null;
  lockedAuditedModel?: string | null;
  profile: ProductProfile;
  promptBank?: PromptBank | null;
  latestRunId?: string | null;
}

export interface ProductListItem {
  productId: string;
  createdAt: string;
  updatedAt: string;
  productName: string;
  brandName?: string | null;
  category?: string | null;
  storeName?: string | null;
  sourceUrl: string;
  canonicalUrl: string;
  promptCount: number;
  runCount: number;
  latestRunId?: string | null;
  lockedAuditedProvider?: string | null;
  lockedAuditedModel?: string | null;
}

export interface CreateProductRequest {
  productUrl: string;
  language?: string;
  market?: string;
  overrides?: ProductProfileOverrides;
}

export interface ProductRunRequest {
  resumeRunId?: string;
  auditedProvider?: AuditedProvider;
  auditedModel?: string;
  language?: string;
  market?: string;
  enableWebSearch?: boolean;
  verifyDetectedUrls?: boolean;
}

export interface UpdateProductPromptRequest {
  promptId: string;
  prompt: string;
}

export interface RunProgressEvent {
  type: "started" | "progress" | "complete" | "error";
  current?: number;
  total?: number;
  promptId?: string;
  promptType?: PromptType;
  promptText?: string;
  message?: string;
  result?: PromptAuditResult;
  run?: AuditRunResponse;
}
