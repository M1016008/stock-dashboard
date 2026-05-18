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
      `SELECT date FROM (SELECT DISTINCT date FROM daily_snapshots ORDER BY date DESC LIMIT 5) ORDER BY date ASC LIMIT 1`,
    ))?.d
    return wkBack ? [wkBack, latest] : [latest, latest]
  }
  // month
  const mBack = (await execGet<{ d: string | null }>(
    `SELECT date FROM (SELECT DISTINCT date FROM daily_snapshots ORDER BY date DESC LIMIT 20) ORDER BY date ASC LIMIT 1`,
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
    `SELECT date FROM (SELECT DISTINCT date FROM daily_snapshots WHERE date < ? ORDER BY date DESC LIMIT 5) ORDER BY date ASC LIMIT 1`,
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
  // 各ティッカーの "前日→当日" 組合せを期間内に集計。
  return await execAll<TransitionCell>(
    `
    WITH ds AS (
      SELECT ticker, date, ${col} AS stage,
             LAG(${col}) OVER (PARTITION BY ticker ORDER BY date) AS prev_stage
      FROM daily_snapshots
      WHERE date BETWEEN date(?, '-10 days') AND ?
        AND ${col} IS NOT NULL
    )
    SELECT prev_stage AS from_stage, stage AS to_stage, COUNT(*) AS count
    FROM ds
    WHERE prev_stage IS NOT NULL
      AND prev_stage != stage
      AND date BETWEEN ? AND ?
    GROUP BY from_stage, to_stage
    ORDER BY count DESC
    `,
    [start, end, start, end],
  )
}

// ─── 期間ごとの遷移件数 (KPI) ───
export interface PeriodCountRow { label: string; count: number }
export async function getPeriodCountTrend(ts: Timescale): Promise<PeriodCountRow[]> {
  const out: PeriodCountRow[] = []
  for (const [label, period] of [['本日', 'today'], ['今週', 'week'], ['今月', 'month']] as const) {
    const cells = await getTransitionMatrix(ts, period)
    const total = cells.reduce((a, c) => a + c.count, 0)
    out.push({ label, count: total })
  }
  return out
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
    WITH ds AS (
      SELECT ticker, date,
             daily_a_stage, daily_b_stage, weekly_a_stage, weekly_b_stage, monthly_a_stage, monthly_b_stage,
             ${col} AS stage,
             LAG(${col}) OVER (PARTITION BY ticker ORDER BY date) AS prev_stage
      FROM daily_snapshots
      WHERE date BETWEEN date(?, '-10 days') AND ?
    ),
    trans AS (
      SELECT * FROM ds
      WHERE prev_stage IS NOT NULL AND prev_stage != stage
        AND date BETWEEN ? AND ?
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
      px.volume
    FROM pick
    LEFT JOIN ticker_universe tu ON tu.ticker = pick.ticker
    LEFT JOIN px USING (ticker)
    LEFT JOIN py USING (ticker)
    ORDER BY pick.date DESC, ABS(pick.stage - pick.prev_stage) DESC
    LIMIT ?
    `,
    [start, end, start, end, end, end, limit],
  )
}
