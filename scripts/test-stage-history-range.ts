import assert from 'node:assert/strict'
import {
  STAGE_HISTORY_TRADING_DAY_PRESETS,
  selectStageHistoryWindow,
} from '@/lib/stage-history-window'

type TestRow = {
  date: string
  daily_a_stage: number
  weekly_b_stage: number
}

function buildTradingDays(count: number): TestRow[] {
  const rows: TestRow[] = []
  const cursor = new Date('2018-01-01T00:00:00Z')
  while (rows.length < count) {
    const day = cursor.getUTCDay()
    if (day !== 0 && day !== 6) {
      const index = rows.length
      rows.push({
        date: cursor.toISOString().slice(0, 10),
        daily_a_stage: index % 6 + 1,
        weekly_b_stage: (index * 5) % 6 + 1,
      })
    }
    cursor.setUTCDate(cursor.getUTCDate() + 1)
  }
  return rows
}

function assertNestedAndStable(
  shorter: ReturnType<typeof selectStageHistoryWindow<TestRow>>,
  longer: ReturnType<typeof selectStageHistoryWindow<TestRow>>,
): void {
  const longerByDate = new Map(longer.displayRows.map((row) => [row.date, row]))
  for (const row of shorter.displayRows) {
    const sameDate = longerByDate.get(row.date)
    assert.ok(sameDate, `${row.date} must remain visible in the longer range`)
    assert.equal(sameDate.daily_a_stage, row.daily_a_stage, `daily A Stage changed at ${row.date}`)
    assert.equal(sameDate.weekly_b_stage, row.weekly_b_stage, `weekly B Stage changed at ${row.date}`)
  }
}

const rows = buildTradingDays(1500)
const windows = STAGE_HISTORY_TRADING_DAY_PRESETS.map((days) => (
  selectStageHistoryWindow(rows, 'weekly', days)
))

for (const [index, days] of STAGE_HISTORY_TRADING_DAY_PRESETS.entries()) {
  const window = windows[index]
  assert.equal(window.metadata.requestedTradingDays, days)
  assert.equal(window.metadata.sourceTradingDays, days)
  assert.equal(window.metadata.sourceEndDate, rows.at(-1)?.date)
  assert.equal(window.metadata.displayEndDate, rows.at(-1)?.date)
  assert.equal(window.metadata.displayPoints, window.displayRows.length)
}

assert.ok(windows[0].metadata.sourceStartDate! > windows[1].metadata.sourceStartDate!)
assert.ok(windows[1].metadata.sourceStartDate! > windows[2].metadata.sourceStartDate!)
assertNestedAndStable(windows[0], windows[1])
assertNestedAndStable(windows[1], windows[2])

const daily200 = selectStageHistoryWindow(rows, 'daily', 200)
assert.equal(daily200.metadata.displayPoints, 200)
assert.deepEqual(daily200.displayRows, daily200.sourceRows)

const monthly1200 = selectStageHistoryWindow(rows, 'monthly', 1200)
assert.ok(monthly1200.metadata.displayPoints < monthly1200.metadata.sourceTradingDays)
assert.equal(monthly1200.metadata.displayEndDate, rows.at(-1)?.date)

const pitEndDate = rows[999].date
for (const days of STAGE_HISTORY_TRADING_DAY_PRESETS) {
  const pit = selectStageHistoryWindow(rows, 'weekly', days, pitEndDate)
  assert.equal(pit.metadata.sourceEndDate, pitEndDate)
  assert.equal(pit.metadata.displayEndDate, pitEndDate)
  assert.ok(pit.displayRows.every((row) => row.date <= pitEndDate))
}

const recentListing = selectStageHistoryWindow(rows.slice(-83), 'daily', 1200)
assert.equal(recentListing.metadata.sourceTradingDays, 83)
assert.equal(recentListing.metadata.displayPoints, 83)

console.log(JSON.stringify({
  ok: true,
  unit: 'active_trading_days',
  ranges: windows.map((window) => window.metadata),
  pitEndDate,
  recentListing: recentListing.metadata,
}, null, 2))
