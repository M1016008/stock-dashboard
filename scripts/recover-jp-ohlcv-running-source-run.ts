import { client } from '@/lib/db/client'
import {
  holdJpOhlcvRunningSourceRun,
  inspectJpOhlcvRunningSourceRun,
} from '@/lib/jp-ohlcv-source-run-recovery'

function integer(value: string | undefined): number {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error('source_run_id_invalid')
  return parsed
}

async function main(): Promise<void> {
  await client.execute('PRAGMA busy_timeout=60000')
  const [command, runValue, expectedStatusSha256] = process.argv.slice(2)
  const sourceRunId = integer(runValue)
  if (command === 'status') {
    console.log(JSON.stringify(await inspectJpOhlcvRunningSourceRun(client, sourceRunId), null, 2))
    return
  }
  if (command === 'hold') {
    if (!expectedStatusSha256) throw new Error('expected_status_sha256_required')
    const approved = await holdJpOhlcvRunningSourceRun(client, { sourceRunId, expectedStatusSha256 })
    console.log(JSON.stringify({
      outcome: 'HELD_PARTIAL',
      sourceRunId,
      approvedStatusSha256: approved.statusSha256,
      previousSuccessfulSourceRunId: approved.previousSuccessfulSourceRunId,
    }, null, 2))
    return
  }
  throw new Error('usage: status <sourceRunId> | hold <sourceRunId> <expectedStatusSha256>')
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
