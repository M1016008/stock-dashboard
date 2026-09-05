import { execAll, execBatch, execGet, execRun } from '@/lib/db/client'
import { buildShortTermCheck } from '@/lib/short-term-check'
import { todayInTokyo } from '@/lib/date-time'
import { evaluateEvEbitda, METRIC_DEFINITION_REGISTRY } from '@/lib/financial-metrics'
import {
  SCREENING_METRIC_MAP,
  type IntegratedScreeningResponse,
  type IntegratedScreeningRow,
  type ScreeningCondition,
  type ScreeningCoverage,
  type ScreeningMetricKey,
  type ScreeningOperator,
} from '@/lib/integrated-screener'
import type { IntegratedScreeningEvaluationSet } from '@/lib/screener-evaluation'

export const SCREENING_SERVING_SOURCE_VERSION = 'integrated-screener-serving-v3'
const BUILD_WRITE_CHUNK = 80
const RESULT_CACHE_TTL_MS = 60_000
const responseCache = new Map<string, { expiresAt: number; value: IntegratedScreeningResponse }>()

type RawBaseRow = Record<string, unknown> & { ticker: string; name: string }
type MetricRow = { ticker: string; metric: string; value: number }
type FactRow = { ticker: string; metric: string; value: number; period_end: string; target_fiscal_year: number | null }
type ForecastRow = {
  ticker: string
  metric: string
  forecast_scope: string
  target_fiscal_year: number
  value: number
  previous_value: number | null
  published_at: string
}

export interface ScreeningServingBuildResult {
  asOf: string
  snapshotDate: string
  valuationDate: string | null
  rows: number
  elapsedMs: number
  cacheHit: boolean
}

export interface IntegratedScreeningReasonData {
  serving: ScreeningServingBuildResult
  row: IntegratedScreeningRow
  sector33Peers: IntegratedScreeningRow[]
  majorCategoryPeers: IntegratedScreeningRow[]
  sectorCount: number
}

const COLUMN_BY_METRIC: Record<ScreeningMetricKey, string> = {
  marketSegment: 'market_segment', sector17: 'sector17', sector33: 'sector33', majorCategory: 'major_category', subIndustry: 'sub_industry', marketCap: 'market_cap',
  revenue: 'revenue', revenueGrowth: 'revenue_growth', epsGrowth: 'eps_growth', revenueCagr3y: 'revenue_cagr_3y', revenueCagr5y: 'revenue_cagr_5y', operatingMargin: 'operating_margin',
  roe: 'roe', roa: 'roa', equityRatio: 'equity_ratio', standardFcf: 'standard_fcf', fcfYield: 'fcf_yield', netDebt: 'net_debt', roic: 'roic',
  per: 'per', forwardPer: 'forward_per', pbr: 'pbr', psr: 'psr', evEbitda: 'ev_ebitda', perPercentile5y: 'per_percentile_5y', pbrPercentile5y: 'pbr_percentile_5y', sectorValuationPercentile: 'sector_valuation_percentile',
  forecastDividendYield: 'forecast_dividend_yield', payoutRatio: 'payout_ratio', forecastDps: 'forecast_dps', dpsYoy: 'dps_yoy', consecutiveIncreaseYears: 'consecutive_increase_years', consecutiveNonDecreaseYears: 'consecutive_non_decrease_years', dpsCagr3y: 'dps_cagr_3y', dpsCagr5y: 'dps_cagr_5y',
  forecastRevenueGrowth: 'forecast_revenue_growth', forecastOperatingProfitGrowth: 'forecast_operating_profit_growth', forecastEpsGrowth: 'forecast_eps_growth', latestForecastRevisionRate: 'latest_forecast_revision_rate', latestForecastRevisionDirection: 'latest_forecast_revision_direction', hasCurrentForecast: 'has_current_forecast', hasNextForecast: 'has_next_forecast',
  dailyAStage: 'daily_a_stage', dailyBStage: 'daily_b_stage', weeklyAStage: 'weekly_a_stage', weeklyBStage: 'weekly_b_stage', monthlyAStage: 'monthly_a_stage', monthlyBStage: 'monthly_b_stage', stageCode: 'stage_code', sectorStructureScore: 'sector_structure_score', sectorRank: 'sector_rank', pms: 'pms', pfs: 'pfs', maStructure: 'ma_structure', shortTermCheck: 'short_term_check',
  creditRatio: 'credit_ratio', longMargin: 'long_margin', shortMargin: 'short_margin', longMarginChange: 'long_margin_change', shortMarginChange: 'short_margin_change',
}

const SELECT_COLUMNS = `
  ticker, as_of AS asOf, snapshot_date AS snapshotDate, valuation_date AS valuationDate, name,
  market_segment AS marketSegment, sector17, sector33, major_category AS majorCategory, sub_industry AS subIndustry,
  price, market_cap AS marketCap, revenue, revenue_growth AS revenueGrowth, eps_growth AS epsGrowth,
  revenue_cagr_3y AS revenueCagr3y, revenue_cagr_5y AS revenueCagr5y, operating_margin AS operatingMargin,
  roe, roa, equity_ratio AS equityRatio, standard_fcf AS standardFcf, fcf_yield AS fcfYield, net_debt AS netDebt, roic,
  per, forward_per AS forwardPer, pbr, psr, ev_ebitda AS evEbitda, per_percentile_5y AS perPercentile5y,
  pbr_percentile_5y AS pbrPercentile5y, sector_valuation_percentile AS sectorValuationPercentile,
  forecast_dividend_yield AS forecastDividendYield, payout_ratio AS payoutRatio, forecast_dps AS forecastDps,
  dps_yoy AS dpsYoy, consecutive_increase_years AS consecutiveIncreaseYears,
  consecutive_non_decrease_years AS consecutiveNonDecreaseYears, dps_cagr_3y AS dpsCagr3y, dps_cagr_5y AS dpsCagr5y,
  forecast_revenue_growth AS forecastRevenueGrowth, forecast_operating_profit_growth AS forecastOperatingProfitGrowth,
  forecast_eps_growth AS forecastEpsGrowth, latest_forecast_revision_rate AS latestForecastRevisionRate,
  latest_forecast_revision_direction AS latestForecastRevisionDirection,
  has_current_forecast AS hasCurrentForecast, has_next_forecast AS hasNextForecast,
  daily_a_stage AS dailyAStage, daily_b_stage AS dailyBStage, weekly_a_stage AS weeklyAStage,
  weekly_b_stage AS weeklyBStage, monthly_a_stage AS monthlyAStage, monthly_b_stage AS monthlyBStage,
  stage_code AS stageCode, sector_structure_score AS sectorStructureScore, sector_rank AS sectorRank,
  pms, pfs, ma_structure AS maStructure, short_term_check AS shortTermCheck,
  credit_ratio AS creditRatio, long_margin AS longMargin, short_margin AS shortMargin,
  long_margin_change AS longMarginChange, short_margin_change AS shortMarginChange
`

function asNumber(value: unknown): number | null {
  if (value == null) return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function asString(value: unknown): string | null {
  return value == null || String(value).trim() === '' ? null : String(value)
}

function isoDate(value: string | null | undefined): string {
  const clean = value?.trim().slice(0, 10)
  if (clean && /^\d{4}-\d{2}-\d{2}$/.test(clean)) return clean
  return todayInTokyo()
}

function subtractYears(date: string, years: number): string {
  const value = new Date(`${date}T00:00:00Z`)
  value.setUTCFullYear(value.getUTCFullYear() - years)
  return value.toISOString().slice(0, 10)
}

function ratioGrowth(current: number | null, previous: number | null): number | null {
  if (current == null || previous == null || previous === 0) return null
  return ((current / previous) - 1) * 100
}

function cagr(current: number | null, previous: number | null, years: number): number | null {
  if (current == null || previous == null || current <= 0 || previous <= 0) return null
  return (Math.pow(current / previous, 1 / years) - 1) * 100
}

function maStructure(row: RawBaseRow): string | null {
  const values = [asNumber(row.ma_5), asNumber(row.ma_25), asNumber(row.ma_75)]
  if (values.some((value) => value == null)) return null
  const [short, medium, long] = values as number[]
  if (short > medium && medium > long) return 'bullish_aligned'
  if (short < medium && medium < long) return 'bearish_aligned'
  const average = (short + medium + long) / 3
  if (average > 0 && (Math.max(...values as number[]) - Math.min(...values as number[])) / average <= 0.03) return 'converging'
  return 'mixed'
}

function percentile(values: number[], target: number | null): number | null {
  if (target == null || values.length === 0) return null
  let lowerOrEqual = 0
  for (const value of values) if (value <= target) lowerOrEqual += 1
  return 100 * lowerOrEqual / values.length
}

function metricMap(rows: MetricRow[]): Map<string, Map<string, number>> {
  const output = new Map<string, Map<string, number>>()
  for (const row of rows) {
    const values = output.get(row.ticker) ?? new Map<string, number>()
    values.set(row.metric, Number(row.value))
    output.set(row.ticker, values)
  }
  return output
}

function latestFactMap(rows: FactRow[]): Map<string, Map<string, FactRow>> {
  const output = new Map<string, Map<string, FactRow>>()
  for (const row of rows) {
    const values = output.get(row.ticker) ?? new Map<string, FactRow>()
    values.set(row.metric, row)
    output.set(row.ticker, values)
  }
  return output
}

function dividendStats(rows: FactRow[]): Map<string, {
  latest: number | null; yoy: number | null; increase: number; nonDecrease: number; cagr3: number | null; cagr5: number | null
}> {
  const grouped = new Map<string, FactRow[]>()
  for (const row of rows) grouped.set(row.ticker, [...(grouped.get(row.ticker) ?? []), row])
  const output = new Map<string, { latest: number | null; yoy: number | null; increase: number; nonDecrease: number; cagr3: number | null; cagr5: number | null }>()
  for (const [ticker, values] of grouped) {
    values.sort((a, b) => (b.target_fiscal_year ?? 0) - (a.target_fiscal_year ?? 0))
    const dps = values.map((row) => Number(row.value)).filter(Number.isFinite)
    let increase = 0
    let nonDecrease = 0
    for (let index = 0; index + 1 < dps.length; index += 1) {
      if (dps[index] > dps[index + 1]) increase += 1
      else break
    }
    for (let index = 0; index + 1 < dps.length; index += 1) {
      if (dps[index] >= dps[index + 1]) nonDecrease += 1
      else break
    }
    output.set(ticker, {
      latest: dps[0] ?? null,
      yoy: ratioGrowth(dps[0] ?? null, dps[1] ?? null),
      increase,
      nonDecrease,
      cagr3: cagr(dps[0] ?? null, dps[3] ?? null, 3),
      cagr5: cagr(dps[0] ?? null, dps[5] ?? null, 5),
    })
  }
  return output
}

function forecastMap(rows: ForecastRow[]): Map<string, Map<string, ForecastRow>> {
  const output = new Map<string, Map<string, ForecastRow>>()
  for (const row of rows) {
    const map = output.get(row.ticker) ?? new Map<string, ForecastRow>()
    map.set(`${row.forecast_scope}:${row.metric}`, row)
    output.set(row.ticker, map)
  }
  return output
}

async function loadBaseRows(snapshotDate: string, valuationDate: string | null, asOf: string): Promise<RawBaseRow[]> {
  return execAll<RawBaseRow>(`
    SELECT
      u.ticker, COALESCE(u.name, u.ticker) AS name, u.market_segment, u.sector17_name, u.sector33_name,
      c.major_category, c.sub_industry,
      d.ma_5, d.ma_25, d.ma_75, d.daily_a_stage, d.daily_b_stage, d.weekly_a_stage, d.weekly_b_stage,
      d.monthly_a_stage, d.monthly_b_stage,
      o.close AS price,
      CASE WHEN o.close > 0 AND u.shares_outstanding > 0 THEN o.close * u.shares_outstanding END AS market_cap,
      v.per, v.forward_per, v.pbr, v.psr, v.fcf_yield, v.ev_ebitda, v.net_debt, v.dividend_yield,
      v.roe, v.revenue_growth, v.enterprise_value, v.ebitda,
      p.physical_momentum_score AS pms, p.physical_force_score AS pfs,
      m.long_margin, m.short_margin, m.long_change, m.short_change,
      CASE WHEN m.short_margin > 0 THEN m.long_margin / m.short_margin END AS credit_ratio
    FROM ticker_universe u
    LEFT JOIN daily_snapshots d ON d.ticker = u.ticker AND d.date = ?
    LEFT JOIN ohlcv_daily o ON o.ticker = u.ticker AND o.date = ?
    LEFT JOIN valuation_daily_serving v ON v.ticker = u.ticker AND v.valuation_date = ?
    LEFT JOIN stock_classification c ON c.ticker = u.ticker
    LEFT JOIN physical_momentum_metrics p ON p.market = 'JP' AND p.symbol = u.ticker AND p.date = ?
    LEFT JOIN weekly_margin_interest m ON m.ticker = u.ticker AND m.date = (
      SELECT MAX(m2.date) FROM weekly_margin_interest m2 WHERE m2.ticker = u.ticker AND m2.date <= ?
    )
    WHERE u.active = 1
    ORDER BY u.ticker
  `, [snapshotDate, snapshotDate, valuationDate ?? '', snapshotDate, asOf])
}

async function loadLatestMetrics(asOf: string): Promise<MetricRow[]> {
  return execAll<MetricRow>(`
    WITH ranked AS (
      SELECT ticker, metric, value,
             ROW_NUMBER() OVER (PARTITION BY ticker, metric ORDER BY as_of DESC, computed_at DESC, value_id DESC) AS rn
      FROM calculated_financial_metrics
      WHERE as_of <= ? AND (metric <> 'ev_ebitda' OR definition_version = ?) AND metric IN (
        'eps_growth','revenue_cagr_3y','revenue_cagr_5y','roe','roa','standard_fcf','fcf_yield','net_debt','roic',
        'per','forward_per','pbr','psr','ev_ebitda','dividend_yield','payout_ratio','revenue_growth'
      )
    )
    SELECT ticker, metric, value FROM ranked WHERE rn = 1
  `, [asOf, METRIC_DEFINITION_REGISTRY.ev_ebitda.version])
}

function tickerChunks(tickers: string[], size = 240): string[][] {
  const output: string[][] = []
  for (let index = 0; index < tickers.length; index += size) output.push(tickers.slice(index, index + size))
  return output
}

async function loadLatestLtmFacts(asOf: string, _tickers: string[]): Promise<FactRow[]> {
  const cutoff = `${asOf}T23:59:59+09:00`
  const rows = await execAll<Record<string, unknown>>(`
    SELECT u.ticker,
      (SELECT value FROM normalized_financial_facts f WHERE f.ticker=u.ticker AND f.metric='revenue' AND f.accumulation_kind='LTM' AND f.published_at<=? ORDER BY f.period_end DESC, f.published_at DESC, f.fact_id DESC LIMIT 1) AS revenue,
      (SELECT value FROM normalized_financial_facts f WHERE f.ticker=u.ticker AND f.metric='operating_profit' AND f.accumulation_kind='LTM' AND f.published_at<=? ORDER BY f.period_end DESC, f.published_at DESC, f.fact_id DESC LIMIT 1) AS operating_profit,
      (SELECT value FROM normalized_financial_facts f WHERE f.ticker=u.ticker AND f.metric='total_assets' AND f.accumulation_kind='INSTANT' AND f.published_at<=? ORDER BY f.period_end DESC, f.published_at DESC, f.fact_id DESC LIMIT 1) AS total_assets,
      (SELECT value FROM normalized_financial_facts f WHERE f.ticker=u.ticker AND f.metric='equity_attributable' AND f.accumulation_kind='INSTANT' AND f.published_at<=? ORDER BY f.period_end DESC, f.published_at DESC, f.fact_id DESC LIMIT 1) AS equity_attributable
    FROM ticker_universe u WHERE u.active=1 ORDER BY u.ticker
  `, [cutoff, cutoff, cutoff, cutoff])
  const output: FactRow[] = []
  for (const row of rows) {
    for (const metric of ['revenue', 'operating_profit', 'total_assets', 'equity_attributable']) {
      const value = asNumber(row[metric])
      if (value != null) output.push({ ticker: String(row.ticker), metric, value, period_end: asOf, target_fiscal_year: null })
    }
  }
  return output
}

async function loadLatestFyFacts(asOf: string, _tickers: string[]): Promise<{ latest: FactRow[]; dividends: FactRow[] }> {
  const cutoff = `${asOf}T23:59:59+09:00`
  const rows = await execAll<Record<string, unknown>>(`
    SELECT u.ticker,
      (SELECT value FROM normalized_financial_facts f WHERE f.ticker=u.ticker AND f.metric='revenue' AND f.period_kind='FY' AND f.accumulation_kind='FY' AND f.published_at<=? ORDER BY f.period_end DESC, f.published_at DESC, f.fact_id DESC LIMIT 1) AS revenue,
      (SELECT value FROM normalized_financial_facts f WHERE f.ticker=u.ticker AND f.metric='operating_profit' AND f.period_kind='FY' AND f.accumulation_kind='FY' AND f.published_at<=? ORDER BY f.period_end DESC, f.published_at DESC, f.fact_id DESC LIMIT 1) AS operating_profit,
      (SELECT value FROM normalized_financial_facts f WHERE f.ticker=u.ticker AND f.metric='eps_basic' AND f.period_kind='FY' AND f.accumulation_kind='FY' AND f.published_at<=? ORDER BY f.period_end DESC, f.published_at DESC, f.fact_id DESC LIMIT 1) AS eps_basic
    FROM ticker_universe u WHERE u.active=1 ORDER BY u.ticker
  `, [cutoff, cutoff, cutoff])
  const latest: FactRow[] = []
  for (const row of rows) {
    for (const metric of ['revenue', 'operating_profit', 'eps_basic']) {
      const value = asNumber(row[metric])
      if (value != null) latest.push({ ticker: String(row.ticker), metric, value, period_end: asOf, target_fiscal_year: null })
    }
  }
  const dividendRows = await execAll<FactRow & { published_at: string }>(`
    SELECT f.ticker, f.metric, f.value, f.period_end, f.target_fiscal_year, f.published_at
    FROM ticker_universe u JOIN normalized_financial_facts f ON f.ticker=u.ticker AND f.metric='dividend_per_share_annual'
    WHERE u.active=1 AND f.published_at<=? AND f.period_kind='FY' AND f.accumulation_kind='FY'
    ORDER BY f.ticker, f.target_fiscal_year DESC, f.period_end DESC, f.published_at DESC, f.fact_id DESC
  `, [cutoff])
  const dividends: FactRow[] = []
  const seenYear = new Set<string>()
  const counts = new Map<string, number>()
  for (const row of dividendRows) {
    const yearKey = `${row.ticker}\u001f${row.target_fiscal_year ?? row.period_end.slice(0, 4)}`
    if (seenYear.has(yearKey)) continue
    seenYear.add(yearKey)
    const count = counts.get(row.ticker) ?? 0
    if (count >= 10) continue
    counts.set(row.ticker, count + 1)
    dividends.push(row)
  }
  return {
    latest,
    dividends,
  }
}

async function loadLatestForecasts(asOf: string, tickers: string[]): Promise<ForecastRow[]> {
  const output: ForecastRow[] = []
  for (const chunk of tickerChunks(tickers)) {
    const rows = await execAll<Omit<ForecastRow, 'previous_value'>>(`
      SELECT ticker, metric, forecast_scope, target_fiscal_year, value, published_at
      FROM financial_forecast_snapshots
      WHERE ticker IN (${chunk.map(() => '?').join(',')}) AND published_at <= ? AND forecast_period = 'FY'
        AND forecast_scope IN ('current_fy','next_fy')
        AND metric IN ('revenue','operating_profit','eps_basic','dividend_per_share_annual')
      ORDER BY ticker, metric, forecast_scope, published_at DESC, target_fiscal_year DESC, snapshot_id DESC
    `, [...chunk, `${asOf}T23:59:59+09:00`])
    const selected = new Map<string, ForecastRow>()
    for (const row of rows) {
      const key = `${row.ticker}\u001f${row.metric}\u001f${row.forecast_scope}`
      const current = selected.get(key)
      if (!current) {
        selected.set(key, { ...row, previous_value: null })
      } else if (current.previous_value == null && current.target_fiscal_year === row.target_fiscal_year) {
        current.previous_value = Number(row.value)
      }
    }
    output.push(...selected.values())
  }
  return output
}

async function loadValuationPercentiles(asOf: string, valuationDate: string | null): Promise<Map<string, { per: number | null; pbr: number | null }>> {
  if (!valuationDate) return new Map()
  const rows = await execAll<{ ticker: string; per_percentile: number | null; pbr_percentile: number | null }>(`
    WITH current_values AS (
      SELECT ticker, per, pbr FROM valuation_daily_serving WHERE valuation_date = ?
    )
    SELECT c.ticker,
      CASE WHEN c.per IS NOT NULL AND COUNT(h.per) > 0
        THEN 100.0 * SUM(CASE WHEN h.per <= c.per THEN 1 ELSE 0 END) / COUNT(h.per) END AS per_percentile,
      CASE WHEN c.pbr IS NOT NULL AND COUNT(h.pbr) > 0
        THEN 100.0 * SUM(CASE WHEN h.pbr <= c.pbr THEN 1 ELSE 0 END) / COUNT(h.pbr) END AS pbr_percentile
    FROM current_values c
    LEFT JOIN valuation_daily_serving h ON h.ticker = c.ticker
      AND h.valuation_date BETWEEN ? AND ?
    GROUP BY c.ticker
  `, [valuationDate, subtractYears(asOf, 5), valuationDate])
  return new Map(rows.map((row) => [row.ticker, { per: asNumber(row.per_percentile), pbr: asNumber(row.pbr_percentile) }]))
}

async function loadSectorStructures(asOf: string): Promise<Map<string, { score: number | null; rank: number }>> {
  const date = await execGet<{ date: string | null }>(`
    SELECT MAX(date) AS date FROM sector_structure_daily WHERE taxonomy = '33' AND date <= ?
  `, [asOf])
  if (!date?.date) return new Map()
  const rows = await execAll<{ group_name: string; strength_score: number | null }>(`
    SELECT group_name, strength_score FROM sector_structure_daily
    WHERE taxonomy = '33' AND date = ? ORDER BY strength_score DESC, group_name
  `, [date.date])
  return new Map(rows.map((row, index) => [row.group_name, { score: asNumber(row.strength_score), rank: index + 1 }]))
}

function revisionDirection(rate: number | null): string | null {
  if (rate == null) return null
  if (rate > 0.01) return 'up'
  if (rate < -0.01) return 'down'
  return 'unchanged'
}

function mapServingRow(
  base: RawBaseRow,
  asOf: string,
  snapshotDate: string,
  valuationDate: string | null,
  metrics: Map<string, number>,
  ltmFacts: Map<string, FactRow>,
  fyFacts: Map<string, FactRow>,
  forecasts: Map<string, ForecastRow>,
  dividends: ReturnType<typeof dividendStats> extends Map<string, infer V> ? V | undefined : never,
  valuationPercentiles: { per: number | null; pbr: number | null } | undefined,
  sectorStructure: { score: number | null; rank: number } | undefined,
): Record<string, unknown> {
  const get = (metric: string) => metrics.get(metric) ?? null
  const ltmRevenue = ltmFacts.get('revenue')?.value ?? null
  const ltmOperatingProfit = ltmFacts.get('operating_profit')?.value ?? null
  const latestFyRevenue = fyFacts.get('revenue')?.value ?? null
  const latestFyOperatingProfit = fyFacts.get('operating_profit')?.value ?? null
  const latestFyEps = fyFacts.get('eps_basic')?.value ?? null
  const currentRevenue = forecasts.get('current_fy:revenue')?.value ?? null
  const currentOperatingProfit = forecasts.get('current_fy:operating_profit')?.value ?? null
  const currentEps = forecasts.get('current_fy:eps_basic')?.value ?? null
  const forecastDps = forecasts.get('current_fy:dividend_per_share_annual')?.value ?? null
  const revisionSource = forecasts.get('current_fy:operating_profit') ?? forecasts.get('current_fy:eps_basic') ?? forecasts.get('current_fy:revenue')
  const revisionRate = ratioGrowth(revisionSource?.value ?? null, revisionSource?.previous_value ?? null)
  const stages = [base.daily_a_stage, base.daily_b_stage, base.weekly_a_stage, base.weekly_b_stage, base.monthly_a_stage, base.monthly_b_stage]
    .map(asNumber)
  const stageCode = stages.every((value) => value != null) ? stages.join('') : null
  const shortTerm = buildShortTermCheck({
    stages: {
      dailyA: stages[0], dailyB: stages[1], weeklyA: stages[2], weeklyB: stages[3], monthlyA: stages[4], monthlyB: stages[5],
    },
    physicalMomentumScore: asNumber(base.pms),
    physicalForceScore: asNumber(base.pfs),
  })
  const equity = ltmFacts.get('equity_attributable')?.value ?? null
  const assets = ltmFacts.get('total_assets')?.value ?? null
  const evEbitda = evaluateEvEbitda(asNumber(base.enterprise_value), asNumber(base.ebitda))
  return {
    ticker: base.ticker, as_of: asOf, snapshot_date: snapshotDate, valuation_date: valuationDate,
    name: base.name, market_segment: asString(base.market_segment), sector17: asString(base.sector17_name),
    sector33: asString(base.sector33_name), major_category: asString(base.major_category), sub_industry: asString(base.sub_industry),
    price: asNumber(base.price), market_cap: asNumber(base.market_cap), revenue: ltmRevenue,
    revenue_growth: get('revenue_growth') ?? asNumber(base.revenue_growth), eps_growth: get('eps_growth'),
    revenue_cagr_3y: get('revenue_cagr_3y'), revenue_cagr_5y: get('revenue_cagr_5y'),
    operating_margin: ltmRevenue && ltmOperatingProfit != null ? 100 * ltmOperatingProfit / ltmRevenue : null,
    roe: get('roe') ?? asNumber(base.roe), roa: get('roa'), equity_ratio: assets && equity != null ? 100 * equity / assets : null,
    standard_fcf: get('standard_fcf'), fcf_yield: get('fcf_yield') ?? asNumber(base.fcf_yield), net_debt: get('net_debt') ?? asNumber(base.net_debt), roic: get('roic'),
    per: get('per') ?? asNumber(base.per), forward_per: get('forward_per') ?? asNumber(base.forward_per), pbr: get('pbr') ?? asNumber(base.pbr),
    psr: get('psr') ?? asNumber(base.psr), ev_ebitda: evEbitda.value,
    per_percentile_5y: valuationPercentiles?.per ?? null, pbr_percentile_5y: valuationPercentiles?.pbr ?? null,
    sector_valuation_percentile: null,
    forecast_dividend_yield: get('dividend_yield') ?? asNumber(base.dividend_yield), payout_ratio: get('payout_ratio'), forecast_dps: forecastDps,
    dps_yoy: dividends?.yoy ?? null, consecutive_increase_years: dividends?.increase ?? null,
    consecutive_non_decrease_years: dividends?.nonDecrease ?? null, dps_cagr_3y: dividends?.cagr3 ?? null, dps_cagr_5y: dividends?.cagr5 ?? null,
    forecast_revenue_growth: ratioGrowth(currentRevenue, latestFyRevenue),
    forecast_operating_profit_growth: ratioGrowth(currentOperatingProfit, latestFyOperatingProfit),
    forecast_eps_growth: ratioGrowth(currentEps, latestFyEps),
    latest_forecast_revision_rate: revisionRate, latest_forecast_revision_direction: revisionDirection(revisionRate),
    has_current_forecast: [...forecasts.keys()].some((key) => key.startsWith('current_fy:')) ? 1 : 0,
    has_next_forecast: [...forecasts.keys()].some((key) => key.startsWith('next_fy:')) ? 1 : 0,
    daily_a_stage: stages[0], daily_b_stage: stages[1], weekly_a_stage: stages[2], weekly_b_stage: stages[3],
    monthly_a_stage: stages[4], monthly_b_stage: stages[5], stage_code: stageCode,
    sector_structure_score: sectorStructure?.score ?? null, sector_rank: sectorStructure?.rank ?? null,
    pms: asNumber(base.pms), pfs: asNumber(base.pfs), ma_structure: maStructure(base),
    short_term_check: shortTerm.label, short_term_score: shortTerm.score,
    credit_ratio: asNumber(base.credit_ratio), long_margin: asNumber(base.long_margin), short_margin: asNumber(base.short_margin),
    long_margin_change: asNumber(base.long_change), short_margin_change: asNumber(base.short_change),
    source_version: SCREENING_SERVING_SOURCE_VERSION, calculated_at: Math.floor(Date.now() / 1000),
  }
}

function applySectorPercentiles(rows: Record<string, unknown>[]): void {
  const sectors = new Map<string, Record<string, unknown>[]>()
  for (const row of rows) {
    const key = asString(row.sector33)
    if (!key) continue
    sectors.set(key, [...(sectors.get(key) ?? []), row])
  }
  for (const sectorRows of sectors.values()) {
    const values = sectorRows.map((row) => asNumber(row.forward_per)).filter((value): value is number => value != null && value > 0)
    for (const row of sectorRows) row.sector_valuation_percentile = percentile(values, asNumber(row.forward_per))
  }
}

async function writeServingRows(rows: Record<string, unknown>[]): Promise<void> {
  if (rows.length === 0) return
  const columns = Object.keys(rows[0])
  const placeholders = columns.map(() => '?').join(',')
  const updates = columns.filter((column) => column !== 'ticker' && column !== 'as_of')
    .map((column) => `${column}=excluded.${column}`).join(',')
  for (let index = 0; index < rows.length; index += BUILD_WRITE_CHUNK) {
    const chunk = rows.slice(index, index + BUILD_WRITE_CHUNK)
    await execBatch(chunk.map((row) => ({
      sql: `INSERT INTO stock_screening_serving (${columns.join(',')}) VALUES (${placeholders})
        ON CONFLICT(ticker, as_of) DO UPDATE SET ${updates}`,
      args: columns.map((column) => row[column] == null ? null : row[column] as string | number),
    })))
  }
}

export async function buildScreeningServingDate(requestedAsOf?: string | null, force = false): Promise<ScreeningServingBuildResult> {
  const startedAt = Date.now()
  const asOf = isoDate(requestedAsOf)
  const existing = await execGet<{ status: string; row_count: number; snapshot_date: string; valuation_date: string | null; source_version: string }>(`
    SELECT status, row_count, snapshot_date, valuation_date, source_version
    FROM stock_screening_serving_dates WHERE as_of = ?
  `, [asOf])
  if (!force && existing?.status === 'completed' && existing.source_version === SCREENING_SERVING_SOURCE_VERSION && Number(existing.row_count) > 0) {
    return { asOf, snapshotDate: existing.snapshot_date, valuationDate: existing.valuation_date, rows: Number(existing.row_count), elapsedMs: Date.now() - startedAt, cacheHit: true }
  }
  const dates = await execGet<{ snapshot_date: string | null; valuation_date: string | null }>(`
    SELECT
      (SELECT MAX(date) FROM daily_snapshots WHERE date <= ?) AS snapshot_date,
      (SELECT MAX(valuation_date) FROM valuation_daily_serving WHERE valuation_date <= ?) AS valuation_date
  `, [asOf, asOf])
  if (!dates?.snapshot_date) throw new Error(`No daily snapshot is available on or before ${asOf}`)
  if (!dates.valuation_date) throw new Error(`No Valuation Serving is available on or before ${asOf}`)
  if (dates.valuation_date !== dates.snapshot_date) {
    throw new Error(`Valuation Serving is stale: quote/snapshot=${dates.snapshot_date}, valuation=${dates.valuation_date}`)
  }
  await execRun(`
    INSERT INTO stock_screening_serving_dates(as_of, snapshot_date, valuation_date, row_count, source_version, status, calculated_at)
    VALUES (?, ?, ?, 0, ?, 'building', unixepoch())
    ON CONFLICT(as_of) DO UPDATE SET snapshot_date=excluded.snapshot_date, valuation_date=excluded.valuation_date,
      source_version=excluded.source_version, status='building', error_message=NULL, calculated_at=unixepoch()
  `, [asOf, dates.snapshot_date, dates.valuation_date, SCREENING_SERVING_SOURCE_VERSION])
  try {
    const baseRows = await loadBaseRows(dates.snapshot_date, dates.valuation_date, asOf)
    const tickers = baseRows.map((row) => row.ticker)
    const metricRows = await loadLatestMetrics(asOf)
    const ltmRows = await loadLatestLtmFacts(asOf, tickers)
    const fyData = await loadLatestFyFacts(asOf, tickers)
    const forecastRows = await loadLatestForecasts(asOf, tickers)
    const valuationPercentiles = await loadValuationPercentiles(asOf, dates.valuation_date)
    const sectorStructures = await loadSectorStructures(asOf)
    const metrics = metricMap(metricRows)
    const ltmFacts = latestFactMap(ltmRows)
    const latestFyFacts = latestFactMap(fyData.latest)
    const forecasts = forecastMap(forecastRows)
    const dividends = dividendStats(fyData.dividends)
    const rows = baseRows.map((base) => mapServingRow(
      base, asOf, dates.snapshot_date!, dates.valuation_date,
      metrics.get(base.ticker) ?? new Map(), ltmFacts.get(base.ticker) ?? new Map(), latestFyFacts.get(base.ticker) ?? new Map(),
      forecasts.get(base.ticker) ?? new Map(), dividends.get(base.ticker), valuationPercentiles.get(base.ticker),
      sectorStructures.get(asString(base.sector33_name) ?? ''),
    ))
    applySectorPercentiles(rows)
    await writeServingRows(rows)
    await execRun(`
      UPDATE stock_screening_serving_dates SET row_count=?, status='completed', error_message=NULL, calculated_at=unixepoch()
      WHERE as_of=?
    `, [rows.length, asOf])
    for (const key of responseCache.keys()) {
      if (key.includes(`"asOf":"${asOf}"`)) responseCache.delete(key)
    }
    return { asOf, snapshotDate: dates.snapshot_date, valuationDate: dates.valuation_date, rows: rows.length, elapsedMs: Date.now() - startedAt, cacheHit: false }
  } catch (error) {
    await execRun(`UPDATE stock_screening_serving_dates SET status='error', error_message=?, calculated_at=unixepoch() WHERE as_of=?`, [error instanceof Error ? error.message.slice(0, 1000) : String(error).slice(0, 1000), asOf])
    throw error
  }
}

function conditionSql(condition: ScreeningCondition, args: Array<string | number>): string | null {
  const column = COLUMN_BY_METRIC[condition.metric]
  const definition = SCREENING_METRIC_MAP.get(condition.metric)
  if (!column || !definition || !definition.operators.includes(condition.operator)) return null
  if (condition.operator === 'has_data') return `${column} IS NOT NULL`
  if (condition.operator === 'between') {
    const first = asNumber(condition.value)
    const second = asNumber(condition.valueTo)
    if (first == null || second == null) return null
    args.push(first, second)
    return `${column} BETWEEN ? AND ?`
  }
  if (condition.operator === 'in') {
    const values = Array.isArray(condition.value) ? condition.value : [condition.value]
    const clean = values.filter((value): value is string | number => typeof value === 'string' || typeof value === 'number')
    if (clean.length === 0) return null
    args.push(...clean)
    return `${column} IN (${clean.map(() => '?').join(',')})`
  }
  const value = typeof condition.value === 'boolean' ? (condition.value ? 1 : 0) : condition.value
  if (typeof value !== 'string' && typeof value !== 'number') return null
  if (typeof value === 'string' && value.trim() === '') return null
  args.push(value)
  const operatorMap: Record<Exclude<ScreeningOperator, 'between' | 'in' | 'has_data'>, string> = { gte: '>=', gt: '>', lte: '<=', lt: '<', eq: '=' }
  return `${column} ${operatorMap[condition.operator as keyof typeof operatorMap]} ?`
}

function sortSql(metric: ScreeningMetricKey | null | undefined, direction: 'asc' | 'desc'): string {
  const column = metric ? COLUMN_BY_METRIC[metric] : null
  return column ? `${column} IS NULL ASC, ${column} ${direction.toUpperCase()}, ticker ASC` : 'market_cap IS NULL ASC, market_cap DESC, ticker ASC'
}

function rowFromDb(row: Record<string, unknown>): IntegratedScreeningRow {
  const numericKeys = new Set<ScreeningMetricKey>([...SCREENING_METRIC_MAP.values()].filter((value) => !['text', 'boolean'].includes(value.valueType)).map((value) => value.key))
  const output = { ...row } as unknown as IntegratedScreeningRow
  for (const key of numericKeys) (output as unknown as Record<string, unknown>)[key] = asNumber(row[key])
  output.price = asNumber(row.price)
  output.hasCurrentForecast = row.hasCurrentForecast == null ? null : Boolean(row.hasCurrentForecast)
  output.hasNextForecast = row.hasNextForecast == null ? null : Boolean(row.hasNextForecast)
  return output
}

export async function evaluateIntegratedScreeningSet(input: {
  asOf?: string | null
  conditions: ScreeningCondition[]
}): Promise<IntegratedScreeningEvaluationSet> {
  const startedAt = Date.now()
  const serving = await buildScreeningServingDate(input.asOf)
  const args: Array<string | number> = [serving.asOf]
  const where = [
    's.as_of = ?',
    'EXISTS (SELECT 1 FROM ticker_universe u WHERE u.ticker=s.ticker AND u.active=1)',
  ]
  for (const condition of input.conditions.slice(0, 40)) {
    const sql = conditionSql(condition, args)
    if (sql) where.push(sql)
  }
  const rows = await execAll<Record<string, unknown>>(`
    SELECT ${SELECT_COLUMNS} FROM stock_screening_serving s
    WHERE ${where.join(' AND ')} ORDER BY s.ticker
  `, args)
  return {
    asOf: serving.asOf,
    snapshotDate: serving.snapshotDate,
    rows: rows.map(rowFromDb),
    elapsedMs: Date.now() - startedAt,
  }
}

export async function getIntegratedScreeningRowsAtDate(
  asOf: string,
  tickers: string[],
): Promise<Map<string, IntegratedScreeningRow>> {
  const output = new Map<string, IntegratedScreeningRow>()
  const unique = [...new Set(tickers.map((ticker) => ticker.trim()).filter(Boolean))]
  for (let index = 0; index < unique.length; index += 400) {
    const chunk = unique.slice(index, index + 400)
    const rows = await execAll<Record<string, unknown>>(`
      SELECT ${SELECT_COLUMNS} FROM stock_screening_serving s
      WHERE s.as_of = ? AND s.ticker IN (${chunk.map(() => '?').join(',')})
        AND EXISTS (SELECT 1 FROM ticker_universe u WHERE u.ticker=s.ticker AND u.active=1)
    `, [asOf, ...chunk])
    for (const row of rows.map(rowFromDb)) output.set(row.ticker, row)
  }
  return output
}

export async function getIntegratedScreeningReasonData(
  ticker: string,
  requestedAsOf?: string | null,
): Promise<IntegratedScreeningReasonData | null> {
  const serving = await buildScreeningServingDate(requestedAsOf)
  const rowRecord = await execGet<Record<string, unknown>>(`
    SELECT ${SELECT_COLUMNS} FROM stock_screening_serving s
    WHERE s.as_of = ? AND s.ticker = ?
      AND EXISTS (SELECT 1 FROM ticker_universe u WHERE u.ticker=s.ticker AND u.active=1)
    LIMIT 1
  `, [serving.asOf, ticker])
  if (!rowRecord) return null
  const row = rowFromDb(rowRecord)
  const [peerRecords, sectorCountRow] = await Promise.all([
    execAll<Record<string, unknown>>(`
      SELECT ${SELECT_COLUMNS} FROM stock_screening_serving s
      WHERE s.as_of = ?
        AND EXISTS (SELECT 1 FROM ticker_universe u WHERE u.ticker=s.ticker AND u.active=1)
        AND (
          (? IS NOT NULL AND s.sector33 = ?)
          OR (? IS NOT NULL AND s.major_category = ?)
        )
      ORDER BY s.ticker
    `, [serving.asOf, row.sector33, row.sector33, row.majorCategory, row.majorCategory]),
    execGet<{ count: number }>(`
      SELECT COUNT(DISTINCT sector33) AS count FROM stock_screening_serving
      WHERE as_of = ? AND sector33 IS NOT NULL AND sector33 <> ''
    `, [serving.asOf]),
  ])
  const peers = peerRecords.map(rowFromDb)
  return {
    serving,
    row,
    sector33Peers: row.sector33 ? peers.filter((peer) => peer.sector33 === row.sector33) : [],
    majorCategoryPeers: row.majorCategory ? peers.filter((peer) => peer.majorCategory === row.majorCategory) : [],
    sectorCount: Number(sectorCountRow?.count ?? 0),
  }
}

async function loadCoverage(asOf: string, universe: number): Promise<ScreeningCoverage[]> {
  const metrics = [...SCREENING_METRIC_MAP.keys()]
  const expressions = metrics.map((metric) => `COUNT(${COLUMN_BY_METRIC[metric]}) AS ${COLUMN_BY_METRIC[metric]}`).join(',')
  const row = await execGet<Record<string, unknown>>(`SELECT ${expressions} FROM stock_screening_serving WHERE as_of = ?`, [asOf])
  return metrics.map((metric) => {
    const available = Number(row?.[COLUMN_BY_METRIC[metric]] ?? 0)
    return { metric, available, universe, percent: universe > 0 ? 100 * available / universe : 0 }
  })
}

async function loadOptions(asOf: string): Promise<IntegratedScreeningResponse['options']> {
  const keys: ScreeningMetricKey[] = ['marketSegment', 'sector17', 'sector33', 'majorCategory', 'subIndustry', 'maStructure', 'shortTermCheck']
  const output: IntegratedScreeningResponse['options'] = {}
  for (const key of keys) {
    const column = COLUMN_BY_METRIC[key]
    const rows = await execAll<{ value: string; count: number }>(`
      SELECT ${column} AS value, COUNT(*) AS count FROM stock_screening_serving
      WHERE as_of = ? AND ${column} IS NOT NULL AND ${column} <> '' GROUP BY ${column} ORDER BY count DESC, value LIMIT 600
    `, [asOf])
    output[key] = rows.map((row) => ({ value: row.value, count: Number(row.count) }))
  }
  return output
}

export async function queryIntegratedScreener(input: {
  asOf?: string | null
  conditions?: ScreeningCondition[]
  sort?: ScreeningMetricKey | null
  direction?: 'asc' | 'desc'
  limit?: number
  offset?: number
}): Promise<IntegratedScreeningResponse> {
  const startedAt = Date.now()
  const serving = await buildScreeningServingDate(input.asOf)
  const limit = Math.max(1, Math.min(500, Math.floor(input.limit ?? 100)))
  const offset = Math.max(0, Math.floor(input.offset ?? 0))
  const direction = input.direction === 'asc' ? 'asc' : 'desc'
  const conditions = (input.conditions ?? []).slice(0, 40)
  const cacheKey = JSON.stringify({ asOf: serving.asOf, conditions, sort: input.sort ?? null, direction, limit, offset })
  const cached = responseCache.get(cacheKey)
  if (cached && cached.expiresAt > Date.now()) return { ...cached.value, elapsedMs: Date.now() - startedAt, cacheHit: true }
  const args: Array<string | number> = [serving.asOf]
  const where = ['s.as_of = ?', 'EXISTS (SELECT 1 FROM ticker_universe u WHERE u.ticker=s.ticker AND u.active=1)']
  for (const condition of conditions) {
    const sql = conditionSql(condition, args)
    if (sql) where.push(sql)
  }
  const whereSql = where.join(' AND ')
  const count = await execGet<{ total: number }>(`
    SELECT COUNT(*) AS total FROM stock_screening_serving s WHERE ${whereSql}
  `, args)
  const rows = await execAll<Record<string, unknown>>(`
    SELECT ${SELECT_COLUMNS} FROM stock_screening_serving s
    WHERE ${whereSql} ORDER BY ${sortSql(input.sort, direction)} LIMIT ? OFFSET ?
  `, [...args, limit, offset])
  const universe = serving.rows
  const [coverage, options] = await Promise.all([loadCoverage(serving.asOf, universe), loadOptions(serving.asOf)])
  const response: IntegratedScreeningResponse = {
    contractVersion: 'integrated-screener-v1', asOf: serving.asOf, snapshotDate: serving.snapshotDate,
    servingBuiltAt: Math.floor(Date.now() / 1000), total: Number(count?.total ?? 0), universe,
    rows: rows.map(rowFromDb), coverage, options, limit, offset, elapsedMs: Date.now() - startedAt, cacheHit: false,
  }
  responseCache.set(cacheKey, { expiresAt: Date.now() + RESULT_CACHE_TTL_MS, value: response })
  return response
}
