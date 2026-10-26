import { NextRequest, NextResponse } from 'next/server'
import { ML_PHYSICS_FEATURE_SET } from '@/lib/backtest/ml-physics'
import {
  execUsAnalyticsAll,
  execUsAnalyticsGet,
  hasUsAnalyticsDb,
} from '@/lib/db/us-analytics'
import { getUsSecondaryName } from '@/lib/us-symbol-aliases'
import { usInvestableSymbolSql } from '@/lib/us-symbol-quality'
import { isIsoDate } from '@/lib/mtf-close-calendar'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const revalidate = 0

const HORIZONS = new Set([5, 10, 20, 40, 60, 90, 200])
const DIRECTIONS = new Set(['up', 'down', 'wait'])

type Direction = 'up' | 'down' | 'wait'

type CandidateRow = {
  asOfDate: string
  direction: Direction
  horizonDays: number
  rank: number
  ticker: string
  name: string | null
  sector: string | null
  candidateScore: number
  modelName: string | null
  featureJson: string
  reasonJson: string
  explanationJson: string
}

function parseJson<T>(value: string | null | undefined, fallback: T): T {
  try {
    return value ? JSON.parse(value) as T : fallback
  } catch {
    return fallback
  }
}

function normalizeTicker(value: string | null): string | null {
  const ticker = value?.trim().toUpperCase()
  return ticker && /^[A-Z0-9.-]{1,20}$/.test(ticker) ? ticker : null
}

function toCandidate(row: CandidateRow) {
  const feature = parseJson<Record<string, unknown>>(row.featureJson, {})
  const reason = parseJson<Record<string, unknown>>(row.reasonJson, {})
  const explanation = parseJson<Record<string, unknown>>(row.explanationJson, {})
  const reasonHighlights = ['maOrder', 'velocity', 'distance', 'context']
    .map((key) => reason[key])
    .filter((value): value is string => typeof value === 'string' && value.length > 0)
    .slice(0, 3)

  return {
    asOfDate: row.asOfDate,
    direction: row.direction,
    horizonDays: Number(row.horizonDays),
    rank: Number(row.rank),
    ticker: row.ticker,
    name: getUsSecondaryName(row.ticker, row.name),
    sector: row.sector,
    candidateScore: Number(row.candidateScore),
    modelName: row.modelName,
    close: typeof feature.close === 'number' ? feature.close : null,
    stageCode: typeof feature.stageCode === 'string' ? feature.stageCode : null,
    maOrder: typeof feature.maOrder === 'string' ? feature.maOrder : null,
    confidenceLabel: typeof explanation.confidenceLabel === 'string'
      ? explanation.confidenceLabel
      : null,
    summary: typeof explanation.summary === 'string' ? explanation.summary : null,
    reasonHighlights,
  }
}

export async function GET(request: NextRequest) {
  try {
    const params = request.nextUrl.searchParams
    for (const name of ['horizon', 'direction', 'limit', 'ticker', 'date']) {
      if (params.getAll(name).length > 1) {
        return NextResponse.json({ error: `duplicate_${name}` }, { status: 400 })
      }
    }
    const rawHorizon = params.get('horizon')
    const rawDirection = params.get('direction')
    const rawLimit = params.get('limit')
    const rawTicker = params.get('ticker')
    const rawDate = params.get('date')?.trim() ?? ''
    const horizonDays = rawHorizon == null ? 20 : Number(rawHorizon)
    const direction = rawDirection == null ? 'up' : rawDirection
    const limit = rawLimit == null ? 20 : Number(rawLimit)
    const ticker = rawTicker == null ? null : normalizeTicker(rawTicker)
    const requestedDate = rawDate || null
    if (!HORIZONS.has(horizonDays)) {
      return NextResponse.json({ error: 'invalid_horizon' }, { status: 400 })
    }
    if (!DIRECTIONS.has(direction)) {
      return NextResponse.json({ error: 'invalid_direction' }, { status: 400 })
    }
    if (!Number.isInteger(limit) || limit < 1 || limit > 120) {
      return NextResponse.json({ error: 'invalid_limit' }, { status: 400 })
    }
    if (rawTicker != null && ticker == null) {
      return NextResponse.json({ error: 'invalid_ticker' }, { status: 400 })
    }
    if (requestedDate != null && !isIsoDate(requestedDate)) {
      return NextResponse.json({ error: 'invalid_date' }, { status: 400 })
    }

    if (!hasUsAnalyticsDb()) {
      return NextResponse.json({
        ok: true,
        available: false,
        market: 'US',
        horizonDays,
        direction,
        candidates: [],
        currentCandidate: null,
        notice: 'US分析DBが見つからないため、物理ML候補ランキングを表示できません。',
      })
    }

    const latest = await execUsAnalyticsGet<{ asOfDate: string | null }>(
      `
        SELECT MAX(as_of_date) AS asOfDate
        FROM serving_ml_physics_candidates
        WHERE horizon_days = ?
          AND direction = ?
          ${requestedDate ? 'AND as_of_date <= ?' : ''}
      `,
      requestedDate ? [horizonDays, direction, requestedDate] : [horizonDays, direction],
    )
    const asOfDate = latest?.asOfDate ?? null

    if (!asOfDate) {
      return NextResponse.json({
        ok: true,
        available: true,
        market: 'US',
        asOfDate: null,
        requestedDate,
        horizonDays,
        direction,
        totalCandidates: 0,
        candidates: [],
        currentCandidate: null,
        notice: '指定条件のUS物理ML候補はまだ生成されていません。',
      })
    }

    const candidateSql = `
      SELECT
        c.as_of_date AS asOfDate,
        c.direction,
        c.horizon_days AS horizonDays,
        c.rank,
        c.ticker,
        COALESCE(NULLIF(c.name, ''), NULLIF(u.name, ''), c.ticker) AS name,
        COALESCE(NULLIF(c.sector_large, ''), NULLIF(u.sector17_name, ''), NULLIF(u.sector33_name, '')) AS sector,
        c.candidate_score AS candidateScore,
        c.model_name AS modelName,
        c.feature_json AS featureJson,
        c.reason_json AS reasonJson,
        c.explanation_json AS explanationJson
      FROM serving_ml_physics_candidates c
      INNER JOIN ticker_universe u
        ON u.ticker = c.ticker
       AND u.active = 1
      WHERE c.as_of_date = ?
        AND c.horizon_days = ?
        AND c.direction = ?
        AND ${usInvestableSymbolSql('c.ticker')}
    `

    const [rows, currentRow, countRow, featureRow] = await Promise.all([
      execUsAnalyticsAll<CandidateRow>(
        `${candidateSql} ORDER BY c.rank ASC LIMIT ?`,
        [asOfDate, horizonDays, direction, limit],
      ),
      ticker
        ? execUsAnalyticsGet<CandidateRow>(
          `${candidateSql} AND c.ticker = ? LIMIT 1`,
          [asOfDate, horizonDays, direction, ticker],
        )
        : Promise.resolve(undefined),
      execUsAnalyticsGet<{ count: number }>(
        `
          SELECT COUNT(*) AS count
          FROM serving_ml_physics_candidates c
          INNER JOIN ticker_universe u
            ON u.ticker = c.ticker
           AND u.active = 1
          WHERE c.as_of_date = ?
            AND c.horizon_days = ?
            AND c.direction = ?
            AND ${usInvestableSymbolSql('c.ticker')}
        `,
        [asOfDate, horizonDays, direction],
      ),
      execUsAnalyticsGet<{ latestFeatureDate: string | null }>(
        `
          SELECT MAX(date) AS latestFeatureDate
          FROM ml_feature_vectors_v2
          WHERE feature_set = ?
            ${requestedDate ? 'AND date <= ?' : ''}
        `,
        requestedDate
          ? [ML_PHYSICS_FEATURE_SET, requestedDate]
          : [ML_PHYSICS_FEATURE_SET],
      ),
    ])

    const latestFeatureDate = featureRow?.latestFeatureDate ?? null
    const stale = latestFeatureDate != null && latestFeatureDate > asOfDate

    return NextResponse.json({
      ok: true,
      available: true,
      market: 'US',
      asOfDate,
      requestedDate,
      latestFeatureDate,
      stale,
      horizonDays,
      direction,
      totalCandidates: Number(countRow?.count ?? 0),
      candidates: rows.map(toCandidate),
      currentCandidate: currentRow ? toCandidate(currentRow) : null,
      notice: stale
        ? `候補ランキングは${asOfDate}時点です。物理ML特徴量は${latestFeatureDate}まで更新されています。`
        : null,
    })
  } catch (error) {
    console.error('US physical ML candidates API error:', error)
    return NextResponse.json(
      {
        ok: false,
        error: 'US物理ML候補ランキングの取得に失敗しました。',
      },
      { status: 500 },
    )
  }
}
