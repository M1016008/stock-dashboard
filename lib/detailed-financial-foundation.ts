import { createHash } from 'node:crypto'

import {
  XbrlFactReader,
  type XbrlContext,
  type XbrlFact,
} from '@/lib/edinet-xbrl-facts'
import type {
  AccountingStandard,
  ConsolidationScope,
} from '@/lib/financial-foundation'

export type DetailedFinancialMetric =
  | 'cash_and_cash_equivalents'
  | 'accounts_receivable'
  | 'inventories'
  | 'current_assets'
  | 'property_plant_equipment'
  | 'intangible_assets'
  | 'goodwill'
  | 'current_liabilities'
  | 'short_term_debt'
  | 'long_term_debt'
  | 'bonds'
  | 'lease_liabilities'
  | 'non_controlling_interests'
  | 'gross_profit'
  | 'cost_of_sales'
  | 'selling_general_admin_expenses'
  | 'depreciation_amortization'
  | 'interest_expense'
  | 'income_tax_expense'
  | 'profit_before_tax'
  | 'capex_property_plant_equipment'
  | 'capex_intangible_assets'
  | 'capex'
  | 'interest_bearing_debt'

export type DetailedFinancialSource = 'jquants_summary' | 'jquants_details' | 'edinet_xbrl' | 'calculated'

export interface DetailedFinancialSourcePolicy {
  metric: DetailedFinancialMetric
  primary: DetailedFinancialSource
  fallback: DetailedFinancialSource[]
  note: string
}

const JQUANTS_DETAIL_NOTE = 'J-Quants /fins/details is preferred when the subscription exposes it; EDINET is the current fallback.'

export const DETAILED_FINANCIAL_SOURCE_POLICIES: Readonly<Record<DetailedFinancialMetric, DetailedFinancialSourcePolicy>> = {
  cash_and_cash_equivalents: {
    metric: 'cash_and_cash_equivalents', primary: 'jquants_summary', fallback: ['jquants_details', 'edinet_xbrl'],
    note: 'CashEq remains the standardized primary; cash and deposits are not silently substituted.',
  },
  accounts_receivable: { metric: 'accounts_receivable', primary: 'jquants_details', fallback: ['edinet_xbrl'], note: JQUANTS_DETAIL_NOTE },
  inventories: { metric: 'inventories', primary: 'jquants_details', fallback: ['edinet_xbrl'], note: JQUANTS_DETAIL_NOTE },
  current_assets: { metric: 'current_assets', primary: 'jquants_details', fallback: ['edinet_xbrl'], note: JQUANTS_DETAIL_NOTE },
  property_plant_equipment: { metric: 'property_plant_equipment', primary: 'jquants_details', fallback: ['edinet_xbrl'], note: JQUANTS_DETAIL_NOTE },
  intangible_assets: { metric: 'intangible_assets', primary: 'jquants_details', fallback: ['edinet_xbrl'], note: JQUANTS_DETAIL_NOTE },
  goodwill: { metric: 'goodwill', primary: 'jquants_details', fallback: ['edinet_xbrl'], note: JQUANTS_DETAIL_NOTE },
  current_liabilities: { metric: 'current_liabilities', primary: 'jquants_details', fallback: ['edinet_xbrl'], note: JQUANTS_DETAIL_NOTE },
  short_term_debt: { metric: 'short_term_debt', primary: 'jquants_details', fallback: ['edinet_xbrl'], note: JQUANTS_DETAIL_NOTE },
  long_term_debt: { metric: 'long_term_debt', primary: 'jquants_details', fallback: ['edinet_xbrl'], note: JQUANTS_DETAIL_NOTE },
  bonds: { metric: 'bonds', primary: 'jquants_details', fallback: ['edinet_xbrl'], note: JQUANTS_DETAIL_NOTE },
  lease_liabilities: { metric: 'lease_liabilities', primary: 'jquants_details', fallback: ['edinet_xbrl'], note: JQUANTS_DETAIL_NOTE },
  non_controlling_interests: { metric: 'non_controlling_interests', primary: 'jquants_details', fallback: ['edinet_xbrl'], note: JQUANTS_DETAIL_NOTE },
  gross_profit: { metric: 'gross_profit', primary: 'jquants_details', fallback: ['edinet_xbrl'], note: JQUANTS_DETAIL_NOTE },
  cost_of_sales: { metric: 'cost_of_sales', primary: 'jquants_details', fallback: ['edinet_xbrl'], note: JQUANTS_DETAIL_NOTE },
  selling_general_admin_expenses: { metric: 'selling_general_admin_expenses', primary: 'jquants_details', fallback: ['edinet_xbrl'], note: JQUANTS_DETAIL_NOTE },
  depreciation_amortization: {
    metric: 'depreciation_amortization', primary: 'edinet_xbrl', fallback: ['jquants_details'],
    note: 'The consolidated whole-company cash-flow add-back is preferred; segment depreciation is excluded.',
  },
  interest_expense: { metric: 'interest_expense', primary: 'jquants_details', fallback: ['edinet_xbrl'], note: JQUANTS_DETAIL_NOTE },
  income_tax_expense: { metric: 'income_tax_expense', primary: 'jquants_details', fallback: ['edinet_xbrl'], note: JQUANTS_DETAIL_NOTE },
  profit_before_tax: { metric: 'profit_before_tax', primary: 'jquants_details', fallback: ['edinet_xbrl'], note: JQUANTS_DETAIL_NOTE },
  capex_property_plant_equipment: {
    metric: 'capex_property_plant_equipment', primary: 'edinet_xbrl', fallback: ['jquants_details'],
    note: 'Cash paid to acquire PPE is used; additions in segment notes and proceeds from disposal are excluded.',
  },
  capex_intangible_assets: {
    metric: 'capex_intangible_assets', primary: 'edinet_xbrl', fallback: ['jquants_details'],
    note: 'Cash paid to acquire intangible assets is used; accounting additions are not mixed in.',
  },
  capex: { metric: 'capex', primary: 'calculated', fallback: [], note: 'PPE acquisition cash outflow plus intangible acquisition cash outflow.' },
  interest_bearing_debt: {
    metric: 'interest_bearing_debt', primary: 'calculated', fallback: [],
    note: 'Short-term debt + long-term debt + bonds + recognized lease liabilities. Deposits of financial institutions are excluded.',
  },
}

export interface DetailedFinancialFact {
  factId: string
  eventId: string
  ticker: string
  publishedAt: string
  periodStart: string | null
  periodEnd: string
  valueKind: 'instant' | 'duration'
  metric: DetailedFinancialMetric
  value: number
  unit: string
  currency: string | null
  consolidationScope: ConsolidationScope
  accountingStandard: AccountingStandard
  correctionStatus: 'original' | 'corrected'
  source: DetailedFinancialSource
  sourceConcept: string
  sourceNamespace: string | null
  contextRef: string
  dimensions: Array<{ dimension: string; member: string; typed: boolean }>
  disclosureId: string
  documentId: string | null
  sourcePriority: number
  derivationMethod: string | null
  inputFactIds: string[]
  definitionVersion: string | null
}

export interface EdinetDetailedFinancialDocument {
  ticker: string
  documentId: string
  disclosureId?: string
  publishedAt: string
  periodEnd: string
  documentType: string
  correctionStatus?: 'original' | 'corrected'
}

export type DetailedConceptGapCategory = 'cash' | 'debt' | 'depreciation_amortization' | 'capex' | 'goodwill'

export type DetailedConceptGapReport = Partial<Record<DetailedConceptGapCategory, string[]>>

type ConceptRule = {
  metric: DetailedFinancialMetric
  valueKind: 'instant' | 'duration'
  concepts: string[]
  combine?: 'sum'
  aggregateConcepts?: string[]
  absoluteValue?: boolean
}

const DEBT_AGGREGATE_CONCEPTS = new Set([
  'InterestBearingLiabilitiesCLIFRS',
  'BondsAndBorrowingsCLIFRS',
  'InterestBearingLiabilitiesNCLIFRS',
  'BondsAndBorrowingsNCLIFRS',
])

const CONCEPT_RULES: ConceptRule[] = [
  {
    metric: 'cash_and_cash_equivalents', valueKind: 'instant', concepts: [
      'CashAndCashEquivalentsIFRS', 'CashAndCashEquivalents', 'CashAndDeposits',
    ],
  },
  {
    metric: 'accounts_receivable', valueKind: 'instant', concepts: [
      'TradeAndOtherReceivablesCAIFRS', 'TradeAndOtherReceivables2CAIFRS', 'TradeReceivables2AssetsIFRS',
      'NotesAndAccountsReceivableTradeAndContractAssets',
      'NotesAndAccountsReceivableTrade', 'AccountsReceivableTrade',
    ],
  },
  { metric: 'inventories', valueKind: 'instant', concepts: ['InventoriesCAIFRS', 'Inventories'] },
  { metric: 'current_assets', valueKind: 'instant', concepts: ['CurrentAssetsIFRS', 'CurrentAssets'] },
  {
    metric: 'property_plant_equipment', valueKind: 'instant', concepts: [
      'PropertyPlantAndEquipmentIFRS', 'PropertyPlantAndEquipment',
    ],
  },
  { metric: 'intangible_assets', valueKind: 'instant', concepts: ['IntangibleAssetsIFRS', 'IntangibleAssets'] },
  { metric: 'goodwill', valueKind: 'instant', concepts: ['GoodwillIFRS', 'Goodwill'] },
  { metric: 'current_liabilities', valueKind: 'instant', concepts: ['TotalCurrentLiabilitiesIFRS', 'CurrentLiabilitiesIFRS', 'CurrentLiabilities'] },
  {
    metric: 'short_term_debt', valueKind: 'instant', combine: 'sum', concepts: [
      'InterestBearingLiabilitiesCLIFRS', 'BondsAndBorrowingsCLIFRS',
      'BorrowingsCLIFRS',
      'ShortTermBorrowingsCLIFRS', 'ShortTermLoansPayable', 'CommercialPapersCLIFRS', 'CommercialPapers',
      'CurrentPortionOfLongTermBorrowingsCLIFRS', 'CurrentPortionOfLongTermLoansPayable',
    ],
    aggregateConcepts: ['InterestBearingLiabilitiesCLIFRS', 'BondsAndBorrowingsCLIFRS', 'BorrowingsCLIFRS'],
  },
  {
    metric: 'long_term_debt', valueKind: 'instant', combine: 'sum', concepts: [
      'InterestBearingLiabilitiesNCLIFRS', 'BondsAndBorrowingsNCLIFRS',
      'BorrowingsNCLIFRS',
      'LongTermBorrowingsNCLIFRS', 'LongTermLoansPayable',
    ],
    aggregateConcepts: ['InterestBearingLiabilitiesNCLIFRS', 'BondsAndBorrowingsNCLIFRS', 'BorrowingsNCLIFRS'],
  },
  {
    metric: 'bonds', valueKind: 'instant', combine: 'sum', concepts: [
      'BondsPayableNCLIFRS', 'BondsPayable', 'CurrentPortionOfBondsCLIFRS', 'CurrentPortionOfBonds',
    ],
  },
  {
    metric: 'lease_liabilities', valueKind: 'instant', combine: 'sum', concepts: [
      'LeaseLiabilitiesCLIFRS', 'LeaseLiabilitiesNCLIFRS', 'LeaseObligationsCL', 'LeaseObligationsNCL',
    ],
  },
  { metric: 'non_controlling_interests', valueKind: 'instant', concepts: ['NonControllingInterestsIFRS', 'NonControllingInterests'] },
  { metric: 'gross_profit', valueKind: 'duration', concepts: ['GrossProfitIFRS', 'GrossProfit'] },
  { metric: 'cost_of_sales', valueKind: 'duration', concepts: ['CostOfSalesIFRS', 'CostOfSales'] },
  {
    metric: 'selling_general_admin_expenses', valueKind: 'duration', concepts: [
      'SellingGeneralAndAdministrativeExpensesIFRS', 'SellingGeneralAndAdministrativeExpenses',
    ],
  },
  {
    metric: 'depreciation_amortization', valueKind: 'duration', concepts: [
      'DepreciationAndAmortizationOpeCFIFRS', 'DepreciationAndAmortizationOpeCF',
      'DepreciationAndOtherAmortizationOpeCF',
    ],
  },
  {
    metric: 'interest_expense', valueKind: 'duration', concepts: [
      'InterestExpensesIFRS', 'InterestExpenseIFRS', 'InterestExpensesAndInterestOnBondsNOE', 'InterestExpensesNOE',
    ],
  },
  { metric: 'income_tax_expense', valueKind: 'duration', concepts: ['IncomeTaxExpenseIFRS', 'IncomeTaxes'] },
  { metric: 'profit_before_tax', valueKind: 'duration', concepts: ['ProfitLossBeforeTaxIFRS', 'IncomeBeforeIncomeTaxes'] },
  {
    metric: 'capex_property_plant_equipment', valueKind: 'duration', combine: 'sum', absoluteValue: true, concepts: [
      'PaymentsToAcquirePropertyPlantAndEquipmentIFRS', 'PurchaseOfPropertyPlantAndEquipmentInvCFIFRS',
      'PurchaseOfPropertyPlantAndEquipmentInvCF',
      'AdditionsToFixedAssetsExcludingEquipmentLeasedToOthersInvCFIFRS',
      'AdditionsToEquipmentLeasedToOthersInvCFIFRS',
    ],
    aggregateConcepts: [
      'PaymentsToAcquirePropertyPlantAndEquipmentIFRS',
      'PurchaseOfPropertyPlantAndEquipmentInvCFIFRS',
      'PurchaseOfPropertyPlantAndEquipmentInvCF',
    ],
  },
  {
    metric: 'capex_intangible_assets', valueKind: 'duration', absoluteValue: true, concepts: [
      'PaymentsToAcquireIntangibleAssetsIFRS', 'PurchaseOfIntangibleAssetsInvCFIFRS',
      'PurchaseOfIntangibleAssetsInvCF', 'AdditionsToIntangibleAssetsInvCFIFRS',
    ],
  },
  {
    metric: 'capex', valueKind: 'duration', absoluteValue: true, concepts: [
      'PurchaseOfPropertyPlantAndEquipmentAndIntangibleAssetsInvCF',
      'PurchaseOfPropertyPlantAndEquipmentAndIntangibleAssetsInvCFIFRS',
    ],
  },
  {
    metric: 'interest_bearing_debt', valueKind: 'instant', concepts: [
      'BondsAndBorrowingsLiabilitiesIFRS',
    ],
  },
]

function stableId(parts: Array<string | number | null>): string {
  return createHash('sha256').update(parts.join('|')).digest('hex')
}

function accountingStandard(reader: XbrlFactReader): AccountingStandard {
  const raw = reader.latestFact(/^(?:AccountingStandardsDEI|AccountingStandardDEI)$/)?.textValue.toUpperCase() ?? ''
  if (raw.includes('IFRS')) return 'IFRS'
  if (raw.includes('US')) return 'USGAAP'
  if (raw.includes('JAPAN') || raw.includes('J-GAAP') || raw.includes('JGAAP')) return 'JGAAP'
  return 'UNKNOWN'
}

function scope(context: XbrlContext | null): ConsolidationScope {
  return context?.consolidation === 'non_consolidated' ? 'standalone' : 'consolidated'
}

function period(context: XbrlContext | null): { start: string | null; end: string; kind: 'instant' | 'duration' } | null {
  if (context?.period.kind === 'instant') return { start: null, end: context.period.instant, kind: 'instant' }
  if (context?.period.kind === 'duration') {
    return { start: context.period.startDate, end: context.period.endDate, kind: 'duration' }
  }
  return null
}

function unit(fact: XbrlFact): { unit: string; currency: string | null } | null {
  const labels = fact.unit?.measures ?? []
  const currency = labels
    .map((label) => label.split(':').at(-1)?.toUpperCase() ?? '')
    .find((label) => /^[A-Z]{3}$/.test(label)) ?? null
  if (!currency) return null
  return { unit: currency, currency }
}

function quality(fact: XbrlFact, document: EdinetDetailedFinancialDocument, conceptRank: number): number {
  const factPeriod = period(fact.context)
  let score = 10_000 - conceptRank * 100
  if (factPeriod?.end === document.periodEnd) score += 40
  if (fact.context?.consolidation === 'consolidated') score += 20
  if ((fact.context?.dimensions.length ?? 0) === 0) score += 10
  if (fact.prefix === 'jppfs_cor' || fact.prefix === 'jpigp_cor') score += 5
  return score
}

function eligibleFacts(reader: XbrlFactReader, concept: string, valueKind: 'instant' | 'duration'): XbrlFact[] {
  return reader.findFacts(concept).filter((fact) => {
    const factPeriod = period(fact.context)
    return fact.numericValue != null
      && factPeriod?.kind === valueKind
      && reader.isPrimaryContext(fact.context)
      && unit(fact) != null
  })
}

function rawFact(
  document: EdinetDetailedFinancialDocument,
  standard: AccountingStandard,
  rule: ConceptRule,
  fact: XbrlFact,
  sourcePriority: number,
): DetailedFinancialFact | null {
  const factPeriod = period(fact.context)
  const factUnit = unit(fact)
  if (!factPeriod || !factUnit || fact.numericValue == null) return null
  const value = rule.absoluteValue ? Math.abs(fact.numericValue) : fact.numericValue
  const factId = `detail:${stableId([document.documentId, rule.metric, fact.qname, fact.contextRef])}`
  return {
    factId,
    eventId: `edinet:${document.documentId}`,
    ticker: document.ticker,
    publishedAt: document.publishedAt,
    periodStart: factPeriod.start,
    periodEnd: factPeriod.end,
    valueKind: factPeriod.kind,
    metric: rule.metric,
    value,
    unit: factUnit.unit,
    currency: factUnit.currency,
    consolidationScope: scope(fact.context),
    accountingStandard: standard,
    correctionStatus: document.correctionStatus ?? (document.documentType === '130' ? 'corrected' : 'original'),
    source: 'edinet_xbrl',
    sourceConcept: fact.qname,
    sourceNamespace: fact.namespaceUri || null,
    contextRef: fact.contextRef,
    dimensions: fact.context?.dimensions ?? [],
    disclosureId: document.disclosureId ?? document.documentId,
    documentId: document.documentId,
    sourcePriority,
    derivationMethod: rule.absoluteValue ? 'absolute_cash_outflow' : null,
    inputFactIds: [],
    definitionVersion: null,
  }
}

function dedupePreferred(facts: DetailedFinancialFact[]): DetailedFinancialFact[] {
  const preferred = new Map<string, DetailedFinancialFact>()
  for (const fact of facts) {
    const key = [fact.metric, fact.periodStart, fact.periodEnd, fact.consolidationScope, fact.accountingStandard, fact.currency].join('|')
    const current = preferred.get(key)
    if (!current || fact.sourcePriority > current.sourcePriority) preferred.set(key, fact)
  }
  return [...preferred.values()]
}

function derivedFact(
  metric: DetailedFinancialMetric,
  inputs: DetailedFinancialFact[],
  method: string,
  version: string,
): DetailedFinancialFact {
  const anchor = inputs[0]
  const value = inputs.reduce((sum, fact) => sum + fact.value, 0)
  return {
    ...anchor,
    factId: `detail:${stableId([metric, version, ...inputs.map((fact) => fact.factId).sort()])}`,
    metric,
    value,
    source: 'calculated',
    sourceConcept: metric,
    sourceNamespace: null,
    contextRef: inputs.map((fact) => fact.contextRef).join(','),
    sourcePriority: 10_000,
    derivationMethod: method,
    inputFactIds: inputs.map((fact) => fact.factId),
    definitionVersion: version,
  }
}

function matchingPeriod(facts: DetailedFinancialFact[], metric: DetailedFinancialMetric, anchor: DetailedFinancialFact): DetailedFinancialFact[] {
  return facts.filter((fact) => (
    fact.metric === metric
    && fact.periodStart === anchor.periodStart
    && fact.periodEnd === anchor.periodEnd
    && fact.consolidationScope === anchor.consolidationScope
    && fact.accountingStandard === anchor.accountingStandard
    && fact.currency === anchor.currency
  ))
}

function appendDerivedFacts(facts: DetailedFinancialFact[]): DetailedFinancialFact[] {
  const output = [...facts]
  const anchors = facts.filter((fact) => fact.metric === 'capex_property_plant_equipment')
  for (const anchor of anchors) {
    const intangible = matchingPeriod(facts, 'capex_intangible_assets', anchor)[0]
    output.push(derivedFact(
      'capex',
      intangible ? [anchor, intangible] : [anchor],
      intangible ? 'PPE acquisition cash outflow + intangible acquisition cash outflow' : 'PPE acquisition cash outflow; no separately disclosed intangible acquisition cash outflow',
      'capex-cash-acquisition-v1',
    ))
  }

  const instantAnchors = facts.filter((fact) => fact.valueKind === 'instant')
  const keys = new Set(instantAnchors.map((fact) => [
    fact.periodEnd, fact.consolidationScope, fact.accountingStandard, fact.currency,
  ].join('|')))
  for (const key of keys) {
    const group = instantAnchors.filter((fact) => [
      fact.periodEnd, fact.consolidationScope, fact.accountingStandard, fact.currency,
    ].join('|') === key)
    if (group.some((fact) => fact.metric === 'interest_bearing_debt')) continue
    const maturityBuckets = ['short_term_debt', 'long_term_debt']
      .flatMap((metric) => group.filter((fact) => fact.metric === metric))
    const hasInclusiveAggregate = maturityBuckets.some((fact) => (
      DEBT_AGGREGATE_CONCEPTS.has(fact.sourceConcept.split(':').at(-1) ?? '')
    ))
    const components = hasInclusiveAggregate
      ? maturityBuckets
      : [
          ...maturityBuckets,
          ...group.filter((fact) => fact.metric === 'bonds' || fact.metric === 'lease_liabilities'),
        ]
    if (components.length > 0) {
      output.push(derivedFact(
        'interest_bearing_debt', components,
        'Short-term debt + long-term debt + bonds + recognized lease liabilities',
        'interest-bearing-debt-including-leases-v1',
      ))
    }
  }
  return dedupePreferred(output)
}

export function parseEdinetDetailedFinancialFacts(
  reader: XbrlFactReader,
  document: EdinetDetailedFinancialDocument,
): DetailedFinancialFact[] {
  const standard = accountingStandard(reader)
  const extracted: DetailedFinancialFact[] = []
  for (const rule of CONCEPT_RULES) {
    if (rule.combine === 'sum') {
      const byPeriod = new Map<string, DetailedFinancialFact[]>()
      for (const [conceptRank, concept] of rule.concepts.entries()) {
        for (const fact of eligibleFacts(reader, concept, rule.valueKind)) {
          const normalized = rawFact(document, standard, rule, fact, quality(fact, document, conceptRank))
          if (!normalized) continue
          const key = [normalized.periodStart, normalized.periodEnd, normalized.consolidationScope, normalized.currency].join('|')
          const group = byPeriod.get(key) ?? []
          group.push(normalized)
          byPeriod.set(key, group)
        }
      }
      for (const group of byPeriod.values()) {
        const uniqueConcepts = new Map<string, DetailedFinancialFact>()
        for (const fact of group) {
          const current = uniqueConcepts.get(fact.sourceConcept)
          if (!current || fact.sourcePriority > current.sourcePriority) uniqueConcepts.set(fact.sourceConcept, fact)
        }
        const components = [...uniqueConcepts.values()]
        const aggregateConcepts = new Set(rule.aggregateConcepts ?? [])
        const aggregates = components.filter((fact) => (
          aggregateConcepts.has(fact.sourceConcept.split(':').at(-1) ?? '')
        ))
        if (aggregates.length > 0) {
          extracted.push(aggregates.sort((a, b) => b.sourcePriority - a.sourcePriority)[0])
        } else if (components.length === 1) extracted.push(components[0])
        else if (components.length > 1) {
          extracted.push(derivedFact(
            rule.metric,
            components,
            `Sum of non-overlapping ${rule.metric} components`,
            `${rule.metric}-components-v1`,
          ))
        }
      }
      continue
    }
    for (const [conceptRank, concept] of rule.concepts.entries()) {
      for (const fact of eligibleFacts(reader, concept, rule.valueKind)) {
        const normalized = rawFact(document, standard, rule, fact, quality(fact, document, conceptRank))
        if (normalized) extracted.push(normalized)
      }
    }
  }
  return appendDerivedFacts(dedupePreferred(extracted))
}

const GAP_PATTERNS: Readonly<Record<DetailedConceptGapCategory, RegExp>> = {
  cash: /cash|deposit/i,
  debt: /debt|borrowings|loanspayable|bondspayable|commercialpaper|lease.*liabil|interestbearing/i,
  depreciation_amortization: /depreciation|amortization/i,
  capex: /capitalexpenditure|acquir.*(?:property|equipment|intangible)|purchase.*(?:property|equipment|intangible)|addition.*(?:fixedasset|property|equipment|intangible)/i,
  goodwill: /goodwill/i,
}

const GAP_NORMALIZED_METRICS: Readonly<Record<DetailedConceptGapCategory, DetailedFinancialMetric[]>> = {
  cash: ['cash_and_cash_equivalents'],
  debt: ['interest_bearing_debt', 'short_term_debt', 'long_term_debt', 'bonds', 'lease_liabilities'],
  depreciation_amortization: ['depreciation_amortization'],
  capex: ['capex', 'capex_property_plant_equipment', 'capex_intangible_assets'],
  goodwill: ['goodwill'],
}

/** Records likely company-extension concepts only when the corresponding normalized value is missing. */
export function analyzeDetailedConceptGaps(
  reader: XbrlFactReader,
  normalized: DetailedFinancialFact[],
): DetailedConceptGapReport {
  const recognized = new Set(normalized.map((fact) => fact.sourceConcept))
  const output: DetailedConceptGapReport = {}
  for (const category of Object.keys(GAP_PATTERNS) as DetailedConceptGapCategory[]) {
    if (normalized.some((fact) => GAP_NORMALIZED_METRICS[category].includes(fact.metric))) continue
    const candidates = reader.facts.filter((fact) => (
      fact.numericValue != null
      && reader.isPrimaryContext(fact.context)
      && unit(fact) != null
      && GAP_PATTERNS[category].test(fact.localName)
      && !recognized.has(fact.qname)
      && !(category === 'debt' && /receivable|repayment|proceeds|increase|decrease|collection|payments|purchase/i.test(fact.localName))
      && !(category === 'depreciation_amortization' && /accumulated|segmentinformation/i.test(fact.localName))
    ))
    const names = [...new Set(candidates.map((fact) => fact.qname))].sort().slice(0, 40)
    if (names.length > 0) output[category] = names
  }
  return output
}

export function selectDetailedFactsAsOf(
  facts: DetailedFinancialFact[],
  asOf: string,
): DetailedFinancialFact[] {
  const cutoff = asOf.length === 10 ? `${asOf}T23:59:59` : asOf
  return facts.filter((fact) => fact.publishedAt <= cutoff)
}

export function latestDetailedFact(
  facts: DetailedFinancialFact[],
  metric: DetailedFinancialMetric,
  valueKind?: 'instant' | 'duration',
): DetailedFinancialFact | undefined {
  const matching = facts.filter((fact) => (
    fact.metric === metric
    && (!valueKind || fact.valueKind === valueKind)
  ))
  const consolidated = matching.filter((fact) => fact.consolidationScope === 'consolidated')
  return (consolidated.length > 0 ? consolidated : matching)
    .sort((a, b) => a.periodEnd.localeCompare(b.periodEnd) || a.publishedAt.localeCompare(b.publishedAt))
    .at(-1)
}
