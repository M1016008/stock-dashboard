import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
// @ts-expect-error Node 24 ships node:sqlite; the repository pins older Node type declarations.
import { DatabaseSync } from 'node:sqlite'
import { MAX_CONTIGUOUS_BAR_GAP_DAYS } from '@/lib/backtest/forward-extrema'

type OfficialEvidence = {
  date: string
  rows: Array<{ ticker: string }>
}

type PriceRow = { date: string; close: number }
type ForwardRow = {
  date: string
  horizonDays: number
  returnPct: number
  returnCategory: string
  endDate: string
}

const HORIZONS = [2, 3, 4, 5, 10, 15, 20, 30, 40, 60, 90, 180, 200] as const

function argument(name: string): string {
  const index = process.argv.indexOf(name)
  const value = index >= 0 ? process.argv[index + 1] : null
  if (!value) throw new Error(`missing ${name}`)
  return path.resolve(value)
}

function category(value: number): string {
  if (value > 10) return 'very_up'
  if (value > 5) return 'up'
  if (value >= -5) return 'flat'
  if (value >= -10) return 'down'
  return 'very_down'
}

function same(left: ForwardRow, right: ForwardRow): boolean {
  return left.date === right.date
    && left.horizonDays === right.horizonDays
    && left.endDate === right.endDate
    && left.returnCategory === right.returnCategory
    && Math.abs(left.returnPct - right.returnPct) <= 1e-10
}

function dayDistance(left: string, right: string): number {
  return (Date.parse(`${right}T00:00:00Z`) - Date.parse(`${left}T00:00:00Z`)) / 86_400_000
}

function main(): void {
  const databasePath = argument('--database')
  const baselinePath = argument('--baseline')
  const officialPath = argument('--official')
  const outputPath = argument('--output')
  const official = JSON.parse(fs.readFileSync(officialPath, 'utf8')) as OfficialEvidence
  const targetDate = official.date
  const repaired = new DatabaseSync(databasePath, { readOnly: true })
  const baseline = new DatabaseSync(baselinePath, { readOnly: true })
  try {
    const baselineTickers = new Set((baseline.prepare(
      'SELECT ticker FROM ohlcv_daily WHERE date=?',
    ).all(targetDate) as Array<{ ticker: string }>).map((row) => row.ticker))
    const tickers = official.rows
      .map((row) => row.ticker)
      .filter((ticker) => !baselineTickers.has(ticker))
      .sort()
    if (tickers.length !== 4_061) throw new Error(`unexpected repair ticker count: ${tickers.length}`)

    const priorRows = repaired.prepare(`
      SELECT date,close FROM ohlcv_daily
      WHERE ticker=? AND date<=?
      ORDER BY date DESC LIMIT ?
    `)
    const futureRows = repaired.prepare(`
      SELECT date,close FROM ohlcv_daily
      WHERE ticker=? AND date>?
      ORDER BY date LIMIT ?
    `)
    const baselineRows = baseline.prepare(`
      SELECT date,horizon_days AS horizonDays,return_pct AS returnPct,
             return_category AS returnCategory,end_date AS endDate
      FROM forward_returns
      WHERE ticker=? AND date BETWEEN ? AND ?
      ORDER BY date,horizon_days
    `)
    const repairedRows = repaired.prepare(`
      SELECT date,horizon_days AS horizonDays,return_pct AS returnPct,
             return_category AS returnCategory,end_date AS endDate
      FROM forward_returns
      WHERE ticker=? AND date BETWEEN ? AND ?
      ORDER BY date,horizon_days
    `)
    const quarantineRows = baseline.prepare(`
      SELECT date,horizon_days AS horizonDays,return_pct AS returnPct,
             return_category AS returnCategory,end_date AS endDate
      FROM forward_returns
      WHERE ticker=? AND date<? AND end_date>?
      ORDER BY date,horizon_days
    `)

    const expectedHash = createHash('sha256')
    const quarantineHash = createHash('sha256')
    const quarantinePerHorizon = new Map<number, number>()
    const perHorizon = new Map<number, { affected: number; missing: number; changed: number; unchanged: number }>()
    const repairedPerHorizon = new Map<number, { affected: number; missing: number; changed: number; unchanged: number }>()
    const baselineMaxDate = new Map<number, string>()
    for (const horizon of HORIZONS) {
      perHorizon.set(horizon, { affected: 0, missing: 0, changed: 0, unchanged: 0 })
      repairedPerHorizon.set(horizon, { affected: 0, missing: 0, changed: 0, unchanged: 0 })
      const coverage = baseline.prepare(
        'SELECT MAX(date) AS maxDate FROM forward_returns WHERE horizon_days=?',
      ).get(horizon) as { maxDate: string | null }
      if (!coverage.maxDate) throw new Error(`baseline forward_returns horizon is missing: ${horizon}`)
      baselineMaxDate.set(horizon, coverage.maxDate)
    }

    let affected = 0
    let missing = 0
    let targetDateMissing = 0
    let preExistingMissing = 0
    let changed = 0
    let unchanged = 0
    let extra = 0
    let repairedMissing = 0
    let repairedChanged = 0
    let repairedUnchanged = 0
    let repairedExtra = 0
    let quarantineRowCount = 0
    const preExistingMissingExamples: string[] = []
    const extraExamples: string[] = []
    const startedAt = Date.now()
    for (const [index, ticker] of tickers.entries()) {
      const quarantined = quarantineRows.all(ticker, targetDate, '2026-07-16') as ForwardRow[]
      quarantineRowCount += quarantined.length
      for (const row of quarantined) {
        quarantinePerHorizon.set(row.horizonDays, (quarantinePerHorizon.get(row.horizonDays) ?? 0) + 1)
        quarantineHash.update(
          `${ticker}|${row.date}|${row.horizonDays}|${row.returnPct.toPrecision(17)}|${row.returnCategory}|${row.endDate}\n`,
        )
      }
      const prior = (priorRows.all(ticker, targetDate, HORIZONS.at(-1)! + 1) as PriceRow[]).reverse()
      const future = futureRows.all(ticker, targetDate, HORIZONS.at(-1)!) as PriceRow[]
      const prices = [...prior, ...future]
      const targetIndex = prices.findIndex((row) => row.date === targetDate)
      if (targetIndex < 0) throw new Error(`repaired target row is missing: ${ticker}:${targetDate}`)
      let segmentStart = targetIndex
      while (segmentStart > 0
        && dayDistance(prices[segmentStart - 1].date, prices[segmentStart].date) <= MAX_CONTIGUOUS_BAR_GAP_DAYS) {
        segmentStart -= 1
      }
      let segmentEnd = targetIndex
      while (segmentEnd + 1 < prices.length
        && dayDistance(prices[segmentEnd].date, prices[segmentEnd + 1].date) <= MAX_CONTIGUOUS_BAR_GAP_DAYS) {
        segmentEnd += 1
      }
      const earliest = prices[Math.max(segmentStart, targetIndex - HORIZONS.at(-1)!)]?.date ?? targetDate
      const current = baselineRows.all(ticker, earliest, targetDate) as ForwardRow[]
      const repairedCurrent = repairedRows.all(ticker, earliest, targetDate) as ForwardRow[]
      const currentByKey = new Map(current.map((row) => [`${row.date}:${row.horizonDays}`, row]))
      const repairedByKey = new Map(repairedCurrent.map((row) => [`${row.date}:${row.horizonDays}`, row]))
      const expectedKeys = new Set<string>()
      const expectedStartByHorizon = new Map<number, string>()

      for (const horizon of HORIZONS) {
        const stats = perHorizon.get(horizon)!
        const firstBase = Math.max(segmentStart, targetIndex - horizon)
        expectedStartByHorizon.set(horizon, prices[firstBase]?.date ?? targetDate)
        for (let baseIndex = firstBase; baseIndex <= targetIndex; baseIndex += 1) {
          const base = prices[baseIndex]
          const end = prices[baseIndex + horizon]
          if (!base || !end || baseIndex + horizon > segmentEnd
            || !(base.close > 0) || !(end.close > 0)) continue
          // Preserve the independently stale Analytics coverage boundary. This
          // audit measures rows made wrong or absent by the 2026-07-17 gap; it
          // must not silently expand a horizon that had never been published.
          if (base.date > baselineMaxDate.get(horizon)!) continue
          const returnPct = 100 * (end.close - base.close) / base.close
          const expected: ForwardRow = {
            date: base.date,
            horizonDays: horizon,
            returnPct,
            returnCategory: category(returnPct),
            endDate: end.date,
          }
          const key = `${expected.date}:${horizon}`
          expectedKeys.add(key)
          expectedHash.update(`${ticker}|${expected.date}|${horizon}|${returnPct.toPrecision(17)}|${expected.returnCategory}|${expected.endDate}\n`)
          affected += 1
          stats.affected += 1
          const actual = currentByKey.get(key)
          if (!actual) {
            missing += 1
            if (expected.date === targetDate) targetDateMissing += 1
            else {
              preExistingMissing += 1
              if (preExistingMissingExamples.length < 20) {
                preExistingMissingExamples.push(`${ticker}:${expected.date}:${horizon}`)
              }
            }
            stats.missing += 1
          } else if (same(expected, actual)) {
            unchanged += 1
            stats.unchanged += 1
          } else {
            changed += 1
            stats.changed += 1
          }
          const repairedActual = repairedByKey.get(key)
          const repairedStats = repairedPerHorizon.get(horizon)!
          repairedStats.affected += 1
          if (!repairedActual) {
            repairedMissing += 1
            repairedStats.missing += 1
          } else if (same(expected, repairedActual)) {
            repairedUnchanged += 1
            repairedStats.unchanged += 1
          } else {
            repairedChanged += 1
            repairedStats.changed += 1
          }
        }
      }
      const unexpectedCurrent = current.filter((row) => {
        if (!HORIZONS.includes(row.horizonDays as typeof HORIZONS[number])) return false
        const start = expectedStartByHorizon.get(row.horizonDays)
        return Boolean(start && row.date >= start && row.date <= baselineMaxDate.get(row.horizonDays)!
          && !expectedKeys.has(`${row.date}:${row.horizonDays}`))
      })
      extra += unexpectedCurrent.length
      for (const row of unexpectedCurrent) {
        if (extraExamples.length < 20) extraExamples.push(`${ticker}:${row.date}:${row.horizonDays}`)
      }
      repairedExtra += repairedCurrent.filter((row) => {
        if (!HORIZONS.includes(row.horizonDays as typeof HORIZONS[number])) return false
        const start = expectedStartByHorizon.get(row.horizonDays)
        return Boolean(start && row.date >= start && row.date <= baselineMaxDate.get(row.horizonDays)!
          && !expectedKeys.has(`${row.date}:${row.horizonDays}`))
      }).length
      if ((index + 1) % 500 === 0) {
        console.error(`audited ${index + 1}/${tickers.length} tickers`)
      }
    }

    const status = repairedMissing === 0 && repairedChanged === 0 && repairedExtra === 0
      ? 'PASS'
      : 'FAIL'
    const receipt = {
      version: 1,
      status,
      createdAt: new Date().toISOString(),
      targetDate,
      repairedDatabase: fs.realpathSync(databasePath),
      baselineDatabase: fs.realpathSync(baselinePath),
      officialEvidence: fs.realpathSync(officialPath),
      tickerCount: tickers.length,
      horizons: [...HORIZONS],
      baselineMaxDate: Object.fromEntries(baselineMaxDate),
      affected,
      missing,
      targetDateMissing,
      preExistingMissing,
      preExistingMissingExamples,
      changed,
      unchanged,
      extra,
      extraExamples,
      repaired: {
        missing: repairedMissing,
        changed: repairedChanged,
        unchanged: repairedUnchanged,
        extra: repairedExtra,
        perHorizon: Object.fromEntries(repairedPerHorizon),
      },
      quarantinePredicate: "approved ticker AND date < '2026-07-17' AND end_date > '2026-07-16'",
      quarantineRowCount,
      quarantineRowsSha256: quarantineHash.digest('hex'),
      quarantinePerHorizon: Object.fromEntries([...quarantinePerHorizon].sort(([left], [right]) => left - right)),
      expectedRowsSha256: expectedHash.digest('hex'),
      perHorizon: Object.fromEntries(perHorizon),
      durationMs: Date.now() - startedAt,
    }
    fs.writeFileSync(outputPath, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 })
    console.log(JSON.stringify(receipt, null, 2))
    if (status !== 'PASS') process.exitCode = 1
  } finally {
    repaired.close()
    baseline.close()
  }
}

main()
