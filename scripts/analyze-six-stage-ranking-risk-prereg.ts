// PREREG_RANKING_RISK_20261113 (research/6stage/event-path-research/) の集計。研究 C (おすすめ順の点数) と研究 D (危険の大きさ)。
// 条件は事前登録の文書が正。ここで条件を変えない。読み取りはすべて immutable、書き込みは出力フォルダだけ (write-once)。
// 研究 1・2・A・B の集計の部品 (イベントの選び方・結果の計算・ブートストラップ・判定) をそのまま使う。
//
//   SIX_STAGE_REAL_RESEARCH_ONLY=1 npx tsx scripts/analyze-six-stage-ranking-risk-prereg.ts analyze --out=<dir>
import fs from 'node:fs'
import path from 'node:path'
import { SIX_STAGE_REAL_RESEARCH_ROOT, sha256File } from '@/lib/research/six-stage-real-data-contract'
import { EVENT_PATH_DISCOVERY_CUTOFF } from '@/lib/research/six-stage-event-path-research'
import { buildSnapshotCalculations } from '@/lib/snapshots/continuous-ma'
import { inferLikelySplitAdjustment } from '@/lib/physical-momentum'
import { transitionGroup } from '@/lib/research/six-stage-dwell-sector'
import {
  STRONG_LEVEL_CD, e039StatesAt, monthEnds, rankingScore, riskOutcome, scoreGroup, type ScoreMetrics,
} from '@/lib/research/six-stage-ranking-risk'
import {
  EventColumns, GAP_LIMIT, HORIZONS, MAIN_HORIZONS, MIN_EVENTS, SPLIT_EXCLUDED, assertInputs, assertOutputDirectory, bothSides,
  has, interpolated, loadCalendar, openImmutable, pathBands, previousMonth, selectTickerEvents, storeOutcome, summarize, writeOnce,
  PATH_POINTS, type EventInput, type Summary,
} from './analyze-six-stage-transitions-prereg'
import { YEAR_BLOCKS, compare, type Comparison } from './analyze-six-stage-dwell-sector-prereg'
import { renderRankingRiskReport } from './lib/six-stage-ranking-risk-report'

const FOUNDATION = path.join(SIX_STAGE_REAL_RESEARCH_ROOT, 'v5', 'E039-JP-scale-consistent-phase1b0-foundation')
const EVENTS_PATH = path.join(FOUNDATION, 'events.sqlite')
const SOURCE_PATH = path.join(SIX_STAGE_REAL_RESEARCH_ROOT,
  'six-stage-discovery-source-export-20261025T211500JST-v2-r2.incomplete', 'jp-discovery-ohlcv.sqlite')
export const RESULT_ROOT_CD = path.join(SIX_STAGE_REAL_RESEARCH_ROOT, 'prereg-ranking-risk-20261113')
// 研究 D の市場区分 (探索): 研究 1・2 の集計で取得したもの。読み取りだけ。
const SEGMENTS_FILE = path.join(SIX_STAGE_REAL_RESEARCH_ROOT, 'prereg-transitions-20261111', 'run-20261111', 'segments.json')
const SEGMENTS_SHA256 = '949ff665ad69da830fca058d7d83a0c496fc6a33844ea32793523b9c5bbe175e'
// 研究 D の状態の計算は main の commit 109d048 のファイルに固定する。変わっていれば止める。
const PINNED_COMMIT = '109d0481076a6a4e4aa013216ac7b32758b02c52'
const PINNED_FILES: Record<string, string> = {
  'lib/snapshots/continuous-ma.ts': '98677ef7a268949447af0bd06c15ce6dacce5cb6d02b2fac8a7e40e11b719d5a',
  'lib/hex-stage.ts': '18177855a54757f26bfda6f105f379a219af89832219e94f8cfe0c5049f2e15e',
  'lib/stage-classification.ts': 'a830768fa882eaa9b68d6416d162ca349c2728100783dc1a8936fb1fc7a0bf74',
  'lib/timeframes.ts': '8dc7fb6e381698bc8a0041769d9bec7507bd06d80b7772d7037f1c4a7a239124',
  'lib/physical-momentum.ts': '54bb26950abc79d4faec39075ad539480be42ae62f71c833059f4ccdaf580605',
}
const MONTH_ENDS = 176
const DIRECTIONS = ['UP', 'DOWN'] as const
const GROUPS = ['IMPROVE', 'DETERIORATE', 'MIXED', 'INVALID'] as const
const RISK_ROWS = 20
type Bar = { date: string; open: number; high: number; low: number; close: number; volume: number | null }
const outputDirectory = () => assertOutputDirectory(process.argv.find((arg) => arg.startsWith('--out='))?.slice(6) ?? '', RESULT_ROOT_CD)
const round = (value: number) => Math.round(value * 1e5) / 1e5
const sorted = (values: Iterable<number>) => Float64Array.from(values).sort()

// 下向きのイベントは、力の向きにそろえる (騰落と道筋の符号を逆にし、最大の上昇幅と下落幅、その到達日を入れ替える)。
function alignDown(c: EventColumns, index: number): void {
  for (let k = index * 4; k < index * 4 + 4; k += 1) {
    const up = c.mfe[k]; c.mfe[k] = -c.mae[k]; c.mae[k] = -up; c.ret[k] = -c.ret[k]
    const hi = c.hiDay[k]; c.hiDay[k] = c.loDay[k]; c.loDay[k] = hi
  }
  for (let k = index * PATH_POINTS; k < (index + 1) * PATH_POINTS; k += 1) c.path[k] = -c.path[k]
}

// 研究 C の 1 つの集まり (本集計、または売買代金で絞った確認用)。
class ScoreStudy {
  readonly c: EventColumns; readonly direction: Int8Array; readonly score: Float64Array
  cuts: Record<string, { p20: number; p80: number }> = {}
  readonly keys = new Set<string>()
  constructor(capacity: number) { this.c = new EventColumns(capacity); this.direction = new Int8Array(capacity); this.score = new Float64Array(capacity) }
  add(kept: ReturnType<typeof selectTickerEvents>[number], bars: readonly Bar[], metrics: ScoreMetrics, tickerId: number, transitionId: number,
    calendarIndex: ReadonlyMap<string, number>, bump: (key: string) => void, ticker: string): void {
    const index = this.c.size++
    const down = metrics.return5 < 0
    this.c.group[index] = transitionId
    this.c.segment[index] = GROUPS.indexOf(transitionGroup(kept.event.sequenceKey).group)
    this.c.ticker[index] = tickerId
    this.c.date[index] = calendarIndex.get(kept.event.signalDate)!
    this.direction[index] = down ? 1 : 0
    this.score[index] = metrics.score
    storeOutcome(this.c, index, bars, kept.signalRow, kept.evaluation)
    if (down) alignDown(this.c, index)
    for (const missing of kept.evaluation.missingHorizons) bump(`missing${missing}.${kept.evaluation.termination}`)
    this.keys.add(`${ticker}|${kept.event.signalDate}|${kept.event.sequenceKey}`)
  }
  // 区切りの値は向きごとに、除外と重複の後のすべてのイベントの点数の 20% 点と 80% 点 (線形補間)。
  assignGroups(): void {
    DIRECTIONS.forEach((name, d) => {
      const scores = sorted(this.rows(d))
      this.cuts[name] = { p20: interpolated(scores, 0.2), p80: interpolated(scores, 0.8) }
    })
    for (let row = 0; row < this.c.size; row += 1) this.c.sub[row] = scoreGroup(this.score[row], this.cuts[DIRECTIONS[this.direction[row]]])
  }
  private *rows(d: number) { for (let row = 0; row < this.c.size; row += 1) if (this.direction[row] === d) yield this.score[row] }
  lists(d: number, filter: (row: number) => boolean = () => true): number[][] {
    const out: number[][] = [[], [], []]
    for (let row = 0; row < this.c.size; row += 1) if (this.direction[row] === d && filter(row)) out[this.c.sub[row]].push(row)
    return out
  }
}

type Hypothesis = { id: string; study: 'C' | 'D'; judged: boolean; label: string; measureName: string; horizon: number } & Omit<Comparison, 'level'> & { level?: Comparison['level'] }
// 判定しない比べ (確認用・探索) には段階を付けない。
const stage = ({ level, ...rest }: Comparison, judged: boolean) => (judged ? { ...rest, level } : rest)
const tableOf = (c: EventColumns, lists: number[][], calendar: string[]) => Object.fromEntries(HORIZONS.map((h) => [h, lists.map((list) => ({
  full: summarize(c, list, h),
  blocks: Object.fromEntries(YEAR_BLOCKS.map(([name, from, to]) => [name, summarize(c, list.filter((row) => {
    const month = calendar[c.date[row]].slice(0, 7); return month >= from && month <= to
  }), h)])),
}))]))
const compact = (s: Summary): number[] | 0 =>
  has(s) ? [s.n, ...[s.winLong, s.mean, s.median, s.q10, s.q25, s.q75, s.q90, s.mfeMedian, s.maeMedian].map(round)] : 0

// 研究 D の分布の棚: (a) −40% 未満、1 ポイント刻みで −40%〜0%、0% 以上 (42 個)。(b) 0.25 ポイント刻みで 0〜10%、10% 以上 (41 個)。
function riskHistogram(c: EventColumns, rows: readonly number[], h: number, kind: 'a' | 'b'): number[] {
  const k = HORIZONS.indexOf(h as typeof HORIZONS[number])
  const bins = new Array(kind === 'a' ? 42 : 41).fill(0)
  for (const row of rows) {
    const value = c.ret[row * 4 + k] * 100
    if (Number.isNaN(value)) continue
    bins[kind === 'a' ? (value < -40 ? 0 : value >= 0 ? 41 : Math.floor(value + 40) + 1) : Math.min(40, Math.floor(value / 0.25))] += 1
  }
  return bins
}

async function analyze(out: string): Promise<void> {
  const inputs = assertInputs()
  const repository = path.resolve(__dirname, '..')
  for (const [file, sha] of Object.entries(PINNED_FILES)) {
    if (sha256File(path.join(repository, file)) !== sha) throw new Error(`${file} differs from the pinned commit ${PINNED_COMMIT}`)
  }
  if (sha256File(SEGMENTS_FILE) !== SEGMENTS_SHA256) throw new Error('segments.json sha256 mismatch')
  const segmentMonths: Record<string, { segments: Record<string, string> }> = JSON.parse(fs.readFileSync(SEGMENTS_FILE, 'utf8')).months
  const source = openImmutable(SOURCE_PATH)
  const eventsDb = openImmutable(EVENTS_PATH)
  const calendar = loadCalendar(source)
  const calendarIndex = new Map(calendar.map((date, index) => [date, index]))
  const counts: Record<string, number> = {}
  const bump = (key: string) => { counts[key] = (counts[key] ?? 0) + 1 }
  const prices = source.prepare('SELECT date,open,high,low,close,volume FROM ohlcv_daily WHERE ticker=? AND date<=? ORDER BY date')
  const barsOf = (ticker: string) => prices.all(ticker, EVENT_PATH_DISCOVERY_CUTOFF) as unknown as Bar[]
  const tickers = source.prepare('SELECT DISTINCT ticker FROM ohlcv_daily WHERE date<=? ORDER BY ticker').all(EVENT_PATH_DISCOVERY_CUTOFF).map((row) => String(row.ticker))
  const tickerId = new Map(tickers.map((ticker, index) => [ticker, index]))
  const gapsOf = (bars: readonly Bar[]) => (i: number) => calendarIndex.get(bars[i + 1].date)! - calendarIndex.get(bars[i].date)! - 1

  // ---- 研究 C: 1 回目。本集計と、売買代金の確認用の「重複の規則の前」のイベント。 ----
  const capacity = Number(eventsDb.prepare(`SELECT COUNT(*) AS n FROM events WHERE event_type='ENTRY' AND length=2`).all()[0].n)
  const main = new ScoreStudy(capacity)
  const transitionIds = new Map<string, number>()
  const transitionId = (key: string) => { if (!transitionIds.has(key)) transitionIds.set(key, transitionIds.size); return transitionIds.get(key)! }
  const preTurnover: { ticker: string; items: { event: EventInput; metrics: ScoreMetrics }[] }[] = []
  const eventRows = eventsDb.prepare(`SELECT ticker,sequence_key,signal_date,dwell_b FROM events WHERE event_type='ENTRY' AND length=2 ORDER BY ticker`)
  const flush = (ticker: string, rows: Record<string, unknown>[]) => {
    if (rows.length === 0) return
    if (SPLIT_EXCLUDED.has(ticker)) { counts['C.excludedSplitTickers'] = (counts['C.excludedSplitTickers'] ?? 0) + rows.length; return }
    const bars = barsOf(ticker)
    const rowOf = new Map(bars.map((bar, index) => [bar.date, index]))
    const gapAfter = gapsOf(bars)
    const chosen = new Map<EventInput, ScoreMetrics>()
    const pre = new Map<EventInput, ScoreMetrics>()
    for (const row of rows) {
      const event: EventInput = { length: 2, sequenceKey: String(row.sequence_key), signalDate: String(row.signal_date), dwellB: Number(row.dwell_b) }
      if (transitionGroup(event.sequenceKey).group === 'INVALID') bump('C.invalidTransitionKept')
      const signalRow = rowOf.get(event.signalDate)
      if (signalRow == null) { bump('C.signalNotInSource'); continue }
      const metrics = rankingScore(bars, signalRow, gapAfter, GAP_LIMIT)
      if ('excluded' in metrics) { bump(`C.excluded.${metrics.excluded}`); continue }
      if (metrics.return5 !== 0) pre.set(event, metrics)
      if (metrics.belowFloor) bump('C.excluded.belowVolumeFloor')
      else if (metrics.return5 === 0) bump('C.excluded.zeroReturn5')
      else chosen.set(event, metrics)
    }
    const id = tickerId.get(ticker)!
    for (const kept of selectTickerEvents(bars, [...chosen.keys()], calendarIndex, (key) => bump(`C.${key.replace(/^s2\./, '')}`))) {
      main.add(kept, bars, chosen.get(kept.event)!, id, transitionId(kept.event.sequenceKey), calendarIndex, (key) => bump(`C.${key}`), ticker)
      bump('C.kept')
    }
    const items = selectTickerEvents(bars, [...pre.keys()], calendarIndex, (key) => bump(`T.pre.${key.replace(/^s2\./, '')}`), false)
      .map((kept) => ({ event: kept.event, metrics: pre.get(kept.event)! }))
    if (items.length) preTurnover.push({ ticker, items })
  }
  let currentTicker = ''
  let buffer: Record<string, unknown>[] = []
  for (const row of eventRows.iterate()) {
    if (String(row.ticker) !== currentTicker) { flush(currentTicker, buffer); currentTicker = String(row.ticker); buffer = [] }
    buffer.push(row)
  }
  flush(currentTicker, buffer)
  main.assignGroups()

  // ---- 研究 C: 売買代金で絞った確認用の集計 (探索)。基準の金額は Discovery 全体で 1 つ。 ----
  const preAll = preTurnover.flatMap((entry) => entry.items)
  const p = preAll.filter((item) => !item.metrics.belowFloor).length / preAll.length
  const turnoverValues = sorted(preAll.map((item) => item.metrics.turnover20))
  if (turnoverValues.some((value) => !Number.isFinite(value))) throw new Error('non-finite 20-day turnover')
  const threshold = interpolated(turnoverValues, 1 - p)
  const turnover = new ScoreStudy(preAll.length)
  for (const { ticker, items } of preTurnover) {
    const keep = new Map(items.filter((item) => item.metrics.turnover20 >= threshold).map((item) => [item.event, item.metrics]))
    if (keep.size === 0) continue
    const bars = barsOf(ticker)
    for (const kept of selectTickerEvents(bars, [...keep.keys()], calendarIndex, (key) => bump(`T.${key.replace(/^s2\./, '')}`))) {
      turnover.add(kept, bars, keep.get(kept.event)!, tickerId.get(ticker)!, transitionId(kept.event.sequenceKey), calendarIndex, (key) => bump(`T.${key}`), ticker)
      bump('T.kept')
    }
  }
  turnover.assignGroups()
  const both = [...turnover.keys].filter((key) => main.keys.has(key)).length

  // ---- 研究 D: 月末の状態と、その後の危険の大きさ。 ----
  const ends = monthEnds(calendar)
  if (ends.length !== MONTH_ENDS) throw new Error(`month ends ${ends.length} != ${MONTH_ENDS}`)
  const riskA = new EventColumns(ends.length * tickers.length)   // ret = (a) 最大の下落率
  const riskB = new EventColumns(ends.length * tickers.length)   // ret = (b) 標準偏差
  const codeIds = new Map<string, number>()
  const segmentNames = ['不明']
  const e039 = eventsDb.prepare(`SELECT sequence_key,signal_date,dwell_b FROM events WHERE ticker=? AND event_type='ENTRY' AND length=2 ORDER BY regime_id_c`)
  const reconciled = new Uint8Array(ends.length * tickers.length)   // 1 = E039 で照合できた組 (探索の内訳に使う)
  const reconcile = { determined: 0, pairsFrom2010: 0, prefixTickers: 0 }
  for (const ticker of tickers) {
    const bars = barsOf(ticker)
    const rowOf = new Map(bars.map((bar, index) => [bar.date, index]))
    const rows = ends.filter((date) => rowOf.has(date)).map((date) => rowOf.get(date)!)
    if (rows.length === 0) continue
    // 月末までの株価だけで計算する。分割の推定 (前後 2 行の比較) で補正される所が無ければ、全期間の計算の値はその日までの株価だけで決まるため、
    // 1 回の計算で済ませる。補正される所がある銘柄だけ、月末ごとにその日までの株価で計算し直す。
    const adjusts = bars.some((bar, i) => i > 0 && inferLikelySplitAdjustment(bars[i - 1] as never, bar as never) != null)
    if (adjusts) reconcile.prefixTickers += 1
    const full = adjusts ? null : new Map(buildSnapshotCalculations(bars as never, { includeWarmup: true }).map((row) => [row.date, row]))
    const stateAt = (row: number) => {
      const s = full ? full.get(bars[row].date) : buildSnapshotCalculations(bars.slice(0, row + 1) as never, { includeWarmup: true }).at(-1)
      if (!s || s.date !== bars[row].date) return { code: null, dailyA: null }
      const digits = [s.daily_a_stage, s.daily_b_stage, s.weekly_a_stage, s.weekly_b_stage, s.monthly_a_stage, s.monthly_b_stage]
      const valid = (v: unknown) => typeof v === 'number' && v >= 1 && v <= 6
      return { code: digits.every(valid) ? digits.join('') : null, dailyA: valid(digits[0]) ? digits[0] as number : null }
    }
    const recorded = e039StatesAt(e039.all(ticker).map((row) => {
      const signalRow = rowOf.get(String(row.signal_date))
      if (signalRow == null) throw new Error(`E039 signal date not in source ${ticker} ${row.signal_date}`)
      return { sequenceKey: String(row.sequence_key), signalRow, dwellB: Number(row.dwell_b) }
    }), rows)
    const split = SPLIT_EXCLUDED.has(ticker)
    const gapAfter = gapsOf(bars)
    for (const row of rows) {
      const date = bars[row].date
      const state = stateAt(row)
      if (date >= '2010-01-01') reconcile.pairsFrom2010 += 1
      if (recorded.has(row)) {
        reconcile.determined += 1
        if (recorded.get(row) !== state.code) throw new Error(`E039 mismatch ${ticker} ${date}: recomputed ${state.code} vs E039 ${recorded.get(row)}`)
      }
      if (split) { bump('D.excludedSplitTickers'); continue }
      if (!(bars[row].close > 0)) { bump('D.excludedInvalidBase'); continue }
      let gap = false
      for (let i = row; i < Math.min(row + RISK_ROWS, bars.length - 1) && !gap; i += 1) if (gapAfter(i) > GAP_LIMIT) gap = true
      if (gap) { bump('D.excludedGap'); continue }
      const index = riskA.size++; riskB.size++
      reconciled[index] = recorded.has(row) ? 1 : 0
      for (const c of [riskA, riskB]) {
        c.ticker[index] = tickerId.get(ticker)!
        c.date[index] = calendarIndex.get(date)!
        if (state.code && !codeIds.has(state.code)) codeIds.set(state.code, codeIds.size)
        c.group[index] = state.code ? codeIds.get(state.code)! : -1
        c.sub[index] = state.dailyA ?? 0
        const segment = segmentMonths[previousMonth(date)]?.segments[ticker] ?? '不明'
        if (!segmentNames.includes(segment)) segmentNames.push(segment)
        c.segment[index] = segmentNames.indexOf(segment)
      }
      for (const h of HORIZONS) {
        const outcome = riskOutcome(bars, row, h)
        if (!outcome) { bump(`D.missing${h}`); continue }
        riskA.ret[index * 4 + HORIZONS.indexOf(h)] = outcome.drawdown
        riskB.ret[index * 4 + HORIZONS.indexOf(h)] = outcome.stdev
      }
      if (!state.code) bump('D.codeUndetermined')
      if (state.dailyA == null) bump('D.dailyAUndetermined')
      bump('D.kept')
    }
  }
  source.close(); eventsDb.close()

  // ---- 判定する 16 個と、確認用の 8 個 (段階は付けない)。 ----
  const options = { strongLevel: STRONG_LEVEL_CD, requireAllReplicates: true }
  const hypotheses: Hypothesis[] = []
  for (const [study, judged] of [[main, true], [turnover, false]] as const) {
    DIRECTIONS.forEach((name, d) => {
      const [bottom, , top] = study.lists(d)
      for (const h of MAIN_HORIZONS) {
        for (const comparison of compare(study.c, top, bottom, h, calendar, YEAR_BLOCKS, options)) {
          hypotheses.push({ id: `${judged ? 'C' : 'C-turnover'}-${name}-${comparison.measure}-${h}`, study: 'C', judged,
            label: name === 'UP' ? '上向き: 上位 − 下位' : '下向き: 上位 − 下位', measureName: comparison.measure === 'median' ? '向きにそろえた騰落の中央値' : '勝率', horizon: h, ...stage(comparison, judged) })
        }
      }
    })
  }
  const rowsByCode = new Map<number, number[]>()
  for (let r = 0; r < riskA.size; r += 1) if (riskA.group[r] >= 0) { const list = rowsByCode.get(riskA.group[r]) ?? []; list.push(r); rowsByCode.set(riskA.group[r], list) }
  const codeRows = (code: string) => rowsByCode.get(codeIds.get(code) ?? -1) ?? []
  const dailyARows = (stage: number) => { const out: number[] = []; for (let r = 0; r < riskA.size; r += 1) if (riskA.sub[r] === stage) out.push(r); return out }
  const allRisk = Array.from({ length: riskA.size }, (_, r) => r)
  const dGroups = { '①': [codeRows('111111'), codeRows('444444')], '②': [dailyARows(1), dailyARows(4)] } as const
  // 研究 D の判定は全組。探索として、E039 で照合できた組だけ・照合できなかった組だけでも同じ差を計算する (段階は付けない)。
  const subsets = [['', () => true], ['照合できた組だけ', (row: number) => reconciled[row] === 1], ['照合できなかった組だけ', (row: number) => reconciled[row] === 0]] as const
  for (const [subset, keep] of subsets) {
    for (const [name, [one, four]] of Object.entries(dGroups)) {
      for (const [kind, c] of [['a', riskA], ['b', riskB]] as const) {
        for (const h of MAIN_HORIZONS) {
          const [median] = compare(c, four.filter(keep), one.filter(keep), h, calendar, YEAR_BLOCKS, options)
          hypotheses.push({ id: `D-${subset ? `${subset}-` : ''}${name}-${kind}-${h}`, study: 'D', judged: !subset, label: `${name} 4 の群 − 1 の群${subset ? ` (${subset})` : ''}`,
            measureName: kind === 'a' ? '(a) 最大の下落率の中央値' : '(b) 標準偏差の中央値', horizon: h, ...stage(median, !subset) })
        }
      }
    }
  }
  if (hypotheses.filter((row) => row.judged).length !== 16) throw new Error('expected 16 judged hypotheses')

  // ---- 表と図 (探索を含む)。研究 C の値は、力の向きにそろえた騰落。 ----
  const studyC = (study: ScoreStudy) => Object.fromEntries(DIRECTIONS.map((name, d) => {
    const lists = study.lists(d)
    const scoreQuantiles = lists.map((list) => { const s = sorted(list.map((row) => study.score[row])); return s.length ? [0, 0.1, 0.25, 0.5, 0.75, 0.9, 1].map((q) => interpolated(s, q)) : [] })
    return [name, { cut: study.cuts[name], scoreQuantiles, tables: tableOf(study.c, lists, calendar),
      byTransitionGroup: Object.fromEntries(GROUPS.slice(0, 3).map((group, g) => [group, Object.fromEntries(HORIZONS.map((h) =>
        [h, study.lists(d, (row) => study.c.segment[row] === g).map((list) => summarize(study.c, list, h))]))])),
      figures: Object.fromEntries(MAIN_HORIZONS.map((h) => [h, { histogram: lists.map((list) => bothSides(study.c, list, h).LONG), path: lists.map((list) => pathBands(study.c, list, h)) }])) }]
  }))
  const riskSummary = (rows: number[]) => Object.fromEntries(HORIZONS.map((h) => [h, { a: summarize(riskA, rows, h), b: summarize(riskB, rows, h) }]))
  // ほかの 6 桁 (探索): すべての 6 桁。件数・25%・中央値・75%・平均を (a)(b) ごとに、期間ごとに持つ。
  const brief = (s: Summary) => (has(s) ? [s.n, round(s.q25), round(s.median), round(s.q75), round(s.mean)] : 0)
  const studyD = {
    groups: Object.fromEntries(Object.entries(dGroups).map(([name, lists]) => [name, lists.map(riskSummary)])),
    all: riskSummary(allRisk),
    dailyA: [1, 2, 3, 4, 5, 6].map((stage) => riskSummary(dailyARows(stage))),
    codes: Object.fromEntries([...codeIds.keys()].sort().map((code) => [code, Object.fromEntries(HORIZONS.map((h) =>
      [h, [brief(summarize(riskA, codeRows(code), h)), brief(summarize(riskB, codeRows(code), h))]]))])),
    bySegment: Object.fromEntries(segmentNames.map((segment, s) => [segment, Object.fromEntries(Object.entries(dGroups).map(([name, lists]) =>
      [name, lists.map((list) => riskSummary(list.filter((row) => riskA.segment[row] === s)))]))])),
    figures: Object.fromEntries(MAIN_HORIZONS.map((h) => [h, Object.fromEntries((['a', 'b'] as const).map((kind) => [kind, {
      '①': dGroups['①'].map((list) => riskHistogram(kind === 'a' ? riskA : riskB, list, h, kind)),
      '②': dGroups['②'].map((list) => riskHistogram(kind === 'a' ? riskA : riskB, list, h, kind)),
      all: riskHistogram(kind === 'a' ? riskA : riskB, allRisk, h, kind),
    }]))])),
  }

  // 遷移 X→Y ごとの数字 (研究 C、探索): 向きと群に分ける前に、どれかの期間で結果のあるイベントが 100 件以上の遷移だけ。
  const byTransition = new Map<number, number[]>()
  for (let row = 0; row < main.c.size; row += 1) { const list = byTransition.get(main.c.group[row]) ?? []; list.push(row); byTransition.set(main.c.group[row], list) }
  const transitions: Record<string, unknown> = {}
  for (const [key, id] of [...transitionIds].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const list = byTransition.get(id)
    if (!list || !HORIZONS.some((h) => summarize(main.c, list, h).n >= MIN_EVENTS)) continue
    transitions[key] = Object.fromEntries(DIRECTIONS.map((name, d) => {
      const lists: number[][] = [[], [], []]
      for (const row of list) if (main.direction[row] === d) lists[main.c.sub[row]].push(row)
      return [name, HORIZONS.map((h) => lists.map((rows) => compact(summarize(main.c, rows, h))))]
    }))
  }

  const result = {
    namespace: 'PREREG_RANKING_RISK_20261113_RESULT_V1', generatedAt: new Date().toISOString(),
    prereg: 'research/6stage/event-path-research/PREREG_RANKING_RISK_20261113.md',
    inputs: { events: EVENTS_PATH, source: SOURCE_PATH, eventsSha256: inputs.eventsSha, sourceSha256: inputs.manifestSourceSha,
      segments: SEGMENTS_FILE, segmentsSha256: SEGMENTS_SHA256, pinnedCommit: PINNED_COMMIT, pinnedFiles: PINNED_FILES },
    counts, hypotheses, blocks: YEAR_BLOCKS,
    turnoverCheck: { p, threshold, events: preAll.length, kept: turnover.c.size, inBoth: both },
    studyC: { main: studyC(main), turnover: studyC(turnover) },
    studyD: { ...studyD, reconcile, monthEnds: ends.length, segments: segmentNames },
    transitions: { minEvents: MIN_EVENTS, observed: byTransition.size, included: Object.keys(transitions).length, file: 'transitions.json' },
  }
  fs.mkdirSync(out, { recursive: true })
  writeOnce(path.join(out, 'transitions.json'), `${JSON.stringify(transitions)}\n`)
  writeOnce(path.join(out, 'result.json'), `${JSON.stringify(result)}\n`)
  writeOnce(path.join(out, 'report.html'), renderRankingRiskReport(result, transitions))
  console.log(JSON.stringify({ out, counts, turnoverCheck: result.turnoverCheck, reconcile,
    judged: hypotheses.filter((row) => row.judged).map((row) => [row.id, row.level]) }, null, 2))
}

if (require.main === module) {
  const mode = process.argv[2]
  if (mode !== 'analyze') throw new Error('mode must be analyze')
  analyze(outputDirectory()).catch((error) => { console.error(error); process.exit(1) })
}
