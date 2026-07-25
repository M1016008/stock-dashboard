// J-Quants の財務サマリーと日々公表信用取引残高を差分更新する。
// 通常は直近の開示日を全銘柄一括取得し、TICKERS 指定時は対象銘柄の全履歴を補完する。

import { db, ensureReady } from '@/lib/db/client'
import { batchRuns } from '@/lib/db/schema'
import {
  fetchJQuantsFinsSummary,
  fetchJQuantsFinsSummaryByDate,
  fetchJQuantsMarginAlert,
  fromJQuantsCode,
  type JFinsSummaryRow,
  type JMarginAlertRow,
} from '@/lib/jquants'
import {
  upsertDailyMarginRows,
  upsertExternalDataStatus,
  upsertFinancialSummaryRows,
} from '@/lib/server/company-overview-store'
import { eq } from 'drizzle-orm'

const LOOKBACK_DAYS = Math.max(2, Number(process.env.COMPANY_OVERVIEW_LOOKBACK_DAYS ?? 14))
const RATE_LIMIT_MS = Math.max(0, Number(process.env.COMPANY_OVERVIEW_RATE_LIMIT_MS ?? 350))
const tickers = (process.env.TICKERS ?? '')
  .split(',')
  .map((value) => value.trim().replace(/\.T$/i, ''))
  .filter(Boolean)

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

function dateDaysAgo(days: number): string {
  const date = new Date()
  date.setUTCDate(date.getUTCDate() - days)
  return date.toISOString().slice(0, 10)
}

async function fetchFinancialRows(): Promise<JFinsSummaryRow[]> {
  if (tickers.length > 0) {
    const rows: JFinsSummaryRow[] = []
    for (const ticker of tickers) {
      rows.push(...await fetchJQuantsFinsSummary(ticker))
      if (RATE_LIMIT_MS > 0) await sleep(RATE_LIMIT_MS)
    }
    return rows
  }

  const rows: JFinsSummaryRow[] = []
  for (let offset = LOOKBACK_DAYS - 1; offset >= 0; offset--) {
    const date = dateDaysAgo(offset)
    rows.push(...await fetchJQuantsFinsSummaryByDate(date))
    if (RATE_LIMIT_MS > 0) await sleep(RATE_LIMIT_MS)
  }
  return rows
}

async function fetchMarginRows(): Promise<JMarginAlertRow[]> {
  if (tickers.length > 0) {
    return (await Promise.all(tickers.map((ticker) => fetchJQuantsMarginAlert({ ticker })))).flat()
  }

  const rows: JMarginAlertRow[] = []
  for (let offset = LOOKBACK_DAYS - 1; offset >= 0; offset--) {
    rows.push(...await fetchJQuantsMarginAlert({ date: dateDaysAgo(offset) }))
    if (RATE_LIMIT_MS > 0) await sleep(RATE_LIMIT_MS)
  }
  return rows
}

async function main() {
  await ensureReady()
  const [run] = await db
    .insert(batchRuns)
    .values({ jobType: 'company_overview', startedAt: new Date(), status: 'running' })
    .returning({ id: batchRuns.id })
  const runId = run.id
  const importedAt = Math.floor(Date.now() / 1000)

  try {
    const financialRows = await fetchFinancialRows()
    const marginRows = await fetchMarginRows()

    const financialInserted = await upsertFinancialSummaryRows(financialRows, importedAt)
    const marginInserted = await upsertDailyMarginRows(marginRows, importedAt)

    if (tickers.length > 0) {
      for (const ticker of tickers) {
        const tickerFinancial = financialRows.filter((row) => fromJQuantsCode(row.Code) === ticker)
        const tickerMargin = marginRows.filter((row) => fromJQuantsCode(row.Code) === ticker)
        await upsertExternalDataStatus(
          ticker,
          'financial_summary',
          tickerFinancial.length > 0 ? 'ready' : 'no_data',
          tickerFinancial.map((row) => row.DiscDate).sort().at(-1) ?? null,
          tickerFinancial.length > 0 ? null : 'J-Quantsに財務サマリーがありません。',
          importedAt,
        )
        await upsertExternalDataStatus(
          ticker,
          'daily_margin',
          tickerMargin.length > 0 ? 'ready' : 'no_data',
          tickerMargin.map((row) => row.AppDate).sort().at(-1) ?? null,
          tickerMargin.length > 0 ? null : '日々公表銘柄の対象データはありません。',
          importedAt,
        )
      }
    }

    await db.update(batchRuns).set({
      finishedAt: new Date(),
      status: 'success',
      totalTickers: tickers.length || null,
      succeeded: tickers.length || null,
      failed: 0,
      rowsInserted: financialInserted + marginInserted,
      errorSummary: null,
    }).where(eq(batchRuns.id, runId))

    console.log(JSON.stringify({
      mode: tickers.length > 0 ? 'tickers' : 'recent',
      tickers,
      financialRows: financialInserted,
      dailyMarginRows: marginInserted,
    }))
  } catch (error) {
    await db.update(batchRuns).set({
      finishedAt: new Date(),
      status: 'failed',
      failed: tickers.length || 1,
      errorSummary: JSON.stringify({ message: error instanceof Error ? error.message : String(error) }),
    }).where(eq(batchRuns.id, runId))
    throw error
  }
}

main().catch((error) => {
  console.error('batch-company-overview failed:', error)
  process.exit(1)
})
