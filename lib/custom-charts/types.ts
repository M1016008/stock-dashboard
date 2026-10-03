import type { ChartIntervalCode } from '@/lib/timeframes'

export type CustomChartMode = 'valuation' | 'comparison' | 'normalized'
export type CustomChartCurrency = 'LOCAL' | 'JPY' | 'USD'
export type CustomChartMissingPolicy = 'intersection' | 'carry-forward'
export type CustomChartVolumeMode = 'turnover' | 'volume'

export type CustomChartAssetKind = 'JP' | 'US' | 'CMD'

export type FormulaNode =
  | { type: 'number'; value: number }
  | { type: 'asset'; symbol: string }
  | { type: 'unary'; op: '-'; expr: FormulaNode }
  | { type: 'binary'; op: '+' | '-' | '*' | '/' | '^'; left: FormulaNode; right: FormulaNode }

export type CustomAssetRef =
  | { kind: 'JP'; ticker: string; key: string; input: string }
  | { kind: 'US'; ticker: string; key: string; input: string }
  | { kind: 'CMD'; market: 'JP' | 'US'; ticker: string; key: string; input: string }

export type CustomChartIndicatorConfig = {
  ma: number[]
  bollinger: boolean
  rsi: boolean
  macd: boolean
  volumeMode: CustomChartVolumeMode
}

export type CustomChartRequest = {
  formula: string
  mode: CustomChartMode
  period: '1mo' | '3mo' | '6mo' | '1y' | '2y' | '5y' | '10y' | 'all'
  interval: ChartIntervalCode
  displayCurrency: CustomChartCurrency
  missingPolicy: CustomChartMissingPolicy
  baseDate?: string | null
  indicators: CustomChartIndicatorConfig
}

export type CustomChartAssetMeta = CustomAssetRef & {
  name: string
  marketLabel: string
  currency: 'JPY' | 'USD'
  priceBasis: 'close' | 'adj_close'
}

export type CustomChartPoint = {
  date: string
  value: number
}

export type CustomChartVolumePoint = {
  date: string
  value: number
}

export type CustomChartCandle = {
  date: string
  open: number
  high: number
  low: number
  close: number
}

export type CustomChartEvaluation = {
  formula: string
  normalizedFormula: string
  description: string
  mode: CustomChartMode
  interval: ChartIntervalCode
  displayCurrency: CustomChartCurrency
  effectiveCurrency: 'JPY' | 'USD' | 'MIXED'
  missingPolicy: CustomChartMissingPolicy
  priceBasis: string
  assets: CustomChartAssetMeta[]
  warnings: string[]
  series: CustomChartPoint[]
  candles: CustomChartCandle[]
  volume: CustomChartVolumePoint[]
  indicators: {
    ma: Record<string, CustomChartPoint[]>
    bollinger: {
      upper: CustomChartPoint[]
      middle: CustomChartPoint[]
      lower: CustomChartPoint[]
    } | null
    rsi: CustomChartPoint[] | null
    macd: {
      macd: CustomChartPoint[]
      signal: CustomChartPoint[]
      histogram: CustomChartPoint[]
    } | null
  }
}

export type StoredCustomChart = {
  id: string
  name: string
  formula: string
  mode: CustomChartMode
  baseDate: string | null
  displayCurrency: CustomChartCurrency
  missingPolicy: CustomChartMissingPolicy
  indicators: CustomChartIndicatorConfig
  favorite: boolean
  sortOrder: number
  createdAt: number
  updatedAt: number
}

export type CustomChartSymbolCandidate = {
  token: string
  label: string
  name: string
  market: 'JP' | 'US' | 'CMD'
  ticker: string
  currency: 'JPY' | 'USD'
  description: string
}
