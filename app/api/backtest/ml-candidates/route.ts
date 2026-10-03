import { NextRequest, NextResponse } from 'next/server'
import { execAll, execGet } from '@/lib/db/client'
import {
  buildCandidateExplanation,
  featureVector,
  heuristicScore,
  type MlDirection,
  type MlFeatureProfile,
} from '@/lib/backtest/ml'

export const dynamic = 'force-dynamic'
export const maxDuration = 30

type CandidateRow = {
  as_of_date: string
  direction: MlDirection
  rank: number
  ticker: string
  name: string | null
  sector_large: string | null
  candidate_score: number
  model_name: string | null
  feature_json: string
  reason_json: string
  explanation_json: string
}

type FeatureRow = {
  ticker: string
  date: string
  feature_json: string
  name: string | null
  sector_large: string | null
}

type EvaluationRow = {
  evaluation_date: string
  direction: MlDirection
  horizon_days: number
  sample_count: number
  precision_at_20: number | null
  precision_at_50: number | null
  precision_at_80: number | null
  hit_rate: number | null
  median_return_pct: number | null
  avg_return_pct: number | null
  max_drawdown_pct: number | null
}

function parseJson<T>(value: string | null | undefined, fallback: T): T {
  try {
    return value ? JSON.parse(value) as T : fallback
  } catch {
    return fallback
  }
}

function boundedDirection(value: string | null): MlDirection | 'both' {
  return value === 'up' || value === 'down' || value === 'both' ? value : 'both'
}

function rowToCandidate(row: CandidateRow) {
  const feature = parseJson<Record<string, unknown>>(row.feature_json, {})
  const reason = parseJson<Record<string, string>>(row.reason_json, {})
  const explanation = parseJson<Record<string, unknown>>(row.explanation_json, {})
  return {
    asOfDate: row.as_of_date,
    direction: row.direction,
    rank: row.rank,
    ticker: row.ticker,
    name: row.name,
    sectorLarge: row.sector_large,
    candidateScore: row.candidate_score,
    confidenceLabel: typeof explanation.confidenceLabel === 'string' ? explanation.confidenceLabel : '要確認',
    modelName: row.model_name,
    close: typeof feature.close === 'number' ? feature.close : null,
    stageCode: typeof feature.stageCode === 'string' ? feature.stageCode : null,
    maOrder: typeof feature.maOrder === 'string' ? feature.maOrder : null,
    reason,
    explanation,
  }
}

async function latestServingDate(): Promise<string | null> {
  return (await execGet<{ date: string | null }>(`SELECT MAX(as_of_date) AS date FROM serving_ml_candidates`))?.date ?? null
}

async function latestFeatureDate(): Promise<string | null> {
  return (await execGet<{ date: string | null }>(`SELECT MAX(date) AS date FROM ml_feature_vectors`))?.date ?? null
}

async function modelEvaluations(horizon: number): Promise<Record<string, unknown>> {
  const latest = (await execGet<{ date: string | null }>(
    `SELECT MAX(evaluation_date) AS date FROM ml_model_evaluations WHERE horizon_days = ?`,
    [horizon],
  ))?.date
  if (!latest) return {}
  const rows = await execAll<EvaluationRow>(
    `
    SELECT evaluation_date, direction, horizon_days, sample_count,
           precision_at_20, precision_at_50, precision_at_80, hit_rate,
           median_return_pct, avg_return_pct, max_drawdown_pct
    FROM ml_model_evaluations
    WHERE evaluation_date = ? AND horizon_days = ?
    ORDER BY direction ASC
    `,
    [latest, horizon],
  )
  return Object.fromEntries(rows.map((row) => [row.direction, {
    evaluationDate: row.evaluation_date,
    horizonDays: row.horizon_days,
    sampleCount: row.sample_count,
    precisionAt20: row.precision_at_20,
    precisionAt50: row.precision_at_50,
    precisionAt80: row.precision_at_80,
    hitRate: row.hit_rate,
    medianReturnPct: row.median_return_pct,
    avgReturnPct: row.avg_return_pct,
    maxDrawdownPct: row.max_drawdown_pct,
  }]))
}

async function servingCandidates(date: string, direction: MlDirection | 'both', limit: number) {
  const where = direction === 'both' ? 'as_of_date = ?' : 'as_of_date = ? AND direction = ?'
  const args = direction === 'both' ? [date] : [date, direction]
  const rows = await execAll<CandidateRow>(
    `
    SELECT c.as_of_date, c.direction, c.rank, c.ticker, COALESCE(c.name, u.name) AS name,
           COALESCE(u.sector17_name, c.sector_large) AS sector_large,
           c.candidate_score, c.model_name, c.feature_json, c.reason_json, c.explanation_json
    FROM serving_ml_candidates c
    LEFT JOIN ticker_universe u ON u.ticker = c.ticker
    WHERE ${where.replaceAll('as_of_date', 'c.as_of_date').replaceAll('direction', 'c.direction')}
    ORDER BY c.direction, c.rank
    LIMIT ?
    `,
    [...args, direction === 'both' ? limit * 2 : limit],
  )
  return rows.map(rowToCandidate)
}

async function fallbackCandidates(date: string, direction: MlDirection | 'both', limit: number) {
  const rows = await execAll<FeatureRow>(
    `
    SELECT f.ticker, f.date, f.feature_json, u.name, COALESCE(u.sector17_name, sm.sector_large) AS sector_large
    FROM ml_feature_vectors f
    LEFT JOIN ticker_universe u ON u.ticker = f.ticker
    LEFT JOIN sector_master sm ON sm.ticker = f.ticker
    WHERE f.date = ?
    `,
    [date],
  )
  const directions: MlDirection[] = direction === 'both' ? ['up', 'down'] : [direction]
  return directions.flatMap((dir) => rows
    .map((row) => {
      const profile = parseJson<MlFeatureProfile | null>(row.feature_json, null)
      if (!profile) return null
      const score = heuristicScore(profile, dir)
      const explanation = buildCandidateExplanation(profile, dir, score)
      return {
        asOfDate: date,
        direction: dir,
        rank: 0,
        ticker: row.ticker,
        name: row.name,
        sectorLarge: row.sector_large,
        candidateScore: score,
        confidenceLabel: explanation.confidenceLabel,
        modelName: 'heuristic_fallback',
        close: profile.close,
        stageCode: profile.stageCode,
        maOrder: profile.maOrder,
        reason: explanation.mesh,
        explanation: { ...explanation, featureNames: featureVector(profile) },
      }
    })
    .filter((item): item is NonNullable<typeof item> => item != null)
    .sort((a, b) => b.candidateScore - a.candidateScore)
    .slice(0, limit)
    .map((item, index) => ({ ...item, rank: index + 1 })))
}

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url)
    const direction = boundedDirection(searchParams.get('direction'))
    const limit = Math.min(50, Math.max(1, Number(searchParams.get('limit') ?? 12)))
    const horizon = Math.max(1, Number(searchParams.get('horizon') ?? searchParams.get('horizonDays') ?? 40))
    const requestedDate = searchParams.get('date')?.trim() || null
    const [servingDate, featureDate, evaluations] = await Promise.all([
      requestedDate ?? latestServingDate(),
      requestedDate ?? latestFeatureDate(),
      modelEvaluations(horizon),
    ])
    if (servingDate) {
      const candidates = await servingCandidates(servingDate, direction, limit)
      if (candidates.length > 0) {
        const stale = !requestedDate && featureDate != null && featureDate > servingDate
        return NextResponse.json({
          asOfDate: servingDate,
          latestFeatureDate: featureDate,
          stale,
          direction,
          horizonDays: horizon,
          source: 'serving_ml_candidates',
          modelEvaluations: evaluations,
          candidates,
          notice: stale ? `ML候補は前回更新日時点(${servingDate})です。最新特徴量は${featureDate}まであります。` : undefined,
        })
      }
    }

    if (!featureDate) {
      return NextResponse.json({
        asOfDate: null,
        latestFeatureDate: null,
      stale: false,
      direction,
      horizonDays: horizon,
      source: 'none',
      modelEvaluations: evaluations,
      candidates: [],
      notice: 'ML特徴量が未作成です。batch:ml-features を実行してください。',
      })
    }
    const candidates = await fallbackCandidates(featureDate, direction, limit)
    return NextResponse.json({
      asOfDate: featureDate,
      latestFeatureDate: featureDate,
      stale: false,
      direction,
      horizonDays: horizon,
      source: 'ml_feature_vectors_fallback',
      modelEvaluations: evaluations,
      candidates,
      notice: candidates.length === 0 ? 'ML候補データが未作成です。batch:ml-candidates を実行してください。' : undefined,
    })
  } catch (error) {
    console.error('ML candidates API error:', error)
    return NextResponse.json(
      { error: 'ML candidates failed', message: (error as Error).message },
      { status: 500 },
    )
  }
}
