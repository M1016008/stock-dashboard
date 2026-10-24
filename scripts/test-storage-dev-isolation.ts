import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { resolveUsAnalyticsDbPath } from '@/lib/db/us-analytics'
import {
  ExternalStorageGuard,
  type GuardConfig,
  type StorageProbe,
  type VolumeIdentity,
} from '@/lib/storage/external-storage-guard'

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stockboard-dev-storage-isolation-'))
const originalCwd = process.cwd()
const originalUsPath = process.env.US_ANALYTICS_DB_PATH

try {
  process.chdir(tempDir)
  delete process.env.US_ANALYTICS_DB_PATH
  assert.equal(
    resolveUsAnalyticsDbPath(),
    path.join(process.cwd(), 'data', 'stockboard-us.db'),
    'an unconfigured development process must stay on its local fixture path',
  )

  const explicitPath = path.join(tempDir, 'explicit-us.db')
  process.env.US_ANALYTICS_DB_PATH = explicitPath
  assert.equal(resolveUsAnalyticsDbPath(), explicitPath)

  const externalDb = '/Volumes/fixture-stockboard/stockboard.db'
  let probeCalls = 0
  const unusedProbe: StorageProbe = {
    volume: () => { probeCalls++; throw new Error('probe must not run') },
    mountPresent: () => { probeCalls++; return false },
    realpath: (value) => { probeCalls++; return value },
    stat: () => { probeCalls++; throw new Error('probe must not run') },
    exists: () => { probeCalls++; return false },
  }
  const missingIdentityDir = path.join(tempDir, 'missing-identity')
  const missingIdentityConfig: GuardConfig = {
    dbPath: externalDb,
    mountPath: '',
    volumeUuid: '',
    minFreeBytes: 0,
    minFreePercent: 0,
    incidentDir: missingIdentityDir,
    jobType: 'unconfigured-development-preview',
  }
  const unconfigured = new ExternalStorageGuard(missingIdentityConfig, unusedProbe)
  assert.throws(
    () => unconfigured.assertWritable(true),
    (error: { storageCode?: string }) => error.storageCode === 'MOUNT_IDENTITY_UNKNOWN',
  )
  assert.equal(probeCalls, 0, 'identity configuration must be rejected before probing storage')
  assert.equal(fs.existsSync(path.join(missingIdentityDir, 'FAILED_SAFE')), false,
    'a process configuration error must not poison the shared production latch')

  const mountPath = '/Volumes/fixture-stockboard'
  const wrongUuidDir = path.join(tempDir, 'wrong-uuid')
  const expectedConfig: GuardConfig = {
    ...missingIdentityConfig,
    mountPath,
    volumeUuid: 'expected-volume-uuid',
    incidentDir: wrongUuidDir,
    jobType: 'configured-production-simulation',
  }
  const observedVolume: VolumeIdentity = {
    mountPoint: mountPath,
    uuid: 'different-volume-uuid',
    filesystem: 'apfs',
    writable: true,
    freeBytes: 1_000,
    totalBytes: 2_000,
  }
  const wrongUuidProbe: StorageProbe = {
    volume: () => observedVolume,
    mountPresent: () => true,
    realpath: (value) => value,
    stat: (value) => ({
      dev: 42,
      isFile: () => value === externalDb,
      isDirectory: () => value === mountPath,
    }),
    exists: (value) => value === mountPath || value === externalDb,
  }
  const wrongUuid = new ExternalStorageGuard(expectedConfig, wrongUuidProbe)
  assert.throws(
    () => wrongUuid.assertWritable(true),
    (error: { storageCode?: string }) => error.storageCode === 'VOLUME_UUID_MISMATCH',
  )
  assert.equal(fs.existsSync(path.join(wrongUuidDir, 'FAILED_SAFE')), true,
    'a configured production volume mismatch must remain globally fail-closed')

  console.log('Storage development isolation test passed')
} finally {
  process.chdir(originalCwd)
  if (originalUsPath === undefined) delete process.env.US_ANALYTICS_DB_PATH
  else process.env.US_ANALYTICS_DB_PATH = originalUsPath
  fs.rmSync(tempDir, { recursive: true, force: true })
}
