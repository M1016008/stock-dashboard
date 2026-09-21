import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { NextRequest } from 'next/server'
import { proxy } from '../proxy'
import {
  ExternalStorageGuard, inspectStorage, inspectWritableTargetPath, isStorageIoError, requiresExternalStorageGuard,
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
  realpath: (value) => value,
  stat: (value) => ({ dev: 42, isFile: () => value === db || value.endsWith('-wal') || value.endsWith('-shm'), isDirectory: () => value === mount }),
  exists: (value) => mounted && (value === mount || (present && value === db)),
}

function expectCode(code: string, fn: () => unknown): void {
  assert.throws(fn, (error: { storageCode?: string }) => error.storageCode === code)
}

try {
  assert.equal(inspectStorage(config, probe).uuid, 'test-uuid')
  assert.equal(inspectWritableTargetPath(config, probe).uuid, 'test-uuid')
  assert.equal(inspectWritableTargetPath({ ...config, dbPath: `${mount}/new/output.db` }, probe).uuid, 'test-uuid')
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
