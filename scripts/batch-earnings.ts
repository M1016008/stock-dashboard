// scripts/batch-earnings.ts
//
// Phase 4 B12: J-Quants /equities/earnings-calendar とJPX公式Excelから
// 決算発表予定を取得し earnings_calendar テーブルに upsert。日次実行。
//
// 使い方:
//   USE_LOCAL_DB=1 npm run batch:earnings

import { db, client, ensureReady } from '@/lib/db/client'
import { earningsCalendar, batchRuns } from '@/lib/db/schema'
import { fetchJQuantsEarningsCalendar } from '@/lib/jquants'
import { fetchJpxEarningsCalendar, JPX_EARNINGS_PAGE } from '@/lib/jpx-earnings'
import { eq } from 'drizzle-orm'

let activeRunId: number | null = null

function todayIsoJst(): string {
  const now = new Date()
  const jst = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Tokyo' }))
  return [
    jst.getFullYear(),
    String(jst.getMonth() + 1).padStart(2, '0'),
    String(jst.getDate()).padStart(2, '0'),
  ].join('-')
}

async function main() {
  await ensureReady()
  const busyTimeoutMs = Math.min(
    600_000,
    Math.max(1_000, Number(process.env.SQLITE_BUSY_TIMEOUT_MS ?? '600000') || 600_000),
  )
  await client.execute({ sql: `PRAGMA busy_timeout = ${busyTimeoutMs}` })

  const [run] = await db
    .insert(batchRuns)
    .values({ jobType: 'earnings_calendar', startedAt: new Date(), status: 'running' })
    .returning({ id: batchRuns.id })
  const runId = run.id
  activeRunId = runId

  console.log('J-Quants /equities/earnings-calendar を取得中...')
  const t0 = Date.now()
  const jquantsRows = await fetchJQuantsEarningsCalendar()
  console.log(`J-Quants取得: ${jquantsRows.length} 件 (${((Date.now() - t0) / 1000).toFixed(1)}s)`)

  console.log('JPX公式 決算発表予定Excel を取得中...')
  const t1 = Date.now()
  const jpxRows = await fetchJpxEarningsCalendar()
  console.log(`JPX公式取得: ${jpxRows.length} 件 (${((Date.now() - t1) / 1000).toFixed(1)}s)`)

  let inserted = 0
  const importedAt = Math.floor(Date.now() / 1000)
  const scheduleRefreshFrom = todayIsoJst()
  const deleted = await client.execute({
    sql: `DELETE FROM earnings_calendar
          WHERE source IN ('jpx', 'jquants')
            AND announce_date >= ?`,
    args: [scheduleRefreshFrom],
  })
  const deletedStaleFutureRows = Number(deleted.rowsAffected ?? 0)
  console.log(`既存の未来予定を整理: ${deletedStaleFutureRows} 件削除 (${scheduleRefreshFrom} 以降 / jpx,jquants)`)

  for (const row of jquantsRows) {
    const code5 = row.Code
    const ticker = code5.length === 5 && code5.endsWith('0') ? code5.slice(0, 4) : code5
    if (!row.Date) continue
    await client.execute({
      sql: `INSERT INTO earnings_calendar (
              ticker, announce_date, fiscal_period, company_name, sector_name,
              market_segment, source, source_url, imported_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(ticker, announce_date) DO UPDATE SET
              fiscal_period = excluded.fiscal_period,
              company_name = COALESCE(excluded.company_name, earnings_calendar.company_name),
              sector_name = COALESCE(excluded.sector_name, earnings_calendar.sector_name),
              market_segment = COALESCE(excluded.market_segment, earnings_calendar.market_segment),
              source = excluded.source,
              source_url = excluded.source_url,
              imported_at = excluded.imported_at`,
      args: [
        ticker,
        row.Date,
        [row.FY, row.FQ].filter(Boolean).join(' ') || null,
        row.CoName ?? null,
        row.SectorNm ?? null,
        row.Section ?? null,
        'jquants',
        'https://jpx-jquants.com/ja/spec/eq-earnings-cal',
        importedAt,
      ],
    })
    inserted++
  }

  for (const row of jpxRows) {
    await client.execute({
      sql: `INSERT INTO earnings_calendar (
              ticker, announce_date, fiscal_period, company_name, sector_name,
              market_segment, source, source_url, imported_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(ticker, announce_date) DO UPDATE SET
              fiscal_period = excluded.fiscal_period,
              company_name = COALESCE(excluded.company_name, earnings_calendar.company_name),
              sector_name = COALESCE(excluded.sector_name, earnings_calendar.sector_name),
              market_segment = COALESCE(excluded.market_segment, earnings_calendar.market_segment),
              source = excluded.source,
              source_url = excluded.source_url,
              imported_at = excluded.imported_at`,
      args: [
        row.ticker,
        row.announceDate,
        row.fiscalPeriod,
        row.companyName,
        row.sectorName,
        row.marketSegment,
        'jpx',
        row.sourceUrl || JPX_EARNINGS_PAGE,
        importedAt,
      ],
    })
    inserted++
  }

  await db
    .update(batchRuns)
    .set({
      finishedAt: new Date(),
      status: 'success',
      totalTickers: jquantsRows.length + jpxRows.length,
      succeeded: inserted,
      rowsInserted: inserted,
      errorSummary: JSON.stringify({
        jquants: jquantsRows.length,
        jpxOfficial: jpxRows.length,
        deletedStaleFutureRows,
        scheduleRefreshFrom,
      }),
    })
    .where(eq(batchRuns.id, runId))
  activeRunId = null

  console.log(`完了: ${inserted} 件を earnings_calendar に同期 (J-Quants ${jquantsRows.length} / JPX公式 ${jpxRows.length} / stale削除 ${deletedStaleFutureRows})`)
}

main().catch(async (err) => {
  if (activeRunId != null) {
    await db
      .update(batchRuns)
      .set({
        finishedAt: new Date(),
        status: 'failed',
        failed: 1,
        errorSummary: err instanceof Error ? err.message : String(err),
      })
      .where(eq(batchRuns.id, activeRunId))
      .catch((updateError) => console.error('Failed to record earnings batch failure:', updateError))
  }
  console.error('Fatal:', err)
  process.exit(1)
})
