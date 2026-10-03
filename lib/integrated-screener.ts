export type ScreeningCategory =
  | 'company'
  | 'growth'
  | 'quality'
  | 'valuation'
  | 'shareholder'
  | 'forecast'
  | 'structure'
  | 'margin'

export type ScreeningOperator = 'gte' | 'gt' | 'lte' | 'lt' | 'eq' | 'between' | 'in' | 'has_data'

export type ScreeningMetricKey =
  | 'marketSegment' | 'sector17' | 'sector33' | 'majorCategory' | 'subIndustry' | 'marketCap'
  | 'revenue' | 'revenueGrowth' | 'epsGrowth' | 'revenueCagr3y' | 'revenueCagr5y' | 'operatingMargin'
  | 'roe' | 'roa' | 'equityRatio' | 'standardFcf' | 'fcfYield' | 'netDebt' | 'roic'
  | 'per' | 'forwardPer' | 'pbr' | 'psr' | 'evEbitda' | 'perPercentile5y' | 'pbrPercentile5y' | 'sectorValuationPercentile'
  | 'forecastDividendYield' | 'payoutRatio' | 'forecastDps' | 'dpsYoy' | 'consecutiveIncreaseYears'
  | 'consecutiveNonDecreaseYears' | 'dpsCagr3y' | 'dpsCagr5y'
  | 'forecastRevenueGrowth' | 'forecastOperatingProfitGrowth' | 'forecastEpsGrowth'
  | 'latestForecastRevisionRate' | 'latestForecastRevisionDirection' | 'hasCurrentForecast' | 'hasNextForecast'
  | 'dailyAStage' | 'dailyBStage' | 'weeklyAStage' | 'weeklyBStage' | 'monthlyAStage' | 'monthlyBStage'
  | 'stageCode' | 'sectorStructureScore' | 'sectorRank' | 'pms' | 'pfs' | 'maStructure' | 'shortTermCheck'
  | 'creditRatio' | 'longMargin' | 'shortMargin' | 'longMarginChange' | 'shortMarginChange'

export interface ScreeningCondition {
  id: string
  metric: ScreeningMetricKey
  operator: ScreeningOperator
  value?: number | string | boolean | Array<number | string>
  valueTo?: number
}

export interface ScreeningMetricDefinition {
  key: ScreeningMetricKey
  label: string
  category: ScreeningCategory
  valueType: 'number' | 'percent' | 'currency' | 'stage' | 'text' | 'boolean'
  unit?: string
  operators: ScreeningOperator[]
  options?: Array<{ value: string | number | boolean; label: string }>
  coverageWarningBelow?: number
}

export interface ScreeningPreset {
  id: string
  label: string
  description: string
  conditions: Array<Omit<ScreeningCondition, 'id'>>
}

export interface IntegratedScreeningRow {
  ticker: string
  name: string
  asOf: string
  snapshotDate: string
  valuationDate: string | null
  marketSegment: string | null
  sector17: string | null
  sector33: string | null
  majorCategory: string | null
  subIndustry: string | null
  price: number | null
  marketCap: number | null
  revenue: number | null
  revenueGrowth: number | null
  epsGrowth: number | null
  revenueCagr3y: number | null
  revenueCagr5y: number | null
  operatingMargin: number | null
  roe: number | null
  roa: number | null
  equityRatio: number | null
  standardFcf: number | null
  fcfYield: number | null
  netDebt: number | null
  roic: number | null
  per: number | null
  forwardPer: number | null
  pbr: number | null
  psr: number | null
  evEbitda: number | null
  perPercentile5y: number | null
  pbrPercentile5y: number | null
  sectorValuationPercentile: number | null
  forecastDividendYield: number | null
  payoutRatio: number | null
  forecastDps: number | null
  dpsYoy: number | null
  consecutiveIncreaseYears: number | null
  consecutiveNonDecreaseYears: number | null
  dpsCagr3y: number | null
  dpsCagr5y: number | null
  forecastRevenueGrowth: number | null
  forecastOperatingProfitGrowth: number | null
  forecastEpsGrowth: number | null
  latestForecastRevisionRate: number | null
  latestForecastRevisionDirection: string | null
  hasCurrentForecast: boolean | null
  hasNextForecast: boolean | null
  dailyAStage: number | null
  dailyBStage: number | null
  weeklyAStage: number | null
  weeklyBStage: number | null
  monthlyAStage: number | null
  monthlyBStage: number | null
  stageCode: string | null
  sectorStructureScore: number | null
  sectorRank: number | null
  pms: number | null
  pfs: number | null
  maStructure: string | null
  shortTermCheck: string | null
  creditRatio: number | null
  longMargin: number | null
  shortMargin: number | null
  longMarginChange: number | null
  shortMarginChange: number | null
}

export interface ScreeningCoverage {
  metric: ScreeningMetricKey
  available: number
  universe: number
  percent: number
}

export interface IntegratedScreeningResponse {
  contractVersion: 'integrated-screener-v1'
  asOf: string
  snapshotDate: string
  servingBuiltAt: number
  total: number
  universe: number
  rows: IntegratedScreeningRow[]
  coverage: ScreeningCoverage[]
  options: Partial<Record<ScreeningMetricKey, Array<{ value: string; count: number }>>>
  limit: number
  offset: number
  elapsedMs: number
  cacheHit: boolean
}

const numericOperators: ScreeningOperator[] = ['gte', 'gt', 'lte', 'lt', 'eq', 'between', 'has_data']
const textOperators: ScreeningOperator[] = ['eq', 'in', 'has_data']

const stageOptions = [1, 2, 3, 4, 5, 6].map((value) => ({ value, label: `Stage ${value}` }))

export const SCREENING_CATEGORY_LABELS: Record<ScreeningCategory, string> = {
  company: '企業基本', growth: '業績・成長', quality: 'Quality', valuation: 'Valuation',
  shareholder: '株主還元', forecast: '業績予想・修正', structure: '市場構造', margin: '需給',
}

export const SCREENING_METRICS: ScreeningMetricDefinition[] = [
  { key: 'marketSegment', label: '市場', category: 'company', valueType: 'text', operators: textOperators },
  { key: 'sector17', label: '17業種', category: 'company', valueType: 'text', operators: textOperators },
  { key: 'sector33', label: '33業種', category: 'company', valueType: 'text', operators: textOperators },
  { key: 'majorCategory', label: '独自60分類', category: 'company', valueType: 'text', operators: textOperators },
  { key: 'subIndustry', label: '独自細分類', category: 'company', valueType: 'text', operators: textOperators },
  { key: 'marketCap', label: '時価総額', category: 'company', valueType: 'currency', unit: '円', operators: numericOperators },
  { key: 'revenue', label: '売上高', category: 'growth', valueType: 'currency', unit: '円', operators: numericOperators },
  { key: 'revenueGrowth', label: 'LTM売上成長率', category: 'growth', valueType: 'percent', unit: '%', operators: numericOperators },
  { key: 'epsGrowth', label: 'EPS成長率', category: 'growth', valueType: 'percent', unit: '%', operators: numericOperators },
  { key: 'revenueCagr3y', label: '売上3年CAGR', category: 'growth', valueType: 'percent', unit: '%', operators: numericOperators },
  { key: 'revenueCagr5y', label: '売上5年CAGR', category: 'growth', valueType: 'percent', unit: '%', operators: numericOperators },
  { key: 'operatingMargin', label: '営業利益率', category: 'growth', valueType: 'percent', unit: '%', operators: numericOperators },
  { key: 'roe', label: 'ROE', category: 'quality', valueType: 'percent', unit: '%', operators: numericOperators },
  { key: 'roa', label: 'ROA', category: 'quality', valueType: 'percent', unit: '%', operators: numericOperators },
  { key: 'equityRatio', label: '自己資本比率', category: 'quality', valueType: 'percent', unit: '%', operators: numericOperators },
  { key: 'standardFcf', label: '標準FCF', category: 'quality', valueType: 'currency', unit: '円', operators: numericOperators },
  { key: 'fcfYield', label: 'FCF Yield', category: 'quality', valueType: 'percent', unit: '%', operators: numericOperators },
  { key: 'netDebt', label: 'Net Debt', category: 'quality', valueType: 'currency', unit: '円', operators: numericOperators },
  { key: 'roic', label: 'ROIC', category: 'quality', valueType: 'percent', unit: '%', operators: numericOperators, coverageWarningBelow: 60 },
  { key: 'per', label: 'PER', category: 'valuation', valueType: 'number', unit: 'x', operators: numericOperators },
  { key: 'forwardPer', label: 'Forward PER', category: 'valuation', valueType: 'number', unit: 'x', operators: numericOperators },
  { key: 'pbr', label: 'PBR', category: 'valuation', valueType: 'number', unit: 'x', operators: numericOperators },
  { key: 'psr', label: 'PSR', category: 'valuation', valueType: 'number', unit: 'x', operators: numericOperators },
  { key: 'evEbitda', label: 'EV/EBITDA', category: 'valuation', valueType: 'number', unit: 'x', operators: numericOperators, coverageWarningBelow: 60 },
  { key: 'perPercentile5y', label: '5年PER Percentile', category: 'valuation', valueType: 'percent', unit: '%', operators: numericOperators },
  { key: 'pbrPercentile5y', label: '5年PBR Percentile', category: 'valuation', valueType: 'percent', unit: '%', operators: numericOperators },
  { key: 'sectorValuationPercentile', label: '業種内Valuation Percentile', category: 'valuation', valueType: 'percent', unit: '%', operators: numericOperators },
  { key: 'forecastDividendYield', label: '予想配当利回り', category: 'shareholder', valueType: 'percent', unit: '%', operators: numericOperators },
  { key: 'payoutRatio', label: '配当性向', category: 'shareholder', valueType: 'percent', unit: '%', operators: numericOperators },
  { key: 'forecastDps', label: '予想DPS', category: 'shareholder', valueType: 'number', unit: '円', operators: numericOperators },
  { key: 'dpsYoy', label: 'DPS前年比', category: 'shareholder', valueType: 'percent', unit: '%', operators: numericOperators },
  { key: 'consecutiveIncreaseYears', label: '連続増配年数', category: 'shareholder', valueType: 'number', unit: '年', operators: numericOperators },
  { key: 'consecutiveNonDecreaseYears', label: '連続非減配年数', category: 'shareholder', valueType: 'number', unit: '年', operators: numericOperators },
  { key: 'dpsCagr3y', label: 'DPS 3年CAGR', category: 'shareholder', valueType: 'percent', unit: '%', operators: numericOperators },
  { key: 'dpsCagr5y', label: 'DPS 5年CAGR', category: 'shareholder', valueType: 'percent', unit: '%', operators: numericOperators },
  { key: 'forecastRevenueGrowth', label: '当期売上予想成長率', category: 'forecast', valueType: 'percent', unit: '%', operators: numericOperators },
  { key: 'forecastOperatingProfitGrowth', label: '当期営業利益予想成長率', category: 'forecast', valueType: 'percent', unit: '%', operators: numericOperators },
  { key: 'forecastEpsGrowth', label: '当期EPS予想成長率', category: 'forecast', valueType: 'percent', unit: '%', operators: numericOperators },
  { key: 'latestForecastRevisionRate', label: '最新予想修正率', category: 'forecast', valueType: 'percent', unit: '%', operators: numericOperators },
  { key: 'latestForecastRevisionDirection', label: '予想修正方向', category: 'forecast', valueType: 'text', operators: textOperators, options: [
    { value: 'up', label: '上方修正' }, { value: 'down', label: '下方修正' }, { value: 'unchanged', label: '据え置き' },
  ] },
  { key: 'hasCurrentForecast', label: '当期予想あり', category: 'forecast', valueType: 'boolean', operators: ['eq'], options: [{ value: true, label: 'あり' }, { value: false, label: 'なし' }] },
  { key: 'hasNextForecast', label: '翌期予想あり', category: 'forecast', valueType: 'boolean', operators: ['eq'], options: [{ value: true, label: 'あり' }, { value: false, label: 'なし' }] },
  ...(['dailyAStage', 'dailyBStage', 'weeklyAStage', 'weeklyBStage', 'monthlyAStage', 'monthlyBStage'] as ScreeningMetricKey[]).map((key, index) => ({
    key, label: ['日A', '日B', '週A', '週B', '月A', '月B'][index], category: 'structure' as const,
    valueType: 'stage' as const, operators: ['eq', 'in', 'has_data'] as ScreeningOperator[], options: stageOptions,
  })),
  { key: 'stageCode', label: '6桁ステージコード', category: 'structure', valueType: 'text', operators: ['eq', 'has_data'] },
  { key: 'sectorStructureScore', label: '業種構造スコア', category: 'structure', valueType: 'number', operators: numericOperators },
  { key: 'sectorRank', label: '業種順位', category: 'structure', valueType: 'number', operators: numericOperators },
  { key: 'pms', label: 'PMS', category: 'structure', valueType: 'number', operators: numericOperators },
  { key: 'pfs', label: 'PFS', category: 'structure', valueType: 'number', operators: numericOperators },
  { key: 'maStructure', label: 'MA構造', category: 'structure', valueType: 'text', operators: textOperators, options: [
    { value: 'bullish_aligned', label: '上昇整列' }, { value: 'bearish_aligned', label: '下降整列' },
    { value: 'converging', label: '収束' }, { value: 'mixed', label: '混在' },
  ] },
  { key: 'shortTermCheck', label: '短期チェック', category: 'structure', valueType: 'text', operators: textOperators },
  { key: 'creditRatio', label: '信用倍率', category: 'margin', valueType: 'number', unit: 'x', operators: numericOperators },
  { key: 'longMargin', label: '信用買残', category: 'margin', valueType: 'number', unit: '株', operators: numericOperators },
  { key: 'shortMargin', label: '信用売残', category: 'margin', valueType: 'number', unit: '株', operators: numericOperators },
  { key: 'longMarginChange', label: '買残前週比', category: 'margin', valueType: 'number', unit: '株', operators: numericOperators },
  { key: 'shortMarginChange', label: '売残前週比', category: 'margin', valueType: 'number', unit: '株', operators: numericOperators },
]

export const SCREENING_METRIC_MAP = new Map(SCREENING_METRICS.map((metric) => [metric.key, metric]))

const c = (metric: ScreeningMetricKey, operator: ScreeningOperator, value?: ScreeningCondition['value']): Omit<ScreeningCondition, 'id'> => ({ metric, operator, value })

export const SCREENING_PRESETS: ScreeningPreset[] = [
  { id: 'growth', label: '成長株', description: '売上とEPSが伸びている企業', conditions: [c('revenueGrowth', 'gte', 10), c('epsGrowth', 'gte', 10)] },
  { id: 'value', label: '割安株', description: '予想利益と純資産に対する倍率を抑える', conditions: [c('forwardPer', 'lte', 15), c('pbr', 'lte', 1.5)] },
  { id: 'quality', label: 'Quality株', description: '収益性とキャッシュ創出を確認', conditions: [c('roe', 'gte', 10), c('operatingMargin', 'gte', 8), c('standardFcf', 'gt', 0)] },
  { id: 'high-dividend', label: '高配当', description: '予想利回り3%以上', conditions: [c('forecastDividendYield', 'gte', 3)] },
  { id: 'dividend-growth', label: '増配', description: '3年以上の連続増配', conditions: [c('consecutiveIncreaseYears', 'gte', 3)] },
  { id: 'revision-up', label: '業績上方修正', description: '最新会社予想が上方修正', conditions: [c('latestForecastRevisionDirection', 'eq', 'up')] },
  { id: 'structure-up', label: '構造上昇', description: '業種構造とPMSが上向き', conditions: [c('sectorStructureScore', 'gte', 70), c('pms', 'gt', 0)] },
  { id: 'turnaround', label: '反転候補', description: '週足初動と短期好転を確認', conditions: [c('weeklyAStage', 'in', [5, 6]), c('shortTermCheck', 'in', ['好転候補', '強気優勢'])] },
  { id: 'growth-value', label: '成長 × 割安', description: '成長率と予想PERを同時確認', conditions: [c('revenueGrowth', 'gte', 8), c('forwardPer', 'lte', 15)] },
  { id: 'quality-structure', label: 'Quality × 構造上昇', description: 'ROEと構造スコアを両立', conditions: [c('roe', 'gte', 10), c('sectorStructureScore', 'gte', 60), c('pms', 'gt', 0)] },
]

export const DEFAULT_SCREENING_COLUMNS: ScreeningMetricKey[] = [
  'marketCap', 'revenueGrowth', 'roe', 'forwardPer', 'pbr', 'forecastDividendYield', 'sectorStructureScore', 'stageCode',
]
