import { client, ensureReady } from '@/lib/db/client'
import { isLargeHolderDocument, parseLargeHolderFiling } from '@/lib/large-holders/filing'
import { downloadEdinetPublicXbrl, listEdinetDocuments } from '@/lib/server/edinet-api'
import { LARGE_HOLDER_PARSER_VERSION, recordLargeHolderWithdrawal, storeLargeHolderFiling } from '@/lib/server/large-holders/ingest'
import { resolveCorrectionAncestors } from '@/lib/server/large-holders/resolve-document'

const flags = new Map(process.argv.slice(2).map((arg) => {
  const [name, ...value] = arg.split('=')
  return [name, value.join('=')]
}))
const from = flags.get('--from')
const to = flags.get('--to') ?? from
const limit = Number(flags.get('--limit') ?? 80)
if (!from || !to || !/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)
    || from > to || !Number.isInteger(limit) || limit < 1 || limit > 1000) {
  throw new Error('Usage: --from=YYYY-MM-DD [--to=YYYY-MM-DD] [--limit=1..1000] [--dry-run]')
}
const dryRun = flags.has('--dry-run')

async function main(): Promise<void> {
  if (!dryRun) await ensureReady()
  let processed = 0
  let examined = 0
  let skipped = 0
  let failed = 0
  let review = 0
  let withdrawals = 0
  let resolvedOrigins = 0
  const indexCache = new Map<string, Awaited<ReturnType<typeof listEdinetDocuments>>>()
  const end = new Date(`${to}T00:00:00Z`)
  for (let day = new Date(`${from}T00:00:00Z`); day <= end; day.setUTCDate(day.getUTCDate() + 1)) {
    if (examined >= limit) break
    const indexDate = day.toISOString().slice(0, 10)
    const indexRows = await listEdinetDocuments(indexDate)
    if (!dryRun) {
      for (const indexRow of indexRows) {
        if (indexRow.withdrawalStatus === '1' && indexRow.parentDocID && indexRow.submitDateTime) {
          await recordLargeHolderWithdrawal(indexRow.parentDocID, indexRow.submitDateTime)
          withdrawals += 1
        } else if (indexRow.withdrawalStatus === '2') {
          if (indexRow.opeDateTime) {
            await recordLargeHolderWithdrawal(indexRow.docID, indexRow.opeDateTime)
            withdrawals += 1
          } else {
            await client.execute({
              sql: `UPDATE large_holder_filings SET status='review',
                error_message='withdrawal_time_unresolved' WHERE document_id=?`,
              args: [indexRow.docID],
            })
          }
        }
      }
    }
    const documents = indexRows.filter(isLargeHolderDocument)
    for (const row of documents) {
      if (examined >= limit) break
      examined += 1
      if (!dryRun) {
        const previous = await client.execute({
          sql: 'SELECT parser_version, status FROM large_holder_filings WHERE document_id = ?',
          args: [row.docID],
        })
        if (previous.rows[0]?.parser_version === LARGE_HOLDER_PARSER_VERSION
            && ['ready', 'review'].includes(String(previous.rows[0]?.status))) {
          skipped += 1
          continue
        }
      }
      processed += 1
      try {
        const xml = await downloadEdinetPublicXbrl(row.docID)
        const filing = parseLargeHolderFiling(row, xml)
        if (filing.filingType === 'AMENDMENT') {
          const ancestors = await resolveCorrectionAncestors(filing, indexCache)
          for (const ancestor of ancestors) {
            if (!dryRun) await storeLargeHolderFiling(ancestor.row, ancestor.filing, ancestor.xml)
            resolvedOrigins += 1
          }
        }
        if (dryRun) {
          console.log(JSON.stringify({ documentId: row.docID, type: filing.filingType,
            issuerCode: filing.issuerSecurityCode, participants: filing.holders.length,
            correctedDocumentId: filing.correctedDocumentId, valuationEligible: filing.holders.filter((h) => h.valuationEligibleShares != null).length }))
        } else if (await storeLargeHolderFiling(row, filing, xml) === 'review') review += 1
      } catch (error) {
        failed += 1
        const message = error instanceof Error ? error.message : String(error)
        console.error(`${row.docID} parse/store failed: ${message}`)
        if (!dryRun) await client.execute({
          sql: `INSERT INTO large_holder_filings
            (document_id, filing_type, submitted_at, issuer_edinet_code, source_url,
              raw_index_json, parser_version, status, error_message)
            VALUES (?, ?, ?, ?, ?, ?, ?, 'failed', ?)
            ON CONFLICT(document_id) DO UPDATE SET
              status=CASE WHEN large_holder_filings.status IN ('ready','withdrawn')
                THEN large_holder_filings.status ELSE 'failed' END,
              error_message=excluded.error_message`,
          args: [row.docID, row.docTypeCode === '360' ? 'AMENDMENT' : 'UNPARSED',
            row.submitDateTime ?? indexDate, row.issuerEdinetCode ?? null,
            `https://disclosure2.edinet-fsa.go.jp/WZEK0040.aspx?${encodeURIComponent(row.docID)}`,
            JSON.stringify(row), LARGE_HOLDER_PARSER_VERSION, message.slice(0, 300)],
        })
      }
      await new Promise((resolve) => setTimeout(resolve, 650))
    }
  }
  console.log(JSON.stringify({ examined, processed, skipped, failed, review, withdrawals, resolvedOrigins, dryRun }))
  if (failed > 0) process.exitCode = 1
}

main().catch((error) => {
  console.error('Large holder ingestion failed:', error instanceof Error ? error.message : 'unknown')
  process.exitCode = 1
})
