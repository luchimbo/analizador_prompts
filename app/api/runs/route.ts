import { NextRequest, NextResponse } from "next/server";

import { listRuns, runAudit } from "@/lib/orchestrator";
import type { AuditRunRequest } from "@/lib/types";

export const runtime = "nodejs";
export const maxDuration = 300;

export async function GET(request: NextRequest) {
  const limit = Number(request.nextUrl.searchParams.get("limit") ?? "20");
  return NextResponse.json(await listRuns(Number.isNaN(limit) ? 20 : limit));
}

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as AuditRunRequest;
    const run = await runAudit(body);
    return NextResponse.json(run);
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unknown error" }, { status: 400 });
  }
}
