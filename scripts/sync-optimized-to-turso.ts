// scripts/sync-optimized-to-turso.ts
//
// ローカルSQLiteの巨大データをそのままTursoへ送らず、サイト表示に必要な
// 最新・直近・集計済みデータへ絞って同期する。

import { createClient, type Client } from '@libsql/client'
import fs from 'node:fs'
import path from 'node:path'
import { ensureSchema } from '@/lib/db/migrate'

const LOCAL_DB = path.join(process.cwd(), 'data', 'stockboard.db')
const REMOTE_URL = process.env.TURSO_DATABASE_URL
const REMOTE_TOKEN = process.env.TURSO_AUTH_TOKEN

const OHLCV_DAYS = Number(process.env.TURSO_OHLCV_DAYS ?? 120)
const SNAPSHOT_DAYS = Number(process.env.TURSO_SNAPSHOT_DAYS ?? 60)
const INDEX_DAYS = Number(process.env.TURSO_INDEX_DAYS ?? 120)
const INCLUDE_FEATURES = process.env.TURSO_INCLUDE_FEATURES === '1'
const FEATURE_DAYS = Number(process.env.TURSO_FEATURE_DAYS ?? 60)
const CHUNK = Number(process.env.TURSO_SYNC_CHUNK ?? 200)
const DRY_RUN = process.env.TURSO_DRY_RUN === '1'

type CopySpec = {
  table: string
  where?: string
  args?: Array<string | number>
  label?: string
}

if (!REMOTE_URL) {
  console.error('TURSO_DATABASE_URL が未設定です。.env.local に設定してください。')
  process.exit(1)
}
if (!fs.existsSync(LOCAL_DB)) {
  console.error(`ローカル DB が見つかりません: ${LOCAL_DB}`)
  process.exit(1)
}

const local = createClient({ url: `file:${LOCAL_DB}` })
const remote = createClient({ url: REMOTE_URL, authToken: REMOTE_TOKEN })

async function tableExists(client: Client, table: string): Promise<boolean> {
  const res = await client.execute({
    sql: `SELECT name FROM sqlite_master WHERE type='table' AND name = ?`,
    args: [table],
  })
  return res.rows.length > 0
}

async function copyTable(spec: CopySpec): Promise<number> {
  if (!await tableExists(local, spec.table)) {
    console.log(`  - ${spec.table}: local table missing (skip)`)
    return 0
  }

  const whereClause = spec.where ? ` WHERE ${spec.where}` : ''
  const countRows = await local.execute({
    sql: `SELECT COUNT(*) AS count FROM ${spec.table}${whereClause}`,
    args: spec.args ?? [],
  })
  const total = Number((countRows.rows[0] as unknown as { count: number }).count ?? 0)
  if (total === 0) {
    console.log(`  - ${spec.label ?? spec.table}: 0 rows`)
    return 0
  }
  if (DRY_RUN) {
    console.log(`  - ${spec.label ?? spec.table}: ${total.toLocaleString()} rows (dry-run)`)
    return total
  }

  const columnRows = await local.execute(`PRAGMA table_info(${spec.table})`)
  const cols = columnRows.rows.map((row) => String((row as unknown as { name: string }).name))
  const placeholders = cols.map(() => '?').join(', ')
  const insertSql = `INSERT OR REPLACE INTO ${spec.table} (${cols.join(', ')}) VALUES (${placeholders})`

  let inserted = 0
  for (let offset = 0; offset < total; offset += CHUNK) {
    const rows = await local.execute({
      sql: `SELECT * FROM ${spec.table}${whereClause} LIMIT ? OFFSET ?`,
      args: [...(spec.args ?? []), CHUNK, offset],
    })
    await remote.batch(
      rows.rows.map((row) => ({
        sql: insertSql,
        args: cols.map((col) => (row as unknown as Record<string, unknown>)[col]) as never[],
      })),
    )
    inserted += rows.rows.length
    process.stdout.write(`\r  - ${spec.label ?? spec.table}: ${inserted}/${total}`)
  }
  process.stdout.write('\n')
  return inserted
}

function recentDateWhere(table: string, days: number): string {
  return `date IN (SELECT date FROM (SELECT DISTINCT date FROM ${table} ORDER BY date DESC LIMIT ${days}))`
}

async function main() {
  console.log(`Turso optimized sync`)
  console.log(`  from: ${LOCAL_DB}`)
  console.log(`  to:   ${REMOTE_URL}`)
  console.log(`  ohlcv_days=${OHLCV_DAYS}, snapshot_days=${SNAPSHOT_DAYS}, include_features=${INCLUDE_FEATURES}`)
  if (DRY_RUN) console.log('  mode=dry-run (no remote writes)')
  console.log('---')

  if (!DRY_RUN) await ensureSchema(remote)

  const specs: CopySpec[] = [
    { table: 'ticker_universe' },
    { table: 'sector_master' },
    { table: 'stock_classification' },
    { table: 'jquants_daily_coverage' },
    { table: 'dashboard_cache' },
    { table: 'indices_daily', where: recentDateWhere('indices_daily', INDEX_DAYS), label: `indices_daily latest ${INDEX_DAYS} dates` },
    { table: 'ohlcv_daily', where: recentDateWhere('ohlcv_daily', OHLCV_DAYS), label: `ohlcv_daily latest ${OHLCV_DAYS} dates` },
    { table: 'daily_snapshots', where: recentDateWhere('daily_snapshots', SNAPSHOT_DAYS), label: `daily_snapshots latest ${SNAPSHOT_DAYS} dates` },
    { table: 'pattern_stats', where: 'count >= 40', label: 'pattern_stats N>=40' },
    { table: 'weekly_margin_interest' },
    { table: 'short_selling_positions' },
    { table: 'earnings_calendar' },
  ]

  if (INCLUDE_FEATURES) {
    specs.push({
      table: 'feature_snapshots',
      where: recentDateWhere('feature_snapshots', FEATURE_DAYS),
      label: `feature_snapshots latest ${FEATURE_DAYS} dates`,
    })
  }

  let total = 0
  for (const spec of specs) {
    total += await copyTable(spec)
  }

  console.log('---')
  console.log(DRY_RUN
    ? `完了: ${total.toLocaleString()} rows would be synced to Turso`
    : `完了: ${total.toLocaleString()} rows synced to Turso`)
  console.log('容量対策: forward_returns と full feature_snapshots はデフォルト除外。必要な統計は pattern_stats/dashboard_cache を利用します。')
}

main().catch((err) => {
  console.error('optimized Turso sync failed:', err)
  process.exit(1)
})
