import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import os from 'node:os'
import type { Client, Transaction } from '@libsql/client'
import { assertJpOhlcvDailyIngestionReceipt, type JpOhlcvDailyIngestionReceipt } from '@/lib/jp-ohlcv-daily-ingestion-receipt'
import { loadJpOhlcvCoverageHead } from '@/lib/jp-ohlcv-coverage-store'
import {
  normalizeJpOhlcvTicker,
  sortJpOhlcvRows,
  stableSha256,
  type JpOhlcvValue,
} from '@/lib/jp-ohlcv-data-quality'

type Executor = Pick<Client | Transaction, 'execute'>
type ProcessIdentity = { pid: number; startedAt: string; processGroupId: number | null }
type ProcessProbe =
  | { status: 'LIVE'; startedAt: string; processGroupId: number }
  | { status: 'DEAD' | 'UNKNOWN' }

export type JpOhlcvSourceRunExecutionIdentity = {
  version: 1
  kind: 'JP_OHLCV_SOURCE_RUN_EXECUTION'
  sourceRunId: number
  syncRunId: number
  targetDate: string
  runToken: string
  ownerHost: string
  owner: ProcessIdentity
  activeChild: ProcessIdentity | null
  startingCoverageHeadSha256: string
  startingProjectionSha256: string
  targetBeforeSha256: string
  previousSuccessfulSourceRunId: number | null
  previousSuccessfulSourceRunSha256: string | null
  identitySha256: string
}

export type JpOhlcvRunningSourceRunRecoveryStatus = {
  version: 1
  sourceRunId: number
  runStatus: string
  targetDate: string | null
  receiptSha256: string | null
  projectionSha256: string | null
  bindingSha256: string | null
  syncRunId: number | null
  executionIdentitySha256: string | null
  ownerPid: number | null
  activeChildPid: number | null
  activeChildProcessGroupId: number | null
  previousSuccessfulSourceRunId: number | null
  previousSuccessfulSourceRunSha256: string | null
  disposition:
    | 'RECOVERABLE_PRE_RECEIPT_TO_PARTIAL'
    | 'RECOVERABLE_POST_RECEIPT_TO_PARTIAL'
    | 'HOLD_WRITER_ACTIVE'
    | 'HOLD_IDENTITY_MISMATCH'
    | 'HOLD_AFTER_STATE_CHANGED'
    | 'HOLD_SYNC_AMBIGUOUS'
    | 'FINALIZED'
    | 'MISSING'
  reasons: string[]
  statusSha256: string
}

function buildStatus(
  input: Omit<JpOhlcvRunningSourceRunRecoveryStatus, 'version' | 'statusSha256'>,
): JpOhlcvRunningSourceRunRecoveryStatus {
  const body = { version: 1 as const, ...input }
  return { ...body, statusSha256: stableSha256(body) }
}

function probeProcess(pid: number): ProcessProbe {
  if (!Number.isSafeInteger(pid) || pid <= 0) return { status: 'UNKNOWN' }
  const arguments_ = process.env.NODE_ENV === 'test'
    && process.env.JP_OHLCV_TEST_PROCESS_PROBE_MODE === 'INVALID_PS_OPTION'
    ? ['-o', 'stockboard_invalid_ps_field=', '-p', String(pid)]
    : ['-o', 'lstart=', '-o', 'pgid=', '-p', String(pid)]
  const result = spawnSync('/bin/ps', arguments_, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, TZ: 'UTC', LC_ALL: 'C' },
  })
  const output = result.stdout.trim()
  const errorOutput = result.stderr.trim()
  if (!result.error && result.status === 1 && output === '' && errorOutput === '') return { status: 'DEAD' }
  if (result.error || result.status !== 0 || output === '') return { status: 'UNKNOWN' }
  const match = /^(.*\d{4})\s+(\d+)$/.exec(output)
  if (!match) return { status: 'UNKNOWN' }
  return { status: 'LIVE', startedAt: match[1].trim(), processGroupId: Number(match[2]) }
}

function currentProcessIdentity(pid: number, expectedProcessGroupId: number | null = null): ProcessIdentity {
  const probe = probeProcess(pid)
  if (probe.status !== 'LIVE') throw new Error(`jp_ohlcv_process_identity_unavailable:${pid}`)
  if (expectedProcessGroupId !== null && probe.processGroupId !== expectedProcessGroupId) {
    throw new Error(`jp_ohlcv_process_group_identity_mismatch:${pid}`)
  }
  return { pid, startedAt: probe.startedAt, processGroupId: expectedProcessGroupId }
}

export function jpOhlcvProcessGroupStatus(processGroupId: number): 'LIVE' | 'DEAD' | 'UNKNOWN' {
  try {
    process.kill(-processGroupId, 0)
    return 'LIVE'
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    return code === 'ESRCH' ? 'DEAD' : 'UNKNOWN'
  }
}

function processIdentityStatus(identity: ProcessIdentity): 'LIVE' | 'DEAD' | 'UNKNOWN' {
  if (identity.processGroupId !== null) return jpOhlcvProcessGroupStatus(identity.processGroupId)
  const probe = probeProcess(identity.pid)
  if (probe.status !== 'LIVE') return probe.status
  return probe.startedAt === identity.startedAt ? 'LIVE' : 'DEAD'
}

function sealExecutionIdentity(
  identity: Omit<JpOhlcvSourceRunExecutionIdentity, 'identitySha256'>,
): JpOhlcvSourceRunExecutionIdentity {
  return { ...identity, identitySha256: stableSha256(identity) }
}

function parseExecutionIdentity(value: unknown): JpOhlcvSourceRunExecutionIdentity {
  const parsed = JSON.parse(String(value)) as JpOhlcvSourceRunExecutionIdentity
  const { identitySha256, ...body } = parsed
  if (parsed.version !== 1
    || parsed.kind !== 'JP_OHLCV_SOURCE_RUN_EXECUTION'
    || !Number.isSafeInteger(parsed.sourceRunId)
    || !Number.isSafeInteger(parsed.syncRunId)
    || !/^[0-9a-f-]{36}$/.test(parsed.runToken)
    || !/^[a-f0-9]{64}$/.test(parsed.startingCoverageHeadSha256)
    || !/^[a-f0-9]{64}$/.test(parsed.startingProjectionSha256)
    || !/^[a-f0-9]{64}$/.test(parsed.targetBeforeSha256)
    || parsed.owner.processGroupId !== null
    || (parsed.activeChild !== null
      && (!Number.isSafeInteger(parsed.activeChild.processGroupId)
        || parsed.activeChild.processGroupId !== parsed.activeChild.pid))
    || (parsed.previousSuccessfulSourceRunId === null) !== (parsed.previousSuccessfulSourceRunSha256 === null)
    || (parsed.previousSuccessfulSourceRunId !== null
      && (!Number.isSafeInteger(parsed.previousSuccessfulSourceRunId)
        || !/^[a-f0-9]{64}$/.test(parsed.previousSuccessfulSourceRunSha256 ?? '')))
    || stableSha256(body) !== identitySha256) {
    throw new Error('jp_ohlcv_source_run_execution_identity_invalid')
  }
  return parsed
}

async function targetDateSha256(executor: Executor, targetDate: string): Promise<string> {
  const rows = await executor.execute({
    sql: `SELECT ticker, date, open, high, low, close, volume
          FROM ohlcv_daily WHERE date = ? ORDER BY ticker`,
    args: [targetDate],
  })
  return stableSha256(sortJpOhlcvRows(rows.rows.map((row): JpOhlcvValue => ({
    ticker: normalizeJpOhlcvTicker(String(row.ticker)),
    date: String(row.date),
    open: Number(row.open),
    high: Number(row.high),
    low: Number(row.low),
    close: Number(row.close),
    volume: Number(row.volume),
  }))))
}

async function previousSuccessfulSource(executor: Executor, sourceRunId: number): Promise<{
  id: number | null
  sha256: string | null
}> {
  const result = await executor.execute({
    sql: `SELECT id, job_type, started_at, finished_at, status, total_tickers,
                 succeeded, failed, rows_inserted, error_summary
          FROM batch_runs
          WHERE job_type = 'ohlcv_fetch:jquants' AND status = 'success' AND id < ?
          ORDER BY id DESC LIMIT 1`,
    args: [sourceRunId],
  })
  const row = result.rows[0]
  return row ? { id: Number(row.id), sha256: stableSha256({ ...row }) } : { id: null, sha256: null }
}

export async function startJpOhlcvSourceRun(
  client: Client,
  input: { targetDate: string },
): Promise<{ sourceRunId: number; syncRunId: number; identitySha256: string }> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.targetDate)) throw new Error('jp_ohlcv_source_run_target_invalid')
  const owner = currentProcessIdentity(process.pid)
  const transaction = await client.transaction('write')
  try {
    const running = await transaction.execute(
      `SELECT id FROM batch_runs
       WHERE job_type = 'ohlcv_fetch:jquants' AND status = 'running'
       ORDER BY id LIMIT 2`,
    )
    if (running.rows.length > 0) {
      throw new Error(`jp_ohlcv_running_source_run_recovery_required:${running.rows.map((row) => row.id).join(',')}`)
    }
    const runningSync = await transaction.execute({
      sql: `SELECT id FROM jquants_sync_runs
            WHERE target_date = ? AND api_type = 'equities/bars/daily:date' AND status = 'running'`,
      args: [input.targetDate],
    })
    if (runningSync.rows.length > 0) throw new Error('jp_ohlcv_running_sync_run_recovery_required')
    const head = await loadJpOhlcvCoverageHead(transaction)
    if (!head) throw new Error('jp_ohlcv_coverage_head_bootstrap_required')
    const startingProjectionSha256 = head.projectionSha256
    const source = await transaction.execute(
      `INSERT INTO batch_runs(job_type, started_at, status)
       VALUES('ohlcv_fetch:jquants', unixepoch(), 'running') RETURNING id`,
    )
    const sourceRunId = Number(source.rows[0].id)
    const sync = await transaction.execute({
      sql: `INSERT INTO jquants_sync_runs(target_date, api_type, status)
            VALUES(?, 'equities/bars/daily:date', 'running') RETURNING id`,
      args: [input.targetDate],
    })
    const syncRunId = Number(sync.rows[0].id)
    const previous = await previousSuccessfulSource(transaction, sourceRunId)
    const identity = sealExecutionIdentity({
      version: 1,
      kind: 'JP_OHLCV_SOURCE_RUN_EXECUTION',
      sourceRunId,
      syncRunId,
      targetDate: input.targetDate,
      runToken: randomUUID(),
      ownerHost: os.hostname(),
      owner,
      activeChild: null,
      startingCoverageHeadSha256: stableSha256(head),
      startingProjectionSha256,
      targetBeforeSha256: await targetDateSha256(transaction, input.targetDate),
      previousSuccessfulSourceRunId: previous.id,
      previousSuccessfulSourceRunSha256: previous.sha256,
    })
    const serialized = JSON.stringify(identity)
    await transaction.execute({
      sql: "UPDATE batch_runs SET error_summary = ? WHERE id = ? AND status = 'running'",
      args: [serialized, sourceRunId],
    })
    await transaction.execute({
      sql: "UPDATE jquants_sync_runs SET error_summary = ? WHERE id = ? AND status = 'running'",
      args: [serialized, syncRunId],
    })
    await transaction.commit()
    return { sourceRunId, syncRunId, identitySha256: identity.identitySha256 }
  } catch (error) {
    try { await transaction.rollback() } catch { /* preserve original failure */ }
    throw error
  }
}

async function updateActiveChild(
  client: Client,
  input: { sourceRunId: number; child: ProcessIdentity | null },
): Promise<void> {
  const transaction = await client.transaction('write')
  try {
    const run = await transaction.execute({
      sql: 'SELECT status, error_summary FROM batch_runs WHERE id = ?', args: [input.sourceRunId],
    })
    if (run.rows[0]?.status !== 'running') throw new Error('jp_ohlcv_source_run_not_running')
    const current = parseExecutionIdentity(run.rows[0].error_summary)
    const { identitySha256: _identitySha256, ...body } = current
    const next = sealExecutionIdentity({ ...body, activeChild: input.child })
    const serialized = JSON.stringify(next)
    const updatedRun = await transaction.execute({
      sql: `UPDATE batch_runs SET error_summary = ?
            WHERE id = ? AND status = 'running' AND error_summary = ?`,
      args: [serialized, input.sourceRunId, JSON.stringify(current)],
    })
    const updatedSync = await transaction.execute({
      sql: `UPDATE jquants_sync_runs SET error_summary = ?
            WHERE id = ? AND status = 'running' AND error_summary = ?`,
      args: [serialized, current.syncRunId, JSON.stringify(current)],
    })
    if (updatedRun.rowsAffected !== 1 || updatedSync.rowsAffected !== 1) {
      throw new Error('jp_ohlcv_source_run_child_identity_compare_and_swap_failed')
    }
    await transaction.commit()
  } catch (error) {
    try { await transaction.rollback() } catch { /* preserve original failure */ }
    throw error
  }
}

export async function registerJpOhlcvSourceRunChild(
  client: Client,
  input: { sourceRunId: number; childPid: number },
): Promise<void> {
  await updateActiveChild(client, {
    sourceRunId: input.sourceRunId,
    child: currentProcessIdentity(input.childPid, input.childPid),
  })
}

export async function clearJpOhlcvSourceRunChild(client: Client, sourceRunId: number): Promise<void> {
  await updateActiveChild(client, { sourceRunId, child: null })
}

export async function inspectJpOhlcvRunningSourceRun(
  executor: Executor,
  sourceRunId: number,
): Promise<JpOhlcvRunningSourceRunRecoveryStatus> {
  if (!Number.isSafeInteger(sourceRunId) || sourceRunId <= 0) throw new Error('jp_ohlcv_source_run_id_invalid')
  const runResult = await executor.execute({
    sql: `SELECT id, job_type, started_at, finished_at, status, total_tickers,
                 succeeded, failed, rows_inserted, error_summary
          FROM batch_runs WHERE id = ?`,
    args: [sourceRunId],
  })
  const run = runResult.rows[0]
  if (!run) {
    return buildStatus({
      sourceRunId, runStatus: 'missing', targetDate: null, receiptSha256: null,
      projectionSha256: null, bindingSha256: null, syncRunId: null,
      executionIdentitySha256: null, ownerPid: null, activeChildPid: null,
      activeChildProcessGroupId: null,
      previousSuccessfulSourceRunId: null, previousSuccessfulSourceRunSha256: null,
      disposition: 'MISSING', reasons: ['source_run_missing'],
    })
  }
  const previous = await previousSuccessfulSource(executor, sourceRunId)
  const runStatus = String(run.status)
  if (run.job_type !== 'ohlcv_fetch:jquants') {
    return buildStatus({
      sourceRunId, runStatus, targetDate: null, receiptSha256: null,
      projectionSha256: null, bindingSha256: null, syncRunId: null,
      executionIdentitySha256: null, ownerPid: null, activeChildPid: null,
      activeChildProcessGroupId: null,
      previousSuccessfulSourceRunId: previous.id, previousSuccessfulSourceRunSha256: previous.sha256,
      disposition: 'HOLD_IDENTITY_MISMATCH', reasons: ['source_run_job_type_mismatch'],
    })
  }
  if (runStatus !== 'running') {
    return buildStatus({
      sourceRunId, runStatus, targetDate: null, receiptSha256: null,
      projectionSha256: null, bindingSha256: null, syncRunId: null,
      executionIdentitySha256: null, ownerPid: null, activeChildPid: null,
      activeChildProcessGroupId: null,
      previousSuccessfulSourceRunId: previous.id, previousSuccessfulSourceRunSha256: previous.sha256,
      disposition: 'FINALIZED', reasons: [],
    })
  }

  let identity: JpOhlcvSourceRunExecutionIdentity
  try {
    identity = parseExecutionIdentity(run.error_summary)
  } catch {
    return buildStatus({
      sourceRunId, runStatus, targetDate: null, receiptSha256: null,
      projectionSha256: null, bindingSha256: null, syncRunId: null,
      executionIdentitySha256: null, ownerPid: null, activeChildPid: null,
      activeChildProcessGroupId: null,
      previousSuccessfulSourceRunId: previous.id, previousSuccessfulSourceRunSha256: previous.sha256,
      disposition: 'HOLD_IDENTITY_MISMATCH', reasons: ['source_run_execution_identity_invalid'],
    })
  }
  const common = {
    sourceRunId,
    runStatus,
    targetDate: identity.targetDate,
    syncRunId: identity.syncRunId,
    executionIdentitySha256: identity.identitySha256,
    ownerPid: identity.owner.pid,
    activeChildPid: identity.activeChild?.pid ?? null,
    activeChildProcessGroupId: identity.activeChild?.processGroupId ?? null,
    previousSuccessfulSourceRunId: identity.previousSuccessfulSourceRunId,
    previousSuccessfulSourceRunSha256: identity.previousSuccessfulSourceRunSha256,
  }
  if (identity.sourceRunId !== sourceRunId || identity.ownerHost !== os.hostname()) {
    return buildStatus({
      ...common, receiptSha256: null, projectionSha256: null, bindingSha256: null,
      disposition: 'HOLD_IDENTITY_MISMATCH', reasons: ['source_run_execution_binding_mismatch'],
    })
  }
  if (previous.id !== identity.previousSuccessfulSourceRunId
    || previous.sha256 !== identity.previousSuccessfulSourceRunSha256) {
    return buildStatus({
      ...common, receiptSha256: null, projectionSha256: null, bindingSha256: null,
      disposition: 'HOLD_AFTER_STATE_CHANGED', reasons: ['previous_successful_source_changed'],
    })
  }
  const ownerStatus = processIdentityStatus(identity.owner)
  const childStatus = identity.activeChild ? processIdentityStatus(identity.activeChild) : 'DEAD'
  if (ownerStatus === 'UNKNOWN' || childStatus === 'UNKNOWN') {
    return buildStatus({
      ...common, receiptSha256: null, projectionSha256: null, bindingSha256: null,
      disposition: 'HOLD_IDENTITY_MISMATCH', reasons: ['source_run_process_liveness_unknown'],
    })
  }
  if (ownerStatus === 'LIVE' || childStatus === 'LIVE') {
    return buildStatus({
      ...common, receiptSha256: null, projectionSha256: null, bindingSha256: null,
      disposition: 'HOLD_WRITER_ACTIVE', reasons: ['source_run_owner_or_child_still_active'],
    })
  }
  const syncResult = await executor.execute({
    sql: `SELECT id, target_date, api_type, status, error_summary
          FROM jquants_sync_runs WHERE status = 'running' AND target_date = ?
          ORDER BY id`,
    args: [identity.targetDate],
  })
  if (syncResult.rows.length !== 1) {
    return buildStatus({
      ...common, receiptSha256: null, projectionSha256: null, bindingSha256: null,
      disposition: 'HOLD_SYNC_AMBIGUOUS', reasons: [`running_sync_run_count:${syncResult.rows.length}`],
    })
  }
  const sync = syncResult.rows[0]
  let syncIdentity: JpOhlcvSourceRunExecutionIdentity
  try { syncIdentity = parseExecutionIdentity(sync.error_summary) } catch {
    return buildStatus({
      ...common, receiptSha256: null, projectionSha256: null, bindingSha256: null,
      disposition: 'HOLD_IDENTITY_MISMATCH', reasons: ['sync_run_execution_identity_invalid'],
    })
  }
  if (Number(sync.id) !== identity.syncRunId
    || sync.api_type !== 'equities/bars/daily:date'
    || syncIdentity.identitySha256 !== identity.identitySha256) {
    return buildStatus({
      ...common, receiptSha256: null, projectionSha256: null, bindingSha256: null,
      disposition: 'HOLD_IDENTITY_MISMATCH', reasons: ['sync_source_execution_identity_mismatch'],
    })
  }

  const receiptResult = await executor.execute({
    sql: `SELECT target_date, projection_sha256, receipt_sha256, binding_sha256, receipt_json
          FROM jp_ohlcv_ingestion_receipts WHERE source_run_id = ?`,
    args: [sourceRunId],
  })
  const receiptRow = receiptResult.rows[0]
  if (!receiptRow) {
    let head
    try { head = await loadJpOhlcvCoverageHead(executor) } catch {
      return buildStatus({
        ...common, receiptSha256: null, projectionSha256: null, bindingSha256: null,
        disposition: 'HOLD_IDENTITY_MISMATCH', reasons: ['coverage_head_invalid'],
      })
    }
    const unchanged = !!head
      && stableSha256(head) === identity.startingCoverageHeadSha256
      && await targetDateSha256(executor, identity.targetDate) === identity.targetBeforeSha256
    return buildStatus({
      ...common, receiptSha256: null, projectionSha256: identity.startingProjectionSha256,
      bindingSha256: null,
      disposition: unchanged ? 'RECOVERABLE_PRE_RECEIPT_TO_PARTIAL' : 'HOLD_AFTER_STATE_CHANGED',
      reasons: unchanged ? [] : ['pre_receipt_source_state_changed'],
    })
  }

  let receipt: JpOhlcvDailyIngestionReceipt
  try {
    receipt = JSON.parse(String(receiptRow.receipt_json)) as JpOhlcvDailyIngestionReceipt
    assertJpOhlcvDailyIngestionReceipt(receipt)
  } catch {
    return buildStatus({
      ...common,
      receiptSha256: String(receiptRow.receipt_sha256),
      projectionSha256: String(receiptRow.projection_sha256),
      bindingSha256: String(receiptRow.binding_sha256),
      disposition: 'HOLD_IDENTITY_MISMATCH', reasons: ['immutable_ingestion_receipt_invalid'],
    })
  }
  const receiptSha256 = String(receiptRow.receipt_sha256)
  const projectionSha256 = String(receiptRow.projection_sha256)
  const bindingSha256 = String(receiptRow.binding_sha256)
  let head
  try { head = await loadJpOhlcvCoverageHead(executor) } catch {
    return buildStatus({
      ...common, receiptSha256, projectionSha256, bindingSha256,
      disposition: 'HOLD_IDENTITY_MISMATCH', reasons: ['coverage_head_invalid'],
    })
  }
  if (receipt.sourceRunId !== sourceRunId
    || receiptSha256 !== receipt.receiptSha256
    || receipt.targetDate !== identity.targetDate
    || receipt.beforeSha256 !== identity.targetBeforeSha256
    || !head
    || head.sourceRunId !== sourceRunId
    || head.projectionSha256 !== projectionSha256
    || head.receiptSha256 !== receiptSha256
    || head.bindingSha256 !== bindingSha256) {
    return buildStatus({
      ...common, receiptSha256, projectionSha256, bindingSha256,
      disposition: 'HOLD_IDENTITY_MISMATCH', reasons: ['receipt_coverage_head_identity_mismatch'],
    })
  }
  if (head.projection.previousProjectionSha256 !== identity.startingProjectionSha256) {
    return buildStatus({
      ...common, receiptSha256, projectionSha256, bindingSha256,
      disposition: 'HOLD_IDENTITY_MISMATCH', reasons: ['receipt_starting_projection_mismatch'],
    })
  }
  if (await targetDateSha256(executor, receipt.targetDate) !== receipt.afterSha256) {
    return buildStatus({
      ...common, receiptSha256, projectionSha256, bindingSha256,
      disposition: 'HOLD_AFTER_STATE_CHANGED', reasons: ['receipt_after_state_changed'],
    })
  }
  return buildStatus({
    ...common, receiptSha256, projectionSha256, bindingSha256,
    disposition: 'RECOVERABLE_POST_RECEIPT_TO_PARTIAL', reasons: [],
  })
}

export async function holdJpOhlcvRunningSourceRun(
  client: Client,
  input: { sourceRunId: number; expectedStatusSha256: string },
): Promise<JpOhlcvRunningSourceRunRecoveryStatus> {
  if (!/^[a-f0-9]{64}$/.test(input.expectedStatusSha256)) {
    throw new Error('jp_ohlcv_running_source_recovery_approval_invalid')
  }
  const transaction = await client.transaction('write')
  try {
    const status = await inspectJpOhlcvRunningSourceRun(transaction, input.sourceRunId)
    if (status.statusSha256 !== input.expectedStatusSha256) {
      throw new Error('jp_ohlcv_running_source_recovery_status_changed')
    }
    if (!['RECOVERABLE_PRE_RECEIPT_TO_PARTIAL', 'RECOVERABLE_POST_RECEIPT_TO_PARTIAL']
      .includes(status.disposition) || status.syncRunId === null) {
      throw new Error(`jp_ohlcv_running_source_recovery_not_permitted:${status.disposition}`)
    }
    const evidence = JSON.stringify([{
      code: 'jp_ohlcv_running_source_run_recovered_to_partial',
      disposition: status.disposition,
      statusSha256: status.statusSha256,
      executionIdentitySha256: status.executionIdentitySha256,
      receiptSha256: status.receiptSha256,
      projectionSha256: status.projectionSha256,
      previousSuccessfulSourceRunId: status.previousSuccessfulSourceRunId,
      previousSuccessfulSourceRunSha256: status.previousSuccessfulSourceRunSha256,
    }])
    const sync = await transaction.execute({
      sql: `UPDATE jquants_sync_runs SET status = 'partial', finished_at = unixepoch(), error_summary = ?
            WHERE id = ? AND target_date = ? AND status = 'running'`,
      args: [evidence, status.syncRunId, status.targetDate!],
    })
    if (sync.rowsAffected !== 1) throw new Error('jp_ohlcv_running_sync_recovery_compare_and_swap_failed')
    const run = await transaction.execute({
      sql: `UPDATE batch_runs SET status = 'partial', finished_at = unixepoch(), error_summary = ?
            WHERE id = ? AND job_type = 'ohlcv_fetch:jquants' AND status = 'running'`,
      args: [evidence, input.sourceRunId],
    })
    if (run.rowsAffected !== 1) throw new Error('jp_ohlcv_running_source_recovery_compare_and_swap_failed')
    const previous = await previousSuccessfulSource(transaction, input.sourceRunId)
    if (previous.id !== status.previousSuccessfulSourceRunId
      || previous.sha256 !== status.previousSuccessfulSourceRunSha256) {
      throw new Error('jp_ohlcv_previous_successful_source_changed')
    }
    await transaction.commit()
    return status
  } catch (error) {
    try { await transaction.rollback() } catch { /* preserve the original failure */ }
    throw error
  }
}
