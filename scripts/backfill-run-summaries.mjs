import fs from "node:fs";

import { createClient } from "@libsql/client";

function parseEnv(filePath) {
  const raw = fs.readFileSync(filePath, "utf8");
  const pairs = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"))
    .map((line) => {
      const idx = line.indexOf("=");
      if (idx === -1) return null;
      return [line.slice(0, idx).trim(), line.slice(idx + 1).trim()];
    })
    .filter(Boolean);
  return Object.fromEntries(pairs);
}

function round(value) {
  return Math.round(value * 100) / 100;
}

function clamp01(value) {
  return Math.max(0, Math.min(1, value));
}

function clampScore(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function normalizeRank(rank) {
  if (!Number.isFinite(rank) || rank <= 0) {
    return 0;
  }
  const bounded = Math.round(rank);
  if (bounded === 1) {
    return 1;
  }
  if (bounded === 2) {
    return 0.5;
  }
  return 0;
}

function classifyScore(score) {
  if (score >= 90) return "excelente";
  if (score >= 70) return "fuerte";
  if (score >= 50) return "media";
  if (score >= 30) return "debil";
  return "muy baja";
}

function buildRunSummary(results) {
  const total = results.length;
  const productHits = results.reduce((acc, result) => acc + result.productHit, 0);
  const vendorHits = results.reduce((acc, result) => acc + result.vendorHit, 0);
  const exactHits = results.reduce((acc, result) => acc + result.exactUrlAccuracy, 0);
  const internalTotal = results.reduce((acc, result) => acc + result.internalAlternatives, 0);
  const externalTotal = results.reduce((acc, result) => acc + result.externalCompetitors, 0);
  const ranks = results.map((result) => result.rank).filter((rank) => rank > 0);

  const productHitRate = total ? round(productHits / total) : 0;
  const vendorHitRate = total ? round(vendorHits / total) : 0;
  const exactUrlAccuracyRate = total ? round(exactHits / total) : 0;
  const averageInternalAlternatives = total ? round(internalTotal / total) : 0;
  const averageExternalCompetitors = total ? round(externalTotal / total) : 0;
  const averageRankWhenPresent = ranks.length ? round(ranks.reduce((acc, rank) => acc + rank, 0) / ranks.length) : 0;
  const rankQualityRate = total ? round(results.reduce((acc, result) => acc + normalizeRank(result.rank), 0) / total) : 0;
  const internalBonusPoints = round(clamp01(averageInternalAlternatives / 2) * 15);
  const externalPenaltyPoints = round(clamp01(averageExternalCompetitors / 2) * -15);

  const scoreBreakdown = {
    productHitPoints: round(productHitRate * 30),
    rankPoints: round(rankQualityRate * 10),
    exactUrlPoints: round(exactUrlAccuracyRate * 25),
    vendorPoints: round(vendorHitRate * 35),
    externalPenaltyPoints,
    internalBonusPoints,
  };

  const overallScore = round(
    clampScore(
      scoreBreakdown.productHitPoints +
        scoreBreakdown.rankPoints +
        scoreBreakdown.exactUrlPoints +
        scoreBreakdown.vendorPoints +
        scoreBreakdown.externalPenaltyPoints +
        scoreBreakdown.internalBonusPoints,
      0,
      100,
    ),
  );

  return {
    totalPrompts: total,
    productHitRate,
    vendorHitRate,
    exactUrlAccuracyRate,
    averageInternalAlternatives,
    averageExternalCompetitors,
    averageRankWhenPresent,
    overallScore,
    scoreLabel: classifyScore(overallScore),
    scoreBreakdown,
  };
}

async function main() {
  const env = parseEnv(".env");
  const client = createClient({
    url: env.TURSO_DATABASE_URL || "file:./data/ia-product-audit.db",
    authToken: env.TURSO_AUTH_TOKEN || undefined,
  });

  const runsResult = await client.execute("SELECT run_id FROM runs ORDER BY created_at ASC");
  let updated = 0;
  let cleared = 0;

  for (const row of runsResult.rows) {
    const runId = String(row.run_id || "");
    if (!runId) {
      continue;
    }

    const resultsResult = await client.execute({
      sql: `
        SELECT product_hit, vendor_hit, exact_url_accuracy,
               internal_alternatives, external_competitors, rank
        FROM run_results
        WHERE run_id = ?
        ORDER BY prompt_order ASC
      `,
      args: [runId],
    });

    const parsedResults = resultsResult.rows.map((resultRow) => ({
      productHit: Number(resultRow.product_hit || 0),
      vendorHit: Number(resultRow.vendor_hit || 0),
      exactUrlAccuracy: Number(resultRow.exact_url_accuracy || 0),
      internalAlternatives: Number(resultRow.internal_alternatives || 0),
      externalCompetitors: Number(resultRow.external_competitors || 0),
      rank: Number(resultRow.rank || 0),
    }));

    const summary = parsedResults.length ? buildRunSummary(parsedResults) : null;
    await client.execute({
      sql: "UPDATE runs SET summary_json = ? WHERE run_id = ?",
      args: [summary ? JSON.stringify(summary) : null, runId],
    });

    if (summary) {
      updated += 1;
    } else {
      cleared += 1;
    }
  }

  console.log(JSON.stringify({ totalRuns: runsResult.rows.length, updated, cleared }, null, 2));
  await client.close();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
