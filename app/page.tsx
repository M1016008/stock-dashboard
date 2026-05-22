// app/page.tsx
// Phase 4 ダッシュボード再構築 + Yoshio 要望: キャッシュ無効化 + Suspense ストリーミング
//
// 各セクションを Suspense で包むことで、ページを開いた瞬間にスケルトン UI が
// 表示され、重い集計クエリが終わったセクションから順に置き換わる
// (体感速度を維持しつつ毎回最新の DB 内容を反映)

import type { Metadata } from 'next'
import { Suspense } from 'react'
import { PageTitle } from '@/components/layout/PageTitle'
import { StereoscopicSignals } from '@/components/dashboard/StereoscopicSignals'
import { NewHighVolume } from '@/components/dashboard/NewHighVolume'
import { SectorHeatmap } from '@/components/dashboard/SectorHeatmap'
import { CreditShortPanel } from '@/components/dashboard/CreditShortPanel'
import { PatternStatsTop } from '@/components/dashboard/PatternStatsTop'
import { EarningsCalendarPanel } from '@/components/dashboard/EarningsCalendarPanel'
import { getCachedLatestDate } from '@/lib/queries/dashboard-cache'

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
  const latest = await getCachedLatestDate()
  const subtitle = latest ? `${latest} 大引け基準` : 'データ未取り込み'

  return (
    <div className="mx-auto flex w-full max-w-[1580px] flex-col gap-5">
      <PageTitle
        title="ダッシュボード"
        subtitle={subtitle}
        badge="パターン統計 最新反映"
      />
      <Suspense fallback={<SectionFallback height={360} />}>
        <StereoscopicSignals />
      </Suspense>
      <Suspense fallback={<SectionFallback height={420} />}>
        <NewHighVolume />
      </Suspense>
      <Suspense fallback={<SectionFallback height={260} />}>
        <PatternStatsTop />
      </Suspense>
      <Suspense fallback={<SectionFallback height={420} />}>
        <CreditShortPanel />
      </Suspense>
      <Suspense fallback={<SectionFallback height={240} />}>
        <SectorHeatmap />
      </Suspense>
      <Suspense fallback={<SectionFallback height={200} />}>
        <EarningsCalendarPanel />
      </Suspense>
    </div>
  )
}
