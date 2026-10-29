import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn, type ChildProcess } from 'node:child_process'
import {
  assertJpOhlcvExecutionSourceIdentity,
  assertJpOhlcvProductionExecutionConfiguration,
  assertJpOhlcvProductionExecutionPackage,
  executionPackageSha256,
  sha256File,
  type JpOhlcvProductionExecutionConfiguration,
  type JpOhlcvProductionExecutionPackage,
} from '@/lib/jp-ohlcv-executable-plan'
import { runJpOhlcvMaintenanceOrchestrator } from '@/lib/jp-ohlcv-maintenance-orchestrator'
import {
  isProcessGroupAlive,
  terminateAndWaitForProcessGroup,
} from '@/lib/jp-ohlcv-repair-process-supervisor'
import {
  assertNoUnauthorizedDatabaseHandles,
  createLaunchdWriterHoldDriver,
} from '@/lib/storage/launchd-writer-hold-driver'
import type { WriterHoldDriver } from '@/lib/storage/weekly-writer-hold'

type OperatorPhase = 'PRE_FLIGHT' | 'WRITER_HOLD' | 'IN_TRANSACTION' | 'COMMIT_VERIFY' | 'POST_COMMIT'
type MutationState = 'NOT_STARTED' | 'TRANSACTION_STATE_UNCERTAIN' | 'COMMIT_REPORTED' | 'COMMIT_VERIFIED'

let operatorPhase: OperatorPhase = 'PRE_FLIGHT'
let operatorMutationState: MutationState = 'NOT_STARTED'
let operatorConfig: JpOhlcvProductionExecutionConfiguration | null = null
let operatorWriterDriver: WriterHoldDriver | null = null

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
  onSpawn: () => void,
): Promise<{
  status: 'COMMITTED'
  archivedJournal: string
  transactionId: string
}> {
  const command = bundle.runner
  assertJpOhlcvExecutionSourceIdentity(config)
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
        STOCKBOARD_JP_OHLCV_PRODUCTION_REPAIR_APPROVED:
          process.env.STOCKBOARD_JP_OHLCV_PRODUCTION_REPAIR_APPROVED!,
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
  const driver = createLaunchdWriterHoldDriver(config.writerServices.map((service) => ({
    label: service.label,
    plistPath: service.plistPath,
    definitionSha256: service.definitionSha256,
    program: service.program,
  })))
  operatorWriterDriver = driver
  operatorPhase = 'WRITER_HOLD'
  type CommittedEvidence = {
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
        timeoutMs: 30_000,
      })
    },
    runTransaction: async (assertWriterHoldValid) => {
      await assertWriterHoldValid()
      operatorPhase = 'IN_TRANSACTION'
      const committed = await runChild(bundle, config, () => {
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
      const dataVerification = journal.evidence?.DATA_VERIFIED as { missingRows?: unknown } | undefined
      const readServices = journal.evidence?.READ_SERVICES_RESUMED
      const insertedRows = Number(dataCommit?.insertedRows)
      const remainingMissingRows = Number(dataVerification?.missingRows)
      if (journal.stage !== 'COMMITTED'
        || insertedRows !== config.repairScope.missingRows
        || remainingMissingRows !== 0
        || !readServices) {
        throw new Error('repair_orchestrator_committed_evidence_mismatch')
      }
      committedEvidence.value = {
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
    status: 'COMMITTED',
    executionPackageSha256: packageSha256,
    repairedMissingRows: finalEvidence.insertedRows,
    remainingMissingRows: finalEvidence.remainingMissingRows,
    preservedConflicts: config.preservedConflictTickers,
    unresolvedConflictCount: config.preservedConflictTickers.length,
    dataQualityStatus: 'MISSING_ROWS_REPAIRED_EXISTING_CONFLICTS_HOLD',
    dayFullyRepaired: false,
    derivedDataNote: 'Derived serving data uses the inserted missing rows. 1447 and 2164 still differ from the official source and retain their pre-repair values.',
    transaction: result.result,
    readServices: finalEvidence.readServices,
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

function operatorAction(): string {
  if (operatorMutationState === 'NOT_STARTED') {
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
  console.error(JSON.stringify({
    status: 'HOLD',
    automaticRetryAllowed: false,
    phase: operatorPhase,
    productionMutationState: operatorMutationState,
    error: redactedError(error),
    intendedScope: {
      missingRows: operatorConfig?.repairScope.missingRows ?? 4067,
      preservedConflicts: operatorConfig?.preservedConflictTickers ?? ['1447', '2164'],
      unresolvedConflictCount: operatorConfig?.preservedConflictTickers.length ?? 2,
      dayFullyRepaired: false,
    },
    state: operatorConfig ? {
      repairLockPresent: fs.existsSync(path.join(operatorConfig.stateDirectory, 'repair.lock')),
      journalPresent: fs.existsSync(path.join(operatorConfig.stateDirectory, 'repair-journal.json')),
      readServiceSnapshotPresent: fs.existsSync(operatorConfig.serviceSnapshotPath),
    } : null,
    writerServices,
    readServiceWarning: 'If readServiceSnapshotPresent is true, Web/Analog may be held or may have failed post-restore health. Verify the exact saved state and health before any service action.',
    writerServiceWarning: 'Any writer with loaded=false that was loaded before maintenance remains intentionally held until the data state is certain. Do not bootstrap it without exact recovery approval.',
    operatorAction: operatorAction(),
  }, null, 2))
  process.exitCode = 1
})
