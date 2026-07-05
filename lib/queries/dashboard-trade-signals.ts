import { execAll, execGet } from '@/lib/db/client'
import { execUsAnalyticsAll, execUsAnalyticsGet, hasUsAnalyticsDb } from '@/lib/db/us-analytics'
import { ML_PHYSICS_FEATURE_SET } from '@/lib/backtest/ml-physics'
import { buildShortTermCheck, type ShortTermCheckLabel } from '@/lib/short-term-check'
import { analyzePhysicsProfile, type PhysicsStatus } from '@/lib/ml/physics-analysis'
import { getUsDisplayName } from '@/lib/us-symbol-aliases'
import { type UniverseFilterValue, universeSqlCondition } from '@/lib/market-universe'
import { US_SEC_SIC_TAXONOMY } from '@/lib/us-classification'

const DASHBOARD_HORIZON_DAYS = 20
const JP_QUERY_LIMIT = 7000
const US_QUERY_LIMIT = 2500
const MIN_DASHBOARD_SCORE = 60

export type DashboardTradeSignalSide = 'buy' | 'short'
export type DashboardTradeSignalMarket = 'JP' | 'US'

export interface DashboardTradeSignalStages {
  dailyA: number | null
  dailyB: number | null
  weeklyA: number | null
  weeklyB: number | null
  monthlyA: number | null
  monthlyB: number | null
}

export interface DashboardTradeSignalRow {
  id: string
  market: DashboardTradeSignalMarket
  side: DashboardTradeSignalSide
  ticker: string
  name: string
  href: string
  date: string | null
  price: number | null
  changePct: number | null
  volume: number | null
  avgVolume: number | null
  avgVolumeLabel: string
  industryName: string
  industryDetail: string | null
  marketSegment: string | null
  marginType: string | null
  confidenceScore: number
  confidenceBand: 'high' | 'candidate'
  primaryLabel: ShortTermCheckLabel | '空売り候補'
  shortTermCheckLabel: ShortTermCheckLabel
  shortTermCheckScore: number
  physicalStatusLabel: PhysicsStatus
  physicalStatusScore: number | null
  pms: number | null
  pfs: number | null
  pes: number | null
  physicsUpRank: number | null
  physicsDownRank: number | null
  classicUpRank: number | null
  classicDownRank: number | null
  stages: DashboardTradeSignalStages
  evidenceChips: string[]
  riskChips: string[]
}

export interface DashboardTradeSignalResult {
  rows: DashboardTradeSignalRow[]
  jpDate: string | null
  usDate: string | null
  generatedAt: string
  horizonDays: number
}

type RawSignalRow = {
  market: DashboardTradeSignalMarket
  ticker: string
  name: string | null
  date: string | null
  price: number | null
  prev_price: number | null
  volume: number | null
  avg_volume: number | null
  sector17_name: string | null
  sector33_name: string | null
  market_segment: string | null
  margin_type: string | null
  exchange: string | null
  sector: string | null
  industry: string | null
  daily_a_stage: number | null
  daily_b_stage: number | null
  weekly_a_stage: number | null
  weekly_b_stage: number | null
  monthly_a_stage: number | null
  monthly_b_stage: number | null
  physical_momentum_score: number | null
  physical_force_score: number | null
  physical_energy_score: number | null
  feature_json: string | null
  physics_up_rank: number | null
  physics_down_rank: number | null
  classic_up_rank: number | null
  classic_down_rank: number | null
}

type UsMetricRow = {
  symbol: string
  physical_momentum_score: number | null
  physical_force_score: number | null
  physical_energy_score: number | null
}

type UsCandidateRow = {
  ticker: string
  direction: string
  rank: number | null
}

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function num(value: unknown): number | null {
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) ? n : null
}

function clamp(value: number, min = 0, max = 100): number {
  return Math.max(min, Math.min(max, value))
}

function parseJson<T>(value: string | null | undefined): T | null {
  if (!value) return null
  try {
    const parsed = JSON.parse(value)
    return parsed && typeof parsed === 'object' ? parsed as T : null
  } catch {
    return null
  }
}

function changePct(price: number | null, prev: number | null): number | null {
  if (!finite(price) || !finite(prev) || prev === 0) return null
  return ((price - prev) / prev) * 100
}

function scoreMetric(value: number | null | undefined, weight: number): number {
  if (!finite(value)) return 0
  return clamp(value, -3, 3) * weight
}

function rankBoost(rank: number | null | undefined, maxRank = 120): number {
  if (!rank || rank <= 0 || rank > maxRank) return 0
  return ((maxRank + 1 - rank) / maxRank) * 20
}

function stageScore(stage: number | null | undefined): number {
  switch (stage) {
    case 1: return 6
    case 6: return 4
    case 2: return 1
    case 5: return 0
    case 3: return -4
    case 4: return -6
    default: return 0
  }
}

function stageComposite(stages: DashboardTradeSignalStages): number {
  return (
    stageScore(stages.dailyA) * 1.25
    + stageScore(stages.dailyB)
    + stageScore(stages.weeklyA) * 0.85
    + stageScore(stages.weeklyB) * 0.7
    + stageScore(stages.monthlyA) * 0.55
    + stageScore(stages.monthlyB) * 0.45
  )
}

function liquidityBonus(avgVolume: number | null): number {
  if (!finite(avgVolume)) return -4
  if (avgVolume >= 1_000_000) return 5
  if (avgVolume >= 300_000) return 2
  if (avgVolume < 100_000) return -6
  return 0
}

function shortTermBuyBonus(label: ShortTermCheckLabel): number {
  switch (label) {
    case '強気優勢': return 18
    case '好転候補': return 10
    case '中立': return 0
    case '弱含み注意': return -8
    case '下落警戒': return -16
  }
}

function shortTermShortBonus(label: ShortTermCheckLabel): number {
  switch (label) {
    case '下落警戒': return 18
    case '弱含み注意': return 10
    case '中立': return 0
    case '好転候補': return -8
    case '強気優勢': return -16
  }
}

function statusBuyBonus(status: PhysicsStatus): number {
  switch (status) {
    case '上昇加速': return 16
    case '上昇継続': return 12
    case '押し目形成': return 8
    case '反発準備': return 7
    case '過熱注意': return -6
    case '失速警戒': return -14
    case '下落加速': return -20
    case '見送り': return 0
    case '算出待ち': return -2
  }
}

function statusShortBonus(status: PhysicsStatus): number {
  switch (status) {
    case '下落加速': return 18
    case '失速警戒': return 14
    case '過熱注意': return 7
    case '見送り': return 0
    case '算出待ち': return -2
    case '反発準備': return -5
    case '押し目形成': return -7
    case '上昇継続': return -12
    case '上昇加速': return -18
  }
}

function physicalStatusFallback(pms: number | null, pfs: number | null): PhysicsStatus {
  if (!finite(pms) && !finite(pfs)) return '算出待ち'
  if ((pfs ?? 0) <= -1.1 || ((pms ?? 0) <= -1 && (pfs ?? 0) < 0)) return '下落加速'
  if ((pms ?? 0) > 0.3 && (pfs ?? 0) <= -0.6) return '失速警戒'
  if ((pms ?? 0) >= 1.4 && (pfs ?? 0) < 0) return '過熱注意'
  if ((pfs ?? 0) >= 1 && (pms ?? 0) >= 0.2) return '上昇加速'
  if ((pms ?? 0) >= 0.7) return '上昇継続'
  if ((pms ?? 0) >= 0 && (pfs ?? 0) > 0) return '反発準備'
  return '見送り'
}

function physicalStatusScore(status: PhysicsStatus, pms: number | null, pfs: number | null): number | null {
  if (status === '算出待ち') return null
  const base: Record<PhysicsStatus, number> = {
    上昇加速: 40,
    上昇継続: 28,
    押し目形成: 18,
    反発準備: 14,
    過熱注意: 4,
    見送り: 0,
    失速警戒: -24,
    下落加速: -40,
    算出待ち: 0,
  }
  return base[status] + clamp(pms ?? 0, -5, 5) + clamp(pfs ?? 0, -5, 5)
}

function industryName(row: RawSignalRow): string {
  if (row.market === 'US') return row.sector || row.industry || '未分類'
  return row.sector17_name || row.sector33_name || '未分類'
}

function industryDetail(row: RawSignalRow): string | null {
  if (row.market === 'US') return row.industry || null
  return row.sector33_name || null
}

function evidenceForSide(row: RawSignalRow, side: DashboardTradeSignalSide, status: PhysicsStatus, label: ShortTermCheckLabel): string[] {
  const chips: string[] = []
  if (side === 'buy') {
    if (row.physics_up_rank) chips.push(`物理ML上昇#${row.physics_up_rank}`)
    if (row.classic_up_rank) chips.push(`通常ML上昇#${row.classic_up_rank}`)
    if ((row.physical_force_score ?? 0) > 0) chips.push('PFS上向き')
    if ((row.physical_momentum_score ?? 0) > 0) chips.push('PMSプラス')
    if (label === '強気優勢' || label === '好転候補') chips.push(label)
    if (status === '上昇加速' || status === '上昇継続' || status === '反発準備') chips.push(status)
  } else {
    if (row.physics_down_rank) chips.push(`物理ML下落#${row.physics_down_rank}`)
    if (row.classic_down_rank) chips.push(`通常ML下落#${row.classic_down_rank}`)
    if ((row.physical_force_score ?? 0) < 0) chips.push('PFS下向き')
    if ((row.physical_momentum_score ?? 0) < 0) chips.push('PMSマイナス')
    if (row.margin_type === '貸借') chips.push('貸借')
    if (label === '下落警戒' || label === '弱含み注意') chips.push(label)
    if (status === '下落加速' || status === '失速警戒' || status === '過熱注意') chips.push(status)
  }
  if ((row.avg_volume ?? 0) >= 1_000_000) chips.push('平均出来高100万+')
  return Array.from(new Set(chips)).slice(0, 5)
}

function riskForSide(row: RawSignalRow, side: DashboardTradeSignalSide, status: PhysicsStatus): string[] {
  const chips: string[] = []
  if (side === 'buy') {
    if (row.physics_down_rank && row.physics_down_rank <= 40) chips.push(`下落ML#${row.physics_down_rank}`)
    if (status === '過熱注意') chips.push('過熱注意')
    if ((row.physical_force_score ?? 0) < 0) chips.push('力は鈍化')
  } else {
    if (row.physics_up_rank && row.physics_up_rank <= 40) chips.push(`上昇ML#${row.physics_up_rank}`)
    if ((row.physical_force_score ?? 0) > 0) chips.push('反発力あり')
    if (stageComposite(toStages(row)) > 10) chips.push('上位足強め')
  }
  return chips.slice(0, 3)
}

function toStages(row: RawSignalRow): DashboardTradeSignalStages {
  return {
    dailyA: num(row.daily_a_stage),
    dailyB: num(row.daily_b_stage),
    weeklyA: num(row.weekly_a_stage),
    weeklyB: num(row.weekly_b_stage),
    monthlyA: num(row.monthly_a_stage),
    monthlyB: num(row.monthly_b_stage),
  }
}

function buildCandidate(row: RawSignalRow, side: DashboardTradeSignalSide): DashboardTradeSignalRow | null {
  const stages = toStages(row)
  const parsedFeature = parseJson<Record<string, unknown>>(row.feature_json)
  const analysis = parsedFeature
    ? analyzePhysicsProfile(parsedFeature)
    : { physicsStatus: physicalStatusFallback(row.physical_momentum_score, row.physical_force_score) }
  const physicalStatusLabel = analysis.physicsStatus
  const shortTerm = buildShortTermCheck({
    stages,
    physicalMomentumScore: row.physical_momentum_score,
    physicalForceScore: row.physical_force_score,
    changePercent: changePct(row.price, row.prev_price),
    mlUpCount: row.physics_up_rank ? 1 : 0,
    mlDownCount: row.physics_down_rank ? 1 : 0,
    physicsStatus: physicalStatusLabel,
  })
  const stage = stageComposite(stages)
  const upBoost = rankBoost(row.physics_up_rank) + rankBoost(row.classic_up_rank) * 0.65
  const downBoost = rankBoost(row.physics_down_rank) + rankBoost(row.classic_down_rank) * 0.65
  const liquidity = liquidityBonus(row.avg_volume)
  const buyScore = clamp(
    34
    + shortTermBuyBonus(shortTerm.label)
    + statusBuyBonus(physicalStatusLabel)
    + scoreMetric(row.physical_momentum_score, 2.8)
    + scoreMetric(row.physical_force_score, 3.2)
    + scoreMetric(row.physical_energy_score, 1)
    + upBoost * 0.55
    - downBoost * 0.6
    + stage * 0.45
    + liquidity,
  )
  const shortEligible = row.market === 'JP' && row.margin_type === '貸借'
  const shortScore = shortEligible
    ? clamp(
      34
      + shortTermShortBonus(shortTerm.label)
      + statusShortBonus(physicalStatusLabel)
      + scoreMetric(finite(row.physical_momentum_score) ? -row.physical_momentum_score : null, 3)
      + scoreMetric(finite(row.physical_force_score) ? -row.physical_force_score : null, 3.6)
      + downBoost * 0.6
      - upBoost * 0.65
      - stage * 0.45
      + liquidity,
    )
    : 0
  const score = side === 'buy' ? buyScore : shortScore
  if (score < MIN_DASHBOARD_SCORE) return null
  if (side === 'buy' && row.market === 'JP' && shortScore > buyScore + 4) return null
  if (side === 'short' && (!shortEligible || buyScore >= shortScore)) return null

  return {
    id: `${row.market}:${row.ticker}:${side}`,
    market: row.market,
    side,
    ticker: row.ticker,
    name: row.market === 'US' ? getUsDisplayName(row.ticker, row.name) : row.name ?? row.ticker,
    href: row.market === 'US' ? `/us/stock/${encodeURIComponent(row.ticker)}` : `/stock/${encodeURIComponent(row.ticker)}`,
    date: row.date,
    price: row.price,
    changePct: changePct(row.price, row.prev_price),
    volume: row.volume,
    avgVolume: row.avg_volume,
    avgVolumeLabel: row.market === 'US' ? '20日平均' : '30日平均',
    industryName: industryName(row),
    industryDetail: industryDetail(row),
    marketSegment: row.market === 'US' ? row.exchange : row.market_segment,
    marginType: row.margin_type,
    confidenceScore: Math.round(score),
    confidenceBand: score >= 75 ? 'high' : 'candidate',
    primaryLabel: side === 'short' ? '空売り候補' : shortTerm.label,
    shortTermCheckLabel: shortTerm.label,
    shortTermCheckScore: shortTerm.score,
    physicalStatusLabel,
    physicalStatusScore: physicalStatusScore(physicalStatusLabel, row.physical_momentum_score, row.physical_force_score),
    pms: row.physical_momentum_score,
    pfs: row.physical_force_score,
    pes: row.physical_energy_score,
    physicsUpRank: row.physics_up_rank,
    physicsDownRank: row.physics_down_rank,
    classicUpRank: row.classic_up_rank,
    classicDownRank: row.classic_down_rank,
    stages,
    evidenceChips: evidenceForSide(row, side, physicalStatusLabel, shortTerm.label),
    riskChips: riskForSide(row, side, physicalStatusLabel),
  }
}

async function loadJpRows(date: string | null, universe: UniverseFilterValue): Promise<{ rows: RawSignalRow[]; date: string | null }> {
  const universeSql = universeSqlCondition('ds.ticker', universe)
  const rows = await execAll<RawSignalRow>(
    `
    WITH target AS (
      SELECT COALESCE(
        (SELECT MAX(date) FROM daily_snapshots WHERE date <= ?),
        (SELECT MAX(date) FROM daily_snapshots)
      ) AS date
    ),
    price_date AS (
      SELECT MAX(date) AS date
      FROM ohlcv_daily
      WHERE date <= (SELECT date FROM target)
    ),
    prev_date AS (
      SELECT MAX(date) AS date
      FROM ohlcv_daily
      WHERE date < (SELECT date FROM price_date)
    ),
    physics_date AS (
      SELECT MAX(date) AS date
      FROM physical_momentum_metrics
      WHERE market = 'JP'
        AND date <= (SELECT date FROM target)
    ),
    avg30 AS (
      SELECT ticker, AVG(volume) AS avg_volume
      FROM ohlcv_daily
      WHERE date IN (
        SELECT date
        FROM ohlcv_daily
        WHERE date <= (SELECT date FROM target)
        GROUP BY date
        ORDER BY date DESC
        LIMIT 30
      )
      GROUP BY ticker
    ),
    feature_date AS (
      SELECT MAX(date) AS date
      FROM ml_feature_vectors_v2
      WHERE feature_set = ?
        AND date <= (SELECT date FROM target)
    ),
    physics_candidate_date AS (
      SELECT MAX(as_of_date) AS date
      FROM serving_ml_physics_candidates
      WHERE as_of_date <= (SELECT date FROM target)
    ),
    classic_candidate_date AS (
      SELECT MAX(as_of_date) AS date
      FROM serving_ml_candidates
      WHERE as_of_date <= (SELECT date FROM target)
    )
    SELECT
      'JP' AS market,
      ds.ticker,
      u.name,
      ds.date,
      cur.close AS price,
      prev.close AS prev_price,
      cur.volume,
      avg30.avg_volume,
      u.sector17_name,
      u.sector33_name,
      u.market_segment,
      u.margin_type,
      NULL AS exchange,
      NULL AS sector,
      NULL AS industry,
      ds.daily_a_stage,
      ds.daily_b_stage,
      ds.weekly_a_stage,
      ds.weekly_b_stage,
      ds.monthly_a_stage,
      ds.monthly_b_stage,
      pm.physical_momentum_score,
      pm.physical_force_score,
      pm.physical_energy_score,
      f.feature_json,
      p_up.rank AS physics_up_rank,
      p_down.rank AS physics_down_rank,
      c_up.rank AS classic_up_rank,
      c_down.rank AS classic_down_rank
    FROM target
    JOIN daily_snapshots ds ON ds.date = target.date
    LEFT JOIN ticker_universe u ON u.ticker = ds.ticker
    LEFT JOIN ohlcv_daily cur
      ON cur.ticker = ds.ticker
     AND cur.date = (SELECT date FROM price_date)
    LEFT JOIN ohlcv_daily prev
      ON prev.ticker = ds.ticker
     AND prev.date = (SELECT date FROM prev_date)
    LEFT JOIN avg30 ON avg30.ticker = ds.ticker
    LEFT JOIN physical_momentum_metrics pm
      ON pm.market = 'JP'
     AND pm.symbol = ds.ticker
     AND pm.date = (SELECT date FROM physics_date)
    LEFT JOIN ml_feature_vectors_v2 f
      ON f.ticker = ds.ticker
     AND f.feature_set = ?
     AND f.date = (SELECT date FROM feature_date)
    LEFT JOIN serving_ml_physics_candidates p_up
      ON p_up.ticker = ds.ticker
     AND p_up.as_of_date = (SELECT date FROM physics_candidate_date)
     AND p_up.horizon_days = ?
     AND p_up.direction = 'up'
    LEFT JOIN serving_ml_physics_candidates p_down
      ON p_down.ticker = ds.ticker
     AND p_down.as_of_date = (SELECT date FROM physics_candidate_date)
     AND p_down.horizon_days = ?
     AND p_down.direction = 'down'
    LEFT JOIN serving_ml_candidates c_up
      ON c_up.ticker = ds.ticker
     AND c_up.as_of_date = (SELECT date FROM classic_candidate_date)
     AND c_up.direction = 'up'
    LEFT JOIN serving_ml_candidates c_down
      ON c_down.ticker = ds.ticker
     AND c_down.as_of_date = (SELECT date FROM classic_candidate_date)
     AND c_down.direction = 'down'
    WHERE COALESCE(u.active, 1) = 1
      ${universeSql.sql ? `AND ${universeSql.sql}` : ''}
    LIMIT ?
    `,
    [
      date ?? '9999-12-31',
      ML_PHYSICS_FEATURE_SET,
      ML_PHYSICS_FEATURE_SET,
      DASHBOARD_HORIZON_DAYS,
      DASHBOARD_HORIZON_DAYS,
      ...universeSql.params,
      JP_QUERY_LIMIT,
    ],
  )
  return { rows, date: rows[0]?.date ?? null }
}

async function loadUsRows(date: string | null): Promise<{ rows: RawSignalRow[]; date: string | null }> {
  const target = await execGet<{ date: string | null }>(
    `
    SELECT COALESCE(
      (SELECT MAX(date) FROM market_daily_snapshots WHERE market = 'US' AND date <= ?),
      (SELECT MAX(date) FROM market_daily_snapshots WHERE market = 'US')
    ) AS date
    `,
    [date ?? '9999-12-31'],
  )
  const targetDate = target?.date ?? null
  if (!targetDate) return { rows: [], date: null }

  const metricMap = new Map<string, UsMetricRow>()
  const upRankMap = new Map<string, number | null>()
  const downRankMap = new Map<string, number | null>()
  const tickerSet = new Set<string>()

  if (hasUsAnalyticsDb()) {
    const [metricDate, candidateDate] = await Promise.all([
      execUsAnalyticsGet<{ date: string | null }>(
        `SELECT MAX(date) AS date FROM physical_momentum_metrics WHERE market = 'US' AND date <= ?`,
        [targetDate],
      ).catch(() => null),
      execUsAnalyticsGet<{ date: string | null }>(
        `SELECT MAX(as_of_date) AS date FROM serving_ml_physics_candidates WHERE as_of_date <= ?`,
        [targetDate],
      ).catch(() => null),
    ])

    if (metricDate?.date) {
      const [topPfs, topPms] = await Promise.all([
        execUsAnalyticsAll<UsMetricRow>(
          `
          SELECT symbol, physical_momentum_score, physical_force_score, physical_energy_score
          FROM physical_momentum_metrics
          WHERE market = 'US'
            AND date = ?
            AND physical_force_score IS NOT NULL
          ORDER BY physical_force_score DESC, symbol ASC
          LIMIT 650
          `,
          [metricDate.date],
        ).catch(() => []),
        execUsAnalyticsAll<UsMetricRow>(
          `
          SELECT symbol, physical_momentum_score, physical_force_score, physical_energy_score
          FROM physical_momentum_metrics
          WHERE market = 'US'
            AND date = ?
            AND physical_momentum_score IS NOT NULL
          ORDER BY physical_momentum_score DESC, symbol ASC
          LIMIT 650
          `,
          [metricDate.date],
        ).catch(() => []),
      ])
      for (const metric of [...topPfs, ...topPms]) {
        metricMap.set(metric.symbol, metric)
        tickerSet.add(metric.symbol)
      }
    }

    if (candidateDate?.date) {
      const candidates = await execUsAnalyticsAll<UsCandidateRow>(
        `
        SELECT ticker, direction, rank
        FROM serving_ml_physics_candidates
        WHERE as_of_date = ?
          AND horizon_days = ?
          AND direction IN ('up', 'down')
          AND rank <= 120
        `,
        [candidateDate.date, DASHBOARD_HORIZON_DAYS],
      ).catch(() => [])
      for (const candidate of candidates) {
        tickerSet.add(candidate.ticker)
        if (candidate.direction === 'up') upRankMap.set(candidate.ticker, candidate.rank)
        if (candidate.direction === 'down') downRankMap.set(candidate.ticker, candidate.rank)
      }
    }
  }

  if (tickerSet.size === 0) {
    const volumeRows = await execAll<{ ticker: string }>(
      `
      SELECT ticker
      FROM market_ohlcv_daily INDEXED BY market_ohlcv_market_date_ticker_idx
      WHERE market = 'US'
        AND date = ?
      ORDER BY volume DESC
      LIMIT 650
      `,
      [targetDate],
    )
    for (const row of volumeRows) tickerSet.add(row.ticker)
  }

  const tickers = Array.from(tickerSet).slice(0, 1300)
  if (tickers.length === 0) return { rows: [], date: targetDate }
  const placeholders = tickers.map(() => '?').join(',')
  const rows = await execAll<RawSignalRow>(
    `
    WITH prev_date AS (
      SELECT MAX(date) AS date
      FROM market_ohlcv_daily INDEXED BY market_ohlcv_market_date_idx
      WHERE market = 'US'
        AND date < ?
    )
    SELECT
      'US' AS market,
      s.ticker,
      COALESCE(u.name, s.ticker) AS name,
      s.date,
      cur.close AS price,
      prev.close AS prev_price,
      cur.volume,
      (
        SELECT AVG(v.volume)
        FROM (
          SELECT volume
          FROM market_ohlcv_daily INDEXED BY market_ohlcv_market_ticker_date_idx
          WHERE market = 'US'
            AND ticker = s.ticker
            AND date <= s.date
          ORDER BY date DESC
          LIMIT 20
        ) v
      ) AS avg_volume,
      NULL AS sector17_name,
      NULL AS sector33_name,
      NULL AS market_segment,
      NULL AS margin_type,
      u.exchange,
      COALESCE(c.sector_name, u.sector) AS sector,
      COALESCE(c.industry_name, u.industry) AS industry,
      s.daily_a_stage,
      s.daily_b_stage,
      s.weekly_a_stage,
      s.weekly_b_stage,
      s.monthly_a_stage,
      s.monthly_b_stage,
      NULL AS physical_momentum_score,
      NULL AS physical_force_score,
      NULL AS physical_energy_score,
      NULL AS feature_json,
      NULL AS physics_up_rank,
      NULL AS physics_down_rank,
      NULL AS classic_up_rank,
      NULL AS classic_down_rank
    FROM market_daily_snapshots s INDEXED BY market_snapshots_market_date_ticker_idx
    LEFT JOIN market_universe u ON u.market = 'US' AND u.ticker = s.ticker
    LEFT JOIN market_classifications c
      ON c.market = 'US'
     AND c.ticker = s.ticker
     AND c.taxonomy = ?
     AND c.effective_from = '0000-01-01'
    LEFT JOIN market_ohlcv_daily cur INDEXED BY market_ohlcv_market_ticker_date_idx
      ON cur.market = 'US'
     AND cur.ticker = s.ticker
     AND cur.date = s.date
    LEFT JOIN market_ohlcv_daily prev INDEXED BY market_ohlcv_market_ticker_date_idx
      ON prev.market = 'US'
     AND prev.ticker = s.ticker
     AND prev.date = (SELECT date FROM prev_date)
    WHERE s.market = 'US'
      AND s.date = ?
      AND s.ticker IN (${placeholders})
      AND COALESCE(u.active, 1) = 1
    ORDER BY avg_volume DESC NULLS LAST, s.ticker ASC
    LIMIT ?
    `,
    [targetDate, US_SEC_SIC_TAXONOMY, targetDate, ...tickers, US_QUERY_LIMIT],
  )

  for (const row of rows) {
    const metric = metricMap.get(row.ticker)
    if (metric) {
      row.physical_momentum_score = metric.physical_momentum_score
      row.physical_force_score = metric.physical_force_score
      row.physical_energy_score = metric.physical_energy_score
    }
    row.feature_json = null
    row.physics_up_rank = upRankMap.get(row.ticker) ?? null
    row.physics_down_rank = downRankMap.get(row.ticker) ?? null
  }

  return { rows, date: rows[0]?.date ?? null }
}

export async function getDashboardTradeSignals(params: {
  date?: string | null
  universe?: UniverseFilterValue
} = {}): Promise<DashboardTradeSignalResult> {
  const [jp, us] = await Promise.all([
    loadJpRows(params.date ?? null, params.universe ?? null),
    params.universe ? Promise.resolve({ rows: [] as RawSignalRow[], date: null }) : loadUsRows(params.date ?? null),
  ])

  const candidates: DashboardTradeSignalRow[] = []
  for (const row of jp.rows) {
    const buy = buildCandidate(row, 'buy')
    const sell = buildCandidate(row, 'short')
    if (buy) candidates.push(buy)
    if (sell) candidates.push(sell)
  }
  for (const row of us.rows) {
    const buy = buildCandidate(row, 'buy')
    if (buy) candidates.push(buy)
  }

  const rows = candidates
    .sort((a, b) => {
      if (b.confidenceScore !== a.confidenceScore) return b.confidenceScore - a.confidenceScore
      return (b.avgVolume ?? 0) - (a.avgVolume ?? 0)
    })
    .slice(0, 240)

  return {
    rows,
    jpDate: jp.date,
    usDate: us.date,
    generatedAt: new Date().toISOString(),
    horizonDays: DASHBOARD_HORIZON_DAYS,
  }
}
