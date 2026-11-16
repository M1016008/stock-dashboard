import { createHash } from 'node:crypto'
import path from 'node:path'
import fs from 'node:fs'
// @ts-expect-error The pinned Node types predate Node 24's built-in SQLite module.
import { DatabaseSync } from 'node:sqlite'
import { assertRange, publishManifest, weekdays, withRetry } from '@/lib/research/jp-research-refetch'

// Auxiliary J-Quants data for the short-side ML and studies E/F (PLAN_SHORT_TRANSITION_ML_20261116.md, step 2).
// Every call names its dates, every row's date is checked before writing, and dates after DISCOVERY_END are refused.
// Each page body is kept as received (with its sha256); rows are also kept one by one (duplicates included) for reading.

const SCHEMA = 'jp-research-aux/1'
export const AUX_DB_NAME = 'jp-research-aux.sqlite'

type Dataset = { endpoint: string; dateField: string } & ({ by: 'date'; param: string } | { by: 'range' })
/** In run order: the exchange calendar first, so the others are checked against it. */
export const AUX_DATASETS: Record<string, Dataset> = {
  calendar: { endpoint: '/markets/calendar', by: 'range', dateField: 'Date' },
  topix: { endpoint: '/indices/bars/daily/topix', by: 'range', dateField: 'Date' },
  'margin-alert': { endpoint: '/markets/margin-alert', by: 'date', param: 'date', dateField: 'PubDate' },
  'short-sale-report': { endpoint: '/markets/short-sale-report', by: 'date', param: 'disc_date', dateField: 'DiscDate' },
  'fins-summary': { endpoint: '/fins/summary', by: 'date', param: 'date', dateField: 'DiscDate' },
  'earnings-date': { endpoint: '/fins/earnings-date', by: 'date', param: 'date', dateField: 'PubDate' },
}

export type AuxSource = (endpoint: string, params: Record<string, string>) => Promise<{ rows: Record<string, unknown>[]; bodies: string[] }>
const sha256 = (text: string) => createHash('sha256').update(text).digest('hex')

function open(file: string, meta: Record<string, string>, create: boolean): DatabaseSync {
  const db = new DatabaseSync(file)
  if (create) {
    db.exec(`PRAGMA journal_mode=DELETE;
      CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID;
      CREATE TABLE responses (dataset TEXT NOT NULL, request TEXT NOT NULL, rows INTEGER NOT NULL, pages INTEGER NOT NULL,
        fetched_at TEXT NOT NULL, PRIMARY KEY (dataset, request)) WITHOUT ROWID;
      CREATE TABLE pages (dataset TEXT NOT NULL, request TEXT NOT NULL, page INTEGER NOT NULL, sha256 TEXT NOT NULL, body TEXT NOT NULL,
        UNIQUE (dataset, request, page));
      CREATE TABLE rows (dataset TEXT NOT NULL, request TEXT NOT NULL, seq INTEGER NOT NULL, date TEXT NOT NULL, code TEXT,
        json TEXT NOT NULL, PRIMARY KEY (dataset, request, seq)) WITHOUT ROWID;`)
    const put = db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)')
    for (const [key, value] of Object.entries(meta)) put.run(key, value)
  }
  // Resume only the same run (schema, range and datasets), so no request is skipped or added.
  const stored = Object.fromEntries(db.prepare('SELECT key, value FROM meta').all().map((r: { key: string; value: string }) => [r.key, r.value]))
  if (Object.keys(meta).some((key) => stored[key] !== meta[key])) {
    db.close()
    throw new Error(`RESUME_RANGE_MISMATCH:${JSON.stringify(stored)}`)
  }
  return db
}

/** Check every row (an object whose date field is the requested day, or inside the range) and write the request in one transaction. */
function store(db: DatabaseSync, dataset: string, request: string, range: [string, string],
  answer: Awaited<ReturnType<AuxSource>>, now: () => Date): void {
  const field = AUX_DATASETS[dataset].dateField
  for (const row of answer.rows) {
    const date = row && typeof row === 'object' ? row[field] : undefined
    if (typeof date !== 'string' || date < range[0] || date > range[1]) throw new Error(`ROW_DATE_MISMATCH:${dataset}:${request}:${String(date)}`)
  }
  const insertRow = db.prepare('INSERT INTO rows (dataset, request, seq, date, code, json) VALUES (?, ?, ?, ?, ?, ?)')
  const insertPage = db.prepare('INSERT INTO pages (dataset, request, page, sha256, body) VALUES (?, ?, ?, ?, ?)')
  db.exec('BEGIN IMMEDIATE')
  try {
    answer.bodies.forEach((body, page) => insertPage.run(dataset, request, page, sha256(body), body))
    answer.rows.forEach((row, seq) => insertRow.run(dataset, request, seq, row[field], typeof row.Code === 'string' ? row.Code : null, JSON.stringify(row)))
    db.prepare('INSERT INTO responses (dataset, request, rows, pages, fetched_at) VALUES (?, ?, ?, ?, ?)')
      .run(dataset, request, answer.rows.length, answer.bodies.length, now().toISOString())
    db.exec('COMMIT')
  } catch (error) { db.exec('ROLLBACK'); throw error }
}

/** Range answers are checked before they are stored, so a bad one is fetched again on resume:
 * the calendar has every day of the range once with a known HolDiv; TOPIX has exactly the calendar's trading days (HolDiv 1 or 2). */
function checkRangeAnswer(dataset: string, rows: Record<string, unknown>[], from: string, to: string, tradingDays: string[]): void {
  const dates = rows.map((row) => String(row.Date)).sort()
  if (dataset === 'calendar') {
    const days: string[] = []
    for (let day = new Date(`${from}T00:00:00Z`); day <= new Date(`${to}T00:00:00Z`); day.setUTCDate(day.getUTCDate() + 1)) days.push(day.toISOString().slice(0, 10))
    if (dates.join() !== days.join() || rows.some((row) => !['0', '1', '2', '3'].includes(String(row.HolDiv)))) throw new Error('CALENDAR_INCOMPLETE')
  } else if (dates.join() !== tradingDays.join()) throw new Error(`${dataset.toUpperCase()}_DATES_MISMATCH`)
}

export async function runAuxFetch(args: {
  directory: string; resume: boolean; from: string; to: string; datasets: string[]; source: AuxSource; pauseMs: number
  log?: (line: string) => void; sleep?: (ms: number) => Promise<void>; now?: () => Date
}): Promise<{ manifestPath: string; manifest: Record<string, unknown> }> {
  assertRange(args.from, args.to)
  // The calendar is always fetched (first): the other datasets are checked against it.
  if (!args.datasets.includes('calendar') || new Set(args.datasets).size !== args.datasets.length || args.datasets.some((name) => !AUX_DATASETS[name])) {
    throw new Error(`DATASETS_INVALID:${args.datasets}`)
  }
  const datasets = Object.keys(AUX_DATASETS).filter((name) => args.datasets.includes(name))
  const sleep = args.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const now = args.now ?? (() => new Date())
  const log = args.log ?? ((line: string) => console.log(line))
  if (!args.resume) {
    fs.mkdirSync(path.dirname(args.directory), { recursive: true, mode: 0o700 })
    fs.mkdirSync(args.directory, { mode: 0o700 })
  }
  const file = path.join(args.directory, AUX_DB_NAME)
  const db = open(file, { schema: SCHEMA, from: args.from, to: args.to, datasets: datasets.join(',') }, !args.resume)
  const summary: Record<string, unknown> = {}
  try {
    const days = weekdays(args.from, args.to)
    const tradingDays = () => (db.prepare("SELECT json FROM rows WHERE dataset = 'calendar'").all() as { json: string }[])
      .map((row) => JSON.parse(row.json)).filter((row) => row.HolDiv === '1' || row.HolDiv === '2').map((row) => String(row.Date)).sort()
    for (const dataset of datasets) {
      const spec = AUX_DATASETS[dataset]
      const done = new Set(db.prepare('SELECT request FROM responses WHERE dataset = ?').all(dataset).map((r: { request: string }) => r.request))
      const requests = spec.by === 'date' ? days : [`${args.from}..${args.to}`]
      const todo = requests.filter((request) => !done.has(request))
      for (const [index, request] of todo.entries()) {
        const params = spec.by === 'date' ? { [spec.param]: request } : { from: args.from, to: args.to }
        const range: [string, string] = spec.by === 'date' ? [request, request] : [args.from, args.to]
        const answer = await withRetry(() => args.source(spec.endpoint, params), sleep)
        if (spec.by === 'range') checkRangeAnswer(dataset, answer.rows, args.from, args.to, dataset === 'calendar' ? [] : tradingDays())
        store(db, dataset, request, range, answer, now)
        if ((index + 1) % 100 === 0 || index + 1 === todo.length) log(`[aux] ${dataset} ${index + 1}/${todo.length} ${request}`)
        await sleep(args.pauseMs)
      }
      const fetched = db.prepare('SELECT request FROM responses WHERE dataset = ? ORDER BY request').all(dataset) as { request: string }[]
      if (fetched.map((r) => r.request).join() !== [...requests].sort().join()) throw new Error(`REQUESTS_INCOMPLETE:${dataset}`)
    }
    for (const dataset of datasets) {
      if (Number(db.prepare('SELECT count(*) n FROM rows WHERE dataset = ?').get(dataset)?.n) === 0) throw new Error(`EMPTY_DATASET:${dataset}`)
    }
    const trading = new Set(tradingDays())
    for (const dataset of datasets) {
      const fetched = db.prepare('SELECT request, rows FROM responses WHERE dataset = ? ORDER BY request').all(dataset) as { request: string; rows: number }[]
      summary[dataset] = {
        endpoint: AUX_DATASETS[dataset].endpoint, requests: fetched.length, rows: fetched.reduce((sum, r) => sum + r.rows, 0),
        firstRowDate: String(db.prepare('SELECT min(date) d FROM rows WHERE dataset = ?').get(dataset)?.d ?? ''),
        // For review: trading days (by the J-Quants calendar of this run) with no rows. Not an error by itself.
        emptyTradingDays: AUX_DATASETS[dataset].by === 'date' ? fetched.filter((r) => r.rows === 0 && trading.has(r.request)).map((r) => r.request) : null,
      }
    }
  } finally { db.close() }
  return publishManifest(file, { kind: SCHEMA, source: 'J-Quants v2 (Standard), each call by date or by from/to',
    plan: 'research/6stage/event-path-research/PLAN_SHORT_TRANSITION_ML_20261116.md', from: args.from, to: args.to,
    datasets: summary, finishedAt: now().toISOString() })
}
