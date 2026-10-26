import { execAll, execGet } from '@/lib/db/client'

export type NextUsEarnings = {
  ticker: string
  providerDate: string
  reportDate: string
  scheduledDate: string | null
  actualReportDate: string | null
  hour: 'bmo' | 'dmh' | 'amc' | null
  timeBucket: 'before_open' | 'market_hours' | 'after_close' | 'unknown'
  fiscalYear: number | null
  fiscalQuarter: number | null
  epsEstimate: number | null
  revenueEstimate: number | null
  scheduleStatus: UsEarningsScheduleStatus
  source: 'finnhub'
  importedAt: string
}

export function todayInNewYork(): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date())
  const value = (type: string) => parts.find((part) => part.type === type)?.value ?? ''
  return `${value('year')}-${value('month')}-${value('day')}`
}

export type UsEarningsTimeBucket = 'before_open' | 'market_hours' | 'after_close' | 'unknown'
export type UsEarningsScheduleStatus = 'reported' | 'provider_scheduled_unverified'

export function usEarningsScheduleStatus(
  epsActual: number | null,
  revenueActual: number | null,
): UsEarningsScheduleStatus {
  return epsActual != null || revenueActual != null ? 'reported' : 'provider_scheduled_unverified'
}

export type UsEarningsCalendarRow = {
  ticker: string
  name: string | null
  providerDate: string
  reportDate: string
  scheduledDate: string | null
  actualReportDate: string | null
  hour: 'bmo' | 'dmh' | 'amc' | null
  timeBucket: UsEarningsTimeBucket
  fiscalYear: number | null
  fiscalQuarter: number | null
  epsEstimate: number | null
  epsActual: number | null
  revenueEstimate: number | null
  revenueActual: number | null
  scheduleStatus: UsEarningsScheduleStatus
  source: 'finnhub'
  sourceUrl: string | null
  importedAt: string
}

export type UsEarningsCalendarResult = {
  rows: UsEarningsCalendarRow[]
  total: number
  from: string
  to: string
  coverage: {
    from: string | null
    to: string | null
    latestImportedAt: string | null
  }
  status: 'ok' | 'empty' | 'unavailable'
  message: string | null
}

export type UsEarningsCalendarInput = {
  from: string
  to: string
  query?: string | null
  timeBucket?: UsEarningsTimeBucket | null
  limit?: number
  offset?: number
}

export type UsEarningsCoverageRun = {
  fromDate: string | null
  toDate: string | null
  finishedAt: number | null
}

export type UsEarningsCoverageResult = {
  ok: boolean
  reason: 'ready' | 'no_successful_run' | 'range_uncovered' | 'stale'
}

export function isUsEarningsDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const parsed = new Date(`${value}T00:00:00Z`)
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value
}

export function addCalendarDays(date: string, days: number): string {
  const parsed = new Date(`${date}T12:00:00Z`)
  parsed.setUTCDate(parsed.getUTCDate() + days)
  return parsed.toISOString().slice(0, 10)
}

function isoFromEpoch(value: number | null | undefined): string | null {
  return typeof value === 'number' && Number.isFinite(value)
    ? new Date(value * 1000).toISOString()
    : null
}

function earningsMaxStalenessDays(): number {
  const configured = Number(process.env.FINNHUB_EARNINGS_MAX_STALENESS_DAYS ?? 7)
  return Number.isFinite(configured) ? Math.max(1, Math.min(30, Math.trunc(configured))) : 7
}

export function evaluateUsEarningsCoverage(
  run: UsEarningsCoverageRun | null | undefined,
  input: { from: string; to: string },
  nowEpochSeconds = Math.floor(Date.now() / 1000),
  maxStalenessDays = earningsMaxStalenessDays(),
): UsEarningsCoverageResult {
  if (!run?.fromDate || !run.toDate || run.finishedAt == null) {
    return { ok: false, reason: 'no_successful_run' }
  }
  if (run.fromDate > input.from || run.toDate < input.to) {
    return { ok: false, reason: 'range_uncovered' }
  }
  if (run.finishedAt < nowEpochSeconds - maxStalenessDays * 86_400) {
    return { ok: false, reason: 'stale' }
  }
  return { ok: true, reason: 'ready' }
}

async function loadUsEarningsCoverageRun(): Promise<UsEarningsCoverageRun | undefined> {
  return execGet<UsEarningsCoverageRun>(`
    SELECT
      json_extract(payload_json, '$.from') AS fromDate,
      json_extract(payload_json, '$.to') AS toDate,
      finished_at AS finishedAt
    FROM market_data_runs
    WHERE market = 'US' AND job_type = 'finnhub_earnings' AND status = 'success'
    ORDER BY id DESC LIMIT 1
  `)
}

export async function getUsEarningsCalendar(input: UsEarningsCalendarInput): Promise<UsEarningsCalendarResult> {
  if (!isUsEarningsDate(input.from) || !isUsEarningsDate(input.to) || input.from > input.to) {
    throw new Error('invalid_us_earnings_range')
  }
  const limit = Math.max(1, Math.min(500, Math.trunc(input.limit ?? 100)))
  const offset = Math.max(0, Math.trunc(input.offset ?? 0))
  const query = input.query?.trim().toUpperCase() ?? ''
  const bucket = input.timeBucket ?? null
  const where = [
    "e.market = 'US'",
    "e.source = 'finnhub'",
    'e.report_date >= ?',
    'e.report_date <= ?',
  ]
  const args: Array<string | number> = [input.from, input.to]
  if (query) {
    where.push('(e.ticker LIKE ? OR UPPER(COALESCE(u.name, \'\')) LIKE ?)')
    args.push(`%${query}%`, `%${query}%`)
  }
  if (bucket) {
    where.push("COALESCE(e.time_bucket, 'unknown') = ?")
    args.push(bucket)
  }

  try {
    const [rows, summary, coverage, coverageRun] = await Promise.all([
      execAll<{
        ticker: string
        name: string | null
        reportDate: string
        hour: 'bmo' | 'dmh' | 'amc' | null
        timeBucket: UsEarningsTimeBucket | null
        fiscalYear: number | null
        fiscalQuarter: number | null
        epsEstimate: number | null
        epsActual: number | null
        revenueEstimate: number | null
        revenueActual: number | null
        source: string
        sourceUrl: string | null
        importedAt: number
      }>(`
        SELECT e.ticker, u.name, e.report_date AS reportDate, e.hour,
          COALESCE(e.time_bucket, 'unknown') AS timeBucket,
          e.fiscal_year AS fiscalYear, e.fiscal_quarter AS fiscalQuarter,
          e.eps_estimate AS epsEstimate, e.eps_actual AS epsActual,
          e.revenue_estimate AS revenueEstimate, e.revenue_actual AS revenueActual,
          e.source, e.source_url AS sourceUrl, e.imported_at AS importedAt
        FROM market_earnings_calendar e
        LEFT JOIN market_universe u ON u.market = 'US' AND u.ticker = e.ticker
        WHERE ${where.join('\n          AND ')}
        ORDER BY e.report_date ASC, e.ticker ASC
        LIMIT ? OFFSET ?
      `, [...args, limit, offset]),
      execGet<{ total: number }>(`
        SELECT COUNT(*) AS total
        FROM market_earnings_calendar e
        LEFT JOIN market_universe u ON u.market = 'US' AND u.ticker = e.ticker
        WHERE ${where.join('\n          AND ')}
      `, args),
      execGet<{ fromDate: string | null; toDate: string | null; latestImportedAt: number | null }>(`
        SELECT MIN(report_date) AS fromDate, MAX(report_date) AS toDate,
          MAX(imported_at) AS latestImportedAt
        FROM market_earnings_calendar
        WHERE market = 'US' AND source = 'finnhub'
      `),
      loadUsEarningsCoverageRun(),
    ])

    const coverageStatus = evaluateUsEarningsCoverage(coverageRun, input)
    if (!coverageStatus.ok) {
      return {
        rows: [],
        total: 0,
        from: input.from,
        to: input.to,
        coverage: {
          from: coverageRun?.fromDate ?? coverage?.fromDate ?? null,
          to: coverageRun?.toDate ?? coverage?.toDate ?? null,
          latestImportedAt: isoFromEpoch(coverage?.latestImportedAt),
        },
        status: 'unavailable',
        message: `Finnhub決算予定の同期範囲または鮮度を確認できません（${coverageStatus.reason}）。空結果として扱いません。`,
      }
    }

    const normalized = rows.flatMap((row): UsEarningsCalendarRow[] => row.source === 'finnhub' ? [{
      ...row,
      providerDate: row.reportDate,
      source: 'finnhub',
      timeBucket: row.timeBucket ?? 'unknown',
      scheduleStatus: usEarningsScheduleStatus(row.epsActual, row.revenueActual),
      scheduledDate: usEarningsScheduleStatus(row.epsActual, row.revenueActual) === 'reported' ? null : row.reportDate,
      actualReportDate: usEarningsScheduleStatus(row.epsActual, row.revenueActual) === 'reported' ? row.reportDate : null,
      importedAt: isoFromEpoch(row.importedAt) ?? '',
    }] : [])
    const total = Number(summary?.total ?? 0)
    const hasCoverage = coverage?.fromDate != null && coverage.toDate != null
    return {
      rows: normalized,
      total,
      from: input.from,
      to: input.to,
      coverage: {
        from: coverage?.fromDate ?? null,
        to: coverage?.toDate ?? null,
        latestImportedAt: isoFromEpoch(coverage?.latestImportedAt),
      },
      status: normalized.length > 0 ? 'ok' : hasCoverage ? 'empty' : 'unavailable',
      message: normalized.length > 0
        ? null
        : hasCoverage
          ? '指定期間に該当する正式決算予定はありません。'
          : 'Finnhub決算予定は未同期です。推定日による補完は行いません。',
    }
  } catch {
    return {
      rows: [],
      total: 0,
      from: input.from,
      to: input.to,
      coverage: { from: null, to: null, latestImportedAt: null },
      status: 'unavailable',
      message: 'US決算カレンダーを読み取れません。価格・Stageデータでの代替は行いません。',
    }
  }
}

export async function getNextUsEarnings(ticker: string): Promise<NextUsEarnings | null> {
  const today = todayInNewYork()
  const coverageRun = await loadUsEarningsCoverageRun().catch(() => undefined)
  if (!evaluateUsEarningsCoverage(coverageRun, { from: today, to: today }).ok) return null
  const row = await execGet<{
    ticker: string
    reportDate: string
    hour: 'bmo' | 'dmh' | 'amc' | null
    timeBucket: 'before_open' | 'market_hours' | 'after_close' | 'unknown' | null
    fiscalYear: number | null
    fiscalQuarter: number | null
    epsEstimate: number | null
    revenueEstimate: number | null
    epsActual: number | null
    revenueActual: number | null
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
        eps_actual AS epsActual,
        revenue_actual AS revenueActual,
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
    [ticker.trim().toUpperCase(), today],
  ).catch(() => undefined)

  if (!row || row.source !== 'finnhub') return null
  const scheduleStatus = usEarningsScheduleStatus(row.epsActual, row.revenueActual)
  return {
    ticker: row.ticker,
    providerDate: row.reportDate,
    reportDate: row.reportDate,
    scheduledDate: scheduleStatus === 'reported' ? null : row.reportDate,
    actualReportDate: scheduleStatus === 'reported' ? row.reportDate : null,
    hour: row.hour,
    timeBucket: row.timeBucket ?? 'unknown',
    fiscalYear: row.fiscalYear,
    fiscalQuarter: row.fiscalQuarter,
    epsEstimate: row.epsEstimate,
    revenueEstimate: row.revenueEstimate,
    scheduleStatus,
    source: 'finnhub',
    importedAt: new Date(row.importedAt * 1000).toISOString(),
  }
}
