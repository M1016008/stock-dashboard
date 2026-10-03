import assert from 'node:assert/strict'
import { evidenceHash, type OfficialInstrument, type OfficialPrice } from '@/lib/large-holders/instrument-certification'
import { activeRegulatoryScope, excludedByRegulation } from '@/lib/large-holders/regulatory-scope'
import { certifyRegulatoryCurrentPosition, createOfficialMarketSnapshot,
  type MarketRow, type RegulatoryCurrentInput } from '@/lib/large-holders/regulatory-current-certification'
import { certifyPositionByMode } from '@/lib/large-holders/current-certification'
import type { IssuerCapitalStructure } from '@/lib/large-holders/cross-document-evidence'
import { recentTransactionTypesFromText } from '@/lib/large-holders/filing-supplemental'

const date = '2026-09-18'
const rows: MarketRow[] = Array.from({ length: 4_100 }, (_, i) => ({
  Date: date, Code: String(i + 10_000), CoName: `検証${i}`, ProdCat: '011', MktNm: 'プライム',
}))
for (const [code, name, prod] of [
  ['82300', 'はせがわ', '011'], ['25930', '伊藤園', '011'], ['25935', '伊藤園第1種優先', '011'],
  ['94340', 'ソフトバンク', '011'], ['94345', 'ソフトバンク第1回社債型種類', '011'],
  ['32900', 'Ｏｎｅリート投資法人', '013'],
]) rows.push({ Date: date, Code: code, CoName: name, ProdCat: prod, MktNm: 'プライム' })
const snapshot = createOfficialMarketSnapshot(rows, date)
const byCode = new Map(snapshot.rows.map((row) => [row.Code, row]))
const makeInstrument = (code: string, issuerCode = 'E03134', officialRow?: MarketRow): OfficialInstrument => {
  const row = officialRow ?? byCode.get(code)!
  return { instrumentId: `JPX:${code}`, issuerEdinetCode: issuerCode, issuerName: row.CoName,
    officialSecurityCode: code, officialSecurityCodeRaw: code, jpxShortCode: code.slice(0, 4),
    isin: null, instrumentName: row.CoName, instrumentType: row.ProdCat === '013' ? 'UNRESOLVED' : 'COMMON_STOCK',
    securityClass: row.ProdCat, quantityUnit: row.ProdCat === '013' ? 'UNKNOWN' : 'SHARE',
    priceUnit: row.ProdCat === '013' ? 'UNKNOWN' : 'JPY_PER_SHARE', market: row.MktNm,
    listingStatus: 'LISTED', listedFrom: null, listedTo: null, priceSeriesId: code.slice(0, 4),
    sourceAuthority: 'JQUANTS_JPX', sourceUrlOrReference: 'https://api.jquants.com/v2/equities/master',
    sourceAsOf: date, sourceEvidence: JSON.stringify({ jquantsMaster: row }), sourceHash: evidenceHash(row),
    mappingStatus: 'OFFICIAL_EXACT', mappingConfidence: 'HIGH' }
}
const makePrice = (code: string, close = 310): OfficialPrice => {
  const row = { Code: code, Date: date, C: close, AdjC: close }
  return { officialSecurityCodeRaw: code, date, rawClose: close, adjustedClose: close, localClose: close,
    sourceAuthority: 'JQUANTS_JPX', sourceUrlOrReference: 'https://api.jquants.com/v2/equities/bars/daily',
    sourceEvidence: JSON.stringify(row), sourceHash: evidenceHash(row) }
}
const filing = (code: string) => ({ documentId: 'S100REGULATORY', submittedAt: '2026-09-16 10:00:00',
  sourceDocumentHash: 'a'.repeat(64), name: { concept: 'jplvh:NameOfIssuer',
    context: 'FilingDateInstant', value: 'はせがわ' },
  securityCode: { concept: 'jplvh:SecurityCodeOfIssuer', context: 'FilingDateInstant', value: code },
  listedStatus: { concept: 'jplvh:ListedOrOTC', context: 'FilingDateInstant', value: '上場' },
  exchange: { concept: 'jplvh:StockListing', context: 'FilingDateInstant', value: '東京' } })
const base: RegulatoryCurrentInput = {
  documentId: 'S100REGULATORY', issuerEdinetCode: 'E03134', issuerEvidence: filing('8230'),
  obligationDate: '2026-09-14', certificationDate: '2026-09-21', valuationAsOf: date,
  latestMarketDate: date, latestEffectivePosition: true, researchStatus: 'FULL_DIRECT',
  directUnits: 2_202_002, directComponentTotal: 2_202_002, directComponentCount: 1,
  directUnit: 'xbrli:shares', directConcept: 'jplvh:StocksOrInvestmentSecuritiesEtcArticle27233MainClause',
  holdingNote: null, issuedTotal: { value: 20_000_000, unit: 'xbrli:shares',
    concept: 'jplvh:TotalNumberOfOutstandingStocksEtc', context: 'FilingDateInstant_Holder' },
  recentTransactionTypes: ['株券'], marketSnapshot: snapshot, currentInstrument: makeInstrument('82300'),
  currentPrice: makePrice('82300'), issuerCapitalStructure: null, jpxReitEvidence: null,
  transitionConflict: false,
}
const certify = (overrides: Partial<RegulatoryCurrentInput> = {}) => certifyRegulatoryCurrentPosition({ ...base, ...overrides })
assert.equal(certify().classification, 'FILING_CODE_REGULATORY_UNIQUE')
assert.equal(certify().strength, 'B')
assert.equal(certify().estimatedCurrentMarketValue, 682_620_620)
assert.equal(certify().publicHistoricalPitValuationReady, false)
assert.deepEqual(certifyPositionByMode({ certificationMode: 'REGULATORY_CURRENT', current: base }), certify())
assert.equal(certify({ holdingNote: '普通株式 2,202,002株' }).classification, 'FILING_EXPLICIT_CLASS')
assert.equal(certify({ holdingNote: '普通株式 2,202,002株' }).strength, 'A')
assert.equal(certify().issuedTotal?.value, 20_000_000)
assert.deepEqual(certify().recentTransactionTypes, ['株券'])
assert.equal(certify({ recentTransactionTypes: [], issuedTotal: null }).publicCurrentValuationReady, true)
assert.deepEqual(recentTransactionTypesFromText('年月日 株券等の種類 数量 単価'), [])
assert.deepEqual(recentTransactionTypesFromText('2026年9月1日 普通株式 3,000 2026年9月2日 投資口 2'),
  ['普通株式', '投資口'])
assert.equal(certify({ directComponentTotal: 2_202_003 }).publicCurrentValuationReady, false)
assert.equal(certify({ directConcept: 'jplvh:ConvertibleBondsArticle27233MainClause' }).publicCurrentValuationReady, false)
assert.equal(certify({ latestEffectivePosition: false }).publicCurrentValuationReady, false)
assert.equal(certify({ transitionConflict: true }).classification, 'CODE_AMBIGUOUS')
assert.equal(certify({ obligationDate: '2026-09-17' }).classification, 'CODE_AMBIGUOUS')
assert.equal(certify({ issuerEvidence: filing('82300') }).filingIssuerSecurityCodeRaw, '82300')
assert.equal(certify({ issuerEvidence: filing('82300') }).publicCurrentValuationReady, false)
assert.equal(certify({ issuerEvidence: { ...filing('8230'), listedStatus: null } }).classification, 'CODE_AMBIGUOUS')
assert.equal(certify({ issuerEvidence: { ...filing('8230'), exchange: null } }).classification, 'CODE_AMBIGUOUS')
assert.equal(certify({ marketSnapshot: null }).classification, 'CODE_AMBIGUOUS')
assert.equal(certify({ currentInstrument: null }).classification, 'CODE_AMBIGUOUS')
assert.equal(certify({ currentPrice: { ...makePrice('82300'), date: '2026-09-17' } }).classification, 'STALE_PRICE')
assert.equal(certify({ latestMarketDate: '2026-09-21' }).classification, 'STALE_PRICE')
assert.equal(certify({ currentPrice: { ...makePrice('82300'), rawClose: 999 } }).classification, 'STALE_PRICE')
assert.equal(certify({ currentPrice: makePrice('82300', 310.5) }).estimatedCurrentMarketValue, 683_721_621)
assert.notEqual(certify().estimatedCurrentMarketValue, 68_262_062_000) // No lot-size multiplier.

const ito = certify({ issuerEvidence: filing('2593'), currentInstrument: makeInstrument('25930'),
  currentPrice: makePrice('25930') })
assert.deepEqual(ito.eligibleListedClasses, ['25930', '25935'])
assert.equal(ito.classification, 'UNKNOWN_REGULATORY_SCOPE')
const softbank = certify({ issuerEvidence: filing('9434'), currentInstrument: makeInstrument('94340'),
  currentPrice: makePrice('94340') })
assert.deepEqual(softbank.excludedClasses, ['94345'])
assert.equal(softbank.classification, 'FILING_CODE_REGULATORY_UNIQUE')
assert.equal(excludedByRegulation(activeRegulatoryScope('PREFERRED_OR_CLASS_STOCK', '94345', date)), true)
assert.equal(excludedByRegulation(activeRegulatoryScope('PREFERRED_OR_CLASS_STOCK', '25935', date)), false)
assert.equal(excludedByRegulation(activeRegulatoryScope('PREFERRED_OR_CLASS_STOCK', '99995', date)), false)
assert.equal(certify({ issuerEvidence: filing('2593'), currentInstrument: makeInstrument('25930'),
  currentPrice: makePrice('25930'), holdingNote: '普通株式 2,202,002株' }).publicCurrentValuationReady, false)

const extended = createOfficialMarketSnapshot([...rows, { Date: date, Code: '82305',
  CoName: 'はせがわ第1種', ProdCat: '011', MktNm: 'プライム' }], date)
assert.equal(certify({ marketSnapshot: extended }).classification, 'UNKNOWN_REGULATORY_SCOPE')
const multiple = createOfficialMarketSnapshot([...rows, { Date: date, Code: '82305',
  CoName: 'はせがわ第1種', ProdCat: '011', MktNm: 'プライム' }], date)
assert.equal(certify({ marketSnapshot: multiple }).publicCurrentValuationReady, false)
const otherProduct = createOfficialMarketSnapshot([...rows, { Date: date, Code: '82305',
  CoName: 'はせがわ別商品', ProdCat: '012', MktNm: 'プライム' }], date)
assert.equal(certify({ marketSnapshot: otherProduct }).classification, 'UNKNOWN_REGULATORY_SCOPE')
const votingFacts = { securityType: 'PREFERRED_OR_CLASS_STOCK' as const, securityCode: '82305',
  votingStatus: 'VOTING' as const, reportingScopeStatus: 'ELIGIBLE' as const,
  convertibleToVoting: false, effectiveFrom: '2024-01-01', effectiveTo: null,
  sourceAuthority: 'JPX' as const, sourceReference: 'https://www.jpx.co.jp/equities/products/preferred-stocks/issues/' }
const voting = { ...votingFacts, sourceEvidence: JSON.stringify(votingFacts),
  sourceHash: evidenceHash(votingFacts) }
assert.equal(certify({ marketSnapshot: multiple, classScopeEvidence: [voting] }).classification,
  'MULTIPLE_ELIGIBLE_CLASSES')
const preferredInstrument = { ...makeInstrument('82305', 'E03134',
  multiple.rows.find((row) => row.Code === '82305')), instrumentType: 'PREFERRED_OR_CLASS_STOCK' as const,
  priceSeriesId: '82305' }
assert.equal(certify({ issuerEvidence: filing('82305'), marketSnapshot: multiple,
  classScopeEvidence: [voting], currentInstrument: preferredInstrument,
  currentPrice: makePrice('82305') }).classification, 'FILING_CODE_REGULATORY_UNIQUE')
assert.equal(certify({ issuerEvidence: filing('82305'), marketSnapshot: multiple,
  classScopeEvidence: [voting], currentInstrument: { ...preferredInstrument, priceSeriesId: '8230' },
  currentPrice: makePrice('82305') }).publicCurrentValuationReady, false)
assert.equal(certify({ marketSnapshot: multiple,
  classScopeEvidence: [{ ...voting, sourceHash: 'bad' }] }).classification, 'UNKNOWN_REGULATORY_SCOPE')

const classEntry = { name: '投資口', kind: 'REIT_INVESTMENT_UNIT' as const, dimension: 'REIT:3290',
  issuedUnits: 973_670, quantityUnit: 'UNIT' as const, listedExchange: null,
  listingDescription: null, lotSize: 1 }
const capitalEvidence = { issuerEdinetCode: 'E27884', sourceDocumentId: 'S100Y705',
  sourceSubmittedAt: '2026-05-28 10:00:00', reportingDate: '2026-05-28',
  xbrlSha256: 'c'.repeat(64), tableSha256: 'd'.repeat(64), classes: [classEntry], tableComplete: false }
const capital: IssuerCapitalStructure = { ...capitalEvidence,
  sourceUrl: 'https://disclosure2.edinet-fsa.go.jp/WZEK0040.aspx?S100Y705',
  sourceEvidence: JSON.stringify(capitalEvidence), sourceHash: evidenceHash(capitalEvidence) }
const reitEvidence = { code: '3290', issuerName: 'Ｏｎｅリート投資法人',
  listedFrom: '2013-10-09', isin: 'JP3047640002' }
const reit = { ...reitEvidence, sourceReference: 'https://www.jpx.co.jp/equities/products/reits/issues/',
  sourceEvidence: JSON.stringify(reitEvidence), sourceHash: evidenceHash(reitEvidence) }
const reitInput: Partial<RegulatoryCurrentInput> = { issuerEdinetCode: 'E27884',
  issuerEvidence: { ...filing('3290'), name: { ...filing('3290').name, value: 'Ｏｎｅリート投資法人' } },
  currentInstrument: makeInstrument('32900', 'E27884'), currentPrice: makePrice('32900', 81_400),
  directUnits: 26_365, directComponentTotal: 26_365, issuerCapitalStructure: capital,
  jpxReitEvidence: reit }
assert.equal(certify({ ...reitInput, jpxReitEvidence: null }).classification, 'REIT_UNRESOLVED')
assert.equal(certify({ ...reitInput, issuerCapitalStructure: null }).classification,
  'CROSS_DOCUMENT_REGULATORY_UNIQUE')
assert.equal(certify({ ...reitInput, issuerEvidence: filing('3290') }).classification, 'REIT_UNRESOLVED')
assert.equal(certify({ ...reitInput, jpxReitEvidence: { ...reit, sourceHash: 'bad' } }).classification,
  'REIT_UNRESOLVED')
assert.equal(certify(reitInput).classification, 'CROSS_DOCUMENT_REGULATORY_UNIQUE')
assert.equal(certify(reitInput).quantityUnit, 'UNIT')
assert.equal(certify(reitInput).priceUnit, 'JPY_PER_UNIT')
assert.equal(certify(reitInput).estimatedCurrentMarketValue, 2_146_111_000)
console.log('large-holder regulatory current certification: PASS')
