import assert from 'node:assert/strict'
import { shouldFailDeteriorationGate } from '@/lib/ml/deterioration-gate'

assert.equal(shouldFailDeteriorationGate([
  { status: 'fail', publicationBlocking: false },
  { status: 'missing', publicationBlocking: false },
], true), false)

assert.equal(shouldFailDeteriorationGate([
  { status: 'warn', publicationBlocking: true },
], true), false)

assert.equal(shouldFailDeteriorationGate([
  { status: 'fail', publicationBlocking: true },
], true), true)

assert.equal(shouldFailDeteriorationGate([
  { status: 'missing', publicationBlocking: true },
], false), false)

console.log('ML deterioration publication gate tests passed')
