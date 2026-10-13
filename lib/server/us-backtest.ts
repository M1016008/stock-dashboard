import {
  execUsAnalyticsAll,
  execUsAnalyticsGet,
  type UsAnalyticsArgs,
} from '@/lib/db/us-analytics'
import { isUsMarketTradingDate } from '@/lib/server/us-data-freshness'

export const US_BACKTEST_HORIZONS = [5, 10, 20, 40, 60, 90, 200] as const
export type UsBacktestHorizon = typeof US_BACKTEST_HORIZONS[number]

export type UsBacktestExecutor = {
  all<T = Record<string, unknown>>(sql: string, args?: readonly unknown[]): Promise<T[]>
  get<T = Record<string, unknown>>(sql: string, args?: readonly unknown[]): Promise<T | undefined>
}

export const usBacktestExecutor: UsBacktestExecutor = {
  all: (sql, args = []) => execUsAnalyticsAll(sql, args as UsAnalyticsArgs),
  get: (sql, args = []) => execUsAnalyticsGet(sql, args as UsAnalyticsArgs),
}

export type UsBacktestDate = {
  date: string
  totalTickers: number
  signalTickers: number
}

export type UsBacktestCoverage = {
  horizon: UsBacktestHorizon
  firstOutcomeDate: string | null
  latestOutcomeDate: string | null
  availableDates: number
  marketLatestDate: string | null
  classificationAvailability: 'OMITTED_HISTORICAL_PIT_UNAVAILABLE'
}

export type UsBacktestResult = {
  date: string
  horizonDays: number
  ticker: string
  name: string | null
  patternCode: string | null
  stages: Array<number | null>
  close: number | null
  volumeRatio20: number | null
  rangePct: number | null
  atr20Pct: number | null
  ma5PosPct: number | null
  ma25PosPct: number | null
  ma75PosPct: number | null
  signalCodes: string[]
  returnPct: number | null
  maxReturnPct: number | null
  maxReturnDate: string | null
  daysToMax: number | null
  minReturnPct: number | null
  minReturnDate: string | null
  daysToMin: number | null
  hit10: boolean | null
  hit20: boolean | null
  hit40: boolean | null
}

export type UsBacktestQuery = {
  date?: string | null
  horizon: UsBacktestHorizon
  search?: string | null
  stageCode?: string | null
  signal?: string | null
  returnMetric?: 'max' | 'period' | 'min'
  returnMin?: number | null
  returnMax?: number | null
  targetPct?: 10 | 20 | 40 | null
  sort?: 'maxReturn' | 'minReturn' | 'periodReturn' | 'volume' | 'ticker'
  page?: number
  pageSize?: number
}

type DateRow = {
  date: string
  total_tickers: number
  signal_tickers: number
}

type ResultRow = {
  date: string
  horizon_days: number
  ticker: string
  name: string | null
  pattern_code: string | null
  daily_a_stage: number | null
  daily_b_stage: number | null
  weekly_a_stage: number | null
  weekly_b_stage: number | null
  monthly_a_stage: number | null
  monthly_b_stage: number | null
  close: number | null
  volume_ratio_20: number | null
  range_pct: number | null
  atr20_pct: number | null
  ma5_pos_pct: number | null
  ma25_pos_pct: number | null
  ma75_pos_pct: number | null
  signal_codes: string | null
  return_pct: number | null
  max_return_pct: number | null
  max_return_date: string | null
  days_to_max: number | null
  min_return_pct: number | null
  min_return_date: string | null
  days_to_min: number | null
  hit_10: number | null
  hit_20: number | null
  hit_40: number | null
}

type SummaryRow = {
  count: number
  with_outcome: number
  hit_10_rate: number | null
  hit_20_rate: number | null
  hit_40_rate: number | null
  avg_max_return_pct: number | null
  avg_min_return_pct: number | null
  avg_days_to_max: number | null
}

function finite(value: unknown): number | null {
  if (value == null) return null
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

function integer(value: unknown): number | null {
  const number = finite(value)
  return number == null ? null : Math.trunc(number)
}

function compactSignals(value: string | null): string[] {
  if (!value) return []
  return value.split(',').map((item) => item.trim()).filter(Boolean)
}

function resultFromRow(row: ResultRow): UsBacktestResult {
  return {
    date: row.date,
    horizonDays: Number(row.horizon_days),
    ticker: row.ticker,
    name: row.name,
    patternCode: row.pattern_code,
    stages: [
      integer(row.daily_a_stage), integer(row.daily_b_stage),
      integer(row.weekly_a_stage), integer(row.weekly_b_stage),
      integer(row.monthly_a_stage), integer(row.monthly_b_stage),
    ],
    close: finite(row.close),
    volumeRatio20: finite(row.volume_ratio_20),
    rangePct: finite(row.range_pct),
    atr20Pct: finite(row.atr20_pct),
    ma5PosPct: finite(row.ma5_pos_pct),
    ma25PosPct: finite(row.ma25_pos_pct),
    ma75PosPct: finite(row.ma75_pos_pct),
    signalCodes: compactSignals(row.signal_codes),
    returnPct: finite(row.return_pct),
    maxReturnPct: finite(row.max_return_pct),
    maxReturnDate: row.max_return_date,
    daysToMax: integer(row.days_to_max),
    minReturnPct: finite(row.min_return_pct),
    minReturnDate: row.min_return_date,
    daysToMin: integer(row.days_to_min),
    hit10: row.hit_10 == null ? null : Boolean(row.hit_10),
    hit20: row.hit_20 == null ? null : Boolean(row.hit_20),
    hit40: row.hit_40 == null ? null : Boolean(row.hit_40),
  }
}

export function isUsBacktestHorizon(value: number): value is UsBacktestHorizon {
  return US_BACKTEST_HORIZONS.includes(value as UsBacktestHorizon)
}

export function isIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const parsed = new Date(`${value}T00:00:00.000Z`)
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value
}

export async function getUsBacktestDates(
  horizon: UsBacktestHorizon,
  executor: UsBacktestExecutor = usBacktestExecutor,
): Promise<{ dates: UsBacktestDate[]; coverage: UsBacktestCoverage }> {
  const [rows, market] = await Promise.all([
    executor.all<DateRow>(
      `
      SELECT d.date, d.total_tickers, d.signal_tickers
      FROM serving_backtest_dates d
      WHERE EXISTS (
        SELECT 1
        FROM serving_backtest_results r INDEXED BY serving_backtest_results_horizon_date_idx
        WHERE r.horizon_days = ? AND r.date = d.date
      )
      ORDER BY d.date DESC
      `,
      [horizon],
    ),
    executor.get<{ date: string | null }>(
      `SELECT date FROM ohlcv_daily INDEXED BY ohlcv_date_idx ORDER BY date DESC LIMIT 1`,
    ),
  ])
  const regularSessionRows = rows.filter((row) => isUsMarketTradingDate(row.date))
  return {
    dates: regularSessionRows.slice(0, 400).map((row) => ({
      date: row.date,
      totalTickers: Number(row.total_tickers),
      signalTickers: Number(row.signal_tickers),
    })),
    coverage: {
      horizon,
      firstOutcomeDate: regularSessionRows.at(-1)?.date ?? null,
      latestOutcomeDate: regularSessionRows[0]?.date ?? null,
      availableDates: regularSessionRows.length,
      marketLatestDate: market?.date ?? null,
      classificationAvailability: 'OMITTED_HISTORICAL_PIT_UNAVAILABLE',
    },
  }
}

function queryClauses(input: UsBacktestQuery): {
  where: string[]
  args: unknown[]
  returnColumn: string
} {
  const where = ['r.date = ?', 'r.horizon_days = ?']
  const args: unknown[] = [input.date, input.horizon]
  const returnColumn = input.returnMetric === 'period'
    ? 'r.return_pct'
    : input.returnMetric === 'min' ? 'r.min_return_pct' : 'r.max_return_pct'
  if (input.search) {
    where.push('(UPPER(r.ticker) LIKE ? OR UPPER(COALESCE(r.name, \'\')) LIKE ?)')
    const pattern = `%${input.search.toUpperCase()}%`
    args.push(pattern, pattern)
  }
  if (input.stageCode) {
    where.push('r.pattern_code = ?')
    args.push(input.stageCode)
  }
  if (input.signal) {
    where.push(`(',' || COALESCE(r.signal_codes, '') || ',') LIKE ?`)
    args.push(`%,${input.signal},%`)
  }
  if (input.returnMin != null) {
    where.push(`${returnColumn} >= ?`)
    args.push(input.returnMin)
  }
  if (input.returnMax != null) {
    where.push(`${returnColumn} <= ?`)
    args.push(input.returnMax)
  }
  if (input.targetPct) where.push(`r.hit_${input.targetPct} = 1`)
  return { where, args, returnColumn }
}

const RESULT_COLUMNS = `
  r.date, r.horizon_days, r.ticker, r.name, r.pattern_code,
  r.daily_a_stage, r.daily_b_stage, r.weekly_a_stage, r.weekly_b_stage,
  r.monthly_a_stage, r.monthly_b_stage, r.close, r.volume_ratio_20,
  r.range_pct, r.atr20_pct, r.ma5_pos_pct, r.ma25_pos_pct, r.ma75_pos_pct,
  r.signal_codes, r.return_pct, r.max_return_pct, r.max_return_date,
  r.days_to_max, r.min_return_pct, r.min_return_date, r.days_to_min,
  r.hit_10, r.hit_20, r.hit_40
`

export async function queryUsBacktest(
  input: UsBacktestQuery,
  executor: UsBacktestExecutor = usBacktestExecutor,
) {
  const requestedDate = input.date && isIsoDate(input.date) ? input.date : null
  const latestCandidates = requestedDate ? [] : await executor.all<{ date: string }>(
    `SELECT DISTINCT date FROM serving_backtest_results INDEXED BY serving_backtest_results_horizon_date_idx WHERE horizon_days = ? ORDER BY date DESC LIMIT 16`,
    [input.horizon],
  )
  const date = requestedDate
    ?? latestCandidates.find((candidate) => isUsMarketTradingDate(candidate.date))?.date
    ?? null
  if (!date) {
    return {
      date: null,
      horizon: input.horizon,
      results: [] as UsBacktestResult[],
      summary: { count: 0, withOutcome: 0, hit10Rate: null, hit20Rate: null, hit40Rate: null, avgMaxReturnPct: null, avgMinReturnPct: null, avgDaysToMax: null },
      pagination: { page: 1, pageSize: input.pageSize ?? 50, total: 0, totalPages: 0 },
      source: 'serving_backtest_results' as const,
    }
  }
  const normalized: UsBacktestQuery = { ...input, date }
  const { where, args } = queryClauses(normalized)
  const pageSize = Math.min(100, Math.max(10, Math.trunc(input.pageSize ?? 50)))
  const page = Math.max(1, Math.trunc(input.page ?? 1))
  const offset = (page - 1) * pageSize
  const sort = {
    maxReturn: 'r.max_return_pct IS NULL ASC, r.max_return_pct DESC, r.ticker ASC',
    minReturn: 'r.min_return_pct IS NULL ASC, r.min_return_pct ASC, r.ticker ASC',
    periodReturn: 'r.return_pct IS NULL ASC, r.return_pct DESC, r.ticker ASC',
    volume: 'r.volume_ratio_20 IS NULL ASC, r.volume_ratio_20 DESC, r.ticker ASC',
    ticker: 'r.ticker ASC',
  }[input.sort ?? 'maxReturn']
  const [rows, summary] = await Promise.all([
    executor.all<ResultRow>(
      `SELECT ${RESULT_COLUMNS} FROM serving_backtest_results r WHERE ${where.join(' AND ')} ORDER BY ${sort} LIMIT ? OFFSET ?`,
      [...args, pageSize, offset],
    ),
    executor.get<SummaryRow>(
      `
      SELECT
        COUNT(*) AS count,
        SUM(CASE WHEN r.max_return_pct IS NOT NULL THEN 1 ELSE 0 END) AS with_outcome,
        AVG(CASE WHEN r.max_return_pct IS NOT NULL THEN r.hit_10 END) AS hit_10_rate,
        AVG(CASE WHEN r.max_return_pct IS NOT NULL THEN r.hit_20 END) AS hit_20_rate,
        AVG(CASE WHEN r.max_return_pct IS NOT NULL THEN r.hit_40 END) AS hit_40_rate,
        AVG(r.max_return_pct) AS avg_max_return_pct,
        AVG(r.min_return_pct) AS avg_min_return_pct,
        AVG(r.days_to_max) AS avg_days_to_max
      FROM serving_backtest_results r
      WHERE ${where.join(' AND ')}
      `,
      args,
    ),
  ])
  const total = Number(summary?.count ?? 0)
  return {
    date,
    horizon: input.horizon,
    results: rows.map(resultFromRow),
    summary: {
      count: total,
      withOutcome: Number(summary?.with_outcome ?? 0),
      hit10Rate: finite(summary?.hit_10_rate),
      hit20Rate: finite(summary?.hit_20_rate),
      hit40Rate: finite(summary?.hit_40_rate),
      avgMaxReturnPct: finite(summary?.avg_max_return_pct),
      avgMinReturnPct: finite(summary?.avg_min_return_pct),
      avgDaysToMax: finite(summary?.avg_days_to_max),
    },
    pagination: { page, pageSize, total, totalPages: Math.ceil(total / pageSize) },
    source: 'serving_backtest_results' as const,
  }
}

export async function getUsBacktestDetail(
  input: { ticker: string; date: string; horizon: UsBacktestHorizon; move: 'up' | 'down' },
  executor: UsBacktestExecutor = usBacktestExecutor,
) {
  const row = await executor.get<ResultRow>(
    `SELECT ${RESULT_COLUMNS} FROM serving_backtest_results r WHERE r.ticker = ? AND r.date = ? AND r.horizon_days = ?`,
    [input.ticker, input.date, input.horizon],
  )
  if (!row) return null
  const result = resultFromRow(row)
  const outcomeDate = input.move === 'down' ? result.minReturnDate : result.maxReturnDate
  const rangeEnd = outcomeDate && outcomeDate > input.date ? outcomeDate : input.date
  const [chart, evidence] = await Promise.all([
    executor.all<{
      date: string
      close: number | null
      pattern_code: string | null
    }>(
      `
      SELECT o.date, o.close, mf.pattern_code
      FROM ohlcv_daily o
      LEFT JOIN model_features mf ON mf.ticker = o.ticker AND mf.date = o.date
      WHERE o.ticker = ? AND o.date BETWEEN date(?, '-120 days') AND ?
      ORDER BY o.date
      `,
      [input.ticker, input.date, rangeEnd],
    ),
    result.signalCodes.length === 0
      ? Promise.resolve([])
      : executor.all<{ signal_code: string; label: string | null; reason_json: string }>(
        `
        SELECT signal_code, label, reason_json
        FROM serving_signal_evidence
        WHERE ticker = ? AND date = ? AND signal_code IN (${result.signalCodes.map(() => '?').join(', ')})
        ORDER BY signal_code
        `,
        [input.ticker, input.date, ...result.signalCodes],
      ),
  ])
  return {
    result,
    move: input.move,
    selectedOutcome: input.move === 'down'
      ? { returnPct: result.minReturnPct, date: result.minReturnDate, sessions: result.daysToMin }
      : { returnPct: result.maxReturnPct, date: result.maxReturnDate, sessions: result.daysToMax },
    chart: chart.map((point) => ({
      date: point.date,
      close: finite(point.close),
      stageCode: point.pattern_code,
    })),
    evidence: evidence.map((item) => {
      let reason: unknown = null
      try { reason = JSON.parse(item.reason_json) } catch { reason = null }
      return { signalCode: item.signal_code, label: item.label, reason }
    }),
    source: 'serving_backtest_results' as const,
    generatedNarrative: false,
  }
}
