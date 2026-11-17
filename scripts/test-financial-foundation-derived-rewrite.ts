// Runs in the isolated test runtime (never the production DB):
//   tsx scripts/run-isolated-runtime.ts test -- tsx scripts/test-financial-foundation-derived-rewrite.ts
import assert from 'node:assert/strict'
import { execAll, execRun } from '@/lib/db/client'
import type { JFinsSummaryRow } from '@/lib/jquants'
import { upsertFinancialFoundationRows } from '@/lib/server/financial-foundation-store'

function row(overrides: Partial<JFinsSummaryRow>): JFinsSummaryRow {
  return {
    DiscDate: '2026-01-01', DiscTime: '15:00:00', Code: '99990', DiscNo: 'base',
    DocType: 'FYFinancialStatements_Consolidated_IFRS', CurPerType: 'FY',
    CurPerSt: '2025-04-01', CurPerEn: '2026-03-31', CurFYSt: '2025-04-01', CurFYEn: '2026-03-31',
    Sales: '', OP: '', NP: '', EPS: '', DEPS: '', TA: '', Eq: '', EqAR: '', BPS: '',
    ShOutFY: '', TrShFY: '', AvgSh: '',
    ...overrides,
  }
}

function fiscalRows(fiscalEndYear: number, revenue: number, netIncome: number): JFinsSummaryRow[] {
  const startYear = fiscalEndYear - 1
  const base = { CurPerSt: `${startYear}-04-01`, CurFYSt: `${startYear}-04-01`, CurFYEn: `${fiscalEndYear}-03-31` }
  return [
    row({ ...base, DiscNo: `${fiscalEndYear}-q1`, DiscDate: `${startYear}-08-01`, DocType: '1QFinancialStatements_Consolidated_IFRS', CurPerType: '1Q', CurPerEn: `${startYear}-06-30`, Sales: String(revenue * 0.2), NP: String(netIncome * 0.2), OP: String(netIncome * 0.25), CFO: '120', AvgSh: '10' }),
    row({ ...base, DiscNo: `${fiscalEndYear}-q2`, DiscDate: `${startYear}-11-01`, DocType: '2QFinancialStatements_Consolidated_IFRS', CurPerType: '2Q', CurPerEn: `${startYear}-09-30`, Sales: String(revenue * 0.45), NP: String(netIncome * 0.45), OP: String(netIncome * 0.55), CFO: '260', AvgSh: '10' }),
    row({ ...base, DiscNo: `${fiscalEndYear}-q3`, DiscDate: `${fiscalEndYear}-02-01`, DocType: '3QFinancialStatements_Consolidated_IFRS', CurPerType: '3Q', CurPerEn: `${startYear}-12-31`, Sales: String(revenue * 0.72), NP: String(netIncome * 0.7), OP: String(netIncome * 0.8), CFO: '430', AvgSh: '10' }),
    row({ ...base, DiscNo: `${fiscalEndYear}-fy`, DiscDate: `${fiscalEndYear}-05-01`, CurPerType: 'FY', CurPerEn: `${fiscalEndYear}-03-31`, Sales: String(revenue), NP: String(netIncome), OP: String(netIncome * 1.1), CFO: '600', ShOutFY: '10', TrShFY: '0', AvgSh: '10' }),
  ]
}

type Derived = { fact_id: string; value: number; imported_at: number; published_at: string }
const derived = () => execAll<Derived>(`SELECT fact_id, value, imported_at, published_at FROM normalized_financial_facts
  WHERE ticker = '9999' AND is_derived = 1 ORDER BY fact_id`)

async function main() {
  const history = [...fiscalRows(2024, 4300, 430), ...fiscalRows(2025, 4700, 470)]
  await upsertFinancialFoundationRows(history, 1_000)
  const first = await derived()
  assert.ok(first.length > 0, 'the fixture yields derived facts')
  assert.ok(first.every((fact) => fact.imported_at === 1_000))

  // The daily re-import of the same disclosures (the 14-day window) leaves every derived row as it was.
  await upsertFinancialFoundationRows(history.slice(-2), 2_000)
  assert.deepEqual(await derived(), first)

  // A new quarter adds derived rows stamped with the new time; the old ones keep theirs.
  const nextQuarter = fiscalRows(2026, 5200, 520).slice(0, 1)
  await upsertFinancialFoundationRows(nextQuarter, 3_000)
  const afterNew = await derived()
  const before = new Map(first.map((fact) => [fact.fact_id, fact]))
  assert.ok(afterNew.length > first.length)
  for (const fact of afterNew) {
    if (before.has(fact.fact_id)) assert.deepEqual(fact, before.get(fact.fact_id))
    else assert.equal(fact.imported_at, 3_000)
  }

  // A corrected disclosure changes the derived values that use it: only those are rewritten.
  const corrected = history.map((source) => (source.DiscNo === '2025-q2' ? { ...source, Sales: String(4700 * 0.46) } : source))
  await upsertFinancialFoundationRows(corrected.filter((source) => source.DiscNo === '2025-q2'), 4_000)
  const afterCorrection = await derived()
  const restamped = afterCorrection.filter((fact) => fact.imported_at === 4_000)
  assert.ok(restamped.length > 0 && restamped.length < afterCorrection.length)
  const previous = new Map(afterNew.map((fact) => [fact.fact_id, fact]))
  for (const fact of restamped) assert.notEqual(fact.value, previous.get(fact.fact_id)?.value)

  // A derived row that no longer comes out (here: planted by hand) is removed.
  await execRun(`INSERT INTO normalized_financial_facts SELECT 'planted-derived', event_id, ticker, published_at, period_start,
    period_end, fiscal_year_start, fiscal_year_end, target_fiscal_year, period_kind, accumulation_kind, value_kind, metric,
    value, unit, currency, consolidation_scope, accounting_standard, correction_status, source, source_field, disclosure_id,
    is_derived, derivation_method, input_fact_ids_json, definition_version, imported_at
    FROM normalized_financial_facts WHERE ticker = '9999' AND is_derived = 1 LIMIT 1`)
  await upsertFinancialFoundationRows(history.slice(-1), 5_000)
  const afterStale = await derived()
  assert.equal(afterStale.some((fact) => fact.fact_id === 'planted-derived'), false)
  assert.deepEqual(afterStale, afterCorrection)
  console.log(`financial-foundation derived rewrite tests passed (${afterStale.length} derived rows)`)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
