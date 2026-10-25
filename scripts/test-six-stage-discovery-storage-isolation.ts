import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import {
  SIX_STAGE_DISCOVERY_PLAN_ID,
  SIX_STAGE_DISCOVERY_SCOPE,
  SixStageStoragePreflightNoGo,
  certifySixStageDiscoveryStoragePreflight,
  prepareSixStageDiscoveryStoragePreflight,
  type SixStageDiscoveryStoragePlan,
} from '@/lib/research/six-stage-discovery-storage-preflight'
import {
  isStorageIoError,
  type StorageProbe,
  type VolumeIdentity,
} from '@/lib/storage/external-storage-guard'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stockboard-six-stage-storage-isolation-'))
const productionIncidents = path.join(root, 'production-incidents')
const isolationRoot = path.join(root, 'isolated-runtime')
const localIncidents = path.join(isolationRoot, 'storage-incidents')
const mountPath = '/Volumes/fixture-owc'
const databasePath = `${mountPath}/stock-dashboard/stockboard.db`
const volumeUuid = 'FIXTURE-OWC-UUID'
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as {
  DatabaseSync: new (file: string, options?: { readOnly?: boolean }) => { close(): void }
}

function plan(mode: 'LOCAL_FIXTURE' | 'AUTHORIZED_PRODUCTION_READ'): SixStageDiscoveryStoragePlan {
  const now = Date.now()
  return {
    planId: SIX_STAGE_DISCOVERY_PLAN_ID,
    authorization: {
      productionDatabaseConnection: true,
      execution: true,
      oneShot: true,
      executionWindow: {
        startNotBefore: new Date(now - 60_000).toISOString(),
        startNoLaterThan: new Date(now + 60_000).toISOString(),
        endNoLaterThan: new Date(now + 600_000).toISOString(),
        maximumTotalRunSeconds: 600,
        maximumSourceReadSeconds: 300,
      },
    },
    sourceDatabase: { path: databasePath },
    writeOnceDestination: {
      root: `${mountPath}/research`,
      incompleteDirectory: `${mountPath}/research/run.incomplete`,
      finalDirectory: `${mountPath}/research/run`,
    },
    resourceLimits: {
      maximumSourceReadSeconds: 300,
      maximumTotalRunSeconds: 600,
      maximumOutputBytes: 1_000_000,
      minimumFreeBytesBeforeStart: 1_000,
      minimumFreeBytesAfterCompletion: 500,
      maximumWalBytesAtStart: 1_000_000,
      maximumWalGrowthBytes: 100_000,
    },
    writerAndHealthIsolation: { healthIntervalSeconds: 60 },
    storageGuard: {
      executionScope: SIX_STAGE_DISCOVERY_SCOPE,
      mode,
      mountPath,
      volumeUuid,
      databasePath,
      incidentPolicy: mode === 'LOCAL_FIXTURE' ? 'ISOLATED_LOCAL' : 'PRODUCTION_SHARED',
    },
  }
}

function environment(mode: 'LOCAL_FIXTURE' | 'AUTHORIZED_PRODUCTION_READ'): NodeJS.ProcessEnv {
  return {
    NODE_ENV: mode === 'LOCAL_FIXTURE' ? 'test' : 'production',
    STOCKBOARD_RESEARCH_EXECUTION_SCOPE: SIX_STAGE_DISCOVERY_SCOPE,
    STOCKBOARD_RESEARCH_PREFLIGHT_MODE: mode,
    STOCKBOARD_ISOLATION_ROOT: mode === 'LOCAL_FIXTURE' ? isolationRoot : undefined,
    STOCK_DATA_INCIDENT_DIR: mode === 'LOCAL_FIXTURE' ? localIncidents : productionIncidents,
    STOCK_DATA_MOUNT_PATH: mountPath,
    STOCK_DATA_VOLUME_UUID: volumeUuid,
    STOCKBOARD_DB_PATH: databasePath,
    STOCK_DATA_MIN_FREE_BYTES: '0',
    STOCK_DATA_MIN_FREE_PERCENT: '0',
  }
}

function fixtureProbe(observedUuid = volumeUuid): StorageProbe {
  const volume: VolumeIdentity = {
    mountPoint: mountPath,
    uuid: observedUuid,
    filesystem: 'apfs',
    writable: true,
    freeBytes: 1_000_000,
    totalBytes: 2_000_000,
  }
  return {
    volume: () => volume,
    mountPresent: () => true,
    realpath: (value) => value,
    stat: (value) => ({
      dev: 42,
      isFile: () => value === databasePath,
      isDirectory: () => value === mountPath,
    }),
    exists: (value) => value === mountPath || value === databasePath,
  }
}

function expectNoGo(run: () => unknown): void {
  assert.throws(run, (error) => error instanceof SixStageStoragePreflightNoGo)
}

try {
  const sharedLatch = path.join(productionIncidents, 'FAILED_SAFE')

  // Incident e505 regression: no identity must stop locally before a Guard probe
  // or any shared Production incident state is created.
  const missingIdentity = environment('AUTHORIZED_PRODUCTION_READ')
  delete missingIdentity.STOCK_DATA_MOUNT_PATH
  delete missingIdentity.STOCK_DATA_VOLUME_UUID
  delete missingIdentity.STOCKBOARD_DB_PATH
  expectNoGo(() => prepareSixStageDiscoveryStoragePreflight(plan('AUTHORIZED_PRODUCTION_READ'), {
    mode: 'AUTHORIZED_PRODUCTION_READ', environment: missingIdentity, productionIncidentDirectory: productionIncidents,
  }))
  assert.equal(fs.existsSync(sharedLatch), false)

  expectNoGo(() => prepareSixStageDiscoveryStoragePreflight({
    ...plan('AUTHORIZED_PRODUCTION_READ'), planId: 'SIX_STAGE_DISCOVERY_SOURCE_EXTRACTION_ONE_SHOT_V1',
  }, {
    mode: 'AUTHORIZED_PRODUCTION_READ',
    environment: environment('AUTHORIZED_PRODUCTION_READ'),
    productionIncidentDirectory: productionIncidents,
  }))
  expectNoGo(() => prepareSixStageDiscoveryStoragePreflight({
    ...plan('AUTHORIZED_PRODUCTION_READ'),
    authorization: { ...plan('AUTHORIZED_PRODUCTION_READ').authorization, execution: false },
  }, {
    mode: 'AUTHORIZED_PRODUCTION_READ',
    environment: environment('AUTHORIZED_PRODUCTION_READ'),
    productionIncidentDirectory: productionIncidents,
  }))
  const missingContract: Record<string, unknown> = { ...plan('AUTHORIZED_PRODUCTION_READ') }
  delete missingContract.storageGuard
  expectNoGo(() => prepareSixStageDiscoveryStoragePreflight(missingContract as unknown as SixStageDiscoveryStoragePlan, {
    mode: 'AUTHORIZED_PRODUCTION_READ',
    environment: environment('AUTHORIZED_PRODUCTION_READ'),
    productionIncidentDirectory: productionIncidents,
  }))
  assert.equal(fs.existsSync(sharedLatch), false)

  const invalidRuntimeLimit = plan('AUTHORIZED_PRODUCTION_READ')
  expectNoGo(() => prepareSixStageDiscoveryStoragePreflight({
    ...invalidRuntimeLimit,
    authorization: {
      ...invalidRuntimeLimit.authorization,
      executionWindow: { ...invalidRuntimeLimit.authorization.executionWindow, maximumTotalRunSeconds: Number.NaN },
    },
  }, {
    mode: 'AUTHORIZED_PRODUCTION_READ',
    environment: environment('AUTHORIZED_PRODUCTION_READ'),
    productionIncidentDirectory: productionIncidents,
  }))
  assert.equal(fs.existsSync(sharedLatch), false)

  const wrongProductionIncident = environment('AUTHORIZED_PRODUCTION_READ')
  wrongProductionIncident.STOCK_DATA_INCIDENT_DIR = path.join(root, 'wrong-production-incidents')
  expectNoGo(() => prepareSixStageDiscoveryStoragePreflight(plan('AUTHORIZED_PRODUCTION_READ'), {
    mode: 'AUTHORIZED_PRODUCTION_READ',
    environment: wrongProductionIncident,
    productionIncidentDirectory: productionIncidents,
  }))
  assert.equal(fs.existsSync(sharedLatch), false)
  assert.equal(fs.existsSync(productionIncidents), false)

  for (const missing of ['STOCK_DATA_MOUNT_PATH', 'STOCK_DATA_VOLUME_UUID', 'STOCKBOARD_DB_PATH'] as const) {
    const partial = environment('AUTHORIZED_PRODUCTION_READ')
    delete partial[missing]
    expectNoGo(() => prepareSixStageDiscoveryStoragePreflight(plan('AUTHORIZED_PRODUCTION_READ'), {
      mode: 'AUTHORIZED_PRODUCTION_READ', environment: partial, productionIncidentDirectory: productionIncidents,
    }))
    assert.equal(fs.existsSync(sharedLatch), false)
  }

  const invalidScope = environment('AUTHORIZED_PRODUCTION_READ')
  invalidScope.STOCKBOARD_RESEARCH_EXECUTION_SCOPE = 'unapproved-research-scope'
  expectNoGo(() => prepareSixStageDiscoveryStoragePreflight(plan('AUTHORIZED_PRODUCTION_READ'), {
    mode: 'AUTHORIZED_PRODUCTION_READ', environment: invalidScope, productionIncidentDirectory: productionIncidents,
  }))
  assert.equal(fs.existsSync(sharedLatch), false)

  const nestedProductionEnvironment = environment('LOCAL_FIXTURE')
  nestedProductionEnvironment.STOCKBOARD_ISOLATION_ROOT = path.join(productionIncidents, 'research-runtime')
  nestedProductionEnvironment.STOCK_DATA_INCIDENT_DIR = path.join(productionIncidents, 'research-runtime', 'storage-incidents')
  expectNoGo(() => prepareSixStageDiscoveryStoragePreflight(plan('LOCAL_FIXTURE'), {
    mode: 'LOCAL_FIXTURE', environment: nestedProductionEnvironment, productionIncidentDirectory: productionIncidents,
  }))
  assert.equal(fs.existsSync(sharedLatch), false)

  fs.mkdirSync(productionIncidents, { recursive: true })
  const symlinkIsolationRoot = path.join(root, 'symlinked-isolation-root')
  fs.symlinkSync(productionIncidents, symlinkIsolationRoot, 'dir')
  const symlinkEnvironment = environment('LOCAL_FIXTURE')
  symlinkEnvironment.STOCKBOARD_ISOLATION_ROOT = symlinkIsolationRoot
  symlinkEnvironment.STOCK_DATA_INCIDENT_DIR = path.join(symlinkIsolationRoot, 'storage-incidents')
  expectNoGo(() => prepareSixStageDiscoveryStoragePreflight(plan('LOCAL_FIXTURE'), {
    mode: 'LOCAL_FIXTURE', environment: symlinkEnvironment, productionIncidentDirectory: productionIncidents,
  }))
  assert.equal(fs.existsSync(sharedLatch), false)

  const volumeIncidentEnvironment = environment('LOCAL_FIXTURE')
  volumeIncidentEnvironment.STOCKBOARD_ISOLATION_ROOT = '/Volumes/fixture-research-runtime'
  volumeIncidentEnvironment.STOCK_DATA_INCIDENT_DIR = '/Volumes/fixture-research-runtime/storage-incidents'
  const volumeIncidentPrepared = prepareSixStageDiscoveryStoragePreflight(plan('LOCAL_FIXTURE'), {
    mode: 'LOCAL_FIXTURE', environment: volumeIncidentEnvironment, productionIncidentDirectory: productionIncidents,
  })
  expectNoGo(() => certifySixStageDiscoveryStoragePreflight(volumeIncidentPrepared, { probe: fixtureProbe() }))
  assert.equal(fs.existsSync(sharedLatch), false)

  const localPrepared = prepareSixStageDiscoveryStoragePreflight(plan('LOCAL_FIXTURE'), {
    mode: 'LOCAL_FIXTURE', environment: environment('LOCAL_FIXTURE'), productionIncidentDirectory: productionIncidents,
  })
  assert.equal(certifySixStageDiscoveryStoragePreflight(localPrepared, { probe: fixtureProbe() }).guard.status, 'HEALTHY')
  assert.equal(fs.existsSync(path.join(localIncidents, 'FAILED_SAFE')), false)

  const missingSourceProbe = fixtureProbe()
  missingSourceProbe.exists = (value) => value === mountPath
  expectNoGo(() => certifySixStageDiscoveryStoragePreflight(localPrepared, { probe: missingSourceProbe }))
  assert.equal(fs.existsSync(path.join(localIncidents, 'FAILED_SAFE')), false)

  const wrongUuidPrepared = prepareSixStageDiscoveryStoragePreflight(plan('LOCAL_FIXTURE'), {
    mode: 'LOCAL_FIXTURE', environment: environment('LOCAL_FIXTURE'), productionIncidentDirectory: productionIncidents,
  })
  assert.throws(
    () => certifySixStageDiscoveryStoragePreflight(wrongUuidPrepared, { probe: fixtureProbe('WRONG-UUID') }),
    (error: { storageCode?: string }) => error.storageCode === 'VOLUME_UUID_MISMATCH',
  )
  assert.equal(fs.existsSync(path.join(localIncidents, 'FAILED_SAFE')), true)
  fs.rmSync(path.join(localIncidents, 'FAILED_SAFE'))

  const fatalProbe = fixtureProbe()
  fatalProbe.volume = () => { throw Object.assign(new Error('synthetic disk I/O error'), { code: 'EIO' }) }
  assert.throws(
    () => certifySixStageDiscoveryStoragePreflight(localPrepared, { probe: fatalProbe }),
    (error: { storageCode?: string }) => error.storageCode === 'FATAL_STORAGE_IO',
  )
  assert.equal(fs.existsSync(path.join(localIncidents, 'FAILED_SAFE')), true)
  assert.equal(fs.existsSync(sharedLatch), false)
  fs.rmSync(path.join(localIncidents, 'FAILED_SAFE'))

  const productionPrepared = prepareSixStageDiscoveryStoragePreflight(plan('AUTHORIZED_PRODUCTION_READ'), {
    mode: 'AUTHORIZED_PRODUCTION_READ',
    environment: environment('AUTHORIZED_PRODUCTION_READ'),
    productionIncidentDirectory: productionIncidents,
  })
  assert.throws(
    () => certifySixStageDiscoveryStoragePreflight(productionPrepared, { probe: fixtureProbe('WRONG-UUID') }),
    (error: { storageCode?: string }) => error.storageCode === 'VOLUME_UUID_MISMATCH',
  )
  assert.equal(fs.existsSync(sharedLatch), true)
  fs.rmSync(sharedLatch)

  fs.mkdirSync(productionIncidents, { recursive: true })
  fs.writeFileSync(sharedLatch, 'manual storage review required\n')
  assert.throws(
    () => certifySixStageDiscoveryStoragePreflight(productionPrepared, { probe: fixtureProbe() }),
    (error: { storageCode?: string }) => error.storageCode === 'FATAL_STORAGE_IO',
  )
  fs.rmSync(sharedLatch)

  const productionFatalProbe = fixtureProbe()
  productionFatalProbe.volume = () => { throw Object.assign(new Error('synthetic Production disk I/O error'), { code: 'EIO' }) }
  assert.throws(
    () => certifySixStageDiscoveryStoragePreflight(productionPrepared, { probe: productionFatalProbe }),
    (error: { storageCode?: string }) => error.storageCode === 'FATAL_STORAGE_IO',
  )
  assert.equal(fs.existsSync(sharedLatch), true, 'a configured Production-equivalent fatal failure must remain fail-closed')
  fs.rmSync(sharedLatch)

  assert.equal(isStorageIoError({ code: 'ERR_SQLITE_ERROR', errcode: 10 }), true)
  assert.equal(isStorageIoError({ code: 'ERR_SQLITE_ERROR', errcode: 14 }), true)
  assert.equal(isStorageIoError({ code: 'ERR_SQLITE_ERROR', errcode: 8 }), true)
  assert.equal(isStorageIoError({ code: 'ERR_SQLITE_ERROR', errcode: 13 }), true)
  assert.equal(isStorageIoError({ code: 'ERR_SQLITE_ERROR', errcode: 1 }), false)
  const cyclicError: { cause?: unknown } = {}
  cyclicError.cause = cyclicError
  assert.equal(isStorageIoError(cyclicError), false)
  let realSqliteError: unknown
  try {
    new DatabaseSync(path.join(root, 'missing-parent', 'unopenable.sqlite'), { readOnly: true })
  } catch (error) {
    realSqliteError = error
  }
  assert.ok(realSqliteError, 'node:sqlite must surface the fixture open failure')
  assert.equal(isStorageIoError(realSqliteError), true)

  const effects = { databaseConnections: 0, writerHolds: 0, outputs: 0 }
  const noIdentity = environment('AUTHORIZED_PRODUCTION_READ')
  delete noIdentity.STOCK_DATA_VOLUME_UUID
  expectNoGo(() => prepareSixStageDiscoveryStoragePreflight(plan('AUTHORIZED_PRODUCTION_READ'), {
    mode: 'AUTHORIZED_PRODUCTION_READ', environment: noIdentity, productionIncidentDirectory: productionIncidents,
  }))
  assert.deepEqual(effects, { databaseConnections: 0, writerHolds: 0, outputs: 0 })

  const runnerSource = fs.readFileSync('scripts/run-six-stage-discovery-source-export.mjs', 'utf8')
  const prepareOffset = runnerSource.indexOf('prepareSixStageDiscoveryStoragePreflight(plan')
  const certifyOffset = runnerSource.indexOf('certifySixStageDiscoveryStoragePreflight(storagePreflight)')
  const outputOffset = runnerSource.indexOf('fs.mkdirSync(currentIncomplete')
  const databaseOffset = runnerSource.indexOf('new DatabaseSync(sourcePath')
  assert.ok(prepareOffset >= 0 && certifyOffset > prepareOffset)
  assert.ok(outputOffset > certifyOffset, 'Storage Guard certification must precede research output creation')
  assert.ok(databaseOffset > certifyOffset, 'Storage Guard certification must precede the Production SQLite connection')
  const periodicHealthOffset = runnerSource.indexOf('const periodicHealth')
  const guardRecheckOffset = runnerSource.indexOf('storageGuard.assertReadableVolumeIdentity(force)', periodicHealthOffset)
  const healthThrottleOffset = runnerSource.indexOf('if (!force && Date.now() - lastHealthAt', periodicHealthOffset)
  assert.ok(guardRecheckOffset > periodicHealthOffset && guardRecheckOffset < healthThrottleOffset,
    'every source chunk must re-certify Storage Guard before throttling HTTP health checks')
  assert.equal(runnerSource.match(/storageGuard\.classify\(error\)/g)?.length, 1,
    'only sourceRead may classify errors into the shared Production Storage Guard')
  assert.match(runnerSource, /try \{\s*log\('FAIL_CLOSED'/,
    'fail-closed exit must survive an unavailable destination execution log')

  const now = Date.now()
  const runnerOutput = path.join(root, 'must-not-be-created')
  const runnerPlan = {
    ...plan('AUTHORIZED_PRODUCTION_READ'),
    authorization: {
      ...plan('AUTHORIZED_PRODUCTION_READ').authorization,
      executionWindow: {
        startNotBefore: new Date(now - 60_000).toISOString(),
        startNoLaterThan: new Date(now + 60_000).toISOString(),
        endNoLaterThan: new Date(now + 120_000).toISOString(),
        maximumTotalRunSeconds: 60,
        maximumSourceReadSeconds: 30,
      },
    },
    resourceLimits: {
      ...plan('AUTHORIZED_PRODUCTION_READ').resourceLimits,
      maximumTotalRunSeconds: 60,
      maximumSourceReadSeconds: 30,
    },
    writeOnceDestination: {
      incompleteDirectory: runnerOutput,
    },
  }
  const runnerPlanPath = path.join(root, 'incident-e505-regression-plan.json')
  const runnerPlanBytes = `${JSON.stringify(runnerPlan, null, 2)}\n`
  fs.writeFileSync(runnerPlanPath, runnerPlanBytes)
  const childHome = path.join(root, 'runner-home')
  const runner = spawnSync(path.resolve('node_modules/.bin/tsx'), [
    'scripts/run-six-stage-discovery-source-export.mjs',
    runnerPlanPath,
    crypto.createHash('sha256').update(runnerPlanBytes).digest('hex'),
  ], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH,
      HOME: childHome,
      NODE_ENV: 'production',
      STOCKBOARD_RESEARCH_EXECUTION_SCOPE: SIX_STAGE_DISCOVERY_SCOPE,
      STOCKBOARD_RESEARCH_PREFLIGHT_MODE: 'AUTHORIZED_PRODUCTION_READ',
    },
  })
  assert.equal(runner.status, 1)
  assert.match(`${runner.stdout}\n${runner.stderr}`, /STOCK_DATA_MOUNT_PATH is required/)
  assert.equal(fs.existsSync(runnerOutput), false)
  assert.equal(fs.existsSync(path.join(childHome, 'Library', 'Application Support', 'StockBoard', 'storage-incidents', 'FAILED_SAFE')), false)

  console.log('Six-stage Discovery Storage Guard isolation: PASS')
} finally {
  fs.rmSync(root, { recursive: true, force: true })
}
