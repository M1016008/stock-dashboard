import { Suspense } from 'react'
import { TransitionsClient } from './_components/TransitionsClient'

export const metadata = {
  title: 'パターン探索 | StockBoard',
  description: '6 桁ステージコードごとの過去ケース統計を探索する。',
}

export default function TransitionsPage({
  searchParams,
}: {
  searchParams: Promise<{ code?: string; horizon?: string }>
}) {
  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold">パターン探索</h1>
        <p className="mt-1 text-sm text-[var(--color-text-secondary)]">
          6 桁ステージコード (日A日B週A週B月A月B) ごとの過去ケース統計。
          表示内容は過去データに基づく統計的観測です。
        </p>
      </header>
      <Suspense fallback={<p className="text-xs text-[var(--color-text-tertiary)]">読み込み中...</p>}>
        <TransitionsClient searchParams={searchParams} />
      </Suspense>
    </div>
  )
}
