import { createHash } from 'node:crypto'
import { copyFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
// @ts-expect-error The pinned Node types predate Node 24's built-in SQLite module.
import { DatabaseSync } from 'node:sqlite'
import { assertWritableTargetPath } from '@/lib/storage/external-storage-guard'
import { priceUpdateCompleted } from '@/lib/server/large-holders/current-fingerprint'

const options = new Map(process.argv.slice(2).map((arg) => {
  const [key, ...value] = arg.split('=')
  return [key, value.join('=')]
}))
const sourcePath = resolve(options.get('--source') ?? '')
const targetPath = resolve(options.get('--target') ?? '')
const priceSourcePath = resolve(options.get('--price-source') ?? sourcePath)
const sourceEvidence = options.get('--source-evidence') ?? ''
const sourceSnapshot = options.get('--source-snapshot') ?? ''
if (!options.get('--source') || !options.get('--target') || !sourceEvidence || !sourceSnapshot
  || sourcePath === targetPath || !targetPath.includes('/stock-dashboard/qa/phase16d-shadow/')
  || priceSourcePath === targetPath || targetPath === process.env.STOCKBOARD_DB_PATH || existsSync(targetPath)
  || resolve(sourceEvidence).startsWith(dirname(targetPath))
  || resolve(sourceSnapshot).startsWith(dirname(targetPath))) {
  throw new Error('shadow_source_target_or_artifact_invalid')
}

const tables = [
  'large_holder_edinet_code_bridge', 'large_holder_filings', 'large_holder_groups',
  'large_holder_instrument_master', 'large_holder_issuer_capital_structure',
  'large_holder_position_certifications', 'large_holder_positions',
  'large_holder_price_evidence', 'large_holder_source_documents',
  'investor_entities', 'investor_aliases', 'investor_identity_reviews',
  'ticker_universe', 'historical_universe', 'batch_runs', 'jquants_daily_coverage', 'jquants_sync_runs',
  'update_locks', 'ohlcv_daily',
]
const priceSignalTables = new Set(['batch_runs', 'jquants_daily_coverage', 'jquants_sync_runs'])

function hashRows(db: DatabaseSync, table: string) {
  const hash = createHash('sha256')
  let count = 0
  for (const row of db.prepare(`SELECT * FROM "${table}" ORDER BY rowid`).iterate()) {
    hash.update(JSON.stringify(row)).update('\n')
    count++
  }
  return { count, sha256: hash.digest('hex') }
}

async function main() {
  assertWritableTargetPath(targetPath, 'phase16d_shadow_seed')
  await mkdir(dirname(targetPath), { recursive: true, mode: 0o700 })
  const source = new DatabaseSync(sourcePath, { readOnly: true })
  source.exec('PRAGMA query_only=ON')
  const priceSource = priceSourcePath === sourcePath
    ? source
    : new DatabaseSync(priceSourcePath, { readOnly: true })
  if (priceSource !== source) priceSource.exec('PRAGMA query_only=ON')
  const shadow = new DatabaseSync(targetPath)
  let shadowClosed = false
  shadow.exec('PRAGMA foreign_keys=OFF')
  const report: Record<string, { count: number; sha256: string }> = {}
  try {
    for (const table of tables) {
      const schema = source.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?")
        .get(table) as { sql: string } | undefined
      if (!schema?.sql) throw new Error(`shadow_missing_source_table:${table}`)
      shadow.exec(schema.sql)
    }
    shadow.exec('BEGIN IMMEDIATE')
    try {
      for (const table of tables.filter((name) => name !== 'update_locks' && name !== 'ohlcv_daily')) {
        const columns = (source.prepare(`PRAGMA table_info("${table}")`).all() as { name: string }[])
          .map((row) => row.name)
        const insert = shadow.prepare(`INSERT INTO "${table}" (${columns.map((name) => `"${name}"`).join(',')})
          VALUES (${columns.map(() => '?').join(',')})`)
        for (const row of source.prepare(`SELECT * FROM "${table}"`).iterate() as Iterable<Record<string, unknown>>) {
          insert.run(...columns.map((name) => row[name]))
        }
      }
      if (priceSource !== source) for (const table of priceSignalTables) {
        const columns = (priceSource.prepare(`PRAGMA table_info("${table}")`).all() as { name: string }[])
          .map((row) => row.name)
        const insert = shadow.prepare(`INSERT OR IGNORE INTO "${table}" (${columns.map((name) => `"${name}"`).join(',')})
          VALUES (${columns.map(() => '?').join(',')})`)
        for (const row of priceSource.prepare(`SELECT * FROM "${table}"`).iterate() as Iterable<Record<string, unknown>>)
          insert.run(...columns.map((name) => row[name]))
      }
      const tickers = (source.prepare('SELECT DISTINCT ticker FROM large_holder_positions WHERE ticker IS NOT NULL')
        .all() as { ticker: string }[]).map((row) => row.ticker)
      const maxDate = (priceSource.prepare('SELECT MAX(date) date FROM ohlcv_daily').get() as { date: string }).date
      if (!priceUpdateCompleted(priceSource, maxDate)) throw new Error('shadow_price_source_not_completed')
      const columns = (source.prepare('PRAGMA table_info("ohlcv_daily")').all() as { name: string }[])
        .map((row) => row.name)
      const insert = shadow.prepare(`INSERT OR IGNORE INTO ohlcv_daily (${columns.map((name) => `"${name}"`).join(',')})
        VALUES (${columns.map(() => '?').join(',')})`)
      for (const row of source.prepare('SELECT * FROM ohlcv_daily WHERE date=?').iterate(maxDate) as Iterable<Record<string, unknown>>)
        insert.run(...columns.map((name) => row[name]))
      const byTicker = source.prepare('SELECT * FROM ohlcv_daily WHERE ticker=?')
      for (const ticker of tickers) for (const row of byTicker.iterate(ticker) as Iterable<Record<string, unknown>>)
        insert.run(...columns.map((name) => row[name]))
      for (const row of priceSource.prepare('SELECT * FROM ohlcv_daily WHERE date=?')
        .iterate(maxDate) as Iterable<Record<string, unknown>>)
        insert.run(...columns.map((name) => row[name]))
      shadow.exec('COMMIT')
    } catch (error) { shadow.exec('ROLLBACK'); throw error }
    for (const table of tables) for (const index of source.prepare(
      "SELECT sql FROM sqlite_master WHERE type='index' AND tbl_name=? AND sql IS NOT NULL",
    ).all(table) as { sql: string }[]) shadow.exec(index.sql)
    const integrity = shadow.prepare('PRAGMA quick_check').all() as { quick_check: string }[]
    if (integrity.length !== 1 || integrity[0].quick_check !== 'ok')
      throw new Error('shadow_seed_integrity_failed')
    for (const table of tables.filter((name) => name !== 'ohlcv_daily' && name !== 'update_locks')) {
      const before = hashRows(source, table), after = hashRows(shadow, table)
      if (!(priceSource !== source && priceSignalTables.has(table))
        && (before.count !== after.count || before.sha256 !== after.sha256))
        throw new Error(`shadow_seed_mismatch:${table}`)
      report[table] = after
    }
    const marketDate = (priceSource.prepare('SELECT MAX(date) date FROM ohlcv_daily').get() as { date: string }).date
    const latestSource = priceSource.prepare('SELECT * FROM ohlcv_daily WHERE date=? ORDER BY ticker').all(marketDate)
    const latestShadow = shadow.prepare('SELECT * FROM ohlcv_daily WHERE date=? ORDER BY ticker').all(marketDate)
    if (JSON.stringify(latestSource) !== JSON.stringify(latestShadow)) throw new Error('shadow_latest_price_mismatch')
    if (!priceUpdateCompleted(shadow, marketDate)) throw new Error('shadow_price_completion_proof_mismatch')
    const evidenceTarget = join(dirname(targetPath), 'evidence')
    await mkdir(join(evidenceTarget, 'manifests'), { recursive: true, mode: 0o700 })
    await mkdir(join(evidenceTarget, 'rankings'), { recursive: true, mode: 0o700 })
    await copyFile(sourceSnapshot, join(evidenceTarget, 'rankings', sourceSnapshot.split('/').at(-1)!))
    const manifest = JSON.parse(await readFile(sourceSnapshot, 'utf8')) as {
      manifestSha256: string; activityEvidenceManifestSha256: string | null }
    await copyFile(join(sourceEvidence, 'manifests', `${manifest.manifestSha256}.json`),
      join(evidenceTarget, 'manifests', `${manifest.manifestSha256}.json`))
    if (manifest.activityEvidenceManifestSha256) {
      await mkdir(join(evidenceTarget, 'activity-manifests'), { recursive: true, mode: 0o700 })
      await copyFile(join(sourceEvidence, 'activity-manifests', `${manifest.activityEvidenceManifestSha256}.json`),
        join(evidenceTarget, 'activity-manifests', `${manifest.activityEvidenceManifestSha256}.json`))
    }
    shadow.close()
    shadowClosed = true
    const reopened = new DatabaseSync(targetPath, { readOnly: true })
    try {
      reopened.exec('PRAGMA query_only=ON')
      const check = reopened.prepare('PRAGMA integrity_check').all() as { integrity_check: string }[]
      if (check.length !== 1 || check[0].integrity_check !== 'ok')
        throw new Error('shadow_seed_post_close_integrity_failed')
    } finally { reopened.close() }
    const summary = { shadowDb: targetPath, shadowEvidence: evidenceTarget,
      baselineSnapshot: join(evidenceTarget, 'rankings', sourceSnapshot.split('/').at(-1)!),
      sourceMode: 'read-only', priceSource: priceSourcePath, officialPriceCompletion: true,
      backup: false, latestPriceDate: marketDate,
      latestPriceRows: latestShadow.length, tables: report,
      shadowDbBytes: (await stat(targetPath)).size }
    await writeFile(join(dirname(targetPath), 'seed-report.json'), `${JSON.stringify(summary, null, 2)}\n`, { mode: 0o600 })
    console.log(JSON.stringify(summary))
  } finally {
    if (!shadowClosed) shadow.close()
    if (priceSource !== source) priceSource.close()
    source.close()
  }
}

void main().catch((error) => { console.error(error); process.exitCode = 1 })
