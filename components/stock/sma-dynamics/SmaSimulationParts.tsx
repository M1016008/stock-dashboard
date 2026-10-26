'use client'

// Small presentational pieces shared by the scenario editor and the inverse solver.
import type { ComponentPropsWithoutRef, ReactNode } from 'react'
import { smaLabColor, type SmaLabAvailable, type SmaLabPeriod, type SmaLabSeries } from '@/lib/sma-dynamics-lab'
import { DIRECTION_LABEL, SMA_FLAT_DISPLAY_TOLERANCE_PCT, type SmaDirection } from '@/lib/sma-dynamics-scenario'
import { formatPct, type PriceFormat } from './SmaDynamicsPanels'

const GLYPH: Record<SmaDirection, { char: string; className: string }> = {
  up: { char: '↑', className: 'text-red-700' },
  flat: { char: '→', className: 'text-[var(--color-text-secondary)]' },
  down: { char: '↓', className: 'text-blue-700' },
}

/** Exact direction of ΔSMA; "≈" marks a non-zero change inside the display tolerance. */
export function DirectionGlyph({ direction, displayFlat = false }: { direction: SmaDirection | null; displayFlat?: boolean }) {
  if (direction == null) return <span className="text-[var(--color-text-tertiary)]" title="計算できません">·</span>
  const glyph = GLYPH[direction]
  const near = displayFlat && direction !== 'flat'
  const title = near
    ? `${DIRECTION_LABEL[direction]} (厳密) ・ 変化が前の足のSMAの${SMA_FLAT_DISPLAY_TOLERANCE_PCT}%以内のため表示上は横ばい`
    : `${DIRECTION_LABEL[direction]}${direction === 'flat' ? ' (厳密に同値)' : ''}`
  return (
    <span className={`inline-flex items-baseline font-sans font-bold ${glyph.className}`} title={title} data-direction={direction} data-display-flat={near || undefined}>
      <span aria-hidden="true">{near ? '≈' : ''}{glyph.char}</span>
      <span className="sr-only">{title}</span>
    </span>
  )
}

/** Exact boundary text: keeps every significant decimal (up to 6) instead of the display rounding. */
export function exactFormatter(digits: number): PriceFormat {
  const format = new Intl.NumberFormat('en-US', { minimumFractionDigits: digits, maximumFractionDigits: 6 })
  return (value) => (value == null || !Number.isFinite(value) ? '—' : format.format(value))
}

export function SmaDot({ period }: { period: SmaLabPeriod }) {
  return <span aria-hidden="true" className="inline-block h-2 w-2 shrink-0 rounded-full" style={{ background: smaLabColor(period) }} />
}

export function Callout({ tone = 'neutral', children, ...rest }: Omit<ComponentPropsWithoutRef<'div'>, 'children'> & { tone?: 'neutral' | 'ok' | 'warn' | 'error'; children: ReactNode }) {
  const tones = {
    neutral: 'border-[var(--color-border-default)] bg-[var(--color-surface-subtle)] text-[var(--color-text-secondary)]',
    ok: 'border-emerald-200 bg-emerald-50 text-emerald-900',
    warn: 'border-amber-200 bg-amber-50 text-amber-900',
    error: 'border-rose-200 bg-rose-50 text-rose-900',
  }
  return (
    <div className={`rounded-[var(--radius-sm)] border px-2.5 py-1.5 text-[11px] font-medium leading-5 ${tones[tone]}`} {...rest}>
      {children}
    </div>
  )
}

export interface ComparisonColumn {
  id: string
  label: string
  title?: string
  sma: SmaLabSeries | null
  /** Explains a null end value (e.g. a missing input). */
  missingNote?: string
}

/** Before/after comparison at the last future bar: anchor SMA, each assumption, and the difference. */
export function ComparisonTable({
  result,
  periods,
  fmt,
  columns,
  caption,
}: {
  result: SmaLabAvailable
  periods: readonly SmaLabPeriod[]
  fmt: PriceFormat
  columns: readonly ComparisonColumn[]
  caption: ReactNode
}) {
  const end = result.projection.bars.length
  const rows = result.periods.filter((summary) => periods.includes(summary.period))
  const last = columns.at(-1)
  const first = columns[0]
  return (
    <table className="w-full max-w-[760px] border-collapse text-[12px]" data-sma-comparison-table>
      <caption className="mb-1.5 text-left text-[12px] font-bold text-[var(--color-text-primary)]">{caption}</caption>
      <thead>
        <tr className="border-b border-[var(--color-border-default)] text-[11px] text-[var(--color-text-tertiary)]">
          <th scope="col" className="py-1 pr-1.5 text-left font-bold">SMA</th>
          <th scope="col" className="px-1.5 py-1 text-right font-bold">最終確定足</th>
          {columns.map((column) => (
            <th key={column.id} scope="col" className="px-1.5 py-1 text-right font-bold" title={column.title}>T+{end} {column.label}</th>
          ))}
          {columns.length > 1 && <th scope="col" className="py-1 pl-1.5 text-right font-bold">差 ({last?.label} − {first?.label})</th>}
        </tr>
      </thead>
      <tbody className="divide-y divide-[var(--color-border-soft)]">
        {rows.length === 0 && (
          <tr><td colSpan={columns.length + 3} className="py-3 text-center text-[11px] text-[var(--color-text-tertiary)]">表示するSMAを選んでください</td></tr>
        )}
        {rows.map((summary) => {
          const values = columns.map((column) => column.sma?.[summary.period][end - 1] ?? null)
          const diff = values[0] != null && values.at(-1) != null ? values.at(-1)! - values[0] : null
          return (
            <tr key={summary.period} data-period={summary.period}>
              <th scope="row" style={{ background: 'transparent' }} className="py-1.5 pr-1.5 text-left font-mono font-bold text-[var(--color-text-primary)]">
                <span className="inline-flex items-center gap-1.5"><SmaDot period={summary.period} />{summary.period}</span>
              </th>
              {summary.status !== 'ok' ? (
                <td colSpan={columns.length + 2} className="py-1.5 pl-1.5 text-right text-[11px] text-[var(--color-text-tertiary)]">現在の足では計算できません</td>
              ) : (
                <>
                  <td className="px-1.5 py-1.5 text-right font-mono tabular-nums text-[var(--color-text-secondary)]">{fmt(summary.anchorValue)}</td>
                  {columns.map((column, index) => (
                    <td key={column.id} className="px-1.5 py-1.5 text-right font-mono font-bold tabular-nums text-[var(--color-text-primary)]" title={values[index] == null ? column.missingNote : undefined}>
                      {fmt(values[index])}
                      {summary.anchorValue != null && values[index] != null && (
                        <span className="block text-[11px] font-medium text-[var(--color-text-tertiary)]">{formatPct(((values[index]! - summary.anchorValue) / summary.anchorValue) * 100)}</span>
                      )}
                    </td>
                  ))}
                  {columns.length > 1 && (
                    <td className="py-1.5 pl-1.5 text-right font-mono tabular-nums text-[var(--color-text-secondary)]">
                      {diff == null ? '—' : `${diff > 0 ? '+' : diff < 0 ? '-' : ''}${fmt(Math.abs(diff))}`}
                    </td>
                  )}
                </>
              )}
            </tr>
          )
        })}
      </tbody>
    </table>
  )
}

/** Plain-language result rows: a short label, then one sentence. Used by every mode's conclusion. */
export function ConclusionRows({ items }: { items: ReadonlyArray<{ label: string; body: ReactNode }> }) {
  return (
    <dl className="m-0 grid min-w-0 grid-cols-[4.75rem_minmax(0,1fr)] gap-x-2 gap-y-1.5 text-[12px] leading-5 text-[var(--color-text-primary)]">
      {items.map((item) => (
        <div key={item.label} className="contents">
          <dt className="m-0 pt-px text-[11px] font-bold text-[var(--color-text-tertiary)]">{item.label}</dt>
          <dd className="m-0 min-w-0 break-words">{item.body}</dd>
        </div>
      ))}
    </dl>
  )
}
