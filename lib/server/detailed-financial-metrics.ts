import { execGet, execRun } from '@/lib/db/client'
import {
  calculateAdvancedFinancialMetrics,
  type CalculatedFinancialMetric,
  type FinancialMetricKey,
} from '@/lib/financial-metrics'
import { loadDetailedFinancialFacts } from '@/lib/server/detailed-financial-foundation-store'
import {
  loadFinancialForecastSnapshots,
  loadNormalizedFinancialFacts,
  upsertCalculatedFinancialMetrics,
} from '@/lib/server/financial-foundation-store'

export const ADVANCED_FINANCIAL_METRIC_KEYS = [
  'net_debt',
  'ebitda',
  'standard_fcf',
  'enterprise_value',
  'ev_ebitda',
  'fcf_yield',
  'roic',
] as const satisfies readonly FinancialMetricKey[]

export interface AdvancedMetricBuildResult {
  ticker: string
  asOf: string
  isFinancialSector: boolean
  metrics: CalculatedFinancialMetric[]
}

function isFinancialSectorName(value: string): boolean {
  return /銀行|保険|証券|金融/.test(value)
}

export async function buildAdvancedFinancialMetricsForTicker(
  ticker: string,
  requestedAsOf?: string,
): Promise<AdvancedMetricBuildResult> {
  const [latestPrice, sector, facts, forecasts, detailedFacts] = await Promise.all([
    execGet<{ date: string; close: number }>(`
      SELECT date, close FROM ohlcv_daily
      WHERE ticker = ? ${requestedAsOf ? 'AND date <= ?' : ''}
      ORDER BY date DESC LIMIT 1
    `, requestedAsOf ? [ticker, requestedAsOf] : [ticker]),
    execGet<{ sector17_name: string | null; sector33_name: string | null }>(`
      SELECT sector17_name, sector33_name FROM ticker_universe WHERE ticker = ?
    `, [ticker]),
    loadNormalizedFinancialFacts(ticker),
    loadFinancialForecastSnapshots(ticker),
    loadDetailedFinancialFacts(ticker, requestedAsOf),
  ])

  const asOf = requestedAsOf
    ?? latestPrice?.date
    ?? detailedFacts.map((fact) => fact.publishedAt.slice(0, 10)).sort().at(-1)
    ?? new Date().toISOString().slice(0, 10)
  const sectorName = `${sector?.sector17_name ?? ''} ${sector?.sector33_name ?? ''}`
  const isFinancialSector = isFinancialSectorName(sectorName)
  const metrics = calculateAdvancedFinancialMetrics({
    ticker,
    asOf,
    facts,
    forecasts,
    detailedFacts,
    price: latestPrice
      ? { value: Number(latestPrice.close), date: latestPrice.date, inputId: `price:JP:${ticker}:${latestPrice.date}` }
      : null,
    isFinancialSector,
  })
  return { ticker, asOf, isFinancialSector, metrics }
}

export async function calculateAndStoreAdvancedFinancialMetrics(
  ticker: string,
  requestedAsOf?: string,
): Promise<AdvancedMetricBuildResult> {
  const result = await buildAdvancedFinancialMetricsForTicker(ticker, requestedAsOf)
  await execRun(`
    DELETE FROM calculated_financial_metrics
    WHERE ticker = ? AND as_of = ?
      AND metric IN (${ADVANCED_FINANCIAL_METRIC_KEYS.map(() => '?').join(',')})
  `, [ticker, result.asOf, ...ADVANCED_FINANCIAL_METRIC_KEYS])
  await upsertCalculatedFinancialMetrics(result.metrics)
  return result
}
