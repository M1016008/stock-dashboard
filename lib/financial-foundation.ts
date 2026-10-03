import { fromJQuantsCode, type JFinsSummaryRow } from '@/lib/jquants'

export type AccountingStandard = 'IFRS' | 'JGAAP' | 'USGAAP' | 'UNKNOWN'
export type ConsolidationScope = 'consolidated' | 'standalone'
export type FinancialPeriodKind = 'FY' | 'Q1' | 'Q2' | 'Q3' | 'Q4' | 'H1' | 'LTM' | 'OTHER'
export type AccumulationKind = 'STANDALONE' | 'YTD' | 'FY' | 'LTM' | 'INSTANT'
export type FinancialValueKind = 'duration' | 'instant'
export type ForecastScope = 'current_fy' | 'next_fy'
export type ForecastPeriod = 'FY' | 'H1'

export interface FinancialDisclosureEvent {
  eventId: string
  ticker: string
  publishedAt: string
  source: 'jquants'
  disclosureId: string
  documentType: string | null
  accountingStandard: AccountingStandard
  correctionStatus: string
  metadataJson: string
}

export interface NormalizedFinancialFact {
  factId: string
  eventId: string
  ticker: string
  publishedAt: string
  periodStart: string | null
  periodEnd: string
  fiscalYearStart: string | null
  fiscalYearEnd: string | null
  targetFiscalYear: number | null
  periodKind: FinancialPeriodKind
  accumulationKind: AccumulationKind
  valueKind: FinancialValueKind
  metric: string
  value: number
  unit: string
  currency: string | null
  consolidationScope: ConsolidationScope
  accountingStandard: AccountingStandard
  correctionStatus: string
  source: 'jquants' | 'calculated'
  sourceField: string | null
  disclosureId: string
  isDerived: boolean
  derivationMethod: string | null
  inputFactIds: string[]
  definitionVersion: string | null
}

export interface FinancialForecastSnapshot {
  snapshotId: string
  eventId: string
  ticker: string
  publishedAt: string
  targetFiscalYear: number
  targetPeriodStart: string | null
  targetPeriodEnd: string
  forecastScope: ForecastScope
  forecastPeriod: ForecastPeriod
  metric: string
  value: number
  unit: string
  currency: string | null
  consolidationScope: ConsolidationScope
  accountingStandard: AccountingStandard
  source: 'jquants'
  sourceField: string
  disclosureId: string
}

export interface NormalizedFinancialDataset {
  disclosures: FinancialDisclosureEvent[]
  facts: NormalizedFinancialFact[]
  forecasts: FinancialForecastSnapshot[]
}

interface FieldSpec {
  field: string
  metric: string
  unit: string
  valueKind: FinancialValueKind
  currency?: string | null
}

const CORE_FACT_FIELDS: FieldSpec[] = [
  { field: 'Sales', metric: 'revenue', unit: 'JPY', valueKind: 'duration', currency: 'JPY' },
  { field: 'OP', metric: 'operating_profit', unit: 'JPY', valueKind: 'duration', currency: 'JPY' },
  { field: 'OdP', metric: 'ordinary_profit', unit: 'JPY', valueKind: 'duration', currency: 'JPY' },
  { field: 'NP', metric: 'net_income_attributable', unit: 'JPY', valueKind: 'duration', currency: 'JPY' },
  { field: 'EPS', metric: 'eps_basic', unit: 'JPY_PER_SHARE', valueKind: 'duration', currency: 'JPY' },
  { field: 'DEPS', metric: 'eps_diluted', unit: 'JPY_PER_SHARE', valueKind: 'duration', currency: 'JPY' },
  { field: 'TA', metric: 'total_assets', unit: 'JPY', valueKind: 'instant', currency: 'JPY' },
  { field: 'Eq', metric: 'equity_attributable', unit: 'JPY', valueKind: 'instant', currency: 'JPY' },
  { field: 'EqAR', metric: 'equity_ratio', unit: 'RATIO', valueKind: 'instant', currency: null },
  { field: 'BPS', metric: 'bps', unit: 'JPY_PER_SHARE', valueKind: 'instant', currency: 'JPY' },
  { field: 'CFO', metric: 'operating_cash_flow', unit: 'JPY', valueKind: 'duration', currency: 'JPY' },
  { field: 'CFI', metric: 'investing_cash_flow', unit: 'JPY', valueKind: 'duration', currency: 'JPY' },
  { field: 'CFF', metric: 'financing_cash_flow', unit: 'JPY', valueKind: 'duration', currency: 'JPY' },
  { field: 'CashEq', metric: 'cash_and_equivalents', unit: 'JPY', valueKind: 'instant', currency: 'JPY' },
  { field: 'DivAnn', metric: 'dividend_per_share_annual', unit: 'JPY_PER_SHARE', valueKind: 'duration', currency: 'JPY' },
  { field: 'PayoutRatioAnn', metric: 'payout_ratio', unit: 'RATIO', valueKind: 'duration', currency: null },
  { field: 'ShOutFY', metric: 'shares_outstanding', unit: 'SHARES', valueKind: 'instant', currency: null },
  { field: 'TrShFY', metric: 'treasury_shares', unit: 'SHARES', valueKind: 'instant', currency: null },
  { field: 'AvgSh', metric: 'weighted_average_shares', unit: 'SHARES', valueKind: 'duration', currency: null },
]

const STANDALONE_FACT_FIELDS: FieldSpec[] = [
  { field: 'NCSales', metric: 'revenue', unit: 'JPY', valueKind: 'duration', currency: 'JPY' },
  { field: 'NCOP', metric: 'operating_profit', unit: 'JPY', valueKind: 'duration', currency: 'JPY' },
  { field: 'NCOdP', metric: 'ordinary_profit', unit: 'JPY', valueKind: 'duration', currency: 'JPY' },
  { field: 'NCNP', metric: 'net_income_attributable', unit: 'JPY', valueKind: 'duration', currency: 'JPY' },
  { field: 'NCEPS', metric: 'eps_basic', unit: 'JPY_PER_SHARE', valueKind: 'duration', currency: 'JPY' },
  { field: 'NCTA', metric: 'total_assets', unit: 'JPY', valueKind: 'instant', currency: 'JPY' },
  { field: 'NCEq', metric: 'equity_attributable', unit: 'JPY', valueKind: 'instant', currency: 'JPY' },
  { field: 'NCEqAR', metric: 'equity_ratio', unit: 'RATIO', valueKind: 'instant', currency: null },
  { field: 'NCBPS', metric: 'bps', unit: 'JPY_PER_SHARE', valueKind: 'instant', currency: 'JPY' },
  { field: 'NCShEq', metric: 'shareholders_equity', unit: 'JPY', valueKind: 'instant', currency: 'JPY' },
  { field: 'NCROE', metric: 'reported_roe', unit: 'RATIO', valueKind: 'duration', currency: null },
]

const FORECAST_METRICS = [
  { suffix: 'Sales', metric: 'revenue', unit: 'JPY', currency: 'JPY' },
  { suffix: 'OP', metric: 'operating_profit', unit: 'JPY', currency: 'JPY' },
  { suffix: 'OdP', metric: 'ordinary_profit', unit: 'JPY', currency: 'JPY' },
  { suffix: 'NP', metric: 'net_income_attributable', unit: 'JPY', currency: 'JPY' },
  { suffix: 'EPS', metric: 'eps_basic', unit: 'JPY_PER_SHARE', currency: 'JPY' },
  { suffix: 'DivAnn', metric: 'dividend_per_share_annual', unit: 'JPY_PER_SHARE', currency: 'JPY' },
  { suffix: 'PayoutRatioAnn', metric: 'payout_ratio', unit: 'RATIO', currency: null },
] as const

const ADDITIVE_DURATION_METRICS = new Set([
  'revenue',
  'operating_profit',
  'ordinary_profit',
  'net_income_attributable',
  'operating_cash_flow',
  'investing_cash_flow',
  'financing_cash_flow',
])

function rawRecord(row: JFinsSummaryRow): Record<string, unknown> {
  return row as unknown as Record<string, unknown>
}

function numberValue(value: unknown): number | null {
  if (value == null || value === '') return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function truthyFlag(value: unknown): boolean {
  return value === true || value === 1 || ['true', '1'].includes(String(value).toLowerCase())
}

function disclosureId(row: JFinsSummaryRow): string {
  return row.DiscNo || [row.DiscDate, row.DiscTime, row.DocType, row.CurPerType, row.CurPerEn]
    .filter(Boolean)
    .join(':')
}

function eventId(ticker: string, id: string): string {
  return `jquants:${ticker}:${id}`
}

function stableId(prefix: string, parts: Array<string | number | null | undefined>): string {
  return `${prefix}:${parts.map((part) => encodeURIComponent(String(part ?? ''))).join(':')}`
}

function accountingStandard(documentType: string | null | undefined): AccountingStandard {
  const value = String(documentType ?? '').toUpperCase()
  if (value.includes('IFRS')) return 'IFRS'
  if (/(^|_)US($|_)/.test(value) || value.includes('USGAAP')) return 'USGAAP'
  if (/(^|_)JP($|_)/.test(value) || value.includes('JGAAP')) return 'JGAAP'
  return 'UNKNOWN'
}

function documentScope(documentType: string | null | undefined): ConsolidationScope {
  return /nonconsolidated/i.test(String(documentType ?? '')) ? 'standalone' : 'consolidated'
}

function correctionStatus(row: JFinsSummaryRow): string {
  const raw = rawRecord(row)
  if (truthyFlag(raw.RetroRst)) return 'restated'
  if (/correction|訂正/i.test(row.DocType ?? '')) return 'corrected'
  return 'original'
}

function periodKind(value: string | null | undefined): FinancialPeriodKind {
  const normalized = String(value ?? '').toUpperCase()
  if (normalized === '1Q' || normalized === 'Q1') return 'Q1'
  if (normalized === '2Q' || normalized === 'Q2') return 'Q2'
  if (normalized === '3Q' || normalized === 'Q3') return 'Q3'
  if (normalized === '4Q' || normalized === 'Q4') return 'Q4'
  if (normalized === 'FY') return 'FY'
  if (normalized === 'H1') return 'H1'
  return 'OTHER'
}

function publishedAt(row: JFinsSummaryRow): string {
  const time = /^\d{2}:\d{2}(:\d{2})?$/.test(row.DiscTime ?? '')
    ? row.DiscTime.length === 5 ? `${row.DiscTime}:00` : row.DiscTime
    : '00:00:00'
  return new Date(`${row.DiscDate}T${time}+09:00`).toISOString()
}

function fiscalYear(date: string | null | undefined): number | null {
  const year = Number(String(date ?? '').slice(0, 4))
  return Number.isInteger(year) && year > 1900 ? year : null
}

function datePlusMonthsMinusDay(date: string | null | undefined, months: number): string | null {
  if (!date) return null
  const parsed = new Date(`${date}T00:00:00Z`)
  if (Number.isNaN(parsed.getTime())) return null
  parsed.setUTCMonth(parsed.getUTCMonth() + months)
  parsed.setUTCDate(parsed.getUTCDate() - 1)
  return parsed.toISOString().slice(0, 10)
}

function nextDate(date: string | null): string | null {
  if (!date) return null
  const parsed = new Date(`${date}T00:00:00Z`)
  if (Number.isNaN(parsed.getTime())) return null
  parsed.setUTCDate(parsed.getUTCDate() + 1)
  return parsed.toISOString().slice(0, 10)
}

function dayDistance(a: string, b: string): number {
  return Math.round(Math.abs(Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86_400_000)
}

function inclusiveDays(start: string | null, end: string): number | null {
  if (!start) return null
  const days = Math.round((Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86_400_000) + 1
  return Number.isFinite(days) && days > 0 ? days : null
}

function actualAccumulation(kind: FinancialPeriodKind, valueKind: FinancialValueKind): AccumulationKind {
  if (valueKind === 'instant') return 'INSTANT'
  return kind === 'FY' ? 'FY' : 'YTD'
}

function factFromField(
  row: JFinsSummaryRow,
  spec: FieldSpec,
  scope: ConsolidationScope,
  event: FinancialDisclosureEvent,
): NormalizedFinancialFact | null {
  const value = numberValue(rawRecord(row)[spec.field])
  if (value == null || !row.CurPerEn) return null
  const kind = periodKind(row.CurPerType)
  return {
    factId: stableId('fact', [event.eventId, spec.field, scope, kind]),
    eventId: event.eventId,
    ticker: event.ticker,
    publishedAt: event.publishedAt,
    periodStart: row.CurPerSt || null,
    periodEnd: row.CurPerEn,
    fiscalYearStart: row.CurFYSt || null,
    fiscalYearEnd: row.CurFYEn || null,
    targetFiscalYear: fiscalYear(row.CurFYEn),
    periodKind: kind,
    accumulationKind: actualAccumulation(kind, spec.valueKind),
    valueKind: spec.valueKind,
    metric: spec.metric,
    value,
    unit: spec.unit,
    currency: spec.currency ?? null,
    consolidationScope: scope,
    accountingStandard: event.accountingStandard,
    correctionStatus: event.correctionStatus,
    source: 'jquants',
    sourceField: spec.field,
    disclosureId: event.disclosureId,
    isDerived: false,
    derivationMethod: null,
    inputFactIds: [],
    definitionVersion: null,
  }
}

function forecastFieldNames(
  metricSuffix: string,
  scope: ConsolidationScope,
  horizon: ForecastScope,
  period: ForecastPeriod,
): string[] {
  const next = horizon === 'next_fy' ? 'Nx' : ''
  const standalone = scope === 'standalone' ? 'NC' : ''
  const periodSuffix = period === 'H1' ? '2Q' : ''
  const canonical = `${next}F${standalone}${metricSuffix}${periodSuffix}`
  if (canonical === 'NxFNP') return ['NxFNp', 'NxFNP']
  if (canonical === 'NxFNP2Q') return ['NxFNp2Q', 'NxFNP2Q']
  return [canonical]
}

function forecastFromField(
  row: JFinsSummaryRow,
  metric: typeof FORECAST_METRICS[number],
  scope: ConsolidationScope,
  horizon: ForecastScope,
  period: ForecastPeriod,
  event: FinancialDisclosureEvent,
): FinancialForecastSnapshot | null {
  const raw = rawRecord(row)
  const sourceField = forecastFieldNames(metric.suffix, scope, horizon, period)
    .find((field) => numberValue(raw[field]) != null)
  if (!sourceField) return null
  const value = numberValue(raw[sourceField])
  const targetStart = horizon === 'current_fy' ? row.CurFYSt : String(raw.NxtFYSt ?? '')
  const fiscalEnd = horizon === 'current_fy' ? row.CurFYEn : String(raw.NxtFYEn ?? '')
  const targetEnd = period === 'FY' ? fiscalEnd : datePlusMonthsMinusDay(targetStart, 6)
  const targetYear = fiscalYear(fiscalEnd)
  if (value == null || !targetEnd || targetYear == null) return null
  return {
    snapshotId: stableId('forecast', [event.eventId, sourceField, scope, horizon, period]),
    eventId: event.eventId,
    ticker: event.ticker,
    publishedAt: event.publishedAt,
    targetFiscalYear: targetYear,
    targetPeriodStart: targetStart || null,
    targetPeriodEnd: targetEnd,
    forecastScope: horizon,
    forecastPeriod: period,
    metric: metric.metric,
    value,
    unit: metric.unit,
    currency: metric.currency,
    consolidationScope: scope,
    accountingStandard: event.accountingStandard,
    source: 'jquants',
    sourceField,
    disclosureId: event.disclosureId,
  }
}

export function normalizeJQuantsFinancialRows(rows: JFinsSummaryRow[]): NormalizedFinancialDataset {
  const disclosures = new Map<string, FinancialDisclosureEvent>()
  const facts = new Map<string, NormalizedFinancialFact>()
  const forecasts = new Map<string, FinancialForecastSnapshot>()

  for (const row of rows) {
    if (!row.Code || !row.DiscDate) continue
    const ticker = fromJQuantsCode(row.Code)
    const id = disclosureId(row)
    const standard = accountingStandard(row.DocType)
    const event: FinancialDisclosureEvent = {
      eventId: eventId(ticker, id),
      ticker,
      publishedAt: publishedAt(row),
      source: 'jquants',
      disclosureId: id,
      documentType: row.DocType || null,
      accountingStandard: standard,
      correctionStatus: correctionStatus(row),
      metadataJson: JSON.stringify({
        currentFiscalYearStart: row.CurFYSt || null,
        currentFiscalYearEnd: row.CurFYEn || null,
        nextFiscalYearStart: rawRecord(row).NxtFYSt || null,
        nextFiscalYearEnd: rawRecord(row).NxtFYEn || null,
        retrospectiveRestatement: truthyFlag(rawRecord(row).RetroRst),
        accountingEstimateChange: truthyFlag(rawRecord(row).ChgAcEst),
        accountingStandardRevision: truthyFlag(rawRecord(row).ChgByASRev),
      }),
    }
    disclosures.set(event.eventId, event)

    const primaryScope = documentScope(row.DocType)
    for (const spec of CORE_FACT_FIELDS) {
      const fact = factFromField(row, spec, primaryScope, event)
      if (fact) facts.set(fact.factId, fact)
    }
    for (const spec of STANDALONE_FACT_FIELDS) {
      const fact = factFromField(row, spec, 'standalone', event)
      if (fact) facts.set(fact.factId, fact)
    }

    for (const horizon of ['current_fy', 'next_fy'] as const) {
      for (const forecastPeriod of ['FY', 'H1'] as const) {
        for (const scope of [primaryScope, 'standalone'] as const) {
          for (const metric of FORECAST_METRICS) {
            const snapshot = forecastFromField(row, metric, scope, horizon, forecastPeriod, event)
            if (snapshot) forecasts.set(snapshot.snapshotId, snapshot)
          }
        }
      }
    }
  }

  return {
    disclosures: [...disclosures.values()].sort((a, b) => a.publishedAt.localeCompare(b.publishedAt)),
    facts: [...facts.values()].sort((a, b) => a.publishedAt.localeCompare(b.publishedAt)),
    forecasts: [...forecasts.values()].sort((a, b) => a.publishedAt.localeCompare(b.publishedAt)),
  }
}

export function normalizeAsOf(asOf: string): string {
  const value = /^\d{4}-\d{2}-\d{2}$/.test(asOf)
    ? `${asOf}T23:59:59.999+09:00`
    : asOf
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? value : parsed.toISOString()
}

export function selectForecastsAsOf(
  snapshots: FinancialForecastSnapshot[],
  asOf: string,
): FinancialForecastSnapshot[] {
  const cutoff = normalizeAsOf(asOf)
  const latest = new Map<string, FinancialForecastSnapshot>()
  for (const snapshot of snapshots) {
    if (snapshot.publishedAt > cutoff) continue
    const key = [
      snapshot.ticker,
      snapshot.targetFiscalYear,
      snapshot.forecastScope,
      snapshot.forecastPeriod,
      snapshot.metric,
      snapshot.consolidationScope,
      snapshot.accountingStandard,
    ].join('|')
    const previous = latest.get(key)
    if (!previous || previous.publishedAt < snapshot.publishedAt) latest.set(key, snapshot)
  }
  return [...latest.values()].sort((a, b) => a.snapshotId.localeCompare(b.snapshotId))
}

function derivationGroup(fact: NormalizedFinancialFact, includeFiscalYear = true): string {
  return [
    fact.ticker,
    fact.metric,
    fact.consolidationScope,
    fact.accountingStandard,
    fact.currency ?? '',
    fact.unit,
    fact.correctionStatus,
    includeFiscalYear ? fact.fiscalYearStart ?? '' : '',
    includeFiscalYear ? fact.fiscalYearEnd ?? '' : '',
  ].join('|')
}

function latestEligibleFact(
  facts: NormalizedFinancialFact[],
  period: FinancialPeriodKind,
  target: NormalizedFinancialFact,
): NormalizedFinancialFact | undefined {
  return facts
    .filter((candidate) => (
      candidate.periodKind === period
      && candidate.publishedAt <= target.publishedAt
      && candidate.periodEnd < target.periodEnd
      && derivationGroup(candidate) === derivationGroup(target)
    ))
    .sort((a, b) => b.publishedAt.localeCompare(a.publishedAt))[0]
}

export function deriveStandaloneQuarterFacts(facts: NormalizedFinancialFact[]): NormalizedFinancialFact[] {
  const base = facts.filter((fact) => (
    !fact.isDerived
    && fact.valueKind === 'duration'
    && ADDITIVE_DURATION_METRICS.has(fact.metric)
    && (fact.accumulationKind === 'YTD' || fact.accumulationKind === 'FY')
  ))
  const derived: NormalizedFinancialFact[] = []

  for (const target of base) {
    let prior: NormalizedFinancialFact | undefined
    let outputPeriod: FinancialPeriodKind | null = null
    if (target.periodKind === 'Q1') outputPeriod = 'Q1'
    if (target.periodKind === 'Q2') {
      outputPeriod = 'Q2'
      prior = latestEligibleFact(base, 'Q1', target)
    }
    if (target.periodKind === 'Q3') {
      outputPeriod = 'Q3'
      prior = latestEligibleFact(base, 'Q2', target)
    }
    if (target.periodKind === 'FY') {
      outputPeriod = 'Q4'
      prior = latestEligibleFact(base, 'Q3', target)
    }
    if (!outputPeriod || (outputPeriod !== 'Q1' && !prior)) continue

    const value = prior ? target.value - prior.value : target.value
    const inputFactIds = prior ? [target.factId, prior.factId] : [target.factId]
    derived.push({
      ...target,
      factId: stableId('derived-quarter', [target.factId, prior?.factId, 'v1']),
      periodStart: prior ? nextDate(prior.periodEnd) : target.fiscalYearStart,
      periodKind: outputPeriod,
      accumulationKind: 'STANDALONE',
      value,
      source: 'calculated',
      sourceField: null,
      isDerived: true,
      derivationMethod: outputPeriod === 'Q1' ? 'q1_ytd_identity' : 'cumulative_difference',
      inputFactIds,
      definitionVersion: 'quarter-standalone-v1',
    })
  }
  return derived
}

export function deriveStandaloneWeightedAverageShareFacts(
  facts: NormalizedFinancialFact[],
): NormalizedFinancialFact[] {
  const base = facts.filter((fact) => (
    !fact.isDerived
    && fact.metric === 'weighted_average_shares'
    && fact.valueKind === 'duration'
    && (fact.accumulationKind === 'YTD' || fact.accumulationKind === 'FY')
  ))
  const derived: NormalizedFinancialFact[] = []
  for (const target of base) {
    let prior: NormalizedFinancialFact | undefined
    let outputPeriod: FinancialPeriodKind | null = null
    if (target.periodKind === 'Q1') outputPeriod = 'Q1'
    if (target.periodKind === 'Q2') {
      outputPeriod = 'Q2'
      prior = latestEligibleFact(base, 'Q1', target)
    }
    if (target.periodKind === 'Q3') {
      outputPeriod = 'Q3'
      prior = latestEligibleFact(base, 'Q2', target)
    }
    if (target.periodKind === 'FY') {
      outputPeriod = 'Q4'
      prior = latestEligibleFact(base, 'Q3', target)
    }
    if (!outputPeriod || (outputPeriod !== 'Q1' && !prior)) continue
    const targetDays = inclusiveDays(target.fiscalYearStart, target.periodEnd)
    const priorDays = prior ? inclusiveDays(target.fiscalYearStart, prior.periodEnd) : 0
    const quarterDays = targetDays != null && priorDays != null ? targetDays - priorDays : null
    if (targetDays == null || priorDays == null || quarterDays == null || quarterDays <= 0) continue
    const value = prior
      ? ((target.value * targetDays) - (prior.value * priorDays)) / quarterDays
      : target.value
    if (!Number.isFinite(value) || value <= 0) continue
    derived.push({
      ...target,
      factId: stableId('derived-quarter-shares', [target.factId, prior?.factId, 'v1']),
      periodStart: prior ? nextDate(prior.periodEnd) : target.fiscalYearStart,
      periodKind: outputPeriod,
      accumulationKind: 'STANDALONE',
      value,
      source: 'calculated',
      sourceField: null,
      isDerived: true,
      derivationMethod: outputPeriod === 'Q1'
        ? 'q1_weighted_average_identity'
        : 'cumulative_share_days_difference',
      inputFactIds: prior ? [target.factId, prior.factId] : [target.factId],
      definitionVersion: 'quarter-weighted-average-shares-v1',
    })
  }
  return derived
}

function areConsecutiveQuarters(facts: NormalizedFinancialFact[]): boolean {
  if (facts.length !== 4) return false
  for (let index = 1; index < facts.length; index++) {
    const gap = dayDistance(facts[index - 1].periodEnd, facts[index].periodEnd)
    if (gap < 70 || gap > 110) return false
  }
  return dayDistance(facts[0].periodEnd, facts[3].periodEnd) >= 260
}

export function deriveLtmFacts(standaloneFacts: NormalizedFinancialFact[]): NormalizedFinancialFact[] {
  const quarters = standaloneFacts
    .filter((fact) => fact.accumulationKind === 'STANDALONE' && ADDITIVE_DURATION_METRICS.has(fact.metric))
    .sort((a, b) => a.periodEnd.localeCompare(b.periodEnd) || a.publishedAt.localeCompare(b.publishedAt))
  const derived: NormalizedFinancialFact[] = []

  for (const current of quarters) {
    const byPeriodEnd = new Map<string, NormalizedFinancialFact>()
    for (const candidate of quarters) {
      if (
        candidate.periodEnd > current.periodEnd
        || candidate.publishedAt > current.publishedAt
        || derivationGroup(candidate, false) !== derivationGroup(current, false)
      ) continue
      const previous = byPeriodEnd.get(candidate.periodEnd)
      if (!previous || previous.publishedAt < candidate.publishedAt) {
        byPeriodEnd.set(candidate.periodEnd, candidate)
      }
    }
    const inputs = [...byPeriodEnd.values()]
      .sort((a, b) => a.periodEnd.localeCompare(b.periodEnd))
      .slice(-4)
    if (!areConsecutiveQuarters(inputs) || inputs.at(-1)?.factId !== current.factId) continue
    derived.push({
      ...current,
      factId: stableId('derived-ltm', [current.factId, ...inputs.map((fact) => fact.factId), 'v1']),
      periodStart: inputs[0].periodStart,
      periodKind: 'LTM',
      accumulationKind: 'LTM',
      value: inputs.reduce((sum, fact) => sum + fact.value, 0),
      source: 'calculated',
      sourceField: null,
      isDerived: true,
      derivationMethod: 'sum_four_standalone_quarters',
      inputFactIds: inputs.map((fact) => fact.factId),
      definitionVersion: 'ltm-four-quarters-v1',
    })
  }
  return derived
}

export function deriveLtmWeightedAverageShareFacts(
  standaloneFacts: NormalizedFinancialFact[],
): NormalizedFinancialFact[] {
  const quarters = standaloneFacts
    .filter((fact) => fact.metric === 'weighted_average_shares' && fact.accumulationKind === 'STANDALONE')
    .sort((a, b) => a.periodEnd.localeCompare(b.periodEnd) || a.publishedAt.localeCompare(b.publishedAt))
  const derived: NormalizedFinancialFact[] = []
  for (const current of quarters) {
    const byPeriodEnd = new Map<string, NormalizedFinancialFact>()
    for (const candidate of quarters) {
      if (
        candidate.periodEnd > current.periodEnd
        || candidate.publishedAt > current.publishedAt
        || derivationGroup(candidate, false) !== derivationGroup(current, false)
      ) continue
      const previous = byPeriodEnd.get(candidate.periodEnd)
      if (!previous || previous.publishedAt < candidate.publishedAt) byPeriodEnd.set(candidate.periodEnd, candidate)
    }
    const inputs = [...byPeriodEnd.values()]
      .sort((a, b) => a.periodEnd.localeCompare(b.periodEnd))
      .slice(-4)
    if (!areConsecutiveQuarters(inputs) || inputs.at(-1)?.factId !== current.factId) continue
    const weighted = inputs.map((fact) => ({ fact, days: inclusiveDays(fact.periodStart, fact.periodEnd) }))
    if (weighted.some(({ days }) => days == null)) continue
    const totalDays = weighted.reduce((sum, item) => sum + item.days!, 0)
    const value = weighted.reduce((sum, item) => sum + (item.fact.value * item.days!), 0) / totalDays
    derived.push({
      ...current,
      factId: stableId('derived-ltm-shares', [current.factId, ...inputs.map((fact) => fact.factId), 'v1']),
      periodStart: inputs[0].periodStart,
      periodKind: 'LTM',
      accumulationKind: 'LTM',
      value,
      source: 'calculated',
      sourceField: null,
      isDerived: true,
      derivationMethod: 'share_day_weighted_four_standalone_quarters',
      inputFactIds: inputs.map((fact) => fact.factId),
      definitionVersion: 'ltm-weighted-average-shares-v1',
    })
  }
  return derived
}

export function deriveFallbackLtmFacts(
  facts: NormalizedFinancialFact[],
  preferredLtmFacts: NormalizedFinancialFact[],
): NormalizedFinancialFact[] {
  const base = facts.filter((fact) => (
    !fact.isDerived
    && fact.valueKind === 'duration'
    && ADDITIVE_DURATION_METRICS.has(fact.metric)
    && (fact.accumulationKind === 'YTD' || fact.accumulationKind === 'FY')
  ))
  const hasPreferred = (target: NormalizedFinancialFact) => preferredLtmFacts.some((fact) => (
    fact.periodEnd === target.periodEnd
    && fact.publishedAt === target.publishedAt
    && derivationGroup(fact, false) === derivationGroup(target, false)
  ))
  const derived: NormalizedFinancialFact[] = []
  for (const target of base) {
    if (hasPreferred(target)) continue
    if (target.periodKind === 'FY') {
      derived.push({
        ...target,
        factId: stableId('derived-ltm-fy', [target.factId, 'v1']),
        periodKind: 'LTM',
        accumulationKind: 'LTM',
        source: 'calculated',
        sourceField: null,
        isDerived: true,
        derivationMethod: 'completed_fy_identity',
        inputFactIds: [target.factId],
        definitionVersion: 'ltm-fy-fallback-v1',
      })
      continue
    }
    if (!['Q1', 'Q2', 'Q3'].includes(target.periodKind) || target.targetFiscalYear == null) continue
    const comparable = base
      .filter((fact) => (
        fact.periodKind === target.periodKind
        && fact.targetFiscalYear === target.targetFiscalYear! - 1
        && fact.publishedAt <= target.publishedAt
        && derivationGroup(fact, false) === derivationGroup(target, false)
      ))
      .sort((a, b) => b.publishedAt.localeCompare(a.publishedAt))[0]
    const previousFy = base
      .filter((fact) => (
        fact.periodKind === 'FY'
        && fact.targetFiscalYear === target.targetFiscalYear! - 1
        && fact.publishedAt <= target.publishedAt
        && derivationGroup(fact, false) === derivationGroup(target, false)
      ))
      .sort((a, b) => b.publishedAt.localeCompare(a.publishedAt))[0]
    if (!comparable || !previousFy || dayDistance(comparable.periodEnd, target.periodEnd) > 400) continue
    derived.push({
      ...target,
      factId: stableId('derived-ltm-ytd', [previousFy.factId, target.factId, comparable.factId, 'v1']),
      periodStart: nextDate(comparable.periodEnd),
      periodKind: 'LTM',
      accumulationKind: 'LTM',
      value: previousFy.value + target.value - comparable.value,
      source: 'calculated',
      sourceField: null,
      isDerived: true,
      derivationMethod: 'previous_fy_plus_current_ytd_minus_prior_ytd',
      inputFactIds: [previousFy.factId, target.factId, comparable.factId],
      definitionVersion: 'ltm-ytd-fallback-v1',
    })
  }
  return derived
}

export function deriveFinancialFacts(facts: NormalizedFinancialFact[]): NormalizedFinancialFact[] {
  const standalone = deriveStandaloneQuarterFacts(facts)
  const standaloneShares = deriveStandaloneWeightedAverageShareFacts(facts)
  const ltm = deriveLtmFacts(standalone)
  return [
    ...standalone,
    ...standaloneShares,
    ...ltm,
    ...deriveFallbackLtmFacts(facts, ltm),
    ...deriveLtmWeightedAverageShareFacts(standaloneShares),
  ]
}
