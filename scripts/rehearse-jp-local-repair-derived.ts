import { execFileSync, spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
// @ts-expect-error Node 24 ships node:sqlite; the repository pins older Node type declarations.
import { DatabaseSync } from 'node:sqlite'
import { ML_PHYSICS_FEATURE_SET } from '@/lib/backtest/ml-physics'
import {
  applyJpOhlcvRepairTransaction,
  chunkJpOhlcvRepairTickers,
  completeJpOhlcvRepairDerived,
  createJpOhlcvRepairPlan,
  identifyJpOhlcvDatabaseContent,
  inspectJpOhlcvRepairMlCoverage,
  jpOhlcvValueSha256,
  type JpOhlcvOfficialRow,
  type JpOhlcvRepairPlan,
} from '@/lib/jp-ohlcv-local-repair'
import { summarizeOpenJpOhlcvCoverageIssues } from '@/lib/jp-ohlcv-coverage'
import { sameJpOhlcvRow } from '@/lib/jp-ohlcv-repair-policy'
import {
  JP_REPAIR_FINAL_VALIDATION_RECEIPT_NAME,
  assertJpRepairExecutionCommit,
  verifyExistingJpRepairFinalValidationReceipt,
  verifyJpRepairPlanBinding,
  type JpRepairFinalValidationReceipt,
} from '@/lib/jp-ohlcv-repair-production'
import type { JpRepairWorkflowContext } from '@/lib/jp-ohlcv-repair-executor'
import {
  JP_REPAIR_ANALOG_BASENAME,
  JP_REPAIR_ANALOG_CONTRACT,
  JP_REPAIR_SERVING_CACHE_BASENAME,
  JP_REPAIR_STAGE_UNSET_ENVIRONMENT,
  assertJpRepairAnalogMeta,
  jpRepairStageEnvironment,
} from '@/lib/jp-ohlcv-repair-stage-environment'
import {
  jpRepairNodeModulesLockSha256,
  jpRepairRuntimeSourceTreeSha256,
} from '@/lib/jp-ohlcv-repair-runtime-manifest'

type OfficialEvidence = {
  date: string
  priceBasis: 'jquants-adjusted-ohlcv-v1'
  sourceContract: {
    contentSha256: string
    providerRows: number
    acceptedRows: number
    noTradeRows: number
    unexpectedRejectedRows: number
  }
  rows: JpOhlcvOfficialRow[]
}

type StageReceipt = {
  name: string
  command: string[]
  sealedFiles: Array<{ path: string; sha256: string }>
  startedAt: string
  finishedAt: string
  durationMs: number
  status: 'PASS' | 'FAIL'
  exitCode: number | null
  signal: NodeJS.Signals | null
  rssBytesPeak: number
  databaseBytesBefore: number
  databaseBytesAfter: number
  walBytesBefore: number
  walBytesAfter: number
  walBytesPeak: number
  allocatedBytesBefore: number
  allocatedBytesAfter: number
  allocatedBytesPeak: number
  observedRows: Record<string, number>
  stdoutTail: string
  stderrTail: string
  chunks?: StageChunkReceipt[]
}

type StageChunkReceipt = {
  index: number
  tickerCount: number
  tickersSha256: string
  startedAt: string
  finishedAt: string
  durationMs: number
  status: 'PASS' | 'FAIL'
  exitCode: number | null
  signal: NodeJS.Signals | null
  rssBytesPeak: number
  walBytesPeak: number
  allocatedBytesPeak: number
  stdoutTail: string
  stderrTail: string
}

type StageDefinition = {
  name: string
  command: string[]
  env?: Record<string, string>
  chunks?: Array<{
    env: Record<string, string>
    tickerCount: number
    tickersSha256: string
  }>
}

type ValuationChunkIdentity = {
  tickerCount: number
  tickersSha256: string
}

type Receipt = {
  version: 1
  status: 'RUNNING' | 'DERIVED_PENDING' | 'PASS' | 'HOLD'
  createdAt: string
  updatedAt: string
  database: string
  baseDatabase: string
  metadataDatabase: string
  officialEvidence: string
  // HEAD captured once at initialization; resume and validate-only require it.
  gitCommitSha: string
  sourceTreeSha256: string
  nodeModulesLockSha256: string
  providerEnvelope: { provider: number; accepted: number; noTrade: number; invalid: number }
  source: null | {
    approvalSha256: string
    approved: number
    inserted: number
    conflictsPreserved: number
    receiptId: number
  }
  stages: StageReceipt[]
  // Set durably before a stage command starts, cleared with its stage receipt.
  inFlightStage?: { name: string; startedAt: string }
  // Present only when the run was started by the execution gate.
  executorBindingSha256?: string
  finalChecks?: Record<string, string | number>
  sealedResearch?: Record<string, { count: number; sha256: string }>
  holdReason?: string
  approvalPackageSha256?: string
}

export type Cli = {
  database: string
  base: string
  metadata: string
  official: string
  analog: string
  servingCache: string
  receipt: string
  priceBasisEvidence: string
  reset: boolean
  validateOnly: boolean
  failBeforeStage: string | null
}

type MaintenanceLockHolder = {
  owner: string
  assertActive: () => void
  watch: (onLoss: (error: Error) => void) => () => void
  release: () => Promise<void>
}

const TARGET_DATE = '2026-07-17'
const LATEST_DATE = '2026-10-30'
const VALUATION_CHUNK_SIZE = 500
const TABLES_BY_STAGE: Record<string, string[]> = {
  snapshots: ['daily_snapshots'],
  features_rebuilt: ['feature_snapshots'],
  weekly: ['weekly_ohlcv'],
  monthly: ['monthly_ma_monitor_daily', 'monthly_ma_cluster_daily'],
  technical: ['model_features', 'technical_signals'],
  forward_extrema: ['forward_extrema', 'forward_extrema_date_coverage'],
  backtest: ['serving_backtest_dates', 'serving_backtest_results', 'serving_backtest_summaries'],
  stages: ['stage_transitions'],
  screener: ['stock_screening_serving', 'stock_screening_serving_dates'],
  dashboard: ['dashboard_cache', 'dashboard_trade_signal_cache'],
  two_year: ['dashboard_trade_signal_cache'],
  trigger: ['trigger_evaluation_batches', 'trigger_evaluations'],
  coverage: ['jquants_daily_coverage'],
  weekly_replacement: ['weekly_ohlcv'],
  sector_structure: ['sector_structure_daily'],
  physical_momentum: ['physical_momentum_metrics'],
  technical_rebuilt: ['model_features', 'technical_signals'],
  forward_extrema_complete: ['forward_extrema', 'forward_extrema_date_coverage'],
  forward_returns_rebuilt: ['forward_returns'],
  pattern_stats_rebuilt: ['pattern_stats'],
  signal_stats_rebuilt: ['signal_stats'],
  signal_return_stats_rebuilt: ['signal_return_stats'],
  backtest_260: ['serving_backtest_dates', 'serving_backtest_results', 'serving_backtest_summaries'],
  stages_rebuilt: ['stage_transitions'],
  valuation: ['valuation_daily_serving', 'valuation_serving_checkpoints'],
  screener_rebuilt: ['stock_screening_serving', 'stock_screening_serving_dates'],
  serving_stock: ['serving_stock_metrics', 'serving_stock_move_periods'],
  historical_universe_rebuilt: ['historical_universe'],
  saved_screening_evaluations: ['saved_screening_evaluations', 'saved_screening_evaluation_members'],
  ml_serving_current: [
    'ml_feature_vectors', 'ml_feature_vectors_v2', 'serving_ml_candidates',
    'serving_ml_physics_candidates', 'ml_predictions', 'serving_current_similars',
    'ml_feature_health_checks',
  ],
  dashboard_rebuilt: ['dashboard_cache', 'dashboard_trade_signal_cache'],
  serving_cache_purged: ['dashboard_cache', 'dashboard_trade_signal_cache'],
  trigger_delta: ['trigger_evaluation_batches', 'trigger_evaluations'],
  coverage_verified: ['jquants_daily_coverage'],
  two_year_published: ['dashboard_trade_signal_cache'],
}

function argument(name: string): string | null {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] ?? null : null
}

function required(name: string): string {
  const value = argument(name)
  if (!value) throw new Error(`missing ${name}`)
  return path.resolve(value)
}

function parseCli(): Cli {
  const database = required('--database')
  const directory = path.dirname(database)
  // Pinned beside the database under the production basenames.
  const analog = path.join(directory, JP_REPAIR_ANALOG_BASENAME)
  if (argument('--analog') && path.resolve(argument('--analog')!) !== analog) {
    throw new Error(`--analog must be ${analog}`)
  }
  return {
    database,
    base: required('--base'),
    metadata: required('--metadata'),
    official: required('--official'),
    analog,
    servingCache: path.join(directory, JP_REPAIR_SERVING_CACHE_BASENAME),
    receipt: path.resolve(argument('--receipt') ?? path.join(directory, 'rehearsal-receipt.json')),
    priceBasisEvidence: path.resolve(argument('--price-basis-evidence')
      ?? 'docs/architecture/2026-11-01/jp-repair-price-basis-evidence.json'),
    reset: process.argv.includes('--reset'),
    validateOnly: process.argv.includes('--validate-only'),
    failBeforeStage: argument('--fail-before-stage'),
  }
}

function assertTemporary(filePath: string): void {
  const resolved = path.resolve(filePath)
  const roots = [path.resolve(os.tmpdir()), '/private/tmp']
  if (!roots.some((root) => resolved === root || resolved.startsWith(`${root}${path.sep}`))) {
    throw new Error(`rehearsal output must remain in a temporary directory: ${resolved}`)
  }
  if (resolved.startsWith('/Volumes/')) throw new Error(`external-volume output is forbidden: ${resolved}`)
}

function bytes(filePath: string): number {
  try { return fs.statSync(filePath).size } catch { return 0 }
}

function allocatedBytes(filePath: string): number {
  try {
    const blocks = fs.statSync(filePath).blocks
    return Number(blocks ?? 0) * 512
  } catch {
    return 0
  }
}

function databaseBundleAllocatedBytes(database: string): number {
  return [database, `${database}-wal`, `${database}-shm`]
    .reduce((total, file) => total + allocatedBytes(file), 0)
}

function tail(value: string, limit = 6_000): string {
  return value.length > limit ? value.slice(-limit) : value
}

function fileSha256(filePath: string): string {
  return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex')
}

function sourceTreeSha256(): string {
  return jpRepairRuntimeSourceTreeSha256()
}

// Same resolution as stockboardBuildProvenance in the runtime manifest.
function gitHeadSha(): string {
  const commit = execFileSync('/usr/bin/git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error('HEAD is not a commit')
  return commit
}

// Re-checked immediately before each approval artifact is written, so a
// checkout or edit during the long run cannot be attributed to the start.
function assertRevisionUnchanged(gitCommitSha: string, sourceTree: string, nodeModulesLockSha256: string): void {
  if (gitHeadSha() !== gitCommitSha || sourceTreeSha256() !== sourceTree
      || jpRepairNodeModulesLockSha256(process.cwd()) !== nodeModulesLockSha256) {
    throw new Error('HEAD, runtime source tree, or installed dependencies changed during the rehearsal; rerun with --reset')
  }
}

function sealedCommandFiles(command: readonly string[]): Array<{ path: string; sha256: string }> {
  return command
    .filter((value) => /\.(?:ts|js|mjs|cjs)$/.test(value))
    .map((value) => path.resolve(value))
    .filter((value) => fs.existsSync(value))
    .map((value) => ({ path: value, sha256: fileSha256(value) }))
}

async function runStageCommand(input: {
  command: string[]
  env: NodeJS.ProcessEnv
  database: string
  barrier?: MaintenanceLockHolder
}): Promise<{
  status: number | null
  signal: NodeJS.Signals | null
  stdout: string
  stderr: string
  rssBytesPeak: number
  walBytesPeak: number
  allocatedBytesPeak: number
}> {
  let stdout = ''
  let stderr = ''
  let rssBytesPeak = 0
  let walBytesPeak = bytes(`${input.database}-wal`)
  let allocatedBytesPeak = databaseBundleAllocatedBytes(input.database)
  let childPid: number | undefined
  let sampleCount = 0
  const sample = (): void => {
    walBytesPeak = Math.max(walBytesPeak, bytes(`${input.database}-wal`))
    allocatedBytesPeak = Math.max(allocatedBytesPeak, databaseBundleAllocatedBytes(input.database))
    sampleCount += 1
    if (childPid && sampleCount % 10 === 0) {
      try {
        const rssKb = Number(execFileSync('ps', ['-o', 'rss=', '-p', String(childPid)], {
          encoding: 'utf8',
          timeout: 2_000,
        }).trim())
        if (Number.isFinite(rssKb)) rssBytesPeak = Math.max(rssBytesPeak, rssKb * 1_024)
      } catch { /* process may have exited between samples */ }
    }
  }
  return new Promise((resolve, reject) => {
    const child = spawn(input.command[0], input.command.slice(1), {
      cwd: process.cwd(),
      env: input.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    childPid = child.pid
    child.stdout.on('data', (chunk: Buffer) => { stdout = tail(stdout + chunk.toString()) })
    child.stderr.on('data', (chunk: Buffer) => { stderr = tail(stderr + chunk.toString()) })
    child.on('error', reject)
    const timer = setInterval(sample, 100)
    let barrierFailure: Error | null = null
    const unwatch = input.barrier?.watch((error) => {
      barrierFailure = error
      child.kill('SIGTERM')
      setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
      }, 10_000).unref()
    }) ?? (() => undefined)
    child.on('close', (status, signal) => {
      clearInterval(timer)
      unwatch()
      sample()
      if (barrierFailure) {
        reject(barrierFailure)
        return
      }
      resolve({ status, signal, stdout, stderr, rssBytesPeak, walBytesPeak, allocatedBytesPeak })
    })
  })
}

function readReceipt(filePath: string): Receipt {
  return JSON.parse(fs.readFileSync(filePath, 'utf8')) as Receipt
}

function writeReceipt(filePath: string, receipt: { updatedAt: string }): void {
  receipt.updatedAt = new Date().toISOString()
  writeJsonAtomic(filePath, receipt)
}

// Stage checkpoint protocol. A stage is durably marked in flight before its
// command can commit anything; the mark is cleared by the same atomic write
// that records the stage receipt. A mark found on restart means the stage may
// have committed output that no receipt describes. The stages are not proven
// idempotent and no validator proves such output safe, so the run holds
// instead of rerunning the stage; only --reset (a new rehearsal) clears it.
// A FAIL stage receipt holds the same way: its partial output is not proven
// safe to run over, so a failed stage is never rerun.
export const JP_REPAIR_STAGE_IN_FLIGHT = 'JP_REPAIR_STAGE_IN_FLIGHT'
export const JP_REPAIR_STAGE_FAILED = 'JP_REPAIR_STAGE_FAILED'

type CheckpointStage = Pick<StageReceipt, 'name' | 'status' | 'sealedFiles'>
export type JpRepairStageCheckpoint<S extends CheckpointStage = CheckpointStage> = Pick<
  Receipt, 'status' | 'updatedAt' | 'inFlightStage'
> & { stages: S[] }

export function assertNoJpRepairStageInFlight(receipt: Pick<Receipt, 'inFlightStage'>): void {
  if (!receipt.inFlightStage) return
  throw Object.assign(new Error(`stage ${receipt.inFlightStage.name} started at ${receipt.inFlightStage.startedAt} `
    + 'has no stage receipt; its output may already be committed, so it is not rerun; rerun with --reset to start a new rehearsal'),
  { holdCode: JP_REPAIR_STAGE_IN_FLIGHT })
}

export function jpRepairStagePassed(
  receipt: JpRepairStageCheckpoint,
  name: string,
  sealedFiles: StageReceipt['sealedFiles'],
): boolean {
  assertNoJpRepairStageInFlight(receipt)
  if (receipt.stages.some((item) => item.name === name && item.status === 'FAIL')) {
    throw Object.assign(new Error(`stage ${name} has a FAIL receipt; its partial output may already be committed, `
      + 'so it is not rerun; rerun with --reset to start a new rehearsal'), { holdCode: JP_REPAIR_STAGE_FAILED })
  }
  return receipt.stages.some((item) => item.name === name && item.status === 'PASS'
    && JSON.stringify(item.sealedFiles) === JSON.stringify(sealedFiles))
}

export function beginJpRepairStage(filePath: string, receipt: JpRepairStageCheckpoint, name: string): void {
  assertNoJpRepairStageInFlight(receipt)
  receipt.inFlightStage = { name, startedAt: new Date().toISOString() }
  writeReceipt(filePath, receipt)
}

export function recordJpRepairStage<S extends CheckpointStage>(
  filePath: string,
  receipt: JpRepairStageCheckpoint<S>,
  item: S,
): void {
  if (receipt.inFlightStage?.name !== item.name) throw new Error(`stage ${item.name} was not marked in flight`)
  receipt.stages = [...receipt.stages.filter((prior) => prior.name !== item.name), item]
  receipt.status = item.status === 'PASS' ? 'DERIVED_PENDING' : 'HOLD'
  delete receipt.inFlightStage
  writeReceipt(filePath, receipt)
}

function valuationChunkIdentities(tickers: readonly string[]): ValuationChunkIdentity[] {
  return chunkJpOhlcvRepairTickers(tickers, VALUATION_CHUNK_SIZE).map((chunk) => ({
    tickerCount: chunk.length,
    tickersSha256: jpOhlcvValueSha256(chunk),
  }))
}

function assertCompleteStageReceipts(
  receipt: Receipt,
  expectedValuationChunks: ValuationChunkIdentity[],
): void {
  const names = receipt.stages.map((stage) => stage.name)
  if (names.length !== 28 || new Set(names).size !== names.length
      || receipt.stages.some((stage) => stage.status !== 'PASS')) {
    throw new Error(`finalization requires 28 distinct passing stages; found ${names.length}`)
  }
  const valuation = receipt.stages.find((stage) => stage.name === 'valuation')
  const valuationChunks = valuation?.chunks ?? []
  const actualChunkIdentities = valuationChunks.map(({ tickerCount, tickersSha256 }) => ({
    tickerCount,
    tickersSha256,
  }))
  if (!receipt.source
      || valuationChunks.length === 0
      || valuationChunks.some((chunk) => chunk.status !== 'PASS' || chunk.signal !== null || chunk.exitCode !== 0)
      || valuationChunks.reduce((total, chunk) => total + chunk.tickerCount, 0) !== receipt.source.approved
      || JSON.stringify(actualChunkIdentities) !== JSON.stringify(expectedValuationChunks)) {
    throw new Error('valuation chunks do not prove the complete approved ticker set')
  }
}

function tableCount(database: string, table: string): number {
  const db = new DatabaseSync(database, { readOnly: true })
  try {
    const exists = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)
    if (!exists) return -1
    return Number((db.prepare(`SELECT COUNT(*) AS count FROM "${table}"`).get() as { count: number }).count)
  } finally {
    db.close()
  }
}

function rowsSha256(
  database: DatabaseSync,
  sql: string,
  args: Array<string | number> = [],
): { count: number; sha256: string } {
  const hash = createHash('sha256')
  let count = 0
  for (const row of database.prepare(sql).iterate(...args) as Iterable<Record<string, unknown>>) {
    hash.update(JSON.stringify(row))
    hash.update('\n')
    count += 1
  }
  return { count, sha256: hash.digest('hex') }
}

const SEALED_RESEARCH_TABLES = [
  'ml_short_labels',
  'rl_training_states_v2',
  'ml_rl_policy_evaluations',
  'ml_physics_status_evaluations',
  'ml_training_labels',
  'rl_training_states',
] as const

function sealedResearchFingerprint(database: DatabaseSync): Record<string, { count: number; sha256: string }> {
  return Object.fromEntries(SEALED_RESEARCH_TABLES.map((table) => [
    table,
    rowsSha256(database, `SELECT * FROM ${table} ORDER BY rowid`),
  ]))
}

function observedRows(database: string, stage: string): Record<string, number> {
  return Object.fromEntries((TABLES_BY_STAGE[stage] ?? []).map((table) => [table, tableCount(database, table)]))
}

function assertQuickCheck(database: string): void {
  const db = new DatabaseSync(database, { readOnly: true })
  try {
    const rows = db.prepare('PRAGMA quick_check').all() as Array<{ quick_check: string }>
    if (rows.length !== 1 || rows[0]?.quick_check !== 'ok') {
      throw new Error(`${database} quick_check failed: ${JSON.stringify(rows)}`)
    }
  } finally {
    db.close()
  }
}

function validateFinalState(
  cli: Cli,
  official: OfficialEvidence,
  receipt: Receipt,
  expectedPhase: 'derived_pending' | 'derived_complete' = 'derived_complete',
  expectedPublicationEvidenceSha256?: string,
): Record<string, string | number> {
  if (!receipt.source) throw new Error('source repair receipt is missing')
  const repaired = new DatabaseSync(cli.database, { readOnly: true })
  const baseline = new DatabaseSync(cli.base, { readOnly: true })
  const evidence = new DatabaseSync(cli.metadata, { readOnly: true })
  try {
    const rows = repaired.prepare(`
      SELECT ticker,date,open,high,low,close,volume
      FROM ohlcv_daily WHERE date=? ORDER BY ticker
    `).all(TARGET_DATE) as JpOhlcvOfficialRow[]
    if (rows.length !== 4_218) throw new Error(`target-date row count is ${rows.length}, expected 4218`)
    const byTicker = new Map(rows.map((row) => [row.ticker, row]))
    const baselineByTicker = new Map((baseline.prepare(`
      SELECT ticker,date,open,high,low,close,volume
      FROM ohlcv_daily WHERE date=? ORDER BY ticker
    `).all(TARGET_DATE) as JpOhlcvOfficialRow[]).map((row) => [row.ticker, row]))
    const affectedTickers = official.rows
      .filter((row) => !baselineByTicker.has(row.ticker))
      .map((row) => row.ticker)
      .sort()
    if (affectedTickers.length !== 4_061) {
      throw new Error(`affected ticker count changed: ${affectedTickers.length}`)
    }
    const valuationStage = receipt.stages.find((stage) => stage.name === 'valuation')
    const valuationStartedAt = Date.parse(valuationStage?.startedAt ?? '') / 1_000
    if (!Number.isFinite(valuationStartedAt)) throw new Error('valuation stage start time is missing')
    const placeholders = affectedTickers.map(() => '?').join(',')
    const valuationCoverage = repaired.prepare(`
      SELECT COUNT(*) AS count,
        SUM(CASE WHEN checkpoint.status='completed'
          AND checkpoint.calculated_at >= ?
          AND checkpoint.latest_price_date=latest.latest_price_date
          AND checkpoint.latest_valuation_date IS NOT NULL
          AND EXISTS (
            SELECT 1 FROM valuation_daily_serving serving
            WHERE serving.ticker=checkpoint.ticker
              AND serving.valuation_date=checkpoint.latest_valuation_date
          )
          AND EXISTS (
            SELECT 1 FROM valuation_daily_serving repaired_day
            WHERE repaired_day.ticker=checkpoint.ticker
              AND repaired_day.valuation_date=?
          ) THEN 1 ELSE 0 END) AS valid
      FROM valuation_serving_checkpoints checkpoint
      INNER JOIN (
        SELECT ticker,MAX(date) AS latest_price_date FROM ohlcv_daily
        WHERE ticker IN (${placeholders}) GROUP BY ticker
      ) latest ON latest.ticker=checkpoint.ticker
      WHERE checkpoint.ticker IN (${placeholders})
    `).get(Math.floor(valuationStartedAt), TARGET_DATE, ...affectedTickers, ...affectedTickers) as {
      count: number
      valid: number | null
    }
    if (Number(valuationCoverage.count) !== affectedTickers.length
        || Number(valuationCoverage.valid ?? 0) !== affectedTickers.length) {
      throw new Error(`valuation serving coverage is incomplete: ${JSON.stringify(valuationCoverage)}`)
    }
    const protectedTickers = new Set(['1447', '2164'])
    for (const expected of official.rows) {
      const actual = byTicker.get(expected.ticker)
      if (!actual) throw new Error(`final OHLCV row is missing: ${expected.ticker}:${TARGET_DATE}`)
      if (protectedTickers.has(expected.ticker)) {
        const prior = baselineByTicker.get(expected.ticker)
        if (!prior || !sameJpOhlcvRow(actual, prior)) {
          throw new Error(`protected conflict changed: ${expected.ticker}:${TARGET_DATE}`)
        }
      } else if (!sameJpOhlcvRow(actual, expected)) {
        throw new Error(`final OHLCV differs from official evidence: ${expected.ticker}:${TARGET_DATE}`)
      }
    }

    const sourceRun = repaired.prepare(`
      SELECT status,error_summary AS errorSummary FROM batch_runs
      WHERE id=? AND job_type='ohlcv_fetch:jquants'
    `).get(receipt.source.receiptId) as { status: string; errorSummary: string | null } | undefined
    const sourceEvidence = JSON.parse(sourceRun?.errorSummary ?? '{}') as {
      approvalSha256?: string
      phase?: string
      publicationEvidenceSha256?: string
    }
    const expectedStatus = expectedPhase === 'derived_complete' ? 'success' : 'partial'
    if (sourceRun?.status !== expectedStatus
        || sourceEvidence.phase !== expectedPhase
        || sourceEvidence.approvalSha256 !== receipt.source.approvalSha256
        || (expectedPublicationEvidenceSha256
          && sourceEvidence.publicationEvidenceSha256 !== expectedPublicationEvidenceSha256)) {
      throw new Error(`source receipt is not the sealed ${expectedPhase} receipt`)
    }

    const issueCounts = summarizeOpenJpOhlcvCoverageIssues(repaired.prepare(`
      SELECT date,ticker,kind,COUNT(*) AS count FROM jquants_daily_coverage_issues
      WHERE status='open' GROUP BY date,ticker,kind
    `).all() as Array<{ date: string; ticker: string; kind: string; count: number }>)
    if (issueCounts.newIssues !== 0 || issueCounts.protectedConflicts !== 2) {
      throw new Error(`unexpected final coverage issues: ${JSON.stringify(issueCounts)}`)
    }

    const smaRows = repaired.prepare(`
      SELECT close FROM ohlcv_daily
      WHERE ticker='7003' AND date <= '2026-10-28'
      ORDER BY date DESC LIMIT 75
    `).all() as Array<{ close: number }>
    if (smaRows.length !== 75) throw new Error(`7003 SMA75 source rows are ${smaRows.length}`)
    const expectedSma75 = smaRows.reduce((sum, row) => sum + Number(row.close), 0) / 75
    const snapshot = repaired.prepare(`
      SELECT ma_75 AS sma75 FROM daily_snapshots
      WHERE ticker='7003' AND date='2026-10-28'
    `).get() as { sma75: number | null } | undefined
    if (snapshot?.sma75 == null || Math.abs(snapshot.sma75 - expectedSma75) > 1e-9) {
      throw new Error(`7003 SMA75 mismatch: ${snapshot?.sma75 ?? 'null'} vs ${expectedSma75}`)
    }

    const required: Array<[string, string, Array<string | number>]> = [
      ['daily snapshot', `SELECT COUNT(*) AS count FROM daily_snapshots WHERE date=?`, [LATEST_DATE]],
      ['screener', `SELECT COUNT(*) AS count FROM stock_screening_serving WHERE as_of=?`, [LATEST_DATE]],
      ['dashboard', `SELECT COUNT(*) AS count FROM dashboard_cache WHERE date=?`, [LATEST_DATE]],
      ['trigger', `SELECT COUNT(*) AS count FROM trigger_evaluations`, []],
      ['two-year serving', `SELECT COUNT(*) AS count FROM dashboard_trade_signal_cache WHERE cache_key LIKE 'two-year-line-serving%3Av1:JP:%'`, []],
      ['classic ML serving', `SELECT COUNT(*) AS count FROM serving_ml_candidates WHERE as_of_date=?`, [LATEST_DATE]],
      ['physics ML serving', `SELECT COUNT(*) AS count FROM serving_ml_physics_candidates WHERE as_of_date=?`, [LATEST_DATE]],
      ['ML predictions', `SELECT COUNT(*) AS count FROM ml_predictions WHERE as_of_date=?`, [LATEST_DATE]],
      ['ML similars', `SELECT COUNT(*) AS count FROM serving_current_similars WHERE as_of_date=?`, [LATEST_DATE]],
      ['ML serving health', `
        SELECT COUNT(*) AS count
        FROM ml_feature_health_checks
        WHERE check_date=(SELECT MAX(check_date) FROM ml_feature_health_checks)
          AND check_key IN (
            'daily_snapshots','model_features','ml_feature_vectors_v2',
            'historical_universe','serving_current_similars','serving_ml_physics_candidates'
          )
          AND status='ok' AND expected_date=? AND actual_date=?
      `, [LATEST_DATE, LATEST_DATE]],
      ['ML health ok observations', `
        SELECT COUNT(*) AS count
        FROM ml_feature_health_checks
        WHERE check_date=(SELECT MAX(check_date) FROM ml_feature_health_checks)
          AND status='ok'
      `, []],
    ]
    const counts: Record<string, number> = {}
    for (const [label, sql, args] of required) {
      const row = repaired.prepare(sql).get(...args) as { count: number }
      const value = Number(row.count ?? 0)
      if (value <= 0) throw new Error(`${label} has no current output`)
      if (label === 'ML serving health' && value !== 6) {
        throw new Error(`ML health serving checks are incomplete: ${value}/6`)
      }
      counts[label] = value
    }
    const createdAtEpoch = Math.floor(Date.parse(receipt.createdAt) / 1_000)
    const classicCoverage = inspectJpOhlcvRepairMlCoverage({
      db: repaired,
      table: 'ml_feature_vectors',
      affectedTickers,
      startDate: TARGET_DATE,
      endDate: LATEST_DATE,
      computedAtEpoch: createdAtEpoch,
      minHistoryDays: 220,
    })
    const physicsCoverage = inspectJpOhlcvRepairMlCoverage({
      db: repaired,
      table: 'ml_feature_vectors_v2',
      affectedTickers,
      startDate: TARGET_DATE,
      endDate: LATEST_DATE,
      computedAtEpoch: createdAtEpoch,
      minHistoryDays: 220,
      featureSet: ML_PHYSICS_FEATURE_SET,
    })
    if (classicCoverage.expected !== classicCoverage.actual
        || classicCoverage.missing !== 0 || classicCoverage.extra !== 0
        || physicsCoverage.expected !== physicsCoverage.actual
        || physicsCoverage.missing !== 0 || physicsCoverage.extra !== 0) {
      throw new Error(
        `current ML features were not rebuilt for the repair scope: `
        + `classic=${JSON.stringify(classicCoverage)}, physics=${JSON.stringify(physicsCoverage)}`,
      )
    }
    if (!receipt.sealedResearch) throw new Error('sealed research baseline fingerprint is missing')
    const finalResearch = sealedResearchFingerprint(repaired)
    for (const table of SEALED_RESEARCH_TABLES) {
      const before = receipt.sealedResearch[table]
      const after = finalResearch[table]
      if (!before || before.count !== after.count || before.sha256 !== after.sha256) {
        throw new Error(`sealed ML research changed: ${table}`)
      }
    }
    const researchContracts = [
      {
        table: 'ml_short_labels',
        order: 'ticker,date,horizon_days',
        where: `date=(SELECT MAX(date) FROM ml_short_labels WHERE date <= '${LATEST_DATE}')`,
      },
      {
        table: 'rl_training_states_v2',
        order: 'ticker,date,horizon_days,action',
        where: `date=(SELECT MAX(date) FROM rl_training_states_v2 WHERE date <= '${LATEST_DATE}')`,
      },
      {
        table: 'ml_rl_policy_evaluations',
        order: 'evaluation_id',
        where: `evaluation_date=(SELECT MAX(evaluation_date) FROM ml_rl_policy_evaluations WHERE evaluation_date <= '${LATEST_DATE}')`,
      },
      {
        table: 'ml_physics_status_evaluations',
        order: 'evaluation_id',
        where: `evaluation_date=(SELECT MAX(evaluation_date) FROM ml_physics_status_evaluations WHERE evaluation_date <= '${LATEST_DATE}')`,
      },
    ] as const
    const researchHash = createHash('sha256')
    let researchRows = 0
    for (const contract of researchContracts) {
      const repairedRows = rowsSha256(
        repaired,
        `SELECT * FROM ${contract.table} WHERE ${contract.where} ORDER BY ${contract.order}`,
      )
      const evidenceRows = rowsSha256(
        evidence,
        `SELECT * FROM ${contract.table} WHERE ${contract.where} ORDER BY ${contract.order}`,
      )
      if (repairedRows.count !== evidenceRows.count || repairedRows.sha256 !== evidenceRows.sha256) {
        throw new Error(`sealed ML research changed: ${contract.table}`)
      }
      researchRows += repairedRows.count
      researchHash.update(`${contract.table}:${repairedRows.count}:${repairedRows.sha256}\n`)
    }
    const analogRows = tableCount(cli.analog, 'analog_sequence_index')
    if (analogRows <= 0) throw new Error('analog index is empty')
    // The deployed reader is v2; a v3 (or unfinished) build must never pass.
    assertJpRepairAnalogMeta(cli.analog)
    return {
      targetDateRows: rows.length,
      openMissing: issueCounts.missing,
      openProtectedConflicts: issueCounts.protectedConflicts,
      openNewCoverageIssues: issueCounts.newIssues,
      sma7003_20261028: expectedSma75,
      mlClassicAffectedRecomputed: classicCoverage.actual,
      mlClassicAffectedEligible: classicCoverage.expected,
      mlPhysicsAffectedRecomputed: physicsCoverage.actual,
      mlPhysicsAffectedEligible: physicsCoverage.expected,
      valuationAffectedComplete: Number(valuationCoverage.valid ?? 0),
      sealedMlResearchRows: researchRows,
      sealedMlResearchSha256: researchHash.digest('hex'),
      analogRows,
      ...counts,
    }
  } finally {
    evidence.close()
    baseline.close()
    repaired.close()
  }
}

function checkpointWalHandoff(database: string): void {
  const db = new DatabaseSync(database)
  try {
    const result = db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get() as {
      busy: number
      log: number
      checkpointed: number
    }
    if (result.busy !== 0 || result.log !== 0 || result.checkpointed !== 0) {
      throw new Error(`WAL handoff checkpoint is incomplete: ${JSON.stringify(result)}`)
    }
  } finally {
    db.close()
  }
}

function checkpointNativeWriter(database: string): void {
  checkpointWalHandoff(database)
  assertQuickCheck(database)
}

function writeJsonAtomic(filePath: string, value: unknown): void {
  const temporary = `${filePath}.${process.pid}.tmp`
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
  const descriptor = fs.openSync(temporary, 'r')
  try { fs.fsyncSync(descriptor) } finally { fs.closeSync(descriptor) }
  fs.renameSync(temporary, filePath)
  // The rename is durable only once the parent directory entry is synced.
  const directory = fs.openSync(path.dirname(filePath), 'r')
  try { fs.fsyncSync(directory) } finally { fs.closeSync(directory) }
}

// Creates the final receipt without ever replacing an existing entry: the
// bytes go to an exclusive no-follow temporary file that is hard-linked into
// place, so a concurrent writer's receipt makes the link fail with EEXIST and
// is then verified instead.
export function persistFinalValidationReceipt(filePath: string, receipt: JpRepairFinalValidationReceipt): void {
  if (verifyExistingJpRepairFinalValidationReceipt(filePath, receipt)) return
  const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`
  const descriptor = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT
    | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600)
  try {
    fs.writeFileSync(descriptor, `${JSON.stringify(receipt, null, 2)}\n`)
    fs.fsyncSync(descriptor)
  } finally {
    fs.closeSync(descriptor)
  }
  try {
    fs.linkSync(temporary, filePath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  } finally {
    fs.rmSync(temporary, { force: true })
  }
  const directory = fs.openSync(path.dirname(filePath), 'r')
  try { fs.fsyncSync(directory) } finally { fs.closeSync(directory) }
  if (!verifyExistingJpRepairFinalValidationReceipt(filePath, receipt)) {
    throw new Error('final validation receipt was not persisted')
  }
}

function fileIdentity(filePath: string): Record<string, string | number> {
  const realpath = fs.realpathSync(filePath)
  const stat = fs.statSync(realpath)
  return {
    realpath,
    inode: Number(stat.ino),
    size: stat.size,
    sha256: fileSha256(realpath),
  }
}

function fileMetadataIdentity(filePath: string): Record<string, string | number> {
  const realpath = fs.realpathSync(filePath)
  const stat = fs.statSync(realpath)
  return {
    realpath,
    inode: Number(stat.ino),
    size: stat.size,
    mtimeMs: stat.mtimeMs,
  }
}

function optionalFileMetadataIdentity(filePath: string): Record<string, string | number> | null {
  return fs.existsSync(filePath) ? fileMetadataIdentity(filePath) : null
}

function databaseBundleIdentity(database: string): Record<string, unknown> {
  return {
    database: fileMetadataIdentity(database),
    wal: optionalFileMetadataIdentity(`${database}-wal`),
  }
}

function verifyPriceBasisEvidence(
  cli: Cli,
  official: OfficialEvidence,
  plan: JpOhlcvRepairPlan,
): { path: string; sha256: string } {
  const report = JSON.parse(fs.readFileSync(cli.priceBasisEvidence, 'utf8')) as {
    status?: string
    targetDate?: string
    priceBasis?: string
    officialEvidence?: string
    classification?: { approvedMissingKeysSha256?: string }
  }
  const expectedKeysSha256 = jpOhlcvValueSha256([...plan.approvedMissingKeys].sort())
  if (report.status !== 'PASS'
      || report.targetDate !== official.date
      || report.priceBasis !== official.priceBasis
      || report.classification?.approvedMissingKeysSha256 !== expectedKeysSha256
      || fs.realpathSync(report.officialEvidence ?? '') !== fs.realpathSync(cli.official)) {
    throw new Error('Price Basis / Corporate Action evidence is not bound to the repair plan')
  }
  return { path: fs.realpathSync(cli.priceBasisEvidence), sha256: fileSha256(cli.priceBasisEvidence) }
}

function assertForwardReturnReceipt(filePath: string): { path: string; sha256: string } {
  const receipt = JSON.parse(fs.readFileSync(filePath, 'utf8')) as {
    status?: string
    repaired?: { missing?: number; changed?: number; extra?: number }
  }
  if (receipt.status !== 'PASS'
      || receipt.repaired?.missing !== 0
      || receipt.repaired.changed !== 0
      || receipt.repaired.extra !== 0) {
    throw new Error(`forward-return verification did not pass: ${JSON.stringify(receipt.repaired ?? {})}`)
  }
  return { path: fs.realpathSync(filePath), sha256: fileSha256(filePath) }
}

function startMaintenanceLockHolder(database: string): Promise<MaintenanceLockHolder> {
  const startupTimeoutMs = Number(process.env.STOCKBOARD_MAINTENANCE_HOLDER_STARTUP_TIMEOUT_MS ?? 600_000)
  if (!Number.isSafeInteger(startupTimeoutMs) || startupTimeoutMs < 30_000) {
    throw new Error('STOCKBOARD_MAINTENANCE_HOLDER_STARTUP_TIMEOUT_MS must be an integer of at least 30000')
  }
  const child = spawn(process.execPath, [
    '--import', process.env.STOCKBOARD_TSX_IMPORT ?? 'tsx', 'scripts/hold-update-lock.ts',
  ], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      USE_LOCAL_DB: '1',
      STOCKBOARD_DB_PATH: database,
      SKIP_SCHEMA_ENSURE: '1',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const closed = new Promise<[number | null, NodeJS.Signals | null]>((resolve) => {
    child.once('close', (code, signal) => resolve([code, signal]))
  })
  return new Promise((resolve, reject) => {
    let stdout = ''
    let stderr = ''
    const timeout = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error(`maintenance lock holder timed out: ${stderr || stdout}`))
    }, startupTimeoutMs)
    const fail = (error: unknown): void => {
      clearTimeout(timeout)
      reject(error)
    }
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString() })
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString()
      const line = stdout.split('\n').find((candidate) => candidate.trim().startsWith('{'))
      if (!line) return
      try {
        const ready = JSON.parse(line) as { status?: unknown; jobType?: unknown; owner?: unknown }
        if (ready.status !== 'LOCKED' || ready.jobType !== 'db_maintenance' || typeof ready.owner !== 'string') {
          throw new Error(`invalid maintenance lock holder response: ${line}`)
        }
        clearTimeout(timeout)
        let released = false
        resolve({
          owner: ready.owner,
          assertActive: () => {
            if (child.exitCode !== null || child.signalCode !== null) {
              throw new Error(`maintenance lock holder exited early: ${stderr || stdout}`)
            }
          },
          watch: (onLoss) => {
            const handler = (code: number | null, signal: NodeJS.Signals | null): void => {
              if (!released) {
                onLoss(new Error(
                  `maintenance lock holder exited during a stage: code=${code}, signal=${signal ?? 'none'} ${stderr}`,
                ))
              }
            }
            child.once('close', handler)
            return () => child.off('close', handler)
          },
          release: async () => {
            if (released) return
            released = true
            if (child.exitCode === null && child.signalCode === null) {
              child.stdin.write('RELEASE\n')
              child.stdin.end()
            }
            const [code, signal] = await closed
            if (code !== 0) throw new Error(`maintenance lock holder failed: code=${code}, signal=${signal ?? 'none'} ${stderr}`)
          },
        })
      } catch (error) {
        child.stdin.end()
        fail(error)
      }
    })
    child.on('error', fail)
    child.on('close', (code, signal) => {
      if (stdout.includes('"status":"LOCKED"')) return
      fail(new Error(`maintenance lock holder exited before ready: code=${code}, signal=${signal ?? 'none'} ${stderr}`))
    })
  })
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`
}

function hydrateScreenerInputs(database: string, metadataDatabase: string): void {
  const target = new DatabaseSync(database)
  try {
    const uri = new URL(`file://${metadataDatabase}`).href.replace('file://', 'file:') + '?mode=ro'
    target.exec(`ATTACH DATABASE '${uri.replaceAll("'", "''")}' AS evidence`)
    const copy = (table: string, where = '1=1', merge = false): void => {
      const existing = target.prepare(`SELECT COUNT(*) AS count FROM main.${quoteIdentifier(table)}`).get() as { count: number }
      if (!merge && existing.count > 0) return
      const mainColumns = (target.prepare(`PRAGMA main.table_info(${quoteIdentifier(table)})`).all() as Array<{ name: string }>).map((row) => row.name)
      const evidenceColumns = new Set(
        (target.prepare(`PRAGMA evidence.table_info(${quoteIdentifier(table)})`).all() as Array<{ name: string }>).map((row) => row.name),
      )
      const columns = mainColumns.filter((column) => evidenceColumns.has(column))
      if (columns.length === 0) throw new Error(`no compatible metadata columns for ${table}`)
      const columnSql = columns.map(quoteIdentifier).join(',')
      target.exec(`INSERT ${merge ? 'OR IGNORE ' : ''}INTO main.${quoteIdentifier(table)}(${columnSql}) SELECT ${columnSql} FROM evidence.${quoteIdentifier(table)} WHERE ${where}`)
    }
    target.exec('BEGIN IMMEDIATE')
    const universe = target.prepare('SELECT * FROM evidence.ticker_universe').all() as Record<string, unknown>[]
    const insertUniverse = target.prepare(`
      INSERT OR REPLACE INTO ticker_universe(
        ticker,name,active,added_at,shares_outstanding,shares_updated_at,
        sector17_code,sector17_name,sector33_code,sector33_name,market_segment,margin_code,margin_type
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)
    `)
    for (const row of universe) insertUniverse.run(...[
      row.ticker, row.name, row.active, row.added_at, row.shares_outstanding, row.shares_updated_at,
      row.sector17_code, row.sector17_name, row.sector33_code, row.sector33_name,
      row.market_segment, row.margin_code, row.margin_type,
    ])
    const sectors = target.prepare('SELECT * FROM evidence.sector_master').all() as Record<string, unknown>[]
    const insertSector = target.prepare(`
      INSERT OR REPLACE INTO sector_master(
        ticker,name,sector_large,sector_small,updated_at,source_file,market_segment,sector33,margin_type
      ) VALUES(?,?,?,?,?,?,?,?,?)
    `)
    for (const row of sectors) insertSector.run(...[
      row.ticker, row.name, row.sector_large, row.sector_small, row.updated_at,
      row.source_file, row.market_segment, row.sector33, row.margin_type,
    ])
    // The extracted source database intentionally has no serving tables. Merge
    // the existing snapshot history so replacement semantics are exercised;
    // repaired rows already written by the rehearsal remain authoritative.
    copy('daily_snapshots', '1=1', true)
    // BIWEEKLY Trigger evaluation needs the pre-repair weekly MA substrate.
    // Production already owns it; fixture hydration is not maintenance work.
    copy('weekly_ohlcv', `date < '${TARGET_DATE}'`, true)
    // Exercise the exact regenerable-cache invalidation set observed in the
    // Production evidence instead of accepting an empty fixture shortcut.
    copy('dashboard_cache', `date >= '${TARGET_DATE}'`, true)
    copy('dashboard_trade_signal_cache', `
      (cache_key LIKE 'v5|%' AND cache_key NOT LIKE '%|jp:none|%')
      OR cache_key LIKE 'two-year-line-serving%3Av1:JP:%'
    `, true)
    copy('valuation_daily_serving', `valuation_date BETWEEN '2021-10-30' AND '${LATEST_DATE}'`)
    copy('calculated_financial_metrics', `as_of <= '${LATEST_DATE}'`)
    copy('normalized_financial_facts', `
      published_at <= '${LATEST_DATE}T23:59:59+09:00'
      AND metric IN ('revenue','operating_profit','total_assets','equity_attributable','eps_basic','dividend_per_share_annual')
    `)
    copy('financial_forecast_snapshots', `
      published_at <= '${LATEST_DATE}T23:59:59+09:00'
      AND forecast_period='FY' AND forecast_scope IN ('current_fy','next_fy')
      AND metric IN ('revenue','operating_profit','eps_basic','dividend_per_share_annual')
    `)
    copy('stock_classification')
    copy('physical_momentum_metrics', `
      market='JP' AND date=(SELECT MAX(date) FROM evidence.physical_momentum_metrics WHERE market='JP' AND date <= '${LATEST_DATE}')
    `)
    copy('weekly_margin_interest', `
      date=(SELECT MAX(newer.date) FROM evidence.weekly_margin_interest newer
            WHERE newer.ticker=evidence.weekly_margin_interest.ticker AND newer.date <= '${LATEST_DATE}')
    `)
    copy('sector_structure_daily', `
      taxonomy='33' AND date=(SELECT MAX(date) FROM evidence.sector_structure_daily WHERE taxonomy='33' AND date <= '${LATEST_DATE}')
    `)
    copy('trigger_definitions')
    copy('saved_screening_definitions')
    copy('saved_screening_evaluations')
    copy('saved_screening_evaluation_members')
    copy('ml_models')
    copy('ml_pipeline_generations')
    // The immutable ML generation proves a full-history baseline at its sealed
    // source date. Preserve the matching rows so verify-or-adopt validates the
    // real baseline contract before this rehearsal builds the current delta.
    copy('ml_feature_vectors', `
      date=(SELECT baseline_source_date FROM evidence.ml_pipeline_generations
            WHERE market='JP' LIMIT 1)
    `)
    copy('ml_feature_vectors_v2', `
      date=(SELECT baseline_source_date FROM evidence.ml_pipeline_generations
            WHERE market='JP' LIMIT 1)
    `)
    // Production already has current-date serving features. Copy them so the
    // rehearsal proves the repair replaces stale current rows instead of only
    // filling an unrealistically empty fixture.
    copy('ml_feature_vectors', `
      date=(SELECT MAX(date) FROM evidence.ml_feature_vectors WHERE date <= '${LATEST_DATE}')
    `, true)
    copy('ml_feature_vectors_v2', `
      date=(SELECT MAX(date) FROM evidence.ml_feature_vectors_v2 WHERE date <= '${LATEST_DATE}')
    `, true)
    // Sealed research data is preserved, not recomputed. Hydrating the current
    // evidence lets the all-scope health gate prove that serving refresh did
    // not make those datasets stale or silently replace them.
    copy('ml_short_labels', `
      date=(SELECT MAX(date) FROM evidence.ml_short_labels WHERE date <= '${LATEST_DATE}')
    `)
    copy('rl_training_states_v2', `
      date=(SELECT MAX(date) FROM evidence.rl_training_states_v2 WHERE date <= '${LATEST_DATE}')
    `)
    copy('ml_physics_status_evaluations', `
      evaluation_date=(SELECT MAX(evaluation_date) FROM evidence.ml_physics_status_evaluations
                       WHERE evaluation_date <= '${LATEST_DATE}')
    `)
    copy('ml_rl_policy_evaluations', `
      evaluation_date=(SELECT MAX(evaluation_date) FROM evidence.ml_rl_policy_evaluations
                       WHERE evaluation_date <= '${LATEST_DATE}')
    `)
    target.exec('COMMIT')
    target.exec('DETACH DATABASE evidence')
  } catch (error) {
    try { target.exec('ROLLBACK') } catch { /* preserve the original error */ }
    throw error
  } finally {
    target.close()
  }
}

function hydrateApiServingCache(database: string): void {
  const cache = new DatabaseSync(database)
  try {
    cache.exec(`
      CREATE TABLE api_serving_cache(
        namespace TEXT NOT NULL, cache_key TEXT NOT NULL, payload_json TEXT NOT NULL,
        generated_at_ms INTEGER NOT NULL, expires_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
        PRIMARY KEY(namespace,cache_key)
      );
    `)
    const insert = cache.prepare(
      'INSERT INTO api_serving_cache VALUES(?,?,?,1,4102444800,1)',
    )
    for (const namespace of [
      'ml_pattern_search_v1', 'historical_analogs_period_v13', 'backtest_coverage_v2',
      'screener_built_rows_v3', 'period-explorer', 'us-screener-v10',
    ]) insert.run(namespace, `${namespace}-fixture`, '{}')
  } finally {
    cache.close()
  }
}

async function initialize(
  cli: Cli,
  official: OfficialEvidence,
  sourceTree: string,
  gitCommitSha: string,
  nodeModulesLockSha256: string,
): Promise<Receipt> {
  const target = new DatabaseSync(cli.database)
  try {
    const plan = createJpOhlcvRepairPlan({
      db: target,
      targetDate: official.date,
      priceBasis: official.priceBasis,
      providerContentSha256: official.sourceContract.contentSha256,
      officialRows: official.rows,
      preservedConflictKeys: ['1447:2026-07-17', '2164:2026-07-17'],
    })
    const planPath = path.join(path.dirname(cli.database), 'repair-plan.json')
    fs.writeFileSync(planPath, `${JSON.stringify(plan, null, 2)}\n`, { mode: 0o600 })
    const planDescriptor = fs.openSync(planPath, 'r')
    try { fs.fsyncSync(planDescriptor) } finally { fs.closeSync(planDescriptor) }
    const sealedPlan = JSON.parse(fs.readFileSync(planPath, 'utf8')) as JpOhlcvRepairPlan
    if (sealedPlan.approvalSha256 !== plan.approvalSha256) {
      throw new Error('sealed repair plan changed before apply')
    }
    const result = applyJpOhlcvRepairTransaction({ db: target, plan: sealedPlan, officialRows: official.rows })
    return {
      version: 1,
      status: 'DERIVED_PENDING',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      database: fs.realpathSync(cli.database),
      baseDatabase: fs.realpathSync(cli.base),
      metadataDatabase: fs.realpathSync(cli.metadata),
      officialEvidence: fs.realpathSync(cli.official),
      gitCommitSha,
      sourceTreeSha256: sourceTree,
      nodeModulesLockSha256,
      providerEnvelope: {
        provider: official.sourceContract.providerRows,
        accepted: official.sourceContract.acceptedRows,
        noTrade: official.sourceContract.noTradeRows,
        invalid: official.sourceContract.unexpectedRejectedRows,
      },
      source: {
        approvalSha256: result.approvalSha256,
        approved: result.approved,
        inserted: result.inserted,
        conflictsPreserved: result.conflictsPreserved,
        receiptId: result.receiptId,
      },
      stages: [],
      sealedResearch: sealedResearchFingerprint(target),
    }
  } catch (error) {
    throw error
  } finally {
    target.close()
  }
}

function stageCommand(script: string, args: string[] = [], nodeArgs: string[] = []): string[] {
  return [process.execPath, ...nodeArgs, '--import', process.env.STOCKBOARD_TSX_IMPORT ?? 'tsx', script, ...args]
}

// validate-only's receipt checks, run before any database is opened. Each
// receipt is read once, so its hash and parsed content come from the same
// bytes. Returns the final validation receipt this run attests; an existing
// one must already equal it.
export function bindValidateOnlyReceipts(input: {
  database: string
  receipt: string
  gitHeadSha: string
  sourceTreeSha256: string
  nodeModulesLockSha256: string
}): {
  receipt: Receipt
  plan: JpOhlcvRepairPlan
  gitCommitSha: string
  executionReceiptSha256: string
  approvalPackageSha256: string
  finalValidationPath: string
  finalValidation: JpRepairFinalValidationReceipt
} {
  const executionBytes = fs.readFileSync(input.receipt)
  const executionReceiptSha256 = createHash('sha256').update(executionBytes).digest('hex')
  const receipt = JSON.parse(executionBytes.toString('utf8')) as Receipt
  if (receipt.status !== 'PASS') throw new Error(`validate-only requires PASS; found ${receipt.status}`)
  const gitCommitSha = assertJpRepairExecutionCommit(receipt, input.gitHeadSha)
  if (receipt.sourceTreeSha256 !== input.sourceTreeSha256) {
    throw new Error('validate-only source tree does not match the execution receipt')
  }
  if (receipt.nodeModulesLockSha256 !== input.nodeModulesLockSha256) {
    throw new Error('validate-only installed dependencies do not match the execution receipt')
  }
  const packagePath = path.join(path.dirname(input.receipt), 'approval-package.json')
  const approvalPackageSha256 = receipt.approvalPackageSha256
  if (!approvalPackageSha256 || !fs.existsSync(packagePath)) {
    throw new Error('validate-only approval package is missing')
  }
  const packageBytes = fs.readFileSync(packagePath)
  if (createHash('sha256').update(packageBytes).digest('hex') !== approvalPackageSha256) {
    throw new Error('validate-only approval package changed')
  }
  const approvalPackage = JSON.parse(packageBytes.toString('utf8')) as {
    version?: number
    status?: string
    gitCommitSha?: string
    sourceTreeSha256?: string
    nodeModulesLockSha256?: string
    repairPlan?: { path?: string; sha256?: string; approvalSha256?: string }
    sourceIdentity?: unknown
  }
  if (approvalPackage.version !== 1
      || approvalPackage.status !== 'PASS'
      || approvalPackage.gitCommitSha !== gitCommitSha
      || approvalPackage.sourceTreeSha256 !== input.sourceTreeSha256
      || approvalPackage.nodeModulesLockSha256 !== input.nodeModulesLockSha256
      || JSON.stringify(approvalPackage.sourceIdentity) !== JSON.stringify(receipt.source)) {
    throw new Error('validate-only approval package is from another revision or source run')
  }
  const { binding: repairPlan, plan } = verifyJpRepairPlanBinding(
    path.join(path.dirname(input.database), 'repair-plan.json'),
    approvalPackage.repairPlan,
    receipt.source?.approvalSha256,
  )
  const validationPath = path.join(path.dirname(input.receipt), 'validation-receipt.json')
  if (!fs.existsSync(validationPath)) throw new Error('validate-only final validation receipt is missing')
  const validationBytes = fs.readFileSync(validationPath)
  const validation = JSON.parse(validationBytes.toString('utf8')) as {
    version?: number
    status?: string
    gitCommitSha?: string
    sourceTreeSha256?: string
    nodeModulesLockSha256?: string
    executionReceiptSha256?: string
    approvalPackageSha256?: string
    source?: unknown
    stageCount?: number
    sourcePhase?: string
    databaseIdentity?: Record<string, unknown>
    analogIdentity?: Record<string, unknown>
    servingCacheIdentity?: Record<string, unknown>
    analogContract?: { basename: string; metaVersion: number }
  }
  if (validation.version !== 1
      || validation.status !== 'PASS'
      || validation.gitCommitSha !== gitCommitSha
      || validation.sourceTreeSha256 !== input.sourceTreeSha256
      || validation.nodeModulesLockSha256 !== input.nodeModulesLockSha256
      || validation.executionReceiptSha256 !== executionReceiptSha256
      || validation.approvalPackageSha256 !== approvalPackageSha256
      || validation.stageCount !== receipt.stages.length
      || validation.sourcePhase !== 'derived_complete'
      || JSON.stringify(validation.analogContract) !== JSON.stringify(JP_REPAIR_ANALOG_CONTRACT)
      || !validation.servingCacheIdentity
      || JSON.stringify(validation.source) !== JSON.stringify(receipt.source)) {
    throw new Error('validate-only final validation receipt does not bind the completed execution')
  }
  const finalValidationPath = path.join(path.dirname(input.receipt), JP_REPAIR_FINAL_VALIDATION_RECEIPT_NAME)
  const finalValidation: JpRepairFinalValidationReceipt = {
    version: 1,
    status: 'PASS',
    gitCommitSha,
    sourceTreeSha256: input.sourceTreeSha256,
    nodeModulesLockSha256: input.nodeModulesLockSha256,
    repairPlan,
    executionReceiptSha256,
    validationReceiptSha256: createHash('sha256').update(validationBytes).digest('hex'),
    approvalPackageSha256,
    source: receipt.source,
    sourcePhase: 'derived_complete',
    stages: receipt.stages.map(({ name, status }) => ({ name, status })),
    databaseIdentity: validation.databaseIdentity,
    analogIdentity: validation.analogIdentity,
    servingCacheIdentity: validation.servingCacheIdentity,
    analogContract: JP_REPAIR_ANALOG_CONTRACT,
  }
  verifyExistingJpRepairFinalValidationReceipt(finalValidationPath, finalValidation)
  return {
    receipt, plan, gitCommitSha, executionReceiptSha256, approvalPackageSha256, finalValidationPath, finalValidation,
  }
}

export type JpRepairRehearsalHooks = {
  // Runs before each stage command that is not already checkpointed.
  beforeStage?: (name: string) => Promise<void>
  // Pins the receipt to the execution gate's binding; absent for a plain rehearsal.
  executorBindingSha256?: string
}

// The execution gate's workflow: this same rehearsal (its 28 stages and its
// receipt as the only checkpoint) run on the gate's targets, with the writer
// hold re-validated before every stage. It never resets or validates-only.
export function jpRepairRehearsalWorkflow(cli: Cli): (context: JpRepairWorkflowContext) => Promise<void> {
  return async (context) => {
    if (cli.reset || cli.validateOnly) throw new Error('the execution gate never resets or validates-only a rehearsal')
    const same = (left: string, right: string) => path.resolve(left) === path.resolve(right)
    if (!same(cli.database, context.targets.database) || !same(cli.analog, context.targets.analog)
        || !same(cli.servingCache, context.targets.servingCache)
        || !same(path.dirname(cli.receipt), context.checkpointDirectory)) {
      throw new Error('rehearsal paths are not the execution gate targets and checkpoint directory')
    }
    await runJpLocalRepairRehearsal(cli, {
      beforeStage: () => context.assertHoldValid(),
      executorBindingSha256: context.bindingSha256,
    })
  }
}

export async function runJpLocalRepairRehearsal(cli: Cli, hooks: JpRepairRehearsalHooks = {}): Promise<void> {
  for (const output of [cli.database, cli.analog, cli.servingCache, cli.receipt]) assertTemporary(output)
  if (!fs.existsSync(cli.base) || !fs.existsSync(cli.metadata) || !fs.existsSync(cli.official)) {
    throw new Error('base, metadata, and official evidence must already exist')
  }
  const official = JSON.parse(fs.readFileSync(cli.official, 'utf8')) as OfficialEvidence
  if (official.date !== TARGET_DATE
      || official.rows.length !== 4_218
      || official.sourceContract.providerRows !== 4_442
      || official.sourceContract.acceptedRows !== 4_218
      || official.sourceContract.noTradeRows !== 224
      || official.sourceContract.unexpectedRejectedRows !== 0) {
    throw new Error('official provider envelope is not the sealed repair input')
  }

  if (cli.validateOnly) {
    if (!fs.existsSync(cli.database) || !fs.existsSync(cli.analog) || !fs.existsSync(cli.receipt)) {
      throw new Error('validate-only requires the completed database, analog database, and receipt')
    }
    const currentSourceTree = sourceTreeSha256()
    const currentNodeModulesLock = jpRepairNodeModulesLockSha256(process.cwd())
    const {
      receipt, plan, gitCommitSha, executionReceiptSha256, approvalPackageSha256, finalValidationPath, finalValidation,
    } = bindValidateOnlyReceipts({
      database: cli.database,
      receipt: cli.receipt,
      gitHeadSha: gitHeadSha(),
      sourceTreeSha256: currentSourceTree,
      nodeModulesLockSha256: currentNodeModulesLock,
    })
    const plannedTickers = plan.approvedMissingKeys.map((key) => key.split(':')[0]).sort()
    assertCompleteStageReceipts(receipt, valuationChunkIdentities(plannedTickers))
    const databaseIdentityBeforeValidation = identifyJpOhlcvDatabaseContent(cli.database)
    const analogIdentityBeforeValidation = identifyJpOhlcvDatabaseContent(cli.analog)
    const servingCacheIdentityBeforeValidation = identifyJpOhlcvDatabaseContent(cli.servingCache)
    if (JSON.stringify(finalValidation.databaseIdentity) !== JSON.stringify(databaseIdentityBeforeValidation)
        || JSON.stringify(finalValidation.analogIdentity) !== JSON.stringify(analogIdentityBeforeValidation)
        || JSON.stringify(finalValidation.servingCacheIdentity) !== JSON.stringify(servingCacheIdentityBeforeValidation)) {
      throw new Error('validate-only database identity changed after final validation')
    }
    assertQuickCheck(cli.database)
    assertQuickCheck(cli.analog)
    assertQuickCheck(cli.servingCache)
    const finalChecks = validateFinalState(
      cli,
      official,
      receipt,
      'derived_complete',
      approvalPackageSha256,
    )
    if (JSON.stringify(databaseIdentityBeforeValidation) !== JSON.stringify(identifyJpOhlcvDatabaseContent(cli.database))
        || JSON.stringify(analogIdentityBeforeValidation) !== JSON.stringify(identifyJpOhlcvDatabaseContent(cli.analog))
        || JSON.stringify(servingCacheIdentityBeforeValidation) !== JSON.stringify(identifyJpOhlcvDatabaseContent(cli.servingCache))) {
      throw new Error('validate-only database content changed during final validation')
    }
    // Written once after the first PASS; a rerun must reproduce it exactly.
    assertRevisionUnchanged(gitCommitSha, currentSourceTree, currentNodeModulesLock)
    persistFinalValidationReceipt(finalValidationPath, finalValidation)
    // The receipt attests these identities; they must still hold after it lands.
    // On mismatch the receipt is kept as evidence; only --reset clears it.
    if (JSON.stringify(finalValidation.databaseIdentity) !== JSON.stringify(identifyJpOhlcvDatabaseContent(cli.database))
        || JSON.stringify(finalValidation.analogIdentity) !== JSON.stringify(identifyJpOhlcvDatabaseContent(cli.analog))
        || JSON.stringify(finalValidation.servingCacheIdentity) !== JSON.stringify(identifyJpOhlcvDatabaseContent(cli.servingCache))) {
      throw new Error('validate-only database content changed while the final validation receipt was written; rerun with --reset to start a new rehearsal')
    }
    console.log(JSON.stringify({
      status: 'PASS',
      gitCommitSha,
      sourceReceiptSha256: executionReceiptSha256,
      approvalPackageSha256,
      finalValidationReceiptSha256: fileSha256(finalValidationPath),
      stageCount: receipt.stages.length,
      finalChecks,
    }, null, 2))
    return
  }

  if (cli.reset) {
    const apiServingCache = cli.servingCache
    const generated = [
      'repair-plan.json',
      'trigger-delta-receipt.json', 'large-holder-impact-receipt.json',
      'forward-returns-impact-receipt.json', 'forward-returns-quarantine.sqlite',
      'forward-returns-quarantine-receipt.json', 'serving-cache-purge-receipt.json',
      'validation-receipt.json', 'approval-package.json', JP_REPAIR_FINAL_VALIDATION_RECEIPT_NAME,
    ].map((file) => path.join(path.dirname(cli.database), file))
    for (const file of [cli.database, `${cli.database}-wal`, `${cli.database}-shm`, cli.analog, `${cli.analog}-wal`, `${cli.analog}-shm`, apiServingCache, `${apiServingCache}-wal`, `${apiServingCache}-shm`, cli.receipt, ...generated]) {
      if (fs.existsSync(file)) fs.rmSync(file)
    }
    const checkpoints = path.join(path.dirname(cli.database), 'checkpoints')
    if (fs.existsSync(checkpoints)) fs.rmSync(checkpoints, { recursive: true })
  }
  // A validated rehearsal is closed: resuming it would rewrite receipts the
  // final validation receipt binds. lstat also catches a dangling symlink.
  if (fs.lstatSync(path.join(path.dirname(cli.receipt), JP_REPAIR_FINAL_VALIDATION_RECEIPT_NAME),
    { throwIfNoEntry: false })) {
    throw new Error('final validation receipt exists; rerun with --reset to start a new rehearsal')
  }
  const sourceTree = sourceTreeSha256()
  const head = gitHeadSha()
  const nodeModulesLockSha256 = jpRepairNodeModulesLockSha256(process.cwd())
  const fresh = !fs.existsSync(cli.receipt)
  if (fresh) {
    fs.mkdirSync(path.dirname(cli.database), { recursive: true })
    fs.copyFileSync(cli.base, cli.database)
    fs.chmodSync(cli.database, 0o600)
  }
  // Every child (schema, lock holder, stages) inherits only the pinned paths.
  const stageEnvironment = jpRepairStageEnvironment(process.env, {
    database: cli.database, servingCache: cli.servingCache, analog: cli.analog,
    analogMetaVersion: JP_REPAIR_ANALOG_CONTRACT.metaVersion,
  })
  for (const name of JP_REPAIR_STAGE_UNSET_ENVIRONMENT) delete process.env[name]
  Object.assign(process.env, stageEnvironment)
  if (fresh) {
    // Fixture-only schema preparation and hydration happen before the measured
    // maintenance lease. Production already contains these tables and data.
    const schema = await runStageCommand({
      command: stageCommand('scripts/ensure-local-schema.ts'),
      env: {
        ...process.env,
        USE_LOCAL_DB: '1',
        STOCKBOARD_DB_PATH: cli.database,
        SKIP_SCHEMA_ENSURE: '0',
      },
      database: cli.database,
    })
    if (schema.status !== 0) {
      throw new Error(`fixture schema initialization failed: ${schema.stderr || schema.stdout}`)
    }
    hydrateScreenerInputs(cli.database, cli.metadata)
    hydrateApiServingCache(cli.servingCache)
    checkpointNativeWriter(cli.database)
  }
  // A stage left in flight holds before the maintenance lock is even taken.
  if (!fresh) assertNoJpRepairStageInFlight(readReceipt(cli.receipt))
  const parentLock = await startMaintenanceLockHolder(cli.database)
  try {
    let receipt = fs.existsSync(cli.receipt)
      ? readReceipt(cli.receipt)
      : { ...await initialize(cli, official, sourceTree, head, nodeModulesLockSha256),
        executorBindingSha256: hooks.executorBindingSha256 }
    if (receipt.executorBindingSha256 !== hooks.executorBindingSha256) {
      throw new Error('rehearsal receipt belongs to another execution-gate binding; rerun with --reset instead of mixing runs')
    }
    if (fresh) checkpointNativeWriter(cli.database)
    if (receipt.sourceTreeSha256 !== sourceTree) {
      throw new Error('rehearsal source tree changed; rerun with --reset instead of mixing revisions')
    }
    if (receipt.nodeModulesLockSha256 !== nodeModulesLockSha256) {
      throw new Error('rehearsal installed dependencies changed; rerun with --reset instead of mixing dependency sets')
    }
    const gitCommitSha = assertJpRepairExecutionCommit(receipt, head)
    writeReceipt(cli.receipt, receipt)
    const baseline = new DatabaseSync(cli.base, { readOnly: true })
    const existingKeys = new Set<string>()
    try {
      const rows = baseline.prepare('SELECT ticker,date FROM ohlcv_daily WHERE date=?')
        .all(TARGET_DATE) as Array<{ ticker: string; date: string }>
      for (const row of rows) existingKeys.add(`${row.ticker}:${row.date}`)
    } finally {
      baseline.close()
    }
    const tickers = official.rows
      .filter((row) => !existingKeys.has(`${row.ticker}:${row.date}`))
      .map((row) => row.ticker)
      .sort()
    if (tickers.length !== 4_061) throw new Error(`unexpected affected ticker count: ${tickers.length}`)

  const common = {
    ...stageEnvironment,
    SKIP_SCHEMA_ENSURE: '1',
    TICKERS: tickers.join(','),
    STOCKBOARD_PARENT_MAINTENANCE_OWNER: parentLock.owner,
    STOCKBOARD_PARENT_UPDATE_LOCK_JOB_TYPE: 'db_maintenance',
    STOCKBOARD_PARENT_UPDATE_LOCK_OWNER: parentLock.owner,
  }
  const valuationChunks = chunkJpOhlcvRepairTickers(tickers, VALUATION_CHUNK_SIZE).map((chunk) => ({
    env: { VALUATION_SERVING_TICKERS: chunk.join(',') },
    tickerCount: chunk.length,
    tickersSha256: jpOhlcvValueSha256(chunk),
  }))
  const prePublicationStages: StageDefinition[] = [
    {
      name: 'snapshots',
      command: stageCommand('scripts/batch-snapshots.ts'),
      env: { SNAPSHOT_RECOMPUTE_FROM_DATE: TARGET_DATE, SNAPSHOT_CONCURRENCY: '8' },
    },
    {
      name: 'features_rebuilt',
      command: stageCommand('scripts/batch-features.ts'),
      env: { FEATURE_RECOMPUTE_FROM_DATE: TARGET_DATE },
    },
    {
      name: 'weekly_replacement',
      command: stageCommand('scripts/batch-weekly-ohlcv.ts'),
      env: { WEEKLY_RECOMPUTE_FROM_DATE: TARGET_DATE },
    },
    {
      name: 'monthly',
      command: stageCommand('scripts/batch-monthly-ma-monitor.ts'),
      env: { MONTHLY_MA_MONITOR_RECOMPUTE_FROM_DATE: TARGET_DATE },
    },
    { name: 'sector_structure', command: stageCommand('scripts/batch-sector-structure.ts'), env: { SECTOR_STRUCTURE_SKIP_LOCK: '1', SECTOR_STRUCTURE_LOOKBACK_DAYS: '180' } },
    { name: 'physical_momentum', command: stageCommand('scripts/batch-physical-momentum.ts'), env: { PMS_MARKETS: 'JP', PMS_START_DATE: TARGET_DATE, PMS_END_DATE: LATEST_DATE, PMS_DELETE_EXISTING: '1' } },
    {
      name: 'technical_rebuilt',
      command: stageCommand('scripts/batch-technical-signals.ts'),
      env: { BACKTEST_RECENT_DAYS: '100', TECHNICAL_SIGNAL_PROCESS_CONCURRENCY: '2' },
    },
    {
      name: 'forward_extrema_complete',
      command: stageCommand('scripts/batch-forward-extrema.ts'),
      env: {
        FORWARD_EXTREMA_START_DATE: '2025-09-01',
        FORWARD_EXTREMA_END_DATE: LATEST_DATE,
        FORWARD_EXTREMA_HORIZONS: '5,10,15,20,30,40,60,90,180,200',
        FORWARD_EXTREMA_WRITE_MODEL_LABELS: '0',
        FORWARD_EXTREMA_INCREMENTAL_UPSERT: '1',
        FORWARD_EXTREMA_RESUME: '1',
        STOCKBOARD_CHECKPOINT_DIR: path.join(path.dirname(cli.database), 'checkpoints'),
      },
    },
    {
      name: 'forward_returns_rebuilt',
      command: stageCommand('scripts/batch-forward-returns.ts'),
      env: {
        FORWARD_RETURN_HORIZONS: '2,3,4,5,10,15,20,30,40,60,90,180,200',
        // A 200-session return ending after the repaired session can begin in
        // early May 2025 for thinly traded symbols. Keep a conservative month
        // of margin so the final audit, rather than a guessed calendar date,
        // defines the complete affected window.
        FORWARD_RETURN_RECOMPUTE_FROM_DATE: '2025-04-01',
        FORWARD_RETURN_RECOMPUTE_TO_DATE: TARGET_DATE,
        FORWARD_RETURNS_TICKER_CHUNK_SIZE: '200',
      },
    },
    {
      name: 'pattern_stats_rebuilt',
      command: stageCommand('scripts/batch-pattern-stats.ts'),
      env: { PATTERN_STAT_HORIZONS: '2,3,4,5,10,15,20,30,40,60,90,180,200' },
    },
    {
      name: 'signal_stats_rebuilt',
      command: stageCommand('scripts/batch-signal-stats.ts'),
      env: {
        SIGNAL_STATS_DIRECT_AGGREGATE: '1',
        SIGNAL_STATS_NATIVE_PARALLEL: '2',
        SIGNAL_STATS_LIMIT_GROUPS: '0',
        BACKTEST_RECENT_DAYS: '0',
      },
    },
    {
      name: 'signal_return_stats_rebuilt',
      command: stageCommand('scripts/batch-signal-return-stats.ts'),
      env: {
        SIGNAL_RETURN_HORIZONS: '2,3,4,5,10,15,20,30,40,60,90,180,200',
        SIGNAL_RETURN_NATIVE_PARALLEL: '2',
        BACKTEST_RECENT_DAYS: '0',
      },
    },
    {
      name: 'backtest_260',
      command: stageCommand('scripts/build-serving-backtest.ts'),
      env: { SERVING_DATE_LIMIT: '260', SERVING_DETAIL_PER_DATE_HORIZON: '20' },
    },
    { name: 'stages_rebuilt', command: stageCommand('scripts/batch-stage-transitions.ts'), env: { STAGE_TRANSITIONS_LOCK_WAIT_HOURS: '1' } },
    {
      name: 'valuation',
      command: stageCommand('scripts/backfill-valuation-serving.ts', [], ['--expose-gc']),
      env: {
        VALUATION_SERVING_YEARS: '5',
        VALUATION_SERVING_FORCE: '1',
      },
      chunks: valuationChunks,
    },
    { name: 'screener_rebuilt', command: stageCommand('scripts/backfill-integrated-screener.ts', [LATEST_DATE, '--force']) },
    { name: 'serving_stock', command: stageCommand('scripts/build-serving-stock.ts') },
    { name: 'historical_universe_rebuilt', command: stageCommand('scripts/build-historical-universe.ts') },
    { name: 'saved_screening_evaluations', command: stageCommand('scripts/evaluate-saved-screeners.ts') },
    {
      name: 'serving_cache_purged',
      command: stageCommand('scripts/rehearse-jp-repair-cache-purge.ts', [
        '--database', cli.database,
        '--target-date', TARGET_DATE,
        '--api-serving-cache', cli.servingCache,
        '--output', path.join(path.dirname(cli.database), 'serving-cache-purge-receipt.json'),
        '--apply',
      ]),
      env: { JP_REPAIR_REHEARSAL: '1' },
    },
    { name: 'dashboard_rebuilt', command: stageCommand('scripts/build-dashboard-cache.ts') },
    {
      name: 'trigger_delta',
      command: stageCommand('scripts/rehearse-jp-repair-trigger-delta.ts', [
        '--baseline', cli.metadata,
        '--as-of', LATEST_DATE,
        '--repair-key', receipt.source!.approvalSha256,
        '--output', path.join(path.dirname(cli.database), 'trigger-delta-receipt.json'),
      ]),
    },
    {
      name: 'large_holder_verified',
      command: stageCommand('scripts/audit-jp-repair-large-holder-impact.ts', [
        '--database', cli.database,
        '--baseline', cli.metadata,
        '--output', path.join(path.dirname(cli.database), 'large-holder-impact-receipt.json'),
      ]),
    },
    {
      name: 'forward_returns_impact',
      command: stageCommand('scripts/audit-jp-repair-forward-returns.ts', [
        '--database', cli.database,
        '--baseline', cli.metadata,
        '--official', cli.official,
        '--output', path.join(path.dirname(cli.database), 'forward-returns-impact-receipt.json'),
      ]),
    },
    { name: 'coverage_verified', command: stageCommand('scripts/guard-data-freshness.ts'), env: { DATA_FRESHNESS_GUARD_DRY_RUN: '1' } },
    { name: 'analog', command: stageCommand('scripts/build-analog-sequence-index.ts', ['JP', 'full']), env: { ANALOG_HIGH_PRIORITY: '1' } },
    {
      name: 'ml_serving_current',
      command: stageCommand('scripts/run-ml-serving-fast.ts'),
      env: {
        ML_DAILY_REFRESH_PHYSICS_STATUS: '0',
        ML_DAILY_FORCE_CURRENT_TICKERS: tickers.join(','),
        ML_DAILY_HISTORY_RECOMPUTE_FROM_DATE: TARGET_DATE,
        ML_DAILY_HEALTH_SCOPE: 'serving',
        ML_FRESHNESS_WARN_DAYS: '1',
        ML_FRESHNESS_FAIL_DAYS: '1',
      },
    },
  ]

  const runStages = async (
    stages: StageDefinition[],
  ): Promise<void> => {
    for (const stage of stages) {
    const sealedFiles = sealedCommandFiles(stage.command)
    if (jpRepairStagePassed(receipt, stage.name, sealedFiles)) continue
    if (cli.failBeforeStage === stage.name) {
      receipt.status = 'HOLD'
      writeReceipt(cli.receipt, receipt)
      throw new Error(`injected failure before ${stage.name}`)
    }
    await hooks.beforeStage?.(stage.name)
    parentLock.assertActive()
    const started = Date.now()
    const databaseBytesBefore = bytes(cli.database)
    const walBytesBefore = bytes(`${cli.database}-wal`)
    const allocatedBytesBefore = databaseBundleAllocatedBytes(cli.database)
    const executions = stage.chunks ?? [{
      env: {},
      tickerCount: 0,
      tickersSha256: '',
    }]
    const chunkReceipts: StageChunkReceipt[] = []
    let exitCode: number | null = 0
    let signal: NodeJS.Signals | null = null
    let rssBytesPeak = 0
    let walBytesPeak = walBytesBefore
    let allocatedBytesPeak = allocatedBytesBefore
    let stdoutTail = ''
    let stderrTail = ''
    beginJpRepairStage(cli.receipt, receipt, stage.name)
    for (const [index, execution] of executions.entries()) {
      parentLock.assertActive()
      const chunkStarted = Date.now()
      const result = await runStageCommand({
        command: stage.command,
        env: { ...common, ...(stage.env ?? {}), ...execution.env },
        database: cli.database,
        barrier: parentLock,
      })
      const status = result.status === 0 && result.signal === null ? 'PASS' : 'FAIL'
      chunkReceipts.push({
        index,
        tickerCount: execution.tickerCount,
        tickersSha256: execution.tickersSha256,
        startedAt: new Date(chunkStarted).toISOString(),
        finishedAt: new Date().toISOString(),
        durationMs: Date.now() - chunkStarted,
        status,
        exitCode: result.status,
        signal: result.signal,
        rssBytesPeak: result.rssBytesPeak,
        walBytesPeak: result.walBytesPeak,
        allocatedBytesPeak: result.allocatedBytesPeak,
        stdoutTail: result.stdout,
        stderrTail: result.stderr,
      })
      exitCode = result.status
      signal = result.signal
      rssBytesPeak = Math.max(rssBytesPeak, result.rssBytesPeak)
      walBytesPeak = Math.max(walBytesPeak, result.walBytesPeak)
      allocatedBytesPeak = Math.max(allocatedBytesPeak, result.allocatedBytesPeak)
      stdoutTail = tail(`${stdoutTail}\n${result.stdout}`)
      stderrTail = tail(`${stderrTail}\n${result.stderr}`)
      if (status === 'FAIL') break
    }
    const item: StageReceipt = {
      name: stage.name,
      command: stage.command,
      sealedFiles,
      startedAt: new Date(started).toISOString(),
      finishedAt: new Date().toISOString(),
      durationMs: Date.now() - started,
      status: exitCode === 0 && signal === null && chunkReceipts.length === executions.length ? 'PASS' : 'FAIL',
      exitCode,
      signal,
      rssBytesPeak,
      databaseBytesBefore,
      databaseBytesAfter: bytes(cli.database),
      walBytesBefore,
      walBytesAfter: bytes(`${cli.database}-wal`),
      walBytesPeak,
      allocatedBytesBefore,
      allocatedBytesAfter: databaseBundleAllocatedBytes(cli.database),
      allocatedBytesPeak,
      observedRows: stage.name === 'analog'
        ? { analog_sequence_index: tableCount(cli.analog, 'analog_sequence_index') }
        : observedRows(cli.database, stage.name),
      stdoutTail,
      stderrTail,
      chunks: stage.chunks ? chunkReceipts : undefined,
    }
    if (item.status === 'PASS') {
      // Never persist PASS for work performed by a changed checkout or dependency set.
      assertRevisionUnchanged(gitCommitSha, sourceTree, nodeModulesLockSha256)
    }
    recordJpRepairStage(cli.receipt, receipt, item)
    if (item.status === 'FAIL') throw new Error(`${stage.name} failed: ${item.stderrTail || item.stdoutTail}`)
    }
  }

  await runStages(prePublicationStages)
    if (!receipt.source) throw new Error('source repair receipt is missing')
    await runStages([
      {
        name: 'two_year_published',
        command: stageCommand('scripts/build-two-year-line-serving.ts'),
        env: {
          TWO_YEAR_LINE_SERVING_MARKET: 'JP',
          TWO_YEAR_LINE_SERVING_AS_OF: LATEST_DATE,
          TWO_YEAR_LINE_PENDING_SOURCE_RUN_ID: String(receipt.source.receiptId),
        },
      },
    ])

    assertCompleteStageReceipts(receipt, valuationChunkIdentities(tickers))

    assertQuickCheck(cli.database)
    assertQuickCheck(cli.analog)
    receipt = readReceipt(cli.receipt)
    const source = receipt.source
    if (!source) throw new Error('source repair receipt disappeared before finalization')
    const pendingChecks = validateFinalState(cli, official, receipt, 'derived_pending')
    const planPath = path.join(path.dirname(cli.database), 'repair-plan.json')
    const plan = JSON.parse(fs.readFileSync(planPath, 'utf8')) as JpOhlcvRepairPlan
    const priceBasisEvidence = verifyPriceBasisEvidence(cli, official, plan)
    const forwardReturnEvidence = assertForwardReturnReceipt(
      path.join(path.dirname(cli.database), 'forward-returns-impact-receipt.json'),
    )
    receipt.finalChecks = pendingChecks
    receipt.status = 'DERIVED_PENDING'
    delete receipt.holdReason
    writeReceipt(cli.receipt, receipt)
    const executionReceiptSha256 = fileSha256(cli.receipt)

    const packagePath = path.join(path.dirname(cli.receipt), 'approval-package.json')
    const approvalPackage = {
      version: 1,
      status: 'PASS',
      createdAt: new Date().toISOString(),
      gitCommitSha,
      sourceTreeSha256: sourceTree,
      nodeModulesLockSha256,
      officialEvidence: { path: fs.realpathSync(cli.official), sha256: fileSha256(cli.official) },
      providerContentSha256: official.sourceContract.contentSha256,
      priceBasisEvidence,
      repairPlan: {
        path: fs.realpathSync(planPath),
        sha256: fileSha256(planPath),
        approvalSha256: plan.approvalSha256,
      },
      pendingExecutionReceiptSha256: executionReceiptSha256,
      sourceIdentity: receipt.source,
      stages: receipt.stages.map((stage) => ({
        name: stage.name,
        status: stage.status,
        sealedFiles: stage.sealedFiles,
        chunks: stage.chunks,
      })),
      databaseIdentity: databaseBundleIdentity(cli.database),
      databaseIdentityPhase: 'derived_pending_before_single_batch_run_promotion',
      analogIdentity: databaseBundleIdentity(cli.analog),
      servingCacheIdentity: databaseBundleIdentity(cli.servingCache),
      analogContract: JP_REPAIR_ANALOG_CONTRACT,
      forwardReturnEvidence,
      finalChecks: pendingChecks,
    }
    assertRevisionUnchanged(gitCommitSha, sourceTree, nodeModulesLockSha256)
    writeJsonAtomic(packagePath, approvalPackage)
    const approvalPackageSha256 = fileSha256(packagePath)
    const completed = new DatabaseSync(cli.database)
    try {
      completeJpOhlcvRepairDerived({
        db: completed,
        receiptId: source.receiptId,
        approvalSha256: source.approvalSha256,
        publicationEvidenceSha256: approvalPackageSha256,
      })
    } finally {
      completed.close()
    }
    await parentLock.release()
    checkpointWalHandoff(cli.database)
    checkpointWalHandoff(cli.analog)
    checkpointWalHandoff(cli.servingCache)
    const databaseIdentityBeforeValidation = identifyJpOhlcvDatabaseContent(cli.database)
    const analogIdentityBeforeValidation = identifyJpOhlcvDatabaseContent(cli.analog)
    const servingCacheIdentityBeforeValidation = identifyJpOhlcvDatabaseContent(cli.servingCache)
    assertQuickCheck(cli.database)
    assertQuickCheck(cli.analog)
    assertQuickCheck(cli.servingCache)
    const finalChecks = validateFinalState(
      cli,
      official,
      receipt,
      'derived_complete',
      approvalPackageSha256,
    )
    if (JSON.stringify(databaseIdentityBeforeValidation) !== JSON.stringify(identifyJpOhlcvDatabaseContent(cli.database))
        || JSON.stringify(analogIdentityBeforeValidation) !== JSON.stringify(identifyJpOhlcvDatabaseContent(cli.analog))
        || JSON.stringify(servingCacheIdentityBeforeValidation) !== JSON.stringify(identifyJpOhlcvDatabaseContent(cli.servingCache))) {
      throw new Error('database content changed during final validation')
    }
    receipt.finalChecks = finalChecks
    receipt.status = 'PASS'
    receipt.approvalPackageSha256 = approvalPackageSha256
    writeReceipt(cli.receipt, receipt)
    const validationPath = path.join(path.dirname(cli.receipt), 'validation-receipt.json')
    assertRevisionUnchanged(gitCommitSha, sourceTree, nodeModulesLockSha256)
    writeJsonAtomic(validationPath, {
      version: 1,
      status: 'PASS',
      createdAt: new Date().toISOString(),
      gitCommitSha,
      sourceTreeSha256: sourceTree,
      nodeModulesLockSha256,
      executionReceiptSha256: fileSha256(cli.receipt),
      approvalPackageSha256,
      source: receipt.source,
      stageCount: receipt.stages.length,
      sourcePhase: 'derived_complete',
      databaseIdentity: databaseIdentityBeforeValidation,
      analogIdentity: analogIdentityBeforeValidation,
      servingCacheIdentity: servingCacheIdentityBeforeValidation,
      analogContract: JP_REPAIR_ANALOG_CONTRACT,
      finalChecks,
    })
  } catch (error) {
    if (fs.existsSync(cli.receipt)) {
      const held = readReceipt(cli.receipt)
      held.status = 'HOLD'
      held.holdReason = error instanceof Error ? error.message : String(error)
      writeReceipt(cli.receipt, held)
    }
    throw error
  } finally {
    await parentLock.release()
  }
  console.log(JSON.stringify(readReceipt(cli.receipt), null, 2))
}

// Run only as the entry point; the readiness test imports the validate-only
// wiring without starting a rehearsal.
if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) {
  runJpLocalRepairRehearsal(parseCli()).catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
}
