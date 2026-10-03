import { configForDatabase } from '@/lib/storage/external-storage-guard'
import { recoverStorage, type RecoveryResolution } from '@/lib/storage/storage-recovery'
import { resolveConfiguredStoragePath } from '@/lib/storage-paths'

const resolutions: RecoveryResolution[] = [
  'REAL_DISCONNECT_RECOVERED', 'FALSE_POSITIVE_CONFIRMED',
  'TRANSIENT_CHECK_FAILURE', 'UNKNOWN_BUT_CURRENTLY_STABLE',
]

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  if (args.length !== 4 || args[0] !== '--incident-id' || args[2] !== '--resolution') {
    throw new Error('Usage: npm run storage:recover -- --incident-id <id> --resolution <classification>')
  }
  const [, incidentId, , resolution] = args
  if (!/^[0-9a-f-]{36}$/i.test(incidentId) || !resolutions.includes(resolution as RecoveryResolution)) {
    throw new Error('Invalid incident ID or resolution')
  }
  const configured = process.env.STOCKBOARD_DB_PATH || process.env.LOCAL_DB_PATH
  if (!configured) throw new Error('STOCKBOARD_DB_PATH is not configured')
  const db = resolveConfiguredStoragePath(configured)
  const result = await recoverStorage(configForDatabase(db, 'manual-recovery'), incidentId, resolution as RecoveryResolution)
  console.log(JSON.stringify({ status: 'RESOLVED', ...result }))
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
