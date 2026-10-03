import { randomUUID } from 'node:crypto'
import { execAll, execBatch, execGet, execRun } from '@/lib/db/client'
import {
  DEFAULT_SCREENING_COLUMNS,
  SCREENING_METRIC_MAP,
  type IntegratedScreeningRow,
  type ScreeningCondition,
  type ScreeningMetricKey,
} from '@/lib/integrated-screener'
import {
  conditionPassed,
  conditionTargetText,
  formatMetric,
  getScreenerReason,
  operatorSymbol,
} from '@/lib/server/integrated-screener-reason'
import {
  evaluateIntegratedScreeningSet,
  getIntegratedScreeningRowsAtDate,
} from '@/lib/server/integrated-screener-serving'
import type {
  SavedScreenChangeReasonContract,
  SavedScreenDefinitionContract,
  SavedScreenEvaluationDetail,
  SavedScreenEvaluationMember,
  SavedScreenEvaluationStatus,
  SavedScreenEvaluationSummary,
  SavedScreenMetricTransition,
  SavedScreenStateContract,
  ScreeningSnapshotValue,
} from '@/lib/screener-evaluation'

const MEMBER_WRITE_CHUNK = 100
const CHANGE_METRICS: ScreeningMetricKey[] = [
  'dailyAStage', 'dailyBStage', 'weeklyAStage', 'weeklyBStage', 'monthlyAStage', 'monthlyBStage',
  'stageCode', 'forwardPer', 'per', 'pbr', 'psr', 'fcfYield', 'evEbitda',
  'latestForecastRevisionRate', 'latestForecastRevisionDirection',
  'pms', 'pfs', 'sectorStructureScore', 'sectorRank',
]

type DefinitionRow = {
  id: string
  name: string
  definition_version: number
  state_json: string
  conditions_json: string
  condition_signature: string
  active: number
  created_at: number
  updated_at: number
}

type EvaluationRow = {
  evaluation_id: string
  definition_id: string
  definition_version: number
  evaluated_at: number
  as_of: string
  snapshot_date: string
  previous_evaluation_id: string | null
  previous_as_of: string | null
  conditions_json: string
  matched_count: number
  new_count: number
  stay_count: number
  out_count: number
  elapsed_ms: number
  status: string
}

type MemberRow = {
  ticker: string
  name: string
  status: SavedScreenEvaluationStatus
  previous_values_json: string | null
  current_values_json: string | null
  changes_json: string | null
}

function isoDateTime(epochSeconds: number): string {
  return new Date(Number(epochSeconds) * 1000).toISOString()
}

function parseJson<T>(value: string, fallback: T): T {
  try { return JSON.parse(value) as T } catch { return fallback }
}

function normalizeState(input: SavedScreenStateContract): SavedScreenStateContract {
  const conditions = input.conditions.filter((condition) => {
    const definition = SCREENING_METRIC_MAP.get(condition.metric)
    return Boolean(definition?.operators.includes(condition.operator))
  }).slice(0, 40)
  const columns = input.columns.filter((metric) => SCREENING_METRIC_MAP.has(metric))
  return {
    asOf: typeof input.asOf === 'string' ? input.asOf : '',
    conditions,
    sort: SCREENING_METRIC_MAP.has(input.sort) ? input.sort : 'marketCap',
    direction: input.direction === 'asc' ? 'asc' : 'desc',
    columns: columns.length > 0 ? columns : DEFAULT_SCREENING_COLUMNS,
    page: 0,
  }
}

function conditionSignature(conditions: ScreeningCondition[]): string {
  return JSON.stringify(conditions.map((condition) => ({
    metric: condition.metric,
    operator: condition.operator,
    value: condition.value ?? null,
    valueTo: condition.valueTo ?? null,
  })).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))))
}

function evaluationSummary(row: EvaluationRow): SavedScreenEvaluationSummary {
  return {
    evaluationId: row.evaluation_id,
    definitionVersion: Number(row.definition_version),
    evaluatedAt: isoDateTime(row.evaluated_at),
    asOf: row.as_of,
    snapshotDate: row.snapshot_date,
    previousEvaluationId: row.previous_evaluation_id,
    previousAsOf: row.previous_as_of,
    matchedCount: Number(row.matched_count),
    newCount: Number(row.new_count),
    stayCount: Number(row.stay_count),
    outCount: Number(row.out_count),
    elapsedMs: Number(row.elapsed_ms),
  }
}

async function loadDefinitionRows(activeOnly = true): Promise<DefinitionRow[]> {
  return execAll<DefinitionRow>(`
    SELECT id, name, definition_version, state_json, conditions_json, condition_signature,
           active, created_at, updated_at
    FROM saved_screening_definitions
    ${activeOnly ? 'WHERE active=1' : ''}
    ORDER BY updated_at DESC, name
  `)
}

async function definitionContract(row: DefinitionRow): Promise<SavedScreenDefinitionContract> {
  const historyRows = await execAll<EvaluationRow>(`
    SELECT * FROM saved_screening_evaluations
    WHERE definition_id=? AND status='completed'
    ORDER BY as_of DESC, evaluated_at DESC LIMIT 12
  `, [row.id])
  const history = historyRows.map(evaluationSummary)
  return {
    id: row.id,
    name: row.name,
    definitionVersion: Number(row.definition_version),
    state: parseJson(row.state_json, normalizeState({
      conditions: [], sort: 'marketCap', direction: 'desc', columns: DEFAULT_SCREENING_COLUMNS,
    })),
    active: Boolean(row.active),
    createdAt: isoDateTime(row.created_at),
    updatedAt: isoDateTime(row.updated_at),
    latestEvaluation: history[0] ?? null,
    history,
  }
}

export async function listSavedScreeningDefinitions(): Promise<SavedScreenDefinitionContract[]> {
  const rows = await loadDefinitionRows(true)
  return Promise.all(rows.map(definitionContract))
}

export async function upsertSavedScreeningDefinition(input: {
  id?: string | null
  name: string
  state: SavedScreenStateContract
  evaluate?: boolean
  evaluateAsOf?: string | null
}): Promise<SavedScreenDefinitionContract> {
  const name = input.name.trim().slice(0, 80)
  if (!name) throw new Error('保存条件名を入力してください。')
  const state = normalizeState(input.state)
  const signature = conditionSignature(state.conditions)
  const existing = await execGet<DefinitionRow>(`
    SELECT * FROM saved_screening_definitions WHERE id=? OR name=?
    ORDER BY CASE WHEN id=? THEN 0 ELSE 1 END LIMIT 1
  `, [input.id ?? '', name, input.id ?? ''])
  const id = existing?.id ?? input.id?.trim() ?? randomUUID()
  const version = existing && existing.condition_signature !== signature
    ? Number(existing.definition_version) + 1
    : Number(existing?.definition_version ?? 1)
  await execRun(`
    INSERT INTO saved_screening_definitions (
      id, name, definition_version, state_json, conditions_json, condition_signature,
      active, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, 1, unixepoch(), unixepoch())
    ON CONFLICT(id) DO UPDATE SET
      name=excluded.name,
      definition_version=excluded.definition_version,
      state_json=excluded.state_json,
      conditions_json=excluded.conditions_json,
      condition_signature=excluded.condition_signature,
      active=1,
      updated_at=unixepoch()
  `, [id, name, version, JSON.stringify(state), JSON.stringify(state.conditions), signature])
  if (input.evaluate !== false) await evaluateSavedScreeningDefinition(id, input.evaluateAsOf)
  const row = await execGet<DefinitionRow>('SELECT * FROM saved_screening_definitions WHERE id=?', [id])
  if (!row) throw new Error('保存条件を保存できませんでした。')
  return definitionContract(row)
}

export async function deactivateSavedScreeningDefinition(id: string): Promise<void> {
  await execRun('UPDATE saved_screening_definitions SET active=0, updated_at=unixepoch() WHERE id=?', [id])
}

function snapshotValue(row: IntegratedScreeningRow | null, metric: ScreeningMetricKey): ScreeningSnapshotValue {
  if (!row) return null
  const value = row[metric as keyof IntegratedScreeningRow]
  if (value == null || value === '') return null
  if (typeof value === 'number' || typeof value === 'string' || typeof value === 'boolean') return value
  return null
}

function compactSnapshot(row: IntegratedScreeningRow | null, conditions: ScreeningCondition[]): Record<string, ScreeningSnapshotValue> | null {
  if (!row) return null
  const metrics = new Set<ScreeningMetricKey>([...conditions.map((condition) => condition.metric), ...CHANGE_METRICS])
  return Object.fromEntries([...metrics].map((metric) => [metric, snapshotValue(row, metric)]))
}

function conditionExpression(condition: ScreeningCondition): string {
  if (condition.operator === 'between' || condition.operator === 'in' || condition.operator === 'has_data') {
    return conditionTargetText(condition)
  }
  return `${operatorSymbol(condition.operator)} ${conditionTargetText(condition)}`
}

function changedEnough(metric: ScreeningMetricKey, previous: ScreeningSnapshotValue, current: ScreeningSnapshotValue): boolean {
  if (previous == null || current == null) return previous !== current
  if (String(previous) === String(current)) return false
  const definition = SCREENING_METRIC_MAP.get(metric)
  if (!definition || ['text', 'boolean', 'stage'].includes(definition.valueType)) return true
  const before = Number(previous)
  const after = Number(current)
  if (!Number.isFinite(before) || !Number.isFinite(after)) return true
  const scale = Math.max(Math.abs(before), Math.abs(after), 1)
  return Math.abs(after - before) / scale >= 0.005
}

function transition(input: {
  metric: ScreeningMetricKey
  condition: ScreeningCondition | null
  previousRow: IntegratedScreeningRow | null
  currentRow: IntegratedScreeningRow | null
  previousAsOf: string | null
  currentAsOf: string
  kind: SavedScreenMetricTransition['kind']
}): SavedScreenMetricTransition {
  const definition = SCREENING_METRIC_MAP.get(input.metric)!
  const previousValue = snapshotValue(input.previousRow, input.metric)
  const currentValue = snapshotValue(input.currentRow, input.metric)
  const previousPassed = input.condition && input.previousRow ? conditionPassed(input.previousRow, input.condition) : null
  const currentPassed = input.condition && input.currentRow ? conditionPassed(input.currentRow, input.condition) : null
  const previousFormatted = formatMetric(input.metric, previousValue)
  const currentFormatted = formatMetric(input.metric, currentValue)
  const suffix = input.condition && ['condition_became_true', 'condition_became_false'].includes(input.kind)
    ? `（条件 ${conditionExpression(input.condition)}を${input.kind === 'condition_became_true' ? '新たに充足' : '未充足'}）`
    : ''
  return {
    id: `${input.kind}:${input.metric}`,
    metric: input.metric,
    label: definition.label,
    kind: input.kind,
    condition: input.condition,
    previous: { asOf: input.previousAsOf, value: previousValue, formatted: previousFormatted, passed: previousPassed },
    current: { asOf: input.currentAsOf, value: currentValue, formatted: currentFormatted, passed: currentPassed },
    message: `${definition.label} ${previousFormatted} → ${currentFormatted}${suffix}`,
    source: {
      source: 'stock_screening_serving', sourceMetric: input.metric,
      previousAsOf: input.previousAsOf, currentAsOf: input.currentAsOf,
    },
  }
}

function buildTransitions(input: {
  status: Exclude<SavedScreenEvaluationStatus, 'STAY'>
  conditions: ScreeningCondition[]
  previousRow: IntegratedScreeningRow | null
  currentRow: IntegratedScreeningRow | null
  previousAsOf: string | null
  currentAsOf: string
}): { conditionChanges: SavedScreenMetricTransition[]; contextChanges: SavedScreenMetricTransition[] } {
  const conditionChanges: SavedScreenMetricTransition[] = []
  for (const condition of input.conditions) {
    const previousPassed = input.previousRow ? conditionPassed(input.previousRow, condition) : false
    const currentPassed = input.currentRow ? conditionPassed(input.currentRow, condition) : false
    if (previousPassed === currentPassed) continue
    conditionChanges.push(transition({
      metric: condition.metric,
      condition,
      previousRow: input.previousRow,
      currentRow: input.currentRow,
      previousAsOf: input.previousAsOf,
      currentAsOf: input.currentAsOf,
      kind: currentPassed ? 'condition_became_true' : 'condition_became_false',
    }))
  }
  const conditionMetrics = new Set(input.conditions.map((condition) => condition.metric))
  const contextChanges = CHANGE_METRICS.filter((metric) => !conditionMetrics.has(metric)).flatMap((metric) => {
    const previousValue = snapshotValue(input.previousRow, metric)
    const currentValue = snapshotValue(input.currentRow, metric)
    if (!changedEnough(metric, previousValue, currentValue)) return []
    const kind = previousValue == null ? 'data_appeared' : currentValue == null ? 'data_disappeared' : 'value_changed'
    return [transition({
      metric, condition: null, previousRow: input.previousRow, currentRow: input.currentRow,
      previousAsOf: input.previousAsOf, currentAsOf: input.currentAsOf, kind,
    })]
  })
  return { conditionChanges, contextChanges }
}

export async function evaluateSavedScreeningDefinition(
  definitionId: string,
  requestedAsOf?: string | null,
): Promise<SavedScreenEvaluationSummary> {
  const startedAt = Date.now()
  const definition = await execGet<DefinitionRow>('SELECT * FROM saved_screening_definitions WHERE id=? AND active=1', [definitionId])
  if (!definition) throw new Error('保存条件が見つかりません。')
  const conditions = parseJson<ScreeningCondition[]>(definition.conditions_json, [])
  const current = await evaluateIntegratedScreeningSet({ asOf: requestedAsOf, conditions })
  const evaluationId = `${definition.id}:v${definition.definition_version}:${current.asOf}`
  const previous = await execGet<EvaluationRow>(`
    SELECT * FROM saved_screening_evaluations
    WHERE definition_id=? AND definition_version=? AND status='completed' AND as_of < ?
    ORDER BY as_of DESC, evaluated_at DESC LIMIT 1
  `, [definition.id, definition.definition_version, current.asOf])
  await execRun(`
    INSERT INTO saved_screening_evaluations (
      evaluation_id, definition_id, definition_version, evaluated_at, as_of, snapshot_date,
      previous_evaluation_id, previous_as_of, conditions_json, status
    ) VALUES (?, ?, ?, unixepoch(), ?, ?, ?, ?, ?, 'running')
    ON CONFLICT(evaluation_id) DO UPDATE SET
      evaluated_at=unixepoch(), snapshot_date=excluded.snapshot_date,
      previous_evaluation_id=excluded.previous_evaluation_id, previous_as_of=excluded.previous_as_of,
      conditions_json=excluded.conditions_json, status='running', error_message=NULL
  `, [
    evaluationId, definition.id, definition.definition_version, current.asOf, current.snapshotDate,
    previous?.evaluation_id ?? null, previous?.as_of ?? null, JSON.stringify(conditions),
  ])
  try {
    const previousMembers = previous
      ? await execAll<{ ticker: string; name: string }>(`
          SELECT ticker, name FROM saved_screening_evaluation_members
          WHERE evaluation_id=? AND status IN ('NEW','STAY')
        `, [previous.evaluation_id])
      : []
    const previousNames = new Map(previousMembers.map((member) => [member.ticker, member.name]))
    const previousSet = new Set(previousMembers.map((member) => member.ticker))
    const currentRows = new Map(current.rows.map((row) => [row.ticker, row]))
    const currentSet = new Set(currentRows.keys())
    const newTickers = previous ? [...currentSet].filter((ticker) => !previousSet.has(ticker)) : []
    const stayTickers = previous ? [...currentSet].filter((ticker) => previousSet.has(ticker)) : [...currentSet]
    const outTickers = previous ? [...previousSet].filter((ticker) => !currentSet.has(ticker)) : []
    const deltaTickers = [...newTickers, ...outTickers]
    const [previousRows, currentDeltaRows] = await Promise.all([
      previous ? getIntegratedScreeningRowsAtDate(previous.as_of, deltaTickers) : Promise.resolve(new Map<string, IntegratedScreeningRow>()),
      getIntegratedScreeningRowsAtDate(current.asOf, outTickers),
    ])
    const members: Array<{
      ticker: string
      name: string
      status: SavedScreenEvaluationStatus
      previousValues: string | null
      currentValues: string | null
      changes: string | null
    }> = []
    for (const ticker of stayTickers) {
      members.push({ ticker, name: currentRows.get(ticker)?.name ?? previousNames.get(ticker) ?? ticker, status: 'STAY', previousValues: null, currentValues: null, changes: null })
    }
    for (const [status, tickers] of [['NEW', newTickers], ['OUT', outTickers]] as const) {
      for (const ticker of tickers) {
        const previousRow = previousRows.get(ticker) ?? null
        const currentRow = currentRows.get(ticker) ?? currentDeltaRows.get(ticker) ?? null
        members.push({
          ticker,
          name: currentRow?.name ?? previousRow?.name ?? previousNames.get(ticker) ?? ticker,
          status,
          previousValues: previousRow ? JSON.stringify(compactSnapshot(previousRow, conditions)) : null,
          currentValues: currentRow ? JSON.stringify(compactSnapshot(currentRow, conditions)) : null,
          changes: null,
        })
      }
    }
    await execRun('DELETE FROM saved_screening_evaluation_members WHERE evaluation_id=?', [evaluationId])
    for (let index = 0; index < members.length; index += MEMBER_WRITE_CHUNK) {
      await execBatch(members.slice(index, index + MEMBER_WRITE_CHUNK).map((member) => ({
        sql: `INSERT INTO saved_screening_evaluation_members (
          evaluation_id, ticker, name, status, previous_values_json, current_values_json, changes_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, unixepoch())`,
        args: [evaluationId, member.ticker, member.name, member.status, member.previousValues, member.currentValues, member.changes],
      })))
    }
    const elapsedMs = Date.now() - startedAt
    await execRun(`
      UPDATE saved_screening_evaluations SET
        matched_count=?, new_count=?, stay_count=?, out_count=?, elapsed_ms=?, status='completed', error_message=NULL
      WHERE evaluation_id=?
    `, [currentSet.size, newTickers.length, stayTickers.length, outTickers.length, elapsedMs, evaluationId])
    const completed = await execGet<EvaluationRow>('SELECT * FROM saved_screening_evaluations WHERE evaluation_id=?', [evaluationId])
    if (!completed) throw new Error('評価履歴を保存できませんでした。')
    return evaluationSummary(completed)
  } catch (error) {
    await execRun(`UPDATE saved_screening_evaluations SET status='error', error_message=?, elapsed_ms=? WHERE evaluation_id=?`, [
      error instanceof Error ? error.message.slice(0, 1000) : String(error).slice(0, 1000),
      Date.now() - startedAt,
      evaluationId,
    ])
    throw error
  }
}

export async function evaluateAllSavedScreeningDefinitions(
  requestedAsOf?: string | null,
): Promise<Array<{ id: string; name: string; evaluation: SavedScreenEvaluationSummary | null; error: string | null }>> {
  const definitions = await loadDefinitionRows(true)
  const results = []
  for (const definition of definitions) {
    try {
      results.push({ id: definition.id, name: definition.name, evaluation: await evaluateSavedScreeningDefinition(definition.id, requestedAsOf), error: null })
    } catch (error) {
      results.push({ id: definition.id, name: definition.name, evaluation: null, error: error instanceof Error ? error.message : String(error) })
    }
  }
  return results
}

async function getDefinitionContract(id: string): Promise<SavedScreenDefinitionContract | null> {
  const row = await execGet<DefinitionRow>('SELECT * FROM saved_screening_definitions WHERE id=?', [id])
  return row ? definitionContract(row) : null
}

export async function getSavedScreeningEvaluationDetail(input: {
  definitionId: string
  evaluationId?: string | null
  status?: SavedScreenEvaluationStatus
  limit?: number
  offset?: number
}): Promise<SavedScreenEvaluationDetail | null> {
  const definition = await getDefinitionContract(input.definitionId)
  if (!definition) return null
  const evaluation = input.evaluationId
    ? await execGet<EvaluationRow>('SELECT * FROM saved_screening_evaluations WHERE evaluation_id=? AND definition_id=? AND status=\'completed\'', [input.evaluationId, input.definitionId])
    : await execGet<EvaluationRow>('SELECT * FROM saved_screening_evaluations WHERE definition_id=? AND status=\'completed\' ORDER BY as_of DESC, evaluated_at DESC LIMIT 1', [input.definitionId])
  if (!evaluation) return null
  const status = input.status && ['NEW', 'STAY', 'OUT'].includes(input.status) ? input.status : 'NEW'
  const limit = Math.max(1, Math.min(200, Math.floor(input.limit ?? 50)))
  const offset = Math.max(0, Math.floor(input.offset ?? 0))
  const [count, rows] = await Promise.all([
    execGet<{ total: number }>('SELECT COUNT(*) AS total FROM saved_screening_evaluation_members WHERE evaluation_id=? AND status=?', [evaluation.evaluation_id, status]),
    execAll<MemberRow>(`
      SELECT ticker, name, status, previous_values_json, current_values_json, changes_json
      FROM saved_screening_evaluation_members WHERE evaluation_id=? AND status=?
      ORDER BY ticker LIMIT ? OFFSET ?
    `, [evaluation.evaluation_id, status, limit, offset]),
  ])
  return {
    contractVersion: 'saved-screen-evaluation-v1',
    definition,
    evaluation: evaluationSummary(evaluation),
    status,
    total: Number(count?.total ?? 0), limit, offset,
    members: rows.map((row): SavedScreenEvaluationMember => ({ ticker: row.ticker, name: row.name, status: row.status })),
  }
}

export async function getSavedScreeningChangeReason(input: {
  definitionId: string
  evaluationId: string
  ticker: string
}): Promise<SavedScreenChangeReasonContract | null> {
  const startedAt = Date.now()
  const [evaluation, member] = await Promise.all([
    execGet<EvaluationRow>('SELECT * FROM saved_screening_evaluations WHERE evaluation_id=? AND definition_id=? AND status=\'completed\'', [input.evaluationId, input.definitionId]),
    execGet<MemberRow>('SELECT ticker, name, status, previous_values_json, current_values_json, changes_json FROM saved_screening_evaluation_members WHERE evaluation_id=? AND ticker=?', [input.evaluationId, input.ticker]),
  ])
  if (!evaluation || !member || member.status === 'STAY') return null
  const conditions = parseJson<ScreeningCondition[]>(evaluation.conditions_json, [])
  const previousValues = parseJson<Record<string, ScreeningSnapshotValue>>(member.previous_values_json ?? '{}', {})
  const currentValues = parseJson<Record<string, ScreeningSnapshotValue>>(member.current_values_json ?? '{}', {})
  const stored = buildTransitions({
    status: member.status,
    conditions,
    previousRow: member.previous_values_json ? previousValues as unknown as IntegratedScreeningRow : null,
    currentRow: member.current_values_json ? currentValues as unknown as IntegratedScreeningRow : null,
    previousAsOf: evaluation.previous_as_of,
    currentAsOf: evaluation.as_of,
  })
  const reasonAsOf = member.status === 'NEW' ? evaluation.as_of : evaluation.previous_as_of
  const reason = reasonAsOf ? await getScreenerReason({ ticker: member.ticker, asOf: reasonAsOf, conditions }) : null
  const status = member.status as 'NEW' | 'OUT'
  return {
    contractVersion: 'saved-screen-change-reason-v1',
    definitionId: evaluation.definition_id,
    definitionVersion: Number(evaluation.definition_version),
    evaluationId: evaluation.evaluation_id,
    ticker: member.ticker,
    name: member.name,
    status,
    previousAsOf: evaluation.previous_as_of,
    currentAsOf: evaluation.as_of,
    summary: status === 'NEW' ? '保存条件を新たに充足' : '保存条件から外れた',
    conditionChanges: stored.conditionChanges,
    contextChanges: stored.contextChanges.slice(0, 8),
    reason,
    generatedAt: new Date().toISOString(),
    elapsedMs: Date.now() - startedAt,
    disclaimer: '構造化データのPIT差分です。投資推奨、売買判断、目標株価ではありません。',
  }
}
