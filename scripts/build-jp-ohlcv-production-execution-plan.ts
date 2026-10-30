import fs from 'node:fs'
import path from 'node:path'
import {
  assertJpOhlcvRepairExecutionPlan,
  type JpOhlcvRepairExecutionPlan,
} from '@/lib/jp-ohlcv-command-adapter'
import type { JpOfficialOhlcvValue, JpOhlcvMissingOnlyRepairScope } from '@/lib/jp-ohlcv-data-quality'
import { JP_OHLCV_BACKUP_TIME_LIMITS as limits } from '@/lib/jp-ohlcv-backup-time-budget'

function value(flag: string): string {
  const index = process.argv.indexOf(flag)
  const result = index >= 0 ? process.argv[index + 1] : null
  if (!result || result.startsWith('--')) throw new Error(`${flag}_required`)
  return result
}

function absolute(flag: string): string {
  const result = value(flag)
  if (!path.isAbsolute(result)) throw new Error(`${flag}_absolute_path_required`)
  return path.resolve(result)
}

function readJson<T>(file: string): T {
  if (fs.lstatSync(file).isSymbolicLink()) throw new Error('repair_plan_input_symlink_forbidden')
  return JSON.parse(fs.readFileSync(file, 'utf8')) as T
}

const officialInput = readJson<JpOfficialOhlcvValue[] | { rows: JpOfficialOhlcvValue[] }>(absolute('--official-rows'))
const officialRows = Array.isArray(officialInput) ? officialInput : officialInput.rows
const commands = readJson<JpOhlcvRepairExecutionPlan['commands']>(absolute('--commands'))
const approvalScope = readJson<JpOhlcvMissingOnlyRepairScope>(absolute('--approval-scope'))
const targetDate = value('--target-date')
const output = absolute('--output')
const plan: JpOhlcvRepairExecutionPlan = {
  version: 1,
  officialRows,
  approvalScope,
  timeBudget: {
    maximumMaintenanceMs: limits.maximumMaintenanceMs,
    forwardDerivedAggregateMs: limits.forwardDerivedAggregateTimeoutMs,
    rollbackDerivedAggregateMs: limits.rollbackDerivedAggregateTimeoutMs,
  },
  commands,
}
assertJpOhlcvRepairExecutionPlan({ plan, targetDate })
fs.mkdirSync(path.dirname(output), { recursive: true })
fs.writeFileSync(output, `${JSON.stringify(plan, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
console.log(JSON.stringify({ status: 'PASS', output, targetDate, officialRows: officialRows.length }))
