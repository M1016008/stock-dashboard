'use client'

import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import { ArrowRight, LoaderCircle, RotateCcw, X } from 'lucide-react'
import { Area, CartesianGrid, ComposedChart, Line, ReferenceDot, ReferenceLine, Tooltip, XAxis, YAxis } from 'recharts'
import { MeasuredChartFrame } from '@/components/charts/MeasuredChartFrame'
import { TriggerScoreCell } from '@/components/trigger-discovery/TriggerScoreCell'
import { StageTag } from '@/components/ui/StageTag'
import type { TriggerHistoricalScanEvent, TriggerHistoricalScanResponse } from '@/lib/trigger-discovery-historical-scan-contract'
import type { TriggerPathHorizonResult, TriggerPathPoint, TriggerPathProfile, TriggerPathResponse } from '@/lib/trigger-path-contract'
import type { TriggerDiscoveryTimeframe } from '@/lib/trigger-discovery-timeframe'

const EXPIRED_MESSAGE = '元の期間検証結果が利用できません。同条件で期間検証を再実行してください。'
const HORIZON_LABELS: Record<number, string> = { 20: '1カ月', 60: '3カ月', 120: '6カ月', 245: '12カ月' }
const STATUS_LABELS: Record<string, string> = {
  APPROACHING: '接近中', NEAR: 'Zone近傍', IN_ZONE: 'Zone内', BELOW_ZONE: 'Zone下方', NOT_MATCHED: '対象外',
}
const EVENT_LABELS: Record<string, string> = {
  ENTERED: '新規候補', RE_ENTRY: '再エントリー', STATUS_CHANGED: '状態変化', EXITED: '候補離脱',
}
const ZONE_LABELS: Record<string, string> = {
  ABOVE_ZONE: 'Zone上', IN_ZONE: 'Zone内', BELOW_ZONE: 'Zone下',
}
const STAGE_AXES = [
  ['日A', 'dayAStage'], ['日B', 'dayBStage'], ['週A', 'weekAStage'],
  ['週B', 'weekBStage'], ['月A', 'monthAStage'], ['月B', 'monthBStage'],
] as const

export function formatPathReturn(value: number | null): string {
  if (value == null || !Number.isFinite(value)) return 'N/A'
  const percent = value * 100
  return `${percent > 0 ? '+' : ''}${percent.toFixed(1)}%`
}

function formatDepth(value: number | null): string {
  return value == null || !Number.isFinite(value) ? 'N/A' : `${value > 0 ? '+' : ''}${value.toFixed(1)}%`
}

function formatPrice(value: number | null): string {
  return value == null || !Number.isFinite(value)
    ? 'N/A'
    : `${new Intl.NumberFormat('ja-JP', { maximumFractionDigits: 2 }).format(value)}円`
}

function formatMultiple(value: number | null): string {
  return value == null || !Number.isFinite(value) ? 'N/A' : `${value.toFixed(1)}×`
}

export function horizonDisplay(horizon: TriggerPathHorizonResult, elapsedTradingSessions: number): {
  status: '確定' | '未確定' | 'N/A'
  value: string
  remaining: number | null
} {
  if (horizon.availability && horizon.path && horizon.returnFromHit != null) {
    return { status: '確定', value: formatPathReturn(horizon.returnFromHit), remaining: null }
  }
  if (elapsedTradingSessions < horizon.horizonSessions) {
    return { status: '未確定', value: '未確定', remaining: horizon.horizonSessions - elapsedTradingSessions }
  }
  return { status: 'N/A', value: 'N/A', remaining: null }
}

export function pathMilestones(profile: TriggerPathProfile, anchorLabel = 'Hit', anchorDate = profile.eventDate): Array<{ label: string; date: string }> {
  const entries = [
    { label: anchorLabel, date: anchorDate },
    profile.deepestDate ? { label: '最深部', date: profile.deepestDate } : null,
    profile.firstZoneLowerReclaimDate ? { label: '初回Zone回復', date: profile.firstZoneLowerReclaimDate } : null,
    profile.firstZoneUpperReclaimDate ? { label: '初回上限回復', date: profile.firstZoneUpperReclaimDate } : null,
    profile.latestDate && profile.latestDate !== profile.eventDate ? { label: '最新', date: profile.latestDate } : null,
  ]
  return entries.filter((entry): entry is { label: string; date: string } => entry != null)
    .sort((a, b) => a.date.localeCompare(b.date))
}

function pathSummary(profile: TriggerPathProfile, anchorLabel: string): string {
  const depth = profile.deepestDate
    ? `${anchorLabel}後の最深下抜けは${formatDepth(profile.dynamicUndershootLowPctAtDeepest)}、${profile.tradingSessionsToDeepest ?? '不明'}営業日後。`
    : '観測期間内にZone下限の下抜けはありません。'
  const reclaim = profile.firstZoneLowerReclaimDate
    ? `初回のZone回復は${profile.firstZoneLowerReclaimDate}。`
    : profile.firstZoneLowerCloseBreachDate ? '終値での下抜け後、Zone回復は未観測です。' : ''
  return `${depth}${reclaim}${anchorLabel}の保存株価から最新まで${formatPathReturn(profile.returnToDate)}。`
}

function priceAtHitTooltip({ active, payload, anchorPrice, anchorLabel }: {
  active?: boolean
  payload?: ReadonlyArray<{ payload?: TriggerPathPoint }>
  anchorPrice: number
  anchorLabel: string
}) {
  const point = active ? payload?.[0]?.payload : null
  if (!point) return null
  return (
    <div className="rounded-[4px] border border-[var(--color-border)] bg-white p-2.5 text-[11px] leading-5 shadow-lg">
      <strong className="tabular-nums text-[var(--color-text-primary)]">{point.date}</strong>
      <dl className="mt-1 grid grid-cols-[auto_auto] gap-x-5 text-[var(--color-text-secondary)]">
        <dt>終値</dt><dd className="text-right tabular-nums">{formatPrice(point.close)}</dd>
        <dt>MA1</dt><dd className="text-right tabular-nums">{formatPrice(point.ma1)}</dd>
        <dt>MA2</dt><dd className="text-right tabular-nums">{formatPrice(point.ma2)}</dd>
        <dt>Zone上限</dt><dd className="text-right tabular-nums">{formatPrice(point.zoneUpper)}</dd>
        <dt>Zone下限</dt><dd className="text-right tabular-nums">{formatPrice(point.zoneLower)}</dd>
        <dt>{anchorLabel}比</dt><dd className="text-right tabular-nums">{formatPathReturn(point.close / anchorPrice - 1)}</dd>
      </dl>
    </div>
  )
}

function PathChart({ response }: { response: TriggerPathResponse }) {
  const { pathProfile: profile, series } = response
  const anchorLabel = response.event.snapshotBasis === 'PREVIOUS' ? '前回候補値' : 'Hit'
  const chartData = useMemo(() => series.map((point) => ({
    ...point,
    zoneBand: point.zoneLower == null || point.zoneUpper == null ? null : [point.zoneLower, point.zoneUpper],
  })), [series])
  const deepest = profile.deepestDate ? series.find((point) => point.date === profile.deepestDate) : null
  const lowBound = Math.min(...series.map((point) => point.low)) * 0.98
  const highBound = Math.max(...series.map((point) => point.high)) * 1.02

  return (
    <section aria-labelledby="follow-up-chart-heading" className="border-t border-[var(--color-border-soft)] pt-5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 id="follow-up-chart-heading" className="text-[14px] font-semibold text-[var(--color-text-primary)]">{anchorLabel}後の値動き</h3>
        <span className="text-[11px] tabular-nums text-[var(--color-text-secondary)]">{series[0]?.date ?? '—'} 〜 {profile.analysisCutoffDate}</span>
      </div>
      <p className="mt-1 text-[11px] leading-5 text-[var(--color-text-secondary)]">{pathSummary(profile, anchorLabel)}</p>
      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-[var(--color-text-secondary)]" aria-hidden="true">
        <span>● 終値</span><span>― MA1</span><span>┄ MA2</span><span>淡色帯 MA1〜MA2</span>
      </div>
      <MeasuredChartFrame className="mt-2 h-[260px] w-full sm:h-[320px]">
        {({ width, height }) => (
          <ComposedChart width={width} height={height} data={chartData} margin={{ top: 14, right: 12, bottom: 4, left: 0 }}>
            <CartesianGrid vertical={false} stroke="var(--color-border-soft)" />
            <XAxis dataKey="date" minTickGap={32} tickFormatter={(date) => String(date).slice(5)} tick={{ fontSize: 10, fill: 'var(--color-text-secondary)' }} tickLine={false} axisLine={false} />
            <YAxis width={50} domain={[lowBound, highBound]} tick={{ fontSize: 10, fill: 'var(--color-text-secondary)' }} tickLine={false} axisLine={false} tickFormatter={(value) => Number(value).toLocaleString('ja-JP')} />
            <Tooltip content={(props) => priceAtHitTooltip({ active: props.active, payload: props.payload, anchorPrice: profile.anchorPrice, anchorLabel })} />
            <Area type="monotone" dataKey="zoneBand" stroke="none" fill="var(--color-brand-100)" fillOpacity={0.55} isAnimationActive={false} connectNulls={false} legendType="none" />
            <Line type="monotone" dataKey="ma1" stroke="var(--color-brand-700)" strokeWidth={1.4} dot={false} isAnimationActive={false} connectNulls={false} />
            <Line type="monotone" dataKey="ma2" stroke="#a16b39" strokeWidth={1.4} strokeDasharray="4 3" dot={false} isAnimationActive={false} connectNulls={false} />
            <Line type="monotone" dataKey="close" stroke="var(--color-text-primary)" strokeWidth={2} dot={false} isAnimationActive={false} />
            <ReferenceLine x={response.event.priceDate} stroke="var(--color-brand-700)" strokeDasharray="3 3" label={{ value: anchorLabel, position: 'insideTopRight', fontSize: 10 }} />
            {deepest && <ReferenceDot x={deepest.date} y={deepest.low} r={4} fill="#b45309" stroke="white" strokeWidth={1.5} />}
            {profile.firstZoneLowerReclaimDate && <ReferenceLine x={profile.firstZoneLowerReclaimDate} stroke="#059669" strokeDasharray="3 3" />}
            {profile.firstZoneUpperReclaimDate && <ReferenceLine x={profile.firstZoneUpperReclaimDate} stroke="#047857" strokeDasharray="2 4" />}
          </ComposedChart>
        )}
      </MeasuredChartFrame>
      <ol className="mt-3 flex flex-wrap items-center gap-x-1 gap-y-2 text-[11px] text-[var(--color-text-secondary)]" aria-label="保存株価から最新までの経過">
        {pathMilestones(profile, anchorLabel, response.event.priceDate).map((item, index) => (
          <li key={`${item.label}-${item.date}`} className="inline-flex items-center gap-1">
            {index > 0 && <ArrowRight size={12} className="text-[var(--color-text-tertiary)]" aria-hidden />}
            <span className="whitespace-nowrap"><strong className="font-semibold text-[var(--color-text-primary)]">{item.label}</strong> <time dateTime={item.date}>{item.date.slice(5)}</time></span>
          </li>
        ))}
      </ol>
    </section>
  )
}

function PathDetails({ response, criteria }: {
  response: TriggerPathResponse
  criteria: TriggerHistoricalScanResponse['criteria'] | null
}) {
  const { event, pathProfile: profile } = response
  const anchorLabel = event.snapshotBasis === 'PREVIOUS' ? '前回候補' : 'Hit時'
  const status = event.snapshotBasis === 'CURRENT' ? event.currentStatus : event.previousStatus
  const details: Array<[string, string]> = [
    ['Event状態', status ? STATUS_LABELS[status] ?? status : 'N/A'],
    [`${anchorLabel}株価`, formatPrice(event.price)],
    [`${anchorLabel}MA1`, formatPrice(event.ma1)],
    [`${anchorLabel}MA2`, formatPrice(event.ma2)],
    [`${anchorLabel}Zone距離`, formatDepth(event.zoneDistancePct)],
    [`${anchorLabel}Zone下限`, formatPrice(profile.anchorZoneLower)],
    ['MA間隔', formatDepth(event.maSpreadPct ?? null)],
    ['間隔変化', event.maSpreadSlope == null ? 'N/A' : formatDepth(event.maSpreadSlope)],
    ['間隔拡大比', formatMultiple(event.maSpreadExpansionRatio ?? null)],
    ['間隔拡大判定', event.spreadExpansionAvailable === false ? 'N/A' : event.spreadExpansionPass == null ? '保存値なし' : event.spreadExpansionPass ? '該当' : '非該当'],
    ['MA1 > MA2', event.bullishMaOrder == null ? '保存値なし' : event.bullishMaOrder ? 'はい' : 'いいえ'],
    ['2本とも上向き / 上から接近', '既存Trigger条件（個別判定値はEventに未保存）'],
    ['Zone下抜け許容', criteria?.belowZoneToleranceEnabled ? `ON / 最大 ${criteria.maxBelowZonePct ?? '—'}%` : 'OFF'],
  ]
  return (
    <details className="border-t border-[var(--color-border-soft)] pt-4">
      <summary className="cursor-pointer text-[13px] font-semibold text-[var(--color-text-primary)]">{anchorLabel}の条件・6ステージ</summary>
      <p className="mt-2 text-[11px] leading-5 text-[var(--color-text-secondary)]">Trigger Scoreは条件への適合度です。投資成果の評価ではありません。</p>
      <div className="mt-3 flex items-center gap-3 text-[11px] text-[var(--color-text-secondary)]">Trigger Score <TriggerScoreCell triggerScore={event.triggerScore} scoreBreakdown={event.scoreBreakdown} /></div>
      <div className="mt-3 grid grid-cols-3 gap-2 sm:grid-cols-6" aria-label={`${anchorLabel}の6ステージ`}>
        {STAGE_AXES.map(([label, key]) => <div key={key} className="flex items-center gap-1.5 text-[11px] text-[var(--color-text-secondary)]">{label}<StageTag stage={event[key]} size="sm" /></div>)}
      </div>
      <dl className="mt-4 grid grid-cols-2 gap-x-5 gap-y-3 text-[11px]">
        {details.map(([label, value]) => <div key={label} className="min-w-0"><dt className="text-[var(--color-text-secondary)]">{label}</dt><dd className="mt-0.5 break-words font-medium tabular-nums text-[var(--color-text-primary)]">{value}</dd></div>)}
      </dl>
    </details>
  )
}

function LoadedFollowUp({ response, criteria }: {
  response: TriggerPathResponse
  criteria: TriggerHistoricalScanResponse['criteria'] | null
}) {
  const profile = response.pathProfile
  const previousBasis = response.event.snapshotBasis === 'PREVIOUS'
  const anchorLabel = previousBasis ? '前回候補値' : 'Hit'
  const depthLow = profile.dynamicUndershootLowPctAtDeepest
  const depthClose = profile.maxZoneUndershootClosePct
  const reclaimLabel = profile.reclaimStatus === 'UPPER_RECLAIMED' ? 'Zone上限を回復'
    : profile.reclaimStatus === 'LOWER_RECLAIMED' ? 'Zone内へ回復'
      : profile.reclaimStatus === 'BREACHED_NOT_RECLAIMED'
        ? profile.firstZoneLowerReclaimDate ? '現在Zone下（再下抜け）' : '下抜け・未回復'
        : '下抜けなし'
  const topValues = [
    [previousBasis ? '前回候補値' : 'Hit時', formatPrice(profile.anchorPrice)],
    ['最新', formatPrice(profile.latestClose)],
    ['現在まで', formatPathReturn(profile.returnToDate)],
    ['経過', `${profile.elapsedTradingSessions}営業日`],
  ]
  return (
    <div className="space-y-6 px-4 pb-10 pt-5 sm:px-6">
      <section aria-label={`${anchorLabel}から最新までの概況`}>
        <div className="grid grid-cols-2 gap-x-4 gap-y-4 border-b border-[var(--color-border-soft)] pb-4 sm:grid-cols-4">
          {topValues.map(([label, value]) => <div key={label}><div className="text-[11px] text-[var(--color-text-secondary)]">{label}</div><div className="mt-1 whitespace-nowrap text-[17px] font-semibold tabular-nums text-[var(--color-text-primary)] sm:text-[19px]">{value}</div></div>)}
        </div>
        <p className="mt-2 text-[11px] leading-5 text-[var(--color-text-secondary)]">現在までは保存Eventの株価から最新利用可能データまでの途中経過です。<strong className="font-medium">最新データ：{profile.analysisCutoffDate}</strong></p>
        {profile.latestDate && profile.latestDate !== profile.analysisCutoffDate && <p className="mt-1 text-[11px] text-[var(--color-text-secondary)]">当該銘柄の最終終値日：{profile.latestDate}</p>}
        {previousBasis && <p className="mt-1 text-[11px] leading-5 text-[var(--color-text-secondary)]">候補離脱は前回候補の保存株価（{response.event.priceDate}）が基準です。Event当日の終値とは異なるため、経過0営業日でも騰落率が0とは限りません。</p>}
        <p className="mt-1 text-[11px] text-[var(--color-text-secondary)]">最新の位置：{profile.currentZonePosition ? ZONE_LABELS[profile.currentZonePosition] : 'N/A'}（最新終値と当日のZoneによる位置）</p>
      </section>

      <section aria-labelledby="follow-up-depth-heading">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 id="follow-up-depth-heading" className="text-[14px] font-semibold text-[var(--color-text-primary)]">Zone下抜けと回復</h3>
          <span className="rounded-[3px] border border-[var(--color-border)] px-2 py-1 text-[11px] font-medium text-[var(--color-text-secondary)]">{reclaimLabel}</span>
        </div>
        {profile.deepestDate ? (
          <>
            <div className="mt-3 grid grid-cols-2 gap-x-5 gap-y-3 border-y border-[var(--color-border-soft)] py-3">
              <div><div className="text-[11px] text-[var(--color-text-secondary)]">最深下抜け（Low）</div><strong className="mt-1 block text-[22px] tabular-nums text-[var(--color-text-primary)]">{formatDepth(depthLow)}</strong></div>
              <div><div className="text-[11px] text-[var(--color-text-secondary)]">最深下抜け（終値）</div><strong className="mt-1 block text-[22px] tabular-nums text-[var(--color-text-primary)]">{depthClose != null && depthClose >= 0 ? '下抜けなし' : formatDepth(depthClose)}</strong></div>
            </div>
            <p className="mt-2 text-[11px] leading-5 text-[var(--color-text-secondary)]">各営業日時点で移動するZone下限との距離。Lowは場中、終値は引け時点です。{profile.intradayOnlyUndershootOccurred && !profile.firstZoneLowerCloseBreachDate ? '場中のみ下抜け。' : ''}</p>
            <dl className="mt-3 grid grid-cols-2 gap-x-5 gap-y-3 text-[11px] sm:grid-cols-3">
              {[
                ['最深部', `${profile.deepestDate} / Low ${formatPrice(profile.deepestLow)} / 終値 ${formatPrice(profile.deepestClose)}`],
                ['最深部まで', profile.tradingSessionsToDeepest == null ? 'N/A' : `${profile.tradingSessionsToDeepest}営業日`],
                [`${anchorLabel}のZone下限基準`, formatDepth(profile.fixedAnchorUndershootLowPctAtDeepest)],
                ['Zone幅比', formatMultiple(profile.undershootToZoneWidthRatio)],
                ['ATR20比', formatMultiple(profile.undershootAtrMultiple)],
                ['Zone下滞在（終値）', `累計 ${profile.totalBelowZoneSessions}営業日 / 最長連続 ${profile.longestConsecutiveBelowZoneSessions}営業日`],
              ].map(([label, value]) => <div key={label}><dt className="text-[var(--color-text-secondary)]">{label}</dt><dd className="mt-1 font-medium tabular-nums text-[var(--color-text-primary)]">{value}</dd></div>)}
            </dl>
            <p className="mt-2 text-[11px] leading-5 text-[var(--color-text-secondary)]">Zone幅比は下抜け幅を最深時点のZone幅で、ATR20比は同時点のATR20で正規化した値です。</p>
          </>
        ) : <p className="mt-3 text-[12px] text-[var(--color-text-secondary)]">観測期間内にZone下限の下抜けはありません。</p>}
        <div className="mt-4 grid grid-cols-2 gap-x-5 gap-y-3 border-t border-[var(--color-border-soft)] pt-3 text-[11px]">
          <div><span className="text-[var(--color-text-secondary)]">初回Zone回復</span><div className="mt-1 font-medium tabular-nums">{profile.firstZoneLowerReclaimDate ?? (profile.firstZoneLowerCloseBreachDate ? '未回復' : '該当なし')}</div>{profile.firstZoneLowerReclaimDate && <div className="text-[var(--color-text-secondary)]">Eventから{profile.sessionsFromHitToLowerReclaim ?? '—'}営業日{profile.sessionsFromDeepestToLowerReclaim != null ? ` / 最深部から${profile.sessionsFromDeepestToLowerReclaim}営業日` : ' / 最深部より前の回復'}</div>}</div>
          <div><span className="text-[var(--color-text-secondary)]">初回Zone上限回復</span><div className="mt-1 font-medium tabular-nums">{profile.firstZoneUpperReclaimDate ?? '未到達'}</div></div>
          <div><span className="text-[var(--color-text-secondary)]">最深部 → 最新</span><div className="mt-1 font-semibold tabular-nums">{formatPathReturn(profile.returnDeepestToLatest)}</div></div>
          <div><span className="text-[var(--color-text-secondary)]">最深部 → その後最高</span><div className="mt-1 font-semibold tabular-nums">{formatPathReturn(profile.maxReboundFromDeepest)}</div><div className="text-[var(--color-text-secondary)]">{profile.maxReboundDate ?? '—'}</div></div>
          {profile.firstZoneLowerReclaimDate && <div><span className="text-[var(--color-text-secondary)]">初回Zone回復 → 最新</span><div className="mt-1 font-semibold tabular-nums">{formatPathReturn(profile.returnFromLowerReclaimToLatest)}</div></div>}
        </div>
      </section>

      <PathChart response={response} />

      <section aria-labelledby="follow-up-horizons-heading" className="border-t border-[var(--color-border-soft)] pt-4">
        <h3 id="follow-up-horizons-heading" className="text-[14px] font-semibold text-[var(--color-text-primary)]">期間別の途中経過</h3>
        <div className="mt-3 grid grid-cols-2 gap-x-5 gap-y-3 sm:grid-cols-4">
          {profile.horizonPaths.map((horizon) => {
            const display = horizonDisplay(horizon, profile.elapsedTradingSessions)
            return <div key={horizon.horizonSessions} className="border-t border-[var(--color-border-soft)] pt-2">
              <div className="text-[11px] text-[var(--color-text-secondary)]">{HORIZON_LABELS[horizon.horizonSessions]}</div>
              <div className="mt-1 text-[18px] font-semibold tabular-nums text-[var(--color-text-primary)]">{display.value}</div>
              <div className="text-[11px] text-[var(--color-text-secondary)]">{display.status === '未確定' ? `あと${display.remaining}営業日` : display.status}{display.status === '確定' && horizon.endDate ? ` · ${horizon.endDate}` : ''}</div>
              {horizon.path && <details className="mt-1 text-[11px] text-[var(--color-text-secondary)]"><summary className="cursor-pointer">経路詳細</summary><div className="mt-1">MFE {formatPathReturn(horizon.path.maxUpsideToDate)} / MAE {formatPathReturn(horizon.path.maxDownsideToDate)}</div><div>最深下抜け {formatDepth(horizon.path.maxZoneUndershootLowPct)}</div></details>}
            </div>
          })}
        </div>
        <p className="mt-2 text-[11px] leading-5 text-[var(--color-text-secondary)]">未確定は所定営業日が未経過、N/Aは経過済みでも必要な価格・Zoneデータが揃わない場合です。</p>
      </section>

      <PathDetails response={response} criteria={criteria} />
    </div>
  )
}

export function TriggerFollowUpDrawer({ jobId, event, timeframe, ma1Period, ma2Period, criteria, onClose }: {
  jobId: string
  event: TriggerHistoricalScanEvent
  timeframe: TriggerDiscoveryTimeframe
  ma1Period: number
  ma2Period: number
  criteria: TriggerHistoricalScanResponse['criteria'] | null
  onClose: () => void
}) {
  const titleId = useId()
  const panelRef = useRef<HTMLElement>(null)
  const closeRef = useRef<HTMLButtonElement>(null)
  const returnFocusRef = useRef<HTMLElement | null>(null)
  const sequence = useRef(0)
  const [response, setResponse] = useState<TriggerPathResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [reloadToken, setReloadToken] = useState(0)
  const eventKey = event.eventKey

  useEffect(() => {
    returnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    closeRef.current?.focus()
    return () => {
      document.body.style.overflow = previousOverflow
      returnFocusRef.current?.focus()
    }
  }, [])

  useEffect(() => {
    if (!eventKey) return
    const controller = new AbortController()
    const currentSequence = ++sequence.current
    setResponse(null)
    setError(null)
    setLoading(true)
    void fetch(`/api/trigger-discovery/historical-scan/jobs/${encodeURIComponent(jobId)}/events/${encodeURIComponent(eventKey)}/follow-up`, {
      cache: 'no-store', signal: controller.signal,
    }).then(async (result) => {
      if (result.status === 404 || result.status === 410 || result.status === 409) throw new Error(EXPIRED_MESSAGE)
      if (!result.ok) throw new Error('その後の値動きを取得できませんでした。少し待ってから再試行してください。')
      const body = await result.json() as TriggerPathResponse
      if (body.event.eventKey !== eventKey || body.meta.scanJobId !== jobId || body.pathProfile.eventDate !== event.date) {
        throw new Error('Eventの照合に失敗しました。期間検証を開き直してください。')
      }
      if (controller.signal.aborted || sequence.current !== currentSequence) return
      setResponse(body)
    }).catch((loadError) => {
      if (!controller.signal.aborted && sequence.current === currentSequence) {
        setError(loadError instanceof Error ? loadError.message : 'その後の値動きを取得できませんでした。')
      }
    }).finally(() => {
      if (!controller.signal.aborted && sequence.current === currentSequence) setLoading(false)
    })
    return () => { controller.abort(); sequence.current += 1 }
  }, [jobId, eventKey, event.date, reloadToken])

  const onKeyDown = (keyboardEvent: KeyboardEvent<HTMLElement>) => {
    if (keyboardEvent.key === 'Escape') { keyboardEvent.preventDefault(); onClose(); return }
    if (keyboardEvent.key !== 'Tab' || !panelRef.current) return
    const focusable = Array.from(panelRef.current.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), summary, [href], [tabindex]:not([tabindex="-1"])'))
    if (!focusable.length) return
    if (keyboardEvent.shiftKey && document.activeElement === focusable[0]) { keyboardEvent.preventDefault(); focusable.at(-1)?.focus() }
    else if (!keyboardEvent.shiftKey && document.activeElement === focusable.at(-1)) { keyboardEvent.preventDefault(); focusable[0].focus() }
  }

  return createPortal(
    <div className="fixed inset-0 z-[100] flex justify-end">
      <button type="button" aria-label="その後を見るを閉じる" onClick={onClose} className="absolute inset-0 cursor-default bg-slate-950/35" />
      <section ref={panelRef} role="dialog" aria-modal="true" aria-labelledby={titleId} onKeyDown={onKeyDown} className="relative h-full w-full max-w-[680px] overflow-y-auto overflow-x-hidden border-l border-[var(--color-border)] bg-white shadow-2xl">
        <header className="sticky top-0 z-20 border-b border-[var(--color-border)] bg-white/95 px-4 py-3 backdrop-blur sm:px-6">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <h2 id={titleId} className="text-[17px] font-semibold text-[var(--color-text-primary)]">{event.ticker} {event.companyName}</h2>
              <p className="mt-1 text-[11px] leading-5 text-[var(--color-text-secondary)]">{event.date} · {EVENT_LABELS[event.eventType]}{event.currentStatus ? ` / ${STATUS_LABELS[event.currentStatus] ?? event.currentStatus}` : ''} · {timeframe === 'BIWEEKLY' ? '2週足' : '月足'} MA {ma1Period} / {ma2Period}</p>
            </div>
            <button ref={closeRef} type="button" onClick={onClose} aria-label="その後を見るを閉じる" className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-[3px] text-[var(--color-text-secondary)] outline-none hover:bg-[var(--color-surface-muted)] focus-visible:ring-2 focus-visible:ring-[var(--color-brand-200)]"><X size={18} aria-hidden /></button>
          </div>
        </header>
        {loading ? <div role="status" className="flex min-h-48 items-center justify-center gap-2 px-4 text-[12px] text-[var(--color-text-secondary)]"><LoaderCircle size={17} className="animate-spin" aria-hidden />その後の値動きを確認しています…</div>
          : error ? <div className="m-5 border-l-2 border-amber-500 bg-amber-50 px-4 py-3 text-[12px] text-amber-900"><p role="alert">{error}</p><button type="button" onClick={() => setReloadToken((value) => value + 1)} className="mt-2 inline-flex items-center gap-1 font-semibold underline underline-offset-2"><RotateCcw size={13} aria-hidden />再試行</button></div>
            : response && response.pathProfile.eventKey === eventKey ? <LoadedFollowUp response={response} criteria={criteria} /> : null}
      </section>
    </div>, document.body,
  )
}
