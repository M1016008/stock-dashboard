// app/page.tsx
// Phase 4 ダッシュボード再構築。Server Component で各セクションをパラレルに await。

import type { Metadata } from 'next'
import { PageTitle } from '@/components/layout/PageTitle'
import { IndicesGrid } from '@/components/dashboard/IndicesGrid'
import { StageDistributionBar } from '@/components/dashboard/StageDistributionBar'
import { TodayTransitionsSummary } from '@/components/dashboard/TodayTransitionsSummary'
import { StereoscopicSignals } from '@/components/dashboard/StereoscopicSignals'
import { NewHighVolume } from '@/components/dashboard/NewHighVolume'
import { SectorHeatmap } from '@/components/dashboard/SectorHeatmap'
import { WatchlistPanel } from '@/components/dashboard/WatchlistPanel'
import { CreditShortPanel } from '@/components/dashboard/CreditShortPanel'
import { PatternStatsTop } from '@/components/dashboard/PatternStatsTop'
import { EarningsCalendarPanel } from '@/components/dashboard/EarningsCalendarPanel'
import { getLatestDate } from '@/lib/queries/dashboard'

export const metadata: Metadata = {
  title: 'ダッシュボード — StockBoard',
  description: 'J-Quants データに基づく市場サマリーとパターン統計',
}

export const revalidate = 300  // 5 分

export default async function DashboardPage() {
  const latest = await getLatestDate()
  const subtitle = latest
    ? `${latest} 大引け基準`
    : 'データ未取り込み'

  return (
    <div className="flex flex-col gap-3.5">
      <PageTitle
        title="ダッシュボード"
        subtitle={subtitle}
        badge="パターン統計 最新反映"
      />
      <IndicesGrid />
      <StageDistributionBar />
      <div className="grid grid-cols-3 gap-2.5">
        <TodayTransitionsSummary />
        <StereoscopicSignals />
        <NewHighVolume />
      </div>
      <div className="grid grid-cols-[1.5fr_1fr] gap-3.5">
        <SectorHeatmap />
        <WatchlistPanel />
      </div>
      <div className="grid grid-cols-2 gap-3.5">
        <CreditShortPanel />
        <PatternStatsTop />
      </div>
      <EarningsCalendarPanel />
    </div>
  )
}
