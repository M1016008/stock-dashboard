// lib/queries/dashboard.ts
//
// Phase 4 ダッシュボード用集計クエリ。
// すべての関数は Server Component 内で呼び出される (await; キャッシュは next の revalidate に任せる)。
// 重い集計が出てきたら結果テーブル化を検討。

import { execAll, execGet } from '@/lib/db/client'

// ─── 最新営業日 ───
export async function getLatestDate(): Promise<string | null> {
  const row = await execGet<{ d: string | null }>(`SELECT MAX(date) AS d FROM daily_snapshots`)
  return row?.d ?? null
}

// ─── 1 営業日前 (前日) ───
export async function getPrevDate(latest: string): Promise<string | null> {
  const row = await execGet<{ d: string | null }>(
    `SELECT MAX(date) AS d FROM daily_snapshots WHERE date < ?`,
    [latest],
  )
  return row?.d ?? null
}

// ─── 騰落数 (騰落レシオ計算用) ───
export interface AdvanceDeclineRow {
  advances: number
  declines: number
  unchanged: number
}
export async function getAdvanceDecline(): Promise<AdvanceDeclineRow | null> {
  const latest = await getLatestDate()
  if (!latest) return null
  const prev = await getPrevDate(latest)
  if (!prev) return null
  const row = await execGet<AdvanceDeclineRow>(
    `
    WITH t AS (SELECT ticker, close FROM ohlcv_daily WHERE date = ?),
         y AS (SELECT ticker, close FROM ohlcv_daily WHERE date = ?)
    SELECT
      SUM(CASE WHEN t.close > y.close THEN 1 ELSE 0 END) AS advances,
      SUM(CASE WHEN t.close < y.close THEN 1 ELSE 0 END) AS declines,
      SUM(CASE WHEN t.close = y.close THEN 1 ELSE 0 END) AS unchanged
    FROM t JOIN y USING (ticker)
    `,
    [latest, prev],
  )
  return row ?? null
}

// ─── ステージ分布 (各軸) ───
export interface StageCountRow { stage: number; count: number }
export async function getStageDistribution(axis: string): Promise<StageCountRow[]> {
  const latest = await getLatestDate()
  if (!latest) return []
  const allowed = new Set(['daily_a_stage', 'daily_b_stage', 'weekly_a_stage', 'weekly_b_stage', 'monthly_a_stage', 'monthly_b_stage'])
  if (!allowed.has(axis)) throw new Error(`bad axis: ${axis}`)
  return await execAll<StageCountRow>(
    `SELECT ${axis} AS stage, COUNT(*) AS count
     FROM daily_snapshots
     WHERE date = ? AND ${axis} IS NOT NULL
     GROUP BY ${axis}
     ORDER BY ${axis}`,
    [latest],
  )
}

// ─── 本日の遷移サマリー (前日と異なるステージにいる銘柄数 × 6 軸) ───
export interface TransitionCount {
  daily_a: number
  daily_b: number
  weekly_a: number
  weekly_b: number
  monthly_a: number
  monthly_b: number
}
export async function getTodayTransitionCounts(): Promise<TransitionCount | null> {
  const latest = await getLatestDate()
  if (!latest) return null
  const prev = await getPrevDate(latest)
  if (!prev) return null
  const row = await execGet<TransitionCount>(
    `
    WITH t AS (SELECT * FROM daily_snapshots WHERE date = ?),
         y AS (SELECT * FROM daily_snapshots WHERE date = ?)
    SELECT
      SUM(CASE WHEN t.daily_a_stage   != y.daily_a_stage   THEN 1 ELSE 0 END) AS daily_a,
      SUM(CASE WHEN t.daily_b_stage   != y.daily_b_stage   THEN 1 ELSE 0 END) AS daily_b,
      SUM(CASE WHEN t.weekly_a_stage  != y.weekly_a_stage  THEN 1 ELSE 0 END) AS weekly_a,
      SUM(CASE WHEN t.weekly_b_stage  != y.weekly_b_stage  THEN 1 ELSE 0 END) AS weekly_b,
      SUM(CASE WHEN t.monthly_a_stage != y.monthly_a_stage THEN 1 ELSE 0 END) AS monthly_a,
      SUM(CASE WHEN t.monthly_b_stage != y.monthly_b_stage THEN 1 ELSE 0 END) AS monthly_b
    FROM t JOIN y USING (ticker)
    `,
    [latest, prev],
  )
  return row ?? null
}

// ─── 立体的類似シグナル: 6 軸ステージで同じパターンに当てはまる銘柄 (n>=20) ───
export interface StereoscopicRow {
  ticker: string
  name: string | null
  patternCount: number
  p50_60d: number | null
}
export async function getStereoscopicSignals(limit = 6): Promise<StereoscopicRow[]> {
  const latest = await getLatestDate()
  if (!latest) return []
  return await execAll<StereoscopicRow>(
    `
    WITH today AS (
      SELECT ticker,
             daily_a_stage   || daily_b_stage   ||
             weekly_a_stage  || weekly_b_stage  ||
             monthly_a_stage || monthly_b_stage AS code
      FROM daily_snapshots
      WHERE date = ?
        AND daily_a_stage IS NOT NULL AND daily_b_stage IS NOT NULL
        AND weekly_a_stage IS NOT NULL AND weekly_b_stage IS NOT NULL
        AND monthly_a_stage IS NOT NULL AND monthly_b_stage IS NOT NULL
    ),
    joined AS (
      SELECT t.ticker, t.code, p.count, p.p50
      FROM today t
      JOIN pattern_stats p ON p.pattern_code = t.code AND p.horizon_days = 60
      WHERE p.count >= 20
    )
    SELECT
      j.ticker,
      tu.name,
      j.count AS patternCount,
      j.p50   AS p50_60d
    FROM joined j
    LEFT JOIN ticker_universe tu ON tu.ticker = j.ticker
    ORDER BY j.p50 DESC
    LIMIT ?
    `,
    [latest, limit],
  )
}

// ─── 新高値・新安値・出来高急増 ───
export interface NewHighVolumeRow {
  ticker: string
  name: string | null
  type: '新高値' | '新安値' | '量' | string
  changePct: number
}
export async function getNewHighVolume(limit = 6): Promise<NewHighVolumeRow[]> {
  const latest = await getLatestDate()
  if (!latest) return []
  const prev = await getPrevDate(latest)
  if (!prev) return []
  // 軽量版: 当日行 + 過去 252 営業日の MAX/MIN を別クエリで結合 (ROW_NUMBER を回避)
  return await execAll<NewHighVolumeRow>(
    `
    WITH today AS (
      SELECT ticker, close, high, low, volume FROM ohlcv_daily WHERE date = ?
    ),
    yest AS (
      SELECT ticker, close AS yc FROM ohlcv_daily WHERE date = ?
    ),
    hist AS (
      SELECT ticker, MAX(high) AS h252, MIN(low) AS l252, AVG(volume) AS avgVol
      FROM ohlcv_daily
      WHERE date BETWEEN date(?, '-1 year') AND date(?, '-1 day')
      GROUP BY ticker
    ),
    tagged AS (
      SELECT today.ticker, today.close, today.volume,
             yest.yc,
             CASE
               WHEN today.high >= hist.h252 THEN '新高値'
               WHEN today.low  <= hist.l252 THEN '新安値'
               WHEN hist.avgVol > 0 AND CAST(today.volume AS REAL)/hist.avgVol >= 2.0
                 THEN CAST(ROUND(CAST(today.volume AS REAL)/hist.avgVol, 1) AS TEXT) || 'x量'
             END AS type
      FROM today
      JOIN hist USING (ticker)
      JOIN yest USING (ticker)
    )
    SELECT
      t.ticker,
      tu.name,
      t.type,
      CASE WHEN t.yc > 0 THEN 100.0 * (t.close - t.yc) / t.yc ELSE 0 END AS changePct
    FROM tagged t
    LEFT JOIN ticker_universe tu ON tu.ticker = t.ticker
    WHERE t.type IS NOT NULL
    ORDER BY ABS(changePct) DESC
    LIMIT ?
    `,
    [latest, prev, latest, latest, limit],
  )
}

// ─── 33 業種ヒートマップ ───
export interface SectorHeatRow {
  sector_code: string | null
  sector_name: string
  n_stocks: number
  avg_change: number
}
export async function getSector33Heatmap(): Promise<SectorHeatRow[]> {
  const latest = await getLatestDate()
  if (!latest) return []
  const prev = await getPrevDate(latest)
  if (!prev) return []
  return await execAll<SectorHeatRow>(
    `
    WITH today AS (SELECT ticker, close FROM ohlcv_daily WHERE date = ?),
         yest AS (SELECT ticker, close FROM ohlcv_daily WHERE date = ?)
    SELECT
      tu.sector33_code AS sector_code,
      COALESCE(tu.sector33_name, 'その他') AS sector_name,
      COUNT(*) AS n_stocks,
      AVG(100.0 * (today.close - yest.close) / yest.close) AS avg_change
    FROM ticker_universe tu
    JOIN today USING (ticker)
    JOIN yest  USING (ticker)
    WHERE tu.active = 1 AND tu.sector33_name IS NOT NULL
    GROUP BY tu.sector33_code, tu.sector33_name
    ORDER BY avg_change DESC
    `,
    [latest, prev],
  )
}

// ─── パターン統計トップ/ボトム ───
export interface PatternRankRow {
  pattern_code: string
  count: number
  p50: number
  kind: 'top' | 'bottom'
}
export async function getPatternStatsTopBottom(): Promise<PatternRankRow[]> {
  const top = await execAll<PatternRankRow>(
    `SELECT pattern_code, count, p50, 'top' AS kind
     FROM pattern_stats
     WHERE horizon_days = 60 AND count >= 20
     ORDER BY p50 DESC LIMIT 3`,
  )
  const bottom = await execAll<PatternRankRow>(
    `SELECT pattern_code, count, p50, 'bottom' AS kind
     FROM pattern_stats
     WHERE horizon_days = 60 AND count >= 20
     ORDER BY p50 ASC LIMIT 2`,
  )
  return [...top, ...bottom]
}

// ─── 業績発表カレンダー (14 日先まで) ───
export interface EarningsRow {
  ticker: string
  name: string | null
  announce_date: string
  daysLeft: number
  daily_a_stage: number | null
  price: number | null
  changePct: number | null
  avgVolume20: number | null
}
export async function getEarningsCalendar(daysAhead = 14): Promise<EarningsRow[]> {
  const latest = await getLatestDate()
  if (!latest) return []
  const prev = await getPrevDate(latest)
  return await execAll<EarningsRow>(
    `
    WITH cal AS (
      SELECT ticker, announce_date,
             CAST(julianday(announce_date) - julianday(?) AS INTEGER) AS daysLeft
      FROM earnings_calendar
      WHERE announce_date BETWEEN ? AND date(?, '+' || ? || ' days')
    ),
    px AS (SELECT ticker, close FROM ohlcv_daily WHERE date = ?),
    py AS (SELECT ticker, close AS prev_close FROM ohlcv_daily WHERE date = ?),
    avgv AS (
      SELECT ticker, AVG(volume) AS avg20
      FROM (SELECT ticker, volume,
                   ROW_NUMBER() OVER (PARTITION BY ticker ORDER BY date DESC) AS rn
            FROM ohlcv_daily) z
      WHERE rn <= 20 GROUP BY ticker
    ),
    st AS (SELECT ticker, daily_a_stage FROM daily_snapshots WHERE date = ?)
    SELECT cal.ticker, tu.name, cal.announce_date, cal.daysLeft,
           st.daily_a_stage,
           px.close AS price,
           CASE WHEN py.prev_close > 0 THEN 100.0 * (px.close - py.prev_close) / py.prev_close ELSE 0 END AS changePct,
           avgv.avg20 AS avgVolume20
    FROM cal
    LEFT JOIN ticker_universe tu ON tu.ticker = cal.ticker
    LEFT JOIN px USING (ticker)
    LEFT JOIN py USING (ticker)
    LEFT JOIN avgv USING (ticker)
    LEFT JOIN st USING (ticker)
    ORDER BY cal.daysLeft ASC
    LIMIT 50
    `,
    [latest, latest, latest, daysAhead, latest, prev ?? latest, latest],
  )
}

// ─── 信用残・空売り注目 ───
export interface CreditShortRow {
  ticker: string
  name: string | null
  longMargin: number | null
  longChange: number | null
  shortRatio: number | null
}
export async function getCreditShortHighlights(limit = 4): Promise<CreditShortRow[]> {
  return await execAll<CreditShortRow>(
    `
    WITH latest_wmi AS (
      SELECT ticker, long_margin, long_change,
             ROW_NUMBER() OVER (PARTITION BY ticker ORDER BY date DESC) AS rn
      FROM weekly_margin_interest
    ),
    latest_ssp AS (
      SELECT ticker, MAX(short_ratio) AS short_ratio
      FROM short_selling_positions
      WHERE date >= date('now', '-30 days')
      GROUP BY ticker
    )
    SELECT w.ticker, tu.name,
           w.long_margin AS longMargin,
           w.long_change AS longChange,
           s.short_ratio AS shortRatio
    FROM latest_wmi w
    LEFT JOIN latest_ssp s USING (ticker)
    LEFT JOIN ticker_universe tu ON tu.ticker = w.ticker
    WHERE w.rn = 1 AND (w.long_margin IS NOT NULL OR s.short_ratio IS NOT NULL)
    ORDER BY ABS(COALESCE(w.long_change, 0)) DESC
    LIMIT ?
    `,
    [limit],
  )
}

// ─── 主要指数 (Yoshio さんの ohlcv_daily 内に "^N225" 等が無いのでフォールバック) ───
export interface IndexQuote {
  label: string
  ticker: string
  value: number | null
  changePct: number | null
}
export async function getDashboardIndices(): Promise<IndexQuote[]> {
  // ticker_universe には ETF/個別株しか入っていないので、騰落レシオは自前計算で対応。
  const ad = await getAdvanceDecline()
  const advRatio = ad && ad.declines > 0 ? (ad.advances / ad.declines) * 100 : null

  return [
    { label: '日経225',     ticker: '^N225',  value: null, changePct: null },
    { label: 'TOPIX',       ticker: '^TPX',   value: null, changePct: null },
    { label: 'グロース250', ticker: '1563',   value: null, changePct: null },
    { label: '騰落レシオ',  ticker: 'ADR',    value: advRatio, changePct: null },
    { label: 'ドル円',      ticker: 'USDJPY', value: null, changePct: null },
    { label: '10年JGB',     ticker: 'JGB10',  value: null, changePct: null },
  ]
}

// ─── ウォッチリスト (ローカルストレージ依存だが SSR では空の placeholder を返す) ───
export interface WatchlistRow {
  ticker: string
  name: string | null
  price: number | null
  changePct: number | null
  daily_a_stage: number | null
}
