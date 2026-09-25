import { XbrlFactReader, type XbrlFact } from '@/lib/edinet-xbrl-facts'
import type { EdinetDocumentIndexRow } from '@/lib/server/edinet-api'
import { createHash } from 'node:crypto'

export type FilingIssuerFact = { concept: string; context: string; value: string }
export type FilingIssuerEvidence = {
  documentId: string
  sourceDocumentHash: string
  submittedAt: string
  name: FilingIssuerFact | null
  securityCode: FilingIssuerFact | null
  listedStatus: FilingIssuerFact | null
  exchange: FilingIssuerFact | null
}

export type HolderFact = {
  key: string
  name: string
  address: string | null
  personOrCorporation: string | null
  businessDescription: string | null
  holdingNote: string | null
  role: 'PRIMARY' | 'JOINT'
  shares: number | null
  holdingPct: number | null
  previousHoldingPct: number | null
  ordinaryShareCandidate: number | null
  valuationEligibleShares: number | null
  valuationBasis: string
  valuationStatus: 'PROVEN_COMMON_SHARE' | 'PARTIAL' | 'NOT_PROVEN' | 'NOT_APPLICABLE'
  valuationEvidence: { concept: string; context: string; quantity: number }[]
  securityComponents: { concept: string; context: string; quantity: number }[]
  securityBreakdown: SecurityComponent[]
  deductions: { concept: string; context: string; quantity: number }[]
  referenceDate: string | null
}

export type SecurityComponent = {
  kind: 'DIRECT_SECURITY' | 'SUBSCRIPTION_RIGHT' | 'CONVERTIBLE_BOND' | 'COVERED_WARRANT'
    | 'DEPOSITARY_RECEIPT' | 'TRUST_BENEFICIARY_SECURITY' | 'REDEEMABLE_BOND'
    | 'EXCHANGEABLE_SECURITY' | 'OTHER'
  holdingBasis: 'OWNERSHIP_LIKE' | 'VOTING_AUTHORITY' | 'INVESTMENT_AUTHORITY' | 'DERIVATIVE'
  concept: string
  context: string
  quantity: number
  unit: string | null
}

export type LargeHolderFiling = {
  documentId: string
  filingType: 'INITIAL' | 'CHANGE' | 'AMENDMENT'
  submittedAt: string
  obligationDate: string | null
  referenceDate: string | null
  parentDocumentId: string | null
  correctedDocumentId: string | null
  previousFilingId: string | null
  reportSerialNumber: number | null
  reportSerialSource: string | null
  submissionCount: number | null
  filerEdinetCode: string | null
  filerName: string | null
  schemaRegime: 'LEGACY_PRE_2026_05_01' | 'CURRENT_2026_05_01_PLUS' | 'UNKNOWN'
  issuerEdinetCode: string | null
  issuerSecurityCode: string | null
  issuerListing: string | null
  issuerName: string | null
  issuerExchange: string | null
  issuerEvidence: FilingIssuerEvidence
  primaryHolderName: string | null
  groupShares: number | null
  groupHoldingPct: number | null
  holders: HolderFact[]
  sourceUrl: string
}

export class HolderCountMismatchError extends Error {
  readonly reasonCode = 'HOLDER_COUNT_INTERNAL_INCONSISTENCY'
  constructor(
    readonly documentId: string,
    readonly coverDeclaredCount: number,
    readonly parsedLegalHolderCount: number,
    readonly rawAxisMemberCount: number,
    readonly affectedHolderMembers: { member: string; name: string; address: string | null; shares: number | null }[],
    readonly issuerSecurityCode: string | null,
    readonly issuerName: string | null,
    readonly sourceSha256: string,
  ) {
    super(`Holder count mismatch: declared ${coverDeclaredCount}, parsed ${parsedLegalHolderCount}`)
  }
}

const HOLDER_AXIS = 'FilersLargeVolumeHoldersAndJointHoldersAxis'
const date = (value?: string | null): string | null => {
  const match = value?.match(/\d{4}-\d{2}-\d{2}/)
  return match?.[0] ?? null
}

function holderKey(fact: XbrlFact): string | null {
  const dimension = fact.context?.dimensions.find((entry) => entry.dimension.includes(HOLDER_AXIS))
  return dimension?.member ?? null
}

function find(facts: XbrlFact[], name: string): XbrlFact | undefined {
  return facts.find((fact) => fact.localName === name && !fact.isNil && fact.textValue !== '')
}

function issuerFact(facts: XbrlFact[], name: string): FilingIssuerFact | null {
  const fact = facts.find((entry) => entry.localName === name && entry.contextRef === 'FilingDateInstant'
    && !entry.isNil && entry.textValue.trim())
  return fact ? { concept: fact.qname, context: fact.contextRef, value: fact.textValue.trim() } : null
}

function number(facts: XbrlFact[], name: string): number | null {
  const fact = find(facts, name)
  return fact?.numericValue != null && Number.isFinite(fact.numericValue) ? fact.numericValue : null
}

function percentage(facts: XbrlFact[], name: string): number | null {
  const value = number(facts, name)
  // EDINET XBRL の pure 比率は 0.0549 = 5.49% として保存される。
  return value === null ? null : value * 100
}

// These are the instrument columns observed in the EDINET large-holding XBRL,
// not a claim that its broad "stocks or investment securities" row is common stock.
// Concept families and legal-basis suffixes are taken from the two EDINET
// large-holding taxonomies present in the immutable legacy/current XBRL sample.
const SECURITY_FAMILIES: Record<string, SecurityComponent['kind']> = {
  StocksOrInvestmentSecuritiesEtc: 'DIRECT_SECURITY',
  SubscriptionRightsToShares: 'SUBSCRIPTION_RIGHT',
  ShareAcquisitionRightsOrInvestmentUnitAcquisitionRightsEtc: 'SUBSCRIPTION_RIGHT',
  ConvertibleBonds: 'CONVERTIBLE_BOND',
  TargetSecurityCoveredWarrants: 'COVERED_WARRANT',
  StockDepositoryReceipts: 'DEPOSITARY_RECEIPT',
  StockRelatedDepositoryReceipts: 'DEPOSITARY_RECEIPT',
  StockTrustBeneficiaryRights: 'TRUST_BENEFICIARY_SECURITY',
  StockRelatedTrustBeneficiaryRights: 'TRUST_BENEFICIARY_SECURITY',
  TargetSecurityRedeemableBonds: 'REDEEMABLE_BOND',
  ExchangeableBonds: 'EXCHANGEABLE_SECURITY',
}
const BASIS: Record<string, SecurityComponent['holdingBasis']> = {
  MainClause: 'OWNERSHIP_LIKE', Item1: 'VOTING_AUTHORITY',
  Item2: 'INVESTMENT_AUTHORITY', Item3: 'DERIVATIVE',
}
const SECURITY_COLUMN = /^(.+)Article27233(MainClause|Item[123])$/
const DEDUCTION_COLUMNS = new Set([
  'NumberOfStocksEtcToDeductAsSoldOnMarginTrading',
  'NumberOfStocksEtcToDeductAsRightsToDemandExistBetweenJointHolders',
  'NumberOfResidualStocksEtcToBeDeductedFromNumberOfResidualStocksEtcHeldDueToExistenceOfRightsSuchAsRightsToClaimDeliveryAmongJointHolders',
])

function reportSerialFromTitle(title: string | null): number | null {
  if (!title) return null
  if (/^大量保有報告(?:書)?(?:（|\(|$)/.test(title)) return 0
  // EDINET's document-title cover fact, not a DEI serial element; absence remains null.
  const match = title.normalize('NFKC').match(/^変更(?:保有)?報告書\s*(?:\(?\s*(?:NO\.?\s*)?(\d+)\s*\)?)/i)
  return match && Number.isSafeInteger(Number(match[1])) ? Number(match[1]) : null
}

export function regimeForObligationDate(value: string | null): LargeHolderFiling['schemaRegime'] {
  if (!value) return 'UNKNOWN'
  return value < '2026-05-01' ? 'LEGACY_PRE_2026_05_01' : 'CURRENT_2026_05_01_PLUS'
}

export function isLargeHolderDocument(row: EdinetDocumentIndexRow): boolean {
  return ['350', '360'].includes(row.docTypeCode ?? '')
    && row.xbrlFlag === '1'
    && row.withdrawalStatus === '0'
    && (row.disclosureStatus == null || row.disclosureStatus === '0')
}

export function parseLargeHolderFiling(
  row: EdinetDocumentIndexRow,
  xml: string,
): LargeHolderFiling {
  if (!isLargeHolderDocument(row)) throw new Error('Not an available large-holding XBRL filing')
  if (!row.submitDateTime) throw new Error('Missing EDINET submission timestamp')
  const facts = new XbrlFactReader(xml).facts
  const root = facts.filter((fact) => !holderKey(fact))
  const groups = new Map<string, XbrlFact[]>()
  for (const fact of facts) {
    const key = holderKey(fact)
    if (!key) continue
    const group = groups.get(key) ?? []
    group.push(fact)
    groups.set(key, group)
  }
  const filerName = find(root, 'FilerNameInJapaneseDEI')?.textValue ?? row.filerName ?? null
  const holders = [...groups].map(([key, entries]) => {
    const name = find(entries, 'Name')?.textValue ?? find(entries, 'FilerNameInJapaneseDEI')?.textValue
    if (!name) return null
    const shares = number(entries, 'TotalNumberOfStocksEtcHeld')
    const mainClauseShares = number(entries, 'StocksOrInvestmentSecuritiesEtcArticle27233MainClause')
    const securityBreakdown = entries.flatMap((fact): SecurityComponent[] => {
      const match = fact.localName.match(SECURITY_COLUMN)
      if (!match || fact.numericValue == null || fact.numericValue === 0 || match[1] === 'Total') return []
      return [{ kind: SECURITY_FAMILIES[match[1]] ?? 'OTHER', holdingBasis: BASIS[match[2]],
        concept: fact.qname, context: fact.contextRef, quantity: fact.numericValue,
        unit: fact.unit?.label ?? null }]
    })
    const deductions = entries.filter((fact) => DEDUCTION_COLUMNS.has(fact.localName)
      && fact.numericValue != null && fact.numericValue !== 0).map((fact) => ({
      concept: fact.qname, context: fact.contextRef, quantity: fact.numericValue!,
    }))
    const securityComponents = securityBreakdown.map(({ concept, context, quantity }) => ({
      concept, context, quantity,
    }))
    const otherInstruments = securityComponents.some((item) => !item.concept.includes('StocksOrInvestmentSecuritiesEtcArticle27233MainClause'))
    const holdingNote = find(entries, 'NotesNumberOfStocksEtcHeldTextBlock')
    // This narrow, entire-field form proves a present holding. The 60-day
    // transaction table and broad article-27 stock counts never prove it.
    const commonText = holdingNote?.textValue.trim().match(/^普通株式\s+([\d,]+)\s*株$/)
    const explicitCommon = commonText ? Number(commonText[1].replaceAll(',', '')) : null
    const provenCommon = explicitCommon != null && Number.isSafeInteger(explicitCommon)
      && explicitCommon > 0 && shares != null && mainClauseShares != null
      && explicitCommon <= shares && explicitCommon <= mainClauseShares ? explicitCommon : null
    // Main-clause "stocks etc." alone is not proof of listed ordinary shares.
    // Preserve it as evidence; only an independently confirmed ordinary-share count may be priced.
    return {
      key,
      name,
      address: find(entries, 'ResidentialAddressOrAddressOfRegisteredHeadquarter')?.textValue ?? null,
      personOrCorporation: find(entries, 'IndividualOrCorporation')?.textValue ?? null,
      businessDescription: find(entries, 'DescriptionOfBusiness')?.textValue ?? null,
      holdingNote: holdingNote?.textValue ?? null,
      role: name.normalize('NFKC').replace(/\s/g, '') === filerName?.normalize('NFKC').replace(/\s/g, '')
        ? 'PRIMARY' as const : 'JOINT' as const,
      shares,
      holdingPct: percentage(entries, 'HoldingRatioOfShareCertificatesEtc'),
      previousHoldingPct: percentage(entries, 'HoldingRatioOfShareCertificatesEtcPerLastReport'),
      ordinaryShareCandidate: !otherInstruments && mainClauseShares === shares ? mainClauseShares : null,
      valuationEligibleShares: provenCommon,
      valuationBasis: provenCommon != null ? 'explicit_current_holding_note' :
        otherInstruments ? 'mixed_instruments_unproven' : 'ordinary_shares_unconfirmed',
      valuationStatus: shares === 0 ? 'NOT_APPLICABLE' as const : provenCommon == null ? 'NOT_PROVEN' as const
        : provenCommon === shares ? 'PROVEN_COMMON_SHARE' as const : 'PARTIAL' as const,
      valuationEvidence: provenCommon != null && holdingNote ? [{
        concept: holdingNote.qname, context: holdingNote.contextRef, quantity: provenCommon,
      }] : [],
      securityComponents,
      securityBreakdown,
      deductions,
      referenceDate: date(find(entries, 'BaseDate')?.textValue),
    }
  }).filter((holder): holder is NonNullable<typeof holder> => holder !== null)
  if (holders.length === 0) throw new Error('No individually identified holders in XBRL')
  const declaredCount = number(root, 'TotalNumberOfFilersAndJointHoldersCoverPage')
  if (declaredCount != null && declaredCount !== holders.length) {
    throw new HolderCountMismatchError(row.docID, declaredCount, holders.length, groups.size,
      holders.map((holder) => ({ member: holder.key, name: holder.name,
        address: holder.address, shares: holder.shares })),
      issuerFact(root, 'SecurityCodeOfIssuer')?.value ?? null,
      issuerFact(root, 'NameOfIssuer')?.value ?? null,
      createHash('sha256').update(xml).digest('hex'))
  }
  const initial = holders.findIndex((holder) => holder.role === 'PRIMARY')
  // A cover-page representative may include a title; XBRL holder 1 is the filer.
  holders.forEach((holder, index) => { holder.role = index === (initial < 0 ? 0 : initial) ? 'PRIMARY' : 'JOINT' })
  const amendmentTarget = find(root, 'IdentificationOfDocumentSubjectToAmendmentDEI')?.textValue.trim() || null
  const kind = row.docTypeCode === '360' ? 'AMENDMENT'
    : /変更報告書/.test(row.docDescription ?? '') ? 'CHANGE' : 'INITIAL'
  if (kind === 'AMENDMENT' && amendmentTarget && row.parentDocID
      && amendmentTarget !== row.parentDocID) {
    throw new Error(`EDINET correction target disagreement: ${row.docID}`)
  }
  const obligationDate = date(find(root, 'DateWhenFilingRequirementAroseCoverPage')?.textValue)
  const title = find(root, 'DocumentTitleCoverPage')?.textValue ?? null
  const reportSerialNumber = reportSerialFromTitle(title)
  const submissionCount = number(root, 'NumberOfSubmissionDEI')
  if (submissionCount != null && (!Number.isSafeInteger(submissionCount) || submissionCount < 1)) {
    throw new Error(`Invalid EDINET submission count: ${row.docID}`)
  }
  const issuerEvidence: FilingIssuerEvidence = {
    documentId: row.docID,
    sourceDocumentHash: createHash('sha256').update(xml).digest('hex'),
    submittedAt: row.submitDateTime,
    name: issuerFact(root, 'NameOfIssuer'),
    securityCode: issuerFact(root, 'SecurityCodeOfIssuer'),
    listedStatus: issuerFact(root, 'ListedOrOTC'),
    exchange: issuerFact(root, 'StockListing'),
  }
  return {
    documentId: row.docID,
    filingType: kind,
    submittedAt: row.submitDateTime,
    obligationDate,
    referenceDate: date(find(root, 'BaseDate')?.textValue),
    parentDocumentId: row.parentDocID ?? null,
    correctedDocumentId: kind === 'AMENDMENT' ? amendmentTarget ?? row.parentDocID ?? null : null,
    previousFilingId: kind === 'CHANGE' ? row.parentDocID ?? null : null,
    reportSerialNumber,
    reportSerialSource: reportSerialNumber == null ? null : 'DocumentTitleCoverPage',
    submissionCount,
    filerEdinetCode: row.edinetCode ?? null,
    filerName,
    schemaRegime: regimeForObligationDate(obligationDate),
    issuerEdinetCode: row.issuerEdinetCode ?? null,
    issuerSecurityCode: issuerEvidence.securityCode?.value ?? null,
    issuerListing: issuerEvidence.listedStatus?.value ?? null,
    issuerName: issuerEvidence.name?.value ?? null,
    issuerExchange: issuerEvidence.exchange?.value ?? null,
    issuerEvidence,
    primaryHolderName: filerName,
    groupShares: number(root, 'TotalNumberOfStocksEtcHeld'),
    groupHoldingPct: percentage(root, 'HoldingRatioOfShareCertificatesEtc'),
    holders,
    sourceUrl: `https://disclosure2.edinet-fsa.go.jp/WZEK0040.aspx?${encodeURIComponent(row.docID)}`,
  }
}
