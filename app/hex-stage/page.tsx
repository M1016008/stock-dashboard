// app/hex-stage/page.tsx
// モック準拠 (v2) + 旧 HexMap 併存 + Suspense ストリーミング + キャッシュ無効化

import type { Metadata } from 'next'
import Link from 'next/link'
import { Suspense } from 'react'
import { SixStageCircleMock } from '@/components/hex/SixStageCircleMock'
import { TransitionMatrixMock } from '@/components/hex/TransitionMatrixMock'
import { TransitionDetailTableMock } from '@/components/hex/TransitionDetailTableMock'
import HexStageMapView from '@/components/hex/HexStageMapView'
import { HexDateSelector } from '@/components/hex/HexDateSelector'
import { HexSectorSelector } from '@/components/hex/HexSectorSelector'
import { StageTransitionScanner } from '@/components/hex/StageTransitionScanner'
import { DashboardHistoricalUnavailable } from '@/components/dashboard/DashboardHistoricalUnavailable'
import { TabRow } from '@/components/ui/TabRow'
import { PageTitle } from '@/components/layout/PageTitle'
import { ViewTabs } from '@/components/ui/ViewTabs'
import { SectionHeader } from '@/components/ui/SectionHeader'
import { getHexDateOptions, type Timescale, type Period } from '@/lib/queries/hex'
import { getDashboardAsOfState } from '@/lib/queries/dashboard-as-of'
import { getHexSelectorCandidates } from '@/lib/queries/hex-selector'
import {
  getSectorStructureBoard,
  resolveSectorStructureParentFromGroup,
} from '@/lib/queries/sectors'
import {
  parseHexSelectorDirection,
  parseHexSelectorMode,
  rankSelectorSectors,
} from '@/lib/hex-selector'
import type { SectorStructureTaxonomy } from '@/lib/sector-structure'
import { getUniverseFilterMeta, parseUniverseFilter, UNIVERSE_FILTER_PARAM } from '@/lib/market-universe'

export const metadata: Metadata = {
  title: 'HEX ステージ — StockBoard',
  description: 'トレンドステージ分布 + 遷移分析 + B×A グリッドで市場全体を俯瞰',
}

export const dynamic = 'force-dynamic'
export const revalidate = 0
export const fetchCache = 'force-no-store'

const VALID_TS: Timescale[] = ['daily_a', 'daily_b', 'weekly_a', 'weekly_b', 'monthly_a', 'monthly_b']
const VALID_PERIOD: Period[] = ['today', 'week', 'month', 'to_latest']

function firstParam(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] ?? null : value ?? null
}

function parseTaxonomy(value: string | null): SectorStructureTaxonomy {
  if (value === '17' || value === '33' || value === 'subIndustry') return value
  return 'major'
}

type HexStageView = 'market' | 'selector' | 'scanner'

function buildViewHref(
  view: HexStageView,
  values: Record<string, string | null | undefined>,
) {
  const params = new URLSearchParams()
  if (view !== 'market') params.set('view', view)
  for (const [key, value] of Object.entries(values)) {
    if (value) params.set(key, value)
  }
  const query = params.toString()
  return `/hex-stage${query ? `?${query}` : ''}`
}

function flattenSearchParams(values: Record<string, string | string[] | undefined>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(values).flatMap(([key, value]) => {
      const first = firstParam(value)
      return first == null ? [] : [[key, first]]
    }),
  )
}

const TS_TABS: { key: Timescale; label: string }[] = [
  { key: 'daily_a',   label: '日足 A' },
  { key: 'daily_b',   label: '日足 B' },
  { key: 'weekly_a',  label: '週足 A' },
  { key: 'weekly_b',  label: '週足 B' },
  { key: 'monthly_a', label: '月足 A' },
  { key: 'monthly_b', label: '月足 B' },
]
const PERIOD_TABS: { key: Period; label: string }[] = [
  { key: 'today', label: '本日' },
  { key: 'week',  label: '今週' },
  { key: 'month', label: '今月' },
  { key: 'to_latest', label: '現在まで' },
]

function Loading({ h = 100 }: { h?: number }) {
  return (
    <div
      role="status"
      aria-busy="true"
      className="flex animate-pulse items-center justify-center rounded-[6px] bg-[var(--color-surface-subtle)] text-[12px] text-[var(--color-text-tertiary)]"
      style={{ height: h }}
    >
      読み込み中…
    </div>
  )
}

function StageViewTabs({
  current,
  marketHref,
  selectorHref,
  scannerHref,
}: {
  current: HexStageView
  marketHref: string
  selectorHref: string
  scannerHref: string
}) {
  return (
    <ViewTabs
      label="6ステージ分析の表示"
      current={current}
      items={[
        { key: 'market', label: <>市場循環</>, href: marketHref },
        { key: 'selector', label: <>業種から選ぶ</>, href: selectorHref },
        { key: 'scanner', label: <>遷移スキャナー</>, href: scannerHref },
      ]}
    />
  )
}

const VIEW_HINT: Record<HexStageView, string> = {
  market: '市場全体の分布と遷移を確認',
  selector: '業種比較から銘柄候補を選別',
  scanner: '直前の実観測から当日への変化を検索',
}

export default async function HexStagePage({
  searchParams,
}: {
  searchParams: Promise<{
    ts?: string | string[]
    period?: string | string[]
    universe?: string | string[]
    date?: string | string[]
    view?: string | string[]
    taxonomy?: string | string[]
    group?: string | string[]
    parent?: string | string[]
    mode?: string | string[]
    direction?: string | string[]
    dailyCells?: string | string[]
    weeklyCells?: string | string[]
    monthlyCells?: string | string[]
    marketCap?: string | string[]
    q?: string | string[]
    from?: string | string[]
    to?: string | string[]
    dateFrom?: string | string[]
    dateTo?: string | string[]
    industry33?: string | string[]
    marketSegment?: string | string[]
    minPrice?: string | string[]
    maxPrice?: string | string[]
    minAvgVolume?: string | string[]
    maxAvgVolume?: string | string[]
    minAvgTurnover?: string | string[]
    maxAvgTurnover?: string | string[]
    sort?: string | string[]
    page?: string | string[]
    pageSize?: string | string[]
  }>
}) {
  const sp = await searchParams
  const rawTs = firstParam(sp.ts)
  const rawPeriod = firstParam(sp.period)
  const rawDate = firstParam(sp.date)
  const ts = (VALID_TS as string[]).includes(rawTs ?? '') ? (rawTs as Timescale) : 'daily_a'
  const period = (VALID_PERIOD as string[]).includes(rawPeriod ?? '') ? (rawPeriod as Period) : 'today'
  const universeFilter = parseUniverseFilter(sp.universe)
  const universeMeta = getUniverseFilterMeta(universeFilter)
  const rawView = firstParam(sp.view)
  const view: HexStageView = rawView === 'selector' || rawView === 'scanner' ? rawView : 'market'
  const taxonomy = parseTaxonomy(firstParam(sp.taxonomy))
  const mode = parseHexSelectorMode(firstParam(sp.mode))
  const direction = parseHexSelectorDirection(firstParam(sp.direction))
  const requestedGroup = firstParam(sp.group)
  const requestedParent = firstParam(sp.parent)

  if (view === 'scanner') {
    const marketHref = buildViewHref('market', { universe: universeFilter })
    const selectorHref = buildViewHref('selector', { universe: universeFilter })
    return (
      <div className="sb-page">
        <PageTitle
          eyebrow="分析・AI"
          title="市場6ステージ"
          subtitle="実観測された6桁ステージの変化を、期間・業種・流動性の条件で検索します。"
          badge={universeMeta ? `${universeMeta.shortLabel}に絞り込み中` : undefined}
        >
          <StageViewTabs current="scanner" marketHref={marketHref} selectorHref={selectorHref} scannerHref="/hex-stage?view=scanner" />
          <span className="text-[12px] text-[var(--color-text-tertiary)]">{VIEW_HINT.scanner}</span>
        </PageTitle>

        <StageTransitionScanner initialParams={flattenSearchParams(sp)} />
      </div>
    )
  }

  const asOf = await getDashboardAsOfState(rawDate ?? null)
  const latestDate = asOf.latestDate
  const targetDate = asOf.resolvedDate
  const selectedDate = targetDate && targetDate !== latestDate ? targetDate : null

  if (asOf.mode === 'unavailable') {
    return (
      <div className="sb-page">
        <PageTitle
          eyebrow="分析・AI"
          title="市場6ステージ"
          subtitle="指定した分析基準日のデータは表示できません。"
          badge="表示できません"
          badgeTone="danger"
          rightSlot={<Link href="/hex-stage" className="btn">最新日へ戻る</Link>}
        />
        <DashboardHistoricalUnavailable state={asOf} />
      </div>
    )
  }

  const initialDates = await getHexDateOptions(90, targetDate)
  let resolvedRequestedParent = requestedParent
  if (view === 'selector' && (taxonomy === 'subIndustry' || taxonomy === '33') && !resolvedRequestedParent) {
    resolvedRequestedParent = await resolveSectorStructureParentFromGroup(taxonomy, requestedGroup)
    if (!resolvedRequestedParent) {
      const parentTaxonomy = taxonomy === 'subIndustry' ? 'major' : '17'
      const parentBoard = await getSectorStructureBoard(parentTaxonomy, {
        requestedDate: targetDate,
        universeFilter,
      })
      resolvedRequestedParent = rankSelectorSectors(parentBoard.rows, mode, direction)[0]?.groupName ?? null
    }
  }
  const selectorSeed = view === 'selector'
    ? await getSectorStructureBoard(taxonomy, {
        selectedGroupKey: requestedGroup,
        parentFilter: resolvedRequestedParent,
        requestedDate: targetDate,
        universeFilter,
      })
    : null
  const rankedSectors = selectorSeed ? rankSelectorSectors(selectorSeed.rows, mode, direction) : []
  const resolvedGroupKey = selectorSeed && requestedGroup && selectorSeed.rows.some((row) => row.groupKey === requestedGroup)
    ? requestedGroup
    : rankedSectors[0]?.groupKey ?? selectorSeed?.selectedGroupKey ?? null
  const selectorBoard = selectorSeed && resolvedGroupKey && resolvedGroupKey !== selectorSeed.selectedGroupKey
    ? await getSectorStructureBoard(taxonomy, {
        selectedGroupKey: resolvedGroupKey,
        parentFilter: selectorSeed.parentFilter,
        requestedDate: targetDate,
        universeFilter,
      })
    : selectorSeed
  const selectedSector = selectorBoard?.rows.find((row) => row.groupKey === selectorBoard.selectedGroupKey) ?? null
  const selectorCandidates = selectedSector && selectorBoard?.latestDate
    ? await getHexSelectorCandidates({
        taxonomy,
        group: selectedSector,
        date: selectorBoard.latestDate,
        mode,
        direction,
        universeFilter,
      })
    : null
  const commonViewParams = {
    date: rawDate,
    universe: universeFilter,
    dailyCells: firstParam(sp.dailyCells),
    weeklyCells: firstParam(sp.weeklyCells),
    monthlyCells: firstParam(sp.monthlyCells),
    marketCap: firstParam(sp.marketCap),
    q: firstParam(sp.q),
  }
  const marketHref = buildViewHref('market', {
    ...commonViewParams,
    ts,
    period,
  })
  const selectorHref = buildViewHref('selector', {
    ...commonViewParams,
    taxonomy,
    group: resolvedGroupKey,
    parent: selectorBoard?.parentFilter,
    mode,
    direction,
  })
  const scannerHref = buildViewHref('scanner', { universe: universeFilter })

  return (
    <div className="sb-page">
      <PageTitle
        eyebrow="分析・AI"
        title="市場6ステージ"
        subtitle="市場全体の循環を確認し、業種構造から候補銘柄まで絞り込みます。"
        badge={universeMeta ? `${universeMeta.shortLabel}に絞り込み中` : undefined}
        meta={<span>{selectedDate ? `${selectedDate} 時点` : latestDate ? `最新 ${latestDate}` : '基準日なし'}</span>}
      >
        <StageViewTabs current={view} marketHref={marketHref} selectorHref={selectorHref} scannerHref={scannerHref} />
        <span className="text-[12px] text-[var(--color-text-tertiary)]">{VIEW_HINT[view]}</span>
      </PageTitle>

      <HexDateSelector
        dates={initialDates}
        requestedDate={rawDate}
        selectedDate={selectedDate}
        latestDate={latestDate}
        targetDate={targetDate}
      />

      {view === 'selector' && selectorBoard ? (
        <HexSectorSelector
          board={selectorBoard}
          candidates={selectorCandidates}
          mode={mode}
          direction={direction}
          universe={universeFilter}
        />
      ) : (
        <>
          <section className="sb-section" aria-label="6ステージの循環">
            <SectionHeader
              level={1}
              title="6ステージの循環"
              description="1 → 2 → 3 → 4 → 5 → 6 → 1 のサイクル"
              actions={<TabRow basePath="/hex-stage" paramKey="ts" current={ts} tabs={TS_TABS} keepKeys={['period', UNIVERSE_FILTER_PARAM, 'date']} label="時間軸" />}
            />
            <Suspense fallback={<Loading h={130} />}>
              <SixStageCircleMock timescale={ts} universe={universeFilter} asOfDate={targetDate} />
            </Suspense>
          </section>

          <section className="sb-section flex flex-col gap-4" aria-label="ステージ変化サマリー">
            <SectionHeader
              level={1}
              title="ステージ変化サマリー"
              description="期間内に起きたステージ遷移の件数と内訳"
              actions={<TabRow basePath="/hex-stage" paramKey="period" current={period} tabs={PERIOD_TABS} keepKeys={['ts', UNIVERSE_FILTER_PARAM, 'date']} label="期間" />}
            />
            <Suspense fallback={<Loading h={300} />}>
              <TransitionMatrixMock timescale={ts} period={period} universe={universeFilter} asOfDate={targetDate} />
            </Suspense>
            <Suspense fallback={<Loading h={300} />}>
              <TransitionDetailTableMock timescale={ts} period={period} universe={universeFilter} asOfDate={targetDate} />
            </Suspense>
          </section>

          <section className="sb-section" aria-label="ステージマップ">
            <HexStageMapView />
          </section>
        </>
      )}
    </div>
  )
}
