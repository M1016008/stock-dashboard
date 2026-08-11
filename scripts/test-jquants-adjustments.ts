import assert from 'node:assert/strict'
import {
  hasJQuantsCorporateAction,
  shouldApplyJQuantsLegacyAdjustment,
} from '@/lib/jquants'

assert.equal(hasJQuantsCorporateAction(1), false)
assert.equal(hasJQuantsCorporateAction(null), false)
assert.equal(hasJQuantsCorporateAction(undefined), false)
assert.equal(hasJQuantsCorporateAction(Number.NaN), false)
assert.equal(hasJQuantsCorporateAction(0.1), true)
assert.equal(hasJQuantsCorporateAction(2), true)

assert.equal(shouldApplyJQuantsLegacyAdjustment({
  adjustmentFactor: 0.1,
  adjustedProviderStartClose: 268,
  existingProviderStartClose: 2680,
  legacyLastClose: 2670,
}), true)
assert.equal(shouldApplyJQuantsLegacyAdjustment({
  adjustmentFactor: 0.1,
  adjustedProviderStartClose: 268,
  existingProviderStartClose: 268,
  legacyLastClose: 2670,
}), true)
assert.equal(shouldApplyJQuantsLegacyAdjustment({
  adjustmentFactor: 0.1,
  adjustedProviderStartClose: 268,
  existingProviderStartClose: 268,
  legacyLastClose: 267,
}), false)
assert.equal(shouldApplyJQuantsLegacyAdjustment({
  adjustmentFactor: 1,
  adjustedProviderStartClose: 268,
  existingProviderStartClose: 2680,
  legacyLastClose: 2670,
}), false)

console.log('J-Quants adjustment detection tests passed')
