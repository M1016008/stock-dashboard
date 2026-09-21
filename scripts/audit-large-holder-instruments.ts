// Research-only: official instrument/quote evidence. Never called by the web server.
import ExcelJS from 'exceljs'
import { client, ensureReady } from '@/lib/db/client'
import { XbrlFactReader } from '@/lib/edinet-xbrl-facts'
import { classifyOfficialInstrument, certifyPosition, evidenceHash, normalizedIssuerName,
  type OfficialInstrument, type OfficialPrice } from '@/lib/large-holders/instrument-certification'
import type { EdinetCodeBridge, IssuerCapitalStructure } from '@/lib/large-holders/cross-document-evidence'
import { latestDisclosedPositions } from '@/lib/server/large-holders/latest-positions'

const MASTER_URL = 'https://api.jquants.com/v2/equities/master'
const BARS_URL = 'https://api.jquants.com/v2/equities/bars/daily'
const JPX_LIST_URL = 'https://www.jpx.co.jp/markets/statistics-equities/misc/tvdivq0000001vg2-att/data_j.xlsx'
const reassessOnly = process.argv.includes('--reassess-only')
const flag = process.argv.slice(2).find((value) => value.startsWith('--as-of='))
const asOf = flag?.slice('--as-of='.length)
const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Tokyo' })
if (!asOf || !/^\d{4}-\d{2}-\d{2}$/.test(asOf) || asOf > today) {
  throw new Error('Usage: --as-of=YYYY-MM-DD (no future date)')
}
const apiKey = process.env.JQUANTS_API_KEY
if (!apiKey && !reassessOnly) throw new Error('JQUANTS_API_KEY is required')

type MasterRow = { Date: string; Code: string; CoName: string; MktNm: string; ProdCat: string }
type BarRow = { Date: string; Code: string; C: number | null; AdjC: number | null }
type CandidateRow = Record<string, unknown>

async function officialRows<T>(baseUrl: string, date: string): Promise<T[]> {
  const rows: T[] = []
  let page: string | undefined
  do {
    const params = new URLSearchParams({ date })
    if (page) params.set('pagination_key', page)
    let payload: { data?: T[]; pagination_key?: string } | null = null
    for (let attempt = 0; attempt < 5 && !payload; attempt++) {
      try {
        const response = await fetch(`${baseUrl}?${params}`, {
          headers: { 'x-api-key': apiKey! }, signal: AbortSignal.timeout(30_000),
        })
        if (!response.ok) throw new Error(`Official API ${response.status}: ${baseUrl} ${date}`)
        payload = await response.json() as { data?: T[]; pagination_key?: string }
      } catch (error) {
        if (attempt === 4) throw error
        await new Promise((resolve) => setTimeout(resolve, 750 * 2 ** attempt))
      }
    }
    if (!payload) throw new Error(`Official API returned no payload: ${date}`)
    rows.push(...(payload.data ?? []))
    page = payload.pagination_key
  } while (page)
  return rows
}

async function jpxAugustList(): Promise<Map<string, { name: string; category: string }>> {
  const response = await fetch(JPX_LIST_URL)
  if (!response.ok) throw new Error(`JPX listed issues ${response.status}`)
  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.load(await response.arrayBuffer() as never)
  const sheet = workbook.worksheets[0]
  if (!sheet || String(sheet.getRow(1).getCell(2).value) !== 'コード') throw new Error('JPX sheet structure changed')
  const result = new Map<string, { name: string; category: string }>()
  for (let index = 2; index <= sheet.rowCount; index++) {
    const row = sheet.getRow(index)
    const code = String(row.getCell(2).value ?? '')
    if (!code) continue
    result.set(code, { name: String(row.getCell(3).value ?? ''),
      category: String(row.getCell(4).value ?? '') })
  }
  return result
}

function officialInstrument(row: MasterRow, issuer: CandidateRow, peerCodes: string[],
  jpx: Map<string, { name: string; category: string }>): OfficialInstrument {
  const code = String(row.Code)
  const shortCode = /^[0-9A-Z]{4}0$/.test(code) ? code.slice(0, 4) : null
  const august = shortCode ? jpx.get(shortCode) : null
  const category = classifyOfficialInstrument(String(row.ProdCat), code)
  const issuerCode = issuer.issuer_security_code == null ? null : String(issuer.issuer_security_code)
  const issuerName = String(issuer.issuer_name ?? '')
  const exact = Boolean(shortCode && issuerCode === shortCode && row.Date <= asOf!
    && normalizedIssuerName(issuerName) === normalizedIssuerName(String(row.CoName)))
  const evidence = { jquantsMaster: row, peerListedCodes: peerCodes,
    jpxAugust2026: row.Date >= '2026-09-03' ? august : null,
    edinetIssuerCodeRaw: issuerCode, edinetIssuerName: issuerName,
    issuerNameMatches: normalizedIssuerName(issuerName) === normalizedIssuerName(String(row.CoName)),
    // JPX's August file is only a cross-check at/after its publication date.
    jpxAugustReference: row.Date >= '2026-09-03' && august ? JPX_LIST_URL : null }
  return { instrumentId: `JPX:${code}`, issuerEdinetCode: issuer.issuer_edinet_code == null
    ? null : String(issuer.issuer_edinet_code), issuerName,
    officialSecurityCode: code, officialSecurityCodeRaw: code, jpxShortCode: shortCode,
    isin: null, instrumentName: String(row.CoName), instrumentType: category.instrumentType,
    securityClass: String(row.ProdCat), quantityUnit: category.quantityUnit,
    priceUnit: category.priceUnit, market: String(row.MktNm), listingStatus: 'LISTED',
    listedFrom: null, listedTo: null, priceSeriesId: shortCode,
    sourceAuthority: 'JQUANTS_JPX', sourceUrlOrReference: `${MASTER_URL}?date=${row.Date}`,
    sourceAsOf: row.Date, sourceEvidence: JSON.stringify(evidence), sourceHash: evidenceHash(row),
    mappingStatus: exact ? 'OFFICIAL_EXACT' : 'UNRESOLVED',
    mappingConfidence: exact ? 'HIGH' : 'UNRESOLVED' }
}

function officialPrice(row: BarRow, localClose: number | null): OfficialPrice {
  return { officialSecurityCodeRaw: String(row.Code), date: row.Date,
    rawClose: row.C == null ? null : Number(row.C),
    adjustedClose: row.AdjC == null ? null : Number(row.AdjC), localClose,
    sourceAuthority: 'JQUANTS_JPX', sourceUrlOrReference: `${BARS_URL}?date=${row.Date}`,
    sourceEvidence: JSON.stringify(row),
    sourceHash: evidenceHash(row) }
}

async function main() {
  if (!asOf) throw new Error('Missing as-of date')
  await ensureReady()
  const startedAt = Date.now()
  const candidates = (await client.execute(`SELECT p.*, f.issuer_edinet_code, f.issuer_security_code,
    f.issuer_name, f.submitted_at, f.obligation_date AS filing_obligation_date,
    f.reference_date AS filing_reference_date, f.raw_parsed_payload_json,
    s.xbrl_sha256
    FROM large_holder_positions p JOIN large_holder_filings f USING(document_id)
    JOIN large_holder_source_documents s USING(document_id)
    WHERE p.market_price_status IN ('FULL_DIRECT','PARTIAL_DIRECT')
    ORDER BY p.document_id,p.holder_key`)).rows as CandidateRow[]
  if (candidates.length !== 233) throw new Error(`Candidate universe changed: ${candidates.length}`)
  const jpx = reassessOnly ? new Map<string, { name: string; category: string }>() : await jpxAugustList()
  const byDate = new Map<string, CandidateRow[]>()
  for (const candidate of candidates) {
    const date = String(candidate.market_price_close_date ?? '')
    if (!date || date > asOf) continue
    byDate.set(date, [...(byDate.get(date) ?? []), candidate])
  }
  byDate.set(asOf, byDate.get(asOf) ?? [])
  const instruments = new Map<string, OfficialInstrument>()
  const prices = new Map<string, OfficialPrice>()
  const peerCounts = new Map<string, number>()
  const codeBridges = new Map<string, EdinetCodeBridge[]>()
  const capitalStructures = new Map<string, IssuerCapitalStructure[]>()
  const bridgeRows = await client.execute('SELECT * FROM large_holder_edinet_code_bridge ORDER BY snapshot_date DESC')
  for (const row of bridgeRows.rows) {
    const code = String(row.edinet_code)
    codeBridges.set(code, [...(codeBridges.get(code) ?? []), {
      edinetCode: code, securityCode: String(row.security_code), submitterName: String(row.submitter_name),
      listingStatus: String(row.listing_status), snapshotDate: String(row.snapshot_date),
      sourceUrl: String(row.source_url), archiveSha256: String(row.archive_sha256),
      sourceEvidence: String(row.source_evidence), sourceHash: String(row.source_hash),
    }])
  }
  const capitalRows = await client.execute('SELECT * FROM large_holder_issuer_capital_structure ORDER BY source_submitted_at DESC')
  for (const row of capitalRows.rows) {
    const code = String(row.issuer_edinet_code)
    capitalStructures.set(code, [...(capitalStructures.get(code) ?? []), {
      issuerEdinetCode: code, sourceDocumentId: String(row.source_document_id),
      sourceSubmittedAt: String(row.source_submitted_at), reportingDate: String(row.reporting_date),
      sourceUrl: String(row.source_url), sourceEvidence: String(row.source_evidence),
      sourceHash: String(row.source_hash),
      classes: JSON.parse(String(row.classes_json)) as IssuerCapitalStructure['classes'],
      tableComplete: Number(row.table_complete) === 1,
    }])
  }
  const sourceIssues: string[] = []
  if (reassessOnly) {
    const storedInstruments = await client.execute({ sql: `SELECT * FROM large_holder_instrument_master
      WHERE source_as_of<=?`, args: [asOf] })
    for (const row of storedInstruments.rows) {
      const originalEvidence = String(row.source_evidence)
      const sourceEvidence = JSON.parse(originalEvidence) as { peerListedCodes?: string[] }
      const instrument: OfficialInstrument = {
        instrumentId: String(row.instrument_id), sourceAsOf: String(row.source_as_of),
        issuerEdinetCode: row.issuer_edinet_code == null ? null : String(row.issuer_edinet_code),
        issuerName: String(row.issuer_name), officialSecurityCode: String(row.official_security_code),
        officialSecurityCodeRaw: String(row.official_security_code_raw),
        jpxShortCode: row.jpx_short_code == null ? null : String(row.jpx_short_code),
        isin: row.isin == null ? null : String(row.isin), instrumentName: String(row.instrument_name),
        instrumentType: row.instrument_type as OfficialInstrument['instrumentType'],
        securityClass: String(row.security_class), quantityUnit: row.quantity_unit as OfficialInstrument['quantityUnit'],
        priceUnit: row.price_unit as OfficialInstrument['priceUnit'], market: String(row.market),
        listingStatus: row.listing_status as OfficialInstrument['listingStatus'],
        listedFrom: row.listed_from == null ? null : String(row.listed_from),
        listedTo: row.listed_to == null ? null : String(row.listed_to),
        priceSeriesId: row.price_series_id == null ? null : String(row.price_series_id),
        sourceAuthority: String(row.source_authority), sourceUrlOrReference: String(row.source_url_or_reference),
        sourceEvidence: originalEvidence, sourceHash: String(row.source_hash),
        mappingStatus: row.mapping_status as OfficialInstrument['mappingStatus'],
        mappingConfidence: row.mapping_confidence as OfficialInstrument['mappingConfidence'],
      }
      const key = `${instrument.jpxShortCode}:${instrument.sourceAsOf}`
      instruments.set(key, instrument)
      peerCounts.set(key, sourceEvidence.peerListedCodes?.length ?? 0)
    }
    const storedPrices = await client.execute({ sql: `SELECT * FROM large_holder_price_evidence
      WHERE price_date<=?`, args: [asOf] })
    for (const row of storedPrices.rows) {
      const code = String(row.official_security_code_raw)
      if (!code.endsWith('0')) continue
      prices.set(`${code.slice(0, 4)}:${row.price_date}`, {
        officialSecurityCodeRaw: code, date: String(row.price_date),
        rawClose: row.raw_close == null ? null : Number(row.raw_close),
        adjustedClose: row.adjusted_close == null ? null : Number(row.adjusted_close),
        localClose: row.local_close == null ? null : Number(row.local_close),
        sourceAuthority: String(row.source_authority), sourceUrlOrReference: String(row.source_url_or_reference),
        sourceEvidence: row.source_evidence == null ? '' : String(row.source_evidence),
        sourceHash: String(row.source_hash),
      })
    }
    if (instruments.size < 100 || prices.size < 100) throw new Error('Official evidence cache is incomplete')
  } else {
  for (const [date, rows] of [...byDate].sort(([left], [right]) => left.localeCompare(right))) {
    const [masterRows, barRows] = await Promise.all([
      officialRows<MasterRow>(MASTER_URL, date), officialRows<BarRow>(BARS_URL, date),
    ])
    if (masterRows.some((row) => row.Date > date) || barRows.some((row) => row.Date > date)) {
      throw new Error(`Future official data returned for ${date}`)
    }
    const targetCodes = new Set(rows.map((row) => String(row.ticker)))
    if (date === asOf) for (const row of candidates) targetCodes.add(String(row.ticker))
    const masterByPrefix = new Map<string, MasterRow[]>()
    for (const row of masterRows) {
      if (String(row.Code).length !== 5) continue
      const prefix = String(row.Code).slice(0, 4)
      if (!targetCodes.has(prefix)) continue
      masterByPrefix.set(prefix, [...(masterByPrefix.get(prefix) ?? []), row])
    }
    const barsByCode = new Map(barRows.map((row) => [String(row.Code), row]))
    const issuerByTicker = new Map(candidates.map((row) => [String(row.ticker), row]))
    for (const ticker of targetCodes) {
      const main = (masterByPrefix.get(ticker) ?? []).find((row) => row.Code === `${ticker}0`)
      if (!main) continue
      const peers = (masterByPrefix.get(ticker) ?? []).filter((row) => row.ProdCat === main.ProdCat)
      const issuer = issuerByTicker.get(ticker)!
      const instrument = officialInstrument(main, issuer, peers.map((row) => row.Code), jpx)
      const key = `${ticker}:${date}`
      instruments.set(key, instrument)
      peerCounts.set(key, peers.length)
      const bar = barsByCode.get(main.Code)
      const local = bar ? await client.execute({ sql: 'SELECT close FROM ohlcv_daily WHERE ticker=? AND date=?',
        args: [ticker, date] }) : null
      if (bar) prices.set(key, officialPrice(bar, local?.rows[0]?.close == null ? null : Number(local.rows[0].close)))
      if (date === asOf && instrument.instrumentType === 'COMMON_STOCK') {
        const august = jpx.get(ticker)
        if (august && !/内国株式|PRO Market/.test(august.category)) {
          sourceIssues.push(`${ticker}:jpx_category_conflict`)
        }
      }
    }
    console.log(JSON.stringify({ sourceDate: date, targetTickers: targetCodes.size,
      matchedInstruments: [...targetCodes].filter((ticker) => instruments.has(`${ticker}:${date}`)).length }))
  }
  }
  if (sourceIssues.length) throw new Error(`Official source conflicts: ${sourceIssues.join(',')}`)

  const currentEffective = new Set((await latestDisclosedPositions(asOf)).map((row) =>
    `${row.documentId}:${row.entityId}:${row.ticker}`))
  const counts: Record<string, number> = {}
  const methods: Record<string, number> = {}
  const sourceCache = new Map<string, { issuerListing: string | null; holderNotes: Map<string, string> }>()
  const samples: { documentId: string; ticker: string; status: string; units: number | null;
    date: string | null; price: number | null; value: number | null }[] = []
  for (const row of candidates) {
    const ticker = String(row.ticker)
    const date = String(row.market_price_close_date ?? '')
    const parsed = JSON.parse(String(row.raw_parsed_payload_json)) as { issuerListing?: string }
    const documentId = String(row.document_id)
    if (!sourceCache.has(documentId)) {
      const source = await client.execute({ sql: 'SELECT xbrl_xml FROM large_holder_source_documents WHERE document_id=?',
        args: [documentId] })
      const facts = source.rows[0]?.xbrl_xml == null ? []
        : new XbrlFactReader(String(source.rows[0].xbrl_xml)).facts
      const holderNotes = new Map<string, string>()
      for (const fact of facts) {
        if (fact.localName !== 'NotesNumberOfStocksEtcHeldTextBlock' || fact.isNil || !fact.textValue) continue
        const holder = fact.context?.dimensions.find((dimension) =>
          dimension.dimension.includes('FilersLargeVolumeHoldersAndJointHoldersAxis'))?.member
        if (holder) holderNotes.set(holder, fact.textValue)
      }
      sourceCache.set(documentId, { issuerListing: facts.find((fact) => fact.localName === 'ListedOrOTC')
        ?.textValue ?? null, holderNotes })
    }
    const breakdown = JSON.parse(String(row.security_breakdown_json)) as {
      kind: string; concept: string; unit: string | null; quantity: number }[]
    const direct = breakdown.filter((part) => part.kind === 'DIRECT_SECURITY' && part.quantity > 0)
    const instrument = instruments.get(`${ticker}:${date}`) ?? null
    const currentInstrument = instruments.get(`${ticker}:${asOf}`) ?? null
    const referenceDate = String(row.reference_date ?? row.filing_reference_date
      ?? row.submitted_at).slice(0, 10)
    const issuerCode = row.issuer_edinet_code == null ? '' : String(row.issuer_edinet_code)
    const obligationDate = String(row.filing_obligation_date ?? referenceDate).slice(0, 10)
    const knowledgeCutoff = `${obligationDate} 23:59:59`
    const pitBridge = codeBridges.get(issuerCode)?.find((bridge) => bridge.snapshotDate <= obligationDate)
    const pitCapital = capitalStructures.get(issuerCode)?.find((capital) =>
      capital.sourceSubmittedAt <= knowledgeCutoff)
    const currentBridge = codeBridges.get(issuerCode)?.find((bridge) => bridge.snapshotDate <= asOf)
    const currentCapital = capitalStructures.get(issuerCode)?.find((capital) =>
      capital.sourceSubmittedAt <= `${asOf} 23:59:59`)
    const certified = certifyPosition({ edinetIssuerCode: row.issuer_edinet_code == null
      ? null : String(row.issuer_edinet_code), edinetSecurityCodeRaw: row.issuer_security_code == null
        ? null : String(row.issuer_security_code), referenceDate, requestedAsOf: asOf,
      filingSubmittedAt: String(row.submitted_at),
      researchStatus: String(row.market_price_status), eligibleUnits: row.market_price_eligible_units == null
        ? null : Number(row.market_price_eligible_units),
      directUnit: direct.length && direct.every((part) => part.unit === direct[0].unit) ? direct[0].unit : null,
      directConcept: direct.length && direct.every((part) => part.concept.includes('StocksOrInvestmentSecurities'))
        ? direct[0].concept : null,
      directComponentTotal: direct.reduce((sum, part) => sum + part.quantity, 0),
      directComponentCount: direct.length,
      sourceDocumentHash: row.xbrl_sha256 == null ? null : String(row.xbrl_sha256),
      holdingNote: sourceCache.get(documentId)?.holderNotes.get(String(row.holder_key)) ?? null,
      issuerListing: sourceCache.get(documentId)?.issuerListing ?? parsed.issuerListing ?? null,
      valuationKnowledgeCutoff: knowledgeCutoff,
      isLatestEffectivePosition: currentEffective.has(`${documentId}:${row.entity_id}:${ticker}`),
      codeBridge: pitBridge, capitalStructure: pitCapital,
      currentCodeBridge: currentBridge, currentCapitalStructure: currentCapital,
      instrument, currentInstrument,
      sameIssuerListedClassCount: peerCounts.get(`${ticker}:${date}`) ?? 0,
      price: date <= obligationDate ? prices.get(`${ticker}:${date}`) ?? null : null,
      currentPrice: prices.get(`${ticker}:${asOf}`) ?? null })
    counts[certified.publicStatus] = (counts[certified.publicStatus] ?? 0) + 1
    methods[certified.certificationMethod] = (methods[certified.certificationMethod] ?? 0) + 1
    if (samples.length < 25 && certified.publicStatus === 'PUBLIC_VALUATION_READY') samples.push({
      documentId: String(row.document_id), ticker, status: certified.publicStatus,
      units: certified.eligibleUnits, date: certified.priceDate, price: certified.pricePerUnit,
      value: certified.estimatedValueYen })
    await client.execute({ sql: `INSERT INTO large_holder_position_certifications
      (document_id,holder_key,instrument_id,mapping_status,price_series_mapping_status,
       public_status,pit_valuation_ready,quantity_unit,price_unit,eligible_units,price_date,price_per_unit,
       estimated_value_yen,current_value_yen,certification_method,certification_strength,
       certification_evidence_json,evidence_json,assessed_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,unixepoch())
      ON CONFLICT(document_id,holder_key) DO UPDATE SET
       instrument_id=excluded.instrument_id,mapping_status=excluded.mapping_status,
       price_series_mapping_status=excluded.price_series_mapping_status,public_status=excluded.public_status,
       pit_valuation_ready=excluded.pit_valuation_ready,
       quantity_unit=excluded.quantity_unit,price_unit=excluded.price_unit,
       eligible_units=excluded.eligible_units,price_date=excluded.price_date,
       price_per_unit=excluded.price_per_unit,estimated_value_yen=excluded.estimated_value_yen,
       current_value_yen=excluded.current_value_yen,evidence_json=excluded.evidence_json,
       certification_method=excluded.certification_method,
       certification_strength=excluded.certification_strength,
       certification_evidence_json=excluded.certification_evidence_json,
       assessed_at=excluded.assessed_at`,
      args: [String(row.document_id), String(row.holder_key), certified.instrumentId, certified.mappingStatus,
        certified.priceSeriesMappingStatus, certified.publicStatus, certified.pitValuationReady ? 1 : 0,
        certified.quantityUnit,
        certified.priceUnit, certified.eligibleUnits, certified.priceDate, certified.pricePerUnit,
        certified.estimatedValueYen, certified.currentValueYen, certified.certificationMethod,
        certified.certificationStrength, JSON.stringify(certified.certificationEvidence),
        JSON.stringify(certified.evidence)] })
  }
  for (const instrument of instruments.values()) await client.execute({ sql: `INSERT INTO large_holder_instrument_master
    (instrument_id,source_as_of,issuer_edinet_code,issuer_name,official_security_code,
     official_security_code_raw,jpx_short_code,isin,instrument_name,instrument_type,
     security_class,quantity_unit,price_unit,market,listing_status,listed_from,listed_to,
     price_series_id,source_authority,source_url_or_reference,source_evidence,source_hash,
     mapping_status,mapping_confidence,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,unixepoch())
    ON CONFLICT(instrument_id,source_as_of) DO UPDATE SET
     source_evidence=excluded.source_evidence,source_hash=excluded.source_hash,
     mapping_status=excluded.mapping_status,mapping_confidence=excluded.mapping_confidence,
     updated_at=excluded.updated_at`,
    args: [instrument.instrumentId, instrument.sourceAsOf, instrument.issuerEdinetCode,
      instrument.issuerName, instrument.officialSecurityCode, instrument.officialSecurityCodeRaw,
      instrument.jpxShortCode, instrument.isin, instrument.instrumentName, instrument.instrumentType,
      instrument.securityClass, instrument.quantityUnit, instrument.priceUnit, instrument.market,
      instrument.listingStatus, instrument.listedFrom, instrument.listedTo, instrument.priceSeriesId,
      instrument.sourceAuthority, instrument.sourceUrlOrReference, instrument.sourceEvidence,
      instrument.sourceHash, instrument.mappingStatus, instrument.mappingConfidence] })
  for (const [key, price] of prices) await client.execute({ sql: `INSERT INTO large_holder_price_evidence
    (instrument_id,price_date,official_security_code_raw,raw_close,adjusted_close,local_close,
     source_authority,source_url_or_reference,source_evidence,source_hash)
    VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(instrument_id,price_date) DO UPDATE SET
     raw_close=excluded.raw_close,adjusted_close=excluded.adjusted_close,
     local_close=excluded.local_close,source_evidence=excluded.source_evidence,
     source_hash=excluded.source_hash`,
    args: [`JPX:${price.officialSecurityCodeRaw}`, price.date, price.officialSecurityCodeRaw,
      price.rawClose, price.adjustedClose, price.localClose, price.sourceAuthority,
      price.sourceUrlOrReference, price.sourceEvidence, price.sourceHash] })
  console.log(JSON.stringify({ asOf, candidates: candidates.length, officialInstrumentSnapshots: instruments.size,
    uniqueOfficialInstruments: new Set([...instruments.values()].map((instrument) => instrument.instrumentId)).size,
    priceEvidenceRows: prices.size, codeBridgeRows: bridgeRows.rows.length,
    capitalStructureRows: capitalRows.rows.length, counts, methods, sampleValues: samples,
    elapsedMs: Date.now() - startedAt }, null, 2))
}

main().catch((error) => { console.error(error); process.exitCode = 1 })
