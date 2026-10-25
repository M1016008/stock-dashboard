import type { Metadata } from 'next'
import { SixStageEventPathLab } from '@/components/research/SixStageEventPathLab'

export const metadata: Metadata = {
  title: '6-Stage Current Match Fixture | StockBoard',
  robots: { index: false, follow: false },
}

export default function SixStageCurrentMatchFixturePage() {
  return (
    <div className="min-w-0">
      <div className="border-b border-amber-300 bg-amber-50 px-4 py-3 text-center text-[12px] font-semibold text-amber-950">
        合成Fixture専用: 現在銘柄・類似イベントとも実市場データではありません。Production / Validation / Holdoutへの接続は0です。
      </div>
      <SixStageEventPathLab />
    </div>
  )
}
