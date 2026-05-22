export type OhlcvPoint = {
  date: string
  open: number | null
  high: number | null
  low: number | null
  close: number | null
  volume: number | null
}

export type StagePoint = {
  date: string
  code: string
}

export type MoveDirection = 'up' | 'down'

export type MovePeriod = {
  direction: MoveDirection
  startDate: string
  endDate: string | null
  startPrice: number | null
  endPrice: number | null
  returnPct: number | null
  tradingDays: number | null
}

export type VolumeSummary = {
  preAverage: number | null
  startVolume: number | null
  endVolume: number | null
  periodAverage: number | null
  maxVolume: number | null
  maxVolumeDate: string | null
  firstPhaseRatio: number | null
  periodRatio: number | null
  comment: string
}

export type MaAnalysis = {
  baseDate: string
  close: number | null
  sma: Record<string, number | null>
  change5Days: Record<string, number | null>
  change10Days: Record<string, number | null>
  pricePosition: Record<string, number | null>
  gaps: {
    sma5To25Pct: number | null
    sma25To75Pct: number | null
    sma75To200Pct: number | null
  }
  maOrder: string
  sma5CrossUpDate: string | null
  daysHeldAboveSma5: number | null
  recentHighDate: string | null
  recentHigh: number | null
  distanceToRecentHighPct: number | null
  brokeRecentHigh: boolean
  facts: string[]
}

export type SimilarPatternCase = {
  ticker: string
  date: string
  patternCode: string | null
  maxReturnPct: number | null
  minReturnPct: number | null
  daysToMax: number | null
}

export type SimilarPatternStats = {
  sampleSize: number
  upRate: number | null
  downRate: number | null
  avgMaxReturnPct: number | null
  avgMinReturnPct: number | null
  cases: SimilarPatternCase[]
}

export type AnalysisComment = {
  source: 'openai' | 'template'
  summary: string
  evidence: string[]
  watchPoints: string[]
  riskNotes: string[]
  similarPatternComment: string
}

const SMA_PERIODS = [5, 25, 75, 200] as const

export function round(value: number | null | undefined, digits = 2): number | null {
  if (value == null || !Number.isFinite(value)) return null
  const scale = 10 ** digits
  return Math.round(value * scale) / scale
}

export function pct(from: number | null | undefined, to: number | null | undefined): number | null {
  if (from == null || to == null || !Number.isFinite(from) || !Number.isFinite(to) || from === 0) return null
  return ((to - from) / from) * 100
}

export function fmtPct(value: number | null | undefined, digits = 1): string {
  if (value == null || !Number.isFinite(value)) return '-'
  return `${value >= 0 ? '+' : ''}${value.toFixed(digits)}%`
}

export function fmtNum(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '-'
  return Math.round(value).toLocaleString('ja-JP')
}

function average(values: Array<number | null | undefined>): number | null {
  const valid = values.filter((value): value is number => value != null && Number.isFinite(value))
  if (valid.length === 0) return null
  return valid.reduce((sum, value) => sum + value, 0) / valid.length
}

function smaAt(rows: OhlcvPoint[], index: number, period: number): number | null {
  if (index < period - 1) return null
  return average(rows.slice(index - period + 1, index + 1).map((row) => row.close))
}

function findIndexByDate(rows: OhlcvPoint[], date: string): number {
  return rows.findIndex((row) => row.date === date)
}

export function buildChartWindow(rows: OhlcvPoint[], startDate: string, endDate: string | null, before = 35, after = 18): OhlcvPoint[] {
  const startIndex = findIndexByDate(rows, startDate)
  const endIndex = endDate ? findIndexByDate(rows, endDate) : startIndex
  if (startIndex < 0) return []
  const safeEnd = endIndex >= startIndex ? endIndex : startIndex
  return rows.slice(Math.max(0, startIndex - before), Math.min(rows.length, safeEnd + after + 1))
}

export function buildMovePeriod(
  direction: MoveDirection,
  rows: OhlcvPoint[],
  startDate: string,
  endDate: string | null,
  returnPct: number | null,
  tradingDays: number | null,
): MovePeriod {
  const startRow = rows.find((row) => row.date === startDate)
  const endRow = endDate ? rows.find((row) => row.date === endDate) : null
  return {
    direction,
    startDate,
    endDate,
    startPrice: startRow?.close ?? null,
    endPrice: endRow?.close ?? null,
    returnPct,
    tradingDays,
  }
}

export function buildVolumeSummary(rows: OhlcvPoint[], startDate: string, endDate: string | null): VolumeSummary {
  const startIndex = findIndexByDate(rows, startDate)
  const endIndex = endDate ? findIndexByDate(rows, endDate) : startIndex
  if (startIndex < 0) {
    return {
      preAverage: null,
      startVolume: null,
      endVolume: null,
      periodAverage: null,
      maxVolume: null,
      maxVolumeDate: null,
      firstPhaseRatio: null,
      periodRatio: null,
      comment: '出来高推移を確認できる履歴データが不足しています。',
    }
  }

  const safeEnd = endIndex >= startIndex ? endIndex : startIndex
  const beforeRows = rows.slice(Math.max(0, startIndex - 20), startIndex)
  const periodRows = rows.slice(startIndex, safeEnd + 1)
  const firstPhaseRows = periodRows.slice(0, Math.max(1, Math.ceil(periodRows.length / 3)))
  const preAverage = average(beforeRows.map((row) => row.volume))
  const periodAverage = average(periodRows.map((row) => row.volume))
  const firstPhaseAverage = average(firstPhaseRows.map((row) => row.volume))
  const maxRow = periodRows.reduce<OhlcvPoint | null>((best, row) => {
    if (row.volume == null) return best
    if (!best || (best.volume ?? 0) < row.volume) return row
    return best
  }, null)
  const firstPhaseRatio = preAverage && firstPhaseAverage ? firstPhaseAverage / preAverage : null
  const periodRatio = preAverage && periodAverage ? periodAverage / preAverage : null

  let comment = '出来高は期間前の平均と比べて大きな変化は限定的です。'
  if ((firstPhaseRatio ?? 0) >= 1.5) {
    comment = `動き出しの出来高が期間前20日平均の約${firstPhaseRatio?.toFixed(1)}倍に増え、初動に参加者が集まっていました。`
  } else if ((periodRatio ?? 0) >= 1.25) {
    comment = `期間中の出来高は期間前20日平均の約${periodRatio?.toFixed(1)}倍で、高めの商いが続きました。`
  } else if ((periodRatio ?? 0) <= 0.75) {
    comment = '期間中の出来高は期間前より少なく、値動きの裏付けは強くありませんでした。'
  }

  return {
    preAverage: round(preAverage, 0),
    startVolume: periodRows[0]?.volume ?? null,
    endVolume: periodRows[periodRows.length - 1]?.volume ?? null,
    periodAverage: round(periodAverage, 0),
    maxVolume: maxRow?.volume ?? null,
    maxVolumeDate: maxRow?.date ?? null,
    firstPhaseRatio: round(firstPhaseRatio, 2),
    periodRatio: round(periodRatio, 2),
    comment,
  }
}

export function buildMaAnalysis(rows: OhlcvPoint[], baseDate: string): MaAnalysis {
  const baseIndex = findIndexByDate(rows, baseDate)
  const row = baseIndex >= 0 ? rows[baseIndex] : null
  const close = row?.close ?? null
  const sma: Record<string, number | null> = {}
  const change5Days: Record<string, number | null> = {}
  const change10Days: Record<string, number | null> = {}
  const pricePosition: Record<string, number | null> = {}

  for (const period of SMA_PERIODS) {
    const key = `sma${period}`
    const current = baseIndex >= 0 ? smaAt(rows, baseIndex, period) : null
    const prev5 = baseIndex >= 5 ? smaAt(rows, baseIndex - 5, period) : null
    const prev10 = baseIndex >= 10 ? smaAt(rows, baseIndex - 10, period) : null
    sma[key] = round(current, 2)
    change5Days[key] = round(pct(prev5, current), 2)
    change10Days[key] = round(pct(prev10, current), 2)
    pricePosition[key] = round(pct(current, close), 2)
  }

  const sma5 = sma.sma5
  const sma25 = sma.sma25
  const sma75 = sma.sma75
  const sma200 = sma.sma200
  const gaps = {
    sma5To25Pct: round(pct(sma25, sma5), 2),
    sma25To75Pct: round(pct(sma75, sma25), 2),
    sma75To200Pct: round(pct(sma200, sma75), 2),
  }

  const ordered = [
    { label: '5日', value: sma5 },
    { label: '25日', value: sma25 },
    { label: '75日', value: sma75 },
    { label: '200日', value: sma200 },
  ].filter((item): item is { label: string; value: number } => item.value != null)
    .sort((a, b) => b.value - a.value)
    .map((item) => item.label)
  const maOrder = ordered.length > 0 ? ordered.join(' > ') : '-'

  let sma5CrossUpDate: string | null = null
  if (baseIndex > 0) {
    for (let i = baseIndex; i >= Math.max(1, baseIndex - 80); i -= 1) {
      const prevSma = smaAt(rows, i - 1, 5)
      const currSma = smaAt(rows, i, 5)
      const prevClose = rows[i - 1]?.close
      const currClose = rows[i]?.close
      if (prevSma != null && currSma != null && prevClose != null && currClose != null && prevClose <= prevSma && currClose > currSma) {
        sma5CrossUpDate = rows[i].date
        break
      }
    }
  }

  let daysHeldAboveSma5 = 0
  if (baseIndex >= 0) {
    for (let i = baseIndex; i >= 0; i -= 1) {
      const currSma = smaAt(rows, i, 5)
      const currClose = rows[i]?.close
      if (currSma == null || currClose == null || currClose < currSma) break
      daysHeldAboveSma5 += 1
    }
  }

  const lookbackRows = baseIndex >= 0 ? rows.slice(Math.max(0, baseIndex - 60), baseIndex + 1) : []
  const recentHighRow = lookbackRows.reduce<OhlcvPoint | null>((best, item) => {
    if (item.high == null) return best
    if (!best || (best.high ?? 0) < item.high) return item
    return best
  }, null)
  const priorHighRows = baseIndex >= 1 ? rows.slice(Math.max(0, baseIndex - 60), baseIndex) : []
  const priorHigh = priorHighRows.reduce<number | null>((best, item) => {
    if (item.high == null) return best
    return best == null || item.high > best ? item.high : best
  }, null)

  const facts: string[] = []
  if (change5Days.sma5 != null) facts.push(`5日SMAの直近5営業日変化率は${fmtPct(change5Days.sma5)}です。`)
  if (change10Days.sma25 != null) facts.push(`25日SMAの直近10営業日変化率は${fmtPct(change10Days.sma25)}です。`)
  if (gaps.sma5To25Pct != null) facts.push(`5日SMAと25日SMAの距離は${fmtPct(gaps.sma5To25Pct)}です。`)
  if (sma5CrossUpDate) facts.push(`直近の5日SMA上抜け日は${sma5CrossUpDate}です。`)
  if (daysHeldAboveSma5 > 0) facts.push(`基準日まで${daysHeldAboveSma5}営業日連続で終値が5日SMA以上です。`)
  if (recentHighRow?.high != null) facts.push(`直近60営業日の高値は${recentHighRow.date}の${fmtNum(recentHighRow.high)}円です。`)

  return {
    baseDate,
    close,
    sma,
    change5Days,
    change10Days,
    pricePosition,
    gaps,
    maOrder,
    sma5CrossUpDate,
    daysHeldAboveSma5: daysHeldAboveSma5 || null,
    recentHighDate: recentHighRow?.date ?? null,
    recentHigh: recentHighRow?.high ?? null,
    distanceToRecentHighPct: round(pct(recentHighRow?.high, close), 2),
    brokeRecentHigh: priorHigh != null && close != null ? close > priorHigh : false,
    facts,
  }
}

export function buildTemplateComment(input: {
  ticker: string
  move: MovePeriod
  stagePath: StagePoint[]
  volume: VolumeSummary
  ma: MaAnalysis
  similar: SimilarPatternStats
}): AnalysisComment {
  const directionLabel = input.move.direction === 'up' ? '上昇' : '下落'
  const stageText = input.stagePath.length > 0 ? input.stagePath.map((item) => item.code).join(' → ') : '確認できません'
  const moveText = input.move.endDate
    ? `${input.move.startDate}から${input.move.endDate}までに${fmtPct(input.move.returnPct)}動きました。`
    : `${input.move.startDate}からの対象期間を確認しています。`
  const similarText = input.similar.sampleSize > 0
    ? `似たステージ・MA位置・出来高条件の過去事例は${input.similar.sampleSize}件あり、最大上昇が10%を超えた割合は${fmtPct(input.similar.upRate == null ? null : input.similar.upRate * 100)}、平均最大上昇は${fmtPct(input.similar.avgMaxReturnPct)}でした。`
    : '類似パターンはまだ十分に蓄積されていません。'

  return {
    source: 'template',
    summary: `${input.ticker}は、${moveText}この間の6桁ステージ遷移は「${stageText}」です。値幅だけでなく、出来高と移動平均線の変化を一緒に確認すると、次の候補探しに使いやすくなります。`,
    evidence: [
      input.volume.comment,
      ...input.ma.facts.slice(0, 4),
      `移動平均線の並びは「${input.ma.maOrder}」です。`,
    ],
    watchPoints: [
      input.ma.recentHigh != null
        ? `直近高値${fmtNum(input.ma.recentHigh)}円を出来高を伴って超えられるかを確認します。`
        : '直近高値を出来高を伴って超えられるかを確認します。',
      input.ma.daysHeldAboveSma5
        ? `5日SMAの上を維持できている日数は${input.ma.daysHeldAboveSma5}営業日です。この維持が続くかを見ます。`
        : '終値が5日SMAの上に戻り、その状態を維持できるかを見ます。',
      '同じ6桁ステージ遷移に出来高増加が重なる銘柄を優先して比較します。',
    ],
    riskNotes: [
      '5日SMAを再び下回る場合は、一時的な反発で終わる可能性があります。',
      directionLabel === '上昇'
        ? '上昇率は過去の結果であり、同じ条件でも必ず再現するわけではありません。'
        : '下落局面では反発の見込みより、下げ止まりの確認を先に見る必要があります。',
    ],
    similarPatternComment: similarText,
  }
}
