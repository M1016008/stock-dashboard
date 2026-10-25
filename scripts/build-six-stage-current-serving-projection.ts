import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { ML_PHYSICS_FEATURE_SET } from '@/lib/backtest/ml-physics'
import { execAll } from '@/lib/db/client'
import { execUsAnalyticsAll } from '@/lib/db/us-analytics'
import {
  assertCurrentServingProjectionUpdateLock,
  CURRENT_SERVING_PRICE_BASIS,
  loadCurrentServingMarketProjection,
  type CurrentServingQuery,
} from '@/lib/research/six-stage-current-serving-adapter'
import { CURRENT_SERVING_PROJECTION_DEFINITION_VERSION } from '@/lib/research/six-stage-current-serving-projection'
import {
  publishCurrentServingProjectionFromStages,
  readCurrentServingMarketStage,
  stageCurrentServingMarket,
  type CurrentServingMarketStage,
} from '@/lib/research/six-stage-current-serving-projection-store'
import { attestCurrentServingProjectionRunner } from '@/lib/research/six-stage-current-serving-runner-attestation'
import {
  resolveSixStageCurrentProjectionRoot,
  SIX_STAGE_CURRENT_PROJECTION_ROOT,
} from '@/lib/runtime/isolation'
import { inspectWritableTargetPath, type GuardConfig } from '@/lib/storage/external-storage-guard'

const MAX_RUNTIME_MS = 5 * 60_000
const DEFAULT_MIN_FREE_BYTES = 5 * 1024 ** 3

function required(name: string): string {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`CURRENT_PROJECTION_REQUIRED_ENV:${name}`)
  return value
}

function requiredPositiveInteger(name: string): number {
  const value = Number(required(name))
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`CURRENT_PROJECTION_INVALID_ENV:${name}`)
  return value
}

function requiredRatio(name: string): number {
  const value = Number(required(name))
  if (!Number.isFinite(value) || value <= 0 || value > 1) {
    throw new Error(`CURRENT_PROJECTION_INVALID_ENV:${name}`)
  }
  return value
}

function market(): 'JP' | 'US' {
  const value = required('CURRENT_SERVING_PROJECTION_MARKET')
  if (value !== 'JP' && value !== 'US') throw new Error('CURRENT_PROJECTION_INVALID_MARKET')
  return value
}

function assertUpdateContext(selectedMarket: 'JP' | 'US'): void {
  if (process.env.CURRENT_SERVING_PROJECTION_ENABLED !== '1') {
    throw new Error('CURRENT_PROJECTION_DISABLED')
  }
  if (process.env.CURRENT_SERVING_PROJECTION_UPDATE_CONTEXT !== selectedMarket) {
    throw new Error('CURRENT_PROJECTION_NOT_IN_UPDATE_CHAIN')
  }
  if (process.env.SKIP_SCHEMA_ENSURE !== '1') {
    throw new Error('CURRENT_PROJECTION_SCHEMA_WRITE_GUARD_REQUIRED')
  }
}

function assertOutputRoot(root: string): void {
  const requestedRoot = path.resolve(root)
  const approvedRoot = resolveSixStageCurrentProjectionRoot(requestedRoot)
  if (requestedRoot !== approvedRoot || approvedRoot !== SIX_STAGE_CURRENT_PROJECTION_ROOT) {
    throw new Error('CURRENT_PROJECTION_OUTPUT_NAMESPACE_MISMATCH')
  }
  const mountPath = path.resolve(required('CURRENT_SERVING_PROJECTION_MOUNT_PATH'))
  const volumeUuid = required('CURRENT_SERVING_PROJECTION_VOLUME_UUID')
  const minimum = Number(process.env.CURRENT_SERVING_PROJECTION_MIN_FREE_BYTES ?? DEFAULT_MIN_FREE_BYTES)
  if (!Number.isFinite(minimum) || minimum < 1024 ** 3) throw new Error('CURRENT_PROJECTION_INVALID_FREE_SPACE_LIMIT')
  const config: GuardConfig = {
    dbPath: path.join(root, `.projection-preflight-${process.pid}`),
    mountPath,
    volumeUuid,
    minFreeBytes: minimum,
    minFreePercent: 1,
    jobType: 'six-stage-current-serving-projection-output',
  }
  inspectWritableTargetPath(config)
  fs.mkdirSync(root, { recursive: true, mode: 0o700 })
  if (fs.lstatSync(root).isSymbolicLink() || fs.realpathSync(root) !== approvedRoot) {
    throw new Error('CURRENT_PROJECTION_OUTPUT_SYMLINK_REJECTED')
  }
  const rootStat = fs.statSync(root)
  const mountStat = fs.statSync(mountPath)
  if (
    !rootStat.isDirectory()
    || rootStat.dev !== mountStat.dev
    || rootStat.uid !== process.getuid?.()
    || (rootStat.mode & 0o077) !== 0
  ) {
    throw new Error('CURRENT_PROJECTION_OUTPUT_IDENTITY_MISMATCH')
  }
}

function queryFor(selectedMarket: 'JP' | 'US'): CurrentServingQuery {
  return selectedMarket === 'JP'
    ? ((sql, args = []) => execAll(sql, args))
    : ((sql, args = []) => execUsAnalyticsAll(sql, args))
}

function stageAlreadySelected(root: string, stage: CurrentServingMarketStage): boolean {
  try {
    const current = readCurrentServingMarketStage({ root, market: stage.market })
    return current.watermark.sourceGeneration === stage.watermark.sourceGeneration
      && current.watermark.asOfTradingDate === stage.watermark.asOfTradingDate
      && current.rows.length === stage.rows.length
  } catch {
    return false
  }
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false
    throw error
  }
}

function acquirePublicationLock(lock: string): { descriptor: number; token: string } | null {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const token = crypto.randomUUID()
    try {
      const descriptor = fs.openSync(lock, 'wx', 0o600)
      fs.writeFileSync(descriptor, `${JSON.stringify({
        pid: process.pid,
        token,
        createdAt: new Date().toISOString(),
      })}\n`)
      fs.fsyncSync(descriptor)
      return { descriptor, token }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      let owner: { pid?: unknown; token?: unknown; createdAt?: unknown }
      try {
        owner = JSON.parse(fs.readFileSync(lock, 'utf8')) as typeof owner
      } catch {
        throw new Error('CURRENT_PROJECTION_PUBLISH_LOCK_INVALID')
      }
      const pid = Number(owner.pid)
      const createdAt = typeof owner.createdAt === 'string' ? Date.parse(owner.createdAt) : Number.NaN
      if (!Number.isSafeInteger(pid) || pid < 1 || typeof owner.token !== 'string' || !Number.isFinite(createdAt)) {
        throw new Error('CURRENT_PROJECTION_PUBLISH_LOCK_INVALID')
      }
      if (Date.now() - createdAt <= 10 * 60_000 || processAlive(pid)) return null
      fs.unlinkSync(lock)
    }
  }
  return null
}

function releasePublicationLock(lock: string, held: { descriptor: number; token: string }): void {
  fs.closeSync(held.descriptor)
  const owner = JSON.parse(fs.readFileSync(lock, 'utf8')) as { token?: unknown }
  if (owner.token !== held.token) throw new Error('CURRENT_PROJECTION_PUBLISH_LOCK_OWNERSHIP_LOST')
  fs.unlinkSync(lock)
}

function combineIfReady(root: string): { status: 'PUBLISHED' | 'ALREADY_PUBLISHED' | 'WAITING_FOR_OTHER_MARKET'; generationId?: string } {
  const jp = path.join(root, 'market-stages', 'JP', 'CURRENT.json')
  const us = path.join(root, 'market-stages', 'US', 'CURRENT.json')
  if (!fs.existsSync(jp) || !fs.existsSync(us)) return { status: 'WAITING_FOR_OTHER_MARKET' }
  const lock = path.join(root, '.publish.lock')
  const held = acquirePublicationLock(lock)
  if (!held) return { status: 'WAITING_FOR_OTHER_MARKET' }
  try {
    const published = publishCurrentServingProjectionFromStages({ root })
    return {
      status: published.alreadyPublished ? 'ALREADY_PUBLISHED' : 'PUBLISHED',
      generationId: published.manifest.generationId,
    }
  } finally {
    releasePublicationLock(lock, held)
  }
}

async function main(): Promise<void> {
  const selectedMarket = market()
  assertUpdateContext(selectedMarket)
  attestCurrentServingProjectionRunner()
  const startedAt = Date.now()
  const deadlineMs = startedAt + MAX_RUNTIME_MS
  const root = resolveSixStageCurrentProjectionRoot(required('CURRENT_SERVING_PROJECTION_ROOT'))
  assertOutputRoot(root)
  await assertCurrentServingProjectionUpdateLock({
    market: selectedMarket,
    owner: required('CURRENT_SERVING_PROJECTION_UPDATE_LOCK_OWNER'),
    query: (sql, args = []) => execAll(sql, args),
  })
  const loaded = await loadCurrentServingMarketProjection({
    market: selectedMarket,
    query: queryFor(selectedMarket),
    priceBasis: CURRENT_SERVING_PRICE_BASIS[selectedMarket],
    featureSet: ML_PHYSICS_FEATURE_SET,
    deadlineMs,
    minRows: requiredPositiveInteger(`CURRENT_SERVING_PROJECTION_${selectedMarket}_MIN_ROWS`),
    minAuxiliaryCoverage: requiredRatio('CURRENT_SERVING_PROJECTION_MIN_AUXILIARY_COVERAGE'),
  })
  const stage: CurrentServingMarketStage = {
    kind: 'stockboard-six-stage-current-serving-market-stage',
    status: 'COMPLETE',
    market: selectedMarket,
    stagedAt: new Date().toISOString(),
    definitionVersion: CURRENT_SERVING_PROJECTION_DEFINITION_VERSION,
    watermark: {
      asOfTradingDate: loaded.watermark.asOfTradingDate,
      sourceGeneration: loaded.watermark.sourceGeneration,
      priceBasis: loaded.watermark.priceBasis,
      featureSet: loaded.watermark.featureSet,
      rows: loaded.rows.length,
      coverage: {
        snapshotRows: loaded.watermark.snapshotRows,
        eligibleRows: loaded.watermark.eligibleRows,
        universeRows: loaded.watermark.universeRows,
        universeIdentityRows: loaded.watermark.universeIdentityRows,
        closeRows: loaded.watermark.closeRows,
        mlRows: loaded.watermark.mlRows,
        smaRows: loaded.watermark.smaRows,
        physicalRows: loaded.watermark.physicalRows,
      },
    },
    rows: loaded.rows,
  }
  if (!stageAlreadySelected(root, stage)) stageCurrentServingMarket({ root, stage })
  if (Date.now() >= deadlineMs) throw new Error('CURRENT_PROJECTION_DEADLINE_EXCEEDED')
  const publication = combineIfReady(root)
  console.log(JSON.stringify({
    status: 'PASS',
    market: selectedMarket,
    asOfTradingDate: loaded.watermark.asOfTradingDate,
    sourceGeneration: loaded.watermark.sourceGeneration,
    rows: loaded.rows.length,
    publication,
    elapsedMs: Date.now() - startedAt,
  }))
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
