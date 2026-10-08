// app/page.tsx
// Phase 4 ダッシュボード再構築 + Yoshio 要望: キャッシュ無効化 + Suspense ストリーミング
//
// 各セクションを Suspense で包むことで、ページを開いた瞬間にスケルトン UI が
// 表示され、重い集計クエリが終わったセクションから順に置き換わる
// (体感速度を維持しつつ毎回最新の DB 内容を反映)

import type { Metadata } from 'next'
import { Suspense } from 'react'
import { PageTitle } from '@/components/layout/PageTitle'
import { AiResearchShortcuts } from '@/components/dashboard/AiResearchShortcuts'
import { DashboardWorkspace } from '@/components/dashboard/DashboardWorkspace'
import { DashboardEarningsAlerts } from '@/components/dashboard/DashboardEarningsAlerts'
import { PhysicalMomentumMarket } from '@/components/dashboard/PhysicalMomentumMarket'
import { DashboardTradeSignalTable } from '@/components/dashboard/DashboardTradeSignalTable'
import { TradeScenarioOverview } from '@/components/dashboard/TradeScenarioOverview'
import { DashboardDateSelector } from '@/components/dashboard/DashboardDateSelector'
import { DashboardHistoricalBanner } from '@/components/dashboard/DashboardHistoricalBanner'
import { DashboardHistoricalShell } from '@/components/dashboard/DashboardHistoricalShell'
import { DashboardHistoricalUnavailable } from '@/components/dashboard/DashboardHistoricalUnavailable'
import { DashboardMarketBrief } from '@/components/dashboard/DashboardMarketBrief'
import { DASHBOARD_SECTION_META, DashboardSectionFallback } from '@/components/dashboard/DashboardSectionFallback'
import { KabutanMaterialNews } from '@/components/dashboard/KabutanMaterialNews'
import { getDashboardAsOfState } from '@/lib/queries/dashboard-as-of'
import { getUniverseFilterMeta, parseUniverseFilter } from '@/lib/market-universe'

export const metadata: Metadata = {
  title: 'ダッシュボード — StockBoard',
  description: 'J-Quants データに基づく市場サマリーと注目銘柄の確認',
}

// Yoshio 要望: ページを開いたら毎回最新の DB を反映する (Next のキャッシュを完全無効化)
export const dynamic = 'force-dynamic'
export const revalidate = 0
export const fetchCache = 'force-no-store'

// 表示日は getDashboardAsOfState の結果だけを正とする。
// - latest: 「今日の市場」(Hero) + 全セクションを表示
// - historical: 当時の内容として検証済みの「売買候補」「市場モメンタム」だけを表示し、
//   現在値に依存する他セクションは AS OF 帯の中で「表示しない項目」として説明する
// - unavailable: 範囲外・不正な日付では最新データを出さず、表示できる期間を案内する
//
// 構成 (上から): AS OF → 今日の市場 (状態 / 市場区分 / 今日の変化 / 今日の確認事項)
//   → 01 市場マップ → 02 売買候補 → 03 シナリオ進捗 → 04 決算・材料 → 05 次の分析
// Hero と各セクションは同じローダー (React cache) を共有するため、取得は 1 リクエストにつき 1 回。
export default async function DashboardPage({
  searchParams,
}: {
  searchParams?: Promise<{ date?: string | string[]; universe?: string | string[]; scenarioInterval?: string | string[] }>
}) {
  const sp = searchParams ? await searchParams : {}
  // 複数指定 (?date=a&date=b) は不正な日付として扱い、黙って最新に落とさない
  const rawDate = Array.isArray(sp.date) ? sp.date.join(',') : sp.date
  const requested = rawDate?.trim() ? rawDate.trim() : null
  const scenarioInterval = typeof sp.scenarioInterval === 'string' ? sp.scenarioInterval : null
  const universeFilter = parseUniverseFilter(sp.universe)
  const universeMeta = getUniverseFilterMeta(universeFilter)
  const asOf = await getDashboardAsOfState(requested)
  const { mode, resolvedDate } = asOf
  const historicalDate = mode === 'historical' ? resolvedDate : null

  const subtitle = mode === 'unavailable'
    ? asOf.availability === 'no_data' ? 'データ未取り込み' : '指定した日付のデータは表示できません'
    : `${resolvedDate} 大引け基準${mode === 'historical' ? '（過去日表示）' : ''}`
  const badgeLabel = mode === 'unavailable' ? '表示できません' : mode === 'historical' ? '過去日表示' : '最新データ反映'
  const initialDates = [
    asOf.latestDate ? { date: asOf.latestDate } : null,
    resolvedDate && resolvedDate !== asOf.latestDate ? { date: resolvedDate } : null,
  ].filter((date): date is { date: string } => date != null)

  const header = (
    <PageTitle
      title="ダッシュボード"
      subtitle={subtitle}
      badge={universeMeta ? `${universeMeta.shortLabel} / ${badgeLabel}` : badgeLabel}
    />
  )
  const selector = (
    <DashboardDateSelector
      dates={initialDates}
      requestedDate={asOf.requestedDate}
      resolvedDate={resolvedDate}
      latestDate={asOf.latestDate}
      earliestDate={asOf.earliestDate}
      mode={mode}
    />
  )

  const meta = (id: keyof typeof DASHBOARD_SECTION_META) => ({
    id,
    label: DASHBOARD_SECTION_META[id].label,
    description: DASHBOARD_SECTION_META[id].description,
  })

  const momentumSection = {
    ...meta('momentum'),
    content: (
      <Suspense fallback={<DashboardSectionFallback section="momentum" />}>
        <PhysicalMomentumMarket date={historicalDate} universe={universeFilter} />
      </Suspense>
    ),
  }
  const signalsSection = {
    ...meta('signals'),
    content: (
      <Suspense fallback={<DashboardSectionFallback section="signals" />}>
        <DashboardTradeSignalTable date={historicalDate} universe={universeFilter} scenarioInterval={scenarioInterval} />
      </Suspense>
    ),
  }

  const brief = mode === 'unavailable' ? null : (
    <DashboardMarketBrief
      date={historicalDate}
      universe={universeFilter}
      scenarioInterval={scenarioInterval}
      mode={mode}
      resolvedDate={resolvedDate}
      universeLabel={universeMeta?.shortLabel ?? null}
    />
  )

  let body: React.ReactNode
  if (mode === 'unavailable') {
    body = <DashboardHistoricalUnavailable state={asOf} />
  } else if (mode === 'historical' && asOf.requestedDate) {
    body = (
      <>
        <DashboardHistoricalBanner
          requestedDate={asOf.requestedDate}
          resolvedDate={resolvedDate!}
          adjusted={asOf.adjustedToPriorSession}
          latestDate={asOf.latestDate}
        />
        {brief}
        <DashboardWorkspace sections={[momentumSection, signalsSection]} />
      </>
    )
  } else {
    body = (
      <>
        {brief}
        <DashboardWorkspace
          sections={[
            momentumSection,
            signalsSection,
            {
              ...meta('trade-overview'),
              content: (
                <Suspense fallback={<DashboardSectionFallback section="trade-overview" />}>
                  <TradeScenarioOverview />
                </Suspense>
              ),
            },
            {
              ...meta('events'),
              content: (
                <div className="grid gap-x-10 gap-y-8 xl:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)]">
                  <Suspense fallback={<DashboardSectionFallback section="earnings" />}>
                    <DashboardEarningsAlerts universe={universeFilter} />
                  </Suspense>
                  <Suspense fallback={<DashboardSectionFallback section="materials" />}>
                    <KabutanMaterialNews compact />
                  </Suspense>
                </div>
              ),
            },
            {
              ...meta('research'),
              content: (
                <Suspense fallback={<DashboardSectionFallback section="research" />}>
                  <AiResearchShortcuts universe={universeFilter} />
                </Suspense>
              ),
            },
          ]}
        />
      </>
    )
  }

  return (
    <DashboardHistoricalShell
      header={header}
      selector={selector}
      contentKey={`${mode}:${asOf.requestedDate ?? 'latest'}:${resolvedDate ?? 'none'}`}
    >
      {body}
    </DashboardHistoricalShell>
  )
}
