import { execAll, execGet, execRun } from '@/lib/db/client'
import { fromJQuantsCode, type JFinsSummaryRow } from '@/lib/jquants'
import {
  rebuildFinancialFoundationForTicker,
  upsertFinancialFoundationRows,
  type FinancialFoundationRebuildResult,
  type FinancialFoundationWriteResult,
} from '@/lib/server/financial-foundation-store'

export type FinancialBackfillCheckpointType =
  | 'local_legacy'
  | 'jquants_date'
  | 'jquants_ticker'
  | 'ticker_finalize'

export interface FinancialBackfillCheckpoint {
  checkpointType: FinancialBackfillCheckpointType
  checkpointKey: string
  status: 'running' | 'complete' | 'no_data' | 'error'
  sourceRows: number
  persistedRows: number
  details: Record<string, unknown>
  errorMessage: string | null
}

interface LegacyFinancialRow {
  ticker: string
  disclosure_no: string
  disclosure_date: string
  disclosure_time: string | null
  document_type: string | null
  period_type: string | null
  period_start: string | null
  period_end: string | null
  fiscal_year_end: string | null
  sales: number | null
  operating_profit: number | null
  ordinary_profit: number | null
  net_profit: number | null
  eps: number | null
  total_assets: number | null
  equity: number | null
  equity_ratio: number | null
  bps: number | null
  operating_cash_flow: number | null
  investing_cash_flow: number | null
  financing_cash_flow: number | null
  cash_equivalents: number | null
  annual_dividend: number | null
  payout_ratio: number | null
  forecast_sales: number | null
  forecast_operating_profit: number | null
  forecast_net_profit: number | null
  forecast_eps: number | null
  forecast_annual_dividend: number | null
}

const LEGACY_BATCH_SIZE = 500

function sourceValue(value: number | null): string {
  return value == null ? '' : String(value)
}

function toJQuantsCode(ticker: string): string {
  return /^\d{4}$/.test(ticker) ? `${ticker}0` : ticker
}

function legacyRowToJQuants(row: LegacyFinancialRow): JFinsSummaryRow | null {
  if (!row.period_end || !row.fiscal_year_end) return null
  return {
    DiscDate: row.disclosure_date,
    DiscTime: row.disclosure_time ?? '',
    Code: toJQuantsCode(row.ticker),
    DiscNo: row.disclosure_no,
    DocType: row.document_type ?? '',
    CurPerType: row.period_type ?? '',
    CurPerSt: row.period_start ?? '',
    CurPerEn: row.period_end,
    CurFYSt: row.period_start ?? '',
    CurFYEn: row.fiscal_year_end,
    Sales: sourceValue(row.sales),
    OP: sourceValue(row.operating_profit),
    OdP: sourceValue(row.ordinary_profit),
    NP: sourceValue(row.net_profit),
    EPS: sourceValue(row.eps),
    DEPS: '',
    TA: sourceValue(row.total_assets),
    Eq: sourceValue(row.equity),
    EqAR: sourceValue(row.equity_ratio),
    BPS: sourceValue(row.bps),
    CFO: sourceValue(row.operating_cash_flow),
    CFI: sourceValue(row.investing_cash_flow),
    CFF: sourceValue(row.financing_cash_flow),
    CashEq: sourceValue(row.cash_equivalents),
    DivAnn: sourceValue(row.annual_dividend),
    PayoutRatioAnn: sourceValue(row.payout_ratio),
    FSales: sourceValue(row.forecast_sales),
    FOP: sourceValue(row.forecast_operating_profit),
    FNP: sourceValue(row.forecast_net_profit),
    FEPS: sourceValue(row.forecast_eps),
    FDivAnn: sourceValue(row.forecast_annual_dividend),
    ShOutFY: '',
    TrShFY: '',
    AvgSh: '',
  }
}

function persistedCount(result: FinancialFoundationWriteResult): number {
  return result.disclosures + result.facts + result.forecasts
}

function parseDetails(value: unknown): Record<string, unknown> {
  try {
    const parsed = JSON.parse(String(value ?? '{}')) as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {}
  } catch {
    return {}
  }
}

export async function getFinancialBackfillCheckpoint(
  checkpointType: FinancialBackfillCheckpointType,
  checkpointKey: string,
): Promise<FinancialBackfillCheckpoint | null> {
  const row = await execGet<Record<string, unknown>>(`
    SELECT checkpoint_type, checkpoint_key, status, source_rows, persisted_rows,
           details_json, error_message
    FROM financial_foundation_backfill_checkpoints
    WHERE checkpoint_type = ? AND checkpoint_key = ?
  `, [checkpointType, checkpointKey])
  if (!row) return null
  return {
    checkpointType: String(row.checkpoint_type) as FinancialBackfillCheckpointType,
    checkpointKey: String(row.checkpoint_key),
    status: String(row.status) as FinancialBackfillCheckpoint['status'],
    sourceRows: Number(row.source_rows),
    persistedRows: Number(row.persisted_rows),
    details: parseDetails(row.details_json),
    errorMessage: row.error_message == null ? null : String(row.error_message),
  }
}

export async function startFinancialBackfillCheckpoint(
  checkpointType: FinancialBackfillCheckpointType,
  checkpointKey: string,
): Promise<void> {
  const now = Math.floor(Date.now() / 1000)
  await execRun(`
    INSERT INTO financial_foundation_backfill_checkpoints (
      checkpoint_type, checkpoint_key, status, source_rows, persisted_rows,
      details_json, error_message, started_at, finished_at, updated_at
    ) VALUES (?, ?, 'running', 0, 0, '{}', NULL, ?, NULL, ?)
    ON CONFLICT(checkpoint_type, checkpoint_key) DO UPDATE SET
      status = 'running',
      error_message = NULL,
      started_at = excluded.started_at,
      finished_at = NULL,
      updated_at = excluded.updated_at
  `, [checkpointType, checkpointKey, now, now])
}

export async function finishFinancialBackfillCheckpoint(args: {
  checkpointType: FinancialBackfillCheckpointType
  checkpointKey: string
  status: 'complete' | 'no_data' | 'error'
  sourceRows?: number
  persistedRows?: number
  details?: Record<string, unknown>
  errorMessage?: string | null
}): Promise<void> {
  const now = Math.floor(Date.now() / 1000)
  await execRun(`
    INSERT INTO financial_foundation_backfill_checkpoints (
      checkpoint_type, checkpoint_key, status, source_rows, persisted_rows,
      details_json, error_message, started_at, finished_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(checkpoint_type, checkpoint_key) DO UPDATE SET
      status = excluded.status,
      source_rows = excluded.source_rows,
      persisted_rows = excluded.persisted_rows,
      details_json = excluded.details_json,
      error_message = excluded.error_message,
      finished_at = excluded.finished_at,
      updated_at = excluded.updated_at
  `, [
    args.checkpointType,
    args.checkpointKey,
    args.status,
    args.sourceRows ?? 0,
    args.persistedRows ?? 0,
    JSON.stringify(args.details ?? {}),
    args.errorMessage ?? null,
    now,
    now,
    now,
  ])
}

export async function loadActiveJapaneseTickers(): Promise<string[]> {
  const rows = await execAll<{ ticker: string }>(`
    SELECT ticker FROM ticker_universe
    WHERE active = 1
    ORDER BY ticker
  `)
  return rows.map((row) => row.ticker)
}

export async function loadKnownFinancialDisclosureDates(
  tickerFilter: string[] = [],
): Promise<string[]> {
  if (tickerFilter.length > 0) return []
  const rows = await execAll<{ disclosure_date: string }>(`
    SELECT DISTINCT e.announce_date AS disclosure_date
    FROM earnings_calendar e
    JOIN ticker_universe u ON u.ticker = e.ticker AND u.active = 1
    WHERE e.source = 'jquants_fins_summary'
      AND e.announce_date <= date('now', '+1 day')
    UNION
    SELECT DISTINCT s.disclosure_date
    FROM stock_financial_summaries s
    JOIN ticker_universe u ON u.ticker = s.ticker AND u.active = 1
    ORDER BY disclosure_date
  `)
  return rows.map((row) => row.disclosure_date)
}

export async function backfillLegacyFinancialSummaries(
  importedAt = Math.floor(Date.now() / 1000),
): Promise<{ sourceRows: number; persistedRows: number }> {
  const rows = await execAll<LegacyFinancialRow>(`
    SELECT ticker, disclosure_no, disclosure_date, disclosure_time, document_type,
           period_type, period_start, period_end, fiscal_year_end,
           sales, operating_profit, ordinary_profit, net_profit, eps,
           total_assets, equity, equity_ratio, bps,
           operating_cash_flow, investing_cash_flow, financing_cash_flow,
           cash_equivalents, annual_dividend, payout_ratio,
           forecast_sales, forecast_operating_profit, forecast_net_profit,
           forecast_eps, forecast_annual_dividend
    FROM stock_financial_summaries
    ORDER BY disclosure_date, ticker, disclosure_no
  `)
  let sourceRows = 0
  let persistedRows = 0
  for (let index = 0; index < rows.length; index += LEGACY_BATCH_SIZE) {
    const source = rows
      .slice(index, index + LEGACY_BATCH_SIZE)
      .map(legacyRowToJQuants)
      .filter((row): row is JFinsSummaryRow => row != null)
    if (source.length === 0) continue
    const result = await upsertFinancialFoundationRows(source, importedAt, {
      deferDerivedAndMetrics: true,
    })
    sourceRows += source.length
    persistedRows += persistedCount(result)
  }
  return { sourceRows, persistedRows }
}

export async function persistJQuantsBackfillRows(
  rows: JFinsSummaryRow[],
  activeTickers: ReadonlySet<string>,
  importedAt = Math.floor(Date.now() / 1000),
): Promise<{ sourceRows: number; targetRows: number; persistedRows: number }> {
  const targetRows = rows.filter((row) => activeTickers.has(fromJQuantsCode(row.Code)))
  if (targetRows.length === 0) {
    return { sourceRows: rows.length, targetRows: 0, persistedRows: 0 }
  }
  const result = await upsertFinancialFoundationRows(targetRows, importedAt, {
    deferDerivedAndMetrics: true,
  })
  return {
    sourceRows: rows.length,
    targetRows: targetRows.length,
    persistedRows: persistedCount(result),
  }
}

export async function countTickerFoundationRows(ticker: string): Promise<{
  facts: number
  sourceFacts: number
  forecasts: number
  metrics: number
  ltmFacts: number
}> {
  const row = await execGet<Record<string, unknown>>(`
    SELECT
      (SELECT COUNT(*) FROM normalized_financial_facts WHERE ticker = ?) AS facts,
      (SELECT COUNT(*) FROM normalized_financial_facts WHERE ticker = ? AND is_derived = 0) AS source_facts,
      (SELECT COUNT(*) FROM financial_forecast_snapshots WHERE ticker = ?) AS forecasts,
      (SELECT COUNT(*) FROM calculated_financial_metrics WHERE ticker = ?) AS metrics,
      (SELECT COUNT(*) FROM normalized_financial_facts WHERE ticker = ? AND accumulation_kind = 'LTM') AS ltm_facts
  `, [ticker, ticker, ticker, ticker, ticker])
  return {
    facts: Number(row?.facts ?? 0),
    sourceFacts: Number(row?.source_facts ?? 0),
    forecasts: Number(row?.forecasts ?? 0),
    metrics: Number(row?.metrics ?? 0),
    ltmFacts: Number(row?.ltm_facts ?? 0),
  }
}

export async function finalizeTickerFinancialFoundation(
  ticker: string,
  computedAt = Math.floor(Date.now() / 1000),
): Promise<FinancialFoundationRebuildResult | null> {
  const before = await countTickerFoundationRows(ticker)
  if (before.sourceFacts === 0) return null
  return rebuildFinancialFoundationForTicker(ticker, computedAt)
}
