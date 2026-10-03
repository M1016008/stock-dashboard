import assert from 'node:assert/strict'
import { ensureReady, execGet } from '@/lib/db/client'
import { rankSelectorSectors } from '@/lib/hex-selector'
import { getUniverseTickerSet, universeSqlCondition } from '@/lib/market-universe'
import { getHexSelectorCandidates } from '@/lib/queries/hex-selector'
import { getSectorStageConstituents } from '@/lib/queries/sector-stage-distribution'
import { getSectorStructureBoard } from '@/lib/queries/sectors'
import { SECTOR_STRUCTURE_AXES } from '@/lib/sector-structure'
import { SECTOR_STAGE_LEVELS } from '@/lib/sector-stage-distribution'

async function main() {
  await ensureReady()

  const universe = 'nikkei225' as const
  const board = await getSectorStructureBoard('major', { universeFilter: universe })
  assert.ok(board.latestDate)
  assert.equal(board.universe, universe)
  assert.ok(board.rows.length > 0)

  const selected = [...board.rows]
    .filter((row) => row.nStocks > 0)
    .sort((a, b) => a.nStocks - b.nStocks)[0]
  assert.ok(selected)

  const universeSql = universeSqlCondition('tu.ticker', universe)
  const direct = await execGet<{ total: number }>(`
    SELECT COUNT(*) AS total
    FROM daily_snapshots AS s
    INNER JOIN ticker_universe AS tu ON tu.ticker = s.ticker AND tu.active = 1
    INNER JOIN stock_classification AS sc ON sc.ticker = s.ticker
    WHERE s.date = ?
      AND sc.major_category = ?
      AND ${universeSql.sql}
  `, [board.latestDate, selected.groupName, ...universeSql.params])
  assert.equal(selected.nStocks, Number(direct?.total ?? 0))

  for (const axis of Object.values(selected.composition)) {
    assert.ok(Object.values(axis).reduce((sum, count) => sum + count, 0) <= selected.nStocks)
  }

  const ranked = rankSelectorSectors(board.rows, 'emerging', 'up')
  const candidateGroup = ranked.find((row) => row.nStocks > 0)
  assert.ok(candidateGroup)
  const candidates = await getHexSelectorCandidates({
    taxonomy: 'major',
    group: candidateGroup,
    date: board.latestDate,
    mode: 'emerging',
    direction: 'up',
    universeFilter: universe,
  })
  const tickerSet = getUniverseTickerSet(universe)
  assert.ok(candidates.candidates.every((candidate) => tickerSet?.has(candidate.ticker)))

  const majorParents = board.rows.slice(0, 2).map((row) => row.groupName)
  assert.equal(majorParents.length, 2)
  const [firstChildren, secondChildren] = await Promise.all(majorParents.map((parentFilter) => (
    getSectorStructureBoard('subIndustry', { parentFilter, universeFilter: universe })
  )))
  assert.deepEqual(firstChildren.marketBaseline, secondChildren.marketBaseline)
  assert.ok(firstChildren.rows.every((row) => row.parentGroup === firstChildren.parentFilter))
  assert.ok(secondChildren.rows.every((row) => row.parentGroup === secondChildren.parentFilter))

  const child = firstChildren.rows[0]
  if (child) {
    const inferred = await getSectorStructureBoard('subIndustry', {
      selectedGroupKey: child.groupKey,
      universeFilter: universe,
    })
    assert.equal(inferred.parentFilter, child.parentGroup)
    assert.ok(inferred.rows.every((row) => row.parentGroup === child.parentGroup))

    const populatedCell = SECTOR_STRUCTURE_AXES.flatMap((axis) => (
      SECTOR_STAGE_LEVELS.map((stage) => ({ axis: axis.key, stage, count: child.composition[axis.key][stage] }))
    )).find((cell) => cell.count > 0)
    assert.ok(populatedCell)
    const page = await getSectorStageConstituents({
      taxonomy: 'subIndustry',
      groupKey: child.groupKey,
      axis: populatedCell.axis,
      stage: populatedCell.stage,
      requestedDate: firstChildren.latestDate,
      universeFilter: universe,
    })
    assert.equal(page?.universe, universe)
    assert.equal(page?.total, populatedCell.count)
  }

  const sector17 = await getSectorStructureBoard('17', { universeFilter: universe })
  const parent17 = sector17.rows[0]
  assert.ok(parent17)
  const sector33 = await getSectorStructureBoard('33', {
    parentFilter: parent17.groupName,
    universeFilter: universe,
  })
  assert.ok(sector33.rows.every((row) => row.parentGroup === sector33.parentFilter))

  console.log(JSON.stringify({
    date: board.latestDate,
    checkedGroup: selected.groupName,
    checkedCount: selected.nStocks,
    candidateCount: candidates.total,
    firstChildRows: firstChildren.rows.length,
    secondChildRows: secondChildren.rows.length,
  }))
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
