import { execAll } from '@/lib/db/client'
import { execUsAnalyticsAll, execUsAnalyticsGet } from '@/lib/db/us-analytics'
import { US_SEC_SIC_TAXONOMY } from '@/lib/us-classification'
import { usInvestableSymbolSql } from '@/lib/us-symbol-quality'

export type UsClassificationAvailability = 'CURRENT' | 'CURRENT_DATE_ONLY'
export type UsMomentumLane = 'initial' | 'continuation' | 'stall' | 'drop'

export type UsMarketMomentumRow = {
  ticker: string
  name: string | null
  exchange: string | null
  sectorCode: string | null
  sector: string | null
  industryCode: string | null
  industry: string | null
  price: number | null
  volume: number | null
  changePct: number | null
  return1w: number | null
  return1m: number | null
  pms: number | null
  pfs: number | null
  pes: number | null
  dailyAStage: number | null
  dailyBStage: number | null
  weeklyAStage: number | null
  weeklyBStage: number | null
  monthlyAStage: number | null
  monthlyBStage: number | null
}

export type UsMarketGroup = {
  key: string
  label: string
  count: number
  avgPms: number | null
  avgPfs: number | null
  avgPes: number | null
  avgChangePct: number | null
  avgReturn1w: number | null
  avgReturn1m: number | null
  positivePmsPct: number | null
  stage1Pct: number | null
}

export type UsMarketMomentumSummary = {
  count: number
  positivePms: number
  negativePms: number
  strongPms: number
  weakPms: number
  positivePfs: number
  highPes: number
  advancing: number
  declining: number
  avgPms: number | null
  avgPfs: number | null
  avgPes: number | null
}

export type UsMarketIntelligence = {
  latestDate: string | null
  date: string | null
  requestedDate: string | null
  isLatest: boolean
  classificationAvailability: UsClassificationAvailability
  summary: UsMarketMomentumSummary
  rows: UsMarketMomentumRow[]
  lanes: Record<UsMomentumLane, UsMarketMomentumRow[]>
  exchanges: UsMarketGroup[]
  sectors: UsMarketGroup[]
  industries: UsMarketGroup[]
  coverage: {
    momentumRows: number
    stageRows: number
    classifiedRows: number
    classificationPct: number | null
  }
}

type AnalyticsRow = {
  ticker: string
  price: number | null
  volume: number | null
  change_pct: number | null
  return_1w: number | null
  return_1m: number | null
  pms: number | null
  pfs: number | null
  pes: number | null
  daily_a_stage: number | null
  daily_b_stage: number | null
  weekly_a_stage: number | null
  weekly_b_stage: number | null
  monthly_a_stage: number | null
  monthly_b_stage: number | null
}

type MetadataRow = {
  ticker: string
  name: string | null
  exchange: string | null
  sector_code: string | null
  sector_name: string | null
  industry_code: string | null
  industry_name: string | null
}

function finite(value: unknown): number | null {
  if (value == null || value === '') return null
  const number = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(number) ? number : null
}

function average(values: Array<number | null>): number | null {
  const present = values.filter((value): value is number => value != null && Number.isFinite(value))
  if (present.length === 0) return null
  return present.reduce((sum, value) => sum + value, 0) / present.length
}

function ratio(part: number, total: number): number | null {
  return total > 0 ? (part / total) * 100 : null
}

function compareDesc(a: number | null, b: number | null): number {
  if (a == null && b == null) return 0
  if (a == null) return 1
  if (b == null) return -1
  return b - a
}

function compareAsc(a: number | null, b: number | null): number {
  if (a == null && b == null) return 0
  if (a == null) return 1
  if (b == null) return -1
  return a - b
}

function byTicker(a: UsMarketMomentumRow, b: UsMarketMomentumRow): number {
  return a.ticker.localeCompare(b.ticker, 'en')
}

export function rankUsMomentumRows(
  rows: UsMarketMomentumRow[],
  lane: UsMomentumLane,
): UsMarketMomentumRow[] {
  const eligible = lane === 'stall'
    ? rows.filter((row) => row.pms != null && row.pms > 0 && row.pfs != null && row.pfs < 0)
    : lane === 'continuation'
      ? rows.filter((row) => row.pms != null && row.pms > 0 && row.pfs != null && row.pfs >= 0)
      : lane === 'drop'
        ? rows.filter((row) => row.pms != null && row.pms < 0 && row.pfs != null && row.pfs <= 0)
        : rows.filter((row) => row.pfs != null && row.pfs > 0)

  return [...eligible].sort((a, b) => {
    if (lane === 'initial') return compareDesc(a.pfs, b.pfs) || compareDesc(a.pms, b.pms) || byTicker(a, b)
    if (lane === 'continuation') return compareDesc(a.pms, b.pms) || compareDesc(a.pfs, b.pfs) || byTicker(a, b)
    if (lane === 'stall') return compareAsc(a.pfs, b.pfs) || compareDesc(a.pms, b.pms) || byTicker(a, b)
    return compareAsc(a.pms, b.pms) || compareAsc(a.pfs, b.pfs) || byTicker(a, b)
  })
}

function buildSummary(rows: UsMarketMomentumRow[]): UsMarketMomentumSummary {
  return {
    count: rows.length,
    positivePms: rows.filter((row) => row.pms != null && row.pms > 0).length,
    negativePms: rows.filter((row) => row.pms != null && row.pms < 0).length,
    strongPms: rows.filter((row) => row.pms != null && row.pms >= 1).length,
    weakPms: rows.filter((row) => row.pms != null && row.pms <= -1).length,
    positivePfs: rows.filter((row) => row.pfs != null && row.pfs > 0).length,
    highPes: rows.filter((row) => row.pes != null && row.pes >= 1).length,
    advancing: rows.filter((row) => row.changePct != null && row.changePct > 0).length,
    declining: rows.filter((row) => row.changePct != null && row.changePct < 0).length,
    avgPms: average(rows.map((row) => row.pms)),
    avgPfs: average(rows.map((row) => row.pfs)),
    avgPes: average(rows.map((row) => row.pes)),
  }
}

function buildGroups(
  rows: UsMarketMomentumRow[],
  keyFor: (row: UsMarketMomentumRow) => string | null,
  labelFor: (row: UsMarketMomentumRow) => string | null,
): UsMarketGroup[] {
  const buckets = new Map<string, { label: string; rows: UsMarketMomentumRow[] }>()
  for (const row of rows) {
    const key = keyFor(row)?.trim()
    const label = labelFor(row)?.trim()
    if (!key || !label) continue
    const bucket = buckets.get(key) ?? { label, rows: [] }
    bucket.rows.push(row)
    buckets.set(key, bucket)
  }

  return [...buckets.entries()].map(([key, bucket]) => {
    const stageRows = bucket.rows.filter((row) => row.dailyAStage != null)
    return {
      key,
      label: bucket.label,
      count: bucket.rows.length,
      avgPms: average(bucket.rows.map((row) => row.pms)),
      avgPfs: average(bucket.rows.map((row) => row.pfs)),
      avgPes: average(bucket.rows.map((row) => row.pes)),
      avgChangePct: average(bucket.rows.map((row) => row.changePct)),
      avgReturn1w: average(bucket.rows.map((row) => row.return1w)),
      avgReturn1m: average(bucket.rows.map((row) => row.return1m)),
      positivePmsPct: ratio(bucket.rows.filter((row) => row.pms != null && row.pms > 0).length, bucket.rows.length),
      stage1Pct: ratio(stageRows.filter((row) => row.dailyAStage === 1).length, stageRows.length),
    }
  }).sort((a, b) => compareDesc(a.avgPms, b.avgPms) || b.count - a.count || a.label.localeCompare(b.label, 'en'))
}

export function buildUsMarketIntelligence(input: {
  latestDate: string | null
  date: string | null
  requestedDate: string | null
  analyticsRows: AnalyticsRow[]
  metadataRows: MetadataRow[]
}): UsMarketIntelligence {
  const isLatest = Boolean(input.date && input.latestDate && input.date === input.latestDate)
  const metadata = new Map(input.metadataRows.map((row) => [row.ticker, row]))
  const rows = input.analyticsRows.map<UsMarketMomentumRow>((row) => {
    const meta = metadata.get(row.ticker)
    return {
      ticker: row.ticker,
      name: meta?.name ?? null,
      exchange: isLatest ? meta?.exchange ?? null : null,
      sectorCode: isLatest ? meta?.sector_code ?? null : null,
      sector: isLatest ? meta?.sector_name ?? null : null,
      industryCode: isLatest ? meta?.industry_code ?? null : null,
      industry: isLatest ? meta?.industry_name ?? null : null,
      price: finite(row.price),
      volume: finite(row.volume),
      changePct: finite(row.change_pct),
      return1w: finite(row.return_1w),
      return1m: finite(row.return_1m),
      pms: finite(row.pms),
      pfs: finite(row.pfs),
      pes: finite(row.pes),
      dailyAStage: finite(row.daily_a_stage),
      dailyBStage: finite(row.daily_b_stage),
      weeklyAStage: finite(row.weekly_a_stage),
      weeklyBStage: finite(row.weekly_b_stage),
      monthlyAStage: finite(row.monthly_a_stage),
      monthlyBStage: finite(row.monthly_b_stage),
    }
  })

  const stageRows = rows.filter((row) => (
    row.dailyAStage != null
    && row.dailyBStage != null
    && row.weeklyAStage != null
    && row.weeklyBStage != null
    && row.monthlyAStage != null
    && row.monthlyBStage != null
  ))
  const classifiedRows = isLatest ? rows.filter((row) => row.sectorCode != null) : []
  return {
    latestDate: input.latestDate,
    date: input.date,
    requestedDate: input.requestedDate,
    isLatest,
    classificationAvailability: isLatest ? 'CURRENT' : 'CURRENT_DATE_ONLY',
    summary: buildSummary(rows),
    rows,
    lanes: {
      initial: rankUsMomentumRows(rows, 'initial').slice(0, 12),
      continuation: rankUsMomentumRows(rows, 'continuation').slice(0, 12),
      stall: rankUsMomentumRows(rows, 'stall').slice(0, 12),
      drop: rankUsMomentumRows(rows, 'drop').slice(0, 12),
    },
    exchanges: isLatest ? buildGroups(rows, (row) => row.exchange, (row) => row.exchange) : [],
    sectors: isLatest ? buildGroups(rows, (row) => row.sectorCode, (row) => row.sector) : [],
    industries: isLatest ? buildGroups(rows, (row) => row.industryCode, (row) => row.industry) : [],
    coverage: {
      momentumRows: rows.length,
      stageRows: stageRows.length,
      classifiedRows: classifiedRows.length,
      classificationPct: isLatest ? ratio(classifiedRows.length, rows.length) : null,
    },
  }
}

async function resolveDates(requestedDate: string | null): Promise<{ latestDate: string | null; date: string | null }> {
  const [latest, resolved] = await Promise.all([
    execUsAnalyticsGet<{ date: string | null }>(`
      SELECT pm.date AS date
      FROM physical_momentum_metrics pm
      WHERE pm.market = 'US'
        AND EXISTS (SELECT 1 FROM daily_snapshots ds WHERE ds.date = pm.date)
        AND EXISTS (SELECT 1 FROM ohlcv_daily px WHERE px.date = pm.date)
      ORDER BY pm.date DESC
      LIMIT 1
    `),
    execUsAnalyticsGet<{ date: string | null }>(`
      SELECT pm.date AS date
      FROM physical_momentum_metrics pm
      WHERE pm.market = 'US'
        AND (? IS NULL OR pm.date <= ?)
        AND EXISTS (SELECT 1 FROM daily_snapshots ds WHERE ds.date = pm.date)
        AND EXISTS (SELECT 1 FROM ohlcv_daily px WHERE px.date = pm.date)
      ORDER BY pm.date DESC
      LIMIT 1
    `, [requestedDate, requestedDate]),
  ])
  return { latestDate: latest?.date ?? null, date: resolved?.date ?? null }
}

async function loadAnalyticsRows(date: string): Promise<AnalyticsRow[]> {
  return execUsAnalyticsAll<AnalyticsRow>(`
    WITH anchors AS (
      SELECT
        (SELECT MAX(date) FROM ohlcv_daily WHERE date < ?) AS prev_date,
        (SELECT MAX(date) FROM ohlcv_daily WHERE date <= date(?, '-7 days')) AS week_date,
        (SELECT MAX(date) FROM ohlcv_daily WHERE date <= date(?, '-1 month')) AS month_date
    )
    SELECT
      pm.symbol AS ticker,
      cur.close AS price,
      cur.volume AS volume,
      CASE WHEN prev.close > 0 THEN 100.0 * (cur.close - prev.close) / prev.close END AS change_pct,
      CASE WHEN week.close > 0 THEN 100.0 * (cur.close - week.close) / week.close END AS return_1w,
      CASE WHEN month.close > 0 THEN 100.0 * (cur.close - month.close) / month.close END AS return_1m,
      pm.physical_momentum_score AS pms,
      pm.physical_force_score AS pfs,
      pm.physical_energy_score AS pes,
      ds.daily_a_stage,
      ds.daily_b_stage,
      ds.weekly_a_stage,
      ds.weekly_b_stage,
      ds.monthly_a_stage,
      ds.monthly_b_stage
    FROM physical_momentum_metrics pm
    JOIN ohlcv_daily cur ON cur.ticker = pm.symbol AND cur.date = ?
    CROSS JOIN anchors a
    LEFT JOIN ohlcv_daily prev ON prev.ticker = pm.symbol AND prev.date = a.prev_date
    LEFT JOIN ohlcv_daily week ON week.ticker = pm.symbol AND week.date = a.week_date
    LEFT JOIN ohlcv_daily month ON month.ticker = pm.symbol AND month.date = a.month_date
    LEFT JOIN daily_snapshots ds ON ds.ticker = pm.symbol AND ds.date = ?
    WHERE pm.market = 'US'
      AND pm.date = ?
      AND pm.physical_momentum_score IS NOT NULL
    ORDER BY pm.symbol
  `, [date, date, date, date, date, date])
}

async function loadMetadataRows(isLatest: boolean): Promise<MetadataRow[]> {
  if (!isLatest) {
    return execAll<MetadataRow>(`
      SELECT ticker, name, NULL AS exchange, NULL AS sector_code, NULL AS sector_name,
        NULL AS industry_code, NULL AS industry_name
      FROM market_universe
      WHERE market = 'US'
    `)
  }
  return execAll<MetadataRow>(`
    SELECT
      u.ticker,
      u.name,
      u.exchange,
      c.sector_code,
      c.sector_name,
      c.industry_code,
      c.industry_name
    FROM market_universe u INDEXED BY market_universe_market_active_idx
    LEFT JOIN market_classifications c
      ON c.market = 'US'
     AND c.ticker = u.ticker
     AND c.taxonomy = ?
     AND c.effective_from = '0000-01-01'
    WHERE u.market = 'US'
      AND u.active = 1
      AND COALESCE(u.asset_type, 'Stock') = 'Stock'
      AND ${usInvestableSymbolSql('u.ticker')}
  `, [US_SEC_SIC_TAXONOMY])
}

export async function loadUsMarketIntelligence(requestedDate: string | null): Promise<UsMarketIntelligence> {
  const dates = await resolveDates(requestedDate)
  if (!dates.date) {
    return buildUsMarketIntelligence({
      ...dates,
      requestedDate,
      analyticsRows: [],
      metadataRows: [],
    })
  }
  const isLatest = dates.date === dates.latestDate
  const [analyticsRows, metadataRows] = await Promise.all([
    loadAnalyticsRows(dates.date),
    loadMetadataRows(isLatest),
  ])
  const allowed = isLatest ? new Set(metadataRows.map((row) => row.ticker)) : null
  return buildUsMarketIntelligence({
    ...dates,
    requestedDate,
    analyticsRows: allowed ? analyticsRows.filter((row) => allowed.has(row.ticker)) : analyticsRows,
    metadataRows,
  })
}
