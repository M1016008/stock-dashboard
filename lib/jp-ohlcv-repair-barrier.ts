import fs from 'node:fs'
import { AsyncLocalStorage } from 'node:async_hooks'
import os from 'node:os'
import path from 'node:path'

export const DEFAULT_JP_OHLCV_REPAIR_LOCK = path.join(
  os.userInfo().homedir,
  'Library',
  'Application Support',
  'StockBoard',
  'jp-ohlcv-repair-state',
  'repair.lock',
)

type JpOhlcvRepairOwnerContext = {
  jobType: 'jp_ohlcv_gap_repair'
  transactionId: string
  lockPath: string
}

const repairOwnerContext = new AsyncLocalStorage<JpOhlcvRepairOwnerContext>()

export type JpOhlcvRepairBarrierDecision = {
  blocked: boolean
  lockPath: string
  reason: string
  transactionId: string | null
}

export class JpOhlcvRepairWriteBarrierError extends Error {
  readonly code = 'JP_OHLCV_REPAIR_WRITE_BARRIER'
  readonly reason!: string
  readonly lockPath!: string
  readonly transactionId!: string | null

  constructor(decision: JpOhlcvRepairBarrierDecision) {
    super('JP OHLCV repair is active or requires recovery; database writes are temporarily unavailable.')
    this.name = 'JpOhlcvRepairWriteBarrierError'
    Object.defineProperties(this, {
      reason: { value: decision.reason, enumerable: false },
      lockPath: { value: decision.lockPath, enumerable: false },
      transactionId: { value: decision.transactionId, enumerable: false },
    })
  }
}

export function jpOhlcvRepairBarrierDecision(input: {
  jobType: string
  environment?: NodeJS.ProcessEnv
}): JpOhlcvRepairBarrierDecision {
  const environment = input.environment ?? process.env
  const ownerContext = repairOwnerContext.getStore()
  const configuredLockPath = environment.STOCKBOARD_JP_OHLCV_REPAIR_LOCK_PATH?.trim()
  const lockPath = path.resolve(
    configuredLockPath || ownerContext?.lockPath || DEFAULT_JP_OHLCV_REPAIR_LOCK,
  )
  if (environment.NODE_ENV !== 'test'
    && configuredLockPath
    && lockPath !== path.resolve(DEFAULT_JP_OHLCV_REPAIR_LOCK)) {
    return { blocked: true, lockPath, reason: 'repair_lock_path_override_forbidden', transactionId: null }
  }
  try {
    fs.lstatSync(lockPath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { blocked: false, lockPath, reason: 'absent', transactionId: null }
    }
    return { blocked: true, lockPath, reason: 'repair_lock_unreadable', transactionId: null }
  }
  try {
    if (fs.lstatSync(lockPath).isSymbolicLink()) {
      return { blocked: true, lockPath, reason: 'repair_lock_symlink_invalid', transactionId: null }
    }
    const parsed = JSON.parse(fs.readFileSync(lockPath, 'utf8')) as { transactionId?: unknown }
    const transactionId = typeof parsed.transactionId === 'string' && parsed.transactionId.trim()
      ? parsed.transactionId.trim()
      : null
    const environmentOwner = environment.STOCKBOARD_UPDATE_JOB_TYPE === 'jp_ohlcv_gap_repair'
      && environment.STOCKBOARD_JP_OHLCV_REPAIR_OWNER === '1'
      ? environment.STOCKBOARD_JP_OHLCV_REPAIR_TRANSACTION_ID?.trim() || null
      : null
    const contextOwner = ownerContext?.jobType === 'jp_ohlcv_gap_repair' && ownerContext.lockPath === lockPath
      ? ownerContext.transactionId
      : null
    const owner = contextOwner || environmentOwner
    const ownerAuthorized = Boolean(owner)
    if (ownerAuthorized && transactionId && owner === transactionId) {
      return { blocked: false, lockPath, reason: 'owned_by_repair_transaction', transactionId }
    }
    return {
      blocked: true,
      lockPath,
      reason: transactionId ? 'repair_transaction_active_or_incomplete' : 'repair_lock_invalid',
      transactionId,
    }
  } catch {
    return { blocked: true, lockPath, reason: 'repair_lock_unreadable', transactionId: null }
  }
}

export function assertJpOhlcvRepairMutationAllowed(
  jobType = repairOwnerContext.getStore()?.jobType
    ?? process.env.STOCKBOARD_UPDATE_JOB_TYPE
    ?? 'database_write',
): void {
  const decision = jpOhlcvRepairBarrierDecision({ jobType })
  if (decision.blocked) throw new JpOhlcvRepairWriteBarrierError(decision)
}

export function jpOhlcvRepairOwnerEnvironment(input: {
  transactionId: string
  lockPath: string
}): NodeJS.ProcessEnv {
  if (!input.transactionId.trim()) throw new Error('repair_owner_transaction_id_required')
  if (!path.isAbsolute(input.lockPath)) throw new Error('repair_owner_lock_absolute_path_required')
  const inherited = [
    'PATH',
    'HOME',
    'USER',
    'LOGNAME',
    'TMPDIR',
    'LANG',
    'LC_ALL',
    'TZ',
    'NODE_ENV',
    'USE_LOCAL_DB',
    'STOCKBOARD_DB_PATH',
    'SKIP_SCHEMA_ENSURE',
    'EXTERNAL_STORAGE_REQUIRED',
    'STOCK_DATA_MOUNT_PATH',
    'STOCK_DATA_VOLUME_UUID',
    'STOCK_DATA_MIN_FREE_BYTES',
    'STOCK_DATA_MIN_FREE_PERCENT',
    'STOCKBOARD_JP_OHLCV_EXECUTION_CONFIGURATION_SHA256',
  ].reduce((environment, key) => {
    const value = process.env[key]
    if (value !== undefined) environment[key] = value
    return environment
  }, {} as NodeJS.ProcessEnv)
  return {
    ...inherited,
    STOCKBOARD_JP_OHLCV_REPAIR_OWNER: '1',
    STOCKBOARD_JP_OHLCV_REPAIR_TRANSACTION_ID: input.transactionId,
    STOCKBOARD_JP_OHLCV_REPAIR_LOCK_PATH: path.resolve(input.lockPath),
    STOCKBOARD_UPDATE_JOB_TYPE: 'jp_ohlcv_gap_repair',
  }
}

export function withJpOhlcvRepairBarrierOwner<T>(
  input: { transactionId: string; lockPath: string },
  operation: () => T,
): T {
  if (!input.transactionId.trim()) throw new Error('repair_owner_transaction_id_required')
  if (!path.isAbsolute(input.lockPath)) throw new Error('repair_owner_lock_absolute_path_required')
  return repairOwnerContext.run({
    jobType: 'jp_ohlcv_gap_repair',
    transactionId: input.transactionId,
    lockPath: path.resolve(input.lockPath),
  }, operation)
}
