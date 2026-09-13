import assert from 'node:assert/strict'
import type { TriggerDiscoveryObservation } from '@/lib/server/trigger-discovery-read-model'
import {
  deriveTriggerLifecycleEvents,
  type TriggerLifecycleMemberSnapshot,
} from '@/lib/trigger-lifecycle'

function member(ticker: string, triggerStatus: TriggerLifecycleMemberSnapshot['triggerStatus'], score = 80): TriggerLifecycleMemberSnapshot {
  return { ticker, triggerStatus, triggerScore: score, price: 100 }
}

function observation(
  ticker: string,
  overrides: Partial<TriggerDiscoveryObservation> = {},
): TriggerDiscoveryObservation {
  return {
    ticker,
    disposition: 'FINAL_CANDIDATE',
    exclusionReason: null,
    triggerStatus: 'NEAR',
    pricePosition: 'ABOVE_ZONE',
    bothRising: true,
    fromAbove: true,
    approachDirection: 'TOWARD_ZONE',
    zoneUpper: 99,
    zoneLower: 98,
    zoneDistancePct: 1.01,
    price: 100,
    triggerScore: 80,
    priceDate: '2026-09-10',
    maDate: '2026-09-10',
    stageDate: '2026-09-10',
    universeFilterPassed: true,
    priceFilterPassed: true,
    liquidityFilterPassed: true,
    stageFilterPassed: true,
    dataAvailable: true,
    ...overrides,
  }
}

function derive(input: {
  previous: TriggerLifecycleMemberSnapshot[] | null
  current?: TriggerLifecycleMemberSnapshot[]
  observations?: TriggerDiscoveryObservation[]
  prior?: string[]
  inZone?: string[]
}) {
  return deriveTriggerLifecycleEvents({
    previousMembers: input.previous,
    currentMembers: input.current ?? [],
    currentObservations: input.observations ?? [],
    priorMemberTickers: new Set(input.prior ?? input.previous?.map((row) => row.ticker) ?? []),
    priorInZoneTickers: new Set(input.inZone ?? []),
  })
}

assert.deepEqual(derive({ previous: null, current: [member('A', 'NEAR')] }), [], 'baseline emits no events')

for (const [from, to] of [['APPROACHING', 'NEAR'], ['NEAR', 'IN_ZONE']] as const) {
  const events = derive({
    previous: [member('A', from)],
    current: [member('A', to, 84)],
    observations: [observation('A', { triggerStatus: to, pricePosition: to === 'IN_ZONE' ? 'IN_ZONE' : 'ABOVE_ZONE' })],
  })
  assert.equal(events[0]?.eventType, 'STATUS_CHANGED')
  assert.equal(events[0]?.previousTriggerStatus, from)
  assert.equal(events[0]?.currentTriggerStatus, to)
}

assert.equal(derive({
  previous: [member('A', 'IN_ZONE')], current: [member('A', 'NEAR')], inZone: ['A'],
  observations: [observation('A', { triggerStatus: 'NEAR', pricePosition: 'ABOVE_ZONE' })],
})[0]?.eventType, 'REBOUNDED')

assert.equal(derive({
  previous: [member('A', 'IN_ZONE')], inZone: ['A'],
  observations: [observation('A', { disposition: 'TRIGGER_EXIT', triggerStatus: 'BELOW_ZONE', pricePosition: 'BELOW_ZONE', exclusionReason: 'TOO_FAR' })],
})[0]?.eventType, 'BROKE_BELOW_ZONE')

assert.equal(derive({
  previous: [member('A', 'NEAR')],
  observations: [observation('A', { disposition: 'CORE_CONDITION_EXIT', triggerStatus: 'NOT_MATCHED', bothRising: false, exclusionReason: 'MA_NOT_BOTH_RISING' })],
})[0]?.eventType, 'CORE_CONDITION_EXIT')

assert.equal(derive({
  previous: [member('A', 'NEAR')],
  observations: [observation('A', { disposition: 'STAGE_FILTER_EXIT', stageFilterPassed: false, exclusionReason: 'STAGE_FILTER' })],
})[0]?.eventType, 'STAGE_FILTER_EXIT')

assert.equal(derive({
  previous: [member('A', 'NEAR')],
  observations: [observation('A', { disposition: 'UNIVERSE_FILTER_EXIT', universeFilterPassed: false, liquidityFilterPassed: false, exclusionReason: 'VOLUME_FILTER' })],
})[0]?.eventType, 'UNIVERSE_FILTER_EXIT')

assert.equal(derive({ previous: [], current: [member('N', 'NEAR')], prior: [] })[0]?.eventType, 'NEW')
assert.equal(derive({ previous: [], current: [member('R', 'NEAR')], prior: ['R'] })[0]?.eventType, 'RE_ENTRY')
assert.deepEqual(derive({ previous: [member('A', 'NEAR', 80)], current: [member('A', 'NEAR', 84)] }), [], 'score-only changes emit no event')

assert.equal(derive({
  previous: [member('A', 'IN_ZONE')], inZone: [],
  observations: [observation('A', { disposition: 'TRIGGER_EXIT', triggerStatus: 'NOT_MATCHED', pricePosition: 'ABOVE_ZONE', exclusionReason: 'NOT_APPROACHING' })],
})[0]?.eventType, 'EXITED', 'rebound requires prior IN_ZONE evidence')

assert.equal(derive({
  previous: [member('A', 'IN_ZONE')], inZone: ['A'],
  observations: [observation('A', { disposition: 'CORE_CONDITION_EXIT', pricePosition: 'ABOVE_ZONE', bothRising: false })],
})[0]?.eventType, 'CORE_CONDITION_EXIT', 'broken core conditions take precedence over rebound')

console.log('Trigger lifecycle baseline, transition, exit, rebound, re-entry, and no-noise tests passed')
