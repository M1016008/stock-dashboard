export const PHYSICAL_MOMENTUM_LOOKBACK_DAYS = 20
export const PHYSICAL_MOMENTUM_MA_PERIODS = [5, 25, 75, 200] as const

export type PhysicalMomentumMaPeriod = typeof PHYSICAL_MOMENTUM_MA_PERIODS[number]

export type PhysicalMomentumInputRow = {
  date: string
  close: number | null
  volume: number | null
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
  if (!isFiniteNumber(current) || !isFiniteNumber(previous) || lookback <= 0) return null
  return Math.atan((current - previous) / lookback)
}

function averageFinite(values: Array<number | null>): number | null {
  const finite = values.filter(isFiniteNumber)
  if (finite.length !== values.length || finite.length === 0) return null
  return finite.reduce((sum, value) => sum + value, 0) / finite.length
}

export function computePhysicalMomentumRawRows(
  rows: PhysicalMomentumInputRow[],
  lookback = PHYSICAL_MOMENTUM_LOOKBACK_DAYS,
): PhysicalMomentumRawRow[] {
  const sorted = [...rows].sort((a, b) => a.date.localeCompare(b.date))
  const closes = sorted.map((row) => row.close)
  const ma5 = rollingSma(closes, 5)
  const ma25 = rollingSma(closes, 25)
  const ma75 = rollingSma(closes, 75)
  const ma200 = rollingSma(closes, 200)
  const velocities: Array<number | null> = []
  const output: PhysicalMomentumRawRow[] = []

  for (let i = 0; i < sorted.length; i += 1) {
    const row = sorted[i]
    const close = row.close
    const previousClose = sorted[i - lookback]?.close ?? null
    const volume = row.volume
    const canUseVolume = isFiniteNumber(volume) && volume > 0
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
      momentum: isFiniteNumber(velocity) && canUseVolume ? volume * velocity : null,
      force: isFiniteNumber(acceleration) && canUseVolume ? volume * acceleration : null,
      ma5Angle,
      ma25Angle,
      ma75Angle,
      ma200Angle,
      maAngleAvg,
      energy: isFiniteNumber(velocity) && canUseVolume ? 0.5 * volume * velocity * velocity : null,
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

export function zScore(value: number | null, mean: number | null, std: number | null): number | null {
  if (!isFiniteNumber(value) || !isFiniteNumber(mean) || !isFiniteNumber(std) || std === 0) return null
  return (value - mean) / std
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
