import { execAll, execGet, type Args } from '@/lib/db/client'
import { universeSqlCondition } from '@/lib/market-universe'
import {
  STAGE_TRANSITION_AVERAGE_SESSIONS,
  STAGE_TRANSITION_MAX_CUSTOM_DAYS,
  changedStageCodeAxes,
  inclusiveCalendarDays,
  isIsoDate,
  isStageCode,
  isStageCodeFilter,
  startOfMonth,
  startOfWeek,
  type StageTransitionRow,
  type StageTransitionSearchInput,
  type StageTransitionSort,
} from '@/lib/stage-transition-scanner'

export interface StageTransitionQueryExecutor {
  all<T>(sql: string, args?: readonly unknown[]): Promise<T[]>
  get<T>(sql: string, args?: readonly unknown[]): Promise<T | undefined>
}

const defaultExecutor: StageTransitionQueryExecutor = {
  all: (sql, args = []) => execAll(sql, args as Args),
  get: (sql, args = []) => execGet(sql, args as Args),
}

export interface StageTransitionResolvedRange {
  latestDate: string
  requestedStartDate: string
  requestedEndDate: string
  startDate: string
  endDate: string
  previousMarketDate: string | null
}

export interface StageTransitionFilterOptions {
  industries33: string[]
  marketSegments: string[]
}

export interface StageTransitionSearchResult {
  rows: StageTransitionRow[]
  total: number
  page: number
  pageSize: number
  totalPages: number
  range: StageTransitionResolvedRange
}

type RawTransitionRow = {
  ticker: string
  name: string | null
  transition_date: string
  from_code: string
  to_code: string
  sector33_name: string | null
  market_segment: string | null
  close: number | null
  avg_volume: number | null
  avg_turnover: number | null
  total_count: number
}

const SORT_SQL: Record<StageTransitionSort, string> = {
  date: 'transition_date',
  ticker: 'ticker',
  industry: 'sector33_name',
  price: 'close',
  avgVolume: 'avg_volume',
  avgTurnover: 'avg_turnover',
}

const STAGE_COLUMNS = [
  'daily_a_stage',
  'daily_b_stage',
  'weekly_a_stage',
  'weekly_b_stage',
  'monthly_a_stage',
  'monthly_b_stage',
] as const

function stageCodeSql(alias: string) {
  return `CASE
  WHEN ${alias}.daily_a_stage BETWEEN 1 AND 6
   AND ${alias}.daily_b_stage BETWEEN 1 AND 6
   AND ${alias}.weekly_a_stage BETWEEN 1 AND 6
   AND ${alias}.weekly_b_stage BETWEEN 1 AND 6
   AND ${alias}.monthly_a_stage BETWEEN 1 AND 6
   AND ${alias}.monthly_b_stage BETWEEN 1 AND 6
  THEN printf('%d%d%d%d%d%d',
    ${alias}.daily_a_stage, ${alias}.daily_b_stage, ${alias}.weekly_a_stage,
    ${alias}.weekly_b_stage, ${alias}.monthly_a_stage, ${alias}.monthly_b_stage
  )
END`
}

export class StageTransitionInputError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message)
    this.name = 'StageTransitionInputError'
  }
}

export async function resolveStageTransitionRange(
  input: Pick<StageTransitionSearchInput, 'period' | 'customFrom' | 'customTo'>,
  executor: StageTransitionQueryExecutor = defaultExecutor,
): Promise<StageTransitionResolvedRange> {
  const latest = await executor.get<{ date: string | null }>(
    'SELECT MAX(date) AS date FROM daily_snapshots',
  )
  if (!latest?.date) throw new StageTransitionInputError('stage_data_unavailable', 'ステージ履歴がありません。')

  let requestedEndDate = latest.date
  let requestedStartDate = latest.date
  if (input.period === 'week') requestedStartDate = startOfWeek(latest.date)
  if (input.period === 'month') requestedStartDate = startOfMonth(latest.date)
  if (input.period === 'custom') {
    if (!input.customFrom || !input.customTo || !isIsoDate(input.customFrom) || !isIsoDate(input.customTo)) {
      throw new StageTransitionInputError('custom_range_required', '期間指定には開始日と終了日が必要です。')
    }
    if (input.customFrom > input.customTo) {
      throw new StageTransitionInputError('custom_range_reversed', '終了日は開始日以降にしてください。')
    }
    if (inclusiveCalendarDays(input.customFrom, input.customTo) > STAGE_TRANSITION_MAX_CUSTOM_DAYS) {
      throw new StageTransitionInputError(
        'custom_range_too_large',
        `期間指定は${STAGE_TRANSITION_MAX_CUSTOM_DAYS}日以内にしてください。`,
      )
    }
    requestedStartDate = input.customFrom
    requestedEndDate = input.customTo
  }

  const end = await executor.get<{ date: string | null }>(
    'SELECT MAX(date) AS date FROM daily_snapshots WHERE date <= ?',
    [requestedEndDate],
  )
  if (!end?.date) throw new StageTransitionInputError('range_unavailable', '指定期間のステージ履歴がありません。')

  const start = await executor.get<{ date: string | null }>(
    'SELECT MIN(date) AS date FROM daily_snapshots WHERE date >= ? AND date <= ?',
    [requestedStartDate, end.date],
  )
  if (!start?.date) throw new StageTransitionInputError('range_unavailable', '指定期間のステージ履歴がありません。')
  const previous = await executor.get<{ date: string | null }>(
    'SELECT MAX(date) AS date FROM daily_snapshots WHERE date < ?',
    [start.date],
  )

  return {
    latestDate: latest.date,
    requestedStartDate,
    requestedEndDate,
    startDate: start.date,
    endDate: end.date,
    previousMarketDate: previous?.date ?? null,
  }
}

export async function getStageTransitionFilterOptions(
  executor: StageTransitionQueryExecutor = defaultExecutor,
): Promise<StageTransitionFilterOptions> {
  const [industries, markets] = await Promise.all([
    executor.all<{ value: string }>(
      `SELECT DISTINCT sector33_name AS value
       FROM ticker_universe
       WHERE active = 1 AND sector33_name IS NOT NULL AND TRIM(sector33_name) <> ''
       ORDER BY sector33_name`,
    ),
    executor.all<{ value: string }>(
      `SELECT DISTINCT market_segment AS value
       FROM ticker_universe
       WHERE active = 1 AND market_segment IS NOT NULL AND TRIM(market_segment) <> ''
       ORDER BY market_segment`,
    ),
  ])
  return {
    industries33: industries.map((row) => row.value),
    marketSegments: markets.map((row) => row.value),
  }
}

function assertSearchInput(input: StageTransitionSearchInput) {
  if (!isStageCodeFilter(input.fromCode) || !isStageCodeFilter(input.toCode)) {
    throw new StageTransitionInputError('invalid_stage_code', '6桁すべてに1〜6の数字を入力するか、Anyを指定してください。')
  }
  if (isStageCode(input.fromCode) && input.fromCode === input.toCode) {
    throw new StageTransitionInputError('unchanged_stage_code', '遷移前と遷移後には異なるコードを指定してください。')
  }
  const ranges: Array<[number | null, number | null, string]> = [
    [input.minPrice, input.maxPrice, '株価'],
    [input.minAvgVolume, input.maxAvgVolume, '平均出来高'],
    [input.minAvgTurnover, input.maxAvgTurnover, '平均売買代金'],
  ]
  for (const [min, max, label] of ranges) {
    if ((min != null && (!Number.isFinite(min) || min < 0)) || (max != null && (!Number.isFinite(max) || max < 0))) {
      throw new StageTransitionInputError('invalid_numeric_filter', `${label}には0以上の数値を入力してください。`)
    }
    if (min != null && max != null && min > max) {
      throw new StageTransitionInputError('reversed_numeric_filter', `${label}の下限は上限以下にしてください。`)
    }
  }
  if (!Number.isInteger(input.page) || input.page < 1) {
    throw new StageTransitionInputError('invalid_page', 'ページ番号が不正です。')
  }
  if (![25, 50, 100].includes(input.pageSize)) {
    throw new StageTransitionInputError('invalid_page_size', '表示件数が不正です。')
  }
}

export function buildStageTransitionSearchSql(
  input: StageTransitionSearchInput,
  range: StageTransitionResolvedRange,
): { sql: string; args: unknown[] } {
  const toIsExact = isStageCode(input.toCode)
  const fromIsExact = isStageCode(input.fromCode)
  const args: unknown[] = []
  const universe = universeSqlCondition('current.ticker', input.universeFilter)
  const currentConditions = toIsExact
    ? STAGE_COLUMNS.map((column) => `current.${column} = ?`)
    : [`${stageCodeSql('current')} IS NOT NULL`]
  if (toIsExact) args.push(...[...input.toCode].map(Number))
  args.push(range.startDate, range.endDate)
  args.push(...universe.params)
  const previousConditions = fromIsExact
    ? STAGE_COLUMNS.map((column) => `previous.${column} = ?`)
    : [`${stageCodeSql('previous')} IS NOT NULL`]
  if (fromIsExact) args.push(...[...input.fromCode].map(Number))
  const filters: string[] = []
  const addFilter = (sql: string, value: unknown) => {
    filters.push(sql)
    args.push(value)
  }
  if (input.industry33) addFilter('sector33_name = ?', input.industry33)
  if (input.marketSegment) addFilter('market_segment = ?', input.marketSegment)
  if (input.minPrice != null) addFilter('close >= ?', input.minPrice)
  if (input.maxPrice != null) addFilter('close <= ?', input.maxPrice)
  if (input.minAvgVolume != null) addFilter('avg_volume >= ?', input.minAvgVolume)
  if (input.maxAvgVolume != null) addFilter('avg_volume <= ?', input.maxAvgVolume)
  if (input.minAvgTurnover != null) addFilter('avg_turnover >= ?', input.minAvgTurnover)
  if (input.maxAvgTurnover != null) addFilter('avg_turnover <= ?', input.maxAvgTurnover)

  const sortColumn = SORT_SQL[input.sort]
  const direction = input.direction === 'asc' ? 'ASC' : 'DESC'
  const orderSql = input.sort === 'date'
    ? `transition_date ${direction}, ticker ASC`
    : `${sortColumn} IS NULL ASC, ${sortColumn} ${direction}, transition_date DESC, ticker ASC`
  args.push(input.pageSize, (input.page - 1) * input.pageSize)

  return {
    sql: `WITH current_candidates AS MATERIALIZED (
      SELECT current.ticker,
             current.date AS transition_date,
             ${stageCodeSql('current')} AS to_code
      FROM daily_snapshots AS current
      WHERE ${currentConditions.join('\n        AND ')}
        AND current.date BETWEEN ? AND ?
        ${universe.sql ? `AND ${universe.sql}` : ''}
    ),
    transitions AS (
      SELECT current.ticker,
             current.transition_date,
             ${stageCodeSql('previous')} AS from_code,
             current.to_code
      FROM current_candidates AS current
      JOIN daily_snapshots AS previous
        ON previous.ticker = current.ticker
       AND previous.date = (
         SELECT MAX(prior.date)
         FROM daily_snapshots AS prior
         WHERE prior.ticker = current.ticker
           AND prior.date < current.transition_date
       )
      WHERE ${previousConditions.join('\n        AND ')}
        AND ${stageCodeSql('previous')} <> current.to_code
    ),
    enriched AS MATERIALIZED (
      SELECT transitions.ticker,
             COALESCE(NULLIF(TRIM(ticker_universe.name), ''), transitions.ticker) AS name,
             transitions.transition_date,
             transitions.from_code,
             transitions.to_code,
             ticker_universe.sector33_name,
             ticker_universe.market_segment,
             event_price.close,
             (
               SELECT AVG(recent.volume)
               FROM (
                 SELECT volume
                 FROM ohlcv_daily
                 WHERE ticker = transitions.ticker
                   AND date <= transitions.transition_date
                 ORDER BY date DESC
                 LIMIT ${STAGE_TRANSITION_AVERAGE_SESSIONS}
               ) AS recent
             ) AS avg_volume,
             (
               SELECT AVG(recent.close * recent.volume)
               FROM (
                 SELECT close, volume
                 FROM ohlcv_daily
                 WHERE ticker = transitions.ticker
                   AND date <= transitions.transition_date
                 ORDER BY date DESC
                 LIMIT ${STAGE_TRANSITION_AVERAGE_SESSIONS}
               ) AS recent
             ) AS avg_turnover
      FROM transitions
      LEFT JOIN ticker_universe ON ticker_universe.ticker = transitions.ticker
      LEFT JOIN ohlcv_daily AS event_price
        ON event_price.ticker = transitions.ticker
       AND event_price.date = transitions.transition_date
      WHERE ticker_universe.active = 1
    ),
    filtered AS (
      SELECT *
      FROM enriched
      ${filters.length > 0 ? `WHERE ${filters.join(' AND ')}` : ''}
    )
    SELECT *, COUNT(*) OVER () AS total_count
    FROM filtered
    ORDER BY ${orderSql}
    LIMIT ? OFFSET ?`,
    args,
  }
}

export async function searchStageTransitions(
  input: StageTransitionSearchInput,
  executor: StageTransitionQueryExecutor = defaultExecutor,
): Promise<StageTransitionSearchResult> {
  assertSearchInput(input)
  const range = await resolveStageTransitionRange(input, executor)
  const query = buildStageTransitionSearchSql(input, range)
  const rows = await executor.all<RawTransitionRow>(query.sql, query.args)
  let total = Number(rows[0]?.total_count ?? 0)

  // COUNT(*) OVER() has no row to carry the count when OFFSET is past the last
  // page. Re-read a single first-page row only for that exceptional URL state so
  // the UI can preserve the real total and offer a return to page 1.
  if (rows.length === 0 && input.page > 1) {
    const countCarrierQuery = buildStageTransitionSearchSql(
      { ...input, page: 1, pageSize: 25 },
      range,
    )
    const countCarrier = await executor.all<RawTransitionRow>(countCarrierQuery.sql, countCarrierQuery.args)
    total = Number(countCarrier[0]?.total_count ?? 0)
  }
  return {
    rows: rows.map((row) => ({
      ticker: row.ticker,
      name: row.name ?? row.ticker,
      transitionDate: row.transition_date,
      fromCode: row.from_code,
      toCode: row.to_code,
      changedAxes: changedStageCodeAxes(row.from_code, row.to_code),
      sector33: row.sector33_name,
      marketSegment: row.market_segment,
      price: row.close == null ? null : Number(row.close),
      averageVolume20: row.avg_volume == null ? null : Number(row.avg_volume),
      averageTurnover20: row.avg_turnover == null ? null : Number(row.avg_turnover),
    })),
    total,
    page: input.page,
    pageSize: input.pageSize,
    totalPages: total === 0 ? 0 : Math.ceil(total / input.pageSize),
    range,
  }
}
