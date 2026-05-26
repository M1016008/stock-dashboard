'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { CalendarDays, ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight, RotateCcw } from 'lucide-react'

export interface MarketDateOption {
  date: string
  tickers?: number
}

interface Props {
  dates: MarketDateOption[]
  value: string | null
  onChange: (date: string | null) => void
  label?: string
  align?: 'left' | 'right'
  compact?: boolean
  className?: string
  loading?: boolean
  onOpen?: () => void
}

const WEEKDAYS = ['日', '月', '火', '水', '木', '金', '土']

function monthOf(date: string) {
  return date.slice(0, 7)
}

function monthLabel(month: string) {
  const [year, m] = month.split('-')
  return `${year}年${Number(m)}月`
}

function makeDate(month: string, day: number) {
  return `${month}-${String(day).padStart(2, '0')}`
}

function daysInMonth(month: string) {
  const [year, m] = month.split('-').map(Number)
  return new Date(Date.UTC(year, m, 0)).getUTCDate()
}

function firstDayOfWeek(month: string) {
  const [year, m] = month.split('-').map(Number)
  return new Date(Date.UTC(year, m - 1, 1)).getUTCDay()
}

export function MarketDateCalendar({
  dates,
  value,
  onChange,
  label = '日付',
  align = 'left',
  compact = false,
  className = '',
  loading = false,
  onOpen,
}: Props) {
  const [open, setOpen] = useState(false)
  const [month, setMonth] = useState('')
  const rootRef = useRef<HTMLDivElement | null>(null)

  const latestDate = dates[0]?.date ?? null
  const activeDate = value ?? latestDate
  const dateMap = useMemo(() => new Map(dates.map((d) => [d.date, d])), [dates])
  const months = useMemo(() => Array.from(new Set(dates.map((d) => monthOf(d.date)))).sort(), [dates])

  useEffect(() => {
    if (activeDate) setMonth(monthOf(activeDate))
    else if (months.length > 0) setMonth(months[months.length - 1])
  }, [activeDate, months])

  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown)
    return () => document.removeEventListener('pointerdown', onPointerDown)
  }, [open])

  const monthIndex = month ? months.indexOf(month) : -1
  const canPrevMonth = monthIndex > 0
  const canNextMonth = monthIndex >= 0 && monthIndex < months.length - 1
  const canPrevYear = monthIndex > 0
  const canNextYear = monthIndex >= 0 && monthIndex < months.length - 1

  const moveMonth = (delta: number) => {
    if (monthIndex < 0) return
    const nextIndex = Math.min(Math.max(monthIndex + delta, 0), months.length - 1)
    setMonth(months[nextIndex] ?? month)
  }
  const grid = useMemo(() => {
    if (!month) return []
    const blanks = Array.from({ length: firstDayOfWeek(month) }, () => null)
    const days = Array.from({ length: daysInMonth(month) }, (_, i) => makeDate(month, i + 1))
    return [...blanks, ...days]
  }, [month])

  const selectDate = (date: string | null) => {
    onChange(date)
    setOpen(false)
  }

  return (
    <div ref={rootRef} className={`relative inline-flex ${className}`}>
      <button
        type="button"
        onClick={() => setOpen((v) => {
          const next = !v
          if (next) onOpen?.()
          return next
        })}
        className={`inline-flex items-center gap-2 rounded-[6px] border border-[var(--color-border-default)] bg-white font-bold text-[var(--color-text-primary)] shadow-sm transition-colors hover:border-[var(--color-brand-300)] ${
          compact ? 'h-8 px-2.5 text-[12px]' : 'h-10 px-3 text-[13px]'
        }`}
      >
        <CalendarDays size={compact ? 14 : 16} />
        <span className="text-[11px] text-[var(--color-text-tertiary)]">{label}</span>
        <span className="tabular-nums">{value ? activeDate : `最新 ${latestDate ?? '---'}`}</span>
      </button>

      {open && (
        <div
          className={`absolute top-[calc(100%+8px)] z-40 w-[324px] rounded-[8px] border border-[var(--color-border-default)] bg-white p-3 shadow-[0_18px_48px_rgba(15,23,42,0.18)] ${
            align === 'right' ? 'right-0' : 'left-0'
          }`}
        >
          <div className="mb-3 flex items-center justify-between gap-2">
            <button
              type="button"
              onClick={() => moveMonth(-12)}
              disabled={!canPrevYear}
              className="inline-flex h-8 w-8 items-center justify-center rounded-[5px] border border-[var(--color-border-soft)] text-[var(--color-text-secondary)] disabled:opacity-35"
              aria-label="前年"
              title="前年"
            >
              <ChevronsLeft size={16} />
            </button>
            <button
              type="button"
              onClick={() => moveMonth(-1)}
              disabled={!canPrevMonth}
              className="inline-flex h-8 w-8 items-center justify-center rounded-[5px] border border-[var(--color-border-soft)] text-[var(--color-text-secondary)] disabled:opacity-35"
              aria-label="前の月"
              title="前の月"
            >
              <ChevronLeft size={16} />
            </button>
            <div
              className="flex h-8 flex-1 items-center justify-center rounded-[5px] border border-[var(--color-border-default)] bg-white px-2 text-center text-[13px] font-bold tabular-nums text-[var(--color-text-primary)]"
              aria-live="polite"
            >
              {month ? monthLabel(month) : '---'}
            </div>
            <button
              type="button"
              onClick={() => moveMonth(1)}
              disabled={!canNextMonth}
              className="inline-flex h-8 w-8 items-center justify-center rounded-[5px] border border-[var(--color-border-soft)] text-[var(--color-text-secondary)] disabled:opacity-35"
              aria-label="次の月"
              title="次の月"
            >
              <ChevronRight size={16} />
            </button>
            <button
              type="button"
              onClick={() => moveMonth(12)}
              disabled={!canNextYear}
              className="inline-flex h-8 w-8 items-center justify-center rounded-[5px] border border-[var(--color-border-soft)] text-[var(--color-text-secondary)] disabled:opacity-35"
              aria-label="翌年"
              title="翌年"
            >
              <ChevronsRight size={16} />
            </button>
          </div>

          <div className="mb-1 grid grid-cols-7 gap-1 text-center text-[10px] font-bold text-[var(--color-text-tertiary)]">
            {WEEKDAYS.map((day) => <span key={day}>{day}</span>)}
          </div>
          <div className="grid grid-cols-7 gap-1">
            {grid.map((date, index) => {
              if (!date) return <span key={`blank-${index}`} />
              const info = dateMap.get(date)
              const enabled = Boolean(info)
              const selected = activeDate === date
              const latest = latestDate === date
              return (
                <button
                  key={date}
                  type="button"
                  disabled={!enabled}
                  onClick={() => selectDate(latest ? null : date)}
                  aria-label={`${date}を選択`}
                  title={info ? `${date} / ${info.tickers?.toLocaleString('ja-JP') ?? '-'}銘柄` : `${date} データなし`}
                  className={`flex h-9 flex-col items-center justify-center rounded-[5px] border text-[11px] font-bold tabular-nums ${
                    selected
                      ? 'border-[var(--color-brand-700)] bg-[var(--color-brand-800)] text-white'
                      : enabled
                        ? 'border-[var(--color-border-soft)] bg-white text-[var(--color-text-primary)] hover:bg-[var(--color-brand-50)]'
                        : 'border-transparent bg-[var(--color-surface-subtle)] text-[var(--color-text-tertiary)] opacity-45'
                  }`}
                >
                  <span>{Number(date.slice(8, 10))}</span>
                  {enabled && <span className="mt-0.5 h-1 w-1 rounded-full bg-current opacity-65" />}
                </button>
              )
            })}
          </div>

          <div className="mt-3 flex items-center justify-between gap-2 border-t border-[var(--color-border-soft)] pt-3">
            <span className="text-[11px] font-semibold text-[var(--color-text-tertiary)]">
              {loading ? '日付を読み込み中...' : '点がある日だけ選択できます'}
            </span>
            <button
              type="button"
              onClick={() => selectDate(null)}
              className="inline-flex h-8 items-center gap-1.5 rounded-[5px] border border-[var(--color-border-default)] px-2.5 text-[11px] font-bold text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-subtle)]"
            >
              <RotateCcw size={13} />
              最新へ
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
