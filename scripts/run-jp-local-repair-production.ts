import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
// @ts-expect-error Node 24 ships node:sqlite; the repository pins older Node type declarations.
import { DatabaseSync } from 'node:sqlite'
import { createJpOhlcvRepairPlan, type JpOhlcvOfficialRow } from '@/lib/jp-ohlcv-local-repair'
import { JP_OHLCV_PROTECTED_CONFLICT_KEYS } from '@/lib/jp-ohlcv-repair-policy'
import { executeJpRepair } from '@/lib/jp-ohlcv-repair-executor'
import {
  JP_REPAIR_SERVICE_LABEL_PREFIX,
  type JpRepairPreflightInput,
  inspectJpRepairDatabaseLogicalState,
  preflightJpRepairProduction,
} from '@/lib/jp-ohlcv-repair-production'
import { jpRepairNodeModulesLockSha256, jpRepairRuntimeSourceTreeSha256 } from '@/lib/jp-ohlcv-repair-runtime-manifest'
import { configForDatabase, hasStorageFatalLatch, inspectStorage } from '@/lib/storage/external-storage-guard'
import {
  assertLaunchdServiceAbsent,
  createLaunchdWriterHoldDriver,
  listLoadedLaunchdLabels,
  readLaunchdWorkingDirectory,
} from '@/lib/storage/launchd-writer-hold-driver'

// Preflight and dry-run only. Opens the database read-only, observes launchd without
// changing it, and never holds services or writes the production database.
// The approval is not parsed here; the preflight reads it only after its hash
// matches --expected-approval-sha256.
//   tsx scripts/run-jp-local-repair-production.ts --approval=/abs/approval.json \
//     --expected-approval-sha256=<sha256> --database=/abs/stockboard.db \
//     --official=/abs/official.json --price-basis-evidence=/abs/evidence.json \
//     --rehearsal-receipt=/abs/rehearsal/rehearsal-receipt.json \
//     --analog=/abs/analog-sequence-jp-v2.db --serving-cache=/abs/stockboard-serving-cache.db \
//     [--b2-evidence=/abs/b2.json --b2-evidence-sha256=<sha256>]
// The execution gate is evaluated as a DRY_RUN; this runner never executes and
// supplies no isolated root, so the gate always HOLDs here (B2 evidence is
// synthetic-only and the C-min/B2 Production verifier has not run).

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
    '--rehearsal-receipt', '--analog', '--serving-cache', '--b2-evidence', '--b2-evidence-sha256',
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
  const analogPath = absolute('--analog')
  const servingCachePath = absolute('--serving-cache')
  const preflightInput: JpRepairPreflightInput = {
    approvalPath,
    expectedApprovalSha256: values.get('--expected-approval-sha256') ?? '',
    databasePath,
    analogPath,
    servingCachePath,
    officialEvidencePath,
    priceBasisEvidencePath,
    rehearsalReceiptPath: absolute('--rehearsal-receipt'),
    now: Date.now(),
    gitCommitSha: () => execFileSync('/usr/bin/git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    runtimeSourceTreeSha256: () => jpRepairRuntimeSourceTreeSha256(),
    nodeModulesLockSha256: () => jpRepairNodeModulesLockSha256(process.cwd()),
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
    assertServiceAbsent: (service) => assertLaunchdServiceAbsent(service),
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
        nodeModulesLockSha256: gitHead && workingDirectory ? jpRepairNodeModulesLockSha256(workingDirectory) : null,
      }
    },
  }
  const preflight = await preflightJpRepairProduction(preflightInput)
  const b2Path = values.get('--b2-evidence')
  const gate = await executeJpRepair({
    mode: 'DRY_RUN',
    preflight: async () => preflight,
    targets: { database: databasePath, analog: analogPath, servingCache: servingCachePath },
    b2: b2Path ? { evidencePath: path.resolve(b2Path), expectedSha256: values.get('--b2-evidence-sha256') ?? '' } : undefined,
    revision: { sourceTreeSha256: jpRepairRuntimeSourceTreeSha256(), nodeModulesLockSha256: jpRepairNodeModulesLockSha256(process.cwd()) },
    workflow: async () => { throw new Error('the production runner never executes') },
  })

  console.log(JSON.stringify({
    mode: 'PREFLIGHT_ONLY',
    executionGate: { verdict: gate.verdict, productionReady: gate.productionReady, holdReasons: gate.holdReasons },
    ...preflight,
    productionDatabaseWritten: false,
    servicesHeld: false,
  }, null, 2))
  if (preflight.verdict !== 'PASS' || gate.verdict !== 'PASS' || !gate.productionReady) process.exitCode = 1
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
