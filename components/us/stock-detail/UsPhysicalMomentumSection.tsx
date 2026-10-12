'use client'

import { useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { ChevronRight } from 'lucide-react'
import {
  buildPhysicalMomentumView,
  buildPhysicalRawMetricView,
} from '@/lib/physical-momentum-view'
import { physicalPlanDirectionLabel, physicalPlanStatisticsLabel } from '@/lib/physical-plan'
import { selectPhysicalMomentumScoreRow } from '@/lib/stock-decision-summary'
import { ScoreThresholdBar } from './ScoreThresholdBar'
import {
  buildMaFieldInsight,
  directionLabelJa,
  fmtLift,
  fmtPct,
  fmtRate,
  fmtScore,
  fmtUsd,
  formatDelta,
  PHYSICAL_BOUNDARIES,
  PHYSICAL_FORCE_THRESHOLD,
  PHYSICAL_STRONG_PMS,
  physicalToneColor,
  previousMomentumRow,
  scoreLevelLabel,
  scoreTone,
  tradePlanToneColor,
  trendArrow,
  trendLabelFromDelta,
  trendText,
  type MaFieldInsight,
  type UsPhysicalMomentumResponse,
  type UsPhysicalMomentumRow,
  type UsPhysicalMomentumTimeframeView,
  type UsPhysicalPlanHorizon,
  type UsPhysicalPlanLevel,
  type UsPhysicalPlanResponse,
} from './technical-view'
import type { UsPhysicalMomentumState } from './useUsPhysicalMomentum'

const CAVEAT_CLASS = 'mb-3 grid gap-1 rounded-[4px] border border-amber-300 bg-amber-50 px-3 py-2 text-[12px] font-medium leading-5 text-amber-900'

export function UsPhysicalMomentumSection({
  ticker,
  analysisDate,
  momentum,
}: {
  ticker: string
  analysisDate: string | null
  /** 親で取得済みの physical-momentum 応答(概要タブと共有。ここでは再取得しない) */
  momentum: UsPhysicalMomentumState
}) {
  const [plan, setPlan] = useState<UsPhysicalPlanResponse | null>(null)
  const [planLoading, setPlanLoading] = useState(true)
  const [planError, setPlanError] = useState('')
  const [mobilePlanOpen, setMobilePlanOpen] = useState(false)

  useEffect(() => {
    let cancelled = false
    setPlan(null)
    setPlanLoading(true)
    setPlanError('')
    setMobilePlanOpen(false)
    const params = new URLSearchParams({ market: 'US' })
    if (analysisDate) params.set('date', analysisDate)
    fetch(`/api/stock-physical-plan/${encodeURIComponent(ticker)}?${params.toString()}`, { cache: 'no-store' })
      .then((res) => res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`)))
      .then((payload: UsPhysicalPlanResponse) => {
        if (!cancelled) setPlan(payload)
      })
      .catch((e) => {
        if (!cancelled) setPlanError(e instanceof Error ? e.message : String(e))
      })
      .finally(() => {
        if (!cancelled) setPlanLoading(false)
      })
    return () => { cancelled = true }
  }, [ticker, analysisDate])

  const data = momentum.data
  const latest = data?.latest ?? null
  const momentumHistoryCount = data?.history?.length ?? 0
  const isMomentumCoverageSparse = momentumHistoryCount < 20
  const isMomentumScoreStale = Boolean(latest && data?.isScoreFresh === false && data?.scoreSource !== 'runtime_raw')
  const fieldInsight = latest ? buildMaFieldInsight(latest, previousMomentumRow(data)) : null
  const scoreRow = latest && data
    ? selectPhysicalMomentumScoreRow({
      latest,
      history: data.history ?? [],
      latestScoredDate: data.latestScoredDate,
      isScoreFresh: data.isScoreFresh,
    }).scoreRow
    : null
  const velocityMetric = buildPhysicalRawMetricView('velocity', latest?.velocity)
  const accelerationMetric = buildPhysicalRawMetricView('acceleration', latest?.acceleration)
  const forceMetric = buildPhysicalRawMetricView('force', latest?.force)

  // 読み順: 運動状態(結論) → 時間軸の整合 → PMS推移・内訳(根拠) → 観察プラン(条件)
  return (
    <section className="card p-3 sm:p-4" aria-labelledby="us-physical-momentum-title">
      <header className="mb-3 flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
        <h2 id="us-physical-momentum-title" className="m-0 text-[14px] font-bold text-[var(--color-text-primary)]">Physical Momentum</h2>
        <span className="text-[11px] font-medium text-[var(--color-text-tertiary)]">
          方向(PFS)・強さ(PMS)・熱量(PES)を、時間軸ごとに並べた運動状態です。予測ではありません。
        </span>
        {latest && (
          <span className="ml-auto font-mono text-[11px] font-medium tabular-nums text-[var(--color-text-tertiary)]">基準 {latest.date}</span>
        )}
      </header>

      {momentum.status === 'idle' || momentum.status === 'loading' ? (
        <p className="m-0 text-[12px] font-medium text-[var(--color-text-tertiary)]" role="status">PMSを読み込んでいます…</p>
      ) : momentum.status === 'error' ? (
        <p className="m-0 text-[12px] font-medium text-[var(--price-down)]" role="alert">PMSを取得できませんでした: {momentum.error}</p>
      ) : !latest ? (
        <p className="m-0 text-[12px] font-medium text-[var(--color-text-tertiary)]">このUS銘柄のPMSはまだ算出されていません。</p>
      ) : (
        <>
          {isMomentumCoverageSparse && (
            <div className={CAVEAT_CLASS}>
              <strong className="font-bold">結論は保留中</strong>
              <span>
                PMS履歴が{momentumHistoryCount}営業日分のため、PMS/PFS/PESを結論として扱わず、チャート・MA・ステージを優先して読んでください。
              </span>
            </div>
          )}
          {isMomentumScoreStale && (
            <div className={CAVEAT_CLASS}>
              <strong className="font-bold">最新スコアの標準化が未完了</strong>
              <span>
                価格・生の運動量は{latest.date}までありますが、PMS/PFS/PESの標準化済みスコアは
                {data?.latestScoredDate ? `${data.latestScoredDate}まで` : 'まだありません'}。古い日付のスコアを最新として扱っていません。
              </span>
            </div>
          )}
          {!isMomentumCoverageSparse && (
            <PhysicalStateSummary
              scoreRow={scoreRow}
              history={data?.history ?? []}
              rank={data?.rank ?? null}
              total={data?.totalRanked ?? 0}
              trend={data?.trend ?? null}
              field={fieldInsight}
            />
          )}

          <PhysicalTimeframeConclusionPanel views={data?.timeframeViews ?? []} />

          <PhysicalMomentumSparkline
            history={data?.history ?? []}
            breakdown={(
              <div className="min-w-0">
                <div className="mb-1 flex flex-wrap items-baseline gap-x-2">
                  <strong className="text-[12px] font-bold text-[var(--color-text-primary)]">内訳</strong>
                  <span className="text-[11px] font-medium text-[var(--color-text-tertiary)]">日足の生の運動量(市場内の強弱はPMS/PFS/PES)</span>
                </div>
                <div className="divide-y divide-[var(--color-border-soft)]">
                  <PhysicalBreakdown label={velocityMetric.label} help={velocityMetric.detail} value={velocityMetric.value} tone={latest.velocity} />
                  <PhysicalBreakdown label={accelerationMetric.label} help={accelerationMetric.detail} value={accelerationMetric.value} tone={latest.acceleration} />
                  <PhysicalBreakdown label={forceMetric.label} help={forceMetric.detail} value={forceMetric.value} tone={latest.force} />
                </div>
              </div>
            )}
          />
        </>
      )}

      {/* 観察プランは PMS の有無と独立した API なので、PMS が無くても表示する */}
      <button
        type="button"
        className="mb-2 mt-3 inline-flex min-h-11 w-full items-center justify-between rounded-[4px] border border-[var(--color-border-default)] bg-white px-3 text-left text-[12px] font-bold text-[var(--color-text-primary)] sm:hidden"
        onClick={() => setMobilePlanOpen((open) => !open)}
        aria-expanded={mobilePlanOpen}
        aria-controls="us-physical-plan"
      >
        <span>観察プラン(短期・中期・長期)</span>
        <ChevronRight size={15} className={`transition-transform ${mobilePlanOpen ? 'rotate-90' : ''}`} aria-hidden="true" />
      </button>
      <div id="us-physical-plan" className={`${mobilePlanOpen ? 'block' : 'hidden'} mt-3 sm:block`}>
        <PhysicalTradePlanRows loading={planLoading} error={planError} plan={plan} analysisDate={analysisDate} />
      </div>
    </section>
  )
}

/** 日足の結論 → 根拠 → 変化点 を示す。数値はAPI値と既存の判定関数の出力のみ */
function PhysicalStateSummary({
  scoreRow,
  history,
  rank,
  total,
  trend,
  field,
}: {
  scoreRow: UsPhysicalMomentumRow | null
  history: UsPhysicalMomentumRow[]
  rank: number | null
  total: number
  trend: UsPhysicalMomentumResponse['trend']
  field: MaFieldInsight | null
}) {
  const view = buildPhysicalMomentumView({
    pms: scoreRow?.physicalMomentumScore,
    pfs: scoreRow?.physicalForceScore,
    pes: scoreRow?.physicalEnergyScore,
    trend,
    rank,
    total,
    fieldLabel: field?.label,
  })
  const color = physicalToneColor(view.tone)
  // PMS推移チャートの「20日変化」と同じ取り方(スコアのある行の20本前との差)
  const scored = history.filter((row) => row.physicalMomentumScore != null && Number.isFinite(row.physicalMomentumScore))
  const last = scored.at(-1)?.physicalMomentumScore ?? null
  const before20 = scored.length >= 21 ? scored[scored.length - 21].physicalMomentumScore : null
  const delta20 = last != null && before20 != null ? last - before20 : null
  // 算出窓が違う2つの向きが食い違うときは、どちらかを選ばず相反として並べる
  const trendDisagrees = delta20 != null && ((trend === 'rising' && delta20 < 0) || (trend === 'falling' && delta20 > 0))
  const details: Array<{ label: string; value: ReactNode; title?: string }> = [
    ...(rank && total
      ? [{ label: 'PMS 市場内', value: <>{rank.toLocaleString('en-US')}/{total.toLocaleString('en-US')}位</> }]
      : []),
    {
      label: '直近の向き',
      title: 'APIが判定するPMSの直近の向き',
      value: <>{trendArrow(trend)} {trendText(trend)}</>,
    },
    ...(delta20 != null
      ? [{
        label: '20日変化',
        title: 'PMSの20本前との差(PMS推移グラフと同じ取り方)',
        value: <span style={{ color: scoreTone(delta20) }}>{formatDelta(delta20)}</span>,
      }]
      : []),
  ]
  return (
    <section
      className="mb-3 grid gap-x-5 gap-y-1.5 rounded-[var(--radius-card)] border border-[var(--color-border-default)] bg-white px-3 py-2 md:grid-cols-[minmax(260px,1.3fr)_minmax(0,1fr)]"
      aria-label="日足の運動状態"
      data-physical-state
    >
      <div className="min-w-0">
        <div className="text-[11px] font-bold text-[var(--color-text-tertiary)]">運動状態(日足・20営業日)</div>
        <strong className="mt-0.5 block text-[15px] font-bold leading-tight [text-wrap:pretty]" style={{ color }}>{view.label}</strong>
        <p className="m-0 mt-1 text-[12px] font-medium leading-5 text-[var(--color-text-secondary)] [text-wrap:pretty]">{view.summary}</p>
      </div>
      <dl className="m-0 flex min-w-0 flex-wrap content-start items-baseline gap-x-5 gap-y-1">
        {details.map((item) => (
          <div key={item.label} className="flex items-baseline gap-1.5" title={item.title}>
            <dt className="text-[11px] font-medium text-[var(--color-text-tertiary)]">{item.label}</dt>
            <dd className="m-0 font-mono text-[13px] font-bold tabular-nums text-[var(--color-text-primary)]">{item.value}</dd>
          </div>
        ))}
        {trendDisagrees && (
          <div className="flex items-baseline">
            <dt className="sr-only">注意</dt>
            <dd
              className="m-0 border border-dashed border-[var(--color-text-secondary)] px-1 text-[11px] font-bold leading-4 text-[var(--color-text-primary)]"
              title="直近の向き(API判定)と20日変化(20本前との差)は算出窓が異なり、向きが食い違っています"
            >相反(窓が異なる)</dd>
          </div>
        )}
      </dl>
    </section>
  )
}

function PhysicalTimeframeConclusionPanel({ views }: { views: UsPhysicalMomentumTimeframeView[] }) {
  if (views.length === 0) return null
  const forceUp = views.filter((view) => (view.physicalForceScore ?? 0) >= PHYSICAL_FORCE_THRESHOLD).length
  const forceDown = views.filter((view) => (view.physicalForceScore ?? 0) <= -PHYSICAL_FORCE_THRESHOLD).length
  const strong = views.filter((view) => (view.physicalMomentumScore ?? 0) >= PHYSICAL_STRONG_PMS).length
  const weak = views.filter((view) => (view.physicalMomentumScore ?? 0) <= -PHYSICAL_STRONG_PMS).length
  const alignment = forceUp === views.length
    ? 'すべての時間軸で上向き'
    : forceDown === views.length
      ? 'すべての時間軸で下向き'
      : forceUp > 0 && forceDown > 0
        ? '時間軸で向きが分かれる'
        : forceUp > 0 || forceDown > 0
          ? '一部の時間軸だけに向き'
          : 'どの時間軸も向きは中立'

  return (
    <section className="mb-3 min-w-0 overflow-hidden rounded-[var(--radius-card)] border border-[var(--color-border-default)] bg-white" aria-labelledby="us-physical-timeframe-title">
      <header className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 border-b border-[var(--color-border-soft)] px-3 py-2">
        <h3 id="us-physical-timeframe-title" className="m-0 text-[12px] font-bold text-[var(--color-text-primary)]">時間軸の整合 <span className="font-medium text-[var(--color-text-secondary)]">{alignment}</span></h3>
        <span className="font-mono text-[11px] font-medium tabular-nums text-[var(--color-text-tertiary)]">
          方向PFS ▲{forceUp} ▼{forceDown} ・ 強さPMS 強{strong} 弱{weak} / {views.length}
        </span>
      </header>
      <div className="hidden grid-cols-[6rem_minmax(8rem,1.2fr)_repeat(3,minmax(0,1fr))] gap-x-3 border-b border-[var(--color-border-soft)] px-3 py-1 text-[11px] font-bold text-[var(--color-text-tertiary)] sm:grid">
        <span>時間軸</span>
        <span>判定・PMS推移</span>
        <span>PMS 強さ</span>
        <span>PFS 方向</span>
        <span>PES 熱量</span>
      </div>
      <div className="divide-y divide-[var(--color-border-soft)]">
        {views.map((view) => (
          <PhysicalTimeframeRow key={view.interval} view={view} />
        ))}
      </div>
      <p className="m-0 border-t border-[var(--color-border-soft)] px-3 py-1 text-[11px] font-medium leading-4 text-[var(--color-text-tertiary)]">
        日足=US市場比較、他=銘柄内比較。行どうしの数値は直接比べません ・ 縦線=判定の境界
      </p>
    </section>
  )
}

function PhysicalTimeframeRow({ view }: { view: UsPhysicalMomentumTimeframeView }) {
  const built = buildPhysicalMomentumView({
    pms: view.physicalMomentumScore,
    pfs: view.physicalForceScore,
    pes: view.physicalEnergyScore,
    trend: view.trend,
  })
  const color = physicalToneColor(built.tone)
  const isPrimary = view.interval === 'D'
  return (
    <div
      className={`grid grid-cols-[6rem_minmax(0,1fr)] items-center gap-x-3 gap-y-1 px-3 py-1.5 sm:grid-cols-[6rem_minmax(8rem,1.2fr)_repeat(3,minmax(0,1fr))] ${isPrimary ? 'bg-[var(--color-surface-subtle)] shadow-[inset_3px_0_0_var(--color-brand-900)]' : ''}`}
      data-physical-timeframe={view.interval}
      title={`${view.label} ${view.basis} ${view.latestDate ?? ''} ${view.scoreSource === 'market_z' ? '市場比較' : '時間軸内比較'}`}
    >
      <span className="min-w-0">
        <span className="block whitespace-nowrap text-[12px] font-bold text-[var(--color-text-primary)]">{view.label}</span>
        <span className="block text-[11px] font-medium text-[var(--color-text-tertiary)]">{view.scoreSource === 'market_z' ? '市場比較' : '銘柄内'}</span>
      </span>
      <span className="min-w-0">
        <strong className="block text-[12px] font-bold leading-tight" style={{ color }}>{built.label}</strong>
        <span className="block text-[11px] font-medium text-[var(--color-text-tertiary)]">PMS {trendArrow(view.trend)} {trendText(view.trend)}</span>
      </span>
      {/* 狭い画面は3スコアを縦に積み、バーに十分な幅を渡す。sm以上は表の列 */}
      <span className="col-span-2 grid gap-y-0.5 sm:contents">
        {([
          ['PMS', view.physicalMomentumScore],
          ['PFS', view.physicalForceScore],
          ['PES', view.physicalEnergyScore],
        ] as const).map(([code, value]) => (
          <span key={code} className="grid min-w-0 grid-cols-[2rem_minmax(0,1fr)] items-center gap-x-2 sm:block">
            <span className="text-[11px] font-bold text-[var(--color-text-tertiary)] sm:hidden">{code}</span>
            <ScoreThresholdBar
              label={`${view.label} ${code}`}
              value={value}
              text={formatDelta(value)}
              neutral={code === 'PES'}
              marks={PHYSICAL_BOUNDARIES.find((item) => item.code === code)?.marks ?? []}
            />
          </span>
        ))}
      </span>
    </div>
  )
}

function PhysicalBreakdown({ label, help, value, tone }: { label: string; help: string; value: string; tone?: number | null }) {
  const color = tone == null || !Number.isFinite(tone) ? 'var(--text-primary)' : tone >= 0 ? 'var(--price-up)' : 'var(--price-down)'
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_auto] items-baseline gap-x-3 py-1.5">
      <span className="text-[12px] font-bold text-[var(--color-text-secondary)]">{label}</span>
      <strong className="text-right font-mono text-[13px] font-bold tabular-nums" style={{ color }}>{value}</strong>
      <small className="col-span-2 text-[11px] font-medium leading-4 text-[var(--color-text-tertiary)]">{help}</small>
    </div>
  )
}

function PhysicalTrendChip({ label, value, tone, note }: { label: string; value: string; tone: number | null | undefined; note?: string }) {
  const color = tone == null || !Number.isFinite(tone) ? 'var(--text-primary)' : tone >= 0 ? 'var(--price-up)' : 'var(--price-down)'
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-x-3 py-1.5" title={note}>
      <dt className="text-[12px] font-bold text-[var(--color-text-secondary)]">{label}</dt>
      <dd className="m-0 font-mono text-[13px] font-bold tabular-nums" style={{ color }}>{value}</dd>
      {note && <dd className="m-0 basis-full text-[11px] font-medium leading-4 text-[var(--color-text-tertiary)]">{note}</dd>}
    </div>
  )
}

/** PMS推移(左)と、変化・内訳(右)を1枚にまとめる。高さは内容なり */
function PhysicalMomentumSparkline({ history, breakdown }: { history: UsPhysicalMomentumRow[]; breakdown: ReactNode }) {
  // SVGは実寸(px)で描き、軸ラベルの11pxを画面幅によらず保つ
  const [plotBox, setPlotBox] = useState<HTMLDivElement | null>(null)
  const [plotWidth, setPlotWidth] = useState(520)
  useEffect(() => {
    if (!plotBox) return
    const measure = () => setPlotWidth(Math.max(260, Math.round(plotBox.clientWidth)))
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(plotBox)
    return () => observer.disconnect()
  }, [plotBox])
  const chart = useMemo(() => {
    const points = history
      .filter((row) => row.physicalMomentumScore != null && Number.isFinite(row.physicalMomentumScore))
      .slice(-160)
    if (points.length === 0) return null
    const scoreMin = -2.5
    const scoreMax = 2.5
    const width = plotWidth
    const height = 184
    const pad = { left: 40, right: 58, top: 18, bottom: 26 }
    const innerWidth = width - pad.left - pad.right
    const innerHeight = height - pad.top - pad.bottom
    const yFor = (value: number) => {
      const clipped = Math.max(scoreMin, Math.min(scoreMax, value))
      return pad.top + ((scoreMax - clipped) / (scoreMax - scoreMin)) * innerHeight
    }
    const xFor = (index: number) => pad.left + (points.length === 1 ? innerWidth : (index / (points.length - 1)) * innerWidth)
    const polyline = points
      .map((row, index) => `${xFor(index).toFixed(1)},${yFor(row.physicalMomentumScore as number).toFixed(1)}`)
      .join(' ')
    const latestScore = points[points.length - 1].physicalMomentumScore as number
    const firstScore = points[0].physicalMomentumScore as number
    const point20 = points.length >= 21 ? points[points.length - 21] : null
    const point60 = points.length >= 61 ? points[points.length - 61] : null
    return {
      points,
      polyline,
      width,
      height,
      pad,
      innerWidth,
      innerHeight,
      yFor,
      latestScore,
      firstDate: points[0].date,
      lastDate: points[points.length - 1].date,
      latestX: xFor(points.length - 1),
      latestY: yFor(latestScore),
      deltaAll: latestScore - firstScore,
      delta20: point20?.physicalMomentumScore == null ? null : latestScore - point20.physicalMomentumScore,
      delta60: point60?.physicalMomentumScore == null ? null : latestScore - point60.physicalMomentumScore,
    }
  }, [history, plotWidth])

  if (!chart) {
    return (
      <section className="mb-3 rounded-[var(--radius-card)] border border-[var(--color-border-default)] bg-white p-3" aria-label="PMS推移と内訳">
        <div className="grid items-start gap-3 lg:grid-cols-[minmax(0,1.7fr)_minmax(0,1fr)]">
          <p className="m-0 rounded-[4px] border border-[var(--color-border-soft)] p-3 text-center text-[12px] font-medium text-[var(--color-text-tertiary)]">PMS時系列はまだありません。</p>
          {breakdown}
        </div>
      </section>
    )
  }

  const sparse = chart.points.length < 20
  const directionDelta = chart.delta20 ?? chart.delta60 ?? chart.deltaAll
  const latestTone = chart.latestScore >= 0 ? 'var(--price-up)' : 'var(--price-down)'
  const latestLabelX = chart.latestX > chart.width - 96 ? chart.latestX - 92 : chart.latestX + 8
  const latestLabelAnchor = chart.latestX > chart.width - 96 ? 'end' : 'start'

  return (
    <section className="mb-3 rounded-[var(--radius-card)] border border-[var(--color-border-default)] bg-white p-3" aria-label="PMS推移と内訳">
      <div className="grid items-start gap-x-5 gap-y-3 lg:grid-cols-[minmax(0,1.7fr)_minmax(0,1fr)]">
        <div className="min-w-0" ref={setPlotBox}>
          <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
            <div>
              <strong className="text-[12px] font-bold text-[var(--color-text-primary)]">PMS推移</strong>
              <small className="mt-0.5 block text-[11px] font-medium text-[var(--color-text-tertiary)]">固定スケールでUS市場平均との差を表示</small>
            </div>
            <span className="font-mono text-[11px] tabular-nums text-[var(--color-text-tertiary)]">{chart.firstDate} → {chart.lastDate}</span>
          </div>
          {sparse ? (
            <div className="rounded-[4px] border border-[var(--color-border-soft)] p-2.5">
              <div className="grid gap-1 text-[12px] leading-5 text-[var(--color-text-secondary)]">
                <strong style={{ color: latestTone }}>{scoreLevelLabel(chart.latestScore)}</strong>
                <span>PMS履歴が{chart.points.length}営業日分のため推移としては読めません。最新値と直近変化を中心に見てください。</span>
              </div>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {chart.points.map((point) => {
                  const score = point.physicalMomentumScore ?? 0
                  return (
                    <span
                      key={point.date}
                      className="rounded-full border px-2 py-0.5 font-mono text-[11px] font-bold tabular-nums"
                      style={{
                        background: score >= 0 ? 'rgba(220, 38, 38, 0.12)' : 'rgba(37, 99, 235, 0.12)',
                        color: score >= 0 ? 'var(--price-up)' : 'var(--price-down)',
                        borderColor: score >= 0 ? 'rgba(220, 38, 38, 0.28)' : 'rgba(37, 99, 235, 0.28)',
                      }}
                      title={point.date}
                    >
                      {fmtScore(score)}
                    </span>
                  )
                })}
              </div>
            </div>
          ) : (
            <svg viewBox={`0 0 ${chart.width} ${chart.height}`} role="img" aria-label={`PMS時系列チャート ${chart.firstDate}から${chart.lastDate}、最新${fmtScore(chart.latestScore)}`} className="block h-[184px] w-full rounded-[4px] border border-[var(--color-border-soft)] bg-white">
              <rect x={chart.pad.left} y={chart.pad.top} width={chart.innerWidth} height={chart.yFor(1) - chart.pad.top} fill="rgba(220, 38, 38, 0.07)" rx="4" />
              <rect x={chart.pad.left} y={chart.yFor(-1)} width={chart.innerWidth} height={chart.pad.top + chart.innerHeight - chart.yFor(-1)} fill="rgba(37, 99, 235, 0.07)" rx="4" />
              {[-2, -1, 0, 1, 2].map((line) => (
                <g key={line}>
                  <line
                    x1={chart.pad.left}
                    x2={chart.pad.left + chart.innerWidth}
                    y1={chart.yFor(line)}
                    y2={chart.yFor(line)}
                    stroke={line === 0 ? 'var(--text-muted)' : 'var(--border-subtle)'}
                    strokeDasharray={line === 0 ? '4 4' : undefined}
                    opacity={line === 0 ? 0.62 : 0.8}
                  />
                  <text x={chart.pad.left - 8} y={chart.yFor(line) + 3} textAnchor="end" fontSize="11" fill="var(--text-muted)" fontFamily="var(--font-mono)">
                    {line > 0 ? `+${line}` : line}
                  </text>
                </g>
              ))}
              <polyline points={chart.polyline} fill="none" stroke={latestTone} strokeWidth="3" strokeLinejoin="round" strokeLinecap="round" />
              <circle cx={chart.latestX} cy={chart.latestY} r="4.8" fill="#fff" stroke={latestTone} strokeWidth="2.6" />
              <text x={latestLabelX} y={Math.max(16, chart.latestY - 7)} textAnchor={latestLabelAnchor} fontSize="12" fontWeight="800" fill={latestTone} fontFamily="var(--font-mono)">
                {fmtScore(chart.latestScore)}
              </text>
              <text x={chart.pad.left} y={chart.height - 5} fontSize="11" fill="var(--text-muted)" fontFamily="var(--font-mono)">{chart.firstDate}</text>
              <text x={chart.pad.left + chart.innerWidth} y={chart.height - 5} textAnchor="end" fontSize="11" fill="var(--text-muted)" fontFamily="var(--font-mono)">{chart.lastDate}</text>
            </svg>
          )}
          <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1 text-[11px] leading-snug text-[var(--color-text-tertiary)]">
            <span><i className="mr-1 inline-block h-[9px] w-[9px] rounded-[2px] align-[-1px]" style={{ background: 'rgba(220, 38, 38, 0.16)' }} />+1以上: 市場より強い</span>
            <span><i className="mr-1 inline-block h-[9px] w-[9px] rounded-[2px] align-[-1px]" style={{ background: 'rgba(37, 99, 235, 0.16)' }} />-1以下: 市場より弱い</span>
            <span><i className="mr-1 inline-block h-[9px] w-[9px] rounded-[2px] align-[-1px]" style={{ background: 'var(--text-muted)' }} />0: 市場平均</span>
          </div>
        </div>
        <div className="min-w-0 space-y-2">
          <dl className="m-0 divide-y divide-[var(--color-border-soft)] border-y border-[var(--color-border-soft)]">
            <PhysicalTrendChip label="全期間" value={formatDelta(chart.deltaAll)} tone={chart.deltaAll} />
            <PhysicalTrendChip
              label="直近方向"
              value={trendLabelFromDelta(directionDelta)}
              tone={directionDelta}
              note={`${chart.delta20 != null ? '20日変化' : chart.delta60 != null ? '60日変化' : '全期間'}が±0.35を超えるかで判定`}
            />
          </dl>
          {breakdown}
        </div>
      </div>
    </section>
  )
}

function PhysicalTradePlanRows({
  loading,
  error,
  plan,
  analysisDate,
}: {
  loading: boolean
  error: string
  plan: UsPhysicalPlanResponse | null
  analysisDate: string | null
}) {
  const panelClass = 'min-w-0 rounded-[var(--radius-card)] border border-[var(--color-border-default)] bg-white'
  const headerClass = 'flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 px-3 py-2'
  const titleClass = 'm-0 text-[12px] font-bold text-[var(--color-text-primary)]'
  const metaClass = 'text-[11px] font-medium text-[var(--color-text-tertiary)]'

  if (loading) {
    return (
      <section className={panelClass} aria-label="観察プラン" aria-busy="true">
        <div className={headerClass}>
          <h3 className={titleClass}>短期・中期・長期の観察プラン</h3>
          <span className={metaClass} role="status">統計と物理MLを確認中…</span>
        </div>
        <div className="divide-y divide-[var(--color-border-soft)] border-t border-[var(--color-border-soft)]">
          {[0, 1, 2, 3].map((index) => (
            <div key={index} className="h-11 animate-pulse bg-[var(--color-surface-subtle)]/60" />
          ))}
        </div>
      </section>
    )
  }

  if (error) {
    return (
      <section className={panelClass} aria-label="観察プラン">
        <div className={headerClass}>
          <h3 className={titleClass}>短期・中期・長期の観察プラン</h3>
          <span className="text-[11px] font-medium text-[var(--price-down)]" role="alert">取得できませんでした: {error}</span>
        </div>
      </section>
    )
  }

  if (!plan?.available || plan.horizons.length === 0) {
    return (
      <section className={panelClass} aria-label="観察プラン">
        <div className={headerClass}>
          <h3 className={titleClass}>短期・中期・長期の観察プラン</h3>
        </div>
        <p className="m-0 border-t border-[var(--color-border-soft)] px-3 py-2 text-[12px] font-medium text-[var(--color-text-tertiary)]">観察プランに必要な特徴量がまだありません。</p>
      </section>
    )
  }

  return (
    <section className={panelClass} aria-label="観察プラン">
      <div className={headerClass}>
        <h3 className={titleClass}>短期・中期・長期の観察プラン</h3>
        <span className={`${metaClass} font-mono tabular-nums`}>
          特徴量 {plan.featureAsOfDate ?? '-'} ・ 価格 {plan.priceAsOfDate ?? '-'}{analysisDate ? ` ・ ${analysisDate}時点で再構成` : ''}
        </span>
      </div>
      <div className="divide-y divide-[var(--color-border-soft)] border-t border-[var(--color-border-soft)]">
        {plan.horizons.map((horizon) => (
          <PhysicalTradePlanRow key={`${horizon.label}-${horizon.horizonDays}`} horizon={horizon} />
        ))}
      </div>
      <p className="m-0 border-t border-[var(--color-border-soft)] px-3 py-2 text-[11px] font-medium leading-4 text-[var(--color-text-tertiary)]">
        現在の形状と過去検証統計から作る観察メモです。売買を断定するものではありません。
      </p>
    </section>
  )
}

function PhysicalTradePlanRow({ horizon }: { horizon: UsPhysicalPlanHorizon }) {
  const toneColor = tradePlanToneColor(horizon.suggestion.tone)
  const topCandidates = horizon.candidates
    .slice()
    .sort((a, b) => a.rank - b.rank)
    .slice(0, 3)
  const decision = horizon.suggestion.decision
  const levels = horizon.levels
  const liftMark = horizon.lift == null || !Number.isFinite(horizon.lift) ? '' : horizon.lift >= 1 ? '▲' : '▼'
  const [open, setOpen] = useState(false)
  const detailsId = `us-physical-plan-detail-${horizon.horizonDays}`
  const chipClass = 'border border-[var(--color-border-soft)] px-1.5'
  // 狭い画面は縦積み / sm: 左に期間・右に内容 / lg: 期間・結論と構造・統計・価格の4列 + 下段に条件(全幅)
  return (
    <article className="min-w-0 px-3 py-2" style={{ boxShadow: `inset 3px 0 0 ${toneColor}` }}>
      <div className="grid gap-x-4 gap-y-1.5 sm:grid-cols-[6rem_minmax(0,1fr)] lg:grid-cols-[6rem_minmax(0,1.5fr)_minmax(0,.9fr)_minmax(0,1.3fr)]">
        <div className="flex items-baseline gap-2 sm:col-start-1 sm:row-span-4 sm:row-start-1 sm:block lg:col-start-1 lg:row-span-2 lg:row-start-1">
          <span className="block text-[12px] font-bold text-[var(--color-text-primary)]">{horizon.label}</span>
          <span className="font-mono text-[11px] font-medium tabular-nums text-[var(--color-text-tertiary)]">{horizon.horizonDays}営業日</span>
        </div>
        <div className="min-w-0 sm:col-start-2 sm:row-start-1 lg:col-start-2">
          <strong className="block text-[14px] font-bold leading-snug [text-wrap:pretty]" style={{ color: toneColor }}>{horizon.suggestion.headline}</strong>
          <div className="mt-1 flex flex-wrap items-baseline gap-x-2 gap-y-1 text-[11px] font-semibold text-[var(--color-text-secondary)]">
            <span className={chipClass}>構造 {physicalPlanDirectionLabel(decision.structureDirection)}</span>
            <span className={chipClass}>PMS/PFS {physicalPlanDirectionLabel(decision.momentumDirection)}</span>
            {decision.candidateDirection !== 'wait' && (
              <span className={chipClass}>物理ML {physicalPlanDirectionLabel(decision.candidateDirection)}</span>
            )}
            <span className={chipClass}>{physicalPlanStatisticsLabel(decision.statisticsQuality)}</span>
          </div>
        </div>
        <dl className="m-0 flex flex-wrap gap-x-4 gap-y-0.5 text-[12px] sm:col-start-2 sm:row-start-2 lg:col-start-3 lg:row-start-1 lg:grid lg:grid-cols-1 lg:content-start">
          <div className="flex items-baseline justify-between gap-2">
            <dt className="text-[11px] font-medium text-[var(--color-text-tertiary)]">的中率(同状態)</dt>
            <dd className="m-0 font-mono font-bold tabular-nums text-[var(--color-text-primary)]">{fmtRate(horizon.hitRate)}</dd>
          </div>
          <div className="flex items-baseline justify-between gap-2">
            <dt className="text-[11px] font-medium text-[var(--color-text-tertiary)]">基準率(市場全体)</dt>
            <dd className="m-0 font-mono font-bold tabular-nums text-[var(--color-text-primary)]">{fmtRate(horizon.baseRate)}</dd>
          </div>
          <div className="flex items-baseline justify-between gap-2">
            <dt className="text-[11px] font-medium text-[var(--color-text-tertiary)]">Lift ・ 信頼 {horizon.confidenceLabel}</dt>
            <dd className="m-0 font-mono font-bold tabular-nums text-[var(--color-text-primary)]">{liftMark}{fmtLift(horizon.lift)}</dd>
          </div>
        </dl>
        {levels ? (
          <div className="grid max-w-md grid-cols-3 gap-2 sm:col-start-2 sm:row-start-3 lg:col-start-4 lg:row-start-1 lg:max-w-none">
            <PhysicalPlanLevelCell label="支持" level={levels.support} color="var(--price-up)" />
            <PhysicalPlanLevelCell label="抵抗" level={levels.resistance} color="var(--price-down)" />
            <PhysicalPlanLevelCell label="割れ注意" level={levels.breakdown} color="var(--price-down)" />
          </div>
        ) : (
          <span className="text-[11px] font-medium text-[var(--color-text-tertiary)] sm:col-start-2 sm:row-start-3 lg:col-start-4 lg:row-start-1">価格の目安は未算出</span>
        )}
        <div className="flex min-w-0 flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 sm:col-start-2 sm:row-start-4 lg:col-span-3 lg:col-start-2 lg:row-start-2">
          <span className="min-w-0 flex-1 basis-[18rem] text-[12px] font-medium leading-5 text-[var(--color-text-secondary)]">
            <b className="font-bold text-[var(--color-text-primary)]">{horizon.suggestion.conditionLabel}</b> {horizon.suggestion.invalidation}
          </span>
          <button
            type="button"
            onClick={() => setOpen((current) => !current)}
            aria-expanded={open}
            aria-controls={detailsId}
            className="inline-flex min-h-11 shrink-0 items-center gap-1 text-[11px] font-bold text-[var(--color-brand-700)] sm:min-h-6"
          >
            候補・検証日
            <ChevronRight size={12} className={`transition-transform ${open ? 'rotate-90' : ''}`} aria-hidden="true" />
          </button>
        </div>
      </div>
      <div id={detailsId} hidden={!open} className="space-y-1.5 pb-1 pt-0.5 text-[12px] font-medium leading-5 text-[var(--color-text-secondary)]">
        <p className="m-0">{horizon.suggestion.stance}</p>
        <div className="flex flex-wrap gap-1.5 text-[11px] font-semibold">
          {topCandidates.length > 0 ? topCandidates.map((candidate) => (
            <span key={`${candidate.direction}-${candidate.rank}`} className="border border-[var(--color-border-soft)] px-1.5">
              {directionLabelJa(candidate.direction)} #{candidate.rank}
            </span>
          )) : (
            <span className="border border-[var(--color-border-soft)] px-1.5">物理ML上位外</span>
          )}
          {horizon.sampleCount != null && (
            <span className="border border-[var(--color-border-soft)] px-1.5 font-mono tabular-nums">検証 n={horizon.sampleCount.toLocaleString('en-US')}</span>
          )}
        </div>
        {horizon.suggestion.checklist.slice(0, 2).map((item) => (
          <div key={item} className="grid grid-cols-[8px_minmax(0,1fr)] items-start gap-1.5">
            <span className="mt-2 h-1.5 w-1.5 rounded-full" style={{ background: toneColor }} />
            <span>{item}</span>
          </div>
        ))}
        <div className="font-mono text-[11px] tabular-nums text-[var(--color-text-tertiary)]">
          {levels ? `基準 ${levels.baseDate} 終値 ${fmtUsd(levels.close)} ・ ` : ''}{horizon.evaluationDate ? `検証 ${horizon.evaluationDate}` : '検証日 -'}
        </div>
      </div>
    </article>
  )
}

function PhysicalPlanLevelCell({ label, level, color }: { label: string; level: UsPhysicalPlanLevel; color: string }) {
  return (
    <div className="min-w-0">
      <span className="block text-[11px] font-medium text-[var(--color-text-tertiary)]">{label}</span>
      <strong className="block whitespace-nowrap font-mono text-[13px] font-bold tabular-nums" style={{ color }}>{fmtUsd(level.value)}</strong>
      <small className="block break-words text-[11px] font-medium leading-tight text-[var(--color-text-tertiary)]">
        {level.label}{level.distancePct != null ? ` ${fmtPct(level.distancePct)}` : ''}
      </small>
    </div>
  )
}
