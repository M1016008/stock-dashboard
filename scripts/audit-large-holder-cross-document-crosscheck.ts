// Independent read-only comparison against downloaded official originals.
import { createHash } from 'node:crypto'
import { Readable } from 'node:stream'
import ExcelJS from 'exceljs'
import { unzipSync } from 'fflate'
import { client } from '@/lib/db/client'
import { XbrlFactReader } from '@/lib/edinet-xbrl-facts'
import { downloadEdinetPublicXbrl, listEdinetDocuments } from '@/lib/server/edinet-api'
import { EDINET_CODE_LIST_URL } from '@/lib/large-holders/cross-document-evidence'

async function main() {
  const started = Date.now()
  const response = await fetch(EDINET_CODE_LIST_URL, { signal: AbortSignal.timeout(30_000) })
  if (!response.ok) throw new Error(`Code list ${response.status}`)
  const bytes = new Uint8Array(await response.arrayBuffer())
  const digest = createHash('sha256').update(bytes).digest('hex')
  const csv = unzipSync(bytes)['EdinetcodeDlInfo.csv']
  if (!csv) throw new Error('Official code list CSV not found')
  const sheet = await new ExcelJS.Workbook().csv.read(Readable.from([new TextDecoder('shift_jis').decode(csv)]))
  const authoritative = new Map<string, { code: string; name: string; listing: string }>()
  for (let i = 3; i <= sheet.rowCount; i++) {
    const row = sheet.getRow(i)
    const code = String(row.getCell(1).value ?? '')
    if (code.startsWith('E')) authoritative.set(code, {
      code: String(row.getCell(12).value ?? ''), name: String(row.getCell(7).value ?? ''),
      listing: String(row.getCell(3).value ?? '') })
  }
  const bridges = (await client.execute('SELECT * FROM large_holder_edinet_code_bridge')).rows
  const issues: string[] = []
  for (const bridge of bridges) {
    const row = authoritative.get(String(bridge.edinet_code))
    if (!row || row.code !== bridge.security_code || row.name !== bridge.submitter_name
      || row.listing !== bridge.listing_status || bridge.archive_sha256 !== digest) {
      issues.push(`${bridge.edinet_code}:code_bridge_mismatch`)
    }
  }
  const capital = (await client.execute(`SELECT * FROM large_holder_issuer_capital_structure
    WHERE table_complete=1 ORDER BY source_document_id`)).rows
  const indexes = new Map<string, Awaited<ReturnType<typeof listEdinetDocuments>>>()
  let statutoryChecked = 0
  for (const item of capital) {
    const day = String(item.source_submitted_at).slice(0, 10)
    if (!indexes.has(day)) indexes.set(day, await listEdinetDocuments(day))
    const officialIndex = indexes.get(day)?.find((row) => row.docID === item.source_document_id)
    if (officialIndex?.edinetCode !== item.issuer_edinet_code
      || !['120', '130'].includes(officialIndex.docTypeCode ?? '')
      || officialIndex.xbrlFlag !== '1'
      || officialIndex.submitDateTime?.replace('T', ' ') !== item.source_submitted_at) {
      issues.push(`${item.source_document_id}:pit_submission_timestamp`)
    }
    const xml = await downloadEdinetPublicXbrl(String(item.source_document_id))
    const evidence = JSON.parse(String(item.source_evidence)) as { xbrlSha256: string; tableSha256: string }
    if (evidence.xbrlSha256 !== createHash('sha256').update(xml).digest('hex')) {
      issues.push(`${item.source_document_id}:xbrl_hash_mismatch`); continue
    }
    const reader = new XbrlFactReader(xml)
    const issuer = reader.facts.find((fact) => fact.localName === 'EDINETCodeDEI')?.textValue
    if (issuer !== item.issuer_edinet_code) issues.push(`${item.source_document_id}:issuer_mismatch`)
    const block = reader.facts.find((fact) => fact.localName === 'IssuedSharesTotalNumberOfSharesEtcTextBlock'
      && fact.contextRef === 'FilingDateInstant')
    if (!block || evidence.tableSha256 !== createHash('sha256').update(block.value).digest('hex')) {
      issues.push(`${item.source_document_id}:issued_table_mismatch`); continue
    }
    const classes = JSON.parse(String(item.classes_json)) as { name: string; dimension: string;
      issuedUnits: number; quantityUnit: string; listedExchange: string | null }[]
    const independentlyEnumerated = reader.facts.filter((fact) =>
      fact.localName === 'ClassIssuedSharesTotalNumberOfSharesEtc'
      && fact.contextRef.startsWith('FilingDateInstant_') && !fact.isNil)
    if (independentlyEnumerated.length !== classes.length) issues.push(`${item.source_document_id}:class_count`)
    for (const entry of classes) {
      const fact = independentlyEnumerated.find((candidate) =>
        candidate.context?.dimensions.some((dimension) => dimension.member === entry.dimension))
      const units = reader.facts.find((candidate) =>
        candidate.localName === 'NumberOfIssuedSharesAsOfFilingDateIssuedSharesTotalNumberOfSharesEtc'
        && candidate.contextRef === fact?.contextRef)
      if (!fact || fact.textValue.normalize('NFKC').trim() !== entry.name || !units
        || units.numericValue !== entry.issuedUnits || units.unit?.label !== 'xbrli:shares'
        || entry.quantityUnit !== 'SHARE' || !entry.listedExchange) {
        issues.push(`${item.source_document_id}:class_or_unit`)
      }
    }
    statutoryChecked++
  }
  const negative = (await listEdinetDocuments('2026-07-21')).find((row) =>
    row.edinetCode === 'E00414' && row.docTypeCode === '120')
  let multipleClassNegative = false
  if (negative) {
    const facts = new XbrlFactReader(await downloadEdinetPublicXbrl(negative.docID)).facts
    const classes = facts.filter((fact) => fact.localName === 'ClassIssuedSharesTotalNumberOfSharesEtc'
      && fact.contextRef.startsWith('FilingDateInstant_') && !fact.isNil)
    multipleClassNegative = classes.some((fact) => /普通株式/.test(fact.textValue))
      && classes.some((fact) => /優先株式/.test(fact.textValue))
    if (!multipleClassNegative) issues.push('E00414:real_multiple_class_negative_missing')
  }
  const reit = (await listEdinetDocuments('2026-05-28')).find((row) =>
    row.edinetCode === 'E27884' && row.docTypeCode === '120')
  let reitUnits: number | null = null
  if (reit) {
    const facts = new XbrlFactReader(await downloadEdinetPublicXbrl(reit.docID)).facts
    const text = facts.find((fact) => fact.localName === 'PaidInCapitalOfInvestmentCorporationTextBlock'
      && fact.contextRef === 'FilingDateInstant')?.textValue.normalize('NFKC') ?? ''
    const found = text.match(/発行済投資口の総口数\s*([\d,]+)\s*口/)
    if (found) reitUnits = Number(found[1].replaceAll(',', ''))
    if (reitUnits !== 973_670) issues.push('E27884:investment_unit_discrepancy')
  }
  const distribution = (await client.execute(`SELECT certification_method,public_status,
    COUNT(*) AS positions FROM large_holder_position_certifications
    GROUP BY certification_method,public_status ORDER BY certification_method`)).rows
  const prices = (await client.execute(`SELECT COUNT(*) AS total,
    SUM(CASE WHEN abs(local_close-adjusted_close)>max(0.01,adjusted_close*0.0001)
      THEN 1 ELSE 0 END) AS inconsistent FROM large_holder_price_evidence`)).rows[0]
  console.log(JSON.stringify({ codeListChecks: bridges.length, statutoryChecks: statutoryChecked,
    multipleClassNegative, reitUnits, certificationDistribution: distribution,
    priceEvidenceRows: prices?.total, localPriceDiscrepancies: prices?.inconsistent,
    errors: issues, elapsedMs: Date.now() - started, peakRssBytes: process.memoryUsage().rss }, null, 2))
  if (issues.length || bridges.length < 50 || statutoryChecked < 30 || !multipleClassNegative) process.exitCode = 1
}

main().catch((error) => { console.error(error); process.exitCode = 1 })
