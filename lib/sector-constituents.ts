import type { StageLevel } from '@/lib/hex-stage'
import type { UniverseFilterValue } from '@/lib/market-universe'
import type { PhysicsStatus, PullbackVerdict } from '@/lib/ml/physics-analysis'
import type { SectorStructureAxisKey, SectorStructureTaxonomy } from '@/lib/sector-structure'
import type { ShortTermCheckLabel, ShortTermCheckTone } from '@/lib/short-term-check'

export type SectorDecisionStrategy = 'up_emerging' | 'up_continuation' | 'reversal' | 'risk'
export type SectorConstituentPreset = 'all' | SectorDecisionStrategy | 'down_emerging' | 'down_continuation'
export type SectorMaDirection = 'all' | 'up' | 'down'
export type SectorMaOrder = 'all' | 'bullish' | 'bearish' | 'converging' | 'other'
export type SectorConstituentSort = 'strategyMatch' | 'trendScore' | 'changePct' | 'marketCap' | 'ticker'

export const SECTOR_DECISION_PRESETS: SectorConstituentPreset[] = [
  'all',
  'up_emerging',
  'up_continuation',
  'reversal',
  'risk',
]

export const SECTOR_CONSTITUENT_PRESETS: Record<SectorConstituentPreset, { label: string; description: string }> = {
  all: { label: '全戦略', description: '各銘柄に最も一致する戦略を表示' },
  up_emerging: { label: '上昇初動', description: '業種改善・ステージ好転・短期反発の重なりを確認' },
  up_continuation: { label: '上昇継続', description: '強い業種・上位足・MA上向きの整合を確認' },
  reversal: { label: '反転候補', description: '弱い業種の改善と収束・反発準備を確認' },
  risk: { label: '失速・下落警戒', description: '業種悪化・ステージ悪化・下向き加速を確認' },
  down_emerging: { label: '下落初動', description: '旧URL互換: 失速・下落警戒として判定' },
  down_continuation: { label: '下落継続', description: '旧URL互換: 下落構造の継続として判定' },
}

export type SectorDecisionContext = {
  trendStructureScore: number | null
  momentum10d: number | null
  marketTrendStructureScore: number | null
}

export type SectorStrategyCriterionKey = 'sector' | 'transition' | 'higherTimeframe' | 'movingAverage' | 'shortTerm'

export type SectorStrategyCriterion = {
  key: SectorStrategyCriterionKey
  label: string
  matched: boolean
  detail: string
}

export type SectorStrategyEvaluation = {
  strategy: SectorDecisionStrategy
  label: string
  matchCount: number
  totalCriteria: 5
  criteria: SectorStrategyCriterion[]
  reasons: string[]
  primaryRisk: string
}

export type SectorConstituentFilters = {
  preset: SectorConstituentPreset
  stages: Partial<Record<SectorStructureAxisKey, StageLevel[]>>
  maDirection: SectorMaDirection
  maMinCount: number
  maOrder: SectorMaOrder
  scoreMin: number | null
  scoreMax: number | null
  changeMin: number | null
  changeMax: number | null
  marketCapMin: number | null
  volumeMin: number | null
  sort: SectorConstituentSort
  sortDir: 'asc' | 'desc'
  offset: number
}

export type SectorFilteredConstituent = {
  ticker: string
  name: string | null
  price: number | null
  changePct: number | null
  marketCap: number | null
  volume: number | null
  stages: Record<SectorStructureAxisKey, number | null>
  stageCode: string | null
  trendStructureScore: number | null
  trendStructureLabel: string
  maUpCount: number
  maDownCount: number
  maValidCount: number
  maOrder: Exclude<SectorMaOrder, 'all'>
  improvingTransitions: number
  deterioratingTransitions: number
  higherUpAlignment: number
  higherDownAlignment: number
  physicalMomentumScore: number | null
  physicalForceScore: number | null
  physicalEnergyScore: number | null
  physicsStatus: PhysicsStatus
  pullbackVerdict: PullbackVerdict
  physicsStatusConfidence: number | null
  physicsStatusSampleCount: number | null
  shortTermCheckLabel: ShortTermCheckLabel
  shortTermCheckTone: ShortTermCheckTone
  shortTermCheckScore: number
  shortTermCheckReasons: string[]
  shortTermCheckMlText: string
  mlSimilarCount: number
  mlTopSimilarity: number | null
  strategyEvaluation: SectorStrategyEvaluation
}

export type SectorFilteredConstituentPage = {
  taxonomy: SectorStructureTaxonomy
  groupKey: string
  groupName: string
  date: string
  universe: UniverseFilterValue
  total: number
  items: SectorFilteredConstituent[]
  nextOffset: number | null
  physicsFeatureDate: string | null
  physicsCalibrationDate: string | null
  presetDescription: string
  decisionContext: SectorDecisionContext
}

type StrategyCandidate = Pick<
  SectorFilteredConstituent,
  | 'trendStructureScore'
  | 'maUpCount'
  | 'maDownCount'
  | 'maOrder'
  | 'improvingTransitions'
  | 'deterioratingTransitions'
  | 'higherUpAlignment'
  | 'higherDownAlignment'
  | 'physicsStatus'
  | 'pullbackVerdict'
  | 'shortTermCheckLabel'
>

const STRATEGY_LABELS: Record<SectorDecisionStrategy, string> = {
  up_emerging: '上昇初動',
  up_continuation: '上昇継続',
  reversal: '反転候補',
  risk: '失速・下落警戒',
}

function criterion(
  key: SectorStrategyCriterionKey,
  label: string,
  matched: boolean,
  detail: string,
): SectorStrategyCriterion {
  return { key, label, matched, detail }
}

function positiveSignal(item: StrategyCandidate) {
  return ['上昇加速', '上昇継続', '押し目形成', '反発準備'].includes(item.physicsStatus)
    || (item.physicsStatus === '算出待ち' && ['強気優勢', '好転候補'].includes(item.shortTermCheckLabel))
}

function reversalSignal(item: StrategyCandidate) {
  return ['押し目形成', '反発準備'].includes(item.physicsStatus)
    || item.pullbackVerdict === '本物の押し目に近い'
    || (item.physicsStatus === '算出待ち' && item.shortTermCheckLabel === '好転候補')
}

function negativeSignal(item: StrategyCandidate) {
  return ['失速警戒', '下落加速'].includes(item.physicsStatus)
    || (item.physicsStatus === '算出待ち' && ['弱含み注意', '下落警戒'].includes(item.shortTermCheckLabel))
}

function maOrderLabel(order: StrategyCandidate['maOrder']) {
  return order === 'bullish' ? '上昇順行' : order === 'bearish' ? '下降逆行' : order === 'converging' ? '収束' : 'その他'
}

export function evaluateSectorStrategy(
  item: StrategyCandidate,
  strategy: SectorDecisionStrategy,
  context: SectorDecisionContext,
): SectorStrategyEvaluation {
  const sectorScore = context.trendStructureScore
  const marketDiff = sectorScore != null && context.marketTrendStructureScore != null
    ? sectorScore - context.marketTrendStructureScore
    : null
  const improving = (context.momentum10d ?? 0) > 0
  const deteriorating = (context.momentum10d ?? 0) < 0
  let criteria: SectorStrategyCriterion[]

  if (strategy === 'up_continuation') {
    criteria = [
      criterion('sector', '業種構造', (sectorScore ?? -Infinity) >= 60 && (marketDiff ?? 0) >= 0, `業種${sectorScore?.toFixed(1) ?? '---'} / 市場差${marketDiff == null ? '---' : `${marketDiff >= 0 ? '+' : ''}${marketDiff.toFixed(1)}pt`}`),
      criterion('transition', 'ステージ変化', item.improvingTransitions >= item.deterioratingTransitions, `改善${item.improvingTransitions} / 悪化${item.deterioratingTransitions}`),
      criterion('higherTimeframe', '上位足', item.higherUpAlignment >= 58, `上昇整合${item.higherUpAlignment.toFixed(0)}%`),
      criterion('movingAverage', 'MA構造', item.maUpCount >= 3 || item.maOrder === 'bullish', `上向き${item.maUpCount}本 / ${maOrderLabel(item.maOrder)}`),
      criterion('shortTerm', '短期・物理', positiveSignal(item), `${item.shortTermCheckLabel} / ${item.physicsStatus}`),
    ]
  } else if (strategy === 'reversal') {
    criteria = [
      criterion('sector', '業種構造', (sectorScore ?? 100) < 60 && improving, `業種${sectorScore?.toFixed(1) ?? '---'} / 10日${context.momentum10d == null ? '---' : `${context.momentum10d >= 0 ? '+' : ''}${context.momentum10d.toFixed(1)}`}`),
      criterion('transition', 'ステージ変化', item.improvingTransitions > item.deterioratingTransitions, `改善${item.improvingTransitions} / 悪化${item.deterioratingTransitions}`),
      criterion('higherTimeframe', '上位足', item.higherDownAlignment < 58, `下落整合${item.higherDownAlignment.toFixed(0)}%`),
      criterion('movingAverage', 'MA構造', item.maOrder === 'converging' || item.maUpCount >= 2, `${maOrderLabel(item.maOrder)} / 上向き${item.maUpCount}本`),
      criterion('shortTerm', '短期・物理', reversalSignal(item), `${item.shortTermCheckLabel} / ${item.physicsStatus}`),
    ]
  } else if (strategy === 'risk') {
    criteria = [
      criterion('sector', '業種構造', deteriorating || (sectorScore ?? 100) <= 40, `業種${sectorScore?.toFixed(1) ?? '---'} / 10日${context.momentum10d == null ? '---' : `${context.momentum10d >= 0 ? '+' : ''}${context.momentum10d.toFixed(1)}`}`),
      criterion('transition', 'ステージ変化', item.deterioratingTransitions > item.improvingTransitions, `改善${item.improvingTransitions} / 悪化${item.deterioratingTransitions}`),
      criterion('higherTimeframe', '上位足', item.higherDownAlignment >= 58, `下落整合${item.higherDownAlignment.toFixed(0)}%`),
      criterion('movingAverage', 'MA構造', item.maDownCount >= 3 || item.maOrder === 'bearish', `下向き${item.maDownCount}本 / ${maOrderLabel(item.maOrder)}`),
      criterion('shortTerm', '短期・物理', negativeSignal(item), `${item.shortTermCheckLabel} / ${item.physicsStatus}`),
    ]
  } else {
    criteria = [
      criterion('sector', '業種構造', improving && (marketDiff ?? 0) >= -5, `市場差${marketDiff == null ? '---' : `${marketDiff >= 0 ? '+' : ''}${marketDiff.toFixed(1)}pt`} / 10日${context.momentum10d == null ? '---' : `${context.momentum10d >= 0 ? '+' : ''}${context.momentum10d.toFixed(1)}`}`),
      criterion('transition', 'ステージ変化', item.improvingTransitions > item.deterioratingTransitions, `改善${item.improvingTransitions} / 悪化${item.deterioratingTransitions}`),
      criterion('higherTimeframe', '上位足', item.higherUpAlignment >= 42, `上昇整合${item.higherUpAlignment.toFixed(0)}%`),
      criterion('movingAverage', 'MA構造', item.maUpCount >= 2 || item.maOrder === 'converging', `上向き${item.maUpCount}本 / ${maOrderLabel(item.maOrder)}`),
      criterion('shortTerm', '短期・物理', positiveSignal(item) || reversalSignal(item), `${item.shortTermCheckLabel} / ${item.physicsStatus}`),
    ]
  }

  const matched = criteria.filter((item) => item.matched)
  const unmatched = criteria.filter((item) => !item.matched)
  return {
    strategy,
    label: STRATEGY_LABELS[strategy],
    matchCount: matched.length,
    totalCriteria: 5,
    criteria,
    reasons: matched.slice(0, 3).map((item) => `${item.label}: ${item.detail}`),
    primaryRisk: unmatched[0]
      ? `${unmatched[0].label}が未一致 (${unmatched[0].detail})`
      : item.physicsStatus === '過熱注意'
        ? '物理状態が過熱注意'
        : '5条件一致。価格・出来高と損切り位置を最終確認',
  }
}

export function evaluateBestSectorStrategy(
  item: StrategyCandidate,
  context: SectorDecisionContext,
): SectorStrategyEvaluation {
  const preferredStrategy: SectorDecisionStrategy = negativeSignal(item)
    || item.higherDownAlignment > item.higherUpAlignment
    || (context.momentum10d ?? 0) < 0
    ? 'risk'
    : reversalSignal(item)
      ? 'reversal'
      : (context.trendStructureScore ?? 50) >= 60
          && item.higherUpAlignment >= 58
          && (item.maOrder === 'bullish' || item.maUpCount >= 3)
        ? 'up_continuation'
        : positiveSignal(item)
            || item.improvingTransitions > item.deterioratingTransitions
            || (context.momentum10d ?? 0) > 0
          ? 'up_emerging'
          : (context.trendStructureScore ?? 50) <= 40
            ? 'risk'
            : item.maOrder === 'converging'
              ? 'reversal'
              : item.maOrder === 'bullish' || item.maUpCount > item.maDownCount
                ? 'up_continuation'
                : 'up_emerging'

  return (['up_emerging', 'up_continuation', 'reversal', 'risk'] as const)
    .map((strategy) => evaluateSectorStrategy(item, strategy, context))
    .sort((a, b) => b.matchCount - a.matchCount
      || Number(b.strategy === preferredStrategy) - Number(a.strategy === preferredStrategy))[0]
}
