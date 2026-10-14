import type { Metadata } from 'next'
import { normalizeTickerForMarket } from '@/lib/markets'
import { getUsQuote } from '@/lib/us-market-data'
import { getNextUsEarnings } from '@/lib/queries/us-earnings'
import { UsDataCoverageStrip } from '@/components/us/UsDataCoverageStrip'
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
  // データ鮮度・カバレッジ帯は銘柄見出しの上に 1 行で置く (銘柄固有の価格日は見出し側が正)。
  return (
    <div className="flex w-full min-w-0 flex-col gap-3">
      <UsDataCoverageStrip scope="stock" ticker={normalized} placement="standalone" />
      <UsStockDetailClient
        ticker={normalized}
        initialQuote={quote}
        initialNextEarnings={nextEarnings}
        initialError={quote ? null : `${normalized} のUS価格データはまだ取得されていません。`}
      />
    </div>
  )
}
