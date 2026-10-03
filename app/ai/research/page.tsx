import type { Metadata } from 'next'
import { Suspense } from 'react'
import { AssistantResearchClient } from '@/components/assistant/AssistantResearchClient'

export const metadata: Metadata = {
  title: 'AI銘柄リサーチ — StockBoard',
  description: '自然言語で銘柄条件を相談し、StockBoardのDB根拠から候補を探す専用ページ',
}

export const dynamic = 'force-dynamic'
export const revalidate = 0

export default function AssistantResearchPage() {
  return (
    <Suspense fallback={<div className="rounded-[8px] border border-[var(--color-border-default)] bg-white p-5 text-[13px] font-bold text-[var(--color-text-secondary)]">AI銘柄リサーチを読み込んでいます...</div>}>
      <AssistantResearchClient />
    </Suspense>
  )
}
