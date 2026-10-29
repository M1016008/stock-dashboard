import assert from 'node:assert/strict'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import {
  buildJpOhlcvBackfillPlan,
  buildJpOhlcvMissingOnlyRepairScope,
  buildJpOhlcvRuntimeRepairScope,
  stableSha256,
  type JpOfficialOhlcvValue,
  type JpOhlcvValue,
} from '@/lib/jp-ohlcv-data-quality'
import {
  assertJpOhlcvRuntimeSnapshot,
  assertJpOhlcvRuntimeSnapshotUnchanged,
  captureJpOhlcvRuntimeSnapshot,
} from '@/lib/jp-ohlcv-runtime-snapshot'

type FixtureDatabase = {
  exec(sql: string): void
  prepare(sql: string): { run(...args: unknown[]): unknown }
  close(): void
}
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as {
  DatabaseSync: new (file: string) => FixtureDatabase
}

const date = '2026-07-17'
const official: JpOfficialOhlcvValue[] = [
  { ticker: '1306', date, open: 400, high: 410, low: 399, close: 407.9, volume: 10, adjustmentFactor: 1 },
  { ticker: '7003', date, open: 4400, high: 4500, low: 4300, close: 4434, volume: 20, adjustmentFactor: 1 },
  { ticker: '1447', date, open: 273.7, high: 285.1, low: 267, close: 270.4, volume: 30, adjustmentFactor: 1 },
]
const conflict: JpOhlcvValue = {
  ticker: '1447', date, open: 273.5, high: 284.9, low: 266.8, close: 270.2, volume: 30,
}
const approvalPlan = buildJpOhlcvBackfillPlan({ date, officialRows: official, existingRows: [conflict] })
const approvalScope = buildJpOhlcvMissingOnlyRepairScope({
  plan: approvalPlan,
  approvedConflictTickers: ['1447'],
})
assert.equal(approvalScope.status, 'READY')

const exact1306: JpOhlcvValue = (({ adjustmentFactor: _factor, ...row }) => row)(official[0])
const exact7003: JpOhlcvValue = (({ adjustmentFactor: _factor, ...row }) => row)(official[1])

const baseline = buildJpOhlcvRuntimeRepairScope({ approvalScope, officialRows: official, existingRows: [conflict] })
assert.equal(baseline.status, 'READY')
assert.equal(baseline.missingRows.length, 2)

const updaterSatisfiedOne = buildJpOhlcvRuntimeRepairScope({
  approvalScope,
  officialRows: official,
  existingRows: [conflict, exact1306],
})
assert.equal(updaterSatisfiedOne.status, 'READY')
assert.deepEqual(updaterSatisfiedOne.missingRows.map((row) => row.ticker), ['7003'])
assert.deepEqual(updaterSatisfiedOne.alreadySatisfiedRows.map((row) => row.ticker), ['1306'])

const allSatisfied = buildJpOhlcvRuntimeRepairScope({
  approvalScope,
  officialRows: official,
  existingRows: [conflict, exact1306, exact7003],
})
assert.equal(allSatisfied.status, 'READY')
assert.equal(allSatisfied.missingRows.length, 0)
assert.equal(allSatisfied.alreadySatisfiedRows.length, 2)

const priceConflict = buildJpOhlcvRuntimeRepairScope({
  approvalScope,
  officialRows: official,
  existingRows: [conflict, { ...exact1306, close: 999 }],
})
assert.equal(priceConflict.status, 'HOLD')
assert.ok(priceConflict.reasons.includes(`approved_key_existing_value_conflict:1306:${date}`))

const unapproved = buildJpOhlcvRuntimeRepairScope({
  approvalScope,
  officialRows: official,
  existingRows: [conflict, { ...exact1306, ticker: '9999' }],
})
assert.equal(unapproved.status, 'HOLD')
assert.ok(unapproved.reasons.includes(`unapproved_or_changed_conflict:9999:${date}`))
assert.equal(unapproved.reasons.filter((reason) => reason.endsWith(`:9999:${date}`)).length, 1)

const revisedOfficial = official.map((row) => row.ticker === '7003' ? { ...row, close: 4435 } : row)
const sourceRevision = buildJpOhlcvRuntimeRepairScope({
  approvalScope,
  officialRows: revisedOfficial,
  existingRows: [conflict],
})
assert.equal(sourceRevision.status, 'HOLD')
assert.ok(sourceRevision.reasons.includes('official_source_hash_changed'))

const updaterTickers = ['1328', '3779', '5341', '6036', '6574', '6787']
const productionScaleTickers = [
  ...Array.from({ length: 5_500 }, (_, index) => String(1_000 + index).padStart(4, '0'))
    .filter((ticker) => !updaterTickers.includes(ticker))
    .slice(0, 4_212),
  ...updaterTickers,
].sort()
const productionScaleOfficial: JpOfficialOhlcvValue[] = productionScaleTickers.map((ticker, index) => {
  const close = 100 + index
  return { ticker, date, open: close - 1, high: close + 2, low: close - 2, close, volume: 10_000 + index, adjustmentFactor: 1 }
})
const officialAtScale = new Map(productionScaleOfficial.map((row) => [row.ticker, row]))
const matchingAtScale = productionScaleOfficial
  .filter((row) => !['1447', '2164'].includes(row.ticker))
  .slice(0, 149)
  .map(({ adjustmentFactor: _factor, ...row }) => row)
const conflictsAtScale = ['1447', '2164'].map((ticker) => {
  const row = officialAtScale.get(ticker)!
  return { ...row, close: row.close - 0.5, adjustmentFactor: undefined } as unknown as JpOhlcvValue
})
const initial151 = [...matchingAtScale, ...conflictsAtScale]
const productionScalePlan = buildJpOhlcvBackfillPlan({
  date,
  officialRows: productionScaleOfficial,
  existingRows: initial151,
})
const productionScaleApproval = buildJpOhlcvMissingOnlyRepairScope({
  plan: productionScalePlan,
  approvedConflictTickers: ['1447', '2164'],
})
assert.equal(productionScaleApproval.status, 'READY')
assert.equal(productionScaleApproval.missingRows.length, 4_067)
const updaterRows = updaterTickers.map((ticker) => {
  const { adjustmentFactor: _factor, ...row } = officialAtScale.get(ticker)!
  return row
})
const current157 = buildJpOhlcvRuntimeRepairScope({
  approvalScope: productionScaleApproval,
  officialRows: productionScaleOfficial,
  existingRows: [...initial151, ...updaterRows],
})
assert.equal(current157.status, 'READY')
assert.equal(current157.missingRows.length, 4_061)
assert.equal(current157.alreadySatisfiedRows.length, 6)
const fourMismatches = updaterRows.map((row) => (
  ['1328', '6036', '6574', '6787'].includes(row.ticker) ? { ...row, close: row.close + 0.5 } : row
))
const mismatched157 = buildJpOhlcvRuntimeRepairScope({
  approvalScope: productionScaleApproval,
  officialRows: productionScaleOfficial,
  existingRows: [...initial151, ...fourMismatches],
})
assert.equal(mismatched157.status, 'HOLD')
assert.equal(mismatched157.reasons.filter((reason) => reason.startsWith('approved_key_existing_value_conflict:')).length, 4)

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jp-ohlcv-runtime-snapshot-'))
const databasePath = path.join(root, 'fixture.sqlite')
const database = new DatabaseSync(databasePath)
database.exec(`
  CREATE TABLE ohlcv_daily (
    ticker TEXT NOT NULL, date TEXT NOT NULL, open REAL NOT NULL, high REAL NOT NULL,
    low REAL NOT NULL, close REAL NOT NULL, volume INTEGER NOT NULL,
    PRIMARY KEY(ticker,date)
  );
  CREATE TABLE batch_runs (
    id INTEGER PRIMARY KEY, job_type TEXT NOT NULL, status TEXT NOT NULL,
    started_at INTEGER, finished_at INTEGER
  );
  INSERT INTO batch_runs VALUES(1,'ohlcv_fetch:jquants','success',1,2);
  CREATE TABLE daily_snapshots(date TEXT, computed_at INTEGER);
  CREATE TABLE stock_screening_serving_dates(as_of TEXT, calculated_at INTEGER);
  CREATE TABLE dashboard_cache(date TEXT, computed_at INTEGER);
`)
const insert = database.prepare('INSERT INTO ohlcv_daily VALUES(?,?,?,?,?,?,?)')
insert.run(conflict.ticker, conflict.date, conflict.open, conflict.high, conflict.low, conflict.close, conflict.volume)
database.close()

const sourceContract = {
  version: 1 as const,
  endpoint: '/v2/equities/bars/daily' as const,
  requestedDate: date,
  providerRows: official.length + 224,
  acceptedRows: official.length,
  rejectedRows: 224,
  noTradeRows: 224,
  unexpectedRejectedRows: 0 as const,
  contentSha256: approvalScope.officialSha256,
  rejectedRowsSha256: 'b'.repeat(64),
  rejectionPolicy: 'ALLOW_ONLY_ALL_OHLCV_FIELDS_NULL' as const,
}
const sourceProof = (at: Date) => ({
  requestedAt: at.toISOString(),
  completedAt: at.toISOString(),
  providerRows: official.length + 224,
  acceptedRows: official.length,
  rejectedRows: 224,
  noTradeRows: 224,
  unexpectedRejectedRows: 0,
  contentSha256: approvalScope.officialSha256,
  rejectedRowsSha256: 'b'.repeat(64),
})

const fixedAt = new Date('2026-10-29T00:00:00.000Z')
const fixed = captureJpOhlcvRuntimeSnapshot({
  databasePath,
  configurationSha256: 'a'.repeat(64),
  approvalScope,
  officialRows: official,
  officialSourceProof: sourceProof(fixedAt),
  officialSourceContract: sourceContract,
  now: fixedAt,
})
assert.doesNotThrow(() => assertJpOhlcvRuntimeSnapshot({
  snapshot: fixed,
  now: new Date('2026-10-29T00:10:00.000Z'),
}))
assert.throws(() => assertJpOhlcvRuntimeSnapshot({
  snapshot: fixed,
  now: new Date('2026-10-29T00:15:00.001Z'),
}), /runtime_snapshot_expired/)

const staleProofCapturedAt = new Date('2026-10-29T01:00:00.000Z')
const staleProofAt = new Date(staleProofCapturedAt.getTime() - 900_001)
const staleOfficialProof = captureJpOhlcvRuntimeSnapshot({
  databasePath,
  configurationSha256: 'a'.repeat(64),
  approvalScope,
  officialRows: official,
  officialSourceProof: sourceProof(staleProofAt),
  officialSourceContract: sourceContract,
  now: staleProofCapturedAt,
})
assert.throws(() => assertJpOhlcvRuntimeSnapshot({
  snapshot: staleOfficialProof,
  now: staleProofCapturedAt,
}), /runtime_snapshot_expired/)

const sealedAt = new Date()
const sealed = captureJpOhlcvRuntimeSnapshot({
  databasePath,
  configurationSha256: 'a'.repeat(64),
  approvalScope,
  officialRows: official,
  officialSourceProof: sourceProof(sealedAt),
  officialSourceContract: sourceContract,
  now: sealedAt,
})
const changedDatabase = new DatabaseSync(databasePath)
changedDatabase.exec("INSERT INTO batch_runs VALUES(2,'ohlcv_fetch:jquants','success',3,4)")
changedDatabase.close()
const changed = captureJpOhlcvRuntimeSnapshot({
  databasePath,
  configurationSha256: 'a'.repeat(64),
  approvalScope,
  officialRows: official,
  officialSourceProof: sourceProof(sealedAt),
  officialSourceContract: sourceContract,
  now: sealedAt,
})
assert.throws(() => assertJpOhlcvRuntimeSnapshotUnchanged({ sealed, current: changed }), /changed_after_writer_hold/)

const malformedProof = {
  ...fixed,
  officialSourceProof: { ...fixed.officialSourceProof, unexpectedRejectedRows: 1, noTradeRows: 223 },
}
malformedProof.officialSourceProofSha256 = stableSha256(malformedProof.officialSourceProof)
const { snapshotSha256: _malformedHash, ...malformedBody } = malformedProof
malformedProof.snapshotSha256 = stableSha256(malformedBody)
assert.throws(() => assertJpOhlcvRuntimeSnapshot({ snapshot: malformedProof, now: fixedAt }), /rejection_policy_violation/)

const changedEnvelope = {
  ...fixed,
  officialSourceProof: { ...fixed.officialSourceProof, rejectedRowsSha256: 'c'.repeat(64) },
}
changedEnvelope.officialSourceProofSha256 = stableSha256(changedEnvelope.officialSourceProof)
const { snapshotSha256: _envelopeHash, ...changedEnvelopeBody } = changedEnvelope
changedEnvelope.snapshotSha256 = stableSha256(changedEnvelopeBody)
assert.throws(
  () => assertJpOhlcvRuntimeSnapshot({ snapshot: changedEnvelope, now: fixedAt }),
  /provider_envelope_mismatch:expectedHash=.*:observedHash=/,
)

const changedAccepted = {
  ...fixed,
  officialSourceProof: { ...fixed.officialSourceProof, contentSha256: 'c'.repeat(64) },
}
changedAccepted.officialSourceProofSha256 = stableSha256(changedAccepted.officialSourceProof)
const { snapshotSha256: _acceptedHash, ...changedAcceptedBody } = changedAccepted
changedAccepted.snapshotSha256 = stableSha256(changedAcceptedBody)
assert.throws(
  () => assertJpOhlcvRuntimeSnapshot({ snapshot: changedAccepted, now: fixedAt }),
  /accepted_content_mismatch/,
)

console.log('JP OHLCV runtime snapshot tests: PASS')
