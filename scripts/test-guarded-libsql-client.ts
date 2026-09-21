import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { readServingCache } from '@/lib/api/serving-cache'
import { openExistingGuardedClient } from '@/lib/storage/guarded-libsql-client'

async function main(): Promise<void> {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'stockboard-guarded-client-'))
  const dbPath = path.join(directory, 'fixture.db')
  try {
    const client = openExistingGuardedClient(dbPath, 'local-fixture')
    await client.execute('CREATE TABLE fixture (value INTEGER)')
    await client.execute('INSERT INTO fixture (value) VALUES (7)')
    const result = await client.execute('SELECT value FROM fixture')
    assert.equal(Number(result.rows[0]?.value), 7)
    client.close()

    const absentMount = `/Volumes/stockboard-guarded-client-missing-${process.pid}`
    process.env.STOCK_DATA_MOUNT_PATH = absentMount
    process.env.STOCK_DATA_VOLUME_UUID = 'fixture-uuid'
    process.env.STOCK_DATA_INCIDENT_DIR = directory
    assert.throws(
      () => openExistingGuardedClient(`${absentMount}/fixture.db`, 'external-fixture'),
      (error: { storageCode?: string }) => error.storageCode === 'VOLUME_NOT_MOUNTED',
    )
    assert.equal(fs.existsSync(absentMount), false)
    fs.unlinkSync(path.join(directory, 'FAILED_SAFE')) // isolated scenario emulates a reviewed process restart
    process.env.SERVING_CACHE_DB_PATH = `${absentMount}/serving/cache.db`
    await assert.rejects(
      () => readServingCache('storage-guard-fixture', 'missing', 1000),
      (error: { storageCode?: string }) => error.storageCode === 'VOLUME_NOT_MOUNTED',
    )
    assert.equal(fs.existsSync(absentMount), false)
    console.log('Guarded libSQL client: PASS (local fixture, external mount missing, no fallback DB or serving cache)')
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1 })
