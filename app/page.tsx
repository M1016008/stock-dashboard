// app/page.tsx
// Phase 4 ダッシュボード再構築 + Yoshio 要望: キャッシュ無効化 + Suspense ストリーミング
//
// 各セクションを Suspense で包むことで、ページを開いた瞬間にスケルトン UI が
// 表示され、重い集計クエリが終わったセクションから順に置き換わる
// (体感速度を維持しつつ毎回最新の DB 内容を反映)

import type { Metadata } from 'next'
import { Suspense } from 'react'
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

// Yoshio 要望: ページを開いたら毎回最新の DB を反映する (Next のキャッシュを完全無効化)
export const dynamic = 'force-dynamic'
export const revalidate = 0
export const fetchCache = 'force-no-store'

function SectionFallback({ height = 80 }: { height?: number }) {
  return (
    <div
      style={{
        height,
        background: 'var(--color-surface-raised)',
        borderRadius: 6,
        border: '1px solid var(--color-border-soft)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        color: 'var(--color-text-tertiary)',
        fontSize: 13,
        fontWeight: 600,
        boxShadow: 'none',
      }}
    >
      読込中...
    </div>
  )
}

export default async function DashboardPage() {
  const latest = await getLatestDate()
  const subtitle = latest ? `${latest} 大引け基準` : 'データ未取り込み'

  return (
    <div className="mx-auto flex w-full max-w-[1580px] flex-col gap-5">
      <PageTitle
        title="ダッシュボード"
        subtitle={subtitle}
        badge="パターン統計 最新反映"
      />
      <Suspense fallback={<SectionFallback height={70} />}>
        <IndicesGrid />
      </Suspense>
      <Suspense fallback={<SectionFallback height={70} />}>
        <StageDistributionBar />
      </Suspense>
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
        <Suspense fallback={<SectionFallback height={170} />}>
          <TodayTransitionsSummary />
        </Suspense>
        <Suspense fallback={<SectionFallback height={170} />}>
          <StereoscopicSignals />
        </Suspense>
        <Suspense fallback={<SectionFallback height={170} />}>
          <NewHighVolume />
        </Suspense>
      </div>
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[1.45fr_1fr]">
        <Suspense fallback={<SectionFallback height={240} />}>
          <SectorHeatmap />
        </Suspense>
        <Suspense fallback={<SectionFallback height={240} />}>
          <WatchlistPanel />
        </Suspense>
      </div>
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <Suspense fallback={<SectionFallback height={170} />}>
          <CreditShortPanel />
        </Suspense>
        <Suspense fallback={<SectionFallback height={170} />}>
          <PatternStatsTop />
        </Suspense>
      </div>
      <Suspense fallback={<SectionFallback height={200} />}>
        <EarningsCalendarPanel />
      </Suspense>
    </div>
  )
}
