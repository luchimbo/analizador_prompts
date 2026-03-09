import { NextResponse } from "next/server";

import { getProduct } from "@/lib/orchestrator";

export const runtime = "nodejs";

export async function GET(_: Request, context: { params: Promise<{ productId: string }> }) {
  const { productId } = await context.params;
  const product = await getProduct(productId);
  if (!product) {
    return NextResponse.json({ error: "Product not found" }, { status: 404 });
  }
  return NextResponse.json(product);
}
