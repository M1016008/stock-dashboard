import { execAll, execGet } from '@/lib/db/client'
import {
  aggregateSectorRotation,
  percentage,
  stageChanges,
  type SectorRotationRow,
  type StageSet,
} from '@/lib/daily-close-report'
import { US_SEC_SIC_TAXONOMY } from '@/lib/us-classification'
import { usInvestableSymbolSql } from '@/lib/us-symbol-quality'

export const US_DAILY_CLOSE_REPORT_VERSION = 1 as const
export const US_DAILY_CLOSE_MAX_UNIVERSE = 20_000
export const US_DAILY_CLOSE_ROW_LIMIT = 12
export const US_DAILY_CLOSE_EARNINGS_LIMIT = 100

export type UsDailyCloseServingRow = {
  ticker: string
  name: string | null
  sector: string | null
  close0: number | null
  close1: number | null
  close2: number | null
  close5: number | null
  close10: number | null
  close20: number | null
  currentVolume: number | null
  avgVolume20: number | null
  dayA: number | null
  dayB: number | null
  weekA: number | null
  weekB: number | null
  monthA: number | null
  monthB: number | null
  prevDayA: number | null
  prevDayB: number | null
  prevWeekA: number | null
  prevWeekB: number | null
  prevMonthA: number | null
  prevMonthB: number | null
}

export type UsDailyCloseBenchmarkRow = {
  ticker: string
  close0: number | null
  close1: number | null
}

export type UsDailyCloseEarningsRow = {
  ticker: string
  name: string | null
  reportDate: string
  timeBucket: 'before_open' | 'market_hours' | 'after_close' | 'unknown'
  source: 'finnhub'
}

export type UsDailyCloseTickerRow = {
  ticker: string
  name: string
  sector: string | null
  price: number | null
  dailyReturn: number | null
  return5D: number | null
  return10D: number | null
  return20D: number | null
  volumeRatio: number | null
  stages: StageSet
  previousStages: StageSet
}

export type UsDailyCloseReport = {
  version: typeof US_DAILY_CLOSE_REPORT_VERSION
  marketCode: 'US'
  status: 'ready' | 'empty'
  requestedDate: string | null
  asOfDate: string | null
  previousDate: string | null
  snapshotDate: string | null
  generatedAt: string
  current: boolean
  priceBasis: 'COALESCE(adj_close, close)'
  classificationBasis: 'CURRENT_REFERENCE'
  coverage: {
    observedRows: number
    pricedRows: number
    stagedRows: number
    classifiedRows: number
  }
  market: {
    advances: number
    declines: number
    unchanged: number
    adjustedTurnoverUsd: number
    stageDistribution: Array<{ stage: number; count: number }>
  }
  benchmarks: Array<{ ticker: string; label: string; price: number | null; changePct: number | null }>
  sectors: SectorRotationRow[]
  leaders: {
    gainers: UsDailyCloseTickerRow[]
    decliners: UsDailyCloseTickerRow[]
    volumeSpikes: UsDailyCloseTickerRow[]
    stageImproving: Array<UsDailyCloseTickerRow & { changes: string[] }>
  }
  earnings: {
    status: 'available' | 'empty'
    rows: UsDailyCloseEarningsRow[]
  }
  unavailable: {
    ownership: { status: 'UNAVAILABLE'; reason: string }
    news: { status: 'UNAVAILABLE'; reason: string }
  }
  sources: string[]
  limitations: string[]
}

type UsDailyCloseDates = {
  latestDate: string | null
  asOfDate: string | null
  previousDate: string | null
  snapshotDate: string | null
  previousSnapshotDate: string | null
}

function finite(value: unknown): number | null {
  if (value == null || value === '') return null
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

function stages(row: UsDailyCloseServingRow, previous = false): StageSet {
  return previous
    ? {
        dayA: finite(row.prevDayA), dayB: finite(row.prevDayB),
        weekA: finite(row.prevWeekA), weekB: finite(row.prevWeekB),
        monthA: finite(row.prevMonthA), monthB: finite(row.prevMonthB),
      }
    : {
        dayA: finite(row.dayA), dayB: finite(row.dayB),
        weekA: finite(row.weekA), weekB: finite(row.weekB),
        monthA: finite(row.monthA), monthB: finite(row.monthB),
      }
}

function view(row: UsDailyCloseServingRow): UsDailyCloseTickerRow {
  const price = finite(row.close0)
  const volume = finite(row.currentVolume)
  const averageVolume = finite(row.avgVolume20)
  return {
    ticker: row.ticker,
    name: row.name?.trim() || row.ticker,
    sector: row.sector?.trim() || null,
    price,
    dailyReturn: percentage(price, finite(row.close1)),
    return5D: percentage(price, finite(row.close5)),
    return10D: percentage(price, finite(row.close10)),
    return20D: percentage(price, finite(row.close20)),
    volumeRatio: volume != null && averageVolume != null && averageVolume > 0
      ? volume / averageVolume
      : null,
    stages: stages(row),
    previousStages: stages(row, true),
  }
}

function top<T>(rows: T[], metric: (row: T) => number | null, direction: 'asc' | 'desc'): T[] {
  return rows.filter((row) => metric(row) != null)
    .sort((left, right) => direction === 'desc'
      ? metric(right)! - metric(left)!
      : metric(left)! - metric(right)!)
    .slice(0, US_DAILY_CLOSE_ROW_LIMIT)
}

export function isUsDailyCloseDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const parsed = new Date(`${value}T00:00:00.000Z`)
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value
}

export function buildUsDailyCloseReport(input: {
  requestedDate: string | null
  dates: UsDailyCloseDates
  rows: UsDailyCloseServingRow[]
  benchmarks?: UsDailyCloseBenchmarkRow[]
  earnings?: UsDailyCloseEarningsRow[]
  generatedAt?: string
}): UsDailyCloseReport {
  if (input.rows.length > US_DAILY_CLOSE_MAX_UNIVERSE) {
    throw new Error('us_daily_close_universe_limit_exceeded')
  }
  const stocks = input.rows.map(view)
  const breadth = stocks.reduce((result, row) => {
    if ((row.dailyReturn ?? 0) > 0) result.advances += 1
    else if ((row.dailyReturn ?? 0) < 0) result.declines += 1
    else result.unchanged += 1
    return result
  }, { advances: 0, declines: 0, unchanged: 0 })
  const stageCounts = new Map<number, number>()
  for (const row of stocks) {
    if (row.stages.dayA != null) stageCounts.set(row.stages.dayA, (stageCounts.get(row.stages.dayA) ?? 0) + 1)
  }
  const sectors = aggregateSectorRotation(input.rows.flatMap((row) => row.sector ? [{
    name: row.sector,
    return1: percentage(finite(row.close0), finite(row.close1)),
    previousReturn1: percentage(finite(row.close1), finite(row.close2)),
    return5: percentage(finite(row.close0), finite(row.close5)),
  }] : []))
  const benchmarkLabels: Record<string, string> = {
    SPY: 'S&P 500 ETF', QQQ: 'Nasdaq 100 ETF', DIA: 'Dow 30 ETF', IWM: 'Russell 2000 ETF',
  }
  const benchmarkRows = new Map((input.benchmarks ?? []).map((row) => [row.ticker, row]))
  const stageImproving = stocks.map((row) => ({
    ...row,
    changes: stageChanges(row.previousStages, row.stages),
  })).filter((row) => row.changes.length > 0)
    .sort((a, b) => b.changes.length - a.changes.length || (b.dailyReturn ?? -Infinity) - (a.dailyReturn ?? -Infinity))
    .slice(0, US_DAILY_CLOSE_ROW_LIMIT)

  return {
    version: US_DAILY_CLOSE_REPORT_VERSION,
    marketCode: 'US',
    status: stocks.length > 0 ? 'ready' : 'empty',
    requestedDate: input.requestedDate,
    asOfDate: input.dates.asOfDate,
    previousDate: input.dates.previousDate,
    snapshotDate: input.dates.snapshotDate,
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    current: input.dates.asOfDate != null
      && input.dates.asOfDate === input.dates.latestDate
      && input.dates.snapshotDate === input.dates.asOfDate,
    priceBasis: 'COALESCE(adj_close, close)',
    classificationBasis: 'CURRENT_REFERENCE',
    coverage: {
      observedRows: stocks.length,
      pricedRows: stocks.filter((row) => row.price != null).length,
      stagedRows: stocks.filter((row) => Object.values(row.stages).every((value) => value != null)).length,
      classifiedRows: stocks.filter((row) => row.sector != null).length,
    },
    market: {
      ...breadth,
      adjustedTurnoverUsd: input.rows.reduce((sum, row) => {
        const price = finite(row.close0)
        const volume = finite(row.currentVolume)
        return sum + (price != null && volume != null ? price * volume : 0)
      }, 0),
      stageDistribution: [1, 2, 3, 4, 5, 6].map((stage) => ({ stage, count: stageCounts.get(stage) ?? 0 })),
    },
    benchmarks: Object.entries(benchmarkLabels).map(([ticker, label]) => {
      const row = benchmarkRows.get(ticker)
      return { ticker, label, price: finite(row?.close0), changePct: percentage(finite(row?.close0), finite(row?.close1)) }
    }),
    sectors,
    leaders: {
      gainers: top([...stocks], (row) => row.dailyReturn, 'desc'),
      decliners: top([...stocks], (row) => row.dailyReturn, 'asc'),
      volumeSpikes: top([...stocks], (row) => row.volumeRatio, 'desc'),
      stageImproving,
    },
    earnings: {
      status: input.earnings?.length ? 'available' : 'empty',
      rows: [...(input.earnings ?? [])].sort((a, b) => a.reportDate.localeCompare(b.reportDate) || a.ticker.localeCompare(b.ticker)),
    },
    unavailable: {
      ownership: {
        status: 'UNAVAILABLE',
        reason: '13F/13D/GとShort Interestの認定済みUS Serving Sourceが未接続です。JP大量保有イベントで代替しません。',
      },
      news: {
        status: 'UNAVAILABLE',
        reason: 'US材料ニュースの認定済みServing Sourceが未接続です。価格変動や決算予定からニュースを推測しません。',
      },
    },
    sources: [
      'market_ohlcv_daily',
      'market_daily_snapshots',
      'market_universe',
      'market_classifications:US_SEC_SIC',
      'market_earnings_calendar:finnhub',
    ],
    limitations: [
      '価格と騰落率は調整済み価格を優先し、欠損時だけ未調整価格を使用します。',
      '過去日でも企業名・SEC SIC分類は現行参照です。分類履歴として扱いません。',
      '決算は正式に同期済みのFinnhub行だけを表示し、未同期日を推定しません。',
      'US Trigger Discoveryはユーザー定義条件であり、単一の認定済み日次評価がないため本レポートへ混在させません。',
      '所有・Short Interest・材料ニュースは対応Source未接続のためUNAVAILABLEです。',
    ],
  }
}

async function resolveDates(requestedDate: string | null): Promise<UsDailyCloseDates> {
  const row = await execGet<UsDailyCloseDates>(`
    SELECT
      (SELECT MAX(date) FROM market_ohlcv_daily WHERE market='US' AND ticker='SPY') AS latestDate,
      (SELECT MAX(date) FROM market_ohlcv_daily WHERE market='US' AND ticker='SPY' AND date<=COALESCE(?, '9999-12-31')) AS asOfDate,
      (SELECT MAX(date) FROM market_ohlcv_daily WHERE market='US' AND ticker='SPY' AND date<(
        SELECT MAX(date) FROM market_ohlcv_daily WHERE market='US' AND ticker='SPY' AND date<=COALESCE(?, '9999-12-31')
      )) AS previousDate,
      (SELECT MAX(date) FROM market_daily_snapshots WHERE market='US' AND date<=(
        SELECT MAX(date) FROM market_ohlcv_daily WHERE market='US' AND ticker='SPY' AND date<=COALESCE(?, '9999-12-31')
      )) AS snapshotDate,
      (SELECT MAX(date) FROM market_daily_snapshots WHERE market='US' AND date<(
        SELECT MAX(date) FROM market_daily_snapshots WHERE market='US' AND date<=(
          SELECT MAX(date) FROM market_ohlcv_daily WHERE market='US' AND ticker='SPY' AND date<=COALESCE(?, '9999-12-31')
        )
      )) AS previousSnapshotDate
  `, [requestedDate, requestedDate, requestedDate, requestedDate])
  return row ?? { latestDate: null, asOfDate: null, previousDate: null, snapshotDate: null, previousSnapshotDate: null }
}

async function loadServingRows(dates: UsDailyCloseDates): Promise<UsDailyCloseServingRow[]> {
  if (!dates.asOfDate) return []
  const rows = await execAll<UsDailyCloseServingRow>(`
    WITH recent_dates AS (
      SELECT date, ROW_NUMBER() OVER (ORDER BY date DESC) AS rn
      FROM (
        SELECT DISTINCT date FROM market_ohlcv_daily
        WHERE market='US' AND date<=?
        ORDER BY date DESC LIMIT 21
      )
    ), prices AS (
      SELECT o.ticker,d.rn,COALESCE(o.adj_close,o.close) price,COALESCE(o.adj_volume,o.volume) volume
      FROM recent_dates d
      JOIN market_ohlcv_daily o INDEXED BY market_ohlcv_market_date_ticker_idx
        ON o.market='US' AND o.date=d.date
      WHERE ${usInvestableSymbolSql('o.ticker')}
    ), pivot AS (
      SELECT ticker,
        MAX(CASE WHEN rn=1 THEN price END) close0,
        MAX(CASE WHEN rn=2 THEN price END) close1,
        MAX(CASE WHEN rn=3 THEN price END) close2,
        MAX(CASE WHEN rn=6 THEN price END) close5,
        MAX(CASE WHEN rn=11 THEN price END) close10,
        MAX(CASE WHEN rn=21 THEN price END) close20,
        MAX(CASE WHEN rn=1 THEN volume END) currentVolume,
        AVG(CASE WHEN rn BETWEEN 2 AND 21 THEN volume END) avgVolume20
      FROM prices GROUP BY ticker HAVING close0 IS NOT NULL
    )
    SELECT p.ticker,COALESCE(u.name,p.ticker) name,
      COALESCE(c.sector_name,u.sector) sector,
      p.close0,p.close1,p.close2,p.close5,p.close10,p.close20,p.currentVolume,p.avgVolume20,
      s.daily_a_stage dayA,s.daily_b_stage dayB,s.weekly_a_stage weekA,s.weekly_b_stage weekB,
      s.monthly_a_stage monthA,s.monthly_b_stage monthB,
      prev.daily_a_stage prevDayA,prev.daily_b_stage prevDayB,
      prev.weekly_a_stage prevWeekA,prev.weekly_b_stage prevWeekB,
      prev.monthly_a_stage prevMonthA,prev.monthly_b_stage prevMonthB
    FROM pivot p
    LEFT JOIN market_universe u ON u.market='US' AND u.ticker=p.ticker
    LEFT JOIN market_classifications c ON c.market='US' AND c.ticker=p.ticker
      AND c.taxonomy=? AND c.effective_from='0000-01-01'
    LEFT JOIN market_daily_snapshots s ON s.market='US' AND s.ticker=p.ticker AND s.date=?
    LEFT JOIN market_daily_snapshots prev ON prev.market='US' AND prev.ticker=p.ticker AND prev.date=?
    ORDER BY p.ticker LIMIT ${US_DAILY_CLOSE_MAX_UNIVERSE + 1}
  `, [dates.asOfDate, US_SEC_SIC_TAXONOMY, dates.snapshotDate, dates.previousSnapshotDate])
  if (rows.length > US_DAILY_CLOSE_MAX_UNIVERSE) throw new Error('us_daily_close_universe_limit_exceeded')
  return rows
}

async function loadBenchmarks(asOfDate: string | null): Promise<UsDailyCloseBenchmarkRow[]> {
  if (!asOfDate) return []
  return execAll<UsDailyCloseBenchmarkRow>(`
    WITH ranked AS (
      SELECT ticker,COALESCE(adj_close,close) price,
        ROW_NUMBER() OVER (PARTITION BY ticker ORDER BY date DESC) rn
      FROM market_ohlcv_daily INDEXED BY market_ohlcv_market_ticker_date_idx
      WHERE market='US' AND ticker IN ('SPY','QQQ','DIA','IWM') AND date<=?
    )
    SELECT ticker,MAX(CASE WHEN rn=1 THEN price END) close0,
      MAX(CASE WHEN rn=2 THEN price END) close1
    FROM ranked WHERE rn<=2 GROUP BY ticker ORDER BY ticker
  `, [asOfDate])
}

async function loadEarnings(asOfDate: string | null): Promise<UsDailyCloseEarningsRow[]> {
  if (!asOfDate) return []
  return execAll<UsDailyCloseEarningsRow>(`
    SELECT e.ticker,COALESCE(u.name,e.ticker) name,e.report_date reportDate,
      CASE WHEN e.time_bucket IN ('before_open','market_hours','after_close')
        THEN e.time_bucket ELSE 'unknown' END timeBucket,e.source
    FROM market_earnings_calendar e
    LEFT JOIN market_universe u ON u.market='US' AND u.ticker=e.ticker
    WHERE e.market='US' AND e.source='finnhub'
      AND e.report_date BETWEEN ? AND date(?, '+14 day')
    ORDER BY e.report_date,e.ticker LIMIT ${US_DAILY_CLOSE_EARNINGS_LIMIT}
  `, [asOfDate, asOfDate])
}

export async function loadUsDailyCloseReport(requestedDate: string | null): Promise<UsDailyCloseReport> {
  if (requestedDate != null && !isUsDailyCloseDate(requestedDate)) throw new Error('invalid_us_daily_close_date')
  const dates = await resolveDates(requestedDate)
  const [rows, benchmarks, earnings] = await Promise.all([
    loadServingRows(dates),
    loadBenchmarks(dates.asOfDate),
    loadEarnings(dates.asOfDate),
  ])
  return buildUsDailyCloseReport({ requestedDate, dates, rows, benchmarks, earnings })
}
