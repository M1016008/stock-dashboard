// Research-only official-source acquisition. No web/API/portfolio publication.
import { createHash } from 'node:crypto'
import { Readable } from 'node:stream'
import ExcelJS from 'exceljs'
import { unzipSync } from 'fflate'
import { client, ensureReady } from '@/lib/db/client'
import { XbrlFactReader } from '@/lib/edinet-xbrl-facts'
import { downloadEdinetPublicXbrl, listEdinetDocuments } from '@/lib/server/edinet-api'
import { EDINET_CODE_LIST_URL, extractReitCapitalStructure, extractStockCapitalStructure,
  verifyCapitalStructure, verifyEdinetBridge, type EdinetCodeBridge,
  type IssuerCapitalStructure } from '@/lib/large-holders/cross-document-evidence'
import { evidenceHash } from '@/lib/large-holders/instrument-certification'

type Candidate = { ticker: string; issuer_edinet_code: string; issuer_security_code: string;
  issuer_name: string }

async function officialCodeList(candidates: Candidate[]): Promise<{ snapshotDate: string;
  bridges: EdinetCodeBridge[]; missing: string[]; mismatch: string[]; nameWarnings: string[] }> {
  const response = await fetch(EDINET_CODE_LIST_URL, { signal: AbortSignal.timeout(30_000) })
  if (!response.ok) throw new Error(`EDINET code list: HTTP ${response.status}`)
  const archive = new Uint8Array(await response.arrayBuffer())
  const archiveSha256 = createHash('sha256').update(archive).digest('hex')
  const files = unzipSync(archive)
  const csv = files['EdinetcodeDlInfo.csv']
  if (!csv) throw new Error('EDINET code list CSV missing')
  const sheet = await new ExcelJS.Workbook().csv.read(Readable.from([new TextDecoder('shift_jis').decode(csv)]))
  const dateText = String(sheet.getRow(1).getCell(2).value ?? '').normalize('NFKC')
  const dateMatch = dateText.match(/^(\d{4})年(\d{2})月(\d{2})日現在$/)
  if (!dateMatch || String(sheet.getRow(2).getCell(1).value ?? '') !== 'ＥＤＩＮＥＴコード') {
    throw new Error('EDINET code list format changed')
  }
  const snapshotDate = `${dateMatch[1]}-${dateMatch[2]}-${dateMatch[3]}`
  const requested = new Set(candidates.map((row) => row.issuer_edinet_code))
  const rows = new Map<string, { submitterName: string; listingStatus: string; securityCode: string }>()
  for (let index = 3; index <= sheet.rowCount; index++) {
    const row = sheet.getRow(index)
    const edinetCode = String(row.getCell(1).value ?? '').trim()
    if (!requested.has(edinetCode)) continue
    if (rows.has(edinetCode)) throw new Error(`Duplicate EDINET code in official list: ${edinetCode}`)
    rows.set(edinetCode, { submitterName: String(row.getCell(7).value ?? '').trim(),
      listingStatus: String(row.getCell(3).value ?? '').trim(),
      securityCode: String(row.getCell(12).value ?? '').trim() })
  }
  const bridges: EdinetCodeBridge[] = []
  const missing: string[] = []
  const mismatch: string[] = []
  const nameWarnings: string[] = []
  for (const candidate of candidates) {
    const row = rows.get(candidate.issuer_edinet_code)
    if (!row) { missing.push(candidate.ticker); continue }
    if (row.securityCode !== `${candidate.issuer_security_code}0` || row.listingStatus !== '上場') {
      mismatch.push(`${candidate.ticker}:${row.securityCode}:${row.listingStatus}`)
      continue
    }
    if (row.submitterName.normalize('NFKC').replace(/[\s株式会社]/g, '')
      !== candidate.issuer_name.normalize('NFKC').replace(/[\s株式会社]/g, '')) {
      nameWarnings.push(candidate.ticker)
    }
    const evidence = { edinetCode: candidate.issuer_edinet_code, securityCode: row.securityCode,
      submitterName: row.submitterName, listingStatus: row.listingStatus,
      snapshotDate, archiveSha256 }
    const bridge = { ...evidence, sourceUrl: EDINET_CODE_LIST_URL,
      sourceEvidence: JSON.stringify(evidence), sourceHash: evidenceHash(evidence) }
    if (!verifyEdinetBridge(bridge, bridge.edinetCode, bridge.securityCode,
      '9999-12-31 23:59:59')) throw new Error(`Official code-list self-check failed: ${candidate.ticker}`)
    bridges.push(bridge)
  }
  return { snapshotDate, bridges, missing, mismatch, nameWarnings }
}

async function storeBridge(row: EdinetCodeBridge): Promise<void> {
  await client.execute({ sql: `INSERT INTO large_holder_edinet_code_bridge
    (edinet_code,snapshot_date,security_code,submitter_name,listing_status,
     source_url,archive_sha256,source_evidence,source_hash)
    VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(edinet_code,snapshot_date) DO UPDATE SET
      security_code=excluded.security_code,submitter_name=excluded.submitter_name,
      listing_status=excluded.listing_status,archive_sha256=excluded.archive_sha256,
      source_evidence=excluded.source_evidence,source_hash=excluded.source_hash`,
  args: [row.edinetCode, row.snapshotDate, row.securityCode, row.submitterName,
    row.listingStatus, row.sourceUrl, row.archiveSha256, row.sourceEvidence, row.sourceHash] })
}

async function storeCapital(row: IssuerCapitalStructure): Promise<void> {
  await client.execute({ sql: `INSERT INTO large_holder_issuer_capital_structure
    (issuer_edinet_code,source_document_id,source_submitted_at,reporting_date,
     source_url,source_evidence,source_hash,classes_json,table_complete)
    VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(issuer_edinet_code,source_document_id) DO UPDATE SET
      source_submitted_at=excluded.source_submitted_at,reporting_date=excluded.reporting_date,
      source_evidence=excluded.source_evidence,source_hash=excluded.source_hash,
      classes_json=excluded.classes_json,table_complete=excluded.table_complete`,
  args: [row.issuerEdinetCode, row.sourceDocumentId, row.sourceSubmittedAt,
    row.reportingDate, row.sourceUrl, row.sourceEvidence, row.sourceHash,
    JSON.stringify(row.classes), row.tableComplete ? 1 : 0] })
}

async function main() {
  const startedAt = Date.now()
  await ensureReady()
  const candidates = (await client.execute(`SELECT DISTINCT f.issuer_edinet_code, f.issuer_security_code,
    f.issuer_name,p.ticker FROM large_holder_positions p JOIN large_holder_filings f USING(document_id)
    WHERE p.market_price_status IN ('FULL_DIRECT','PARTIAL_DIRECT')
    AND f.issuer_edinet_code IS NOT NULL AND f.issuer_security_code IS NOT NULL
    GROUP BY f.issuer_edinet_code ORDER BY p.ticker`)).rows as unknown as Candidate[]
  const codes = await officialCodeList(candidates)
  for (const bridge of codes.bridges) await storeBridge(bridge)
  const documents = (await client.execute(`SELECT s.document_id,s.edinet_code,s.published_at,s.ticker
    FROM edinet_company_snapshots s JOIN (SELECT DISTINCT issuer_edinet_code AS code
      FROM large_holder_filings) f ON f.code=s.edinet_code
    WHERE s.document_type IN ('120','130') ORDER BY s.ticker,s.published_at DESC`)).rows
  const seen = new Set<string>()
  let verified = 0
  let incomplete = 0
  const failures: string[] = []
  const details: { ticker: string; documentId: string; classes: number; complete: boolean;
    availableAt: string }[] = []
  for (const row of documents) {
    if (seen.has(String(row.edinet_code)) || verified >= 35) continue
    seen.add(String(row.edinet_code))
    const id = String(row.document_id)
    try {
      const xml = await downloadEdinetPublicXbrl(id)
      const reader = new XbrlFactReader(xml)
      if (reader.facts.find((fact) => fact.localName === 'EDINETCodeDEI')?.textValue
        !== row.edinet_code) throw new Error('issuer DEI code mismatch')
      const capital = extractStockCapitalStructure(reader, { issuerEdinetCode: String(row.edinet_code),
        sourceDocumentId: id, sourceSubmittedAt: String(row.published_at), xbrlXml: xml })
      if (!capital) { incomplete++; failures.push(`${row.ticker}:no_structured_issued_shares`); continue }
      await storeCapital(capital)
      if (verifyCapitalStructure(capital, capital.issuerEdinetCode, capital.sourceSubmittedAt)) verified++
      else incomplete++
      details.push({ ticker: String(row.ticker), documentId: id, classes: capital.classes.length,
        complete: capital.tableComplete, availableAt: capital.sourceSubmittedAt })
    } catch (error) { failures.push(`${row.ticker}:${error instanceof Error ? error.message : String(error)}`) }
  }
  const reitDate = '2026-05-28'
  const reitIndex = (await listEdinetDocuments(reitDate)).find((doc) => doc.edinetCode === 'E27884'
    && doc.docTypeCode === '120' && doc.xbrlFlag === '1')
  let reit: { documentId: string; issuedUnits: number; verifiable: boolean } | null = null
  if (reitIndex?.submitDateTime) {
    const xml = await downloadEdinetPublicXbrl(reitIndex.docID)
    const capital = extractReitCapitalStructure(new XbrlFactReader(xml), {
      issuerEdinetCode: 'E27884', sourceDocumentId: reitIndex.docID,
      sourceSubmittedAt: reitIndex.submitDateTime.replace('T', ' '), xbrlXml: xml })
    if (capital) {
      await storeCapital(capital)
      reit = { documentId: reitIndex.docID, issuedUnits: capital.classes[0].issuedUnits,
        verifiable: verifyCapitalStructure(capital, 'E27884', '2026-09-21 23:59:59') }
    }
  }
  const multiIndex = (await listEdinetDocuments('2026-07-21')).find((doc) =>
    doc.edinetCode === 'E00414' && doc.docTypeCode === '120' && doc.xbrlFlag === '1')
  let multiClassNegative: { documentId: string; classes: string[]; bothListed: boolean } | null = null
  if (multiIndex?.submitDateTime) {
    const xml = await downloadEdinetPublicXbrl(multiIndex.docID)
    const capital = extractStockCapitalStructure(new XbrlFactReader(xml), {
      issuerEdinetCode: 'E00414', sourceDocumentId: multiIndex.docID,
      sourceSubmittedAt: multiIndex.submitDateTime.replace('T', ' '), xbrlXml: xml })
    if (capital) {
      await storeCapital(capital)
      multiClassNegative = { documentId: multiIndex.docID,
        classes: capital.classes.map((entry) => entry.name),
        bothListed: capital.tableComplete && capital.classes.length > 1
          && capital.classes.every((entry) => Boolean(entry.listedExchange)) }
    }
  }
  console.log(JSON.stringify({ candidates: candidates.length, edinetCodeSnapshotDate: codes.snapshotDate,
    codeListMapped: codes.bridges.length, codeListMissing: codes.missing, codeListMismatch: codes.mismatch,
    nameWarnings: codes.nameWarnings, issuerDocumentsVerified: verified, incomplete,
    issuerDetails: details, reit, multiClassNegative, failures, elapsedMs: Date.now() - startedAt,
    note: 'A current EDINET code list is not an historical PIT code list.' }, null, 2))
}

main().catch((error) => { console.error(error); process.exitCode = 1 })
