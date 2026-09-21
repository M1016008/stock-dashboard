import assert from 'node:assert/strict'
import { archiveOfficialRaw, decisionHash, derivedFact, sha256,
  verifyArchivedLineage } from '@/lib/large-holders/evidence-provenance'
import { classifyFromFiling } from '@/lib/large-holders/classification'

async function main() {
  const root = `/tmp/stockboard-large-holder-evidence-test-${process.pid}`
  const bytes = Buffer.from('<html>official source</html>')
  const source = await archiveOfficialRaw(root, 'FSA', 'https://www.fsa.go.jp/test', bytes, 'html')
  assert.equal(source.sha256, sha256(bytes))
  assert.deepEqual(await archiveOfficialRaw(root, 'FSA', source.reference, bytes, 'html'), source)
  const fact = derivedFact('REGULATORY_SCOPE', 'page#section', { eligible: true }, source)
  assert.notEqual(fact.factsSha256, source.sha256)
  const decision = { ready: true }
  const lineage = { positionKey: 'S100TEST:HOLDER', decision,
    decisionSha256: decisionHash('S100TEST:HOLDER', decision, [fact]), facts: [fact] }
  assert.match(lineage.decisionSha256, /^[a-f0-9]{64}$/)
  assert.equal(await verifyArchivedLineage([source], [lineage]), true)
  assert.equal(await verifyArchivedLineage([source], [{ ...lineage, decision: { ready: false } }]), false)
  assert.equal(await verifyArchivedLineage([source], [lineage, lineage]), false)
  assert.throws(() => decisionHash('S100TEST:HOLDER', { ready: true },
    [{ ...fact, rawSourceSha256: '0'.repeat(64) }]), /evidence_lineage_broken/)

  assert.equal(classifyFromFiling('個人').category, 'INDIVIDUAL')
  assert.equal(classifyFromFiling('法人（株式会社）', '投資運用業', '東京都').investorClass, 'INSTITUTIONAL')
  assert.equal(classifyFromFiling('法人（株式会社）', '商業施設の建築・設計・施工').category,
    'OPERATING_COMPANY')
  assert.equal(classifyFromFiling('株式会社A', '投資先の製造業を支援').category, 'UNCLASSIFIED')
  assert.equal(classifyFromFiling('○○株式会社').category, 'UNCLASSIFIED')
  assert.equal(classifyFromFiling('法人（株式会社）', '有価証券の保有管理').category, 'UNCLASSIFIED')
  console.log('large-holder evidence provenance: PASS')
}

main().catch((error) => { console.error(error); process.exitCode = 1 })
