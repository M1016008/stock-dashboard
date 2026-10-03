import assert from 'node:assert/strict'
import { execGet } from '@/lib/db/client'
import { universeSqlCondition } from '@/lib/market-universe'
import { getFilteredSectorConstituents } from '@/lib/queries/sector-constituents'
import { getSectorStructureBoard } from '@/lib/queries/sectors'
import { getStockSectorContext } from '@/lib/queries/stock-sector-context'
import { loadPhysicsStatusCalibration } from '@/lib/queries/physics-status-calibration'
import {
  evaluateBestSectorStrategy,
  type SectorConstituentFilters,
} from '@/lib/sector-constituents'
import type { SectorStructureTaxonomy } from '@/lib/sector-structure'

const GROUP_KEY = '8'

function filters(overrides: Partial<SectorConstituentFilters> = {}): SectorConstituentFilters {
  return {
    preset: 'all',
    stages: {},
    maDirection: 'all',
    maMinCount: 2,
    maOrder: 'all',
    scoreMin: null,
    scoreMax: null,
    changeMin: null,
    changeMax: null,
    marketCapMin: null,
    volumeMin: null,
    sort: 'trendScore',
    sortDir: 'desc',
    offset: 0,
    ...overrides,
  }
}

function taxonomyCondition(taxonomy: SectorStructureTaxonomy) {
  if (taxonomy === '17') return `COALESCE(NULLIF(tu.sector17_code, ''), tu.sector17_name) = ?`
  if (taxonomy === '33') return `COALESCE(NULLIF(tu.sector33_code, ''), tu.sector33_name) = ?`
  if (taxonomy === 'major') return 'sc.major_category = ?'
  return `(sc.major_category || char(31) || sc.sub_industry) = ?`
}

async function directTaxonomyCount({
  taxonomy,
  groupKey,
  date,
  dailyAStages,
}: {
  taxonomy: SectorStructureTaxonomy
  groupKey: string
  date: string
  dailyAStages?: number[]
}) {
  return Number((await execGet<{ total: number }>(`
    SELECT COUNT(*) AS total
    FROM daily_snapshots AS s
    JOIN ticker_universe AS tu ON tu.ticker = s.ticker AND tu.active = 1
    LEFT JOIN stock_classification AS sc ON sc.ticker = s.ticker
    WHERE s.date = ?
      AND ${taxonomyCondition(taxonomy)}
      ${dailyAStages ? `AND s.daily_a_stage IN (${dailyAStages.map(() => '?').join(', ')})` : ''}
  `, [date, groupKey, ...(dailyAStages ?? [])]))?.total ?? 0)
}

async function main() {
const negativeTie = evaluateBestSectorStrategy({
  trendStructureScore: 50,
  maUpCount: 3,
  maDownCount: 3,
  maOrder: 'other',
  improvingTransitions: 1,
  deterioratingTransitions: 1,
  higherUpAlignment: 60,
  higherDownAlignment: 60,
  physicsStatus: '下落加速',
  pullbackVerdict: '下落途中の一時反発',
  shortTermCheckLabel: '下落警戒',
}, {
  trendStructureScore: 50,
  momentum10d: 0,
  marketTrendStructureScore: 50,
})
assert.equal(negativeTie.matchCount, 3)
assert.equal(negativeTie.strategy, 'risk', 'negative evidence must win an equal-score strategy tie')

const reversalTie = evaluateBestSectorStrategy({
  trendStructureScore: 50,
  maUpCount: 2,
  maDownCount: 1,
  maOrder: 'converging',
  improvingTransitions: 2,
  deterioratingTransitions: 0,
  higherUpAlignment: 45,
  higherDownAlignment: 40,
  physicsStatus: '反発準備',
  pullbackVerdict: '本物の押し目に近い',
  shortTermCheckLabel: '好転候補',
}, {
  trendStructureScore: 50,
  momentum10d: 1,
  marketTrendStructureScore: 50,
})
assert.equal(reversalTie.matchCount, 5)
assert.equal(reversalTie.strategy, 'reversal', 'reversal evidence must win an equal-score strategy tie')

const all = await getFilteredSectorConstituents({
  taxonomy: '17',
  groupKey: GROUP_KEY,
  universeFilter: null,
  filters: filters(),
})
assert.ok(all)
const directAll = Number((await execGet<{ total: number }>(`
  SELECT COUNT(*) AS total
  FROM daily_snapshots AS s
  JOIN ticker_universe AS tu ON tu.ticker = s.ticker AND tu.active = 1
  WHERE s.date = ?
    AND COALESCE(NULLIF(tu.sector17_code, ''), tu.sector17_name) = ?
`, [all.date, GROUP_KEY]))?.total ?? 0)
assert.equal(all.total, directAll)
assert.ok(all.items.every((item) => item.trendStructureScore == null || (item.trendStructureScore >= 0 && item.trendStructureScore <= 100)))
assert.ok(all.items.every((item) => item.strategyEvaluation.criteria.length === 5))
assert.ok(all.items.every((item) => item.strategyEvaluation.matchCount >= 0 && item.strategyEvaluation.matchCount <= 5))
assert.ok(all.items.every((item) => item.shortTermCheckLabel && item.physicsStatus))
assert.ok(all.physicsFeatureDate == null || all.physicsFeatureDate <= all.date)
assert.ok(all.physicsCalibrationDate == null || all.physicsCalibrationDate <= all.date)
const calibrationAsOfDate = await loadPhysicsStatusCalibration(20, all.date)
assert.ok(calibrationAsOfDate.size > 0, 'physics status calibration should exist for the analysis date')
assert.ok(
  [...calibrationAsOfDate.values()].every((item) => item.evaluationDate <= all.date),
  'physics status calibration must not use evaluations after the analysis date',
)

const stage = await getFilteredSectorConstituents({
  taxonomy: '17',
  groupKey: GROUP_KEY,
  universeFilter: null,
  filters: filters({ stages: { dailyA: [1, 6] } }),
})
assert.ok(stage)
const directStage = Number((await execGet<{ total: number }>(`
  SELECT COUNT(*) AS total
  FROM daily_snapshots AS s
  JOIN ticker_universe AS tu ON tu.ticker = s.ticker AND tu.active = 1
  WHERE s.date = ?
    AND COALESCE(NULLIF(tu.sector17_code, ''), tu.sector17_name) = ?
    AND s.daily_a_stage IN (1, 6)
`, [stage.date, GROUP_KEY]))?.total ?? 0)
assert.equal(stage.total, directStage)
assert.ok(stage.items.every((item) => item.stages.dailyA === 1 || item.stages.dailyA === 6))

const emerging = await getFilteredSectorConstituents({
  taxonomy: '17',
  groupKey: GROUP_KEY,
  universeFilter: null,
  filters: filters({ preset: 'up_emerging' }),
})
assert.ok(emerging)
assert.ok(emerging.items.every((item) => item.improvingTransitions > 0))
assert.ok(emerging.items.every((item) => item.strategyEvaluation.strategy === 'up_emerging'))
assert.ok(emerging.items.every((item) => item.strategyEvaluation.matchCount >= 3))

const risk = await getFilteredSectorConstituents({
  taxonomy: '17',
  groupKey: GROUP_KEY,
  universeFilter: null,
  sectorContext: { trendStructureScore: 35, momentum10d: -5, marketTrendStructureScore: 55 },
  filters: filters({ preset: 'risk', sort: 'strategyMatch' }),
})
assert.ok(risk)
assert.ok(risk.items.every((item) => item.strategyEvaluation.strategy === 'risk'))
assert.ok(risk.items.every((item) => item.strategyEvaluation.matchCount >= 3))

const maUp = await getFilteredSectorConstituents({
  taxonomy: '17',
  groupKey: GROUP_KEY,
  universeFilter: null,
  filters: filters({ maDirection: 'up', maMinCount: 3 }),
})
assert.ok(maUp)
assert.ok(maUp.items.every((item) => item.maUpCount >= 3))

const universe = universeSqlCondition('tu.ticker', 'nikkei225')
const nikkei225 = await getFilteredSectorConstituents({
  taxonomy: '17',
  groupKey: GROUP_KEY,
  universeFilter: 'nikkei225',
  filters: filters(),
})
assert.ok(nikkei225)
const directNikkei = Number((await execGet<{ total: number }>(`
  SELECT COUNT(*) AS total
  FROM daily_snapshots AS s
  JOIN ticker_universe AS tu ON tu.ticker = s.ticker AND tu.active = 1
  WHERE s.date = ?
    AND COALESCE(NULLIF(tu.sector17_code, ''), tu.sector17_name) = ?
    AND ${universe.sql}
`, [nikkei225.date, GROUP_KEY, ...universe.params]))?.total ?? 0)
assert.equal(nikkei225.total, directNikkei)

const taxonomyTotals: Partial<Record<SectorStructureTaxonomy, number>> = {}
for (const taxonomy of ['17', '33', 'major', 'subIndustry'] as const) {
  const board = await getSectorStructureBoard(taxonomy)
  const row = board.rows[0]
  assert.ok(row, `${taxonomy}: board row is required`)

  const taxonomyAll = await getFilteredSectorConstituents({
    taxonomy,
    groupKey: row.groupKey,
    requestedDate: board.latestDate,
    universeFilter: null,
    filters: filters(),
  })
  assert.ok(taxonomyAll, `${taxonomy}: constituent page is required`)
  assert.equal(taxonomyAll.total, await directTaxonomyCount({
    taxonomy,
    groupKey: row.groupKey,
    date: taxonomyAll.date,
  }), `${taxonomy}: all count`)
  assert.equal(taxonomyAll.total, row.nStocks, `${taxonomy}: board and constituent count`)
  assert.equal(taxonomyAll.items.length, Math.min(50, taxonomyAll.total), `${taxonomy}: first page size`)

  const taxonomyStages = await getFilteredSectorConstituents({
    taxonomy,
    groupKey: row.groupKey,
    requestedDate: board.latestDate,
    universeFilter: null,
    filters: filters({ stages: { dailyA: [1, 6] } }),
  })
  assert.ok(taxonomyStages, `${taxonomy}: stage page is required`)
  assert.equal(taxonomyStages.total, await directTaxonomyCount({
    taxonomy,
    groupKey: row.groupKey,
    date: taxonomyStages.date,
    dailyAStages: [1, 6],
  }), `${taxonomy}: stage count`)
  assert.ok(taxonomyStages.items.every((item) => item.stages.dailyA === 1 || item.stages.dailyA === 6))
  taxonomyTotals[taxonomy] = taxonomyAll.total
}

const stockContext = await getStockSectorContext({
  ticker: '7003',
  taxonomy: 'major',
  requestedDate: all.date,
  universe: null,
})
assert.ok(stockContext)
assert.equal(stockContext.ticker, '7003')
assert.ok(stockContext.groupName.length > 0)
assert.equal(stockContext.date, all.date)

console.log(JSON.stringify({
  date: all.date,
  all: all.total,
  dailyA16: stage.total,
  upEmerging: emerging.total,
  risk: risk.total,
  stockSector: stockContext.groupName,
  maUp3: maUp.total,
  nikkei225: nikkei225.total,
  taxonomyTotals,
}))
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
