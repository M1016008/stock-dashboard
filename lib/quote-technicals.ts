export type MacdRelation = 'golden' | 'dead' | 'neutral'
export type MacdCrossType = Exclude<MacdRelation, 'neutral'>

export interface QuoteTechnicalPoint {
  date: string
  close: number
  volume: number
}

export interface QuoteTechnicalSummary {
  asOfDate: string
  averageVolume30: number | null
  averageVolumeObservationCount: number
  macd: {
    relation: MacdRelation
    value: number
    signal: number
    histogram: number
    lastCrossType: MacdCrossType | null
    lastCrossDate: string | null
  } | null
}

function calculateEma(values: number[], period: number): Array<number | null> {
  const result: Array<number | null> = new Array(values.length).fill(null)
  if (values.length < period) return result

  const seed = values.slice(0, period).reduce((sum, value) => sum + value, 0) / period
  result[period - 1] = seed
  const multiplier = 2 / (period + 1)

  for (let index = period; index < values.length; index += 1) {
    result[index] = values[index] * multiplier + result[index - 1]! * (1 - multiplier)
  }
  return result
}

export function buildQuoteTechnicalSummary(input: QuoteTechnicalPoint[]): QuoteTechnicalSummary | null {
  const rowsByDate = new Map<string, QuoteTechnicalPoint>()
  for (const row of input) {
    if (
      !/^\d{4}-\d{2}-\d{2}$/.test(row.date) ||
      !Number.isFinite(row.close) ||
      !Number.isFinite(row.volume)
    ) {
      continue
    }
    rowsByDate.set(row.date, row)
  }
  const rows = [...rowsByDate.values()].sort((left, right) => left.date.localeCompare(right.date))
  if (rows.length === 0) return null

  const volumeRows = rows.slice(-30)
  const averageVolume30 = volumeRows.length > 0
    ? volumeRows.reduce((sum, row) => sum + Math.max(0, row.volume), 0) / volumeRows.length
    : null

  const closes = rows.map((row) => row.close)
  const ema12 = calculateEma(closes, 12)
  const ema26 = calculateEma(closes, 26)
  const macdValues = closes.map((_, index) => {
    const fast = ema12[index]
    const slow = ema26[index]
    return fast == null || slow == null ? null : fast - slow
  })
  const firstMacdIndex = macdValues.findIndex((value) => value != null)
  const compactMacd = firstMacdIndex >= 0
    ? macdValues.slice(firstMacdIndex).filter((value): value is number => value != null)
    : []
  const compactSignal = calculateEma(compactMacd, 9)
  const signalValues: Array<number | null> = new Array(rows.length).fill(null)
  if (firstMacdIndex >= 0) {
    compactSignal.forEach((value, index) => {
      signalValues[firstMacdIndex + index] = value
    })
  }

  let lastCrossType: MacdCrossType | null = null
  let lastCrossDate: string | null = null
  for (let index = 1; index < rows.length; index += 1) {
    const previousMacd = macdValues[index - 1]
    const previousSignal = signalValues[index - 1]
    const currentMacd = macdValues[index]
    const currentSignal = signalValues[index]
    if (
      previousMacd == null ||
      previousSignal == null ||
      currentMacd == null ||
      currentSignal == null
    ) {
      continue
    }
    const previousDifference = previousMacd - previousSignal
    const currentDifference = currentMacd - currentSignal
    if (previousDifference <= 0 && currentDifference > 0) {
      lastCrossType = 'golden'
      lastCrossDate = rows[index].date
    } else if (previousDifference >= 0 && currentDifference < 0) {
      lastCrossType = 'dead'
      lastCrossDate = rows[index].date
    }
  }

  const latestIndex = rows.length - 1
  const latestMacd = macdValues[latestIndex]
  const latestSignal = signalValues[latestIndex]
  const histogram = latestMacd == null || latestSignal == null ? null : latestMacd - latestSignal
  const relation: MacdRelation = histogram == null || Math.abs(histogram) < 1e-12
    ? 'neutral'
    : histogram > 0 ? 'golden' : 'dead'

  return {
    asOfDate: rows[latestIndex].date,
    averageVolume30,
    averageVolumeObservationCount: volumeRows.length,
    macd: latestMacd == null || latestSignal == null || histogram == null
      ? null
      : {
          relation,
          value: latestMacd,
          signal: latestSignal,
          histogram,
          lastCrossType,
          lastCrossDate,
        },
  }
}
