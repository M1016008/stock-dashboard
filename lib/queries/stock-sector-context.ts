import { execGet } from '@/lib/db/client'
import { isHistoricalUniverseMemberAt } from '@/lib/historical-universe'
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

export type StockSectorContextReasonCode =
  | 'ticker_not_in_universe'
  | 'ticker_not_active'
  | 'ticker_not_listed_as_of'
  | 'classification_not_found'
  | 'taxonomy_group_not_found'
  | 'structure_snapshot_not_found'
  | 'structure_snapshot_not_found_as_of'
  | 'sector_group_snapshot_not_found'

export type StockSectorContextResult = {
  context: StockSectorContext | null
  availability: 'available' | 'missing' | 'not_applicable'
  reason: {
    code: StockSectorContextReasonCode
    message: string
  } | null
  requestedDate: string | null
}

type ClassificationRow = {
  ticker: string
  currentTicker: string | null
  historicalTicker: string | null
  currentActive: number | null
  firstTradeDate: string | null
  lastTradeDate: string | null
  ledgerThrough: string | null
  fallbackFirstTradeDate: string | null
  fallbackLastTradeDate: string | null
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

type StockSectorContextInput = {
  ticker: string
  taxonomy: SectorStructureTaxonomy
  requestedDate?: string | null
  universe: UniverseFilterValue
}

function unavailableContext(
  availability: StockSectorContextResult['availability'],
  code: StockSectorContextReasonCode,
  message: string,
  requestedDate: string | null,
): StockSectorContextResult {
  return { context: null, availability, reason: { code, message }, requestedDate }
}

export async function getStockSectorContextResult({
  ticker,
  taxonomy,
  requestedDate,
  universe,
}: StockSectorContextInput): Promise<StockSectorContextResult> {
  const normalizedRequestedDate = requestedDate ?? null
  const normalizedTicker = ticker.toUpperCase().replace(/\.T$/i, '')
  if (!isTickerInUniverse(normalizedTicker, universe)) {
    return unavailableContext(
      'not_applicable',
      'ticker_not_in_universe',
      '選択中のユニバース対象外です',
      normalizedRequestedDate,
    )
  }
  const classification = await execGet<ClassificationRow>(`
    SELECT input.ticker,
      tu.ticker AS currentTicker,
      hu.ticker AS historicalTicker,
      tu.active AS currentActive,
      hu.first_trade_date AS firstTradeDate,
      hu.last_trade_date AS lastTradeDate,
      COALESCE(
        hu.latest_ohlcv_date,
        (SELECT MAX(latest_ohlcv_date) FROM historical_universe)
      ) AS ledgerThrough,
      (SELECT MIN(date) FROM ohlcv_daily WHERE ticker = input.ticker) AS fallbackFirstTradeDate,
      (SELECT MAX(date) FROM ohlcv_daily WHERE ticker = input.ticker) AS fallbackLastTradeDate,
      CASE WHEN ? IS NOT NULL THEN COALESCE(hu.sector17_code, tu.sector17_code) ELSE tu.sector17_code END AS sector17Code,
      CASE WHEN ? IS NOT NULL THEN COALESCE(hu.sector17_name, tu.sector17_name) ELSE tu.sector17_name END AS sector17Name,
      CASE WHEN ? IS NOT NULL THEN COALESCE(hu.sector33_code, tu.sector33_code) ELSE tu.sector33_code END AS sector33Code,
      CASE WHEN ? IS NOT NULL THEN COALESCE(hu.sector33_name, tu.sector33_name) ELSE tu.sector33_name END AS sector33Name,
      sc.major_category AS majorCategory,
      sc.sub_industry AS subIndustry
    FROM (SELECT ? AS ticker) AS input
    LEFT JOIN ticker_universe AS tu ON tu.ticker = input.ticker
    LEFT JOIN historical_universe AS hu ON hu.ticker = input.ticker
    LEFT JOIN stock_classification AS sc ON sc.ticker = input.ticker
    LIMIT 1
  `, [
    normalizedRequestedDate,
    normalizedRequestedDate,
    normalizedRequestedDate,
    normalizedRequestedDate,
    normalizedTicker,
  ])
  if (!classification?.currentTicker && !classification?.historicalTicker) {
    return unavailableContext('missing', 'classification_not_found', '対象銘柄の分類がありません', normalizedRequestedDate)
  }
  if (normalizedRequestedDate) {
    const historicalMember = isHistoricalUniverseMemberAt({
      asOf: normalizedRequestedDate,
      currentActive: classification.currentActive === 1,
      historicalRecordExists: classification.historicalTicker != null,
      firstTradeDate: classification.firstTradeDate,
      lastTradeDate: classification.lastTradeDate,
      ledgerThrough: classification.ledgerThrough,
      fallbackFirstTradeDate: classification.fallbackFirstTradeDate,
      fallbackLastTradeDate: classification.fallbackLastTradeDate,
    })
    if (!historicalMember) {
      return unavailableContext(
        'not_applicable',
        'ticker_not_listed_as_of',
        '基準日時点では上場対象外です',
        normalizedRequestedDate,
      )
    }
  } else if (classification.currentActive !== 1) {
    return unavailableContext('not_applicable', 'ticker_not_active', '現在の上場対象外です', normalizedRequestedDate)
  }
  const groupKey = groupForTaxonomy(classification, taxonomy)
  if (!groupKey) {
    return unavailableContext('missing', 'taxonomy_group_not_found', '対象の業種分類がありません', normalizedRequestedDate)
  }
  const board = await getSectorStructureBoard(taxonomy, {
    selectedGroupKey: groupKey,
    requestedDate,
    universeFilter: universe,
    includeAllRows: true,
  })
  if (!board.latestDate) {
    return unavailableContext(
      'missing',
      normalizedRequestedDate ? 'structure_snapshot_not_found_as_of' : 'structure_snapshot_not_found',
      normalizedRequestedDate ? '基準日時点の業種構造データがありません' : '業種構造データが未計算です',
      normalizedRequestedDate,
    )
  }
  const row = board.rows.find((item) => item.groupKey === groupKey)
  if (!row) {
    return unavailableContext(
      'missing',
      'sector_group_snapshot_not_found',
      '所属業種の構造データが未計算です',
      normalizedRequestedDate,
    )
  }
  const rankedRows = board.rows
    .filter((item) => item.trendStructureScore != null)
    .sort((a, b) => (b.trendStructureScore ?? -Infinity) - (a.trendStructureScore ?? -Infinity))
  const rankIndex = rankedRows.findIndex((item) => item.groupKey === groupKey)
  return {
    context: {
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
    },
    availability: 'available',
    reason: null,
    requestedDate: normalizedRequestedDate,
  }
}

export async function getStockSectorContext(input: StockSectorContextInput): Promise<StockSectorContext | null> {
  return (await getStockSectorContextResult(input)).context
}
