import assert from 'node:assert/strict'
import { ensureReady, execAll, execGet } from '@/lib/db/client'
import { getStockSectorContextResult } from '@/lib/queries/stock-sector-context'
import { getSectorStructureBoard } from '@/lib/queries/sectors'

async function main() {
  await ensureReady()

  const classification = await execGet<{
    ticker: string
    sector17Code: string | null
    sector17Name: string | null
    sector33Code: string | null
    sector33Name: string | null
  }>(`
    SELECT ticker,
      sector17_code AS sector17Code,
      sector17_name AS sector17Name,
      sector33_code AS sector33Code,
      sector33_name AS sector33Name
    FROM ticker_universe
    WHERE ticker = '7003' AND active = 1
  `)
  assert.equal(classification?.sector33Code, '3600')
  assert.equal(classification?.sector33Name, '機械')

  const current = await getStockSectorContextResult({
    ticker: '7003', taxonomy: '33', requestedDate: null, universe: null,
  })
  const suffixed = await getStockSectorContextResult({
    ticker: '7003.T', taxonomy: '33', requestedDate: null, universe: null,
  })
  assert.equal(current.availability, 'available')
  assert.deepEqual(suffixed, current)
  assert.equal(current.context?.ticker, '7003')
  assert.equal(current.context?.taxonomy, '33')
  assert.equal(current.context?.groupKey, classification?.sector33Code)
  assert.equal(current.context?.groupName, classification?.sector33Name)
  assert.ok(current.context?.trendStructureScore != null)
  assert.ok(current.context.trendStructureScore >= 0 && current.context.trendStructureScore <= 100)
  assert.ok((current.context?.rank ?? 0) >= 1)
  assert.ok((current.context?.totalGroups ?? 0) >= (current.context?.rank ?? Infinity))

  const board = await getSectorStructureBoard('33', {
    selectedGroupKey: classification?.sector33Code,
    includeAllRows: true,
  })
  const machine = board.rows.find((row) => row.groupKey === classification?.sector33Code)
  const ranked = board.rows
    .filter((row) => row.trendStructureScore != null)
    .sort((a, b) => (b.trendStructureScore ?? -Infinity) - (a.trendStructureScore ?? -Infinity))
  assert.equal(current.context?.trendStructureScore, machine?.trendStructureScore)
  assert.equal(current.context?.rank, ranked.findIndex((row) => row.groupKey === classification?.sector33Code) + 1)
  assert.equal(current.context?.totalGroups, ranked.length)

  const dates = await execAll<{ date: string }>(`
    SELECT DISTINCT date
    FROM sector_structure_daily
    WHERE taxonomy = '33' AND date <= '2026-08-25'
    ORDER BY date DESC
    LIMIT 1
  `)
  assert.equal(dates.length, 1)
  const pastDate = dates[0].date
  assert.equal(pastDate, '2026-08-25')
  const past = await getStockSectorContextResult({
    ticker: '7003', taxonomy: '33', requestedDate: pastDate, universe: null,
  })
  assert.equal(past.availability, 'available')
  assert.ok((past.context?.date ?? '9999-99-99') <= pastDate)
  assert.ok(past.context?.trendStructureScore != null)
  assert.ok((past.context?.rank ?? 0) >= 1)
  assert.ok((past.context?.totalGroups ?? 0) >= (past.context?.rank ?? Infinity))

  const beforeHistory = await getStockSectorContextResult({
    ticker: '7003', taxonomy: '33', requestedDate: '2026-04-01', universe: null,
  })
  assert.equal(beforeHistory.availability, 'missing')
  assert.equal(beforeHistory.reason?.code, 'structure_snapshot_not_found_as_of')

  const outsideUniverse = await getStockSectorContextResult({
    ticker: '7003', taxonomy: '33', requestedDate: null, universe: 'nikkei225',
  })
  assert.equal(outsideUniverse.availability, 'not_applicable')
  assert.equal(outsideUniverse.reason?.code, 'ticker_not_in_universe')

  const toyota = await getStockSectorContextResult({
    ticker: '7203', taxonomy: '33', requestedDate: null, universe: null,
  })
  assert.equal(toyota.availability, 'available')
  assert.equal(toyota.context?.groupName, '輸送用機器')

  console.log(JSON.stringify({
    classification,
    current: current.context,
    past: past.context,
    beforeHistory: { availability: beforeHistory.availability, reason: beforeHistory.reason },
    outsideUniverse: { availability: outsideUniverse.availability, reason: outsideUniverse.reason },
    toyota: toyota.context,
  }, null, 2))
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
