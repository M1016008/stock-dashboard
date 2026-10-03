import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { NextRequest } from 'next/server'
import { proxy } from '../proxy'
import {
  ExternalStorageGuard, StorageUnavailableError, certifyVolumeIdentitySingleFlight, inspectReadableVolumeIdentity, inspectStorage, inspectWritableTargetPath, isStorageIoError, mountTableContains, requiresExternalStorageGuard, storageProbeCoordinationPaths,
  type GuardConfig, type StorageProbe, type VolumeIdentity,
} from '@/lib/storage/external-storage-guard'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'stockboard-storage-guard-'))
const mount = '/Volumes/fixture-stockboard'
const db = `${mount}/stockboard/stockboard.db`
const config: GuardConfig = {
  dbPath: db, mountPath: mount, volumeUuid: 'test-uuid',
  minFreeBytes: 50, minFreePercent: 5, incidentDir: tmp, jobType: 'simulation',
}
const healthyVolume: VolumeIdentity = {
  mountPoint: mount, uuid: 'test-uuid', filesystem: 'apfs', writable: true,
  freeBytes: 1_000, totalBytes: 2_000,
}
let mounted = true
let present = true
let volume = healthyVolume
let probeCalls = 0
const probe: StorageProbe = {
  volume: () => { probeCalls++; return mounted ? volume : null },
  mountPresent: () => mounted,
  realpath: (value) => value,
  stat: (value) => ({ dev: 42, isFile: () => value === db || value.endsWith('-wal') || value.endsWith('-shm'), isDirectory: () => value === mount }),
  exists: (value) => mounted && (value === mount || (present && value === db)),
}

function expectCode(code: string, fn: () => unknown): void {
  assert.throws(fn, (error: { storageCode?: string }) => error.storageCode === code)
}

try {
  assert.equal(mountTableContains('/dev/disk5s1 on /Volumes/OWC Express 1M2 80G (apfs, local, journaled)',
    '/Volumes/OWC Express 1M2 80G'), true)
  assert.equal(mountTableContains('/dev/disk5s1 on /Volumes/OWC Express 1M2 80G copy (apfs, local)',
    '/Volumes/OWC Express 1M2 80G'), false)
  assert.equal(mountTableContains('/dev/disk5s1 on /Volumes/OWC\\040Express\\0401M2\\04080G (apfs, local)',
    '/Volumes/OWC Express 1M2 80G'), true)
  assert.equal(inspectStorage(config, probe).uuid, 'test-uuid')
  assert.equal(inspectWritableTargetPath(config, probe).uuid, 'test-uuid')
  assert.equal(inspectWritableTargetPath({ ...config, dbPath: `${mount}/new/output.db` }, probe).uuid, 'test-uuid')

  const coordinatedMount = path.join(tmp, 'coordinated-mount')
  const coordinationDir = path.join(tmp, 'probe-coordination')
  fs.mkdirSync(coordinatedMount)
  let certifications = 0
  const coordinatedVolume = { ...healthyVolume, mountPoint: coordinatedMount }
  assert.equal(certifyVolumeIdentitySingleFlight(coordinatedMount, () => {
    certifications++
    return coordinatedVolume
  }, { coordinationDir, cacheTtlMs: 10_000 }).uuid, 'test-uuid')
  assert.equal(certifyVolumeIdentitySingleFlight(coordinatedMount, () => {
    certifications++
    return coordinatedVolume
  }, { coordinationDir, cacheTtlMs: 10_000 }).uuid, 'test-uuid')
  assert.equal(certifications, 1, 'same-volume certifications share the short-lived process result')

  const contendedMount = path.join(tmp, 'contended-mount')
  fs.mkdirSync(contendedMount)
  const contendedPaths = storageProbeCoordinationPaths(contendedMount, coordinationDir)
  fs.mkdirSync(path.dirname(contendedPaths.lockPath), { recursive: true })
  fs.writeFileSync(contendedPaths.lockPath, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }))
  let contendedCertifications = 0
  expectCode('PROBE_FAILED', () => certifyVolumeIdentitySingleFlight(contendedMount, () => {
    contendedCertifications++
    return { ...healthyVolume, mountPoint: contendedMount }
  }, { coordinationDir, cacheTtlMs: 0, waitMs: 5, pollMs: 1 }))
  assert.equal(contendedCertifications, 0, 'a contending caller must not start a second full probe')
  fs.unlinkSync(contendedPaths.lockPath)

  const optionalIncidentDir = path.join(tmp, 'optional-read')
  const optionalDb = `${mount}/ma-trajectory-shadow/shadow.db`
  const optionalConfig = { ...config, dbPath: optionalDb, incidentDir: optionalIncidentDir, jobType: 'optional-read' }
  let optionalMounted = true
  let optionalExists = false
  let optionalVolume = healthyVolume
  const optionalProbe: StorageProbe = {
    volume: () => optionalMounted ? optionalVolume : null,
    mountPresent: () => optionalMounted,
    realpath: (value) => value,
    stat: (value) => ({
      dev: 42,
      isFile: () => value === optionalDb,
      isDirectory: () => value === mount,
    }),
    exists: (value) => optionalMounted && (value === mount || (optionalExists && value === optionalDb)),
  }
  const optionalMissing = new ExternalStorageGuard(optionalConfig, optionalProbe)
  optionalMissing.assertReadableVolumeIdentity(true)
  assert.equal(optionalMissing.status, 'HEALTHY')
  assert.equal(fs.existsSync(path.join(optionalIncidentDir, 'FAILED_SAFE')), false,
    'missing optional artifact must not create the shared fatal latch')
  optionalVolume = { ...healthyVolume, writable: false, freeBytes: 1 }
  assert.equal(inspectReadableVolumeIdentity(optionalConfig, optionalProbe).uuid, 'test-uuid',
    'read identity must not require write capacity or free-space headroom')
  optionalVolume = healthyVolume
  optionalExists = true
  assert.equal(inspectReadableVolumeIdentity(optionalConfig, optionalProbe).uuid, 'test-uuid')
  optionalExists = false
  assert.throws(() => optionalMissing.classifyOptionalRead(Object.assign(new Error('artifact missing'), { code: 'ENOENT' })),
    (error: { code?: string }) => error.code === 'ENOENT')
  assert.equal(fs.existsSync(path.join(optionalIncidentDir, 'FAILED_SAFE')), false)

  optionalMounted = false
  expectCode('VOLUME_NOT_MOUNTED', () => optionalMissing.assertReadableVolumeIdentity(true))
  assert.equal(optionalMissing.status, 'FAILED_SAFE')
  assert.equal(fs.existsSync(path.join(optionalIncidentDir, 'FAILED_SAFE')), true)
  fs.unlinkSync(path.join(optionalIncidentDir, 'FAILED_SAFE'))
  optionalMounted = true
  optionalVolume = { ...healthyVolume, uuid: 'wrong-uuid' }
  const optionalWrongUuid = new ExternalStorageGuard(optionalConfig, optionalProbe)
  expectCode('VOLUME_UUID_MISMATCH', () => optionalWrongUuid.assertReadableVolumeIdentity(true))
  assert.equal(fs.existsSync(path.join(optionalIncidentDir, 'FAILED_SAFE')), true)
  fs.unlinkSync(path.join(optionalIncidentDir, 'FAILED_SAFE'))
  optionalVolume = healthyVolume
  const optionalIo = new ExternalStorageGuard(optionalConfig, optionalProbe)
  optionalIo.assertReadableVolumeIdentity(true)
  expectCode('FATAL_STORAGE_IO', () => optionalIo.classifyOptionalRead(
    Object.assign(new Error('simulated optional read I/O error'), { code: 'EIO' })))
  assert.equal(fs.existsSync(path.join(optionalIncidentDir, 'FAILED_SAFE')), true)
  fs.unlinkSync(path.join(optionalIncidentDir, 'FAILED_SAFE'))

  const rebuildableIncidentDir = path.join(tmp, 'rebuildable-cache')
  const rebuildable = new ExternalStorageGuard({ ...config, incidentDir: rebuildableIncidentDir }, probe)
  rebuildable.assertWritable(true)
  assert.throws(() => rebuildable.classifyRebuildableCache(
    Object.assign(new Error('database disk image is malformed'), { code: 'SQLITE_CORRUPT' })))
  assert.equal(fs.existsSync(path.join(rebuildableIncidentDir, 'FAILED_SAFE')), false,
    'cache-local corruption must not create the shared fatal latch')
  expectCode('FATAL_STORAGE_IO', () => rebuildable.classifyRebuildableCache(
    Object.assign(new Error('simulated cache I/O error'), { code: 'EIO' })))
  assert.equal(fs.existsSync(path.join(rebuildableIncidentDir, 'FAILED_SAFE')), true,
    'actual cache volume I/O failure remains volume-fatal')
  fs.unlinkSync(path.join(rebuildableIncidentDir, 'FAILED_SAFE'))

  const requiredIncidentDir = path.join(tmp, 'required-missing')
  const requiredMissing = new ExternalStorageGuard({ ...config, incidentDir: requiredIncidentDir }, {
    ...probe,
    exists: (value) => value === mount,
  })
  expectCode('DB_NOT_FOUND', () => requiredMissing.assertWritable(true))
  assert.equal(requiredMissing.status, 'FAILED_SAFE', 'missing primary DB must remain fatal')
  assert.equal(fs.existsSync(path.join(requiredIncidentDir, 'FAILED_SAFE')), true)
  const originalNodeEnv = process.env.NODE_ENV
  Reflect.set(process.env, 'NODE_ENV', 'production')
  try { assert.equal(requiresExternalStorageGuard('/tmp/misconfigured-production.db'), true) }
  finally {
    if (originalNodeEnv === undefined) Reflect.deleteProperty(process.env, 'NODE_ENV')
    else Reflect.set(process.env, 'NODE_ENV', originalNodeEnv)
  }
  const guard = new ExternalStorageGuard(config, probe)
  let opens = 0
  guard.assertWritable(true)
  if (guard.status === 'HEALTHY') opens++
  assert.equal(opens, 1)

  const failedProbe: StorageProbe = {
    ...probe,
    volume: () => { throw new StorageUnavailableError('PROBE_FAILED', 'volume identity probe timed out') },
  }
  expectCode('PROBE_FAILED', () => inspectStorage(config, failedProbe))
  let transientCalls = 0
  let writesDuringUncertainty = 0
  let transientGuard: ExternalStorageGuard
  transientGuard = new ExternalStorageGuard(config, {
    ...probe,
    volume: () => {
      transientCalls++
      if (transientCalls === 1) throw new StorageUnavailableError('PROBE_FAILED', 'diskutil timeout', {
        probeStage: 'DISKUTIL_INFO', startedAt: new Date().toISOString(), durationMs: 8_000,
        exitStatus: null, signal: 'SIGTERM', stderr: null,
      })
      return healthyVolume
    },
  }, { wait: () => {
    assert.equal(transientGuard.status, 'PROBE_UNCERTAIN')
    assert.equal(fs.existsSync(path.join(tmp, `PROBE_UNCERTAIN-${process.pid}`)), true)
    expectCode('PROBE_FAILED', () => { transientGuard.assertWritable(); writesDuringUncertainty++ })
    const peer = new ExternalStorageGuard(config, probe)
    expectCode('PROBE_FAILED', () => { peer.assertWritable(); writesDuringUncertainty++ })
  } })
  transientGuard.assertWritable(true)
  assert.equal(transientGuard.status, 'HEALTHY')
  assert.equal(transientCalls, 2)
  assert.equal(writesDuringUncertainty, 0)
  assert.equal(transientGuard.probeMetrics.recoveredTransientCount, 1)
  assert.equal(fs.existsSync(path.join(tmp, 'FAILED_SAFE')), false)
  assert.equal(fs.existsSync(path.join(tmp, `PROBE_UNCERTAIN-${process.pid}`)), false)
  const parseGuard = new ExternalStorageGuard(config, {
    ...probe, volume: (() => {
      let attempts = 0
      return () => {
        if (++attempts === 1) throw new StorageUnavailableError('PROBE_FAILED', 'plutil parse failure', {
          probeStage: 'PLUTIL_PARSE', startedAt: new Date().toISOString(), durationMs: 1,
          exitStatus: 1, signal: null, stderr: null,
        })
        return healthyVolume
      }
    })(),
  }, { wait: () => undefined })
  parseGuard.assertWritable(true)
  assert.equal(parseGuard.status, 'HEALTHY')
  let threeFailuresThenSuccess = 0
  const serializedRecovery = new ExternalStorageGuard(config, {
    ...probe,
    volume: () => {
      threeFailuresThenSuccess++
      if (threeFailuresThenSuccess <= 3) {
        throw new StorageUnavailableError('PROBE_FAILED', 'serialized diskutil failure', {
          probeStage: 'DISKUTIL_INFO', startedAt: new Date().toISOString(), durationMs: 8_000,
          exitStatus: null, signal: 'SIGPIPE', stderr: null,
        })
      }
      return healthyVolume
    },
  }, { wait: () => undefined })
  serializedRecovery.assertWritable(true)
  assert.equal(threeFailuresThenSuccess, 4)
  assert.equal(serializedRecovery.status, 'HEALTHY')
  assert.equal(fs.existsSync(path.join(tmp, 'FAILED_SAFE')), false)
  let raceEnabled = false
  let walPresent = true
  const raceGuard = new ExternalStorageGuard(config, {
    ...probe,
    exists: (value) => value === `${db}-wal` ? raceEnabled && walPresent : probe.exists(value),
    realpath: (value) => {
      if (value === `${db}-wal` && raceEnabled && walPresent) {
        walPresent = false
        throw Object.assign(new Error('WAL was removed after existence check'), { code: 'ENOENT' })
      }
      return value
    },
  })
  raceGuard.assertWritable(true)
  raceEnabled = true
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1_100)
  raceGuard.assertWritable()
  assert.equal(raceGuard.status, 'HEALTHY')
  assert.equal(raceGuard.probeMetrics.fullCount, 2, 'companion removal requires full UUID revalidation')
  assert.equal(fs.existsSync(path.join(tmp, 'FAILED_SAFE')), false)
  let fullWalPresent = true
  const fullRaceGuard = new ExternalStorageGuard(config, {
    ...probe,
    exists: (value) => value === `${db}-wal` ? fullWalPresent : probe.exists(value),
    realpath: (value) => {
      if (value === `${db}-wal` && fullWalPresent) {
        fullWalPresent = false
        throw Object.assign(new Error('WAL was removed during full probe'), { code: 'ENOENT' })
      }
      return value
    },
  }, { wait: () => undefined })
  fullRaceGuard.assertWritable(true)
  assert.equal(fullRaceGuard.status, 'HEALTHY')
  assert.equal(fullRaceGuard.probeMetrics.fullCount, 2)
  assert.equal(fullRaceGuard.probeMetrics.recoveredTransientCount, 1)
  assert.equal(fs.existsSync(path.join(tmp, 'FAILED_SAFE')), false)
  let mountTableCalls = 0
  const mountTableGuard = new ExternalStorageGuard(config, {
    ...probe,
    mountPresent: () => {
      if (++mountTableCalls === 1) throw new StorageUnavailableError('PROBE_FAILED', 'mount table timeout', {
        probeStage: 'MOUNT_TABLE', startedAt: new Date().toISOString(), durationMs: 8_000,
        exitStatus: null, signal: 'SIGTERM', stderr: null,
      })
      return true
    },
  }, { wait: () => undefined })
  mountTableGuard.assertWritable(true)
  assert.equal(mountTableGuard.status, 'HEALTHY')
  assert.equal(mountTableCalls, 2, 'confirmation uses in-process identity before the final mount and UUID check')
  const probeFailure = new ExternalStorageGuard(config, failedProbe, { wait: () => undefined })
  expectCode('PROBE_FAILED', () => probeFailure.assertWritable(true))
  assert.equal(probeFailure.status, 'FAILED_SAFE', 'three failed certifications require manual recovery')
  assert.equal(probeFailure.probeMetrics.fullCount, 4)
  const failedIncident = JSON.parse(fs.readFileSync(path.join(tmp, 'incidents.ndjson'), 'utf8').trim().split('\n').at(-1)!)
  assert.deepEqual(failedIncident.confirmationAttempts.map((attempt: { attempt: number }) => attempt.attempt), [1, 2, 3, 4])
  assert.equal(failedIncident.confirmationAttempts.every((attempt: { uuidVerified: boolean }) => !attempt.uuidVerified), true)
  assert.equal(failedIncident.confirmationAttempts[1].inProcessIdentity, true)
  fs.unlinkSync(path.join(tmp, 'FAILED_SAFE'))

  mounted = false
  expectCode('VOLUME_NOT_MOUNTED', () => inspectStorage(config, probe))
  const missingMount = new ExternalStorageGuard(config, probe)
  expectCode('VOLUME_NOT_MOUNTED', () => missingMount.assertWritable(true))
  assert.equal(opens, 1, 'missing mount cannot open DB')
  mounted = true
  expectCode('VOLUME_NOT_MOUNTED', () => missingMount.assertWritable(true))
  assert.equal(probeCalls > 0, true)

  volume = { ...healthyVolume, uuid: 'other-uuid' }
  expectCode('VOLUME_UUID_MISMATCH', () => inspectStorage(config, probe))
  expectCode('VOLUME_UUID_MISMATCH', () => inspectWritableTargetPath({ ...config, dbPath: `${mount}/new/output.db` }, probe))
  volume = healthyVolume
  present = false
  expectCode('DB_NOT_FOUND', () => inspectStorage(config, probe))
  assert.equal(opens, 1, 'missing DB cannot be created by guard')
  present = true
  volume = { ...healthyVolume, writable: false }
  expectCode('VOLUME_READ_ONLY', () => inspectStorage(config, probe))
  volume = { ...healthyVolume, freeBytes: 1 }
  expectCode('INSUFFICIENT_STORAGE', () => inspectStorage(config, probe))
  volume = healthyVolume
  expectCode('DB_OUTSIDE_EXPECTED_VOLUME', () => inspectStorage({ ...config, dbPath: '/tmp/stockboard.db' }, probe))
  mounted = false
  expectCode('VOLUME_NOT_MOUNTED', () => inspectStorage(config, probe))
  mounted = true

  const incidentFile = path.join(tmp, 'incidents.ndjson')
  fs.unlinkSync(path.join(tmp, 'FAILED_SAFE')) // isolated preflight scenarios do not share a process restart latch
  const incidentsBeforeRuntime = fs.readFileSync(incidentFile, 'utf8').trim().split('\n').length
  let closes = 0
  const runtime = new ExternalStorageGuard(config, probe)
  runtime.setFatalHandler(() => { closes++ })
  runtime.setOperationContext('HISTORICAL_SCAN', 'fixture-job')
  runtime.assertWritable(true)
  const ioError = Object.assign(new Error('simulated I/O error'), { code: 'SQLITE_IOERR' })
  assert.equal(isStorageIoError(ioError), true)
  expectCode('FATAL_STORAGE_IO', () => runtime.classify(ioError))
  const callsAfterFatal = probeCalls
  expectCode('FATAL_STORAGE_IO', () => runtime.assertWritable(true))
  assert.equal(probeCalls, callsAfterFatal, 'fatal process must not retry storage preflight')
  assert.equal(runtime.status, 'FAILED_SAFE')
  assert.equal(closes, 1, 'fatal handler must run exactly once')
  assert.equal(fs.readFileSync(incidentFile, 'utf8').trim().split('\n').length, incidentsBeforeRuntime + 1)
  assert.equal(fs.readFileSync(incidentFile, 'utf8').includes('fixture-job'), true)
  fs.unlinkSync(path.join(tmp, 'FAILED_SAFE')) // simulated recovery between isolated scenarios
  assert.equal(isStorageIoError(Object.assign(new Error('locked'), { code: 'SQLITE_BUSY' })), false)
  for (const [kind, brokenVolume, missingMount] of [
    ['uuid', { ...healthyVolume, uuid: 'wrong-uuid' }, false],
    ['read-only', { ...healthyVolume, writable: false }, false],
    ['full', { ...healthyVolume, freeBytes: 1 }, false],
    ['mount-loss', healthyVolume, true],
  ] as const) {
    const scenario = new ExternalStorageGuard(config, probe)
    volume = healthyVolume
    mounted = true
    scenario.assertWritable(true)
    let writes = 0
    volume = brokenVolume
    mounted = !missingMount
    expectCode(missingMount ? 'VOLUME_NOT_MOUNTED' : kind === 'uuid' ? 'VOLUME_UUID_MISMATCH'
      : kind === 'full' ? 'INSUFFICIENT_STORAGE' : 'VOLUME_READ_ONLY', () => scenario.assertWritable(true))
    const afterFatal = probeCalls
    expectCode(scenario.fatalError!.storageCode, () => { scenario.assertWritable(true); writes++ })
    assert.equal(writes, 0)
    assert.equal(probeCalls, afterFatal)
    fs.unlinkSync(path.join(tmp, 'FAILED_SAFE')) // only the isolated fixture may clear its latch
  }
  volume = healthyVolume
  mounted = true
  assert.equal(isStorageIoError(new Error('database or disk is full')), true)
  assert.equal(fs.readFileSync(incidentFile, 'utf8').includes('test-uuid'), false, 'incidents must not expose UUID')
  const events = fs.readFileSync(path.join(tmp, 'probe-events.ndjson'), 'utf8')
  assert.match(events, /DISKUTIL_INFO/)
  assert.match(events, /PLUTIL_PARSE/)
  assert.match(events, /MOUNT_TABLE/)
  assert.match(events, /TRANSIENT_PROBE_FAILURE_RECOVERED/)

  let changedDevice = false
  const deviceGuard = new ExternalStorageGuard(config, {
    ...probe,
    stat: (value) => ({ dev: changedDevice ? 43 : 42,
      isFile: () => value === db, isDirectory: () => value === mount }),
  }, { wait: () => undefined })
  deviceGuard.assertWritable(true)
  changedDevice = true
  expectCode('VOLUME_IDENTITY_LOST', () => deviceGuard.assertWritable(true))
  assert.equal(deviceGuard.status, 'FAILED_SAFE')
  fs.unlinkSync(path.join(tmp, 'FAILED_SAFE'))
  const staleMarker = path.join(tmp, 'PROBE_UNCERTAIN-999999999')
  fs.writeFileSync(staleMarker, 'fixture\n')
  const staleOwnerGuard = new ExternalStorageGuard(config, probe)
  expectCode('FATAL_STORAGE_IO', () => staleOwnerGuard.assertWritable())
  assert.equal(staleOwnerGuard.status, 'FAILED_SAFE')
  fs.unlinkSync(staleMarker)
  fs.unlinkSync(path.join(tmp, 'FAILED_SAFE'))

  const absentMount = `/Volumes/stockboard-guard-never-mounted-${process.pid}`
  const oldDbPath = process.env.STOCKBOARD_DB_PATH
  const oldMountPath = process.env.STOCK_DATA_MOUNT_PATH
  const oldUuid = process.env.STOCK_DATA_VOLUME_UUID
  const oldIncidentDir = process.env.STOCK_DATA_INCIDENT_DIR
  try {
    process.env.STOCKBOARD_DB_PATH = `${absentMount}/stockboard.db`
    process.env.STOCK_DATA_MOUNT_PATH = absentMount
    process.env.STOCK_DATA_VOLUME_UUID = 'fake-uuid'
    process.env.STOCK_DATA_INCIDENT_DIR = tmp
    assert.equal(proxy(new NextRequest('http://127.0.0.1:3000/stock/7003')).status, 503)
    assert.equal(fs.existsSync(absentMount), false, 'web request must not create a fallback mount directory')
  } finally {
    for (const [name, value] of [
      ['STOCKBOARD_DB_PATH', oldDbPath], ['STOCK_DATA_MOUNT_PATH', oldMountPath],
      ['STOCK_DATA_VOLUME_UUID', oldUuid], ['STOCK_DATA_INCIDENT_DIR', oldIncidentDir],
    ] as const) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  }
  console.log('External storage guard simulation: PASS (normal, missing mount/DB, wrong UUID, read-only, low space, fatal IO, no retry)')
} finally {
  fs.rmSync(tmp, { recursive: true, force: true })
}
