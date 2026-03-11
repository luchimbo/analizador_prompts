import { NextResponse } from "next/server";

import { env, getOpenRouterGeminiAuditModel } from "@/lib/env";

export const runtime = "nodejs";

export async function GET() {
  return NextResponse.json({
    status: "ok",
    openRouterConfigured: Boolean(env.openRouterApiKey),
    databaseMode: env.tursoDatabaseUrl.startsWith("file:") ? "local-libsql" : "turso",
    lockedMarket: env.defaultMarket,
    defaultOpenAiModel: env.openRouterOpenAiAuditModel,
    defaultGeminiModel: getOpenRouterGeminiAuditModel(),
  });
}
