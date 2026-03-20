import { NextResponse } from "next/server";

import { buildImprovementComparisonExcelBuffer } from "@/lib/excel";
import { listImprovementComparisonRows } from "@/lib/orchestrator";

export const runtime = "nodejs";

export async function GET() {
  const rows = await listImprovementComparisonRows();
  const buffer = buildImprovementComparisonExcelBuffer(rows);

  return new NextResponse(new Uint8Array(buffer), {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": 'attachment; filename="improvement-score-comparison.xlsx"',
    },
  });
}
