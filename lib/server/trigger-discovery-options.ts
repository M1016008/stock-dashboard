import { execAll, execGet } from '@/lib/db/client'
import type { TriggerDiscoveryOptionsResponse } from '@/lib/trigger-discovery-contract'

type MarketRow = {
  market: string | null
  count: number
}

export async function getTriggerDiscoveryOptions(): Promise<TriggerDiscoveryOptionsResponse> {
  const [latest, markets] = await Promise.all([
    execGet<{ date: string | null }>('SELECT MAX(date) AS date FROM ohlcv_daily'),
    execAll<MarketRow>(`
      SELECT market_segment AS market, COUNT(*) AS count
      FROM ticker_universe
      WHERE active = 1
      GROUP BY market_segment
      ORDER BY CASE WHEN market_segment IS NULL OR TRIM(market_segment) = '' THEN 1 ELSE 0 END,
               market_segment
    `),
  ])
  return {
    contractVersion: 'trigger-discovery-options-v1',
    latestAsOf: latest?.date ?? null,
    markets: markets.map((row) => ({
      value: row.market?.trim() || null,
      label: row.market?.trim() || '市場区分なし',
      count: Number(row.count),
    })),
  }
}
