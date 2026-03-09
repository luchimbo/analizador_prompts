import { NextRequest, NextResponse } from "next/server";

import { profileProduct } from "@/lib/orchestrator";
import type { ProfileRequest } from "@/lib/types";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as ProfileRequest;
    const profile = await profileProduct(body);
    return NextResponse.json(profile);
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unknown error" }, { status: 400 });
  }
}
