import { statSync } from 'node:fs'

import { client, ensureReady } from '@/lib/db/client'

const INPUT_METRICS = {
  cash: 'cash_and_cash_equivalents',
  debt: 'interest_bearing_debt',
  depreciationAmortization: 'depreciation_amortization',
  capex: 'capex',
  goodwill: 'goodwill',
} as const

const ADVANCED_METRICS = [
  'net_debt',
  'ebitda',
  'standard_fcf',
  'enterprise_value',
  'ev_ebitda',
  'fcf_yield',
  'roic',
] as const

function percentage(numerator: number, denominator: number): number | null {
  return denominator > 0 ? Math.round((numerator / denominator) * 10_000) / 100 : null
}

function countBy<T extends string>(values: T[]): Record<T, number> {
  const output = {} as Record<T, number>
  for (const value of values) output[value] = (output[value] ?? 0) + 1
  return output
}

async function main() {
  await ensureReady()
  const [universeResult, tickerCheckpointResult, factTickerResult, latestInputResult, standardResult, advancedResult, errorResult, dbSizeResult] = await Promise.all([
    client.execute(`SELECT COUNT(*) AS count FROM ticker_universe WHERE active = 1`),
    client.execute(`
      SELECT checkpoint_key AS ticker, status, details_json
      FROM financial_foundation_backfill_checkpoints
      WHERE checkpoint_type = 'detailed_financial_ticker'
    `),
    client.execute(`SELECT COUNT(DISTINCT ticker) AS count, COUNT(*) AS facts, COUNT(DISTINCT document_id) AS documents FROM detailed_financial_facts`),
    client.execute(`
      WITH latest_period AS (
        SELECT ticker, MAX(period_end) AS period_end
        FROM detailed_financial_facts
        WHERE consolidation_scope = 'consolidated'
        GROUP BY ticker
      )
      SELECT f.accounting_standard, f.metric, COUNT(DISTINCT f.ticker) AS count
      FROM detailed_financial_facts f
      JOIN latest_period p ON p.ticker = f.ticker AND p.period_end = f.period_end
      WHERE f.consolidation_scope = 'consolidated'
        AND f.metric IN (${Object.keys(INPUT_METRICS).map(() => '?').join(',')})
      GROUP BY f.accounting_standard, f.metric
    `, Object.values(INPUT_METRICS)),
    client.execute(`
      WITH latest_period AS (
        SELECT ticker, MAX(period_end) AS period_end
        FROM detailed_financial_facts
        WHERE consolidation_scope = 'consolidated'
        GROUP BY ticker
      )
      SELECT f.accounting_standard, COUNT(DISTINCT f.ticker) AS count
      FROM detailed_financial_facts f
      JOIN latest_period p ON p.ticker = f.ticker AND p.period_end = f.period_end
      WHERE f.consolidation_scope = 'consolidated'
      GROUP BY f.accounting_standard
    `),
    client.execute({
      sql: `
        SELECT metric, COUNT(DISTINCT ticker) AS count
        FROM calculated_financial_metrics
        WHERE metric IN (${ADVANCED_METRICS.map(() => '?').join(',')})
        GROUP BY metric
      `,
      args: [...ADVANCED_METRICS],
    }),
    client.execute(`
      SELECT status, details_json, error_message
      FROM financial_foundation_backfill_checkpoints
      WHERE checkpoint_type = 'detailed_financial' AND status = 'failed'
    `),
    client.execute(`
      SELECT name, SUM(pgsize) AS bytes
      FROM dbstat
      WHERE name IN (
        'detailed_financial_facts',
        'detailed_financial_facts_ticker_metric_period_idx',
        'detailed_financial_facts_disclosure_idx',
        'detailed_financial_facts_source_concept_idx',
        'calculated_financial_metrics'
      )
      GROUP BY name
    `),
  ])

  const activeUniverse = Number(universeResult.rows[0]?.count ?? 0)
  const tickerCheckpoints = tickerCheckpointResult.rows.map((row) => {
    let details: Record<string, unknown> = {}
    try { details = JSON.parse(String(row.details_json ?? '{}')) }
    catch { details = {} }
    return { ticker: String(row.ticker), status: String(row.status), details }
  })
  const statusCounts = countBy(tickerCheckpoints.map((row) => row.status))
  const exclusionCounts = countBy(tickerCheckpoints
    .filter((row) => row.status === 'excluded')
    .map((row) => String(row.details.scope ?? 'unknown')))
  const financialExcluded = tickerCheckpoints.filter((row) => row.status === 'financial_metrics_excluded').length
  const edinetTargets = tickerCheckpoints.filter((row) => row.status !== 'excluded').length
  const latestReportSuccess = tickerCheckpoints.filter((row) => (
    ['completed', 'financial_metrics_excluded', 'partial'].includes(row.status)
    && Number(row.details.metricCount ?? 0) >= 0
  )).length
  const savedTickers = Number(factTickerResult.rows[0]?.count ?? 0)

  const inputByStandard: Record<string, Record<string, number>> = {}
  for (const row of latestInputResult.rows) {
    const standard = String(row.accounting_standard ?? 'UNKNOWN')
    inputByStandard[standard] ??= {}
    inputByStandard[standard][String(row.metric)] = Number(row.count ?? 0)
  }
  const standardTickerCounts = Object.fromEntries(standardResult.rows.map((row) => [
    String(row.accounting_standard ?? 'UNKNOWN'),
    Number(row.count ?? 0),
  ]))
  const inputCoverage = Object.fromEntries(Object.entries(INPUT_METRICS).map(([label, metric]) => {
    const count = Object.values(inputByStandard).reduce((sum, metrics) => sum + Number(metrics[metric] ?? 0), 0)
    return [label, {
      count,
      pctOfActiveUniverse: percentage(count, activeUniverse),
      pctOfSavedTickers: percentage(count, savedTickers),
      byAccountingStandard: Object.fromEntries(Object.entries(inputByStandard).map(([standard, metrics]) => [
        standard,
        { count: Number(metrics[metric] ?? 0), pct: percentage(Number(metrics[metric] ?? 0), standardTickerCounts[standard] ?? 0) },
      ])),
    }]
  }))
  const advancedCounts = Object.fromEntries(ADVANCED_METRICS.map((metric) => {
    const row = advancedResult.rows.find((candidate) => String(candidate.metric) === metric)
    const count = Number(row?.count ?? 0)
    return [metric, {
      count,
      pctOfActiveUniverse: percentage(count, activeUniverse),
      pctOfNonFinancialSaved: percentage(count, Math.max(0, savedTickers - financialExcluded)),
    }]
  }))

  const gapConceptCounts: Record<string, Record<string, number>> = {}
  for (const checkpointRow of tickerCheckpoints) {
    const gaps = checkpointRow.details.conceptGaps
    if (!gaps || typeof gaps !== 'object') continue
    for (const [category, concepts] of Object.entries(gaps as Record<string, unknown>)) {
      if (!Array.isArray(concepts)) continue
      gapConceptCounts[category] ??= {}
      for (const concept of concepts) {
        const name = String(concept)
        gapConceptCounts[category][name] = (gapConceptCounts[category][name] ?? 0) + 1
      }
    }
  }
  const topUnmappedConcepts = Object.fromEntries(Object.entries(gapConceptCounts).map(([category, concepts]) => [
    category,
    Object.entries(concepts).sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0])).slice(0, 20),
  ]))

  let apiErrors = 0
  let xbrlParseErrors = 0
  for (const row of errorResult.rows) {
    let category = ''
    try { category = String(JSON.parse(String(row.details_json ?? '{}')).errorCategory ?? '') }
    catch { category = '' }
    if (category === 'api_error' || /HTTP|request failed|timeout|fetch/i.test(String(row.error_message ?? ''))) apiErrors += 1
    else xbrlParseErrors += 1
  }

  const dbPath = process.env.STOCKBOARD_DB_PATH || process.env.LOCAL_DB_PATH
  const databaseFileBytes = dbPath ? statSync(dbPath).size : null
  console.log(JSON.stringify({
    generatedAt: new Date().toISOString(),
    activeUniverse,
    tickerCheckpointCoverage: { count: tickerCheckpoints.length, pct: percentage(tickerCheckpoints.length, activeUniverse) },
    statusCounts,
    exclusions: { ...exclusionCounts, financialAdvancedMetrics: financialExcluded },
    edinetTargets,
    latestReportSuccess,
    factStorage: {
      tickers: savedTickers,
      pctOfActiveUniverse: percentage(savedTickers, activeUniverse),
      facts: Number(factTickerResult.rows[0]?.facts ?? 0),
      documents: Number(factTickerResult.rows[0]?.documents ?? 0),
    },
    inputCoverage,
    advancedMetricCoverage: advancedCounts,
    accountingStandardTickerDenominators: standardTickerCounts,
    errors: { apiErrors, xbrlParseErrors },
    topUnmappedConcepts,
    storage: {
      databaseFileBytes,
      logicalTableBytes: Object.fromEntries(dbSizeResult.rows.map((row) => [String(row.name), Number(row.bytes ?? 0)])),
    },
  }, null, 2))
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
