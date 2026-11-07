import assert from 'node:assert/strict'
import {
  hasJQuantsCorporateAction,
  isJQuantsNoTradeRow,
  isLikelyJQuantsCorporateActionBoundary,
  shouldApplyJQuantsLegacyAdjustment,
  type JQuantsDailyProviderRow,
} from '@/lib/jquants'

const noTradeRow: JQuantsDailyProviderRow = {
  Date: '2026-07-17', Code: '99990',
  O: null, H: null, L: null, C: null, UL: null, LL: null, Vo: null, Va: null,
  AdjFactor: 1, AdjO: null, AdjH: null, AdjL: null, AdjC: null, AdjVo: null,
}
assert.equal(isJQuantsNoTradeRow(noTradeRow), true)
assert.equal(isJQuantsNoTradeRow({ ...noTradeRow, C: 100 }), false)

assert.equal(hasJQuantsCorporateAction(1), false)
assert.equal(hasJQuantsCorporateAction(null), false)
assert.equal(hasJQuantsCorporateAction(undefined), false)
assert.equal(hasJQuantsCorporateAction(Number.NaN), false)
assert.equal(hasJQuantsCorporateAction(0.1), true)
assert.equal(hasJQuantsCorporateAction(2), true)

assert.equal(isLikelyJQuantsCorporateActionBoundary({
  previousDate: '2026-06-26',
  currentDate: '2026-06-29',
  previousClose: 14_370,
  currentClose: 1_887,
}), true)
assert.equal(isLikelyJQuantsCorporateActionBoundary({
  previousDate: '2026-06-26',
  currentDate: '2026-06-29',
  previousClose: 8_520,
  currentClose: 2_772,
}), true)
assert.equal(isLikelyJQuantsCorporateActionBoundary({
  previousDate: '2026-06-26',
  currentDate: '2026-06-29',
  previousClose: 1_556,
  currentClose: 791,
}), true)
assert.equal(isLikelyJQuantsCorporateActionBoundary({
  previousDate: '2026-06-26',
  currentDate: '2026-06-29',
  previousClose: 1_000,
  currentClose: 820,
}), false)
assert.equal(isLikelyJQuantsCorporateActionBoundary({
  previousDate: '2026-05-01',
  currentDate: '2026-06-29',
  previousClose: 1_000,
  currentClose: 500,
}), false)

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
