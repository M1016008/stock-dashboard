import {
  XbrlFactReader,
  type XbrlConsolidation,
  type XbrlContext,
  type XbrlFact,
  type XbrlResolvedDimension,
} from '@/lib/edinet-xbrl-facts'

export type MajorShareholderFact = {
  holderName: string
  shares: number | null
  holdingRatio: number | null
}

export type PolicyHoldingFact = {
  issuerName: string
  shares: number | null
  bookValue: number | null
  purpose: string | null
  quantitativeEffect: string | null
  holdingType: string | null
}

export type LargeHoldingFact = {
  holderName: string | null
  shares: number | null
  holdingRatio: number | null
  previousHoldingRatio: number | null
  purpose: string | null
  reportKind: string | null
}

export type EdinetXbrlSource = string | XbrlFactReader

export type CompanyNarrativeFact = {
  concept: string
  text: string
  contextRef: string
  periodEnd: string | null
  consolidation: XbrlConsolidation
}

export type CompanyOverviewFact = {
  businessDescription: CompanyNarrativeFact | null
  companyHistory: CompanyNarrativeFact | null
  businessPolicy: CompanyNarrativeFact | null
  basicDescriptionTextBlocks: CompanyNarrativeFact[]
}

export type EmployeeSnapshotFact = {
  contextRef: string
  periodEnd: string | null
  consolidation: XbrlConsolidation
  employeeCount: number | null
  employeeCountUnit: string | null
  averageAgeYears: number | null
  averageAgeUnit: string | null
  averageLengthOfServiceYears: number | null
  averageLengthOfServiceUnit: string | null
  averageAnnualSalary: number | null
  averageAnnualSalaryUnit: string | null
}

export type EmployeeInformationFact = {
  consolidated: EmployeeSnapshotFact | null
  nonConsolidated: EmployeeSnapshotFact | null
}

export type OfficerFact = {
  name: string
  role: string | null
  biography: string | null
  term: string | null
  sharesHeld: number | null
  sharesUnit: string | null
  sharesSource: 'structured_fact' | 'table_dash' | null
  outside: boolean | null
  outsideSource: 'role' | 'officer_footnote' | null
  independent: boolean | null
  independentSource: 'governance_narrative' | null
  contextRef: string
  asOfDate: string | null
}

export type OfficerInformationFact = {
  officers: OfficerFact[]
  outsideOfficerNarrative: CompanyNarrativeFact | null
}

export type SegmentKind = 'business' | 'other' | 'adjustment' | 'corporate' | 'total'

export type SegmentMetricFact = {
  value: number
  unit: string | null
  concept: string
}

export type OperatingSegmentFact = {
  key: string
  name: string
  kind: SegmentKind
  axis: string
  member: string
  typedMember: boolean
  periodEnd: string | null
  consolidation: XbrlConsolidation
  revenue: SegmentMetricFact | null
  externalRevenue: SegmentMetricFact | null
  intersegmentRevenue: SegmentMetricFact | null
  profitLoss: SegmentMetricFact | null
  assets: SegmentMetricFact | null
  depreciation: SegmentMetricFact | null
  capitalExpenditure: SegmentMetricFact | null
}

export type GeographicRevenueFact = {
  name: string
  kind: 'region' | 'other'
  periodEnd: string | null
  revenue: SegmentMetricFact
  source: 'structured_fact' | 'text_block'
}

export type MajorCustomerFact = {
  name: string
  periodEnd: string | null
  revenue: SegmentMetricFact | null
  revenueRatio: SegmentMetricFact | null
}

export type SegmentInformationFact = {
  periodEnd: string | null
  accountingFramework: 'IFRS' | 'J-GAAP' | 'unknown'
  segments: OperatingSegmentFact[]
  geographicAreas: GeographicRevenueFact[]
  geographicRevenueTotal: SegmentMetricFact | null
  majorCustomers: MajorCustomerFact[]
  segmentNarrative: CompanyNarrativeFact | null
  geographicNarrative: CompanyNarrativeFact | null
}

export type SegmentParserOptions = {
  memberLabels?: Readonly<Record<string, string>>
}

type PolicyHoldingCandidate = PolicyHoldingFact & {
  periodEnd: string
  completeness: number
}

function readerFrom(source: EdinetXbrlSource): XbrlFactReader {
  return typeof source === 'string' ? new XbrlFactReader(source) : source
}

function firstFact(facts: readonly XbrlFact[], pattern: RegExp): XbrlFact | undefined {
  return facts.find((fact) => {
    pattern.lastIndex = 0
    return pattern.test(fact.localName)
  })
}

function exactFact(facts: readonly XbrlFact[], localName: string): XbrlFact | undefined {
  return facts.find((fact) => fact.localName === localName)
}

function narrativeFact(fact: XbrlFact | null | undefined): CompanyNarrativeFact | null {
  if (!fact?.textValue) return null
  return {
    concept: fact.localName,
    text: fact.textValue,
    contextRef: fact.contextRef,
    periodEnd: XbrlFactReader.contextEndDate(fact.context) || null,
    consolidation: fact.context?.consolidation ?? 'unknown',
  }
}

function latestNarrative(reader: XbrlFactReader, localName: string): CompanyNarrativeFact | null {
  return narrativeFact(reader.latestFact(localName, { primaryContextOnly: true }))
}

function compactComparableText(value: string): string {
  return value.normalize('NFKC').replace(/\s+/g, '')
}

function latestFacts(reader: XbrlFactReader, localName: string): XbrlFact[] {
  const facts = reader.findFacts(localName).filter((fact) => fact.textValue)
  const latestPeriod = facts.reduce((latest, fact) => {
    const periodEnd = XbrlFactReader.contextEndDate(fact.context)
    return periodEnd > latest ? periodEnd : latest
  }, '')
  return facts.filter((fact) => (
    !latestPeriod || XbrlFactReader.contextEndDate(fact.context) === latestPeriod
  ))
}

function tableShowsNoShares(
  tableText: string,
  officer: Pick<OfficerFact, 'name' | 'term'>,
  officerNames: readonly string[],
): boolean {
  if (!officer.term) return false
  const table = compactComparableText(tableText)
  const name = compactComparableText(officer.name)
  const start = table.indexOf(name)
  if (start < 0) return false
  const nextOfficer = officerNames
    .map(compactComparableText)
    .filter((candidate) => candidate !== name)
    .map((candidate) => table.indexOf(candidate, start + name.length))
    .filter((position) => position > start)
    .sort((left, right) => left - right)[0] ?? table.length
  const row = table.slice(start, nextOfficer)
  const term = compactComparableText(officer.term)
  const termPosition = row.lastIndexOf(term)
  if (termPosition < 0) return false
  return /^[―—–-]/.test(row.slice(termPosition + term.length))
}

type SegmentMetricKey =
  | 'revenue'
  | 'externalRevenue'
  | 'intersegmentRevenue'
  | 'profitLoss'
  | 'assets'
  | 'depreciation'
  | 'capitalExpenditure'

type SegmentMetricCandidate = SegmentMetricFact & { priority: number }

const SEGMENT_METRIC_PATTERNS: Array<{
  key: SegmentMetricKey
  patterns: RegExp[]
}> = [
  {
    key: 'externalRevenue',
    patterns: [
      /^OperatingRevenueFromExternalCustomersIFRS$/i,
      /^(?:Revenue|Revenues|Sales).*(?:ExternalCustomers?|OutsideCustomers?)/i,
      /^(?:ExternalCustomers?).*(?:Revenue|Revenues|Sales)/i,
    ],
  },
  {
    key: 'intersegmentRevenue',
    patterns: [
      /^IntersegmentOperatingRevenuesIFRS$/i,
      /^Intersegment.*(?:Revenue|Revenues|Sales|Transfers?)/i,
      /^(?:Revenue|Revenues|Sales).*Intersegment/i,
    ],
  },
  {
    key: 'revenue',
    patterns: [
      /^SalesRevenuesIFRS$/i,
      /^(?:Revenue|Revenues)IFRS$/i,
      /^(?:NetSales|Sales|Revenue|Revenues)$/i,
      /^(?:Segment)?(?:NetSales|Sales|Revenue|Revenues)(?:IFRS)?$/i,
    ],
  },
  {
    key: 'profitLoss',
    patterns: [
      /^OperatingProfitLossIFRS$/i,
      /^SegmentProfitLoss/i,
      /^Segment.*(?:Profit|Loss)/i,
      /^(?:OperatingIncome|OperatingProfitLoss)$/i,
    ],
  },
  {
    key: 'assets',
    patterns: [/^AssetsIFRS$/i, /^SegmentAssets/i, /^Assets$/i],
  },
  {
    key: 'depreciation',
    patterns: [
      /^DepreciationAndAmortizationOperatingExpensesIFRS$/i,
      /^DepreciationAndAmortization/i,
      /^Depreciation(?:Expense|Expenses)?/i,
    ],
  },
  {
    key: 'capitalExpenditure',
    patterns: [
      /^CapitalExpendituresIFRS$/i,
      /^CapitalExpenditures$/i,
      /^IncreaseIn.*(?:PropertyPlantAndEquipment|NoncurrentAssets|TangibleAssets)/i,
      /^CapitalExpendituresOverviewOfCapitalExpendituresEtc$/i,
    ],
  },
]

function segmentMetricCandidate(fact: XbrlFact): {
  key: SegmentMetricKey
  metric: SegmentMetricCandidate
} | null {
  if (fact.numericValue == null) return null
  for (const definition of SEGMENT_METRIC_PATTERNS) {
    const priority = definition.patterns.findIndex((pattern) => {
      pattern.lastIndex = 0
      return pattern.test(fact.localName)
    })
    if (priority >= 0) {
      return {
        key: definition.key,
        metric: {
          value: fact.numericValue,
          unit: fact.unit?.label ?? null,
          concept: fact.localName,
          priority,
        },
      }
    }
  }
  return null
}

function segmentKind(memberName: string): SegmentKind {
  if (/(?:ConsolidatedTotal|ReportableSegmentsTotal|TotalOf|TotalMember|連結合計|合計)/i.test(memberName)) {
    return 'total'
  }
  if (/(?:Eliminat|Adjust|Reconcil|CorporateExpenses|消去|調整)/i.test(memberName)) {
    return 'adjustment'
  }
  if (/(?:CorporateShared|CorporateCommon|HeadOffice|全社共通|本社)/i.test(memberName)) {
    return 'corporate'
  }
  if (/(?:AllOther|OtherReportable|OtherSegments?|その他)/i.test(memberName)) return 'other'
  return 'business'
}

function humanizeMemberName(memberName: string, kind: SegmentKind): string {
  if (kind === 'other') return 'その他'
  if (kind === 'adjustment') return '消去又は全社'
  if (kind === 'corporate') return '全社共通'
  if (kind === 'total') return '連結合計'
  const base = memberName
    .replace(/Member$/i, '')
    .replace(/(?:Reportable|Operating|Business)?Segment$/i, '')
  if (/^Automotive$/i.test(base)) return '自動車'
  if (/^FinancialServices?$/i.test(base)) return '金融'
  return base.replace(/([a-z0-9])([A-Z])/g, '$1 $2') || memberName
}

function resolvedMemberLabel(
  dimension: XbrlResolvedDimension,
  kind: SegmentKind,
  options: SegmentParserOptions,
): string {
  const configured = options.memberLabels?.[dimension.memberQName]
    ?? options.memberLabels?.[dimension.memberName]
  if (configured) return configured
  if (dimension.typed) return dimension.memberValue
  return humanizeMemberName(dimension.memberName, kind)
}

function segmentIdentity(
  dimension: XbrlResolvedDimension,
  options: SegmentParserOptions,
): { key: string; name: string; kind: SegmentKind } {
  const kind = segmentKind(dimension.memberName)
  const key = kind === 'other' || kind === 'adjustment' || kind === 'corporate' || kind === 'total'
    ? kind
    : dimension.memberQName
  return { key, name: resolvedMemberLabel(dimension, kind, options), kind }
}

function parseTextNumber(value: string): number | null {
  const normalized = value.normalize('NFKC').replace(/,/g, '').trim()
  if (/^[―—–-]$/.test(normalized)) return null
  const negative = /^[△▲]/.test(normalized)
  const parsed = Number(normalized.replace(/^[△▲]/, ''))
  if (!Number.isFinite(parsed)) return null
  return negative ? -parsed : parsed
}

function textBlockGeographicRevenue(
  fact: XbrlFact | null,
): { areas: GeographicRevenueFact[]; total: SegmentMetricFact | null } {
  if (!fact?.textValue) return { areas: [], total: null }
  const start = fact.textValue.search(/外部顧客.*(?:営業収益|売上高)/)
  if (start < 0) return { areas: [], total: null }
  const endMarker = fact.textValue.indexOf('②', start)
  const section = fact.textValue.slice(start, endMarker > start ? endMarker : undefined)
  const years = [...section.matchAll(/(?:19|20)\d{2}年/g)]
  if (years.length < 2 || years[1].index == null) return { areas: [], total: null }
  const rowsText = section.slice(years[1].index + years[1][0].length)
  const multiplier = /百万円/.test(section) ? 1_000_000 : /千円/.test(section) ? 1_000 : 1
  const unit = /円/.test(section) ? 'iso4217:JPY' : null
  const periodEnd = XbrlFactReader.contextEndDate(fact.context) || null
  const rows: Array<{ name: string; value: number }> = []
  const rowPattern = /([^\d]+?)\s+([△▲]?[\d,]+|[―—–-])\s+([△▲]?[\d,]+|[―—–-])(?=\s|$)/g
  for (const match of rowsText.matchAll(rowPattern)) {
    const name = match[1].trim()
    const value = parseTextNumber(match[3])
    if (!name || value == null) continue
    rows.push({ name, value: value * multiplier })
  }
  const metric = (value: number): SegmentMetricFact => ({
    value,
    unit,
    concept: fact.localName,
  })
  const totalRow = rows.find((row) => /^(?:合計|Total)$/i.test(row.name))
  return {
    areas: rows
      .filter((row) => !/^(?:合計|Total)$/i.test(row.name))
      .map((row) => ({
        name: row.name,
        kind: /^(?:その他|Other)$/i.test(row.name) ? 'other' as const : 'region' as const,
        periodEnd,
        revenue: metric(row.value),
        source: 'text_block' as const,
      })),
    total: totalRow ? metric(totalRow.value) : null,
  }
}

function contextContains(context: XbrlContext | null, pattern: RegExp): boolean {
  if (!context) return false
  return context.dimensions.some((dimension) => {
    pattern.lastIndex = 0
    if (pattern.test(dimension.dimension)) return true
    pattern.lastIndex = 0
    return pattern.test(dimension.member)
  })
}

function policyHoldingType(
  context: XbrlContext | null,
  facts: readonly XbrlFact[],
): string | null {
  const names = [
    ...(context?.dimensions.flatMap((dimension) => [dimension.dimension, dimension.member]) ?? []),
    ...facts.map((fact) => fact.localName),
  ].join(' ')
  if (/DeemedHolding/i.test(names)) return 'みなし保有'
  if (/SpecifiedInvestment/i.test(names)) return '特定投資株式'
  return null
}

function candidateIsBetter(
  candidate: PolicyHoldingCandidate,
  current: PolicyHoldingCandidate,
): boolean {
  if (candidate.periodEnd !== current.periodEnd) return candidate.periodEnd > current.periodEnd
  return candidate.completeness > current.completeness
}

export function parseMajorShareholders(source: EdinetXbrlSource): MajorShareholderFact[] {
  const rows = readerFrom(source).groupedFacts().flatMap(({ context, facts }) => {
    const holder = firstFact(
      facts,
      /(Name.*Major.*Shareholder|MajorShareholder.*Name|NameMajorShareholders)/i,
    )
    if (!holder && !contextContains(context, /MajorShareholdersAxis/i)) return []
    const holderName = holder?.textValue ?? ''
    if (!holderName) return []
    return [{
      holderName,
      shares: firstFact(facts, /(NumberOfSharesHeld|NumberOfSharesOwned)/i)?.numericValue ?? null,
      holdingRatio: firstFact(
        facts,
        /(ShareholdingRatio|PercentageOfTotalNumberOfIssuedSharesHeld|RatioOfShareholding)/i,
      )?.numericValue ?? null,
    }]
  })
  return dedupeBy(rows, (row) => row.holderName)
}

export function parsePolicyHoldings(source: EdinetXbrlSource): PolicyHoldingFact[] {
  const reader = readerFrom(source)
  const candidates = reader.groupedFacts().flatMap(({ context, facts }) => {
    const policyContext = contextContains(
      context,
      /(SpecifiedInvestment|DeemedHolding|PolicyHolding|CrossShareholding)/i,
    )
    const purpose = firstFact(
      facts,
      /(PurposeOfHolding|ReasonForHolding|PurposeOfShareholdingOverviewOfBusinessAlliance.*DetailsOf(?:SpecifiedInvestment|DeemedHoldings))/i,
    )
    if (!policyContext && !purpose) return []

    const issuer = firstFact(
      facts,
      /(NameOfIssuer|IssuerName|NameOfSecuritiesDetailsOf(?:SpecifiedInvestment|DeemedHoldings))/i,
    )
    const issuerName = issuer?.textValue ?? ''
    if (!issuerName) return []

    const shares = firstFact(
      facts,
      /(NumberOfSharesHeldDetailsOf(?:SpecifiedInvestment|DeemedHoldings)|NumberOfShares|NumberOfStocks)/i,
    )?.numericValue ?? null
    const bookValue = firstFact(
      facts,
      /(BookValueDetailsOf(?:SpecifiedInvestment|DeemedHoldings)|BalanceSheetAmount|BookValue)/i,
    )?.numericValue ?? null
    const quantitativeEffect = firstFact(
      facts,
      /^(QuantitativeEffects?|QuantitativeEffect)/i,
    )?.textValue ?? null
    const holdingType = policyHoldingType(context, facts)
    const periodEnd = XbrlFactReader.contextEndDate(context)
    const completeness = [shares, bookValue, purpose?.textValue, quantitativeEffect]
      .filter((value) => value != null && value !== '').length

    return [{
      issuerName,
      shares,
      bookValue,
      purpose: purpose?.textValue ?? null,
      quantitativeEffect,
      holdingType,
      periodEnd,
      completeness,
    } satisfies PolicyHoldingCandidate]
  })

  const latestByHolding = new Map<string, PolicyHoldingCandidate>()
  for (const candidate of candidates) {
    const key = `${candidate.holdingType ?? ''}:${candidate.issuerName}`
    const current = latestByHolding.get(key)
    if (!current || candidateIsBetter(candidate, current)) latestByHolding.set(key, candidate)
  }

  return [...latestByHolding.values()].map(({ periodEnd: _periodEnd, completeness: _completeness, ...row }) => row)
}

export function parseLargeHolding(
  source: EdinetXbrlSource,
  filerName?: string | null,
): LargeHoldingFact {
  const facts = readerFrom(source).facts
  const find = (pattern: RegExp) => firstFact(facts, pattern)?.textValue
  const findNumber = (pattern: RegExp) => firstFact(facts, pattern)?.numericValue ?? null
  return {
    holderName: find(/(NameOfLargeShareholdingReporter|NameOfReporter|ReporterName)/i) ?? filerName ?? null,
    shares: findNumber(/(TotalNumberOfStocksEtcHeld|NumberOfStocksEtcHeld|TotalNumberOfSharesHeld)/i),
    holdingRatio: findNumber(/(RatioOfStockEtcHolding|HoldingRatioAfterTransaction)/i)
      ?? findNumber(/ShareholdingRatio/i),
    previousHoldingRatio: findNumber(/(PreviousRatioOfStockEtcHolding|HoldingRatioBeforeTransaction)/i),
    purpose: find(/PurposeOfStockHolding/i) ?? find(/PurposeOfHolding/i) ?? null,
    reportKind: find(/(DocumentType|TypeOfReport|ReasonForSubmission)/i) ?? null,
  }
}

export function parseCompanyOverview(source: EdinetXbrlSource): CompanyOverviewFact {
  const reader = readerFrom(source)
  const businessDescription = latestNarrative(reader, 'DescriptionOfBusinessTextBlock')
  const companyHistory = latestNarrative(reader, 'CompanyHistoryTextBlock')
  const businessPolicy = latestNarrative(
    reader,
    'BusinessPolicyBusinessEnvironmentIssuesToAddressEtcTextBlock',
  )
  const overviewOfAffiliates = latestNarrative(reader, 'OverviewOfAffiliatedEntitiesTextBlock')

  return {
    businessDescription,
    companyHistory,
    businessPolicy,
    basicDescriptionTextBlocks: [
      businessDescription,
      companyHistory,
      businessPolicy,
      overviewOfAffiliates,
    ].filter((fact): fact is CompanyNarrativeFact => fact != null),
  }
}

export function parseEmployeeInformation(source: EdinetXbrlSource): EmployeeInformationFact {
  const reader = readerFrom(source)
  const snapshots = reader.groupedFacts({ primaryContextOnly: true }).flatMap((group) => {
    const employeeCount = exactFact(group.facts, 'NumberOfEmployees')
    const averageAge = exactFact(
      group.facts,
      'AverageAgeYearsInformationAboutReportingCompanyInformationAboutEmployees',
    )
    const averageLengthOfService = exactFact(
      group.facts,
      'AverageLengthOfServiceYearsInformationAboutReportingCompanyInformationAboutEmployees',
    )
    const averageAnnualSalary = exactFact(
      group.facts,
      'AverageAnnualSalaryInformationAboutReportingCompanyInformationAboutEmployees',
    )
    if (!employeeCount && !averageAge && !averageLengthOfService && !averageAnnualSalary) return []

    return [{
      contextRef: group.contextRef,
      periodEnd: XbrlFactReader.contextEndDate(group.context) || null,
      consolidation: group.context?.consolidation ?? 'unknown',
      employeeCount: employeeCount?.numericValue ?? null,
      employeeCountUnit: employeeCount?.unit?.label ?? null,
      averageAgeYears: averageAge?.numericValue ?? null,
      averageAgeUnit: averageAge?.unit?.label ?? null,
      averageLengthOfServiceYears: averageLengthOfService?.numericValue ?? null,
      averageLengthOfServiceUnit: averageLengthOfService?.unit?.label ?? null,
      averageAnnualSalary: averageAnnualSalary?.numericValue ?? null,
      averageAnnualSalaryUnit: averageAnnualSalary?.unit?.label ?? null,
    } satisfies EmployeeSnapshotFact]
  })

  const latest = (consolidation: XbrlConsolidation): EmployeeSnapshotFact | null => (
    snapshots
      .filter((snapshot) => snapshot.consolidation === consolidation)
      .sort((left, right) => (right.periodEnd ?? '').localeCompare(left.periodEnd ?? ''))[0]
      ?? null
  )

  return {
    consolidated: latest('consolidated'),
    nonConsolidated: latest('non_consolidated'),
  }
}

export function parseOfficerInformation(source: EdinetXbrlSource): OfficerInformationFact {
  const reader = readerFrom(source)
  const officers = reader.groupedFacts().flatMap((group) => {
    const name = exactFact(group.facts, 'NameInformationAboutDirectorsAndCorporateAuditors')
    if (!name?.textValue) return []
    const role = exactFact(
      group.facts,
      'OfficialTitleOrPositionInformationAboutDirectorsAndCorporateAuditors',
    )
    const biography = exactFact(
      group.facts,
      'CareerSummaryInformationAboutDirectorsAndCorporateAuditorsTextBlock',
    )
    const term = exactFact(
      group.facts,
      'TermOfOfficeInformationAboutDirectorsAndCorporateAuditors',
    )
    const shares = exactFact(
      group.facts,
      'NumberOfSharesHeldOrdinarySharesInformationAboutDirectorsAndCorporateAuditors',
    )

    return [{
      name: name.textValue,
      role: role?.textValue ?? null,
      biography: biography?.textValue ?? null,
      term: term?.textValue ?? null,
      sharesHeld: shares?.numericValue ?? null,
      sharesUnit: shares?.unit?.label ?? null,
      sharesSource: shares?.numericValue != null ? 'structured_fact' : null,
      outside: null,
      outsideSource: null,
      independent: null,
      independentSource: null,
      contextRef: group.contextRef,
      asOfDate: XbrlFactReader.contextEndDate(group.context) || null,
    } satisfies OfficerFact]
  })

  const latestAsOfDate = officers.reduce(
    (latest, officer) => officer.asOfDate && officer.asOfDate > latest ? officer.asOfDate : latest,
    '',
  )
  const currentOfficers = dedupeBy(
    officers.filter((officer) => !latestAsOfDate || officer.asOfDate === latestAsOfDate),
    (officer) => `${officer.name}:${officer.role ?? ''}`,
  )
  const officerTable = reader.latestFact(
    'InformationAboutOfficersTextBlock',
    { primaryContextOnly: true },
  )?.textValue ?? ''
  const officerNames = currentOfficers.map((officer) => officer.name)
  const outsideRoster = latestFacts(reader, 'FootnotesDirectorsAndCorporateAuditorsTextBlock')
    .map((fact) => fact.textValue)
    .filter((text) => /社外取締役です/.test(text))
    .join(' ')
  const compactOutsideRoster = compactComparableText(outsideRoster)
  const hasOutsideRoster = compactOutsideRoster.length > 0
  const governanceNarrative = reader.findFacts(/CorporateGovernance.*TextBlock$/i)
    .filter((fact) => reader.isPrimaryContext(fact.context))
    .sort((left, right) => (
      XbrlFactReader.contextEndDate(right.context)
        .localeCompare(XbrlFactReader.contextEndDate(left.context))
    ))
    .find((fact) => /社外取締役.{0,500}全員を独立役員/.test(fact.textValue))
  const allOutsideAreIndependent = governanceNarrative != null

  const enrichedOfficers = currentOfficers.map((officer): OfficerFact => {
    const roleMarksOutside = officer.role != null && /社外/.test(officer.role)
    const rosterMarksOutside = hasOutsideRoster
      && compactOutsideRoster.includes(compactComparableText(officer.name))
    const outside = roleMarksOutside || rosterMarksOutside
      ? true
      : hasOutsideRoster ? false : null
    const outsideSource = roleMarksOutside
      ? 'role' as const
      : hasOutsideRoster ? 'officer_footnote' as const : null
    const inferredZeroShares = officer.sharesHeld == null
      && tableShowsNoShares(officerTable, officer, officerNames)

    return {
      ...officer,
      sharesHeld: inferredZeroShares ? 0 : officer.sharesHeld,
      sharesUnit: inferredZeroShares ? 'xbrli:shares' : officer.sharesUnit,
      sharesSource: inferredZeroShares ? 'table_dash' : officer.sharesSource,
      outside,
      outsideSource,
      independent: allOutsideAreIndependent && outside != null ? outside : null,
      independentSource: allOutsideAreIndependent && outside != null
        ? 'governance_narrative'
        : null,
    }
  })

  return {
    officers: enrichedOfficers,
    outsideOfficerNarrative: latestNarrative(
      reader,
      'OutsideDirectorsAndOutsideCorporateAuditorsTextBlock',
    ),
  }
}

export function parseSegmentInformation(
  source: EdinetXbrlSource,
  options: SegmentParserOptions = {},
): SegmentInformationFact {
  const reader = readerFrom(source)
  const segmentGroups = reader.groupedFacts({ consolidation: 'consolidated' }).flatMap((group) => {
    const dimension = reader.findDimension(
      group.context,
      /^(?:Operating|Reportable|Business)Segments?Axis$/i,
    )
    if (!dimension) return []
    const metrics = group.facts
      .map(segmentMetricCandidate)
      .filter((candidate): candidate is NonNullable<typeof candidate> => candidate != null)
    if (metrics.length === 0) return []
    return [{
      group,
      dimension,
      metrics,
      periodEnd: XbrlFactReader.contextEndDate(group.context),
    }]
  })
  const latestPeriod = segmentGroups.reduce(
    (latest, group) => group.periodEnd > latest ? group.periodEnd : latest,
    '',
  )

  type SegmentAccumulator = {
    key: string
    name: string
    kind: SegmentKind
    dimension: XbrlResolvedDimension
    periodEnd: string
    consolidation: XbrlConsolidation
    metrics: Partial<Record<SegmentMetricKey, SegmentMetricCandidate>>
  }
  const segmentMap = new Map<string, SegmentAccumulator>()
  for (const entry of segmentGroups.filter((group) => group.periodEnd === latestPeriod)) {
    const identity = segmentIdentity(entry.dimension, options)
    const current = segmentMap.get(identity.key) ?? {
      ...identity,
      dimension: entry.dimension,
      periodEnd: entry.periodEnd,
      consolidation: entry.group.context?.consolidation ?? 'unknown',
      metrics: {},
    }
    for (const candidate of entry.metrics) {
      const existing = current.metrics[candidate.key]
      if (!existing || candidate.metric.priority < existing.priority) {
        current.metrics[candidate.key] = candidate.metric
      }
    }
    segmentMap.set(identity.key, current)
  }

  const metric = (candidate: SegmentMetricCandidate | undefined): SegmentMetricFact | null => {
    if (!candidate) return null
    const { priority: _priority, ...value } = candidate
    return value
  }
  const kindOrder: Record<SegmentKind, number> = {
    business: 0,
    other: 1,
    adjustment: 2,
    corporate: 3,
    total: 4,
  }
  const segments = [...segmentMap.values()]
    .map((segment): OperatingSegmentFact => ({
      key: segment.key,
      name: segment.name,
      kind: segment.kind,
      axis: segment.dimension.axisQName,
      member: segment.dimension.memberQName,
      typedMember: segment.dimension.typed,
      periodEnd: segment.periodEnd || null,
      consolidation: segment.consolidation,
      revenue: metric(segment.metrics.revenue),
      externalRevenue: metric(segment.metrics.externalRevenue),
      intersegmentRevenue: metric(segment.metrics.intersegmentRevenue),
      profitLoss: metric(segment.metrics.profitLoss),
      assets: metric(segment.metrics.assets),
      depreciation: metric(segment.metrics.depreciation),
      capitalExpenditure: metric(segment.metrics.capitalExpenditure),
    }))
    .sort((left, right) => (
      kindOrder[left.kind] - kindOrder[right.kind] || left.name.localeCompare(right.name, 'ja')
    ))

  const geographicNarrativeFact = reader.latestFact(
    /^(?:InformationAboutGeographicalAreasIFRSTextBlock|GeographicalInformationTextBlock)$/i,
    { primaryContextOnly: true },
  )
  const structuredGeography = reader.groupedFacts({ consolidation: 'consolidated' }).flatMap((group) => {
    const dimension = reader.findDimension(
      group.context,
      /^(?:(?:Geographical|Geographic)Areas?|CountriesOrRegions|Countries|Regions)Axis$/i,
    )
    if (!dimension) return []
    const revenue = group.facts
      .map(segmentMetricCandidate)
      .find((candidate) => candidate?.key === 'externalRevenue')
    if (!revenue) return []
    return [{
      dimension,
      revenue: metric(revenue.metric)!,
      periodEnd: XbrlFactReader.contextEndDate(group.context),
    }]
  })
  const latestGeographicPeriod = structuredGeography.reduce(
    (latest, row) => row.periodEnd > latest ? row.periodEnd : latest,
    '',
  )
  const structuredGeographicRows = structuredGeography
    .filter((row) => row.periodEnd === latestGeographicPeriod)
  let geographicRevenueTotal = structuredGeographicRows
    .find((row) => /(?:Total|合計)/i.test(row.dimension.memberName))?.revenue ?? null
  let geographicAreas: GeographicRevenueFact[] = structuredGeographicRows
    .filter((row) => !/(?:Total|合計)/i.test(row.dimension.memberName))
    .map((row) => {
      const other = /(?:Other|その他)/i.test(row.dimension.memberName)
      return {
        name: resolvedMemberLabel(
          row.dimension,
          other ? 'other' : 'business',
          options,
        ),
        kind: other ? 'other' as const : 'region' as const,
        periodEnd: row.periodEnd || null,
        revenue: row.revenue,
        source: 'structured_fact' as const,
      }
    })
  if (geographicAreas.length === 0) {
    const parsed = textBlockGeographicRevenue(geographicNarrativeFact)
    geographicAreas = parsed.areas
    geographicRevenueTotal = parsed.total
  }

  const customerGroups = reader.groupedFacts({ consolidation: 'consolidated' }).flatMap((group) => {
    const dimension = reader.findDimension(
      group.context,
      /^(?:MajorCustomers?|SignificantCustomers?|CustomersRepresenting.*)Axis$/i,
    )
    if (!dimension) return []
    const nameFact = firstFact(group.facts, /^(?:NameOfMajorCustomer|MajorCustomerName)/i)
    const revenueFact = firstFact(
      group.facts,
      /^(?:Revenue|Revenues|Sales).*(?:Major|Significant)Customer|^(?:Major|Significant)Customer.*(?:Revenue|Revenues|Sales)/i,
    )
    const ratioFact = firstFact(
      group.facts,
      /^(?:Percentage|Ratio|Share).*(?:Revenue|Sales).*(?:Major|Significant)Customer/i,
    )
    if (!nameFact && !dimension.typed && !revenueFact && !ratioFact) return []
    return [{
      name: nameFact?.textValue
        || resolvedMemberLabel(dimension, 'business', options),
      periodEnd: XbrlFactReader.contextEndDate(group.context),
      revenue: revenueFact?.numericValue == null ? null : {
        value: revenueFact.numericValue,
        unit: revenueFact.unit?.label ?? null,
        concept: revenueFact.localName,
      },
      revenueRatio: ratioFact?.numericValue == null ? null : {
        value: ratioFact.numericValue,
        unit: ratioFact.unit?.label ?? null,
        concept: ratioFact.localName,
      },
    } satisfies MajorCustomerFact]
  })
  const latestCustomerPeriod = customerGroups.reduce(
    (latest, row) => (row.periodEnd ?? '') > latest ? row.periodEnd ?? '' : latest,
    '',
  )
  const majorCustomers = dedupeBy(
    customerGroups.filter((row) => !latestCustomerPeriod || row.periodEnd === latestCustomerPeriod),
    (row) => row.name,
  )
  const usedConcepts = segments.flatMap((segment) => [
    segment.revenue,
    segment.externalRevenue,
    segment.intersegmentRevenue,
    segment.profitLoss,
    segment.assets,
    segment.depreciation,
    segment.capitalExpenditure,
  ]).filter((value): value is SegmentMetricFact => value != null)
  const accountingFramework = usedConcepts.some((value) => /IFRS/i.test(value.concept))
    ? 'IFRS'
    : segments.length > 0 ? 'J-GAAP' : 'unknown'

  return {
    periodEnd: latestPeriod || null,
    accountingFramework,
    segments,
    geographicAreas,
    geographicRevenueTotal,
    majorCustomers,
    segmentNarrative: narrativeFact(reader.latestFact(
      /^(?:NotesSegmentInformation.*TextBlock|SegmentInformationTextBlock)$/i,
      { primaryContextOnly: true },
    )),
    geographicNarrative: narrativeFact(geographicNarrativeFact),
  }
}

function dedupeBy<T>(rows: T[], key: (row: T) => string): T[] {
  const seen = new Set<string>()
  return rows.filter((row) => {
    const value = key(row)
    if (!value || seen.has(value)) return false
    seen.add(value)
    return true
  })
}
