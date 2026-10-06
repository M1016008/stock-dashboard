import type { FormattedFinancialSummaryValue } from '@/lib/stock-decision-summary'
import type { MedianComparison } from '@/lib/valuation-comparison'

/** Fundamentals サブタブ ID (StockDetailClient の FundamentalTab と同一) */
export type FundamentalTabId = 'summary' | 'performance' | 'financial' | 'valuation' | 'returns'

export type UnavailableAvailability = 'missing' | 'not_applicable' | 'not_meaningful'

/**
 * 欠損の言い方をFundamentals全体で統一する。
 * 対象外 = 指標の適用対象外 / 算出不能 = 入力はあるが意味のある値にできない / データなし = 必要入力を確認できない
 */
export const UNAVAILABLE_LABEL: Record<UnavailableAvailability, string> = {
  missing: 'データなし',
  not_applicable: '対象外',
  not_meaningful: '算出不能',
}

export const UNAVAILABLE_LEGEND = '対象外 = 指標の適用対象外 / 算出不能 = 入力はあるが意味のある値にできない / データなし = 必要入力を確認できない'

export function unavailableLabel(availability: string | null | undefined): string {
  if (availability === 'not_applicable') return UNAVAILABLE_LABEL.not_applicable
  if (availability === 'not_meaningful') return UNAVAILABLE_LABEL.not_meaningful
  return UNAVAILABLE_LABEL.missing
}

export interface DisplayValue {
  text: string
  /** true のときは数値ではなく「データなし」等の状態表示。弱い色で出す。 */
  unavailable: boolean
}

/** formatFinancialSummaryValue の結果を、統一した欠損語彙に直して表示する。 */
export function displaySummary(value: FormattedFinancialSummaryValue): DisplayValue {
  if (value.availability === 'available') return { text: value.text, unavailable: false }
  if (value.availability === 'loading') return { text: '—', unavailable: true }
  if (value.availability === 'not_applicable') return { text: UNAVAILABLE_LABEL.not_applicable, unavailable: true }
  if (value.text === 'N/M') return { text: UNAVAILABLE_LABEL.not_meaningful, unavailable: true }
  if (value.text === '予想なし') return { text: '予想なし', unavailable: true }
  return { text: UNAVAILABLE_LABEL.missing, unavailable: true }
}

export type Direction = 'higher' | 'lower' | 'same'

export const DIRECTION_WORD: Record<Direction, string> = {
  higher: '上回る',
  lower: '下回る',
  same: '同水準',
}

/** 同じ単位の2値を表示精度で丸めて比べる。表示上同じ値なら「同水準」。 */
export function compareDisplayed(a: number, b: number, precision: number): Direction {
  const left = Math.round(a / precision)
  const right = Math.round(b / precision)
  if (left === right) return 'same'
  return left > right ? 'higher' : 'lower'
}

/**
 * 既存の中央値比較(MedianComparison)の符号だけを向きとして読む。
 * 値は小数1桁の表示で0.0になるなら同水準。新しい指標や閾値は作らない。
 */
export function directionFromMedianComparison(comparison: MedianComparison | null | undefined): Direction | null {
  if (!comparison || comparison.value == null || !Number.isFinite(comparison.value)) return null
  if (Number(comparison.value.toFixed(1)) === 0) return 'same'
  return comparison.value > 0 ? 'higher' : 'lower'
}

/** 円建ての大きな数を 兆/億/万 で短く表す(単位サフィックスなし)。 */
export function compactNumberJa(value: number, fractionDigits = 1): string {
  const absolute = Math.abs(value)
  if (absolute >= 1e12) return `${(value / 1e12).toFixed(fractionDigits)}兆`
  if (absolute >= 1e8) return `${(value / 1e8).toFixed(0)}億`
  if (absolute >= 1e4) return `${(value / 1e4).toFixed(0)}万`
  return value.toLocaleString('ja-JP', { maximumFractionDigits: 1 })
}

/** 単位つき値の表示。欠損語彙は unavailableLabel と揃える。 */
export function formatUnitValue(
  value: number | null | undefined,
  unit: string | null | undefined,
  availability: string | null | undefined,
  options: { digits?: number } = {},
): DisplayValue {
  if (value == null || !Number.isFinite(value)) return { text: unavailableLabel(availability), unavailable: true }
  const digits = options.digits ?? 1
  if (unit === 'PERCENT') return { text: `${value.toFixed(digits)}%`, unavailable: false }
  if (unit === 'JPY_PER_SHARE') return { text: `¥${value.toLocaleString('ja-JP', { maximumFractionDigits: 1 })}`, unavailable: false }
  if (unit === 'MULTIPLE') return { text: `${value.toFixed(digits)}倍`, unavailable: false }
  if (unit === 'YEARS') return { text: `${value.toFixed(0)}年`, unavailable: false }
  if (unit === 'COUNT') return { text: `${value.toFixed(0)}回`, unavailable: false }
  return { text: compactNumberJa(value), unavailable: false }
}

export function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, value))
}

/** 帯(low〜high)の中での位置(%)。帯の外にあるときは端に寄せ、clipped で方向を返す。 */
export function positionInRange(
  value: number | null | undefined,
  low: number | null | undefined,
  high: number | null | undefined,
): { left: number; clipped: 'low' | 'high' | null } | null {
  if (value == null || low == null || high == null) return null
  if (![value, low, high].every(Number.isFinite) || high <= low) return null
  const raw = (100 * (value - low)) / (high - low)
  if (raw < 0) return { left: 0, clipped: 'low' }
  if (raw > 100) return { left: 100, clipped: 'high' }
  return { left: raw, clipped: null }
}

export function signedPercentText(value: number | null | undefined, digits = 1): string {
  if (value == null || !Number.isFinite(value)) return UNAVAILABLE_LABEL.missing
  const rounded = Number(value.toFixed(digits))
  return `${rounded > 0 ? '+' : ''}${rounded.toFixed(digits)}%`
}

export function directionOfSigned(value: number | null | undefined, digits = 1): Direction | null {
  if (value == null || !Number.isFinite(value)) return null
  const rounded = Number(value.toFixed(digits))
  if (rounded === 0) return 'same'
  return rounded > 0 ? 'higher' : 'lower'
}
