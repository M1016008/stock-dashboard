import fs from 'node:fs'
import path from 'node:path'
import { DEFAULT_JP_OHLCV_REPAIR_LOCK } from '@/lib/jp-ohlcv-repair-barrier'
import type { JpOhlcvRepairJournal } from '@/lib/jp-ohlcv-production-repair'
import { isProcessGroupAlive } from '@/lib/jp-ohlcv-repair-process-supervisor'

function value(flag: string): string | null {
  const index = process.argv.indexOf(flag)
  const result = index >= 0 ? process.argv[index + 1] ?? null : null
  return result?.startsWith('--') ? null : result
}

function readJson(file: string): unknown {
  if (fs.lstatSync(file).isSymbolicLink()) throw new Error(`repair_state_symlink_forbidden:${file}`)
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

const requested = value('--state-directory')
const stateDirectory = requested ? path.resolve(requested) : path.dirname(DEFAULT_JP_OHLCV_REPAIR_LOCK)
if (process.env.NODE_ENV !== 'test' && stateDirectory !== path.dirname(DEFAULT_JP_OHLCV_REPAIR_LOCK)) {
  throw new Error('repair_status_production_state_directory_override_forbidden')
}
const lockPath = path.join(stateDirectory, 'repair.lock')
const journalPath = path.join(stateDirectory, 'repair-journal.json')
function lstatExists(file: string): boolean {
  try { fs.lstatSync(file); return true } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}
const lockExists = lstatExists(lockPath)
const journalExists = lstatExists(journalPath)
const partialJournals = lstatExists(stateDirectory)
  ? fs.readdirSync(stateDirectory).filter((entry) => entry.startsWith('repair-journal.json.tmp-')).sort()
  : []

type RepairLock = { transactionId?: unknown; pid?: unknown; startedAt?: unknown }

let lock: RepairLock | null = null
let journal: JpOhlcvRepairJournal | null = null
let parseFailure: string | null = null
try {
  if (lockExists) lock = readJson(lockPath) as RepairLock
  if (journalExists) journal = readJson(journalPath) as JpOhlcvRepairJournal
} catch (error) {
  parseFailure = error instanceof Error ? error.message : String(error)
}

const transactionMatches = Boolean(
  lock?.transactionId
  && journal?.transactionId
  && lock.transactionId === journal.transactionId,
)
const activeStageProcess = journal?.activeStageProcess ?? null
const activeStageProcessAlive = activeStageProcess
  ? isProcessGroupAlive(activeStageProcess.processGroupId)
  : false
const status = !lockExists && !journalExists && partialJournals.length === 0
  ? 'CLEAR'
  : parseFailure || !lockExists || !journalExists || !transactionMatches || partialJournals.length > 0
    ? 'HOLD_UNCERTAIN'
    : activeStageProcessAlive
      ? 'HOLD_ACTIVE_STAGE_PROCESS'
      : activeStageProcess
        ? 'HOLD_STALE_STAGE_PROCESS_REQUIRES_EXACT_RECOVERY_APPROVAL'
        : journal?.stage === 'HOLD'
          ? 'HOLD'
          : 'ACTIVE_OR_INCOMPLETE'

console.log(JSON.stringify({
  version: 1,
  checkedAt: new Date().toISOString(),
  status,
  stateDirectory,
  lock: lockExists ? {
    path: lockPath,
    transactionId: lock?.transactionId ?? null,
    pid: lock?.pid ?? null,
    startedAt: lock?.startedAt ?? null,
  } : null,
  journal: journalExists ? {
    path: journalPath,
    transactionId: journal?.transactionId ?? null,
    stage: journal?.stage ?? null,
    updatedAt: journal?.updatedAt ?? null,
    targetDate: journal?.targetDate ?? null,
    operatorAction: journal?.operatorAction ?? null,
    failure: journal?.failure ?? null,
    failureHistory: journal?.failureHistory ?? [],
    protectedPaths: journal?.protectedPaths ?? [],
  } : null,
  transactionMatches,
  activeStageProcess,
  activeStageProcessAlive,
  partialJournals,
  parseFailure,
}, null, 2))

if (status !== 'CLEAR') process.exitCode = 2
