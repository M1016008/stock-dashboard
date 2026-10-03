import assert from 'node:assert/strict'
import { execGet } from '@/lib/db/client'
import type { DetailedFinancialFact } from '@/lib/detailed-financial-foundation'
import type { FinancialForecastSnapshot, NormalizedFinancialFact } from '@/lib/financial-foundation'
import {
  calculateAdvancedFinancialMetrics,
  calculateFinancialMetrics,
  type CalculatedFinancialMetric,
  type FinancialMetricKey,
} from '@/lib/financial-metrics'
import { loadDetailedFinancialFactsForTickers } from '@/lib/server/detailed-financial-foundation-store'
import {
  loadFinancialForecastSnapshotsForTickers,
  loadNormalizedFinancialFactsForTickers,
} from '@/lib/server/financial-foundation-store'
import {
  buildValuationServingForTicker,
  loadLatestValuationServingRows,
  loadValuationMetricBases,
  servingMetricValue,
  servingPeerMetricValue,
  VALUATION_SERVING_METRICS,
} from '@/lib/server/valuation-serving'

const TICKERS = ['7203', '7003', '8349', '4755'] as const
const PIT_DATES = ['2024-06-28', '2025-06-30'] as const
const PEER_LTM = new Set(['net_income_attributable', 'weighted_average_shares', 'revenue', 'operating_profit', 'operating_cash_flow'])
const PEER_INSTANT = new Set(['equity_attributable', 'bps', 'shares_outstanding', 'treasury_shares'])
const PEER_DETAIL = new Set(['cash_and_cash_equivalents', 'interest_bearing_debt', 'non_controlling_interests', 'depreciation_amortization', 'capex'])

function subtractYears(date: string, years: number): string {
  const value = new Date(`${date}T00:00:00Z`)
  value.setUTCFullYear(value.getUTCFullYear() - years)
  return value.toISOString().slice(0, 10)
}

function metricMap(
  ticker: string,
  date: string,
  price: { date: string; close: number },
  facts: NormalizedFinancialFact[],
  forecasts: FinancialForecastSnapshot[],
  detailedFacts: DetailedFinancialFact[],
  financialSector: boolean,
): Map<FinancialMetricKey, CalculatedFinancialMetric> {
  const context = {
    ticker,
    asOf: date,
    facts,
    forecasts,
    price: { value: Number(price.close), date: price.date, inputId: `price:JP:${ticker}:${price.date}` },
    isFinancialSector: financialSector,
  }
  return new Map([
    ...calculateFinancialMetrics(context),
    ...calculateAdvancedFinancialMetrics({ ...context, detailedFacts }),
  ].map((metric) => [metric.metric, metric]))
}

function closeEnough(actual: number | null, expected: number | undefined, label: string): void {
  if (expected == null) {
    assert.equal(actual, null, `${label}: expected unavailable`)
    return
  }
  assert.notEqual(actual, null, `${label}: serving value is missing`)
  const tolerance = 1e-9 * Math.max(1, Math.abs(expected))
  assert.ok(Math.abs(actual! - expected) <= tolerance, `${label}: ${actual} != ${expected}`)
}

async function verifyDate(
  ticker: string,
  date: string,
  facts: NormalizedFinancialFact[],
  forecasts: FinancialForecastSnapshot[],
  detailedFacts: DetailedFinancialFact[],
  financialSector: boolean,
): Promise<void> {
  const price = await execGet<{ date: string; close: number }>(`
    SELECT date, close FROM ohlcv_daily WHERE ticker = ? AND date <= ? ORDER BY date DESC LIMIT 1
  `, [ticker, date])
  assert.ok(price, `${ticker}: missing price at ${date}`)
  const serving = (await loadLatestValuationServingRows([ticker], date))[0]
  assert.ok(serving, `${ticker}: missing serving row at ${date}`)

  const display = metricMap(ticker, date, price!, facts, forecasts, detailedFacts, financialSector)
  const peerFacts = facts.filter((fact) => (
    fact.periodEnd >= subtractYears(date, 3)
    && (
      (fact.source === 'calculated' && fact.accumulationKind === 'LTM' && PEER_LTM.has(fact.metric))
      || (fact.source === 'jquants' && fact.accumulationKind === 'INSTANT' && PEER_INSTANT.has(fact.metric))
    )
  ))
  const peer = metricMap(
    ticker,
    date,
    price!,
    peerFacts,
    forecasts,
    detailedFacts.filter((fact) => PEER_DETAIL.has(fact.metric)),
    financialSector,
  )

  for (const metric of VALUATION_SERVING_METRICS) {
    closeEnough(servingMetricValue(serving, metric), display.get(metric)?.value, `${ticker}/${date}/${metric}`)
  }
  for (const metric of ['forward_per', 'pbr', 'fcf_yield', 'roe', 'revenue_growth', 'ev_ebitda'] as const) {
    closeEnough(servingPeerMetricValue(serving, metric), peer.get(metric)?.value, `${ticker}/${date}/peer/${metric}`)
  }

  const bases = await loadValuationMetricBases([serving.basisId])
  const forward = bases.get(serving.basisId)?.transforms.forward_per
  if (forward?.forecastSnapshotId) {
    const snapshot = forecasts.find((candidate) => candidate.snapshotId === forward.forecastSnapshotId)
    assert.ok(snapshot && snapshot.publishedAt <= new Date(`${date}T23:59:59.999+09:00`).toISOString())
  }
}

async function main() {
  for (const ticker of TICKERS) {
    const [profile, latestPrice, facts, forecasts, detailedFacts] = await Promise.all([
      execGet<{ sector17Name: string | null; sector33Name: string | null }>(`
        SELECT sector17_name AS sector17Name, sector33_name AS sector33Name
        FROM ticker_universe WHERE ticker = ?
      `, [ticker]),
      execGet<{ date: string }>('SELECT MAX(date) AS date FROM ohlcv_daily WHERE ticker = ?', [ticker]),
      loadNormalizedFinancialFactsForTickers([ticker]),
      loadFinancialForecastSnapshotsForTickers([ticker]),
      loadDetailedFinancialFactsForTickers([ticker]),
    ])
    assert.ok(latestPrice?.date)
    const financialSector = /銀行|保険|証券|金融/.test(`${profile?.sector17Name ?? ''} ${profile?.sector33Name ?? ''}`)
    for (const date of [latestPrice.date, ...PIT_DATES]) {
      await verifyDate(ticker, date, facts, forecasts, detailedFacts, financialSector)
    }
    const rerun = await buildValuationServingForTicker(ticker)
    assert.equal(rerun.status, 'skipped', `${ticker}: idempotent rerun must skip unchanged sources`)
  }
  console.log('Valuation serving PIT, peer compatibility, provenance, and idempotency tests passed')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
