import fs from 'node:fs/promises'
import path from 'node:path'
import { readSafeSpreadsheetFile } from '@/lib/safe-spreadsheet'
import {
  loadJpMarketSessionCoverageForValidation,
  loadUsMarketSessionCoverageForValidation,
} from '@/lib/server/mtf-close-calendar-read-model'
import {
  buildTradingViewMtfFixture,
  compareTradingViewMtfFixture,
  importTradingViewOracleRows,
  type TradingViewMtfFixture,
  type TradingViewOracleMarket,
  type TradingViewParityReport,
} from '@/lib/tradingview/mtf-close-parity'

const MARKET_DEFAULTS = {
  JP: {
    fixture: 'fixtures/mtf-close-calendar/tradingview-close-dates.json',
    symbol: 'TSE:7203',
    from: '2025-01-01',
    to: '2026-10-02',
  },
  US: {
    fixture: 'fixtures/mtf-close-calendar/tradingview-close-dates-us.json',
    symbol: 'NASDAQ:AAPL',
    from: '2025-01-02',
    to: '2026-10-13',
  },
} as const

function option(name: string): string | null {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] ?? null : null
}

function printReport(report: TradingViewParityReport): void {
  console.log('TRADINGVIEW MTF PARITY REPORT')
  console.log('')
  console.log(`Symbol: ${report.symbol ?? 'NOT VALIDATED'}`)
  console.log(`Session: ${report.session ?? 'NOT VALIDATED'}`)
  console.log(`Period: ${report.period ? `${report.period.from} - ${report.period.to}` : 'NOT VALIDATED'}`)
  console.log(`Dates compared: ${report.totalDatesCompared}`)
  console.log(`TF-date comparisons: ${report.totalTfDateComparisons}`)
  console.log('')
  for (const result of report.timeframes) {
    console.log(result.timeframe)
    console.log(`expected closes: ${result.expectedCloses}`)
    console.log(`actual closes: ${result.actualCloses}`)
    console.log(`mismatch: ${result.mismatches}`)
    console.log('')
  }
  if (report.mismatches.length > 0) {
    console.log('MISMATCHES')
    for (const mismatch of report.mismatches) {
      console.log([
        mismatch.date,
        mismatch.timeframe,
        `TradingView=${mismatch.tradingViewExpected ? 1 : 0}`,
        `StockBoard=${mismatch.stockBoardActual ? 1 : 0}`,
      ].join(' '))
    }
    console.log('')
  }
  console.log(`2026-10-30: ${report.october30.status}`)
  if (report.october30.status === 'COMPARED') {
    console.log(`TradingView: ${report.october30.tradingView?.join(' / ') || '(none)'}`)
    console.log(`StockBoard: ${report.october30.stockBoard?.join(' / ') || '(none)'}`)
  }
  console.log(`TOTAL MISMATCHES: ${report.totalMismatches}`)
  console.log(`RESULT: ${report.result}`)
}

function requestedMarket(): TradingViewOracleMarket {
  const market = (option('--market') ?? 'JP').toUpperCase()
  if (market !== 'JP' && market !== 'US') {
    throw new Error('TradingView market must be JP or US.')
  }
  return market
}

async function importCsv(
  csvPath: string,
  fixturePath: string,
  market: TradingViewOracleMarket,
): Promise<TradingViewMtfFixture> {
  const defaults = MARKET_DEFAULTS[market]
  const symbol = option('--symbol') ?? defaults.symbol
  const from = option('--from') ?? defaults.from
  const to = option('--to') ?? defaults.to
  const spreadsheet = await readSafeSpreadsheetFile(path.resolve(csvPath), {
    maxInputBytes: 16 * 1024 * 1024,
    maxRows: 20_000,
    maxColumns: 64,
  })
  const oracle = importTradingViewOracleRows(spreadsheet.rows, { symbol, from, to, market })
  const coverage = market === 'JP'
    ? await loadJpMarketSessionCoverageForValidation(from, to)
    : await loadUsMarketSessionCoverageForValidation(from, to)
  const fixture = buildTradingViewMtfFixture({
    oracle,
    tradingDates: coverage.tradingDates,
    anchorDate: coverage.tradingDates[0] ?? '',
    coverageFrom: coverage.actualCoverageFrom,
    coverageTo: coverage.actualCoverageTo,
    calendarSource: coverage.calendarSource,
  })
  const target = path.resolve(fixturePath)
  await fs.mkdir(path.dirname(target), { recursive: true })
  await fs.writeFile(target, `${JSON.stringify(fixture, null, 2)}\n`, 'utf8')
  return fixture
}

async function loadFixture(fixturePath: string): Promise<TradingViewMtfFixture> {
  const parsed = JSON.parse(await fs.readFile(path.resolve(fixturePath), 'utf8')) as TradingViewMtfFixture
  if (!Array.isArray(parsed.observations)) {
    throw new Error('TradingView fixture is invalid: observations must be an array.')
  }
  return parsed
}

async function main() {
  const market = requestedMarket()
  const fixturePath = option('--fixture') ?? MARKET_DEFAULTS[market].fixture
  const csvPath = option('--csv')
  const fixture = csvPath
    ? await importCsv(csvPath, fixturePath, market)
    : await loadFixture(fixturePath)
  const report = compareTradingViewMtfFixture(fixture)
  printReport(report)
  process.exitCode = report.result === 'PASS' ? 0 : report.result === 'FAIL' ? 1 : 2
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : 'TradingView parity validation failed.')
  process.exitCode = 1
})
