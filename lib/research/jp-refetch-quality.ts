import fs from 'node:fs'
import path from 'node:path'
// @ts-expect-error The pinned Node types predate Node 24's built-in SQLite module.
import { DatabaseSync } from 'node:sqlite'
import { fromJQuantsCode } from '@/lib/jquants'
import { DISCOVERY_END, weekdays } from '@/lib/research/jp-research-refetch'
import { sha256File } from '@/lib/research/six-stage-real-data-contract'
import { isJpMarketTradingDate } from '@/lib/server/jp-market-calendar'

// Quality gate for the JP re-fetch with delisted stocks (QUALITY_GATE_JP_20261116.md; seal B condition 6, JP).
// Reads only (immutable) and only dates up to DISCOVERY_END. Every threshold is fixed in that document before the data is seen.

export const GATE = {
  // Full-day exchange halts that the holiday calendar does not have (2020-10-01: TSE system failure).
  haltDays: ['2020-10-01'],
  minDayRowsShare: 0.9, dayWindow: 20,
  maxListedWithoutBarShare: 0.02, maxBarWithoutListingShare: 0.005,   // per month-end
  adjTolerance: 0.05 + 1e-6,         // AdjC is rounded to 0.1 yen
  maxAdjInconsistentCodes: 10,
  splitJump: 0.5, maxSplitJumpShare: 0.01,
  returnTolerance: 0.005, maxReturnMismatchShare: 0.001,
  codeMismatchShare: 0.01, codeMinCompared: 20, maxMismatchCodes: 10,
  maxDiscoveryTickersMissing: 0.005,
  maxSanityShare: 0.0001,
} as const

export type Bar = { date: string; o: number | null; h: number | null; l: number | null; c: number | null; vo: number | null; f: number | null; adjc: number | null }

/** m[i] = product of AdjFactor(d) for rows after i: price(i) as seen on the last day = raw(i) × m[i]; volume ÷ m[i].
 * A traded row (close present) without a positive AdjFactor or AdjC is counted as missing (a stop). */
export function multipliers(rows: Bar[]): { m: number[]; missing: number } {
  const m = new Array<number>(rows.length)
  let running = 1
  let missing = 0
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    m[i] = running
    const factor = rows[i].f
    if (factor === null || !(factor > 0)) missing += 1
    else running *= factor
    if (rows[i].c !== null && !(rows[i].adjc! > 0)) missing += 1
  }
  return { m, missing }
}

/** Rebuilt closes must equal AdjC up to one constant k (splits after the last day) and 0.1-yen rounding.
 * Each row allows k in [(AdjC − 0.05) / rebuilt, (AdjC + 0.05) / rebuilt]; k is where the most rows agree, and the rest are counted. */
export function adjInconsistentRows(rows: Bar[], m: number[]): number {
  const pairs = rows.map((row, i) => [row.c !== null && row.c > 0 ? row.c * m[i] : NaN, row.adjc ?? NaN]).filter(([a, b]) => a > 0 && b > 0)
  const edges = pairs.flatMap(([a, b]) => [[(b - GATE.adjTolerance) / a, 1], [(b + GATE.adjTolerance) / a, -1]]).sort((x, y) => x[0] - y[0] || y[1] - x[1])
  let open = 0, best = 0
  for (const [, step] of edges) { open += step; best = Math.max(best, open) }
  return pairs.length - best
}

/** Ex-dates (AdjFactor ≠ 1) with a close on both sides, and those whose rebuilt move is larger than GATE.splitJump. */
export function splitJumps(rows: Bar[], m: number[]): { events: number; unchecked: number; jumps: number } {
  let events = 0, unchecked = 0, jumps = 0
  for (let i = 1; i < rows.length; i += 1) {
    if (rows[i].f === null || rows[i].f === 1) continue
    const before = rows[i - 1].c, after = rows[i].c
    if (!before || !after) { unchecked += 1; continue }
    events += 1
    if (Math.abs((after * m[i]) / (before * m[i - 1]) - 1) > GATE.splitJump) jumps += 1
  }
  return { events, unchecked, jumps }
}

/** Close-to-close moves on consecutive days that both sources have, compared with a 0.1-yen rounding allowance. */
export function returnMismatches(rows: Bar[], m: number[], discovery: Map<string, { prev: string | null; close: number }>): { compared: number; mismatched: number } {
  let compared = 0, mismatched = 0
  for (let i = 1; i < rows.length; i += 1) {
    const now = discovery.get(rows[i].date)
    const before = discovery.get(rows[i - 1].date)
    if (!now || !before || now.prev !== rows[i - 1].date || !rows[i].c || !rows[i - 1].c || !(now.close > 0) || !(before.close > 0)) continue
    compared += 1
    const ours = (rows[i].c! * m[i]) / (rows[i - 1].c! * m[i - 1])
    if (Math.abs(ours / (now.close / before.close) - 1) > GATE.returnTolerance + 0.05 / now.close + 0.05 / before.close) mismatched += 1
  }
  return { compared, mismatched }
}

/** OHLC must be all missing (no trade) or all positive and consistent; volume not negative. */
export function insane(b: Bar): boolean {
  const values = [b.o, b.h, b.l, b.c]
  if (b.vo !== null && b.vo < 0) return true
  if (values.every((v) => v === null)) return false
  return values.some((v) => v === null || v <= 0) || b.h! < b.l! || b.o! > b.h! || b.o! < b.l! || b.c! > b.h! || b.c! < b.l!
}

const median = (values: number[]) => {
  const s = [...values].sort((a, b) => a - b)
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2
}
const open = (file: string) => {
  const url = new URL(`file://${file}`)
  url.searchParams.set('mode', 'ro'); url.searchParams.set('immutable', '1')
  return new DatabaseSync(url, { readOnly: true })
}

export function runQuality(args: { refetchDirectory: string; range: { from: string; to: string }; discoveryPath: string; discoverySha256: string; excludedTickers: Set<string> }):
  { report: Record<string, unknown>; stops: string[] } {
  const manifest = JSON.parse(fs.readFileSync(path.join(args.refetchDirectory, 'manifest.json'), 'utf8'))
  // Only the whole planned range: a shorter run cannot pass the gate.
  if (manifest.kind !== 'jp-daily-bars-with-delisted/1' || !(args.range.to <= DISCOVERY_END) || manifest.from !== args.range.from || manifest.to !== args.range.to) {
    throw new Error('NOT_THE_DISCOVERY_RUN')
  }
  const file = path.join(args.refetchDirectory, 'jp-daily-bars.sqlite')
  if (sha256File(file) !== manifest.files['jp-daily-bars.sqlite'].sha256) throw new Error('REFETCH_SHA256_MISMATCH')
  if (sha256File(args.discoveryPath) !== args.discoverySha256) throw new Error('DISCOVERY_SHA256_MISMATCH')
  const db = open(file)
  const source = open(args.discoveryPath)
  const stops: string[] = []
  try {
    const meta = Object.fromEntries(db.prepare('SELECT key, value FROM meta').all().map((r: { key: string; value: string }) => [r.key, r.value]))
    if (meta.from !== manifest.from || meta.to !== manifest.to) throw new Error('META_MISMATCH')
    const { from, to } = manifest as { from: string; to: string }
    // Q2. Every weekday fetched; an empty weekday must be a holiday in the fixed calendar or a known halt.
    const fetched = db.prepare("SELECT date, rows FROM fetched WHERE kind = 'bars' AND date <= ? ORDER BY date").all(DISCOVERY_END) as { date: string; rows: number }[]
    const emptyTrading = fetched.filter((r) => r.rows === 0 && isJpMarketTradingDate(r.date) && !(GATE.haltDays as readonly string[]).includes(r.date)).map((r) => r.date)
    if (fetched.length !== manifest.weekdays) stops.push('WEEKDAYS_INCOMPLETE')
    if (emptyTrading.length) stops.push(`EMPTY_TRADING_DAYS:${emptyTrading.join(',')}`)
    // Q3. Rows per day against the median of the previous 20 trading days (the next 20 for the first 20 days; never the day itself).
    const days = fetched.filter((r) => r.rows > 0)
    const reference = (i: number) => (i >= GATE.dayWindow ? days.slice(i - GATE.dayWindow, i) : days.slice(i + 1, i + 1 + GATE.dayWindow))
    const thinDays = days.filter((r, i) => r.rows < GATE.minDayRowsShare * median(reference(i).map((d) => d.rows))).map((r) => r.date)
    if (thinDays.length) stops.push(`THIN_DAYS:${thinDays.join(',')}`)

    // Q4. Each month-end listing against the bars of the same day.
    const listingDates = db.prepare('SELECT DISTINCT date FROM listings WHERE date <= ? ORDER BY date').all(DISCOVERY_END).map((r: { date: string }) => r.date)
    // Expected: the last trading day of each month, except a last month that the range ends inside (as in the re-fetch).
    const lastDay = new Map(days.map((d) => [d.date.slice(0, 7), d.date]))
    const monthEnd = new Date(Date.UTC(Number(to.slice(0, 4)), Number(to.slice(5, 7)), 0)).toISOString().slice(0, 10)
    if (to < weekdays(`${to.slice(0, 7)}-01`, monthEnd).at(-1)!) lastDay.delete(to.slice(0, 7))
    if ([...lastDay.values()].join() !== listingDates.join()) stops.push('LISTING_DATES_MISMATCH')
    const monthEnds = listingDates.map((date: string) => {
      const listing = new Set(db.prepare('SELECT code FROM listings WHERE date = ?').all(date).map((r: { code: string }) => r.code))
      const bars = new Set(db.prepare('SELECT code FROM bars WHERE date = ?').all(date).map((r: { code: string }) => r.code))
      const listedWithoutBar = [...listing].filter((code) => !bars.has(code)).length
      const barWithoutListing = [...bars].filter((code) => !listing.has(code)).length
      return { date, listed: listing.size, listedWithoutBar, bars: bars.size, barWithoutListing }
    })
    const badMonths = monthEnds.filter((x: { listed: number; listedWithoutBar: number; bars: number; barWithoutListing: number }) => x.listedWithoutBar > GATE.maxListedWithoutBarShare * x.listed || x.barWithoutListing > GATE.maxBarWithoutListingShare * x.bars)
    if (badMonths.length) stops.push(`LISTING_MISMATCH:${badMonths.map((x: { date: string }) => x.date).join(',')}`)

    // Q5-Q8 per code, and Q7 coverage of the current Discovery source.
    const discoveryRows = source.prepare('SELECT date, close FROM ohlcv_daily WHERE ticker = ? AND date >= ? AND date <= ? ORDER BY date')
    let rows = 0, insaneRows = 0, missing = 0, splitEvents = 0, splitUnchecked = 0, splitJumpCount = 0, compared = 0, mismatched = 0
    const adjCodes: string[] = [], mismatchCodes: Record<string, { compared: number; mismatched: number }> = {}, endedByYear: Record<string, number> = {}
    const tickers = new Map<string, string>()
    let group: Bar[] = [], code: string | null = null
    const flush = () => {
      if (code === null) return
      const ticker = fromJQuantsCode(code)
      if (tickers.has(ticker)) stops.push(`CODE_COLLISION:${tickers.get(ticker)}:${code}`)
      tickers.set(ticker, code)
      const { m, missing: absent } = multipliers(group)
      missing += absent
      if (adjInconsistentRows(group, m) > 0) adjCodes.push(code)
      const split = splitJumps(group, m)
      splitEvents += split.events; splitUnchecked += split.unchecked; splitJumpCount += split.jumps
      if (!args.excludedTickers.has(ticker)) {
        let prev: string | null = null
        const map = new Map<string, { prev: string | null; close: number }>()
        for (const r of discoveryRows.all(ticker, from, to) as { date: string; close: number }[]) { map.set(r.date, { prev, close: r.close }); prev = r.date }
        const result = returnMismatches(group, m, map)
        compared += result.compared; mismatched += result.mismatched
        if (result.mismatched) mismatchCodes[ticker] = { compared: result.compared, mismatched: result.mismatched }
      }
      const last = group.at(-1)!.date
      if (last < '2022-12-01') endedByYear[last.slice(0, 4)] = (endedByYear[last.slice(0, 4)] ?? 0) + 1
    }
    const all = db.prepare('SELECT code, date, o, h, l, c, vo, adjfactor f, adjc FROM bars WHERE date <= ? ORDER BY code, date').iterate(DISCOVERY_END)
    for (const r of all as Iterable<Bar & { code: string }>) {
      if (r.code !== code) { flush(); group = []; code = r.code }
      group.push(r); rows += 1
      if (insane(r)) insaneRows += 1
    }
    flush()
    const discoveryTickers = source.prepare('SELECT DISTINCT ticker FROM ohlcv_daily WHERE date >= ? AND date <= ?').all(from, to)
      .map((r: { ticker: string }) => r.ticker).filter((t: string) => !args.excludedTickers.has(t))
    const discoveryMissing = discoveryTickers.filter((t: string) => !tickers.has(t))
    if (missing > 0) stops.push('ADJ_VALUES_MISSING')
    if (adjCodes.length > GATE.maxAdjInconsistentCodes) stops.push('ADJ_INCONSISTENT')
    if (splitJumpCount > GATE.maxSplitJumpShare * splitEvents) stops.push('SPLIT_JUMPS')
    if (compared === 0 || mismatched > GATE.maxReturnMismatchShare * compared) stops.push('DISCOVERY_RETURN_MISMATCH')
    const badCodes = Object.values(mismatchCodes).filter((x) => x.compared >= GATE.codeMinCompared && x.mismatched > GATE.codeMismatchShare * x.compared)
    if (badCodes.length > GATE.maxMismatchCodes) stops.push('DISCOVERY_MISMATCH_CODES')
    if (discoveryMissing.length > GATE.maxDiscoveryTickersMissing * discoveryTickers.length) stops.push('DISCOVERY_TICKERS_MISSING')
    if (insaneRows > GATE.maxSanityShare * rows) stops.push('RAW_SANITY')
    const report = {
      gate: GATE, from, to, refetchSha256: manifest.files['jp-daily-bars.sqlite'].sha256, discoverySha256: args.discoverySha256,
      weekdays: fetched.length, tradingDays: days.length, emptyTradingDays: emptyTrading, thinDays, monthEnds,
      rows, codes: tickers.size, insaneRows, adjValuesMissing: missing, adjInconsistentCodes: adjCodes,
      split: { events: splitEvents, unchecked: splitUnchecked, jumps: splitJumpCount },
      discovery: { tickers: discoveryTickers.length, missing: discoveryMissing, compared, mismatched, mismatchCodes, excludedTickers: [...args.excludedTickers].sort() },
      codesEndingBefore202212ByYear: endedByYear, stops,
    }
    return { report, stops }
  } finally { db.close(); source.close() }
}
