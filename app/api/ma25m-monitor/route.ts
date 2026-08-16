import { NextRequest, NextResponse } from 'next/server'
import { execAll, execGet } from '@/lib/db/client'
import {
  MONTHLY_MA_CLUSTER_CONFIG,
  MONTHLY_MA_MONITOR_CONFIG,
  MONTHLY_MA_MONITOR_PERIODS,
  parseBoundedMonitorNumber,
} from '@/lib/monthly-ma-monitor'

export const dynamic = 'force-dynamic'
export const revalidate = 0

const STATUS_FILTERS = new Set([
  'all',
  'approaching',
  'approaching_above',
  'approaching_below',
  'contact',
  'touch_today',
  'touch_3',
  'touch_5',
  'cross_up',
  'cross_down',
  'rapid',
  'cluster',
  'cluster_approaching',
  'cluster_touch_today',
  'cluster_cross_up',
  'cluster_cross_down',
])

const CLUSTER_STATUSES = new Set([
  'cluster',
  'cluster_approaching',
  'cluster_touch_today',
  'cluster_cross_up',
  'cluster_cross_down',
])

const SORT_SQL: Record<string, string> = {
  score: 's.approach_score',
  distance: 's.abs_distance_pct',
  speed: 's.approach_speed_pct_per_day',
  touch: 's.touch_age_sessions',
  cross: 's.cross_age_sessions',
  avgVolume: 'v.avg_volume_30',
  volumeRatio: '(v.current_volume * 1.0 / NULLIF(v.avg_volume_30, 0))',
  ticker: 's.ticker',
}

const SIGNALS_CTE = `WITH recent_dates AS (
  SELECT DISTINCT date
  FROM ohlcv_daily
  WHERE date <= ?
  ORDER BY date DESC
  LIMIT 30
), volume_stats AS (
  SELECT
    ticker,
    MAX(CASE WHEN date = ? THEN volume END) AS current_volume,
    AVG(volume) AS avg_volume_30,
    COUNT(*) AS volume_observations
  FROM ohlcv_daily
  WHERE date IN (SELECT date FROM recent_dates)
  GROUP BY ticker
), signals AS (
  SELECT
    'ma' AS signal_kind,
    m.ticker,
    m.period,
    CAST(m.period AS TEXT) || 'M' AS signal_label,
    NULL AS cluster_key,
    NULL AS cluster_periods_json,
    NULL AS cluster_type,
    0 AS is_strong_cluster,
    m.date,
    m.close,
    m.ma_value AS target_value,
    m.ma_value AS target_low,
    m.ma_value AS target_high,
    NULL AS cluster_spread_pct,
    m.distance_pct,
    m.abs_distance_pct,
    m.distance_1d_pct,
    m.distance_3d_pct,
    m.distance_5d_pct,
    m.distance_10d_pct,
    m.distance_20d_pct,
    m.position_side,
    m.is_approaching,
    m.approach_direction,
    m.approach_speed_pct_per_day,
    m.approach_consistency,
    m.distance_shrink_5_pct,
    m.distance_shrink_10_pct,
    m.is_touch,
    m.last_touch_date,
    m.touch_age_sessions,
    m.cross_direction,
    m.last_cross_date,
    m.last_cross_direction,
    m.cross_age_sessions,
    m.primary_status,
    m.closeness_score,
    m.movement_score,
    m.event_score,
    m.approach_score,
    m.is_rapid_approach
  FROM monthly_ma_monitor_latest m
  WHERE m.date = ?

  UNION ALL

  SELECT
    'cluster' AS signal_kind,
    c.ticker,
    NULL AS period,
    REPLACE(REPLACE(c.periods_json, '[', ''), ']', '') || 'M cluster' AS signal_label,
    c.cluster_key,
    c.periods_json AS cluster_periods_json,
    c.cluster_type,
    c.is_strong AS is_strong_cluster,
    c.date,
    c.close,
    c.band_average AS target_value,
    c.band_low AS target_low,
    c.band_high AS target_high,
    c.spread_pct AS cluster_spread_pct,
    c.distance_pct,
    c.abs_distance_pct,
    NULL AS distance_1d_pct,
    NULL AS distance_3d_pct,
    NULL AS distance_5d_pct,
    NULL AS distance_10d_pct,
    NULL AS distance_20d_pct,
    CASE WHEN c.distance_pct > 0 THEN 'above' WHEN c.distance_pct < 0 THEN 'below' ELSE 'on_line' END AS position_side,
    c.is_approaching,
    c.approach_direction,
    c.approach_speed_pct_per_day,
    NULL AS approach_consistency,
    NULL AS distance_shrink_5_pct,
    NULL AS distance_shrink_10_pct,
    c.is_touch,
    c.last_touch_date,
    c.touch_age_sessions,
    c.cross_direction,
    c.last_cross_date,
    c.last_cross_direction,
    c.cross_age_sessions,
    c.primary_status,
    NULL AS closeness_score,
    NULL AS movement_score,
    NULL AS event_score,
    c.approach_score,
    CASE
      WHEN c.is_approaching = 1
        AND c.abs_distance_pct BETWEEN 3 AND 10
        AND c.approach_speed_pct_per_day >= 0.15
      THEN 1 ELSE 0
    END AS is_rapid_approach
  FROM monthly_ma_cluster_latest c
  WHERE c.date = ? AND c.is_cluster = 1 AND c.is_maximal = 1
)`

type SignalRow = Record<string, unknown> & { clusterPeriodsJson?: string | null }

type FilterOptionRow = {
  kind: 'marketSegments' | 'sector17' | 'sector33' | 'marginTypes' | 'majorCategories' | 'subIndustries'
  value: string
  label: string
  parent: string | null
  count: number
}

function parsePeriod(value: string | null): number | 'all' {
  if (value === 'all') return 'all'
  const parsed = Number(value ?? '25')
  return MONTHLY_MA_MONITOR_PERIODS.includes(parsed as never) ? parsed : 25
}

function cleanTextParam(value: string | null, maxLength = 80): string | null {
  const trimmed = value?.trim()
  return trimmed ? trimmed.slice(0, maxLength) : null
}

function parseOptionalNumber(value: string | null, min: number, max: number): number | null {
  if (!value?.trim()) return null
  const parsed = Number(value.replace(/,/g, ''))
  if (!Number.isFinite(parsed)) return null
  return Math.min(max, Math.max(min, parsed))
}

function parseStage(value: string | null): number | null {
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= 6 ? parsed : null
}

function filterOptions(rows: FilterOptionRow[]) {
  const empty = {
    marketSegments: [] as FilterOptionRow[],
    sector17: [] as FilterOptionRow[],
    sector33: [] as FilterOptionRow[],
    marginTypes: [] as FilterOptionRow[],
    majorCategories: [] as FilterOptionRow[],
    subIndustries: [] as FilterOptionRow[],
  }
  for (const row of rows) empty[row.kind].push(row)
  return empty
}

function statusWhere(status: string, args: Array<string | number>, contactThreshold: number): string | null {
  switch (status) {
    case 'approaching': return "s.signal_kind = 'ma' AND s.is_approaching = 1"
    case 'approaching_above': return "s.signal_kind = 'ma' AND s.is_approaching = 1 AND s.approach_direction = 'above'"
    case 'approaching_below': return "s.signal_kind = 'ma' AND s.is_approaching = 1 AND s.approach_direction = 'below'"
    case 'contact':
      args.push(contactThreshold)
      return "s.signal_kind = 'ma' AND s.abs_distance_pct <= ?"
    case 'touch_today': return "s.signal_kind = 'ma' AND s.touch_age_sessions = 0"
    case 'touch_3': return "s.signal_kind = 'ma' AND s.touch_age_sessions BETWEEN 0 AND 3"
    case 'touch_5': return "s.signal_kind = 'ma' AND s.touch_age_sessions BETWEEN 0 AND 5"
    case 'cross_up': return "s.signal_kind = 'ma' AND s.last_cross_direction = 'up' AND s.cross_age_sessions BETWEEN 0 AND 5"
    case 'cross_down': return "s.signal_kind = 'ma' AND s.last_cross_direction = 'down' AND s.cross_age_sessions BETWEEN 0 AND 5"
    case 'rapid': return "s.signal_kind = 'ma' AND s.is_rapid_approach = 1"
    case 'cluster': return "s.signal_kind = 'cluster'"
    case 'cluster_approaching': return "s.signal_kind = 'cluster' AND s.is_approaching = 1"
    case 'cluster_touch_today': return "s.signal_kind = 'cluster' AND s.touch_age_sessions = 0"
    case 'cluster_cross_up': return "s.signal_kind = 'cluster' AND s.last_cross_direction = 'up' AND s.cross_age_sessions BETWEEN 0 AND 5"
    case 'cluster_cross_down': return "s.signal_kind = 'cluster' AND s.last_cross_direction = 'down' AND s.cross_age_sessions BETWEEN 0 AND 5"
    default: return null
  }
}

function normalizeSignalRow(row: SignalRow): Record<string, unknown> {
  let clusterPeriods: number[] | null = null
  if (typeof row.clusterPeriodsJson === 'string') {
    try {
      const parsed = JSON.parse(row.clusterPeriodsJson)
      clusterPeriods = Array.isArray(parsed) ? parsed.map(Number).filter(Number.isFinite) : null
    } catch {
      clusterPeriods = null
    }
  }
  const { clusterPeriodsJson: _clusterPeriodsJson, ...rest } = row
  return { ...rest, clusterPeriods }
}

export async function GET(request: NextRequest) {
  try {
    const latest = await execGet<{ date: string | null }>(`SELECT MAX(date) AS date FROM monthly_ma_monitor_latest`)
    if (!latest?.date) {
      return NextResponse.json({
        date: null,
        rows: [],
        total: 0,
        period: parsePeriod(request.nextUrl.searchParams.get('period')),
        summary: {
          monitored: 0, signals: 0, approaching: 0, contact: 0,
          touch5: 0, cross5: 0, rapid: 0, clusters: 0, strongClusters: 0,
        },
        message: 'Monthly MA monitor batch has not completed yet.',
      })
    }

    const params = request.nextUrl.searchParams
    const period = parsePeriod(params.get('period'))
    const requestedStatus = params.get('status') ?? 'all'
    const status = STATUS_FILTERS.has(requestedStatus) ? requestedStatus : 'all'
    const contactThreshold = parseBoundedMonitorNumber(
      params.get('contactPct'), MONTHLY_MA_MONITOR_CONFIG.contactThresholdPct, 0.1, 10,
    )
    const minScore = parseBoundedMonitorNumber(params.get('minScore'), 0, 0, 100)
    const maxDistance = params.has('maxDistance')
      ? parseBoundedMonitorNumber(params.get('maxDistance'), 100, 0, 100)
      : null
    const limit = Math.floor(parseBoundedMonitorNumber(params.get('limit'), 100, 1, 200))
    const offset = Math.floor(parseBoundedMonitorNumber(params.get('offset'), 0, 0, 100_000))
    const sort = SORT_SQL[params.get('sort') ?? 'score'] ? params.get('sort') ?? 'score' : 'score'
    const defaultDirection = ['distance', 'touch', 'cross', 'ticker'].includes(sort) ? 'asc' : 'desc'
    const direction = params.get('dir') === 'asc' || params.get('dir') === 'desc'
      ? params.get('dir')!
      : defaultDirection
    const query = params.get('q')?.trim().slice(0, 40) ?? ''
    const marketSegment = cleanTextParam(params.get('market'))
    const sector17 = cleanTextParam(params.get('sector17'))
    const sector33 = cleanTextParam(params.get('sector33'))
    const marginType = cleanTextParam(params.get('marginType'))
    const majorCategory = cleanTextParam(params.get('majorCategory'))
    const subIndustry = cleanTextParam(params.get('subIndustry'))
    const avgVolumeMin = parseOptionalNumber(params.get('avgVolumeMin'), 0, 10_000_000_000)
    const volumeRatioMin = parseOptionalNumber(params.get('volumeRatioMin'), 0, 100)
    const stageFilters = [
      ['d.daily_a_stage', parseStage(params.get('dailyA'))],
      ['d.daily_b_stage', parseStage(params.get('dailyB'))],
      ['d.weekly_a_stage', parseStage(params.get('weeklyA'))],
      ['d.weekly_b_stage', parseStage(params.get('weeklyB'))],
      ['d.monthly_a_stage', parseStage(params.get('monthlyA'))],
      ['d.monthly_b_stage', parseStage(params.get('monthlyB'))],
    ] as const

    const where = ['u.active = 1', 's.approach_score >= ?']
    const args: Array<string | number> = [minScore]
    if (period !== 'all') {
      where.push("s.signal_kind = 'ma'", 's.period = ?')
      args.push(period)
    } else if (status === 'all') {
      where.push(`(
        s.signal_kind = 'cluster'
        OR s.primary_status <> 'watch'
        OR s.touch_age_sessions BETWEEN 0 AND 5
        OR s.cross_age_sessions BETWEEN 0 AND 5
        OR s.is_rapid_approach = 1
      )`)
    }
    if (period !== 'all' && CLUSTER_STATUSES.has(status)) where.push('0 = 1')
    if (maxDistance != null) {
      where.push('s.abs_distance_pct <= ?')
      args.push(maxDistance)
    }
    const statusClause = statusWhere(status, args, contactThreshold)
    if (statusClause) where.push(statusClause)
    if (query) {
      where.push('(s.ticker LIKE ? OR COALESCE(u.name, \'\') LIKE ?)')
      args.push(`%${query}%`, `%${query}%`)
    }
    for (const [column, value] of [
      ['u.market_segment', marketSegment],
      ['u.sector17_name', sector17],
      ['u.sector33_name', sector33],
      ['u.margin_type', marginType],
      ['sc.major_category', majorCategory],
      ['sc.sub_industry', subIndustry],
    ] as const) {
      if (value) {
        where.push(`${column} = ?`)
        args.push(value)
      }
    }
    if (avgVolumeMin != null) {
      where.push('v.avg_volume_30 >= ?')
      args.push(avgVolumeMin)
    }
    if (volumeRatioMin != null) {
      where.push('(v.current_volume * 1.0 / NULLIF(v.avg_volume_30, 0)) >= ?')
      args.push(volumeRatioMin)
    }
    for (const [column, value] of stageFilters) {
      if (value != null) {
        where.push(`${column} = ?`)
        args.push(value)
      }
    }
    const whereSql = where.join(' AND ')
    const orderSql = ['touch', 'cross'].includes(sort)
      ? `CASE WHEN ${SORT_SQL[sort]} IS NULL THEN 1 ELSE 0 END ASC, ${SORT_SQL[sort]} ${direction.toUpperCase()}, s.approach_score DESC`
      : `${SORT_SQL[sort]} ${direction.toUpperCase()}, s.ticker ASC, COALESCE(s.period, 999) ASC`

    const summaryPeriodWhere = period === 'all' ? '' : 'AND m.period = ?'
    const summaryArgs: Array<string | number> = [contactThreshold, latest.date]
    if (period !== 'all') summaryArgs.push(period)

    const signalArgs = [latest.date, latest.date, latest.date, latest.date]
    const [rawRows, count, summary, clusterSummary, rawFilterOptions] = await Promise.all([
      execAll<SignalRow>(
        `${SIGNALS_CTE}
         SELECT
           s.signal_kind AS signalKind,
           s.ticker,
           COALESCE(u.name, s.ticker) AS name,
           s.period,
           s.signal_label AS signalLabel,
           s.cluster_key AS clusterKey,
           s.cluster_periods_json AS clusterPeriodsJson,
           s.cluster_type AS clusterType,
           s.is_strong_cluster AS isStrongCluster,
           s.date,
           s.close,
           s.target_value AS maValue,
           CASE WHEN s.period = 25 THEN s.target_value ELSE NULL END AS ma25m,
           s.target_low AS targetLow,
           s.target_high AS targetHigh,
           s.cluster_spread_pct AS clusterSpreadPct,
           s.distance_pct AS distancePct,
           s.abs_distance_pct AS absDistancePct,
           s.distance_1d_pct AS distance1dPct,
           s.distance_3d_pct AS distance3dPct,
           s.distance_5d_pct AS distance5dPct,
           s.distance_10d_pct AS distance10dPct,
           s.distance_20d_pct AS distance20dPct,
           s.position_side AS positionSide,
           s.is_approaching AS isApproaching,
           s.approach_direction AS approachDirection,
           s.approach_speed_pct_per_day AS approachSpeedPctPerDay,
           s.approach_consistency AS approachConsistency,
           s.distance_shrink_5_pct AS distanceShrink5Pct,
           s.distance_shrink_10_pct AS distanceShrink10Pct,
           s.is_touch AS isTouch,
           s.last_touch_date AS lastTouchDate,
           s.touch_age_sessions AS touchAgeSessions,
           s.cross_direction AS crossDirection,
           s.last_cross_date AS lastCrossDate,
           s.last_cross_direction AS lastCrossDirection,
           s.cross_age_sessions AS crossAgeSessions,
           s.primary_status AS primaryStatus,
           s.closeness_score AS closenessScore,
           s.movement_score AS movementScore,
           s.event_score AS eventScore,
           s.approach_score AS approachScore,
           s.is_rapid_approach AS isRapidApproach,
           u.market_segment AS marketSegment,
           u.sector17_name AS sector17Name,
           u.sector33_name AS sector33Name,
           u.margin_type AS marginType,
           sc.major_category AS majorCategory,
           sc.sub_industry AS subIndustry,
           d.daily_a_stage AS dailyAStage,
           d.daily_b_stage AS dailyBStage,
           d.weekly_a_stage AS weeklyAStage,
           d.weekly_b_stage AS weeklyBStage,
           d.monthly_a_stage AS monthlyAStage,
           d.monthly_b_stage AS monthlyBStage,
           CASE
             WHEN d.daily_a_stage IS NOT NULL AND d.daily_b_stage IS NOT NULL
              AND d.weekly_a_stage IS NOT NULL AND d.weekly_b_stage IS NOT NULL
              AND d.monthly_a_stage IS NOT NULL AND d.monthly_b_stage IS NOT NULL
             THEN CAST(d.daily_a_stage AS TEXT) || CAST(d.daily_b_stage AS TEXT)
               || CAST(d.weekly_a_stage AS TEXT) || CAST(d.weekly_b_stage AS TEXT)
               || CAST(d.monthly_a_stage AS TEXT) || CAST(d.monthly_b_stage AS TEXT)
             ELSE NULL
           END AS stageCode,
           v.current_volume AS currentVolume,
           v.avg_volume_30 AS avgVolume30,
           v.volume_observations AS volumeObservations,
           v.current_volume * 1.0 / NULLIF(v.avg_volume_30, 0) AS volumeRatio30
         FROM signals s
         INNER JOIN ticker_universe u ON u.ticker = s.ticker
         LEFT JOIN stock_classification sc ON sc.ticker = s.ticker
         LEFT JOIN daily_snapshots d ON d.ticker = s.ticker AND d.date = s.date
         LEFT JOIN volume_stats v ON v.ticker = s.ticker
         WHERE ${whereSql}
         ORDER BY ${orderSql}
         LIMIT ? OFFSET ?`,
        [...signalArgs, ...args, limit, offset],
      ),
      execGet<{ total: number }>(
        `${SIGNALS_CTE}
         SELECT COUNT(*) AS total
         FROM signals s
         INNER JOIN ticker_universe u ON u.ticker = s.ticker
         LEFT JOIN stock_classification sc ON sc.ticker = s.ticker
         LEFT JOIN daily_snapshots d ON d.ticker = s.ticker AND d.date = s.date
         LEFT JOIN volume_stats v ON v.ticker = s.ticker
         WHERE ${whereSql}`,
        [...signalArgs, ...args],
      ),
      execGet<{
        monitored: number
        signals: number
        approaching: number
        contact: number
        touch5: number
        cross5: number
        rapid: number
      }>(
        `SELECT
           COUNT(DISTINCT m.ticker) AS monitored,
           COUNT(*) AS signals,
           COUNT(DISTINCT CASE WHEN m.is_approaching = 1 THEN m.ticker END) AS approaching,
           COUNT(DISTINCT CASE WHEN m.abs_distance_pct <= ? THEN m.ticker END) AS contact,
           COUNT(DISTINCT CASE WHEN m.touch_age_sessions BETWEEN 0 AND 5 THEN m.ticker END) AS touch5,
           COUNT(DISTINCT CASE WHEN m.cross_age_sessions BETWEEN 0 AND 5 THEN m.ticker END) AS cross5,
           COUNT(DISTINCT CASE WHEN m.is_rapid_approach = 1 THEN m.ticker END) AS rapid
         FROM monthly_ma_monitor_latest m
         INNER JOIN ticker_universe u ON u.ticker = m.ticker
         WHERE m.date = ? AND u.active = 1 ${summaryPeriodWhere}`,
        summaryArgs,
      ),
      execGet<{ clusters: number; strongClusters: number }>(
        `SELECT
           COUNT(*) AS clusters,
           SUM(CASE WHEN c.is_strong = 1 THEN 1 ELSE 0 END) AS strongClusters
         FROM monthly_ma_cluster_latest c
         INNER JOIN ticker_universe u ON u.ticker = c.ticker
         WHERE c.date = ? AND c.is_cluster = 1 AND c.is_maximal = 1 AND u.active = 1`,
        [latest.date],
      ),
      execAll<FilterOptionRow>(
        `SELECT 'marketSegments' AS kind, market_segment AS value, market_segment AS label,
                NULL AS parent, COUNT(*) AS count
           FROM ticker_universe WHERE active = 1 AND COALESCE(market_segment, '') <> '' GROUP BY market_segment
         UNION ALL
         SELECT 'sector17', sector17_name, sector17_name, NULL, COUNT(*)
           FROM ticker_universe WHERE active = 1 AND COALESCE(sector17_name, '') <> '' GROUP BY sector17_name
         UNION ALL
         SELECT 'sector33', sector33_name, sector33_name, sector17_name, COUNT(*)
           FROM ticker_universe WHERE active = 1 AND COALESCE(sector33_name, '') <> '' GROUP BY sector17_name, sector33_name
         UNION ALL
         SELECT 'marginTypes', margin_type, margin_type, NULL, COUNT(*)
           FROM ticker_universe WHERE active = 1 AND COALESCE(margin_type, '') <> '' GROUP BY margin_type
         UNION ALL
         SELECT 'majorCategories', sc.major_category, sc.major_category, NULL, COUNT(*)
           FROM stock_classification sc INNER JOIN ticker_universe u ON u.ticker = sc.ticker
          WHERE u.active = 1 AND COALESCE(sc.major_category, '') <> '' GROUP BY sc.major_category
         UNION ALL
         SELECT 'subIndustries', sc.sub_industry, sc.sub_industry, sc.major_category, COUNT(*)
           FROM stock_classification sc INNER JOIN ticker_universe u ON u.ticker = sc.ticker
          WHERE u.active = 1 AND COALESCE(sc.sub_industry, '') <> '' GROUP BY sc.major_category, sc.sub_industry
         ORDER BY kind, count DESC, label ASC`,
      ),
    ])

    return NextResponse.json({
      date: latest.date,
      period,
      periods: MONTHLY_MA_MONITOR_PERIODS,
      rows: rawRows.map(normalizeSignalRow),
      total: Number(count?.total ?? 0),
      offset,
      limit,
      contactThreshold,
      volumeWindow: 30,
      filterOptions: filterOptions(rawFilterOptions),
      clusterConfig: MONTHLY_MA_CLUSTER_CONFIG,
      scoreConfig: MONTHLY_MA_MONITOR_CONFIG.scoring,
      rapidApproach: {
        minDistancePct: MONTHLY_MA_MONITOR_CONFIG.rapidApproachMinDistancePct,
        maxDistancePct: MONTHLY_MA_MONITOR_CONFIG.rapidApproachMaxDistancePct,
        minSpeedPctPerDay: MONTHLY_MA_MONITOR_CONFIG.rapidApproachMinSpeedPctPerDay,
      },
      summary: {
        monitored: Number(summary?.monitored ?? 0),
        signals: Number(summary?.signals ?? 0),
        approaching: Number(summary?.approaching ?? 0),
        contact: Number(summary?.contact ?? 0),
        touch5: Number(summary?.touch5 ?? 0),
        cross5: Number(summary?.cross5 ?? 0),
        rapid: Number(summary?.rapid ?? 0),
        clusters: Number(clusterSummary?.clusters ?? 0),
        strongClusters: Number(clusterSummary?.strongClusters ?? 0),
      },
    })
  } catch (error) {
    console.error('Monthly MA monitor API error:', error)
    return NextResponse.json({ error: 'Failed to load Monthly MA monitor' }, { status: 500 })
  }
}
