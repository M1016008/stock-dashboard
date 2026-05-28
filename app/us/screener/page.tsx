import { PageTitle } from '@/components/layout/PageTitle'
import { UsScreenerClient } from './UsScreenerClient'

export const dynamic = 'force-dynamic'
export const revalidate = 0

export default function UsScreenerPage() {
  return (
    <div className="mx-auto flex w-full max-w-[1480px] flex-col gap-5">
      <PageTitle
        title="USスクリーナー"
        subtitle="Tiingo EODから生成した米国株のステージ、移動平均、価格変化を一覧で確認します。"
        badge="US / Tiingo"
      />
      <UsScreenerClient />
    </div>
  )
}
