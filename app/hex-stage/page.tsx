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
import { TabRow } from '@/components/ui/TabRow'
import { getHexDateOptions, getLatestHexDate, resolveHexAsOfDate, type Timescale, type Period } from '@/lib/queries/hex'
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

function buildViewHref(
  view: 'market' | 'selector',
  values: Record<string, string | null | undefined>,
) {
  const params = new URLSearchParams()
  if (view === 'selector') params.set('view', 'selector')
  for (const [key, value] of Object.entries(values)) {
    if (value) params.set(key, value)
  }
  const query = params.toString()
  return `/hex-stage${query ? `?${query}` : ''}`
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
      style={{
        height: h,
        background: 'var(--color-surface-subtle)',
        borderRadius: 6,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        color: 'var(--color-text-tertiary)',
        fontSize: 11,
      }}
    >
      読込中...
    </div>
  )
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
  const view = firstParam(sp.view) === 'selector' ? 'selector' : 'market'
  const taxonomy = parseTaxonomy(firstParam(sp.taxonomy))
  const mode = parseHexSelectorMode(firstParam(sp.mode))
  const direction = parseHexSelectorDirection(firstParam(sp.direction))
  const requestedGroup = firstParam(sp.group)
  const requestedParent = firstParam(sp.parent)
  const [latestDate, targetDate] = await Promise.all([
    getLatestHexDate(),
    resolveHexAsOfDate(rawDate ?? null),
  ])
  const selectedDate = targetDate && targetDate !== latestDate ? targetDate : null
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

  return (
    <div className="sb-page">
      <div className="sb-page-title">
        <h1>HEX ステージ分析</h1>
        <p>
          市場全体の循環を確認し、業種構造から候補銘柄まで絞り込みます
          {universeMeta ? ` · ${universeMeta.shortLabel}に絞り込み中` : ''}
          {selectedDate ? ` · ${selectedDate}時点` : latestDate ? ` · 最新 ${latestDate}` : ''}
        </p>
      </div>

      <div className="sb-section-bd flex items-center gap-1 py-2">
        <Link href={marketHref} className={`sb-tab ${view === 'market' ? 'sb-on' : ''}`}>市場循環</Link>
        <Link href={selectorHref} className={`sb-tab ${view === 'selector' ? 'sb-on' : ''}`}>業種から選ぶ</Link>
        <span className="ml-auto hidden text-[10px] font-semibold text-[var(--color-text-tertiary)] sm:inline">
          {view === 'market' ? '市場全体の分布・遷移を確認' : '業種比較から銘柄候補を選別'}
        </span>
      </div>

      <HexDateSelector dates={initialDates} selectedDate={selectedDate} latestDate={latestDate} targetDate={targetDate} />

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
          <div className="sb-section-bd" style={{ display: 'flex', alignItems: 'center', gap: 4, paddingTop: 0 }}>
            <TabRow basePath="/hex-stage" paramKey="ts" current={ts} tabs={TS_TABS} keepKeys={['period', UNIVERSE_FILTER_PARAM, 'date']} />
          </div>

          <div className="sb-section">
            <div className="sb-hd">
              <h2>6 ステージの循環</h2>
              <span>1 → 2 → 3 → 4 → 5 → 6 → 1 のサイクル</span>
            </div>
            <Suspense fallback={<Loading h={130} />}>
              <SixStageCircleMock timescale={ts} universe={universeFilter} asOfDate={targetDate} />
            </Suspense>
          </div>

          <div className="sb-section" style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <h2 style={{ margin: '0 12px 0 0', fontSize: 14, fontWeight: 500 }}>ステージ変化サマリー</h2>
            <TabRow basePath="/hex-stage" paramKey="period" current={period} tabs={PERIOD_TABS} keepKeys={['ts', UNIVERSE_FILTER_PARAM, 'date']} />
          </div>

          <div className="sb-section">
            <Suspense fallback={<Loading h={300} />}>
              <TransitionMatrixMock timescale={ts} period={period} universe={universeFilter} asOfDate={targetDate} />
            </Suspense>
          </div>

          <div className="sb-section">
            <Suspense fallback={<Loading h={300} />}>
              <TransitionDetailTableMock timescale={ts} period={period} universe={universeFilter} asOfDate={targetDate} />
            </Suspense>
          </div>

          <div style={{ borderTop: '0.5px solid var(--color-border-soft)' }}>
            <div className="sb-section" style={{ paddingTop: 14 }}>
              <HexStageMapView />
            </div>
          </div>
        </>
      )}
    </div>
  )
}
