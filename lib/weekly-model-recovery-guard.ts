import path from 'node:path'
import { OperatorActionRequiredError } from '@/lib/operational-exit'
import {
  assertNoIncompleteSqlitePromotion,
  resolveSqlitePromotionJournalPath,
  resolveWeeklyMlPromotionJournalPath,
} from '@/lib/sqlite-promotion-journal'
import {
  acquireUsMlProcessLock,
  US_ML_PROCESS_LOCK_PATH,
} from '@/lib/us-ml-process-lock'

type WeeklyModelRecoveryGuardInput = {
  stepId: string
  market: 'JP' | 'US' | null
  modelDbPath: string
  priceBasis: string
  originalFailure: string
  env?: Readonly<Record<string, string | undefined>>
  usMlLockPath?: string
}

export class WeeklyModelRecoveryBlockedError extends OperatorActionRequiredError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'WeeklyModelRecoveryBlockedError'
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function protectedArtifactSummary(
  modelDbPath: string,
  priceBasis: string,
  env: Readonly<Record<string, string | undefined>>,
): { journalPaths: string[]; artifacts: string[] } {
  const primaryPath = path.resolve(modelDbPath)
  const foundationShadowPath = env.US_ADJUSTED_FOUNDATION_SHADOW_PATH?.trim()
    ? path.resolve(env.US_ADJUSTED_FOUNDATION_SHADOW_PATH)
    : `${primaryPath}.${priceBasis}.building`
  const weeklyShadowPath = `${primaryPath}.weekly-ml.building`
  const foundationJournalPath = resolveSqlitePromotionJournalPath(primaryPath, priceBasis, env)
  const weeklyJournalPath = resolveWeeklyMlPromotionJournalPath(primaryPath)
  const sqliteFamily = (dbPath: string) => [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]
  return {
    journalPaths: [foundationJournalPath, weeklyJournalPath],
    artifacts: [
      ...sqliteFamily(primaryPath),
      ...sqliteFamily(foundationShadowPath),
      ...sqliteFamily(weeklyShadowPath),
      `${primaryPath}.pre-weekly-ml-*`,
      foundationJournalPath,
      weeklyJournalPath,
    ],
  }
}

export async function withWeeklyModelRecoveryGuard<T>(
  input: WeeklyModelRecoveryGuardInput,
  recover: () => Promise<T>,
): Promise<T> {
  if (input.market !== 'US') return recover()

  const env = input.env ?? process.env
  const lockPath = input.usMlLockPath ?? US_ML_PROCESS_LOCK_PATH
  const protectedState = protectedArtifactSummary(input.modelDbPath, input.priceBasis, env)
  const lock = acquireUsMlProcessLock(`parent-recovery-${input.stepId}`, lockPath)
  if (!lock) {
    throw new WeeklyModelRecoveryBlockedError(
      `Weekly parent model recovery is blocked by a concurrent US ML owner; step=${input.stepId}, `
      + `originalFailure=${input.originalFailure}, lock=${lockPath}, generation=unknown, `
      + `journals=not-inspected-due-to-concurrent-owner:${protectedState.journalPaths.join(',')}, `
      + `protectedArtifacts=${protectedState.artifacts.join(',')}. `
      + 'Do not restore, republish, promote, delete, or adopt these artifacts until ownership is reviewed.',
    )
  }

  try {
    for (const [journalKind, journalPath] of [
      ['adjusted-foundation', protectedState.journalPaths[0]],
      ['weekly-ml', protectedState.journalPaths[1]],
    ] as const) {
      try {
        assertNoIncompleteSqlitePromotion(journalPath)
      } catch (error) {
        throw new WeeklyModelRecoveryBlockedError(
          `Weekly parent model recovery is fail-closed because promotion state is incomplete or unreadable; `
          + `step=${input.stepId}, originalFailure=${input.originalFailure}, generation=unknown, `
          + `blockingJournalKind=${journalKind}, blockingJournal=${journalPath}, `
          + `allJournals=${protectedState.journalPaths.join(',')}, `
          + `protectedArtifacts=${protectedState.artifacts.join(',')}, `
          + `unknownArtifacts=journal corruption may hide exact Analog and timestamped backup paths, `
          + `journalReason=${errorMessage(error)}. `
          + 'Do not restore, republish, promote, delete, or adopt any listed or related artifact. '
          + 'Read-only operator inspection and explicit recovery approval are required.',
          { cause: error },
        )
      }
    }
    return await recover()
  } finally {
    lock.release()
  }
}
