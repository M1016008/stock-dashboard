import { execAll, execGet } from '@/lib/db/client'
import {
  analyzeHexSelectorCandidate,
  sortHexSelectorCandidates,
  type HexSelectorCandidate,
  type HexSelectorCandidateInput,
  type HexSelectorDirection,
  type HexSelectorMode,
} from '@/lib/hex-selector'
import { type UniverseFilterValue, universeSqlCondition } from '@/lib/market-universe'
import type { SectorStructureTaxonomy } from '@/lib/sector-structure'
import type { SectorStructureRow } from '@/lib/queries/sectors'

const RESULT_LIMIT = 50

type CandidateDbRow = {
  ticker: string
  name: string | null
  marketSegment: string | null
  sharesOutstanding: number | null
  price: number | null
  previousPrice: number | null
  volume: number | null
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
  physicalMomentumScore: number | null
  mlUpRank: number | null
  mlDownRank: number | null
}

export type HexSelectorCandidateResult = {
  date: string
  groupKey: string
  groupName: string
  total: number
  candidates: HexSelectorCandidate[]
}

function groupCondition(taxonomy: SectorStructureTaxonomy) {
  if (taxonomy === '17') return `COALESCE(NULLIF(tu.sector17_code, ''), tu.sector17_name) = ?`
  if (taxonomy === '33') return `COALESCE(NULLIF(tu.sector33_code, ''), tu.sector33_name) = ?`
  if (taxonomy === 'major') return 'sc.major_category = ?'
  return `(sc.major_category || char(31) || sc.sub_industry) = ?`
}

function toInput(row: CandidateDbRow): HexSelectorCandidateInput {
  const marketCap = row.price != null && row.sharesOutstanding != null
    ? row.price * row.sharesOutstanding
    : null
  const changePct = row.price != null && row.previousPrice != null && row.previousPrice > 0
    ? 100 * (row.price - row.previousPrice) / row.previousPrice
    : null
  return {
    ticker: row.ticker,
    name: row.name,
    marketSegment: row.marketSegment,
    marketCap,
    price: row.price,
    changePct,
    volume: row.volume,
    stages: {
      dailyA: row.dailyA,
      dailyB: row.dailyB,
      weeklyA: row.weeklyA,
      weeklyB: row.weeklyB,
      monthlyA: row.monthlyA,
      monthlyB: row.monthlyB,
    },
    previousStages: {
      dailyA: row.previousDailyA,
      dailyB: row.previousDailyB,
      weeklyA: row.previousWeeklyA,
      weeklyB: row.previousWeeklyB,
      monthlyA: row.previousMonthlyA,
      monthlyB: row.previousMonthlyB,
    },
    ma: { ma5: row.ma5, ma25: row.ma25, ma75: row.ma75, ma300: row.ma300 },
    previousMa: {
      ma5: row.previousMa5,
      ma25: row.previousMa25,
      ma75: row.previousMa75,
      ma300: row.previousMa300,
    },
    physicalMomentumScore: row.physicalMomentumScore,
    mlUpRank: row.mlUpRank,
    mlDownRank: row.mlDownRank,
  }
}

export async function getHexSelectorCandidates({
  taxonomy,
  group,
  date,
  mode,
  direction,
  universeFilter = null,
}: {
  taxonomy: SectorStructureTaxonomy
  group: SectorStructureRow
  date: string
  mode: HexSelectorMode
  direction: HexSelectorDirection
  universeFilter?: UniverseFilterValue
}): Promise<HexSelectorCandidateResult> {
  const previousSnapshotDate = (await execGet<{ date: string | null }>(`
    SELECT MAX(date) AS date FROM daily_snapshots WHERE date < ?
  `, [date]))?.date ?? null
  const previousPriceDate = (await execGet<{ date: string | null }>(`
    SELECT MAX(date) AS date FROM ohlcv_daily WHERE date < ?
  `, [date]))?.date ?? null
  const universe = universeSqlCondition('current.ticker', universeFilter)
  const rows = await execAll<CandidateDbRow>(`
    WITH ml_date AS (
      SELECT MAX(as_of_date) AS date
      FROM serving_ml_candidates
      WHERE as_of_date <= ?
    )
    SELECT
      current.ticker,
      tu.name,
      tu.market_segment AS marketSegment,
      tu.shares_outstanding AS sharesOutstanding,
      current_price.close AS price,
      previous_price.close AS previousPrice,
      current_price.volume,
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
      pm.physical_momentum_score AS physicalMomentumScore,
      ml_up.rank AS mlUpRank,
      ml_down.rank AS mlDownRank
    FROM daily_snapshots AS current INDEXED BY snapshots_date_idx
    JOIN ticker_universe AS tu ON tu.ticker = current.ticker AND tu.active = 1
    LEFT JOIN stock_classification AS sc ON sc.ticker = current.ticker
    LEFT JOIN daily_snapshots AS previous
      ON previous.ticker = current.ticker AND previous.date = ?
    LEFT JOIN ohlcv_daily AS current_price
      ON current_price.ticker = current.ticker AND current_price.date = ?
    LEFT JOIN ohlcv_daily AS previous_price
      ON previous_price.ticker = current.ticker AND previous_price.date = ?
    LEFT JOIN physical_momentum_metrics AS pm
      ON pm.market = 'JP' AND pm.symbol = current.ticker AND pm.date = ?
    LEFT JOIN serving_ml_candidates AS ml_up
      ON ml_up.ticker = current.ticker
     AND ml_up.direction = 'up'
     AND ml_up.as_of_date = (SELECT date FROM ml_date)
    LEFT JOIN serving_ml_candidates AS ml_down
      ON ml_down.ticker = current.ticker
     AND ml_down.direction = 'down'
     AND ml_down.as_of_date = (SELECT date FROM ml_date)
    WHERE current.date = ?
      AND ${groupCondition(taxonomy)}
      ${universe.sql ? `AND ${universe.sql}` : ''}
  `, [
    date,
    previousSnapshotDate ?? '',
    date,
    previousPriceDate ?? '',
    date,
    date,
    group.groupKey,
    ...universe.params,
  ])

  const analyzed = rows.map((row) => analyzeHexSelectorCandidate(toInput(row), group, mode, direction))
  const eligible = analyzed.filter((row) => (
    mode === 'emerging' ? row.transitionMatches > 0 : row.higherAlignment >= 58
  ))
  const ranked = sortHexSelectorCandidates(eligible, mode, direction)
  return {
    date,
    groupKey: group.groupKey,
    groupName: group.groupName,
    total: ranked.length,
    candidates: ranked.slice(0, RESULT_LIMIT),
  }
}
