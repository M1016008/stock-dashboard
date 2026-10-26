const FMP_BASE_URL = 'https://financialmodelingprep.com/stable'
const FMP_EARNINGS_PAGE_LIMIT = 4_000
type Environment = Readonly<Record<string, string | undefined>>

export const FMP_EARNINGS_DOCUMENTATION_URL =
  'https://site.financialmodelingprep.com/developer/docs#earnings-calendar-earnings'
export const FMP_PROFILE_DOCUMENTATION_URL =
  'https://site.financialmodelingprep.com/developer/docs#company-profile-company-information'

export type FmpEarningsCalendarRow = {
  symbol?: unknown
  date?: unknown
  epsActual?: unknown
  epsEstimated?: unknown
  revenueActual?: unknown
  revenueEstimated?: unknown
  lastUpdated?: unknown
}

export type FmpEarningsEvent = {
  provider: 'fmp'
  ticker: string
  reportDate: string
  timeBucket: 'unknown'
  scheduleStatus: 'reported' | 'provider_scheduled_unverified'
  epsEstimate: number | null
  epsActual: number | null
  revenueEstimate: number | null
  revenueActual: number | null
  sourceUpdatedAt: string | null
  sourceUrl: typeof FMP_EARNINGS_DOCUMENTATION_URL
  raw: FmpEarningsCalendarRow
}

export type FmpCompanyProfileRow = {
  symbol?: unknown
  companyName?: unknown
  cik?: unknown
  exchange?: unknown
  exchangeFullName?: unknown
  sector?: unknown
  industry?: unknown
  currency?: unknown
}

export type FmpCompanyClassification = {
  provider: 'fmp'
  ticker: string
  name: string | null
  cik: string | null
  exchange: string | null
  exchangeFullName: string | null
  sector: string | null
  industry: string | null
  currency: string | null
  taxonomy: 'FMP_CUSTOM'
  effectiveAt: null
  historicalPitAvailable: false
  sourceUrl: typeof FMP_PROFILE_DOCUMENTATION_URL
}

function isIsoDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const date = new Date(`${value}T00:00:00Z`)
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value
}

function calendarSpanDays(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000)
}

function nullableNumber(value: unknown): number | null {
  if (value == null || value === '') return null
  const parsed = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function nullableText(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function normalizedTicker(value: unknown): string | null {
  const ticker = nullableText(value)?.toUpperCase() ?? null
  return ticker && /^[A-Z0-9.^=-]{1,24}$/.test(ticker) ? ticker : null
}

export function normalizeFmpEarningsCalendar(payload: unknown): FmpEarningsEvent[] {
  if (!Array.isArray(payload)) throw new Error('FMP earnings response must be an array')
  return payload.flatMap((raw): FmpEarningsEvent[] => {
    if (!raw || typeof raw !== 'object') return []
    const row = raw as FmpEarningsCalendarRow
    const ticker = normalizedTicker(row.symbol)
    if (!ticker || !isIsoDate(row.date)) return []
    const epsActual = nullableNumber(row.epsActual)
    const revenueActual = nullableNumber(row.revenueActual)
    return [{
      provider: 'fmp',
      ticker,
      reportDate: row.date,
      // The documented calendar payload does not guarantee BMO/AMC semantics.
      timeBucket: 'unknown',
      scheduleStatus: epsActual != null || revenueActual != null
        ? 'reported'
        : 'provider_scheduled_unverified',
      epsEstimate: nullableNumber(row.epsEstimated),
      epsActual,
      revenueEstimate: nullableNumber(row.revenueEstimated),
      revenueActual,
      sourceUpdatedAt: isIsoDate(row.lastUpdated) ? row.lastUpdated : null,
      sourceUrl: FMP_EARNINGS_DOCUMENTATION_URL,
      raw: row,
    }]
  })
}

export function normalizeFmpCompanyProfile(payload: unknown): FmpCompanyClassification[] {
  if (!Array.isArray(payload)) throw new Error('FMP profile response must be an array')
  return payload.flatMap((raw): FmpCompanyClassification[] => {
    if (!raw || typeof raw !== 'object') return []
    const row = raw as FmpCompanyProfileRow
    const ticker = normalizedTicker(row.symbol)
    if (!ticker) return []
    return [{
      provider: 'fmp',
      ticker,
      name: nullableText(row.companyName),
      cik: nullableText(row.cik),
      exchange: nullableText(row.exchange),
      exchangeFullName: nullableText(row.exchangeFullName),
      sector: nullableText(row.sector),
      industry: nullableText(row.industry),
      currency: nullableText(row.currency),
      // FMP documents a customized classification guided by GICS. It is not GICS.
      taxonomy: 'FMP_CUSTOM',
      effectiveAt: null,
      historicalPitAvailable: false,
      sourceUrl: FMP_PROFILE_DOCUMENTATION_URL,
    }]
  })
}

function fmpApiKey(environment: Environment): string {
  if (!isFmpDisplayLicenseApproved(environment)) {
    throw new Error('FMP display/redistribution rights are not approved')
  }
  const key = environment.FMP_API_KEY?.trim()
  if (!key) throw new Error('FMP_API_KEY is not configured')
  return key
}

async function fetchFmpJson(
  endpoint: string,
  params: Record<string, string>,
  environment: Environment,
): Promise<unknown> {
  const url = new URL(`${FMP_BASE_URL}/${endpoint}`)
  for (const [name, value] of Object.entries(params)) url.searchParams.set(name, value)
  url.searchParams.set('apikey', fmpApiKey(environment))
  const response = await fetch(url, {
    headers: { accept: 'application/json' },
    cache: 'no-store',
    signal: AbortSignal.timeout(20_000),
  })
  if (!response.ok) throw new Error(`FMP ${endpoint} request failed with HTTP ${response.status}`)
  return await response.json()
}

export async function fetchFmpEarningsCalendar(
  from: string,
  to: string,
  environment: Environment = process.env,
): Promise<FmpEarningsEvent[]> {
  if (!isIsoDate(from) || !isIsoDate(to) || from > to) throw new Error('Invalid FMP earnings range')
  if (calendarSpanDays(from, to) > 90) throw new Error('FMP earnings range exceeds the documented 90-day maximum')
  const payload = await fetchFmpJson('earnings-calendar', {
    from,
    to,
    page: '0',
    includeReportTimes: 'true',
  }, environment)
  if (Array.isArray(payload) && payload.length >= FMP_EARNINGS_PAGE_LIMIT) {
    throw new Error('FMP earnings response reached the 4,000-row page limit; refusing a potentially truncated calendar')
  }
  return normalizeFmpEarningsCalendar(payload)
}

export async function fetchFmpCompanyProfile(
  ticker: string,
  environment: Environment = process.env,
): Promise<FmpCompanyClassification[]> {
  const normalized = normalizedTicker(ticker)
  if (!normalized) throw new Error('Invalid FMP profile ticker')
  const payload = await fetchFmpJson('profile', { symbol: normalized }, environment)
  return normalizeFmpCompanyProfile(payload)
}

export function isFmpDisplayLicenseApproved(environment: Environment = process.env): boolean {
  return environment.FMP_DISPLAY_LICENSE_APPROVED === '1'
}
