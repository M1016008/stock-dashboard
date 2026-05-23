import { execAll, execGet, execRun } from '@/lib/db/client'
import {
  getDashboardIndices,
  getEarningsCalendarDashboard,
  getLatestDate,
  getMarketMovers,
  getPatternStatsTopBottom,
  getSector17Heatmap,
  getSector33Heatmap,
  getStageDistribution,
  getStereoscopicSignals,
  getTodayTransitionCounts,
  type CreditShortDashboard,
  type EarningsRow,
  type IndexQuote,
  type MarketMovers,
  type PatternRankRow,
  type SectorHeatRow,
  type StageCountRow,
  type StereoscopicRow,
  type TransitionCount,
} from '@/lib/queries/dashboard'

export type DashboardCachePayload = {
  latestDate: string
  stereoscopicSignals: StereoscopicRow[]
  marketMovers: MarketMovers
  sector17Heatmap?: SectorHeatRow[]
  sector33Heatmap: SectorHeatRow[]
  creditShortDashboard?: CreditShortDashboard
  patternStatsTopBottom: PatternRankRow[]
  earningsCalendar: EarningsRow[]
  computedAt: string
}

type DashboardCacheRow = {
  date: string
  payloadJson: string
}

export interface DashboardAvailableDate {
  date: string
  tickers: number
}

function parsePayload(row: DashboardCacheRow | undefined): DashboardCachePayload | null {
  if (!row) return null
  try {
    const payload = JSON.parse(row.payloadJson) as DashboardCachePayload
    return payload.latestDate === row.date ? payload : null
  } catch {
    return null
  }
}

async function readDashboardCache(date: string): Promise<DashboardCachePayload | null> {
  const row = await execGet<DashboardCacheRow>(
    `SELECT date, payload_json AS payloadJson FROM dashboard_cache WHERE date = ?`,
    [date],
  )
  return parsePayload(row)
}

export async function buildDashboardCache(date?: string): Promise<DashboardCachePayload | null> {
  const latestDate = date ?? await getLatestDate()
  if (!latestDate) return null

  const [
    stereoscopicSignals,
    marketMovers,
    sector17Heatmap,
    sector33Heatmap,
    patternStatsTopBottom,
    earningsCalendar,
  ] = await Promise.all([
    getStereoscopicSignals(12, latestDate),
    getMarketMovers(latestDate),
    getSector17Heatmap(latestDate),
    getSector33Heatmap(latestDate),
    getPatternStatsTopBottom(),
    getEarningsCalendarDashboard(120, latestDate).then((data) => data.rows),
  ])

  const payload: DashboardCachePayload = {
    latestDate,
    stereoscopicSignals,
    marketMovers,
    sector17Heatmap,
    sector33Heatmap,
    patternStatsTopBottom,
    earningsCalendar,
    computedAt: new Date().toISOString(),
  }

  await execRun(
    `
      INSERT INTO dashboard_cache (date, payload_json, computed_at)
      VALUES (?, ?, unixepoch())
      ON CONFLICT(date) DO UPDATE SET
        payload_json = excluded.payload_json,
        computed_at = excluded.computed_at
    `,
    [latestDate, JSON.stringify(payload)],
  )

  return payload
}

export async function getDashboardPayload(date?: string | null): Promise<DashboardCachePayload | null> {
  const latestDate = date ?? await getLatestDate()
  if (!latestDate) return null
  const cached = await readDashboardCache(latestDate)
  return cached ?? buildDashboardCache(latestDate)
}

export async function getCachedLatestDate(date?: string | null): Promise<string | null> {
  return (await getDashboardPayload(date))?.latestDate ?? null
}

export async function getDashboardAvailableDates(limit = 5000): Promise<DashboardAvailableDate[]> {
  return execAll<DashboardAvailableDate>(
    `SELECT date, COUNT(*) AS tickers
     FROM daily_snapshots
     GROUP BY date
     ORDER BY date DESC
     LIMIT ?`,
    [limit],
  )
}

export async function getCachedDashboardIndices(): Promise<IndexQuote[]> {
  return getDashboardIndices()
}

export async function getCachedStageDistributionDailyA(date?: string | null): Promise<StageCountRow[]> {
  return getStageDistribution('daily_a_stage', date)
}

export async function getCachedTodayTransitionCounts(date?: string | null): Promise<TransitionCount | null> {
  return getTodayTransitionCounts(date)
}

export async function getCachedStereoscopicSignals(date?: string | null): Promise<StereoscopicRow[]> {
  return (await getDashboardPayload(date))?.stereoscopicSignals ?? []
}

export async function getCachedMarketMovers(date?: string | null): Promise<MarketMovers> {
  return (await getDashboardPayload(date))?.marketMovers ?? { newHighs: [], newLows: [], volumeSpikes: [] }
}

export async function getCachedSector33Heatmap(date?: string | null): Promise<SectorHeatRow[]> {
  return (await getDashboardPayload(date))?.sector33Heatmap ?? []
}

export async function getCachedSector17Heatmap(date?: string | null): Promise<SectorHeatRow[]> {
  return (await getDashboardPayload(date))?.sector17Heatmap ?? await getSector17Heatmap(date ?? undefined)
}

export async function getCachedCreditShortDashboard(date?: string | null): Promise<CreditShortDashboard> {
  return (await getDashboardPayload(date))?.creditShortDashboard ?? { asOf: null, sectorRows: [], stockRows: [] }
}

export async function getCachedPatternStatsTopBottom(date?: string | null): Promise<PatternRankRow[]> {
  return (await getDashboardPayload(date))?.patternStatsTopBottom ?? []
}

export async function getCachedEarningsCalendar(date?: string | null): Promise<EarningsRow[]> {
  return (await getDashboardPayload(date))?.earningsCalendar ?? []
}
