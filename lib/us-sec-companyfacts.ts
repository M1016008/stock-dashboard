import {
  type AccountingStandard,
  type FinancialDisclosureEvent,
  type FinancialPeriodKind,
  type NormalizedFinancialDataset,
  type NormalizedFinancialFact,
} from '@/lib/financial-foundation'

export type SecCompanyFactUnit = {
  start?: string
  end: string
  val: number
  accn: string
  fy?: number
  fp?: string
  form: string
  filed: string
  frame?: string
}

export type SecCompanyFactConcept = {
  label?: string
  description?: string
  units: Record<string, SecCompanyFactUnit[]>
}

export type SecCompanyFactsPayload = {
  cik: number | string
  entityName: string
  facts: Record<string, Record<string, SecCompanyFactConcept>>
}

export type SecSubmissionRecent = {
  accessionNumber?: string[]
  filingDate?: string[]
  reportDate?: string[]
  acceptanceDateTime?: string[]
  form?: string[]
  primaryDocument?: string[]
}

export type SecSubmissionsPayload = {
  cik?: string
  name?: string
  filings?: {
    recent?: SecSubmissionRecent
  }
}

export type SecCompanyfactsNormalization = NormalizedFinancialDataset & {
  cik: string
  entityName: string
  ignored: {
    unsupportedForms: number
    unsupportedUnits: number
    nonYtdDurations: number
    invalidValues: number
  }
}

type ConceptSpec = {
  namespace: 'us-gaap' | 'ifrs-full' | 'dei'
  concept: string
  metric: string
  valueKind: 'duration' | 'instant'
  units: string[]
  priority: number
}

const CONCEPT_SPECS: readonly ConceptSpec[] = [
  { namespace: 'us-gaap', concept: 'RevenueFromContractWithCustomerExcludingAssessedTax', metric: 'revenue', valueKind: 'duration', units: ['USD'], priority: 10 },
  { namespace: 'us-gaap', concept: 'SalesRevenueNet', metric: 'revenue', valueKind: 'duration', units: ['USD'], priority: 20 },
  { namespace: 'us-gaap', concept: 'Revenues', metric: 'revenue', valueKind: 'duration', units: ['USD'], priority: 30 },
  { namespace: 'ifrs-full', concept: 'Revenue', metric: 'revenue', valueKind: 'duration', units: ['USD'], priority: 10 },
  { namespace: 'us-gaap', concept: 'OperatingIncomeLoss', metric: 'operating_profit', valueKind: 'duration', units: ['USD'], priority: 10 },
  { namespace: 'ifrs-full', concept: 'ProfitLossFromOperatingActivities', metric: 'operating_profit', valueKind: 'duration', units: ['USD'], priority: 10 },
  { namespace: 'us-gaap', concept: 'NetIncomeLoss', metric: 'net_income_attributable', valueKind: 'duration', units: ['USD'], priority: 10 },
  { namespace: 'ifrs-full', concept: 'ProfitLossAttributableToOwnersOfParent', metric: 'net_income_attributable', valueKind: 'duration', units: ['USD'], priority: 10 },
  { namespace: 'us-gaap', concept: 'EarningsPerShareBasic', metric: 'eps_basic', valueKind: 'duration', units: ['USD/shares'], priority: 10 },
  { namespace: 'ifrs-full', concept: 'BasicEarningsLossPerShare', metric: 'eps_basic', valueKind: 'duration', units: ['USD/shares'], priority: 10 },
  { namespace: 'us-gaap', concept: 'WeightedAverageNumberOfSharesOutstandingBasic', metric: 'weighted_average_shares', valueKind: 'duration', units: ['shares'], priority: 10 },
  { namespace: 'ifrs-full', concept: 'WeightedAverageNumberOfSharesOutstanding', metric: 'weighted_average_shares', valueKind: 'duration', units: ['shares'], priority: 10 },
  { namespace: 'us-gaap', concept: 'Assets', metric: 'total_assets', valueKind: 'instant', units: ['USD'], priority: 10 },
  { namespace: 'ifrs-full', concept: 'Assets', metric: 'total_assets', valueKind: 'instant', units: ['USD'], priority: 10 },
  { namespace: 'us-gaap', concept: 'StockholdersEquity', metric: 'equity_attributable', valueKind: 'instant', units: ['USD'], priority: 10 },
  { namespace: 'us-gaap', concept: 'StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest', metric: 'equity_attributable', valueKind: 'instant', units: ['USD'], priority: 20 },
  { namespace: 'ifrs-full', concept: 'EquityAttributableToOwnersOfParent', metric: 'equity_attributable', valueKind: 'instant', units: ['USD'], priority: 10 },
  { namespace: 'us-gaap', concept: 'NetCashProvidedByUsedInOperatingActivities', metric: 'operating_cash_flow', valueKind: 'duration', units: ['USD'], priority: 10 },
  { namespace: 'ifrs-full', concept: 'CashFlowsFromUsedInOperatingActivities', metric: 'operating_cash_flow', valueKind: 'duration', units: ['USD'], priority: 10 },
  { namespace: 'us-gaap', concept: 'NetCashProvidedByUsedInInvestingActivities', metric: 'investing_cash_flow', valueKind: 'duration', units: ['USD'], priority: 10 },
  { namespace: 'ifrs-full', concept: 'CashFlowsFromUsedInInvestingActivities', metric: 'investing_cash_flow', valueKind: 'duration', units: ['USD'], priority: 10 },
  { namespace: 'us-gaap', concept: 'NetCashProvidedByUsedInFinancingActivities', metric: 'financing_cash_flow', valueKind: 'duration', units: ['USD'], priority: 10 },
  { namespace: 'ifrs-full', concept: 'CashFlowsFromUsedInFinancingActivities', metric: 'financing_cash_flow', valueKind: 'duration', units: ['USD'], priority: 10 },
  { namespace: 'us-gaap', concept: 'CashAndCashEquivalentsAtCarryingValue', metric: 'cash_and_equivalents', valueKind: 'instant', units: ['USD'], priority: 10 },
  { namespace: 'ifrs-full', concept: 'CashAndCashEquivalents', metric: 'cash_and_equivalents', valueKind: 'instant', units: ['USD'], priority: 10 },
  { namespace: 'dei', concept: 'EntityCommonStockSharesOutstanding', metric: 'shares_outstanding', valueKind: 'instant', units: ['shares'], priority: 10 },
  { namespace: 'us-gaap', concept: 'TreasuryStockShares', metric: 'treasury_shares', valueKind: 'instant', units: ['shares'], priority: 10 },
  { namespace: 'us-gaap', concept: 'CommonStockDividendsPerShareDeclared', metric: 'dividend_per_share_annual', valueKind: 'duration', units: ['USD/shares'], priority: 10 },
  { namespace: 'us-gaap', concept: 'PaymentsForRepurchaseOfCommonStock', metric: 'share_repurchases', valueKind: 'duration', units: ['USD'], priority: 10 },
] as const

const SUPPORTED_FORMS = new Set(['10-K', '10-K/A', '10-Q', '10-Q/A', '20-F', '20-F/A', '40-F', '40-F/A'])

function stableId(prefix: string, parts: Array<string | number | null | undefined>): string {
  return `${prefix}:${parts.map((part) => encodeURIComponent(String(part ?? ''))).join(':')}`
}

function paddedCik(value: string | number): string {
  return String(value).replace(/^0+/, '').padStart(10, '0')
}

function normalizedTicker(value: string): string {
  return value.trim().toUpperCase().replaceAll('.', '-')
}

function validDate(value: string | undefined): value is string {
  return Boolean(value && /^\d{4}-\d{2}-\d{2}$/.test(value))
}

function dayCount(start: string | undefined, end: string): number | null {
  if (!validDate(start) || !validDate(end)) return null
  const milliseconds = Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)
  if (!Number.isFinite(milliseconds) || milliseconds < 0) return null
  return Math.round(milliseconds / 86_400_000) + 1
}

function periodKind(entry: SecCompanyFactUnit): FinancialPeriodKind {
  const fp = String(entry.fp ?? '').toUpperCase()
  if (fp === 'FY' || entry.form.startsWith('10-K') || entry.form.startsWith('20-F') || entry.form.startsWith('40-F')) return 'FY'
  if (fp === 'Q1') return 'Q1'
  if (fp === 'Q2') return 'Q2'
  if (fp === 'Q3') return 'Q3'
  if (fp === 'Q4') return 'Q4'
  return 'OTHER'
}

function isCumulativeDuration(entry: SecCompanyFactUnit, kind: FinancialPeriodKind): boolean {
  const days = dayCount(entry.start, entry.end)
  if (days == null) return false
  if (kind === 'FY') return days >= 300 && days <= 430
  if (kind === 'Q1') return days >= 45 && days <= 150
  if (kind === 'Q2') return days >= 140 && days <= 230
  if (kind === 'Q3') return days >= 220 && days <= 330
  return false
}

function unitContract(raw: string): { unit: string; currency: string | null } | null {
  if (raw === 'USD') return { unit: 'USD', currency: 'USD' }
  if (raw === 'USD/shares') return { unit: 'USD_PER_SHARE', currency: 'USD' }
  if (raw === 'shares') return { unit: 'SHARES', currency: null }
  if (raw === 'pure') return { unit: 'RATIO', currency: null }
  return null
}

function submissionAcceptanceMap(submissions: SecSubmissionsPayload): Map<string, string> {
  const recent = submissions.filings?.recent
  const output = new Map<string, string>()
  if (!recent?.accessionNumber) return output
  for (let index = 0; index < recent.accessionNumber.length; index += 1) {
    const accession = recent.accessionNumber[index]
    const acceptance = recent.acceptanceDateTime?.[index]
    if (!accession || !acceptance) continue
    const parsed = new Date(acceptance)
    if (!Number.isNaN(parsed.getTime())) output.set(accession, parsed.toISOString())
  }
  return output
}

function conservativePublishedAt(entry: SecCompanyFactUnit, acceptance: Map<string, string>): string | null {
  const exact = acceptance.get(entry.accn)
  if (exact) return exact
  if (!validDate(entry.filed)) return null
  return `${entry.filed}T23:59:59.999Z`
}

function accountingStandard(namespace: ConceptSpec['namespace']): AccountingStandard {
  return namespace === 'ifrs-full' ? 'IFRS' : 'USGAAP'
}

function sourceFactKey(metric: string, entry: SecCompanyFactUnit, unit: string): string {
  return [metric, entry.accn, entry.start ?? '', entry.end, entry.fp ?? '', unit].join('|')
}

function disclosureMetadata(
  cik: string,
  entityName: string,
  entry: SecCompanyFactUnit,
  exactAcceptance: boolean,
): string {
  return JSON.stringify({
    cik,
    entityName,
    form: entry.form,
    filed: entry.filed,
    acceptanceTimeSource: exactAcceptance ? 'sec_submissions' : 'filed_end_of_day_conservative',
  })
}

export function normalizeSecCompanyfacts(
  tickerValue: string,
  companyfacts: SecCompanyFactsPayload,
  submissions: SecSubmissionsPayload = {},
): SecCompanyfactsNormalization {
  const ticker = normalizedTicker(tickerValue)
  const cik = paddedCik(companyfacts.cik)
  const acceptance = submissionAcceptanceMap(submissions)
  const disclosures = new Map<string, FinancialDisclosureEvent>()
  const facts = new Map<string, { priority: number; fact: NormalizedFinancialFact }>()
  const ignored = {
    unsupportedForms: 0,
    unsupportedUnits: 0,
    nonYtdDurations: 0,
    invalidValues: 0,
  }

  for (const spec of [...CONCEPT_SPECS].sort((a, b) => a.priority - b.priority)) {
    const concept = companyfacts.facts[spec.namespace]?.[spec.concept]
    if (!concept) continue
    for (const rawUnit of Object.keys(concept.units)) {
      if (!spec.units.includes(rawUnit)) {
        ignored.unsupportedUnits += concept.units[rawUnit]?.length ?? 0
        continue
      }
      const unit = unitContract(rawUnit)
      if (!unit) continue
      for (const entry of concept.units[rawUnit] ?? []) {
        if (!SUPPORTED_FORMS.has(entry.form)) {
          ignored.unsupportedForms += 1
          continue
        }
        if (!Number.isFinite(entry.val) || !validDate(entry.end) || !entry.accn) {
          ignored.invalidValues += 1
          continue
        }
        const kind = periodKind(entry)
        if (spec.valueKind === 'duration' && !isCumulativeDuration(entry, kind)) {
          ignored.nonYtdDurations += 1
          continue
        }
        const publishedAt = conservativePublishedAt(entry, acceptance)
        if (!publishedAt) {
          ignored.invalidValues += 1
          continue
        }
        const eventId = stableId('sec-disclosure', [cik, entry.accn])
        const corrected = entry.form.endsWith('/A')
        disclosures.set(eventId, {
          eventId,
          ticker,
          publishedAt,
          source: 'sec_companyfacts',
          disclosureId: entry.accn,
          documentType: entry.form,
          accountingStandard: accountingStandard(spec.namespace),
          correctionStatus: corrected ? 'corrected' : 'original',
          metadataJson: disclosureMetadata(cik, companyfacts.entityName, entry, acceptance.has(entry.accn)),
        })

        const key = sourceFactKey(spec.metric, entry, unit.unit)
        const previous = facts.get(key)
        if (previous && previous.priority <= spec.priority) continue
        const targetFiscalYear = Number(entry.fy)
        const accumulationKind = spec.valueKind === 'instant'
          ? 'INSTANT'
          : kind === 'FY' ? 'FY' : 'YTD'
        facts.set(key, {
          priority: spec.priority,
          fact: {
            factId: stableId('sec-fact', [cik, entry.accn, spec.metric, entry.start, entry.end, spec.concept, unit.unit]),
            eventId,
            ticker,
            publishedAt,
            periodStart: spec.valueKind === 'duration' && validDate(entry.start) ? entry.start : null,
            periodEnd: entry.end,
            fiscalYearStart: spec.valueKind === 'duration' && validDate(entry.start) ? entry.start : null,
            // Companyfacts does not expose a PIT fiscal-year-end attribute for
            // interim facts. Keep the grouping field consistently null rather
            // than enriching earlier quarters from a future annual filing.
            fiscalYearEnd: null,
            targetFiscalYear: Number.isInteger(targetFiscalYear) ? targetFiscalYear : null,
            periodKind: kind,
            accumulationKind,
            valueKind: spec.valueKind,
            metric: spec.metric,
            value: Number(entry.val),
            unit: unit.unit,
            currency: unit.currency,
            consolidationScope: 'consolidated',
            accountingStandard: accountingStandard(spec.namespace),
            correctionStatus: corrected ? 'corrected' : 'original',
            source: 'sec_companyfacts',
            sourceField: `${spec.namespace}:${spec.concept}`,
            disclosureId: entry.accn,
            isDerived: false,
            derivationMethod: null,
            inputFactIds: [],
            definitionVersion: 'sec-companyfacts-normalization-v1',
          },
        })
      }
    }
  }

  const normalizedFacts = [...facts.values()].map(({ fact }) => fact)
  const usedEvents = new Set(normalizedFacts.map((fact) => fact.eventId))
  return {
    cik,
    entityName: companyfacts.entityName,
    disclosures: [...disclosures.values()]
      .filter((event) => usedEvents.has(event.eventId))
      .sort((a, b) => a.publishedAt.localeCompare(b.publishedAt) || a.eventId.localeCompare(b.eventId)),
    facts: normalizedFacts
      .sort((a, b) => a.publishedAt.localeCompare(b.publishedAt) || a.periodEnd.localeCompare(b.periodEnd) || a.factId.localeCompare(b.factId)),
    forecasts: [],
    ignored,
  }
}

function distanceDays(left: string, right: string): number {
  return Math.round(Math.abs(
    Date.parse(`${left}T00:00:00Z`) - Date.parse(`${right}T00:00:00Z`),
  ) / 86_400_000)
}

export function deriveSecInstantFinancialFacts(
  facts: NormalizedFinancialFact[],
): NormalizedFinancialFact[] {
  const sourceFacts = facts.filter((fact) => fact.source === 'sec_companyfacts' && !fact.isDerived)
  const byEvent = new Map<string, NormalizedFinancialFact[]>()
  for (const fact of sourceFacts) {
    const eventFacts = byEvent.get(fact.eventId) ?? []
    eventFacts.push(fact)
    byEvent.set(fact.eventId, eventFacts)
  }
  const output: NormalizedFinancialFact[] = []
  for (const eventFacts of byEvent.values()) {
    const equities = eventFacts.filter((fact) => fact.metric === 'equity_attributable' && fact.valueKind === 'instant')
    const assets = eventFacts.filter((fact) => fact.metric === 'total_assets' && fact.valueKind === 'instant')
    const shares = eventFacts.filter((fact) => fact.metric === 'shares_outstanding' && fact.valueKind === 'instant')
    for (const equity of equities) {
      const asset = assets.find((candidate) => candidate.periodEnd === equity.periodEnd)
      if (asset && asset.value > 0) {
        output.push({
          ...equity,
          factId: stableId('sec-derived', [equity.eventId, 'equity_ratio', equity.periodEnd, 'v1']),
          metric: 'equity_ratio',
          value: equity.value / asset.value,
          unit: 'RATIO',
          currency: null,
          source: 'calculated',
          sourceField: null,
          isDerived: true,
          derivationMethod: 'sec_equity_attributable_divided_by_total_assets',
          inputFactIds: [equity.factId, asset.factId],
          definitionVersion: 'sec-equity-ratio-v1',
        })
      }
      const share = shares
        .filter((candidate) => candidate.value > 0 && distanceDays(candidate.periodEnd, equity.periodEnd) <= 60)
        .sort((a, b) => distanceDays(a.periodEnd, equity.periodEnd) - distanceDays(b.periodEnd, equity.periodEnd))[0]
      if (share) {
        output.push({
          ...equity,
          factId: stableId('sec-derived', [equity.eventId, 'bps', equity.periodEnd, share.periodEnd, 'v1']),
          metric: 'bps',
          value: equity.value / share.value,
          unit: 'USD_PER_SHARE',
          currency: 'USD',
          source: 'calculated',
          sourceField: null,
          isDerived: true,
          derivationMethod: 'sec_equity_attributable_divided_by_entity_common_stock_shares_outstanding',
          inputFactIds: [equity.factId, share.factId],
          definitionVersion: 'sec-bps-v1',
        })
      }
    }
  }
  return output.sort((a, b) => a.publishedAt.localeCompare(b.publishedAt) || a.factId.localeCompare(b.factId))
}

export function secTickerAliases(tickerValue: string): string[] {
  const ticker = normalizedTicker(tickerValue)
  return [...new Set([ticker, ticker.replaceAll('-', '.'), ticker.replaceAll('.', '-')])]
}
