import { spawn } from 'node:child_process'
import { createClient } from '@libsql/client'
import path from 'node:path'
import {
  canRefreshLegacyBaselineForCalendarStages,
  hasAuditedFullHistoryBaseline,
  readMlPipelineState,
  verifyOrAdoptMlPipelineBaseline,
} from '@/lib/ml/pipeline-generation'
import { resolveConfiguredStoragePath } from '@/lib/storage-paths'
import { waitForMemoryHeadroom, withMemoryGuardEnv } from '@/lib/system/memory-guard'

const jpDbPath = resolveConfiguredStoragePath(path.resolve(
  process.env.STOCKBOARD_DB_PATH?.trim()
    || process.env.LOCAL_DB_PATH?.trim()
    || 'data/stockboard.db',
))

type BaselineAction = 'delta' | 'calendar-stage-refresh' | 'full'

async function baselineAction(): Promise<BaselineAction> {
  const client = createClient({ url: `file:${jpDbPath}` })
  try {
    await client.execute(`PRAGMA busy_timeout=${Number(process.env.SQLITE_BUSY_TIMEOUT_MS ?? 60_000)}`)
    const existing = await readMlPipelineState(client, 'JP')
    if (hasAuditedFullHistoryBaseline(existing)) return 'delta'
    if (canRefreshLegacyBaselineForCalendarStages(existing)) {
      console.log('JP weekly: reusing the audited v1 targets for the calendar-stage feature refresh')
      return 'calendar-stage-refresh'
    }

    try {
      const adopted = await verifyOrAdoptMlPipelineBaseline(client, 'JP')
      console.log(
        adopted.adopted
          ? 'JP weekly: adopted the existing audited full-history baseline'
          : 'JP weekly: verified the recorded full-history baseline',
      )
      return hasAuditedFullHistoryBaseline(adopted.state) ? 'delta' : 'full'
    } catch (error) {
      console.log(
        `JP weekly: audited full-history baseline is unavailable; initial full run required (${error instanceof Error ? error.message : String(error)})`,
      )
      return 'full'
    }
  } finally {
    client.close()
  }
}

async function runNpm(script: string, extraEnv: Record<string, string> = {}): Promise<void> {
  await waitForMemoryHeadroom({ label: `JP weekly ${script}` })
  await new Promise<void>((resolve, reject) => {
    const child = spawn('npm', ['run', script], {
      cwd: process.cwd(),
      stdio: 'inherit',
      env: withMemoryGuardEnv({
        ...process.env,
        USE_LOCAL_DB: '1',
        STOCKBOARD_DB_PATH: jpDbPath,
        ...extraEnv,
      }),
    })
    child.on('error', reject)
    child.on('close', (code, signal) => {
      if (code === 0) resolve()
      else reject(new Error(`npm run ${script} failed: code=${code}, signal=${signal ?? 'none'}`))
    })
  })
}

async function main(): Promise<void> {
  const action = await baselineAction()
  if (action === 'delta') {
    console.log('JP weekly: full-history baseline is ready; running delta refresh only')
    await runNpm('batch:ml-weekly-delta-governance')
    return
  }

  if (action === 'calendar-stage-refresh') {
    console.log('JP weekly: running the checkpointed full-history calendar-stage refresh')
    await runNpm('batch:ml-calendar-stage-refresh-governance')
  } else {
    console.log('JP weekly: running the one-time full-history baseline')
    await runNpm('batch:ml-weekly-full-governance')
  }
  await runNpm('batch:ml-pipeline-state', {
    ML_PIPELINE_ACTION: 'mark-baseline',
    ML_PIPELINE_MARKET: 'JP',
  })
}

main().catch((error) => {
  console.error('JP weekly efficient update failed:', error)
  process.exit(1)
})
