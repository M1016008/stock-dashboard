// scripts/sync-optimized-to-turso.ts
//
// ローカルSQLiteを原本にし、Tursoへは段階的に同期する。
// baseline/backtest/recent はサイト表示を高速化する軽量同期、
// history は全期間OHLCV/ステージ履歴を日付レンジで再開可能に同期する。

import { createClient, type Client, type InValue } from '@libsql/client'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { ensureSchema } from '@/lib/db/migrate'

const LOCAL_DB = path.join(process.cwd(), 'data', 'stockboard.db')
const REMOTE_URL = process.env.TURSO_DATABASE_URL
const REMOTE_TOKEN = process.env.TURSO_AUTH_TOKEN

const OHLCV_DAYS = envInt('TURSO_OHLCV_DAYS', 120, 1)
const SNAPSHOT_DAYS = envInt('TURSO_SNAPSHOT_DAYS', 60, 1)
const INDEX_DAYS = envInt('TURSO_INDEX_DAYS', 120, 1)
const FEATURE_DAYS = envInt('TURSO_FEATURE_DAYS', 60, 1)
const INCLUDE_FEATURES = process.env.TURSO_INCLUDE_FEATURES === '1'
const CHUNK = envInt('TURSO_SYNC_CHUNK', 250, 1)
const DATE_CHUNK = envInt('TURSO_SYNC_DATE_CHUNK', 20, 1)
const DRY_RUN = process.env.TURSO_DRY_RUN === '1'
const FORCE = process.env.TURSO_FORCE === '1'

type SqlArg = string | number | null

type CopySpec = {
  mode: string
  table: string
  label?: string
  partition: 'all' | 'date'
  dateColumn?: string
  latestDates?: number
  where?: string
  args?: SqlArg[]
}

type Partition = {
  key: string
  rangeStart: string | null
  rangeEnd: string | null
  where?: string
  args: SqlArg[]
}

function envInt(name: string, fallback: number, min = 0): number {
  const value = Number(process.env[name] ?? fallback)
  if (!Number.isFinite(value)) return fallback
  return Math.max(min, Math.floor(value))
}

function selectedModes(): Set<string> {
  const raw = process.env.TURSO_SYNC_MODE ?? 'baseline'
  const modes = new Set(raw.split(',').map((mode) => mode.trim()).filter(Boolean))
  if (modes.has('all')) return new Set(['baseline', 'backtest', 'recent', 'history'])
  return modes
}

function redactUrl(url: string): string {
  try {
    const parsed = new URL(url)
    return `${parsed.protocol}//${parsed.hostname}${parsed.pathname}`
  } catch {
    return '<invalid-url>'
  }
}

function runId(): string {
  return `${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}-${crypto.randomBytes(4).toString('hex')}`
}

function quoteIdent(name: string): string {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) throw new Error(`unsafe identifier: ${name}`)
  return name
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

async function columnsOf(table: string): Promise<string[]> {
  const res = await local.execute(`PRAGMA table_info(${quoteIdent(table)})`)
  return res.rows.map((row) => String((row as unknown as { name: string }).name))
}

async function countLocal(table: string, where?: string, args: SqlArg[] = []): Promise<number> {
  const res = await local.execute({
    sql: `SELECT COUNT(*) AS count FROM ${quoteIdent(table)}${where ? ` WHERE ${where}` : ''}`,
    args: args as InValue[],
  })
  return Number((res.rows[0] as unknown as { count: number }).count ?? 0)
}

async function markRun(id: string, mode: string, status: string, summary?: unknown, error?: string): Promise<void> {
  await local.execute({
    sql: `
      INSERT OR REPLACE INTO turso_sync_runs
        (run_id, mode, status, dry_run, started_at, finished_at, summary_json, error_message)
      VALUES (
        ?,
        ?,
        ?,
        ?,
        COALESCE((SELECT started_at FROM turso_sync_runs WHERE run_id = ?), unixepoch()),
        CASE WHEN ? IN ('success', 'failed') THEN unixepoch() ELSE NULL END,
        ?,
        ?
      )
    `,
    args: [
      id,
      mode,
      status,
      DRY_RUN ? 1 : 0,
      id,
      status,
      summary == null ? null : JSON.stringify(summary),
      error ?? null,
    ],
  })
}

async function partitionState(spec: CopySpec, partition: Partition): Promise<{ status: string; row_count: number } | null> {
  const res = await local.execute({
    sql: `
      SELECT status, row_count
      FROM turso_sync_partitions
      WHERE mode = ? AND table_name = ? AND partition_key = ?
    `,
    args: [spec.mode, spec.table, partition.key],
  })
  return res.rows[0] as unknown as { status: string; row_count: number } | undefined ?? null
}

async function markPartition(
  spec: CopySpec,
  partition: Partition,
  id: string,
  status: string,
  rowCount: number,
  error?: string,
): Promise<void> {
  await local.execute({
    sql: `
      INSERT OR REPLACE INTO turso_sync_partitions
        (mode, table_name, partition_key, range_start, range_end, row_count, status, run_id, synced_at, error_message)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, CASE WHEN ? = 'completed' THEN unixepoch() ELSE NULL END, ?)
    `,
    args: [
      spec.mode,
      spec.table,
      partition.key,
      partition.rangeStart,
      partition.rangeEnd,
      rowCount,
      status,
      id,
      status,
      error ?? null,
    ],
  })
}

async function datePartitions(spec: CopySpec): Promise<Partition[]> {
  const dateColumn = quoteIdent(spec.dateColumn ?? 'date')
  const table = quoteIdent(spec.table)
  const dateLimit = spec.latestDates ? `LIMIT ${spec.latestDates}` : ''
  const dateRows = await local.execute(`
    SELECT DISTINCT ${dateColumn} AS date
    FROM ${table}
    ${spec.where ? `WHERE ${spec.where}` : ''}
    ORDER BY ${dateColumn} DESC
    ${dateLimit}
  `)
  const dates = dateRows.rows
    .map((row) => String((row as unknown as { date: string }).date))
    .sort((a, b) => a.localeCompare(b))

  const partitions: Partition[] = []
  for (let i = 0; i < dates.length; i += DATE_CHUNK) {
    const chunk = dates.slice(i, i + DATE_CHUNK)
    const start = chunk[0]
    const end = chunk[chunk.length - 1]
    partitions.push({
      key: `${start}..${end}`,
      rangeStart: start,
      rangeEnd: end,
      where: `${dateColumn} >= ? AND ${dateColumn} <= ?${spec.where ? ` AND (${spec.where})` : ''}`,
      args: [start, end, ...(spec.args ?? [])],
    })
  }
  return partitions
}

async function partitionsFor(spec: CopySpec): Promise<Partition[]> {
  if (spec.partition === 'date') return datePartitions(spec)
  return [{
    key: spec.where ? crypto.createHash('sha1').update(`${spec.where}:${JSON.stringify(spec.args ?? [])}`).digest('hex').slice(0, 12) : 'all',
    rangeStart: null,
    rangeEnd: null,
    where: spec.where,
    args: spec.args ?? [],
  }]
}

async function copyPartition(spec: CopySpec, partition: Partition, id: string): Promise<number> {
  const total = await countLocal(spec.table, partition.where, partition.args)
  const previous = await partitionState(spec, partition)
  if (!FORCE && previous?.status === 'completed' && Number(previous.row_count) === total) {
    console.log(`  - ${spec.label ?? spec.table} ${partition.key}: skip (${total.toLocaleString()} rows)`)
    return 0
  }
  if (total === 0) {
    if (!DRY_RUN) await markPartition(spec, partition, id, 'completed', 0)
    console.log(`  - ${spec.label ?? spec.table} ${partition.key}: 0 rows`)
    return 0
  }
  if (DRY_RUN) {
    console.log(`  - ${spec.label ?? spec.table} ${partition.key}: ${total.toLocaleString()} rows (dry-run)`)
    return total
  }

  const cols = await columnsOf(spec.table)
  const placeholders = cols.map(() => '?').join(', ')
  const insertSql = `INSERT OR REPLACE INTO ${quoteIdent(spec.table)} (${cols.map(quoteIdent).join(', ')}) VALUES (${placeholders})`

  await markPartition(spec, partition, id, 'running', total)
  await remote.execute({
    sql: `DELETE FROM ${quoteIdent(spec.table)}${partition.where ? ` WHERE ${partition.where}` : ''}`,
    args: partition.args as InValue[],
  })

  let inserted = 0
  const orderColumns = spec.partition === 'date'
    ? [spec.dateColumn ?? 'date', cols.includes('ticker') ? 'ticker' : cols[0]]
    : (cols.includes('ticker') ? ['ticker'] : [])
  const orderSql = orderColumns.length > 0
    ? ` ORDER BY ${Array.from(new Set(orderColumns)).map(quoteIdent).join(', ')}`
    : ''
  const selectSql = `SELECT * FROM ${quoteIdent(spec.table)}${partition.where ? ` WHERE ${partition.where}` : ''}${orderSql}`
  const rows = await local.execute({ sql: selectSql, args: partition.args as InValue[] })
  for (let i = 0; i < rows.rows.length; i += CHUNK) {
    const slice = rows.rows.slice(i, i + CHUNK)
    if (slice.length > 0) {
      await remote.batch(slice.map((row) => ({
        sql: insertSql,
        args: cols.map((col) => (row as unknown as Record<string, unknown>)[col] as InValue),
      })))
    }
    inserted += slice.length
    process.stdout.write(`\r  - ${spec.label ?? spec.table} ${partition.key}: ${inserted}/${total}`)
  }
  process.stdout.write('\n')
  await markPartition(spec, partition, id, 'completed', total)
  return inserted
}

async function copySpec(spec: CopySpec, id: string): Promise<number> {
  if (!await tableExists(local, spec.table)) {
    console.log(`  - ${spec.table}: local table missing (skip)`)
    return 0
  }
  const partitions = await partitionsFor(spec)
  let total = 0
  for (const partition of partitions) {
    try {
      total += await copyPartition(spec, partition, id)
    } catch (error) {
      if (!DRY_RUN) {
        const count = await countLocal(spec.table, partition.where, partition.args).catch(() => 0)
        await markPartition(spec, partition, id, 'failed', count, (error as Error).message)
      }
      throw error
    }
  }
  return total
}

function specsFor(modes: Set<string>): CopySpec[] {
  const specs: CopySpec[] = []
  const hasHistory = modes.has('history')

  if (modes.has('baseline')) {
    specs.push(
      { mode: 'baseline', table: 'ticker_universe', partition: 'all' },
      { mode: 'baseline', table: 'sector_master', partition: 'all' },
      { mode: 'baseline', table: 'stock_classification', partition: 'all' },
      { mode: 'baseline', table: 'jquants_daily_coverage', partition: 'all' },
      { mode: 'baseline', table: 'dashboard_cache', partition: 'all' },
      { mode: 'baseline', table: 'pattern_stats', partition: 'all', where: 'count >= 40', label: 'pattern_stats N>=40' },
      { mode: 'baseline', table: 'weekly_margin_interest', partition: 'date', dateColumn: 'date', latestDates: 180 },
      { mode: 'baseline', table: 'short_selling_positions', partition: 'date', dateColumn: 'date', latestDates: 180 },
      { mode: 'baseline', table: 'earnings_calendar', partition: 'date', dateColumn: 'announce_date', latestDates: 240 },
      { mode: 'baseline', table: 'serving_stock_metrics', partition: 'all' },
      { mode: 'baseline', table: 'serving_stock_move_periods', partition: 'all' },
    )
  }

  if (modes.has('backtest')) {
    specs.push(
      { mode: 'backtest', table: 'serving_latest_signals', partition: 'date', dateColumn: 'date' },
      { mode: 'backtest', table: 'serving_signal_stats', partition: 'all' },
      { mode: 'backtest', table: 'serving_backtest_dates', partition: 'all' },
      { mode: 'backtest', table: 'serving_backtest_summaries', partition: 'date', dateColumn: 'date' },
      { mode: 'backtest', table: 'serving_backtest_results', partition: 'date', dateColumn: 'date' },
      { mode: 'backtest', table: 'serving_backtest_details', partition: 'date', dateColumn: 'date' },
      { mode: 'backtest', table: 'serving_signal_evidence', partition: 'date', dateColumn: 'date' },
      { mode: 'backtest', table: 'serving_similar_cases', partition: 'date', dateColumn: 'source_date' },
    )
  }

  if (modes.has('recent')) {
    specs.push(
      { mode: 'recent', table: 'indices_daily', partition: 'date', dateColumn: 'date', latestDates: INDEX_DAYS, label: `indices_daily latest ${INDEX_DAYS} dates` },
    )
    if (!hasHistory) {
      specs.push(
        { mode: 'recent', table: 'ohlcv_daily', partition: 'date', dateColumn: 'date', latestDates: OHLCV_DAYS, label: `ohlcv_daily latest ${OHLCV_DAYS} dates` },
        { mode: 'recent', table: 'daily_snapshots', partition: 'date', dateColumn: 'date', latestDates: SNAPSHOT_DAYS, label: `daily_snapshots latest ${SNAPSHOT_DAYS} dates` },
      )
    }
    if (INCLUDE_FEATURES) {
      specs.push({ mode: 'recent', table: 'feature_snapshots', partition: 'date', dateColumn: 'date', latestDates: FEATURE_DAYS, label: `feature_snapshots latest ${FEATURE_DAYS} dates` })
    }
  }

  if (hasHistory) {
    specs.push(
      { mode: 'history', table: 'ohlcv_daily', partition: 'date', dateColumn: 'date', label: 'ohlcv_daily full history' },
      { mode: 'history', table: 'daily_snapshots', partition: 'date', dateColumn: 'date', label: 'daily_snapshots full history' },
    )
  }

  return specs
}

async function main() {
  const modes = selectedModes()
  const id = runId()
  const modeLabel = Array.from(modes).join(',')
  console.log('Turso optimized staged sync')
  console.log(`  from: ${LOCAL_DB}`)
  console.log(`  to:   ${redactUrl(REMOTE_URL!)}`)
  console.log(`  mode=${modeLabel}, date_chunk=${DATE_CHUNK}, row_chunk=${CHUNK}`)
  if (DRY_RUN) console.log('  mode=dry-run (no remote writes)')
  console.log('---')

  await ensureSchema(local)
  if (!DRY_RUN) {
    await ensureSchema(remote)
    await markRun(id, modeLabel, 'running')
  }

  const specs = specsFor(modes)
  let total = 0
  try {
    for (const spec of specs) {
      total += await copySpec(spec, id)
    }
    if (!DRY_RUN) await markRun(id, modeLabel, 'success', { syncedRows: total, specs: specs.length })
  } catch (error) {
    if (!DRY_RUN) await markRun(id, modeLabel, 'failed', { syncedRows: total }, (error as Error).message)
    throw error
  }

  console.log('---')
  console.log(DRY_RUN
    ? `完了: ${total.toLocaleString()} rows would be synced to Turso`
    : `完了: ${total.toLocaleString()} rows synced to Turso`)
  console.log('容量対策: 重い生成用テーブルはローカル原本を維持し、Tursoはserving_*と必要な履歴を段階同期します。')
}

main().catch((err) => {
  console.error('optimized Turso sync failed:', err)
  process.exit(1)
})
