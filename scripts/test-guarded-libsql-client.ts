import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { readAnalogSequenceIndexMeta } from '@/lib/db/analog-sequence-index'
import { readServingCache, writeServingCache } from '@/lib/api/serving-cache'
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

    const cachePath = path.join(directory, 'rebuildable', 'serving-cache.db')
    fs.mkdirSync(path.dirname(cachePath), { recursive: true })
    process.env.SERVING_CACHE_DB_PATH = cachePath
    assert.equal(await readServingCache('storage-guard-fixture', 'missing', 1000), null)
    assert.equal(fs.existsSync(cachePath), false, 'a read miss must not create the rebuildable cache')
    await writeServingCache('storage-guard-fixture', 'created', { ok: true }, 60_000)
    assert.equal(fs.existsSync(cachePath), true, 'the write path may rebuild the optional cache')
    assert.deepEqual((await readServingCache<{ ok: boolean }>('storage-guard-fixture', 'created', 60_000))?.payload, { ok: true })

    const invalidCachePath = path.join(directory, 'invalid-serving-cache.db')
    fs.writeFileSync(invalidCachePath, 'not a sqlite database')
    process.env.SERVING_CACHE_DB_PATH = invalidCachePath
    assert.equal(await readServingCache('storage-guard-fixture', 'invalid', 1000), null,
      'cache-local corruption must degrade to a miss')

    const missingAnalogPath = path.join(directory, 'missing-analog-sequence.db')
    process.env.ANALOG_JP_DB_PATH = missingAnalogPath
    assert.equal(await readAnalogSequenceIndexMeta('JP'), null)
    assert.equal(fs.existsSync(missingAnalogPath), false, 'an optional analog read must not create its artifact')

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
