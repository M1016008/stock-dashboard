"use client";

import { useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  BarChart3,
  ChevronLeft,
  ChevronRight,
  Database,
  RefreshCw,
  Search,
} from "lucide-react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { SixStageAdvancedFeatureDiscovery } from "@/components/research/SixStageAdvancedFeatureDiscovery";

type Market = "JP" | "US";
type Direction = "LONG" | "SHORT";
type Horizon = 5 | 10 | 15 | 20;
type Length = 2 | 3;
type Sort =
  | "first5"
  | "hit10"
  | "median"
  | "mfe"
  | "mae"
  | "samples"
  | "outlier"
  | "composite";
type RankingWeights = {
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

type Meta = {
  status: string;
  discoveryStart: string;
  discoveryCutoff: string;
  sourceAdoptionSha256: string;
  distributionArtifactSha256: string;
  productionAccess: number;
  validationAccess: number;
  holdoutAccess: number;
  isolationEvidence: {
    mode: string;
    researchRootVerified: boolean;
    fixedInputHashesVerified: boolean;
    apiEnvironmentGate: string;
    runtimeAccessCountersAvailable: boolean;
  };
  availableSmaFeatures: string[];
  availablePhysicalFeatures: string[];
  unavailableFeatures: Record<string, string>;
  markets: Array<{
    market: Market;
    events: number;
    patterns: number;
    summaryRows: number;
    eventStoreSha256: string;
    priceBasis: string;
    featureKeyCoverage: number;
  }>;
};

type RankingRow = {
  length: Length;
  sequenceKey: string;
  horizon: Horizon;
  populationEvents: number;
  observedEvents: number;
  missingEntry: number;
  invalidPrice: number;
  rightCensored: number;
  tickerCount: number;
  yearCount: number;
  topTickerShare: number | null;
  topYearShare: number | null;
  mean: number | null;
  median: number | null;
  q25: number | null;
  q75: number | null;
  mfeMedian: number | null;
  maeMedian: number | null;
  first5Rate: number | null;
  hit10Rate: number | null;
  sameSession5: number;
  topAbs1Contribution: number | null;
  qualityFlaggedEvents: number;
  qualityFlaggedShare: number | null;
  qualityFlags: string[];
  compositeScore: number | null;
  compositeWeightCoverage: number | null;
};

type Ranking = {
  total: number;
  page: number;
  pageSize: number;
  rows: RankingRow[];
};
type Summary = {
  count: number;
  mean: number | null;
  median: number | null;
  q01: number | null;
  q05: number | null;
  q25: number | null;
  q75: number | null;
  q95: number | null;
  q99: number | null;
  minimum: number | null;
  maximum: number | null;
  trimmedMean: number | null;
  topAbs1Contribution: number | null;
  topAbs5Contribution: number | null;
};
type Detail = {
  sequenceKey: string;
  observations: number;
  passage: {
    favorable: number;
    adverse: number;
    sameSessionUnknown: number;
    neither: number;
    favorableRate: number | null;
    adverseRate: number | null;
  };
  distribution: Summary;
  mfe: Summary;
  mae: Summary;
  histogram: Array<{ from: number; to: number; count: number }>;
  cdf: Array<{ value: number; cumulative: number }>;
  tickerConcentration: Array<{
    key: string;
    count: number;
    share: number | null;
  }>;
  yearConcentration: Array<{
    key: string;
    count: number;
    share: number | null;
  }>;
  outliers: Array<{
    ticker: string;
    signalDate: string;
    entryDate: string | null;
    value: number;
    mfe: number;
    mae: number;
    first: string;
    favorableDay: number | null;
    adverseDay: number | null;
    qualityFlags: string[];
  }>;
  featureBreakdown: null | {
    available: number;
    missing: number;
    bins: Array<{
      index: number;
      minimum: number;
      maximum: number;
      observations: number;
      favorable: number;
      favorableRate: number | null;
      distribution: Summary;
      mfe: Summary;
      mae: Summary;
    }>;
  };
  qualityComparison: {
    flaggedEvents: number;
    flaggedShare: number | null;
    flaggedTickers: string[];
    reference: null | {
      observations: number;
      favorableRate: number | null;
      distribution: Summary;
      mfe: Summary;
      mae: Summary;
    };
    policy: string;
  };
};

const API = "/api/research/six-stage/event-paths";
const PAGE_SIZE = 50;
const HORIZONS: Horizon[] = [5, 10, 15, 20];
const SORTS: Array<{ value: Sort; label: string }> = [
  { value: "first5", label: "+5%先着率（高い順）" },
  { value: "hit10", label: "+10%到達率（高い順）" },
  { value: "median", label: "方向調整済み終点中央値（有利な順）" },
  { value: "mfe", label: "MFE中央値（高い順）" },
  { value: "mae", label: "MAE中央値（0に近い順）" },
  { value: "samples", label: "観測件数（多い順）" },
  { value: "outlier", label: "上位1%絶対寄与（小さい順）" },
  { value: "composite", label: "重み付き比較スコア" },
];

const DEFAULT_WEIGHTS: RankingWeights = {
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

const WEIGHT_LABELS: Array<{ key: keyof RankingWeights; label: string }> = [
  { key: "first5", label: "+5%先着" },
  { key: "hit10", label: "+10%到達" },
  { key: "median", label: "終点中央値" },
  { key: "mfe", label: "MFE" },
  { key: "mae", label: "逆行抑制" },
  { key: "samples", label: "標本数" },
  { key: "concentration", label: "集中抑制" },
  { key: "outlier", label: "外れ値抑制" },
  { key: "quality", label: "品質flag抑制" },
];

const FEATURE_LABELS: Record<string, string> = {
  sma25Angle: "SMA25 角度",
  sma75Angle: "SMA75 角度",
  sma150Angle: "SMA150 角度",
  sma200Angle: "SMA200 角度",
  sma300Angle: "SMA300 角度",
  sma25Curvature: "SMA25 曲率",
  sma75Curvature: "SMA75 曲率",
  sma150Curvature: "SMA150 曲率",
  sma200Curvature: "SMA200 曲率",
  sma300Curvature: "SMA300 曲率",
  sma25CloseGap: "終値-SMA25 乖離",
  sma75CloseGap: "終値-SMA75 乖離",
  sma150CloseGap: "終値-SMA150 乖離",
  sma200CloseGap: "終値-SMA200 乖離",
  sma300CloseGap: "終値-SMA300 乖離",
  sma25To75Distance: "SMA25-75 距離",
  sma75To150Distance: "SMA75-150 距離",
  sma150To200Distance: "SMA150-200 距離",
  sma200To300Distance: "SMA200-300 距離",
  sma25To75Convergence: "SMA25-75 収束",
  sma75To150Convergence: "SMA75-150 収束",
  sma150To200Convergence: "SMA150-200 収束",
  sma200To300Convergence: "SMA200-300 収束",
  velocity: "速度",
  acceleration: "加速度",
  momentum: "Momentum",
  force: "Force",
  energy: "Energy",
  physicalMa5Angle: "Prefix価格 MA5角度",
  physicalMa25Angle: "Prefix価格 MA25角度",
  physicalMa75Angle: "Prefix価格 MA75角度",
  physicalMa200Angle: "Prefix価格 MA200角度",
  physicalMaAngleAverage: "物理計算 MA角度平均",
};

function pct(value: number | null | undefined, digits = 2): string {
  return value == null || !Number.isFinite(value)
    ? "—"
    : `${(value * 100).toFixed(digits)}%`;
}

function count(value: number | null | undefined): string {
  return value == null ? "—" : value.toLocaleString("ja-JP");
}

function hash(value: string): string {
  return `${value.slice(0, 10)}…${value.slice(-8)}`;
}

function classNames(
  ...values: Array<string | false | null | undefined>
): string {
  return values.filter(Boolean).join(" ");
}

function Segment<T extends string | number>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: Array<{ value: T; label: string }>;
  onChange: (value: T) => void;
}) {
  return (
    <fieldset className="min-w-0">
      <legend className="mb-1 text-[11px] font-semibold text-[var(--color-text-secondary)]">
        {label}
      </legend>
      <div className="inline-flex max-w-full overflow-x-auto rounded border border-[var(--color-border-default)] bg-white p-0.5">
        {options.map((option) => (
          <button
            key={option.value}
            type="button"
            aria-pressed={value === option.value}
            onClick={() => onChange(option.value)}
            className={classNames(
              "min-h-11 shrink-0 px-3 py-1.5 text-[12px] font-semibold",
              value === option.value
                ? "bg-[var(--color-brand-700)] text-white"
                : "text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-subtle)]",
            )}
          >
            {option.label}
          </button>
        ))}
      </div>
    </fieldset>
  );
}

function Metric({
  label,
  value,
  sub,
}: {
  label: string;
  value: string;
  sub: string;
}) {
  return (
    <div className="min-w-0 border-b border-[var(--color-border-soft)] p-3 last:border-b-0 sm:border-b-0 sm:border-r sm:last:border-r-0">
      <div className="text-[11px] font-semibold text-[var(--color-text-secondary)]">
        {label}
      </div>
      <div
        className="mt-1 truncate font-mono text-lg font-bold text-[var(--color-text-primary)]"
        title={value}
      >
        {value}
      </div>
      <div
        className="mt-0.5 truncate text-[10px] text-[var(--color-text-muted)]"
        title={sub}
      >
        {sub}
      </div>
    </div>
  );
}

async function getJson<T>(
  params: URLSearchParams,
  signal: AbortSignal,
): Promise<T> {
  const response = await fetch(`${API}?${params}`, {
    cache: "no-store",
    signal,
  });
  const text = await response.text();
  let payload: T & { error?: string };
  try {
    payload = JSON.parse(text) as T & { error?: string };
  } catch {
    throw new Error(`研究APIを利用できません (HTTP ${response.status})`);
  }
  if (!response.ok)
    throw new Error(userError(payload.error ?? `HTTP ${response.status}`));
  return payload;
}

function userError(value: string): string {
  const messages: Record<string, string> = {
    invalid_threshold: "閾値は0より大きく100以下で指定してください。",
    invalid_ticker: "銘柄コードの形式を確認してください。",
    invalid_year: "年はDiscovery期間内で指定してください。",
    invalid_sequence: "遷移identityの形式を確認してください。",
    real_research_store_unavailable: "実データ研究Indexが未完成です。",
    physical_feature_store_unavailable:
      "Physical特徴Storeはまだ利用できません。",
    invalid_market: "市場の指定を確認してください。",
    invalid_direction: "LONG/SHORTの指定を確認してください。",
    invalid_length: "2状態/3状態の指定を確認してください。",
    invalid_horizon: "営業日の指定を確認してください。",
    invalid_sort: "並べ替えの指定を確認してください。",
    invalid_pagination: "ページ指定を確認してください。",
    invalid_view: "研究表示の指定を確認してください。",
    invalid_search: "遷移検索の形式を確認してください。",
    invalid_feature: "特徴量の指定を確認してください。",
    real_research_index_mismatch: "固定研究IndexのIdentityが一致しません。",
    real_research_request_failed: "研究データの取得に失敗しました。",
  };
  return messages[value] ?? value;
}

export function SixStageRealEventPathLab() {
  const [meta, setMeta] = useState<Meta | null>(null);
  const [market, setMarket] = useState<Market>("JP");
  const [direction, setDirection] = useState<Direction>("LONG");
  const [length, setLength] = useState<Length>(2);
  const [horizon, setHorizon] = useState<Horizon>(20);
  const [sort, setSort] = useState<Sort>("samples");
  const [draftWeights, setDraftWeights] =
    useState<RankingWeights>(DEFAULT_WEIGHTS);
  const [rankingWeights, setRankingWeights] =
    useState<RankingWeights>(DEFAULT_WEIGHTS);
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [ranking, setRanking] = useState<Ranking | null>(null);
  const [sequenceKey, setSequenceKey] = useState("");
  const [selectedSummary, setSelectedSummary] = useState<RankingRow | null>(
    null,
  );
  const [ticker, setTicker] = useState("");
  const [year, setYear] = useState("");
  const [favorablePct, setFavorablePct] = useState("5");
  const [adversePct, setAdversePct] = useState("5");
  const [feature, setFeature] = useState("sma25Angle");
  const [detail, setDetail] = useState<Detail | null>(null);
  const [rankingLoading, setRankingLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [metaError, setMetaError] = useState<string | null>(null);
  const [rankingError, setRankingError] = useState<string | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [metaReload, setMetaReload] = useState(0);
  const [rankingReload, setRankingReload] = useState(0);
  const [detailReload, setDetailReload] = useState(0);
  const [pageInput, setPageInput] = useState("1");

  useEffect(() => {
    const controller = new AbortController();
    setMetaError(null);
    getJson<Meta>(new URLSearchParams({ view: "meta" }), controller.signal)
      .then(setMeta)
      .catch((reason) => {
        if (!controller.signal.aborted)
          setMetaError(
            reason instanceof Error ? reason.message : "入力情報を読めません",
          );
      });
    return () => controller.abort();
  }, [metaReload]);

  useEffect(() => {
    const controller = new AbortController();
    setRankingLoading(true);
    setRankingError(null);
    const params = new URLSearchParams({
      view: "ranking",
      market,
      direction,
      length: String(length),
      horizon: String(horizon),
      sort,
      page: String(page),
      pageSize: String(PAGE_SIZE),
      ...(search ? { search } : {}),
      ...(sort === "composite"
        ? {
            wFirst5: String(rankingWeights.first5),
            wHit10: String(rankingWeights.hit10),
            wMedian: String(rankingWeights.median),
            wMfe: String(rankingWeights.mfe),
            wMae: String(rankingWeights.mae),
            wSamples: String(rankingWeights.samples),
            wConcentration: String(rankingWeights.concentration),
            wOutlier: String(rankingWeights.outlier),
            wQuality: String(rankingWeights.quality),
          }
        : {}),
    });
    getJson<Ranking>(params, controller.signal)
      .then((payload) => {
        setRanking(payload);
      })
      .catch((reason) => {
        if (!controller.signal.aborted) {
          setRanking(null);
          setRankingError(
            reason instanceof Error ? reason.message : "ランキングを読めません",
          );
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setRankingLoading(false);
      });
    return () => controller.abort();
  }, [
    market,
    direction,
    length,
    horizon,
    sort,
    page,
    search,
    rankingReload,
    rankingWeights,
  ]);

  useEffect(() => {
    if (!sequenceKey || !meta) {
      setDetail(null);
      setDetailLoading(false);
      setDetailError(null);
      return;
    }
    const available = [
      ...meta.availableSmaFeatures,
      ...meta.availablePhysicalFeatures,
    ];
    if (!available.includes(feature)) {
      setDetail(null);
      setDetailLoading(false);
      setDetailError(null);
      return;
    }
    setDetailError(null);
    const favorable = Number(favorablePct);
    const adverse = Number(adversePct);
    const normalizedTicker = ticker.trim().toUpperCase();
    if (
      !Number.isFinite(favorable) ||
      favorable <= 0 ||
      favorable > 100 ||
      !Number.isFinite(adverse) ||
      adverse <= 0 ||
      adverse > 100
    ) {
      setDetail(null);
      setDetailLoading(false);
      setDetailError("閾値は0より大きく100以下で指定してください。");
      return;
    }
    if (normalizedTicker && !/^[A-Z0-9.-]{1,16}$/.test(normalizedTicker)) {
      setDetail(null);
      setDetailLoading(false);
      setDetailError(
        "銘柄コードは英数字・ピリオド・ハイフンの16文字以内で指定してください。",
      );
      return;
    }
    const controller = new AbortController();
    setDetail(null);
    const timer = window.setTimeout(() => {
      setDetailLoading(true);
      setDetailError(null);
      const params = new URLSearchParams({
        view: "detail",
        market,
        direction,
        length: String(length),
        sequenceKey,
        horizon: String(horizon),
        favorablePct,
        adversePct,
        feature,
        ...(ticker.trim() ? { ticker: ticker.trim() } : {}),
        ...(year ? { year } : {}),
      });
      getJson<Detail>(params, controller.signal)
        .then(setDetail)
        .catch((reason) => {
          if (!controller.signal.aborted)
            setDetailError(
              reason instanceof Error ? reason.message : "分布を読めません",
            );
        })
        .finally(() => {
          if (!controller.signal.aborted) setDetailLoading(false);
        });
    }, 250);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [
    market,
    direction,
    length,
    horizon,
    sequenceKey,
    favorablePct,
    adversePct,
    ticker,
    year,
    feature,
    detailReload,
    meta,
  ]);

  useEffect(() => {
    if (!meta) return;
    const available = [
      ...meta.availableSmaFeatures,
      ...meta.availablePhysicalFeatures,
    ];
    if (!available.includes(feature) && available.length)
      setFeature(available[0]);
  }, [meta, feature]);

  const selected = useMemo(
    () =>
      ranking?.rows.find((row) => row.sequenceKey === sequenceKey) ??
      selectedSummary,
    [ranking, sequenceKey, selectedSummary],
  );
  const marketMeta = meta?.markets.find((row) => row.market === market);
  const availableFeatures = [
    ...(meta?.availableSmaFeatures ?? []),
    ...(meta?.availablePhysicalFeatures ?? []),
  ];
  const totalPages = Math.max(1, Math.ceil((ranking?.total ?? 0) / PAGE_SIZE));
  const histogram =
    detail?.histogram.map((row, index, rows) => ({
      ...row,
      label:
        index === 0
          ? `≤${(row.to * 100).toFixed(1)}`
          : index === rows.length - 1
            ? `≥${(row.from * 100).toFixed(1)}`
            : `${(row.from * 100).toFixed(1)}`,
    })) ?? [];
  const cumulative =
    detail?.cdf.map((row) => ({
      value: row.value * 100,
      cumulative: row.cumulative * 100,
    })) ?? [];
  const lowSample = detail != null && detail.observations < 30;
  const endpointOutlierDependent =
    (detail?.distribution.topAbs1Contribution ?? 0) >= 0.5;
  const mfeOutlierDependent = (detail?.mfe.topAbs1Contribution ?? 0) >= 0.5;
  const maeOutlierDependent = (detail?.mae.topAbs1Contribution ?? 0) >= 0.5;
  const fixedFavorableSign = direction === "LONG" ? "+" : "−";
  const favorableValue = Number(favorablePct);
  const adverseValue = Number(adversePct);
  const thresholdInputInvalid =
    !Number.isFinite(favorableValue) ||
    favorableValue <= 0 ||
    favorableValue > 100 ||
    !Number.isFinite(adverseValue) ||
    adverseValue <= 0 ||
    adverseValue > 100;
  const detailFiltersApplied =
    ticker.trim() !== "" ||
    year !== "" ||
    favorablePct !== "5" ||
    adversePct !== "5";
  const tickerInputInvalid =
    ticker.trim() !== "" &&
    !/^[A-Z0-9.-]{1,16}$/.test(ticker.trim().toUpperCase());
  const startYear = Number(meta?.discoveryStart.slice(0, 4) ?? "2010");
  const endYear = Number(meta?.discoveryCutoff.slice(0, 4) ?? "2022");

  const changeScope = (callback: () => void) => {
    callback();
    setPage(1);
    setPageInput("1");
    setSequenceKey("");
    setSelectedSummary(null);
    setDetail(null);
  };
  const selectSequence = (value: string) => {
    setSequenceKey(value);
    setSelectedSummary(
      ranking?.rows.find((row) => row.sequenceKey === value) ?? null,
    );
    if (window.innerWidth < 1536)
      window.setTimeout(
        () =>
          document
            .getElementById("pattern-detail")
            ?.scrollIntoView({ behavior: "smooth", block: "start" }),
        0,
      );
  };
  const changePage = (value: number) => {
    const next = Math.max(1, Math.min(totalPages, value));
    setPage(next);
    setPageInput(String(next));
  };

  return (
    <main className="mx-auto flex w-full max-w-[1600px] min-w-0 flex-col gap-5 px-3 py-5 sm:px-5 lg:px-7">
      <header className="flex flex-col gap-3 border-b border-[var(--color-border-default)] pb-4 xl:flex-row xl:items-end xl:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2 text-[11px] font-semibold">
            <span className="rounded bg-emerald-50 px-2 py-1 text-emerald-800">
              実Discoveryデータ
            </span>
            <span className="text-[var(--color-text-secondary)]">
              上限 {meta?.discoveryCutoff ?? "2022-12-30"}
            </span>
            {meta && (
              <span className="rounded border border-slate-300 px-2 py-1 text-[12px] text-slate-700">
                固定入力ハッシュ照合済み（実行時アクセス監視なし）
              </span>
            )}
          </div>
          <h1 className="mt-2 text-2xl font-bold text-[var(--color-text-primary)] sm:text-3xl">
            6ステージ 実価格経路ラボ
          </h1>
          <p className="mt-1 max-w-5xl text-[13px] leading-6 text-[var(--color-text-secondary)]">
            全観測遷移を除外せず、終点分布、MFE/MAE、先着順、集中度、SMA条件を同じ母集団で比較します。順位は観測値であり、自動採択ではありません。
          </p>
        </div>
        <div className="flex shrink-0 flex-col gap-1 text-[12px] text-[var(--color-text-secondary)]">
          <span className="inline-flex items-center gap-1">
            <Database size={14} /> Source{" "}
            <span title={meta?.sourceAdoptionSha256}>
              {meta ? hash(meta.sourceAdoptionSha256) : "確認中"}
            </span>
          </span>
          <span title={marketMeta?.eventStoreSha256}>
            Path {marketMeta ? hash(marketMeta.eventStoreSha256) : "確認中"}
          </span>
          <span>
            対象: OWC Discovery固定入力のみ。Production / Validation /
            Holdoutへ接続しない契約（実行時監視なし）
          </span>
          {meta && (
            <span>
              隔離モード: OWC read-only固定入力 · 研究API環境ゲート:{" "}
              {meta.isolationEvidence.apiEnvironmentGate}
            </span>
          )}
        </div>
      </header>

      <div className="grid gap-2 border-l-4 border-amber-600 bg-amber-50 px-4 py-3 text-[12px] text-amber-950 md:grid-cols-2">
        <p>
          <strong>全パターン表示:</strong>{" "}
          少数標本も保持します。既定は母数順で、率順へ切り替えると1件などの100%が上位になり得ます。
        </p>
        <p>
          <strong>特徴量範囲:</strong> SMA25〜300は結合済み。
          {!meta
            ? metaError
              ? "特徴量メタデータの読込みに失敗しました。"
              : "Physical Momentum状態は確認中です。"
            : meta.availablePhysicalFeatures.length
              ? "raw Momentum/Force/Energyも結合済みです。"
              : "Physical Momentumはまだ未結合です。"}{" "}
          PMS/PFS/PESは全市場日次断面を再現できないため未算出で、欠損値も0補完しません。
        </p>
      </div>

      {metaError && (
        <div
          role="alert"
          className="flex items-center justify-between gap-3 border-l-4 border-red-600 bg-red-50 px-4 py-3 text-[12px] text-red-900"
        >
          <span className="flex items-start gap-2">
            <AlertTriangle size={16} className="mt-0.5 shrink-0" />
            研究入力・隔離記録を読めません: {metaError}
          </span>
          <button
            type="button"
            onClick={() => setMetaReload((value) => value + 1)}
            className="min-h-11 shrink-0 rounded border border-red-300 bg-white px-3 py-1 font-semibold"
          >
            再試行
          </button>
        </div>
      )}
      {rankingError && (
        <div
          role="alert"
          className="flex items-center justify-between gap-3 border-l-4 border-red-600 bg-red-50 px-4 py-3 text-[12px] text-red-900"
        >
          <span className="flex items-start gap-2">
            <AlertTriangle size={16} className="mt-0.5 shrink-0" />
            ランキングエラー: {rankingError}
          </span>
          <button
            type="button"
            onClick={() => setRankingReload((value) => value + 1)}
            className="min-h-11 shrink-0 rounded border border-red-300 bg-white px-3 py-1 font-semibold"
          >
            再試行
          </button>
        </div>
      )}
      {detailError && (
        <div
          role="alert"
          className="flex items-center justify-between gap-3 border-l-4 border-red-600 bg-red-50 px-4 py-3 text-[12px] text-red-900"
        >
          <span className="flex items-start gap-2">
            <AlertTriangle size={16} className="mt-0.5 shrink-0" />
            詳細分布エラー: {detailError}
          </span>
          <button
            type="button"
            onClick={() => setDetailReload((value) => value + 1)}
            className="min-h-11 shrink-0 rounded border border-red-300 bg-white px-3 py-1 font-semibold"
          >
            再試行
          </button>
        </div>
      )}

      <section
        className="grid gap-3 border-b border-[var(--color-border-default)] pb-4 md:grid-cols-2 xl:grid-cols-[auto_auto_auto_minmax(170px,0.7fr)_minmax(200px,1fr)_auto] xl:items-end"
        aria-label="研究条件"
      >
        <Segment
          label="市場"
          value={market}
          onChange={(value) => changeScope(() => setMarket(value))}
          options={[
            { value: "JP", label: "JP" },
            { value: "US", label: "US" },
          ]}
        />
        <Segment
          label="方向"
          value={direction}
          onChange={(value) => changeScope(() => setDirection(value))}
          options={[
            { value: "LONG", label: "LONG" },
            { value: "SHORT", label: "SHORT" },
          ]}
        />
        <Segment
          label="遷移"
          value={length}
          onChange={(value) => changeScope(() => setLength(value))}
          options={[
            { value: 2, label: "2状態" },
            { value: 3, label: "3状態" },
          ]}
        />
        <label className="text-[11px] font-semibold text-[var(--color-text-secondary)]">
          営業日
          <select
            value={horizon}
            onChange={(event) =>
              changeScope(() =>
                setHorizon(Number(event.target.value) as Horizon),
              )
            }
            className="mt-1 h-11 w-full rounded border border-[var(--color-border-default)] bg-white px-2 text-[13px]"
          >
            {HORIZONS.map((value) => (
              <option key={value} value={value}>
                {value}日
              </option>
            ))}
          </select>
        </label>
        <label className="text-[11px] font-semibold text-[var(--color-text-secondary)]">
          ランキング
          <select
            value={sort}
            onChange={(event) =>
              changeScope(() => setSort(event.target.value as Sort))
            }
            className="mt-1 h-11 w-full rounded border border-[var(--color-border-default)] bg-white px-2 text-[13px]"
          >
            {SORTS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.value === "first5"
                  ? `${fixedFavorableSign}5%先着率（高い順）`
                  : option.value === "hit10"
                    ? `${fixedFavorableSign}10%到達率（高い順）`
                    : option.label}
              </option>
            ))}
          </select>
        </label>
        <form
          className="flex items-end gap-1"
          onSubmit={(event) => {
            event.preventDefault();
            changeScope(() => setSearch(searchInput.trim()));
          }}
        >
          <label className="min-w-0 flex-1 text-[11px] font-semibold text-[var(--color-text-secondary)]">
            遷移検索
            <input
              value={searchInput}
              onChange={(event) =>
                setSearchInput(event.target.value.replace(/[^0-9>]/g, ""))
              }
              placeholder="211111>111111"
              className="mt-1 h-11 w-full rounded border border-[var(--color-border-default)] px-2 font-mono text-[12px]"
            />
          </label>
          <button
            type="submit"
            title="検索"
            className="grid size-11 shrink-0 place-items-center rounded border border-[var(--color-border-default)] bg-white hover:bg-[var(--color-surface-subtle)]"
          >
            <Search size={15} />
          </button>
        </form>
        <p className="text-[11px] text-[var(--color-text-muted)] md:col-span-2 xl:col-span-6">
          遷移identityの全部または一部を入力し、検索ボタンで適用します。例:
          211111&gt;111111
        </p>
      </section>

      <details className="border-b border-[var(--color-border-default)] pb-4">
        <summary className="min-h-11 cursor-pointer py-3 text-[12px] font-bold">
          重み付き全パターン比較
        </summary>
        <p className="mb-3 text-[11px] leading-5 text-[var(--color-text-muted)]">
          全パターンをサーバー側で0〜1に正規化して並べます。欠損指標は0扱いせず分母から外し、利用できた重みの割合を併記します。スコアは推奨確率ではありません。
        </p>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
          {WEIGHT_LABELS.map(({ key, label }) => (
            <label key={key} className="text-[11px] font-semibold">
              {label}
              <div className="mt-1 flex items-center gap-2">
                <input
                  type="range"
                  min={0}
                  max={10}
                  step={1}
                  value={draftWeights[key]}
                  aria-valuetext={`${label} ${draftWeights[key]}`}
                  onChange={(event) =>
                    setDraftWeights((current) => ({
                      ...current,
                      [key]: Number(event.target.value),
                    }))
                  }
                  className="min-h-11 min-w-0 flex-1"
                />
                <input
                  type="number"
                  min={0}
                  max={10}
                  value={draftWeights[key]}
                  aria-label={`${label}の重み`}
                  onChange={(event) =>
                    setDraftWeights((current) => ({
                      ...current,
                      [key]: Math.max(
                        0,
                        Math.min(10, Number(event.target.value) || 0),
                      ),
                    }))
                  }
                  className="min-h-11 w-16 border border-[var(--color-border-default)] px-2 text-right font-mono"
                />
              </div>
            </label>
          ))}
        </div>
        <div className="mt-3 flex flex-wrap gap-2">
          <button
            type="button"
            disabled={Object.values(draftWeights).every((value) => value === 0)}
            onClick={() => {
              setRankingWeights({ ...draftWeights });
              setSort("composite");
              setPage(1);
              setPageInput("1");
            }}
            className="min-h-11 bg-[var(--color-brand-700)] px-4 text-[12px] font-bold text-white disabled:cursor-not-allowed disabled:opacity-50"
          >
            全件へ適用
          </button>
          <button
            type="button"
            onClick={() => {
              setDraftWeights(DEFAULT_WEIGHTS);
              setRankingWeights(DEFAULT_WEIGHTS);
            }}
            className="min-h-11 border border-[var(--color-border-default)] bg-white px-4 text-[12px] font-semibold"
          >
            初期値に戻す
          </button>
          {Object.values(draftWeights).every((value) => value === 0) && (
            <span role="alert" className="self-center text-[12px] text-red-700">
              少なくとも1項目に重みが必要です。
            </span>
          )}
        </div>
      </details>

      <section
        className="grid overflow-hidden rounded border border-[var(--color-border-default)] bg-white sm:grid-cols-2 xl:grid-cols-5"
        aria-label="研究入力"
      >
        <Metric
          label={`${market} 全イベント`}
          value={count(marketMeta?.events)}
          sub={`全遷移 ${count(marketMeta?.patterns)}種類`}
        />
        <Metric
          label="ランキング母数（全銘柄・全年）"
          value={count(selected?.populationEvents)}
          sub={`観測可能 ${count(selected?.observedEvents)}`}
        />
        <Metric
          label={`${fixedFavorableSign}${favorablePct}%先着 (詳細)`}
          value={pct(detail?.passage.favorableRate)}
          sub={`${detailFiltersApplied ? "フィルタ適用中 · " : ""}固定5%ランキングとは別 · 同一足不明 ${count(detail?.passage.sameSessionUnknown)}`}
        />
        <Metric
          label="詳細・方向調整終点中央値"
          value={pct(detail?.distribution.median)}
          sub={`${detailFiltersApplied ? "フィルタ適用中 · " : ""}1%トリム平均 ${pct(detail?.distribution.trimmedMean)}`}
        />
        <Metric
          label="詳細・上位1%絶対寄与"
          value={pct(detail?.distribution.topAbs1Contribution)}
          sub={`${detailFiltersApplied ? "フィルタ適用中 · " : ""}上位5% ${pct(detail?.distribution.topAbs5Contribution)}`}
        />
      </section>

      <section className="grid min-w-0 gap-5 2xl:grid-cols-[minmax(650px,1.2fr)_minmax(480px,0.8fr)]">
        <div id="pattern-ranking" className="min-w-0 scroll-mt-4">
          <div className="mb-2 flex items-center justify-between gap-3">
            <div>
              <h2 className="text-[15px] font-bold text-[var(--color-text-primary)]">
                全遷移ランキング
              </h2>
              <p className="text-[11px] text-[var(--color-text-secondary)]">
                {count(ranking?.total)}パターン · 固定{fixedFavorableSign}5% /{" "}
                {fixedFavorableSign}10% ·
                終点とMFEは有利方向を正、MAEは逆行方向を負で表示
              </p>
              <p className="mt-1 text-[11px] text-[var(--color-text-muted)]">
                デスクトップ表は横スクロール対応。順位は観測値であり推奨ではありません。少数=30件未満（表示のみ・除外なし）。上位1%は標本100件未満でも最低1件です。
              </p>
              {sort !== "samples" && (
                <p className="mt-1 border-l-2 border-amber-600 pl-2 text-[11px] font-semibold text-amber-900">
                  母数制限なしの並べ替えです。少数標本が上位になり得るため、母数・銘柄数・高依存表示を併読してください。
                </p>
              )}
            </div>
            {rankingLoading && (
              <span
                role="status"
                aria-live="polite"
                className="inline-flex items-center gap-1 text-[11px] text-[var(--color-text-muted)]"
              >
                <RefreshCw size={15} className="animate-spin" />
                読込中
              </span>
            )}
          </div>
          <p className="mb-2 border-l-4 border-slate-500 bg-slate-50 px-3 py-2 text-[12px] font-semibold text-slate-800 lg:hidden">
            観測値の並べ替えであり、投資候補の推奨順位ではありません。
          </p>
          <div
            aria-busy={rankingLoading}
            className={classNames(
              "grid gap-2 lg:hidden",
              rankingLoading && "pointer-events-none opacity-50",
            )}
          >
            {ranking?.rows.map((row) => (
              <button
                key={row.sequenceKey}
                type="button"
                aria-pressed={sequenceKey === row.sequenceKey}
                onClick={() => selectSequence(row.sequenceKey)}
                className={classNames(
                  "min-h-11 border-y px-2 py-3 text-left",
                  row.observedEvents < 30 && "bg-amber-50",
                  sequenceKey === row.sequenceKey &&
                    "border-emerald-600 bg-emerald-50",
                )}
              >
                <span className="flex items-center justify-between gap-2">
                  <span className="font-mono text-[12px] font-bold">
                    {row.sequenceKey}
                  </span>
                  <span className="text-[12px]">
                    観測 {count(row.observedEvents)}
                    {row.observedEvents < 30 ? " · 少数標本（参考）" : ""}
                  </span>
                </span>
                <span className="mt-2 grid grid-cols-2 gap-2 text-[12px]">
                  {row.observedEvents < 30 && (
                    <span className="col-span-2 border-l-2 border-amber-700 pl-2 font-semibold text-amber-950">
                      少数標本 n={count(row.observedEvents)}
                      （参考表示・除外なし）
                    </span>
                  )}
                  <span>母数 {count(row.populationEvents)}</span>
                  <span>
                    {fixedFavorableSign}5先着 {pct(row.first5Rate, 1)} (n=
                    {count(row.observedEvents)})
                  </span>
                  <span>
                    {fixedFavorableSign}10到達 {pct(row.hit10Rate, 1)} (n=
                    {count(row.observedEvents)})
                  </span>
                  <span>
                    方向調整中央値 {pct(row.median)} (n=
                    {count(row.observedEvents)})
                  </span>
                  <span>
                    Q25 {pct(row.q25)} (n={count(row.observedEvents)})
                  </span>
                  <span>
                    Q75 {pct(row.q75)} (n={count(row.observedEvents)})
                  </span>
                  <span>
                    MFE {pct(row.mfeMedian)} (n={count(row.observedEvents)})
                  </span>
                  <span>
                    MAE {pct(row.maeMedian)} (n={count(row.observedEvents)})
                  </span>
                  <span>銘柄 {count(row.tickerCount)}</span>
                  <span>最大銘柄集中 {pct(row.topTickerShare, 1)}</span>
                  <span>右側打切り {count(row.rightCensored)}</span>
                  <span>上位1% {pct(row.topAbs1Contribution, 1)}</span>
                  <span>
                    重みスコア {pct(row.compositeScore, 1)}
                  </span>
                  <span>
                    重みcoverage {pct(row.compositeWeightCoverage, 0)}
                  </span>
                  <span>
                    品質flag {count(row.qualityFlaggedEvents)}
                  </span>
                  <span className="col-span-2 text-[10px] text-[var(--color-text-muted)]">
                    MFE=有利方向の最大変動（正） / MAE=逆行幅（負）
                  </span>
                </span>
                <span className="mt-1 flex gap-2 text-[12px] font-semibold">
                  {(row.topAbs1Contribution ?? 0) >= 0.5 && (
                    <span
                      className="text-red-800"
                      title="上位1%寄与50%以上の注意表示。除外条件ではなく、100件未満は最低1件で計算。"
                    >
                      {row.observedEvents < 100
                        ? "上位1件寄与（計算上）"
                        : "上位1%寄与高・参考"}
                    </span>
                  )}
                  {row.qualityFlaggedEvents > 0 && (
                    <span className="text-amber-900">
                      監査対象tickerを{count(row.qualityFlaggedEvents)}件含む
                    </span>
                  )}
                </span>
              </button>
            ))}
            {!rankingLoading && ranking == null && !rankingError && (
              <p className="py-6 text-center text-[12px]">
                ランキングを読み込めません。
              </p>
            )}
            {!rankingLoading && ranking?.rows.length === 0 && (
              <p className="py-6 text-center text-[12px]">
                一致する遷移はありません。
              </p>
            )}
          </div>
          <div
            aria-busy={rankingLoading}
            className={classNames(
              "hidden max-h-[540px] overflow-auto border-y border-[var(--color-border-default)] lg:block",
              rankingLoading && "pointer-events-none opacity-50",
            )}
          >
            <table className="w-full min-w-[1060px] border-collapse text-left text-[11px]">
              <caption className="sr-only">
                {market} {length}状態 {horizon}営業日の全遷移ランキング
              </caption>
              <thead className="sticky top-0 z-10 bg-white">
                <tr className="border-b border-[var(--color-border-default)] text-[var(--color-text-secondary)]">
                  <th
                    scope="col"
                    className="sticky left-0 z-20 bg-white px-2 py-2"
                  >
                    遷移
                  </th>
                  <th scope="col" className="px-2 py-2 text-right">
                    母数
                  </th>
                  <th scope="col" className="px-2 py-2 text-right">
                    観測
                  </th>
                  <th scope="col" className="px-2 py-2 text-right">
                    {fixedFavorableSign}5先着
                  </th>
                  <th scope="col" className="px-2 py-2 text-right">
                    同一足不明
                  </th>
                  <th scope="col" className="px-2 py-2 text-right">
                    {fixedFavorableSign}10到達
                  </th>
                  <th scope="col" className="px-2 py-2 text-right">
                    方向調整終点
                  </th>
                  <th scope="col" className="px-2 py-2 text-right">
                    <span title="有利方向の最大変動。LONG/SHORTとも正値。">
                      MFE
                    </span>
                  </th>
                  <th scope="col" className="px-2 py-2 text-right">
                    <span title="不利方向の最大変動。LONG/SHORTとも負値で、0に近いほど浅い。">
                      MAE
                    </span>
                  </th>
                  <th scope="col" className="px-2 py-2 text-right">
                    <span title="絶対変動合計に占める上位1%（最低1件）の寄与">
                      上位1%
                    </span>
                  </th>
                  <th scope="col" className="px-2 py-2 text-right">
                    重みスコア
                  </th>
                  <th scope="col" className="px-2 py-2 text-right">
                    品質flag
                  </th>
                  <th scope="col" className="px-2 py-2 text-right">
                    銘柄
                  </th>
                  <th scope="col" className="px-2 py-2 text-right">
                    右側打切り
                  </th>
                </tr>
              </thead>
              <tbody>
                {ranking?.rows.map((row) => (
                  <tr
                    key={row.sequenceKey}
                    className={classNames(
                      "border-b border-[var(--color-border-soft)] hover:bg-[var(--color-surface-subtle)]",
                      row.observedEvents < 30 && "bg-amber-50/50",
                      sequenceKey === row.sequenceKey && "bg-emerald-50",
                    )}
                  >
                    <td
                      className={classNames(
                        "sticky left-0 z-[1] whitespace-nowrap px-2 py-1 font-mono font-semibold",
                        sequenceKey === row.sequenceKey
                          ? "bg-emerald-50"
                          : row.observedEvents < 30
                            ? "bg-amber-50"
                            : "bg-white",
                      )}
                    >
                      <button
                        type="button"
                        aria-pressed={sequenceKey === row.sequenceKey}
                        onClick={() => selectSequence(row.sequenceKey)}
                        className="min-h-11 rounded px-1 text-left underline-offset-2 hover:underline focus-visible:outline focus-visible:outline-2"
                      >
                        {row.sequenceKey}
                      </button>
                    </td>
                    <td className="px-2 py-2 text-right">
                      {count(row.populationEvents)}
                    </td>
                    <td className="px-2 py-2 text-right">
                      {count(row.observedEvents)}
                      {row.observedEvents < 30 ? (
                        <span className="ml-1 rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-semibold text-amber-900">
                          <span aria-hidden="true">少数・参考</span>
                          <span className="sr-only">少数標本の参考表示</span>
                        </span>
                      ) : null}
                    </td>
                    <td className="px-2 py-2 text-right font-mono">
                      {pct(row.first5Rate, 1)}
                    </td>
                    <td className="px-2 py-2 text-right font-mono">
                      {count(row.sameSession5)}
                    </td>
                    <td className="px-2 py-2 text-right font-mono">
                      {pct(row.hit10Rate, 1)}
                    </td>
                    <td className="px-2 py-2 text-right font-mono">
                      {pct(row.median)}
                    </td>
                    <td className="px-2 py-2 text-right font-mono">
                      {pct(row.mfeMedian)}
                    </td>
                    <td className="px-2 py-2 text-right font-mono">
                      {pct(row.maeMedian)}
                    </td>
                    <td className="px-2 py-2 text-right font-mono">
                      {pct(row.topAbs1Contribution, 1)}
                      {(row.topAbs1Contribution ?? 0) >= 0.5 && (
                        <span
                          className="ml-1 rounded bg-red-50 px-1.5 py-0.5 text-[10px] font-semibold text-red-800"
                          title="上位1%寄与50%以上の注意表示。除外条件ではなく、100件未満は最低1件で計算。"
                        >
                          {row.observedEvents < 100
                            ? "上位1件寄与"
                            : "上位1%寄与高"}
                        </span>
                      )}
                    </td>
                    <td className="px-2 py-2 text-right font-mono">
                      {pct(row.compositeScore, 1)}
                      <span className="block text-[11px] text-[var(--color-text-muted)]">
                        coverage {pct(row.compositeWeightCoverage, 0)}
                      </span>
                    </td>
                    <td className="px-2 py-2 text-right font-mono">
                      {count(row.qualityFlaggedEvents)}
                    </td>
                    <td className="px-2 py-2 text-right">
                      {count(row.tickerCount)}
                    </td>
                    <td className="px-2 py-2 text-right">
                      {count(row.rightCensored)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!rankingLoading && ranking?.rows.length === 0 && (
              <p className="px-3 py-8 text-center text-[12px] text-[var(--color-text-secondary)]">
                一致する遷移はありません。
              </p>
            )}
            {!rankingLoading && ranking == null && !rankingError && (
              <p className="px-3 py-8 text-center text-[12px] text-[var(--color-text-secondary)]">
                ランキングを読み込めません。
              </p>
            )}
          </div>
          <div className="mt-2 flex flex-wrap items-center justify-between gap-2 text-[11px]">
            <button
              type="button"
              disabled={page <= 1}
              onClick={() => changePage(page - 1)}
              className="inline-flex min-h-11 items-center gap-1 rounded border px-3 py-1 disabled:opacity-40"
            >
              <ChevronLeft size={13} /> 前
            </button>
            <span aria-live="polite">
              {page.toLocaleString("ja-JP")} /{" "}
              {totalPages.toLocaleString("ja-JP")}
            </span>
            <form
              className="inline-flex items-center gap-1"
              onSubmit={(event) => {
                event.preventDefault();
                const candidate = Number(pageInput);
                if (Number.isInteger(candidate)) changePage(candidate);
                else setPageInput(String(page));
              }}
            >
              <label htmlFor="ranking-page">ページ</label>
              <input
                id="ranking-page"
                type="number"
                min={1}
                max={totalPages}
                step={1}
                value={pageInput}
                onChange={(event) => setPageInput(event.target.value)}
                className="h-11 w-20 rounded border px-2 text-[12px]"
              />
              <button
                type="submit"
                className="min-h-11 rounded border px-3 font-semibold"
              >
                移動
              </button>
            </form>
            <button
              type="button"
              onClick={() =>
                document
                  .getElementById("pattern-detail")
                  ?.scrollIntoView({ behavior: "smooth" })
              }
              className="min-h-11 rounded px-2 font-semibold underline 2xl:hidden"
            >
              詳細へ
            </button>
            <button
              type="button"
              disabled={page >= totalPages}
              onClick={() => changePage(page + 1)}
              className="inline-flex min-h-11 items-center gap-1 rounded border px-3 py-1 disabled:opacity-40"
            >
              次 <ChevronRight size={13} />
            </button>
          </div>
        </div>

        <aside
          id="pattern-detail"
          aria-busy={detailLoading}
          className="min-w-0 scroll-mt-4"
        >
          <div className="mb-2 flex items-center justify-between gap-2">
            <div>
              <h2 className="font-mono text-[15px] font-bold text-[var(--color-text-primary)]">
                {sequenceKey || "遷移を選択"}
              </h2>
              <p className="text-[11px] text-[var(--color-text-secondary)]">
                以下は可変閾値・銘柄・年を反映。左のランキング値は全銘柄・全年・固定5%/10%で、別条件です。
              </p>
              <p className="mt-1 inline-block border-l-2 border-emerald-700 pl-2 text-[12px] font-semibold text-emerald-900">
                詳細母集団:{" "}
                {detailFiltersApplied
                  ? "銘柄・年または閾値を変更した条件"
                  : "全銘柄・全年・利益/損失5%"}
              </p>
              {detailFiltersApplied && (
                <p className="mt-1 inline-block rounded bg-amber-100 px-2 py-1 text-[12px] font-semibold text-amber-950">
                  詳細フィルタ適用中: ランキングとは別母集団・別閾値
                </p>
              )}
            </div>
            <button
              type="button"
              onClick={() =>
                document
                  .getElementById("pattern-ranking")
                  ?.scrollIntoView({ behavior: "smooth", block: "start" })
              }
              className="min-h-11 shrink-0 rounded border px-3 text-[12px] font-semibold 2xl:hidden"
            >
              一覧へ戻る
            </button>
            {detailLoading && (
              <span
                role="status"
                aria-live="polite"
                className="inline-flex items-center gap-1 text-[11px]"
              >
                <RefreshCw size={15} className="animate-spin" />
                分布を集計中
              </span>
            )}
          </div>
          <div className="grid gap-2 border-y border-[var(--color-border-default)] py-3 sm:grid-cols-2">
            <label className="text-[11px] font-semibold text-[var(--color-text-secondary)]">
              利益側 %
              <input
                id="favorable-threshold"
                type="number"
                min="0.1"
                max="100"
                step="0.5"
                value={favorablePct}
                onChange={(event) => setFavorablePct(event.target.value)}
                aria-invalid={thresholdInputInvalid}
                aria-describedby="threshold-help"
                className="mt-1 h-11 w-full rounded border px-2 text-[12px]"
              />
            </label>
            <label className="text-[11px] font-semibold text-[var(--color-text-secondary)]">
              損失側 %
              <input
                id="adverse-threshold"
                type="number"
                min="0.1"
                max="100"
                step="0.5"
                value={adversePct}
                onChange={(event) => setAdversePct(event.target.value)}
                aria-invalid={thresholdInputInvalid}
                aria-describedby="threshold-help"
                className="mt-1 h-11 w-full rounded border px-2 text-[12px]"
              />
            </label>
            <label className="text-[11px] font-semibold text-[var(--color-text-secondary)]">
              銘柄
              <input
                value={ticker}
                onChange={(event) =>
                  setTicker(event.target.value.toUpperCase())
                }
                placeholder="全銘柄"
                aria-invalid={tickerInputInvalid}
                aria-describedby="ticker-help"
                className="mt-1 h-11 w-full rounded border px-2 text-[12px]"
              />
            </label>
            <label className="text-[11px] font-semibold text-[var(--color-text-secondary)]">
              年
              <select
                value={year}
                onChange={(event) => setYear(event.target.value)}
                className="mt-1 h-11 w-full rounded border bg-white px-2 text-[12px]"
              >
                <option value="">全年</option>
                {Array.from(
                  { length: Math.max(0, endYear - startYear + 1) },
                  (_, index) => startYear + index,
                ).map((value) => (
                  <option key={value} value={value}>
                    {value}
                  </option>
                ))}
              </select>
            </label>
            <button
              type="button"
              onClick={() => {
                setTicker("");
                setYear("");
                setFavorablePct("5");
                setAdversePct("5");
              }}
              className="min-h-11 rounded border border-[var(--color-border-default)] bg-white px-3 text-[12px] font-semibold sm:col-span-2"
            >
              詳細条件を戻す
            </button>
          </div>
          <p
            id="ticker-help"
            className={classNames(
              "mt-1 text-[11px]",
              tickerInputInvalid
                ? "font-semibold text-red-700"
                : "text-[var(--color-text-muted)]",
            )}
          >
            銘柄コードは英数字・ピリオド・ハイフンの16文字以内。
          </p>
          <p
            id="threshold-help"
            aria-live="polite"
            className={classNames(
              "mt-1 text-[11px]",
              thresholdInputInvalid
                ? "font-semibold text-red-700"
                : "text-[var(--color-text-muted)]",
            )}
          >
            利益側・損失側は0より大きく100以下。詳細だけに適用されます。
          </p>
          <div className="grid grid-cols-2 gap-px bg-[var(--color-border-soft)] sm:grid-cols-4">
            <Metric
              label="詳細観測（率の分母）"
              value={count(detail?.observations)}
              sub={
                detailFiltersApplied
                  ? "銘柄・年・閾値フィルタ適用"
                  : "全銘柄・全年"
              }
            />
            <Metric
              label="詳細MFE中央値"
              value={pct(detail?.mfe.median)}
              sub={`${detailFiltersApplied ? "フィルタ適用 · " : ""}下位四分位(Q25) ${pct(detail?.mfe.q25)}`}
            />
            <Metric
              label="詳細MAE中央値"
              value={pct(detail?.mae.median)}
              sub={`${detailFiltersApplied ? "フィルタ適用 · " : ""}上位四分位(Q75) ${pct(detail?.mae.q75)}`}
            />
            <Metric
              label="逆側先着"
              value={pct(detail?.passage.adverseRate)}
              sub={`未到達 ${count(detail?.passage.neither)}`}
            />
          </div>
          {selected && (
            <p className="mt-2 border-l-2 border-slate-400 pl-2 text-[11px] text-[var(--color-text-secondary)]">
              ランキング側の全母数 {count(selected.populationEvents)}件 = 観測{" "}
              {count(selected.observedEvents)} / Entry欠損{" "}
              {count(selected.missingEntry)} / Invalid{" "}
              {count(selected.invalidPrice)} / 右側打切り{" "}
              {count(selected.rightCensored)}
              。詳細フィルタ後の打切り件数ではありません。
            </p>
          )}
          {!detailLoading && detail?.observations === 0 && (
            <p className="mt-3 border-l-4 border-slate-400 bg-slate-50 px-3 py-2 text-[11px]">
              指定した銘柄・年に該当する観測はありません。
            </p>
          )}
          {endpointOutlierDependent ||
          mfeOutlierDependent ||
          maeOutlierDependent ||
          lowSample ? (
            <div className="mt-3 flex gap-2 border-l-4 border-amber-600 bg-amber-50 px-3 py-2 text-[11px] text-amber-950">
              <AlertTriangle size={15} className="shrink-0" />
              <span>
                {lowSample
                  ? `観測${count(detail?.observations)}件の少数標本です。率の順位だけで判断できません。`
                  : ""}
                {endpointOutlierDependent
                  ? ` 上位1%が絶対変動の${pct(detail?.distribution.topAbs1Contribution, 1)}を占めます。`
                  : ""}
                {mfeOutlierDependent
                  ? ` MFEの上位1%寄与は${pct(detail?.mfe.topAbs1Contribution, 1)}です。`
                  : ""}
                {maeOutlierDependent
                  ? ` MAEの上位1%寄与は${pct(detail?.mae.topAbs1Contribution, 1)}です。`
                  : ""}
                {(endpointOutlierDependent ||
                  mfeOutlierDependent ||
                  maeOutlierDependent) &&
                  " 50%以上を注意表示しており、除外条件ではありません。100件未満では上位1%を最低1件として計算します。"}
              </span>
            </div>
          ) : null}
          {detail?.qualityComparison.flaggedEvents ? (
            <div className="mt-3 border-l-4 border-amber-500 bg-amber-50 px-3 py-2 text-[11px] leading-5 text-amber-950">
              <strong>品質監査flag:</strong>{" "}
              {detail.qualityComparison.flaggedTickers.join(", ")} を
              {count(detail.qualityComparison.flaggedEvents)}件（
              {pct(detail.qualityComparison.flaggedShare, 1)}）含みます。主結果は全件のままです。
              {detail.qualityComparison.reference && (
                <span>
                  {" "}flag除外参考は n=
                  {count(detail.qualityComparison.reference.observations)}、利益側先着
                  {pct(detail.qualityComparison.reference.favorableRate)}、終点中央値
                  {pct(detail.qualityComparison.reference.distribution.median)}。
                </span>
              )}
            </div>
          ) : null}
        </aside>
      </section>

      {detail ? (
        <section className="grid min-w-0 gap-5 border-t border-[var(--color-border-default)] pt-4 xl:grid-cols-2">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <BarChart3 size={16} />
              <h2 className="text-[15px] font-bold">終点リターン分布</h2>
            </div>
            <p className="text-[11px] text-[var(--color-text-secondary)]">
              表示範囲は1〜99パーセンタイル。範囲外も端のビンに含めるため、端ビンは裾の形を表しません。全件数は維持します。
            </p>
            <div
              className="mt-2 h-[280px] border-y py-3"
              role="img"
              aria-label={`${sequenceKey} ${horizon}営業日の終点リターンヒストグラム。観測${count(detail?.observations)}件、中央値${pct(detail?.distribution.median)}。`}
            >
              <ResponsiveContainer width="100%" height="100%">
                <BarChart
                  data={histogram}
                  margin={{ top: 5, right: 10, left: -18, bottom: 0 }}
                >
                  <CartesianGrid
                    strokeDasharray="3 3"
                    vertical={false}
                    stroke="#e5e7eb"
                  />
                  <XAxis
                    dataKey="label"
                    tick={{ fontSize: 9 }}
                    interval={4}
                    unit="%"
                  />
                  <YAxis tick={{ fontSize: 9 }} />
                  <Tooltip
                    formatter={(value) => [
                      `${Number(value).toLocaleString("ja-JP")}件`,
                      "イベント",
                    ]}
                    labelFormatter={(label) => `${label}%付近`}
                  />
                  <Bar dataKey="count" fill="#247b73" />
                </BarChart>
              </ResponsiveContainer>
            </div>
            <details className="mt-2 text-[11px]">
              <summary className="min-h-11 cursor-pointer py-3 font-semibold">
                ヒストグラム数値表
              </summary>
              <div className="max-h-64 overflow-auto">
                <table className="w-full">
                  <thead>
                    <tr>
                      <th scope="col" className="text-left">
                        範囲
                      </th>
                      <th scope="col" className="text-right">
                        件数
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {detail.histogram.map((row, index, rows) => (
                      <tr key={`${row.from}-${row.to}`}>
                        <th
                          scope="row"
                          className="text-left font-mono font-normal"
                        >
                          {index === 0
                            ? `≤ ${(row.to * 100).toFixed(2)}%`
                            : index === rows.length - 1
                              ? `≥ ${(row.from * 100).toFixed(2)}%`
                              : `${(row.from * 100).toFixed(2)}% 〜 ${(row.to * 100).toFixed(2)}%`}
                        </th>
                        <td className="text-right">{count(row.count)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </details>
          </div>
          <div className="min-w-0">
            <h2 className="text-[15px] font-bold">累積分布</h2>
            <p className="text-[11px] text-[var(--color-text-secondary)]">
              全件の分位点を最大101点で表示。101件未満では観測順に対応する分位点で、点間は線形表示です。
            </p>
            <div
              className="mt-2 h-[280px] border-y py-3"
              role="img"
              aria-label={`${sequenceKey} ${horizon}営業日の累積分布。1パーセンタイル${pct(detail?.distribution.q01)}、99パーセンタイル${pct(detail?.distribution.q99)}。`}
            >
              <ResponsiveContainer width="100%" height="100%">
                <LineChart
                  data={cumulative}
                  margin={{ top: 5, right: 12, left: -10, bottom: 0 }}
                >
                  <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
                  <XAxis
                    dataKey="value"
                    type="number"
                    domain={["dataMin", "dataMax"]}
                    tick={{ fontSize: 9 }}
                    unit="%"
                  />
                  <YAxis tick={{ fontSize: 9 }} unit="%" />
                  <Tooltip
                    formatter={(value) => [
                      `${Number(value).toFixed(1)}%`,
                      "累積",
                    ]}
                    labelFormatter={(label) =>
                      `リターン ${Number(label).toFixed(2)}%`
                    }
                  />
                  <Line
                    type="linear"
                    dataKey="cumulative"
                    stroke="#b16a24"
                    strokeWidth={2}
                    dot={false}
                  />
                </LineChart>
              </ResponsiveContainer>
            </div>
            <details className="mt-2 text-[11px]">
              <summary className="min-h-11 cursor-pointer py-3 font-semibold">
                累積分布数値表
              </summary>
              <div className="max-h-64 overflow-auto">
                <table className="w-full">
                  <thead>
                    <tr>
                      <th scope="col" className="text-left">
                        終点リターン
                      </th>
                      <th scope="col" className="text-right">
                        累積
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {detail.cdf.map((row) => (
                      <tr key={`${row.value}-${row.cumulative}`}>
                        <th
                          scope="row"
                          className="text-left font-mono font-normal"
                        >
                          {pct(row.value)}
                        </th>
                        <td className="text-right font-mono">
                          {pct(row.cumulative)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </details>
          </div>
        </section>
      ) : (
        <section className="border-t border-[var(--color-border-default)] py-8 text-center text-[12px] text-[var(--color-text-secondary)]">
          {detailLoading
            ? "分布を集計しています。"
            : "遷移を選択すると分布を表示します。"}
        </section>
      )}

      <section className="border-t border-[var(--color-border-default)] pt-4">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <h2 className="text-[15px] font-bold">
              SMA・物理条件ブレイクダウン
            </h2>
            <p className="text-[11px] text-[var(--color-text-secondary)]">
              prefix-only特徴量を選択パターン内の五分位で集計。成功例だけには限定しません。
            </p>
            <p className="mt-1 text-[10px] text-[var(--color-text-muted)]">
              表は横方向にもスクロールできます。少数=30件未満、高依存=上位1%寄与50%以上の注意表示で、どちらも除外条件ではありません。
            </p>
          </div>
          <label className="text-[11px] font-semibold text-[var(--color-text-secondary)]">
            特徴量
            <select
              disabled={!meta || availableFeatures.length === 0}
              value={feature}
              onChange={(event) => setFeature(event.target.value)}
              className="ml-2 h-11 max-w-[260px] rounded border bg-white px-2 text-[12px] disabled:opacity-50"
            >
              {!meta && (
                <option value={feature}>
                  {metaError ? "特徴量メタデータ読込失敗" : "特徴量を読込中"}
                </option>
              )}
              {availableFeatures.map((value) => (
                <option key={value} value={value}>
                  {FEATURE_LABELS[value] ?? value}
                </option>
              ))}
              {meta && meta.availablePhysicalFeatures.length === 0 && (
                <option disabled>Physical未生成</option>
              )}
            </select>
          </label>
        </div>
        <p className="mt-2 text-[11px] text-[var(--color-text-secondary)]">
          {metaError
            ? "特徴量メタデータを読めないため、SMA/Physicalの利用可否を確認できません。"
            : meta?.availablePhysicalFeatures.length
              ? "raw Momentum/Force/Energyを選択できます。PMS/PFS/PESは未算出です。"
              : "Physical Momentum特徴は未結合です。SMA特徴のみ利用できます。"}
        </p>
        <div className="mt-3 overflow-x-auto">
          <table className="w-full min-w-[1050px] text-left text-[11px]">
            <caption className="sr-only">
              選択特徴量の五分位別価格経路分布
            </caption>
            <thead>
              <tr className="border-y text-[var(--color-text-secondary)]">
                <th scope="col" className="px-2 py-2">
                  区間
                </th>
                <th scope="col" className="px-2 py-2 text-right">
                  件数
                </th>
                <th scope="col" className="px-2 py-2 text-right">
                  利益側先着
                </th>
                <th scope="col" className="px-2 py-2 text-right">
                  割合
                </th>
                <th scope="col" className="px-2 py-2 text-right">
                  終点中央値
                </th>
                <th scope="col" className="px-2 py-2 text-right">
                  MFE中央値
                </th>
                <th scope="col" className="px-2 py-2 text-right">
                  MAE中央値
                </th>
                <th scope="col" className="px-2 py-2 text-right">
                  終点 上位1%
                </th>
                <th scope="col" className="px-2 py-2 text-right">
                  MFE 上位1%
                </th>
                <th scope="col" className="px-2 py-2 text-right">
                  MAE 上位1%
                </th>
              </tr>
            </thead>
            <tbody>
              {detail?.featureBreakdown?.bins.map((row) => (
                <tr key={row.index} className="border-b">
                  <td className="px-2 py-2 font-mono">
                    {row.minimum.toFixed(5)} 〜 {row.maximum.toFixed(5)}
                  </td>
                  <td className="px-2 py-2 text-right">
                    {count(row.observations)}
                    {row.observations < 30 && (
                      <span className="ml-1 text-[10px] font-semibold text-amber-900">
                        少数・参考
                      </span>
                    )}
                  </td>
                  <td className="px-2 py-2 text-right">
                    {count(row.favorable)}
                  </td>
                  <td className="px-2 py-2 text-right font-mono">
                    {pct(row.favorableRate, 1)}
                  </td>
                  <td className="px-2 py-2 text-right font-mono">
                    {pct(row.distribution.median)}
                  </td>
                  <td className="px-2 py-2 text-right font-mono">
                    {pct(row.mfe.median)}
                  </td>
                  <td className="px-2 py-2 text-right font-mono">
                    {pct(row.mae.median)}
                  </td>
                  <td className="px-2 py-2 text-right font-mono">
                    {pct(row.distribution.topAbs1Contribution, 1)}
                    {(row.distribution.topAbs1Contribution ?? 0) >= 0.5 && (
                      <span className="ml-1 text-[10px] font-semibold text-red-800">
                        高依存・参考
                      </span>
                    )}
                  </td>
                  <td className="px-2 py-2 text-right font-mono">
                    {pct(row.mfe.topAbs1Contribution, 1)}
                  </td>
                  <td className="px-2 py-2 text-right font-mono">
                    {pct(row.mae.topAbs1Contribution, 1)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {!detailLoading && detail?.featureBreakdown?.bins.length === 0 && (
            <p className="px-3 py-6 text-center text-[11px] text-[var(--color-text-secondary)]">
              この条件では特徴量の観測がありません。
            </p>
          )}
          {metaError && (
            <div className="flex items-center justify-center gap-2 px-3 py-6 text-[11px] text-red-800">
              <span>特徴量メタデータの読込みエラーです。</span>
              <button
                type="button"
                onClick={() => setMetaReload((value) => value + 1)}
                className="min-h-11 rounded border border-red-300 bg-white px-3 font-semibold"
              >
                特徴量情報を再試行
              </button>
            </div>
          )}
          {!metaError && !sequenceKey && (
            <p className="px-3 py-6 text-center text-[11px] text-[var(--color-text-secondary)]">
              遷移を選択すると特徴量別の分布を表示します。
            </p>
          )}
          {!metaError && sequenceKey && detailError && (
            <p className="px-3 py-6 text-center text-[11px] text-red-800">
              詳細分布を取得できないため、特徴量別集計も表示できません。
            </p>
          )}
          {!detailLoading &&
            detail != null &&
            detail.featureBreakdown == null && (
              <p className="px-3 py-6 text-center text-[11px] text-[var(--color-text-secondary)]">
                選択した特徴量は、この条件では利用できません。
              </p>
            )}
        </div>
        <div className="mt-2 flex flex-wrap gap-3 text-[10px] text-[var(--color-text-muted)]">
          <span>特徴量あり {count(detail?.featureBreakdown?.available)}</span>
          <span>欠損 {count(detail?.featureBreakdown?.missing)}</span>
          <span>SMA5(F1): 未収録</span>
          <span>
            {meta?.availablePhysicalFeatures.length
              ? "raw Momentum/Force/Energy: 結合済み"
              : "Physical Momentum: 未結合"}
          </span>
          <span>PMS/PFS/PES: 未算出</span>
        </div>
      </section>

      <section className="grid gap-5 border-t border-[var(--color-border-default)] pt-4 xl:grid-cols-[1fr_1fr_1.4fr]">
        <div className="min-w-0">
          <h2 className="text-[14px] font-bold">銘柄集中</h2>
          <div className="mt-2 max-h-[260px] overflow-auto border-y">
            <table className="w-full text-[11px]">
              <caption className="sr-only">銘柄別の観測集中</caption>
              <thead>
                <tr className="border-b">
                  <th scope="col" className="px-2 py-1 text-left">
                    銘柄
                  </th>
                  <th scope="col" className="px-2 py-1 text-right">
                    件数
                  </th>
                  <th scope="col" className="px-2 py-1 text-right">
                    割合
                  </th>
                </tr>
              </thead>
              <tbody>
                {detail?.tickerConcentration.map((row) => (
                  <tr key={row.key} className="border-b">
                    <td className="px-2 py-1.5 font-mono">{row.key}</td>
                    <td className="px-2 py-1.5 text-right">
                      {count(row.count)}
                    </td>
                    <td className="px-2 py-1.5 text-right font-mono">
                      {pct(row.share, 1)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
        <div className="min-w-0">
          <h2 className="text-[14px] font-bold">年代集中</h2>
          <div className="mt-2 max-h-[260px] overflow-auto border-y">
            <table className="w-full text-[11px]">
              <caption className="sr-only">年別の観測集中</caption>
              <thead>
                <tr className="border-b">
                  <th scope="col" className="px-2 py-1 text-left">
                    年
                  </th>
                  <th scope="col" className="px-2 py-1 text-right">
                    件数
                  </th>
                  <th scope="col" className="px-2 py-1 text-right">
                    割合
                  </th>
                </tr>
              </thead>
              <tbody>
                {detail?.yearConcentration.map((row) => (
                  <tr key={row.key} className="border-b">
                    <td className="px-2 py-1.5">{row.key}</td>
                    <td className="px-2 py-1.5 text-right">
                      {count(row.count)}
                    </td>
                    <td className="px-2 py-1.5 text-right font-mono">
                      {pct(row.share, 1)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
        <div className="min-w-0">
          <h2 className="text-[14px] font-bold">絶対変動 上位イベント</h2>
          <p className="text-[10px] text-[var(--color-text-muted)]">
            横方向にもスクロールできます。
          </p>
          <div className="mt-2 max-h-[260px] overflow-auto border-y">
            <table className="w-full min-w-[520px] text-[10px]">
              <caption className="sr-only">絶対変動の大きいイベント</caption>
              <thead className="sticky top-0 bg-white">
                <tr className="border-b">
                  <th scope="col" className="px-2 py-1 text-left">
                    銘柄
                  </th>
                  <th scope="col" className="px-2 py-1 text-left">
                    Signal / Entry
                  </th>
                  <th scope="col" className="px-2 py-1 text-right">
                    終点
                  </th>
                  <th scope="col" className="px-2 py-1 text-right">
                    MFE
                  </th>
                  <th scope="col" className="px-2 py-1 text-right">
                    MAE
                  </th>
                  <th scope="col" className="px-2 py-1 text-left">
                    先着 / 日
                  </th>
                </tr>
              </thead>
              <tbody>
                {detail?.outliers.map((row, index) => (
                  <tr
                    key={`${row.ticker}-${row.signalDate}-${index}`}
                    className="border-b"
                  >
                    <td className="px-2 py-1 font-mono">
                      {row.ticker}
                      {row.qualityFlags.length > 0 && (
                        <span className="ml-1 border border-amber-400 bg-amber-50 px-1 py-0.5 text-[11px] font-semibold text-amber-900">
                          品質flag
                        </span>
                      )}
                    </td>
                    <td className="px-2 py-1 font-mono">
                      {row.signalDate}
                      <br />
                      {row.entryDate ?? "Entry欠損"}
                    </td>
                    <td className="px-2 py-1 text-right font-mono">
                      {pct(row.value)}
                    </td>
                    <td className="px-2 py-1 text-right font-mono">
                      {pct(row.mfe)}
                    </td>
                    <td className="px-2 py-1 text-right font-mono">
                      {pct(row.mae)}
                    </td>
                    <td className="px-2 py-1">
                      {(
                        {
                          FAVORABLE: "利益側",
                          ADVERSE: "損失側",
                          SAME_SESSION_UNKNOWN: "同一足不明",
                          NEITHER: "未到達",
                        } as Record<string, string>
                      )[row.first] ?? row.first}
                      <br />
                      {row.favorableDay ?? "—"} / {row.adverseDay ?? "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </section>

      <SixStageAdvancedFeatureDiscovery
        market={market}
        length={length}
        sequenceKey={sequenceKey}
        horizon={horizon}
        direction={direction}
        favorablePct={favorablePct}
        adversePct={adversePct}
        smaFeatures={meta?.availableSmaFeatures ?? []}
        physicalFeatures={meta?.availablePhysicalFeatures ?? []}
      />

      <footer className="border-t border-[var(--color-border-default)] pt-3 text-[11px] leading-5 text-[var(--color-text-muted)]">
        <p>
          Source {meta ? hash(meta.sourceAdoptionSha256) : "—"} · Distribution{" "}
          {meta ? hash(meta.distributionArtifactSha256) : "—"} ·
          OWC固定入力をリクエストごとにハッシュ照合する研究APIです。実行時アクセス監視は未提供です。
        </p>
        <p>
          SMA25〜300は凍結F1、raw Momentum/Force/Energyは採択Sourceのprefix-only派生です。公式PMS/PFS/PESは全市場日次断面が不足するため未算出です。現在銘柄照合は隔離Fixtureのみで、最新Serving接続には別承認が必要です。
        </p>
      </footer>
    </main>
  );
}
