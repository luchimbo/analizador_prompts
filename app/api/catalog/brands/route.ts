import { NextResponse } from "next/server";

import { listCatalogBrandRules, setCatalogBrandRule } from "@/lib/catalog";

export const runtime = "nodejs";

export async function GET() {
  try {
    const items = await listCatalogBrandRules();
    const totals = items.reduce(
      (acc, item) => {
        if (item.classification === "internal") {
          acc.internalBrands += 1;
          acc.internalSkus += item.skuCount;
        } else {
          acc.externalBrands += 1;
          acc.externalSkus += item.skuCount;
        }
        return acc;
      },
      {
        totalBrands: items.length,
        internalBrands: 0,
        externalBrands: 0,
        internalSkus: 0,
        externalSkus: 0,
      },
    );

    return NextResponse.json({ items, totals });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "No se pudo cargar clasificacion de marcas" },
      { status: 500 },
    );
  }
}

export async function PATCH(request: Request) {
  try {
    const payload = (await request.json()) as { brand?: string; classification?: "internal" | "external" };
    if (!payload.brand || !payload.classification) {
      return NextResponse.json({ error: "brand y classification son requeridos" }, { status: 400 });
    }

    if (payload.classification !== "internal" && payload.classification !== "external") {
      return NextResponse.json({ error: "classification debe ser internal o external" }, { status: 400 });
    }

    await setCatalogBrandRule(payload.brand, payload.classification);
    const items = await listCatalogBrandRules();

    return NextResponse.json({ items });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "No se pudo guardar clasificacion" },
      { status: 500 },
    );
  }
}
