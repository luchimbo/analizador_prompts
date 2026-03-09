import { NextRequest, NextResponse } from "next/server";

import { generateProductPrompts, updateSavedProductPrompt } from "@/lib/orchestrator";
import type { UpdateProductPromptRequest } from "@/lib/types";

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

export async function PATCH(request: NextRequest, context: { params: Promise<{ productId: string }> }) {
  try {
    const { productId } = await context.params;
    const body = (await request.json()) as UpdateProductPromptRequest;
    const product = await updateSavedProductPrompt(productId, body.promptId, body.prompt);
    return NextResponse.json(product);
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unknown error" }, { status: 400 });
  }
}
