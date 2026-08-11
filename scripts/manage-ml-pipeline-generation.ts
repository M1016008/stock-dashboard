import { createClient } from '@libsql/client'
import fs from 'node:fs'
import path from 'node:path'
import {
  inspectMlPipelineEvidence,
  type MlPipelineAction,
  type MlPipelineMarket,
  readMlPipelineState,
  recordMlPipelineBaseline,
  recordMlPipelineDelta,
  verifyOrAdoptMlPipelineBaseline,
} from '@/lib/ml/pipeline-generation'

const DEFAULT_US_DB = '/Volumes/OWC Express 1M2 80G/stockboard-data/us/stockboard-us.db'

function marketFromEnv(value: string | undefined): MlPipelineMarket {
  const normalized = value?.trim().toUpperCase()
  if (normalized === 'JP' || normalized === 'US') return normalized
  throw new Error('ML_PIPELINE_MARKET must be JP or US')
}

function actionFromEnv(value: string | undefined): MlPipelineAction {
  if (value === 'verify-or-adopt' || value === 'mark-baseline' || value === 'mark-delta' || value === 'status') {
    return value
  }
  throw new Error('ML_PIPELINE_ACTION must be verify-or-adopt, mark-baseline, mark-delta, or status')
}

function databasePath(market: MlPipelineMarket): string {
  const configured = market === 'US'
    ? process.env.US_ANALYTICS_DB_PATH?.trim() || process.env.STOCKBOARD_DB_PATH?.trim() || DEFAULT_US_DB
    : process.env.STOCKBOARD_DB_PATH?.trim() || process.env.LOCAL_DB_PATH?.trim() || 'data/stockboard.db'
  return path.resolve(configured)
}

async function main(): Promise<void> {
  const market = marketFromEnv(process.env.ML_PIPELINE_MARKET)
  const action = actionFromEnv(process.env.ML_PIPELINE_ACTION)
  const dbPath = databasePath(market)
  if (!fs.existsSync(dbPath)) throw new Error(`${market} database not found: ${dbPath}`)

  const client = createClient({ url: `file:${dbPath}` })
  try {
    await client.execute(`PRAGMA busy_timeout=${Number(process.env.SQLITE_BUSY_TIMEOUT_MS ?? 60_000)}`)
    if (action === 'verify-or-adopt') {
      const result = await verifyOrAdoptMlPipelineBaseline(client, market)
      console.log(JSON.stringify({ action, market, adopted: result.adopted, state: result.state }, null, 2))
      return
    }
    if (action === 'mark-baseline') {
      const evidence = await inspectMlPipelineEvidence(client, market, {
        includeCounts: true,
        requireFullHistoryModels: true,
      })
      await recordMlPipelineBaseline(client, evidence)
      console.log(JSON.stringify({ action, market, evidence }, null, 2))
      return
    }
    if (action === 'mark-delta') {
      const evidence = await inspectMlPipelineEvidence(client, market)
      await recordMlPipelineDelta(client, market, evidence)
      console.log(JSON.stringify({ action, market, evidence }, null, 2))
      return
    }

    const state = await readMlPipelineState(client, market)
    console.log(JSON.stringify({ action, market, state }, null, 2))
  } finally {
    client.close()
  }
}

main().catch((error) => {
  console.error('[manage-ml-pipeline-generation] failed:', error)
  process.exitCode = 1
})
