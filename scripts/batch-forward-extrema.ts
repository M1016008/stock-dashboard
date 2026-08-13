// scripts/batch-forward-extrema.ts
//
// 指定日から各 horizon 内に「どこまで上がったか / 下がったか」を計算する。
// forward_returns は終端日の騰落率だけなので、到達率分析と ML/RL ラベル用に別テーブルへ保存する。

import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { execAll, execBatch, execGet, execRun, localDbPath } from '@/lib/db/client'
import { HORIZONS as DEFAULT_HORIZONS } from '@/lib/backtest/signals'
import {
  computeForwardExtremaRows,
  type ForwardExtremaBar as Bar,
  type ForwardExtremaRow as ExtremaRow,
} from '@/lib/backtest/forward-extrema'
import { waitForMemoryHeadroom } from '@/lib/system/memory-guard'

const EXTREMA_BINDINGS_PER_ROW = 17
const SQLITE_SAFE_BIND_LIMIT = 32_766
const DEFAULT_CHUNK = 1_000
const requestedChunk = Number(process.env.FORWARD_EXTREMA_CHUNK ?? DEFAULT_CHUNK)
const CHUNK = Number.isFinite(requestedChunk) && requestedChunk > 0
  ? Math.min(Math.floor(requestedChunk), Math.floor(SQLITE_SAFE_BIND_LIMIT / EXTREMA_BINDINGS_PER_ROW))
  : DEFAULT_CHUNK
const requestedProgressEvery = Number(process.env.FORWARD_EXTREMA_PROGRESS_EVERY ?? 100)
const PROGRESS_EVERY = Number.isFinite(requestedProgressEvery) && requestedProgressEvery > 0
  ? Math.floor(requestedProgressEvery)
  : 100
const requestedWriteBatchTickers = Number(process.env.FORWARD_EXTREMA_WRITE_BATCH_TICKERS ?? 25)
const WRITE_BATCH_TICKERS = Number.isFinite(requestedWriteBatchTickers) && requestedWriteBatchTickers > 0
  ? Math.min(100, Math.floor(requestedWriteBatchTickers))
  : 25
const RECENT_DAYS = Number(process.env.BACKTEST_RECENT_DAYS ?? 0)
const START_DATE = process.env.FORWARD_EXTREMA_START_DATE?.trim() || null
const END_DATE = process.env.FORWARD_EXTREMA_END_DATE?.trim() || null
const TICKER_START = process.env.FORWARD_EXTREMA_TICKER_START?.trim() || null
const TICKER_END = process.env.FORWARD_EXTREMA_TICKER_END?.trim() || null
const ACTIVE_ONLY = process.env.FORWARD_EXTREMA_ACTIVE_ONLY === '1'
const WRITE_MODEL_LABELS = process.env.FORWARD_EXTREMA_WRITE_MODEL_LABELS !== '0'
const INCREMENTAL_UPSERT = process.env.FORWARD_EXTREMA_INCREMENTAL_UPSERT === '1'
const RESUME_ENABLED = process.env.FORWARD_EXTREMA_RESUME === '1'
const CHECKPOINT_VERSION = 1

type Checkpoint = {
  version: number
  signature: string
  latestDate: string | null
  totalTickers: number
  lastCompletedIndex: number
  totalRows: number
  coverageDates?: string[]
  updatedAt: string
}

let requestedSignal: NodeJS.Signals | null = null

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    if (requestedSignal) {
      process.exit(signal === 'SIGINT' ? 130 : 143)
    }
    requestedSignal = signal
    console.warn(`forward_extrema received ${signal}; checkpointing after the current ticker`)
  })
}

function parseHorizons(value: string | undefined): number[] {
  if (!value?.trim()) return [...DEFAULT_HORIZONS]
  const parsed = value
    .split(',')
    .map((item) => Number(item.trim()))
    .filter((item) => Number.isFinite(item) && item > 0)
  if (parsed.length === 0) throw new Error('FORWARD_EXTREMA_HORIZONS に有効な営業日数がありません')
  return [...new Set(parsed)].sort((a, b) => a - b)
}

const HORIZONS = parseHorizons(process.env.FORWARD_EXTREMA_HORIZONS)

function checkpointDirectory(): string {
  return process.env.STOCKBOARD_CHECKPOINT_DIR?.trim()
    || path.join(os.homedir(), 'Library', 'Application Support', 'StockBoard', 'checkpoints')
}

function buildCheckpointSignature(codes: string[], latestDate: string | null): string {
  const payload = JSON.stringify({
    version: CHECKPOINT_VERSION,
    database: localDbPath,
    latestDate,
    recentDays: RECENT_DAYS,
    startDate: START_DATE,
    endDate: END_DATE,
    tickerStart: TICKER_START,
    tickerEnd: TICKER_END,
    activeOnly: ACTIVE_ONLY,
    writeModelLabels: WRITE_MODEL_LABELS,
    horizons: HORIZONS,
    tickers: codes,
  })
  return createHash('sha256').update(payload).digest('hex').slice(0, 24)
}

function checkpointPath(signature: string): string {
  return path.join(checkpointDirectory(), `forward-extrema-${signature}.json`)
}

async function readCheckpoint(file: string, signature: string, totalTickers: number): Promise<Checkpoint | null> {
  if (!RESUME_ENABLED) return null
  try {
    const checkpoint = JSON.parse(await fs.readFile(file, 'utf8')) as Checkpoint
    if (
      checkpoint.version !== CHECKPOINT_VERSION
      || checkpoint.signature !== signature
      || checkpoint.totalTickers !== totalTickers
      || !Number.isInteger(checkpoint.lastCompletedIndex)
      || checkpoint.lastCompletedIndex < -1
      || checkpoint.lastCompletedIndex >= totalTickers
      || !Number.isFinite(checkpoint.totalRows)
      || checkpoint.totalRows < 0
      || (checkpoint.coverageDates != null && (
        !Array.isArray(checkpoint.coverageDates)
        || checkpoint.coverageDates.some((value) => typeof value !== 'string')
      ))
    ) {
      console.warn('forward_extrema ignored an incompatible checkpoint')
      return null
    }
    return checkpoint
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.warn(`forward_extrema checkpoint read failed: ${error instanceof Error ? error.message : String(error)}`)
    }
    return null
  }
}

async function writeCheckpoint(file: string, checkpoint: Checkpoint): Promise<void> {
  if (!RESUME_ENABLED) return
  const temporary = `${file}.${process.pid}.tmp`
  try {
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(temporary, `${JSON.stringify(checkpoint)}\n`, 'utf8')
    await fs.rename(temporary, file)
  } catch (error) {
    await fs.unlink(temporary).catch(() => undefined)
    console.warn(`forward_extrema checkpoint write failed: ${error instanceof Error ? error.message : String(error)}`)
  }
}

async function removeCheckpoint(file: string): Promise<void> {
  if (!RESUME_ENABLED) return
  try {
    await fs.unlink(file)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.warn(`forward_extrema checkpoint cleanup failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
}

function jobType(): string {
  return 'forward_extrema'
}

async function startBatchRun(totalTickers: number, succeeded: number, rowsInserted: number): Promise<number | null> {
  try {
    await execRun(
      `
        UPDATE batch_runs
        SET finished_at = unixepoch(),
            status = 'failed',
            failed = 1,
            error_summary = COALESCE(error_summary, 'Superseded after the previous worker exited')
        WHERE job_type = ? AND status = 'running'
      `,
      [jobType()],
    )
    const row = await execGet<{ id: number }>(
      `
        INSERT INTO batch_runs
          (job_type, started_at, status, total_tickers, succeeded, failed, rows_inserted)
        VALUES (?, unixepoch(), 'running', ?, ?, 0, ?)
        RETURNING id
      `,
      [jobType(), totalTickers, succeeded, rowsInserted],
    )
    return row?.id ?? null
  } catch (error) {
    console.warn(`forward_extrema progress tracking unavailable: ${error instanceof Error ? error.message : String(error)}`)
    return null
  }
}

async function updateBatchRun(
  id: number | null,
  succeeded: number,
  rowsInserted: number,
): Promise<void> {
  if (id == null) return
  try {
    await execRun(
      `
        UPDATE batch_runs
        SET succeeded = ?, rows_inserted = ?
        WHERE id = ? AND status = 'running'
      `,
      [succeeded, rowsInserted, id],
    )
  } catch (error) {
    console.warn(`forward_extrema progress update failed: ${error instanceof Error ? error.message : String(error)}`)
  }
}

async function finishBatchRun(
  id: number | null,
  status: 'success' | 'failed',
  succeeded: number,
  rowsInserted: number,
  errorSummary: string | null = null,
): Promise<void> {
  if (id == null) return
  try {
    await execRun(
      `
        UPDATE batch_runs
        SET finished_at = unixepoch(),
            status = ?,
            succeeded = ?,
            failed = ?,
            rows_inserted = ?,
            error_summary = ?
        WHERE id = ?
      `,
      [status, succeeded, status === 'failed' ? 1 : 0, rowsInserted, errorSummary, id],
    )
  } catch (error) {
    console.warn(`forward_extrema final progress update failed: ${error instanceof Error ? error.message : String(error)}`)
  }
}

async function tickers(): Promise<string[]> {
  const filter = process.env.TICKERS?.split(',').map((value) => value.trim()).filter(Boolean)
  if (filter && filter.length > 0) return filter
  const where: string[] = []
  const args: string[] = []
  if (ACTIVE_ONLY) where.push(`active = 1`)
  if (TICKER_START) {
    where.push(`ticker >= ?`)
    args.push(TICKER_START)
  }
  if (TICKER_END) {
    where.push(`ticker <= ?`)
    args.push(TICKER_END)
  }
  const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''
  if (ACTIVE_ONLY) {
    try {
      const rows = await execAll<{ ticker: string }>(
        `SELECT ticker FROM ticker_universe ${whereSql} GROUP BY ticker ORDER BY ticker`,
        args,
      )
      if (rows.length > 0) return rows.map((row) => row.ticker)
      console.warn('FORWARD_EXTREMA_ACTIVE_ONLY=1 but ticker_universe returned no rows; falling back to ohlcv_daily')
    } catch (error) {
      console.warn(
        `FORWARD_EXTREMA_ACTIVE_ONLY=1 fallback: ${
          error instanceof Error ? error.message : String(error)
        }`,
      )
    }
  }
  const ohlcvWhere = [
    ...(TICKER_START ? [`ticker >= ?`] : []),
    ...(TICKER_END ? [`ticker <= ?`] : []),
  ]
  const ohlcvWhereSql = ohlcvWhere.length > 0 ? `WHERE ${ohlcvWhere.join(' AND ')}` : ''
  const ohlcvArgs = [
    ...(TICKER_START ? [TICKER_START] : []),
    ...(TICKER_END ? [TICKER_END] : []),
  ]
  const rows = await execAll<{ ticker: string }>(
    `SELECT ticker FROM ohlcv_daily ${ohlcvWhereSql} GROUP BY ticker ORDER BY ticker`,
    ohlcvArgs,
  )
  return rows.map((row) => row.ticker)
}

function computeTicker(ticker: string, bars: Bar[]): ExtremaRow[] {
  const recentIndex = RECENT_DAYS > 0 ? Math.max(0, bars.length - RECENT_DAYS) : 0
  const startDateIndex = START_DATE ? bars.findIndex((bar) => bar.date >= START_DATE) : -1
  const startIndex = Math.max(recentIndex, startDateIndex >= 0 ? startDateIndex : 0)
  return computeForwardExtremaRows({ ticker, bars, horizons: HORIZONS, startIndex, endDate: END_DATE })
}

async function loadBarsBatch(tickers: string[]): Promise<Map<string, Bar[]>> {
  const result = new Map(tickers.map((ticker) => [ticker, [] as Bar[]]))
  if (tickers.length === 0) return result
  const placeholders = tickers.map(() => '?').join(', ')
  let rows: Array<Bar & { ticker: string }>
  if (RECENT_DAYS > 0 && !END_DATE) {
    rows = await execAll<Bar & { ticker: string }>(
      `
        SELECT ticker, date, high, low, close
        FROM (
          SELECT ticker, date, high, low, close,
                 ROW_NUMBER() OVER (PARTITION BY ticker ORDER BY date DESC) AS recent_rank
          FROM ohlcv_daily
          WHERE ticker IN (${placeholders})
        )
        WHERE recent_rank <= ?
        ORDER BY ticker, date
      `,
      [...tickers, Math.floor(RECENT_DAYS)],
    )
  } else {
    rows = await execAll<Bar & { ticker: string }>(
      `
        SELECT ticker, date, high, low, close
        FROM ohlcv_daily
        WHERE ticker IN (${placeholders})
        ORDER BY ticker, date
      `,
      tickers,
    )
  }
  for (const row of rows) result.get(row.ticker)?.push(row)
  return result
}

function appendInsertStatements(
  statements: Parameters<typeof execBatch>[0],
  ticker: string,
  rows: ExtremaRow[],
): void {
  if (rows.length === 0) return
  const horizonPlaceholders = HORIZONS.map(() => '?').join(', ')
  const minDate = rows[0].date
  const maxDate = rows[rows.length - 1].date

  if (!INCREMENTAL_UPSERT) {
    statements.push({
      sql: `
        DELETE FROM forward_extrema
        WHERE ticker = ?
          AND horizon_days IN (${horizonPlaceholders})
          AND date BETWEEN ? AND ?
      `,
      args: [ticker, ...HORIZONS, minDate, maxDate],
    })
  }
  if (WRITE_MODEL_LABELS) {
    statements.push({
      sql: `
        DELETE FROM model_labels
        WHERE ticker = ?
          AND horizon_days IN (${horizonPlaceholders})
          AND date BETWEEN ? AND ?
      `,
      args: [ticker, ...HORIZONS, minDate, maxDate],
    })
  }

  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK)
    const extremaArgs: Array<string | number | null> = []
    const extremaValues = chunk.map((row) => {
      extremaArgs.push(
        row.ticker,
        row.date,
        row.horizon_days,
        row.return_pct,
        row.end_date,
        row.max_return_pct,
        row.max_return_date,
        row.days_to_max,
        row.min_return_pct,
        row.min_return_date,
        row.days_to_min,
        row.hit_10,
        row.hit_20,
        row.hit_40,
        row.days_to_10,
        row.days_to_20,
        row.days_to_40,
      )
      return `(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, unixepoch())`
    }).join(', ')

    statements.push({
      sql: `
      INSERT INTO forward_extrema
        (ticker, date, horizon_days, return_pct, end_date, max_return_pct, max_return_date, days_to_max,
         min_return_pct, min_return_date, days_to_min, hit_10, hit_20, hit_40, days_to_10, days_to_20, days_to_40, computed_at)
      VALUES ${extremaValues}
      ${INCREMENTAL_UPSERT ? `
      ON CONFLICT(ticker, date, horizon_days) DO UPDATE SET
        return_pct = excluded.return_pct,
        end_date = excluded.end_date,
        max_return_pct = excluded.max_return_pct,
        max_return_date = excluded.max_return_date,
        days_to_max = excluded.days_to_max,
        min_return_pct = excluded.min_return_pct,
        min_return_date = excluded.min_return_date,
        days_to_min = excluded.days_to_min,
        hit_10 = excluded.hit_10,
        hit_20 = excluded.hit_20,
        hit_40 = excluded.hit_40,
        days_to_10 = excluded.days_to_10,
        days_to_20 = excluded.days_to_20,
        days_to_40 = excluded.days_to_40,
        computed_at = unixepoch()
      WHERE forward_extrema.return_pct IS NOT excluded.return_pct
         OR forward_extrema.end_date IS NOT excluded.end_date
         OR forward_extrema.max_return_pct IS NOT excluded.max_return_pct
         OR forward_extrema.max_return_date IS NOT excluded.max_return_date
         OR forward_extrema.days_to_max IS NOT excluded.days_to_max
         OR forward_extrema.min_return_pct IS NOT excluded.min_return_pct
         OR forward_extrema.min_return_date IS NOT excluded.min_return_date
         OR forward_extrema.days_to_min IS NOT excluded.days_to_min
         OR forward_extrema.hit_10 IS NOT excluded.hit_10
         OR forward_extrema.hit_20 IS NOT excluded.hit_20
         OR forward_extrema.hit_40 IS NOT excluded.hit_40
         OR forward_extrema.days_to_10 IS NOT excluded.days_to_10
         OR forward_extrema.days_to_20 IS NOT excluded.days_to_20
         OR forward_extrema.days_to_40 IS NOT excluded.days_to_40
      ` : ''}
      `,
      args: extremaArgs,
    })

    if (WRITE_MODEL_LABELS) {
      const labelArgs: Array<string | number | null> = []
      const labelValues = chunk.map((row) => {
        labelArgs.push(
          row.ticker,
          row.date,
          row.horizon_days,
          row.return_pct,
          row.max_return_pct,
          row.min_return_pct,
          row.days_to_max,
          row.hit_10,
          row.hit_20,
          row.hit_40,
          row.max_return_pct + Math.min(row.min_return_pct, 0),
          JSON.stringify({
            endDate: row.end_date,
            maxReturnDate: row.max_return_date,
            minReturnDate: row.min_return_date,
            daysToMin: row.days_to_min,
            daysTo10: row.days_to_10,
            daysTo20: row.days_to_20,
            daysTo40: row.days_to_40,
          }),
        )
        return `(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, unixepoch())`
      }).join(', ')

      statements.push({
        sql: `
        INSERT INTO model_labels
          (ticker, date, horizon_days, return_pct, max_return_pct, min_return_pct, days_to_max,
           hit_10, hit_20, hit_40, reward_score, label_json, computed_at)
        VALUES ${labelValues}
        `,
        args: labelArgs,
      })
    }
  }

}

async function insertTickerBatch(entries: Array<{ ticker: string; rows: ExtremaRow[] }>): Promise<void> {
  const statements: Parameters<typeof execBatch>[0] = []
  for (const entry of entries) appendInsertStatements(statements, entry.ticker, entry.rows)
  if (statements.length > 0) await execBatch(statements)
}

async function refreshCoverageDates(
  horizons: number[],
  incrementalDates: ReadonlySet<string>,
): Promise<void> {
  const selected = [...new Set(horizons)]
  if (selected.length === 0) return
  if (INCREMENTAL_UPSERT) {
    const rows = [...incrementalDates]
      .map((value) => {
        const separator = value.indexOf('|')
        return {
          horizon: Number(value.slice(0, separator)),
          date: value.slice(separator + 1),
        }
      })
      .filter((row) => Number.isInteger(row.horizon) && row.date.length > 0)
    const statements: Parameters<typeof execBatch>[0] = []
    for (let index = 0; index < rows.length; index += 500) {
      const chunk = rows.slice(index, index + 500)
      const args: Array<string | number> = []
      const values = chunk.map((row) => {
        args.push(row.horizon, row.date)
        return '(?, ?, unixepoch())'
      }).join(', ')
      statements.push({
        sql: `
          INSERT INTO forward_extrema_date_coverage (horizon_days, date, updated_at)
          VALUES ${values}
          ON CONFLICT(horizon_days, date) DO UPDATE SET updated_at = excluded.updated_at
        `,
        args,
      })
    }
    if (statements.length > 0) await execBatch(statements)
    return
  }
  const placeholders = selected.map(() => '?').join(', ')
  await execBatch([
    {
      sql: `DELETE FROM forward_extrema_date_coverage WHERE horizon_days IN (${placeholders})`,
      args: selected,
    },
    {
      sql: `
        INSERT INTO forward_extrema_date_coverage (horizon_days, date, updated_at)
        SELECT horizon_days, date, unixepoch()
        FROM forward_extrema INDEXED BY fext_horizon_date_idx
        WHERE horizon_days IN (${placeholders})
        GROUP BY horizon_days, date
      `,
      args: selected,
    },
  ])
}

async function main() {
  const codes = await tickers()
  const latest = await execGet<{ date: string | null }>('SELECT MAX(date) AS date FROM ohlcv_daily')
  const signature = buildCheckpointSignature(codes, latest?.date ?? null)
  const checkpointFile = checkpointPath(signature)
  const checkpoint = await readCheckpoint(checkpointFile, signature, codes.length)
  const resumeIndex = checkpoint ? checkpoint.lastCompletedIndex + 1 : 0
  let completed = resumeIndex
  let total = checkpoint?.totalRows ?? 0
  const incrementalCoverageDates = new Set<string>(checkpoint?.coverageDates ?? [])
  const started = Date.now()
  const runId = await startBatchRun(codes.length, completed, total)
  console.log(
    `forward_extrema build: ${codes.length} tickers, recent_days=${RECENT_DAYS || 'all'}, start=${START_DATE ?? '-'}, end=${END_DATE ?? '-'}, horizons=${HORIZONS.join('/')}, chunk=${CHUNK}, write_batch=${WRITE_BATCH_TICKERS}, incremental_upsert=${INCREMENTAL_UPSERT ? 'on' : 'off'}, model_labels=${WRITE_MODEL_LABELS ? 'on' : 'off'}, resume=${RESUME_ENABLED ? 'on' : 'off'}`,
  )
  if (ACTIVE_ONLY) console.log('forward_extrema active_only=on')
  if (TICKER_START || TICKER_END) console.log(`forward_extrema ticker range: ${TICKER_START ?? '-'}..${TICKER_END ?? '-'}`)
  if (checkpoint) {
    console.log(`forward_extrema resumed at ${resumeIndex}/${codes.length}; prior_rows=${total}`)
  }

  try {
    for (let batchStart = resumeIndex; batchStart < codes.length; batchStart += WRITE_BATCH_TICKERS) {
      if (requestedSignal) throw new Error(`interrupted by ${requestedSignal}`)
      const batchEnd = Math.min(codes.length, batchStart + WRITE_BATCH_TICKERS)
      const batchTickers = codes.slice(batchStart, batchEnd)
      const barsByTicker = await loadBarsBatch(batchTickers)
      const entries: Array<{ ticker: string; rows: ExtremaRow[] }> = []
      for (const ticker of batchTickers) {
        const bars = barsByTicker.get(ticker) ?? []
        entries.push({ ticker, rows: computeTicker(ticker, bars) })
      }
      await insertTickerBatch(entries)
      for (const entry of entries) {
        for (const row of entry.rows) {
          incrementalCoverageDates.add(`${row.horizon_days}|${row.date}`)
        }
      }
      const rowsInserted = entries.reduce((sum, entry) => sum + entry.rows.length, 0)
      total += rowsInserted
      completed = batchEnd
      const lastEntry = entries[entries.length - 1]

      const crossedReportBoundary = Math.floor(completed / PROGRESS_EVERY) > Math.floor(batchStart / PROGRESS_EVERY)
      const shouldReport = crossedReportBoundary || completed === codes.length || requestedSignal != null
      if (shouldReport) {
        await writeCheckpoint(checkpointFile, {
          version: CHECKPOINT_VERSION,
          signature,
          latestDate: latest?.date ?? null,
          totalTickers: codes.length,
          lastCompletedIndex: completed - 1,
          totalRows: total,
          coverageDates: INCREMENTAL_UPSERT ? [...incrementalCoverageDates] : undefined,
          updatedAt: new Date().toISOString(),
        })
        await updateBatchRun(runId, completed, total)
        const elapsedMinutes = (Date.now() - started) / 60000
        const processedThisAttempt = Math.max(1, completed - resumeIndex)
        const remaining = codes.length - completed
        const etaMinutes = remaining * (elapsedMinutes / processedThisAttempt)
        console.log(
          `[${completed}/${codes.length}] ${lastEntry.ticker}: ${lastEntry.rows.length} labels, total=${total}, elapsed=${elapsedMinutes.toFixed(1)}m, eta=${etaMinutes.toFixed(1)}m`,
        )
        if (!requestedSignal && completed < codes.length) {
          await waitForMemoryHeadroom({
            label: `forward_extrema ${completed}/${codes.length}`,
          })
        }
      }
      if (requestedSignal) throw new Error(`interrupted by ${requestedSignal}`)
    }

    await refreshCoverageDates(HORIZONS, incrementalCoverageDates)
    await finishBatchRun(runId, 'success', completed, total)
    await removeCheckpoint(checkpointFile)
    console.log(`forward_extrema complete: ${total} rows`)
  } catch (error) {
    await finishBatchRun(
      runId,
      'failed',
      completed,
      total,
      (error instanceof Error ? error.message : String(error)).slice(0, 1_000),
    )
    throw error
  }
}

main().then(() => {
  process.exit(0)
}).catch((error) => {
  console.error('batch-forward-extrema failed:', error)
  process.exit(1)
})
