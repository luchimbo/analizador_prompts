import * as XLSX from "xlsx";

import { getPromptPlanLabel } from "@/lib/audit-metrics";
import type { AuditRunResponse, ImprovementComparisonRow } from "@/lib/types";

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
    Internal_Alternatives: result.internalAlternatives,
    External_Competitors: result.externalCompetitors,
    Rank: result.rank,
    Alternative_Mentions: (result.alternativeMentions ?? []).join("\n"),
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
    { Field: "Prompt_Plan", Value: getPromptPlanLabel(run.promptBank.prompts.length) },
    { Field: "Total_Prompts", Value: run.summary?.totalPrompts ?? 0 },
    { Field: "Overall_Score", Value: run.summary?.overallScore ?? 0 },
    { Field: "Score_Label", Value: run.summary?.scoreLabel ?? "" },
    { Field: "Product_Hit_Rate", Value: run.summary?.productHitRate ?? 0 },
    { Field: "Vendor_Hit_Rate", Value: run.summary?.vendorHitRate ?? 0 },
    { Field: "Exact_URL_Accuracy_Rate", Value: run.summary?.exactUrlAccuracyRate ?? 0 },
    { Field: "Average_Internal_Alternatives", Value: run.summary?.averageInternalAlternatives ?? 0 },
    { Field: "Average_External_Competitors", Value: run.summary?.averageExternalCompetitors ?? 0 },
    { Field: "Average_Rank_When_Present", Value: run.summary?.averageRankWhenPresent ?? 0 },
    { Field: "Score_Product_Hit_Points", Value: run.summary?.scoreBreakdown.productHitPoints ?? 0 },
    { Field: "Score_Rank_Points", Value: run.summary?.scoreBreakdown.rankPoints ?? 0 },
    { Field: "Score_Exact_URL_Points", Value: run.summary?.scoreBreakdown.exactUrlPoints ?? 0 },
    { Field: "Score_Vendor_Points", Value: run.summary?.scoreBreakdown.vendorPoints ?? 0 },
    { Field: "Score_External_Penalty_Points", Value: run.summary?.scoreBreakdown.externalPenaltyPoints ?? 0 },
    { Field: "Score_Internal_Bonus_Points", Value: run.summary?.scoreBreakdown.internalBonusPoints ?? 0 },
  ];

  XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(detailRows), "Prompt Detail");
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(summaryRows), "Summary");

  return XLSX.write(workbook, { type: "buffer", bookType: "xlsx" }) as Buffer;
}

export function buildImprovementComparisonExcelBuffer(rows: ImprovementComparisonRow[]): Buffer {
  const workbook = XLSX.utils.book_new();

  const summaryRows = rows.map((row) => ({
    Product_ID: row.productId,
    Product: row.productName,
    Brand: row.brandName ?? "",
    Store: row.storeName ?? "",
    First_Run_ID: row.firstRunId ?? "",
    First_Run_At: row.firstRunAt ?? "",
    Score_Before: row.firstRunScore ?? "",
    Second_Run_ID: row.secondRunId ?? "",
    Second_Run_At: row.secondRunAt ?? "",
    Score_After: row.secondRunScore ?? "",
    Score_Difference: row.scoreDifference ?? "",
    Product_Hit_Before: row.productHitBefore ?? "",
    Product_Hit_After: row.productHitAfter ?? "",
    Product_Hit_Difference: row.productHitDifference ?? "",
    Vendor_Hit_Before: row.vendorHitBefore ?? "",
    Vendor_Hit_After: row.vendorHitAfter ?? "",
    Vendor_Hit_Difference: row.vendorHitDifference ?? "",
    Exact_URL_Before: row.exactUrlBefore ?? "",
    Exact_URL_After: row.exactUrlAfter ?? "",
    Exact_URL_Difference: row.exactUrlDifference ?? "",
    Avg_Rank_Before: row.avgRankBefore ?? "",
    Avg_Rank_After: row.avgRankAfter ?? "",
    Avg_Rank_Difference: row.avgRankDifference ?? "",
    Internal_Bonus_Base_Before: row.internalBaseBefore ?? "",
    Internal_Bonus_Base_After: row.internalBaseAfter ?? "",
    Internal_Bonus_Base_Difference: row.internalBaseDifference ?? "",
    External_Penalty_Base_Before: row.externalBaseBefore ?? "",
    External_Penalty_Base_After: row.externalBaseAfter ?? "",
    External_Penalty_Base_Difference: row.externalBaseDifference ?? "",
  }));

  XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(summaryRows), "Improvement Impact");
  return XLSX.write(workbook, { type: "buffer", bookType: "xlsx" }) as Buffer;
}
