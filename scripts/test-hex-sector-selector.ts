import assert from 'node:assert/strict'
import {
  analyzeHexSelectorCandidate,
  rankSelectorSectors,
  sortHexSelectorCandidates,
  type HexSelectorCandidateInput,
} from '@/lib/hex-selector'
import { calculateSectorMarketBaseline } from '@/lib/sector-stage-distribution'
import type { SectorStructureRow } from '@/lib/queries/sectors'
import type { SectorStageComposition } from '@/lib/sector-stage-distribution'

function composition(stage: number, count = 10): SectorStageComposition {
  const axis = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0 }
  axis[stage as keyof typeof axis] = count
  return {
    dailyA: { ...axis },
    dailyB: { ...axis },
    weeklyA: { ...axis },
    weeklyB: { ...axis },
    monthlyA: { ...axis },
    monthlyB: { ...axis },
  }
}

function sector(overrides: Partial<SectorStructureRow> = {}): SectorStructureRow {
  return {
    taxonomy: 'major',
    groupKey: 'test',
    groupName: 'テスト業種',
    parentGroup: null,
    date: '2026-08-21',
    nStocks: 20,
    validStageCount: 120,
    strengthScore: 70,
    transitionChangeScore: 35,
    momentum5d: 5,
    momentum10d: 12,
    momentum20d: 18,
    propagationDirection: 'improving',
    propagationPhase: 3,
    propagationLabel: '改善波及',
    improvingCount: 12,
    deterioratingCount: 3,
    stableCount: 105,
    composition: composition(1, 20),
    dominantChange: null,
    ...overrides,
  }
}

function candidate(overrides: Partial<HexSelectorCandidateInput> = {}): HexSelectorCandidateInput {
  return {
    ticker: '7003',
    name: 'テスト自動車',
    marketSegment: 'プライム',
    marketCap: 50_000_000_000,
    price: 2500,
    changePct: 1.2,
    volume: 1_000_000,
    stages: { dailyA: 5, dailyB: 6, weeklyA: 6, weeklyB: 1, monthlyA: 1, monthlyB: 2 },
    previousStages: { dailyA: 4, dailyB: 5, weeklyA: 5, weeklyB: 1, monthlyA: 1, monthlyB: 2 },
    ma: { ma5: 105, ma25: 103, ma75: 101, ma300: 99 },
    previousMa: { ma5: 100, ma25: 100, ma75: 100, ma300: 100 },
    physicalMomentumScore: 1.4,
    mlUpRank: 12,
    mlDownRank: null,
    ...overrides,
  }
}

const strong = sector({ groupKey: 'strong', groupName: '強い業種' })
const weak = sector({
  groupKey: 'weak',
  groupName: '弱い業種',
  strengthScore: 20,
  transitionChangeScore: -45,
  momentum10d: -10,
  propagationDirection: 'deteriorating',
  composition: composition(4, 20),
})

assert.equal(rankSelectorSectors([weak, strong], 'emerging', 'up')[0].groupKey, 'strong')
assert.equal(rankSelectorSectors([weak, strong], 'emerging', 'down')[0].groupKey, 'weak')
assert.equal(rankSelectorSectors([weak, strong], 'continuation', 'up')[0].groupKey, 'strong')
assert.equal(rankSelectorSectors([weak, strong], 'continuation', 'down')[0].groupKey, 'weak')

const tinySpike = sector({
  groupKey: 'tiny-spike',
  groupName: '少数急変業種',
  nStocks: 3,
  transitionChangeScore: 20,
})
const broadMove = sector({
  groupKey: 'broad-move',
  groupName: '広範改善業種',
  nStocks: 18,
  transitionChangeScore: 8,
})
assert.equal(rankSelectorSectors([tinySpike, broadMove], 'emerging', 'up')[0].groupKey, 'broad-move')

const baseline = calculateSectorMarketBaseline([strong, weak])
assert.equal(baseline.dailyA[1], 0.5)
assert.equal(baseline.dailyA[4], 0.5)

const up = analyzeHexSelectorCandidate(candidate(), strong, 'emerging', 'up')
assert.ok(up.transitionMatches >= 3)
assert.ok(up.matchCount >= 4)
assert.ok(up.reasons.some((reason) => reason.includes('ステージ遷移')))
assert.equal(up.stageCode, '566112')

const downInput = candidate({
  ticker: '9999',
  stages: { dailyA: 2, dailyB: 3, weeklyA: 3, weeklyB: 4, monthlyA: 4, monthlyB: 4 },
  previousStages: { dailyA: 1, dailyB: 2, weeklyA: 2, weeklyB: 3, monthlyA: 3, monthlyB: 4 },
  ma: { ma5: 95, ma25: 97, ma75: 99, ma300: 99 },
  previousMa: { ma5: 100, ma25: 100, ma75: 100, ma300: 100 },
  physicalMomentumScore: -1.2,
  mlUpRank: null,
  mlDownRank: 8,
})
const down = analyzeHexSelectorCandidate(downInput, weak, 'emerging', 'down')
assert.ok(down.transitionMatches >= 5)
assert.ok(down.higherAlignment > up.higherAlignment)
assert.equal(sortHexSelectorCandidates([up, down], 'emerging', 'down')[0].ticker, '9999')

console.log('hex sector selector tests passed')
