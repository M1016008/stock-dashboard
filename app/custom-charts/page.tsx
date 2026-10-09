import type { Metadata } from 'next'
import { PageTitle } from '@/components/layout/PageTitle'
import { CustomChartsClient } from './CustomChartsClient'

export const dynamic = 'force-dynamic'
export const revalidate = 0

export const metadata: Metadata = {
  title: '合成チャート — StockBoard',
  description: '複数銘柄を数式で合成し、ラインまたはロウソク足で比較します。',
}

export default function CustomChartsPage() {
  return (
    <div className="w-full min-w-0 max-w-full space-y-4">
      <PageTitle
        eyebrow="分析・AI"
        title="合成チャート"
        subtitle="複数銘柄の株価・出来高を数式で合成し、ラインまたはロウソク足で表示します。"
      />
      <CustomChartsClient />
    </div>
  )
}
