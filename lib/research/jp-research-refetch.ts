import fs from 'node:fs'
import path from 'node:path'
// @ts-expect-error The pinned Node types predate Node 24's built-in SQLite module.
import { DatabaseSync } from 'node:sqlite'
import type { JBarRow, JListedInfoRow } from '@/lib/jquants'
import { sha256File } from '@/lib/research/six-stage-real-data-contract'
import { isJpMarketTradingDate } from '@/lib/server/jp-market-calendar'

// Research copy of JP daily bars that includes stocks delisted later (PREREG_START_TIMING_20261116.md).
// Fetched by date, so every code that traded that day is returned. Resumable: each date is one transaction.
// Validation (2023-2024) and Holdout (2025-) are sealed, so dates after DISCOVERY_END are refused.

export const DISCOVERY_END = '2022-12-30'
const SCHEMA = 'jp-daily-bars-with-delisted/1'
const DB_NAME = 'jp-daily-bars.sqlite'
const BAR_REAL = ['O', 'H', 'L', 'C', 'Vo', 'Va', 'AdjFactor', 'AdjO', 'AdjH', 'AdjL', 'AdjC', 'AdjVo'] as const
const BAR_TEXT = ['UL', 'LL'] as const   // "0" / "1" in the API
const LISTING_TEXT = ['CoName', 'S17', 'S33', 'S33Nm', 'ScaleCat', 'Mkt', 'MktNm', 'ProdCat'] as const

export type RefetchSource = {
  bars: (date: string) => Promise<JBarRow[]>
  listings: (date: string) => Promise<JListedInfoRow[]>
}

const isoDay = (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value

export function weekdays(from: string, to: string): string[] {
  const out: string[] = []
  for (let day = new Date(`${from}T00:00:00Z`); day <= new Date(`${to}T00:00:00Z`); day.setUTCDate(day.getUTCDate() + 1)) {
    if (day.getUTCDay() !== 0 && day.getUTCDay() !== 6) out.push(day.toISOString().slice(0, 10))
  }
  return out
}

export function assertRange(from: string, to: string): void {
  if (!isoDay(from) || !isoDay(to) || from > to) throw new Error('RANGE_INVALID')
  if (to > DISCOVERY_END) throw new Error(`RANGE_AFTER_DISCOVERY_END:${DISCOVERY_END}`)
}

/** out must be a direct child of root (root's parent must already exist). Resume needs this tool's unfinished run. */
export function assertOutput(out: string, root: string, resume: boolean, dbName = DB_NAME): string {
  if (!path.isAbsolute(out) || !path.isAbsolute(root)) throw new Error('OUTPUT_MUST_BE_ABSOLUTE')
  const realRoot = path.join(fs.realpathSync(path.dirname(root)), path.basename(root))
  if (fs.existsSync(realRoot) && (fs.lstatSync(realRoot).isSymbolicLink() || !fs.lstatSync(realRoot).isDirectory())) throw new Error('ROOT_INVALID')
  if (path.resolve(path.dirname(out)) !== path.resolve(root) && path.dirname(out) !== realRoot) throw new Error(`OUTPUT_OUTSIDE_ROOT:${realRoot}`)
  const resolved = path.join(realRoot, path.basename(out))
  const exists = fs.existsSync(resolved)
  if (exists && !resume) throw new Error('OUTPUT_EXISTS')
  if (!exists && resume) throw new Error('RESUME_TARGET_MISSING')
  if (exists) {
    if (fs.lstatSync(resolved).isSymbolicLink() || fs.existsSync(path.join(resolved, 'manifest.json'))) throw new Error('OUTPUT_FINISHED_OR_INVALID')
    // Only this tool's database (and its rollback journal), each a regular file and not a symlink.
    const names = fs.readdirSync(resolved)
    const regular = (name: string) => { const stat = fs.lstatSync(path.join(resolved, name)); return stat.isFile() && !stat.isSymbolicLink() }
    if (!names.includes(dbName) || names.some((name) => ![dbName, `${dbName}-journal`].includes(name) || !regular(name))) {
      throw new Error('RESUME_TARGET_UNEXPECTED_FILES')
    }
  }
  return resolved
}

function open(file: string, range: { from: string; to: string }, create: boolean): DatabaseSync {
  const db = new DatabaseSync(file)
  if (create) {
    db.exec(`PRAGMA journal_mode=DELETE;
      CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID;
      CREATE TABLE bars (date TEXT NOT NULL, code TEXT NOT NULL, ${BAR_REAL.map((c) => `${c.toLowerCase()} REAL`).join(', ')},
        ${BAR_TEXT.map((c) => `${c.toLowerCase()} TEXT`).join(', ')}, PRIMARY KEY (date, code)) WITHOUT ROWID;
      CREATE TABLE listings (date TEXT NOT NULL, code TEXT NOT NULL, ${LISTING_TEXT.map((c) => `${c.toLowerCase()} TEXT`).join(', ')},
        PRIMARY KEY (date, code)) WITHOUT ROWID;
      CREATE TABLE fetched (kind TEXT NOT NULL, date TEXT NOT NULL, rows INTEGER NOT NULL, fetched_at TEXT NOT NULL,
        PRIMARY KEY (kind, date)) WITHOUT ROWID;`)
    const put = db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)')
    for (const [key, value] of Object.entries({ schema: SCHEMA, from: range.from, to: range.to })) put.run(key, value)
  }
  // Resume only the same run: same schema and the same range, so no date is skipped or added.
  const meta = Object.fromEntries(db.prepare('SELECT key, value FROM meta').all().map((r: { key: string; value: string }) => [r.key, r.value]))
  if (meta.schema !== SCHEMA || meta.from !== range.from || meta.to !== range.to) {
    db.close()
    throw new Error(`RESUME_RANGE_MISMATCH:${meta.schema}:${meta.from}:${meta.to}`)
  }
  return db
}

const transient = (error: unknown) => /\b(429|5\d\d)\b|fetch failed|ECONNRESET|ETIMEDOUT|EAI_AGAIN/.test(String(error))

export async function withRetry<T>(work: () => Promise<T>, sleep: (ms: number) => Promise<void>): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try { return await work() } catch (error) {
      if (attempt >= 5 || !transient(error)) throw error
      await sleep(5_000 * 2 ** attempt)
    }
  }
}

function store(db: DatabaseSync, kind: 'bars' | 'listings', date: string, rows: (JBarRow | JListedInfoRow)[], now: () => Date): void {
  if (!Array.isArray(rows)) throw new Error(`RESPONSE_NOT_ARRAY:${kind}:${date}`)
  // A month-end listing must have rows. An empty bars day is recorded; the manifest lists the ones the calendar calls trading days
  // (the calendar misses some holidays, e.g. 2019-04-30, so this is for review, not a stop).
  if (rows.length === 0 && kind === 'listings') throw new Error(`EMPTY_LISTING:${date}`)
  const columns = kind === 'bars' ? [...BAR_REAL, ...BAR_TEXT] : LISTING_TEXT
  const insert = db.prepare(`INSERT INTO ${kind} (date, code, ${columns.map((c) => c.toLowerCase()).join(', ')})
    VALUES (?, ?, ${columns.map(() => '?').join(', ')})`)
  db.exec('BEGIN IMMEDIATE')
  try {
    for (const row of rows) {
      const record = row as unknown as Record<string, string | number | null | undefined>
      if (record.Date !== date) throw new Error(`ROW_DATE_MISMATCH:${kind}:${date}:${record.Date}`)
      insert.run(date, String(record.Code), ...columns.map((c) => record[c] ?? null))
    }
    db.prepare('INSERT INTO fetched (kind, date, rows, fetched_at) VALUES (?, ?, ?, ?)').run(kind, date, rows.length, now().toISOString())
    db.exec('COMMIT')
  } catch (error) { db.exec('ROLLBACK'); throw error }
}

export async function runRefetch(args: {
  directory: string; resume: boolean; from: string; to: string; source: RefetchSource; pauseMs: number
  log?: (line: string) => void; sleep?: (ms: number) => Promise<void>; now?: () => Date
}): Promise<{ manifestPath: string; manifest: Record<string, unknown> }> {
  assertRange(args.from, args.to)
  const sleep = args.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const now = args.now ?? (() => new Date())
  const log = args.log ?? ((line: string) => console.log(line))
  if (!args.resume) {
    fs.mkdirSync(path.dirname(args.directory), { recursive: true, mode: 0o700 })
    fs.mkdirSync(args.directory, { mode: 0o700 })   // fails if it appeared meanwhile
  }
  const file = path.join(args.directory, DB_NAME)
  const db = open(file, args, !args.resume)
  let summary: Record<string, unknown>
  try {
    const done = (kind: string) => new Set(db.prepare('SELECT date FROM fetched WHERE kind = ?').all(kind).map((r: { date: string }) => r.date))
    const days = weekdays(args.from, args.to)
    const barsDone = done('bars')
    const todo = days.filter((day) => !barsDone.has(day))
    for (const [index, day] of todo.entries()) {
      store(db, 'bars', day, await withRetry(() => args.source.bars(day), sleep), now)
      if ((index + 1) % 25 === 0 || index + 1 === todo.length) log(`[refetch] bars ${index + 1}/${todo.length} ${day}`)
      await sleep(args.pauseMs)
    }
    const fetchedBars = [...done('bars')].sort()
    if (fetchedBars.join() !== days.join()) throw new Error('BARS_DATES_INCOMPLETE')
    // The listing on the last trading day of each month that ends inside the range.
    const monthEnds = new Map<string, string>()
    for (const row of db.prepare('SELECT date FROM fetched WHERE kind = \'bars\' AND rows > 0 ORDER BY date').all()) {
      monthEnds.set(String(row.date).slice(0, 7), String(row.date))
    }
    const lastMonth = args.to.slice(0, 7)
    const monthEnd = new Date(Date.UTC(Number(lastMonth.slice(0, 4)), Number(lastMonth.slice(5)), 0)).toISOString().slice(0, 10)
    if (args.to < weekdays(`${lastMonth}-01`, monthEnd).at(-1)!) monthEnds.delete(lastMonth)
    const listingsDone = done('listings')
    for (const day of [...monthEnds.values()].filter((d) => !listingsDone.has(d))) {
      store(db, 'listings', day, await withRetry(() => args.source.listings(day), sleep), now)
      await sleep(args.pauseMs)
    }
    const count = (sql: string) => Number(db.prepare(sql).get()?.n ?? 0)
    summary = {
      from: args.from, to: args.to, weekdays: days.length,
      tradingDays: count('SELECT count(*) n FROM fetched WHERE kind = \'bars\' AND rows > 0'),
      barRows: count('SELECT count(*) n FROM bars'), codes: count('SELECT count(DISTINCT code) n FROM bars'),
      listingDates: monthEnds.size, listingRows: count('SELECT count(*) n FROM listings'),
      emptyWeekdaysCalendarCallsTrading: db.prepare('SELECT date FROM fetched WHERE kind = \'bars\' AND rows = 0 ORDER BY date').all()
        .map((r: { date: string }) => r.date).filter((date: string) => isJpMarketTradingDate(date)),
      firstFetchedAt: String(db.prepare('SELECT min(fetched_at) t FROM fetched').get()?.t),
      lastFetchedAt: String(db.prepare('SELECT max(fetched_at) t FROM fetched').get()?.t),
    }
  } finally { db.close() }
  return publishManifest(file, { kind: SCHEMA, source: 'J-Quants v2 /equities/bars/daily?date= and /equities/master?date=',
    prereg: 'research/6stage/event-path-research/PREREG_START_TIMING_20261116.md', ...summary, finishedAt: now().toISOString() })
}

/** Publish the manifest whole (temp file, then a link that fails if one exists), then make the DB read-only. */
export function publishManifest(file: string, content: Record<string, unknown>): { manifestPath: string; manifest: Record<string, unknown> } {
  const manifest = { ...content, files: { [path.basename(file)]: { sha256: sha256File(file), bytes: fs.statSync(file).size } } }
  const manifestPath = path.join(path.dirname(file), 'manifest.json')
  const temporary = `${manifestPath}.tmp-${process.pid}`
  const descriptor = fs.openSync(temporary, 'wx', 0o444)
  try { fs.writeSync(descriptor, `${JSON.stringify(manifest, null, 2)}\n`); fs.fsyncSync(descriptor) } finally { fs.closeSync(descriptor) }
  try { fs.linkSync(temporary, manifestPath) } finally { fs.unlinkSync(temporary) }
  fs.chmodSync(file, 0o444)
  return { manifestPath, manifest }
}
