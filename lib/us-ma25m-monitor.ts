import {
  buildMonthlyMaMonitorSeries,
  type MonthlyMaMonitorPoint,
} from '@/lib/monthly-ma-monitor'
import { US_ADJUSTED_PRICE_BASIS } from '@/lib/us-adjusted-ohlcv'

export const US_MONTHLY_MA_MONITOR_PERIODS = [3, 5, 10, 20, 25] as const
export const US_MONTHLY_MA_UNAVAILABLE_PERIODS = [15] as const
export const US_MONTHLY_MA_LIST_HISTORY_SESSIONS = 31
export const US_MONTHLY_MA_DETAIL_HISTORY_SESSIONS = 320
export const US_MONTHLY_MA_PRICE_BASIS = US_ADJUSTED_PRICE_BASIS
export const US_MONTHLY_MA_DEFINITION_VERSION = 'us-monthly-ma-monitor-v1'

export type UsMonthlyMaPeriod = (typeof US_MONTHLY_MA_MONITOR_PERIODS)[number]
export type UsMonthlyMaStatus =
  | 'signals'
  | 'all'
  | 'approaching'
  | 'contact'
  | 'touch_5'
  | 'cross_up'
  | 'cross_down'
  | 'rapid'

export type UsMonthlyMaSort = 'score' | 'distance' | 'speed' | 'ticker'

export type UsMonthlyMaSourceRow = {
  ticker: string
  name: string | null
  exchange: string | null
  sector: string | null
  industry: string | null
  assetType: string | null
  date: string
  open: number
  high: number
  low: number
  close: number
  volume: number | null
  avgVolume20: number | null
  dailyAStage: number | null
  dailyBStage: number | null
  weeklyAStage: number | null
  weeklyBStage: number | null
  monthlyAStage: number | null
  monthlyBStage: number | null
  monthlyMa3: number | null
  monthlyMa5: number | null
  monthlyMa10: number | null
  monthlyMa20: number | null
  monthlyMa25: number | null
}

export type UsMonthlyMaMonitorRow = MonthlyMaMonitorPoint & {
  signalKind: 'ma'
  ticker: string
  name: string
  exchange: string | null
  sector: string | null
  industry: string | null
  assetType: string | null
  period: UsMonthlyMaPeriod
  maValue: number
  currentVolume: number | null
  avgVolume20: number | null
  volumeRatio20: number | null
  dailyAStage: number | null
  dailyBStage: number | null
  weeklyAStage: number | null
  weeklyBStage: number | null
  monthlyAStage: number | null
  monthlyBStage: number | null
  historyWindowStartDate: string
  historyWindowSessions: number
  historyTruncated: boolean
}

export type UsMonthlyMaBuildResult = {
  rows: UsMonthlyMaMonitorRow[]
  sourceTickers: number
  eligibleTickers: number
  missingByPeriod: Record<UsMonthlyMaPeriod, number>
  historyStartDate: string | null
}

export type UsMonthlyMaFilter = {
  period: UsMonthlyMaPeriod | 'all'
  status: UsMonthlyMaStatus
  query: string
  exchange: string | null
  sector: string | null
  maxDistance: number | null
  minScore: number
  contactThreshold: number
  sort: UsMonthlyMaSort
  direction: 'asc' | 'desc'
  offset: number
  limit: number
}

export type UsMonthlyMaSummary = {
  monitored: number
  signals: number
  approaching: number
  contact: number
  touch5: number
  cross5: number
  rapid: number
}

const PERIOD_FIELD: Record<UsMonthlyMaPeriod, keyof UsMonthlyMaSourceRow> = {
  3: 'monthlyMa3',
  5: 'monthlyMa5',
  10: 'monthlyMa10',
  20: 'monthlyMa20',
  25: 'monthlyMa25',
}

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function latestMetadata(rows: UsMonthlyMaSourceRow[], asOfDate: string): UsMonthlyMaSourceRow | null {
  return rows.find((row) => row.date === asOfDate) ?? null
}

function pointIsSignal(row: UsMonthlyMaMonitorRow): boolean {
  return row.primaryStatus !== 'watch'
    || (row.touchAgeSessions != null && row.touchAgeSessions <= 5)
    || (row.crossAgeSessions != null && row.crossAgeSessions <= 5)
    || row.isRapidApproach
}

export function buildUsMonthlyMaMonitorRows(
  source: UsMonthlyMaSourceRow[],
  asOfDate: string,
  options: { historyTruncated?: boolean } = {},
): UsMonthlyMaBuildResult {
  const grouped = new Map<string, UsMonthlyMaSourceRow[]>()
  for (const row of source) {
    if (!row.ticker || !row.date || row.date > asOfDate) continue
    const values = [row.open, row.high, row.low, row.close]
    if (values.some((value) => !Number.isFinite(value) || value <= 0)) continue
    const rows = grouped.get(row.ticker) ?? []
    rows.push(row)
    grouped.set(row.ticker, rows)
  }

  const missingByPeriod = Object.fromEntries(
    US_MONTHLY_MA_MONITOR_PERIODS.map((period) => [period, 0]),
  ) as Record<UsMonthlyMaPeriod, number>
  const output: UsMonthlyMaMonitorRow[] = []
  const eligible = new Set<string>()
  let historyStartDate: string | null = null

  for (const [ticker, unorderedRows] of grouped) {
    const rows = unorderedRows.slice().sort((left, right) => left.date.localeCompare(right.date))
    const metadata = latestMetadata(rows, asOfDate)
    if (!metadata) continue
    const firstDate = rows[0]?.date ?? asOfDate
    if (historyStartDate == null || firstDate < historyStartDate) historyStartDate = firstDate

    for (const period of US_MONTHLY_MA_MONITOR_PERIODS) {
      const field = PERIOD_FIELD[period]
      const observations = rows.flatMap((row) => {
        const targetValue = finiteNumber(row[field])
        if (targetValue == null || targetValue <= 0) return []
        return [{
          date: row.date,
          open: row.open,
          high: row.high,
          low: row.low,
          close: row.close,
          targetValue,
        }]
      })
      const series = buildMonthlyMaMonitorSeries(observations)
      const point = series.at(-1)
      if (!point || point.date !== asOfDate) {
        missingByPeriod[period] += 1
        continue
      }
      eligible.add(ticker)
      const currentVolume = finiteNumber(metadata.volume)
      const avgVolume20 = finiteNumber(metadata.avgVolume20)
      output.push({
        ...point,
        signalKind: 'ma',
        ticker,
        name: metadata.name?.trim() || ticker,
        exchange: metadata.exchange,
        sector: metadata.sector,
        industry: metadata.industry,
        assetType: metadata.assetType,
        period,
        maValue: point.targetValue,
        currentVolume,
        avgVolume20,
        volumeRatio20: currentVolume != null && avgVolume20 != null && avgVolume20 > 0
          ? currentVolume / avgVolume20
          : null,
        dailyAStage: metadata.dailyAStage,
        dailyBStage: metadata.dailyBStage,
        weeklyAStage: metadata.weeklyAStage,
        weeklyBStage: metadata.weeklyBStage,
        monthlyAStage: metadata.monthlyAStage,
        monthlyBStage: metadata.monthlyBStage,
        historyWindowStartDate: firstDate,
        historyWindowSessions: rows.length,
        historyTruncated: options.historyTruncated ?? true,
      })
    }
  }

  return {
    rows: output,
    sourceTickers: grouped.size,
    eligibleTickers: eligible.size,
    missingByPeriod,
    historyStartDate,
  }
}

export function summarizeUsMonthlyMaRows(
  rows: UsMonthlyMaMonitorRow[],
  contactThreshold: number,
): UsMonthlyMaSummary {
  return {
    monitored: new Set(rows.map((row) => row.ticker)).size,
    signals: rows.filter(pointIsSignal).length,
    approaching: rows.filter((row) => row.isApproaching).length,
    contact: rows.filter((row) => row.absDistancePct <= contactThreshold).length,
    touch5: rows.filter((row) => row.touchAgeSessions != null && row.touchAgeSessions <= 5).length,
    cross5: rows.filter((row) => row.crossAgeSessions != null && row.crossAgeSessions <= 5).length,
    rapid: rows.filter((row) => row.isRapidApproach).length,
  }
}

function matchesStatus(row: UsMonthlyMaMonitorRow, status: UsMonthlyMaStatus, contactThreshold: number): boolean {
  switch (status) {
    case 'signals': return pointIsSignal(row)
    case 'approaching': return row.isApproaching
    case 'contact': return row.absDistancePct <= contactThreshold
    case 'touch_5': return row.touchAgeSessions != null && row.touchAgeSessions <= 5
    case 'cross_up': return row.lastCrossDirection === 'up' && row.crossAgeSessions != null && row.crossAgeSessions <= 5
    case 'cross_down': return row.lastCrossDirection === 'down' && row.crossAgeSessions != null && row.crossAgeSessions <= 5
    case 'rapid': return row.isRapidApproach
    case 'all': return true
  }
}

function compareNullable(left: number | null, right: number | null): number {
  if (left == null && right == null) return 0
  if (left == null) return 1
  if (right == null) return -1
  return left - right
}

export function filterUsMonthlyMaRows(
  rows: UsMonthlyMaMonitorRow[],
  filter: UsMonthlyMaFilter,
): { rows: UsMonthlyMaMonitorRow[]; total: number } {
  const query = filter.query.trim().toUpperCase()
  const filtered = rows.filter((row) => (
    (filter.period === 'all' || row.period === filter.period)
    && matchesStatus(row, filter.status, filter.contactThreshold)
    && (!query || row.ticker.includes(query) || row.name.toUpperCase().includes(query))
    && (!filter.exchange || row.exchange === filter.exchange)
    && (!filter.sector || row.sector === filter.sector)
    && (filter.maxDistance == null || row.absDistancePct <= filter.maxDistance)
    && row.approachScore >= filter.minScore
  ))
  const multiplier = filter.direction === 'asc' ? 1 : -1
  filtered.sort((left, right) => {
    let compared = 0
    if (filter.sort === 'ticker') compared = left.ticker.localeCompare(right.ticker) || left.period - right.period
    if (filter.sort === 'distance') compared = left.absDistancePct - right.absDistancePct
    if (filter.sort === 'speed') compared = left.approachSpeedPctPerDay - right.approachSpeedPctPerDay
    if (filter.sort === 'score') compared = left.approachScore - right.approachScore
    return compared * multiplier || left.ticker.localeCompare(right.ticker) || left.period - right.period
  })
  return {
    total: filtered.length,
    rows: filtered.slice(filter.offset, filter.offset + filter.limit),
  }
}

export function usMonthlyMaFilterOptions(rows: UsMonthlyMaMonitorRow[]): {
  exchanges: string[]
  sectors: string[]
} {
  return {
    exchanges: [...new Set(rows.map((row) => row.exchange).filter((value): value is string => Boolean(value)))].sort(),
    sectors: [...new Set(rows.map((row) => row.sector).filter((value): value is string => Boolean(value)))].sort(),
  }
}

export function usMonthlyMaLimitations(historySessions: number): string[] {
  return [
    '15か月線は現行US Snapshot契約にないため表示しません。欠損値の補完は行いません。',
    `接触・クロスの履歴は直近${historySessions}米国営業日の読取り範囲内です。範囲以前のイベントは「未観測」であり「未発生」ではありません。`,
    'JP版の事前計算MAクラスターはUS契約にないため、この画面では単線シグナルのみを表示します。',
    'Exchange・Sector・Industryは現在参照属性で、過去時点属性ではありません。',
  ]
}

export function parseUsMonthlyPeriod(value: string | null): UsMonthlyMaPeriod | 'all' {
  if (value === 'all' || value == null || value === '') return 'all'
  const parsed = Number(value)
  return US_MONTHLY_MA_MONITOR_PERIODS.includes(parsed as UsMonthlyMaPeriod)
    ? parsed as UsMonthlyMaPeriod
    : 'all'
}

export function parseUsMonthlyStatus(value: string | null): UsMonthlyMaStatus {
  return ['signals', 'all', 'approaching', 'contact', 'touch_5', 'cross_up', 'cross_down', 'rapid'].includes(value ?? '')
    ? value as UsMonthlyMaStatus
    : 'signals'
}

export function parseUsMonthlySort(value: string | null): UsMonthlyMaSort {
  return ['score', 'distance', 'speed', 'ticker'].includes(value ?? '')
    ? value as UsMonthlyMaSort
    : 'score'
}

export function boundedUsMonthlyNumber(
  value: string | null,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  if (value == null || value.trim() === '') return fallback
  const parsed = Number(value)
  return Number.isFinite(parsed) ? Math.min(maximum, Math.max(minimum, parsed)) : fallback
}

export function monthlyMaSourceValue(row: UsMonthlyMaSourceRow, period: UsMonthlyMaPeriod): number | null {
  return finiteNumber(row[PERIOD_FIELD[period]])
}

export function buildUsMonthlyMaHistory(
  source: UsMonthlyMaSourceRow[],
  period: UsMonthlyMaPeriod,
): MonthlyMaMonitorPoint[] {
  return buildMonthlyMaMonitorSeries(
    source
      .slice()
      .sort((left, right) => left.date.localeCompare(right.date))
      .flatMap((row) => {
        const targetValue = monthlyMaSourceValue(row, period)
        if (
          targetValue == null
          || targetValue <= 0
          || !Number.isFinite(row.open)
          || !Number.isFinite(row.high)
          || !Number.isFinite(row.low)
          || !Number.isFinite(row.close)
        ) return []
        return [{
          date: row.date,
          open: row.open,
          high: row.high,
          low: row.low,
          close: row.close,
          targetValue,
        }]
      }),
  )
}

