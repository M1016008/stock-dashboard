import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
// @ts-expect-error The pinned Node types predate Node 24's built-in SQLite module.
import { DatabaseSync } from 'node:sqlite'
import { fetchJQuantsPagesStrict } from '@/lib/jquants'
import { AUX_DB_NAME, runAuxFetch, type AuxSource } from '@/lib/research/jp-research-aux-fetch'
import { assertOutput } from '@/lib/research/jp-research-refetch'

const count = (file: string, sql: string) => {
  const db = new DatabaseSync(file, { readOnly: true })
  try { return Number(db.prepare(sql).get()?.n) } finally { db.close() }
}

async function testStrictFetch(): Promise<void> {
  // Pages are followed and returned as received; any non-2xx (403 and 404 included), a body without a `data` array,
  // a pagination_key that is not a non-empty string, and a repeated pagination_key all fail.
  process.env.JQUANTS_API_KEY = 'test-key'
  const realFetch = globalThis.fetch
  const urls: string[] = []
  const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })
  try {
    globalThis.fetch = (async (url: string) => {
      urls.push(String(url))
      return String(url).includes('pagination_key=k2') ? reply({ data: [{ PubDate: '2022-11-30', Code: '13010' }] })
        : reply({ data: [{ PubDate: '2022-11-30', Code: '72030' }], pagination_key: 'k2' })
    }) as typeof fetch
    const answer = await fetchJQuantsPagesStrict('/markets/margin-alert', { date: '2022-11-30' })
    assert.deepEqual(answer.rows.map((row) => row.Code), ['72030', '13010'])
    assert.equal(answer.bodies.length, 2)
    assert.equal(JSON.parse(answer.bodies[0]).pagination_key, 'k2')
    assert.ok(urls[0].endsWith('/markets/margin-alert?date=2022-11-30'))
    for (const [body, status, pattern] of [[{ message: 'x' }, 403, /403/], [{ message: 'x' }, 404, /404/], [{ message: 'x' }, 200, /RESPONSE_SHAPE/],
      [{ data: [], pagination_key: 5 }, 200, /RESPONSE_PAGINATION/], [{ data: [], pagination_key: null }, 200, /RESPONSE_PAGINATION/],
      [{ data: [], pagination_key: 'same' }, 200, /RESPONSE_PAGINATION/]] as const) {
      globalThis.fetch = (async () => reply(body, status)) as typeof fetch
      await assert.rejects(fetchJQuantsPagesStrict('/fins/summary', { date: '2022-11-30' }), pattern)
    }
  } finally { globalThis.fetch = realFetch }
}

const answer = (rows: Record<string, unknown>[]) => ({ rows, bodies: [JSON.stringify({ data: rows })] })
// 2022-11-21..25 (Mon..Fri); 11-23 is a holiday in the calendar answer.
const DAYS = ['2022-11-21', '2022-11-22', '2022-11-23', '2022-11-24', '2022-11-25']
const calendarRows = DAYS.map((date) => ({ Date: date, HolDiv: date === '2022-11-23' ? '0' : '1' }))
const topixRows = DAYS.filter((date) => date !== '2022-11-23').map((date) => ({ Date: date, C: 1 }))

async function main(): Promise<void> {
  await testStrictFetch()
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'aux-test-'))
  const root = path.join(base, 'root')
  const calls: string[] = []
  // 11-24 has no short-sale reports; 11-25 fails once with 429 for margin-alert.
  let failOnce = true
  const source = (failOn: string | null, overrides: { calendar?: Record<string, unknown>[]; topix?: Record<string, unknown>[] } = {}): AuxSource =>
    async (endpoint, params) => {
      calls.push(`${endpoint}?${new URLSearchParams(params)}`)
      if (endpoint === '/markets/calendar') return answer(overrides.calendar ?? calendarRows)
      if (endpoint.includes('topix')) return answer(overrides.topix ?? topixRows)
      const day = params.date ?? params.disc_date
      if (day === failOn) throw new Error(`J-Quants ${endpoint} 失敗: 400 bad`)
      if (day === '2022-11-25' && endpoint === '/markets/margin-alert' && failOnce) { failOnce = false; throw new Error('J-Quants 失敗: 429 limit') }
      if (day === '2022-11-23' || (day === '2022-11-24' && endpoint.includes('short-sale'))) return answer([])
      const field = endpoint.includes('summary') || endpoint.includes('short-sale') ? 'DiscDate' : 'PubDate'
      return answer([{ [field]: day, Code: '13010' }, { [field]: day, Code: '13010' }])
    }
  const sleeps: number[] = []
  const common = { from: '2022-11-21', to: '2022-11-25', pauseMs: 0, log: () => undefined, sleep: async (ms: number) => { sleeps.push(ms) } }
  const all = ['margin-alert', 'short-sale-report', 'fins-summary', 'earnings-date', 'topix', 'calendar']
  const directory = assertOutput(path.join(root, 'aux1'), root, false, AUX_DB_NAME)
  // A failure stops the run without a manifest; resume needs the same range and datasets and fetches only what is missing.
  await assert.rejects(runAuxFetch({ ...common, directory, resume: false, datasets: all, source: source('2022-11-22') }), /400 bad/)
  assert.ok(!fs.existsSync(path.join(directory, 'manifest.json')))
  assert.ok(calls[0].startsWith('/markets/calendar'), 'the calendar is fetched first')
  await assert.rejects(runAuxFetch({ ...common, directory: assertOutput(directory, root, true, AUX_DB_NAME), resume: true,
    datasets: ['calendar', 'topix'], source: source(null) }), /RESUME_RANGE_MISMATCH/)
  calls.length = 0
  const { manifest } = await runAuxFetch({ ...common, directory: assertOutput(directory, root, true, AUX_DB_NAME), resume: true, datasets: all, source: source(null) })
  assert.ok(!calls.some((call) => call.includes('margin-alert?date=2022-11-21') || call.includes('calendar')), 'finished requests are not fetched again')
  assert.ok(sleeps.includes(5_000), 'a 429 is retried after a pause')
  assert.ok(calls.includes('/markets/short-sale-report?disc_date=2022-11-22'))
  const datasets = manifest.datasets as Record<string, { requests: number; rows: number; emptyTradingDays: string[] | null }>
  assert.deepEqual([datasets['margin-alert'].requests, datasets['margin-alert'].rows], [5, 8])   // duplicates kept
  assert.deepEqual(datasets['short-sale-report'].emptyTradingDays, ['2022-11-24'])
  assert.deepEqual(datasets['fins-summary'].emptyTradingDays, [])   // 11-23 is a holiday in the J-Quants calendar
  assert.deepEqual([datasets.topix.requests, datasets.topix.rows], [1, 4])
  const file = path.join(directory, AUX_DB_NAME)
  assert.equal(fs.statSync(file).mode & 0o777, 0o444)
  assert.equal(count(file, "SELECT count(*) n FROM rows WHERE dataset = 'earnings-date' AND date = '2022-11-25' AND code = '13010'"), 2)
  assert.equal(count(file, "SELECT count(*) n FROM pages WHERE dataset = 'fins-summary' AND length(sha256) = 64"), 5)
  assert.throws(() => assertOutput(directory, root, true, AUX_DB_NAME), /FINISHED/)

  // Refusals before the manifest: rows outside the request, a calendar with a missing day, TOPIX off the calendar, an empty dataset.
  const refuse = async (name: string, datasets: string[], src: AuxSource, pattern: RegExp) => {
    const dir = assertOutput(path.join(root, name), root, false, AUX_DB_NAME)
    await assert.rejects(runAuxFetch({ ...common, directory: dir, resume: false, datasets, source: src }), pattern)
    assert.ok(!fs.existsSync(path.join(dir, 'manifest.json')))
    return path.join(dir, AUX_DB_NAME)
  }
  const late = await refuse('aux2', ['calendar', 'topix'], source(null, { topix: [...topixRows, { Date: '2023-01-04' }] }), /TOPIX_DATES_MISMATCH/)
  assert.equal(count(late, "SELECT count(*) n FROM rows WHERE dataset = 'topix'") + count(late, "SELECT count(*) n FROM pages WHERE dataset = 'topix'"), 0)
  await refuse('aux3', ['calendar', 'margin-alert'], async (endpoint) => answer(endpoint === '/markets/calendar' ? calendarRows : [{ Code: '13010' }]),
    /ROW_DATE_MISMATCH/)
  const badCalendar = await refuse('aux4', ['calendar'], source(null, { calendar: calendarRows.slice(1) }), /CALENDAR_INCOMPLETE/)
  assert.equal(count(badCalendar, 'SELECT count(*) n FROM responses'), 0)   // not recorded, so a resume fetches it again
  await refuse('aux4b', ['calendar'], source(null, { calendar: [...calendarRows, calendarRows[0]] }), /CALENDAR_INCOMPLETE/)
  await refuse('aux5', ['calendar', 'topix'], source(null, { topix: topixRows.slice(1) }), /TOPIX_DATES_MISMATCH/)
  await refuse('aux6', ['calendar', 'earnings-date'], async (endpoint) => answer(endpoint === '/markets/calendar' ? calendarRows : []), /EMPTY_DATASET:earnings-date/)
  for (const datasets of [['calendar', 'topix', 'topix'], ['topix'], ['margin-alert']]) {
    await assert.rejects(runAuxFetch({ ...common, directory: path.join(root, 'aux7'), resume: false, datasets, source: source(null) }), /DATASETS_INVALID/)
  }
  await assert.rejects(runAuxFetch({ ...common, to: '2023-01-04', directory: path.join(root, 'aux8'), resume: false, datasets: ['calendar'], source: source(null) }),
    /RANGE_AFTER_DISCOVERY_END/)
  assert.ok(!fs.existsSync(path.join(root, 'aux7')) && !fs.existsSync(path.join(root, 'aux8')))
  fs.rmSync(base, { recursive: true, force: true })
  console.log('jp-research-aux-fetch tests passed')
}

main().catch((error) => { console.error(error); process.exitCode = 1 })
