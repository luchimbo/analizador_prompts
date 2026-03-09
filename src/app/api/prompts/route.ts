import { NextRequest, NextResponse } from "next/server";

import { previewPromptBank } from "@/lib/orchestrator";
import type { PromptBankRequest } from "@/lib/types";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as PromptBankRequest;
    const bank = await previewPromptBank(body);
    return NextResponse.json(bank);
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unknown error" }, { status: 400 });
  }
}
