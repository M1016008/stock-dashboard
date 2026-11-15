// PREREG_DWELL_SECTOR_20261111 (研究 A・B) の決まりを、データに依らない関数にしたもの。条件は事前登録の文書が正。
import { getStageTransitionDirection } from '@/lib/hex-stage'
import { quantile } from '@/lib/research/six-stage-statistics'

export type TransitionGroup = 'IMPROVE' | 'DETERIORATE' | 'MIXED' | 'INVALID'

// 遷移の全体の判定 (STATUS の F02)。変化した桁のうち判定できる桁だけで分類し、すべて判定不能なら INVALID。
export function transitionGroup(sequenceKey: string): { group: TransitionGroup; invalidDigits: number } {
  const [from, to] = sequenceKey.split('>')
  let up = 0; let down = 0; let other = 0; let invalidDigits = 0
  for (let digit = 0; digit < from.length; digit += 1) {
    if (from[digit] === to[digit]) continue
    const direction = getStageTransitionDirection(Number(from[digit]), Number(to[digit]))
    if (direction === 'invalid') invalidDigits += 1
    else if (direction === 'improve' || direction === 'jump_improve') up += 1
    else if (direction === 'deteriorate' || direction === 'jump_deteriorate') down += 1
    else other += 1
  }
  if (up + down + other === 0) return { group: 'INVALID', invalidDigits }
  return { group: other === 0 && down === 0 ? 'IMPROVE' : other === 0 && up === 0 ? 'DETERIORATE' : 'MIXED', invalidDigits }
}

// 研究 A: 直前の状態にいた営業日数。0 = 短い (1〜5)、1 = 中 (6〜19)、2 = 長い (20 以上)。
export function dwellClass(dwell: number): 0 | 1 | 2 {
  if (!Number.isInteger(dwell) || dwell < 1) throw new Error(`invalid dwell ${dwell}`)
  return dwell <= 5 ? 0 : dwell <= 19 ? 1 : 2
}

// 並べた値の中央値 (線形補間)。without を渡すと、その値を 1 つ除いた中央値。
export function sortedMedian(sorted: ArrayLike<number>, without?: number): number {
  const skip = without == null ? -1 : lowerBound(sorted, without)
  if (without != null && sorted[skip] !== without) throw new Error('value to exclude is not in the list')
  const n = sorted.length - (skip >= 0 ? 1 : 0)
  const at = (i: number) => sorted[skip >= 0 && i >= skip ? i + 1 : i]
  const position = (n - 1) / 2
  return (at(Math.floor(position)) + at(Math.ceil(position))) / 2
}

function lowerBound(sorted: ArrayLike<number>, value: number): number {
  let low = 0; let high = sorted.length
  while (low < high) { const mid = (low + high) >> 1; if (sorted[mid] < value) low = mid + 1; else high = mid }
  return low
}

export const MIN_SECTOR_MEMBERS = 5

// 研究 B: その日の業種の強さ。sectors は業種の並び順 (同じ値のときの順) で、各業種の 20 日騰落を小さい順に並べたもの。
// 遷移した銘柄の業種は、その銘柄の値 (ownValue。中央値に入らない銘柄なら null) を除いて数える。
// 中央値の大きい順に順位を付け、順位 <= n/3 を 0 (強い)、> 2n/3 を 2 (弱い)、残りを 1 (中) とする。
export function sectorStrength(
  sectors: readonly { key: string; sorted: ArrayLike<number> }[],
  ownKey: string,
  ownValue: number | null,
): { strength: 0 | 1 | 2; rank: number; ranked: number } | { excluded: 'ownSectorMissing' | 'ownSectorTooSmall' } {
  const own = sectors.find((sector) => sector.key === ownKey)
  if (!own) return { excluded: 'ownSectorMissing' }
  const ownCount = own.sorted.length - (ownValue == null ? 0 : 1)
  if (ownCount < MIN_SECTOR_MEMBERS) return { excluded: 'ownSectorTooSmall' }
  const ranked = sectors
    .map((sector, order) => sector.key === ownKey
      ? { key: sector.key, order, median: sortedMedian(sector.sorted, ownValue ?? undefined) }
      : sector.sorted.length >= MIN_SECTOR_MEMBERS ? { key: sector.key, order, median: sortedMedian(sector.sorted) } : null)
    .filter((sector): sector is { key: string; order: number; median: number } => sector != null)
    .sort((a, b) => b.median - a.median || a.order - b.order)
  const rank = ranked.findIndex((sector) => sector.key === ownKey) + 1
  const n = ranked.length
  return { strength: rank <= n / 3 ? 0 : rank > (2 * n) / 3 ? 2 : 1, rank, ranked: n }
}

// 判定の 2 段階 (12 個の仮説)。区間は銘柄・年月の 2 つの分布の、両方を含む広い方。
export const STRONG_LEVEL = 1 - 0.05 / 12
export function envelope(axes: readonly (readonly number[])[], level: number): { lower: number; upper: number } {
  const tail = (1 - level) / 2
  return {
    lower: Math.min(...axes.map((values) => quantile(values, tail))),
    upper: Math.max(...axes.map((values) => quantile(values, 1 - tail))),
  }
}

export function evidenceLevel(input: {
  interval95: { lower: number; upper: number }
  intervalStrong: { lower: number; upper: number }
  blocksSameDirection: boolean
}): 'STRONG' | 'WEAK' | 'NONE' {
  const excludesZero = (interval: { lower: number; upper: number }) => interval.lower > 0 || interval.upper < 0
  if (!input.blocksSameDirection) return 'NONE'
  if (excludesZero(input.intervalStrong)) return 'STRONG'
  return excludesZero(input.interval95) ? 'WEAK' : 'NONE'
}
