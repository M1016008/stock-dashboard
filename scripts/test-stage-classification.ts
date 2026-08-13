import assert from 'node:assert/strict'
// @ts-expect-error Node 22 provides node:sqlite; the installed @types/node version predates it.
import { DatabaseSync } from 'node:sqlite'
import { calculateStageFromThreeMa, buildMaValuesFromOhlcv } from '@/lib/hex-stage'
import { activeCalendarPeriodCounts, sampleCalendarPeriodEnds } from '@/lib/snapshots/calendar-periods'
import { buildCalendarStageBackfillStatements } from '@/lib/snapshots/calendar-backfill-sql'
import { buildSnapshotCalculations } from '@/lib/snapshots/continuous-ma'
import type { OHLCV } from '@/types/stock'

const permutations: Array<[number, number, number, number]> = [
  [3, 2, 1, 1],
  [2, 3, 1, 2],
  [1, 3, 2, 3],
  [1, 2, 3, 4],
  [2, 1, 3, 5],
  [3, 1, 2, 6],
]
for (const [shortMa, middleMa, longMa, expected] of permutations) {
  assert.equal(calculateStageFromThreeMa(shortMa, middleMa, longMa), expected)
}
assert.equal(calculateStageFromThreeMa(1, 1, 0), null)
assert.equal(calculateStageFromThreeMa(1 + 1e-12, 1, 0), null)
assert.equal(calculateStageFromThreeMa(1 + 1e-8, 1, 0), 1)
assert.equal(calculateStageFromThreeMa(null, 1, 0), null)

function buildWeekdays(start: string, count: number): OHLCV[] {
  const rows: OHLCV[] = []
  const date = new Date(`${start}T00:00:00Z`)
  while (rows.length < count) {
    const day = date.getUTCDay()
    if (day !== 0 && day !== 6) {
      const close = 100 + rows.length * 0.37 + Math.sin(rows.length / 11) * 4
      rows.push({
        date: date.toISOString().slice(0, 10),
        open: close - 0.5,
        high: close + 1,
        low: close - 1,
        close,
        volume: 1_000 + rows.length,
      })
    }
    date.setUTCDate(date.getUTCDate() + 1)
  }
  return rows
}

function assertNumberEqual(actual: number | null, expected: number | null, label: string): void {
  if (actual === null || expected === null) {
    assert.equal(actual, expected, label)
    return
  }
  assert.ok(Math.abs(actual - expected) < 1e-9, `${label}: ${actual} !== ${expected}`)
}

const rows = buildWeekdays('2023-01-02', 820)
const calculations = buildSnapshotCalculations(rows, { includeWarmup: true })
assert.equal(calculations.length, rows.length)

const maKeys = [
  'ma_5', 'ma_25', 'ma_75', 'ma_150', 'ma_300',
  'weekly_ma_5', 'weekly_ma_13', 'weekly_ma_25', 'weekly_ma_50', 'weekly_ma_100',
  'monthly_ma_3', 'monthly_ma_5', 'monthly_ma_10', 'monthly_ma_20', 'monthly_ma_25',
] as const

for (let index = 0; index < rows.length; index += 37) {
  const expected = buildMaValuesFromOhlcv(rows.slice(0, index + 1))
  const actual = calculations[index]
  for (const key of maKeys) assertNumberEqual(actual[key], expected[key], `${actual.date} ${key}`)
}

const withGap = [
  ...buildWeekdays('2020-01-06', 540),
  ...buildWeekdays('2023-01-02', 12),
]
const gapCalculations = buildSnapshotCalculations(withGap, { includeWarmup: true })
const afterGap = gapCalculations.find((row) => row.date === '2023-01-02')
assert.ok(afterGap)
assert.equal(afterGap.activeDays, 1)
assert.equal(afterGap.weekly_ma_5, null)
assert.equal(afterGap.monthly_ma_3, null)

const sampledRows = [
  { date: '2026-05-14' },
  { date: '2026-05-15' },
  { date: '2026-05-18' },
  { date: '2026-05-21' },
  { date: '2026-05-25' },
  { date: '2026-05-29' },
  { date: '2026-06-01' },
]
assert.deepEqual(
  sampleCalendarPeriodEnds(sampledRows, 'weekly', 10).map((row) => row.date),
  ['2026-05-15', '2026-05-21', '2026-05-29', '2026-06-01'],
)
assert.deepEqual(
  sampleCalendarPeriodEnds(sampledRows, 'monthly', 10).map((row) => row.date),
  ['2026-05-29', '2026-06-01'],
)
assert.equal(activeCalendarPeriodCounts(sampledRows, 'weekly').get('2026-06-01'), 4)
assert.equal(activeCalendarPeriodCounts(sampledRows, 'monthly').get('2026-06-01'), 2)

const sqlite = new DatabaseSync(':memory:')
sqlite.exec(`
  CREATE TABLE ohlcv_daily (
    ticker TEXT NOT NULL,
    date TEXT NOT NULL,
    close REAL NOT NULL,
    PRIMARY KEY (ticker, date)
  );
  CREATE TABLE daily_snapshots (
    ticker TEXT NOT NULL,
    date TEXT NOT NULL,
    weekly_ma_5 REAL,
    weekly_ma_13 REAL,
    weekly_ma_25 REAL,
    weekly_ma_50 REAL,
    weekly_ma_100 REAL,
    monthly_ma_3 REAL,
    monthly_ma_5 REAL,
    monthly_ma_10 REAL,
    monthly_ma_20 REAL,
    monthly_ma_25 REAL,
    weekly_a_stage INTEGER,
    weekly_b_stage INTEGER,
    monthly_a_stage INTEGER,
    monthly_b_stage INTEGER,
    computed_at INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (ticker, date)
  );
`)
const insertPrice = sqlite.prepare('INSERT INTO ohlcv_daily(ticker, date, close) VALUES (?, ?, ?)')
const insertSnapshot = sqlite.prepare('INSERT INTO daily_snapshots(ticker, date) VALUES (?, ?)')
sqlite.exec('BEGIN')
for (const row of rows) {
  insertPrice.run('TEST', row.date, row.close)
  insertSnapshot.run('TEST', row.date)
}
sqlite.exec('COMMIT')

sqlite.exec('BEGIN')
for (const statement of buildCalendarStageBackfillStatements('JP', 'TEST')) {
  sqlite.prepare(statement.sql).run(...statement.args)
}
sqlite.exec('COMMIT')

type Stored = Record<(typeof maKeys)[number], number | null> & {
  date: string
  weekly_a_stage: number | null
  weekly_b_stage: number | null
  monthly_a_stage: number | null
  monthly_b_stage: number | null
}
const stored = sqlite.prepare(`
  SELECT date,
    weekly_ma_5, weekly_ma_13, weekly_ma_25, weekly_ma_50, weekly_ma_100,
    monthly_ma_3, monthly_ma_5, monthly_ma_10, monthly_ma_20, monthly_ma_25,
    weekly_a_stage, weekly_b_stage, monthly_a_stage, monthly_b_stage
  FROM daily_snapshots WHERE ticker = 'TEST' ORDER BY date
`).all() as unknown as Stored[]

const calendarMaKeys = maKeys.filter((key) => key.startsWith('weekly_') || key.startsWith('monthly_'))
const stageKeys = ['weekly_a_stage', 'weekly_b_stage', 'monthly_a_stage', 'monthly_b_stage'] as const
for (let index = 0; index < stored.length; index += 1) {
  for (const key of calendarMaKeys) {
    assertNumberEqual(stored[index][key], calculations[index][key], `SQL ${stored[index].date} ${key}`)
  }
  for (const key of stageKeys) {
    assert.equal(stored[index][key], calculations[index][key], `SQL ${stored[index].date} ${key}`)
  }
}
sqlite.close()

console.log('stage classification and calendar snapshot tests passed')
