import { NextRequest, NextResponse } from "next/server";

import { deleteProduct, getProduct, setProductDescriptionImproved, setProductImprovementCheckpoints } from "@/lib/orchestrator";
import type { UpdateProductImprovementRequest } from "@/lib/types";

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

export async function PATCH(request: NextRequest, context: { params: Promise<{ productId: string }> }) {
  try {
    const { productId } = await context.params;
    const body = (await request.json()) as UpdateProductImprovementRequest;
    let product = await getProduct(productId);
    if (!product) {
      return NextResponse.json({ error: "Product not found" }, { status: 404 });
    }

    if (Object.prototype.hasOwnProperty.call(body, "descriptionImproved")) {
      product = await setProductDescriptionImproved(productId, Boolean(body.descriptionImproved));
    }

    if (Object.prototype.hasOwnProperty.call(body, "firstRunAt") || Object.prototype.hasOwnProperty.call(body, "secondRunAt")) {
      product = await setProductImprovementCheckpoints(productId, {
        ...(Object.prototype.hasOwnProperty.call(body, "firstRunAt") ? { firstRunAt: body.firstRunAt ?? null } : {}),
        ...(Object.prototype.hasOwnProperty.call(body, "secondRunAt") ? { secondRunAt: body.secondRunAt ?? null } : {}),
      });
    }

    return NextResponse.json(product);
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unknown error" }, { status: 400 });
  }
}
