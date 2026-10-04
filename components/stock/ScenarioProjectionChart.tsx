'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import {
  createChart,
  createSeriesMarkers,
  CandlestickSeries,
  LineSeries,
  LineStyle,
  ColorType,
  type IChartApi,
  type UTCTimestamp,
} from 'lightweight-charts'
import type { OHLCV } from '@/types/stock'
import { movingAverageColor } from '@/lib/chart-colors'
import type { MarketCode } from '@/lib/markets'
import type { ChartIntervalCode } from '@/lib/timeframes'
import { ScoreRuler, StackedShareBar } from '@/components/stock/StockAnalysisVisuals'

type ScenarioInterval = ChartIntervalCode
type ProjectionDirection = 'up' | 'down' | 'range'
type SummaryDirection = ProjectionDirection | 'mixed'

interface ProjectionPoint {
  date: string
  value: number
}

interface ProjectionScenario {
  id: string
  type: string
  direction: ProjectionDirection
  label: string
  score: number
  relativeWeightPct: number
  probabilityRank: number
  scoreBreakdown: ScenarioScoreBreakdown[]
  targetPrice: number | null
  stopPrice: number | null
  upperGuidePrice: number | null
  lowerGuidePrice: number | null
  reboundLine: string | null
  invalidation: string
  thesis: string
  narrative: string
  evidence: string[]
  points: ProjectionPoint[]
}

interface ScenarioScoreBreakdown {
  key: string
  label: string
  value: number
  max: number
  detail: string
  availability: 'available' | 'unavailable'
}

interface ProjectionResponse {
  ok: true
  ticker: string
  interval: ScenarioInterval
  horizonDays: number
  message?: string
  baseDate: string
  basePrice: number
  statusLabel: string
  sourceDates: {
    price: string
    feature: string | null
    featureDerived?: boolean
    physicalMomentum: string | null
    calibration: string | null
    physicsCandidates: string | null
  }
  chart: {
    candles: OHLCV[]
    ma: Record<string, ProjectionPoint[]>
  }
  realized?: {
    complete: boolean
    observedDays: number
    latestDate: string | null
    latestPrice: number | null
    returnPct: number | null
    maxReturnPct: number | null
    minReturnPct: number | null
    points: ProjectionPoint[]
  }
  stats: {
    recentHigh: number | null
    recentLow: number | null
    atrPct: number | null
    ma5: number | null
    ma25: number | null
    ma75: number | null
    ma200: number | null
    pms: number | null
    pfs: number | null
    pes: number | null
    hitRate: number | null
    baseRate: number | null
    lift: number | null
    avgMaxReturnPct: number | null
    avgMinReturnPct: number | null
  }
  scenarios: ProjectionScenario[]
  note: string
  llmNarrative?: {
    attempted: boolean
    used: boolean
    model: string | null
    reason?: string
  }
}

interface ScenarioProjectionChartProps {
  ticker: string
  name: string
  analysisDate?: string | null
  showActual?: boolean
  market?: MarketCode
  onUseLatest?: () => void
}

const TABS: Array<{ interval: ScenarioInterval; label: string; horizonDays: number; note: string }> = [
  { interval: 'D', label: '日足', horizonDays: 5, note: '5営業日' },
  { interval: '2D', label: '2日足', horizonDays: 10, note: '10営業日' },
  { interval: 'W', label: '週足', horizonDays: 20, note: '20営業日' },
  { interval: '2W', label: '2週足', horizonDays: 40, note: '40営業日' },
  { interval: 'M', label: '月足', horizonDays: 60, note: '60営業日' },
  { interval: '2M', label: '2ヶ月足', horizonDays: 120, note: '120営業日' },
]

function dateToTime(date: string): UTCTimestamp {
  return Math.floor(new Date(`${date}T00:00:00Z`).getTime() / 1000) as UTCTimestamp
}

function fmtPrice(value: number | null | undefined, market: MarketCode = 'JP'): string {
  if (value == null || !Number.isFinite(value)) return '-'
  if (market === 'US') {
    return `$${value.toLocaleString('en-US', { maximumFractionDigits: 2 })}`
  }
  return `${value.toLocaleString('ja-JP', { maximumFractionDigits: 1 })}円`
}

function fmtPercent(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '-'
  return `${value >= 0 ? '+' : ''}${value.toFixed(2)}%`
}

function fmtScore(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '-'
  return value.toFixed(2)
}

function fmtContribution(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '-'
  return `${value >= 0 ? '+' : ''}${value.toFixed(1)}`
}

function confidenceLabel(score: number): string {
  if (score >= 80) return '高'
  if (score >= 60) return '中'
  return '低'
}

function scenarioTone(direction: ProjectionDirection, rank: number) {
  const opacity = rank <= 3 ? 1 : rank <= 5 ? 0.74 : 0.55
  if (direction === 'up') return { color: `rgba(220, 38, 38, ${opacity})`, bg: 'rgba(220, 38, 38, 0.06)', border: 'rgba(220, 38, 38, 0.24)' }
  if (direction === 'down') return { color: `rgba(37, 99, 235, ${opacity})`, bg: 'rgba(37, 99, 235, 0.06)', border: 'rgba(37, 99, 235, 0.24)' }
  return { color: `rgba(107, 114, 128, ${opacity})`, bg: 'rgba(245, 158, 11, 0.08)', border: 'rgba(245, 158, 11, 0.26)' }
}

function scenarioLineStyle(scenario: ProjectionScenario) {
  const tone = scenarioTone(scenario.direction, scenario.probabilityRank)
  return {
    ...tone,
    lineWidth: scenario.probabilityRank <= 3 ? 2 as const : 1 as const,
  }
}

function directionLabel(direction: ProjectionDirection): string {
  if (direction === 'up') return '上昇'
  if (direction === 'down') return '下落'
  return '横ばい'
}

function toTradeDirection(direction: ProjectionDirection): 'bullish' | 'bearish' | 'watch' {
  if (direction === 'up') return 'bullish'
  if (direction === 'down') return 'bearish'
  return 'watch'
}

function summaryTone(direction: SummaryDirection) {
  if (direction === 'up') return { color: '#dc2626', bg: 'rgba(220, 38, 38, 0.07)', border: 'rgba(220, 38, 38, 0.24)' }
  if (direction === 'down') return { color: '#2563eb', bg: 'rgba(37, 99, 235, 0.07)', border: 'rgba(37, 99, 235, 0.24)' }
  if (direction === 'range') return { color: '#b45309', bg: 'rgba(245, 158, 11, 0.10)', border: 'rgba(245, 158, 11, 0.28)' }
  return { color: 'var(--text-secondary)', bg: 'var(--surface-muted)', border: 'var(--border-subtle)' }
}

function buildDirectionSummary(data: ProjectionResponse) {
  const totals: Record<ProjectionDirection, number> = { up: 0, down: 0, range: 0 }
  for (const scenario of data.scenarios) {
    totals[scenario.direction] += scenario.relativeWeightPct
  }
  const ranked = (Object.entries(totals) as Array<[ProjectionDirection, number]>).sort((a, b) => b[1] - a[1])
  const [leader, leaderPct] = ranked[0] ?? ['range', 0]
  const secondPct = ranked[1]?.[1] ?? 0
  const gap = leaderPct - secondPct
  const primary: SummaryDirection = leaderPct < 38 || gap < 6 ? 'mixed' : leader
  const primaryLabel: Record<SummaryDirection, string> = {
    up: '上昇方向の比重が最大',
    down: '下落方向の比重が最大',
    range: '横ばいの比重が最大',
    mixed: '方向別の比重は拮抗',
  }

  return {
    primary,
    headline: primaryLabel[primary],
    totals,
  }
}

function ScenarioCanvas({ data, market }: { data: ProjectionResponse; market: MarketCode }) {
  const containerRef = useRef<HTMLDivElement>(null)
  const chartRef = useRef<IChartApi | null>(null)

  useEffect(() => {
    if (!containerRef.current || data.chart.candles.length === 0) return
    if (chartRef.current) {
      chartRef.current.remove()
      chartRef.current = null
    }

    const chart = createChart(containerRef.current, {
      width: containerRef.current.clientWidth,
      height: 420,
      layout: {
        background: { type: ColorType.Solid, color: '#ffffff' },
        textColor: '#525252',
        fontSize: 11,
      },
      grid: {
        vertLines: { color: 'rgba(0,0,0,0.04)' },
        horzLines: { color: 'rgba(0,0,0,0.04)' },
      },
      timeScale: {
        borderColor: 'rgba(0,0,0,0.10)',
        timeVisible: false,
      },
      rightPriceScale: {
        borderColor: 'rgba(0,0,0,0.10)',
      },
      crosshair: { mode: 1 },
    })

    const candleSeries = chart.addSeries(CandlestickSeries, {
      upColor: '#dc2626',
      downColor: '#2563eb',
      borderUpColor: '#dc2626',
      borderDownColor: '#2563eb',
      wickUpColor: '#dc2626',
      wickDownColor: '#2563eb',
    })
    candleSeries.setData(data.chart.candles.map((row) => ({
      time: dateToTime(row.date),
      open: row.open,
      high: row.high,
      low: row.low,
      close: row.close,
    })))
    if (data.realized?.points.length) {
      createSeriesMarkers(candleSeries, [{
        time: dateToTime(data.baseDate),
        position: 'aboveBar',
        color: '#047857',
        shape: 'square',
        text: '分析基準',
      }])
    }

    for (const [period, points] of Object.entries(data.chart.ma)) {
      const series = chart.addSeries(LineSeries, {
        color: movingAverageColor(period),
        lineWidth: 1,
        priceLineVisible: false,
        lastValueVisible: false,
      })
      series.setData(points.map((point) => ({ time: dateToTime(point.date), value: point.value })))
    }

    for (const scenario of data.scenarios) {
      const tone = scenarioLineStyle(scenario)
      const series = chart.addSeries(LineSeries, {
        color: tone.color,
        lineWidth: tone.lineWidth,
        lineStyle: LineStyle.Dashed,
        priceLineVisible: false,
        lastValueVisible: false,
      })
      series.setData(scenario.points.map((point) => ({ time: dateToTime(point.date), value: point.value })))
    }

    if (data.realized?.points.length) {
      const realizedSeries = chart.addSeries(LineSeries, {
        color: '#047857',
        lineWidth: 3,
        lineStyle: LineStyle.Solid,
        priceLineVisible: false,
        lastValueVisible: true,
        title: '事後実績',
      })
      realizedSeries.setData(data.realized.points.map((point) => ({
        time: dateToTime(point.date),
        value: point.value,
      })))
    }

    chart.timeScale().fitContent()
    chartRef.current = chart
    const resize = () => {
      if (containerRef.current && chartRef.current) {
        chartRef.current.applyOptions({ width: containerRef.current.clientWidth })
      }
    }
    window.addEventListener('resize', resize)
    return () => {
      window.removeEventListener('resize', resize)
      if (chartRef.current) {
        chartRef.current.remove()
        chartRef.current = null
      }
    }
  }, [data])

  const rankedScenarios = [...data.scenarios].sort((a, b) => a.probabilityRank - b.probabilityRank)

  return (
    <>
      <div style={chartWrapStyle}>
      <div ref={containerRef} style={{ height: 420, width: '100%' }} />
      <div style={chartOverlayBadgeStyle}>
        点線は将来シナリオ
        {data.realized?.points.length ? ' / 緑実線は事後実績' : ''}
        {' / '}基準 {data.baseDate} {fmtPrice(data.basePrice, market)}
      </div>
      </div>
      <ol style={scenarioRailStyle} aria-label="シナリオ順位（チャート線の凡例）">
        {rankedScenarios.map((scenario) => {
          const tone = scenarioLineStyle(scenario)
          return (
            <li
              key={scenario.id}
              style={{ ...scenarioRailItemStyle, borderColor: tone.color, color: tone.color }}
              title={`#${scenario.probabilityRank} ${directionLabel(scenario.direction)} ${scenario.label} / score ${scenario.score}`}
            >
              <span style={{ ...endpointLabelNumberStyle, background: tone.color }}>#{scenario.probabilityRank}</span>
              <span style={scenarioRailLabelStyle}>{scenario.label}</span>
              <span style={scenarioRailScoreStyle}>{scenario.score}</span>
            </li>
          )
        })}
      </ol>
    </>
  )
}

type RefreshSource = 'initial' | 'auto' | 'manual'

export function ScenarioProjectionChart({
  ticker,
  name,
  analysisDate,
  showActual = false,
  market = 'JP',
  onUseLatest,
}: ScenarioProjectionChartProps) {
  const [activeTab, setActiveTab] = useState(TABS[0])
  const [data, setData] = useState<ProjectionResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [savingId, setSavingId] = useState<string | null>(null)
  const [savedIds, setSavedIds] = useState<Set<string>>(new Set())
  const [message, setMessage] = useState('')
  const [refreshNonce, setRefreshNonce] = useState(0)
  const [refreshNotice, setRefreshNotice] = useState('')
  const refreshSourceRef = useRef<RefreshSource>('initial')

  useEffect(() => {
    if (analysisDate) return
    const refreshLatest = () => {
      refreshSourceRef.current = 'auto'
      setRefreshNonce((value) => value + 1)
    }
    const onVisibility = () => {
      if (document.visibilityState === 'visible') refreshLatest()
    }
    window.addEventListener('focus', refreshLatest)
    document.addEventListener('visibilitychange', onVisibility)
    const timer = window.setInterval(refreshLatest, 10 * 60 * 1000)
    return () => {
      window.removeEventListener('focus', refreshLatest)
      document.removeEventListener('visibilitychange', onVisibility)
      window.clearInterval(timer)
    }
  }, [analysisDate])

  useEffect(() => {
    let cancelled = false
    const requestDate = analysisDate
    const isManualRefresh = refreshSourceRef.current === 'manual'
    setLoading(true)
    setError('')
    setMessage('')
    if (isManualRefresh) {
      setRefreshNotice('最新データでシナリオを再生成中...')
      refreshSourceRef.current = 'initial'
    } else if (requestDate) {
      setRefreshNotice('')
    }
    const params = new URLSearchParams({
      market,
      interval: activeTab.interval,
      horizonDays: String(activeTab.horizonDays),
      limit: '8',
    })
    if (requestDate) params.set('date', requestDate)
    if (requestDate && showActual) params.set('actual', '1')
    if (!requestDate || isManualRefresh) params.set('_ts', String(Date.now()))
    fetch(`/api/stock-scenario-projections/${encodeURIComponent(ticker)}?${params.toString()}`, { cache: 'no-store' })
      .then((res) => res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`)))
      .then((payload) => {
        if (!cancelled) {
          setData(payload)
          if (isManualRefresh) {
            setRefreshNotice(`最新データで再生成しました。基準 ${payload.baseDate ?? payload.sourceDates?.price ?? '-'}。`)
          }
        }
      })
      .catch((e) => {
        if (!cancelled) {
          setError((e as Error).message)
          if (isManualRefresh) setRefreshNotice('')
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => { cancelled = true }
  }, [ticker, activeTab, analysisDate, showActual, market, refreshNonce])

  function regenerateLatest() {
    refreshSourceRef.current = 'manual'
    onUseLatest?.()
    setError('')
    setMessage('')
    setRefreshNonce((value) => value + 1)
  }

  const scenarios = Array.isArray(data?.scenarios) ? data.scenarios : []
  const topScenario = scenarios[0] ?? null
  const realizedDirection: ProjectionDirection | null = data?.realized?.returnPct == null
    ? null
    : data.realized.returnPct > 1
      ? 'up'
      : data.realized.returnPct < -1
        ? 'down'
        : 'range'
  const sourceText = useMemo(() => {
    if (!data) return ''
    const sourceDates = data.sourceDates
    const priceDate = sourceDates?.price ?? data.baseDate ?? '-'
    const parts = [
      `価格 ${priceDate}`,
      sourceDates?.feature
        ? `特徴量 ${sourceDates.featureDerived ? '最新足から再計算' : sourceDates.feature}`
        : null,
      sourceDates?.physicalMomentum && sourceDates.physicalMomentum !== priceDate
        ? `PMS ${sourceDates.physicalMomentum}`
        : null,
      sourceDates?.calibration ? `検証 ${sourceDates.calibration}` : null,
      data.llmNarrative?.used ? `AI説明 ${data.llmNarrative.model}` : 'ルールベース説明',
    ].filter(Boolean)
    return parts.join(' / ')
  }, [data])

  async function saveScenario(scenario: ProjectionScenario) {
    if (!data) return
    setSavingId(scenario.id)
    setMessage('')
    setError('')
    try {
      const body = {
        ticker,
        market,
        name,
        direction: toTradeDirection(scenario.direction),
        confidence: scenario.score >= 70 ? 'high' : scenario.score >= 50 ? 'medium' : 'low',
        anchorDate: data.baseDate,
        horizonDays: data.horizonDays,
        entryPlanPrice: data.basePrice,
        targetPrice: scenario.direction === 'range' ? null : scenario.targetPrice,
        stopLossPrice: scenario.stopPrice,
        thesis: [
          `自動生成: ${scenario.label}`,
          scenario.narrative,
          `根拠: ${scenario.evidence.join(' / ')}`,
        ].join('\n'),
        invalidation: scenario.invalidation,
        sourceRangeLabel: `シナリオチャート ${activeTab.label} ${activeTab.note}`,
        context: {
          scenarioProjection: {
            id: scenario.id,
            interval: data.interval,
            horizonDays: data.horizonDays,
            score: scenario.score,
            relativeWeightPct: scenario.relativeWeightPct,
            scoreBreakdown: scenario.scoreBreakdown,
            type: scenario.type,
            direction: scenario.direction,
            upperGuidePrice: scenario.upperGuidePrice,
            lowerGuidePrice: scenario.lowerGuidePrice,
            sourceDates: data.sourceDates,
            analysisDate,
          },
        },
      }
      const res = await fetch('/api/trade/scenarios', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const payload = await res.json()
      if (!res.ok) throw new Error(payload.message ?? payload.error ?? `HTTP ${res.status}`)
      setSavedIds((prev) => new Set([...prev, scenario.id]))
      setMessage('シナリオメモに保存しました。')
      window.dispatchEvent(new CustomEvent('trade-scenario-saved', { detail: { ticker, market, scenarioId: payload.scenario?.id } }))
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setSavingId(null)
    }
  }

  return (
    <section className="card" style={sectionStyle}>
      <div style={headerStyle}>
        <div className="section-header" style={headerTitleStyle}>
          シナリオ
          {analysisDate && <span className="ml-2 font-mono text-[11px] font-semibold text-[var(--text-muted)]">{analysisDate}以前に固定</span>}
        </div>
        <span style={badgeStyle}>将来を断定するものではありません</span>
      </div>

      <div style={horizonLabelStyle}>評価する期間</div>
      <div style={tabRowStyle} role="group" aria-label="評価する期間">
        {TABS.map((tab) => (
          <button
            key={tab.interval}
            type="button"
            onClick={() => setActiveTab(tab)}
            style={tabButtonStyle(tab.interval === activeTab.interval)}
            aria-pressed={tab.interval === activeTab.interval}
          >
            <strong>{tab.label}</strong>
            <span>{tab.note}</span>
          </button>
        ))}
      </div>

      {loading ? (
        <div style={emptyStyle}>シナリオを生成中…</div>
      ) : error ? (
        <div style={{ ...emptyStyle, color: 'var(--price-down)' }}>シナリオを取得できませんでした({error})</div>
      ) : !data || scenarios.length === 0 ? (
        <div style={emptyStyle}>{data?.message ?? '価格データが不足しているため、シナリオを表示できません。'}</div>
      ) : (
        <div style={loadedStackStyle}>
          <DirectionSummaryPanel data={data} />
          <div style={chartPanelStyle}>
              <div style={summaryBarStyle}>
                <strong>{data.statusLabel}</strong>
                <span>{sourceText}</span>
              </div>
              <div style={freshnessNoticeStyle(data.sourceDates.featureDerived === true)}>
                {data.sourceDates.featureDerived
                  ? `物理状態を ${data.sourceDates.price} の足から再計算`
                  : `保存済み物理特徴量・${data.sourceDates.price} 基準`}
                <button type="button" onClick={regenerateLatest} style={refreshButtonStyle}>
                  {analysisDate ? '最新モードへ' : '最新で再生成'}
                </button>
              </div>
              {refreshNotice && <div style={refreshNoticeStyle}>{refreshNotice}</div>}
              {data.realized && (
                <div className="grid gap-2 border border-emerald-200 bg-emerald-50 p-2.5 sm:grid-cols-[minmax(0,1fr)_repeat(3,minmax(84px,auto))]">
                  <div>
                    <div className="text-[11px] font-black text-emerald-900">事後実績との照合</div>
                    <div className="mt-1 text-[10px] font-bold leading-5 text-emerald-800">
                      {data.realized.observedDays === 0
                        ? '基準日後の価格はまだありません。'
                        : `${data.realized.observedDays}営業日を観測。最上位シナリオ「${topScenario?.label ?? '-'}」との方向${
                          realizedDirection && topScenario?.direction === realizedDirection ? 'は一致' : 'は不一致または中立'
                        }です。`}
                    </div>
                  </div>
                  <Metric label="実績騰落率" value={fmtPercent(data.realized.returnPct)} />
                  <Metric label="期間内上値" value={fmtPercent(data.realized.maxReturnPct)} />
                  <Metric label="期間内下値" value={fmtPercent(data.realized.minReturnPct)} />
                </div>
              )}
              <ScenarioCanvas data={data} market={market} />
              <div style={legendStyle}>
                <span><i style={{ background: '#dc2626' }} />上昇</span>
                <span><i style={{ background: '#f59e0b' }} />横ばい</span>
                <span><i style={{ background: '#2563eb' }} />下落</span>
                {data.realized?.points.length ? <span><i style={{ background: '#047857' }} />事後実績</span> : null}
                <span>#n = 下のシナリオ順位</span>
              </div>
              <p style={noteStyle}>{data.note}</p>
          </div>
          <CalibrationStrip stats={data.stats} calibrationDate={data.sourceDates.calibration} />
          {message && <div style={messageStyle}>{message}</div>}
          {topScenario && (
            <LeadScenarioMatrix
              scenario={topScenario}
              data={data}
              market={market}
              saved={savedIds.has(topScenario.id)}
              saving={savingId === topScenario.id}
              onSave={() => saveScenario(topScenario)}
            />
          )}
          {scenarios.length > 1 && (
            <div className="grid gap-1.5" aria-label="その他のシナリオ">
              {scenarios.slice(1, 3).map((scenario) => (
                <CompactScenarioRow
                  key={scenario.id}
                  scenario={scenario}
                  market={market}
                  saved={savedIds.has(scenario.id)}
                  saving={savingId === scenario.id}
                  onSave={() => saveScenario(scenario)}
                />
              ))}
              {scenarios.length > 3 && (
                <details className="border border-[var(--border-subtle)] bg-[var(--bg-elevated)]">
                  <summary className="flex min-h-9 cursor-pointer items-center px-3 text-[10px] font-black text-[var(--text-secondary)]">
                    その他のシナリオ {scenarios.length - 3}件
                    {scenarios.slice(3).some((scenario) => scenario.scoreBreakdown.some((part) => part.availability === 'unavailable')) && (
                      <span className="ml-2 font-semibold text-[var(--text-muted)]">判定不能の入力あり</span>
                    )}
                  </summary>
                  <div className="grid gap-1.5 border-t border-[var(--border-subtle)] p-1.5">
                    {scenarios.slice(3).map((scenario) => (
                      <CompactScenarioRow
                        key={scenario.id}
                        scenario={scenario}
                        market={market}
                        saved={savedIds.has(scenario.id)}
                        saving={savingId === scenario.id}
                        onSave={() => saveScenario(scenario)}
                      />
                    ))}
                  </div>
                </details>
              )}
            </div>
          )}
        </div>
      )}
    </section>
  )
}

function DirectionSummaryPanel({ data }: { data: ProjectionResponse }) {
  const summary = buildDirectionSummary(data)
  const tone = summaryTone(summary.primary)
  return (
    <div className="grid gap-2 border p-3" style={{ borderColor: tone.border, background: tone.bg }}>
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
        <strong className="text-[16px] font-black" style={{ color: tone.color }}>{summary.headline}</strong>
        <span className="text-[10px] font-semibold text-[var(--text-muted)]">方向別の相対ウェイト合計</span>
      </div>
      <StackedShareBar
        segments={[
          { key: 'up', label: '上昇', value: summary.totals.up, color: '#dc2626' },
          { key: 'range', label: '横ばい', value: summary.totals.range, color: '#b45309' },
          { key: 'down', label: '下落', value: summary.totals.down, color: '#2563eb' },
        ]}
      />
    </div>
  )
}

function CalibrationStrip({ stats, calibrationDate }: { stats: ProjectionResponse['stats']; calibrationDate: string | null }) {
  const pct = (value: number | null) => (value == null || !Number.isFinite(value) ? null : `${(value * 100).toFixed(0)}%`)
  const items = [
    { label: '的中率', value: pct(stats.hitRate), ratio: stats.hitRate },
    { label: '基準率', value: pct(stats.baseRate), ratio: stats.baseRate },
    { label: 'lift', value: stats.lift == null ? null : `×${stats.lift.toFixed(2)}`, ratio: null },
    { label: '平均最大上昇', value: stats.avgMaxReturnPct == null ? null : fmtPercent(stats.avgMaxReturnPct), ratio: null },
    { label: '平均最大下落', value: stats.avgMinReturnPct == null ? null : fmtPercent(stats.avgMinReturnPct), ratio: null },
    { label: 'ATR', value: stats.atrPct == null ? null : `${stats.atrPct.toFixed(2)}%`, ratio: null },
  ].filter((item) => item.value != null)
  if (items.length === 0) return null
  return (
    <section className="border border-[var(--border-subtle)] bg-white" aria-label="過去検証の保存値">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--border-subtle)] px-3 py-1.5 text-[10px] font-black text-[var(--text-secondary)]">
        <span>過去検証(保存値)</span>
        <span className="font-mono font-semibold text-[var(--text-muted)]">{calibrationDate ? `検証 ${calibrationDate}` : '検証日なし'}</span>
      </div>
      <div className="grid grid-cols-2 gap-px bg-[var(--border-subtle)] sm:grid-cols-3 lg:grid-cols-6">
        {items.map((item) => (
          <div key={item.label} className="min-w-0 bg-white px-3 py-2">
            <div className="text-[9px] font-bold text-[var(--text-muted)]">{item.label}</div>
            <div className="mt-0.5 font-mono text-[14px] font-black text-[var(--text-primary)]">{item.value}</div>
            <div className="mt-1 h-1 bg-[var(--bg-elevated)]" aria-hidden="true">
              {item.ratio != null && <div className="h-full bg-[var(--color-brand-700)]" style={{ width: `${Math.min(100, Math.max(0, item.ratio * 100))}%` }} />}
            </div>
          </div>
        ))}
      </div>
    </section>
  )
}

function ScoreRow({ part }: { part: ScenarioScoreBreakdown }) {
  if (part.availability === 'unavailable') {
    return (
      <div className="grid min-h-7 grid-cols-[minmax(0,1fr)_auto] items-center gap-2" title={part.detail}>
        <span className="truncate text-[10px] font-bold text-[var(--text-secondary)]">{part.label}</span>
        <strong className="text-right text-[10px] font-black text-[var(--text-muted)]">判定不能</strong>
      </div>
    )
  }
  const positive = part.value >= 0
  const ratio = Math.min(1, Math.abs(part.value) / Math.max(1, part.max))
  return (
    <div className="grid h-6 grid-cols-[minmax(0,1fr)_minmax(56px,.8fr)_56px] items-center gap-2" title={part.detail}>
      <span className="truncate text-[10px] font-bold text-[var(--text-secondary)]">{part.label}</span>
      <span className="block h-2 bg-[var(--bg-elevated)]" aria-hidden="true">
        <span className="block h-full" style={{ width: `${ratio * 100}%`, background: positive ? 'rgba(220, 38, 38, 0.7)' : 'rgba(37, 99, 235, 0.7)' }} />
      </span>
      <strong className="text-right font-mono text-[10px] font-black" style={{ color: positive ? 'var(--price-up)' : 'var(--price-down)' }}>
        {fmtContribution(part.value)}<span className="font-semibold text-[var(--text-muted)]">/{part.max}</span>
      </strong>
    </div>
  )
}

function PriceLadder({ scenario, basePrice, market }: { scenario: ProjectionScenario; basePrice: number; market: MarketCode }) {
  const levels = [
    { key: 'upper', label: '上値', price: scenario.upperGuidePrice, color: '#9ca3af' },
    { key: 'target', label: '目標', price: scenario.targetPrice, color: '#047857' },
    { key: 'base', label: '基準', price: basePrice, color: 'var(--text-primary)' },
    { key: 'stop', label: '見直し', price: scenario.stopPrice, color: '#b45309' },
    { key: 'lower', label: '下値', price: scenario.lowerGuidePrice, color: '#9ca3af' },
  ].flatMap((level) => (level.price == null || !Number.isFinite(level.price) ? [] : [{ ...level, price: level.price }]))
    .sort((a, b) => b.price - a.price)
  const min = Math.min(...levels.map((level) => level.price))
  const max = Math.max(...levels.map((level) => level.price))
  return (
    <div className="divide-y divide-[var(--border-subtle)] border-y border-[var(--border-subtle)]">
      {levels.map((level) => {
        const ratio = max === min ? 0.5 : (level.price - min) / (max - min)
        return (
          <div key={level.key} className="grid h-6 grid-cols-[40px_minmax(0,1fr)_72px] items-center gap-2">
            <span className={`text-[10px] ${level.key === 'base' ? 'font-black text-[var(--text-primary)]' : 'font-bold text-[var(--text-muted)]'}`}>{level.label}</span>
            <span className="relative block h-3" aria-hidden="true">
              <span className="absolute inset-x-0 top-1/2 h-px bg-[var(--border-subtle)]" />
              <span
                className="absolute top-1/2 h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full border border-white ring-1 ring-[var(--border-subtle)]"
                style={{ left: `calc(6px + (100% - 12px) * ${ratio})`, background: level.color }}
              />
            </span>
            <strong className="truncate text-right font-mono text-[10px] font-black text-[var(--text-primary)]">{fmtPrice(level.price, market)}</strong>
          </div>
        )
      })}
    </div>
  )
}

function RankChip({ scenario, color }: { scenario: ProjectionScenario; color: string }) {
  return (
    <span className="inline-flex shrink-0 items-center gap-1.5 text-[10px] font-black text-[var(--text-muted)]">
      <span className="inline-flex h-5 min-w-7 items-center justify-center px-1.5 font-mono text-[10px] text-white" style={{ background: color, borderRadius: 999 }}>#{scenario.probabilityRank}</span>
      {directionLabel(scenario.direction)}
    </span>
  )
}

function LeadScenarioMatrix({
  scenario,
  data,
  market,
  saved,
  saving,
  onSave,
}: {
  scenario: ProjectionScenario
  data: ProjectionResponse
  market: MarketCode
  saved: boolean
  saving: boolean
  onSave: () => void
}) {
  const tone = scenarioTone(scenario.direction, scenario.probabilityRank)
  const evidence = scenario.evidence.slice(0, 4)
  return (
    <article className="border bg-white" style={{ borderColor: tone.border }} aria-label={`最上位シナリオ ${scenario.label}`}>
      <header className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 border-b px-3 py-2" style={{ borderColor: tone.border, background: tone.bg }}>
        <div className="flex min-w-0 items-center gap-2">
          <RankChip scenario={scenario} color={tone.color} />
          <strong className="min-w-0 truncate text-[14px] font-black" style={{ color: tone.color }}>{scenario.label}</strong>
        </div>
        <div className="font-mono text-[11px] font-black text-[var(--text-primary)]">
          {scenario.score}/100 <span className="font-semibold text-[var(--text-muted)]">相対{scenario.relativeWeightPct.toFixed(1)}% ・ 信頼{confidenceLabel(scenario.score)}</span>
        </div>
      </header>
      <div className="grid gap-x-6 gap-y-4 p-3 lg:grid-cols-3">
        <section className="min-w-0" aria-label="現在の状態と根拠">
          <h4 className="mb-1.5 text-[11px] font-black text-[var(--text-secondary)]">現在の状態</h4>
          <div className="mb-1.5 truncate text-[12px] font-black text-[var(--text-primary)]" title={data.statusLabel}>{data.statusLabel}</div>
          <div className="space-y-1">
            <ScoreRuler code="PMS" label="運動状態" value={data.stats.pms} text={fmtScore(data.stats.pms)} />
            <ScoreRuler code="PFS" label="足元の力" value={data.stats.pfs} text={fmtScore(data.stats.pfs)} />
            <ScoreRuler code="PES" label="熱量" value={data.stats.pes} text={fmtScore(data.stats.pes)} />
          </div>
          {evidence.length > 0 && (
            <ul className="mt-2 grid gap-0.5 border-t border-[var(--border-subtle)] pt-1.5">
              {evidence.map((item) => (
                <li key={item} className="flex gap-1.5 text-[10px] font-semibold leading-4 text-[var(--text-secondary)]">
                  <span className="mt-1.5 h-1 w-1 shrink-0 bg-[var(--text-muted)]" aria-hidden="true" />
                  <span className="min-w-0 break-words">{item}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
        <section className="min-w-0" aria-label="スコア寄与">
          <h4 className="mb-1.5 text-[11px] font-black text-[var(--text-secondary)]">スコア寄与 <span className="font-semibold text-[var(--text-muted)]">値/上限</span></h4>
          <div className="divide-y divide-[var(--border-subtle)] border-y border-[var(--border-subtle)]">
            {scenario.scoreBreakdown.map((part) => <ScoreRow key={`${scenario.id}-${part.key}`} part={part} />)}
          </div>
        </section>
        <section className="min-w-0" aria-label="価格水準">
          <h4 className="mb-1.5 text-[11px] font-black text-[var(--text-secondary)]">価格水準 <span className="font-semibold text-[var(--text-muted)]">高い順</span></h4>
          <PriceLadder scenario={scenario} basePrice={data.basePrice} market={market} />
        </section>
      </div>
      <footer className="flex flex-wrap items-center justify-between gap-2 border-t border-[var(--border-subtle)] px-3 py-2">
        <div className="min-w-0 flex-1 border-l-[3px] border-[var(--accent-primary)] pl-2 text-[11px] font-semibold leading-4 text-[var(--text-secondary)]">
          <b className="mr-1.5 font-black text-[var(--text-primary)]">見方が変わる条件</b>{scenario.invalidation}
        </div>
        <button type="button" onClick={onSave} disabled={saving || saved} style={saveButtonStyle(saved)}>
          {saved ? '保存済み' : saving ? '保存中…' : 'メモに残す'}
        </button>
      </footer>
    </article>
  )
}

function CompactScenarioRow({
  scenario,
  market,
  saved,
  saving,
  onSave,
}: {
  scenario: ProjectionScenario
  market: MarketCode
  saved: boolean
  saving: boolean
  onSave: () => void
}) {
  const tone = scenarioTone(scenario.direction, scenario.probabilityRank)
  const weight = Math.min(100, Math.max(0, scenario.relativeWeightPct))
  return (
    <article className="border bg-white" style={{ borderColor: tone.border }}>
      <div className="grid items-center gap-x-3 gap-y-1.5 px-3 py-2 sm:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)_auto]">
        <div className="flex min-w-0 items-center gap-2">
          <RankChip scenario={scenario} color={tone.color} />
          <strong className="min-w-0 truncate text-[12px] font-black" style={{ color: tone.color }} title={scenario.label}>{scenario.label}</strong>
        </div>
        <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2" title={`相対ウェイト ${scenario.relativeWeightPct.toFixed(1)}%`}>
          <span className="block h-2 bg-[var(--bg-elevated)]" aria-hidden="true">
            <span className="block h-full" style={{ width: `${weight}%`, background: tone.color }} />
          </span>
          <span className="font-mono text-[10px] font-black text-[var(--text-primary)]">{scenario.score}/100 ・ {scenario.relativeWeightPct.toFixed(1)}%</span>
        </div>
        <button type="button" onClick={onSave} disabled={saving || saved} style={saveButtonStyle(saved)} className="justify-self-start sm:justify-self-end">
          {saved ? '保存済み' : saving ? '保存中…' : 'メモに残す'}
        </button>
      </div>
      <details className="border-t border-[var(--border-subtle)]">
        <summary className="flex min-h-8 cursor-pointer items-center gap-3 px-3 text-[10px] font-black text-[var(--text-muted)]">
          <span>水準・見方が変わる条件</span>
          <span className="truncate font-mono font-semibold">目標 {fmtPrice(scenario.targetPrice, market)} ・ 見直し {fmtPrice(scenario.stopPrice, market)}</span>
        </summary>
        <div className="grid gap-1 px-3 pb-2 text-[10px] font-semibold leading-4 text-[var(--text-secondary)]">
          <div className="font-mono">上値 {fmtPrice(scenario.upperGuidePrice, market)} ・ 下値 {fmtPrice(scenario.lowerGuidePrice, market)}</div>
          <div className="border-l-[3px] border-[var(--accent-primary)] pl-2">{scenario.invalidation}</div>
        </div>
      </details>
    </article>
  )
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div style={metricStyle}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  )
}

const sectionStyle: CSSProperties = {
  padding: 16,
}

const headerStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'flex-start',
  justifyContent: 'space-between',
  gap: 12,
  flexWrap: 'wrap',
  marginBottom: 10,
}

const headerTitleStyle: CSSProperties = {
  margin: 0,
  fontSize: 18,
  lineHeight: 1.35,
}

const badgeStyle: CSSProperties = {
  border: '1px solid var(--border-subtle)',
  borderRadius: 999,
  background: 'var(--bg-elevated)',
  color: 'var(--text-secondary)',
  fontSize: 11,
  fontWeight: 800,
  padding: '5px 9px',
}

const tabRowStyle: CSSProperties = {
  display: 'flex',
  gap: 6,
  flexWrap: 'wrap',
  marginBottom: 10,
}

function tabButtonStyle(active: boolean): CSSProperties {
  return {
    border: `1px solid ${active ? 'var(--accent-primary)' : 'var(--border-subtle)'}`,
    borderRadius: 8,
    background: active ? 'var(--accent-dim)' : '#fff',
    color: active ? 'var(--accent-primary)' : 'var(--text-secondary)',
    padding: '8px 12px',
    display: 'inline-grid',
    gap: 3,
    minWidth: 92,
    fontSize: 12,
    cursor: 'pointer',
  }
}

const loadedStackStyle: CSSProperties = {
  display: 'grid',
  gap: 12,
}

const chartPanelStyle: CSSProperties = {
  border: '1px solid var(--border-subtle)',
  borderRadius: 8,
  background: '#fff',
  padding: 10,
  minWidth: 0,
}

const summaryBarStyle: CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'baseline',
  gap: 8,
  flexWrap: 'wrap',
  color: 'var(--text-secondary)',
  fontSize: 12,
  marginBottom: 10,
}

function freshnessNoticeStyle(derived: boolean): CSSProperties {
  return {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
    flexWrap: 'wrap',
    border: `1px solid ${derived ? 'rgba(245, 158, 11, 0.30)' : 'var(--border-subtle)'}`,
    borderRadius: 8,
    background: derived ? 'rgba(245, 158, 11, 0.08)' : 'var(--surface-muted)',
    color: derived ? '#92400e' : 'var(--text-secondary)',
    fontSize: 11,
    fontWeight: 800,
    lineHeight: 1.55,
    padding: '7px 9px',
    marginBottom: 10,
  }
}

const refreshButtonStyle: CSSProperties = {
  border: '1px solid var(--border-subtle)',
  borderRadius: 999,
  background: '#fff',
  color: 'var(--accent-primary)',
  fontSize: 11,
  fontWeight: 900,
  padding: '4px 9px',
  cursor: 'pointer',
}

const refreshNoticeStyle: CSSProperties = {
  border: '1px solid rgba(37, 99, 235, 0.22)',
  borderRadius: 8,
  background: 'rgba(37, 99, 235, 0.06)',
  color: '#1d4ed8',
  fontSize: 11,
  fontWeight: 900,
  lineHeight: 1.55,
  padding: '7px 9px',
  marginBottom: 10,
}

const chartWrapStyle: CSSProperties = {
  position: 'relative',
  minHeight: 420,
}

const scenarioRailStyle: CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  gap: 6,
  listStyle: 'none',
  margin: 0,
  padding: '8px 0 0',
}

const scenarioRailItemStyle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 5,
  minWidth: 0,
  maxWidth: '100%',
  border: '1px solid',
  borderRadius: 999,
  background: '#fff',
  fontSize: 11,
  fontWeight: 900,
  padding: '3px 8px 3px 3px',
}

const scenarioRailLabelStyle: CSSProperties = {
  minWidth: 0,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
}

const scenarioRailScoreStyle: CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: 10,
  opacity: 0.8,
}

const endpointLabelNumberStyle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  borderRadius: 999,
  color: '#fff',
  minWidth: 26,
  height: 20,
  padding: '0 5px',
  fontFamily: 'var(--font-mono)',
  fontSize: 10,
}

const chartOverlayBadgeStyle: CSSProperties = {
  position: 'absolute',
  left: 8,
  bottom: 8,
  border: '1px solid var(--border-subtle)',
  borderRadius: 999,
  background: 'rgba(255,255,255,0.86)',
  color: 'var(--text-secondary)',
  fontSize: 11,
  fontWeight: 800,
  padding: '5px 9px',
  pointerEvents: 'none',
}

const legendStyle: CSSProperties = {
  display: 'flex',
  gap: 12,
  flexWrap: 'wrap',
  alignItems: 'center',
  color: 'var(--text-muted)',
  fontSize: 11,
  marginTop: 10,
}

const noteStyle: CSSProperties = {
  margin: '10px 0 0',
  color: 'var(--text-muted)',
  fontSize: 11,
  lineHeight: 1.65,
}

const metricStyle: CSSProperties = {
  border: '1px solid var(--border-subtle)',
  borderRadius: 7,
  background: '#fff',
  padding: 7,
  display: 'grid',
  gap: 3,
  minWidth: 0,
  fontSize: 11,
}

const horizonLabelStyle: CSSProperties = {
  color: 'var(--text-muted)',
  fontSize: 11,
  fontWeight: 800,
  marginBottom: 4,
}

function saveButtonStyle(saved: boolean): CSSProperties {
  return {
    border: '1px solid var(--accent-primary)',
    borderRadius: 8,
    background: saved ? 'var(--bg-elevated)' : 'var(--accent-primary)',
    color: saved ? 'var(--text-muted)' : '#fff',
    fontSize: 12,
    fontWeight: 900,
    padding: '8px 11px',
    cursor: saved ? 'default' : 'pointer',
  }
}

const emptyStyle: CSSProperties = {
  border: '1px solid var(--border-subtle)',
  borderRadius: 8,
  background: 'var(--surface-muted)',
  padding: 16,
  color: 'var(--text-muted)',
  fontSize: 12,
  fontWeight: 800,
}

const messageStyle: CSSProperties = {
  border: '1px solid rgba(22, 163, 74, 0.28)',
  borderRadius: 8,
  background: 'rgba(22, 163, 74, 0.07)',
  color: 'var(--price-up)',
  padding: 8,
  fontSize: 11,
  fontWeight: 800,
}
