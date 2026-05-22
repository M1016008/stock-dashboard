import { execGet, execRun } from '@/lib/db/client'
import {
  getCreditShortDashboard,
  getDashboardIndices,
  getEarningsCalendar,
  getLatestDate,
  getMarketMovers,
  getPatternStatsTopBottom,
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
  sector33Heatmap: SectorHeatRow[]
  creditShortDashboard: CreditShortDashboard
  patternStatsTopBottom: PatternRankRow[]
  earningsCalendar: EarningsRow[]
  computedAt: string
}

type DashboardCacheRow = {
  date: string
  payloadJson: string
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
    sector33Heatmap,
    creditShortDashboard,
    patternStatsTopBottom,
    earningsCalendar,
  ] = await Promise.all([
    getStereoscopicSignals(12),
    getMarketMovers(),
    getSector33Heatmap(),
    getCreditShortDashboard(),
    getPatternStatsTopBottom(),
    getEarningsCalendar(14),
  ])

  const payload: DashboardCachePayload = {
    latestDate,
    stereoscopicSignals,
    marketMovers,
    sector33Heatmap,
    creditShortDashboard,
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

export async function getDashboardPayload(): Promise<DashboardCachePayload | null> {
  const latestDate = await getLatestDate()
  if (!latestDate) return null
  const cached = await readDashboardCache(latestDate)
  return cached ?? buildDashboardCache(latestDate)
}

export async function getCachedLatestDate(): Promise<string | null> {
  return (await getDashboardPayload())?.latestDate ?? null
}

export async function getCachedDashboardIndices(): Promise<IndexQuote[]> {
  return getDashboardIndices()
}

export async function getCachedStageDistributionDailyA(): Promise<StageCountRow[]> {
  return getStageDistribution('daily_a_stage')
}

export async function getCachedTodayTransitionCounts(): Promise<TransitionCount | null> {
  return getTodayTransitionCounts()
}

export async function getCachedStereoscopicSignals(): Promise<StereoscopicRow[]> {
  return (await getDashboardPayload())?.stereoscopicSignals ?? []
}

export async function getCachedMarketMovers(): Promise<MarketMovers> {
  return (await getDashboardPayload())?.marketMovers ?? { newHighs: [], newLows: [], volumeSpikes: [] }
}

export async function getCachedSector33Heatmap(): Promise<SectorHeatRow[]> {
  return (await getDashboardPayload())?.sector33Heatmap ?? []
}

export async function getCachedCreditShortDashboard(): Promise<CreditShortDashboard> {
  return (await getDashboardPayload())?.creditShortDashboard ?? { asOf: null, sectorRows: [], stockRows: [] }
}

export async function getCachedPatternStatsTopBottom(): Promise<PatternRankRow[]> {
  return (await getDashboardPayload())?.patternStatsTopBottom ?? []
}

export async function getCachedEarningsCalendar(): Promise<EarningsRow[]> {
  return (await getDashboardPayload())?.earningsCalendar ?? []
}
