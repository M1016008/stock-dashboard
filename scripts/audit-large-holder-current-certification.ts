// Phase 16A-6 research audit. The production DB is opened read-only; no migration or update runs.
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { todayInTokyo } from '@/lib/date-time'
import { XbrlFactReader } from '@/lib/edinet-xbrl-facts'
import { parseLargeHolderFiling, type LargeHolderFiling } from '@/lib/large-holders/filing'
import { certifyPositionByMode, type CurrentClassification,
  type HistoricalClassProof } from '@/lib/large-holders/current-certification'
import type { IssuerCapitalStructure } from '@/lib/large-holders/cross-document-evidence'
import { evidenceHash, officialMasterEvidenceMatches, officialPriceMatchesInstrument, type OfficialInstrument,
  type OfficialPrice } from '@/lib/large-holders/instrument-certification'
import { resolveRevisionChains, type RevisionFiling } from '@/lib/large-holders/revision-chain'
import { downloadEdinetPublicXbrl, listEdinetDocuments } from '@/lib/server/edinet-api'
import type { EdinetDocumentIndexRow } from '@/lib/server/edinet-api'

type Row = Record<string, string | number | null>
type ReadOnlySqlite = {
  prepare(sql: string): { all(...values: (string | number)[]): unknown[];
    get(...values: (string | number)[]): unknown }
  exec(sql: string): void
  close(): void
}
const { DatabaseSync } = createRequire(`${process.cwd()}/package.json`)('node:sqlite') as {
  DatabaseSync: new (path: string, options: { readOnly: boolean }) => ReadOnlySqlite
}
const started = Date.now()
const dbPath = process.env.STOCKBOARD_DB_PATH?.trim()
if (!dbPath) throw new Error('STOCKBOARD_DB_PATH is required')
const db = new DatabaseSync(dbPath, { readOnly: true })
db.exec('PRAGMA query_only=ON')
const all = (sql: string, ...params: (string | number)[]): Row[] =>
  db.prepare(sql).all(...params) as unknown as Row[]
const one = (sql: string, ...params: (string | number)[]): Row | undefined =>
  db.prepare(sql).get(...params) as Row | undefined
const text = (value: string | number | null | undefined): string => String(value ?? '')
const optional = (value: string | number | null | undefined): string | null => value == null ? null : String(value)
const number = (value: string | number | null | undefined): number | null => value == null ? null : Number(value)
const sha = (value: string): string => createHash('sha256').update(value).digest('hex')
const flag = process.argv.find((arg) => arg.startsWith('--as-of='))
const asOf = flag?.slice('--as-of='.length)
  ?? text(one('SELECT MAX(price_date) AS d FROM large_holder_price_evidence')?.d)
if (!/^\d{4}-\d{2}-\d{2}$/.test(asOf)) throw new Error('Invalid --as-of')
const latestMarketDate = text(one('SELECT MAX(date) AS d FROM ohlcv_daily')?.d)
const certificationDate = process.argv.find((arg) => arg.startsWith('--certified-on='))
  ?.slice('--certified-on='.length) ?? todayInTokyo()
if (!/^\d{4}-\d{2}-\d{2}$/.test(certificationDate) || certificationDate < asOf) {
  throw new Error('Invalid --certified-on')
}
const officialCrosscheck = process.argv.includes('--official-crosscheck')

const candidateRows = all(`SELECT p.*,f.issuer_edinet_code,f.issuer_security_code,f.issuer_name,
  f.submitted_at,f.obligation_date AS filing_obligation_date,f.raw_index_json,
  s.xbrl_sha256,s.xbrl_xml FROM large_holder_positions p
  JOIN large_holder_filings f USING(document_id)
  JOIN large_holder_source_documents s USING(document_id)
  WHERE p.market_price_status IN ('FULL_DIRECT','PARTIAL_DIRECT')
  ORDER BY p.document_id,p.holder_key`)
if (candidateRows.length !== 233) throw new Error(`Expected 233 research candidates, got ${candidateRows.length}`)

const instrumentRows = all('SELECT * FROM large_holder_instrument_master WHERE source_as_of<=?', asOf)
const instruments = new Map<string, OfficialInstrument>()
for (const row of instrumentRows) {
  const instrument: OfficialInstrument = {
    instrumentId: text(row.instrument_id), issuerEdinetCode: optional(row.issuer_edinet_code),
    issuerName: text(row.issuer_name), officialSecurityCode: text(row.official_security_code),
    officialSecurityCodeRaw: text(row.official_security_code_raw), jpxShortCode: optional(row.jpx_short_code),
    isin: optional(row.isin), instrumentName: text(row.instrument_name),
    instrumentType: text(row.instrument_type) as OfficialInstrument['instrumentType'],
    securityClass: text(row.security_class), quantityUnit: text(row.quantity_unit) as OfficialInstrument['quantityUnit'],
    priceUnit: text(row.price_unit) as OfficialInstrument['priceUnit'], market: text(row.market),
    listingStatus: text(row.listing_status) as OfficialInstrument['listingStatus'],
    listedFrom: optional(row.listed_from), listedTo: optional(row.listed_to), priceSeriesId: optional(row.price_series_id),
    sourceAuthority: text(row.source_authority), sourceUrlOrReference: text(row.source_url_or_reference),
    sourceAsOf: text(row.source_as_of), sourceEvidence: text(row.source_evidence), sourceHash: text(row.source_hash),
    mappingStatus: text(row.mapping_status) as OfficialInstrument['mappingStatus'],
    mappingConfidence: text(row.mapping_confidence) as OfficialInstrument['mappingConfidence'],
  }
  instruments.set(`${instrument.jpxShortCode}:${instrument.sourceAsOf}`, instrument)
}
const priceRows = all('SELECT * FROM large_holder_price_evidence WHERE price_date<=?', asOf)
const prices = new Map<string, OfficialPrice>()
for (const row of priceRows) {
  const price: OfficialPrice = {
    officialSecurityCodeRaw: text(row.official_security_code_raw), date: text(row.price_date),
    rawClose: number(row.raw_close), adjustedClose: number(row.adjusted_close),
    localClose: number(row.local_close), sourceAuthority: text(row.source_authority),
    sourceUrlOrReference: text(row.source_url_or_reference), sourceEvidence: text(row.source_evidence),
    sourceHash: text(row.source_hash),
  }
  prices.set(`${price.officialSecurityCodeRaw}:${price.date}`, price)
}
const capitalRows = all('SELECT * FROM large_holder_issuer_capital_structure')
const capital = new Map<string, IssuerCapitalStructure[]>()
for (const row of capitalRows) {
  const structure: IssuerCapitalStructure = {
    issuerEdinetCode: text(row.issuer_edinet_code), sourceDocumentId: text(row.source_document_id),
    sourceSubmittedAt: text(row.source_submitted_at), reportingDate: text(row.reporting_date),
    sourceUrl: text(row.source_url), sourceEvidence: text(row.source_evidence), sourceHash: text(row.source_hash),
    classes: JSON.parse(text(row.classes_json)) as IssuerCapitalStructure['classes'],
    tableComplete: Number(row.table_complete) === 1,
  }
  capital.set(structure.issuerEdinetCode, [...(capital.get(structure.issuerEdinetCode) ?? []), structure])
}

const revisionRows = all(`SELECT f.document_id,f.filing_type,f.submitted_at,f.obligation_date,
  f.corrected_document_id,f.previous_filing_id,f.issuer_edinet_code,f.issuer_security_code,
  f.withdrawn_at,f.status,f.report_serial_number,f.submission_count,s.xbrl_sha256
  FROM large_holder_filings f LEFT JOIN large_holder_source_documents s USING(document_id)
  WHERE f.status IN ('ready','withdrawn') AND substr(f.submitted_at,1,10)<=?`, certificationDate)
const revisions = resolveRevisionChains(revisionRows.map((row): RevisionFiling => ({
  documentId: text(row.document_id), filingType: text(row.filing_type), submittedAt: text(row.submitted_at),
  obligationDate: optional(row.obligation_date), correctsFilingId: optional(row.corrected_document_id),
  previousFilingId: optional(row.previous_filing_id), issuerEdinetCode: optional(row.issuer_edinet_code),
  issuerSecurityCode: optional(row.issuer_security_code), withdrawnAt: optional(row.withdrawn_at),
  status: text(row.status), sourceSha256: optional(row.xbrl_sha256),
  reportSerialNumber: number(row.report_serial_number), submissionCount: number(row.submission_count),
})), certificationDate)
const effective = revisions.filter((item) => item.isEffectiveRevision)
const effectiveIds = new Set(effective.map((item) => item.documentId))
const positions = all(`SELECT p.document_id,p.holder_key,p.ticker,p.entity_id,p.reported_shares,
  f.submitted_at,f.obligation_date FROM large_holder_positions p
  JOIN large_holder_filings f USING(document_id) ORDER BY p.entity_id,p.ticker`)
  .filter((row) => effectiveIds.has(text(row.document_id)))
positions.sort((a, b) => text(b.obligation_date ?? b.submitted_at).localeCompare(text(a.obligation_date ?? a.submitted_at))
  || text(b.submitted_at).localeCompare(text(a.submitted_at))
  || text(b.document_id).localeCompare(text(a.document_id)))
const latest = new Map<string, Row>()
for (const row of positions) {
  const key = `${row.entity_id}:${row.ticker}`
  if (!latest.has(key)) latest.set(key, row)
}
const latestKeys = new Set([...latest.values()].map((row) => `${row.document_id}:${row.holder_key}`))

const filingCache = new Map<string, LargeHolderFiling>()
const classifications: Record<CurrentClassification, number> = {
  RETROSPECTIVE_UNIQUE_COMMON: 0, RETROSPECTIVE_UNIQUE_REIT: 0,
  MULTIPLE_CLASS_AMBIGUOUS: 0, NO_HISTORICAL_CLASS_EVIDENCE: 0,
  NO_FILING_SECURITY_CODE: 0, NO_MARKET_INSTRUMENT: 0,
  STALE_CURRENT_PRICE: 0, OTHER: 0,
}
const samples: { documentId: string; holderKey: string; ticker: string; category: CurrentClassification;
  reason: string; candidate: boolean; currentValueYen: number | null }[] = []
const readyKeys = new Set<string>()
let candidateCount = 0
let nameWarnings = 0
let storedSourceMismatches = 0
let directComponentMismatches = 0
let retrospectiveEvidenceCoveringDate = 0
let historicalPitReady = 0
let commonReady = 0
let reitReady = 0
let filingNativeCodePresent = 0
let historicalCodeListUnavailable = 0
let latestMissingFreshPrice = 0
let supersededResearchRows = 0
let latestDirectUnitUnproven = 0
let datedHistoricalInstrumentPresent = 0
let completeIssuerClassCountPresent = 0
for (const row of candidateRows) {
  const documentId = text(row.document_id)
  let filing = filingCache.get(documentId)
  if (!filing) {
    const xml = text(row.xbrl_xml)
    const digest = sha(xml)
    if (digest !== row.xbrl_sha256) storedSourceMismatches++
    filing = parseLargeHolderFiling(JSON.parse(text(row.raw_index_json)) as EdinetDocumentIndexRow, xml)
    filingCache.set(documentId, filing)
    if (filing.issuerSecurityCode !== row.issuer_security_code
      || filing.issuerEdinetCode !== row.issuer_edinet_code
      || filing.issuerName !== row.issuer_name) storedSourceMismatches++
  }
  const holder = filing.holders.find((item) => item.key === row.holder_key)
  if (!holder) { directComponentMismatches++; continue }
  const breakdown = JSON.parse(text(row.security_breakdown_json)) as LargeHolderFiling['holders'][number]['securityBreakdown']
  if (JSON.stringify(breakdown) !== JSON.stringify(holder.securityBreakdown)) directComponentMismatches++
  const direct = holder.securityBreakdown.filter((part) => part.kind === 'DIRECT_SECURITY' && part.quantity > 0)
  const obligationDate = text(row.filing_obligation_date)
  const issuerCode = text(row.issuer_edinet_code)
  if (filing.issuerEvidence.securityCode?.value) filingNativeCodePresent++
  if (!one(`SELECT 1 AS present FROM large_holder_edinet_code_bridge
    WHERE edinet_code=? AND snapshot_date<? LIMIT 1`, issuerCode, obligationDate)) historicalCodeListUnavailable++
  const proofSource = capital.get(issuerCode)?.find((item) =>
    item.reportingDate === obligationDate && item.sourceSubmittedAt.slice(0, 10) <= certificationDate) ?? null
  const proof: HistoricalClassProof | null = proofSource ? {
    structure: proofSource, sourcePublishedAt: proofSource.sourceSubmittedAt,
    sourceEffectiveFrom: proofSource.reportingDate, sourceEffectiveTo: proofSource.reportingDate,
    sourceAsOfDate: proofSource.reportingDate, evidenceType: 'ISSUER_STATUTORY_POINT',
  } : null
  if (proof) retrospectiveEvidenceCoveringDate++
  const ticker = text(row.ticker)
  const isLatest = latestKeys.has(`${documentId}:${row.holder_key}`)
  if (!isLatest) supersededResearchRows++
  else if (!number(row.market_price_eligible_units)) latestDirectUnitUnproven++
  const current = instruments.get(`${ticker}:${asOf}`) ?? null
  const historic = instruments.get(`${ticker}:${obligationDate}`) ?? null
  if (historic) datedHistoricalInstrumentPresent++
  const sameIssuerDirectClassCount = proofSource?.tableComplete
    ? proofSource.classes.length : null
  if (sameIssuerDirectClassCount != null) completeIssuerClassCountPresent++
  const currentPrice = current ? prices.get(`${current.officialSecurityCodeRaw}:${asOf}`) ?? null : null
  if (isLatest
    && (!current || !currentPrice || !officialPriceMatchesInstrument(currentPrice, current))) {
    latestMissingFreshPrice++
  }
  const valuation = certifyPositionByMode({ certificationMode: 'RETROSPECTIVE_TRUTH', current: {
    documentId, holderKey: text(row.holder_key), issuerEdinetCode: optional(row.issuer_edinet_code),
    issuerEvidence: filing.issuerEvidence, obligationDate,
    holdingInformationDate: text(row.reference_date ?? row.filing_obligation_date),
    latestFilingDate: text(row.submitted_at).slice(0, 10),
    certificationDate, valuationAsOf: asOf, latestMarketDate,
    latestEffectivePosition: isLatest,
    researchStatus: text(row.market_price_status), directUnits: number(row.market_price_eligible_units),
    directComponentTotal: direct.reduce((sum, part) => sum + part.quantity, 0),
    directComponentCount: direct.length,
    directUnit: direct.length && direct.every((part) => part.unit === direct[0].unit) ? direct[0].unit : null,
    directConcept: direct.length && direct.every((part) => part.concept.includes('StocksOrInvestmentSecurities'))
      ? direct[0].concept : null,
    historicalClassProof: proof, reitProof: null,
    historicalInstrument: historic,
    currentInstrument: current, sameIssuerDirectClassCount,
    currentPrice,
  } })
  classifications[valuation.classification]++
  if (valuation.currentValuationCandidate) candidateCount++
  if (valuation.warnings.includes('NAME_HISTORY_WARNING')) nameWarnings++
  if (valuation.publicCurrentValuationReady) {
    readyKeys.add(`${documentId}:${row.holder_key}`)
    if (valuation.securityClassStatus === 'UNIQUE_COMMON') commonReady++
    if (valuation.securityClassStatus === 'UNIQUE_REIT') reitReady++
  }
  const legacy = one(`SELECT pit_valuation_ready FROM large_holder_position_certifications
    WHERE document_id=? AND holder_key=?`, documentId, text(row.holder_key))
  if (Number(legacy?.pit_valuation_ready) === 1) historicalPitReady++
  if (samples.length < 16 || valuation.publicCurrentValuationReady) samples.push({
    documentId, holderKey: text(row.holder_key), ticker,
    category: valuation.classification, reason: valuation.reason,
    candidate: valuation.currentValuationCandidate,
    currentValueYen: valuation.currentEstimatedValueYen,
  })
}

const portfolios = new Map<string, { valued: number; total: number }>()
for (const row of latest.values()) {
  const entityId = text(row.entity_id)
  const entry = portfolios.get(entityId) ?? { valued: 0, total: 0 }
  entry.total++
  if (readyKeys.has(`${row.document_id}:${row.holder_key}`)) entry.valued++
  portfolios.set(entityId, entry)
}
const completeness = { COMPLETE: 0, PARTIAL: 0, NONE: 0 }
for (const row of portfolios.values()) {
  if (!row.valued) completeness.NONE++
  else if (row.valued === row.total) completeness.COMPLETE++
  else completeness.PARTIAL++
}

const sampledRows = candidateRows.filter((row) => latestKeys.has(`${row.document_id}:${row.holder_key}`))
  .filter((row, index, rows) => rows.findIndex((other) => other.document_id === row.document_id) === index)
  .slice(0, 50)
async function officialDateRows(url: string, date: string): Promise<Record<string, unknown>[]> {
  const key = process.env.JQUANTS_API_KEY?.trim()
  if (!key) throw new Error('JQUANTS_API_KEY is required for official cross-check')
  const rows: Record<string, unknown>[] = []
  let next: string | undefined
  do {
    const params = new URLSearchParams({ date })
    if (next) params.set('pagination_key', next)
    const response = await fetch(`${url}?${params}`, {
      headers: { 'x-api-key': key }, signal: AbortSignal.timeout(30_000),
    })
    if (!response.ok) throw new Error(`J-Quants cross-check HTTP ${response.status}`)
    const body = await response.json() as { data?: Record<string, unknown>[]; pagination_key?: string }
    rows.push(...(body.data ?? []))
    next = body.pagination_key
  } while (next)
  return rows
}

async function finishAudit(): Promise<void> {
  let independentChecks = 0
  let independentMismatches = 0
  let independentMarketRows = 0
  let independentPriceRows = 0
  let independentPriceMissing = 0
  let independentValuationChecks = 0
  let officialMultipleClassNegative = false
  let officialReitUnits: number | null = null
  if (officialCrosscheck) {
    if (sampledRows.length < 50) throw new Error(`Only ${sampledRows.length} independent documents`)
    const [officialMaster, officialBars] = await Promise.all([
      officialDateRows('https://api.jquants.com/v2/equities/master', asOf),
      officialDateRows('https://api.jquants.com/v2/equities/bars/daily', asOf),
    ])
    const masterByCode = new Map(officialMaster.map((row) => [String(row.Code), row]))
    const barByCode = new Map(officialBars.map((row) => [String(row.Code), row]))
    for (const source of sampledRows) {
      const documentId = text(source.document_id)
      const xml = await downloadEdinetPublicXbrl(documentId)
      const parsed = parseLargeHolderFiling(JSON.parse(text(source.raw_index_json)) as EdinetDocumentIndexRow, xml)
      const holder = parsed.holders.find((entry) => entry.key === source.holder_key)
      const storedBreakdown = JSON.parse(text(source.security_breakdown_json)) as unknown
      independentChecks++
      if (sha(xml) !== source.xbrl_sha256 || parsed.issuerSecurityCode !== source.issuer_security_code
        || parsed.issuerEdinetCode !== source.issuer_edinet_code
        || parsed.issuerEvidence.exchange?.value !== filingCache.get(documentId)?.issuerExchange
        || parsed.holders.length !== filingCache.get(documentId)?.holders.length
        || !holder || JSON.stringify(holder.securityBreakdown) !== JSON.stringify(storedBreakdown)) {
        independentMismatches++
      }
      const current = instruments.get(`${source.ticker}:${asOf}`)
      if (!current) continue
      const master = masterByCode.get(current.officialSecurityCodeRaw)
      independentMarketRows++
      if (!master || evidenceHash(master) !== current.sourceHash || !officialMasterEvidenceMatches(current)) {
        independentMismatches++
      }
      const price = prices.get(`${current.officialSecurityCodeRaw}:${asOf}`)
      if (!price || price.rawClose == null) { independentPriceMissing++; continue }
      const bar = barByCode.get(current.officialSecurityCodeRaw)
      independentPriceRows++
      if (!bar || evidenceHash(bar) !== price.sourceHash || !officialPriceMatchesInstrument(price, current)) {
        independentMismatches++
      }
    }
    const [classIndex, reitIndex] = await Promise.all([
      listEdinetDocuments('2026-07-21'), listEdinetDocuments('2026-05-28'),
    ])
    const classDoc = classIndex.find((row) => row.edinetCode === 'E00414' && row.docTypeCode === '120')
    if (classDoc) {
      const facts = new XbrlFactReader(await downloadEdinetPublicXbrl(classDoc.docID)).facts
      const classes = facts.filter((fact) => fact.localName === 'ClassIssuedSharesTotalNumberOfSharesEtc'
        && fact.contextRef.startsWith('FilingDateInstant_') && !fact.isNil)
      officialMultipleClassNegative = classes.some((fact) => /普通株式/.test(fact.textValue))
        && classes.some((fact) => /優先株式/.test(fact.textValue))
    }
    if (!officialMultipleClassNegative) independentMismatches++
    const reitDoc = reitIndex.find((row) => row.edinetCode === 'E27884' && row.docTypeCode === '120')
    if (reitDoc) {
      const facts = new XbrlFactReader(await downloadEdinetPublicXbrl(reitDoc.docID)).facts
      const block = facts.find((fact) => fact.localName === 'PaidInCapitalOfInvestmentCorporationTextBlock'
        && fact.contextRef === 'FilingDateInstant')
      const match = block?.textValue.normalize('NFKC')
        .match(/発行済投資口の総口数\s*([\d,]+)\s*口/)
      officialReitUnits = match ? Number(match[1].replaceAll(',', '')) : null
    }
    if (officialReitUnits !== 973_670) independentMismatches++
  }
  const realMultipleClassNegativeControls = capitalRows
    .map((row) => ({ issuerEdinetCode: text(row.issuer_edinet_code),
      sourceDocumentId: text(row.source_document_id),
      classCount: (JSON.parse(text(row.classes_json)) as unknown[]).length }))
    .filter((row) => row.classCount > 1)
    .map((row) => ({ ...row, positions: all(`SELECT p.ticker,p.market_price_status
      FROM large_holder_positions p JOIN large_holder_filings f USING(document_id)
      WHERE f.issuer_edinet_code=?`, row.issuerEdinetCode) }))
  const realReitClassSources = capitalRows.filter((row) =>
    (JSON.parse(text(row.classes_json)) as { kind: string }[])
      .some((item) => item.kind === 'REIT_INVESTMENT_UNIT')).length
  const classification = all(`SELECT investor_class,COUNT(*) AS n FROM investor_entities
  WHERE entity_id IN (SELECT DISTINCT entity_id FROM large_holder_positions)
  GROUP BY investor_class ORDER BY investor_class`)
  const result = {
    phase: '16A-6', mode: 'RETROSPECTIVE_TRUTH', readOnlyDb: true,
    valuationAsOf: asOf, certificationDate, latestMarketDate,
    priceDateIsLatestMarketDate: asOf === latestMarketDate,
    candidatePositions: candidateRows.length,
    currentValuationCandidates: candidateCount, classifications,
    publicCurrentValuationReady: readyKeys.size, publicHistoricalPitValuationReady: historicalPitReady,
    commonReady, reitReady, portfolioCompleteness: completeness,
    latestEffectivePositions: latest.size, investorPortfolios: portfolios.size,
    retrospectiveEvidenceCoveringDate, nameWarnings, filingNativeCodePresent,
    historicalCodeListUnavailable, latestMissingFreshPrice,
    supersededResearchRows, latestDirectUnitUnproven,
    datedHistoricalInstrumentPresent, completeIssuerClassCountPresent,
    realMultipleClassNegativeControls, realReitClassSources,
    officialMultipleClassNegative, officialReitUnits,
    storedSourceMismatches, directComponentMismatches,
    independentChecks, independentMismatches, independentMarketRows,
    independentPriceRows, independentPriceMissing, independentValuationChecks,
    correctionUnresolved: revisions.filter((row) => row.unresolvedReason).length,
    classificationFoundation: classification,
    samples, phase16bCurrentRankingGate: 'NO-GO',
    historicalPitValuationGate: 'NO-GO',
    elapsedMs: Date.now() - started,
    maxRssBytes: process.resourceUsage().maxRSS * 1024,
    rssBytesAtReport: process.memoryUsage().rss, dbWrites: 0,
  }
  db.close()
  console.log(JSON.stringify(result, null, 2))
  if (storedSourceMismatches || directComponentMismatches || independentMismatches) process.exitCode = 1
}

finishAudit().catch((error) => { db.close(); console.error(error); process.exitCode = 1 })
