import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
// @ts-expect-error Node 24 ships node:sqlite; the repository pins older Node type declarations.
import { DatabaseSync } from 'node:sqlite'
import {
  applyJpOhlcvRepairTransaction,
  chunkJpOhlcvRepairTickers,
  createJpOhlcvRepairPlan,
  inspectJpOhlcvRepairMlCoverage,
} from '@/lib/jp-ohlcv-local-repair'
import { isJpOhlcvProtectedConflictKey } from '@/lib/jp-ohlcv-repair-policy'

type Row = {
  ticker: string
  adjustmentFactor: number
  date: string
  open: number
  high: number
  low: number
  close: number
  volume: number
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stockboard-local-repair-'))
const script = path.resolve('scripts/poc-jp-local-repair.ts')
const officialPath = path.join(root, 'official.json')
const basePath = path.join(root, 'base.sqlite')
const planPath = path.join(root, 'plan.json')
const targetDate = '2026-07-17'

function rows(): Row[] {
  return Array.from({ length: 4_218 }, (_, index) => {
    const ticker = String(1_000 + index)
    const close = 100 + index / 100
    return {
      ticker,
      adjustmentFactor: 1,
      date: targetDate,
      open: close - 1,
      high: close + 1,
      low: close - 2,
      close,
      volume: 10_000 + index,
    }
  })
}

const officialRows = rows()

function createBase(): void {
  fs.writeFileSync(officialPath, JSON.stringify({
    date: targetDate,
    priceBasis: 'jquants-adjusted-ohlcv-v1',
    sourceContract: {
      contentSha256: 'a'.repeat(64),
      acceptedRows: officialRows.length,
      unexpectedRejectedRows: 0,
    },
    rows: officialRows,
  }))
  const db = new DatabaseSync(basePath)
  db.exec(`
    PRAGMA journal_mode=WAL;
    PRAGMA synchronous=FULL;
    PRAGMA fullfsync=ON;
    CREATE TABLE ohlcv_daily(
      ticker TEXT NOT NULL,date TEXT NOT NULL,open REAL NOT NULL,high REAL NOT NULL,
      low REAL NOT NULL,close REAL NOT NULL,volume INTEGER NOT NULL,
      PRIMARY KEY(ticker,date)
    ) WITHOUT ROWID;
    CREATE TABLE batch_runs(
      id INTEGER PRIMARY KEY AUTOINCREMENT,job_type TEXT NOT NULL,started_at INTEGER NOT NULL,
      finished_at INTEGER,status TEXT NOT NULL,total_tickers INTEGER,succeeded INTEGER DEFAULT 0,
      failed INTEGER DEFAULT 0,rows_inserted INTEGER DEFAULT 0,error_summary TEXT
    );
    CREATE TABLE repair_derived_probe(id INTEGER PRIMARY KEY,value INTEGER NOT NULL);
    INSERT INTO repair_derived_probe VALUES(1,0);
    CREATE TABLE jquants_daily_coverage(
      date TEXT PRIMARY KEY,expected_rows INTEGER NOT NULL,imported_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE TABLE jquants_daily_coverage_issues(
      date TEXT NOT NULL,ticker TEXT NOT NULL,kind TEXT NOT NULL,status TEXT NOT NULL,
      detail TEXT,observed_at INTEGER NOT NULL DEFAULT (unixepoch()),resolved_at INTEGER,
      PRIMARY KEY(date,ticker,kind)
    );
    INSERT INTO jquants_daily_coverage_issues(date,ticker,kind,status,detail)
    VALUES('${targetDate}','*','FETCH_FAILED','open','fixture failure');
    INSERT INTO jquants_daily_coverage_issues(date,ticker,kind,status,detail)
    VALUES('${targetDate}','UNRELATED','MISSING','open','not in this approved repair');
  `)
  const insert = db.prepare('INSERT INTO ohlcv_daily VALUES(?,?,?,?,?,?,?)')
  const exact = officialRows.filter((row) => !['1447', '2164'].includes(row.ticker)).slice(0, 155)
  for (const row of exact) insert.run(row.ticker, row.date, row.open, row.high, row.low, row.close, row.volume)
  for (const ticker of ['1447', '2164']) {
    const row = officialRows.find((candidate) => candidate.ticker === ticker)!
    insert.run(row.ticker, row.date, row.open, row.high, row.low, row.close + 0.2, row.volume)
  }
  db.close()
}

function command(database: string, mode: 'plan' | 'apply', extra: string[] = []): string[] {
  return [
    '--import', 'tsx', script, mode,
    '--database', database,
    '--official', officialPath,
    '--plan', planPath,
    ...extra,
  ]
}

function run(database: string, extra: string[] = []): ReturnType<typeof spawnSync> {
  return spawnSync(process.execPath, command(database, 'apply', extra), {
    cwd: process.cwd(),
    encoding: 'utf8',
  })
}

function output(value: string | Buffer | null): string {
  return typeof value === 'string' ? value : value?.toString('utf8') ?? ''
}

function copy(name: string): string {
  const database = path.join(root, `${name}.sqlite`)
  fs.copyFileSync(basePath, database)
  return database
}

function inspect(database: string): {
  targetRows: number
  conflictCloses: number[]
  derived: number
  receipts: number
  receiptStatuses: string[]
  quickCheck: string
  openCoverage: string[]
} {
  // Writable open is intentional for the SIGKILL case: SQLite may need to
  // recover a hot rollback journal before a read can prove transactionality.
  const db = new DatabaseSync(database)
  try {
    return {
      targetRows: (db.prepare('SELECT COUNT(*) AS count FROM ohlcv_daily WHERE date=?').get(targetDate) as { count: number }).count,
      conflictCloses: (db.prepare("SELECT close FROM ohlcv_daily WHERE ticker IN ('1447','2164') ORDER BY ticker").all() as Array<{ close: number }>).map((row) => row.close),
      derived: (db.prepare('SELECT value FROM repair_derived_probe WHERE id=1').get() as { value: number }).value,
      receipts: (db.prepare("SELECT COUNT(*) AS count FROM batch_runs WHERE job_type='ohlcv_fetch:jquants'").get() as { count: number }).count,
      receiptStatuses: (db.prepare("SELECT status FROM batch_runs WHERE job_type='ohlcv_fetch:jquants' ORDER BY id").all() as Array<{ status: string }>).map((row) => row.status),
      quickCheck: (db.prepare('PRAGMA quick_check').get() as { quick_check: string }).quick_check,
      openCoverage: (db.prepare(`
        SELECT ticker || ':' || kind AS issue FROM jquants_daily_coverage_issues
        WHERE status='open' ORDER BY ticker,kind
      `).all() as Array<{ issue: string }>).map((row) => row.issue),
    }
  } finally {
    db.close()
  }
}

async function waitForFile(filePath: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (fs.existsSync(filePath)) return
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error(`timed out waiting for ${filePath}`)
}

async function main(): Promise<void> {
  const chunked = chunkJpOhlcvRepairTickers(
    Array.from({ length: 4_061 }, (_, index) => String(index + 1)),
    500,
  )
  assert.equal(chunked.length, 9)
  assert.equal(chunked.at(-1)?.length, 61)
  assert.deepEqual(chunked.flat(), Array.from({ length: 4_061 }, (_, index) => String(index + 1)))
  assert.throws(() => chunkJpOhlcvRepairTickers(['1306'], 0), /positive integer/)

  const mlCoverageDb = new DatabaseSync(':memory:')
  mlCoverageDb.exec(`
    CREATE TABLE ohlcv_daily(ticker TEXT NOT NULL,date TEXT NOT NULL,PRIMARY KEY(ticker,date));
    CREATE TABLE ml_feature_vectors(ticker TEXT NOT NULL,date TEXT NOT NULL,computed_at INTEGER NOT NULL);
    CREATE TABLE ml_feature_vectors_v2(
      ticker TEXT NOT NULL,date TEXT NOT NULL,computed_at INTEGER NOT NULL,feature_set TEXT NOT NULL
    );
  `)
  const insertHistory = mlCoverageDb.prepare('INSERT INTO ohlcv_daily VALUES(?,?)')
  for (let day = 0; day < 220; day += 1) {
    insertHistory.run('2068', new Date(Date.UTC(2026, 0, 1 + day)).toISOString().slice(0, 10))
  }
  insertHistory.run('SHORT', '2026-08-08')
  mlCoverageDb.prepare('INSERT INTO ml_feature_vectors_v2 VALUES(?,?,?,?)')
    .run('2068', '2026-08-08', 100, 'ma_physics_v4')
  mlCoverageDb.prepare('INSERT INTO ml_feature_vectors_v2 VALUES(?,?,?,?)')
    .run('SHORT', '2026-08-08', 100, 'ma_physics_v4')
  assert.deepEqual(inspectJpOhlcvRepairMlCoverage({
    db: mlCoverageDb,
    table: 'ml_feature_vectors_v2',
    affectedTickers: ['2068', 'SHORT'],
    startDate: '2026-08-08',
    endDate: '2026-08-08',
    computedAtEpoch: 100,
    minHistoryDays: 220,
    featureSet: 'ma_physics_v4',
  }), { expected: 1, actual: 2, missing: 0, extra: 1 })
  mlCoverageDb.prepare("DELETE FROM ml_feature_vectors_v2 WHERE ticker='SHORT'").run()
  assert.deepEqual(inspectJpOhlcvRepairMlCoverage({
    db: mlCoverageDb,
    table: 'ml_feature_vectors_v2',
    affectedTickers: ['2068'],
    startDate: '2026-08-08',
    endDate: '2026-08-08',
    computedAtEpoch: 100,
    minHistoryDays: 220,
    featureSet: 'ma_physics_v4',
  }), { expected: 1, actual: 1, missing: 0, extra: 0 })
  mlCoverageDb.prepare('INSERT INTO ml_feature_vectors_v2 VALUES(?,?,?,?)')
    .run('2068', '2026-08-08', 100, 'ma_physics_v4')
  assert.deepEqual(inspectJpOhlcvRepairMlCoverage({
    db: mlCoverageDb,
    table: 'ml_feature_vectors_v2',
    affectedTickers: ['2068'],
    startDate: '2026-08-08',
    endDate: '2026-08-08',
    computedAtEpoch: 100,
    minHistoryDays: 220,
    featureSet: 'ma_physics_v4',
  }), { expected: 1, actual: 2, missing: 0, extra: 0 })
  mlCoverageDb.prepare("DELETE FROM ml_feature_vectors_v2 WHERE ticker='2068'").run()
  assert.deepEqual(inspectJpOhlcvRepairMlCoverage({
    db: mlCoverageDb,
    table: 'ml_feature_vectors_v2',
    affectedTickers: ['2068'],
    startDate: '2026-08-08',
    endDate: '2026-08-08',
    computedAtEpoch: 100,
    minHistoryDays: 220,
    featureSet: 'ma_physics_v4',
  }), { expected: 1, actual: 0, missing: 1, extra: 0 })
  mlCoverageDb.close()

  createBase()
  const validationDb = new DatabaseSync(basePath)
  assert.throws(() => createJpOhlcvRepairPlan({
    db: validationDb,
    targetDate,
    priceBasis: 'jquants-adjusted-ohlcv-v1',
    providerContentSha256: 'a'.repeat(64),
    officialRows: [{ ...officialRows[0], date: '2026-07-16' }, ...officialRows.slice(1)],
    preservedConflictKeys: ['1447:2026-07-17', '2164:2026-07-17'],
  }), /official row date mismatch/)
  assert.throws(() => createJpOhlcvRepairPlan({
    db: validationDb,
    targetDate,
    priceBasis: 'jquants-adjusted-ohlcv-v1',
    providerContentSha256: 'a'.repeat(64),
    officialRows: [...officialRows, officialRows[0]],
    preservedConflictKeys: ['1447:2026-07-17', '2164:2026-07-17'],
  }), /duplicate official row/)
  validationDb.close()
  const planned = spawnSync(process.execPath, command(basePath, 'plan'), { cwd: process.cwd(), encoding: 'utf8' })
  assert.equal(planned.status, 0, output(planned.stderr))
  const plan = JSON.parse(fs.readFileSync(planPath, 'utf8')) as { approvedMissingKeys: string[] }
  assert.equal(plan.approvedMissingKeys.length, 4_061)
  assert.equal(isJpOhlcvProtectedConflictKey({ ticker: '1447', date: targetDate }), true)
  assert.equal(isJpOhlcvProtectedConflictKey({ ticker: '7003', date: targetDate }), false)

  const successDb = copy('success')
  const success = run(successDb, ['--fixture-derived-probe'])
  assert.equal(success.status, 0, output(success.stderr))
  assert.deepEqual(inspect(successDb), {
    targetRows: 4_218,
    conflictCloses: [officialRows.find((row) => row.ticker === '1447')!.close + 0.2, officialRows.find((row) => row.ticker === '2164')!.close + 0.2],
    derived: 1,
    receipts: 1,
    receiptStatuses: ['success'],
    quickCheck: 'ok',
    openCoverage: ['1447:PROTECTED_CONFLICT', '2164:PROTECTED_CONFLICT', 'UNRELATED:MISSING'],
  })
  const sourceRerun = run(successDb)
  assert.equal(sourceRerun.status, 0, output(sourceRerun.stderr))
  assert.match(output(sourceRerun.stdout), /"alreadySatisfied":4061/)
  assert.match(output(sourceRerun.stdout), /"inserted":0/)
  assert.equal(inspect(successDb).receipts, 1)
  const derivedRerun = run(successDb, ['--fixture-derived-probe'])
  assert.equal(derivedRerun.status, 0, output(derivedRerun.stderr))
  assert.match(output(derivedRerun.stdout), /"derived":"already_complete"/)
  assert.equal(inspect(successDb).derived, 1)

  const alreadyDb = copy('already-satisfied')
  const already = new DatabaseSync(alreadyDb)
  const firstApproved = officialRows.find((row) => `${row.ticker}:${row.date}` === plan.approvedMissingKeys[0])!
  already.prepare('INSERT INTO ohlcv_daily VALUES(?,?,?,?,?,?,?)')
    .run(firstApproved.ticker, firstApproved.date, firstApproved.open, firstApproved.high, firstApproved.low, firstApproved.close, firstApproved.volume)
  already.close()
  const alreadyResult = run(alreadyDb, ['--fixture-derived-probe'])
  assert.notEqual(alreadyResult.status, 0)
  assert.match(output(alreadyResult.stderr), /partial external insertion detected/)
  assert.equal(inspect(alreadyDb).targetRows, 158)

  const sourceFailureDb = copy('source-failure')
  const sourceFailure = run(sourceFailureDb, ['--fixture-derived-probe', '--fail-at', 'after-source-insert'])
  assert.notEqual(sourceFailure.status, 0)
  assert.deepEqual(inspect(sourceFailureDb), {
    targetRows: 157,
    conflictCloses: [officialRows.find((row) => row.ticker === '1447')!.close + 0.2, officialRows.find((row) => row.ticker === '2164')!.close + 0.2],
    derived: 0,
    receipts: 0,
    receiptStatuses: [],
    quickCheck: 'ok',
    openCoverage: ['*:FETCH_FAILED', 'UNRELATED:MISSING'],
  })

  const capacityDb = copy('capacity-failure')
  const capacity = new DatabaseSync(capacityDb)
  try {
    const capacityPlan = createJpOhlcvRepairPlan({
      db: capacity,
      targetDate,
      priceBasis: 'jquants-adjusted-ohlcv-v1',
      providerContentSha256: 'a'.repeat(64),
      officialRows,
      preservedConflictKeys: ['1447:2026-07-17', '2164:2026-07-17'],
    })
    const pageCount = Number((capacity.prepare('PRAGMA page_count').get() as { page_count: number }).page_count)
    capacity.exec(`PRAGMA max_page_count=${pageCount}`)
    assert.throws(
      () => applyJpOhlcvRepairTransaction({ db: capacity, plan: capacityPlan, officialRows }),
      /database or disk is full|SQLITE_FULL/i,
    )
  } finally {
    capacity.close()
  }
  assert.deepEqual(inspect(capacityDb), {
    targetRows: 157,
    conflictCloses: [officialRows.find((row) => row.ticker === '1447')!.close + 0.2, officialRows.find((row) => row.ticker === '2164')!.close + 0.2],
    derived: 0,
    receipts: 0,
    receiptStatuses: [],
    quickCheck: 'ok',
    openCoverage: ['*:FETCH_FAILED', 'UNRELATED:MISSING'],
  })

  const wrongJournalDb = copy('wrong-journal')
  const wrongJournal = new DatabaseSync(wrongJournalDb)
  wrongJournal.prepare('PRAGMA journal_mode=DELETE').get()
  wrongJournal.close()
  const wrongJournalResult = run(wrongJournalDb)
  assert.notEqual(wrongJournalResult.status, 0)
  assert.match(output(wrongJournalResult.stderr), /requires WAL journal mode/)
  assert.equal(inspect(wrongJournalDb).targetRows, 157)

  const derivedFailureDb = copy('derived-failure')
  const derivedFailure = run(derivedFailureDb, ['--fixture-derived-probe', '--fail-at', 'during-derived'])
  assert.notEqual(derivedFailure.status, 0)
  const derivedFailureState = inspect(derivedFailureDb)
  assert.equal(derivedFailureState.targetRows, 4_218)
  assert.equal(derivedFailureState.derived, 0)
  assert.equal(derivedFailureState.receipts, 1)
  assert.deepEqual(derivedFailureState.receiptStatuses, ['partial'])
  assert.equal(derivedFailureState.quickCheck, 'ok')
  const derivedResume = run(derivedFailureDb, ['--fixture-derived-probe'])
  assert.equal(derivedResume.status, 0, output(derivedResume.stderr))
  const derivedResumedState = inspect(derivedFailureDb)
  assert.equal(derivedResumedState.targetRows, 4_218)
  assert.equal(derivedResumedState.derived, 1)
  assert.deepEqual(derivedResumedState.receiptStatuses, ['success'])

  const conflictDb = copy('new-conflict')
  const conflict = new DatabaseSync(conflictDb)
  const conflicting = officialRows.find((row) => plan.approvedMissingKeys.includes(`${row.ticker}:${row.date}`))!
  conflict.prepare('INSERT INTO ohlcv_daily VALUES(?,?,?,?,?,?,?)')
    .run(conflicting.ticker, conflicting.date, conflicting.open, conflicting.high, conflicting.low, conflicting.close + 1, conflicting.volume)
  conflict.close()
  const rejected = run(conflictDb)
  assert.notEqual(rejected.status, 0)
  assert.match(output(rejected.stderr), /unapproved conflict set/)
  assert.equal(inspect(conflictDb).targetRows, 158)

  const sigkillDb = copy('sigkill')
  const marker = path.join(root, 'sigkill-ready')
  const child = spawn(process.execPath, command(sigkillDb, 'apply', [
    '--fixture-derived-probe', '--fail-at', 'pause-after-source-insert', '--marker', marker,
  ]), { cwd: process.cwd(), stdio: 'ignore' })
  await waitForFile(marker, 10_000)
  child.kill('SIGKILL')
  await new Promise<void>((resolve) => child.once('close', () => resolve()))
  const killed = inspect(sigkillDb)
  assert.equal(killed.targetRows, 157)
  assert.equal(killed.derived, 0)
  assert.equal(killed.receipts, 0)
  assert.deepEqual(killed.receiptStatuses, [])
  assert.equal(killed.quickCheck, 'ok')

  const concurrentDb = copy('concurrent-reader')
  const concurrentMarker = path.join(root, 'concurrent-ready')
  const concurrentChild = spawn(process.execPath, command(concurrentDb, 'apply', [
    '--fail-at', 'delay-after-source-insert', '--marker', concurrentMarker,
  ]), { cwd: process.cwd(), stdio: 'ignore' })
  const concurrentClosed = new Promise<void>((resolve) => concurrentChild.once('close', () => resolve()))
  await waitForFile(concurrentMarker, 10_000)
  const reader = new DatabaseSync(concurrentDb, { readOnly: true })
  const observed = new Set<number>()
  while (concurrentChild.exitCode == null) {
    observed.add((reader.prepare('SELECT COUNT(*) AS count FROM ohlcv_daily WHERE date=?')
      .get(targetDate) as { count: number }).count)
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  reader.close()
  await concurrentClosed
  observed.add(inspect(concurrentDb).targetRows)
  assert.deepEqual([...observed].sort((left, right) => left - right), [157, 4_218])

  console.log('JP local repair transaction tests passed')
}

main().then(() => {
  if (process.env.KEEP_JP_REPAIR_FIXTURE === '1') console.log(`fixture=${root}`)
  else fs.rmSync(root, { recursive: true, force: true })
}).catch((error) => {
  console.error(error)
  process.exitCode = 1
})
