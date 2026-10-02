import type { ClassificationMomentum, DailyCloseReport, PeriodMetric } from '@/lib/daily-close-report'

// Page 06 Design Lab「判定ロジック / ViewModel」層。
// 60分類 MOMENTUM MATRIX (1M Rank × 1W Rank) の状態判定・信頼性フラグ・注目分類の選定を行う。
// Momentum Shift = rank1M - rank1W (正 = 順位上昇)。リターンの加速度ではない。
// 文章 (Narrative) はここでは扱わない → lib/daily-close-page06-narrative-content.ts

export type MomentumState = 'LEADER' | 'EMERGING' | 'FADING' | 'RECOVERING' | 'NEUTRAL'
export type SpotlightState = Exclude<MomentumState, 'NEUTRAL'>

export const MOMENTUM_STATE_LABEL: Record<MomentumState, string> = {
  LEADER: '上位維持',
  EMERGING: '急浮上',
  FADING: '高位失速',
  RECOVERING: '下位改善',
  NEUTRAL: 'その他',
}

// Phase 1 しきい値 (60分類の平均リターン順位、1 = 最上位)
export const MOMENTUM_THRESHOLDS = { top: 15, lowerHalf: 30, bottomQuartile: 45, recoveringShift: 15 } as const

export const MOMENTUM_STATE_RULE: Record<SpotlightState, string> = {
  LEADER: `1M≤${MOMENTUM_THRESHOLDS.top}かつ1W≤${MOMENTUM_THRESHOLDS.top}`,
  EMERGING: `1M>${MOMENTUM_THRESHOLDS.lowerHalf}かつ1W≤${MOMENTUM_THRESHOLDS.top}`,
  FADING: `1M≤${MOMENTUM_THRESHOLDS.top}かつ1W>${MOMENTUM_THRESHOLDS.lowerHalf}`,
  RECOVERING: `1M>${MOMENTUM_THRESHOLDS.bottomQuartile}かつShift≥${MOMENTUM_THRESHOLDS.recoveringShift}`,
}

// リスト・Claude 入力で扱う順 (変化の大きい状態を先に読む)
export const SPOTLIGHT_ORDER: SpotlightState[] = ['EMERGING', 'FADING', 'RECOVERING', 'LEADER']
export const LIST_LIMIT = 3

export type MomentumPoint = {
  name: string
  rank1M: number | null
  rank1W: number | null
  momentumShift: number | null
  oneWeek: { mean: number | null; median: number | null; winRate: number | null; eligible: number; total: number }
  oneMonth: { mean: number | null }
  state: MomentumState
  lowSample: boolean
  meanDriven: boolean
  labeled: boolean
}

export type MomentumMatrixModel = {
  reportDate: string
  points: MomentumPoint[]
  counts: Record<MomentumState, number>
  lowSampleCount: number
  lowSampleNames: string[]
  lists: Record<SpotlightState, MomentumPoint[]>
  spotlight: MomentumPoint[]
}

export function classifyMomentumState(rank1M: number | null, rank1W: number | null): MomentumState {
  if (rank1M == null || rank1W == null) return 'NEUTRAL'
  const { top, lowerHalf, bottomQuartile, recoveringShift } = MOMENTUM_THRESHOLDS
  if (rank1M <= top && rank1W <= top) return 'LEADER'
  if (rank1M > lowerHalf && rank1W <= top) return 'EMERGING'
  if (rank1M <= top && rank1W > lowerHalf) return 'FADING'
  if (rank1M > bottomQuartile && rank1M - rank1W >= recoveringShift) return 'RECOVERING'
  return 'NEUTRAL'
}

// 平均はプラスだが、中央値 ≤ 0 または勝率 < 50% (少数銘柄が平均を押し上げている可能性)
export function isMeanDriven(metric: PeriodMetric): boolean {
  if (metric.meanReturn == null || metric.meanReturn <= 0) return false
  return (metric.medianReturn != null && metric.medianReturn <= 0) || (metric.winRate != null && metric.winRate < 0.5)
}

function byName(a: MomentumPoint, b: MomentumPoint): number {
  return a.name.localeCompare(b.name, 'ja')
}

function toPoint(row: ClassificationMomentum): MomentumPoint {
  return {
    name: row.name,
    rank1M: row.rank1M,
    rank1W: row.rank1W,
    momentumShift: row.rankChange1MTo1W,
    oneWeek: {
      mean: row.oneWeek.meanReturn,
      median: row.oneWeek.medianReturn,
      winRate: row.oneWeek.winRate,
      eligible: row.oneWeek.eligibleCount,
      total: row.oneWeek.totalCount,
    },
    oneMonth: { mean: row.oneMonth.meanReturn },
    state: classifyMomentumState(row.rank1M, row.rank1W),
    lowSample: row.oneWeek.lowSample || row.oneMonth.lowSample,
    meanDriven: isMeanDriven(row.oneWeek),
    labeled: false,
  }
}

const LIST_SORT: Record<SpotlightState, (a: MomentumPoint, b: MomentumPoint) => number> = {
  LEADER: (a, b) => a.rank1W! - b.rank1W! || a.rank1M! - b.rank1M! || byName(a, b),
  EMERGING: (a, b) => b.momentumShift! - a.momentumShift! || byName(a, b),
  FADING: (a, b) => a.momentumShift! - b.momentumShift! || byName(a, b),
  RECOVERING: (a, b) => b.momentumShift! - a.momentumShift! || byName(a, b),
}

export function buildMomentumMatrix(report: Pick<DailyCloseReport, 'reportDate' | 'classifications60'>): MomentumMatrixModel {
  const points = report.classifications60.map(toPoint).sort(byName)
  const counts: Record<MomentumState, number> = { LEADER: 0, EMERGING: 0, FADING: 0, RECOVERING: 0, NEUTRAL: 0 }
  for (const point of points) counts[point.state] += 1
  const lowSample = points.filter((point) => point.lowSample)

  // LOW SAMPLE は Matrix には残すが、注目・ラベル・Claude 入力の候補から除外する
  const lists = Object.fromEntries(SPOTLIGHT_ORDER.map((state) => [
    state,
    points.filter((point) => point.state === state && !point.lowSample).sort(LIST_SORT[state]).slice(0, LIST_LIMIT),
  ])) as Record<SpotlightState, MomentumPoint[]>
  for (const state of SPOTLIGHT_ORDER) for (const point of lists[state]) point.labeled = true

  return {
    reportDate: report.reportDate,
    points,
    counts,
    lowSampleCount: lowSample.length,
    lowSampleNames: lowSample.map((point) => point.name),
    lists,
    spotlight: SPOTLIGHT_ORDER.flatMap((state) => lists[state].slice(0, 1)),
  }
}

// ---- 表示用フォーマット (Narrative / レイアウト共通) ----

export function round1(value: number | null): number | null {
  return value == null || !Number.isFinite(value) ? null : Math.round(value * 10) / 10
}

export function winRatePct(value: number | null): number | null {
  return value == null || !Number.isFinite(value) ? null : Math.round(value * 100)
}

export function formatShift(value: number | null): string {
  return value == null ? '—' : value === 0 ? '±0' : `${value > 0 ? '+' : ''}${value}`
}

export function formatPct(value: number | null): string {
  const rounded = round1(value)
  return rounded == null ? 'N/A' : `${rounded >= 0 ? '+' : ''}${rounded.toFixed(1)}%`
}

export function formatWinRate(value: number | null): string {
  const pct = winRatePct(value)
  return pct == null ? 'N/A' : `${pct}%`
}
