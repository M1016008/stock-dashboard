import type { Metadata } from 'next'
import { normalizeTickerForMarket } from '@/lib/markets'
import { getUsQuote } from '@/lib/us-market-data'
import { getNextUsEarnings } from '@/lib/queries/us-earnings'
import { UsStockDetailClient } from './UsStockDetailClient'

export const dynamic = 'force-dynamic'
export const revalidate = 0

type Props = {
  params: Promise<{ ticker: string }>
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { ticker } = await params
  const normalized = normalizeTickerForMarket(ticker, 'US')
  return {
    title: `${normalized} — US StockBoard`,
  }
}

export default async function UsStockPage({ params }: Props) {
  const { ticker } = await params
  const normalized = normalizeTickerForMarket(ticker, 'US')
  const [quote, nextEarnings] = await Promise.all([
    getUsQuote(normalized),
    getNextUsEarnings(normalized),
  ])
  return (
    <UsStockDetailClient
      ticker={normalized}
      initialQuote={quote}
      initialNextEarnings={nextEarnings}
      initialError={quote ? null : `${normalized} のUS価格データはまだ取得されていません。`}
    />
  )
}
