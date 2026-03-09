import { NextRequest, NextResponse } from "next/server";

import { listRunsByProduct, runProductAudit } from "@/lib/orchestrator";
import type { ProductRunRequest } from "@/lib/types";

export const runtime = "nodejs";
export const maxDuration = 300;

export async function GET(request: NextRequest, context: { params: Promise<{ productId: string }> }) {
  const { productId } = await context.params;
  const limit = Number(request.nextUrl.searchParams.get("limit") ?? "20");
  return NextResponse.json(await listRunsByProduct(productId, Number.isNaN(limit) ? 20 : limit));
}

export async function POST(request: NextRequest, context: { params: Promise<{ productId: string }> }) {
  try {
    const { productId } = await context.params;
    const body = (await request.json()) as ProductRunRequest;
    const run = await runProductAudit(productId, body);
    return NextResponse.json(run);
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unknown error" }, { status: 400 });
  }
}
