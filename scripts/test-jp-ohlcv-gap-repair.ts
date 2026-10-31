import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createClient } from '@libsql/client'
import {
  buildJpOhlcvBackfillPlan,
  classifyJpFetchFailure,
  evaluateJpDailyCoverage,
  findJpHistoricalCoverageGaps,
  historicalCoverageDates,
  stableSha256,
  type JpOfficialOhlcvValue,
  type JpOhlcvValue,
} from '@/lib/jp-ohlcv-data-quality'
import { getJpTradingDates } from '@/lib/server/jp-market-calendar'
import { createIsolatedRuntimeEnvironment } from '@/lib/runtime/isolation'

const DATE = '2026-07-17'

function row(ticker: string, close: number, adjustmentFactor = 1): JpOfficialOhlcvValue {
  return {
    ticker,
    date: DATE,
    open: close - 10,
    high: close + 20,
    low: close - 20,
    close,
    volume: Math.round(close * 1_000),
    adjustmentFactor,
  }
}

function existing(value: JpOfficialOhlcvValue): JpOhlcvValue {
  const { adjustmentFactor: _adjustmentFactor, ...result } = value
  return result
}

// Production-scale regression: 4,218 official rows, 151 matching rows and 4,067 missing.
const official = Array.from({ length: 4_218 }, (_, index) => row(String(index + 1).padStart(4, '0'), 1_000 + index))
official[1_305] = {
  ticker: '1306', date: DATE, open: 415.9, high: 416.8, low: 401.9, close: 407.9,
  volume: 31_540_630, adjustmentFactor: 1,
}
official[4_000] = {
  ticker: '7003', date: DATE, open: 4_567, high: 4_571, low: 4_326, close: 4_434,
  volume: 20_732_000, adjustmentFactor: 1,
}
const productionSubset = official.slice(0, 151).map(existing)
const plan = buildJpOhlcvBackfillPlan({ date: DATE, officialRows: official, existingRows: productionSubset })
assert.equal(plan.status, 'READY')
assert.equal(plan.officialRows, 4_218)
assert.equal(plan.existingRows, 151)
assert.equal(plan.matchingRows, 151)
assert.equal(plan.missingRows.length, 4_067)
assert.equal(plan.conflicts.length, 0)
assert.equal(plan.missingRows.find((value) => value.ticker === '7003')?.close, 4_434)
assert.equal(plan.missingRows.find((value) => value.ticker === '1306')?.close, 407.9)
assert.equal(plan.rollbackDeleteKeys.length, 4_067)

// Applying only missing rows is idempotent and preserves all 151 originals byte-for-byte.
const simulatedAfter = [...productionSubset, ...plan.missingRows.map(existing)]
const secondPlan = buildJpOhlcvBackfillPlan({ date: DATE, officialRows: official, existingRows: simulatedAfter })
assert.equal(secondPlan.status, 'READY')
assert.equal(secondPlan.missingRows.length, 0)
assert.equal(secondPlan.matchingRows, 4_218)
assert.equal(stableSha256(productionSubset), plan.existingSha256)

// Existing values never get overwritten, even when the provider row is otherwise valid.
const conflictingExisting = productionSubset.map((value, index) => index === 0 ? { ...value, close: value.close + 1 } : value)
const conflictPlan = buildJpOhlcvBackfillPlan({ date: DATE, officialRows: official, existingRows: conflictingExisting })
assert.equal(conflictPlan.status, 'HOLD')
assert.ok(conflictPlan.conflicts.some((conflict) => conflict.reason === 'EXISTING_VALUE_CONFLICT'))

// Provider duplicate disagreement and malformed bars fail closed.
const duplicatePlan = buildJpOhlcvBackfillPlan({
  date: DATE,
  officialRows: [row('7003', 4_434), row('7003', 4_435)],
  existingRows: [],
})
assert.equal(duplicatePlan.status, 'HOLD')
assert.ok(duplicatePlan.conflicts.some((conflict) => conflict.reason === 'OFFICIAL_DUPLICATE_CONFLICT'))
const invalidPlan = buildJpOhlcvBackfillPlan({
  date: DATE,
  officialRows: [{ ...row('7003', 4_434), high: 4_000 }],
  existingRows: [],
})
assert.equal(invalidPlan.status, 'HOLD')
assert.ok(invalidPlan.conflicts.some((conflict) => (
  conflict.reason === 'OFFICIAL_VALUE_INVALID' && conflict.validationReason === 'high_invalid'
)))

// Daily coverage is compared with independent neighboring sessions, never with itself.
const healthy = evaluateJpDailyCoverage({
  providerRows: 4_218,
  storedRows: 4_218,
  referenceRows: [4_208, 4_224, 4_215, 4_219, 4_210],
})
assert.equal(healthy.status, 'PASS')
assert.ok(healthy.expectedRows >= 4_208 && healthy.expectedRows <= 4_224)
const collapsed = evaluateJpDailyCoverage({
  providerRows: 151,
  storedRows: 151,
  referenceRows: [4_208, 4_224, 4_215, 4_219, 4_210],
})
assert.equal(collapsed.status, 'HOLD')
assert.ok(collapsed.reasons.includes('provider_row_count_below_baseline'))
assert.equal(evaluateJpDailyCoverage({
  providerRows: 4_218,
  storedRows: 4_217,
  referenceRows: [4_208, 4_224],
}).status, 'HOLD')

// Trading-day scans distinguish a real missing session from weekends and exchange holidays.
const tradingDates = getJpTradingDates('2026-07-13', '2026-07-21')
assert.deepEqual(tradingDates, ['2026-07-13', '2026-07-14', '2026-07-15', '2026-07-16', '2026-07-17', '2026-07-21'])
const rowsByDate = new Map(tradingDates.map((date) => [date, date === DATE ? 151 : 4_210]))
const gaps = findJpHistoricalCoverageGaps({ tradingDates, rowsByDate, referenceRows: [4_208, 4_224, 4_210] })
assert.deepEqual(gaps.map((gap) => gap.date), [DATE])
assert.deepEqual(
  historicalCoverageDates(['2026-07-16', '2026-07-17'], '2026-07-17'),
  ['2026-07-16'],
  'a trading-day target is independently checked and excluded from the historical scan',
)
assert.deepEqual(
  historicalCoverageDates(['2026-07-16', '2026-07-17'], '2026-07-18'),
  ['2026-07-16', '2026-07-17'],
  'a weekend target must retain the latest actual trading session',
)

// Operator logs retain actionable categories/status without response bodies or credentials.
assert.deepEqual(classifyJpFetchFailure(new Error('HTTP 429')), { category: 'RATE_LIMIT', httpStatus: 429, retryable: true })
assert.deepEqual(classifyJpFetchFailure(new Error('J-Quants failed: 401')), { category: 'AUTH', httpStatus: 401, retryable: false })
assert.deepEqual(classifyJpFetchFailure(new Error('fetch failed: ETIMEDOUT')), { category: 'NETWORK', httpStatus: null, retryable: true })
assert.deepEqual(classifyJpFetchFailure(new Error('invalid JSON response')), { category: 'INVALID_RESPONSE', httpStatus: null, retryable: false })
assert.deepEqual(
  classifyJpFetchFailure({ category: 'RATE_LIMIT', httpStatus: 429, retryable: true }),
  { category: 'RATE_LIMIT', httpStatus: 429, retryable: true },
  'structured provider errors must preserve their retry policy',
)
assert.deepEqual(
  classifyJpFetchFailure(new Error('request failed on 2026-07-17')),
  { category: 'UNKNOWN', httpStatus: null, retryable: false },
  'dates in error messages must not be parsed as HTTP status codes',
)

const batchSource = fs.readFileSync(path.join(process.cwd(), 'scripts', 'batch-ohlcv.ts'), 'utf8')
assert.match(batchSource, /dateBulkFatalError/)
assert.match(batchSource, /unresolved_historical_ohlcv_coverage/)
assert.match(batchSource, /OHLCV update incomplete/)
assert.match(batchSource, /applyJpOhlcvIngestionBoundary/)
assert.match(batchSource, /requireRunningBatchRun: true/)
assert.match(batchSource, /jp_ohlcv_normal_updater_requires_date_bulk_boundary/)
assert.match(batchSource, /\^\\d\{4\}-\\d\{2\}-\\d\{2\}\$/)
assert.match(batchSource, /jquants_corporate_action_requires_approved_history_boundary/)
assert.match(batchSource, /jp_ohlcv_source_run_finalize_compare_and_swap_failed/)
assert.match(batchSource, /positiveIntegerSetting/)
assert.match(batchSource, /historicalCoverageDates/)
assert.doesNotMatch(
  batchSource.slice(batchSource.indexOf('async function storeRows'), batchSource.indexOf('async function historicalCoverageGaps')),
  /onConflictDoUpdate|onConflictDoNothing/,
  'date backfill must never overwrite existing rows',
)
const bulkStart = batchSource.indexOf('const providerCoverage')
const corporateActionHold = batchSource.indexOf('jquants_corporate_action_requires_approved_history_boundary', bulkStart)
const boundaryWrite = batchSource.indexOf('const stored = await storeRows(rows, runId)', bulkStart)
assert.ok(corporateActionHold > bulkStart && corporateActionHold < boundaryWrite,
  'corporate-action history must hold before the daily boundary mutates source rows')
const refreshCall = batchSource.indexOf('await refreshAfterOhlcv()', boundaryWrite)
const publicationAssertion = batchSource.indexOf('await publishJpOhlcvSourceRun', refreshCall)
assert.ok(refreshCall < publicationAssertion,
  'derived refresh must precede the source-run publication transaction')
const coverageStoreSource = fs.readFileSync(
  path.join(process.cwd(), 'lib', 'jp-ohlcv-coverage-store.ts'),
  'utf8',
)
const publicationTransaction = coverageStoreSource.slice(
  coverageStoreSource.indexOf('export async function publishJpOhlcvSourceRun'),
)
assert.match(publicationTransaction, /client\.transaction\('write'\)/)
assert.ok(
  publicationTransaction.indexOf('await assertJpOhlcvSourceRunPublishable')
    < publicationTransaction.indexOf('UPDATE batch_runs'),
  'coverage-head proof and source-run CAS must share one write transaction',
)
const bulkCatch = batchSource.slice(
  batchSource.indexOf('} catch (err) {', boundaryWrite),
  batchSource.indexOf('\n  }\n  let nextIndex', boundaryWrite),
)
assert.match(bulkCatch, /dateBulkFatalError = message/)
assert.match(bulkCatch, /tickers = \[\]/)
assert.doesNotMatch(bulkCatch, /if \(failClosed\)/,
  'every exhausted date-bulk failure must stop before the legacy per-ticker writer')

async function isolatedApplyRegression(): Promise<void> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stockboard-jp-gap-repair-'))
  const dbPath = path.join(root, 'data', 'stockboard.db')
  fs.mkdirSync(path.dirname(dbPath), { recursive: true })
  const client = createClient({ url: `file:${dbPath}` })
  await client.execute(`CREATE TABLE ohlcv_daily (
    ticker TEXT NOT NULL, date TEXT NOT NULL, open REAL NOT NULL, high REAL NOT NULL,
    low REAL NOT NULL, close REAL NOT NULL, volume INTEGER NOT NULL,
    PRIMARY KEY (ticker, date)
  )`)
  const fixture = [row('1306', 407.9), row('7003', 4_434), row('7203', 3_210)]
  const first = existing(fixture[0])
  await client.execute({
    sql: 'INSERT INTO ohlcv_daily (ticker,date,open,high,low,close,volume) VALUES (?,?,?,?,?,?,?)',
    args: [first.ticker, first.date, first.open, first.high, first.low, first.close, first.volume],
  })
  client.close()
  const officialFile = path.join(root, 'official.json')
  const output1 = path.join(root, 'apply-1.json')
  const output2 = path.join(root, 'apply-2.json')
  fs.writeFileSync(officialFile, JSON.stringify(fixture))
  const isolated = createIsolatedRuntimeEnvironment('test', root, process.env)
  const run = (output: string, extraEnv: Record<string, string | undefined> = {}) => spawnSync(process.execPath, [
    '--import', 'tsx', 'scripts/repair-jp-ohlcv-gap.ts',
    '--date', DATE, '--official-json', officialFile, '--apply-isolated-db', dbPath, '--output', output,
  ], { cwd: process.cwd(), encoding: 'utf8', env: { ...isolated, ...extraEnv } })
  const firstRun = run(output1)
  assert.equal(firstRun.status, 0, firstRun.stderr)
  assert.equal(JSON.parse(fs.readFileSync(output1, 'utf8')).execution.insertedRows, 2)
  const secondRun = run(output2)
  assert.equal(secondRun.status, 0, secondRun.stderr)
  assert.equal(JSON.parse(fs.readFileSync(output2, 'utf8')).execution.insertedRows, 0)

  const countsFile = path.join(root, 'counts.json')
  const coverageOutput = path.join(root, 'coverage.json')
  fs.writeFileSync(countsFile, JSON.stringify([
    { date: '2026-07-16', count: 4_208 },
    { date: '2026-07-17', count: 151 },
    { date: '2026-07-21', count: 4_224 },
  ]))
  const coverage = spawnSync(process.execPath, [
    '--import', 'tsx', 'scripts/audit-jp-ohlcv-coverage.ts',
    '--from', '2026-07-16', '--to', '2026-07-21',
    '--counts-json', countsFile, '--output', coverageOutput,
  ], { cwd: process.cwd(), encoding: 'utf8', env: isolated })
  assert.equal(coverage.status, 2, 'coverage HOLD must be observable through the process exit code')
  assert.equal(JSON.parse(fs.readFileSync(coverageOutput, 'utf8')).gapCount, 1)

  const failedRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'stockboard-jp-gap-rollback-'))
  const failedDb = path.join(failedRoot, 'data', 'stockboard.db')
  fs.mkdirSync(path.dirname(failedDb), { recursive: true })
  const failedClient = createClient({ url: `file:${failedDb}` })
  await failedClient.execute(`CREATE TABLE ohlcv_daily (
    ticker TEXT NOT NULL, date TEXT NOT NULL, open REAL NOT NULL, high REAL NOT NULL,
    low REAL NOT NULL, close REAL NOT NULL, volume INTEGER NOT NULL,
    PRIMARY KEY (ticker, date)
  )`)
  failedClient.close()
  const failedOfficial = path.join(failedRoot, 'official.json')
  fs.writeFileSync(failedOfficial, JSON.stringify(fixture))
  const failedEnv = createIsolatedRuntimeEnvironment('test', failedRoot, process.env)
  const reservedOutput = path.join(failedRoot, 'reserved.json')
  fs.writeFileSync(reservedOutput, '{}')
  const collision = spawnSync(process.execPath, [
    '--import', 'tsx', 'scripts/repair-jp-ohlcv-gap.ts',
    '--date', DATE, '--official-json', failedOfficial, '--apply-isolated-db', failedDb,
    '--output', reservedOutput,
  ], { cwd: process.cwd(), encoding: 'utf8', env: failedEnv })
  assert.notEqual(collision.status, 0, 'an occupied evidence path must stop before applying rows')
  const collisionCheck = createClient({ url: `file:${failedDb}` })
  const afterCollision = await collisionCheck.execute('SELECT COUNT(*) AS count FROM ohlcv_daily')
  collisionCheck.close()
  assert.equal(Number(afterCollision.rows[0]?.count ?? -1), 0, 'evidence-path failure must not mutate the database')
  const failedOutput = path.join(failedRoot, 'failed.json')
  const failed = spawnSync(process.execPath, [
    '--import', 'tsx', 'scripts/repair-jp-ohlcv-gap.ts',
    '--date', DATE, '--official-json', failedOfficial, '--apply-isolated-db', failedDb,
    '--output', failedOutput,
  ], {
    cwd: process.cwd(), encoding: 'utf8',
    env: { ...failedEnv, JP_OHLCV_REPAIR_FAIL_AFTER_INSERTS: '1' },
  })
  assert.notEqual(failed.status, 0)
  assert.equal(JSON.parse(fs.readFileSync(failedOutput, 'utf8')).state, 'FAILED')
  const verifyRollback = createClient({ url: `file:${failedDb}` })
  const afterFailure = await verifyRollback.execute('SELECT COUNT(*) AS count FROM ohlcv_daily')
  verifyRollback.close()
  assert.equal(Number(afterFailure.rows[0]?.count ?? -1), 0, 'failed isolated transaction must roll back every inserted row')
  fs.rmSync(root, { recursive: true })
  fs.rmSync(failedRoot, { recursive: true })
}

isolatedApplyRegression().then(() => {
  console.log(JSON.stringify({
    status: 'PASS',
    officialRows: plan.officialRows,
    existingRows: plan.existingRows,
    missingRows: plan.missingRows.length,
    conflicts: plan.conflicts.length,
    productionMutation: false,
  }))
}).catch((error) => {
  console.error(error)
  process.exitCode = 1
})
