'use client'

import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { MarketDateCalendar, type MarketDateOption } from '@/components/ui/MarketDateCalendar'

interface Props {
  dates: MarketDateOption[]
  selectedDate: string | null
}

export function DashboardDateSelector({ dates, selectedDate }: Props) {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()

  const updateDate = (date: string | null) => {
    const params = new URLSearchParams(searchParams.toString())
    if (date) params.set('date', date)
    else params.delete('date')
    const query = params.toString()
    router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false })
  }

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-[8px] border border-[var(--color-border-soft)] bg-[var(--color-surface-subtle)] px-3 py-3">
      <div>
        <div className="text-[12px] font-bold text-[var(--color-text-secondary)]">表示基準日</div>
        <div className="mt-1 text-[11px] font-semibold text-[var(--color-text-tertiary)]">
          初期表示は最新日です。過去日を選ぶと、その日の市場状況・ステージ・シグナルへ切り替わります。
        </div>
      </div>
      <MarketDateCalendar dates={dates} value={selectedDate} onChange={updateDate} label="ダッシュボード日付" align="right" />
    </div>
  )
}
