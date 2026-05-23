// lib/queries/dashboard.ts
//
// Phase 4 ダッシュボード用集計クエリ。
// すべての関数は Server Component 内で呼び出される (await; キャッシュは next の revalidate に任せる)。
// 重い集計が出てきたら結果テーブル化を検討。

import { execAll, execGet } from '@/lib/db/client'
import {
  attachEarningsSignalDecorations,
  loadEarningsSignalDecorations,
  type EarningsSignalDecoration,
} from '@/lib/signals/earnings-labels'

// ─── 最新営業日 ───
export async function getLatestDate(): Promise<string | null> {
  const row = await execGet<{ d: string | null }>(`SELECT MAX(date) AS d FROM daily_snapshots`)
  return row?.d ?? null
}

export async function resolveTradingDate(date?: string | null): Promise<string | null> {
  if (!date) return getLatestDate()
  const row = await execGet<{ d: string | null }>(
    `SELECT date AS d FROM daily_snapshots WHERE date = ? LIMIT 1`,
    [date],
  )
  return row?.d ?? await getLatestDate()
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
export async function getStageDistribution(axis: string, date?: string | null): Promise<StageCountRow[]> {
  const latest = await resolveTradingDate(date)
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
export async function getTodayTransitionCounts(date?: string | null): Promise<TransitionCount | null> {
  const latest = await resolveTradingDate(date)
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
  sectorName: string | null
  sector17Name: string | null
  sector33Name: string | null
  marketSegment: string | null
  marginType: string | null
  marginAsOfDate: string | null
  longMargin: number | null
  shortMargin: number | null
  longChange: number | null
  shortChange: number | null
  creditRatio: number | null
  shortRatio: number | null
  patternCode: string
  patternCount: number
  price: number | null
  changePct: number | null
  volumeRatio30: number | null
  daily_a_stage: number | null
  daily_b_stage: number | null
  weekly_a_stage: number | null
  weekly_b_stage: number | null
  monthly_a_stage: number | null
  monthly_b_stage: number | null
  p50_30d: number | null
  p50_60d: number | null
  p50_90d: number | null
}
export async function getStereoscopicSignals(limit = 12, date?: string | null): Promise<StereoscopicRow[]> {
  const latest = await resolveTradingDate(date)
  if (!latest) return []
  const prev = await getPrevDate(latest)
  return await execAll<StereoscopicRow>(
    `
    WITH today AS (
      SELECT
        s.ticker,
        printf('%d%d%d%d%d%d',
          s.daily_a_stage, s.daily_b_stage,
          s.weekly_a_stage, s.weekly_b_stage,
          s.monthly_a_stage, s.monthly_b_stage
        ) AS code,
        s.daily_a_stage,
        s.daily_b_stage,
        s.weekly_a_stage,
        s.weekly_b_stage,
        s.monthly_a_stage,
        s.monthly_b_stage,
        px.close AS price,
        py.close AS prev_close,
        px.volume,
        (
          SELECT AVG(volume)
          FROM (
            SELECT volume
            FROM ohlcv_daily od
            WHERE od.ticker = s.ticker AND od.date <= ?
            ORDER BY od.date DESC
            LIMIT 30
          )
        ) AS avg_volume_30
      FROM daily_snapshots
      s
      LEFT JOIN ohlcv_daily px ON px.ticker = s.ticker AND px.date = s.date
      LEFT JOIN ohlcv_daily py ON py.ticker = s.ticker AND py.date = ?
      WHERE s.date = ?
        AND daily_a_stage IS NOT NULL AND daily_b_stage IS NOT NULL
        AND weekly_a_stage IS NOT NULL AND weekly_b_stage IS NOT NULL
        AND monthly_a_stage IS NOT NULL AND monthly_b_stage IS NOT NULL
    )
    SELECT
      t.ticker,
      tu.name,
      tu.sector33_name AS sectorName,
      tu.sector17_name AS sector17Name,
      tu.sector33_name AS sector33Name,
      tu.market_segment AS marketSegment,
      COALESCE(tu.margin_type, sml.margin_type) AS marginType,
      sml.as_of_date AS marginAsOfDate,
      sml.long_margin AS longMargin,
      sml.short_margin AS shortMargin,
      sml.long_change AS longChange,
      sml.short_change AS shortChange,
      sml.credit_ratio AS creditRatio,
      sml.short_ratio AS shortRatio,
      t.code AS patternCode,
      p30.count AS patternCount,
      t.price,
      CASE WHEN t.prev_close > 0 THEN 100.0 * (t.price - t.prev_close) / t.prev_close END AS changePct,
      CASE WHEN t.avg_volume_30 > 0 THEN CAST(t.volume AS REAL) / t.avg_volume_30 END AS volumeRatio30,
      t.daily_a_stage,
      t.daily_b_stage,
      t.weekly_a_stage,
      t.weekly_b_stage,
      t.monthly_a_stage,
      t.monthly_b_stage,
      p30.p50 AS p50_30d,
      p60.p50 AS p50_60d,
      p90.p50 AS p50_90d
    FROM today t
    JOIN pattern_stats p30 ON p30.pattern_code = t.code AND p30.horizon_days = 30 AND p30.count >= 40
    LEFT JOIN pattern_stats p60 ON p60.pattern_code = t.code AND p60.horizon_days = 60
    LEFT JOIN pattern_stats p90 ON p90.pattern_code = t.code AND p90.horizon_days = 90
    LEFT JOIN ticker_universe tu ON tu.ticker = t.ticker
    LEFT JOIN serving_margin_latest sml ON sml.ticker = t.ticker
    ORDER BY p30.p50 DESC, changePct DESC
    LIMIT ?
    `,
    [latest, prev ?? latest, latest, limit],
  )
}

// ─── 新高値・新安値・出来高急増 ───
export interface NewHighVolumeRow {
  ticker: string
  name: string | null
  category: 'newHighs' | 'newLows' | 'volumeSpikes'
  sectorName: string | null
  sector17Name: string | null
  sector33Name: string | null
  marketSegment: string | null
  marginType: string | null
  marginAsOfDate: string | null
  longMargin: number | null
  shortMargin: number | null
  longChange: number | null
  shortChange: number | null
  creditRatio: number | null
  shortRatio: number | null
  type: string
  price: number | null
  changePct: number
  volume: number | null
  volumeRatio: number | null
  daily_a_stage: number | null
  daily_b_stage: number | null
  weekly_a_stage: number | null
  weekly_b_stage: number | null
  monthly_a_stage: number | null
  monthly_b_stage: number | null
}
export type MarketMovers = {
  newHighs: NewHighVolumeRow[]
  newLows: NewHighVolumeRow[]
  volumeSpikes: NewHighVolumeRow[]
}
export async function getMarketMovers(date?: string | null): Promise<MarketMovers> {
  const latest = await resolveTradingDate(date)
  if (!latest) return { newHighs: [], newLows: [], volumeSpikes: [] }
  const prev = await getPrevDate(latest)
  if (!prev) return { newHighs: [], newLows: [], volumeSpikes: [] }
  // 軽量版: 当日行 + 過去 252 営業日の MAX/MIN を別クエリで結合 (ROW_NUMBER を回避)
  const rows = await execAll<NewHighVolumeRow>(
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
    )
    SELECT * FROM (
      SELECT
        'newHighs' AS category,
        today.ticker,
        tu.name,
        tu.sector33_name AS sectorName,
        tu.sector17_name AS sector17Name,
        tu.sector33_name AS sector33Name,
        tu.market_segment AS marketSegment,
        COALESCE(tu.margin_type, sml.margin_type) AS marginType,
        sml.as_of_date AS marginAsOfDate,
        sml.long_margin AS longMargin,
        sml.short_margin AS shortMargin,
        sml.long_change AS longChange,
        sml.short_change AS shortChange,
        sml.credit_ratio AS creditRatio,
        sml.short_ratio AS shortRatio,
        '新高値' AS type,
        today.close AS price,
        CASE WHEN yest.yc > 0 THEN 100.0 * (today.close - yest.yc) / yest.yc ELSE 0 END AS changePct,
        today.volume,
        CASE WHEN hist.avgVol > 0 THEN CAST(today.volume AS REAL) / hist.avgVol END AS volumeRatio,
        s.daily_a_stage,
        s.daily_b_stage,
        s.weekly_a_stage,
        s.weekly_b_stage,
        s.monthly_a_stage,
        s.monthly_b_stage
      FROM today
      JOIN hist USING (ticker)
      JOIN yest USING (ticker)
      LEFT JOIN ticker_universe tu ON tu.ticker = today.ticker
      LEFT JOIN serving_margin_latest sml ON sml.ticker = today.ticker
      LEFT JOIN daily_snapshots s ON s.ticker = today.ticker AND s.date = ?
      WHERE today.high >= hist.h252
      UNION ALL
      SELECT
        'newLows' AS category,
        today.ticker,
        tu.name,
        tu.sector33_name AS sectorName,
        tu.sector17_name AS sector17Name,
        tu.sector33_name AS sector33Name,
        tu.market_segment AS marketSegment,
        COALESCE(tu.margin_type, sml.margin_type) AS marginType,
        sml.as_of_date AS marginAsOfDate,
        sml.long_margin AS longMargin,
        sml.short_margin AS shortMargin,
        sml.long_change AS longChange,
        sml.short_change AS shortChange,
        sml.credit_ratio AS creditRatio,
        sml.short_ratio AS shortRatio,
        '新安値' AS type,
        today.close AS price,
        CASE WHEN yest.yc > 0 THEN 100.0 * (today.close - yest.yc) / yest.yc ELSE 0 END AS changePct,
        today.volume,
        CASE WHEN hist.avgVol > 0 THEN CAST(today.volume AS REAL) / hist.avgVol END AS volumeRatio,
        s.daily_a_stage,
        s.daily_b_stage,
        s.weekly_a_stage,
        s.weekly_b_stage,
        s.monthly_a_stage,
        s.monthly_b_stage
      FROM today
      JOIN hist USING (ticker)
      JOIN yest USING (ticker)
      LEFT JOIN ticker_universe tu ON tu.ticker = today.ticker
      LEFT JOIN serving_margin_latest sml ON sml.ticker = today.ticker
      LEFT JOIN daily_snapshots s ON s.ticker = today.ticker AND s.date = ?
      WHERE today.low <= hist.l252
      UNION ALL
      SELECT
        'volumeSpikes' AS category,
        today.ticker,
        tu.name,
        tu.sector33_name AS sectorName,
        tu.sector17_name AS sector17Name,
        tu.sector33_name AS sector33Name,
        tu.market_segment AS marketSegment,
        COALESCE(tu.margin_type, sml.margin_type) AS marginType,
        sml.as_of_date AS marginAsOfDate,
        sml.long_margin AS longMargin,
        sml.short_margin AS shortMargin,
        sml.long_change AS longChange,
        sml.short_change AS shortChange,
        sml.credit_ratio AS creditRatio,
        sml.short_ratio AS shortRatio,
        CAST(ROUND(CAST(today.volume AS REAL) / hist.avgVol, 1) AS TEXT) || 'x量' AS type,
        today.close AS price,
        CASE WHEN yest.yc > 0 THEN 100.0 * (today.close - yest.yc) / yest.yc ELSE 0 END AS changePct,
        today.volume,
        CASE WHEN hist.avgVol > 0 THEN CAST(today.volume AS REAL) / hist.avgVol END AS volumeRatio,
        s.daily_a_stage,
        s.daily_b_stage,
        s.weekly_a_stage,
        s.weekly_b_stage,
        s.monthly_a_stage,
        s.monthly_b_stage
      FROM today
      JOIN hist USING (ticker)
      JOIN yest USING (ticker)
      LEFT JOIN ticker_universe tu ON tu.ticker = today.ticker
      LEFT JOIN serving_margin_latest sml ON sml.ticker = today.ticker
      LEFT JOIN daily_snapshots s ON s.ticker = today.ticker AND s.date = ?
      WHERE hist.avgVol > 0 AND CAST(today.volume AS REAL) / hist.avgVol >= 2.0
    )
    ORDER BY category, ABS(changePct) DESC, COALESCE(volumeRatio, 0) DESC
    `,
    [latest, prev, latest, latest, latest, latest, latest],
  )
  return {
    newHighs: rows.filter((row) => row.category === 'newHighs'),
    newLows: rows.filter((row) => row.category === 'newLows'),
    volumeSpikes: rows.filter((row) => row.category === 'volumeSpikes'),
  }
}

export async function getNewHighVolume(limit = 6, date?: string | null): Promise<NewHighVolumeRow[]> {
  const movers = await getMarketMovers(date)
  return [...movers.newHighs, ...movers.newLows, ...movers.volumeSpikes].slice(0, limit)
}

// ─── 17/33 業種ヒートマップ ───
export interface SectorHeatRow {
  sector_code: string | null
  sector_name: string
  n_stocks: number
  avg_change: number
}

export async function getSector17Heatmap(date?: string | null): Promise<SectorHeatRow[]> {
  const latest = await resolveTradingDate(date)
  if (!latest) return []
  const prev = await getPrevDate(latest)
  if (!prev) return []
  return await execAll<SectorHeatRow>(
    `
    WITH today AS (SELECT ticker, close FROM ohlcv_daily WHERE date = ?),
         yest AS (SELECT ticker, close FROM ohlcv_daily WHERE date = ?)
    SELECT
      tu.sector17_code AS sector_code,
      COALESCE(tu.sector17_name, 'その他') AS sector_name,
      COUNT(*) AS n_stocks,
      AVG(100.0 * (today.close - yest.close) / yest.close) AS avg_change
    FROM ticker_universe tu
    JOIN today USING (ticker)
    JOIN yest  USING (ticker)
    WHERE tu.active = 1 AND tu.sector17_name IS NOT NULL
    GROUP BY tu.sector17_code, tu.sector17_name
    ORDER BY avg_change DESC
    `,
    [latest, prev],
  )
}

export async function getSector33Heatmap(date?: string | null): Promise<SectorHeatRow[]> {
  const latest = await resolveTradingDate(date)
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
  p50_2d: number | null
  p50_3d: number | null
  p50_4d: number | null
  p50_5d: number | null
  p50_10d: number | null
  p50_15d: number | null
  kind: 'top' | 'bottom'
}
export async function getPatternStatsTopBottom(): Promise<PatternRankRow[]> {
  const selectSql = (kind: 'top' | 'bottom') => `
    SELECT
      p5.pattern_code,
      p5.count,
      p2.p50 AS p50_2d,
      p3.p50 AS p50_3d,
      p4.p50 AS p50_4d,
      p5.p50 AS p50_5d,
      p10.p50 AS p50_10d,
      p15.p50 AS p50_15d,
      '${kind}' AS kind
    FROM pattern_stats p5
    LEFT JOIN pattern_stats p2 ON p2.pattern_code = p5.pattern_code AND p2.horizon_days = 2
    LEFT JOIN pattern_stats p3 ON p3.pattern_code = p5.pattern_code AND p3.horizon_days = 3
    LEFT JOIN pattern_stats p4 ON p4.pattern_code = p5.pattern_code AND p4.horizon_days = 4
    LEFT JOIN pattern_stats p10 ON p10.pattern_code = p5.pattern_code AND p10.horizon_days = 10
    LEFT JOIN pattern_stats p15 ON p15.pattern_code = p5.pattern_code AND p15.horizon_days = 15
    WHERE p5.horizon_days = 5 AND p5.count >= 40
    ORDER BY p5.p50 ${kind === 'top' ? 'DESC' : 'ASC'}
    LIMIT 10
  `
  const [top, bottom] = await Promise.all(
    [
      execAll<PatternRankRow>(selectSql('top')),
      execAll<PatternRankRow>(selectSql('bottom')),
    ],
  )
  return [...top, ...bottom]
}

// ─── 決算発表カレンダー (J-Quants 最新取得分) ───
export interface EarningsRow extends EarningsSignalDecoration {
  ticker: string
  name: string | null
  announce_date: string
  daysLeft: number
  kind: 'upcoming' | 'completed'
  source: string | null
  sector17Name: string | null
  sector33Name: string | null
  marketSegment: string | null
  marginType: string | null
  marginAsOfDate: string | null
  longMargin: number | null
  shortMargin: number | null
  longChange: number | null
  shortChange: number | null
  creditRatio: number | null
  shortRatio: number | null
  daily_a_stage: number | null
  daily_b_stage: number | null
  weekly_a_stage: number | null
  weekly_b_stage: number | null
  monthly_a_stage: number | null
  monthly_b_stage: number | null
  price: number | null
  changePct: number | null
  avgVolume10: number | null
  avgVolume30: number | null
  avgVolume60: number | null
  postEarningsBaseDate: string | null
  postEarningsBasePrice: number | null
  postEarningsChangePct: number | null
  postEarningsTradingDays: number | null
}
type EarningsRowBase = Omit<EarningsRow, keyof EarningsSignalDecoration>

async function withEarningsSignals(rows: EarningsRowBase[], baseDate: string | null): Promise<EarningsRow[]> {
  const decorations = await loadEarningsSignalDecorations(rows.map((row) => row.ticker), baseDate)
  return attachEarningsSignalDecorations(rows, decorations)
}

export type EarningsCalendarStatus = 'ok' | 'none' | 'stale' | 'empty' | 'error'
export interface EarningsCalendarRunStatus {
  status: string | null
  rowsInserted: number | null
  totalTickers: number | null
  finishedAt: string | number | null
}
export interface EarningsCalendarDashboard {
  rows: EarningsRow[]
  completedRows: EarningsRow[]
  referenceRows: EarningsRow[]
  status: EarningsCalendarStatus
  message: string
  latestAnnounceDate: string | null
  latestImportedAt: number | null
  totalRows: number
  lastRun: EarningsCalendarRunStatus | null
  windowStart: string | null
  windowEnd: string | null
}
export async function getEarningsCalendar(daysAhead = 14, date?: string | null): Promise<EarningsRow[]> {
  const latest = await resolveTradingDate(date)
  if (!latest) return []
  const prev = await getPrevDate(latest)
  const rows = await execAll<EarningsRowBase>(
    `
    WITH cal AS (
      SELECT ticker, announce_date, company_name, sector_name, market_segment, source,
             CAST(julianday(announce_date) - julianday(?) AS INTEGER) AS daysLeft
      FROM earnings_calendar
      WHERE announce_date BETWEEN ? AND date(?, '+' || ? || ' days')
    ),
    px AS (SELECT ticker, close FROM ohlcv_daily WHERE date = ?),
    py AS (SELECT ticker, close AS prev_close FROM ohlcv_daily WHERE date = ?),
    st AS (SELECT * FROM daily_snapshots WHERE date = ?)
    SELECT cal.ticker, COALESCE(tu.name, cal.company_name) AS name, cal.announce_date, cal.daysLeft, 'upcoming' AS kind, cal.source,
           tu.sector17_name AS sector17Name,
           COALESCE(tu.sector33_name, cal.sector_name) AS sector33Name,
           COALESCE(tu.market_segment, cal.market_segment) AS marketSegment,
           COALESCE(tu.margin_type, sml.margin_type) AS marginType,
           sml.as_of_date AS marginAsOfDate,
           sml.long_margin AS longMargin,
           sml.short_margin AS shortMargin,
           sml.long_change AS longChange,
           sml.short_change AS shortChange,
           sml.credit_ratio AS creditRatio,
           sml.short_ratio AS shortRatio,
           st.daily_a_stage,
           st.daily_b_stage,
           st.weekly_a_stage,
           st.weekly_b_stage,
           st.monthly_a_stage,
           st.monthly_b_stage,
           px.close AS price,
           CASE WHEN py.prev_close > 0 THEN 100.0 * (px.close - py.prev_close) / py.prev_close ELSE 0 END AS changePct,
           (
             SELECT AVG(volume)
             FROM (
               SELECT volume
               FROM ohlcv_daily od
               WHERE od.ticker = cal.ticker AND od.date <= ?
               ORDER BY od.date DESC
               LIMIT 10
             )
           ) AS avgVolume10,
           (
             SELECT AVG(volume)
             FROM (
               SELECT volume
               FROM ohlcv_daily od
               WHERE od.ticker = cal.ticker AND od.date <= ?
               ORDER BY od.date DESC
               LIMIT 30
             )
           ) AS avgVolume30,
           (
             SELECT AVG(volume)
             FROM (
               SELECT volume
               FROM ohlcv_daily od
               WHERE od.ticker = cal.ticker AND od.date <= ?
               ORDER BY od.date DESC
               LIMIT 60
             )
           ) AS avgVolume60
           ,NULL AS postEarningsBaseDate,
           NULL AS postEarningsBasePrice,
           NULL AS postEarningsChangePct,
           NULL AS postEarningsTradingDays
    FROM cal
    LEFT JOIN ticker_universe tu ON tu.ticker = cal.ticker
    LEFT JOIN serving_margin_latest sml ON sml.ticker = cal.ticker
    LEFT JOIN px USING (ticker)
    LEFT JOIN py USING (ticker)
    LEFT JOIN st USING (ticker)
    ORDER BY cal.daysLeft ASC
    LIMIT 50
    `,
    [latest, latest, latest, daysAhead, latest, prev ?? latest, latest, latest, latest, latest],
  )
  return withEarningsSignals(rows, latest)
}

async function getRecentEarningsCalendarRows(baseDate: string, prevDate: string | null, limit = 20): Promise<EarningsRow[]> {
  const rows = await execAll<EarningsRowBase>(
    `
    WITH latest_cal AS (
      SELECT MAX(announce_date) AS announce_date FROM earnings_calendar
    ),
    cal AS (
      SELECT e.ticker, e.announce_date, e.company_name, e.sector_name, e.market_segment, e.source,
             CAST(julianday(e.announce_date) - julianday(?) AS INTEGER) AS daysLeft
      FROM earnings_calendar e
      JOIN latest_cal lc ON lc.announce_date = e.announce_date
      ORDER BY e.ticker
      LIMIT ?
    ),
    px AS (SELECT ticker, close FROM ohlcv_daily WHERE date = ?),
    py AS (SELECT ticker, close AS prev_close FROM ohlcv_daily WHERE date = ?),
    st AS (SELECT * FROM daily_snapshots WHERE date = ?)
    SELECT cal.ticker, COALESCE(tu.name, cal.company_name) AS name, cal.announce_date, cal.daysLeft, 'upcoming' AS kind, cal.source,
           tu.sector17_name AS sector17Name,
           COALESCE(tu.sector33_name, cal.sector_name) AS sector33Name,
           COALESCE(tu.market_segment, cal.market_segment) AS marketSegment,
           COALESCE(tu.margin_type, sml.margin_type) AS marginType,
           sml.as_of_date AS marginAsOfDate,
           sml.long_margin AS longMargin,
           sml.short_margin AS shortMargin,
           sml.long_change AS longChange,
           sml.short_change AS shortChange,
           sml.credit_ratio AS creditRatio,
           sml.short_ratio AS shortRatio,
           st.daily_a_stage,
           st.daily_b_stage,
           st.weekly_a_stage,
           st.weekly_b_stage,
           st.monthly_a_stage,
           st.monthly_b_stage,
           px.close AS price,
           CASE WHEN py.prev_close > 0 THEN 100.0 * (px.close - py.prev_close) / py.prev_close ELSE 0 END AS changePct,
           (
             SELECT AVG(volume)
             FROM (
               SELECT volume FROM ohlcv_daily od
               WHERE od.ticker = cal.ticker AND od.date <= ?
               ORDER BY od.date DESC LIMIT 10
             )
           ) AS avgVolume10,
           (
             SELECT AVG(volume)
             FROM (
               SELECT volume FROM ohlcv_daily od
               WHERE od.ticker = cal.ticker AND od.date <= ?
               ORDER BY od.date DESC LIMIT 30
             )
           ) AS avgVolume30,
           (
             SELECT AVG(volume)
             FROM (
               SELECT volume FROM ohlcv_daily od
               WHERE od.ticker = cal.ticker AND od.date <= ?
               ORDER BY od.date DESC LIMIT 60
             )
           ) AS avgVolume60
           ,NULL AS postEarningsBaseDate,
           NULL AS postEarningsBasePrice,
           NULL AS postEarningsChangePct,
           NULL AS postEarningsTradingDays
    FROM cal
    LEFT JOIN ticker_universe tu ON tu.ticker = cal.ticker
    LEFT JOIN serving_margin_latest sml ON sml.ticker = cal.ticker
    LEFT JOIN px USING (ticker)
    LEFT JOIN py USING (ticker)
    LEFT JOIN st USING (ticker)
    ORDER BY cal.announce_date DESC, cal.ticker
    `,
    [baseDate, limit, baseDate, prevDate ?? baseDate, baseDate, baseDate, baseDate, baseDate],
  )
  return withEarningsSignals(rows, baseDate)
}

async function getLatestImportedEarningsCalendarRows(baseDate: string, prevDate: string | null, limit = 50): Promise<EarningsRow[]> {
  const rows = await execAll<EarningsRowBase>(
    `
    WITH latest_import AS (
      SELECT MAX(imported_at) AS imported_at FROM earnings_calendar
    ),
    cal AS (
      SELECT e.ticker, e.announce_date, e.company_name, e.sector_name, e.market_segment, e.source,
             CAST(julianday(e.announce_date) - julianday(?) AS INTEGER) AS daysLeft
      FROM earnings_calendar e
      JOIN latest_import li ON li.imported_at = e.imported_at
      WHERE e.announce_date IS NOT NULL AND e.announce_date <> ''
        AND e.announce_date >= ?
      ORDER BY e.announce_date ASC, e.ticker
      LIMIT ?
    ),
    px AS (SELECT ticker, close FROM ohlcv_daily WHERE date = ?),
    py AS (SELECT ticker, close AS prev_close FROM ohlcv_daily WHERE date = ?),
    st AS (SELECT * FROM daily_snapshots WHERE date = ?)
    SELECT cal.ticker, COALESCE(tu.name, cal.company_name) AS name, cal.announce_date, cal.daysLeft, 'upcoming' AS kind, cal.source,
           tu.sector17_name AS sector17Name,
           COALESCE(tu.sector33_name, cal.sector_name) AS sector33Name,
           COALESCE(tu.market_segment, cal.market_segment) AS marketSegment,
           COALESCE(tu.margin_type, sml.margin_type) AS marginType,
           sml.as_of_date AS marginAsOfDate,
           sml.long_margin AS longMargin,
           sml.short_margin AS shortMargin,
           sml.long_change AS longChange,
           sml.short_change AS shortChange,
           sml.credit_ratio AS creditRatio,
           sml.short_ratio AS shortRatio,
           st.daily_a_stage,
           st.daily_b_stage,
           st.weekly_a_stage,
           st.weekly_b_stage,
           st.monthly_a_stage,
           st.monthly_b_stage,
           px.close AS price,
           CASE WHEN py.prev_close > 0 THEN 100.0 * (px.close - py.prev_close) / py.prev_close ELSE 0 END AS changePct,
           (
             SELECT AVG(volume)
             FROM (
               SELECT volume FROM ohlcv_daily od
               WHERE od.ticker = cal.ticker AND od.date <= ?
               ORDER BY od.date DESC LIMIT 10
             )
           ) AS avgVolume10,
           (
             SELECT AVG(volume)
             FROM (
               SELECT volume FROM ohlcv_daily od
               WHERE od.ticker = cal.ticker AND od.date <= ?
               ORDER BY od.date DESC LIMIT 30
             )
           ) AS avgVolume30,
           (
             SELECT AVG(volume)
             FROM (
               SELECT volume FROM ohlcv_daily od
               WHERE od.ticker = cal.ticker AND od.date <= ?
               ORDER BY od.date DESC LIMIT 60
             )
           ) AS avgVolume60
           ,NULL AS postEarningsBaseDate,
           NULL AS postEarningsBasePrice,
           NULL AS postEarningsChangePct,
           NULL AS postEarningsTradingDays
    FROM cal
    LEFT JOIN ticker_universe tu ON tu.ticker = cal.ticker
    LEFT JOIN serving_margin_latest sml ON sml.ticker = cal.ticker
    LEFT JOIN px USING (ticker)
    LEFT JOIN py USING (ticker)
    LEFT JOIN st USING (ticker)
    ORDER BY cal.announce_date ASC, cal.ticker
    `,
    [baseDate, baseDate, limit, baseDate, prevDate ?? baseDate, baseDate, baseDate, baseDate, baseDate],
  )
  return withEarningsSignals(rows, baseDate)
}

async function getCompletedEarningsCalendarRows(baseDate: string, prevDate: string | null, daysBack = 14, limit = 80): Promise<EarningsRow[]> {
  const rows = await execAll<EarningsRowBase>(
    `
    WITH cal AS (
      SELECT e.ticker, e.announce_date, e.company_name, e.sector_name, e.market_segment, e.source,
             CAST(julianday(e.announce_date) - julianday(?) AS INTEGER) AS daysLeft
      FROM earnings_calendar e
      WHERE e.announce_date BETWEEN date(?, '-' || ? || ' days') AND date(?, '-1 day')
      ORDER BY e.announce_date DESC, e.ticker
      LIMIT ?
    ),
    px AS (SELECT ticker, close FROM ohlcv_daily WHERE date = ?),
    py AS (SELECT ticker, close AS prev_close FROM ohlcv_daily WHERE date = ?),
    st AS (SELECT * FROM daily_snapshots WHERE date = ?),
    first_trade AS (
      SELECT cal.ticker, MIN(od.date) AS base_date
      FROM cal
      JOIN ohlcv_daily od ON od.ticker = cal.ticker AND od.date >= cal.announce_date AND od.date <= ?
      GROUP BY cal.ticker
    ),
    first_px AS (
      SELECT ft.ticker, ft.base_date, od.close AS base_close
      FROM first_trade ft
      LEFT JOIN ohlcv_daily od ON od.ticker = ft.ticker AND od.date = ft.base_date
    )
    SELECT cal.ticker, COALESCE(tu.name, cal.company_name) AS name, cal.announce_date, cal.daysLeft, 'completed' AS kind, cal.source,
           tu.sector17_name AS sector17Name,
           COALESCE(tu.sector33_name, cal.sector_name) AS sector33Name,
           COALESCE(tu.market_segment, cal.market_segment) AS marketSegment,
           COALESCE(tu.margin_type, sml.margin_type) AS marginType,
           sml.as_of_date AS marginAsOfDate,
           sml.long_margin AS longMargin,
           sml.short_margin AS shortMargin,
           sml.long_change AS longChange,
           sml.short_change AS shortChange,
           sml.credit_ratio AS creditRatio,
           sml.short_ratio AS shortRatio,
           st.daily_a_stage,
           st.daily_b_stage,
           st.weekly_a_stage,
           st.weekly_b_stage,
           st.monthly_a_stage,
           st.monthly_b_stage,
           px.close AS price,
           CASE WHEN py.prev_close > 0 THEN 100.0 * (px.close - py.prev_close) / py.prev_close ELSE 0 END AS changePct,
           (
             SELECT AVG(volume)
             FROM (
               SELECT volume FROM ohlcv_daily od
               WHERE od.ticker = cal.ticker AND od.date <= ?
               ORDER BY od.date DESC LIMIT 10
             )
           ) AS avgVolume10,
           (
             SELECT AVG(volume)
             FROM (
               SELECT volume FROM ohlcv_daily od
               WHERE od.ticker = cal.ticker AND od.date <= ?
               ORDER BY od.date DESC LIMIT 30
             )
           ) AS avgVolume30,
           (
             SELECT AVG(volume)
             FROM (
               SELECT volume FROM ohlcv_daily od
               WHERE od.ticker = cal.ticker AND od.date <= ?
               ORDER BY od.date DESC LIMIT 60
             )
           ) AS avgVolume60,
           fp.base_date AS postEarningsBaseDate,
           fp.base_close AS postEarningsBasePrice,
           CASE WHEN fp.base_close > 0 THEN 100.0 * (px.close - fp.base_close) / fp.base_close END AS postEarningsChangePct,
           (
             SELECT COUNT(*) - 1
             FROM ohlcv_daily od
             WHERE od.ticker = cal.ticker AND fp.base_date IS NOT NULL AND od.date BETWEEN fp.base_date AND ?
           ) AS postEarningsTradingDays
    FROM cal
    LEFT JOIN ticker_universe tu ON tu.ticker = cal.ticker
    LEFT JOIN serving_margin_latest sml ON sml.ticker = cal.ticker
    LEFT JOIN px USING (ticker)
    LEFT JOIN py USING (ticker)
    LEFT JOIN st USING (ticker)
    LEFT JOIN first_px fp USING (ticker)
    ORDER BY cal.announce_date DESC, cal.ticker
    `,
    [
      baseDate,
      baseDate,
      daysBack,
      baseDate,
      limit,
      baseDate,
      prevDate ?? baseDate,
      baseDate,
      baseDate,
      baseDate,
      baseDate,
      baseDate,
      baseDate,
    ],
  )
  return withEarningsSignals(rows, baseDate)
}

function earningsDateRange(rows: EarningsRow[], fallbackStart: string | null, fallbackEnd: string | null) {
  if (rows.length === 0) return { start: fallbackStart, end: fallbackEnd }
  const dates = rows.map(row => row.announce_date).sort()
  return { start: dates[0] ?? fallbackStart, end: dates[dates.length - 1] ?? fallbackEnd }
}

export async function getEarningsCalendarDashboard(daysAhead = 14, date?: string | null): Promise<EarningsCalendarDashboard> {
  const latest = await resolveTradingDate(date)
  if (!latest) {
    return {
      rows: [],
      completedRows: [],
      referenceRows: [],
      status: 'empty',
      message: '株価データ未取り込みのため、決算発表銘柄を判定できません。',
      latestAnnounceDate: null,
      latestImportedAt: null,
      totalRows: 0,
      lastRun: null,
      windowStart: null,
      windowEnd: null,
    }
  }

  const prev = await getPrevDate(latest)
  const meta = await execGet<{ latestAnnounceDate: string | null; latestImportedAt: number | null; total: number }>(
    `SELECT MAX(NULLIF(announce_date, '')) AS latestAnnounceDate,
            MAX(imported_at) AS latestImportedAt,
            COUNT(*) AS total
     FROM earnings_calendar`,
  )
  const lastRun = await execGet<EarningsCalendarRunStatus>(
    `
      SELECT status,
             rows_inserted AS rowsInserted,
             total_tickers AS totalTickers,
             finished_at AS finishedAt
      FROM batch_runs
      WHERE job_type = 'earnings_calendar'
      ORDER BY started_at DESC
      LIMIT 1
    `,
  )
  const windowEndRow = await execGet<{ d: string | null }>(
    `SELECT date(?, '+' || ? || ' days') AS d`,
    [latest, daysAhead],
  )
  const windowEnd = windowEndRow?.d ?? null
  const total = Number(meta?.total ?? 0)
  const latestImportedAt = meta?.latestImportedAt == null ? null : Number(meta.latestImportedAt)
  if (total === 0) {
    return {
      rows: [],
      completedRows: [],
      referenceRows: [],
      status: 'empty',
      message: '決算カレンダーが未取得です。J-Quants決算予定の取得バッチを確認してください。',
      latestAnnounceDate: null,
      latestImportedAt,
      totalRows: total,
      lastRun: lastRun ?? null,
      windowStart: latest,
      windowEnd,
    }
  }

  try {
    const lastInserted = lastRun?.rowsInserted == null ? null : Number(lastRun.rowsInserted)
    const completedRows = await getCompletedEarningsCalendarRows(latest, prev, 14, 80)
    const latestImportRows = lastInserted === 0 ? [] : await getLatestImportedEarningsCalendarRows(latest, prev, 80)

    if (lastInserted === 0) {
      const referenceRows = await getRecentEarningsCalendarRows(latest, prev, 20)
      return {
        rows: [],
        completedRows,
        referenceRows,
        status: 'none',
        message: 'J-Quants最新取得は0件でした。このAPIは翌営業日に決算発表が行われる銘柄を返すため、翌営業日の開示予定がない場合は空になります。',
        latestAnnounceDate: meta?.latestAnnounceDate ?? null,
        latestImportedAt,
        totalRows: total,
        lastRun: lastRun ?? null,
        windowStart: latest,
        windowEnd,
      }
    }

    if (latestImportRows.length > 0) {
      const range = earningsDateRange(latestImportRows, latest, windowEnd)
      return {
        rows: latestImportRows,
        completedRows,
        referenceRows: [],
        status: 'ok',
        message: 'J-Quants翌営業日APIとJPX公式Excelを統合した最新取得分です。J-Quantsで分からない月次予定はJPX公式の決算発表予定Excelから補完しています。',
        latestAnnounceDate: meta?.latestAnnounceDate ?? null,
        latestImportedAt,
        totalRows: total,
        lastRun: lastRun ?? null,
        windowStart: range.start,
        windowEnd: range.end,
      }
    }

    const rows = await getEarningsCalendar(daysAhead, latest)
    if (rows.length > 0) {
      return {
        rows,
        completedRows,
        referenceRows: [],
        status: 'ok',
        message: 'J-Quants決算予定の取得済みデータから、表示対象期間に該当する銘柄を表示しています。',
        latestAnnounceDate: meta?.latestAnnounceDate ?? null,
        latestImportedAt,
        totalRows: total,
        lastRun: lastRun ?? null,
        windowStart: latest,
        windowEnd,
      }
    }

    const latestAnnounceDate = meta?.latestAnnounceDate ?? null
    const stale = Boolean(latestAnnounceDate && latestAnnounceDate < latest)
    const referenceRows = stale ? await getRecentEarningsCalendarRows(latest, prev, 20) : []
    return {
      rows: [],
      completedRows,
      referenceRows,
      status: stale ? 'stale' : 'none',
      message: stale
        ? `J-Quants決算予定のDB内最新日は ${latestAnnounceDate} です。最新取得バッチの状態を確認してください。`
        : 'J-Quants決算予定の表示対象銘柄はありません。',
      latestAnnounceDate,
      latestImportedAt,
      totalRows: total,
      lastRun: lastRun ?? null,
      windowStart: latest,
      windowEnd,
    }
  } catch (error) {
    return {
      rows: [],
      completedRows: [],
      referenceRows: [],
      status: 'error',
      message: `決算カレンダーの取得に失敗しました: ${error instanceof Error ? error.message : String(error)}`,
      latestAnnounceDate: meta?.latestAnnounceDate ?? null,
      latestImportedAt,
      totalRows: total,
      lastRun: lastRun ?? null,
      windowStart: latest,
      windowEnd,
    }
  }
}

// ─── 信用残・空売り注目 ───
export interface CreditShortRow {
  ticker: string
  name: string | null
  sectorName: string | null
  marketSegment: string | null
  price: number | null
  changePct: number | null
  longMargin: number | null
  longChange: number | null
  shortMargin: number | null
  shortChange: number | null
  shortRatio: number | null
  daily_a_stage: number | null
  daily_b_stage: number | null
}
export interface CreditShortSectorRow {
  sectorName: string
  tickerCount: number
  longMargin: number
  longChange: number
  shortMargin: number
  shortChange: number
  shortRatio: number | null
  pressureScore: number
}
export interface CreditShortDashboard {
  asOf: string | null
  sectorRows: CreditShortSectorRow[]
  stockRows: CreditShortRow[]
}
export async function getCreditShortDashboard(): Promise<CreditShortDashboard> {
  const latest = await getLatestDate()
  const prev = latest ? await getPrevDate(latest) : null
  const latestWmi = (await execGet<{ d: string | null }>(
    `SELECT MAX(date) AS d FROM weekly_margin_interest`,
  ))?.d ?? null

  const stockRows = await execAll<CreditShortRow>(
    `
    WITH latest_wmi AS (
      SELECT ticker, long_margin, long_change, short_margin, short_change,
             ROW_NUMBER() OVER (PARTITION BY ticker ORDER BY date DESC) AS rn
      FROM weekly_margin_interest
    ),
    latest_ssp AS (
      SELECT ticker, MAX(short_ratio) AS short_ratio
      FROM short_selling_positions
      WHERE date >= date('now', '-60 days')
      GROUP BY ticker
    ),
    px AS (SELECT ticker, close FROM ohlcv_daily WHERE date = ?),
    py AS (SELECT ticker, close AS prev_close FROM ohlcv_daily WHERE date = ?),
    st AS (SELECT ticker, daily_a_stage, daily_b_stage FROM daily_snapshots WHERE date = ?)
    SELECT w.ticker,
           tu.name,
           tu.sector33_name AS sectorName,
           tu.market_segment AS marketSegment,
           px.close AS price,
           CASE WHEN py.prev_close > 0 THEN 100.0 * (px.close - py.prev_close) / py.prev_close END AS changePct,
           w.long_margin AS longMargin,
           w.long_change AS longChange,
           w.short_margin AS shortMargin,
           w.short_change AS shortChange,
           COALESCE(
             s.short_ratio,
             CASE
               WHEN COALESCE(w.long_margin, 0) + COALESCE(w.short_margin, 0) > 0
               THEN 100.0 * COALESCE(w.short_margin, 0) / (COALESCE(w.long_margin, 0) + COALESCE(w.short_margin, 0))
             END
           ) AS shortRatio,
           st.daily_a_stage,
           st.daily_b_stage
    FROM latest_wmi w
    LEFT JOIN latest_ssp s USING (ticker)
    LEFT JOIN ticker_universe tu ON tu.ticker = w.ticker
    LEFT JOIN px USING (ticker)
    LEFT JOIN py USING (ticker)
    LEFT JOIN st USING (ticker)
    WHERE w.rn = 1
      AND (w.long_margin IS NOT NULL OR w.short_margin IS NOT NULL OR s.short_ratio IS NOT NULL)
    ORDER BY
      ABS(COALESCE(w.short_change, 0)) DESC,
      COALESCE(shortRatio, 0) DESC
    LIMIT 16
    `,
    [latest ?? '', prev ?? latest ?? '', latest ?? ''],
  )

  const sectorRows = await execAll<CreditShortSectorRow>(
    `
    WITH latest_wmi AS (
      SELECT ticker, long_margin, long_change, short_margin, short_change,
             ROW_NUMBER() OVER (PARTITION BY ticker ORDER BY date DESC) AS rn
      FROM weekly_margin_interest
    ),
    base AS (
      SELECT
        COALESCE(tu.sector33_name, 'その他') AS sectorName,
        w.ticker,
        COALESCE(w.long_margin, 0) AS longMargin,
        COALESCE(w.long_change, 0) AS longChange,
        COALESCE(w.short_margin, 0) AS shortMargin,
        COALESCE(w.short_change, 0) AS shortChange
      FROM latest_wmi w
      LEFT JOIN ticker_universe tu ON tu.ticker = w.ticker
      WHERE w.rn = 1
    )
    SELECT
      sectorName,
      COUNT(*) AS tickerCount,
      SUM(longMargin) AS longMargin,
      SUM(longChange) AS longChange,
      SUM(shortMargin) AS shortMargin,
      SUM(shortChange) AS shortChange,
      CASE
        WHEN SUM(longMargin) + SUM(shortMargin) > 0
        THEN 100.0 * SUM(shortMargin) / (SUM(longMargin) + SUM(shortMargin))
      END AS shortRatio,
      ABS(SUM(shortChange)) + ABS(SUM(longChange)) AS pressureScore
    FROM base
    GROUP BY sectorName
    ORDER BY pressureScore DESC
    LIMIT 8
    `,
  )

  return { asOf: latestWmi, sectorRows, stockRows }
}
export async function getCreditShortHighlights(limit = 4): Promise<CreditShortRow[]> {
  return (await getCreditShortDashboard()).stockRows.slice(0, limit)
}

// ─── 主要指数 (J-Quants /indices/bars/daily 由来) ───
//
// 日経225 は J-Quants 公式の指数コード表に存在しないため含まれない。
// ドル円 / 10年JGB も同様 (為替・金利は当面「データ未接続」)

export interface IndexQuote {
  label: string
  code: string
  value: number | null
  changePct: number | null
  note?: string  // 「データ未接続」等の補足
}

const INDEX_LIST: Array<{ code: string; label: string; format?: 'int' | 'float' }> = [
  { code: '0000', label: 'TOPIX' },
  { code: '0070', label: 'グロース250' },
  { code: '0500', label: 'プライム' },
  { code: '0501', label: 'スタンダード' },
]

export async function getDashboardIndices(): Promise<IndexQuote[]> {
  // 最新日 + 前日の close を一括取得
  const latestRow = await execGet<{ d: string | null }>(
    `SELECT MAX(date) AS d FROM indices_daily`,
  )
  const latest = latestRow?.d
  const prev = latest
    ? (await execGet<{ d: string | null }>(`SELECT MAX(date) AS d FROM indices_daily WHERE date < ?`, [latest]))?.d
    : null

  const codes = INDEX_LIST.map(i => i.code)
  const placeholders = codes.map(() => '?').join(',')
  const rows = latest
    ? await execAll<{ code: string; close: number | null }>(
        `SELECT code, close FROM indices_daily WHERE date = ? AND code IN (${placeholders})`,
        [latest, ...codes],
      )
    : []
  const prevRows = prev
    ? await execAll<{ code: string; close: number | null }>(
        `SELECT code, close FROM indices_daily WHERE date = ? AND code IN (${placeholders})`,
        [prev, ...codes],
      )
    : []
  const closeMap = new Map(rows.map(r => [r.code, r.close]))
  const prevMap = new Map(prevRows.map(r => [r.code, r.close]))

  const out: IndexQuote[] = INDEX_LIST.map(i => {
    const v = closeMap.get(i.code) ?? null
    const p = prevMap.get(i.code) ?? null
    const changePct = v != null && p != null && p > 0 ? ((v - p) / p) * 100 : null
    return { label: i.label, code: i.code, value: v, changePct }
  })

  // 騰落レシオ (自前計算)
  const ad = await getAdvanceDecline()
  const advRatio = ad && ad.declines > 0 ? (ad.advances / ad.declines) * 100 : null
  out.push({ label: '騰落レシオ', code: 'ADR', value: advRatio, changePct: null })

  // 日経225 (J-Quants 指数四本値 API では未提供)
  out.push({ label: '日経225', code: 'N225', value: null, changePct: null, note: 'J-Quants未提供' })

  return out
}

// ─── ウォッチリスト (ローカルストレージ依存だが SSR では空の placeholder を返す) ───
export interface WatchlistRow {
  ticker: string
  name: string | null
  price: number | null
  changePct: number | null
  daily_a_stage: number | null
}
