import assert from 'node:assert/strict'
import { findUsAliasTickers, getUsDisplayName } from '@/lib/us-symbol-aliases'

for (const query of ['BRK.B', 'BRK-B', 'BRK/B', 'brk_b']) {
  assert.ok(
    findUsAliasTickers(query).includes('BRK-B'),
    `${query} must resolve to the canonical BRK-B ticker`,
  )
}

assert.ok(findUsAliasTickers('Berkshire Class A').includes('BRK-A'))
assert.deepEqual(findUsAliasTickers('NVIDIA'), ['NVDA'])
assert.deepEqual(findUsAliasTickers('エヌビディア'), ['NVDA'])
assert.equal(getUsDisplayName('BRK-B'), 'Berkshire Hathaway Inc. Class B')

console.log('US symbol aliases: PASS')
