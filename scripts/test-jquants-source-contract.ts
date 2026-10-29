import assert from 'node:assert/strict'
import {
  buildJQuantsDailyByDateEvidence,
  assertJQuantsDailyByDateSourceContract,
  assertJQuantsRejectedDailyRowEvidence,
  jQuantsDailyByDateSourceContract,
  type JBarRow,
} from '@/lib/jquants'

const date = '2026-07-17'
const base = {
  Date: date,
  UL: 0,
  LL: 0,
  Va: null,
  AdjFactor: 1,
} as const
const accepted: JBarRow = {
  ...base,
  Code: '70030',
  O: 4400,
  H: 4500,
  L: 4300,
  C: 4434,
  Vo: 100,
  AdjO: 4400,
  AdjH: 4500,
  AdjL: 4300,
  AdjC: 4434,
  AdjVo: 100,
}
const noTrade: JBarRow = {
  ...base,
  Code: '131A0',
  O: null,
  H: null,
  L: null,
  C: null,
  Vo: null,
  AdjO: null,
  AdjH: null,
  AdjL: null,
  AdjC: null,
  AdjVo: null,
}
const evidence = buildJQuantsDailyByDateEvidence({
  date,
  requestedAt: '2026-10-29T00:00:00.000Z',
  completedAt: '2026-10-29T00:00:01.000Z',
  pages: 1,
  providerRows: [accepted, noTrade],
})
assert.equal(evidence.providerRows, 2)
assert.equal(evidence.acceptedRows, 1)
assert.equal(evidence.rejectedRows, 1)
assert.equal(evidence.noTradeRows, 1)
assert.equal(evidence.unexpectedRejectedRows, 0)
assert.doesNotThrow(() => jQuantsDailyByDateSourceContract(evidence))
assert.doesNotThrow(() => assertJQuantsDailyByDateSourceContract(
  jQuantsDailyByDateSourceContract(evidence),
  { requestedDate: date, acceptedRows: 1, contentSha256: evidence.contentSha256 },
))
assert.doesNotThrow(() => assertJQuantsRejectedDailyRowEvidence(
  evidence.rejectedRowEvidence,
  jQuantsDailyByDateSourceContract(evidence),
))
assert.throws(() => assertJQuantsRejectedDailyRowEvidence(
  [{ ...evidence.rejectedRowEvidence[0], code: 'changed' }],
  jQuantsDailyByDateSourceContract(evidence),
), /hash_mismatch/)
assert.throws(() => assertJQuantsDailyByDateSourceContract(
  { ...jQuantsDailyByDateSourceContract(evidence), rejectedRowsSha256: 'bad' },
), /hash_invalid/)

const malformed = buildJQuantsDailyByDateEvidence({
  date,
  requestedAt: evidence.requestedAt,
  completedAt: evidence.completedAt,
  pages: 1,
  providerRows: [{ ...noTrade, Code: '99990', Vo: 10 }],
})
assert.equal(malformed.noTradeRows, 0)
assert.equal(malformed.unexpectedRejectedRows, 1)
assert.throws(() => jQuantsDailyByDateSourceContract(malformed), /unexpected_rejected_rows/)

console.log('J-Quants official source contract tests: PASS')
