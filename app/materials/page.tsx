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
    <div className="h-[420px] animate-pulse border border-[var(--color-border-default)] bg-[var(--color-surface-subtle)]" aria-label="材料ニュースを読み込み中" />
  )
}

export default function MaterialsPage() {
  return (
    <div className="mx-auto flex w-full max-w-[1500px] flex-col gap-5">
      <PageTitle
        title="材料ニュース"
        subtitle="材料を見出しで終わらせず、関連銘柄の6ステージ・短期チェック・流動性まで同じ画面で確認します。"
        badge="Materials"
      />
      <Suspense fallback={<MaterialNewsFallback />}>
        <KabutanMaterialNews />
      </Suspense>
    </div>
  )
}
