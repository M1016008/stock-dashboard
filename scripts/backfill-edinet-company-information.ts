import { client, ensureReady } from '@/lib/db/client'
import {
  parseCompanyOverview,
  parseEmployeeInformation,
  parseMajorShareholders,
  parseOfficerInformation,
  parsePolicyHoldings,
  parseSegmentInformation,
} from '@/lib/edinet-xbrl'
import { XbrlFactReader } from '@/lib/edinet-xbrl-facts'
import { downloadEdinetPublicXbrl } from '@/lib/server/edinet-api'
import {
  edinetCompanySnapshotExists,
  saveEdinetCompanySnapshot,
} from '@/lib/server/edinet-company-store'

const RATE_LIMIT_MS = Math.max(0, Number(process.env.EDINET_COMPANY_RATE_LIMIT_MS ?? 650))
const MAX_DOCUMENTS = Math.max(1, Number(process.env.EDINET_COMPANY_MAX_DOCUMENTS ?? 10_000))
const WORKERS = Math.min(8, Math.max(1, Number(process.env.EDINET_COMPANY_WORKERS ?? 2)))
const PROGRESS_EVERY = Math.max(1, Number(process.env.EDINET_COMPANY_PROGRESS_EVERY ?? 50))
const FORCE = process.env.EDINET_COMPANY_FORCE === '1'

type SourceDocument = {
  documentId: string
  ticker: string
  companyName: string
  publishedAt: string
  periodEnd: string | null
  accountingStandard: string | null
  correctionStatus: string | null
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

function requestedTickers(): string[] {
  return [...new Set((process.env.EDINET_COMPANY_TICKERS ?? '')
    .split(',')
    .map((value) => value.trim().replace(/\.T$/i, ''))
    .filter(Boolean))]
}

function normalizeAccountingStandard(reader: XbrlFactReader, fallback: string | null): string {
  const raw = reader.latestFact(/^(?:AccountingStandardsDEI|AccountingStandardDEI)$/i)?.textValue
    .toUpperCase() ?? fallback?.toUpperCase() ?? ''
  if (/IFRS|国際財務報告基準/.test(raw)) return 'IFRS'
  if (/US.?GAAP|米国会計基準/.test(raw)) return 'US-GAAP'
  if (/J.?GAAP|日本基準|JAPAN/.test(raw)) return 'J-GAAP'
  return fallback || 'UNKNOWN'
}

function textFact(reader: XbrlFactReader, pattern: RegExp): string | null {
  const value = reader.latestFact(pattern)?.textValue.trim()
  return value || null
}

async function sourceDocuments(): Promise<SourceDocument[]> {
  const explicit = requestedTickers()
  const result = await client.execute({
    sql: `
      WITH detailed_docs AS (
        SELECT
          checkpoint_key AS document_id,
          json_extract(details_json, '$.ticker') AS ticker,
          json_extract(details_json, '$.publishedAt') AS published_at,
          json_extract(details_json, '$.periodEnd') AS period_end
        FROM financial_foundation_backfill_checkpoints
        WHERE checkpoint_type = 'detailed_financial'
          AND status IN ('completed', 'no_data')
      ), metadata AS (
        SELECT
          document_id,
          MAX(accounting_standard) AS accounting_standard,
          MAX(correction_status) AS correction_status
        FROM detailed_financial_facts
        WHERE document_id IS NOT NULL
        GROUP BY document_id
      )
      SELECT
        d.document_id,
        d.ticker,
        u.name,
        d.published_at,
        d.period_end,
        m.accounting_standard,
        m.correction_status
      FROM detailed_docs d
      JOIN ticker_universe u ON u.ticker = d.ticker AND u.active = 1
      LEFT JOIN metadata m ON m.document_id = d.document_id
      WHERE d.ticker IS NOT NULL
        AND d.published_at IS NOT NULL
        ${explicit.length ? `AND d.ticker IN (${explicit.map(() => '?').join(',')})` : ''}
      ORDER BY d.ticker, d.published_at, d.document_id
      LIMIT ?
    `,
    args: [...explicit, MAX_DOCUMENTS],
  })
  return result.rows.map((row) => ({
    documentId: String(row.document_id),
    ticker: String(row.ticker),
    companyName: String(row.name ?? ''),
    publishedAt: String(row.published_at),
    periodEnd: row.period_end == null ? null : String(row.period_end),
    accountingStandard: row.accounting_standard == null ? null : String(row.accounting_standard),
    correctionStatus: row.correction_status == null ? null : String(row.correction_status),
  }))
}

async function checkpoint(
  type: string,
  key: string,
  status: string,
  sourceRows: number,
  persistedRows: number,
  details: Record<string, unknown>,
  errorMessage: string | null = null,
): Promise<void> {
  await client.execute({
    sql: `
      INSERT INTO financial_foundation_backfill_checkpoints (
        checkpoint_type, checkpoint_key, status, source_rows, persisted_rows,
        details_json, error_message, started_at, finished_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, unixepoch(), unixepoch(), unixepoch())
      ON CONFLICT(checkpoint_type, checkpoint_key) DO UPDATE SET
        status = excluded.status,
        source_rows = excluded.source_rows,
        persisted_rows = excluded.persisted_rows,
        details_json = excluded.details_json,
        error_message = excluded.error_message,
        finished_at = excluded.finished_at,
        updated_at = excluded.updated_at
    `,
    args: [type, key, status, sourceRows, persistedRows, JSON.stringify(details), errorMessage],
  })
}

async function updateDatasetStatus(
  ticker: string,
  dataset: string,
  status: string,
  sourceDate: string | null,
  message: string | null,
): Promise<void> {
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

async function main() {
  const startedAt = Date.now()
  await ensureReady()
  const documents = await sourceDocuments()
  if (documents.length === 0) {
    console.log(JSON.stringify({ sourceDocuments: 0, message: '対象書類がありません。' }))
    return
  }

  let nextIndex = 0
  let completed = 0
  let skipped = 0
  let failed = 0
  let apiErrors = 0
  let xbrlErrors = 0
  let lastReportedProgress = 0
  let nextDownloadAt = 0
  let downloadGate = Promise.resolve()
  const waitForDownloadSlot = () => {
    const slot = downloadGate.then(async () => {
      const delay = Math.max(0, nextDownloadAt - Date.now())
      if (delay > 0) await sleep(delay)
      nextDownloadAt = Date.now() + RATE_LIMIT_MS
    })
    downloadGate = slot.catch(() => undefined)
    return slot
  }

  const processDocument = async (document: SourceDocument) => {
    if (!FORCE && await edinetCompanySnapshotExists(document.documentId)) {
      skipped += 1
      return
    }
    try {
      await waitForDownloadSlot()
      const xml = await downloadEdinetPublicXbrl(document.documentId)
      const reader = new XbrlFactReader(xml)
      const overview = parseCompanyOverview(reader)
      const employees = parseEmployeeInformation(reader)
      const officers = parseOfficerInformation(reader)
      const segments = parseSegmentInformation(reader)
      const majorShareholders = parseMajorShareholders(reader)
      const policyHoldings = parsePolicyHoldings(reader)
      const periodStart = textFact(reader, /^(?:CurrentFiscalYearStartDateDEI|CurrentPeriodStartDateDEI)$/i)
      const periodEnd = document.periodEnd
        ?? textFact(reader, /^(?:CurrentFiscalYearEndDateDEI|CurrentPeriodEndDateDEI)$/i)
      const edinetCode = textFact(reader, /^(?:EDINETCodeDEI|FilerEDINETCodeDEI)$/i)
      const filerName = textFact(reader, /^(?:FilerNameInJapaneseDEI|CompanyNameCoverPage)$/i)
        ?? document.companyName
      const accountingStandard = normalizeAccountingStandard(reader, document.accountingStandard)
      const correctionStatus = document.correctionStatus
        ?? (/Correction|訂正/.test(textFact(reader, /^DocumentTypeDEI$/i) ?? '') ? 'corrected' : 'original')

      await saveEdinetCompanySnapshot({
        documentId: document.documentId,
        ticker: document.ticker,
        edinetCode,
        documentType: correctionStatus === 'corrected' ? '130' : '120',
        filerName,
        publishedAt: document.publishedAt,
        periodStart,
        periodEnd,
        accountingStandard,
        correctionStatus,
        xbrlFactCount: reader.facts.length,
        overview,
        employees,
        officers,
        segments,
        majorShareholders,
        policyHoldings,
      })
      const datasets = [
        ['company_overview', Boolean(overview.businessDescription || overview.businessPolicy || overview.companyHistory)],
        ['employee_information', Boolean(employees.consolidated || employees.nonConsolidated)],
        ['officer_information', officers.officers.length > 0],
        ['segment_information', segments.segments.length > 0],
        ['major_shareholders', majorShareholders.length > 0],
        ['policy_holdings', policyHoldings.length > 0],
      ] as const
      for (const [dataset, available] of datasets) {
        await updateDatasetStatus(
          document.ticker,
          dataset,
          available ? 'ready' : 'no_data',
          periodEnd,
          available ? null : '対象有報に構造化して抽出できる情報がありません。',
        )
      }
      const persistedRows = 1 + majorShareholders.length + policyHoldings.length
      await checkpoint('edinet_company_document', document.documentId, 'completed', reader.facts.length, persistedRows, {
        ticker: document.ticker,
        publishedAt: document.publishedAt,
        periodEnd,
        accountingStandard,
        hasOverview: datasets[0][1],
        employeeSnapshots: Number(employees.consolidated != null) + Number(employees.nonConsolidated != null),
        officerCount: officers.officers.length,
        segmentCount: segments.segments.length,
        majorShareholderCount: majorShareholders.length,
        policyHoldingCount: policyHoldings.length,
      })
      completed += 1
    } catch (error) {
      failed += 1
      const message = error instanceof Error ? error.message : String(error)
      const errorCategory = /HTTP|request failed|timeout|fetch/i.test(message) ? 'api_error' : 'xbrl_parse_error'
      if (errorCategory === 'api_error') apiErrors += 1
      else xbrlErrors += 1
      await checkpoint('edinet_company_document', document.documentId, 'failed', 0, 0, {
        ticker: document.ticker,
        errorCategory,
      }, message.slice(0, 1000))
      console.error(`[edinet-company] ${document.ticker} ${document.documentId}: ${message}`)
    }
  }

  const worker = async () => {
    while (true) {
      const index = nextIndex
      nextIndex += 1
      if (index >= documents.length) return
      await processDocument(documents[index])
      const done = completed + skipped + failed
      const reportAt = Math.floor(done / PROGRESS_EVERY) * PROGRESS_EVERY
      if (reportAt > lastReportedProgress) {
        lastReportedProgress = reportAt
        console.log(`[edinet-company] ${done}/${documents.length}; completed=${completed} reused=${skipped} failed=${failed}`)
      }
    }
  }
  await Promise.all(Array.from({ length: WORKERS }, () => worker()))

  const tickers = [...new Set(documents.map((document) => document.ticker))]
  for (const ticker of tickers) {
    const result = await client.execute({
      sql: `
        SELECT COUNT(*) AS snapshots,
          MAX(period_end) AS latest_period_end,
          SUM(has_company_overview) AS overview_rows,
          SUM(CASE WHEN segment_count > 0 THEN 1 ELSE 0 END) AS segment_rows,
          SUM(CASE WHEN employee_snapshot_count > 0 THEN 1 ELSE 0 END) AS employee_rows,
          SUM(CASE WHEN officer_count > 0 THEN 1 ELSE 0 END) AS officer_rows
        FROM edinet_company_snapshots WHERE ticker = ?
      `,
      args: [ticker],
    })
    const row = result.rows[0]
    await checkpoint('edinet_company_ticker', ticker, Number(row?.snapshots ?? 0) > 0 ? 'completed' : 'no_data', documents.filter((doc) => doc.ticker === ticker).length, Number(row?.snapshots ?? 0), {
      latestPeriodEnd: row?.latest_period_end ?? null,
      overviewRows: Number(row?.overview_rows ?? 0),
      segmentRows: Number(row?.segment_rows ?? 0),
      employeeRows: Number(row?.employee_rows ?? 0),
      officerRows: Number(row?.officer_rows ?? 0),
    })
  }

  console.log(JSON.stringify({
    source: 'edinet_xbrl',
    sourceDocuments: documents.length,
    targetTickers: tickers.length,
    completed,
    reused: skipped,
    failed,
    apiErrors,
    xbrlErrors,
    rateLimitMs: RATE_LIMIT_MS,
    workers: WORKERS,
    elapsedSeconds: Math.round((Date.now() - startedAt) / 1000),
  }, null, 2))
}

main().catch((error) => {
  console.error('backfill-edinet-company-information failed:', error instanceof Error ? error.message : String(error))
  process.exit(1)
})
