import assert from 'node:assert/strict'
import { currentPositionEntityId, OZAKI_ATSUSHI_SUCCESSION as review } from '@/lib/large-holders/entity-adjudications'

const base = {
  entity_id: review.priorEntityId,
  document_id: 'S100YQZ0',
  holder_key: 'jplvh010000-lvh_E09744-000:FilerLargeVolumeHolder4Member',
  ticker: review.ticker,
  issuer_edinet_code: review.issuerEdinetCode,
  filer_edinet_code: review.filerEdinetCode,
  reported_shares: review.reportedShares,
  reported_holding_pct: review.reportedHoldingPct,
  report_serial_number: 17,
  xbrl_sha256: review.priorFilings.S100YQZ0.xbrlSha256,
}

assert.equal(currentPositionEntityId(base), review.canonicalEntityId)
assert.equal(currentPositionEntityId({ ...base, document_id: 'S100YI0J',
  holder_key: 'jplvh010000-lvh_E09744-000:FilerLargeVolumeHolder5Member',
  report_serial_number: 16, xbrl_sha256: review.priorFilings.S100YI0J.xbrlSha256 }), review.canonicalEntityId)
assert.equal(currentPositionEntityId({ ...base, document_id: 'S100Z2FB',
  holder_key: 'jplvh010000-lvh_E09744-000:FilerLargeVolumeHolder5Member',
  report_serial_number: 16, xbrl_sha256: review.priorFilings.S100Z2FB.xbrlSha256 }), review.canonicalEntityId)
assert.throws(() => currentPositionEntityId({ ...base, document_id: 'S100Z2FB',
  holder_key: 'jplvh010000-lvh_E09744-000:FilerLargeVolumeHolder5Member',
  report_serial_number: 16, xbrl_sha256: review.priorFilings.S100YI0J.xbrlSha256 }),
  /reviewed_holder_succession_evidence_changed/)
assert.equal(currentPositionEntityId({ ...base, document_id: 'S100Z2FD',
  xbrl_sha256: review.priorFilings.S100Z2FD.xbrlSha256 }), review.canonicalEntityId)
assert.throws(() => currentPositionEntityId({ ...base, document_id: 'S100Z2FD',
  xbrl_sha256: review.priorFilings.S100YQZ0.xbrlSha256 }),
  /reviewed_holder_succession_evidence_changed/)
for (const changed of [
  { document_id: 'S100UNKNOWN' }, { reported_shares: 3763001 },
  { reported_holding_pct: 7.29 }, { issuer_edinet_code: 'OTHER' },
  { filer_edinet_code: 'OTHER' }, { xbrl_sha256: 'OTHER' },
  { report_serial_number: 18 },
]) assert.throws(() => currentPositionEntityId({ ...base, ...changed }),
  /reviewed_holder_succession_evidence_changed/)
assert.equal(currentPositionEntityId({ ...base, entity_id: 'unrelated-id' }), 'unrelated-id')
console.log('large-holder entity adjudication: PASS')
