'use client'

import type {
  TriggerDiscoveryMiniChart,
  TriggerDiscoveryMiniChartPoint,
} from '@/lib/trigger-discovery-contract'
import type { TriggerDiscoveryTimeframe } from '@/lib/trigger-discovery-timeframe'

const WIDTH = 156
const HEIGHT = 56
const PAD_X = 3
const PAD_Y = 5

function finiteValues(points: TriggerDiscoveryMiniChartPoint[]): number[] {
  return points.flatMap((point) => [point.close, point.ma1, point.ma2])
    .filter((value): value is number => value != null && Number.isFinite(value))
}

function lineSegments(
  points: TriggerDiscoveryMiniChartPoint[],
  x: (index: number) => number,
  y: (value: number) => number,
  value: (point: TriggerDiscoveryMiniChartPoint) => number | null,
): string[] {
  const segments: string[] = []
  let current = ''
  points.forEach((point, index) => {
    const resolved = value(point)
    if (resolved == null || !Number.isFinite(resolved)) {
      if (current) segments.push(current)
      current = ''
      return
    }
    current += `${current ? ' L' : 'M'} ${x(index).toFixed(2)} ${y(resolved).toFixed(2)}`
  })
  if (current) segments.push(current)
  return segments
}

function zonePolygons(
  points: TriggerDiscoveryMiniChartPoint[],
  x: (index: number) => number,
  y: (value: number) => number,
): string[] {
  const groups: Array<Array<{ index: number; ma1: number; ma2: number }>> = []
  let current: Array<{ index: number; ma1: number; ma2: number }> = []
  points.forEach((point, index) => {
    if (point.ma1 == null || point.ma2 == null) {
      if (current.length > 1) groups.push(current)
      current = []
      return
    }
    current.push({ index, ma1: point.ma1, ma2: point.ma2 })
  })
  if (current.length > 1) groups.push(current)
  return groups.map((group) => [
    ...group.map((point) => `${x(point.index).toFixed(2)},${y(Math.max(point.ma1, point.ma2)).toFixed(2)}`),
    ...[...group].reverse().map((point) => `${x(point.index).toFixed(2)},${y(Math.min(point.ma1, point.ma2)).toFixed(2)}`),
  ].join(' '))
}

export function TriggerMiniChart({
  chart,
  loading,
  failed,
  timeframe,
  ma1Period,
  ma2Period,
}: {
  chart?: TriggerDiscoveryMiniChart
  loading: boolean
  failed: boolean
  timeframe: TriggerDiscoveryTimeframe
  ma1Period: number
  ma2Period: number
}) {
  if (loading) {
    return <div className="h-[56px] w-[156px] animate-pulse rounded-[3px] bg-[var(--color-surface-muted)]" aria-label="Mini Chartを読み込み中" />
  }
  if (failed || !chart || chart.availability !== 'available' || chart.points.length < 2) {
    return (
      <div className="flex h-[56px] w-[156px] items-center justify-center text-[10px] text-[var(--color-text-tertiary)]">
        {chart?.availability === 'insufficient_history' ? '履歴不足' : '—'}
      </div>
    )
  }

  const values = finiteValues(chart.points)
  const minimum = Math.min(...values)
  const maximum = Math.max(...values)
  const padding = Math.max((maximum - minimum) * 0.08, Math.abs(maximum) * 0.005, 0.01)
  const low = minimum - padding
  const high = maximum + padding
  const x = (index: number) => PAD_X + (index / Math.max(1, chart.points.length - 1)) * (WIDTH - PAD_X * 2)
  const y = (value: number) => PAD_Y + ((high - value) / Math.max(0.000001, high - low)) * (HEIGHT - PAD_Y * 2)
  const latest = chart.points.at(-1)!
  const closePaths = lineSegments(chart.points, x, y, (point) => point.close)
  const ma1Paths = lineSegments(chart.points, x, y, (point) => point.ma1)
  const ma2Paths = lineSegments(chart.points, x, y, (point) => point.ma2)
  const timeframeLabel = timeframe === 'BIWEEKLY' ? '2週足' : '月足'
  const periodUnit = timeframe === 'BIWEEKLY' ? '本' : 'か月'
  const periodCode = timeframe === 'BIWEEKLY' ? '本' : 'M'

  return (
    <svg
      viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
      className="block h-[56px] w-[156px]"
      role="img"
      aria-label={`${chart.ticker} ${timeframeLabel}。終値、${ma1Period}${periodUnit}移動平均、${ma2Period}${periodUnit}移動平均。最新 ${chart.latestPointDate ?? '不明'}`}
    >
      <title>{`${chart.latestPointDate ?? '—'} 終値 ${latest.close.toFixed(2)} / ${ma1Period}${periodCode} ${latest.ma1?.toFixed(2) ?? '—'} / ${ma2Period}${periodCode} ${latest.ma2?.toFixed(2) ?? '—'}`}</title>
      {zonePolygons(chart.points, x, y).map((points, index) => (
        <polygon key={index} points={points} fill="var(--color-brand-100)" opacity="0.55" />
      ))}
      {ma1Paths.map((path, index) => <path key={`ma1-${index}`} d={path} fill="none" stroke="#2563eb" strokeWidth="1.2" vectorEffect="non-scaling-stroke" />)}
      {ma2Paths.map((path, index) => <path key={`ma2-${index}`} d={path} fill="none" stroke="#d97706" strokeWidth="1.2" vectorEffect="non-scaling-stroke" />)}
      {closePaths.map((path, index) => <path key={`close-${index}`} d={path} fill="none" stroke="var(--color-text-primary)" strokeWidth="1.55" vectorEffect="non-scaling-stroke" />)}
      <circle cx={x(chart.points.length - 1)} cy={y(latest.close)} r="1.9" fill="var(--color-text-primary)" />
    </svg>
  )
}
