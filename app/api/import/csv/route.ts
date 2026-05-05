// app/api/import/csv/route.ts
// CSVファイル取込 API。
// FormData で `files` (1〜N個) と任意の `date` (yyyy-mm-dd) を受け取る。
// date 未指定の場合はファイル名から自動検出、それも失敗したら今日の日付を使用。

import { NextResponse } from 'next/server'
import { execAll, execBatch, execRun, ensureReady } from '@/lib/db/client'
import { parseTradingViewCsv, detectDateFromFileName, type ParsedRow } from '@/lib/csv/tradingview-parser'

export const dynamic = 'force-dynamic'
export const maxDuration = 120

interface ImportSummary {
  fileName: string
  date: string | null
  detectionMethod: 'manual' | 'filename' | 'today'
  rowsParsed: number
  rowsInserted: number
  errors: string[]
}

function todayStr(): string {
  return new Date().toISOString().split('T')[0]
}

const UPSERT_SQL = `INSERT INTO tv_daily_snapshots (
  date, ticker, name, market_segment, margin_type, price, currency, change_percent_1d, volume_1d,
  avg_volume_10d, avg_volume_30d, market_cap, market_cap_currency,
  per, dividend_yield_pct,
  perf_pct_1w, perf_pct_1m, perf_pct_3m, perf_pct_6m, perf_pct_ytd,
  sma_5d, sma_25d, sma_75d, sma_150d, sma_300d,
  sma_5w, sma_13w, sma_25w, sma_50w, sma_100w,
  sma_3m, sma_5m, sma_10m, sma_20m, sma_25m,
  earnings_last_date, earnings_next_date,
  imported_at, source_file
) VALUES (
  ?, ?, ?, ?, ?, ?, ?, ?, ?,
  ?, ?, ?, ?,
  ?, ?,
  ?, ?, ?, ?, ?,
  ?, ?, ?, ?, ?,
  ?, ?, ?, ?, ?,
  ?, ?, ?, ?, ?,
  ?, ?,
  ?, ?
)
ON CONFLICT(date, ticker) DO UPDATE SET
  name=excluded.name,
  market_segment=excluded.market_segment,
  margin_type=excluded.margin_type,
  price=excluded.price,
  currency=excluded.currency,
  change_percent_1d=excluded.change_percent_1d,
  volume_1d=excluded.volume_1d,
  avg_volume_10d=excluded.avg_volume_10d,
  avg_volume_30d=excluded.avg_volume_30d,
  market_cap=excluded.market_cap,
  market_cap_currency=excluded.market_cap_currency,
  per=excluded.per,
  dividend_yield_pct=excluded.dividend_yield_pct,
  perf_pct_1w=excluded.perf_pct_1w,
  perf_pct_1m=excluded.perf_pct_1m,
  perf_pct_3m=excluded.perf_pct_3m,
  perf_pct_6m=excluded.perf_pct_6m,
  perf_pct_ytd=excluded.perf_pct_ytd,
  sma_5d=excluded.sma_5d,
  sma_25d=excluded.sma_25d,
  sma_75d=excluded.sma_75d,
  sma_150d=excluded.sma_150d,
  sma_300d=excluded.sma_300d,
  sma_5w=excluded.sma_5w,
  sma_13w=excluded.sma_13w,
  sma_25w=excluded.sma_25w,
  sma_50w=excluded.sma_50w,
  sma_100w=excluded.sma_100w,
  sma_3m=excluded.sma_3m,
  sma_5m=excluded.sma_5m,
  sma_10m=excluded.sma_10m,
  sma_20m=excluded.sma_20m,
  sma_25m=excluded.sma_25m,
  earnings_last_date=excluded.earnings_last_date,
  earnings_next_date=excluded.earnings_next_date,
  imported_at=excluded.imported_at,
  source_file=excluded.source_file`

function rowArgs(date: string, r: ParsedRow, importedAt: string, sourceFile: string) {
  return [
    date, r.ticker, r.name, r.marketSegment, r.marginType, r.price, r.currency, r.changePercent1d, r.volume1d,
    r.avgVolume10d, r.avgVolume30d, r.marketCap, r.marketCapCurrency,
    r.per, r.dividendYieldPct,
    r.perfPct1w, r.perfPct1m, r.perfPct3m, r.perfPct6m, r.perfPctYtd,
    r.sma5d, r.sma25d, r.sma75d, r.sma150d, r.sma300d,
    r.sma5w, r.sma13w, r.sma25w, r.sma50w, r.sma100w,
    r.sma3m, r.sma5m, r.sma10m, r.sma20m, r.sma25m,
    r.earningsLastDate, r.earningsNextDate,
    importedAt, sourceFile,
  ]
}

export async function POST(request: Request) {
  try {
    await ensureReady()
    const formData = await request.formData()
    const files = formData.getAll('files').filter((f): f is File => f instanceof File)
    const manualDate = formData.get('date')
    const overrideDate = typeof manualDate === 'string' && manualDate.length > 0 ? manualDate : null

    if (files.length === 0) {
      return NextResponse.json({ error: 'ファイルが指定されていません' }, { status: 400 })
    }

    const summaries: ImportSummary[] = []

    for (const file of files) {
      const text = await file.text()
      const parsed = parseTradingViewCsv(text)

      let date: string | null = overrideDate
      let method: ImportSummary['detectionMethod'] = overrideDate ? 'manual' : 'today'
      if (!date) {
        const detected = detectDateFromFileName(file.name)
        if (detected) {
          date = detected
          method = 'filename'
        } else {
          date = todayStr()
          method = 'today'
        }
      }

      const summary: ImportSummary = {
        fileName: file.name,
        date,
        detectionMethod: method,
        rowsParsed: parsed.rows.length,
        rowsInserted: 0,
        errors: [...parsed.errors],
      }

      if (parsed.errors.length === 0 && parsed.rows.length > 0 && date) {
        const importedAt = new Date().toISOString()
        // libsql の batch は暗黙的にトランザクション。500行ずつで分割。
        const CHUNK = 500
        for (let i = 0; i < parsed.rows.length; i += CHUNK) {
          const slice = parsed.rows.slice(i, i + CHUNK)
          await execBatch(
            slice.map((r) => ({ sql: UPSERT_SQL, args: rowArgs(date!, r, importedAt, file.name) })),
          )
        }
        summary.rowsInserted = parsed.rows.length

        await execRun(
          `INSERT INTO csv_imports (date, file_name, row_count, imported_at, detection_method)
           VALUES (?, ?, ?, ?, ?)`,
          [date, file.name, summary.rowsInserted, importedAt, method],
        )
      }

      summaries.push(summary)
    }

    return NextResponse.json({ summaries })
  } catch (error) {
    console.error('CSV import error:', error)
    return NextResponse.json(
      { error: 'Import failed', message: (error as Error).message },
      { status: 500 },
    )
  }
}

export async function GET() {
  try {
    const recent = await execAll(
      `SELECT id, date, file_name, row_count, imported_at, detection_method
       FROM csv_imports
       ORDER BY imported_at DESC
       LIMIT 50`,
    )
    const summary = await execAll(
      `SELECT date, COUNT(*) AS tickers
       FROM tv_daily_snapshots
       GROUP BY date
       ORDER BY date DESC`,
    )
    return NextResponse.json({ imports: recent, dates: summary })
  } catch (error) {
    console.error('list imports error:', error)
    return NextResponse.json({ error: (error as Error).message }, { status: 500 })
  }
}
