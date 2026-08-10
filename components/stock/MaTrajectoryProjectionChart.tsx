'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import {
  ColorType,
  createChart,
  createSeriesMarkers,
  LineSeries,
  LineStyle,
  type IChartApi,
  type ISeriesApi,
  type UTCTimestamp,
} from 'lightweight-charts'
import { Eye, EyeOff, Layers3 } from 'lucide-react'
import {
  MA_TRAJECTORY_DEFAULT_PERIODS,
  MA_TRAJECTORY_HORIZONS,
  MA_TRAJECTORY_PERIODS,
  type MaTrajectoryEvent,
  type MaTrajectoryHorizon,
  type MaTrajectoryMarket,
  type MaTrajectoryPeriod,
  type MaTrajectoryProjectionAvailable,
  type MaTrajectoryProjectionResponse,
  type MaTrajectoryScenario,
} from '@/lib/ma-trajectory/core'

type Props = {
  ticker: string
  market: MaTrajectoryMarket
  analysisDate?: string | null
  initialData: MaTrajectoryProjectionAvailable
}

const PERIOD_COLORS: Record<MaTrajectoryPeriod, string> = {
  3: '#e11d48',
  5: '#dc2626',
  10: '#d97706',
  25: '#15803d',
  75: '#2563eb',
  100: '#c026d3',
  200: '#7c3aed',
}

function toTime(value: string): UTCTimestamp {
  return Math.floor(new Date(`${value}T00:00:00Z`).getTime() / 1000) as UTCTimestamp
}

function methodLabel(method: MaTrajectoryProjectionAvailable['selectedMethod']): string {
  if (method === 'deep_state_encoder') return '深層状態エンコーダー'
  if (method === 'lightgbm_lambdarank') return 'LightGBM LambdaRank'
  return '重み付き距離'
}

function eventShape(type: MaTrajectoryEvent['type']): 'circle' | 'square' | 'arrowUp' | 'arrowDown' {
  if (type === 'cross') return 'square'
  if (type === 'bounce') return 'arrowUp'
  return 'circle'
}

function TrajectoryCanvas({
  data,
  scenario,
  visiblePeriods,
  compare,
  showPrice,
}: {
  data: MaTrajectoryProjectionAvailable
  scenario: MaTrajectoryScenario
  visiblePeriods: Set<MaTrajectoryPeriod>
  compare: boolean
  showPrice: boolean
}) {
  const containerRef = useRef<HTMLDivElement>(null)
  const chartRef = useRef<IChartApi | null>(null)

  useEffect(() => {
    if (!containerRef.current) return
    const chart = createChart(containerRef.current, {
      width: containerRef.current.clientWidth,
      height: 480,
      layout: {
        background: { type: ColorType.Solid, color: '#ffffff' },
        textColor: '#525252',
        fontSize: 11,
      },
      grid: {
        vertLines: { color: 'rgba(0,0,0,0.04)' },
        horzLines: { color: 'rgba(0,0,0,0.04)' },
      },
      rightPriceScale: { borderColor: 'rgba(0,0,0,0.12)' },
      timeScale: { borderColor: 'rgba(0,0,0,0.12)', rightOffset: 3 },
      crosshair: { mode: 1 },
    })
    chartRef.current = chart
    const selectedSeries = new Map<MaTrajectoryPeriod, ISeriesApi<'Line'>>()

    for (const period of MA_TRAJECTORY_PERIODS) {
      if (!visiblePeriods.has(period)) continue
      const color = PERIOD_COLORS[period]
      const history = chart.addSeries(LineSeries, {
        color,
        lineWidth: period === 5 || period === 25 ? 2 : 1,
        lineStyle: LineStyle.Solid,
        priceLineVisible: false,
        lastValueVisible: false,
        title: `${period}日`,
      })
      history.setData((data.history[String(period)] ?? []).map((point) => ({
        time: toTime(point.date),
        value: point.value,
      })))

      const forecast = chart.addSeries(LineSeries, {
        color,
        lineWidth: period === 5 || period === 25 ? 3 : 2,
        lineStyle: LineStyle.Dashed,
        priceLineVisible: false,
        lastValueVisible: true,
        title: `${period}日予測`,
      })
      forecast.setData((scenario.lines[String(period)] ?? []).map((point) => ({
        time: toTime(point.date),
        value: point.median,
      })))
      selectedSeries.set(period, forecast)

      for (const [key, lineStyle] of [['p10', LineStyle.Dotted], ['p90', LineStyle.Dotted]] as const) {
        const boundary = chart.addSeries(LineSeries, {
          color: `${color}66`,
          lineWidth: 1,
          lineStyle,
          priceLineVisible: false,
          lastValueVisible: false,
        })
        boundary.setData((scenario.lines[String(period)] ?? []).map((point) => ({
          time: toTime(point.date),
          value: point[key],
        })))
      }
    }

    if (compare) {
      for (const alternative of data.scenarios.filter((item) => item.id !== scenario.id)) {
        for (const period of visiblePeriods) {
          const overlay = chart.addSeries(LineSeries, {
            color: `${PERIOD_COLORS[period]}45`,
            lineWidth: 1,
            lineStyle: alternative.rank === 2 ? LineStyle.Dashed : LineStyle.Dotted,
            priceLineVisible: false,
            lastValueVisible: false,
          })
          overlay.setData((alternative.lines[String(period)] ?? []).map((point) => ({
            time: toTime(point.date),
            value: point.median,
          })))
        }
      }
    }

    if (showPrice && scenario.priceAuxiliary.length > 0) {
      for (const [key, style, width] of [
        ['median', LineStyle.Solid, 2],
        ['p10', LineStyle.Dotted, 1],
        ['p90', LineStyle.Dotted, 1],
      ] as const) {
        const price = chart.addSeries(LineSeries, {
          color: key === 'median' ? '#64748b80' : '#94a3b84d',
          lineWidth: width,
          lineStyle: style,
          priceLineVisible: false,
          lastValueVisible: false,
          title: key === 'median' ? '補助価格' : undefined,
        })
        price.setData(scenario.priceAuxiliary.map((point) => ({
          time: toTime(point.date),
          value: point[key],
        })))
      }
    }

    for (const [period, series] of selectedSeries) {
      const markers = scenario.events
        .filter((event) => event.shortPeriod === period)
        .slice(0, 8)
        .map((event) => ({
          time: toTime(event.date),
          position: event.type === 'bounce' ? 'belowBar' as const : 'aboveBar' as const,
          color: event.type === 'cross' ? '#111827' : PERIOD_COLORS[period],
          shape: eventShape(event.type),
          text: event.label.replace(`${event.shortPeriod}日線 / ${event.longPeriod}日線 `, ''),
        }))
      if (markers.length > 0) createSeriesMarkers(series, markers)
    }

    chart.timeScale().fitContent()
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width
      if (width) chart.applyOptions({ width })
    })
    observer.observe(containerRef.current)
    return () => {
      observer.disconnect()
      chart.remove()
      chartRef.current = null
    }
  }, [compare, data, scenario, showPrice, visiblePeriods])

  return <div ref={containerRef} style={{ width: '100%', maxWidth: '100%', height: 480, minWidth: 0, overflow: 'hidden' }} />
}

export function MaTrajectoryProjectionChart({ ticker, market, analysisDate, initialData }: Props) {
  const [data, setData] = useState(initialData)
  const [horizon, setHorizon] = useState<MaTrajectoryHorizon>(initialData.horizonSessions)
  const [selectedScenarioId, setSelectedScenarioId] = useState(initialData.scenarios[0]?.id ?? '')
  const [visiblePeriods, setVisiblePeriods] = useState<Set<MaTrajectoryPeriod>>(
    () => new Set(MA_TRAJECTORY_DEFAULT_PERIODS),
  )
  const [compare, setCompare] = useState(false)
  const [showPrice, setShowPrice] = useState(true)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    setData(initialData)
    setHorizon(initialData.horizonSessions)
    setSelectedScenarioId(initialData.scenarios[0]?.id ?? '')
  }, [initialData])

  useEffect(() => {
    if (horizon === data.horizonSessions) return
    const controller = new AbortController()
    let active = true
    const params = new URLSearchParams({ market, horizon: String(horizon) })
    if (analysisDate) params.set('date', analysisDate)
    setLoading(true)
    fetch(`/api/ma-trajectory-projections/${encodeURIComponent(ticker)}?${params}`, {
      signal: controller.signal,
      cache: 'no-store',
    })
      .then((response) => response.json() as Promise<MaTrajectoryProjectionResponse>)
      .then((response) => {
        if (!active) return
        if (!response.available) {
          setHorizon(data.horizonSessions)
          return
        }
        setData(response)
        setSelectedScenarioId(response.scenarios[0]?.id ?? '')
      })
      .catch((error) => {
        if (active && (error as Error).name !== 'AbortError') {
          console.error('MA trajectory horizon fetch failed:', error)
          setHorizon(data.horizonSessions)
        }
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => {
      active = false
      controller.abort()
    }
  }, [analysisDate, data.horizonSessions, horizon, market, ticker])

  const selectedScenario = useMemo(
    () => data.scenarios.find((scenario) => scenario.id === selectedScenarioId) ?? data.scenarios[0],
    [data, selectedScenarioId],
  )
  if (!selectedScenario) return null

  const togglePeriod = (period: MaTrajectoryPeriod) => {
    setVisiblePeriods((current) => {
      const next = new Set(current)
      if (next.has(period) && next.size > 1) next.delete(period)
      else next.add(period)
      return next
    })
  }

  return (
    <section
      style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: 14, minWidth: 0 }}
      aria-label="MA軌道シナリオ"
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', alignItems: 'start' }}>
        <div>
          <div className="section-header" style={{ marginBottom: 3 }}>MA軌道シナリオ</div>
          <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
            {data.asOfDate}時点 · {methodLabel(data.selectedMethod)} · {data.modelVersion}
          </div>
        </div>
        <div style={segmentedStyle} aria-label="予測期間">
          {MA_TRAJECTORY_HORIZONS.map((value) => (
            <button
              key={value}
              type="button"
              onClick={() => setHorizon(value)}
              aria-pressed={horizon === value}
              style={{ ...segmentButtonStyle, ...(horizon === value ? activeSegmentStyle : {}) }}
            >
              {value}日
            </button>
          ))}
        </div>
      </div>

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        {MA_TRAJECTORY_PERIODS.map((period) => (
          <button
            key={period}
            type="button"
            onClick={() => togglePeriod(period)}
            aria-pressed={visiblePeriods.has(period)}
            style={{
              ...toggleButtonStyle,
              borderColor: visiblePeriods.has(period) ? PERIOD_COLORS[period] : 'var(--border-subtle)',
              color: visiblePeriods.has(period) ? PERIOD_COLORS[period] : 'var(--text-secondary)',
            }}
          >
            <span style={{ width: 12, height: 3, background: PERIOD_COLORS[period], display: 'inline-block' }} />
            {period}日
          </button>
        ))}
        <button type="button" onClick={() => setCompare((value) => !value)} style={iconTextButtonStyle} aria-pressed={compare}>
          <Layers3 size={15} /> 代替比較
        </button>
        <button type="button" onClick={() => setShowPrice((value) => !value)} style={iconTextButtonStyle} aria-pressed={showPrice}>
          {showPrice ? <Eye size={15} /> : <EyeOff size={15} />} 補助価格
        </button>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 220px), 1fr))', gap: 8 }}>
        {data.scenarios.map((scenario) => (
          <button
            key={scenario.id}
            type="button"
            onClick={() => setSelectedScenarioId(scenario.id)}
            aria-pressed={scenario.id === selectedScenario.id}
            style={{
              ...scenarioButtonStyle,
              borderColor: scenario.id === selectedScenario.id ? '#111827' : 'var(--border-subtle)',
              background: scenario.id === selectedScenario.id ? '#f8fafc' : '#ffffff',
            }}
          >
            <span style={{ fontWeight: 700 }}>{scenario.rank === 1 ? '本命' : `代替${scenario.rank - 1}`} · {scenario.label}</span>
            <span style={{ fontVariantNumeric: 'tabular-nums' }}>{scenario.probabilityPct.toFixed(1)}%</span>
            <span style={{ gridColumn: '1 / -1', color: 'var(--text-secondary)', fontSize: 11 }}>
              類似 {scenario.analogCount}件 · 平均類似度 {scenario.averageSimilarity.toFixed(3)}
            </span>
          </button>
        ))}
      </div>

      <div style={{ position: 'relative', width: '100%', minWidth: 0, minHeight: 480, overflow: 'hidden', opacity: loading ? 0.55 : 1 }}>
        <TrajectoryCanvas
          data={data}
          scenario={selectedScenario}
          visiblePeriods={visiblePeriods}
          compare={compare}
          showPrice={showPrice}
        />
        {loading && <div style={loadingStyle}>読み込み中</div>}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 280px), 1fr))', gap: 16 }}>
        <div>
          <div style={subheadingStyle}>予想イベント</div>
          <div style={{ display: 'grid', gap: 6 }}>
            {selectedScenario.events.slice(0, 6).map((event) => (
              <div key={`${event.shortPeriod}-${event.longPeriod}-${event.date}-${event.type}`} style={detailRowStyle}>
                <span>{event.date} · {event.label}</span>
                <strong>{event.probabilityPct.toFixed(0)}%</strong>
              </div>
            ))}
          </div>
        </div>
        <div>
          <div style={subheadingStyle}>逃げ道の状態</div>
          <div style={{ display: 'grid', gap: 6 }}>
            {selectedScenario.escapeStates.slice(0, 4).map((state) => (
              <div key={state.state} style={detailRowStyle}>
                <span>{state.label}</span>
                <strong>{state.probabilityPct.toFixed(1)}%</strong>
              </div>
            ))}
          </div>
        </div>
        <div>
          <div style={subheadingStyle}>主要因</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {selectedScenario.drivers.slice(0, 5).map((driver) => (
              <span key={driver.key} style={driverStyle}>{driver.label}</span>
            ))}
          </div>
          <div style={{ marginTop: 9, color: 'var(--text-secondary)', fontSize: 11 }}>
            ECE {data.calibration.ece?.toFixed(3) ?? '-'} · 80%帯実測 {data.calibration.intervalCoverage80 == null ? '-' : `${(data.calibration.intervalCoverage80 * 100).toFixed(1)}%`}
          </div>
        </div>
      </div>
    </section>
  )
}

const segmentedStyle: React.CSSProperties = { display: 'flex', border: '1px solid var(--border-subtle)', padding: 2, background: '#f8fafc' }
const segmentButtonStyle: React.CSSProperties = { border: 0, background: 'transparent', color: 'var(--text-secondary)', padding: '6px 10px', fontSize: 12, cursor: 'pointer', whiteSpace: 'nowrap' }
const activeSegmentStyle: React.CSSProperties = { background: '#111827', color: '#ffffff' }
const toggleButtonStyle: React.CSSProperties = { display: 'inline-flex', alignItems: 'center', gap: 6, border: '1px solid', background: '#ffffff', padding: '5px 8px', fontSize: 12, cursor: 'pointer' }
const iconTextButtonStyle: React.CSSProperties = { display: 'inline-flex', alignItems: 'center', gap: 5, border: '1px solid var(--border-subtle)', background: '#ffffff', color: 'var(--text-primary)', padding: '5px 8px', fontSize: 12, cursor: 'pointer' }
const scenarioButtonStyle: React.CSSProperties = { border: '1px solid', padding: '10px 12px', display: 'grid', gridTemplateColumns: '1fr auto', textAlign: 'left', gap: 5, cursor: 'pointer', color: 'var(--text-primary)', minHeight: 66 }
const loadingStyle: React.CSSProperties = { position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', color: 'var(--text-secondary)', fontSize: 13, pointerEvents: 'none' }
const subheadingStyle: React.CSSProperties = { fontSize: 12, fontWeight: 700, marginBottom: 8, color: 'var(--text-secondary)' }
const detailRowStyle: React.CSSProperties = { display: 'flex', justifyContent: 'space-between', gap: 10, fontSize: 12, borderBottom: '1px solid var(--border-subtle)', paddingBottom: 5 }
const driverStyle: React.CSSProperties = { border: '1px solid var(--border-subtle)', background: '#f8fafc', padding: '4px 7px', fontSize: 11 }
