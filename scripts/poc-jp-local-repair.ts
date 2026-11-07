import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
// @ts-expect-error Node 24 ships node:sqlite; the repository pins older Node type declarations.
import { DatabaseSync } from 'node:sqlite'
import {
  applyJpOhlcvRepairTransaction,
  completeJpOhlcvRepairDerived,
  createJpOhlcvRepairPlan,
  type JpOhlcvOfficialRow,
  type JpOhlcvRepairPlan,
} from '@/lib/jp-ohlcv-local-repair'

type OfficialEvidence = {
  date: string
  priceBasis: 'jquants-adjusted-ohlcv-v1'
  sourceContract: { contentSha256: string; acceptedRows: number; unexpectedRejectedRows: number }
  rows: JpOhlcvOfficialRow[]
}

function parse(argv: string[]): { command: string; values: Map<string, string>; flags: Set<string> } {
  const command = argv.shift()
  if (command !== 'plan' && command !== 'apply') throw new Error('command must be plan or apply')
  const values = new Map<string, string>()
  const flags = new Set<string>()
  while (argv.length > 0) {
    const name = argv.shift()!
    if (!name.startsWith('--')) throw new Error(`unexpected argument: ${name}`)
    if (name === '--fixture-derived-probe') {
      flags.add(name)
      continue
    }
    const value = argv.shift()
    if (!value) throw new Error(`missing value for ${name}`)
    values.set(name, value)
  }
  return { command, values, flags }
}

function required(values: Map<string, string>, name: string): string {
  const value = values.get(name)
  if (!value) throw new Error(`missing ${name}`)
  return path.resolve(value)
}

function assertIsolatedDatabase(database: string): void {
  const real = fs.realpathSync(database)
  const allowedRoots = [fs.realpathSync(os.tmpdir()), fs.realpathSync('/private/tmp')]
  if (!allowedRoots.some((root) => real === root || real.startsWith(`${root}${path.sep}`))) {
    throw new Error(`PoC refuses non-temporary database: ${real}`)
  }
  if (real.startsWith('/Volumes/')) throw new Error(`PoC refuses external-volume database: ${real}`)
}

function loadOfficial(filePath: string): OfficialEvidence {
  const evidence = JSON.parse(fs.readFileSync(filePath, 'utf8')) as OfficialEvidence
  if (evidence.priceBasis !== 'jquants-adjusted-ohlcv-v1'
      || evidence.sourceContract.acceptedRows !== evidence.rows.length
      || evidence.sourceContract.unexpectedRejectedRows !== 0) {
    throw new Error('official evidence is not approved')
  }
  return evidence
}

async function main(): Promise<void> {
  const cli = parse(process.argv.slice(2))
  const database = required(cli.values, '--database')
  const officialPath = required(cli.values, '--official')
  const planPath = required(cli.values, '--plan')
  assertIsolatedDatabase(database)
  const official = loadOfficial(officialPath)
  const db = new DatabaseSync(database)
  try {
    if (cli.command === 'plan') {
      const plan = createJpOhlcvRepairPlan({
        db,
        targetDate: official.date,
        priceBasis: official.priceBasis,
        providerContentSha256: official.sourceContract.contentSha256,
        officialRows: official.rows,
        preservedConflictKeys: ['1447:2026-07-17', '2164:2026-07-17'],
      })
      if (official.rows.length !== 4_218 || plan.approvedMissingKeys.length !== 4_061) {
        throw new Error(`unexpected repair envelope: official=${official.rows.length} missing=${plan.approvedMissingKeys.length}`)
      }
      fs.writeFileSync(planPath, `${JSON.stringify(plan, null, 2)}\n`)
      console.log(JSON.stringify({ command: 'plan', approvalSha256: plan.approvalSha256, plan: planPath }))
      return
    }

    db.exec('PRAGMA synchronous=FULL; PRAGMA fullfsync=ON; PRAGMA busy_timeout=5000;')
    const journalMode = (db.prepare('PRAGMA journal_mode').get() as { journal_mode: string }).journal_mode
    if (journalMode.toLowerCase() !== 'wal') {
      throw new Error(`repair apply requires WAL journal mode; got ${journalMode}`)
    }
    const plan = JSON.parse(fs.readFileSync(planPath, 'utf8')) as JpOhlcvRepairPlan
    const failAt = cli.values.get('--fail-at') ?? null
    const marker = cli.values.get('--marker') ? path.resolve(cli.values.get('--marker')!) : null
    const result = applyJpOhlcvRepairTransaction({
      db,
      plan,
      officialRows: official.rows,
      testOnlyAfterSourceInsert: () => {
        if (failAt === 'after-source-insert') throw new Error('injected failure after source insert')
        if (failAt === 'delay-after-source-insert') {
          if (!marker) throw new Error('--marker is required for delay-after-source-insert')
          fs.writeFileSync(marker, 'ready\n')
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500)
        }
        if (failAt === 'pause-after-source-insert') {
          if (!marker) throw new Error('--marker is required for pause-after-source-insert')
          fs.writeFileSync(marker, 'ready\n')
          const until = Date.now() + 60_000
          while (Date.now() < until) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1_000)
          throw new Error('pause expired without SIGKILL')
        }
      },
    })
    if (cli.flags.has('--fixture-derived-probe')) {
      const receipt = db.prepare('SELECT status FROM batch_runs WHERE id=?')
        .get(result.receiptId) as { status: string } | undefined
      if (!receipt) throw new Error('sealed repair receipt is missing')
      if (receipt.status === 'success') {
        console.log(JSON.stringify({ command: 'apply', ...result, derived: 'already_complete' }))
        return
      }
      if (receipt.status !== 'partial') throw new Error(`unexpected repair receipt status: ${receipt.status}`)
      if (failAt === 'during-derived') throw new Error('injected derived failure')
      db.prepare('UPDATE repair_derived_probe SET value=value+1 WHERE id=1').run()
      completeJpOhlcvRepairDerived({
        db,
        receiptId: result.receiptId,
        approvalSha256: result.approvalSha256,
      })
    }
    console.log(JSON.stringify({ command: 'apply', ...result }))
  } finally {
    db.close()
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
