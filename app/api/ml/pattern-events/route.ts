import { NextRequest, NextResponse } from 'next/server'
import { execAll } from '@/lib/db/client'
import { ML_PHYSICS_FEATURE_SET } from '@/lib/backtest/ml-physics'
import { parseUniverseFilter, universeSqlCondition, UNIVERSE_FILTER_PARAM, type UniverseFilterValue } from '@/lib/market-universe'

export const dynamic = 'force-dynamic'
export const maxDuration = 30

type Direction = 'up' | 'down'

type RawEventRow = {
  ticker: string
  date: string
  name: string | null
  market_segment: string | null
  sector17_name: string | null
  sector33_name: string | null
  horizon_days: number
  return_pct: number | null
  end_date: string | null
  max_return_pct: number | null
  max_return_date: string | null
  days_to_max: number | null
  min_return_pct: number | null
  min_return_date: string | null
  days_to_min: number | null
  pattern_start_date: string | null
  pattern_end_date: string | null
}

const EXISTING_HORIZONS = new Set([5, 10, 15, 20, 30, 40, 60, 90, 180, 200])
const MAX_HORIZON_DAYS = 200
const MAX_LIMIT = 200

function badRequest(message: string, status = 400) {
  return NextResponse.json({ error: 'invalid_request', message }, { status })
}

function direction(value: string | null): Direction | null {
  return value === 'up' || value === 'down' ? value : null
}

function positiveNumber(value: string | null): number | null {
  const parsed = Number(value ?? '')
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null
}

function positiveInteger(value: string | null): number | null {
  const parsed = Number(value ?? '')
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null
}

function dateParam(value: string | null): string | null {
  const trimmed = value?.trim()
  return trimmed && /^\d{4}-\d{2}-\d{2}$/.test(trimmed) ? trimmed : null
}

function patternRowsForHorizon(horizonDays: number): number {
  return Math.min(30, Math.max(5, horizonDays))
}

function maxCalendarDaysForHorizon(horizonDays: number): number {
  return Math.ceil(horizonDays * 3)
}

function mapEvent(row: RawEventRow, directionValue: Direction, thresholdPct: number) {
  const movePct = directionValue === 'up' ? row.max_return_pct : row.min_return_pct
  const reachedDate = directionValue === 'up' ? row.max_return_date : row.min_return_date
  const reachedDays = directionValue === 'up' ? row.days_to_max : row.days_to_min
  return {
    ticker: row.ticker,
    name: row.name,
    marketSegment: row.market_segment,
    sector17Name: row.sector17_name,
    sector33Name: row.sector33_name,
    sourceDate: row.date,
    horizonDays: Number(row.horizon_days),
    direction: directionValue,
    thresholdPct,
    returnPct: row.return_pct,
    endDate: row.end_date,
    maxReturnPct: row.max_return_pct,
    maxReturnDate: row.max_return_date,
    daysToMax: row.days_to_max,
    minReturnPct: row.min_return_pct,
    minReturnDate: row.min_return_date,
    daysToMin: row.days_to_min,
    reachedPct: movePct,
    reachedDate,
    reachedDays,
    patternStartDate: row.pattern_start_date ?? row.date,
    patternEndDate: row.pattern_end_date ?? row.date,
  }
}

async function attachPatternWindows(rows: RawEventRow[], patternRows: number): Promise<RawEventRow[]> {
  if (rows.length === 0) return rows
  const values = rows.map(() => '(?, ?)').join(', ')
  const args: Array<string | number> = rows.flatMap((row) => [row.ticker, row.date])
  args.push(ML_PHYSICS_FEATURE_SET, patternRows)
  const windows = await execAll<{ ticker: string; date: string; pattern_start_date: string | null }>(
    `
    WITH selected(ticker, date) AS (
      VALUES ${values}
    ),
    ranked AS (
      SELECT
        s.ticker,
        s.date,
        fv.date AS feature_date,
        ROW_NUMBER() OVER (PARTITION BY s.ticker, s.date ORDER BY fv.date DESC) AS rn
      FROM selected s
      INNER JOIN ml_feature_vectors_v2 fv
        ON fv.feature_set = ?
       AND fv.ticker = s.ticker
       AND fv.date <= s.date
    )
    SELECT ticker, date, MIN(feature_date) AS pattern_start_date
    FROM ranked
    WHERE rn <= ?
    GROUP BY ticker, date
    `,
    args,
  )
  const byKey = new Map(windows.map((row) => [`${row.ticker}\u0000${row.date}`, row.pattern_start_date]))
  return rows.map((row) => ({
    ...row,
    pattern_start_date: byKey.get(`${row.ticker}\u0000${row.date}`) ?? row.pattern_start_date ?? row.date,
    pattern_end_date: row.pattern_end_date ?? row.date,
  }))
}

async function existingHorizonEvents(
  directionValue: Direction,
  horizonDays: number,
  thresholdPct: number,
  startDate: string | null,
  endDate: string | null,
  limit: number,
  universeFilter: UniverseFilterValue,
) {
  const patternRows = patternRowsForHorizon(horizonDays)
  const maxCalendarDays = maxCalendarDaysForHorizon(horizonDays)
  const where = ['fe.horizon_days = ?', "COALESCE(u.market_segment, '') <> 'その他'"]
  const args: Array<string | number> = [ML_PHYSICS_FEATURE_SET, horizonDays]
  if (startDate) {
    where.push('fe.date >= ?')
    args.push(startDate)
  }
  if (endDate) {
    where.push('fe.date <= ?')
    args.push(endDate)
  }
  const universe = universeSqlCondition('fe.ticker', universeFilter)
  if (universe.sql) {
    where.push(universe.sql)
    args.push(...universe.params)
  }
  if (directionValue === 'up') {
    where.push('fe.max_return_pct >= ?')
    args.push(thresholdPct)
    where.push('fe.max_return_date IS NOT NULL')
    where.push('julianday(fe.max_return_date) - julianday(fe.date) <= ?')
    args.push(maxCalendarDays)
  } else {
    where.push('fe.min_return_pct <= ?')
    args.push(-thresholdPct)
    where.push('fe.min_return_date IS NOT NULL')
    where.push('julianday(fe.min_return_date) - julianday(fe.date) <= ?')
    args.push(maxCalendarDays)
  }
  where.push('fe.end_date IS NOT NULL')
  where.push('julianday(fe.end_date) - julianday(fe.date) <= ?')
  args.push(maxCalendarDays)
  args.push(limit)

  const rows = await execAll<RawEventRow>(
    `
    SELECT
      fe.ticker,
      fe.date,
      u.name,
      u.market_segment,
      u.sector17_name,
      u.sector33_name,
      fe.horizon_days,
      fe.return_pct,
      fe.end_date,
      fe.max_return_pct,
      fe.max_return_date,
      fe.days_to_max,
      fe.min_return_pct,
      fe.min_return_date,
      fe.days_to_min,
      NULL AS pattern_start_date,
      fe.date AS pattern_end_date
    FROM forward_extrema fe INDEXED BY fext_horizon_date_idx
    INNER JOIN ml_feature_vectors_v2 f
      ON f.feature_set = ?
     AND f.ticker = fe.ticker
     AND f.date = fe.date
    LEFT JOIN ticker_universe u ON u.ticker = fe.ticker
    WHERE ${where.join(' AND ')}
    ORDER BY fe.date DESC
    LIMIT ?
    `,
    args,
  )
  const rowsWithWindows = await attachPatternWindows(rows, patternRows)
  return rowsWithWindows.map((row) => mapEvent(row, directionValue, thresholdPct))
}

async function arbitraryHorizonEvents(
  directionValue: Direction,
  horizonDays: number,
  thresholdPct: number,
  startDate: string | null,
  endDate: string | null,
  limit: number,
  universeFilter: UniverseFilterValue,
) {
  const patternRows = patternRowsForHorizon(horizonDays)
  const maxCalendarDays = maxCalendarDaysForHorizon(horizonDays)
  const scanLimit = Math.min(30_000, Math.max(5_000, limit * 150))
  const dateWhere: string[] = []
  const args: Array<string | number> = [ML_PHYSICS_FEATURE_SET]
  if (startDate) {
    dateWhere.push('f.date >= ?')
    args.push(startDate)
  }
  if (endDate) {
    dateWhere.push('f.date <= ?')
    args.push(endDate)
  }
  const universe = universeSqlCondition('f.ticker', universeFilter)
  args.push(...universe.params)
  args.push(thresholdPct, thresholdPct, -thresholdPct, -thresholdPct, horizonDays)
  args.push(directionValue === 'up' ? thresholdPct : -thresholdPct, limit)

  const rows = await execAll<RawEventRow>(
    `
    WITH valid_cutoff AS (
      SELECT date
      FROM (
        SELECT DISTINCT date
        FROM ohlcv_daily
        ORDER BY date DESC
        LIMIT ${horizonDays + 1}
      )
      ORDER BY date ASC
      LIMIT 1
    ),
    base AS (
      SELECT
        f.ticker,
        f.date,
        u.name,
        u.market_segment,
        u.sector17_name,
        u.sector33_name,
        o.close,
        f.date AS pattern_start_date
      FROM ml_feature_vectors_v2 f
      INNER JOIN ohlcv_daily o ON o.ticker = f.ticker AND o.date = f.date
      LEFT JOIN ticker_universe u ON u.ticker = f.ticker
      WHERE f.feature_set = ?
        AND f.date <= (SELECT date FROM valid_cutoff)
        AND COALESCE(u.market_segment, '') <> 'その他'
        ${dateWhere.length > 0 ? `AND ${dateWhere.join(' AND ')}` : ''}
        ${universe.sql ? `AND ${universe.sql}` : ''}
      ORDER BY f.date DESC, f.ticker
      LIMIT ${scanLimit}
    ),
    future AS (
      SELECT
        base.*,
        o.date AS future_date,
        ROW_NUMBER() OVER (PARTITION BY base.ticker, base.date ORDER BY o.date) AS rn,
        ((o.high - base.close) / base.close) * 100 AS high_return,
        ((o.low - base.close) / base.close) * 100 AS low_return,
        ((o.close - base.close) / base.close) * 100 AS close_return
      FROM base
      INNER JOIN ohlcv_daily o ON o.ticker = base.ticker AND o.date > base.date
      WHERE base.close IS NOT NULL AND base.close > 0
        AND julianday(o.date) - julianday(base.date) <= ${maxCalendarDays}
    ),
    agg AS (
      SELECT
        ticker,
        date,
        name,
        market_segment,
        sector17_name,
        sector33_name,
        ${horizonDays} AS horizon_days,
        MAX(CASE WHEN rn = ${horizonDays} THEN close_return END) AS return_pct,
        MAX(CASE WHEN rn = ${horizonDays} THEN future_date END) AS end_date,
        MAX(high_return) AS max_return_pct,
        MIN(low_return) AS min_return_pct,
        MIN(CASE WHEN high_return >= ? THEN future_date END) AS max_return_date,
        MIN(CASE WHEN high_return >= ? THEN rn END) AS days_to_max,
        MIN(CASE WHEN low_return <= ? THEN future_date END) AS min_return_date,
        MIN(CASE WHEN low_return <= ? THEN rn END) AS days_to_min,
        pattern_start_date,
        date AS pattern_end_date,
        COUNT(*) AS future_count
      FROM future
      WHERE rn <= ${horizonDays}
      GROUP BY ticker, date
    )
    SELECT
      ticker,
      date,
      name,
      market_segment,
      sector17_name,
      sector33_name,
      horizon_days,
      return_pct,
      end_date,
      max_return_pct,
      max_return_date,
      days_to_max,
      min_return_pct,
      min_return_date,
      days_to_min,
      pattern_start_date,
      pattern_end_date
    FROM agg
    WHERE future_count >= ?
      AND ${directionValue === 'up' ? 'max_return_pct >= ?' : 'min_return_pct <= ?'}
    ORDER BY date DESC
    LIMIT ?
    `,
    args,
  )
  const rowsWithWindows = await attachPatternWindows(rows, patternRows)
  return rowsWithWindows.map((row) => mapEvent(row, directionValue, thresholdPct))
}

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url)
    const directionValue = direction(searchParams.get('direction'))
    if (!directionValue) return badRequest('direction must be up or down')

    const horizonDays = positiveInteger(searchParams.get('horizonDays') ?? searchParams.get('horizon'))
    if (!horizonDays || horizonDays > MAX_HORIZON_DAYS) {
      return badRequest(`horizonDays must be between 1 and ${MAX_HORIZON_DAYS}`)
    }

    const thresholdPct = positiveNumber(searchParams.get('thresholdPct') ?? searchParams.get('threshold'))
    if (!thresholdPct) return badRequest('thresholdPct must be a positive number')

    const startDate = dateParam(searchParams.get('startDate'))
    const endDate = dateParam(searchParams.get('endDate'))
    if (startDate && endDate && startDate > endDate) return badRequest('startDate must be before endDate')

    const rawLimit = positiveInteger(searchParams.get('limit'))
    const limit = Math.min(MAX_LIMIT, Math.max(1, rawLimit ?? 40))
    const universeFilter = parseUniverseFilter(searchParams.get(UNIVERSE_FILTER_PARAM))
    const source = EXISTING_HORIZONS.has(horizonDays) ? 'forward_extrema' : 'ohlcv_ondemand'
    const events = source === 'forward_extrema'
      ? await existingHorizonEvents(directionValue, horizonDays, thresholdPct, startDate, endDate, limit, universeFilter)
      : await arbitraryHorizonEvents(directionValue, horizonDays, thresholdPct, startDate, endDate, limit, universeFilter)

    return NextResponse.json({
      direction: directionValue,
      horizonDays,
      thresholdPct,
      startDate,
      endDate,
      source,
      filters: { universe: universeFilter },
      count: events.length,
      events,
    })
  } catch (error) {
    console.error('pattern events API error:', error)
    return NextResponse.json(
      { error: 'pattern_events_failed', message: (error as Error).message },
      { status: 500 },
    )
  }
}
