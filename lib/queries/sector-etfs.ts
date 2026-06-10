import { execAll, execGet } from '@/lib/db/client'
import {
  SECTOR_ETF_CATALOG,
  SECTOR_ETF_REFERENCE_LINKS,
  getSectorEtfByTicker,
  getSectorEtfSourceGuide,
  type SectorEtfCatalogItem,
} from '@/lib/sector-etfs'
import { calculateAngle } from '@/lib/hex-stage'

export interface SectorEtfStages {
  dailyA: number | null
  dailyB: number | null
  weeklyA: number | null
  weeklyB: number | null
  monthlyA: number | null
  monthlyB: number | null
}

export interface SectorEtfMaAngles {
  daily5: number | null
  daily25: number | null
  daily75: number | null
  weekly5: number | null
  weekly13: number | null
  weekly25: number | null
  monthly3: number | null
  monthly5: number | null
  monthly10: number | null
}

export interface SectorEtfHoldingStatus {
  count: number
  asOfDate: string | null
  updatedAt: number | null
  source: string | null
  sourceUrl: string | null
  lastRunStatus: string | null
  lastRunError: string | null
}

export interface SectorEtfMetric extends SectorEtfCatalogItem {
  dbName: string | null
  price: number | null
  priceDate: string | null
  prevClose: number | null
  change: number | null
  changePct: number | null
  stageDate: string | null
  stages: SectorEtfStages
  stageCode: string | null
  maOrderDaily: string | null
  maOrderWeekly: string | null
  maOrderMonthly: string | null
  maAngles: SectorEtfMaAngles
  maTrendLabel: string
  holdings: SectorEtfHoldingStatus
}

export interface SectorEtfHolding {
  id: number
  etfTicker: string
  holdingTicker: string
  holdingName: string
  weightPct: number | null
  shares: number | null
  marketValue: number | null
  asOfDate: string | null
  source: string
  sourceUrl: string | null
  updatedAt: number | null
}

export interface SectorEtfBoard {
  latestPriceDate: string | null
  latestStageDate: string | null
  metrics: SectorEtfMetric[]
  topix17: SectorEtfMetric[]
  themeGroups: Array<{ group: string; items: SectorEtfMetric[] }>
  summary: {
    total: number
    priced: number
    advancing: number
    declining: number
    stageOneOrSix: number
    stageFour: number
    holdingsReady: number
  }
  referenceLinks: typeof SECTOR_ETF_REFERENCE_LINKS
}

export interface SectorEtfDetail {
  metric: SectorEtfMetric
  holdings: SectorEtfHolding[]
  sourceGuide: string
}

interface PriceRankRow {
  ticker: string
  date: string
  close: number
  rn: number
}

interface SnapshotRankRow {
  ticker: string
  date: string
  ma_5: number | null
  ma_25: number | null
  ma_75: number | null
  ma_150: number | null
  ma_300: number | null
  weekly_ma_5: number | null
  weekly_ma_13: number | null
  weekly_ma_25: number | null
  weekly_ma_50: number | null
  weekly_ma_100: number | null
  monthly_ma_3: number | null
  monthly_ma_5: number | null
  monthly_ma_10: number | null
  monthly_ma_20: number | null
  monthly_ma_25: number | null
  daily_a_stage: number | null
  daily_b_stage: number | null
  weekly_a_stage: number | null
  weekly_b_stage: number | null
  monthly_a_stage: number | null
  monthly_b_stage: number | null
  rn: number
}

interface HoldingStatusRow {
  etf_ticker: string
  count: number
  as_of_date: string | null
  updated_at: number | null
  source: string | null
  source_url: string | null
}

interface HoldingRunRow {
  etf_ticker: string
  status: string
  error_summary: string | null
  rn: number
}

interface UniverseNameRow {
  ticker: string
  name: string | null
}

function normalizeTicker(ticker: string): string {
  return ticker.trim().toUpperCase().replace(/\.T$/i, '')
}

function toNumber(value: unknown): number | null {
  if (value == null) return null
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) ? n : null
}

function inClause(items: readonly string[]) {
  return items.map(() => '?').join(',')
}

function stageCode(stages: SectorEtfStages): string | null {
  const values = [stages.dailyA, stages.dailyB, stages.weeklyA, stages.weeklyB, stages.monthlyA, stages.monthlyB]
  if (values.some((v) => v == null)) return null
  return values.join('')
}

function orderedLabel(entries: Array<[string, number | null]>): string | null {
  if (entries.some(([, value]) => value == null || !Number.isFinite(value))) return null
  return [...entries]
    .sort((a, b) => (b[1] ?? 0) - (a[1] ?? 0))
    .map(([label]) => label)
    .join(' > ')
}

function directionFromAngle(angle: number | null): 'up' | 'down' | 'flat' {
  if (angle == null || !Number.isFinite(angle)) return 'flat'
  if (angle > 3) return 'up'
  if (angle < -3) return 'down'
  return 'flat'
}

function maTrendLabel(angles: SectorEtfMaAngles, stages: SectorEtfStages): string {
  const daily = [angles.daily5, angles.daily25, angles.daily75].map(directionFromAngle)
  const upCount = daily.filter((d) => d === 'up').length
  const downCount = daily.filter((d) => d === 'down').length
  if (stages.dailyA === 1 && upCount >= 2) return '上昇優勢'
  if (stages.dailyA === 4 && downCount >= 2) return '下落優勢'
  if (upCount > downCount) return '上向き'
  if (downCount > upCount) return '下向き'
  return '中立'
}

function buildMetric(
  catalog: SectorEtfCatalogItem,
  dbName: string | null,
  prices: PriceRankRow[],
  snapshots: SnapshotRankRow[],
  holdingStatus?: HoldingStatusRow,
  latestRun?: HoldingRunRow,
): SectorEtfMetric {
  const latestPrice = prices.find((row) => Number(row.rn) === 1)
  const prevPrice = prices.find((row) => Number(row.rn) === 2)
  const latestSnapshot = snapshots.find((row) => Number(row.rn) === 1)
  const angleBase = [...snapshots].reverse().find((row) => Number(row.rn) > 1) ?? null
  const angleDays = angleBase ? Math.max(1, Number(angleBase.rn) - 1) : 1
  const stages: SectorEtfStages = {
    dailyA: toNumber(latestSnapshot?.daily_a_stage),
    dailyB: toNumber(latestSnapshot?.daily_b_stage),
    weeklyA: toNumber(latestSnapshot?.weekly_a_stage),
    weeklyB: toNumber(latestSnapshot?.weekly_b_stage),
    monthlyA: toNumber(latestSnapshot?.monthly_a_stage),
    monthlyB: toNumber(latestSnapshot?.monthly_b_stage),
  }
  const maAngles: SectorEtfMaAngles = {
    daily5: calculateAngle(toNumber(latestSnapshot?.ma_5), toNumber(angleBase?.ma_5), angleDays),
    daily25: calculateAngle(toNumber(latestSnapshot?.ma_25), toNumber(angleBase?.ma_25), angleDays),
    daily75: calculateAngle(toNumber(latestSnapshot?.ma_75), toNumber(angleBase?.ma_75), angleDays),
    weekly5: calculateAngle(toNumber(latestSnapshot?.weekly_ma_5), toNumber(angleBase?.weekly_ma_5), angleDays),
    weekly13: calculateAngle(toNumber(latestSnapshot?.weekly_ma_13), toNumber(angleBase?.weekly_ma_13), angleDays),
    weekly25: calculateAngle(toNumber(latestSnapshot?.weekly_ma_25), toNumber(angleBase?.weekly_ma_25), angleDays),
    monthly3: calculateAngle(toNumber(latestSnapshot?.monthly_ma_3), toNumber(angleBase?.monthly_ma_3), angleDays),
    monthly5: calculateAngle(toNumber(latestSnapshot?.monthly_ma_5), toNumber(angleBase?.monthly_ma_5), angleDays),
    monthly10: calculateAngle(toNumber(latestSnapshot?.monthly_ma_10), toNumber(angleBase?.monthly_ma_10), angleDays),
  }
  const price = toNumber(latestPrice?.close)
  const prevClose = toNumber(prevPrice?.close)
  const change = price != null && prevClose != null ? price - prevClose : null
  const changePct = change != null && prevClose && prevClose > 0 ? (change / prevClose) * 100 : null
  return {
    ...catalog,
    dbName,
    price,
    priceDate: latestPrice?.date ?? null,
    prevClose,
    change,
    changePct,
    stageDate: latestSnapshot?.date ?? null,
    stages,
    stageCode: stageCode(stages),
    maOrderDaily: orderedLabel([
      ['5日', toNumber(latestSnapshot?.ma_5)],
      ['25日', toNumber(latestSnapshot?.ma_25)],
      ['75日', toNumber(latestSnapshot?.ma_75)],
    ]),
    maOrderWeekly: orderedLabel([
      ['5週', toNumber(latestSnapshot?.weekly_ma_5)],
      ['13週', toNumber(latestSnapshot?.weekly_ma_13)],
      ['25週', toNumber(latestSnapshot?.weekly_ma_25)],
    ]),
    maOrderMonthly: orderedLabel([
      ['3月', toNumber(latestSnapshot?.monthly_ma_3)],
      ['5月', toNumber(latestSnapshot?.monthly_ma_5)],
      ['10月', toNumber(latestSnapshot?.monthly_ma_10)],
    ]),
    maAngles,
    maTrendLabel: maTrendLabel(maAngles, stages),
    holdings: {
      count: Number(holdingStatus?.count ?? 0),
      asOfDate: holdingStatus?.as_of_date ?? null,
      updatedAt: toNumber(holdingStatus?.updated_at),
      source: holdingStatus?.source ?? null,
      sourceUrl: holdingStatus?.source_url ?? null,
      lastRunStatus: latestRun?.status ?? null,
      lastRunError: latestRun?.error_summary ?? null,
    },
  }
}

async function loadMetrics(tickers: readonly string[]): Promise<SectorEtfMetric[]> {
  if (tickers.length === 0) return []
  const placeholders = inClause(tickers)
  const [priceRows, snapshotRows, holdingRows, runRows, nameRows] = await Promise.all([
    execAll<PriceRankRow>(
      `
        SELECT ticker, date, close, rn
        FROM (
          SELECT
            ticker,
            date,
            close,
            ROW_NUMBER() OVER (PARTITION BY ticker ORDER BY date DESC) AS rn
          FROM ohlcv_daily
          WHERE ticker IN (${placeholders})
        )
        WHERE rn <= 2
      `,
      tickers,
    ),
    execAll<SnapshotRankRow>(
      `
        SELECT *
        FROM (
          SELECT
            ticker,
            date,
            ma_5, ma_25, ma_75, ma_150, ma_300,
            weekly_ma_5, weekly_ma_13, weekly_ma_25, weekly_ma_50, weekly_ma_100,
            monthly_ma_3, monthly_ma_5, monthly_ma_10, monthly_ma_20, monthly_ma_25,
            daily_a_stage, daily_b_stage, weekly_a_stage, weekly_b_stage, monthly_a_stage, monthly_b_stage,
            ROW_NUMBER() OVER (PARTITION BY ticker ORDER BY date DESC) AS rn
          FROM daily_snapshots
          WHERE ticker IN (${placeholders})
        )
        WHERE rn <= 6
      `,
      tickers,
    ),
    execAll<HoldingStatusRow>(
      `
        WITH latest AS (
          SELECT
            etf_ticker,
            as_of_date,
            source,
            source_url,
            updated_at,
            ROW_NUMBER() OVER (
              PARTITION BY etf_ticker
              ORDER BY as_of_date IS NULL, as_of_date DESC, updated_at DESC
            ) AS rn
          FROM sector_etf_holdings
          WHERE etf_ticker IN (${placeholders})
        )
        SELECT
          h.etf_ticker,
          COUNT(*) AS count,
          l.as_of_date,
          l.updated_at,
          l.source,
          l.source_url
        FROM latest l
        JOIN sector_etf_holdings h
          ON h.etf_ticker = l.etf_ticker
         AND (h.as_of_date = l.as_of_date OR (h.as_of_date IS NULL AND l.as_of_date IS NULL))
        WHERE l.rn = 1
        GROUP BY h.etf_ticker, l.as_of_date, l.updated_at, l.source, l.source_url
      `,
      tickers,
    ),
    execAll<HoldingRunRow>(
      `
        SELECT etf_ticker, status, error_summary, rn
        FROM (
          SELECT
            etf_ticker,
            status,
            error_summary,
            ROW_NUMBER() OVER (PARTITION BY etf_ticker ORDER BY started_at DESC, id DESC) AS rn
          FROM sector_etf_holding_runs
          WHERE etf_ticker IN (${placeholders})
        )
        WHERE rn = 1
      `,
      tickers,
    ),
    execAll<UniverseNameRow>(
      `SELECT ticker, name FROM ticker_universe WHERE ticker IN (${placeholders})`,
      tickers,
    ),
  ])
  const pricesByTicker = new Map<string, PriceRankRow[]>()
  const snapshotsByTicker = new Map<string, SnapshotRankRow[]>()
  const holdingsByTicker = new Map<string, HoldingStatusRow>()
  const runsByTicker = new Map<string, HoldingRunRow>()
  const namesByTicker = new Map<string, string | null>()
  for (const row of priceRows) {
    const list = pricesByTicker.get(row.ticker) ?? []
    list.push(row)
    pricesByTicker.set(row.ticker, list)
  }
  for (const row of snapshotRows) {
    const list = snapshotsByTicker.get(row.ticker) ?? []
    list.push(row)
    snapshotsByTicker.set(row.ticker, list)
  }
  for (const row of holdingRows) holdingsByTicker.set(row.etf_ticker, row)
  for (const row of runRows) runsByTicker.set(row.etf_ticker, row)
  for (const row of nameRows) namesByTicker.set(row.ticker, row.name)

  return SECTOR_ETF_CATALOG
    .filter((item) => tickers.includes(item.ticker))
    .map((item) => buildMetric(
      item,
      namesByTicker.get(item.ticker) ?? null,
      pricesByTicker.get(item.ticker) ?? [],
      snapshotsByTicker.get(item.ticker) ?? [],
      holdingsByTicker.get(item.ticker),
      runsByTicker.get(item.ticker),
    ))
}

export async function getSectorEtfBoard(): Promise<SectorEtfBoard> {
  const tickers = SECTOR_ETF_CATALOG.map((item) => item.ticker)
  const metrics = await loadMetrics(tickers)
  const topix17 = metrics.filter((item) => item.category === 'topix17')
  const themeItems = metrics.filter((item) => item.category !== 'topix17')
  const groupNames = Array.from(new Set(themeItems.map((item) => item.group)))
  const themeGroups = groupNames.map((group) => ({
    group,
    items: themeItems.filter((item) => item.group === group),
  }))
  const priced = metrics.filter((item) => item.price != null)
  const latestPriceDate = priced.map((item) => item.priceDate).filter(Boolean).sort().at(-1) ?? null
  const latestStageDate = metrics.map((item) => item.stageDate).filter(Boolean).sort().at(-1) ?? null
  return {
    latestPriceDate,
    latestStageDate,
    metrics,
    topix17,
    themeGroups,
    summary: {
      total: metrics.length,
      priced: priced.length,
      advancing: metrics.filter((item) => (item.changePct ?? 0) > 0).length,
      declining: metrics.filter((item) => (item.changePct ?? 0) < 0).length,
      stageOneOrSix: metrics.filter((item) => item.stages.dailyA === 1 || item.stages.dailyA === 6).length,
      stageFour: metrics.filter((item) => item.stages.dailyA === 4).length,
      holdingsReady: metrics.filter((item) => item.holdings.count > 0).length,
    },
    referenceLinks: SECTOR_ETF_REFERENCE_LINKS,
  }
}

export async function getSectorEtfDetail(rawTicker: string): Promise<SectorEtfDetail | null> {
  const ticker = normalizeTicker(rawTicker)
  const catalog = getSectorEtfByTicker(ticker)
  if (!catalog) return null
  const [metric] = await loadMetrics([catalog.ticker])
  if (!metric) return null
  const latest = await execGet<{ as_of_date: string | null }>(
    `
      SELECT as_of_date
      FROM sector_etf_holdings
      WHERE etf_ticker = ?
      ORDER BY as_of_date IS NULL, as_of_date DESC, updated_at DESC
      LIMIT 1
    `,
    [catalog.ticker],
  )
  const holdings = latest
    ? await execAll<SectorEtfHolding>(
      `
        SELECT
          id,
          etf_ticker AS etfTicker,
          holding_ticker AS holdingTicker,
          holding_name AS holdingName,
          weight_pct AS weightPct,
          shares,
          market_value AS marketValue,
          as_of_date AS asOfDate,
          source,
          source_url AS sourceUrl,
          updated_at AS updatedAt
        FROM sector_etf_holdings
        WHERE etf_ticker = ?
          AND (as_of_date = ? OR (as_of_date IS NULL AND ? IS NULL))
        ORDER BY weight_pct IS NULL, weight_pct DESC, holding_ticker
      `,
      [catalog.ticker, latest.as_of_date, latest.as_of_date],
    )
    : []
  return {
    metric,
    holdings,
    sourceGuide: getSectorEtfSourceGuide(catalog.provider),
  }
}
