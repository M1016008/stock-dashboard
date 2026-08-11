import { createClient } from '@libsql/client'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ML_PHYSICS_FEATURE_SET, ML_PHYSICS_MODEL_TYPE } from '@/lib/backtest/ml-physics'
import { ML_PRIMARY_HORIZONS } from '@/lib/backtest/ml-horizons'
import {
  inspectMlPipelineEvidence,
  ML_PIPELINE_NAME,
  readMlPipelineState,
  recordMlPipelineDelta,
  verifyOrAdoptMlPipelineBaseline,
} from '@/lib/ml/pipeline-generation'
import { US_ADJUSTED_PRICE_BASIS } from '@/lib/us-adjusted-ohlcv'

async function main(): Promise<void> {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'stockboard-ml-generation-'))
  const dbPath = path.join(directory, 'test.db')
  const client = createClient({ url: `file:${dbPath}` })
  try {
    await client.batch([
      'CREATE TABLE ohlcv_daily (ticker TEXT NOT NULL, date TEXT NOT NULL)',
      'CREATE TABLE ml_feature_vectors (ticker TEXT NOT NULL, date TEXT NOT NULL)',
      'CREATE TABLE ml_feature_vectors_v2 (feature_set TEXT NOT NULL, ticker TEXT NOT NULL, date TEXT NOT NULL)',
      `CREATE TABLE ml_models (
        model_type TEXT NOT NULL,
        direction TEXT NOT NULL,
        horizon_days INTEGER NOT NULL,
        metrics_json TEXT NOT NULL,
        trained_at INTEGER NOT NULL
      )`,
      'CREATE TABLE us_analytics_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL)',
      "INSERT INTO ohlcv_daily VALUES ('AAPL', '2020-01-02'), ('AAPL', '2026-08-10')",
      "INSERT INTO ml_feature_vectors VALUES ('AAPL', '2020-01-02'), ('AAPL', '2026-08-10')",
      `INSERT INTO ml_feature_vectors_v2 VALUES
        ('${ML_PHYSICS_FEATURE_SET}', 'AAPL', '2020-01-02'),
        ('${ML_PHYSICS_FEATURE_SET}', 'AAPL', '2026-08-10')`,
      `INSERT INTO us_analytics_metadata VALUES ('ohlcv_price_basis', '${US_ADJUSTED_PRICE_BASIS}')`,
    ])
    for (const horizon of ML_PRIMARY_HORIZONS) {
      await client.batch([
        ...['up', 'down'].map((direction) => ({
          sql: 'INSERT INTO ml_models VALUES (?, ?, ?, ?, ?)',
          args: ['logistic_regression_v1', direction, horizon, JSON.stringify({ mode: 'yearly', trainStartDate: '2020-01-02' }), 1],
        })),
        ...['up', 'down', 'wait'].map((direction) => ({
          sql: 'INSERT INTO ml_models VALUES (?, ?, ?, ?, ?)',
          args: [ML_PHYSICS_MODEL_TYPE, direction, horizon, JSON.stringify({ mode: 'yearly', trainStartDate: '2020-01-02' }), 1],
        })),
      ])
    }

    await assert.rejects(
      () => verifyOrAdoptMlPipelineBaseline(client, 'US'),
      /full-history model proof/,
    )
    await client.execute(
      `UPDATE ml_models
       SET metrics_json = json_set(metrics_json, '$.mode', 'all_paged')`,
    )
    const adopted = await verifyOrAdoptMlPipelineBaseline(client, 'US')
    assert.equal(adopted.adopted, true)
    assert.equal(adopted.state.baselineSourceDate, '2026-08-10')

    await client.batch([
      "INSERT INTO ohlcv_daily VALUES ('AAPL', '2026-08-11')",
      "INSERT INTO ml_feature_vectors VALUES ('AAPL', '2026-08-11')",
      `INSERT INTO ml_feature_vectors_v2 VALUES ('${ML_PHYSICS_FEATURE_SET}', 'AAPL', '2026-08-11')`,
    ])
    const deltaEvidence = await inspectMlPipelineEvidence(client, 'US')
    await recordMlPipelineDelta(client, 'US', deltaEvidence)
    const updated = await readMlPipelineState(client, 'US')
    assert.equal(updated?.baselineSourceDate, '2026-08-10')
    assert.equal(updated?.lastDeltaSourceDate, '2026-08-11')
    const payload = JSON.parse(updated?.payloadJson ?? '{}') as Record<string, unknown>
    assert.ok(payload.baseline)
    assert.ok(payload.latestDelta)

    await client.execute({
      sql: 'UPDATE ml_pipeline_generations SET generation_version = ? WHERE market = ? AND pipeline = ?',
      args: ['incompatible', 'US', ML_PIPELINE_NAME],
    })
    await assert.rejects(() => verifyOrAdoptMlPipelineBaseline(client, 'US'), /incompatible/)
  } finally {
    client.close()
    fs.rmSync(directory, { recursive: true, force: true })
  }
  console.log('ML pipeline generation tests passed')
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
