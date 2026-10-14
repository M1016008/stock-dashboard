import { execUsAnalyticsAll } from '@/lib/db/us-analytics'

export type UsMlPredictionOutcome = {
  returnPct: number | null
  maxReturnPct: number | null
  minReturnPct: number | null
  hitLabel: boolean
  missLabel: boolean
  payload: {
    source: 'ohlcv_daily_readonly'
    observedSessions: number
    endDate: string
    maxReturnDate: string
    minReturnDate: string
    daysToMax: number
    daysToMin: number
  }
}

export type UsMlPredictionHistoryRow = {
  asOfDate: string
  horizonDays: number
  direction: 'up' | 'down'
  ticker: string
  rank: number
  score: number
  modelName: string | null
  explanation: Record<string, unknown>
  outcome: UsMlPredictionOutcome | null
}

type PredictionRow = {
  asOfDate: string
  horizonDays: number
  direction: string
  ticker: string
  rank: number
  score: number
  modelName: string | null
  explanationJson: string
}

export type UsMlPredictionPrice = {
  date: string
  close: number
}

function parseJson(value: string | null | undefined): Record<string, unknown> {
  try {
    return value ? JSON.parse(value) as Record<string, unknown> : {}
  } catch {
    return {}
  }
}

function pct(value: number, base: number): number {
  return 100 * (value / base - 1)
}

export function endOfUsMarketDateEpoch(date: string): number {
  const [year, month, day] = date.split('-').map(Number)
  const midday = new Date(Date.UTC(year, month - 1, day, 12))
  const offsetPart = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    timeZoneName: 'longOffset',
  }).formatToParts(midday).find((part) => part.type === 'timeZoneName')?.value ?? 'GMT-05:00'
  const match = offsetPart.match(/^GMT([+-])(\d{2}):(\d{2})$/)
  const offsetMinutes = match
    ? (match[1] === '+' ? 1 : -1) * (Number(match[2]) * 60 + Number(match[3]))
    : -300
  const localEndAsUtc = Date.UTC(year, month - 1, day, 23, 59, 59, 999)
  return Math.floor((localEndAsUtc - offsetMinutes * 60_000) / 1000)
}

export function evaluateUsMlPredictionOutcome(
  prediction: Pick<UsMlPredictionHistoryRow, 'asOfDate' | 'direction' | 'horizonDays'>,
  prices: readonly UsMlPredictionPrice[],
): UsMlPredictionOutcome | null {
  const anchorIndex = prices.findIndex((row) => row.date === prediction.asOfDate)
  if (anchorIndex < 0) return null
  const anchor = prices[anchorIndex]
  if (!Number.isFinite(anchor.close) || anchor.close <= 0) return null
  const future = prices.slice(anchorIndex + 1, anchorIndex + 1 + prediction.horizonDays)
  if (future.length < prediction.horizonDays) return null

  let maxIndex = 0
  let minIndex = 0
  for (let index = 1; index < future.length; index += 1) {
    if (future[index].close > future[maxIndex].close) maxIndex = index
    if (future[index].close < future[minIndex].close) minIndex = index
  }
  const end = future[future.length - 1]
  const returnPct = pct(end.close, anchor.close)
  const maxReturnPct = pct(future[maxIndex].close, anchor.close)
  const minReturnPct = pct(future[minIndex].close, anchor.close)
  const hitLabel = prediction.direction === 'up'
    ? maxReturnPct >= 10
    : minReturnPct <= -5
  const missLabel = prediction.direction === 'up'
    ? minReturnPct <= -5
    : maxReturnPct >= 10

  return {
    returnPct,
    maxReturnPct,
    minReturnPct,
    hitLabel,
    missLabel,
    payload: {
      source: 'ohlcv_daily_readonly',
      observedSessions: future.length,
      endDate: end.date,
      maxReturnDate: future[maxIndex].date,
      minReturnDate: future[minIndex].date,
      daysToMax: maxIndex + 1,
      daysToMin: minIndex + 1,
    },
  }
}

export async function getUsMlPredictionHistory(params: {
  ticker: string
  limit?: number
  date?: string | null
}): Promise<{ ticker: string; source: string; rows: UsMlPredictionHistoryRow[] }> {
  const ticker = params.ticker.trim().toUpperCase()
  const limit = Math.min(300, Math.max(1, params.limit ?? 80))
  const cutoffEpoch = params.date ? endOfUsMarketDateEpoch(params.date) : null
  const predictions = await execUsAnalyticsAll<PredictionRow>(
    `
      SELECT
        p.as_of_date AS asOfDate,
        p.horizon_days AS horizonDays,
        p.direction,
        p.ticker,
        p.rank,
        p.score,
        p.model_name AS modelName,
        p.explanation_json AS explanationJson
      FROM ml_predictions p
      LEFT JOIN ml_models m ON m.model_name = p.model_name
      WHERE p.ticker = ?
        ${params.date ? 'AND p.as_of_date <= ?' : ''}
        ${params.date ? 'AND p.created_at <= ?' : ''}
        ${params.date ? 'AND (p.model_name IS NULL OR (m.model_name IS NOT NULL AND m.trained_at <= ?))' : ''}
      ORDER BY p.as_of_date DESC, p.horizon_days ASC, p.direction ASC
      LIMIT ?
    `,
    params.date
      ? [ticker, params.date, cutoffEpoch!, cutoffEpoch!, limit]
      : [ticker, limit],
  )
  if (predictions.length === 0) {
    return { ticker, source: 'us_analytics.ml_predictions+ohlcv_daily', rows: [] }
  }

  const earliestDate = predictions.reduce(
    (earliest, row) => row.asOfDate < earliest ? row.asOfDate : earliest,
    predictions[0].asOfDate,
  )
  const prices = await execUsAnalyticsAll<UsMlPredictionPrice>(
    `
      SELECT date, close
      FROM ohlcv_daily
      WHERE ticker = ?
        AND date >= ?
        ${params.date ? 'AND date <= ?' : ''}
      ORDER BY date ASC
    `,
    params.date ? [ticker, earliestDate, params.date] : [ticker, earliestDate],
  )

  const rows = predictions.map<UsMlPredictionHistoryRow>((row) => {
    const prediction = {
      asOfDate: row.asOfDate,
      horizonDays: Number(row.horizonDays),
      direction: row.direction === 'down' ? 'down' as const : 'up' as const,
      ticker: row.ticker,
      rank: Number(row.rank),
      score: Number(row.score),
      modelName: row.modelName,
      explanation: parseJson(row.explanationJson),
      outcome: null,
    }
    return {
      ...prediction,
      outcome: evaluateUsMlPredictionOutcome(prediction, prices),
    }
  })
  return { ticker, source: 'us_analytics.ml_predictions+ohlcv_daily', rows }
}
