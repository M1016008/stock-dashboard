import { openExistingGuardedClient } from '@/lib/storage/guarded-libsql-client'
import fs from 'node:fs'
import path from 'node:path'
import {
  inspectMlPipelineEvidence,
  type MlPipelineAction,
  type MlPipelineMarket,
  readMlPipelineState,
  recordMlPipelineBaseline,
  recordMlPipelineDelta,
  verifyOrAdoptMlPipelineBaseline,
} from '@/lib/ml/pipeline-generation'
import { resolveConfiguredStoragePath } from '@/lib/storage-paths'
import {
  DeferredExecutionError,
  OperatorActionRequiredError,
  operationalExitCode,
} from '@/lib/operational-exit'
import {
  assessWeeklySourceReadiness,
  parseWeeklyOptimizationRunContract,
} from '@/lib/weekly-optimization-run-contract'
import { readWeeklySourceObservation } from '@/lib/weekly-source-observation'
import {
  assessWeeklyUsSourceBoundary,
  parseWeeklyUsSourceBoundary,
  US_WEEKLY_SOURCE_BOUNDARY_ENV,
} from '@/lib/weekly-us-source-boundary'

const DEFAULT_US_DB = '/Volumes/OWC Express 1M2 80G/stockboard-data/us/stockboard-us.db'

function marketFromEnv(value: string | undefined): MlPipelineMarket {
  const normalized = value?.trim().toUpperCase()
  if (normalized === 'JP' || normalized === 'US') return normalized
  throw new Error('ML_PIPELINE_MARKET must be JP or US')
}

function actionFromEnv(value: string | undefined): MlPipelineAction {
  if (value === 'verify-or-adopt' || value === 'mark-baseline' || value === 'mark-delta' || value === 'status') {
    return value
  }
  throw new Error('ML_PIPELINE_ACTION must be verify-or-adopt, mark-baseline, mark-delta, or status')
}

function databasePath(market: MlPipelineMarket): string {
  const configured = market === 'US'
    ? process.env.US_ANALYTICS_DB_PATH?.trim() || process.env.STOCKBOARD_DB_PATH?.trim() || DEFAULT_US_DB
    : process.env.STOCKBOARD_DB_PATH?.trim() || process.env.LOCAL_DB_PATH?.trim() || 'data/stockboard.db'
  return resolveConfiguredStoragePath(path.resolve(configured))
}

async function acquirePinnedUsSourcePromotionLock(
  market: MlPipelineMarket,
  action: MlPipelineAction,
): Promise<import('@/lib/server/update-lock').UpdateLockHandle | null> {
  const rawContract = process.env.WEEKLY_OPTIMIZATION_CONTRACT?.trim()
  const rawBoundary = process.env[US_WEEKLY_SOURCE_BOUNDARY_ENV]?.trim()
  if (market !== 'US' || !['mark-baseline', 'mark-delta'].includes(action)) {
    return null
  }
  if (!rawContract && !rawBoundary) {
    if (process.env.US_ML_ALLOW_UNPINNED_DAILY_PROMOTION === '1') return null
    throw new OperatorActionRequiredError(
      'US generation promotion requires a weekly run contract or pinned source boundary',
    )
  }
  const sourceDbPath = process.env.STOCKBOARD_SOURCE_DB_PATH?.trim()
  if (!sourceDbPath) {
    throw new OperatorActionRequiredError(
      'Weekly US generation promotion requires STOCKBOARD_SOURCE_DB_PATH',
    )
  }
  const contract = rawContract ? parseWeeklyOptimizationRunContract(rawContract) : null
  const boundary = rawBoundary ? parseWeeklyUsSourceBoundary(rawBoundary) : null

  // update-lock binds its client at module initialization. Load it only after
  // pinning the source role, while the analytics target remains an explicit path.
  process.env.STOCKBOARD_DB_PATH = sourceDbPath
  process.env.LOCAL_DB_PATH = sourceDbPath
  process.env.STOCKBOARD_DB_ROLE = 'source'
  const { acquireUsStockboardUpdateLock } = await import('@/lib/server/update-lock')
  const lock = await acquireUsStockboardUpdateLock('us_model_generation_promotion', 15 * 60)
  if (!lock) {
    throw new DeferredExecutionError(
      'Weekly US generation promotion deferred: source generation is changing',
    )
  }
  try {
    const source = readWeeklySourceObservation(
      'US',
      resolveConfiguredStoragePath(path.resolve(sourceDbPath)),
      contract?.markets.US.priceBasis ?? boundary!.priceBasis,
    )
    source.activeWriterLocks = source.activeWriterLocks.filter(
      (entry) => !entry.startsWith('us_model_generation_promotion:'),
    )
    const assessment = contract
      ? assessWeeklySourceReadiness(contract.markets.US, source)
      : assessWeeklyUsSourceBoundary(boundary!, source)
    if (!assessment.ok) {
      throw new OperatorActionRequiredError(
        `Weekly US generation promotion blocked by source lineage: ${assessment.issues.join(', ')}`,
      )
    }
    return lock
  } catch (error) {
    await lock.release().catch(() => undefined)
    throw error
  }
}

async function main(): Promise<void> {
  const market = marketFromEnv(process.env.ML_PIPELINE_MARKET)
  const action = actionFromEnv(process.env.ML_PIPELINE_ACTION)
  const dbPath = databasePath(market)
  if (!fs.existsSync(dbPath)) throw new Error(`${market} database not found: ${dbPath}`)

  const sourcePromotionLock = await acquirePinnedUsSourcePromotionLock(market, action)
  let sourcePromotionHeartbeatError: unknown = null
  const sourcePromotionHeartbeat = sourcePromotionLock
    ? setInterval(() => {
        void sourcePromotionLock.heartbeat().catch((error) => {
          sourcePromotionHeartbeatError = error
        })
      }, 60_000)
    : null
  const assertSourcePromotionLock = async (): Promise<void> => {
    if (!sourcePromotionLock) return
    if (sourcePromotionHeartbeatError) {
      throw new OperatorActionRequiredError(
        `Weekly US generation promotion lost its source lock: ${String(sourcePromotionHeartbeatError)}`,
      )
    }
    try {
      await sourcePromotionLock.heartbeat()
    } catch (error) {
      throw new OperatorActionRequiredError(
        `Weekly US generation promotion could not renew its source lock: ${String(error)}`,
      )
    }
  }
  let client: ReturnType<typeof openExistingGuardedClient> | null = null
  try {
    client = openExistingGuardedClient(dbPath, 'ml-pipeline-generation')
    await client.execute(`PRAGMA busy_timeout=${Number(process.env.SQLITE_BUSY_TIMEOUT_MS ?? 60_000)}`)
    if (action === 'verify-or-adopt') {
      const result = await verifyOrAdoptMlPipelineBaseline(client, market)
      console.log(JSON.stringify({ action, market, adopted: result.adopted, state: result.state }, null, 2))
      return
    }
    if (action === 'mark-baseline') {
      const sourceDate = process.env.WEEKLY_OPTIMIZATION_CONTRACT?.trim()
        ? parseWeeklyOptimizationRunContract(process.env.WEEKLY_OPTIMIZATION_CONTRACT).markets[market].expectedTradingDate
        : market === 'US' && process.env[US_WEEKLY_SOURCE_BOUNDARY_ENV]?.trim()
          ? parseWeeklyUsSourceBoundary(process.env[US_WEEKLY_SOURCE_BOUNDARY_ENV]!).expectedTradingDate
          : process.env.ML_PIPELINE_SOURCE_DATE?.trim() || null
      const evidence = await inspectMlPipelineEvidence(client, market, {
        includeCounts: process.env.ML_PIPELINE_INCLUDE_COUNTS === '1',
        requireFullHistoryModels: true,
        sourceDate,
      })
      await assertSourcePromotionLock()
      await recordMlPipelineBaseline(client, evidence)
      console.log(JSON.stringify({ action, market, evidence }, null, 2))
      return
    }
    if (action === 'mark-delta') {
      const sourceDate = process.env.WEEKLY_OPTIMIZATION_CONTRACT?.trim()
        ? parseWeeklyOptimizationRunContract(process.env.WEEKLY_OPTIMIZATION_CONTRACT).markets[market].expectedTradingDate
        : market === 'US' && process.env[US_WEEKLY_SOURCE_BOUNDARY_ENV]?.trim()
          ? parseWeeklyUsSourceBoundary(process.env[US_WEEKLY_SOURCE_BOUNDARY_ENV]!).expectedTradingDate
          : null
      const evidence = await inspectMlPipelineEvidence(client, market, { sourceDate })
      await assertSourcePromotionLock()
      await recordMlPipelineDelta(client, market, evidence)
      console.log(JSON.stringify({ action, market, evidence }, null, 2))
      return
    }

    const state = await readMlPipelineState(client, market)
    console.log(JSON.stringify({ action, market, state }, null, 2))
  } finally {
    if (sourcePromotionHeartbeat) clearInterval(sourcePromotionHeartbeat)
    try {
      client?.close()
    } finally {
      if (sourcePromotionLock) {
        try {
          await sourcePromotionLock.release()
        } catch (error) {
          throw new OperatorActionRequiredError(
            `Weekly US generation promotion could not release its source lock: ${String(error)}`,
          )
        }
      }
    }
  }
}

main().catch((error) => {
  console.error('[manage-ml-pipeline-generation] failed:', error)
  process.exitCode = operationalExitCode(error)
})
