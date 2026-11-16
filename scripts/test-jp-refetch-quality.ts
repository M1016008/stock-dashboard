import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
// @ts-expect-error The pinned Node types predate Node 24's built-in SQLite module.
import { DatabaseSync } from 'node:sqlite'
import type { JBarRow } from '@/lib/jquants'
import { adjInconsistentRows, insane, multipliers, returnMismatches, runQuality, splitJumps, type Bar } from '@/lib/research/jp-refetch-quality'
import { assertOutput, runRefetch } from '@/lib/research/jp-research-refetch'
import { sha256File } from '@/lib/research/six-stage-real-data-contract'

const bar = (date: string, c: number | null, f: number | null = 1, adjc: number | null = c): Bar => ({ date, o: c, h: c, l: c, c, vo: 100, f, adjc })

// A 1:2 split on day 3 (AdjFactor 0.5): earlier prices halve, so the rebuilt series is continuous.
const split = [bar('2022-11-21', 200, 1, 100), bar('2022-11-22', 210, 1, 105), bar('2022-11-24', 104, 0.5, 104), bar('2022-11-25', 106, 1, 106)]
const { m, missing } = multipliers(split)
assert.deepEqual([m, missing], [[0.5, 0.5, 1, 1], 0])
assert.equal(multipliers([bar('2022-11-21', 100, null)]).missing, 1)          // no AdjFactor
assert.equal(multipliers([bar('2022-11-21', 100, 1, null)]).missing, 1)       // traded row without AdjC
assert.equal(multipliers([bar('2022-11-21', null, 1, null)]).missing, 0)      // no trade: AdjC may be empty
assert.equal(adjInconsistentRows(split, m), 0)
// A later split only scales AdjC by one constant; 0.1-yen rounding is allowed even across very different price levels.
const wide = [bar('2017-01-04', 30), bar('2022-11-25', 30_000)].map((b) => ({ ...b, adjc: Math.round(b.c! * 0.013 * 10) / 10 }))
assert.equal(adjInconsistentRows(wide, multipliers(wide).m), 0)
assert.equal(adjInconsistentRows(split.map((b, i) => ({ ...b, adjc: i === 1 ? 210 : b.adjc })), m), 1)   // one row not adjusted
assert.deepEqual(splitJumps(split, m), { events: 1, unchecked: 0, jumps: 0 })
const missed = split.map((b) => ({ ...b, c: b.date === '2022-11-24' ? 52 : b.c }))
assert.equal(splitJumps(missed, multipliers(missed).m).jumps, 1)   // a 50%+ move on an ex-date is flagged
assert.deepEqual(splitJumps([split[1], { ...split[2], c: null }], [1, 1]), { events: 0, unchecked: 1, jumps: 0 })
// Returns against the Discovery source: only consecutive days that both have.
const disc = new Map([['2022-11-21', { prev: null, close: 100 }], ['2022-11-22', { prev: '2022-11-21', close: 105 }],
  ['2022-11-24', { prev: '2022-11-22', close: 104 }], ['2022-11-25', { prev: '2022-11-24', close: 120 }]])
assert.deepEqual(returnMismatches(split, m, disc), { compared: 3, mismatched: 1 })
assert.ok(insane({ ...split[0], h: 100, l: 120 }) && insane({ ...split[0], vo: -1 }) && insane({ ...split[0], o: null }))
assert.ok(!insane(bar('2022-11-21', null)))

type Fixture = { bars: (date: string) => JBarRow[]; listings?: (date: string) => string[]; discovery?: [string, string, number][]; from?: string; to?: string }
async function check(name: string, base: string, fixture: Fixture) {
  const root = path.join(base, 'root')
  const directory = assertOutput(path.join(root, name), root, false)
  const range = { from: fixture.from ?? '2022-10-24', to: fixture.to ?? '2022-11-30' }
  await runRefetch({ directory, resume: false, ...range, pauseMs: 0, log: () => undefined,
    sleep: async () => undefined,
    source: { bars: async (date) => fixture.bars(date), listings: async (date) => (fixture.listings ?? ((d) => fixture.bars(d).map((r) => r.Code)))(date)
      .map((code) => ({ Date: date, Code: code, CoName: code })) } })
  const discoveryPath = path.join(base, `${name}.sqlite`)
  const db = new DatabaseSync(discoveryPath)
  db.exec('CREATE TABLE ohlcv_daily(ticker TEXT NOT NULL,date TEXT NOT NULL,open REAL,high REAL,low REAL,close REAL,volume REAL,PRIMARY KEY(ticker,date)) WITHOUT ROWID')
  for (const [ticker, date, close] of fixture.discovery ?? []) db.prepare('INSERT INTO ohlcv_daily VALUES (?,?,?,?,?,?,?)').run(ticker, date, 1, 1, 1, close, 1)
  db.close()
  return { directory, discoveryPath, run: (sha = sha256File(discoveryPath), want = range) => runQuality({ refetchDirectory: directory, range: want, discoveryPath, discoverySha256: sha, excludedTickers: new Set() }) }
}

const row = (date: string, code: string, c: number | null, f: number | null = 1): JBarRow => ({ Date: date, Code: code, O: c, H: c, L: c, C: c, UL: '0', LL: '0',
  Vo: 100, Va: 100, AdjFactor: f, AdjO: c, AdjH: c, AdjL: c, AdjC: c, AdjVo: 100 })
const holiday = (date: string) => date === '2022-11-03' || date === '2022-11-23'
const price = (date: string) => 100 + Number(date.slice(5, 7)) * 3 + Number(date.slice(8))

async function main(): Promise<void> {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'quality-test-'))
  const discoveryDays: [string, string, number][] = []
  for (let d = new Date('2022-10-24T00:00:00Z'); d <= new Date('2022-11-30T00:00:00Z'); d.setUTCDate(d.getUTCDate() + 1)) {
    const date = d.toISOString().slice(0, 10)
    if (d.getUTCDay() % 6 !== 0 && !holiday(date)) discoveryDays.push(['1301', date, price(date)])
  }
  const good = (date: string) => (holiday(date) ? [] : [row(date, '13010', price(date)), row(date, '72030', 500)])
  const ok = await check('ok', base, { bars: good, discovery: discoveryDays })
  assert.throws(() => ok.run('0'.repeat(64)), /DISCOVERY_SHA256_MISMATCH/)
  assert.throws(() => ok.run(undefined, { from: '2022-10-03', to: '2022-11-30' }), /NOT_THE_DISCOVERY_RUN/)   // a shorter run
  const { report, stops } = ok.run()
  assert.deepEqual(stops, [])
  assert.equal(report.tradingDays, 26)
  assert.equal((report.discovery as { compared: number }).compared, 25)
  assert.deepEqual((report.monthEnds as { date: string }[]).map((x) => x.date), ['2022-10-31', '2022-11-30'])
  // One month-end with all bars missing stops the gate even if other months are fine.
  const listingGap = await check('listing', base, { bars: (date) => (date === '2022-10-31' ? [row(date, '13010', price(date))] : good(date)),
    listings: () => ['13010', '72030'], discovery: discoveryDays })
  assert.ok(listingGap.run().stops.some((s) => s.startsWith('LISTING_MISMATCH:2022-10-31')))
  // A missing trading day, a missing AdjFactor, and no overlap with the Discovery source each stop the gate.
  const gap = await check('gap', base, { bars: (date) => (date === '2022-11-10' ? [] : good(date)), discovery: discoveryDays })
  assert.ok(gap.run().stops.includes('EMPTY_TRADING_DAYS:2022-11-10'))
  const noFactor = await check('factor', base, { bars: (date) => good(date).map((r) => (date === '2022-11-15' ? { ...r, AdjFactor: null } : r)), discovery: discoveryDays })
  assert.ok(noFactor.run().stops.includes('ADJ_VALUES_MISSING'))
  const noOverlap = await check('overlap', base, { bars: good })
  assert.ok(noOverlap.run().stops.includes('DISCOVERY_RETURN_MISMATCH'))
  // 2020-10-01 (TSE halt) may be empty.
  const halt = await check('halt', base, { from: '2020-09-28', to: '2020-10-02', bars: (date) => (date === '2020-10-01' ? [] : [row(date, '13010', 100)]) })
  assert.ok(!halt.run().stops.some((s) => s.startsWith('EMPTY_TRADING_DAYS')))
  fs.rmSync(base, { recursive: true, force: true })
  console.log('jp-refetch-quality tests passed')
}

main().catch((error) => { console.error(error); process.exitCode = 1 })
