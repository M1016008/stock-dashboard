import fs from 'node:fs'
import path from 'node:path'

export type ReleaseTransactionStage =
  | 'PREPARING'
  | 'PREPARED'
  | 'TARGETS_FROZEN'
  | 'PREVIOUS_RETIRED'
  | 'LIVE_MOVED'
  | 'ARTIFACT_ACTIVE'
  | 'RUNTIME_MOVED'
  | 'GENERATION_ACTIVE'
  | 'SERVICES_RESTARTED'
  | 'VERIFIED'
  | 'ROLLBACK_STARTED'
  | 'ROLLED_BACK'
  | 'ROLLBACK_FAILED'
  | 'COMMITTED'

export interface ReleaseTransactionJournal {
  version: 1
  transactionId: string
  createdAt: string
  updatedAt: string
  stage: ReleaseTransactionStage
  candidate: { buildId: string; artifactTreeSha256: string; runtimeIdentitySha256: string }
  rollback: {
    buildId: string
    artifactTreeSha256: string
    runtimeIdentitySha256: string
    runtimeNodeModulesTarget: string
  }
  paths: ReleaseTransactionPaths
  recovery: {
    automaticRetryAllowed: false
    protectedPaths: string[]
    reason: string
  }
  error?: string
}

export interface ReleaseTransactionPaths {
  releaseRoot: string
  artifact: string
  candidateRuntimeNodeModules: string
  live: string
  previous: string
  stage: string
  nodeModules: string
  runtimePrevious: string
  runtimeStage: string
  journal: string
  lock: string
}

export interface ReleaseTransactionIdentity {
  candidateBuildId: string
  candidateArtifactTreeSha256: string
  candidateRuntimeIdentitySha256: string
  rollbackBuildId: string
  rollbackArtifactTreeSha256: string
  rollbackRuntimeIdentitySha256: string
  rollbackRuntimeNodeModulesTarget: string
}

export interface ReleaseTransactionOptions {
  paths: ReleaseTransactionPaths
  identity: ReleaseTransactionIdentity
  failpoint?: (stage: ReleaseTransactionStage) => void
  transactionId?: string
}

function syncDirectory(directory: string): void {
  const descriptor = fs.openSync(directory, 'r')
  try { fs.fsyncSync(descriptor) } finally { fs.closeSync(descriptor) }
}

function atomicJson(file: string, value: unknown): void {
  const temporary = `${file}.tmp-${process.pid}`
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

function renameAndSync(source: string, destination: string): void {
  fs.renameSync(source, destination)
  syncDirectory(path.dirname(destination))
}

function exists(target: string): boolean {
  try { fs.lstatSync(target); return true } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

function removeIfExists(target: string): void {
  if (!exists(target)) return
  const stat = fs.lstatSync(target)
  if (stat.isDirectory() && !stat.isSymbolicLink()) fs.rmSync(target, { recursive: true })
  else fs.unlinkSync(target)
}

function readBuildId(root: string): string | null {
  const file = path.join(root, 'BUILD_ID')
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim() : null
}

function symlinkTarget(link: string): string | null {
  if (!exists(link) || !fs.lstatSync(link).isSymbolicLink()) return null
  return path.resolve(path.dirname(link), fs.readlinkSync(link))
}

export function assertNoUncertainReleaseTransaction(paths: Pick<ReleaseTransactionPaths, 'journal' | 'lock'>): void {
  if (exists(paths.journal)) throw new Error(`release_transaction_journal_requires_manual_recovery:${paths.journal}`)
  if (exists(paths.lock)) throw new Error(`release_transaction_lock_requires_manual_recovery:${paths.lock}`)
  const temporaryPrefix = `${path.basename(paths.journal)}.tmp-`
  const temporary = fs.readdirSync(path.dirname(paths.journal)).find((entry) => entry.startsWith(temporaryPrefix))
  if (temporary) throw new Error(`release_transaction_partial_journal_requires_manual_recovery:${path.join(path.dirname(paths.journal), temporary)}`)
}

export class WebAnalogReleaseTransaction {
  readonly paths: ReleaseTransactionPaths
  readonly identity: ReleaseTransactionIdentity
  readonly transactionId: string
  private readonly failpoint?: (stage: ReleaseTransactionStage) => void
  private journal: ReleaseTransactionJournal | null = null

  constructor(options: ReleaseTransactionOptions) {
    this.paths = options.paths
    this.identity = options.identity
    this.failpoint = options.failpoint
    this.transactionId = options.transactionId ?? `${Date.now()}-${process.pid}`
  }

  static loadForExplicitRecovery(journalFile: string): WebAnalogReleaseTransaction {
    const parsed = JSON.parse(fs.readFileSync(journalFile, 'utf8')) as ReleaseTransactionJournal
    if (parsed.version !== 1 || parsed.paths.journal !== journalFile || parsed.recovery?.automaticRetryAllowed !== false) {
      throw new Error('release_transaction_journal_invalid')
    }
    if (parsed.stage === 'COMMITTED') throw new Error('release_transaction_committed_journal_requires_finalize')
    const transaction = new WebAnalogReleaseTransaction({
      paths: parsed.paths,
      transactionId: parsed.transactionId,
      identity: {
        candidateBuildId: parsed.candidate.buildId,
        candidateArtifactTreeSha256: parsed.candidate.artifactTreeSha256,
        candidateRuntimeIdentitySha256: parsed.candidate.runtimeIdentitySha256,
        rollbackBuildId: parsed.rollback.buildId,
        rollbackArtifactTreeSha256: parsed.rollback.artifactTreeSha256,
        rollbackRuntimeIdentitySha256: parsed.rollback.runtimeIdentitySha256,
        rollbackRuntimeNodeModulesTarget: parsed.rollback.runtimeNodeModulesTarget,
      },
    })
    transaction.journal = parsed
    return transaction
  }

  currentStage(): ReleaseTransactionStage | null { return this.journal?.stage ?? null }

  ownsMutableState(): boolean { return this.journal !== null }

  assertOwnedState(expectedStage: ReleaseTransactionStage): void {
    if (!this.journal || this.journal.stage !== expectedStage) {
      throw new Error(`release_transaction_owned_stage_mismatch:${expectedStage}:${this.journal?.stage ?? 'missing'}`)
    }
    const diskJournal = JSON.parse(fs.readFileSync(this.paths.journal, 'utf8')) as ReleaseTransactionJournal
    if (JSON.stringify(diskJournal) !== JSON.stringify(this.journal)) {
      throw new Error('release_transaction_owned_journal_mismatch')
    }
    const lock = JSON.parse(fs.readFileSync(this.paths.lock, 'utf8')) as {
      transactionId?: unknown
      pid?: unknown
      startedAt?: unknown
    }
    if (lock.transactionId !== this.transactionId || lock.pid !== process.pid
      || typeof lock.startedAt !== 'string' || !Number.isFinite(Date.parse(lock.startedAt))) {
      throw new Error('release_transaction_owned_lock_mismatch')
    }
  }

  generationMayHaveChanged(): boolean {
    const stage = this.currentStage()
    return stage !== null && !['PREPARING', 'PREPARED', 'COMMITTED'].includes(stage)
  }

  recoverySummary(): Pick<ReleaseTransactionJournal, 'transactionId' | 'stage' | 'candidate' | 'rollback' | 'recovery'> | null {
    if (!this.journal) return null
    const { transactionId, stage, candidate, rollback, recovery } = this.journal
    return { transactionId, stage, candidate, rollback, recovery }
  }

  private retiredArtifact(): string { return `${this.paths.previous}.retired-${this.transactionId}` }
  private retiredRuntime(): string { return `${this.paths.runtimePrevious}.retired-${this.transactionId}` }
  private failedArtifact(): string { return `${this.paths.live}.failed-${this.transactionId}` }
  private failedRuntime(): string { return `${this.paths.nodeModules}.failed-${this.transactionId}` }

  private update(stage: ReleaseTransactionStage, error?: unknown): void {
    if (!this.journal) throw new Error('release_transaction_not_initialized')
    this.journal = {
      ...this.journal,
      stage,
      updatedAt: new Date().toISOString(),
      ...(error === undefined ? {} : { error: error instanceof Error ? `${error.name}: ${error.message}` : String(error) }),
    }
    atomicJson(this.paths.journal, this.journal)
    this.failpoint?.(stage)
  }

  prepare(): void {
    assertNoUncertainReleaseTransaction(this.paths)
    for (const target of [this.paths.stage, this.paths.runtimeStage, this.retiredArtifact(), this.retiredRuntime(), this.failedArtifact(), this.failedRuntime()]) {
      if (exists(target)) throw new Error(`release_transaction_path_not_clear:${target}`)
    }
    const lockDescriptor = fs.openSync(this.paths.lock, 'wx', 0o600)
    try {
      fs.writeFileSync(lockDescriptor, `${JSON.stringify({ transactionId: this.transactionId, pid: process.pid, startedAt: new Date().toISOString() })}\n`)
      fs.fsyncSync(lockDescriptor)
    } finally {
      fs.closeSync(lockDescriptor)
    }
    syncDirectory(path.dirname(this.paths.lock))
    const now = new Date().toISOString()
    this.journal = {
      version: 1,
      transactionId: this.transactionId,
      createdAt: now,
      updatedAt: now,
      stage: 'PREPARING',
      candidate: {
        buildId: this.identity.candidateBuildId,
        artifactTreeSha256: this.identity.candidateArtifactTreeSha256,
        runtimeIdentitySha256: this.identity.candidateRuntimeIdentitySha256,
      },
      rollback: {
        buildId: this.identity.rollbackBuildId,
        artifactTreeSha256: this.identity.rollbackArtifactTreeSha256,
        runtimeIdentitySha256: this.identity.rollbackRuntimeIdentitySha256,
        runtimeNodeModulesTarget: this.identity.rollbackRuntimeNodeModulesTarget,
      },
      paths: this.paths,
      recovery: {
        automaticRetryAllowed: false,
        protectedPaths: [
          this.paths.live, this.paths.previous, this.paths.stage,
          this.paths.nodeModules, this.paths.runtimePrevious, this.paths.runtimeStage,
          this.paths.journal,
        ],
        reason: 'Inspect journal stage and generation identities before any restore, republish, cleanup, or retry.',
      },
    }
    atomicJson(this.paths.journal, this.journal)
    this.failpoint?.('PREPARING')
    fs.cpSync(this.paths.artifact, this.paths.stage, { recursive: true, errorOnExist: true, force: false })
    fs.symlinkSync(this.paths.candidateRuntimeNodeModules, this.paths.runtimeStage)
    if (readBuildId(this.paths.stage) !== this.identity.candidateBuildId) throw new Error('release_transaction_staged_build_mismatch')
    if (symlinkTarget(this.paths.runtimeStage) !== path.resolve(this.paths.candidateRuntimeNodeModules)) {
      throw new Error('release_transaction_staged_runtime_mismatch')
    }
    this.update('PREPARED')
  }

  markTargetsFrozen(): void { this.update('TARGETS_FROZEN') }

  activate(): void {
    if (!this.journal || this.journal.stage !== 'TARGETS_FROZEN') throw new Error('release_transaction_targets_not_frozen')
    if (exists(this.paths.previous)) renameAndSync(this.paths.previous, this.retiredArtifact())
    if (exists(this.paths.runtimePrevious)) renameAndSync(this.paths.runtimePrevious, this.retiredRuntime())
    this.update('PREVIOUS_RETIRED')
    renameAndSync(this.paths.live, this.paths.previous)
    this.update('LIVE_MOVED')
    renameAndSync(this.paths.stage, this.paths.live)
    this.update('ARTIFACT_ACTIVE')
    renameAndSync(this.paths.nodeModules, this.paths.runtimePrevious)
    this.update('RUNTIME_MOVED')
    renameAndSync(this.paths.runtimeStage, this.paths.nodeModules)
    this.update('GENERATION_ACTIVE')
    if (readBuildId(this.paths.live) !== this.identity.candidateBuildId
      || symlinkTarget(this.paths.nodeModules) !== path.resolve(this.paths.candidateRuntimeNodeModules)) {
      throw new Error('release_transaction_active_generation_mismatch')
    }
  }

  markServicesRestarted(): void { this.update('SERVICES_RESTARTED') }

  hasMutableState(): boolean { return this.ownsMutableState() }

  rollback(verifyRestored?: () => void): boolean {
    if (this.journal?.stage === 'COMMITTED') {
      throw new Error('release_transaction_committed_journal_requires_finalize')
    }
    const generationChanged = readBuildId(this.paths.live) === this.identity.candidateBuildId
      || symlinkTarget(this.paths.nodeModules) === path.resolve(this.paths.candidateRuntimeNodeModules)
      || !exists(this.paths.live) || !exists(this.paths.nodeModules)
    try {
      if (this.journal) this.update('ROLLBACK_STARTED')
      if (symlinkTarget(this.paths.nodeModules) === path.resolve(this.paths.candidateRuntimeNodeModules)) {
        renameAndSync(this.paths.nodeModules, this.failedRuntime())
      }
      if (!exists(this.paths.nodeModules) && exists(this.paths.runtimePrevious)) renameAndSync(this.paths.runtimePrevious, this.paths.nodeModules)
      if (readBuildId(this.paths.live) === this.identity.candidateBuildId) renameAndSync(this.paths.live, this.failedArtifact())
      if (!exists(this.paths.live) && exists(this.paths.previous)) renameAndSync(this.paths.previous, this.paths.live)
      if (!exists(this.paths.previous) && exists(this.retiredArtifact())) renameAndSync(this.retiredArtifact(), this.paths.previous)
      if (!exists(this.paths.runtimePrevious) && exists(this.retiredRuntime())) renameAndSync(this.retiredRuntime(), this.paths.runtimePrevious)
      removeIfExists(this.paths.stage)
      removeIfExists(this.paths.runtimeStage)
      if (readBuildId(this.paths.live) !== this.identity.rollbackBuildId) throw new Error('release_transaction_rollback_build_mismatch')
      if (symlinkTarget(this.paths.nodeModules) !== path.resolve(this.identity.rollbackRuntimeNodeModulesTarget)) {
        throw new Error('release_transaction_rollback_runtime_mismatch')
      }
      verifyRestored?.()
      if (this.journal) {
        this.update('ROLLED_BACK')
        const archived = `${this.paths.journal}.rolled-back-${this.transactionId}`
        renameAndSync(this.paths.journal, archived)
      }
      removeIfExists(this.paths.lock)
      syncDirectory(this.paths.releaseRoot)
      syncDirectory(path.dirname(this.paths.lock))
      return generationChanged
    } catch (error) {
      if (this.journal) {
        try { this.update('ROLLBACK_FAILED', error) } catch { /* preserve the earlier journal if reporting fails */ }
      }
      throw error
    }
  }

  commit(): void {
    this.update('VERIFIED')
    if (readBuildId(this.paths.live) !== this.identity.candidateBuildId
      || symlinkTarget(this.paths.nodeModules) !== path.resolve(this.paths.candidateRuntimeNodeModules)) {
      throw new Error('release_transaction_candidate_generation_lost')
    }
    if (readBuildId(this.paths.previous) !== this.identity.rollbackBuildId) throw new Error('release_transaction_rollback_artifact_lost')
    if (!exists(this.paths.runtimePrevious) || !fs.lstatSync(this.paths.runtimePrevious).isSymbolicLink()) {
      throw new Error('release_transaction_rollback_runtime_lost')
    }
    this.update('COMMITTED')
    const archived = `${this.paths.journal}.committed-${this.transactionId}`
    renameAndSync(this.paths.journal, archived)
    // These are the generation older than the newly preserved rollback. They
    // are no longer recoverable state after COMMITTED and must not pollute the
    // next release baseline.
    removeIfExists(this.retiredArtifact())
    removeIfExists(this.retiredRuntime())
    removeIfExists(this.paths.lock)
    syncDirectory(this.paths.releaseRoot)
    syncDirectory(path.dirname(this.paths.lock))
  }
}
