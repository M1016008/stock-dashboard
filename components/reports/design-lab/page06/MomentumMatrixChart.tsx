import {
  MOMENTUM_STATE_LABEL,
  MOMENTUM_THRESHOLDS,
  formatShift,
  type MomentumMatrixModel,
  type MomentumPoint,
  type MomentumState,
} from '@/lib/daily-close-momentum-matrix'
import { MATRIX, STATE_COLOR } from './layout'

// Momentum Matrix 描画。X = 1M順位 (右ほど上位)、Y = 1W順位 (上ほど上位)。
// 状態ゾーンは MOMENTUM_THRESHOLDS と一致させる (判定ロジックと描画の境界を共有)。

const { plot, rankMax } = MATRIX

export function xOf(rank1M: number): number {
  return plot.left + (rankMax + 0.5 - rank1M) / rankMax * plot.width
}

export function yOf(rank1W: number): number {
  return plot.top + (rank1W - 0.5) / rankMax * plot.height
}

function zonePoints(corners: Array<[number, number]>): string {
  return corners.map(([rank1M, rank1W]) => `${xOf(rank1M).toFixed(1)},${yOf(rank1W).toFixed(1)}`).join(' ')
}

type Zone = { state: Exclude<MomentumState, 'NEUTRAL'>; corners: Array<[number, number]>; label: [number, number]; anchor: 'start' | 'end' }

const { top, lowerHalf, bottomQuartile, recoveringShift } = MOMENTUM_THRESHOLDS
const ZONES: Zone[] = [
  // 上位維持のラベルは右下 (右上は 1M・1W 上位の点とラベルが集中するため)
  { state: 'LEADER', corners: [[0.5, 0.5], [top + 0.5, 0.5], [top + 0.5, top + 0.5], [0.5, top + 0.5]], label: [1, top - 0.4], anchor: 'end' },
  { state: 'EMERGING', corners: [[lowerHalf + 0.5, 0.5], [rankMax + 0.5, 0.5], [rankMax + 0.5, top + 0.5], [lowerHalf + 0.5, top + 0.5]], label: [rankMax, 1.6], anchor: 'start' },
  { state: 'FADING', corners: [[0.5, lowerHalf + 0.5], [top + 0.5, lowerHalf + 0.5], [top + 0.5, rankMax + 0.5], [0.5, rankMax + 0.5]], label: [1, rankMax - 0.4], anchor: 'end' },
  {
    // 1M>45 かつ Shift≥15 (= 1W ≤ 1M − 15)、ただし 1W≤15 は急浮上
    state: 'RECOVERING',
    corners: [[bottomQuartile + 0.5, top + 0.5], [rankMax + 0.5, top + 0.5], [rankMax + 0.5, rankMax + 0.5 - recoveringShift], [bottomQuartile + 0.5, bottomQuartile + 0.5 - recoveringShift]],
    label: [rankMax, top + 2.4],
    anchor: 'start',
  },
]

type PlacedLabel = { point: MomentumPoint; x: number; y: number; px: number; py: number; anchor: 'start' | 'end' }

// ラベルは点の左右 (プロット中央より右の点は左側) に置き、同じ側で縦に labelGap 以上離す
export function placeLabels(points: MomentumPoint[]): PlacedLabel[] {
  const placed: PlacedLabel[] = []
  for (const side of ['start', 'end'] as const) {
    const group = points
      .filter((point) => point.rank1M != null && point.rank1W != null)
      .map((point) => ({ point, px: xOf(point.rank1M!), py: yOf(point.rank1W!) }))
      .filter(({ px }) => (px > plot.left + plot.width / 2 ? 'end' : 'start') === side)
      .sort((a, b) => a.py - b.py || a.point.name.localeCompare(b.point.name, 'ja'))
    let lastY = -Infinity
    for (const item of group) {
      const y = Math.min(plot.top + plot.height - 4, Math.max(item.py + 4, lastY + MATRIX.labelGap))
      lastY = y
      placed.push({ ...item, y, x: side === 'end' ? item.px - MATRIX.labelOffset : item.px + MATRIX.labelOffset, anchor: side })
    }
  }
  return placed
}

export function MomentumMatrixChart({ model }: { model: MomentumMatrixModel }) {
  const plotted = model.points.filter((point) => point.rank1M != null && point.rank1W != null)
  const labels = placeLabels(plotted.filter((point) => point.labeled))
  const bottom = plot.top + plot.height
  const right = plot.left + plot.width
  const diagonalAngle = (Math.atan2(plot.height, plot.width) * -180 / Math.PI).toFixed(1)
  return (
    <svg className="matrix" viewBox={`0 0 ${MATRIX.viewWidth} ${MATRIX.viewHeight}`} role="img" aria-label="60分類 1M順位×1W順位 Momentum Matrix">
      <rect x={plot.left} y={plot.top} width={plot.width} height={plot.height} className="plotFrame" />
      {ZONES.map((zone) => (
        <g key={zone.state}>
          <polygon points={zonePoints(zone.corners)} fill={STATE_COLOR[zone.state]} fillOpacity={MATRIX.zoneFillOpacity} stroke={STATE_COLOR[zone.state]} strokeOpacity={MATRIX.zoneStrokeOpacity} strokeWidth={0.8} />
          <text x={xOf(zone.label[0]) + (zone.anchor === 'end' ? -4 : 4)} y={yOf(zone.label[1])} textAnchor={zone.anchor} className="zoneLabel" fill={STATE_COLOR[zone.state]}>
            {MOMENTUM_STATE_LABEL[zone.state]} {model.counts[zone.state]}
          </text>
        </g>
      ))}
      {MATRIX.ticks.map((tick) => (
        <g key={`tick-${tick}`}>
          <line x1={xOf(tick)} y1={bottom} x2={xOf(tick)} y2={bottom + 4} className="tick" />
          <text x={xOf(tick)} y={bottom + 14} textAnchor="middle" className="tickLabel">{tick}</text>
          <line x1={plot.left - 4} y1={yOf(tick)} x2={plot.left} y2={yOf(tick)} className="tick" />
          <text x={plot.left - 7} y={yOf(tick) + 3.5} textAnchor="end" className="tickLabel">{tick}</text>
        </g>
      ))}
      <line x1={xOf(rankMax + 0.5)} y1={yOf(rankMax + 0.5)} x2={xOf(0.5)} y2={yOf(0.5)} className="diagonal" />
      <text x={xOf(22)} y={yOf(25.5)} className="diagonalLabel" transform={`rotate(${diagonalAngle} ${xOf(22)} ${yOf(25.5)})`}>順位変化なし（対角線より上 = 1Wで順位上昇）</text>
      {plotted.map((point) => (
        <circle
          key={point.name}
          cx={xOf(point.rank1M!)}
          cy={yOf(point.rank1W!)}
          r={point.labeled ? MATRIX.labeledPointRadius : MATRIX.pointRadius}
          fill={point.lowSample ? '#ffffff' : STATE_COLOR[point.state]}
          fillOpacity={point.lowSample ? 1 : point.state === 'NEUTRAL' ? MATRIX.neutralFillOpacity : MATRIX.stateFillOpacity}
          stroke={point.lowSample ? STATE_COLOR[point.state] : point.labeled ? '#0b1f33' : '#ffffff'}
          strokeWidth={point.lowSample ? 1.3 : point.labeled ? 1.2 : 0.8}
          strokeDasharray={point.lowSample ? MATRIX.lowSampleDash : undefined}
        />
      ))}
      {labels.map((label) => (
        <g key={`label-${label.point.name}`}>
          {Math.abs(label.y - 4 - label.py) > MATRIX.leaderMinOffset
            ? <line x1={label.px} y1={label.py} x2={label.x + (label.anchor === 'end' ? 2 : -2)} y2={label.y - 4} className="leader" />
            : null}
          <text x={label.x} y={label.y} textAnchor={label.anchor} className="pointLabel">
            {label.point.name}<tspan className="pointShift" dx="3">{formatShift(label.point.momentumShift)}</tspan>
          </text>
        </g>
      ))}
      <text x={right} y={MATRIX.viewHeight - 4} textAnchor="end" className="axisTitle">1M順位（右ほど上位）→</text>
      <text x={plot.left - 40} y={plot.top - MATRIX.axisTitleOffsetY} className="axisTitle">↑ 1W順位（上ほど上位）</text>
    </svg>
  )
}
