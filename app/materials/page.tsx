import type { Metadata } from 'next'
import { Suspense } from 'react'
import { KabutanMaterialNews } from '@/components/dashboard/KabutanMaterialNews'
import { PageTitle } from '@/components/layout/PageTitle'

export const dynamic = 'force-dynamic'
export const revalidate = 0

export const metadata: Metadata = {
  title: '材料ニュース — StockBoard',
  description: '株探の材料ニュースと関連銘柄を、6ステージ・短期チェックと合わせて確認します。',
}

function MaterialNewsFallback() {
  return (
    <div className="h-[420px] animate-pulse rounded-[6px] bg-[var(--color-surface-subtle)]" aria-label="材料ニュースを読み込み中" />
  )
}

export default function MaterialsPage() {
  return (
    <div className="flex w-full flex-col gap-5">
      <PageTitle
        eyebrow="市場・業種"
        title="材料ニュース"
        subtitle="材料ニュースの関連銘柄を、6ステージ・短期チェック・出来高と合わせて確認します。"
      />
      <Suspense fallback={<MaterialNewsFallback />}>
        <KabutanMaterialNews />
      </Suspense>
    </div>
  )
}
