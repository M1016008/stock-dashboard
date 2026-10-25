"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, FlaskConical, RefreshCw } from "lucide-react";

type Market = "JP" | "US";
type Direction = "LONG" | "SHORT";

type Summary = {
  count: number;
  median: number | null;
  q25: number | null;
  q75: number | null;
  topAbs1Contribution: number | null;
};

type ObservationSummary = {
  observations: number;
  favorable: number;
  adverse: number;
  sameSessionUnknown: number;
  neither: number;
  favorableRate: number | null;
  adverseRate: number | null;
  distribution: Summary;
  mfe: Summary;
  mae: Summary;
};

type QualityComparison = {
  primary: ObservationSummary;
  flaggedEvents: number;
  flaggedShare: number | null;
  flaggedTickers: string[];
  reference: ObservationSummary | null;
  policy: string;
};

type Discovery = {
  requestedBins: number;
  features: { featureA: string; featureB: string };
  ranges: {
    featureA: Array<{ index: number; minimum: number; maximum: number }>;
    featureB: Array<{ index: number; minimum: number; maximum: number }>;
  };
  observations: number;
  completeFeaturePairs: number;
  missingFeaturePairs: number;
  overall: QualityComparison;
  cells: Array<
    ObservationSummary & {
      featureABin: { index: number; minimum: number; maximum: number };
      featureBBin: { index: number; minimum: number; maximum: number };
      qualityComparison: QualityComparison;
    }
  >;
  pitEvidence: {
    featureKeyJoin: string;
    sma: string;
    physical: string;
    futureOutcomeColumnsUsedAsFeatures: number;
  };
};

const API = "/api/research/six-stage/event-paths";

const LABELS: Record<string, string> = {
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
  physicalMa5Angle: "prefix MA5角度",
  physicalMa25Angle: "prefix MA25角度",
  physicalMa75Angle: "prefix MA75角度",
  physicalMa200Angle: "prefix MA200角度",
  physicalMaAngleAverage: "物理 MA角度平均",
};

function percent(value: number | null | undefined, digits = 2): string {
  return value == null || !Number.isFinite(value)
    ? "—"
    : `${(value * 100).toFixed(digits)}%`;
}

function number(value: number): string {
  return value.toLocaleString("ja-JP");
}

function rangeLabel(range: { minimum: number; maximum: number }): string {
  return `${range.minimum.toPrecision(4)} ～ ${range.maximum.toPrecision(4)}`;
}

async function getDiscovery(
  params: URLSearchParams,
  signal: AbortSignal,
): Promise<Discovery> {
  const response = await fetch(`${API}?${params}`, {
    signal,
    cache: "no-store",
  });
  const payload = (await response.json()) as Discovery | { error?: string };
  if (!response.ok) {
    throw new Error("error" in payload && payload.error ? payload.error : "探索結果を取得できません");
  }
  return payload as Discovery;
}

export function SixStageAdvancedFeatureDiscovery({
  market,
  length,
  sequenceKey,
  horizon,
  direction,
  favorablePct,
  adversePct,
  smaFeatures,
  physicalFeatures,
}: {
  market: Market;
  length: 2 | 3;
  sequenceKey: string;
  horizon: 5 | 10 | 15 | 20;
  direction: Direction;
  favorablePct: string;
  adversePct: string;
  smaFeatures: string[];
  physicalFeatures: string[];
}) {
  const [featureA, setFeatureA] = useState("sma25Angle");
  const [featureB, setFeatureB] = useState("momentum");
  const [bins, setBins] = useState(5);
  const [applied, setApplied] = useState<{
    market: Market;
    length: 2 | 3;
    sequenceKey: string;
    horizon: 5 | 10 | 15 | 20;
    direction: Direction;
    favorablePct: string;
    adversePct: string;
    featureA: string;
    featureB: string;
    bins: number;
  } | null>(null);
  const [result, setResult] = useState<Discovery | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const appliedMatchesCurrent = applied != null &&
    applied.market === market &&
    applied.length === length &&
    applied.sequenceKey === sequenceKey &&
    applied.horizon === horizon &&
    applied.direction === direction &&
    applied.favorablePct === favorablePct &&
    applied.adversePct === adversePct &&
    applied.featureA === featureA &&
    applied.featureB === featureB &&
    applied.bins === bins;

  useEffect(() => {
    if (!smaFeatures.includes(featureA) && smaFeatures.length) {
      setFeatureA(smaFeatures[0]);
    }
  }, [featureA, smaFeatures]);
  useEffect(() => {
    if (!physicalFeatures.includes(featureB) && physicalFeatures.length) {
      setFeatureB(physicalFeatures[0]);
    }
  }, [featureB, physicalFeatures]);
  useEffect(() => {
    if (applied && !appliedMatchesCurrent) {
      setApplied(null);
      setResult(null);
      setError(null);
      setLoading(false);
    }
  }, [applied, appliedMatchesCurrent]);

  useEffect(() => {
    if (!applied) return;
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    const params = new URLSearchParams({
      view: "feature-discovery",
      market: applied.market,
      length: String(applied.length),
      sequenceKey: applied.sequenceKey,
      horizon: String(applied.horizon),
      direction: applied.direction,
      favorablePct: applied.favorablePct,
      adversePct: applied.adversePct,
      featureA: applied.featureA,
      featureB: applied.featureB,
      bins: String(applied.bins),
    });
    getDiscovery(params, controller.signal)
      .then(setResult)
      .catch((reason) => {
        if (!controller.signal.aborted) {
          setResult(null);
          setError(reason instanceof Error ? reason.message : "探索結果を取得できません");
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [applied]);

  const canApply =
    sequenceKey !== "" &&
    featureA !== featureB &&
    smaFeatures.includes(featureA) &&
    physicalFeatures.includes(featureB) &&
    Number(favorablePct) > 0 &&
    Number(adversePct) > 0;
  const collapsedBins = useMemo(
    () =>
      result != null &&
      (result.ranges.featureA.length < result.requestedBins ||
        result.ranges.featureB.length < result.requestedBins),
    [result],
  );

  return (
    <section className="min-w-0 border-y border-[var(--color-border-default)] py-5">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
        <div className="min-w-0">
          <h2 className="text-[16px] font-bold">SMA × Physical Momentum 自動ブレイクダウン</h2>
          <p className="mt-1 max-w-4xl text-[12px] leading-5 text-[var(--color-text-secondary)]">
            選択した遷移の観測母集団から量子化境界を生成し、全セルを表示します。探索セル数と母数を残し、最良セルの自動採択は行いません。
          </p>
        </div>
        <Link
          href="/dev/six-stage-event-matching"
          className="inline-flex min-h-11 shrink-0 items-center justify-center gap-2 border border-[var(--color-border-default)] px-3 text-[12px] font-semibold hover:bg-[var(--color-surface-subtle)]"
        >
          <FlaskConical className="h-4 w-4" aria-hidden="true" />
          現在銘柄照合Fixture
        </Link>
      </div>

      <div className="mt-4 grid min-w-0 gap-3 sm:grid-cols-2 lg:grid-cols-[1fr_1fr_150px_auto]">
        <label className="min-w-0 text-[12px] font-semibold">
          SMA特徴
          <select
            value={featureA}
            onChange={(event) => setFeatureA(event.target.value)}
            className="mt-1 min-h-11 w-full border border-[var(--color-border-default)] bg-white px-2"
          >
            {smaFeatures.map((key) => (
              <option key={key} value={key}>{LABELS[key] ?? key}</option>
            ))}
          </select>
        </label>
        <label className="min-w-0 text-[12px] font-semibold">
          物理特徴
          <select
            value={featureB}
            onChange={(event) => setFeatureB(event.target.value)}
            className="mt-1 min-h-11 w-full border border-[var(--color-border-default)] bg-white px-2"
          >
            {physicalFeatures.map((key) => (
              <option key={key} value={key}>{LABELS[key] ?? key}</option>
            ))}
          </select>
        </label>
        <label className="text-[12px] font-semibold">
          各軸の分位数
          <input
            type="number"
            min={2}
            max={10}
            value={bins}
            onChange={(event) => setBins(Math.max(2, Math.min(10, Number(event.target.value) || 2)))}
            className="mt-1 min-h-11 w-full border border-[var(--color-border-default)] px-2"
          />
        </label>
        <button
          type="button"
          disabled={!canApply || loading}
          onClick={() =>
            setApplied({ market, length, sequenceKey, horizon, direction, favorablePct, adversePct, featureA, featureB, bins })
          }
          className="mt-auto inline-flex min-h-11 items-center justify-center gap-2 bg-[var(--color-brand-700)] px-4 text-[12px] font-bold text-white disabled:cursor-not-allowed disabled:opacity-50"
        >
          <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} aria-hidden="true" />
          適用
        </button>
      </div>

      {!sequenceKey && (
        <p className="mt-3 text-[12px] text-[var(--color-text-muted)]">上のランキングから遷移を1件選択してください。</p>
      )}
      {error && (
        <p role="alert" className="mt-3 flex items-center gap-2 border border-red-300 bg-red-50 px-3 py-2 text-[12px] text-red-800">
          <AlertTriangle className="h-4 w-4" aria-hidden="true" />{error}
        </p>
      )}
      {result && (
        <>
          {applied && (
            <p className="mt-4 border-l-4 border-teal-700 bg-teal-50 px-3 py-2 text-[12px] text-teal-950">
              <strong>適用済み条件:</strong> {applied.market} · {applied.length}状態 · {applied.sequenceKey} · {applied.direction} · H{applied.horizon} · 利益/損失 {applied.favorablePct}%/{applied.adversePct}% · {LABELS[applied.featureA] ?? applied.featureA} × {LABELS[applied.featureB] ?? applied.featureB} · {applied.bins}分位
            </p>
          )}
          <div className="mt-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-4" aria-live="polite">
            <div className="border-l-2 border-teal-600 pl-3"><div className="text-[11px] text-[var(--color-text-muted)]">対象観測</div><div className="font-mono text-[15px] font-bold">{number(result.observations)}</div></div>
            <div className="border-l-2 border-teal-600 pl-3"><div className="text-[11px] text-[var(--color-text-muted)]">特徴ペア利用可能</div><div className="font-mono text-[15px] font-bold">{number(result.completeFeaturePairs)}</div></div>
            <div className="border-l-2 border-amber-500 pl-3"><div className="text-[11px] text-[var(--color-text-muted)]">特徴ペア欠損</div><div className="font-mono text-[15px] font-bold">{number(result.missingFeaturePairs)}</div></div>
            <div className="border-l-2 border-slate-500 pl-3"><div className="text-[11px] text-[var(--color-text-muted)]">検査セル</div><div className="font-mono text-[15px] font-bold">{number(result.cells.length)}</div></div>
          </div>

          <div className="mt-3 flex flex-wrap gap-2 text-[11px]">
            <span className="border border-slate-300 px-2 py-1">境界: この母集団の分位点</span>
            <span className="border border-slate-300 px-2 py-1">SMA {result.ranges.featureA.length}/{result.requestedBins} bins</span>
            <span className="border border-slate-300 px-2 py-1">物理 {result.ranges.featureB.length}/{result.requestedBins} bins</span>
            {collapsedBins && <span className="border border-amber-400 bg-amber-50 px-2 py-1 text-amber-900">同値境界を統合</span>}
            {result.overall.flaggedEvents > 0 && <span className="border border-amber-400 bg-amber-50 px-2 py-1 text-amber-900">品質監査対象 {number(result.overall.flaggedEvents)}件</span>}
          </div>

          <div className="mt-4 hidden max-h-[620px] overflow-auto border-y lg:block">
            <table className="w-full min-w-[1100px] text-[11px]">
              <caption className="sr-only">SMAと物理特徴量の組み合わせ別実績</caption>
              <thead className="sticky top-0 bg-white">
                <tr className="border-b">
                  <th scope="col" className="sticky left-0 bg-white px-2 py-2 text-left">SMA区間</th>
                  <th scope="col" className="px-2 py-2 text-left">物理区間</th>
                  <th scope="col" className="px-2 py-2 text-right">n</th>
                  <th scope="col" className="px-2 py-2 text-right">利益側先着</th>
                  <th scope="col" className="px-2 py-2 text-right">終点中央値</th>
                  <th scope="col" className="px-2 py-2 text-right">MFE中央値</th>
                  <th scope="col" className="px-2 py-2 text-right">MAE中央値</th>
                  <th scope="col" className="px-2 py-2 text-right">品質flag</th>
                  <th scope="col" className="px-2 py-2 text-right">flag除外参考</th>
                </tr>
              </thead>
              <tbody>
                {result.cells.map((cell) => (
                  <tr key={`${cell.featureABin.index}:${cell.featureBBin.index}`} className="border-b">
                    <td className="sticky left-0 bg-white px-2 py-2 font-mono">{rangeLabel(cell.featureABin)}</td>
                    <td className="px-2 py-2 font-mono">{rangeLabel(cell.featureBBin)}</td>
                    <td className="px-2 py-2 text-right font-mono">{number(cell.observations)}</td>
                    <td className="px-2 py-2 text-right font-mono">{percent(cell.favorableRate)}</td>
                    <td className="px-2 py-2 text-right font-mono">{percent(cell.distribution.median)}</td>
                    <td className="px-2 py-2 text-right font-mono">{percent(cell.mfe.median)}</td>
                    <td className="px-2 py-2 text-right font-mono">{percent(cell.mae.median)}</td>
                    <td className="px-2 py-2 text-right font-mono">{number(cell.qualityComparison.flaggedEvents)}</td>
                    <td className="px-2 py-2 text-right font-mono">{cell.qualityComparison.reference ? `${percent(cell.qualityComparison.reference.favorableRate)} (n=${number(cell.qualityComparison.reference.observations)})` : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="mt-4 grid gap-2 lg:hidden">
            {result.cells.map((cell) => (
              <article key={`${cell.featureABin.index}:${cell.featureBBin.index}`} className="border border-[var(--color-border-default)] p-3 text-[12px]">
                <div className="font-mono font-semibold">{rangeLabel(cell.featureABin)}</div>
                <div className="mt-1 font-mono text-[var(--color-text-secondary)]">× {rangeLabel(cell.featureBBin)}</div>
                <div className="mt-2 grid grid-cols-2 gap-2">
                  <span>n {number(cell.observations)}</span><span>先着 {percent(cell.favorableRate)}</span>
                  <span>中央値 {percent(cell.distribution.median)}</span><span>MFE {percent(cell.mfe.median)}</span>
                </div>
                <details className="mt-2 border-t pt-2">
                  <summary className="min-h-11 cursor-pointer py-3 font-semibold">品質・参考分布</summary>
                  <p>MAE {percent(cell.mae.median)} · 品質flag {number(cell.qualityComparison.flaggedEvents)}</p>
                  <p>flag除外参考 {cell.qualityComparison.reference ? `${percent(cell.qualityComparison.reference.favorableRate)} (n=${number(cell.qualityComparison.reference.observations)})` : "—"}</p>
                </details>
              </article>
            ))}
          </div>

          <p className="mt-3 text-[11px] leading-5 text-[var(--color-text-muted)]">
            品質除外はZXZZT・ABVC・IVTの監査済みフラグだけを使う参考比較です。主結果は全イベントを保持します。SMA/物理特徴はsignal時点のfeature_keyで結合し、Outcome列を特徴量に使用していません。
          </p>
        </>
      )}
    </section>
  );
}
