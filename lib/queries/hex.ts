// lib/queries/hex.ts — Phase 4 HEX ページ用の集計クエリ

import { execAll, execGet } from '@/lib/db/client'

export type Timescale = 'daily_a' | 'daily_b' | 'weekly_a' | 'weekly_b' | 'monthly_a' | 'monthly_b'
export type Period = 'today' | 'week' | 'month'

const STAGE_COL: Record<Timescale, string> = {
  daily_a:   'daily_a_stage',
  daily_b:   'daily_b_stage',
  weekly_a:  'weekly_a_stage',
  weekly_b:  'weekly_b_stage',
  monthly_a: 'monthly_a_stage',
  monthly_b: 'monthly_b_stage',
}

function getCol(ts: Timescale): string {
  return STAGE_COL[ts]
}

// 期間レンジ: 本日=最新日, week=直近5営業日, month=直近20営業日
async function getDateRange(period: Period): Promise<[string, string] | null> {
  const latest = (await execGet<{ d: string | null }>(`SELECT MAX(date) AS d FROM daily_snapshots`))?.d
  if (!latest) return null
  if (period === 'today') return [latest, latest]
  if (period === 'week') {
    const wkBack = (await execGet<{ d: string | null }>(
      `SELECT date AS d FROM (SELECT DISTINCT date FROM daily_snapshots ORDER BY date DESC LIMIT 5) ORDER BY date ASC LIMIT 1`,
    ))?.d
    return wkBack ? [wkBack, latest] : [latest, latest]
  }
  // month
  const mBack = (await execGet<{ d: string | null }>(
    `SELECT date AS d FROM (SELECT DISTINCT date FROM daily_snapshots ORDER BY date DESC LIMIT 20) ORDER BY date ASC LIMIT 1`,
  ))?.d
  return mBack ? [mBack, latest] : [latest, latest]
}

// ─── 6 ステージごとの最新件数 + 先週比 ───
export interface StageCircleRow {
  stage: number
  count: number
  prev_count: number
  diff: number
}
export async function getStageCircle(ts: Timescale): Promise<StageCircleRow[]> {
  const col = getCol(ts)
  const latest = (await execGet<{ d: string | null }>(`SELECT MAX(date) AS d FROM daily_snapshots`))?.d
  if (!latest) return []
  // 先週基準 = 5 営業日前。なければ最古日。
  const prevDate = (await execGet<{ d: string | null }>(
    `SELECT date AS d FROM (SELECT DISTINCT date FROM daily_snapshots WHERE date < ? ORDER BY date DESC LIMIT 5) ORDER BY date ASC LIMIT 1`,
    [latest],
  ))?.d ?? latest
  return await execAll<StageCircleRow>(
    `
    WITH cur AS (
      SELECT ${col} AS stage, COUNT(*) AS count
      FROM daily_snapshots WHERE date = ? AND ${col} IS NOT NULL
      GROUP BY ${col}
    ),
    pre AS (
      SELECT ${col} AS stage, COUNT(*) AS count
      FROM daily_snapshots WHERE date = ? AND ${col} IS NOT NULL
      GROUP BY ${col}
    )
    SELECT
      s.stage,
      COALESCE(cur.count, 0) AS count,
      COALESCE(pre.count, 0) AS prev_count,
      COALESCE(cur.count, 0) - COALESCE(pre.count, 0) AS diff
    FROM (SELECT 1 AS stage UNION SELECT 2 UNION SELECT 3 UNION SELECT 4 UNION SELECT 5 UNION SELECT 6) s
    LEFT JOIN cur ON cur.stage = s.stage
    LEFT JOIN pre ON pre.stage = s.stage
    ORDER BY s.stage
    `,
    [latest, prevDate],
  )
}

// ─── 6×6 遷移マトリクス (期間内に発生した遷移数) ───
export interface TransitionCell { from_stage: number; to_stage: number; count: number }
export async function getTransitionMatrix(ts: Timescale, period: Period): Promise<TransitionCell[]> {
  const range = await getDateRange(period)
  if (!range) return []
  const [start, end] = range
  const col = getCol(ts)
  // 各ティッカーの期間内スナップショットを、その銘柄の直前スナップショットと比較する。
  // 任意の lookback 日数に依存しないため、休場・欠損・上場直後でも集計の意味がぶれにくい。
  return await execAll<TransitionCell>(
    `
    WITH cur AS (
      SELECT ticker, date, ${col} AS stage
      FROM daily_snapshots
      WHERE date BETWEEN ? AND ?
        AND ${col} IS NOT NULL
    ),
    paired AS (
      SELECT
        cur.ticker,
        cur.date,
        prev.${col} AS prev_stage,
        cur.stage
      FROM cur
      JOIN daily_snapshots prev
        ON prev.ticker = cur.ticker
       AND prev.date = (
         SELECT MAX(p.date)
         FROM daily_snapshots p
         WHERE p.ticker = cur.ticker
           AND p.date < cur.date
       )
       AND prev.${col} IS NOT NULL
    )
    SELECT prev_stage AS from_stage, stage AS to_stage, COUNT(*) AS count
    FROM paired
    WHERE prev_stage != stage
    GROUP BY from_stage, to_stage
    ORDER BY count DESC
    `,
    [start, end],
  )
}

// ─── 詳細テーブル: 期間内に遷移した銘柄 ───
export interface TransitionDetailRow {
  ticker: string
  name: string | null
  daily_a: number | null
  daily_b: number | null
  weekly_a: number | null
  weekly_b: number | null
  monthly_a: number | null
  monthly_b: number | null
  from_stage: number | null
  to_stage: number | null
  price: number | null
  changePct: number | null
  volume: number | null
  ma_5: number | null
  ma_25: number | null
  ma_75: number | null
  ma_300: number | null
  prev_ma_5: number | null
  prev_ma_25: number | null
  prev_ma_75: number | null
  prev_ma_300: number | null
  prev2_ma_5: number | null
  prev2_ma_25: number | null
  prev2_ma_75: number | null
  prev2_ma_300: number | null
  signal_codes: string | null
  ml_up_rank: number | null
  ml_down_rank: number | null
  ml_up_reason_json: string | null
  ml_down_reason_json: string | null
  ml_up_explanation_json: string | null
  ml_down_explanation_json: string | null
}
export async function getTransitionDetail(
  ts: Timescale,
  period: Period,
  limit = 30,
): Promise<TransitionDetailRow[]> {
  const range = await getDateRange(period)
  if (!range) return []
  const [start, end] = range
  const col = getCol(ts)

  // 期間内最後の遷移を 1 銘柄あたり 1 件抽出。
  return await execAll<TransitionDetailRow>(
    `
    WITH cur AS (
      SELECT ticker, date,
             daily_a_stage, daily_b_stage, weekly_a_stage, weekly_b_stage, monthly_a_stage, monthly_b_stage,
             ma_5, ma_25, ma_75, ma_300,
             ${col} AS stage
      FROM daily_snapshots
      WHERE date BETWEEN ? AND ?
        AND ${col} IS NOT NULL
    ),
    paired AS (
      SELECT
        cur.*,
        prev.${col} AS prev_stage,
        prev.ma_5 AS prev_ma_5,
        prev.ma_25 AS prev_ma_25,
        prev.ma_75 AS prev_ma_75,
        prev.ma_300 AS prev_ma_300,
        prev2.ma_5 AS prev2_ma_5,
        prev2.ma_25 AS prev2_ma_25,
        prev2.ma_75 AS prev2_ma_75,
        prev2.ma_300 AS prev2_ma_300
      FROM cur
      JOIN daily_snapshots prev
        ON prev.ticker = cur.ticker
       AND prev.date = (
         SELECT MAX(p.date)
         FROM daily_snapshots p
         WHERE p.ticker = cur.ticker
           AND p.date < cur.date
       )
       AND prev.${col} IS NOT NULL
      LEFT JOIN daily_snapshots prev2
        ON prev2.ticker = cur.ticker
       AND prev2.date = (
         SELECT MAX(p2.date)
         FROM daily_snapshots p2
         WHERE p2.ticker = cur.ticker
           AND p2.date < prev.date
       )
    ),
    trans AS (
      SELECT * FROM paired
      WHERE prev_stage != stage
    ),
    latest AS (
      SELECT ticker, MAX(date) AS d FROM trans GROUP BY ticker
    ),
    pick AS (
      SELECT t.* FROM trans t JOIN latest l ON l.ticker = t.ticker AND l.d = t.date
    ),
    px AS (
      SELECT ticker, close, volume FROM ohlcv_daily WHERE date = ?
    ),
    py AS (
      SELECT ticker, close AS prev_close FROM ohlcv_daily WHERE date = (
        SELECT MAX(date) FROM ohlcv_daily WHERE date < ?
      )
    ),
    ml_date AS (
      SELECT MAX(as_of_date) AS d FROM serving_ml_candidates WHERE as_of_date <= ?
    ),
    signal_date AS (
      SELECT MAX(date) AS d FROM serving_latest_signals WHERE date <= ?
    )
    SELECT
      pick.ticker,
      tu.name,
      pick.daily_a_stage   AS daily_a,
      pick.daily_b_stage   AS daily_b,
      pick.weekly_a_stage  AS weekly_a,
      pick.weekly_b_stage  AS weekly_b,
      pick.monthly_a_stage AS monthly_a,
      pick.monthly_b_stage AS monthly_b,
      pick.prev_stage      AS from_stage,
      pick.stage           AS to_stage,
      px.close             AS price,
      CASE WHEN py.prev_close > 0 THEN 100.0 * (px.close - py.prev_close) / py.prev_close END AS changePct,
      px.volume,
      pick.ma_5,
      pick.ma_25,
      pick.ma_75,
      pick.ma_300,
      pick.prev_ma_5,
      pick.prev_ma_25,
      pick.prev_ma_75,
      pick.prev_ma_300,
      pick.prev2_ma_5,
      pick.prev2_ma_25,
      pick.prev2_ma_75,
      pick.prev2_ma_300,
      sig.signal_codes,
      ml_up.rank AS ml_up_rank,
      ml_down.rank AS ml_down_rank,
      ml_up.reason_json AS ml_up_reason_json,
      ml_down.reason_json AS ml_down_reason_json,
      ml_up.explanation_json AS ml_up_explanation_json,
      ml_down.explanation_json AS ml_down_explanation_json
    FROM pick
    LEFT JOIN ticker_universe tu ON tu.ticker = pick.ticker
    LEFT JOIN px USING (ticker)
    LEFT JOIN py USING (ticker)
    LEFT JOIN serving_latest_signals sig
      ON sig.ticker = pick.ticker
     AND sig.date = (SELECT d FROM signal_date)
    LEFT JOIN serving_ml_candidates ml_up
      ON ml_up.ticker = pick.ticker
     AND ml_up.direction = 'up'
     AND ml_up.as_of_date = (SELECT d FROM ml_date)
    LEFT JOIN serving_ml_candidates ml_down
      ON ml_down.ticker = pick.ticker
     AND ml_down.direction = 'down'
     AND ml_down.as_of_date = (SELECT d FROM ml_date)
    ORDER BY pick.date DESC, ABS(pick.stage - pick.prev_stage) DESC
    LIMIT ?
    `,
    [start, end, end, end, end, end, limit],
  )
}
