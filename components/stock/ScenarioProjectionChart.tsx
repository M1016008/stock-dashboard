'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import {
  createChart,
  CandlestickSeries,
  LineSeries,
  LineStyle,
  ColorType,
  type IChartApi,
  type ISeriesApi,
  type UTCTimestamp,
} from 'lightweight-charts'
import type { OHLCV } from '@/types/stock'
import { movingAverageColor } from '@/lib/chart-colors'
import type { MarketCode } from '@/lib/markets'
import type { ChartIntervalCode } from '@/lib/timeframes'

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
}

interface ProjectionResponse {
  ok: true
  ticker: string
  interval: ScenarioInterval
  horizonDays: number
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
  market?: MarketCode
  onUseLatest?: () => void
}

interface ScenarioEndpointLabel {
  id: string
  rank: number
  label: string
  direction: ProjectionDirection
  score: number
  color: string
  x: number
  y: number
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
  const leadScenario =
    data.scenarios.find((scenario) => scenario.direction === (primary === 'mixed' ? leader : primary)) ??
    data.scenarios[0]
  const reasonParts = (leadScenario?.scoreBreakdown ?? [])
    .filter((part) => part.value > 0)
    .sort((a, b) => b.value - a.value)
    .slice(0, 4)

  const primaryLabel: Record<SummaryDirection, string> = {
    up: '上昇シナリオ優勢',
    down: '下落シナリオ優勢',
    range: '横ばい・様子見優勢',
    mixed: '方向感は拮抗',
  }

  const headline = `結論: ${primaryLabel[primary]}`
  const description = primary === 'mixed'
    ? `上昇 ${totals.up.toFixed(1)}% / 下落 ${totals.down.toFixed(1)}% / 横ばい ${totals.range.toFixed(1)}% で、優勢方向の差が小さい状態です。`
    : `${directionLabel(primary)}が相対優勢 ${leaderPct.toFixed(1)}%。最上位候補は「${leadScenario?.label ?? '-'}」です。`

  return {
    primary,
    leader,
    headline,
    description,
    totals,
    leadScenario,
    reasonParts,
  }
}

function ScenarioCanvas({ data, market }: { data: ProjectionResponse; market: MarketCode }) {
  const containerRef = useRef<HTMLDivElement>(null)
  const chartRef = useRef<IChartApi | null>(null)
  const [endpointLabels, setEndpointLabels] = useState<ScenarioEndpointLabel[]>([])

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

    for (const [period, points] of Object.entries(data.chart.ma)) {
      const series = chart.addSeries(LineSeries, {
        color: movingAverageColor(period),
        lineWidth: 1,
        priceLineVisible: false,
        lastValueVisible: false,
      })
      series.setData(points.map((point) => ({ time: dateToTime(point.date), value: point.value })))
    }

    const scenarioSeries: Array<{ scenario: ProjectionScenario; series: ISeriesApi<'Line'> }> = []
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
      scenarioSeries.push({ scenario, series })
    }

    chart.timeScale().fitContent()
    chartRef.current = chart
    const updateEndpointLabels = () => {
      const container = containerRef.current
      if (!container) return
      const width = container.clientWidth
      const height = container.clientHeight
      const next = scenarioSeries.flatMap(({ scenario, series }) => {
        const last = scenario.points[scenario.points.length - 1]
        if (!last) return []
        const x = chart.timeScale().timeToCoordinate(dateToTime(last.date))
        const y = series.priceToCoordinate(last.value)
        if (x == null || y == null) return []
        const tone = scenarioLineStyle(scenario)
        return [{
          id: scenario.id,
          rank: scenario.probabilityRank,
          label: scenario.label,
          direction: scenario.direction,
          score: scenario.score,
          color: tone.color,
          x: Math.max(8, Math.min(width - 148, x + 6)),
          y: Math.max(8, Math.min(height - 32, y - 12)),
        }]
      }).sort((a, b) => a.y - b.y)

      const minY = 8
      const maxY = Math.max(minY, height - 32)
      for (let i = 1; i < next.length; i += 1) {
        if (next[i].y - next[i - 1].y < 26) next[i].y = next[i - 1].y + 26
      }
      const overflow = next.length ? next[next.length - 1].y - maxY : 0
      if (overflow > 0) {
        for (const item of next) item.y = Math.max(minY, item.y - overflow)
      }
      for (let i = 1; i < next.length; i += 1) {
        if (next[i].y - next[i - 1].y < 26) next[i].y = Math.min(maxY, next[i - 1].y + 26)
      }
      setEndpointLabels(next)
    }
    requestAnimationFrame(updateEndpointLabels)
    const resize = () => {
      if (containerRef.current && chartRef.current) {
        chartRef.current.applyOptions({ width: containerRef.current.clientWidth })
        requestAnimationFrame(updateEndpointLabels)
      }
    }
    window.addEventListener('resize', resize)
    return () => {
      window.removeEventListener('resize', resize)
      setEndpointLabels([])
      if (chartRef.current) {
        chartRef.current.remove()
        chartRef.current = null
      }
    }
  }, [data])

  return (
    <div style={chartWrapStyle}>
      <div ref={containerRef} style={{ height: 420, width: '100%' }} />
      {endpointLabels.map((item) => (
        <div
          key={item.id}
          style={{
            ...endpointLabelStyle,
            left: item.x,
            top: item.y,
            borderColor: item.color,
            color: item.color,
          }}
          title={`#${item.rank} ${directionLabel(item.direction)} ${item.label} / score ${item.score}`}
        >
          <span style={{ ...endpointLabelNumberStyle, background: item.color }}>#{item.rank}</span>
          <span>{item.label}</span>
        </div>
      ))}
      <div style={chartOverlayBadgeStyle}>
        点線は将来シナリオ / 基準 {data.baseDate} {fmtPrice(data.basePrice, market)}
      </div>
    </div>
  )
}

type RefreshSource = 'initial' | 'auto' | 'manual'

export function ScenarioProjectionChart({ ticker, name, analysisDate, market = 'JP', onUseLatest }: ScenarioProjectionChartProps) {
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
  }, [ticker, activeTab, analysisDate, market, refreshNonce])

  function regenerateLatest() {
    refreshSourceRef.current = 'manual'
    onUseLatest?.()
    setError('')
    setMessage('')
    setRefreshNonce((value) => value + 1)
  }

  const topScenario = data?.scenarios[0] ?? null
  const sourceText = useMemo(() => {
    if (!data) return ''
    const parts = [
      `価格 ${data.sourceDates.price}`,
      data.sourceDates.feature
        ? `特徴量 ${data.sourceDates.featureDerived ? '最新足から再計算' : data.sourceDates.feature}`
        : null,
      data.sourceDates.physicalMomentum && data.sourceDates.physicalMomentum !== data.sourceDates.price
        ? `PMS ${data.sourceDates.physicalMomentum}`
        : null,
      data.sourceDates.calibration ? `検証 ${data.sourceDates.calibration}` : null,
      data.llmNarrative?.used ? `AI説明 ${data.llmNarrative.model}` : 'ローカル説明',
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
      setMessage('売買シナリオノートに保存しました。')
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
        <div>
          <div className="section-header" style={headerTitleStyle}>シナリオチャート</div>
          <p style={subTextStyle}>
            既存データ、物理モメンタム、MA状態、ML候補から複数の値動きシナリオを点線で可視化します。
            {analysisDate ? ` 基準日は${analysisDate}以前のデータに固定しています。` : ''}
          </p>
        </div>
        <span style={badgeStyle}>予測断定ではありません</span>
      </div>

      <div style={tabRowStyle}>
        {TABS.map((tab) => (
          <button
            key={tab.interval}
            type="button"
            onClick={() => setActiveTab(tab)}
            style={tabButtonStyle(tab.interval === activeTab.interval)}
          >
            <strong>{tab.label}</strong>
            <span>{tab.note}</span>
          </button>
        ))}
      </div>

      {loading ? (
        <div style={emptyStyle}>シナリオを生成中...</div>
      ) : error ? (
        <div style={{ ...emptyStyle, color: 'var(--price-down)' }}>シナリオ取得エラー: {error}</div>
      ) : !data || data.scenarios.length === 0 ? (
        <div style={emptyStyle}>シナリオ生成に必要な価格データがありません。</div>
      ) : (
        <div style={loadedStackStyle}>
          <DirectionSummaryPanel data={data} />
          <div style={bodyGridStyle}>
            <div style={chartPanelStyle}>
              <div style={summaryBarStyle}>
                <div>
                  <strong>{data.statusLabel}</strong>
                  <span>{sourceText}</span>
                </div>
                {topScenario && (
                  <div style={topScenarioStyle}>
                    最上位: {topScenario.label} / score {topScenario.score}
                  </div>
                )}
              </div>
              <div style={freshnessNoticeStyle(data.sourceDates.featureDerived === true)}>
                {data.sourceDates.featureDerived
                  ? `保存済み物理特徴量が最新価格日と異なるため、${data.sourceDates.price} の足から物理状態を再計算して表示しています。`
                  : `保存済み物理特徴量と価格データを使って ${data.sourceDates.price} 基準で表示しています。`}
                <button type="button" onClick={regenerateLatest} style={refreshButtonStyle}>
                  最新で再生成
                </button>
              </div>
              {refreshNotice && <div style={refreshNoticeStyle}>{refreshNotice}</div>}
              <ScenarioCanvas data={data} market={market} />
              <div style={legendStyle}>
                <span><i style={{ background: '#dc2626' }} />上昇</span>
                <span><i style={{ background: '#f59e0b' }} />横ばい</span>
                <span><i style={{ background: '#2563eb' }} />下落</span>
                <span>点線の終点 #n が右側カードの #n と対応</span>
              </div>
              <p style={noteStyle}>{data.note}</p>
            </div>
            <div style={scenarioListStyle}>
              {message && <div style={messageStyle}>{message}</div>}
              {data.scenarios.map((scenario) => {
                const tone = scenarioTone(scenario.direction, scenario.probabilityRank)
                const saved = savedIds.has(scenario.id)
                return (
                  <article key={scenario.id} style={{ ...scenarioCardStyle, borderColor: tone.border, background: tone.bg }}>
                    <div style={scenarioTopStyle}>
                      <div>
                        <span style={scenarioLineChipStyle}>
                          <i style={{ ...scenarioLineSampleStyle, borderColor: tone.color }} />
                          <span style={{ ...scenarioRankBadgeStyle, background: tone.color }}>#{scenario.probabilityRank}</span>
                          <span>{directionLabel(scenario.direction)}</span>
                        </span>
                        <strong style={{ ...scenarioTitleStyle, color: tone.color }}>{scenario.label}</strong>
                      </div>
                      <div style={scoreBoxStyle}>
                        <span style={scoreMainStyle}>{scenario.score}/100</span>
                        <span>相対{scenario.relativeWeightPct.toFixed(1)}%</span>
                        <span>信頼{confidenceLabel(scenario.score)}</span>
                      </div>
                    </div>
                    <p style={scenarioNarrativeStyle}>{scenario.narrative}</p>
                    <div style={scoreBreakdownStyle}>
                      {scenario.scoreBreakdown.map((part) => (
                        <ScorePart key={`${scenario.id}-${part.key}`} part={part} />
                      ))}
                    </div>
                    <div style={metricGridStyle}>
                      <Metric label="目標" value={fmtPrice(scenario.targetPrice, market)} />
                      <Metric label="撤退" value={fmtPrice(scenario.stopPrice, market)} />
                      <Metric label="上値" value={fmtPrice(scenario.upperGuidePrice, market)} />
                      <Metric label="下値" value={fmtPrice(scenario.lowerGuidePrice, market)} />
                    </div>
                    <div style={evidenceRowStyle}>
                      {scenario.evidence.slice(0, 4).map((item) => (
                        <span key={item}>{item}</span>
                      ))}
                    </div>
                    <div style={invalidationStyle}>
                      <strong>崩れる条件</strong>
                      <span>{scenario.invalidation}</span>
                    </div>
                    <button
                      type="button"
                      onClick={() => saveScenario(scenario)}
                      disabled={savingId === scenario.id || saved}
                      style={saveButtonStyle(saved)}
                    >
                      {saved ? '保存済み' : savingId === scenario.id ? '保存中...' : 'このシナリオを保存'}
                    </button>
                  </article>
                )
              })}
            </div>
          </div>
        </div>
      )}
    </section>
  )
}

function DirectionSummaryPanel({ data }: { data: ProjectionResponse }) {
  const summary = buildDirectionSummary(data)
  const tone = summaryTone(summary.primary)
  const bars: Array<{ direction: ProjectionDirection; label: string; value: number }> = [
    { direction: 'up', label: '上昇', value: summary.totals.up },
    { direction: 'down', label: '下落', value: summary.totals.down },
    { direction: 'range', label: '横ばい', value: summary.totals.range },
  ]

  return (
    <div style={{ ...directionSummaryStyle, borderColor: tone.border, background: tone.bg }}>
      <div style={directionSummaryMainStyle}>
        <div>
          <span style={directionEyebrowStyle}>結論ファースト</span>
          <strong style={{ ...directionHeadlineStyle, color: tone.color }}>{summary.headline}</strong>
          <p style={directionDescriptionStyle}>{summary.description}</p>
        </div>
        <div style={directionTotalGridStyle}>
          {bars.map((bar) => {
            const barTone = scenarioTone(bar.direction, 1)
            return (
              <div key={bar.direction} style={directionTotalStyle}>
                <div style={directionTotalLabelStyle}>
                  <span>{bar.label}</span>
                  <strong>{bar.value.toFixed(1)}%</strong>
                </div>
                <div style={directionTrackStyle}>
                  <span style={{ ...directionBarStyle, width: `${Math.min(100, bar.value)}%`, background: barTone.color }} />
                </div>
              </div>
            )
          })}
        </div>
      </div>
      <div style={directionReasonGridStyle}>
        {summary.reasonParts.map((part) => (
          <div key={`${summary.leadScenario?.id}-${part.key}`} style={directionReasonStyle}>
            <span>{part.label}</span>
            <strong>{fmtContribution(part.value)}</strong>
            <small>{part.detail}</small>
          </div>
        ))}
      </div>
    </div>
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

function ScorePart({ part }: { part: ScenarioScoreBreakdown }) {
  const positive = part.value >= 0
  const magnitude = Math.min(100, Math.round((Math.abs(part.value) / Math.max(1, part.max)) * 100))
  return (
    <div style={scorePartStyle} title={part.detail}>
      <div style={scorePartHeaderStyle}>
        <span>{part.label}</span>
        <strong style={{ color: positive ? 'var(--price-up)' : 'var(--price-down)' }}>
          {fmtContribution(part.value)}
        </strong>
      </div>
      <div style={scorePartTrackStyle}>
        <span
          style={{
            ...scorePartBarStyle,
            width: `${magnitude}%`,
            background: positive ? 'rgba(220, 38, 38, 0.58)' : 'rgba(37, 99, 235, 0.58)',
          }}
        />
      </div>
      <span style={scorePartDetailStyle}>{part.detail}</span>
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

const subTextStyle: CSSProperties = {
  margin: '4px 0 0',
  color: 'var(--text-muted)',
  fontSize: 12,
  lineHeight: 1.6,
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

const bodyGridStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(min(440px, 100%), 1fr))',
  gap: 10,
  alignItems: 'start',
}

const loadedStackStyle: CSSProperties = {
  display: 'grid',
  gap: 12,
}

const directionSummaryStyle: CSSProperties = {
  border: '1px solid var(--border-subtle)',
  borderRadius: 8,
  padding: 12,
  display: 'grid',
  gap: 12,
}

const directionSummaryMainStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'minmax(0, 1.15fr) minmax(min(360px, 100%), 0.85fr)',
  gap: 10,
  alignItems: 'center',
}

const directionEyebrowStyle: CSSProperties = {
  display: 'inline-flex',
  width: 'fit-content',
  border: '1px solid var(--border-subtle)',
  borderRadius: 999,
  background: 'rgba(255,255,255,0.78)',
  color: 'var(--text-secondary)',
  fontSize: 11,
  fontWeight: 900,
  padding: '4px 8px',
  marginBottom: 6,
}

const directionHeadlineStyle: CSSProperties = {
  display: 'block',
  fontSize: 20,
  fontWeight: 950,
  letterSpacing: 0,
}

const directionDescriptionStyle: CSSProperties = {
  margin: '4px 0 0',
  color: 'var(--text-secondary)',
  fontSize: 13,
  lineHeight: 1.6,
  fontWeight: 700,
}

const directionTotalGridStyle: CSSProperties = {
  display: 'grid',
  gap: 7,
}

const directionTotalStyle: CSSProperties = {
  display: 'grid',
  gap: 4,
}

const directionTotalLabelStyle: CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  gap: 8,
  color: 'var(--text-secondary)',
  fontSize: 12,
  fontWeight: 900,
}

const directionTrackStyle: CSSProperties = {
  height: 7,
  borderRadius: 999,
  background: 'rgba(255,255,255,0.75)',
  border: '1px solid rgba(0,0,0,0.04)',
  overflow: 'hidden',
}

const directionBarStyle: CSSProperties = {
  display: 'block',
  height: '100%',
  borderRadius: 999,
}

const directionReasonGridStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(min(190px, 100%), 1fr))',
  gap: 6,
}

const directionReasonStyle: CSSProperties = {
  border: '1px solid var(--border-subtle)',
  borderRadius: 8,
  background: 'rgba(255,255,255,0.82)',
  padding: 9,
  display: 'grid',
  gap: 4,
  color: 'var(--text-secondary)',
  fontSize: 11,
  fontWeight: 800,
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

const topScenarioStyle: CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: 11,
  color: 'var(--text-muted)',
}

const chartWrapStyle: CSSProperties = {
  position: 'relative',
  minHeight: 420,
}

const endpointLabelStyle: CSSProperties = {
  position: 'absolute',
  zIndex: 4,
  display: 'inline-flex',
  alignItems: 'center',
  gap: 5,
  maxWidth: 136,
  border: '1px solid',
  borderRadius: 999,
  background: 'rgba(255,255,255,0.92)',
  boxShadow: '0 2px 8px rgba(15, 23, 42, 0.12)',
  fontSize: 11,
  fontWeight: 900,
  padding: '3px 8px 3px 3px',
  pointerEvents: 'none',
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
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

const scenarioListStyle: CSSProperties = {
  display: 'grid',
  gap: 10,
  maxHeight: 680,
  overflow: 'auto',
  paddingRight: 2,
}

const scenarioCardStyle: CSSProperties = {
  border: '1px solid var(--border-subtle)',
  borderRadius: 8,
  padding: 12,
  display: 'grid',
  gap: 10,
}

const scenarioTopStyle: CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'flex-start',
  gap: 10,
}

const scenarioLineChipStyle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
  color: 'var(--text-muted)',
  fontSize: 11,
  fontWeight: 900,
}

const scenarioLineSampleStyle: CSSProperties = {
  width: 28,
  borderTop: '2px dashed',
}

const scenarioRankBadgeStyle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  borderRadius: 999,
  color: '#fff',
  minWidth: 28,
  height: 20,
  padding: '0 6px',
  fontFamily: 'var(--font-mono)',
  fontSize: 10,
}

const scenarioTitleStyle: CSSProperties = {
  display: 'block',
  marginTop: 3,
  fontSize: 15,
  fontWeight: 900,
}

const scoreBoxStyle: CSSProperties = {
  border: '1px solid var(--border-subtle)',
  borderRadius: 8,
  background: '#fff',
  color: 'var(--text-secondary)',
  fontSize: 11,
  fontWeight: 900,
  padding: '6px 8px',
  whiteSpace: 'nowrap',
  display: 'grid',
  gap: 2,
  justifyItems: 'end',
}

const scoreMainStyle: CSSProperties = {
  fontFamily: 'var(--font-mono)',
  color: 'var(--text-primary)',
  fontSize: 14,
  lineHeight: 1,
}

const scenarioNarrativeStyle: CSSProperties = {
  margin: 0,
  color: 'var(--text-secondary)',
  fontSize: 12,
  lineHeight: 1.65,
}

const scoreBreakdownStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(min(170px, 100%), 1fr))',
  gap: 6,
}

const scorePartStyle: CSSProperties = {
  border: '1px solid var(--border-subtle)',
  borderRadius: 7,
  background: 'rgba(255,255,255,0.82)',
  padding: 7,
  display: 'grid',
  gap: 5,
  minWidth: 0,
}

const scorePartHeaderStyle: CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  gap: 6,
  alignItems: 'center',
  color: 'var(--text-secondary)',
  fontSize: 12,
  fontWeight: 900,
}

const scorePartTrackStyle: CSSProperties = {
  position: 'relative',
  height: 5,
  borderRadius: 999,
  background: 'rgba(0,0,0,0.06)',
  overflow: 'hidden',
}

const scorePartBarStyle: CSSProperties = {
  display: 'block',
  height: '100%',
  borderRadius: 999,
}

const scorePartDetailStyle: CSSProperties = {
  overflowWrap: 'anywhere',
  whiteSpace: 'normal',
  color: 'var(--text-muted)',
  fontSize: 11,
  lineHeight: 1.45,
  fontWeight: 700,
}

const metricGridStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(4, minmax(0, 1fr))',
  gap: 6,
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

const evidenceRowStyle: CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  gap: 6,
  color: 'var(--text-secondary)',
  fontSize: 11,
  fontWeight: 800,
}

const invalidationStyle: CSSProperties = {
  borderTop: '1px solid var(--border-subtle)',
  paddingTop: 8,
  display: 'grid',
  gap: 4,
  color: 'var(--text-secondary)',
  fontSize: 12,
  lineHeight: 1.55,
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
