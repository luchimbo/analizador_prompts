import * as XLSX from "xlsx";

import type { AuditRunResponse } from "@/lib/types";

export function buildExcelBuffer(run: AuditRunResponse): Buffer {
  const workbook = XLSX.utils.book_new();

  const detailRows = run.results.map((result) => ({
    Request_ID: result.requestId,
    Prompt_ID: result.promptId,
    Prompt_Type: result.promptType,
    Prompt: result.promptText,
    Raw_Response: result.rawResponse,
    Product_Hit: result.productHit,
    Vendor_Hit: result.vendorHit,
    Exact_URL_Accuracy: result.exactUrlAccuracy,
    Product_Competitors: result.productCompetitors,
    Rank: result.rank,
    Detected_URLs: result.detectedUrls.join("\n"),
    Evidence_Snippet: result.evidenceSnippet ?? "",
    Model_Audited: `${run.auditedProvider}:${run.auditedModel}`,
    Timestamp: result.createdAt,
  }));

  const summaryRows = [
    { Field: "Run_ID", Value: run.runId },
    { Field: "Status", Value: run.status },
    { Field: "Product", Value: run.productProfile.productName },
    { Field: "Brand", Value: run.productProfile.brandName ?? "" },
    { Field: "Store", Value: run.productProfile.storeName ?? "" },
    { Field: "Canonical_URL", Value: run.productProfile.canonicalUrl },
    { Field: "Audited_Model", Value: `${run.auditedProvider}:${run.auditedModel}` },
    { Field: "Total_Prompts", Value: run.summary?.totalPrompts ?? 0 },
    { Field: "Product_Hit_Rate", Value: run.summary?.productHitRate ?? 0 },
    { Field: "Vendor_Hit_Rate", Value: run.summary?.vendorHitRate ?? 0 },
    { Field: "Exact_URL_Accuracy_Rate", Value: run.summary?.exactUrlAccuracyRate ?? 0 },
    { Field: "Average_Competitors", Value: run.summary?.averageCompetitors ?? 0 },
    { Field: "Average_Rank_When_Present", Value: run.summary?.averageRankWhenPresent ?? 0 },
  ];

  XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(detailRows), "Prompt Detail");
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(summaryRows), "Summary");

  return XLSX.write(workbook, { type: "buffer", bookType: "xlsx" }) as Buffer;
}
