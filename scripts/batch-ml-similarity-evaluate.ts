// scripts/batch-ml-similarity-evaluate.ts
//
// 保存済みの類似候補が、その後1週/2週/3週でどう動いたかを集計する。

import { execAll, execBatch } from '@/lib/db/client'

type EvalRow = {
  as_of_date: string
  base_ticker: string
  similar_ticker: string
  similarity_score: number
  return_pct: number | null
  max_return_pct: number | null
  min_return_pct: number | null
  up_label: number
  down_label: number
}

const HORIZONS = (process.env.ML_SIMILARITY_EVAL_HORIZONS ?? '5,10,15')
  .split(',')
  .map((value) => Number(value.trim()))
  .filter((value) => Number.isFinite(value) && value > 0)
const SOURCE = 'serving_current_similars_v2'
const STRICT = process.env.ML_SIMILARITY_EVAL_STRICT === '1'

type SimilarityCoverage = {
  matureThrough: string | null
  latestLabelDate: string | null
  maturePairCount: number
}

function median(values: number[]): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid]
}

function round(value: number | null | undefined, digits = 4): number | null {
  if (value == null || !Number.isFinite(value)) return null
  const scale = 10 ** digits
  return Math.round(value * scale) / scale
}

async function evaluateHorizon(horizon: number) {
  const coverageRows = await execAll<SimilarityCoverage>(
    `
    WITH mature_session AS (
      SELECT MIN(date) AS matureThrough
      FROM (
        SELECT DISTINCT date
        FROM ohlcv_daily
        ORDER BY date DESC
        LIMIT ?
      )
    ),
    label_watermark AS (
      SELECT MAX(date) AS latestLabelDate
      FROM ml_short_labels l
      INNER JOIN ticker_universe u ON u.ticker = l.ticker AND u.active = 1
      WHERE l.horizon_days = ?
    )
    SELECT
      mature_session.matureThrough,
      label_watermark.latestLabelDate,
      COUNT(s.similar_ticker) AS maturePairCount
    FROM mature_session
    CROSS JOIN label_watermark
    LEFT JOIN serving_current_similars s
      ON mature_session.matureThrough IS NOT NULL
     AND s.as_of_date <= mature_session.matureThrough
    LEFT JOIN ticker_universe base_u ON base_u.ticker = s.base_ticker AND base_u.active = 1
    LEFT JOIN ticker_universe similar_u ON similar_u.ticker = s.similar_ticker AND similar_u.active = 1
    WHERE s.similar_ticker IS NULL OR (base_u.ticker IS NOT NULL AND similar_u.ticker IS NOT NULL)
    `,
    [horizon + 1, horizon],
  )
  const coverage = coverageRows[0] ?? {
    matureThrough: null,
    latestLabelDate: null,
    maturePairCount: 0,
  }
  const rows = await execAll<EvalRow>(
    `
    SELECT
      s.as_of_date,
      s.base_ticker,
      s.similar_ticker,
      s.similarity_score,
      l.return_pct,
      l.max_return_pct,
      l.min_return_pct,
      l.up_label,
      l.down_label
    FROM serving_current_similars s
    INNER JOIN ticker_universe base_u ON base_u.ticker = s.base_ticker AND base_u.active = 1
    INNER JOIN ticker_universe similar_u ON similar_u.ticker = s.similar_ticker AND similar_u.active = 1
    INNER JOIN ml_short_labels l
      ON l.ticker = s.similar_ticker
     AND l.date = s.as_of_date
     AND l.horizon_days = ?
    WHERE s.rank <= ?
    `,
    [horizon, Number(process.env.ML_SIMILARITY_EVAL_TOP_RANK ?? 5)],
  )
  if (STRICT && coverage.maturePairCount > 0) {
    if (!coverage.latestLabelDate || (coverage.matureThrough && coverage.latestLabelDate < coverage.matureThrough)) {
      throw new Error(
        `similarity labels stale for horizon=${horizon}: latest_label=${coverage.latestLabelDate ?? '-'}, mature_through=${coverage.matureThrough ?? '-'}, mature_pairs=${coverage.maturePairCount}`,
      )
    }
    if (rows.length === 0) {
      throw new Error(
        `similarity evaluation has no joined pairs for horizon=${horizon}: latest_label=${coverage.latestLabelDate}, mature_through=${coverage.matureThrough}, mature_pairs=${coverage.maturePairCount}`,
      )
    }
  }
  const groups = new Map<string, EvalRow[]>()
  for (const row of rows) {
    const current = groups.get(row.as_of_date) ?? []
    current.push(row)
    groups.set(row.as_of_date, current)
  }
  return Array.from(groups.entries()).map(([date, group]) => {
    const returns = group.map((row) => Number(row.return_pct)).filter(Number.isFinite)
    const drawdowns = group.map((row) => row.min_return_pct).filter((value): value is number => value != null && Number.isFinite(value))
    const upHits = group.filter((row) => row.up_label).length
    const downHits = group.filter((row) => row.down_label).length
    return {
      sql: `
        INSERT OR REPLACE INTO ml_similarity_evaluations
          (as_of_date, horizon_days, source, base_count, pair_count, up_rate, down_rate,
           median_return_pct, avg_return_pct, max_drawdown_pct, payload_json, computed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, unixepoch())
      `,
      args: [
        date,
        horizon,
        SOURCE,
        new Set(group.map((row) => row.base_ticker)).size,
        group.length,
        round(upHits / Math.max(1, group.length)),
        round(downHits / Math.max(1, group.length)),
        round(median(returns)),
        round(returns.reduce((sum, value) => sum + value, 0) / Math.max(1, returns.length)),
        round(drawdowns.length ? Math.min(...drawdowns) : null),
        JSON.stringify({
          source: SOURCE,
          universeScope: 'current_active',
          topRank: Number(process.env.ML_SIMILARITY_EVAL_TOP_RANK ?? 5),
          avgSimilarity: round(group.reduce((sum, row) => sum + Number(row.similarity_score ?? 0), 0) / Math.max(1, group.length)),
        }),
      ],
    }
  })
}

async function main() {
  const statements = []
  for (const horizon of HORIZONS) statements.push(...await evaluateHorizon(horizon))
  if (statements.length > 0) await execBatch(statements)
  console.log(`ml similarity evaluation complete: horizons=${HORIZONS.join('/')}, rows=${statements.length}, strict=${STRICT ? 'on' : 'off'}`)
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error)
    process.exit(1)
  })
