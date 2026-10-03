// Phase 16A-7 research only. No migrations, inserts, or production delivery.
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { unzipSync } from 'fflate'
import { XbrlFactReader } from '@/lib/edinet-xbrl-facts'
import { parseLargeHolderFiling, type LargeHolderFiling } from '@/lib/large-holders/filing'
import { recentTransactionTypesFromText } from '@/lib/large-holders/filing-supplemental'
import { verifyCapitalStructureSource, type IssuerCapitalStructure } from '@/lib/large-holders/cross-document-evidence'
import { evidenceHash, type OfficialInstrument, type OfficialPrice } from '@/lib/large-holders/instrument-certification'
import { createOfficialMarketSnapshot,
  type MarketRow, type RegulatoryCurrentClassification } from '@/lib/large-holders/regulatory-current-certification'
import { certifyPositionByMode } from '@/lib/large-holders/current-certification'
import { resolveRevisionChains, type RevisionFiling } from '@/lib/large-holders/revision-chain'
import { downloadEdinetPublicArchiveBytes, downloadEdinetPublicXbrl,
  type EdinetDocumentIndexRow } from '@/lib/server/edinet-api'
import { classifyFromFiling, classForCategory, type InvestorCategory } from '@/lib/large-holders/classification'
import { currentPositionEntityId } from '@/lib/large-holders/entity-adjudications'
import { guardForDatabase, requiresExternalStorageGuard } from '@/lib/storage/external-storage-guard'
import { blockedTickerSet, readQuarantineScopes } from '@/lib/server/large-holders/quarantine-scope'
import { archiveOfficialRaw, decisionHash, derivedFact, sha256, verifyArchivedLineage,
  type RawEvidence } from '@/lib/large-holders/evidence-provenance'

type Row = Record<string, string | number | null>
const path = process.env.STOCKBOARD_DB_PATH
if (!path) throw new Error('STOCKBOARD_DB_PATH required')
if (requiresExternalStorageGuard(path)) guardForDatabase(path).assertWritable(true)
const started = Date.now()
const { DatabaseSync } = createRequire(`${process.cwd()}/package.json`)('node:sqlite') as {
  DatabaseSync: new (filename: string, options: { readOnly: boolean }) => {
    prepare(sql: string): { all(...args: (string | number)[]): unknown[];
      get(...args: (string | number)[]): unknown }
    exec(sql: string): void; close(): void
  }
}
const db = new DatabaseSync(path, { readOnly: true })
db.exec('PRAGMA query_only=ON')
const all = (sql: string, ...args: (string | number)[]) => db.prepare(sql).all(...args) as Row[]
const one = (sql: string, ...args: (string | number)[]) => db.prepare(sql).get(...args) as Row | undefined
const str = (value: unknown) => String(value ?? '')
const nullable = (value: unknown) => value == null ? null : String(value)
const num = (value: unknown) => value == null ? null : Number(value)
const hash = (s: string) => createHash('sha256').update(s).digest('hex')
const phase16a8 = process.argv.includes('--phase-16a8')
const operational = process.argv.includes('--operational')
const archiveRoot = process.env.LARGE_HOLDER_EVIDENCE_DIR
  ?? join(homedir(), 'Library', 'Application Support', 'StockBoard', 'large-holder-evidence', 'phase-16a8')
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const reuseManifest = process.argv.find((arg) => arg.startsWith('--reuse-edinet-manifest='))?.slice(24)
const previouslyCaptured = new Map<string, RawEvidence>()
const previouslyReferenced = new Map<string, RawEvidence>()
const asOf = process.argv.find((arg) => arg.startsWith('--as-of='))?.slice(8)
  ?? str(one('SELECT MAX(price_date) AS d FROM large_holder_price_evidence')?.d)
if (!/^\d{4}-\d{2}-\d{2}$/.test(asOf)) throw new Error('Invalid as-of')
const certificationDate = process.argv.find((arg) => arg.startsWith('--certified-on='))?.slice(15)
  ?? new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Tokyo' })
const blockedTickers = blockedTickerSet(readQuarantineScopes(db as never, certificationDate))
const marketDate = str(one('SELECT MAX(date) AS d FROM ohlcv_daily')?.d)
const rows = all(`SELECT p.*,f.issuer_edinet_code,f.issuer_security_code,f.issuer_name,
  f.submitted_at,f.obligation_date AS filing_obligation_date,f.raw_index_json,
  s.xbrl_sha256,s.xbrl_xml FROM large_holder_positions p
  JOIN large_holder_filings f USING(document_id)
  JOIN large_holder_source_documents s USING(document_id)
  WHERE p.market_price_status IN ('FULL_DIRECT','PARTIAL_DIRECT') ORDER BY p.document_id,p.holder_key`)
if (!operational && rows.length !== 233) throw new Error(`Research population changed: ${rows.length}`)
if (operational && rows.length < 20) throw new Error('Operational research population unexpectedly small')
const revisions = resolveRevisionChains(all(`SELECT f.document_id,f.filing_type,f.submitted_at,
  f.obligation_date,f.corrected_document_id,f.previous_filing_id,f.issuer_edinet_code,
  f.issuer_security_code,f.withdrawn_at,f.status,f.report_serial_number,f.submission_count,
  s.xbrl_sha256 FROM large_holder_filings f LEFT JOIN large_holder_source_documents s USING(document_id)
  WHERE f.status IN ('ready','withdrawn') AND substr(f.submitted_at,1,10)<=?`, certificationDate)
  .map((row): RevisionFiling => ({ documentId: str(row.document_id), filingType: str(row.filing_type),
    submittedAt: str(row.submitted_at), obligationDate: nullable(row.obligation_date),
    correctsFilingId: nullable(row.corrected_document_id), previousFilingId: nullable(row.previous_filing_id),
    issuerEdinetCode: nullable(row.issuer_edinet_code), issuerSecurityCode: nullable(row.issuer_security_code),
    withdrawnAt: nullable(row.withdrawn_at), status: str(row.status), sourceSha256: nullable(row.xbrl_sha256),
    reportSerialNumber: num(row.report_serial_number), submissionCount: num(row.submission_count) })), certificationDate)
const effective = new Set(revisions.filter((row) => row.isEffectiveRevision).map((row) => row.documentId))
const latest = new Map<string, Row>()
const positions = all(`SELECT p.document_id,p.holder_key,p.ticker,p.entity_id,p.reported_shares,
  p.reported_holding_pct,f.submitted_at,f.obligation_date,f.issuer_edinet_code,
  f.filer_edinet_code,f.report_serial_number,s.xbrl_sha256
  FROM large_holder_positions p JOIN large_holder_filings f USING(document_id)
  LEFT JOIN large_holder_source_documents s USING(document_id)`)
  .filter((row) => effective.has(str(row.document_id)) && !blockedTickers.has(str(row.ticker)))
positions.sort((a, b) => str(b.obligation_date ?? b.submitted_at).localeCompare(str(a.obligation_date ?? a.submitted_at))
  || str(b.submitted_at).localeCompare(str(a.submitted_at))
  || str(b.document_id).localeCompare(str(a.document_id)))
for (const position of positions) {
  const key = `${phase16a8 ? currentPositionEntityId(position) : position.entity_id}:${position.ticker}`
  if (!latest.has(key)) latest.set(key, position)
}
const latestKeys = new Set([...latest.values()].map((row) => `${row.document_id}:${row.holder_key}`))
const instrument = new Map<string, OfficialInstrument>()
const instrumentHistory = new Map<string, { date: string; code: string; product: string;
  status: string }[]>()
for (const row of all(`SELECT jpx_short_code,official_security_code_raw,source_as_of,
  security_class,listing_status FROM large_holder_instrument_master`)) {
  const code = str(row.jpx_short_code)
  if (!code) continue
  instrumentHistory.set(code, [...(instrumentHistory.get(code) ?? []), {
    date: str(row.source_as_of), code: str(row.official_security_code_raw),
    product: str(row.security_class), status: str(row.listing_status),
  }])
}
for (const row of all('SELECT * FROM large_holder_instrument_master WHERE source_as_of=?', asOf)) {
  instrument.set(str(row.official_security_code_raw), {
    instrumentId: str(row.instrument_id), issuerEdinetCode: nullable(row.issuer_edinet_code),
    issuerName: str(row.issuer_name), officialSecurityCode: str(row.official_security_code),
    officialSecurityCodeRaw: str(row.official_security_code_raw), jpxShortCode: nullable(row.jpx_short_code),
    isin: nullable(row.isin), instrumentName: str(row.instrument_name),
    instrumentType: str(row.instrument_type) as OfficialInstrument['instrumentType'],
    securityClass: str(row.security_class), quantityUnit: str(row.quantity_unit) as OfficialInstrument['quantityUnit'],
    priceUnit: str(row.price_unit) as OfficialInstrument['priceUnit'], market: str(row.market),
    listingStatus: str(row.listing_status) as OfficialInstrument['listingStatus'],
    listedFrom: nullable(row.listed_from), listedTo: nullable(row.listed_to),
    priceSeriesId: nullable(row.price_series_id), sourceAuthority: str(row.source_authority),
    sourceUrlOrReference: str(row.source_url_or_reference), sourceAsOf: str(row.source_as_of),
    sourceEvidence: str(row.source_evidence), sourceHash: str(row.source_hash),
    mappingStatus: str(row.mapping_status) as OfficialInstrument['mappingStatus'],
    mappingConfidence: str(row.mapping_confidence) as OfficialInstrument['mappingConfidence'],
  })
}
const prices = new Map<string, OfficialPrice>()
for (const row of all('SELECT * FROM large_holder_price_evidence WHERE price_date=?', asOf)) {
  prices.set(str(row.official_security_code_raw), {
    officialSecurityCodeRaw: str(row.official_security_code_raw), date: str(row.price_date),
    rawClose: num(row.raw_close), adjustedClose: num(row.adjusted_close), localClose: num(row.local_close),
    sourceAuthority: str(row.source_authority), sourceUrlOrReference: str(row.source_url_or_reference),
    sourceEvidence: str(row.source_evidence), sourceHash: str(row.source_hash),
  })
}
const structures = new Map<string, IssuerCapitalStructure>()
for (const row of all('SELECT * FROM large_holder_issuer_capital_structure')) {
  const structure: IssuerCapitalStructure = {
    issuerEdinetCode: str(row.issuer_edinet_code), sourceDocumentId: str(row.source_document_id),
    sourceSubmittedAt: str(row.source_submitted_at), reportingDate: str(row.reporting_date),
    sourceUrl: str(row.source_url), sourceEvidence: str(row.source_evidence), sourceHash: str(row.source_hash),
    classes: JSON.parse(str(row.classes_json)), tableComplete: Number(row.table_complete) === 1,
  }
  if (verifyCapitalStructureSource(structure, structure.issuerEdinetCode))
    structures.set(structure.issuerEdinetCode, structure)
}

async function officialRows(url: string): Promise<{ rows: Record<string, unknown>[];
  rawByCode: Map<string, RawEvidence> }> {
  const key = process.env.JQUANTS_API_KEY
  if (!key) throw new Error('JQUANTS_API_KEY required: full official snapshot must not be inferred from local subset')
  const result: Record<string, unknown>[] = []
  const rawByCode = new Map<string, RawEvidence>()
  const seen = new Set<string>()
  let page: string | undefined
  do {
    const query = new URLSearchParams({ date: asOf })
    if (page) query.set('pagination_key', page)
    let raw: string | null = null
    for (let attempt = 0; attempt < 3 && raw == null; attempt++) {
      try {
        const response = await fetch(`${url}?${query}`, { headers: { 'x-api-key': key },
          signal: AbortSignal.timeout(30_000) })
        if (!response.ok) {
          if (response.status < 500 && response.status !== 429)
            throw new Error(`J-Quants ${response.status} at ${url}`)
          throw new Error(`J-Quants transient ${response.status} at ${url}`)
        }
        raw = await response.text()
      } catch (error) {
        if (attempt === 2 || (error instanceof Error && /^J-Quants 4(?!29)/.test(error.message)))
          throw error
        await pause(1_500 * (attempt + 1))
      }
    }
    if (raw == null) throw new Error('J-Quants response unavailable')
    const body = JSON.parse(raw) as { data?: Record<string, unknown>[]; pagination_key?: string }
    if (!Array.isArray(body.data)) throw new Error('Official data missing')
    if (phase16a8) {
      const source = await archiveOfficialRaw(archiveRoot, 'JQUANTS', `${url}?${query}`,
        Buffer.from(raw), 'json')
      for (const row of body.data) rawByCode.set(str(row.Code), source)
      await pause(350)
    }
    result.push(...body.data)
    page = body.pagination_key
    if (page && seen.has(page)) throw new Error('Repeated official pagination key')
    if (page) seen.add(page)
  } while (page)
  return { rows: result, rawByCode }
}

async function officialReference(url: string, authority: 'FSA' | 'JPX', extension: 'html' | 'pdf') {
  const prior = previouslyReferenced.get(url)
  if (prior) {
    const bytes = new Uint8Array(await readFile(prior.archivePath))
    if (prior.authority !== authority || sha256(bytes) !== prior.sha256
      || bytes.byteLength !== prior.byteLength) throw new Error(`official_reference_archive_mismatch:${url}`)
    return { evidence: prior, text: extension === 'html' ? new TextDecoder().decode(bytes) : '' }
  }
  const response = await fetch(url, { signal: AbortSignal.timeout(30_000) })
  if (!response.ok) throw new Error(`official_reference_http_${response.status}:${url}`)
  const length = Number(response.headers.get('content-length') ?? 0)
  if (length > 8 * 1024 * 1024) throw new Error(`official_reference_too_large:${url}`)
  const bytes = new Uint8Array(await response.arrayBuffer())
  if (bytes.byteLength > 8 * 1024 * 1024) throw new Error(`official_reference_too_large:${url}`)
  const evidence = await archiveOfficialRaw(archiveRoot, authority, url, bytes, extension)
  await pause(500)
  return { evidence, text: extension === 'html' ? new TextDecoder().decode(bytes) : '' }
}

async function officialEdinetArchive(documentId: string): Promise<{ raw: RawEvidence; xml: string }> {
  const prior = previouslyCaptured.get(documentId)
  if (prior) {
    const bytes = new Uint8Array(await readFile(prior.archivePath))
    if (sha256(bytes) !== prior.sha256 || bytes.byteLength !== prior.byteLength)
      throw new Error(`EDINET ${documentId}: prior archive mismatch`)
    return { raw: prior, xml: extractEdinetXml(bytes, documentId) }
  }
  const bytes = await downloadEdinetPublicArchiveBytes(documentId)
  const raw = await archiveOfficialRaw(archiveRoot, 'EDINET',
    `https://api.edinet-fsa.go.jp/api/v2/documents/${documentId}?type=1`, bytes, 'zip')
  await pause(500)
  return { raw, xml: extractEdinetXml(bytes, documentId) }
}

function extractEdinetXml(bytes: Uint8Array, documentId: string): string {
  const files = unzipSync(bytes, { filter: (file) => /XBRL\/PublicDoc\/.*\.xbrl$/i.test(file.name) })
  const xbrl = Object.entries(files).filter(([name]) => /XBRL\/PublicDoc\/.*\.xbrl$/i.test(name))
    .sort((left, right) => right[1].byteLength - left[1].byteLength)[0]
  if (!xbrl) throw new Error(`EDINET ${documentId}: PublicDoc XBRL missing`)
  return new TextDecoder('utf-8').decode(xbrl[1])
}

const reitSources: Record<string, { issuerName: string; listedFrom: string; isin: string }> = {
  // Curated from the JPX listed REIT issues, with separate issuer statutory verification below.
  '3290': { issuerName: 'Ｏｎｅリート投資法人', listedFrom: '2013-10-09', isin: 'JP3047640002' },
  '8968': { issuerName: '福岡リート投資法人', listedFrom: '2005-06-21', isin: 'JP3046240002' },
}
function supplemental(xml: string, holderKey: string) {
  const facts = new XbrlFactReader(xml).facts.filter((fact) => fact.context?.dimensions
    .some((dimension) => dimension.dimension.includes('FilersLargeVolumeHoldersAndJointHoldersAxis')
      && dimension.member === holderKey))
  const issued = facts.find((fact) => fact.localName === 'TotalNumberOfOutstandingStocksEtc'
    && !fact.isNil && fact.numericValue != null)
  const block = facts.find((fact) => fact.localName ===
    'DetailsOfAcquisitionsAndDisposalsOfStocksEtcIssuedByIssuerOfSaidStocksEtcDuringLast60DaysTextBlock'
    && !fact.isNil)?.textValue ?? ''
  const types = recentTransactionTypesFromText(block)
  return { issuedTotal: issued ? { value: issued.numericValue!, unit: issued.unit?.label ?? '',
    concept: issued.qname, context: issued.contextRef } : null, recentTransactionTypes: types }
}

async function main() {
  if (reuseManifest) {
    if (!phase16a8) throw new Error('archive reuse requires --phase-16a8')
    const prior = JSON.parse(await readFile(reuseManifest, 'utf8')) as {
      asOf: string; edinetSources?: (RawEvidence & { documentId: string })[];
      rawSources?: RawEvidence[] }
    if (prior.asOf !== asOf && (!operational || prior.asOf > asOf))
      throw new Error('prior_manifest_scope_mismatch')
    for (const source of prior.rawSources ?? []) {
      if (source.authority === 'FSA' || source.authority === 'JPX')
        previouslyReferenced.set(source.reference, source)
    }
    const edinetSources = prior.edinetSources ?? (prior.rawSources ?? [])
      .filter((source) => source.authority === 'EDINET')
      .map((source) => ({ ...source,
        documentId: source.reference.match(/\/documents\/([^?]+)\?type=1$/)?.[1] ?? '' }))
    for (const item of edinetSources) {
      const raw = prior.rawSources?.find((source) => source.authority === 'EDINET'
        && source.reference.includes(`/documents/${item.documentId}?`)) ?? item
      if (raw.authority !== 'EDINET'
        || raw.reference !== `https://api.edinet-fsa.go.jp/api/v2/documents/${item.documentId}?type=1`
        || !/^[a-f0-9]{64}$/.test(raw.sha256))
        throw new Error(`prior_manifest_edinet_invalid:${item.documentId}`)
      previouslyCaptured.set(item.documentId, raw)
    }
    if (previouslyCaptured.size === 0) throw new Error('prior_manifest_has_no_edinet_sources')
  }
  const [masterResponse, barsResponse] = phase16a8
    ? [await officialRows('https://api.jquants.com/v2/equities/master'),
      await officialRows('https://api.jquants.com/v2/equities/bars/daily')]
    : await Promise.all([officialRows('https://api.jquants.com/v2/equities/master'),
      officialRows('https://api.jquants.com/v2/equities/bars/daily')])
  const master = masterResponse.rows, bars = barsResponse.rows
  const officialReferences = new Map<string, RawEvidence>()
  if (phase16a8) {
    for (const [url, authority, extension] of [
      ['https://www.fsa.go.jp/common/shinsei/tairyohoyu/summary/index.html', 'FSA', 'html'],
      ['https://www.fsa.go.jp/news/21/sonota/20100331-12/03.pdf', 'FSA', 'pdf'],
      ['https://www.jpx.co.jp/equities/products/reits/issues/', 'JPX', 'html'],
      ['https://www.jpx.co.jp/equities/products/preferred-stocks/issues/tvdivq0000007usm-att/25935g.pdf', 'JPX', 'pdf'],
      ['https://www2.jpx.co.jp/disc/94340/140120230925557770.pdf', 'JPX', 'pdf'],
    ] as const) {
      const { evidence, text } = await officialReference(url, authority, extension)
      if (authority === 'FSA' && extension === 'html'
        && (!text.includes('議決権のない株式に係るものを除く') || !text.includes('投資証券等')))
        throw new Error('FSA regulatory scope raw anchor missing')
      if (authority === 'JPX' && extension === 'html'
        && (!text.includes('3290') || !text.includes('JP3047640002')
          || !text.includes('8968') || !text.includes('JP3046240002')))
        throw new Error('JPX REIT raw anchor missing')
      officialReferences.set(url, evidence)
    }
  }
  const snapshot = createOfficialMarketSnapshot(master as MarketRow[], asOf)
  const officialBars = new Map(bars.map((bar) => [str(bar.Code), bar]))
  const counts: Record<RegulatoryCurrentClassification, number> = {
    FILING_EXPLICIT_CLASS: 0, FILING_CODE_REGULATORY_UNIQUE: 0,
    CROSS_DOCUMENT_REGULATORY_UNIQUE: 0, MULTIPLE_ELIGIBLE_CLASSES: 0,
    UNKNOWN_REGULATORY_SCOPE: 0, CODE_AMBIGUOUS: 0, REIT_UNRESOLVED: 0, STALE_PRICE: 0, OTHER: 0,
  }
  const parsed = new Map<string, LargeHolderFiling>()
  const ready = new Set<string>()
  const positive: { documentId: string; holderKey: string; ticker: string; quantity: number;
    price: number; value: number; classification: string }[] = []
  const negative: { ticker: string; classification: string; reason: string }[] = []
  let mismatches = 0
  let superseded = 0
  let commonReady = 0
  let reitReady = 0
  let explicitCount = 0
  let independentChecks = 0
  let transitionConflicts = 0
  const officialArchives = new Map<string, { raw: RawEvidence; xml: string }>()
  const lineages: { positionKey: string; entityId: string; ticker: string;
    decision: unknown; decisionSha256: string; classification: string;
    value: number; facts: ReturnType<typeof derivedFact>[]; investorCategory: string }[] = []
  const investorEvidence = new Map<string, Set<string>>()
  const allCurrentInvestorEvidence = new Map<string, Set<string>>()
  const classificationLineages: { positionKey: string; decision: unknown;
    decisionSha256: string; facts: ReturnType<typeof derivedFact>[] }[] = []
  let rawMismatches = 0
  const fullMaster = new Map(master.map((m) => [str(m.Code), m]))
  for (const row of rows) {
    const doc = str(row.document_id), holderKey = str(row.holder_key), code = str(row.issuer_security_code)
    const isLatest = latestKeys.has(`${doc}:${holderKey}`)
    if (!isLatest) { superseded++; continue }
    let filing = parsed.get(doc)
    if (!filing) {
      const xml = str(row.xbrl_xml)
      if (hash(xml) !== row.xbrl_sha256) mismatches++
      filing = parseLargeHolderFiling(JSON.parse(str(row.raw_index_json)) as EdinetDocumentIndexRow, xml)
      parsed.set(doc, filing)
    }
    let archived: { raw: RawEvidence; xml: string } | undefined
    if (phase16a8) {
      archived = officialArchives.get(doc)
      if (!archived) {
        archived = await officialEdinetArchive(doc)
        officialArchives.set(doc, archived)
      }
      if (sha256(archived.xml) !== row.xbrl_sha256 || archived.xml !== row.xbrl_xml)
        rawMismatches++
    }
    const holder = filing.holders.find((candidate) => candidate.key === holderKey)
    if (!holder || filing.issuerEdinetCode !== row.issuer_edinet_code
      || filing.issuerSecurityCode !== row.issuer_security_code) { mismatches++; continue }
    const direct = holder.securityBreakdown.filter((part) => part.kind === 'DIRECT_SECURITY' && part.quantity > 0)
    const storedBreakdown = JSON.parse(str(row.security_breakdown_json))
    if (JSON.stringify(storedBreakdown) !== JSON.stringify(holder.securityBreakdown)) mismatches++
    const current = instrument.get(`${code}0`) ?? null
    const price = current ? prices.get(current.officialSecurityCodeRaw) ?? null : null
    const aux = supplemental(str(row.xbrl_xml), holderKey)
    const reit = reitSources[code]
    const reitEvidence = reit ? { code, ...reit } : null
    const conflict = (instrumentHistory.get(code) ?? []).some((item) =>
      item.date >= str(row.filing_obligation_date) && item.date <= str(row.submitted_at).slice(0, 10)
      && (item.status !== 'LISTED' || item.code !== `${code}0`
        || item.product !== (reit ? '013' : '011')))
    if (conflict) transitionConflicts++
    const valuation = certifyPositionByMode({ certificationMode: 'REGULATORY_CURRENT', current: {
      documentId: doc, issuerEdinetCode: nullable(row.issuer_edinet_code),
      issuerEvidence: filing.issuerEvidence, obligationDate: str(row.filing_obligation_date),
      certificationDate, valuationAsOf: asOf, latestMarketDate: marketDate,
      latestEffectivePosition: isLatest, researchStatus: str(row.market_price_status),
      directUnits: num(row.market_price_eligible_units),
      directComponentTotal: direct.reduce((sum, item) => sum + item.quantity, 0),
      directComponentCount: direct.length,
      directUnit: direct.length && direct.every((item) => item.unit === direct[0].unit) ? direct[0].unit : null,
      directConcept: direct.length && direct.every((item) => item.concept.includes('StocksOrInvestmentSecuritiesEtcArticle27233'))
        ? direct[0].concept : null,
      holdingNote: holder.holdingNote, ...aux, marketSnapshot: snapshot, currentInstrument: current,
      currentPrice: price, issuerCapitalStructure: structures.get(str(row.issuer_edinet_code)) ?? null,
      jpxReitEvidence: reitEvidence ? { ...reitEvidence,
        sourceReference: 'https://www.jpx.co.jp/equities/products/reits/issues/',
        sourceEvidence: JSON.stringify(reitEvidence), sourceHash: evidenceHash(reitEvidence) } : null,
      transitionConflict: conflict,
    } })
    counts[valuation.classification]++
    if (valuation.strength === 'A') explicitCount++
    if (!valuation.publicCurrentValuationReady) {
      if (negative.length < 20) negative.push({ ticker: str(row.ticker),
        classification: valuation.classification, reason: valuation.reason })
      continue
    }
    ready.add(`${doc}:${holderKey}`)
    if (valuation.quantityUnit === 'UNIT') reitReady++
    else commonReady++
    if (!phase16a8 && positive.length >= 50 && valuation.quantityUnit !== 'UNIT') continue
    const raw = phase16a8 ? archived!.xml : await downloadEdinetPublicXbrl(doc)
    const source = parseLargeHolderFiling(JSON.parse(str(row.raw_index_json)) as EdinetDocumentIndexRow, raw)
    const rawHolder = source.holders.find((item) => item.key === holderKey)
    const masterRow = fullMaster.get(current!.officialSecurityCodeRaw)
    const bar = officialBars.get(current!.officialSecurityCodeRaw)
    const amount = valuation.directEligibleUnits! * valuation.latestFreshUnadjustedPrice!
    independentChecks++
    if (hash(raw) !== row.xbrl_sha256 || source.issuerSecurityCode !== code
      || source.issuerExchange !== filing.issuerExchange || !rawHolder
      || JSON.stringify(rawHolder.securityBreakdown) !== JSON.stringify(holder.securityBreakdown)
      || evidenceHash(masterRow) !== current!.sourceHash || evidenceHash(bar) !== price!.sourceHash
      || Number(bar?.C) !== valuation.latestFreshUnadjustedPrice
      || amount !== valuation.estimatedCurrentMarketValue) mismatches++
    if (phase16a8) {
      const masterRaw = masterResponse.rawByCode.get(current!.officialSecurityCodeRaw)
      const barRaw = barsResponse.rawByCode.get(current!.officialSecurityCodeRaw)
      const scopeRaw = officialReferences.get('https://www.fsa.go.jp/common/shinsei/tairyohoyu/summary/index.html')
      const reitRaw = officialReferences.get('https://www.jpx.co.jp/equities/products/reits/issues/')
      if (!masterRaw || !barRaw || !scopeRaw || (valuation.quantityUnit === 'UNIT' && !reitRaw))
        throw new Error(`official_raw_lineage_missing:${doc}:${holderKey}`)
      const facts = [
        derivedFact('FILING_ISSUER_AND_HOLDER', `EDINET:${doc}#${holderKey}`,
          { issuerCode: source.issuerSecurityCode, issuerEdinetCode: source.issuerEdinetCode,
            obligationDate: source.obligationDate, holderRole: rawHolder!.role,
            direct: rawHolder!.securityBreakdown }, archived!.raw),
        derivedFact('LISTED_INSTRUMENT', `JQUANTS:${asOf}:${current!.officialSecurityCodeRaw}`,
          masterRow, masterRaw),
        derivedFact('UNADJUSTED_PRICE', `JQUANTS:${asOf}:${current!.officialSecurityCodeRaw}`,
          bar, barRaw),
        derivedFact('REGULATORY_SCOPE', scopeRaw.reference,
          valuation.classScopes.map(({ code: c, scope }) => ({ code: c, scope: scope.reportingScopeStatus })),
          scopeRaw),
      ]
      if (valuation.quantityUnit === 'UNIT') facts.push(derivedFact('JPX_REIT_LIST',
        `${reitRaw!.reference}#${code}`, reitSources[code], reitRaw!))
      const investor = classifyFromFiling(rawHolder!.personOrCorporation,
        rawHolder!.businessDescription, rawHolder!.address)
      facts.push(derivedFact('INVESTOR_CLASS', `EDINET:${doc}#${holderKey}:classification`,
        { category: investor.category, source: investor.source, evidence: investor.evidence }, archived!.raw))
      const entityClasses = investorEvidence.get(str(row.entity_id)) ?? new Set<string>()
      entityClasses.add(investor.category)
      investorEvidence.set(str(row.entity_id), entityClasses)
      const positionKey = `${doc}:${holderKey}`
      const decision = { classification: valuation.classification,
        quantity: valuation.directEligibleUnits, price: valuation.latestFreshUnadjustedPrice,
        amount: valuation.estimatedCurrentMarketValue }
      lineages.push({ positionKey, entityId: str(row.entity_id), ticker: str(row.ticker),
        decision, decisionSha256: decisionHash(positionKey, decision, facts),
        classification: valuation.classification, value: amount, facts,
        investorCategory: investor.category })
    }
    positive.push({ documentId: doc, holderKey, ticker: str(row.ticker),
      quantity: valuation.directEligibleUnits!, price: valuation.latestFreshUnadjustedPrice!,
      value: amount, classification: valuation.classification })
  }
  if (phase16a8) {
    const documentIds = [...new Set([...latest.values()].map((row) => str(row.document_id)))]
    const currentSources = new Map(all(`SELECT f.document_id,f.raw_index_json,s.xbrl_sha256,s.xbrl_xml
      FROM large_holder_filings f JOIN large_holder_source_documents s USING(document_id)
      WHERE f.document_id IN (${documentIds.map(() => '?').join(',')})`, ...documentIds)
      .map((row) => [str(row.document_id), row]))
    for (const position of latest.values()) {
      const doc = str(position.document_id), holderKey = str(position.holder_key)
      const stored = currentSources.get(doc)
      if (!stored) { rawMismatches++; continue }
      let archived = officialArchives.get(doc)
      if (!archived) {
        archived = await officialEdinetArchive(doc)
        officialArchives.set(doc, archived)
      }
      if (sha256(archived.xml) !== stored.xbrl_sha256 || archived.xml !== stored.xbrl_xml) {
        rawMismatches++
        continue
      }
      const indexRow = JSON.parse(str(stored.raw_index_json)) as EdinetDocumentIndexRow
      const filing = parseLargeHolderFiling(indexRow, archived.xml)
      const holder = filing.holders.find((item) => item.key === holderKey)
      if (!holder) { rawMismatches++; continue }
      const investor = classifyFromFiling(holder.personOrCorporation,
        holder.businessDescription, holder.address)
      const entityId = str(position.entity_id)
      const classes = allCurrentInvestorEvidence.get(entityId) ?? new Set<string>()
      classes.add(investor.category)
      allCurrentInvestorEvidence.set(entityId, classes)
      const positionKey = `INVESTOR:${doc}:${holderKey}`
      const decision = { category: investor.category, investorClass: investor.investorClass,
        confidence: investor.confidence }
      const facts = [derivedFact('INVESTOR_CLASS', `EDINET:${doc}#${holderKey}:classification`,
        { description: holder.personOrCorporation, business: holder.businessDescription,
          addressSha256: holder.address ? sha256(holder.address) : null }, archived.raw)]
      classificationLineages.push({ positionKey, decision,
        decisionSha256: decisionHash(positionKey, decision, facts), facts })
    }
  }
  const portfolios = new Map<string, { total: number; ready: number }>()
  for (const row of latest.values()) {
    const key = str(row.entity_id), current = portfolios.get(key) ?? { total: 0, ready: 0 }
    current.total++
    if (ready.has(`${row.document_id}:${row.holder_key}`)) current.ready++
    portfolios.set(key, current)
  }
  const completeness = { COMPLETE: 0, PARTIAL: 0, NONE: 0 }
  for (const row of portfolios.values()) completeness[row.ready === 0 ? 'NONE'
    : row.ready === row.total ? 'COMPLETE' : 'PARTIAL']++
  const investorClasses = { individual: 0, institutional: 0, operatingCompany: 0, unclassified: 0,
    conflicting: 0 }
  const storedClasses = new Map(all('SELECT entity_id,investor_class FROM investor_entities')
    .map((row) => [str(row.entity_id), str(row.investor_class)]))
  let classificationContradictions = 0
  if (phase16a8) for (const categories of investorEvidence.values()) {
    if (categories.size !== 1) { investorClasses.conflicting++; continue }
    const category = [...categories][0]
    if (category === 'INDIVIDUAL') investorClasses.individual++
    else if (category === 'OPERATING_COMPANY') investorClasses.operatingCompany++
    else if (category === 'UNCLASSIFIED') investorClasses.unclassified++
    else investorClasses.institutional++
  }
  const allCurrentInvestorClasses = { individual: 0, institutional: 0,
    operatingCompany: 0, unclassified: 0, conflicting: 0 }
  if (phase16a8) for (const [entityId, categories] of allCurrentInvestorEvidence) {
    if (categories.size !== 1) { allCurrentInvestorClasses.conflicting++; continue }
    const category = [...categories][0]
    if (category === 'INDIVIDUAL') allCurrentInvestorClasses.individual++
    else if (category === 'OPERATING_COMPANY') allCurrentInvestorClasses.operatingCompany++
    else if (category === 'UNCLASSIFIED') allCurrentInvestorClasses.unclassified++
    else allCurrentInvestorClasses.institutional++
    const storedClass = storedClasses.get(entityId)
    if (storedClass && storedClass !== 'UNCLASSIFIED'
      && storedClass !== classForCategory([...categories][0] as InvestorCategory))
      classificationContradictions++
  }
  const lineageKeys = new Set(lineages.map((item) => item.positionKey))
  const entityTickerKeys = new Set(lineages.map((item) => `${item.entityId}:${item.ticker}`))
  const jointHolderDoubleCount = lineages.length - entityTickerKeys.size
  const jqSources = [...new Map([...masterResponse.rawByCode.values(),
    ...barsResponse.rawByCode.values()].map((source) => [source.sha256, source])).values()]
  const edinetSources = [...officialArchives.values()].map(({ raw }) => raw)
  const allRawSources = [...officialReferences.values(), ...jqSources, ...edinetSources]
  const archiveVerified = phase16a8
    ? await verifyArchivedLineage(allRawSources, [...lineages, ...classificationLineages]) : false
  const phase16a8Gate = phase16a8 && archiveVerified && rawMismatches === 0 && mismatches === 0
    && lineages.length === ready.size && lineageKeys.size === ready.size
    && jointHolderDoubleCount === 0
    && investorClasses.conflicting === 0 && allCurrentInvestorClasses.conflicting === 0
    && allCurrentInvestorEvidence.size === portfolios.size
    && classificationContradictions === 0 && ready.size >= 20
    && revisions.every((item) => !item.unresolvedReason) && transitionConflicts === 0
  let manifestPath: string | null = null
  if (phase16a8) {
    const manifest = JSON.stringify({ phase: '16A-8', asOf, certificationDate,
      rawSources: allRawSources,
      lineages, classificationLineages }, null, 2)
    const directory = join(archiveRoot, 'manifests')
    await mkdir(directory, { recursive: true, mode: 0o700 })
    manifestPath = join(directory, `${sha256(manifest)}.json`)
    try { await writeFile(manifestPath, manifest, { flag: 'wx', mode: 0o600 }) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST'
        || await readFile(manifestPath, 'utf8') !== manifest) throw error
    }
  }
  const result = { phase: phase16a8 ? '16A-8' : '16A-7', readOnlyDb: true,
    asOf, marketDate, certificationDate,
    researchCandidates: rows.length, currentCandidates: rows.length - superseded, superseded,
    counts, ready: ready.size, commonReady, reitReady, explicitCount,
    eligibleClassSnapshotRows: snapshot.rows.length, eligibleClassSnapshotHash: snapshot.sourceHash,
    completeness, positiveValidations: independentChecks, mismatches,
    positive: phase16a8 ? positive.slice(0, 5) : positive, negative,
    correctionUnresolved: revisions.filter((item) => item.unresolvedReason).length,
    transitionConflicts,
    investorClasses: all(`SELECT investor_class,COUNT(*) AS n FROM investor_entities
      WHERE entity_id IN (SELECT DISTINCT entity_id FROM large_holder_positions) GROUP BY investor_class`),
    phase16a8: phase16a8 ? { rawArchiveRoot: archiveRoot, manifestPath,
      rawOfficialReferences: officialReferences.size, rawJquantsPages: jqSources.length,
      rawEdinetDocuments: officialArchives.size, archiveVerified,
      rawMismatches, lineagePositions: lineages.length, candidateEntities: investorEvidence.size,
      investorClasses, allCurrentEntities: allCurrentInvestorEvidence.size,
      allCurrentInvestorClasses, classificationLineages: classificationLineages.length,
      classificationContradictions, jointHolderDoubleCount,
      publicCurrentValuationReady: phase16a8Gate ? ready.size : 0,
      dataGate: phase16a8Gate ? 'GO' : 'NO_GO' } : null,
    elapsedMs: Date.now() - started, maxRssBytes: process.resourceUsage().maxRSS * 1024,
    rssBytesAtReport: process.memoryUsage().rss, dbWrites: 0, deploy: false }
  console.log(JSON.stringify(result, null, 2))
  if (mismatches || independentChecks < 20 || (!operational && superseded !== (phase16a8 ? 55 : 54))
    || (phase16a8 && !phase16a8Gate)) process.exitCode = 1
}

main().catch((error) => { console.error(error); process.exitCode = 1 })
  .finally(() => db.close())
