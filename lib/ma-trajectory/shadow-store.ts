import { createClient } from '@libsql/client'
import fs from 'node:fs'
import {
  MA_TRAJECTORY_FEATURE_VERSION,
  MA_TRAJECTORY_MODEL_VERSION,
  MA_TRAJECTORY_PERIODS,
  normalizeScenarioProbabilities,
  type MaTrajectoryHorizon,
  type MaTrajectoryMarket,
  type MaTrajectoryProjectionAvailable,
  type MaTrajectoryProjectionResponse,
} from '@/lib/ma-trajectory/core'
import { resolveMaTrajectoryShadowDbPath } from '@/lib/ma-trajectory/paths'

type PredictionRow = {
  payloadJson: string
  sourceDate: string
  modelVersion: string
  selectedMethod: string
  generatedAt: string
  promotionEligible: number
}

function normalizeTicker(ticker: string, market: MaTrajectoryMarket): string {
  const normalized = ticker.trim().toUpperCase()
  return market === 'JP' ? normalized.replace(/\.T$/i, '') : normalized.replace(/\s+/g, '')
}

function isMissingSchemaError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /no such table|SQLITE_CANTOPEN|cannot open/i.test(message)
}

function parsePayload(
  row: PredictionRow,
  market: MaTrajectoryMarket,
  ticker: string,
  horizon: MaTrajectoryHorizon,
): MaTrajectoryProjectionAvailable | null {
  try {
    const payload = JSON.parse(row.payloadJson) as Partial<MaTrajectoryProjectionAvailable>
    if (!payload || !Array.isArray(payload.scenarios) || payload.scenarios.length === 0) return null
    if (row.modelVersion !== MA_TRAJECTORY_MODEL_VERSION) return null
    if (payload.featureVersion !== MA_TRAJECTORY_FEATURE_VERSION) return null
    if (!payload.history || MA_TRAJECTORY_PERIODS.some((period) => !Array.isArray(payload.history?.[String(period)]))) {
      return null
    }
    if (payload.scenarios.some((scenario) => (
      !scenario.lines
      || MA_TRAJECTORY_PERIODS.some((period) => !Array.isArray(scenario.lines[String(period)]))
    ))) return null
    const scenarios = normalizeScenarioProbabilities(payload.scenarios)
      .map((scenario, index) => ({ ...scenario, rank: index + 1 }))
      .slice(0, 3)
    return {
      ok: true,
      available: true,
      market,
      ticker,
      asOfDate: String(payload.asOfDate ?? row.sourceDate),
      sourceDate: row.sourceDate,
      horizonSessions: horizon,
      modelVersion: row.modelVersion,
      featureVersion: MA_TRAJECTORY_FEATURE_VERSION,
      selectedMethod: row.selectedMethod as MaTrajectoryProjectionAvailable['selectedMethod'],
      generatedAt: row.generatedAt,
      periods: MA_TRAJECTORY_PERIODS,
      history: payload.history ?? {},
      scenarios,
      calibration: payload.calibration ?? { ece: null, intervalCoverage80: null, queryCount: 0 },
    }
  } catch {
    return null
  }
}

export async function readMaTrajectoryProjection(params: {
  market: MaTrajectoryMarket
  ticker: string
  horizon: MaTrajectoryHorizon
  asOfDate?: string | null
}): Promise<MaTrajectoryProjectionResponse> {
  const market = params.market
  const ticker = normalizeTicker(params.ticker, market)
  if (market === 'US' && process.env.MA_TRAJECTORY_US_ENABLED !== '1') {
    return { ok: true, available: false, market, ticker, horizonSessions: params.horizon, reason: 'unsupported_market' }
  }

  const dbPath = resolveMaTrajectoryShadowDbPath(market)
  if (!fs.existsSync(dbPath)) {
    return { ok: true, available: false, market, ticker, horizonSessions: params.horizon, reason: 'shadow_not_found' }
  }

  const client = createClient({ url: `file:${dbPath}` })
  try {
    await client.execute('PRAGMA query_only=ON')
    await client.execute('PRAGMA busy_timeout=5000')
    const dateClause = params.asOfDate ? 'AND p.as_of_date <= ?' : ''
    const args = params.asOfDate
      ? [market, ticker, params.horizon, MA_TRAJECTORY_MODEL_VERSION, MA_TRAJECTORY_FEATURE_VERSION, params.asOfDate]
      : [market, ticker, params.horizon, MA_TRAJECTORY_MODEL_VERSION, MA_TRAJECTORY_FEATURE_VERSION]
    const result = await client.execute({
      sql: `
        SELECT
          p.payload_json AS payloadJson,
          r.source_date AS sourceDate,
          r.model_version AS modelVersion,
          r.selected_method AS selectedMethod,
          p.generated_at AS generatedAt,
          r.promotion_eligible AS promotionEligible
        FROM ma_trajectory_predictions p
        INNER JOIN ma_trajectory_runs r ON r.id = p.run_id
        WHERE p.market = ?
          AND p.ticker = ?
          AND p.horizon_sessions = ?
          AND r.model_version = ?
          AND r.feature_version = ?
          ${dateClause}
        ORDER BY r.promotion_eligible DESC, p.as_of_date DESC, r.id DESC
        LIMIT 1
      `,
      args,
    })
    const raw = result.rows[0]
    if (!raw) {
      return { ok: true, available: false, market, ticker, horizonSessions: params.horizon, reason: 'prediction_not_found' }
    }
    const row: PredictionRow = {
      payloadJson: String(raw.payloadJson ?? ''),
      sourceDate: String(raw.sourceDate ?? ''),
      modelVersion: String(raw.modelVersion ?? ''),
      selectedMethod: String(raw.selectedMethod ?? 'weighted_distance'),
      generatedAt: String(raw.generatedAt ?? ''),
      promotionEligible: Number(raw.promotionEligible ?? 0),
    }
    if (row.promotionEligible !== 1 && process.env.MA_TRAJECTORY_ALLOW_UNPROMOTED !== '1') {
      return { ok: true, available: false, market, ticker, horizonSessions: params.horizon, reason: 'shadow_not_promoted' }
    }
    const payload = parsePayload(row, market, ticker, params.horizon)
    return payload ?? {
      ok: true,
      available: false,
      market,
      ticker,
      horizonSessions: params.horizon,
      reason: 'prediction_not_found',
    }
  } catch (error) {
    if (isMissingSchemaError(error)) {
      return { ok: true, available: false, market, ticker, horizonSessions: params.horizon, reason: 'shadow_not_found' }
    }
    throw error
  } finally {
    client.close()
  }
}
