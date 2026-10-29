import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import type { JpOhlcvProductionExecutionConfiguration } from '@/lib/jp-ohlcv-executable-plan'

type ReadOnlyDatabase = {
  prepare(sql: string): { get(): Record<string, unknown> | undefined }
  close(): void
}

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as {
  DatabaseSync: new (file: string, options: { readOnly: boolean }) => ReadOnlyDatabase
}

function value(flag: string): string {
  const index = process.argv.indexOf(flag)
  const result = index >= 0 ? process.argv[index + 1] : null
  if (!result || result.startsWith('--')) throw new Error(`${flag}_required`)
  return result
}

function sqlText(input: string): string {
  if (input.includes('\0') || input.includes('\n') || input.includes('\r')) throw new Error('repair_verify_sql_text_invalid')
  return `'${input.replaceAll("'", "''")}'`
}

const configPath = path.resolve(value('--config'))
const mode = value('--mode')
if (mode !== 'forward' && mode !== 'rollback') throw new Error('repair_verify_mode_unsupported')
const config = JSON.parse(fs.readFileSync(configPath, 'utf8')) as JpOhlcvProductionExecutionConfiguration
const database = process.env.STOCKBOARD_DB_PATH
if (!database || fs.realpathSync(database) !== config.databaseRealpath) {
  throw new Error('repair_verify_database_identity_mismatch')
}
const connection = new DatabaseSync(database, { readOnly: true })

function sqlite(sql: string): string {
  const row = connection.prepare(sql).get()
  if (!row) return ''
  const value = Object.values(row)[0]
  return value === null || value === undefined ? '' : String(value)
}

const expectedTargetRows = mode === 'forward'
  ? config.repairScope.officialRows
  : config.repairScope.existingRows
const targetRows = Number(sqlite(`SELECT COUNT(*) FROM ohlcv_daily WHERE date=${sqlText(config.targetDate)};`))
if (targetRows !== expectedTargetRows) {
  throw new Error(`repair_verify_${mode}_coverage_mismatch:expected_${expectedTargetRows}:actual_${targetRows}`)
}
for (const expected of config.preservedConflictRows) {
  const encoded = sqlite(`SELECT json_array(open,high,low,close,volume) FROM ohlcv_daily
    WHERE ticker=${sqlText(expected.ticker)} AND date=${sqlText(config.targetDate)};`)
  const values = JSON.parse(encoded || 'null') as unknown
  const wanted = [expected.open, expected.high, expected.low, expected.close, expected.volume]
  if (!Array.isArray(values) || values.length !== wanted.length
    || values.some((entry, index) => Number(entry) !== wanted[index])) {
    throw new Error(`repair_verify_${mode}_conflict_changed:${expected.ticker}`)
  }
}
for (const table of [
  'daily_snapshots',
  'stage_transitions',
  'stock_screening_serving',
  'stock_screening_serving_dates',
  'dashboard_cache',
]) {
  const exists = Number(sqlite(`SELECT COUNT(*) FROM sqlite_schema WHERE type='table' AND name=${sqlText(table)};`))
  if (exists !== 1) throw new Error(`repair_verify_${mode}_derived_table_missing:${table}`)
}

let derived: Record<string, unknown> | null = null
if (mode === 'forward') {
  for (const expected of config.requiredTargetRows) {
    const encoded = sqlite(`SELECT json_array(open,high,low,close,volume) FROM ohlcv_daily
      WHERE ticker=${sqlText(expected.ticker)} AND date=${sqlText(config.targetDate)};`)
    const values = JSON.parse(encoded || 'null') as unknown
    const wanted = [expected.open, expected.high, expected.low, expected.close, expected.volume]
    if (!Array.isArray(values) || values.length !== wanted.length
      || values.some((entry, index) => Number(entry) !== wanted[index])) {
      throw new Error(`repair_verify_forward_required_row_mismatch:${expected.ticker}`)
    }
    const snapshot = JSON.parse(sqlite(`SELECT json_object(
        'date', date, 'ma75', ma_75, 'computedAt', computed_at
      ) FROM daily_snapshots
      WHERE ticker=${sqlText(expected.ticker)} AND date=${sqlText(config.targetDate)};`) || 'null') as {
        date?: unknown; ma75?: unknown; computedAt?: unknown
      } | null
    if (snapshot?.date !== config.targetDate || !Number.isFinite(Number(snapshot.ma75))
      || !Number.isFinite(Number(snapshot.computedAt))) {
      throw new Error(`repair_verify_forward_snapshot_incomplete:${expected.ticker}`)
    }
  }

  const latestSnapshotDate = sqlite('SELECT MAX(date) FROM daily_snapshots;')
  if (!/^\d{4}-\d{2}-\d{2}$/.test(latestSnapshotDate) || latestSnapshotDate < config.targetDate) {
    throw new Error('repair_verify_forward_latest_snapshot_invalid')
  }
  const transitionAxes = Number(sqlite('SELECT COUNT(DISTINCT axis) FROM stage_transitions WHERE count > 0;'))
  if (transitionAxes !== 6) throw new Error(`repair_verify_forward_stage_transition_axes_invalid:${transitionAxes}`)

  const screener = JSON.parse(sqlite(`SELECT json_object(
      'asOf', as_of, 'snapshotDate', snapshot_date, 'rowCount', row_count,
      'sourceVersion', source_version, 'status', status, 'calculatedAt', calculated_at
    ) FROM stock_screening_serving_dates
    WHERE as_of=${sqlText(latestSnapshotDate)};`) || 'null') as Record<string, unknown> | null
  const screenerRows = Number(sqlite(`SELECT COUNT(*) FROM stock_screening_serving
    WHERE as_of=${sqlText(latestSnapshotDate)};`))
  if (screener?.status !== 'completed' || screener?.snapshotDate !== latestSnapshotDate
    || !Number.isSafeInteger(Number(screener.rowCount)) || Number(screener.rowCount) <= 0
    || screenerRows !== Number(screener.rowCount)
    || typeof screener.sourceVersion !== 'string' || screener.sourceVersion.length === 0
    || !Number.isFinite(Number(screener.calculatedAt))) {
    throw new Error('repair_verify_forward_screener_generation_invalid')
  }

  const dashboard = JSON.parse(sqlite(`SELECT json_object(
      'date', date, 'validJson', json_valid(payload_json),
      'payloadBytes', length(payload_json), 'computedAt', computed_at
    ) FROM dashboard_cache WHERE date=${sqlText(latestSnapshotDate)};`) || 'null') as Record<string, unknown> | null
  if (dashboard?.date !== latestSnapshotDate || Number(dashboard.validJson) !== 1
    || Number(dashboard.payloadBytes) <= 2 || !Number.isFinite(Number(dashboard.computedAt))) {
    throw new Error('repair_verify_forward_dashboard_generation_invalid')
  }

  if (!fs.existsSync(config.triggerRepairEvidencePath)
    || fs.lstatSync(config.triggerRepairEvidencePath).isSymbolicLink()) {
    throw new Error('repair_verify_forward_trigger_evidence_missing')
  }
  const triggerEvidence = JSON.parse(fs.readFileSync(config.triggerRepairEvidencePath, 'utf8')) as Record<string, unknown>
  if (triggerEvidence.version !== 1
    || triggerEvidence.sourceGeneration !== config.sourceGenerationAfter
    || triggerEvidence.status !== 'COMPLETED'
    || Number(triggerEvidence.failedCount) !== 0
    || triggerEvidence.notificationsSuppressed !== true
    || typeof triggerEvidence.batchId !== 'string'
    || !Array.isArray(triggerEvidence.evaluationIds)) {
    throw new Error('repair_verify_forward_trigger_generation_invalid')
  }
  derived = {
    latestSnapshotDate,
    transitionAxes,
    screener,
    screenerRows,
    dashboard,
    triggerEvidence: {
      batchId: triggerEvidence.batchId,
      sourceGeneration: triggerEvidence.sourceGeneration,
      status: triggerEvidence.status,
      definitionCount: triggerEvidence.definitionCount,
      evaluationCount: triggerEvidence.evaluationIds.length,
      notificationsSuppressed: triggerEvidence.notificationsSuppressed,
    },
  }
}
if (sqlite('PRAGMA quick_check;') !== 'ok') throw new Error(`repair_verify_${mode}_quick_check_failed`)
connection.close()

console.log(JSON.stringify({
  status: 'PASS',
  mode,
  dataQualityStatus: mode === 'forward'
    ? 'MISSING_ROWS_REPAIRED_EXISTING_CONFLICTS_HOLD'
    : 'BASELINE_RESTORED_EXISTING_CONFLICTS_HOLD',
  dayFullyRepaired: false,
  targetDate: config.targetDate,
  targetRows,
  preservedConflicts: config.preservedConflictTickers,
  unresolvedConflictCount: config.preservedConflictTickers.length,
  derived,
  quickCheck: 'ok',
}))
