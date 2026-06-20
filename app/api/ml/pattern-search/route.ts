import { NextRequest, NextResponse } from 'next/server'
import { execAll, execGet } from '@/lib/db/client'
import { ML_PHYSICS_FEATURE_SET, type PhysicsFeatureProfile } from '@/lib/backtest/ml-physics'
import { buildChartWindowWithMa, type OhlcvPoint, type StagePoint } from '@/lib/backtest/detail-analysis'
import { physicsSimilarity, physicsSimilarityScore, stageSimilarity } from '@/lib/ml/physics-similarity'
import { filterRowsByUniverse, parseUniverseFilter, UNIVERSE_FILTER_PARAM } from '@/lib/market-universe'
import { readServingCache, stableCacheKey, writeServingCache } from '@/lib/api/serving-cache'

export const dynamic = 'force-dynamic'
export const maxDuration = 30

type AnyProfile = Partial<PhysicsFeatureProfile> & Record<string, any>

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
  velocity: number | null
  acceleration: number | null
  momentum: number | null
  force: number | null
  ma_angle_avg: number | null
  energy: number | null
  physical_momentum_score: number | null
  physical_force_score: number | null
  physical_energy_score: number | null
}

type FeaturePoint = FeatureRow & {
  profile: AnyProfile | null
}

type OutcomeRow = {
  horizon_days: number
  return_pct: number | null
  end_date: string | null
  max_return_pct: number | null
  max_return_date: string | null
  days_to_max: number | null
  min_return_pct: number | null
  min_return_date: string | null
  days_to_min: number | null
}

type RankedMatch = {
  ticker: string
  name: string | null
  marketSegment: string | null
  sector17Name: string | null
  sector33Name: string | null
  similarityScore: number
  averageScore: number
  finalScore: number
  trajectoryScore: number
  stagePathScore: number
  currentStartDate: string
  currentEndDate: string
  profile: ReturnType<typeof summarizeProfile>
  reason: Record<string, string>
}

const MIN_PATTERN_DAYS = 5
const MAX_PATTERN_DAYS = 90
const MAX_LIMIT = 100
const CACHE_TTL_MS = 60 * 60 * 1000
const CACHE_MAX_ENTRIES = 50
const CACHE_NAMESPACE = 'ml_pattern_search_v1'

const searchCache = new Map<string, { generatedAt: number; payload: unknown }>()

function badRequest(message: string, status = 400) {
  return NextResponse.json({ error: 'invalid_request', message }, { status })
}

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

function dateParam(value: string | null): string | null {
  const trimmed = value?.trim()
  return trimmed && /^\d{4}-\d{2}-\d{2}$/.test(trimmed) ? trimmed : null
}

function positiveInteger(value: string | null): number | null {
  const parsed = Number(value ?? '')
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null
}

function closeness(a: number | null, b: number | null, scale: number): number {
  if (!finite(a) || !finite(b) || scale <= 0) return 0.5
  return Math.max(0, Math.min(1, 1 - Math.abs(a - b) / scale))
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

function metric(profile: AnyProfile | null, key: string): number | null {
  if (!profile) return null
  switch (key) {
    case 'sma5Velocity5': return finite(profile.velocities?.sma5?.d5) ? profile.velocities.sma5.d5 : null
    case 'sma25Velocity5': return finite(profile.velocities?.sma25?.d5) ? profile.velocities.sma25.d5 : null
    case 'sma75Velocity10': return finite(profile.velocities?.sma75?.d10) ? profile.velocities.sma75.d10 : null
    case 'sma5Acceleration5': return finite(profile.accelerations?.sma5?.d5) ? profile.accelerations.sma5.d5 : null
    case 'sma25Acceleration5': return finite(profile.accelerations?.sma25?.d5) ? profile.accelerations.sma25.d5 : null
    case 'gap5To25Pct': return finite(profile.gaps?.sma5To25Pct) ? profile.gaps.sma5To25Pct : null
    case 'gap25To75Pct': return finite(profile.gaps?.sma25To75Pct) ? profile.gaps.sma25To75Pct : null
    case 'gap5To25Velocity5': return finite(profile.gapVelocity?.sma5To25D5) ? profile.gapVelocity.sma5To25D5 : null
    case 'gap25To75Velocity5': return finite(profile.gapVelocity?.sma25To75D5) ? profile.gapVelocity.sma25To75D5 : null
    case 'priceVelocity5': return finite(profile.priceVelocity?.d5) ? profile.priceVelocity.d5 : null
    case 'priceToSma25': return finite(profile.pricePosition?.sma25) ? profile.pricePosition.sma25 : null
    case 'bundleWidthPct': return finite(profile.bundleWidthPct) ? profile.bundleWidthPct : null
    case 'bundleWidthVelocity5': return finite(profile.bundleWidthVelocity5) ? profile.bundleWidthVelocity5 : null
    case 'physicalVelocity': return finite(profile.physicalMomentum?.velocity) ? profile.physicalMomentum.velocity : null
    case 'physicalAcceleration': return finite(profile.physicalMomentum?.acceleration) ? profile.physicalMomentum.acceleration : null
    case 'physicalMomentum': return finite(profile.physicalMomentum?.momentum) ? profile.physicalMomentum.momentum : null
    case 'physicalForce': return finite(profile.physicalMomentum?.force) ? profile.physicalMomentum.force : null
    case 'physicalMaAngleAvg': return finite(profile.physicalMomentum?.maAngleAvg) ? profile.physicalMomentum.maAngleAvg : null
    case 'physicalEnergy': return finite(profile.physicalMomentum?.energy) ? profile.physicalMomentum.energy : null
    case 'physicalMomentumScore': return finite(profile.physicalMomentum?.pms) ? profile.physicalMomentum.pms : null
    case 'physicalForceScore': return finite(profile.physicalMomentum?.pfs) ? profile.physicalMomentum.pfs : null
    case 'physicalEnergyScore': return finite(profile.physicalMomentum?.pes) ? profile.physicalMomentum.pes : null
    default: return null
  }
}

function delta(sequence: FeaturePoint[], key: string): number | null {
  const first = metric(sequence[0]?.profile ?? null, key)
  const last = metric(sequence[sequence.length - 1]?.profile ?? null, key)
  return finite(first) && finite(last) ? last - first : null
}

function average(values: number[]): number {
  if (values.length === 0) return 0
  return values.reduce((sum, value) => sum + value, 0) / values.length
}

function trajectoryScore(base: FeaturePoint[], candidate: FeaturePoint[]): number {
  const specs = [
    { key: 'sma5Velocity5', scale: 10 },
    { key: 'sma25Velocity5', scale: 7 },
    { key: 'sma75Velocity10', scale: 8 },
    { key: 'sma5Acceleration5', scale: 8 },
    { key: 'sma25Acceleration5', scale: 5 },
    { key: 'gap5To25Pct', scale: 10 },
    { key: 'gap25To75Pct', scale: 10 },
    { key: 'gap5To25Velocity5', scale: 6 },
    { key: 'gap25To75Velocity5', scale: 6 },
    { key: 'priceVelocity5', scale: 14 },
    { key: 'priceToSma25', scale: 14 },
    { key: 'bundleWidthPct', scale: 16 },
    { key: 'bundleWidthVelocity5', scale: 8 },
    { key: 'physicalVelocity', scale: 0.18 },
    { key: 'physicalAcceleration', scale: 0.08 },
    { key: 'physicalMaAngleAvg', scale: 0.10 },
    { key: 'physicalMomentumScore', scale: 2.5 },
    { key: 'physicalForceScore', scale: 2.5 },
    { key: 'physicalEnergyScore', scale: 2.5 },
  ]
  return average(specs.map((spec) => closeness(delta(base, spec.key), delta(candidate, spec.key), spec.scale)))
}

function summarizeProfile(row: FeaturePoint) {
  return {
    ticker: row.ticker,
    name: row.name,
    marketSegment: row.market_segment,
    sector17Name: row.sector17_name,
    sector33Name: row.sector33_name,
    date: row.date,
    close: profileClose(row.profile),
    stageCode: profileStage(row.profile, row.stage_code),
    maOrder: profileMaOrder(row.profile),
    trend: typeof row.profile?.regimes?.trend === 'string' ? row.profile.regimes.trend : null,
    sma5Velocity5: metric(row.profile, 'sma5Velocity5'),
    sma25Velocity5: metric(row.profile, 'sma25Velocity5'),
    sma5Acceleration5: metric(row.profile, 'sma5Acceleration5'),
    gap5To25Pct: metric(row.profile, 'gap5To25Pct'),
    gap5To25Velocity5: metric(row.profile, 'gap5To25Velocity5'),
    priceToSma25: metric(row.profile, 'priceToSma25'),
    physicalVelocity: metric(row.profile, 'physicalVelocity'),
    physicalAcceleration: metric(row.profile, 'physicalAcceleration'),
    physicalMomentum: metric(row.profile, 'physicalMomentum'),
    physicalForce: metric(row.profile, 'physicalForce'),
    physicalMaAngleAvg: metric(row.profile, 'physicalMaAngleAvg'),
    physicalEnergy: metric(row.profile, 'physicalEnergy'),
    physicalMomentumScore: metric(row.profile, 'physicalMomentumScore'),
    physicalForceScore: metric(row.profile, 'physicalForceScore'),
    physicalEnergyScore: metric(row.profile, 'physicalEnergyScore'),
  }
}

function stagePath(sequence: FeaturePoint[]): StagePoint[] {
  return sequence
    .map((point) => ({ date: point.date, code: profileStage(point.profile, point.stage_code) ?? '------' }))
    .filter((point) => point.code !== '------')
    .filter((point, index, arr) => index === 0 || arr[index - 1]?.code !== point.code)
}

function toFeaturePoint(row: FeatureRow): FeaturePoint {
  const profile = parseJson<AnyProfile | null>(row.feature_json, null)
  if (!profile) return { ...row, profile }

  profile.physicalMomentum = {
    velocity: row.velocity,
    acceleration: row.acceleration,
    momentum: row.momentum,
    force: row.force,
    maAngleAvg: row.ma_angle_avg,
    energy: row.energy,
    pms: row.physical_momentum_score,
    pfs: row.physical_force_score,
    pes: row.physical_energy_score,
  }

  return { ...row, profile }
}

async function loadFeatureSequence(ticker: string, startDate: string, endDate: string): Promise<FeaturePoint[]> {
  const rows = await execAll<FeatureRow>(
    `
    SELECT f.ticker, f.date, f.stage_code, f.feature_json, f.vector_json,
           u.name, u.market_segment, u.sector17_name, u.sector33_name,
           pm.velocity, pm.acceleration, pm.momentum, pm.force, pm.ma_angle_avg, pm.energy,
           pm.physical_momentum_score, pm.physical_force_score, pm.physical_energy_score
    FROM ml_feature_vectors_v2 f
    LEFT JOIN ticker_universe u ON u.ticker = f.ticker
    LEFT JOIN physical_momentum_metrics pm ON pm.market = 'JP' AND pm.symbol = f.ticker AND pm.date = f.date
    WHERE f.feature_set = ?
      AND f.ticker = ?
      AND f.date >= ?
      AND f.date <= ?
    ORDER BY f.date
    `,
    [ML_PHYSICS_FEATURE_SET, ticker, startDate, endDate],
  )
  return rows.map(toFeaturePoint)
}

async function latestFeatureDate(asOfDate: string | null): Promise<string | null> {
  const args: string[] = [ML_PHYSICS_FEATURE_SET]
  if (asOfDate) args.push(asOfDate)
  return (await execGet<{ date: string | null }>(
    `
    SELECT MAX(date) AS date
    FROM ml_feature_vectors_v2
    WHERE feature_set = ?
      ${asOfDate ? 'AND date <= ?' : ''}
    `,
    args,
  ))?.date ?? null
}

async function featureDatesEndingAt(endDate: string, count: number): Promise<string[]> {
  const rows = await execAll<{ date: string }>(
    `
    SELECT DISTINCT date
    FROM ml_feature_vectors_v2
    WHERE feature_set = ?
      AND date <= ?
    ORDER BY date DESC
    LIMIT ${count}
    `,
    [ML_PHYSICS_FEATURE_SET, endDate],
  )
  return rows.map((row) => row.date).reverse()
}

async function loadLatestMarketRows(endDate: string, stageCodeFilter?: string | null): Promise<FeaturePoint[]> {
  const dailyStage = stageCodeFilter?.[0] ?? null
  const rows = await execAll<FeatureRow>(
    `
    SELECT f.ticker, f.date, f.stage_code, f.feature_json, f.vector_json,
           u.name, u.market_segment, u.sector17_name, u.sector33_name,
           pm.velocity, pm.acceleration, pm.momentum, pm.force, pm.ma_angle_avg, pm.energy,
           pm.physical_momentum_score, pm.physical_force_score, pm.physical_energy_score
    FROM ml_feature_vectors_v2 f
    LEFT JOIN ticker_universe u ON u.ticker = f.ticker
    LEFT JOIN physical_momentum_metrics pm ON pm.market = 'JP' AND pm.symbol = f.ticker AND pm.date = f.date
    WHERE f.feature_set = ?
      AND f.date = ?
      ${dailyStage ? 'AND substr(f.stage_code, 1, 1) = ?' : ''}
    ORDER BY f.ticker
    `,
    dailyStage ? [ML_PHYSICS_FEATURE_SET, endDate, dailyStage] : [ML_PHYSICS_FEATURE_SET, endDate],
  )
  return rows.map(toFeaturePoint)
}

async function loadMarketRows(startDate: string, endDate: string, tickers: string[]): Promise<FeaturePoint[]> {
  if (tickers.length === 0) return []
  const placeholders = tickers.map(() => '?').join(',')
  const rows = await execAll<FeatureRow>(
    `
    SELECT f.ticker, f.date, f.stage_code, f.feature_json, f.vector_json,
           u.name, u.market_segment, u.sector17_name, u.sector33_name,
           pm.velocity, pm.acceleration, pm.momentum, pm.force, pm.ma_angle_avg, pm.energy,
           pm.physical_momentum_score, pm.physical_force_score, pm.physical_energy_score
    FROM ml_feature_vectors_v2 f
    LEFT JOIN ticker_universe u ON u.ticker = f.ticker
    LEFT JOIN physical_momentum_metrics pm ON pm.market = 'JP' AND pm.symbol = f.ticker AND pm.date = f.date
    WHERE f.feature_set = ?
      AND f.date >= ?
      AND f.date <= ?
      AND f.ticker IN (${placeholders})
    ORDER BY f.ticker, f.date
    `,
    [ML_PHYSICS_FEATURE_SET, startDate, endDate, ...tickers],
  )
  return rows.map(toFeaturePoint)
}

async function loadOutcomes(ticker: string, date: string): Promise<OutcomeRow[]> {
  return execAll<OutcomeRow>(
    `
    SELECT horizon_days, return_pct, end_date, max_return_pct, max_return_date, days_to_max,
           min_return_pct, min_return_date, days_to_min
    FROM forward_extrema
    WHERE ticker = ? AND date = ?
    ORDER BY horizon_days
    `,
    [ticker, date],
  )
}

async function loadReferenceChart(ticker: string, startDate: string, endDate: string) {
  const rows = await execAll<OhlcvPoint>(
    `
    SELECT date, open, high, low, close, volume
    FROM ohlcv_daily
    WHERE ticker = ?
    ORDER BY date
    `,
    [ticker],
  )
  return buildChartWindowWithMa(rows, startDate, endDate, 35, 12)
    .map((point) => ({ ...point, volume: null }))
}

function rankMarket(base: FeaturePoint[], marketRows: FeaturePoint[], currentDates: string[], limit: number): RankedMatch[] {
  const baseLast = base[base.length - 1]
  const grouped = new Map<string, FeaturePoint[]>()
  for (const row of marketRows) {
    const list = grouped.get(row.ticker) ?? []
    list.push(row)
    grouped.set(row.ticker, list)
  }

  const ranked: RankedMatch[] = []
  for (const [ticker, rows] of grouped.entries()) {
    if (rows.length !== base.length) continue
    if (!rows.every((row, index) => row.date === currentDates[index])) continue

    const currentLast = rows[rows.length - 1]
    const dailyScores = rows.map((row, index) => physicsSimilarityScore(
      base[index]?.profile ?? {},
      row.profile ?? {},
      base[index]?.stage_code ?? null,
      row.stage_code,
    ))
    const averageScore = average(dailyScores)
    const finalSimilarity = physicsSimilarity(
      baseLast.profile ?? {},
      currentLast.profile ?? {},
      baseLast.stage_code,
      currentLast.stage_code,
    )
    const flowScore = trajectoryScore(base, rows)
    const stageScore = average(rows.map((row, index) => stageSimilarity(
      profileStage(base[index]?.profile ?? null, base[index]?.stage_code ?? null),
      profileStage(row.profile, row.stage_code),
    )))
    const score = Math.min(0.999, Math.max(0, averageScore * 0.55 + finalSimilarity.score * 0.3 + flowScore * 0.15))

    ranked.push({
      ticker,
      name: currentLast.name,
      marketSegment: currentLast.market_segment,
      sector17Name: currentLast.sector17_name,
      sector33Name: currentLast.sector33_name,
      similarityScore: score,
      averageScore,
      finalScore: finalSimilarity.score,
      trajectoryScore: flowScore,
      stagePathScore: stageScore,
      currentStartDate: rows[0]?.date ?? '',
      currentEndDate: currentLast.date,
      profile: summarizeProfile(currentLast),
      reason: finalSimilarity.reason,
    })
  }

  return ranked
    .sort((a, b) => b.similarityScore - a.similarityScore)
    .slice(0, limit)
    .map((row, index) => ({ ...row, rank: index + 1 }) as RankedMatch & { rank: number })
}

function candidateTickerPool(baseLast: FeaturePoint, latestRows: FeaturePoint[], limit: number): string[] {
  const poolSize = Math.min(500, Math.max(120, limit * 25))
  return latestRows
    .map((row) => ({
      ticker: row.ticker,
      score: physicsSimilarityScore(
        baseLast.profile ?? {},
        row.profile ?? {},
        baseLast.stage_code,
        row.stage_code,
      ),
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, poolSize)
    .map((row) => row.ticker)
}

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url)
    const ticker = searchParams.get('ticker')?.replace(/\.T$/i, '').trim()
    const startDate = dateParam(searchParams.get('startDate'))
    const endDate = dateParam(searchParams.get('endDate'))
    if (!ticker) return badRequest('ticker is required')
    if (!startDate || !endDate) return badRequest('startDate and endDate are required')
    if (startDate > endDate) return badRequest('startDate must be before endDate')

    const asOfDate = dateParam(searchParams.get('asOfDate'))
    const rawLimit = positiveInteger(searchParams.get('limit'))
    const limit = Math.min(MAX_LIMIT, Math.max(1, rawLimit ?? 30))
    const universeFilter = parseUniverseFilter(searchParams.get(UNIVERSE_FILTER_PARAM))
    const cacheIdentity = {
      ticker,
      startDate,
      endDate,
      asOfDate,
      limit,
      universeFilter,
    }
    const cacheKey = JSON.stringify(cacheIdentity)
    const cached = searchCache.get(cacheKey)
    if (cached && Date.now() - cached.generatedAt < CACHE_TTL_MS) {
      return NextResponse.json({
        ...(cached.payload as Record<string, unknown>),
        cache: { hit: true, generatedAt: new Date(cached.generatedAt).toISOString() },
      })
    }
    const storedKey = stableCacheKey(cacheIdentity)
    const stored = await readServingCache<Record<string, unknown>>(CACHE_NAMESPACE, storedKey, CACHE_TTL_MS)
    if (stored) {
      searchCache.set(cacheKey, { generatedAt: stored.generatedAt, payload: stored.payload })
      return NextResponse.json({
        ...stored.payload,
        cache: { hit: true, generatedAt: new Date(stored.generatedAt).toISOString(), store: 'db' },
      })
    }

    const base = await loadFeatureSequence(ticker, startDate, endDate)
    if (base.length < MIN_PATTERN_DAYS) {
      return badRequest(`pattern must include at least ${MIN_PATTERN_DAYS} feature dates`, 422)
    }
    if (base.length > MAX_PATTERN_DAYS) {
      return badRequest(`pattern must include at most ${MAX_PATTERN_DAYS} feature dates`, 422)
    }

    const currentEndDate = await latestFeatureDate(asOfDate)
    if (!currentEndDate) return badRequest('current feature date is not available', 422)

    const currentDates = await featureDatesEndingAt(currentEndDate, base.length)
    if (currentDates.length !== base.length) return badRequest('current feature history is too short', 422)

    const baseLast = base[base.length - 1]
    const filteredLatestRows = filterRowsByUniverse(
      await loadLatestMarketRows(currentEndDate, profileStage(baseLast.profile, baseLast.stage_code)),
      universeFilter,
    )
    const latestRows = filteredLatestRows.length >= Math.max(limit * 3, 60)
      ? filteredLatestRows
      : filterRowsByUniverse(await loadLatestMarketRows(currentEndDate), universeFilter)
    const candidateTickers = candidateTickerPool(base[base.length - 1], latestRows, limit)
    const marketRows = await loadMarketRows(currentDates[0], currentEndDate, candidateTickers)
    const matches = rankMarket(base, marketRows, currentDates, limit)
    const referenceStart = base[0].date
    const referenceEnd = base[base.length - 1].date
    const referenceLast = base[base.length - 1]
    const [outcomes, chart] = await Promise.all([
      loadOutcomes(ticker, referenceEnd),
      loadReferenceChart(ticker, referenceStart, referenceEnd),
    ])

    const generatedAt = Date.now()
    const payload = {
      ticker,
      requestedStartDate: startDate,
      requestedEndDate: endDate,
      asOfDate: currentEndDate,
      filters: { universe: universeFilter },
      currentStartDate: currentDates[0],
      currentEndDate,
      count: matches.length,
      reference: {
        ticker,
        name: referenceLast.name,
        marketSegment: referenceLast.market_segment,
        sector17Name: referenceLast.sector17_name,
        sector33Name: referenceLast.sector33_name,
        startDate: referenceStart,
        endDate: referenceEnd,
        featureDays: base.length,
        profile: summarizeProfile(referenceLast),
        stagePath: stagePath(base),
        outcomes,
        chart: {
          series: chart,
          highlightStart: referenceStart,
          highlightEnd: referenceEnd,
          direction: 'up',
          stagePath: stagePath(base),
          startPrice: profileClose(base[0]?.profile ?? null),
          endPrice: profileClose(referenceLast.profile),
          returnPct: finite(profileClose(base[0]?.profile ?? null)) && finite(profileClose(referenceLast.profile))
            ? ((profileClose(referenceLast.profile)! - profileClose(base[0]!.profile)!) / profileClose(base[0]!.profile)!) * 100
            : null,
        },
      },
      matches,
      cache: { hit: false, generatedAt: new Date(generatedAt).toISOString() },
    }
    searchCache.set(cacheKey, { generatedAt, payload })
    await writeServingCache(CACHE_NAMESPACE, storedKey, payload, CACHE_TTL_MS, generatedAt)
    if (searchCache.size > CACHE_MAX_ENTRIES) {
      const firstKey = searchCache.keys().next().value
      if (firstKey) searchCache.delete(firstKey)
    }

    return NextResponse.json(payload)
  } catch (error) {
    console.error('pattern search API error:', error)
    return NextResponse.json(
      { error: 'pattern_search_failed', message: (error as Error).message },
      { status: 500 },
    )
  }
}
