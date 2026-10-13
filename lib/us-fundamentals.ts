import { normalizeAsOf, type NormalizedFinancialFact } from '@/lib/financial-foundation'

export type UsFundamentalAvailability = 'available' | 'missing' | 'not_meaningful' | 'not_applicable'

export type UsFundamentalValue = {
  value: number | null
  unit: 'USD' | 'USD_PER_SHARE' | 'PERCENT' | 'MULTIPLE' | 'SHARES' | 'COUNT'
  availability: UsFundamentalAvailability
  reason: string | null
  periodEnd: string | null
  sourceFactIds: string[]
}

export type UsPerformancePeriod = {
  fiscalYear: number
  periodEnd: string
  publishedAt: string
  revenue: UsFundamentalValue
  operatingProfit: UsFundamentalValue
  netIncome: UsFundamentalValue
  eps: UsFundamentalValue
  operatingMargin: UsFundamentalValue
  revenueGrowth: UsFundamentalValue
}

export type UsDividendYear = {
  year: number
  cashPerShare: number
  payments: number
}

export type UsFundamentalsModel = {
  contractVersion: 'us-fundamentals-v1'
  ticker: string
  name: string | null
  asOf: string
  priceDate: string | null
  price: number | null
  currency: 'USD'
  source: 'SEC Companyfacts + Tiingo EOD'
  coverage: {
    status: 'READY' | 'PARTIAL' | 'UNAVAILABLE'
    sourceFacts: number
    latestPublishedAt: string | null
    forecasts: 'UNAVAILABLE'
    forecastReason: string
  }
  summary: {
    revenueGrowth: UsFundamentalValue
    operatingMargin: UsFundamentalValue
    roe: UsFundamentalValue
    equityRatio: UsFundamentalValue
    trailingPer: UsFundamentalValue
    trailingDividendYield: UsFundamentalValue
  }
  performance: { periods: UsPerformancePeriod[] }
  financials: {
    totalAssets: UsFundamentalValue
    equity: UsFundamentalValue
    cash: UsFundamentalValue
    operatingCashFlow: UsFundamentalValue
    freeCashFlow: UsFundamentalValue
  }
  valuation: {
    trailingPer: UsFundamentalValue
    pbr: UsFundamentalValue
    psr: UsFundamentalValue
    marketCap: UsFundamentalValue
    peerComparison: 'UNAVAILABLE'
    peerReason: string
  }
  shareholderReturn: {
    trailingDividendPerShare: UsFundamentalValue
    trailingDividendYield: UsFundamentalValue
    payoutRatio: UsFundamentalValue
    shareRepurchases: UsFundamentalValue
    buybackYield: UsFundamentalValue
    dividendHistory: UsDividendYear[]
  }
}

type BuildInput = {
  ticker: string
  name: string | null
  asOf: string
  price: { date: string; close: number } | null
  facts: NormalizedFinancialFact[]
  dividends: Array<{ date: string; cash: number }>
  dividendCoverageStart: string | null
}

function missing(unit: UsFundamentalValue['unit'], reason: string): UsFundamentalValue {
  return { value: null, unit, availability: 'missing', reason, periodEnd: null, sourceFactIds: [] }
}

function notMeaningful(unit: UsFundamentalValue['unit'], reason: string, facts: NormalizedFinancialFact[] = []): UsFundamentalValue {
  return {
    value: null,
    unit,
    availability: 'not_meaningful',
    reason,
    periodEnd: facts.at(-1)?.periodEnd ?? null,
    sourceFactIds: facts.map((fact) => fact.factId),
  }
}

function available(
  value: number,
  unit: UsFundamentalValue['unit'],
  facts: NormalizedFinancialFact[] = [],
  periodEnd: string | null = facts.at(-1)?.periodEnd ?? null,
): UsFundamentalValue {
  return {
    value,
    unit,
    availability: 'available',
    reason: null,
    periodEnd,
    sourceFactIds: facts.map((fact) => fact.factId),
  }
}

function eligibleFacts(facts: NormalizedFinancialFact[], asOf: string): NormalizedFinancialFact[] {
  const cutoff = normalizeAsOf(asOf)
  return facts.filter((fact) => fact.publishedAt <= cutoff && fact.periodEnd <= asOf)
}

function preferredFacts(
  facts: NormalizedFinancialFact[],
  metric: string,
  accumulationKind?: string,
): NormalizedFinancialFact[] {
  const candidates = facts.filter((fact) => fact.metric === metric && (!accumulationKind || fact.accumulationKind === accumulationKind))
  const byPeriod = new Map<string, NormalizedFinancialFact>()
  for (const fact of candidates) {
    const key = `${fact.periodEnd}|${fact.accumulationKind}|${fact.consolidationScope}|${fact.accountingStandard}`
    const previous = byPeriod.get(key)
    if (!previous || previous.publishedAt < fact.publishedAt) byPeriod.set(key, fact)
  }
  return [...byPeriod.values()].sort((a, b) => a.periodEnd.localeCompare(b.periodEnd) || a.publishedAt.localeCompare(b.publishedAt))
}

function latest(facts: NormalizedFinancialFact[], metric: string, accumulationKind?: string): NormalizedFinancialFact | null {
  return preferredFacts(facts, metric, accumulationKind).at(-1) ?? null
}

function latestAtOrBefore(
  facts: NormalizedFinancialFact[],
  metric: string,
  periodEnd: string,
): NormalizedFinancialFact | null {
  return preferredFacts(facts, metric).filter((fact) => fact.periodEnd <= periodEnd).at(-1) ?? null
}

function valueFromFact(fact: NormalizedFinancialFact | null, unit: UsFundamentalValue['unit'], reason: string): UsFundamentalValue {
  return fact ? available(fact.value, unit, [fact]) : missing(unit, reason)
}

function ratio(
  numerator: NormalizedFinancialFact | null,
  denominator: NormalizedFinancialFact | null,
  reason: string,
): UsFundamentalValue {
  if (!numerator || !denominator) return missing('PERCENT', reason)
  if (denominator.value <= 0) return notMeaningful('PERCENT', `${reason} 分母が正数ではありません。`, [numerator, denominator])
  return available((numerator.value / denominator.value) * 100, 'PERCENT', [numerator, denominator])
}

function returnOnAverageEquity(
  netIncome: NormalizedFinancialFact | null,
  currentEquity: NormalizedFinancialFact | null,
  priorEquity: NormalizedFinancialFact | null,
): UsFundamentalValue {
  if (!netIncome || !currentEquity || !priorEquity) {
    return missing('PERCENT', 'LTM純利益と比較可能な期首・期末純資産が揃っていません。')
  }
  const averageEquity = (currentEquity.value + priorEquity.value) / 2
  if (averageEquity <= 0) {
    return notMeaningful('PERCENT', '平均純資産が正数ではないためROEはN/Mです。', [netIncome, priorEquity, currentEquity])
  }
  return available((netIncome.value / averageEquity) * 100, 'PERCENT', [netIncome, priorEquity, currentEquity])
}

function growth(current: NormalizedFinancialFact | null, previous: NormalizedFinancialFact | null): UsFundamentalValue {
  if (!current || !previous) return missing('PERCENT', '比較可能な前年実績がありません。')
  if (previous.value <= 0) return notMeaningful('PERCENT', '前年値が正数ではないため成長率を算定しません。', [previous, current])
  return available(((current.value / previous.value) - 1) * 100, 'PERCENT', [previous, current])
}

function samePeriodFact(
  facts: NormalizedFinancialFact[],
  metric: string,
  anchor: NormalizedFinancialFact,
  accumulationKind = anchor.accumulationKind,
): NormalizedFinancialFact | null {
  return facts
    .filter((fact) => fact.metric === metric && fact.accumulationKind === accumulationKind && fact.periodEnd === anchor.periodEnd)
    .sort((a, b) => b.publishedAt.localeCompare(a.publishedAt))[0] ?? null
}

function fiscalPeriods(facts: NormalizedFinancialFact[]): UsPerformancePeriod[] {
  const revenues = preferredFacts(facts, 'revenue', 'FY').filter((fact) => fact.targetFiscalYear != null).slice(-6)
  return revenues.map((revenue, index) => {
    const previous = index > 0 ? revenues[index - 1] : null
    const operatingProfit = samePeriodFact(facts, 'operating_profit', revenue, 'FY')
    const netIncome = samePeriodFact(facts, 'net_income_attributable', revenue, 'FY')
    const eps = samePeriodFact(facts, 'eps_basic', revenue, 'FY')
    return {
      fiscalYear: revenue.targetFiscalYear!,
      periodEnd: revenue.periodEnd,
      publishedAt: revenue.publishedAt,
      revenue: available(revenue.value, 'USD', [revenue]),
      operatingProfit: valueFromFact(operatingProfit, 'USD', '同じFYの営業利益がありません。'),
      netIncome: valueFromFact(netIncome, 'USD', '同じFYの純利益がありません。'),
      eps: valueFromFact(eps, 'USD_PER_SHARE', '同じFYのEPSがありません。'),
      operatingMargin: ratio(operatingProfit, revenue, '同じFYの売上高・営業利益が揃っていません。'),
      revenueGrowth: growth(revenue, previous),
    }
  })
}

function annualDividends(rows: Array<{ date: string; cash: number }>, asOf: string): UsDividendYear[] {
  const byYear = new Map<number, { cashPerShare: number; payments: number }>()
  for (const row of rows) {
    if (row.date > asOf || !Number.isFinite(row.cash) || row.cash <= 0) continue
    const year = Number(row.date.slice(0, 4))
    const current = byYear.get(year) ?? { cashPerShare: 0, payments: 0 }
    current.cashPerShare += row.cash
    current.payments += 1
    byYear.set(year, current)
  }
  return [...byYear.entries()].sort(([a], [b]) => a - b).slice(-10).map(([year, value]) => ({ year, ...value }))
}

function trailingDividends(
  rows: Array<{ date: string; cash: number }>,
  asOf: string,
  coverageStart: string | null,
): { cash: number; covered: boolean } {
  const start = new Date(`${asOf}T00:00:00Z`)
  start.setUTCFullYear(start.getUTCFullYear() - 1)
  const startDate = start.toISOString().slice(0, 10)
  return {
    cash: rows.filter((row) => row.date > startDate && row.date <= asOf && row.cash > 0).reduce((sum, row) => sum + row.cash, 0),
    covered: coverageStart != null && coverageStart <= startDate,
  }
}

function marketCap(
  price: BuildInput['price'],
  shares: NormalizedFinancialFact | null,
): UsFundamentalValue {
  if (!price || !shares) return missing('USD', '基準日株価またはSEC株式数factがありません。')
  if (price.close <= 0 || shares.value <= 0) return notMeaningful('USD', '株価または株式数が正数ではありません。', [shares])
  return available(price.close * shares.value, 'USD', [shares], price.date)
}

export function buildUsFundamentalsModel(input: BuildInput): UsFundamentalsModel {
  const facts = eligibleFacts(input.facts, input.asOf)
  const periods = fiscalPeriods(facts)
  const ltmRevenue = latest(facts, 'revenue', 'LTM')
  const revenueLtms = preferredFacts(facts, 'revenue', 'LTM')
  const priorLtmRevenue = revenueLtms.length >= 2 ? revenueLtms.at(-2)! : null
  const ltmOperating = latest(facts, 'operating_profit', 'LTM')
  const ltmNet = latest(facts, 'net_income_attributable', 'LTM')
  const ltmEpsReported = latest(facts, 'eps_basic', 'LTM')
  const weightedShares = latest(facts, 'weighted_average_shares', 'LTM')
  const ltmEpsValue = ltmEpsReported?.value ?? (
    ltmNet && weightedShares && weightedShares.value > 0 ? ltmNet.value / weightedShares.value : null
  )
  const ltmEpsFacts = ltmEpsReported
    ? [ltmEpsReported]
    : ltmNet && weightedShares && weightedShares.value > 0 ? [ltmNet, weightedShares] : []
  const assets = latest(facts, 'total_assets')
  const equity = latest(facts, 'equity_attributable')
  const equityAtAssetsDate = assets ? samePeriodFact(facts, 'equity_attributable', assets, 'INSTANT') : null
  const cash = latest(facts, 'cash_and_equivalents')
  const cfo = latest(facts, 'operating_cash_flow', 'LTM') ?? latest(facts, 'operating_cash_flow', 'FY')
  const capex = cfo ? samePeriodFact(facts, 'capex', cfo, cfo.accumulationKind) : null
  const shares = latest(facts, 'shares_outstanding')
  const marketCapitalization = marketCap(input.price, shares)
  const dividends = annualDividends(input.dividends, input.asOf)
  const trailingDividend = trailingDividends(input.dividends, input.asOf, input.dividendCoverageStart)
  const dividendPerShare = trailingDividend.covered
    ? available(trailingDividend.cash, 'USD_PER_SHARE', [], input.asOf)
    : missing('USD_PER_SHARE', '過去1年分の配当データcoverageを確認できません。')
  const dividendYield = !trailingDividend.covered
    ? missing('PERCENT', '過去1年分の配当データcoverageを確認できません。')
    : input.price && input.price.close > 0
      ? available((trailingDividend.cash / input.price.close) * 100, 'PERCENT', [], input.price.date)
      : missing('PERCENT', '基準日株価がありません。')
  const repurchases = latest(facts, 'share_repurchases', 'LTM') ?? latest(facts, 'share_repurchases', 'FY')
  const cashDividends = ltmNet
    ? samePeriodFact(facts, 'cash_dividends_paid', ltmNet, 'LTM')
    : null

  const trailingPer = input.price && ltmEpsValue != null
    ? ltmEpsValue > 0
      ? available(input.price.close / ltmEpsValue, 'MULTIPLE', ltmEpsFacts, input.price.date)
      : notMeaningful('MULTIPLE', 'LTM EPSが0以下のためPERはN/Mです。', ltmEpsFacts)
    : missing('MULTIPLE', '基準日株価またはLTM EPSがありません。')
  const bps = equity && shares && shares.value > 0 ? equity.value / shares.value : null
  const pbr = input.price && bps != null
    ? bps > 0
      ? available(input.price.close / bps, 'MULTIPLE', [equity!, shares!], input.price.date)
      : notMeaningful('MULTIPLE', '1株当たり純資産が0以下のためPBRはN/Mです。', [equity!, shares!])
    : missing('MULTIPLE', '基準日株価・純資産・株式数が揃っていません。')
  const psr = marketCapitalization.value != null && ltmRevenue
    ? ltmRevenue.value > 0
      ? available(marketCapitalization.value / ltmRevenue.value, 'MULTIPLE', [ltmRevenue, ...(shares ? [shares] : [])], input.price?.date ?? null)
      : notMeaningful('MULTIPLE', 'LTM売上高が0以下のためPSRはN/Mです。', [ltmRevenue])
    : missing('MULTIPLE', '時価総額またはLTM売上高がありません。')
  const roeEndEquity = ltmNet ? latestAtOrBefore(facts, 'equity_attributable', ltmNet.periodEnd) : null
  const roePriorEquity = ltmNet?.periodStart
    ? preferredFacts(facts, 'equity_attributable').filter((fact) => fact.periodEnd < ltmNet.periodStart!).at(-1) ?? null
    : null
  const roe = returnOnAverageEquity(ltmNet, roeEndEquity, roePriorEquity)
  const equityRatio = ratio(equityAtAssetsDate, assets, '同一時点の純資産・総資産が揃っていません。')
  const operatingMargin = ratio(ltmOperating, ltmRevenue, 'LTM売上高または営業利益がありません。')
  const revenueGrowth = growth(ltmRevenue, priorLtmRevenue)
  const freeCashFlow = cfo && capex
    ? available(cfo.value + capex.value, 'USD', [cfo, capex])
    : missing('USD', '営業CFまたは設備投資額がありません。')
  const payoutRatio = cashDividends && ltmNet
    ? ltmNet.value > 0
      ? available((cashDividends.value / ltmNet.value) * 100, 'PERCENT', [cashDividends, ltmNet])
      : notMeaningful('PERCENT', 'LTM純利益が0以下のため配当性向はN/Mです。', [cashDividends, ltmNet])
    : missing('PERCENT', '同じLTM期間の現金配当と純利益が揃っていません。')
  const buybackYield = repurchases && marketCapitalization.value != null && marketCapitalization.value > 0
    ? available((repurchases.value / marketCapitalization.value) * 100, 'PERCENT', [repurchases, ...(shares ? [shares] : [])], input.price?.date ?? null)
    : missing('PERCENT', '自社株買い額または時価総額がありません。')
  const latestPublishedAt = facts.map((fact) => fact.publishedAt).sort().at(-1) ?? null
  const status = facts.length === 0 ? 'UNAVAILABLE' : [ltmRevenue, assets, shares].every(Boolean) ? 'READY' : 'PARTIAL'

  return {
    contractVersion: 'us-fundamentals-v1',
    ticker: input.ticker,
    name: input.name,
    asOf: input.asOf,
    priceDate: input.price?.date ?? null,
    price: input.price?.close ?? null,
    currency: 'USD',
    source: 'SEC Companyfacts + Tiingo EOD',
    coverage: {
      status,
      sourceFacts: facts.filter((fact) => !fact.isDerived).length,
      latestPublishedAt,
      forecasts: 'UNAVAILABLE',
      forecastReason: '承認済みの米国企業予想ソースがないため、会社予想値は表示しません。',
    },
    summary: { revenueGrowth, operatingMargin, roe, equityRatio, trailingPer, trailingDividendYield: dividendYield },
    performance: { periods },
    financials: {
      totalAssets: valueFromFact(assets, 'USD', '総資産factがありません。'),
      equity: valueFromFact(equity, 'USD', '純資産factがありません。'),
      cash: valueFromFact(cash, 'USD', '現金同等物factがありません。'),
      operatingCashFlow: valueFromFact(cfo, 'USD', '営業CF factがありません。'),
      freeCashFlow,
    },
    valuation: {
      trailingPer,
      pbr,
      psr,
      marketCap: marketCapitalization,
      peerComparison: 'UNAVAILABLE',
      peerReason: 'SEC SIC peerのPIT財務coverageが十分になるまで同業分布は表示しません。',
    },
    shareholderReturn: {
      trailingDividendPerShare: dividendPerShare,
      trailingDividendYield: dividendYield,
      payoutRatio,
      shareRepurchases: valueFromFact(repurchases, 'USD', '自社株買いfactがありません。'),
      buybackYield,
      dividendHistory: dividends,
    },
  }
}
