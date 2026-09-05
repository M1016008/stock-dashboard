import assert from 'node:assert/strict'
import { execAll, execGet } from '@/lib/db/client'
import {
  calculatePeriodPriceMetrics,
  summarizeStagePeriod,
} from '@/lib/period-explorer'
import {
  getPeriodExplorerCalendar,
  queryPeriodExplorer,
  resolvePeriodExplorerDateRange,
  type PeriodExplorerStockRow,
} from '@/lib/server/period-explorer-read-model'

function stockRows(result: Awaited<ReturnType<typeof queryPeriodExplorer>>): PeriodExplorerStockRow[] {
  assert.equal(result.resultKind, 'stocks')
  return result.rows as PeriodExplorerStockRow[]
}

function assertSorted(values: number[], direction: 'asc' | 'desc', label: string): void {
  for (let index = 1; index < values.length; index += 1) {
    if (direction === 'asc') assert.ok(values[index - 1] <= values[index], `${label} must be ascending`)
    else assert.ok(values[index - 1] >= values[index], `${label} must be descending`)
  }
}

type BoundaryPriceRow = { date: string; open: number; high: number; low: number; close: number }

async function assertVolatilityBoundary(from: string, to: string) {
  const response = await queryPeriodExplorer({ from, to, ranking: 'realized_volatility', limit: 10 })
  const sample = stockRows(response)[0]
  assert.ok(sample, 'volatility ranking must return a sample stock')
  const rows = await execAll<BoundaryPriceRow>(`
    SELECT date, open, high, low, close
    FROM ohlcv_daily
    WHERE ticker = ? AND date <= ?
      AND date >= COALESCE(
        (SELECT MAX(date) FROM ohlcv_daily WHERE ticker = ? AND date < ?),
        ?
      )
    ORDER BY date
  `, [sample.ticker, response.range.adoptedTo, sample.ticker, response.range.adoptedFrom, response.range.adoptedFrom])
  const selectedRows = rows.filter((row) => row.date >= response.range.adoptedFrom)
  const returns: number[] = []
  let gapUpCount = 0
  let gapDownCount = 0
  for (const row of selectedRows) {
    const index = rows.findIndex((candidate) => candidate.date === row.date)
    const previous = index > 0 ? rows[index - 1] : null
    if (!previous || previous.close <= 0) continue
    returns.push((row.close / previous.close - 1) * 100)
    if (row.open > previous.high) gapUpCount += 1
    if (row.open < previous.low) gapDownCount += 1
  }
  assert.equal(returns.length, selectedRows.length, 'the selected first day must have a previous-close input')
  const mean = returns.reduce((sum, value) => sum + value, 0) / returns.length
  const variance = returns.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (returns.length - 1)
  const realizedVolatilityPct = Math.sqrt(variance)
  assert.ok(Math.abs(realizedVolatilityPct - sample.realizedVolatilityPct!) < 1e-9)
  assert.equal(sample.gapUpCount, gapUpCount)
  assert.equal(sample.gapDownCount, gapDownCount)
  const first = selectedRows[0]
  const previous = rows[rows.findIndex((row) => row.date === first.date) - 1]
  return {
    ticker: sample.ticker,
    from: response.range.adoptedFrom,
    to: response.range.adoptedTo,
    firstClose: first.close,
    previousClose: previous.close,
    firstReturnPct: returns[0],
    firstGap: first.open > previous.high ? 'up' : first.open < previous.low ? 'down' : 'none',
    observations: returns.length,
    realizedVolatilityPct,
    gapUpCount,
    gapDownCount,
  }
}

async function main(): Promise<void> {
const formula = calculatePeriodPriceMetrics({ startClose: 100, endClose: 120, periodHigh: 130, periodLow: 80 })
assert.ok(Math.abs((formula.periodReturnPct ?? 0) - 20) < 1e-10)
assert.ok(Math.abs((formula.maxRisePct ?? 0) - 30) < 1e-10)
assert.ok(Math.abs((formula.maxFallPct ?? 0) - (-20)) < 1e-10)
assert.ok(Math.abs((formula.drawdownFromHighPct ?? 0) - (-7.692307692307687)) < 1e-10)
assert.ok(Math.abs((formula.reboundFromLowPct ?? 0) - 50) < 1e-10)

const stageSemantics = summarizeStagePeriod(
  { dailyA: 4, dailyB: 5, weeklyA: 1, weeklyB: 2, monthlyA: 6, monthlyB: 3 },
  { dailyA: 5, dailyB: 6, weeklyA: 2, weeklyB: 1, monthlyA: 1, monthlyB: 3 },
)
assert.equal(stageSemantics.improvingAxes, 4, 'Stage improvement must use the canonical cycle, not numeric order')
assert.equal(stageSemantics.deterioratingAxes, 1)
assert.equal(stageSemantics.stableAxes, 1)

const calendar = await getPeriodExplorerCalendar()
assert.ok(calendar.length > 250, 'Period Explorer needs a sufficiently long trading calendar')
const latest = calendar.at(-1)!
const from20 = calendar.at(-20)!

const weekendRange = await resolvePeriodExplorerDateRange('2026-08-01', '2026-08-09')
assert.equal(weekendRange.adoptedFrom, '2026-08-03')
assert.equal(weekendRange.adoptedTo, '2026-08-07')

const upward = await queryPeriodExplorer({ from: from20, to: latest, ranking: 'return_up', limit: 20 })
const upwardRows = stockRows(upward)
assert.equal(upward.range.tradingDays, 20)
assert.ok(upwardRows.length > 0)
assertSorted(upwardRows.map((row) => row.rankingValue!), 'desc', 'upward ranking')

const sample = upwardRows[0]
const rawPrices = await execGet<{ start_close: number; end_close: number }>(`
  SELECT
    (SELECT close FROM ohlcv_daily WHERE ticker = ? AND date = ?) AS start_close,
    (SELECT close FROM ohlcv_daily WHERE ticker = ? AND date = ?) AS end_close
`, [sample.ticker, upward.range.adoptedFrom, sample.ticker, upward.range.adoptedTo])
assert.ok(rawPrices)
const manualReturn = (Number(rawPrices!.end_close) / Number(rawPrices!.start_close) - 1) * 100
assert.ok(Math.abs(manualReturn - sample.periodReturnPct!) < 1e-9, 'period return must match adjusted OHLCV')

const downward = await queryPeriodExplorer({ from: from20, to: latest, ranking: 'return_down', limit: 20 })
assertSorted(stockRows(downward).map((row) => row.rankingValue!), 'asc', 'downward ranking')

const boundary = await assertVolatilityBoundary(from20, latest)
const shiftedBoundary = await assertVolatilityBoundary(calendar[calendar.indexOf(from20) + 1], latest)

const volume = await queryPeriodExplorer({ from: from20, to: latest, ranking: 'avg_volume', limit: 10 })
const volumeSample = stockRows(volume)[0]
const rawVolume = await execGet<{ avg_volume: number }>(`
  SELECT AVG(volume) AS avg_volume
  FROM ohlcv_daily
  WHERE ticker = ? AND date BETWEEN ? AND ?
`, [volumeSample.ticker, volume.range.adoptedFrom, volume.range.adoptedTo])
assert.ok(Math.abs(Number(rawVolume?.avg_volume) - volumeSample.avgVolume!) < 1e-6, 'average volume must match source rows')

const stage = await queryPeriodExplorer({ from: from20, to: latest, ranking: 'stage_improve', limit: 20 })
const stageRows = stockRows(stage)
assertSorted(stageRows.map((row) => row.rankingValue!), 'desc', 'Stage improvement ranking')
for (const row of stageRows) assert.equal(row.rankingValue, row.stageSummary.improvingAxes)

const ma = await queryPeriodExplorer({ from: from20, to: latest, ranking: 'ma25_deviation_high', limit: 10 })
const maSample = stockRows(ma)[0]
const rawMa = await execGet<{ close: number; ma_25: number }>(`
  SELECT o.close, s.ma_25
  FROM ohlcv_daily o
  INNER JOIN daily_snapshots s ON s.ticker = o.ticker AND s.date = o.date
  WHERE o.ticker = ? AND o.date = ?
`, [maSample.ticker, ma.range.adoptedTo])
assert.ok(rawMa)
const manualMaDeviation = (Number(rawMa!.close) / Number(rawMa!.ma_25) - 1) * 100
assert.ok(Math.abs(manualMaDeviation - maSample.ma25DeviationPct!) < 1e-9, 'MA deviation must match the daily snapshot')

const primeMarket = upward.options.markets.find((item) => item.value.includes('プライム'))?.value
assert.ok(primeMarket, 'Prime market option must be available')
const filtered = await queryPeriodExplorer({
  from: from20,
  to: latest,
  ranking: 'avg_turnover',
  filters: {
    markets: [primeMarket!],
    marketCapMin: 50_000_000_000,
    avgTurnoverMin: 100_000_000,
    stages: { weeklyA: [1, 6], weeklyB: [1, 6] },
  },
  limit: 100,
})
const filteredRows = stockRows(filtered)
assert.ok(filtered.total > 0, 'compound filter should retain real stocks')
for (const row of filteredRows) {
  assert.equal(row.marketSegment, primeMarket)
  assert.ok(row.marketCap != null && row.marketCap >= 50_000_000_000)
  assert.ok(row.avgTurnover != null && row.avgTurnover >= 100_000_000)
  assert.ok(row.endStages.weeklyA != null && [1, 6].includes(row.endStages.weeklyA))
  assert.ok(row.endStages.weeklyB != null && [1, 6].includes(row.endStages.weeklyB))
}

const secondPage = await queryPeriodExplorer({ from: from20, to: latest, ranking: 'return_up', limit: 10, offset: 10 })
assert.equal(stockRows(secondPage)[0]?.rank, 11)
assert.notEqual(stockRows(secondPage)[0]?.ticker, upwardRows[0]?.ticker)

const sectors = await queryPeriodExplorer({ from: from20, to: latest, ranking: 'sector_avg_return', limit: 20 })
assert.equal(sectors.resultKind, 'sectors')
assert.ok(sectors.total > 0, 'industry rankings must aggregate filtered stock rows before ranking-value filtering')
assert.ok(sectors.rows.length > 0)
assertSorted(sectors.rows.map((row) => row.rankingValue!), 'desc', 'industry average return ranking')

const pitRange = await resolvePeriodExplorerDateRange('2025-08-01', '2025-08-25')
const pit = await queryPeriodExplorer({ from: pitRange.adoptedFrom, to: pitRange.adoptedTo, ranking: 'return_up', limit: 5 })
assert.ok(pit.range.adoptedTo <= '2025-08-25')
assert.ok(stockRows(pit).every((row) => row.endClose > 0))

console.log(JSON.stringify({
  ok: true,
  range: upward.range,
  formulaSample: { ticker: sample.ticker, startClose: sample.startClose, endClose: sample.endClose, returnPct: sample.periodReturnPct },
  volumeSample: { ticker: volumeSample.ticker, avgVolume: volumeSample.avgVolume },
  stageSample: stageRows.slice(0, 3).map((row) => ({ ticker: row.ticker, improvingAxes: row.stageSummary.improvingAxes, code: row.stageCode })),
  maSample: { ticker: maSample.ticker, ma25DeviationPct: maSample.ma25DeviationPct },
  sectorSample: sectors.rows.slice(0, 3).map((row) => ({ sector: row.rowType === 'sector' ? row.sector : null, value: row.rankingValue })),
  compoundFilter: { total: filtered.total, rowsChecked: filteredRows.length },
  pitRange: pit.range,
  volatilityBoundary: boundary,
  shiftedVolatilityBoundary: shiftedBoundary,
}, null, 2))
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
