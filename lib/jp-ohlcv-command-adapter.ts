import { spawn } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import {
  buildJpOhlcvBackfillPlan,
  buildJpOhlcvMissingOnlyRepairScope,
  stableSha256,
  type JpOfficialOhlcvValue,
  type JpOhlcvMissingOnlyRepairScope,
  type JpOhlcvValue,
} from '@/lib/jp-ohlcv-data-quality'
import type {
  JpOhlcvRepairAdapter,
  JpOhlcvRepairExecutionContext,
  JpOhlcvRepairRollbackAdapter,
} from '@/lib/jp-ohlcv-repair-runner'
import type { JpOhlcvRepairApproval, JpOhlcvRepairRollbackApproval } from '@/lib/jp-ohlcv-production-repair'
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
      if (!failure && timedOut) failure = new Error('repair_stage_command_timeout')
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
  approval: JpOhlcvRepairApproval
  officialRows: JpOfficialOhlcvValue[]
  existingRows: JpOhlcvValue[]
}): JpOhlcvMissingOnlyRepairScope {
  const plan = buildJpOhlcvBackfillPlan({
    date: input.approval.targetDate,
    officialRows: input.officialRows,
    existingRows: input.existingRows,
  })
  return buildJpOhlcvMissingOnlyRepairScope({
    plan,
    approvedConflictTickers: input.approval.approvedConflictTickers,
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
}

export function createJpOhlcvCommandAdapters(input: {
  approval: JpOhlcvRepairApproval
  plan: JpOhlcvRepairExecutionPlan
  rollbackApproval?: JpOhlcvRepairRollbackApproval
}): { forward: JpOhlcvRepairAdapter; rollback: JpOhlcvRepairRollbackAdapter } {
  assertPlan(input)
  let verifiedScope: JpOhlcvMissingOnlyRepairScope | null = null
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
      if (sha256File(evidence.backupRealpath) !== evidence.backupSha256) {
        throw new Error('repair_backup_sha256_mismatch')
      }
      return evidence
    },
    revalidatePlan: async () => {
      verifiedScope = revalidatedScope({
        approval: input.approval,
        officialRows: input.plan.officialRows,
        existingRows: await currentRows(input.approval.targetDate),
      })
      return verifiedScope
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
      const { client } = await import('@/lib/db/client')
      const transaction = await client.transaction('write')
      let insertedRows = 0
      try {
        for (const row of scope.missingRows) {
          const result = await transaction.execute({
            sql: `INSERT INTO ohlcv_daily (ticker, date, open, high, low, close, volume)
                  VALUES (?, ?, ?, ?, ?, ?, ?)
                  ON CONFLICT(ticker, date) DO NOTHING`,
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
        approval: input.approval,
        officialRows: input.plan.officialRows,
        existingRows: await currentRows(input.approval.targetDate),
      })
      if (after.missingRows.length !== 0
        || after.preservedConflictsSha256 !== scope.preservedConflictsSha256) {
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
      for (const command of input.plan.commands.rebuildDerivedServing) {
        const result = await runJsonStage<{ status: 'PASS'; rebuilt: string[] }>(command, context)
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
      if (fs.realpathSync(evidence.backupRealpath) !== evidence.backupRealpath
        || sha256File(evidence.backupRealpath) !== evidence.backupSha256) {
        throw new Error('repair_rollback_backup_file_identity_mismatch')
      }
      return evidence
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
      for (const command of input.plan.commands.rebuildOriginalDerivedServing) {
        const result = await runJsonStage<{ status: 'PASS'; rebuilt: string[] }>(command, context)
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
      }
    },
    verifyOriginalServing: (context) => runJsonStage(input.plan.commands.verifyOriginalServing, context),
    resumeReadServices: (context) => runJsonStage(input.plan.commands.resumeReadServices, context),
  }
  return { forward, rollback }
}
