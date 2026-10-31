// scripts/batch-ohlcv.ts
//
// 日足 OHLCV を J-Quants API から取得して ohlcv_daily に蓄積するバッチ。
// (Phase 3.5 で Yahoo 分岐を削除、J-Quants 一本化)
//
// 使い方:
//   USE_LOCAL_DB=1 npm run batch:ohlcv                                  # 全銘柄、差分取得
//   TICKERS=7203,6758 USE_LOCAL_DB=1 npm run batch:ohlcv                # 銘柄絞り込み
//   HISTORY_FROM=2016-05-13 USE_LOCAL_DB=1 npm run batch:ohlcv          # 初回フルフェッチ用
//
// 環境変数:
//   USE_LOCAL_DB        '1' でローカル SQLite を強制 (Turso クォータ回避)
//   TICKERS             カンマ区切りで銘柄を絞り込み (テスト用)
//   HISTORY_FROM        ISO 日付 (YYYY-MM-DD) で取得開始日を上書き (初回フェッチ時のみ意味あり)
//   OHLCV_FORCE_FULL_HISTORY  '1' で対象銘柄の全履歴を再取得 (分割調整の修復用)
//   OHLCV_LEGACY_ADJUSTMENT_FACTOR  取得期間外の旧履歴へ適用する係数 (対象を絞った修復時のみ)
//
// 動作:
//   - 各銘柄について ohlcv_daily の最新日付を確認、それ以降の差分のみ取得 (冪等)
//   - エラー発生時は MAX_RETRIES 回まで指数バックオフ
//   - 失敗銘柄は batch_runs.error_summary に記録、バッチは続行

import { spawn } from 'node:child_process'
import { client, db, execAll, execGet, execRun } from '@/lib/db/client'
import { ohlcvDaily } from '@/lib/db/schema'
import {
  fetchJQuantsDaily,
  fetchJQuantsDailyByDateWithEvidence,
  hasJQuantsCorporateAction,
  isLikelyJQuantsCorporateActionBoundary,
  shouldApplyJQuantsLegacyAdjustment,
  type JQuantsDailyByDateRow,
} from '@/lib/jquants'
import {
  classifyJpFetchFailure,
  evaluateJpDailyCoverage,
  findJpHistoricalCoverageGaps,
  historicalCoverageDates,
} from '@/lib/jp-ohlcv-data-quality'
import { applyJpOhlcvIngestionBoundary } from '@/lib/jp-ohlcv-ingestion-boundary'
import { publishJpOhlcvSourceRun } from '@/lib/jp-ohlcv-coverage-store'
import { expectedLatestTradingDate } from '@/lib/server/data-freshness'
import { getJpTradingDates } from '@/lib/server/jp-market-calendar'
import {
  clearJpOhlcvSourceRunChild,
  jpOhlcvProcessGroupStatus,
  registerJpOhlcvSourceRunChild,
  startJpOhlcvSourceRun,
} from '@/lib/jp-ohlcv-source-run-recovery'
import type { OHLCV } from '@/types/stock'
import { sql } from 'drizzle-orm'

function positiveIntegerSetting(value: string | undefined, fallback: number, minimum: number): number {
  const parsed = Number(value ?? fallback)
  return Number.isSafeInteger(parsed) && parsed >= minimum ? parsed : fallback
}

function isValidIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const parsed = new Date(`${value}T00:00:00.000Z`)
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value
}

const RATE_LIMIT_MS = Number(process.env.OHLCV_RATE_LIMIT_MS ?? 0)
const CONCURRENCY = positiveIntegerSetting(process.env.OHLCV_CONCURRENCY, 8, 1)
const MAX_RETRIES = positiveIntegerSetting(process.env.OHLCV_MAX_RETRIES, 4, 1)
const PROGRESS_EVERY = positiveIntegerSetting(process.env.OHLCV_PROGRESS_EVERY, 100, 1)
const HISTORICAL_COVERAGE_LOOKBACK = positiveIntegerSetting(
  process.env.OHLCV_COVERAGE_LOOKBACK_TRADING_DAYS,
  260,
  20,
)

// 取得開始日: HISTORY_FROM があればそれ、なければ Standard プラン上限 (今日から 10 年前) を試行
const DEFAULT_FROM_DATE: string =
  process.env.HISTORY_FROM
  ?? new Date(Date.now() - 10 * 365 * 86_400_000).toISOString().slice(0, 10)
const TARGET_DATE = process.env.OHLCV_TARGET_DATE ?? expectedLatestTradingDate()
const USE_DATE_BULK = process.env.OHLCV_USE_DATE_BULK !== '0'
const ENABLE_MISSING_FALLBACK = process.env.OHLCV_ENABLE_MISSING_FALLBACK === '1'
const FORCE_FULL_HISTORY = process.env.OHLCV_FORCE_FULL_HISTORY === '1'
const configuredLegacyAdjustmentFactor = Number(process.env.OHLCV_LEGACY_ADJUSTMENT_FACTOR)
const LEGACY_ADJUSTMENT_FACTOR = Number.isFinite(configuredLegacyAdjustmentFactor)
  && configuredLegacyAdjustmentFactor > 0
  ? configuredLegacyAdjustmentFactor
  : null

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

type RunResult = {
  code: number | null
  signal: NodeJS.Signals | null
}

async function stopAndVerifyChildProcessGroup(processGroupId: number): Promise<void> {
  let status = jpOhlcvProcessGroupStatus(processGroupId)
  if (status === 'UNKNOWN') throw new Error('child_process_group_liveness_unknown')
  if (status === 'LIVE') {
    try { process.kill(-processGroupId, 'SIGTERM') } catch { /* re-probe below */ }
    const gracefulDeadline = Date.now() + 2_000
    while (Date.now() < gracefulDeadline && (status = jpOhlcvProcessGroupStatus(processGroupId)) === 'LIVE') {
      await sleep(25)
    }
    if (status === 'LIVE') {
      try { process.kill(-processGroupId, 'SIGKILL') } catch { /* re-probe below */ }
    }
  }
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    status = jpOhlcvProcessGroupStatus(processGroupId)
    if (status === 'DEAD') return
    if (status === 'UNKNOWN') throw new Error('child_process_group_liveness_unknown')
    await sleep(25)
  }
  throw new Error('child_process_group_still_active')
}

async function runScript(script: string, sourceRunId: number): Promise<RunResult> {
  const child = spawn(process.execPath, [
    '--import',
    'tsx',
    'scripts/lib/run-jp-ohlcv-registered-child.ts',
    script,
  ], {
    cwd: process.cwd(),
    detached: true,
    stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    env: {
      ...process.env,
      USE_LOCAL_DB: '1',
      JP_OHLCV_BATCH_PARENT_PID: String(process.pid),
    },
  })
  await new Promise<void>((resolve, reject) => {
    child.once('spawn', resolve)
    child.once('error', reject)
  })
  if (!child.pid) throw new Error(`child_process_identity_unavailable:${script}`)
  try {
    await registerJpOhlcvSourceRunChild(client, { sourceRunId, childPid: child.pid })
    await new Promise<void>((resolve, reject) => {
      child.send({ type: 'START' }, (error) => error ? reject(error) : resolve())
    })
  } catch (error) {
    try {
      await stopAndVerifyChildProcessGroup(child.pid)
      await clearJpOhlcvSourceRunChild(client, sourceRunId)
    } catch (cleanupError) {
      throw new Error(
        `child_process_group_safety_hold:${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`,
        { cause: error },
      )
    }
    throw error
  }
  try {
    const result = await new Promise<RunResult>((resolve, reject) => {
      child.once('error', reject)
      child.once('close', (code, signal) => resolve({ code, signal }))
    })
    await stopAndVerifyChildProcessGroup(child.pid)
    await clearJpOhlcvSourceRunChild(client, sourceRunId)
    return result
  } catch (error) {
    try {
      await stopAndVerifyChildProcessGroup(child.pid)
      await clearJpOhlcvSourceRunChild(client, sourceRunId)
    } catch (cleanupError) {
      throw new Error(
        `child_process_group_safety_hold:${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`,
        { cause: error },
      )
    }
    throw error
  }
}

async function refreshAfterOhlcv(sourceRunId: number): Promise<void> {
  if (process.env.POST_OHLCV_REFRESH === '0') {
    console.log('Post-OHLCV refresh skipped: POST_OHLCV_REFRESH=0')
    return
  }

  console.log('\n▶ scripts/refresh-after-ohlcv.ts')
  const result = await runScript('scripts/refresh-after-ohlcv.ts', sourceRunId)
  if (result.code !== 0) {
    throw new Error(`scripts/refresh-after-ohlcv.ts failed: code=${result.code}, signal=${result.signal ?? 'none'}`)
  }
}

async function withDbRetry<T>(fn: () => Promise<T>): Promise<T> {
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      return await fn()
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (attempt === 5 || !/busy|locked|SQLITE_BUSY/i.test(msg)) throw err
      await sleep(250 * attempt)
    }
  }
  throw new Error('unreachable')
}

type SyncEvidence = {
  expectedRows: number
  importedRows: number
  missingTickersJson: string
}

async function finalizeHeldSourceAndSync(input: {
  sourceRunId: number
  syncRunId: number
  status: 'failed' | 'partial'
  totalTickers: number
  succeeded: number
  failed: number
  rowsInserted: number
  errorSummary: string
  syncEvidence: SyncEvidence | null
}): Promise<void> {
  const transaction = await client.transaction('write')
  try {
    const sync = input.syncEvidence
      ? await transaction.execute({
          sql: `UPDATE jquants_sync_runs
                SET expected_rows = ?, imported_rows = ?, missing_tickers = ?, status = ?,
                    finished_at = unixepoch(), error_summary = ?
                WHERE id = ? AND status = 'running'`,
          args: [
            input.syncEvidence.expectedRows,
            input.syncEvidence.importedRows,
            input.syncEvidence.missingTickersJson,
            input.status,
            input.errorSummary,
            input.syncRunId,
          ],
        })
      : await transaction.execute({
          sql: `UPDATE jquants_sync_runs
                SET status = ?, finished_at = unixepoch(), error_summary = ?
                WHERE id = ? AND status = 'running'`,
          args: [input.status, input.errorSummary, input.syncRunId],
        })
    if (sync.rowsAffected !== 1) throw new Error('jp_ohlcv_sync_run_finalize_compare_and_swap_failed')
    const source = await transaction.execute({
      sql: `UPDATE batch_runs
            SET finished_at = unixepoch(), status = ?, total_tickers = ?, succeeded = ?,
                failed = ?, rows_inserted = ?, error_summary = ?
            WHERE id = ? AND job_type = 'ohlcv_fetch:jquants' AND status = 'running'`,
      args: [
        input.status,
        input.totalTickers,
        input.succeeded,
        input.failed,
        input.rowsInserted,
        input.errorSummary,
        input.sourceRunId,
      ],
    })
    if (source.rowsAffected !== 1) throw new Error('jp_ohlcv_source_run_finalize_compare_and_swap_failed')
    await transaction.commit()
  } catch (error) {
    try { await transaction.rollback() } catch { /* preserve the original failure */ }
    throw error
  }
}

async function fetchDateWithRetry(date: string) {
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt += 1) {
    try {
      return await fetchJQuantsDailyByDateWithEvidence(date)
    } catch (error) {
      const classified = classifyJpFetchFailure(error)
      console.warn(JSON.stringify({
        event: 'jquants_date_fetch_failed',
        date,
        attempt,
        maxAttempts: MAX_RETRIES,
        category: classified.category,
        httpStatus: classified.httpStatus,
        retryable: classified.retryable,
      }))
      if (!classified.retryable || attempt === MAX_RETRIES) throw error
      await sleep((classified.category === 'RATE_LIMIT' ? 5_000 : 1_000) * attempt)
    }
  }
  throw new Error('jquants_date_fetch_retry_exhausted')
}

async function recentDateCounts(targetDate: string, limit = 10): Promise<number[]> {
  const rows = await execAll<{ count: number }>(
    `
      SELECT COUNT(*) AS count
      FROM ohlcv_daily
      WHERE date < ?
      GROUP BY date
      ORDER BY date DESC
      LIMIT ?
    `,
    [targetDate, limit],
  )
  return rows.map((row) => Number(row.count)).filter((count) => Number.isSafeInteger(count) && count > 0)
}

async function fetchAndStoreForTicker(
  ticker: string,
  lastDate: string | null,
  options: { fullHistory?: boolean; legacyAdjustmentFactor?: number | null } = {},
): Promise<number> {
  const fromDate = options.fullHistory ? undefined : (lastDate ?? DEFAULT_FROM_DATE)

  // フェッチ (リトライ付き、指数バックオフ)
  let data: OHLCV[] = []
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      data = await fetchJQuantsDaily(ticker, fromDate)
      break
    } catch (err) {
      if (attempt === MAX_RETRIES) throw err
      const msg = err instanceof Error ? err.message : String(err)
      const penalty = msg.includes('429') ? 5000 : 1000
      await sleep(penalty * attempt)
    }
  }

  if (data.length === 0) return 0

  const providerStartDate = data[0].date
  const legacyAdjustmentFactor = options.legacyAdjustmentFactor
  let applyLegacyAdjustment = false
  if (options.fullHistory && hasJQuantsCorporateAction(legacyAdjustmentFactor)) {
    const [existingProviderStart, legacyLast] = await Promise.all([
      execGet<{ close: number }>(
        'SELECT close FROM ohlcv_daily WHERE ticker = ? AND date = ?',
        [ticker, providerStartDate],
      ),
      execGet<{ close: number }>(
        'SELECT close FROM ohlcv_daily WHERE ticker = ? AND date < ? ORDER BY date DESC LIMIT 1',
        [ticker, providerStartDate],
      ),
    ])
    applyLegacyAdjustment = shouldApplyJQuantsLegacyAdjustment({
      adjustmentFactor: legacyAdjustmentFactor,
      adjustedProviderStartClose: data[0].close,
      existingProviderStartClose: existingProviderStart?.close,
      legacyLastClose: legacyLast?.close,
    })
  }

  // チャンク分割で UPSERT (libSQL の SQL 長制限対策)
  const CHUNK = 200
  for (let i = 0; i < data.length; i += CHUNK) {
    const chunk = data.slice(i, i + CHUNK).map(d => ({ ticker, ...d }))
    await withDbRetry(() =>
      db
        .insert(ohlcvDaily)
        .values(chunk)
        .onConflictDoUpdate({
          target: [ohlcvDaily.ticker, ohlcvDaily.date],
          set: {
            open:   sql`excluded.open`,
            high:   sql`excluded.high`,
            low:    sql`excluded.low`,
            close:  sql`excluded.close`,
            volume: sql`excluded.volume`,
          },
        }),
    )
  }

  if (applyLegacyAdjustment) {
    await withDbRetry(() => execRun(
      `
        UPDATE ohlcv_daily
        SET open = open * ?,
            high = high * ?,
            low = low * ?,
            close = close * ?,
            volume = CAST(ROUND(volume / ?) AS INTEGER)
        WHERE ticker = ? AND date < ?
      `,
      [
        legacyAdjustmentFactor!,
        legacyAdjustmentFactor!,
        legacyAdjustmentFactor!,
        legacyAdjustmentFactor!,
        legacyAdjustmentFactor!,
        ticker,
        providerStartDate,
      ],
    ))
    console.log(
      `${ticker}: adjusted legacy rows before ${providerStartDate} with factor=${legacyAdjustmentFactor}`,
    )
  }

  return data.length
}

async function storeRows(rows: JQuantsDailyByDateRow[], sourceRunId: number): Promise<{
  inserted: number
  stored: number
  sourcePublication: 'PUBLISHABLE' | 'PARTIAL_HOLD' | 'HOLD'
}> {
  if (rows.length === 0) return { inserted: 0, stored: 0, sourcePublication: 'HOLD' }
  const date = rows[0].date
  if (rows.some((row) => row.date !== date)) throw new Error('jquants_date_response_contains_multiple_dates')
  const boundary = await withDbRetry(() => applyJpOhlcvIngestionBoundary(client, {
    sourceRunId,
    targetDate: date,
    officialRows: rows,
    requireRunningBatchRun: true,
  }))
  const stored = await execGet<{ count: number }>(
    'SELECT COUNT(*) AS count FROM ohlcv_daily WHERE date = ?',
    [date],
  )
  return {
    inserted: boundary.inserted,
    stored: Number(stored?.count ?? 0),
    sourcePublication: boundary.sourcePublication,
  }
}

async function historicalCoverageGaps(targetDate: string) {
  const start = new Date(`${targetDate}T00:00:00Z`)
  start.setUTCDate(start.getUTCDate() - Math.ceil(HISTORICAL_COVERAGE_LOOKBACK * 1.7))
  const from = start.toISOString().slice(0, 10)
  const tradingDates = historicalCoverageDates(
    getJpTradingDates(from, targetDate).slice(-HISTORICAL_COVERAGE_LOOKBACK),
    targetDate,
  )
  if (tradingDates.length === 0) return []
  const rows = await execAll<{ date: string; count: number }>(
    `
      SELECT date, COUNT(*) AS count
      FROM ohlcv_daily
      WHERE date BETWEEN ? AND ?
      GROUP BY date
      ORDER BY date
    `,
    [tradingDates[0], tradingDates[tradingDates.length - 1]],
  )
  const rowsByDate = new Map(rows.map((row) => [row.date, Number(row.count)]))
  const referenceRows = rows.map((row) => Number(row.count))
    .filter((count) => Number.isSafeInteger(count) && count > 0)
    .sort((left, right) => right - left)
    .slice(0, Math.min(20, rows.length))
  return findJpHistoricalCoverageGaps({ tradingDates, rowsByDate, referenceRows })
}

async function findCorporateActionBoundaryCandidates(
  targetDate: string,
  incomingRows: readonly JQuantsDailyByDateRow[],
): Promise<string[]> {
  const previousRows = new Map<string, {
    ticker: string
    previousDate: string | null
    previousClose: number | null
  }>()
  const tickers = [...new Set(incomingRows.map((row) => row.ticker))]
  for (let offset = 0; offset < tickers.length; offset += 500) {
    const chunk = tickers.slice(offset, offset + 500)
    const placeholders = chunk.map(() => '?').join(',')
    const rows = await execAll<{
      ticker: string
      previousDate: string | null
      previousClose: number | null
    }>(
      `SELECT history.ticker,
              history.date AS previousDate,
              history.close AS previousClose
       FROM ohlcv_daily history
       WHERE history.ticker IN (${placeholders})
         AND history.date = (
           SELECT MAX(previous.date)
           FROM ohlcv_daily previous
           WHERE previous.ticker = history.ticker AND previous.date < ?
         )`,
      [...chunk, targetDate],
    )
    for (const row of rows) previousRows.set(row.ticker, row)
  }

  return incomingRows
    .filter((row) => isLikelyJQuantsCorporateActionBoundary({
      previousDate: previousRows.get(row.ticker)?.previousDate ?? null,
      currentDate: row.date,
      previousClose: previousRows.get(row.ticker)?.previousClose ?? null,
      currentClose: row.close,
    }))
    .map((row) => row.ticker)
}

async function main() {
  console.log(`SOURCE=jquants, HISTORY_FROM=${DEFAULT_FROM_DATE}, TARGET_DATE=${TARGET_DATE}, CONCURRENCY=${CONCURRENCY}, RATE_LIMIT=${RATE_LIMIT_MS}ms, FORCE_FULL_HISTORY=${FORCE_FULL_HISTORY}`)

  const tickerFilter = process.env.TICKERS?.split(',').map(s => s.trim()).filter(Boolean)
  if (!isValidIsoDate(TARGET_DATE)
    || !USE_DATE_BULK || tickerFilter?.length || FORCE_FULL_HISTORY || ENABLE_MISSING_FALLBACK) {
    throw new Error('jp_ohlcv_normal_updater_requires_date_bulk_boundary')
  }
  const execution = await startJpOhlcvSourceRun(client, { targetDate: TARGET_DATE })
  const runId = execution.sourceRunId
  const syncRunId = execution.syncRunId

  // 対象銘柄
  let tickers: { ticker: string; lastDate: string | null }[]
  if (tickerFilter && tickerFilter.length > 0) {
    const placeholders = tickerFilter.map(() => '?').join(',')
    const latestRows = await execAll<{ ticker: string; lastDate: string | null }>(
      `SELECT ticker, MAX(date) AS lastDate FROM ohlcv_daily WHERE ticker IN (${placeholders}) GROUP BY ticker`,
      tickerFilter,
    )
    const latestByTicker = new Map(latestRows.map(r => [r.ticker, r.lastDate]))
    tickers = tickerFilter.map(ticker => ({ ticker, lastDate: latestByTicker.get(ticker) ?? null }))
    console.log(`TICKERS env で絞り込み: ${tickers.length} 銘柄`)
  } else {
    tickers = await execAll<{ ticker: string; lastDate: string | null }>(`
      SELECT u.ticker, MAX(o.date) AS lastDate
      FROM ticker_universe u
      LEFT JOIN ohlcv_daily o ON o.ticker = u.ticker
      WHERE u.active = 1
      GROUP BY u.ticker
      HAVING COALESCE(MAX(o.date), '') < ?
      ORDER BY u.ticker
    `, [TARGET_DATE])
  }

  const initialTickerCount = tickers.length
  let succeeded = 0
  let failed = 0
  let rowsInserted = 0
  const errors: string[] = []
  let dateBulkFatalError: string | null = null
  let sourcePublicationError: string | null = null
  let pendingSyncEvidence: SyncEvidence | null = null

  console.log(`OHLCV fetch 開始: ${tickers.length} 銘柄`)
  const startTime = Date.now()

  if (USE_DATE_BULK && !tickerFilter && TARGET_DATE) {
    try {
      console.log(`J-Quants date bulk fetch: ${TARGET_DATE}`)
      const evidence = await fetchDateWithRetry(TARGET_DATE)
      const rows = evidence.rows
      const referenceRows = await recentDateCounts(TARGET_DATE)
      const providerCoverage = evaluateJpDailyCoverage({
        providerRows: evidence.acceptedRows,
        storedRows: evidence.acceptedRows,
        referenceRows,
      })
      if (providerCoverage.status !== 'PASS') {
        throw new Error(`jquants_provider_coverage_hold:${JSON.stringify(providerCoverage)}`)
      }
      const explicitCorporateActionTickers = Array.from(new Set(
        rows
          .filter(row => hasJQuantsCorporateAction(row.adjustmentFactor))
          .map(row => row.ticker),
      ))
      const boundaryCorporateActionTickers = await findCorporateActionBoundaryCandidates(TARGET_DATE, rows)
      const corporateActionTickers = Array.from(new Set([
        ...explicitCorporateActionTickers,
        ...boundaryCorporateActionTickers,
      ]))
      if (corporateActionTickers.length > 0) {
        throw new Error(
          `jquants_corporate_action_requires_approved_history_boundary:${corporateActionTickers.join(',')}`,
        )
      }
      const stored = await storeRows(rows, runId)
      if (stored.sourcePublication !== 'PUBLISHABLE') {
        sourcePublicationError = `jp_ohlcv_source_publication_hold:${stored.sourcePublication}`
        errors.push(sourcePublicationError)
      }
      const storedCoverage = evaluateJpDailyCoverage({
        providerRows: evidence.acceptedRows,
        storedRows: stored.stored,
        referenceRows,
      })
      if (storedCoverage.status !== 'PASS') {
        throw new Error(`jquants_stored_coverage_hold:${JSON.stringify(storedCoverage)}`)
      }
      const adjustedHistoryRows = 0
      const rowTickerSet = new Set(rows.map(r => r.ticker))
      const missingTickers = tickers
        .filter(t => !rowTickerSet.has(t.ticker))
        .map(t => t.ticker)

      rowsInserted += stored.inserted + adjustedHistoryRows
      succeeded += Math.max(0, tickers.length - missingTickers.length)
      pendingSyncEvidence = {
        expectedRows: storedCoverage.expectedRows,
        importedRows: stored.stored,
        missingTickersJson: JSON.stringify(missingTickers),
      }
      console.log(
        `J-Quants date bulk 完了: expected=${storedCoverage.expectedRows}, provider=${evidence.providerRows}, stored=${stored.stored}, inserted=${stored.inserted}, corporateActions=${explicitCorporateActionTickers.length}, boundaryCandidates=${boundaryCorporateActionTickers.length}, adjustedHistoryRows=${adjustedHistoryRows}`,
      )
      tickers = tickers.filter(t => !rowTickerSet.has(t.ticker))
      if (tickers.length > 0 && !ENABLE_MISSING_FALLBACK) {
        console.log(`missing ${tickers.length} tickers after date bulk; per-ticker fallback is disabled`)
        tickers = []
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      const classified = classifyJpFetchFailure(err)
      console.warn(`J-Quants date bulk をスキップ: ${message}`)
      dateBulkFatalError = message
      failed += tickers.length
      errors.push(`date_bulk_fail_closed:${classified.category}:${message}`)
      tickers = []
    }
  }
  let nextIndex = 0
  let processed = 0

  async function worker(workerId: number) {
    while (true) {
      const i = nextIndex++
      const item = tickers[i]
      if (!item) return
      const { ticker, lastDate } = item
      try {
        const count = await fetchAndStoreForTicker(ticker, lastDate, {
          fullHistory: FORCE_FULL_HISTORY,
          legacyAdjustmentFactor: FORCE_FULL_HISTORY ? LEGACY_ADJUSTMENT_FACTOR : null,
        })
        succeeded++
        rowsInserted += count
      } catch (err) {
        failed++
        const msg = `${ticker}: ${err instanceof Error ? err.message : String(err)}`
        errors.push(msg)
        console.error(`✗ worker=${workerId} ${msg}`)
      } finally {
        processed++
        if (processed % PROGRESS_EVERY === 0 || processed === tickers.length) {
          const pct = ((processed / tickers.length) * 100).toFixed(1)
          const elapsedMin = ((Date.now() - startTime) / 60000).toFixed(1)
          console.log(`[${processed}/${tickers.length} ${pct}%] 累計 ${rowsInserted} rows / 成功 ${succeeded} / 失敗 ${failed} / 経過 ${elapsedMin}min`)
        }
        if (RATE_LIMIT_MS > 0) await sleep(RATE_LIMIT_MS)
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, tickers.length) }, (_, i) => worker(i + 1)),
  )

  let historicalCoverageError: string | null = null
  try {
    const gaps = await historicalCoverageGaps(TARGET_DATE)
    if (gaps.length > 0) {
      historicalCoverageError = `unresolved_historical_ohlcv_coverage:${JSON.stringify(gaps.slice(0, 20))}`
      errors.push(historicalCoverageError)
      console.error(historicalCoverageError)
    }
  } catch (error) {
    historicalCoverageError = `historical_coverage_audit_failed:${error instanceof Error ? error.message : String(error)}`
    errors.push(historicalCoverageError)
    console.error(historicalCoverageError)
  }

  let postRefreshError: string | null = null
  const fetchStatus =
    failed === 0 ? 'success' :
    succeeded === 0 ? 'failed' :
    'partial'

  if (fetchStatus !== 'failed' && !dateBulkFatalError && !historicalCoverageError && !sourcePublicationError) {
    try {
      await refreshAfterOhlcv(runId)
    } catch (err) {
      postRefreshError = err instanceof Error ? err.message : String(err)
      if (postRefreshError.startsWith('child_process_group_safety_hold:')) throw err
      errors.push(`post_ohlcv_refresh: ${postRefreshError}`)
      console.error(`Post-OHLCV refresh failed: ${postRefreshError}`)
    }
  }

  // 終了記録。後段更新が失敗した場合、OHLCV取得だけ成功しても success にはしない。
  const finalStatus = (postRefreshError || dateBulkFatalError || historicalCoverageError || sourcePublicationError) && fetchStatus === 'success'
    ? 'partial'
    : fetchStatus

  const errorSummary = JSON.stringify(errors.slice(0, 10))
  if (finalStatus === 'success') {
    if (!pendingSyncEvidence) throw new Error('jp_ohlcv_sync_publication_evidence_missing')
    try {
      await publishJpOhlcvSourceRun(client, {
        sourceRunId: runId,
        targetDate: TARGET_DATE,
        totalTickers: initialTickerCount,
        succeeded,
        failed,
        rowsInserted,
        errorSummary,
        syncRun: { id: syncRunId, ...pendingSyncEvidence },
      })
    } catch (error) {
      const message = `jp_ohlcv_source_publication_failed:${error instanceof Error ? error.message : String(error)}`
      await finalizeHeldSourceAndSync({
        sourceRunId: runId,
        syncRunId,
        status: 'partial',
        totalTickers: initialTickerCount,
        succeeded,
        failed,
        rowsInserted,
        errorSummary: JSON.stringify([...errors, message].slice(0, 10)),
        syncEvidence: pendingSyncEvidence,
      })
      throw new Error(message)
    }
  } else {
    await finalizeHeldSourceAndSync({
      sourceRunId: runId,
      syncRunId,
      status: finalStatus,
      totalTickers: initialTickerCount,
      succeeded,
      failed,
      rowsInserted,
      errorSummary,
      syncEvidence: pendingSyncEvidence,
    })
  }

  console.log(`完了: ${succeeded} 成功 / ${failed} 失敗 / 計 ${rowsInserted} 行 / ステータス: ${finalStatus}`)
  if (postRefreshError) {
    throw new Error(`OHLCV fetched but post-refresh failed: ${postRefreshError}`)
  }
  if (dateBulkFatalError) {
    throw new Error(`OHLCV date bulk failed closed: ${dateBulkFatalError}`)
  }
  if (historicalCoverageError) {
    throw new Error(`OHLCV current date fetched but historical coverage remains unresolved: ${historicalCoverageError}`)
  }
  if (sourcePublicationError) {
    throw new Error(`OHLCV source publication held: ${sourcePublicationError}`)
  }
  if (finalStatus !== 'success') {
    throw new Error(`OHLCV update incomplete: status=${finalStatus}, succeeded=${succeeded}, failed=${failed}`)
  }
}

main().catch(err => {
  console.error('Fatal:', err)
  process.exit(1)
})
