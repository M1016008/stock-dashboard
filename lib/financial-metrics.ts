import {
  normalizeAsOf,
  selectForecastsAsOf,
  type AccountingStandard,
  type ConsolidationScope,
  type FinancialForecastSnapshot,
  type NormalizedFinancialFact,
} from '@/lib/financial-foundation'
import type { DetailedFinancialFact } from '@/lib/detailed-financial-foundation'

export type FinancialMetricKey =
  | 'eps'
  | 'bps'
  | 'per'
  | 'forward_per'
  | 'pbr'
  | 'psr'
  | 'roe'
  | 'roa'
  | 'operating_margin'
  | 'net_margin'
  | 'equity_ratio'
  | 'revenue_growth'
  | 'eps_growth'
  | 'revenue_cagr_3y'
  | 'revenue_cagr_5y'
  | 'dividend_yield'
  | 'payout_ratio'
  | 'simple_fcf'
  | 'net_debt'
  | 'ebitda'
  | 'standard_fcf'
  | 'enterprise_value'
  | 'ev_ebitda'
  | 'fcf_yield'
  | 'roic'

export interface MetricDefinition {
  key: FinancialMetricKey
  displayName: string
  formula: string
  requiredInputs: string[]
  periodBasis: 'FY' | 'LTM' | 'FORWARD' | 'INSTANT' | 'MIXED'
  financialSectorPolicy: 'allowed' | 'limited' | 'not_applicable'
  missingPolicy: string
  dataSource: string
  version: string
}

const COMMON_MISSING = 'Do not zero-fill or silently mix scope/framework; return unavailable with a reason.'
const NORMALIZED_FACT_SOURCE = 'J-Quants normalized financial facts'
const PIT_FORECAST_SOURCE = 'J-Quants PIT forecast snapshots and normalized financial facts'

export const METRIC_DEFINITION_REGISTRY: Readonly<Record<FinancialMetricKey, MetricDefinition>> = {
  eps: {
    key: 'eps', displayName: 'EPS', formula: 'LTM attributable net income / shares outstanding',
    requiredInputs: ['net_income_attributable:LTM', 'weighted_average_shares:LTM'], periodBasis: 'LTM',
    financialSectorPolicy: 'allowed', missingPolicy: COMMON_MISSING, dataSource: NORMALIZED_FACT_SOURCE, version: 'eps-ltm-v1',
  },
  bps: {
    key: 'bps', displayName: 'BPS', formula: 'Latest reported attributable equity per share',
    requiredInputs: ['bps:instant'], periodBasis: 'INSTANT', financialSectorPolicy: 'allowed',
    missingPolicy: COMMON_MISSING, dataSource: NORMALIZED_FACT_SOURCE, version: 'bps-reported-v1',
  },
  per: {
    key: 'per', displayName: 'PER', formula: 'As-of price / LTM EPS',
    requiredInputs: ['price', 'net_income_attributable:LTM', 'weighted_average_shares:LTM'], periodBasis: 'LTM',
    financialSectorPolicy: 'allowed', missingPolicy: `${COMMON_MISSING} Non-positive EPS is N/M.`, dataSource: NORMALIZED_FACT_SOURCE, version: 'per-ltm-v1',
  },
  forward_per: {
    key: 'forward_per', displayName: '予想PER', formula: 'As-of price / latest PIT company forecast EPS for the nearest fiscal year after the latest completed FY',
    requiredInputs: ['price', 'forecast_eps:nearest-future-fy'], periodBasis: 'FORWARD',
    financialSectorPolicy: 'allowed', missingPolicy: `${COMMON_MISSING} Non-positive forecast EPS is N/M.`, dataSource: PIT_FORECAST_SOURCE, version: 'forward-per-nearest-future-fy-pit-v2',
  },
  pbr: {
    key: 'pbr', displayName: 'PBR', formula: 'As-of price / latest BPS',
    requiredInputs: ['price', 'bps:instant'], periodBasis: 'INSTANT', financialSectorPolicy: 'allowed',
    missingPolicy: `${COMMON_MISSING} Non-positive BPS is N/M.`, dataSource: NORMALIZED_FACT_SOURCE, version: 'pbr-latest-v1',
  },
  psr: {
    key: 'psr', displayName: 'PSR', formula: 'Market capitalization / LTM revenue',
    requiredInputs: ['price', 'shares_outstanding:instant', 'revenue:LTM'], periodBasis: 'LTM',
    financialSectorPolicy: 'not_applicable', missingPolicy: `${COMMON_MISSING} Revenue must be positive.`, dataSource: NORMALIZED_FACT_SOURCE, version: 'psr-ltm-v1',
  },
  roe: {
    key: 'roe', displayName: 'ROE', formula: 'LTM attributable net income / average attributable equity',
    requiredInputs: ['net_income_attributable:LTM', 'equity_attributable:begin/end'], periodBasis: 'LTM',
    financialSectorPolicy: 'allowed', missingPolicy: `${COMMON_MISSING} Average equity must be positive.`, dataSource: NORMALIZED_FACT_SOURCE, version: 'roe-average-equity-ltm-v1',
  },
  roa: {
    key: 'roa', displayName: 'ROA', formula: 'LTM attributable net income / average total assets',
    requiredInputs: ['net_income_attributable:LTM', 'total_assets:begin/end'], periodBasis: 'LTM',
    financialSectorPolicy: 'allowed', missingPolicy: `${COMMON_MISSING} Average assets must be positive.`, dataSource: NORMALIZED_FACT_SOURCE, version: 'roa-average-assets-ltm-v1',
  },
  operating_margin: {
    key: 'operating_margin', displayName: '営業利益率', formula: 'Operating profit / revenue',
    requiredInputs: ['operating_profit:same-period', 'revenue:same-period'], periodBasis: 'MIXED',
    financialSectorPolicy: 'not_applicable', missingPolicy: `${COMMON_MISSING} Revenue must be positive.`,
    dataSource: NORMALIZED_FACT_SOURCE, version: 'operating-margin-same-period-v1',
  },
  net_margin: {
    key: 'net_margin', displayName: '純利益率', formula: 'Attributable net income / revenue',
    requiredInputs: ['net_income_attributable:same-period', 'revenue:same-period'], periodBasis: 'MIXED',
    financialSectorPolicy: 'not_applicable', missingPolicy: `${COMMON_MISSING} Revenue must be positive.`,
    dataSource: NORMALIZED_FACT_SOURCE, version: 'net-margin-same-period-v1',
  },
  equity_ratio: {
    key: 'equity_ratio', displayName: '自己資本比率', formula: 'Latest reported attributable equity ratio',
    requiredInputs: ['equity_ratio:instant'], periodBasis: 'INSTANT', financialSectorPolicy: 'allowed',
    missingPolicy: COMMON_MISSING, dataSource: NORMALIZED_FACT_SOURCE, version: 'equity-ratio-reported-v1',
  },
  revenue_growth: {
    key: 'revenue_growth', displayName: '売上成長率', formula: 'Latest LTM revenue / prior-year LTM revenue - 1',
    requiredInputs: ['revenue:LTM', 'revenue:prior-year-LTM'], periodBasis: 'LTM',
    financialSectorPolicy: 'limited', missingPolicy: `${COMMON_MISSING} Prior revenue must be positive.`, dataSource: NORMALIZED_FACT_SOURCE, version: 'revenue-growth-ltm-yoy-v1',
  },
  eps_growth: {
    key: 'eps_growth', displayName: 'EPS成長率', formula: 'Latest LTM EPS / prior-year LTM EPS - 1',
    requiredInputs: ['net_income_attributable:LTM current/prior', 'weighted_average_shares:LTM current/prior'], periodBasis: 'LTM',
    financialSectorPolicy: 'allowed', missingPolicy: `${COMMON_MISSING} Both EPS bases must be positive; sign transitions are N/M.`, dataSource: NORMALIZED_FACT_SOURCE, version: 'eps-growth-ltm-yoy-v1',
  },
  revenue_cagr_3y: {
    key: 'revenue_cagr_3y', displayName: '売上高3年CAGR', formula: '(latest completed FY revenue / FY revenue three years earlier)^(1/3) - 1',
    requiredInputs: ['revenue:FY latest', 'revenue:FY t-3'], periodBasis: 'FY', financialSectorPolicy: 'limited',
    missingPolicy: `${COMMON_MISSING} Both endpoints must be positive.`, dataSource: NORMALIZED_FACT_SOURCE, version: 'revenue-cagr-3y-fy-v1',
  },
  revenue_cagr_5y: {
    key: 'revenue_cagr_5y', displayName: '売上高5年CAGR', formula: '(latest completed FY revenue / FY revenue five years earlier)^(1/5) - 1',
    requiredInputs: ['revenue:FY latest', 'revenue:FY t-5'], periodBasis: 'FY', financialSectorPolicy: 'limited',
    missingPolicy: `${COMMON_MISSING} Both endpoints must be positive.`, dataSource: NORMALIZED_FACT_SOURCE, version: 'revenue-cagr-5y-fy-v1',
  },
  dividend_yield: {
    key: 'dividend_yield', displayName: '予想配当利回り', formula: 'Latest PIT forecast annual DPS for the nearest fiscal year after the latest completed FY / as-of price',
    requiredInputs: ['forecast_dividend_per_share_annual:nearest-future-fy', 'price'], periodBasis: 'FORWARD',
    financialSectorPolicy: 'allowed', missingPolicy: `${COMMON_MISSING} Price must be positive.`, dataSource: PIT_FORECAST_SOURCE, version: 'dividend-yield-nearest-future-fy-pit-v2',
  },
  payout_ratio: {
    key: 'payout_ratio', displayName: '配当性向', formula: 'Latest reported annual payout ratio',
    requiredInputs: ['payout_ratio:FY'], periodBasis: 'FY', financialSectorPolicy: 'allowed',
    missingPolicy: COMMON_MISSING, dataSource: NORMALIZED_FACT_SOURCE, version: 'payout-ratio-reported-fy-v1',
  },
  simple_fcf: {
    key: 'simple_fcf', displayName: '簡易FCF', formula: 'LTM operating cash flow + LTM investing cash flow',
    requiredInputs: ['operating_cash_flow:LTM', 'investing_cash_flow:LTM'], periodBasis: 'LTM',
    financialSectorPolicy: 'not_applicable', missingPolicy: `${COMMON_MISSING} Label as simplified FCF, not capex-only FCF.`, dataSource: NORMALIZED_FACT_SOURCE, version: 'simple-fcf-cfo-plus-cfi-ltm-v1',
  },
  net_debt: {
    key: 'net_debt', displayName: 'Net Debt', formula: 'Interest-bearing debt including recognized lease liabilities - cash and cash equivalents',
    requiredInputs: ['interest_bearing_debt:instant', 'cash_and_equivalents:same-instant'], periodBasis: 'INSTANT',
    financialSectorPolicy: 'not_applicable', missingPolicy: `${COMMON_MISSING} Bank deposits are never treated as debt; absent debt components are not inferred.`,
    dataSource: 'J-Quants summary cash and normalized detailed financial facts', version: 'net-debt-including-leases-v1',
  },
  ebitda: {
    key: 'ebitda', displayName: 'EBITDA', formula: 'LTM operating profit + LTM depreciation and amortization',
    requiredInputs: ['operating_profit:LTM', 'depreciation_amortization:same-LTM'], periodBasis: 'LTM',
    financialSectorPolicy: 'not_applicable', missingPolicy: `${COMMON_MISSING} FY detail is accepted as LTM only at the same 12-month fiscal period end.`,
    dataSource: 'J-Quants normalized operating profit and detailed financial facts', version: 'ebitda-operating-profit-plus-da-ltm-v1',
  },
  standard_fcf: {
    key: 'standard_fcf', displayName: '標準FCF', formula: 'LTM operating cash flow - LTM cash acquisition of PPE and intangible assets',
    requiredInputs: ['operating_cash_flow:LTM', 'capex:same-LTM'], periodBasis: 'LTM',
    financialSectorPolicy: 'not_applicable', missingPolicy: `${COMMON_MISSING} This remains distinct from simplified FCF (CFO + CFI).`,
    dataSource: 'J-Quants normalized operating cash flow and EDINET detailed capex', version: 'standard-fcf-cfo-minus-capex-ltm-v1',
  },
  enterprise_value: {
    key: 'enterprise_value', displayName: 'EV', formula: 'As-of market capitalization + Net Debt + non-controlling interests',
    requiredInputs: ['price', 'shares_outstanding', 'treasury_shares', 'net_debt', 'non_controlling_interests'], periodBasis: 'MIXED',
    financialSectorPolicy: 'not_applicable', missingPolicy: `${COMMON_MISSING} Market data is as-of; balance-sheet inputs use the latest disclosure available as-of.`,
    dataSource: 'As-of market price, normalized financial facts, and detailed financial facts', version: 'enterprise-value-net-debt-nci-v1',
  },
  ev_ebitda: {
    key: 'ev_ebitda', displayName: 'EV/EBITDA', formula: 'Enterprise value / LTM EBITDA',
    requiredInputs: ['enterprise_value', 'ebitda:LTM'], periodBasis: 'MIXED',
    financialSectorPolicy: 'not_applicable', missingPolicy: `${COMMON_MISSING} Non-positive EV or EBITDA is N/M.`,
    dataSource: 'Calculated EV and EBITDA', version: 'ev-ebitda-ltm-v2',
  },
  fcf_yield: {
    key: 'fcf_yield', displayName: 'FCF Yield', formula: 'LTM standard FCF / as-of market capitalization',
    requiredInputs: ['standard_fcf:LTM', 'price', 'shares_outstanding', 'treasury_shares'], periodBasis: 'MIXED',
    financialSectorPolicy: 'not_applicable', missingPolicy: `${COMMON_MISSING} Market capitalization must be positive.`,
    dataSource: 'Calculated standard FCF and as-of market capitalization', version: 'fcf-yield-standard-fcf-ltm-v1',
  },
  roic: {
    key: 'roic', displayName: 'ROIC', formula: 'LTM NOPAT / average invested capital; NOPAT = operating profit × (1 - income tax expense / profit before tax); invested capital = attributable equity + NCI + interest-bearing debt - cash',
    requiredInputs: ['operating_profit:LTM', 'income_tax_expense:same-LTM', 'profit_before_tax:same-LTM', 'invested_capital:begin/end'], periodBasis: 'LTM',
    financialSectorPolicy: 'not_applicable', missingPolicy: `${COMMON_MISSING} Pretax income and both invested-capital endpoints must be positive; no statutory-rate substitution.`,
    dataSource: 'J-Quants normalized facts and normalized detailed financial facts', version: 'roic-nopat-average-invested-capital-v1',
  },
}

export interface MetricPriceInput {
  value: number
  date: string
  inputId: string
}

export interface MetricCalculationContext {
  ticker: string
  asOf: string
  facts: NormalizedFinancialFact[]
  forecasts: FinancialForecastSnapshot[]
  price?: MetricPriceInput | null
  isFinancialSector?: boolean
  /** Inputs have already been advanced to asOf by a monotonic PIT cursor. */
  inputsPreparedForAsOf?: boolean
}

export interface CalculatedFinancialMetric {
  valueId: string
  ticker: string
  asOf: string
  periodStart: string | null
  periodEnd: string | null
  metric: FinancialMetricKey
  value: number
  unit: string
  consolidationScope: ConsolidationScope
  accountingStandard: AccountingStandard
  definitionVersion: string
  derivationMethod: string
  inputFactIds: string[]
  source: 'calculated'
}

export type EvEbitdaContract = {
  status: 'available' | 'missing' | 'not_meaningful'
  value: number | null
  rawCalculationValue: number | null
  reason: 'missing_ev' | 'missing_ebitda' | 'non_positive_ev' | 'non_positive_ebitda' | null
}

export function evaluateEvEbitda(
  enterpriseValue: number | null | undefined,
  ebitda: number | null | undefined,
): EvEbitdaContract {
  const ev = enterpriseValue == null ? null : Number(enterpriseValue)
  const denominator = ebitda == null ? null : Number(ebitda)
  if (ev == null || !Number.isFinite(ev)) {
    return { status: 'missing', value: null, rawCalculationValue: null, reason: 'missing_ev' }
  }
  if (denominator == null || !Number.isFinite(denominator)) {
    return { status: 'missing', value: null, rawCalculationValue: null, reason: 'missing_ebitda' }
  }
  const rawCalculationValue = denominator === 0 ? null : ev / denominator
  if (ev <= 0) {
    return { status: 'not_meaningful', value: null, rawCalculationValue, reason: 'non_positive_ev' }
  }
  if (denominator <= 0) {
    return { status: 'not_meaningful', value: null, rawCalculationValue, reason: 'non_positive_ebitda' }
  }
  return { status: 'available', value: rawCalculationValue, rawCalculationValue, reason: null }
}

function metricValueId(ticker: string, metric: string, asOf: string, version: string): string {
  return `metric:${encodeURIComponent(ticker)}:${encodeURIComponent(metric)}:${encodeURIComponent(asOf)}:${encodeURIComponent(version)}`
}

function latestByPeriod(facts: NormalizedFinancialFact[]): NormalizedFinancialFact[] {
  const latest = new Map<string, NormalizedFinancialFact>()
  for (const fact of facts) {
    const key = [fact.metric, fact.periodEnd, fact.accumulationKind, fact.consolidationScope, fact.accountingStandard].join('|')
    const previous = latest.get(key)
    if (!previous || previous.publishedAt < fact.publishedAt) latest.set(key, fact)
  }
  return [...latest.values()]
}

function preferredFacts(
  facts: NormalizedFinancialFact[],
  metric: string,
  accumulationKind?: string,
): NormalizedFinancialFact[] {
  const matching = facts.filter((fact) => (
    fact.metric === metric && (!accumulationKind || fact.accumulationKind === accumulationKind)
  ))
  const consolidated = matching.filter((fact) => fact.consolidationScope === 'consolidated')
  return latestByPeriod(consolidated.length > 0 ? consolidated : matching.filter((fact) => fact.consolidationScope === 'standalone'))
    .sort((a, b) => a.periodEnd.localeCompare(b.periodEnd) || a.publishedAt.localeCompare(b.publishedAt))
}

function latestFact(
  facts: NormalizedFinancialFact[],
  metric: string,
  accumulationKind?: string,
  beforeOrAt?: string,
): NormalizedFinancialFact | undefined {
  return preferredFacts(facts, metric, accumulationKind)
    .filter((fact) => !beforeOrAt || fact.periodEnd <= beforeOrAt)
    .at(-1)
}

function factNearPriorYear(facts: NormalizedFinancialFact[], latest: NormalizedFinancialFact): NormalizedFinancialFact | undefined {
  return facts
    .filter((fact) => fact.periodEnd < latest.periodEnd)
    .map((fact) => ({ fact, distance: Math.abs(dayDiff(fact.periodEnd, latest.periodEnd) - 365) }))
    .filter(({ distance }) => distance <= 50)
    .sort((a, b) => a.distance - b.distance || b.fact.publishedAt.localeCompare(a.fact.publishedAt))[0]?.fact
}

function dayDiff(a: string, b: string): number {
  return Math.round(Math.abs(Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86_400_000)
}

function previousDate(date: string): string {
  const parsed = new Date(`${date}T00:00:00Z`)
  parsed.setUTCDate(parsed.getUTCDate() - 1)
  return parsed.toISOString().slice(0, 10)
}

function addMetric(
  output: CalculatedFinancialMetric[],
  context: MetricCalculationContext,
  key: FinancialMetricKey,
  value: number | null,
  unit: string,
  inputFacts: Array<NormalizedFinancialFact | FinancialForecastSnapshot | MetricPriceInput>,
  anchor: NormalizedFinancialFact | FinancialForecastSnapshot | null,
  method?: string,
): void {
  if (value == null || !Number.isFinite(value)) return
  const definition = METRIC_DEFINITION_REGISTRY[key]
  const inputFactIds = inputFacts.map((input) => (
    'factId' in input ? input.factId : 'snapshotId' in input ? input.snapshotId : input.inputId
  ))
  output.push({
    valueId: metricValueId(context.ticker, key, context.asOf, definition.version),
    ticker: context.ticker,
    asOf: context.asOf,
    periodStart: anchor && 'periodStart' in anchor ? anchor.periodStart : anchor && 'targetPeriodStart' in anchor ? anchor.targetPeriodStart : null,
    periodEnd: anchor && 'periodEnd' in anchor ? anchor.periodEnd : anchor && 'targetPeriodEnd' in anchor ? anchor.targetPeriodEnd : null,
    metric: key,
    value,
    unit,
    consolidationScope: anchor?.consolidationScope ?? 'consolidated',
    accountingStandard: anchor?.accountingStandard ?? 'UNKNOWN',
    definitionVersion: definition.version,
    derivationMethod: method ?? definition.formula,
    inputFactIds,
    source: 'calculated',
  })
}

function balancePair(
  facts: NormalizedFinancialFact[],
  metric: string,
  ltm: NormalizedFinancialFact,
): [NormalizedFinancialFact, NormalizedFinancialFact] | null {
  const candidates = preferredFacts(facts, metric)
    .filter((fact) => (
      fact.consolidationScope === ltm.consolidationScope
      && fact.accountingStandard === ltm.accountingStandard
    ))
  const ending = candidates.filter((fact) => fact.periodEnd <= ltm.periodEnd).at(-1)
  const beginning = ltm.periodStart
    ? candidates.filter((fact) => fact.periodEnd <= previousDate(ltm.periodStart!)).at(-1)
    : undefined
  return beginning && ending ? [beginning, ending] : null
}

function weightedSharesForLtm(
  facts: NormalizedFinancialFact[],
  ltm: NormalizedFinancialFact,
): NormalizedFinancialFact | undefined {
  return preferredFacts(facts, 'weighted_average_shares', 'LTM').find((fact) => (
    fact.periodEnd === ltm.periodEnd
    && fact.consolidationScope === ltm.consolidationScope
    && fact.accountingStandard === ltm.accountingStandard
  ))
}

function marketSharesForPeriod(
  facts: NormalizedFinancialFact[],
  periodEnd: string,
): { value: number; facts: NormalizedFinancialFact[] } | null {
  const issued = latestFact(facts, 'shares_outstanding', undefined, periodEnd)
  if (!issued) return null
  const treasury = latestFact(facts, 'treasury_shares', undefined, periodEnd)
  if (!treasury) return null
  const value = issued.value - treasury.value
  return value > 0 ? { value, facts: [issued, treasury] } : null
}

function fyCagrInputs(
  facts: NormalizedFinancialFact[],
  years: number,
): [NormalizedFinancialFact, NormalizedFinancialFact] | null {
  const periods = preferredFacts(facts, 'revenue', 'FY').filter((fact) => fact.targetFiscalYear != null)
  const latest = periods.at(-1)
  if (!latest?.targetFiscalYear) return null
  const base = periods.find((fact) => fact.targetFiscalYear === latest.targetFiscalYear! - years)
  return base ? [base, latest] : null
}

function latestCompletedFiscalYear(facts: NormalizedFinancialFact[]): number | null {
  const years = facts
    .filter((fact) => fact.accumulationKind === 'FY' && fact.targetFiscalYear != null)
    .map((fact) => fact.targetFiscalYear!)
  return years.length > 0 ? Math.max(...years) : null
}

function nearestForwardForecast(
  forecasts: FinancialForecastSnapshot[],
  metric: string,
  completedFiscalYear: number | null,
): FinancialForecastSnapshot | undefined {
  const candidates = forecasts.filter((forecast) => (
    forecast.metric === metric
    && forecast.forecastPeriod === 'FY'
    && (completedFiscalYear == null || forecast.targetFiscalYear > completedFiscalYear)
  ))
  const targetYear = candidates.map((forecast) => forecast.targetFiscalYear).sort((a, b) => a - b)[0]
  if (targetYear == null) return undefined
  const target = candidates.filter((forecast) => forecast.targetFiscalYear === targetYear)
  const consolidated = target.filter((forecast) => forecast.consolidationScope === 'consolidated')
  return (consolidated.length > 0 ? consolidated : target)
    .sort((a, b) => b.publishedAt.localeCompare(a.publishedAt))[0]
}

export function calculateFinancialMetrics(context: MetricCalculationContext): CalculatedFinancialMetric[] {
  const cutoff = normalizeAsOf(context.asOf)
  const facts = context.inputsPreparedForAsOf
    ? context.facts
    : context.facts.filter((fact) => fact.ticker === context.ticker && fact.publishedAt <= cutoff)
  const forecasts = context.inputsPreparedForAsOf
    ? context.forecasts
    : selectForecastsAsOf(
      context.forecasts.filter((forecast) => forecast.ticker === context.ticker),
      context.asOf,
    )
  const output: CalculatedFinancialMetric[] = []
  const price = context.price && context.price.date <= context.asOf.slice(0, 10) ? context.price : null
  const ltmNet = latestFact(facts, 'net_income_attributable', 'LTM')
  const ltmRevenue = latestFact(facts, 'revenue', 'LTM')
  const weightedShares = ltmNet ? weightedSharesForLtm(facts, ltmNet) : undefined
  const marketShares = ltmRevenue
    ? marketSharesForPeriod(facts, ltmRevenue.periodEnd)
    : marketSharesForPeriod(facts, '9999-12-31')
  const ltmEps = ltmNet && weightedShares?.value ? ltmNet.value / weightedShares.value : null
  const completedFiscalYear = latestCompletedFiscalYear(facts)

  if (ltmNet && weightedShares) addMetric(output, context, 'eps', ltmEps, 'JPY_PER_SHARE', [ltmNet, weightedShares], ltmNet)
  const bps = latestFact(facts, 'bps')
  if (bps) addMetric(output, context, 'bps', bps.value, 'JPY_PER_SHARE', [bps], bps, 'latest_reported_bps')
  if (price && ltmEps != null && ltmEps > 0 && ltmNet && weightedShares) {
    addMetric(output, context, 'per', price.value / ltmEps, 'MULTIPLE', [price, ltmNet, weightedShares], ltmNet)
  }

  const forwardEps = nearestForwardForecast(forecasts, 'eps_basic', completedFiscalYear)
  if (price && forwardEps && forwardEps.value > 0) {
    addMetric(output, context, 'forward_per', price.value / forwardEps.value, 'MULTIPLE', [price, forwardEps], forwardEps)
  }
  if (price && bps && bps.value > 0) addMetric(output, context, 'pbr', price.value / bps.value, 'MULTIPLE', [price, bps], bps)
  if (!context.isFinancialSector && price && marketShares && ltmRevenue && ltmRevenue.value > 0) {
    addMetric(output, context, 'psr', (price.value * marketShares.value) / ltmRevenue.value, 'MULTIPLE', [price, ...marketShares.facts, ltmRevenue], ltmRevenue)
  }

  if (ltmNet) {
    const equity = balancePair(facts, 'equity_attributable', ltmNet)
    if (equity) {
      const average = (equity[0].value + equity[1].value) / 2
      if (average > 0) addMetric(output, context, 'roe', (ltmNet.value / average) * 100, 'PERCENT', [ltmNet, ...equity], ltmNet)
    }
    const assets = balancePair(facts, 'total_assets', ltmNet)
    if (assets) {
      const average = (assets[0].value + assets[1].value) / 2
      if (average > 0) addMetric(output, context, 'roa', (ltmNet.value / average) * 100, 'PERCENT', [ltmNet, ...assets], ltmNet)
    }
  }

  if (ltmRevenue) {
    const revenueLtms = preferredFacts(facts, 'revenue', 'LTM')
    const prior = factNearPriorYear(revenueLtms, ltmRevenue)
    if (prior && prior.value > 0) {
      addMetric(output, context, 'revenue_growth', ((ltmRevenue.value / prior.value) - 1) * 100, 'PERCENT', [ltmRevenue, prior], ltmRevenue)
    }
  }
  if (ltmNet && weightedShares) {
    const priorNet = factNearPriorYear(preferredFacts(facts, 'net_income_attributable', 'LTM'), ltmNet)
    const priorShares = priorNet ? weightedSharesForLtm(facts, priorNet) : undefined
    const priorEps = priorNet && priorShares && priorShares.value > 0 ? priorNet.value / priorShares.value : null
    if (ltmEps != null && ltmEps > 0 && priorEps != null && priorEps > 0 && priorNet && priorShares) {
      addMetric(output, context, 'eps_growth', ((ltmEps / priorEps) - 1) * 100, 'PERCENT', [ltmNet, weightedShares, priorNet, priorShares], ltmNet)
    }
  }

  for (const years of [3, 5] as const) {
    const pair = fyCagrInputs(facts, years)
    if (!pair || pair[0].value <= 0 || pair[1].value <= 0) continue
    const key = years === 3 ? 'revenue_cagr_3y' : 'revenue_cagr_5y'
    addMetric(output, context, key, (Math.pow(pair[1].value / pair[0].value, 1 / years) - 1) * 100, 'PERCENT', pair, pair[1])
  }

  const forecastDividend = nearestForwardForecast(
    forecasts,
    'dividend_per_share_annual',
    completedFiscalYear,
  )
  if (price && forecastDividend && price.value > 0) {
    addMetric(output, context, 'dividend_yield', (forecastDividend.value / price.value) * 100, 'PERCENT', [forecastDividend, price], forecastDividend)
  }
  const payout = latestFact(facts, 'payout_ratio', 'FY')
  if (payout) addMetric(output, context, 'payout_ratio', payout.value * 100, 'PERCENT', [payout], payout, 'latest_reported_fy_payout_ratio')

  if (!context.isFinancialSector) {
    const cfo = latestFact(facts, 'operating_cash_flow', 'LTM')
    const cfi = latestFact(facts, 'investing_cash_flow', 'LTM')
    if (
      cfo && cfi
      && cfo.periodEnd === cfi.periodEnd
      && cfo.consolidationScope === cfi.consolidationScope
      && cfo.accountingStandard === cfi.accountingStandard
    ) {
      addMetric(output, context, 'simple_fcf', cfo.value + cfi.value, 'JPY', [cfo, cfi], cfo)
    }
  }
  return output
}

export interface AdvancedMetricCalculationContext extends MetricCalculationContext {
  detailedFacts: DetailedFinancialFact[]
}

type AdvancedMetricInput = NormalizedFinancialFact | DetailedFinancialFact | MetricPriceInput

function advancedInputId(input: AdvancedMetricInput): string {
  if ('factId' in input) return input.factId
  return input.inputId
}

function addAdvancedMetric(
  output: CalculatedFinancialMetric[],
  context: AdvancedMetricCalculationContext,
  key: Extract<FinancialMetricKey, 'net_debt' | 'ebitda' | 'standard_fcf' | 'enterprise_value' | 'ev_ebitda' | 'fcf_yield' | 'roic'>,
  value: number | null,
  unit: string,
  inputs: AdvancedMetricInput[],
  anchor: NormalizedFinancialFact | DetailedFinancialFact | null,
): CalculatedFinancialMetric | null {
  if (value == null || !Number.isFinite(value)) return null
  const definition = METRIC_DEFINITION_REGISTRY[key]
  const metric: CalculatedFinancialMetric = {
    valueId: metricValueId(context.ticker, key, context.asOf, definition.version),
    ticker: context.ticker,
    asOf: context.asOf,
    periodStart: anchor?.periodStart ?? null,
    periodEnd: anchor?.periodEnd ?? null,
    metric: key,
    value,
    unit,
    consolidationScope: anchor?.consolidationScope ?? 'consolidated',
    accountingStandard: anchor?.accountingStandard ?? 'UNKNOWN',
    definitionVersion: definition.version,
    derivationMethod: definition.formula,
    inputFactIds: inputs.map(advancedInputId),
    source: 'calculated',
  }
  output.push(metric)
  return metric
}

function latestDetailed(
  facts: DetailedFinancialFact[],
  metric: DetailedFinancialFact['metric'],
  options: { periodEnd?: string; periodStart?: string | null; valueKind?: 'instant' | 'duration' } = {},
): DetailedFinancialFact | undefined {
  const matching = facts.filter((fact) => (
    fact.metric === metric
    && (!options.periodEnd || fact.periodEnd === options.periodEnd)
    && (options.periodStart === undefined || fact.periodStart === options.periodStart)
    && (!options.valueKind || fact.valueKind === options.valueKind)
  ))
  const consolidated = matching.filter((fact) => fact.consolidationScope === 'consolidated')
  return (consolidated.length > 0 ? consolidated : matching)
    .sort((left, right) => (
      left.periodEnd.localeCompare(right.periodEnd)
      || left.publishedAt.localeCompare(right.publishedAt)
      || left.sourcePriority - right.sourcePriority
    ))
    .at(-1)
}

function exactNormalized(
  facts: NormalizedFinancialFact[],
  metric: string,
  periodEnd: string,
  periodStart?: string | null,
  accumulationKind?: string,
): NormalizedFinancialFact | undefined {
  const matching = facts.filter((fact) => (
    fact.metric === metric
    && fact.periodEnd === periodEnd
    && (periodStart === undefined || fact.periodStart === periodStart)
    && (!accumulationKind || fact.accumulationKind === accumulationKind)
  ))
  const consolidated = matching.filter((fact) => fact.consolidationScope === 'consolidated')
  return (consolidated.length > 0 ? consolidated : matching)
    .sort((left, right) => left.publishedAt.localeCompare(right.publishedAt))
    .at(-1)
}

function isTwelveMonthDuration(fact: DetailedFinancialFact): boolean {
  if (!fact.periodStart) return false
  const days = Math.round((Date.parse(`${fact.periodEnd}T00:00:00Z`) - Date.parse(`${fact.periodStart}T00:00:00Z`)) / 86_400_000)
  return days >= 330 && days <= 400
}

function detailedPairCompatible(left: DetailedFinancialFact, right: DetailedFinancialFact): boolean {
  return left.consolidationScope === right.consolidationScope
    && left.accountingStandard === right.accountingStandard
    && left.currency === right.currency
}

function cashAt(
  normalized: NormalizedFinancialFact[],
  detailed: DetailedFinancialFact[],
  anchor: DetailedFinancialFact,
): NormalizedFinancialFact | DetailedFinancialFact | undefined {
  const primary = exactNormalized(normalized, 'cash_and_equivalents', anchor.periodEnd)
  if (primary && primary.consolidationScope === anchor.consolidationScope && primary.accountingStandard === anchor.accountingStandard) {
    return primary
  }
  const fallback = latestDetailed(detailed, 'cash_and_cash_equivalents', {
    periodEnd: anchor.periodEnd,
    valueKind: 'instant',
  })
  return fallback && detailedPairCompatible(anchor, fallback) ? fallback : undefined
}

function marketCapitalizationInput(
  normalized: NormalizedFinancialFact[],
  price: MetricPriceInput | null,
): { value: number; inputs: AdvancedMetricInput[] } | null {
  if (!price || price.value <= 0) return null
  const shares = marketSharesForPeriod(normalized, '9999-12-31')
  if (!shares) return null
  return { value: price.value * shares.value, inputs: [price, ...shares.facts] }
}

function investedCapitalAt(
  normalized: NormalizedFinancialFact[],
  detailed: DetailedFinancialFact[],
  debt: DetailedFinancialFact,
): { value: number; inputs: AdvancedMetricInput[] } | null {
  const equity = exactNormalized(normalized, 'equity_attributable', debt.periodEnd)
  const cash = cashAt(normalized, detailed, debt)
  const nci = latestDetailed(detailed, 'non_controlling_interests', { periodEnd: debt.periodEnd, valueKind: 'instant' })
  if (!equity || !cash || !nci) return null
  if (
    equity.consolidationScope !== debt.consolidationScope
    || equity.accountingStandard !== debt.accountingStandard
    || !detailedPairCompatible(debt, nci)
  ) return null
  return {
    value: equity.value + nci.value + debt.value - cash.value,
    inputs: [equity, nci, debt, cash],
  }
}

/**
 * Detailed metrics are deliberately strict: all duration inputs must have the same
 * period, scope, framework and currency. Missing components produce no value.
 */
export function calculateAdvancedFinancialMetrics(
  context: AdvancedMetricCalculationContext,
): CalculatedFinancialMetric[] {
  if (context.isFinancialSector) return []
  const cutoff = normalizeAsOf(context.asOf)
  const normalized = context.inputsPreparedForAsOf
    ? context.facts
    : context.facts.filter((fact) => fact.ticker === context.ticker && fact.publishedAt <= cutoff)
  const detailed = context.inputsPreparedForAsOf
    ? context.detailedFacts
    : context.detailedFacts.filter((fact) => fact.ticker === context.ticker && fact.publishedAt <= cutoff)
  const price = context.price && context.price.date <= context.asOf.slice(0, 10) ? context.price : null
  const output: CalculatedFinancialMetric[] = []

  const debt = latestDetailed(detailed, 'interest_bearing_debt', { valueKind: 'instant' })
  const cash = debt ? cashAt(normalized, detailed, debt) : undefined
  const netDebtValue = debt && cash ? debt.value - cash.value : null
  const netDebt = debt && cash
    ? addAdvancedMetric(output, context, 'net_debt', netDebtValue, debt.unit, [debt, cash], debt)
    : null

  const da = latestDetailed(detailed, 'depreciation_amortization', { valueKind: 'duration' })
  const operatingProfit = da && isTwelveMonthDuration(da)
    ? exactNormalized(normalized, 'operating_profit', da.periodEnd, da.periodStart, 'LTM')
    : undefined
  const compatibleDa = da && operatingProfit
    && da.consolidationScope === operatingProfit.consolidationScope
    && da.accountingStandard === operatingProfit.accountingStandard
    && da.currency === operatingProfit.currency
  const ebitdaValue = compatibleDa ? operatingProfit.value + da.value : null
  const ebitda = compatibleDa
    ? addAdvancedMetric(output, context, 'ebitda', ebitdaValue, da.unit, [operatingProfit, da], operatingProfit)
    : null

  const capex = latestDetailed(detailed, 'capex', { valueKind: 'duration' })
  const operatingCashFlow = capex && isTwelveMonthDuration(capex)
    ? exactNormalized(normalized, 'operating_cash_flow', capex.periodEnd, capex.periodStart, 'LTM')
    : undefined
  const compatibleCapex = capex && operatingCashFlow
    && capex.consolidationScope === operatingCashFlow.consolidationScope
    && capex.accountingStandard === operatingCashFlow.accountingStandard
    && capex.currency === operatingCashFlow.currency
  const standardFcfValue = compatibleCapex ? operatingCashFlow.value - capex.value : null
  const standardFcf = compatibleCapex
    ? addAdvancedMetric(output, context, 'standard_fcf', standardFcfValue, capex.unit, [operatingCashFlow, capex], operatingCashFlow)
    : null

  const nci = debt ? latestDetailed(detailed, 'non_controlling_interests', { periodEnd: debt.periodEnd, valueKind: 'instant' }) : undefined
  const marketCap = marketCapitalizationInput(normalized, price)
  const evValue = marketCap && netDebt && nci && detailedPairCompatible(debt!, nci)
    ? marketCap.value + netDebt.value + nci.value
    : null
  const ev = marketCap && netDebt && nci
    ? addAdvancedMetric(output, context, 'enterprise_value', evValue, debt!.unit, [...marketCap.inputs, debt!, cash!, nci], debt!)
    : null

  const evEbitda = evaluateEvEbitda(ev?.value, ebitda?.value)
  if (ev && ebitda && evEbitda.status === 'available') {
    addAdvancedMetric(output, context, 'ev_ebitda', evEbitda.value, 'MULTIPLE', [debt!, cash!, nci!, operatingProfit!, da!], operatingProfit!)
  }
  if (standardFcf && marketCap && marketCap.value > 0) {
    addAdvancedMetric(output, context, 'fcf_yield', (standardFcf.value / marketCap.value) * 100, 'PERCENT', [operatingCashFlow!, capex!, ...marketCap.inputs], operatingCashFlow!)
  }

  if (operatingProfit && da) {
    const tax = latestDetailed(detailed, 'income_tax_expense', {
      periodStart: operatingProfit.periodStart,
      periodEnd: operatingProfit.periodEnd,
      valueKind: 'duration',
    })
    const pretax = latestDetailed(detailed, 'profit_before_tax', {
      periodStart: operatingProfit.periodStart,
      periodEnd: operatingProfit.periodEnd,
      valueKind: 'duration',
    })
    const endingDebt = latestDetailed(detailed, 'interest_bearing_debt', { periodEnd: operatingProfit.periodEnd, valueKind: 'instant' })
    const priorDebts = detailed.filter((fact) => (
      fact.metric === 'interest_bearing_debt'
      && fact.valueKind === 'instant'
      && fact.periodEnd < operatingProfit.periodEnd
      && endingDebt
      && detailedPairCompatible(fact, endingDebt)
    )).sort((left, right) => left.periodEnd.localeCompare(right.periodEnd))
    const beginningDebt = priorDebts.at(-1)
    const endingCapital = endingDebt ? investedCapitalAt(normalized, detailed, endingDebt) : null
    const beginningCapital = beginningDebt ? investedCapitalAt(normalized, detailed, beginningDebt) : null
    const taxRate = tax && pretax && pretax.value > 0 ? tax.value / pretax.value : null
    const averageCapital = beginningCapital && endingCapital
      ? (beginningCapital.value + endingCapital.value) / 2
      : null
    if (
      tax && pretax && endingDebt && beginningDebt && beginningCapital && endingCapital
      && taxRate != null && taxRate >= 0 && taxRate <= 1
      && averageCapital != null && averageCapital > 0
    ) {
      const nopat = operatingProfit.value * (1 - taxRate)
      addAdvancedMetric(
        output,
        context,
        'roic',
        (nopat / averageCapital) * 100,
        'PERCENT',
        [operatingProfit, tax, pretax, ...beginningCapital.inputs, ...endingCapital.inputs],
        operatingProfit,
      )
    }
  }
  return output
}
