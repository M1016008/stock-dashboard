// Read-only independent audit of persisted official rows and certification results.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { client, ensureReady, localDbPath } from '@/lib/db/client'
import { XbrlFactReader } from '@/lib/edinet-xbrl-facts'
import { latestDisclosedPositions } from '@/lib/server/large-holders/latest-positions'

function hash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

async function main() {
  await ensureReady()
  const started = Date.now()
  const master = await client.execute('SELECT * FROM large_holder_instrument_master')
  const prices = await client.execute('SELECT * FROM large_holder_price_evidence')
  const candidates = await client.execute(`SELECT p.document_id, p.holder_key, p.ticker,
    p.market_price_close_date, p.market_price_eligible_units, p.market_price_status,
    p.reference_date, p.entity_id, f.issuer_security_code, f.issuer_name,
    f.obligation_date, f.submitted_at, f.raw_parsed_payload_json,
    c.instrument_id, c.public_status, c.pit_valuation_ready, c.estimated_value_yen,
    c.current_value_yen, c.price_series_mapping_status,
    c.certification_method, c.certification_strength, c.certification_evidence_json
    FROM large_holder_positions p JOIN large_holder_filings f USING(document_id)
    JOIN large_holder_position_certifications c USING(document_id,holder_key)
    WHERE p.market_price_status IN ('FULL_DIRECT','PARTIAL_DIRECT')`)
  const sourceDocuments = await client.execute(`SELECT document_id,xbrl_xml,xbrl_sha256
    FROM large_holder_source_documents`)
  const errors: string[] = []
  const notesBySourceHolder = new Map<string, string | null>()
  for (const document of sourceDocuments.rows) {
    const xml = String(document.xbrl_xml)
    if (createHash('sha256').update(xml).digest('hex') !== document.xbrl_sha256) {
      errors.push(`${document.document_id}:source_document_hash`)
    }
    for (const fact of new XbrlFactReader(xml).facts) {
      if (fact.localName !== 'NotesNumberOfStocksEtcHeldTextBlock') continue
      const member = fact.context?.dimensions.find((dimension) =>
        dimension.dimension.includes('FilersLargeVolumeHoldersAndJointHoldersAxis'))?.member
      if (member) notesBySourceHolder.set(`${document.document_id}:${member}`, fact.textValue || null)
    }
  }
  const masterByCodeDate = new Map<string, (typeof master.rows)[number]>()
  const exactMasterCodes = new Set<string>()
  const categoryCounts: Record<string, number> = {}
  for (const item of master.rows) {
    const id = `${item.official_security_code_raw}:${item.source_as_of}`
    const source = JSON.parse(String(item.source_evidence)) as { jquantsMaster: Record<string, unknown> }
    const row = source.jquantsMaster
    if (!row || hash(row) !== item.source_hash || row.Code !== item.official_security_code_raw
      || row.Date !== item.source_as_of || row.CoName !== item.instrument_name
      || row.ProdCat !== item.security_class) errors.push(`${id}:master_source`)
    if (masterByCodeDate.has(id)) errors.push(`${id}:duplicate_master`)
    masterByCodeDate.set(id, item)
    if (item.mapping_status === 'OFFICIAL_EXACT') exactMasterCodes.add(String(item.official_security_code_raw))
    categoryCounts[String(item.instrument_type)] = (categoryCounts[String(item.instrument_type)] ?? 0) + 1
  }
  const priceByCodeDate = new Map<string, (typeof prices.rows)[number]>()
  let officialNoTradeRows = 0
  for (const item of prices.rows) {
    const id = `${item.official_security_code_raw}:${item.price_date}`
    const row = JSON.parse(String(item.source_evidence)) as Record<string, unknown>
    const noTrade = row.C == null && row.AdjC == null
    if (noTrade) officialNoTradeRows++
    if (hash(row) !== item.source_hash || row.Code !== item.official_security_code_raw
      || row.Date !== item.price_date || row.C !== item.raw_close
      || row.AdjC !== item.adjusted_close
      || (noTrade ? item.local_close != null : !Number.isFinite(item.raw_close)
        || Number(item.raw_close) <= 0)) errors.push(`${id}:price_source`)
    if (!noTrade && (item.local_close == null || item.adjusted_close == null
      || Math.abs(Number(item.local_close) - Number(item.adjusted_close))
        > Math.max(0.01, Number(item.adjusted_close) * 0.0001))) errors.push(`${id}:local_series`)
    if (priceByCodeDate.has(id)) errors.push(`${id}:duplicate_price`)
    priceByCodeDate.set(id, item)
  }
  let sourceHoldingNotes = 0
  let explicitClassQuantityEvidence = 0
  let parsedNoteOmissions = 0
  let exactPositionPriceChains = 0
  let researchArithmeticChecks = 0
  let publicValuationChecks = 0
  const publicCounts: Record<string, number> = {}
  const priceMappingCounts: Record<string, number> = {}
  const failedNameTickers = new Set<string>()
  for (const item of candidates.rows) {
    const ticker = String(item.ticker)
    const code = `${ticker}0`
    const date = String(item.market_price_close_date)
    const reference = String(item.reference_date ?? item.obligation_date ?? item.submitted_at).slice(0, 10)
    if (date > reference || date > '2026-09-18') errors.push(`${item.document_id}:future_price`)
    const masterRow = masterByCodeDate.get(`${code}:${date}`)
    const price = priceByCodeDate.get(`${code}:${date}`)
    const parsed = JSON.parse(String(item.raw_parsed_payload_json)) as {
      holders: { key: string; holdingNote: string | null }[] }
    const note = parsed.holders.find((holder) => holder.key === item.holder_key)?.holdingNote ?? null
    const sourceNote = notesBySourceHolder.get(`${item.document_id}:${item.holder_key}`) ?? null
    if (note !== sourceNote) parsedNoteOmissions++
    if (sourceNote) sourceHoldingNotes++
    if (sourceNote?.normalize('NFKC').trim().match(/^(?:普通株式\s+[\d,]+\s*株|投資口\s+[\d,]+\s*口)$/)) {
      explicitClassQuantityEvidence++
    }
    if (masterRow?.mapping_status === 'OFFICIAL_EXACT' && price
      && masterRow.price_series_id === ticker && item.instrument_id === masterRow.instrument_id
      && String(item.issuer_security_code) === ticker) {
      exactPositionPriceChains++
      if (researchArithmeticChecks < 20) {
        const value = Number(item.market_price_eligible_units) * Number(price.raw_close)
        if (!Number.isSafeInteger(value)) errors.push(`${item.document_id}:research_arithmetic_unsafe`)
        researchArithmeticChecks++
      }
    }
    if (masterRow?.mapping_status === 'UNRESOLVED') failedNameTickers.add(ticker)
    const status = String(item.public_status)
    publicCounts[status] = (publicCounts[status] ?? 0) + 1
    const priceMapping = String(item.price_series_mapping_status)
    priceMappingCounts[priceMapping] = (priceMappingCounts[priceMapping] ?? 0) + 1
    if (status === 'PUBLIC_VALUATION_READY') {
      publicValuationChecks++
      const explicit = sourceNote?.normalize('NFKC').trim().match(/^普通株式\s+([\d,]+)\s*株$/)
      const method = String(item.certification_method)
      const evidence = JSON.parse(String(item.certification_evidence_json)) as { source: string; hash: string }[]
      const completeChain = ['LARGE_HOLDER_FILING', 'EDINET_CODE_LIST', 'JPX_INSTRUMENT', 'JPX_PRICE']
        .every((source) => evidence.some((entry) => entry.source === source && entry.hash))
      const classProof = method === 'EXPLICIT_FILING'
        ? Boolean(explicit && Number(explicit[1].replaceAll(',', '')) === Number(item.market_price_eligible_units))
        : method === 'CROSS_DOCUMENT_UNIQUE'
          && evidence.some((entry) => entry.source === 'ISSUER_STATUTORY_FILING' && entry.hash)
      if (!masterRow || !price || !completeChain || !classProof
        || item.pit_valuation_ready !== 1
        || item.estimated_value_yen !== Number(item.market_price_eligible_units) * Number(price.raw_close)) {
        errors.push(`${item.document_id}:${item.holder_key}:public_valuation`)
      }
    } else if (item.estimated_value_yen != null || item.current_value_yen != null || item.pit_valuation_ready !== 0) {
      errors.push(`${item.document_id}:${item.holder_key}:uncertified_value`)
    }
  }
  const latest = await latestDisclosedPositions('2026-09-18')
  const byInvestor = new Map<string, { total: number; valued: number }>()
  const readyByDocEntity = new Map<string, boolean>()
  for (const item of candidates.rows) {
    const key = `${item.document_id}:${item.entity_id}:${item.ticker}`
    if (readyByDocEntity.has(key)) errors.push(`${key}:duplicate_entity_position`)
    readyByDocEntity.set(key, item.public_status === 'PUBLIC_VALUATION_READY')
  }
  for (const item of latest) {
    const value = byInvestor.get(item.entityId) ?? { total: 0, valued: 0 }
    value.total++
    if (readyByDocEntity.get(`${item.documentId}:${item.entityId}:${item.ticker}`)) value.valued++
    byInvestor.set(item.entityId, value)
  }
  const portfolios = { COMPLETE: 0, PARTIAL: 0, NONE: 0 }
  for (const value of byInvestor.values()) {
    portfolios[value.valued === 0 ? 'NONE' : value.valued === value.total ? 'COMPLETE' : 'PARTIAL']++
  }
  const tableRows = master.rows.length + prices.rows.length + candidates.rows.length
  const evidenceBytes = master.rows.reduce((sum, row) => sum + String(row.source_evidence).length, 0)
    + prices.rows.reduce((sum, row) => sum + String(row.source_evidence).length, 0)
  const snapshot = { database: localDbPath, masterSnapshots: master.rows.length,
    uniqueOfficialInstruments: new Set(master.rows.map((row) => row.instrument_id)).size,
    exactMasterInstruments: exactMasterCodes.size, masterCategories: categoryCounts,
    priceEvidenceRows: prices.rows.length, officialNoTradeRows,
    sourceDocumentsChecked: sourceDocuments.rows.length,
    positionCandidates: candidates.rows.length,
    exactPositionPriceChains, sourceHoldingNotes, explicitClassQuantityEvidence,
    parsedNoteOmissions, publicCounts, priceMappingCounts,
    publicValuationChecks, researchArithmeticChecks, latestPositions: latest.length,
    portfolios, failedNameTickers: [...failedNameTickers].sort(), tableRows,
    sourceEvidenceBytes: evidenceBytes, errors: errors.slice(0, 30), errorCount: errors.length,
    runtimeMs: Date.now() - started, peakRssBytes: process.memoryUsage().rss }
  console.log(JSON.stringify(snapshot, null, 2))
  assert.ok(exactMasterCodes.size >= 50, 'fewer than 50 exact official instruments')
  assert.ok(exactPositionPriceChains >= 50, 'fewer than 50 independent position-price mappings')
  assert.equal(errors.length, 0, 'independent cross-check failed')
}

main().catch((error) => { console.error(error); process.exitCode = 1 })
