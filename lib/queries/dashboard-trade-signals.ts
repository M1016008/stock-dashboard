import { execAll, execGet } from '@/lib/db/client'
import { execUsAnalyticsAll, execUsAnalyticsGet, hasUsAnalyticsDb } from '@/lib/db/us-analytics'
import { ML_PHYSICS_FEATURE_SET } from '@/lib/backtest/ml-physics'
import { buildShortTermCheck, type ShortTermCheckLabel } from '@/lib/short-term-check'
import { analyzePhysicsProfile, type PhysicsStatus } from '@/lib/ml/physics-analysis'
import { getUsDisplayName } from '@/lib/us-symbol-aliases'
import { type UniverseFilterValue, universeSqlCondition } from '@/lib/market-universe'
import { US_SEC_SIC_TAXONOMY } from '@/lib/us-classification'
import {
  buildStockScenarioProjection,
  defaultProjectionHorizon,
  normalizeProjectionInterval,
  type ProjectionDirection,
  type ProjectionResponse,
  type ScenarioInterval,
} from '@/lib/stock-scenarios/projections'

const DASHBOARD_HORIZON_DAYS = 20
const JP_QUERY_LIMIT = 7000
const US_QUERY_LIMIT = 2500
const MIN_DASHBOARD_SCORE = 60
const MAX_ROWS_PER_MARKET_SIDE = 80
const SCENARIO_ENRICH_CONCURRENCY = 6
const US_LEVERAGED_INVERSE_ETP_TICKERS = new Set([
  'AGQ',
  'BOIL',
  'DUST',
  'DUG',
  'DXD',
  'EDC',
  'EDZ',
  'ERX',
  'ERY',
  'FAZ',
  'FAS',
  'GDXD',
  'GDXU',
  'GUSH',
  'HIBL',
  'HIBS',
  'KOLD',
  'LABD',
  'LABU',
  'NUGT',
  'PSQ',
  'QID',
  'QLD',
  'SCO',
  'SDOW',
  'SDS',
  'SH',
  'SOXL',
  'SOXS',
  'SPXL',
  'SPXS',
  'SPXU',
  'SQQQ',
  'SVXY',
  'TBT',
  'TECL',
  'TECS',
  'TNA',
  'TQQQ',
  'TWM',
  'TZA',
  'UCO',
  'UPRO',
  'UVXY',
  'VXX',
  'YANG',
  'YINN',
  'ZSL',
])

export type DashboardTradeSignalSide = 'buy' | 'sell'
export type DashboardTradeSignalMarket = 'JP' | 'US'
export type DashboardScenarioInterval = ScenarioInterval
export type DashboardScenarioDecisionTone = 'constructive' | 'caution' | 'neutral' | 'conflict'

const SCENARIO_INTERVAL_LABELS: Record<ScenarioInterval, string> = {
  D: '1日',
  '2D': '2日',
  W: '1週間',
  '2W': '2週間',
  M: '1か月',
  '2M': '2か月',
}

export function dashboardScenarioIntervalLabel(interval: ScenarioInterval): string {
  return SCENARIO_INTERVAL_LABELS[interval] ?? interval
}

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
  industry17: string
  industry33: string
  marketSegment: string | null
  marginType: string | null
  confidenceScore: number
  confidenceBand: 'high' | 'candidate'
  primaryLabel: ShortTermCheckLabel | '売り候補'
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
  scenario: DashboardScenarioSignal | null
  technicalChips: string[]
  evidenceChips: string[]
  riskChips: string[]
}

export interface DashboardScenarioSignal {
  baseDate: string
  interval: ScenarioInterval
  intervalLabel: string
  horizonDays: number
  leader: ProjectionDirection | 'mixed'
  upWeightPct: number
  downWeightPct: number
  rangeWeightPct: number
  sideWeightPct: number
  oppositeWeightPct: number
  scenarioScore: number
  topLabel: string
  topDirection: ProjectionDirection
  topScore: number
  alignedLabel: string | null
  alignedScore: number | null
  targetPrice: number | null
  stopPrice: number | null
  invalidation: string | null
  decisionSummary: string
  decisionPoints: string[]
  decisionTone: DashboardScenarioDecisionTone
  evidence: string[]
}

export interface DashboardTradeSignalResult {
  rows: DashboardTradeSignalRow[]
  jpDate: string | null
  usDate: string | null
  generatedAt: string
  horizonDays: number
  scenarioInterval: ScenarioInterval
  scenarioIntervalLabel: string
  scenarioHorizonDays: number
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

function round(value: number | null | undefined, digits = 1): number | null {
  if (!finite(value)) return null
  const scale = 10 ** digits
  return Math.round(value * scale) / scale
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

function recordAt(value: unknown, key: string): Record<string, unknown> | null {
  if (!value || typeof value !== 'object') return null
  const next = (value as Record<string, unknown>)[key]
  return next && typeof next === 'object' ? next as Record<string, unknown> : null
}

function boolAt(value: unknown, path: string[]): boolean | null {
  let current: unknown = value
  for (const key of path) {
    if (!current || typeof current !== 'object') return null
    current = (current as Record<string, unknown>)[key]
  }
  return typeof current === 'boolean' ? current : null
}

function numAt(value: unknown, path: string[]): number | null {
  let current: unknown = value
  for (const key of path) {
    if (!current || typeof current !== 'object') return null
    current = (current as Record<string, unknown>)[key]
  }
  return num(current)
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

function buildTechnicalChips(
  row: RawSignalRow,
  feature: Record<string, unknown> | null,
  side: DashboardTradeSignalSide,
): string[] {
  const bullish: string[] = []
  const bearish: string[] = []
  const neutral: string[] = []

  if (boolAt(feature, ['crosses', 'upSma5'])) bullish.push('日足: 5日線上抜け')
  if (boolAt(feature, ['crosses', 'downSma5'])) bearish.push('日足: 5日線下抜け')
  if (boolAt(feature, ['crosses', 'upSma25'])) bullish.push('日足: 25日線上抜け')
  if (boolAt(feature, ['crosses', 'downSma25'])) bearish.push('日足: 25日線下抜け')

  const daily5 = numAt(feature, ['pricePosition', 'sma5'])
  const daily25 = numAt(feature, ['pricePosition', 'sma25'])
  if (finite(daily5) && finite(daily25)) {
    if (daily5 > 0 && daily25 > 0) bullish.push('日足: 5/25日線上')
    if (daily5 < 0 && daily25 < 0) bearish.push('日足: 5/25日線下')
  }

  const bundleVelocity = numAt(feature, ['bundleWidthVelocity5'])
  if (finite(bundleVelocity)) {
    if (bundleVelocity < -0.2) neutral.push('日足: MA束収縮')
    if (bundleVelocity > 0.25) neutral.push('日足: MA束拡散')
  }

  const weekly = recordAt(recordAt(feature, 'multiTimeframe'), 'weekly')
  const weekly5 = numAt(weekly, ['pricePosition', 'ma5'])
  const weekly13 = numAt(weekly, ['pricePosition', 'ma13'])
  const weekly5Slope = numAt(weekly, ['velocities', 'ma5', 'd5'])
  if (finite(weekly5) && finite(weekly13)) {
    if (weekly5 > 0 && weekly13 > 0) bullish.push('週足: 5/13週線上')
    if (weekly5 < 0 && weekly13 < 0) bearish.push('週足: 5/13週線下')
  }
  if (finite(weekly5) && finite(weekly5Slope)) {
    if (weekly5 > 0 && weekly5Slope > 0) bullish.push('週足: 5週線上向き')
    if (weekly5 < 0 && weekly5Slope < 0) bearish.push('週足: 5週線下向き')
  }

  const twoDay = recordAt(recordAt(feature, 'multiTimeframe'), 'twoDay')
  const twoDay5 = numAt(twoDay, ['pricePosition', 'ma5'])
  const twoDay25 = numAt(twoDay, ['pricePosition', 'ma25'])
  if (finite(twoDay5) && finite(twoDay25)) {
    if (twoDay5 > 0 && twoDay25 > 0) bullish.push('2日足: 5/25本線上')
    if (twoDay5 < 0 && twoDay25 < 0) bearish.push('2日足: 5/25本線下')
  }

  const trend = recordAt(feature, 'regimes')?.trend
  if (trend === 'up_acceleration') bullish.push('物理: 上昇加速')
  if (trend === 'down_acceleration') bearish.push('物理: 下落加速')
  if (trend === 'reversal_down') bearish.push('物理: 反落警戒')
  if (trend === 'reversal_up') bullish.push('物理: 反発兆候')

  if (row.daily_a_stage === 1 || row.daily_a_stage === 6) bullish.push(`日A: S${row.daily_a_stage}`)
  if (row.daily_a_stage === 3 || row.daily_a_stage === 4) bearish.push(`日A: S${row.daily_a_stage}`)
  if (row.weekly_a_stage === 1 || row.weekly_a_stage === 6) bullish.push(`週A: S${row.weekly_a_stage}`)
  if (row.weekly_a_stage === 3 || row.weekly_a_stage === 4) bearish.push(`週A: S${row.weekly_a_stage}`)

  const ordered = side === 'sell'
    ? [...bearish, ...neutral, ...bullish]
    : [...bullish, ...neutral, ...bearish]
  return Array.from(new Set(ordered)).slice(0, 7)
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
    if (row.market === 'JP' && row.margin_type === '貸借') chips.push('貸借')
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

function isExcludedDashboardInstrument(row: RawSignalRow): boolean {
  const ticker = row.ticker.toUpperCase()
  const name = row.name ?? ''
  const sector17 = row.sector17_name ?? ''
  const sector33 = row.sector33_name ?? ''
  const text = `${row.ticker} ${name} ${sector17} ${sector33}`.toLowerCase()
  const jpText = `${row.ticker} ${name} ${sector17} ${sector33}`

  if (row.market === 'US' && US_LEVERAGED_INVERSE_ETP_TICKERS.has(ticker)) return true

  const isEtfLike =
    /ETF|ＥＴＦ|上場投信|上場投資信託|投資信託|投信投資顧問|投資法人|REIT|ＲＥＩＴ/i.test(jpText)
  const isLeveragedOrInverse =
    /インバース|ダブルインバース|ベア|ブル|レバレッジ|先物|指数連動|leveraged|inverse|ultra|bear|bull/.test(text)
  const isOtherFund =
    (sector17 === 'その他' || sector33 === 'その他') &&
    /ETF|ＥＴＦ|投信|投資信託|投資顧問|指数連動|インバース|レバレッジ/i.test(jpText)

  return isLeveragedOrInverse || isEtfLike || isOtherFund
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
  if (isExcludedDashboardInstrument(row)) return null

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
  const sellScore = clamp(
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
  const score = side === 'buy' ? buyScore : sellScore
  if (score < MIN_DASHBOARD_SCORE) return null
  if (side === 'buy' && sellScore > buyScore + 4) return null
  if (side === 'sell' && buyScore >= sellScore) return null

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
    industry17: row.market === 'US' ? row.sector || '未分類' : row.sector17_name || '未分類',
    industry33: row.market === 'US' ? row.industry || row.sector || '未分類' : row.sector33_name || row.sector17_name || '未分類',
    marketSegment: row.market === 'US' ? row.exchange : row.market_segment,
    marginType: row.margin_type,
    confidenceScore: Math.round(score),
    confidenceBand: score >= 75 ? 'high' : 'candidate',
    primaryLabel: side === 'sell' ? '売り候補' : shortTerm.label,
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
    scenario: null,
    technicalChips: buildTechnicalChips(row, parsedFeature, side),
    evidenceChips: evidenceForSide(row, side, physicalStatusLabel, shortTerm.label),
    riskChips: riskForSide(row, side, physicalStatusLabel),
  }
}

function scenarioLeader(upWeightPct: number, downWeightPct: number, rangeWeightPct: number): ProjectionDirection | 'mixed' {
  const ranked = [
    ['up', upWeightPct],
    ['down', downWeightPct],
    ['range', rangeWeightPct],
  ] as Array<[ProjectionDirection, number]>
  ranked.sort((a, b) => b[1] - a[1])
  const [leader, top] = ranked[0] ?? ['range', 0]
  const second = ranked[1]?.[1] ?? 0
  if (top < 38 || top - second < 6) return 'mixed'
  return leader
}

function scenarioDecision(
  side: DashboardTradeSignalSide,
  leader: ProjectionDirection | 'mixed',
  sideWeightPct: number,
  oppositeWeightPct: number,
  rangeWeightPct: number,
  score: number,
  invalidation: string | null,
): { summary: string; points: string[]; tone: DashboardScenarioDecisionTone } {
  const sideLabel = side === 'buy' ? '買い目線' : '売り目線'
  const sideDirectionLabel = side === 'buy' ? '上昇' : '下落'
  const oppositeDirectionLabel = side === 'buy' ? '下落' : '反発'
  const invalidationPoint = invalidation ? `崩れる条件: ${invalidation}` : null
  const withInvalidation = (points: string[]) => invalidationPoint ? [...points, invalidationPoint] : points

  if (sideWeightPct >= 48 && sideWeightPct - oppositeWeightPct >= 14 && score >= 70) {
    const points = withInvalidation([
      `${sideLabel}: ${sideDirectionLabel}シナリオ優勢`,
      `重み: ${sideWeightPct.toFixed(1)}% 対 ${oppositeDirectionLabel}${oppositeWeightPct.toFixed(1)}%`,
      '見方: 目標と撤退条件を先に決め、同方向の継続を確認',
    ])
    return {
      summary: points.join(' / '),
      points,
      tone: side === 'buy' ? 'constructive' : 'caution',
    }
  }

  if (sideWeightPct >= 40 && sideWeightPct >= oppositeWeightPct) {
    const points = withInvalidation([
      `${sideLabel}: ${sideDirectionLabel}シナリオやや優勢`,
      `重み: ${sideWeightPct.toFixed(1)}% 対 ${oppositeDirectionLabel}${oppositeWeightPct.toFixed(1)}%`,
      '見方: 差は大きくない。出来高・MA位置・失効条件を確認して追う候補',
    ])
    return {
      summary: points.join(' / '),
      points,
      tone: side === 'buy' ? 'constructive' : 'caution',
    }
  }

  if (oppositeWeightPct >= sideWeightPct + 8) {
    const points = withInvalidation([
      `${sideLabel}: 反対側が優勢`,
      `重み: ${oppositeDirectionLabel}${oppositeWeightPct.toFixed(1)}% が上回る`,
      '見方: 無理に入らず、形が崩れるか再加速するかを確認',
    ])
    return {
      summary: points.join(' / '),
      points,
      tone: 'conflict',
    }
  }

  if (leader === 'range' || rangeWeightPct >= 34) {
    const points = withInvalidation([
      '方向感: 横ばい・保ち合いの重み大',
      `横ばい: ${rangeWeightPct.toFixed(1)}%`,
      '見方: 上抜け/下抜け後に再評価',
    ])
    return {
      summary: points.join(' / '),
      points,
      tone: 'neutral',
    }
  }

  const points = withInvalidation([
    `${sideLabel}: 優劣は薄い`,
    `重み: ${sideDirectionLabel}${sideWeightPct.toFixed(1)}% / ${oppositeDirectionLabel}${oppositeWeightPct.toFixed(1)}%`,
    '見方: 監視候補。方向が出るまで待つ',
  ])
  return {
    summary: points.join(' / '),
    points,
    tone: 'neutral',
  }
}

function buildScenarioSignal(projection: ProjectionResponse, side: DashboardTradeSignalSide): DashboardScenarioSignal | null {
  if (projection.scenarios.length === 0) return null
  const totals: Record<ProjectionDirection, number> = { up: 0, down: 0, range: 0 }
  for (const scenario of projection.scenarios) {
    totals[scenario.direction] += scenario.relativeWeightPct
  }
  const sideDirection: ProjectionDirection = side === 'buy' ? 'up' : 'down'
  const oppositeDirection: ProjectionDirection = side === 'buy' ? 'down' : 'up'
  const topScenario = projection.scenarios[0]
  const alignedScenario =
    projection.scenarios.find((scenario) => scenario.direction === sideDirection) ??
    null
  const sideWeight = totals[sideDirection]
  const oppositeWeight = totals[oppositeDirection]
  const alignment = sideWeight - oppositeWeight
  const confidenceBasis = alignedScenario?.score ?? Math.max(0, topScenario.score - 16)
  const topDirectionBonus = topScenario.direction === sideDirection ? 8 : topScenario.direction === 'range' ? -4 : -10
  const liftBonus = projection.stats.lift && projection.stats.lift > 1 ? Math.min(8, (projection.stats.lift - 1) * 10) : 0
  const score = clamp(
    confidenceBasis * 0.72
    + alignment * 0.38
    + topDirectionBonus
    + liftBonus
    + (sideWeight >= 45 ? 6 : 0)
    - (sideWeight < 26 ? 8 : 0),
  )
  const leader = scenarioLeader(totals.up, totals.down, totals.range)
  const invalidation = alignedScenario?.invalidation ?? topScenario.invalidation ?? null
  const decision = scenarioDecision(
    side,
    leader,
    round(sideWeight, 1) ?? 0,
    round(oppositeWeight, 1) ?? 0,
    round(totals.range, 1) ?? 0,
    score,
    invalidation,
  )
  return {
    baseDate: projection.baseDate,
    interval: projection.interval,
    intervalLabel: dashboardScenarioIntervalLabel(projection.interval),
    horizonDays: projection.horizonDays,
    leader,
    upWeightPct: round(totals.up, 1) ?? 0,
    downWeightPct: round(totals.down, 1) ?? 0,
    rangeWeightPct: round(totals.range, 1) ?? 0,
    sideWeightPct: round(sideWeight, 1) ?? 0,
    oppositeWeightPct: round(oppositeWeight, 1) ?? 0,
    scenarioScore: Math.round(score),
    topLabel: topScenario.label,
    topDirection: topScenario.direction,
    topScore: topScenario.score,
    alignedLabel: alignedScenario?.label ?? null,
    alignedScore: alignedScenario?.score ?? null,
    targetPrice: alignedScenario?.targetPrice ?? topScenario.targetPrice,
    stopPrice: alignedScenario?.stopPrice ?? topScenario.stopPrice,
    invalidation,
    decisionSummary: decision.summary,
    decisionPoints: decision.points,
    decisionTone: decision.tone,
    evidence: (alignedScenario?.evidence ?? topScenario.evidence).slice(0, 4),
  }
}

function scenarioEvidenceChips(signal: DashboardScenarioSignal, side: DashboardTradeSignalSide): string[] {
  const directionLabel = side === 'buy' ? '上昇' : '下落'
  const chips = [
    `シナリオ${directionLabel}${signal.sideWeightPct.toFixed(1)}%`,
    `#1 ${signal.topLabel}`,
  ]
  if (signal.alignedLabel && signal.alignedLabel !== signal.topLabel) chips.push(signal.alignedLabel)
  for (const evidence of signal.evidence) {
    if (/^PMS|^PFS|^PES|過去検証/.test(evidence)) continue
    chips.push(evidence)
  }
  if (signal.scenarioScore >= 75) chips.push('シナリオ強')
  return Array.from(new Set(chips)).slice(0, 7)
}

function scenarioRiskChips(signal: DashboardScenarioSignal, side: DashboardTradeSignalSide): string[] {
  const oppositeLabel = side === 'buy' ? '下落' : '上昇'
  const chips: string[] = []
  if (signal.oppositeWeightPct >= 32) chips.push(`${oppositeLabel}${signal.oppositeWeightPct.toFixed(1)}%`)
  if (signal.leader === 'mixed') chips.push('シナリオ拮抗')
  if (signal.topDirection === 'range') chips.push('横ばい優勢')
  return chips
}

function applyScenarioToRow(row: DashboardTradeSignalRow, signal: DashboardScenarioSignal | null): DashboardTradeSignalRow {
  if (!signal) return row
  const sideMatchesTop = (row.side === 'buy' && signal.topDirection === 'up') || (row.side === 'sell' && signal.topDirection === 'down')
  const sideWeightPenalty = signal.sideWeightPct < 30 ? -10 : 0
  const dominanceBonus = clamp((signal.sideWeightPct - signal.oppositeWeightPct) * 0.08, -5, 5)
  const adjustedScore = clamp(
    row.confidenceScore * 0.22
    + signal.scenarioScore * 0.78
    + (sideMatchesTop ? 4 : -6)
    + sideWeightPenalty
    + dominanceBonus,
  )
  return {
    ...row,
    confidenceScore: Math.round(adjustedScore),
    confidenceBand: adjustedScore >= 75 ? 'high' : 'candidate',
    scenario: signal,
    evidenceChips: Array.from(new Set([...scenarioEvidenceChips(signal, row.side), ...row.evidenceChips])).slice(0, 7),
    riskChips: Array.from(new Set([...scenarioRiskChips(signal, row.side), ...row.riskChips])).slice(0, 5),
  }
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  mapper: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length)
  let nextIndex = 0
  async function worker() {
    while (nextIndex < items.length) {
      const index = nextIndex
      nextIndex += 1
      results[index] = await mapper(items[index], index)
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker))
  return results
}

async function enrichScenarioSignals(
  rows: DashboardTradeSignalRow[],
  date: string | null,
  scenarioInterval: ScenarioInterval,
  scenarioHorizonDays: number,
): Promise<DashboardTradeSignalRow[]> {
  const uniqueRows = new Map<string, DashboardTradeSignalRow>()
  for (const row of rows) {
    uniqueRows.set(`${row.market}:${row.ticker}`, row)
  }
  const projectionPairs = await mapWithConcurrency(Array.from(uniqueRows.values()), SCENARIO_ENRICH_CONCURRENCY, async (row) => {
    const key = `${row.market}:${row.ticker}`
    try {
      const projection = await buildStockScenarioProjection({
        ticker: row.ticker,
        market: row.market,
        interval: scenarioInterval,
        horizonDays: scenarioHorizonDays,
        limit: 8,
        asOfDate: date ?? null,
      })
      return [key, projection] as const
    } catch {
      return [key, null] as const
    }
  })
  const projectionMap = new Map(projectionPairs)
  return rows.map((row) => {
    const projection = projectionMap.get(`${row.market}:${row.ticker}`)
    return applyScenarioToRow(row, projection ? buildScenarioSignal(projection, row.side) : null)
  })
}

function selectDashboardTradeRows(rows: DashboardTradeSignalRow[]): DashboardTradeSignalRow[] {
  return (['JP', 'US'] as const).flatMap((market) => (
    (['buy', 'sell'] as const).flatMap((side) => (
      rows
        .filter((row) => row.market === market && row.side === side)
        .sort((a, b) => {
          if (b.confidenceScore !== a.confidenceScore) return b.confidenceScore - a.confidenceScore
          return (b.avgVolume ?? 0) - (a.avgVolume ?? 0)
        })
        .slice(0, MAX_ROWS_PER_MARKET_SIDE)
    ))
  ))
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
  scenarioInterval?: string | null
} = {}): Promise<DashboardTradeSignalResult> {
  const scenarioInterval = normalizeProjectionInterval(params.scenarioInterval)
  const scenarioHorizonDays = defaultProjectionHorizon(scenarioInterval)
  const [jp, us] = await Promise.all([
    loadJpRows(params.date ?? null, params.universe ?? null),
    params.universe ? Promise.resolve({ rows: [] as RawSignalRow[], date: null }) : loadUsRows(params.date ?? null),
  ])

  const candidates: DashboardTradeSignalRow[] = []
  for (const row of jp.rows) {
    const buy = buildCandidate(row, 'buy')
    const sell = buildCandidate(row, 'sell')
    if (buy) candidates.push(buy)
    if (sell) candidates.push(sell)
  }
  for (const row of us.rows) {
    const buy = buildCandidate(row, 'buy')
    const sell = buildCandidate(row, 'sell')
    if (buy) candidates.push(buy)
    if (sell) candidates.push(sell)
  }

  const displayCandidates = selectDashboardTradeRows(candidates)
  const scenarioCandidates = await enrichScenarioSignals(displayCandidates, params.date ?? null, scenarioInterval, scenarioHorizonDays)
  const rows = selectDashboardTradeRows(scenarioCandidates)

  return {
    rows,
    jpDate: jp.date,
    usDate: us.date,
    generatedAt: new Date().toISOString(),
    horizonDays: DASHBOARD_HORIZON_DAYS,
    scenarioInterval,
    scenarioIntervalLabel: dashboardScenarioIntervalLabel(scenarioInterval),
    scenarioHorizonDays,
  }
}
