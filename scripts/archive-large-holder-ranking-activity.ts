// Append-only official evidence acquisition for effective historical transitions.
// @ts-expect-error The pinned Node types predate Node 24's built-in SQLite module.
import { DatabaseSync } from 'node:sqlite'
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { unzipSync } from 'fflate'
import { archiveOfficialRaw, sha256, type RawEvidence } from '@/lib/large-holders/evidence-provenance'
import { resolveRevisionChains, type RevisionFiling } from '@/lib/large-holders/revision-chain'
import { downloadEdinetPublicArchiveBytes } from '@/lib/server/edinet-api'
import { guardForDatabase, requiresExternalStorageGuard } from '@/lib/storage/external-storage-guard'

type Row = Record<string, string | number | null>
const str = (value: unknown) => String(value ?? '')
const optional = (value: unknown) => value == null ? null : String(value)
const number = (value: unknown) => value == null ? null : Number(value)

async function main() {
  const path = process.argv[2], dbPath = process.env.STOCKBOARD_DB_PATH
  if (!path || !dbPath) throw new Error('Usage: STOCKBOARD_DB_PATH=... tsx archive-large-holder-ranking-activity.ts <16a8-manifest>')
  if (requiresExternalStorageGuard(dbPath)) guardForDatabase(dbPath).assertWritable(true)
  const original = await readFile(path)
  const baseHash = sha256(original)
  if (basename(path) !== `${baseHash}.json`) throw new Error('base_manifest_digest_mismatch')
  const manifest = JSON.parse(original.toString('utf8')) as { phase: string; asOf: string;
    certificationDate: string; rawSources: RawEvidence[] }
  if (manifest.phase !== '16A-8') throw new Error('base_manifest_phase_invalid')
  const reusePath = process.argv.find((arg) => arg.startsWith('--reuse-activity-manifest='))?.slice(26)
  const reused = new Map<string, RawEvidence & { documentId: string; xbrlSha256: string }>()
  if (reusePath) {
    const priorBytes = await readFile(reusePath)
    if (basename(reusePath) !== `${sha256(priorBytes)}.json`) throw new Error('prior_activity_digest_mismatch')
    const prior = JSON.parse(priorBytes.toString('utf8')) as { phase: string; asOf: string;
      rawSources: (RawEvidence & { documentId: string; xbrlSha256: string })[] }
    if (prior.phase !== '16B-1-ACTIVITY' || prior.asOf > manifest.asOf)
      throw new Error('prior_activity_scope_invalid')
    for (const source of prior.rawSources) {
      const bytes = await readFile(source.archivePath)
      if (source.authority !== 'EDINET' || source.reference !==
        `https://api.edinet-fsa.go.jp/api/v2/documents/${source.documentId}?type=1`
        || bytes.byteLength !== source.byteLength || sha256(bytes) !== source.sha256
        || reused.has(source.documentId)) throw new Error('prior_activity_source_invalid')
      reused.set(source.documentId, source)
    }
  }
  const db = new DatabaseSync(dbPath, { readOnly: true })
  db.exec('PRAGMA query_only=ON')
  try {
    const filings = db.prepare(`SELECT f.document_id,f.filing_type,f.submitted_at,f.obligation_date,
      f.corrected_document_id,f.previous_filing_id,f.issuer_edinet_code,f.issuer_security_code,
      f.withdrawn_at,f.status,f.report_serial_number,f.submission_count,s.xbrl_sha256,s.xbrl_xml
      FROM large_holder_filings f LEFT JOIN large_holder_source_documents s USING(document_id)`)
      .all() as Row[]
    const revisions = resolveRevisionChains(filings.map((row): RevisionFiling => ({
      documentId: str(row.document_id), filingType: str(row.filing_type), submittedAt: str(row.submitted_at),
      obligationDate: optional(row.obligation_date), correctsFilingId: optional(row.corrected_document_id),
      previousFilingId: optional(row.previous_filing_id), issuerEdinetCode: optional(row.issuer_edinet_code),
      issuerSecurityCode: optional(row.issuer_security_code), withdrawnAt: optional(row.withdrawn_at),
      status: str(row.status), reportSerialNumber: number(row.report_serial_number),
      submissionCount: number(row.submission_count), sourceSha256: optional(row.xbrl_sha256),
    })), manifest.certificationDate)
    if (revisions.some((item) => item.unresolvedReason)) throw new Error('revision_chain_unresolved')
    const archived = new Set(manifest.rawSources.filter((source) => source.authority === 'EDINET')
      .map((source) => source.reference.match(/\/documents\/([^?]+)\?type=1$/)?.[1] ?? ''))
    const byId = new Map(filings.map((item) => [str(item.document_id), item]))
    const missing = revisions.filter((item) => item.isEffectiveRevision && !archived.has(item.documentId))
      .map((item) => item.documentId).sort()
    const sources: (RawEvidence & { documentId: string; xbrlSha256: string })[] = []
    let reusedCount = 0
    let fetchedCount = 0
    const archiveRoot = process.env.LARGE_HOLDER_EVIDENCE_DIR ?? dirname(dirname(path))
    for (const [index, doc] of missing.entries()) {
      const stored = byId.get(doc)!
      if (!stored.xbrl_sha256 || !stored.xbrl_xml) throw new Error(`stored_source_missing:${doc}`)
      const prior = reused.get(doc)
      const bytes = prior ? new Uint8Array(await readFile(prior.archivePath))
        : await downloadEdinetPublicArchiveBytes(doc)
      const files = unzipSync(bytes, { filter: (file) => /XBRL\/PublicDoc\/.*\.xbrl$/i.test(file.name) })
      const entry = Object.entries(files).filter(([name]) => /XBRL\/PublicDoc\/.*\.xbrl$/i.test(name))
        .sort((a, b) => b[1].byteLength - a[1].byteLength)[0]
      if (!entry) throw new Error(`public_xbrl_missing:${doc}`)
      const xml = new TextDecoder('utf-8').decode(entry[1])
      if (sha256(xml) !== stored.xbrl_sha256 || xml !== stored.xbrl_xml)
        throw new Error(`official_stored_xbrl_mismatch:${doc}`)
      if (prior && prior.xbrlSha256 !== stored.xbrl_sha256)
        throw new Error(`prior_activity_xbrl_changed:${doc}`)
      const source = prior ?? await archiveOfficialRaw(archiveRoot, 'EDINET',
        `https://api.edinet-fsa.go.jp/api/v2/documents/${doc}?type=1`, bytes, 'zip')
      sources.push({ ...source, documentId: doc, xbrlSha256: str(stored.xbrl_sha256) })
      if (prior) reusedCount++
      else {
        fetchedCount++
        console.log(JSON.stringify({ fetched: fetchedCount, total: missing.length, documentId: doc }))
        if (index < missing.length - 1) await new Promise((resolve) => setTimeout(resolve, 1000))
      }
    }
    const output = JSON.stringify({ phase: '16B-1-ACTIVITY', asOf: manifest.asOf,
      certificationDate: manifest.certificationDate, baseManifestSha256: baseHash,
      rawSources: sources }, null, 2)
    const directory = join(archiveRoot, 'activity-manifests')
    await mkdir(directory, { recursive: true, mode: 0o700 })
    const outputPath = join(directory, `${sha256(output)}.json`)
    try { await writeFile(outputPath, output, { flag: 'wx', mode: 0o600 }) }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST'
      || await readFile(outputPath, 'utf8') !== output) throw error }
    console.log(JSON.stringify({ activityManifestPath: outputPath, baseManifestSha256: baseHash,
      supplementalOfficialDocuments: sources.length, reused: reusedCount, fetched: fetchedCount, dbWrites: 0 }))
  } finally { db.close() }
}

main().catch((error) => { console.error(error); process.exitCode = 1 })
