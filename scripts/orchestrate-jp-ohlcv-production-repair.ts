import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn, type ChildProcess } from 'node:child_process'
import {
  assertJpOhlcvExecutionSourceIdentity,
  assertJpOhlcvProductionExecutionConfiguration,
  assertJpOhlcvProductionExecutionPackage,
  assertJpOhlcvStorageIdentityEnvironment,
  executionPackageSha256,
  sha256File,
  type JpOhlcvProductionExecutionConfiguration,
  type JpOhlcvProductionExecutionPackage,
} from '@/lib/jp-ohlcv-executable-plan'
import { runJpOhlcvMaintenanceOrchestrator } from '@/lib/jp-ohlcv-maintenance-orchestrator'
import { JP_OHLCV_BACKUP_TIME_LIMITS } from '@/lib/jp-ohlcv-backup-time-budget'
import {
  isProcessGroupAlive,
  terminateAndWaitForProcessGroup,
} from '@/lib/jp-ohlcv-repair-process-supervisor'
import {
  assertNoUnauthorizedDatabaseHandles,
  createLaunchdWriterHoldDriver,
} from '@/lib/storage/launchd-writer-hold-driver'
import {
  WriterHoldError,
  WriterPreflightError,
  type WriterHoldDriver,
} from '@/lib/storage/weekly-writer-hold'
import { inspectWritableTargetPath } from '@/lib/storage/external-storage-guard'
import {
  buildJpOhlcvBackfillPlan,
  type JpOfficialOhlcvValue,
  type JpOhlcvMissingOnlyRepairScope,
} from '@/lib/jp-ohlcv-data-quality'
import type { JpOhlcvRepairExecutionPlan } from '@/lib/jp-ohlcv-command-adapter'
import type { JpOhlcvRepairApproval } from '@/lib/jp-ohlcv-production-repair'
import {
  assertJQuantsDailyByDateSourceContract,
  fetchJQuantsDailyByDateWithEvidence,
} from '@/lib/jquants'
import {
  assertJpOhlcvRuntimeSnapshot,
  captureJpOhlcvRuntimeSnapshot,
  type JpOhlcvRuntimeSnapshot,
} from '@/lib/jp-ohlcv-runtime-snapshot'

type OperatorPhase = 'PRE_FLIGHT' | 'WRITER_HOLD' | 'IN_TRANSACTION' | 'COMMIT_VERIFY' | 'POST_COMMIT'
type MutationState = 'NOT_STARTED' | 'TRANSACTION_STATE_UNCERTAIN' | 'COMMIT_REPORTED' | 'COMMIT_VERIFIED'

let operatorPhase: OperatorPhase = 'PRE_FLIGHT'
let operatorMutationState: MutationState = 'NOT_STARTED'
let operatorConfig: JpOhlcvProductionExecutionConfiguration | null = null
let operatorWriterDriver: WriterHoldDriver | null = null
let operatorOfficialSourceEvidence: null | {
  requestedAt: string
  completedAt: string
  providerRows: number
  acceptedRows: number
  rejectedRows: number
  noTradeRows: number
  unexpectedRejectedRows: number
  contentSha256: string
  rejectedRowsSha256: string
  rejectedRowEvidence: unknown[]
} = null

function redactedError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error))
    .replace(/\b(Bearer|Basic)\s+[^\s]+/gi, '$1 [REDACTED]')
    .replace(/\b(x-api-key|authorization)\s*:\s*[^\s,}]+/gi, '$1: [REDACTED]')
    .replace(/\b([A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|AUTH|COOKIE|API_KEY)[A-Z0-9_]*)=([^\s]+)/gi, '$1=[REDACTED]')
    .replace(/("(?:password|token|secret|api[_-]?key|authorization)"\s*:\s*)"[^"]*"/gi, '$1"[REDACTED]"')
}

function value(flag: string): string {
  const index = process.argv.indexOf(flag)
  const result = index >= 0 ? process.argv[index + 1] : null
  if (!result || result.startsWith('--')) throw new Error(`${flag}_required`)
  return result
}

function absolute(flag: string): string {
  const result = value(flag)
  if (!path.isAbsolute(result)) throw new Error(`${flag}_absolute_path_required`)
  return path.resolve(result)
}

function readJson<T>(file: string): T {
  if (fs.lstatSync(file).isSymbolicLink()) throw new Error('repair_orchestrator_json_symlink_forbidden')
  return JSON.parse(fs.readFileSync(file, 'utf8')) as T
}

async function runChild(
  bundle: JpOhlcvProductionExecutionPackage,
  config: JpOhlcvProductionExecutionConfiguration,
  runtimeSnapshotPath: string,
  runtimeSnapshot: JpOhlcvRuntimeSnapshot,
  onSpawn: () => void,
): Promise<{
  status: 'COMMITTED'
  archivedJournal: string
  transactionId: string
}> {
  const command = bundle.runner
  assertJpOhlcvExecutionSourceIdentity(config)
  assertJpOhlcvStorageIdentityEnvironment(config, command.environment)
  if (sha256File(fs.realpathSync(command.executable)) !== command.executableSha256) {
    throw new Error('repair_orchestrator_runner_executable_changed')
  }
  for (const sealed of command.sealedFiles) {
    if (sha256File(fs.realpathSync(sealed.path)) !== sealed.sha256) {
      throw new Error(`repair_orchestrator_runner_sealed_file_changed:${sealed.path}`)
    }
  }
  return new Promise((resolve, reject) => {
    const child: ChildProcess = spawn(command.executable, command.args, {
      cwd: command.workingDirectory,
      env: {
        NODE_ENV: 'production',
        PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
        HOME: process.env.HOME,
        USER: process.env.USER,
        LOGNAME: process.env.LOGNAME,
        TMPDIR: process.env.TMPDIR,
        LANG: process.env.LANG,
        LC_ALL: process.env.LC_ALL,
        TZ: process.env.TZ,
        ...command.environment,
        ...(process.env.JQUANTS_API_KEY
          ? { JQUANTS_API_KEY: process.env.JQUANTS_API_KEY }
          : {}),
        STOCKBOARD_JP_OHLCV_PRODUCTION_REPAIR_APPROVED:
          process.env.STOCKBOARD_JP_OHLCV_PRODUCTION_REPAIR_APPROVED!,
        STOCKBOARD_JP_OHLCV_RUNTIME_SNAPSHOT_PATH: runtimeSnapshotPath,
        STOCKBOARD_JP_OHLCV_RUNTIME_SNAPSHOT_SHA256: runtimeSnapshot.snapshotSha256,
        STOCKBOARD_JP_OHLCV_RUNTIME_SNAPSHOT_FILE_SHA256: sha256File(runtimeSnapshotPath),
      },
      shell: false,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const stdout: string[] = []
    const stderr: string[] = []
    let interruptedBy: NodeJS.Signals | null = null
    let timerFailure: Error | null = null
    const signalProcessGroup = (signal: NodeJS.Signals) => {
      if (!child.pid) return
      try {
        process.kill(-child.pid, signal)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {
          timerFailure = error instanceof Error ? error : new Error(String(error))
        }
      }
    }
    const handleSignal = (signal: NodeJS.Signals) => {
      interruptedBy = signal
      signalProcessGroup('SIGTERM')
    }
    const onSigterm = () => handleSignal('SIGTERM')
    const onSigint = () => handleSignal('SIGINT')
    process.once('SIGTERM', onSigterm)
    process.once('SIGINT', onSigint)
    if (!child.pid) {
      process.off('SIGTERM', onSigterm)
      process.off('SIGINT', onSigint)
      reject(new Error('repair_orchestrator_runner_pid_missing'))
      return
    }
    onSpawn()
    const terminationTimer = setTimeout(() => {
      signalProcessGroup('SIGTERM')
    }, command.timeoutMs)
    const killTimer = setTimeout(() => {
      signalProcessGroup('SIGKILL')
    }, command.timeoutMs + 10_000)
    child.stdout?.on('data', (chunk: Buffer | string) => stdout.push(String(chunk)))
    child.stderr?.on('data', (chunk: Buffer | string) => stderr.push(String(chunk)))
    child.once('error', (error) => {
      clearTimeout(terminationTimer)
      clearTimeout(killTimer)
      process.off('SIGTERM', onSigterm)
      process.off('SIGINT', onSigint)
      reject(error)
    })
    child.once('close', async (code, signal) => {
      clearTimeout(terminationTimer)
      clearTimeout(killTimer)
      process.off('SIGTERM', onSigterm)
      process.off('SIGINT', onSigint)
      try {
        if (child.pid && isProcessGroupAlive(child.pid)) {
          await terminateAndWaitForProcessGroup(child.pid)
        }
      } catch (error) {
        reject(error)
        return
      }
      if (timerFailure) {
        reject(timerFailure)
        return
      }
      if (interruptedBy) {
        reject(new Error(`repair_orchestrator_interrupted:${interruptedBy}`))
        return
      }
      if (code !== 0 || signal) {
        reject(new Error(`repair_orchestrator_runner_failed:exit_${code}:signal_${signal}:${stderr.join('').slice(-8000)}`))
        return
      }
      const line = stdout.join('').split('\n').map((entry) => entry.trim()).filter(Boolean).at(-1)
      if (!line) {
        reject(new Error('repair_orchestrator_runner_result_missing'))
        return
      }
      try {
        const result = JSON.parse(line) as { status?: unknown; archivedJournal?: unknown }
        if (result.status !== 'COMMITTED' || typeof result.archivedJournal !== 'string') {
          throw new Error('repair_orchestrator_runner_result_invalid')
        }
        const match = path.basename(result.archivedJournal).match(/^repair-journal\.json\.committed-(.+)$/)
        if (!match) throw new Error('repair_orchestrator_committed_journal_name_invalid')
        if (fs.realpathSync(path.dirname(result.archivedJournal)) !== fs.realpathSync(config.stateDirectory)) {
          throw new Error('repair_orchestrator_committed_journal_directory_invalid')
        }
        const journal = readJson<{ transactionId?: unknown }>(result.archivedJournal)
        if (journal.transactionId !== match[1]) {
          throw new Error('repair_orchestrator_committed_journal_transaction_mismatch')
        }
        resolve({ status: 'COMMITTED', archivedJournal: result.archivedJournal, transactionId: match[1] })
      } catch (error) {
        reject(error)
      }
    })
  })
}

async function main(): Promise<void> {
  if (!process.argv.includes('--execute')) throw new Error('--execute_required')
  const packageFile = absolute('--execution-package')
  const bundle = readJson<JpOhlcvProductionExecutionPackage>(packageFile)
  assertJpOhlcvProductionExecutionPackage(bundle)
  const currentScript = fs.realpathSync(fileURLToPath(import.meta.url))
  if (currentScript !== fs.realpathSync(bundle.orchestratorScriptPath)
    || sha256File(currentScript) !== bundle.orchestratorScriptSha256) {
    throw new Error('repair_orchestrator_self_identity_mismatch')
  }
  const packageSha256 = executionPackageSha256(bundle)
  if (process.env.STOCKBOARD_JP_OHLCV_EXECUTION_PACKAGE_APPROVED !== packageSha256) {
    throw new Error('repair_orchestrator_exact_package_approval_required')
  }
  const config = readJson<JpOhlcvProductionExecutionConfiguration>(bundle.configurationPath)
  assertJpOhlcvProductionExecutionConfiguration(config)
  if (sha256File(bundle.configurationPath) !== bundle.configurationSha256
    || config.mode !== 'PRODUCTION'
    || config.targetDate !== bundle.targetDate) {
    throw new Error('repair_orchestrator_configuration_mismatch')
  }
  operatorConfig = config
  const approvalBundle = readJson<{
    approval: JpOhlcvRepairApproval
    scope: JpOhlcvMissingOnlyRepairScope
  }>(bundle.approvalBundlePath)
  try {
    assertJQuantsDailyByDateSourceContract(approvalBundle.approval.officialSourceContract, {
      requestedDate: config.targetDate,
      acceptedRows: approvalBundle.approval.expectedOfficialRows,
      contentSha256: approvalBundle.approval.officialSha256,
    })
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    throw new Error(`repair_execution_package_stale_official_source_contract_regenerate_required:${reason}`)
  }
  const executionPlan = readJson<JpOhlcvRepairExecutionPlan>(bundle.executionPlanPath)
  const sealedOfficialSha256 = buildJpOhlcvBackfillPlan({
    date: config.targetDate,
    officialRows: executionPlan.officialRows,
    existingRows: [],
  }).officialSha256
  if (sealedOfficialSha256 !== approvalBundle.scope.officialSha256) {
    throw new Error('repair_preflight_sealed_official_source_mismatch')
  }
  const fetchCurrentOfficial = async (): Promise<{
    rows: JpOfficialOhlcvValue[]
    proof: JpOhlcvRuntimeSnapshot['officialSourceProof']
  }> => {
    const evidence = await fetchJQuantsDailyByDateWithEvidence(config.targetDate, {
      timeoutMs: JP_OHLCV_BACKUP_TIME_LIMITS.officialSourceFetchMaxTimeoutMs,
    })
    operatorOfficialSourceEvidence = {
      requestedAt: evidence.requestedAt,
      completedAt: evidence.completedAt,
      providerRows: evidence.providerRows,
      acceptedRows: evidence.acceptedRows,
      rejectedRows: evidence.rejectedRows,
      noTradeRows: evidence.noTradeRows,
      unexpectedRejectedRows: evidence.unexpectedRejectedRows,
      contentSha256: evidence.contentSha256,
      rejectedRowsSha256: evidence.rejectedRowsSha256,
      rejectedRowEvidence: evidence.rejectedRowEvidence,
    }
    const currentOfficialSha256 = buildJpOhlcvBackfillPlan({
      date: config.targetDate,
      officialRows: evidence.rows,
      existingRows: [],
    }).officialSha256
    if (currentOfficialSha256 !== approvalBundle.scope.officialSha256) {
      throw new Error('repair_preflight_official_source_hash_changed')
    }
    return {
      rows: evidence.rows,
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
  }
  const preHoldOfficial = await fetchCurrentOfficial()
  const preHoldSnapshot = captureJpOhlcvRuntimeSnapshot({
    databasePath: config.databaseRealpath,
    configurationSha256: bundle.configurationSha256,
    approvalScope: approvalBundle.scope,
    officialRows: preHoldOfficial.rows,
    officialSourceProof: preHoldOfficial.proof,
    officialSourceContract: approvalBundle.approval.officialSourceContract,
  })
  assertJpOhlcvRuntimeSnapshot({
    snapshot: preHoldSnapshot,
    expectedOfficialSourceContract: approvalBundle.approval.officialSourceContract,
  })
  inspectWritableTargetPath({
    dbPath: config.databaseRealpath,
    ...config.storageIdentity,
    jobType: 'jp_ohlcv_gap_repair',
  })
  const driver = createLaunchdWriterHoldDriver(config.writerServices.map((service) => ({
    label: service.label,
    plistPath: service.plistPath,
    definitionSha256: service.definitionSha256,
    program: service.program,
  })))
  operatorWriterDriver = driver
  operatorPhase = 'WRITER_HOLD'
  type CommittedEvidence = {
    approvedMissingRows: number
    alreadySatisfiedExactRows: number
    residualMissingRows: number
    insertedRows: number
    remainingMissingRows: number
    readServices: unknown
  }
  const committedEvidence: { value: CommittedEvidence | null } = { value: null }
  const result = await runJpOhlcvMaintenanceOrchestrator({
    config,
    driver,
    assertOnlyApprovedReaderHandles: async () => {
      assertNoUnauthorizedDatabaseHandles({
        databasePath: config.databaseRealpath,
        approvedReaders: config.readServices.map((service) => ({
          label: service.label,
          plistPath: service.plistPath,
          definitionSha256: service.definitionSha256,
          program: service.program,
        })),
        timeoutMs: JP_OHLCV_BACKUP_TIME_LIMITS.readerHandleProbeMaxTimeoutMs,
      })
    },
    runTransaction: async (assertWriterHoldValid) => {
      await assertWriterHoldValid()
      const writerStaticOfficial = await fetchCurrentOfficial()
      const runtimeSnapshot = captureJpOhlcvRuntimeSnapshot({
        databasePath: config.databaseRealpath,
        configurationSha256: bundle.configurationSha256,
        approvalScope: approvalBundle.scope,
        officialRows: writerStaticOfficial.rows,
        officialSourceProof: writerStaticOfficial.proof,
        officialSourceContract: approvalBundle.approval.officialSourceContract,
      })
      assertJpOhlcvRuntimeSnapshot({
        snapshot: runtimeSnapshot,
        expectedOfficialSourceContract: approvalBundle.approval.officialSourceContract,
      })
      fs.mkdirSync(config.stateDirectory, { recursive: true, mode: 0o700 })
      const runtimeSnapshotPath = path.join(
        config.stateDirectory,
        `runtime-snapshot-${Date.now()}-${process.pid}.json`,
      )
      fs.writeFileSync(runtimeSnapshotPath, `${JSON.stringify(runtimeSnapshot, null, 2)}\n`, {
        flag: 'wx',
        mode: 0o600,
      })
      operatorPhase = 'IN_TRANSACTION'
      const committed = await runChild(bundle, config, runtimeSnapshotPath, runtimeSnapshot, () => {
        operatorMutationState = 'TRANSACTION_STATE_UNCERTAIN'
      })
      operatorMutationState = 'COMMIT_REPORTED'
      return committed
    },
    assertCommittedState: async (committed) => {
      operatorPhase = 'COMMIT_VERIFY'
      if (!fs.existsSync(committed.archivedJournal)
        || fs.existsSync(path.join(config.stateDirectory, 'repair.lock'))
        || fs.existsSync(path.join(config.stateDirectory, 'repair-journal.json'))) {
        throw new Error('repair_orchestrator_commit_state_uncertain')
      }
      const source = readJson<{ generation?: unknown; transactionId?: unknown }>(config.sourceGenerationPointer)
      const serving = readJson<{
        generation?: unknown
        sourceGeneration?: unknown
        transactionId?: unknown
      }>(config.servingGenerationPointer)
      if (source.generation !== config.sourceGenerationAfter
        || source.transactionId !== committed.transactionId
        || serving.generation !== config.servingGenerationAfter
        || serving.sourceGeneration !== config.sourceGenerationAfter
        || serving.transactionId !== committed.transactionId) {
        throw new Error('repair_orchestrator_committed_generation_mismatch')
      }
      const journal = readJson<{ stage?: unknown; evidence?: Record<string, unknown> }>(committed.archivedJournal)
      const dataCommit = journal.evidence?.DATA_COMMITTED as { insertedRows?: unknown } | undefined
      const dataCommitting = journal.evidence?.DATA_COMMITTING as {
        approvedMissingRows?: unknown
        alreadySatisfiedExactRows?: unknown
        residualMissingRows?: unknown
        missingRows?: unknown
      } | undefined
      const dataVerification = journal.evidence?.DATA_VERIFIED as { missingRows?: unknown } | undefined
      const readServices = journal.evidence?.READ_SERVICES_RESUMED
      const insertedRows = Number(dataCommit?.insertedRows)
      const approvedMissingRows = Number(dataCommitting?.approvedMissingRows)
      const alreadySatisfiedExactRows = Number(dataCommitting?.alreadySatisfiedExactRows)
      const residualMissingRows = Number(dataCommitting?.residualMissingRows)
      const remainingMissingRows = Number(dataVerification?.missingRows)
      if (journal.stage !== 'COMMITTED'
        || residualMissingRows !== Number(dataCommitting?.missingRows)
        || insertedRows !== residualMissingRows
        || approvedMissingRows !== config.repairScope.missingRows
        || approvedMissingRows !== alreadySatisfiedExactRows + insertedRows
        || insertedRows < 0
        || insertedRows > config.repairScope.missingRows
        || remainingMissingRows !== 0
        || !readServices) {
        throw new Error('repair_orchestrator_committed_evidence_mismatch')
      }
      committedEvidence.value = {
        approvedMissingRows,
        alreadySatisfiedExactRows,
        residualMissingRows,
        insertedRows,
        remainingMissingRows,
        readServices,
      }
      operatorMutationState = 'COMMIT_VERIFIED'
    },
  })
  operatorPhase = 'POST_COMMIT'
  const finalEvidence = committedEvidence.value
  if (!finalEvidence) throw new Error('repair_orchestrator_committed_evidence_missing')
  console.log(JSON.stringify({
    status: finalEvidence.insertedRows === 0
      ? 'COMMITTED_ALREADY_SATISFIED_REBUILT'
      : 'COMMITTED',
    executionPackageSha256: packageSha256,
    approvedRepairKeys: finalEvidence.approvedMissingRows,
    alreadySatisfiedExact: finalEvidence.alreadySatisfiedExactRows,
    residualAtWriterStaticSnapshot: finalEvidence.residualMissingRows,
    insertedRows: finalEvidence.insertedRows,
    repairedMissingRows: finalEvidence.insertedRows,
    remainingMissingRows: finalEvidence.remainingMissingRows,
    preservedConflicts: config.preservedConflictTickers,
    unresolvedConflictCount: config.preservedConflictTickers.length,
    dataQualityStatus: 'MISSING_ROWS_REPAIRED_EXISTING_CONFLICTS_HOLD',
    existingRowsEvidenceKind: operatorConfig.existingEvidence.kind,
    dayFullyRepaired: false,
    derivedDataNote: finalEvidence.insertedRows === 0
      ? 'All approved missing keys were already present with exact sealed official values. No OHLCV row was inserted; generation publication and derived serving rebuild were still verified. Preserved conflicts retain their pre-repair values.'
      : 'Derived serving data uses the inserted rows plus approved keys already satisfied by exact sealed official values. Preserved conflicts retain their pre-repair values.',
    transaction: result.result,
    readServices: finalEvidence.readServices,
    writerRestoreSloStatus: result.writerHold.restoreWithinSlo ? 'PASS' : 'BREACH',
    writerHold: result.writerHold,
  }))
}

async function observeWriterStates(): Promise<Array<Record<string, unknown>> | null> {
  if (!operatorConfig || !operatorWriterDriver) return null
  return Promise.all(operatorConfig.writerServices.map(async (service) => {
    try {
      const state = await operatorWriterDriver!.observe(service.label)
      return {
        label: service.label,
        loaded: state.loaded,
        disabled: state.disabled,
        instances: state.instances,
        pid: state.pid ?? null,
        processGroupId: state.processGroupId ?? null,
      }
    } catch (error) {
      return { label: service.label, observationError: redactedError(error) }
    }
  }))
}

type HoldClass = 'BENIGN_RECAPTURE' | 'WAIT_FOR_UPDATER' | 'SOURCE_REVISED' | 'PRICE_CONFLICT'
  | 'UNAPPROVED_DRIFT' | 'PROVIDER_ENVELOPE_CHANGED' | 'CONCURRENT_STATE_CHANGE' | 'BACKUP_TIMEOUT'
  | 'WRITER_STATE_MISMATCH' | 'SAFETY_GATE' | 'UNCLASSIFIED'

function backupTimeoutSubtype(error: unknown): string | null {
  const message = error instanceof Error ? error.message : String(error)
  if (message.includes('repair_backup_copy_timeout_or_failure')) return 'BACKUP_COPY'
  if (message.includes('repair_backup_journal_mode_timeout_or_failure')) return 'JOURNAL_MODE_NORMALIZATION'
  if (message.includes('repair_backup_quick_check_timeout_or_failure')) return 'FULL_QUICK_CHECK'
  if (message.includes('repair_backup_sha256_timeout_or_failure')) return 'BACKUP_STAGE_SHA256'
  if (message.includes('repair_parent_backup_sha256_timeout')
    || message.includes('repair_parent_large_file_sha256_timeout')) return 'PARENT_SHA256_ATTESTATION'
  if (message.includes('repair_rollback_backup_sha256_timeout_or_failure')) return 'ROLLBACK_BACKUP_SHA256'
  if (message.includes('repair_rollback_backup_quick_check_timeout_or_failure')) return 'ROLLBACK_FULL_QUICK_CHECK'
  if (message.includes('repair_backup_time_budget_insufficient')) return 'STAGE_REMAINING_BUDGET'
  if (message.includes('repair_stage_command_timeout:create-backup')) return 'CREATE_BACKUP_STAGE'
  if (message.includes('repair_stage_command_timeout:verify-backup')) return 'VERIFY_BACKUP_STAGE'
  return null
}

function holdClass(error: unknown): HoldClass {
  if (error instanceof WriterPreflightError) return 'WRITER_STATE_MISMATCH'
  const message = error instanceof Error ? error.message : String(error)
  if (message.includes('repair_runtime_snapshot_expired:')) return 'BENIGN_RECAPTURE'
  if (message.includes('repair_runtime_snapshot_source_generation_not_publishable')) return 'WAIT_FOR_UPDATER'
  if (message.includes('repair_preflight_official_source_hash_changed')
    || message.includes('official_source_hash_changed')
    || message.includes('official_source_accepted_content_mismatch')
    || message.includes('approved_key_official_value_changed')) return 'SOURCE_REVISED'
  if (message.includes('official_source_rejection_policy_violation')
    || message.includes('official_source_provider_envelope_mismatch')) return 'PROVIDER_ENVELOPE_CHANGED'
  const summaryStart = message.indexOf('repair_runtime_snapshot_scope_hold:')
  if (summaryStart >= 0) {
    const encoded = message
      .slice(summaryStart + 'repair_runtime_snapshot_scope_hold:'.length)
      .split(/\r?\n/, 1)[0]
    try {
      const parsed = JSON.parse(encoded) as { holdClass?: unknown }
      if (parsed.holdClass === 'PRICE_CONFLICT') return 'PRICE_CONFLICT'
      if (parsed.holdClass === 'UNAPPROVED_DRIFT') return 'UNAPPROVED_DRIFT'
      if (parsed.holdClass === 'SOURCE_REVISED') return 'SOURCE_REVISED'
      return 'SAFETY_GATE'
    } catch {
      return 'SAFETY_GATE'
    }
  }
  if (message.includes('repair_runtime_snapshot_changed_after_writer_hold')) return 'CONCURRENT_STATE_CHANGE'
  if (message.includes('WRITER_INITIAL_STATE_MISMATCH:')
    || message.includes('WRITER_INITIAL_DISABLED_STATE_MISMATCH:')
    || message.includes('WRITER_EXPECTED_STATE_LABELS_INVALID')
    || message.includes('WRITER_EXPECTED_DISABLED_LABELS_INVALID')) return 'WRITER_STATE_MISMATCH'
  if (message.includes('repair_backup_copy_timeout_or_failure')
    || message.includes('repair_backup_journal_mode_timeout_or_failure')
    || message.includes('repair_backup_quick_check_timeout_or_failure')
    || message.includes('repair_backup_sha256_timeout_or_failure')
    || message.includes('repair_backup_time_budget_insufficient')
    || message.includes('repair_parent_backup_sha256_timeout')
    || message.includes('repair_parent_large_file_sha256_timeout')
    || message.includes('repair_stage_command_timeout:create-backup')
    || message.includes('repair_stage_command_timeout:verify-backup')
    || message.includes('repair_rollback_backup_sha256_timeout_or_failure')
    || message.includes('repair_rollback_backup_quick_check_timeout_or_failure')) return 'BACKUP_TIMEOUT'
  if (message.includes('repair_runtime_snapshot_invalid')
    || message.includes('repair_runtime_snapshot_official_source_proof_invalid')
    || message.includes('repair_runtime_snapshot_official_source_contract_invalid')
    || message.includes('repair_runtime_snapshot_official_source_contract_approval_mismatch')
    || message.includes('repair_runtime_snapshot_hash_mismatch')
    || message.includes('repair_runtime_snapshot_approval_hash_mismatch')
    || message.includes('stale_official_source_contract_regenerate_required')) return 'SAFETY_GATE'
  return 'UNCLASSIFIED'
}

function operatorAction(error: unknown): string {
  if (operatorMutationState === 'NOT_STARTED') {
    const classification = holdClass(error)
    if (classification === 'BENIGN_RECAPTURE') {
      return 'The database transaction did not start. The short-lived runtime snapshot expired. Verify writer restoration, then capture a new bounded snapshot; do not reuse the expired proof or retry automatically.'
    }
    if (classification === 'WAIT_FOR_UPDATER') {
      return 'The database transaction did not start. A source updater is running or its latest run is not publishable. Restore any held writers through the approved no-mutation path, wait for a terminal publishable updater state, and capture new evidence.'
    }
    if (classification === 'SOURCE_REVISED') {
      return 'The database transaction did not start. The official source changed from the sealed approval. Preserve both source proofs and obtain a new bounded approval; do not insert or overwrite any row.'
    }
    if (classification === 'PROVIDER_ENVELOPE_CHANGED') {
      return 'The database transaction did not start and Production data was not modified. The accepted OHLCV set may still match, but the provider envelope contains an unapproved rejected-row set or an unexpected partially populated row. Preserve both source proofs and obtain a new exact package approval. If writers are already held, restore them only through the approved no-mutation recovery path; do not weaken the rejection policy or retry automatically.'
    }
    if (classification === 'PRICE_CONFLICT' || classification === 'UNAPPROVED_DRIFT') {
      return 'The database transaction did not start. Production contains a price conflict or unapproved key drift. Preserve the runtime snapshot and investigate the sampled keys; do not widen the repair scope or overwrite rows.'
    }
    if (classification === 'BACKUP_TIMEOUT') {
      return 'The database transaction did not start. Backup creation or full verification exceeded its sealed operation or maintenance budget. Preserve the partial or unverified backup, journal, lock, and timing evidence; do not delete, reuse as rollback, or retry automatically. Restore held writers only through the exact hash-bound no-mutation recovery path, then obtain a fresh package and approval after the timeout cause is resolved.'
    }
    if (classification === 'WRITER_STATE_MISMATCH') {
      return 'No writer stop was attempted. The exact approved loaded, unloaded, or disabled service state did not match Production. Preserve the observed state and repair package; do not normalize services or widen the approved identity set before independent review.'
    }
    return 'The database transaction did not start. Do not retry automatically. Verify every writer service against writerServices and preserve all evidence. If writers were held, restore them only through the separately hash-approved no-mutation recovery path; then correct only the rejected preflight condition before obtaining fresh exact-hash approval.'
  }
  if (operatorMutationState === 'TRANSACTION_STATE_UNCERTAIN') {
    return 'Database state is uncertain. Do not retry, restore, or restart held services automatically. Preserve the journal, lock, service snapshot, database, backup, and generation evidence; run status:jp-ohlcv-production-repair and obtain operator-approved recovery.'
  }
  if (operatorMutationState === 'COMMIT_REPORTED') {
    return 'The child reported COMMITTED but outer verification did not complete. Treat the repair as committed-but-unverified. Do not retry or roll back automatically; preserve evidence and verify the archived journal, generations, read services, and all writer services.'
  }
  return 'The repair commit was verified, but post-commit service restoration or final orchestration failed. Do not rerun the data transaction. Preserve evidence and restore only services whose exact saved identity and health can be verified.'
}

main().catch(async (error) => {
  const writerServices = await observeWriterStates()
  let officialSourceEvidenceFile: null
    | { path: string; sha256: string; error?: never }
    | { path: null; sha256?: never; error: string } = null
  if (operatorConfig && operatorOfficialSourceEvidence && operatorMutationState === 'NOT_STARTED') {
    try {
      fs.mkdirSync(operatorConfig.stateDirectory, { recursive: true, mode: 0o700 })
      const evidencePath = path.join(
        operatorConfig.stateDirectory,
        `official-source-hold-${Date.now()}-${process.pid}.json`,
      )
      fs.writeFileSync(evidencePath, `${JSON.stringify(operatorOfficialSourceEvidence, null, 2)}\n`, {
        flag: 'wx',
        mode: 0o600,
      })
      officialSourceEvidenceFile = { path: evidencePath, sha256: sha256File(evidencePath) }
    } catch (evidenceError) {
      officialSourceEvidenceFile = {
        path: null,
        error: redactedError(evidenceError),
      }
    }
  }
  console.error(JSON.stringify({
    status: 'HOLD',
    automaticRetryAllowed: false,
    phase: operatorPhase,
    productionMutationState: operatorMutationState,
    error: redactedError(error),
    holdClass: holdClass(error),
    holdSubtype: backupTimeoutSubtype(error),
    writerMutationAttempted: error instanceof WriterPreflightError ? false : null,
    existingRowsEvidenceKind: operatorConfig?.existingEvidence.kind ?? null,
    intendedScope: operatorConfig ? {
      approvedRepairKeys: operatorConfig.repairScope.missingRows,
      approvedExistingRows: operatorConfig.repairScope.existingRows,
      approvedMatchingRows: operatorConfig.repairScope.matchingRows,
      approvedConflictRows: operatorConfig.repairScope.conflicts,
      preservedConflicts: operatorConfig.preservedConflictTickers,
      unresolvedConflictCount: operatorConfig.preservedConflictTickers.length,
      dayFullyRepaired: false,
    } : null,
    state: operatorConfig ? {
      repairLockPresent: fs.existsSync(path.join(operatorConfig.stateDirectory, 'repair.lock')),
      journalPresent: fs.existsSync(path.join(operatorConfig.stateDirectory, 'repair-journal.json')),
      readServiceSnapshotPresent: fs.existsSync(operatorConfig.serviceSnapshotPath),
    } : null,
    writerServices,
    writerRestoreEvidence: error instanceof WriterHoldError ? error.restoreEvidence : null,
    officialSourceEvidenceFile,
    readServiceWarning: 'If readServiceSnapshotPresent is true, Web/Analog may be held or may have failed post-restore health. Verify the exact saved state and health before any service action.',
    writerServiceWarning: 'Any writer with loaded=false that was loaded before maintenance remains intentionally held until the data state is certain. Do not bootstrap it without exact recovery approval.',
    operatorAction: operatorAction(error),
  }, null, 2))
  process.exitCode = 1
})
