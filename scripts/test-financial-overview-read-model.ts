import assert from 'node:assert/strict'
import { ensureReady } from '@/lib/db/client'
import {
  getFinancialOverviewReadModel,
  type FinancialOverviewValue,
} from '@/lib/server/financial-overview-read-model'

function allValues(value: unknown): FinancialOverviewValue[] {
  if (!value || typeof value !== 'object') return []
  if ('availability' in value && 'inputIds' in value) return [value as FinancialOverviewValue]
  return Object.values(value).flatMap(allValues)
}

async function main() {
  await ensureReady()
  const asOf = '2026-08-21'
  const toyota = await getFinancialOverviewReadModel('7203', asOf)
  assert.equal(toyota.contractVersion, 'financial-overview-v1')
  assert.equal(toyota.asOf, asOf)
  assert.ok(toyota.coverage.facts > 0)
  assert.ok(toyota.coverage.sourceFacts > 0)
  assert.equal(toyota.coverage.ltmAvailable, true)
  assert.equal(toyota.forecasts.currentFy.targetFiscalYear, 2027)
  assert.equal(toyota.forecasts.nextFy.targetFiscalYear, null)
  assert.equal(toyota.quality.roic.value, null)
  assert.equal(toyota.quality.roic.availability, 'missing')
  assert.ok(toyota.quality.roic.reason)
  assert.ok(allValues(toyota).every((point) => (
    point.availability === 'available' || point.value === null
  )), 'missing and N/A values must never be zero-filled')
  assert.ok(allValues(toyota).every((point) => (
    !point.publishedAt || point.publishedAt <= new Date(`${asOf}T23:59:59.999+09:00`).toISOString()
  )), 'read model leaked a disclosure published after as_of')

  const bank = await getFinancialOverviewReadModel('8306', asOf)
  assert.equal(bank.isFinancialSector, true)
  assert.equal(bank.valuation.psr.value, null)
  assert.equal(bank.valuation.psr.availability, 'not_applicable')
  assert.equal(bank.quality.roic.availability, 'not_applicable')
  assert.equal(bank.quality.simpleFcf.availability, 'not_applicable')
  assert.equal(bank.performanceAndGrowth.operatingMargin.availability, 'not_applicable')

  console.log('Financial overview read model tests passed')
}

main().catch((error) => {
  console.error('Financial overview read model tests failed:', error instanceof Error ? error.message : String(error))
  process.exit(1)
})
