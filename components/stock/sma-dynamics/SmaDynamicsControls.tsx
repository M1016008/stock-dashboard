'use client'

import { useId, useState, type FormEvent, type ReactNode } from 'react'
import {
  addSmaLabPeriodsFromText,
  smaLabColor,
  SMA_LAB_MAX_PERIOD,
  SMA_LAB_MAX_SELECTED_PERIODS,
  SMA_LAB_MIN_PERIOD,
  SMA_LAB_PERIODS,
  type SmaLabPeriod,
  type SmaLabPeriodSummary,
} from '@/lib/sma-dynamics-lab'

export function SegmentedControl<T extends string | number>({
  label,
  value,
  options,
  disabled = false,
  onChange,
  hideLabel = false,
}: {
  label: string
  value: T
  options: ReadonlyArray<{ value: T; label: string; title?: string }>
  disabled?: boolean
  onChange: (value: T) => void
  hideLabel?: boolean
}) {
  return (
    <div role="group" aria-label={label} className="flex min-w-0 items-center gap-2" data-disabled={disabled || undefined}>
      {!hideLabel && <span className="shrink-0 text-[11px] font-bold text-[var(--color-text-tertiary)]">{label}</span>}
      <div className="min-w-0 max-w-full">
        <div className={`inline-flex max-w-full flex-wrap pl-px pt-px ${disabled ? 'opacity-45' : ''}`}>
          {options.map((option) => {
            const active = option.value === value
            return (
              <button
                key={String(option.value)}
                type="button"
                aria-pressed={active}
                disabled={disabled}
                title={option.title}
                onClick={() => onChange(option.value)}
                className={`-ml-px -mt-px min-h-11 whitespace-nowrap border border-[var(--color-border-default)] px-2.5 focus-visible:relative focus-visible:z-10 text-[12px] font-bold leading-none disabled:cursor-not-allowed sm:min-h-8 ${
                  active ? 'bg-[var(--color-brand-900)] text-white' : `bg-white text-[var(--color-text-secondary)] ${disabled ? '' : 'hover:bg-[var(--color-surface-subtle)]'}`
                }`}
              >
                {option.label}
              </button>
            )
          })}
        </div>
      </div>
    </div>
  )
}

export function ControlRow({ label, children, aside }: { label: string; children: ReactNode; aside?: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-1 sm:flex-row sm:items-center sm:gap-3">
      <span className="w-[68px] shrink-0 text-[11px] font-bold text-[var(--color-text-tertiary)]">{label}</span>
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-1">
        {children}
        {aside}
      </div>
    </div>
  )
}

export function periodStatusText(summary: SmaLabPeriodSummary, barNoun: string): string {
  if (summary.status === 'insufficient_history') return `履歴不足: ${barNoun}あと${summary.shortfall}本 (${summary.available}/${summary.required})`
  if (summary.status === 'invalid_window') return `計算不可: 窓内に使用できない終値 ${summary.invalidBarsInWindow.length}本`
  return ''
}

/** SMA on/off chips. Unavailable periods stay toggleable so the reason stays visible next to the chart. */
export function SmaPeriodPicker({
  selected,
  summaries,
  disabled,
  onToggle,
  periods = SMA_LAB_PERIODS,
  label = '表示するSMA (選択した足の本数)',
}: {
  /** Periods drawn as chips (default: all); the rest are offered elsewhere. */
  periods?: readonly SmaLabPeriod[]
  label?: string
  selected: readonly SmaLabPeriod[]
  summaries: ReadonlyArray<SmaLabPeriodSummary> | null
  disabled: boolean
  onToggle: (period: SmaLabPeriod) => void
}) {
  return (
    <div role="group" aria-label={label} className="flex min-w-0 flex-wrap items-center gap-1" data-sma-dynamics-period-picker>
      {periods.map((period) => {
        const on = selected.includes(period)
        const summary = summaries?.find((item) => item.period === period)
        const unavailable = summary != null && summary.status !== 'ok'
        return (
          <button
            key={period}
            type="button"
            aria-pressed={on}
            disabled={disabled}
            onClick={() => onToggle(period)}
            title={`SMA${period}${unavailable ? ' (現在の足では計算できません)' : ''}`}
            className={`inline-flex min-h-11 min-w-11 items-center justify-center gap-1 rounded-[var(--radius-sm)] border px-1.5 font-mono text-[11px] font-bold tabular-nums disabled:cursor-not-allowed disabled:opacity-45 sm:min-h-7 sm:min-w-0 ${
              on
                ? 'border-[var(--color-border-strong)] bg-white text-[var(--color-text-primary)] shadow-[inset_0_-2px_0_var(--sma-color)]'
                : 'border-transparent text-[var(--color-text-tertiary)] hover:bg-[var(--color-surface-subtle)]'
            }`}
            style={{ ['--sma-color' as string]: smaLabColor(period) }}
            data-period={period}
          >
            <span aria-hidden="true" className={`inline-block h-2 w-2 rounded-full ${on ? '' : 'opacity-40'}`} style={{ background: smaLabColor(period) }} />
            {period}
            {on && unavailable && <span aria-hidden="true" className="text-amber-700">!</span>}
          </button>
        )
      })}
    </div>
  )
}

/**
 * Any integer SMA period 3..300. Typed periods join the selection (and are computed by the lab);
 * custom ones can be removed again. Nothing is rounded: "7.5" or "301" is rejected with a reason.
 */
export function CustomPeriodInput({
  selected,
  disabled,
  onChange,
  onAdded,
}: {
  selected: readonly SmaLabPeriod[]
  disabled: boolean
  onChange: (periods: SmaLabPeriod[]) => void
  /** Called with the periods that were just added (the solver selects the first one). */
  onAdded?: (added: SmaLabPeriod[]) => void
}) {
  const id = useId()
  const [text, setText] = useState('')
  const [message, setMessage] = useState<string | null>(null)
  const custom = selected.filter((period) => !(SMA_LAB_PERIODS as readonly number[]).includes(period))

  const submit = (event: FormEvent) => {
    event.preventDefault()
    const result = addSmaLabPeriodsFromText(selected, text)
    const notes: string[] = []
    if (result.rejected.length > 0) notes.push(`「${result.rejected.join('」「')}」は使えません (${SMA_LAB_MIN_PERIOD}〜${SMA_LAB_MAX_PERIOD}の整数)`)
    if (result.overflow.length > 0) notes.push(`同時に表示できるのは${SMA_LAB_MAX_SELECTED_PERIODS}本までです (${result.overflow.join(', ')} は追加していません)`)
    if (result.added.length === 0 && notes.length === 0) notes.push(text.trim() === '' ? '期間を入力してください (例: 7, 20, 120)' : '入力した期間はすでに選択されています')
    setMessage(notes.length > 0 ? notes.join(' / ') : null)
    if (result.added.length > 0) {
      onChange(result.periods)
      onAdded?.(result.added)
      setText('')
    }
  }

  return (
    <div className="flex min-w-0 flex-col gap-1" data-sma-custom-periods>
      <form onSubmit={submit} className="flex min-w-0 flex-wrap items-center gap-1.5">
        <label htmlFor={`${id}-periods`} className="text-[11px] font-bold text-[var(--color-text-tertiary)]">任意の期間 ({SMA_LAB_MIN_PERIOD}〜{SMA_LAB_MAX_PERIOD})</label>
        <input
          id={`${id}-periods`}
          type="text"
          inputMode="numeric"
          autoComplete="off"
          spellCheck={false}
          placeholder="例: 7, 20, 120"
          value={text}
          disabled={disabled}
          aria-describedby={message ? `${id}-periods-note` : undefined}
          aria-invalid={message != null || undefined}
          onChange={(event) => setText(event.target.value)}
          className="h-11 w-36 min-w-0 rounded-[var(--radius-sm)] border border-[var(--color-border-default)] bg-white px-2 font-mono text-[12px] tabular-nums disabled:opacity-45 sm:h-8"
        />
        <button type="submit" disabled={disabled} className="inline-flex min-h-11 items-center rounded-[var(--radius-sm)] border border-[var(--color-border-default)] bg-white px-2.5 text-[12px] font-bold text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-subtle)] disabled:cursor-not-allowed disabled:opacity-45 sm:min-h-8">
          追加
        </button>
      </form>
      {message && <p id={`${id}-periods-note`} role="status" className="m-0 text-[11px] font-medium text-amber-800" data-sma-custom-period-note>{message}</p>}
      {custom.length > 0 && (
        <div role="group" aria-label="追加した期間" className="flex flex-wrap items-center gap-1" data-sma-custom-period-chips>
          {custom.map((period) => (
            <button
              key={period}
              type="button"
              disabled={disabled}
              onClick={() => onChange(selected.filter((item) => item !== period))}
              title={`SMA${period} を外す`}
              aria-label={`SMA${period} を外す`}
              className="inline-flex min-h-11 items-center gap-1 rounded-[var(--radius-sm)] border border-[var(--color-border-strong)] bg-white px-1.5 font-mono text-[11px] font-bold tabular-nums text-[var(--color-text-primary)] shadow-[inset_0_-2px_0_var(--sma-color)] disabled:opacity-45 sm:min-h-7"
              style={{ ['--sma-color' as string]: smaLabColor(period) }}
            >
              <span aria-hidden="true" className="inline-block h-2 w-2 rounded-full" style={{ background: smaLabColor(period) }} />
              {period}
              <span aria-hidden="true" className="text-[var(--color-text-tertiary)]">×</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
