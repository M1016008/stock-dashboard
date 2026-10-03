import { execGet } from '@/lib/db/client'
import {
  normalizeAsOf,
  selectForecastsAsOf,
  type FinancialForecastSnapshot,
  type NormalizedFinancialFact,
} from '@/lib/financial-foundation'
import {
  calculateFinancialMetrics,
  METRIC_DEFINITION_REGISTRY,
  type CalculatedFinancialMetric,
  type FinancialMetricKey,
} from '@/lib/financial-metrics'
import {
  loadFinancialForecastSnapshots,
  loadNormalizedFinancialFacts,
} from '@/lib/server/financial-foundation-store'

export type FinancialValueAvailability = 'available' | 'missing' | 'not_applicable'

export interface FinancialMissingReason {
  code: string
  message: string
}

export interface FinancialOverviewValue {
  value: number | null
  unit: string | null
  availability: FinancialValueAvailability
  reason: FinancialMissingReason | null
  periodStart: string | null
  periodEnd: string | null
  publishedAt: string | null
  consolidationScope: string | null
  accountingStandard: string | null
  definitionVersion: string | null
  inputIds: string[]
}

export interface FinancialOverviewForecastScope {
  targetFiscalYear: number | null
  publishedAt: string | null
  revenue: FinancialOverviewValue
  operatingProfit: FinancialOverviewValue
  netIncome: FinancialOverviewValue
  eps: FinancialOverviewValue
  dps: FinancialOverviewValue
}

export interface FinancialOverviewReadModel {
  contractVersion: 'financial-overview-v1'
  ticker: string
  asOf: string
  priceDate: string | null
  isFinancialSector: boolean
  classification: {
    name: string | null
    marketSegment: string | null
    sector17: string | null
    sector33: string | null
  }
  performanceAndGrowth: {
    latestFyRevenue: FinancialOverviewValue
    ltmRevenue: FinancialOverviewValue
    ltmRevenueGrowth: FinancialOverviewValue
    latestFyOperatingProfit: FinancialOverviewValue
    ltmOperatingProfit: FinancialOverviewValue
    operatingMargin: FinancialOverviewValue
    eps: FinancialOverviewValue
    epsGrowth: FinancialOverviewValue
    revenueCagr3y: FinancialOverviewValue
    revenueCagr5y: FinancialOverviewValue
  }
  quality: {
    roe: FinancialOverviewValue
    roa: FinancialOverviewValue
    roic: FinancialOverviewValue
    simpleFcf: FinancialOverviewValue
  }
  valuation: {
    marketCapitalization: FinancialOverviewValue
    per: FinancialOverviewValue
    forwardPer: FinancialOverviewValue
    pbr: FinancialOverviewValue
    psr: FinancialOverviewValue
  }
  shareholderReturns: {
    actualDps: FinancialOverviewValue
    currentForecastDps: FinancialOverviewValue
    dividendYield: FinancialOverviewValue
    payoutRatio: FinancialOverviewValue
  }
  forecasts: {
    currentFy: FinancialOverviewForecastScope
    nextFy: FinancialOverviewForecastScope
  }
  coverage: {
    facts: number
    sourceFacts: number
    derivedFacts: number
    forecastSnapshots: number
    calculatedMetrics: number
    ltmAvailable: boolean
  }
}

interface TickerProfile {
  name: string | null
  market_segment: string | null
  sector17_name: string | null
  sector33_name: string | null
}

interface PriceRow {
  date: string
  close: number
}

const FINANCIAL_SECTOR_PATTERN = /銀行|保険|証券|金融/

function availableFromFact(fact: NormalizedFinancialFact): FinancialOverviewValue {
  return {
    value: fact.value,
    unit: fact.unit,
    availability: 'available',
    reason: null,
    periodStart: fact.periodStart,
    periodEnd: fact.periodEnd,
    publishedAt: fact.publishedAt,
    consolidationScope: fact.consolidationScope,
    accountingStandard: fact.accountingStandard,
    definitionVersion: fact.definitionVersion,
    inputIds: fact.inputFactIds.length > 0 ? fact.inputFactIds : [fact.factId],
  }
}

function availableFromForecast(snapshot: FinancialForecastSnapshot): FinancialOverviewValue {
  return {
    value: snapshot.value,
    unit: snapshot.unit,
    availability: 'available',
    reason: null,
    periodStart: snapshot.targetPeriodStart,
    periodEnd: snapshot.targetPeriodEnd,
    publishedAt: snapshot.publishedAt,
    consolidationScope: snapshot.consolidationScope,
    accountingStandard: snapshot.accountingStandard,
    definitionVersion: null,
    inputIds: [snapshot.snapshotId],
  }
}

function unavailable(
  code: string,
  message: string,
  availability: Exclude<FinancialValueAvailability, 'available'> = 'missing',
): FinancialOverviewValue {
  return {
    value: null,
    unit: null,
    availability,
    reason: { code, message },
    periodStart: null,
    periodEnd: null,
    publishedAt: null,
    consolidationScope: null,
    accountingStandard: null,
    definitionVersion: null,
    inputIds: [],
  }
}

function metricValue(metric: CalculatedFinancialMetric): FinancialOverviewValue {
  return {
    value: metric.value,
    unit: metric.unit,
    availability: 'available',
    reason: null,
    periodStart: metric.periodStart,
    periodEnd: metric.periodEnd,
    publishedAt: null,
    consolidationScope: metric.consolidationScope,
    accountingStandard: metric.accountingStandard,
    definitionVersion: metric.definitionVersion,
    inputIds: metric.inputFactIds,
  }
}

function preferredFacts(
  facts: NormalizedFinancialFact[],
  metric: string,
  accumulationKind?: NormalizedFinancialFact['accumulationKind'],
): NormalizedFinancialFact[] {
  const matching = facts.filter((fact) => (
    fact.metric === metric && (!accumulationKind || fact.accumulationKind === accumulationKind)
  ))
  const consolidated = matching.filter((fact) => fact.consolidationScope === 'consolidated')
  const scoped = consolidated.length > 0
    ? consolidated
    : matching.filter((fact) => fact.consolidationScope === 'standalone')
  const latest = new Map<string, NormalizedFinancialFact>()
  for (const fact of scoped) {
    const key = [fact.periodEnd, fact.accumulationKind, fact.accountingStandard].join('|')
    const previous = latest.get(key)
    if (!previous || previous.publishedAt < fact.publishedAt) latest.set(key, fact)
  }
  return [...latest.values()].sort((a, b) => (
    a.periodEnd.localeCompare(b.periodEnd) || a.publishedAt.localeCompare(b.publishedAt)
  ))
}

function latestFact(
  facts: NormalizedFinancialFact[],
  metric: string,
  accumulationKind?: NormalizedFinancialFact['accumulationKind'],
): NormalizedFinancialFact | undefined {
  return preferredFacts(facts, metric, accumulationKind).at(-1)
}

function metricOrReason(
  metrics: Map<FinancialMetricKey, CalculatedFinancialMetric>,
  key: FinancialMetricKey,
  isFinancialSector: boolean,
  missingCode: string,
  missingMessage: string,
): FinancialOverviewValue {
  const policy = METRIC_DEFINITION_REGISTRY[key].financialSectorPolicy
  if (isFinancialSector && policy === 'not_applicable') {
    return unavailable(
      'not_applicable_financial_sector',
      `${METRIC_DEFINITION_REGISTRY[key].displayName}は金融業では定義上の比較可能性が低いため適用外です。`,
      'not_applicable',
    )
  }
  const metric = metrics.get(key)
  return metric ? metricValue(metric) : unavailable(missingCode, missingMessage)
}

function forecastGroup(
  snapshots: FinancialForecastSnapshot[],
  targetFiscalYear: number | null,
  role: 'current_fy' | 'next_fy',
): FinancialOverviewForecastScope {
  const candidates = targetFiscalYear == null ? [] : snapshots.filter((snapshot) => (
    snapshot.targetFiscalYear === targetFiscalYear && snapshot.forecastPeriod === 'FY'
  ))
  const consolidated = candidates.filter((snapshot) => snapshot.consolidationScope === 'consolidated')
  const scoped = consolidated.length > 0 ? consolidated : candidates
  const target = scoped
  const forMetric = (metric: string) => target
    .filter((snapshot) => snapshot.metric === metric)
    .sort((a, b) => b.publishedAt.localeCompare(a.publishedAt))[0]
  const missing = () => unavailable(
    role === 'current_fy' ? 'no_current_fy_forecast_as_of' : 'no_next_fy_forecast_as_of',
    role === 'current_fy'
      ? '指定日時点で利用できる当期会社予想がありません。'
      : '指定日時点で利用できる翌期会社予想がありません。',
  )
  const point = (metric: string) => {
    const snapshot = forMetric(metric)
    return snapshot ? availableFromForecast(snapshot) : missing()
  }
  return {
    targetFiscalYear,
    publishedAt: target.map((snapshot) => snapshot.publishedAt).sort().at(-1) ?? null,
    revenue: point('revenue'),
    operatingProfit: point('operating_profit'),
    netIncome: point('net_income_attributable'),
    eps: point('eps_basic'),
    dps: point('dividend_per_share_annual'),
  }
}

function operatingMarginValue(
  facts: NormalizedFinancialFact[],
  isFinancialSector: boolean,
): FinancialOverviewValue {
  if (isFinancialSector) {
    return unavailable(
      'not_applicable_financial_sector',
      '営業利益率は銀行・保険・証券等では一般事業会社と同じ定義で比較できないため適用外です。',
      'not_applicable',
    )
  }
  const revenue = latestFact(facts, 'revenue', 'LTM')
  if (!revenue || revenue.value <= 0) {
    return unavailable('ltm_revenue_missing', 'LTM売上高を導出できないため営業利益率を計算できません。')
  }
  const operatingProfit = preferredFacts(facts, 'operating_profit', 'LTM').find((fact) => (
    fact.periodEnd === revenue.periodEnd
    && fact.consolidationScope === revenue.consolidationScope
    && fact.accountingStandard === revenue.accountingStandard
  ))
  if (!operatingProfit) {
    return unavailable('ltm_operating_profit_missing', '同一期間・同一会計基準のLTM営業利益がありません。')
  }
  return {
    ...availableFromFact(operatingProfit),
    value: (operatingProfit.value / revenue.value) * 100,
    unit: 'PERCENT',
    definitionVersion: 'operating-margin-ltm-v1',
    inputIds: [operatingProfit.factId, revenue.factId],
  }
}

function marketCapitalizationValue(
  facts: NormalizedFinancialFact[],
  price: PriceRow | undefined,
): FinancialOverviewValue {
  if (!price) return unavailable('price_missing', '指定日時点以前の終値がありません。')
  const issued = latestFact(facts, 'shares_outstanding')
  const treasury = latestFact(facts, 'treasury_shares')
  if (!issued || !treasury) {
    return unavailable(
      'share_count_missing',
      '発行済株式数または自己株式数がないため、ゼロ補完せず時価総額を欠損扱いにしています。',
    )
  }
  const shares = issued.value - treasury.value
  if (shares <= 0) return unavailable('share_count_non_positive', '自己株式控除後の株式数が正数ではありません。')
  return {
    ...availableFromFact(issued),
    value: price.close * shares,
    unit: 'JPY',
    periodStart: null,
    periodEnd: price.date,
    definitionVersion: 'market-cap-close-net-shares-v1',
    inputIds: [issued.factId, treasury.factId, `price:JP:${issued.ticker}:${price.date}`],
  }
}

export async function getFinancialOverviewReadModel(
  ticker: string,
  requestedAsOf?: string | null,
): Promise<FinancialOverviewReadModel> {
  const latestPrice = await execGet<PriceRow>(`
    SELECT date, close FROM ohlcv_daily
    WHERE ticker = ?
    ORDER BY date DESC LIMIT 1
  `, [ticker])
  const asOf = requestedAsOf || latestPrice?.date || new Date().toISOString().slice(0, 10)
  const asOfDate = normalizeAsOf(asOf).slice(0, 10)
  const [profile, price, allFacts, allForecasts] = await Promise.all([
    execGet<TickerProfile>(`
      SELECT name, market_segment, sector17_name, sector33_name
      FROM ticker_universe WHERE ticker = ?
    `, [ticker]),
    execGet<PriceRow>(`
      SELECT date, close FROM ohlcv_daily
      WHERE ticker = ? AND date <= ?
      ORDER BY date DESC LIMIT 1
    `, [ticker, asOfDate]),
    loadNormalizedFinancialFacts(ticker),
    loadFinancialForecastSnapshots(ticker),
  ])
  const cutoff = normalizeAsOf(asOf)
  const facts = allFacts.filter((fact) => fact.publishedAt <= cutoff)
  const forecasts = selectForecastsAsOf(allForecasts, asOf)
  const sectorText = `${profile?.sector17_name ?? ''} ${profile?.sector33_name ?? ''}`
  const isFinancialSector = FINANCIAL_SECTOR_PATTERN.test(sectorText)
  const calculated = calculateFinancialMetrics({
    ticker,
    asOf: asOfDate,
    facts,
    forecasts,
    price: price ? { value: Number(price.close), date: price.date, inputId: `price:JP:${ticker}:${price.date}` } : null,
    isFinancialSector,
  })
  const metrics = new Map(calculated.map((metric) => [metric.metric, metric]))
  const latestFyRevenue = latestFact(facts, 'revenue', 'FY')
  const completedFiscalYear = facts
    .filter((fact) => fact.accumulationKind === 'FY' && fact.targetFiscalYear != null)
    .map((fact) => fact.targetFiscalYear!)
    .sort((a, b) => b - a)[0] ?? null
  const forwardYears = [...new Set(forecasts
    .filter((forecast) => (
      forecast.forecastPeriod === 'FY'
      && (completedFiscalYear == null || forecast.targetFiscalYear > completedFiscalYear)
    ))
    .map((forecast) => forecast.targetFiscalYear))]
    .sort((a, b) => a - b)
  const currentForecast = forecastGroup(forecasts, forwardYears[0] ?? null, 'current_fy')
  const nextForecast = forecastGroup(forecasts, forwardYears[1] ?? null, 'next_fy')
  const ltmRevenue = latestFact(facts, 'revenue', 'LTM')
  const latestFyOperatingProfit = latestFact(facts, 'operating_profit', 'FY')
  const ltmOperatingProfit = latestFact(facts, 'operating_profit', 'LTM')
  const actualDps = latestFact(facts, 'dividend_per_share_annual', 'FY')
  const noFact = (label: string, code: string) => unavailable(code, `${label}に必要な正規化済み財務factがありません。`)

  return {
    contractVersion: 'financial-overview-v1',
    ticker,
    asOf: asOfDate,
    priceDate: price?.date ?? null,
    isFinancialSector,
    classification: {
      name: profile?.name ?? null,
      marketSegment: profile?.market_segment ?? null,
      sector17: profile?.sector17_name ?? null,
      sector33: profile?.sector33_name ?? null,
    },
    performanceAndGrowth: {
      latestFyRevenue: latestFyRevenue ? availableFromFact(latestFyRevenue) : noFact('最新FY売上高', 'fy_revenue_missing'),
      ltmRevenue: ltmRevenue ? availableFromFact(ltmRevenue) : noFact('LTM売上高', 'ltm_revenue_missing'),
      ltmRevenueGrowth: metricOrReason(metrics, 'revenue_growth', isFinancialSector, 'revenue_growth_inputs_missing', '当期・前年同期のLTM売上高が揃っていません。'),
      latestFyOperatingProfit: latestFyOperatingProfit ? availableFromFact(latestFyOperatingProfit) : noFact('最新FY営業利益', 'fy_operating_profit_missing'),
      ltmOperatingProfit: ltmOperatingProfit ? availableFromFact(ltmOperatingProfit) : noFact('LTM営業利益', 'ltm_operating_profit_missing'),
      operatingMargin: operatingMarginValue(facts, isFinancialSector),
      eps: metricOrReason(metrics, 'eps', isFinancialSector, 'ltm_eps_inputs_missing', 'LTM純利益またはLTM期中平均株式数がありません。'),
      epsGrowth: metricOrReason(metrics, 'eps_growth', isFinancialSector, 'eps_growth_inputs_missing_or_nm', '当期・前年のEPSが揃わないか、符号変化により増減率が算定不能です。'),
      revenueCagr3y: metricOrReason(metrics, 'revenue_cagr_3y', isFinancialSector, 'revenue_cagr_3y_inputs_missing', '3年前と最新FYの正の売上高が揃っていません。'),
      revenueCagr5y: metricOrReason(metrics, 'revenue_cagr_5y', isFinancialSector, 'revenue_cagr_5y_inputs_missing', '5年前と最新FYの正の売上高が揃っていません。'),
    },
    quality: {
      roe: metricOrReason(metrics, 'roe', isFinancialSector, 'roe_inputs_missing', 'LTM純利益または期首・期末自己資本が揃っていません。'),
      roa: metricOrReason(metrics, 'roa', isFinancialSector, 'roa_inputs_missing', 'LTM純利益または期首・期末総資産が揃っていません。'),
      roic: isFinancialSector
        ? unavailable('not_applicable_financial_sector', 'ROICは金融業では通常企業と同じ定義を適用しないため適用外です。', 'not_applicable')
        : unavailable('roic_definition_inputs_unavailable', '税引後営業利益と投下資本の標準化入力が未整備のため、推測値は返しません。'),
      simpleFcf: metricOrReason(metrics, 'simple_fcf', isFinancialSector, 'simple_fcf_inputs_missing', '同一期間のLTM営業CF・投資CFが揃っていません。'),
    },
    valuation: {
      marketCapitalization: marketCapitalizationValue(facts, price),
      per: metricOrReason(metrics, 'per', isFinancialSector, 'per_inputs_missing_or_nm', '株価または正のLTM EPSがなく、PERは算定不能です。'),
      forwardPer: metricOrReason(metrics, 'forward_per', isFinancialSector, 'forward_per_inputs_missing_or_nm', '指定日時点の正の当期会社予想EPSまたは株価がありません。'),
      pbr: metricOrReason(metrics, 'pbr', isFinancialSector, 'pbr_inputs_missing_or_nm', '株価または正のBPSがありません。'),
      psr: metricOrReason(metrics, 'psr', isFinancialSector, 'psr_inputs_missing', '時価総額または正のLTM売上高がありません。'),
    },
    shareholderReturns: {
      actualDps: actualDps ? availableFromFact(actualDps) : noFact('実績DPS', 'actual_dps_missing'),
      currentForecastDps: currentForecast.dps,
      dividendYield: metricOrReason(metrics, 'dividend_yield', isFinancialSector, 'dividend_yield_inputs_missing', '指定日時点の当期予想DPSまたは株価がありません。'),
      payoutRatio: metricOrReason(metrics, 'payout_ratio', isFinancialSector, 'payout_ratio_missing', '最新FYの実績配当性向がありません。'),
    },
    forecasts: {
      currentFy: currentForecast,
      nextFy: nextForecast,
    },
    coverage: {
      facts: facts.length,
      sourceFacts: facts.filter((fact) => !fact.isDerived).length,
      derivedFacts: facts.filter((fact) => fact.isDerived).length,
      forecastSnapshots: allForecasts.filter((forecast) => forecast.publishedAt <= cutoff).length,
      calculatedMetrics: calculated.length,
      ltmAvailable: facts.some((fact) => fact.accumulationKind === 'LTM'),
    },
  }
}
