import fs from 'node:fs'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { stableSha256, type JpOhlcvMissingOnlyRepairScope } from '@/lib/jp-ohlcv-data-quality'
import { DEFAULT_JP_OHLCV_REPAIR_LOCK } from '@/lib/jp-ohlcv-repair-barrier'
import {
  readProcessIdentity,
  recordedProcessIdentityState,
  type RecordedProcessIdentity,
} from '@/lib/jp-ohlcv-repair-process-supervisor'

export type JpOhlcvRepairStage =
  | 'PREPARING'
  | 'PREPARED'
  | 'WRITER_LOCKED'
  | 'BACKUP_VERIFIED'
  | 'READ_SERVICES_HOLDING'
  | 'READ_SERVICES_HELD'
  | 'DATA_COMMITTING'
  | 'DATA_COMMITTED'
  | 'DATA_VERIFIED'
  | 'DERIVED_REBUILDING'
  | 'DERIVED_VERIFIED'
  | 'SERVING_VERIFIED'
  | 'READ_SERVICES_RESUMING'
  | 'READ_SERVICES_RESUMED'
  | 'COMMITTED'
  | 'ROLLBACK_STARTED'
  | 'ROLLBACK_READ_SERVICES_HOLDING'
  | 'ROLLBACK_READ_SERVICES_HELD'
  | 'ROLLBACK_DATA_RESTORED'
  | 'ROLLBACK_DERIVED_REBUILT'
  | 'ROLLBACK_SERVING_VERIFIED'
  | 'ROLLBACK_READ_SERVICES_RESUMING'
  | 'ROLLBACK_READ_SERVICES_RESUMED'
  | 'ROLLBACK_VERIFIED'
  | 'ROLLED_BACK'
  | 'HOLD'

export type JpOhlcvRepairApproval = {
  version: 1
  executionScope: 'PRODUCTION' | 'ISOLATED_FIXTURE'
  targetDate: string
  officialSha256: string
  planSha256: string
  missingRowsSha256: string
  preservedConflictsSha256: string
  expectedOfficialRows: number
  expectedExistingRows: number
  expectedMatchingRows: number
  expectedMissingRows: number
  approvedConflictTickers: string[]
  conflictDisposition: 'PRESERVE_EXISTING_HOLD'
  databaseRealpath: string
  databaseIdentitySha256: string
  stateDirectory: string
  backupDirectory: string
  sourceGenerationBefore: string
  sourceGenerationAfter: string
  servingGenerationBefore: string
  servingGenerationAfter: string
  derivedPlanSha256: string
}

export type JpOhlcvRepairJournal = {
  version: 1
  transactionId: string
  stage: JpOhlcvRepairStage
  createdAt: string
  updatedAt: string
  approvalSha256: string
  targetDate: string
  databaseRealpath: string
  backupDirectory: string
  sourceGeneration: { before: string; after: string }
  servingGeneration: { before: string; after: string }
  protectedPaths: string[]
  preservedConflicts: {
    tickers: string[]
    sha256: string
    disposition: 'PRESERVE_EXISTING_HOLD'
  }
  automaticRetryAllowed: false
  operatorAction: string
  evidence: Record<string, unknown>
  failure?: {
    name: string
    message: string
    originalStage: JpOhlcvRepairStage
    causes: Array<{ name: string; message: string }>
  }
  failureHistory?: Array<NonNullable<JpOhlcvRepairJournal['failure']>>
  activeStageProcess?: {
    pid: number
    processGroupId: number
    commandSha256: string
    processIdentitySha256: string
    startedAt: string
  }
}

export type JpOhlcvRepairStaleProcessRecovery = {
  pid: number
  processGroupId: number
  commandSha256: string
  processIdentitySha256: string
  confirmedStoppedAt: string
  reason: string
}

export type JpOhlcvRepairRunnerRecovery = {
  pid: number
  processGroupId: number
  processIdentitySha256: string
  observedState: 'PID_ABSENT' | 'PID_REUSED_OR_IDENTITY_MISMATCH'
  confirmedStoppedAt: string
  reason: string
}

export type JpOhlcvRepairRollbackApproval = {
  version: 1
  action: 'ROLLBACK'
  repairApprovalSha256: string
  journalSha256: string
  transactionId: string
  databaseRealpath: string
  backupDirectory: string
  backupRealpath: string
  backupSha256: string
  sourceGenerationTarget: string
  servingGenerationTarget: string
  reason: string
  originalRunnerRecovery: JpOhlcvRepairRunnerRecovery
  staleStageProcessRecovery?: JpOhlcvRepairStaleProcessRecovery
}

export type JpOhlcvRepairPrewriteCleanupApproval = {
  version: 1
  action: 'ARCHIVE_PREWRITE_HOLD'
  repairApprovalSha256: string
  journalSha256: string
  transactionId: string
  writerLockEvidence: {
    version: 1
    checkedAt: string
    expiresAt: string
    databaseRealpath: string
    databaseIdentitySha256: string
    repairTransactionId: string
    updateLockSnapshotPath: string
    updateLockSnapshotSha256: string
    processSnapshotPath: string
    processSnapshotSha256: string
  }
  writerLockEvidenceSha256: string
  reason: string
  originalRunnerRecovery: JpOhlcvRepairRunnerRecovery
  staleStageProcessRecovery?: JpOhlcvRepairStaleProcessRecovery
}

const REQUIRED_REPAIR_WRITER_JOB_TYPES = [
  'calendar_stage_backfill_jp',
  'calendar_stage_backfill_us',
  'db_maintenance',
  'earnings_refresh',
  'jp_ohlcv_gap_repair',
  'kabutan_material_news',
  'kabutan_themes',
  'large_holder_daily',
  'ml_freshness_guard',
  'ml_learning',
  'post_ohlcv_refresh',
  'sector_structure',
  'stage_transitions',
  'update_latest',
  'us_adjusted_foundation',
  'us_adjusted_source_snapshots',
  'us_update_latest',
] as const

export type JpOhlcvRepairResumeServicesApproval = {
  version: 1
  action: 'RESUME_READ_SERVICES'
  repairApprovalSha256: string
  journalSha256: string
  transactionId: string
  sourceGeneration: string
  servingGeneration: string
  reason: string
  originalRunnerRecovery: JpOhlcvRepairRunnerRecovery
  staleStageProcessRecovery?: JpOhlcvRepairStaleProcessRecovery
}

export type JpOhlcvRepairUpdateLockSnapshot = {
  version: 1
  checkedAt: string
  databaseRealpath: string
  databaseIdentitySha256: string
  repairTransactionId: string
  locks: Array<{
    jobType: string
    state: 'ABSENT' | 'EXPIRED'
    leaseExpiresAt: number | null
  }>
}

export type JpOhlcvRepairWriterProcessSnapshot = {
  version: 1
  checkedAt: string
  scanStatus: 'CLEAR'
  matchingWriterProcesses: []
}

export type JpOhlcvRepairPaths = {
  stateDirectory: string
  journal: string
  lock: string
}

function syncDirectory(directory: string): void {
  const descriptor = fs.openSync(directory, 'r')
  try { fs.fsyncSync(descriptor) } finally { fs.closeSync(descriptor) }
}

function atomicJson(file: string, value: unknown): void {
  const temporary = `${file}.tmp-${process.pid}-${randomUUID()}`
  const descriptor = fs.openSync(temporary, 'wx', 0o600)
  try {
    fs.writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`)
    fs.fsyncSync(descriptor)
  } finally {
    fs.closeSync(descriptor)
  }
  fs.renameSync(temporary, file)
  syncDirectory(path.dirname(file))
}

function exists(file: string): boolean {
  try { fs.lstatSync(file); return true } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

function sanitizeFailureText(value: unknown): string {
  return String(value)
    .replace(/\b(Bearer)\s+[^\s]+/gi, '$1 [REDACTED]')
    .replace(/\b([A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|AUTH)[A-Z0-9_]*)=([^\s]+)/gi, '$1=[REDACTED]')
    .replace(/[\r\n\t]+/g, ' ')
    .slice(0, 500)
}

function failureCauses(error: unknown): Array<{ name: string; message: string }> {
  const result: Array<{ name: string; message: string }> = []
  const visit = (value: unknown): void => {
    if (value instanceof AggregateError) {
      for (const nested of value.errors) visit(nested)
      if (value.cause) visit(value.cause)
      return
    }
    if (value instanceof Error) {
      result.push({ name: sanitizeFailureText(value.name), message: sanitizeFailureText(value.message) })
      if (value.cause) visit(value.cause)
      return
    }
    result.push({ name: 'Error', message: sanitizeFailureText(value) })
  }
  visit(error)
  return result
}

function holdOperatorAction(stage: JpOhlcvRepairStage): string {
  if (['PREPARING', 'PREPARED', 'WRITER_LOCKED', 'BACKUP_VERIFIED'].includes(stage)) {
    return 'No data mutation is recorded. Preserve the lock and journal, run the read-only status command, prove the writer lock absent or expired, and obtain an exact hash-bound ARCHIVE_PREWRITE_HOLD approval. A retry is a new transaction and approval.'
  }
  if (stage === 'READ_SERVICES_RESUMING') {
    return 'The new Source and Serving generations were verified, but Web/Analog resume is uncertain. Preserve all artifacts and run status. Choose either exact hash-bound RESUME_READ_SERVICES after revalidating the promoted generation, or exact hash-bound ROLLBACK; never retry automatically.'
  }
  return 'Data or serving state may be partial and Web/Analog may be held. Preserve the database, verified backup, journal, lock and both generations; run the read-only status command and obtain an exact hash-bound rollback approval.'
}

function assertStoppedStageProcessRecovery(input: {
  stageProcess: NonNullable<JpOhlcvRepairJournal['activeStageProcess']>
  recovery: JpOhlcvRepairStaleProcessRecovery | undefined
  errorPrefix: string
}): void {
  const recorded: RecordedProcessIdentity = {
    pid: input.stageProcess.pid,
    processGroupId: input.stageProcess.processGroupId,
    identitySha256: input.stageProcess.processIdentitySha256,
  }
  const processState = recordedProcessIdentityState(recorded)
  if (processState === 'MATCHING_PROCESS_ACTIVE'
    || processState === 'RECORDED_PROCESS_GROUP_ACTIVE_WITHOUT_LEADER') {
    throw new Error(`${input.errorPrefix}_stage_process_still_active:${recorded.pid}`)
  }
  const recovery = input.recovery
  const confirmedStoppedAt = recovery ? Date.parse(recovery.confirmedStoppedAt) : Number.NaN
  const recordedStartedAt = Date.parse(input.stageProcess.startedAt)
  if (!recovery
    || recovery.pid !== recorded.pid
    || recovery.processGroupId !== recorded.processGroupId
    || recovery.commandSha256 !== input.stageProcess.commandSha256
    || recovery.processIdentitySha256 !== recorded.identitySha256
    || !Number.isFinite(confirmedStoppedAt)
    || !Number.isFinite(recordedStartedAt)
    || confirmedStoppedAt < recordedStartedAt
    || confirmedStoppedAt > Date.now()
    || !recovery.reason.trim()) {
    throw new Error(`${input.errorPrefix}_stage_process_exact_recovery_approval_required:${recorded.pid}`)
  }
}

function assertOriginalTransactionOwnerStopped(
  paths: JpOhlcvRepairPaths,
  transactionId: string,
  recovery: JpOhlcvRepairRunnerRecovery,
): void {
  const lock = readStateJson<RepairLockRecord>(paths.lock)
  if (lock.transactionId !== transactionId
    || typeof lock.pid !== 'number'
    || typeof lock.processGroupId !== 'number'
    || typeof lock.processIdentitySha256 !== 'string') {
    throw new Error('repair_recovery_lock_owner_identity_invalid')
  }
  const current = readProcessIdentity(lock.pid)
  if (current
    && current.processGroupId === lock.processGroupId
    && current.identitySha256 === lock.processIdentitySha256) {
    throw new Error(`repair_recovery_original_runner_still_active:${lock.pid}`)
  }
  const observedState = current ? 'PID_REUSED_OR_IDENTITY_MISMATCH' : 'PID_ABSENT'
  const confirmedStoppedAt = Date.parse(recovery?.confirmedStoppedAt ?? '')
  const recordedStartedAt = Date.parse(typeof lock.startedAt === 'string' ? lock.startedAt : '')
  if (!recovery
    || recovery.pid !== lock.pid
    || recovery.processGroupId !== lock.processGroupId
    || recovery.processIdentitySha256 !== lock.processIdentitySha256
    || recovery.observedState !== observedState
    || !Number.isFinite(confirmedStoppedAt)
    || !Number.isFinite(recordedStartedAt)
    || confirmedStoppedAt < recordedStartedAt
    || confirmedStoppedAt > Date.now()
    || !recovery.reason.trim()) {
    throw new Error(`repair_recovery_original_runner_exact_approval_required:${lock.pid}:${observedState}`)
  }
}

export function repairApprovalSha256(approval: JpOhlcvRepairApproval): string {
  return stableSha256(approval)
}

export function repairRollbackApprovalSha256(approval: JpOhlcvRepairRollbackApproval): string {
  return stableSha256(approval)
}

export function repairPrewriteCleanupApprovalSha256(approval: JpOhlcvRepairPrewriteCleanupApproval): string {
  return stableSha256(approval)
}

export function repairResumeServicesApprovalSha256(approval: JpOhlcvRepairResumeServicesApproval): string {
  return stableSha256(approval)
}

export function assertRepairApproval(input: {
  approval: JpOhlcvRepairApproval
  expectedSha256: string
  scope: JpOhlcvMissingOnlyRepairScope
}): void {
  const { approval, scope } = input
  if (!/^[a-f0-9]{64}$/.test(input.expectedSha256)
    || repairApprovalSha256(approval) !== input.expectedSha256) throw new Error('repair_approval_hash_mismatch')
  if (approval.version !== 1 || scope.version !== 1 || scope.status !== 'READY') throw new Error('repair_scope_not_ready')
  if (!['PRODUCTION', 'ISOLATED_FIXTURE'].includes(approval.executionScope)) throw new Error('repair_execution_scope_invalid')
  const approvalLock = path.join(path.resolve(approval.stateDirectory), 'repair.lock')
  if (approval.executionScope === 'PRODUCTION' && approvalLock !== path.resolve(DEFAULT_JP_OHLCV_REPAIR_LOCK)) {
    throw new Error('repair_production_writer_barrier_path_mismatch')
  }
  if (approval.executionScope === 'ISOLATED_FIXTURE' && process.env.NODE_ENV !== 'test') {
    throw new Error('repair_isolated_fixture_scope_requires_test_environment')
  }
  if (approval.targetDate !== scope.date
    || approval.officialSha256 !== scope.officialSha256
    || approval.planSha256 !== scope.planSha256
    || approval.missingRowsSha256 !== scope.missingRowsSha256
    || approval.preservedConflictsSha256 !== scope.preservedConflictsSha256
    || approval.conflictDisposition !== scope.conflictDisposition) throw new Error('repair_approval_scope_mismatch')
  if (approval.expectedMissingRows !== scope.missingRows.length) throw new Error('repair_approval_missing_count_mismatch')
  if (scope.missingRowsSha256 !== stableSha256(scope.missingRows)
    || scope.preservedConflictsSha256 !== stableSha256(scope.preservedConflicts)) {
    throw new Error('repair_scope_content_hash_mismatch')
  }
  if (scope.missingRows.some((row) => row.date !== approval.targetDate)) {
    throw new Error('repair_scope_target_date_mismatch')
  }
  const actualConflicts = [...new Set(scope.preservedConflicts.map((row) => row.ticker))].sort()
  const approvedConflicts = [...new Set(approval.approvedConflictTickers)].sort()
  if (JSON.stringify(actualConflicts) !== JSON.stringify(approvedConflicts)) {
    throw new Error('repair_approval_conflict_set_mismatch')
  }
  if (scope.missingRows.some((row) => actualConflicts.includes(row.ticker))) {
    throw new Error('repair_scope_missing_conflict_overlap')
  }
  if (approval.expectedOfficialRows !== approval.expectedMatchingRows + approval.expectedMissingRows + scope.preservedConflicts.length
    || approval.expectedExistingRows !== approval.expectedMatchingRows + scope.preservedConflicts.length) {
    throw new Error('repair_approval_row_accounting_mismatch')
  }
  for (const value of [
    approval.databaseIdentitySha256,
    approval.derivedPlanSha256,
    approval.officialSha256,
    approval.planSha256,
  ]) {
    if (!/^[a-f0-9]{64}$/.test(value)) throw new Error('repair_approval_sha256_invalid')
  }
  for (const directory of [approval.stateDirectory, approval.backupDirectory]) {
    if (!path.isAbsolute(directory)) throw new Error('repair_approval_absolute_directory_required')
  }
  if (!path.isAbsolute(approval.databaseRealpath)) throw new Error('repair_approval_database_absolute_required')
  if (approval.sourceGenerationBefore === approval.sourceGenerationAfter
    || approval.servingGenerationBefore === approval.servingGenerationAfter) {
    throw new Error('repair_approval_generation_must_advance')
  }
}

export function assertNoIncompleteRepair(paths: JpOhlcvRepairPaths): void {
  if (exists(paths.lock)) throw new Error(`repair_lock_requires_manual_recovery:${paths.lock}`)
  if (exists(paths.journal)) throw new Error(`repair_journal_requires_manual_recovery:${paths.journal}`)
  if (!exists(paths.stateDirectory)) return
  const partial = fs.readdirSync(paths.stateDirectory).find((entry) => entry.startsWith(`${path.basename(paths.journal)}.tmp-`))
  if (partial) throw new Error(`repair_partial_journal_requires_manual_recovery:${path.join(paths.stateDirectory, partial)}`)
}

type RepairLockRecord = {
  transactionId?: unknown
  pid?: unknown
  processGroupId?: unknown
  processIdentitySha256?: unknown
  startedAt?: unknown
}

function readStateJson<T>(file: string): T {
  if (fs.lstatSync(file).isSymbolicLink()) throw new Error(`repair_state_symlink_forbidden:${file}`)
  return JSON.parse(fs.readFileSync(file, 'utf8')) as T
}

function readBoundEvidenceJson<T>(file: string, expectedSha256: string): T {
  if (!path.isAbsolute(file) || !/^[a-f0-9]{64}$/.test(expectedSha256)) {
    throw new Error('repair_evidence_snapshot_identity_invalid')
  }
  const metadata = fs.lstatSync(file)
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new Error(`repair_evidence_snapshot_file_invalid:${file}`)
  }
  const bytes = fs.readFileSync(file)
  if (createHash('sha256').update(bytes).digest('hex') !== expectedSha256) {
    throw new Error(`repair_evidence_snapshot_hash_mismatch:${file}`)
  }
  return JSON.parse(bytes.toString('utf8')) as T
}

function latestTerminalJournal(stateDirectory: string, journalName: string): {
  path: string
  journal: JpOhlcvRepairJournal | null
  parseFailure: string | null
} | null {
  if (!exists(stateDirectory)) return null
  const candidates = fs.readdirSync(stateDirectory)
    .filter((entry) => entry.startsWith(`${journalName}.committed-`)
      || entry.startsWith(`${journalName}.rolled-back-`)
      || entry.startsWith(`${journalName}.aborted-prewrite-`))
    .map((entry) => {
      const candidate = path.join(stateDirectory, entry)
      return { path: candidate, mtimeMs: fs.lstatSync(candidate).mtimeMs }
    })
    .sort((left, right) => right.mtimeMs - left.mtimeMs)
  if (!candidates[0]) return null
  try {
    return { path: candidates[0].path, journal: readStateJson<JpOhlcvRepairJournal>(candidates[0].path), parseFailure: null }
  } catch (error) {
    return {
      path: candidates[0].path,
      journal: null,
      parseFailure: sanitizeFailureText(error instanceof Error ? error.message : error),
    }
  }
}

export function inspectJpOhlcvProductionRepair(paths: JpOhlcvRepairPaths): Record<string, unknown> {
  if (exists(paths.stateDirectory) && fs.lstatSync(paths.stateDirectory).isSymbolicLink()) {
    throw new Error(`repair_state_directory_symlink_forbidden:${paths.stateDirectory}`)
  }
  const lockExists = exists(paths.lock)
  const journalExists = exists(paths.journal)
  const partialJournals = exists(paths.stateDirectory)
    ? fs.readdirSync(paths.stateDirectory).filter((entry) => entry.startsWith(`${path.basename(paths.journal)}.tmp-`)).sort()
    : []
  let lock: RepairLockRecord | null = null
  let journal: JpOhlcvRepairJournal | null = null
  let lockParseFailure: string | null = null
  let journalParseFailure: string | null = null
  if (lockExists) {
    try { lock = readStateJson<RepairLockRecord>(paths.lock) } catch (error) {
      lockParseFailure = sanitizeFailureText(error instanceof Error ? error.message : error)
    }
  }
  if (journalExists) {
    try { journal = readStateJson<JpOhlcvRepairJournal>(paths.journal) } catch (error) {
      journalParseFailure = sanitizeFailureText(error instanceof Error ? error.message : error)
    }
  }
  const transactionMatches = Boolean(lock?.transactionId && journal?.transactionId
    && lock.transactionId === journal.transactionId)
  const lockIdentity = typeof lock?.pid === 'number'
    && typeof lock.processGroupId === 'number'
    && typeof lock.processIdentitySha256 === 'string'
    ? (() => {
      const current = readProcessIdentity(lock.pid)
      if (!current) return 'PID_ABSENT' as const
      return current.processGroupId === lock.processGroupId
        && current.identitySha256 === lock.processIdentitySha256
        ? 'MATCHING_PROCESS_ACTIVE' as const
        : 'PID_REUSED_OR_IDENTITY_MISMATCH' as const
    })()
    : null
  const activeStageProcess = journal?.activeStageProcess ?? null
  const activeStageProcessState = activeStageProcess
    ? recordedProcessIdentityState({
      pid: activeStageProcess.pid,
      processGroupId: activeStageProcess.processGroupId,
      identitySha256: activeStageProcess.processIdentitySha256,
    })
    : null
  const reasons: string[] = []
  if (lockParseFailure) reasons.push(`LOCK_PARSE_FAILED:${lockParseFailure}`)
  if (journalParseFailure) reasons.push(`JOURNAL_PARSE_FAILED:${journalParseFailure}`)
  if (lockExists && !journalExists) reasons.push('LOCK_WITHOUT_JOURNAL')
  if (journalExists && !lockExists) reasons.push('JOURNAL_WITHOUT_LOCK')
  if (lock && journal && !transactionMatches) reasons.push('LOCK_JOURNAL_TRANSACTION_MISMATCH')
  if (lockExists && lock && lockIdentity === null) reasons.push('LOCK_OWNER_IDENTITY_MISSING_OR_INVALID')
  if (lockIdentity) reasons.push(`LOCK_OWNER_PROCESS:${lockIdentity}`)
  if (partialJournals.length > 0) reasons.push('PARTIAL_JOURNAL_FILES_PRESENT')
  const activeStageProcessStillRunning = activeStageProcessState === 'MATCHING_PROCESS_ACTIVE'
    || activeStageProcessState === 'RECORDED_PROCESS_GROUP_ACTIVE_WITHOUT_LEADER'
  if (activeStageProcessStillRunning) reasons.push(`RECORDED_STAGE_PROCESS_ACTIVE:${activeStageProcessState}`)
  if (activeStageProcessState && !activeStageProcessStillRunning) {
    reasons.push(`RECORDED_STAGE_PROCESS_STALE:${activeStageProcessState}`)
  }
  if (journal?.stage === 'HOLD') reasons.push(`TRANSACTION_HOLD:${journal.failure?.originalStage ?? 'UNKNOWN'}`)
  const lockOwnerUncertain = lockExists && (!lock || lockIdentity === null
    || lockIdentity === 'PID_REUSED_OR_IDENTITY_MISMATCH'
    || (lockIdentity === 'PID_ABSENT' && journal?.stage !== 'HOLD'))
  const status = !lockExists && !journalExists && partialJournals.length === 0
    ? 'CLEAR'
    : lockParseFailure || journalParseFailure || !lockExists || !journalExists || !transactionMatches
      || partialJournals.length > 0 || lockOwnerUncertain
      ? 'HOLD_UNCERTAIN'
      : activeStageProcessStillRunning
        ? 'HOLD_ACTIVE_STAGE_PROCESS'
        : activeStageProcess
          ? 'HOLD_STALE_STAGE_PROCESS_REQUIRES_EXACT_RECOVERY_APPROVAL'
          : journal?.stage === 'HOLD'
            ? 'HOLD'
            : 'ACTIVE_OR_INCOMPLETE'
  const terminal = latestTerminalJournal(paths.stateDirectory, path.basename(paths.journal))
  const backup = journal?.evidence.BACKUP_VERIFIED as { backupRealpath?: unknown; backupSha256?: unknown } | undefined
  const readServicesMayBeHeld = journal?.stage === 'HOLD' && journal.failure
    ? ['READ_SERVICES_HOLDING', 'READ_SERVICES_HELD', 'DATA_COMMITTING', 'DATA_COMMITTED', 'DATA_VERIFIED',
      'DERIVED_REBUILDING', 'DERIVED_VERIFIED', 'SERVING_VERIFIED', 'READ_SERVICES_RESUMING',
      'ROLLBACK_READ_SERVICES_HOLDING', 'ROLLBACK_READ_SERVICES_HELD', 'ROLLBACK_DATA_RESTORED',
      'ROLLBACK_DERIVED_REBUILT', 'ROLLBACK_SERVING_VERIFIED', 'ROLLBACK_READ_SERVICES_RESUMING']
      .includes(journal.failure.originalStage)
    : false
  const terminalConflicts = terminal?.journal?.preservedConflicts?.tickers ?? []
  const fallbackOperatorAction = status === 'CLEAR'
    ? 'No live repair transaction is present. Review lastTerminalTransaction before planning a new separately approved repair.'
    : 'Fail-Closed. Preserve the entire repair state directory and every approved Production database, DB-WAL, DB-SHM, backup, Source Generation and Serving Generation artifact. Do not delete locks or journals, do not restart the repair, and recover unreadable evidence from the approved bundle or immutable audit copy before choosing cleanup, resume, or rollback.'
  return {
    version: 2,
    checkedAt: new Date().toISOString(),
    status,
    transactionState: status,
    dataQualityStatus: terminalConflicts.length > 0
      ? 'PARTIAL_REPAIR_UNRESOLVED_CONFLICTS_HOLD'
      : 'NO_UNRESOLVED_CONFLICTS_RECORDED',
    reasons,
    fallbackOperatorAction,
    protectedResourcesFallback: {
      stateDirectory: paths.stateDirectory,
      journal: paths.journal,
      lock: paths.lock,
      productionData: 'Preserve the approved database plus its WAL/SHM and every backup/generation artifact; exact paths require the approved bundle when the journal is unreadable.',
    },
    stateDirectory: paths.stateDirectory,
    lock: lockExists ? {
      path: paths.lock,
      transactionId: lock?.transactionId ?? null,
      pid: lock?.pid ?? null,
      processGroupId: lock?.processGroupId ?? null,
      processIdentitySha256: lock?.processIdentitySha256 ?? null,
      processIdentityState: lockIdentity,
      startedAt: lock?.startedAt ?? null,
      parseFailure: lockParseFailure,
    } : null,
    journal: journalExists ? {
      path: paths.journal,
      sha256: journal ? stableSha256(journal) : null,
      transactionId: journal?.transactionId ?? null,
      stage: journal?.stage ?? null,
      updatedAt: journal?.updatedAt ?? null,
      approvalSha256: journal?.approvalSha256 ?? null,
      targetDate: journal?.targetDate ?? null,
      sourceGeneration: journal?.sourceGeneration ?? null,
      servingGeneration: journal?.servingGeneration ?? null,
      operatorAction: journal?.operatorAction ?? null,
      failure: journal?.failure ?? null,
      failureHistory: journal?.failureHistory ?? [],
      readServicesMayBeHeld,
      protectedResources: journal ? {
        database: journal.databaseRealpath,
        backupDirectory: journal.backupDirectory,
        verifiedBackup: typeof backup?.backupRealpath === 'string' ? backup.backupRealpath : null,
        verifiedBackupSha256: typeof backup?.backupSha256 === 'string' ? backup.backupSha256 : null,
        stateDirectory: paths.stateDirectory,
        journal: paths.journal,
        lock: paths.lock,
      } : null,
      preservedConflicts: journal?.preservedConflicts ?? null,
      parseFailure: journalParseFailure,
    } : null,
    transactionMatches,
    activeStageProcess,
    activeStageProcessState,
    partialJournals,
    lastTerminalTransaction: terminal ? {
      path: terminal.path,
      parseFailure: terminal.parseFailure,
      transactionId: terminal.journal?.transactionId ?? null,
      stage: terminal.journal?.stage ?? null,
      targetDate: terminal.journal?.targetDate ?? null,
      sourceGeneration: terminal.journal?.sourceGeneration ?? null,
      servingGeneration: terminal.journal?.servingGeneration ?? null,
      preservedConflicts: terminal.journal?.preservedConflicts ?? null,
      dayFullyRepaired: terminal.journal?.preservedConflicts
        ? terminal.journal.preservedConflicts.tickers.length === 0
        : null,
    } : null,
  }
}

export class JpOhlcvProductionRepairTransaction {
  readonly approval: JpOhlcvRepairApproval
  readonly approvalSha256: string
  readonly paths: JpOhlcvRepairPaths
  readonly transactionId: string
  private journal: JpOhlcvRepairJournal | null = null

  constructor(input: {
    approval: JpOhlcvRepairApproval
    approvalSha256: string
    paths: JpOhlcvRepairPaths
    transactionId?: string
  }) {
    this.approval = input.approval
    this.approvalSha256 = input.approvalSha256
    this.paths = input.paths
    this.transactionId = input.transactionId ?? `${Date.now()}-${process.pid}`
    if (path.resolve(this.paths.stateDirectory) !== path.resolve(this.approval.stateDirectory)
      || path.resolve(this.paths.journal) !== path.join(path.resolve(this.approval.stateDirectory), 'repair-journal.json')
      || path.resolve(this.paths.lock) !== path.join(path.resolve(this.approval.stateDirectory), 'repair.lock')) {
      throw new Error('repair_state_path_contract_mismatch')
    }
    if (this.approval.executionScope === 'PRODUCTION'
      && path.resolve(this.paths.lock) !== path.resolve(DEFAULT_JP_OHLCV_REPAIR_LOCK)) {
      throw new Error('repair_production_writer_barrier_path_mismatch')
    }
  }

  static resumeForRollback(input: {
    approval: JpOhlcvRepairApproval
    approvalSha256: string
    rollbackApproval: JpOhlcvRepairRollbackApproval
    rollbackApprovalSha256: string
    paths: JpOhlcvRepairPaths
  }): JpOhlcvProductionRepairTransaction {
    if (repairApprovalSha256(input.approval) !== input.approvalSha256) {
      throw new Error('repair_approval_hash_mismatch')
    }
    if (repairRollbackApprovalSha256(input.rollbackApproval) !== input.rollbackApprovalSha256) {
      throw new Error('repair_rollback_approval_hash_mismatch')
    }
    if (!exists(input.paths.lock) || !exists(input.paths.journal)) {
      throw new Error('repair_rollback_incomplete_state_required')
    }
    const journal = JSON.parse(fs.readFileSync(input.paths.journal, 'utf8')) as JpOhlcvRepairJournal
    const rollback = input.rollbackApproval
    if (rollback.version !== 1 || rollback.action !== 'ROLLBACK'
      || rollback.repairApprovalSha256 !== input.approvalSha256
      || rollback.journalSha256 !== stableSha256(journal)
      || rollback.transactionId !== journal.transactionId
      || rollback.databaseRealpath !== journal.databaseRealpath
      || rollback.backupDirectory !== journal.backupDirectory
      || rollback.sourceGenerationTarget !== journal.sourceGeneration.before
      || rollback.servingGenerationTarget !== journal.servingGeneration.before
      || journal.approvalSha256 !== input.approvalSha256) {
      throw new Error('repair_rollback_approval_state_mismatch')
    }
    const recordedBackup = journal.evidence.BACKUP_VERIFIED as { backupRealpath?: unknown; backupSha256?: unknown } | undefined
    if (rollback.backupRealpath !== recordedBackup?.backupRealpath
      || rollback.backupSha256 !== recordedBackup?.backupSha256
      || !/^[a-f0-9]{64}$/.test(rollback.backupSha256)) {
      throw new Error('repair_rollback_backup_identity_mismatch')
    }
    if (journal.stage === 'ROLLED_BACK' || journal.stage === 'ROLLBACK_VERIFIED') {
      throw new Error(`repair_rollback_terminal_stage:${journal.stage}`)
    }
    const staleStageProcess = journal.activeStageProcess
    if (staleStageProcess) {
      assertStoppedStageProcessRecovery({
        stageProcess: staleStageProcess,
        recovery: rollback.staleStageProcessRecovery,
        errorPrefix: 'repair_rollback',
      })
    }
    if (!rollback.reason.trim()) throw new Error('repair_rollback_reason_required')
    assertOriginalTransactionOwnerStopped(input.paths, journal.transactionId, rollback.originalRunnerRecovery)
    const transaction = new JpOhlcvProductionRepairTransaction({
      approval: input.approval,
      approvalSha256: input.approvalSha256,
      paths: input.paths,
      transactionId: journal.transactionId,
    })
    transaction.journal = journal
    if (staleStageProcess) transaction.acknowledgeStoppedStageProcess(rollback.staleStageProcessRecovery!)
    return transaction
  }

  static resumeForPrewriteCleanup(input: {
    approval: JpOhlcvRepairApproval
    approvalSha256: string
    cleanupApproval: JpOhlcvRepairPrewriteCleanupApproval
    cleanupApprovalSha256: string
    paths: JpOhlcvRepairPaths
  }): JpOhlcvProductionRepairTransaction {
    if (repairApprovalSha256(input.approval) !== input.approvalSha256) {
      throw new Error('repair_approval_hash_mismatch')
    }
    if (repairPrewriteCleanupApprovalSha256(input.cleanupApproval) !== input.cleanupApprovalSha256) {
      throw new Error('repair_prewrite_cleanup_approval_hash_mismatch')
    }
    if (!exists(input.paths.lock) || !exists(input.paths.journal)) {
      throw new Error('repair_prewrite_cleanup_incomplete_state_required')
    }
    const journal = JSON.parse(fs.readFileSync(input.paths.journal, 'utf8')) as JpOhlcvRepairJournal
    const cleanup = input.cleanupApproval
    const writerEvidence = cleanup.writerLockEvidence
    const writerCheckedAt = Date.parse(writerEvidence?.checkedAt ?? '')
    const writerExpiresAt = Date.parse(writerEvidence?.expiresAt ?? '')
    const allowedOriginalStages: JpOhlcvRepairStage[] = ['PREPARING', 'PREPARED', 'WRITER_LOCKED', 'BACKUP_VERIFIED']
    if (cleanup.version !== 1
      || cleanup.action !== 'ARCHIVE_PREWRITE_HOLD'
      || cleanup.repairApprovalSha256 !== input.approvalSha256
      || cleanup.journalSha256 !== stableSha256(journal)
      || cleanup.transactionId !== journal.transactionId
      || writerEvidence?.version !== 1
      || cleanup.writerLockEvidenceSha256 !== stableSha256(writerEvidence)
      || !/^[a-f0-9]{64}$/.test(cleanup.writerLockEvidenceSha256)
      || !Number.isFinite(writerCheckedAt)
      || !Number.isFinite(writerExpiresAt)
      || writerCheckedAt > Date.now() + 30_000
      || writerExpiresAt <= Date.now()
      || writerExpiresAt - writerCheckedAt > 15 * 60_000
      || writerEvidence.databaseRealpath !== input.approval.databaseRealpath
      || writerEvidence.databaseIdentitySha256 !== input.approval.databaseIdentitySha256
      || writerEvidence.repairTransactionId !== journal.transactionId
      || !path.isAbsolute(writerEvidence.updateLockSnapshotPath)
      || !/^[a-f0-9]{64}$/.test(writerEvidence.updateLockSnapshotSha256)
      || !path.isAbsolute(writerEvidence.processSnapshotPath)
      || !/^[a-f0-9]{64}$/.test(writerEvidence.processSnapshotSha256)
      || writerEvidence.updateLockSnapshotPath === writerEvidence.processSnapshotPath
      || !cleanup.reason.trim()
      || journal.stage !== 'HOLD'
      || !journal.failure
      || !allowedOriginalStages.includes(journal.failure.originalStage)
      || journal.approvalSha256 !== input.approvalSha256) {
      throw new Error('repair_prewrite_cleanup_approval_state_mismatch')
    }
    const updateLockSnapshot = readBoundEvidenceJson<JpOhlcvRepairUpdateLockSnapshot>(
      writerEvidence.updateLockSnapshotPath,
      writerEvidence.updateLockSnapshotSha256,
    )
    const processSnapshot = readBoundEvidenceJson<JpOhlcvRepairWriterProcessSnapshot>(
      writerEvidence.processSnapshotPath,
      writerEvidence.processSnapshotSha256,
    )
    const snapshotWriterJobTypes = Array.isArray(updateLockSnapshot.locks)
      ? [...new Set(updateLockSnapshot.locks.map((entry) => entry.jobType))].sort()
      : []
    if (updateLockSnapshot.version !== 1
      || updateLockSnapshot.checkedAt !== writerEvidence.checkedAt
      || updateLockSnapshot.databaseRealpath !== input.approval.databaseRealpath
      || updateLockSnapshot.databaseIdentitySha256 !== input.approval.databaseIdentitySha256
      || updateLockSnapshot.repairTransactionId !== journal.transactionId
      || JSON.stringify(snapshotWriterJobTypes) !== JSON.stringify(REQUIRED_REPAIR_WRITER_JOB_TYPES)
      || !Array.isArray(updateLockSnapshot.locks)
      || updateLockSnapshot.locks.length !== REQUIRED_REPAIR_WRITER_JOB_TYPES.length
      || updateLockSnapshot.locks.some((entry) => !['ABSENT', 'EXPIRED'].includes(entry.state)
        || (entry.state === 'ABSENT' && entry.leaseExpiresAt !== null)
        || (entry.state === 'EXPIRED' && (!Number.isFinite(entry.leaseExpiresAt)
          || Number(entry.leaseExpiresAt) * 1_000 > writerCheckedAt)))
      || processSnapshot.version !== 1
      || processSnapshot.checkedAt !== writerEvidence.checkedAt
      || processSnapshot.scanStatus !== 'CLEAR'
      || !Array.isArray(processSnapshot.matchingWriterProcesses)
      || processSnapshot.matchingWriterProcesses.length !== 0) {
      throw new Error('repair_prewrite_cleanup_writer_snapshot_content_mismatch')
    }
    if (journal.activeStageProcess) {
      assertStoppedStageProcessRecovery({
        stageProcess: journal.activeStageProcess,
        recovery: cleanup.staleStageProcessRecovery,
        errorPrefix: 'repair_prewrite_cleanup',
      })
    }
    assertOriginalTransactionOwnerStopped(input.paths, journal.transactionId, cleanup.originalRunnerRecovery)
    const transaction = new JpOhlcvProductionRepairTransaction({
      approval: input.approval,
      approvalSha256: input.approvalSha256,
      paths: input.paths,
      transactionId: journal.transactionId,
    })
    transaction.journal = journal
    if (journal.activeStageProcess) transaction.acknowledgeStoppedStageProcess(cleanup.staleStageProcessRecovery!)
    return transaction
  }

  static resumeForReadServices(input: {
    approval: JpOhlcvRepairApproval
    approvalSha256: string
    resumeApproval: JpOhlcvRepairResumeServicesApproval
    resumeApprovalSha256: string
    paths: JpOhlcvRepairPaths
  }): JpOhlcvProductionRepairTransaction {
    if (repairApprovalSha256(input.approval) !== input.approvalSha256) {
      throw new Error('repair_approval_hash_mismatch')
    }
    if (repairResumeServicesApprovalSha256(input.resumeApproval) !== input.resumeApprovalSha256) {
      throw new Error('repair_resume_services_approval_hash_mismatch')
    }
    if (!exists(input.paths.lock) || !exists(input.paths.journal)) {
      throw new Error('repair_resume_services_incomplete_state_required')
    }
    const journal = JSON.parse(fs.readFileSync(input.paths.journal, 'utf8')) as JpOhlcvRepairJournal
    const resume = input.resumeApproval
    const serving = journal.evidence.SERVING_VERIFIED as {
      sourceGeneration?: unknown
      servingGeneration?: unknown
      health?: unknown
    } | undefined
    if (resume.version !== 1
      || resume.action !== 'RESUME_READ_SERVICES'
      || resume.repairApprovalSha256 !== input.approvalSha256
      || resume.journalSha256 !== stableSha256(journal)
      || resume.transactionId !== journal.transactionId
      || resume.sourceGeneration !== journal.sourceGeneration.after
      || resume.servingGeneration !== journal.servingGeneration.after
      || !resume.reason.trim()
      || journal.stage !== 'HOLD'
      || journal.failure?.originalStage !== 'READ_SERVICES_RESUMING'
      || journal.approvalSha256 !== input.approvalSha256
      || serving?.sourceGeneration !== resume.sourceGeneration
      || serving?.servingGeneration !== resume.servingGeneration
      || serving?.health !== 'PASS') {
      throw new Error('repair_resume_services_approval_state_mismatch')
    }
    if (journal.activeStageProcess) {
      assertStoppedStageProcessRecovery({
        stageProcess: journal.activeStageProcess,
        recovery: resume.staleStageProcessRecovery,
        errorPrefix: 'repair_resume_services',
      })
    }
    assertOriginalTransactionOwnerStopped(input.paths, journal.transactionId, resume.originalRunnerRecovery)
    const transaction = new JpOhlcvProductionRepairTransaction({
      approval: input.approval,
      approvalSha256: input.approvalSha256,
      paths: input.paths,
      transactionId: journal.transactionId,
    })
    transaction.journal = journal
    if (journal.activeStageProcess) transaction.acknowledgeStoppedStageProcess(resume.staleStageProcessRecovery!)
    return transaction
  }

  currentStage(): JpOhlcvRepairStage | null { return this.journal?.stage ?? null }

  recordStageProcessStarted(input: {
    pid: number
    processGroupId: number
    commandSha256: string
    processIdentitySha256: string
  }): void {
    if (!this.journal) throw new Error('repair_stage_process_journal_missing')
    if (this.journal.activeStageProcess) throw new Error('repair_stage_process_already_recorded')
    this.assertLockOwnership()
    this.journal = {
      ...this.journal,
      updatedAt: new Date().toISOString(),
      activeStageProcess: { ...input, startedAt: new Date().toISOString() },
    }
    atomicJson(this.paths.journal, this.journal)
  }

  recordStageProcessStopped(input: {
    processGroupId: number
    outcome: string
  }): void {
    if (!this.journal?.activeStageProcess) throw new Error('repair_stage_process_record_missing')
    if (this.journal.activeStageProcess.processGroupId !== input.processGroupId) {
      throw new Error('repair_stage_process_record_mismatch')
    }
    this.assertLockOwnership()
    const stopped = {
      ...this.journal.activeStageProcess,
      stoppedAt: new Date().toISOString(),
      outcome: sanitizeFailureText(input.outcome),
    }
    const { activeStageProcess: _activeStageProcess, ...withoutActive } = this.journal
    this.journal = {
      ...withoutActive,
      updatedAt: new Date().toISOString(),
      evidence: { ...this.journal.evidence, LAST_STAGE_PROCESS: stopped },
    }
    atomicJson(this.paths.journal, this.journal)
  }

  private acknowledgeStoppedStageProcess(recovery: JpOhlcvRepairStaleProcessRecovery): void {
    if (!this.journal?.activeStageProcess) throw new Error('repair_stage_process_recovery_record_missing')
    assertStoppedStageProcessRecovery({
      stageProcess: this.journal.activeStageProcess,
      recovery,
      errorPrefix: 'repair',
    })
    this.assertLockOwnership()
    const recovered = {
      ...this.journal.activeStageProcess,
      confirmedStoppedAt: recovery.confirmedStoppedAt,
      reason: sanitizeFailureText(recovery.reason),
    }
    const { activeStageProcess: _activeStageProcess, ...withoutActive } = this.journal
    this.journal = {
      ...withoutActive,
      updatedAt: new Date().toISOString(),
      evidence: { ...this.journal.evidence, STALE_STAGE_PROCESS_RECOVERY: recovered },
    }
    atomicJson(this.paths.journal, this.journal)
  }

  private assertLockOwnership(): void {
    const lock = JSON.parse(fs.readFileSync(this.paths.lock, 'utf8')) as { transactionId?: string }
    if (lock.transactionId !== this.transactionId) throw new Error('repair_lock_ownership_mismatch')
  }

  prepare(): void {
    fs.mkdirSync(this.paths.stateDirectory, { recursive: true, mode: 0o700 })
    if (fs.lstatSync(this.paths.stateDirectory).isSymbolicLink()) throw new Error('repair_state_directory_symlink_forbidden')
    assertNoIncompleteRepair(this.paths)
    const ownerIdentity = readProcessIdentity(process.pid)
    if (!ownerIdentity) throw new Error('repair_owner_process_identity_unavailable')
    const descriptor = fs.openSync(this.paths.lock, 'wx', 0o600)
    try {
      fs.writeFileSync(descriptor, `${JSON.stringify({
        transactionId: this.transactionId,
        pid: process.pid,
        processGroupId: ownerIdentity.processGroupId,
        processIdentitySha256: ownerIdentity.identitySha256,
        startedAt: new Date().toISOString(),
      })}\n`)
      fs.fsyncSync(descriptor)
    } finally {
      fs.closeSync(descriptor)
    }
    syncDirectory(this.paths.stateDirectory)
    const now = new Date().toISOString()
    this.journal = {
      version: 1,
      transactionId: this.transactionId,
      stage: 'PREPARING',
      createdAt: now,
      updatedAt: now,
      approvalSha256: this.approvalSha256,
      targetDate: this.approval.targetDate,
      databaseRealpath: this.approval.databaseRealpath,
      backupDirectory: this.approval.backupDirectory,
      sourceGeneration: { before: this.approval.sourceGenerationBefore, after: this.approval.sourceGenerationAfter },
      servingGeneration: { before: this.approval.servingGenerationBefore, after: this.approval.servingGenerationAfter },
      protectedPaths: [
        this.approval.databaseRealpath,
        this.approval.backupDirectory,
        this.paths.stateDirectory,
        this.paths.journal,
        this.paths.lock,
      ],
      preservedConflicts: {
        tickers: [...this.approval.approvedConflictTickers].sort(),
        sha256: this.approval.preservedConflictsSha256,
        disposition: this.approval.conflictDisposition,
      },
      automaticRetryAllowed: false,
      operatorAction: 'Preserve the database, backup, journal and generations. Inspect the recorded stage before resume, rollback or cleanup.',
      evidence: {},
    }
    atomicJson(this.paths.journal, this.journal)
    this.advance('PREPARING', 'PREPARED', { approvalSha256: this.approvalSha256 })
  }

  advance(expected: JpOhlcvRepairStage, next: JpOhlcvRepairStage, evidence: Record<string, unknown>): void {
    if (!this.journal || this.journal.stage !== expected) {
      throw new Error(`repair_stage_mismatch:${expected}:${this.journal?.stage ?? 'missing'}`)
    }
    const onDisk = JSON.parse(fs.readFileSync(this.paths.journal, 'utf8')) as JpOhlcvRepairJournal
    if (JSON.stringify(onDisk) !== JSON.stringify(this.journal)) throw new Error('repair_journal_ownership_mismatch')
    this.journal = {
      ...this.journal,
      stage: next,
      updatedAt: new Date().toISOString(),
      evidence: { ...this.journal.evidence, [next]: evidence },
    }
    atomicJson(this.paths.journal, this.journal)
  }

  hold(error: unknown): never {
    if (!this.journal) throw error
    const originalStage = this.journal.stage
    const previousFailure = this.journal.failure
    this.journal = {
      ...this.journal,
      stage: 'HOLD',
      updatedAt: new Date().toISOString(),
      operatorAction: holdOperatorAction(originalStage),
      failure: {
        name: sanitizeFailureText(error instanceof Error ? error.name : 'Error'),
        message: sanitizeFailureText(error instanceof Error ? error.message : error),
        originalStage,
        causes: failureCauses(error),
      },
      failureHistory: previousFailure
        ? [...(this.journal.failureHistory ?? []), previousFailure]
        : this.journal.failureHistory,
    }
    atomicJson(this.paths.journal, this.journal)
    throw error
  }

  beginRollback(evidence: Record<string, unknown>): void {
    if (!this.journal) throw new Error('repair_rollback_journal_missing')
    const current = this.journal.stage
    if (current === 'ROLLBACK_STARTED' || current === 'ROLLBACK_VERIFIED' || current === 'ROLLED_BACK' || current === 'COMMITTED') {
      throw new Error(`repair_rollback_stage_invalid:${current}`)
    }
    this.advance(current, 'ROLLBACK_STARTED', {
      ...evidence,
      previousFailure: this.journal.failure ?? null,
    })
  }

  beginReadServicesRecovery(evidence: Record<string, unknown>): void {
    if (!this.journal || this.journal.stage !== 'HOLD'
      || this.journal.failure?.originalStage !== 'READ_SERVICES_RESUMING') {
      throw new Error(`repair_resume_services_stage_invalid:${this.journal?.stage ?? 'missing'}`)
    }
    this.advance('HOLD', 'SERVING_VERIFIED', {
      ...evidence,
      recoveryOfFailure: this.journal.failure,
    })
  }

  archivePrewriteHold(input: {
    cleanupApprovalSha256: string
    writerLockEvidence: JpOhlcvRepairPrewriteCleanupApproval['writerLockEvidence']
    writerLockEvidenceSha256: string
    originalRunnerRecovery: JpOhlcvRepairRunnerRecovery
    reason: string
  }): string {
    if (!this.journal || this.journal.stage !== 'HOLD' || !this.journal.failure
      || !['PREPARING', 'PREPARED', 'WRITER_LOCKED', 'BACKUP_VERIFIED'].includes(this.journal.failure.originalStage)) {
      throw new Error(`repair_prewrite_cleanup_stage_invalid:${this.journal?.stage ?? 'missing'}`)
    }
    const archived = `${this.paths.journal}.aborted-prewrite-${this.transactionId}`
    if (exists(archived)) throw new Error(`repair_prewrite_cleanup_archive_exists:${archived}`)
    this.assertLockOwnership()
    this.journal = {
      ...this.journal,
      updatedAt: new Date().toISOString(),
      operatorAction: 'Pre-write HOLD was archived under exact approval. Production data and serving generations were not changed; a new repair requires a new approval and transaction.',
      evidence: {
        ...this.journal.evidence,
        PREWRITE_CLEANUP: {
          cleanupApprovalSha256: input.cleanupApprovalSha256,
          writerLockEvidence: input.writerLockEvidence,
          writerLockEvidenceSha256: input.writerLockEvidenceSha256,
          originalRunnerRecovery: input.originalRunnerRecovery,
          reason: sanitizeFailureText(input.reason),
          completedAt: new Date().toISOString(),
          productionDataMutation: false,
        },
      },
    }
    atomicJson(this.paths.journal, this.journal)
    fs.renameSync(this.paths.journal, archived)
    fs.unlinkSync(this.paths.lock)
    syncDirectory(this.paths.stateDirectory)
    return archived
  }

  markCommitted(): void {
    if (!this.journal || this.journal.stage !== 'READ_SERVICES_RESUMED') {
      throw new Error(`repair_commit_stage_invalid:${this.journal?.stage ?? 'missing'}`)
    }
    const archived = `${this.paths.journal}.committed-${this.transactionId}`
    if (exists(archived)) throw new Error(`repair_commit_archive_exists:${archived}`)
    this.assertLockOwnership()
    this.advance('READ_SERVICES_RESUMED', 'COMMITTED', { completedAt: new Date().toISOString() })
  }

  finalizeCommit(): string {
    if (!this.journal || this.journal.stage !== 'COMMITTED') {
      throw new Error(`repair_finalize_commit_stage_invalid:${this.journal?.stage ?? 'missing'}`)
    }
    const archived = `${this.paths.journal}.committed-${this.transactionId}`
    if (exists(archived)) throw new Error(`repair_commit_archive_exists:${archived}`)
    this.assertLockOwnership()
    fs.renameSync(this.paths.journal, archived)
    fs.unlinkSync(this.paths.lock)
    syncDirectory(this.paths.stateDirectory)
    return archived
  }

  markRollbackVerified(evidence: Record<string, unknown>): string {
    if (!this.journal || this.journal.stage !== 'ROLLBACK_READ_SERVICES_RESUMED') {
      throw new Error('repair_rollback_stage_invalid')
    }
    const archived = `${this.paths.journal}.rolled-back-${this.transactionId}`
    if (exists(archived)) throw new Error(`repair_rollback_archive_exists:${archived}`)
    this.assertLockOwnership()
    this.advance('ROLLBACK_READ_SERVICES_RESUMED', 'ROLLBACK_VERIFIED', evidence)
    this.advance('ROLLBACK_VERIFIED', 'ROLLED_BACK', { completedAt: new Date().toISOString() })
    fs.renameSync(this.paths.journal, archived)
    fs.unlinkSync(this.paths.lock)
    syncDirectory(this.paths.stateDirectory)
    return archived
  }
}
