import { NextResponse } from "next/server";

import { env } from "@/lib/env";

export const runtime = "nodejs";

export async function GET() {
  return NextResponse.json({
    status: "ok",
    openRouterConfigured: Boolean(env.openRouterApiKey),
    defaultOpenAiModel: env.openRouterOpenAiAuditModel,
    defaultGeminiModel: env.openRouterGeminiAuditModel,
    defaultGrokModel: env.openRouterGrokAuditModel,
    defaultKimiModel: env.openRouterGrokAuditModel,
  });
}
