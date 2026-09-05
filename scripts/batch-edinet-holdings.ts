// EDINET API v2 の有価証券報告書・大量保有報告書を日次差分で取り込み、
// 個別銘柄の概要で使う大株主、政策保有株式、大量保有報告を保存する。

import { unzipSync } from 'fflate'
import { client, ensureReady } from '@/lib/db/client'
import {
  parseLargeHolding,
  parseMajorShareholders,
  parsePolicyHoldings,
} from '@/lib/edinet-xbrl'
import { XbrlFactReader } from '@/lib/edinet-xbrl-facts'

const API_BASE = 'https://api.edinet-fsa.go.jp/api/v2'
const LOOKBACK_DAYS = Math.max(1, Number(process.env.EDINET_LOOKBACK_DAYS ?? 7))
const MAX_DOCUMENTS = Math.max(1, Number(process.env.EDINET_MAX_DOCUMENTS ?? 80))
const RATE_LIMIT_MS = Math.max(0, Number(process.env.EDINET_RATE_LIMIT_MS ?? 650))
const MAX_ARCHIVE_BYTES = Math.max(
  5 * 1024 * 1024,
  Number(process.env.EDINET_MAX_ARCHIVE_BYTES ?? 50 * 1024 * 1024),
)

type EdinetDocument = {
  docID: string
  edinetCode?: string | null
  secCode?: string | null
  filerName?: string | null
  docTypeCode?: string | null
  submitDateTime?: string | null
  periodEnd?: string | null
  withdrawalStatus?: string | null
  xbrlFlag?: string | null
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

function dateDaysAgo(days: number): string {
  const date = new Date()
  date.setUTCDate(date.getUTCDate() - days)
  return date.toISOString().slice(0, 10)
}

function tickerFromSecCode(secCode?: string | null): string | null {
  if (!secCode) return null
  const value = secCode.trim()
  if (!/^[0-9A-Z]{5}$/.test(value)) return null
  return value.endsWith('0') ? value.slice(0, -1) : value
}

async function listDocuments(date: string, apiKey: string): Promise<EdinetDocument[]> {
  const params = new URLSearchParams({ date, type: '2', 'Subscription-Key': apiKey })
  const response = await fetch(`${API_BASE}/documents.json?${params}`)
  if (!response.ok) throw new Error(`EDINET documents date=${date}: ${response.status}`)
  const payload = await response.json() as { results?: EdinetDocument[] }
  return payload.results ?? []
}

async function downloadXbrl(documentId: string, apiKey: string): Promise<string> {
  const params = new URLSearchParams({ type: '1', 'Subscription-Key': apiKey })
  const response = await fetch(`${API_BASE}/documents/${encodeURIComponent(documentId)}?${params}`)
  if (!response.ok) throw new Error(`EDINET document ${documentId}: ${response.status}`)
  const contentLength = Number(response.headers.get('content-length') ?? 0)
  if (contentLength > MAX_ARCHIVE_BYTES) {
    throw new Error(`archive too large: ${contentLength} bytes`)
  }
  const bytes = new Uint8Array(await response.arrayBuffer())
  if (bytes.byteLength > MAX_ARCHIVE_BYTES) {
    throw new Error(`archive too large: ${bytes.byteLength} bytes`)
  }
  const files = unzipSync(bytes, {
    filter: (file) => /XBRL\/PublicDoc\/.*\.xbrl$/i.test(file.name),
  })
  const candidates = Object.entries(files).sort((a, b) => b[1].byteLength - a[1].byteLength)
  if (candidates.length === 0) throw new Error('PublicDoc XBRL not found')
  return new TextDecoder('utf-8').decode(candidates[0][1])
}

async function alreadyProcessed(documentId: string): Promise<boolean> {
  const result = await client.execute({
    sql: `SELECT status FROM edinet_documents WHERE document_id = ?`,
    args: [documentId],
  })
  return ['ready', 'no_data'].includes(String(result.rows[0]?.status ?? ''))
}

async function saveDocumentStatus(
  document: EdinetDocument,
  ticker: string,
  status: string,
  errorMessage: string | null,
) {
  await client.execute({
    sql: `
      INSERT INTO edinet_documents (
        document_id, ticker, document_type, submitted_at, period_end,
        filer_name, status, error_message, processed_at, imported_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, unixepoch(), unixepoch())
      ON CONFLICT(document_id) DO UPDATE SET
        ticker = excluded.ticker,
        document_type = excluded.document_type,
        submitted_at = excluded.submitted_at,
        period_end = excluded.period_end,
        filer_name = excluded.filer_name,
        status = excluded.status,
        error_message = excluded.error_message,
        processed_at = excluded.processed_at,
        imported_at = excluded.imported_at
    `,
    args: [
      document.docID,
      ticker,
      document.docTypeCode ?? 'unknown',
      document.submitDateTime ?? null,
      document.periodEnd ?? null,
      document.filerName ?? null,
      status,
      errorMessage,
    ],
  })
}

async function updateDatasetStatus(
  ticker: string,
  dataset: string,
  status: string,
  sourceDate: string | null,
  message: string | null,
) {
  await client.execute({
    sql: `
      INSERT INTO stock_external_data_status
        (ticker, dataset, status, source_date, message, attempted_at)
      VALUES (?, ?, ?, ?, ?, unixepoch())
      ON CONFLICT(ticker, dataset) DO UPDATE SET
        status = excluded.status,
        source_date = excluded.source_date,
        message = excluded.message,
        attempted_at = excluded.attempted_at
    `,
    args: [ticker, dataset, status, sourceDate, message],
  })
}

async function processAnnualReport(document: EdinetDocument, ticker: string, xml: string) {
  const reader = new XbrlFactReader(xml)
  const major = parseMajorShareholders(reader)
  const policy = parsePolicyHoldings(reader)
  const statements: Array<{ sql: string; args: Array<string | number | null> }> = [
    { sql: `DELETE FROM major_shareholders WHERE document_id = ?`, args: [document.docID] },
    { sql: `DELETE FROM policy_holdings WHERE document_id = ?`, args: [document.docID] },
  ]
  major.forEach((row, index) => statements.push({
    sql: `
      INSERT INTO major_shareholders (
        ticker, document_id, rank, fiscal_year_end, holder_name, shares,
        holding_ratio, submitted_at, source, imported_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'edinet', unixepoch())
    `,
    args: [
      ticker, document.docID, index + 1, document.periodEnd ?? null, row.holderName,
      row.shares, row.holdingRatio, document.submitDateTime ?? null,
    ],
  }))
  policy.forEach((row, index) => statements.push({
    sql: `
      INSERT INTO policy_holdings (
        ticker, document_id, rank, fiscal_year_end, issuer_name, shares, book_value,
        purpose, quantitative_effect, holding_type, submitted_at, source, imported_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'edinet', unixepoch())
    `,
    args: [
      ticker, document.docID, index + 1, document.periodEnd ?? null, row.issuerName,
      row.shares, row.bookValue, row.purpose, row.quantitativeEffect, row.holdingType,
      document.submitDateTime ?? null,
    ],
  }))
  await client.batch(statements)
  await updateDatasetStatus(
    ticker,
    'major_shareholders',
    major.length > 0 ? 'ready' : 'no_data',
    document.periodEnd ?? null,
    major.length > 0 ? null : '最新の有価証券報告書に抽出可能な大株主情報がありません。',
  )
  await updateDatasetStatus(
    ticker,
    'policy_holdings',
    policy.length > 0 ? 'ready' : 'no_data',
    document.periodEnd ?? null,
    policy.length > 0 ? null : '最新の有価証券報告書に抽出可能な政策保有株式がありません。',
  )
  return major.length + policy.length
}

async function processLargeHolding(document: EdinetDocument, ticker: string, xml: string) {
  const row = parseLargeHolding(xml, document.filerName)
  await client.execute({
    sql: `
      INSERT INTO large_holding_reports (
        ticker, document_id, submitted_at, report_date, holder_name, shares,
        holding_ratio, previous_holding_ratio, purpose, report_kind, source, imported_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'edinet', unixepoch())
      ON CONFLICT(ticker, document_id) DO UPDATE SET
        submitted_at = excluded.submitted_at,
        report_date = excluded.report_date,
        holder_name = excluded.holder_name,
        shares = excluded.shares,
        holding_ratio = excluded.holding_ratio,
        previous_holding_ratio = excluded.previous_holding_ratio,
        purpose = excluded.purpose,
        report_kind = excluded.report_kind,
        imported_at = excluded.imported_at
    `,
    args: [
      ticker,
      document.docID,
      document.submitDateTime ?? null,
      document.submitDateTime?.slice(0, 10) ?? null,
      row.holderName,
      row.shares,
      row.holdingRatio,
      row.previousHoldingRatio,
      row.purpose,
      row.reportKind,
    ],
  })
  await updateDatasetStatus(
    ticker,
    'large_holding_reports',
    'ready',
    document.submitDateTime?.slice(0, 10) ?? null,
    null,
  )
  return 1
}

async function main() {
  await ensureReady()
  const apiKey = process.env.EDINET_API_KEY
  if (!apiKey) {
    console.warn('EDINET_API_KEY is not configured; EDINET holdings refresh skipped.')
    return
  }

  const documents: EdinetDocument[] = []
  for (let offset = LOOKBACK_DAYS - 1; offset >= 0; offset--) {
    documents.push(...await listDocuments(dateDaysAgo(offset), apiKey))
    if (RATE_LIMIT_MS > 0) await sleep(RATE_LIMIT_MS)
  }
  const targets = documents
    .filter((document) => (
      ['120', '350'].includes(document.docTypeCode ?? '')
      && document.withdrawalStatus !== '1'
      && document.xbrlFlag !== '0'
      && tickerFromSecCode(document.secCode)
    ))
    .sort((a, b) => (a.submitDateTime ?? '').localeCompare(b.submitDateTime ?? ''))

  let processed = 0
  let rowsInserted = 0
  let failed = 0
  for (const document of targets) {
    if (processed >= MAX_DOCUMENTS) break
    if (await alreadyProcessed(document.docID)) continue
    const ticker = tickerFromSecCode(document.secCode)
    if (!ticker) continue
    processed++
    try {
      const xml = await downloadXbrl(document.docID, apiKey)
      const inserted = document.docTypeCode === '120'
        ? await processAnnualReport(document, ticker, xml)
        : await processLargeHolding(document, ticker, xml)
      rowsInserted += inserted
      await saveDocumentStatus(document, ticker, inserted > 0 ? 'ready' : 'no_data', null)
    } catch (error) {
      failed++
      const message = error instanceof Error ? error.message : String(error)
      await saveDocumentStatus(document, ticker, 'failed', message.slice(0, 500))
      console.error(`${document.docID} (${ticker}) failed: ${message}`)
    }
    if (RATE_LIMIT_MS > 0) await sleep(RATE_LIMIT_MS)
  }

  console.log(JSON.stringify({ candidates: targets.length, processed, rowsInserted, failed }))
}

main().catch((error) => {
  console.error('batch-edinet-holdings failed:', error)
  process.exit(1)
})
