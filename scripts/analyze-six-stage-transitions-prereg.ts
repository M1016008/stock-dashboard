// PREREG_TRANSITIONS_20261111 (research/6stage/event-path-research/) の集計。研究 1 (X→Y→X 型) と研究 2 (遷移ごとの勝率)。
// 条件は事前登録の文書が正。ここで条件を変えない。読み取りはすべて immutable、書き込みは出力フォルダだけ (write-once)。
//
//   SIX_STAGE_REAL_RESEARCH_ONLY=1 npx tsx --env-file=<jquants.env> scripts/analyze-six-stage-transitions-prereg.ts segments --out=<dir>
//   SIX_STAGE_REAL_RESEARCH_ONLY=1 npx tsx scripts/analyze-six-stage-transitions-prereg.ts analyze --out=<dir>
import fs from 'node:fs'
import path from 'node:path'
import {
  SIX_STAGE_REAL_RESEARCH_ROOT,
  assertResearchOnlyExecution,
  assertSixStageRealInput,
  sha256File,
} from '@/lib/research/six-stage-real-data-contract'
import { EVENT_PATH_DISCOVERY_CUTOFF, evaluateEventPricePath, type EventPriceBar } from '@/lib/research/six-stage-event-path-research'
import { compareTransitionCohorts, mulberry32, type TransitionComparisonRecord } from '@/lib/research/six-stage-statistics'
import { fetchJQuantsListedInfo, fromJQuantsCode } from '@/lib/jquants'
import { renderTransitionsReport } from './lib/six-stage-transitions-report'

type Statement = { all(...b: unknown[]): Record<string, unknown>[]; iterate(...b: unknown[]): IterableIterator<Record<string, unknown>> }
type Database = { exec(sql: string): void; prepare(sql: string): Statement; close(): void }
const { DatabaseSync } = require('node:sqlite') as { DatabaseSync: new (p: URL, o?: { readOnly?: boolean }) => Database }

const FOUNDATION = path.join(SIX_STAGE_REAL_RESEARCH_ROOT, 'v5', 'E039-JP-scale-consistent-phase1b0-foundation')
const EVENTS_PATH = path.join(FOUNDATION, 'events.sqlite')
const SOURCE_PATH = path.join(SIX_STAGE_REAL_RESEARCH_ROOT,
  'six-stage-discovery-source-export-20261025T211500JST-v2-r2.incomplete', 'jp-discovery-ohlcv.sqlite')
// STATUS「日本株の研究 Store (E039) を使うときの除外」: 補正漏れの 18 銘柄と 1773 は全イベントを除く。
export const SPLIT_EXCLUDED = new Set(('1663 1899 2163 2303 2436 3091 3176 3193 3673 4099 4452 4641 6863 7425 7460 7781 7846 8818 1773').split(' '))
export const HORIZONS = [5, 10, 15, 20] as const
export const MAIN_HORIZONS = [10, 20] as const
export const GAP_LIMIT = 10
const DEDUP_ROWS = 20
const MIN_EVENTS = 100
export const SEED = 20261111
export const BOOTSTRAP = 2_000
const PERMUTATIONS = 10_000
export const BLOCKS = [['2008-2012', '2008', '2012'], ['2013-2017', '2013', '2017'], ['2018-2022', '2018', '2022']] as const
const SEGMENT_FROM_MONTH = '2016-11'  // J-Quants の契約の範囲 (2016-11-11 以降) の最初の月末

export function openImmutable(file: string): Database {
  const url = new URL(`file://${file}`)
  url.searchParams.set('mode', 'ro')
  url.searchParams.set('immutable', '1')
  const db = new DatabaseSync(url, { readOnly: true })
  db.exec('PRAGMA query_only=ON; PRAGMA trusted_schema=OFF;')
  return db
}

// 出力は研究フォルダの下の専用フォルダか、一時フォルダ (scratch) だけ。封印 C の入力のフォルダには書かない。
export const RESULT_ROOT = path.join(SIX_STAGE_REAL_RESEARCH_ROOT, 'prereg-transitions-20261111')
// シンボリックリンクをたどった実際の場所で判断する (まだ無い部分は、存在する一番近い親から)。
function realLocation(target: string): string {
  let existing = target
  const rest: string[] = []
  while (!fs.existsSync(existing)) { rest.unshift(path.basename(existing)); existing = path.dirname(existing) }
  return path.join(fs.realpathSync(existing), ...rest)
}
export function assertOutputDirectory(value: string, resultRoot = RESULT_ROOT): string {
  if (!path.isAbsolute(value)) throw new Error('--out=<absolute directory> is required')
  const resolved = realLocation(path.resolve(value))
  // 許すのは、研究フォルダの専用フォルダと、一時フォルダ (scratch) の下だけ。
  const allowed = [resultRoot, '/private/tmp'].map(realLocation)  // 環境変数で変わる os.tmpdir() は使わない
  if (!allowed.some((root) => resolved.startsWith(`${root}${path.sep}`))) throw new Error(`output must be under ${resultRoot} or a temporary directory`)
  return resolved
}
const outputDirectory = () => assertOutputDirectory(process.argv.find((arg) => arg.startsWith('--out='))?.slice(6) ?? '')

// link は宛先があれば失敗するため、同時に動いても上書きしない。
export function writeOnce(file: string, body: string): void {
  const temporary = `${file}.tmp-${process.pid}`
  fs.writeFileSync(temporary, body, { flag: 'wx' })
  try { fs.linkSync(temporary, file) } finally { fs.unlinkSync(temporary) }
}

export function assertInputs(): { manifestSourceSha: string; eventsSha: string } {
  assertResearchOnlyExecution()
  const manifest = assertSixStageRealInput('JP')
  if (sha256File(SOURCE_PATH) !== manifest.source.priceSourceFileSha256) throw new Error('JP source sha256 mismatch')
  const foundation = JSON.parse(fs.readFileSync(path.join(FOUNDATION, 'manifest.json'), 'utf8'))
  if (sha256File(EVENTS_PATH) !== foundation.files['events.sqlite'].sha256) throw new Error('E039 events.sqlite sha256 mismatch')
  return { manifestSourceSha: manifest.source.priceSourceFileSha256, eventsSha: foundation.files['events.sqlite'].sha256 }
}

export function loadCalendar(source: Database): string[] {
  return source.prepare('SELECT DISTINCT date FROM ohlcv_daily WHERE date<=? ORDER BY date').all(EVENT_PATH_DISCOVERY_CUTOFF)
    .map((row) => String(row.date))
}

// 月末の上場銘柄一覧 (市場区分と 33 業種)。シグナルの月には前月末の値を使う (分析側)。
export async function fetchSegments(out: string): Promise<void> {
  assertInputs()
  const source = openImmutable(SOURCE_PATH)
  const calendar = loadCalendar(source)
  source.close()
  const monthEnds = new Map<string, string>()
  for (const date of calendar) if (date.slice(0, 7) >= SEGMENT_FROM_MONTH) monthEnds.set(date.slice(0, 7), date)
  monthEnds.delete(EVENT_PATH_DISCOVERY_CUTOFF.slice(0, 7))  // 2022-12 の値を使うシグナルは無い
  const months: Record<string, { date: string; segments: Record<string, string>; sectors33: Record<string, string> }> = {}
  const sector33Names: Record<string, string> = {}
  for (const [month, date] of monthEnds) {
    const rows = await fetchJQuantsListedInfo(undefined, date)
    const segments: Record<string, string> = {}
    const sectors33: Record<string, string> = {}
    for (const row of rows) {
      if (row.MktNm) segments[fromJQuantsCode(row.Code)] = row.MktNm
      if (row.S33) { sectors33[fromJQuantsCode(row.Code)] = row.S33; if (row.S33Nm) sector33Names[row.S33] = row.S33Nm }
    }
    months[month] = { date, segments, sectors33 }
    console.log(`${month} ${date} ${Object.keys(segments).length}`)
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  fs.mkdirSync(out, { recursive: true })
  writeOnce(path.join(out, 'segments.json'), `${JSON.stringify({ source: 'J-Quants /equities/master?date=<month end>', sector33Names, months })}\n`)
}

// --- 1 イベント分の結果を列で持つ (数百万件のため) ---
export const PATH_POINTS = 22  // 0 = シグナルの日、1 = 買った日 (0)、2..21 = 買った後の 1..20 行目
export class EventColumns {
  size = 0
  constructor(readonly capacity: number,
    readonly group = new Int32Array(capacity), readonly sub = new Int32Array(capacity), readonly ticker = new Int32Array(capacity),
    readonly date = new Int32Array(capacity), readonly dwell = new Int32Array(capacity),
    readonly segment = new Int16Array(capacity),
    readonly ret = new Float32Array(capacity * 4).fill(NaN), readonly mfe = new Float32Array(capacity * 4).fill(NaN),
    readonly mae = new Float32Array(capacity * 4).fill(NaN), readonly hiDay = new Uint8Array(capacity * 4),
    readonly loDay = new Uint8Array(capacity * 4), readonly path = new Float32Array(capacity * PATH_POINTS).fill(NaN)) {}
}

type FullSummary = {
  n: number; winLong: number; winShort: number; mean: number; median: number
  q10: number; q25: number; q75: number; q90: number
  mfeMedian: number; mfeQ90: number; mfeMax: number; maeMedian: number; hiDayMedian: number; loDayMedian: number
}
export type Summary = FullSummary | { n: 0 }
export const has = (s: Summary): s is FullSummary => s.n > 0

// 既存の研究コード (six-stage-statistics.ts の quantile) と同じ線形補間。1 回だけ並べ替える。
export function interpolated(sorted: ArrayLike<number>, p: number): number {
  const position = (sorted.length - 1) * p
  const lower = Math.floor(position)
  const upper = Math.ceil(position)
  return lower === upper ? sorted[lower] : sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower)
}

export function summarize(c: EventColumns, rows: readonly number[], h: number): Summary {
  const k = HORIZONS.indexOf(h as typeof HORIZONS[number])
  const valid = rows.filter((row) => !Number.isNaN(c.ret[row * 4 + k]))
  if (valid.length === 0) return { n: 0 }
  const sorted = (pick: (row: number) => number) => Float64Array.from(valid, pick).sort()
  const ret = sorted((row) => c.ret[row * 4 + k])
  const mfe = sorted((row) => c.mfe[row * 4 + k])
  let sum = 0; let up = 0; let down = 0
  for (const value of ret) { sum += value; if (value > 0) up += 1; if (value < 0) down += 1 }
  return {
    n: valid.length, winLong: up / valid.length, winShort: down / valid.length, mean: sum / valid.length,
    median: interpolated(ret, 0.5), q10: interpolated(ret, 0.1), q25: interpolated(ret, 0.25),
    q75: interpolated(ret, 0.75), q90: interpolated(ret, 0.9),
    mfeMedian: interpolated(mfe, 0.5), mfeQ90: interpolated(mfe, 0.9), mfeMax: mfe[mfe.length - 1],
    maeMedian: interpolated(sorted((row) => c.mae[row * 4 + k]), 0.5),
    hiDayMedian: interpolated(sorted((row) => c.hiDay[row * 4 + k]), 0.5),
    loDayMedian: interpolated(sorted((row) => c.loDay[row * 4 + k]), 0.5),
  }
}

// ③ の区間: −30% 未満、1 ポイント刻みの 60 個、+30% 以上 (計 62)。
export function histogram(c: EventColumns, rows: readonly number[], h: number, side: 'LONG' | 'SHORT' = 'LONG'): number[] {
  const k = HORIZONS.indexOf(h as typeof HORIZONS[number])
  const bins = new Array(62).fill(0)
  for (const row of rows) {
    const value = c.ret[row * 4 + k]
    if (Number.isNaN(value)) continue
    const percent = (side === 'SHORT' ? -value : value) * 100
    bins[percent < -30 ? 0 : percent >= 30 ? 61 : Math.floor(percent + 30) + 1] += 1
  }
  return bins
}

export const bothSides = (c: EventColumns, rows: readonly number[], h: number) =>
  ({ LONG: histogram(c, rows, h, 'LONG'), SHORT: histogram(c, rows, h, 'SHORT') })

// ④: シグナルの日から h 行目まで、日ごとの 10・25・50・75・90% 点。選んだ期間の結果があるイベントだけ。
export function pathBands(c: EventColumns, rows: readonly number[], h: number): number[][] {
  const k = HORIZONS.indexOf(h as typeof HORIZONS[number])
  const valid = rows.filter((row) => !Number.isNaN(c.ret[row * 4 + k]))
  if (valid.length === 0) return []
  return Array.from({ length: h + 2 }, (_, point) => {
    const values = Float64Array.from(valid, (row) => c.path[row * PATH_POINTS + point]).filter((v) => !Number.isNaN(v)).sort()
    return values.length ? [0.1, 0.25, 0.5, 0.75, 0.9].map((p) => interpolated(values, p)) : []
  })
}

function sameDirection(a: Summary, b: Summary, side: 'LONG' | 'SHORT'): boolean {
  if (!has(a) || !has(b)) return false
  return side === 'LONG'
    ? a.winLong > 0.5 && a.median > 0 && b.winLong > 0.5 && b.median > 0
    : a.winShort > 0.5 && a.median < 0 && b.winShort > 0.5 && b.median < 0
}

// 偶然で期待される候補の数: 確かめる期間の数字を 1 組のまま遷移の間で入れ替える (Fisher–Yates、mulberry32)。
export function permutationBaseline(explore: Summary[], confirm: Summary[], side: 'LONG' | 'SHORT', observed: number) {
  const random = mulberry32(SEED)
  const shuffled = [...confirm]
  let total = 0; let atLeast = 0
  for (let iteration = 0; iteration < PERMUTATIONS; iteration += 1) {
    for (let i = shuffled.length - 1; i > 0; i -= 1) {
      const j = Math.floor(random() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]]
    }
    let count = 0
    for (let i = 0; i < explore.length; i += 1) if (sameDirection(explore[i], shuffled[i], side)) count += 1
    total += count
    if (count >= observed) atLeast += 1
  }
  return { observed, expected: total / PERMUTATIONS, probabilityAtLeastObserved: atLeast / PERMUTATIONS, permutations: PERMUTATIONS }
}

// 1 イベントの道筋と結果を列に書く (研究 A・B も使う)。
export function storeOutcome(c: EventColumns, index: number, bars: readonly EventPriceBar[], signalRow: number,
  evaluation: ReturnType<typeof evaluateEventPricePath>): void {
  const entryPrice = evaluation.entryPrice!
  c.path[index * PATH_POINTS] = bars[signalRow].close / entryPrice - 1
  c.path[index * PATH_POINTS + 1] = 0
  for (const point of evaluation.dailyExcursions) c.path[index * PATH_POINTS + 1 + point.day] = point.closeReturn ?? NaN
  for (const horizon of evaluation.completedHorizons) {
    const k = index * 4 + HORIZONS.indexOf(horizon.horizonSessions)
    c.ret[k] = horizon.closeReturn; c.mfe[k] = horizon.mfe; c.mae[k] = horizon.mae
    c.hiDay[k] = horizon.highestDay; c.loDay[k] = horizon.lowestDay
  }
}

export type EventInput = { length: number; sequenceKey: string; signalDate: string; dwellB: number }
const toInput = (row: Record<string, unknown>): EventInput => ({
  length: Number(row.length), sequenceKey: String(row.sequence_key), signalDate: String(row.signal_date), dwellB: Number(row.dwell_b),
})

// シグナルの月には前月末の区分を使う。
export function previousMonth(date: string): string {
  const [year, month] = date.slice(0, 7).split('-').map(Number)
  return month === 1 ? `${year - 1}-12` : `${year}-${String(month - 1).padStart(2, '0')}`
}

// 1 銘柄のイベントに、除外 (空白) と重複の規則をこの順で適用し、終値で買った結果を付ける。
export function selectTickerEvents(bars: readonly EventPriceBar[], events: readonly EventInput[],
  calendarIndex: ReadonlyMap<string, number>, bump: (key: string) => void) {
  const rowOf = new Map(bars.map((bar, index) => [bar.date, index]))
  const gapAfter = (row: number) => calendarIndex.get(bars[row + 1].date)! - calendarIndex.get(bars[row].date)! - 1
  const lastKept = new Map<string, number>()
  const kept = []
  const sorted = [...events].sort((a, b) => a.signalDate.localeCompare(b.signalDate) || a.sequenceKey.localeCompare(b.sequenceKey))
  for (const event of sorted) {
    const study = event.length === 3 ? 1 as const : 2 as const
    const states = event.sequenceKey.split('>')
    const groupKey = study === 1 ? (states[0] === states[2] ? 'XYX' : 'XYZ') : event.sequenceKey
    const signalRow = rowOf.get(event.signalDate)
    if (signalRow == null) { bump(`s${study}.signalNotInSource`); continue }
    if (signalRow + 1 >= bars.length) { bump(`s${study}.missingEntry`); continue }
    if (gapAfter(signalRow) > GAP_LIMIT) { bump(`s${study}.excludedEntryGap`); continue }
    // 買った日から 20 行後までの、行と行の間の空白。
    let outcomeGap = false
    for (let row = signalRow + 1; row < Math.min(signalRow + 1 + DEDUP_ROWS, bars.length - 1); row += 1) if (gapAfter(row) > GAP_LIMIT) outcomeGap = true
    if (outcomeGap) { bump(`s${study}.excludedOutcomeGap`); continue }
    const evaluation = evaluateEventPricePath(bars, signalRow, 'NEXT_CLOSE')
    if (evaluation.entryPrice == null) { bump(`s${study}.invalidEntry`); continue }
    // 重複は同じ型 (研究 1) / 同じ遷移 (研究 2) の中でだけ数える。
    const previous = lastKept.get(`${study}:${groupKey}`)
    if (previous != null && signalRow - previous <= DEDUP_ROWS) { bump(`s${study}.dedupDropped`); continue }
    lastKept.set(`${study}:${groupKey}`, signalRow)
    kept.push({ study, groupKey, states, signalRow, evaluation, event })
  }
  return kept
}

function analyze(out: string): void {
  const inputs = assertInputs()
  // 当時の区分は先に segments で取得しておく (無ければ止める)。2016 年 11 月末より前は「不明」。
  const segmentFile = path.join(out, 'segments.json')
  if (!fs.existsSync(segmentFile)) throw new Error('run the segments step first')
  const segmentMonths: Record<string, { segments: Record<string, string> }> = JSON.parse(fs.readFileSync(segmentFile, 'utf8')).months
  const source = openImmutable(SOURCE_PATH)
  const eventsDb = openImmutable(EVENTS_PATH)
  const calendar = loadCalendar(source)
  const calendarIndex = new Map(calendar.map((date, index) => [date, index]))
  const capacity = (length: number) => Number(eventsDb.prepare(`SELECT COUNT(*) AS n FROM events WHERE event_type='ENTRY' AND length=?`).all(length)[0].n)
  const studies = { 1: new EventColumns(capacity(3)), 2: new EventColumns(capacity(2)) }
  const groupIds = { 1: new Map<string, number>(), 2: new Map<string, number>() }
  const segmentNames = ['不明']
  const tickers: string[] = []
  const counts: Record<string, number> = {}
  const bump = (key: string) => { counts[key] = (counts[key] ?? 0) + 1 }
  const prices = source.prepare('SELECT date,open,high,low,close FROM ohlcv_daily WHERE ticker=? AND date<=? ORDER BY date')
  const eventRows = eventsDb.prepare(`SELECT ticker,length,sequence_key,signal_date,dwell_b FROM events
    WHERE event_type='ENTRY' AND length IN (2,3) ORDER BY ticker`)

  const flush = (ticker: string, events: Record<string, unknown>[]) => {
    if (events.length === 0) return
    const tickerId = tickers.push(ticker) - 1
    if (SPLIT_EXCLUDED.has(ticker)) { counts.excludedSplitTickers = (counts.excludedSplitTickers ?? 0) + events.length; return }
    const bars = prices.all(ticker, EVENT_PATH_DISCOVERY_CUTOFF) as unknown as EventPriceBar[]
    for (const kept of selectTickerEvents(bars, events.map(toInput), calendarIndex, bump)) {
      const { study, groupKey, states, signalRow, evaluation, event } = kept
      for (const missing of evaluation.missingHorizons) bump(`s${study}.missing${missing}.${evaluation.termination}`)
      const c = studies[study]
      const index = c.size++
      const ids = groupIds[study]
      if (!ids.has(groupKey)) ids.set(groupKey, ids.size)
      c.group[index] = ids.get(groupKey)!
      c.ticker[index] = tickerId
      c.date[index] = calendarIndex.get(event.signalDate)!
      c.dwell[index] = study === 1 ? event.dwellB : 0
      if (study === 1) { const x = `X:${states[0]}`; if (!ids.has(x)) ids.set(x, ids.size); c.sub[index] = ids.get(x)! }
      const segment = segmentMonths[previousMonth(event.signalDate)]?.segments[ticker] ?? '不明'
      if (!segmentNames.includes(segment)) segmentNames.push(segment)
      c.segment[index] = segmentNames.indexOf(segment)
      storeOutcome(c, index, bars, signalRow, evaluation)
      bump(`s${study}.kept`)
    }
  }

  let currentTicker = ''
  let buffer: Record<string, unknown>[] = []
  for (const row of eventRows.iterate()) {
    if (String(row.ticker) !== currentTicker) { flush(currentTicker, buffer); currentTicker = String(row.ticker); buffer = [] }
    buffer.push(row)
  }
  flush(currentTicker, buffer)
  source.close(); eventsDb.close()

  const year = (c: EventColumns, row: number) => calendar[c.date[row]].slice(0, 4)
  const rowsBy = (c: EventColumns, filter: (row: number) => boolean) => {
    const rows: number[] = []
    for (let row = 0; row < c.size; row += 1) if (filter(row)) rows.push(row)
    return rows
  }
  const bySegment = (c: EventColumns, rows: number[], h: number) => Object.fromEntries(segmentNames.map((name, id) =>
    [name, summarize(c, rows.filter((row) => c.segment[row] === id), h)]))

  // --- 研究 1 ---
  const s1 = studies[1]
  const ids1 = groupIds[1]
  const xyx = rowsBy(s1, (row) => s1.group[row] === ids1.get('XYX'))
  const xyz = rowsBy(s1, (row) => s1.group[row] === ids1.get('XYZ'))
  const all1 = [...xyx, ...xyz]
  const study1 = {
    dwellY: { XYX: dwellSummary(s1, xyx), XYZ: dwellSummary(s1, xyz) },
    horizons: Object.fromEntries(HORIZONS.map((h) => [h, {
      full: { XYX: summarize(s1, xyx, h), XYZ: summarize(s1, xyz, h), ALL: summarize(s1, all1, h) },
      blocks: Object.fromEntries(BLOCKS.map(([name, from, to]) => {
        const inBlock = (row: number) => year(s1, row) >= from && year(s1, row) <= to
        const a = xyx.filter(inBlock); const b = xyz.filter(inBlock)
        const dates = [...a, ...b].map((row) => s1.date[row]).sort((l, r) => l - r)
        return [name, { XYX: summarize(s1, a, h), XYZ: summarize(s1, b, h),
          firstSignal: dates.length ? calendar[dates[0]] : null, lastSignal: dates.length ? calendar[dates.at(-1)!] : null }]
      })),
      bySegment: { XYX: bySegment(s1, xyx, h), XYZ: bySegment(s1, xyz, h) },
      ...(MAIN_HORIZONS.includes(h as 10 | 20) ? {
        histogram: { XYX: bothSides(s1, xyx, h), XYZ: bothSides(s1, xyz, h) },
        path: { XYX: pathBands(s1, xyx, h), XYZ: pathBands(s1, xyz, h) },
        judgment: judge(s1, xyx, xyz, h, calendar),
      } : {}),
      byX: Object.fromEntries([...ids1.keys()].filter((key) => key.startsWith('X:')).sort().map((key) => {
        const id = ids1.get(key)!
        return [key.slice(2), { XYX: summarize(s1, xyx.filter((row) => s1.sub[row] === id), h), XYZ: summarize(s1, xyz.filter((row) => s1.sub[row] === id), h) }]
      })),
    }])),
  }

  // --- 研究 2 ---
  const s2 = studies[2]
  const groups2 = new Map<number, number[]>()
  for (let row = 0; row < s2.size; row += 1) {
    const list = groups2.get(s2.group[row]) ?? []
    list.push(row)
    groups2.set(s2.group[row], list)
  }
  const keys2 = [...groupIds[2].entries()].sort(([a], [b]) => a.localeCompare(b))
  const split = (list: number[]) => ({ explore: list.filter((row) => year(s2, row) <= '2017'), confirm: list.filter((row) => year(s2, row) >= '2018') })
  const eligibleAt = new Map(HORIZONS.map((h) => [h, new Set(keys2.filter(([, id]) => summarize(s2, groups2.get(id)!, h).n >= MIN_EVENTS).map(([key]) => key))]))
  // 数字の表: いずれかの期間で対象になった遷移は、4 つの期間すべての数字を持つ (対象かどうかも記録)。
  const details2 = Object.fromEntries(keys2.filter(([key]) => HORIZONS.some((h) => eligibleAt.get(h)!.has(key))).map(([key, id]) => {
    const list = groups2.get(id)!
    const { explore, confirm } = split(list)
    return [key, Object.fromEntries(HORIZONS.map((h) => [h, { eligible: eligibleAt.get(h)!.has(key), all: summarize(s2, list, h),
      explore: summarize(s2, explore, h), confirm: summarize(s2, confirm, h), bySegment: bySegment(s2, list, h) }]))]
  }))
  const periodRange = (filter: (row: number) => boolean) => {
    let first = Infinity; let last = -Infinity
    for (let row = 0; row < s2.size; row += 1) if (filter(row)) { first = Math.min(first, s2.date[row]); last = Math.max(last, s2.date[row]) }
    return Number.isFinite(first) ? { firstSignal: calendar[first], lastSignal: calendar[last] } : null
  }
  const periods2 = { explore: periodRange((row) => year(s2, row) <= '2017'), confirm: periodRange((row) => year(s2, row) >= '2018') }
  const study2 = Object.fromEntries(HORIZONS.map((h) => {
    const eligible = keys2.filter(([key]) => eligibleAt.get(h)!.has(key))
    const rows = eligible.map(([key, id]) => {
      const list = groups2.get(id)!
      const detail = details2[key][h]
      return { key, all: detail.all, explore: detail.explore, confirm: detail.confirm,
        ...(MAIN_HORIZONS.includes(h as 10 | 20) ? { histogram: bothSides(s2, list, h), path: pathBands(s2, list, h) } : {}) }
    })
    const pooled = eligible.flatMap(([, id]) => groups2.get(id)!)
    const candidates = MAIN_HORIZONS.includes(h as 10 | 20) ? Object.fromEntries((['LONG', 'SHORT'] as const).map((side) => {
      const marked = rows.filter((row) => sameDirection(row.explore, row.confirm, side)).map((row) => row.key)
      return [side, { keys: marked, baseline: permutationBaseline(rows.map((r) => r.explore), rows.map((r) => r.confirm), side, marked.length) }]
    })) : null
    return [h, { eligibleTransitions: rows.length, rows, candidates,
      ...(MAIN_HORIZONS.includes(h as 10 | 20) ? { pooledHistogram: bothSides(s2, pooled, h), pooledPath: pathBands(s2, pooled, h) } : {}) }]
  }))

  const result = {
    namespace: 'PREREG_TRANSITIONS_20261111_RESULT_V1', generatedAt: new Date().toISOString(),
    prereg: 'research/6stage/event-path-research/PREREG_TRANSITIONS_20261111.md',
    inputs: { events: EVENTS_PATH, source: SOURCE_PATH, eventsSha256: inputs.eventsSha, sourceSha256: inputs.manifestSourceSha, segments: segmentFile },
    counts, segmentNames, study1, study2, details2, periods2,
  }
  fs.mkdirSync(out, { recursive: true })
  writeOnce(path.join(out, 'result.json'), `${JSON.stringify(result)}\n`)
  writeOnce(path.join(out, 'report.html'), renderTransitionsReport(result))
  console.log(JSON.stringify({ out, counts }, null, 2))
}

// 保存済みの result.json から報告ページだけを作り直す (集計はしない。数値は result.json のまま)。
//   npx tsx scripts/analyze-six-stage-transitions-prereg.ts render --out=<dir> --name=report-<suffix>.html
function renderOnly(out: string): void {
  const name = process.argv.find((arg) => arg.startsWith('--name='))?.slice(7) ?? ''
  if (!/^report-[A-Za-z0-9-]+\.html$/.test(name)) throw new Error('--name=report-<suffix>.html is required')
  const result = JSON.parse(fs.readFileSync(path.join(out, 'result.json'), 'utf8'))
  writeOnce(path.join(out, name), renderTransitionsReport(result))
  console.log(`rendered ${path.join(out, name)}`)
}

function dwellSummary(c: EventColumns, rows: number[]) {
  const values = Float64Array.from(rows, (row) => c.dwell[row]).sort()
  return values.length ? { n: values.length, median: interpolated(values, 0.5), q10: interpolated(values, 0.1), q90: interpolated(values, 0.9) } : { n: 0 }
}

// 研究 1 の判断: 中央値の差の保守的な 95% 区間 (銘柄 / 年月のまとまり) と、3 つの区分の向き。
function judge(c: EventColumns, xyx: number[], xyz: number[], h: number, calendar: string[]) {
  const k = HORIZONS.indexOf(h as typeof HORIZONS[number])
  const records: TransitionComparisonRecord[] = []
  // 既存コードの枠をそのまま使う: H001 = X→Y→X 型、C2 = X→Y→Z 型。
  const push = (rows: number[], cohort: 'H001' | 'C2') => {
    for (const row of rows) {
      const value = c.ret[row * 4 + k]
      if (!Number.isNaN(value)) records.push({ cohort, ticker: String(c.ticker[row]), signalDate: calendar[c.date[row]], netReturn: value })
    }
  }
  push(xyx, 'H001'); push(xyz, 'C2')
  const comparison = compareTransitionCohorts({ records, iterations: BOOTSTRAP, seed: SEED, timeAxis: 'signalMonth' })
  const sign = Math.sign(comparison.medianDifference)
  const blocks = BLOCKS.map(([name, from, to]) => {
    const inBlock = (row: number) => calendar[c.date[row]].slice(0, 4) >= from && calendar[c.date[row]].slice(0, 4) <= to
    const a = summarize(c, xyx.filter(inBlock), h); const b = summarize(c, xyz.filter(inBlock), h)
    const difference = has(a) && has(b) ? a.median - b.median : null
    return { name, difference, sameDirection: difference != null && difference !== 0 && Math.sign(difference) === sign }
  })
  const intervalExcludesZero = comparison.conservative95.lower > 0 || comparison.conservative95.upper < 0
  return {
    medianDifference: comparison.medianDifference, conservative95: comparison.conservative95,
    tickerCluster: comparison.tickerClusterBootstrap, monthCluster: comparison.signalDateClusterBootstrap,
    samples: comparison.samples, clusters: comparison.clusters, blocks, intervalExcludesZero,
    difference: intervalExcludesZero && sign !== 0 && blocks.every((block) => block.sameDirection) ? 'DIFFERENCE' : 'NO_DIFFERENCE',
  }
}

if (require.main === module) {
  const mode = process.argv[2]
  const out = outputDirectory()
  if (mode === 'segments') fetchSegments(out).catch((error) => { console.error(error); process.exit(1) })
  else if (mode === 'analyze') analyze(out)
  else if (mode === 'render') renderOnly(out)
  else throw new Error('mode must be segments, analyze or render')
}
