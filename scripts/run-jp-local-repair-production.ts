import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
// @ts-expect-error Node 24 ships node:sqlite; the repository pins older Node type declarations.
import { DatabaseSync } from 'node:sqlite'
import { createJpOhlcvRepairPlan, type JpOhlcvOfficialRow } from '@/lib/jp-ohlcv-local-repair'
import { JP_OHLCV_PROTECTED_CONFLICT_KEYS } from '@/lib/jp-ohlcv-repair-policy'
import {
  JP_REPAIR_SERVICE_LABEL_PREFIX,
  inspectJpRepairDatabaseLogicalState,
  preflightJpRepairProduction,
} from '@/lib/jp-ohlcv-repair-production'
import { jpRepairRuntimeSourceTreeSha256 } from '@/lib/jp-ohlcv-repair-runtime-manifest'
import { configForDatabase, hasStorageFatalLatch, inspectStorage } from '@/lib/storage/external-storage-guard'
import {
  createLaunchdWriterHoldDriver,
  listLoadedLaunchdLabels,
  readLaunchdWorkingDirectory,
} from '@/lib/storage/launchd-writer-hold-driver'

// Preflight only. Opens the database read-only, observes launchd without
// changing it, and never holds services or writes the production database.
// The approval is not parsed here; the preflight reads it only after its hash
// matches --expected-approval-sha256.
//   tsx scripts/run-jp-local-repair-production.ts --approval=/abs/approval.json \
//     --expected-approval-sha256=<sha256> --database=/abs/stockboard.db \
//     --official=/abs/official.json --price-basis-evidence=/abs/evidence.json \
//     --rehearsal-receipt=/abs/rehearsal/rehearsal-receipt.json

const values = new Map(process.argv.slice(2).map((argument) => {
  const [key, ...rest] = argument.split('=')
  return [key, rest.join('=')]
}))

function absolute(name: string): string {
  const value = values.get(name)
  if (!value || !path.isAbsolute(value)) throw new Error(`${name}=/absolute/path is required`)
  return value
}

async function main(): Promise<void> {
  const allowed = new Set([
    '--approval', '--expected-approval-sha256', '--database', '--official', '--price-basis-evidence',
    '--rehearsal-receipt',
  ])
  const unknown = [...values.keys()].filter((key) => !allowed.has(key))
  if (unknown.length > 0) throw new Error(`unsupported arguments (preflight only): ${unknown.join(',')}`)
  const approvalPath = absolute('--approval')
  const databasePath = absolute('--database')
  const officialEvidencePath = absolute('--official')
  const priceBasisEvidencePath = absolute('--price-basis-evidence')
  const official = JSON.parse(fs.readFileSync(officialEvidencePath, 'utf8')) as {
    date: string
    priceBasis: 'jquants-adjusted-ohlcv-v1'
    sourceContract: { contentSha256: string }
    rows: JpOhlcvOfficialRow[]
  }
  const preflight = await preflightJpRepairProduction({
    approvalPath,
    expectedApprovalSha256: values.get('--expected-approval-sha256') ?? '',
    databasePath,
    officialEvidencePath,
    priceBasisEvidencePath,
    rehearsalReceiptPath: absolute('--rehearsal-receipt'),
    now: Date.now(),
    gitCommitSha: () => execFileSync('/usr/bin/git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    runtimeSourceTreeSha256: () => jpRepairRuntimeSourceTreeSha256(),
    inspectStorageVolumeUuid: () => {
      const config = configForDatabase(databasePath, 'db_maintenance')
      if (hasStorageFatalLatch(config)) throw new Error('storage fatal latch is set')
      return inspectStorage(config).uuid ?? ''
    },
    inspectDatabase: () => {
      const db = new DatabaseSync(databasePath, { readOnly: true })
      try {
        db.exec('PRAGMA busy_timeout=60000')
        const plan = createJpOhlcvRepairPlan({
          db,
          targetDate: official.date,
          priceBasis: official.priceBasis,
          providerContentSha256: official.sourceContract.contentSha256,
          officialRows: official.rows,
          preservedConflictKeys: JP_OHLCV_PROTECTED_CONFLICT_KEYS.map(({ ticker, date }) => `${ticker}:${date}`),
        })
        return { plan, logical: inspectJpRepairDatabaseLogicalState(db) }
      } finally {
        db.close()
      }
    },
    // Used only for observe(); bootout/bootstrap are never called here. A
    // loaded job must also have been loaded from the approved plist/program.
    createServiceObserver: (services) => createLaunchdWriterHoldDriver(services, { verifyLoadedJob: true }),
    listLoadedServiceLabels: () => listLoadedLaunchdLabels(JP_REPAIR_SERVICE_LABEL_PREFIX),
    inspectRuntime: (service) => {
      // The loaded job's actual working directory, checked against the plist.
      const configured = readLaunchdWorkingDirectory(service)
      const workingDirectory = configured ? fs.realpathSync(configured) : null
      const head = workingDirectory
        ? spawnSync('/usr/bin/git', ['rev-parse', 'HEAD'], { cwd: workingDirectory, encoding: 'utf8' })
        : null
      const gitHead = head?.status === 0 ? head.stdout.trim() : null
      // Throws on a dirty, untracked, or ignored-executable runtime tree.
      return {
        workingDirectory,
        gitHead,
        sourceTreeSha256: gitHead && workingDirectory ? jpRepairRuntimeSourceTreeSha256(workingDirectory) : null,
      }
    },
  })

  console.log(JSON.stringify({
    mode: 'PREFLIGHT_ONLY',
    ...preflight,
    productionDatabaseWritten: false,
    servicesHeld: false,
  }, null, 2))
  if (preflight.verdict !== 'PASS') process.exitCode = 1
}

main().catch((error) => {
  console.error(JSON.stringify({
    mode: 'PREFLIGHT_ONLY',
    verdict: 'HOLD',
    holdReasons: [`RUNNER_ERROR:${error instanceof Error ? error.message : String(error)}`],
    productionDatabaseWritten: false,
  }, null, 2))
  process.exitCode = 1
})
