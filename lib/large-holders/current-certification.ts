import type { FilingIssuerEvidence } from './filing'
import { verifyCapitalStructureSource, type IssuerCapitalStructure } from './cross-document-evidence'
import { certifyPosition, evidenceHash, officialMasterEvidenceMatches,
  officialPriceMatchesInstrument, type CertificationInput, type OfficialInstrument,
  type OfficialPrice, type QuantityUnit, type PriceUnit } from './instrument-certification'
import { certifyRegulatoryCurrentPosition, type RegulatoryCurrentInput,
  type RegulatoryCurrentResult } from './regulatory-current-certification'

export type CertificationMode = 'RETROSPECTIVE_TRUTH' | 'REGULATORY_CURRENT' | 'AS_KNOWN_AT_TIME'
export type CurrentClassification = 'RETROSPECTIVE_UNIQUE_COMMON' | 'RETROSPECTIVE_UNIQUE_REIT'
  | 'MULTIPLE_CLASS_AMBIGUOUS' | 'NO_HISTORICAL_CLASS_EVIDENCE'
  | 'NO_FILING_SECURITY_CODE' | 'NO_MARKET_INSTRUMENT' | 'STALE_CURRENT_PRICE' | 'OTHER'

export type HistoricalClassProof = {
  structure: IssuerCapitalStructure
  sourcePublishedAt: string
  sourceEffectiveFrom: string
  sourceEffectiveTo: string
  sourceAsOfDate: string
  evidenceType: 'ISSUER_STATUTORY_POINT'
}

export type OfficialReitProof = {
  issuerEdinetCode: string
  securityCode: string
  issuedUnits: number
  listedFrom: string
  listedTo: string | null
  sourcePublishedAt: string
  sourceAsOfDate: string
  sourceAuthority: 'JPX_REIT'
  sourceReference: string
  sourceEvidence: string
  sourceHash: string
}

export type CurrentCertificationInput = {
  documentId: string
  holderKey: string
  issuerEdinetCode: string | null
  issuerEvidence: FilingIssuerEvidence
  obligationDate: string
  holdingInformationDate: string
  latestFilingDate: string
  certificationDate: string
  valuationAsOf: string
  latestMarketDate: string
  latestEffectivePosition: boolean
  researchStatus: string
  directUnits: number | null
  directComponentTotal: number
  directComponentCount: number
  directUnit: string | null
  directConcept: string | null
  historicalClassProof: HistoricalClassProof | null
  reitProof: OfficialReitProof | null
  historicalInstrument: OfficialInstrument | null
  currentInstrument: OfficialInstrument | null
  sameIssuerDirectClassCount: number | null
  currentPrice: OfficialPrice | null
}

export type CurrentCertification = {
  certificationMode: 'RETROSPECTIVE_TRUTH'
  classification: CurrentClassification
  securityClassStatus: 'UNIQUE_COMMON' | 'UNIQUE_REIT' | 'MULTIPLE' | 'UNPROVEN'
  currentValuationCandidate: boolean
  publicCurrentValuationReady: boolean
  publicHistoricalPitValuationReady: false
  reason: string
  warnings: string[]
  quantityUnit: QuantityUnit
  priceUnit: PriceUnit
  directUnits: number | null
  currentPricePerUnit: number | null
  currentEstimatedValueYen: number | null
  holdingInformationDate: string
  latestFilingDate: string
  certificationDate: string
  priceDate: string | null
  daysSinceLatestDisclosure: number | null
  evidence: { source: string; asOf: string; publishedAt: string | null; hash: string;
    reference: string; effectiveFrom?: string; effectiveTo?: string }[]
}

export type ModeCertificationRequest =
  | { certificationMode: 'RETROSPECTIVE_TRUTH'; current: CurrentCertificationInput }
  | { certificationMode: 'REGULATORY_CURRENT'; current: RegulatoryCurrentInput }
  | { certificationMode: 'AS_KNOWN_AT_TIME'; historical: CertificationInput }

function filingCode(evidence: FilingIssuerEvidence): string | null {
  const fact = evidence.securityCode
  if (!fact || !fact.concept.endsWith(':SecurityCodeOfIssuer')
    || fact.context !== 'FilingDateInstant') return null
  const code = fact.value.trim().toUpperCase()
  return /^[0-9A-Z]{4}(?:0)?$/.test(code) ? code.slice(0, 4) : null
}

function filingListed(evidence: FilingIssuerEvidence): boolean {
  return evidence.listedStatus?.concept.endsWith(':ListedOrOTC') === true
    && evidence.listedStatus.context === 'FilingDateInstant'
    && evidence.listedStatus.value === '上場'
    && evidence.exchange?.concept.endsWith(':StockListing') === true
    && evidence.exchange.context === 'FilingDateInstant'
    && evidence.exchange.value.trim().length > 0
}

function daysBetween(from: string, to: string): number | null {
  const first = Date.parse(`${from.slice(0, 10)}T00:00:00Z`)
  const last = Date.parse(`${to.slice(0, 10)}T00:00:00Z`)
  return Number.isFinite(first) && Number.isFinite(last) && last >= first
    ? Math.round((last - first) / 86_400_000) : null
}

export function verifyHistoricalClassProof(proof: HistoricalClassProof, issuerEdinetCode: string,
  obligationDate: string, certificationDate: string): boolean {
  const structure = proof.structure
  return proof.evidenceType === 'ISSUER_STATUTORY_POINT'
    && verifyCapitalStructureSource(structure, issuerEdinetCode)
    && (structure.tableComplete || (structure.classes.length === 1
      && structure.classes[0].kind === 'REIT_INVESTMENT_UNIT'))
    && proof.sourcePublishedAt === structure.sourceSubmittedAt
    && proof.sourcePublishedAt <= `${certificationDate} 23:59:59`
    && proof.sourceAsOfDate === structure.reportingDate
    // A filing-date snapshot proves only that date. Do not silently extend it.
    && proof.sourceEffectiveFrom === proof.sourceAsOfDate
    && proof.sourceEffectiveTo === proof.sourceAsOfDate
    && obligationDate === proof.sourceAsOfDate
}

export function verifyOfficialReitProof(proof: OfficialReitProof, issuerCode: string,
  securityCode: string, obligationDate: string, certificationDate: string): boolean {
  try {
    const source = JSON.parse(proof.sourceEvidence) as Record<string, unknown>
    return proof.sourceAuthority === 'JPX_REIT'
      && proof.sourceReference.startsWith('https://www.jpx.co.jp/')
      && proof.issuerEdinetCode === issuerCode && proof.securityCode === securityCode
      && proof.sourcePublishedAt <= `${certificationDate} 23:59:59`
      && proof.listedFrom <= obligationDate && (!proof.listedTo || proof.listedTo >= obligationDate)
      && proof.sourceAsOfDate >= obligationDate
      && Number.isSafeInteger(proof.issuedUnits) && proof.issuedUnits > 0
      && source.issuerEdinetCode === proof.issuerEdinetCode
      && source.securityCode === proof.securityCode
      && source.issuedUnits === proof.issuedUnits
      && source.listedFrom === proof.listedFrom && source.listedTo === proof.listedTo
      && source.sourceAsOfDate === proof.sourceAsOfDate
      && source.quantityUnit === 'UNIT' && source.priceUnit === 'JPY_PER_UNIT'
      && evidenceHash(source) === proof.sourceHash
  } catch { return false }
}

export function certifyCurrentPosition(input: CurrentCertificationInput): CurrentCertification {
  const { issuerEvidence: filing, historicalInstrument: historic, currentInstrument: current } = input
  const code = filingCode(filing)
  const warnings: string[] = []
  if (filing.name?.value && current?.instrumentName
    && filing.name.value.normalize('NFKC').replace(/[\s株式会社]/g, '')
      !== current.instrumentName.normalize('NFKC').replace(/[\s株式会社]/g, '')) {
    warnings.push('NAME_HISTORY_WARNING')
  }
  const direct = ['FULL_DIRECT', 'PARTIAL_DIRECT'].includes(input.researchStatus)
    && Number.isSafeInteger(input.directUnits) && (input.directUnits ?? 0) > 0
    && input.directComponentCount > 0 && input.directComponentTotal === input.directUnits
    && input.directUnit === 'xbrli:shares'
    && input.directConcept?.includes('StocksOrInvestmentSecurities') === true
  const freshPrice = current != null && input.valuationAsOf === input.latestMarketDate
    && input.currentPrice?.date === input.valuationAsOf
    && current.sourceAsOf === input.valuationAsOf
    && officialPriceMatchesInstrument(input.currentPrice, current)
  const candidate = input.latestEffectivePosition && direct && code != null
    && filingListed(filing) && freshPrice
  let classification: CurrentClassification = 'OTHER'
  let reason = 'not_latest_effective_or_direct_units_unproven'
  let securityClassStatus: CurrentCertification['securityClassStatus'] = 'UNPROVEN'
  const classProof = input.historicalClassProof
  const classSourceValid = classProof != null && input.issuerEdinetCode != null
    && verifyHistoricalClassProof(classProof, input.issuerEdinetCode,
      input.obligationDate, input.certificationDate)
  if (!code || filing.documentId !== input.documentId
    || !/^[a-f0-9]{64}$/.test(filing.sourceDocumentHash)
    || filing.submittedAt.slice(0, 10) > input.certificationDate) {
    classification = 'NO_FILING_SECURITY_CODE'
    reason = 'filing_native_issuer_identity_unproven'
  } else if (!filingListed(filing)) {
    classification = 'NO_MARKET_INSTRUMENT'
    reason = 'filing_native_listing_or_exchange_unproven'
  } else if (!direct || !input.latestEffectivePosition) {
    classification = 'OTHER'
  } else if (classSourceValid && classProof!.structure.classes.length > 1) {
    classification = 'MULTIPLE_CLASS_AMBIGUOUS'
    securityClassStatus = 'MULTIPLE'
    reason = 'filing_does_not_allocate_direct_units_between_classes'
  } else if (!classSourceValid || classProof!.structure.classes.length !== 1) {
    classification = 'NO_HISTORICAL_CLASS_EVIDENCE'
    reason = 'no_official_class_evidence_covering_obligation_date'
  } else {
    const onlyClass = classProof!.structure.classes[0]
    const common = onlyClass.kind === 'COMMON_STOCK' && onlyClass.quantityUnit === 'SHARE'
      && Boolean(onlyClass.listedExchange)
    const reit = onlyClass.kind === 'REIT_INVESTMENT_UNIT' && onlyClass.quantityUnit === 'UNIT'
      && input.issuerEdinetCode != null && input.reitProof != null
      && verifyOfficialReitProof(input.reitProof, input.issuerEdinetCode, `${code}0`,
        input.obligationDate, input.certificationDate)
      && input.reitProof.issuedUnits === onlyClass.issuedUnits
    if (!common && !reit) {
      classification = 'NO_HISTORICAL_CLASS_EVIDENCE'
      reason = 'security_class_or_reit_unit_unproven'
    } else {
      securityClassStatus = common ? 'UNIQUE_COMMON' : 'UNIQUE_REIT'
      classification = common ? 'RETROSPECTIVE_UNIQUE_COMMON' : 'RETROSPECTIVE_UNIQUE_REIT'
      reason = 'retrospective_unique_direct_class_certified'
      const instrumentType = common ? 'COMMON_STOCK' : 'REIT_INVESTMENT_UNIT'
      if (!historic || !current || historic.instrumentType !== instrumentType
        || current.instrumentType !== instrumentType
        || historic.sourceAsOf !== input.obligationDate
        || historic.listingStatus !== 'LISTED' || current.listingStatus !== 'LISTED'
        || historic.officialSecurityCodeRaw !== `${code}0`
        || current.officialSecurityCodeRaw !== `${code}0`
        || historic.instrumentId !== current.instrumentId
        || input.sameIssuerDirectClassCount !== 1
        || !officialMasterEvidenceMatches(historic)
        || !officialMasterEvidenceMatches(current)) {
        classification = 'NO_MARKET_INSTRUMENT'
        reason = 'dated_market_instrument_or_unique_listing_unproven'
      } else if (!freshPrice) {
        classification = 'STALE_CURRENT_PRICE'
        reason = 'fresh_official_current_price_missing'
      } else if (current.quantityUnit !== onlyClass.quantityUnit
        || current.priceUnit !== (common ? 'JPY_PER_SHARE' : 'JPY_PER_UNIT')) {
        classification = 'OTHER'
        reason = 'quantity_price_unit_mismatch'
      }
    }
  }
  const certified = candidate && (classification === 'RETROSPECTIVE_UNIQUE_COMMON'
    || classification === 'RETROSPECTIVE_UNIQUE_REIT')
  const calculatedValue = certified ? input.directUnits! * input.currentPrice!.rawClose! : null
  const ready = calculatedValue != null && Number.isFinite(calculatedValue)
    && calculatedValue > 0 && calculatedValue <= Number.MAX_SAFE_INTEGER
  if (certified && !ready) { classification = 'OTHER'; reason = 'current_value_out_of_safe_range' }
  const units = ready ? input.directUnits! : null
  const price = ready ? input.currentPrice!.rawClose! : null
  const evidence = [
    { source: 'LARGE_HOLDER_FILING', asOf: input.obligationDate, publishedAt: filing.submittedAt,
      hash: filing.sourceDocumentHash, reference: filing.documentId },
    ...(classSourceValid ? [{ source: 'ISSUER_CAPITAL_STRUCTURE', asOf: classProof!.sourceAsOfDate,
      publishedAt: classProof!.sourcePublishedAt, hash: classProof!.structure.sourceHash,
      reference: classProof!.structure.sourceDocumentId,
      effectiveFrom: classProof!.sourceEffectiveFrom, effectiveTo: classProof!.sourceEffectiveTo }] : []),
    ...(input.reitProof && securityClassStatus === 'UNIQUE_REIT' ? [{ source: 'JPX_REIT',
      asOf: input.reitProof.sourceAsOfDate, publishedAt: input.reitProof.sourcePublishedAt,
      hash: input.reitProof.sourceHash, reference: input.reitProof.sourceReference }] : []),
    ...(historic ? [{ source: 'MARKET_INSTRUMENT', asOf: historic.sourceAsOf,
      publishedAt: null, hash: historic.sourceHash,
      reference: historic.sourceUrlOrReference }] : []),
    ...(current ? [{ source: 'CURRENT_MARKET_INSTRUMENT', asOf: current.sourceAsOf,
      publishedAt: null, hash: current.sourceHash,
      reference: current.sourceUrlOrReference }] : []),
    ...(freshPrice ? [{ source: 'CURRENT_RAW_CLOSE', asOf: input.currentPrice!.date,
      publishedAt: null, hash: input.currentPrice!.sourceHash,
      reference: input.currentPrice!.sourceUrlOrReference }] : []),
  ]
  return { certificationMode: 'RETROSPECTIVE_TRUTH', classification, securityClassStatus,
    currentValuationCandidate: candidate, publicCurrentValuationReady: ready,
    publicHistoricalPitValuationReady: false, reason, warnings,
    quantityUnit: ready ? current!.quantityUnit : 'UNKNOWN',
    priceUnit: ready ? current!.priceUnit : 'UNKNOWN', directUnits: units,
    currentPricePerUnit: price, currentEstimatedValueYen: ready ? calculatedValue : null,
    holdingInformationDate: input.holdingInformationDate,
    latestFilingDate: input.latestFilingDate, certificationDate: input.certificationDate,
    priceDate: freshPrice ? input.currentPrice!.date : null,
    daysSinceLatestDisclosure: daysBetween(input.latestFilingDate, input.certificationDate), evidence }
}

export function certifyPositionByMode(request: Extract<ModeCertificationRequest,
  { certificationMode: 'RETROSPECTIVE_TRUTH' }>): CurrentCertification
export function certifyPositionByMode(request: Extract<ModeCertificationRequest,
  { certificationMode: 'REGULATORY_CURRENT' }>): RegulatoryCurrentResult
export function certifyPositionByMode(request: Extract<ModeCertificationRequest,
  { certificationMode: 'AS_KNOWN_AT_TIME' }>): {
  certificationMode: 'AS_KNOWN_AT_TIME'
  publicHistoricalPitValuationReady: boolean
  publicCurrentValuationReady: false
  historical: ReturnType<typeof certifyPosition>
}
export function certifyPositionByMode(request: ModeCertificationRequest) {
  if (request.certificationMode === 'RETROSPECTIVE_TRUTH') return certifyCurrentPosition(request.current)
  if (request.certificationMode === 'REGULATORY_CURRENT') return certifyRegulatoryCurrentPosition(request.current)
  const historical = certifyPosition(request.historical)
  return { certificationMode: 'AS_KNOWN_AT_TIME' as const,
    publicHistoricalPitValuationReady: historical.pitValuationReady,
    publicCurrentValuationReady: false as const, historical }
}
