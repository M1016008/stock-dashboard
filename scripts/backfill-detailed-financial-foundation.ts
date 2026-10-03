import { XbrlFactReader } from '@/lib/edinet-xbrl-facts'
import {
  analyzeDetailedConceptGaps,
  parseEdinetDetailedFinancialFacts,
  type DetailedConceptGapReport,
} from '@/lib/detailed-financial-foundation'
import { client, ensureReady } from '@/lib/db/client'
import {
  downloadEdinetPublicXbrl,
  isAnnualSecuritiesReport,
  listEdinetDocuments,
  tickerFromEdinetSecurityCode,
  type EdinetDocumentIndexRow,
} from '@/lib/server/edinet-api'
import {
  detailedFinancialDocumentExists,
  saveDetailedFinancialFacts,
} from '@/lib/server/detailed-financial-foundation-store'
import { calculateAndStoreAdvancedFinancialMetrics } from '@/lib/server/detailed-financial-metrics'

const RATE_LIMIT_MS = Math.max(0, Number(process.env.DETAIL_FIN_RATE_LIMIT_MS ?? 650))
const MAX_DOCUMENTS = Math.max(1, Number(process.env.DETAIL_FIN_MAX_DOCUMENTS ?? 10_000))
const FORCE = process.env.DETAIL_FIN_FORCE === '1'
const PROGRESS_EVERY = Math.max(1, Number(process.env.DETAIL_FIN_PROGRESS_EVERY ?? 50))
const WORKERS = Math.min(4, Math.max(1, Number(process.env.DETAIL_FIN_WORKERS ?? 3)))
const REPROCESSABLE_GAP_CONCEPTS = new Set([
  'BorrowingsCLIFRS',
  'BorrowingsNCLIFRS',
  'DepreciationAndOtherAmortizationOpeCF',
  'PurchaseOfPropertyPlantAndEquipmentAndIntangibleAssetsInvCFIFRS',
])

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10)
}

function dateRange(from: string, to: string): string[] {
  const output: string[] = []
  const cursor = new Date(`${from}T00:00:00Z`)
  const end = new Date(`${to}T00:00:00Z`)
  while (cursor <= end) {
    output.push(isoDate(cursor))
    cursor.setUTCDate(cursor.getUTCDate() + 1)
  }
  return output
}

function requestedDates(): string[] {
  const explicit = process.env.DETAIL_FIN_DOCUMENT_DATES?.split(',').map((value) => value.trim()).filter(Boolean)
  if (explicit?.length) return [...new Set(explicit)].sort()
  const end = process.env.DETAIL_FIN_TO?.trim() || isoDate(new Date())
  const defaultStart = new Date(`${end}T00:00:00Z`)
  defaultStart.setUTCDate(defaultStart.getUTCDate() - 450)
  const start = process.env.DETAIL_FIN_FROM?.trim() || isoDate(defaultStart)
  return dateRange(start, end)
}

type UniverseTicker = {
  ticker: string
  name: string
  marketSegment: string
  sector17Name: string
  sector33Name: string
}

type ScopeClassification = {
  status: 'eligible' | 'financial' | 'fund_etf' | 'reit' | 'preferred' | 'foreign' | 'other_security'
  eligibleForEdinet: boolean
  eligibleForAdvancedMetrics: boolean
  reason: string
}

function classifyScope(row: UniverseTicker): ScopeClassification {
  const text = `${row.name} ${row.marketSegment} ${row.sector17Name} ${row.sector33Name}`.toLowerCase()
  if (/etf|ｅｔｆ|etn|ｅｔｎ|上場投信|上場投資信託|投資信託|投信投資顧問|指数連動証券/i.test(text)) {
    return { status: 'fund_etf', eligibleForEdinet: false, eligibleForAdvancedMetrics: false, reason: 'ETF・ETN・ファンド' }
  }
  if (/投資法人|reit|ｒｅｉｔ|リート/i.test(text)) {
    return { status: 'reit', eligibleForEdinet: false, eligibleForAdvancedMetrics: false, reason: 'REIT・投資法人' }
  }
  if (/優先株式|優先株/.test(text)) {
    return { status: 'preferred', eligibleForEdinet: false, eligibleForAdvancedMetrics: false, reason: '優先株式' }
  }
  if (/外国株|foreign stock/i.test(text)) {
    return { status: 'foreign', eligibleForEdinet: false, eligibleForAdvancedMetrics: false, reason: '外国株' }
  }
  if (row.marketSegment === 'その他') {
    return { status: 'other_security', eligibleForEdinet: false, eligibleForAdvancedMetrics: false, reason: '市場区分「その他」の非普通株商品' }
  }
  if (/銀行|保険|証券|金融/.test(`${row.sector17Name} ${row.sector33Name}`)) {
    return { status: 'financial', eligibleForEdinet: true, eligibleForAdvancedMetrics: false, reason: '金融業のため通常企業向け高度指標は対象外' }
  }
  return { status: 'eligible', eligibleForEdinet: true, eligibleForAdvancedMetrics: true, reason: '通常企業' }
}

async function targetUniverse(): Promise<Map<string, UniverseTicker>> {
  const explicit = process.env.DETAIL_FIN_TICKERS?.split(',')
    .map((ticker) => ticker.trim().replace(/\.T$/i, ''))
    .filter(Boolean)
  const result = await client.execute({
    sql: `
    SELECT ticker, name, market_segment, sector17_name, sector33_name
    FROM ticker_universe
    WHERE active = 1 ${explicit?.length ? `AND ticker IN (${explicit.map(() => '?').join(',')})` : ''}
    ORDER BY ticker
  `,
    args: explicit ?? [],
  })
  return new Map(result.rows.map((row) => {
    const ticker = String(row.ticker).replace(/\.T$/i, '')
    return [ticker, {
      ticker,
      name: String(row.name ?? ''),
      marketSegment: String(row.market_segment ?? ''),
      sector17Name: String(row.sector17_name ?? ''),
      sector33Name: String(row.sector33_name ?? ''),
    }]
  }))
}

async function checkpoint(
  checkpointType: string,
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
    args: [checkpointType, key, status, sourceRows, persistedRows, JSON.stringify(details), errorMessage],
  })
}

async function documentAlreadyProcessed(documentId: string): Promise<boolean> {
  const result = await client.execute({
    sql: `
      SELECT status, details_json FROM financial_foundation_backfill_checkpoints
      WHERE checkpoint_type = 'detailed_financial' AND checkpoint_key = ?
      LIMIT 1
    `,
    args: [documentId],
  })
  const checkpointRow = result.rows[0]
  if (checkpointRow) {
    try {
      const details = JSON.parse(String(checkpointRow.details_json ?? '{}')) as { conceptGaps?: Record<string, string[]> }
      const needsReprocessing = Object.values(details.conceptGaps ?? {}).flat().some((concept) => (
        REPROCESSABLE_GAP_CONCEPTS.has(concept.split(':').at(-1) ?? '')
      ))
      if (needsReprocessing) return false
    } catch {
      // A malformed diagnostic must not invalidate an otherwise persisted document.
    }
  }
  if (await detailedFinancialDocumentExists(documentId)) return true
  return ['completed', 'no_data'].includes(String(checkpointRow?.status ?? ''))
}

function mergeConceptGaps(target: DetailedConceptGapReport, source: DetailedConceptGapReport): void {
  for (const [category, concepts] of Object.entries(source)) {
    const current = target[category as keyof DetailedConceptGapReport] ?? []
    target[category as keyof DetailedConceptGapReport] = [...new Set([...current, ...(concepts ?? [])])].sort().slice(0, 40)
  }
}

function latestAnnualDocuments(documents: EdinetDocumentIndexRow[]): EdinetDocumentIndexRow[] {
  const grouped = new Map<string, EdinetDocumentIndexRow[]>()
  for (const document of documents) {
    const ticker = tickerFromEdinetSecurityCode(document.secCode)
    if (!ticker) continue
    const group = grouped.get(ticker) ?? []
    group.push(document)
    grouped.set(ticker, group)
  }
  const selected: EdinetDocumentIndexRow[] = []
  for (const group of grouped.values()) {
    const latestPeriod = group.map((document) => document.periodEnd ?? '').sort().at(-1) ?? ''
    selected.push(...group
      .filter((document) => (document.periodEnd ?? '') === latestPeriod)
      .sort((left, right) => (left.submitDateTime ?? '').localeCompare(right.submitDateTime ?? '')))
  }
  return selected.sort((left, right) => (
    (tickerFromEdinetSecurityCode(left.secCode) ?? '').localeCompare(tickerFromEdinetSecurityCode(right.secCode) ?? '')
    || (left.submitDateTime ?? '').localeCompare(right.submitDateTime ?? '')
  ))
}

async function main() {
  const startedAt = Date.now()
  await ensureReady()
  const universe = await targetUniverse()
  const scopes = new Map([...universe].map(([ticker, row]) => [ticker, classifyScope(row)]))
  const eligibleTickers = new Set([...scopes]
    .filter(([, scope]) => scope.eligibleForEdinet)
    .map(([ticker]) => ticker))

  for (const [ticker, scope] of scopes) {
    if (scope.eligibleForEdinet) continue
    const row = universe.get(ticker)!
    await checkpoint('detailed_financial_ticker', ticker, 'excluded', 0, 0, {
      scope: scope.status,
      reason: scope.reason,
      marketSegment: row.marketSegment,
      sector17Name: row.sector17Name,
      sector33Name: row.sector33Name,
    })
  }

  if (process.env.DETAIL_FIN_SCOPE_ONLY === '1') {
    console.log(JSON.stringify({
      requested: universe.size,
      eligible: eligibleTickers.size,
      excluded: universe.size - eligibleTickers.size,
      scopeOnly: true,
    }, null, 2))
    return
  }

  const dates = requestedDates()
  const documents: EdinetDocumentIndexRow[] = []
  let dateScanErrors = 0
  for (const [index, date] of dates.entries()) {
    try {
      const rows = await listEdinetDocuments(date)
      documents.push(...rows.filter((document) => {
        const ticker = tickerFromEdinetSecurityCode(document.secCode)
        return isAnnualSecuritiesReport(document) && ticker != null && eligibleTickers.has(ticker)
      }))
      await checkpoint('detailed_financial_date', date, 'completed', rows.length, 0, {
        matchedAnnualDocuments: rows.filter((document) => isAnnualSecuritiesReport(document)).length,
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      await checkpoint('detailed_financial_date', date, 'failed', 0, 0, {}, message)
      console.error(`[detailed-financial:index] ${date}: ${message}`)
      dateScanErrors += 1
    }
    if ((index + 1) % 100 === 0) {
      console.log(`[detailed-financial:index] ${index + 1}/${dates.length} dates, ${documents.length} candidate documents`)
    }
    if (RATE_LIMIT_MS > 0 && index < dates.length - 1) await sleep(RATE_LIMIT_MS)
  }
  const allLatestTargets = latestAnnualDocuments(documents)
  const targets = allLatestTargets.slice(0, MAX_DOCUMENTS)
  const limitedRun = targets.length < allLatestTargets.length
  const documentsByTicker = new Map<string, EdinetDocumentIndexRow[]>()
  for (const document of targets) {
    const ticker = tickerFromEdinetSecurityCode(document.secCode)!
    const group = documentsByTicker.get(ticker) ?? []
    group.push(document)
    documentsByTicker.set(ticker, group)
  }

  let processed = 0
  let skipped = 0
  let failed = 0
  let apiErrors = 0
  let xbrlErrors = 0
  let persistedFacts = 0
  let calculatedMetrics = 0
  let noReport = 0
  let completedTickers = 0
  let completedWork = 0
  let nextWorkIndex = 0
  let nextDownloadAt = 0
  let downloadGate = Promise.resolve()
  const waitForDownloadSlot = () => {
    const slot = downloadGate.then(async () => {
      const delay = Math.max(0, nextDownloadAt - Date.now())
      if (delay > 0) await sleep(delay)
      nextDownloadAt = Date.now() + RATE_LIMIT_MS
    })
    downloadGate = slot.catch(() => {})
    return slot
  }
  const eligibleEntries = [...universe].filter(([ticker]) => scopes.get(ticker)!.eligibleForEdinet)

  const processTicker = async ([ticker, row]: [string, UniverseTicker]) => {
    const scope = scopes.get(ticker)!
    const tickerDocuments = documentsByTicker.get(ticker) ?? []
    if (tickerDocuments.length === 0) {
      if (!limitedRun && dateScanErrors === 0) {
        await checkpoint('detailed_financial_ticker', ticker, 'no_report', 0, 0, {
          scope: scope.status,
          reason: '指定期間内にEDINET有価証券報告書なし',
          marketSegment: row.marketSegment,
          sector17Name: row.sector17Name,
          sector33Name: row.sector33Name,
        })
        noReport += 1
      }
      return
    }
    const conceptGaps: DetailedConceptGapReport = {}
    let tickerFailures = 0
    for (const document of tickerDocuments) {
      if (!FORCE && await documentAlreadyProcessed(document.docID)) {
        skipped += 1
        continue
      }
      try {
        await waitForDownloadSlot()
        const xml = await downloadEdinetPublicXbrl(document.docID)
        const reader = new XbrlFactReader(xml)
        const facts = parseEdinetDetailedFinancialFacts(reader, {
          ticker,
          documentId: document.docID,
          disclosureId: document.docID,
          publishedAt: document.submitDateTime ?? `${document.periodEnd ?? dates.at(-1)}T00:00:00`,
          periodEnd: document.periodEnd ?? '',
          documentType: document.docTypeCode ?? '120',
          correctionStatus: document.docTypeCode === '130' ? 'corrected' : 'original',
        })
        const gaps = analyzeDetailedConceptGaps(reader, facts)
        mergeConceptGaps(conceptGaps, gaps)
        await saveDetailedFinancialFacts(facts, {
          documentType: document.docTypeCode,
          metadata: {
            edinetCode: document.edinetCode ?? null,
            filerName: document.filerName ?? null,
            periodStart: document.periodStart ?? null,
            periodEnd: document.periodEnd ?? null,
            conceptGaps: gaps,
          },
        })
        await checkpoint('detailed_financial', document.docID, facts.length > 0 ? 'completed' : 'no_data', reader.facts.length, facts.length, {
          ticker,
          publishedAt: document.submitDateTime ?? null,
          periodEnd: document.periodEnd ?? null,
          conceptGaps: gaps,
        })
        processed += 1
        persistedFacts += facts.length
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        const errorCategory = /HTTP|request failed|timeout|fetch/i.test(message) ? 'api_error' : 'xbrl_parse_error'
        await checkpoint('detailed_financial', document.docID, 'failed', 0, 0, { ticker, errorCategory }, message)
        console.error(`[detailed-financial] ${ticker} ${document.docID}: ${message}`)
        failed += 1
        tickerFailures += 1
        if (errorCategory === 'api_error') apiErrors += 1
        else xbrlErrors += 1
      }
    }
    let metricCount = 0
    try {
      const result = await calculateAndStoreAdvancedFinancialMetrics(ticker)
      metricCount = result.metrics.length
      calculatedMetrics += metricCount
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.error(`[detailed-financial:metrics] ${ticker}: ${message}`)
      tickerFailures += 1
    }
    const factResult = await client.execute({
      sql: `SELECT COUNT(*) AS count FROM detailed_financial_facts WHERE ticker = ?`,
      args: [ticker],
    })
    const factCount = Number(factResult.rows[0]?.count ?? 0)
    const tickerStatus = tickerFailures > 0
      ? (tickerFailures === tickerDocuments.length ? 'failed' : 'partial')
      : factCount > 0 ? (scope.status === 'financial' ? 'financial_metrics_excluded' : 'completed') : 'no_data'
    await checkpoint('detailed_financial_ticker', ticker, tickerStatus, tickerDocuments.length, factCount, {
      scope: scope.status,
      reason: scope.reason,
      marketSegment: row.marketSegment,
      sector17Name: row.sector17Name,
      sector33Name: row.sector33Name,
      documentIds: tickerDocuments.map((document) => document.docID),
      latestPeriodEnd: tickerDocuments.map((document) => document.periodEnd ?? '').sort().at(-1) ?? null,
      metricCount,
      conceptGaps,
    })
    if (tickerStatus === 'completed' || tickerStatus === 'financial_metrics_excluded') completedTickers += 1
  }

  const worker = async () => {
    while (true) {
      const workIndex = nextWorkIndex
      nextWorkIndex += 1
      if (workIndex >= eligibleEntries.length) return
      await processTicker(eligibleEntries[workIndex])
      completedWork += 1
      if (completedWork % PROGRESS_EVERY === 0) {
        console.log(`[detailed-financial] ${completedWork}/${eligibleTickers.size} eligible tickers; documents ${processed} processed, ${skipped} reused, ${failed} failed`)
      }
    }
  }
  await Promise.all(Array.from({ length: WORKERS }, () => worker()))
  console.log(JSON.stringify({
    source: 'edinet_xbrl',
    sourcePolicy: 'J-Quants details primary when subscribed; EDINET current fallback; no source averaging',
    requestedTickers: universe.size,
    eligibleEdinetTickers: eligibleTickers.size,
    excludedTickers: universe.size - eligibleTickers.size,
    scannedDates: dates.length,
    dateScanErrors,
    matchedDocuments: targets.length,
    matchedTickers: documentsByTicker.size,
    completedTickers,
    noReport,
    processed,
    skipped,
    failed,
    apiErrors,
    xbrlErrors,
    persistedFacts,
    calculatedMetrics,
    elapsedSeconds: Math.round((Date.now() - startedAt) / 1000),
  }, null, 2))
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
})
