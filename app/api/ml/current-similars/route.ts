import { NextRequest, NextResponse } from 'next/server'
import { getCurrentSimilars } from '@/lib/queries/ml-insights'
import { execAll, execGet } from '@/lib/db/client'
import type { MlFeatureProfile } from '@/lib/backtest/ml'

export const dynamic = 'force-dynamic'
export const maxDuration = 30

type FeatureRow = {
  ticker: string
  date: string
  feature_json: string
  vector_json: string
  name: string | null
  market_segment: string | null
  sector17_name: string | null
  sector33_name: string | null
}

function parseJson<T>(value: string | null | undefined, fallback: T): T {
  try {
    return value ? JSON.parse(value) as T : fallback
  } catch {
    return fallback
  }
}

function fmtPct(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '-'
  return `${value >= 0 ? '+' : ''}${value.toFixed(1)}%`
}

function vectorDistance(a: number[], b: number[]): number {
  const length = Math.min(a.length, b.length)
  let sum = 0
  let used = 0
  for (let i = 0; i < length; i += 1) {
    if (!Number.isFinite(a[i]) || !Number.isFinite(b[i])) continue
    const diff = a[i] - b[i]
    sum += diff * diff
    used += 1
  }
  return used === 0 ? Number.POSITIVE_INFINITY : Math.sqrt(sum / used)
}

function stageSimilarity(a: string | null | undefined, b: string | null | undefined): number {
  if (!a || !b) return 0
  let same = 0
  for (let i = 0; i < Math.min(6, a.length, b.length); i += 1) if (a[i] === b[i]) same += 1
  return same / 6
}

async function latestFeatureDate(): Promise<string | null> {
  return (await execGet<{ date: string | null }>(`SELECT MAX(date) AS date FROM ml_feature_vectors`))?.date ?? null
}

async function fallbackTickerSimilars(ticker: string, requestedDate: string | null, limit: number) {
  const date = requestedDate ?? await latestFeatureDate()
  if (!date) return { asOfDate: null, rows: [] }
  const rows = await execAll<FeatureRow>(
    `
    SELECT f.ticker, f.date, f.feature_json, f.vector_json,
           u.name, u.market_segment, u.sector17_name, u.sector33_name
    FROM ml_feature_vectors f
    LEFT JOIN ticker_universe u ON u.ticker = f.ticker
    WHERE f.date = ?
    `,
    [date],
  )
  const items = rows
    .map((row) => ({
      row,
      vector: parseJson<number[]>(row.vector_json, []),
      profile: parseJson<MlFeatureProfile | null>(row.feature_json, null),
    }))
    .filter((item) => item.vector.length > 0)
  const base = items.find((item) => item.row.ticker === ticker)
  if (!base) return { asOfDate: date, rows: [] }
  const ranked = items
    .filter((item) => item.row.ticker !== ticker)
    .map((item) => {
      const distance = vectorDistance(base.vector, item.vector)
      const score = Math.min(0.999, Math.max(0, (1 / (1 + distance)) * 0.88 + 0.12 * stageSimilarity(base.profile?.stageCode, item.profile?.stageCode)))
      return { item, score }
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
  return {
    asOfDate: date,
    rows: ranked.map(({ item, score }, index) => ({
      asOfDate: date,
      baseTicker: ticker,
      rank: index + 1,
      similarTicker: item.row.ticker,
      similarityScore: score,
      baseDirection: null,
      similarDirection: null,
      payload: {
        base: {
          ticker,
          name: base.row.name,
          stageCode: base.profile?.stageCode ?? null,
          maOrder: base.profile?.maOrder ?? null,
          sector17Name: base.row.sector17_name,
          sector33Name: base.row.sector33_name,
        },
        similar: {
          ticker: item.row.ticker,
          name: item.row.name,
          stageCode: item.profile?.stageCode ?? null,
          maOrder: item.profile?.maOrder ?? null,
          sector17Name: item.row.sector17_name,
          sector33Name: item.row.sector33_name,
        },
      },
      reason: {
        stage: `6桁ステージは ${base.profile?.stageCode ?? '------'} と ${item.profile?.stageCode ?? '------'} です。`,
        maAngle: `25日MAの10日変化率は基準銘柄が${fmtPct(base.profile?.slopes10.sma25)}、候補銘柄が${fmtPct(item.profile?.slopes10.sma25)}です。`,
        maDistance: `5日-25日MAの距離は基準銘柄が${fmtPct(base.profile?.gaps.sma5To25Pct)}、候補銘柄が${fmtPct(item.profile?.gaps.sma5To25Pct)}です。`,
        pricePosition: `株価と移動平均線の位置関係を含む特徴量距離から、類似度${Math.round(score * 100)}%として抽出しました。`,
      },
    })),
  }
}

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url)
    const ticker = searchParams.get('ticker')?.replace(/\.T$/i, '').trim() || null
    const date = searchParams.get('date')?.trim() || null
    const limit = Math.min(100, Math.max(1, Number(searchParams.get('limit') ?? (ticker ? 8 : 20))))
    const result = await getCurrentSimilars({ ticker, date, limit })
    const finalResult = ticker && result.rows.length === 0
      ? await fallbackTickerSimilars(ticker, date, limit)
      : result
    return NextResponse.json({
      asOfDate: finalResult.asOfDate,
      ticker,
      count: finalResult.rows.length,
      similars: finalResult.rows,
      source: result.rows.length > 0 ? 'serving_current_similars' : 'ml_feature_vectors_fallback',
    })
  } catch (error) {
    console.error('current similars API error:', error)
    return NextResponse.json(
      { error: 'current similars failed', message: (error as Error).message },
      { status: 500 },
    )
  }
}
