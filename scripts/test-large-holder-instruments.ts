import assert from 'node:assert/strict'
import { certifyPosition, classifyOfficialInstrument, evidenceHash, portfolioCompleteness,
  type CertificationInput, type OfficialInstrument, type OfficialPrice } from '@/lib/large-holders/instrument-certification'
import { EDINET_CODE_LIST_URL, verifyCapitalStructure, verifyEdinetBridge,
  type EdinetCodeBridge, type IssuerCapitalStructure,
  type StatutorySecurityClass } from '@/lib/large-holders/cross-document-evidence'

const stockMasterRow = { Code: '82300', Date: '2025-02-28', CoName: 'はせがわ', ProdCat: '011' }
const stockBarRow = { Code: '82300', Date: '2025-02-28', C: 310, AdjC: 310 }
const stock: OfficialInstrument = {
  instrumentId: 'JPX:82300', issuerEdinetCode: 'E07445', issuerName: '株式会社 はせがわ',
  officialSecurityCode: '82300', officialSecurityCodeRaw: '82300', jpxShortCode: '8230',
  isin: null, instrumentName: 'はせがわ', instrumentType: 'COMMON_STOCK', securityClass: '011',
  quantityUnit: 'SHARE', priceUnit: 'JPY_PER_SHARE', market: 'スタンダード',
  listingStatus: 'LISTED', listedFrom: '2001-01-01', listedTo: null, priceSeriesId: '8230',
  sourceAuthority: 'JQUANTS_JPX', sourceUrlOrReference: 'https://api.jquants.com/v2/equities/master?date=2025-02-28',
  sourceAsOf: '2025-02-28', sourceEvidence: JSON.stringify({ jquantsMaster: stockMasterRow }),
  sourceHash: evidenceHash(stockMasterRow), mappingStatus: 'OFFICIAL_EXACT', mappingConfidence: 'HIGH',
}
const stockPrice: OfficialPrice = {
  officialSecurityCodeRaw: '82300', date: '2025-02-28', rawClose: 310,
  adjustedClose: 310, localClose: 310, sourceAuthority: 'JQUANTS_JPX',
  sourceUrlOrReference: 'https://api.jquants.com/v2/equities/bars/daily?date=2025-02-28',
  sourceEvidence: JSON.stringify(stockBarRow),
  sourceHash: evidenceHash(stockBarRow),
}
function codeBridge(code = 'E07445', securityCode = '82300', snapshotDate = '2025-02-27'): EdinetCodeBridge {
  const evidence = { edinetCode: code, securityCode, submitterName: '株式会社はせがわ',
    listingStatus: '上場', snapshotDate, archiveSha256: 'a'.repeat(64) }
  return { ...evidence, sourceUrl: EDINET_CODE_LIST_URL,
    sourceEvidence: JSON.stringify(evidence), sourceHash: evidenceHash(evidence) }
}
const commonClass: StatutorySecurityClass = { name: '普通株式', kind: 'COMMON_STOCK',
  dimension: 'jpcrp_cor:OrdinaryShareMember', issuedUnits: 20_000_000, quantityUnit: 'SHARE',
  listedExchange: '東京証券取引所 スタンダード', listingDescription: '東京証券取引所 スタンダード', lotSize: 100 }
function capitalStructure(classes: StatutorySecurityClass[] = [commonClass],
  code = 'E07445', submittedAt = '2025-02-28 09:00'): IssuerCapitalStructure {
  const evidence = { issuerEdinetCode: code, sourceDocumentId: 'S100TEST',
    sourceSubmittedAt: submittedAt, reportingDate: submittedAt.slice(0, 10),
    xbrlSha256: 'b'.repeat(64), tableSha256: 'c'.repeat(64), classes, tableComplete: true }
  return { issuerEdinetCode: code, sourceDocumentId: evidence.sourceDocumentId,
    sourceSubmittedAt: submittedAt, reportingDate: evidence.reportingDate,
    sourceUrl: 'https://disclosure2.edinet-fsa.go.jp/WZEK0040.aspx?S100TEST',
    sourceEvidence: JSON.stringify(evidence), sourceHash: evidenceHash(evidence),
    classes, tableComplete: true }
}
const base: CertificationInput = {
  edinetIssuerCode: 'E07445', edinetSecurityCodeRaw: '8230', referenceDate: '2025-02-28',
  requestedAsOf: '2025-02-28', filingSubmittedAt: '2025-02-28 10:44',
  researchStatus: 'FULL_DIRECT', eligibleUnits: 2_202_002,
  directUnit: 'xbrli:shares', directConcept: 'jplvh_cor:StocksOrInvestmentSecuritiesEtcArticle27233MainClause',
  directComponentTotal: 2_202_002, directComponentCount: 1, sourceDocumentHash: 'edinet-xbrl-hash',
  holdingNote: '普通株式 2,202,002株', issuerListing: '上場', instrument: stock,
  currentInstrument: stock, sameIssuerListedClassCount: 1, price: stockPrice, currentPrice: stockPrice,
  codeBridge: codeBridge(), capitalStructure: capitalStructure(),
  currentCodeBridge: codeBridge(), currentCapitalStructure: capitalStructure(),
  isLatestEffectivePosition: true,
}
const ready = certifyPosition(base)
assert.equal(ready.publicStatus, 'PUBLIC_VALUATION_READY')
assert.equal(ready.estimatedValueYen, 682_620_620)
assert.equal(ready.currentValueYen, 682_620_620)
assert.equal(ready.quantityUnit, 'SHARE')
assert.equal(ready.priceUnit, 'JPY_PER_SHARE')
assert.ok(ready.evidence.quantity?.startsWith('edinet-xbrl-hash:'))
assert.notEqual(ready.estimatedValueYen, 68_262_062_000)
assert.equal(ready.certificationMethod, 'EXPLICIT_FILING')
assert.equal(ready.certificationStrength, 'EXPLICIT')
assert.equal(ready.certificationEvidence.length, 5)
assert.equal(verifyEdinetBridge(codeBridge(), 'E07445', '82300', '2025-02-27 23:59:59'), false)
assert.equal(verifyEdinetBridge({ ...codeBridge(), submitterName: '別法人' }, 'E07445',
  '82300', '2025-02-28 23:59:59'), false)
assert.equal(verifyEdinetBridge({ ...codeBridge(), listingStatus: '上場',
  sourceEvidence: codeBridge().sourceEvidence.replace('上場', '非上場') }, 'E07445',
  '82300', '2025-02-28 23:59:59'), false)
assert.equal(verifyCapitalStructure(capitalStructure(), 'E07445', '2025-02-27 23:59:59'), false)
assert.equal(certifyPosition({ ...base, codeBridge: codeBridge('E07445', '82300', '2026-09-20') })
  .certificationMethod, 'NO_OFFICIAL_CODE_MAPPING')
assert.equal(certifyPosition({ ...base, holdingNote: null, capitalStructure: capitalStructure(undefined,
  'E07445', '2025-03-01 09:00') }).certificationMethod, 'NO_CAPITAL_STRUCTURE_EVIDENCE')
const cross = certifyPosition({ ...base, holdingNote: null })
assert.equal(cross.publicStatus, 'PUBLIC_VALUATION_READY')
assert.equal(cross.certificationMethod, 'CROSS_DOCUMENT_UNIQUE')
assert.equal(cross.certificationStrength, 'OFFICIAL_CROSS_DOCUMENT')
assert.equal(cross.currentValueYen, 682_620_620)
assert.equal(certifyPosition({ ...base, holdingNote: null,
  instrument: { ...stock, issuerName: '旧はせがわ社名', mappingStatus: 'UNRESOLVED',
    mappingConfidence: 'UNRESOLVED' } }).certificationMethod, 'CROSS_DOCUMENT_UNIQUE')
assert.equal(certifyPosition({ ...base, holdingNote: null, codeBridge: codeBridge('E07445', '00000') })
  .certificationMethod, 'NO_OFFICIAL_CODE_MAPPING')
assert.equal(certifyPosition({ ...base, holdingNote: null, codeBridge: { ...codeBridge(), sourceHash: 'bad' } })
  .pitValuationReady, false)
assert.equal(certifyPosition({ ...base, holdingNote: null,
  capitalStructure: capitalStructure([commonClass, { ...commonClass, name: '第1種優先株式',
    kind: 'PREFERRED_OR_CLASS_STOCK', dimension: 'PreferredShareMember' }]) })
  .certificationMethod, 'AMBIGUOUS_MULTIPLE_CLASS')
assert.equal(certifyPosition({ ...base, holdingNote: null,
  capitalStructure: capitalStructure([commonClass, { ...commonClass, name: '第1種優先株式',
    kind: 'PREFERRED_OR_CLASS_STOCK', dimension: 'PreferredShareMember', listedExchange: null,
    listingDescription: '非上場' }]) }).publicStatus, 'SECURITY_CLASS_AMBIGUOUS')
assert.equal(certifyPosition({ ...base, holdingNote: null,
  capitalStructure: capitalStructure([{ ...commonClass, listingDescription: null }]) })
  .pitValuationReady, false)
assert.equal(certifyPosition({ ...base, holdingNote: null, currentCapitalStructure: null }).currentValueYen, null)
assert.equal(certifyPosition({ ...base, isLatestEffectivePosition: false }).currentValueYen, null)
assert.equal(certifyPosition({ ...base, filingSubmittedAt: '2025-03-01 09:00' }).pitValuationReady, false)

const reit: OfficialInstrument = { ...stock, instrumentId: 'JPX:32900', issuerEdinetCode: 'E00000',
  issuerName: 'Ｏｎｅリート投資法人 投資証券',
  officialSecurityCode: '32900', officialSecurityCodeRaw: '32900', jpxShortCode: '3290',
  priceSeriesId: '3290', instrumentName: 'Ｏｎｅリート投資法人 投資証券',
  instrumentType: 'REIT_INVESTMENT_UNIT', quantityUnit: 'UNIT', priceUnit: 'JPY_PER_UNIT',
  sourceEvidence: JSON.stringify({ jquantsMaster: { ...stockMasterRow, Code: '32900',
    CoName: 'Ｏｎｅリート投資法人 投資証券' } }),
  sourceHash: evidenceHash({ ...stockMasterRow, Code: '32900',
    CoName: 'Ｏｎｅリート投資法人 投資証券' }) }
const reitPrice: OfficialPrice = { ...stockPrice, officialSecurityCodeRaw: '32900', rawClose: 81_400,
  adjustedClose: 81_400, localClose: 81_400,
  sourceEvidence: JSON.stringify({ ...stockBarRow, Code: '32900', C: 81_400, AdjC: 81_400 }),
  sourceHash: evidenceHash({ ...stockBarRow, Code: '32900', C: 81_400, AdjC: 81_400 }) }
const reitInput: CertificationInput = { ...base, edinetIssuerCode: 'E00000', edinetSecurityCodeRaw: '3290',
  eligibleUnits: 26_365, directComponentTotal: 26_365, instrument: reit,
  currentInstrument: reit, price: reitPrice, currentPrice: reitPrice,
  holdingNote: '投資口 26,365口', codeBridge: codeBridge('E00000', '32900'),
  currentCodeBridge: codeBridge('E00000', '32900'),
  capitalStructure: capitalStructure([{ ...commonClass, name: '投資口', kind: 'REIT_INVESTMENT_UNIT',
    quantityUnit: 'UNIT', lotSize: 1 }], 'E00000'),
  currentCapitalStructure: capitalStructure([{ ...commonClass, name: '投資口', kind: 'REIT_INVESTMENT_UNIT',
    quantityUnit: 'UNIT', lotSize: 1 }], 'E00000') }
assert.equal(certifyPosition(reitInput).estimatedValueYen, 2_146_111_000)
assert.equal(certifyPosition({ ...reitInput, holdingNote: null }).certificationMethod, 'CROSS_DOCUMENT_UNIQUE')
assert.equal(certifyPosition({ ...reitInput, holdingNote: '投資口 26,364口' }).publicStatus,
  'SECURITY_CLASS_AMBIGUOUS')
assert.equal(certifyPosition({ ...base, holdingNote: '普通株式 2,202,001株' }).publicStatus,
  'SECURITY_CLASS_AMBIGUOUS')
assert.equal(certifyPosition({ ...base, holdingNote: null, sameIssuerListedClassCount: 2 }).mappingStatus,
  'MULTIPLE_LISTED_CLASSES')
assert.equal(certifyPosition({ ...base, instrument: null }).mappingStatus, 'INSTRUMENT_NOT_FOUND')
assert.equal(certifyPosition({ ...base, instrument: { ...stock, instrumentType: 'PREFERRED_OR_CLASS_STOCK' } })
  .publicStatus, 'SECURITY_CLASS_AMBIGUOUS')
assert.equal(certifyPosition({ ...base, instrument: { ...stock, sourceHash: 'tampered' } })
  .publicStatus, 'SECURITY_CLASS_AMBIGUOUS')
assert.equal(certifyPosition({ ...base, price: null }).publicStatus, 'PRICE_SERIES_MISSING')
assert.equal(certifyPosition({ ...base, price: { ...stockPrice, date: '2025-03-01' } }).publicStatus,
  'PRICE_SERIES_MISSING')
assert.equal(certifyPosition({ ...base, instrument: { ...stock, sourceAsOf: '2025-03-01' } }).publicStatus,
  'SECURITY_CLASS_AMBIGUOUS')
assert.equal(certifyPosition({ ...base, instrument: { ...stock, listedTo: '2025-01-01' } }).mappingStatus,
  'HISTORICAL_ONLY')
assert.equal(certifyPosition({ ...base, directComponentTotal: 2_202_001 }).publicStatus, 'OTHER')
assert.equal(certifyPosition({ ...base, directUnit: 'UNKNOWN' }).mappingStatus, 'QUANTITY_UNIT_MISMATCH')
assert.equal(certifyPosition({ ...base, price: { ...stockPrice, adjustedClose: 620, localClose: 620,
  sourceEvidence: JSON.stringify({ ...stockBarRow, AdjC: 620 }),
  sourceHash: evidenceHash({ ...stockBarRow, AdjC: 620 }) } })
  .estimatedValueYen, 682_620_620)
assert.equal(certifyPosition({ ...base, price: { ...stockPrice, rawClose: 999 } }).publicStatus,
  'PRICE_SERIES_MISSING')
assert.equal(certifyPosition({ ...base, price: { ...stockPrice, localClose: 999 } }).publicStatus,
  'PRICE_SERIES_MISSING')
assert.equal(certifyPosition({ ...base, currentPrice: { ...stockPrice, date: '2025-02-27' } })
  .currentValueYen, null)
assert.equal(certifyPosition({ ...base, currentPrice: null }).publicStatus, 'STALE_ONLY')
assert.equal(certifyPosition({ ...base, currentInstrument: { ...stock, listingStatus: 'DELISTED' } })
  .currentValueYen, null)
assert.equal(certifyPosition({ ...base, currentInstrument: { ...stock, listingStatus: 'DELISTED' } })
  .pitValuationReady, true)
assert.equal(certifyPosition({ ...base, researchStatus: 'AMBIGUOUS' }).pitValuationReady, false)
assert.equal(certifyPosition({ ...base, researchStatus: 'PARTIAL_DIRECT' }).estimatedValueYen, 682_620_620)
assert.equal(classifyOfficialInstrument('011', '92015').instrumentType, 'PREFERRED_OR_CLASS_STOCK')
assert.equal(classifyOfficialInstrument('011', '278A0').instrumentType, 'COMMON_STOCK')
assert.equal(certifyPosition({ ...base, instrument: { ...stock,
  officialSecurityCode: '278A0', officialSecurityCodeRaw: '278A0', jpxShortCode: '278A',
  priceSeriesId: '278A', sourceEvidence: JSON.stringify({ jquantsMaster: {
    ...stockMasterRow, Code: '278A0' } }),
  sourceHash: evidenceHash({ ...stockMasterRow, Code: '278A0' }) },
  edinetSecurityCodeRaw: '278A', price: { ...stockPrice, officialSecurityCodeRaw: '278A0',
    sourceEvidence: JSON.stringify({ ...stockBarRow, Code: '278A0' }),
    sourceHash: evidenceHash({ ...stockBarRow, Code: '278A0' }) },
  currentInstrument: { ...stock, officialSecurityCode: '278A0', officialSecurityCodeRaw: '278A0',
    jpxShortCode: '278A', priceSeriesId: '278A',
    sourceEvidence: JSON.stringify({ jquantsMaster: { ...stockMasterRow, Code: '278A0' } }),
    sourceHash: evidenceHash({ ...stockMasterRow, Code: '278A0' }) },
  currentPrice: { ...stockPrice, officialSecurityCodeRaw: '278A0',
    sourceEvidence: JSON.stringify({ ...stockBarRow, Code: '278A0' }),
    sourceHash: evidenceHash({ ...stockBarRow, Code: '278A0' }) },
  codeBridge: codeBridge('E07445', '278A0'), currentCodeBridge: codeBridge('E07445', '278A0') })
  .publicStatus,
  'PUBLIC_VALUATION_READY')
assert.equal(classifyOfficialInstrument('013', '92840').instrumentType, 'UNRESOLVED')
assert.equal(classifyOfficialInstrument('013', '92840', 'INFRASTRUCTURE_FUND').instrumentType,
  'INFRASTRUCTURE_FUND_UNIT')
assert.deepEqual(portfolioCompleteness([true, true]), {
  status: 'COMPLETE', valuedPositionCount: 2, totalRelevantPositionCount: 2, unvaluedPositionCount: 0,
})
assert.deepEqual(portfolioCompleteness([true, false]), {
  status: 'PARTIAL', valuedPositionCount: 1, totalRelevantPositionCount: 2, unvaluedPositionCount: 1,
})
assert.equal(portfolioCompleteness([false, false]).status, 'NONE')
console.log('large-holder instrument certification: PASS')
