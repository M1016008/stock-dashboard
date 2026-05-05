// lib/alert-engine.ts
import type { Alert } from '@/types/alert'
import type { OHLCV } from '@/types/stock'
import { calcSMA, calcMACD } from './indicators'

export function checkPriceAlert(
  condition: Extract<Alert['condition'], { type: 'PRICE_ABOVE' | 'PRICE_BELOW' }>,
  currentPrice: number
): boolean {
  if (condition.type === 'PRICE_ABOVE') return currentPrice > condition.threshold
  if (condition.type === 'PRICE_BELOW') return currentPrice < condition.threshold
  return false
}

export function checkMAOrder(
  condition: Extract<Alert['condition'], { type: 'MA_ORDER' }>,
  ohlcvData: OHLCV[]
): boolean {
  if (ohlcvData.length < 75) return false
  const sma5  = calcSMA(ohlcvData, 5)
  const sma25 = calcSMA(ohlcvData, 25)
  const sma75 = calcSMA(ohlcvData, 75)

  const last = ohlcvData.length - 1
  const v5  = sma5[last]
  const v25 = sma25[last]
  const v75 = sma75[last]

  if (v5 == null || v25 == null || v75 == null) return false

  if (condition.order === 'BULLISH') return v5 > v25 && v25 > v75
  if (condition.order === 'BEARISH') return v5 < v25 && v25 < v75
  return false
}

export function checkCross(
  condition: Extract<Alert['condition'], { type: 'GOLDEN_CROSS' | 'DEAD_CROSS' }>,
  ohlcvData: OHLCV[]
): boolean {
  const { shortPeriod, longPeriod } = condition
  if (ohlcvData.length < longPeriod + 1) return false

  const shortMA = calcSMA(ohlcvData, shortPeriod)
  const longMA  = calcSMA(ohlcvData, longPeriod)

  const last = ohlcvData.length - 1
  const prev = last - 1

  const prevShort = shortMA[prev]
  const prevLong  = longMA[prev]
  const curShort  = shortMA[last]
  const curLong   = longMA[last]

  if (prevShort == null || prevLong == null || curShort == null || curLong == null) return false

  if (condition.type === 'GOLDEN_CROSS') return prevShort < prevLong && curShort > curLong
  if (condition.type === 'DEAD_CROSS')   return prevShort > prevLong && curShort < curLong
  return false
}

export function checkMACDCross(
  condition: Extract<Alert['condition'], { type: 'MACD_GOLDEN_CROSS' | 'MACD_DEAD_CROSS' }>,
  ohlcvData: OHLCV[]
): boolean {
  if (ohlcvData.length < 35) return false
  const { macd, signal } = calcMACD(ohlcvData)

  const last = ohlcvData.length - 1
  const prev = last - 1

  const prevMACD   = macd[prev]
  const prevSignal = signal[prev]
  const curMACD    = macd[last]
  const curSignal  = signal[last]

  if (prevMACD == null || prevSignal == null || curMACD == null || curSignal == null) return false

  if (condition.type === 'MACD_GOLDEN_CROSS') return prevMACD < prevSignal && curMACD > curSignal
  if (condition.type === 'MACD_DEAD_CROSS')   return prevMACD > prevSignal && curMACD < curSignal
  return false
}

export function evaluateAlert(
  alert: Alert,
  ohlcvData: OHLCV[],
  currentPrice: number
): boolean {
  if (!alert.enabled) return false

  // クールダウン判定
  if (alert.lastTriggeredAt) {
    const lastTriggered = new Date(alert.lastTriggeredAt).getTime()
    const cooldownMs = alert.cooldownMinutes * 60 * 1000
    if (Date.now() - lastTriggered < cooldownMs) return false
  }

  const c = alert.condition
  switch (c.type) {
    case 'PRICE_ABOVE':
    case 'PRICE_BELOW':
      return checkPriceAlert(c, currentPrice)
    case 'MA_ORDER':
      return checkMAOrder(c, ohlcvData)
    case 'GOLDEN_CROSS':
    case 'DEAD_CROSS':
      return checkCross(c, ohlcvData)
    case 'MACD_GOLDEN_CROSS':
    case 'MACD_DEAD_CROSS':
      return checkMACDCross(c, ohlcvData)
    default:
      return false
  }
}

// 全アラートを一括評価（銘柄ごとにデータをまとめて取得）
export async function evaluateAllAlerts(
  alerts: Alert[],
  fetchData: (ticker: string) => Promise<{ ohlcv: OHLCV[]; currentPrice: number }>
): Promise<Alert[]> {
  const enabledAlerts = alerts.filter(a => a.enabled)

  // 銘柄ごとにグループ化（重複リクエスト排除）
  const tickerMap = new Map<string, Alert[]>()
  for (const alert of enabledAlerts) {
    const ticker = alert.condition.ticker
    if (!tickerMap.has(ticker)) tickerMap.set(ticker, [])
    tickerMap.get(ticker)!.push(alert)
  }

  const triggered: Alert[] = []

  for (const [ticker, tickerAlerts] of tickerMap) {
    try {
      const { ohlcv, currentPrice } = await fetchData(ticker)
      for (const alert of tickerAlerts) {
        if (evaluateAlert(alert, ohlcv, currentPrice)) {
          triggered.push(alert)
        }
      }
    } catch (error) {
      console.error(`Alert evaluation error for ${ticker}:`, error)
    }
  }

  return triggered
}
