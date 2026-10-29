import assert from 'node:assert/strict'
import {
  buildJQuantsDailyByDateEvidence,
  assertJQuantsDailyByDateSourceContract,
  assertJQuantsRejectedDailyRowEvidence,
  fetchJQuantsDailyByDateWithEvidence,
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

const productionScaleAccepted = Array.from({ length: 4_218 }, (_, index): JBarRow => {
  const value = 1_000 + index
  return {
    ...accepted,
    Code: `${value}0`,
    O: value,
    H: value + 2,
    L: value - 2,
    C: value + 1,
    Vo: value * 10,
    AdjO: value,
    AdjH: value + 2,
    AdjL: value - 2,
    AdjC: value + 1,
    AdjVo: value * 10,
  }
})
const productionScaleNoTrade = Array.from({ length: 224 }, (_, index): JBarRow => ({
  ...noTrade,
  Code: `${6_000 + index}0`,
}))
const productionScaleEvidence = buildJQuantsDailyByDateEvidence({
  date,
  requestedAt: '2026-10-29T01:00:00.000Z',
  completedAt: '2026-10-29T01:00:01.000Z',
  pages: 5,
  providerRows: [...productionScaleAccepted, ...productionScaleNoTrade],
})
const productionScaleContract = jQuantsDailyByDateSourceContract(productionScaleEvidence)
assert.equal(productionScaleEvidence.providerRows, 4_442)
assert.equal(productionScaleEvidence.acceptedRows, 4_218)
assert.equal(productionScaleEvidence.rejectedRows, 224)
assert.equal(productionScaleEvidence.noTradeRows, 224)
assert.equal(productionScaleEvidence.unexpectedRejectedRows, 0)
assert.doesNotThrow(() => assertJQuantsRejectedDailyRowEvidence(
  productionScaleEvidence.rejectedRowEvidence,
  productionScaleContract,
))
assert.throws(() => assertJQuantsRejectedDailyRowEvidence(
  productionScaleEvidence.rejectedRowEvidence.map((row, index) => (
    index === 223 ? { ...row, code: 'changed-provider-envelope' } : row
  )),
  productionScaleContract,
), /hash_mismatch/)

async function testFetchTimeoutAndSecretRedaction(): Promise<void> {
  const originalFetch = globalThis.fetch
  const originalApiKey = process.env.JQUANTS_API_KEY
  const secretApiKey = 'fixture-secret-api-key-must-not-appear'
  const keepAlive = setInterval(() => undefined, 1_000)
  process.env.JQUANTS_API_KEY = secretApiKey

  try {
    await assert.rejects(
      fetchJQuantsDailyByDateWithEvidence(date, { timeoutMs: 15 * 60_000 + 1 }),
      /jquants_daily_timeout_invalid/,
    )
    globalThis.fetch = ((_url: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal
      if (!signal) return reject(new Error(`missing timeout ${secretApiKey}`))
      signal.addEventListener('abort', () => reject(new DOMException('fixture timeout', 'TimeoutError')), { once: true })
    })) as typeof fetch
    await assert.rejects(async () => {
      try {
        await fetchJQuantsDailyByDateWithEvidence(date, { timeoutMs: 5 })
      } catch (error) {
        assert.doesNotMatch(error instanceof Error ? error.message : String(error), new RegExp(secretApiKey))
        throw error
      }
    }, /timed out/)
    globalThis.fetch = (async () => {
      throw new Error(`fixture network failure ${secretApiKey}`)
    }) as typeof fetch
    await assert.rejects(async () => {
      try {
        await fetchJQuantsDailyByDateWithEvidence(date, { timeoutMs: 100 })
      } catch (error) {
        assert.doesNotMatch(error instanceof Error ? error.message : String(error), new RegExp(secretApiKey))
        throw error
      }
    }, /network failure/)
  } finally {
    clearInterval(keepAlive)
    globalThis.fetch = originalFetch
    if (originalApiKey === undefined) delete process.env.JQUANTS_API_KEY
    else process.env.JQUANTS_API_KEY = originalApiKey
  }
}

testFetchTimeoutAndSecretRedaction()
  .then(() => console.log('J-Quants official source contract tests: PASS'))
  .catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
