import type { Metadata } from 'next'
import { PageTitle } from '@/components/layout/PageTitle'
import { UsScreenerClient } from './UsScreenerClient'

export const dynamic = 'force-dynamic'
export const revalidate = 0

export const metadata: Metadata = {
  title: 'USスクリーナー — StockBoard',
  description: '米国株のステージ、移動平均、価格変化を条件で絞り込みます。',
}

export default function UsScreenerPage() {
  return (
    <div className="mx-auto flex w-full max-w-[1480px] flex-col gap-5">
      <PageTitle
        title="USスクリーナー"
        subtitle="米国株の日次価格から生成したステージ、移動平均、価格変化を一覧で確認します。"
        badge="US Market"
      />
      <UsScreenerClient />
    </div>
  )
}
