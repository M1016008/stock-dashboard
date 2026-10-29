import fs from 'node:fs'
import path from 'node:path'
import { findJpHistoricalCoverageGaps, stableSha256 } from '@/lib/jp-ohlcv-data-quality'
import { getJpTradingDates } from '@/lib/server/jp-market-calendar'

type CountRow = { date: string; count: number }

function arg(flag: string): string | null {
  const index = process.argv.indexOf(flag)
  return index >= 0 ? process.argv[index + 1] ?? null : null
}

function absolute(flag: string): string {
  const value = arg(flag)
  if (!value || !path.isAbsolute(value)) throw new Error(`${flag}_absolute_path_required`)
  return path.resolve(value)
}

function main(): void {
  const from = arg('--from')
  const to = arg('--to')
  if (!from || !to || !/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
    throw new Error('--from_and_--to_YYYY-MM-DD_required')
  }
  const countsFile = absolute('--counts-json')
  const outputFile = absolute('--output')
  const parsed = JSON.parse(fs.readFileSync(countsFile, 'utf8')) as unknown
  if (!Array.isArray(parsed)) throw new Error('counts_json_array_required')
  const rows = parsed.map((row) => ({
    date: String((row as Record<string, unknown>).date ?? ''),
    count: Number((row as Record<string, unknown>).count ?? 0),
  })) satisfies CountRow[]
  const rowsByDate = new Map(rows.map((row) => [row.date, row.count]))
  const tradingDates = getJpTradingDates(from, to)
  const referenceRows = rows.map((row) => row.count)
    .filter((count) => Number.isSafeInteger(count) && count > 0)
    .sort((left, right) => right - left)
    .slice(0, Math.min(20, rows.length))
  const gaps = findJpHistoricalCoverageGaps({ tradingDates, rowsByDate, referenceRows })
  const manifest = {
    version: 1,
    generatedAt: new Date().toISOString(),
    from,
    to,
    tradingSessions: tradingDates.length,
    observedSessions: rows.length,
    countsSha256: stableSha256(rows),
    referenceRows,
    gapCount: gaps.length,
    gaps,
    productionMutation: false,
  }
  fs.mkdirSync(path.dirname(outputFile), { recursive: true })
  fs.writeFileSync(outputFile, `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
  console.log(JSON.stringify({ status: gaps.length === 0 ? 'PASS' : 'HOLD', ...manifest }))
  if (gaps.length > 0) process.exitCode = 2
}

try {
  main()
} catch (error) {
  console.error(error instanceof Error ? `${error.name}: ${error.message}` : String(error))
  process.exitCode = 1
}
