import { execAll, execGet } from '@/lib/db/client'
import type { DailyCloseReport, LargeHolderEvent } from '@/lib/daily-close-report'
import { buildDailyCloseReportWith } from '@/lib/server/daily-close-report-core'
import { RankingUnavailable, getRankingSnapshot } from '@/lib/server/large-holders/ranking-read-model'
import { readPublishedPointer } from '@/lib/large-holders/snapshot-publication'

async function loadLargeHolderEvents(priceDate: string): Promise<DailyCloseReport['events']['largeHolder']> {
  try {
    const snapshot = await getRankingSnapshot()
    const investors = new Map(snapshot.investors.map((investor) => [investor.investorEntityId, investor.displayName]))
    const events: LargeHolderEvent[] = snapshot.activities
      .filter((event) => event.obligationDate <= priceDate)
      .sort((a, b) => b.obligationDate.localeCompare(a.obligationDate)
        || (b.currentValueEquivalent ?? -1) - (a.currentValueEquivalent ?? -1))
      .slice(0, 12)
      .map((event) => ({ eventType: event.eventType, issuer: event.issuerName ?? event.ticker,
        investor: investors.get(event.investorEntityId) ?? '名称未確認', ticker: event.ticker,
        holdingRatio: event.reportedHoldingPct, estimatedCurrentValue: event.currentValueEquivalent,
        obligationDate: event.obligationDate }))
    return { status: snapshot.priceDate === priceDate ? 'CURRENT' : 'DELAYED', priceDate: snapshot.priceDate, events }
  } catch (error) {
    const status = error instanceof RankingUnavailable && error.reason.startsWith('certified_snapshot_stale')
      ? 'DELAYED' : 'UNAVAILABLE'
    const currentPath = process.env.LARGE_HOLDER_RANKING_CURRENT_PATH
    const pointer = status === 'DELAYED' && currentPath
      ? await readPublishedPointer(currentPath).catch(() => null) : null
    return { status, priceDate: pointer?.priceDate ?? null, events: [] }
  }
}

export async function buildDailyCloseReport(input: { requestedDate?: string | null; watchlistTickers?: string[] }): Promise<DailyCloseReport> {
  return buildDailyCloseReportWith({ execAll, execGet, loadLargeHolderEvents }, input)
}
