import type { OHLCV } from '@/types/stock'

export const PHYSICAL_MOMENTUM_LOOKBACK_DAYS = 20
export const PHYSICAL_MOMENTUM_MA_PERIODS = [5, 25, 75, 200] as const

export type PhysicalMomentumMaPeriod = typeof PHYSICAL_MOMENTUM_MA_PERIODS[number]

export type PhysicalMomentumInputRow = {
  date: string
  close: number | null
  volume: number | null
  splitFactor?: number | null
}

export type PhysicalMomentumRawRow = {
  date: string
  velocity: number | null
  acceleration: number | null
  momentum: number | null
  force: number | null
  ma5Angle: number | null
  ma25Angle: number | null
  ma75Angle: number | null
  ma200Angle: number | null
  maAngleAvg: number | null
  energy: number | null
}

export type PhysicalMomentumZRow = PhysicalMomentumRawRow & {
  zVelocity: number | null
  zAcceleration: number | null
  zMomentum: number | null
  zForce: number | null
  zMaAngleAvg: number | null
  zEnergy: number | null
  physicalMomentumScore: number | null
  physicalForceScore: number | null
  physicalEnergyScore: number | null
}

export type PhysicalMomentumRawKey =
  | 'velocity'
  | 'acceleration'
  | 'momentum'
  | 'force'
  | 'maAngleAvg'
  | 'energy'

export type PhysicalMomentumNormalizationStats = {
  mean: number | null
  std: number | null
  lower: number | null
  upper: number | null
}

const SPLIT_ADJUSTMENT_FACTORS = [
  0.005,
  0.01,
  0.02,
  0.04,
  0.05,
  0.1,
  0.125,
  0.2,
  0.25,
  1 / 3,
  0.5,
  2,
  3,
  4,
  5,
  8,
  10,
  20,
  25,
  30,
  40,
  50,
  100,
  125,
  200,
  300,
] as const

export function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

export function rollingSma(values: Array<number | null>, period: number): Array<number | null> {
  const output: Array<number | null> = []
  let sum = 0
  let valid = 0

  for (let i = 0; i < values.length; i += 1) {
    const value = values[i]
    if (isFiniteNumber(value)) {
      sum += value
      valid += 1
    }

    if (i >= period) {
      const oldValue = values[i - period]
      if (isFiniteNumber(oldValue)) {
        sum -= oldValue
        valid -= 1
      }
    }

    output.push(i >= period - 1 && valid === period ? sum / period : null)
  }

  return output
}

function maAngle(current: number | null, previous: number | null, lookback: number): number | null {
  if (!isFiniteNumber(current) || !isFiniteNumber(previous) || previous <= 0 || lookback <= 0) return null
  const percentSlopePerBar = ((current / previous) - 1) * 100 / lookback
  return Math.atan(percentSlopePerBar)
}

function averageFinite(values: Array<number | null>): number | null {
  const finite = values.filter(isFiniteNumber)
  if (finite.length !== values.length || finite.length === 0) return null
  return finite.reduce((sum, value) => sum + value, 0) / finite.length
}

function inferLikelySplitAdjustment(
  previous: PhysicalMomentumInputRow,
  current: PhysicalMomentumInputRow,
): number | null {
  const gapDays = (
    Date.parse(`${current.date}T00:00:00Z`)
    - Date.parse(`${previous.date}T00:00:00Z`)
  ) / 86_400_000
  if (
    !Number.isFinite(gapDays)
    || gapDays <= 0
    || gapDays > 10
    || !isFiniteNumber(previous.close)
    || !isFiniteNumber(current.close)
    || previous.close <= 0
    || current.close <= 0
    || !isFiniteNumber(previous.volume)
    || !isFiniteNumber(current.volume)
    || previous.volume <= 0
    || current.volume <= 0
  ) {
    return null
  }

  const priceRatio = current.close / previous.close
  const volumeRatio = current.volume / previous.volume
  const factor = SPLIT_ADJUSTMENT_FACTORS.reduce((best, candidate) => (
    Math.abs(Math.log(priceRatio / candidate)) < Math.abs(Math.log(priceRatio / best))
      ? candidate
      : best
  ))
  if (factor < 4 && factor > 0.25) return null
  const priceError = Math.abs(Math.log(priceRatio / factor))
  const volumeError = Math.abs(Math.log(volumeRatio * factor))
  const isLargeCorporateAction = factor >= 10 || factor <= 0.1
  const maxPriceError = Math.log(isLargeCorporateAction ? 1.75 : 1.35)
  const maxVolumeError = Math.log(isLargeCorporateAction ? 16 : 4)

  // A split changes price and share volume in opposite directions. Requiring
  // both signals avoids treating an ordinary gap as a corporate action.
  if (priceError > maxPriceError || volumeError > maxVolumeError) return null
  return factor
}

export function adjustLikelySplitDiscontinuities(
  rows: PhysicalMomentumInputRow[],
): PhysicalMomentumInputRow[] {
  if (rows.length < 2) return rows.map((row) => ({ ...row }))

  const output = rows.map((row) => ({ ...row }))
  let historicalPriceFactor = 1
  let historicalVolumeFactor = 1

  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index]
    output[index] = {
      ...row,
      close: isFiniteNumber(row.close) ? row.close * historicalPriceFactor : row.close,
      volume: isFiniteNumber(row.volume) ? row.volume * historicalVolumeFactor : row.volume,
    }

    if (index === 0) continue
    const providerSplitFactor = isFiniteNumber(row.splitFactor) && row.splitFactor > 0
      ? 1 / row.splitFactor
      : null
    const splitAdjustment = providerSplitFactor != null && Math.abs(providerSplitFactor - 1) > 1e-8
      ? providerSplitFactor
      : inferLikelySplitAdjustment(rows[index - 1], row)
    if (splitAdjustment == null) continue
    historicalPriceFactor *= splitAdjustment
    historicalVolumeFactor /= splitAdjustment
  }

  return output
}

export function adjustLikelySplitOhlcv(rows: OHLCV[]): OHLCV[] {
  const adjusted = adjustLikelySplitDiscontinuities(rows)

  return rows.map((row, index) => {
    const adjustedRow = adjusted[index]
    const priceFactor = adjustedRow?.close != null && row.close > 0
      ? adjustedRow.close / row.close
      : 1

    return {
      ...row,
      open: row.open * priceFactor,
      high: row.high * priceFactor,
      low: row.low * priceFactor,
      close: adjustedRow?.close ?? row.close,
      volume: Math.round(adjustedRow?.volume ?? row.volume),
      adjustedClose: row.adjustedClose == null ? row.adjustedClose : row.adjustedClose * priceFactor,
    }
  })
}

export function computePhysicalMomentumRawRows(
  rows: PhysicalMomentumInputRow[],
  lookback = PHYSICAL_MOMENTUM_LOOKBACK_DAYS,
): PhysicalMomentumRawRow[] {
  const sorted = adjustLikelySplitDiscontinuities(
    [...rows].sort((a, b) => a.date.localeCompare(b.date)),
  )
  const closes = sorted.map((row) => row.close)
  const volumes = sorted.map((row) => row.volume)
  const ma5 = rollingSma(closes, 5)
  const ma25 = rollingSma(closes, 25)
  const ma75 = rollingSma(closes, 75)
  const ma200 = rollingSma(closes, 200)
  const averageVolume = rollingSma(volumes, lookback)
  const velocities: Array<number | null> = []
  const output: PhysicalMomentumRawRow[] = []

  for (let i = 0; i < sorted.length; i += 1) {
    const row = sorted[i]
    const close = row.close
    const previousClose = sorted[i - lookback]?.close ?? null
    const volume = row.volume
    const baselineVolume = averageVolume[i] ?? null
    const relativeVolume =
      isFiniteNumber(volume) && volume > 0 && isFiniteNumber(baselineVolume) && baselineVolume > 0
        ? volume / baselineVolume
        : null
    const velocity =
      i >= lookback && isFiniteNumber(close) && isFiniteNumber(previousClose) && previousClose > 0
        ? (close - previousClose) / previousClose
        : null
    const previousVelocity = velocities[i - 1] ?? null
    const acceleration =
      isFiniteNumber(velocity) && isFiniteNumber(previousVelocity)
        ? velocity - previousVelocity
        : null

    velocities.push(velocity)

    const ma5Angle = maAngle(ma5[i] ?? null, ma5[i - lookback] ?? null, lookback)
    const ma25Angle = maAngle(ma25[i] ?? null, ma25[i - lookback] ?? null, lookback)
    const ma75Angle = maAngle(ma75[i] ?? null, ma75[i - lookback] ?? null, lookback)
    const ma200Angle = maAngle(ma200[i] ?? null, ma200[i - lookback] ?? null, lookback)
    const maAngleAvg = averageFinite([ma5Angle, ma25Angle, ma75Angle, ma200Angle])

    output.push({
      date: row.date,
      velocity,
      acceleration,
      momentum: isFiniteNumber(velocity) && isFiniteNumber(relativeVolume) ? relativeVolume * velocity : null,
      force: isFiniteNumber(acceleration) && isFiniteNumber(relativeVolume) ? relativeVolume * acceleration : null,
      ma5Angle,
      ma25Angle,
      ma75Angle,
      ma200Angle,
      maAngleAvg,
      energy: isFiniteNumber(velocity) && isFiniteNumber(relativeVolume)
        ? 0.5 * relativeVolume * velocity * velocity
        : null,
    })
  }

  return output
}

export function meanAndStd(values: Array<number | null>): { mean: number | null; std: number | null } {
  const finite = values.filter(isFiniteNumber)
  if (finite.length === 0) return { mean: null, std: null }

  const mean = finite.reduce((sum, value) => sum + value, 0) / finite.length
  const variance = finite.reduce((sum, value) => sum + (value - mean) ** 2, 0) / finite.length
  const std = Math.sqrt(variance)

  return { mean, std: std > 0 ? std : null }
}

export function winsorizedMeanAndStd(
  values: Array<number | null>,
  tailRatio = 0.01,
): PhysicalMomentumNormalizationStats {
  const finite = values.filter(isFiniteNumber).sort((a, b) => a - b)
  if (finite.length === 0) {
    return { mean: null, std: null, lower: null, upper: null }
  }

  const boundedTail = Math.max(0, Math.min(0.2, tailRatio))
  const lowerIndex = Math.floor((finite.length - 1) * boundedTail)
  const upperIndex = Math.ceil((finite.length - 1) * (1 - boundedTail))
  const lower = finite[lowerIndex]
  const upper = finite[upperIndex]
  const winsorized = finite.map((value) => Math.max(lower, Math.min(upper, value)))
  const { mean, std } = meanAndStd(winsorized)
  return { mean, std, lower, upper }
}

export function zScore(value: number | null, mean: number | null, std: number | null): number | null {
  if (!isFiniteNumber(value) || !isFiniteNumber(mean) || !isFiniteNumber(std) || std === 0) return null
  return (value - mean) / std
}

export function winsorizedZScore(
  value: number | null,
  stats: PhysicalMomentumNormalizationStats,
): number | null {
  if (
    !isFiniteNumber(value)
    || !isFiniteNumber(stats.lower)
    || !isFiniteNumber(stats.upper)
  ) {
    return null
  }
  return zScore(
    Math.max(stats.lower, Math.min(stats.upper, value)),
    stats.mean,
    stats.std,
  )
}

function averageZ(values: Array<number | null>): number | null {
  if (values.some((value) => !isFiniteNumber(value))) return null
  const finite = values.filter(isFiniteNumber)
  return finite.reduce((sum, value) => sum + value, 0) / finite.length
}

export function composePhysicalMomentumScores(row: {
  zVelocity: number | null
  zAcceleration: number | null
  zMomentum: number | null
  zForce: number | null
  zMaAngleAvg: number | null
  zEnergy: number | null
}): Pick<PhysicalMomentumZRow, 'physicalMomentumScore' | 'physicalForceScore' | 'physicalEnergyScore'> {
  return {
    physicalMomentumScore: averageZ([
      row.zVelocity,
      row.zAcceleration,
      row.zMomentum,
      row.zForce,
      row.zMaAngleAvg,
      row.zEnergy,
    ]),
    physicalForceScore: averageZ([row.zForce, row.zAcceleration]),
    physicalEnergyScore: averageZ([row.zEnergy, row.zMomentum]),
  }
}
