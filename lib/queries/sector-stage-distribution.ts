import { execAll, execGet } from '@/lib/db/client'
import type { StageLevel } from '@/lib/hex-stage'
import { type UniverseFilterValue, universeSqlCondition } from '@/lib/market-universe'
import { SECTOR_STRUCTURE_AXES, type SectorStructureAxisKey, type SectorStructureTaxonomy } from '@/lib/sector-structure'

const PAGE_SIZE = 50

export type SectorStageConstituentItem = {
  ticker: string
  name: string | null
  stageCode: string | null
  price: number | null
  changePct: number | null
}

export type SectorStageConstituentPage = {
  taxonomy: SectorStructureTaxonomy
  groupKey: string
  groupName: string
  axis: SectorStructureAxisKey
  stage: StageLevel
  date: string
  universe: UniverseFilterValue
  total: number
  items: SectorStageConstituentItem[]
  nextCursor: string | null
}

function groupCondition(taxonomy: SectorStructureTaxonomy): string {
  if (taxonomy === '17') return `COALESCE(NULLIF(tu.sector17_code, ''), tu.sector17_name) = ?`
  if (taxonomy === '33') return `COALESCE(NULLIF(tu.sector33_code, ''), tu.sector33_name) = ?`
  if (taxonomy === 'major') return 'sc.major_category = ?'
  return `(sc.major_category || char(31) || sc.sub_industry) = ?`
}

function normalizeCursor(cursor: string | null | undefined): string | null {
  const value = cursor?.trim() || null
  return value && /^[0-9A-Za-z.\-^]{1,24}$/.test(value) ? value : null
}

export async function getSectorStageConstituents({
  taxonomy,
  groupKey,
  axis,
  stage,
  requestedDate,
  cursor,
  universeFilter = null,
}: {
  taxonomy: SectorStructureTaxonomy
  groupKey: string
  axis: SectorStructureAxisKey
  stage: StageLevel
  requestedDate?: string | null
  cursor?: string | null
  universeFilter?: UniverseFilterValue
}): Promise<SectorStageConstituentPage | null> {
  const dateArgs: string[] = [taxonomy]
  if (requestedDate) dateArgs.push(requestedDate)
  const resolvedDate = (await execGet<{ date: string | null }>(`
    SELECT MAX(date) AS date
    FROM sector_structure_daily
    WHERE taxonomy = ?
      ${requestedDate ? 'AND date <= ?' : ''}
  `, dateArgs))?.date ?? null
  if (!resolvedDate) return null

  const group = await execGet<{ groupName: string }>(`
    SELECT group_name AS groupName
    FROM sector_structure_daily
    WHERE taxonomy = ? AND group_key = ? AND date = ?
    LIMIT 1
  `, [taxonomy, groupKey, resolvedDate])
  if (!group) return null

  const axisColumn = SECTOR_STRUCTURE_AXES.find((item) => item.key === axis)?.dbColumn
  if (!axisColumn) return null
  const condition = groupCondition(taxonomy)
  const universe = universeSqlCondition('tu.ticker', universeFilter)
  const cleanCursor = normalizeCursor(cursor)
  const baseArgs: Array<string | number> = [resolvedDate, groupKey, stage, ...universe.params]

  const total = Number((await execGet<{ total: number }>(`
    SELECT COUNT(*) AS total
    FROM daily_snapshots AS s INDEXED BY snapshots_date_idx
    JOIN ticker_universe AS tu ON tu.ticker = s.ticker AND tu.active = 1
    LEFT JOIN stock_classification AS sc ON sc.ticker = s.ticker
    WHERE s.date = ?
      AND ${condition}
      AND s.${axisColumn} = ?
      ${universe.sql ? `AND ${universe.sql}` : ''}
  `, baseArgs))?.total ?? 0)

  const itemArgs: Array<string | number> = [resolvedDate, resolvedDate, resolvedDate, groupKey, stage]
  itemArgs.push(...universe.params)
  if (cleanCursor) itemArgs.push(cleanCursor)
  itemArgs.push(PAGE_SIZE + 1)
  const rows = await execAll<SectorStageConstituentItem>(`
    WITH previous_date AS (
      SELECT MAX(date) AS date FROM ohlcv_daily WHERE date < ?
    )
    SELECT
      tu.ticker,
      tu.name,
      CASE
        WHEN s.daily_a_stage IS NOT NULL
         AND s.daily_b_stage IS NOT NULL
         AND s.weekly_a_stage IS NOT NULL
         AND s.weekly_b_stage IS NOT NULL
         AND s.monthly_a_stage IS NOT NULL
         AND s.monthly_b_stage IS NOT NULL
        THEN CAST(s.daily_a_stage AS TEXT)
          || CAST(s.daily_b_stage AS TEXT)
          || CAST(s.weekly_a_stage AS TEXT)
          || CAST(s.weekly_b_stage AS TEXT)
          || CAST(s.monthly_a_stage AS TEXT)
          || CAST(s.monthly_b_stage AS TEXT)
      END AS stageCode,
      current_price.close AS price,
      CASE
        WHEN previous_price.close > 0
        THEN 100.0 * (current_price.close - previous_price.close) / previous_price.close
      END AS changePct
    FROM daily_snapshots AS s INDEXED BY snapshots_date_idx
    JOIN ticker_universe AS tu ON tu.ticker = s.ticker AND tu.active = 1
    LEFT JOIN stock_classification AS sc ON sc.ticker = s.ticker
    LEFT JOIN ohlcv_daily AS current_price
      ON current_price.ticker = s.ticker AND current_price.date = ?
    LEFT JOIN ohlcv_daily AS previous_price
      ON previous_price.ticker = s.ticker AND previous_price.date = (SELECT date FROM previous_date)
    WHERE s.date = ?
      AND ${condition}
      AND s.${axisColumn} = ?
      ${universe.sql ? `AND ${universe.sql}` : ''}
      ${cleanCursor ? 'AND tu.ticker > ?' : ''}
    ORDER BY tu.ticker
    LIMIT ?
  `, itemArgs)

  const hasMore = rows.length > PAGE_SIZE
  const items = rows.slice(0, PAGE_SIZE)
  return {
    taxonomy,
    groupKey,
    groupName: group.groupName,
    axis,
    stage,
    date: resolvedDate,
    universe: universeFilter,
    total,
    items,
    nextCursor: hasMore ? items.at(-1)?.ticker ?? null : null,
  }
}
