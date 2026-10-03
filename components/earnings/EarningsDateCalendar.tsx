import Link from 'next/link'
import { ChevronLeft, ChevronRight, RotateCcw } from 'lucide-react'
import type { EarningsDateCount } from '@/lib/queries/earnings-calendar'

const WEEKDAYS = ['日', '月', '火', '水', '木', '金', '土']

function isMonth(value: string | null | undefined): value is string {
  return typeof value === 'string' && /^\d{4}-\d{2}$/.test(value)
}

function isDate(value: string | null | undefined): value is string {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
}

function monthOf(date: string) {
  return date.slice(0, 7)
}

function monthLabel(month: string) {
  const [year, m] = month.split('-')
  return `${year}年${Number(m)}月`
}

function addMonth(month: string, delta: number) {
  const [year, m] = month.split('-').map(Number)
  const d = new Date(Date.UTC(year, m - 1 + delta, 1))
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`
}

function daysInMonth(month: string) {
  const [year, m] = month.split('-').map(Number)
  return new Date(Date.UTC(year, m, 0)).getUTCDate()
}

function firstDayOfWeek(month: string) {
  const [year, m] = month.split('-').map(Number)
  return new Date(Date.UTC(year, m - 1, 1)).getUTCDay()
}

function makeDate(month: string, day: number) {
  return `${month}-${String(day).padStart(2, '0')}`
}

function hrefFor(params: Record<string, string | null>) {
  const sp = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value) sp.set(key, value)
  }
  const query = sp.toString()
  return query ? `/earnings?${query}` : '/earnings'
}

export function EarningsDateCalendar({
  counts,
  selectedDate,
  displayMonth,
  latestDate,
}: {
  counts: EarningsDateCount[]
  selectedDate: string | null
  displayMonth: string | null
  latestDate: string | null
}) {
  const countMap = new Map(counts.map((row) => [row.date, row.count]))
  const latestEventDate = counts[counts.length - 1]?.date ?? null
  const month = isMonth(displayMonth)
    ? displayMonth
    : selectedDate
      ? monthOf(selectedDate)
      : latestDate
        ? monthOf(latestDate)
        : latestEventDate
          ? monthOf(latestEventDate)
          : null

  if (!month) {
    return (
      <div className="rounded-[10px] border border-[var(--color-border-soft)] bg-[var(--color-surface-subtle)] px-4 py-6 text-center text-[13px] font-bold text-[var(--color-text-tertiary)]">
        決算日カレンダー用のデータがありません。
      </div>
    )
  }

  const blanks = Array.from({ length: firstDayOfWeek(month) }, () => null)
  const days = Array.from({ length: daysInMonth(month) }, (_, index) => makeDate(month, index + 1))
  const grid = [...blanks, ...days]
  const monthTotal = days.reduce((sum, date) => sum + (countMap.get(date) ?? 0), 0)
  const selectedCount = selectedDate ? countMap.get(selectedDate) ?? 0 : null

  return (
    <section className="rounded-[10px] border border-[var(--color-border-default)] bg-white p-4 shadow-[var(--shadow-card)]">
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3 border-b-2 border-[var(--color-brand-700)] bg-[var(--color-surface-subtle)] px-3 py-2">
        <div className="min-w-0 border-l-4 border-[var(--color-market-red)] pl-2">
          <h2 className="text-[14px] font-bold text-[var(--color-brand-900)]">決算イベントカレンダー</h2>
          <p className="mt-1 text-[11px] font-semibold text-[var(--color-text-tertiary)]">
            日付の件数をクリックすると、その日を基準に決算予定・発表後の値動き・シグナルへ切り替わります。
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Link
            href={hrefFor({ month: addMonth(month, -1) })}
            className="inline-flex h-8 w-8 items-center justify-center rounded-[5px] border border-[var(--color-border-default)] bg-white text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-subtle)]"
            prefetch={false}
            aria-label="前の月"
          >
            <ChevronLeft size={16} />
          </Link>
          <div className="min-w-[118px] text-center text-[14px] font-bold tabular-nums text-[var(--color-brand-900)]">
            {monthLabel(month)}
          </div>
          <Link
            href={hrefFor({ month: addMonth(month, 1) })}
            className="inline-flex h-8 w-8 items-center justify-center rounded-[5px] border border-[var(--color-border-default)] bg-white text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-subtle)]"
            prefetch={false}
            aria-label="次の月"
          >
            <ChevronRight size={16} />
          </Link>
          <Link
            href="/earnings"
            className="inline-flex h-8 items-center gap-1.5 rounded-[5px] border border-[var(--color-border-default)] bg-white px-2.5 text-[11px] font-bold text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-subtle)]"
            prefetch={false}
          >
            <RotateCcw size={13} />
            最新へ
          </Link>
        </div>
      </div>

      <div className="mb-3 grid grid-cols-1 gap-2 sm:grid-cols-3">
        <div className="rounded-[8px] border border-[var(--color-border-soft)] bg-[var(--color-surface-subtle)] px-3 py-2">
          <div className="text-[10px] font-bold text-[var(--color-text-tertiary)]">表示月の決算件数</div>
          <div className="mt-1 text-[18px] font-bold tabular-nums text-[var(--color-brand-900)]">{monthTotal.toLocaleString()}件</div>
        </div>
        <div className="rounded-[8px] border border-[var(--color-border-soft)] bg-[var(--color-surface-subtle)] px-3 py-2">
          <div className="text-[10px] font-bold text-[var(--color-text-tertiary)]">選択日</div>
          <div className="mt-1 text-[18px] font-bold tabular-nums text-[var(--color-brand-900)]">{selectedDate ?? '最新基準'}</div>
        </div>
        <div className="rounded-[8px] border border-[var(--color-border-soft)] bg-[var(--color-surface-subtle)] px-3 py-2">
          <div className="text-[10px] font-bold text-[var(--color-text-tertiary)]">選択日の決算件数</div>
          <div className="mt-1 text-[18px] font-bold tabular-nums text-[var(--color-brand-900)]">
            {selectedCount == null ? '---' : `${selectedCount.toLocaleString()}件`}
          </div>
        </div>
      </div>

      <div className="grid grid-cols-7 gap-1 text-center text-[10px] font-bold text-[var(--color-text-tertiary)]">
        {WEEKDAYS.map((day) => <span key={day}>{day}</span>)}
      </div>
      <div className="mt-1 grid grid-cols-7 gap-1">
        {grid.map((date, index) => {
          if (!date) return <span key={`blank-${index}`} className="min-h-[64px]" />
          const count = countMap.get(date) ?? 0
          const selected = isDate(selectedDate) && selectedDate === date
          const hasEvents = count > 0
          const baseClass = `flex min-h-[64px] flex-col items-center justify-center rounded-[7px] border px-1.5 py-2 text-center transition-colors ${
            selected
              ? 'border-[var(--color-brand-800)] bg-[var(--color-brand-800)] text-white'
              : hasEvents
                ? 'border-[var(--color-brand-100)] bg-[var(--color-brand-50)] text-[var(--color-brand-900)] hover:border-[var(--color-brand-400)] hover:bg-white'
                : 'border-transparent bg-[var(--color-surface-subtle)] text-[var(--color-text-tertiary)] opacity-55'
          }`
          const content = (
            <>
              <span className="text-[12px] font-bold tabular-nums">{Number(date.slice(8, 10))}</span>
              <span className={`mt-1 rounded-full px-1.5 py-0.5 text-[10px] font-bold tabular-nums ${selected ? 'bg-white/15 text-white' : hasEvents ? 'bg-white text-[var(--color-brand-800)]' : 'bg-transparent'}`}>
                {hasEvents ? `${count}件` : '-'}
              </span>
            </>
          )
          return hasEvents ? (
            <Link
              key={date}
              href={hrefFor({ date, month })}
              className={baseClass}
              prefetch={false}
              title={`${date}: ${count.toLocaleString()}件`}
            >
              {content}
            </Link>
          ) : (
            <span key={date} className={baseClass} title={`${date}: 該当なし`}>
              {content}
            </span>
          )
        })}
      </div>
    </section>
  )
}
