import { createHash } from 'node:crypto'
import path from 'node:path'

export const WEEKLY_BACKUP_SCHEMA_VERSION = 1 as const
export const MINIMUM_DESTINATION_RESERVE_BYTES = 150_000_000_000
export const MAXIMUM_WRITER_HOLD_MS = 8 * 60 * 60 * 1_000
export const MAXIMUM_VERIFICATION_MS = 40 * 60 * 60 * 1_000

export const WEEKLY_BACKUP_WRITER_LABELS = [
  'com.stockboard.classification-sync',
  'com.stockboard.data-freshness-guard',
  'com.stockboard.db-maintenance',
  'com.stockboard.earnings-refresh',
  'com.stockboard.kabutan-material-news',
  'com.stockboard.kabutan-themes',
  'com.stockboard.large-holder-update',
  'com.stockboard.ml-freshness-guard',
  'com.stockboard.ml-learning',
  'com.stockboard.ml-weekly-governance',
  'com.stockboard.trigger-historical-scan',
  'com.stockboard.trigger-ml-frozen-monitor',
  'com.stockboard.update-latest',
  'com.stockboard.us-ml-weekly',
  'com.stockboard.us-update-latest',
  'com.stockboard.weekly-optimization',
] as const

export const WEEKLY_BACKUP_READER_LABELS = [
  'com.stockboard.web',
  'com.stockboard.analog-search',
  'com.stockboard.friend-readonly-gateway',
  'com.stockboard.web-health',
] as const

export type Market = 'JP' | 'US'
export type PriorGenerationStatus = 'VERIFIED' | 'ACQUIRED_WITH_LIMITATIONS'

export type WeeklyBackupPlan = {
  schemaVersion: typeof WEEKLY_BACKUP_SCHEMA_VERSION
  runId: string
  oneShot: true
  startsAt: string
  mustStartBefore: string
  mustFinishBefore: string
  destinationReserveBytes: number
  maximumCandidateGrowthBytes: number
  maximumCombinedWalBytes: number
  maximumWalGrowthBytes: number
  maximumWriterHoldMs: number
  maximumVerificationMs: number
  sourceMount: string
  destinationMount: string
  sourcePhysicalSerial: string
  destinationPhysicalSerial: string
  sourceVolumeUuid: string
  destinationVolumeUuid: string
  sourceDatabasePaths: Record<Market, string>
  priorDatabasePaths: Record<Market, string>
  destinationRoot: string
  priorGenerationId: string
  priorGenerationStatus: PriorGenerationStatus
  writerLabels: string[]
  readerLabelsKeptOnline: string[]
  runbookSha256: string
  priorManifestPath: string
  priorManifestSha256: string
  sqliteVersion: string
  sqliteBinaryPath: string
  sqliteBinarySha256: string
  sqliteRsyncBinaryPath: string
  sqliteRsyncBinarySha256: string
  sqliteToolsArchiveSha3: string
}

export type WeeklyBackupObservation = {
  now: string
  sourceMount: string
  destinationMount: string
  sourcePhysicalSerial: string
  destinationPhysicalSerial: string
  sourceVolumeUuid: string
  destinationVolumeUuid: string
  destinationFreeBytes: number
  combinedWalBytes: number
  activeWriterLabels: string[]
  unknownWriterLabels: string[]
  writerLockOwners: string[]
  updateWindowConflict: boolean
  webHealthy: boolean
  analogHealthy: boolean
  existingCandidatePath: boolean
  existingCompleteManifest: boolean
  priorManifestSha256: string
  sqliteVersion: string
  sqliteBinarySha256: string
  sqliteRsyncBinarySha256: string
  sqliteToolsArchiveSha3: string
}

export type MarketVerification = {
  market: Market
  generationId: string
  syncStatus: 'PASS' | 'FAIL'
  databaseSha256: string
  quickCheck: 'ok' | string
  integrityCheck: 'ok' | string
  readOnlyReopen: boolean
  restoreQuickCheck: 'ok' | string
  restoreIntegrityCheck: 'ok' | string
  sourceWalGrowthBytes: number
  candidatePhysicalGrowthBytes: number
}

export type PromotionEvidence = {
  generationId: string
  priorGenerationId: string
  priorGenerationStatus: PriorGenerationStatus
  priorGenerationUnchanged: boolean
  writerHoldDurationMs: number
  verificationDurationMs: number
  destinationFreeBytesAfter: number
  completeManifestExists: boolean
  candidateIsUniquePath: boolean
  writerStatesRestored: boolean
  dailySchedulesUnchanged: boolean
  webHealthyAfter: boolean
  analogHealthyAfter: boolean
  jp: MarketVerification
  us: MarketVerification
}

export type WeeklyBackupCompleteManifest = {
  kind: 'stockboard-weekly-backup-generation'
  schemaVersion: typeof WEEKLY_BACKUP_SCHEMA_VERSION
  status: 'VERIFIED'
  generationId: string
  priorGeneration: {
    id: string
    status: PriorGenerationStatus
    promotedAsVerified: false
    unchanged: true
  }
  markets: { JP: MarketVerification; US: MarketVerification }
  writerHoldDurationMs: number
  verificationDurationMs: number
  destinationFreeBytesAfter: number
  writerStatesRestored: true
  dailySchedulesUnchanged: true
  readServicesHealthyAfter: true
  completedAt: string
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, canonical(child)]))
  }
  return value
}

export function stableJson(value: unknown): string {
  return `${JSON.stringify(canonical(value), null, 2)}\n`
}

export function weeklyBackupPlanSha256(plan: WeeklyBackupPlan): string {
  return createHash('sha256').update(stableJson(plan)).digest('hex')
}

function assertFiniteNonNegative(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`INVALID_${name}`)
}

function assertExactSet(name: string, actual: string[], expected: readonly string[]): void {
  const normalizedActual = [...new Set(actual)].sort()
  const normalizedExpected = [...expected].sort()
  if (JSON.stringify(normalizedActual) !== JSON.stringify(normalizedExpected)) {
    throw new Error(`${name}_MISMATCH`)
  }
}

export function validateWeeklyBackupPlan(plan: WeeklyBackupPlan): void {
  if (plan.schemaVersion !== WEEKLY_BACKUP_SCHEMA_VERSION) throw new Error('WEEKLY_BACKUP_SCHEMA_MISMATCH')
  if (plan.oneShot !== true) throw new Error('WEEKLY_BACKUP_MUST_BE_ONE_SHOT')
  if (!/^[a-z0-9][a-z0-9-]{7,127}$/.test(plan.runId)) throw new Error('INVALID_WEEKLY_BACKUP_RUN_ID')
  if (!pathLikeAbsolute(plan.destinationRoot)) throw new Error('DESTINATION_ROOT_MUST_BE_ABSOLUTE')
  if (!pathLikeAbsolute(plan.sourceMount) || !pathLikeAbsolute(plan.destinationMount)
    || plan.sourceMount === plan.destinationMount) throw new Error('MOUNT_IDENTITY_INVALID')
  if (!plan.sourcePhysicalSerial || !plan.destinationPhysicalSerial
    || plan.sourcePhysicalSerial === plan.destinationPhysicalSerial) throw new Error('PHYSICAL_DEVICE_IDENTITY_INVALID')
  if (!['VERIFIED', 'ACQUIRED_WITH_LIMITATIONS'].includes(plan.priorGenerationStatus)) {
    throw new Error('PRIOR_GENERATION_STATUS_INVALID')
  }
  if (!isWithin(plan.destinationMount, plan.destinationRoot)) {
    throw new Error('DESTINATION_ROOT_OUTSIDE_DESTINATION_MOUNT')
  }
  for (const market of ['JP', 'US'] as const) {
    if (!pathLikeAbsolute(plan.sourceDatabasePaths[market])
      || !pathLikeAbsolute(plan.priorDatabasePaths[market])) throw new Error(`${market}_DATABASE_PATH_INVALID`)
    if (!isWithin(plan.sourceMount, plan.sourceDatabasePaths[market])) throw new Error(`${market}_SOURCE_PATH_OUTSIDE_MOUNT`)
    if (!isWithin(plan.destinationMount, plan.priorDatabasePaths[market])) {
      throw new Error(`${market}_PRIOR_PATH_OUTSIDE_DESTINATION_MOUNT`)
    }
  }
  if (!plan.sourceVolumeUuid || !plan.destinationVolumeUuid
    || plan.sourceVolumeUuid === plan.destinationVolumeUuid) throw new Error('VOLUME_IDENTITY_INVALID')
  const startsAt = Date.parse(plan.startsAt)
  const mustStartBefore = Date.parse(plan.mustStartBefore)
  const mustFinishBefore = Date.parse(plan.mustFinishBefore)
  if (![startsAt, mustStartBefore, mustFinishBefore].every(Number.isFinite)
    || startsAt >= mustStartBefore || mustStartBefore >= mustFinishBefore) {
    throw new Error('WEEKLY_BACKUP_WINDOW_INVALID')
  }
  assertFiniteNonNegative('DESTINATION_RESERVE_BYTES', plan.destinationReserveBytes)
  assertFiniteNonNegative('MAXIMUM_CANDIDATE_GROWTH_BYTES', plan.maximumCandidateGrowthBytes)
  assertFiniteNonNegative('MAXIMUM_COMBINED_WAL_BYTES', plan.maximumCombinedWalBytes)
  assertFiniteNonNegative('MAXIMUM_WAL_GROWTH_BYTES', plan.maximumWalGrowthBytes)
  assertFiniteNonNegative('MAXIMUM_WRITER_HOLD_MS', plan.maximumWriterHoldMs)
  assertFiniteNonNegative('MAXIMUM_VERIFICATION_MS', plan.maximumVerificationMs)
  if (plan.destinationReserveBytes < MINIMUM_DESTINATION_RESERVE_BYTES) {
    throw new Error('DESTINATION_RESERVE_BELOW_150GB')
  }
  if (plan.maximumCandidateGrowthBytes === 0) throw new Error('CANDIDATE_GROWTH_BUDGET_REQUIRED')
  if (plan.maximumWriterHoldMs === 0 || plan.maximumWriterHoldMs > MAXIMUM_WRITER_HOLD_MS) {
    throw new Error('WRITER_HOLD_LIMIT_INVALID')
  }
  if (plan.maximumVerificationMs === 0 || plan.maximumVerificationMs > MAXIMUM_VERIFICATION_MS) {
    throw new Error('VERIFICATION_LIMIT_INVALID')
  }
  if (plan.maximumWriterHoldMs + plan.maximumVerificationMs > mustFinishBefore - startsAt) {
    throw new Error('EXECUTION_WINDOW_TOO_SHORT')
  }
  assertExactSet('WRITER_LABEL_ALLOWLIST', plan.writerLabels, WEEKLY_BACKUP_WRITER_LABELS)
  assertExactSet('READER_LABEL_ALLOWLIST', plan.readerLabelsKeptOnline, WEEKLY_BACKUP_READER_LABELS)
  if (!pathLikeAbsolute(plan.priorManifestPath)) throw new Error('PRIOR_MANIFEST_PATH_INVALID')
  if (!isWithin(plan.destinationMount, plan.priorManifestPath)) {
    throw new Error('PRIOR_MANIFEST_OUTSIDE_DESTINATION_MOUNT')
  }
  if (!pathLikeAbsolute(plan.sqliteBinaryPath) || !pathLikeAbsolute(plan.sqliteRsyncBinaryPath)) {
    throw new Error('SQLITE_TOOL_PATH_INVALID')
  }
  if (!/^3\.54\./.test(plan.sqliteVersion)) throw new Error('UNAPPROVED_SQLITE_VERSION')
  for (const [name, hash] of [
    ['RUNBOOK_SHA256', plan.runbookSha256],
    ['PRIOR_MANIFEST_SHA256', plan.priorManifestSha256],
    ['SQLITE_BINARY_SHA256', plan.sqliteBinarySha256],
    ['SQLITE_RSYNC_BINARY_SHA256', plan.sqliteRsyncBinarySha256],
  ] as const) {
    if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error(`INVALID_${name}`)
  }
  if (!/^[a-f0-9]{64}$/.test(plan.sqliteToolsArchiveSha3)) throw new Error('INVALID_SQLITE_TOOL_ARCHIVE_SHA3')
}

function pathLikeAbsolute(value: string): boolean {
  return value.startsWith('/') && !value.includes('\0')
}

function isWithin(root: string, candidate: string): boolean {
  const normalizedRoot = path.resolve(root)
  const normalizedCandidate = path.resolve(candidate)
  return normalizedCandidate === normalizedRoot || normalizedCandidate.startsWith(`${normalizedRoot}${path.sep}`)
}

export function availableCandidateGrowthBytes(plan: WeeklyBackupPlan, destinationFreeBytes: number): number {
  assertFiniteNonNegative('DESTINATION_FREE_BYTES', destinationFreeBytes)
  return Math.max(0, destinationFreeBytes - plan.destinationReserveBytes)
}

export function assertWeeklyBackupPreflight(plan: WeeklyBackupPlan, observed: WeeklyBackupObservation): void {
  validateWeeklyBackupPlan(plan)
  const now = Date.parse(observed.now)
  if (!Number.isFinite(now) || now < Date.parse(plan.startsAt) || now >= Date.parse(plan.mustStartBefore)) {
    throw new Error('OUTSIDE_APPROVED_START_WINDOW')
  }
  if (now + plan.maximumWriterHoldMs + plan.maximumVerificationMs > Date.parse(plan.mustFinishBefore)) {
    throw new Error('REMAINING_EXECUTION_WINDOW_TOO_SHORT')
  }
  if (observed.sourceVolumeUuid !== plan.sourceVolumeUuid
    || observed.destinationVolumeUuid !== plan.destinationVolumeUuid) throw new Error('VOLUME_IDENTITY_MISMATCH')
  if (observed.sourceMount !== plan.sourceMount || observed.destinationMount !== plan.destinationMount) {
    throw new Error('MOUNT_IDENTITY_MISMATCH')
  }
  if (observed.sourcePhysicalSerial !== plan.sourcePhysicalSerial
    || observed.destinationPhysicalSerial !== plan.destinationPhysicalSerial
    || observed.sourcePhysicalSerial === observed.destinationPhysicalSerial) {
    throw new Error('PHYSICAL_DEVICE_IDENTITY_MISMATCH')
  }
  if (observed.sqliteVersion !== plan.sqliteVersion
    || observed.sqliteBinarySha256 !== plan.sqliteBinarySha256
    || observed.sqliteRsyncBinarySha256 !== plan.sqliteRsyncBinarySha256
    || observed.sqliteToolsArchiveSha3 !== plan.sqliteToolsArchiveSha3) throw new Error('SQLITE_TOOL_IDENTITY_MISMATCH')
  if (observed.priorManifestSha256 !== plan.priorManifestSha256) {
    throw new Error('PRIOR_GENERATION_MANIFEST_MISMATCH')
  }
  if (observed.combinedWalBytes > plan.maximumCombinedWalBytes) throw new Error('SOURCE_WAL_LIMIT_EXCEEDED')
  if (availableCandidateGrowthBytes(plan, observed.destinationFreeBytes) < plan.maximumCandidateGrowthBytes) {
    throw new Error('INSUFFICIENT_DESTINATION_HEADROOM')
  }
  if (observed.unknownWriterLabels.length > 0) throw new Error('UNKNOWN_WRITER_LABEL')
  if (observed.writerLockOwners.length > 0) throw new Error('ACTIVE_WRITER_LOCK')
  if (observed.updateWindowConflict) throw new Error('DAILY_UPDATE_WINDOW_CONFLICT')
  if (!observed.webHealthy || !observed.analogHealthy) throw new Error('READ_SERVICE_NOT_HEALTHY')
  if (observed.existingCandidatePath || observed.existingCompleteManifest) throw new Error('RUN_ID_COLLISION')
  const active = new Set(observed.activeWriterLabels)
  for (const label of active) {
    if (!plan.writerLabels.includes(label)) throw new Error(`UNAPPROVED_ACTIVE_WRITER:${label}`)
  }
}

function assertVerification(market: Market, expectedGeneration: string, value: MarketVerification,
  plan: WeeklyBackupPlan): void {
  if (value.market !== market || value.generationId !== expectedGeneration) {
    throw new Error(`${market}_GENERATION_MISMATCH`)
  }
  if (value.syncStatus !== 'PASS') throw new Error(`${market}_SYNC_NOT_PASS`)
  if (!/^[a-f0-9]{64}$/.test(value.databaseSha256)) throw new Error(`${market}_HASH_INVALID`)
  if (value.quickCheck !== 'ok' || value.integrityCheck !== 'ok' || !value.readOnlyReopen
    || value.restoreQuickCheck !== 'ok' || value.restoreIntegrityCheck !== 'ok') {
    throw new Error(`${market}_SQLITE_VERIFICATION_INCOMPLETE`)
  }
  if (value.sourceWalGrowthBytes < 0 || value.sourceWalGrowthBytes > plan.maximumWalGrowthBytes) {
    throw new Error(`${market}_WAL_GROWTH_LIMIT_EXCEEDED`)
  }
  if (value.candidatePhysicalGrowthBytes < 0
    || value.candidatePhysicalGrowthBytes > plan.maximumCandidateGrowthBytes) {
    throw new Error(`${market}_CANDIDATE_GROWTH_LIMIT_EXCEEDED`)
  }
}

export function buildWeeklyBackupCompleteManifest(plan: WeeklyBackupPlan, evidence: PromotionEvidence,
  completedAt: string): WeeklyBackupCompleteManifest {
  validateWeeklyBackupPlan(plan)
  if (evidence.completeManifestExists) throw new Error('COMPLETE_MANIFEST_ALREADY_EXISTS')
  if (!evidence.candidateIsUniquePath) throw new Error('CANDIDATE_PATH_NOT_UNIQUE')
  if (!evidence.priorGenerationUnchanged) throw new Error('PRIOR_GENERATION_CHANGED')
  if (!evidence.writerStatesRestored || !evidence.dailySchedulesUnchanged) {
    throw new Error('WRITER_RUNTIME_STATE_NOT_RESTORED')
  }
  if (!evidence.webHealthyAfter || !evidence.analogHealthyAfter) throw new Error('READ_SERVICE_NOT_HEALTHY_AFTER_BACKUP')
  if (evidence.priorGenerationId !== plan.priorGenerationId
    || evidence.priorGenerationStatus !== plan.priorGenerationStatus) throw new Error('PRIOR_GENERATION_IDENTITY_MISMATCH')
  if (evidence.writerHoldDurationMs < 0 || evidence.writerHoldDurationMs > plan.maximumWriterHoldMs) {
    throw new Error('WRITER_HOLD_LIMIT_EXCEEDED')
  }
  if (evidence.verificationDurationMs < 0 || evidence.verificationDurationMs > plan.maximumVerificationMs) {
    throw new Error('VERIFICATION_LIMIT_EXCEEDED')
  }
  if (evidence.destinationFreeBytesAfter < plan.destinationReserveBytes) {
    throw new Error('DESTINATION_RESERVE_BREACHED')
  }
  assertVerification('JP', evidence.generationId, evidence.jp, plan)
  assertVerification('US', evidence.generationId, evidence.us, plan)
  if (evidence.jp.candidatePhysicalGrowthBytes + evidence.us.candidatePhysicalGrowthBytes
    > plan.maximumCandidateGrowthBytes) throw new Error('COMBINED_CANDIDATE_GROWTH_LIMIT_EXCEEDED')
  if (!Number.isFinite(Date.parse(completedAt))) throw new Error('INVALID_COMPLETION_TIME')
  return {
    kind: 'stockboard-weekly-backup-generation',
    schemaVersion: WEEKLY_BACKUP_SCHEMA_VERSION,
    status: 'VERIFIED',
    generationId: evidence.generationId,
    priorGeneration: {
      id: evidence.priorGenerationId,
      status: evidence.priorGenerationStatus,
      promotedAsVerified: false,
      unchanged: true,
    },
    markets: { JP: evidence.jp, US: evidence.us },
    writerHoldDurationMs: evidence.writerHoldDurationMs,
    verificationDurationMs: evidence.verificationDurationMs,
    destinationFreeBytesAfter: evidence.destinationFreeBytesAfter,
    writerStatesRestored: true,
    dailySchedulesUnchanged: true,
    readServicesHealthyAfter: true,
    completedAt,
  }
}
