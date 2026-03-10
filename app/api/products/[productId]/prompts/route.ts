import { NextRequest, NextResponse } from "next/server";

import { generateProductPrompts } from "@/lib/orchestrator";

export const runtime = "nodejs";

export async function POST(_: Request, context: { params: Promise<{ productId: string }> }) {
  try {
    const { productId } = await context.params;
    const product = await generateProductPrompts(productId);
    return NextResponse.json(product);
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unknown error" }, { status: 400 });
  }
}

export async function PATCH(_: NextRequest) {
  return NextResponse.json({ error: "Los prompts guardados son inmutables y no se pueden editar." }, { status: 405 });
}
