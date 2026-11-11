// PREREG_DWELL_SECTOR_20261111 (research/6stage/event-path-research/) の集計。研究 A (滞在日数) と研究 B (業種の強さ)。
// 条件は事前登録の文書が正。ここで条件を変えない。読み取りはすべて immutable、書き込みは出力フォルダだけ (write-once)。
// 研究 1・2 の集計 (analyze-six-stage-transitions-prereg.ts) の部品をそのまま使う。
//
//   SIX_STAGE_REAL_RESEARCH_ONLY=1 npx tsx --env-file=<jquants.env> scripts/analyze-six-stage-dwell-sector-prereg.ts sectors --out=<dir>
//   SIX_STAGE_REAL_RESEARCH_ONLY=1 npx tsx scripts/analyze-six-stage-dwell-sector-prereg.ts sector60 --db=<Backup の写しの stockboard.db> --out=<dir>
//   SIX_STAGE_REAL_RESEARCH_ONLY=1 npx tsx scripts/analyze-six-stage-dwell-sector-prereg.ts analyze --out=<dir>
//   npx tsx scripts/analyze-six-stage-dwell-sector-prereg.ts render --out=<dir> --name=report-<suffix>.html
import fs from 'node:fs'
import path from 'node:path'
import { SIX_STAGE_REAL_RESEARCH_ROOT, sha256File } from '@/lib/research/six-stage-real-data-contract'
import { EVENT_PATH_DISCOVERY_CUTOFF, evaluateEventPricePath, type EventPriceBar } from '@/lib/research/six-stage-event-path-research'
import { bootstrapCohortDifferences, type TransitionComparisonRecord } from '@/lib/research/six-stage-statistics'
import {
  STRONG_LEVEL, dwellClass, envelope, evidenceLevel, sectorStrength, transitionGroup, type TransitionGroup,
} from '@/lib/research/six-stage-dwell-sector'
import {
  BLOCKS, BOOTSTRAP, EventColumns, GAP_LIMIT, HORIZONS, MAIN_HORIZONS, MIN_EVENTS, SEED, SPLIT_EXCLUDED,
  assertInputs, assertOutputDirectory, bothSides, fetchSegments, has, interpolated, loadCalendar, openImmutable,
  pathBands, previousMonth, selectTickerEvents, storeOutcome, summarize, writeOnce, type EventInput, type Summary,
} from './analyze-six-stage-transitions-prereg'
import { renderDwellSectorReport } from './lib/six-stage-dwell-sector-report'

const FOUNDATION = path.join(SIX_STAGE_REAL_RESEARCH_ROOT, 'v5', 'E039-JP-scale-consistent-phase1b0-foundation')
const EVENTS_PATH = path.join(FOUNDATION, 'events.sqlite')
const SOURCE_PATH = path.join(SIX_STAGE_REAL_RESEARCH_ROOT,
  'six-stage-discovery-source-export-20261025T211500JST-v2-r2.incomplete', 'jp-discovery-ohlcv.sqlite')
export const RESULT_ROOT_AB = path.join(SIX_STAGE_REAL_RESEARCH_ROOT, 'prereg-dwell-sector-20261111')
const PRODUCTION_DB_DIRECTORY = '/Volumes/OWC Express 1M2 80G/stock-dashboard'
const RETURN_ROWS = 20
const B33_FROM = '2016-12-01'
type Block = readonly [name: string, fromMonth: string, toMonth: string]
const YEAR_BLOCKS: readonly Block[] = BLOCKS.map(([name, from, to]) => [name, `${from}-01`, `${to}-12`] as const)
const B33_BLOCKS: readonly Block[] = [
  ['2016-12〜2018-12', '2016-12', '2018-12'], ['2019-01〜2020-12', '2019-01', '2020-12'], ['2021-01〜2022-12', '2021-01', '2022-12'],
]
const GROUPS: readonly TransitionGroup[] = ['IMPROVE', 'DETERIORATE', 'MIXED']
type StudyKey = 'A' | 'B33' | 'B60'
const STUDY_BLOCKS: Record<StudyKey, readonly Block[]> = { A: YEAR_BLOCKS, B33: B33_BLOCKS, B60: YEAR_BLOCKS }
const outputDirectory = () => assertOutputDirectory(process.argv.find((arg) => arg.startsWith('--out='))?.slice(6) ?? '', RESULT_ROOT_AB)
const realPath = (file: string) => fs.realpathSync(file)

// 今の 60 分類を、11/15 の Backup の写し (読み取り専用) から書き出す。本番の DB は読まない。
function exportSector60(out: string): void {
  const db = process.argv.find((arg) => arg.startsWith('--db='))?.slice(5) ?? ''
  if (!path.isAbsolute(db) || !fs.existsSync(db)) throw new Error('--db=<absolute path of the backup copy> is required')
  if (realPath(db).startsWith(`${realPath(PRODUCTION_DB_DIRECTORY)}${path.sep}`)) throw new Error('refusing to read the production DB directory')
  const database = openImmutable(realPath(db))
  const rows = database.prepare(`SELECT ticker, major_category FROM stock_classification WHERE major_category IS NOT NULL AND major_category <> ''`).all()
  database.close()
  const sectors = Object.fromEntries(rows.map((row) => [String(row.ticker), String(row.major_category)]))
  fs.mkdirSync(out, { recursive: true })
  writeOnce(path.join(out, 'sector60.json'), `${JSON.stringify({ source: 'stock_classification.major_category', db: realPath(db), dbSha256: sha256File(realPath(db)), sectors })}\n`)
  console.log(`sector60: ${rows.length} tickers, ${new Set(Object.values(sectors)).size} categories`)
}

// 1 日分の業種ごとの 20 日騰落 (小さい順)。order は業種の並び順 (同じ値のときの順)。
type DaySectors = { key: string; sorted: Float32Array }[]
function buildDaySectors(r20: Float32Array, dates: number, day: number, sectorOf: (ticker: number) => string | undefined,
  tickerCount: number, order: (a: string, b: string) => number): DaySectors {
  const values = new Map<string, number[]>()
  for (let ticker = 0; ticker < tickerCount; ticker += 1) {
    const value = r20[ticker * dates + day]
    const key = Number.isNaN(value) ? undefined : sectorOf(ticker)
    if (key == null) continue
    const list = values.get(key) ?? []
    list.push(value)
    values.set(key, list)
  }
  return [...values.keys()].sort(order).map((key) => ({ key, sorted: Float32Array.from(values.get(key)!).sort() }))
}

// 20 日騰落: シグナル日の終値 ÷ 20 行前の終値 − 1。20 行に満たない、終値が無い・0 以下、10 営業日を超える空白、補正漏れは入れない。
export function twentyDayReturns(bars: readonly EventPriceBar[], calendarIndex: ReadonlyMap<string, number>,
  write: (day: number, value: number) => void): void {
  for (let row = RETURN_ROWS; row < bars.length; row += 1) {
    const now = bars[row].close; const before = bars[row - RETURN_ROWS].close
    if (!(now > 0) || !(before > 0)) continue
    let gap = false
    for (let i = row - RETURN_ROWS; i < row && !gap; i += 1) {
      if (calendarIndex.get(bars[i + 1].date)! - calendarIndex.get(bars[i].date)! - 1 > GAP_LIMIT) gap = true
    }
    if (!gap) write(calendarIndex.get(bars[row].date)!, now / before - 1)
  }
}

type Comparison = {
  measure: 'median' | 'winRate'; difference: number
  interval95: { lower: number; upper: number }; intervalStrong: { lower: number; upper: number }
  tickerReplicates: number; monthReplicates: number
  blocks: { name: string; difference: number | null; sameDirection: boolean }[]
  level: 'STRONG' | 'WEAK' | 'NONE'
}

// a − b (LONG)。区間は銘柄・年月のまとまりのブートストラップ (研究 1 と同じ種) の、両方を含む広い方。
function compare(c: EventColumns, a: number[], b: number[], h: number, calendar: string[], blocks: readonly Block[]): Comparison[] {
  const k = HORIZONS.indexOf(h as typeof HORIZONS[number])
  const records: TransitionComparisonRecord[] = []
  const push = (rows: number[], cohort: 'H001' | 'C2') => {
    for (const row of rows) {
      const value = c.ret[row * 4 + k]
      if (!Number.isNaN(value)) records.push({ cohort, ticker: String(c.ticker[row]), signalDate: calendar[c.date[row]], netReturn: value })
    }
  }
  push(a, 'H001'); push(b, 'C2')
  const byTicker = bootstrapCohortDifferences(records, 'ticker', BOOTSTRAP, SEED ^ 0x5449434b)
  const byMonth = bootstrapCohortDifferences(records, 'signalMonth', BOOTSTRAP, SEED ^ 0x44415445)
  const point = (left: Summary, right: Summary, measure: Comparison['measure']) => has(left) && has(right)
    ? measure === 'median' ? left.median - right.median : left.winLong - right.winLong : null
  const full = { a: summarize(c, a, h), b: summarize(c, b, h) }
  return (['median', 'winRate'] as const).map((measure) => {
    const difference = point(full.a, full.b, measure)!
    const axes = [byTicker[measure], byMonth[measure]]
    const interval95 = envelope(axes, 0.95)
    const intervalStrong = envelope(axes, STRONG_LEVEL)
    const blockRows = blocks.map(([name, from, to]) => {
      const inBlock = (row: number) => { const month = calendar[c.date[row]].slice(0, 7); return month >= from && month <= to }
      const value = point(summarize(c, a.filter(inBlock), h), summarize(c, b.filter(inBlock), h), measure)
      return { name, difference: value, sameDirection: value != null && value !== 0 && Math.sign(value) === Math.sign(difference) }
    })
    const blocksSameDirection = difference !== 0 && blockRows.every((block) => block.sameDirection)
    return { measure, difference, interval95, intervalStrong, tickerReplicates: byTicker.median.length,
      monthReplicates: byMonth.median.length, blocks: blockRows, level: evidenceLevel({ interval95, intervalStrong, blocksSameDirection }) }
  })
}

// 遷移ごとの数字 (件数、勝率 LONG/SHORT、平均、中央値、10/25/75/90%、最大の上昇幅・下落幅の中央値)。0 件は 0。
const round = (value: number) => Math.round(value * 1e5) / 1e5
function compact(s: Summary): number[] | 0 {
  return has(s) ? [s.n, ...[s.winLong, s.winShort, s.mean, s.median, s.q10, s.q25, s.q75, s.q90, s.mfeMedian, s.maeMedian].map(round)] : 0
}

function analyze(out: string): void {
  const inputs = assertInputs()
  const segmentFile = path.join(out, 'segments.json')
  const sector60File = path.join(out, 'sector60.json')
  for (const file of [segmentFile, sector60File]) if (!fs.existsSync(file)) throw new Error(`run the ${path.basename(file, '.json').replace('segments', 'sectors')} step first`)
  const listing: { sector33Names: Record<string, string>; months: Record<string, { sectors33: Record<string, string> }> } = JSON.parse(fs.readFileSync(segmentFile, 'utf8'))
  const sector60: Record<string, string> = JSON.parse(fs.readFileSync(sector60File, 'utf8')).sectors
  const source = openImmutable(SOURCE_PATH)
  const eventsDb = openImmutable(EVENTS_PATH)
  const calendar = loadCalendar(source)
  const calendarIndex = new Map(calendar.map((date, index) => [date, index]))
  const counts: Record<string, number> = {}
  const bump = (key: string) => { counts[key] = (counts[key] ?? 0) + 1 }
  const prices = source.prepare('SELECT date,open,high,low,close FROM ohlcv_daily WHERE ticker=? AND date<=? ORDER BY date')

  // 1 回目: 全銘柄の 20 日騰落 (業種の中央値に使う)。
  const tickers = source.prepare('SELECT DISTINCT ticker FROM ohlcv_daily ORDER BY ticker').all().map((row) => String(row.ticker))
  const tickerId = new Map(tickers.map((ticker, index) => [ticker, index]))
  const D = calendar.length
  const r20 = new Float32Array(tickers.length * D).fill(NaN)
  tickers.forEach((ticker, id) => {
    if (SPLIT_EXCLUDED.has(ticker)) return
    twentyDayReturns(prices.all(ticker, EVENT_PATH_DISCOVERY_CUTOFF) as unknown as EventPriceBar[], calendarIndex, (day, value) => { r20[id * D + day] = value })
  })
  const byCode = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)
  const days33 = new Map<number, DaySectors>()
  const days60 = new Map<number, DaySectors>()
  const sectors33At = (day: number) => listing.months[previousMonth(calendar[day])]?.sectors33
  const daySectors33 = (day: number) => {
    if (!days33.has(day)) {
      const month = sectors33At(day) ?? {}
      days33.set(day, buildDaySectors(r20, D, day, (id) => { const code = month[tickers[id]]; return code && code !== '9999' ? code : undefined }, tickers.length, byCode))
    }
    return days33.get(day)!
  }
  const daySectors60 = (day: number) => {
    if (!days60.has(day)) days60.set(day, buildDaySectors(r20, D, day, (id) => sector60[tickers[id]], tickers.length, byCode))
    return days60.get(day)!
  }

  // 2 回目: イベント。研究ごとの除外を先に済ませ、その後に重複の規則を研究ごとに当てる。
  const capacity = Number(eventsDb.prepare(`SELECT COUNT(*) AS n FROM events WHERE event_type='ENTRY' AND length=2`).all()[0].n)
  const studies: Record<StudyKey, EventColumns> = { A: new EventColumns(capacity), B33: new EventColumns(capacity), B60: new EventColumns(capacity) }
  const transitionIds = new Map<string, number>()
  const eventRows = eventsDb.prepare(`SELECT ticker,length,sequence_key,signal_date,dwell_b,left_censored_b FROM events
    WHERE event_type='ENTRY' AND length=2 ORDER BY ticker`)
  const flush = (ticker: string, rows: Record<string, unknown>[]) => {
    if (rows.length === 0) return
    if (SPLIT_EXCLUDED.has(ticker)) { counts.excludedSplitTickers = (counts.excludedSplitTickers ?? 0) + rows.length; return }
    const bars = prices.all(ticker, EVENT_PATH_DISCOVERY_CUTOFF) as unknown as EventPriceBar[]
    const id = tickerId.get(ticker)
    const candidates: Record<StudyKey, Map<EventInput, { group: number; cls: number }>> = { A: new Map(), B33: new Map(), B60: new Map() }
    for (const row of rows) {
      const event: EventInput = { length: 2, sequenceKey: String(row.sequence_key), signalDate: String(row.signal_date), dwellB: Number(row.dwell_b) }
      const { group, invalidDigits } = transitionGroup(event.sequenceKey)
      if (invalidDigits > 0) bump('transitionsWithInvalidDigits')
      if (group === 'INVALID') { bump('excludedInvalidTransition'); continue }
      const groupId = GROUPS.indexOf(group)
      if (Number(row.left_censored_b) === 1) bump('A.excludedLeftCensored')
      else candidates.A.set(event, { group: groupId, cls: dwellClass(event.dwellB) })
      const day = calendarIndex.get(event.signalDate)
      const own = day == null || id == null ? NaN : r20[id * D + day]
      const ownValue = Number.isNaN(own) ? null : own
      const strength = (key: StudyKey, sectorKey: string | undefined, sectors: () => DaySectors) => {
        if (day == null) { bump(`${key}.signalNotInSource`); return }
        if (!sectorKey) { bump(`${key}.excludedNoSector`); return }
        const result = sectorStrength(sectors(), sectorKey, ownValue)
        if ('excluded' in result) bump(`${key}.${result.excluded}`)
        else candidates[key].set(event, { group: groupId, cls: result.strength })
      }
      if (event.signalDate < B33_FROM) bump('B33.outsidePeriod')
      else {
        const code = day == null ? undefined : sectors33At(day)?.[ticker]
        if (code === '9999') bump('B33.excludedOtherSector')
        else strength('B33', code, () => daySectors33(day!))
      }
      strength('B60', sector60[ticker], () => daySectors60(day!))
    }
    for (const key of ['A', 'B33', 'B60'] as const) {
      const chosen = candidates[key]
      const prefixed = (name: string) => bump(`${key}.${name.replace(/^s2\./, '')}`)
      for (const kept of selectTickerEvents(bars, [...chosen.keys()], calendarIndex, prefixed)) {
        const c = studies[key]
        const index = c.size++
        const { group, cls } = chosen.get(kept.event)!
        if (!transitionIds.has(kept.event.sequenceKey)) transitionIds.set(kept.event.sequenceKey, transitionIds.size)
        c.group[index] = transitionIds.get(kept.event.sequenceKey)!
        c.segment[index] = group
        c.sub[index] = cls
        c.ticker[index] = id ?? -1
        c.date[index] = calendarIndex.get(kept.event.signalDate)!
        c.dwell[index] = kept.event.dwellB
        storeOutcome(c, index, bars, kept.signalRow, kept.evaluation)
        for (const missing of kept.evaluation.missingHorizons) bump(`${key}.missing${missing}.${kept.evaluation.termination}`)
        bump(`${key}.kept`)
      }
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

  // 群ごとの行。rows[study][group][class]
  const rows = Object.fromEntries((['A', 'B33', 'B60'] as const).map((key) => {
    const c = studies[key]
    const lists = GROUPS.map(() => [[], [], []] as number[][])
    for (let row = 0; row < c.size; row += 1) lists[c.segment[row]][c.sub[row]].push(row)
    return [key, lists]
  })) as Record<StudyKey, number[][][]>
  const blockFilter = (c: EventColumns, from: string, to: string) => (row: number) => {
    const month = calendar[c.date[row]].slice(0, 7); return month >= from && month <= to
  }
  const tables = (key: StudyKey) => {
    const c = studies[key]
    return Object.fromEntries(GROUPS.map((group, g) => [group, Object.fromEntries(HORIZONS.map((h) => [h, rows[key][g].map((list) => ({
      full: summarize(c, list, h),
      blocks: Object.fromEntries(STUDY_BLOCKS[key].map(([name, from, to]) => [name, summarize(c, list.filter(blockFilter(c, from, to)), h)])),
    }))]))]))
  }
  const figures = (key: StudyKey) => {
    const c = studies[key]
    return Object.fromEntries(GROUPS.map((group, g) => [group, Object.fromEntries(MAIN_HORIZONS.map((h) => [h, {
      histogram: rows[key][g].map((list) => bothSides(c, list, h)), path: rows[key][g].map((list) => pathBands(c, list, h)),
    }]))]))
  }
  // 判定する 12 個: 研究 A は長い − 短い (中央値・勝率)、研究 B (33 業種) は強い − 弱い (中央値)。研究 B の勝率の差は探索。
  const hypotheses: Array<{ id: string; study: 'A' | 'B'; group: TransitionGroup; horizon: number; judged: boolean } & Comparison> = []
  for (const [key, a, b] of [['A', 2, 0], ['B33', 0, 2]] as const) {
    for (const group of ['IMPROVE', 'DETERIORATE'] as const) {
      for (const h of MAIN_HORIZONS) {
        const g = GROUPS.indexOf(group)
        for (const comparison of compare(studies[key], rows[key][g][a], rows[key][g][b], h, calendar, STUDY_BLOCKS[key])) {
          const study = key === 'A' ? 'A' : 'B'
          const judged = study === 'A' || comparison.measure === 'median'
          hypotheses.push({ id: `${study}-${group}-${comparison.measure}-${h}`, study, group, horizon: h, judged, ...comparison })
        }
      }
    }
  }
  if (hypotheses.filter((row) => row.judged).length !== 12) throw new Error('expected 12 judged hypotheses')

  // 遷移ごとの数字 (全期間と 3 つの期間、探索)。研究 2 と同じく、どれかの期間で結果のあるイベントが 100 件以上の遷移だけを載せる
  // (研究 A・B ごとに判断し、満たさない研究は null。2026-11-11 オーナー決定)。X の先頭 2 桁ごとのファイル (数十個) にまとめる。
  const transitionsDir = path.join(out, 'transitions')
  fs.mkdirSync(transitionsDir, { recursive: true })
  const byTransition = new Map<number, Record<'A' | 'B33', number[][]>>()
  for (const key of ['A', 'B33'] as const) {
    const c = studies[key]
    for (let row = 0; row < c.size; row += 1) {
      const entry = byTransition.get(c.group[row]) ?? { A: [[], [], []], B33: [[], [], []] }
      entry[key][c.sub[row]].push(row)
      byTransition.set(c.group[row], entry)
    }
  }
  const shards = new Map<string, Record<string, unknown>>()
  const included: string[] = []
  for (const [key, id] of [...transitionIds.entries()].sort(([a], [b]) => byCode(a, b))) {
    const entry = byTransition.get(id)
    if (!entry) continue
    const eligible = (study: 'A' | 'B33') => HORIZONS.some((h) => summarize(studies[study], entry[study].flat(), h).n >= MIN_EVENTS)
    if (!eligible('A') && !eligible('B33')) continue
    included.push(key)
    const shard = shards.get(key.slice(0, 2)) ?? {}
    shard[key] = Object.fromEntries((['A', 'B33'] as const).map((study) => {
      const c = studies[study]
      return [study, eligible(study) ? HORIZONS.map((h) => entry[study].map((list) => [compact(summarize(c, list, h)),
        ...STUDY_BLOCKS[study].map(([, from, to]) => compact(summarize(c, list.filter(blockFilter(c, from, to)), h)))])) : null]
    }))
    shards.set(key.slice(0, 2), shard)
  }
  let transitionBytes = 0
  for (const [name, shard] of shards) {
    const body = JSON.stringify(shard)
    const files = [[`${name}.json`, `${body}\n`], [`${name}.js`, `window.__transitions(${JSON.stringify(name)},${body.replace(/</g, '\\u003c')});\n`]]
    for (const [file, text] of files) { writeOnce(path.join(transitionsDir, file), text); transitionBytes += Buffer.byteLength(text) }
  }

  const dwell = (key: StudyKey) => GROUPS.map((_, g) => rows[key][g].map((list) => {
    const values = Float64Array.from(list, (row) => studies[key].dwell[row]).sort()
    return values.length ? { n: values.length, median: interpolated(values, 0.5) } : { n: 0 }
  }))
  const result = {
    namespace: 'PREREG_DWELL_SECTOR_20261111_RESULT_V1', generatedAt: new Date().toISOString(),
    prereg: 'research/6stage/event-path-research/PREREG_DWELL_SECTOR_20261111.md',
    inputs: { events: EVENTS_PATH, source: SOURCE_PATH, eventsSha256: inputs.eventsSha, sourceSha256: inputs.manifestSourceSha,
      segments: segmentFile, segmentsSha256: sha256File(segmentFile), sector60: sector60File, sector60Sha256: sha256File(sector60File) },
    counts, groups: GROUPS, blocks: STUDY_BLOCKS, sector33Names: listing.sector33Names, hypotheses,
    studies: { A: { tables: tables('A'), figures: figures('A'), dwell: dwell('A') }, B33: { tables: tables('B33'), figures: figures('B33') },
      B60: { tables: tables('B60') } },
    transitions: { minEvents: MIN_EVENTS, observed: byTransition.size, included: included.length, keys: included,
      shards: [...shards.keys()].sort(), bytes: transitionBytes },
  }
  writeOnce(path.join(out, 'result.json'), `${JSON.stringify(result)}\n`)
  writeOnce(path.join(out, 'report.html'), renderDwellSectorReport(result))
  const totalBytes = transitionBytes + ['result.json', 'report.html'].reduce((sum, file) => sum + fs.statSync(path.join(out, file)).size, 0)
  console.log(JSON.stringify({ out, counts, transitions: { observed: byTransition.size, included: included.length, files: shards.size * 2, totalBytes }, judged: hypotheses.filter((row) => row.judged).map((row) => [row.id, row.level]) }, null, 2))
}

// 保存済みの result.json から報告ページだけを作り直す (集計はしない)。
function renderOnly(out: string): void {
  const name = process.argv.find((arg) => arg.startsWith('--name='))?.slice(7) ?? ''
  if (!/^report-[A-Za-z0-9-]+\.html$/.test(name)) throw new Error('--name=report-<suffix>.html is required')
  writeOnce(path.join(out, name), renderDwellSectorReport(JSON.parse(fs.readFileSync(path.join(out, 'result.json'), 'utf8'))))
  console.log(`rendered ${path.join(out, name)}`)
}

if (require.main === module) {
  const mode = process.argv[2]
  const out = outputDirectory()
  if (mode === 'sectors') fetchSegments(out).catch((error) => { console.error(error); process.exit(1) })
  else if (mode === 'sector60') exportSector60(out)
  else if (mode === 'analyze') analyze(out)
  else if (mode === 'render') renderOnly(out)
  else throw new Error('mode must be sectors, sector60, analyze or render')
}

