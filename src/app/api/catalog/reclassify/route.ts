import { NextResponse } from "next/server";

import { reclassifyHistoricalRunResults } from "@/lib/catalog";

export const runtime = "nodejs";

export async function POST() {
  try {
    const outcome = await reclassifyHistoricalRunResults();
    return NextResponse.json({ ok: true, updated: outcome.updated });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "No se pudo recalcular historico" },
      { status: 500 },
    );
  }
}
