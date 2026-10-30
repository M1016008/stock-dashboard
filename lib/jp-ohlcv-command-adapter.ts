import { spawn } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import {
  buildJpOhlcvBackfillPlan,
  buildJpOhlcvRuntimeRepairScope,
  stableSha256,
  type JpOfficialOhlcvValue,
  type JpOhlcvMissingOnlyRepairScope,
  type JpOhlcvRuntimeRepairScope,
  type JpOhlcvValue,
} from '@/lib/jp-ohlcv-data-quality'
import type {
  JpOhlcvRepairAdapter,
  JpOhlcvRepairExecutionContext,
  JpOhlcvRepairRollbackAdapter,
} from '@/lib/jp-ohlcv-repair-runner'
import type { JpOhlcvRepairApproval, JpOhlcvRepairRollbackApproval } from '@/lib/jp-ohlcv-production-repair'
import {
  assertJpOhlcvRuntimeSnapshotPreinsertBudget,
  assertJpOhlcvRuntimeSnapshotRenewal,
  assertJpOhlcvRuntimeSnapshotUnchanged,
  captureJpOhlcvRuntimeSnapshot,
  type JpOhlcvOfficialSourceProof,
  type JpOhlcvRuntimeSnapshot,
} from '@/lib/jp-ohlcv-runtime-snapshot'
import {
  assertJpOhlcvBackupMaintenanceBudget,
  assertJpOhlcvPlanMaintenanceBudget,
  JP_OHLCV_BACKUP_TIME_LIMITS as backupTimeLimits,
} from '@/lib/jp-ohlcv-backup-time-budget'
import {
  assertJQuantsRejectedDailyRowEvidence,
  fetchJQuantsDailyByDateWithEvidence,
  jQuantsDailyByDateSourceContract,
  type JQuantsDailyByDateSourceContract,
  type JQuantsRejectedDailyRowEvidence,
} from '@/lib/jquants'
import {
  assertJpOhlcvRepairExecutionActive,
  clearActiveStageProcess,
  currentJpOhlcvRepairShutdownSignal,
  isProcessGroupAlive,
  readProcessIdentity,
  registerActiveStageProcess,
  terminateAndWaitForProcessGroup,
} from '@/lib/jp-ohlcv-repair-process-supervisor'

const RESERVED_STAGE_ENVIRONMENT = new Set([
  'NODE_ENV',
  'USE_LOCAL_DB',
  'TURSO_DATABASE_URL',
  'TURSO_AUTH_TOKEN',
  'STOCKBOARD_DB_PATH',
  'EXTERNAL_STORAGE_REQUIRED',
  'STOCK_DATA_MOUNT_PATH',
  'STOCK_DATA_VOLUME_UUID',
  'STOCK_DATA_MIN_FREE_BYTES',
  'STOCK_DATA_MIN_FREE_PERCENT',
  'STOCKBOARD_JP_OHLCV_REPAIR_OWNER',
  'STOCKBOARD_JP_OHLCV_REPAIR_TRANSACTION_ID',
  'STOCKBOARD_JP_OHLCV_REPAIR_LOCK_PATH',
  'STOCKBOARD_UPDATE_JOB_TYPE',
  'STOCKBOARD_JP_OHLCV_RUNTIME_SNAPSHOT_PATH',
  'STOCKBOARD_JP_OHLCV_RUNTIME_SNAPSHOT_SHA256',
  'STOCKBOARD_JP_OHLCV_RUNTIME_SNAPSHOT_FILE_SHA256',
])

export type JpOhlcvRepairStageCommand = {
  executable: string
  executableSha256: string
  sealedFiles: Array<{ path: string; sha256: string; snapshot?: boolean }>
  args: string[]
  workingDirectory: string
  timeoutMs: number
  environment?: Record<string, string>
}

export type JpOhlcvRepairExecutionPlan = {
  version: 1
  officialRows: JpOfficialOhlcvValue[]
  approvalScope: JpOhlcvMissingOnlyRepairScope
  timeBudget: {
    maximumMaintenanceMs: number
    forwardDerivedAggregateMs: number
    rollbackDerivedAggregateMs: number
  }
  commands: {
    createBackup: JpOhlcvRepairStageCommand
    holdReadServices: JpOhlcvRepairStageCommand
    publishSourceGeneration: JpOhlcvRepairStageCommand
    verifyDataGeneration: JpOhlcvRepairStageCommand
    rebuildDerivedServing: JpOhlcvRepairStageCommand[]
    verifyServing: JpOhlcvRepairStageCommand
    resumeReadServices: JpOhlcvRepairStageCommand
    verifyBackupForRollback: JpOhlcvRepairStageCommand
    restoreBackup: JpOhlcvRepairStageCommand
    rebuildOriginalDerivedServing: JpOhlcvRepairStageCommand[]
    verifyOriginalServing: JpOhlcvRepairStageCommand
  }
}

function sha256File(file: string): string {
  const hash = crypto.createHash('sha256')
  const descriptor = fs.openSync(file, 'r')
  const buffer = Buffer.allocUnsafe(1024 * 1024)
  try {
    for (;;) {
      const bytes = fs.readSync(descriptor, buffer, 0, buffer.length, null)
      if (bytes === 0) break
      hash.update(buffer.subarray(0, bytes))
    }
  } finally {
    fs.closeSync(descriptor)
  }
  return hash.digest('hex')
}

function sha256BackupFileWithTimeout(file: string): { sha256: string; elapsedMs: number; timeoutMs: number } {
  const timeoutMs = backupTimeLimits.parentBackupSha256MaxTimeoutMs
  const startedAt = Date.now()
  const hash = crypto.createHash('sha256')
  const descriptor = fs.openSync(file, 'r')
  const buffer = Buffer.allocUnsafe(1024 * 1024)
  try {
    for (;;) {
      const elapsedMs = Date.now() - startedAt
      if (elapsedMs > timeoutMs) {
        throw new Error(`repair_parent_backup_sha256_timeout:elapsed_${elapsedMs}:timeout_${timeoutMs}`)
      }
      const bytes = fs.readSync(descriptor, buffer, 0, buffer.length, null)
      if (bytes === 0) break
      hash.update(buffer.subarray(0, bytes))
    }
  } finally {
    fs.closeSync(descriptor)
  }
  const elapsedMs = Date.now() - startedAt
  if (elapsedMs > timeoutMs) {
    throw new Error(`repair_parent_backup_sha256_timeout:elapsed_${elapsedMs}:timeout_${timeoutMs}`)
  }
  return { sha256: hash.digest('hex'), elapsedMs, timeoutMs }
}

function atomicJson(file: string, payload: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  const temporary = `${file}.tmp-${process.pid}-${crypto.randomUUID()}`
  const descriptor = fs.openSync(temporary, 'wx', 0o600)
  try {
    fs.writeFileSync(descriptor, `${JSON.stringify(payload, null, 2)}\n`)
    fs.fsyncSync(descriptor)
  } finally {
    fs.closeSync(descriptor)
  }
  fs.renameSync(temporary, file)
  const directory = fs.openSync(path.dirname(file), 'r')
  try { fs.fsyncSync(directory) } finally { fs.closeSync(directory) }
}

type JpOhlcvOfficialSourceRefresh = {
  rows: JpOfficialOhlcvValue[]
  rejectedRows: JQuantsRejectedDailyRowEvidence[]
  proof: JpOhlcvOfficialSourceProof
  contract: JQuantsDailyByDateSourceContract
}

function stageFailureDetail(value: string): string {
  return value
    .replace(/\b(Bearer|Basic)\s+[^\s]+/gi, '$1 [REDACTED]')
    .replace(/\b(x-api-key|authorization)\s*:\s*[^\s,}]+/gi, '$1: [REDACTED]')
    .replace(/\b([A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|AUTH|COOKIE|API_KEY)[A-Z0-9_]*)=([^\s]+)/gi, '$1=[REDACTED]')
    .replace(/("(?:password|token|secret|api[_-]?key|authorization)"\s*:\s*)"[^"]*"/gi, '$1"[REDACTED]"')
    .replace(/[\r\n\t]+/g, ' ')
    .trim()
    .slice(-2_000)
}

function assertCommand(spec: JpOhlcvRepairStageCommand): string {
  if (!path.isAbsolute(spec.executable) || !path.isAbsolute(spec.workingDirectory)) {
    throw new Error('repair_stage_command_absolute_path_required')
  }
  const executable = fs.realpathSync(spec.executable)
  if (!fs.statSync(executable).isFile() || sha256File(executable) !== spec.executableSha256) {
    throw new Error(`repair_stage_command_identity_mismatch:${spec.executable}`)
  }
  if (!fs.statSync(fs.realpathSync(spec.workingDirectory)).isDirectory()) {
    throw new Error(`repair_stage_command_working_directory_invalid:${spec.workingDirectory}`)
  }
  if (!Array.isArray(spec.sealedFiles)) throw new Error('repair_stage_command_sealed_files_required')
  for (const sealed of spec.sealedFiles) {
    if (!path.isAbsolute(sealed.path) || !/^[a-f0-9]{64}$/.test(sealed.sha256)) {
      throw new Error('repair_stage_command_sealed_file_identity_invalid')
    }
    if (sealed.snapshot !== undefined && typeof sealed.snapshot !== 'boolean') {
      throw new Error('repair_stage_command_sealed_file_snapshot_invalid')
    }
    const resolved = fs.realpathSync(sealed.path)
    if (!fs.statSync(resolved).isFile() || sha256File(resolved) !== sealed.sha256) {
      throw new Error(`repair_stage_command_sealed_file_identity_mismatch:${sealed.path}`)
    }
  }
  if (!Number.isSafeInteger(spec.timeoutMs) || spec.timeoutMs < 1_000 || spec.timeoutMs > 12 * 60 * 60_000) {
    throw new Error('repair_stage_command_timeout_invalid')
  }
  if (spec.args.some((arg) => typeof arg !== 'string' || arg.includes('\0'))) {
    throw new Error('repair_stage_command_argument_invalid')
  }
  if (Object.keys(spec.environment ?? {}).some((key) => RESERVED_STAGE_ENVIRONMENT.has(key))) {
    throw new Error('repair_stage_command_reserved_environment_forbidden')
  }
  const executableName = path.basename(executable).toLowerCase()
  const interpreter = executableName === 'node'
    || executableName === 'tsx'
    || ['sh', 'bash', 'zsh'].includes(executableName)
    || executableName.startsWith('python')
  if (interpreter) {
    if (spec.args.includes('-e') || spec.args.includes('-c')) {
      throw new Error('repair_stage_command_inline_interpreter_forbidden')
    }
    const script = spec.args.find((arg) => !arg.startsWith('-'))
    const sealedPaths = new Set(spec.sealedFiles.map((entry) => fs.realpathSync(entry.path)))
    if (!script || !path.isAbsolute(script) || !sealedPaths.has(fs.realpathSync(script))) {
      throw new Error('repair_stage_command_interpreter_script_must_be_sealed')
    }
  }
  return executable
}

export function assertJpOhlcvRepairExecutionPlan(input: {
  plan: JpOhlcvRepairExecutionPlan
  targetDate: string
}): void {
  if (input.plan.version !== 1 || input.plan.officialRows.length === 0) {
    throw new Error('repair_execution_plan_invalid')
  }
  if (!input.plan.timeBudget
    || typeof input.plan.timeBudget !== 'object'
    || !Number.isSafeInteger(input.plan.timeBudget.maximumMaintenanceMs)
    || !Number.isSafeInteger(input.plan.timeBudget.forwardDerivedAggregateMs)
    || !Number.isSafeInteger(input.plan.timeBudget.rollbackDerivedAggregateMs)) {
    throw new Error('repair_execution_plan_time_budget_missing_regenerate_required')
  }
  if (input.plan.approvalScope.version !== 1
    || input.plan.approvalScope.status !== 'READY'
    || input.plan.approvalScope.date !== input.targetDate
    || input.plan.approvalScope.officialSha256 !== buildJpOhlcvBackfillPlan({
      date: input.targetDate,
      officialRows: input.plan.officialRows,
      existingRows: [],
    }).officialSha256) {
    throw new Error('repair_execution_plan_approval_scope_invalid')
  }
  const keys = new Set<string>()
  for (const row of input.plan.officialRows) {
    if (row.date !== input.targetDate) throw new Error('repair_execution_plan_official_date_mismatch')
    const key = `${row.ticker}:${row.date}`
    if (keys.has(key)) throw new Error('repair_execution_plan_official_duplicate')
    keys.add(key)
  }
  const commands = input.plan.commands
  const single = [
    commands.createBackup,
    commands.holdReadServices,
    commands.publishSourceGeneration,
    commands.verifyDataGeneration,
    commands.verifyServing,
    commands.resumeReadServices,
    commands.verifyBackupForRollback,
    commands.restoreBackup,
    commands.verifyOriginalServing,
  ]
  if (commands.rebuildDerivedServing.length === 0 || commands.rebuildOriginalDerivedServing.length === 0) {
    throw new Error('repair_execution_plan_derived_commands_missing')
  }
  for (const command of [...single, ...commands.rebuildDerivedServing, ...commands.rebuildOriginalDerivedServing]) {
    assertCommand(command)
  }
  assertJpOhlcvPlanMaintenanceBudget({
    maximumMaintenanceMs: input.plan.timeBudget.maximumMaintenanceMs,
    timeouts: {
      createBackupMs: commands.createBackup.timeoutMs,
      holdReadServicesMs: commands.holdReadServices.timeoutMs,
      publishSourceGenerationMs: commands.publishSourceGeneration.timeoutMs,
      verifyDataGenerationMs: commands.verifyDataGeneration.timeoutMs,
      verifyServingMs: commands.verifyServing.timeoutMs,
      resumeReadServicesMs: commands.resumeReadServices.timeoutMs,
      verifyBackupForRollbackMs: commands.verifyBackupForRollback.timeoutMs,
      restoreBackupMs: commands.restoreBackup.timeoutMs,
      verifyOriginalServingMs: commands.verifyOriginalServing.timeoutMs,
      forwardDerivedAggregateMs: input.plan.timeBudget.forwardDerivedAggregateMs,
      rollbackDerivedAggregateMs: input.plan.timeBudget.rollbackDerivedAggregateMs,
    },
  })
}

function snapshotSealedFiles(input: {
  spec: JpOhlcvRepairStageCommand
  context: JpOhlcvRepairExecutionContext
}): string[] {
  if (input.spec.sealedFiles.length === 0) return [...input.spec.args]
  const snapshotDirectory = path.join(
    path.dirname(input.context.lockPath),
    'command-snapshots',
    input.context.transactionId,
  )
  fs.mkdirSync(snapshotDirectory, { recursive: true, mode: 0o700 })
  const replacements = new Map<string, string>()
  for (const sealed of input.spec.sealedFiles) {
    const source = fs.realpathSync(sealed.path)
    if (sha256File(source) !== sealed.sha256) {
      throw new Error(sealed.snapshot === false
        ? 'repair_stage_command_attested_file_changed_before_execution'
        : 'repair_stage_command_sealed_file_changed_before_snapshot')
    }
    if (sealed.snapshot === false) continue
    const destination = path.join(snapshotDirectory, `${sealed.sha256}-${path.basename(source)}`)
    if (!fs.existsSync(destination)) {
      const bytes = fs.readFileSync(source)
      if (crypto.createHash('sha256').update(bytes).digest('hex') !== sealed.sha256) {
        throw new Error('repair_stage_command_sealed_file_changed_before_snapshot')
      }
      const descriptor = fs.openSync(destination, 'wx', 0o500)
      try {
        fs.writeFileSync(descriptor, bytes)
        fs.fsyncSync(descriptor)
      } finally {
        fs.closeSync(descriptor)
      }
    }
    if (sha256File(destination) !== sealed.sha256) {
      throw new Error('repair_stage_command_snapshot_identity_mismatch')
    }
    replacements.set(source, destination)
  }
  return input.spec.args.map((arg) => {
    if (!path.isAbsolute(arg)) return arg
    const resolved = fs.realpathSync(arg)
    return replacements.get(resolved) ?? arg
  })
}

async function executeStage(input: {
  executable: string
  args: string[]
  spec: JpOhlcvRepairStageCommand
  context: JpOhlcvRepairExecutionContext
}): Promise<string> {
  assertJpOhlcvRepairExecutionActive()
  const stageStartedAt = Date.now()
  const operationIndex = input.spec.args.indexOf('--operation')
  const operationName = operationIndex >= 0 ? input.spec.args[operationIndex + 1] ?? 'unknown' : 'unknown'
  return new Promise((resolve, reject) => {
    const child = spawn(input.executable, input.args, {
      cwd: fs.realpathSync(input.spec.workingDirectory),
      env: { ...input.spec.environment, ...input.context.childEnvironment },
      detached: true,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    const stdout: Buffer[] = []
    let stderr = Buffer.alloc(0)
    let stdoutBytes = 0
    let outputOverflow = false
    let timedOut = false
    let terminationRequested = false
    let settled = false
    let registered = false
    let recorded = false
    let killPromise: Promise<void> | null = null
    let timer: NodeJS.Timeout | null = null
    const requestTermination = () => {
      if (!child.pid) return Promise.resolve()
      terminationRequested = true
      killPromise ??= terminateAndWaitForProcessGroup(child.pid)
      return killPromise
    }
    const finalize = async (inputFailure: Error | null, code: number | null, signal: NodeJS.Signals | null) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      let failure = inputFailure
      let processGroupStopped = !child.pid
      let unexpectedDescendants = false
      try {
        if (killPromise) await killPromise
        if (child.pid && isProcessGroupAlive(child.pid)) {
          unexpectedDescendants = !terminationRequested && code === 0 && signal === null
          await terminateAndWaitForProcessGroup(child.pid)
        }
        processGroupStopped = !child.pid || !isProcessGroupAlive(child.pid)
        if (!processGroupStopped) failure = new Error('repair_stage_command_descendants_remained')
        else if (unexpectedDescendants) failure = new Error('repair_stage_command_descendants_remained_after_exit')
      } catch (error) {
        failure = error instanceof Error ? error : new Error(String(error))
        processGroupStopped = !child.pid || !isProcessGroupAlive(child.pid)
      }
      const shutdownSignal = currentJpOhlcvRepairShutdownSignal()
      if (!failure && shutdownSignal) failure = new Error(`repair_execution_interrupted:${shutdownSignal}`)
      if (!failure && timedOut) {
        failure = new Error(
          `repair_stage_command_timeout:${operationName}:elapsed_${Date.now() - stageStartedAt}:timeout_${input.spec.timeoutMs}`,
        )
      }
      if (!failure && outputOverflow) failure = new Error('repair_stage_command_output_limit_exceeded')
      if (!failure && code !== 0) {
        const detail = stageFailureDetail(stderr.toString('utf8'))
        failure = new Error(
          `repair_stage_command_failed:exit_${code ?? 'null'}:signal_${signal ?? 'none'}${detail ? `:${detail}` : ''}`,
        )
      }
      try {
        // A process group that cannot be proven stopped remains active in both
        // the in-memory supervisor and the durable journal. Rollback recovery
        // must then require explicit stale-process evidence after it is gone.
        if (processGroupStopped && registered && child.pid) clearActiveStageProcess(child.pid)
        if (processGroupStopped && recorded && child.pid) {
          input.context.recordStageProcessStopped({
            processGroupId: child.pid,
            outcome: failure?.message ?? (terminationRequested ? 'terminated' : 'exit_0'),
          })
        }
      } catch (recordError) {
        failure ??= recordError instanceof Error ? recordError : new Error(String(recordError))
      }
      if (failure) reject(failure)
      else resolve(Buffer.concat(stdout).toString('utf8'))
    }
    child.once('error', () => { void finalize(new Error('repair_stage_command_spawn_failed'), null, null) })
    child.once('close', (code, signal) => { void finalize(null, code, signal) })
    child.stdout.on('data', (chunk: Buffer) => {
      stdoutBytes += chunk.length
      if (stdoutBytes > 16 * 1024 * 1024) {
        outputOverflow = true
        void requestTermination().catch(() => {
          // finalize() owns the durable survivor decision and preserves the
          // active process record when termination cannot be proven.
        })
        return
      }
      stdout.push(chunk)
    })
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = Buffer.concat([stderr, chunk])
      if (stderr.length > 64 * 1024) stderr = stderr.subarray(stderr.length - 64 * 1024)
    })
    if (!child.pid) return
    try {
      registerActiveStageProcess({ pid: child.pid, processGroupId: child.pid })
      registered = true
      const identity = readProcessIdentity(child.pid)
      if (!identity || identity.processGroupId !== child.pid) {
        throw new Error('repair_stage_process_identity_unavailable')
      }
      input.context.recordStageProcessStarted({
        pid: child.pid,
        processGroupId: child.pid,
        commandSha256: input.spec.executableSha256,
        processIdentitySha256: identity.identitySha256,
      })
      recorded = true
    } catch (error) {
      void requestTermination()
        .catch(() => undefined)
        .finally(() => {
          void finalize(error instanceof Error ? error : new Error(String(error)), null, null)
        })
      return
    }
    timer = setTimeout(() => {
      timedOut = true
      void requestTermination().catch(() => {
        // finalize() records the termination failure without dropping the
        // durable activeStageProcess guard.
      })
    }, input.spec.timeoutMs)
  })
}

async function runJsonStage<T>(
  spec: JpOhlcvRepairStageCommand,
  context: JpOhlcvRepairExecutionContext,
): Promise<T> {
  const executable = assertCommand(spec)
  const args = snapshotSealedFiles({ spec, context })
  const stdout = await executeStage({ executable, args, spec, context })
  const line = stdout.split('\n').map((value) => value.trim()).filter(Boolean).at(-1)
  if (!line) throw new Error('repair_stage_command_json_output_missing')
  try {
    return JSON.parse(line) as T
  } catch {
    throw new Error('repair_stage_command_json_output_invalid')
  }
}

async function runJsonStageSequenceWithinBudget<T>(input: {
  commands: JpOhlcvRepairStageCommand[]
  aggregateTimeoutMs: number
  context: JpOhlcvRepairExecutionContext
  errorCode: string
}): Promise<{ results: T[]; elapsedMs: number; aggregateTimeoutMs: number }> {
  const startedAt = Date.now()
  const minimumCommandWindowMs = 60_000
  const results: T[] = []
  for (let index = 0; index < input.commands.length; index += 1) {
    const elapsedMs = Date.now() - startedAt
    const remainingCommands = input.commands.length - index - 1
    const reserveMs = remainingCommands * minimumCommandWindowMs
    const availableMs = input.aggregateTimeoutMs - elapsedMs - reserveMs
    if (availableMs < minimumCommandWindowMs) {
      throw new Error(`${input.errorCode}:elapsed_${elapsedMs}:budget_${input.aggregateTimeoutMs}:next_${index}`)
    }
    const command = input.commands[index]!
    results.push(await runJsonStage<T>({
      ...command,
      timeoutMs: Math.min(command.timeoutMs, availableMs),
    }, input.context))
  }
  return { results, elapsedMs: Date.now() - startedAt, aggregateTimeoutMs: input.aggregateTimeoutMs }
}

async function currentRows(date: string): Promise<JpOhlcvValue[]> {
  const { client, ensureReady } = await import('@/lib/db/client')
  await ensureReady()
  const result = await client.execute({
    sql: 'SELECT ticker, date, open, high, low, close, volume FROM ohlcv_daily WHERE date = ? ORDER BY ticker',
    args: [date],
  })
  return result.rows.map((row) => ({
    ticker: String(row.ticker),
    date: String(row.date),
    open: Number(row.open),
    high: Number(row.high),
    low: Number(row.low),
    close: Number(row.close),
    volume: Number(row.volume),
  }))
}

function revalidatedScope(input: {
  approvalScope: JpOhlcvMissingOnlyRepairScope
  officialRows: JpOfficialOhlcvValue[]
  existingRows: JpOhlcvValue[]
}): JpOhlcvRuntimeRepairScope {
  return buildJpOhlcvRuntimeRepairScope({
    approvalScope: input.approvalScope,
    officialRows: input.officialRows,
    existingRows: input.existingRows,
  })
}

function assertPlan(input: {
  approval: JpOhlcvRepairApproval
  plan: JpOhlcvRepairExecutionPlan
}): void {
  assertJpOhlcvRepairExecutionPlan({ plan: input.plan, targetDate: input.approval.targetDate })
  if (input.plan.version !== 1 || stableSha256(input.plan) !== input.approval.derivedPlanSha256) {
    throw new Error('repair_execution_plan_hash_mismatch')
  }
  const officialIdentity = buildJpOhlcvBackfillPlan({
    date: input.approval.targetDate,
    officialRows: input.plan.officialRows,
    existingRows: [],
  }).officialSha256
  if (officialIdentity !== input.approval.officialSha256) {
    throw new Error('repair_execution_plan_official_hash_mismatch')
  }
  if (input.plan.approvalScope.planSha256 !== input.approval.planSha256
    || input.plan.approvalScope.missingRowsSha256 !== input.approval.missingRowsSha256
    || input.plan.approvalScope.preservedConflictsSha256 !== input.approval.preservedConflictsSha256) {
    throw new Error('repair_execution_plan_approval_scope_mismatch')
  }
}

export function createJpOhlcvCommandAdapters(input: {
  approval: JpOhlcvRepairApproval
  plan: JpOhlcvRepairExecutionPlan
  rollbackApproval?: JpOhlcvRepairRollbackApproval
  runtimeSnapshot?: JpOhlcvRuntimeSnapshot
  now?: () => Date
  refreshOfficialSource?: (targetDate: string) => Promise<JpOhlcvOfficialSourceRefresh>
}): { forward: JpOhlcvRepairAdapter; rollback: JpOhlcvRepairRollbackAdapter } {
  assertJpOhlcvBackupMaintenanceBudget()
  assertPlan(input)
  let verifiedScope: JpOhlcvRuntimeRepairScope | null = null
  let activeRuntimeSnapshot = input.runtimeSnapshot ?? null
  const now = input.now ?? (() => new Date())
  const refreshOfficialSource = input.refreshOfficialSource ?? (async (targetDate) => {
    const evidence = await fetchJQuantsDailyByDateWithEvidence(targetDate, { timeoutMs: 2 * 60_000 })
    const contract = jQuantsDailyByDateSourceContract(evidence)
    return {
      rows: evidence.rows,
      rejectedRows: evidence.rejectedRowEvidence,
      contract,
      proof: {
        requestedAt: evidence.requestedAt,
        completedAt: evidence.completedAt,
        providerRows: evidence.providerRows,
        acceptedRows: evidence.acceptedRows,
        rejectedRows: evidence.rejectedRows,
        noTradeRows: evidence.noTradeRows,
        unexpectedRejectedRows: evidence.unexpectedRejectedRows,
        contentSha256: evidence.contentSha256,
        rejectedRowsSha256: evidence.rejectedRowsSha256,
      },
    }
  })
  const acquireWriterLock = async (context: JpOhlcvRepairExecutionContext) => {
    const { acquireUpdateLock, EXCLUSIVE_UPDATE_JOB_TYPES } = await import('@/lib/server/update-lock')
    const lock = await acquireUpdateLock(
      'jp_ohlcv_gap_repair',
      12 * 60 * 60,
      EXCLUSIVE_UPDATE_JOB_TYPES.filter((jobType) => jobType !== 'jp_ohlcv_gap_repair'),
    )
    if (!lock) throw new Error('repair_writer_lock_unavailable')
    context.childEnvironment.STOCKBOARD_JP_OHLCV_REPAIR_UPDATE_LOCK_OWNER = lock.owner
    return lock
  }

  const forward: JpOhlcvRepairAdapter = {
    acquireWriterLock,
    createAndVerifyConsistentBackup: async (context) => {
      const { closeLocalClientBeforeExternalWriter } = await import('@/lib/db/client')
      await closeLocalClientBeforeExternalWriter()
      const evidence = await runJsonStage<{
        databaseRealpath: string
        databaseIdentitySha256: string
        backupRealpath: string
        backupSha256: string
        quickCheck: 'PASS'
        sourceGeneration: string
        servingGeneration: string
      }>(input.plan.commands.createBackup, context)
      if (fs.realpathSync(evidence.databaseRealpath) !== input.approval.databaseRealpath
        || evidence.databaseIdentitySha256 !== input.approval.databaseIdentitySha256) {
        throw new Error('repair_backup_database_identity_mismatch')
      }
      if (fs.realpathSync(evidence.backupRealpath) !== evidence.backupRealpath) {
        throw new Error('repair_backup_realpath_mismatch')
      }
      const parentVerification = sha256BackupFileWithTimeout(evidence.backupRealpath)
      if (parentVerification.sha256 !== evidence.backupSha256) {
        throw new Error('repair_backup_sha256_mismatch')
      }
      return {
        ...evidence,
        parentBackupSha256ElapsedMs: parentVerification.elapsedMs,
        parentBackupSha256TimeoutMs: parentVerification.timeoutMs,
      }
    },
    revalidatePlan: async () => {
      if (!activeRuntimeSnapshot) throw new Error('repair_runtime_snapshot_required')
      const checkedAt = now()
      const current = captureJpOhlcvRuntimeSnapshot({
        databasePath: input.approval.databaseRealpath,
        configurationSha256: activeRuntimeSnapshot.configurationSha256,
        approvalScope: input.plan.approvalScope,
        officialRows: input.plan.officialRows,
        officialSourceProof: activeRuntimeSnapshot.officialSourceProof,
        officialSourceContract: activeRuntimeSnapshot.officialSourceContract,
        now: checkedAt,
      })
      assertJpOhlcvRuntimeSnapshotUnchanged({
        sealed: activeRuntimeSnapshot,
        current,
        stage: 'pre_backup',
        now: checkedAt,
      })
      verifiedScope = current.runtimeScope
      return verifiedScope
    },
    renewRuntimeSnapshotAfterBackup: async (context) => {
      if (!activeRuntimeSnapshot || !verifiedScope) throw new Error('repair_runtime_snapshot_required')
      const refreshedSource = await refreshOfficialSource(input.approval.targetDate)
      assertJQuantsRejectedDailyRowEvidence(refreshedSource.rejectedRows, refreshedSource.contract)
      if (stableSha256(refreshedSource.contract) !== stableSha256(input.approval.officialSourceContract)) {
        throw new Error(
          `repair_runtime_snapshot_renewal_provider_envelope_changed:expectedProvider=`
          + `${input.approval.officialSourceContract.providerRows}:observedProvider=${refreshedSource.contract.providerRows}:`
          + `expectedAccepted=${input.approval.officialSourceContract.acceptedRows}:`
          + `observedAccepted=${refreshedSource.contract.acceptedRows}:expectedRejected=`
          + `${input.approval.officialSourceContract.rejectedRows}:observedRejected=`
          + `${refreshedSource.contract.rejectedRows}:expectedUnexpected=`
          + `${input.approval.officialSourceContract.unexpectedRejectedRows}:observedUnexpected=`
          + `${refreshedSource.contract.unexpectedRejectedRows}:expectedContent=`
          + `${input.approval.officialSourceContract.contentSha256}:observedContent=`
          + `${refreshedSource.contract.contentSha256}:expectedRejectedHash=`
          + `${input.approval.officialSourceContract.rejectedRowsSha256}:observedRejectedHash=`
          + `${refreshedSource.contract.rejectedRowsSha256}`,
        )
      }
      const renewedAt = now()
      const renewed = captureJpOhlcvRuntimeSnapshot({
        databasePath: input.approval.databaseRealpath,
        configurationSha256: activeRuntimeSnapshot.configurationSha256,
        approvalScope: input.plan.approvalScope,
        officialRows: refreshedSource.rows,
        officialSourceProof: refreshedSource.proof,
        officialSourceContract: refreshedSource.contract,
        now: renewedAt,
      })
      assertJpOhlcvRuntimeSnapshotRenewal({
        previous: activeRuntimeSnapshot,
        renewed,
        now: renewedAt,
      })
      assertJpOhlcvRuntimeSnapshotPreinsertBudget({ snapshot: renewed, now: renewedAt })
      if (stableSha256(renewed.runtimeScope) !== stableSha256(verifiedScope)) {
        throw new Error(
          `repair_runtime_snapshot_renewal_scope_changed:expected=${stableSha256(verifiedScope)}:`
          + `observed=${stableSha256(renewed.runtimeScope)}`,
        )
      }
      const evidencePath = path.join(
        input.approval.stateDirectory,
        `runtime-snapshot-renewed-${context.transactionId}.json`,
      )
      atomicJson(evidencePath, {
        version: 1,
        transactionId: context.transactionId,
        renewedAt: renewed.capturedAt,
        snapshot: renewed,
        rejectedRows: refreshedSource.rejectedRows,
      })
      activeRuntimeSnapshot = renewed
      verifiedScope = renewed.runtimeScope
      return {
        runtimeScope: renewed.runtimeScope,
        snapshotSha256: renewed.snapshotSha256,
        capturedAt: renewed.capturedAt,
        expiresAt: renewed.expiresAt,
        officialSourceProofSha256: renewed.officialSourceProofSha256,
        officialSourceContractSha256: renewed.officialSourceContractSha256,
        providerRows: renewed.officialSourceProof.providerRows,
        acceptedRows: renewed.officialSourceProof.acceptedRows,
        rejectedRows: renewed.officialSourceProof.rejectedRows,
        noTradeRows: renewed.officialSourceProof.noTradeRows,
        unexpectedRejectedRows: renewed.officialSourceProof.unexpectedRejectedRows,
        evidencePath,
        evidenceFileSha256: sha256File(evidencePath),
      }
    },
    assertPreinsertRuntimeSnapshot: async () => {
      if (!activeRuntimeSnapshot || !verifiedScope) throw new Error('repair_runtime_snapshot_required')
      const checkedAt = now()
      const current = captureJpOhlcvRuntimeSnapshot({
        databasePath: input.approval.databaseRealpath,
        configurationSha256: activeRuntimeSnapshot.configurationSha256,
        approvalScope: input.plan.approvalScope,
        officialRows: input.plan.officialRows,
        officialSourceProof: activeRuntimeSnapshot.officialSourceProof,
        officialSourceContract: activeRuntimeSnapshot.officialSourceContract,
        now: checkedAt,
      })
      assertJpOhlcvRuntimeSnapshotUnchanged({
        sealed: activeRuntimeSnapshot,
        current,
        stage: 'post_read_service_hold',
        now: checkedAt,
      })
      return {
        snapshotSha256: activeRuntimeSnapshot.snapshotSha256,
        checkedAt: checkedAt.toISOString(),
        expiresAt: activeRuntimeSnapshot.expiresAt,
        remainingValidityMs: Date.parse(activeRuntimeSnapshot.expiresAt) - checkedAt.getTime(),
      }
    },
    holdReadServices: async (context) => {
      const { closeLocalClientBeforeExternalWriter } = await import('@/lib/db/client')
      await closeLocalClientBeforeExternalWriter()
      return runJsonStage(input.plan.commands.holdReadServices, context)
    },
    insertMissingRowsAtomically: async (scope, context) => {
      if (!verifiedScope || stableSha256(verifiedScope) !== stableSha256(scope)) {
        throw new Error('repair_insert_scope_not_revalidated')
      }
      if (!activeRuntimeSnapshot) throw new Error('repair_runtime_snapshot_required')
      const checkedAt = now()
      const beforeInsertSnapshot = captureJpOhlcvRuntimeSnapshot({
        databasePath: input.approval.databaseRealpath,
        configurationSha256: activeRuntimeSnapshot.configurationSha256,
        approvalScope: input.plan.approvalScope,
        officialRows: input.plan.officialRows,
        officialSourceProof: activeRuntimeSnapshot.officialSourceProof,
        officialSourceContract: activeRuntimeSnapshot.officialSourceContract,
        now: checkedAt,
      })
      assertJpOhlcvRuntimeSnapshotUnchanged({
        sealed: activeRuntimeSnapshot,
        current: beforeInsertSnapshot,
        stage: 'pre_insert',
        now: checkedAt,
      })
      const { client } = await import('@/lib/db/client')
      const transaction = await client.transaction('write')
      let insertedRows = 0
      try {
        const beforeRows = await transaction.execute({
          sql: 'SELECT ticker, date, open, high, low, close, volume FROM ohlcv_daily WHERE date = ? ORDER BY ticker',
          args: [input.approval.targetDate],
        })
        const beforeScope = revalidatedScope({
          approvalScope: input.plan.approvalScope,
          officialRows: input.plan.officialRows,
          existingRows: beforeRows.rows.map((row) => ({
            ticker: String(row.ticker),
            date: String(row.date),
            open: Number(row.open),
            high: Number(row.high),
            low: Number(row.low),
            close: Number(row.close),
            volume: Number(row.volume),
          })),
        })
        if (beforeScope.status !== 'READY' || stableSha256(beforeScope) !== stableSha256(scope)) {
          throw new Error('repair_insert_runtime_scope_changed')
        }
        for (const row of scope.missingRows) {
          const result = await transaction.execute({
            sql: `INSERT INTO ohlcv_daily (ticker, date, open, high, low, close, volume)
                  VALUES (?, ?, ?, ?, ?, ?, ?)`,
            args: [row.ticker, row.date, row.open, row.high, row.low, row.close, row.volume],
          })
          insertedRows += Number(result.rowsAffected ?? 0)
        }
        if (insertedRows !== scope.missingRows.length) throw new Error('repair_insert_row_count_mismatch')
        await transaction.commit()
      } catch (error) {
        try { await transaction.rollback() } catch { /* retain original failure */ }
        throw error
      }
      const published = await runJsonStage<{ status: 'PASS'; sourceGeneration: string }>(
        input.plan.commands.publishSourceGeneration,
        context,
      )
      if (published.status !== 'PASS' || published.sourceGeneration !== input.approval.sourceGenerationAfter) {
        throw new Error('repair_source_generation_publication_mismatch')
      }
      return { insertedRows, missingRowsSha256: scope.missingRowsSha256, sourceGeneration: published.sourceGeneration }
    },
    verifyData: async (scope, context) => {
      const after = revalidatedScope({
        approvalScope: input.plan.approvalScope,
        officialRows: input.plan.officialRows,
        existingRows: await currentRows(input.approval.targetDate),
      })
      if (after.missingRows.length !== 0
        || after.preservedConflictsSha256 !== scope.preservedConflictsSha256
        || after.alreadySatisfiedRows.length !== input.plan.approvalScope.missingRows.length) {
        throw new Error('repair_post_insert_coverage_mismatch')
      }
      const generation = await runJsonStage<{ status: 'PASS'; sourceGeneration: string }>(
        input.plan.commands.verifyDataGeneration,
        context,
      )
      if (generation.status !== 'PASS' || generation.sourceGeneration !== input.approval.sourceGenerationAfter) {
        throw new Error('repair_post_insert_generation_mismatch')
      }
      return {
        missingRows: 0,
        preservedConflictsSha256: after.preservedConflictsSha256,
        sourceGeneration: generation.sourceGeneration,
      }
    },
    rebuildDerivedServing: async (context) => {
      const { closeLocalClientBeforeExternalWriter } = await import('@/lib/db/client')
      await closeLocalClientBeforeExternalWriter()
      const rebuilt: string[] = []
      const sequence = await runJsonStageSequenceWithinBudget<{ status: 'PASS'; rebuilt: string[] }>({
        commands: input.plan.commands.rebuildDerivedServing,
        aggregateTimeoutMs: input.plan.timeBudget.forwardDerivedAggregateMs,
        context,
        errorCode: 'repair_forward_derived_aggregate_budget_exhausted',
      })
      for (const result of sequence.results) {
        if (result.status !== 'PASS' || !Array.isArray(result.rebuilt) || result.rebuilt.length === 0) {
          throw new Error('repair_derived_command_evidence_mismatch')
        }
        rebuilt.push(...result.rebuilt)
      }
      return {
        derivedPlanSha256: input.approval.derivedPlanSha256,
        sourceGeneration: input.approval.sourceGenerationAfter,
        servingGeneration: input.approval.servingGenerationAfter,
        rebuilt,
        aggregateElapsedMs: sequence.elapsedMs,
        aggregateTimeoutMs: sequence.aggregateTimeoutMs,
      }
    },
    verifyServing: (context) => runJsonStage(input.plan.commands.verifyServing, context),
    resumeReadServices: (context) => runJsonStage(input.plan.commands.resumeReadServices, context),
  }

  const rollback: JpOhlcvRepairRollbackAdapter = {
    acquireWriterLock,
    restoreRecoveryRequired: async (context) => {
      const state = path.join(input.approval.stateDirectory, `rollback-restore-${context.transactionId}.json`)
      if (!fs.existsSync(state)) return false
      const parsed = JSON.parse(fs.readFileSync(state, 'utf8')) as { phase?: unknown }
      return parsed.phase !== 'COMPLETED'
    },
    verifyBackupForRollback: async (context) => {
      const evidence = await runJsonStage<{
        backupRealpath: string
        backupSha256: string
        quickCheck: 'PASS'
        sourceGeneration: string
        servingGeneration: string
      }>(input.plan.commands.verifyBackupForRollback, context)
      const parentVerification = sha256BackupFileWithTimeout(evidence.backupRealpath)
      if (fs.realpathSync(evidence.backupRealpath) !== evidence.backupRealpath
        || parentVerification.sha256 !== evidence.backupSha256) {
        throw new Error('repair_rollback_backup_file_identity_mismatch')
      }
      return {
        ...evidence,
        parentBackupSha256ElapsedMs: parentVerification.elapsedMs,
        parentBackupSha256TimeoutMs: parentVerification.timeoutMs,
      }
    },
    holdReadServices: async (context) => {
      const { closeLocalClientBeforeExternalWriter } = await import('@/lib/db/client')
      await closeLocalClientBeforeExternalWriter()
      return runJsonStage(input.plan.commands.holdReadServices, context)
    },
    restoreBackupAtomically: async (context) => {
      const { closeLocalClientBeforeExternalWriter } = await import('@/lib/db/client')
      await closeLocalClientBeforeExternalWriter()
      const evidence = await runJsonStage<{
        databaseRealpath: string
        databaseSha256: string
        sourceGeneration: string
        restoreStatePath: string
        restorePhase: 'COMPLETED'
      }>(input.plan.commands.restoreBackup, context)
      if (fs.realpathSync(evidence.databaseRealpath) !== input.approval.databaseRealpath
        || sha256File(evidence.databaseRealpath) !== evidence.databaseSha256
        || evidence.restorePhase !== 'COMPLETED'
        || path.dirname(evidence.restoreStatePath) !== input.approval.stateDirectory
        || !fs.statSync(evidence.restoreStatePath).isFile()) {
        throw new Error('repair_rollback_restored_database_identity_mismatch')
      }
      return evidence
    },
    rebuildOriginalDerivedServing: async (context) => {
      const { closeLocalClientBeforeExternalWriter } = await import('@/lib/db/client')
      await closeLocalClientBeforeExternalWriter()
      const rebuilt: string[] = []
      const sequence = await runJsonStageSequenceWithinBudget<{ status: 'PASS'; rebuilt: string[] }>({
        commands: input.plan.commands.rebuildOriginalDerivedServing,
        aggregateTimeoutMs: input.plan.timeBudget.rollbackDerivedAggregateMs,
        context,
        errorCode: 'repair_rollback_derived_aggregate_budget_exhausted',
      })
      for (const result of sequence.results) {
        if (result.status !== 'PASS' || !Array.isArray(result.rebuilt) || result.rebuilt.length === 0) {
          throw new Error('repair_rollback_derived_command_evidence_mismatch')
        }
        rebuilt.push(...result.rebuilt)
      }
      const approval = input.rollbackApproval
      if (!approval) throw new Error('repair_rollback_approval_required')
      return {
        sourceGeneration: approval.sourceGenerationTarget,
        servingGeneration: approval.servingGenerationTarget,
        rebuilt,
        aggregateElapsedMs: sequence.elapsedMs,
        aggregateTimeoutMs: sequence.aggregateTimeoutMs,
      }
    },
    verifyOriginalServing: (context) => runJsonStage(input.plan.commands.verifyOriginalServing, context),
    resumeReadServices: (context) => runJsonStage(input.plan.commands.resumeReadServices, context),
  }
  return { forward, rollback }
}
