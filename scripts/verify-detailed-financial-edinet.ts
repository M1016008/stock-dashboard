import assert from 'node:assert/strict'

import { XbrlFactReader } from '@/lib/edinet-xbrl-facts'
import { parseEdinetDetailedFinancialFacts } from '@/lib/detailed-financial-foundation'
import {
  downloadEdinetPublicXbrl,
  listEdinetDocuments,
} from '@/lib/server/edinet-api'
import { loadDetailedFinancialFacts } from '@/lib/server/detailed-financial-foundation-store'

const targets = [
  { ticker: '7203', secCode: '72030', date: '2026-06-10' },
  { ticker: '7003', secCode: '70030', date: '2026-06-25' },
  { ticker: '8306', secCode: '83060', date: '2026-06-24' },
  { ticker: '4755', secCode: '47550', date: '2026-03-26' },
  { ticker: '4502', secCode: '45020', date: '2026-06-17' },
  { ticker: '7974', secCode: '79740', date: '2026-06-25' },
] as const

async function main() {
const report = []
for (const target of targets) {
  const documents = await listEdinetDocuments(target.date)
  const document = documents.find((row) => (
    row.secCode === target.secCode
    && row.docTypeCode === '120'
    && row.withdrawalStatus !== '1'
    && row.xbrlFlag === '1'
  ))
  assert.ok(document, `${target.ticker}: annual report not found`)
  const reader = new XbrlFactReader(await downloadEdinetPublicXbrl(document.docID))
  const parsed = parseEdinetDetailedFinancialFacts(reader, {
    ticker: target.ticker,
    documentId: document.docID,
    publishedAt: document.submitDateTime!,
    periodEnd: document.periodEnd!,
    documentType: document.docTypeCode!,
  })
  const stored = (await loadDetailedFinancialFacts(target.ticker))
    .filter((fact) => fact.documentId === document.docID)
  assert.equal(stored.length, parsed.length, `${target.ticker}: persisted fact count differs from source XBRL`)
  for (const fact of parsed) {
    const persisted = stored.find((candidate) => candidate.factId === fact.factId)
    assert.ok(persisted, `${target.ticker}: ${fact.metric} fact missing from DB`)
    assert.equal(persisted.value, fact.value, `${target.ticker}: ${fact.metric} value changed`)
    assert.equal(persisted.unit, fact.unit, `${target.ticker}: ${fact.metric} unit changed`)
    assert.equal(persisted.consolidationScope, fact.consolidationScope)
  }
  const current = parsed.filter((fact) => (
    fact.periodEnd === document.periodEnd
    && fact.consolidationScope === 'consolidated'
  ))
  assert.ok(current.every((fact) => fact.currency === 'JPY'), `${target.ticker}: unexpected source currency`)
  assert.ok(current.every((fact) => Math.abs(fact.value) < 1e17), `${target.ticker}: probable unit explosion`)
  report.push({
    ticker: target.ticker,
    documentId: document.docID,
    periodEnd: document.periodEnd,
    sourceFacts: reader.facts.length,
    normalizedFacts: parsed.length,
    currentConsolidatedFacts: current.length,
    currency: [...new Set(current.map((fact) => fact.currency))],
  })
}

console.log(JSON.stringify({ verifiedAgainstEdinetXbrl: report }, null, 2))
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
