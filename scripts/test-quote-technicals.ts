import assert from 'node:assert/strict'
import { buildQuoteTechnicalSummary, type QuoteTechnicalPoint } from '@/lib/quote-technicals'

function dateAt(index: number): string {
  const date = new Date(Date.UTC(2026, 0, 1 + index))
  return date.toISOString().slice(0, 10)
}

function point(index: number, close: number): QuoteTechnicalPoint {
  return {
    date: dateAt(index),
    close,
    volume: index + 1,
  }
}

const rising = Array.from({ length: 80 }, (_, index) => (
  point(index, index < 50 ? 100 : 100 + (index - 49) * 2)
))
const risingSummary = buildQuoteTechnicalSummary(rising)
assert.ok(risingSummary)
assert.equal(risingSummary.averageVolumeObservationCount, 30)
assert.equal(risingSummary.averageVolume30, 65.5)
assert.equal(risingSummary.macd?.relation, 'golden')
assert.equal(risingSummary.macd?.lastCrossType, 'golden')
assert.ok(risingSummary.macd?.lastCrossDate)

const falling = [
  ...rising,
  ...Array.from({ length: 35 }, (_, offset) => point(80 + offset, 160 - (offset + 1) * 3)),
]
const fallingSummary = buildQuoteTechnicalSummary(falling)
assert.ok(fallingSummary)
assert.equal(fallingSummary.averageVolume30, 100.5)
assert.equal(fallingSummary.macd?.relation, 'dead')
assert.equal(fallingSummary.macd?.lastCrossType, 'dead')
assert.ok(fallingSummary.macd?.lastCrossDate)

const insufficient = buildQuoteTechnicalSummary(Array.from({ length: 20 }, (_, index) => point(index, 100)))
assert.ok(insufficient)
assert.equal(insufficient.averageVolumeObservationCount, 20)
assert.equal(insufficient.macd, null)

console.log('quote technical summary tests: ok')
