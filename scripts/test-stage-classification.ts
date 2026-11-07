import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
// @ts-expect-error Node 22 provides node:sqlite; the installed @types/node version predates it.
import { DatabaseSync } from 'node:sqlite'
import {
  STAGE_COMPARISON_RELATIVE_EPSILON,
  calculateStageFromThreeMa,
  buildMaValuesFromOhlcv,
} from '@/lib/hex-stage'
import { stageFromThreeMa } from '@/lib/timeframes'
import {
  MA_SEQUENCE_LEGACY_STRICT_VERSION,
  MA_SEQUENCE_VERSION,
  buildMaSequenceEmbedding,
  prepareMaSequence,
  resolveMaSequenceBuildVersion,
  stageCodeAt,
  type MaSequenceFrame,
  type MaSequencePrepared,
} from '@/lib/ml/ma-sequence'
import {
  JP_REPAIR_ANALOG_CONTRACT,
  assertJpRepairAnalogMeta,
} from '@/lib/jp-ohlcv-repair-stage-environment'
import { assertIsolatedRuntimeEnvironment, createIsolatedRuntimeEnvironment } from '@/lib/runtime/isolation'
import { activeCalendarPeriodCounts, sampleCalendarPeriodEnds } from '@/lib/snapshots/calendar-periods'
import {
  buildCalendarStageBackfillStatements,
  buildCalendarStageBatchBackfillStatements,
} from '@/lib/snapshots/calendar-backfill-sql'
import { buildSnapshotCalculations } from '@/lib/snapshots/continuous-ma'
import type { OHLCV } from '@/types/stock'

function mlStageFromThree(a: number, b: number, c: number): number | null {
  const frame: MaSequenceFrame = {
    step: 1,
    periods: [1, 2, 3],
    mas: [[a], [b], [c]],
    bucketKeys: ['test'],
    velocityIndexes: [-1],
  }
  const prepared: MaSequencePrepared = {
    rows: [{ date: '2026-01-05', close: 1 }],
    stage: frame,
    daily: frame,
    weekly: frame,
    monthly: frame,
    yearly: frame,
  }
  const code = stageCodeAt(prepared, 0)
  return code == null ? null : Number(code)
}

const classifiers = [
  ['snapshot', calculateStageFromThreeMa],
  ['chart', stageFromThreeMa],
  ['ml', mlStageFromThree],
] as const

const permutations: Array<[number, number, number, number]> = [
  [3, 2, 1, 1],
  [2, 3, 1, 2],
  [1, 3, 2, 3],
  [1, 2, 3, 4],
  [2, 1, 3, 5],
  [3, 1, 2, 6],
]
for (const [shortMa, middleMa, longMa, expected] of permutations) {
  for (const [label, classify] of classifiers) {
    assert.equal(classify(shortMa, middleMa, longMa), expected, `${label} permutation ${shortMa}/${middleMa}/${longMa}`)
  }
}

for (const first of [0, 1, 2]) {
  for (const second of [0, 1, 2]) {
    for (const third of [0, 1, 2]) {
      if (new Set([first, second, third]).size === 3) continue
      for (const [label, classify] of classifiers) {
        assert.equal(classify(first, second, third), null, `${label} exact tie ${first}/${second}/${third}`)
      }
    }
  }
}

for (const scale of [1, 1_000_000]) {
  const near = STAGE_COMPARISON_RELATIVE_EPSILON * Math.max(1, scale) * 0.5
  const low = scale * 0.5
  const nearTieCases: Array<[number, number, number]> = [
    [scale + near, scale, low],
    [scale, scale + near, low],
    [scale + near, low, scale],
    [scale, low, scale + near],
    [low, scale + near, scale],
    [low, scale, scale + near],
  ]
  for (const values of nearTieCases) {
    for (const [label, classify] of classifiers) {
      assert.equal(classify(...values), null, `${label} near tie ${values.join('/')}`)
    }
  }
}

for (const [label, classify] of classifiers) {
  assert.equal(classify(1 + 1e-8, 1, 0), 1, `${label} resolves values outside tolerance`)
}
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

const splitRows = buildWeekdays('2026-01-05', 86).map((row, index) => {
  const close = index < 80 ? 800 : 100
  return {
    ...row,
    open: close,
    high: close,
    low: close,
    close,
    volume: index < 80 ? 1_000 : 8_000,
  }
})
const splitCalculations = buildSnapshotCalculations(splitRows, { includeWarmup: true })
const latestSplitCalculation = splitCalculations.at(-1)
assert.ok(latestSplitCalculation)
assertNumberEqual(latestSplitCalculation.ma_5, 100, '1:8 split ma_5')
assertNumberEqual(latestSplitCalculation.ma_25, 100, '1:8 split ma_25')
assertNumberEqual(latestSplitCalculation.ma_75, 100, '1:8 split ma_75')

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

const batchSqlite = new DatabaseSync(':memory:')
batchSqlite.exec(`
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
const batchInsertPrice = batchSqlite.prepare('INSERT INTO ohlcv_daily(ticker, date, close) VALUES (?, ?, ?)')
const batchInsertSnapshot = batchSqlite.prepare('INSERT INTO daily_snapshots(ticker, date) VALUES (?, ?)')
batchSqlite.exec('BEGIN')
for (const ticker of ['FIRST', 'SECOND']) {
  for (const row of rows) {
    batchInsertPrice.run(ticker, row.date, ticker === 'FIRST' ? row.close : row.close * 1.7)
    batchInsertSnapshot.run(ticker, row.date)
  }
}
batchSqlite.exec('COMMIT')
batchSqlite.exec('BEGIN')
for (const statement of buildCalendarStageBatchBackfillStatements('JP', ['FIRST', 'SECOND'])) {
  batchSqlite.prepare(statement.sql).run(...statement.args)
}
batchSqlite.exec('COMMIT')
for (const ticker of ['FIRST', 'SECOND']) {
  const batchStored = batchSqlite.prepare(`
    SELECT date,
      weekly_ma_5, weekly_ma_13, weekly_ma_25, weekly_ma_50, weekly_ma_100,
      monthly_ma_3, monthly_ma_5, monthly_ma_10, monthly_ma_20, monthly_ma_25,
      weekly_a_stage, weekly_b_stage, monthly_a_stage, monthly_b_stage
    FROM daily_snapshots WHERE ticker = ? ORDER BY date
  `).all(ticker) as unknown as Stored[]
  for (let index = 0; index < batchStored.length; index += 1) {
    for (const key of calendarMaKeys) {
      const scale = ticker === 'FIRST' ? 1 : 1.7
      const expected = calculations[index][key]
      assertNumberEqual(
        batchStored[index][key],
        expected == null ? null : expected * scale,
        `batch SQL ${ticker} ${batchStored[index].date} ${key}`,
      )
    }
    for (const key of stageKeys) {
      assert.equal(
        batchStored[index][key],
        calculations[index][key],
        `batch SQL ${ticker} ${batchStored[index].date} ${key}`,
      )
    }
  }
}
batchSqlite.close()

// Repair-only analog v2 compatibility: strict historical stages, v2 pin, v3 unchanged.
assert.equal(resolveMaSequenceBuildVersion(undefined), MA_SEQUENCE_VERSION)
assert.equal(resolveMaSequenceBuildVersion(' '), MA_SEQUENCE_VERSION)
assert.equal(resolveMaSequenceBuildVersion('3'), MA_SEQUENCE_VERSION)
assert.equal(resolveMaSequenceBuildVersion('2'), MA_SEQUENCE_LEGACY_STRICT_VERSION)
for (const bad of ['1', '4', 'abc', '2.5']) {
  assert.throws(() => resolveMaSequenceBuildVersion(bad), /unsupported analog build version pin/, `pin ${bad}`)
}
{
  const strictCode = (a: number, b: number, c: number): string | null => {
    const frame: MaSequenceFrame = { step: 1, periods: [1, 2, 3], mas: [[a], [b], [c]], bucketKeys: ['test'], velocityIndexes: [-1] }
    const prepared: MaSequencePrepared = {
      rows: [{ date: '2026-01-05', close: 1 }], stage: frame, daily: frame, weekly: frame, monthly: frame, yearly: frame,
      legacyStrictStages: true,
    }
    return stageCodeAt(prepared, 0)
  }
  // Clear orderings agree with the canonical classifier.
  for (const [short, middle, long, expected] of permutations) {
    assert.equal(strictCode(short, middle, long), String(expected), `strict ${short}/${middle}/${long}`)
  }
  // A near tie below the canonical epsilon: strict still orders it, canonical does not.
  const near = STAGE_COMPARISON_RELATIVE_EPSILON * 0.5
  assert.equal(strictCode(1 + near, 1, 0.5), '1', 'strict v2 orders a sub-epsilon difference')
  assert.equal(mlStageFromThree(1 + near, 1, 0.5), null, 'canonical v3 treats it as a tie')
  // Exact ties are unclassified in both.
  assert.equal(strictCode(1, 1, 0.5), null)

  // Over a real series with no near ties the two builds are byte-identical.
  const rows = Array.from({ length: 520 }, (_, index) => ({
    date: new Date(Date.UTC(2024, 0, 1 + index)).toISOString().slice(0, 10),
    close: 100 + 20 * Math.sin(index / 17) + index * 0.05,
  }))
  const canonical = prepareMaSequence(rows)
  const strict = prepareMaSequence(rows, { legacyStrictStages: true })
  assert.equal(canonical.legacyStrictStages, undefined, 'the default build never selects strict stages')
  assert.equal(strict.legacyStrictStages, true)
  let compared = 0
  for (let index = 250; index < rows.length; index += 7) {
    assert.equal(stageCodeAt(strict, index), stageCodeAt(canonical, index), `stage code ${index}`)
    const left = buildMaSequenceEmbedding(canonical, index)
    const right = buildMaSequenceEmbedding(strict, index)
    assert.deepEqual(right, left, `embedding ${index}`)
    compared += 1
  }
  assert.ok(compared > 20)
  // A near-flat rising series (sub-epsilon MA gaps) is where strict v2 and canonical v3 differ; the flag selects the difference.
  const flat = Array.from({ length: 300 }, (_, index) => ({
    date: new Date(Date.UTC(2024, 0, 1 + index)).toISOString().slice(0, 10),
    close: 100 + index * 1e-10,
  }))
  const flatStrict = stageCodeAt(prepareMaSequence(flat, { legacyStrictStages: true }), 299)
  const flatCanonical = stageCodeAt(prepareMaSequence(flat), 299)
  assert.notEqual(flatStrict, null, 'strict v2 classifies sub-epsilon gaps')
  assert.equal(flatCanonical, null, 'canonical v3 treats them as ties')
}

// Real scripts/build-analog-sequence-index.ts against synthetic SQLite under the
// isolation launcher's test environment, unmodified (guards, HOME, TMPDIR and
// every database path pinned inside a temporary root; no Production or OWC
// path). Proves the v2 pin writes completed v2 meta that assertJpRepairAnalogMeta
// accepts, differs from the default v3 build only where strict stage
// classification differs, and never reaches a US build. It does not exercise
// the 28-stage repair.
{
  const series = (name: string, rows: number, close: (index: number) => number) =>
    Array.from({ length: rows }, (_, index) => [
      name, new Date(Date.UTC(2024, 0, 1 + index)).toISOString().slice(0, 10), close(index),
    ] as const)
  const fixture = [
    ...series('SINE', 520, (index) => 100 + 20 * Math.sin(index / 17) + index * 0.05),
    ...series('FLAT', 400, (index) => 100 + index * 1e-10),
  ]
  const buildAnalog = (market: 'JP' | 'US', pin: string | undefined) => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'stockboard-analog-v2-')))
    try {
      const environment = createIsolatedRuntimeEnvironment('test', root, process.env)
      assertIsolatedRuntimeEnvironment(environment)
      for (const dir of [environment.HOME!, environment.TMPDIR!, environment.XDG_CACHE_HOME!]) {
        assert.ok(dir.startsWith(`${root}${path.sep}`), `${dir} is inside the isolated root`)
        fs.mkdirSync(dir, { recursive: true })
      }
      if (pin !== undefined) environment.JP_REPAIR_ANALOG_META_VERSION = pin
      const source = market === 'US' ? environment.US_ANALYTICS_DB_PATH! : environment.STOCKBOARD_DB_PATH!
      const target = market === 'US' ? environment.ANALOG_US_DB_PATH! : environment.ANALOG_JP_DB_PATH!
      for (const file of [source, target]) assert.ok(file.startsWith(`${root}${path.sep}`), `${file} is inside the isolated root`)
      fs.mkdirSync(path.dirname(source), { recursive: true })
      const sourceDb = new DatabaseSync(source)
      sourceDb.exec('CREATE TABLE ohlcv_daily (ticker TEXT NOT NULL, date TEXT NOT NULL, close REAL, PRIMARY KEY (ticker, date))')
      const insert = sourceDb.prepare('INSERT INTO ohlcv_daily(ticker, date, close) VALUES (?, ?, ?)')
      for (const row of fixture) insert.run(...row)
      if (market === 'US') {
        sourceDb.exec(`CREATE TABLE us_analytics_copy_state (ticker TEXT PRIMARY KEY, status TEXT NOT NULL, ohlcv_rows INTEGER NOT NULL);
          INSERT INTO us_analytics_copy_state SELECT ticker, 'done', COUNT(*) FROM ohlcv_daily GROUP BY ticker`)
      }
      sourceDb.close()
      const child = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/build-analog-sequence-index.ts', market, 'full'],
        { cwd: process.cwd(), env: environment, encoding: 'utf8' })
      assert.equal(child.status, 0, `${child.stdout}\n${child.stderr}`)
      const db = new DatabaseSync(target, { readOnly: true })
      try {
        assert.equal((db.prepare('PRAGMA quick_check').get() as { quick_check: string }).quick_check, 'ok')
        const meta = Object.fromEntries((db.prepare('SELECT key, value FROM analog_sequence_meta').all() as Array<{ key: string; value: string }>)
          .map((row) => [row.key, row.value]))
        const count = (table: string) => (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n
        const stages = new Map((db.prepare('SELECT ticker, date, stage_code FROM analog_sequence_index').all() as
          Array<{ ticker: string; date: string; stage_code: string | null }>).map((row) => [`${row.ticker}|${row.date}`, row.stage_code]))
        let repairMeta: Error | ReturnType<typeof assertJpRepairAnalogMeta>
        try { repairMeta = assertJpRepairAnalogMeta(target) } catch (error) { repairMeta = error as Error }
        return { meta, index: count('analog_sequence_index'), prices: count('analog_sequence_prices'), stages, repairMeta }
      } finally {
        db.close()
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  }
  const v2 = buildAnalog('JP', String(JP_REPAIR_ANALOG_CONTRACT.metaVersion))
  const v3 = buildAnalog('JP', undefined)
  const us = buildAnalog('US', String(JP_REPAIR_ANALOG_CONTRACT.metaVersion))
  assert.equal(v2.meta.version, '2')
  assert.deepEqual(v2.repairMeta, { version: 2, sourceDate: v2.meta.source_date }, 'the repair accepts the pinned v2 build')
  assert.equal(v3.meta.version, String(MA_SEQUENCE_VERSION))
  assert.ok(v3.repairMeta instanceof Error && /must be completed version 2/.test(v3.repairMeta.message),
    'the repair rejects a default v3 build')
  assert.equal(us.meta.version, String(MA_SEQUENCE_VERSION), 'the JP repair pin never changes a US build')
  assert.ok(us.repairMeta instanceof Error)
  assert.deepEqual(us.stages, v3.stages, 'a US build with the JP pin set is the default v3 build')
  for (const built of [v2, v3, us]) {
    assert.equal(built.meta.completed, '1')
    assert.ok(built.index > 0 && built.prices === fixture.length, 'index and price data are present')
  }
  assert.deepEqual([...v2.stages.keys()].sort(), [...v3.stages.keys()].sort())
  let flatDiffers = 0
  for (const [key, stage] of v2.stages) {
    if (key.startsWith('FLAT|')) {
      if (stage !== v3.stages.get(key)) flatDiffers += 1
    } else {
      assert.equal(stage, v3.stages.get(key), `non-tie series is identical in v2 and v3: ${key}`)
    }
  }
  assert.ok(flatDiffers > 0, 'strict v2 classifies sub-epsilon rows that v3 leaves unclassified')
  assert.ok([...v3.stages].every(([key, stage]) => !key.startsWith('FLAT|') || stage === null))
}

console.log('stage classification and calendar snapshot tests passed')
