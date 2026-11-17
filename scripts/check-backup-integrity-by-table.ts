/**
 * integrity_check of a published weekly backup copy, one table at a time, resumable across nights.
 *
 * The weekly run checks the snapshot with quick_check only (B-tree structure, free list, page use).
 * What quick_check leaves out is the comparison of each index with its table (and UNIQUE); that is
 * `PRAGMA integrity_check(<table>)`, which checks one table with its indexes. Running it per table lets
 * the check be split over several nights. It reads the copy on the backup drive, never production.
 *
 *   npx tsx scripts/check-backup-integrity-by-table.ts --generation=<dir with COMPLETE.manifest.json>
 *     --market=JP|US --report=<new or existing .jsonl outside the generation>
 *     [--stop-starting-after=<ISO time>] [--sqlite=<sqlite3 binary>]
 *
 * The copy is opened read-only and immutable, so SQLite creates no -wal/-shm beside it. The first run
 * hashes the copy and records its identity; later runs require the same identity, and the run that
 * finishes the last table hashes it again before it writes the `complete` line.
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileSha256 } from '@/lib/storage/sqlite-rsync-generation'

type Line =
  | { kind: 'start'; database: string; sha256: string; bytes: number; ino: number; mtimeMs: number; at: string }
  | { kind: 'table'; table: string; result: string; startedAt: string; finishedAt: string }
  | { kind: 'complete'; ok: boolean; tables: number; failed: string[]; sha256: string; at: string }

const DATABASE_NAMES = { JP: 'stockboard.db', US: 'stockboard-us.db' } as const

export function checkBackupIntegrityByTable(args: {
  generation: string
  market: 'JP' | 'US'
  report: string
  sqlite: string
  stopStartingAfterMs?: number
  log?: (message: string) => void
}): { done: number; remaining: number; failed: string[]; complete: boolean } {
  const log = args.log ?? console.log
  const generation = fs.realpathSync(args.generation)
  const report = path.join(fs.realpathSync(path.dirname(path.resolve(args.report))), path.basename(args.report))
  if (report === generation || report.startsWith(`${generation}${path.sep}`)) throw new Error('REPORT_INSIDE_GENERATION')
  const manifest = JSON.parse(fs.readFileSync(path.join(generation, 'COMPLETE.manifest.json'), 'utf8'))
  if (manifest.status !== 'VERIFIED' || !manifest.markets?.[args.market]) throw new Error('GENERATION_NOT_VERIFIED')
  const expectedSha256: string = manifest.markets[args.market].databaseSha256
  const database = path.join(generation, args.market, DATABASE_NAMES[args.market])
  const stat = fs.statSync(database)
  const lines: Line[] = fs.existsSync(report)
    ? fs.readFileSync(report, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line))
    : []
  const append = (line: Line) => {
    const descriptor = fs.openSync(report, 'a', 0o600)
    try { fs.writeSync(descriptor, `${JSON.stringify(line)}\n`); fs.fsyncSync(descriptor) } finally { fs.closeSync(descriptor) }
    lines.push(line)
  }
  const start = lines.find((line) => line.kind === 'start')
  if (!start) {
    log(`hashing ${database}`)
    const sha256 = fileSha256(database)
    if (sha256 !== expectedSha256) throw new Error('DATABASE_SHA256_MISMATCH')
    append({ kind: 'start', database, sha256, bytes: stat.size, ino: stat.ino, mtimeMs: stat.mtimeMs, at: new Date().toISOString() })
  } else if (start.database !== database || start.sha256 !== expectedSha256 || start.bytes !== stat.size
    || start.ino !== stat.ino || start.mtimeMs !== stat.mtimeMs) {
    throw new Error('DATABASE_CHANGED_SINCE_FIRST_RUN')
  }
  if (lines.some((line) => line.kind === 'complete')) throw new Error('REPORT_ALREADY_COMPLETE')

  const uri = `file:${database.split(path.sep).map(encodeURIComponent).join('/')}?immutable=1`
  const run = (sql: string) => {
    const result = spawnSync(args.sqlite, ['-readonly', uri, sql], { encoding: 'utf8', maxBuffer: 64_000_000 })
    if (result.error || result.status !== 0) throw new Error(`SQLITE_FAILED:${result.status}:${result.error?.message ?? result.stderr.trim()}`)
    return result.stdout.trim()
  }
  const tables = ['sqlite_schema', ...run("SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name;")
    .split('\n').filter(Boolean)]
  const checked = new Map(lines.flatMap((line) => (line.kind === 'table' ? [[line.table, line.result] as const] : [])))
  for (const table of tables) {
    if (checked.has(table)) continue
    if (args.stopStartingAfterMs !== undefined && Date.now() >= args.stopStartingAfterMs) break
    const startedAt = new Date().toISOString()
    log(`${startedAt} integrity_check(${table})`)
    const result = run(`PRAGMA integrity_check("${table.replaceAll('"', '""')}");`).slice(0, 10_000)
    append({ kind: 'table', table, result, startedAt, finishedAt: new Date().toISOString() })
    checked.set(table, result)
  }
  const failed = [...checked].filter(([, result]) => result !== 'ok').map(([table]) => table)
  const remaining = tables.filter((table) => !checked.has(table)).length
  if (remaining > 0) return { done: checked.size, remaining, failed, complete: false }
  log(`hashing ${database} again`)
  const sha256 = fileSha256(database)
  append({ kind: 'complete', ok: failed.length === 0 && sha256 === expectedSha256, tables: tables.length, failed, sha256, at: new Date().toISOString() })
  return { done: checked.size, remaining: 0, failed, complete: true }
}

if (require.main === module) {
  const option = (name: string) => process.argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3)
  const market = option('market')
  if (market !== 'JP' && market !== 'US') throw new Error('MARKET_REQUIRED')
  const stop = option('stop-starting-after')
  if (stop !== undefined && Number.isNaN(Date.parse(stop))) throw new Error('STOP_STARTING_AFTER_INVALID')
  const result = checkBackupIntegrityByTable({
    generation: option('generation') ?? '',
    market,
    report: option('report') ?? '',
    sqlite: option('sqlite') ?? '/Volumes/OWC Express 1M2 80G/StockBoard Development/tools/sqlite-3.54.1/sqlite3',
    stopStartingAfterMs: stop === undefined ? undefined : Date.parse(stop),
  })
  console.log(JSON.stringify(result))
  if (result.failed.length > 0) process.exitCode = 1
}
