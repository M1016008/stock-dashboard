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
import { PhysicalMomentumMarket } from '@/components/dashboard/PhysicalMomentumMarket'
import { TradeScenarioOverview } from '@/components/dashboard/TradeScenarioOverview'
import { DashboardDateSelector } from '@/components/dashboard/DashboardDateSelector'
import { getLatestDate } from '@/lib/queries/dashboard'
import { getDashboardDateOption } from '@/lib/queries/dashboard-cache'
import { getUniverseFilterMeta, parseUniverseFilter } from '@/lib/market-universe'

export const metadata: Metadata = {
  title: 'ダッシュボード — StockBoard',
  description: 'J-Quants データに基づく市場サマリーと注目銘柄の確認',
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

export default async function DashboardPage({
  searchParams,
}: {
  searchParams?: Promise<{ date?: string | string[]; universe?: string | string[] }>
}) {
  const sp = searchParams ? await searchParams : {}
  const requested = typeof sp.date === 'string' ? sp.date : null
  const universeFilter = parseUniverseFilter(sp.universe)
  const universeMeta = getUniverseFilterMeta(universeFilter)
  const [latestAvailable, requestedDateOption] = await Promise.all([
    getLatestDate(),
    getDashboardDateOption(requested),
  ])
  const requestedExists = Boolean(requestedDateOption)
  const selectedDate = requestedExists && requested !== latestAvailable ? requested : null
  const targetDate = requestedExists ? requested : latestAvailable
  const latest = targetDate
  const subtitle = latest
    ? `${latest} 大引け基準${selectedDate ? '（過去日表示）' : ''}`
    : 'データ未取り込み'
  const initialDates = [
    latestAvailable ? { date: latestAvailable } : null,
    selectedDate && selectedDate !== latestAvailable ? { date: selectedDate } : null,
  ].filter((date): date is { date: string } => date != null)

  return (
    <div className="mx-auto flex w-full max-w-[1420px] flex-col gap-5">
      <PageTitle
        title="ダッシュボード"
        subtitle={subtitle}
        badge={universeMeta ? `${universeMeta.shortLabel} / 最新データ反映` : '最新データ反映'}
      />
      <DashboardDateSelector dates={initialDates} selectedDate={selectedDate} />
      <Suspense fallback={<SectionFallback height={300} />}>
        <TradeScenarioOverview />
      </Suspense>
      <Suspense fallback={<SectionFallback height={150} />}>
        <PhysicalMomentumMarket universe={universeFilter} />
      </Suspense>
      <Suspense fallback={<SectionFallback height={360} />}>
        <StereoscopicSignals date={latest} universe={universeFilter} />
      </Suspense>
      <Suspense fallback={<SectionFallback height={420} />}>
        <NewHighVolume date={latest} universe={universeFilter} />
      </Suspense>
    </div>
  )
}
