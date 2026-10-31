import assert from 'node:assert/strict'
import {
  assertJpOhlcvDailyIngestionReceipt,
  buildJpOhlcvDailyIngestionReceipt,
} from '@/lib/jp-ohlcv-daily-ingestion-receipt'
import type { JpOfficialOhlcvValue, JpOhlcvValue } from '@/lib/jp-ohlcv-data-quality'

function row(ticker: string, close = 100): JpOfficialOhlcvValue {
  return {
    ticker,
    date: '2026-07-17',
    open: close - 1,
    high: close + 1,
    low: close - 2,
    close,
    volume: 100,
    adjustmentFactor: 1,
  }
}

function stored(value: JpOfficialOhlcvValue): JpOhlcvValue {
  const { adjustmentFactor: _factor, ...result } = value
  return result
}

const official = [row('1306', 407.9), row('7003', 4434)]
const complete = official.map(stored)

const zeroInsert = buildJpOhlcvDailyIngestionReceipt({
  sourceRunId: 10,
  targetDate: '2026-07-17',
  officialRows: official,
  beforeRows: complete,
  afterRows: complete,
  approvedKnownConflictKeys: new Set(),
})
assertJpOhlcvDailyIngestionReceipt(zeroInsert)
assert.equal(zeroInsert.insertedKeys.length, 0)
assert.equal(zeroInsert.alreadySatisfiedKeys.length, 2)
assert.equal(zeroInsert.missingCoverage, 'COMPLETE')
assert.equal(zeroInsert.dataQualityConflict, 'CLEAN')
assert.equal(zeroInsert.sourcePublication, 'PUBLISHABLE')

const inserted = buildJpOhlcvDailyIngestionReceipt({
  sourceRunId: 11,
  targetDate: '2026-07-17',
  officialRows: official,
  beforeRows: [complete[0]],
  afterRows: complete,
  approvedKnownConflictKeys: new Set(),
})
assertJpOhlcvDailyIngestionReceipt(inserted)
assert.deepEqual(inserted.insertedKeys, ['7003:2026-07-17'])
assert.equal(inserted.sourcePublication, 'PUBLISHABLE')

const conflictRows = [{ ...complete[0], close: 407.8 }, complete[1]]
const knownConflict = buildJpOhlcvDailyIngestionReceipt({
  sourceRunId: 12,
  targetDate: '2026-07-17',
  officialRows: official,
  beforeRows: conflictRows,
  afterRows: conflictRows,
  approvedKnownConflictKeys: new Set(['1306:2026-07-17']),
})
assertJpOhlcvDailyIngestionReceipt(knownConflict)
assert.equal(knownConflict.insertedKeys.length, 0)
assert.equal(knownConflict.missingCoverage, 'COMPLETE')
assert.equal(knownConflict.dataQualityConflict, 'KNOWN_CONFLICTS')
assert.equal(knownConflict.sourcePublication, 'PARTIAL_HOLD')

const newConflict = buildJpOhlcvDailyIngestionReceipt({
  sourceRunId: 13,
  targetDate: '2026-07-17',
  officialRows: official,
  beforeRows: conflictRows,
  afterRows: conflictRows,
  approvedKnownConflictKeys: new Set(),
})
assertJpOhlcvDailyIngestionReceipt(newConflict)
assert.equal(newConflict.dataQualityConflict, 'NEW_CONFLICTS')
assert.equal(newConflict.sourcePublication, 'HOLD')

const productionOfficial = Array.from({ length: 4_218 }, (_, index) => row(String(1000 + index), 100 + index))
const protectedTickers = new Set(['1447', '2164'])
const productionBeforeSource = [
  ...productionOfficial.filter((value) => !protectedTickers.has(value.ticker)).slice(0, 155),
  ...productionOfficial.filter((value) => protectedTickers.has(value.ticker)),
]
const productionBefore = productionBeforeSource.map((value) => (
  protectedTickers.has(value.ticker) ? { ...stored(value), close: value.close + 0.1 } : stored(value)
))
const beforeKeys = new Set(productionBefore.map((value) => `${value.ticker}:${value.date}`))
const productionAfter = [
  ...productionBefore,
  ...productionOfficial.filter((value) => !beforeKeys.has(`${value.ticker}:${value.date}`)).map(stored),
]
const productionReceipt = buildJpOhlcvDailyIngestionReceipt({
  sourceRunId: 14,
  targetDate: '2026-07-17',
  officialRows: productionOfficial,
  beforeRows: productionBefore,
  afterRows: productionAfter,
  approvedKnownConflictKeys: new Set(['1447:2026-07-17', '2164:2026-07-17']),
})
assertJpOhlcvDailyIngestionReceipt(productionReceipt)
assert.equal(productionReceipt.insertedKeys.length, 4_061)
assert.equal(productionReceipt.alreadySatisfiedKeys.length, 155)
assert.equal(productionReceipt.knownConflictKeys.length, 2)
assert.equal(productionReceipt.sourcePublication, 'PARTIAL_HOLD')

console.log('JP OHLCV daily ingestion receipt tests: PASS')
