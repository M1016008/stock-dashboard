import {
  deriveHistoricalScanEvents,
  getTriggerHistoricalScan,
  historicalSnapshot,
  MAX_HISTORICAL_SCAN_TRADING_DAYS,
} from '@/lib/server/trigger-discovery-historical-scan'
import { parseTriggerHistoricalScanRequest } from '@/lib/server/trigger-discovery-historical-scan-request'
import type { TriggerDiscoveryRow } from '@/lib/server/trigger-discovery-read-model'
import type {
  TriggerHistoricalScanCandidateSnapshot,
  TriggerHistoricalScanEvent,
  TriggerHistoricalScanPerformance,
  TriggerHistoricalScanRequest,
  TriggerHistoricalScanResponse,
} from '@/lib/trigger-discovery-historical-scan-contract'

export const RESEARCH_LONG_SCAN_VERSION = 2
export const DEFAULT_RESEARCH_CHUNK_SESSIONS = 180

type Scan = typeof getTriggerHistoricalScan

export class ResearchScanContinuity {
  private previous: Map<string, TriggerHistoricalScanCandidateSnapshot> | null = null
  private readonly seen = new Set<string>()
  private lastDate: string | null = null
  baselineCandidateCount = 0
  enteredCount = 0
  reEntryCount = 0
  statusChangeCount = 0
  exitedCount = 0
  totalEventCount = 0

  onDay(date: string, rows: TriggerDiscoveryRow[]): TriggerHistoricalScanEvent[] {
    if (this.lastDate && date <= this.lastDate) throw new Error('research_scan_non_monotonic_date')
    const current = new Map(rows.map((row) => [row.ticker, historicalSnapshot(row)]))
    if (this.previous === null) this.baselineCandidateCount = current.size
    const events = deriveHistoricalScanEvents({ date, previous: this.previous, current, seen: this.seen })
    for (const event of events) {
      if (event.eventType === 'ENTERED') this.enteredCount += 1
      else if (event.eventType === 'RE_ENTRY') this.reEntryCount += 1
      else if (event.eventType === 'STATUS_CHANGED') this.statusChangeCount += 1
      else this.exitedCount += 1
    }
    this.totalEventCount += events.length
    this.previous = current
    this.lastDate = date
    return events
  }

  get uniqueCandidateCount(): number { return this.seen.size }
  get latestDate(): string | null { return this.lastDate }
  snapshot(ticker: string): TriggerHistoricalScanCandidateSnapshot | null {
    return this.previous?.get(ticker) ?? null
  }
}

function sumPerformance(parts: TriggerHistoricalScanPerformance[]): TriggerHistoricalScanPerformance {
  const first = parts[0]
  if (!first) throw new Error('research_scan_no_chunks')
  const sum = (key: keyof TriggerHistoricalScanPerformance) => parts.reduce((total, part) =>
    total + (typeof part[key] === 'number' ? part[key] as number : 0), 0)
  return {
    ...first,
    totalMs: sum('totalMs'), queryCount: sum('queryCount'), tradingDays: sum('tradingDays'),
    sourceTickerCount: Math.max(...parts.map((part) => part.sourceTickerCount)),
    sourceRows: {
      ohlcv: parts.reduce((n, part) => n + part.sourceRows.ohlcv, 0),
      storedMonthlyMa: parts.reduce((n, part) => n + part.sourceRows.storedMonthlyMa, 0),
      weeklyOhlcv: parts.reduce((n, part) => n + part.sourceRows.weeklyOhlcv, 0),
      stage: parts.reduce((n, part) => n + part.sourceRows.stage, 0),
    },
    sqlMs: Object.fromEntries(Object.keys(first.sqlMs).map((key) => [key,
      parts.reduce((n, part) => n + part.sqlMs[key as keyof typeof part.sqlMs], 0),
    ])) as TriggerHistoricalScanPerformance['sqlMs'],
    peakHeapBytes: Math.max(...parts.map((part) => part.peakHeapBytes)),
    peakRssBytes: Math.max(...parts.map((part) => part.peakRssBytes)),
    heapDeltaBytes: Math.max(...parts.map((part) => part.heapDeltaBytes)),
    seriesBuildMs: sum('seriesBuildMs'), maPreparationMs: sum('maPreparationMs'),
    liquidityMs: sum('liquidityMs'), universeFilterMs: sum('universeFilterMs'),
    triggerEngineMs: sum('triggerEngineMs'), stageJoinMs: sum('stageJoinMs'),
    scoreMs: sum('scoreMs'), eventDerivationMs: sum('eventDerivationMs'),
  }
}

export async function runResearchLongScan(input: {
  request: Omit<TriggerHistoricalScanRequest, 'eventOffset' | 'eventLimit'>
  sessions: string[]
  chunkSessions?: number
  onEvents: (date: string, events: TriggerHistoricalScanEvent[]) => Promise<void> | void
  onDay?: (date: string, rows: TriggerDiscoveryRow[]) => Promise<void> | void
  onChunk?: (index: number, response: TriggerHistoricalScanResponse) => Promise<void> | void
  scan?: Scan
}): Promise<{ response: TriggerHistoricalScanResponse; chunkRanges: Array<[string, string]> }> {
  const chunkSessions = input.chunkSessions ?? DEFAULT_RESEARCH_CHUNK_SESSIONS
  if (!Number.isInteger(chunkSessions) || chunkSessions < 1
    || chunkSessions > MAX_HISTORICAL_SCAN_TRADING_DAYS) throw new Error('invalid_research_chunk_size')
  if (!input.sessions.length || input.sessions[0] < input.request.startDate
    || input.sessions.at(-1)! > input.request.endDate
    || input.sessions.some((date, index) => index > 0 && date <= input.sessions[index - 1])) {
    throw new Error('invalid_research_sessions')
  }
  const parsed = parseTriggerHistoricalScanRequest({ ...input.request, eventOffset: 0, eventLimit: 1 })
  const continuity = new ResearchScanContinuity()
  const chunkRanges: Array<[string, string]> = []
  const parts: TriggerHistoricalScanResponse[] = []
  let observed = 0
  for (let offset = 0; offset < input.sessions.length; offset += chunkSessions) {
    const chunk = input.sessions.slice(offset, offset + chunkSessions)
    const start = chunk[0]
    const end = chunk.at(-1)!
    chunkRanges.push([start, end])
    const response = await (input.scan ?? getTriggerHistoricalScan)({
      requestedStartDate: start, requestedEndDate: end,
      timeframe: parsed.timeframe, criteria: parsed.input, eventOffset: 0, eventLimit: 1,
    }, {
      onDay: async (date, rows) => {
        if (date !== input.sessions[observed]) throw new Error('research_scan_session_mismatch')
        const events = continuity.onDay(date, rows)
        await input.onDay?.(date, rows)
        await input.onEvents(date, events)
        observed += 1
      },
    })
    if (response.scanMeta.tradingDayCount !== chunk.length
      || response.scanMeta.resolvedStartDate !== start
      || response.scanMeta.resolvedEndDate !== end) throw new Error('research_scan_chunk_range_mismatch')
    parts.push(response)
    await input.onChunk?.(parts.length - 1, response)
  }
  if (observed !== input.sessions.length) throw new Error('research_scan_incomplete')
  const first = parts[0]
  const last = parts.at(-1)!
  const dailyCounts = parts.flatMap((part) => part.dailyCounts)
  const totalCandidates = dailyCounts.reduce((n, day) => n + day.candidateCount, 0)
  const response: TriggerHistoricalScanResponse = {
    ...first,
    scanMeta: { ...first.scanMeta,
      requestedStartDate: input.request.startDate, requestedEndDate: input.request.endDate,
      resolvedStartDate: input.sessions[0], resolvedEndDate: input.sessions.at(-1)!,
      tradingDayCount: input.sessions.length, processedTradingDays: observed,
      baselineDate: input.sessions[0], baselineCandidateCount: continuity.baselineCandidateCount,
    },
    summary: {
      tradingDays: input.sessions.length, uniqueCandidateCount: continuity.uniqueCandidateCount,
      enteredCount: continuity.enteredCount, reEntryCount: continuity.reEntryCount,
      statusChangeCount: continuity.statusChangeCount, exitedCount: continuity.exitedCount,
      totalEventCount: continuity.totalEventCount,
      maxDailyCandidates: Math.max(...dailyCounts.map((day) => day.candidateCount)),
      averageDailyCandidates: Math.round(totalCandidates / observed * 1_000) / 1_000,
    },
    dailyCounts,
    events: [],
    eventPage: { offset: 0, limit: 0, returnedCount: 0,
      totalCount: continuity.totalEventCount, hasMore: continuity.totalEventCount > 0 },
    performance: sumPerformance(parts.map((part) => part.performance)),
  }
  if (last.scanMeta.resolvedEndDate !== continuity.latestDate) throw new Error('research_scan_final_date_mismatch')
  return { response, chunkRanges }
}
