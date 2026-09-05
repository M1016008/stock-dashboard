import { execAll, execGet } from '@/lib/db/client'
import { ML_PHYSICS_FEATURE_SET, type PhysicsFeatureProfile } from '@/lib/backtest/ml-physics'
import { getStageTransitionDirection, isStage, type StageLevel } from '@/lib/hex-stage'
import { type UniverseFilterValue, universeSqlCondition } from '@/lib/market-universe'
import { analyzePhysicsProfile } from '@/lib/ml/physics-analysis'
import { loadPhysicsStatusCalibration } from '@/lib/queries/physics-status-calibration'
import {
  calculateDirectionalStageAlignment,
  calculateTrendStructureMetrics,
  SECTOR_STRUCTURE_AXES,
  trendStructureBand,
  type MovingAverageSet,
  type SectorStructureAxisKey,
  type SectorStructureTaxonomy,
} from '@/lib/sector-structure'
import {
  evaluateBestSectorStrategy,
  evaluateSectorStrategy,
  SECTOR_CONSTITUENT_PRESETS,
  type SectorConstituentFilters,
  type SectorConstituentPreset,
  type SectorDecisionContext,
  type SectorDecisionStrategy,
  type SectorFilteredConstituent,
  type SectorFilteredConstituentPage,
  type SectorMaOrder,
} from '@/lib/sector-constituents'
import { buildShortTermCheck } from '@/lib/short-term-check'

const PAGE_SIZE = 50

type DbRow = {
  ticker: string
  name: string | null
  sector17Name: string | null
  sector33Name: string | null
  dailyA: number | null
  dailyB: number | null
  weeklyA: number | null
  weeklyB: number | null
  monthlyA: number | null
  monthlyB: number | null
  previousDailyA: number | null
  previousDailyB: number | null
  previousWeeklyA: number | null
  previousWeeklyB: number | null
  previousMonthlyA: number | null
  previousMonthlyB: number | null
  ma5: number | null
  ma25: number | null
  ma75: number | null
  ma300: number | null
  previousMa5: number | null
  previousMa25: number | null
  previousMa75: number | null
  previousMa300: number | null
  price: number | null
  previousPrice: number | null
  volume: number | null
  sharesOutstanding: number | null
  physicalMomentumScore: number | null
  physicalForceScore: number | null
  physicalEnergyScore: number | null
  physicsFeatureJson: string | null
  physicsFeatureDate: string | null
}

type MlEvidence = {
  upCount: number
  downCount: number
  similarCount: number
  topSimilarity: number | null
}

function groupCondition(taxonomy: SectorStructureTaxonomy) {
  if (taxonomy === '17') return `COALESCE(NULLIF(tu.sector17_code, ''), tu.sector17_name) = ?`
  if (taxonomy === '33') return `COALESCE(NULLIF(tu.sector33_code, ''), tu.sector33_name) = ?`
  if (taxonomy === 'major') return 'sc.major_category = ?'
  return `(sc.major_category || char(31) || sc.sub_industry) = ?`
}

function asMovingAverages(row: DbRow): { current: MovingAverageSet; previous: MovingAverageSet } {
  return {
    current: { ma5: row.ma5, ma25: row.ma25, ma75: row.ma75, ma300: row.ma300 },
    previous: {
      ma5: row.previousMa5,
      ma25: row.previousMa25,
      ma75: row.previousMa75,
      ma300: row.previousMa300,
    },
  }
}

function maOrderOf(ma: MovingAverageSet): Exclude<SectorMaOrder, 'all'> {
  const values = [ma.ma5, ma.ma25, ma.ma75, ma.ma300]
  if (values.some((value) => value == null || !Number.isFinite(value) || value <= 0)) return 'other'
  const [ma5, ma25, ma75, ma300] = values as number[]
  if (ma5 > ma25 && ma25 > ma75 && ma75 > ma300) return 'bullish'
  if (ma5 < ma25 && ma25 < ma75 && ma75 < ma300) return 'bearish'
  const average = values.reduce<number>((sum, value) => sum + Number(value), 0) / values.length
  const spread = Math.max(...values as number[]) - Math.min(...values as number[])
  return average > 0 && spread / average <= 0.03 ? 'converging' : 'other'
}

function stageCode(stages: Partial<Record<SectorStructureAxisKey, number | null>>) {
  const values = SECTOR_STRUCTURE_AXES.map((axis) => stages[axis.key])
  return values.every((value) => isStage(value ?? null)) ? values.join('') : null
}

function transitionCounts(
  stages: Partial<Record<SectorStructureAxisKey, number | null>>,
  previousStages: Partial<Record<SectorStructureAxisKey, number | null>>,
) {
  let improving = 0
  let deteriorating = 0
  for (const axis of SECTOR_STRUCTURE_AXES) {
    const transition = getStageTransitionDirection(previousStages[axis.key] ?? null, stages[axis.key] ?? null)
    if (transition === 'improve' || transition === 'jump_improve') improving += 1
    if (transition === 'deteriorate' || transition === 'jump_deteriorate') deteriorating += 1
  }
  return { improving, deteriorating }
}

function matchesPreset(item: SectorFilteredConstituent, preset: SectorConstituentPreset) {
  if (preset === 'all') return true
  if (preset === 'up_emerging') return item.improvingTransitions > item.deterioratingTransitions && item.strategyEvaluation.matchCount >= 3
  if (preset === 'up_continuation') {
    return (item.trendStructureScore ?? -Infinity) >= 60
      && item.higherUpAlignment >= 58
      && item.strategyEvaluation.matchCount >= 3
  }
  if (preset === 'reversal') return item.improvingTransitions > item.deterioratingTransitions && item.strategyEvaluation.matchCount >= 3
  if (preset === 'risk') return item.strategyEvaluation.matchCount >= 3
  if (preset === 'down_emerging') return item.deterioratingTransitions > 0 && item.strategyEvaluation.matchCount >= 3
  if (preset === 'down_continuation') {
    return (item.trendStructureScore ?? Infinity) <= 40
      && item.higherDownAlignment >= 58
      && item.strategyEvaluation.matchCount >= 3
  }
  return item.strategyEvaluation.matchCount >= 3
}

function normalizeStrategy(preset: SectorConstituentPreset): SectorDecisionStrategy | null {
  if (preset === 'all') return null
  if (preset === 'down_emerging' || preset === 'down_continuation') return 'risk'
  return preset
}

function parsePhysicsProfile(value: string | null): Partial<PhysicsFeatureProfile> | null {
  if (!value) return null
  try {
    const parsed = JSON.parse(value)
    return parsed && typeof parsed === 'object' ? parsed as Partial<PhysicsFeatureProfile> : null
  } catch {
    return null
  }
}

async function loadMlEvidence(tickers: string[], date: string): Promise<Map<string, MlEvidence>> {
  if (tickers.length === 0) return new Map()
  const latest = await execGet<{ date: string | null }>(`
    SELECT MAX(as_of_date) AS date FROM serving_current_similars WHERE as_of_date <= ?
  `, [date]).catch(() => null)
  if (!latest?.date) return new Map()
  const map = new Map<string, MlEvidence>()
  for (let index = 0; index < tickers.length; index += 400) {
    const chunk = tickers.slice(index, index + 400)
    const rows = await execAll<{
      ticker: string
      upCount: number | null
      downCount: number | null
      similarCount: number | null
      topSimilarity: number | null
    }>(`
      SELECT base_ticker AS ticker,
        SUM(CASE WHEN similar_direction = 'up' THEN 1 ELSE 0 END) AS upCount,
        SUM(CASE WHEN similar_direction = 'down' THEN 1 ELSE 0 END) AS downCount,
        COUNT(*) AS similarCount,
        MAX(similarity_score) AS topSimilarity
      FROM serving_current_similars
      WHERE as_of_date = ? AND base_ticker IN (${chunk.map(() => '?').join(', ')})
      GROUP BY base_ticker
    `, [latest.date, ...chunk]).catch(() => [])
    for (const row of rows) {
      map.set(row.ticker, {
        upCount: Number(row.upCount ?? 0),
        downCount: Number(row.downCount ?? 0),
        similarCount: Number(row.similarCount ?? 0),
        topSimilarity: row.topSimilarity,
      })
    }
  }
  return map
}

function fallbackDecisionContext(
  items: Array<Pick<SectorFilteredConstituent, 'trendStructureScore' | 'improvingTransitions' | 'deterioratingTransitions'>>,
  supplied?: Partial<SectorDecisionContext> | null,
): SectorDecisionContext {
  const scored = items.filter((item) => item.trendStructureScore != null)
  const trendStructureScore = supplied?.trendStructureScore
    ?? (scored.length > 0 ? scored.reduce((sum, item) => sum + Number(item.trendStructureScore), 0) / scored.length : null)
  const improving = items.reduce((sum, item) => sum + item.improvingTransitions, 0)
  const deteriorating = items.reduce((sum, item) => sum + item.deterioratingTransitions, 0)
  const transitionTotal = improving + deteriorating
  return {
    trendStructureScore,
    momentum10d: supplied?.momentum10d ?? (transitionTotal > 0 ? 100 * (improving - deteriorating) / transitionTotal : 0),
    marketTrendStructureScore: supplied?.marketTrendStructureScore ?? null,
  }
}

function compareNullable(a: string | number | null, b: string | number | null, direction: 1 | -1) {
  if (a == null && b == null) return 0
  if (a == null) return 1
  if (b == null) return -1
  if (typeof a === 'number' && typeof b === 'number') return (a - b) * direction
  return String(a).localeCompare(String(b), 'ja-JP') * direction
}

export async function getFilteredSectorConstituents({
  taxonomy,
  groupKey,
  requestedDate,
  universeFilter,
  filters,
  sectorContext,
}: {
  taxonomy: SectorStructureTaxonomy
  groupKey: string
  requestedDate?: string | null
  universeFilter: UniverseFilterValue
  filters: SectorConstituentFilters
  sectorContext?: Partial<SectorDecisionContext> | null
}): Promise<SectorFilteredConstituentPage | null> {
  const date = (await execGet<{ date: string | null }>(`
    SELECT MAX(date) AS date
    FROM daily_snapshots
    ${requestedDate ? 'WHERE date <= ?' : ''}
  `, requestedDate ? [requestedDate] : []))?.date ?? null
  if (!date) return null
  const previousSnapshotDate = (await execGet<{ date: string | null }>(`
    SELECT MAX(date) AS date FROM daily_snapshots WHERE date < ?
  `, [date]))?.date ?? null
  const priceDate = (await execGet<{ date: string | null }>(`
    SELECT MAX(date) AS date FROM ohlcv_daily WHERE date <= ?
  `, [date]))?.date ?? null
  const previousPriceDate = priceDate
    ? (await execGet<{ date: string | null }>(`SELECT MAX(date) AS date FROM ohlcv_daily WHERE date < ?`, [priceDate]))?.date ?? null
    : null
  const universe = universeSqlCondition('tu.ticker', universeFilter)
  const rows = await execAll<DbRow>(`
    WITH physics_date AS (
      SELECT MAX(date) AS date
      FROM ml_feature_vectors_v2
      WHERE feature_set = ? AND date <= ?
    )
    SELECT
      current.ticker,
      tu.name,
      tu.sector17_name AS sector17Name,
      tu.sector33_name AS sector33Name,
      current.daily_a_stage AS dailyA,
      current.daily_b_stage AS dailyB,
      current.weekly_a_stage AS weeklyA,
      current.weekly_b_stage AS weeklyB,
      current.monthly_a_stage AS monthlyA,
      current.monthly_b_stage AS monthlyB,
      previous.daily_a_stage AS previousDailyA,
      previous.daily_b_stage AS previousDailyB,
      previous.weekly_a_stage AS previousWeeklyA,
      previous.weekly_b_stage AS previousWeeklyB,
      previous.monthly_a_stage AS previousMonthlyA,
      previous.monthly_b_stage AS previousMonthlyB,
      current.ma_5 AS ma5,
      current.ma_25 AS ma25,
      current.ma_75 AS ma75,
      current.ma_300 AS ma300,
      previous.ma_5 AS previousMa5,
      previous.ma_25 AS previousMa25,
      previous.ma_75 AS previousMa75,
      previous.ma_300 AS previousMa300,
      currentPrice.close AS price,
      previousPrice.close AS previousPrice,
      currentPrice.volume,
      tu.shares_outstanding AS sharesOutstanding,
      pm.physical_momentum_score AS physicalMomentumScore,
      pm.physical_force_score AS physicalForceScore,
      pm.physical_energy_score AS physicalEnergyScore,
      physics.feature_json AS physicsFeatureJson,
      physics.date AS physicsFeatureDate
    FROM daily_snapshots AS current INDEXED BY snapshots_date_idx
    INNER JOIN ticker_universe AS tu ON tu.ticker = current.ticker AND tu.active = 1
    LEFT JOIN stock_classification AS sc ON sc.ticker = current.ticker
    LEFT JOIN daily_snapshots AS previous
      ON previous.ticker = current.ticker AND previous.date = ?
    LEFT JOIN ohlcv_daily AS currentPrice
      ON currentPrice.ticker = current.ticker AND currentPrice.date = ?
    LEFT JOIN ohlcv_daily AS previousPrice
      ON previousPrice.ticker = current.ticker AND previousPrice.date = ?
    LEFT JOIN physical_momentum_metrics AS pm
      ON pm.market = 'JP' AND pm.symbol = current.ticker AND pm.date = ?
    LEFT JOIN ml_feature_vectors_v2 AS physics
      ON physics.ticker = current.ticker
     AND physics.feature_set = ?
     AND physics.date = (SELECT date FROM physics_date)
    WHERE current.date = ?
      AND ${groupCondition(taxonomy)}
      ${universe.sql ? `AND ${universe.sql}` : ''}
  `, [
    ML_PHYSICS_FEATURE_SET,
    date,
    previousSnapshotDate ?? '',
    priceDate ?? '',
    previousPriceDate ?? '',
    date,
    ML_PHYSICS_FEATURE_SET,
    date,
    groupKey,
    ...universe.params,
  ])

  const [mlEvidence, statusCalibration] = await Promise.all([
    loadMlEvidence(rows.map((row) => row.ticker), date),
    loadPhysicsStatusCalibration(20, date),
  ])

  const baseItems = rows.map((row): Omit<SectorFilteredConstituent, 'strategyEvaluation'> => {
    const stages = {
      dailyA: row.dailyA,
      dailyB: row.dailyB,
      weeklyA: row.weeklyA,
      weeklyB: row.weeklyB,
      monthlyA: row.monthlyA,
      monthlyB: row.monthlyB,
    }
    const previousStages = {
      dailyA: row.previousDailyA,
      dailyB: row.previousDailyB,
      weeklyA: row.previousWeeklyA,
      weeklyB: row.previousWeeklyB,
      monthlyA: row.previousMonthlyA,
      monthlyB: row.previousMonthlyB,
    }
    const ma = asMovingAverages(row)
    const metrics = calculateTrendStructureMetrics({ stages, ma: ma.current, previousMa: ma.previous })
    const transitions = transitionCounts(stages, previousStages)
    const band = trendStructureBand(metrics.trendScore)
    const evidence = mlEvidence.get(row.ticker) ?? { upCount: 0, downCount: 0, similarCount: 0, topSimilarity: null }
    const physics = analyzePhysicsProfile(parsePhysicsProfile(row.physicsFeatureJson))
    const shortTerm = buildShortTermCheck({
      stages,
      physicalMomentumScore: row.physicalMomentumScore,
      physicalForceScore: row.physicalForceScore,
      changePercent: row.price != null && row.previousPrice != null && row.previousPrice > 0
        ? 100 * (row.price - row.previousPrice) / row.previousPrice
        : null,
      mlUpCount: evidence.upCount,
      mlDownCount: evidence.downCount,
      mlSimilarCount: evidence.similarCount,
      mlTopSimilarity: evidence.topSimilarity,
      physicsStatus: physics.physicsStatus,
    })
    const calibration = statusCalibration.get(physics.physicsStatus) ?? null
    return {
      ticker: row.ticker,
      name: row.name,
      price: row.price,
      changePct: row.price != null && row.previousPrice != null && row.previousPrice > 0
        ? 100 * (row.price - row.previousPrice) / row.previousPrice
        : null,
      marketCap: row.price != null && row.sharesOutstanding != null ? row.price * row.sharesOutstanding : null,
      volume: row.volume,
      stages,
      stageCode: stageCode(stages),
      trendStructureScore: metrics.trendScore,
      trendStructureLabel: band?.label ?? '算出待ち',
      maUpCount: metrics.maUpCount,
      maDownCount: metrics.maDownCount,
      maValidCount: metrics.maValidCount,
      maOrder: maOrderOf(ma.current),
      improvingTransitions: transitions.improving,
      deterioratingTransitions: transitions.deteriorating,
      higherUpAlignment: calculateDirectionalStageAlignment(stages, 'up'),
      higherDownAlignment: calculateDirectionalStageAlignment(stages, 'down'),
      physicalMomentumScore: row.physicalMomentumScore,
      physicalForceScore: row.physicalForceScore,
      physicalEnergyScore: row.physicalEnergyScore,
      physicsStatus: physics.physicsStatus,
      pullbackVerdict: physics.pullbackVerdict,
      physicsStatusConfidence: calibration?.confidenceScore ?? null,
      physicsStatusSampleCount: calibration?.sampleCount ?? null,
      shortTermCheckLabel: shortTerm.label,
      shortTermCheckTone: shortTerm.tone,
      shortTermCheckScore: shortTerm.score,
      shortTermCheckReasons: shortTerm.reasons,
      shortTermCheckMlText: shortTerm.mlText,
      mlSimilarCount: evidence.similarCount,
      mlTopSimilarity: evidence.topSimilarity,
    }
  })

  const decisionContext = fallbackDecisionContext(baseItems, sectorContext)
  const requestedStrategy = normalizeStrategy(filters.preset)
  const items = baseItems.map((item): SectorFilteredConstituent => ({
    ...item,
    strategyEvaluation: requestedStrategy
      ? evaluateSectorStrategy(item, requestedStrategy, decisionContext)
      : evaluateBestSectorStrategy(item, decisionContext),
  }))

  const filtered = items.filter((item) => {
    if (!matchesPreset(item, filters.preset)) return false
    if (filters.maDirection === 'up' && item.maUpCount < filters.maMinCount) return false
    if (filters.maDirection === 'down' && item.maDownCount < filters.maMinCount) return false
    if (filters.maOrder !== 'all' && item.maOrder !== filters.maOrder) return false
    if (filters.scoreMin != null && (item.trendStructureScore ?? -Infinity) < filters.scoreMin) return false
    if (filters.scoreMax != null && (item.trendStructureScore ?? Infinity) > filters.scoreMax) return false
    if (filters.changeMin != null && (item.changePct ?? -Infinity) < filters.changeMin) return false
    if (filters.changeMax != null && (item.changePct ?? Infinity) > filters.changeMax) return false
    if (filters.marketCapMin != null && (item.marketCap ?? -Infinity) < filters.marketCapMin) return false
    if (filters.volumeMin != null && (item.volume ?? -Infinity) < filters.volumeMin) return false
    return Object.entries(filters.stages).every(([axis, allowed]) => (
      !allowed || allowed.length === 0 || allowed.includes(item.stages[axis as SectorStructureAxisKey] as StageLevel)
    ))
  })

  const direction = filters.sortDir === 'asc' ? 1 : -1
  filtered.sort((a, b) => {
    const aValue = filters.sort === 'strategyMatch'
      ? a.strategyEvaluation.matchCount
      : filters.sort === 'trendScore'
      ? a.trendStructureScore
      : filters.sort === 'changePct'
        ? a.changePct
        : filters.sort === 'marketCap'
          ? a.marketCap
          : a.ticker
    const bValue = filters.sort === 'strategyMatch'
      ? b.strategyEvaluation.matchCount
      : filters.sort === 'trendScore'
      ? b.trendStructureScore
      : filters.sort === 'changePct'
        ? b.changePct
        : filters.sort === 'marketCap'
          ? b.marketCap
          : b.ticker
    return compareNullable(aValue, bValue, direction) || a.ticker.localeCompare(b.ticker)
  })
  const offset = Math.max(0, filters.offset)
  const pageItems = filtered.slice(offset, offset + PAGE_SIZE)
  const groupName = taxonomy === 'subIndustry'
    ? groupKey.split('\u001f').at(-1) ?? groupKey
    : taxonomy === '17'
      ? rows[0]?.sector17Name ?? groupKey
      : taxonomy === '33'
        ? rows[0]?.sector33Name ?? groupKey
        : groupKey
  return {
    taxonomy,
    groupKey,
    groupName,
    date,
    universe: universeFilter,
    total: filtered.length,
    items: pageItems,
    nextOffset: offset + pageItems.length < filtered.length ? offset + pageItems.length : null,
    physicsFeatureDate: rows.find((row) => row.physicsFeatureDate)?.physicsFeatureDate ?? null,
    physicsCalibrationDate: statusCalibration.values().next().value?.evaluationDate ?? null,
    presetDescription: SECTOR_CONSTITUENT_PRESETS[filters.preset].description,
    decisionContext,
  }
}
