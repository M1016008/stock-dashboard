'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { CalendarRange, Check, ChevronLeft, ChevronRight, RotateCcw } from 'lucide-react'
import {
  addIsoDays,
  getUpcomingCloseDays,
  passesCloseCountFilter,
  visibleCloseTimeframes,
  type CloseCalendarDay,
  type CloseCalendarResult,
  type CloseCountFilter,
} from '@/lib/mtf-close-calendar'
import {
  CLOSE_TIMEFRAMES,
  intervalToSpec,
  type CloseTimeframe,
  type TimeframeUnit,
} from '@/lib/timeframes'

const WEEKDAYS = ['日', '月', '火', '水', '木', '金', '土']
const CLOSE_FILTERS: Array<{ value: CloseCountFilter; label: string }> = [
  { value: 0, label: 'すべて' },
  { value: 2, label: '2本以上' },
  { value: 3, label: '3本以上' },
  { value: 4, label: '4本以上' },
  { value: 5, label: '5本以上' },
]
const TIMEFRAME_GROUPS: Array<{ unit: TimeframeUnit; label: string }> = [
  { unit: 'day', label: '日' },
  { unit: 'week', label: '週' },
  { unit: 'month', label: '月' },
]

function addMonths(month: string, delta: number): string {
  const [year, value] = month.split('-').map(Number)
  const date = new Date(Date.UTC(year, value - 1 + delta, 1))
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`
}

function monthEnd(month: string): string {
  const [year, value] = month.split('-').map(Number)
  const date = new Date(Date.UTC(year, value, 0))
  return date.toISOString().slice(0, 10)
}

function monthLabel(month: string): string {
  const [year, value] = month.split('-')
  return `${year}年${Number(value)}月`
}

function firstWeekday(month: string): number {
  return new Date(`${month}-01T00:00:00Z`).getUTCDay()
}

function dateLabel(date: string): string {
  return new Intl.DateTimeFormat('ja-JP', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    weekday: 'long',
    timeZone: 'UTC',
  }).format(new Date(`${date}T00:00:00Z`))
}

function compactDateLabel(date: string): string {
  return new Intl.DateTimeFormat('ja-JP', {
    month: 'short',
    day: 'numeric',
    weekday: 'short',
    timeZone: 'UTC',
  }).format(new Date(`${date}T00:00:00Z`))
}

function timeframeBadgeClass(timeframe: CloseTimeframe): string {
  const unit = intervalToSpec(timeframe).timeframe
  if (unit === 'week') return 'border-[#8dd8c8] bg-[#ecfdf8] text-[#056756]'
  if (unit === 'month') return 'border-[#e6c972] bg-[#fff9df] text-[#74520a]'
  return 'border-[var(--color-brand-100)] bg-[var(--color-brand-50)] text-[var(--color-brand-800)]'
}

function countCellClass(count: number): string {
  if (count >= 7) return 'border-[var(--color-brand-700)] bg-[#e5f1ff]'
  if (count >= 5) return 'border-[#7ba5d4] bg-[#edf5ff]'
  if (count >= 3) return 'border-[var(--color-border-default)] bg-white'
  return 'border-[var(--color-border-soft)] bg-white'
}

function timeframeGroup(unit: TimeframeUnit): CloseTimeframe[] {
  return CLOSE_TIMEFRAMES.filter((timeframe) => intervalToSpec(timeframe).timeframe === unit)
}

export function MtfCloseCalendarClient({ initialMonth, today }: { initialMonth: string; today: string }) {
  const [month, setMonth] = useState(initialMonth)
  const [result, setResult] = useState<CloseCalendarResult | null>(null)
  const [selectedDate, setSelectedDate] = useState<string | null>(today)
  const [enabledTimeframes, setEnabledTimeframes] = useState<CloseTimeframe[]>([...CLOSE_TIMEFRAMES])
  const [minimumCloses, setMinimumCloses] = useState<CloseCountFilter>(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [requestVersion, setRequestVersion] = useState(0)

  const enabledSet = useMemo(() => new Set(enabledTimeframes), [enabledTimeframes])
  const visibleFrom = `${month}-01`
  const visibleTo = monthEnd(month)

  const loadCalendar = useCallback(async (signal: AbortSignal) => {
    setLoading(true)
    setError(null)
    const query = new URLSearchParams({
      market: 'JP',
      from: visibleFrom,
      to: addIsoDays(visibleTo, 70),
    })
    const response = await fetch(`/api/mtf-close-calendar?${query}`, { cache: 'no-store', signal })
    const payload = await response.json() as CloseCalendarResult & { message?: string }
    if (!response.ok) throw new Error(payload.message ?? `HTTP ${response.status}`)
    setResult(payload)
    setSelectedDate((current) => {
      if (current && current.startsWith(month) && payload.days.some((day) => day.date === current)) return current
      if (today.startsWith(month) && payload.days.some((day) => day.date === today)) return today
      return payload.days.find((day) => day.date.startsWith(month) && day.isTradingDay)?.date ?? `${month}-01`
    })
    setLoading(false)
  }, [month, today, visibleFrom, visibleTo])

  useEffect(() => {
    const controller = new AbortController()
    loadCalendar(controller.signal).catch((loadError) => {
      if (controller.signal.aborted) return
      setError(loadError instanceof Error ? loadError.message : 'カレンダーを取得できませんでした。')
      setLoading(false)
    })
    return () => controller.abort()
  }, [loadCalendar, requestVersion])

  const dayMap = useMemo(() => new Map(result?.days.map((day) => [day.date, day]) ?? []), [result])
  const monthDays = useMemo(
    () => result?.days.filter((day) => day.date >= visibleFrom && day.date <= visibleTo) ?? [],
    [result, visibleFrom, visibleTo],
  )
  const blanks = useMemo(() => Array.from({ length: firstWeekday(month) }, (_, index) => `blank-${index}`), [month])
  const selectedDay = selectedDate ? dayMap.get(selectedDate) ?? null : null
  const selectedVisibleTimeframes = selectedDay ? visibleCloseTimeframes(selectedDay, enabledSet) : []
  const upcomingStart = month < today.slice(0, 7) ? visibleFrom : today > visibleFrom ? today : visibleFrom
  const upcoming = useMemo(
    () => getUpcomingCloseDays(result?.days ?? [], enabledSet, upcomingStart),
    [enabledSet, result, upcomingStart],
  )
  const matchingDays = monthDays.filter((day) => day.isTradingDay && passesCloseCountFilter(day, enabledSet, minimumCloses)).length

  function toggleTimeframe(timeframe: CloseTimeframe) {
    setEnabledTimeframes((current) => current.includes(timeframe)
      ? current.filter((item) => item !== timeframe)
      : CLOSE_TIMEFRAMES.filter((item) => current.includes(item) || item === timeframe))
  }

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <section className="overflow-hidden rounded-[6px] border border-[var(--color-border-default)] bg-white">
        <div className="flex flex-col gap-3 border-b border-[var(--color-border-default)] bg-[var(--color-surface-subtle)] px-3 py-3 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex items-center gap-2">
            <CalendarRange size={18} className="text-[var(--color-brand-700)]" />
            <div>
              <h2 className="text-[15px] font-bold text-[var(--color-text-primary)]">{monthLabel(month)}</h2>
              <p className="text-[11px] tabular-nums text-[var(--color-text-tertiary)]">条件に該当 {matchingDays}営業日</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setMonth((value) => addMonths(value, -1))}
              className="inline-flex h-8 w-8 items-center justify-center rounded-[4px] border border-[var(--color-border-default)] bg-white text-[var(--color-text-secondary)] hover:bg-[var(--color-brand-50)]"
              aria-label="前の月"
              title="前の月"
            >
              <ChevronLeft size={16} />
            </button>
            <button
              type="button"
              onClick={() => setMonth(initialMonth)}
              className="inline-flex h-8 items-center gap-1.5 rounded-[4px] border border-[var(--color-border-default)] bg-white px-2.5 text-[11px] font-bold text-[var(--color-text-secondary)] hover:bg-[var(--color-brand-50)]"
            >
              <RotateCcw size={13} />
              今月
            </button>
            <button
              type="button"
              onClick={() => setMonth((value) => addMonths(value, 1))}
              className="inline-flex h-8 w-8 items-center justify-center rounded-[4px] border border-[var(--color-border-default)] bg-white text-[var(--color-text-secondary)] hover:bg-[var(--color-brand-50)]"
              aria-label="次の月"
              title="次の月"
            >
              <ChevronRight size={16} />
            </button>
          </div>
        </div>

        <div className="grid gap-3 border-b border-[var(--color-border-soft)] px-3 py-3 xl:grid-cols-[auto_minmax(0,1fr)] xl:items-start">
          <div className="flex min-w-0 flex-wrap items-center gap-1.5" aria-label="同時に確定する本数で絞り込み">
            <span className="mr-1 text-[11px] font-bold text-[var(--color-text-secondary)]">同時確定</span>
            {CLOSE_FILTERS.map((filter) => (
              <button
                key={filter.value}
                type="button"
                onClick={() => setMinimumCloses(filter.value)}
                aria-pressed={minimumCloses === filter.value}
                className={`h-8 rounded-[4px] border px-2.5 text-[11px] font-bold ${
                  minimumCloses === filter.value
                    ? 'border-[var(--color-brand-700)] bg-[var(--color-brand-800)] text-white'
                    : 'border-[var(--color-border-default)] bg-white text-[var(--color-text-secondary)] hover:bg-[var(--color-brand-50)]'
                }`}
              >
                {filter.label}
              </button>
            ))}
          </div>
          <div className="flex min-w-0 flex-wrap gap-x-3 gap-y-2 xl:justify-end" aria-label="時間足フィルター">
            {TIMEFRAME_GROUPS.map((group) => (
              <div key={group.unit} className="flex items-center gap-1">
                <span className="mr-0.5 text-[10px] font-bold text-[var(--color-text-tertiary)]">{group.label}足</span>
                {timeframeGroup(group.unit).map((timeframe) => {
                  const checked = enabledSet.has(timeframe)
                  return (
                    <label
                      key={timeframe}
                      className={`inline-flex h-7 cursor-pointer items-center gap-1 border px-1.5 text-[10px] font-bold ${
                        checked
                          ? 'border-[var(--color-brand-500)] bg-[var(--color-brand-50)] text-[var(--color-brand-800)]'
                          : 'border-[var(--color-border-soft)] bg-white text-[var(--color-text-tertiary)]'
                      }`}
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => toggleTimeframe(timeframe)}
                        className="sr-only"
                      />
                      <span className="inline-flex h-3.5 w-3.5 items-center justify-center border border-current bg-white">
                        {checked && <Check size={11} strokeWidth={3} />}
                      </span>
                      {timeframe}
                    </label>
                  )
                })}
              </div>
            ))}
          </div>
        </div>

        {error ? (
          <div className="flex min-h-[360px] flex-col items-center justify-center gap-3 px-4 text-center">
            <p className="text-[13px] font-bold text-[var(--color-market-red-dark)]">{error}</p>
            <button
              type="button"
              onClick={() => setRequestVersion((value) => value + 1)}
              className="btn"
            >
              <RotateCcw size={13} aria-hidden />
              再読み込み
            </button>
          </div>
        ) : (
          <div className="grid min-w-0 gap-4 p-2 sm:p-3 xl:grid-cols-[minmax(0,1fr)_320px]">
            <div className="min-w-0">
              <div className="grid grid-cols-7 gap-0.5 border-b border-[var(--color-border-default)] pb-1 text-center text-[10px] font-bold text-[var(--color-text-tertiary)] sm:gap-1">
                {WEEKDAYS.map((weekday, index) => (
                  <span key={weekday} className={index === 0 ? 'text-[var(--color-market-red)]' : index === 6 ? 'text-[var(--color-brand-700)]' : ''}>
                    {weekday}
                  </span>
                ))}
              </div>
              <div className="mt-1 grid grid-cols-7 gap-0.5 sm:gap-1" aria-busy={loading}>
                {blanks.map((blank) => <span key={blank} className="min-h-[94px] bg-[var(--color-surface-subtle)] sm:min-h-[118px]" />)}
                {monthDays.map((day) => {
                  const visible = visibleCloseTimeframes(day, enabledSet)
                  const matches = passesCloseCountFilter(day, enabledSet, minimumCloses)
                  const selected = day.date === selectedDate
                  const current = day.date === today
                  return (
                    <button
                      key={day.date}
                      type="button"
                      onClick={() => setSelectedDate(day.date)}
                      aria-pressed={selected}
                      aria-label={`${day.date}、${day.isTradingDay ? `${visible.length}時間足確定` : '休場日'}`}
                      className={`relative flex min-h-[94px] min-w-0 flex-col items-stretch overflow-hidden border p-1 text-left transition-colors sm:min-h-[118px] sm:p-1.5 ${
                        selected
                          ? 'border-[var(--color-brand-800)] ring-1 ring-[var(--color-brand-700)]'
                          : countCellClass(visible.length)
                      } ${!day.isTradingDay || !matches ? 'bg-[var(--color-surface-subtle)] opacity-55' : 'hover:border-[var(--color-brand-500)]'} `}
                    >
                      <span className="flex items-center justify-between gap-1">
                        <span className={`text-[11px] font-bold tabular-nums sm:text-[12px] ${current ? 'text-[var(--color-market-red)]' : 'text-[var(--color-text-primary)]'}`}>
                          {Number(day.date.slice(8, 10))}
                        </span>
                        {current && <span className="hidden text-[9px] font-bold text-[var(--color-market-red)] sm:inline">今日</span>}
                      </span>
                      {day.isTradingDay && matches ? (
                        <>
                          <span className="mt-1 flex content-start flex-wrap gap-0.5 sm:gap-1">
                            {visible.map((timeframe) => (
                              <span key={timeframe} className={`inline-flex h-[17px] items-center border px-1 text-[9px] font-bold leading-none sm:h-[19px] sm:text-[10px] ${timeframeBadgeClass(timeframe)}`}>
                                {timeframe}
                              </span>
                            ))}
                          </span>
                          <span className="mt-auto pt-1 text-[9px] font-bold tabular-nums text-[var(--color-text-secondary)] sm:text-[10px]">
                            {visible.length}本確定
                          </span>
                        </>
                      ) : (
                        <span className="mt-auto text-[9px] font-semibold text-[var(--color-text-tertiary)] sm:text-[10px]">
                          {day.isTradingDay ? '—' : '休場'}
                        </span>
                      )}
                    </button>
                  )
                })}
              </div>
              {loading && (
                <div className="mt-2 h-1 overflow-hidden bg-[var(--color-surface-muted)]">
                  <div className="h-full w-1/2 animate-pulse bg-[var(--color-brand-600)]" />
                </div>
              )}
            </div>

            <aside className="min-w-0 border border-[var(--color-border-default)] bg-[var(--color-surface-subtle)]">
              <div className="border-b border-[var(--color-border-default)] px-3 py-3">
                <div className="text-[11px] font-bold text-[var(--color-text-tertiary)]">選択日</div>
                <div className="mt-1 text-[15px] font-bold text-[var(--color-text-primary)]">
                  {selectedDay ? dateLabel(selectedDay.date) : '—'}
                </div>
                <div className="mt-2 flex items-end justify-between gap-3">
                  <div>
                    <div className="text-[11px] font-bold text-[var(--color-text-tertiary)]">確定する時間足</div>
                    <div className="text-[24px] font-bold tabular-nums text-[var(--color-text-primary)]">{selectedVisibleTimeframes.length}<span className="ml-0.5 text-[12px] font-semibold text-[var(--color-text-secondary)]">本</span></div>
                  </div>
                  <div className="text-right text-[10px] font-semibold text-[var(--color-text-tertiary)]">
                    {selectedDay?.isTradingDay ? `次回 ${selectedDay.nextTradingDate ?? '未確定'}` : '市場休場日'}
                  </div>
                </div>
              </div>
              <div className="divide-y divide-[var(--color-border-soft)] bg-white">
                {TIMEFRAME_GROUPS.map((group) => (
                  <div key={group.unit} className="px-3 py-2.5">
                    <div className="mb-1.5 text-[11px] font-bold text-[var(--color-text-tertiary)]">{group.label}足</div>
                    <div className="grid grid-cols-4 gap-1">
                      {timeframeGroup(group.unit).map((timeframe) => {
                        const closed = selectedDay?.closeTimeframes.includes(timeframe) ?? false
                        return (
                          <div key={timeframe} className="flex items-center justify-between border border-[var(--color-border-soft)] px-1.5 py-1 text-[10px] font-bold">
                            <span>{timeframe}</span>
                            <span className={closed ? 'text-[var(--color-brand-700)]' : 'text-[var(--color-text-tertiary)]'}>{closed ? '✓' : '—'}</span>
                          </div>
                        )
                      })}
                    </div>
                  </div>
                ))}
              </div>
              <div className="border-t border-[var(--color-border-default)] bg-white px-3 py-3">
                <h3 className="text-[13px] font-bold text-[var(--color-text-primary)]">この先の確定日</h3>
                <div className="mt-2 divide-y divide-[var(--color-border-soft)]">
                  {upcoming.length > 0 ? upcoming.map((day) => (
                    <button
                      key={day.date}
                      type="button"
                      onClick={() => {
                        setMonth(day.date.slice(0, 7))
                        setSelectedDate(day.date)
                      }}
                      className="flex w-full items-center justify-between gap-2 py-2 text-left hover:bg-[var(--color-brand-50)]"
                    >
                      <span className="min-w-[72px] text-[11px] font-bold tabular-nums text-[var(--color-text-primary)]">{compactDateLabel(day.date)}</span>
                      <span className="min-w-0 flex-1 truncate text-[10px] font-semibold text-[var(--color-text-secondary)]">{day.visibleTimeframes.join(' / ')}</span>
                      <span className="text-[11px] font-bold tabular-nums text-[var(--color-brand-800)]">{day.visibleTimeframes.length}</span>
                    </button>
                  )) : (
                    <div className="py-5 text-center text-[11px] font-semibold text-[var(--color-text-tertiary)]">該当日なし</div>
                  )}
                </div>
              </div>
            </aside>
          </div>
        )}

        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-[var(--color-border-soft)] px-3 py-2 text-[10px] font-semibold text-[var(--color-text-tertiary)]">
          <span className="tabular-nums">営業日の起点 {result?.sessionAnchorDate ?? '—'}</span>
          <span className="tabular-nums">実データの範囲 {result?.sessionCoverageFrom ?? '—'} – {result?.sessionCoverageTo ?? '—'}</span>
        </div>
      </section>
    </div>
  )
}
