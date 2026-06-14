// lib/queries/hex.ts — Phase 4 HEX ページ用の集計クエリ

import { execAll, execGet } from '@/lib/db/client'
import { type UniverseFilterValue, universeSqlCondition } from '@/lib/market-universe'

export type Timescale = 'daily_a' | 'daily_b' | 'weekly_a' | 'weekly_b' | 'monthly_a' | 'monthly_b'
export type Period = 'today' | 'week' | 'month' | 'to_latest'

export interface HexDateOption {
  date: string
  tickers?: number
}

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

export function getPhysicsHorizonForPeriod(period: Period): number {
  return period === 'month' || period === 'to_latest' ? 60 : 20
}

export async function getLatestHexDate(): Promise<string | null> {
  const row = await execGet<{ d: string | null }>(`SELECT MAX(date) AS d FROM daily_snapshots`)
  return row?.d ?? null
}

export async function resolveHexAsOfDate(requestedDate: string | null = null): Promise<string | null> {
  if (requestedDate && /^\d{4}-\d{2}-\d{2}$/.test(requestedDate)) {
    const row = await execGet<{ d: string | null }>(
      `SELECT MAX(date) AS d FROM daily_snapshots WHERE date <= ?`,
      [requestedDate],
    )
    if (row?.d) return row.d
  }
  return getLatestHexDate()
}

export async function getHexDateOptions(limit = 80, includeDate: string | null = null): Promise<HexDateOption[]> {
  const safeLimit = Math.max(1, Math.min(10000, Math.trunc(limit)))
  const rows = await execAll<HexDateOption>(
    `SELECT date, COUNT(DISTINCT ticker) AS tickers
     FROM daily_snapshots
     GROUP BY date
     ORDER BY date DESC
     LIMIT ?`,
    [safeLimit],
  )
  if (!includeDate || rows.some((row) => row.date === includeDate)) return rows
  const extra = await execGet<HexDateOption>(
    `SELECT date, COUNT(DISTINCT ticker) AS tickers
     FROM daily_snapshots
     WHERE date = ?
     GROUP BY date`,
    [includeDate],
  )
  return extra ? [extra, ...rows] : rows
}

// 期間レンジ: 本日=基準日, week=基準日までの直近5営業日, month=基準日までの直近20営業日
async function getDateRange(period: Period, asOfDate: string | null = null): Promise<[string, string] | null> {
  const targetDate = await resolveHexAsOfDate(asOfDate)
  if (!targetDate) return null
  if (period === 'to_latest') {
    const latest = await getLatestHexDate()
    return latest ? [targetDate, latest] : [targetDate, targetDate]
  }
  if (period === 'today') return [targetDate, targetDate]
  if (period === 'week') {
    const wkBack = (await execGet<{ d: string | null }>(
      `SELECT date AS d
       FROM (
         SELECT DISTINCT date
         FROM daily_snapshots
         WHERE date <= ?
         ORDER BY date DESC
         LIMIT 5
       )
       ORDER BY date ASC
       LIMIT 1`,
      [targetDate],
    ))?.d
    return wkBack ? [wkBack, targetDate] : [targetDate, targetDate]
  }
  // month
  const mBack = (await execGet<{ d: string | null }>(
    `SELECT date AS d
     FROM (
       SELECT DISTINCT date
       FROM daily_snapshots
       WHERE date <= ?
       ORDER BY date DESC
       LIMIT 20
     )
     ORDER BY date ASC
     LIMIT 1`,
    [targetDate],
  ))?.d
  return mBack ? [mBack, targetDate] : [targetDate, targetDate]
}

async function getSnapshotWindowStart(endDate: string, days: number): Promise<string> {
  const safeDays = Math.max(1, Math.min(30, Math.trunc(days)))
  const row = await execGet<{ d: string | null }>(
    `SELECT date AS d
     FROM (
       SELECT DISTINCT date
       FROM daily_snapshots
       WHERE date <= ?
       ORDER BY date DESC
       LIMIT ${safeDays}
     )
     ORDER BY date ASC
     LIMIT 1`,
    [endDate],
  )
  return row?.d ?? endDate
}

// ─── 6 ステージごとの最新件数 + 先週比 ───
export interface StageCircleRow {
  stage: number
  count: number
  prev_count: number
  diff: number
}
export async function getStageCircle(
  ts: Timescale,
  universeFilter: UniverseFilterValue = null,
  asOfDate: string | null = null,
): Promise<StageCircleRow[]> {
  const col = getCol(ts)
  const targetDate = await resolveHexAsOfDate(asOfDate)
  if (!targetDate) return []
  const universe = universeSqlCondition('ticker', universeFilter)
  // 比較基準 = 対象日から5営業日前。なければ対象日。
  const prevDate = (await execGet<{ d: string | null }>(
    `SELECT date AS d FROM (SELECT DISTINCT date FROM daily_snapshots WHERE date < ? ORDER BY date DESC LIMIT 5) ORDER BY date ASC LIMIT 1`,
    [targetDate],
  ))?.d ?? targetDate
  return await execAll<StageCircleRow>(
    `
    WITH cur_rows AS (
      SELECT stage FROM (
        SELECT
          ticker,
          ${col} AS stage,
          ROW_NUMBER() OVER (PARTITION BY ticker ORDER BY computed_at DESC) AS rn
        FROM daily_snapshots
        WHERE date = ?
          AND ${col} IS NOT NULL
          ${universe.sql ? `AND ${universe.sql}` : ''}
      )
      WHERE rn = 1
    ),
    pre_rows AS (
      SELECT stage FROM (
        SELECT
          ticker,
          ${col} AS stage,
          ROW_NUMBER() OVER (PARTITION BY ticker ORDER BY computed_at DESC) AS rn
        FROM daily_snapshots
        WHERE date = ?
          AND ${col} IS NOT NULL
          ${universe.sql ? `AND ${universe.sql}` : ''}
      )
      WHERE rn = 1
    ),
    cur AS (
      SELECT stage, COUNT(*) AS count
      FROM cur_rows
      GROUP BY stage
    ),
    pre AS (
      SELECT stage, COUNT(*) AS count
      FROM pre_rows
      GROUP BY stage
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
    [targetDate, ...universe.params, prevDate, ...universe.params],
  )
}

// ─── 6×6 遷移マトリクス (期間内に発生した遷移数) ───
export interface TransitionCell { from_stage: number; to_stage: number; count: number }
export async function getTransitionMatrix(
  ts: Timescale,
  period: Period,
  universeFilter: UniverseFilterValue = null,
  asOfDate: string | null = null,
): Promise<TransitionCell[]> {
  const range = await getDateRange(period, asOfDate)
  if (!range) return []
  const [start, end] = range
  const col = getCol(ts)
  const universe = universeSqlCondition('ticker', universeFilter)
  if (period === 'to_latest') {
    if (start >= end) return []
    return await execAll<TransitionCell>(
      `
      WITH dedup AS (
        SELECT ticker, date, stage FROM (
          SELECT
            ticker,
            date,
            ${col} AS stage,
            ROW_NUMBER() OVER (PARTITION BY ticker, date ORDER BY computed_at DESC) AS rn
          FROM daily_snapshots
          WHERE date IN (?, ?)
            AND ${col} IS NOT NULL
        )
        WHERE rn = 1
      ),
      start_rows AS (
        SELECT ticker, stage
        FROM dedup
        WHERE date = ?
          ${universe.sql ? `AND ${universe.sql}` : ''}
      ),
      end_rows AS (
        SELECT ticker, stage
        FROM dedup
        WHERE date = ?
      )
      SELECT start_rows.stage AS from_stage, end_rows.stage AS to_stage, COUNT(*) AS count
      FROM start_rows
      JOIN end_rows USING (ticker)
      WHERE start_rows.stage != end_rows.stage
      GROUP BY start_rows.stage, end_rows.stage
      ORDER BY count DESC
      `,
      [start, end, start, ...universe.params, end],
    )
  }
  const dedupStart = await getSnapshotWindowStart(end, period === 'month' ? 22 : period === 'week' ? 7 : 3)
  // 各ティッカーの期間内スナップショットを、その銘柄の直前スナップショットと比較する。
  // 任意の lookback 日数に依存しないため、休場・欠損・上場直後でも集計の意味がぶれにくい。
  return await execAll<TransitionCell>(
    `
    WITH dedup AS (
      SELECT ticker, date, stage FROM (
        SELECT
          ticker,
          date,
          ${col} AS stage,
          ROW_NUMBER() OVER (PARTITION BY ticker, date ORDER BY computed_at DESC) AS rn
        FROM daily_snapshots
        WHERE date BETWEEN ? AND ?
          AND ${col} IS NOT NULL
      )
      WHERE rn = 1
    ),
    cur AS (
      SELECT ticker, date, stage
      FROM dedup
      WHERE date BETWEEN ? AND ?
        ${universe.sql ? `AND ${universe.sql}` : ''}
    ),
    paired AS (
      SELECT
        cur.ticker,
        cur.date,
        prev.stage AS prev_stage,
        cur.stage
      FROM cur
      JOIN dedup prev
        ON prev.ticker = cur.ticker
       AND prev.date = (
         SELECT MAX(p.date)
         FROM dedup p
         WHERE p.ticker = cur.ticker
           AND p.date < cur.date
       )
    )
    SELECT prev_stage AS from_stage, stage AS to_stage, COUNT(*) AS count
    FROM paired
    WHERE prev_stage != stage
    GROUP BY from_stage, to_stage
    ORDER BY count DESC
    `,
    [dedupStart, end, start, end, ...universe.params],
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
  physics_horizon_days: number | null
  physics_up_rank: number | null
  physics_up_score: number | null
  physics_up_model: string | null
  physics_up_feature_json: string | null
  physics_up_reason_json: string | null
  physics_up_explanation_json: string | null
  physics_down_rank: number | null
  physics_down_score: number | null
  physics_down_model: string | null
  physics_down_feature_json: string | null
  physics_down_reason_json: string | null
  physics_down_explanation_json: string | null
  physics_wait_rank: number | null
  physics_wait_score: number | null
  physics_wait_model: string | null
  physics_wait_feature_json: string | null
  physics_wait_reason_json: string | null
  physics_wait_explanation_json: string | null
  objective_up_evaluation_date: string | null
  objective_up_sample_count: number | null
  objective_up_precision_at_20: number | null
  objective_up_precision_at_50: number | null
  objective_up_hit_rate: number | null
  objective_up_metrics_json: string | null
  objective_down_evaluation_date: string | null
  objective_down_sample_count: number | null
  objective_down_precision_at_20: number | null
  objective_down_precision_at_50: number | null
  objective_down_hit_rate: number | null
  objective_down_metrics_json: string | null
}
export async function getTransitionDetail(
  ts: Timescale,
  period: Period,
  universeFilter: UniverseFilterValue = null,
  limit = 30,
  asOfDate: string | null = null,
): Promise<TransitionDetailRow[]> {
  const range = await getDateRange(period, asOfDate)
  if (!range) return []
  const [start, end] = range
  const col = getCol(ts)
  const physicsHorizon = getPhysicsHorizonForPeriod(period)
  const universe = universeSqlCondition('ticker', universeFilter)

  if (period === 'to_latest') {
    if (start >= end) return []
    const prevEnd1 = (await execGet<{ d: string | null }>(
      `SELECT MAX(date) AS d FROM daily_snapshots WHERE date < ?`,
      [end],
    ))?.d ?? null
    const prevEnd2 = prevEnd1
      ? (await execGet<{ d: string | null }>(
        `SELECT MAX(date) AS d FROM daily_snapshots WHERE date < ?`,
        [prevEnd1],
      ))?.d ?? null
      : null

    return await execAll<TransitionDetailRow>(
      `
      WITH dedup AS (
        SELECT
          ticker, date,
          daily_a_stage, daily_b_stage, weekly_a_stage, weekly_b_stage, monthly_a_stage, monthly_b_stage,
          ma_5, ma_25, ma_75, ma_300,
          stage
        FROM (
          SELECT
            ticker, date,
            daily_a_stage, daily_b_stage, weekly_a_stage, weekly_b_stage, monthly_a_stage, monthly_b_stage,
            ma_5, ma_25, ma_75, ma_300,
            ${col} AS stage,
            ROW_NUMBER() OVER (PARTITION BY ticker, date ORDER BY computed_at DESC) AS rn
          FROM daily_snapshots
          WHERE date IN (?, ?, ?, ?)
            AND ${col} IS NOT NULL
        )
        WHERE rn = 1
      ),
      start_rows AS (
        SELECT ticker, stage AS start_stage
        FROM dedup
        WHERE date = ?
      ),
      cur AS (
        SELECT *
        FROM dedup
        WHERE date = ?
          ${universe.sql ? `AND ${universe.sql}` : ''}
      ),
      paired AS (
        SELECT
          cur.*,
          start_rows.start_stage AS prev_stage,
          prev.ma_5 AS prev_ma_5,
          prev.ma_25 AS prev_ma_25,
          prev.ma_75 AS prev_ma_75,
          prev.ma_300 AS prev_ma_300,
          prev2.ma_5 AS prev2_ma_5,
          prev2.ma_25 AS prev2_ma_25,
          prev2.ma_75 AS prev2_ma_75,
          prev2.ma_300 AS prev2_ma_300
        FROM cur
        JOIN start_rows ON start_rows.ticker = cur.ticker
        LEFT JOIN dedup prev
          ON prev.ticker = cur.ticker
         AND prev.date = ?
        LEFT JOIN dedup prev2
          ON prev2.ticker = cur.ticker
         AND prev2.date = ?
        WHERE start_rows.start_stage != cur.stage
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
      ),
      physics_date AS (
        SELECT MAX(as_of_date) AS d
        FROM serving_ml_physics_candidates
        WHERE as_of_date <= ?
          AND horizon_days = ?
      ),
      objective_up AS (
        SELECT evaluation_date, sample_count, precision_at_20, precision_at_50, hit_rate, metrics_json
        FROM ml_model_evaluations
        WHERE direction = 'up'
          AND horizon_days = ?
          AND model_type LIKE '%objective%holdout%'
          AND (model_type LIKE '%enhanced%' OR metrics_json LIKE '%"variant":"enhanced"%')
        ORDER BY
          CASE WHEN metrics_json LIKE '%"split":"test"%' THEN 0 ELSE 1 END ASC,
          evaluation_date DESC,
          created_at DESC
        LIMIT 1
      ),
      objective_down AS (
        SELECT evaluation_date, sample_count, precision_at_20, precision_at_50, hit_rate, metrics_json
        FROM ml_model_evaluations
        WHERE direction = 'down'
          AND horizon_days = ?
          AND model_type LIKE '%objective%holdout%'
          AND (model_type LIKE '%enhanced%' OR metrics_json LIKE '%"variant":"enhanced"%')
        ORDER BY
          CASE WHEN metrics_json LIKE '%"split":"test"%' THEN 0 ELSE 1 END ASC,
          evaluation_date DESC,
          created_at DESC
        LIMIT 1
      )
      SELECT
        paired.ticker,
        tu.name,
        paired.daily_a_stage   AS daily_a,
        paired.daily_b_stage   AS daily_b,
        paired.weekly_a_stage  AS weekly_a,
        paired.weekly_b_stage  AS weekly_b,
        paired.monthly_a_stage AS monthly_a,
        paired.monthly_b_stage AS monthly_b,
        paired.prev_stage      AS from_stage,
        paired.stage           AS to_stage,
        px.close               AS price,
        CASE WHEN py.prev_close > 0 THEN 100.0 * (px.close - py.prev_close) / py.prev_close END AS changePct,
        px.volume,
        paired.ma_5,
        paired.ma_25,
        paired.ma_75,
        paired.ma_300,
        paired.prev_ma_5,
        paired.prev_ma_25,
        paired.prev_ma_75,
        paired.prev_ma_300,
        paired.prev2_ma_5,
        paired.prev2_ma_25,
        paired.prev2_ma_75,
        paired.prev2_ma_300,
        sig.signal_codes,
        ml_up.rank AS ml_up_rank,
        ml_down.rank AS ml_down_rank,
        ml_up.reason_json AS ml_up_reason_json,
        ml_down.reason_json AS ml_down_reason_json,
        ml_up.explanation_json AS ml_up_explanation_json,
        ml_down.explanation_json AS ml_down_explanation_json,
        ? AS physics_horizon_days,
        p_up.rank AS physics_up_rank,
        p_up.candidate_score AS physics_up_score,
        p_up.model_name AS physics_up_model,
        p_up.feature_json AS physics_up_feature_json,
        p_up.reason_json AS physics_up_reason_json,
        p_up.explanation_json AS physics_up_explanation_json,
        p_down.rank AS physics_down_rank,
        p_down.candidate_score AS physics_down_score,
        p_down.model_name AS physics_down_model,
        p_down.feature_json AS physics_down_feature_json,
        p_down.reason_json AS physics_down_reason_json,
        p_down.explanation_json AS physics_down_explanation_json,
        p_wait.rank AS physics_wait_rank,
        p_wait.candidate_score AS physics_wait_score,
        p_wait.model_name AS physics_wait_model,
        p_wait.feature_json AS physics_wait_feature_json,
        p_wait.reason_json AS physics_wait_reason_json,
        p_wait.explanation_json AS physics_wait_explanation_json,
        (SELECT evaluation_date FROM objective_up) AS objective_up_evaluation_date,
        (SELECT sample_count FROM objective_up) AS objective_up_sample_count,
        (SELECT precision_at_20 FROM objective_up) AS objective_up_precision_at_20,
        (SELECT precision_at_50 FROM objective_up) AS objective_up_precision_at_50,
        (SELECT hit_rate FROM objective_up) AS objective_up_hit_rate,
        (SELECT metrics_json FROM objective_up) AS objective_up_metrics_json,
        (SELECT evaluation_date FROM objective_down) AS objective_down_evaluation_date,
        (SELECT sample_count FROM objective_down) AS objective_down_sample_count,
        (SELECT precision_at_20 FROM objective_down) AS objective_down_precision_at_20,
        (SELECT precision_at_50 FROM objective_down) AS objective_down_precision_at_50,
        (SELECT hit_rate FROM objective_down) AS objective_down_hit_rate,
        (SELECT metrics_json FROM objective_down) AS objective_down_metrics_json
      FROM paired
      LEFT JOIN ticker_universe tu ON tu.ticker = paired.ticker
      LEFT JOIN px USING (ticker)
      LEFT JOIN py USING (ticker)
      LEFT JOIN serving_latest_signals sig
        ON sig.ticker = paired.ticker
       AND sig.date = (SELECT d FROM signal_date)
      LEFT JOIN serving_ml_candidates ml_up
        ON ml_up.ticker = paired.ticker
       AND ml_up.direction = 'up'
       AND ml_up.as_of_date = (SELECT d FROM ml_date)
      LEFT JOIN serving_ml_candidates ml_down
        ON ml_down.ticker = paired.ticker
       AND ml_down.direction = 'down'
       AND ml_down.as_of_date = (SELECT d FROM ml_date)
      LEFT JOIN serving_ml_physics_candidates p_up
        ON p_up.ticker = paired.ticker
       AND p_up.direction = 'up'
       AND p_up.horizon_days = ?
       AND p_up.as_of_date = (SELECT d FROM physics_date)
      LEFT JOIN serving_ml_physics_candidates p_down
        ON p_down.ticker = paired.ticker
       AND p_down.direction = 'down'
       AND p_down.horizon_days = ?
       AND p_down.as_of_date = (SELECT d FROM physics_date)
      LEFT JOIN serving_ml_physics_candidates p_wait
        ON p_wait.ticker = paired.ticker
       AND p_wait.direction = 'wait'
       AND p_wait.horizon_days = ?
       AND p_wait.as_of_date = (SELECT d FROM physics_date)
      ORDER BY ABS(paired.stage - paired.prev_stage) DESC, paired.ticker ASC
      LIMIT ?
      `,
      [
        start,
        end,
        prevEnd1 ?? '',
        prevEnd2 ?? '',
        start,
        end,
        ...universe.params,
        prevEnd1 ?? '',
        prevEnd2 ?? '',
        end,
        end,
        end,
        end,
        end,
        physicsHorizon,
        physicsHorizon,
        physicsHorizon,
        physicsHorizon,
        physicsHorizon,
        physicsHorizon,
        physicsHorizon,
        limit,
      ],
    )
  }

  const dedupStart = await getSnapshotWindowStart(end, period === 'month' ? 22 : period === 'week' ? 7 : 3)

  // 期間内最後の遷移を 1 銘柄あたり 1 件抽出。
  return await execAll<TransitionDetailRow>(
    `
    WITH dedup AS (
      SELECT
        ticker, date,
        daily_a_stage, daily_b_stage, weekly_a_stage, weekly_b_stage, monthly_a_stage, monthly_b_stage,
        ma_5, ma_25, ma_75, ma_300,
        stage
      FROM (
        SELECT
          ticker, date,
          daily_a_stage, daily_b_stage, weekly_a_stage, weekly_b_stage, monthly_a_stage, monthly_b_stage,
          ma_5, ma_25, ma_75, ma_300,
          ${col} AS stage,
          ROW_NUMBER() OVER (PARTITION BY ticker, date ORDER BY computed_at DESC) AS rn
        FROM daily_snapshots
        WHERE date BETWEEN ? AND ?
          AND ${col} IS NOT NULL
      )
      WHERE rn = 1
    ),
    cur AS (
      SELECT ticker, date,
             daily_a_stage, daily_b_stage, weekly_a_stage, weekly_b_stage, monthly_a_stage, monthly_b_stage,
             ma_5, ma_25, ma_75, ma_300,
             stage
      FROM dedup
      WHERE date BETWEEN ? AND ?
        ${universe.sql ? `AND ${universe.sql}` : ''}
    ),
    paired AS (
      SELECT
        cur.*,
        prev.stage AS prev_stage,
        prev.ma_5 AS prev_ma_5,
        prev.ma_25 AS prev_ma_25,
        prev.ma_75 AS prev_ma_75,
        prev.ma_300 AS prev_ma_300,
        prev2.ma_5 AS prev2_ma_5,
        prev2.ma_25 AS prev2_ma_25,
        prev2.ma_75 AS prev2_ma_75,
        prev2.ma_300 AS prev2_ma_300
      FROM cur
      JOIN dedup prev
        ON prev.ticker = cur.ticker
       AND prev.date = (
         SELECT MAX(p.date)
         FROM dedup p
         WHERE p.ticker = cur.ticker
           AND p.date < cur.date
       )
      LEFT JOIN dedup prev2
        ON prev2.ticker = cur.ticker
       AND prev2.date = (
         SELECT MAX(p2.date)
         FROM dedup p2
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
    ),
    physics_date AS (
      SELECT MAX(as_of_date) AS d
      FROM serving_ml_physics_candidates
      WHERE as_of_date <= ?
        AND horizon_days = ?
    ),
    objective_up AS (
      SELECT evaluation_date, sample_count, precision_at_20, precision_at_50, hit_rate, metrics_json
      FROM ml_model_evaluations
      WHERE direction = 'up'
        AND horizon_days = ?
        AND model_type LIKE '%objective%holdout%'
        AND (model_type LIKE '%enhanced%' OR metrics_json LIKE '%"variant":"enhanced"%')
      ORDER BY
        CASE WHEN metrics_json LIKE '%"split":"test"%' THEN 0 ELSE 1 END ASC,
        evaluation_date DESC,
        created_at DESC
      LIMIT 1
    ),
    objective_down AS (
      SELECT evaluation_date, sample_count, precision_at_20, precision_at_50, hit_rate, metrics_json
      FROM ml_model_evaluations
      WHERE direction = 'down'
        AND horizon_days = ?
        AND model_type LIKE '%objective%holdout%'
        AND (model_type LIKE '%enhanced%' OR metrics_json LIKE '%"variant":"enhanced"%')
      ORDER BY
        CASE WHEN metrics_json LIKE '%"split":"test"%' THEN 0 ELSE 1 END ASC,
        evaluation_date DESC,
        created_at DESC
      LIMIT 1
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
      ml_down.explanation_json AS ml_down_explanation_json,
      ? AS physics_horizon_days,
      p_up.rank AS physics_up_rank,
      p_up.candidate_score AS physics_up_score,
      p_up.model_name AS physics_up_model,
      p_up.feature_json AS physics_up_feature_json,
      p_up.reason_json AS physics_up_reason_json,
      p_up.explanation_json AS physics_up_explanation_json,
      p_down.rank AS physics_down_rank,
      p_down.candidate_score AS physics_down_score,
      p_down.model_name AS physics_down_model,
      p_down.feature_json AS physics_down_feature_json,
      p_down.reason_json AS physics_down_reason_json,
      p_down.explanation_json AS physics_down_explanation_json,
      p_wait.rank AS physics_wait_rank,
      p_wait.candidate_score AS physics_wait_score,
      p_wait.model_name AS physics_wait_model,
      p_wait.feature_json AS physics_wait_feature_json,
      p_wait.reason_json AS physics_wait_reason_json,
      p_wait.explanation_json AS physics_wait_explanation_json,
      (SELECT evaluation_date FROM objective_up) AS objective_up_evaluation_date,
      (SELECT sample_count FROM objective_up) AS objective_up_sample_count,
      (SELECT precision_at_20 FROM objective_up) AS objective_up_precision_at_20,
      (SELECT precision_at_50 FROM objective_up) AS objective_up_precision_at_50,
      (SELECT hit_rate FROM objective_up) AS objective_up_hit_rate,
      (SELECT metrics_json FROM objective_up) AS objective_up_metrics_json,
      (SELECT evaluation_date FROM objective_down) AS objective_down_evaluation_date,
      (SELECT sample_count FROM objective_down) AS objective_down_sample_count,
      (SELECT precision_at_20 FROM objective_down) AS objective_down_precision_at_20,
      (SELECT precision_at_50 FROM objective_down) AS objective_down_precision_at_50,
      (SELECT hit_rate FROM objective_down) AS objective_down_hit_rate,
      (SELECT metrics_json FROM objective_down) AS objective_down_metrics_json
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
    LEFT JOIN serving_ml_physics_candidates p_up
      ON p_up.ticker = pick.ticker
     AND p_up.direction = 'up'
     AND p_up.horizon_days = ?
     AND p_up.as_of_date = (SELECT d FROM physics_date)
    LEFT JOIN serving_ml_physics_candidates p_down
      ON p_down.ticker = pick.ticker
     AND p_down.direction = 'down'
     AND p_down.horizon_days = ?
     AND p_down.as_of_date = (SELECT d FROM physics_date)
    LEFT JOIN serving_ml_physics_candidates p_wait
      ON p_wait.ticker = pick.ticker
     AND p_wait.direction = 'wait'
     AND p_wait.horizon_days = ?
     AND p_wait.as_of_date = (SELECT d FROM physics_date)
    ORDER BY pick.date DESC, ABS(pick.stage - pick.prev_stage) DESC
    LIMIT ?
    `,
    [
      dedupStart,
      end,
      start,
      end,
      ...universe.params,
      end,
      end,
      end,
      end,
      end,
      physicsHorizon,
      physicsHorizon,
      physicsHorizon,
      physicsHorizon,
      physicsHorizon,
      physicsHorizon,
      physicsHorizon,
      limit,
    ],
  )
}
