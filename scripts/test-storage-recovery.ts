import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { recoverStorage, type RecoveryChecks } from '@/lib/storage/storage-recovery'
import { storageFatalLatchPath, type GuardConfig, type VolumeIdentity } from '@/lib/storage/external-storage-guard'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stockboard-recovery-'))
const incidentId = '11111111-2222-4333-8444-555555555555'
const config: GuardConfig = {
  dbPath: '/Volumes/fixture/stockboard.db', mountPath: '/Volumes/fixture', volumeUuid: 'fixture-uuid',
  minFreeBytes: 1, minFreePercent: 1, incidentDir: dir,
}
const volume: VolumeIdentity = {
  mountPoint: config.mountPath, uuid: config.volumeUuid, filesystem: 'apfs', writable: true,
  freeBytes: 1_000, totalBytes: 2_000,
}
const identity = { mount: config.mountPath, db: config.dbPath, device: 42 }
let checkedErrors = false
const checks: RecoveryChecks = {
  inspect: () => volume,
  identity: () => identity,
  noHandles: () => {},
  noErrors: () => { checkedErrors = true },
  wait: async () => {},
}

async function run(): Promise<void> {
  try {
    fs.writeFileSync(path.join(dir, 'incidents.ndjson'), `${JSON.stringify({
      incidentId, timestamp: '2026-09-21T08:06:04.766Z', errorCode: 'VOLUME_NOT_MOUNTED',
    })}\n`)
    fs.writeFileSync(storageFatalLatchPath(config), 'manual review required\n')
    const options = { checks, observations: 3, intervalMs: 0 }
    await assert.rejects(recoverStorage(config, 'other-id', 'UNKNOWN_BUT_CURRENTLY_STABLE', options), /Incident ID/)
    assert.equal(fs.existsSync(storageFatalLatchPath(config)), true)
    await assert.rejects(recoverStorage(config, incidentId, 'UNKNOWN_BUT_CURRENTLY_STABLE', {
      ...options, checks: { ...checks, noHandles: () => { throw new Error('active writer') } },
    }), /active writer/)
    await assert.rejects(recoverStorage(config, incidentId, 'UNKNOWN_BUT_CURRENTLY_STABLE', {
      ...options, checks: { ...checks, noErrors: () => { throw new Error('new NVMe error') } },
    }), /new NVMe error/)
    let identityCalls = 0
    await assert.rejects(recoverStorage(config, incidentId, 'UNKNOWN_BUT_CURRENTLY_STABLE', {
      ...options, checks: {
        ...checks,
        identity: () => (++identityCalls === 2 ? { ...identity, device: 43 } : identity),
      },
    }), /Storage identity changed/)
    await assert.rejects(recoverStorage(config, incidentId, 'UNKNOWN_BUT_CURRENTLY_STABLE', {
      ...options, checks: { ...checks, inspect: () => ({ ...volume, uuid: 'unexpected-uuid' }) },
    }), /Volume UUID changed/)
    assert.equal(fs.existsSync(storageFatalLatchPath(config)), true, 'failed gates must preserve latch')
    const liveMarker = path.join(dir, `PROBE_UNCERTAIN-${process.pid}`)
    fs.writeFileSync(liveMarker, 'fixture\n')
    await assert.rejects(recoverStorage(config, incidentId, 'UNKNOWN_BUT_CURRENTLY_STABLE', options), /Probe owner remains alive/)
    fs.unlinkSync(liveMarker)
    const staleMarker = path.join(dir, 'PROBE_UNCERTAIN-999999999')
    fs.writeFileSync(staleMarker, 'fixture\n')
    const result = await recoverStorage(config, incidentId, 'UNKNOWN_BUT_CURRENTLY_STABLE', options)
    assert.equal(result.checks, 3)
    assert.equal(checkedErrors, true)
    assert.equal(fs.existsSync(storageFatalLatchPath(config)), false)
    assert.equal(fs.existsSync(path.join(dir, `FAILED_SAFE.resolved-${incidentId}`)), true)
    assert.equal(fs.existsSync(path.join(dir, `PROBE_UNCERTAIN-999999999.resolved-${incidentId}`)), true)
    const record = JSON.parse(fs.readFileSync(path.join(dir, `recovery-${incidentId}.json`), 'utf8'))
    assert.equal(record.resolution, 'UNKNOWN_BUT_CURRENTLY_STABLE')
    assert.equal(record.originalErrorCode, 'VOLUME_NOT_MOUNTED')
    await assert.rejects(recoverStorage(config, incidentId, 'UNKNOWN_BUT_CURRENTLY_STABLE', options), /No FAILED_SAFE latch/)
    console.log('Storage recovery gate: PASS')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

run().catch((error: unknown) => { console.error(error); process.exitCode = 1 })
