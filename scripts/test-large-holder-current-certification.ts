import assert from 'node:assert/strict'
import { certifyPositionByMode, verifyHistoricalClassProof,
  type CurrentCertificationInput, type OfficialReitProof } from '@/lib/large-holders/current-certification'
import { evidenceHash, type CertificationInput, type OfficialInstrument,
  type OfficialPrice } from '@/lib/large-holders/instrument-certification'
import type { IssuerCapitalStructure, StatutorySecurityClass } from '@/lib/large-holders/cross-document-evidence'

const obligation = '2025-02-28'
const currentDate = '2026-09-18'
const stockRow = { Date: obligation, Code: '82300', CoName: 'はせがわ', ProdCat: '011' }
function instrument(date: string, type: OfficialInstrument['instrumentType'] = 'COMMON_STOCK',
  code = '82300'): OfficialInstrument {
  const row = { ...stockRow, Date: date, Code: code, CoName: type === 'REIT_INVESTMENT_UNIT'
    ? 'Oneリート投資法人 投資証券' : stockRow.CoName, ProdCat: type === 'REIT_INVESTMENT_UNIT' ? '013' : '011' }
  return { instrumentId: `JPX:${code}`, issuerEdinetCode: 'E03134', issuerName: row.CoName,
    officialSecurityCode: code, officialSecurityCodeRaw: code, jpxShortCode: code.slice(0, 4),
    isin: null, instrumentName: row.CoName, instrumentType: type, securityClass: row.ProdCat,
    quantityUnit: type === 'REIT_INVESTMENT_UNIT' ? 'UNIT' : 'SHARE',
    priceUnit: type === 'REIT_INVESTMENT_UNIT' ? 'JPY_PER_UNIT' : 'JPY_PER_SHARE',
    market: 'スタンダード', listingStatus: 'LISTED', listedFrom: obligation, listedTo: null,
    priceSeriesId: code.slice(0, 4), sourceAuthority: 'JQUANTS_JPX',
    sourceUrlOrReference: `https://api.jquants.com/v2/equities/master?date=${date}`,
    sourceAsOf: date, sourceEvidence: JSON.stringify({ jquantsMaster: row }), sourceHash: evidenceHash(row),
    mappingStatus: 'OFFICIAL_EXACT', mappingConfidence: 'HIGH' }
}
function price(date: string, code = '82300', close = 310): OfficialPrice {
  const row = { Date: date, Code: code, C: close, AdjC: close }
  return { officialSecurityCodeRaw: code, date, rawClose: close, adjustedClose: close,
    localClose: close, sourceAuthority: 'JQUANTS_JPX',
    sourceUrlOrReference: `https://api.jquants.com/v2/equities/bars/daily?date=${date}`,
    sourceEvidence: JSON.stringify(row), sourceHash: evidenceHash(row) }
}
const commonClass: StatutorySecurityClass = { name: '普通株式', kind: 'COMMON_STOCK',
  dimension: 'OrdinaryShareMember', issuedUnits: 20_000_000, quantityUnit: 'SHARE',
  listedExchange: '東京証券取引所', listingDescription: '東京証券取引所', lotSize: 100 }
function capital(classes: StatutorySecurityClass[], tableComplete = true): IssuerCapitalStructure {
  const evidence = { issuerEdinetCode: 'E03134', sourceDocumentId: 'S100LATER',
    sourceSubmittedAt: '2025-03-02 10:00:00', reportingDate: obligation,
    xbrlSha256: 'a'.repeat(64), tableSha256: 'b'.repeat(64), classes, tableComplete }
  return { issuerEdinetCode: evidence.issuerEdinetCode, sourceDocumentId: evidence.sourceDocumentId,
    sourceSubmittedAt: evidence.sourceSubmittedAt, reportingDate: evidence.reportingDate,
    sourceUrl: 'https://disclosure2.edinet-fsa.go.jp/WZEK0040.aspx?S100LATER',
    sourceEvidence: JSON.stringify(evidence), sourceHash: evidenceHash(evidence), classes, tableComplete }
}
const proof = (structure: IssuerCapitalStructure) => ({ structure,
  sourcePublishedAt: structure.sourceSubmittedAt, sourceEffectiveFrom: obligation,
  sourceEffectiveTo: obligation, sourceAsOfDate: obligation,
  evidenceType: 'ISSUER_STATUTORY_POINT' as const })
const filing = { documentId: 'S100HOLDER', sourceDocumentHash: 'c'.repeat(64),
  submittedAt: '2025-03-01 09:00:00',
  name: { concept: 'jplvh:NameOfIssuer', context: 'FilingDateInstant', value: '株式会社はせがわ' },
  securityCode: { concept: 'jplvh:SecurityCodeOfIssuer', context: 'FilingDateInstant', value: '8230' },
  listedStatus: { concept: 'jplvh:ListedOrOTC', context: 'FilingDateInstant', value: '上場' },
  exchange: { concept: 'jplvh:StockListing', context: 'FilingDateInstant', value: '東京' },
}
const base: CurrentCertificationInput = { documentId: filing.documentId, holderKey: 'holder1',
  issuerEdinetCode: 'E03134', issuerEvidence: filing, obligationDate: obligation,
  holdingInformationDate: obligation, latestFilingDate: '2025-03-01',
  certificationDate: currentDate, valuationAsOf: currentDate, latestMarketDate: currentDate,
  latestEffectivePosition: true, researchStatus: 'FULL_DIRECT', directUnits: 2_202_002,
  directComponentTotal: 2_202_002, directComponentCount: 1, directUnit: 'xbrli:shares',
  directConcept: 'jplvh:StocksOrInvestmentSecuritiesEtcArticle27233MainClause',
  historicalClassProof: proof(capital([commonClass])), reitProof: null,
  historicalInstrument: instrument(obligation), currentInstrument: instrument(currentDate),
  sameIssuerDirectClassCount: 1, currentPrice: price(currentDate) }
const retro = certifyPositionByMode({ certificationMode: 'RETROSPECTIVE_TRUTH', current: base })
assert.equal(retro.currentValuationCandidate, true)
assert.equal(retro.classification, 'RETROSPECTIVE_UNIQUE_COMMON')
assert.equal(retro.publicCurrentValuationReady, true)
assert.equal(retro.currentEstimatedValueYen, 682_620_620)
assert.notEqual(retro.currentEstimatedValueYen, 68_262_062_000)
assert.equal(retro.publicHistoricalPitValuationReady, false)
assert.equal(retro.quantityUnit, 'SHARE')
assert.equal(retro.priceUnit, 'JPY_PER_SHARE')
assert.equal(retro.evidence[1].publishedAt, '2025-03-02 10:00:00')
assert.equal(retro.daysSinceLatestDisclosure, 566)
const laterSource = capital([commonClass])
const laterSourceEvidence = { ...JSON.parse(laterSource.sourceEvidence),
  sourceSubmittedAt: '2026-09-20 10:00:00' }
laterSource.sourceSubmittedAt = laterSourceEvidence.sourceSubmittedAt
laterSource.sourceEvidence = JSON.stringify(laterSourceEvidence)
laterSource.sourceHash = evidenceHash(laterSourceEvidence)
const laterCertified = certifyPositionByMode({ certificationMode: 'RETROSPECTIVE_TRUTH', current: {
  ...base, certificationDate: '2026-09-21', historicalClassProof: proof(laterSource) } })
assert.equal(laterCertified.publicCurrentValuationReady, true)
assert.equal(laterCertified.priceDate, currentDate)
assert.equal(laterCertified.certificationDate, '2026-09-21')
assert.equal(laterCertified.daysSinceLatestDisclosure, 569)
assert.equal(certifyPositionByMode({ certificationMode: 'RETROSPECTIVE_TRUTH', current: {
  ...base, certificationDate: currentDate, historicalClassProof: proof(laterSource) } })
  .publicCurrentValuationReady, false)

const pitInput: CertificationInput = { edinetIssuerCode: 'E03134', edinetSecurityCodeRaw: '8230',
  referenceDate: obligation, requestedAsOf: obligation, filingSubmittedAt: filing.submittedAt,
  researchStatus: 'FULL_DIRECT', eligibleUnits: base.directUnits, directUnit: base.directUnit,
  directConcept: base.directConcept, directComponentTotal: base.directComponentTotal,
  directComponentCount: 1, sourceDocumentHash: filing.sourceDocumentHash,
  holdingNote: null, issuerListing: '上場', instrument: base.historicalInstrument,
  sameIssuerListedClassCount: 1, price: price(obligation), codeBridge: null,
  capitalStructure: base.historicalClassProof!.structure }
const pit = certifyPositionByMode({ certificationMode: 'AS_KNOWN_AT_TIME', historical: pitInput })
assert.equal(pit.publicHistoricalPitValuationReady, false)
assert.equal(pit.publicCurrentValuationReady, false)
assert.equal(retro.publicCurrentValuationReady, true)
assert.equal(certifyPositionByMode({ certificationMode: 'RETROSPECTIVE_TRUTH', current: {
  ...base, historicalClassProof: null } }).classification, 'NO_HISTORICAL_CLASS_EVIDENCE')
assert.equal(verifyHistoricalClassProof({ ...base.historicalClassProof!, sourceEffectiveTo: '2025-03-31' },
  'E03134', obligation, currentDate), false)
assert.equal(certifyPositionByMode({ certificationMode: 'RETROSPECTIVE_TRUTH', current: {
  ...base, historicalClassProof: proof(capital([commonClass, { ...commonClass,
    name: '第1種優先株式', kind: 'PREFERRED_OR_CLASS_STOCK', dimension: 'PreferredMember' }])) } })
  .classification, 'MULTIPLE_CLASS_AMBIGUOUS')
assert.equal(certifyPositionByMode({ certificationMode: 'RETROSPECTIVE_TRUTH', current: {
  ...base, issuerEvidence: { ...filing, securityCode: null } } }).classification, 'NO_FILING_SECURITY_CODE')
const renamed = certifyPositionByMode({ certificationMode: 'RETROSPECTIVE_TRUTH', current: {
  ...base, issuerEvidence: { ...filing, name: { ...filing.name, value: '旧はせがわ商事' } } } })
assert.equal(renamed.publicCurrentValuationReady, true)
assert.deepEqual(renamed.warnings, ['NAME_HISTORY_WARNING'])
assert.equal(certifyPositionByMode({ certificationMode: 'RETROSPECTIVE_TRUTH', current: {
  ...base, currentPrice: price('2026-09-17') } }).classification, 'STALE_CURRENT_PRICE')
assert.equal(certifyPositionByMode({ certificationMode: 'RETROSPECTIVE_TRUTH', current: {
  ...base, latestMarketDate: '2026-09-21' } }).classification, 'STALE_CURRENT_PRICE')
assert.equal(certifyPositionByMode({ certificationMode: 'RETROSPECTIVE_TRUTH', current: {
  ...base, latestEffectivePosition: false } }).currentEstimatedValueYen, null)
assert.equal(certifyPositionByMode({ certificationMode: 'RETROSPECTIVE_TRUTH', current: {
  ...base, directComponentTotal: 2_202_003 } }).publicCurrentValuationReady, false)
assert.equal(certifyPositionByMode({ certificationMode: 'RETROSPECTIVE_TRUTH', current: {
  ...base, sameIssuerDirectClassCount: 2 } }).classification, 'NO_MARKET_INSTRUMENT')
assert.equal(certifyPositionByMode({ certificationMode: 'RETROSPECTIVE_TRUTH', current: {
  ...base, currentPrice: { ...price(currentDate), rawClose: 999 } } }).publicCurrentValuationReady, false)

const reitClass: StatutorySecurityClass = { ...commonClass, name: '投資口',
  kind: 'REIT_INVESTMENT_UNIT', dimension: 'EDINET:32900', issuedUnits: 973_670,
  quantityUnit: 'UNIT', listedExchange: null, listingDescription: null, lotSize: 1 }
const reitData = { issuerEdinetCode: 'E03134', securityCode: '32900', issuedUnits: 973_670,
  listedFrom: '2018-01-01', listedTo: null, sourceAsOfDate: currentDate,
  quantityUnit: 'UNIT', priceUnit: 'JPY_PER_UNIT' }
const reitProof: OfficialReitProof = { issuerEdinetCode: reitData.issuerEdinetCode,
  securityCode: reitData.securityCode, issuedUnits: reitData.issuedUnits,
  listedFrom: reitData.listedFrom, listedTo: null, sourceAsOfDate: currentDate,
  sourcePublishedAt: `${currentDate} 17:00:00`, sourceAuthority: 'JPX_REIT',
  sourceReference: 'https://www.jpx.co.jp/equities/products/reits/issues/',
  sourceEvidence: JSON.stringify(reitData), sourceHash: evidenceHash(reitData) }
const reitInput: CurrentCertificationInput = { ...base, issuerEvidence: {
  ...filing, securityCode: { ...filing.securityCode, value: '3290' } },
  directUnits: 26_365, directComponentTotal: 26_365,
  historicalClassProof: proof(capital([reitClass], false)), reitProof,
  historicalInstrument: instrument(obligation, 'REIT_INVESTMENT_UNIT', '32900'),
  currentInstrument: instrument(currentDate, 'REIT_INVESTMENT_UNIT', '32900'),
  currentPrice: price(currentDate, '32900', 81_400) }
const reit = certifyPositionByMode({ certificationMode: 'RETROSPECTIVE_TRUTH', current: reitInput })
assert.equal(reit.classification, 'RETROSPECTIVE_UNIQUE_REIT')
assert.equal(reit.publicCurrentValuationReady, true)
assert.equal(reit.currentEstimatedValueYen, 2_146_111_000)
assert.equal(reit.quantityUnit, 'UNIT')
assert.equal(reit.priceUnit, 'JPY_PER_UNIT')
assert.equal(certifyPositionByMode({ certificationMode: 'RETROSPECTIVE_TRUTH', current: {
  ...reitInput, reitProof: null } }).publicCurrentValuationReady, false)
assert.equal(certifyPositionByMode({ certificationMode: 'RETROSPECTIVE_TRUTH', current: {
  ...reitInput, reitProof: { ...reitProof, sourceHash: 'bad' } } }).publicCurrentValuationReady, false)

console.log('large-holder current and PIT mode certification: PASS')
