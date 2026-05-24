// scripts/batch-signal-return-stats.ts
//
// シグナル発生後 1週/2週/3週の上昇割合・下落割合・中央値騰落率を作る。
// 画面表示はこの軽量テーブルを優先し、重いJOINをリクエスト時に走らせない。

import { execAll, execBatch, execRun } from '@/lib/db/client'

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
const RECENT_DAYS = envInt('BACKTEST_RECENT_DAYS', 260, 0)
const DATE_CHUNK = envInt('SIGNAL_RETURN_DATE_CHUNK', 10, 1)
const MIN_N = envInt('SIGNAL_RETURN_MIN_N', 20, 1)

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

async function loadChunkReturns(dates: string[]): Promise<ReturnRow[]> {
  if (dates.length === 0) return []
  const datePlaceholders = dates.map(() => '?').join(', ')
  const horizonPlaceholders = HORIZONS.map(() => '?').join(', ')
  return execAll<ReturnRow>(
    `
    SELECT ts.signal_code, fr.horizon_days, fr.return_pct
    FROM technical_signals ts
    INNER JOIN forward_returns fr INDEXED BY sqlite_autoindex_forward_returns_1
      ON fr.ticker = ts.ticker
     AND fr.date = ts.date
     AND fr.horizon_days IN (${horizonPlaceholders})
    WHERE ts.date IN (${datePlaceholders})
      AND fr.return_pct IS NOT NULL
    `,
    [...HORIZONS, ...dates],
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

async function main() {
  console.log(`signal_return_stats build: horizons=${HORIZONS.join(',')}, min_n=${MIN_N}, recent_days=${RECENT_DAYS || 'all'}, date_chunk=${DATE_CHUNK}`)
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
  await execRun(
    `DELETE FROM signal_return_stats WHERE horizon_days IN (${HORIZONS.map(() => '?').join(', ')})`,
    HORIZONS,
  )

  const dates = await loadTargetDates()
  if (dates.length === 0) {
    console.log('signal_return_stats skipped: no technical_signals dates')
    return
  }

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
