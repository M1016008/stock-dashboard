import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
// @ts-expect-error The pinned Node types predate Node 24's built-in SQLite module.
import { DatabaseSync } from 'node:sqlite'
import { anyStorageFatal, anyStorageUncertain } from '@/lib/storage/external-storage-guard'
import { readPublishedPointer, readSnapshotFile } from '@/lib/large-holders/snapshot-publication'
import { reviewQueue } from '@/lib/large-holders/entity-review'
import { largeHolderAdminAuthorized } from '@/lib/server/large-holders/review-admin'
import { documentDisposition } from '@/lib/large-holders/source-quarantine'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(request: Request) {
  if (!largeHolderAdminAuthorized(request))
    return Response.json({ error: 'admin_authorization_required' }, { status: 403 })
  const dbPath = process.env.STOCKBOARD_DB_PATH
  if (!dbPath) return Response.json({ error: 'database_not_configured' }, { status: 503 })
  try {
    const pointerPath = process.env.LARGE_HOLDER_RANKING_CURRENT_PATH
    const publication = pointerPath ? await readPublishedPointer(pointerPath) : null
    const legacyPath = process.env.LARGE_HOLDER_RANKING_SNAPSHOT_PATH
    const snapshotPath = pointerPath && publication
      ? join(dirname(pointerPath), `${publication.snapshotId}.json`)
      : legacyPath
    const snapshot = snapshotPath ? (await readSnapshotFile(snapshotPath)).snapshot : null
    const db = new DatabaseSync(dbPath, { readOnly: true })
    db.exec('PRAGMA query_only=ON')
    let source: Record<string, unknown>
    try {
      const filings = db.prepare(`SELECT COUNT(*) AS total,
        SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) AS failed,
        SUM(CASE WHEN status='review' THEN 1 ELSE 0 END) AS review,
        MAX(submitted_at) AS latestSubmittedAt,
        MAX(imported_at) AS latestImportedAt FROM large_holder_filings`).get() as Record<string, unknown>
      const market = db.prepare('SELECT MAX(date) AS date FROM ohlcv_daily').get() as Record<string, unknown>
      const price = db.prepare('SELECT MAX(price_date) AS date FROM large_holder_price_evidence').get() as Record<string, unknown>
      const unresolved = db.prepare(`SELECT COUNT(*) AS count FROM large_holder_filings
        WHERE status IN ('failed','review','review_required_source_inconsistency')
          AND filing_type='CORRECTION'`).get() as Record<string, unknown>
      const qualityRows = db.prepare(`SELECT f.document_id,f.ticker,f.issuer_name,
        f.submitted_at,f.status,f.error_message,f.source_url,f.raw_parsed_payload_json,
        s.xbrl_sha256 FROM large_holder_filings f
        LEFT JOIN large_holder_source_documents s USING(document_id)
        WHERE f.status IN ('quarantined_source_inconsistency',
          'review_required_source_inconsistency','failed','review') ORDER BY f.submitted_at DESC`)
        .all() as Record<string, unknown>[]
      source = { filings, marketDate: market.date ?? null, priceEvidenceDate: price.date ?? null,
        unresolvedCorrections: Number(unresolved.count ?? 0),
        sourceQualityReview: qualityRows.map((row) => {
          const record = row.raw_parsed_payload_json
            ? JSON.parse(String(row.raw_parsed_payload_json)) as Record<string, unknown> : null
          return { documentId: row.document_id, ticker: row.ticker, issuer: row.issuer_name,
            submittedAt: row.submitted_at, disposition: documentDisposition(String(row.status)),
            reason: record?.reasonCode ?? row.error_message,
            coverDeclaredCount: record?.coverDeclaredCount ?? null,
            parsedLegalHolderCount: record?.parsedLegalHolderCount ?? null,
            rawAxisMemberCount: record?.rawAxisMemberCount ?? null,
            rawSourceSha256: row.xbrl_sha256 ?? record?.sourceSha256 ?? null,
            reviewStatus: record?.reviewStatus ?? 'UNREVIEWED',
            affectedHolderMembers: record?.affectedHolderMembers ?? [], sourceUrl: row.source_url }
        }) }
    } finally { db.close() }
    const eventsPath = join(process.env.LARGE_HOLDER_OPERATIONS_DIR
      ?? join(homedir(), 'Library', 'Application Support', 'StockBoard', 'large-holder-operations'), 'events.ndjson')
    const text = await readFile(eventsPath, 'utf8').catch((error) => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return ''
      throw error
    })
    const events = text.split('\n').filter(Boolean).slice(-100).map((line) => JSON.parse(line) as {
      at: string; stage: string; status: string; detail?: Record<string, unknown> })
    const queue = snapshot ? reviewQueue(snapshot) : []
    return Response.json({ snapshotId: publication?.snapshotId ?? null,
      snapshotGeneratedAt: publication?.generatedAt ?? null, snapshotStatus: publication?.status ?? 'LEGACY',
      source, storage: { failedSafe: anyStorageFatal(), probeUncertain: anyStorageUncertain() },
      lastSuccess: events.filter((row) => row.status === 'PASS').at(-1) ?? null,
      lastError: events.filter((row) => row.status === 'FAILED').at(-1) ?? null,
      recentEvents: events.slice(-12), quality: {
        unclassifiedInvestors: snapshot?.investors.filter((row) => row.investorClass === 'UNCLASSIFIED').length ?? null,
        ambiguousEntities: queue.filter((row) => row.reasons.includes('SAME_NAME_DISTINCT_CANDIDATE')).length,
        valuationUnavailable: snapshot?.currentPositionCount != null
          ? snapshot.currentPositionCount - snapshot.publicCurrentValuationReadyCount : null,
        parseFailures: Number((source.filings as Record<string, unknown>).failed ?? 0),
      } }, { headers: { 'Cache-Control': 'no-store' } })
  } catch { return Response.json({ error: 'operations_health_unavailable' }, { status: 503 }) }
}
