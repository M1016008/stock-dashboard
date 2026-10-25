import assert from "node:assert/strict";
import {
  getSixStageRealFeatureDiscovery,
  getSixStageRealPatternDetail,
  getSixStageRealResearchMeta,
  listSixStageRealPatternRankings,
} from "@/lib/server/six-stage-real-research-store";

process.env.SIX_STAGE_REAL_RESEARCH_ONLY = "1";

const meta = getSixStageRealResearchMeta();
assert.equal(meta.status, "REAL_DISCOVERY_DATA");
assert.equal(meta.productionAccess, 0);
assert.equal(meta.validationAccess, 0);
assert.equal(meta.holdoutAccess, 0);
assert.equal(meta.isolationEvidence.mode, "OWC_FIXED_INPUTS_READ_ONLY");
assert.equal(meta.isolationEvidence.researchRootVerified, true);
assert.equal(meta.isolationEvidence.fixedInputHashesVerified, true);
assert.equal(meta.isolationEvidence.runtimeAccessCountersAvailable, false);
assert.equal(
  meta.markets.reduce((sum, market) => sum + market.events, 0),
  11_179_679,
);
assert.equal(
  meta.markets.find((market) => market.market === "JP")?.events,
  3_301_583,
);
assert.equal(
  meta.markets.find((market) => market.market === "US")?.events,
  7_878_096,
);
assert.equal(meta.availableSmaFeatures.includes("sma25Angle"), true);
assert.equal(meta.availableSmaFeatures.includes("sma5Angle"), false);
assert.equal(meta.availablePhysicalFeatures.includes("momentum"), true);
assert.equal(meta.availablePhysicalFeatures.includes("physicalMa5Angle"), true);
assert.equal(meta.availablePhysicalFeatures.includes("pms"), false);

const ranking = listSixStageRealPatternRankings({
  market: "JP",
  length: 2,
  horizon: 20,
  direction: "LONG",
  sort: "samples",
  page: 1,
  pageSize: 20,
});
assert.equal(ranking.total, 161_519);
assert.equal(ranking.rows.length, 20);
assert.equal(
  ranking.rows[0].populationEvents >= ranking.rows[1].populationEvents,
  true,
);

const composite = listSixStageRealPatternRankings({
  market: "JP",
  length: 2,
  horizon: 20,
  direction: "LONG",
  sort: "composite",
  page: 1,
  pageSize: 20,
  weights: {
    first5: 4,
    hit10: 2,
    median: 3,
    mfe: 2,
    mae: 2,
    samples: 1,
    concentration: 1,
    outlier: 1,
    quality: 1,
  },
});
assert.equal(composite.total, ranking.total);
assert.equal(composite.rows.length, ranking.rows.length);
assert.equal(
  composite.rows.every(
    (row) =>
      row.compositeScore != null &&
      row.compositeWeightCoverage != null &&
      row.compositeWeightCoverage > 0 &&
      row.compositeWeightCoverage <= 1,
  ),
  true,
);
assert.equal(
  composite.rows.every(
    (row, index) =>
      index === 0 ||
      Number(composite.rows[index - 1].compositeScore) >=
        Number(row.compositeScore),
  ),
  true,
);
assert.equal(
  ranking.rows.every(
    (row) =>
      row.populationEvents ===
      row.observedEvents +
        row.missingEntry +
        row.invalidPrice +
        row.rightCensored,
  ),
  true,
);

const sequenceKey = ranking.rows[0].sequenceKey;
const fixedThresholdDetail = getSixStageRealPatternDetail({
  market: "JP",
  length: 2,
  sequenceKey,
  horizon: 20,
  direction: "LONG",
  favorablePct: 5,
  adversePct: 5,
  feature: "sma25Angle",
});
assert.equal(fixedThresholdDetail.observations, ranking.rows[0].observedEvents);
assert.equal(
  fixedThresholdDetail.passage.favorableRate,
  ranking.rows[0].first5Rate,
);
for (const sort of ["mfe", "mae"] as const) {
  const shortRanking = listSixStageRealPatternRankings({
    market: "JP",
    length: 2,
    horizon: 20,
    direction: "SHORT",
    sort,
    page: 1,
    pageSize: 20,
  });
  const field = sort === "mfe" ? "mfeMedian" : "maeMedian";
  assert.ok(
    shortRanking.rows[0][field] != null && shortRanking.rows[1][field] != null,
  );
  assert.ok(
    Number(shortRanking.rows[0][field]) >= Number(shortRanking.rows[1][field]),
  );
}
const detail = getSixStageRealPatternDetail({
  market: "JP",
  length: 2,
  sequenceKey,
  horizon: 20,
  direction: "LONG",
  favorablePct: 7.5,
  adversePct: 4.5,
  feature: "sma25Angle",
});
assert.equal(detail.sequenceKey, sequenceKey);
assert.equal(detail.observations, ranking.rows[0].observedEvents);
assert.equal(
  detail.observations,
  detail.passage.favorable +
    detail.passage.adverse +
    detail.passage.sameSessionUnknown +
    detail.passage.neither,
);
assert.equal(
  detail.histogram.reduce((sum, bin) => sum + bin.count, 0),
  detail.observations,
);
assert.equal(detail.featureBreakdown != null, true);
assert.equal(
  detail.featureBreakdown!.available + detail.featureBreakdown!.missing,
  detail.observations,
);

const short = getSixStageRealPatternDetail({
  market: "JP",
  length: 2,
  sequenceKey,
  horizon: 20,
  direction: "SHORT",
  favorablePct: 5,
  adversePct: 5,
});
assert.equal(short.observations, fixedThresholdDetail.observations);
assert.ok(
  fixedThresholdDetail.distribution.median != null &&
    short.distribution.median != null,
);
assert.ok(
  Math.abs(
    fixedThresholdDetail.distribution.median + short.distribution.median,
  ) < 1e-12,
);
assert.equal(short.passage.favorable, fixedThresholdDetail.passage.adverse);
assert.equal(short.passage.adverse, fixedThresholdDetail.passage.favorable);
assert.equal(
  short.passage.sameSessionUnknown,
  fixedThresholdDetail.passage.sameSessionUnknown,
);
assert.equal(short.passage.neither, fixedThresholdDetail.passage.neither);
assert.equal(short.outliers.length, fixedThresholdDetail.outliers.length);
for (let index = 0; index < fixedThresholdDetail.outliers.length; index += 1) {
  const longRow = fixedThresholdDetail.outliers[index];
  const shortRow = short.outliers[index];
  assert.equal(shortRow.ticker, longRow.ticker);
  assert.equal(shortRow.signalDate, longRow.signalDate);
  assert.equal(shortRow.value, -longRow.value);
  assert.equal(shortRow.mfe, -longRow.mae);
  assert.equal(shortRow.mae, -longRow.mfe);
  assert.equal(
    shortRow.first,
    longRow.first === "FAVORABLE"
      ? "ADVERSE"
      : longRow.first === "ADVERSE"
        ? "FAVORABLE"
        : longRow.first,
  );
  assert.equal(shortRow.favorableDay, longRow.adverseDay);
  assert.equal(shortRow.adverseDay, longRow.favorableDay);
}

const shortMedianRanking = listSixStageRealPatternRankings({
  market: "JP",
  length: 2,
  horizon: 20,
  direction: "SHORT",
  sort: "median",
  page: 1,
  pageSize: 20,
});
assert.ok(
  shortMedianRanking.rows[0].median != null &&
    shortMedianRanking.rows[1].median != null,
);
assert.ok(
  Number(shortMedianRanking.rows[0].median) >=
    Number(shortMedianRanking.rows[1].median),
);

const physical = getSixStageRealPatternDetail({
  market: "JP",
  length: 2,
  sequenceKey,
  horizon: 20,
  direction: "LONG",
  favorablePct: 7.5,
  adversePct: 4.5,
  feature: "momentum",
});
assert.equal(physical.featureBreakdown != null, true);
assert.equal(
  physical.featureBreakdown!.available + physical.featureBreakdown!.missing,
  physical.observations,
);

assert.equal(
  physical.qualityComparison.primary.observations,
  physical.observations,
);

const discovery = getSixStageRealFeatureDiscovery({
  market: "JP",
  length: 2,
  sequenceKey,
  horizon: 20,
  direction: "LONG",
  favorablePct: 5,
  adversePct: 5,
  featureA: "sma25Angle",
  featureB: "momentum",
  bins: 5,
});
assert.equal(discovery.observations, physical.observations);
assert.equal(
  discovery.completeFeaturePairs + discovery.missingFeaturePairs,
  discovery.observations,
);
assert.equal(
  discovery.cells.reduce((sum, cell) => sum + cell.observations, 0),
  discovery.completeFeaturePairs,
);
assert.equal(discovery.pitEvidence.futureOutcomeColumnsUsedAsFeatures, 0);

const usQuality = getSixStageRealPatternDetail({
  market: "US",
  length: 2,
  sequenceKey: "444444>544444",
  horizon: 20,
  direction: "LONG",
  favorablePct: 5,
  adversePct: 5,
  feature: "momentum",
});
assert.equal(usQuality.qualityComparison.flaggedEvents, 17);
assert.deepEqual(usQuality.qualityComparison.flaggedTickers, [
  "ABVC",
  "IVT",
  "ZXZZT",
]);
assert.equal(
  usQuality.qualityComparison.reference!.observations +
    usQuality.qualityComparison.flaggedEvents,
  usQuality.observations,
);

console.log(
  JSON.stringify(
    {
      status: "PASS",
      events: meta.markets.reduce((sum, market) => sum + market.events, 0),
      jpPatternsLength2: ranking.total,
      checkedSequence: sequenceKey,
      checkedEvents: detail.observations,
      sma25Available: detail.featureBreakdown?.available,
      sma25Missing: detail.featureBreakdown?.missing,
      physicalMomentumAvailable: physical.featureBreakdown?.available,
      physicalMomentumMissing: physical.featureBreakdown?.missing,
      jointCells: discovery.cells.length,
      compositeTotal: composite.total,
      usQualityFlaggedEvents: usQuality.qualityComparison.flaggedEvents,
    },
    null,
    2,
  ),
);
