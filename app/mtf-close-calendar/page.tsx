import type { Metadata } from 'next'
import { PageTitle } from '@/components/layout/PageTitle'
import { MtfCloseCalendarClient } from './MtfCloseCalendarClient'

export const metadata: Metadata = {
  title: 'MTF Close Calendar | StockBoard',
  description: '日・週・月の複数時間足が確定する市場営業日を月間カレンダーで確認します。',
}

export const dynamic = 'force-dynamic'

function jstToday(): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date())
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]))
  return `${values.year}-${values.month}-${values.day}`
}

export default function MtfCloseCalendarPage() {
  const today = jstToday()
  return (
    <div className="flex w-full flex-col gap-5">
      <PageTitle
        title="MTF Close Calendar"
        subtitle="日・週・月のローソク足が同時に確定する市場営業日"
        badge="JP / Market Sessions"
      />
      <MtfCloseCalendarClient initialMonth={today.slice(0, 7)} today={today} />
    </div>
  )
}
