import { execAll, execGet } from '@/lib/db/client'
import { type UniverseFilterValue, universeSqlCondition } from '@/lib/market-universe'
import { SECTOR_STRUCTURE_AXES, type AxisStructureSummary, type SectorStructureAxisKey, type SectorStructureTaxonomy } from '@/lib/sector-structure'

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
  axes?: Record<SectorStructureAxisKey, AxisStructureSummary>
}

export interface SectorStructureBoard {
  latestDate: string | null
  taxonomy: SectorStructureTaxonomy
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

export async function getSectorStructureBoard(
  taxonomy: SectorStructureTaxonomy = 'major',
): Promise<SectorStructureBoard> {
  const latest = await execGet<{ date: string | null }>(`
    SELECT MAX(date) AS date FROM sector_structure_daily WHERE taxonomy = ?
  `, [taxonomy])
  if (!latest?.date) return { latestDate: null, taxonomy, rows: [] }
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
  }>(`
    SELECT
      taxonomy,
      group_key AS groupKey,
      group_name AS groupName,
      parent_group AS parentGroup,
      date,
      n_stocks AS nStocks,
      valid_stage_count AS validStageCount,
      strength_score AS strengthScore,
      transition_change_score AS transitionChangeScore,
      momentum_5d AS momentum5d,
      momentum_10d AS momentum10d,
      momentum_20d AS momentum20d,
      propagation_direction AS propagationDirection,
      propagation_phase AS propagationPhase,
      propagation_label AS propagationLabel,
      improving_count AS improvingCount,
      deteriorating_count AS deterioratingCount,
      stable_count AS stableCount,
      axis_json AS axisJson
    FROM sector_structure_daily
    WHERE taxonomy = ? AND date = ?
    ORDER BY momentum_10d DESC, strength_score DESC, group_name
  `, [taxonomy, latest.date])
  // 軽量な一覧では軸別の大きなJSONを送らず、詳細展開に使う上位24件だけに付与する。
  const detailKeys = new Set(
    [...raw]
      .sort((a, b) => Math.abs(b.momentum10d ?? 0) - Math.abs(a.momentum10d ?? 0))
      .slice(0, 24)
      .map((row) => row.groupKey),
  )
  return {
    latestDate: latest.date,
    taxonomy,
    rows: raw.map(({ axisJson, ...row }) => ({
      ...row,
      ...(detailKeys.has(row.groupKey) ? { axes: parseAxisJson(axisJson) } : {}),
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
