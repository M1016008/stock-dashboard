import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { GET } from '@/app/api/health/route'

async function main() {
  const incidentDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'stockboard-health-'))
  const mount = `/Volumes/stockboard-health-missing-${process.pid}`
  try {
    process.env.STOCKBOARD_DB_PATH = `${mount}/stockboard.db`
    process.env.STOCK_DATA_MOUNT_PATH = mount
    process.env.STOCK_DATA_VOLUME_UUID = 'fixture-uuid'
    process.env.STOCK_DATA_INCIDENT_DIR = incidentDirectory
    process.env.EXTERNAL_STORAGE_REQUIRED = 'true'
    const marker = path.join(incidentDirectory, `PROBE_UNCERTAIN-${process.pid}`)
    fs.writeFileSync(marker, 'fixture\n')
    const verifying = await GET()
    assert.equal(verifying.status, 503)
    assert.equal((await verifying.json() as Record<string, unknown>).storageStatus, 'verifying')
    fs.unlinkSync(marker)
    const response = await GET()
    assert.equal(response.status, 503)
    const body = await response.json() as Record<string, unknown>
    assert.equal(body.status, 'degraded')
    assert.equal(body.overall, 'degraded')
    assert.equal(body.appStatus, 'running')
    assert.equal(body.storageStatus, 'unavailable')
    assert.equal(typeof body.uptimeSeconds, 'number')
    assert.equal(typeof body.timestamp, 'string')
    console.log('Storage health contract: PASS (app running, storage unavailable, HTTP 503)')
  } finally {
    fs.rmSync(incidentDirectory, { recursive: true, force: true })
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1 })
