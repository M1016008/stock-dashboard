import { createHash, randomUUID } from 'node:crypto'
import type { InValue } from '@libsql/client'
import { client, ensureReady, execAll, execGet, execRun } from '@/lib/db/client'
import {
  getTriggerDiscovery,
  TriggerDiscoveryInputError,
  type TriggerDiscoveryInput,
  type TriggerDiscoveryExecutionOptions,
  type TriggerDiscoveryObservation,
  type TriggerDiscoveryResult,
  type TriggerDiscoveryRow,
} from '@/lib/server/trigger-discovery-read-model'
import {
  SavedTriggerNotFoundError,
  getSavedTriggerDefinition,
  getSavedTriggerDefinitionForHistory,
  validateSavedTriggerId,
} from '@/lib/server/saved-trigger-definitions'
import { parseTriggerDiscoverySearchRequest } from '@/lib/server/trigger-discovery-search-request'
import {
  TRIGGER_EVALUATION_CONTRACT_VERSION,
  type TriggerEvaluationDetailResponse,
  type TriggerEvaluationMember,
  type TriggerEvaluationRunResponse,
  type TriggerEvaluationStatus,
  type TriggerEvaluationSummary,
} from '@/lib/trigger-evaluation'
import {
  deriveAndPersistTriggerLifecycle,
  getPreviousEvaluationMemberTickers,
} from '@/lib/server/trigger-lifecycle'
import {
  SavedTriggerValidationError,
  canonicalizeSavedTriggerEvaluationConfig,
  searchRequestFromSavedTrigger,
  type SavedTriggerDefinition,
} from '@/lib/trigger-definition'

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const ALL_CANDIDATES_LIMIT = 10_000
const MEMBER_WRITE_CHUNK = 20

type EvaluationRow = {
  id: string
  definition_id: string
  evaluation_version: number
  engine_version: number
  score_version: number
  run_signature: string
  evaluation_config_signature: string
  evaluation_config_snapshot_json: string
  requested_as_of: string
  resolved_as_of: string
  started_at: number
  completed_at: number | null
  status: TriggerEvaluationStatus
  pit_universe_count: number
  current_price_count: number
  stale_accepted_count: number
  trigger_evaluated_count: number
  trigger_matched_count: number
  final_matched_count: number
  duration_ms: number
  discovery_duration_ms: number
  snapshot_transform_ms: number
  persistence_duration_ms: number
  discovery_query_count: number
  discovery_db_query_ms: number
  attempt_count: number
  error_category: string | null
  created_at: number
}

type MemberRow = {
  evaluation_id: string
  ticker: string
  company_name: string
  market: string | null
  trigger_status: TriggerDiscoveryRow['triggerStatus']
  price: number
  ma1_value: number
  ma2_value: number
  zone_upper: number
  zone_lower: number
  zone_distance_pct: number
  ma1_distance_pct: number
  ma2_distance_pct: number
  approach_velocity: number
  average_volume: number | null
  average_trading_value: number | null
  day_a_stage: number | null
  day_b_stage: number | null
  week_a_stage: number | null
  week_b_stage: number | null
  month_a_stage: number | null
  month_b_stage: number | null
  stage_available: number
  stage_complete: number
  trigger_score: number
  score_breakdown_json: string
  price_date: string
  ma_date: string
  stage_date: string | null
  price_freshness: TriggerDiscoveryRow['priceFreshness']
  price_staleness_sessions: number
  liquidity_lookback_sessions: number
  liquidity_observation_count: number
  liquidity_complete: number
  ma1_period: number
  ma2_period: number
  ma1_trend: TriggerDiscoveryRow['ma1Trend']
  ma2_trend: TriggerDiscoveryRow['ma2Trend']
  ma1_slope_pct: number
  ma2_slope_pct: number
  both_rising: number
  from_above: number
  approach_direction: TriggerDiscoveryRow['approachDirection']
  ma_path: TriggerDiscoveryRow['maPath']
}

export class TriggerEvaluationNotFoundError extends Error {
  constructor() {
    super('Trigger評価が見つかりません。')
    this.name = 'TriggerEvaluationNotFoundError'
  }
}

export class TriggerEvaluationInProgressError extends Error {
  constructor() {
    super('同じ条件・基準日の評価を実行中です。')
    this.name = 'TriggerEvaluationInProgressError'
  }
}

export class TriggerEvaluationDefinitionChangedError extends Error {
  constructor() {
    super('保存済みTriggerが日次Batch開始後に変更されました。')
    this.name = 'TriggerEvaluationDefinitionChangedError'
  }
}

export type TriggerEvaluationDefinitionIdentity = {
  evaluationVersion: number
  evaluationConfigSignature: string
  engineVersion: number
  scoreVersion: number
}

export interface TriggerEvaluationDependencies {
  resolveAsOf?: (requestedAsOf: string) => Promise<string | null>
  discover?: (input: TriggerDiscoveryInput, options?: TriggerDiscoveryExecutionOptions) => Promise<TriggerDiscoveryResult>
  now?: () => number
  expectedDefinitionIdentity?: TriggerEvaluationDefinitionIdentity
}

function matchesExpectedDefinitionIdentity(
  definition: SavedTriggerDefinition,
  expected: TriggerEvaluationDefinitionIdentity | undefined,
): boolean {
  return expected == null || (
    definition.evaluationVersion === expected.evaluationVersion
    && definition.evaluationSignature === expected.evaluationConfigSignature
    && definition.engineVersion === expected.engineVersion
    && definition.scoreVersion === expected.scoreVersion
  )
}

const EVALUATION_COLUMNS = `
  id, definition_id, evaluation_version, engine_version, score_version,
  run_signature, evaluation_config_signature, evaluation_config_snapshot_json,
  requested_as_of, resolved_as_of, started_at, completed_at, status,
  pit_universe_count, current_price_count, stale_accepted_count,
  trigger_evaluated_count, trigger_matched_count, final_matched_count,
  duration_ms, discovery_duration_ms, snapshot_transform_ms, persistence_duration_ms,
  discovery_query_count, discovery_db_query_ms, attempt_count, error_category, created_at
`

function isoDateTime(epochSeconds: number | null): string | null {
  return epochSeconds == null ? null : new Date(Number(epochSeconds) * 1000).toISOString()
}

function parseSnapshot(value: string): SavedTriggerDefinition['evaluationConfig'] {
  try {
    return canonicalizeSavedTriggerEvaluationConfig(JSON.parse(value), { allowLegacyTimeframe: true })
  } catch {
    throw new Error('evaluation config snapshot is corrupted')
  }
}

function summary(row: EvaluationRow): TriggerEvaluationSummary {
  return {
    id: row.id,
    definitionId: row.definition_id,
    evaluationVersion: Number(row.evaluation_version),
    engineVersion: Number(row.engine_version),
    scoreVersion: Number(row.score_version),
    runSignature: row.run_signature,
    evaluationConfigSignature: row.evaluation_config_signature,
    evaluationConfigSnapshot: parseSnapshot(row.evaluation_config_snapshot_json),
    requestedAsOf: row.requested_as_of,
    resolvedAsOf: row.resolved_as_of,
    startedAt: isoDateTime(row.started_at)!,
    completedAt: isoDateTime(row.completed_at),
    status: row.status,
    counts: {
      pitUniverse: Number(row.pit_universe_count),
      currentPrice: Number(row.current_price_count),
      staleAccepted: Number(row.stale_accepted_count),
      triggerEvaluated: Number(row.trigger_evaluated_count),
      triggerMatched: Number(row.trigger_matched_count),
      finalMatched: Number(row.final_matched_count),
    },
    performance: {
      totalMs: Number(row.duration_ms),
      discoveryMs: Number(row.discovery_duration_ms),
      snapshotTransformMs: Number(row.snapshot_transform_ms),
      persistenceMs: Number(row.persistence_duration_ms),
      discoveryQueryCount: Number(row.discovery_query_count),
      discoveryDbQueryMs: Number(row.discovery_db_query_ms),
    },
    attemptCount: Number(row.attempt_count),
    errorCategory: row.error_category,
    createdAt: isoDateTime(row.created_at)!,
  }
}

function member(row: MemberRow): TriggerEvaluationMember {
  return {
    ticker: row.ticker,
    companyName: row.company_name,
    market: row.market,
    priceDate: row.price_date,
    maDate: row.ma_date,
    stageDate: row.stage_date,
    price: Number(row.price),
    priceStalenessSessions: Number(row.price_staleness_sessions),
    priceFreshness: row.price_freshness,
    averageVolume: row.average_volume == null ? null : Number(row.average_volume),
    averageTradingValue: row.average_trading_value == null ? null : Number(row.average_trading_value),
    liquidityLookbackSessions: Number(row.liquidity_lookback_sessions),
    liquidityObservationCount: Number(row.liquidity_observation_count),
    liquidityComplete: Boolean(row.liquidity_complete),
    ma1Period: Number(row.ma1_period),
    ma2Period: Number(row.ma2_period),
    ma1Value: Number(row.ma1_value),
    ma2Value: Number(row.ma2_value),
    ma1Trend: row.ma1_trend,
    ma2Trend: row.ma2_trend,
    ma1SlopePct: Number(row.ma1_slope_pct),
    ma2SlopePct: Number(row.ma2_slope_pct),
    bothRising: Boolean(row.both_rising),
    zoneUpper: Number(row.zone_upper),
    zoneLower: Number(row.zone_lower),
    zoneDistancePct: Number(row.zone_distance_pct),
    ma1DistancePct: Number(row.ma1_distance_pct),
    ma2DistancePct: Number(row.ma2_distance_pct),
    fromAbove: Boolean(row.from_above),
    approachDirection: row.approach_direction,
    approachVelocityPctPointsPerSession: Number(row.approach_velocity),
    triggerStatus: row.trigger_status,
    maPath: row.ma_path,
    triggerScore: Number(row.trigger_score),
    scoreBreakdown: JSON.parse(row.score_breakdown_json),
    dayAStage: row.day_a_stage == null ? null : Number(row.day_a_stage),
    dayBStage: row.day_b_stage == null ? null : Number(row.day_b_stage),
    weekAStage: row.week_a_stage == null ? null : Number(row.week_a_stage),
    weekBStage: row.week_b_stage == null ? null : Number(row.week_b_stage),
    monthAStage: row.month_a_stage == null ? null : Number(row.month_a_stage),
    monthBStage: row.month_b_stage == null ? null : Number(row.month_b_stage),
    stageAvailable: Boolean(row.stage_available),
    stageComplete: Boolean(row.stage_complete),
  }
}

function runSignature(definition: SavedTriggerDefinition, resolvedAsOf: string): string {
  return createHash('sha256').update(JSON.stringify({
    definitionId: definition.id,
    evaluationVersion: definition.evaluationVersion,
    engineVersion: definition.engineVersion,
    scoreVersion: definition.scoreVersion,
    evaluationConfigSignature: definition.evaluationSignature,
    resolvedAsOf,
  })).digest('hex')
}

async function defaultResolveAsOf(requestedAsOf: string): Promise<string | null> {
  const parsed = parseTriggerDiscoverySearchRequest({ requestedAsOf })
  const row = await execGet<{ date: string | null }>(
    'SELECT MAX(date) AS date FROM ohlcv_daily WHERE date <= ?',
    [parsed.request.requestedAsOf],
  )
  return row?.date ?? null
}

function discoveryInput(definition: SavedTriggerDefinition, requestedAsOf: string): {
  input: TriggerDiscoveryInput
  options: TriggerDiscoveryExecutionOptions
} {
  const parsed = parseTriggerDiscoverySearchRequest(searchRequestFromSavedTrigger(definition, requestedAsOf))
  return {
    input: {
      ...parsed.input,
      sortBy: undefined,
      sortDirection: undefined,
      limit: ALL_CANDIDATES_LIMIT,
      offset: 0,
    },
    options: { timeframe: parsed.timeframe },
  }
}

function errorCategory(error: unknown): string {
  if (error instanceof TriggerDiscoveryInputError || error instanceof SavedTriggerValidationError) return 'invalid_input'
  if (error instanceof SavedTriggerNotFoundError) return 'definition_not_found'
  const name = error instanceof Error ? error.name : ''
  if (/timeout/i.test(name) || /timeout/i.test(error instanceof Error ? error.message : '')) return 'timeout'
  if (/SQLITE_BUSY|database is locked/i.test(error instanceof Error ? error.message : '')) return 'database_busy'
  return 'evaluation_failed'
}

async function evaluationByRunSignature(signature: string): Promise<EvaluationRow | undefined> {
  return execGet<EvaluationRow>(`SELECT ${EVALUATION_COLUMNS} FROM trigger_evaluations WHERE run_signature=?`, [signature])
}

async function evaluationById(id: string): Promise<EvaluationRow> {
  if (!UUID_PATTERN.test(id)) throw new SavedTriggerValidationError('evaluationId must be a UUID')
  const row = await execGet<EvaluationRow>(`SELECT ${EVALUATION_COLUMNS} FROM trigger_evaluations WHERE id=?`, [id])
  if (!row) throw new TriggerEvaluationNotFoundError()
  return row
}

function memberArgs(evaluationId: string, row: TriggerDiscoveryRow): InValue[] {
  return [
    evaluationId, row.ticker, row.companyName, row.market, row.triggerStatus,
    row.price, row.ma1Value, row.ma2Value, row.zoneUpper, row.zoneLower,
    row.zoneDistancePct, row.ma1DistancePct, row.ma2DistancePct,
    row.approachVelocityPctPointsPerSession, row.averageVolume, row.averageTradingValue,
    row.dayAStage, row.dayBStage, row.weekAStage, row.weekBStage, row.monthAStage, row.monthBStage,
    row.stageAvailable ? 1 : 0, row.stageComplete ? 1 : 0, row.triggerScore,
    JSON.stringify(row.scoreBreakdown), row.priceDate, row.maDate, row.stageDate,
    row.priceFreshness, row.priceStalenessSessions, row.liquidityLookbackSessions,
    row.liquidityObservationCount,
    row.liquidityComplete ? 1 : 0, row.ma1Period, row.ma2Period, row.ma1Trend, row.ma2Trend,
    row.ma1SlopePct, row.ma2SlopePct, row.bothRising ? 1 : 0, row.fromAbove ? 1 : 0,
    row.approachDirection, row.maPath,
  ]
}

function nullableBoolean(value: boolean | null): number | null {
  return value == null ? null : value ? 1 : 0
}

function observationArgs(evaluationId: string, row: TriggerDiscoveryObservation): InValue[] {
  return [
    evaluationId, row.ticker, row.disposition, row.exclusionReason, row.triggerStatus,
    row.pricePosition, nullableBoolean(row.bothRising), nullableBoolean(row.fromAbove),
    row.approachDirection, row.zoneUpper, row.zoneLower, row.zoneDistancePct, row.price,
    row.triggerScore, row.priceDate, row.maDate, row.stageDate,
    row.universeFilterPassed ? 1 : 0, nullableBoolean(row.priceFilterPassed),
    nullableBoolean(row.liquidityFilterPassed), nullableBoolean(row.stageFilterPassed),
    row.dataAvailable ? 1 : 0,
  ]
}

async function persistCompletedEvaluation(input: {
  evaluationId: string
  result: TriggerDiscoveryResult
  totalStartedAt: number
  discoveryMs: number
  snapshotTransformMs: number
}): Promise<void> {
  await ensureReady()
  const persistenceStartedAt = performance.now()
  const tx = await client.transaction('write')
  try {
    await tx.execute({
      sql: "DELETE FROM trigger_evaluation_members WHERE evaluation_id=? AND EXISTS (SELECT 1 FROM trigger_evaluations WHERE id=? AND status='RUNNING')",
      args: [input.evaluationId, input.evaluationId],
    })
    await tx.execute({
      sql: "DELETE FROM trigger_evaluation_observations WHERE evaluation_id=? AND EXISTS (SELECT 1 FROM trigger_evaluations WHERE id=? AND status='RUNNING')",
      args: [input.evaluationId, input.evaluationId],
    })
    const columns = `evaluation_id, ticker, company_name, market, trigger_status,
      price, ma1_value, ma2_value, zone_upper, zone_lower, zone_distance_pct,
      ma1_distance_pct, ma2_distance_pct, approach_velocity, average_volume,
      average_trading_value, day_a_stage, day_b_stage, week_a_stage, week_b_stage,
      month_a_stage, month_b_stage, stage_available, stage_complete, trigger_score,
      score_breakdown_json, price_date, ma_date, stage_date, price_freshness,
      price_staleness_sessions, liquidity_lookback_sessions, liquidity_observation_count, liquidity_complete,
      ma1_period, ma2_period, ma1_trend, ma2_trend, ma1_slope_pct, ma2_slope_pct,
      both_rising, from_above, approach_direction, ma_path`
    for (let offset = 0; offset < input.result.rows.length; offset += MEMBER_WRITE_CHUNK) {
      const chunk = input.result.rows.slice(offset, offset + MEMBER_WRITE_CHUNK)
      const placeholders = chunk.map(() => `(${Array(44).fill('?').join(',')})`).join(',')
      await tx.execute({
        sql: `INSERT INTO trigger_evaluation_members (${columns}) VALUES ${placeholders}`,
        args: chunk.flatMap((row) => memberArgs(input.evaluationId, row)),
      })
    }
    const observationColumns = `evaluation_id, ticker, disposition, exclusion_reason,
      trigger_status, price_position, both_rising, from_above, approach_direction,
      zone_upper, zone_lower, zone_distance_pct, price, trigger_score, price_date,
      ma_date, stage_date, universe_filter_passed, price_filter_passed,
      liquidity_filter_passed, stage_filter_passed, data_available`
    const lifecycleObservations = input.result.observations ?? []
    for (let offset = 0; offset < lifecycleObservations.length; offset += MEMBER_WRITE_CHUNK) {
      const chunk = lifecycleObservations.slice(offset, offset + MEMBER_WRITE_CHUNK)
      const placeholders = chunk.map(() => `(${Array(22).fill('?').join(',')})`).join(',')
      await tx.execute({
        sql: `INSERT INTO trigger_evaluation_observations (${observationColumns}) VALUES ${placeholders}`,
        args: chunk.flatMap((row) => observationArgs(input.evaluationId, row)),
      })
    }
    const persistenceMs = Math.round((performance.now() - persistenceStartedAt) * 1000) / 1000
    const durationMs = Math.round((performance.now() - input.totalStartedAt) * 1000) / 1000
    const counts = input.result.diagnostics.counts
    await tx.execute({
      sql: `UPDATE trigger_evaluations SET
        completed_at=unixepoch(), status='COMPLETED', pit_universe_count=?,
        current_price_count=?, stale_accepted_count=?, trigger_evaluated_count=?,
        trigger_matched_count=?, final_matched_count=?, duration_ms=?,
        discovery_duration_ms=?, snapshot_transform_ms=?, persistence_duration_ms=?,
        discovery_query_count=?, discovery_db_query_ms=?, error_category=NULL
        WHERE id=? AND status='RUNNING'`,
      args: [
        counts.universe, counts.currentPrice, counts.staleAccepted, counts.evaluated,
        input.result.totalTriggerMatched, input.result.totalMatched, durationMs,
        input.discoveryMs, input.snapshotTransformMs, persistenceMs,
        input.result.diagnostics.performance.queryCount,
        input.result.diagnostics.performance.dbQueryMs,
        input.evaluationId,
      ],
    })
    await tx.commit()
  } catch (error) {
    await tx.rollback().catch(() => undefined)
    throw error
  } finally {
    tx.close()
  }
}

export async function evaluateSavedTriggerDefinition(
  definitionId: string,
  requestedAsOf: string,
  dependencies: TriggerEvaluationDependencies = {},
): Promise<TriggerEvaluationRunResponse> {
  const totalStartedAt = performance.now()
  const definition = await getSavedTriggerDefinition(definitionId)
  if (!matchesExpectedDefinitionIdentity(definition, dependencies.expectedDefinitionIdentity)) {
    throw new TriggerEvaluationDefinitionChangedError()
  }
  const discovery = discoveryInput(definition, requestedAsOf)
  const resolvedAsOf = await (dependencies.resolveAsOf ?? defaultResolveAsOf)(requestedAsOf)
  if (!resolvedAsOf) throw new TriggerDiscoveryInputError('requestedAsOf has no available market session')
  const signature = runSignature(definition, resolvedAsOf)
  const existing = await evaluationByRunSignature(signature)
  if (existing?.status === 'COMPLETED') {
    return {
      contractVersion: TRIGGER_EVALUATION_CONTRACT_VERSION,
      evaluation: summary(existing),
      reused: true,
      lifecycle: await deriveAndPersistTriggerLifecycle(existing.id),
    }
  }
  if (existing?.status === 'RUNNING') throw new TriggerEvaluationInProgressError()

  const evaluationId = existing?.id ?? randomUUID()
  const nowSeconds = Math.floor((dependencies.now?.() ?? Date.now()) / 1000)
  if (existing?.status === 'FAILED') {
    await execRun(`UPDATE trigger_evaluations SET
      status='RUNNING', started_at=?, completed_at=NULL, duration_ms=0,
      discovery_duration_ms=0, snapshot_transform_ms=0, persistence_duration_ms=0,
      error_category=NULL, attempt_count=attempt_count+1
      WHERE id=? AND status='FAILED'`, [nowSeconds, evaluationId])
  } else {
    await execRun(`INSERT OR IGNORE INTO trigger_evaluations (
      id, definition_id, evaluation_version, engine_version, score_version,
      run_signature, evaluation_config_signature, evaluation_config_snapshot_json,
      requested_as_of, resolved_as_of, started_at, status, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'RUNNING', ?)`, [
      evaluationId, definition.id, definition.evaluationVersion, definition.engineVersion,
      definition.scoreVersion, signature, definition.evaluationSignature,
      JSON.stringify(definition.evaluationConfig), requestedAsOf, resolvedAsOf,
      nowSeconds, nowSeconds,
    ])
    const claimed = await evaluationByRunSignature(signature)
    if (!claimed) throw new Error('evaluation_claim_failed')
    if (claimed.id !== evaluationId) {
      if (claimed.status === 'COMPLETED') {
        return {
          contractVersion: TRIGGER_EVALUATION_CONTRACT_VERSION,
          evaluation: summary(claimed),
          reused: true,
          lifecycle: await deriveAndPersistTriggerLifecycle(claimed.id),
        }
      }
      throw new TriggerEvaluationInProgressError()
    }
  }

  try {
    const previous = await getPreviousEvaluationMemberTickers({
      definitionId: definition.id,
      evaluationVersion: definition.evaluationVersion,
      engineVersion: definition.engineVersion,
      scoreVersion: definition.scoreVersion,
      evaluationConfigSignature: definition.evaluationSignature,
      resolvedAsOf,
    })
    discovery.input.observeTickers = previous.tickers
    const discoveryStartedAt = performance.now()
    const result = await (dependencies.discover ?? getTriggerDiscovery)(discovery.input, discovery.options)
    const discoveryMs = Math.round((performance.now() - discoveryStartedAt) * 1000) / 1000
    if (result.resolvedAsOf !== resolvedAsOf) {
      throw new Error('resolved_as_of_changed_during_evaluation')
    }
    if (result.hasMore || result.rows.length !== result.totalMatched) {
      throw new Error('evaluation_candidate_limit_exceeded')
    }
    const transformStartedAt = performance.now()
    // Serialization is deliberately completed before opening the write transaction.
    for (const row of result.rows) JSON.stringify(row.scoreBreakdown)
    const snapshotTransformMs = Math.round((performance.now() - transformStartedAt) * 1000) / 1000
    await persistCompletedEvaluation({
      evaluationId,
      result,
      totalStartedAt,
      discoveryMs,
      snapshotTransformMs,
    })
    const completed = await evaluationById(evaluationId)
    return {
      contractVersion: TRIGGER_EVALUATION_CONTRACT_VERSION,
      evaluation: summary(completed),
      reused: false,
      lifecycle: await deriveAndPersistTriggerLifecycle(completed.id),
    }
  } catch (error) {
    await execRun(`UPDATE trigger_evaluations SET
      completed_at=unixepoch(), status='FAILED', duration_ms=?, error_category=?
      WHERE id=? AND status='RUNNING'`, [
      Math.round((performance.now() - totalStartedAt) * 1000) / 1000,
      errorCategory(error),
      evaluationId,
    ]).catch(() => undefined)
    throw error
  }
}

export async function listSavedTriggerEvaluations(definitionId: string): Promise<TriggerEvaluationSummary[]> {
  await getSavedTriggerDefinitionForHistory(definitionId)
  const rows = await execAll<EvaluationRow>(`
    SELECT ${EVALUATION_COLUMNS}
    FROM trigger_evaluations
    WHERE definition_id=?
    ORDER BY resolved_as_of DESC, created_at DESC
    LIMIT 250
  `, [definitionId])
  return rows.map(summary)
}

export async function getTriggerEvaluationDetail(input: {
  evaluationId: string
  limit?: number
  offset?: number
}): Promise<TriggerEvaluationDetailResponse> {
  const evaluation = await evaluationById(input.evaluationId)
  const limit = input.limit ?? 100
  const offset = input.offset ?? 0
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
    throw new SavedTriggerValidationError('limit must be an integer between 1 and 500')
  }
  if (!Number.isInteger(offset) || offset < 0) {
    throw new SavedTriggerValidationError('offset must be a non-negative integer')
  }
  const rows = await execAll<MemberRow>(`
    SELECT * FROM trigger_evaluation_members
    WHERE evaluation_id=?
    ORDER BY ticker
    LIMIT ? OFFSET ?
  `, [input.evaluationId, limit, offset])
  const count = await execGet<{ count: number }>(
    'SELECT COUNT(*) AS count FROM trigger_evaluation_members WHERE evaluation_id=?',
    [input.evaluationId],
  )
  const totalMembers = Number(count?.count ?? 0)
  return {
    contractVersion: TRIGGER_EVALUATION_CONTRACT_VERSION,
    evaluation: summary(evaluation),
    members: rows.map(member),
    totalMembers,
    limit,
    offset,
    hasMore: offset + rows.length < totalMembers,
  }
}
