import type { FilingIssuerEvidence } from './filing'
import { verifyCapitalStructureSource, type IssuerCapitalStructure } from './cross-document-evidence'
import { evidenceHash, officialMasterEvidenceMatches, officialPriceMatchesInstrument,
  normalizedIssuerName, type OfficialInstrument, type OfficialPrice } from './instrument-certification'
import { activeRegulatoryScope, excludedByRegulation, verifiedClassScope,
  type RegulatoryScopeEntry } from './regulatory-scope'

export type MarketRow = { Date: string; Code: string; CoName: string; ProdCat: string; MktNm: string }
export type OfficialMarketSnapshot = { date: string; sourceReference: string; sourceHash: string;
  rows: readonly MarketRow[] }
export type RegulatoryCurrentClassification = 'FILING_EXPLICIT_CLASS' | 'FILING_CODE_REGULATORY_UNIQUE'
  | 'CROSS_DOCUMENT_REGULATORY_UNIQUE' | 'MULTIPLE_ELIGIBLE_CLASSES'
  | 'UNKNOWN_REGULATORY_SCOPE' | 'CODE_AMBIGUOUS' | 'REIT_UNRESOLVED'
  | 'STALE_PRICE' | 'OTHER'
export type CertificationStrength = 'A' | 'B' | 'C' | 'D'

export type RegulatoryCurrentInput = {
  documentId: string
  issuerEdinetCode: string | null
  issuerEvidence: FilingIssuerEvidence
  obligationDate: string
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
  holdingNote: string | null
  issuedTotal: { value: number; unit: string; concept: string; context: string } | null
  recentTransactionTypes: readonly string[]
  classScopeEvidence?: readonly RegulatoryScopeEntry[]
  marketSnapshot: OfficialMarketSnapshot | null
  currentInstrument: OfficialInstrument | null
  currentPrice: OfficialPrice | null
  issuerCapitalStructure: IssuerCapitalStructure | null
  // Curated against the JPX REIT issues page. The statutory issuer evidence must also match.
  jpxReitEvidence: { code: string; issuerName: string; listedFrom: string;
    isin: string; sourceReference: string; sourceEvidence: string; sourceHash: string } | null
  transitionConflict: boolean
}
export type RegulatoryCurrentResult = {
  classification: RegulatoryCurrentClassification
  strength: CertificationStrength
  publicCurrentValuationReady: boolean
  publicHistoricalPitValuationReady: false
  reason: string
  filingIssuerSecurityCodeRaw: string | null
  filingIssuerListedStatus: string | null
  filingIssuerExchange: string | null
  sourceDocumentId: string
  sourceConcept: string | null
  sourceContext: string | null
  sourceHash: string
  eligibleListedClasses: string[]
  excludedClasses: string[]
  classScopes: { code: string; scope: RegulatoryScopeEntry }[]
  quantityUnit: 'SHARE' | 'UNIT' | 'UNKNOWN'
  priceUnit: 'JPY_PER_SHARE' | 'JPY_PER_UNIT' | 'UNKNOWN'
  directEligibleUnits: number | null
  latestFreshUnadjustedPrice: number | null
  estimatedCurrentMarketValue: number | null
  issuedTotal: RegulatoryCurrentInput['issuedTotal']
  recentTransactionTypes: readonly string[]
  evidence: { source: string; reference: string; hash: string; asOf: string }[]
}

export function createOfficialMarketSnapshot(rows: readonly MarketRow[], date: string): OfficialMarketSnapshot {
  if (rows.length < 4_000 || rows.some((row) => row.Date !== date
    || !/^[0-9A-Z]{5}$/.test(row.Code) || !row.CoName || !row.ProdCat)
    || new Set(rows.map((row) => row.Code)).size !== rows.length) {
    throw new Error('Incomplete or invalid full-date official market snapshot')
  }
  const canonical = [...rows].sort((a, b) => a.Code.localeCompare(b.Code))
  return { date, rows: canonical,
    sourceReference: `https://api.jquants.com/v2/equities/master?date=${date}`,
    sourceHash: evidenceHash(canonical) }
}

export function certifyRegulatoryCurrentPosition(input: RegulatoryCurrentInput): RegulatoryCurrentResult {
  const filing = input.issuerEvidence
  const raw = filing.securityCode?.value.trim().toUpperCase() ?? null
  const validCode = filing.securityCode?.concept.endsWith(':SecurityCodeOfIssuer')
    && filing.securityCode.context === 'FilingDateInstant' && raw != null && /^[0-9A-Z]{4,5}$/.test(raw)
  const code = validCode ? raw : null
  const listed = filing.listedStatus?.concept.endsWith(':ListedOrOTC')
    && filing.listedStatus.context === 'FilingDateInstant' && filing.listedStatus.value === '上場'
    && filing.exchange?.concept.endsWith(':StockListing')
    && filing.exchange.context === 'FilingDateInstant' && /東京|東証|Tokyo/i.test(filing.exchange.value)
  const snapshot = input.marketSnapshot
  const snapshotValid = snapshot != null && snapshot.date === input.valuationAsOf
    && snapshot.rows.length >= 4_000 && evidenceHash(snapshot.rows) === snapshot.sourceHash
    && snapshot.rows.every((row) => row.Date === snapshot.date)
    && new Set(snapshot.rows.map((row) => row.Code)).size === snapshot.rows.length
    && snapshot.sourceReference === `https://api.jquants.com/v2/equities/master?date=${snapshot.date}`
  const direct = ['FULL_DIRECT', 'PARTIAL_DIRECT'].includes(input.researchStatus)
    && Number.isSafeInteger(input.directUnits) && (input.directUnits ?? 0) > 0
    && input.directComponentTotal === input.directUnits && input.directComponentCount > 0
    && input.directUnit === 'xbrli:shares'
    && input.directConcept?.includes('StocksOrInvestmentSecuritiesEtcArticle27233') === true
  const instrument = input.currentInstrument
  const price = input.currentPrice
  const fresh = instrument != null && price != null
    && input.valuationAsOf === input.latestMarketDate && instrument.sourceAsOf === input.valuationAsOf
    && price.date === input.valuationAsOf && officialPriceMatchesInstrument(price, instrument)
  const candidates = code && snapshotValid ? snapshot.rows.filter((row) => row.ProdCat === '011'
    && (code.length === 5 ? row.Code === code : row.Code.startsWith(code))) : []
  const otherListedClass = code && snapshotValid && code.length === 4
    && snapshot.rows.some((row) => row.Code.startsWith(code) && row.ProdCat !== '011'
      && !(row.ProdCat === '013' && row.Code === `${code}0`))
  const scopes = candidates.map((row) => ({ code: row.Code,
    scope: input.classScopeEvidence?.find((scope) => verifiedClassScope(scope, row.Code, input.obligationDate))
      ?? activeRegulatoryScope(row.Code.endsWith('0') ? 'COMMON_STOCK'
        : 'PREFERRED_OR_CLASS_STOCK', row.Code, input.obligationDate) }))
  const excluded = scopes.filter(({ scope }) => excludedByRegulation(scope)).map(({ code: c }) => c)
  const eligible = scopes.filter(({ code: c }) => !excluded.includes(c))
  const unknown = eligible.some(({ scope }) => scope.reportingScopeStatus === 'UNKNOWN')
  const explicitOrdinary = input.holdingNote?.normalize('NFKC').trim()
    .match(/^普通株式\s+([\d,]+)\s*株$/)
  const explicitMatch = explicitOrdinary != null && Number(explicitOrdinary[1].replaceAll(',', '')) === input.directUnits
  const ordinary = eligible.some(({ code: c }) => c.endsWith('0'))
  const reitRow = code && snapshotValid && code.length === 4
    ? snapshot.rows.find((row) => row.Code === `${code}0` && row.ProdCat === '013') : null
  const reit = input.jpxReitEvidence
  let reitEvidenceValid = false
  try { reitEvidenceValid = reit != null && evidenceHash(JSON.parse(reit.sourceEvidence)) === reit.sourceHash }
  catch { /* An invalid official source is not evidence. */ }
  const reitSource = reit != null && reit.sourceReference === 'https://www.jpx.co.jp/equities/products/reits/issues/'
    && reitEvidenceValid
    && reit.code === code && reit.listedFrom <= input.obligationDate
    && /^JP[0-9A-Z]{10}$/.test(reit.isin)
    && filing.name?.concept.endsWith(':NameOfIssuer') === true
    && filing.name.context === 'FilingDateInstant'
    && normalizedIssuerName(filing.name.value) === normalizedIssuerName(reit.issuerName)
    && (input.issuerCapitalStructure == null || (input.issuerEdinetCode != null
      && verifyCapitalStructureSource(input.issuerCapitalStructure, input.issuerEdinetCode)
      && input.issuerCapitalStructure.classes.some((item) => item.kind === 'REIT_INVESTMENT_UNIT'
        && item.quantityUnit === 'UNIT')))
    && reitRow != null && reit.issuerName.normalize('NFKC').includes('投資法人')
    && reitRow.CoName.normalize('NFKC').includes('投資法人')
  const selected = reitRow ? (reitSource ? reitRow : null) : code?.length === 5
    ? eligible.length === 1 ? candidates.find((row) => row.Code === code) : null
    : ordinary ? candidates.find((row) => row.Code === `${code}0`) : null
  const matchedInstrument = selected != null && instrument != null
    && instrument.officialSecurityCodeRaw === selected.Code
    && instrument.issuerEdinetCode === input.issuerEdinetCode
    && instrument.sourceHash === evidenceHash(selected) && officialMasterEvidenceMatches(instrument)
    && instrument.listingStatus === 'LISTED' && instrument.sourceAuthority === 'JQUANTS_JPX'
    && instrument.market === selected.MktNm && instrument.mappingStatus === 'OFFICIAL_EXACT'
    && (reitRow ? instrument.securityClass === '013'
      : instrument.instrumentType === (code?.length === 5 && !code.endsWith('0')
        ? 'PREFERRED_OR_CLASS_STOCK' : 'COMMON_STOCK'))
  let classification: RegulatoryCurrentClassification = 'OTHER'
  let reason = 'latest_direct_position_unproven'
  if (!input.latestEffectivePosition || !direct) { /* Fail closed before mapping. */ }
  else if (!code || filing.documentId !== input.documentId
    || !/^[a-f0-9]{64}$/.test(filing.sourceDocumentHash)
    || filing.submittedAt.slice(0, 10) > input.certificationDate
    || filing.submittedAt.slice(0, 10) < input.obligationDate || !listed) {
    classification = 'CODE_AMBIGUOUS'; reason = 'filing_native_identity_or_exchange_unproven'
  } else if (!snapshotValid || input.transitionConflict) {
    classification = 'CODE_AMBIGUOUS'
    reason = input.transitionConflict ? 'filing_obligation_instrument_transition'
      : 'complete_market_snapshot_missing'
  } else if (reitRow && !reitSource) {
    classification = 'REIT_UNRESOLVED'; reason = 'official_issuer_type_or_reit_unit_missing'
  } else if (otherListedClass) {
    classification = 'UNKNOWN_REGULATORY_SCOPE'; reason = 'other_listed_class_security_type_unproven'
  } else if (!reitRow && unknown) {
    classification = 'UNKNOWN_REGULATORY_SCOPE'; reason = 'class_specific_voting_rights_unproven'
  } else if (!reitRow && eligible.length !== 1 && !explicitMatch) {
    classification = eligible.length > 1 ? 'MULTIPLE_ELIGIBLE_CLASSES' : 'CODE_AMBIGUOUS'
    reason = 'filing_direct_quantity_not_allocated_to_one_eligible_class'
  } else if (!selected || !matchedInstrument) {
    classification = 'CODE_AMBIGUOUS'; reason = 'direct_class_not_uniquely_identified'
  } else if (!fresh) {
    classification = 'STALE_PRICE'; reason = 'latest_official_unadjusted_price_unavailable'
  } else if ((!reitRow && (instrument.quantityUnit !== 'SHARE'
    || instrument.priceUnit !== 'JPY_PER_SHARE'))
    || (reitRow && !reitSource)
    || instrument.priceSeriesId !== code) {
    classification = 'OTHER'; reason = 'quantity_or_price_unit_or_series_mismatch'
  } else {
    classification = reitRow ? 'CROSS_DOCUMENT_REGULATORY_UNIQUE'
      : explicitMatch ? 'FILING_EXPLICIT_CLASS' : 'FILING_CODE_REGULATORY_UNIQUE'
    reason = 'unique_reporting_scope_direct_instrument_with_fresh_price'
  }
  const strength: CertificationStrength = classification === 'FILING_EXPLICIT_CLASS' ? 'A'
    : classification === 'FILING_CODE_REGULATORY_UNIQUE' ? 'B'
      : classification === 'CROSS_DOCUMENT_REGULATORY_UNIQUE' ? 'C' : 'D'
  const amount = strength !== 'D' ? input.directUnits! * price!.rawClose! : null
  const ready = amount != null && Number.isFinite(amount) && amount > 0
    && amount <= Number.MAX_SAFE_INTEGER
  if (strength !== 'D' && !ready) { classification = 'OTHER'; reason = 'estimated_value_not_safe_integer' }
  const publicReady = ready && strength !== 'D'
  return { classification, strength: publicReady ? strength : 'D', publicCurrentValuationReady: publicReady,
    publicHistoricalPitValuationReady: false, reason, filingIssuerSecurityCodeRaw: code,
    filingIssuerListedStatus: filing.listedStatus?.value ?? null,
    filingIssuerExchange: filing.exchange?.value ?? null, sourceDocumentId: filing.documentId,
    sourceConcept: filing.securityCode?.concept ?? null, sourceContext: filing.securityCode?.context ?? null,
    sourceHash: filing.sourceDocumentHash, eligibleListedClasses: reitRow ? [reitRow.Code] : eligible.map(({ code: c }) => c),
    excludedClasses: excluded, classScopes: scopes,
    quantityUnit: publicReady ? reitRow ? 'UNIT' : 'SHARE' : 'UNKNOWN',
    priceUnit: publicReady ? reitRow ? 'JPY_PER_UNIT' : 'JPY_PER_SHARE' : 'UNKNOWN',
    directEligibleUnits: publicReady ? input.directUnits : null,
    latestFreshUnadjustedPrice: publicReady ? price!.rawClose : null,
    estimatedCurrentMarketValue: publicReady ? amount : null,
    issuedTotal: input.issuedTotal, recentTransactionTypes: input.recentTransactionTypes,
    evidence: [
      { source: 'EDINET_FILING', reference: filing.documentId, hash: filing.sourceDocumentHash,
        asOf: filing.submittedAt },
      ...(snapshotValid ? [{ source: 'JQUANTS_FULL_MASTER', reference: snapshot!.sourceReference,
        hash: snapshot!.sourceHash, asOf: snapshot!.date }] : []),
      ...scopes.map(({ code: c, scope }) => ({ source: scope.sourceAuthority,
        reference: `${scope.sourceReference}#${c}`, hash: scope.sourceHash, asOf: input.valuationAsOf })),
      ...(reitSource ? [{ source: 'JPX_REIT', reference: reit!.sourceReference,
        hash: reit!.sourceHash, asOf: input.valuationAsOf }] : []),
      ...(matchedInstrument ? [{ source: 'JQUANTS_INSTRUMENT', reference: instrument!.sourceUrlOrReference,
        hash: instrument!.sourceHash, asOf: input.valuationAsOf }] : []),
      ...(fresh ? [{ source: 'JQUANTS_UNADJUSTED_CLOSE', reference: price!.sourceUrlOrReference,
        hash: price!.sourceHash, asOf: price!.date }] : []),
    ] }
}
