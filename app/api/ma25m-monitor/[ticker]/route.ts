import { NextRequest, NextResponse } from 'next/server'
import { execAll, execGet } from '@/lib/db/client'
import { parseBoundedMonitorNumber } from '@/lib/monthly-ma-monitor'
import { decodePathSegment } from '@/lib/url-path'

export const dynamic = 'force-dynamic'
export const revalidate = 0

const SELECT_FIELDS = `
  m.ticker,
  COALESCE(u.name, m.ticker) AS name,
  m.period,
  m.date,
  m.close,
  m.ma_value AS maValue,
  CASE WHEN m.period = 25 THEN m.ma_value ELSE NULL END AS ma25m,
  m.distance_pct AS distancePct,
  m.abs_distance_pct AS absDistancePct,
  m.distance_1d_pct AS distance1dPct,
  m.distance_3d_pct AS distance3dPct,
  m.distance_5d_pct AS distance5dPct,
  m.distance_10d_pct AS distance10dPct,
  m.distance_20d_pct AS distance20dPct,
  m.position_side AS positionSide,
  m.is_approaching AS isApproaching,
  m.approach_direction AS approachDirection,
  m.approach_speed_pct_per_day AS approachSpeedPctPerDay,
  m.approach_consistency AS approachConsistency,
  m.distance_shrink_5_pct AS distanceShrink5Pct,
  m.distance_shrink_10_pct AS distanceShrink10Pct,
  m.is_touch AS isTouch,
  m.last_touch_date AS lastTouchDate,
  m.touch_age_sessions AS touchAgeSessions,
  m.cross_direction AS crossDirection,
  m.last_cross_date AS lastCrossDate,
  m.last_cross_direction AS lastCrossDirection,
  m.cross_age_sessions AS crossAgeSessions,
  m.primary_status AS primaryStatus,
  m.closeness_score AS closenessScore,
  m.movement_score AS movementScore,
  m.event_score AS eventScore,
  m.approach_score AS approachScore,
  m.is_rapid_approach AS isRapidApproach`

type ClusterRow = Record<string, unknown> & { periodsJson?: string | null }

function normalizeCluster(row: ClusterRow): Record<string, unknown> {
  let periods: number[] = []
  if (typeof row.periodsJson === 'string') {
    try {
      const parsed = JSON.parse(row.periodsJson)
      if (Array.isArray(parsed)) periods = parsed.map(Number).filter(Number.isFinite)
    } catch {
      periods = []
    }
  }
  const { periodsJson: _periodsJson, ...rest } = row
  return { ...rest, periods }
}

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ ticker: string }> },
) {
  try {
    const { ticker: rawTicker } = await context.params
    const ticker = decodePathSegment(rawTicker).replace(/\.T$/i, '')
    const requestedDate = request.nextUrl.searchParams.get('date')
    const date = requestedDate && /^\d{4}-\d{2}-\d{2}$/.test(requestedDate) ? requestedDate : null
    const limit = Math.floor(parseBoundedMonitorNumber(request.nextUrl.searchParams.get('limit'), 30, 1, 120))
    const target = await execGet<{ date: string | null }>(
      `SELECT MAX(date) AS date
       FROM monthly_ma_monitor_daily
       WHERE ticker = ? ${date ? 'AND date <= ?' : ''}`,
      date ? [ticker, date] : [ticker],
    )
    if (!target?.date) {
      return NextResponse.json({ ticker, date: null, latest: null, monitors: [], clusters: [], history: [] })
    }

    const [monitors, clusterRows, history] = await Promise.all([
      execAll(
        `SELECT ${SELECT_FIELDS}
         FROM monthly_ma_monitor_daily m
         LEFT JOIN ticker_universe u ON u.ticker = m.ticker
         WHERE m.ticker = ? AND m.date = ?
         ORDER BY m.period`,
        [ticker, target.date],
      ),
      execAll<ClusterRow>(
        `SELECT
           c.cluster_key AS clusterKey,
           c.periods_json AS periodsJson,
           c.period_count AS periodCount,
           c.cluster_type AS clusterType,
           c.is_strong AS isStrong,
           c.date,
           c.close,
           c.band_low AS bandLow,
           c.band_high AS bandHigh,
           c.band_average AS bandAverage,
           c.spread_pct AS spreadPct,
           c.distance_pct AS distancePct,
           c.abs_distance_pct AS absDistancePct,
           c.is_approaching AS isApproaching,
           c.approach_direction AS approachDirection,
           c.approach_speed_pct_per_day AS approachSpeedPctPerDay,
           c.is_touch AS isTouch,
           c.last_touch_date AS lastTouchDate,
           c.touch_age_sessions AS touchAgeSessions,
           c.last_cross_date AS lastCrossDate,
           c.last_cross_direction AS lastCrossDirection,
           c.cross_age_sessions AS crossAgeSessions,
           c.primary_status AS primaryStatus,
           c.approach_score AS approachScore
         FROM monthly_ma_cluster_daily c
         WHERE c.ticker = ? AND c.date = ?
         ORDER BY c.period_count DESC, c.cluster_key`,
        [ticker, target.date],
      ),
      execAll(
        `SELECT ${SELECT_FIELDS}
         FROM monthly_ma_monitor_daily m
         LEFT JOIN ticker_universe u ON u.ticker = m.ticker
         WHERE m.ticker = ? AND m.period = 25 AND m.date <= ?
         ORDER BY m.date DESC
         LIMIT ?`,
        [ticker, target.date, limit],
      ),
    ])

    const latest = monitors.find((row) => Number((row as { period?: number }).period) === 25) ?? null
    return NextResponse.json({
      ticker,
      date: target.date,
      latest,
      monitors,
      clusters: clusterRows.map(normalizeCluster),
      history,
    })
  } catch (error) {
    console.error('Monthly MA monitor detail API error:', error)
    return NextResponse.json({ error: 'Failed to load Monthly MA monitor detail' }, { status: 500 })
  }
}
