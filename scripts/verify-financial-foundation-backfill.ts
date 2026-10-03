import { performance } from 'node:perf_hooks'
import { ensureReady, execAll, execGet } from '@/lib/db/client'
import { countTickerFoundationRows } from '@/lib/server/financial-foundation-backfill'
import {
  getFinancialOverviewReadModel,
  type FinancialOverviewReadModel,
  type FinancialOverviewValue,
} from '@/lib/server/financial-overview-read-model'

const CASES = [
  { ticker: '7203', label: 'トヨタ自動車', property: '基準・IFRS' },
  { ticker: '7003', label: '三井E&S', property: '既存重点銘柄' },
  { ticker: '8306', label: '三菱UFJ FG', property: '銀行' },
  { ticker: '4755', label: '楽天グループ', property: '赤字・IFRS' },
  { ticker: '4502', label: '武田薬品工業', property: 'IFRS' },
  { ticker: '7974', label: '任天堂', property: 'J-GAAP' },
] as const

function compactPoint(point: FinancialOverviewValue) {
  return {
    value: point.value,
    unit: point.unit,
    availability: point.availability,
    reason: point.reason,
    periodEnd: point.periodEnd,
    accountingStandard: point.accountingStandard,
    definitionVersion: point.definitionVersion,
  }
}

function missingReasons(model: FinancialOverviewReadModel): Array<{ path: string; code: string; message: string }> {
  const output: Array<{ path: string; code: string; message: string }> = []
  const visit = (value: unknown, path: string) => {
    if (!value || typeof value !== 'object') return
    if ('availability' in value && 'reason' in value) {
      const point = value as FinancialOverviewValue
      if (point.reason) output.push({ path, ...point.reason })
      return
    }
    for (const [key, child] of Object.entries(value)) visit(child, path ? `${path}.${key}` : key)
  }
  visit(model, '')
  return output
}

async function verifyTicker(ticker: string) {
  const started = performance.now()
  const model = await getFinancialOverviewReadModel(ticker)
  const readMs = performance.now() - started
  const counts = await countTickerFoundationRows(ticker)
  const accounting = await execAll<{ accounting_standard: string; count: number }>(`
    SELECT accounting_standard, COUNT(*) AS count
    FROM normalized_financial_facts
    WHERE ticker = ? AND is_derived = 0
    GROUP BY accounting_standard
    ORDER BY count DESC
  `, [ticker])
  const latestLtmNet = await execGet<{ value: number; period_end: string }>(`
    SELECT value, period_end
    FROM normalized_financial_facts
    WHERE ticker = ? AND metric = 'net_income_attributable'
      AND accumulation_kind = 'LTM'
    ORDER BY period_end DESC, published_at DESC LIMIT 1
  `, [ticker])
  return {
    counts,
    ltmGenerated: counts.ltmFacts > 0,
    latestLtmNetIncome: latestLtmNet ?? null,
    accountingStandards: accounting,
    forwardPer: compactPoint(model.valuation.forwardPer),
    roe: compactPoint(model.quality.roe),
    revenueGrowth: compactPoint(model.performanceAndGrowth.ltmRevenueGrowth),
    missingReasons: missingReasons(model),
    readModelMs: Number(readMs.toFixed(2)),
  }
}

async function main() {
  await ensureReady()
  const cases = []
  for (const item of CASES) {
    cases.push({ ...item, ...(await verifyTicker(item.ticker)) })
  }
  const checkpoints = await execAll<Record<string, unknown>>(`
    SELECT checkpoint_type, status, COUNT(*) AS count
    FROM financial_foundation_backfill_checkpoints
    GROUP BY checkpoint_type, status
    ORDER BY checkpoint_type, status
  `)
  const totals = await execGet<Record<string, unknown>>(`
    SELECT
      (SELECT COUNT(*) FROM ticker_universe WHERE active = 1) AS active_tickers,
      (SELECT COUNT(DISTINCT ticker) FROM normalized_financial_facts) AS fact_tickers,
      (SELECT COUNT(*) FROM normalized_financial_facts) AS facts,
      (SELECT COUNT(DISTINCT ticker) FROM financial_forecast_snapshots) AS forecast_tickers,
      (SELECT COUNT(*) FROM financial_forecast_snapshots) AS forecasts,
      (SELECT COUNT(DISTINCT ticker) FROM calculated_financial_metrics) AS metric_tickers,
      (SELECT COUNT(*) FROM calculated_financial_metrics) AS metrics
  `)
  console.log(JSON.stringify({ totals, checkpoints, cases }, null, 2))
}

main().catch((error) => {
  console.error('Financial foundation backfill verification failed:', error instanceof Error ? error.message : String(error))
  process.exit(1)
})
