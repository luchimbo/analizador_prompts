import { env } from "@/lib/env";

const LEGACY_GEMINI_MODELS = new Set([
  "google/gemini-2.5-pro",
  "google/gemini-2.5-pro:online",
]);

export function normalizeAuditedModel(provider: string | null | undefined, model: string | null | undefined): string | null {
  const trimmed = model?.trim();
  if (!trimmed) {
    return trimmed ?? null;
  }

  if (provider === "gemini" && LEGACY_GEMINI_MODELS.has(trimmed)) {
    return env.openRouterGeminiAuditModel;
  }

  return trimmed;
}

export function resolveConfiguredAuditedModel(provider: string | null | undefined, model: string | null | undefined): string | null {
  if (provider === "gemini") {
    return env.openRouterGeminiAuditModel;
  }

  return normalizeAuditedModel(provider, model);
}
