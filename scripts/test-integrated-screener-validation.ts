import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { NextRequest } from 'next/server'

const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stockboard-integrated-screener-validation-'))
Object.assign(process.env, {
  NODE_ENV: 'test',
  EXTERNAL_STORAGE_REQUIRED: 'false',
  USE_LOCAL_DB: '1',
  STOCKBOARD_DB_PATH: path.join(runtimeDir, 'stockboard.db'),
})

async function main() {
  const { POST } = await import('@/app/api/integrated-screener/route')
  const { POST: saveScreen } = await import('@/app/api/integrated-screener/saved/route')
  const { POST: explainScreen } = await import('@/app/api/integrated-screener/reason/route')
  const { parseScreeningConditions } = await import('@/lib/integrated-screener')
  const invalidConditions = [
    [{ id: 'unsupported', metric: 'roe', operator: 'in', value: [10] }],
    [{ id: 'between', metric: 'roe', operator: 'between', value: 10 }],
    [{ id: 'in-scalar', metric: 'sector33', operator: 'in', value: '情報・通信業' }],
    [{ id: 'in-mixed', metric: 'weeklyAStage', operator: 'in', value: [1, '2'] }],
    [{ id: 'in-option', metric: 'maStructure', operator: 'in', value: ['sideways'] }],
    [{ id: 'wrong-type', metric: 'roe', operator: 'gte', value: '10' }],
  ]

  for (const conditions of invalidConditions) {
    const response = await POST(new NextRequest('http://local.test/api/integrated-screener', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ conditions }),
    }))
    assert.equal(response.status, 400, JSON.stringify(conditions))
    const body = await response.json() as Record<string, unknown>
    assert.equal(body.error, 'Invalid screening conditions')

    const saved = await saveScreen(new NextRequest('http://local.test/api/integrated-screener/saved', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'invalid', state: { conditions } }),
    }))
    assert.equal(saved.status, 400, `saved screen accepted ${JSON.stringify(conditions)}`)

    const explained = await explainScreen(new NextRequest('http://local.test/api/integrated-screener/reason', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ticker: '7203', conditions }),
    }))
    assert.equal(explained.status, 400, `reason API accepted ${JSON.stringify(conditions)}`)
  }

  assert.deepEqual(parseScreeningConditions([
    { id: 'range', metric: 'roe', operator: 'between', value: 20, valueTo: 10 },
  ]), [
    { id: 'range', metric: 'roe', operator: 'between', value: 10, valueTo: 20 },
  ], 'between bounds must have one canonical meaning in search, save, and reason paths')

  console.log('integrated screener strict shared condition contract tests: ok')
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
}).finally(() => {
  fs.rmSync(runtimeDir, { recursive: true, force: true })
})
