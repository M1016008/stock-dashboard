// PREREG_RANKING_RISK_20261113 (研究 C・D) の決まりを、データに依らない関数にしたもの。条件は事前登録の文書が正。

// 判定の強い証拠の区間 (16 個の Bonferroni)。
export const STRONG_LEVEL_CD = 1 - 0.05 / 16
export const VOLUME_FLOOR = 200_000
export const SCORE_ROWS = 20
export const VOLUME_RATIO_CAP = 5

type ScoreBar = { close: number; volume: number | null }
export type ScoreMetrics = { return5: number; volumeRatio: number; score: number; averageVolume20: number; turnover20: number; belowFloor: boolean }
const positive = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0

// 研究 C の点数 (シグナル日の行 row)。gapAfter(i) = 行 i と i+1 の間の、売買の無い営業日の数。
// 事前登録の除外の順に確かめる。20 万株の条件と「5 日騰落率がちょうど 0」は、呼ぶ側が集計ごとに判断する (belowFloor・return5)。
export function rankingScore(bars: readonly ScoreBar[], row: number, gapAfter: (i: number) => number, gapLimit: number):
  ScoreMetrics | { excluded: 'fewerThan20Rows' | 'invalidClose' | 'invalidVolume' | 'gap' | 'zeroAverageVolume' } {
  if (row < SCORE_ROWS) return { excluded: 'fewerThan20Rows' }
  if (!positive(bars[row].close) || !positive(bars[row - 5].close)) return { excluded: 'invalidClose' }
  for (let i = row - SCORE_ROWS; i <= row; i += 1) {
    const volume = bars[i].volume
    if (typeof volume !== 'number' || !Number.isFinite(volume) || volume < 0) return { excluded: 'invalidVolume' }
  }
  for (let i = row - SCORE_ROWS; i < row; i += 1) if (gapAfter(i) > gapLimit) return { excluded: 'gap' }
  let volumeSum = 0; let turnoverSum = 0
  for (let i = row - SCORE_ROWS; i < row; i += 1) { volumeSum += bars[i].volume!; turnoverSum += bars[i].close * bars[i].volume! }
  const averageVolume20 = volumeSum / SCORE_ROWS
  if (averageVolume20 === 0) return { excluded: 'zeroAverageVolume' }
  const return5 = bars[row].close / bars[row - 5].close - 1
  const volumeRatio = bars[row].volume! / averageVolume20
  return { return5, volumeRatio, score: Math.abs(return5) * Math.min(volumeRatio, VOLUME_RATIO_CAP), averageVolume20,
    turnover20: turnoverSum / SCORE_ROWS, belowFloor: averageVolume20 < VOLUME_FLOOR }
}

// 0 = 下位 (20% 点以下)、2 = 上位 (80% 点以上)、1 = 中位。
export function scoreGroup(score: number, cut: { p20: number; p80: number }): 0 | 1 | 2 {
  return score >= cut.p80 ? 2 : score <= cut.p20 ? 0 : 1
}

type RiskBar = { high: number; low: number; close: number }
// 研究 D の結果 (基準 = baseRow の終値)。h 行目が無い、または 1〜h 行目に高値・安値・終値が無い・0 以下の行があれば null。
// (a) 最大の下落率 = 1〜h 行目の安値の最小 ÷ 基準 − 1。(b) 1〜h 行目の日々の騰落率の標本標準偏差 (h − 1 で割る)。
export function riskOutcome(bars: readonly RiskBar[], baseRow: number, h: number): { drawdown: number; stdev: number } | null {
  const base = bars[baseRow].close
  if (baseRow + h >= bars.length) return null
  let low = Infinity
  const returns: number[] = []
  for (let i = 1; i <= h; i += 1) {
    const bar = bars[baseRow + i]
    if (!positive(bar.high) || !positive(bar.low) || !positive(bar.close)) return null
    low = Math.min(low, bar.low)
    returns.push(bar.close / (i === 1 ? base : bars[baseRow + i - 1].close) - 1)
  }
  const mean = returns.reduce((a, b) => a + b, 0) / h
  const stdev = Math.sqrt(returns.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (h - 1))
  return { drawdown: low / base - 1, stdev }
}

// 月末の日: 営業日の並び (いずれかの銘柄に売買がある日) の、各月の最後の日。
export function monthEnds(calendar: readonly string[]): string[] {
  return calendar.filter((date, i) => i === calendar.length - 1 || calendar[i + 1].slice(0, 7) !== date.slice(0, 7))
}

// E039 のイベント (状態が変わった日) だけで決まる、各行の 6 桁。X>Y のイベントの前の dwell_b 行 (X の状態が続いた行) は X。
// 区間の最後の状態は次の変化が無いため決まらない。signalRow はイベントの日の行、rows は調べる行 (小さい順)。
export function e039StatesAt(events: readonly { sequenceKey: string; signalRow: number; dwellB: number }[], rows: readonly number[]): Map<number, string> {
  const out = new Map<number, string>()
  for (const event of events) {
    const from = event.signalRow - event.dwellB
    for (const row of rows) if (row >= from && row < event.signalRow) out.set(row, event.sequenceKey.split('>')[0])
  }
  return out
}
