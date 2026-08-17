// lib/hex-stage.ts
// 完全移植: 株式アプリ/HEX-app/frontend/lib/stage-calculator.ts
// ステージ判定ロジック - 3本の移動平均線（ma1, ma2, ma3）の並び順で判定
//
// ステージ分類:
//   1: ma1 > ma2 > ma3   （短期 > 中期 > 長期 = パーフェクトオーダー、最強気）
//   2: ma2 > ma1 > ma3   （調整入り、短期が中期を割る）
//   3: ma2 > ma3 > ma1   （短期が最下層、弱気移行）
//   4: ma3 > ma2 > ma1   （リバースパーフェクト、最弱気）
//   5: ma3 > ma1 > ma2   （反発の兆し）
//   6: ma1 > ma3 > ma2   （強気移行、強気初期）
//
// 期間設定:
//   日足 A: SMA 5/25/75
//   日足 B: SMA 75/150/300
//   週足 A: 暦週 SMA 5/13/25
//   週足 B: 暦週 SMA 25/50/100
//   月足 A: 暦月 SMA 3/5/10
//   月足 B: 暦月 SMA 10/20/25

import type { OHLCV } from '@/types/stock'
import { resampleOhlcv, smaAt } from './timeframes'

export type StageLevel = 1 | 2 | 3 | 4 | 5 | 6

export type StageTransitionDirection =
  | 'improve'
  | 'deteriorate'
  | 'jump_improve'
  | 'jump_deteriorate'
  | 'stable'
  | 'invalid'

export interface StageTransitionInfo {
  from: StageLevel
  to: StageLevel
  direction: StageTransitionDirection
  forwardDistance: number
  backwardDistance: number
  isCycleAdjacent: boolean
}

export interface StageTransitionCell {
  from: StageLevel
  to: StageLevel
  direction: StageTransitionDirection
  forwardDistance: number
  backwardDistance: number
  isCycleAdjacent: boolean
  label: string
}

export const STAGE_CYCLE: ReadonlyArray<StageLevel> = [1, 2, 3, 4, 5, 6]
export const STAGE_COUNT = STAGE_CYCLE.length

const STAGE_TO_INDEX: Record<StageLevel, number> = {
  1: 0,
  2: 1,
  3: 2,
  4: 3,
  5: 4,
  6: 5,
}

/**
 * 6段階循環に対する遷移分類を1箇所で定義
 * - forwardDistance: from -> to への循環順距離
 * - backwardDistance: to -> from への循環順距離
 * - 1歩進行を改善、1歩後退を悪化として扱う
 * - 2〜4ステップは飛躍（jump）として扱う
 */
function classifyStageTransition(from: StageLevel, to: StageLevel): Omit<StageTransitionInfo, 'from' | 'to'> {
  const fromIdx = STAGE_TO_INDEX[from]
  const toIdx = STAGE_TO_INDEX[to]
  const rawForward = (toIdx - fromIdx + STAGE_COUNT) % STAGE_COUNT
  const forwardDistance = rawForward === 0 ? 0 : rawForward
  const backwardDistance = (STAGE_COUNT - forwardDistance) % STAGE_COUNT

  let direction: StageTransitionDirection = 'invalid'
  if (from === to) {
    direction = 'stable'
  } else if (forwardDistance === 1) {
    direction = 'improve'
  } else if (backwardDistance === 1) {
    direction = 'deteriorate'
  } else if (forwardDistance > 1 && forwardDistance < STAGE_COUNT - 1) {
    direction = 'jump_improve'
  } else if (backwardDistance > 1 && backwardDistance < STAGE_COUNT - 1) {
    direction = 'jump_deteriorate'
  }

  return {
    direction,
    forwardDistance,
    backwardDistance,
    isCycleAdjacent: direction === 'improve' || direction === 'deteriorate',
  }
}

export const STAGE_TRANSITION_MATRIX: StageTransitionCell[][] = STAGE_CYCLE.map((from) =>
  STAGE_CYCLE.map((to) => {
    const { direction, forwardDistance, backwardDistance, isCycleAdjacent } = classifyStageTransition(from, to)
    const labelMap: Record<StageTransitionDirection, string> = {
      stable: '据置',
      improve: '循環順',
      deteriorate: '逆循環',
      jump_improve: '飛躍改善',
      jump_deteriorate: '飛躍悪化',
      invalid: '不明',
    }

    return {
      from,
      to,
      direction,
      forwardDistance,
      backwardDistance,
      isCycleAdjacent,
      label: labelMap[direction],
    }
  }),
)

export const STAGE_DIRECTION_META: Record<
  StageTransitionDirection,
  { title: string; rgb: string; text: string; tone: string; description: string }
> = {
  stable: {
    title: '据置',
    rgb: '120, 113, 108',
    text: 'var(--color-text-tertiary)',
    tone: 'neutral',
    description: '同一ステージを維持（前後で循環距離0）',
  },
  improve: {
    title: '改善',
    rgb: '22, 163, 74',
    text: '#166534',
    tone: 'up',
    description: '循環順で1ステップ移動（1→2, 6→1）',
  },
  deteriorate: {
    title: '悪化',
    rgb: '37, 99, 235',
    text: '#1d4ed8',
    tone: 'down',
    description: '循環逆順で1ステップ移動（3→2, 1→6）',
  },
  jump_improve: {
    title: '大幅改善',
    rgb: '6, 95, 70',
    text: '#065f46',
    tone: 'up',
    description: '循環順で2〜4ステップ移動（例: 1→4）',
  },
  jump_deteriorate: {
    title: '大幅悪化',
    rgb: '217, 119, 6',
    text: '#92400e',
    tone: 'down',
    description: '循環逆順で2〜4ステップ移動（例: 4→1）',
  },
  invalid: {
    title: '不明',
    rgb: '120, 113, 108',
    text: 'var(--color-text-tertiary)',
    tone: 'neutral',
    description: 'ステージが未計算または不正のため遷移方向を判定できません',
  },
}

export function isStage(value: number | null): value is StageLevel {
  return value === 1 || value === 2 || value === 3 || value === 4 || value === 5 || value === 6
}

export function getStageTransitionInfo(from: number | null, to: number | null): StageTransitionInfo | null {
  if (!isStage(from) || !isStage(to)) return null
  const { direction, forwardDistance, backwardDistance, isCycleAdjacent } = classifyStageTransition(from, to)
  return { from, to, direction, forwardDistance, backwardDistance, isCycleAdjacent }
}

export function getStageTransitionDirection(from: number | null, to: number | null): StageTransitionDirection {
  return getStageTransitionInfo(from, to)?.direction ?? 'invalid'
}

export function getStageTransitionTone(
  direction: StageTransitionDirection,
): 'up' | 'down' | 'watch' | 'neutral' {
  switch (direction) {
    case 'improve':
    case 'jump_improve':
      return 'up'
    case 'deteriorate':
    case 'jump_deteriorate':
      return 'down'
    case 'stable':
      return 'neutral'
    default:
      return 'watch'
  }
}

export const STAGE_COMPARISON_RELATIVE_EPSILON = 1e-10

export interface MaValues {
  ma_5: number | null
  ma_25: number | null
  ma_75: number | null
  ma_150: number | null
  ma_300: number | null
  weekly_ma_5: number | null
  weekly_ma_13: number | null
  weekly_ma_25: number | null
  weekly_ma_50: number | null
  weekly_ma_100: number | null
  monthly_ma_3: number | null
  monthly_ma_5: number | null
  monthly_ma_10: number | null
  monthly_ma_20: number | null
  monthly_ma_25: number | null
}

export interface StageResult {
  daily_a_stage: number | null
  daily_b_stage: number | null
  weekly_a_stage: number | null
  weekly_b_stage: number | null
  monthly_a_stage: number | null
  monthly_b_stage: number | null
}

/**
 * 3本の移動平均線（ma1, ma2, ma3）の並び順からステージを判定
 */
export function calculateStageFromThreeMa(
  ma1: number | null,
  ma2: number | null,
  ma3: number | null,
): number | null {
  if (ma1 === null || ma2 === null || ma3 === null) return null

  const greaterThan = (left: number, right: number): boolean => {
    const tolerance = STAGE_COMPARISON_RELATIVE_EPSILON * Math.max(1, Math.abs(left), Math.abs(right))
    return left - right > tolerance
  }

  if (greaterThan(ma1, ma2) && greaterThan(ma2, ma3)) return 1
  if (greaterThan(ma2, ma1) && greaterThan(ma1, ma3)) return 2
  if (greaterThan(ma2, ma3) && greaterThan(ma3, ma1)) return 3
  if (greaterThan(ma3, ma2) && greaterThan(ma2, ma1)) return 4
  if (greaterThan(ma3, ma1) && greaterThan(ma1, ma2)) return 5
  if (greaterThan(ma1, ma3) && greaterThan(ma3, ma2)) return 6

  // 等しい値がある場合は判定不能
  return null
}

function calculateDailyAStage(ma: MaValues) {
  return calculateStageFromThreeMa(ma.ma_5, ma.ma_25, ma.ma_75)
}
function calculateDailyBStage(ma: MaValues) {
  return calculateStageFromThreeMa(ma.ma_75, ma.ma_150, ma.ma_300)
}
function calculateWeeklyAStage(ma: MaValues) {
  return calculateStageFromThreeMa(ma.weekly_ma_5, ma.weekly_ma_13, ma.weekly_ma_25)
}
function calculateWeeklyBStage(ma: MaValues) {
  return calculateStageFromThreeMa(ma.weekly_ma_25, ma.weekly_ma_50, ma.weekly_ma_100)
}
function calculateMonthlyAStage(ma: MaValues) {
  return calculateStageFromThreeMa(ma.monthly_ma_3, ma.monthly_ma_5, ma.monthly_ma_10)
}
function calculateMonthlyBStage(ma: MaValues) {
  return calculateStageFromThreeMa(ma.monthly_ma_10, ma.monthly_ma_20, ma.monthly_ma_25)
}

/**
 * すべてのステージを計算（日週月 × A/B = 計6つ）
 */
export function calculateAllStages(ma: MaValues): StageResult {
  return {
    daily_a_stage: calculateDailyAStage(ma),
    daily_b_stage: calculateDailyBStage(ma),
    weekly_a_stage: calculateWeeklyAStage(ma),
    weekly_b_stage: calculateWeeklyBStage(ma),
    monthly_a_stage: calculateMonthlyAStage(ma),
    monthly_b_stage: calculateMonthlyBStage(ma),
  }
}

// ─────────────────────────────────────────────────────────
// OHLCV から MA を計算するヘルパー（stock-dashboard 固有）
// ─────────────────────────────────────────────────────────

function lastSma(ohlcv: OHLCV[], period: number): number | null {
  return smaAt(ohlcv, period)
}

/** Yahoo Finance の日足 OHLCV から MA 値一式を計算 */
export function buildMaValuesFromOhlcv(ohlcv: OHLCV[]): MaValues {
  const daily = resampleOhlcv(ohlcv, { timeframe: 'day', multiplier: 1 })
  const weekly = resampleOhlcv(daily, { timeframe: 'week', multiplier: 1 })
  const monthly = resampleOhlcv(daily, { timeframe: 'month', multiplier: 1 })

  return {
    ma_5: lastSma(daily, 5),
    ma_25: lastSma(daily, 25),
    ma_75: lastSma(daily, 75),
    ma_150: lastSma(daily, 150),
    ma_300: lastSma(daily, 300),
    weekly_ma_5: lastSma(weekly, 5),
    weekly_ma_13: lastSma(weekly, 13),
    weekly_ma_25: lastSma(weekly, 25),
    weekly_ma_50: lastSma(weekly, 50),
    weekly_ma_100: lastSma(weekly, 100),
    monthly_ma_3: lastSma(monthly, 3),
    monthly_ma_5: lastSma(monthly, 5),
    monthly_ma_10: lastSma(monthly, 10),
    monthly_ma_20: lastSma(monthly, 20),
    monthly_ma_25: lastSma(monthly, 25),
  }
}

/**
 * 過去日付の MA 値を取得（OHLCV を slice して再計算）
 * offset=3 なら3営業日前まで、10なら10営業日前まで、20なら20営業日前まで。
 */
export function buildMaValuesAtOffset(ohlcv: OHLCV[], offset: number): MaValues | null {
  if (ohlcv.length <= offset) return null
  const sliced = ohlcv.slice(0, ohlcv.length - offset)
  return buildMaValuesFromOhlcv(sliced)
}

/**
 * SMA角度計算
 * Formula: atan( (change / prev) * 100 / days ) * 180 / PI
 */
export function calculateAngle(curr: number | null, prev: number | null, days: number): number | null {
  if (curr == null || prev == null || prev === 0) return null
  const slope = (((curr - prev) / prev) * 100) / days
  const angleRad = Math.atan(slope)
  return Math.round(angleRad * (180 / Math.PI))
}

// HEX-app スタイル色
export const STAGE_BG_COLORS: Record<number, string> = {
  1: '#dcfce7',
  2: '#fef3c7',
  3: '#fee2e2',
  4: '#fce7f3',
  5: '#dbeafe',
  6: '#f3e8ff',
}

export const STAGE_BORDER_COLORS: Record<number, string> = {
  1: '#22c55e',
  2: '#f59e0b',
  3: '#ef4444',
  4: '#ec4899',
  5: '#3b82f6',
  6: '#a855f7',
}

export const STAGE_LABELS: Record<number, string> = {
  1: '安定上昇期',
  2: '上昇変化期①',
  3: '下降変化期①',
  4: '安定下降期',
  5: '下降変化期②',
  6: '上昇変化期②',
}
