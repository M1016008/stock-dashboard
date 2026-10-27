import assert from 'node:assert/strict'
import {
  requiredSecUserAgent,
  secRequestIntervalMs,
} from '@/lib/sec-edgar'

assert.equal(
  requiredSecUserAgent({ SEC_USER_AGENT: 'StockBoard/1.0 operator@example.com' }),
  'StockBoard/1.0 operator@example.com',
)
assert.throws(() => requiredSecUserAgent({}), /operator contact email/)
assert.throws(() => requiredSecUserAgent({ SEC_USER_AGENT: 'anonymous-bot' }), /operator contact email/)
assert.equal(secRequestIntervalMs({ SEC_RATE_LIMIT_MS: '5' }), 100)
assert.equal(secRequestIntervalMs({ SEC_RATE_LIMIT_MS: '250' }), 250)
assert.equal(secRequestIntervalMs({ SEC_RATE_LIMIT_MS: 'invalid' }), 150)

console.log('SEC EDGAR access contract tests: PASS')
