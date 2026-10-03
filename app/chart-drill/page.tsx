import type { Metadata } from 'next'
import { ChartDrillClient } from './ChartDrillClient'

export const metadata: Metadata = {
  title: 'チャートドリル — StockBoard',
  description: '過去チャートを使い、初動察知と見送り判断を反復練習するトレーニングページ',
}

export const dynamic = 'force-dynamic'
export const revalidate = 0
export const fetchCache = 'force-no-store'

export default function ChartDrillPage() {
  return <ChartDrillClient />
}
