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
//   週足 A: WMA 5/13/25
//   週足 B: WMA 25/50/100
//   月足 A: MMA 3/5/10
//   月足 B: MMA 10/20/25

import type { OHLCV } from '@/types/stock'
import { calcSMA } from './indicators'

export type StageLevel = 1 | 2 | 3 | 4 | 5 | 6

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
function calculateStageFromThreeMa(
  ma1: number | null,
  ma2: number | null,
  ma3: number | null,
): number | null {
  if (ma1 === null || ma2 === null || ma3 === null) return null

  if (ma1 > ma2 && ma2 > ma3) return 1
  if (ma2 > ma1 && ma1 > ma3) return 2
  if (ma2 > ma3 && ma3 > ma1) return 3
  if (ma3 > ma2 && ma2 > ma1) return 4
  if (ma3 > ma1 && ma1 > ma2) return 5
  if (ma1 > ma3 && ma3 > ma2) return 6

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

/** 日足 OHLCV を週足/月足に集約 */
function aggregate(ohlcv: OHLCV[], groupSize: number): OHLCV[] {
  if (groupSize <= 1) return ohlcv
  const result: OHLCV[] = []
  for (let i = 0; i < ohlcv.length; i += groupSize) {
    const slice = ohlcv.slice(i, i + groupSize)
    if (slice.length === 0) continue
    result.push({
      date: slice[slice.length - 1].date,
      open: slice[0].open,
      high: Math.max(...slice.map((d) => d.high)),
      low: Math.min(...slice.map((d) => d.low)),
      close: slice[slice.length - 1].close,
      volume: slice.reduce((s, d) => s + d.volume, 0),
    })
  }
  return result
}

function lastSma(ohlcv: OHLCV[], period: number): number | null {
  const arr = calcSMA(ohlcv, period)
  return arr[arr.length - 1] ?? null
}

/** Yahoo Finance の日足 OHLCV から MA 値一式を計算 */
export function buildMaValuesFromOhlcv(ohlcv: OHLCV[]): MaValues {
  const weekly = aggregate(ohlcv, 5)
  const monthly = aggregate(ohlcv, 21)

  return {
    ma_5: lastSma(ohlcv, 5),
    ma_25: lastSma(ohlcv, 25),
    ma_75: lastSma(ohlcv, 75),
    ma_150: lastSma(ohlcv, 150),
    ma_300: lastSma(ohlcv, 300),
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
  1: 'パーフェクト',
  2: '調整',
  3: '弱気移行',
  4: 'リバース',
  5: '反発兆し',
  6: '強気移行',
}
