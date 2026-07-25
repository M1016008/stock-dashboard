import { NextResponse } from 'next/server'
import { execAll, ensureReady } from '@/lib/db/client'
import { fetchJQuantsFinsSummary } from '@/lib/jquants'
import {
  upsertExternalDataStatus,
  upsertFinancialSummaryRows,
} from '@/lib/server/company-overview-store'

export const dynamic = 'force-dynamic'

function normalizeTicker(raw: string) {
  return decodeURIComponent(raw).replace(/\.T$/i, '')
}

type FinancialRow = {
  disclosureDate: string
  disclosureTime: string | null
  periodType: string | null
  periodStart: string | null
  periodEnd: string | null
  fiscalYearEnd: string | null
  sales: number | null
  operatingProfit: number | null
  ordinaryProfit: number | null
  netProfit: number | null
  eps: number | null
  totalAssets: number | null
  equity: number | null
  equityRatio: number | null
  bps: number | null
  operatingCashFlow: number | null
  investingCashFlow: number | null
  financingCashFlow: number | null
  cashEquivalents: number | null
  annualDividend: number | null
  payoutRatio: number | null
  forecastSales: number | null
  forecastOperatingProfit: number | null
  forecastNetProfit: number | null
  forecastEps: number | null
  forecastAnnualDividend: number | null
}

const FINANCIAL_SQL = `
  SELECT
    disclosure_date AS disclosureDate,
    disclosure_time AS disclosureTime,
    period_type AS periodType,
    period_start AS periodStart,
    period_end AS periodEnd,
    fiscal_year_end AS fiscalYearEnd,
    sales,
    operating_profit AS operatingProfit,
    ordinary_profit AS ordinaryProfit,
    net_profit AS netProfit,
    eps,
    total_assets AS totalAssets,
    equity,
    equity_ratio AS equityRatio,
    bps,
    operating_cash_flow AS operatingCashFlow,
    investing_cash_flow AS investingCashFlow,
    financing_cash_flow AS financingCashFlow,
    cash_equivalents AS cashEquivalents,
    annual_dividend AS annualDividend,
    payout_ratio AS payoutRatio,
    forecast_sales AS forecastSales,
    forecast_operating_profit AS forecastOperatingProfit,
    forecast_net_profit AS forecastNetProfit,
    forecast_eps AS forecastEps,
    forecast_annual_dividend AS forecastAnnualDividend
  FROM stock_financial_summaries
  WHERE ticker = ?
  ORDER BY disclosure_date DESC, disclosure_time DESC
  LIMIT 16
`

function shouldRetryStatus(status: {
  status: string
  attemptedAt: number
} | undefined): boolean {
  if (!status) return true
  if (status.status === 'ready') return false
  return status.attemptedAt < Math.floor(Date.now() / 1000) - 7 * 24 * 60 * 60
}

function comparablePrevious(rows: FinancialRow[]): FinancialRow | null {
  const latest = rows[0]
  if (!latest) return null
  return rows.find((row, index) => (
    index > 0
    && row.periodType === latest.periodType
    && row.periodEnd !== latest.periodEnd
  )) ?? null
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ ticker: string }> },
) {
  try {
    await ensureReady()
    const { ticker: rawTicker } = await params
    const ticker = normalizeTicker(rawTicker)

    const [initialFinancialRows, majorShareholders, policyHoldings, largeHoldingReports, statuses] = await Promise.all([
      execAll<FinancialRow>(FINANCIAL_SQL, [ticker]),
      execAll<{
        rank: number
        fiscalYearEnd: string | null
        holderName: string
        shares: number | null
        holdingRatio: number | null
        submittedAt: string | null
      }>(
        `
        SELECT rank, fiscal_year_end AS fiscalYearEnd, holder_name AS holderName,
               shares, holding_ratio AS holdingRatio, submitted_at AS submittedAt
        FROM major_shareholders
        WHERE ticker = ?
          AND document_id = (
            SELECT document_id FROM major_shareholders
            WHERE ticker = ?
            ORDER BY COALESCE(fiscal_year_end, '') DESC, COALESCE(submitted_at, '') DESC
            LIMIT 1
          )
        ORDER BY rank
        LIMIT 20
        `,
        [ticker, ticker],
      ),
      execAll<{
        rank: number
        fiscalYearEnd: string | null
        issuerName: string
        shares: number | null
        bookValue: number | null
        purpose: string | null
        quantitativeEffect: string | null
        holdingType: string | null
        submittedAt: string | null
      }>(
        `
        SELECT rank, fiscal_year_end AS fiscalYearEnd, issuer_name AS issuerName,
               shares, book_value AS bookValue, purpose,
               quantitative_effect AS quantitativeEffect, holding_type AS holdingType,
               submitted_at AS submittedAt
        FROM policy_holdings
        WHERE ticker = ?
          AND document_id = (
            SELECT document_id FROM policy_holdings
            WHERE ticker = ?
            ORDER BY COALESCE(fiscal_year_end, '') DESC, COALESCE(submitted_at, '') DESC
            LIMIT 1
          )
        ORDER BY COALESCE(book_value, 0) DESC, rank
        LIMIT 30
        `,
        [ticker, ticker],
      ),
      execAll<{
        documentId: string
        submittedAt: string | null
        reportDate: string | null
        holderName: string | null
        shares: number | null
        holdingRatio: number | null
        previousHoldingRatio: number | null
        purpose: string | null
        reportKind: string | null
      }>(
        `
        SELECT document_id AS documentId, submitted_at AS submittedAt,
               report_date AS reportDate, holder_name AS holderName, shares,
               holding_ratio AS holdingRatio, previous_holding_ratio AS previousHoldingRatio,
               purpose, report_kind AS reportKind
        FROM large_holding_reports
        WHERE ticker = ?
        ORDER BY COALESCE(submitted_at, report_date, '') DESC
        LIMIT 20
        `,
        [ticker],
      ),
      execAll<{
        dataset: string
        status: string
        sourceDate: string | null
        message: string | null
        attemptedAt: number
      }>(
        `
        SELECT dataset, status, source_date AS sourceDate, message, attempted_at AS attemptedAt
        FROM stock_external_data_status
        WHERE ticker = ?
        `,
        [ticker],
      ),
    ])
    let financialRows = initialFinancialRows
    const financialStatus = statuses.find((status) => status.dataset === 'financial_summary')
    if (financialRows.length === 0 && shouldRetryStatus(financialStatus)) {
      const attemptedAt = Math.floor(Date.now() / 1000)
      try {
        const rows = await fetchJQuantsFinsSummary(ticker)
        await upsertFinancialSummaryRows(rows, attemptedAt)
        const sourceDate = rows.map((row) => row.DiscDate).filter(Boolean).sort().at(-1) ?? null
        await upsertExternalDataStatus(
          ticker,
          'financial_summary',
          rows.length > 0 ? 'ready' : 'no_data',
          sourceDate,
          rows.length > 0 ? null : 'J-Quantsに財務サマリーがありません。',
          attemptedAt,
        )
        financialRows = await execAll<FinancialRow>(FINANCIAL_SQL, [ticker])
      } catch (error) {
        await upsertExternalDataStatus(
          ticker,
          'financial_summary',
          'failed',
          null,
          error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300),
          attemptedAt,
        )
      }
    }

    const latest = financialRows[0] ?? null
    return NextResponse.json({
      ticker,
      financial: {
        latest,
        previousComparable: comparablePrevious(financialRows),
        available: Boolean(latest),
      },
      shareholders: {
        major: majorShareholders,
        policy: policyHoldings,
        largeReports: largeHoldingReports,
        edinetConfigured: Boolean(process.env.EDINET_API_KEY),
      },
      statuses: Object.fromEntries(statuses.map((status) => [status.dataset, status])),
      sources: {
        financial: 'https://jpx-jquants.com/ja/spec/fins-summary',
        margin: 'https://jpx-jquants.com/ja/spec/mkt-margin-alert',
        shareholders: 'https://disclosure2.edinet-fsa.go.jp/',
      },
    })
  } catch (error) {
    return NextResponse.json(
      { error: 'Stock overview failed', message: (error as Error).message },
      { status: 500 },
    )
  }
}
