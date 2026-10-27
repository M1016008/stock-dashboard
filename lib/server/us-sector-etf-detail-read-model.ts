import { execAll, execGet } from '@/lib/db/client'
import { calculateAngle } from '@/lib/hex-stage'
import { isValidTickerForMarket, normalizeTickerForMarket } from '@/lib/markets'
import {
  US_ADJUSTED_PRICE_BASIS,
  toAdjustedUsOhlcvRows,
  type UsRawOhlcvRow,
} from '@/lib/us-adjusted-ohlcv'
import type { OHLCV } from '@/types/stock'
import {
  US_SECTOR_ETF_CATALOG,
  type UsSectorEtfCatalogItem,
  type UsSectorEtfStages,
} from '@/lib/server/us-sector-etf-read-model'

const MAX_HISTORY_ROWS = 2_600

type PriceIdentityRow = {
  date: string
  adj_close: number | null
  source: string | null
  imported_at: number | null
}

type SnapshotRow = {
  date: string
  ma_5: number | null
  ma_25: number | null
  ma_75: number | null
  ma_150: number | null
  ma_200: number | null
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

export type UsSectorEtfMovingAverageGroup = {
  labels: string[]
  values: Array<number | null>
  order: string | null
  angles: Array<number | null>
  angleObservationSteps: number | null
}

export type UsSectorEtfDetail = {
  status: 'ready'
  catalog: UsSectorEtfCatalogItem
  requestedDate: string | null
  asOfDate: string
  price: {
    value: number
    previousValue: number | null
    previousDate: string | null
    change: number | null
    changePct: number | null
    currency: 'USD'
    source: string | null
    importedAt: number | null
  }
  history: OHLCV[]
  historyCoverage: {
    firstDate: string
    lastDate: string
    rows: number
    cappedAt: number
  }
  stages: UsSectorEtfStages
  stageCode: string | null
  stageDate: string | null
  movingAverages: {
    daily: UsSectorEtfMovingAverageGroup
    weekly: UsSectorEtfMovingAverageGroup
    monthly: UsSectorEtfMovingAverageGroup
  }
  holdings: {
    status: 'unavailable'
    constituentsAvailable: false
    weightsAvailable: false
    reason: string
  }
  lineage: {
    market: 'US'
    priceBasis: typeof US_ADJUSTED_PRICE_BASIS
    priceRequirement: 'ADJ_CLOSE_REQUIRED'
    stageBasis: 'MARKET_DAILY_SNAPSHOTS_EXACT_AS_OF'
    holdingsBasis: 'UNAVAILABLE_NO_APPROVED_SOURCE'
  }
}

function numeric(value: unknown): number | null {
  if (value == null || value === '') return null
  const parsed = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function stage(value: unknown): number | null {
  const parsed = numeric(value)
  return parsed != null && Number.isInteger(parsed) && parsed >= 1 && parsed <= 6 ? parsed : null
}

function orderedLabel(labels: readonly string[], values: Array<number | null>): string | null {
  if (values.some((value) => value == null)) return null
  return labels
    .map((label, index) => [label, values[index]] as const)
    .sort((left, right) => (right[1] ?? 0) - (left[1] ?? 0))
    .map(([label]) => label)
    .join(' > ')
}

function stageCode(stages: UsSectorEtfStages): string | null {
  const values = [stages.dailyA, stages.dailyB, stages.weeklyA, stages.weeklyB, stages.monthlyA, stages.monthlyB]
  return values.every((value) => value != null) ? values.join('') : null
}

function buildMaGroup(
  labels: readonly string[],
  currentValues: Array<number | null>,
  baseValues: Array<number | null>,
  observationSteps: number | null,
): UsSectorEtfMovingAverageGroup {
  return {
    labels: [...labels],
    values: currentValues,
    order: orderedLabel(labels, currentValues),
    angles: currentValues.map((value, index) => (
      observationSteps == null ? null : calculateAngle(value, baseValues[index] ?? null, observationSteps)
    )),
    angleObservationSteps: observationSteps,
  }
}

export type UsSectorEtfTickerResolution =
  | { status: 'valid'; ticker: string; catalog: UsSectorEtfCatalogItem }
  | { status: 'invalid' }
  | { status: 'unsupported'; ticker: string }

export function resolveUsSectorEtfTicker(rawTicker: string): UsSectorEtfTickerResolution {
  const trimmed = rawTicker.trim()
  if (!trimmed || /\s/.test(trimmed)) return { status: 'invalid' }
  let ticker: string
  try {
    ticker = normalizeTickerForMarket(trimmed, 'US')
  } catch {
    return { status: 'invalid' }
  }
  if (!ticker || !isValidTickerForMarket(ticker, 'US')) return { status: 'invalid' }
  const catalog = US_SECTOR_ETF_CATALOG.find((item) => item.ticker === ticker)
  return catalog ? { status: 'valid', ticker, catalog } : { status: 'unsupported', ticker }
}

async function resolveAsOfDate(ticker: string, requestedDate: string | null): Promise<string | null> {
  if (requestedDate) {
    const exact = await execGet<{ date: string }>(
      `SELECT date
       FROM market_ohlcv_daily INDEXED BY market_ohlcv_market_ticker_date_idx
       WHERE market = 'US' AND ticker = ? AND date = ? AND adj_close IS NOT NULL
       LIMIT 1`,
      [ticker, requestedDate],
    )
    return exact?.date ?? null
  }
  const latest = await execGet<{ date: string | null }>(
    `SELECT MAX(date) AS date
     FROM market_ohlcv_daily INDEXED BY market_ohlcv_market_ticker_date_idx
     WHERE market = 'US' AND ticker = ? AND adj_close IS NOT NULL`,
    [ticker],
  )
  return latest?.date ?? null
}

async function loadHistory(ticker: string, asOfDate: string): Promise<OHLCV[]> {
  const rows = await execAll<UsRawOhlcvRow>(
    `SELECT date, open, high, low, close, volume,
            adj_open AS adjustedOpen,
            adj_high AS adjustedHigh,
            adj_low AS adjustedLow,
            adj_close AS adjustedClose,
            adj_volume AS adjustedVolume
     FROM (
       SELECT date, open, high, low, close, volume,
              adj_open, adj_high, adj_low, adj_close, adj_volume
       FROM market_ohlcv_daily INDEXED BY market_ohlcv_market_ticker_date_idx
       WHERE market = 'US' AND ticker = ? AND date <= ? AND adj_close IS NOT NULL
       ORDER BY date DESC
       LIMIT ?
     )
     ORDER BY date`,
    [ticker, asOfDate, MAX_HISTORY_ROWS],
  )
  return toAdjustedUsOhlcvRows(rows)
}

async function loadSnapshots(ticker: string, asOfDate: string): Promise<SnapshotRow[]> {
  return execAll<SnapshotRow>(
    `SELECT *, ROW_NUMBER() OVER (ORDER BY date DESC) AS rn
     FROM (
       SELECT date,
              ma_5, ma_25, ma_75, ma_150, ma_200, ma_300,
              weekly_ma_5, weekly_ma_13, weekly_ma_25, weekly_ma_50, weekly_ma_100,
              monthly_ma_3, monthly_ma_5, monthly_ma_10, monthly_ma_20, monthly_ma_25,
              daily_a_stage, daily_b_stage, weekly_a_stage, weekly_b_stage,
              monthly_a_stage, monthly_b_stage
       FROM market_daily_snapshots INDEXED BY market_snapshots_market_date_ticker_idx
       WHERE market = 'US' AND ticker = ? AND date <= ?
       ORDER BY date DESC
       LIMIT 6
     )
     ORDER BY date DESC`,
    [ticker, asOfDate],
  )
}

export async function loadUsSectorEtfDetail(
  rawTicker: string,
  requestedDate: string | null = null,
): Promise<UsSectorEtfDetail | null> {
  const resolution = resolveUsSectorEtfTicker(rawTicker)
  if (resolution.status !== 'valid') return null

  const asOfDate = await resolveAsOfDate(resolution.ticker, requestedDate)
  if (!asOfDate) return null

  const [identityRows, history, snapshots] = await Promise.all([
    execAll<PriceIdentityRow>(
      `SELECT date, adj_close, source, imported_at
       FROM market_ohlcv_daily INDEXED BY market_ohlcv_market_ticker_date_idx
       WHERE market = 'US' AND ticker = ? AND date <= ? AND adj_close IS NOT NULL
       ORDER BY date DESC
       LIMIT 2`,
      [resolution.ticker, asOfDate],
    ),
    loadHistory(resolution.ticker, asOfDate),
    loadSnapshots(resolution.ticker, asOfDate),
  ])

  const currentPrice = identityRows.find((row) => row.date === asOfDate)
  const price = numeric(currentPrice?.adj_close)
  if (!currentPrice || price == null || history.length === 0) return null

  const previousPriceRow = identityRows.find((row) => row.date < asOfDate)
  const previousValue = numeric(previousPriceRow?.adj_close)
  const change = previousValue == null ? null : price - previousValue
  const currentSnapshot = snapshots.find((row) => row.date === asOfDate)
  const baseSnapshot = currentSnapshot ? [...snapshots].reverse().find((row) => row.date < asOfDate) : undefined
  const observationSteps = currentSnapshot && baseSnapshot
    ? Math.max(1, Number(baseSnapshot.rn) - Number(currentSnapshot.rn))
    : null

  const stages: UsSectorEtfStages = {
    dailyA: stage(currentSnapshot?.daily_a_stage),
    dailyB: stage(currentSnapshot?.daily_b_stage),
    weeklyA: stage(currentSnapshot?.weekly_a_stage),
    weeklyB: stage(currentSnapshot?.weekly_b_stage),
    monthlyA: stage(currentSnapshot?.monthly_a_stage),
    monthlyB: stage(currentSnapshot?.monthly_b_stage),
  }

  const dailyValues = [
    numeric(currentSnapshot?.ma_5),
    numeric(currentSnapshot?.ma_25),
    numeric(currentSnapshot?.ma_75),
    numeric(currentSnapshot?.ma_150),
    numeric(currentSnapshot?.ma_200),
    numeric(currentSnapshot?.ma_300),
  ]
  const weeklyValues = [
    numeric(currentSnapshot?.weekly_ma_5),
    numeric(currentSnapshot?.weekly_ma_13),
    numeric(currentSnapshot?.weekly_ma_25),
    numeric(currentSnapshot?.weekly_ma_50),
    numeric(currentSnapshot?.weekly_ma_100),
  ]
  const monthlyValues = [
    numeric(currentSnapshot?.monthly_ma_3),
    numeric(currentSnapshot?.monthly_ma_5),
    numeric(currentSnapshot?.monthly_ma_10),
    numeric(currentSnapshot?.monthly_ma_20),
    numeric(currentSnapshot?.monthly_ma_25),
  ]

  return {
    status: 'ready',
    catalog: resolution.catalog,
    requestedDate,
    asOfDate,
    price: {
      value: price,
      previousValue,
      previousDate: previousPriceRow?.date ?? null,
      change,
      changePct: change != null && previousValue != null && previousValue > 0 ? (change / previousValue) * 100 : null,
      currency: 'USD',
      source: currentPrice.source,
      importedAt: numeric(currentPrice.imported_at),
    },
    history,
    historyCoverage: {
      firstDate: history[0].date,
      lastDate: history.at(-1)?.date ?? asOfDate,
      rows: history.length,
      cappedAt: MAX_HISTORY_ROWS,
    },
    stages,
    stageCode: stageCode(stages),
    stageDate: currentSnapshot?.date ?? null,
    movingAverages: {
      daily: buildMaGroup(
        ['5日', '25日', '75日', '150日', '200日', '300日'],
        dailyValues,
        [
          numeric(baseSnapshot?.ma_5), numeric(baseSnapshot?.ma_25), numeric(baseSnapshot?.ma_75),
          numeric(baseSnapshot?.ma_150), numeric(baseSnapshot?.ma_200), numeric(baseSnapshot?.ma_300),
        ],
        observationSteps,
      ),
      weekly: buildMaGroup(
        ['5週', '13週', '25週', '50週', '100週'],
        weeklyValues,
        [
          numeric(baseSnapshot?.weekly_ma_5), numeric(baseSnapshot?.weekly_ma_13),
          numeric(baseSnapshot?.weekly_ma_25), numeric(baseSnapshot?.weekly_ma_50),
          numeric(baseSnapshot?.weekly_ma_100),
        ],
        observationSteps,
      ),
      monthly: buildMaGroup(
        ['3月', '5月', '10月', '20月', '25月'],
        monthlyValues,
        [
          numeric(baseSnapshot?.monthly_ma_3), numeric(baseSnapshot?.monthly_ma_5),
          numeric(baseSnapshot?.monthly_ma_10), numeric(baseSnapshot?.monthly_ma_20),
          numeric(baseSnapshot?.monthly_ma_25),
        ],
        observationSteps,
      ),
    },
    holdings: {
      status: 'unavailable',
      constituentsAvailable: false,
      weightsAvailable: false,
      reason: '承認済みの米国セクターETF構成銘柄・組入比率ソースがないため表示できません。価格からの推定は行いません。',
    },
    lineage: {
      market: 'US',
      priceBasis: US_ADJUSTED_PRICE_BASIS,
      priceRequirement: 'ADJ_CLOSE_REQUIRED',
      stageBasis: 'MARKET_DAILY_SNAPSHOTS_EXACT_AS_OF',
      holdingsBasis: 'UNAVAILABLE_NO_APPROVED_SOURCE',
    },
  }
}
