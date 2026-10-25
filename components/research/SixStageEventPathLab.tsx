'use client'

import { useEffect, useMemo, useState } from 'react'
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
} from 'recharts'
import { Database, Gauge, Search, SlidersHorizontal } from 'lucide-react'
import {
  EVENT_PHYSICAL_SIMILARITY_FEATURES,
  EVENT_SMA_SIMILARITY_FEATURES,
  buildAutomaticBreakdown,
  compareEventSimilarity,
  extractObservedTemplate,
  matchesExplicitEventFilters,
  templateToExplicitFilters,
  type EventNumericFeature,
  type EventSimilarityVector,
} from '@/lib/research/six-stage-event-analysis'
import {
  FIXTURE_SEQUENCE_KEYS,
  buildSixStageEventLabFixture,
  type FixtureEvent,
  type FixtureHorizon,
  type FixtureMarket,
} from '@/lib/research/six-stage-event-lab-fixture'
import {
  evaluateFirstPassage,
  summarizeDistribution,
  summarizeFirstPassage,
  type EventResearchDirection,
  type FirstPassageClassification,
} from '@/lib/research/six-stage-event-path-research'

const fixture = buildSixStageEventLabFixture()
const INITIAL_EVENT_ID = fixture.events.find((event) => (
  event.market === 'JP' && event.vector.sequenceKey === FIXTURE_SEQUENCE_KEYS[0]
))?.vector.eventId ?? ''
const INITIAL_CURRENT_ID = fixture.currentCandidates.find((candidate) => candidate.market === 'JP')?.vector.eventId ?? ''
const HORIZONS: FixtureHorizon[] = [5, 10, 15, 20]
const FEATURE_OPTIONS: Array<{ value: EventNumericFeature; label: string }> = [
  { value: 'sma5Angle', label: 'SMA5 角度' },
  { value: 'sma25Angle', label: 'SMA25 角度' },
  { value: 'sma75Angle', label: 'SMA75 角度' },
  { value: 'sma25CloseGap', label: '終値とSMA25の乖離' },
  { value: 'sma25To75Distance', label: 'SMA25/75間距離' },
  { value: 'sma25Curvature', label: 'SMA25 曲率' },
  { value: 'velocity', label: '速度' },
  { value: 'acceleration', label: '加速度' },
  { value: 'momentum', label: 'Momentum' },
  { value: 'force', label: 'Force' },
]
const FEATURE_SCALES = Object.fromEntries([
  ...EVENT_SMA_SIMILARITY_FEATURES.map((feature) => [feature, feature.includes('Angle') ? 20 : feature.includes('Curvature') ? 0.5 : 0.05]),
  ...EVENT_PHYSICAL_SIMILARITY_FEATURES.map((feature) => [feature, 1]),
])

function percent(value: number | null, digits = 1): string {
  return value == null ? '—' : `${value >= 0 ? '+' : ''}${(value * 100).toFixed(digits)}%`
}

function rate(value: number | null, digits = 1): string {
  return value == null ? '—' : `${(value * 100).toFixed(digits)}%`
}

function score(value: number | null): string {
  return value == null ? '—' : `${(value * 100).toFixed(0)}`
}

function directionalValue(event: FixtureEvent, horizon: FixtureHorizon, direction: EventResearchDirection): number {
  const raw = event.closeReturns[horizon]
  return direction === 'LONG' ? raw : -raw
}

function passageFor(event: FixtureEvent, direction: EventResearchDirection, horizon: FixtureHorizon, favorable: number, adverse: number) {
  return evaluateFirstPassage({
    excursions: event.dailyExcursions,
    direction,
    horizonSessions: horizon,
    favorableThreshold: favorable,
    adverseThreshold: adverse,
    termination: 'COMPLETE',
  })
}

function thresholdPercent(value: string, fallback: number): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed >= 0.1 && parsed <= 50 ? parsed : fallback
}

function firstPassageObservation(classification: FirstPassageClassification): boolean | null {
  if (classification === 'INVALID' || classification === 'CENSORED_WITHOUT_DECISION') return null
  return classification === 'FAVORABLE_FIRST' || classification === 'FAVORABLE_ONLY'
}

function histogram(values: readonly number[], bins = 12): Array<{ label: string; count: number; midpoint: number }> {
  if (values.length === 0) return []
  const minimum = Math.min(...values)
  const maximum = Math.max(...values)
  const width = maximum === minimum ? 1 : (maximum - minimum) / bins
  return Array.from({ length: bins }, (_, index) => {
    const lower = minimum + index * width
    const upper = index === bins - 1 ? maximum : lower + width
    const count = values.filter((value) => value >= lower && (index === bins - 1 ? value <= upper : value < upper)).length
    return { label: `${(lower * 100).toFixed(1)}`, count, midpoint: (lower + upper) / 2 }
  })
}

function cdf(values: readonly number[]): Array<{ value: number; cumulative: number }> {
  return [...values].sort((left, right) => left - right).map((value, index, sorted) => ({
    value: value * 100,
    cumulative: ((index + 1) / sorted.length) * 100,
  }))
}

function featureValue(vector: EventSimilarityVector, feature: EventNumericFeature): number | null | undefined {
  return EVENT_SMA_SIMILARITY_FEATURES.includes(feature as never)
    ? vector.sma[feature as keyof EventSimilarityVector['sma']]
    : vector.physical[feature as keyof EventSimilarityVector['physical']]
}

function Metric({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="min-w-0 border-r border-[var(--color-border-soft)] px-4 py-3 last:border-r-0">
      <p className="text-[11px] font-semibold text-[var(--color-text-tertiary)]">{label}</p>
      <p className="mt-1 font-mono text-[19px] font-bold tabular-nums text-[var(--color-text-primary)]">{value}</p>
      {sub ? <p className="mt-1 text-[11px] text-[var(--color-text-secondary)]">{sub}</p> : null}
    </div>
  )
}

function Segment<T extends string | number>({ value, options, onChange, label }: {
  value: T
  options: Array<{ value: T; label: string }>
  onChange: (value: T) => void
  label: string
}) {
  return (
    <fieldset className="min-w-0">
      <legend className="mb-1 text-[11px] font-semibold text-[var(--color-text-secondary)]">{label}</legend>
      <div className="inline-flex max-w-full overflow-x-auto rounded border border-[var(--color-border-default)] bg-white p-0.5">
        {options.map((option) => (
          <button
            type="button"
            key={option.value}
            aria-pressed={value === option.value}
            onClick={() => onChange(option.value)}
            className={`min-h-11 shrink-0 px-3 text-[12px] font-semibold ${value === option.value ? 'bg-[var(--color-brand-700)] text-white' : 'text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-subtle)]'}`}
          >
            {option.label}
          </button>
        ))}
      </div>
    </fieldset>
  )
}

export function SixStageEventPathLab() {
  const [market, setMarket] = useState<FixtureMarket>('JP')
  const [direction, setDirection] = useState<EventResearchDirection>('LONG')
  const [sequenceKey, setSequenceKey] = useState<string>(FIXTURE_SEQUENCE_KEYS[0])
  const [horizon, setHorizon] = useState<FixtureHorizon>(20)
  const [favorableInput, setFavorableInput] = useState('5')
  const [adverseInput, setAdverseInput] = useState('5')
  const [breakdownFeature, setBreakdownFeature] = useState<EventNumericFeature>('sma25Angle')
  const [transitionWeight, setTransitionWeight] = useState(35)
  const [smaWeight, setSmaWeight] = useState(40)
  const [physicalWeight, setPhysicalWeight] = useState(25)
  const [exactTransitionOnly, setExactTransitionOnly] = useState(false)
  const [angleFilterEnabled, setAngleFilterEnabled] = useState(false)
  const [angleMinimum, setAngleMinimum] = useState(-90)
  const [angleMaximum, setAngleMaximum] = useState(90)
  const [baseEventId, setBaseEventId] = useState(INITIAL_EVENT_ID)
  const [currentBaseId, setCurrentBaseId] = useState(INITIAL_CURRENT_ID)

  const favorablePct = thresholdPercent(favorableInput, 5)
  const adversePct = thresholdPercent(adverseInput, 5)
  const events = useMemo(() => fixture.events.filter((event) => (
    event.market === market && event.vector.sequenceKey === sequenceKey
  )), [market, sequenceKey])
  const currentMarketCandidates = useMemo(
    () => fixture.currentCandidates.filter((candidate) => candidate.market === market),
    [market],
  )
  useEffect(() => {
    if (!events.some((event) => event.vector.eventId === baseEventId)) {
      setBaseEventId(events[0]?.vector.eventId ?? '')
    }
  }, [baseEventId, events])
  useEffect(() => {
    if (!currentMarketCandidates.some((candidate) => candidate.vector.eventId === currentBaseId)) {
      setCurrentBaseId(currentMarketCandidates[0]?.vector.eventId ?? '')
    }
  }, [currentBaseId, currentMarketCandidates])
  const passages = useMemo(() => events.map((event) => passageFor(event, direction, horizon, favorablePct / 100, adversePct / 100)), [events, direction, horizon, favorablePct, adversePct])
  const passageSummary = useMemo(() => summarizeFirstPassage(passages), [passages])
  const values = useMemo(() => events.map((event) => directionalValue(event, horizon, direction)), [events, horizon, direction])
  const distribution = useMemo(() => summarizeDistribution(events.map((event) => ({
    ticker: event.vector.ticker,
    signalDate: event.vector.signalDate,
    value: directionalValue(event, horizon, direction),
  }))), [events, horizon, direction])
  const hist = useMemo(() => histogram(values), [values])
  const cumulative = useMemo(() => cdf(values), [values])
  const breakdown = useMemo(() => buildAutomaticBreakdown(events.map((event, index) => ({
    eventId: event.vector.eventId,
    ticker: event.vector.ticker,
    signalDate: event.vector.signalDate,
    vector: event.vector,
    value: directionalValue(event, horizon, direction),
    favorableFirst: firstPassageObservation(passages[index].classification),
  })), breakdownFeature, 5), [events, horizon, direction, passages, breakdownFeature])

  const successfulVectors = useMemo(() => events
    .filter((_, index) => passages[index].classification === 'FAVORABLE_FIRST' || passages[index].classification === 'FAVORABLE_ONLY')
    .map((event) => event.vector), [events, passages])
  const template = useMemo(() => extractObservedTemplate(successfulVectors, [breakdownFeature, 'momentum']), [successfulVectors, breakdownFeature])
  const templateFilters = useMemo(() => templateToExplicitFilters(template), [template])
  const reevaluatedEvents = useMemo(() => successfulVectors.length === 0
    ? []
    : events.filter((event) => matchesExplicitEventFilters(event.vector, templateFilters)), [events, successfulVectors.length, templateFilters])
  const reevaluatedPassages = useMemo(() => reevaluatedEvents.map((event) => passageFor(event, direction, horizon, favorablePct / 100, adversePct / 100)), [reevaluatedEvents, direction, horizon, favorablePct, adversePct])
  const reevaluatedSummary = useMemo(() => summarizeFirstPassage(reevaluatedPassages), [reevaluatedPassages])

  const baseVector = events.find((event) => event.vector.eventId === baseEventId)?.vector ?? null
  const candidates = useMemo(() => !baseVector ? [] : currentMarketCandidates
    .filter((candidate) => matchesExplicitEventFilters(candidate.vector, {
      sma: angleFilterEnabled ? { sma25Angle: { minimum: angleMinimum, maximum: angleMaximum } } : undefined,
    }))
    .map((candidate) => ({
      ...candidate,
      similarity: compareEventSimilarity({
        base: baseVector,
        candidate: candidate.vector,
        scales: FEATURE_SCALES,
        weights: {
          transition: transitionWeight,
          sma: smaWeight,
          physical: physicalWeight,
        },
      }),
    }))
    .sort((left, right) => (right.similarity.combined ?? -1) - (left.similarity.combined ?? -1)), [currentMarketCandidates, angleFilterEnabled, angleMinimum, angleMaximum, baseVector, transitionWeight, smaWeight, physicalWeight])
  const exactCandidates = candidates.filter((candidate) => candidate.vector.sequenceKey === sequenceKey)
  const similarCandidates = candidates.filter((candidate) => candidate.vector.sequenceKey !== sequenceKey)
  const visibleCandidates = exactTransitionOnly ? exactCandidates : candidates
  const currentBase = currentMarketCandidates.find((candidate) => candidate.vector.eventId === currentBaseId) ?? null
  const pastMatches = useMemo(() => !currentBase ? [] : fixture.events
    .filter((event) => event.market === market)
    .filter((event) => matchesExplicitEventFilters(event.vector, {
      sma: angleFilterEnabled ? { sma25Angle: { minimum: angleMinimum, maximum: angleMaximum } } : undefined,
    }))
    .map((event) => ({
      event,
      similarity: compareEventSimilarity({
        base: currentBase.vector,
        candidate: event.vector,
        scales: FEATURE_SCALES,
        weights: {
          transition: transitionWeight,
          sma: smaWeight,
          physical: physicalWeight,
        },
      }),
    }))
    .sort((left, right) => (right.similarity.combined ?? -1) - (left.similarity.combined ?? -1)), [currentBase, market, angleFilterEnabled, angleMinimum, angleMaximum, transitionWeight, smaWeight, physicalWeight])
  const visiblePastMatches = exactTransitionOnly
    ? pastMatches.filter((row) => row.event.vector.sequenceKey === currentBase?.vector.sequenceKey)
    : pastMatches

  const sequenceRanking = useMemo(() => FIXTURE_SEQUENCE_KEYS.map((sequence) => {
    const rows = fixture.events.filter((event) => event.market === market && event.vector.sequenceKey === sequence)
    const rowPassages = rows.map((event) => passageFor(event, direction, horizon, favorablePct / 100, adversePct / 100))
    const summary = summarizeFirstPassage(rowPassages)
    const valuesForSequence = rows.map((event) => directionalValue(event, horizon, direction))
    const stats = summarizeDistribution(rows.map((event) => ({ ticker: event.vector.ticker, signalDate: event.vector.signalDate, value: directionalValue(event, horizon, direction) })))
    const mfe = rows.map((event) => Math.max(...event.dailyExcursions.slice(0, horizon).map((point) => direction === 'LONG' ? point.upReturn : -point.downReturn)))
    const mae = rows.map((event) => Math.min(...event.dailyExcursions.slice(0, horizon).map((point) => direction === 'LONG' ? point.downReturn : -point.upReturn)))
    return {
      sequence,
      samples: rows.length,
      firstRate: summary.favorableFirstRateAllValid,
      median: stats.median,
      medianMfe: summarizeDistribution(mfe.map((value, index) => ({ ticker: rows[index]?.vector.ticker ?? '', signalDate: rows[index]?.vector.signalDate ?? '', value }))).median,
      medianMae: summarizeDistribution(mae.map((value, index) => ({ ticker: rows[index]?.vector.ticker ?? '', signalDate: rows[index]?.vector.signalDate ?? '', value }))).median,
      positive: valuesForSequence.filter((value) => value > 0).length,
    }
  }).sort((left, right) => (right.firstRate ?? -1) - (left.firstRate ?? -1)), [market, direction, horizon, favorablePct, adversePct])

  return (
    <main className="mx-auto flex w-full max-w-[1500px] min-w-0 flex-col gap-5 px-3 py-5 sm:px-5 lg:px-7">
      <header className="flex flex-col gap-3 border-b border-[var(--color-border-default)] pb-4 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <div className="flex flex-wrap items-center gap-2 text-[11px] font-semibold text-[var(--color-text-secondary)]">
            <span className="rounded bg-amber-50 px-2 py-1 text-amber-800">合成Fixture</span>
            <span>Discovery上限 2022-12-30</span>
            <span>現在データ未接続</span>
          </div>
          <h1 className="mt-2 text-2xl font-bold text-[var(--color-text-primary)] sm:text-3xl">6ステージ 経路・SMA・物理状態ラボ</h1>
          <p className="mt-1 max-w-4xl text-[13px] leading-6 text-[var(--color-text-secondary)]">全観測結果を残したまま、値動きの分布、SMA形状、Physical Momentum、現在候補との近さを別々に比較します。順位は観測値であり、採択や売買推奨ではありません。</p>
        </div>
        <div className="flex items-center gap-2 text-[12px] text-[var(--color-text-secondary)]"><Database size={16} aria-hidden /> Production通信 0</div>
      </header>

      <section className="grid gap-3 border-b border-[var(--color-border-default)] pb-4 lg:grid-cols-[auto_auto_minmax(220px,1fr)_auto] lg:items-end" aria-label="研究条件">
        <Segment value={market} onChange={setMarket} label="市場" options={[{ value: 'JP', label: 'JP' }, { value: 'US', label: 'US' }]} />
        <Segment value={direction} onChange={setDirection} label="方向" options={[{ value: 'LONG', label: 'LONG' }, { value: 'SHORT', label: 'SHORT' }]} />
        <label className="min-w-0 text-[11px] font-semibold text-[var(--color-text-secondary)]">
          遷移identity
          <select value={sequenceKey} onChange={(event) => setSequenceKey(event.target.value)} className="mt-1 min-h-11 w-full rounded border border-[var(--color-border-default)] bg-white px-2 text-[13px] text-[var(--color-text-primary)]">
            {FIXTURE_SEQUENCE_KEYS.map((sequence) => <option key={sequence} value={sequence}>{sequence}</option>)}
          </select>
        </label>
        <Segment value={horizon} onChange={setHorizon} label="営業日" options={HORIZONS.map((value) => ({ value, label: `${value}日` }))} />
      </section>

      <section className="grid overflow-hidden rounded border border-[var(--color-border-default)] bg-white sm:grid-cols-2 lg:grid-cols-5" aria-label="主要な観測値">
        <Metric label="対象イベント" value={events.length.toLocaleString('ja-JP')} sub="少数でも非表示にしない" />
        <Metric label={`+${favorablePct}%利益側が先/単独`} value={rate(passageSummary.favorableFirstRateAllValid)} sub={`有効分母 ${passageSummary.validEvents.toLocaleString('ja-JP')}件`} />
        <Metric label="中央値" value={percent(distribution.median)} sub={`平均 ${percent(distribution.mean)}`} />
        <Metric label="上位1%依存" value={rate(distribution.topAbsolute1Contribution)} sub="絶対寄与率 · 最低1件" />
        <Metric label="順序不明" value={passageSummary.sameSessionUnknown.toLocaleString('ja-JP')} sub="同一足で両閾値到達" />
      </section>

      <section className="grid min-w-0 gap-5 xl:grid-cols-2" aria-labelledby="distribution-heading">
        <div className="min-w-0">
          <div className="mb-2 flex flex-wrap items-end justify-between gap-2">
            <div><h2 id="distribution-heading" className="text-[15px] font-bold text-[var(--color-text-primary)]">実績分布</h2><p className="text-[12px] text-[var(--color-text-secondary)]">翌営業日始値基準の方向調整済み終点リターン</p></div>
            <div className="flex gap-2">
              <label className="text-[11px] text-[var(--color-text-secondary)]">利益側 %<input type="number" min="0.1" max="50" step="0.5" value={favorableInput} onChange={(event) => setFavorableInput(event.target.value)} className="ml-1 min-h-11 w-16 rounded border px-2" /></label>
              <label className="text-[11px] text-[var(--color-text-secondary)]">損失側 %<input type="number" min="0.1" max="50" step="0.5" value={adverseInput} onChange={(event) => setAdverseInput(event.target.value)} className="ml-1 min-h-11 w-16 rounded border px-2" /></label>
            </div>
          </div>
          <div className="h-[300px] border-y border-[var(--color-border-soft)] py-3" role="img" aria-label={`${events.length}件の方向調整済み終点リターンのヒストグラム。中央値${percent(distribution.median)}、平均${percent(distribution.mean)}。`}>
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={hist} margin={{ top: 8, right: 8, left: -18, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#e5e7eb" />
                <XAxis dataKey="label" tick={{ fontSize: 10 }} interval={1} unit="%" />
                <YAxis allowDecimals={false} tick={{ fontSize: 10 }} />
                <Tooltip formatter={(value) => [`${value}件`, 'イベント']} labelFormatter={(label) => `${label}%付近`} />
                <Bar dataKey="count" fill="#247b73" radius={[2, 2, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
        <div className="min-w-0">
          <div className="mb-2"><h2 className="text-[15px] font-bold text-[var(--color-text-primary)]">累積分布</h2><p className="text-[12px] text-[var(--color-text-secondary)]">平均だけでなく裾と外れ値を確認</p></div>
          <div className="h-[300px] border-y border-[var(--color-border-soft)] py-3" role="img" aria-label={`${events.length}件の方向調整済み終点リターンの累積分布。中央値${percent(distribution.median)}。`}>
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={cumulative} margin={{ top: 8, right: 12, left: -10, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
                <XAxis dataKey="value" type="number" domain={['dataMin', 'dataMax']} tick={{ fontSize: 10 }} unit="%" />
                <YAxis tick={{ fontSize: 10 }} unit="%" />
                <Tooltip formatter={(value) => [`${Number(value).toFixed(1)}%`, '累積']} labelFormatter={(label) => `リターン ${Number(label).toFixed(1)}%`} />
                <Line type="monotone" dataKey="cumulative" stroke="#b16a24" strokeWidth={2} dot={false} />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </div>
      </section>

      <section className="min-w-0 border-t border-[var(--color-border-default)] pt-4" aria-labelledby="breakdown-heading">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
          <div><h2 id="breakdown-heading" className="text-[15px] font-bold text-[var(--color-text-primary)]">SMA・物理特徴の自動ブレイクダウン</h2><p className="text-[12px] text-[var(--color-text-secondary)]">データ分位点で区間を作成。全区間を表示し、境界は後から変更できます。</p></div>
          <label className="text-[11px] font-semibold text-[var(--color-text-secondary)]">特徴量<select value={breakdownFeature} onChange={(event) => setBreakdownFeature(event.target.value as EventNumericFeature)} className="ml-2 min-h-11 rounded border border-[var(--color-border-default)] bg-white px-2 text-[13px]">{FEATURE_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>
        </div>
        <div className="mt-3 overflow-x-auto">
          <table className="w-full min-w-[760px] border-collapse text-left text-[12px]">
            <thead><tr className="border-y border-[var(--color-border-default)] text-[var(--color-text-secondary)]"><th className="px-3 py-2">自動区間</th><th className="px-3 py-2 text-right">全件</th><th className="px-3 py-2 text-right">有効分母</th><th className="px-3 py-2 text-right">利益側が先/単独</th><th className="px-3 py-2 text-right">割合</th><th className="px-3 py-2 text-right">中央値</th><th className="px-3 py-2 text-right">平均</th><th className="px-3 py-2 text-right">上位1%依存</th></tr></thead>
            <tbody>{breakdown.map((row) => <tr key={row.bin.index} className="border-b border-[var(--color-border-soft)]"><td className="px-3 py-2 font-mono">{row.bin.minimum.toFixed(3)} 〜 {row.bin.maximum.toFixed(3)}</td><td className="px-3 py-2 text-right">{row.observations}</td><td className="px-3 py-2 text-right">{row.favorableFirstKnown}</td><td className="px-3 py-2 text-right">{row.favorableFirstCount}</td><td className="px-3 py-2 text-right font-mono">{rate(row.favorableFirstRate)}</td><td className="px-3 py-2 text-right font-mono">{percent(row.distribution.median)}</td><td className="px-3 py-2 text-right font-mono">{percent(row.distribution.mean)}</td><td className="px-3 py-2 text-right font-mono">{rate(row.distribution.topAbsolute1Contribution)}</td></tr>)}</tbody>
          </table>
        </div>
        <div className="mt-3 grid gap-3 border-l-4 border-amber-600 bg-amber-50 px-4 py-3 text-[12px] text-amber-950 md:grid-cols-[1fr_auto] md:items-center">
          {successfulVectors.length > 0 ? <>
            <p><strong>全件への戻し集計:</strong> 利益側が先/単独の例 {successfulVectors.length}件から中央50%の条件を抽出し、成功・失敗を含む全{events.length}件へ再適用しました。同じ母集団内の探索的・選択バイアスを含む参考値で、予測検証ではありません。</p>
            <p className="font-mono font-semibold">一致 {reevaluatedEvents.length}件 · 割合 {rate(reevaluatedSummary.favorableFirstRateAllValid)}</p>
          </> : <p><strong>条件抽出なし:</strong> 現在の条件では利益側が先/単独の例が0件のため、空条件を全件へ適用していません。</p>}
        </div>
      </section>

      <section className="min-w-0 border-t border-[var(--color-border-default)] pt-4" aria-labelledby="ranking-heading">
        <div className="flex items-center gap-2"><Gauge size={17} aria-hidden /><h2 id="ranking-heading" className="text-[15px] font-bold text-[var(--color-text-primary)]">全遷移ランキング</h2></div>
        <p className="mt-1 text-[12px] text-[var(--color-text-secondary)]">少数・非有意・マイナスも保持。現在は+{favorablePct}%利益側が先/単独の割合順です。</p>
        <div className="mt-3 overflow-x-auto">
          <table className="w-full min-w-[780px] text-left text-[12px]"><thead><tr className="border-y"><th className="px-3 py-2">順位</th><th className="px-3 py-2">遷移</th><th className="px-3 py-2 text-right">母数</th><th className="px-3 py-2 text-right">利益側が先/単独</th><th className="px-3 py-2 text-right">中央値</th><th className="px-3 py-2 text-right">MFE中央値</th><th className="px-3 py-2 text-right">MAE中央値</th><th className="px-3 py-2 text-right">プラス件数</th></tr></thead><tbody>{sequenceRanking.map((row, index) => <tr key={row.sequence} className="border-b"><td className="px-3 py-2 font-mono">{index + 1}</td><td className="px-3 py-2 font-mono font-semibold">{row.sequence}</td><td className="px-3 py-2 text-right">{row.samples}</td><td className="px-3 py-2 text-right font-mono">{rate(row.firstRate)}</td><td className="px-3 py-2 text-right font-mono">{percent(row.median)}</td><td className="px-3 py-2 text-right font-mono">{percent(row.medianMfe)}</td><td className="px-3 py-2 text-right font-mono">{percent(row.medianMae)}</td><td className="px-3 py-2 text-right">{row.positive}</td></tr>)}</tbody></table>
        </div>
      </section>

      <section className="min-w-0 border-t border-[var(--color-border-default)] pt-4" aria-labelledby="candidate-heading">
        <div className="flex items-center gap-2">
          <Search size={17} aria-hidden />
          <h2 id="candidate-heading" className="text-[15px] font-bold text-[var(--color-text-primary)]">現在候補との双方向類似検索</h2>
        </div>
        <p className="mt-1 text-[12px] text-[var(--color-text-secondary)]">
          現在側も過去側も合成Fixtureです。類似度は固定尺度による近さであり、確率や推奨ではありません。
        </p>

        <div className="mt-3 grid gap-4 border-y border-[var(--color-border-default)] py-4 lg:grid-cols-2">
          <label className="text-[12px] font-semibold">
            過去→現在の比較基準イベント
            <select value={baseEventId} onChange={(event) => setBaseEventId(event.target.value)} className="mt-1 min-h-11 w-full border bg-white px-2 font-mono">
              {events.map((event) => <option key={event.vector.eventId} value={event.vector.eventId}>{event.vector.ticker} / {event.vector.signalDate}</option>)}
            </select>
          </label>
          <label className="text-[12px] font-semibold">
            現在→過去の比較基準銘柄
            <select value={currentBaseId} onChange={(event) => setCurrentBaseId(event.target.value)} className="mt-1 min-h-11 w-full border bg-white px-2">
              {currentMarketCandidates.map((candidate) => <option key={candidate.vector.eventId} value={candidate.vector.eventId}>{candidate.vector.ticker} / {candidate.companyName}</option>)}
            </select>
          </label>
          <div>
            <div className="flex items-center gap-2 text-[12px] font-bold"><SlidersHorizontal size={15} aria-hidden /> 類似度の重み</div>
            <div className="mt-2 grid gap-3 sm:grid-cols-3">
              {[
                ['遷移', transitionWeight, setTransitionWeight],
                ['SMA形状', smaWeight, setSmaWeight],
                ['Physical', physicalWeight, setPhysicalWeight],
              ].map(([label, value, setter]) => <label key={label as string} className="text-[11px] text-[var(--color-text-secondary)]"><span className="flex justify-between"><b>{label as string}</b><span>{value as number}</span></span><input className="min-h-11 w-full accent-[var(--color-brand-700)]" type="range" min="0" max="100" value={value as number} aria-valuetext={`${label} ${value}`} onChange={(event) => (setter as (value: number) => void)(Number(event.target.value))} /></label>)}
            </div>
          </div>
          <div>
            <p className="text-[12px] font-bold">明示フィルター</p>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <label className="flex min-h-11 items-center gap-2 text-[11px]"><input type="checkbox" checked={angleFilterEnabled} onChange={(event) => setAngleFilterEnabled(event.target.checked)} /> SMA25角度を絞る</label>
              <label className="text-[11px]">下限<input disabled={!angleFilterEnabled} className="ml-1 min-h-11 w-20 border px-2 disabled:bg-gray-100" type="number" min="-90" max="90" value={angleMinimum} onChange={(event) => setAngleMinimum(Math.max(-90, Math.min(90, Number(event.target.value))))} /></label>
              <label className="text-[11px]">上限<input disabled={!angleFilterEnabled} className="ml-1 min-h-11 w-20 border px-2 disabled:bg-gray-100" type="number" min="-90" max="90" value={angleMaximum} onChange={(event) => setAngleMaximum(Math.max(-90, Math.min(90, Number(event.target.value))))} /></label>
            </div>
            {angleFilterEnabled && angleMinimum > angleMaximum && <p role="alert" className="mt-1 text-[11px] font-semibold text-red-700">下限は上限以下にしてください。</p>}
            {transitionWeight + smaWeight + physicalWeight === 0 && <p role="alert" className="mt-1 text-[11px] font-semibold text-red-700">少なくとも1レイヤーに重みが必要です。</p>}
          </div>
        </div>

        <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-[12px]">
          <span>完全一致 {exactCandidates.length}件 / 類似 {similarCandidates.length}件</span>
          <label className="flex min-h-11 items-center gap-2 font-semibold"><input type="checkbox" checked={exactTransitionOnly} onChange={(event) => setExactTransitionOnly(event.target.checked)} /> 完全一致tierだけ表示</label>
        </div>
        <div className="mt-2 overflow-x-auto">
          <table className="w-full min-w-[1050px] text-left text-[12px]">
            <caption className="sr-only">過去イベントから現在Fixture候補への類似検索</caption>
            <thead><tr className="border-y"><th scope="col" className="px-3 py-2">tier</th><th scope="col" className="px-3 py-2">銘柄</th><th scope="col" className="px-3 py-2">現在遷移</th><th scope="col" className="px-3 py-2 text-right">総合</th><th scope="col" className="px-3 py-2 text-right">遷移 score / coverage</th><th scope="col" className="px-3 py-2 text-right">SMA score / coverage</th><th scope="col" className="px-3 py-2 text-right">Physical score / coverage</th></tr></thead>
            <tbody>{visibleCandidates.map((candidate) => <tr key={candidate.vector.eventId} className="border-b"><td className="px-3 py-2 font-semibold">{candidate.vector.sequenceKey === sequenceKey ? '完全一致' : '類似'}</td><td className="px-3 py-2"><strong>FIXTURE {candidate.vector.ticker}</strong><span className="ml-2 text-[var(--color-text-tertiary)]">{candidate.companyName}</span></td><td className="px-3 py-2 font-mono">{candidate.vector.sequenceKey}</td><td className="px-3 py-2 text-right font-mono font-bold">{score(candidate.similarity.combined)}</td><td className="px-3 py-2 text-right font-mono">{score(candidate.similarity.transition.score)} / {score(candidate.similarity.transition.coverage)}</td><td className="px-3 py-2 text-right font-mono">{score(candidate.similarity.sma.score)} / {score(candidate.similarity.sma.coverage)}</td><td className="px-3 py-2 text-right font-mono">{score(candidate.similarity.physical.score)} / {score(candidate.similarity.physical.coverage)}</td></tr>)}</tbody>
          </table>
        </div>

        <h3 className="mt-5 text-[13px] font-bold">現在Fixture銘柄 → 過去Fixtureイベント</h3>
        <p className="mt-1 text-[11px] text-[var(--color-text-muted)]">完全一致 {pastMatches.filter((row) => row.event.vector.sequenceKey === currentBase?.vector.sequenceKey).length}件 / 類似 {pastMatches.filter((row) => row.event.vector.sequenceKey !== currentBase?.vector.sequenceKey).length}件。全件を保持し、上の明示フィルターとtier表示を両方向へ適用します。</p>
        <div className="mt-2 max-h-[460px] overflow-auto border-y">
          <table className="w-full min-w-[1050px] text-left text-[12px]">
            <caption className="sr-only">現在Fixture銘柄から過去Fixtureイベントへの類似検索</caption>
            <thead className="sticky top-0 bg-white"><tr className="border-b"><th scope="col" className="px-3 py-2">tier</th><th scope="col" className="px-3 py-2">過去イベント</th><th scope="col" className="px-3 py-2">遷移</th><th scope="col" className="px-3 py-2 text-right">総合</th><th scope="col" className="px-3 py-2 text-right">遷移 / coverage</th><th scope="col" className="px-3 py-2 text-right">SMA / coverage</th><th scope="col" className="px-3 py-2 text-right">Physical / coverage</th></tr></thead>
            <tbody>{visiblePastMatches.map(({ event, similarity }) => <tr key={event.vector.eventId} className="border-b"><td className="px-3 py-2 font-semibold">{event.vector.sequenceKey === currentBase?.vector.sequenceKey ? '完全一致' : '類似'}</td><td className="px-3 py-2 font-mono">FIXTURE {event.vector.ticker} / {event.vector.signalDate}</td><td className="px-3 py-2 font-mono">{event.vector.sequenceKey}</td><td className="px-3 py-2 text-right font-mono font-bold">{score(similarity.combined)}</td><td className="px-3 py-2 text-right font-mono">{score(similarity.transition.score)} / {score(similarity.transition.coverage)}</td><td className="px-3 py-2 text-right font-mono">{score(similarity.sma.score)} / {score(similarity.sma.coverage)}</td><td className="px-3 py-2 text-right font-mono">{score(similarity.physical.score)} / {score(similarity.physical.coverage)}</td></tr>)}</tbody>
          </table>
        </div>
      </section>

      <footer className="border-t border-[var(--color-border-default)] pt-3 text-[11px] leading-5 text-[var(--color-text-tertiary)]">
        合成Fixtureのため現在銘柄・類似イベントとも実市場データではありません。過去のDiscovery Storeは別画面の固定入力として採択済みですが、現在銘柄Servingは未接続です。Validation/HoldoutおよびProductionには接続しません。
      </footer>
    </main>
  )
}
