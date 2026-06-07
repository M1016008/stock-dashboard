import { execAll, execGet } from '@/lib/db/client'
import { type UniverseFilterValue, universeSqlCondition } from '@/lib/market-universe'

export type SectorClassification = '17' | '33'
export type SectorPeriod = 'today' | 'week' | 'month'

export interface SectorHeatmapRow {
  sector_code: string | null
  sector_name: string
  n_stocks: number
  avg_change: number
  advancing_count: number
  declining_count: number
}

export interface SectorPeriodSummary {
  period: SectorPeriod
  label: string
  description: string
  latestDate: string
  baseDate: string
  rows17: SectorHeatmapRow[]
  rows33: SectorHeatmapRow[]
}

export interface SectorAnalysisBoard {
  latestDate: string | null
  periods: SectorPeriodSummary[]
  universe: UniverseFilterValue
}

const PERIODS: Array<{ period: SectorPeriod; label: string; description: string }> = [
  { period: 'today', label: '本日', description: '前営業日終値比' },
  { period: 'week', label: '今週', description: '直近5営業日前比' },
  { period: 'month', label: '今月', description: '前月最終営業日比' },
]

async function getLatestPriceDate(): Promise<string | null> {
  return (await execGet<{ d: string | null }>(`SELECT MAX(date) AS d FROM ohlcv_daily`))?.d ?? null
}

async function getPreviousTradingDate(date: string): Promise<string | null> {
  return (await execGet<{ d: string | null }>(
    `SELECT MAX(date) AS d FROM ohlcv_daily WHERE date < ?`,
    [date],
  ))?.d ?? null
}

async function getNthPreviousTradingDate(date: string, sessions: number): Promise<string | null> {
  const row = await execGet<{ d: string | null }>(
    `
      SELECT date AS d
      FROM (
        SELECT DISTINCT date
        FROM ohlcv_daily
        WHERE date <= ?
        ORDER BY date DESC
        LIMIT ?
      )
      ORDER BY date ASC
      LIMIT 1
    `,
    [date, sessions + 1],
  )
  return row?.d ?? null
}

async function getPreviousMonthEndTradingDate(date: string): Promise<string | null> {
  return (await execGet<{ d: string | null }>(
    `SELECT MAX(date) AS d FROM ohlcv_daily WHERE date < date(?, 'start of month')`,
    [date],
  ))?.d ?? null
}

async function resolveBaseDate(period: SectorPeriod, latestDate: string): Promise<string | null> {
  if (period === 'today') return getPreviousTradingDate(latestDate)
  if (period === 'week') {
    const base = await getNthPreviousTradingDate(latestDate, 5)
    return base && base !== latestDate ? base : getPreviousTradingDate(latestDate)
  }
  return await getPreviousMonthEndTradingDate(latestDate) ?? getPreviousTradingDate(latestDate)
}

function sectorColumns(classification: SectorClassification) {
  if (classification === '17') {
    return {
      code: 'tu.sector17_code',
      name: `COALESCE(NULLIF(tu.sector17_name, ''), 'その他')`,
      hasName: `tu.sector17_name IS NOT NULL AND tu.sector17_name <> ''`,
    }
  }
  return {
    code: 'tu.sector33_code',
    name: `COALESCE(NULLIF(tu.sector33_name, ''), 'その他')`,
    hasName: `tu.sector33_name IS NOT NULL AND tu.sector33_name <> ''`,
  }
}

export async function getSectorHeatmapRows(
  classification: SectorClassification,
  latestDate: string,
  baseDate: string,
  universeFilter: UniverseFilterValue = null,
): Promise<SectorHeatmapRow[]> {
  const cols = sectorColumns(classification)
  const universe = universeSqlCondition('tu.ticker', universeFilter)
  return execAll<SectorHeatmapRow>(
    `
      WITH latest_px AS (
        SELECT ticker, close
        FROM ohlcv_daily
        WHERE date = ?
      ),
      base_px AS (
        SELECT ticker, close
        FROM ohlcv_daily
        WHERE date = ?
      ),
      priced AS (
        SELECT
          tu.ticker,
          ${cols.code} AS sector_code,
          ${cols.name} AS sector_name,
          CASE
            WHEN base_px.close > 0 THEN 100.0 * (latest_px.close - base_px.close) / base_px.close
          END AS change_pct
        FROM ticker_universe tu
        JOIN latest_px ON latest_px.ticker = tu.ticker
        JOIN base_px ON base_px.ticker = tu.ticker
        WHERE tu.active = 1
          AND ${cols.hasName}
          ${universe.sql ? `AND ${universe.sql}` : ''}
      )
      SELECT
        sector_code,
        sector_name,
        COUNT(*) AS n_stocks,
        COALESCE(AVG(change_pct), 0) AS avg_change,
        SUM(CASE WHEN change_pct > 0 THEN 1 ELSE 0 END) AS advancing_count,
        SUM(CASE WHEN change_pct < 0 THEN 1 ELSE 0 END) AS declining_count
      FROM priced
      GROUP BY sector_code, sector_name
      ORDER BY avg_change DESC
    `,
    [latestDate, baseDate, ...universe.params],
  )
}

export async function getSectorAnalysisBoard(universeFilter: UniverseFilterValue = null): Promise<SectorAnalysisBoard> {
  const latestDate = await getLatestPriceDate()
  if (!latestDate) return { latestDate: null, periods: [], universe: universeFilter }

  const periods: SectorPeriodSummary[] = []
  for (const periodMeta of PERIODS) {
    const baseDate = await resolveBaseDate(periodMeta.period, latestDate)
    if (!baseDate) continue
    const [rows17, rows33] = await Promise.all([
      getSectorHeatmapRows('17', latestDate, baseDate, universeFilter),
      getSectorHeatmapRows('33', latestDate, baseDate, universeFilter),
    ])
    periods.push({
      ...periodMeta,
      latestDate,
      baseDate,
      rows17,
      rows33,
    })
  }

  return { latestDate, periods, universe: universeFilter }
}
