import type { OHLCV } from '@/types/stock'

export type UsScreenerPeriodMetrics = {
  prevClose: number | null
  close5d: number | null
  close20d: number | null
  close60d: number | null
  close120d: number | null
  avgVolume20: number | null
  ma200: number | null
  ma200Prev: number | null
  ma200Observations: number
}

function average(prefix: number[], start: number, endExclusive: number): number | null {
  const count = endExclusive - start
  return count > 0 ? (prefix[endExclusive] - prefix[start]) / count : null
}

export function computeUsScreenerPeriodMetrics(
  rows: OHLCV[],
  marketDates: string[],
): UsScreenerPeriodMetrics[] {
  const marketIndex = new Map(marketDates.map((date, index) => [date, index]))
  const rowMarketIndices = rows.map((row) => {
    const index = marketIndex.get(row.date)
    if (index == null) throw new Error(`US market calendar is missing ${row.date}.`)
    return index
  })
  const closeByMarketIndex = new Map(
    rows.map((row, index) => [rowMarketIndices[index], row.close]),
  )
  const closePrefix = [0]
  const volumePrefix = [0]
  for (const row of rows) {
    closePrefix.push(closePrefix[closePrefix.length - 1] + row.close)
    volumePrefix.push(volumePrefix[volumePrefix.length - 1] + row.volume)
  }

  let start20 = 0
  let start200 = 0
  let start200Prev = 0
  return rows.map((row, index) => {
    const currentMarketIndex = rowMarketIndices[index]
    while (rowMarketIndices[start20] < currentMarketIndex - 19) start20 += 1
    while (rowMarketIndices[start200] < currentMarketIndex - 199) start200 += 1
    while (rowMarketIndices[start200Prev] < currentMarketIndex - 200) start200Prev += 1

    return {
      prevClose: closeByMarketIndex.get(currentMarketIndex - 1) ?? null,
      close5d: closeByMarketIndex.get(currentMarketIndex - 5) ?? null,
      close20d: closeByMarketIndex.get(currentMarketIndex - 20) ?? null,
      close60d: closeByMarketIndex.get(currentMarketIndex - 60) ?? null,
      close120d: closeByMarketIndex.get(currentMarketIndex - 120) ?? null,
      avgVolume20: average(volumePrefix, start20, index + 1),
      ma200: average(closePrefix, start200, index + 1),
      ma200Prev: average(closePrefix, start200Prev, index),
      ma200Observations: index + 1 - start200,
    }
  })
}
