import { createHash } from 'node:crypto'
import { verifyCapitalStructure, verifyEdinetBridge,
  type EdinetCodeBridge, type IssuerCapitalStructure } from './cross-document-evidence'

export type InstrumentType = 'COMMON_STOCK' | 'PREFERRED_OR_CLASS_STOCK'
  | 'REIT_INVESTMENT_UNIT' | 'INFRASTRUCTURE_FUND_UNIT' | 'ETF_UNIT'
  | 'ETN_SECURITY' | 'FOREIGN_STOCK' | 'OTHER_LISTED_SECURITY' | 'UNRESOLVED'
export type QuantityUnit = 'SHARE' | 'UNIT' | 'SECURITY' | 'UNKNOWN'
export type PriceUnit = 'JPY_PER_SHARE' | 'JPY_PER_UNIT' | 'JPY_PER_SECURITY' | 'UNKNOWN'
export type PriceSeriesMappingStatus = 'CERTIFIED' | 'AMBIGUOUS' | 'MISSING' | 'STALE_ONLY' | 'HISTORICAL_ONLY'
export type PositionInstrumentStatus = 'CERTIFIED_UNIQUE' | 'MULTIPLE_LISTED_CLASSES'
  | 'INSTRUMENT_NOT_FOUND' | 'PRICE_SERIES_NOT_FOUND' | 'PRICE_UNIT_UNPROVEN'
  | 'QUANTITY_UNIT_MISMATCH' | 'HISTORICAL_ONLY' | 'OTHER_AMBIGUOUS'
export type PublicValuationStatus = 'PUBLIC_VALUATION_READY' | 'SECURITY_CLASS_AMBIGUOUS'
  | 'PRICE_UNIT_UNPROVEN' | 'PRICE_SERIES_MISSING' | 'STALE_ONLY' | 'OTHER'

export type OfficialInstrument = {
  instrumentId: string
  issuerEdinetCode: string | null
  issuerName: string
  officialSecurityCode: string
  officialSecurityCodeRaw: string
  jpxShortCode: string | null
  isin: string | null
  instrumentName: string
  instrumentType: InstrumentType
  securityClass: string
  quantityUnit: QuantityUnit
  priceUnit: PriceUnit
  market: string
  listingStatus: 'LISTED' | 'DELISTED' | 'UNKNOWN'
  listedFrom: string | null
  listedTo: string | null
  priceSeriesId: string | null
  sourceAuthority: string
  sourceUrlOrReference: string
  sourceAsOf: string
  sourceEvidence: string
  sourceHash: string
  mappingStatus: 'OFFICIAL_EXACT' | 'UNRESOLVED'
  mappingConfidence: 'HIGH' | 'UNRESOLVED'
}

export type OfficialPrice = {
  officialSecurityCodeRaw: string
  date: string
  rawClose: number | null
  adjustedClose: number | null
  localClose: number | null
  sourceAuthority: string
  sourceUrlOrReference: string
  sourceEvidence: string
  sourceHash: string
}

export type CertificationInput = {
  edinetIssuerCode: string | null
  edinetSecurityCodeRaw: string | null
  referenceDate: string
  requestedAsOf: string
  filingSubmittedAt?: string
  researchStatus: string
  eligibleUnits: number | null
  directUnit: string | null
  directConcept: string | null
  directComponentTotal: number
  directComponentCount: number
  sourceDocumentHash: string | null
  holdingNote: string | null
  issuerListing: string | null
  instrument: OfficialInstrument | null
  currentInstrument?: OfficialInstrument | null
  sameIssuerListedClassCount: number
  price: OfficialPrice | null
  currentPrice?: OfficialPrice | null
  valuationKnowledgeCutoff?: string
  codeBridge?: EdinetCodeBridge | null
  capitalStructure?: IssuerCapitalStructure | null
  currentCapitalStructure?: IssuerCapitalStructure | null
  currentCodeBridge?: EdinetCodeBridge | null
  isLatestEffectivePosition?: boolean
}

export type CertificationMethod = 'EXPLICIT_FILING' | 'CROSS_DOCUMENT_UNIQUE'
  | 'AMBIGUOUS_MULTIPLE_CLASS' | 'NO_CAPITAL_STRUCTURE_EVIDENCE'
  | 'NO_OFFICIAL_CODE_MAPPING' | 'NO_PRICE_MAPPING' | 'STALE_CURRENT_PRICE' | 'OTHER'

export type Certification = {
  certificationMethod: CertificationMethod
  certificationStrength: 'EXPLICIT' | 'OFFICIAL_CROSS_DOCUMENT' | 'NONE'
  certificationEvidence: { source: string; asOf: string; hash: string; reference: string }[]
  mappingStatus: PositionInstrumentStatus
  priceSeriesMappingStatus: PriceSeriesMappingStatus
  publicStatus: PublicValuationStatus
  pitValuationReady: boolean
  instrumentId: string | null
  quantityUnit: QuantityUnit
  priceUnit: PriceUnit
  eligibleUnits: number | null
  priceDate: string | null
  pricePerUnit: number | null
  estimatedValueYen: number | null
  currentValueYen: number | null
  evidence: { instrument: string | null; quantity: string | null; priceUnit: string | null;
    priceSeries: string | null; reason: string }
}

export function evidenceHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

function evidenceMatchesHash(sourceEvidence: string, sourceHash: string, master: boolean): boolean {
  try {
    const parsed = JSON.parse(sourceEvidence) as { jquantsMaster?: unknown }
    const sourceRow = master ? parsed.jquantsMaster : parsed
    return sourceRow != null && evidenceHash(sourceRow) === sourceHash
  } catch { return false }
}

export function officialMasterEvidenceMatches(instrument: OfficialInstrument): boolean {
  try {
    const row = (JSON.parse(instrument.sourceEvidence) as { jquantsMaster?: Record<string, unknown> }).jquantsMaster
    return Boolean(row && evidenceMatchesHash(instrument.sourceEvidence, instrument.sourceHash, true)
      && row.Code === instrument.officialSecurityCodeRaw && row.Date === instrument.sourceAsOf
      && row.CoName === instrument.instrumentName && row.ProdCat === instrument.securityClass)
  } catch { return false }
}

export function normalizedIssuerName(name: string): string {
  return name.normalize('NFKC').replace(/株式会社|有限会社|[\s・（）()]/g, '').toLowerCase()
}

function sourceIdentifiesQuantity(note: string | null, type: InstrumentType, units: number): boolean {
  const label = type === 'COMMON_STOCK' ? '普通株式' : type === 'REIT_INVESTMENT_UNIT' ? '投資口' : null
  const unit = type === 'COMMON_STOCK' ? '株' : type === 'REIT_INVESTMENT_UNIT' ? '口' : null
  if (!label || !unit || !note) return false
  const match = note.normalize('NFKC').trim().match(new RegExp(`^${label}\\s+([\\d,]+)\\s*${unit}$`))
  return Boolean(match && Number(match[1].replaceAll(',', '')) === units)
}

export function officialPriceMatchesInstrument(price: OfficialPrice | null | undefined,
  instrument: OfficialInstrument | null): boolean {
  if (!price || !instrument) return false
  try {
    const row = JSON.parse(price.sourceEvidence) as Record<string, unknown>
    return Boolean(price.officialSecurityCodeRaw === instrument.officialSecurityCodeRaw
    && price.sourceAuthority === 'JQUANTS_JPX'
    && evidenceMatchesHash(price.sourceEvidence, price.sourceHash, false)
    && row.Code === price.officialSecurityCodeRaw && row.Date === price.date
    && Number(row.C) === price.rawClose && Number(row.AdjC) === price.adjustedClose
    && Number.isFinite(price.rawClose) && (price.rawClose ?? 0) > 0
    && price.localClose != null && price.adjustedClose != null
    && Math.abs(price.localClose - price.adjustedClose) <= Math.max(0.01, price.adjustedClose * 0.0001))
  } catch { return false }
}

export function classifyOfficialInstrument(productCategory: string, rawCode: string,
  officialSubtype?: 'REIT' | 'INFRASTRUCTURE_FUND'): {
  instrumentType: InstrumentType; quantityUnit: QuantityUnit; priceUnit: PriceUnit
} {
  if (productCategory === '011') {
    const common = /^[0-9A-Z]{4}0$/.test(rawCode)
    return { instrumentType: common ? 'COMMON_STOCK' : 'PREFERRED_OR_CLASS_STOCK',
      quantityUnit: 'SHARE', priceUnit: 'JPY_PER_SHARE' }
  }
  if (productCategory === '013' && officialSubtype === 'REIT') return {
    instrumentType: 'REIT_INVESTMENT_UNIT', quantityUnit: 'UNIT', priceUnit: 'JPY_PER_UNIT',
  }
  if (productCategory === '013' && officialSubtype === 'INFRASTRUCTURE_FUND') return {
    instrumentType: 'INFRASTRUCTURE_FUND_UNIT', quantityUnit: 'UNIT', priceUnit: 'JPY_PER_UNIT',
  }
  if (productCategory === '014') return {
    instrumentType: 'ETF_UNIT', quantityUnit: 'UNIT', priceUnit: 'JPY_PER_UNIT',
  }
  if (productCategory === '021') return {
    instrumentType: 'FOREIGN_STOCK', quantityUnit: 'SHARE', priceUnit: 'JPY_PER_SHARE',
  }
  return { instrumentType: productCategory === '012' ? 'OTHER_LISTED_SECURITY' : 'UNRESOLVED',
    quantityUnit: 'UNKNOWN', priceUnit: 'UNKNOWN' }
}

function result(input: CertificationInput, mappingStatus: PositionInstrumentStatus,
  publicStatus: PublicValuationStatus, reason: string,
  priceSeriesMappingStatus?: PriceSeriesMappingStatus,
  method: CertificationMethod = 'OTHER'): Certification {
  const instrument = input.instrument
  const pitPriceCertified = officialPriceMatchesInstrument(input.price, instrument)
  const currentPriceCertified = officialPriceMatchesInstrument(input.currentPrice, input.currentInstrument ?? null)
    && input.currentPrice?.date === input.requestedAsOf
  return { mappingStatus, publicStatus, certificationMethod: method,
    certificationStrength: 'NONE', certificationEvidence: [],
    priceSeriesMappingStatus: priceSeriesMappingStatus ?? (pitPriceCertified
      ? currentPriceCertified ? 'CERTIFIED' : 'STALE_ONLY'
      : input.price ? 'AMBIGUOUS' : 'MISSING'),
    pitValuationReady: false,
    instrumentId: instrument?.instrumentId ?? null,
    quantityUnit: instrument?.quantityUnit ?? 'UNKNOWN', priceUnit: instrument?.priceUnit ?? 'UNKNOWN',
    eligibleUnits: null, priceDate: null, pricePerUnit: null, estimatedValueYen: null, currentValueYen: null,
    evidence: { instrument: instrument?.sourceHash ?? null, quantity: null,
      priceUnit: instrument?.sourceHash ?? null, priceSeries: input.price?.sourceHash ?? null, reason },
  }
}

export function certifyPosition(input: CertificationInput): Certification {
  const instrument = input.instrument
  if (!instrument) return result(input, 'INSTRUMENT_NOT_FOUND', 'SECURITY_CLASS_AMBIGUOUS', 'official_instrument_missing')
  if (instrument.instrumentType !== 'COMMON_STOCK' && instrument.instrumentType !== 'REIT_INVESTMENT_UNIT') {
    return result(input, 'OTHER_AMBIGUOUS', 'SECURITY_CLASS_AMBIGUOUS', 'security_class_not_certified_for_valuation')
  }
  if (instrument.issuerEdinetCode !== input.edinetIssuerCode || !input.edinetIssuerCode
    || instrument.sourceAsOf > input.referenceDate || instrument.listingStatus !== 'LISTED'
    || !['JPX', 'JQUANTS_JPX'].includes(instrument.sourceAuthority)
    || !officialMasterEvidenceMatches(instrument)
    || !instrument.jpxShortCode || input.edinetSecurityCodeRaw !== instrument.jpxShortCode
    || instrument.officialSecurityCodeRaw !== `${instrument.jpxShortCode}0`
    || instrument.priceSeriesId !== instrument.jpxShortCode || input.issuerListing !== '上場') {
    return result(input, 'OTHER_AMBIGUOUS', 'SECURITY_CLASS_AMBIGUOUS', 'issuer_code_or_listing_not_certified')
  }
  const cutoff = input.valuationKnowledgeCutoff ?? `${input.referenceDate} 23:59:59`
  if (!input.codeBridge || !verifyEdinetBridge(input.codeBridge, input.edinetIssuerCode,
    instrument.officialSecurityCodeRaw, cutoff)) {
    return result(input, 'OTHER_AMBIGUOUS', 'SECURITY_CLASS_AMBIGUOUS',
      'official_edinet_code_bridge_unavailable_at_cutoff', undefined, 'NO_OFFICIAL_CODE_MAPPING')
  }
  if (instrument.listedFrom && instrument.listedFrom > input.referenceDate
    || instrument.listedTo && instrument.listedTo < input.referenceDate) {
    return result(input, 'HISTORICAL_ONLY', 'STALE_ONLY', 'not_listed_at_reference', 'HISTORICAL_ONLY')
  }
  if (!['FULL_DIRECT', 'PARTIAL_DIRECT'].includes(input.researchStatus)
    || (input.filingSubmittedAt != null
      && input.filingSubmittedAt > `${input.requestedAsOf} 23:59:59`)
    || input.eligibleUnits == null || !Number.isSafeInteger(input.eligibleUnits) || input.eligibleUnits <= 0
    || input.directComponentCount < 1 || input.directComponentTotal !== input.eligibleUnits
    || !input.sourceDocumentHash
    || input.directUnit !== 'xbrli:shares' || !input.directConcept?.includes('StocksOrInvestmentSecurities')) {
    return result(input, 'QUANTITY_UNIT_MISMATCH', 'OTHER', 'direct_quantity_not_certified')
  }
  const explicit = sourceIdentifiesQuantity(input.holdingNote, instrument.instrumentType, input.eligibleUnits)
  if (input.holdingNote && /^(?:普通株式|投資口)\s+[\d,]+\s*(?:株|口)/.test(
    input.holdingNote.normalize('NFKC').trim()) && !explicit) {
    return result(input, 'QUANTITY_UNIT_MISMATCH', 'SECURITY_CLASS_AMBIGUOUS',
      'explicit_filing_quantity_conflicts_with_direct_row')
  }
  const structure = input.capitalStructure
  const statutory = Boolean(structure && verifyCapitalStructure(structure, input.edinetIssuerCode, cutoff))
  if (!explicit && !statutory) {
    return result(input, 'OTHER_AMBIGUOUS', 'SECURITY_CLASS_AMBIGUOUS',
      'no_pit_issuer_statutory_capital_structure', undefined, 'NO_CAPITAL_STRUCTURE_EVIDENCE')
  }
  if (statutory && structure!.classes.length !== 1 && !explicit) {
    return result(input, 'MULTIPLE_LISTED_CLASSES', 'SECURITY_CLASS_AMBIGUOUS',
      'multiple_possible_direct_classes', undefined, 'AMBIGUOUS_MULTIPLE_CLASS')
  }
  if (input.sameIssuerListedClassCount !== 1 && !explicit) return result(input, 'MULTIPLE_LISTED_CLASSES',
    'SECURITY_CLASS_AMBIGUOUS', 'multiple_listed_direct_classes', undefined, 'AMBIGUOUS_MULTIPLE_CLASS')
  const onlyClass = statutory && structure!.classes.length === 1 ? structure!.classes[0] : null
  if (!explicit && (!onlyClass || onlyClass.kind !== instrument.instrumentType
    || onlyClass.quantityUnit !== instrument.quantityUnit || !onlyClass.listedExchange
    || !/証券取引所/.test(onlyClass.listedExchange))) {
    return result(input, 'OTHER_AMBIGUOUS', 'SECURITY_CLASS_AMBIGUOUS',
      'issuer_class_not_uniquely_listed', undefined, 'NO_CAPITAL_STRUCTURE_EVIDENCE')
  }
  if (instrument.priceUnit !== (instrument.quantityUnit === 'SHARE' ? 'JPY_PER_SHARE' : 'JPY_PER_UNIT')) {
    return result(input, 'PRICE_UNIT_UNPROVEN', 'PRICE_UNIT_UNPROVEN', 'quantity_price_unit_mismatch')
  }
  const price = input.price
  if (!price || price.date > input.referenceDate || price.date > input.requestedAsOf) {
    return result(input, 'PRICE_SERIES_NOT_FOUND', 'PRICE_SERIES_MISSING', 'pit_price_missing', undefined,
      'NO_PRICE_MAPPING')
  }
  if (price.officialSecurityCodeRaw !== instrument.officialSecurityCodeRaw
    || price.sourceAuthority !== 'JQUANTS_JPX'
    || !evidenceMatchesHash(price.sourceEvidence, price.sourceHash, false)
    || !Number.isFinite(price.rawClose) || (price.rawClose ?? 0) <= 0) {
    return result(input, 'PRICE_UNIT_UNPROVEN', 'PRICE_UNIT_UNPROVEN', 'official_raw_close_unproven', 'AMBIGUOUS')
  }
  if (!officialPriceMatchesInstrument(price, instrument)) {
    return result(input, 'PRICE_SERIES_NOT_FOUND', 'PRICE_SERIES_MISSING',
      'local_price_series_not_reconciled', 'AMBIGUOUS', 'NO_PRICE_MAPPING')
  }
  const current = input.currentPrice
  const currentInstrument = input.currentInstrument
  const currentStructure = input.currentCapitalStructure
  const currentIdentityCertified = Boolean(currentInstrument && input.currentCodeBridge
    && verifyEdinetBridge(input.currentCodeBridge, input.edinetIssuerCode,
      currentInstrument.officialSecurityCodeRaw, `${input.requestedAsOf} 23:59:59`)
    && currentStructure && verifyCapitalStructure(currentStructure, input.edinetIssuerCode,
      `${input.requestedAsOf} 23:59:59`)
    && currentStructure.classes.length === 1
    && currentStructure.classes[0].kind === currentInstrument.instrumentType
    && currentStructure.classes[0].quantityUnit === currentInstrument.quantityUnit
    && currentStructure.classes[0].listedExchange)
  const currentValueYen = currentInstrument?.instrumentId === instrument.instrumentId
    && input.isLatestEffectivePosition === true
    && currentIdentityCertified
    && currentInstrument.listingStatus === 'LISTED' && currentInstrument.sourceAsOf === input.requestedAsOf
    && officialPriceMatchesInstrument(current, currentInstrument)
    && current?.date === input.requestedAsOf
    && (!instrument.listedTo || instrument.listedTo >= current.date)
    ? input.eligibleUnits * current.rawClose! : null
  const certificationEvidence = [
    { source: 'LARGE_HOLDER_FILING', asOf: cutoff, hash: input.sourceDocumentHash,
      reference: input.sourceDocumentHash },
    { source: 'EDINET_CODE_LIST', asOf: input.codeBridge.snapshotDate,
      hash: input.codeBridge.sourceHash, reference: input.codeBridge.sourceUrl },
    ...(statutory ? [{ source: 'ISSUER_STATUTORY_FILING', asOf: structure!.sourceSubmittedAt,
      hash: structure!.sourceHash, reference: structure!.sourceDocumentId }] : []),
    { source: 'JPX_INSTRUMENT', asOf: instrument.sourceAsOf, hash: instrument.sourceHash,
      reference: instrument.sourceUrlOrReference },
    { source: 'JPX_PRICE', asOf: price.date, hash: price.sourceHash,
      reference: price.sourceUrlOrReference },
  ].filter((entry): entry is { source: string; asOf: string; hash: string; reference: string } => !!entry.hash)
  return { mappingStatus: 'CERTIFIED_UNIQUE', priceSeriesMappingStatus: 'CERTIFIED',
    certificationMethod: explicit ? 'EXPLICIT_FILING' : 'CROSS_DOCUMENT_UNIQUE',
    certificationStrength: explicit ? 'EXPLICIT' : 'OFFICIAL_CROSS_DOCUMENT', certificationEvidence,
    publicStatus: currentValueYen == null ? 'STALE_ONLY' : 'PUBLIC_VALUATION_READY',
    pitValuationReady: true, instrumentId: instrument.instrumentId,
    quantityUnit: instrument.quantityUnit, priceUnit: instrument.priceUnit,
    eligibleUnits: input.eligibleUnits, priceDate: price.date, pricePerUnit: price.rawClose,
    estimatedValueYen: input.eligibleUnits * price.rawClose!, currentValueYen,
    evidence: { instrument: instrument.sourceHash,
      quantity: `${input.sourceDocumentHash}:${evidenceHash({ unit: input.directUnit,
        concept: input.directConcept, note: input.holdingNote, units: input.eligibleUnits,
        componentCount: input.directComponentCount })}`, priceUnit: instrument.sourceHash,
      priceSeries: price.sourceHash, reason: 'official_instrument_and_unadjusted_price_certified' },
  }
}

export function portfolioCompleteness(ready: readonly boolean[]): {
  status: 'COMPLETE' | 'PARTIAL' | 'NONE'
  valuedPositionCount: number
  totalRelevantPositionCount: number
  unvaluedPositionCount: number
} {
  const valuedPositionCount = ready.filter(Boolean).length
  return { status: !valuedPositionCount ? 'NONE' : valuedPositionCount === ready.length ? 'COMPLETE' : 'PARTIAL',
    valuedPositionCount, totalRelevantPositionCount: ready.length,
    unvaluedPositionCount: ready.length - valuedPositionCount }
}
