const env = {
  appName: process.env.APP_NAME ?? "IA Product Audit",
  defaultLanguage: process.env.DEFAULT_LANGUAGE ?? "es",
  defaultMarket: process.env.DEFAULT_MARKET ?? "Argentina",
  verifyDetectedUrls: process.env.VERIFY_DETECTED_URLS === "true",
  runConcurrency: Number(process.env.RUN_CONCURRENCY ?? "3"),
  tursoDatabaseUrl: process.env.TURSO_DATABASE_URL ?? "file:./data/ia-product-audit.db",
  tursoAuthToken: process.env.TURSO_AUTH_TOKEN ?? "",
  openRouterApiKey: process.env.OPENROUTER_API_KEY ?? "",
  openRouterBaseUrl: process.env.OPENROUTER_BASE_URL ?? "https://openrouter.ai/api/v1",
  openRouterGeneratorModel: process.env.OPENROUTER_GENERATOR_MODEL ?? "google/gemini-2.5-flash",
  openRouterJudgeModel: process.env.OPENROUTER_JUDGE_MODEL ?? "moonshotai/kimi-k2",
  openRouterOpenAiAuditModel: process.env.OPENROUTER_OPENAI_AUDIT_MODEL ?? "openai/gpt-4.1-mini",
  openRouterGeminiAuditModel: process.env.OPENROUTER_GEMINI_AUDIT_MODEL ?? "google/gemini-2.5-pro",
  openRouterKimiAuditModel: process.env.OPENROUTER_KIMI_AUDIT_MODEL ?? "moonshotai/kimi-k2",
  openRouterWebPluginId: process.env.OPENROUTER_WEB_PLUGIN_ID ?? "web",
  openRouterSiteUrl: process.env.OPENROUTER_SITE_URL ?? "",
  openRouterAppName: process.env.OPENROUTER_APP_NAME ?? "ia-product-audit",
};

export function assertOpenRouterKey(): string {
  if (!env.openRouterApiKey) {
    throw new Error("OPENROUTER_API_KEY is not configured in .env");
  }
  return env.openRouterApiKey;
}

export { env };
