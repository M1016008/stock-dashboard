import { NextRequest, NextResponse } from 'next/server'
import { getCurrentSimilars } from '@/lib/queries/ml-insights'
import { execAll, execGet } from '@/lib/db/client'
import type { MlFeatureProfile } from '@/lib/backtest/ml'
import { ML_PHYSICS_FEATURE_SET } from '@/lib/backtest/ml-physics'
import { buildChartWindowWithMa, type OhlcvPoint, type StagePoint } from '@/lib/backtest/detail-analysis'
import { physicsSimilarity } from '@/lib/ml/physics-similarity'
import { MIN_DISPLAY_SIMILARITY_SCORE } from '@/lib/ml/similarity-threshold'

export const dynamic = 'force-dynamic'
export const maxDuration = 30

type AnyProfile = Partial<MlFeatureProfile> & Record<string, any>

type FeatureRow = {
  ticker: string
  date: string
  stage_code: string | null
  feature_json: string
  vector_json: string
  name: string | null
  market_segment: string | null
  sector17_name: string | null
  sector33_name: string | null
}

type FeatureItem = {
  row: FeatureRow
  vector: number[]
  profile: AnyProfile | null
}

type FeatureContext = {
  asOfDate: string
  base: FeatureItem
  items: FeatureItem[]
  source: 'ml_feature_vectors_v2_fallback' | 'ml_feature_vectors_fallback'
}

type FallbackResult = {
  asOfDate: string | null
  rows: Array<Record<string, unknown>>
  context: FeatureContext | null
  source: FeatureContext['source'] | 'none'
}

type CasePoolRow = FeatureRow & {
  h5_return_pct: number | null
  h5_max_return_pct: number | null
  h5_min_return_pct: number | null
  h10_return_pct: number | null
  h10_max_return_pct: number | null
  h10_min_return_pct: number | null
  h15_return_pct: number | null
  h15_max_return_pct: number | null
  h15_min_return_pct: number | null
}

type EvolutionRow = {
  date: string
  feature_json: string
}

const CASE_STUDY_LIMIT = 3
const CASE_STUDY_POOL_LIMIT = Math.max(1000, Number(process.env.ML_STOCK_CASE_POOL_LIMIT ?? 4000))

function parseJson<T>(value: string | null | undefined, fallback: T): T {
  try {
    return value ? JSON.parse(value) as T : fallback
  } catch {
    return fallback
  }
}

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function fmtPct(value: number | null | undefined): string {
  if (!finite(value)) return '-'
  return `${value >= 0 ? '+' : ''}${value.toFixed(1)}%`
}

function subtractCalendarDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00.000Z`)
  d.setUTCDate(d.getUTCDate() - days)
  return d.toISOString().slice(0, 10)
}

function minDate(a: string | null, b: string | null): string | null {
  if (!a) return b
  if (!b) return a
  return a < b ? a : b
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
  for (let i = 0; i < Math.min(6, a.length, b.length); i += 1) {
    if (a[i] === b[i]) same += 1
  }
  return same / 6
}

function profileStage(profile: AnyProfile | null, fallback?: string | null): string | null {
  return typeof profile?.stageCode === 'string' ? profile.stageCode : fallback ?? null
}

function profileMaOrder(profile: AnyProfile | null): string | null {
  return typeof profile?.maOrder === 'string' ? profile.maOrder : null
}

function profileClose(profile: AnyProfile | null): number | null {
  return finite(profile?.close) ? profile.close : null
}

function profileSlope(
  profile: AnyProfile | null,
  key: 'sma5' | 'sma25' | 'sma75' | 'sma200',
  window: 'd5' | 'd10' = 'd10',
): number | null {
  const legacyKey = window === 'd10' ? 'slopes10' : 'slopes5'
  const legacy = profile?.[legacyKey]?.[key]
  if (finite(legacy)) return legacy
  const physics = profile?.velocities?.[key]?.[window]
  return finite(physics) ? physics : null
}

function profileGap(
  profile: AnyProfile | null,
  key: 'sma5To25Pct' | 'sma25To75Pct' | 'sma75To200Pct',
): number | null {
  const value = profile?.gaps?.[key]
  return finite(value) ? value : null
}

function profileGapVelocity(
  profile: AnyProfile | null,
  key: 'sma5To25D5' | 'sma25To75D5' | 'sma75To200D5',
): number | null {
  const value = profile?.gapVelocity?.[key]
  return finite(value) ? value : null
}

function profilePricePosition(
  profile: AnyProfile | null,
  key: 'sma5' | 'sma25' | 'sma75' | 'sma200',
): number | null {
  const value = profile?.pricePosition?.[key]
  return finite(value) ? value : null
}

function profileTrend(profile: AnyProfile | null): string | null {
  return typeof profile?.regimes?.trend === 'string' ? profile.regimes.trend : null
}

async function latestFeatureDateForTicker(
  table: 'ml_feature_vectors_v2' | 'ml_feature_vectors',
  ticker: string,
  requestedDate: string | null,
): Promise<string | null> {
  const featureSetClause = table === 'ml_feature_vectors_v2' ? 'feature_set = ? AND ' : ''
  const args: string[] = table === 'ml_feature_vectors_v2' ? [ML_PHYSICS_FEATURE_SET, ticker] : [ticker]
  if (requestedDate) args.push(requestedDate)
  return (await execGet<{ date: string | null }>(
    `
    SELECT MAX(date) AS date
    FROM ${table}
    WHERE ${featureSetClause}ticker = ?
      ${requestedDate ? 'AND date <= ?' : ''}
    `,
    args,
  ))?.date ?? null
}

async function loadFeatureItems(
  table: 'ml_feature_vectors_v2' | 'ml_feature_vectors',
  date: string,
): Promise<FeatureItem[]> {
  const featureSetClause = table === 'ml_feature_vectors_v2' ? 'f.feature_set = ? AND ' : ''
  const args: string[] = table === 'ml_feature_vectors_v2' ? [ML_PHYSICS_FEATURE_SET, date] : [date]
  const rows = await execAll<FeatureRow>(
    `
    SELECT f.ticker, f.date, f.stage_code, f.feature_json, f.vector_json,
           u.name, u.market_segment, u.sector17_name, u.sector33_name
    FROM ${table} f
    LEFT JOIN ticker_universe u ON u.ticker = f.ticker
    WHERE ${featureSetClause}f.date = ?
    `,
    args,
  )
  return rows
    .map((row) => ({
      row,
      vector: parseJson<number[]>(row.vector_json, []),
      profile: parseJson<AnyProfile | null>(row.feature_json, null),
    }))
    .filter((item) => item.vector.length > 0)
}

async function loadFeatureContext(ticker: string, requestedDate: string | null): Promise<FeatureContext | null> {
  const physicsDate = await latestFeatureDateForTicker('ml_feature_vectors_v2', ticker, requestedDate)
  if (physicsDate) {
    const items = await loadFeatureItems('ml_feature_vectors_v2', physicsDate)
    const base = items.find((item) => item.row.ticker === ticker)
    if (base) {
      return { asOfDate: physicsDate, base, items, source: 'ml_feature_vectors_v2_fallback' }
    }
  }

  const legacyDate = await latestFeatureDateForTicker('ml_feature_vectors', ticker, requestedDate)
  if (legacyDate) {
    const items = await loadFeatureItems('ml_feature_vectors', legacyDate)
    const base = items.find((item) => item.row.ticker === ticker)
    if (base) {
      return { asOfDate: legacyDate, base, items, source: 'ml_feature_vectors_fallback' }
    }
  }

  return null
}

function summarizeProfile(row: FeatureRow, profile: AnyProfile | null) {
  return {
    ticker: row.ticker,
    name: row.name,
    marketSegment: row.market_segment,
    sector17Name: row.sector17_name,
    sector33Name: row.sector33_name,
    close: profileClose(profile),
    stageCode: profileStage(profile, row.stage_code),
    maOrder: profileMaOrder(profile),
    slopes5: {
      sma5: profileSlope(profile, 'sma5', 'd5'),
      sma25: profileSlope(profile, 'sma25', 'd5'),
      sma75: profileSlope(profile, 'sma75', 'd5'),
      sma200: profileSlope(profile, 'sma200', 'd5'),
    },
    slopes10: {
      sma5: profileSlope(profile, 'sma5', 'd10'),
      sma25: profileSlope(profile, 'sma25', 'd10'),
      sma75: profileSlope(profile, 'sma75', 'd10'),
      sma200: profileSlope(profile, 'sma200', 'd10'),
    },
    gaps: {
      sma5To25Pct: profileGap(profile, 'sma5To25Pct'),
      sma25To75Pct: profileGap(profile, 'sma25To75Pct'),
      sma75To200Pct: profileGap(profile, 'sma75To200Pct'),
    },
    gapVelocity: {
      sma5To25D5: profileGapVelocity(profile, 'sma5To25D5'),
      sma25To75D5: profileGapVelocity(profile, 'sma25To75D5'),
      sma75To200D5: profileGapVelocity(profile, 'sma75To200D5'),
    },
    pricePosition: {
      sma5: profilePricePosition(profile, 'sma5'),
      sma25: profilePricePosition(profile, 'sma25'),
      sma75: profilePricePosition(profile, 'sma75'),
      sma200: profilePricePosition(profile, 'sma200'),
    },
    trend: profileTrend(profile),
  }
}

function explainSimilarity(base: FeatureItem, similar: FeatureItem, score: number): Record<string, string> {
  const baseStage = profileStage(base.profile, base.row.stage_code) ?? '------'
  const similarStage = profileStage(similar.profile, similar.row.stage_code) ?? '------'
  const stageRate = Math.round(stageSimilarity(baseStage, similarStage) * 100)
  return {
    stage: `6桁ステージは ${baseStage} と ${similarStage} で、6軸の一致度は約${stageRate}%です。`,
    maAngle: `25日MAの10日変化率は基準銘柄が${fmtPct(profileSlope(base.profile, 'sma25', 'd10'))}、候補銘柄が${fmtPct(profileSlope(similar.profile, 'sma25', 'd10'))}です。`,
    maDistance: `5日-25日MAの距離は基準銘柄が${fmtPct(profileGap(base.profile, 'sma5To25Pct'))}、候補銘柄が${fmtPct(profileGap(similar.profile, 'sma5To25Pct'))}です。`,
    pricePosition: `株価と5日/25日MAの位置関係、MA速度、MA間距離を含む特徴量距離から、類似度${Math.round(score * 100)}%として抽出しました。`,
  }
}

function rankFeatureItems(context: FeatureContext, ticker: string, limit: number) {
  const ranked = context.items
    .filter((item) => item.row.ticker !== ticker)
    .map((item) => {
      if (context.source === 'ml_feature_vectors_v2_fallback') {
        const similarity = physicsSimilarity(
          context.base.profile ?? {},
          item.profile ?? {},
          context.base.row.stage_code,
          item.row.stage_code,
        )
        return { item, score: similarity.score, reason: similarity.reason }
      }
      const distance = vectorDistance(context.base.vector, item.vector)
      const score = Math.min(
        0.999,
        Math.max(
          0,
          (1 / (1 + distance)) * 0.86 +
          0.14 * stageSimilarity(
            profileStage(context.base.profile, context.base.row.stage_code),
            profileStage(item.profile, item.row.stage_code),
          ),
        ),
      )
      return { item, score, reason: explainSimilarity(context.base, item, score) }
    })
    .filter((item) => item.score >= MIN_DISPLAY_SIMILARITY_SCORE)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)

  return {
    asOfDate: context.asOfDate,
    rows: ranked.map(({ item, score, reason }, index) => ({
      asOfDate: context.asOfDate,
      baseTicker: ticker,
      rank: index + 1,
      similarTicker: item.row.ticker,
      similarityScore: score,
      baseDirection: null,
      similarDirection: null,
      payload: {
        base: summarizeProfile(context.base.row, context.base.profile),
        similar: summarizeProfile(item.row, item.profile),
      },
      reason,
    })),
  }
}

async function fallbackTickerSimilars(ticker: string, requestedDate: string | null, limit: number): Promise<FallbackResult> {
  const context = await loadFeatureContext(ticker, requestedDate)
  if (!context) return { asOfDate: null, rows: [], context: null, source: 'none' }
  return { ...rankFeatureItems(context, ticker, limit), context, source: context.source }
}

async function latestShortLabelDate(horizonDays: number): Promise<string | null> {
  return (await execGet<{ date: string | null }>(
    `SELECT MAX(date) AS date FROM ml_short_labels WHERE horizon_days = ?`,
    [horizonDays],
  ))?.date ?? null
}

function classifyCase(returnPct: number | null, evolution: Array<{ trend: string | null; gap5To25Pct: number | null }>): string {
  const latest = evolution[evolution.length - 1]
  const first = evolution[0]
  const gapDelta = finite(latest?.gap5To25Pct) && finite(first?.gap5To25Pct)
    ? latest.gap5To25Pct - first.gap5To25Pct
    : null
  if (finite(returnPct) && returnPct >= 8) return '上昇継続'
  if (finite(returnPct) && returnPct >= 3) return gapDelta != null && gapDelta > 0 ? '再上昇' : '押し目後の反発'
  if (finite(returnPct) && returnPct <= -8) return '下落転換'
  if (finite(returnPct) && returnPct <= -3) return '弱含み'
  return '押し目形成・横ばい'
}

async function loadCaseEvolution(ticker: string, caseDate: string) {
  const rows = await execAll<EvolutionRow>(
    `
    SELECT date, feature_json
    FROM ml_feature_vectors_v2
    WHERE feature_set = ?
      AND ticker = ?
      AND date >= ?
    ORDER BY date
    LIMIT 16
    `,
    [ML_PHYSICS_FEATURE_SET, ticker, caseDate],
  )
  return [0, 5, 10, 15]
    .filter((offset) => rows[offset])
    .map((offset) => {
      const row = rows[offset]
      const profile = parseJson<AnyProfile | null>(row.feature_json, null)
      return {
        afterDays: offset,
        date: row.date,
        close: profileClose(profile),
        stageCode: profileStage(profile),
        maOrder: profileMaOrder(profile),
        sma5Velocity5: profileSlope(profile, 'sma5', 'd5'),
        sma25Velocity5: profileSlope(profile, 'sma25', 'd5'),
        sma75Velocity5: profileSlope(profile, 'sma75', 'd5'),
        gap5To25Pct: profileGap(profile, 'sma5To25Pct'),
        gap25To75Pct: profileGap(profile, 'sma25To75Pct'),
        trend: profileTrend(profile),
      }
    })
}

async function loadCaseChart(ticker: string, startDate: string, endDate: string | null) {
  const rows = await execAll<OhlcvPoint>(
    `
    SELECT date, open, high, low, close, volume
    FROM ohlcv_daily
    WHERE ticker = ?
    ORDER BY date
    `,
    [ticker],
  )
  return buildChartWindowWithMa(rows, startDate, endDate, 45, 20)
}

function buildCaseNarrative(row: CasePoolRow, similarityScore: number, evolution: Awaited<ReturnType<typeof loadCaseEvolution>>) {
  const ret = row.h15_return_pct ?? row.h10_return_pct ?? row.h5_return_pct
  const horizon = row.h15_return_pct != null ? 15 : row.h10_return_pct != null ? 10 : 5
  const pattern = classifyCase(ret, evolution)
  const first = evolution[0]
  const last = evolution[evolution.length - 1]
  const stagePath = evolution
    .map((point) => point.stageCode)
    .filter((code): code is string => typeof code === 'string' && code.length > 0)
    .filter((code, index, arr) => index === 0 || arr[index - 1] !== code)

  const gapStart = first?.gap5To25Pct
  const gapEnd = last?.gap5To25Pct
  const gapComment = finite(gapStart) && finite(gapEnd)
    ? `5日-25日MAの距離は${fmtPct(gapStart)}から${fmtPct(gapEnd)}へ${gapEnd >= gapStart ? '拡大' : '縮小'}しました。`
    : '5日-25日MAの距離変化は一部データ不足です。'

  return {
    pattern,
    stagePath,
    summary: `${row.date}の${row.ticker}は、現在の形状と類似度${Math.round(similarityScore * 100)}%の過去ケースです。${horizon}営業日後の騰落率は${fmtPct(ret)}で、分類は「${pattern}」です。`,
    maComment: `${gapComment} 25日MAの5日変化率は、開始時${fmtPct(first?.sma25Velocity5)}、終盤${fmtPct(last?.sma25Velocity5)}でした。`,
    hint: pattern === '下落転換' || pattern === '弱含み'
      ? '似た形で下方向へ進んだケースなので、5日MAを再び下回るか、25日MAの傾きが悪化するかを優先して確認します。'
      : pattern === '上昇継続' || pattern === '再上昇'
        ? '似た形で上方向へ進んだケースなので、5日MAが25日MAから離れすぎず、25日MAも上向きを保てるかを確認します。'
        : '似た形では一度もみ合うケースもあるため、MA間距離の再拡大と6桁ステージの改善を待って確認します。',
  }
}

async function buildCaseStudies(context: FeatureContext) {
  if (context.source !== 'ml_feature_vectors_v2_fallback') return []
  const maxLabelDate = await latestShortLabelDate(15)
  const endDate = minDate(context.asOfDate, maxLabelDate)
  if (!endDate) return []
  const fromDate = subtractCalendarDays(endDate, 1200)

  const rows = await execAll<CasePoolRow>(
    `
    SELECT f.ticker, f.date, f.stage_code, f.feature_json, f.vector_json,
           u.name, u.market_segment, u.sector17_name, u.sector33_name,
           l5.return_pct AS h5_return_pct, l5.max_return_pct AS h5_max_return_pct, l5.min_return_pct AS h5_min_return_pct,
           l10.return_pct AS h10_return_pct, l10.max_return_pct AS h10_max_return_pct, l10.min_return_pct AS h10_min_return_pct,
           l15.return_pct AS h15_return_pct, l15.max_return_pct AS h15_max_return_pct, l15.min_return_pct AS h15_min_return_pct
    FROM ml_feature_vectors_v2 f
    INNER JOIN ml_short_labels l15
      ON l15.ticker = f.ticker
     AND l15.date = f.date
     AND l15.horizon_days = 15
    LEFT JOIN ml_short_labels l10
      ON l10.ticker = f.ticker
     AND l10.date = f.date
     AND l10.horizon_days = 10
    LEFT JOIN ml_short_labels l5
      ON l5.ticker = f.ticker
     AND l5.date = f.date
     AND l5.horizon_days = 5
    LEFT JOIN ticker_universe u ON u.ticker = f.ticker
    WHERE f.feature_set = ?
      AND f.date >= ?
      AND f.date <= ?
      AND f.ticker <> ?
      AND f.vector_json IS NOT NULL
    ORDER BY f.date DESC
    LIMIT ?
    `,
    [ML_PHYSICS_FEATURE_SET, fromDate, endDate, context.base.row.ticker, CASE_STUDY_POOL_LIMIT],
  )

  const ranked = rows
    .map((row) => {
      const vector = parseJson<number[]>(row.vector_json, [])
      if (vector.length === 0) return null
      const profile = parseJson<AnyProfile | null>(row.feature_json, null)
      const distance = vectorDistance(context.base.vector, vector)
      const similarity = physicsSimilarity(context.base.profile ?? {}, profile ?? {}, context.base.row.stage_code, row.stage_code)
      const score = context.source === 'ml_feature_vectors_v2_fallback'
        ? similarity.score
        : Math.min(
            0.999,
            Math.max(
              0,
              (1 / (1 + distance)) * 0.84 +
              0.16 * stageSimilarity(
                profileStage(context.base.profile, context.base.row.stage_code),
                profileStage(profile, row.stage_code),
              ),
            ),
          )
      return { row, profile, score }
    })
    .filter((item): item is { row: CasePoolRow; profile: AnyProfile | null; score: number } => item != null)
    .filter((item) => item.score >= MIN_DISPLAY_SIMILARITY_SCORE)
    .sort((a, b) => b.score - a.score)
  const success = ranked.filter((item) => (item.row.h15_return_pct ?? item.row.h10_return_pct ?? item.row.h5_return_pct ?? 0) >= 3)
  const failure = ranked.filter((item) => (item.row.h15_return_pct ?? item.row.h10_return_pct ?? item.row.h5_return_pct ?? 0) <= -3)
  const selected = [...success.slice(0, 2), ...failure.slice(0, 2), ...ranked]
    .filter((item, index, arr) => arr.findIndex((other) => other.row.ticker === item.row.ticker && other.row.date === item.row.date) === index)
    .slice(0, CASE_STUDY_LIMIT)

  return Promise.all(selected.map(async ({ row, profile, score }, index) => {
    const evolution = await loadCaseEvolution(row.ticker, row.date)
    const narrative = buildCaseNarrative(row, score, evolution)
    const endPoint = evolution.find((point) => point.afterDays === 15) ?? evolution[evolution.length - 1]
    const startPoint = evolution[0]
    const caseReturnPct = row.h15_return_pct ?? row.h10_return_pct ?? row.h5_return_pct
    const chartSeries = await loadCaseChart(row.ticker, row.date, endPoint?.date ?? null)
    const stageMarkers: StagePoint[] = evolution
      .map((point) => ({ date: point.date, code: point.stageCode ?? '------' }))
      .filter((point, markerIndex, arr) => point.code !== '------' && (markerIndex === 0 || arr[markerIndex - 1]?.code !== point.code))
    return {
      rank: index + 1,
      ticker: row.ticker,
      name: row.name,
      caseDate: row.date,
      similarityScore: score,
      stageCode: profileStage(profile, row.stage_code),
      maOrder: profileMaOrder(profile),
      sector17Name: row.sector17_name,
      sector33Name: row.sector33_name,
      returns: {
        week1: row.h5_return_pct,
        week2: row.h10_return_pct,
        week3: row.h15_return_pct,
        maxWeek3: row.h15_max_return_pct,
        minWeek3: row.h15_min_return_pct,
      },
      evolution,
      chart: {
        series: chartSeries,
        highlightStart: row.date,
        highlightEnd: endPoint?.date ?? null,
        direction: (caseReturnPct ?? 0) >= 0 ? 'up' : 'down',
        startPrice: startPoint?.close ?? null,
        endPrice: endPoint?.close ?? null,
        returnPct: caseReturnPct,
        stagePath: stageMarkers,
      },
      ...narrative,
    }
  }))
}

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url)
    const ticker = searchParams.get('ticker')?.replace(/\.T$/i, '').trim() || null
    const date = searchParams.get('date')?.trim() || null
    const limit = Math.min(100, Math.max(1, Number(searchParams.get('limit') ?? (ticker ? 8 : 20))))
    const result = await getCurrentSimilars({ ticker, date, limit })
    const fallback = ticker ? await fallbackTickerSimilars(ticker, date, limit) : null
    const finalResult = ticker && result.rows.length === 0 && fallback
      ? fallback
      : result
    const caseStudies = ticker && fallback?.context ? await buildCaseStudies(fallback.context) : []

    return NextResponse.json({
      asOfDate: finalResult.asOfDate,
      featureAsOfDate: fallback?.context?.asOfDate ?? finalResult.asOfDate,
      ticker,
      minSimilarityScore: MIN_DISPLAY_SIMILARITY_SCORE,
      count: finalResult.rows.length,
      similars: finalResult.rows,
      caseStudies,
      source: result.rows.length > 0 ? 'serving_current_similars' : fallback?.source ?? 'none',
    })
  } catch (error) {
    console.error('current similars API error:', error)
    return NextResponse.json(
      { error: 'current similars failed', message: (error as Error).message },
      { status: 500 },
    )
  }
}
