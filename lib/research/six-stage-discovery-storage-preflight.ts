import os from 'node:os'
import path from 'node:path'
import {
  ExternalStorageGuard,
  storageFatalLatchPath,
  type GuardConfig,
  type StorageProbe,
  systemStorageProbe,
} from '@/lib/storage/external-storage-guard'
import { resolveThroughExistingAncestor } from '@/lib/runtime/isolation'

export const SIX_STAGE_DISCOVERY_SCOPE = 'six-stage-discovery-source-export'
export const SIX_STAGE_DISCOVERY_PLAN_ID = 'SIX_STAGE_DISCOVERY_SOURCE_EXTRACTION_ONE_SHOT_V2'

export type SixStageStoragePreflightMode = 'LOCAL_FIXTURE' | 'AUTHORIZED_PRODUCTION_READ'

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
  }>
  writerAndHealthIsolation: Readonly<{
    healthIntervalSeconds: number
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

function positiveFinite(value: number, name: string): number {
  if (!Number.isFinite(value) || value <= 0) noGo(`${name} must be finite and positive`)
  return value
}

function nonNegativeFinite(value: number, name: string): number {
  if (!Number.isFinite(value) || value < 0) noGo(`${name} must be finite and non-negative`)
  return value
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
    || !plan.writerAndHealthIsolation || typeof plan.writerAndHealthIsolation !== 'object') {
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
  const maximumTotalRunSeconds = positiveFinite(executionWindow.maximumTotalRunSeconds, 'maximumTotalRunSeconds')
  const maximumSourceReadSeconds = positiveFinite(executionWindow.maximumSourceReadSeconds, 'maximumSourceReadSeconds')
  if (maximumSourceReadSeconds > maximumTotalRunSeconds) noGo('source-read limit exceeds total runtime limit')
  if (positiveFinite(plan.resourceLimits.maximumTotalRunSeconds, 'resourceLimits.maximumTotalRunSeconds') !== maximumTotalRunSeconds
    || positiveFinite(plan.resourceLimits.maximumSourceReadSeconds, 'resourceLimits.maximumSourceReadSeconds') !== maximumSourceReadSeconds) {
    noGo('resource limits differ from the approved execution window')
  }
  positiveFinite(plan.resourceLimits.maximumOutputBytes, 'resourceLimits.maximumOutputBytes')
  nonNegativeFinite(plan.resourceLimits.minimumFreeBytesBeforeStart, 'resourceLimits.minimumFreeBytesBeforeStart')
  nonNegativeFinite(plan.resourceLimits.minimumFreeBytesAfterCompletion, 'resourceLimits.minimumFreeBytesAfterCompletion')
  nonNegativeFinite(plan.resourceLimits.maximumWalBytesAtStart, 'resourceLimits.maximumWalBytesAtStart')
  nonNegativeFinite(plan.resourceLimits.maximumWalGrowthBytes, 'resourceLimits.maximumWalGrowthBytes')
  if (plan.resourceLimits.minimumFreeBytesAfterCompletion > plan.resourceLimits.minimumFreeBytesBeforeStart) {
    noGo('post-run free-space floor exceeds the start requirement')
  }
  positiveFinite(plan.writerAndHealthIsolation.healthIntervalSeconds, 'writerAndHealthIsolation.healthIntervalSeconds')

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
