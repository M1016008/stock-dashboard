import type {
  AccountingStandard,
  AccumulationKind,
  FinancialDisclosureEvent,
  FinancialPeriodKind,
  FinancialValueKind,
  NormalizedFinancialDataset,
  NormalizedFinancialFact,
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

export type SecCompanyFacts = {
  cik: number
  entityName: string
  facts: Record<string, Record<string, SecCompanyFactConcept>>
}

type ConceptSpec = {
  taxonomy: 'us-gaap' | 'dei'
  concepts: string[]
  metric: string
  valueKind: FinancialValueKind
  allowedUnits: string[]
  valueSign?: 1 | -1
}

const CONCEPTS: ConceptSpec[] = [
  {
    taxonomy: 'us-gaap',
    concepts: ['RevenueFromContractWithCustomerExcludingAssessedTax', 'Revenues', 'SalesRevenueNet'],
    metric: 'revenue', valueKind: 'duration', allowedUnits: ['USD'],
  },
  {
    taxonomy: 'us-gaap', concepts: ['GrossProfit'],
    metric: 'gross_profit', valueKind: 'duration', allowedUnits: ['USD'],
  },
  {
    taxonomy: 'us-gaap', concepts: ['OperatingIncomeLoss'],
    metric: 'operating_profit', valueKind: 'duration', allowedUnits: ['USD'],
  },
  {
    taxonomy: 'us-gaap', concepts: ['NetIncomeLoss', 'ProfitLoss'],
    metric: 'net_income_attributable', valueKind: 'duration', allowedUnits: ['USD'],
  },
  {
    taxonomy: 'us-gaap', concepts: ['EarningsPerShareBasic'],
    metric: 'eps_basic', valueKind: 'duration', allowedUnits: ['USD/shares'],
  },
  {
    taxonomy: 'us-gaap', concepts: ['EarningsPerShareDiluted'],
    metric: 'eps_diluted', valueKind: 'duration', allowedUnits: ['USD/shares'],
  },
  {
    taxonomy: 'us-gaap', concepts: ['Assets'],
    metric: 'total_assets', valueKind: 'instant', allowedUnits: ['USD'],
  },
  {
    taxonomy: 'us-gaap',
    concepts: ['StockholdersEquity', 'StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest'],
    metric: 'equity_attributable', valueKind: 'instant', allowedUnits: ['USD'],
  },
  {
    taxonomy: 'us-gaap', concepts: ['CashAndCashEquivalentsAtCarryingValue', 'CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalents'],
    metric: 'cash_and_equivalents', valueKind: 'instant', allowedUnits: ['USD'],
  },
  {
    taxonomy: 'us-gaap', concepts: ['NetCashProvidedByUsedInOperatingActivities', 'NetCashProvidedByUsedInOperatingActivitiesContinuingOperations'],
    metric: 'operating_cash_flow', valueKind: 'duration', allowedUnits: ['USD'],
  },
  {
    taxonomy: 'us-gaap', concepts: ['NetCashProvidedByUsedInInvestingActivities', 'NetCashProvidedByUsedInInvestingActivitiesContinuingOperations'],
    metric: 'investing_cash_flow', valueKind: 'duration', allowedUnits: ['USD'],
  },
  {
    taxonomy: 'us-gaap', concepts: ['NetCashProvidedByUsedInFinancingActivities', 'NetCashProvidedByUsedInFinancingActivitiesContinuingOperations'],
    metric: 'financing_cash_flow', valueKind: 'duration', allowedUnits: ['USD'],
  },
  {
    taxonomy: 'us-gaap', concepts: ['WeightedAverageNumberOfSharesOutstandingBasic'],
    metric: 'weighted_average_shares', valueKind: 'duration', allowedUnits: ['shares'],
  },
  {
    taxonomy: 'dei', concepts: ['EntityCommonStockSharesOutstanding'],
    metric: 'shares_outstanding', valueKind: 'instant', allowedUnits: ['shares'],
  },
  {
    taxonomy: 'us-gaap', concepts: ['CommonStockDividendsPerShareDeclared', 'CommonStockDividendsPerShareCashPaid'],
    metric: 'dividend_per_share_annual', valueKind: 'duration', allowedUnits: ['USD/shares'],
  },
  {
    taxonomy: 'us-gaap', concepts: ['PaymentsForRepurchaseOfCommonStock'],
    metric: 'share_repurchases', valueKind: 'duration', allowedUnits: ['USD'],
  },
  {
    taxonomy: 'us-gaap', concepts: ['PaymentsOfDividendsCommonStock', 'PaymentsOfDividends'],
    metric: 'cash_dividends_paid', valueKind: 'duration', allowedUnits: ['USD'],
  },
  {
    taxonomy: 'us-gaap', concepts: ['PaymentsToAcquirePropertyPlantAndEquipment', 'PaymentsToAcquireProductiveAssets'],
    metric: 'capex', valueKind: 'duration', allowedUnits: ['USD'], valueSign: -1,
  },
  {
    taxonomy: 'us-gaap', concepts: ['LongTermDebtCurrent', 'ShortTermBorrowings'],
    metric: 'interest_bearing_debt_current', valueKind: 'instant', allowedUnits: ['USD'],
  },
  {
    taxonomy: 'us-gaap', concepts: ['LongTermDebtNoncurrent', 'LongTermDebtAndFinanceLeaseObligationsNoncurrent'],
    metric: 'interest_bearing_debt_noncurrent', valueKind: 'instant', allowedUnits: ['USD'],
  },
]

const ALLOWED_FORMS = new Set(['10-K', '10-K/A', '10-Q', '10-Q/A', '20-F', '20-F/A', '40-F', '40-F/A'])

function stableId(prefix: string, parts: Array<string | number | null | undefined>): string {
  return `${prefix}:${parts.map((part) => encodeURIComponent(String(part ?? ''))).join(':')}`
}

function filingPublishedAt(filed: string): string {
  // Companyfacts does not carry EDGAR acceptance time. End-of-day UTC is deliberately
  // conservative: a date-only historical query cannot see the filing until the next day.
  return `${filed}T23:59:59.999Z`
}

function accountingStandard(taxonomy: string): AccountingStandard {
  return taxonomy === 'us-gaap' ? 'USGAAP' : 'UNKNOWN'
}

function periodKind(unit: SecCompanyFactUnit, valueKind: FinancialValueKind): FinancialPeriodKind {
  if (valueKind === 'instant') return 'OTHER'
  const fp = String(unit.fp ?? '').toUpperCase()
  if (fp === 'FY') return 'FY'
  if (fp === 'Q1' || fp === 'Q2' || fp === 'Q3' || fp === 'Q4') return fp
  return 'OTHER'
}

function accumulationKind(unit: SecCompanyFactUnit, valueKind: FinancialValueKind): AccumulationKind {
  if (valueKind === 'instant') return 'INSTANT'
  if (String(unit.fp ?? '').toUpperCase() === 'FY') return 'FY'
  return unit.frame ? 'STANDALONE' : 'YTD'
}

function periodStartForFiscalYear(unit: SecCompanyFactUnit): string | null {
  if (!unit.start) return null
  const fy = unit.fy
  if (!fy) return unit.start
  return unit.start
}

function inferFiscalYearEndMonth(payload: SecCompanyFacts): number | null {
  const counts = new Map<number, number>()
  for (const taxonomy of Object.values(payload.facts)) {
    for (const concept of Object.values(taxonomy)) {
      for (const units of Object.values(concept.units)) {
        for (const unit of units) {
          if (!isEligibleUnit(unit) || String(unit.fp ?? '').toUpperCase() !== 'FY') continue
          const month = Number(unit.end.slice(5, 7))
          if (month >= 1 && month <= 12) counts.set(month, (counts.get(month) ?? 0) + 1)
        }
      }
    }
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0])[0]?.[0] ?? null
}

function targetFiscalYear(
  unit: SecCompanyFactUnit,
  kind: FinancialPeriodKind,
  fiscalYearEndMonth: number | null,
): number | null {
  const periodYear = Number(unit.end.slice(0, 4))
  const periodMonth = Number(unit.end.slice(5, 7))
  if (!Number.isInteger(periodYear) || !Number.isInteger(periodMonth)) {
    return Number.isInteger(unit.fy) ? unit.fy! : null
  }
  if (kind === 'FY') return periodYear
  if (fiscalYearEndMonth != null) return periodMonth <= fiscalYearEndMonth ? periodYear : periodYear + 1
  return Number.isInteger(unit.fy) ? unit.fy! : null
}

function unitToNormalized(unit: string): { unit: string; currency: string | null } {
  if (unit === 'USD') return { unit: 'USD', currency: 'USD' }
  if (unit === 'USD/shares') return { unit: 'USD_PER_SHARE', currency: 'USD' }
  if (unit === 'shares') return { unit: 'SHARES', currency: null }
  return { unit, currency: null }
}

function selectConcepts(payload: SecCompanyFacts, spec: ConceptSpec): Array<{
  concept: string
  fact: SecCompanyFactConcept
  priority: number
}> {
  const taxonomy = payload.facts[spec.taxonomy] ?? {}
  return spec.concepts.flatMap((concept, priority) => {
    const fact = taxonomy[concept]
    return fact ? [{ concept, fact, priority }] : []
  })
}

function isEligibleUnit(unit: SecCompanyFactUnit): boolean {
  return Boolean(
    unit.accn
      && unit.filed
      && unit.end
      && Number.isFinite(unit.val)
      && ALLOWED_FORMS.has(unit.form),
  )
}

function correctionStatus(form: string): string {
  return form.endsWith('/A') ? 'amended' : 'original'
}

export function normalizeSecCompanyFacts(
  ticker: string,
  payload: SecCompanyFacts,
): NormalizedFinancialDataset {
  const normalizedTicker = ticker.trim().toUpperCase()
  const disclosures = new Map<string, FinancialDisclosureEvent>()
  const facts: NormalizedFinancialFact[] = []
  const fiscalYearEndMonth = inferFiscalYearEndMonth(payload)

  for (const spec of CONCEPTS) {
    const candidates = new Map<string, { priority: number; fact: NormalizedFinancialFact }>()
    for (const selected of selectConcepts(payload, spec)) {
      for (const [rawUnit, units] of Object.entries(selected.fact.units)) {
        if (!spec.allowedUnits.includes(rawUnit)) continue
        const normalizedUnit = unitToNormalized(rawUnit)
        for (const entry of units) {
          if (!isEligibleUnit(entry)) continue
          const eventId = `sec-companyfacts:${payload.cik}:${entry.accn}`
          const publishedAt = filingPublishedAt(entry.filed)
          if (!disclosures.has(eventId)) {
            disclosures.set(eventId, {
              eventId,
              ticker: normalizedTicker,
              publishedAt,
              source: 'sec_companyfacts',
              disclosureId: entry.accn,
              documentType: entry.form,
              accountingStandard: accountingStandard(spec.taxonomy),
              correctionStatus: correctionStatus(entry.form),
              metadataJson: JSON.stringify({ cik: payload.cik, entityName: payload.entityName, filed: entry.filed }),
            })
          }
          const kind = periodKind(entry, spec.valueKind)
          const accumulation = accumulationKind(entry, spec.valueKind)
          const fact: NormalizedFinancialFact = {
            factId: stableId('sec-fact', [
              payload.cik, entry.accn, spec.taxonomy, selected.concept, rawUnit,
              entry.start, entry.end, entry.frame,
            ]),
            eventId,
            ticker: normalizedTicker,
            publishedAt,
            periodStart: entry.start ?? null,
            periodEnd: entry.end,
            fiscalYearStart: periodStartForFiscalYear(entry),
            fiscalYearEnd: kind === 'FY' ? entry.end : null,
            targetFiscalYear: targetFiscalYear(entry, kind, fiscalYearEndMonth),
            periodKind: kind,
            accumulationKind: accumulation,
            valueKind: spec.valueKind,
            metric: spec.metric,
            value: entry.val * (spec.valueSign ?? 1),
            unit: normalizedUnit.unit,
            currency: normalizedUnit.currency,
            consolidationScope: 'consolidated',
            accountingStandard: accountingStandard(spec.taxonomy),
            correctionStatus: correctionStatus(entry.form),
            source: 'sec_companyfacts',
            sourceField: `${spec.taxonomy}:${selected.concept}`,
            disclosureId: entry.accn,
            isDerived: false,
            derivationMethod: null,
            inputFactIds: [],
            definitionVersion: 'sec-companyfacts-normalization-v1',
          }
          // Companies can switch standard concepts over time. Preserve non-overlapping
          // history while preferring the first approved concept for duplicate contexts.
          const observationKey = [entry.accn, rawUnit, entry.start ?? '', entry.end, entry.frame ?? ''].join('|')
          const previous = candidates.get(observationKey)
          if (!previous || selected.priority < previous.priority) {
            candidates.set(observationKey, { priority: selected.priority, fact })
          }
        }
      }
    }
    facts.push(...[...candidates.values()].map((candidate) => candidate.fact))
  }

  const uniqueFacts = new Map<string, NormalizedFinancialFact>()
  for (const fact of facts) uniqueFacts.set(fact.factId, fact)

  return {
    disclosures: [...disclosures.values()].sort((a, b) => a.publishedAt.localeCompare(b.publishedAt) || a.eventId.localeCompare(b.eventId)),
    facts: [...uniqueFacts.values()].sort((a, b) => a.publishedAt.localeCompare(b.publishedAt) || a.factId.localeCompare(b.factId)),
    forecasts: [],
  }
}

export function secCompanyfactsConceptCoverage(payload: SecCompanyFacts): Array<{
  metric: string
  concept: string | null
  observations: number
}> {
  return CONCEPTS.map((spec) => {
    const selected = selectConcepts(payload, spec)
    const observationKeys = new Set<string>()
    for (const item of selected) {
      for (const [unit, rows] of Object.entries(item.fact.units)) {
        if (!spec.allowedUnits.includes(unit)) continue
        for (const row of rows.filter(isEligibleUnit)) {
          observationKeys.add([row.accn, unit, row.start ?? '', row.end, row.frame ?? ''].join('|'))
        }
      }
    }
    return {
      metric: spec.metric,
      concept: selected.length ? selected.map((item) => item.concept).join(',') : null,
      observations: observationKeys.size,
    }
  })
}
