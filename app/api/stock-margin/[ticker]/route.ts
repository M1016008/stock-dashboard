import { NextResponse } from 'next/server'
import { execAll, execGet, ensureReady } from '@/lib/db/client'
import { fetchJQuantsMarginAlert } from '@/lib/jquants'
import {
  upsertDailyMarginRows,
  upsertExternalDataStatus,
} from '@/lib/server/company-overview-store'

export const dynamic = 'force-dynamic'

function normalizeTicker(raw: string) {
  return decodeURIComponent(raw).replace(/\.T$/i, '')
}

function parsePublicationReasons(raw: string | null): string[] {
  if (!raw) return []
  const labels: Record<string, string> = {
    Restricted: '規制',
    DailyPublication: '日々公表',
    Monitoring: '監視',
    RestrictedByJSF: '日証金規制',
    PrecautionByJSF: '日証金注意喚起',
    UnclearOrSecOnAlert: '不明確・注意銘柄',
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, string>
    return Object.entries(parsed)
      .filter(([, value]) => value === '1')
      .map(([key]) => labels[key] ?? key)
  } catch {
    return [raw]
  }
}

type DailyMarginRow = {
  publicationDate: string
  applicationDate: string
  publicationReasonJson: string | null
  shortOutstanding: number | null
  shortChange: number | null
  shortRatio: number | null
  longOutstanding: number | null
  longChange: number | null
  longRatio: number | null
  shortLongRatio: number | null
  regulationClass: string | null
}

const DAILY_MARGIN_SQL = `
  SELECT
    publication_date AS publicationDate,
    application_date AS applicationDate,
    publication_reason_json AS publicationReasonJson,
    short_outstanding AS shortOutstanding,
    short_change AS shortChange,
    short_ratio AS shortRatio,
    long_outstanding AS longOutstanding,
    long_change AS longChange,
    long_ratio AS longRatio,
    short_long_ratio AS shortLongRatio,
    regulation_class AS regulationClass
  FROM daily_margin_alerts
  WHERE ticker = ?
  ORDER BY application_date DESC, publication_date DESC
  LIMIT 8
`

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ ticker: string }> },
) {
  try {
    await ensureReady()
    const { ticker: rawTicker } = await params
    const ticker = normalizeTicker(rawTicker)
    const latest = await execGet<{
      ticker: string
      marginType: string | null
      asOfDate: string | null
      longMargin: number | null
      shortMargin: number | null
      longChange: number | null
      shortChange: number | null
      creditRatio: number | null
      shortRatio: number | null
    }>(
      `
      SELECT
        COALESCE(sml.ticker, tu.ticker) AS ticker,
        COALESCE(tu.margin_type, sml.margin_type) AS marginType,
        sml.as_of_date AS asOfDate,
        sml.long_margin AS longMargin,
        sml.short_margin AS shortMargin,
        sml.long_change AS longChange,
        sml.short_change AS shortChange,
        sml.credit_ratio AS creditRatio,
        sml.short_ratio AS shortRatio
      FROM ticker_universe tu
      LEFT JOIN serving_margin_latest sml ON sml.ticker = tu.ticker
      WHERE tu.ticker = ?
      UNION ALL
      SELECT
        sml.ticker,
        sml.margin_type AS marginType,
        sml.as_of_date AS asOfDate,
        sml.long_margin AS longMargin,
        sml.short_margin AS shortMargin,
        sml.long_change AS longChange,
        sml.short_change AS shortChange,
        sml.credit_ratio AS creditRatio,
        sml.short_ratio AS shortRatio
      FROM serving_margin_latest sml
      WHERE sml.ticker = ?
      LIMIT 1
      `,
      [ticker, ticker],
    )

    const history = await execAll<{
      date: string
      longMargin: number | null
      shortMargin: number | null
      longChange: number | null
      shortChange: number | null
    }>(
      `
      SELECT
        date,
        long_margin AS longMargin,
        short_margin AS shortMargin,
        long_change AS longChange,
        short_change AS shortChange
      FROM weekly_margin_interest
      WHERE ticker = ?
      ORDER BY date DESC
      LIMIT 8
      `,
      [ticker],
    )

    let dailyHistory = await execAll<DailyMarginRow>(DAILY_MARGIN_SQL, [ticker])
    if (dailyHistory.length === 0) {
      const status = await execGet<{ status: string; attemptedAt: number }>(
        `
        SELECT status, attempted_at AS attemptedAt
        FROM stock_external_data_status
        WHERE ticker = ? AND dataset = 'daily_margin'
        `,
        [ticker],
      )
      const shouldRetry = !status
        || (
          status.status !== 'ready'
          && status.attemptedAt < Math.floor(Date.now() / 1000) - 7 * 24 * 60 * 60
        )
      if (shouldRetry) {
        const attemptedAt = Math.floor(Date.now() / 1000)
        try {
          const rows = await fetchJQuantsMarginAlert({ ticker })
          await upsertDailyMarginRows(rows, attemptedAt)
          await upsertExternalDataStatus(
            ticker,
            'daily_margin',
            rows.length > 0 ? 'ready' : 'no_data',
            rows.map((row) => row.AppDate).filter(Boolean).sort().at(-1) ?? null,
            rows.length > 0 ? null : '日々公表銘柄の対象データはありません。',
            attemptedAt,
          )
          dailyHistory = await execAll<DailyMarginRow>(DAILY_MARGIN_SQL, [ticker])
        } catch (error) {
          await upsertExternalDataStatus(
            ticker,
            'daily_margin',
            'failed',
            null,
            error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300),
            attemptedAt,
          )
        }
      }
    }
    const daily = dailyHistory.map(({ publicationReasonJson, ...row }) => ({
      ...row,
      publicationReasons: parsePublicationReasons(publicationReasonJson),
    }))

    return NextResponse.json({
      latest: latest ?? null,
      history,
      dailyLatest: daily[0] ?? null,
      dailyHistory: daily,
      dailyStatus: daily.length > 0 ? 'ready' : 'not_applicable_or_no_data',
      source: 'jquants',
    })
  } catch (error) {
    return NextResponse.json(
      { error: 'Stock margin failed', message: (error as Error).message },
      { status: 500 },
    )
  }
}
