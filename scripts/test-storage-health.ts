import assert from 'node:assert/strict'
import { GET } from '@/app/api/health/route'

async function main() {
  const mount = `/Volumes/stockboard-health-missing-${process.pid}`
  process.env.STOCKBOARD_DB_PATH = `${mount}/stockboard.db`
  process.env.STOCK_DATA_MOUNT_PATH = mount
  process.env.STOCK_DATA_VOLUME_UUID = 'fixture-uuid'
  process.env.EXTERNAL_STORAGE_REQUIRED = 'true'
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
}

main().catch((error) => { console.error(error); process.exitCode = 1 })
