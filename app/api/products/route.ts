import { NextRequest, NextResponse } from "next/server";

import { createProduct, listProducts } from "@/lib/orchestrator";
import type { CreateProductRequest } from "@/lib/types";

export const runtime = "nodejs";

export async function GET() {
  return NextResponse.json(await listProducts());
}

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as CreateProductRequest;
    const product = await createProduct(body);
    return NextResponse.json(product);
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unknown error" }, { status: 400 });
  }
}
