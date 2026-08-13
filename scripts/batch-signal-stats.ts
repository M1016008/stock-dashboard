// scripts/batch-signal-stats.ts
//
// シグナル × ステージパターン × horizon の過去成績を集計する。
//
// 全期間を一度に GROUP BY すると technical_signals × forward_extrema のJOINが
// 巨大化するため、日付レンジに分割して集計し、Node側で合算する。

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { execAll, execBatch, execRun, localDbPath } from '@/lib/db/client'

type GroupRow = {
  signal_code: string
  pattern_code: string
  horizon_days: number
  count: number
  hit_10_sum: number | null
  hit_20_sum: number | null
  hit_40_sum: number | null
  max_return_sum: number | null
  return_sum: number | null
  min_return_sum: number | null
  days_to_max_sum: number | null
  days_to_max_count: number | null
}

const BY_PATTERN = process.env.SIGNAL_STATS_BY_PATTERN === '1'

function envInt(name: string, fallback: number, min = 0): number {
  const value = Number(process.env[name] ?? fallback)
  if (!Number.isFinite(value)) return fallback
  return Math.max(min, Math.floor(value))
}

const MIN_N = envInt('SIGNAL_MIN_N', 40, 1)
const GROUP_LIMIT = envInt('SIGNAL_STATS_LIMIT_GROUPS', 0, 0)
const RECENT_DAYS = envInt('BACKTEST_RECENT_DAYS', 0, 0)
const DATE_CHUNK = envInt('SIGNAL_STATS_DATE_CHUNK', BY_PATTERN ? 5 : 10, 1)
const INSERT_CHUNK = 200
const DIRECT_AGGREGATE = process.env.SIGNAL_STATS_DIRECT_AGGREGATE !== '0'
const NATIVE_PARALLEL = envInt('SIGNAL_STATS_NATIVE_PARALLEL', 0, 0)
const DIRECT_HORIZONS = (process.env.SIGNAL_STATS_HORIZONS ?? '5,10,20,40,60,90,200')
  .split(',')
  .map((value) => Number(value.trim()))
  .filter((value) => Number.isInteger(value) && value > 0)

type TargetDateRow = {
  date: string
}

type StatAccumulator = {
  signalCode: string
  patternCode: string
  horizonDays: number
  count: number
  hit10Sum: number
  hit20Sum: number
  hit40Sum: number
  maxReturnSum: number
  returnSum: number
  minReturnSum: number
  daysToMaxSum: number
  daysToMaxCount: number
}

type SignalStatRow = {
  signal_code: string
  pattern_code: string
  horizon_days: number
  count: number
  hit_10_rate: number | null
  hit_20_rate: number | null
  hit_40_rate: number | null
  max_return_p25: number | null
  max_return_p50: number | null
  max_return_p75: number | null
  return_p50: number | null
  min_return_p50: number | null
  days_to_max_p50: number | null
}

function toNumber(value: unknown): number {
  const n = Number(value ?? 0)
  return Number.isFinite(n) ? n : 0
}

function nullableAverage(sum: number, count: number): number | null {
  return count > 0 ? sum / count : null
}

function keyFor(signalCode: string, patternCode: string, horizonDays: number): string {
  return `${signalCode}\t${patternCode}\t${horizonDays}`
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

async function loadChunkStats(dates: string[]): Promise<GroupRow[]> {
  if (dates.length === 0) return []

  const placeholders = dates.map(() => '?').join(', ')
  if (!BY_PATTERN) {
    return execAll<GroupRow>(
      `
      SELECT
        ts.signal_code,
        'ALL' AS pattern_code,
        fe.horizon_days,
        COUNT(*) AS count,
        SUM(fe.hit_10) AS hit_10_sum,
        SUM(fe.hit_20) AS hit_20_sum,
        SUM(fe.hit_40) AS hit_40_sum,
        SUM(COALESCE(fe.max_return_pct, 0)) AS max_return_sum,
        SUM(COALESCE(fe.return_pct, 0)) AS return_sum,
        SUM(COALESCE(fe.min_return_pct, 0)) AS min_return_sum,
        SUM(COALESCE(fe.days_to_max, 0)) AS days_to_max_sum,
        SUM(CASE WHEN fe.days_to_max IS NULL THEN 0 ELSE 1 END) AS days_to_max_count
      FROM technical_signals ts
      INNER JOIN forward_extrema fe ON fe.ticker = ts.ticker AND fe.date = ts.date
      WHERE ts.date IN (${placeholders})
      GROUP BY ts.signal_code, fe.horizon_days
      `,
      dates,
    )
  }

  return execAll<GroupRow>(
    `
    SELECT
      ts.signal_code,
      COALESCE(mf.pattern_code, '------') AS pattern_code,
      fe.horizon_days,
      COUNT(*) AS count,
      SUM(fe.hit_10) AS hit_10_sum,
      SUM(fe.hit_20) AS hit_20_sum,
      SUM(fe.hit_40) AS hit_40_sum,
      SUM(COALESCE(fe.max_return_pct, 0)) AS max_return_sum,
      SUM(COALESCE(fe.return_pct, 0)) AS return_sum,
      SUM(COALESCE(fe.min_return_pct, 0)) AS min_return_sum,
      SUM(COALESCE(fe.days_to_max, 0)) AS days_to_max_sum,
      SUM(CASE WHEN fe.days_to_max IS NULL THEN 0 ELSE 1 END) AS days_to_max_count
    FROM technical_signals ts
    INNER JOIN model_features mf ON mf.ticker = ts.ticker AND mf.date = ts.date
    INNER JOIN forward_extrema fe ON fe.ticker = ts.ticker AND fe.date = ts.date
    WHERE ts.date IN (${placeholders})
      AND mf.pattern_code IS NOT NULL
    GROUP BY ts.signal_code, mf.pattern_code, fe.horizon_days
    `,
    dates,
  )
}

function addRows(accumulators: Map<string, StatAccumulator>, rows: GroupRow[]): void {
  for (const row of rows) {
    const signalCode = row.signal_code
    const patternCode = row.pattern_code
    const horizonDays = toNumber(row.horizon_days)
    const key = keyFor(signalCode, patternCode, horizonDays)
    const acc = accumulators.get(key) ?? {
      signalCode,
      patternCode,
      horizonDays,
      count: 0,
      hit10Sum: 0,
      hit20Sum: 0,
      hit40Sum: 0,
      maxReturnSum: 0,
      returnSum: 0,
      minReturnSum: 0,
      daysToMaxSum: 0,
      daysToMaxCount: 0,
    }
    acc.count += toNumber(row.count)
    acc.hit10Sum += toNumber(row.hit_10_sum)
    acc.hit20Sum += toNumber(row.hit_20_sum)
    acc.hit40Sum += toNumber(row.hit_40_sum)
    acc.maxReturnSum += toNumber(row.max_return_sum)
    acc.returnSum += toNumber(row.return_sum)
    acc.minReturnSum += toNumber(row.min_return_sum)
    acc.daysToMaxSum += toNumber(row.days_to_max_sum)
    acc.daysToMaxCount += toNumber(row.days_to_max_count)
    accumulators.set(key, acc)
  }
}

function finalizeRows(accumulators: Map<string, StatAccumulator>): SignalStatRow[] {
  const rows = Array.from(accumulators.values())
    .filter((row) => row.count >= MIN_N)
    .sort((a, b) => b.count - a.count)
    .slice(0, GROUP_LIMIT > 0 ? GROUP_LIMIT : undefined)

  return rows.map((row) => {
    const avgMaxReturn = nullableAverage(row.maxReturnSum, row.count)
    return {
      signal_code: row.signalCode,
      pattern_code: row.patternCode,
      horizon_days: row.horizonDays,
      count: row.count,
      hit_10_rate: nullableAverage(row.hit10Sum, row.count),
      hit_20_rate: nullableAverage(row.hit20Sum, row.count),
      hit_40_rate: nullableAverage(row.hit40Sum, row.count),
      // 高速サービング向けの集計では分位点ではなく平均値を格納する。
      // UI側は「平均最大」として表示しているため、この互換列を使う。
      max_return_p25: avgMaxReturn,
      max_return_p50: avgMaxReturn,
      max_return_p75: avgMaxReturn,
      return_p50: nullableAverage(row.returnSum, row.count),
      min_return_p50: nullableAverage(row.minReturnSum, row.count),
      days_to_max_p50: nullableAverage(row.daysToMaxSum, row.daysToMaxCount),
    }
  })
}

async function insertRows(rows: SignalStatRow[]): Promise<void> {
  for (let i = 0; i < rows.length; i += INSERT_CHUNK) {
    await execBatch(rows.slice(i, i + INSERT_CHUNK).map((row) => ({
      sql: `
        INSERT OR REPLACE INTO signal_stats
          (signal_code, pattern_code, horizon_days, count, hit_10_rate, hit_20_rate, hit_40_rate,
           max_return_p25, max_return_p50, max_return_p75, return_p50, min_return_p50, days_to_max_p50, computed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, unixepoch())
      `,
      args: [
        row.signal_code,
        row.pattern_code,
        row.horizon_days,
        row.count,
        row.hit_10_rate,
        row.hit_20_rate,
        row.hit_40_rate,
        row.max_return_p25,
        row.max_return_p50,
        row.max_return_p75,
        row.return_p50,
        row.min_return_p50,
        row.days_to_max_p50,
      ],
    })))
  }
}

async function aggregateDirectBySignal(): Promise<void> {
  const signalCodes = await execAll<{ signal_code: string }>(
    `SELECT signal_code FROM technical_signals GROUP BY signal_code ORDER BY signal_code`,
  )
  const horizonPlaceholders = DIRECT_HORIZONS.map(() => '?').join(', ')
  await execRun(`DELETE FROM signal_stats`)

  for (const [index, { signal_code: signalCode }] of signalCodes.entries()) {
    const started = Date.now()
    await execRun(
      `
      INSERT INTO signal_stats
        (signal_code, pattern_code, horizon_days, count, hit_10_rate, hit_20_rate, hit_40_rate,
         max_return_p25, max_return_p50, max_return_p75, return_p50, min_return_p50,
         days_to_max_p50, computed_at)
      SELECT
        ts.signal_code,
        'ALL',
        fe.horizon_days,
        COUNT(*) AS count,
        AVG(fe.hit_10),
        AVG(fe.hit_20),
        AVG(fe.hit_40),
        AVG(COALESCE(fe.max_return_pct, 0)),
        AVG(COALESCE(fe.max_return_pct, 0)),
        AVG(COALESCE(fe.max_return_pct, 0)),
        AVG(COALESCE(fe.return_pct, 0)),
        AVG(COALESCE(fe.min_return_pct, 0)),
        AVG(fe.days_to_max),
        unixepoch()
      FROM technical_signals ts INDEXED BY tech_signal_code_idx
      INNER JOIN forward_extrema fe
        ON fe.ticker = ts.ticker AND fe.date = ts.date
      WHERE ts.signal_code = ?
        AND fe.horizon_days IN (${horizonPlaceholders})
      GROUP BY fe.horizon_days
      HAVING COUNT(*) >= ?
      `,
      [signalCode, ...DIRECT_HORIZONS, MIN_N],
    )
    const count = await execAll<{ count: number }>(
      `SELECT COUNT(*) AS count FROM signal_stats WHERE signal_code = ?`,
      [signalCode],
    )
    console.log(
      `signal_stats direct signal=${index + 1}/${signalCodes.length} ${signalCode}: `
      + `rows=${Number(count[0]?.count ?? 0)}, `
      + `elapsed=${((Date.now() - started) / 60000).toFixed(1)}m`,
    )
  }
}

async function aggregateDirectByHorizon(): Promise<void> {
  await execRun(`DELETE FROM signal_stats`)

  for (const horizon of DIRECT_HORIZONS) {
    const started = Date.now()
    await execRun(
      `
      INSERT INTO signal_stats
        (signal_code, pattern_code, horizon_days, count, hit_10_rate, hit_20_rate, hit_40_rate,
         max_return_p25, max_return_p50, max_return_p75, return_p50, min_return_p50,
         days_to_max_p50, computed_at)
      SELECT
        ts.signal_code,
        'ALL',
        fe.horizon_days,
        COUNT(*) AS count,
        AVG(fe.hit_10),
        AVG(fe.hit_20),
        AVG(fe.hit_40),
        AVG(COALESCE(fe.max_return_pct, 0)),
        AVG(COALESCE(fe.max_return_pct, 0)),
        AVG(COALESCE(fe.max_return_pct, 0)),
        AVG(COALESCE(fe.return_pct, 0)),
        AVG(COALESCE(fe.min_return_pct, 0)),
        AVG(fe.days_to_max),
        unixepoch()
      FROM forward_extrema fe INDEXED BY fext_horizon_date_idx
      INNER JOIN technical_signals ts
        ON ts.ticker = fe.ticker AND ts.date = fe.date
      WHERE fe.horizon_days = ?
      GROUP BY ts.signal_code, fe.horizon_days
      HAVING COUNT(*) >= ?
      `,
      [horizon, MIN_N],
    )
    const count = await execAll<{ count: number }>(
      `SELECT COUNT(*) AS count FROM signal_stats WHERE horizon_days = ?`,
      [horizon],
    )
    console.log(
      `signal_stats direct horizon=${horizon}: rows=${Number(count[0]?.count ?? 0)}, `
      + `elapsed=${((Date.now() - started) / 60000).toFixed(1)}m`,
    )
  }
}

function nativeAggregateSql(horizon: number): string {
  return `
    PRAGMA temp_store=FILE;
    PRAGMA cache_size=-32768;
    SELECT
      ts.signal_code,
      'ALL' AS pattern_code,
      fe.horizon_days,
      COUNT(*) AS count,
      AVG(fe.hit_10) AS hit_10_rate,
      AVG(fe.hit_20) AS hit_20_rate,
      AVG(fe.hit_40) AS hit_40_rate,
      AVG(COALESCE(fe.max_return_pct, 0)) AS max_return_p25,
      AVG(COALESCE(fe.max_return_pct, 0)) AS max_return_p50,
      AVG(COALESCE(fe.max_return_pct, 0)) AS max_return_p75,
      AVG(COALESCE(fe.return_pct, 0)) AS return_p50,
      AVG(COALESCE(fe.min_return_pct, 0)) AS min_return_p50,
      AVG(fe.days_to_max) AS days_to_max_p50
    FROM forward_extrema fe INDEXED BY fext_horizon_date_idx
    INNER JOIN technical_signals ts
      ON ts.ticker = fe.ticker AND ts.date = fe.date
    WHERE fe.horizon_days = ${horizon}
    GROUP BY ts.signal_code, fe.horizon_days
    HAVING COUNT(*) >= ${MIN_N}
    ORDER BY ts.signal_code;
  `
}

async function aggregateNativeHorizon(horizon: number, tempDir: string): Promise<SignalStatRow[]> {
  const started = Date.now()
  const output = await new Promise<string>((resolve, reject) => {
    const child = spawn(
      '/usr/bin/sqlite3',
      ['-readonly', '-json', '-cmd', '.timeout 60000', localDbPath, nativeAggregateSql(horizon)],
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
        `sqlite3 signal aggregate h${horizon} failed: code=${code}, signal=${signal ?? 'none'}${stderr ? `: ${stderr.trim()}` : ''}`,
      ))
    })
  })
  const parsed = output.trim() ? JSON.parse(output) as SignalStatRow[] : []
  console.log(
    `signal_stats native horizon=${horizon}: rows=${parsed.length}, `
    + `elapsed=${((Date.now() - started) / 60000).toFixed(1)}m`,
  )
  return parsed
}

async function aggregateNativeParallel(): Promise<void> {
  if (localDbPath === ':memory:') throw new Error('Native signal aggregation requires a file-backed SQLite DB')
  const tempDir = path.join(path.dirname(localDbPath), '.signal-stats-tmp')
  fs.mkdirSync(tempDir, { recursive: true })
  const concurrency = Math.min(4, Math.max(1, NATIVE_PARALLEL))
  const pending = [...DIRECT_HORIZONS]
  const rows: SignalStatRow[] = []
  console.log(
    `signal_stats: native parallel aggregate concurrency=${concurrency}, `
    + `horizons=${DIRECT_HORIZONS.join(',')}, temp=${tempDir}`,
  )

  await Promise.all(Array.from({ length: Math.min(concurrency, pending.length) }, async () => {
    while (pending.length > 0) {
      const horizon = pending.shift()
      if (horizon == null) return
      rows.push(...await aggregateNativeHorizon(horizon, tempDir))
    }
  }))

  const placeholders = DIRECT_HORIZONS.map(() => '?').join(', ')
  await execRun(`DELETE FROM signal_stats WHERE horizon_days IN (${placeholders})`, DIRECT_HORIZONS)
  await insertRows(rows)
  console.log(`signal_stats complete: native parallel aggregate (${rows.length} rows)`)
}

async function main() {
  console.log(`signal_stats build: min_n=${MIN_N}, group_limit=${GROUP_LIMIT || 'all'}, recent_days=${RECENT_DAYS || 'all'}, date_chunk=${DATE_CHUNK}, by_pattern=${BY_PATTERN}`)
  if (DIRECT_AGGREGATE && !BY_PATTERN && GROUP_LIMIT === 0 && RECENT_DAYS === 0) {
    if (NATIVE_PARALLEL > 0) {
      await aggregateNativeParallel()
      return
    }
    const axis = process.env.SIGNAL_STATS_DIRECT_AXIS === 'signal' ? 'signal' : 'horizon'
    console.log(`signal_stats: using equivalent ${axis}-indexed direct aggregation`)
    if (axis === 'signal') await aggregateDirectBySignal()
    else await aggregateDirectByHorizon()
    console.log(`signal_stats complete: direct ${axis} aggregate`)
    return
  }
  await execRun(`DELETE FROM signal_stats`)

  const dates = await loadTargetDates()
  if (dates.length === 0) {
    console.log('signal_stats skipped: no technical_signals dates')
    return
  }

  const accumulators = new Map<string, StatAccumulator>()
  const totalChunks = Math.ceil(dates.length / DATE_CHUNK)
  const started = Date.now()

  for (let i = 0; i < dates.length; i += DATE_CHUNK) {
    const chunkDates = dates.slice(i, i + DATE_CHUNK)
    const rows = await loadChunkStats(chunkDates)
    addRows(accumulators, rows)

    const chunkNo = Math.floor(i / DATE_CHUNK) + 1
    if (chunkNo % 5 === 0 || chunkNo === totalChunks) {
      const elapsed = ((Date.now() - started) / 60000).toFixed(1)
      const from = chunkDates[chunkDates.length - 1]
      const to = chunkDates[0]
      console.log(`[${chunkNo}/${totalChunks}] ${from}..${to} groups=${accumulators.size} elapsed=${elapsed}m`)
    }
  }

  const rows = finalizeRows(accumulators)
  await insertRows(rows)
  console.log(`signal_stats complete: ${rows.length} rows (date-range aggregate)`)
}

main().catch((error) => {
  console.error('batch-signal-stats failed:', error)
  process.exit(1)
})
