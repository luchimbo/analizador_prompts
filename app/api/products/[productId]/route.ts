import { NextResponse } from "next/server";

import { deleteProduct, getProduct } from "@/lib/orchestrator";

export const runtime = "nodejs";

export async function GET(_: Request, context: { params: Promise<{ productId: string }> }) {
  const { productId } = await context.params;
  const product = await getProduct(productId);
  if (!product) {
    return NextResponse.json({ error: "Product not found" }, { status: 404 });
  }
  return NextResponse.json(product);
}

export async function DELETE(_: Request, context: { params: Promise<{ productId: string }> }) {
  try {
    const { productId } = await context.params;
    const deleted = await deleteProduct(productId);
    if (!deleted) {
      return NextResponse.json({ error: "Product not found" }, { status: 404 });
    }
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unknown error" }, { status: 500 });
  }
}
