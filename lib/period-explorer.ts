import {
  getStageTransitionDirection,
  STAGE_STRUCTURE_STRENGTH,
  type StageLevel,
} from '@/lib/hex-stage'

export const PERIOD_EXPLORER_AXIS_KEYS = [
  'dailyA',
  'dailyB',
  'weeklyA',
  'weeklyB',
  'monthlyA',
  'monthlyB',
] as const

export type PeriodExplorerAxisKey = (typeof PERIOD_EXPLORER_AXIS_KEYS)[number]

export const PERIOD_EXPLORER_AXIS_LABELS: Record<PeriodExplorerAxisKey, string> = {
  dailyA: '日足A',
  dailyB: '日足B',
  weeklyA: '週足A',
  weeklyB: '週足B',
  monthlyA: '月足A',
  monthlyB: '月足B',
}

export type PeriodExplorerRankingCategory =
  | 'price'
  | 'technical'
  | 'liquidity'
  | 'highLow'
  | 'volatility'
  | 'industry'

export type PeriodExplorerRankingKey =
  | 'return_up'
  | 'return_down'
  | 'max_rise'
  | 'max_fall'
  | 'drawdown_from_high'
  | 'rebound_from_low'
  | 'stage_improve'
  | 'stage_deteriorate'
  | 'stage_alignment'
  | 'stage_twist_resolution'
  | 'ma25_deviation_high'
  | 'ma25_deviation_low'
  | 'ma75_deviation_high'
  | 'ma75_deviation_low'
  | 'ma_convergence'
  | 'ma_expansion'
  | 'golden_cross'
  | 'dead_cross'
  | 'avg_volume'
  | 'max_volume'
  | 'volume_increase'
  | 'avg_turnover'
  | 'total_turnover'
  | 'turnover_increase'
  | 'high_52_proximity'
  | 'low_52_proximity'
  | 'period_range'
  | 'realized_volatility'
  | 'gap_up_count'
  | 'gap_down_count'
  | 'sector_avg_return'
  | 'sector_median_return'
  | 'sector_breadth'
  | 'sector_stage_improve'

export interface PeriodExplorerRankingDefinition {
  key: PeriodExplorerRankingKey
  label: string
  shortLabel: string
  category: PeriodExplorerRankingCategory
  description: string
  unit: 'percent' | 'currency' | 'volume' | 'count' | 'axes'
  defaultDirection: 'asc' | 'desc'
  requiresRangeStats?: boolean
  requiresPreviousRange?: boolean
  requires52Week?: boolean
  requiresVolatility?: boolean
  resultKind?: 'stocks' | 'sectors'
}

export const PERIOD_EXPLORER_RANKINGS: readonly PeriodExplorerRankingDefinition[] = [
  { key: 'return_up', label: '上昇率', shortLabel: '上昇', category: 'price', description: '(終了日終値 ÷ 開始日終値 − 1) × 100', unit: 'percent', defaultDirection: 'desc' },
  { key: 'return_down', label: '下落率', shortLabel: '下落', category: 'price', description: '期間騰落率を低い順に表示', unit: 'percent', defaultDirection: 'asc' },
  { key: 'max_rise', label: '最大上昇', shortLabel: '最大上昇', category: 'price', description: '(期間最高値 ÷ 開始日終値 − 1) × 100', unit: 'percent', defaultDirection: 'desc', requiresRangeStats: true },
  { key: 'max_fall', label: '最大下落', shortLabel: '最大下落', category: 'price', description: '(期間最安値 ÷ 開始日終値 − 1) × 100', unit: 'percent', defaultDirection: 'asc', requiresRangeStats: true },
  { key: 'drawdown_from_high', label: '期間高値から下落', shortLabel: '高値から下落', category: 'price', description: '(終了日終値 ÷ 期間最高値 − 1) × 100', unit: 'percent', defaultDirection: 'asc', requiresRangeStats: true },
  { key: 'rebound_from_low', label: '期間安値から反発', shortLabel: '安値から反発', category: 'price', description: '(終了日終値 ÷ 期間最安値 − 1) × 100', unit: 'percent', defaultDirection: 'desc', requiresRangeStats: true },
  { key: 'stage_improve', label: 'Stage改善', shortLabel: 'Stage改善', category: 'technical', description: '6軸の開始Stageから終了Stageへの改善軸数。既存の循環遷移定義を使用', unit: 'axes', defaultDirection: 'desc' },
  { key: 'stage_deteriorate', label: 'Stage悪化', shortLabel: 'Stage悪化', category: 'technical', description: '6軸の開始Stageから終了Stageへの悪化軸数。既存の循環遷移定義を使用', unit: 'axes', defaultDirection: 'desc' },
  { key: 'stage_alignment', label: 'A/B一致', shortLabel: 'A/B一致', category: 'technical', description: '終了日時点でA/Bが一致している時間軸数', unit: 'count', defaultDirection: 'desc' },
  { key: 'stage_twist_resolution', label: 'ねじれ解消', shortLabel: 'ねじれ解消', category: 'technical', description: '開始日にA/B不一致、終了日に一致となった時間軸数', unit: 'count', defaultDirection: 'desc' },
  { key: 'ma25_deviation_high', label: '25MA乖離上位', shortLabel: '25MA上方乖離', category: 'technical', description: '(終了日終値 ÷ 25日MA − 1) × 100', unit: 'percent', defaultDirection: 'desc' },
  { key: 'ma25_deviation_low', label: '25MA乖離下位', shortLabel: '25MA下方乖離', category: 'technical', description: '25日MA乖離率を低い順に表示', unit: 'percent', defaultDirection: 'asc' },
  { key: 'ma75_deviation_high', label: '75MA乖離上位', shortLabel: '75MA上方乖離', category: 'technical', description: '(終了日終値 ÷ 75日MA − 1) × 100', unit: 'percent', defaultDirection: 'desc' },
  { key: 'ma75_deviation_low', label: '75MA乖離下位', shortLabel: '75MA下方乖離', category: 'technical', description: '75日MA乖離率を低い順に表示', unit: 'percent', defaultDirection: 'asc' },
  { key: 'ma_convergence', label: 'MA収束', shortLabel: 'MA収束', category: 'technical', description: '25日MAと75日MAの乖離幅が期間中に縮小した割合', unit: 'percent', defaultDirection: 'desc' },
  { key: 'ma_expansion', label: 'MA拡散', shortLabel: 'MA拡散', category: 'technical', description: '25日MAと75日MAの乖離幅が期間中に拡大した割合', unit: 'percent', defaultDirection: 'desc' },
  { key: 'golden_cross', label: 'Golden Cross', shortLabel: 'GC', category: 'technical', description: '開始日は25日MAが75日MA以下、終了日は25日MAが75日MAを上回る銘柄', unit: 'percent', defaultDirection: 'desc' },
  { key: 'dead_cross', label: 'Dead Cross', shortLabel: 'DC', category: 'technical', description: '開始日は25日MAが75日MA以上、終了日は25日MAが75日MAを下回る銘柄', unit: 'percent', defaultDirection: 'asc' },
  { key: 'avg_volume', label: '平均出来高', shortLabel: '平均出来高', category: 'liquidity', description: '選択期間の日次出来高平均', unit: 'volume', defaultDirection: 'desc', requiresRangeStats: true },
  { key: 'max_volume', label: '最大出来高', shortLabel: '最大出来高', category: 'liquidity', description: '選択期間の日次出来高最大値', unit: 'volume', defaultDirection: 'desc', requiresRangeStats: true },
  { key: 'volume_increase', label: '出来高増加率', shortLabel: '出来高増加', category: 'liquidity', description: '選択期間平均出来高 ÷ 直前同営業日数平均 − 1', unit: 'percent', defaultDirection: 'desc', requiresRangeStats: true, requiresPreviousRange: true },
  { key: 'avg_turnover', label: '平均売買代金', shortLabel: '平均売買代金', category: 'liquidity', description: '選択期間の日次調整後終値 × 調整後出来高の平均', unit: 'currency', defaultDirection: 'desc', requiresRangeStats: true },
  { key: 'total_turnover', label: '期間売買代金', shortLabel: '期間売買代金', category: 'liquidity', description: '選択期間の日次売買代金合計', unit: 'currency', defaultDirection: 'desc', requiresRangeStats: true },
  { key: 'turnover_increase', label: '売買代金増加率', shortLabel: '売買代金増加', category: 'liquidity', description: '選択期間平均売買代金 ÷ 直前同営業日数平均 − 1', unit: 'percent', defaultDirection: 'desc', requiresRangeStats: true, requiresPreviousRange: true },
  { key: 'high_52_proximity', label: '52週高値接近', shortLabel: '52週高値接近', category: 'highLow', description: '(終了日終値 ÷ 終了日以前250営業日の最高値 − 1) × 100', unit: 'percent', defaultDirection: 'desc', requires52Week: true },
  { key: 'low_52_proximity', label: '52週安値からの距離', shortLabel: '52週安値距離', category: 'highLow', description: '(終了日終値 ÷ 終了日以前250営業日の最安値 − 1) × 100', unit: 'percent', defaultDirection: 'asc', requires52Week: true },
  { key: 'period_range', label: '期間レンジ', shortLabel: '期間レンジ', category: 'volatility', description: '(期間最高値 ÷ 期間最安値 − 1) × 100', unit: 'percent', defaultDirection: 'desc', requiresRangeStats: true },
  { key: 'realized_volatility', label: '日次変動率', shortLabel: '日次変動', category: 'volatility', description: '期間内の日次騰落率の標準偏差。年率換算はしない', unit: 'percent', defaultDirection: 'desc', requiresVolatility: true },
  { key: 'gap_up_count', label: 'Gap Up回数', shortLabel: 'Gap Up', category: 'volatility', description: '当日始値が前日高値を上回った回数', unit: 'count', defaultDirection: 'desc', requiresVolatility: true },
  { key: 'gap_down_count', label: 'Gap Down回数', shortLabel: 'Gap Down', category: 'volatility', description: '当日始値が前日安値を下回った回数', unit: 'count', defaultDirection: 'desc', requiresVolatility: true },
  { key: 'sector_avg_return', label: '業種平均騰落率', shortLabel: '平均騰落率', category: 'industry', description: '業種構成銘柄の期間騰落率平均', unit: 'percent', defaultDirection: 'desc', resultKind: 'sectors' },
  { key: 'sector_median_return', label: '業種中央値騰落率', shortLabel: '中央値騰落率', category: 'industry', description: '業種構成銘柄の期間騰落率中央値', unit: 'percent', defaultDirection: 'desc', resultKind: 'sectors' },
  { key: 'sector_breadth', label: '業種上昇銘柄比率', shortLabel: '上昇銘柄比率', category: 'industry', description: '期間騰落率がプラスの構成銘柄比率', unit: 'percent', defaultDirection: 'desc', resultKind: 'sectors' },
  { key: 'sector_stage_improve', label: '業種Stage改善比率', shortLabel: 'Stage改善比率', category: 'industry', description: '6軸のうち1軸以上が改善した構成銘柄の比率', unit: 'percent', defaultDirection: 'desc', resultKind: 'sectors' },
] as const

export const PERIOD_EXPLORER_RANKING_MAP = new Map(
  PERIOD_EXPLORER_RANKINGS.map((definition) => [definition.key, definition]),
)

export interface PeriodPriceMetrics {
  periodReturnPct: number | null
  maxRisePct: number | null
  maxFallPct: number | null
  drawdownFromHighPct: number | null
  reboundFromLowPct: number | null
  periodRangePct: number | null
}

function ratioPct(numerator: number | null, denominator: number | null): number | null {
  if (numerator == null || denominator == null || denominator <= 0) return null
  return (numerator / denominator - 1) * 100
}

export function calculatePeriodPriceMetrics(input: {
  startClose: number | null
  endClose: number | null
  periodHigh: number | null
  periodLow: number | null
}): PeriodPriceMetrics {
  return {
    periodReturnPct: ratioPct(input.endClose, input.startClose),
    maxRisePct: ratioPct(input.periodHigh, input.startClose),
    maxFallPct: ratioPct(input.periodLow, input.startClose),
    drawdownFromHighPct: ratioPct(input.endClose, input.periodHigh),
    reboundFromLowPct: ratioPct(input.endClose, input.periodLow),
    periodRangePct: ratioPct(input.periodHigh, input.periodLow),
  }
}

export interface StagePeriodSummary {
  improvingAxes: number
  deterioratingAxes: number
  stableAxes: number
  validAxes: number
  structuralDelta: number
  alignedTimeframes: number
  resolvedTwists: number
}

export function summarizeStagePeriod(
  start: Partial<Record<PeriodExplorerAxisKey, number | null>>,
  end: Partial<Record<PeriodExplorerAxisKey, number | null>>,
): StagePeriodSummary {
  let improvingAxes = 0
  let deterioratingAxes = 0
  let stableAxes = 0
  let validAxes = 0
  let structuralDelta = 0

  for (const axis of PERIOD_EXPLORER_AXIS_KEYS) {
    const from = start[axis]
    const to = end[axis]
    if (!(from && to && from >= 1 && from <= 6 && to >= 1 && to <= 6)) continue
    validAxes += 1
    const direction = getStageTransitionDirection(from, to)
    if (direction === 'improve' || direction === 'jump_improve') improvingAxes += 1
    else if (direction === 'deteriorate' || direction === 'jump_deteriorate') deterioratingAxes += 1
    else if (direction === 'stable') stableAxes += 1
    structuralDelta += STAGE_STRUCTURE_STRENGTH[to as StageLevel] - STAGE_STRUCTURE_STRENGTH[from as StageLevel]
  }

  const pairs: Array<[PeriodExplorerAxisKey, PeriodExplorerAxisKey]> = [
    ['dailyA', 'dailyB'],
    ['weeklyA', 'weeklyB'],
    ['monthlyA', 'monthlyB'],
  ]
  let alignedTimeframes = 0
  let resolvedTwists = 0
  for (const [a, b] of pairs) {
    if (end[a] != null && end[b] != null && end[a] === end[b]) alignedTimeframes += 1
    if (start[a] != null && start[b] != null && start[a] !== start[b] && end[a] != null && end[a] === end[b]) {
      resolvedTwists += 1
    }
  }

  return { improvingAxes, deterioratingAxes, stableAxes, validAxes, structuralDelta, alignedTimeframes, resolvedTwists }
}

export function median(values: number[]): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle]
}

export function isPeriodExplorerRankingKey(value: string | null): value is PeriodExplorerRankingKey {
  return value != null && PERIOD_EXPLORER_RANKING_MAP.has(value as PeriodExplorerRankingKey)
}
