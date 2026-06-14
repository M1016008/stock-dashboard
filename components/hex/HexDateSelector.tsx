'use client'

import { useState } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { MarketDateCalendar, type MarketDateOption } from '@/components/ui/MarketDateCalendar'

interface Props {
  dates: MarketDateOption[]
  selectedDate: string | null
  latestDate: string | null
  targetDate: string | null
}

export function HexDateSelector({ dates, selectedDate, latestDate, targetDate }: Props) {
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

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-[8px] border border-[var(--color-border-soft)] bg-[var(--color-surface-subtle)] px-3 py-3">
      <div>
        <div className="text-[12px] font-bold text-[var(--color-text-secondary)]">分析基準日</div>
        <div className="mt-1 text-[11px] font-semibold text-[var(--color-text-tertiary)]">
          {isHistorical
            ? `${targetDate}時点のステージを表示中。期間タブの「現在まで」で最新日 ${latestDate ?? '-'} への遷移を確認できます。`
            : `最新日 ${latestDate ?? '-'} 基準で表示中。過去日を選ぶと、その時点のHEX分析へ切り替わります。`}
        </div>
      </div>
      <MarketDateCalendar
        dates={loadedDates}
        value={selectedDate}
        onChange={updateDate}
        label="HEX日付"
        align="right"
        loading={loading}
        onOpen={loadAllDates}
      />
    </div>
  )
}
