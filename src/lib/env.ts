import { readFileSync } from "node:fs";
import path from "node:path";

const DEFAULT_GEMINI_MODEL = "google/gemini-2.5-flash-lite:online";
const LEGACY_GEMINI_MODELS = new Set([
  "google/gemini-2.5-pro",
  "google/gemini-2.5-pro:online",
]);

const env = {
  appName: process.env.APP_NAME ?? "IA Product Audit",
  requestTimeoutSeconds: Number(process.env.REQUEST_TIMEOUT_SECONDS ?? "60"),
  urlResolveTimeoutSeconds: Number(process.env.URL_RESOLVE_TIMEOUT_SECONDS ?? "8"),
  maxVerifiedUrlsPerPrompt: Number(process.env.MAX_VERIFIED_URLS_PER_PROMPT ?? "3"),
  defaultLanguage: process.env.DEFAULT_LANGUAGE ?? "es",
  defaultMarket: process.env.DEFAULT_MARKET ?? "Argentina",
  verifyDetectedUrls: process.env.VERIFY_DETECTED_URLS === "true",
  runConcurrency: Number(process.env.RUN_CONCURRENCY ?? "3"),
  tursoDatabaseUrl: process.env.TURSO_DATABASE_URL ?? "file:./data/ia-product-audit.db",
  tursoAuthToken: process.env.TURSO_AUTH_TOKEN ?? "",
  openRouterApiKey: process.env.OPENROUTER_API_KEY ?? "",
  openRouterBaseUrl: process.env.OPENROUTER_BASE_URL ?? "https://openrouter.ai/api/v1",
  openRouterGeneratorModel: process.env.OPENROUTER_GENERATOR_MODEL ?? DEFAULT_GEMINI_MODEL,
  openRouterJudgeModel: process.env.OPENROUTER_JUDGE_MODEL ?? "moonshotai/kimi-k2",
  openRouterOpenAiAuditModel: process.env.OPENROUTER_OPENAI_AUDIT_MODEL ?? "openai/gpt-4.1-mini",
  openRouterGeminiAuditModel: process.env.OPENROUTER_GEMINI_AUDIT_MODEL ?? DEFAULT_GEMINI_MODEL,
  openRouterWebPluginId: process.env.OPENROUTER_WEB_PLUGIN_ID ?? "web",
  openRouterSiteUrl: process.env.OPENROUTER_SITE_URL ?? "",
  openRouterAppName: process.env.OPENROUTER_APP_NAME ?? "ia-product-audit",
};

function readDotEnvValue(name: string): string | null {
  try {
    const envPath = path.resolve(process.cwd(), ".env");
    const contents = readFileSync(envPath, "utf8");
    for (const line of contents.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) {
        continue;
      }

      const separatorIndex = trimmed.indexOf("=");
      if (separatorIndex < 0) {
        continue;
      }

      const key = trimmed.slice(0, separatorIndex).trim();
      if (key !== name) {
        continue;
      }

      const value = trimmed.slice(separatorIndex + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        return value.slice(1, -1);
      }

      return value;
    }
  } catch {
    return null;
  }

  return null;
}

function normalizeModelValue(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function isGeminiModel(value: string | null | undefined): boolean {
  return normalizeModelValue(value)?.toLowerCase().includes("gemini") ?? false;
}

function isLegacyGeminiModel(value: string | null | undefined): boolean {
  const normalized = normalizeModelValue(value);
  return normalized ? LEGACY_GEMINI_MODELS.has(normalized) : false;
}

export function getOpenRouterGeneratorModel(): string {
  const configured = normalizeModelValue(readDotEnvValue("OPENROUTER_GENERATOR_MODEL") || env.openRouterGeneratorModel);
  if (!configured) {
    return DEFAULT_GEMINI_MODEL;
  }
  if (isLegacyGeminiModel(configured)) {
    return DEFAULT_GEMINI_MODEL;
  }
  return configured;
}

export function getOpenRouterGeminiAuditModel(): string {
  const auditConfigured = normalizeModelValue(readDotEnvValue("OPENROUTER_GEMINI_AUDIT_MODEL") || env.openRouterGeminiAuditModel);
  const generatorConfigured = normalizeModelValue(readDotEnvValue("OPENROUTER_GENERATOR_MODEL") || env.openRouterGeneratorModel);

  if (auditConfigured && isGeminiModel(auditConfigured) && !isLegacyGeminiModel(auditConfigured)) {
    return auditConfigured;
  }

  if (generatorConfigured && isGeminiModel(generatorConfigured) && !isLegacyGeminiModel(generatorConfigured)) {
    return generatorConfigured;
  }

  return DEFAULT_GEMINI_MODEL;
}

export function assertOpenRouterKey(): string {
  if (!env.openRouterApiKey) {
    throw new Error("OPENROUTER_API_KEY is not configured in .env");
  }
  return env.openRouterApiKey;
}

export { env };
