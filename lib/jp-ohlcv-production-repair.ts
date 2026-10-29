import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { stableSha256, type JpOhlcvMissingOnlyRepairScope } from '@/lib/jp-ohlcv-data-quality'
import { DEFAULT_JP_OHLCV_REPAIR_LOCK } from '@/lib/jp-ohlcv-repair-barrier'

export type JpOhlcvRepairStage =
  | 'PREPARING'
  | 'PREPARED'
  | 'WRITER_LOCKED'
  | 'BACKUP_VERIFIED'
  | 'DATA_COMMITTING'
  | 'DATA_COMMITTED'
  | 'DATA_VERIFIED'
  | 'DERIVED_REBUILDING'
  | 'DERIVED_VERIFIED'
  | 'SERVING_VERIFIED'
  | 'COMMITTED'
  | 'ROLLBACK_STARTED'
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
  automaticRetryAllowed: false
  operatorAction: string
  evidence: Record<string, unknown>
  failure?: { name: string; message: string; originalStage: JpOhlcvRepairStage }
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

export function repairApprovalSha256(approval: JpOhlcvRepairApproval): string {
  return stableSha256(approval)
}

export function repairRollbackApprovalSha256(approval: JpOhlcvRepairRollbackApproval): string {
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
  for (const value of [approval.derivedPlanSha256, approval.officialSha256, approval.planSha256]) {
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
    if (!rollback.reason.trim()) throw new Error('repair_rollback_reason_required')
    const transaction = new JpOhlcvProductionRepairTransaction({
      approval: input.approval,
      approvalSha256: input.approvalSha256,
      paths: input.paths,
      transactionId: journal.transactionId,
    })
    transaction.journal = journal
    return transaction
  }

  currentStage(): JpOhlcvRepairStage | null { return this.journal?.stage ?? null }

  private assertLockOwnership(): void {
    const lock = JSON.parse(fs.readFileSync(this.paths.lock, 'utf8')) as { transactionId?: string }
    if (lock.transactionId !== this.transactionId) throw new Error('repair_lock_ownership_mismatch')
  }

  prepare(): void {
    fs.mkdirSync(this.paths.stateDirectory, { recursive: true, mode: 0o700 })
    if (fs.lstatSync(this.paths.stateDirectory).isSymbolicLink()) throw new Error('repair_state_directory_symlink_forbidden')
    assertNoIncompleteRepair(this.paths)
    const descriptor = fs.openSync(this.paths.lock, 'wx', 0o600)
    try {
      fs.writeFileSync(descriptor, `${JSON.stringify({ transactionId: this.transactionId, pid: process.pid, startedAt: new Date().toISOString() })}\n`)
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
        this.paths.journal,
        this.paths.lock,
      ],
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
    this.journal = {
      ...this.journal,
      stage: 'HOLD',
      updatedAt: new Date().toISOString(),
      failure: {
        name: error instanceof Error ? error.name : 'Error',
        message: error instanceof Error ? error.message : String(error),
        originalStage,
      },
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

  markCommitted(): void {
    if (!this.journal || this.journal.stage !== 'SERVING_VERIFIED') {
      throw new Error(`repair_commit_stage_invalid:${this.journal?.stage ?? 'missing'}`)
    }
    const archived = `${this.paths.journal}.committed-${this.transactionId}`
    if (exists(archived)) throw new Error(`repair_commit_archive_exists:${archived}`)
    this.assertLockOwnership()
    this.advance('SERVING_VERIFIED', 'COMMITTED', { completedAt: new Date().toISOString() })
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
    if (!this.journal || this.journal.stage !== 'ROLLBACK_STARTED') throw new Error('repair_rollback_stage_invalid')
    const archived = `${this.paths.journal}.rolled-back-${this.transactionId}`
    if (exists(archived)) throw new Error(`repair_rollback_archive_exists:${archived}`)
    this.assertLockOwnership()
    this.advance('ROLLBACK_STARTED', 'ROLLBACK_VERIFIED', evidence)
    this.advance('ROLLBACK_VERIFIED', 'ROLLED_BACK', { completedAt: new Date().toISOString() })
    fs.renameSync(this.paths.journal, archived)
    fs.unlinkSync(this.paths.lock)
    syncDirectory(this.paths.stateDirectory)
    return archived
  }
}
