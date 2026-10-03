const FINNHUB_BASE_URL = 'https://finnhub.io'
export const FINNHUB_EARNINGS_SOURCE_URL = 'https://finnhub.io/docs/api/earnings-calendar'

export type FinnhubEarningsHour = 'bmo' | 'dmh' | 'amc' | null

export type FinnhubEarningsEvent = {
  date: string
  symbol: string
  hour: FinnhubEarningsHour
  year: number | null
  quarter: number | null
  epsEstimate: number | null
  epsActual: number | null
  revenueEstimate: number | null
  revenueActual: number | null
  raw: Record<string, unknown>
}

export class FinnhubHttpError extends Error {
  readonly status: number
  readonly retryAfterSeconds: number | null

  constructor(message: string, status: number, retryAfterSeconds: number | null) {
    super(message)
    this.name = 'FinnhubHttpError'
    this.status = status
    this.retryAfterSeconds = retryAfterSeconds
  }
}

function apiKey(): string {
  const key = process.env.FINNHUB_API_KEY?.trim()
  if (!key) {
    throw new Error('FINNHUB_API_KEY is not set. Add the issued Finnhub API key to .env.local.')
  }
  return key
}

function numberOrNull(value: unknown): number | null {
  if (value == null || value === '') return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function integerOrNull(value: unknown): number | null {
  const parsed = numberOrNull(value)
  return parsed == null ? null : Math.trunc(parsed)
}

function validDate(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
}

export function normalizeFinnhubEarningsHour(value: unknown): FinnhubEarningsHour {
  if (typeof value !== 'string') return null
  const normalized = value.trim().toLowerCase()
  return normalized === 'bmo' || normalized === 'dmh' || normalized === 'amc'
    ? normalized
    : null
}

export function finnhubEarningsTimeBucket(hour: FinnhubEarningsHour): 'before_open' | 'market_hours' | 'after_close' | 'unknown' {
  if (hour === 'bmo') return 'before_open'
  if (hour === 'dmh') return 'market_hours'
  if (hour === 'amc') return 'after_close'
  return 'unknown'
}

export function parseFinnhubEarningsResponse(payload: unknown): FinnhubEarningsEvent[] {
  const rows = typeof payload === 'object' && payload !== null && 'earningsCalendar' in payload
    ? (payload as { earningsCalendar?: unknown }).earningsCalendar
    : null
  if (!Array.isArray(rows)) {
    throw new Error('Finnhub earnings response does not contain an earningsCalendar array')
  }

  return rows.flatMap((value): FinnhubEarningsEvent[] => {
    if (typeof value !== 'object' || value === null) return []
    const row = value as Record<string, unknown>
    if (!validDate(row.date) || typeof row.symbol !== 'string' || !row.symbol.trim()) return []
    return [{
      date: row.date,
      symbol: row.symbol.trim().toUpperCase(),
      hour: normalizeFinnhubEarningsHour(row.hour),
      year: integerOrNull(row.year),
      quarter: integerOrNull(row.quarter),
      epsEstimate: numberOrNull(row.epsEstimate),
      epsActual: numberOrNull(row.epsActual),
      revenueEstimate: numberOrNull(row.revenueEstimate),
      revenueActual: numberOrNull(row.revenueActual),
      raw: row,
    }]
  })
}

export async function fetchFinnhubEarningsCalendar(from: string, to: string): Promise<FinnhubEarningsEvent[]> {
  if (!validDate(from) || !validDate(to) || from > to) {
    throw new Error(`Invalid Finnhub earnings range: ${from}..${to}`)
  }

  const url = new URL('/api/v1/calendar/earnings', FINNHUB_BASE_URL)
  url.searchParams.set('from', from)
  url.searchParams.set('to', to)
  url.searchParams.set('international', 'false')

  const response = await fetch(url, {
    headers: {
      accept: 'application/json',
      'X-Finnhub-Token': apiKey(),
      'user-agent': 'StockBoard Finnhub earnings ingestion',
    },
    signal: AbortSignal.timeout(30_000),
  })
  if (!response.ok) {
    const body = await response.text().catch(() => '')
    const retryAfter = Number(response.headers.get('retry-after'))
    throw new FinnhubHttpError(
      `Finnhub earnings calendar failed: HTTP ${response.status}${body ? ` ${body.slice(0, 200)}` : ''}`,
      response.status,
      Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : null,
    )
  }

  return parseFinnhubEarningsResponse(await response.json())
}
