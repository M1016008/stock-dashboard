import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createClient } from '@libsql/client'

async function createGeneration(dbPath: string, generation: string): Promise<void> {
  const client = createClient({ url: `file:${dbPath}` })
  try {
    await client.execute('CREATE TABLE generation_marker (value TEXT NOT NULL)')
    await client.execute({
      sql: 'INSERT INTO generation_marker (value) VALUES (?)',
      args: [generation],
    })
    await client.execute('PRAGMA wal_checkpoint(TRUNCATE)')
  } finally {
    client.close()
  }
}

async function main(): Promise<void> {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stockboard-us-generation-'))
  const activePath = path.join(tempDir, 'active.db')
  const replacementPath = path.join(tempDir, 'replacement.db')

  try {
    await createGeneration(activePath, 'generation-1')
    process.env.US_ANALYTICS_DB_PATH = activePath
    const { execUsAnalyticsGet } = await import('../lib/db/us-analytics')

    const before = await execUsAnalyticsGet<{ value: string }>(
      'SELECT value FROM generation_marker',
    )
    assert.equal(before?.value, 'generation-1')

    await createGeneration(replacementPath, 'generation-2')
    fs.renameSync(replacementPath, activePath)

    const after = await execUsAnalyticsGet<{ value: string }>(
      'SELECT value FROM generation_marker',
    )
    assert.equal(after?.value, 'generation-2')
    console.log('US analytics generation swap test passed')
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
