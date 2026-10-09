'use client'

import { useState } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { MarketDateCalendar, type MarketDateOption } from '@/components/ui/MarketDateCalendar'

interface Props {
  dates: MarketDateOption[]
  requestedDate: string | null
  selectedDate: string | null
  latestDate: string | null
  targetDate: string | null
}

export function HexDateSelector({ dates, requestedDate, selectedDate, latestDate, targetDate }: Props) {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const [loadedDates, setLoadedDates] = useState(dates)
  const [loadedAll, setLoadedAll] = useState(false)
  const [loading, setLoading] = useState(false)

  const loadAllDates = async () => {
    if (loadedAll || loading) return
    setLoading(true)
    try {
      const res = await fetch('/api/hex/available-dates?limit=10000', { cache: 'no-store' })
      if (!res.ok) throw new Error(`hex dates failed: ${res.status}`)
      const json = await res.json() as { dates?: MarketDateOption[] }
      if (Array.isArray(json.dates) && json.dates.length > 0) {
        setLoadedDates(json.dates)
        setLoadedAll(true)
      }
    } catch (error) {
      console.warn(error)
    } finally {
      setLoading(false)
    }
  }

  const updateDate = (date: string | null) => {
    const params = new URLSearchParams(searchParams.toString())
    if (date) params.set('date', date)
    else params.delete('date')
    const query = params.toString()
    router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false })
  }

  const isHistorical = Boolean(selectedDate)
  const adjustedToPriorSession = Boolean(
    isHistorical && requestedDate && targetDate && requestedDate !== targetDate,
  )

  return (
    <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-y border-[var(--color-border-soft)] py-2">
      <div className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-3 gap-y-0.5">
        <span className="text-[11px] font-bold text-[var(--color-text-secondary)]">分析基準日</span>
        <span className={`text-[12px] tabular-nums ${isHistorical ? 'font-semibold text-[#92400e]' : 'text-[var(--color-text-primary)]'}`}>
          {isHistorical
            ? adjustedToPriorSession
              ? `指定日 ${requestedDate} は休場のため、直前の営業日 ${targetDate} を表示中`
              : `${targetDate} 時点を表示中`
            : `最新 ${latestDate ?? '-'} を表示中`}
        </span>
        <span className="text-[11px] text-[var(--color-text-tertiary)]">
          {isHistorical
            ? `期間「現在まで」で最新日 ${latestDate ?? '-'} までの遷移を確認できます。`
            : '過去日を選ぶと、その時点の分析に切り替わります。'}
        </span>
      </div>
      <MarketDateCalendar
        dates={loadedDates}
        value={selectedDate}
        onChange={updateDate}
        label="基準日を選ぶ"
        align="right"
        compact
        loading={loading}
        onOpen={loadAllDates}
      />
    </div>
  )
}
