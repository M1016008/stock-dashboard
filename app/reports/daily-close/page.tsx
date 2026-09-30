import type { Metadata } from 'next'
import { DailyCloseReportClient } from '@/components/reports/DailyCloseReportClient'

export const metadata: Metadata = {
  title: 'Daily Close Report — StockBoard',
  description: '日本株の確定終値に基づく機関投資家向け日次市場レポート',
}

export const dynamic = 'force-dynamic'
export const revalidate = 0

export default async function DailyCloseReportPage({
  searchParams,
}: {
  searchParams?: Promise<{ date?: string | string[] }>
}) {
  const params = searchParams ? await searchParams : {}
  const requestedDate = typeof params.date === 'string' ? params.date : null
  return <DailyCloseReportClient requestedDate={requestedDate} />
}
