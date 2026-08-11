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
  fetchJQuantsDailyByDate,
  hasJQuantsCorporateAction,
  shouldApplyJQuantsLegacyAdjustment,
  type JQuantsDailyByDateRow,
} from '@/lib/jquants'
import { expectedLatestTradingDate } from '@/lib/server/data-freshness'
import type { OHLCV } from '@/types/stock'
import { eq, sql } from 'drizzle-orm'

const RATE_LIMIT_MS = Number(process.env.OHLCV_RATE_LIMIT_MS ?? 0)
const CONCURRENCY = Math.max(1, Number(process.env.OHLCV_CONCURRENCY ?? 8))
const MAX_RETRIES = Number(process.env.OHLCV_MAX_RETRIES ?? 4)
const PROGRESS_EVERY = Number(process.env.OHLCV_PROGRESS_EVERY ?? 100)

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

async function storeRows(rows: JQuantsDailyByDateRow[]): Promise<number> {
  const CHUNK = 200
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK).map(({ adjustmentFactor: _adjustmentFactor, ...row }) => row)
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
  return rows.length
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
      const rows = await fetchJQuantsDailyByDate(TARGET_DATE)
      const inserted = await storeRows(rows)
      const corporateActionTickers = Array.from(new Set(
        rows
          .filter(row => hasJQuantsCorporateAction(row.adjustmentFactor))
          .map(row => row.ticker),
      ))
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

      rowsInserted += inserted + adjustedHistoryRows
      succeeded += Math.max(0, tickers.length - missingTickers.length)
      await db
        .insert(jquantsDailyCoverage)
        .values({ date: TARGET_DATE, expectedRows: rows.length })
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
          expectedRows: rows.length,
          importedRows: inserted,
          missingTickers: JSON.stringify(missingTickers),
          status: 'success',
          finishedAt: new Date(),
        })
        .where(eq(jquantsSyncRuns.id, syncRun.id))
      console.log(
        `J-Quants date bulk 完了: expected=${rows.length}, stored=${inserted}, corporateActions=${corporateActionTickers.length}, adjustedHistoryRows=${adjustedHistoryRows}`,
      )
      tickers = tickers.filter(t => !rowTickerSet.has(t.ticker))
      if (tickers.length > 0 && !ENABLE_MISSING_FALLBACK) {
        console.log(`missing ${tickers.length} tickers after date bulk; per-ticker fallback is disabled`)
        tickers = []
      }
    } catch (err) {
      console.warn(`J-Quants date bulk をスキップ: ${err instanceof Error ? err.message : String(err)}`)
      await db
        .update(jquantsSyncRuns)
        .set({
          status: 'failed',
          finishedAt: new Date(),
          errorSummary: err instanceof Error ? err.message : String(err),
        })
        .where(eq(jquantsSyncRuns.id, syncRun.id))
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

  let postRefreshError: string | null = null
  const fetchStatus =
    failed === 0 ? 'success' :
    succeeded === 0 ? 'failed' :
    'partial'

  if (fetchStatus !== 'failed') {
    try {
      await refreshAfterOhlcv()
    } catch (err) {
      postRefreshError = err instanceof Error ? err.message : String(err)
      errors.push(`post_ohlcv_refresh: ${postRefreshError}`)
      console.error(`Post-OHLCV refresh failed: ${postRefreshError}`)
    }
  }

  // 終了記録。後段更新が失敗した場合、OHLCV取得だけ成功しても success にはしない。
  const finalStatus = postRefreshError && fetchStatus === 'success' ? 'partial' : fetchStatus

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
}

main().catch(err => {
  console.error('Fatal:', err)
  process.exit(1)
})
