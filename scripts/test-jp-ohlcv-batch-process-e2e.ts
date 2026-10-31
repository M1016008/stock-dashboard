import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { createClient, type Client } from '@libsql/client'
import { applyJpOhlcvIngestionBoundary } from '@/lib/jp-ohlcv-ingestion-boundary'
import {
  initializeJpOhlcvCoverageStore,
  publishJpOhlcvSourceRun,
} from '@/lib/jp-ohlcv-coverage-store'
import { getJpTradingDates } from '@/lib/server/jp-market-calendar'
import type { JpOfficialOhlcvValue } from '@/lib/jp-ohlcv-data-quality'
import { stableSha256 } from '@/lib/jp-ohlcv-data-quality'

const TARGET_DATE = '2026-10-30'
const tickers = ['1306', '7003', '1447', '2164'] as const

type Fixture = {
  directory: string
  databasePath: string
  scenarioPath: string
  fakeBin: string
  client: Client
  bootstrapRunId: number
  previousSuccessfulRunId: number | null
}

type ProcessResult = {
  status: number | null
  signal: NodeJS.Signals | null
  stdout: string
  stderr: string
}

function officialRows(date: string, adjustmentFactor = 1): JpOfficialOhlcvValue[] {
  return [
    { ticker: '1306', date, open: 400, high: 410, low: 399, close: 407.9, volume: 10, adjustmentFactor },
    { ticker: '7003', date, open: 4400, high: 4500, low: 4300, close: 4434, volume: 20, adjustmentFactor },
    { ticker: '1447', date, open: 273.7, high: 285.1, low: 267, close: 270.4, volume: 30, adjustmentFactor },
    { ticker: '2164', date, open: 113, high: 113, low: 105, close: 108.3, volume: 40, adjustmentFactor },
  ]
}

function providerRows(date: string, adjustmentFactor = 1): Array<Record<string, unknown>> {
  return officialRows(date, adjustmentFactor).map((row) => ({
    Date: date,
    Code: `${row.ticker}0`,
    O: row.open,
    H: row.high,
    L: row.low,
    C: row.close,
    Vo: row.volume,
    Va: row.close * row.volume,
    AdjFactor: row.adjustmentFactor,
    AdjO: row.open,
    AdjH: row.high,
    AdjL: row.low,
    AdjC: row.close,
    AdjVo: row.volume,
    UL: null,
    LL: null,
  }))
}

async function createSchema(client: Client): Promise<void> {
  await client.executeMultiple(`
    CREATE TABLE ticker_universe (
      ticker TEXT PRIMARY KEY, active INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE ohlcv_daily (
      ticker TEXT NOT NULL, date TEXT NOT NULL, open REAL NOT NULL, high REAL NOT NULL,
      low REAL NOT NULL, close REAL NOT NULL, volume INTEGER NOT NULL,
      PRIMARY KEY (ticker, date)
    );
    CREATE INDEX ohlcv_date_idx ON ohlcv_daily(date);
    CREATE TABLE batch_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT, job_type TEXT NOT NULL, started_at INTEGER NOT NULL,
      finished_at INTEGER, status TEXT NOT NULL, total_tickers INTEGER,
      succeeded INTEGER DEFAULT 0, failed INTEGER DEFAULT 0, rows_inserted INTEGER DEFAULT 0,
      error_summary TEXT
    );
    CREATE TABLE jquants_sync_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT, target_date TEXT NOT NULL, api_type TEXT NOT NULL,
      expected_rows INTEGER NOT NULL DEFAULT 0, imported_rows INTEGER NOT NULL DEFAULT 0,
      missing_tickers TEXT, status TEXT NOT NULL, started_at INTEGER NOT NULL DEFAULT (unixepoch()),
      finished_at INTEGER, error_summary TEXT
    );
    CREATE TABLE jquants_daily_coverage (
      date TEXT PRIMARY KEY, expected_rows INTEGER NOT NULL, imported_at INTEGER NOT NULL
    );
  `)
  await initializeJpOhlcvCoverageStore(client)
  for (const ticker of tickers) {
    await client.execute({ sql: 'INSERT INTO ticker_universe(ticker,active) VALUES(?,1)', args: [ticker] })
  }
}

async function insertRows(client: Client, rows: readonly JpOfficialOhlcvValue[]): Promise<void> {
  for (const row of rows) {
    await client.execute({
      sql: `INSERT INTO ohlcv_daily(ticker,date,open,high,low,close,volume)
            VALUES(?,?,?,?,?,?,?)`,
      args: [row.ticker, row.date, row.open, row.high, row.low, row.close, row.volume],
    })
  }
}

async function createFixture(input: {
  targetPresent?: boolean
  knownConflicts?: boolean
} = {}): Promise<Fixture> {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'jp-ohlcv-process-e2e-'))
  const databasePath = path.join(directory, 'fixture.sqlite')
  const scenarioPath = path.join(directory, 'provider.json')
  const fakeBin = path.join(directory, 'bin')
  fs.mkdirSync(fakeBin)
  const fakeNpx = path.join(fakeBin, 'npx')
  fs.writeFileSync(fakeNpx, `#!/bin/sh
case "$OHLCV_E2E_REFRESH_MODE" in
  success) sleep 1; exit 0 ;;
  fail) sleep 1; exit 37 ;;
  kill-parent)
    sleep 1
    (exec 0</dev/null 1>/dev/null 2>&1; sleep 30) &
    kill -KILL "$JP_OHLCV_BATCH_PARENT_PID"
    kill -KILL "$PPID"
    exit 137
    ;;
  kill-wrapper)
    (exec 0</dev/null 1>/dev/null 2>&1; sleep 30) &
    echo $! > "$OHLCV_E2E_ORPHAN_PID_PATH"
    kill -KILL "$PPID"
    exit 137
    ;;
  *) exit 38 ;;
esac
`)
  fs.chmodSync(fakeNpx, 0o755)
  const client = createClient({ url: `file:${databasePath}` })
  await createSchema(client)

  const calendar = getJpTradingDates('2026-09-01', TARGET_DATE).slice(-21)
  assert.equal(calendar.at(-1), TARGET_DATE)
  for (const date of calendar.slice(0, -1)) await insertRows(client, officialRows(date))
  if (input.targetPresent) await insertRows(client, officialRows(TARGET_DATE))

  const bootstrapDate = calendar[0]
  let previousSuccessfulRunId: number | null = null
  if (input.knownConflicts) {
    await client.execute({
      sql: `INSERT INTO batch_runs(job_type,started_at,finished_at,status)
            VALUES('ohlcv_fetch:jquants',1,2,'success')`,
      args: [],
    })
    previousSuccessfulRunId = Number((await client.execute('SELECT last_insert_rowid() AS id')).rows[0].id)
    await client.execute({
      sql: "UPDATE ohlcv_daily SET close=close-0.2 WHERE date=? AND ticker IN ('1447','2164')",
      args: [bootstrapDate],
    })
  }
  const run = await client.execute({
    sql: `INSERT INTO batch_runs(job_type,started_at,status)
          VALUES('ohlcv_fetch:jquants',unixepoch(),'running') RETURNING id`,
    args: [],
  })
  const bootstrapRunId = Number(run.rows[0].id)
  const sync = await client.execute({
    sql: `INSERT INTO jquants_sync_runs(target_date,api_type,status)
          VALUES(?,'equities/bars/daily:date','running') RETURNING id`,
    args: [bootstrapDate],
  })
  const boundary = await applyJpOhlcvIngestionBoundary(client, {
    sourceRunId: bootstrapRunId,
    targetDate: bootstrapDate,
    officialRows: officialRows(bootstrapDate),
    bootstrapPreservedConflictTickers: input.knownConflicts ? ['1447', '2164'] : [],
    requireRunningBatchRun: true,
  })
  if (input.knownConflicts) {
    assert.equal(boundary.sourcePublication, 'PARTIAL_HOLD')
    await client.execute({
      sql: "UPDATE batch_runs SET status='partial',finished_at=unixepoch() WHERE id=?",
      args: [bootstrapRunId],
    })
    await client.execute({
      sql: "UPDATE jquants_sync_runs SET status='partial',finished_at=unixepoch() WHERE id=?",
      args: [Number(sync.rows[0].id)],
    })
  } else {
    assert.equal(boundary.sourcePublication, 'PUBLISHABLE')
    await publishJpOhlcvSourceRun(client, {
      sourceRunId: bootstrapRunId,
      targetDate: bootstrapDate,
      totalTickers: tickers.length,
      succeeded: tickers.length,
      failed: 0,
      rowsInserted: 0,
      errorSummary: '[]',
      syncRun: {
        id: Number(sync.rows[0].id),
        expectedRows: tickers.length,
        importedRows: tickers.length,
        missingTickersJson: '[]',
      },
    })
    previousSuccessfulRunId = bootstrapRunId
  }
  return { directory, databasePath, scenarioPath, fakeBin, client, bootstrapRunId, previousSuccessfulRunId }
}

function childEnvironment(fixture: Fixture, refreshMode = 'success'): NodeJS.ProcessEnv {
  const preloader = pathToFileURL(path.resolve('scripts/fixtures/jp-ohlcv-process-fetch-mock.mjs')).href
  return {
    ...process.env,
    NODE_ENV: 'test',
    NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --import=${preloader}`.trim(),
    PATH: `${fixture.fakeBin}:${process.env.PATH ?? ''}`,
    USE_LOCAL_DB: '1',
    SKIP_SCHEMA_ENSURE: '1',
    EXTERNAL_STORAGE_REQUIRED: 'false',
    STOCKBOARD_DB_PATH: fixture.databasePath,
    STOCKBOARD_JP_OHLCV_REPAIR_LOCK_PATH: path.join(fixture.directory, 'absent-repair.lock'),
    JQUANTS_API_KEY: 'process-e2e-fixture-key',
    JP_OHLCV_PROCESS_E2E_PROVIDER_SCENARIO: fixture.scenarioPath,
    OHLCV_TARGET_DATE: TARGET_DATE,
    OHLCV_MAX_RETRIES: '1',
    OHLCV_CONCURRENCY: '1',
    OHLCV_COVERAGE_LOOKBACK_TRADING_DAYS: '20',
    POST_OHLCV_REFRESH: '1',
    OHLCV_E2E_REFRESH_MODE: refreshMode,
  }
}

function runScript(script: string, args: string[], environment: NodeJS.ProcessEnv): ProcessResult {
  return spawnSync(process.execPath, ['--import', 'tsx', script, ...args], {
    cwd: process.cwd(),
    env: environment,
    encoding: 'utf8',
    timeout: Number(environment.OHLCV_E2E_PROCESS_TIMEOUT_MS ?? 30_000),
  })
}

function runBatch(fixture: Fixture, input: {
  providerStatus?: number
  adjustmentFactor?: number
  refreshMode?: string
  environment?: Partial<NodeJS.ProcessEnv>
  scenario?: Record<string, unknown>
} = {}): ProcessResult {
  fs.writeFileSync(fixture.scenarioPath, JSON.stringify({
    status: input.providerStatus ?? 200,
    rows: providerRows(TARGET_DATE, input.adjustmentFactor ?? 1),
    ...input.scenario,
  }))
  return runScript('scripts/batch-ohlcv.ts', [], {
    ...childEnvironment(fixture, input.refreshMode ?? 'success'),
    ...input.environment,
  })
}

function spawnBatch(fixture: Fixture, input: {
  environment?: Partial<NodeJS.ProcessEnv>
  scenario: Record<string, unknown>
}): { child: ReturnType<typeof spawn>; completion: Promise<ProcessResult> } {
  fs.writeFileSync(fixture.scenarioPath, JSON.stringify({
    status: 200,
    rows: providerRows(TARGET_DATE),
    ...input.scenario,
  }))
  const child = spawn(process.execPath, ['--import', 'tsx', 'scripts/batch-ohlcv.ts'], {
    cwd: process.cwd(),
    env: { ...childEnvironment(fixture), ...input.environment },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout = ''
  let stderr = ''
  child.stdout?.on('data', (chunk) => { stdout += String(chunk) })
  child.stderr?.on('data', (chunk) => { stderr += String(chunk) })
  const completion = new Promise<ProcessResult>((resolve, reject) => {
    child.once('error', reject)
    child.once('close', (status, signal) => resolve({ status, signal, stdout, stderr }))
  })
  return { child, completion }
}

async function waitForFile(filePath: string): Promise<void> {
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    if (fs.existsSync(filePath)) return
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error(`fixture_file_timeout:${filePath}`)
}

async function latestRun(client: Client): Promise<Record<string, unknown>> {
  const result = await client.execute(
    "SELECT * FROM batch_runs WHERE job_type='ohlcv_fetch:jquants' ORDER BY id DESC LIMIT 1",
  )
  assert.ok(result.rows[0])
  return result.rows[0] as Record<string, unknown>
}

async function latestSuccessfulRunId(client: Client): Promise<number | null> {
  const result = await client.execute(
    "SELECT id FROM batch_runs WHERE job_type='ohlcv_fetch:jquants' AND status='success' ORDER BY id DESC LIMIT 1",
  )
  return result.rows[0] ? Number(result.rows[0].id) : null
}

async function targetRowCount(client: Client): Promise<number> {
  const result = await client.execute({
    sql: 'SELECT COUNT(*) AS count FROM ohlcv_daily WHERE date=?', args: [TARGET_DATE],
  })
  return Number(result.rows[0].count)
}

async function tableRowSha256(client: Client, sql: string): Promise<string> {
  const result = await client.execute(sql)
  return stableSha256(result.rows.map((row) => ({ ...row })))
}

async function receiptCount(client: Client): Promise<number> {
  const result = await client.execute('SELECT COUNT(*) AS count FROM jp_ohlcv_ingestion_receipts')
  return Number(result.rows[0].count)
}

async function coverageHeadSha256(client: Client): Promise<string> {
  return tableRowSha256(client, 'SELECT * FROM jp_ohlcv_coverage_heads ORDER BY scope')
}

async function terminateProcessGroup(processGroupId: number): Promise<void> {
  process.kill(-processGroupId, 'SIGKILL')
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    try {
      process.kill(-processGroupId, 0)
      await new Promise((resolve) => setTimeout(resolve, 25))
    } catch {
      return
    }
  }
  throw new Error(`fixture_child_group_did_not_exit:${processGroupId}`)
}

async function cleanup(fixture: Fixture): Promise<void> {
  fixture.client.close()
  fs.rmSync(fixture.directory, { recursive: true, force: true })
}

async function normalZeroInsert(): Promise<void> {
  const fixture = await createFixture({ targetPresent: true })
  try {
    const receiptsBefore = await receiptCount(fixture.client)
    const targetBefore = await tableRowSha256(
      fixture.client,
      `SELECT * FROM ohlcv_daily WHERE date='${TARGET_DATE}' ORDER BY ticker`,
    )
    const result = runBatch(fixture)
    assert.equal(result.status, 0, result.stderr)
    const run = await latestRun(fixture.client)
    assert.equal(run.status, 'success')
    assert.equal(Number(run.rows_inserted), 0)
    assert.equal(await receiptCount(fixture.client), receiptsBefore + 1)
    const sync = (await fixture.client.execute(
      'SELECT status,imported_rows FROM jquants_sync_runs ORDER BY id DESC LIMIT 1',
    )).rows[0]
    assert.equal(sync.status, 'success')
    assert.equal(Number(sync.imported_rows), tickers.length)
    assert.equal(await tableRowSha256(
      fixture.client,
      `SELECT * FROM ohlcv_daily WHERE date='${TARGET_DATE}' ORDER BY ticker`,
    ), targetBefore)
    const head = (await fixture.client.execute(
      'SELECT source_run_id FROM jp_ohlcv_coverage_heads ORDER BY scope LIMIT 1',
    )).rows[0]
    assert.equal(Number(head.source_run_id), Number(run.id))
    assert.equal(Number((await fixture.client.execute({
      sql: 'SELECT COUNT(*) AS count FROM jquants_daily_coverage WHERE date=?', args: [TARGET_DATE],
    })).rows[0].count), 1)
  } finally { await cleanup(fixture) }
}

async function knownConflictsRemainPartial(): Promise<void> {
  const fixture = await createFixture({ targetPresent: true, knownConflicts: true })
  try {
    const conflictRowsBefore = await tableRowSha256(
      fixture.client,
      "SELECT * FROM ohlcv_daily WHERE ticker IN ('1447','2164') ORDER BY ticker,date",
    )
    const result = runBatch(fixture)
    assert.equal(result.status, 1)
    assert.match(result.stderr, /source publication held: jp_ohlcv_source_publication_hold:PARTIAL_HOLD/)
    assert.equal((await latestRun(fixture.client)).status, 'partial')
    assert.equal(await latestSuccessfulRunId(fixture.client), fixture.previousSuccessfulRunId)
    assert.equal(await tableRowSha256(
      fixture.client,
      "SELECT * FROM ohlcv_daily WHERE ticker IN ('1447','2164') ORDER BY ticker,date",
    ), conflictRowsBefore)
  } finally { await cleanup(fixture) }
}

async function providerRevisionDoesNotOverwrite(): Promise<void> {
  const fixture = await createFixture({ targetPresent: true })
  try {
    const targetBefore = await tableRowSha256(
      fixture.client,
      `SELECT * FROM ohlcv_daily WHERE date='${TARGET_DATE}' ORDER BY ticker`,
    )
    const revised = providerRows(TARGET_DATE)
    revised[0] = { ...revised[0], C: 999, AdjC: 999 }
    const result = runBatch(fixture, { scenario: { rows: revised } })
    assert.equal(result.status, 1)
    assert.match(result.stderr, /jp_ohlcv_new_value_conflict:1306:2026-10-30/)
    assert.equal((await latestRun(fixture.client)).status, 'partial')
    assert.equal(await tableRowSha256(
      fixture.client,
      `SELECT * FROM ohlcv_daily WHERE date='${TARGET_DATE}' ORDER BY ticker`,
    ), targetBefore)
  } finally { await cleanup(fixture) }
}

async function providerFailure(): Promise<void> {
  const fixture = await createFixture()
  try {
    const receiptsBefore = await receiptCount(fixture.client)
    const result = runBatch(fixture, { providerStatus: 503 })
    assert.equal(result.status, 1)
    assert.match(result.stderr, /OHLCV date bulk failed closed/)
    assert.equal((await latestRun(fixture.client)).status, 'failed')
    assert.equal(await targetRowCount(fixture.client), 0)
    assert.equal(await receiptCount(fixture.client), receiptsBefore)
  } finally { await cleanup(fixture) }
}

async function corporateActionHold(): Promise<void> {
  const fixture = await createFixture()
  try {
    const headBefore = await coverageHeadSha256(fixture.client)
    const result = runBatch(fixture, { adjustmentFactor: 2 })
    assert.equal(result.status, 1)
    assert.match(result.stderr, /corporate_action_requires_approved_history_boundary/)
    assert.equal(await targetRowCount(fixture.client), 0)
    assert.equal(await coverageHeadSha256(fixture.client), headBefore)
  } finally { await cleanup(fixture) }
}

async function fallbackRejectedBeforeRun(): Promise<void> {
  const fixture = await createFixture()
  try {
    const before = Number((await fixture.client.execute('SELECT COUNT(*) AS count FROM batch_runs')).rows[0].count)
    const result = runBatch(fixture, { environment: { OHLCV_ENABLE_MISSING_FALLBACK: '1' } })
    assert.equal(result.status, 1)
    assert.match(result.stderr, /normal_updater_requires_date_bulk_boundary/)
    const after = Number((await fixture.client.execute('SELECT COUNT(*) AS count FROM batch_runs')).rows[0].count)
    assert.equal(after, before)
  } finally { await cleanup(fixture) }
}

async function coverageCasFailure(): Promise<void> {
  const fixture = await createFixture()
  try {
    const headBefore = await coverageHeadSha256(fixture.client)
    const receiptsBefore = await receiptCount(fixture.client)
    await fixture.client.execute(`CREATE TRIGGER process_e2e_fail_coverage_cas
      BEFORE UPDATE ON jp_ohlcv_coverage_heads
      BEGIN SELECT RAISE(ABORT, 'process_e2e_coverage_cas_failed'); END`)
    const result = runBatch(fixture)
    assert.equal(result.status, 1)
    assert.match(result.stderr, /OHLCV date bulk failed closed/)
    assert.equal(await targetRowCount(fixture.client), 0)
    assert.equal((await latestRun(fixture.client)).status, 'failed')
    assert.equal(await coverageHeadSha256(fixture.client), headBefore)
    assert.equal(await receiptCount(fixture.client), receiptsBefore)
  } finally { await cleanup(fixture) }
}

async function derivedRefreshFailure(): Promise<void> {
  const fixture = await createFixture()
  try {
    const result = runBatch(fixture, { refreshMode: 'fail' })
    assert.equal(result.status, 1)
    assert.match(result.stderr, /post-refresh failed/)
    assert.equal(await targetRowCount(fixture.client), tickers.length)
    assert.equal((await latestRun(fixture.client)).status, 'partial')
    assert.equal(await latestSuccessfulRunId(fixture.client), fixture.previousSuccessfulRunId)
    assert.equal((await fixture.client.execute(
      'SELECT status FROM jquants_sync_runs ORDER BY id DESC LIMIT 1',
    )).rows[0].status, 'partial')
    assert.equal(Number((await fixture.client.execute({
      sql: 'SELECT COUNT(*) AS count FROM jquants_daily_coverage WHERE date=?', args: [TARGET_DATE],
    })).rows[0].count), 0)
  } finally { await cleanup(fixture) }
}

async function publicationFailure(): Promise<void> {
  const fixture = await createFixture()
  try {
    await fixture.client.execute(`CREATE TRIGGER process_e2e_fail_publication
      BEFORE INSERT ON jquants_daily_coverage WHEN NEW.date='${TARGET_DATE}'
      BEGIN SELECT RAISE(ABORT, 'process_e2e_publication_failed'); END`)
    const result = runBatch(fixture)
    assert.equal(result.status, 1)
    assert.match(result.stderr, /source_publication_failed/)
    assert.equal(await targetRowCount(fixture.client), tickers.length)
    assert.equal((await latestRun(fixture.client)).status, 'partial')
    assert.equal(await latestSuccessfulRunId(fixture.client), fixture.previousSuccessfulRunId)
    assert.equal((await fixture.client.execute(
      'SELECT status FROM jquants_sync_runs ORDER BY id DESC LIMIT 1',
    )).rows[0].status, 'partial')
    assert.equal(Number((await fixture.client.execute({
      sql: 'SELECT COUNT(*) AS count FROM jquants_daily_coverage WHERE date=?', args: [TARGET_DATE],
    })).rows[0].count), 0)
  } finally { await cleanup(fixture) }
}

async function crashRecoveryAndRerun(): Promise<void> {
  const fixture = await createFixture()
  try {
    const priorSuccessSha = await tableRowSha256(
      fixture.client,
      "SELECT * FROM batch_runs WHERE status='success' ORDER BY id",
    )
    const receiptsBefore = await receiptCount(fixture.client)
    const crashed = runBatch(fixture, { refreshMode: 'kill-parent' })
    assert.equal(crashed.signal, 'SIGKILL')
    assert.equal(await targetRowCount(fixture.client), tickers.length)
    const running = await latestRun(fixture.client)
    const runningId = Number(running.id)
    assert.equal(running.status, 'running')
    assert.equal(await latestSuccessfulRunId(fixture.client), fixture.previousSuccessfulRunId)
    const headAfterCrash = await coverageHeadSha256(fixture.client)
    const targetAfterCrash = await tableRowSha256(
      fixture.client,
      `SELECT * FROM ohlcv_daily WHERE date='${TARGET_DATE}' ORDER BY ticker`,
    )
    assert.equal(await receiptCount(fixture.client), receiptsBefore + 1)

    const blocked = runBatch(fixture)
    assert.equal(blocked.status, 1)
    assert.match(blocked.stderr, new RegExp(`running_source_run_recovery_required:${runningId}`))
    assert.equal(Number((await latestRun(fixture.client)).id), runningId)

    const environment = childEnvironment(fixture)
    const status = runScript('scripts/recover-jp-ohlcv-running-source-run.ts', ['status', String(runningId)], environment)
    assert.equal(status.status, 0, status.stderr)
    const active = JSON.parse(status.stdout) as {
      disposition: string
      statusSha256: string
      activeChildPid: number
      activeChildProcessGroupId: number
      syncRunId: number
    }
    assert.equal(active.disposition, 'HOLD_WRITER_ACTIVE')
    assert.ok(active.activeChildPid > 0)
    assert.equal(active.activeChildProcessGroupId, active.activeChildPid)
    const refused = runScript(
      'scripts/recover-jp-ohlcv-running-source-run.ts',
      ['hold', String(runningId), active.statusSha256],
      environment,
    )
    assert.equal(refused.status, 1)
    assert.match(refused.stderr, /recovery_not_permitted:HOLD_WRITER_ACTIVE/)

    await terminateProcessGroup(active.activeChildProcessGroupId)
    const safeStatus = runScript(
      'scripts/recover-jp-ohlcv-running-source-run.ts',
      ['status', String(runningId)],
      environment,
    )
    assert.equal(safeStatus.status, 0, safeStatus.stderr)
    const evidence = JSON.parse(safeStatus.stdout) as { disposition: string; statusSha256: string }
    assert.equal(evidence.disposition, 'RECOVERABLE_POST_RECEIPT_TO_PARTIAL')
    const recovered = runScript(
      'scripts/recover-jp-ohlcv-running-source-run.ts',
      ['hold', String(runningId), evidence.statusSha256],
      environment,
    )
    assert.equal(recovered.status, 0, recovered.stderr)
    assert.equal((await fixture.client.execute({
      sql: 'SELECT status FROM batch_runs WHERE id=?', args: [runningId],
    })).rows[0].status, 'partial')
    assert.equal(await latestSuccessfulRunId(fixture.client), fixture.previousSuccessfulRunId)
    assert.equal(await tableRowSha256(
      fixture.client,
      "SELECT * FROM batch_runs WHERE status='success' ORDER BY id",
    ), priorSuccessSha)
    assert.equal(await coverageHeadSha256(fixture.client), headAfterCrash)
    assert.equal(await tableRowSha256(
      fixture.client,
      `SELECT * FROM ohlcv_daily WHERE date='${TARGET_DATE}' ORDER BY ticker`,
    ), targetAfterCrash)
    assert.equal(await receiptCount(fixture.client), receiptsBefore + 1)
    assert.equal((await fixture.client.execute({
      sql: 'SELECT status FROM jquants_sync_runs WHERE id=?', args: [active.syncRunId],
    })).rows[0].status, 'partial')

    const duplicate = runScript(
      'scripts/recover-jp-ohlcv-running-source-run.ts',
      ['hold', String(runningId), evidence.statusSha256],
      environment,
    )
    assert.equal(duplicate.status, 1)
    assert.match(duplicate.stderr, /recovery_status_changed|recovery_not_permitted/)

    const rerun = runBatch(fixture)
    assert.equal(rerun.status, 0, rerun.stderr)
    const published = await latestRun(fixture.client)
    assert.equal(published.status, 'success')
    assert.equal(Number(published.rows_inserted), 0)
  } finally { await cleanup(fixture) }
}

async function preReceiptCrashRecovery(): Promise<void> {
  const fixture = await createFixture()
  try {
    const headBefore = await coverageHeadSha256(fixture.client)
    const receiptBefore = await receiptCount(fixture.client)
    const targetBefore = await targetRowCount(fixture.client)
    const waitMarker = path.join(fixture.directory, 'provider-requested')
    const releaseMarker = path.join(fixture.directory, 'provider-release-never-created')
    const crashed = runBatch(fixture, {
      scenario: { waitMarker, releaseMarker },
      environment: { OHLCV_E2E_PROCESS_TIMEOUT_MS: '1500', TZ: 'Asia/Tokyo' },
    })
    assert.equal(crashed.signal, 'SIGTERM')
    assert.ok(fs.existsSync(waitMarker))
    const running = await latestRun(fixture.client)
    const runningId = Number(running.id)
    assert.equal(running.status, 'running')

    const environment = childEnvironment(fixture)
    const probeFailure = runScript(
      'scripts/recover-jp-ohlcv-running-source-run.ts',
      ['status', String(runningId)],
      { ...environment, JP_OHLCV_TEST_PROCESS_PROBE_MODE: 'INVALID_PS_OPTION', TZ: 'UTC' },
    )
    assert.equal(probeFailure.status, 0, probeFailure.stderr)
    assert.equal((JSON.parse(probeFailure.stdout) as { disposition: string }).disposition, 'HOLD_IDENTITY_MISMATCH')
    const status = runScript(
      'scripts/recover-jp-ohlcv-running-source-run.ts',
      ['status', String(runningId)],
      { ...environment, TZ: 'UTC' },
    )
    assert.equal(status.status, 0, status.stderr)
    const evidence = JSON.parse(status.stdout) as { disposition: string; statusSha256: string }
    assert.equal(evidence.disposition, 'RECOVERABLE_PRE_RECEIPT_TO_PARTIAL')
    const recovered = runScript(
      'scripts/recover-jp-ohlcv-running-source-run.ts',
      ['hold', String(runningId), evidence.statusSha256],
      environment,
    )
    assert.equal(recovered.status, 0, recovered.stderr)
    assert.equal(await coverageHeadSha256(fixture.client), headBefore)
    assert.equal(await receiptCount(fixture.client), receiptBefore)
    assert.equal(await targetRowCount(fixture.client), targetBefore)
    assert.equal((await latestRun(fixture.client)).status, 'partial')

    const rerun = runBatch(fixture)
    assert.equal(rerun.status, 0, rerun.stderr)
  } finally { await cleanup(fixture) }
}

async function liveOwnerIdentityIsTimezoneStable(): Promise<void> {
  const fixture = await createFixture()
  let child: ReturnType<typeof spawn> | null = null
  try {
    const waitMarker = path.join(fixture.directory, 'provider-requested-live-owner')
    const spawned = spawnBatch(fixture, {
      scenario: {
        waitMarker,
        releaseMarker: path.join(fixture.directory, 'provider-release-never-created'),
        waitTimeoutMs: 30_000,
      },
      environment: { TZ: 'Asia/Tokyo' },
    })
    child = spawned.child
    await waitForFile(waitMarker)
    const runningId = Number((await latestRun(fixture.client)).id)
    const status = runScript(
      'scripts/recover-jp-ohlcv-running-source-run.ts',
      ['status', String(runningId)],
      { ...childEnvironment(fixture), TZ: 'UTC' },
    )
    assert.equal(status.status, 0, status.stderr)
    assert.equal((JSON.parse(status.stdout) as { disposition: string }).disposition, 'HOLD_WRITER_ACTIVE')

    child.kill('SIGTERM')
    const terminated = await spawned.completion
    assert.equal(terminated.signal, 'SIGTERM')
    child = null
    const recoverable = runScript(
      'scripts/recover-jp-ohlcv-running-source-run.ts',
      ['status', String(runningId)],
      childEnvironment(fixture),
    )
    const evidence = JSON.parse(recoverable.stdout) as { disposition: string; statusSha256: string }
    assert.equal(evidence.disposition, 'RECOVERABLE_PRE_RECEIPT_TO_PARTIAL')
    const held = runScript(
      'scripts/recover-jp-ohlcv-running-source-run.ts',
      ['hold', String(runningId), evidence.statusSha256],
      childEnvironment(fixture),
    )
    assert.equal(held.status, 0, held.stderr)
  } finally {
    if (child?.pid) child.kill('SIGKILL')
    await cleanup(fixture)
  }
}

async function wrapperCrashDoesNotLeaveUntrackedDescendant(): Promise<void> {
  const fixture = await createFixture()
  try {
    const orphanPidPath = path.join(fixture.directory, 'orphan.pid')
    const failed = runBatch(fixture, {
      refreshMode: 'kill-wrapper',
      environment: { OHLCV_E2E_ORPHAN_PID_PATH: orphanPidPath },
    })
    assert.equal(failed.status, 1)
    assert.match(failed.stderr, /post-refresh failed/)
    const orphanPid = Number(fs.readFileSync(orphanPidPath, 'utf8').trim())
    assert.ok(orphanPid > 0)
    assert.throws(() => process.kill(orphanPid, 0))
    assert.equal((await latestRun(fixture.client)).status, 'partial')
    const rerun = runBatch(fixture)
    assert.equal(rerun.status, 0, rerun.stderr)
  } finally { await cleanup(fixture) }
}

async function recoveryRejectsChangedPriorSuccess(): Promise<void> {
  const fixture = await createFixture()
  try {
    const waitMarker = path.join(fixture.directory, 'provider-requested')
    const crashed = runBatch(fixture, {
      scenario: {
        waitMarker,
        releaseMarker: path.join(fixture.directory, 'provider-release-never-created'),
      },
      environment: { OHLCV_E2E_PROCESS_TIMEOUT_MS: '1500' },
    })
    assert.equal(crashed.signal, 'SIGTERM')
    const runningId = Number((await latestRun(fixture.client)).id)
    assert.ok(fixture.previousSuccessfulRunId)
    await fixture.client.execute({
      sql: 'UPDATE batch_runs SET error_summary=? WHERE id=?',
      args: ['externally-changed', fixture.previousSuccessfulRunId!],
    })
    const status = runScript(
      'scripts/recover-jp-ohlcv-running-source-run.ts',
      ['status', String(runningId)],
      childEnvironment(fixture),
    )
    assert.equal(status.status, 0, status.stderr)
    const evidence = JSON.parse(status.stdout) as { disposition: string; reasons: string[] }
    assert.equal(evidence.disposition, 'HOLD_AFTER_STATE_CHANGED')
    assert.deepEqual(evidence.reasons, ['previous_successful_source_changed'])
  } finally { await cleanup(fixture) }
}

async function main(): Promise<void> {
  await normalZeroInsert()
  await knownConflictsRemainPartial()
  await providerRevisionDoesNotOverwrite()
  await providerFailure()
  await corporateActionHold()
  await fallbackRejectedBeforeRun()
  await coverageCasFailure()
  await derivedRefreshFailure()
  await publicationFailure()
  await preReceiptCrashRecovery()
  await liveOwnerIdentityIsTimezoneStable()
  await wrapperCrashDoesNotLeaveUntrackedDescendant()
  await recoveryRejectsChangedPriorSuccess()
  await crashRecoveryAndRerun()
  console.log('JP OHLCV batch process E2E: PASS')
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
