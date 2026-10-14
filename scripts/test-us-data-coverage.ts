import assert from 'node:assert/strict'
import { summarizeUsCoverage } from '@/lib/us-status'

assert.deepEqual(summarizeUsCoverage(null, 12_004, 11_760), {
  date: null,
  eligible: 12_004,
  covered: 11_760,
  percent: null,
  status: 'UNAVAILABLE',
})

assert.deepEqual(summarizeUsCoverage('2026-10-13', 0, 0), {
  date: '2026-10-13',
  eligible: 0,
  covered: 0,
  percent: null,
  status: 'UNAVAILABLE',
})

assert.deepEqual(summarizeUsCoverage('2026-10-13', 11_741, 11_741), {
  date: '2026-10-13',
  eligible: 11_741,
  covered: 11_741,
  percent: 100,
  status: 'COMPLETE',
})

const partial = summarizeUsCoverage('2026-10-13', 12_004, 11_760)
assert.equal(partial.status, 'PARTIAL')
assert.equal(partial.eligible, 12_004)
assert.equal(partial.covered, 11_760)
assert.equal(partial.percent?.toFixed(2), '97.97')

const clamped = summarizeUsCoverage('2026-10-13', 10, 12)
assert.equal(clamped.covered, 10)
assert.equal(clamped.percent, 100)
assert.equal(clamped.status, 'COMPLETE')

console.log('US data coverage contract tests passed')
