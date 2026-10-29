import path from 'node:path'
import { DEFAULT_JP_OHLCV_REPAIR_LOCK } from '@/lib/jp-ohlcv-repair-barrier'
import {
  inspectJpOhlcvProductionRepair,
  type JpOhlcvRepairPaths,
} from '@/lib/jp-ohlcv-production-repair'

function value(flag: string): string | null {
  const index = process.argv.indexOf(flag)
  const result = index >= 0 ? process.argv[index + 1] ?? null : null
  return result?.startsWith('--') ? null : result
}

const requested = value('--state-directory')
const stateDirectory = requested ? path.resolve(requested) : path.dirname(DEFAULT_JP_OHLCV_REPAIR_LOCK)
if (process.env.NODE_ENV !== 'test' && stateDirectory !== path.dirname(DEFAULT_JP_OHLCV_REPAIR_LOCK)) {
  console.log(JSON.stringify({
    version: 2,
    checkedAt: new Date().toISOString(),
    status: 'HOLD_UNCERTAIN',
    reasons: ['repair_status_production_state_directory_override_forbidden'],
    fallbackOperatorAction: 'Use the fixed Production repair state directory. Do not inspect or alter an alternate path as if it were Production state.',
  }, null, 2))
  process.exitCode = 2
} else {
  const paths: JpOhlcvRepairPaths = {
    stateDirectory,
    journal: path.join(stateDirectory, 'repair-journal.json'),
    lock: path.join(stateDirectory, 'repair.lock'),
  }

  try {
    const inspection = inspectJpOhlcvProductionRepair(paths)
    console.log(JSON.stringify(inspection, null, 2))
    if (inspection.status !== 'CLEAR') process.exitCode = 2
  } catch (error) {
    console.log(JSON.stringify({
      version: 2,
      checkedAt: new Date().toISOString(),
      status: 'HOLD_UNCERTAIN',
      reasons: [`STATUS_INSPECTION_FAILED:${error instanceof Error ? error.message : String(error)}`],
      stateDirectory,
      fallbackOperatorAction: 'Preserve the entire repair state directory and all approved database, WAL/SHM, backup and generation artifacts. Do not delete locks or journals and do not retry.',
    }, null, 2))
    process.exitCode = 2
  }
}
