import type { OHLCV } from '@/types/stock'

export type StockPreviewMarket = 'JP' | 'US'
export type StockPreviewContext = 'latest' | 'periodExplorer' | 'screener' | 'industry' | 'watchlist' | 'home' | 'backtest'

export interface StockPreviewStages {
  dailyA: number | null
  dailyB: number | null
  weeklyA: number | null
  weeklyB: number | null
  monthlyA: number | null
  monthlyB: number | null
}

export interface StockPreviewData {
  success: true
  ticker: string
  market: StockPreviewMarket
  name: string
  requestedAsOf: string | null
  asOf: string
  priceDate: string
  stageDate: string | null
  price: number
  change: number | null
  changePercent: number | null
  sector: string | null
  sector17: string | null
  marketSegment: string | null
  marginType: string | null
  description: string | null
  stages: StockPreviewStages
  marketCap: number | null
  marketCapBasis: 'pit' | 'current' | 'missing'
  avgTradingValue20: number | null
  avgVolume20: number | null
  high52: number | null
  low52: number | null
  high52DistancePercent: number | null
  low52DistancePercent: number | null
  attributeBasis: 'current'
  chart?: OHLCV[]
  elapsedMs: number
}

export const STOCK_PREVIEW_STAGE_ORDER = [
  'dailyA',
  'dailyB',
  'weeklyA',
  'weeklyB',
  'monthlyA',
  'monthlyB',
] as const satisfies readonly (keyof StockPreviewStages)[]
