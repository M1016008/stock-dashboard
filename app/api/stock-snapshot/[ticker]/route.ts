// app/api/stock-snapshot/[ticker]/route.ts
// 個別銘柄の最新スナップショット情報（決算日など）を返す。

import { NextResponse } from 'next/server'
import { execGet } from '@/lib/db/client'

export const dynamic = 'force-dynamic'

interface Row {
  date: string
  ticker: string
  name: string
  earnings_last_date: string | null
  earnings_next_date: string | null
}

interface ServingMetricRow {
  as_of_date: string
  payload_json: string
}

interface EarningsCalendarRow {
  announce_date: string | null
  fiscal_period: string | null
  source: string | null
  source_url: string | null
}

interface TickerProfile {
  name: string | null
  market_segment: string | null
  sector17_name: string | null
  sector33_name: string | null
}

interface ResolvedNextEarnings {
  date: string | null
  fiscalPeriod: string | null
  source: string | null
}

function parseJson(value: string): Record<string, unknown> {
  try {
    return JSON.parse(value) as Record<string, unknown>
  } catch {
    return {}
  }
}

async function getLatestPriceDate(ticker: string): Promise<string | null> {
  const latest = await execGet<{ date: string | null }>(
    `SELECT MAX(date) AS date FROM ohlcv_daily WHERE ticker = ?`,
    [ticker],
  )
  return latest?.date ?? null
}

async function getTickerProfile(ticker: string): Promise<TickerProfile | null> {
  const profile = await execGet<TickerProfile>(
    `SELECT name, market_segment, sector17_name, sector33_name
     FROM ticker_universe
     WHERE ticker = ?`,
    [ticker],
  )
  return profile ?? null
}

async function getEarningsAround(ticker: string, referenceDate: string | null) {
  const previous = await execGet<EarningsCalendarRow>(
    `SELECT announce_date, fiscal_period, source, source_url
     FROM earnings_calendar
     WHERE ticker = ?
       AND announce_date <= COALESCE(?, date('now'))
     ORDER BY announce_date DESC
     LIMIT 1`,
    [ticker, referenceDate],
  )
  const next = await execGet<EarningsCalendarRow>(
    `SELECT announce_date, fiscal_period, source, source_url
     FROM earnings_calendar
     WHERE ticker = ?
       AND announce_date > COALESCE(?, date('now'))
     ORDER BY announce_date ASC
     LIMIT 1`,
    [ticker, referenceDate],
  )
  return { previous, next }
}

function resolveNextEarnings(
  next: EarningsCalendarRow | undefined,
  fallbackNextDate: string | null | undefined,
  fallbackSource: string | null,
  previousDate: string | null,
  referenceDate: string | null,
  allowEstimate: boolean,
): ResolvedNextEarnings {
  if (next?.announce_date) {
    return {
      date: next.announce_date,
      fiscalPeriod: next.fiscal_period,
      source: next.source,
    }
  }

  if (fallbackNextDate) {
    return {
      date: fallbackNextDate,
      fiscalPeriod: null,
      source: fallbackSource,
    }
  }

  if (!allowEstimate) {
    return {
      date: null,
      fiscalPeriod: null,
      source: null,
    }
  }

  const estimated = estimateNextQuarterlyDate(previousDate, referenceDate ?? todayIsoJst())
  if (estimated) {
    return {
      date: estimated,
      fiscalPeriod: null,
      source: 'estimated_from_previous_earnings',
    }
  }

  return {
    date: null,
    fiscalPeriod: null,
    source: null,
  }
}

function estimateNextQuarterlyDate(lastKnownDate: string | null, referenceDate: string): string | null {
  if (!lastKnownDate || !/^\d{4}-\d{2}-\d{2}$/.test(lastKnownDate)) return null
  let candidate = lastKnownDate
  for (let i = 0; i < 8; i++) {
    candidate = nextWeekday(addMonthsClamped(candidate, 3))
    if (candidate > referenceDate) return candidate
  }
  return null
}

function addMonthsClamped(dateStr: string, months: number): string {
  const [year, month, day] = dateStr.split('-').map(Number)
  const targetMonthIndex = month - 1 + months
  const targetYear = year + Math.floor(targetMonthIndex / 12)
  const targetMonth = ((targetMonthIndex % 12) + 12) % 12
  const lastDay = new Date(Date.UTC(targetYear, targetMonth + 1, 0)).getUTCDate()
  const clampedDay = Math.min(day, lastDay)
  return `${targetYear}-${String(targetMonth + 1).padStart(2, '0')}-${String(clampedDay).padStart(2, '0')}`
}

function nextWeekday(dateStr: string): string {
  let time = Date.parse(`${dateStr}T00:00:00.000Z`)
  if (!Number.isFinite(time)) return dateStr
  for (let i = 0; i < 3; i++) {
    const day = new Date(time).getUTCDay()
    if (day >= 1 && day <= 5) {
      const d = new Date(time)
      return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`
    }
    time += 86400000
  }
  return dateStr
}

function todayIsoJst(): string {
  const now = new Date()
  const jst = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Tokyo' }))
  return [
    jst.getFullYear(),
    String(jst.getMonth() + 1).padStart(2, '0'),
    String(jst.getDate()).padStart(2, '0'),
  ].join('-')
}

function isFundLikeProfile(profile: TickerProfile | null, fallbackName?: string | null): boolean {
  const text = [
    fallbackName,
    profile?.name,
    profile?.market_segment,
    profile?.sector17_name,
    profile?.sector33_name,
  ].filter(Boolean).join(' ').toLowerCase()
  return (
    profile?.market_segment === 'その他' ||
    text.includes('etf') ||
    text.includes('ｅｔｆ') ||
    text.includes('上場投信') ||
    text.includes('投資法人') ||
    text.includes('reit') ||
    text.includes('リート') ||
    text.includes('優先株式')
  )
}

export async function GET(
  _request: Request,
  context: { params: Promise<{ ticker: string }> },
) {
  const { ticker: rawTicker } = await context.params
  const ticker = decodeURIComponent(rawTicker)
  const latestPriceDate = await getLatestPriceDate(ticker)
  const profile = await getTickerProfile(ticker)

  const serving = await execGet<ServingMetricRow>(
    `SELECT as_of_date, payload_json FROM serving_stock_metrics WHERE ticker = ?`,
    [ticker],
  )
  if (serving) {
    const payload = parseJson(serving.payload_json)
    const earnings = payload.earnings as { previousDate?: string | null; nextDate?: string | null } | undefined
    const referenceDate = latestPriceDate ?? serving.as_of_date
    const calendar = await getEarningsAround(ticker, referenceDate)
    const name = typeof payload.name === 'string' ? payload.name : profile?.name ?? undefined
    const previousDate = calendar.previous?.announce_date ?? earnings?.previousDate ?? null
    const nextEarnings = resolveNextEarnings(
      calendar.next,
      earnings?.nextDate ?? null,
      earnings?.nextDate ? 'serving_stock_metrics' : null,
      previousDate,
      referenceDate,
      !isFundLikeProfile(profile, name),
    )
    return NextResponse.json({
      ticker,
      name,
      date: referenceDate,
      earningsLastDate: previousDate,
      earningsLastFiscalPeriod: calendar.previous?.fiscal_period ?? null,
      earningsLastSource: calendar.previous?.source ?? null,
      earningsNextDate: nextEarnings.date,
      earningsNextFiscalPeriod: nextEarnings.fiscalPeriod,
      earningsNextSource: nextEarnings.source,
      source: nextEarnings.date || calendar.previous?.announce_date
        ? 'earnings_calendar'
        : 'serving_stock_metrics',
    })
  }

  const row = await execGet<Row>(
    `SELECT date, ticker, name, earnings_last_date, earnings_next_date
     FROM tv_daily_snapshots
     WHERE ticker = ?
     ORDER BY date DESC
     LIMIT 1`,
    [ticker],
  )

  if (!row) {
    const calendar = await getEarningsAround(ticker, latestPriceDate)
    const previousDate = calendar.previous?.announce_date ?? null
    const nextEarnings = resolveNextEarnings(
      calendar.next,
      null,
      null,
      previousDate,
      latestPriceDate,
      !isFundLikeProfile(profile),
    )
    return NextResponse.json({
      ticker,
      date: latestPriceDate,
      earningsLastDate: previousDate,
      earningsLastFiscalPeriod: calendar.previous?.fiscal_period ?? null,
      earningsLastSource: calendar.previous?.source ?? null,
      earningsNextDate: nextEarnings.date,
      earningsNextFiscalPeriod: nextEarnings.fiscalPeriod,
      earningsNextSource: nextEarnings.source,
      source: 'earnings_calendar',
    })
  }

  const referenceDate = latestPriceDate ?? row.date
  const calendar = await getEarningsAround(ticker, referenceDate)
  const previousDate = calendar.previous?.announce_date ?? row.earnings_last_date
  const nextEarnings = resolveNextEarnings(
    calendar.next,
    row.earnings_next_date,
    row.earnings_next_date ? 'tv_daily_snapshots' : null,
    previousDate,
    referenceDate,
    !isFundLikeProfile(profile, row.name),
  )

  return NextResponse.json({
    ticker: row.ticker,
    name: row.name,
    date: referenceDate,
    earningsLastDate: previousDate,
    earningsLastFiscalPeriod: calendar.previous?.fiscal_period ?? null,
    earningsLastSource: calendar.previous?.source ?? null,
    earningsNextDate: nextEarnings.date,
    earningsNextFiscalPeriod: nextEarnings.fiscalPeriod,
    earningsNextSource: nextEarnings.source,
    source: nextEarnings.date || calendar.previous?.announce_date
      ? 'earnings_calendar'
      : 'tv_daily_snapshots',
  })
}
