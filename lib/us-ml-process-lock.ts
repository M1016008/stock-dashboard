import os from 'node:os'
import path from 'node:path'
import { acquirePidProcessLock, type PidProcessLock } from '@/lib/pid-process-lock'

export const US_ML_PROCESS_LOCK_PATH = path.join(
  os.homedir(),
  'Library',
  'Application Support',
  'StockBoard',
  'us-ml-job.lock',
)

export type UsMlProcessLock = PidProcessLock

export function acquireUsMlProcessLock(
  mode: string,
  lockPath = US_ML_PROCESS_LOCK_PATH,
): UsMlProcessLock | null {
  return acquirePidProcessLock(lockPath, `US ML ${mode}`)
}
