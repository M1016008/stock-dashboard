import assert from 'node:assert/strict'
import { getSimilarityComparisonReadModel } from '@/lib/server/similarity-comparison-read-model'

const TICKERS = ['7203', '7003', '8306', '4755', '4502', '7974'] as const
const FINANCIAL_PATTERN = /銀行|保険|証券|金融/

async function main() {
for (const ticker of TICKERS) {
  const startedAt = Date.now()
  const model = await getSimilarityComparisonReadModel(ticker)
  assert.equal(model.contractVersion, 'similarity-comparison-v1')
  assert.equal(model.ticker, ticker)
  assert.equal(model.candidateGroups.length, 4)
  assert.deepEqual(model.candidateGroups.map((group) => group.kind), ['sector33', 'custom', 'financial', 'structure'])
  assert.ok(model.selectedTickers.length >= 3 && model.selectedTickers.length <= 8)
  assert.equal(model.selectedTickers[0], ticker)
  assert.deepEqual(model.companies.map((company) => company.ticker), model.selectedTickers)
  assert.equal(model.companies.filter((company) => company.isBase).length, 1)
  assert.ok(model.coverage.activeUniverse >= 4_500)
  assert.ok(model.asOf >= (model.valuationDate ?? '0000-00-00'))
  assert.ok(model.asOf >= (model.structureDate ?? '0000-00-00'))
  const stats = Object.values(model.sectorDistribution.metrics)
  for (const item of stats) {
    if (!item || item.median == null || item.percentile25 == null || item.percentile75 == null) continue
    assert.ok(item.percentile25 <= item.median && item.median <= item.percentile75)
  }
  if (ticker === '8306') {
    const financial = model.candidateGroups.find((group) => group.kind === 'financial')!
    assert.ok(financial.candidates.every((candidate) => FINANCIAL_PATTERN.test(`${candidate.sector33 ?? ''} ${candidate.custom60 ?? ''}`)))
    const base = model.companies.find((company) => company.isBase)!
    assert.equal(base.metrics.fcfYield.availability, 'not_applicable')
    assert.equal(base.metrics.evEbitda.availability, 'not_applicable')
  }
  console.log(JSON.stringify({
    ticker,
    name: model.classification.name,
    asOf: model.asOf,
    candidates: Object.fromEntries(model.candidateGroups.map((group) => [group.kind, group.candidates.slice(0, 3).map((candidate) => `${candidate.ticker} ${candidate.name ?? ''}`.trim())])),
    selected: model.selectedTickers,
    elapsedMs: Date.now() - startedAt,
  }))
}

for (const asOf of ['2026-05-29', '2026-07-31']) {
  const model = await getSimilarityComparisonReadModel('7203', asOf, ['7203', '6902', '7269'])
  assert.equal(model.asOf, asOf)
  assert.ok(!model.valuationDate || model.valuationDate <= asOf)
  assert.ok(!model.structureDate || model.structureDate <= asOf)
  assert.deepEqual(model.selectedTickers, ['7203', '6902', '7269'])
  const base = model.companies[0]
  assert.equal(base.ticker, '7203')
  for (const metric of Object.values(base.metrics)) {
    if (metric.source === 'valuation-serving' && metric.asOf) assert.ok(metric.asOf <= asOf)
  }
  console.log(JSON.stringify({
    pitAsOf: asOf,
    valuationDate: model.valuationDate,
    structureDate: model.structureDate,
    forwardPer: base.metrics.forwardPer.value,
    pbr: base.metrics.pbr.value,
    stageCode: base.stageCode,
  }))
}

console.log('similarity comparison tests passed')
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
