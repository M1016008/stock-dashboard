import { execAll, execGet } from '@/lib/db/client'
import type { DetailedFinancialFact } from '@/lib/detailed-financial-foundation'
import {
  normalizeAsOf,
  selectForecastsAsOf,
  type FinancialForecastSnapshot,
  type NormalizedFinancialFact,
} from '@/lib/financial-foundation'
import {
  calculateAdvancedFinancialMetrics,
  calculateFinancialMetrics,
  evaluateEvEbitda,
  METRIC_DEFINITION_REGISTRY,
  type CalculatedFinancialMetric,
  type FinancialMetricKey,
} from '@/lib/financial-metrics'
import { loadDetailedFinancialFactsForTickers } from '@/lib/server/detailed-financial-foundation-store'
import {
  loadFinancialForecastSnapshotsForTickers,
  loadNormalizedFinancialFactsForTickers,
} from '@/lib/server/financial-foundation-store'
import {
  loadLatestValuationServingRows,
  loadValuationServingHistory,
  servingMetricProvenance,
  servingMetricValue,
  servingPeerMetricValue,
  type ValuationMetricBasis,
  type ValuationServingRow,
} from '@/lib/server/valuation-serving'
import {
  VALUATION_CURRENT_METRICS,
  VALUATION_HISTORY_METRICS,
  VALUATION_PEER_METRICS,
  type ValuationAvailability,
  type ValuationCurrentMetric,
  type ValuationDetailReadModel,
  type ValuationHistoryMetric,
  type ValuationHistoryPoint,
  type ValuationHistoryWindow,
  type ValuationMetricHistory,
  type ValuationPeerGroup,
  type ValuationPeerMetric,
  type ValuationPeerMetricComparison,
  type ValuationRangeStatistics,
  type ValuationValue,
} from '@/lib/valuation-detail'

type PriceRow = { ticker: string; date: string; close: number }
type ProfileRow = {
  ticker: string
  name: string | null
  sector17Name: string | null
  sector33Name: string | null
  custom60Name: string | null
}

const FINANCIAL_SECTOR_PATTERN = /銀行|保険|証券|金融/
const HISTORY_WINDOWS: ValuationHistoryWindow[] = ['3y', '5y', '10y']
const HISTORY_YEARS: Record<ValuationHistoryWindow, number> = { '3y': 3, '5y': 5, '10y': 10 }
const PEER_LTM_FACT_METRICS = [
  'net_income_attributable',
  'weighted_average_shares',
  'revenue',
  'operating_profit',
  'operating_cash_flow',
] as const
const PEER_INSTANT_FACT_METRICS = [
  'equity_attributable',
  'bps',
  'shares_outstanding',
  'treasury_shares',
] as const
const PEER_DETAIL_METRICS = [
  'cash_and_cash_equivalents',
  'interest_bearing_debt',
  'non_controlling_interests',
  'depreciation_amortization',
  'capex',
] as const
const CACHE_TTL_MS = 5 * 60 * 1000
const CACHE_MAX_ENTRIES = 80
const modelCache = new Map<string, { expiresAt: number; model: ValuationDetailReadModel }>()

function asDate(value: string): string {
  return normalizeAsOf(value).slice(0, 10)
}

function subtractYears(date: string, years: number): string {
  const value = new Date(`${date}T00:00:00Z`)
  value.setUTCFullYear(value.getUTCFullYear() - years)
  return value.toISOString().slice(0, 10)
}

function addDays(date: string, days: number): string {
  const value = new Date(`${date}T00:00:00Z`)
  value.setUTCDate(value.getUTCDate() + days)
  return value.toISOString().slice(0, 10)
}

function isFinancial(profile: Pick<ProfileRow, 'sector17Name' | 'sector33Name'>): boolean {
  return FINANCIAL_SECTOR_PATTERN.test(`${profile.sector17Name ?? ''} ${profile.sector33Name ?? ''}`)
}

function groupByTicker<T extends { ticker: string }>(rows: T[]): Map<string, T[]> {
  const output = new Map<string, T[]>()
  for (const row of rows) output.set(row.ticker, [...(output.get(row.ticker) ?? []), row])
  return output
}

function metricMap(
  ticker: string,
  date: string,
  price: PriceRow | null,
  facts: NormalizedFinancialFact[],
  forecasts: FinancialForecastSnapshot[],
  detailedFacts: DetailedFinancialFact[],
  financialSector: boolean,
): Map<FinancialMetricKey, CalculatedFinancialMetric> {
  const context = {
    ticker,
    asOf: date,
    facts,
    forecasts,
    price: price ? { value: Number(price.close), date: price.date, inputId: `price:JP:${ticker}:${price.date}` } : null,
    isFinancialSector: financialSector,
  }
  const metrics = [
    ...calculateFinancialMetrics(context),
    ...calculateAdvancedFinancialMetrics({ ...context, detailedFacts }),
  ]
  return new Map(metrics.map((metric) => [metric.metric, metric]))
}

function latestCompletedFiscalYear(facts: NormalizedFinancialFact[], cutoff: string): number | null {
  const years = facts
    .filter((fact) => fact.publishedAt <= cutoff && fact.accumulationKind === 'FY' && fact.targetFiscalYear != null)
    .map((fact) => fact.targetFiscalYear!)
  return years.length > 0 ? Math.max(...years) : null
}

function nearestForecast(
  forecasts: FinancialForecastSnapshot[],
  facts: NormalizedFinancialFact[],
  metric: string,
  date: string,
): FinancialForecastSnapshot | null {
  const cutoff = normalizeAsOf(date)
  const selected = selectForecastsAsOf(forecasts, date)
  const completed = latestCompletedFiscalYear(facts, cutoff)
  const candidates = selected.filter((forecast) => (
    forecast.metric === metric
    && forecast.forecastPeriod === 'FY'
    && (completed == null || forecast.targetFiscalYear > completed)
  ))
  const year = candidates.map((forecast) => forecast.targetFiscalYear).sort((a, b) => a - b)[0]
  if (year == null) return null
  const target = candidates.filter((forecast) => forecast.targetFiscalYear === year)
  const consolidated = target.filter((forecast) => forecast.consolidationScope === 'consolidated')
  return [...(consolidated.length > 0 ? consolidated : target)]
    .sort((a, b) => b.publishedAt.localeCompare(a.publishedAt) || b.snapshotId.localeCompare(a.snapshotId))[0] ?? null
}

function unavailableValue(
  metric: FinancialMetricKey,
  availability: Exclude<ValuationAvailability, 'available'>,
  reason: string,
  flags: ValuationValue['flags'] = [],
): ValuationValue {
  return {
    metric,
    label: METRIC_DEFINITION_REGISTRY[metric].displayName,
    value: null,
    unit: null,
    availability,
    reason,
    periodEnd: null,
    definitionVersion: METRIC_DEFINITION_REGISTRY[metric].version,
    inputFactIds: [],
    forecastSnapshotId: null,
    flags,
  }
}

function availableValue(
  metric: FinancialMetricKey,
  calculated: CalculatedFinancialMetric,
  snapshotIds: Set<string>,
  flags: ValuationValue['flags'] = [],
): ValuationValue {
  return {
    metric,
    label: METRIC_DEFINITION_REGISTRY[metric].displayName,
    value: calculated.value,
    unit: calculated.unit,
    availability: 'available',
    reason: flags.includes('negative_fcf') ? '標準FCFが負のため、FCF Yieldも負値です。' : null,
    periodEnd: calculated.periodEnd,
    definitionVersion: calculated.definitionVersion,
    inputFactIds: calculated.inputFactIds,
    forecastSnapshotId: calculated.inputFactIds.find((id) => snapshotIds.has(id)) ?? null,
    flags,
  }
}

function valuationValue(
  metric: FinancialMetricKey,
  metrics: Map<FinancialMetricKey, CalculatedFinancialMetric>,
  facts: NormalizedFinancialFact[],
  forecasts: FinancialForecastSnapshot[],
  date: string,
  financialSector: boolean,
): ValuationValue {
  const definition = METRIC_DEFINITION_REGISTRY[metric]
  if (financialSector && definition.financialSectorPolicy === 'not_applicable') {
    return unavailableValue(metric, 'not_applicable', '金融業では通常企業と同じ定義で比較できないため対象外です。', ['financial_sector'])
  }
  const snapshotIds = new Set(forecasts.filter((snapshot) => snapshot.publishedAt <= normalizeAsOf(date)).map((snapshot) => snapshot.snapshotId))
  const calculated = metrics.get(metric)
  if (metric === 'ev_ebitda') {
    const ev = metrics.get('enterprise_value')
    const ebitda = metrics.get('ebitda')
    const contract = evaluateEvEbitda(ev?.value, ebitda?.value)
    if (contract.reason === 'non_positive_ev') {
      return unavailableValue(metric, 'not_meaningful', 'EVが0以下のため、負の倍率を通常のValuationとして表示しません。', ['non_positive_ev', 'financial_composite_caution'])
    }
    if (contract.reason === 'non_positive_ebitda') {
      return unavailableValue(metric, 'not_meaningful', 'EBITDAが0以下のため倍率はN/Mです。', ['non_positive_ebitda'])
    }
  }
  if (calculated) {
    const flags: ValuationValue['flags'] = []
    if (metric === 'fcf_yield' && calculated.value < 0) flags.push('negative_fcf')
    return availableValue(metric, calculated, snapshotIds, flags)
  }
  if (metric === 'per') {
    const eps = metrics.get('eps')
    if (eps && eps.value <= 0) return unavailableValue(metric, 'not_meaningful', 'LTM EPSが0以下のためPERはN/Mです。')
  }
  if (metric === 'forward_per') {
    const forecast = nearestForecast(forecasts, facts, 'eps_basic', date)
    if (forecast && forecast.value <= 0) return unavailableValue(metric, 'not_meaningful', '会社予想EPSが0以下のためForward PERはN/Mです。')
  }
  if (metric === 'pbr') {
    const bps = metrics.get('bps')
    if (bps && bps.value <= 0) return unavailableValue(metric, 'not_meaningful', 'BPSが0以下のためPBRはN/Mです。')
  }
  return unavailableValue(metric, 'missing', `${definition.displayName}の必要入力が指定日時点で揃っていません。`)
}

function quantile(values: number[], probability: number): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const position = (sorted.length - 1) * probability
  const lower = Math.floor(position)
  const upper = Math.ceil(position)
  if (lower === upper) return sorted[lower]
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower)
}

function percentileOf(values: number[], target: number | null): number | null {
  if (target == null || values.length === 0) return null
  return 100 * values.filter((value) => {
    const tolerance = 1e-10 * Math.max(1, Math.abs(value), Math.abs(target))
    return value <= target + tolerance
  }).length / values.length
}

function rangeStatistics(
  window: ValuationHistoryWindow,
  points: ValuationHistoryPoint[],
  current: number | null,
  endDate: string,
): ValuationRangeStatistics {
  const start = subtractYears(endDate, HISTORY_YEARS[window])
  const values = points.filter((point) => point.date >= start && point.date <= endDate).map((point) => point.value)
  const observations = points.filter((point) => point.date >= start && point.date <= endDate)
  const median = quantile(values, 0.5)
  return {
    window,
    observationCount: values.length,
    observationStartDate: observations[0]?.date ?? null,
    observationEndDate: observations.at(-1)?.date ?? null,
    fullWindow: Boolean(observations[0] && observations[0].date <= addDays(start, 14)),
    current,
    median,
    minimum: values.length ? Math.min(...values) : null,
    maximum: values.length ? Math.max(...values) : null,
    displayMinimum: quantile(values, 0.05),
    displayMaximum: quantile(values, 0.95),
    percentile: percentileOf(values, current),
    versusMedianPercent: current != null && median != null && median !== 0 ? ((current / median) - 1) * 100 : null,
  }
}

function historyMetricValue(
  metric: ValuationHistoryMetric,
  metrics: Map<FinancialMetricKey, CalculatedFinancialMetric>,
): CalculatedFinancialMetric | null {
  const value = metrics.get(metric)
  if (!value || !Number.isFinite(value.value)) return null
  if (metric === 'fcf_yield') return value
  if (metric === 'ev_ebitda') {
    const ev = metrics.get('enterprise_value')
    const ebitda = metrics.get('ebitda')
    return ev && ev.value > 0 && ebitda && ebitda.value > 0 && value.value > 0 ? value : null
  }
  return value.value > 0 ? value : null
}

function monthlyPoints(points: ValuationHistoryPoint[]): ValuationHistoryPoint[] {
  const byMonth = new Map<string, ValuationHistoryPoint>()
  for (const point of points) byMonth.set(point.date.slice(0, 7), point)
  const latest = points.at(-1)
  if (latest) byMonth.set(`latest:${latest.date}`, latest)
  return [...byMonth.values()]
    .filter((point, index, rows) => rows.findIndex((candidate) => candidate.date === point.date) === index)
    .sort((a, b) => a.date.localeCompare(b.date))
}

function buildHistory(
  ticker: string,
  prices: PriceRow[],
  facts: NormalizedFinancialFact[],
  forecasts: FinancialForecastSnapshot[],
  detailedFacts: DetailedFinancialFact[],
  financialSector: boolean,
  currentValues: Map<FinancialMetricKey, ValuationValue>,
): Record<ValuationHistoryMetric, ValuationMetricHistory> {
  const forecastIds = new Set(forecasts.map((snapshot) => snapshot.snapshotId))
  const daily = new Map<ValuationHistoryMetric, ValuationHistoryPoint[]>(VALUATION_HISTORY_METRICS.map((metric) => [metric, []]))
  for (const price of prices) {
    const metrics = metricMap(ticker, price.date, price, facts, forecasts, detailedFacts, financialSector)
    for (const metric of VALUATION_HISTORY_METRICS) {
      const value = historyMetricValue(metric, metrics)
      if (!value) continue
      daily.get(metric)!.push({
        date: price.date,
        price: Number(price.close),
        metric,
        value: value.value,
        inputFactIds: value.inputFactIds,
        forecastSnapshotId: value.inputFactIds.find((id) => forecastIds.has(id)) ?? null,
        definitionVersion: value.definitionVersion,
      })
    }
  }
  const endDate = prices.at(-1)?.date ?? ''
  return Object.fromEntries(VALUATION_HISTORY_METRICS.map((metric) => {
    const current = currentValues.get(metric)!
    const points = daily.get(metric) ?? []
    const currentNumber = current.availability === 'available' ? current.value : null
    return [metric, {
      metric,
      label: METRIC_DEFINITION_REGISTRY[metric].displayName,
      unit: METRIC_DEFINITION_REGISTRY[metric].key === 'fcf_yield' ? 'PERCENT' : 'MULTIPLE',
      current,
      points: monthlyPoints(points),
      statistics: Object.fromEntries(HISTORY_WINDOWS.map((window) => [
        window,
        rangeStatistics(window, points, currentNumber, endDate),
      ])) as Record<ValuationHistoryWindow, ValuationRangeStatistics>,
      sampling: 'month_end_and_latest' as const,
      note: !points[0] || points[0].date > subtractYears(endDate, 3)
        ? 'PIT条件を満たす履歴が3年未満のため、長期レンジの解釈には注意が必要です。'
        : null,
    }]
  })) as Record<ValuationHistoryMetric, ValuationMetricHistory>
}

function buildServingHistory(
  rows: ValuationServingRow[],
  bases: Map<string, ValuationMetricBasis>,
  currentValues: Map<FinancialMetricKey, ValuationValue>,
): Record<ValuationHistoryMetric, ValuationMetricHistory> {
  const daily = new Map<ValuationHistoryMetric, ValuationHistoryPoint[]>(VALUATION_HISTORY_METRICS.map((metric) => [metric, []]))
  for (const row of rows) {
    for (const metric of VALUATION_HISTORY_METRICS) {
      const value = servingMetricValue(row, metric)
      if (value == null || !Number.isFinite(value)) continue
      if (metric === 'ev_ebitda') {
        if ((row.enterpriseValue ?? 0) <= 0 || (row.ebitda ?? 0) <= 0 || value <= 0) continue
      } else if (metric !== 'fcf_yield' && value <= 0) {
        continue
      }
      const provenance = servingMetricProvenance(row, bases.get(row.basisId), metric)
      if (!provenance) continue
      daily.get(metric)!.push({
        date: row.valuationDate,
        price: row.price,
        metric,
        value,
        inputFactIds: provenance.inputFactIds,
        forecastSnapshotId: provenance.forecastSnapshotId,
        definitionVersion: provenance.definitionVersion,
      })
    }
  }
  const endDate = rows.at(-1)?.valuationDate ?? ''
  return Object.fromEntries(VALUATION_HISTORY_METRICS.map((metric) => {
    const current = currentValues.get(metric)!
    const points = daily.get(metric) ?? []
    const currentNumber = current.availability === 'available' ? current.value : null
    return [metric, {
      metric,
      label: METRIC_DEFINITION_REGISTRY[metric].displayName,
      unit: metric === 'fcf_yield' ? 'PERCENT' : 'MULTIPLE',
      current,
      points: monthlyPoints(points),
      statistics: Object.fromEntries(HISTORY_WINDOWS.map((window) => [
        window,
        rangeStatistics(window, points, currentNumber, endDate),
      ])) as Record<ValuationHistoryWindow, ValuationRangeStatistics>,
      sampling: 'month_end_and_latest' as const,
      note: !points[0] || points[0].date > subtractYears(endDate, 3)
        ? 'PIT条件を満たす履歴が3年未満のため、長期レンジの解釈には注意が必要です。'
        : null,
    }]
  })) as Record<ValuationHistoryMetric, ValuationMetricHistory>
}

async function loadPeerProfiles(profile: ProfileRow): Promise<ProfileRow[]> {
  if (!profile.sector33Name && !profile.custom60Name) return [profile]
  return execAll<ProfileRow>(`
    SELECT
      tu.ticker,
      tu.name,
      tu.sector17_name AS sector17Name,
      tu.sector33_name AS sector33Name,
      sc.major_category AS custom60Name
    FROM ticker_universe tu
    LEFT JOIN stock_classification sc ON sc.ticker = tu.ticker
    WHERE tu.active = 1
      AND (
        (? IS NOT NULL AND tu.sector33_name = ?)
        OR (? IS NOT NULL AND sc.major_category = ?)
      )
    ORDER BY tu.ticker
  `, [profile.sector33Name, profile.sector33Name, profile.custom60Name, profile.custom60Name])
}

async function loadLatestPrices(tickers: string[], asOf: string): Promise<Map<string, PriceRow>> {
  const output = new Map<string, PriceRow>()
  const marketDate = await execGet<{ date: string | null }>(
    'SELECT MAX(date) AS date FROM ohlcv_daily WHERE date <= ?',
    [asOf],
  )
  for (let offset = 0; offset < tickers.length; offset += 300) {
    const chunk = tickers.slice(offset, offset + 300)
    const rows = marketDate?.date ? await execAll<PriceRow>(`
      SELECT ticker, date, close FROM ohlcv_daily
      WHERE ticker IN (${chunk.map(() => '?').join(',')}) AND date = ?
    `, [...chunk, marketDate.date]) : []
    for (const row of rows) output.set(row.ticker, row)
    const missing = chunk.filter((ticker) => !output.has(ticker))
    if (missing.length === 0) continue
    const fallback = await execAll<PriceRow>(`
      SELECT price.ticker, price.date, price.close
      FROM ohlcv_daily price
      INNER JOIN (
        SELECT ticker, MAX(date) AS date
        FROM ohlcv_daily
        WHERE ticker IN (${missing.map(() => '?').join(',')}) AND date <= ?
        GROUP BY ticker
      ) latest ON latest.ticker = price.ticker AND latest.date = price.date
    `, [...missing, asOf])
    for (const row of fallback) output.set(row.ticker, row)
  }
  return output
}

async function calculatePitPeerMetricsLegacy(
  profiles: ProfileRow[],
  asOf: string,
): Promise<Map<string, Map<FinancialMetricKey, number>>> {
  const tickers = profiles.map((profile) => profile.ticker)
  const [prices, ltmFacts, instantFacts, forecasts, detailedFacts] = await Promise.all([
    loadLatestPrices(tickers, asOf),
    loadNormalizedFinancialFactsForTickers(tickers, {
      asOf,
      metrics: [...PEER_LTM_FACT_METRICS],
      periodEndFrom: subtractYears(asOf, 3),
      sources: ['calculated'],
      accumulationKinds: ['LTM'],
    }),
    loadNormalizedFinancialFactsForTickers(tickers, {
      asOf,
      metrics: [...PEER_INSTANT_FACT_METRICS],
      periodEndFrom: subtractYears(asOf, 3),
      sources: ['jquants'],
      accumulationKinds: ['INSTANT'],
    }),
    loadFinancialForecastSnapshotsForTickers(tickers, { asOf, metrics: ['eps_basic'] }),
    loadDetailedFinancialFactsForTickers(tickers, { asOf, metrics: [...PEER_DETAIL_METRICS] }),
  ])
  const facts = [...ltmFacts, ...instantFacts]
  const factsByTicker = groupByTicker(facts)
  const forecastsByTicker = groupByTicker(forecasts)
  const detailByTicker = groupByTicker(detailedFacts)
  const output = new Map<string, Map<FinancialMetricKey, number>>()
  for (const profile of profiles) {
    const metrics = metricMap(
      profile.ticker,
      asOf,
      prices.get(profile.ticker) ?? null,
      factsByTicker.get(profile.ticker) ?? [],
      forecastsByTicker.get(profile.ticker) ?? [],
      detailByTicker.get(profile.ticker) ?? [],
      isFinancial(profile),
    )
    output.set(profile.ticker, new Map([...metrics].map(([metric, value]) => [metric, value.value])))
  }
  return output
}

async function calculatePitPeerMetrics(
  profiles: ProfileRow[],
  asOf: string,
): Promise<Map<string, Map<FinancialMetricKey, number>>> {
  const servingRows = await loadLatestValuationServingRows(profiles.map((profile) => profile.ticker), asOf)
  const output = new Map<string, Map<FinancialMetricKey, number>>()
  for (const row of servingRows) {
    const metrics = new Map<FinancialMetricKey, number>()
    for (const metric of VALUATION_PEER_METRICS) {
      const value = servingPeerMetricValue(row, metric)
      if (value != null && Number.isFinite(value)) metrics.set(metric, value)
    }
    output.set(row.ticker, metrics)
  }
  const missingProfiles = profiles.filter((profile) => !output.has(profile.ticker))
  if (missingProfiles.length > 0) {
    const fallback = await calculatePitPeerMetricsLegacy(missingProfiles, asOf)
    for (const [ticker, metrics] of fallback) output.set(ticker, metrics)
  }
  return output
}

function validPeerValue(metric: ValuationPeerMetric, value: number | undefined): value is number {
  if (value == null || !Number.isFinite(value)) return false
  if (metric === 'fcf_yield' || metric === 'roe' || metric === 'revenue_growth') return true
  return value > 0
}

function peerMetricComparison(
  metric: ValuationPeerMetric,
  profiles: ProfileRow[],
  peerMetrics: Map<string, Map<FinancialMetricKey, number>>,
  target: ValuationValue,
): ValuationPeerMetricComparison {
  const values = profiles
    .map((profile) => peerMetrics.get(profile.ticker)?.get(metric))
    .filter((value): value is number => validPeerValue(metric, value))
  const targetValue = target.availability === 'available' && validPeerValue(metric, target.value ?? undefined)
    ? target.value
    : null
  const median = quantile(values, 0.5)
  const coveragePercent = profiles.length > 0 ? 100 * values.length / profiles.length : 0
  const sampleEnough = values.length >= 8 && coveragePercent >= 25
  const displayable = metric === 'ev_ebitda' ? sampleEnough : values.length >= 3
  return {
    metric,
    label: METRIC_DEFINITION_REGISTRY[metric].displayName,
    unit: metric === 'fcf_yield' || metric === 'roe' || metric === 'revenue_growth' ? 'PERCENT' : 'MULTIPLE',
    target,
    median,
    percentile25: quantile(values, 0.25),
    percentile75: quantile(values, 0.75),
    targetPercentile: percentileOf(values, targetValue),
    versusMedianPercent: targetValue != null && median != null && median !== 0 ? ((targetValue / median) - 1) * 100 : null,
    validCount: values.length,
    peerCount: profiles.length,
    coveragePercent,
    displayable,
    reason: displayable ? null : metric === 'ev_ebitda'
      ? '有効値8銘柄以上かつカバレッジ25%以上を満たさないため表示対象外です。'
      : '比較可能な銘柄が3銘柄未満です。',
  }
}

function peerGroup(
  taxonomy: ValuationPeerGroup['taxonomy'],
  groupName: string | null,
  profiles: ProfileRow[],
  peerMetrics: Map<string, Map<FinancialMetricKey, number>>,
  targets: Map<FinancialMetricKey, ValuationValue>,
): ValuationPeerGroup {
  return {
    taxonomy,
    label: taxonomy === 'sector33' ? 'J-Quants 33業種' : '独自60分類',
    groupName,
    peerCount: profiles.length,
    metrics: Object.fromEntries(VALUATION_PEER_METRICS.map((metric) => [
      metric,
      peerMetricComparison(metric, profiles, peerMetrics, targets.get(metric)!),
    ])) as Record<ValuationPeerMetric, ValuationPeerMetricComparison>,
  }
}

function cacheGet(key: string): ValuationDetailReadModel | null {
  const entry = modelCache.get(key)
  if (!entry || entry.expiresAt <= Date.now()) {
    modelCache.delete(key)
    return null
  }
  return { ...entry.model, coverage: { ...entry.model.coverage, cacheHit: true } }
}

function cacheSet(key: string, model: ValuationDetailReadModel): void {
  if (modelCache.size >= CACHE_MAX_ENTRIES) modelCache.delete(modelCache.keys().next().value ?? '')
  modelCache.set(key, { expiresAt: Date.now() + CACHE_TTL_MS, model })
}

export async function getValuationDetailReadModel(
  rawTicker: string,
  requestedAsOf?: string | null,
): Promise<ValuationDetailReadModel> {
  const ticker = rawTicker.replace(/\.T$/i, '')
  const requestedDateFromInput = requestedAsOf ? asDate(requestedAsOf) : null
  const preliminaryCacheKey = `${ticker}|${requestedDateFromInput ?? 'latest'}`
  const preliminaryCached = cacheGet(preliminaryCacheKey)
  if (preliminaryCached) return preliminaryCached

  const latestPrice = await execGet<PriceRow>(`
    SELECT ticker, date, close FROM ohlcv_daily WHERE ticker = ? ORDER BY date DESC LIMIT 1
  `, [ticker])
  const requestedDate = requestedDateFromInput ?? asDate(latestPrice?.date || new Date().toISOString().slice(0, 10))
  const cacheKey = `${ticker}|${requestedDate}`
  if (cacheKey !== preliminaryCacheKey) {
    const cached = cacheGet(cacheKey)
    if (cached) return cached
  }

  const [profile, price, facts, forecasts, detailedFacts] = await Promise.all([
    execGet<ProfileRow>(`
      SELECT
        tu.ticker,
        tu.name,
        tu.sector17_name AS sector17Name,
        tu.sector33_name AS sector33Name,
        sc.major_category AS custom60Name
      FROM ticker_universe tu
      LEFT JOIN stock_classification sc ON sc.ticker = tu.ticker
      WHERE tu.ticker = ?
    `, [ticker]),
    execGet<PriceRow>(`
      SELECT ticker, date, close FROM ohlcv_daily
      WHERE ticker = ? AND date <= ? ORDER BY date DESC LIMIT 1
    `, [ticker, requestedDate]),
    loadNormalizedFinancialFactsForTickers([ticker], { asOf: requestedDate }),
    loadFinancialForecastSnapshotsForTickers([ticker], { asOf: requestedDate }),
    loadDetailedFinancialFactsForTickers([ticker], { asOf: requestedDate }),
  ])
  const safeProfile: ProfileRow = profile ?? {
    ticker,
    name: null,
    sector17Name: null,
    sector33Name: null,
    custom60Name: null,
  }
  const financialSector = isFinancial(safeProfile)
  const currentMetrics = metricMap(ticker, requestedDate, price ?? null, facts, forecasts, detailedFacts, financialSector)
  const currentValues = new Map<FinancialMetricKey, ValuationValue>()
  for (const metric of [...new Set<FinancialMetricKey>([
    ...VALUATION_CURRENT_METRICS,
    ...VALUATION_HISTORY_METRICS,
    ...VALUATION_PEER_METRICS,
  ])]) {
    currentValues.set(metric, valuationValue(metric, currentMetrics, facts, forecasts, requestedDate, financialSector))
  }

  const historyStart = subtractYears(requestedDate, 10)
  const servingHistory = await loadValuationServingHistory(ticker, historyStart, requestedDate)
  let historyRows = servingHistory.rows
  let history: Record<ValuationHistoryMetric, ValuationMetricHistory>
  if (historyRows.length > 0) {
    history = buildServingHistory(historyRows, servingHistory.bases, currentValues)
  } else {
    const prices = await execAll<PriceRow>(`
      SELECT ticker, date, close FROM ohlcv_daily
      WHERE ticker = ? AND date BETWEEN ? AND ?
      ORDER BY date
    `, [ticker, historyStart, requestedDate])
    historyRows = prices.map((item) => ({
      ticker: item.ticker,
      valuationDate: item.date,
      priceDate: item.date,
      price: Number(item.close),
      isTradingDay: true,
      per: null,
      forwardPer: null,
      pbr: null,
      psr: null,
      fcfYield: null,
      evEbitda: null,
      netDebt: null,
      dividendYield: null,
      roe: null,
      revenueGrowth: null,
      enterpriseValue: null,
      ebitda: null,
      peerForwardPer: null,
      peerPbr: null,
      peerFcfYield: null,
      peerRoe: null,
      peerRevenueGrowth: null,
      peerEvEbitda: null,
      basisId: '',
      forecastSnapshotId: null,
    }))
    history = buildHistory(ticker, prices, facts, forecasts, detailedFacts, financialSector, currentValues)
  }

  const peerProfiles = await loadPeerProfiles(safeProfile)
  const peerMode = 'pit_recalculated' as const
  const peerMetrics = await calculatePitPeerMetrics(peerProfiles, requestedDate)
  const sector33Peers = safeProfile.sector33Name
    ? peerProfiles.filter((item) => item.sector33Name === safeProfile.sector33Name)
    : []
  const custom60Peers = safeProfile.custom60Name
    ? peerProfiles.filter((item) => item.custom60Name === safeProfile.custom60Name)
    : []

  const enterpriseValue = currentMetrics.get('enterprise_value')
  const cautions: string[] = []
  if (enterpriseValue && enterpriseValue.value <= 0 && !financialSector) {
    cautions.push('EVが0以下です。純現金超過または金融子会社を含む複合企業では、EV系指標を通常企業と同列に比較できません。')
  }
  if (currentValues.get('fcf_yield')?.flags.includes('negative_fcf')) {
    cautions.push('標準FCFが負のため、FCF Yieldは負値です。')
  }

  const definitions = Object.fromEntries([...new Set<FinancialMetricKey>([
    ...VALUATION_CURRENT_METRICS,
    ...VALUATION_HISTORY_METRICS,
    ...VALUATION_PEER_METRICS,
  ])].map((metric) => [metric, METRIC_DEFINITION_REGISTRY[metric]])) as ValuationDetailReadModel['definitions']
  const servingAsOf = historyRows.at(-1)?.valuationDate ?? null
  const quoteAsOf = price?.date ?? null
  const freshnessStatus = !quoteAsOf || !servingAsOf
    ? 'missing'
    : quoteAsOf === servingAsOf
      ? 'current'
      : 'stale'
  const model: ValuationDetailReadModel = {
    contractVersion: 'valuation-detail-v1',
    ticker,
    asOf: requestedDate,
    priceDate: price?.date ?? null,
    price: price?.close == null ? null : Number(price.close),
    isFinancialSector: financialSector,
    classification: {
      name: safeProfile.name,
      sector33: safeProfile.sector33Name,
      custom60: safeProfile.custom60Name,
    },
    current: {
      primary: ['forward_per', 'pbr', 'fcf_yield', 'dividend_yield'].map((metric) => currentValues.get(metric as FinancialMetricKey)!),
      secondary: ['per', 'psr', 'ev_ebitda', 'net_debt']
        .map((metric) => currentValues.get(metric as FinancialMetricKey)!),
      qualityContext: {
        roe: currentValues.get('roe')!,
        revenueGrowth: currentValues.get('revenue_growth')!,
      },
      cautions,
    },
    history,
    peers: {
      sector33: peerGroup('sector33', safeProfile.sector33Name, sector33Peers, peerMetrics, currentValues),
      custom60: peerGroup('custom60', safeProfile.custom60Name, custom60Peers, peerMetrics, currentValues),
    },
    definitions,
    coverage: {
      priceObservations: historyRows.length,
      facts: facts.filter((fact) => fact.publishedAt <= normalizeAsOf(requestedDate)).length,
      forecastSnapshots: forecasts.filter((forecast) => forecast.publishedAt <= normalizeAsOf(requestedDate)).length,
      detailedFacts: detailedFacts.length,
      historyStartDate: historyRows[0]?.valuationDate ?? null,
      historyEndDate: historyRows.at(-1)?.valuationDate ?? null,
      peerCalculationMode: peerMode,
      quoteAsOf,
      servingAsOf,
      freshnessStatus,
      cacheHit: false,
    },
  }
  cacheSet(cacheKey, model)
  if (!requestedAsOf) cacheSet(preliminaryCacheKey, model)
  return model
}
