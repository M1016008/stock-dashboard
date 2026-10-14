// market_source_availability の読み書きと、US日次カバレッジSLAの集計。
// 分類ルール自体は lib/us-source-availability.ts の純粋関数が持つ。

import { execAll, execBatch, execGet } from '@/lib/db/client'
import {
  summarizeUsDailyCoverageSla,
  US_SOURCE_TIINGO,
  type UsDailyCoverageSla,
  type UsSourceAvailabilityRecord,
} from '@/lib/us-source-availability'
import { usInvestableSymbolSql } from '@/lib/us-symbol-quality'

const MARKET = 'US'
const UPSERT_CHUNK = 500

type AvailabilityRow = {
  market: string
  ticker: string
  source: string
  status: UsSourceAvailabilityRecord['status']
  statusReason: UsSourceAvailabilityRecord['statusReason']
  terminalEvidenceCount: number
  firstTerminalTargetDate: string | null
  lastTerminalTargetDate: string | null
  lastTerminalRunId: number | null
  lastObservationType: UsSourceAvailabilityRecord['lastObservationType']
  lastObservedTargetDate: string | null
  lastSuccessDataDate: string | null
  lastHttpStatus: number | null
  updatedAt: number
}

export async function loadUsSourceAvailability(
  source = US_SOURCE_TIINGO,
): Promise<Map<string, UsSourceAvailabilityRecord>> {
  const rows = await execAll<AvailabilityRow>(
    `SELECT
       market,
       ticker,
       source,
       status,
       status_reason AS statusReason,
       terminal_evidence_count AS terminalEvidenceCount,
       first_terminal_target_date AS firstTerminalTargetDate,
       last_terminal_target_date AS lastTerminalTargetDate,
       last_terminal_run_id AS lastTerminalRunId,
       last_observation_type AS lastObservationType,
       last_observed_target_date AS lastObservedTargetDate,
       last_success_data_date AS lastSuccessDataDate,
       last_http_status AS lastHttpStatus,
       updated_at AS updatedAt
     FROM market_source_availability
     WHERE market = ? AND source = ?`,
    [MARKET, source],
  )
  return new Map(rows.map((row) => [row.ticker, {
    ...row,
    terminalEvidenceCount: Number(row.terminalEvidenceCount ?? 0),
    lastTerminalRunId: row.lastTerminalRunId == null ? null : Number(row.lastTerminalRunId),
    lastHttpStatus: row.lastHttpStatus == null ? null : Number(row.lastHttpStatus),
    updatedAt: Number(row.updatedAt ?? 0),
  }]))
}

export async function upsertUsSourceAvailability(rows: readonly UsSourceAvailabilityRecord[]): Promise<void> {
  for (let i = 0; i < rows.length; i += UPSERT_CHUNK) {
    await execBatch(rows.slice(i, i + UPSERT_CHUNK).map((row) => ({
      sql: `INSERT INTO market_source_availability (
              market, ticker, source, status, status_reason, terminal_evidence_count,
              first_terminal_target_date, last_terminal_target_date, last_terminal_run_id,
              last_observation_type, last_observed_target_date, last_success_data_date,
              last_http_status, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(market, ticker, source) DO UPDATE SET
              status = excluded.status,
              status_reason = excluded.status_reason,
              terminal_evidence_count = excluded.terminal_evidence_count,
              first_terminal_target_date = excluded.first_terminal_target_date,
              last_terminal_target_date = excluded.last_terminal_target_date,
              last_terminal_run_id = excluded.last_terminal_run_id,
              last_observation_type = excluded.last_observation_type,
              last_observed_target_date = excluded.last_observed_target_date,
              last_success_data_date = excluded.last_success_data_date,
              last_http_status = excluded.last_http_status,
              updated_at = excluded.updated_at`,
      args: [
        row.market,
        row.ticker,
        row.source,
        row.status,
        row.statusReason,
        row.terminalEvidenceCount,
        row.firstTerminalTargetDate,
        row.lastTerminalTargetDate,
        row.lastTerminalRunId,
        row.lastObservationType,
        row.lastObservedTargetDate,
        row.lastSuccessDataDate,
        row.lastHttpStatus,
        row.updatedAt,
      ],
    })))
  }
}

/** Current active investable universe, matching the coverage SLA denominator. */
export async function loadUsActiveInvestableTickers(): Promise<Set<string>> {
  const rows = await execAll<{ ticker: string }>(
    `SELECT u.ticker
     FROM market_universe u INDEXED BY market_universe_market_active_idx
     WHERE u.market = ?
       AND u.active = 1
       AND ${usInvestableSymbolSql('u.ticker')}`,
    [MARKET],
  )
  return new Set(rows.map((row) => row.ticker))
}

/**
 * Raw and effective latest-date coverage against the current active investable universe.
 * PERMANENTLY_UNAVAILABLE is durable; PENDING/TEMPORARILY_UNAVAILABLE only classify a missing
 * ticker when they were observed for this exact target date. Everything else is unclassified.
 */
export async function loadUsDailyCoverageSla(
  date: string,
  source = US_SOURCE_TIINGO,
): Promise<UsDailyCoverageSla> {
  const row = await execGet<{
    rawUniverse: number
    covered: number | null
    permanentExcluded: number | null
    pending: number | null
    temporary: number | null
  }>(
    `SELECT
       COUNT(*) AS rawUniverse,
       SUM(CASE WHEN o.ticker IS NOT NULL THEN 1 ELSE 0 END) AS covered,
       SUM(CASE WHEN o.ticker IS NULL AND a.status = 'PERMANENTLY_UNAVAILABLE' THEN 1 ELSE 0 END) AS permanentExcluded,
       SUM(CASE WHEN o.ticker IS NULL AND a.status = 'PENDING' AND a.last_observed_target_date = ? THEN 1 ELSE 0 END) AS pending,
       SUM(CASE WHEN o.ticker IS NULL AND a.status = 'TEMPORARILY_UNAVAILABLE' AND a.last_observed_target_date = ? THEN 1 ELSE 0 END) AS temporary
     FROM market_universe u INDEXED BY market_universe_market_active_idx
     LEFT JOIN market_ohlcv_daily o INDEXED BY market_ohlcv_market_date_ticker_idx
       ON o.market = 'US' AND o.date = ? AND o.ticker = u.ticker
     LEFT JOIN market_source_availability a
       ON a.market = u.market AND a.ticker = u.ticker AND a.source = ?
     WHERE u.market = 'US'
       AND u.active = 1
       AND ${usInvestableSymbolSql('u.ticker')}`,
    [date, date, date, source],
  )
  return summarizeUsDailyCoverageSla(date, {
    rawUniverse: row?.rawUniverse,
    covered: row?.covered,
    permanentExcluded: row?.permanentExcluded,
    pending: row?.pending,
    temporary: row?.temporary,
  })
}
