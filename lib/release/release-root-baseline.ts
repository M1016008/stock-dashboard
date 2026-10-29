import fs from 'node:fs'
import path from 'node:path'

const RUNNER_OWNED_ROLLBACK_RUNTIME = '.node_modules-release-prev'
const ALLOWED_STATUS = `?? ${RUNNER_OWNED_ROLLBACK_RUNTIME}`
const COMMITTED_JOURNAL_PREFIX = 'sma-release-journal.json.committed-'

interface CommittedJournal {
  version: number
  transactionId: string
  stage: string
  candidate: { buildId: string }
  rollback: { runtimeIdentitySha256: string; runtimeNodeModulesTarget: string }
  paths: {
    releaseRoot: string
    live: string
    nodeModules: string
    runtimePrevious: string
    candidateRuntimeNodeModules: string
    journal: string
  }
}

export interface RunnerOwnedRollbackRuntime {
  target: string
  runtimeIdentitySha256: string
  journalFile: string
}

function committedJournal(value: unknown, file: string): CommittedJournal {
  const record = value as Partial<CommittedJournal> | null
  const candidate = record?.candidate as Partial<CommittedJournal['candidate']> | undefined
  const rollback = record?.rollback as Partial<CommittedJournal['rollback']> | undefined
  const paths = record?.paths as Partial<CommittedJournal['paths']> | undefined
  const pathFields: Array<keyof CommittedJournal['paths']> = [
    'releaseRoot', 'live', 'nodeModules', 'runtimePrevious', 'candidateRuntimeNodeModules', 'journal',
  ]
  if (
    !record || record.version !== 1 || typeof record.transactionId !== 'string' || typeof record.stage !== 'string'
    || typeof candidate?.buildId !== 'string'
    || typeof rollback?.runtimeIdentitySha256 !== 'string' || typeof rollback.runtimeNodeModulesTarget !== 'string'
    || !paths || pathFields.some((field) => typeof paths[field] !== 'string')
  ) throw new Error(`release_committed_journal_invalid_contract:${file}`)
  return record as CommittedJournal
}

function inside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child)
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
}

function canonicalLocation(value: string): string {
  return path.join(fs.realpathSync(path.dirname(value)), path.basename(value))
}

function assertRunnerOwnedRollbackRuntime(releaseRoot: string, releaseStateDirectory: string): RunnerOwnedRollbackRuntime {
  const link = path.join(releaseRoot, RUNNER_OWNED_ROLLBACK_RUNTIME)
  let stat: fs.Stats
  try {
    stat = fs.lstatSync(link)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error('release_runner_owned_rollback_runtime_missing')
    throw new Error(`release_runner_owned_rollback_runtime_lstat_failed:${(error as NodeJS.ErrnoException).code ?? 'unknown'}`)
  }
  if (!stat.isSymbolicLink()) throw new Error('release_runner_owned_rollback_runtime_must_be_symlink')
  const realReleaseRoot = fs.realpathSync(releaseRoot)
  const target = fs.realpathSync(link)
  if (inside(realReleaseRoot, target)) throw new Error('release_runner_owned_rollback_runtime_must_be_external')
  if (!fs.statSync(target).isDirectory()) throw new Error(`release_runner_owned_rollback_runtime_target_invalid:${target}`)

  const currentBuildId = fs.readFileSync(path.join(releaseRoot, '.next-live', 'BUILD_ID'), 'utf8').trim()
  const currentRuntimeTarget = fs.realpathSync(path.join(releaseRoot, 'node_modules'))
  const expectedJournalPath = path.join(releaseStateDirectory, 'sma-release-journal.json')
  const matches: RunnerOwnedRollbackRuntime[] = []
  for (const entry of fs.readdirSync(releaseStateDirectory).filter((name) => name.startsWith(COMMITTED_JOURNAL_PREFIX))) {
    const journalFile = path.join(releaseStateDirectory, entry)
    let journal: CommittedJournal
    try {
      journal = committedJournal(JSON.parse(fs.readFileSync(journalFile, 'utf8')), journalFile)
    } catch (error) {
      throw new Error(`release_committed_journal_invalid:${journalFile}:${error instanceof Error ? error.message : String(error)}`)
    }
    if (
      journal.version !== 1
      || journal.stage !== 'COMMITTED'
      || journal.paths.journal !== expectedJournalPath
      || journalFile !== `${journal.paths.journal}.committed-${journal.transactionId}`
    ) continue
    if (
      fs.realpathSync(journal.paths.releaseRoot) !== realReleaseRoot
      || canonicalLocation(journal.paths.live) !== path.join(realReleaseRoot, '.next-live')
      || canonicalLocation(journal.paths.nodeModules) !== path.join(realReleaseRoot, 'node_modules')
      || canonicalLocation(journal.paths.runtimePrevious) !== path.join(realReleaseRoot, RUNNER_OWNED_ROLLBACK_RUNTIME)
      || journal.candidate.buildId !== currentBuildId
      || fs.realpathSync(journal.paths.candidateRuntimeNodeModules) !== currentRuntimeTarget
      || fs.realpathSync(journal.rollback.runtimeNodeModulesTarget) !== target
      || !/^[a-f0-9]{64}$/.test(journal.rollback.runtimeIdentitySha256)
    ) continue
    matches.push({ target, runtimeIdentitySha256: journal.rollback.runtimeIdentitySha256, journalFile })
  }
  if (matches.length !== 1) throw new Error(`release_runner_owned_rollback_runtime_journal_mismatch:${matches.length}`)
  if (matches[0].target === currentRuntimeTarget) throw new Error('release_runner_owned_rollback_runtime_matches_active_runtime')
  return matches[0]
}

export function assertReleaseRootBaselineStatus(
  releaseRoot: string,
  releaseStateDirectory: string,
  porcelainStatus: string,
): RunnerOwnedRollbackRuntime | null {
  const lines = porcelainStatus.split('\n').map((line) => line.trimEnd()).filter(Boolean)
  const unexpected = lines.filter((line) => line !== ALLOWED_STATUS)
  if (unexpected.length > 0 || lines.filter((line) => line === ALLOWED_STATUS).length > 1) {
    throw new Error(`release_baseline_worktree_dirty:${unexpected.join(',') || 'duplicate_runner_owned_path'}`)
  }
  return lines.includes(ALLOWED_STATUS)
    ? assertRunnerOwnedRollbackRuntime(releaseRoot, releaseStateDirectory)
    : null
}
