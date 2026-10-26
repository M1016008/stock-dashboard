'use client'

// Shape of the SMA family under the assumed path: slope, curvature, crossings, convergence /
// divergence and the position of the close relative to each SMA. Pure presentation of
// lib/sma-dynamics-geometry; every number here is recomputed from the assumed closes.
import { useId, useMemo, useState, type KeyboardEvent } from 'react'
import { smaLabColor, type SmaLabPeriod } from '@/lib/sma-dynamics-lab'
import {
  analyzeShape,
  crossName,
  describeCross,
  describeShape,
  GAP_TREND_LABEL,
  ORDER_LABEL,
  snapshotAt,
  type CrossEvent,
  type GapPoint,
  type ShapeAnalysis,
  type ShapeTimeline,
} from '@/lib/sma-dynamics-geometry'
import { formatPct } from './SmaDynamicsPanels'

/** Confirmed bars drawn before the as-of bar (the future is always drawn in full). */
export const SHAPE_PAST_BARS = 30
const MAX_LINES = 6
const VIEW_W = 640
const PLOT_H = 150
const PAD = { left: 44, right: 10, top: 8, bottom: 16 }

export interface ShapeBarLabel {
  /** Last session of the bar (past) or of the assumed bar (future). */
  date: string
  /** "T+3" for assumed bars, null for confirmed ones. */
  tag: string | null
}

interface PlotSeries {
  id: string
  label: string
  color: string
  values: ReadonlyArray<number | null>
  dashed?: boolean
}

interface Marker {
  index: number
  value: number
  direction: 'up' | 'down'
  label: string
}

function fixed(value: number | null, digits = 2): string {
  return value == null || !Number.isFinite(value) ? '—' : value.toFixed(digits)
}

function signed(value: number | null, digits = 3): string {
  if (value == null || !Number.isFinite(value)) return '—'
  const text = Math.abs(value) < 0.5 * 10 ** -digits ? (0).toFixed(digits) : value.toFixed(digits)
  return `${value > 0 && Number(text) !== 0 ? '+' : ''}${text}`
}

function niceRange(values: number[]): { lo: number; hi: number } {
  if (values.length === 0) return { lo: -1, hi: 1 }
  let lo = Math.min(0, ...values)
  let hi = Math.max(0, ...values)
  if (hi - lo < 1e-9) { lo -= 1; hi += 1 }
  const pad = (hi - lo) * 0.08
  return { lo: lo - pad, hi: hi + pad }
}

/** One line plot with a zero line, an as-of divider, optional markers and a keyboard/hover readout. */
function LinePlot({
  title,
  unit,
  series,
  from,
  to,
  anchorIndex,
  labels,
  markers = [],
  digits = 2,
}: {
  title: string
  unit: string
  series: ReadonlyArray<PlotSeries>
  from: number
  to: number
  anchorIndex: number
  labels: ReadonlyArray<ShapeBarLabel>
  markers?: ReadonlyArray<Marker>
  digits?: number
}) {
  const id = useId()
  const [hover, setHover] = useState<number | null>(null)
  const count = to - from + 1
  const innerW = VIEW_W - PAD.left - PAD.right
  const innerH = PLOT_H - PAD.top - PAD.bottom
  const values = series.flatMap((item) => item.values.slice(from, to + 1).filter((value): value is number => value != null && Number.isFinite(value)))
  const { lo, hi } = niceRange(values)
  const x = (index: number) => PAD.left + (count <= 1 ? innerW / 2 : ((index - from) / (count - 1)) * innerW)
  const y = (value: number) => PAD.top + (1 - (value - lo) / (hi - lo)) * innerH
  const active = hover ?? anchorIndex

  const paths = series.map((item) => {
    let d = ''
    let pen = false
    for (let index = from; index <= to; index += 1) {
      const value = item.values[index]
      if (value == null || !Number.isFinite(value)) { pen = false; continue }
      d += `${pen ? 'L' : 'M'}${x(index).toFixed(1)} ${y(value).toFixed(1)} `
      pen = true
    }
    return { item, d: d.trim() }
  })

  const move = (delta: number) => setHover(Math.min(to, Math.max(from, (hover ?? anchorIndex) + delta)))
  const onKey = (event: KeyboardEvent<SVGSVGElement>) => {
    if (event.key === 'ArrowLeft') { event.preventDefault(); move(-1) }
    else if (event.key === 'ArrowRight') { event.preventDefault(); move(1) }
    else if (event.key === 'Home') { event.preventDefault(); setHover(from) }
    else if (event.key === 'End') { event.preventDefault(); setHover(to) }
    else if (event.key === 'Escape') setHover(null)
  }
  const label = labels[active]
  const readout = series.map((item) => `${item.label} ${signed(item.values[active] ?? null, digits)}${unit}`).join(' ・ ')

  return (
    <figure className="m-0 flex min-w-0 flex-col gap-1" data-sma-shape-plot={id}>
      <figcaption className="text-[11px] font-bold text-[var(--color-text-secondary)]">{title}</figcaption>
      <svg
        viewBox={`0 0 ${VIEW_W} ${PLOT_H}`}
        className="h-auto w-full max-w-full touch-pan-y overflow-visible rounded-[var(--radius-sm)] border border-[var(--color-border-soft)] bg-white outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-brand-600)]"
        role="img"
        tabIndex={0}
        aria-label={`${title}。左右キーで足を移動。${label ? `${label.tag ?? '確定'} ${label.date}: ${readout}` : ''}`}
        onKeyDown={onKey}
        onBlur={() => setHover(null)}
        onMouseLeave={() => setHover(null)}
        onMouseMove={(event) => {
          const rect = event.currentTarget.getBoundingClientRect()
          const px = ((event.clientX - rect.left) / rect.width) * VIEW_W
          const index = from + Math.round(((px - PAD.left) / innerW) * (count - 1))
          setHover(Math.min(to, Math.max(from, index)))
        }}
      >
        {anchorIndex < to && <rect x={x(anchorIndex)} y={PAD.top} width={Math.max(0, x(to) - x(anchorIndex))} height={innerH} fill="var(--color-surface-subtle)" opacity="0.7" />}
        {[lo, 0, hi].filter((value, i, all) => value >= lo && value <= hi && all.indexOf(value) === i).map((value) => (
          <g key={value}>
            <line x1={PAD.left} x2={VIEW_W - PAD.right} y1={y(value)} y2={y(value)} stroke={value === 0 ? 'var(--color-border-strong)' : 'var(--color-border-soft)'} strokeWidth={value === 0 ? 1.25 : 0.75} />
            {(value === 0 || value === lo || value === hi) && <text x={PAD.left - 4} y={y(value) + 3} textAnchor="end" fontSize="9" fill="var(--color-text-tertiary)">{value === 0 ? '0' : value.toFixed(digits === 3 ? 2 : 1)}</text>}
          </g>
        ))}
        <line x1={x(anchorIndex)} x2={x(anchorIndex)} y1={PAD.top} y2={PAD.top + innerH} stroke="var(--color-border-strong)" strokeDasharray="3 3" />
        <text x={x(anchorIndex) + 3} y={PAD.top + 9} fontSize="9" fill="var(--color-text-tertiary)">基準日</text>
        {paths.map(({ item, d }) => d && (
          <path key={item.id} d={d} fill="none" stroke={item.color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" strokeDasharray={item.dashed ? '5 3' : undefined} />
        ))}
        {markers.filter((marker) => marker.index >= from && marker.index <= to).map((marker, i) => (
          <g key={`${marker.label}-${i}`}>
            <path
              d={marker.direction === 'up'
                ? `M${x(marker.index)} ${y(marker.value) - 6} l5 9 h-10 z`
                : `M${x(marker.index)} ${y(marker.value) + 6} l5 -9 h-10 z`}
              fill="var(--color-surface-base, #fff)"
              stroke="var(--color-text-primary)"
              strokeWidth={1.5}
            >
              <title>{marker.label}</title>
            </path>
          </g>
        ))}
        {hover != null && <line x1={x(hover)} x2={x(hover)} y1={PAD.top} y2={PAD.top + innerH} stroke="var(--color-text-secondary)" strokeWidth={1} />}
        {hover != null && paths.map(({ item }) => {
          const value = item.values[hover]
          return value == null ? null : <circle key={item.id} cx={x(hover)} cy={y(value)} r={3.5} fill={item.color} stroke="#fff" strokeWidth={2} />
        })}
        <text x={PAD.left} y={PLOT_H - 3} fontSize="9" fill="var(--color-text-tertiary)">{labels[from]?.date.slice(2) ?? ''}</text>
        <text x={VIEW_W - PAD.right} y={PLOT_H - 3} textAnchor="end" fontSize="9" fill="var(--color-text-tertiary)">{labels[to]?.tag ?? ''} {labels[to]?.date.slice(2) ?? ''}</text>
      </svg>
      <p className="m-0 min-h-4 font-mono text-[10px] font-medium tabular-nums text-[var(--color-text-secondary)]" data-sma-shape-readout>
        {label ? <><b className="font-sans">{label.tag ?? '確定'} {label.date}</b> ・ {readout}</> : ''}
      </p>
    </figure>
  )
}

function pairLabel(shorter: SmaLabPeriod, longer: SmaLabPeriod): string {
  return `SMA${shorter} − SMA${longer}`
}

function PositionStrip({
  analysis,
  from,
  to,
  anchorIndex,
}: {
  analysis: ShapeAnalysis
  from: number
  to: number
  anchorIndex: number
}) {
  const cell = (point: GapPoint | undefined) => {
    if (!point || point.side == null) return { glyph: '·', cls: 'text-[var(--color-text-tertiary)]', text: '計算不可' }
    if (point.side === 0) return { glyph: '＝', cls: 'text-amber-700', text: '接触' }
    return point.side > 0 ? { glyph: '▲', cls: 'text-emerald-700', text: '終値がSMAより上' } : { glyph: '▼', cls: 'text-rose-700', text: '終値がSMAより下' }
  }
  const indexes = Array.from({ length: to - from + 1 }, (_, i) => from + i)
  const orderGlyph = { bullish: { glyph: '↗', cls: 'text-emerald-700' }, bearish: { glyph: '↘', cls: 'text-rose-700' }, mixed: { glyph: '～', cls: 'text-[var(--color-text-tertiary)]' } } as const
  return (
    <div className="min-w-0 overflow-x-auto" data-sma-position-strip>
      <table className="border-collapse text-[10px] leading-4" aria-label="終値とSMAの位置関係 (▲上 ▼下 ＝接触) と並び順">
        <thead>
          <tr>
            <th scope="col" className="sticky left-0 bg-white pr-2 text-left font-bold text-[var(--color-text-tertiary)]">足</th>
            {indexes.map((index) => (
              <th key={index} scope="col" className={`w-3.5 min-w-3.5 p-0 text-center font-normal ${index > anchorIndex ? 'bg-[var(--color-surface-subtle)]' : ''} ${index === anchorIndex ? 'border-r border-dashed border-[var(--color-border-strong)]' : ''}`}>
                <span className="sr-only">{index > anchorIndex ? `T+${index - anchorIndex}` : index === anchorIndex ? '基準日' : `${anchorIndex - index}本前`}</span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {analysis.closes.map((item) => (
            <tr key={item.period}>
              <th scope="row" className="sticky left-0 whitespace-nowrap bg-white pr-2 text-left font-mono font-bold" style={{ color: 'var(--color-text-primary)' }}>
                <span aria-hidden="true" className="mr-1 inline-block size-2 rounded-full" style={{ background: smaLabColor(item.period) }} />終値 vs SMA{item.period}
              </th>
              {indexes.map((index) => {
                const c = cell(item.points[index])
                return (
                  <td key={index} className={`p-0 text-center ${c.cls} ${index > anchorIndex ? 'bg-[var(--color-surface-subtle)]' : ''} ${index === anchorIndex ? 'border-r border-dashed border-[var(--color-border-strong)]' : ''}`} title={`${c.text} ${signed(item.points[index]?.gapPct ?? null, 2)}%`}>
                    <span aria-hidden="true">{c.glyph}</span><span className="sr-only">{c.text}</span>
                  </td>
                )
              })}
            </tr>
          ))}
          {analysis.periods.length >= 2 && (
            <tr>
              <th scope="row" className="sticky left-0 whitespace-nowrap bg-white pr-2 text-left font-bold text-[var(--color-text-secondary)]">SMAの並び</th>
              {indexes.map((index) => {
                const point = analysis.order[index]
                const g = point?.kind ? orderGlyph[point.kind] : { glyph: '·', cls: 'text-[var(--color-text-tertiary)]' }
                return (
                  <td key={index} className={`p-0 text-center ${g.cls} ${index > anchorIndex ? 'bg-[var(--color-surface-subtle)]' : ''} ${index === anchorIndex ? 'border-r border-dashed border-[var(--color-border-strong)]' : ''}`} title={point?.kind ? `${ORDER_LABEL[point.kind]}: ${point.ranking?.map((p) => `SMA${p}`).join(' > ')}` : '計算不可'}>
                    <span aria-hidden="true">{g.glyph}</span><span className="sr-only">{point?.kind ? ORDER_LABEL[point.kind] : '計算不可'}</span>
                  </td>
                )
              })}
            </tr>
          )}
        </tbody>
      </table>
      <p className="m-0 mt-1 text-[10px] font-medium text-[var(--color-text-tertiary)]">▲ 終値がSMAより上 ・ ▼ 下 ・ ＝ 同値 ・ 並び: ↗ 短期ほど上 ・ ↘ 短期ほど下 ・ ～ 入り交じり。灰色の背景は仮定した足です。</p>
    </div>
  )
}

export function SmaShapePanel({
  timeline,
  periods,
  labels,
  sourceLabel,
  barNoun,
}: {
  timeline: ShapeTimeline
  /** Periods that have a usable SMA at the as-of bar. */
  periods: ReadonlyArray<SmaLabPeriod>
  labels: ReadonlyArray<ShapeBarLabel>
  /** "価格固定" / "シナリオ" / "逆算経路": the assumption behind the future bars. */
  sourceLabel: string
  barNoun: string
}) {
  const shown = useMemo(() => [...periods].sort((a, b) => a - b).slice(0, MAX_LINES), [periods])
  const analysis = useMemo(() => analyzeShape(timeline, shown), [timeline, shown])
  const anchor = timeline.anchorIndex
  const last = timeline.closes.length - 1
  const from = Math.max(1, anchor - SHAPE_PAST_BARS)
  const now = snapshotAt(analysis, timeline, anchor)
  const end = snapshotAt(analysis, timeline, last)
  const futureCrosses = analysis.crosses.filter((event) => event.phase === 'future')
  const recentPast = analysis.crosses.filter((event) => event.phase === 'past' && event.index >= from)

  if (shown.length === 0) {
    return <p className="m-0 text-[11px] font-medium text-[var(--color-text-tertiary)]" data-sma-shape-empty>計算できるSMAがないため、形の分析はありません。SMAを選ぶか、時間軸を変えてください。</p>
  }

  const slopeSeries: PlotSeries[] = shown.map((period) => ({
    id: `s${period}`,
    label: `SMA${period}`,
    color: smaLabColor(period),
    values: analysis.slopes[period].map((point) => point.slopePct),
  }))
  const curvatureSeries: PlotSeries[] = shown.map((period) => ({
    id: `c${period}`,
    label: `SMA${period}`,
    color: smaLabColor(period),
    values: analysis.slopes[period].map((point) => point.curvaturePct),
    dashed: true,
  }))
  const pairSeries: PlotSeries[] = analysis.pairs.map((pair) => ({
    id: `p${pair.shorter}-${pair.longer}`,
    label: pairLabel(pair.shorter, pair.longer),
    color: smaLabColor(pair.shorter),
    values: pair.points.map((point) => point.gapPct),
  }))
  const crossMarkers: Marker[] = analysis.pairs.flatMap((pair) => pair.crosses.map((event) => ({
    index: event.index,
    value: pair.points[event.index]?.gapPct ?? 0,
    direction: event.direction,
    label: describeCross(event),
  })))
  const bandValues: PlotSeries[] = analysis.periods.length >= 2
    ? [{ id: 'band', label: 'SMAの幅', color: 'var(--color-text-secondary)', values: analysis.band.map((point) => point.widthPct) }]
    : []

  const crossLine = (event: CrossEvent) => {
    const bar = labels[event.index]
    const name = crossName(event)
    return (
      <li key={`${event.subject}-${event.reference}-${event.index}`} className="flex flex-wrap items-baseline gap-x-2" data-sma-cross-event={event.phase}>
        <span className="font-mono font-bold">{bar?.tag ?? bar?.date ?? `#${event.index}`}</span>
        <span>{describeCross(event)}</span>
        {name && <span className="text-[var(--color-text-tertiary)]">({name})</span>}
        {event.touchIndex != null && <span className="text-[var(--color-text-tertiary)]">途中で一度同値</span>}
      </li>
    )
  }

  return (
    <div className="flex min-w-0 flex-col gap-3" data-sma-shape-panel data-source={sourceLabel}>
      <p className="m-0 text-[11px] font-medium leading-5 text-[var(--color-text-secondary)]">
        「{sourceLabel}」で仮定した終値に対する、SMAの形です。傾きは直前の{barNoun}からの変化率 (%/本)、曲率は傾きの変化 (正 = 上向きに曲がる)。将来の株価を示すものではありません。
        {periods.length > MAX_LINES && <> 線が多いため先頭の{MAX_LINES}本 (SMA{shown.join('・')}) を表示します。</>}
      </p>

      <div className="max-w-full overflow-x-auto rounded-[var(--radius-sm)] border border-[var(--color-border-soft)]">
        <table className="w-full border-collapse font-mono text-[11px] tabular-nums" data-sma-shape-table>
          <caption className="sr-only">基準日と最後の仮定足でのSMAの傾き・曲率・形と、終値との位置</caption>
          <thead className="bg-white">
            <tr className="border-b border-[var(--color-border-default)] text-[var(--color-text-tertiary)]">
              <th scope="col" className="py-1 pl-2 pr-2 text-left font-sans font-bold">SMA</th>
              <th scope="col" className="px-1.5 py-1 text-right font-sans font-bold">傾き 基準日</th>
              <th scope="col" className="px-1.5 py-1 text-right font-sans font-bold">曲率 基準日</th>
              <th scope="col" className="px-1.5 py-1 text-left font-sans font-bold">形 基準日</th>
              <th scope="col" className="px-1.5 py-1 text-right font-sans font-bold">傾き 最終足</th>
              <th scope="col" className="px-1.5 py-1 text-left font-sans font-bold">形 最終足</th>
              <th scope="col" className="px-1.5 py-1 text-right font-sans font-bold">終値との差 基準日</th>
              <th scope="col" className="px-1.5 py-1 text-right font-sans font-bold">最終足</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[var(--color-border-soft)]">
            {now.map((row, i) => (
              <tr key={row.period} data-period={row.period}>
                <th scope="row" className="whitespace-nowrap py-1 pl-2 pr-2 text-left font-bold"><span aria-hidden="true" className="mr-1 inline-block size-2 rounded-full" style={{ background: smaLabColor(row.period) }} />SMA{row.period}</th>
                <td className="px-1.5 py-1 text-right">{signed(row.slopePct)}%</td>
                <td className="px-1.5 py-1 text-right">{signed(row.curvaturePct)}</td>
                <td className="px-1.5 py-1 text-left font-sans">{describeShape(row)}</td>
                <td className="px-1.5 py-1 text-right">{signed(end[i].slopePct)}%</td>
                <td className="px-1.5 py-1 text-left font-sans">{describeShape(end[i])}</td>
                <td className="px-1.5 py-1 text-right">{formatPct(row.closeGapPct)}</td>
                <td className="px-1.5 py-1 text-right">{formatPct(end[i].closeGapPct)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="grid min-w-0 gap-3 lg:grid-cols-2">
        <LinePlot title="傾き (%/本)" unit="%" series={slopeSeries} from={from} to={last} anchorIndex={anchor} labels={labels} digits={3} />
        <LinePlot title="曲率 (傾きの変化, 点線)" unit="" series={curvatureSeries} from={from} to={last} anchorIndex={anchor} labels={labels} digits={3} />
      </div>

      {analysis.pairs.length > 0 && (
        <div className="flex min-w-0 flex-col gap-2" data-sma-pair-section>
          <LinePlot title="SMA間の差 (短期 − 長期, % / 0で交差、△▽は交差)" unit="%" series={pairSeries} from={from} to={last} anchorIndex={anchor} labels={labels} markers={crossMarkers} digits={2} />
          <div className="max-w-full overflow-x-auto rounded-[var(--radius-sm)] border border-[var(--color-border-soft)]">
            <table className="w-full border-collapse font-mono text-[11px] tabular-nums" data-sma-pair-table>
              <caption className="sr-only">隣り合うSMAの差と収束・拡散</caption>
              <thead>
                <tr className="border-b border-[var(--color-border-default)] text-[var(--color-text-tertiary)]">
                  <th scope="col" className="py-1 pl-2 pr-2 text-left font-sans font-bold">組</th>
                  <th scope="col" className="px-1.5 py-1 text-right font-sans font-bold">差 基準日</th>
                  <th scope="col" className="px-1.5 py-1 text-left font-sans font-bold">基準日の動き</th>
                  <th scope="col" className="px-1.5 py-1 text-right font-sans font-bold">差 最終足</th>
                  <th scope="col" className="px-1.5 py-1 text-left font-sans font-bold">最終足の動き</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--color-border-soft)]">
                {analysis.pairs.map((pair) => {
                  const atNow = pair.points[anchor]
                  const atEnd = pair.points[last]
                  return (
                    <tr key={`${pair.shorter}-${pair.longer}`}>
                      <th scope="row" className="whitespace-nowrap py-1 pl-2 pr-2 text-left font-bold">{pairLabel(pair.shorter, pair.longer)}</th>
                      <td className="px-1.5 py-1 text-right">{formatPct(atNow?.gapPct ?? null)}</td>
                      <td className="px-1.5 py-1 text-left font-sans">{atNow?.trend ? GAP_TREND_LABEL[atNow.trend] : '—'}</td>
                      <td className="px-1.5 py-1 text-right">{formatPct(atEnd?.gapPct ?? null)}</td>
                      <td className="px-1.5 py-1 text-left font-sans">{atEnd?.trend ? GAP_TREND_LABEL[atEnd.trend] : '—'}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {bandValues.length > 0 && (
        <p className="m-0 text-[11px] font-medium leading-5 text-[var(--color-text-secondary)]" data-sma-band>
          SMA全体の幅 (最大−最小 ÷ 最小): 基準日 <b className="font-mono">{fixed(analysis.band[anchor]?.widthPct ?? null)}%</b>
          {analysis.band[anchor]?.trend && <>({GAP_TREND_LABEL[analysis.band[anchor].trend!]})</>}
          {' → '}最終足 <b className="font-mono">{fixed(analysis.band[last]?.widthPct ?? null)}%</b>
          {analysis.band[last]?.trend && <>({GAP_TREND_LABEL[analysis.band[last].trend!]})</>}。
        </p>
      )}

      <PositionStrip analysis={analysis} from={from} to={last} anchorIndex={anchor} />

      <section aria-label="交差の一覧" className="min-w-0" data-sma-cross-list>
        <h4 className="m-0 mb-0.5 text-[11px] font-bold text-[var(--color-text-secondary)]">交差 (SMA同士・終値とSMA)</h4>
        {futureCrosses.length === 0 && recentPast.length === 0 ? (
          <p className="m-0 text-[11px] font-medium text-[var(--color-text-tertiary)]">表示範囲と仮定した足のあいだに交差はありません。</p>
        ) : (
          <ul className="m-0 flex list-none flex-col gap-0.5 p-0 text-[11px] font-medium text-[var(--color-text-primary)]">
            {futureCrosses.length > 0 && <li className="text-[10px] font-bold text-[var(--color-text-tertiary)]">仮定した足</li>}
            {futureCrosses.map(crossLine)}
            {recentPast.length > 0 && <li className="mt-1 text-[10px] font-bold text-[var(--color-text-tertiary)]">直近の確定足</li>}
            {recentPast.map(crossLine)}
          </ul>
        )}
      </section>
    </div>
  )
}
