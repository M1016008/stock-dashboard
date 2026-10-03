import assert from 'node:assert/strict'
import { ensureReady, execAll } from '@/lib/db/client'
import { fetchJQuantsFinsSummary } from '@/lib/jquants'
import { upsertFinancialSummaryRows } from '@/lib/server/company-overview-store'
import { getForecastSnapshotsAsOf, loadNormalizedFinancialFacts } from '@/lib/server/financial-foundation-store'

async function main() {
  await ensureReady()
  const rows = await fetchJQuantsFinsSummary('7203')
  assert.ok(rows.length > 0, '7203 J-Quants financial rows are empty')
  await upsertFinancialSummaryRows(rows)

  const facts = await loadNormalizedFinancialFacts('7203')
  const latestPrice = (await execAll<{ date: string; close: number }>(`
    SELECT date, close FROM ohlcv_daily WHERE ticker = '7203' ORDER BY date DESC LIMIT 1
  `))[0]
  const asOf = latestPrice?.date ?? rows.map((row) => row.DiscDate).sort().at(-1)!
  const forecasts = await getForecastSnapshotsAsOf('7203', asOf)
  const forecastHistory = await execAll<Record<string, unknown>>(`
    SELECT published_at, target_fiscal_year, forecast_scope, forecast_period, metric, value,
           consolidation_scope, accounting_standard, disclosure_id
    FROM financial_forecast_snapshots
    WHERE ticker = '7203'
      AND metric IN ('revenue', 'operating_profit', 'net_income_attributable', 'eps_basic')
    ORDER BY published_at DESC, metric
    LIMIT 16
  `)
  const periodSamples = ['FY', 'STANDALONE', 'LTM'].map((kind) => {
    const matching = facts.filter((fact) => (
      fact.metric === 'revenue'
      && (kind === 'FY' ? fact.accumulationKind === 'FY' : fact.accumulationKind === kind)
      && fact.consolidationScope === 'consolidated'
    )).sort((a, b) => a.periodEnd.localeCompare(b.periodEnd) || a.publishedAt.localeCompare(b.publishedAt))
    const fact = matching.at(-1)
    return fact ? {
      kind,
      period: fact.periodKind,
      periodStart: fact.periodStart,
      periodEnd: fact.periodEnd,
      value: fact.value,
      derivationMethod: fact.derivationMethod,
      inputFactCount: fact.inputFactIds.length,
    } : null
  }).filter(Boolean)
  const metricRows = await execAll<Record<string, unknown>>(`
    SELECT metric, value, unit, as_of, period_end, definition_version,
           derivation_method, input_fact_ids_json
    FROM calculated_financial_metrics
    WHERE ticker = '7203' AND as_of = ?
      AND metric IN ('forward_per', 'roe', 'revenue_growth', 'revenue_cagr_3y')
    ORDER BY metric
  `, [asOf])
  const metricSamples = metricRows.map((metric) => ({
    metric: metric.metric,
    value: metric.value,
    unit: metric.unit,
    asOf: metric.as_of,
    periodEnd: metric.period_end,
    definitionVersion: metric.definition_version,
    derivationMethod: metric.derivation_method,
    inputFactCount: (JSON.parse(String(metric.input_fact_ids_json)) as string[]).length,
  }))

  assert.ok(forecastHistory.some((row) => row.forecast_scope === 'current_fy'))
  assert.ok(forecastHistory.some((row) => row.forecast_scope === 'next_fy'))
  assert.ok(periodSamples.some((sample) => sample?.kind === 'FY'))
  assert.ok(periodSamples.some((sample) => sample?.kind === 'STANDALONE'))
  assert.ok(periodSamples.some((sample) => sample?.kind === 'LTM'))
  for (const metric of ['forward_per', 'roe', 'revenue_growth', 'revenue_cagr_3y']) {
    assert.ok(metricSamples.some((sample) => sample.metric === metric), `${metric} was not calculated`)
  }

  console.log(JSON.stringify({
    ticker: '7203',
    sourceRows: rows.length,
    asOf,
    persisted: {
      facts: facts.length,
      pitForecastsAsOf: forecasts.length,
    },
    pitForecastHistorySample: forecastHistory,
    periodSamples,
    metricSamples,
  }, null, 2))
}

main().catch((error) => {
  console.error('Toyota financial foundation verification failed:', error instanceof Error ? error.message : String(error))
  process.exit(1)
})
