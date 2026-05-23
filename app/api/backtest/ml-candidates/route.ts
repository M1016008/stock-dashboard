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

async function servingCandidates(date: string, direction: MlDirection | 'both', limit: number) {
  const where = direction === 'both' ? 'as_of_date = ?' : 'as_of_date = ? AND direction = ?'
  const args = direction === 'both' ? [date] : [date, direction]
  const rows = await execAll<CandidateRow>(
    `
    SELECT as_of_date, direction, rank, ticker, name, sector_large, candidate_score, model_name,
           feature_json, reason_json, explanation_json
    FROM serving_ml_candidates
    WHERE ${where}
    ORDER BY direction, rank
    LIMIT ?
    `,
    [...args, direction === 'both' ? limit * 2 : limit],
  )
  return rows.map(rowToCandidate)
}

async function fallbackCandidates(date: string, direction: MlDirection | 'both', limit: number) {
  const rows = await execAll<FeatureRow>(
    `
    SELECT f.ticker, f.date, f.feature_json, u.name, sm.sector_large
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
    const requestedDate = searchParams.get('date')?.trim() || null
    const servingDate = requestedDate ?? await latestServingDate()
    if (servingDate) {
      const candidates = await servingCandidates(servingDate, direction, limit)
      if (candidates.length > 0) {
        return NextResponse.json({ asOfDate: servingDate, direction, source: 'serving_ml_candidates', candidates })
      }
    }

    const featureDate = requestedDate ?? await latestFeatureDate()
    if (!featureDate) {
      return NextResponse.json({
        asOfDate: null,
        direction,
        source: 'none',
        candidates: [],
        notice: 'ML特徴量が未作成です。batch:ml-features を実行してください。',
      })
    }
    const candidates = await fallbackCandidates(featureDate, direction, limit)
    return NextResponse.json({
      asOfDate: featureDate,
      direction,
      source: 'ml_feature_vectors_fallback',
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
