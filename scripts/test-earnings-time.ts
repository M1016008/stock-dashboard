import assert from 'node:assert/strict'
import {
  classifyEarningsTime,
  normalizeEarningsTime,
  predictEarningsTime,
} from '../lib/earnings-time'

assert.equal(normalizeEarningsTime('14:30:00'), '14:30')
assert.equal(normalizeEarningsTime('9:05'), '09:05')
assert.equal(normalizeEarningsTime('25:00'), null)

assert.equal(classifyEarningsTime('08:59', '2026-07-31'), 'pre_open')
assert.equal(classifyEarningsTime('10:00', '2026-07-31'), 'morning')
assert.equal(classifyEarningsTime('12:00', '2026-07-31'), 'lunch')
assert.equal(classifyEarningsTime('14:30', '2026-07-31'), 'afternoon')
assert.equal(classifyEarningsTime('15:00', '2024-10-31'), 'after_close')
assert.equal(classifyEarningsTime('15:00', '2026-07-31'), 'afternoon')
assert.equal(classifyEarningsTime('15:30', '2026-07-31'), 'after_close')
assert.equal(classifyEarningsTime(null), 'unknown')

assert.deepEqual(
  predictEarningsTime(['15:00', '15:01', '15:00', '15:02', '15:00', '15:00', '14:59', '14:58']),
  { time: '15:00', confidence: 'high', sampleCount: 8, modeCount: 8 },
)
assert.equal(predictEarningsTime(['15:00', '15:00']), null)

const mixed = predictEarningsTime(['14:30', '14:31', '14:29', '15:00', '15:01'])
assert.equal(mixed?.time, '14:30')
assert.equal(mixed?.confidence, 'medium')
assert.equal(mixed?.modeCount, 3)

console.log('earnings time tests: ok')
