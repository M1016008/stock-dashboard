import { randomUUID } from 'node:crypto'
import { link, mkdir, open, readFile, rename, unlink } from 'node:fs/promises'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { sha256 } from './evidence-provenance'
import type { RankingSnapshot } from './ranking-core'

export const LARGE_HOLDER_GENERATOR_VERSION = '16D-3'

export type PublishedSnapshot = {
  status: 'VALIDATED' | 'VALIDATED_WITH_QUARANTINE'
  snapshotId: string
  baseSnapshotId: string
  generatedAt: string
  sourceEdinetCutoff: string | null
  sourceFilingCount: number
  sourceLatestImportedAt: number | null
  sourceLatestSubmittedAt: string | null
  priceDate: string
  positionHash: string
  currentPositionHash: string
  certificationHash: string
  classificationHash: string
  reviewHash: string
  generatorVersion: string
}

const digestPattern = /^[a-f0-9]{64}$/

export function validateRankingSnapshot(snapshot: RankingSnapshot): void {
  if (snapshot.version !== 1 || !snapshot.effectiveFilingArchiveComplete
    || snapshot.publicCurrentValuationReadyCount < 20
    || snapshot.certificationAsOf !== snapshot.priceDate
    || !digestPattern.test(snapshot.manifestSha256)
    || !digestPattern.test(snapshot.positionFingerprintSha256)) throw new Error('snapshot_contract_invalid')
  const positions = snapshot.investors.flatMap((investor) => investor.positions)
  const investorIds = new Set(snapshot.investors.map((investor) => investor.investorEntityId))
  const positionKeys = new Set(positions.map((position) => position.positionKey))
  const pairs = new Set(positions.map((position) => `${position.investorEntityId}:${position.ticker}`))
  const filingIds = new Set(snapshot.filings.map((filing) => filing.documentId))
  const activityKeys = new Set(snapshot.activities.map((activity) =>
    `${activity.documentId}:${activity.investorEntityId}:${activity.ticker}:${activity.eventType}`))
  const quarantines = snapshot.quarantines ?? []
  const blockedTickers = new Set(quarantines.map((item) => item.ticker))
  const knownAffectedInvestors = new Set(quarantines.flatMap((item) =>
    item.knownPriorInvestorEntityIds ?? []))
  const metadata = snapshot.quarantineMetadata
  if (metadata && (metadata.quarantinedDocumentCount !== quarantines.length
    || metadata.quarantinedPositionScopeCount !== quarantines.reduce((count, item) =>
      count + item.affectedHolderCount, 0)
    || metadata.affectedIssuerCount !== blockedTickers.size
    || metadata.affectedInvestorCount !== knownAffectedInvestors.size
    || Number(metadata.quarantineReasons.HOLDER_COUNT_INTERNAL_INCONSISTENCY ?? 0) !== quarantines.length))
    throw new Error('snapshot_quarantine_metadata_invalid')
  if (quarantines.length && !metadata) throw new Error('snapshot_quarantine_metadata_missing')
  if (quarantines.length !== new Set(quarantines.map((item) => item.documentId)).size
    || quarantines.some((item) => !item.ticker || !digestPattern.test(item.sourceSha256)
      || item.reasonCode !== 'HOLDER_COUNT_INTERNAL_INCONSISTENCY'
      || !Number.isSafeInteger(item.affectedHolderCount) || item.affectedHolderCount < 1)
    || positions.some((item) => blockedTickers.has(item.ticker))
    || snapshot.activities.some((item) => blockedTickers.has(item.ticker))
    || snapshot.filings.some((item) => item.ticker != null && blockedTickers.has(item.ticker))
    || [...knownAffectedInvestors].some((id) => !snapshot.investors.some((investor) =>
      investor.investorEntityId === id && (investor.blockedPositionCount ?? 0) > 0)))
    throw new Error('snapshot_quarantine_population_invalid')
  if (positions.length !== snapshot.currentPositionCount || positionKeys.size !== positions.length
    || pairs.size !== positions.length || investorIds.size !== snapshot.investors.length
    || filingIds.size !== snapshot.filings.length || snapshot.filings.some((filing) => !filing.sourceVerified)
    || activityKeys.size !== snapshot.activities.length
    || snapshot.activities.some((activity) => !filingIds.has(activity.documentId))
    || positions.filter((position) => position.valuationStatus === 'PUBLIC_CURRENT_VALUATION_READY').length
      !== snapshot.publicCurrentValuationReadyCount
    || positions.filter((position) => position.estimatedCurrentValue != null).length
      !== snapshot.publicCurrentValuationReadyCount
    || snapshot.investors.reduce((count, investor) => count + investor.valuedPositionCount, 0)
      !== snapshot.publicCurrentValuationReadyCount
    || snapshot.activities.some((activity) => !investorIds.has(activity.investorEntityId)))
    throw new Error('snapshot_population_invalid')
  const exactDuplicate = new Set<string>()
  for (const investor of snapshot.investors) for (const position of investor.positions) {
    const key = `${investor.displayName.normalize('NFKC').replace(/\s+/g, '')}:${position.ticker}:`
      + `${position.reportedShares}:${position.reportedHoldingPct}`
    if (exactDuplicate.has(key)) throw new Error('snapshot_possible_double_count')
    exactDuplicate.add(key)
  }
}

export async function readSnapshotFile(path: string): Promise<{ snapshotId: string; snapshot: RankingSnapshot }> {
  const bytes = await readFile(path)
  const snapshotId = sha256(bytes)
  if (basename(path) !== `${snapshotId}.json`) throw new Error('snapshot_digest_mismatch')
  const snapshot = JSON.parse(bytes.toString('utf8')) as RankingSnapshot
  validateRankingSnapshot(snapshot)
  return { snapshotId, snapshot }
}

export async function writeImmutableSnapshot(directory: string, snapshot: RankingSnapshot): Promise<string> {
  validateRankingSnapshot(snapshot)
  const bytes = JSON.stringify(snapshot)
  const path = join(directory, `${sha256(bytes)}.json`)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const temporary = join(directory, `.snapshot-${randomUUID()}.tmp`)
  let handle
  try {
    handle = await open(temporary, 'wx', 0o600)
    await handle.writeFile(bytes)
    await handle.sync()
    if (process.env.PHASE16D_SHADOW_QA === '1'
      && process.env.PHASE16D_SHADOW_FAIL_AT === 'SNAPSHOT_GENERATION') {
      const dbPath = process.env.STOCKBOARD_DB_PATH ?? ''
      const root = resolve(dbPath, '..')
      if (!root.includes('/stock-dashboard/qa/phase16d-shadow/')
        || !dbPath.endsWith('/shadow.db') || !resolve(directory).startsWith(`${root}${sep}`))
        throw new Error('phase16d_shadow_boundary_invalid')
      throw new Error('phase16d_shadow_controlled_failure:SNAPSHOT_GENERATION')
    }
    await handle.close()
    handle = undefined
    try { await link(temporary, path) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST'
        || await readFile(path, 'utf8') !== bytes) throw error
    }
  } finally {
    await handle?.close()
    await unlink(temporary).catch(() => undefined)
  }
  return path
}

export async function readPublishedSnapshot(pointerPath: string): Promise<{
  publication: PublishedSnapshot; snapshotPath: string; snapshot: RankingSnapshot
}> {
  const publication = await readPublishedPointer(pointerPath)
  const snapshotPath = join(dirname(pointerPath), `${publication.snapshotId}.json`)
  const loaded = await readSnapshotFile(snapshotPath)
  if (loaded.snapshotId !== publication.snapshotId || loaded.snapshot.priceDate !== publication.priceDate
    || publication.status !== ((loaded.snapshot.quarantines?.length ?? 0)
      ? 'VALIDATED_WITH_QUARANTINE' : 'VALIDATED')
    || loaded.snapshot.positionFingerprintSha256 !== publication.positionHash
    || loaded.snapshot.manifestSha256 !== publication.certificationHash
    || loaded.snapshot.latestEdinetDataAt !== publication.sourceEdinetCutoff)
    throw new Error('snapshot_pointer_mismatch')
  await readSnapshotFile(join(dirname(pointerPath), `${publication.baseSnapshotId}.json`))
  return { publication, snapshotPath, snapshot: loaded.snapshot }
}

export async function readPublishedPointer(pointerPath: string): Promise<PublishedSnapshot> {
  const publication = JSON.parse(await readFile(pointerPath, 'utf8')) as PublishedSnapshot
  if (!['VALIDATED', 'VALIDATED_WITH_QUARANTINE'].includes(publication.status)
    || !digestPattern.test(publication.snapshotId)
    || !digestPattern.test(publication.baseSnapshotId)
    || !digestPattern.test(publication.positionHash)
    || !digestPattern.test(publication.currentPositionHash)
    || !digestPattern.test(publication.certificationHash)
    || !digestPattern.test(publication.classificationHash)
    || !digestPattern.test(publication.reviewHash)
    || !Number.isSafeInteger(publication.sourceFilingCount) || publication.sourceFilingCount < 0
    || (publication.sourceLatestImportedAt !== null
      && (!Number.isSafeInteger(publication.sourceLatestImportedAt) || publication.sourceLatestImportedAt < 0))
    || !['16D-1', LARGE_HOLDER_GENERATOR_VERSION].includes(publication.generatorVersion))
    throw new Error('snapshot_pointer_invalid')
  return publication
}

export async function publishValidatedSnapshot(pointerPath: string, input: Omit<PublishedSnapshot,
  'status' | 'generatorVersion'>): Promise<'PUBLISHED' | 'UNCHANGED'> {
  const snapshotPath = join(dirname(pointerPath), `${input.snapshotId}.json`)
  const loaded = await readSnapshotFile(snapshotPath)
  await readSnapshotFile(join(dirname(pointerPath), `${input.baseSnapshotId}.json`))
  if (loaded.snapshotId !== input.snapshotId || loaded.snapshot.priceDate !== input.priceDate
    || loaded.snapshot.positionFingerprintSha256 !== input.positionHash
    || loaded.snapshot.manifestSha256 !== input.certificationHash
    || loaded.snapshot.latestEdinetDataAt !== input.sourceEdinetCutoff
    || !digestPattern.test(input.currentPositionHash)
    || !digestPattern.test(input.classificationHash) || !digestPattern.test(input.reviewHash))
    throw new Error('snapshot_publish_evidence_mismatch')
  try {
    const current = await readPublishedSnapshot(pointerPath)
    if (current.publication.snapshotId === input.snapshotId
      && current.publication.baseSnapshotId === input.baseSnapshotId
      && current.publication.classificationHash === input.classificationHash
      && current.publication.reviewHash === input.reviewHash
      && current.publication.sourceFilingCount === input.sourceFilingCount
      && current.publication.sourceLatestImportedAt === input.sourceLatestImportedAt
      && current.publication.sourceLatestSubmittedAt === input.sourceLatestSubmittedAt) return 'UNCHANGED'
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  const publication: PublishedSnapshot = { ...input, status: loaded.snapshot.quarantines?.length
    ? 'VALIDATED_WITH_QUARANTINE' : 'VALIDATED',
    generatorVersion: LARGE_HOLDER_GENERATOR_VERSION }
  await mkdir(dirname(pointerPath), { recursive: true, mode: 0o700 })
  const temporary = join(dirname(pointerPath), `.current-${randomUUID()}.tmp`)
  let handle
  try {
    handle = await open(temporary, 'wx', 0o600)
    await handle.writeFile(`${JSON.stringify(publication)}\n`)
    await handle.sync()
    await handle.close()
    handle = undefined
    await rename(temporary, pointerPath)
  } catch (error) {
    await handle?.close()
    await unlink(temporary).catch(() => undefined)
    throw error
  }
  return 'PUBLISHED'
}
