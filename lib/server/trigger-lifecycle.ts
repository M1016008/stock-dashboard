import { createHash } from 'node:crypto'
import type { InValue } from '@libsql/client'
import { client, ensureReady, execAll, execGet } from '@/lib/db/client'
import type { TriggerDiscoveryObservation } from '@/lib/server/trigger-discovery-read-model'
import type { TriggerStatus, TriggerPricePosition } from '@/lib/trigger-discovery-engine'
import {
  TRIGGER_LIFECYCLE_CONTRACT_VERSION,
  deriveTriggerLifecycleEvents,
  type TriggerLifecycleEvent,
  type TriggerLifecycleEventDraft,
  type TriggerLifecycleEventType,
  type TriggerLifecycleEventsResponse,
  type TriggerLifecycleMemberSnapshot,
  type TriggerLifecycleSummary,
} from '@/lib/trigger-lifecycle'

const WRITE_CHUNK = 40
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export class TriggerLifecycleEvaluationNotFoundError extends Error {
  constructor() {
    super('Trigger評価が見つかりません。')
    this.name = 'TriggerLifecycleEvaluationNotFoundError'
  }
}

type EvaluationContextRow = {
  id: string
  definition_id: string
  evaluation_version: number
  engine_version: number
  score_version: number
  evaluation_config_signature: string
  resolved_as_of: string
  status: string
}

type MemberRow = {
  ticker: string
  trigger_status: TriggerStatus
  trigger_score: number
  price: number
}

type ObservationRow = {
  ticker: string
  disposition: TriggerDiscoveryObservation['disposition']
  exclusion_reason: TriggerDiscoveryObservation['exclusionReason']
  trigger_status: TriggerStatus | null
  price_position: TriggerPricePosition | null
  both_rising: number | null
  from_above: number | null
  approach_direction: TriggerDiscoveryObservation['approachDirection']
  zone_upper: number | null
  zone_lower: number | null
  zone_distance_pct: number | null
  price: number | null
  trigger_score: number | null
  price_date: string | null
  ma_date: string | null
  stage_date: string | null
  universe_filter_passed: number
  price_filter_passed: number | null
  liquidity_filter_passed: number | null
  stage_filter_passed: number | null
  data_available: number
}

type HistoryEvidenceRow = { ticker: string; reached_in_zone: number }

type EventRow = {
  id: string
  definition_id: string
  evaluation_version: number
  previous_evaluation_id: string | null
  current_evaluation_id: string
  ticker: string
  event_type: TriggerLifecycleEventType
  previous_trigger_status: TriggerStatus | null
  current_trigger_status: TriggerStatus | null
  exit_reason: string | null
  previous_score: number | null
  current_score: number | null
  previous_price: number | null
  current_price: number | null
  current_price_position: TriggerPricePosition | null
  current_zone_upper: number | null
  current_zone_lower: number | null
  current_zone_distance_pct: number | null
  resolved_as_of: string
  created_at: number
}

function isoDateTime(epochSeconds: number): string {
  return new Date(Number(epochSeconds) * 1000).toISOString()
}

function member(row: MemberRow): TriggerLifecycleMemberSnapshot {
  return {
    ticker: row.ticker,
    triggerStatus: row.trigger_status,
    triggerScore: Number(row.trigger_score),
    price: Number(row.price),
  }
}

function nullableBoolean(value: number | null): boolean | null {
  return value == null ? null : Boolean(value)
}

function observation(row: ObservationRow): TriggerDiscoveryObservation {
  return {
    ticker: row.ticker,
    disposition: row.disposition,
    exclusionReason: row.exclusion_reason,
    triggerStatus: row.trigger_status,
    pricePosition: row.price_position,
    bothRising: nullableBoolean(row.both_rising),
    fromAbove: nullableBoolean(row.from_above),
    approachDirection: row.approach_direction,
    zoneUpper: row.zone_upper == null ? null : Number(row.zone_upper),
    zoneLower: row.zone_lower == null ? null : Number(row.zone_lower),
    zoneDistancePct: row.zone_distance_pct == null ? null : Number(row.zone_distance_pct),
    price: row.price == null ? null : Number(row.price),
    triggerScore: row.trigger_score == null ? null : Number(row.trigger_score),
    priceDate: row.price_date,
    maDate: row.ma_date,
    stageDate: row.stage_date,
    universeFilterPassed: Boolean(row.universe_filter_passed),
    priceFilterPassed: nullableBoolean(row.price_filter_passed),
    liquidityFilterPassed: nullableBoolean(row.liquidity_filter_passed),
    stageFilterPassed: nullableBoolean(row.stage_filter_passed),
    dataAvailable: Boolean(row.data_available),
  }
}

function event(row: EventRow): TriggerLifecycleEvent {
  return {
    id: row.id,
    definitionId: row.definition_id,
    evaluationVersion: Number(row.evaluation_version),
    previousEvaluationId: row.previous_evaluation_id,
    currentEvaluationId: row.current_evaluation_id,
    ticker: row.ticker,
    eventType: row.event_type,
    previousTriggerStatus: row.previous_trigger_status,
    currentTriggerStatus: row.current_trigger_status,
    exitReason: row.exit_reason,
    previousScore: row.previous_score == null ? null : Number(row.previous_score),
    currentScore: row.current_score == null ? null : Number(row.current_score),
    previousPrice: row.previous_price == null ? null : Number(row.previous_price),
    currentPrice: row.current_price == null ? null : Number(row.current_price),
    currentPricePosition: row.current_price_position,
    currentZoneUpper: row.current_zone_upper == null ? null : Number(row.current_zone_upper),
    currentZoneLower: row.current_zone_lower == null ? null : Number(row.current_zone_lower),
    currentZoneDistancePct: row.current_zone_distance_pct == null ? null : Number(row.current_zone_distance_pct),
    resolvedAsOf: row.resolved_as_of,
    createdAt: isoDateTime(row.created_at),
  }
}

async function evaluationContext(evaluationId: string): Promise<EvaluationContextRow> {
  if (!UUID_PATTERN.test(evaluationId)) throw new TriggerLifecycleEvaluationNotFoundError()
  const row = await execGet<EvaluationContextRow>(`
    SELECT id, definition_id, evaluation_version, engine_version, score_version,
           evaluation_config_signature, resolved_as_of, status
    FROM trigger_evaluations WHERE id=?
  `, [evaluationId])
  if (!row) throw new TriggerLifecycleEvaluationNotFoundError()
  if (row.status !== 'COMPLETED') throw new Error('lifecycle_requires_completed_evaluation')
  return row
}

async function previousEvaluation(current: EvaluationContextRow): Promise<EvaluationContextRow | undefined> {
  return execGet<EvaluationContextRow>(`
    SELECT id, definition_id, evaluation_version, engine_version, score_version,
           evaluation_config_signature, resolved_as_of, status
    FROM trigger_evaluations
    WHERE definition_id=? AND evaluation_version=? AND engine_version=? AND score_version=?
      AND evaluation_config_signature=? AND status='COMPLETED' AND resolved_as_of < ?
    ORDER BY resolved_as_of DESC, completed_at DESC, created_at DESC
    LIMIT 1
  `, [
    current.definition_id, current.evaluation_version, current.engine_version,
    current.score_version, current.evaluation_config_signature, current.resolved_as_of,
  ])
}

export async function getPreviousEvaluationMemberTickers(input: {
  definitionId: string
  evaluationVersion: number
  engineVersion: number
  scoreVersion: number
  evaluationConfigSignature: string
  resolvedAsOf: string
}): Promise<{ previousEvaluationId: string | null; tickers: string[] }> {
  await ensureReady()
  const previous = await execGet<{ id: string }>(`
    SELECT id FROM trigger_evaluations
    WHERE definition_id=? AND evaluation_version=? AND engine_version=? AND score_version=?
      AND evaluation_config_signature=? AND status='COMPLETED' AND resolved_as_of < ?
    ORDER BY resolved_as_of DESC, completed_at DESC, created_at DESC LIMIT 1
  `, [input.definitionId, input.evaluationVersion, input.engineVersion, input.scoreVersion,
    input.evaluationConfigSignature, input.resolvedAsOf])
  if (!previous) return { previousEvaluationId: null, tickers: [] }
  const rows = await execAll<{ ticker: string }>(
    'SELECT ticker FROM trigger_evaluation_members WHERE evaluation_id=? ORDER BY ticker',
    [previous.id],
  )
  return { previousEvaluationId: previous.id, tickers: rows.map((row) => row.ticker) }
}

function eventId(currentEvaluationId: string, draft: TriggerLifecycleEventDraft): string {
  return createHash('sha256')
    .update(`${currentEvaluationId}\u001f${draft.ticker}\u001f${draft.eventType}`)
    .digest('hex')
}

function eventArgs(
  context: EvaluationContextRow,
  previousEvaluationId: string,
  draft: TriggerLifecycleEventDraft,
  createdAt: number | null,
): InValue[] {
  return [
    eventId(context.id, draft), context.definition_id, context.evaluation_version,
    previousEvaluationId, context.id, draft.ticker, draft.eventType,
    draft.previousTriggerStatus, draft.currentTriggerStatus, draft.exitReason,
    draft.previousScore, draft.currentScore, draft.previousPrice, draft.currentPrice,
    draft.currentPricePosition, draft.currentZoneUpper, draft.currentZoneLower,
    draft.currentZoneDistancePct, context.resolved_as_of, createdAt ?? Math.floor(Date.now() / 1000),
  ]
}

function summarize(
  currentEvaluationId: string,
  previousEvaluationId: string | null,
  events: ReadonlyArray<Pick<TriggerLifecycleEventDraft, 'eventType'>>,
): TriggerLifecycleSummary {
  const eventCounts: TriggerLifecycleSummary['eventCounts'] = {}
  for (const row of events) eventCounts[row.eventType] = (eventCounts[row.eventType] ?? 0) + 1
  return {
    baseline: previousEvaluationId == null,
    previousEvaluationId,
    currentEvaluationId,
    eventCount: events.length,
    eventCounts,
  }
}

export async function deriveAndPersistTriggerLifecycle(evaluationId: string): Promise<TriggerLifecycleSummary> {
  await ensureReady()
  const current = await evaluationContext(evaluationId)
  const previous = await previousEvaluation(current)
  if (!previous) {
    const tx = await client.transaction('write')
    try {
      await tx.execute({ sql: 'DELETE FROM trigger_lifecycle_events WHERE current_evaluation_id=?', args: [current.id] })
      await tx.commit()
    } catch (error) {
      await tx.rollback().catch(() => undefined)
      throw error
    } finally {
      tx.close()
    }
    return summarize(current.id, null, [])
  }

  const [previousRows, currentRows, observationRows, historyRows] = await Promise.all([
    execAll<MemberRow>('SELECT ticker, trigger_status, trigger_score, price FROM trigger_evaluation_members WHERE evaluation_id=?', [previous.id]),
    execAll<MemberRow>('SELECT ticker, trigger_status, trigger_score, price FROM trigger_evaluation_members WHERE evaluation_id=?', [current.id]),
    execAll<ObservationRow>('SELECT * FROM trigger_evaluation_observations WHERE evaluation_id=?', [current.id]),
    execAll<HistoryEvidenceRow>(`
      SELECT members.ticker,
             MAX(CASE WHEN members.trigger_status='IN_ZONE' THEN 1 ELSE 0 END) AS reached_in_zone
      FROM trigger_evaluations AS evaluations
      INNER JOIN trigger_evaluation_members AS members ON members.evaluation_id=evaluations.id
      WHERE evaluations.definition_id=? AND evaluations.evaluation_version=?
        AND evaluations.engine_version=? AND evaluations.score_version=?
        AND evaluations.evaluation_config_signature=? AND evaluations.status='COMPLETED'
        AND evaluations.resolved_as_of < ?
      GROUP BY members.ticker
    `, [current.definition_id, current.evaluation_version, current.engine_version,
      current.score_version, current.evaluation_config_signature, current.resolved_as_of]),
  ])
  const priorMemberTickers = new Set(historyRows.map((row) => row.ticker))
  const priorInZoneTickers = new Set(historyRows.filter((row) => Boolean(row.reached_in_zone)).map((row) => row.ticker))
  const drafts = deriveTriggerLifecycleEvents({
    previousMembers: previousRows.map(member),
    currentMembers: currentRows.map(member),
    currentObservations: observationRows.map(observation),
    priorMemberTickers,
    priorInZoneTickers,
  })
  const existingRows = await execAll<{ id: string; created_at: number }>(
    'SELECT id, created_at FROM trigger_lifecycle_events WHERE current_evaluation_id=?',
    [current.id],
  )
  const existingCreatedAt = new Map(existingRows.map((row) => [row.id, Number(row.created_at)]))
  const tx = await client.transaction('write')
  try {
    await tx.execute({ sql: 'DELETE FROM trigger_lifecycle_events WHERE current_evaluation_id=?', args: [current.id] })
    const columns = `id, definition_id, evaluation_version, previous_evaluation_id,
      current_evaluation_id, ticker, event_type, previous_trigger_status,
      current_trigger_status, exit_reason, previous_score, current_score,
      previous_price, current_price, current_price_position, current_zone_upper,
      current_zone_lower, current_zone_distance_pct, resolved_as_of, created_at`
    for (let offset = 0; offset < drafts.length; offset += WRITE_CHUNK) {
      const chunk = drafts.slice(offset, offset + WRITE_CHUNK)
      const placeholders = chunk.map(() => `(${Array(20).fill('?').join(',')})`).join(',')
      await tx.execute({
        sql: `INSERT OR IGNORE INTO trigger_lifecycle_events (${columns}) VALUES ${placeholders}`,
        args: chunk.flatMap((row) => eventArgs(
          current,
          previous.id,
          row,
          existingCreatedAt.get(eventId(current.id, row)) ?? null,
        )),
      })
    }
    await tx.commit()
  } catch (error) {
    await tx.rollback().catch(() => undefined)
    throw error
  } finally {
    tx.close()
  }
  return summarize(current.id, previous.id, drafts)
}

export async function getTriggerLifecycleEvents(evaluationId: string): Promise<TriggerLifecycleEventsResponse> {
  await ensureReady()
  const current = await evaluationContext(evaluationId)
  const previous = await previousEvaluation(current)
  const rows = await execAll<EventRow>(`
    SELECT * FROM trigger_lifecycle_events
    WHERE current_evaluation_id=? ORDER BY ticker, event_type
  `, [evaluationId])
  const events = rows.map(event)
  return {
    contractVersion: TRIGGER_LIFECYCLE_CONTRACT_VERSION,
    ...summarize(current.id, previous?.id ?? null, events),
    events,
  }
}
