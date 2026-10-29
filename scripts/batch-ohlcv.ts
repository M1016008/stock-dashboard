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
import { db, execAll, execGet, execRun } from '@/lib/db/client'
import { ohlcvDaily, batchRuns, jquantsDailyCoverage, jquantsSyncRuns } from '@/lib/db/schema'
import {
  fetchJQuantsDaily,
  fetchJQuantsDailyByDateWithEvidence,
  hasJQuantsCorporateAction,
  isLikelyJQuantsCorporateActionBoundary,
  shouldApplyJQuantsLegacyAdjustment,
  type JQuantsDailyByDateRow,
} from '@/lib/jquants'
import {
  buildJpOhlcvBackfillPlan,
  classifyJpFetchFailure,
  evaluateJpDailyCoverage,
  findJpHistoricalCoverageGaps,
  historicalCoverageDates,
  type JpOhlcvValue,
} from '@/lib/jp-ohlcv-data-quality'
import { expectedLatestTradingDate } from '@/lib/server/data-freshness'
import { getJpTradingDates } from '@/lib/server/jp-market-calendar'
import type { OHLCV } from '@/types/stock'
import { eq, sql } from 'drizzle-orm'

function positiveIntegerSetting(value: string | undefined, fallback: number, minimum: number): number {
  const parsed = Number(value ?? fallback)
  return Number.isSafeInteger(parsed) && parsed >= minimum ? parsed : fallback
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

function runScript(script: string): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn('npx', ['tsx', '--env-file=.env.local', script], {
      cwd: process.cwd(),
      stdio: 'inherit',
      env: {
        ...process.env,
        USE_LOCAL_DB: '1',
      },
    })

    child.on('error', reject)
    child.on('close', (code, signal) => resolve({ code, signal }))
  })
}

async function refreshAfterOhlcv(): Promise<void> {
  if (process.env.POST_OHLCV_REFRESH === '0') {
    console.log('Post-OHLCV refresh skipped: POST_OHLCV_REFRESH=0')
    return
  }

  console.log('\n▶ scripts/refresh-after-ohlcv.ts')
  const result = await runScript('scripts/refresh-after-ohlcv.ts')
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

async function storeRows(rows: JQuantsDailyByDateRow[]): Promise<{ inserted: number; stored: number }> {
  if (rows.length === 0) return { inserted: 0, stored: 0 }
  const date = rows[0].date
  if (rows.some((row) => row.date !== date)) throw new Error('jquants_date_response_contains_multiple_dates')
  const existingRows = await execAll<JpOhlcvValue>(
    'SELECT ticker, date, open, high, low, close, volume FROM ohlcv_daily WHERE date = ? ORDER BY ticker',
    [date],
  )
  const plan = buildJpOhlcvBackfillPlan({ date, officialRows: rows, existingRows })
  if (plan.status !== 'READY') {
    const reasons = Array.from(new Set(plan.conflicts.map((conflict) => conflict.reason)))
    const samples = plan.conflicts.slice(0, 5).map((conflict) => ({
      ticker: conflict.ticker,
      reason: conflict.reason,
      validationReason: conflict.validationReason ?? null,
    }))
    throw new Error(
      `jquants_existing_rows_conflict:${date}:count=${plan.conflicts.length}:reasons=${reasons.join(',')}:samples=${JSON.stringify(samples)}:action=run_audit_jp_ohlcv_gap`,
    )
  }
  const CHUNK = 200
  for (let i = 0; i < plan.missingRows.length; i += CHUNK) {
    const chunk = plan.missingRows.slice(i, i + CHUNK).map(({ adjustmentFactor: _adjustmentFactor, ...row }) => row)
    await withDbRetry(() =>
      db
        .insert(ohlcvDaily)
        .values(chunk)
        .onConflictDoNothing(),
    )
  }
  const stored = await execGet<{ count: number }>(
    'SELECT COUNT(*) AS count FROM ohlcv_daily WHERE date = ?',
    [date],
  )
  return { inserted: plan.missingRows.length, stored: Number(stored?.count ?? 0) }
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

async function findCorporateActionBoundaryCandidates(targetDate: string): Promise<string[]> {
  const rows = await execAll<{
    ticker: string
    currentDate: string
    currentClose: number
    previousDate: string | null
    previousClose: number | null
  }>(
    `
      SELECT current.ticker,
             current.date AS currentDate,
             current.close AS currentClose,
             previous.date AS previousDate,
             previous.close AS previousClose
      FROM ohlcv_daily current
      LEFT JOIN ohlcv_daily previous
        ON previous.ticker = current.ticker
       AND previous.date = (
         SELECT MAX(history.date)
         FROM ohlcv_daily history
         WHERE history.ticker = current.ticker
           AND history.date < current.date
       )
      WHERE current.date = ?
    `,
    [targetDate],
  )

  return rows
    .filter((row) => isLikelyJQuantsCorporateActionBoundary({
      previousDate: row.previousDate,
      currentDate: row.currentDate,
      previousClose: row.previousClose,
      currentClose: row.currentClose,
    }))
    .map((row) => row.ticker)
}

async function main() {
  console.log(`SOURCE=jquants, HISTORY_FROM=${DEFAULT_FROM_DATE}, TARGET_DATE=${TARGET_DATE}, CONCURRENCY=${CONCURRENCY}, RATE_LIMIT=${RATE_LIMIT_MS}ms, FORCE_FULL_HISTORY=${FORCE_FULL_HISTORY}`)

  // 開始記録
  const [run] = await db
    .insert(batchRuns)
    .values({
      jobType: 'ohlcv_fetch:jquants',
      startedAt: new Date(),
      status: 'running',
    })
    .returning({ id: batchRuns.id })

  const runId = run.id

  // 対象銘柄
  const tickerFilter = process.env.TICKERS?.split(',').map(s => s.trim()).filter(Boolean)
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

  console.log(`OHLCV fetch 開始: ${tickers.length} 銘柄`)
  const startTime = Date.now()

  if (USE_DATE_BULK && !tickerFilter && TARGET_DATE) {
    const [syncRun] = await db
      .insert(jquantsSyncRuns)
      .values({
        targetDate: TARGET_DATE,
        apiType: 'equities/bars/daily:date',
        status: 'running',
      })
      .returning({ id: jquantsSyncRuns.id })

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
      const stored = await storeRows(rows)
      const storedCoverage = evaluateJpDailyCoverage({
        providerRows: evidence.acceptedRows,
        storedRows: stored.stored,
        referenceRows,
      })
      if (storedCoverage.status !== 'PASS') {
        throw new Error(`jquants_stored_coverage_hold:${JSON.stringify(storedCoverage)}`)
      }
      const explicitCorporateActionTickers = Array.from(new Set(
        rows
          .filter(row => hasJQuantsCorporateAction(row.adjustmentFactor))
          .map(row => row.ticker),
      ))
      const boundaryCorporateActionTickers = await findCorporateActionBoundaryCandidates(TARGET_DATE)
      const corporateActionTickers = Array.from(new Set([
        ...explicitCorporateActionTickers,
        ...boundaryCorporateActionTickers,
      ]))
      let adjustedHistoryRows = 0
      for (const ticker of corporateActionTickers) {
        const adjustmentFactor = rows.find(row => row.ticker === ticker)?.adjustmentFactor ?? null
        console.log(`${ticker}: adjustment factor detected; refreshing J-Quants adjusted full history`)
        adjustedHistoryRows += await fetchAndStoreForTicker(ticker, null, {
          fullHistory: true,
          legacyAdjustmentFactor: adjustmentFactor,
        })
      }
      const rowTickerSet = new Set(rows.map(r => r.ticker))
      const missingTickers = tickers
        .filter(t => !rowTickerSet.has(t.ticker))
        .map(t => t.ticker)

      rowsInserted += stored.inserted + adjustedHistoryRows
      succeeded += Math.max(0, tickers.length - missingTickers.length)
      await db
        .insert(jquantsDailyCoverage)
        .values({ date: TARGET_DATE, expectedRows: storedCoverage.expectedRows })
        .onConflictDoUpdate({
          target: jquantsDailyCoverage.date,
          set: {
            expectedRows: sql`excluded.expected_rows`,
            importedAt: sql`unixepoch()`,
          },
        })
      await db
        .update(jquantsSyncRuns)
        .set({
          expectedRows: storedCoverage.expectedRows,
          importedRows: stored.stored,
          missingTickers: JSON.stringify(missingTickers),
          status: 'success',
          finishedAt: new Date(),
        })
        .where(eq(jquantsSyncRuns.id, syncRun.id))
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
      const failClosed = /jquants_provider_coverage_hold|jquants_stored_coverage_hold|jquants_existing_rows_conflict|jquants_date_response_contains_multiple_dates/.test(message)
        || ['AUTH', 'HTTP_CLIENT', 'INVALID_RESPONSE'].includes(classified.category)
      console.warn(`J-Quants date bulk をスキップ: ${message}`)
      await db
        .update(jquantsSyncRuns)
        .set({
          status: 'failed',
          finishedAt: new Date(),
          errorSummary: message,
        })
        .where(eq(jquantsSyncRuns.id, syncRun.id))
      if (failClosed) {
        dateBulkFatalError = message
        failed += tickers.length
        errors.push(`date_bulk_fail_closed:${message}`)
        tickers = []
      }
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

  if (fetchStatus !== 'failed' && !dateBulkFatalError && !historicalCoverageError) {
    try {
      await refreshAfterOhlcv()
    } catch (err) {
      postRefreshError = err instanceof Error ? err.message : String(err)
      errors.push(`post_ohlcv_refresh: ${postRefreshError}`)
      console.error(`Post-OHLCV refresh failed: ${postRefreshError}`)
    }
  }

  // 終了記録。後段更新が失敗した場合、OHLCV取得だけ成功しても success にはしない。
  const finalStatus = (postRefreshError || dateBulkFatalError || historicalCoverageError) && fetchStatus === 'success'
    ? 'partial'
    : fetchStatus

  await db
    .update(batchRuns)
    .set({
      finishedAt: new Date(),
      status: finalStatus,
      totalTickers: initialTickerCount,
      succeeded,
      failed,
      rowsInserted,
      errorSummary: JSON.stringify(errors.slice(0, 10)),
    })
    .where(eq(batchRuns.id, runId))

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
  if (finalStatus !== 'success') {
    throw new Error(`OHLCV update incomplete: status=${finalStatus}, succeeded=${succeeded}, failed=${failed}`)
  }
}

main().catch(err => {
  console.error('Fatal:', err)
  process.exit(1)
})
