import { getStageTransitionDirection } from '@/lib/hex-stage'

export const DAILY_CLOSE_REPORT_TYPE = 'STOCKBOARD_DAILY_CLOSE' as const
export const DAILY_CLOSE_REPORT_VERSION = 1 as const

export type DataStatus = 'CURRENT' | 'DELAYED' | 'UNAVAILABLE'
export type TriggerReportStatus = 'APPROACHING' | 'NEAR' | 'IN_ZONE' | 'BELOW_ZONE'

export type StageSet = {
  dayA: number | null
  dayB: number | null
  weekA: number | null
  weekB: number | null
  monthA: number | null
  monthB: number | null
}

export type ReportTickerRow = {
  ticker: string
  name: string
  price: number | null
  dailyReturn: number | null
  volumeRatio: number | null
  turnoverRatio: number | null
  tradingValue: number | null
  sector33: string | null
  classification60: string | null
  stages: StageSet
  previousStages: StageSet
}

export type PeriodMetric = {
  meanReturn: number | null
  medianReturn: number | null
  winnerCount: number
  loserCount: number
  eligibleCount: number
  totalCount: number
  winRate: number | null
  coverageRatio: number
  lowSample: boolean
}

export type ClassificationMomentum = {
  name: string
  oneWeek: PeriodMetric
  twoWeek: PeriodMetric
  oneMonth: PeriodMetric
  rank1W: number | null
  rank2W: number | null
  rank1M: number | null
  rankChange1MTo1W: number | null
}

export type SectorRotationRow = {
  name: string
  return1D: number | null
  return5D: number | null
  currentRank: number | null
  previousRank: number | null
  rankChange: number | null
  eligibleCount: number
  totalCount: number
}

export type ReportIndex = {
  code: string
  label: string
  value: number | null
  changePct: number | null
  note?: string
}

export type TriggerReportRow = {
  ticker: string
  name: string
  status: TriggerReportStatus
  score: number
  previousScore: number | null
  zoneDistancePct: number
  previousZoneDistancePct: number | null
  averageTradingValue: number | null
  stages: StageSet
}

export type TriggerReport = {
  available: boolean
  candidateCount: number
  definitionName: string | null
  evaluationDate: string | null
  previousEvaluationDate: string | null
  currentCounts: Record<'NEW' | 'RE_ENTRY' | 'NEAR' | 'IN_ZONE', number>
  previousCounts: Record<'NEW' | 'RE_ENTRY' | 'NEAR' | 'IN_ZONE', number>
  newRows: TriggerReportRow[]
  reentryRows: TriggerReportRow[]
  nearRows: TriggerReportRow[]
  inZoneRows: TriggerReportRow[]
}

export type WatchlistReportRow = TriggerReportRow & ReportTickerRow & {
  changeReasons: string[]
  sparkline: number[]
}

export type LargeHolderEvent = {
  eventType: 'NEW_5PCT' | 'INCREASE' | 'DECREASE' | 'EXIT_5PCT'
  issuer: string
  investor: string
  ticker: string
  holdingRatio: number | null
  estimatedCurrentValue: number | null
  obligationDate: string
}

export type EarningsEvent = {
  ticker: string
  name: string
  eventDate: string
  sessionsRemaining: number | null
  triggerStatus: TriggerReportStatus | null
  stages: StageSet
}

export type ReportTakeaway = { headline: string; detail: string[] }

export type DailyCloseReport = {
  version: typeof DAILY_CLOSE_REPORT_VERSION
  reportType: typeof DAILY_CLOSE_REPORT_TYPE
  reportDate: string
  requestedDate: string | null
  priceDate: string
  derivedDate: string | null
  generatedAt: string
  generationMs: number
  current: boolean
  dataStatus: {
    jpPrice: { date: string | null; status: DataStatus }
    jpDerived: { date: string | null; status: DataStatus }
    trigger: { date: string | null; status: DataStatus }
    largeHolder: { date: string | null; status: DataStatus; note?: string }
  }
  executive: {
    keyPoints: string[]
    kpis: Array<{ label: string; value: string; change: number | null; context: string }>
  }
  market: {
    indices: ReportIndex[]
    advances: number
    declines: number
    unchanged: number
    tradingValue: number
    newHighs: number
    newLows: number
    stageDistribution: Array<{ stage: number; count: number }>
  }
  sectors33: SectorRotationRow[]
  classifications60: ClassificationMomentum[]
  watchlist: { source: 'BROWSER_LOCAL_STORAGE'; total: number; changed: WatchlistReportRow[] }
  trigger: TriggerReport
  setups: {
    stageImproving: Array<ReportTickerRow & { changes: string[] }>
    maApproaching: TriggerReportRow[]
    priceRangeHit: Array<ReportTickerRow & { label: string }>
  }
  unusual: {
    volumeSpike: ReportTickerRow[]
    turnoverSpike: ReportTickerRow[]
    priceMove: ReportTickerRow[]
    triggerScoreMove: TriggerReportRow[]
  }
  events: {
    largeHolder: { status: DataStatus; priceDate: string | null; events: LargeHolderEvent[] }
    earnings: EarningsEvent[]
  }
  takeaways: Record<number, ReportTakeaway>
  sources: string[]
  limitations: string[]
}

export type ClassificationInput = { name: string; return5: number | null; return10: number | null; return20: number | null }
export type SectorInput = { name: string; return1: number | null; previousReturn1: number | null; return5: number | null }

export function isValidReportDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const date = new Date(`${value}T00:00:00.000Z`)
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value
}

function finite(values: Array<number | null | undefined>): number[] {
  return values.filter((value): value is number => typeof value === 'number' && Number.isFinite(value))
}

export function median(values: number[]): number | null {
  if (!values.length) return null
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}

function metric(values: Array<number | null>, totalCount: number): PeriodMetric {
  const eligible = finite(values)
  const winnerCount = eligible.filter((value) => value > 0).length
  const loserCount = eligible.filter((value) => value < 0).length
  return {
    meanReturn: eligible.length ? eligible.reduce((sum, value) => sum + value, 0) / eligible.length : null,
    medianReturn: median(eligible),
    winnerCount,
    loserCount,
    eligibleCount: eligible.length,
    totalCount,
    winRate: eligible.length ? winnerCount / eligible.length : null,
    coverageRatio: totalCount ? eligible.length / totalCount : 0,
    lowSample: eligible.length < 5,
  }
}

function ranks<T>(rows: T[], value: (row: T) => number | null): Map<T, number> {
  return new Map(rows.filter((row) => value(row) != null)
    .sort((a, b) => value(b)! - value(a)!)
    .map((row, index) => [row, index + 1]))
}

export function aggregateClassifications60(rows: ClassificationInput[]): ClassificationMomentum[] {
  const grouped = new Map<string, ClassificationInput[]>()
  for (const row of rows) {
    if (!row.name) continue
    const list = grouped.get(row.name) ?? []
    list.push(row)
    grouped.set(row.name, list)
  }
  const result: ClassificationMomentum[] = [...grouped.entries()].map(([name, items]) => ({
    name,
    oneWeek: metric(items.map((item) => item.return5), items.length),
    twoWeek: metric(items.map((item) => item.return10), items.length),
    oneMonth: metric(items.map((item) => item.return20), items.length),
    rank1W: null,
    rank2W: null,
    rank1M: null,
    rankChange1MTo1W: null,
  }))
  const rank1W = ranks(result, (row) => row.oneWeek.meanReturn)
  const rank2W = ranks(result, (row) => row.twoWeek.meanReturn)
  const rank1M = ranks(result, (row) => row.oneMonth.meanReturn)
  for (const row of result) {
    row.rank1W = rank1W.get(row) ?? null
    row.rank2W = rank2W.get(row) ?? null
    row.rank1M = rank1M.get(row) ?? null
    row.rankChange1MTo1W = row.rank1W != null && row.rank1M != null ? row.rank1M - row.rank1W : null
  }
  return result.sort((a, b) => a.name.localeCompare(b.name, 'ja'))
}

export function aggregateSectorRotation(rows: SectorInput[]): SectorRotationRow[] {
  const grouped = new Map<string, SectorInput[]>()
  for (const row of rows) {
    if (!row.name) continue
    const list = grouped.get(row.name) ?? []
    list.push(row)
    grouped.set(row.name, list)
  }
  const mean = (values: Array<number | null>) => {
    const selected = finite(values)
    return selected.length ? selected.reduce((sum, value) => sum + value, 0) / selected.length : null
  }
  const result = [...grouped.entries()].map(([name, items]) => ({
    name,
    return1D: mean(items.map((item) => item.return1)),
    previousReturn1D: mean(items.map((item) => item.previousReturn1)),
    return5D: mean(items.map((item) => item.return5)),
    currentRank: null as number | null,
    previousRank: null as number | null,
    rankChange: null as number | null,
    eligibleCount: items.filter((item) => item.return1 != null).length,
    totalCount: items.length,
  }))
  const current = ranks(result, (row) => row.return1D)
  const previous = ranks(result, (row) => row.previousReturn1D)
  for (const row of result) {
    row.currentRank = current.get(row) ?? null
    row.previousRank = previous.get(row) ?? null
    row.rankChange = row.currentRank != null && row.previousRank != null
      ? row.previousRank - row.currentRank : null
  }
  return result.map(({ previousReturn1D: _previous, ...row }) => row)
    .sort((a, b) => (a.currentRank ?? Number.MAX_SAFE_INTEGER) - (b.currentRank ?? Number.MAX_SAFE_INTEGER))
}

export function stageChanges(previous: StageSet, current: StageSet): string[] {
  const axes: Array<[keyof StageSet, string]> = [
    ['dayA', '日A'], ['dayB', '日B'], ['weekA', '週A'],
    ['weekB', '週B'], ['monthA', '月A'], ['monthB', '月B'],
  ]
  return axes.flatMap(([key, label]) => {
    const direction = getStageTransitionDirection(previous[key], current[key])
    return direction === 'improve' || direction === 'jump_improve'
      ? [`${label} S${previous[key]}→S${current[key]}`]
      : []
  })
}

export function watchlistChangeReasons(
  stock: Pick<ReportTickerRow, 'dailyReturn' | 'volumeRatio' | 'previousStages' | 'stages'>,
  trigger?: Pick<TriggerReportRow, 'score' | 'previousScore'>,
): string[] {
  const changes = stageChanges(stock.previousStages, stock.stages)
  if (trigger?.previousScore != null && Math.abs(trigger.score - trigger.previousScore) >= 5) {
    changes.push(`Score ${trigger.previousScore.toFixed(0)}→${trigger.score.toFixed(0)}`)
  }
  if (stock.volumeRatio != null && stock.volumeRatio >= 2) {
    changes.push(`出来高 ${stock.volumeRatio.toFixed(1)}倍`)
  }
  if (stock.dailyReturn != null && Math.abs(stock.dailyReturn) >= 3) {
    changes.push(`日次 ${stock.dailyReturn >= 0 ? '+' : ''}${stock.dailyReturn.toFixed(1)}%`)
  }
  return changes
}

export function percentage(current: number | null, base: number | null): number | null {
  return current != null && base != null && base !== 0 ? (current / base - 1) * 100 : null
}

export function sortTopBottom<T>(rows: T[], value: (row: T) => number | null, count: number) {
  const eligible = rows.filter((row) => value(row) != null)
  return {
    top: [...eligible].sort((a, b) => value(b)! - value(a)!).slice(0, count),
    bottom: [...eligible].sort((a, b) => value(a)! - value(b)!).slice(0, count),
  }
}
