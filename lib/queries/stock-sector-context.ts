import { execGet } from '@/lib/db/client'
import { isTickerInUniverse, type UniverseFilterValue } from '@/lib/market-universe'
import { getSectorStructureBoard } from '@/lib/queries/sectors'
import type { SectorStructureTaxonomy } from '@/lib/sector-structure'

export type StockSectorContext = {
  ticker: string
  taxonomy: SectorStructureTaxonomy
  groupKey: string
  groupName: string
  parentGroup: string | null
  date: string
  universe: UniverseFilterValue
  trendStructureScore: number | null
  marketTrendStructureScore: number | null
  marketDifference: number | null
  rank: number | null
  totalGroups: number
  momentum10d: number | null
  propagationLabel: string
  maUpBreadth: number | null
  upwardStockRatio: number | null
}

type ClassificationRow = {
  ticker: string
  sector17Code: string | null
  sector17Name: string | null
  sector33Code: string | null
  sector33Name: string | null
  majorCategory: string | null
  subIndustry: string | null
}

function groupForTaxonomy(row: ClassificationRow, taxonomy: SectorStructureTaxonomy) {
  if (taxonomy === '17') return row.sector17Code || row.sector17Name
  if (taxonomy === '33') return row.sector33Code || row.sector33Name
  if (taxonomy === 'major') return row.majorCategory
  return row.majorCategory && row.subIndustry ? `${row.majorCategory}\u001f${row.subIndustry}` : null
}

export async function getStockSectorContext({
  ticker,
  taxonomy,
  requestedDate,
  universe,
}: {
  ticker: string
  taxonomy: SectorStructureTaxonomy
  requestedDate?: string | null
  universe: UniverseFilterValue
}): Promise<StockSectorContext | null> {
  const normalizedTicker = ticker.toUpperCase().replace(/\.T$/i, '')
  if (!isTickerInUniverse(normalizedTicker, universe)) return null
  const classification = await execGet<ClassificationRow>(`
    SELECT tu.ticker,
      tu.sector17_code AS sector17Code,
      tu.sector17_name AS sector17Name,
      tu.sector33_code AS sector33Code,
      tu.sector33_name AS sector33Name,
      sc.major_category AS majorCategory,
      sc.sub_industry AS subIndustry
    FROM ticker_universe AS tu
    LEFT JOIN stock_classification AS sc ON sc.ticker = tu.ticker
    WHERE tu.ticker = ? AND tu.active = 1
    LIMIT 1
  `, [normalizedTicker])
  if (!classification) return null
  const groupKey = groupForTaxonomy(classification, taxonomy)
  if (!groupKey) return null
  const board = await getSectorStructureBoard(taxonomy, {
    selectedGroupKey: groupKey,
    requestedDate,
    universeFilter: universe,
    includeAllRows: true,
  })
  const row = board.rows.find((item) => item.groupKey === groupKey)
  if (!row || !board.latestDate) return null
  const rankedRows = board.rows
    .filter((item) => item.trendStructureScore != null)
    .sort((a, b) => (b.trendStructureScore ?? -Infinity) - (a.trendStructureScore ?? -Infinity))
  const rankIndex = rankedRows.findIndex((item) => item.groupKey === groupKey)
  return {
    ticker: normalizedTicker,
    taxonomy,
    groupKey: row.groupKey,
    groupName: row.groupName,
    parentGroup: row.parentGroup,
    date: board.latestDate,
    universe,
    trendStructureScore: row.trendStructureScore,
    marketTrendStructureScore: board.marketTrendStructureScore,
    marketDifference: row.trendStructureScore != null && board.marketTrendStructureScore != null
      ? row.trendStructureScore - board.marketTrendStructureScore
      : null,
    rank: rankIndex >= 0 ? rankIndex + 1 : null,
    totalGroups: rankedRows.length,
    momentum10d: row.momentum10d,
    propagationLabel: row.propagationLabel,
    maUpBreadth: row.maUpBreadth,
    upwardStockRatio: row.upwardStockRatio,
  }
}
