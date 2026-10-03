import { runTriggerHistoricalWorkLoop } from '@/lib/server/trigger-historical-work-queue'

runTriggerHistoricalWorkLoop().catch((error) => {
  console.error('[trigger-historical-scan-worker] fatal', error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
