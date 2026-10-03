import { NextRequest, NextResponse } from 'next/server'
import { execAll, execGet, isCloud, type Args } from '@/lib/db/client'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

type BacktestRow = {
  date: string
  ticker: string
  name: string | null
  sector_large: string | null
  sector_small: string | null
  sector17_name: string | null
  sector33_name: string | null
  market_segment: string | null
  margin_type: string | null
  pattern_code: string | null
  daily_a_stage: number | null
  daily_b_stage: number | null
  weekly_a_stage: number | null
  weekly_b_stage: number | null
  monthly_a_stage: number | null
  monthly_b_stage: number | null
  open: number | null
  high: number | null
  low: number | null
  close: number | null
  volume: number | null
  volume_ratio_20: number | null
  range_pct: number | null
  atr20_pct: number | null
  ma5_pos_pct: number | null
  ma25_pos_pct: number | null
  ma75_pos_pct: number | null
  signal_codes: string | null
  horizon_days: number | null
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

const STAGE_PARAMS: Record<string, string> = {
  daily_a: 'mf.daily_a_stage',
  daily_b: 'mf.daily_b_stage',
  weekly_a: 'mf.weekly_a_stage',
  weekly_b: 'mf.weekly_b_stage',
  monthly_a: 'mf.monthly_a_stage',
  monthly_b: 'mf.monthly_b_stage',
}

const SORTS: Record<string, string> = {
  maxReturn: 'fe.max_return_pct DESC',
  return: 'fe.return_pct DESC',
  drawdown: 'fe.min_return_pct ASC',
  volume: 'mf.volume_ratio_20 DESC',
  ticker: 'mf.ticker ASC',
}

const SERVING_SORTS: Record<string, string> = {
  maxReturn: 'sr.max_return_pct DESC',
  return: 'sr.return_pct DESC',
  drawdown: 'sr.min_return_pct ASC',
  volume: 'sr.volume_ratio_20 DESC',
  ticker: 'sr.ticker ASC',
}

function numParam(params: URLSearchParams, key: string): number | null {
  const raw = params.get(key)
  if (!raw) return null
  const value = Number(raw)
  return Number.isFinite(value) ? value : null
}

function intList(raw: string | null): number[] {
  if (!raw) return []
  return raw
    .split(',')
    .map((value) => Number(value.trim()))
    .filter((value) => Number.isInteger(value) && value >= 1 && value <= 6)
}

async function latestOutcomeDate(horizon: number): Promise<string | null> {
  const serving = await execGet<{ date: string | null }>(
    `SELECT MAX(date) AS date FROM serving_backtest_results WHERE horizon_days = ?`,
    [horizon],
  )
  if (serving?.date) return serving.date

  return (await execGet<{ date: string | null }>(
    `
    SELECT MAX(mf.date) AS date
    FROM model_features mf
    WHERE EXISTS (
      SELECT 1 FROM forward_extrema fe
      WHERE fe.ticker = mf.ticker AND fe.date = mf.date AND fe.horizon_days = ?
    )
    `,
    [horizon],
  ))?.date ?? null
}

async function hasServingResults(date: string, horizon: number): Promise<boolean> {
  const row = await execGet<{ count: number }>(
    `SELECT COUNT(*) AS count FROM serving_backtest_results WHERE date = ? AND horizon_days = ? LIMIT 1`,
    [date, horizon],
  )
  return Number(row?.count ?? 0) > 0
}

function compactSignals(signalCodes: string | null): string[] {
  if (!signalCodes) return []
  return signalCodes.split(',').map((code) => code.trim()).filter(Boolean)
}

function summarize(rows: BacktestRow[]) {
  const valid = rows.filter((row) => row.max_return_pct != null)
  const avg = (values: number[]) => values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length
  return {
    count: rows.length,
    withOutcome: valid.length,
    hit10Rate: avg(valid.map((row) => row.hit_10 ? 1 : 0)),
    hit20Rate: avg(valid.map((row) => row.hit_20 ? 1 : 0)),
    hit40Rate: avg(valid.map((row) => row.hit_40 ? 1 : 0)),
    avgMaxReturnPct: avg(valid.map((row) => Number(row.max_return_pct))),
    avgMinReturnPct: avg(valid.map((row) => Number(row.min_return_pct))),
    avgDaysToMax: avg(valid.map((row) => Number(row.days_to_max)).filter(Number.isFinite)),
  }
}

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url)
    const horizon = Number(searchParams.get('horizon') ?? 40)
    const safeHorizon = [5, 20, 30, 40, 60, 90, 180, 200].includes(horizon) ? horizon : 40
    const date = searchParams.get('date') ?? await latestOutcomeDate(safeHorizon)
    if (!date) {
      return NextResponse.json({
        date: null,
        horizon: safeHorizon,
        results: [],
        summary: summarize([]),
        notice: '過去検証用の model_features が未作成です。batch:weekly-ohlcv → batch:forward-extrema → batch:technical-signals を実行してください。',
      })
    }
    const limit = Math.min(1000, Math.max(1, Number(searchParams.get('limit') ?? 300)))
    const returnMin = numParam(searchParams, 'returnMin')
    const returnMax = numParam(searchParams, 'returnMax')
    const returnMetric = searchParams.get('returnMetric') === 'period' ? 'period' : 'max'
    const returnColumn = returnMetric === 'period' ? 'fe.return_pct' : 'fe.max_return_pct'
    const targetPct = numParam(searchParams, 'targetPct')
    const sector = searchParams.get('sector')?.trim()
    const sector17 = searchParams.get('sector17')?.trim()
    const sector33 = searchParams.get('sector33')?.trim()
    const signalFilter = (searchParams.get('signals') ?? '')
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean)
    const sortKey = searchParams.get('sort') ?? ''
    const sort = SORTS[sortKey] ?? SORTS.maxReturn
    const servingSort = SERVING_SORTS[sortKey] ?? SERVING_SORTS.maxReturn

    const where: string[] = ['mf.date = ?', 'fe.horizon_days = ?']
    const args: Args = [date, safeHorizon]

    if (returnMin != null) {
      where.push(`${returnColumn} >= ?`)
      ;(args as unknown[]).push(returnMin)
    }
    if (returnMax != null) {
      where.push(`${returnColumn} <= ?`)
      ;(args as unknown[]).push(returnMax)
    }
    if (targetPct === 10 || targetPct === 20 || targetPct === 40) {
      where.push(`fe.hit_${targetPct} = 1`)
    }
    if (sector) {
      where.push('(sm.sector_large = ? OR sm.sector_small = ? OR sm.sector33 = ? OR u.sector17_name = ? OR u.sector33_name = ?)')
      ;(args as unknown[]).push(sector, sector, sector, sector, sector)
    }
    if (sector17) {
      where.push('u.sector17_name = ?')
      ;(args as unknown[]).push(sector17)
    }
    if (sector33) {
      where.push('u.sector33_name = ?')
      ;(args as unknown[]).push(sector33)
    }
    for (const [param, col] of Object.entries(STAGE_PARAMS)) {
      const vals = intList(searchParams.get(param))
      if (vals.length > 0) {
        where.push(`${col} IN (${vals.map(() => '?').join(', ')})`)
        ;(args as unknown[]).push(...vals)
      }
    }
    for (const signal of signalFilter) {
      where.push(`(',' || COALESCE(mf.signal_codes, '') || ',') LIKE ?`)
      ;(args as unknown[]).push(`%,${signal},%`)
    }

    const useServing = await hasServingResults(date, safeHorizon)
    if (useServing || isCloud) {
      const servingWhere: string[] = ['sr.date = ?', 'sr.horizon_days = ?']
      const servingArgs: Args = [date, safeHorizon]

      if (returnMin != null) {
        servingWhere.push(`${returnMetric === 'period' ? 'sr.return_pct' : 'sr.max_return_pct'} >= ?`)
        ;(servingArgs as unknown[]).push(returnMin)
      }
      if (returnMax != null) {
        servingWhere.push(`${returnMetric === 'period' ? 'sr.return_pct' : 'sr.max_return_pct'} <= ?`)
        ;(servingArgs as unknown[]).push(returnMax)
      }
      if (targetPct === 10 || targetPct === 20 || targetPct === 40) {
        servingWhere.push(`sr.hit_${targetPct} = 1`)
      }
      if (sector) {
        servingWhere.push('(sr.sector_large = ? OR sr.sector_small = ? OR u.sector17_name = ? OR u.sector33_name = ?)')
        ;(servingArgs as unknown[]).push(sector, sector, sector, sector)
      }
      if (sector17) {
        servingWhere.push('u.sector17_name = ?')
        ;(servingArgs as unknown[]).push(sector17)
      }
      if (sector33) {
        servingWhere.push('u.sector33_name = ?')
        ;(servingArgs as unknown[]).push(sector33)
      }
      const servingStageCols: Record<string, string> = {
        daily_a: 'sr.daily_a_stage',
        daily_b: 'sr.daily_b_stage',
        weekly_a: 'sr.weekly_a_stage',
        weekly_b: 'sr.weekly_b_stage',
        monthly_a: 'sr.monthly_a_stage',
        monthly_b: 'sr.monthly_b_stage',
      }
      for (const [param, col] of Object.entries(servingStageCols)) {
        const vals = intList(searchParams.get(param))
        if (vals.length > 0) {
          servingWhere.push(`${col} IN (${vals.map(() => '?').join(', ')})`)
          ;(servingArgs as unknown[]).push(...vals)
        }
      }
      for (const signal of signalFilter) {
        servingWhere.push(`(',' || COALESCE(sr.signal_codes, '') || ',') LIKE ?`)
        ;(servingArgs as unknown[]).push(`%,${signal},%`)
      }

      const rows = await execAll<BacktestRow>(
        `
        SELECT
          sr.date,
          sr.ticker,
          sr.name,
          COALESCE(sr.sector_large, u.sector17_name) AS sector_large,
          COALESCE(sr.sector_small, u.sector33_name) AS sector_small,
          u.sector17_name,
          u.sector33_name,
          COALESCE(sr.market_segment, u.market_segment) AS market_segment,
          u.margin_type,
          sr.pattern_code,
          sr.daily_a_stage,
          sr.daily_b_stage,
          sr.weekly_a_stage,
          sr.weekly_b_stage,
          sr.monthly_a_stage,
          sr.monthly_b_stage,
          sr.open,
          sr.high,
          sr.low,
          sr.close,
          sr.volume,
          sr.volume_ratio_20,
          sr.range_pct,
          sr.atr20_pct,
          sr.ma5_pos_pct,
          sr.ma25_pos_pct,
          sr.ma75_pos_pct,
          sr.signal_codes,
          sr.horizon_days,
          sr.return_pct,
          sr.max_return_pct,
          sr.max_return_date,
          sr.days_to_max,
          sr.min_return_pct,
          sr.min_return_date,
          sr.days_to_min,
          sr.hit_10,
          sr.hit_20,
          sr.hit_40
        FROM serving_backtest_results sr
        LEFT JOIN ticker_universe u ON u.ticker = sr.ticker
        WHERE ${servingWhere.join(' AND ')}
        ORDER BY ${servingSort}
        LIMIT ?
        `,
        [...servingArgs, limit],
      )

      return NextResponse.json({
        date,
        horizon: safeHorizon,
        source: 'serving_backtest_results',
        results: rows.map((row) => ({
          ...row,
          signal_codes: compactSignals(row.signal_codes),
        })),
        summary: summarize(rows),
        filters: {
          returnMin,
          returnMax,
          returnMetric,
          targetPct,
          sector,
          sector17,
          sector33,
          signals: signalFilter,
        },
      })
    }

    const rows = await execAll<BacktestRow>(
      `
      SELECT
        mf.date,
        mf.ticker,
        u.name,
        COALESCE(sm.sector_large, u.sector17_name) AS sector_large,
        COALESCE(sm.sector_small, u.sector33_name) AS sector_small,
        u.sector17_name,
        u.sector33_name,
        COALESCE(sm.market_segment, u.market_segment) AS market_segment,
        u.margin_type,
        mf.pattern_code,
        mf.daily_a_stage,
        mf.daily_b_stage,
        mf.weekly_a_stage,
        mf.weekly_b_stage,
        mf.monthly_a_stage,
        mf.monthly_b_stage,
        o.open,
        o.high,
        o.low,
        COALESCE(mf.close, o.close) AS close,
        COALESCE(mf.volume, o.volume) AS volume,
        mf.volume_ratio_20,
        mf.range_pct,
        mf.atr20_pct,
        mf.ma5_pos_pct,
        mf.ma25_pos_pct,
        mf.ma75_pos_pct,
        mf.signal_codes,
        fe.horizon_days,
        fe.return_pct,
        fe.max_return_pct,
        fe.max_return_date,
        fe.days_to_max,
        fe.min_return_pct,
        fe.min_return_date,
        fe.days_to_min,
        fe.hit_10,
        fe.hit_20,
        fe.hit_40
      FROM model_features mf
      INNER JOIN forward_extrema fe ON fe.ticker = mf.ticker AND fe.date = mf.date
      LEFT JOIN ohlcv_daily o ON o.ticker = mf.ticker AND o.date = mf.date
      LEFT JOIN ticker_universe u ON u.ticker = mf.ticker
      LEFT JOIN sector_master sm ON sm.ticker = mf.ticker
      WHERE ${where.join(' AND ')}
      ORDER BY ${sort}
      LIMIT ?
      `,
      [...args, limit],
    )

    return NextResponse.json({
      date,
      horizon: safeHorizon,
      results: rows.map((row) => ({
        ...row,
        signal_codes: compactSignals(row.signal_codes),
      })),
      summary: summarize(rows),
      filters: {
        returnMin,
        returnMax,
        returnMetric,
        targetPct,
        sector,
        sector17,
        sector33,
        signals: signalFilter,
      },
    })
  } catch (error) {
    console.error('Backtest query API error:', error)
    return NextResponse.json(
      { error: 'Backtest query failed', message: (error as Error).message },
      { status: 500 },
    )
  }
}
