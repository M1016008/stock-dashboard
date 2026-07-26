import { execGet } from '@/lib/db/client'

export type NextUsEarnings = {
  ticker: string
  reportDate: string
  hour: 'bmo' | 'dmh' | 'amc' | null
  timeBucket: 'before_open' | 'market_hours' | 'after_close' | 'unknown'
  fiscalYear: number | null
  fiscalQuarter: number | null
  epsEstimate: number | null
  revenueEstimate: number | null
  source: 'finnhub'
  importedAt: string
}

function todayInNewYork(): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date())
  const value = (type: string) => parts.find((part) => part.type === type)?.value ?? ''
  return `${value('year')}-${value('month')}-${value('day')}`
}

export async function getNextUsEarnings(ticker: string): Promise<NextUsEarnings | null> {
  const row = await execGet<{
    ticker: string
    reportDate: string
    hour: 'bmo' | 'dmh' | 'amc' | null
    timeBucket: 'before_open' | 'market_hours' | 'after_close' | 'unknown' | null
    fiscalYear: number | null
    fiscalQuarter: number | null
    epsEstimate: number | null
    revenueEstimate: number | null
    source: string
    importedAt: number
  }>(
    `
      SELECT
        ticker,
        report_date AS reportDate,
        hour,
        COALESCE(time_bucket, 'unknown') AS timeBucket,
        fiscal_year AS fiscalYear,
        fiscal_quarter AS fiscalQuarter,
        eps_estimate AS epsEstimate,
        revenue_estimate AS revenueEstimate,
        source,
        imported_at AS importedAt
      FROM market_earnings_calendar
      WHERE market = 'US'
        AND ticker = ?
        AND report_date >= ?
        AND source = 'finnhub'
      ORDER BY report_date ASC
      LIMIT 1
    `,
    [ticker.trim().toUpperCase(), todayInNewYork()],
  ).catch(() => undefined)

  if (!row || row.source !== 'finnhub') return null
  return {
    ...row,
    source: 'finnhub',
    timeBucket: row.timeBucket ?? 'unknown',
    importedAt: new Date(row.importedAt * 1000).toISOString(),
  }
}
