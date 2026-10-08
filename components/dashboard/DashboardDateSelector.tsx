'use client'

import { useCallback, useEffect, useRef, useState, useTransition } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { MarketDateCalendar, type MarketDateOption } from '@/components/ui/MarketDateCalendar'
import { useDashboardHistoricalPending } from '@/components/dashboard/DashboardHistoricalShell'

interface Props {
  /** カレンダーの初期候補 (最新日 + 表示中の営業日)。全件は開いたときに取得する */
  dates: MarketDateOption[]
  /** URL で指定された日付 (存在しない日・範囲外でもそのまま入力欄に出す) */
  requestedDate: string | null
  /** 実際に表示している営業日 (表示できない場合は null) */
  resolvedDate: string | null
  latestDate: string | null
  earliestDate: string | null
  mode: 'latest' | 'historical' | 'unavailable'
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

const buttonClass =
  'inline-flex h-8 items-center justify-center rounded-[6px] border border-[var(--color-border-default)] bg-white px-2.5 text-[12px] font-bold text-[var(--color-text-secondary)] transition-colors hover:border-[var(--color-brand-500)] hover:text-[var(--color-brand-800)] disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:border-[var(--color-border-default)] disabled:hover:text-[var(--color-text-secondary)] focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--color-brand-500)]'

function statusText({ mode, latestDate, resolvedDate }: Pick<Props, 'mode' | 'latestDate' | 'resolvedDate'>) {
  if (mode === 'historical' && resolvedDate) return `過去日を表示中（${resolvedDate} 大引け）`
  if (mode === 'unavailable') return '指定した日付は表示できません'
  return latestDate ? `最新の大引けを表示中（${latestDate}）` : 'データ未取り込み'
}

export function DashboardDateSelector({ dates, requestedDate, resolvedDate, latestDate, earliestDate, mode }: Props) {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const { setPending } = useDashboardHistoricalPending()
  const [isPending, startTransition] = useTransition()

  const [allDates, setAllDates] = useState<MarketDateOption[] | null>(null)
  const [loadingDates, setLoadingDates] = useState(false)
  const abortRef = useRef<AbortController | null>(null)
  const requestSeqRef = useRef(0)

  // 入力欄は URL の指定日に追従させる (props が変わったときだけ再設定)
  const initialDraft = requestedDate && ISO_DATE.test(requestedDate) ? requestedDate : ''
  const [draft, setDraft] = useState(initialDraft)
  const [syncedDraft, setSyncedDraft] = useState(initialDraft)
  if (syncedDraft !== initialDraft) {
    setSyncedDraft(initialDraft)
    setDraft(initialDraft)
  }

  // 切替が終わったら (成功・失敗とも) 確認中ビューを解除する
  useEffect(() => {
    if (!isPending) setPending(null)
  }, [isPending, setPending])

  useEffect(() => () => abortRef.current?.abort(), [])

  const loadAllDates = useCallback(async () => {
    if (allDates || abortRef.current) return
    const controller = new AbortController()
    const seq = ++requestSeqRef.current
    abortRef.current = controller
    setLoadingDates(true)
    try {
      const res = await fetch('/api/dashboard/dates?limit=10000', { cache: 'no-store', signal: controller.signal })
      if (!res.ok) throw new Error(`dashboard dates failed: ${res.status}`)
      const json = await res.json() as { dates?: MarketDateOption[] }
      // 古い応答・中断済みの応答は捨てる
      if (controller.signal.aborted || seq !== requestSeqRef.current) return
      if (Array.isArray(json.dates) && json.dates.length > 0) setAllDates(json.dates)
    } catch (error) {
      if (controller.signal.aborted) return
      console.warn(error)
    } finally {
      if (seq === requestSeqRef.current) {
        abortRef.current = null
        setLoadingDates(false)
      }
    }
  }, [allDates])

  const currentTarget = requestedDate && requestedDate === latestDate ? null : requestedDate

  const navigate = (date: string | null) => {
    const target = date && date === latestDate ? null : date
    // 切替中に「いま表示中の日付」へ戻す操作は有効 (最後の選択を優先する)
    if (!isPending && target === currentTarget) return
    const params = new URLSearchParams(searchParams.toString())
    if (target) params.set('date', target)
    else params.delete('date')
    const query = params.toString()
    setPending({ date: target, historical: target !== null })
    startTransition(() => {
      router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false })
    })
  }

  const canSubmit = ISO_DATE.test(draft)
  const showLatest = mode !== 'latest' && latestDate !== null
  const showEarliest = earliestDate !== null && earliestDate !== requestedDate
  const calendarValue = mode === 'historical' ? resolvedDate : null

  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-y border-[var(--color-border-soft)] px-1 py-2">
      <div className="flex min-w-[200px] flex-1 items-baseline gap-3">
        <span className="text-[11px] font-bold text-[var(--color-text-secondary)]">表示基準日</span>
        <span className={`text-[12px] font-semibold tabular-nums ${mode === 'latest' ? 'text-[var(--color-text-primary)]' : mode === 'historical' ? 'text-[#92400e]' : 'text-[var(--color-market-red-dark)]'}`}>
          {statusText({ mode, latestDate, resolvedDate })}
        </span>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <form
          className="flex items-center gap-2"
          onSubmit={(event) => {
            event.preventDefault()
            if (canSubmit) navigate(draft)
          }}
        >
          <input
            type="date"
            value={draft}
            max="9999-12-31"
            onChange={(event) => setDraft(event.target.value)}
            aria-label="表示基準日を日付で指定"
            className="h-8 w-[142px] rounded-[6px] border border-[var(--color-border-default)] bg-white px-2 text-[12px] font-bold tabular-nums text-[var(--color-text-primary)] focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--color-brand-500)]"
          />
          <button type="submit" disabled={!canSubmit} className={buttonClass}>
            表示
          </button>
        </form>
        {showEarliest && (
          <button type="button" onClick={() => navigate(earliestDate)} className={buttonClass}>
            最初の日
          </button>
        )}
        {showLatest && (
          <button type="button" onClick={() => navigate(null)} className={buttonClass}>
            最新へ
          </button>
        )}
        <MarketDateCalendar
          dates={allDates ?? dates}
          value={calendarValue}
          onChange={navigate}
          label="カレンダー"
          align="right"
          compact
          className="ml-auto"
          loading={loadingDates}
          onOpen={loadAllDates}
        />
      </div>
    </div>
  )
}
