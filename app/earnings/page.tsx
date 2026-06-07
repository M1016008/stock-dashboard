import type { Metadata } from 'next'
import { Suspense } from 'react'
import { EarningsCalendarPanel } from '@/components/earnings/EarningsCalendarPanel'
import { EarningsDateCalendar } from '@/components/earnings/EarningsDateCalendar'
import { PageTitle } from '@/components/layout/PageTitle'
import { getEarningsDateCounts } from '@/lib/queries/earnings-calendar'
import {
  getLatestDate,
  type EarningsCalendarFilters,
  type EarningsSortDir,
  type EarningsSortKey,
  type EarningsVolumeCondition,
} from '@/lib/queries/dashboard'
import { getUniverseFilterMeta, parseUniverseFilter } from '@/lib/market-universe'

export const metadata: Metadata = {
  title: '決算 — StockBoard',
  description: '決算発表予定・発表後の値動き・テクニカルシグナルを確認',
}

export const dynamic = 'force-dynamic'
export const revalidate = 0
export const fetchCache = 'force-no-store'

function EarningsFallback() {
  return (
    <div className="rounded-[8px] border border-[var(--color-border-soft)] bg-[var(--color-surface-raised)] px-4 py-10 text-center text-[13px] font-bold text-[var(--color-text-tertiary)]">
      決算データを読込中...
    </div>
  )
}

function firstParam(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value
}

function isIsoDate(value: string | undefined): value is string {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
}

function isMonth(value: string | undefined): value is string {
  return typeof value === 'string' && /^\d{4}-\d{2}$/.test(value)
}

function parseNumberParam(value: string | undefined): number | null {
  if (!value?.trim()) return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

function parseLimit(value: string | undefined): number | null {
  if (!value?.trim()) return null
  const n = Number(value)
  return Number.isInteger(n) && n > 0 ? n : null
}

function parseVolumeCondition(value: string | undefined): EarningsVolumeCondition | null {
  if (
    value === 'volume_spike' ||
    value === 'above_avg' ||
    value === 'volume_10k' ||
    value === 'volume_100k'
  ) return value
  return null
}

function parseSortKey(value: string | undefined): EarningsSortKey | null {
  if (
    value === 'daysLeft' ||
    value === 'announceDate' ||
    value === 'ticker' ||
    value === 'name' ||
    value === 'market' ||
    value === 'sector17' ||
    value === 'sector33' ||
    value === 'price' ||
    value === 'changePct' ||
    value === 'avgVolume10' ||
    value === 'avgVolume30' ||
    value === 'avgVolume60' ||
    value === 'signalCount' ||
    value === 'stageCode' ||
    value === 'postEarningsChangePct'
  ) return value
  return null
}

function parseSortDir(value: string | undefined): EarningsSortDir | null {
  if (value === 'asc' || value === 'desc') return value
  return null
}

export default async function EarningsPage({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>
}) {
  const sp = searchParams ? await searchParams : {}
  const requestedDate = firstParam(sp.date)
  const requestedMonth = firstParam(sp.month)
  const selectedDate = isIsoDate(requestedDate) ? requestedDate : null
  const displayMonth = isMonth(requestedMonth) ? requestedMonth : null
  const universeFilter = parseUniverseFilter(sp.universe)
  const universeMeta = getUniverseFilterMeta(universeFilter)
  const filters: EarningsCalendarFilters = {
    marketSegment: firstParam(sp.market) ?? null,
    sector17: firstParam(sp.sector17) ?? null,
    sector33: firstParam(sp.sector33) ?? null,
    stageCode: firstParam(sp.stageCode) ?? null,
    dailyPattern: firstParam(sp.dailyPattern) ?? null,
    volumeCondition: parseVolumeCondition(firstParam(sp.volume)),
    priceMin: parseNumberParam(firstParam(sp.priceMin)),
    priceMax: parseNumberParam(firstParam(sp.priceMax)),
    signal: firstParam(sp.signal) ?? null,
    sortBy: parseSortKey(firstParam(sp.sort)),
    sortDir: parseSortDir(firstParam(sp.dir)),
    limit: parseLimit(firstParam(sp.limit)),
    completed: firstParam(sp.completed) === '1',
    universe: universeFilter,
  }
  const [latest, counts] = await Promise.all([
    getLatestDate(),
    getEarningsDateCounts(),
  ])
  const panelDate = selectedDate ?? latest
  const subtitle = panelDate
    ? `${panelDate} 基準 / 決算発表予定・発表後2週間の値動き`
    : 'データ未取り込み'

  return (
    <div className="mx-auto flex w-full max-w-[1420px] flex-col gap-5">
      <PageTitle
        title="決算"
        subtitle={subtitle}
        badge={universeMeta ? `${universeMeta.shortLabel} / JPX公式 + J-Quants` : 'JPX公式 + J-Quants'}
      />
      <EarningsDateCalendar
        counts={counts}
        selectedDate={selectedDate}
        displayMonth={displayMonth}
        latestDate={latest}
      />
      <Suspense fallback={<EarningsFallback />}>
        <EarningsCalendarPanel
          date={panelDate}
          month={displayMonth ?? (selectedDate ? selectedDate.slice(0, 7) : undefined)}
          preferLatestImport={!selectedDate}
          filters={filters}
          includeCompleted={filters.completed === true}
        />
      </Suspense>
    </div>
  )
}
