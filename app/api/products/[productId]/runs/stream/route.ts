import { NextRequest } from "next/server";

import { ensureReadyPromptBank, getProduct, runProductAuditWithProgress } from "@/lib/orchestrator";
import type { ProductRunRequest, RunProgressEvent } from "@/lib/types";

export const runtime = "nodejs";
export const maxDuration = 300;

export async function POST(request: NextRequest, context: { params: Promise<{ productId: string }> }) {
  try {
    const { productId } = await context.params;
    const body = (await request.json()) as ProductRunRequest;
    const product = await getProduct(productId);
    if (!product) {
      return Response.json({ error: "Product not found" }, { status: 404 });
    }
    const promptBank = ensureReadyPromptBank(product);

    const encoder = new TextEncoder();

    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const push = (event: RunProgressEvent) => {
          controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
        };

        try {
          push({
            type: "started",
            current: 0,
            total: promptBank.prompts.length,
            message: "Run started",
          });

          const run = await runProductAuditWithProgress(productId, body, (update) => {
            push({
              type: "progress",
              current: update.current,
              total: update.total,
              promptId: update.promptId,
              promptType: update.promptType,
              promptText: update.promptText,
              result: update.result,
            });
          });

          push({ type: "complete", current: run.results.length, total: run.results.length, run });
        } catch (error) {
          push({
            type: "error",
            message: error instanceof Error ? error.message : "Unknown error",
          });
        } finally {
          controller.close();
        }
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "application/x-ndjson; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
      },
    });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Unknown error" }, { status: 400 });
  }
}
