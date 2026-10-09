import type { Metadata } from 'next'
import { Suspense } from 'react'
import { AssistantResearchClient } from '@/components/assistant/AssistantResearchClient'
import { PageLoadingSkeleton } from '@/components/ui/PageLoadingSkeleton'

export const metadata: Metadata = {
  title: 'AI銘柄リサーチ — StockBoard',
  description: '自然言語で銘柄条件を相談し、StockBoardのDB根拠から候補を探す専用ページ',
}

export const dynamic = 'force-dynamic'
export const revalidate = 0

export default function AssistantResearchPage() {
  return (
    <Suspense fallback={<PageLoadingSkeleton title="AI銘柄リサーチを読み込んでいます" sections={2} />}>
      <AssistantResearchClient />
    </Suspense>
  )
}
