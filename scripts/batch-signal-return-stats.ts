// scripts/batch-signal-return-stats.ts
//
// シグナル発生後 1週/2週/3週の上昇割合・下落割合・中央値騰落率を作る。
// 画面表示はこの軽量テーブルを優先し、重いJOINをリクエスト時に走らせない。

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { execAll, execBatch, execRun, localDbPath } from '@/lib/db/client'

type TargetDateRow = { date: string }
type ReturnRow = {
  signal_code: string
  horizon_days: number
  return_pct: number
}

type Accumulator = {
  signalCode: string
  horizonDays: number
  count: number
  upCount: number
  downCount: number
  sum: number
  values: number[]
}

const DEFAULT_HORIZONS = [5, 10, 15]
const INSERT_CHUNK = 200

function envInt(name: string, fallback: number, min = 0): number {
  const value = Number(process.env[name] ?? fallback)
  if (!Number.isFinite(value)) return fallback
  return Math.max(min, Math.floor(value))
}

function parseHorizons(): number[] {
  const raw = process.env.SIGNAL_RETURN_HORIZONS ?? DEFAULT_HORIZONS.join(',')
  const horizons = [...new Set(
    raw
      .split(',')
      .map((part) => Number(part.trim()))
      .filter((value) => Number.isInteger(value) && value > 0),
  )].sort((a, b) => a - b)
  return horizons.length > 0 ? horizons : DEFAULT_HORIZONS
}

const HORIZONS = parseHorizons()
const RECENT_DAYS = envInt('BACKTEST_RECENT_DAYS', 0, 0)
const DATE_CHUNK = envInt('SIGNAL_RETURN_DATE_CHUNK', 10, 1)
const MIN_N = envInt('SIGNAL_RETURN_MIN_N', 20, 1)
const NATIVE_PARALLEL = envInt('SIGNAL_RETURN_NATIVE_PARALLEL', 0, 0)
// Counts/rates/means always use every row. Full-history median sorting is the
// exceptional expensive part, so use a stable rowid sample unless overridden.
const MEDIAN_SAMPLE_MOD = envInt(
  'SIGNAL_RETURN_MEDIAN_SAMPLE_MOD',
  RECENT_DAYS === 0 ? 10 : 1,
  1,
)
const prevDateByDate = new Map<string, string | null>()

type NativeReturnStatRow = {
  signal_code: string
  horizon_days: number
  count: number
  up_rate: number | null
  down_rate: number | null
  median_return_pct: number | null
  median_sample_count: number
  avg_return_pct: number | null
}

function keyFor(signalCode: string, horizonDays: number): string {
  return `${signalCode}\t${horizonDays}`
}

function median(values: number[]): number | null {
  if (values.length === 0) return null
  values.sort((a, b) => a - b)
  const mid = Math.floor(values.length / 2)
  if (values.length % 2 === 1) return values[mid]
  return (values[mid - 1] + values[mid]) / 2
}

async function loadTargetDates(): Promise<string[]> {
  const limitSql = RECENT_DAYS > 0 ? `LIMIT ?` : ''
  const args = RECENT_DAYS > 0 ? [RECENT_DAYS] : []
  const rows = await execAll<TargetDateRow>(
    `
    SELECT date
    FROM (
      SELECT DISTINCT date
      FROM technical_signals
      ORDER BY date DESC
      ${limitSql}
    )
    ORDER BY date DESC
    `,
    args,
  )
  return rows.map((row) => row.date)
}

async function loadPrevDates(targetDates: string[]): Promise<void> {
  prevDateByDate.clear()
  if (targetDates.length === 0) return
  const maxDate = targetDates.reduce((max, date) => date > max ? date : max, targetDates[0])
  const minDate = targetDates.reduce((min, date) => date < min ? date : min, targetDates[0])
  const rows = await execAll<TargetDateRow>(
    `
    SELECT DISTINCT date
    FROM daily_snapshots
    WHERE date <= ?
      AND date >= (
        SELECT COALESCE(MAX(date), ?)
        FROM daily_snapshots
        WHERE date < ?
      )
    ORDER BY date ASC
    `,
    [maxDate, minDate, minDate],
  )
  let prev: string | null = null
  const targetSet = new Set(targetDates)
  for (const row of rows) {
    if (targetSet.has(row.date)) prevDateByDate.set(row.date, prev)
    prev = row.date
  }
}

async function loadChunkReturns(dates: string[]): Promise<ReturnRow[]> {
  if (dates.length === 0) return []
  const horizonPlaceholders = HORIZONS.map(() => '?').join(', ')
  const selectedValues = dates.map(() => '(?, ?)').join(', ')
  const selectedArgs = dates.flatMap((date) => [date, prevDateByDate.get(date) ?? null])
  return execAll<ReturnRow>(
    `
    WITH selected_dates(date, prev_date) AS (
      VALUES ${selectedValues}
    ),
    signal_starts AS (
      SELECT ts.ticker, ts.date, ts.signal_code
      FROM technical_signals ts
      JOIN selected_dates sd ON sd.date = ts.date
      WHERE NOT EXISTS (
        SELECT 1
        FROM technical_signals prev INDEXED BY tech_signal_ticker_code_date_idx
        WHERE prev.ticker = ts.ticker
          AND prev.signal_code = ts.signal_code
          AND prev.date = sd.prev_date
      )
      GROUP BY ts.ticker, ts.date, ts.signal_code
    )
    SELECT ss.signal_code, fr.horizon_days, fr.return_pct
    FROM signal_starts ss
    INNER JOIN forward_returns fr INDEXED BY sqlite_autoindex_forward_returns_1
      ON fr.ticker = ss.ticker
     AND fr.date = ss.date
     AND fr.horizon_days IN (${horizonPlaceholders})
    WHERE fr.return_pct IS NOT NULL
    `,
    [...selectedArgs, ...HORIZONS],
  )
}

function addRows(accumulators: Map<string, Accumulator>, rows: ReturnRow[]): void {
  for (const row of rows) {
    const returnPct = Number(row.return_pct)
    const horizonDays = Number(row.horizon_days)
    if (!Number.isFinite(returnPct) || !Number.isFinite(horizonDays)) continue
    const key = keyFor(row.signal_code, horizonDays)
    const acc = accumulators.get(key) ?? {
      signalCode: row.signal_code,
      horizonDays,
      count: 0,
      upCount: 0,
      downCount: 0,
      sum: 0,
      values: [],
    }
    acc.count += 1
    acc.sum += returnPct
    if (returnPct > 0) acc.upCount += 1
    if (returnPct < 0) acc.downCount += 1
    acc.values.push(returnPct)
    accumulators.set(key, acc)
  }
}

async function insertRows(accumulators: Map<string, Accumulator>): Promise<number> {
  const rows = Array.from(accumulators.values())
    .filter((row) => row.count >= MIN_N)
    .sort((a, b) => a.signalCode.localeCompare(b.signalCode) || a.horizonDays - b.horizonDays)
    .map((row) => ({
      signalCode: row.signalCode,
      horizonDays: row.horizonDays,
      count: row.count,
      upRate: row.upCount / row.count,
      downRate: row.downCount / row.count,
      medianReturnPct: median(row.values),
      avgReturnPct: row.sum / row.count,
    }))

  for (let i = 0; i < rows.length; i += INSERT_CHUNK) {
    await execBatch(rows.slice(i, i + INSERT_CHUNK).map((row) => ({
      sql: `
        INSERT OR REPLACE INTO signal_return_stats
          (signal_code, horizon_days, count, up_rate, down_rate, median_return_pct, avg_return_pct, computed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, unixepoch())
      `,
      args: [
        row.signalCode,
        row.horizonDays,
        row.count,
        row.upRate,
        row.downRate,
        row.medianReturnPct,
        row.avgReturnPct,
      ],
    })))
  }

  return rows.length
}

function nativeReturnAggregateSql(): string {
  const horizonList = HORIZONS.join(', ')
  const recentDateFilter = RECENT_DAYS > 0 ? `WHERE recent_rank <= ${RECENT_DAYS}` : ''
  const medianValue = MEDIAN_SAMPLE_MOD === 1
    ? 'fr.return_pct'
    : `CASE WHEN (ss.sample_key % ${MEDIAN_SAMPLE_MOD}) = 0 THEN fr.return_pct END`
  return `
    PRAGMA temp_store=FILE;
    PRAGMA cache_size=-32768;
    WITH market_dates AS MATERIALIZED (
      SELECT date, prev_date
      FROM (
        SELECT
          date,
          LAG(date) OVER (ORDER BY date) AS prev_date,
          ROW_NUMBER() OVER (ORDER BY date DESC) AS recent_rank
        FROM (SELECT date FROM daily_snapshots GROUP BY date)
      )
      ${recentDateFilter}
    ),
    ordered_signals AS (
      SELECT
        ticker,
        date,
        signal_code,
        rowid AS sample_key,
        LAG(date) OVER (
          PARTITION BY ticker, signal_code
          ORDER BY date, rowid
        ) AS previous_signal_date
      FROM technical_signals INDEXED BY tech_signal_ticker_code_date_idx
    )
    SELECT
      ss.signal_code,
      fr.horizon_days,
      COUNT(*) AS count,
      AVG(CASE WHEN fr.return_pct > 0 THEN 1.0 ELSE 0.0 END) AS up_rate,
      AVG(CASE WHEN fr.return_pct < 0 THEN 1.0 ELSE 0.0 END) AS down_rate,
      COALESCE(median(${medianValue}), AVG(fr.return_pct)) AS median_return_pct,
      COUNT(${medianValue}) AS median_sample_count,
      AVG(fr.return_pct) AS avg_return_pct
    FROM ordered_signals ss
    CROSS JOIN market_dates md
    INNER JOIN forward_returns fr INDEXED BY sqlite_autoindex_forward_returns_1
     ON fr.ticker = ss.ticker
     AND fr.date = ss.date
     AND fr.horizon_days IN (${horizonList})
    WHERE md.date = ss.date
      AND (ss.previous_signal_date IS NULL OR ss.previous_signal_date <> ss.date)
      AND (ss.previous_signal_date IS NULL OR ss.previous_signal_date <> md.prev_date)
      AND fr.return_pct IS NOT NULL
    GROUP BY ss.signal_code, fr.horizon_days
    HAVING COUNT(*) >= ${MIN_N}
    ORDER BY ss.signal_code;
  `
}

async function aggregateNative(tempDir: string): Promise<NativeReturnStatRow[]> {
  const started = Date.now()
  const output = await new Promise<string>((resolve, reject) => {
    const child = spawn(
      '/usr/bin/sqlite3',
      ['-readonly', '-json', '-cmd', '.timeout 60000', localDbPath, nativeReturnAggregateSql()],
      {
        env: { ...process.env, SQLITE_TMPDIR: tempDir },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    )
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => { stdout += chunk })
    child.stderr.on('data', (chunk: string) => { stderr += chunk })
    child.on('error', reject)
    child.on('close', (code, signal) => {
      if (code === 0) resolve(stdout)
      else reject(new Error(
        `sqlite3 signal-return aggregate failed: code=${code}, signal=${signal ?? 'none'}${stderr ? `: ${stderr.trim()}` : ''}`,
      ))
    })
  })
  const parsed = output.trim() ? JSON.parse(output) as NativeReturnStatRow[] : []
  console.log(
    `signal_return_stats native horizons=${HORIZONS.join(',')}: rows=${parsed.length}, `
    + `median_sample=1/${MEDIAN_SAMPLE_MOD}, `
    + `elapsed=${((Date.now() - started) / 60000).toFixed(1)}m`,
  )
  return parsed
}

async function insertNativeRows(rows: NativeReturnStatRow[]): Promise<void> {
  for (let i = 0; i < rows.length; i += INSERT_CHUNK) {
    await execBatch(rows.slice(i, i + INSERT_CHUNK).map((row) => ({
      sql: `
        INSERT OR REPLACE INTO signal_return_stats
          (signal_code, horizon_days, count, up_rate, down_rate, median_return_pct, avg_return_pct, computed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, unixepoch())
      `,
      args: [
        row.signal_code,
        row.horizon_days,
        row.count,
        row.up_rate,
        row.down_rate,
        row.median_return_pct,
        row.avg_return_pct,
      ],
    })))
  }
}

async function aggregateNativeParallel(): Promise<void> {
  if (localDbPath === ':memory:') throw new Error('Native signal-return aggregation requires a file-backed SQLite DB')
  const tempDir = process.env.SIGNAL_RETURN_TMPDIR?.trim()
    || path.join(path.dirname(localDbPath), '.signal-return-stats-tmp')
  fs.mkdirSync(tempDir, { recursive: true })
  console.log(
    `signal_return_stats: native single-pass aggregate horizons=${HORIZONS.join(',')}, temp=${tempDir}`,
  )
  const rows = await aggregateNative(tempDir)

  await execRun(
    `DELETE FROM signal_return_stats WHERE horizon_days IN (${HORIZONS.map(() => '?').join(', ')})`,
    HORIZONS,
  )
  await insertNativeRows(rows)
  console.log(`signal_return_stats complete: native single-pass aggregate (${rows.length} rows)`)
}

async function main() {
  console.log(
    `signal_return_stats build: horizons=${HORIZONS.join(',')}, min_n=${MIN_N}, `
    + `recent_days=${RECENT_DAYS || 'all'}, date_chunk=${DATE_CHUNK}, `
    + `median_sample=1/${MEDIAN_SAMPLE_MOD}`,
  )
  await execRun(`
    CREATE TABLE IF NOT EXISTS signal_return_stats (
      signal_code TEXT NOT NULL,
      horizon_days INTEGER NOT NULL,
      count INTEGER NOT NULL,
      up_rate REAL,
      down_rate REAL,
      median_return_pct REAL,
      avg_return_pct REAL,
      computed_at INTEGER NOT NULL DEFAULT (unixepoch()),
      PRIMARY KEY (signal_code, horizon_days)
    )
  `)
  await execRun(`CREATE INDEX IF NOT EXISTS signal_return_stats_code_idx ON signal_return_stats(signal_code, horizon_days, count)`)
  if (NATIVE_PARALLEL > 0) {
    await aggregateNativeParallel()
    return
  }
  await execRun(
    `DELETE FROM signal_return_stats WHERE horizon_days IN (${HORIZONS.map(() => '?').join(', ')})`,
    HORIZONS,
  )

  const dates = await loadTargetDates()
  if (dates.length === 0) {
    console.log('signal_return_stats skipped: no technical_signals dates')
    return
  }
  await loadPrevDates(dates)

  const accumulators = new Map<string, Accumulator>()
  const totalChunks = Math.ceil(dates.length / DATE_CHUNK)
  const started = Date.now()

  for (let i = 0; i < dates.length; i += DATE_CHUNK) {
    const chunkDates = dates.slice(i, i + DATE_CHUNK)
    const rows = await loadChunkReturns(chunkDates)
    addRows(accumulators, rows)
    const chunkNo = Math.floor(i / DATE_CHUNK) + 1
    if (chunkNo % 5 === 0 || chunkNo === totalChunks) {
      const elapsed = ((Date.now() - started) / 60000).toFixed(1)
      const from = chunkDates[chunkDates.length - 1]
      const to = chunkDates[0]
      console.log(`[${chunkNo}/${totalChunks}] ${from}..${to} groups=${accumulators.size} rows=${rows.length.toLocaleString()} elapsed=${elapsed}m`)
    }
  }

  const inserted = await insertRows(accumulators)
  console.log(`signal_return_stats complete: ${inserted} rows`)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
