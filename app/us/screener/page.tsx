import type { Metadata } from 'next'
import { UsScreenerClient } from './UsScreenerClient'

export const dynamic = 'force-dynamic'
export const revalidate = 0

export const metadata: Metadata = {
  title: 'USスクリーナー — StockBoard',
  description: '米国株のステージ、移動平均、価格変化を条件で絞り込みます。',
}

export default function UsScreenerPage() {
  return (
    <div className="mx-auto w-full max-w-[1600px]">
      <UsScreenerClient />
    </div>
  )
}
