import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
// @ts-expect-error The pinned Node types predate Node 24's built-in SQLite module.
import { DatabaseSync } from 'node:sqlite'
import {
  StageTransitionInputError,
  searchStageTransitions,
  type StageTransitionQueryExecutor,
} from '@/lib/queries/stage-transition-scanner'
import {
  STAGE_CODE_AXES,
  changedStageCodeAxes,
  isStageCode,
  startOfMonth,
  startOfWeek,
  type StageTransitionSearchInput,
} from '@/lib/stage-transition-scanner'

const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stage-transition-scanner-'))
const fixturePath = path.join(fixtureDir, 'fixture.db')
const db = new DatabaseSync(fixturePath)

db.exec(`
  CREATE TABLE daily_snapshots (
    ticker TEXT NOT NULL,
    date TEXT NOT NULL,
    daily_a_stage INTEGER,
    daily_b_stage INTEGER,
    weekly_a_stage INTEGER,
    weekly_b_stage INTEGER,
    monthly_a_stage INTEGER,
    monthly_b_stage INTEGER,
    PRIMARY KEY (ticker, date)
  );
  CREATE INDEX snapshots_date_idx ON daily_snapshots(date);
  CREATE INDEX snapshots_date_ticker_idx ON daily_snapshots(date, ticker);
  CREATE TABLE ohlcv_daily (
    ticker TEXT NOT NULL,
    date TEXT NOT NULL,
    open REAL NOT NULL,
    high REAL NOT NULL,
    low REAL NOT NULL,
    close REAL NOT NULL,
    volume INTEGER NOT NULL,
    PRIMARY KEY (ticker, date)
  );
  CREATE TABLE ticker_universe (
    ticker TEXT PRIMARY KEY,
    name TEXT,
    active INTEGER NOT NULL,
    sector33_name TEXT,
    market_segment TEXT
  );
`)

const insertStage = db.prepare(`
  INSERT INTO daily_snapshots (
    ticker, date, daily_a_stage, daily_b_stage,
    weekly_a_stage, weekly_b_stage, monthly_a_stage, monthly_b_stage
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`)
const insertPrice = db.prepare(`
  INSERT INTO ohlcv_daily (ticker, date, open, high, low, close, volume)
  VALUES (?, ?, ?, ?, ?, ?, ?)
`)
const insertTicker = db.prepare(`
  INSERT INTO ticker_universe (ticker, name, active, sector33_name, market_segment)
  VALUES (?, ?, 1, ?, ?)
`)

function codeValues(code: string): Array<number | null> {
  return [...code].map((digit) => digit === '0' ? null : Number(digit))
}

function stage(ticker: string, date: string, code: string) {
  insertStage.run(ticker, date, ...codeValues(code))
}

function price(ticker: string, date: string, close: number, volume: number) {
  insertPrice.run(ticker, date, close, close, close, close, volume)
}

function seedTicker(ticker: string, sector = '情報・通信業', market = 'プライム', volume = 100) {
  insertTicker.run(ticker, `銘柄${ticker}`, sector, market)
  for (const [index, date] of ['2026-09-24', '2026-09-25', '2026-09-28', '2026-09-29', '2026-09-30', '2026-10-01', '2026-10-02'].entries()) {
    price(ticker, date, 100 + index, volume + index)
  }
}

seedTicker('A001')
stage('A001', '2026-09-25', '111111')
stage('A001', '2026-09-28', '211111')
stage('A001', '2026-09-29', '211111')

seedTicker('B001')
stage('B001', '2026-09-25', '111111')
stage('B001', '2026-09-28', '111111')
stage('B001', '2026-09-29', '111111')

seedTicker('C001')
stage('C001', '2026-09-25', '111111')
stage('C001', '2026-09-28', '101111')
stage('C001', '2026-09-29', '211111')

seedTicker('D001', '電気・ガス業', 'スタンダード', 1_000)
stage('D001', '2026-09-25', '111111')
stage('D001', '2026-09-28', '211111')
stage('D001', '2026-09-29', '111111')
stage('D001', '2026-09-30', '211111')

seedTicker('E001')
stage('E001', '2026-09-24', '111111')
stage('E001', '2026-09-28', '211111')

seedTicker('F001')
stage('F001', '2026-09-30', '111111')
stage('F001', '2026-10-01', '211111')

seedTicker('G001', 'サービス業', 'グロース', 500)
stage('G001', '2026-10-01', '111111')
stage('G001', '2026-10-02', '211111')
price('G001', '2026-10-03', 999, 99_999_999)

seedTicker('H001')
stage('H001', '2026-10-01', '311111')
stage('H001', '2026-10-02', '211111')

seedTicker('I001', '機械', 'プライム', 320)
stage('I001', '2026-09-25', '211116')
stage('I001', '2026-09-28', '111116')

for (let index = 0; index < 30; index += 1) {
  const ticker = `P${String(index).padStart(3, '0')}`
  seedTicker(ticker, index % 2 === 0 ? '機械' : '小売業', 'プライム', 200 + index)
  stage(ticker, '2026-09-25', '111111')
  stage(ticker, '2026-09-28', '211111')
}

const executor: StageTransitionQueryExecutor = {
  async all<T>(sql: string, args: readonly unknown[] = []) {
    return db.prepare(sql).all(...args) as T[]
  },
  async get<T>(sql: string, args: readonly unknown[] = []) {
    return db.prepare(sql).get(...args) as T | undefined
  },
}

const base: StageTransitionSearchInput = {
  fromCode: '111111',
  toCode: '211111',
  universeFilter: null,
  period: 'week',
  customFrom: null,
  customTo: null,
  industry33: null,
  marketSegment: null,
  minPrice: null,
  maxPrice: null,
  minAvgVolume: null,
  maxAvgVolume: null,
  minAvgTurnover: null,
  maxAvgTurnover: null,
  sort: 'date',
  direction: 'desc',
  page: 1,
  pageSize: 50,
}

async function run() {
  assert.equal(isStageCode('123456'), true)
  assert.equal(isStageCode('123450'), false)
  assert.deepEqual(STAGE_CODE_AXES.map((axis) => axis.label), ['日A', '日B', '週A', '週B', '月A', '月B'])
  assert.equal(startOfWeek('2026-10-02'), '2026-09-28')
  assert.equal(startOfMonth('2026-10-02'), '2026-10-01')
  assert.deepEqual(changedStageCodeAxes('112311', '112211'), [
    { key: 'weeklyB', label: '週B', from: 3, to: 2 },
  ])

  const week = await searchStageTransitions(base, executor)
  assert.equal(week.range.startDate, '2026-09-28')
  assert.equal(week.range.previousMarketDate, '2026-09-25')
  assert.equal(week.total, 36, 'week includes Friday-to-Monday transitions and keeps repeated events')
  assert.equal(week.rows.filter((row) => row.ticker === 'D001').length, 2, 'multiple exact events for one ticker are retained')
  assert.equal(week.rows.some((row) => row.ticker === 'C001'), false, 'missing Stage observation must break the transition chain')
  assert.equal(week.rows.some((row) => row.ticker === 'E001'), true, 'ticker-specific predecessor is used when the shared prior session is absent')
  assert.equal(new Set(week.rows.map((row) => `${row.ticker}:${row.transitionDate}`)).size, week.rows.length)

  const noTransition = await searchStageTransitions({ ...base, fromCode: '111111', toCode: '111112' }, executor)
  assert.equal(noTransition.total, 0)

  const primaryRecoveryCase = await searchStageTransitions({ ...base, fromCode: '211111', toCode: '111111' }, executor)
  assert.deepEqual(
    primaryRecoveryCase.rows.map((row) => `${row.ticker}:${row.transitionDate}`),
    ['D001:2026-09-29'],
    '211111 -> 111111 is matched as an exact observed transition',
  )

  const monthlyAxisCase = await searchStageTransitions({ ...base, fromCode: '211116', toCode: '111116' }, executor)
  assert.deepEqual(
    monthlyAxisCase.rows.map((row) => `${row.ticker}:${row.transitionDate}`),
    ['I001:2026-09-28'],
    '211116 -> 111116 preserves all six stage axes in order',
  )

  const anyArrival = await searchStageTransitions({ ...base, fromCode: 'any', toCode: '211111' }, executor)
  assert.equal(anyArrival.total, 37, 'Any to exact includes every actual source code')
  assert.equal(anyArrival.rows.some((row) => row.ticker === 'H001' && row.fromCode === '311111'), true)

  const anyDeparture = await searchStageTransitions({ ...base, fromCode: '111111', toCode: 'any' }, executor)
  assert.equal(anyDeparture.total, 36, 'exact to Any includes every changed destination code')

  const anyChange = await searchStageTransitions({ ...base, fromCode: 'any', toCode: 'any' }, executor)
  assert.equal(anyChange.total, 39, 'Any to Any includes changed states and excludes stable rows')
  assert.equal(anyChange.rows.some((row) => row.fromCode === row.toCode), false)

  const industry = await searchStageTransitions({ ...base, industry33: '電気・ガス業' }, executor)
  assert.deepEqual(industry.rows.map((row) => row.ticker), ['D001', 'D001'])

  const market = await searchStageTransitions({ ...base, marketSegment: 'スタンダード' }, executor)
  assert.deepEqual(market.rows.map((row) => row.ticker), ['D001', 'D001'])

  const liquid = await searchStageTransitions({ ...base, minAvgVolume: 900 }, executor)
  assert.deepEqual(liquid.rows.map((row) => row.ticker), ['D001', 'D001'])

  const higherPrice = await searchStageTransitions({ ...base, minPrice: 103 }, executor)
  assert.deepEqual(
    higherPrice.rows.map((row) => `${row.ticker}:${row.transitionDate}`),
    ['G001:2026-10-02', 'F001:2026-10-01', 'D001:2026-09-30'],
  )
  assert.equal(higherPrice.rows.every((row) => (row.price ?? 0) >= 103), true)

  const higherTurnover = await searchStageTransitions({ ...base, minAvgTurnover: 90_000 }, executor)
  assert.deepEqual(higherTurnover.rows.map((row) => row.ticker), ['D001', 'D001'])

  const ascending = await searchStageTransitions({ ...base, sort: 'ticker', direction: 'asc' }, executor)
  assert.equal(ascending.rows[0]?.ticker, 'A001')

  const pageOne = await searchStageTransitions({ ...base, pageSize: 25 }, executor)
  const pageTwo = await searchStageTransitions({ ...base, pageSize: 25, page: 2 }, executor)
  assert.equal(pageOne.rows.length, 25)
  assert.equal(pageTwo.rows.length, 11)
  assert.equal(pageTwo.total, 36)
  assert.equal(new Set([...pageOne.rows, ...pageTwo.rows].map((row) => `${row.ticker}:${row.transitionDate}`)).size, 36)

  const pageOutOfRange = await searchStageTransitions({ ...base, pageSize: 25, page: 99 }, executor)
  assert.equal(pageOutOfRange.rows.length, 0)
  assert.equal(pageOutOfRange.total, 36)
  assert.equal(pageOutOfRange.totalPages, 2)

  const month = await searchStageTransitions({ ...base, period: 'month' }, executor)
  assert.equal(month.range.startDate, '2026-10-01')
  assert.equal(month.rows.some((row) => row.ticker === 'F001' && row.transitionDate === '2026-10-01'), true)

  const today = await searchStageTransitions({ ...base, period: 'today' }, executor)
  assert.deepEqual(today.rows.map((row) => row.ticker), ['G001'])
  assert.ok((today.rows[0]?.averageVolume20 ?? 0) < 1_000, 'future OHLCV must not enter event-date averages')

  const custom = await searchStageTransitions({
    ...base,
    period: 'custom',
    customFrom: '2026-09-29',
    customTo: '2026-09-30',
  }, executor)
  assert.deepEqual(custom.rows.map((row) => `${row.ticker}:${row.transitionDate}`), ['D001:2026-09-30'])

  const weekendStart = await searchStageTransitions({
    ...base,
    period: 'custom',
    customFrom: '2026-09-26',
    customTo: '2026-09-28',
  }, executor)
  assert.equal(weekendStart.range.startDate, '2026-09-28')
  assert.equal(weekendStart.range.previousMarketDate, '2026-09-25')
  assert.equal(weekendStart.rows.some((row) => row.ticker === 'A001'), true)

  const maximumCustomRange = await searchStageTransitions({
    ...base,
    period: 'custom',
    customFrom: '2025-10-02',
    customTo: '2026-10-02',
  }, executor)
  assert.equal(maximumCustomRange.range.requestedStartDate, '2025-10-02', '366 calendar days are accepted')

  await assert.rejects(
    () => searchStageTransitions({
      ...base,
      period: 'custom',
      customFrom: '2025-10-01',
      customTo: '2026-10-02',
    }, executor),
    (error: unknown) => error instanceof StageTransitionInputError && error.code === 'custom_range_too_large',
  )

  await assert.rejects(
    () => searchStageTransitions({ ...base, fromCode: '111110' }, executor),
    (error: unknown) => error instanceof StageTransitionInputError && error.code === 'invalid_stage_code',
  )
  await assert.rejects(
    () => searchStageTransitions({ ...base, fromCode: '111111', toCode: '111111' }, executor),
    (error: unknown) => error instanceof StageTransitionInputError && error.code === 'unchanged_stage_code',
  )
}

run()
  .then(() => console.log('stage transition scanner tests passed'))
  .finally(() => {
    db.close()
    fs.rmSync(fixtureDir, { recursive: true, force: true })
  })
