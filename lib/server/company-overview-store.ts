import { client } from '@/lib/db/client'
import {
  fromJQuantsCode,
  type JFinsSummaryRow,
  type JMarginAlertRow,
} from '@/lib/jquants'
import { upsertFinancialFoundationRows } from '@/lib/server/financial-foundation-store'

function numberOrNull(value: string | number | null | undefined): number | null {
  if (value === '' || value == null) return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function disclosureNo(row: JFinsSummaryRow): string {
  if (row.DiscNo) return row.DiscNo
  return [row.DiscDate, row.DiscTime, row.DocType, row.CurPerType, row.CurPerEn]
    .filter(Boolean)
    .join(':')
}

export async function upsertExternalDataStatus(
  ticker: string,
  dataset: string,
  status: string,
  sourceDate: string | null,
  message: string | null,
  attemptedAt = Math.floor(Date.now() / 1000),
) {
  await client.execute({
    sql: `
      INSERT INTO stock_external_data_status
        (ticker, dataset, status, source_date, message, attempted_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(ticker, dataset) DO UPDATE SET
        status = excluded.status,
        source_date = excluded.source_date,
        message = excluded.message,
        attempted_at = excluded.attempted_at
    `,
    args: [ticker, dataset, status, sourceDate, message, attemptedAt],
  })
}

export async function upsertFinancialSummaryRows(
  rows: JFinsSummaryRow[],
  importedAt = Math.floor(Date.now() / 1000),
): Promise<number> {
  // Keep the legacy summary table for existing readers, while the normalized
  // foundation preserves current/next forecasts and every disclosure snapshot.
  await upsertFinancialFoundationRows(rows, importedAt)
  let inserted = 0
  for (const row of rows) {
    if (!row.DiscDate || !row.Code) continue
    const ticker = fromJQuantsCode(row.Code)
    await client.execute({
      sql: `
        INSERT INTO stock_financial_summaries (
          ticker, disclosure_no, disclosure_date, disclosure_time, document_type,
          period_type, period_start, period_end, fiscal_year_end,
          sales, operating_profit, ordinary_profit, net_profit, eps,
          total_assets, equity, equity_ratio, bps,
          operating_cash_flow, investing_cash_flow, financing_cash_flow, cash_equivalents,
          annual_dividend, payout_ratio,
          forecast_sales, forecast_operating_profit, forecast_net_profit, forecast_eps,
          forecast_annual_dividend, source, imported_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'jquants', ?)
        ON CONFLICT(ticker, disclosure_no) DO UPDATE SET
          disclosure_date = excluded.disclosure_date,
          disclosure_time = excluded.disclosure_time,
          document_type = excluded.document_type,
          period_type = excluded.period_type,
          period_start = excluded.period_start,
          period_end = excluded.period_end,
          fiscal_year_end = excluded.fiscal_year_end,
          sales = excluded.sales,
          operating_profit = excluded.operating_profit,
          ordinary_profit = excluded.ordinary_profit,
          net_profit = excluded.net_profit,
          eps = excluded.eps,
          total_assets = excluded.total_assets,
          equity = excluded.equity,
          equity_ratio = excluded.equity_ratio,
          bps = excluded.bps,
          operating_cash_flow = excluded.operating_cash_flow,
          investing_cash_flow = excluded.investing_cash_flow,
          financing_cash_flow = excluded.financing_cash_flow,
          cash_equivalents = excluded.cash_equivalents,
          annual_dividend = excluded.annual_dividend,
          payout_ratio = excluded.payout_ratio,
          forecast_sales = excluded.forecast_sales,
          forecast_operating_profit = excluded.forecast_operating_profit,
          forecast_net_profit = excluded.forecast_net_profit,
          forecast_eps = excluded.forecast_eps,
          forecast_annual_dividend = excluded.forecast_annual_dividend,
          imported_at = excluded.imported_at
      `,
      args: [
        ticker,
        disclosureNo(row),
        row.DiscDate,
        row.DiscTime || null,
        row.DocType || null,
        row.CurPerType || null,
        row.CurPerSt || null,
        row.CurPerEn || null,
        row.CurFYEn || null,
        numberOrNull(row.Sales),
        numberOrNull(row.OP),
        numberOrNull(row.OdP),
        numberOrNull(row.NP),
        numberOrNull(row.EPS),
        numberOrNull(row.TA),
        numberOrNull(row.Eq),
        numberOrNull(row.EqAR),
        numberOrNull(row.BPS),
        numberOrNull(row.CFO),
        numberOrNull(row.CFI),
        numberOrNull(row.CFF),
        numberOrNull(row.CashEq),
        numberOrNull(row.DivAnn),
        numberOrNull(row.PayoutRatioAnn),
        numberOrNull(row.FSales),
        numberOrNull(row.FOP),
        numberOrNull(row.FNP),
        numberOrNull(row.FEPS),
        numberOrNull(row.FDivAnn),
        importedAt,
      ],
    })
    inserted++
  }
  return inserted
}

export async function upsertDailyMarginRows(
  rows: JMarginAlertRow[],
  importedAt = Math.floor(Date.now() / 1000),
): Promise<number> {
  let inserted = 0
  for (const row of rows) {
    if (!row.Code || !row.PubDate || !row.AppDate) continue
    const ticker = fromJQuantsCode(row.Code)
    await client.execute({
      sql: `
        INSERT INTO daily_margin_alerts (
          ticker, publication_date, application_date, publication_reason_json,
          short_outstanding, short_change, short_ratio,
          long_outstanding, long_change, long_ratio, short_long_ratio,
          short_negotiable, short_standardized, long_negotiable, long_standardized,
          regulation_class, source, imported_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'jquants', ?)
        ON CONFLICT(ticker, publication_date, application_date) DO UPDATE SET
          publication_reason_json = excluded.publication_reason_json,
          short_outstanding = excluded.short_outstanding,
          short_change = excluded.short_change,
          short_ratio = excluded.short_ratio,
          long_outstanding = excluded.long_outstanding,
          long_change = excluded.long_change,
          long_ratio = excluded.long_ratio,
          short_long_ratio = excluded.short_long_ratio,
          short_negotiable = excluded.short_negotiable,
          short_standardized = excluded.short_standardized,
          long_negotiable = excluded.long_negotiable,
          long_standardized = excluded.long_standardized,
          regulation_class = excluded.regulation_class,
          imported_at = excluded.imported_at
      `,
      args: [
        ticker,
        row.PubDate,
        row.AppDate,
        row.PubReason == null
          ? null
          : typeof row.PubReason === 'string' ? row.PubReason : JSON.stringify(row.PubReason),
        numberOrNull(row.ShrtOut),
        numberOrNull(row.ShrtOutChg),
        numberOrNull(row.ShrtOutRatio),
        numberOrNull(row.LongOut),
        numberOrNull(row.LongOutChg),
        numberOrNull(row.LongOutRatio),
        numberOrNull(row.SLRatio),
        numberOrNull(row.ShrtNegOut),
        numberOrNull(row.ShrtStdOut),
        numberOrNull(row.LongNegOut),
        numberOrNull(row.LongStdOut),
        row.TSEMrgnRegCls || null,
        importedAt,
      ],
    })
    inserted++
  }
  return inserted
}
