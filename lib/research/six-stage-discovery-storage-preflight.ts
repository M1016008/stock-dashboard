import os from 'node:os'
import path from 'node:path'
import {
  ExternalStorageGuard,
  storageFatalLatchPath,
  type GuardConfig,
  type StorageProbe,
  systemStorageProbe,
} from '@/lib/storage/external-storage-guard'
import {
  WEEKLY_BACKUP_READER_LABELS,
  WEEKLY_BACKUP_WRITER_LABELS,
} from '@/lib/storage/weekly-backup-policy'
import {
  LAUNCHD_RESTORE_RESERVE_BASE_MS,
  LAUNCHD_RESTORE_RESERVE_PER_WRITER_MS,
} from '@/lib/storage/launchd-writer-hold-driver'
import { resolveThroughExistingAncestor } from '@/lib/runtime/isolation'

export const SIX_STAGE_DISCOVERY_SCOPE = 'six-stage-discovery-source-export'
export const SIX_STAGE_DISCOVERY_PLAN_ID = 'SIX_STAGE_DISCOVERY_SOURCE_EXTRACTION_ONE_SHOT_V2'

export type SixStageStoragePreflightMode = 'LOCAL_FIXTURE' | 'AUTHORIZED_PRODUCTION_READ'

export type SixStageLaunchdIdentity = Readonly<{
  label: string
  definitionSha256: string
  program: string
  plistPath: string
}>

export type SixStageDiscoveryStoragePlan = Readonly<{
  planId: string
  authorization: Readonly<{
    productionDatabaseConnection: boolean
    execution: boolean
    oneShot: boolean
    executionWindow: Readonly<{
      startNotBefore: string
      startNoLaterThan: string
      endNoLaterThan: string
      maximumTotalRunSeconds: number
      maximumSourceReadSeconds: number
    }>
  }>
  sourceDatabase: Readonly<{ path: string }>
  writeOnceDestination: Readonly<{
    root: string
    incompleteDirectory: string
    finalDirectory: string
  }>
  resourceLimits: Readonly<{
    maximumSourceReadSeconds: number
    maximumTotalRunSeconds: number
    maximumOutputBytes: number
    minimumFreeBytesBeforeStart: number
    minimumFreeBytesAfterCompletion: number
    maximumWalBytesAtStart: number
    maximumWalGrowthBytes: number
    maximumSourceReadBytesPerSecond: number
  }>
  writerAndHealthIsolation: Readonly<{
    webHealth: string
    analogHealth: string
    healthIntervalSeconds: number
    handleProbeIntervalSeconds: number
    handleProbeTimeoutSeconds: number
    maximumWriterHoldSeconds: number
    writerRestoreReserveSeconds: number
    approvedWriters: readonly SixStageLaunchdIdentity[]
    approvedReaders: readonly SixStageLaunchdIdentity[]
  }>
  chunkContract: Readonly<{
    rowsPerChunk: number
    sleepBetweenChunksMs: number
  }>
  storageGuard: Readonly<{
    executionScope: string
    mode: SixStageStoragePreflightMode
    mountPath: string
    volumeUuid: string
    databasePath: string
    incidentPolicy: 'ISOLATED_LOCAL' | 'PRODUCTION_SHARED'
  }>
}>

export type PreparedSixStageStoragePreflight = Readonly<{
  mode: SixStageStoragePreflightMode
  sourcePath: string
  incidentDirectory: string
  guardConfig: GuardConfig
}>

export type CertifiedSixStageStoragePreflight = Readonly<{
  guard: ExternalStorageGuard
}>

export class SixStageStoragePreflightNoGo extends Error {
  readonly code = 'SIX_STAGE_STORAGE_PREFLIGHT_NO_GO'

  constructor(message: string) {
    super(message)
    this.name = 'SixStageStoragePreflightNoGo'
  }
}

type PrepareOptions = Readonly<{
  mode: SixStageStoragePreflightMode
  environment?: NodeJS.ProcessEnv
  productionIncidentDirectory?: string
}>

type CertifyOptions = Readonly<{
  probe?: StorageProbe
}>

function noGo(message: string): never {
  throw new SixStageStoragePreflightNoGo(message)
}

function required(value: string | undefined, name: string): string {
  const normalized = value?.trim() ?? ''
  if (!normalized) noGo(`${name} is required before the Production Storage Guard can run`)
  return normalized
}

function exactPath(value: string, name: string): string {
  if (!path.isAbsolute(value) || path.normalize(value) !== value) noGo(`${name} must be an exact absolute path`)
  return value
}

function contained(mountPath: string, targetPath: string): boolean {
  const relative = path.relative(mountPath, targetPath)
  return relative !== ''
    && relative !== '..'
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative)
}

function sameOrContained(parentPath: string, targetPath: string): boolean {
  const relative = path.relative(parentPath, targetPath)
  return relative === ''
    || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
}

function productionIncidentDirectory(): string {
  return path.join(os.homedir(), 'Library', 'Application Support', 'StockBoard', 'storage-incidents')
}

function positiveSafeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) noGo(`${name} must be a positive safe integer`)
  return value
}

function nonNegativeSafeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) noGo(`${name} must be a non-negative safe integer`)
  return value
}

function healthUrl(value: string, name: string): string {
  const normalized = required(value, name)
  let parsed: URL
  try {
    parsed = new URL(normalized)
  } catch {
    noGo(`${name} must be a valid HTTP URL`)
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) noGo(`${name} must be a valid HTTP URL`)
  return normalized
}

function assertLaunchdIdentities(
  identities: readonly SixStageLaunchdIdentity[],
  expectedLabels: readonly string[],
  name: string,
): void {
  if (!Array.isArray(identities)) noGo(`${name} must be an array`)
  const labels = identities.map((identity) => identity?.label)
  if (new Set(labels).size !== labels.length
    || JSON.stringify([...labels].sort()) !== JSON.stringify([...expectedLabels].sort())) {
    noGo(`${name} does not match the approved runtime inventory`)
  }
  for (const identity of identities) {
    required(identity.label, `${name}.label`)
    if (!/^[a-f0-9]{64}$/.test(required(identity.definitionSha256, `${name}.definitionSha256`))) {
      noGo(`${name}.definitionSha256 must be lowercase SHA-256`)
    }
    exactPath(required(identity.program, `${name}.program`), `${name}.program`)
    exactPath(required(identity.plistPath, `${name}.plistPath`), `${name}.plistPath`)
  }
}

export function prepareSixStageDiscoveryStoragePreflight(
  plan: SixStageDiscoveryStoragePlan,
  options: PrepareOptions,
): PreparedSixStageStoragePreflight {
  const environment = options.environment ?? process.env
  const expectedIncidentDirectory = path.resolve(
    options.productionIncidentDirectory ?? productionIncidentDirectory(),
  )

  if (!plan || typeof plan !== 'object') noGo('invalid extraction plan')
  if (plan.planId !== SIX_STAGE_DISCOVERY_PLAN_ID) noGo('unsupported or superseded extraction plan')
  if (!plan.authorization || typeof plan.authorization !== 'object'
    || !plan.sourceDatabase || typeof plan.sourceDatabase !== 'object'
    || !plan.storageGuard || typeof plan.storageGuard !== 'object'
    || !plan.writeOnceDestination || typeof plan.writeOnceDestination !== 'object'
    || !plan.resourceLimits || typeof plan.resourceLimits !== 'object'
    || !plan.writerAndHealthIsolation || typeof plan.writerAndHealthIsolation !== 'object'
    || !plan.chunkContract || typeof plan.chunkContract !== 'object') {
    noGo('extraction plan is missing the Storage Guard contract')
  }
  if (!plan.authorization.oneShot
    || !plan.authorization.execution
    || !plan.authorization.productionDatabaseConnection) {
    noGo('the plan does not contain explicit one-shot Production read authorization')
  }
  if (plan.storageGuard.mode !== options.mode) noGo('plan and runtime preflight modes differ')
  if (plan.storageGuard.executionScope !== SIX_STAGE_DISCOVERY_SCOPE) noGo('invalid research execution scope in plan')
  if (required(environment.STOCKBOARD_RESEARCH_EXECUTION_SCOPE, 'STOCKBOARD_RESEARCH_EXECUTION_SCOPE')
    !== SIX_STAGE_DISCOVERY_SCOPE) {
    noGo('invalid research execution scope in environment')
  }
  if (required(environment.STOCKBOARD_RESEARCH_PREFLIGHT_MODE, 'STOCKBOARD_RESEARCH_PREFLIGHT_MODE')
    !== options.mode) {
    noGo('invalid research preflight mode in environment')
  }

  const mountPath = exactPath(required(environment.STOCK_DATA_MOUNT_PATH, 'STOCK_DATA_MOUNT_PATH'), 'STOCK_DATA_MOUNT_PATH')
  const volumeUuid = required(environment.STOCK_DATA_VOLUME_UUID, 'STOCK_DATA_VOLUME_UUID')
  const databasePath = exactPath(required(environment.STOCKBOARD_DB_PATH, 'STOCKBOARD_DB_PATH'), 'STOCKBOARD_DB_PATH')
  const planMountPath = exactPath(required(plan.storageGuard.mountPath, 'plan.storageGuard.mountPath'), 'plan.storageGuard.mountPath')
  const planDatabasePath = exactPath(required(plan.storageGuard.databasePath, 'plan.storageGuard.databasePath'), 'plan.storageGuard.databasePath')
  const sourcePath = exactPath(required(plan.sourceDatabase.path, 'plan.sourceDatabase.path'), 'plan.sourceDatabase.path')
  const planVolumeUuid = required(plan.storageGuard.volumeUuid, 'plan.storageGuard.volumeUuid')
  const outputRoot = exactPath(required(plan.writeOnceDestination.root, 'plan.writeOnceDestination.root'), 'plan.writeOnceDestination.root')
  const incompleteDirectory = exactPath(required(plan.writeOnceDestination.incompleteDirectory, 'plan.writeOnceDestination.incompleteDirectory'), 'plan.writeOnceDestination.incompleteDirectory')
  const finalDirectory = exactPath(required(plan.writeOnceDestination.finalDirectory, 'plan.writeOnceDestination.finalDirectory'), 'plan.writeOnceDestination.finalDirectory')

  if (mountPath !== planMountPath) noGo('trusted mount path does not match the approved plan')
  if (volumeUuid.toUpperCase() !== planVolumeUuid.toUpperCase()) noGo('trusted volume UUID does not match the approved plan')
  if (databasePath !== planDatabasePath || sourcePath !== planDatabasePath) {
    noGo('trusted database path does not match the approved plan')
  }
  if (!contained(mountPath, databasePath)) noGo('approved database path is outside the trusted mount')
  if (!contained(mountPath, outputRoot)
    || !contained(outputRoot, incompleteDirectory)
    || !contained(outputRoot, finalDirectory)
    || incompleteDirectory === finalDirectory) {
    noGo('write-once destination is outside the trusted output boundary')
  }

  const executionWindow = plan.authorization.executionWindow
  if (!executionWindow || typeof executionWindow !== 'object') noGo('approved execution window is missing')
  const startNotBefore = Date.parse(executionWindow.startNotBefore)
  const startNoLaterThan = Date.parse(executionWindow.startNoLaterThan)
  const endNoLaterThan = Date.parse(executionWindow.endNoLaterThan)
  if (![startNotBefore, startNoLaterThan, endNoLaterThan].every(Number.isFinite)
    || startNotBefore > startNoLaterThan || startNoLaterThan > endNoLaterThan) {
    noGo('approved execution window is invalid')
  }
  const maximumTotalRunSeconds = positiveSafeInteger(executionWindow.maximumTotalRunSeconds, 'maximumTotalRunSeconds')
  const maximumSourceReadSeconds = positiveSafeInteger(executionWindow.maximumSourceReadSeconds, 'maximumSourceReadSeconds')
  if (maximumSourceReadSeconds > maximumTotalRunSeconds) noGo('source-read limit exceeds total runtime limit')
  if (positiveSafeInteger(plan.resourceLimits.maximumTotalRunSeconds, 'resourceLimits.maximumTotalRunSeconds') !== maximumTotalRunSeconds
    || positiveSafeInteger(plan.resourceLimits.maximumSourceReadSeconds, 'resourceLimits.maximumSourceReadSeconds') !== maximumSourceReadSeconds) {
    noGo('resource limits differ from the approved execution window')
  }
  positiveSafeInteger(plan.resourceLimits.maximumOutputBytes, 'resourceLimits.maximumOutputBytes')
  nonNegativeSafeInteger(plan.resourceLimits.minimumFreeBytesBeforeStart, 'resourceLimits.minimumFreeBytesBeforeStart')
  nonNegativeSafeInteger(plan.resourceLimits.minimumFreeBytesAfterCompletion, 'resourceLimits.minimumFreeBytesAfterCompletion')
  nonNegativeSafeInteger(plan.resourceLimits.maximumWalBytesAtStart, 'resourceLimits.maximumWalBytesAtStart')
  nonNegativeSafeInteger(plan.resourceLimits.maximumWalGrowthBytes, 'resourceLimits.maximumWalGrowthBytes')
  positiveSafeInteger(plan.resourceLimits.maximumSourceReadBytesPerSecond, 'resourceLimits.maximumSourceReadBytesPerSecond')
  if (plan.resourceLimits.minimumFreeBytesAfterCompletion > plan.resourceLimits.minimumFreeBytesBeforeStart) {
    noGo('post-run free-space floor exceeds the start requirement')
  }
  healthUrl(plan.writerAndHealthIsolation.webHealth, 'writerAndHealthIsolation.webHealth')
  healthUrl(plan.writerAndHealthIsolation.analogHealth, 'writerAndHealthIsolation.analogHealth')
  positiveSafeInteger(plan.writerAndHealthIsolation.healthIntervalSeconds, 'writerAndHealthIsolation.healthIntervalSeconds')
  positiveSafeInteger(plan.writerAndHealthIsolation.handleProbeIntervalSeconds, 'writerAndHealthIsolation.handleProbeIntervalSeconds')
  const handleProbeTimeoutSeconds = positiveSafeInteger(
    plan.writerAndHealthIsolation.handleProbeTimeoutSeconds,
    'writerAndHealthIsolation.handleProbeTimeoutSeconds',
  )
  if (handleProbeTimeoutSeconds > 60) noGo('handle probe timeout exceeds 60 seconds')
  const maximumWriterHoldSeconds = positiveSafeInteger(
    plan.writerAndHealthIsolation.maximumWriterHoldSeconds,
    'writerAndHealthIsolation.maximumWriterHoldSeconds',
  )
  const writerRestoreReserveSeconds = positiveSafeInteger(
    plan.writerAndHealthIsolation.writerRestoreReserveSeconds,
    'writerAndHealthIsolation.writerRestoreReserveSeconds',
  )
  const minimumWriterRestoreReserveSeconds = Math.ceil((
    LAUNCHD_RESTORE_RESERVE_BASE_MS
      + WEEKLY_BACKUP_WRITER_LABELS.length * LAUNCHD_RESTORE_RESERVE_PER_WRITER_MS
  ) / 1_000)
  if (maximumWriterHoldSeconds > 3 * 60 * 60 || maximumWriterHoldSeconds > maximumTotalRunSeconds
    || maximumSourceReadSeconds > maximumWriterHoldSeconds - writerRestoreReserveSeconds
    || writerRestoreReserveSeconds < minimumWriterRestoreReserveSeconds
    || maximumWriterHoldSeconds <= writerRestoreReserveSeconds) {
    noGo('Writer Hold limit is outside the approved source-read boundary')
  }
  if (plan.writerAndHealthIsolation.handleProbeIntervalSeconds > 5) {
    noGo('handle probe interval exceeds five seconds')
  }
  assertLaunchdIdentities(
    plan.writerAndHealthIsolation.approvedWriters,
    WEEKLY_BACKUP_WRITER_LABELS,
    'writerAndHealthIsolation.approvedWriters',
  )
  assertLaunchdIdentities(
    plan.writerAndHealthIsolation.approvedReaders,
    WEEKLY_BACKUP_READER_LABELS,
    'writerAndHealthIsolation.approvedReaders',
  )
  if (plan.chunkContract.rowsPerChunk !== 25_000) noGo('rowsPerChunk must remain fixed at 25,000')
  nonNegativeSafeInteger(plan.chunkContract.sleepBetweenChunksMs, 'chunkContract.sleepBetweenChunksMs')

  let incidentDirectory: string
  if (options.mode === 'AUTHORIZED_PRODUCTION_READ') {
    if (plan.storageGuard.incidentPolicy !== 'PRODUCTION_SHARED') noGo('Production reads must use the Production incident policy')
    if (environment.NODE_ENV !== 'production') noGo('authorized Production reads require NODE_ENV=production')
    if (environment.STOCKBOARD_RUNTIME_SCOPE?.trim()) noGo('an isolated development runtime cannot request Production read authority')
    const configuredIncidentDirectory = environment.STOCK_DATA_INCIDENT_DIR?.trim()
    incidentDirectory = path.resolve(configuredIncidentDirectory || expectedIncidentDirectory)
    if (incidentDirectory !== expectedIncidentDirectory) noGo('Production incident directory does not match the trusted shared location')
  } else {
    if (plan.storageGuard.incidentPolicy !== 'ISOLATED_LOCAL') noGo('local preflight must use an isolated incident policy')
    if (environment.NODE_ENV !== 'test' && environment.NODE_ENV !== 'development') {
      noGo('local preflight requires a test or development runtime')
    }
    const isolationRoot = exactPath(required(environment.STOCKBOARD_ISOLATION_ROOT, 'STOCKBOARD_ISOLATION_ROOT'), 'STOCKBOARD_ISOLATION_ROOT')
    incidentDirectory = exactPath(required(environment.STOCK_DATA_INCIDENT_DIR, 'STOCK_DATA_INCIDENT_DIR'), 'STOCK_DATA_INCIDENT_DIR')
    if (incidentDirectory !== path.join(isolationRoot, 'storage-incidents')) {
      noGo('local incident directory must be pinned below the isolated runtime root')
    }
    const resolvedProductionDirectory = resolveThroughExistingAncestor(expectedIncidentDirectory)
    const resolvedLocalDirectory = resolveThroughExistingAncestor(incidentDirectory)
    if (sameOrContained(resolvedProductionDirectory, resolvedLocalDirectory)) {
      noGo('local preflight cannot access the Production incident directory')
    }
  }

  const minFreeBytes = Number(environment.STOCK_DATA_MIN_FREE_BYTES ?? 50 * 1024 ** 3)
  const minFreePercent = Number(environment.STOCK_DATA_MIN_FREE_PERCENT ?? 5)
  if (!Number.isFinite(minFreeBytes) || minFreeBytes < 0
    || !Number.isFinite(minFreePercent) || minFreePercent < 0 || minFreePercent > 100) {
    noGo('invalid storage capacity threshold')
  }

  return {
    mode: options.mode,
    sourcePath,
    incidentDirectory,
    guardConfig: {
      dbPath: databasePath,
      mountPath,
      volumeUuid,
      minFreeBytes,
      minFreePercent,
      incidentDir: incidentDirectory,
      jobType: SIX_STAGE_DISCOVERY_SCOPE,
    },
  }
}

export function certifySixStageDiscoveryStoragePreflight(
  prepared: PreparedSixStageStoragePreflight,
  options: CertifyOptions = {},
): CertifiedSixStageStoragePreflight {
  const probe = options.probe ?? systemStorageProbe
  const guard = new ExternalStorageGuard(prepared.guardConfig, probe)
  const expectedLatch = path.join(prepared.incidentDirectory, 'FAILED_SAFE')
  if (path.resolve(storageFatalLatchPath(prepared.guardConfig)) !== path.resolve(expectedLatch)) {
    noGo('effective Storage Guard incident directory differs from the validated boundary')
  }
  guard.assertReadableVolumeIdentity(true)
  try {
    if (!probe.exists(prepared.sourcePath)) {
      noGo('approved Production source database does not exist')
    }
    const sourceRealPath = probe.realpath(prepared.sourcePath)
    const sourceStat = probe.stat(sourceRealPath)
    const mountStat = probe.stat(probe.realpath(prepared.guardConfig.mountPath))
    if (!sourceStat.isFile() || sourceStat.dev !== mountStat.dev) {
      noGo('approved Production source database is not a file on the trusted volume')
    }
  } catch (error) {
    guard.classify(error)
  }
  return { guard }
}
