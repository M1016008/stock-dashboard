// lib/indicators.ts
import type { OHLCV } from '@/types/stock'

export function calcSMA(data: OHLCV[], period: number): (number | null)[] {
  return data.map((_, i) => {
    if (i < period - 1) return null
    const slice = data.slice(i - period + 1, i + 1)
    const sum = slice.reduce((acc, d) => acc + d.close, 0)
    return sum / period
  })
}

export function calcEMA(data: OHLCV[], period: number): (number | null)[] {
  const k = 2 / (period + 1)
  const result: (number | null)[] = new Array(data.length).fill(null)

  // EMAの最初の値はSMA
  if (data.length < period) return result

  const firstSMA = data.slice(0, period).reduce((acc, d) => acc + d.close, 0) / period
  result[period - 1] = firstSMA

  for (let i = period; i < data.length; i++) {
    result[i] = data[i].close * k + result[i - 1]! * (1 - k)
  }

  return result
}

export function calcRSI(data: OHLCV[], period: number = 14): (number | null)[] {
  const result: (number | null)[] = new Array(data.length).fill(null)

  if (data.length < period + 1) return result

  let avgGain = 0
  let avgLoss = 0

  // 最初のperiod区間の平均を計算
  for (let i = 1; i <= period; i++) {
    const change = data[i].close - data[i - 1].close
    if (change > 0) avgGain += change
    else avgLoss += Math.abs(change)
  }
  avgGain /= period
  avgLoss /= period

  const rs = avgGain / (avgLoss || 1)
  result[period] = 100 - 100 / (1 + rs)

  // Wilder平滑化
  for (let i = period + 1; i < data.length; i++) {
    const change = data[i].close - data[i - 1].close
    const gain = change > 0 ? change : 0
    const loss = change < 0 ? Math.abs(change) : 0

    avgGain = (avgGain * (period - 1) + gain) / period
    avgLoss = (avgLoss * (period - 1) + loss) / period

    const r = avgGain / (avgLoss || 1)
    result[i] = 100 - 100 / (1 + r)
  }

  return result
}

export function calcMACD(data: OHLCV[]): {
  macd: (number | null)[]
  signal: (number | null)[]
  histogram: (number | null)[]
} {
  const ema12 = calcEMA(data, 12)
  const ema26 = calcEMA(data, 26)

  const macd: (number | null)[] = data.map((_, i) => {
    if (ema12[i] == null || ema26[i] == null) return null
    return ema12[i]! - ema26[i]!
  })

  // シグナル: MACDの9期間EMA
  const macdForEMA: OHLCV[] = macd.map((v, i) => ({
    ...data[i],
    close: v ?? 0,
  }))
  const signalRaw = calcEMA(macdForEMA, 9)

  const signal: (number | null)[] = signalRaw.map((v, i) => {
    if (macd[i] == null) return null
    return v
  })

  const histogram: (number | null)[] = macd.map((m, i) => {
    if (m == null || signal[i] == null) return null
    return m - signal[i]!
  })

  return { macd, signal, histogram }
}

export function calcBollingerBands(
  data: OHLCV[],
  period: number = 20,
  stdDev: number = 2
): { upper: (number | null)[]; middle: (number | null)[]; lower: (number | null)[] } {
  const middle = calcSMA(data, period)
  const upper: (number | null)[] = []
  const lower: (number | null)[] = []

  data.forEach((_, i) => {
    if (i < period - 1 || middle[i] == null) {
      upper.push(null)
      lower.push(null)
      return
    }
    const slice = data.slice(i - period + 1, i + 1)
    const mean = middle[i]!
    const variance = slice.reduce((acc, d) => acc + Math.pow(d.close - mean, 2), 0) / period
    const sd = Math.sqrt(variance)
    upper.push(mean + stdDev * sd)
    lower.push(mean - stdDev * sd)
  })

  return { upper, middle, lower }
}

// OHLCV日次データを週足・月足・年足に変換
export function aggregateOHLCV(
  data: OHLCV[],
  period: 'week' | 'month' | 'year'
): OHLCV[] {
  if (data.length === 0) return []

  const getKey = (date: string) => {
    const d = new Date(date)
    if (period === 'week') {
      const startOfWeek = new Date(d)
      startOfWeek.setDate(d.getDate() - d.getDay() + 1)
      return startOfWeek.toISOString().split('T')[0]
    }
    if (period === 'month') return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
    return `${d.getFullYear()}`
  }

  const groups = new Map<string, OHLCV[]>()
  data.forEach(d => {
    const key = getKey(d.date)
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key)!.push(d)
  })

  return Array.from(groups.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, candles]) => ({
      date: candles[0].date,
      open: candles[0].open,
      high: Math.max(...candles.map(c => c.high)),
      low: Math.min(...candles.map(c => c.low)),
      close: candles[candles.length - 1].close,
      volume: candles.reduce((acc, c) => acc + c.volume, 0),
    }))
}
