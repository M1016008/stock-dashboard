import assert from 'node:assert/strict'
import {
  EVENT_PHYSICAL_SIMILARITY_FEATURES,
  EVENT_SMA_SIMILARITY_FEATURES,
  automaticFeatureBins,
  buildAutomaticBreakdown,
  compareEventSimilarity,
  extractObservedTemplate,
  matchesExplicitEventFilters,
  templateToExplicitFilters,
  type EventSimilarityVector,
} from '@/lib/research/six-stage-event-analysis'
import { FIXTURE_SEQUENCE_KEYS, buildSixStageEventLabFixture } from '@/lib/research/six-stage-event-lab-fixture'

function vector(input: {
  id: string
  gap: number | null
  velocity: number | null
  sequence?: string
  age?: number
}): EventSimilarityVector {
  return {
    eventId: input.id,
    ticker: input.id,
    signalDate: '2022-01-04',
    sequenceKey: input.sequence ?? '211111>111111',
    cAge: input.age ?? 0,
    sma: { sma25CloseGap: input.gap },
    physical: { velocity: input.velocity },
  }
}

assert.ok(EVENT_SMA_SIMILARITY_FEATURES.includes('sma25Angle'))
assert.ok(!EVENT_PHYSICAL_SIMILARITY_FEATURES.some((feature) => feature.toLowerCase().includes('sma')))

const base = vector({ id: 'base', gap: 0.1, velocity: 0.2 })
const physicalMismatch = vector({ id: 'candidate', gap: 0.1, velocity: 1.2 })
const scales = { sma25CloseGap: 0.1, velocity: 0.1 }
const smaWeighted = compareEventSimilarity({
  base,
  candidate: physicalMismatch,
  scales,
  weights: { transition: 0, sma: 1, physical: 0 },
})
const physicalWeighted = compareEventSimilarity({
  base,
  candidate: physicalMismatch,
  scales,
  weights: { transition: 0, sma: 0, physical: 1 },
})
assert.equal(smaWeighted.sma.score, 1)
assert.ok((physicalWeighted.physical.score ?? 1) < 0.001)
assert.equal(smaWeighted.combined, 1)
assert.ok((physicalWeighted.combined ?? 1) < 0.001)

assert.equal(matchesExplicitEventFilters(base, {
  sequenceKey: '211111>111111',
  sma: { sma25CloseGap: { minimum: 0.05, maximum: 0.15 } },
}), true)
assert.equal(matchesExplicitEventFilters(base, {
  physical: { velocity: { minimum: 0.3 } },
}), false)

const vectors = [
  vector({ id: 'a', gap: -2, velocity: -2 }),
  vector({ id: 'b', gap: -1, velocity: -1 }),
  vector({ id: 'c', gap: 1, velocity: 1 }),
  vector({ id: 'd', gap: 1.5, velocity: 1.5 }),
  vector({ id: 'e', gap: 2, velocity: 2 }),
]
const bins = automaticFeatureBins(vectors, 'sma25CloseGap', 2)
assert.equal(bins.reduce((sum, bin) => sum + bin.events, 0), vectors.length)

const outcomes = [-0.2, 0.1, 0.2, -0.1, 0.4]
const firstPassage = [false, true, true, false, null]
const breakdown = buildAutomaticBreakdown(vectors.map((item, index) => ({
  eventId: item.eventId,
  ticker: item.ticker,
  signalDate: item.signalDate,
  vector: item,
  value: outcomes[index],
  favorableFirst: firstPassage[index],
})), 'sma25CloseGap', 2)
assert.equal(breakdown.reduce((sum, row) => sum + row.observations, 0), vectors.length)
assert.equal(breakdown.reduce((sum, row) => sum + row.favorableFirstKnown, 0), 4)
assert.equal(breakdown.reduce((sum, row) => sum + row.favorableFirstCount, 0), 2)

const selectedPositiveExamples = [vectors[2], vectors[3], vectors[4]]
const template = extractObservedTemplate(selectedPositiveExamples, ['sma25CloseGap', 'velocity'])
const templateFilters = templateToExplicitFilters(template)
const matchingAllEvents = vectors.filter((item) => matchesExplicitEventFilters(item, templateFilters))
assert.deepEqual(matchingAllEvents.map((item) => item.eventId), ['d'])
assert.equal(firstPassage[vectors.indexOf(matchingAllEvents[0])], false)

const missingPhysical = vector({ id: 'missing', gap: 0.1, velocity: null })
const missingResult = compareEventSimilarity({
  base,
  candidate: missingPhysical,
  scales,
  weights: { transition: 1, sma: 1, physical: 1 },
})
assert.equal(missingResult.physical.score, null)
assert.equal(missingResult.physical.coverage, 0)
assert.ok(missingResult.combined != null)

const fixture = buildSixStageEventLabFixture()
for (const market of ['JP', 'US'] as const) {
  for (const sequenceKey of FIXTURE_SEQUENCE_KEYS) {
    assert.ok(fixture.events.some((event) => (
      event.market === market && event.vector.sequenceKey === sequenceKey
    )), `missing fixture cell: ${market}/${sequenceKey}`)
  }
}

console.log('six-stage event analysis tests passed')
