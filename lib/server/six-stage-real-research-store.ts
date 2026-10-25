import fs from "node:fs";
import path from "node:path";
import {
  SIX_STAGE_DISTRIBUTION_SHA256,
  SIX_STAGE_REAL_ANALYSIS_DIRECTORY,
  SIX_STAGE_REAL_ANALYSIS_NAMESPACE,
  SIX_STAGE_REAL_INPUTS,
  SIX_STAGE_SOURCE_ADOPTION_SHA256,
  assertResearchOnlyExecution,
  assertSixStageRealInput,
  type SixStageRealMarket,
} from "@/lib/research/six-stage-real-data-contract";
import { decodeDailyExcursions } from "@/lib/research/six-stage-event-path-store";
import type { EventPathHorizon } from "@/lib/research/six-stage-event-path-research";

type Statement = {
  all(...bindings: unknown[]): Record<string, unknown>[];
  iterate(...bindings: unknown[]): Iterable<Record<string, unknown>>;
  get(...bindings: unknown[]): Record<string, unknown> | undefined;
};
type Database = {
  exec(sql: string): void;
  prepare(sql: string): Statement;
  close(): void;
};
const { DatabaseSync } = require("node:sqlite") as {
  DatabaseSync: new (
    databasePath: string,
    options?: { readOnly?: boolean },
  ) => Database;
};

export type SixStageResearchDirection = "LONG" | "SHORT";
export type SixStageRankingSort =
  | "first5"
  | "hit10"
  | "median"
  | "mfe"
  | "mae"
  | "samples"
  | "outlier"
  | "composite";

export type SixStageRankingWeights = {
  first5: number;
  hit10: number;
  median: number;
  mfe: number;
  mae: number;
  samples: number;
  concentration: number;
  outlier: number;
  quality: number;
};

const HORIZONS = new Set([5, 10, 15, 20]);
const FEATURE_COLUMNS = {
  sma25Angle: "f_sma25_angle",
  sma75Angle: "f_sma75_angle",
  sma150Angle: "f_sma150_angle",
  sma200Angle: "f_sma200_angle",
  sma300Angle: "f_sma300_angle",
  sma25Curvature: "f_sma25_acceleration",
  sma75Curvature: "f_sma75_acceleration",
  sma150Curvature: "f_sma150_acceleration",
  sma200Curvature: "f_sma200_acceleration",
  sma300Curvature: "f_sma300_acceleration",
  sma25CloseGap: "f_sma25_close_gap",
  sma75CloseGap: "f_sma75_close_gap",
  sma150CloseGap: "f_sma150_close_gap",
  sma200CloseGap: "f_sma200_close_gap",
  sma300CloseGap: "f_sma300_close_gap",
  sma25To75Distance: "f_sma25_75_distance",
  sma75To150Distance: "f_sma75_150_distance",
  sma150To200Distance: "f_sma150_200_distance",
  sma200To300Distance: "f_sma200_300_distance",
  sma25To75Convergence: "f_sma25_75_convergence",
  sma75To150Convergence: "f_sma75_150_convergence",
  sma150To200Convergence: "f_sma150_200_convergence",
  sma200To300Convergence: "f_sma200_300_convergence",
} as const;

const PHYSICAL_FEATURE_COLUMNS = {
  velocity: "velocity",
  acceleration: "acceleration",
  momentum: "momentum",
  force: "force",
  energy: "energy",
  physicalMa5Angle: "ma5_angle",
  physicalMa25Angle: "ma25_angle",
  physicalMa75Angle: "ma75_angle",
  physicalMa200Angle: "ma200_angle",
  physicalMaAngleAverage: "ma_angle_avg",
} as const;

const AUDITED_EXTREME_TICKERS = new Set(["ZXZZT", "ABVC", "IVT"]);
const QUALITY_TICKER_COUNT_CACHE = new Map<string, Map<string, number>>();

export type SixStageAvailableFeature =
  | keyof typeof FEATURE_COLUMNS
  | keyof typeof PHYSICAL_FEATURE_COLUMNS;

type DetailObservation = {
  ticker: string;
  signalDate: string;
  entryDate: string | null;
  value: number;
  mfe: number;
  mae: number;
  first: "FAVORABLE" | "ADVERSE" | "SAME_SESSION_UNKNOWN" | "NEITHER";
  favorableDay: number | null;
  adverseDay: number | null;
  feature: number | null;
  featureB?: number | null;
  qualityFlags: string[];
};

function analysisPath(market: SixStageRealMarket): string {
  return path.join(
    SIX_STAGE_REAL_ANALYSIS_DIRECTORY,
    `${market.toLowerCase()}-pattern-analysis.sqlite`,
  );
}

function physicalFeaturePath(market: SixStageRealMarket): string {
  return path.join(
    SIX_STAGE_REAL_ANALYSIS_DIRECTORY,
    "event-physical-features-v1",
    `${market.toLowerCase()}-event-physical-features.sqlite`,
  );
}

function physicalFeaturesAvailable(market: SixStageRealMarket): boolean {
  const filePath = physicalFeaturePath(market);
  if (!fs.existsSync(filePath)) return false;
  const database = openReadOnly(filePath);
  try {
    const status = database
      .prepare("SELECT value FROM metadata WHERE key='status'")
      .get()?.value;
    const source = database
      .prepare("SELECT value FROM metadata WHERE key='event_store_sha256'")
      .get()?.value;
    return (
      status === "COMPLETE" &&
      source === SIX_STAGE_REAL_INPUTS[market].expectedEventStoreSha256
    );
  } catch {
    return false;
  } finally {
    database.close();
  }
}

function qualityFlags(market: SixStageRealMarket, ticker: string): string[] {
  return market === "US" && AUDITED_EXTREME_TICKERS.has(ticker)
    ? ["AUDITED_NEAR_ZERO_OR_DISCONTINUITY"]
    : [];
}

function qualityTickerCounts(
  market: SixStageRealMarket,
  length: 2 | 3,
): Map<string, number> {
  if (market !== "US") return new Map();
  const cacheKey = `${market}:${length}`;
  const cached = QUALITY_TICKER_COUNT_CACHE.get(cacheKey);
  if (cached) return cached;
  const input = SIX_STAGE_REAL_INPUTS[market];
  const database = openReadOnly(input.eventStorePath);
  try {
    const tickers = [...AUDITED_EXTREME_TICKERS];
    const placeholders = tickers.map(() => "?").join(",");
    const rows = database
      .prepare(
        `SELECT e.sequence_key,COUNT(*) AS count
         FROM event_paths e
         JOIN ticker_dictionary t ON t.ticker_id=e.ticker_id
         WHERE e.length=? AND t.ticker IN (${placeholders})
         GROUP BY e.sequence_key`,
      )
      .all(length, ...tickers);
    const result = new Map(
      rows.map((row) => [String(row.sequence_key), Number(row.count)]),
    );
    QUALITY_TICKER_COUNT_CACHE.set(cacheKey, result);
    return result;
  } finally {
    database.close();
  }
}

function immutableUri(filePath: string): string {
  return `file:${filePath.replaceAll("?", "%3F")}?immutable=1`;
}

function openReadOnly(filePath: string): Database {
  if (!fs.existsSync(filePath))
    throw new Error("real_research_store_unavailable");
  const db = new DatabaseSync(filePath, { readOnly: true });
  db.exec("PRAGMA query_only=ON; PRAGMA trusted_schema=OFF;");
  return db;
}

function assertRuntimeInputs(market: SixStageRealMarket): void {
  assertResearchOnlyExecution();
  assertSixStageRealInput(market);
  const index = openReadOnly(analysisPath(market));
  try {
    const metadata = Object.fromEntries(
      index
        .prepare("SELECT key,value FROM metadata")
        .all()
        .map((row) => [String(row.key), String(row.value)]),
    );
    if (
      metadata.namespace !== SIX_STAGE_REAL_ANALYSIS_NAMESPACE ||
      metadata.status !== "COMPLETE" ||
      metadata.event_store_sha256 !==
        SIX_STAGE_REAL_INPUTS[market].expectedEventStoreSha256 ||
      metadata.source_adoption_sha256 !== SIX_STAGE_SOURCE_ADOPTION_SHA256
    ) {
      throw new Error("real_research_index_mismatch");
    }
  } finally {
    index.close();
  }
}

function parseHorizon(value: number): EventPathHorizon {
  if (!HORIZONS.has(value)) throw new Error("invalid_horizon");
  return value as EventPathHorizon;
}

function assertSequence(sequenceKey: string, length: 2 | 3): string {
  const parts = sequenceKey.split(">");
  if (parts.length !== length || parts.some((part) => !/^\d{6}$/.test(part)))
    throw new Error("invalid_sequence");
  return sequenceKey;
}

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function nullableNumber(value: unknown): number | null {
  return finite(value) ? value : null;
}

function validatedWeights(
  weights: Partial<SixStageRankingWeights> | null | undefined,
): SixStageRankingWeights {
  const defaults: SixStageRankingWeights = {
    first5: 3,
    hit10: 1,
    median: 2,
    mfe: 1,
    mae: 1,
    samples: 1,
    concentration: 1,
    outlier: 1,
    quality: 1,
  };
  const result = { ...defaults, ...(weights ?? {}) };
  for (const [key, value] of Object.entries(result)) {
    if (!finite(value) || value < 0 || value > 100) {
      throw new Error(`invalid_weight_${key}`);
    }
  }
  if (Object.values(result).every((value) => value === 0)) {
    throw new Error("invalid_weights");
  }
  return result;
}

type ResolvedFeature = {
  key: SixStageAvailableFeature;
  select: string;
  needsPhysical: boolean;
};

function resolveFeature(
  market: SixStageRealMarket,
  feature: SixStageAvailableFeature,
  alias: string,
): ResolvedFeature {
  if (feature in FEATURE_COLUMNS) {
    return {
      key: feature,
      select: `f.${FEATURE_COLUMNS[feature as keyof typeof FEATURE_COLUMNS]} AS ${alias}`,
      needsPhysical: false,
    };
  }
  if (feature in PHYSICAL_FEATURE_COLUMNS) {
    if (!physicalFeaturesAvailable(market)) {
      throw new Error("physical_feature_store_unavailable");
    }
    return {
      key: feature,
      select: `p.${PHYSICAL_FEATURE_COLUMNS[feature as keyof typeof PHYSICAL_FEATURE_COLUMNS]} AS ${alias}`,
      needsPhysical: true,
    };
  }
  throw new Error("invalid_feature");
}

function quantile(
  sorted: readonly number[],
  probability: number,
): number | null {
  if (!sorted.length) return null;
  const position = (sorted.length - 1) * probability;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  return lower === upper
    ? sorted[lower]
    : sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

function summarize(values: readonly number[]) {
  const sorted = [...values].sort((left, right) => left - right);
  const absolute = values.map(Math.abs).sort((left, right) => right - left);
  const absoluteTotal = absolute.reduce((sum, value) => sum + value, 0);
  const contribution = (ratio: number) => {
    if (!absolute.length) return null;
    if (absoluteTotal === 0) return 0;
    const count = Math.max(1, Math.ceil(absolute.length * ratio));
    return (
      absolute.slice(0, count).reduce((sum, value) => sum + value, 0) /
      absoluteTotal
    );
  };
  const trim = Math.floor(sorted.length * 0.01);
  const trimmed =
    trim * 2 < sorted.length
      ? sorted.slice(trim, sorted.length - trim)
      : sorted;
  return {
    count: sorted.length,
    mean: sorted.length
      ? sorted.reduce((sum, value) => sum + value, 0) / sorted.length
      : null,
    median: quantile(sorted, 0.5),
    q01: quantile(sorted, 0.01),
    q05: quantile(sorted, 0.05),
    q25: quantile(sorted, 0.25),
    q75: quantile(sorted, 0.75),
    q95: quantile(sorted, 0.95),
    q99: quantile(sorted, 0.99),
    minimum: sorted[0] ?? null,
    maximum: sorted.at(-1) ?? null,
    trimmedMean: trimmed.length
      ? trimmed.reduce((sum, value) => sum + value, 0) / trimmed.length
      : null,
    topAbs1Contribution: contribution(0.01),
    topAbs5Contribution: contribution(0.05),
  };
}

function histogram(
  values: readonly number[],
  bins = 40,
): Array<{ from: number; to: number; count: number }> {
  if (!values.length) return [];
  const sorted = [...values].sort((left, right) => left - right);
  const lower = quantile(sorted, 0.01) ?? sorted[0];
  const upper = quantile(sorted, 0.99) ?? sorted.at(-1)!;
  const width = upper > lower ? (upper - lower) / bins : 1;
  const counts = Array.from({ length: bins }, () => 0);
  for (const value of values) {
    const index = Math.max(
      0,
      Math.min(
        bins - 1,
        Math.floor((Math.max(lower, Math.min(upper, value)) - lower) / width),
      ),
    );
    counts[index] += 1;
  }
  return counts.map((count, index) => ({
    from: lower + width * index,
    to: lower + width * (index + 1),
    count,
  }));
}

function cdf(
  values: readonly number[],
  points = 101,
): Array<{ value: number; cumulative: number }> {
  if (!values.length) return [];
  const sorted = [...values].sort((left, right) => left - right);
  const count = Math.min(points, sorted.length);
  return Array.from({ length: count }, (_, index) => {
    const probability = count === 1 ? 1 : index / (count - 1);
    return { value: quantile(sorted, probability)!, cumulative: probability };
  });
}

function rate(count: number, denominator: number): number | null {
  return denominator ? count / denominator : null;
}

function directionalRankingRow(
  row: Record<string, unknown>,
  direction: SixStageResearchDirection,
  flaggedEvents = Number(row.quality_flagged_events ?? 0),
) {
  const long = direction === "LONG";
  const median = nullableNumber(row.median_return);
  const q25 = nullableNumber(row.q25_return);
  const q75 = nullableNumber(row.q75_return);
  const mfe = nullableNumber(row.mfe_median);
  const mae = nullableNumber(row.mae_median);
  return {
    length: Number(row.length),
    sequenceKey: String(row.sequence_key),
    horizon: Number(row.horizon),
    populationEvents: Number(row.population_events),
    observedEvents: Number(row.observed_events),
    missingEntry: Number(row.missing_entry),
    invalidPrice: Number(row.invalid_price),
    rightCensored: Number(row.right_censored),
    tickerCount: Number(row.ticker_count),
    yearCount: Number(row.year_count),
    topTickerShare: nullableNumber(row.top_ticker_share),
    topYearShare: nullableNumber(row.top_year_share),
    mean: long
      ? nullableNumber(row.mean_return)
      : nullableNumber(row.mean_return) == null
        ? null
        : -Number(row.mean_return),
    median: median == null ? null : long ? median : -median,
    q25: long ? q25 : q75 == null ? null : -q75,
    q75: long ? q75 : q25 == null ? null : -q25,
    mfeMedian: long ? mfe : mae == null ? null : -mae,
    maeMedian: long ? mae : mfe == null ? null : -mfe,
    first5Rate: nullableNumber(
      row[long ? "up_first_5_rate" : "down_first_5_rate"],
    ),
    hit10Rate: nullableNumber(
      row[long ? "up_hit_10_rate" : "down_hit_10_rate"],
    ),
    sameSession5: Number(row.same_session_5),
    topAbs1Contribution: nullableNumber(row.top_abs_1_contribution),
    qualityFlaggedEvents: flaggedEvents,
    qualityFlaggedShare: rate(flaggedEvents, Number(row.population_events)),
    qualityFlags:
      flaggedEvents > 0 ? ["AUDITED_NEAR_ZERO_OR_DISCONTINUITY"] : [],
    compositeScore: nullableNumber(row.composite_score),
    compositeWeightCoverage: nullableNumber(row.composite_weight_coverage),
  };
}

export function getSixStageRealResearchMeta() {
  assertResearchOnlyExecution();
  const markets = (["JP", "US"] as const).map((market) => {
    assertRuntimeInputs(market);
    const db = openReadOnly(analysisPath(market));
    try {
      const counts =
        db
          .prepare(
            `SELECT
        COUNT(*) AS summary_rows,
        COUNT(DISTINCT length || char(31) || sequence_key) AS patterns,
        SUM(CASE WHEN horizon=20 THEN population_events ELSE 0 END) AS events
        FROM pattern_summary`,
          )
          .get() ?? {};
      const manifest = assertSixStageRealInput(market);
      return {
        market,
        events: Number(counts.events),
        patterns: Number(counts.patterns),
        summaryRows: Number(counts.summary_rows),
        eventStoreSha256: manifest.file.sha256,
        priceBasis: manifest.source.priceBasis,
        featureKeyCoverage: manifest.rows.events,
      };
    } finally {
      db.close();
    }
  });
  return {
    schemaVersion: 1,
    status: "REAL_DISCOVERY_DATA",
    discoveryStart: "2010-01-01",
    discoveryCutoff: "2022-12-30",
    sourceAdoptionSha256: SIX_STAGE_SOURCE_ADOPTION_SHA256,
    distributionArtifactSha256: SIX_STAGE_DISTRIBUTION_SHA256,
    productionAccess: 0,
    validationAccess: 0,
    holdoutAccess: 0,
    isolationEvidence: {
      mode: "OWC_FIXED_INPUTS_READ_ONLY",
      researchRootVerified: true,
      fixedInputHashesVerified: true,
      apiEnvironmentGate: "SIX_STAGE_REAL_RESEARCH_ONLY=1",
      runtimeAccessCountersAvailable: false,
    },
    availableSmaFeatures: Object.keys(FEATURE_COLUMNS),
    availablePhysicalFeatures: (["JP", "US"] as const).every(
      physicalFeaturesAvailable,
    )
      ? Object.keys(PHYSICAL_FEATURE_COLUMNS)
      : [],
    unavailableFeatures: {
      sma5: "F1 frozen store does not contain SMA5 fields",
      physicalMomentum: (["JP", "US"] as const).every(physicalFeaturesAvailable)
        ? "Raw prefix-only Momentum/Force/Energy are available; official PMS/PFS/PES require the full market-date cross-section and remain unavailable"
        : "Historical prefix-only physical feature store has not completed for both markets",
    },
    qualityPolicy: {
      flags: ["AUDITED_NEAR_ZERO_OR_DISCONTINUITY"],
      auditedTickers: [...AUDITED_EXTREME_TICKERS],
      primaryPopulation: "ALL_EVENTS_UNCHANGED",
      referencePopulation: "AUDITED_FLAGGED_TICKERS_EXCLUDED_FOR_COMPARISON_ONLY",
    },
    markets,
  };
}

export function listSixStageRealPatternRankings(args: {
  market: SixStageRealMarket;
  length: 2 | 3;
  horizon: number;
  direction: SixStageResearchDirection;
  sort: SixStageRankingSort;
  page: number;
  pageSize: number;
  search?: string | null;
  weights?: Partial<SixStageRankingWeights> | null;
}) {
  assertRuntimeInputs(args.market);
  const horizon = parseHorizon(args.horizon);
  if (args.length !== 2 && args.length !== 3) throw new Error("invalid_length");
  if (args.direction !== "LONG" && args.direction !== "SHORT")
    throw new Error("invalid_direction");
  if (
    !Number.isInteger(args.page) ||
    args.page < 1 ||
    !Number.isInteger(args.pageSize) ||
    args.pageSize < 1 ||
    args.pageSize > 200
  ) {
    throw new Error("invalid_pagination");
  }
  const long = args.direction === "LONG";
  const orderBy: Record<SixStageRankingSort, string> = {
    first5: long
      ? "up_first_5_rate IS NULL ASC, up_first_5_rate DESC"
      : "down_first_5_rate IS NULL ASC, down_first_5_rate DESC",
    hit10: long
      ? "up_hit_10_rate IS NULL ASC, up_hit_10_rate DESC"
      : "down_hit_10_rate IS NULL ASC, down_hit_10_rate DESC",
    median: long
      ? "median_return IS NULL ASC, median_return DESC"
      : "median_return IS NULL ASC, median_return ASC",
    mfe: long
      ? "mfe_median IS NULL ASC, mfe_median DESC"
      : "mae_median IS NULL ASC, mae_median ASC",
    mae: long
      ? "mae_median IS NULL ASC, mae_median DESC"
      : "mfe_median IS NULL ASC, mfe_median ASC",
    samples: "observed_events DESC",
    outlier: "top_abs_1_contribution IS NULL ASC, top_abs_1_contribution ASC",
    composite: "composite_score DESC",
  };
  if (!orderBy[args.sort]) throw new Error("invalid_sort");
  const search = args.search?.trim() ?? "";
  if (search && !/^[0-9>]{1,32}$/.test(search))
    throw new Error("invalid_search");
  const where = search ? "AND sequence_key LIKE ?" : "";
  const rankedWhere = search ? "AND p.sequence_key LIKE ?" : "";
  const bindings: unknown[] = [args.length, horizon];
  if (search) bindings.push(`%${search}%`);
  const qualityCounts = qualityTickerCounts(args.market, args.length);
  const qualityValues = [...qualityCounts];
  const qualityCte = qualityValues.length
    ? `quality(sequence_key,quality_flagged_events) AS (VALUES ${qualityValues
        .map(() => "(?,?)")
        .join(",")}),`
    : "quality(sequence_key,quality_flagged_events) AS (SELECT NULL,0 WHERE 0),";
  const qualityBindings = qualityValues.flatMap(([sequenceKey, count]) => [
    sequenceKey,
    count,
  ]);
  const weights = validatedWeights(args.weights);
  const scoreWeight = Object.values(weights).reduce(
    (sum, value) => sum + value,
    0,
  );
  const first5Column = long ? "p.up_first_5_rate" : "p.down_first_5_rate";
  const hit10Column = long ? "p.up_hit_10_rate" : "p.down_hit_10_rate";
  const medianExpression = long ? "p.median_return" : "-p.median_return";
  const mfeExpression = long ? "p.mfe_median" : "-p.mae_median";
  const maeExpression = long ? "ABS(p.mae_median)" : "ABS(p.mfe_median)";
  const compositeNumerator = `(
    ${weights.first5} * CASE WHEN ${first5Column} IS NOT NULL THEN ${first5Column} ELSE 0 END +
    ${weights.hit10} * CASE WHEN ${hit10Column} IS NOT NULL THEN ${hit10Column} ELSE 0 END +
    ${weights.median} * CASE WHEN ${medianExpression} IS NOT NULL THEN MAX(0,MIN(1,(${medianExpression}+0.2)/0.4)) ELSE 0 END +
    ${weights.mfe} * CASE WHEN ${mfeExpression} IS NOT NULL THEN MAX(0,MIN(1,${mfeExpression}/0.3)) ELSE 0 END +
    ${weights.mae} * CASE WHEN ${maeExpression} IS NOT NULL THEN (1-MAX(0,MIN(1,${maeExpression}/0.3))) ELSE 0 END +
    ${weights.samples} * CASE WHEN maxima.maximum_observed>0 THEN p.observed_events*1.0/maxima.maximum_observed ELSE 0 END +
    ${weights.concentration} * CASE
      WHEN p.top_ticker_share IS NOT NULL AND p.top_year_share IS NOT NULL THEN (1-MAX(p.top_ticker_share,p.top_year_share))
      WHEN p.top_ticker_share IS NOT NULL THEN (1-p.top_ticker_share)
      WHEN p.top_year_share IS NOT NULL THEN (1-p.top_year_share)
      ELSE 0
    END +
    ${weights.outlier} * CASE WHEN p.top_abs_1_contribution IS NOT NULL THEN (1-p.top_abs_1_contribution) ELSE 0 END +
    ${weights.quality} * (1-CASE WHEN p.population_events>0 THEN COALESCE(q.quality_flagged_events,0)*1.0/p.population_events ELSE 1 END)
  )`;
  const compositeDenominator = `(
    ${weights.first5} * CASE WHEN ${first5Column} IS NOT NULL THEN 1 ELSE 0 END +
    ${weights.hit10} * CASE WHEN ${hit10Column} IS NOT NULL THEN 1 ELSE 0 END +
    ${weights.median} * CASE WHEN ${medianExpression} IS NOT NULL THEN 1 ELSE 0 END +
    ${weights.mfe} * CASE WHEN ${mfeExpression} IS NOT NULL THEN 1 ELSE 0 END +
    ${weights.mae} * CASE WHEN ${maeExpression} IS NOT NULL THEN 1 ELSE 0 END +
    ${weights.samples} +
    ${weights.concentration} * CASE WHEN p.top_ticker_share IS NOT NULL OR p.top_year_share IS NOT NULL THEN 1 ELSE 0 END +
    ${weights.outlier} * CASE WHEN p.top_abs_1_contribution IS NOT NULL THEN 1 ELSE 0 END +
    ${weights.quality}
  )`;
  const compositeExpression = `CASE WHEN ${compositeDenominator}>0 THEN ${compositeNumerator}/${compositeDenominator} ELSE NULL END`;
  const db = openReadOnly(analysisPath(args.market));
  try {
    const total = Number(
      db
        .prepare(
          `SELECT COUNT(*) AS count FROM pattern_summary WHERE length=? AND horizon=? ${where}`,
        )
        .get(...bindings)?.count ?? 0,
    );
    const rows = db
      .prepare(
        `WITH ${qualityCte}
        maxima AS (
          SELECT MAX(observed_events) AS maximum_observed
          FROM pattern_summary WHERE length=? AND horizon=?
        )
        SELECT p.*,COALESCE(q.quality_flagged_events,0) AS quality_flagged_events,
          ${compositeExpression} AS composite_score,
          ${compositeDenominator}*1.0/${scoreWeight} AS composite_weight_coverage
        FROM pattern_summary p
        LEFT JOIN quality q ON q.sequence_key=p.sequence_key
        CROSS JOIN maxima
        WHERE p.length=? AND p.horizon=? ${rankedWhere}
      ORDER BY ${orderBy[args.sort]}, observed_events DESC, p.sequence_key ASC LIMIT ? OFFSET ?`,
      )
      .all(
        ...qualityBindings,
        args.length,
        horizon,
        ...bindings,
        args.pageSize,
        (args.page - 1) * args.pageSize,
      )
      .map((row) => directionalRankingRow(row, args.direction));
    return {
      market: args.market,
      direction: args.direction,
      horizon,
      length: args.length,
      total,
      page: args.page,
      pageSize: args.pageSize,
      weights,
      rows,
    };
  } finally {
    db.close();
  }
}

function firstPassage(
  excursion: Uint8Array,
  horizon: number,
  direction: SixStageResearchDirection,
  favorablePct: number,
  adversePct: number,
) {
  const points = decodeDailyExcursions(excursion).slice(0, horizon);
  const favorableDay =
    points.find((point) =>
      direction === "LONG"
        ? point.upReturn >= favorablePct / 100
        : point.downReturn <= -favorablePct / 100,
    )?.day ?? null;
  const adverseDay =
    points.find((point) =>
      direction === "LONG"
        ? point.downReturn <= -adversePct / 100
        : point.upReturn >= adversePct / 100,
    )?.day ?? null;
  const first: DetailObservation["first"] =
    favorableDay != null && adverseDay != null && favorableDay === adverseDay
      ? "SAME_SESSION_UNKNOWN"
      : favorableDay != null &&
          (adverseDay == null || favorableDay < adverseDay)
        ? "FAVORABLE"
        : adverseDay != null &&
            (favorableDay == null || adverseDay < favorableDay)
          ? "ADVERSE"
          : "NEITHER";
  return { first, favorableDay, adverseDay };
}

function featureBreakdown(observations: readonly DetailObservation[]) {
  const withFeature = observations.filter(
    (row): row is DetailObservation & { feature: number } =>
      finite(row.feature),
  );
  if (!withFeature.length)
    return { available: 0, missing: observations.length, bins: [] };
  const sortedFeatures = withFeature
    .map((row) => row.feature)
    .sort((left, right) => left - right);
  const boundaries = Array.from({ length: 6 }, (_, index) =>
    quantile(sortedFeatures, index / 5)!,
  ).filter((value, index, values) => index === 0 || value > values[index - 1]);
  if (boundaries.length === 1) boundaries.push(boundaries[0]);
  const bins = boundaries.slice(0, -1).map((minimum, index) => {
    const maximum = boundaries[index + 1];
    const includeMaximum = index === boundaries.length - 2;
    const rows = withFeature.filter(
      (row) =>
        row.feature >= minimum &&
        (includeMaximum ? row.feature <= maximum : row.feature < maximum),
    );
    const favorable = rows.filter((row) => row.first === "FAVORABLE").length;
    return {
      index,
      minimum,
      maximum,
      observations: rows.length,
      favorable,
      favorableRate: rate(favorable, rows.length),
      distribution: summarize(rows.map((row) => row.value)),
      mfe: summarize(rows.map((row) => row.mfe)),
      mae: summarize(rows.map((row) => row.mae)),
    };
  });
  return {
    available: withFeature.length,
    missing: observations.length - withFeature.length,
    bins,
  };
}

function observationSummary(observations: readonly DetailObservation[]) {
  const favorable = observations.filter(
    (row) => row.first === "FAVORABLE",
  ).length;
  const adverse = observations.filter((row) => row.first === "ADVERSE").length;
  const sameSessionUnknown = observations.filter(
    (row) => row.first === "SAME_SESSION_UNKNOWN",
  ).length;
  const neither = observations.filter((row) => row.first === "NEITHER").length;
  return {
    observations: observations.length,
    favorable,
    adverse,
    sameSessionUnknown,
    neither,
    favorableRate: rate(favorable, observations.length),
    adverseRate: rate(adverse, observations.length),
    distribution: summarize(observations.map((row) => row.value)),
    mfe: summarize(observations.map((row) => row.mfe)),
    mae: summarize(observations.map((row) => row.mae)),
  };
}

function qualityComparison(observations: readonly DetailObservation[]) {
  const flagged = observations.filter((row) => row.qualityFlags.length > 0);
  const reference = observations.filter((row) => row.qualityFlags.length === 0);
  return {
    primary: observationSummary(observations),
    flaggedEvents: flagged.length,
    flaggedShare: rate(flagged.length, observations.length),
    flaggedTickers: [...new Set(flagged.map((row) => row.ticker))].sort(),
    reference:
      flagged.length > 0 ? observationSummary(reference) : null,
    policy:
      "Primary keeps every event. Reference excludes only the three separately audited US source-quality tickers; it never replaces the primary result.",
  };
}

function quantileRanges(
  values: readonly number[],
  requestedBins: number,
): Array<{ index: number; minimum: number; maximum: number }> {
  if (!values.length) return [];
  const sorted = [...values].sort((left, right) => left - right);
  const boundaries = Array.from({ length: requestedBins + 1 }, (_, index) =>
    quantile(sorted, index / requestedBins)!,
  ).filter(
    (value, index, all) => index === 0 || value > all[index - 1],
  );
  if (boundaries.length === 1) boundaries.push(boundaries[0]);
  return boundaries.slice(0, -1).map((minimum, index) => ({
    index,
    minimum,
    maximum: boundaries[index + 1],
  }));
}

function rangeIndex(
  value: number,
  ranges: ReadonlyArray<{ minimum: number; maximum: number }>,
): number {
  const index = ranges.findIndex(
    (range, rangeIndexValue) =>
      value >= range.minimum &&
      (rangeIndexValue === ranges.length - 1
        ? value <= range.maximum
        : value < range.maximum),
  );
  return index;
}

export function getSixStageRealFeatureDiscovery(args: {
  market: SixStageRealMarket;
  length: 2 | 3;
  sequenceKey: string;
  horizon: number;
  direction: SixStageResearchDirection;
  favorablePct: number;
  adversePct: number;
  featureA: SixStageAvailableFeature;
  featureB: SixStageAvailableFeature;
  bins: number;
}) {
  assertRuntimeInputs(args.market);
  const sequenceKey = assertSequence(args.sequenceKey, args.length);
  const horizon = parseHorizon(args.horizon);
  if (args.direction !== "LONG" && args.direction !== "SHORT") {
    throw new Error("invalid_direction");
  }
  if (
    !(args.favorablePct > 0 && args.favorablePct <= 100) ||
    !(args.adversePct > 0 && args.adversePct <= 100)
  ) {
    throw new Error("invalid_threshold");
  }
  if (!Number.isInteger(args.bins) || args.bins < 2 || args.bins > 10) {
    throw new Error("invalid_bins");
  }
  if (args.featureA === args.featureB) throw new Error("invalid_feature_pair");
  const featureA = resolveFeature(args.market, args.featureA, "feature_a");
  const featureB = resolveFeature(args.market, args.featureB, "feature_b");
  const input = SIX_STAGE_REAL_INPUTS[args.market];
  const database = new DatabaseSync(input.eventStorePath, { readOnly: true });
  try {
    database.exec("PRAGMA trusted_schema=OFF");
    database.exec(
      `ATTACH DATABASE '${immutableUri(input.f1Path).replaceAll("'", "''")}' AS f1`,
    );
    if (featureA.needsPhysical || featureB.needsPhysical) {
      database.exec(
        `ATTACH DATABASE '${immutableUri(physicalFeaturePath(args.market)).replaceAll("'", "''")}' AS phys`,
      );
    }
    database.exec("PRAGMA query_only=ON");
    const physicalJoin =
      featureA.needsPhysical || featureB.needsPhysical
        ? "LEFT JOIN phys.event_physical_features p ON p.feature_key=e.feature_key"
        : "";
    const rows = database
      .prepare(
        `SELECT t.ticker,e.signal_date,e.entry_date,
          e.close_return_${horizon} AS close_return,
          e.mfe_${horizon} AS mfe,e.mae_${horizon} AS mae,e.excursion_path,
          ${featureA.select},${featureB.select}
        FROM event_paths e
        JOIN ticker_dictionary t ON t.ticker_id=e.ticker_id
        LEFT JOIN f1.signal_ma_features f ON f.feature_key=e.feature_key
        ${physicalJoin}
        WHERE e.length=? AND e.sequence_key=?
          AND e.close_return_${horizon} IS NOT NULL
          AND e.signal_date<='2022-12-30'
        ORDER BY e.signal_date,t.ticker`,
      )
      .iterate(args.length, sequenceKey);
    const observations: DetailObservation[] = [];
    for (const row of rows) {
      const closeReturn = nullableNumber(row.close_return);
      const rawMfe = nullableNumber(row.mfe);
      const rawMae = nullableNumber(row.mae);
      if (closeReturn == null || rawMfe == null || rawMae == null) {
        throw new Error("real_research_index_mismatch");
      }
      const ticker = String(row.ticker);
      observations.push({
        ticker,
        signalDate: String(row.signal_date),
        entryDate: row.entry_date == null ? null : String(row.entry_date),
        value: args.direction === "LONG" ? closeReturn : -closeReturn,
        mfe: args.direction === "LONG" ? rawMfe : -rawMae,
        mae: args.direction === "LONG" ? rawMae : -rawMfe,
        ...firstPassage(
          row.excursion_path as Uint8Array,
          horizon,
          args.direction,
          args.favorablePct,
          args.adversePct,
        ),
        feature: nullableNumber(row.feature_a),
        featureB: nullableNumber(row.feature_b),
        qualityFlags: qualityFlags(args.market, ticker),
      });
    }
    const complete = observations.filter(
      (row): row is DetailObservation & { feature: number; featureB: number } =>
        finite(row.feature) && finite(row.featureB),
    );
    const rangesA = quantileRanges(
      complete.map((row) => row.feature),
      args.bins,
    );
    const rangesB = quantileRanges(
      complete.map((row) => row.featureB),
      args.bins,
    );
    const grouped = new Map<string, DetailObservation[]>();
    for (const row of complete) {
      const a = rangeIndex(row.feature, rangesA);
      const b = rangeIndex(row.featureB, rangesB);
      if (a < 0 || b < 0) continue;
      const key = `${a}:${b}`;
      const group = grouped.get(key) ?? [];
      group.push(row);
      grouped.set(key, group);
    }
    const cells = [...grouped].map(([key, group]) => {
      const [a, b] = key.split(":").map(Number);
      return {
        featureABin: rangesA[a],
        featureBBin: rangesB[b],
        ...observationSummary(group),
        qualityComparison: qualityComparison(group),
      };
    });
    cells.sort(
      (left, right) =>
        left.featureABin.index - right.featureABin.index ||
        left.featureBBin.index - right.featureBBin.index,
    );
    return {
      market: args.market,
      length: args.length,
      sequenceKey,
      horizon,
      direction: args.direction,
      thresholds: {
        favorablePct: args.favorablePct,
        adversePct: args.adversePct,
      },
      features: { featureA: args.featureA, featureB: args.featureB },
      requestedBins: args.bins,
      ranges: { featureA: rangesA, featureB: rangesB },
      observations: observations.length,
      completeFeaturePairs: complete.length,
      missingFeaturePairs: observations.length - complete.length,
      overall: qualityComparison(observations),
      cells,
      pitEvidence: {
        featureKeyJoin: "FROZEN_SIGNAL_DATE_FEATURE_KEY",
        sma: "F1_PREFIX_ONLY",
        physical: "PREFIX_ONLY_RAW_FEATURES_NO_MARKET_CROSS_SECTION",
        futureOutcomeColumnsUsedAsFeatures: 0,
      },
    };
  } finally {
    database.close();
  }
}

export function getSixStageRealPatternDetail(args: {
  market: SixStageRealMarket;
  length: 2 | 3;
  sequenceKey: string;
  horizon: number;
  direction: SixStageResearchDirection;
  favorablePct: number;
  adversePct: number;
  ticker?: string | null;
  year?: number | null;
  feature?: SixStageAvailableFeature | null;
}) {
  assertRuntimeInputs(args.market);
  const sequenceKey = assertSequence(args.sequenceKey, args.length);
  const horizon = parseHorizon(args.horizon);
  if (args.direction !== "LONG" && args.direction !== "SHORT")
    throw new Error("invalid_direction");
  if (
    !(args.favorablePct > 0 && args.favorablePct <= 100) ||
    !(args.adversePct > 0 && args.adversePct <= 100)
  ) {
    throw new Error("invalid_threshold");
  }
  const ticker = args.ticker?.trim().toUpperCase() || null;
  if (ticker && !/^[A-Z0-9.-]{1,16}$/.test(ticker))
    throw new Error("invalid_ticker");
  if (
    args.year != null &&
    (!Number.isInteger(args.year) || args.year < 2010 || args.year > 2022)
  )
    throw new Error("invalid_year");
  const feature = args.feature ?? null;
  const resolvedFeature = feature
    ? resolveFeature(args.market, feature, "feature_value")
    : null;
  const input = SIX_STAGE_REAL_INPUTS[args.market];
  const db = new DatabaseSync(input.eventStorePath, { readOnly: true });
  try {
    db.exec("PRAGMA trusted_schema=OFF");
    db.exec(
      `ATTACH DATABASE '${immutableUri(input.f1Path).replaceAll("'", "''")}' AS f1`,
    );
    if (resolvedFeature?.needsPhysical)
      db.exec(
        `ATTACH DATABASE '${immutableUri(physicalFeaturePath(args.market)).replaceAll("'", "''")}' AS phys`,
      );
    db.exec("PRAGMA query_only=ON");
    const where = [
      "e.length=?",
      "e.sequence_key=?",
      `e.close_return_${horizon} IS NOT NULL`,
      "e.signal_date<='2022-12-30'",
    ];
    const bindings: unknown[] = [args.length, sequenceKey];
    if (ticker) {
      where.push("t.ticker=?");
      bindings.push(ticker);
    }
    if (args.year != null) {
      where.push("substr(e.signal_date,1,4)=?");
      bindings.push(String(args.year));
    }
    const featureSelect = resolvedFeature?.select ?? "NULL AS feature_value";
    const physicalJoin = resolvedFeature?.needsPhysical
      ? "LEFT JOIN phys.event_physical_features p ON p.feature_key=e.feature_key"
      : "";
    const rows = db
      .prepare(
        `SELECT t.ticker,e.signal_date,e.entry_date,e.close_return_${horizon} AS close_return,
      e.mfe_${horizon} AS mfe,e.mae_${horizon} AS mae,e.excursion_path,${featureSelect}
      FROM event_paths e JOIN ticker_dictionary t ON t.ticker_id=e.ticker_id
      LEFT JOIN f1.signal_ma_features f ON f.feature_key=e.feature_key
      ${physicalJoin}
      WHERE ${where.join(" AND ")} ORDER BY e.signal_date,t.ticker`,
      )
      .iterate(...bindings);
    const observations: DetailObservation[] = [];
    const tickerCounts = new Map<string, number>();
    const yearCounts = new Map<string, number>();
    for (const row of rows) {
      const closeReturn = nullableNumber(row.close_return);
      const rawMfe = nullableNumber(row.mfe);
      const rawMae = nullableNumber(row.mae);
      if (closeReturn == null || rawMfe == null || rawMae == null) {
        throw new Error("real_research_index_mismatch");
      }
      const passage = firstPassage(
        row.excursion_path as Uint8Array,
        horizon,
        args.direction,
        args.favorablePct,
        args.adversePct,
      );
      const rowTicker = String(row.ticker);
      const observation: DetailObservation = {
        ticker: rowTicker,
        signalDate: String(row.signal_date),
        entryDate: row.entry_date == null ? null : String(row.entry_date),
        value: args.direction === "LONG" ? closeReturn : -closeReturn,
        mfe: args.direction === "LONG" ? rawMfe : -rawMae,
        mae: args.direction === "LONG" ? rawMae : -rawMfe,
        ...passage,
        feature: nullableNumber(row.feature_value),
        qualityFlags: qualityFlags(args.market, rowTicker),
      };
      observations.push(observation);
      tickerCounts.set(
        observation.ticker,
        (tickerCounts.get(observation.ticker) ?? 0) + 1,
      );
      const year = observation.signalDate.slice(0, 4);
      yearCounts.set(year, (yearCounts.get(year) ?? 0) + 1);
    }
    const values = observations.map((row) => row.value);
    const favorable = observations.filter(
      (row) => row.first === "FAVORABLE",
    ).length;
    const adverse = observations.filter(
      (row) => row.first === "ADVERSE",
    ).length;
    const same = observations.filter(
      (row) => row.first === "SAME_SESSION_UNKNOWN",
    ).length;
    const neither = observations.filter(
      (row) => row.first === "NEITHER",
    ).length;
    const orderedCounts = (counts: Map<string, number>) =>
      [...counts]
        .sort((left, right) => right[1] - left[1])
        .slice(0, 20)
        .map(([key, count]) => ({
          key,
          count,
          share: rate(count, observations.length),
        }));
    return {
      market: args.market,
      length: args.length,
      sequenceKey,
      horizon,
      direction: args.direction,
      filters: { ticker, year: args.year ?? null, feature },
      thresholds: {
        favorablePct: args.favorablePct,
        adversePct: args.adversePct,
      },
      observations: observations.length,
      passage: {
        favorable,
        adverse,
        sameSessionUnknown: same,
        neither,
        favorableRate: rate(favorable, observations.length),
        adverseRate: rate(adverse, observations.length),
      },
      distribution: summarize(values),
      mfe: summarize(observations.map((row) => row.mfe)),
      mae: summarize(observations.map((row) => row.mae)),
      histogram: histogram(values),
      cdf: cdf(values),
      tickerConcentration: orderedCounts(tickerCounts),
      yearConcentration: orderedCounts(yearCounts),
      outliers: [...observations]
        .sort((left, right) => Math.abs(right.value) - Math.abs(left.value))
        .slice(0, 50),
      featureBreakdown: feature ? featureBreakdown(observations) : null,
      qualityComparison: qualityComparison(observations),
    };
  } finally {
    db.close();
  }
}
