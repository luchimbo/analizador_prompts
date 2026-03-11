function clamp01(value) {
  return Math.max(0, Math.min(1, value));
}

function round(value) {
  return Math.round(value * 100) / 100;
}

function normalizeRank(rank) {
  if (!Number.isFinite(rank) || rank <= 0) {
    return 0;
  }
  if (Math.round(rank) === 1) {
    return 1;
  }
  if (Math.round(rank) === 2) {
    return 0.5;
  }
  return 0;
}

function scoreRun({ productHitRate, vendorHitRate, exactUrlAccuracyRate, averageRankScore, averageInternalAlternatives, averageExternalCompetitors }) {
  const scoreBreakdown = {
    productHitPoints: round(productHitRate * 30),
    vendorPoints: round(vendorHitRate * 35),
    exactUrlPoints: round(exactUrlAccuracyRate * 25),
    rankPoints: round(averageRankScore * 10),
    internalBonusPoints: round(clamp01(averageInternalAlternatives / 2) * 15),
    externalPenaltyPoints: round(clamp01(averageExternalCompetitors / 2) * -15),
  };

  const overallScore = round(
    Math.max(
      0,
      Math.min(
        100,
        scoreBreakdown.productHitPoints +
          scoreBreakdown.vendorPoints +
          scoreBreakdown.exactUrlPoints +
          scoreBreakdown.rankPoints +
          scoreBreakdown.internalBonusPoints +
          scoreBreakdown.externalPenaltyPoints,
      ),
    ),
  );

  return { scoreBreakdown, overallScore };
}

const scenarios = [
  {
    name: "Perfect commercial outcome",
    input: {
      productHitRate: 1,
      vendorHitRate: 1,
      exactUrlAccuracyRate: 1,
      averageRankScore: normalizeRank(1),
      averageInternalAlternatives: 0,
      averageExternalCompetitors: 0,
    },
  },
  {
    name: "Rank 2 with one internal alternative",
    input: {
      productHitRate: 1,
      vendorHitRate: 0.5,
      exactUrlAccuracyRate: 0.5,
      averageRankScore: normalizeRank(2),
      averageInternalAlternatives: 1,
      averageExternalCompetitors: 0,
    },
  },
  {
    name: "External pressure penalty",
    input: {
      productHitRate: 0.6,
      vendorHitRate: 0.4,
      exactUrlAccuracyRate: 0.2,
      averageRankScore: normalizeRank(3),
      averageInternalAlternatives: 0,
      averageExternalCompetitors: 2,
    },
  },
];

for (const scenario of scenarios) {
  const result = scoreRun(scenario.input);
  console.log(`\n${scenario.name}`);
  console.log(JSON.stringify(result, null, 2));
}
