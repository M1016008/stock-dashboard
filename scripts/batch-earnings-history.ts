// scripts/batch-earnings-history.ts
//
// J-Quants /fins/summary の実際の開示日を earnings_calendar に補完する。
// JPX/J-Quants の「予定」APIにまだ出ていない銘柄でも、過去実績から次回推定日を表示できるようにする。

import { db, client } from '@/lib/db/client'
import { batchRuns } from '@/lib/db/schema'
import { fetchJQuantsFinsSummary, type JFinsSummaryRow } from '@/lib/jquants'
import { classifyEarningsTime, normalizeEarningsTime } from '@/lib/earnings-time'
import { eq } from 'drizzle-orm'

const RATE_LIMIT_MS = Number(process.env.EARNINGS_HISTORY_RATE_LIMIT_MS ?? 850)
const PROGRESS_EVERY = Number(process.env.EARNINGS_HISTORY_PROGRESS_EVERY ?? 50)
const LIMIT = Number(process.env.EARNINGS_HISTORY_LIMIT ?? 0)
const RETRY_MAX = Number(process.env.EARNINGS_HISTORY_RETRY_MAX ?? 4)
const RETRY_BASE_MS = Number(process.env.EARNINGS_HISTORY_RETRY_BASE_MS ?? 15000)
const TARGET_MODE = process.env.EARNINGS_HISTORY_MODE ?? 'missing-last'
const SOURCE_URL = 'https://jpx-jquants.com/ja/spec/fins-summary'

type TargetTicker = {
  ticker: string
  name: string | null
  sector17_name: string | null
  sector33_name: string | null
  market_segment: string | null
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

function isFinancialStatement(row: JFinsSummaryRow): boolean {
  const extended = row as JFinsSummaryRow & { TypeOfDocument?: string }
  const docType = `${extended.DocType ?? ''} ${extended.TypeOfDocument ?? ''}`
  return (
    Boolean(row.DiscDate) &&
    ['1Q', '2Q', '3Q', 'FY'].includes(row.CurPerType) &&
    /FinancialStatements/i.test(docType)
  )
}

function fiscalPeriod(row: JFinsSummaryRow): string | null {
  return [row.CurPerEn, row.CurPerType].filter(Boolean).join(' ') || null
}

async function loadTargets(): Promise<TargetTicker[]> {
  const envTickers = process.env.TICKERS?.split(',').map((s) => s.trim()).filter(Boolean)
  if (envTickers && envTickers.length > 0) {
    const placeholders = envTickers.map(() => '?').join(',')
    return client.execute({
      sql: `
        SELECT ticker, name, sector17_name, sector33_name, market_segment
        FROM ticker_universe
        WHERE ticker IN (${placeholders})
        ORDER BY ticker
      `,
      args: envTickers,
    }).then((res) => res.rows.map((row) => ({ ...row })) as unknown as TargetTicker[])
  }

  const limitSql = LIMIT > 0 ? `LIMIT ${Math.floor(LIMIT)}` : ''
  const targetPredicateSql =
    TARGET_MODE === 'all'
      ? ''
      : TARGET_MODE === 'missing-summary'
        ? `AND NOT EXISTS (
              SELECT 1
              FROM earnings_calendar e
              WHERE e.ticker = tu.ticker
                AND e.source = 'jquants_fins_summary'
            )`
        : `AND NOT EXISTS (
              SELECT 1
              FROM earnings_calendar e
              WHERE e.ticker = tu.ticker
                AND e.announce_date < ds.date
            )`
  const res = await client.execute({
    sql: `
      WITH latest AS (
        SELECT MAX(date) AS date FROM daily_snapshots
      )
      SELECT tu.ticker, tu.name, tu.sector17_name, tu.sector33_name, tu.market_segment
      FROM ticker_universe tu
      JOIN daily_snapshots ds
        ON ds.ticker = tu.ticker
       AND ds.date = (SELECT date FROM latest)
      WHERE tu.active = 1
        AND COALESCE(tu.market_segment, '') IN ('プライム', 'スタンダード', 'グロース')
        AND lower(COALESCE(tu.name, '') || ' ' || COALESCE(tu.sector17_name, '') || ' ' || COALESCE(tu.sector33_name, '')) NOT LIKE '%etf%'
        AND lower(COALESCE(tu.name, '') || ' ' || COALESCE(tu.sector17_name, '') || ' ' || COALESCE(tu.sector33_name, '')) NOT LIKE '%ｅｔｆ%'
        AND COALESCE(tu.name, '') NOT LIKE '%上場投信%'
        AND COALESCE(tu.name, '') NOT LIKE '%投資法人%'
        AND lower(COALESCE(tu.name, '') || ' ' || COALESCE(tu.sector17_name, '') || ' ' || COALESCE(tu.sector33_name, '')) NOT LIKE '%reit%'
        AND COALESCE(tu.name, '') NOT LIKE '%リート%'
        AND COALESCE(tu.name, '') NOT LIKE '%優先株式%'
        ${targetPredicateSql}
      ORDER BY tu.market_segment, tu.ticker
      ${limitSql}
    `,
  })
  return res.rows.map((row) => ({ ...row })) as unknown as TargetTicker[]
}

async function upsertRows(target: TargetTicker, rows: JFinsSummaryRow[], importedAt: number): Promise<number> {
  let inserted = 0
  for (const row of rows.filter(isFinancialStatement)) {
    const actualTime = normalizeEarningsTime(row.DiscTime)
    const actualAt = actualTime ? `${row.DiscDate}T${actualTime}:00+09:00` : null
    await client.execute({
      sql: `
        INSERT INTO earnings_calendar (
          ticker, announce_date, fiscal_period, company_name, sector_name,
          market_segment, source, source_url,
          actual_disclosed_date, actual_disclosed_time, actual_disclosed_at,
          actual_source, actual_source_url, time_bucket, time_updated_at, imported_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(ticker, announce_date) DO UPDATE SET
          fiscal_period = COALESCE(earnings_calendar.fiscal_period, excluded.fiscal_period),
          company_name = COALESCE(earnings_calendar.company_name, excluded.company_name),
          sector_name = COALESCE(earnings_calendar.sector_name, excluded.sector_name),
          market_segment = COALESCE(earnings_calendar.market_segment, excluded.market_segment),
          source = CASE
            WHEN earnings_calendar.source IN ('jpx', 'jquants') THEN earnings_calendar.source
            ELSE excluded.source
          END,
          source_url = COALESCE(excluded.source_url, earnings_calendar.source_url),
          actual_disclosed_date = COALESCE(excluded.actual_disclosed_date, earnings_calendar.actual_disclosed_date),
          actual_disclosed_time = COALESCE(excluded.actual_disclosed_time, earnings_calendar.actual_disclosed_time),
          actual_disclosed_at = COALESCE(excluded.actual_disclosed_at, earnings_calendar.actual_disclosed_at),
          actual_source = COALESCE(excluded.actual_source, earnings_calendar.actual_source),
          actual_source_url = COALESCE(excluded.actual_source_url, earnings_calendar.actual_source_url),
          time_bucket = COALESCE(excluded.time_bucket, earnings_calendar.time_bucket),
          time_updated_at = MAX(COALESCE(earnings_calendar.time_updated_at, 0), excluded.time_updated_at),
          imported_at = MAX(earnings_calendar.imported_at, excluded.imported_at)
      `,
      args: [
        target.ticker,
        row.DiscDate,
        fiscalPeriod(row),
        target.name,
        target.sector33_name ?? target.sector17_name,
        target.market_segment,
        'jquants_fins_summary',
        SOURCE_URL,
        row.DiscDate,
        actualTime,
        actualAt,
        'jquants_fins_summary',
        SOURCE_URL,
        classifyEarningsTime(actualTime, row.DiscDate),
        importedAt,
        importedAt,
      ],
    })
    inserted++
  }
  return inserted
}

function isRateLimitError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /429|Rate limit exceeded/i.test(message)
}

async function fetchFinsSummaryWithRetry(ticker: string): Promise<JFinsSummaryRow[]> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fetchJQuantsFinsSummary(ticker)
    } catch (error) {
      if (!isRateLimitError(error) || attempt >= RETRY_MAX) throw error
      const waitMs = RETRY_BASE_MS * (attempt + 1)
      console.warn(`rate limited: ${ticker}, retry ${attempt + 1}/${RETRY_MAX} after ${(waitMs / 1000).toFixed(0)}s`)
      await sleep(waitMs)
    }
  }
}

async function main() {
  const [run] = await db
    .insert(batchRuns)
    .values({ jobType: 'earnings_history', startedAt: new Date(), status: 'running' })
    .returning({ id: batchRuns.id })
  const runId = run.id

  const targets = await loadTargets()
  const importedAt = Math.floor(Date.now() / 1000)
  let succeeded = 0
  let failed = 0
  let rowsInserted = 0
  const errors: string[] = []
  const start = Date.now()

  console.log(`earnings history backfill: targets=${targets.length}, limit=${LIMIT || 'all'}, mode=${TARGET_MODE}`)

  for (const [index, target] of targets.entries()) {
    try {
      const rows = await fetchFinsSummaryWithRetry(target.ticker)
      rowsInserted += await upsertRows(target, rows, importedAt)
      succeeded++
      if ((index + 1) % PROGRESS_EVERY === 0 || index === targets.length - 1) {
        const pct = targets.length === 0 ? '100.0' : (((index + 1) / targets.length) * 100).toFixed(1)
        const elapsed = ((Date.now() - start) / 60000).toFixed(1)
        console.log(`[${index + 1}/${targets.length} ${pct}%] ${target.ticker}: rows=${rows.length}, inserted=${rowsInserted}, failed=${failed}, elapsed=${elapsed}min`)
      }
    } catch (error) {
      failed++
      const message = `${target.ticker}: ${error instanceof Error ? error.message : String(error)}`
      errors.push(message)
      console.error(`✗ ${message}`)
    }
    if (RATE_LIMIT_MS > 0) await sleep(RATE_LIMIT_MS)
  }

  const status = failed === 0 ? 'success' : succeeded === 0 ? 'failed' : 'partial'
  await db
    .update(batchRuns)
    .set({
      finishedAt: new Date(),
      status,
      totalTickers: targets.length,
      succeeded,
      failed,
      rowsInserted,
      errorSummary: errors.length > 0 ? JSON.stringify(errors.slice(0, 10)) : null,
    })
    .where(eq(batchRuns.id, runId))

  console.log(`完了: ${succeeded} 成功 / ${failed} 失敗 / ${rowsInserted} 行補完 / ${status}`)
}

main().catch((error) => {
  console.error('Fatal:', error)
  process.exit(1)
})
