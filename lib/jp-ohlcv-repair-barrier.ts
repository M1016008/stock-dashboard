import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const DEFAULT_JP_OHLCV_REPAIR_LOCK = path.join(
  os.homedir(),
  'Library',
  'Application Support',
  'StockBoard',
  'jp-ohlcv-repair-state',
  'repair.lock',
)

export type JpOhlcvRepairBarrierDecision = {
  blocked: boolean
  lockPath: string
  reason: string
  transactionId: string | null
}

export function jpOhlcvRepairBarrierDecision(input: {
  jobType: string
  environment?: NodeJS.ProcessEnv
}): JpOhlcvRepairBarrierDecision {
  const environment = input.environment ?? process.env
  const lockPath = path.resolve(
    environment.STOCKBOARD_JP_OHLCV_REPAIR_LOCK_PATH?.trim() || DEFAULT_JP_OHLCV_REPAIR_LOCK,
  )
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
    const owner = environment.STOCKBOARD_JP_OHLCV_REPAIR_TRANSACTION_ID?.trim() || null
    if (input.jobType === 'jp_ohlcv_gap_repair' && transactionId && owner === transactionId) {
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
