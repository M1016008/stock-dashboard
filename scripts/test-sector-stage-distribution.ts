import assert from 'node:assert/strict'
import { SECTOR_STRUCTURE_AXES } from '@/lib/sector-structure'
import {
  calculateSectorStageDeltas,
  emptySectorStageComposition,
  findDominantStageChange,
  normalizeSectorStage,
  normalizeSectorStructureAxis,
  normalizeSectorStructureTaxonomy,
  parseSectorStageComposition,
} from '@/lib/sector-stage-distribution'

const parsed = parseSectorStageComposition(JSON.stringify({
  dailyA: { 1: 24, 2: 5, 3: 2, 4: 2, 5: 2, 6: 1 },
  dailyB: { 1: 13, 2: 10, 3: 8, 4: 5, 5: 0, 6: 0 },
  weeklyA: { 1: 13, 2: 2, 3: 2, 4: 2, 5: 7, 6: 10 },
  weeklyB: { 1: 22, 2: 4, 3: 4, 4: 5, 5: 1, 6: 0 },
  monthlyA: { 1: 11, 2: 4, 3: 2, 4: 6, 5: 8, 6: 5 },
  monthlyB: { 1: 25, 2: 0, 3: 0, 4: 4, 5: 2, 6: 5 },
}))

assert.deepEqual(Object.keys(parsed), SECTOR_STRUCTURE_AXES.map((axis) => axis.key))
assert.equal(parsed.dailyA[1], 24)
assert.equal(parsed.monthlyB[6], 5)

const malformed = parseSectorStageComposition('{not-json')
assert.deepEqual(malformed, emptySectorStageComposition())

const partial = parseSectorStageComposition(JSON.stringify({ dailyA: { 1: 3, 2: -5, 3: '2.8' } }))
assert.equal(partial.dailyA[1], 3)
assert.equal(partial.dailyA[2], 0)
assert.equal(partial.dailyA[3], 2)
assert.equal(partial.weeklyA[1], 0)

const previous = emptySectorStageComposition()
previous.dailyA[1] = 20
previous.dailyA[2] = 7
const deltas = calculateSectorStageDeltas(parsed, previous)
assert.equal(deltas.dailyA[1], 4)
assert.equal(deltas.dailyA[2], -2)
assert.deepEqual(findDominantStageChange(deltas), {
  axis: 'monthlyB',
  axisLabel: '月足B',
  stage: 1,
  delta: 25,
})

assert.equal(normalizeSectorStructureTaxonomy('major'), 'major')
assert.equal(normalizeSectorStructureTaxonomy('other'), null)
assert.equal(normalizeSectorStructureAxis('weeklyB'), 'weeklyB')
assert.equal(normalizeSectorStructureAxis('weeklyC'), null)
assert.equal(normalizeSectorStage('6'), 6)
assert.equal(normalizeSectorStage('7'), null)
assert.equal(normalizeSectorStage('1.5'), null)

console.log('sector stage distribution tests passed')
