// app/stock/[ticker]/page.tsx
import type { Metadata } from 'next'
import Link from 'next/link'
import { StockDetailClient } from './StockDetailClient'

export async function generateMetadata(
  { params }: { params: Promise<{ ticker: string }> }
): Promise<Metadata> {
  const { ticker } = await params
  const decodedTicker = decodeURIComponent(ticker)
  return {
    title: `${decodedTicker} — StockBoard`,
    description: `${decodedTicker}の株価チャート、ファンダメンタル指標、テクニカル分析`,
  }
}

export default async function StockDetailPage(
  { params }: { params: Promise<{ ticker: string }> }
) {
  const { ticker } = await params
  const decodedTicker = decodeURIComponent(ticker)

  return <StockDetailClient ticker={decodedTicker} />
}
