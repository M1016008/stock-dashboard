import { spawn } from 'node:child_process'
import { closeSync, openSync, readSync, statSync } from 'node:fs'
import { appendFile, mkdir, readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve, sep } from 'node:path'
// @ts-expect-error The pinned Node types predate Node 24's built-in SQLite module.
import { DatabaseSync } from 'node:sqlite'
import { planLargeHolderIndexDay, type StoredLargeHolderDocument } from '@/lib/large-holders/daily-update-plan'
import { LARGE_HOLDER_PARSER_VERSION } from '@/lib/server/large-holders/ingest'
import { POSITION_FINGERPRINT_SQL, type RankingSnapshot } from '@/lib/large-holders/ranking-core'
import { sha256 } from '@/lib/large-holders/evidence-provenance'
import { readPublishedSnapshot, readSnapshotFile, publishValidatedSnapshot,
  writeImmutableSnapshot } from '@/lib/large-holders/snapshot-publication'
import { applyReviewDecisions, reviewDigest } from '@/lib/large-holders/entity-review'
import { readReviewLedger } from '@/lib/server/large-holders/review-ledger'
import { listEdinetDocuments } from '@/lib/server/edinet-api'
import { readLargeHolderSourceState } from '@/lib/server/large-holders/current-fingerprint'
import { closeLocalClientBeforeExternalWriter } from '@/lib/db/client'
import { acquireExclusiveUpdateLock, type UpdateLockHandle } from '@/lib/server/update-lock'
import { guardForDatabase, requiresExternalStorageGuard } from '@/lib/storage/external-storage-guard'

type SourceState = ReturnType<typeof readLargeHolderSourceState>
type OperationEvent = { at: string; stage: string; status: 'STARTED' | 'PASS' | 'FAILED' | 'SKIPPED';
  detail?: Record<string, string | number | boolean | null> }
const command = process.argv[2]
const args = new Map(process.argv.slice(3).map((item) => {
  const [key, ...rest] = item.split('=')
  return [key, rest.join('=')]
}))
const dryRun = args.has('--dry-run')
const dbPath = process.env.STOCKBOARD_DB_PATH
if (!dbPath) throw new Error('STOCKBOARD_DB_PATH required')
const evidenceDir = process.env.LARGE_HOLDER_EVIDENCE_DIR
  ?? join(homedir(), 'Library', 'Application Support', 'StockBoard', 'large-holder-evidence', 'phase-16a8')
const rankingDir = process.env.LARGE_HOLDER_RANKING_DIR ?? join(evidenceDir, 'rankings')
const currentPath = process.env.LARGE_HOLDER_RANKING_CURRENT_PATH ?? join(rankingDir, 'current.json')
const operationsDir = process.env.LARGE_HOLDER_OPERATIONS_DIR
  ?? join(homedir(), 'Library', 'Application Support', 'StockBoard', 'large-holder-operations')
const shadowQa = process.env.PHASE16D_SHADOW_QA === '1'
if (shadowQa) {
  const root = resolve(dbPath, '..')
  if (!root.includes('/stock-dashboard/qa/phase16d-shadow/')
    || !dbPath.endsWith('/shadow.db')
    || ![evidenceDir, rankingDir, currentPath, operationsDir,
      process.env.LARGE_HOLDER_RANKING_SNAPSHOT_PATH,
      process.env.LARGE_HOLDER_REVIEW_LEDGER_PATH, process.env.STOCK_DATA_INCIDENT_DIR]
      .every((value) => value && resolve(value).startsWith(`${root}${sep}`))) {
    throw new Error('phase16d_shadow_boundary_invalid')
  }
}
function shadowPhysicalState(stage: string) {
  if (!shadowQa) return
  const header = Buffer.alloc(100)
  const file = openSync(dbPath!, 'r')
  try { readSync(file, header, 0, header.length, 0) } finally { closeSync(file) }
  console.error(JSON.stringify({ stage, fileBytes: statSync(dbPath!).size,
    headerPages: header.readUInt32BE(28), pageBytes: header.readUInt16BE(16) }))
}
function shadowFailpoint(stage: string) {
  if (shadowQa && process.env.PHASE16D_SHADOW_FAIL_AT === stage)
    throw new Error(`phase16d_shadow_controlled_failure:${stage}`)
}
const todayJst = () => new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Tokyo' })
const datePattern = /^\d{4}-\d{2}-\d{2}$/
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

function storagePreflight() {
  if (requiresExternalStorageGuard(dbPath!)) guardForDatabase(dbPath!).assertWritable(true)
}

function sourceState(): SourceState {
  storagePreflight()
  const db = new DatabaseSync(dbPath!, { readOnly: true })
  db.exec('PRAGMA query_only=ON')
  try { return readLargeHolderSourceState(db, todayJst()) }
  finally { db.close() }
}

async function event(stage: string, status: OperationEvent['status'], detail?: OperationEvent['detail']) {
  if (dryRun) return
  await mkdir(operationsDir, { recursive: true, mode: 0o700 })
  await appendFile(join(operationsDir, 'events.ndjson'),
    `${JSON.stringify({ at: new Date().toISOString(), stage, status, detail } satisfies OperationEvent)}\n`,
    { mode: 0o600 })
}

async function lastEvents(): Promise<OperationEvent[]> {
  const text = await readFile(join(operationsDir, 'events.ndjson'), 'utf8').catch((error) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return ''
    throw error
  })
  return text.trim().split('\n').filter(Boolean).slice(-100).map((line) => JSON.parse(line) as OperationEvent)
}

async function defaultDailyFrom(to: string): Promise<string> {
  const latest = (await lastEvents()).filter((item) => item.stage === 'ingestion'
    && ['PASS', 'SKIPPED'].includes(item.status) && typeof item.detail?.to === 'string').at(-1)
  const anchor = typeof latest?.detail?.to === 'string' ? latest.detail.to
    : sourceState().latestSubmittedAt?.slice(0, 10)
  if (!anchor || !datePattern.test(anchor)) throw new Error('daily_bootstrap_requires_bounded_backfill')
  return dateShift(anchor > to ? to : anchor, -1)
}

async function previousPublication() {
  try { return await readPublishedSnapshot(currentPath) }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error }
}

async function baselineSnapshot() {
  const published = await previousPublication()
  if (published) return { snapshot: published.snapshot, snapshotId: published.publication.snapshotId,
    baseSnapshotId: published.publication.baseSnapshotId,
    currentPositionHash: published.publication.currentPositionHash,
    reviewHash: published.publication.reviewHash,
    sourceFilingCount: published.publication.sourceFilingCount,
    sourceLatestImportedAt: published.publication.sourceLatestImportedAt,
    sourceLatestSubmittedAt: published.publication.sourceLatestSubmittedAt }
  const configured = process.env.LARGE_HOLDER_RANKING_SNAPSHOT_PATH
  if (!configured) return null
  const loaded = await readSnapshotFile(configured)
  const state = sourceState()
  const db = new DatabaseSync(dbPath!, { readOnly: true })
  db.exec('PRAGMA query_only=ON')
  let legacyPositionHash: string
  try { legacyPositionHash = sha256(JSON.stringify(db.prepare(POSITION_FINGERPRINT_SQL).all())) }
  finally { db.close() }
  const unchanged = state.marketDate === loaded.snapshot.priceDate
    && state.priceEvidenceDate === loaded.snapshot.priceDate
    && state.filingCount === loaded.snapshot.filingWatermark.count
    && state.latestImportedAt === loaded.snapshot.filingWatermark.maxImportedAt
    && state.latestSubmittedAt === loaded.snapshot.filingWatermark.maxSubmittedAt
    && legacyPositionHash === loaded.snapshot.positionFingerprintSha256
  return { ...loaded, baseSnapshotId: loaded.snapshotId,
    currentPositionHash: unchanged ? state.currentPositionHash : null,
    reviewHash: unchanged ? sha256('[]') : null,
    sourceFilingCount: loaded.snapshot.filingWatermark.count,
    sourceLatestImportedAt: loaded.snapshot.filingWatermark.maxImportedAt,
    sourceLatestSubmittedAt: loaded.snapshot.filingWatermark.maxSubmittedAt }
}

function sourceWatermarkCurrent(state: SourceState, baseline: Awaited<ReturnType<typeof baselineSnapshot>>) {
  return baseline != null && state.filingCount === baseline.sourceFilingCount
    && state.latestImportedAt === baseline.sourceLatestImportedAt
    && state.latestSubmittedAt === baseline.sourceLatestSubmittedAt
}

async function classificationHash(snapshot: RankingSnapshot): Promise<string> {
  const path = join(evidenceDir, 'manifests', `${snapshot.manifestSha256}.json`)
  const bytes = await readFile(path)
  if (basename(path) !== `${sha256(bytes)}.json`) throw new Error('certification_manifest_digest_mismatch')
  const manifest = JSON.parse(bytes.toString('utf8')) as { classificationLineages: unknown[] }
  return sha256(JSON.stringify(manifest.classificationLineages))
}

function validatedDate(value: string | undefined, label: string): string {
  if (!value || !datePattern.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`)))
    throw new Error(`invalid_${label}`)
  return value
}

function dateShift(date: string, days: number): string {
  const value = new Date(`${date}T00:00:00Z`)
  value.setUTCDate(value.getUTCDate() + days)
  return value.toISOString().slice(0, 10)
}

async function child(script: string, childArgs: string[], lock: UpdateLockHandle): Promise<string> {
  storagePreflight()
  await closeLocalClientBeforeExternalWriter()
  const commandPath = join(process.cwd(), 'node_modules', '.bin', 'tsx')
  const timeoutMs = Math.min(120, Math.max(1, Number(process.env.LARGE_HOLDER_CHILD_TIMEOUT_MINUTES ?? 75))) * 60_000
  return new Promise((resolve, reject) => {
    const processChild = spawn(commandPath, [script, ...childArgs], {
      cwd: process.cwd(), env: { ...process.env, USE_LOCAL_DB: '1', SKIP_SCHEMA_ENSURE: '1',
        LARGE_HOLDER_EVIDENCE_DIR: evidenceDir, LARGE_HOLDER_RANKING_DIR: rankingDir },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = '', stderr = '', guardError: Error | null = null
    processChild.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString()
      if (stdout.length > 4_000_000) processChild.kill('SIGTERM')
    })
    processChild.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString()
      if (stderr.length > 200_000) processChild.kill('SIGTERM')
    })
    const interval = setInterval(() => {
      try {
        storagePreflight()
        // The 3-hour lock lease exceeds the bounded 2-hour child timeout.
        // Keep the parent's local SQLite connection closed while the child writes.
      } catch (error) { guardError = error as Error; processChild.kill('SIGTERM') }
    }, 30_000)
    const timeout = setTimeout(() => { guardError = new Error(`large_holder_child_timeout:${script}`)
      processChild.kill('SIGTERM') }, timeoutMs)
    processChild.on('error', (error) => { clearInterval(interval); clearTimeout(timeout); reject(error) })
    processChild.on('close', (code) => {
      clearInterval(interval); clearTimeout(timeout)
      shadowPhysicalState('child_close')
      if (guardError) reject(guardError)
      else if (code !== 0) reject(new Error(`${script} failed: ${stderr.slice(-1200) || `exit ${code}`}`))
      else resolve(stdout)
    })
  })
}

function finalJson<T>(output: string): T {
  const trimmed = output.trim()
  const lastLine = trimmed.split('\n').at(-1)
  if (!lastLine) throw new Error('operation_missing_result')
  try { return JSON.parse(trimmed) as T }
  catch { return JSON.parse(lastLine) as T }
}

async function withLock<T>(run: (lock: UpdateLockHandle) => Promise<T>): Promise<T> {
  if (process.env.SKIP_SCHEMA_ENSURE !== '1')
    throw new Error('SKIP_SCHEMA_ENSURE=1 required: Phase 16D may not alter production schema')
  storagePreflight()
  const lock = await acquireExclusiveUpdateLock('large_holder_daily', 3 * 60 * 60)
  if (!lock) throw new Error('large_holder_update_lock_busy')
  try { return await run(lock) }
  finally { shadowPhysicalState('before_release'); await lock.release(); shadowPhysicalState('after_release') }
}

async function snapshotStatus() {
  const state = sourceState()
  const baseline = await baselineSnapshot()
  const currentReviewHash = reviewDigest(await readReviewLedger())
  const events = await lastEvents()
  const current = await previousPublication()
  const reasons = !baseline ? ['NO_SNAPSHOT'] : [
    ...(state.marketDate !== baseline.snapshot.priceDate ? ['NEW_PRICE'] : []),
    ...(!baseline.currentPositionHash ? ['SOURCE_CHANGED'] : []),
    ...(baseline.currentPositionHash && state.currentPositionHash !== baseline.currentPositionHash
      ? ['CURRENT_POSITION_CHANGED'] : []),
    ...(!sourceWatermarkCurrent(state, baseline) ? ['EDINET_SOURCE_CHANGED'] : []),
    ...(baseline.reviewHash !== currentReviewHash ? ['ENTITY_REVIEW_CHANGED'] : []),
    ...(state.priceEvidenceDate !== state.marketDate ? ['PRICE_EVIDENCE_STALE'] : []),
  ]
  if (!state.priceBatchComplete) reasons.push('PRICE_UPDATE_INCOMPLETE')
  if (state.unresolvedFilingCount) reasons.push('UNRESOLVED_SOURCE')
  if (!current) reasons.push('UNPUBLISHED')
  return { state, currentSnapshotId: current?.publication.snapshotId ?? baseline?.snapshotId ?? null,
    currentGeneratedAt: current?.publication.generatedAt ?? null,
    latestEdinetDataAt: baseline?.snapshot.latestEdinetDataAt ?? null,
    snapshotPriceDate: baseline?.snapshot.priceDate ?? null,
    status: reasons.length ? 'STALE' : 'CURRENT', reasons,
    lastSuccess: events.filter((item) => item.status === 'PASS').at(-1)?.at ?? null,
    lastError: events.filter((item) => item.status === 'FAILED').at(-1) ?? null,
    recentEvents: events.slice(-12) }
}

async function refreshLocked(lock: UpdateLockHandle, historicalOnly = false) {
  const start = Date.now()
  const before = await baselineSnapshot()
  const state = sourceState()
  const decisions = await readReviewLedger()
  const reviewHash = reviewDigest(decisions)
  if (!state.marketDate || state.marketDate > todayJst()) throw new Error('market_date_invalid')
  if (!state.priceBatchComplete) throw new Error('price_update_incomplete')
  if (state.unresolvedFilingCount) throw new Error('unresolved_source_document')
  if (before && before.snapshot.priceDate === state.marketDate
    && before.currentPositionHash === state.currentPositionHash
    && state.priceEvidenceDate === state.marketDate
    && (sourceWatermarkCurrent(state, before) || historicalOnly)) {
    if (!await previousPublication() && before.reviewHash === reviewHash) {
      if (dirname(process.env.LARGE_HOLDER_RANKING_SNAPSHOT_PATH ?? '') !== rankingDir)
        throw new Error('legacy_snapshot_not_in_ranking_directory')
      const publication = await publishValidatedSnapshot(currentPath, {
        snapshotId: before.snapshotId, baseSnapshotId: before.baseSnapshotId,
        generatedAt: new Date().toISOString(),
        sourceEdinetCutoff: before.snapshot.latestEdinetDataAt,
        sourceFilingCount: state.filingCount,
        sourceLatestImportedAt: state.latestImportedAt,
        sourceLatestSubmittedAt: state.latestSubmittedAt,
        priceDate: before.snapshot.priceDate, positionHash: before.snapshot.positionFingerprintSha256,
        currentPositionHash: state.currentPositionHash,
        certificationHash: before.snapshot.manifestSha256,
        classificationHash: await classificationHash(before.snapshot), reviewHash,
      })
      await event('snapshot', 'PASS', { reason: 'adopt_existing_certified_snapshot', snapshotId: before.snapshotId })
      return { status: publication, snapshotId: before.snapshotId, elapsedMs: Date.now() - start }
    }
    if (before.reviewHash === reviewHash && sourceWatermarkCurrent(state, before)) {
      await event('snapshot', 'SKIPPED', { reason: 'no_effective_change', snapshotId: before.snapshotId })
      return { status: 'UNCHANGED', snapshotId: before.snapshotId, elapsedMs: Date.now() - start }
    }
    if (before.reviewHash === reviewHash && historicalOnly) {
      const status = await publishValidatedSnapshot(currentPath, {
        snapshotId: before.snapshotId, baseSnapshotId: before.baseSnapshotId,
        generatedAt: new Date().toISOString(), sourceEdinetCutoff: before.snapshot.latestEdinetDataAt,
        sourceFilingCount: state.filingCount, sourceLatestImportedAt: state.latestImportedAt,
        sourceLatestSubmittedAt: state.latestSubmittedAt,
        priceDate: before.snapshot.priceDate, positionHash: before.snapshot.positionFingerprintSha256,
        currentPositionHash: state.currentPositionHash, certificationHash: before.snapshot.manifestSha256,
        classificationHash: await classificationHash(before.snapshot), reviewHash,
      })
      await event('snapshot', 'PASS', { reason: 'historical_source_position_unchanged', snapshotId: before.snapshotId })
      return { status, snapshotId: before.snapshotId, elapsedMs: Date.now() - start }
    }
    const base = await readSnapshotFile(join(rankingDir, `${before.baseSnapshotId}.json`))
    const reviewed = applyReviewDecisions(base.snapshot, decisions)
    const reviewedPath = await writeImmutableSnapshot(rankingDir, reviewed)
    const loaded = await readSnapshotFile(reviewedPath)
    const status = await publishValidatedSnapshot(currentPath, {
      snapshotId: loaded.snapshotId, baseSnapshotId: base.snapshotId,
      generatedAt: new Date().toISOString(), sourceEdinetCutoff: loaded.snapshot.latestEdinetDataAt,
      sourceFilingCount: state.filingCount, sourceLatestImportedAt: state.latestImportedAt,
      sourceLatestSubmittedAt: state.latestSubmittedAt,
      priceDate: loaded.snapshot.priceDate, positionHash: loaded.snapshot.positionFingerprintSha256,
      currentPositionHash: state.currentPositionHash, certificationHash: loaded.snapshot.manifestSha256,
      classificationHash: await classificationHash(base.snapshot), reviewHash,
    })
    await event('snapshot', 'PASS', { reason: 'entity_review', snapshotId: loaded.snapshotId })
    return { status, snapshotId: loaded.snapshotId, elapsedMs: Date.now() - start }
  }
  await event('snapshot', 'STARTED', { priceDate: state.marketDate })
  if (state.priceEvidenceDate !== state.marketDate || !before
    || before.currentPositionHash !== state.currentPositionHash) {
    await child('scripts/audit-large-holder-instruments.ts',
      [`--as-of=${state.marketDate}`, '--operational'], lock)
    await lock.heartbeat()
  }
  const afterEvidence = sourceState()
  if (afterEvidence.priceEvidenceDate !== state.marketDate)
    throw new Error('official_price_evidence_not_current')
  const auditArgs = ['--phase-16a8', '--operational', `--as-of=${state.marketDate}`,
    `--certified-on=${todayJst()}`]
  if (before) auditArgs.push(`--reuse-edinet-manifest=${join(evidenceDir, 'manifests', `${before.snapshot.manifestSha256}.json`)}`)
  const audit = finalJson<{ mismatches: number; correctionUnresolved: number; transitionConflicts: number;
    phase16a8: { dataGate: string; archiveVerified: boolean; rawMismatches: number;
      classificationContradictions: number; jointHolderDoubleCount: number;
      publicCurrentValuationReady: number; manifestPath: string } }>(
    await child('scripts/audit-large-holder-regulatory-current.ts', auditArgs, lock))
  if (audit.phase16a8?.dataGate !== 'GO' || !audit.phase16a8.archiveVerified
    || audit.mismatches || audit.correctionUnresolved || audit.transitionConflicts
    || audit.phase16a8.rawMismatches || audit.phase16a8.classificationContradictions
    || audit.phase16a8.jointHolderDoubleCount || audit.phase16a8.publicCurrentValuationReady < 20)
    throw new Error('official_certification_gate_failed')
  const activityArgs = [audit.phase16a8.manifestPath]
  if (before?.snapshot.activityEvidenceManifestSha256)
    activityArgs.push(`--reuse-activity-manifest=${join(evidenceDir, 'activity-manifests',
      `${before.snapshot.activityEvidenceManifestSha256}.json`)}`)
  const activity = finalJson<{ activityManifestPath: string }>(
    await child('scripts/archive-large-holder-ranking-activity.ts', activityArgs, lock))
  const materialized = finalJson<{ snapshotPath: string; publicReady: number; positions: number;
    investors: number; dbWrites: number }>(await child('scripts/build-large-holder-ranking-snapshot.ts',
    [audit.phase16a8.manifestPath, activity.activityManifestPath], lock))
  const base = await readSnapshotFile(materialized.snapshotPath)
  const reviewedPath = decisions.length
    ? await writeImmutableSnapshot(rankingDir, applyReviewDecisions(base.snapshot, decisions))
    : materialized.snapshotPath
  const loaded = await readSnapshotFile(reviewedPath)
  if (dirname(materialized.snapshotPath) !== rankingDir || materialized.publicReady !== loaded.snapshot.publicCurrentValuationReadyCount
    || materialized.positions !== loaded.snapshot.currentPositionCount
    || materialized.investors !== base.snapshot.investors.length
    || materialized.publicReady !== audit.phase16a8.publicCurrentValuationReady
    || materialized.dbWrites !== 0) throw new Error('materialized_snapshot_validation_failed')
  const finalState = sourceState()
  if (finalState.currentPositionHash !== afterEvidence.currentPositionHash
    || finalState.marketDate !== state.marketDate) throw new Error('source_changed_during_materialization')
  storagePreflight()
  shadowFailpoint('BEFORE_PUBLISH')
  const status = await publishValidatedSnapshot(currentPath, {
    snapshotId: loaded.snapshotId, baseSnapshotId: base.snapshotId,
    generatedAt: new Date().toISOString(),
    sourceEdinetCutoff: loaded.snapshot.latestEdinetDataAt, priceDate: loaded.snapshot.priceDate,
    sourceFilingCount: finalState.filingCount,
    sourceLatestImportedAt: finalState.latestImportedAt,
    sourceLatestSubmittedAt: finalState.latestSubmittedAt,
    positionHash: loaded.snapshot.positionFingerprintSha256,
    currentPositionHash: finalState.currentPositionHash,
    certificationHash: loaded.snapshot.manifestSha256,
    classificationHash: await classificationHash(base.snapshot), reviewHash,
  })
  shadowFailpoint('AFTER_PUBLISH')
  await event('snapshot', 'PASS', { snapshotId: loaded.snapshotId,
    publicReady: loaded.snapshot.publicCurrentValuationReadyCount,
    positions: loaded.snapshot.currentPositionCount, elapsedMs: Date.now() - start })
  return { status, snapshotId: loaded.snapshotId, elapsedMs: Date.now() - start,
    publicReady: loaded.snapshot.publicCurrentValuationReadyCount,
    positions: loaded.snapshot.currentPositionCount, investors: loaded.snapshot.investors.length }
}

async function discover(from: string, to: string) {
  storagePreflight()
  const db = new DatabaseSync(dbPath!, { readOnly: true })
  db.exec('PRAGMA query_only=ON')
  try {
    const existing = new Map((db.prepare(`SELECT document_id,parser_version,status,submitted_at,
      withdrawn_at,xbrl_sha256 FROM large_holder_filings LEFT JOIN large_holder_source_documents USING(document_id)`)
      .all() as Record<string, unknown>[]).map((row) => [String(row.document_id), row]))
    const stored = new Map<string, StoredLargeHolderDocument>([...existing].map(([id, row]) => [id, {
      parserVersion: String(row.parser_version ?? ''), status: String(row.status ?? ''),
      submittedAt: row.submitted_at == null ? null : String(row.submitted_at),
      withdrawnAt: row.withdrawn_at == null ? null : String(row.withdrawn_at),
    }]))
    const missing: string[] = []
    const changed: string[] = []
    const withdrawals: string[] = []
    const days: { date: string; largeHolderDocuments: number; changed: boolean }[] = []
    let requests = 0
    for (let date = from; date <= to; date = dateShift(date, 1)) {
      storagePreflight()
      const documents = await listEdinetDocuments(date)
      requests++
      const plan = planLargeHolderIndexDay(documents, stored, LARGE_HOLDER_PARSER_VERSION)
      missing.push(...plan.missing)
      changed.push(...plan.changed)
      withdrawals.push(...plan.withdrawals)
      days.push({ date, largeHolderDocuments: plan.largeHolderDocuments, changed: plan.changedDay })
      await sleep(650)
    }
    return { missing: [...new Set(missing)], changed: [...new Set(changed)],
      withdrawals: [...new Set(withdrawals)], requests, days,
      latestProcessedDocId: [...existing.keys()].sort().at(-1) ?? null,
      latestProcessedSubmittedAt: [...existing.values()].map((row) => String(row.submitted_at ?? '')).sort().at(-1) ?? null,
      sourceHash: sha256(JSON.stringify([...existing].map(([id, row]) =>
        [id, row.xbrl_sha256, row.submitted_at]).sort(([a], [b]) => String(a).localeCompare(String(b))))) }
  } finally { db.close() }
}

async function ingestChangedDays(found: Awaited<ReturnType<typeof discover>>,
  lock: UpdateLockHandle): Promise<{ processed: number; failed: number; review: number;
    quarantined: number; examined: number }> {
  const result = { processed: 0, failed: 0, review: 0, quarantined: 0, examined: 0 }
  for (const day of found.days.filter((item) => item.changed)) {
    if (day.largeHolderDocuments > 1000) throw new Error('daily_edinet_limit_exceeded')
    const batch = finalJson<{ processed: number; failed: number; review: number;
      quarantined: number; examined: number }>(
      await child('scripts/ingest-large-holders.ts',
        [`--from=${day.date}`, `--to=${day.date}`, '--limit=1000'], lock))
    if (batch.examined !== day.largeHolderDocuments || batch.failed || batch.review)
      throw new Error(`large_holder_ingestion_incomplete:${day.date}`)
    result.processed += batch.processed
    result.failed += batch.failed
    result.review += batch.review
    result.quarantined += batch.quarantined
    result.examined += batch.examined
    await lock.heartbeat()
  }
  return result
}

async function dailyLocked(lock: UpdateLockHandle, from: string, to: string) {
  const start = Date.now()
  const found = await discover(from, to)
  if (dryRun) return { dryRun: true, source: found, snapshot: await snapshotStatus() }
  await event('ingestion', 'STARTED', { from, to, indexRequests: found.requests,
    newDocuments: found.missing.length, changedDocuments: found.changed.length,
    withdrawals: found.withdrawals.length })
  if (found.missing.length || found.changed.length || found.withdrawals.length) {
    const ingest = await ingestChangedDays(found, lock)
    await event('ingestion', 'PASS', { from, to, processed: ingest.processed, indexRequests: found.requests })
  } else await event('ingestion', 'SKIPPED', { from, to,
    reason: 'no_new_source', indexRequests: found.requests })
  await lock.heartbeat()
  const snapshot = await refreshLocked(lock)
  return { dryRun: false, source: found, snapshot, elapsedMs: Date.now() - start }
}

async function backfillLocked(lock: UpdateLockHandle, from: string, to: string, chunkDays: number) {
  const checkpoint = join(operationsDir, `backfill-${sha256(`${from}:${to}:${chunkDays}`)}.ndjson`)
  const history = await readFile(checkpoint, 'utf8').catch((error) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return ''
    throw error
  })
  if (history && !args.has('--resume') && !dryRun) throw new Error('backfill_checkpoint_exists_use_resume')
  const completed = new Set(history.trim().split('\n').filter(Boolean)
    .map((line) => JSON.parse(line) as { chunk: string; status: string })
    .filter((item) => item.status === 'PUBLISHED').map((item) => item.chunk))
  const results: { chunk: string; status: string; source?: unknown }[] = []
  for (let cursor = from; cursor <= to; cursor = dateShift(cursor, chunkDays)) {
    const end = dateShift(cursor, chunkDays - 1) < to ? dateShift(cursor, chunkDays - 1) : to
    const chunk = `${cursor}:${end}`
    if (completed.has(chunk)) { results.push({ chunk, status: 'SKIPPED_COMPLETED' }); continue }
    const source = await discover(cursor, end)
    if (dryRun) { results.push({ chunk, status: 'PLANNED', source }); continue }
    const record = async (status: string) => {
      await mkdir(operationsDir, { recursive: true, mode: 0o700 })
      await appendFile(checkpoint, `${JSON.stringify({ at: new Date().toISOString(), chunk, status })}\n`, { mode: 0o600 })
    }
    try {
      await record('FETCHED')
      if (source.missing.length || source.changed.length || source.withdrawals.length) {
        await ingestChangedDays(source, lock)
      }
      await record('PARSED')
      const baseline = await baselineSnapshot()
      const historicalOnly = baseline != null && source.days.filter((day) => day.changed)
        .every((day) => day.date < (baseline.snapshot.latestEdinetDataAt ?? '').slice(0, 10)
          && day.date < dateShift(baseline.snapshot.priceDate, -365))
      const snapshot = await refreshLocked(lock, historicalOnly)
      await record('CERTIFIED')
      await record('PUBLISHED')
      results.push({ chunk, status: snapshot.status, source })
    } catch (error) { await record('FAILED'); throw error }
    if (shadowQa && Number(process.env.PHASE16D_SHADOW_INTERRUPT_AFTER_CHUNKS ?? 0) === results.length)
      throw new Error('phase16d_shadow_controlled_backfill_interruption')
  }
  return { from, to, chunkDays, dryRun, chunks: results }
}

async function main() {
  if (!['status', 'snapshot-refresh', 'update-daily', 'backfill'].includes(command))
    throw new Error('Usage: run-large-holder-operations.ts status|snapshot-refresh|update-daily|backfill')
  if (command === 'status') { console.log(JSON.stringify(await snapshotStatus(), null, 2)); return }
  if (command === 'snapshot-refresh' && dryRun) {
    console.log(JSON.stringify({ dryRun: true, ...(await snapshotStatus()) }, null, 2)); return
  }
  if (command === 'snapshot-refresh') {
    console.log(JSON.stringify(await withLock(refreshLocked), null, 2)); return
  }
  if (command === 'update-daily') {
    const to = validatedDate(args.get('--to') || todayJst(), 'to')
    const from = validatedDate(args.get('--from') || await defaultDailyFrom(to), 'from')
    if (from > to || to > todayJst()
      || Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`) > 13 * 86_400_000)
      throw new Error('daily_range_exceeds_14_days')
    const result = dryRun ? await dailyLocked(null as never, from, to)
      : await withLock((lock) => dailyLocked(lock, from, to))
    console.log(JSON.stringify(result, null, 2)); return
  }
  const from = validatedDate(args.get('--from'), 'from')
  const to = validatedDate(args.get('--to'), 'to')
  const chunkDays = Number(args.get('--chunk-days') ?? 3)
  if (from > to || to > todayJst() || !Number.isInteger(chunkDays) || chunkDays < 1 || chunkDays > 7
    || Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`) > 30 * 86_400_000)
    throw new Error('backfill_range_or_chunk_invalid')
  const result = dryRun ? await backfillLocked(null as never, from, to, chunkDays)
    : await withLock((lock) => backfillLocked(lock, from, to, chunkDays))
  console.log(JSON.stringify(result, null, 2))
}

main().catch(async (error) => {
  await event(command ?? 'unknown', 'FAILED', { reason: error instanceof Error ? error.message : String(error) })
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
