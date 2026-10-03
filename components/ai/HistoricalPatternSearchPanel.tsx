'use client'

import Link from 'next/link'
import { useMemo, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { ArrowRight, Loader2, Search, SlidersHorizontal, TrendingDown, TrendingUp } from 'lucide-react'
import { StageTag } from '@/components/ui/StageTag'
import { BacktestHighlightChart, type HighlightChartPoint, type StageMarkerPoint } from '@/components/charts/BacktestHighlightChart'
import { getUniverseFilterMeta, parseUniverseFilter, UNIVERSE_FILTER_PARAM } from '@/lib/market-universe'

type Direction = 'up' | 'down'
type Mode = 'manual' | 'events'

type PatternEvent = {
  ticker: string
  name: string | null
  sourceDate: string
  horizonDays: number
  direction: Direction
  thresholdPct: number
  reachedPct: number | null
  reachedDate: string | null
  reachedDays: number | null
  maxReturnPct: number | null
  minReturnPct: number | null
  patternStartDate: string
  patternEndDate: string
  sector17Name: string | null
  sector33Name: string | null
}

type PatternSearchMatch = {
  rank: number
  ticker: string
  name: string | null
  sector17Name: string | null
  sector33Name: string | null
  similarityScore: number
  averageScore: number
  finalScore: number
  trajectoryScore: number
  stagePathScore: number
  currentStartDate: string
  currentEndDate: string
  profile: {
    close: number | null
    stageCode: string | null
    maOrder: string | null
    trend: string | null
    sma5Velocity5: number | null
    sma25Velocity5: number | null
    sma5Acceleration5: number | null
    gap5To25Pct: number | null
    gap5To25Velocity5: number | null
    priceToSma25: number | null
  }
  reason: Record<string, string>
}

type PatternSearchResponse = {
  ticker: string
  asOfDate: string
  currentStartDate: string
  currentEndDate: string
  count: number
  reference: {
    ticker: string
    name: string | null
    startDate: string
    endDate: string
    featureDays: number
    profile: PatternSearchMatch['profile']
    stagePath: StageMarkerPoint[]
    outcomes: Array<{
      horizon_days: number
      return_pct: number | null
      end_date: string | null
      max_return_pct: number | null
      max_return_date: string | null
      days_to_max: number | null
      min_return_pct: number | null
      min_return_date: string | null
      days_to_min: number | null
    }>
    chart: {
      series: HighlightChartPoint[]
      highlightStart: string
      highlightEnd: string | null
      direction: 'up' | 'down'
      stagePath: StageMarkerPoint[]
      startPrice: number | null
      endPrice: number | null
      returnPct: number | null
    }
  }
  matches: PatternSearchMatch[]
}

type EventsResponse = {
  source: 'forward_extrema' | 'ohlcv_ondemand'
  count: number
  events: PatternEvent[]
}

const HORIZON_OPTIONS = [5, 10, 15, 20, 30, 40, 60, 90, 180, 200]

function subtractCalendarDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00.000Z`)
  d.setUTCDate(d.getUTCDate() - days)
  return d.toISOString().slice(0, 10)
}

function fmtPct(value: number | null | undefined, digits = 1): string {
  if (value == null || !Number.isFinite(value)) return '-'
  return `${value >= 0 ? '+' : ''}${value.toFixed(digits)}%`
}

function fmtPrice(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '-'
  return Math.round(value).toLocaleString('ja-JP')
}

function trendLabel(value: string | null | undefined): string {
  switch (value) {
    case 'up_acceleration': return '上向き加速'
    case 'up_deceleration': return '上向き鈍化'
    case 'down_acceleration': return '下向き加速'
    case 'down_deceleration': return '下向き鈍化'
    case 'sideways': return '横ばい'
    default: return '-'
  }
}

function stageTags(code: string | null | undefined) {
  if (!code || !/^\d{6}$/.test(code)) return <span className="font-mono text-[var(--color-text-tertiary)]">------</span>
  return (
    <span className="inline-flex gap-0.5 align-middle">
      {code.split('').slice(0, 6).map((char, index) => (
        <StageTag key={`${char}-${index}`} stage={Number(char)} size="xs" />
      ))}
    </span>
  )
}

function encodeParams(values: Record<string, string | number | null | undefined>): string {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(values)) {
    if (value == null || value === '') continue
    params.set(key, String(value))
  }
  return params.toString()
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-[4px] border border-[var(--color-border-default)] bg-white px-2 py-1.5">
      <div className="text-[10px] font-bold text-[var(--color-text-tertiary)]">{label}</div>
      <div className="mt-0.5 text-[12px] font-black text-[var(--color-brand-900)]">{value}</div>
    </div>
  )
}

export function HistoricalPatternSearchPanel({ latestFeatureDate }: { latestFeatureDate: string | null }) {
  const searchParams = useSearchParams()
  const activeUniverse = parseUniverseFilter(searchParams.get(UNIVERSE_FILTER_PARAM))
  const activeUniverseMeta = getUniverseFilterMeta(activeUniverse)
  const defaultEnd = latestFeatureDate ?? ''
  const defaultStart = defaultEnd ? subtractCalendarDays(defaultEnd, 28) : ''
  const [mode, setMode] = useState<Mode>('manual')
  const [ticker, setTicker] = useState('6326')
  const [startDate, setStartDate] = useState(defaultStart)
  const [endDate, setEndDate] = useState(defaultEnd)
  const [direction, setDirection] = useState<Direction>('up')
  const [horizonDays, setHorizonDays] = useState('20')
  const [thresholdPct, setThresholdPct] = useState('10')
  const [eventStartDate, setEventStartDate] = useState('')
  const [eventEndDate, setEventEndDate] = useState('')
  const [events, setEvents] = useState<PatternEvent[]>([])
  const [eventsSource, setEventsSource] = useState<string | null>(null)
  const [eventsLoading, setEventsLoading] = useState(false)
  const [searchLoading, setSearchLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<PatternSearchResponse | null>(null)

  const selectedHorizonIsKnown = useMemo(() => HORIZON_OPTIONS.includes(Number(horizonDays)), [horizonDays])

  async function loadEvents() {
    setError(null)
    setEventsLoading(true)
    try {
      const query = encodeParams({
        direction,
        horizonDays,
        thresholdPct,
        startDate: eventStartDate,
        endDate: eventEndDate,
        universe: activeUniverse,
        limit: 12,
      })
      const res = await fetch(`/api/ml/pattern-events?${query}`, { cache: 'no-store' })
      const json = await res.json()
      if (!res.ok) throw new Error(json.message ?? 'イベント抽出に失敗しました')
      const payload = json as EventsResponse
      setEvents(Array.isArray(payload.events) ? payload.events : [])
      setEventsSource(payload.source ?? null)
    } catch (eventError) {
      setEvents([])
      setEventsSource(null)
      setError((eventError as Error).message)
    } finally {
      setEventsLoading(false)
    }
  }

  async function runSearch(next?: { ticker?: string; startDate?: string; endDate?: string }) {
    const nextTicker = next?.ticker ?? ticker
    const nextStart = next?.startDate ?? startDate
    const nextEnd = next?.endDate ?? endDate
    setError(null)
    setSearchLoading(true)
    try {
      const query = encodeParams({
        ticker: nextTicker,
        startDate: nextStart,
        endDate: nextEnd,
        universe: activeUniverse,
        limit: 24,
      })
      const res = await fetch(`/api/ml/pattern-search?${query}`, { cache: 'no-store' })
      const json = await res.json()
      if (!res.ok) throw new Error(json.message ?? 'パターン検索に失敗しました')
      setResult(json as PatternSearchResponse)
    } catch (searchError) {
      setResult(null)
      setError((searchError as Error).message)
    } finally {
      setSearchLoading(false)
    }
  }

  function useEvent(event: PatternEvent) {
    setTicker(event.ticker)
    setStartDate(event.patternStartDate)
    setEndDate(event.patternEndDate)
    runSearch({ ticker: event.ticker, startDate: event.patternStartDate, endDate: event.patternEndDate })
  }

  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => setMode('manual')}
          className={`inline-flex items-center gap-1.5 rounded-[4px] border px-3 py-1.5 text-[12px] font-bold ${mode === 'manual' ? 'border-[var(--color-brand-700)] bg-[var(--color-brand-50)] text-[var(--color-brand-900)]' : 'border-[var(--color-border-default)] bg-white text-[var(--color-text-secondary)]'}`}
        >
          <SlidersHorizontal className="h-3.5 w-3.5" />
          銘柄+期間
        </button>
        <button
          type="button"
          onClick={() => setMode('events')}
          className={`inline-flex items-center gap-1.5 rounded-[4px] border px-3 py-1.5 text-[12px] font-bold ${mode === 'events' ? 'border-[var(--color-brand-700)] bg-[var(--color-brand-50)] text-[var(--color-brand-900)]' : 'border-[var(--color-border-default)] bg-white text-[var(--color-text-secondary)]'}`}
        >
          {direction === 'up' ? <TrendingUp className="h-3.5 w-3.5" /> : <TrendingDown className="h-3.5 w-3.5" />}
          条件ケース
        </button>
        {activeUniverseMeta && (
          <span className="inline-flex items-center rounded-full border border-[var(--color-market-red)] bg-[var(--color-price-up-bg)] px-2.5 py-1 text-[11px] font-bold text-[var(--color-market-red)]">
            {activeUniverseMeta.shortLabel}
          </span>
        )}
      </div>

      {mode === 'manual' && (
        <div className="grid gap-3 rounded-[4px] border border-[var(--color-border-default)] bg-[var(--color-surface-subtle)] p-3 lg:grid-cols-[110px_1fr_1fr_auto]">
          <label className="grid gap-1 text-[11px] font-bold text-[var(--color-text-tertiary)]">
            銘柄
            <input
              value={ticker}
              onChange={(event) => setTicker(event.target.value.replace(/\.T$/i, ''))}
              className="h-9 rounded-[4px] border border-[var(--color-border-default)] bg-white px-2 font-mono text-[13px] font-bold text-[var(--color-text-primary)] outline-none focus:border-[var(--color-brand-600)]"
            />
          </label>
          <label className="grid gap-1 text-[11px] font-bold text-[var(--color-text-tertiary)]">
            開始日
            <input
              type="date"
              value={startDate}
              onChange={(event) => setStartDate(event.target.value)}
              className="h-9 rounded-[4px] border border-[var(--color-border-default)] bg-white px-2 text-[13px] font-bold text-[var(--color-text-primary)] outline-none focus:border-[var(--color-brand-600)]"
            />
          </label>
          <label className="grid gap-1 text-[11px] font-bold text-[var(--color-text-tertiary)]">
            終了日
            <input
              type="date"
              value={endDate}
              onChange={(event) => setEndDate(event.target.value)}
              className="h-9 rounded-[4px] border border-[var(--color-border-default)] bg-white px-2 text-[13px] font-bold text-[var(--color-text-primary)] outline-none focus:border-[var(--color-brand-600)]"
            />
          </label>
          <button
            type="button"
            onClick={() => runSearch()}
            disabled={searchLoading}
            className="mt-auto inline-flex h-9 items-center justify-center gap-1.5 rounded-[4px] bg-[var(--color-brand-700)] px-4 text-[12px] font-bold text-white disabled:opacity-60"
          >
            {searchLoading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Search className="h-3.5 w-3.5" />}
            検索
          </button>
        </div>
      )}

      {mode === 'events' && (
        <div className="grid gap-3 rounded-[4px] border border-[var(--color-border-default)] bg-[var(--color-surface-subtle)] p-3">
          <div className="grid gap-3 md:grid-cols-[120px_1fr_1fr_1fr_1fr_auto]">
            <label className="grid gap-1 text-[11px] font-bold text-[var(--color-text-tertiary)]">
              方向
              <select
                value={direction}
                onChange={(event) => setDirection(event.target.value as Direction)}
                className="h-9 rounded-[4px] border border-[var(--color-border-default)] bg-white px-2 text-[13px] font-bold text-[var(--color-text-primary)] outline-none focus:border-[var(--color-brand-600)]"
              >
                <option value="up">上昇</option>
                <option value="down">下落</option>
              </select>
            </label>
            <label className="grid gap-1 text-[11px] font-bold text-[var(--color-text-tertiary)]">
              期間
              <input
                list="pattern-horizon-options"
                value={horizonDays}
                onChange={(event) => setHorizonDays(event.target.value)}
                className="h-9 rounded-[4px] border border-[var(--color-border-default)] bg-white px-2 text-[13px] font-bold text-[var(--color-text-primary)] outline-none focus:border-[var(--color-brand-600)]"
              />
              <datalist id="pattern-horizon-options">
                {HORIZON_OPTIONS.map((value) => <option key={value} value={value} />)}
              </datalist>
            </label>
            <label className="grid gap-1 text-[11px] font-bold text-[var(--color-text-tertiary)]">
              しきい値%
              <input
                type="number"
                min="0"
                step="0.5"
                value={thresholdPct}
                onChange={(event) => setThresholdPct(event.target.value)}
                className="h-9 rounded-[4px] border border-[var(--color-border-default)] bg-white px-2 text-[13px] font-bold text-[var(--color-text-primary)] outline-none focus:border-[var(--color-brand-600)]"
              />
            </label>
            <label className="grid gap-1 text-[11px] font-bold text-[var(--color-text-tertiary)]">
              開始日
              <input
                type="date"
                value={eventStartDate}
                onChange={(event) => setEventStartDate(event.target.value)}
                className="h-9 rounded-[4px] border border-[var(--color-border-default)] bg-white px-2 text-[13px] font-bold text-[var(--color-text-primary)] outline-none focus:border-[var(--color-brand-600)]"
              />
            </label>
            <label className="grid gap-1 text-[11px] font-bold text-[var(--color-text-tertiary)]">
              終了日
              <input
                type="date"
                value={eventEndDate}
                onChange={(event) => setEventEndDate(event.target.value)}
                className="h-9 rounded-[4px] border border-[var(--color-border-default)] bg-white px-2 text-[13px] font-bold text-[var(--color-text-primary)] outline-none focus:border-[var(--color-brand-600)]"
              />
            </label>
            <button
              type="button"
              onClick={loadEvents}
              disabled={eventsLoading}
              className="mt-auto inline-flex h-9 items-center justify-center gap-1.5 rounded-[4px] bg-[var(--color-brand-700)] px-4 text-[12px] font-bold text-white disabled:opacity-60"
            >
              {eventsLoading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Search className="h-3.5 w-3.5" />}
              抽出
            </button>
          </div>
          <div className="flex flex-wrap items-center gap-2 text-[11px] font-bold text-[var(--color-text-tertiary)]">
            <span className="rounded-[4px] border border-[var(--color-border-default)] bg-white px-2 py-1">
              {selectedHorizonIsKnown ? 'forward_extrema' : 'オンデマンド'} / 表示12件
            </span>
            {eventsSource && <span>{eventsSource === 'forward_extrema' ? '計算済みhorizon' : '任意horizon'}</span>}
          </div>
          {events.length > 0 && (
            <div className="max-h-[360px] overflow-auto rounded-[4px] border border-[var(--color-border-default)] bg-white">
              <table className="w-full min-w-[760px] text-left text-[12px]">
                <thead className="sticky top-0 bg-[var(--color-surface-subtle)] text-[11px] text-[var(--color-text-tertiary)]">
                  <tr>
                    <th className="px-3 py-2">銘柄</th>
                    <th className="px-3 py-2">発生日</th>
                    <th className="px-3 py-2">達成</th>
                    <th className="px-3 py-2">期間内</th>
                    <th className="px-3 py-2">基準期間</th>
                    <th className="px-3 py-2"></th>
                  </tr>
                </thead>
                <tbody>
                  {events.map((event) => (
                    <tr key={`${event.ticker}-${event.sourceDate}-${event.horizonDays}-${event.direction}`} className="border-t border-[var(--color-border-default)]">
                      <td className="px-3 py-2">
                        <div className="font-mono font-black text-[var(--color-brand-900)]">{event.ticker}</div>
                        <div className="text-[11px] font-bold text-[var(--color-text-tertiary)]">{event.name ?? event.sector17Name ?? '-'}</div>
                      </td>
                      <td className="px-3 py-2 font-bold">{event.sourceDate}</td>
                      <td className="px-3 py-2">
                        <div className={event.direction === 'up' ? 'font-black text-[var(--color-market-red)]' : 'font-black text-[var(--color-market-blue)]'}>
                          {fmtPct(event.reachedPct)}
                        </div>
                        <div className="text-[11px] font-bold text-[var(--color-text-tertiary)]">
                          {event.reachedDate ?? '-'} / {event.reachedDays ?? '-'}日
                        </div>
                      </td>
                      <td className="px-3 py-2 text-[11px] font-bold text-[var(--color-text-secondary)]">
                        最大 {fmtPct(event.maxReturnPct)} / 最小 {fmtPct(event.minReturnPct)}
                      </td>
                      <td className="px-3 py-2 text-[11px] font-bold text-[var(--color-text-secondary)]">
                        {event.patternStartDate}〜{event.patternEndDate}
                      </td>
                      <td className="px-3 py-2 text-right">
                        <button
                          type="button"
                          onClick={() => useEvent(event)}
                          className="inline-flex items-center gap-1 rounded-[4px] border border-[var(--color-border-default)] bg-white px-2 py-1 text-[11px] font-bold text-[var(--color-brand-900)] hover:bg-[var(--color-surface-subtle)]"
                        >
                          検索
                          <ArrowRight className="h-3 w-3" />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {error && (
        <div className="rounded-[4px] border border-[var(--color-market-blue)] bg-[rgba(37,99,235,0.07)] px-3 py-2 text-[12px] font-bold text-[var(--color-market-blue)]">
          {error}
        </div>
      )}

      {result && (
        <div className="grid gap-4 xl:grid-cols-[minmax(0,0.95fr)_minmax(0,1.35fr)]">
          <div className="grid gap-3 rounded-[4px] border border-[var(--color-border-default)] bg-[var(--color-surface-subtle)] p-3">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div>
                <div className="text-[13px] font-black text-[var(--color-brand-900)]">
                  {result.reference.ticker} {result.reference.name ?? ''}
                </div>
                <div className="mt-1 text-[11px] font-bold text-[var(--color-text-tertiary)]">
                  {result.reference.startDate}〜{result.reference.endDate} / {result.reference.featureDays}営業日
                </div>
              </div>
              <div>{stageTags(result.reference.profile.stageCode)}</div>
            </div>
            {result.reference.chart.series.length > 0 && (
              <div className="rounded-[4px] border border-[var(--color-border-default)] bg-white p-2">
                <BacktestHighlightChart
                  series={result.reference.chart.series}
                  highlightStart={result.reference.chart.highlightStart}
                  highlightEnd={result.reference.chart.highlightEnd}
                  direction={result.reference.chart.returnPct != null && result.reference.chart.returnPct < 0 ? 'down' : 'up'}
                  stagePath={result.reference.chart.stagePath}
                  startPrice={result.reference.chart.startPrice}
                  endPrice={result.reference.chart.endPrice}
                  returnPct={result.reference.chart.returnPct}
                  height={240}
                />
              </div>
            )}
            <div className="grid grid-cols-2 gap-2">
              <Metric label="終値" value={fmtPrice(result.reference.profile.close)} />
              <Metric label="期間騰落" value={fmtPct(result.reference.chart.returnPct)} />
              <Metric label="5SMA速度" value={fmtPct(result.reference.profile.sma5Velocity5)} />
              <Metric label="5-25距離" value={fmtPct(result.reference.profile.gap5To25Pct)} />
            </div>
            {result.reference.outcomes.length > 0 && (
              <div className="grid gap-1 text-[11px] font-bold text-[var(--color-text-secondary)]">
                {result.reference.outcomes.slice(0, 6).map((outcome) => (
                  <div key={outcome.horizon_days} className="flex justify-between gap-2 rounded-[4px] bg-white px-2 py-1">
                    <span>{outcome.horizon_days}日</span>
                    <span>最大 {fmtPct(outcome.max_return_pct)} / 最小 {fmtPct(outcome.min_return_pct)}</span>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="grid gap-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="text-[12px] font-black text-[var(--color-brand-900)]">
                現在の類似候補 {result.count}件
              </div>
              <div className="text-[11px] font-bold text-[var(--color-text-tertiary)]">
                {result.currentStartDate}〜{result.currentEndDate}
              </div>
            </div>
            {result.matches.length === 0 && (
              <div className="rounded-[4px] border border-[var(--color-border-default)] bg-white px-3 py-6 text-center text-[12px] font-bold text-[var(--color-text-tertiary)]">
                該当する類似候補はありません
              </div>
            )}
            {result.matches.map((match) => (
              <div key={`${match.ticker}-${match.rank}`} className="rounded-[4px] border border-[var(--color-border-default)] bg-white p-3">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div>
                    <Link href={`/stock/${match.ticker}`} className="font-mono text-[13px] font-black text-[var(--color-brand-900)] hover:underline">
                      {match.ticker}
                    </Link>
                    <span className="ml-2 text-[12px] font-bold text-[var(--color-text-primary)]">{match.name ?? ''}</span>
                    <div className="mt-1 text-[11px] font-bold text-[var(--color-text-tertiary)]">
                      {match.sector17Name ?? match.sector33Name ?? '-'} / {trendLabel(match.profile.trend)}
                    </div>
                  </div>
                  <div className="grid justify-items-end gap-1">
                    <div className="text-[18px] font-black text-[var(--color-market-red)]">{Math.round(match.similarityScore * 100)}%</div>
                    <div>{stageTags(match.profile.stageCode)}</div>
                  </div>
                </div>
                <div className="mt-3 grid grid-cols-2 gap-2 md:grid-cols-4">
                  <Metric label="平均" value={`${Math.round(match.averageScore * 100)}%`} />
                  <Metric label="最終日" value={`${Math.round(match.finalScore * 100)}%`} />
                  <Metric label="流れ" value={`${Math.round(match.trajectoryScore * 100)}%`} />
                  <Metric label="ステージ" value={`${Math.round(match.stagePathScore * 100)}%`} />
                </div>
                <div className="mt-3 grid gap-1 text-[11px] font-semibold leading-relaxed text-[var(--color-text-secondary)]">
                  {['stage', 'maAngle', 'maAcceleration', 'maDistance', 'maDistanceFlow', 'pricePosition', 'context', 'risk'].map((key) => (
                    match.reason[key] ? <span key={key}>{match.reason[key]}</span> : null
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
