import { NextResponse } from "next/server";

import { buildExcelBuffer } from "@/lib/excel";
import { getRun } from "@/lib/orchestrator";

export const runtime = "nodejs";

export async function GET(_: Request, context: { params: Promise<{ runId: string }> }) {
  const { runId } = await context.params;
  const run = await getRun(runId);
  if (!run) {
    return NextResponse.json({ error: "Run not found" }, { status: 404 });
  }

  const buffer = buildExcelBuffer(run);
  return new NextResponse(new Uint8Array(buffer), {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="${runId}.xlsx"`,
    },
  });
}
