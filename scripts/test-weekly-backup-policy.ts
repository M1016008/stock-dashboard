import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import {
  MINIMUM_DESTINATION_RESERVE_BYTES,
  WEEKLY_BACKUP_READER_LABELS,
  WEEKLY_BACKUP_SCHEMA_VERSION,
  WEEKLY_BACKUP_WRITER_LABELS,
  assertWeeklyBackupPreflight,
  availableCandidateGrowthBytes,
  buildWeeklyBackupCompleteManifest,
  validateWeeklyBackupPlan,
  weeklyBackupPlanSha256,
  type MarketVerification,
  type PromotionEvidence,
  type WeeklyBackupObservation,
  type WeeklyBackupPlan,
} from '@/lib/storage/weekly-backup-policy'

const toolSha3 = 'a3106c6db3b50ec9ef4fde4edfafe7504179e9bfd7e0816a280b29c4d56a2e7b'
const plan: WeeklyBackupPlan = {
  schemaVersion: WEEKLY_BACKUP_SCHEMA_VERSION,
  runId: 'weekly-fixture-20261025-v1',
  oneShot: true,
  startsAt: '2026-10-25T02:00:00+09:00',
  mustStartBefore: '2026-10-25T02:15:00+09:00',
  mustFinishBefore: '2026-10-27T03:00:00+09:00',
  destinationReserveBytes: MINIMUM_DESTINATION_RESERVE_BYTES,
  maximumCandidateGrowthBytes: 700_000_000_000,
  maximumCombinedWalBytes: 64 * 1024 ** 3,
  maximumWalGrowthBytes: 0,
  maximumWriterHoldMs: 8 * 60 * 60 * 1_000,
  maximumVerificationMs: 40 * 60 * 60 * 1_000,
  sourceMount: '/fixture/source',
  destinationMount: '/fixture',
  sourcePhysicalSerial: 'source-serial',
  destinationPhysicalSerial: 'destination-serial',
  sourceVolumeUuid: 'source-uuid',
  destinationVolumeUuid: 'destination-uuid',
  sourceDatabasePaths: { JP: '/fixture/source/jp.db', US: '/fixture/source/us.db' },
  priorDatabasePaths: {
    JP: '/fixture/weekly-backups/prior/jp.db',
    US: '/fixture/weekly-backups/prior/us.db',
  },
  destinationRoot: '/fixture/weekly-backups',
  priorGenerationId: 'acquired-with-limitations-v1',
  priorGenerationStatus: 'ACQUIRED_WITH_LIMITATIONS',
  writerLabels: [...WEEKLY_BACKUP_WRITER_LABELS],
  readerLabelsKeptOnline: [...WEEKLY_BACKUP_READER_LABELS],
  runbookSha256: 'c'.repeat(64),
  priorManifestPath: '/fixture/weekly-backups/prior/BACKUP_ACQUIRED_WITH_LIMITATIONS.manifest.json',
  priorManifestSha256: 'd'.repeat(64),
  sqliteVersion: '3.54.1',
  sqliteBinaryPath: '/fixture/tools/sqlite3',
  sqliteBinarySha256: 'e'.repeat(64),
  sqliteRsyncBinaryPath: '/fixture/tools/sqlite3_rsync',
  sqliteRsyncBinarySha256: 'f'.repeat(64),
  sqliteToolsArchiveSha3: toolSha3,
}

const observed: WeeklyBackupObservation = {
  now: '2026-10-25T02:05:00+09:00',
  sourceMount: '/fixture/source',
  destinationMount: '/fixture',
  sourcePhysicalSerial: 'source-serial',
  destinationPhysicalSerial: 'destination-serial',
  sourceVolumeUuid: 'source-uuid',
  destinationVolumeUuid: 'destination-uuid',
  destinationFreeBytes: 894_700_000_000,
  combinedWalBytes: 1_000_000,
  activeWriterLabels: ['com.stockboard.update-latest', 'com.stockboard.us-update-latest'],
  unknownWriterLabels: [],
  writerLockOwners: [],
  updateWindowConflict: false,
  webHealthy: true,
  analogHealthy: true,
  existingCandidatePath: false,
  existingCompleteManifest: false,
  priorManifestSha256: plan.priorManifestSha256,
  sqliteVersion: '3.54.1',
  sqliteBinarySha256: plan.sqliteBinarySha256,
  sqliteRsyncBinarySha256: plan.sqliteRsyncBinarySha256,
  sqliteToolsArchiveSha3: toolSha3,
}

const verification = (market: 'JP' | 'US'): MarketVerification => ({
  market,
  generationId: 'weekly-generation-v2',
  syncStatus: 'PASS',
  databaseSha256: market === 'JP' ? 'a'.repeat(64) : 'b'.repeat(64),
  quickCheck: 'ok',
  integrityCheck: 'ok',
  readOnlyReopen: true,
  restoreQuickCheck: 'ok',
  restoreIntegrityCheck: 'ok',
  sourceWalGrowthBytes: 0,
  candidatePhysicalGrowthBytes: market === 'JP' ? 35_000_000_000 : 45_000_000_000,
})

const evidence: PromotionEvidence = {
  generationId: 'weekly-generation-v2',
  priorGenerationId: plan.priorGenerationId,
  priorGenerationStatus: 'ACQUIRED_WITH_LIMITATIONS',
  priorGenerationUnchanged: true,
  writerHoldDurationMs: 90 * 60 * 1_000,
  verificationDurationMs: 12 * 60 * 60 * 1_000,
  destinationFreeBytesAfter: 800_000_000_000,
  completeManifestExists: false,
  candidateIsUniquePath: true,
  writerStatesRestored: true,
  dailySchedulesUnchanged: true,
  webHealthyAfter: true,
  analogHealthyAfter: true,
  jp: verification('JP'),
  us: verification('US'),
}

validateWeeklyBackupPlan(plan)
assertWeeklyBackupPreflight(plan, observed)
assert.equal(availableCandidateGrowthBytes(plan, observed.destinationFreeBytes), 744_700_000_000)
assert.match(weeklyBackupPlanSha256(plan), /^[a-f0-9]{64}$/)

const manifest = buildWeeklyBackupCompleteManifest(plan, evidence, '2026-10-25T14:00:00+09:00')
assert.equal(manifest.status, 'VERIFIED')
assert.equal(manifest.priorGeneration.status, 'ACQUIRED_WITH_LIMITATIONS')
assert.equal(manifest.priorGeneration.promotedAsVerified, false)

const initialPlan = JSON.parse(fs.readFileSync(
  'docs/production-weekly-backup-initial-plan-20261101.json', 'utf8')) as WeeklyBackupPlan
validateWeeklyBackupPlan(initialPlan)
const initialPlanHash = weeklyBackupPlanSha256(initialPlan)
const frozenPlanHash = fs.readFileSync(
  'docs/production-weekly-backup-initial-plan-20261101.sha256', 'utf8').trim().split(/\s+/)[0]
assert.equal(initialPlanHash, frozenPlanHash)
assert.equal(initialPlan.runbookSha256, createHash('sha256')
  .update(fs.readFileSync('docs/production-weekly-backup-runbook.md')).digest('hex'))

function rejects(mutate: (nextPlan: WeeklyBackupPlan, nextObserved: WeeklyBackupObservation,
  nextEvidence: PromotionEvidence) => void, pattern: RegExp): void {
  const nextPlan = structuredClone(plan)
  const nextObserved = structuredClone(observed)
  const nextEvidence = structuredClone(evidence)
  mutate(nextPlan, nextObserved, nextEvidence)
  assert.throws(() => {
    validateWeeklyBackupPlan(nextPlan)
    assertWeeklyBackupPreflight(nextPlan, nextObserved)
    buildWeeklyBackupCompleteManifest(nextPlan, nextEvidence, '2026-10-25T14:00:00+09:00')
  }, pattern)
}

rejects((next) => { next.writerLabels.pop() }, /WRITER_LABEL_ALLOWLIST_MISMATCH/)
rejects((next) => { next.sourceDatabasePaths.JP = '/fixture/source/../outside.db' }, /JP_SOURCE_PATH_OUTSIDE_MOUNT/)
rejects((_, next) => { next.destinationFreeBytes = 849_999_999_999 }, /INSUFFICIENT_DESTINATION_HEADROOM/)
rejects((_, next) => { next.combinedWalBytes = 65 * 1024 ** 3 }, /SOURCE_WAL_LIMIT_EXCEEDED/)
rejects((_, next) => { next.unknownWriterLabels = ['com.stockboard.unknown-writer'] }, /UNKNOWN_WRITER_LABEL/)
rejects((_, next) => { next.writerLockOwners = ['update-latest:123'] }, /ACTIVE_WRITER_LOCK/)
rejects((_, next) => { next.updateWindowConflict = true }, /DAILY_UPDATE_WINDOW_CONFLICT/)
rejects((_, next) => { next.webHealthy = false }, /READ_SERVICE_NOT_HEALTHY/)
rejects((_, next) => { next.existingCandidatePath = true }, /RUN_ID_COLLISION/)
rejects((_, next) => { next.priorManifestSha256 = '0'.repeat(64) }, /PRIOR_GENERATION_MANIFEST_MISMATCH/)
rejects((_, next) => { next.sqliteRsyncBinarySha256 = '0'.repeat(64) }, /SQLITE_TOOL_IDENTITY_MISMATCH/)
rejects((_, __, next) => { next.jp.generationId = 'other-generation' }, /JP_GENERATION_MISMATCH/)
rejects((_, __, next) => { next.us.integrityCheck = 'corrupt' }, /US_SQLITE_VERIFICATION_INCOMPLETE/)
rejects((_, __, next) => { next.jp.sourceWalGrowthBytes = 1 }, /JP_WAL_GROWTH_LIMIT_EXCEEDED/)
rejects((_, __, next) => { next.destinationFreeBytesAfter = 149_999_999_999 }, /DESTINATION_RESERVE_BREACHED/)
rejects((_, __, next) => { next.priorGenerationUnchanged = false }, /PRIOR_GENERATION_CHANGED/)
rejects((_, __, next) => { next.completeManifestExists = true }, /COMPLETE_MANIFEST_ALREADY_EXISTS/)
rejects((_, __, next) => { next.writerStatesRestored = false }, /WRITER_RUNTIME_STATE_NOT_RESTORED/)
rejects((_, __, next) => { next.webHealthyAfter = false }, /READ_SERVICE_NOT_HEALTHY_AFTER_BACKUP/)

console.log(JSON.stringify({
  verdict: 'PASS',
  planHash: weeklyBackupPlanSha256(plan),
  candidateBudgetBytes: availableCandidateGrowthBytes(plan, observed.destinationFreeBytes),
  oldLimitedGenerationPromoted: false,
  writerHoldMaximumHours: plan.maximumWriterHoldMs / 3_600_000,
  verificationMaximumHours: plan.maximumVerificationMs / 3_600_000,
  failClosedCases: 18,
}, null, 2))
