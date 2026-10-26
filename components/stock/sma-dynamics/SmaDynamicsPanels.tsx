'use client'

import { ChevronRight } from 'lucide-react'
import {
  describeSmaLabIssueKind,
  smaLabColor,
  type SmaLabAvailable,
  type SmaLabPeriod,
  type SmaLabSeries,
} from '@/lib/sma-dynamics-lab'
import {
  SMA_LAB_CANDLE_COLORS,
  SMA_LAB_FROZEN_LINE_COLOR,
  SMA_LAB_OVERLAY_CLOSE_COLORS,
  type SmaLabChartModel,
  type SmaLabOverlayEmphasis,
  type SmaLabOverlayId,
} from '@/lib/sma-dynamics-chart-model'
import { smaLabTimeframe, type SmaLabBar, type SmaLabDataIssue } from '@/lib/sma-dynamics-timeframes'

export type PriceFormat = (value: number | null | undefined) => string

export function priceFormatter(digits: number): PriceFormat {
  const format = new Intl.NumberFormat('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })
  return (value) => (value == null || !Number.isFinite(value) ? '—' : format.format(value))
}

const volumeFormat = new Intl.NumberFormat('en-US')

export function formatPct(value: number | null): string {
  if (value == null || !Number.isFinite(value)) return '—'
  const rounded = Math.abs(value) < 0.005 ? 0 : value
  return `${rounded > 0 ? '+' : ''}${rounded.toFixed(2)}%`
}

function formatSigned(value: number | null, fmt: PriceFormat): string {
  if (value == null || !Number.isFinite(value)) return '—'
  return `${value > 0 ? '+' : value < 0 ? '-' : ''}${fmt(Math.abs(value))}`
}

export function barPeriodText(bar: Pick<SmaLabBar, 'firstSession' | 'lastSession'>): string {
  return bar.firstSession === bar.lastSession ? bar.firstSession : `${bar.firstSession}〜${bar.lastSession.slice(5)}`
}

export function barStatusText(bar: SmaLabBar): string {
  if (bar.phase === 'forming') return `未確定 (${bar.elapsedSessions}/${bar.expectedSessions}営業日経過)`
  if (!bar.closeExact) return '確定 ・ 終値なし (SMAに使用しません)'
  const notes: string[] = []
  if (bar.leadingPartial) notes.push('履歴開始前の営業日を含む')
  if (bar.missingDates.length > 0) notes.push(`欠損${bar.missingDates.length}日`)
  if (bar.invalidDates.length > 0) notes.push(`不正${bar.invalidDates.length}日`)
  if (notes.length === 0 && !bar.ohlcComplete) notes.push('OHLC不完全')
  return notes.length > 0 ? `確定 ・ ${notes.join('・')}` : '確定'
}

function Swatch({ color, dash }: { color: string; dash?: string }) {
  return (
    <svg aria-hidden="true" focusable="false" width="22" height="8" viewBox="0 0 22 8" className="shrink-0">
      <line x1="1" y1="4" x2="21" y2="4" stroke={color} strokeWidth="2" strokeDasharray={dash} strokeLinecap="round" />
    </svg>
  )
}

/** One assumed path shown in the readout (Price Freeze, scenario or solver path). */
export interface ReadoutLayer {
  id: SmaLabOverlayId
  label: string
  closes: ReadonlyArray<number | null>
  sma: SmaLabSeries
  primary: boolean
}

export function SlotReadout({
  id,
  result,
  model,
  slot,
  periods,
  fmt,
  layers,
}: {
  id: string
  result: SmaLabAvailable
  model: SmaLabChartModel
  slot: number
  periods: readonly SmaLabPeriod[]
  fmt: PriceFormat
  /** Assumptions drawn on the chart; defaults to Price Freeze only (Phase 1). */
  layers?: readonly ReadoutLayer[]
}) {
  const info = model.slots[Math.min(Math.max(slot, 0), model.slots.length - 1)]
  const tf = smaLabTimeframe(result.timeframe)
  const isBar = info.kind === 'bar'
  const bar = info.bar
  const future = info.future
  const forming = bar?.phase === 'forming'
  const kind = !isBar ? 'assumed' : forming ? 'forming' : 'actual'
  const chip = kind === 'assumed'
    ? { text: `仮定 T+${future?.k}`, className: 'border-dashed border-[var(--color-text-tertiary)] text-[var(--color-text-secondary)]' }
    : kind === 'forming'
      ? { text: '未確定足', className: 'border-amber-300 bg-amber-50 text-amber-800' }
      : { text: '実績', className: 'border-[var(--color-border-strong)] text-[var(--color-text-primary)]' }
  const primary = layers?.find((layer) => layer.primary) ?? null
  const usesFreeze = !primary || primary.id === 'freeze'
  const secondary = (layers ?? []).filter((layer) => layer !== primary)
  const assumedClose = future ? (usesFreeze ? future.close : primary!.closes[future.k - 1] ?? null) : null
  const smaValue = (period: SmaLabPeriod): number | null => {
    if (!isBar && future) return usesFreeze ? result.projection.sma[period][future.k - 1] : primary!.sma[period][future.k - 1] ?? null
    if (forming) return result.periods.find((item) => item.period === period)?.provisionalValue ?? null
    return bar ? result.sma[period][bar.index] : null
  }
  const smaLabel = kind === 'assumed' ? (usesFreeze ? '仮定SMA' : `仮定SMA (${primary!.label})`) : kind === 'forming' ? '暫定SMA' : 'SMA'

  return (
    <div
      id={id}
      className="flex min-h-[36px] flex-wrap items-baseline gap-x-3 gap-y-1 px-0.5 font-mono text-[11px] tabular-nums text-[var(--color-text-secondary)]"
      data-sma-dynamics-readout
    >
      <span className={`inline-flex items-center rounded-[3px] border px-1 font-sans text-[10px] font-bold ${chip.className}`}>{chip.text}</span>
      <span className="font-bold text-[var(--color-text-primary)]">
        {barPeriodText(bar ?? future!)}
        <span className="ml-1 font-sans font-medium text-[var(--color-text-tertiary)]">{tf.name}</span>
      </span>
      {bar && <span className="font-sans text-[var(--color-text-tertiary)]">{barStatusText(bar)}</span>}
      {!isBar && future && (
        <span className="font-sans text-[var(--color-text-tertiary)]">
          基準日の後 {future.sessionsAhead}営業日 ・ 仮定終値{usesFreeze ? '' : ` (${primary!.label})`}{' '}
          <b className="font-mono text-[var(--color-text-primary)]">{assumedClose == null ? '未入力' : fmt(assumedClose)}</b>
        </span>
      )}
      {bar && bar.open != null && (
        <span>
          始 {fmt(bar.open)} 高 {fmt(bar.high)} 安 {fmt(bar.low)} <span className="font-sans">{forming ? '現在' : '終'}</span> <b className="text-[var(--color-text-primary)]">{fmt(bar.close)}</b>
          {bar.volume != null && <span className="ml-2">出来高 {volumeFormat.format(bar.volume)}</span>}
        </span>
      )}
      {bar && bar.open == null && <span className="font-sans">ローソク足なし (終値 {fmt(bar.close)})</span>}
      {periods.length > 0 && (
        <span className="inline-flex flex-wrap items-baseline gap-x-2.5 gap-y-0.5">
          <span className="font-sans text-[10px] font-bold text-[var(--color-text-tertiary)]">{smaLabel}</span>
          {periods.map((period) => (
            <span key={period} className="inline-flex items-baseline gap-1">
              <span aria-hidden="true" className="inline-block h-2 w-2 self-center rounded-full" style={{ background: smaLabColor(period) }} />
              {period} <b className="text-[var(--color-text-primary)]">{fmt(smaValue(period))}</b>
            </span>
          ))}
        </span>
      )}
      {forming && future && (
        <span className="w-full font-sans text-[10px] text-[var(--color-text-tertiary)]">
          暫定SMAは現在値を含む参考値で、確定SMA(実線)には含めません。
          {usesFreeze
            ? `価格固定ではこの足が ${fmt(future.close)} のまま ${future.lastSession} に確定すると仮定します。`
            : `${primary!.label}ではこの足が ${assumedClose == null ? '(未入力)' : fmt(assumedClose)} で ${future.lastSession} に確定すると仮定します。`}
        </span>
      )}
      {future && !forming && !isBar && secondary.length > 0 && (
        <span className="flex w-full flex-wrap gap-x-3 gap-y-0.5 text-[10px] text-[var(--color-text-tertiary)]" data-sma-dynamics-readout-compare>
          {secondary.map((layer) => (
            <span key={layer.id} className="inline-flex flex-wrap items-baseline gap-x-1.5">
              <span className="font-sans font-bold">{layer.label}</span>
              終値 {fmt(layer.closes[future.k - 1] ?? null)}
              {periods.map((period) => <span key={period}>{period} {fmt(layer.sma[period][future.k - 1] ?? null)}</span>)}
            </span>
          ))}
        </span>
      )}
    </div>
  )
}

export function ChartLegend({
  hasForming,
  hasIncomplete,
  freeze = 'primary',
  overlays = [],
  hasBoundary = false,
}: {
  hasForming: boolean
  hasIncomplete: boolean
  freeze?: SmaLabOverlayEmphasis | 'hidden'
  overlays?: ReadonlyArray<{ id: Exclude<SmaLabOverlayId, 'freeze'>; label: string; muted: boolean }>
  hasBoundary?: boolean
}) {
  const item = 'inline-flex items-center gap-1.5'
  const fade = (muted: boolean) => (muted ? ' (淡色: 比較)' : '')
  return (
    <ul className="m-0 flex list-none flex-wrap gap-x-4 gap-y-1 p-0 text-[11px] font-medium text-[var(--color-text-secondary)]" aria-label="凡例" data-sma-dynamics-legend>
      <li className={item}><Swatch color="#334155" />実線: 実績SMA (確定足の終値)</li>
      {freeze !== 'hidden' && (
        <>
          <li className={item}><Swatch color="#334155" dash="1 3" />点線: 価格固定を仮定したSMA{fade(freeze === 'muted')}</li>
          <li className={item}><Swatch color={SMA_LAB_FROZEN_LINE_COLOR} dash="6 3" />破線: 仮定した将来終値</li>
        </>
      )}
      {overlays.length > 0 && <li className={item}><Swatch color="#334155" dash="5 3" />色付き破線: シナリオ・逆算経路のSMA</li>}
      {overlays.map((overlay) => (
        <li key={overlay.id} className={item}>
          <svg aria-hidden="true" focusable="false" width="22" height="8" viewBox="0 0 22 8" className="shrink-0">
            <line x1="1" y1="4" x2="21" y2="4" stroke={SMA_LAB_OVERLAY_CLOSE_COLORS[overlay.id]} strokeWidth="2" opacity={overlay.muted ? 0.4 : 1} />
            <circle cx="11" cy="4" r="2.5" fill={SMA_LAB_OVERLAY_CLOSE_COLORS[overlay.id]} opacity={overlay.muted ? 0.4 : 1} />
          </svg>
          {overlay.label}の仮定終値 (ローソク足は作りません){fade(overlay.muted)}
        </li>
      ))}
      {hasBoundary && <li className={item}><Swatch color={SMA_LAB_OVERLAY_CLOSE_COLORS.solver} dash="4 2" />橙の破線: 境界価格 (上側と下側で向きが分かれる)</li>}
      <li className={item}>
        <span aria-hidden="true" className="inline-block h-3 w-4 rounded-[2px] bg-[repeating-linear-gradient(135deg,rgba(100,116,139,0.18)_0_3px,rgba(100,116,139,0.04)_3px_6px)]" />
        網掛け: 将来 (仮定) 領域 ・ 縦破線: 基準日
      </li>
      {hasForming && (
        <li className={item}>
          <span aria-hidden="true" className="inline-block h-3 w-2 rounded-[1px] border" style={{ background: SMA_LAB_CANDLE_COLORS.formingUpFill, borderColor: SMA_LAB_CANDLE_COLORS.up }} />
          淡い足: 未確定足
        </li>
      )}
      {hasIncomplete && (
        <li className={item}>
          <span aria-hidden="true" className="inline-block h-3 w-2 rounded-[1px] border" style={{ background: SMA_LAB_CANDLE_COLORS.incompleteFill, borderColor: SMA_LAB_CANDLE_COLORS.incompleteLine }} />
          灰色の足: 欠損・履歴開始前を含む足
        </li>
      )}
    </ul>
  )
}

export function SummaryTable({
  result,
  periods,
  fmt,
  statusText,
}: {
  result: SmaLabAvailable
  periods: readonly SmaLabPeriod[]
  fmt: PriceFormat
  statusText: (period: SmaLabPeriod) => string
}) {
  const end = result.projection.bars.at(-1)
  const endLabel = end ? `T+${end.k}` : 'T+0'
  const lastConfirmed = result.lastConfirmedIndex == null ? null : result.bars[result.lastConfirmedIndex]
  const forming = result.formingIndex != null
  const rows = result.periods.filter((summary) => periods.includes(summary.period))
  return (
    <table className="w-full max-w-[680px] border-collapse text-[12px]" data-sma-dynamics-table>
      <caption className="mb-1.5 text-left">
        <span className="text-[12px] font-bold text-[var(--color-text-primary)]">SMAの数値</span>{' '}
        <span className="font-mono text-[11px] font-medium text-[var(--color-text-tertiary)]">
          最終確定足 {lastConfirmed ? lastConfirmed.lastSession : '—'} → {endLabel}{end ? ` ${end.lastSession}` : ''}
        </span>
      </caption>
      <thead>
        <tr className="border-b border-[var(--color-border-default)] text-[11px] text-[var(--color-text-tertiary)]">
          <th scope="col" className="py-1 pr-1.5 text-left font-bold">SMA</th>
          <th scope="col" className="px-1.5 py-1 text-right font-bold">最終確定足</th>
          {forming && <th scope="col" className="px-1.5 py-1 text-right font-bold" title="未確定足の現在値を含む参考値">暫定</th>}
          <th scope="col" className="px-1.5 py-1 text-right font-bold">{endLabel} (仮定)</th>
          <th scope="col" className="py-1 pl-1.5 text-right font-bold">変化</th>
        </tr>
      </thead>
      <tbody className="divide-y divide-[var(--color-border-soft)]">
        {rows.length === 0 && (
          <tr><td colSpan={forming ? 5 : 4} className="py-3 text-center text-[11px] text-[var(--color-text-tertiary)]">表示するSMAを選んでください</td></tr>
        )}
        {rows.map((summary) => (
          <tr key={summary.period} data-period={summary.period} className="align-top">
            <th scope="row" style={{ background: 'transparent' }} className="py-1.5 pr-1.5 text-left font-mono font-bold text-[var(--color-text-primary)]">
              <span className="inline-flex items-center gap-1.5">
                <span aria-hidden="true" className="inline-block h-2 w-2 rounded-full" style={{ background: smaLabColor(summary.period) }} />
                {summary.period}
              </span>
            </th>
            {summary.status === 'ok' ? (
              <>
                <td className="px-1.5 py-1.5 text-right font-mono tabular-nums">
                  <span className="block font-bold text-[var(--color-text-primary)]">{fmt(summary.anchorValue)}</span>
                  <span className="block text-[11px] text-[var(--color-text-tertiary)]" title="基準日の終値とSMAの差(SMA比)">終値差 {formatPct(summary.closeGapPct)}</span>
                </td>
                {forming && <td className="px-1.5 py-1.5 text-right font-mono tabular-nums text-[var(--color-text-secondary)]">{fmt(summary.provisionalValue)}</td>}
                <td className="px-1.5 py-1.5 text-right font-mono font-bold tabular-nums text-[var(--color-text-primary)]">{fmt(summary.endValue)}</td>
                <td className="py-1.5 pl-1.5 text-right font-mono tabular-nums">
                  <span className="block font-bold text-[var(--color-text-primary)]">{formatPct(summary.endChangePct)}</span>
                  <span className="block text-[11px] text-[var(--color-text-tertiary)]">{formatSigned(summary.endChange, fmt)}</span>
                </td>
              </>
            ) : (
              <td colSpan={forming ? 4 : 3} className="py-1.5 pl-1.5 text-right text-[11px] font-medium text-[var(--color-text-tertiary)]">
                {statusText(summary.period)}
              </td>
            )}
          </tr>
        ))}
      </tbody>
    </table>
  )
}

export function FutureValuesDetails({ result, periods, fmt }: { result: SmaLabAvailable; periods: readonly SmaLabPeriod[]; fmt: PriceFormat }) {
  const tf = smaLabTimeframe(result.timeframe)
  const shown = result.periods.filter((summary) => summary.status === 'ok' && periods.includes(summary.period))
  if (result.projection.bars.length === 0 || shown.length === 0) return null
  return (
    <details className="group border-t border-[var(--color-border-soft)]" data-sma-dynamics-future-values>
      <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 px-3 text-[12px] font-bold text-[var(--color-text-secondary)] sm:min-h-9 sm:px-4 [&::-webkit-details-marker]:hidden">
        <ChevronRight size={13} aria-hidden="true" className="shrink-0 text-[var(--color-text-tertiary)] transition-transform group-open:rotate-90" />
        将来足ごとの計算値
        <span className="text-[11px] font-medium text-[var(--color-text-tertiary)]">T+1〜T+{result.projection.bars.length} ・ {tf.name} ・ 終了日は市場カレンダーの営業日</span>
      </summary>
      <div className="max-w-full overflow-x-auto px-3 pb-3 sm:px-4">
        <table className="w-full border-collapse font-mono text-[11px] tabular-nums">
          <caption className="sr-only">価格固定時のSMA計算値 (仮定終値 {fmt(result.asOf.close)})</caption>
          <thead>
            <tr className="border-b border-[var(--color-border-default)] text-[var(--color-text-tertiary)]">
              <th scope="col" className="py-1 pr-2 text-left font-sans font-bold">足</th>
              <th scope="col" className="px-1 py-1 text-left font-sans font-bold">期間</th>
              <th scope="col" className="px-1 py-1 text-right font-sans font-bold">基準日から</th>
              {shown.map((summary) => (
                <th key={summary.period} scope="col" className="px-1 py-1 text-right font-bold" style={{ color: smaLabColor(summary.period) }}>
                  {summary.period}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-[var(--color-border-soft)]">
            {result.projection.bars.map((bar, offset) => (
              <tr key={bar.k}>
                <th scope="row" style={{ background: 'transparent' }} className="whitespace-nowrap py-1 pr-2 text-left font-medium text-[var(--color-text-secondary)]">
                  T+{bar.k}{bar.completesForming && <span className="ml-1 font-sans text-[10px] text-amber-700">未確定足の確定</span>}
                </th>
                <td className="whitespace-nowrap px-1 py-1 text-[var(--color-text-secondary)]">{barPeriodText(bar)}</td>
                <td className="whitespace-nowrap px-1 py-1 text-right text-[var(--color-text-tertiary)]">{bar.sessionsAhead}営業日</td>
                {shown.map((summary) => (
                  <td key={summary.period} className="px-1 py-1 text-right text-[var(--color-text-primary)]">{fmt(result.projection.sma[summary.period][offset])}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  )
}

const MAX_DATES_PER_KIND = 4

export function IssuesBand({ issues }: { issues: ReadonlyArray<SmaLabDataIssue> }) {
  const groups = new Map<SmaLabDataIssue['kind'], string[]>()
  for (const issue of issues) {
    const list = groups.get(issue.kind) ?? []
    list.push(issue.date)
    groups.set(issue.kind, list)
  }
  return (
    <div role="status" className="border-t border-[var(--color-border-soft)] bg-[var(--color-surface-subtle)] px-3 py-2 text-[11px] font-medium leading-5 text-amber-800 sm:px-4" data-sma-dynamics-issues>
      <p className="m-0 font-bold">価格履歴に確認が必要な点が {issues.length} 件あります。該当する足は灰色で示し、終値が使えない足を含むSMAは計算していません。</p>
      <ul className="m-0 mt-0.5 list-disc pl-4">
        {[...groups.entries()].map(([kind, dates]) => (
          <li key={kind}>
            {describeSmaLabIssueKind(kind)}: {dates.length}件
            <span className="font-mono text-[10px] text-amber-900/80"> ({dates.slice(0, MAX_DATES_PER_KIND).join(', ')}{dates.length > MAX_DATES_PER_KIND ? ' ほか' : ''})</span>
          </li>
        ))}
      </ul>
    </div>
  )
}
