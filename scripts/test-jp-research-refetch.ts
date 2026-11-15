import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
// @ts-expect-error The pinned Node types predate Node 24's built-in SQLite module.
import { DatabaseSync } from 'node:sqlite'
import { fetchJQuantsDailyBarsRawByDate, fetchJQuantsDailyByDate, type JBarRow, type JListedInfoRow } from '@/lib/jquants'
import { assertOutput, assertRange, runRefetch, weekdays } from '@/lib/research/jp-research-refetch'

const bar = (date: string, code: string, close: number | null): JBarRow => ({ Date: date, Code: code, O: close, H: close, L: close, C: close,
  UL: '0', LL: '0', Vo: 1000, Va: 1000, AdjFactor: 1, AdjO: close, AdjH: close, AdjL: close, AdjC: close, AdjVo: 1000 })
const listing = (date: string, code: string): JListedInfoRow => ({ Date: date, Code: code, CoName: `c${code}`, MktNm: 'プライム', ProdCat: '011' })
const count = (file: string, sql: string) => {
  const db = new DatabaseSync(file, { readOnly: true })
  try { return Number(db.prepare(sql).get()?.n) } finally { db.close() }
}

async function testLibraryFetch(): Promise<void> {
  // The raw fetch follows pages; the existing adjusted fetch keeps its output (4-digit code, no null close, sorted).
  process.env.JQUANTS_API_KEY = 'test-key'
  const pages = [{ data: [bar('2022-11-30', '72030', 10), bar('2022-11-30', '13010', null)], pagination_key: 'p2' },
    { data: [bar('2022-11-30', '13050', 5)] }]
  const realFetch = globalThis.fetch
  const urls: string[] = []
  globalThis.fetch = (async (url: string) => {
    urls.push(String(url))
    return new Response(JSON.stringify(pages[String(url).includes('pagination_key=p2') ? 1 : 0]), { status: 200 })
  }) as typeof fetch
  try {
    assert.deepEqual((await fetchJQuantsDailyBarsRawByDate('2022-11-30')).map((row) => row.Code), ['72030', '13010', '13050'])
    assert.equal(urls.length, 2)
    assert.deepEqual((await fetchJQuantsDailyByDate('2022-11-30')).map((row) => [row.ticker, row.close]), [['1305', 5], ['7203', 10]])
    globalThis.fetch = (async () => new Response('busy', { status: 429 })) as typeof fetch
    await assert.rejects(fetchJQuantsDailyBarsRawByDate('2022-11-30'), /429/)
  } finally { globalThis.fetch = realFetch }
}

async function main(): Promise<void> {
  await testLibraryFetch()
  assert.equal(weekdays('2022-12-30', '2023-01-02').length, 2)   // Fri 12-30, Mon 01-02
  assert.deepEqual(weekdays('2022-12-24', '2022-12-25'), [])
  assert.doesNotThrow(() => assertRange('2016-11-16', '2022-12-30'))
  assert.throws(() => assertRange('2016-11-16', '2023-01-04'), /RANGE_AFTER_DISCOVERY_END/)
  assert.throws(() => assertRange('2022-12-30', '2022-12-01'), /RANGE_INVALID/)
  assert.throws(() => assertRange('2022-02-31', '2022-03-01'), /RANGE_INVALID/)

  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'refetch-test-'))
  const root = path.join(base, 'root')                    // created by the first run
  assert.throws(() => assertOutput('relative/x', root, false), /ABSOLUTE/)
  assert.throws(() => assertOutput(path.join(base, 'elsewhere'), root, false), /OUTSIDE_ROOT/)
  assert.throws(() => assertOutput(path.join(root, 'a', 'b'), root, false), /OUTSIDE_ROOT/)
  assert.throws(() => assertOutput(path.join(root, 'missing'), root, true), /RESUME_TARGET_MISSING/)
  const directory = assertOutput(path.join(root, 'run1'), root, false)

  // 2022-11-23 is a holiday (no rows). 11-29 fails once with 429 (retried); 11-30 fails for good, so the run stops.
  let failOnce429 = true
  const calls: string[] = []
  const source = (failDay: string | null) => ({
    bars: async (date: string) => {
      calls.push(date)
      if (date === failDay) throw new Error('J-Quants bars/daily 失敗: 400 bad')
      if (date === '2022-11-29' && failOnce429) { failOnce429 = false; throw new Error('J-Quants bars/daily 失敗: 429 Rate limit') }
      return date === '2022-11-23' ? [] : [bar(date, '13010', 100), bar(date, '33940', 50)]
    },
    listings: async (date: string) => [listing(date, '13010'), listing(date, '33940')],
  })
  const sleeps: number[] = []
  const common = { from: '2022-11-21', to: '2022-11-30', pauseMs: 0, log: () => undefined, sleep: async (ms: number) => { sleeps.push(ms) } }
  await assert.rejects(runRefetch({ ...common, directory, resume: false, source: source('2022-11-30') }), /400 bad/)
  assert.ok(sleeps.includes(5_000), 'a 429 is retried after a pause')
  assert.ok(!fs.existsSync(path.join(directory, 'manifest.json')))
  assert.throws(() => assertOutput(directory, root, false), /OUTPUT_EXISTS/)

  // Resume must use the same range.
  await assert.rejects(runRefetch({ ...common, to: '2022-11-29', directory: assertOutput(directory, root, true), resume: true, source: source(null) }),
    /RESUME_RANGE_MISMATCH/)
  // Resume finishes only the missing dates.
  calls.length = 0
  const { manifest } = await runRefetch({ ...common, directory: assertOutput(directory, root, true), resume: true, source: source(null) })
  assert.deepEqual(calls, ['2022-11-30'])
  assert.equal(manifest.weekdays, 8)
  assert.equal(manifest.tradingDays, 7)
  assert.equal(manifest.barRows, 14)
  assert.equal(manifest.codes, 2)
  assert.equal(manifest.listingDates, 1)     // the month's last trading day only
  assert.deepEqual(manifest.emptyWeekdaysCalendarCallsTrading, [])   // 11-23 is a holiday in the calendar too
  const file = path.join(directory, 'jp-daily-bars.sqlite')
  assert.equal(fs.statSync(file).mode & 0o777, 0o444)
  assert.equal(count(file, "SELECT count(*) n FROM bars WHERE code = '33940' AND vo = 1000 AND adjc = 50 AND ul = '0'"), 7)
  assert.equal(count(file, "SELECT count(*) n FROM listings WHERE date = '2022-11-30' AND prodcat = '011'"), 2)
  assert.throws(() => assertOutput(directory, root, true), /FINISHED/)

  // A month that does not end inside the range gets no listing.
  const partial = await runRefetch({ ...common, to: '2022-11-29', directory: assertOutput(path.join(root, 'run2'), root, false), resume: false, source: source(null) })
  assert.equal(partial.manifest.listingDates, 0)

  // An empty trading day is recorded and listed for review; an empty month-end listing stops the run.
  const run3 = assertOutput(path.join(root, 'run3'), root, false)
  const empty = await runRefetch({ ...common, from: '2022-11-28', to: '2022-11-29', directory: run3, resume: false,
    source: { bars: async () => [], listings: async () => [] } })
  assert.deepEqual(empty.manifest.emptyWeekdaysCalendarCallsTrading, ['2022-11-28', '2022-11-29'])
  const run3b = assertOutput(path.join(root, 'run3b'), root, false)
  await assert.rejects(runRefetch({ ...common, from: '2022-11-30', to: '2022-11-30', directory: run3b, resume: false,
    source: { bars: async (date: string) => [bar(date, '13010', 1)], listings: async () => [] } }), /EMPTY_LISTING/)
  const run4 = assertOutput(path.join(root, 'run4'), root, false)
  await assert.rejects(runRefetch({ ...common, from: '2022-11-30', to: '2022-11-30', directory: run4, resume: false,
    source: { bars: async () => [bar('2022-11-30', '13010', 1), bar('2022-11-29', '13010', 1)], listings: async () => [] } }), /ROW_DATE_MISMATCH/)
  assert.equal(count(path.join(run4, 'jp-daily-bars.sqlite'), 'SELECT count(*) n FROM bars'), 0)

  // Resume refuses a directory with anything besides this tool's database.
  fs.symlinkSync(path.join(base, 'elsewhere-journal'), path.join(run4, 'jp-daily-bars.sqlite-journal'))
  assert.throws(() => assertOutput(run4, root, true), /UNEXPECTED_FILES/)   // a symlinked journal
  fs.unlinkSync(path.join(run4, 'jp-daily-bars.sqlite-journal'))
  assert.doesNotThrow(() => assertOutput(run4, root, true))
  fs.writeFileSync(path.join(run4, 'other.txt'), 'x')
  assert.throws(() => assertOutput(run4, root, true), /UNEXPECTED_FILES/)
  fs.rmSync(base, { recursive: true, force: true })
  console.log('jp-research-refetch tests passed')
}

main().catch((error) => { console.error(error); process.exitCode = 1 })
