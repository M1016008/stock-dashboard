import type { TriggerDiscoveryObservation } from '@/lib/server/trigger-discovery-read-model'
import type { TriggerStatus, TriggerPricePosition } from '@/lib/trigger-discovery-engine'

export const TRIGGER_LIFECYCLE_CONTRACT_VERSION = 'trigger-lifecycle-v1' as const

export type TriggerLifecycleEventType =
  | 'NEW'
  | 'RE_ENTRY'
  | 'STATUS_CHANGED'
  | 'REBOUNDED'
  | 'BROKE_BELOW_ZONE'
  | 'CORE_CONDITION_EXIT'
  | 'STAGE_FILTER_EXIT'
  | 'UNIVERSE_FILTER_EXIT'
  | 'DATA_UNAVAILABLE'
  | 'EXITED'

export interface TriggerLifecycleMemberSnapshot {
  ticker: string
  triggerStatus: TriggerStatus
  triggerScore: number
  price: number
}

export interface TriggerLifecycleEventDraft {
  ticker: string
  eventType: TriggerLifecycleEventType
  previousTriggerStatus: TriggerStatus | null
  currentTriggerStatus: TriggerStatus | null
  exitReason: string | null
  previousScore: number | null
  currentScore: number | null
  previousPrice: number | null
  currentPrice: number | null
  currentPricePosition: TriggerPricePosition | null
  currentZoneUpper: number | null
  currentZoneLower: number | null
  currentZoneDistancePct: number | null
}

export interface TriggerLifecycleEvent extends TriggerLifecycleEventDraft {
  id: string
  definitionId: string
  evaluationVersion: number
  previousEvaluationId: string | null
  currentEvaluationId: string
  resolvedAsOf: string
  createdAt: string
}

export interface TriggerLifecycleSummary {
  baseline: boolean
  previousEvaluationId: string | null
  currentEvaluationId: string
  eventCount: number
  eventCounts: Partial<Record<TriggerLifecycleEventType, number>>
}

export interface TriggerLifecycleEventsResponse extends TriggerLifecycleSummary {
  contractVersion: typeof TRIGGER_LIFECYCLE_CONTRACT_VERSION
  events: TriggerLifecycleEvent[]
}

export interface DeriveTriggerLifecycleInput {
  previousMembers: TriggerLifecycleMemberSnapshot[] | null
  currentMembers: TriggerLifecycleMemberSnapshot[]
  currentObservations: TriggerDiscoveryObservation[]
  priorMemberTickers: ReadonlySet<string>
  priorInZoneTickers: ReadonlySet<string>
}

function draft(
  eventType: TriggerLifecycleEventType,
  previous: TriggerLifecycleMemberSnapshot | null,
  current: TriggerLifecycleMemberSnapshot | null,
  observation: TriggerDiscoveryObservation | null,
  exitReason: string | null = null,
): TriggerLifecycleEventDraft {
  return {
    ticker: current?.ticker ?? previous?.ticker ?? observation!.ticker,
    eventType,
    previousTriggerStatus: previous?.triggerStatus ?? null,
    currentTriggerStatus: current?.triggerStatus ?? observation?.triggerStatus ?? null,
    exitReason,
    previousScore: previous?.triggerScore ?? null,
    currentScore: current?.triggerScore ?? observation?.triggerScore ?? null,
    previousPrice: previous?.price ?? null,
    currentPrice: current?.price ?? observation?.price ?? null,
    currentPricePosition: observation?.pricePosition ?? null,
    currentZoneUpper: observation?.zoneUpper ?? null,
    currentZoneLower: observation?.zoneLower ?? null,
    currentZoneDistancePct: observation?.zoneDistancePct ?? null,
  }
}

function pricePosition(member: TriggerLifecycleMemberSnapshot): TriggerPricePosition {
  return member.triggerStatus === 'IN_ZONE' ? 'IN_ZONE' : 'ABOVE_ZONE'
}

/** Pure, DB-independent comparison. Snapshots remain immutable; only changes emit events. */
export function deriveTriggerLifecycleEvents(input: DeriveTriggerLifecycleInput): TriggerLifecycleEventDraft[] {
  if (input.previousMembers == null) return []
  const previous = new Map(input.previousMembers.map((row) => [row.ticker, row]))
  const current = new Map(input.currentMembers.map((row) => [row.ticker, row]))
  const observations = new Map(input.currentObservations.map((row) => [row.ticker, row]))
  const events: TriggerLifecycleEventDraft[] = []

  for (const row of input.currentMembers) {
    const before = previous.get(row.ticker)
    if (!before) {
      events.push(draft(input.priorMemberTickers.has(row.ticker) ? 'RE_ENTRY' : 'NEW', null, row, null))
      continue
    }
    const observation = observations.get(row.ticker) ?? {
      ticker: row.ticker,
      pricePosition: pricePosition(row),
    } as TriggerDiscoveryObservation
    if (input.priorInZoneTickers.has(row.ticker)
      && observation.pricePosition === 'ABOVE_ZONE'
      && observation.bothRising !== false
      && observation.fromAbove !== false
      && before.triggerStatus === 'IN_ZONE') {
      events.push(draft('REBOUNDED', before, row, observation))
    } else if (before.triggerStatus !== row.triggerStatus) {
      events.push(draft('STATUS_CHANGED', before, row, observation))
    }
  }

  for (const before of input.previousMembers) {
    if (current.has(before.ticker)) continue
    const observation = observations.get(before.ticker)
    if (!observation || observation.disposition === 'DATA_UNAVAILABLE') {
      events.push(draft('DATA_UNAVAILABLE', before, null, observation ?? null, observation?.exclusionReason ?? 'OBSERVATION_MISSING'))
      continue
    }
    if (observation.disposition === 'STAGE_FILTER_EXIT') {
      events.push(draft('STAGE_FILTER_EXIT', before, null, observation, observation.exclusionReason))
      continue
    }
    if (observation.disposition === 'UNIVERSE_FILTER_EXIT') {
      events.push(draft('UNIVERSE_FILTER_EXIT', before, null, observation, observation.exclusionReason))
      continue
    }
    if (observation.disposition === 'CORE_CONDITION_EXIT') {
      const reason = observation.bothRising === false ? 'MA_NOT_BOTH_RISING' : 'NOT_FROM_ABOVE'
      events.push(draft('CORE_CONDITION_EXIT', before, null, observation, reason))
      continue
    }
    if ((before.triggerStatus === 'NEAR' || before.triggerStatus === 'IN_ZONE')
      && observation.pricePosition === 'BELOW_ZONE') {
      events.push(draft('BROKE_BELOW_ZONE', before, null, observation, 'BELOW_ZONE'))
      continue
    }
    if (input.priorInZoneTickers.has(before.ticker)
      && observation.pricePosition === 'ABOVE_ZONE'
      && observation.bothRising === true
      && observation.fromAbove === true) {
      events.push(draft('REBOUNDED', before, null, observation))
      continue
    }
    events.push(draft('EXITED', before, null, observation, observation.exclusionReason))
  }

  return events.sort((left, right) => left.ticker.localeCompare(right.ticker)
    || left.eventType.localeCompare(right.eventType))
}
