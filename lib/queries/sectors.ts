import { execAll, execGet } from '@/lib/db/client'
import { type UniverseFilterValue, universeSqlCondition } from '@/lib/market-universe'
import { SECTOR_STRUCTURE_AXES, type AxisStructureSummary, type SectorStructureAxisKey, type SectorStructureTaxonomy } from '@/lib/sector-structure'
import {
  calculateSectorMarketBaseline,
  calculateSectorStageDeltas,
  findDominantStageChange,
  parseSectorStageComposition,
  type SectorDominantStageChange,
  type SectorMarketBaseline,
  type SectorStageComposition,
  type SectorStageDeltas,
} from '@/lib/sector-stage-distribution'
import {
  buildSectorStructureSeries,
  type SectorStructureSourceRow,
} from '@/lib/sector-structure-series'

export type SectorClassification = '17' | '33'
export type SectorHeatmapClassification = SectorClassification | 'major' | 'subIndustry'
export type SectorPeriod = 'today' | 'week' | 'month'

export interface SectorHeatmapRow {
  sector_code: string | null
  sector_name: string
  sector_parent_name: string | null
  n_stocks: number
  avg_change: number
  advancing_count: number
  declining_count: number
  avg_pms: number | null
  avg_pfs: number | null
  avg_pes: number | null
}

export interface SectorPeriodSummary {
  period: SectorPeriod
  label: string
  description: string
  latestDate: string
  baseDate: string
  rows17: SectorHeatmapRow[]
  rows33: SectorHeatmapRow[]
  rowsMajor: SectorHeatmapRow[]
  rowsSubIndustry: SectorHeatmapRow[]
}

export interface SectorAnalysisBoard {
  latestDate: string | null
  periods: SectorPeriodSummary[]
  universe: UniverseFilterValue
}

export interface SectorStructureRow {
  taxonomy: SectorStructureTaxonomy
  groupKey: string
  groupName: string
  parentGroup: string | null
  date: string
  nStocks: number
  validStageCount: number
  strengthScore: number | null
  transitionChangeScore: number
  momentum5d: number | null
  momentum10d: number | null
  momentum20d: number | null
  propagationDirection: 'improving' | 'deteriorating' | 'neutral'
  propagationPhase: number
  propagationLabel: string
  improvingCount: number
  deterioratingCount: number
  stableCount: number
  composition: SectorStageComposition
  dominantChange: SectorDominantStageChange | null
  axes?: Record<SectorStructureAxisKey, AxisStructureSummary>
  stageDeltas?: SectorStageDeltas
}

export interface SectorStructureBoard {
  latestDate: string | null
  previousDate: string | null
  taxonomy: SectorStructureTaxonomy
  universe: UniverseFilterValue
  parentFilter: string | null
  selectedGroupKey: string | null
  marketBaseline: SectorMarketBaseline
  rows: SectorStructureRow[]
}

export type SectorConstituentSortKey =
  | 'ticker'
  | 'name'
  | 'price'
  | 'changePct'
  | 'volume'
  | 'avgVolume30'
  | 'avgVolume60'
  | 'marginType'
  | 'stageCode'
  | 'marketSegment'
  | 'pms'
  | 'pfs'
  | 'pes'

export type SectorConstituentSortDir = 'asc' | 'desc'

export interface SectorConstituentRow {
  ticker: string
  name: string | null
  marketSegment: string | null
  marginType: string | null
  sector17Name: string | null
  sector33Name: string | null
  price: number | null
  changePct: number | null
  volume: number | null
  avgVolume30: number | null
  avgVolume60: number | null
  stageCode: string | null
  dailyAStage: number | null
  dailyBStage: number | null
  weeklyAStage: number | null
  weeklyBStage: number | null
  monthlyAStage: number | null
  monthlyBStage: number | null
  pms: number | null
  pfs: number | null
  pes: number | null
}

export interface SectorConstituentSummary {
  totalCount: number
  marginTypeCounts: Array<{ marginType: string; count: number }>
  avgChangePct: number | null
  totalVolume: number
  avgVolume30: number | null
  avgPms: number | null
  avgPfs: number | null
  avgPes: number | null
}

export interface SectorConstituentResult {
  classification: SectorClassification
  sectorName: string
  latestDate: string
  baseDate: string
  sortKey: SectorConstituentSortKey
  sortDir: SectorConstituentSortDir
  marginType: string | null
  rows: SectorConstituentRow[]
  summary: SectorConstituentSummary
}

const PERIODS: Array<{ period: SectorPeriod; label: string; description: string }> = [
  { period: 'today', label: '本日', description: '前営業日終値比' },
  { period: 'week', label: '今週', description: '直近5営業日前比' },
  { period: 'month', label: '今月', description: '前月最終営業日比' },
]

async function getLatestPriceDate(): Promise<string | null> {
  return (await execGet<{ d: string | null }>(`SELECT MAX(date) AS d FROM ohlcv_daily`))?.d ?? null
}

async function getPreviousTradingDate(date: string): Promise<string | null> {
  return (await execGet<{ d: string | null }>(
    `SELECT MAX(date) AS d FROM ohlcv_daily WHERE date < ?`,
    [date],
  ))?.d ?? null
}

async function getNthPreviousTradingDate(date: string, sessions: number): Promise<string | null> {
  const row = await execGet<{ d: string | null }>(
    `
      SELECT date AS d
      FROM (
        SELECT DISTINCT date
        FROM ohlcv_daily
        WHERE date <= ?
        ORDER BY date DESC
        LIMIT ?
      )
      ORDER BY date ASC
      LIMIT 1
    `,
    [date, sessions + 1],
  )
  return row?.d ?? null
}

async function getPreviousMonthEndTradingDate(date: string): Promise<string | null> {
  return (await execGet<{ d: string | null }>(
    `SELECT MAX(date) AS d FROM ohlcv_daily WHERE date < date(?, 'start of month')`,
    [date],
  ))?.d ?? null
}

async function resolveBaseDate(period: SectorPeriod, latestDate: string): Promise<string | null> {
  if (period === 'today') return getPreviousTradingDate(latestDate)
  if (period === 'week') {
    const base = await getNthPreviousTradingDate(latestDate, 5)
    return base && base !== latestDate ? base : getPreviousTradingDate(latestDate)
  }
  return await getPreviousMonthEndTradingDate(latestDate) ?? getPreviousTradingDate(latestDate)
}

function sectorColumns(classification: SectorHeatmapClassification) {
  if (classification === '17') {
    return {
      code: 'tu.sector17_code',
      name: `COALESCE(NULLIF(tu.sector17_name, ''), 'その他')`,
      parent: 'NULL',
      hasName: `tu.sector17_name IS NOT NULL AND tu.sector17_name <> ''`,
      classificationJoin: '',
    }
  }
  if (classification === '33') {
    return {
      code: 'tu.sector33_code',
      name: `COALESCE(NULLIF(tu.sector33_name, ''), 'その他')`,
      parent: 'NULL',
      hasName: `tu.sector33_name IS NOT NULL AND tu.sector33_name <> ''`,
      classificationJoin: '',
    }
  }
  if (classification === 'major') {
    return {
      code: 'sc.major_category',
      name: 'sc.major_category',
      parent: 'NULL',
      hasName: `sc.major_category IS NOT NULL AND sc.major_category <> ''`,
      classificationJoin: 'JOIN stock_classification sc ON sc.ticker = tu.ticker',
    }
  }
  return {
    code: `sc.major_category || char(31) || sc.sub_industry`,
    name: 'sc.sub_industry',
    parent: 'sc.major_category',
    hasName: `sc.major_category IS NOT NULL AND sc.major_category <> '' AND sc.sub_industry IS NOT NULL AND sc.sub_industry <> ''`,
    classificationJoin: 'JOIN stock_classification sc ON sc.ticker = tu.ticker',
  }
}

export async function getSectorHeatmapRows(
  classification: SectorHeatmapClassification,
  latestDate: string,
  baseDate: string,
  universeFilter: UniverseFilterValue = null,
): Promise<SectorHeatmapRow[]> {
  const cols = sectorColumns(classification)
  const universe = universeSqlCondition('tu.ticker', universeFilter)
  return execAll<SectorHeatmapRow>(
    `
      WITH latest_px AS (
        SELECT ticker, close
        FROM ohlcv_daily
        WHERE date = ?
      ),
      base_px AS (
        SELECT ticker, close
        FROM ohlcv_daily
        WHERE date = ?
      ),
      priced AS (
        SELECT
          tu.ticker,
          ${cols.code} AS sector_code,
          ${cols.name} AS sector_name,
          ${cols.parent} AS sector_parent_name,
          CASE
            WHEN base_px.close > 0 THEN 100.0 * (latest_px.close - base_px.close) / base_px.close
          END AS change_pct,
          pm.physical_momentum_score AS pms,
          pm.physical_force_score AS pfs,
          pm.physical_energy_score AS pes
        FROM ticker_universe tu
        ${cols.classificationJoin}
        JOIN latest_px ON latest_px.ticker = tu.ticker
        JOIN base_px ON base_px.ticker = tu.ticker
        LEFT JOIN physical_momentum_metrics pm ON pm.market = 'JP' AND pm.symbol = tu.ticker AND pm.date = ?
        WHERE tu.active = 1
          AND ${cols.hasName}
          ${universe.sql ? `AND ${universe.sql}` : ''}
      )
      SELECT
        sector_code,
        sector_name,
        sector_parent_name,
        COUNT(*) AS n_stocks,
        COALESCE(AVG(change_pct), 0) AS avg_change,
        SUM(CASE WHEN change_pct > 0 THEN 1 ELSE 0 END) AS advancing_count,
        SUM(CASE WHEN change_pct < 0 THEN 1 ELSE 0 END) AS declining_count,
        AVG(pms) AS avg_pms,
        AVG(pfs) AS avg_pfs,
        AVG(pes) AS avg_pes
      FROM priced
      GROUP BY sector_code, sector_name, sector_parent_name
      ORDER BY avg_change DESC
    `,
    [latestDate, baseDate, latestDate, ...universe.params],
  )
}

export async function getSectorAnalysisBoard(
  universeFilter: UniverseFilterValue = null,
  options: {
    classifications?: readonly SectorHeatmapClassification[]
    periods?: readonly SectorPeriod[]
  } = {},
): Promise<SectorAnalysisBoard> {
  const latestDate = await getLatestPriceDate()
  if (!latestDate) return { latestDate: null, periods: [], universe: universeFilter }

  const classifications = new Set<SectorHeatmapClassification>(options.classifications ?? ['17', '33'])
  const periodMetas = options.periods?.length
    ? PERIODS.filter((meta) => options.periods?.includes(meta.period))
    : PERIODS
  const periods: SectorPeriodSummary[] = []
  for (const periodMeta of periodMetas) {
    const baseDate = await resolveBaseDate(periodMeta.period, latestDate)
    if (!baseDate) continue
    const [rows17, rows33, rowsMajor, rowsSubIndustry] = await Promise.all([
      classifications.has('17') ? getSectorHeatmapRows('17', latestDate, baseDate, universeFilter) : Promise.resolve([]),
      classifications.has('33') ? getSectorHeatmapRows('33', latestDate, baseDate, universeFilter) : Promise.resolve([]),
      classifications.has('major') ? getSectorHeatmapRows('major', latestDate, baseDate, universeFilter) : Promise.resolve([]),
      classifications.has('subIndustry') ? getSectorHeatmapRows('subIndustry', latestDate, baseDate, universeFilter) : Promise.resolve([]),
    ])
    periods.push({
      ...periodMeta,
      latestDate,
      baseDate,
      rows17,
      rows33,
      rowsMajor,
      rowsSubIndustry,
    })
  }

  return { latestDate, periods, universe: universeFilter }
}

function parseAxisJson(raw: string): Record<SectorStructureAxisKey, AxisStructureSummary> {
  const fallback = Object.fromEntries(SECTOR_STRUCTURE_AXES.map((axis) => [axis.key, {
    validCount: 0,
    stages: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0 },
    strength: null,
    improving: 0,
    deteriorating: 0,
    stable: 0,
    jumpImproving: 0,
    jumpDeteriorating: 0,
    changeScore: 0,
  }])) as Record<SectorStructureAxisKey, AxisStructureSummary>
  try {
    const parsed = JSON.parse(raw) as Partial<Record<SectorStructureAxisKey, AxisStructureSummary>>
    for (const axis of SECTOR_STRUCTURE_AXES) {
      const value = parsed[axis.key]
      if (value && typeof value === 'object') fallback[axis.key] = { ...fallback[axis.key], ...value }
    }
  } catch {
    // 集計途中または旧レコードは空の構成比として表示し、画面を落とさない。
  }
  return fallback
}

async function getSector33ParentMap(): Promise<Map<string, string>> {
  const rows = await execAll<{ groupKey: string; parentGroup: string }>(`
    SELECT
      COALESCE(NULLIF(sector33_code, ''), sector33_name) AS groupKey,
      MIN(sector17_name) AS parentGroup
    FROM ticker_universe
    WHERE active = 1
      AND sector33_name IS NOT NULL AND sector33_name <> ''
      AND sector17_name IS NOT NULL AND sector17_name <> ''
    GROUP BY COALESCE(NULLIF(sector33_code, ''), sector33_name)
    HAVING COUNT(DISTINCT sector17_name) = 1
  `)
  return new Map(rows.map((row) => [row.groupKey, row.parentGroup]))
}

export async function resolveSectorStructureParentFromGroup(
  taxonomy: SectorStructureTaxonomy,
  groupKey: string | null | undefined,
): Promise<string | null> {
  const cleanGroupKey = groupKey?.trim() || null
  if (!cleanGroupKey) return null
  if (taxonomy === 'subIndustry') {
    const separator = cleanGroupKey.indexOf('\u001f')
    return separator > 0 ? cleanGroupKey.slice(0, separator) : null
  }
  if (taxonomy === '33') return (await getSector33ParentMap()).get(cleanGroupKey) ?? null
  return null
}

function compositionFromAxes(
  axes: Record<SectorStructureAxisKey, AxisStructureSummary>,
): SectorStageComposition {
  return Object.fromEntries(SECTOR_STRUCTURE_AXES.map((axis) => [
    axis.key,
    { ...axes[axis.key].stages },
  ])) as SectorStageComposition
}

async function loadUniverseSectorStructureRows(
  taxonomy: SectorStructureTaxonomy,
  requestedDate: string,
  universeFilter: Exclude<UniverseFilterValue, null>,
): Promise<{
  latestDate: string | null
  previousDate: string | null
  rows: Array<SectorStructureRow & {
    axes: Record<SectorStructureAxisKey, AxisStructureSummary>
    stageDeltas: SectorStageDeltas
  }>
}> {
  const universe = universeSqlCondition('tu.ticker', universeFilter)
  const sourceRows = await execAll<SectorStructureSourceRow>(`
    WITH selected_dates AS (
      SELECT date
      FROM (
        SELECT DISTINCT date
        FROM daily_snapshots
        WHERE date <= ?
        ORDER BY date DESC
        LIMIT 21
      )
    ),
    source AS (
      SELECT
        s.ticker,
        s.date,
        s.daily_a_stage AS dailyA,
        s.daily_b_stage AS dailyB,
        s.weekly_a_stage AS weeklyA,
        s.weekly_b_stage AS weeklyB,
        s.monthly_a_stage AS monthlyA,
        s.monthly_b_stage AS monthlyB,
        LAG(s.daily_a_stage) OVER (PARTITION BY s.ticker ORDER BY s.date) AS prevDailyA,
        LAG(s.daily_b_stage) OVER (PARTITION BY s.ticker ORDER BY s.date) AS prevDailyB,
        LAG(s.weekly_a_stage) OVER (PARTITION BY s.ticker ORDER BY s.date) AS prevWeeklyA,
        LAG(s.weekly_b_stage) OVER (PARTITION BY s.ticker ORDER BY s.date) AS prevWeeklyB,
        LAG(s.monthly_a_stage) OVER (PARTITION BY s.ticker ORDER BY s.date) AS prevMonthlyA,
        LAG(s.monthly_b_stage) OVER (PARTITION BY s.ticker ORDER BY s.date) AS prevMonthlyB
      FROM daily_snapshots AS s
      INNER JOIN selected_dates AS d ON d.date = s.date
    )
    SELECT
      source.*,
      tu.sector17_code AS sector17Code,
      tu.sector17_name AS sector17Name,
      tu.sector33_code AS sector33Code,
      tu.sector33_name AS sector33Name,
      sc.major_category AS majorCategory,
      sc.sub_industry AS subIndustry
    FROM source
    INNER JOIN ticker_universe AS tu ON tu.ticker = source.ticker AND tu.active = 1
    LEFT JOIN stock_classification AS sc ON sc.ticker = source.ticker
    WHERE source.date > (SELECT MIN(date) FROM selected_dates)
      AND ${universe.sql}
    ORDER BY source.date, source.ticker
  `, [requestedDate, ...universe.params])

  const series = buildSectorStructureSeries(sourceRows, [taxonomy])
  const dates = [...new Set(series.map((row) => row.date))].sort((a, b) => b.localeCompare(a))
  const latestDate = dates[0] ?? null
  const previousDate = dates[1] ?? null
  if (!latestDate) return { latestDate: null, previousDate: null, rows: [] }

  const sector33Parents = taxonomy === '33' ? await getSector33ParentMap() : new Map<string, string>()
  const previousByGroup = new Map(
    series
      .filter((row) => row.date === previousDate)
      .map((row) => [row.groupKey, compositionFromAxes(row.axes)]),
  )
  const rows = series
    .filter((row) => row.date === latestDate)
    .map((row) => {
      const composition = compositionFromAxes(row.axes)
      const previousComposition = previousByGroup.get(row.groupKey) ?? null
      const stageDeltas = calculateSectorStageDeltas(composition, previousComposition)
      return {
        ...row,
        parentGroup: row.parentGroup ?? sector33Parents.get(row.groupKey) ?? null,
        composition,
        stageDeltas,
        dominantChange: previousComposition ? findDominantStageChange(stageDeltas) : null,
      }
    })
  return { latestDate, previousDate, rows }
}

export async function getSectorStructureBoard(
  taxonomy: SectorStructureTaxonomy = 'major',
  options: {
    selectedGroupKey?: string | null
    parentFilter?: string | null
    requestedDate?: string | null
    includeAxesForAll?: boolean
    universeFilter?: UniverseFilterValue
  } = {},
): Promise<SectorStructureBoard> {
  const universeFilter = options.universeFilter ?? null
  const requestedDate = options.requestedDate && /^\d{4}-\d{2}-\d{2}$/.test(options.requestedDate)
    ? options.requestedDate
    : null
  const latest = await execGet<{ date: string | null }>(`
    SELECT MAX(date) AS date
    FROM sector_structure_daily
    WHERE taxonomy = ?
      ${requestedDate ? 'AND date <= ?' : ''}
  `, requestedDate ? [taxonomy, requestedDate] : [taxonomy])
  if (!latest?.date) {
    return {
      latestDate: null,
      previousDate: null,
      taxonomy,
      universe: universeFilter,
      parentFilter: null,
      selectedGroupKey: null,
      marketBaseline: calculateSectorMarketBaseline([]),
      rows: [],
    }
  }
  let resolvedLatestDate = latest.date
  let resolvedPreviousDate: string | null = null
  let prepared: Array<SectorStructureRow & {
    axes: Record<SectorStructureAxisKey, AxisStructureSummary>
    stageDeltas: SectorStageDeltas
  }>

  if (universeFilter) {
    const dynamicBoard = await loadUniverseSectorStructureRows(taxonomy, latest.date, universeFilter)
    resolvedLatestDate = dynamicBoard.latestDate ?? latest.date
    resolvedPreviousDate = dynamicBoard.previousDate
    prepared = dynamicBoard.rows
  } else {
    const previous = await execGet<{ date: string | null }>(`
      SELECT MAX(date) AS date
      FROM sector_structure_daily
      WHERE taxonomy = ? AND date < ?
    `, [taxonomy, latest.date])
    resolvedPreviousDate = previous?.date ?? null
    const raw = await execAll<{
      taxonomy: SectorStructureTaxonomy
      groupKey: string
      groupName: string
      parentGroup: string | null
      date: string
      nStocks: number
      validStageCount: number
      strengthScore: number | null
      transitionChangeScore: number
      momentum5d: number | null
      momentum10d: number | null
      momentum20d: number | null
      propagationDirection: 'improving' | 'deteriorating' | 'neutral'
      propagationPhase: number
      propagationLabel: string
      improvingCount: number
      deterioratingCount: number
      stableCount: number
      axisJson: string
      compositionJson: string
      previousCompositionJson: string | null
    }>(`
      SELECT
        current.taxonomy,
        current.group_key AS groupKey,
        current.group_name AS groupName,
        current.parent_group AS parentGroup,
        current.date,
        current.n_stocks AS nStocks,
        current.valid_stage_count AS validStageCount,
        current.strength_score AS strengthScore,
        current.transition_change_score AS transitionChangeScore,
        current.momentum_5d AS momentum5d,
        current.momentum_10d AS momentum10d,
        current.momentum_20d AS momentum20d,
        current.propagation_direction AS propagationDirection,
        current.propagation_phase AS propagationPhase,
        current.propagation_label AS propagationLabel,
        current.improving_count AS improvingCount,
        current.deteriorating_count AS deterioratingCount,
        current.stable_count AS stableCount,
        current.axis_json AS axisJson,
        current.composition_json AS compositionJson,
        previous.composition_json AS previousCompositionJson
      FROM sector_structure_daily AS current
      LEFT JOIN sector_structure_daily AS previous
        ON previous.taxonomy = current.taxonomy
       AND previous.group_key = current.group_key
       AND previous.date = ?
      WHERE current.taxonomy = ? AND current.date = ?
      ORDER BY current.momentum_10d DESC, current.strength_score DESC, current.group_name
    `, [resolvedPreviousDate ?? '', taxonomy, latest.date])

    const sector33Parents = taxonomy === '33' ? await getSector33ParentMap() : new Map<string, string>()
    prepared = raw.map(({ axisJson, compositionJson, previousCompositionJson, ...row }) => {
      const composition = parseSectorStageComposition(compositionJson)
      const previousComposition = previousCompositionJson
        ? parseSectorStageComposition(previousCompositionJson)
        : null
      const stageDeltas = calculateSectorStageDeltas(composition, previousComposition)
      return {
        ...row,
        parentGroup: row.parentGroup ?? sector33Parents.get(row.groupKey) ?? null,
        composition,
        axes: parseAxisJson(axisJson),
        stageDeltas,
        dominantChange: previousComposition ? findDominantStageChange(stageDeltas) : null,
      }
    })
  }
  const marketBaseline = calculateSectorMarketBaseline(prepared)
  const inferredParent = await resolveSectorStructureParentFromGroup(taxonomy, options.selectedGroupKey)
  const requestedParent = options.parentFilter?.trim() || inferredParent
  const parentRows = requestedParent
    ? prepared.filter((row) => row.parentGroup === requestedParent)
    : prepared
  const isChildTaxonomy = taxonomy === 'subIndustry' || taxonomy === '33'
  const fallbackParent = isChildTaxonomy
    ? [...prepared]
        .sort((a, b) => Math.abs(b.momentum10d ?? 0) - Math.abs(a.momentum10d ?? 0))[0]
        ?.parentGroup ?? null
    : null
  const resolvedParent = requestedParent && parentRows.length > 0
    ? requestedParent
    : fallbackParent
  const fallbackRows = resolvedParent
    ? prepared.filter((row) => row.parentGroup === resolvedParent)
    : prepared
  const rowsInScope = requestedParent && parentRows.length > 0 ? parentRows : fallbackRows
  const requestedGroup = options.selectedGroupKey?.trim() || null
  const defaultGroup = [...rowsInScope]
    .sort((a, b) => Math.abs(b.momentum10d ?? 0) - Math.abs(a.momentum10d ?? 0))[0]
    ?.groupKey ?? null
  const selectedGroupKey = requestedGroup && rowsInScope.some((row) => row.groupKey === requestedGroup)
    ? requestedGroup
    : defaultGroup

  return {
    latestDate: resolvedLatestDate,
    previousDate: resolvedPreviousDate,
    taxonomy,
    universe: universeFilter,
    parentFilter: resolvedParent,
    selectedGroupKey,
    marketBaseline,
    rows: rowsInScope.map(({ axes, stageDeltas, ...row }) => ({
      ...row,
      ...(options.includeAxesForAll || row.groupKey === selectedGroupKey
        ? { axes, stageDeltas }
        : {}),
    })),
  }
}

function normalizeSortKey(value: string | null | undefined): SectorConstituentSortKey {
  if (
    value === 'ticker' ||
    value === 'name' ||
    value === 'price' ||
    value === 'changePct' ||
    value === 'volume' ||
    value === 'avgVolume30' ||
    value === 'avgVolume60' ||
    value === 'marginType' ||
    value === 'stageCode' ||
    value === 'marketSegment' ||
    value === 'pms' ||
    value === 'pfs' ||
    value === 'pes'
  ) {
    return value
  }
  return 'changePct'
}

function normalizeSortDir(value: string | null | undefined): SectorConstituentSortDir {
  return value === 'asc' ? 'asc' : 'desc'
}

function constituentOrderBy(sortKey: SectorConstituentSortKey, sortDir: SectorConstituentSortDir): string {
  const dir = sortDir === 'asc' ? 'ASC' : 'DESC'
  const nulls = sortDir === 'asc' ? 'ASC' : 'DESC'
  const orderMap: Record<SectorConstituentSortKey, string> = {
    ticker: `ticker ${dir}`,
    name: `name ${dir}, ticker ASC`,
    price: `price IS NULL ASC, price ${dir}, ticker ASC`,
    changePct: `changePct IS NULL ASC, changePct ${dir}, ticker ASC`,
    volume: `volume IS NULL ASC, volume ${dir}, ticker ASC`,
    avgVolume30: `avgVolume30 IS NULL ASC, avgVolume30 ${dir}, ticker ASC`,
    avgVolume60: `avgVolume60 IS NULL ASC, avgVolume60 ${dir}, ticker ASC`,
    marginType: `marginType IS NULL ASC, marginType ${dir}, ticker ASC`,
    stageCode: `stageCode IS NULL ASC, stageCode ${dir}, ticker ASC`,
    marketSegment: `marketSegment IS NULL ASC, marketSegment ${dir}, ticker ASC`,
    pms: `pms IS NULL ASC, pms ${dir}, ticker ASC`,
    pfs: `pfs IS NULL ASC, pfs ${dir}, ticker ASC`,
    pes: `pes IS NULL ASC, pes ${dir}, ticker ASC`,
  }
  return orderMap[sortKey] ?? `changePct IS NULL ${nulls}, changePct ${dir}, ticker ASC`
}

export function normalizeSectorConstituentSort(
  sortKey?: string | null,
  sortDir?: string | null,
): { sortKey: SectorConstituentSortKey; sortDir: SectorConstituentSortDir } {
  return {
    sortKey: normalizeSortKey(sortKey),
    sortDir: normalizeSortDir(sortDir),
  }
}

export async function getSectorConstituents({
  classification,
  sectorName,
  latestDate,
  baseDate,
  sortKey,
  sortDir,
  marginType,
  universeFilter = null,
  limit = 1000,
}: {
  classification: SectorClassification
  sectorName: string
  latestDate: string
  baseDate: string
  sortKey?: string | null
  sortDir?: string | null
  marginType?: string | null
  universeFilter?: UniverseFilterValue
  limit?: number
}): Promise<SectorConstituentResult> {
  const normalized = normalizeSectorConstituentSort(sortKey, sortDir)
  const cols = sectorColumns(classification)
  const universe = universeSqlCondition('tu.ticker', universeFilter)
  const cleanMarginType = marginType?.trim() || null
  const maxRows = Math.min(1000, Math.max(1, Math.floor(limit)))
  const params: Array<string | number> = [latestDate, baseDate, latestDate, latestDate, latestDate, latestDate, sectorName]
  if (cleanMarginType) params.push(cleanMarginType)
  params.push(...universe.params)
  params.push(maxRows)

  const rows = await execAll<SectorConstituentRow>(
    `
      WITH latest_px AS (
        SELECT ticker, close, volume
        FROM ohlcv_daily
        WHERE date = ?
      ),
      base_px AS (
        SELECT ticker, close
        FROM ohlcv_daily
        WHERE date = ?
      ),
      latest_snap AS (
        SELECT
          ticker,
          daily_a_stage,
          daily_b_stage,
          weekly_a_stage,
          weekly_b_stage,
          monthly_a_stage,
          monthly_b_stage
        FROM daily_snapshots
        WHERE date = ?
      )
      SELECT
        tu.ticker AS ticker,
        tu.name AS name,
        tu.market_segment AS marketSegment,
        tu.margin_type AS marginType,
        tu.sector17_name AS sector17Name,
        tu.sector33_name AS sector33Name,
        latest_px.close AS price,
        CASE
          WHEN base_px.close > 0 THEN 100.0 * (latest_px.close - base_px.close) / base_px.close
        END AS changePct,
        latest_px.volume AS volume,
        (
          SELECT ROUND(AVG(volume))
          FROM (
            SELECT od.volume
            FROM ohlcv_daily od
            WHERE od.ticker = tu.ticker AND od.date <= ?
            ORDER BY od.date DESC
            LIMIT 30
          )
        ) AS avgVolume30,
        (
          SELECT ROUND(AVG(volume))
          FROM (
            SELECT od.volume
            FROM ohlcv_daily od
            WHERE od.ticker = tu.ticker AND od.date <= ?
            ORDER BY od.date DESC
            LIMIT 60
          )
        ) AS avgVolume60,
        CASE
          WHEN latest_snap.daily_a_stage IS NOT NULL
            AND latest_snap.daily_b_stage IS NOT NULL
            AND latest_snap.weekly_a_stage IS NOT NULL
            AND latest_snap.weekly_b_stage IS NOT NULL
            AND latest_snap.monthly_a_stage IS NOT NULL
            AND latest_snap.monthly_b_stage IS NOT NULL
          THEN
            CAST(latest_snap.daily_a_stage AS TEXT) ||
            CAST(latest_snap.daily_b_stage AS TEXT) ||
            CAST(latest_snap.weekly_a_stage AS TEXT) ||
            CAST(latest_snap.weekly_b_stage AS TEXT) ||
            CAST(latest_snap.monthly_a_stage AS TEXT) ||
            CAST(latest_snap.monthly_b_stage AS TEXT)
        END AS stageCode,
        latest_snap.daily_a_stage AS dailyAStage,
        latest_snap.daily_b_stage AS dailyBStage,
        latest_snap.weekly_a_stage AS weeklyAStage,
        latest_snap.weekly_b_stage AS weeklyBStage,
        latest_snap.monthly_a_stage AS monthlyAStage,
        latest_snap.monthly_b_stage AS monthlyBStage,
        pm.physical_momentum_score AS pms,
        pm.physical_force_score AS pfs,
        pm.physical_energy_score AS pes
      FROM ticker_universe tu
      JOIN latest_px ON latest_px.ticker = tu.ticker
      JOIN base_px ON base_px.ticker = tu.ticker
      LEFT JOIN latest_snap ON latest_snap.ticker = tu.ticker
      LEFT JOIN physical_momentum_metrics pm ON pm.market = 'JP' AND pm.symbol = tu.ticker AND pm.date = ?
      WHERE tu.active = 1
        AND ${cols.hasName}
        AND ${cols.name} = ?
        ${cleanMarginType ? 'AND COALESCE(NULLIF(tu.margin_type, \'\'), \'未設定\') = ?' : ''}
        ${universe.sql ? `AND ${universe.sql}` : ''}
      ORDER BY ${constituentOrderBy(normalized.sortKey, normalized.sortDir)}
      LIMIT ?
    `,
    params,
  )

  const totalCount = rows.length
  const totalVolume = rows.reduce((sum, row) => sum + (row.volume ?? 0), 0)
  const avgChangeValues = rows.map((row) => row.changePct).filter((value): value is number => value != null && Number.isFinite(value))
  const avgVolumeValues = rows.map((row) => row.avgVolume30).filter((value): value is number => value != null && Number.isFinite(value))
  const pmsValues = rows.map((row) => row.pms).filter((value): value is number => value != null && Number.isFinite(value))
  const pfsValues = rows.map((row) => row.pfs).filter((value): value is number => value != null && Number.isFinite(value))
  const pesValues = rows.map((row) => row.pes).filter((value): value is number => value != null && Number.isFinite(value))
  const marginCounts = new Map<string, number>()
  for (const row of rows) {
    const key = row.marginType?.trim() || '未設定'
    marginCounts.set(key, (marginCounts.get(key) ?? 0) + 1)
  }

  return {
    classification,
    sectorName,
    latestDate,
    baseDate,
    sortKey: normalized.sortKey,
    sortDir: normalized.sortDir,
    marginType: cleanMarginType,
    rows,
    summary: {
      totalCount,
      marginTypeCounts: Array.from(marginCounts.entries())
        .map(([type, count]) => ({ marginType: type, count }))
        .sort((a, b) => b.count - a.count || a.marginType.localeCompare(b.marginType, 'ja')),
      avgChangePct: avgChangeValues.length > 0
        ? avgChangeValues.reduce((sum, value) => sum + value, 0) / avgChangeValues.length
        : null,
      totalVolume,
      avgVolume30: avgVolumeValues.length > 0
        ? avgVolumeValues.reduce((sum, value) => sum + value, 0) / avgVolumeValues.length
        : null,
      avgPms: pmsValues.length > 0
        ? pmsValues.reduce((sum, value) => sum + value, 0) / pmsValues.length
        : null,
      avgPfs: pfsValues.length > 0
        ? pfsValues.reduce((sum, value) => sum + value, 0) / pfsValues.length
        : null,
      avgPes: pesValues.length > 0
        ? pesValues.reduce((sum, value) => sum + value, 0) / pesValues.length
        : null,
    },
  }
}
