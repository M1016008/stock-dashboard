// app/api/screener/route.ts
// マルチ軸スクリーナー API。
// データソース: J-Quants 由来の local DB
//   - daily_snapshots: MA / HEX ステージ
//   - ohlcv_daily: 株価、出来高、騰落率
//   - ticker_universe / sector_master: 銘柄属性
//   - market: JP のみ対応
//   - segment: プライム/スタンダード/グロース（マスタから絞り込み）
//   - daily_a / daily_b / weekly_a / weekly_b / monthly_a / monthly_b:
//       各系統で 1..6 を指定（カンマ区切りで複数指定可、例: daily_a=1,2,3）
// 軸内は OR、軸間は AND で絞り込む。

import { NextRequest, NextResponse } from 'next/server'
import { execAll, execGet } from '@/lib/db/client'
import { filterRowsByUniverse, parseUniverseFilter, UNIVERSE_FILTER_PARAM } from '@/lib/market-universe'
import { getTickersByMarket } from '@/lib/master/tickers'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

interface SnapshotRow {
  date: string
  ticker: string
  name: string | null
  price: number | null
  change_percent_1d: number | null
  volume_1d: number | null
  avg_volume_10d: number | null
  avg_volume_30d: number | null
  market_cap: number | null
  shares_outstanding: number | null
  perf_pct_1w: number | null
  perf_pct_1m: number | null
  perf_pct_3m: number | null
  perf_pct_6m: number | null
  perf_pct_ytd: number | null
  sma_5d: number | null
  sma_5d_prev: number | null
  sma_25d: number | null
  sma_75d: number | null
  sma_200d: number | null
  sma_200d_prev: number | null
  earnings_last_date: string | null
  earnings_last_source: string | null
  earnings_last_fiscal_period: string | null
  earnings_next_date: string | null
  earnings_next_source: string | null
  earnings_next_fiscal_period: string | null
  earnings_calendar_count: number | null
  earnings_latest_known_date: string | null
  earnings_summary_count: number | null
  earnings_summary_earliest_date: string | null
  earnings_summary_global_earliest_date: string | null
  sector17_name: string | null
  sector33_name: string | null
  market_segment: string | null
  margin_type: string | null
  daily_a_stage: number | null
  daily_b_stage: number | null
  weekly_a_stage: number | null
  weekly_b_stage: number | null
  monthly_a_stage: number | null
  monthly_b_stage: number | null
  physical_momentum_score: number | null
  physical_force_score: number | null
  physical_energy_score: number | null
  physical_momentum_rank: number | null
  physical_momentum_prev_score: number | null
  physical_acceleration: number | null
  physical_force: number | null
}

interface ScreenerStockRow {
  ticker: string
  name: string
  market: 'JP'
  marketSegment: string
  marginType?: string
  sectorLarge: string
  sector33: string | null
  sector17Name: string | null
  sector33Name: string | null
  price: number | null
  currency: string | null
  changePercent: number | null
  changePercentWeek: number | null
  changePercentMonth: number | null
  perfPct3m: number | null
  perfPct6m: number | null
  perfPctYtd: number | null
  volume: number | null
  avgVolume10d: number | null
  avgVolume30d: number | null
  marketCap: number | null
  marketCapCurrency: string | null
  marketCapStatus: 'calculated' | 'not_applicable' | 'shares_missing' | 'price_missing'
  sma5Angle: number | null
  sma25Angle: number | null
  sma75Angle: number | null
  sma200Angle: number | null
  earningsLastDate: string | null
  earningsLastDateKind: 'reported' | 'not_applicable' | 'not_collected' | 'unverified'
  earningsLastDateSource: string | null
  earningsLastFiscalPeriod: string | null
  earningsNextDate: string | null
  earningsNextDateKind: 'confirmed' | 'estimated' | 'not_announced' | 'not_applicable' | 'no_history'
  earningsNextDateSource: string | null
  earningsNextFiscalPeriod: string | null
  daily_a_stage: number | null
  daily_b_stage: number | null
  weekly_a_stage: number | null
  weekly_b_stage: number | null
  monthly_a_stage: number | null
  monthly_b_stage: number | null
  physicalMomentumScore: number | null
  physicalForceScore: number | null
  physicalEnergyScore: number | null
  physicalMomentumRank: number | null
  physicalMomentumTrend: 'rising' | 'falling' | 'flat' | null
  physicalAcceleration: number | null
  physicalForce: number | null
}

type ScreenerSortKey =
  | keyof ScreenerStockRow
  | 'earningsLastElapsedDays'
  | 'earningsNextBusinessDays'

const STAGE_KEYS = [
  'daily_a_stage',
  'daily_b_stage',
  'weekly_a_stage',
  'weekly_b_stage',
  'monthly_a_stage',
  'monthly_b_stage',
] as const

const STAGE_PARAM_MAP: Record<string, typeof STAGE_KEYS[number]> = {
  daily_a: 'daily_a_stage',
  daily_b: 'daily_b_stage',
  weekly_a: 'weekly_a_stage',
  weekly_b: 'weekly_b_stage',
  monthly_a: 'monthly_a_stage',
  monthly_b: 'monthly_b_stage',
}

async function latestSnapshotDate(): Promise<string | null> {
  const row = await execGet<{ d: string | null }>(`SELECT MAX(date) AS d FROM daily_snapshots`)
  return row?.d ?? null
}

async function loadSnapshotByDate(date: string): Promise<SnapshotRow[]> {
  return execAll<SnapshotRow>(
    `
    WITH
      prev_dates AS (
        SELECT
          (SELECT MAX(date) FROM ohlcv_daily WHERE date < ?) AS d1,
          (SELECT MAX(date) FROM ohlcv_daily WHERE date <= date(?, '-7 days')) AS w1,
          (SELECT MAX(date) FROM ohlcv_daily WHERE date <= date(?, '-1 month')) AS m1,
          (SELECT MAX(date) FROM ohlcv_daily WHERE date <= date(?, '-3 months')) AS m3,
          (SELECT MAX(date) FROM ohlcv_daily WHERE date <= date(?, '-6 months')) AS m6,
          (SELECT MAX(date) FROM ohlcv_daily WHERE date <= substr(?, 1, 4) || '-01-01') AS ytd,
          (
            SELECT date
            FROM (
              SELECT DISTINCT date
          FROM ohlcv_daily
          WHERE date <= ?
          ORDER BY date DESC
          LIMIT 21
        )
        ORDER BY date ASC
        LIMIT 1
      ) AS d20
      ),
      pms_ranked AS (
        SELECT
          symbol,
          physical_momentum_score,
          physical_force_score,
          physical_energy_score,
          acceleration,
          force,
          RANK() OVER (ORDER BY physical_momentum_score DESC) AS physical_momentum_rank
        FROM physical_momentum_metrics
        WHERE market = 'JP'
          AND date = ?
          AND physical_momentum_score IS NOT NULL
      )
    SELECT
      s.date,
      s.ticker,
      u.name,
      cur.close AS price,
      CASE WHEN d1.close > 0 THEN 100.0 * (cur.close - d1.close) / d1.close END AS change_percent_1d,
      cur.volume AS volume_1d,
      (
        SELECT ROUND(AVG(volume))
        FROM (
          SELECT od.volume
          FROM ohlcv_daily od
          WHERE od.ticker = s.ticker AND od.date <= s.date
          ORDER BY od.date DESC
          LIMIT 10
        )
      ) AS avg_volume_10d,
      (
        SELECT ROUND(AVG(volume))
        FROM (
          SELECT od.volume
          FROM ohlcv_daily od
          WHERE od.ticker = s.ticker AND od.date <= s.date
          ORDER BY od.date DESC
          LIMIT 30
        )
      ) AS avg_volume_30d,
      CASE WHEN u.shares_outstanding IS NOT NULL THEN cur.close * u.shares_outstanding END AS market_cap,
      u.shares_outstanding,
      CASE WHEN w1.close > 0 THEN 100.0 * (cur.close - w1.close) / w1.close END AS perf_pct_1w,
      CASE WHEN m1.close > 0 THEN 100.0 * (cur.close - m1.close) / m1.close END AS perf_pct_1m,
      CASE WHEN m3.close > 0 THEN 100.0 * (cur.close - m3.close) / m3.close END AS perf_pct_3m,
      CASE WHEN m6.close > 0 THEN 100.0 * (cur.close - m6.close) / m6.close END AS perf_pct_6m,
      CASE WHEN ytd.close > 0 THEN 100.0 * (cur.close - ytd.close) / ytd.close END AS perf_pct_ytd,
      s.ma_5 AS sma_5d,
      prev_s.ma_5 AS sma_5d_prev,
      s.ma_25 AS sma_25d,
      s.ma_75 AS sma_75d,
      (
        SELECT CASE WHEN COUNT(*) >= 200 THEN AVG(close) END
        FROM (
          SELECT od.close
          FROM ohlcv_daily od
          WHERE od.ticker = s.ticker AND od.date <= s.date
          ORDER BY od.date DESC
          LIMIT 200
        )
      ) AS sma_200d,
      (
        SELECT CASE WHEN COUNT(*) >= 200 THEN AVG(close) END
        FROM (
          SELECT od.close
          FROM ohlcv_daily od
          WHERE od.ticker = s.ticker AND od.date <= pd.d20
          ORDER BY od.date DESC
          LIMIT 200
        )
      ) AS sma_200d_prev,
      (
        SELECT e.announce_date
        FROM earnings_calendar e
        WHERE e.ticker = s.ticker AND e.announce_date < s.date
        ORDER BY CASE WHEN e.source = 'jquants_fins_summary' THEN 0 ELSE 1 END, e.announce_date DESC
        LIMIT 1
      ) AS earnings_last_date,
      (
        SELECT e.source
        FROM earnings_calendar e
        WHERE e.ticker = s.ticker AND e.announce_date < s.date
        ORDER BY CASE WHEN e.source = 'jquants_fins_summary' THEN 0 ELSE 1 END, e.announce_date DESC
        LIMIT 1
      ) AS earnings_last_source,
      (
        SELECT e.fiscal_period
        FROM earnings_calendar e
        WHERE e.ticker = s.ticker AND e.announce_date < s.date
        ORDER BY CASE WHEN e.source = 'jquants_fins_summary' THEN 0 ELSE 1 END, e.announce_date DESC
        LIMIT 1
      ) AS earnings_last_fiscal_period,
      (SELECT MIN(e.announce_date) FROM earnings_calendar e WHERE e.ticker = s.ticker AND e.announce_date >= s.date) AS earnings_next_date,
      (
        SELECT e.source
        FROM earnings_calendar e
        WHERE e.ticker = s.ticker AND e.announce_date >= s.date
        ORDER BY e.announce_date ASC
        LIMIT 1
      ) AS earnings_next_source,
      (
        SELECT e.fiscal_period
        FROM earnings_calendar e
        WHERE e.ticker = s.ticker AND e.announce_date >= s.date
        ORDER BY e.announce_date ASC
        LIMIT 1
      ) AS earnings_next_fiscal_period,
      (SELECT COUNT(*) FROM earnings_calendar e WHERE e.ticker = s.ticker) AS earnings_calendar_count,
      (SELECT MAX(e.announce_date) FROM earnings_calendar e WHERE e.ticker = s.ticker) AS earnings_latest_known_date,
      (SELECT COUNT(*) FROM earnings_calendar e WHERE e.ticker = s.ticker AND e.source = 'jquants_fins_summary') AS earnings_summary_count,
      (SELECT MIN(e.announce_date) FROM earnings_calendar e WHERE e.ticker = s.ticker AND e.source = 'jquants_fins_summary') AS earnings_summary_earliest_date,
      (SELECT MIN(e.announce_date) FROM earnings_calendar e WHERE e.source = 'jquants_fins_summary') AS earnings_summary_global_earliest_date,
      u.sector17_name,
      u.sector33_name,
      u.market_segment,
      u.margin_type,
      s.daily_a_stage,
      s.daily_b_stage,
      s.weekly_a_stage,
      s.weekly_b_stage,
      s.monthly_a_stage,
      s.monthly_b_stage,
      pm.physical_momentum_score,
      pm.physical_force_score,
      pm.physical_energy_score,
      pm.physical_momentum_rank,
      pm_prev.physical_momentum_score AS physical_momentum_prev_score,
      pm.acceleration AS physical_acceleration,
      pm.force AS physical_force
    FROM daily_snapshots s
    LEFT JOIN ohlcv_daily cur ON cur.ticker = s.ticker AND cur.date = s.date
    CROSS JOIN prev_dates pd
    LEFT JOIN ohlcv_daily d1 ON d1.ticker = s.ticker AND d1.date = pd.d1
    LEFT JOIN ohlcv_daily w1 ON w1.ticker = s.ticker AND w1.date = pd.w1
    LEFT JOIN ohlcv_daily m1 ON m1.ticker = s.ticker AND m1.date = pd.m1
    LEFT JOIN ohlcv_daily m3 ON m3.ticker = s.ticker AND m3.date = pd.m3
    LEFT JOIN ohlcv_daily m6 ON m6.ticker = s.ticker AND m6.date = pd.m6
    LEFT JOIN ohlcv_daily ytd ON ytd.ticker = s.ticker AND ytd.date = pd.ytd
    LEFT JOIN ticker_universe u ON u.ticker = s.ticker
    LEFT JOIN daily_snapshots prev_s ON prev_s.ticker = s.ticker AND prev_s.date = pd.d1
    LEFT JOIN pms_ranked pm ON pm.symbol = s.ticker
    LEFT JOIN physical_momentum_metrics pm_prev ON pm_prev.market = 'JP' AND pm_prev.symbol = s.ticker AND pm_prev.date = pd.d1
    WHERE s.date = ?
    `,
    [date, date, date, date, date, date, date, date, date],
  )
}

/**
 * 短期SMAと長期SMAの差から「角度」を算出する。
 * 直角三角形を考え、隣辺=長期SMA、対辺=(短期SMA-長期SMA) として
 * 傾き = (短期 - 長期) / 長期 を求め、atan() で角度（度）に変換する。
 *  例) 5% 上向き → atan(0.05) ≒ 2.86°
 *      30% 上向き → atan(0.30) ≒ 16.7°
 */
function smaAngleDegrees(shortSma: number | null, longSma: number | null): number | null {
  if (shortSma == null || longSma == null || longSma === 0) return null
  const slope = (shortSma - longSma) / longSma
  return Math.atan(slope) * (180 / Math.PI)
}

function smaChangeAngleDegrees(currentSma: number | null, previousSma: number | null): number | null {
  if (currentSma == null || previousSma == null || previousSma === 0) return null
  const slope = (currentSma - previousSma) / previousSma
  return Math.atan(slope) * (180 / Math.PI)
}

interface SectorEntry {
  sectorLarge: string | null
  sector33: string | null
  marketSegment: string | null
  marginType: string | null
}

async function loadSectorMap(): Promise<Map<string, SectorEntry>> {
  const rows = await execAll<{
    ticker: string
    sector_large: string | null
    sector33: string | null
    market_segment: string | null
    margin_type: string | null
  }>(
    `SELECT ticker, sector_large, sector33, market_segment, margin_type FROM sector_master`,
  )
  const map = new Map<string, SectorEntry>()
  for (const r of rows) {
    map.set(r.ticker, {
      sectorLarge: r.sector_large,
      sector33: r.sector33,
      marketSegment: r.market_segment,
      marginType: r.margin_type,
    })
  }
  return map
}

function buildResultRow(s: SnapshotRow, sectorMap: Map<string, SectorEntry>): ScreenerStockRow | null {
  const master = getTickersByMarket('JP').find((t) => t.ticker === s.ticker)
  const fromDb = sectorMap.get(s.ticker)
  // J-Quants 17/33業種を第一参照にする。
  const sectorLarge = s.sector17_name ?? fromDb?.sectorLarge ?? master?.sectorLarge ?? 'その他'
  const sector33 = s.sector33_name ?? fromDb?.sector33 ?? null
  const marketSegment = s.market_segment ?? fromDb?.marketSegment ?? master?.marketSegment ?? ''
  const marketCapStatus = resolveMarketCapStatus(s, marketSegment, sectorLarge, sector33)
  const lastEarnings = resolveLastEarningsDate(s, marketSegment, sectorLarge, sector33)
  const nextEarnings = resolveNextEarningsDate(s, marketSegment, sectorLarge, sector33)
  return {
    ticker: s.ticker,
    name: s.name ?? master?.name ?? s.ticker,
    market: 'JP',
    marketSegment,
    marginType: s.margin_type ?? fromDb?.marginType ?? master?.marginType,
    sectorLarge,
    sector33,
    sector17Name: s.sector17_name,
    sector33Name: s.sector33_name,
    price: s.price,
    currency: 'JPY',
    changePercent: s.change_percent_1d,
    changePercentWeek: s.perf_pct_1w,
    changePercentMonth: s.perf_pct_1m,
    perfPct3m: s.perf_pct_3m,
    perfPct6m: s.perf_pct_6m,
    perfPctYtd: s.perf_pct_ytd,
    volume: s.volume_1d,
    avgVolume10d: s.avg_volume_10d,
    avgVolume30d: s.avg_volume_30d,
    marketCap: s.market_cap,
    marketCapCurrency: s.market_cap == null ? null : 'JPY',
    marketCapStatus,
    // SMA角度: atan で実際の角度（度）に変換
    sma5Angle: smaChangeAngleDegrees(s.sma_5d, s.sma_5d_prev),
    sma25Angle: smaAngleDegrees(s.sma_5d, s.sma_25d),
    sma75Angle: smaAngleDegrees(s.sma_25d, s.sma_75d),
    sma200Angle: smaChangeAngleDegrees(s.sma_200d, s.sma_200d_prev),
    earningsLastDate: lastEarnings.earningsLastDate,
    earningsLastDateKind: lastEarnings.earningsLastDateKind,
    earningsLastDateSource: lastEarnings.earningsLastDateSource,
    earningsLastFiscalPeriod: lastEarnings.earningsLastFiscalPeriod,
    earningsNextDate: nextEarnings.earningsNextDate,
    earningsNextDateKind: nextEarnings.earningsNextDateKind,
    earningsNextDateSource: nextEarnings.earningsNextDateSource,
    earningsNextFiscalPeriod: nextEarnings.earningsNextFiscalPeriod,
    daily_a_stage: s.daily_a_stage,
    daily_b_stage: s.daily_b_stage,
    weekly_a_stage: s.weekly_a_stage,
    weekly_b_stage: s.weekly_b_stage,
    monthly_a_stage: s.monthly_a_stage,
    monthly_b_stage: s.monthly_b_stage,
    physicalMomentumScore: s.physical_momentum_score,
    physicalForceScore: s.physical_force_score,
    physicalEnergyScore: s.physical_energy_score,
    physicalMomentumRank: s.physical_momentum_rank,
    physicalMomentumTrend:
      s.physical_momentum_score == null || s.physical_momentum_prev_score == null
        ? null
        : s.physical_momentum_score > s.physical_momentum_prev_score
          ? 'rising'
          : s.physical_momentum_score < s.physical_momentum_prev_score
            ? 'falling'
            : 'flat',
    physicalAcceleration: s.physical_acceleration,
    physicalForce: s.physical_force,
  }
}

function resolveLastEarningsDate(
  s: SnapshotRow,
  marketSegment: string,
  sectorLarge: string | null,
  sector33: string | null,
): Pick<ScreenerStockRow, 'earningsLastDate' | 'earningsLastDateKind' | 'earningsLastDateSource' | 'earningsLastFiscalPeriod'> {
  if (s.earnings_last_date) {
    return {
      earningsLastDate: s.earnings_last_date,
      earningsLastDateKind: 'reported',
      earningsLastDateSource: s.earnings_last_source,
      earningsLastFiscalPeriod: s.earnings_last_fiscal_period,
    }
  }

  if (isFundLike(s, marketSegment, sectorLarge, sector33)) {
    return {
      earningsLastDate: null,
      earningsLastDateKind: 'not_applicable',
      earningsLastDateSource: null,
      earningsLastFiscalPeriod: null,
    }
  }

  if (
    (s.earnings_summary_global_earliest_date != null && s.date < s.earnings_summary_global_earliest_date) ||
    (
      Number(s.earnings_summary_count ?? 0) > 0 &&
      s.earnings_summary_earliest_date != null &&
      s.date < s.earnings_summary_earliest_date
    )
  ) {
    return {
      earningsLastDate: null,
      earningsLastDateKind: 'unverified',
      earningsLastDateSource: null,
      earningsLastFiscalPeriod: null,
    }
  }

  return {
    earningsLastDate: null,
    earningsLastDateKind: 'not_collected',
    earningsLastDateSource: null,
    earningsLastFiscalPeriod: null,
  }
}

function resolveNextEarningsDate(
  s: SnapshotRow,
  marketSegment: string,
  sectorLarge: string | null,
  sector33: string | null,
): Pick<ScreenerStockRow, 'earningsNextDate' | 'earningsNextDateKind' | 'earningsNextDateSource' | 'earningsNextFiscalPeriod'> {
  if (s.earnings_next_date) {
    return {
      earningsNextDate: s.earnings_next_date,
      earningsNextDateKind: 'confirmed',
      earningsNextDateSource: s.earnings_next_source,
      earningsNextFiscalPeriod: s.earnings_next_fiscal_period,
    }
  }

  if (isFundLike(s, marketSegment, sectorLarge, sector33)) {
    return {
      earningsNextDate: null,
      earningsNextDateKind: 'not_applicable',
      earningsNextDateSource: null,
      earningsNextFiscalPeriod: null,
    }
  }

  const estimated = estimateNextQuarterlyDate(s.earnings_last_date ?? s.earnings_latest_known_date, s.date)
  if (estimated) {
    return {
      earningsNextDate: estimated,
      earningsNextDateKind: 'estimated',
      earningsNextDateSource: 'estimated_from_previous_earnings',
      earningsNextFiscalPeriod: null,
    }
  }

  return {
    earningsNextDate: null,
    earningsNextDateKind: Number(s.earnings_calendar_count ?? 0) > 0 ? 'not_announced' : 'no_history',
    earningsNextDateSource: null,
    earningsNextFiscalPeriod: null,
  }
}

function estimateNextQuarterlyDate(lastKnownDate: string | null, referenceDate: string): string | null {
  if (!lastKnownDate || !/^\d{4}-\d{2}-\d{2}$/.test(lastKnownDate)) return null
  let candidate = lastKnownDate
  for (let i = 0; i < 8; i++) {
    candidate = nextWeekday(addMonthsClamped(candidate, 3))
    if (candidate > referenceDate) return candidate
  }
  return null
}

function addMonthsClamped(dateStr: string, months: number): string {
  const [year, month, day] = dateStr.split('-').map(Number)
  const targetMonthIndex = month - 1 + months
  const targetYear = year + Math.floor(targetMonthIndex / 12)
  const targetMonth = ((targetMonthIndex % 12) + 12) % 12
  const lastDay = new Date(Date.UTC(targetYear, targetMonth + 1, 0)).getUTCDate()
  const clampedDay = Math.min(day, lastDay)
  return `${targetYear}-${String(targetMonth + 1).padStart(2, '0')}-${String(clampedDay).padStart(2, '0')}`
}

function nextWeekday(dateStr: string): string {
  let time = Date.parse(`${dateStr}T00:00:00.000Z`)
  if (!Number.isFinite(time)) return dateStr
  for (let i = 0; i < 3; i++) {
    const day = new Date(time).getUTCDay()
    if (day >= 1 && day <= 5) {
      const d = new Date(time)
      return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`
    }
    time += 86400000
  }
  return dateStr
}

function isFundLike(
  s: SnapshotRow,
  marketSegment: string,
  sectorLarge: string | null,
  sector33: string | null,
): boolean {
  const text = `${s.name ?? ''} ${marketSegment} ${sectorLarge ?? ''} ${sector33 ?? ''}`.toLowerCase()
  return (
    marketSegment === 'その他' ||
    text.includes('etf') ||
    text.includes('ｅｔｆ') ||
    text.includes('上場投信') ||
    text.includes('投資法人') ||
    text.includes('reit') ||
    text.includes('リート') ||
    text.includes('優先株式')
  )
}

function resolveMarketCapStatus(
  s: SnapshotRow,
  marketSegment: string,
  sectorLarge: string | null,
  sector33: string | null,
): ScreenerStockRow['marketCapStatus'] {
  if (s.market_cap != null && s.market_cap > 0) return 'calculated'
  if (s.price == null || s.price <= 0) return 'price_missing'

  if (isFundLike(s, marketSegment, sectorLarge, sector33)) return 'not_applicable'
  return 'shares_missing'
}

function numParam(searchParams: URLSearchParams, key: string): number | null {
  const raw = searchParams.get(key)
  if (!raw) return null
  const value = Number(raw)
  return Number.isFinite(value) ? value : null
}

function stringSetParam(searchParams: URLSearchParams, key: string): Set<string> {
  return new Set(
    (searchParams.get(key) ?? '')
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean),
  )
}

function parseDateUtc(dateStr: string | null | undefined): number | null {
  if (!dateStr || !/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return null
  const [year, month, day] = dateStr.split('-').map(Number)
  return Date.UTC(year, month - 1, day)
}

function daysSince(dateStr: string | null | undefined, referenceDate: string): number | null {
  const date = parseDateUtc(dateStr)
  const ref = parseDateUtc(referenceDate)
  if (date == null || ref == null) return null
  return Math.round((ref - date) / 86400000)
}

function isWeekdayUtc(time: number): boolean {
  const day = new Date(time).getUTCDay()
  return day >= 1 && day <= 5
}

function businessDaysUntil(dateStr: string | null | undefined, referenceDate: string): number | null {
  const date = parseDateUtc(dateStr)
  const ref = parseDateUtc(referenceDate)
  if (date == null || ref == null) return null
  if (date === ref) return 0
  const direction = date > ref ? 1 : -1
  let count = 0
  for (let time = ref + direction * 86400000; direction > 0 ? time <= date : time >= date; time += direction * 86400000) {
    if (isWeekdayUtc(time)) count += direction
  }
  return count
}

const SORT_KEYS = new Set<ScreenerSortKey>([
  'ticker',
  'marginType',
  'marketSegment',
  'sector33',
  'sectorLarge',
  'name',
  'price',
  'currency',
  'changePercent',
  'changePercentWeek',
  'changePercentMonth',
  'perfPct3m',
  'perfPct6m',
  'perfPctYtd',
  'volume',
  'avgVolume10d',
  'avgVolume30d',
  'marketCap',
  'marketCapCurrency',
  'sma5Angle',
  'sma25Angle',
  'sma75Angle',
  'sma200Angle',
  'physicalMomentumScore',
  'physicalForceScore',
  'physicalEnergyScore',
  'physicalMomentumRank',
  'earningsLastDate',
  'earningsLastElapsedDays',
  'earningsNextDate',
  'earningsNextBusinessDays',
])

function sortValue(row: ScreenerStockRow, key: ScreenerSortKey, referenceDate: string): unknown {
  if (key === 'earningsLastElapsedDays') return daysSince(row.earningsLastDate, referenceDate)
  if (key === 'earningsNextBusinessDays') return businessDaysUntil(row.earningsNextDate, referenceDate)
  return row[key as keyof ScreenerStockRow]
}

function compareNullable(a: unknown, b: unknown, dir: 1 | -1): number {
  if (a == null && b == null) return 0
  if (a == null) return 1
  if (b == null) return -1
  if (typeof a === 'number' && typeof b === 'number') {
    if (!Number.isFinite(a) && !Number.isFinite(b)) return 0
    if (!Number.isFinite(a)) return 1
    if (!Number.isFinite(b)) return -1
    return (a - b) * dir
  }
  return String(a).localeCompare(String(b), 'ja') * dir
}

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url)
    // 当ダッシュボードは日本株専用。market パラメタは互換のため受け取るだけ。
    const segment = searchParams.get('segment')
    const universeFilter = parseUniverseFilter(searchParams.get(UNIVERSE_FILTER_PARAM))
    const requestedDate = searchParams.get('date')
    const marginTypes = stringSetParam(searchParams, 'marginType')
    const sector17 = searchParams.get('sector17')?.trim()
    const sector33 = searchParams.get('sector33')?.trim()
    const marketCapMin = numParam(searchParams, 'marketCapMin')
    const marketCapMax = numParam(searchParams, 'marketCapMax')
    const priceMin = numParam(searchParams, 'priceMin')
    const priceMax = numParam(searchParams, 'priceMax')
    const volumeMin = numParam(searchParams, 'volumeMin')
    const volumeMax = numParam(searchParams, 'volumeMax')
    const pmsMin = numParam(searchParams, 'pmsMin')
    const pfsMin = numParam(searchParams, 'pfsMin')
    const pesMin = numParam(searchParams, 'pesMin')
    const accelerationPositive = searchParams.get('accelerationPositive') === '1'
    const forcePositive = searchParams.get('forcePositive') === '1'
    const stage23Candidate = searchParams.get('stage23Candidate') === '1'
    const pmsTrend = searchParams.get('pmsTrend')
    const rawLimit = numParam(searchParams, 'limit')
    const rawOffset = numParam(searchParams, 'offset')
    const limit = rawLimit == null ? null : Math.min(5000, Math.max(1, Math.floor(rawLimit)))
    const offset = rawOffset == null ? 0 : Math.max(0, Math.floor(rawOffset))
    const requestedSort = searchParams.get('sort') as ScreenerSortKey | null
    const sortKey = requestedSort && SORT_KEYS.has(requestedSort) ? requestedSort : null
    const sortDir: 1 | -1 = searchParams.get('dir') === 'asc' ? 1 : -1

    const date = requestedDate ?? (await latestSnapshotDate())
    if (!date) {
      return NextResponse.json({
        results: [],
        total: 0,
        universe: 0,
        date: null,
        cached: false,
        source: 'jquants',
        notice: 'J-Quants 由来の日次スナップショットが未作成です。最新化バッチを実行してください。',
        filters: { segment, universe: universeFilter },
      })
    }

    // 6系統のステージフィルタ（軸内 OR / 軸間 AND）
    const stageFilter: Partial<Record<typeof STAGE_KEYS[number], number[]>> = {}
    for (const [param, key] of Object.entries(STAGE_PARAM_MAP)) {
      const raw = searchParams.get(param)
      if (!raw) continue
      const stages = raw
        .split(',')
        .map((s) => Number(s.trim()))
        .filter((n) => Number.isInteger(n) && n >= 1 && n <= 6)
      if (stages.length > 0) stageFilter[key] = Array.from(new Set(stages)).sort()
    }

    const [snapshots, sectorMap] = await Promise.all([
      loadSnapshotByDate(date),
      loadSectorMap(),
    ])
    const universe = snapshots.length
    const built = snapshots
      .map((s) => buildResultRow(s, sectorMap))
      .filter((r): r is ScreenerStockRow => r !== null)

    let filtered = filterRowsByUniverse(built, universeFilter)
    if (segment) filtered = filtered.filter((r) => r.marketSegment === segment)
    if (marginTypes.size > 0) {
      filtered = filtered.filter((r) => marginTypes.has(r.marginType?.trim() || '未設定'))
    }
    if (sector17) {
      filtered = filtered.filter((r) => r.sectorLarge === sector17 || r.sector17Name === sector17)
    }
    if (sector33) {
      filtered = filtered.filter((r) => r.sector33 === sector33 || r.sector33Name === sector33)
    }
    if (marketCapMin != null) filtered = filtered.filter((r) => (r.marketCap ?? -Infinity) >= marketCapMin)
    if (marketCapMax != null) filtered = filtered.filter((r) => (r.marketCap ?? Infinity) <= marketCapMax)
    if (priceMin != null) filtered = filtered.filter((r) => (r.price ?? -Infinity) >= priceMin)
    if (priceMax != null) filtered = filtered.filter((r) => (r.price ?? Infinity) <= priceMax)
    if (volumeMin != null) filtered = filtered.filter((r) => (r.volume ?? -Infinity) >= volumeMin)
    if (volumeMax != null) filtered = filtered.filter((r) => (r.volume ?? Infinity) <= volumeMax)
    if (pmsMin != null) filtered = filtered.filter((r) => (r.physicalMomentumScore ?? -Infinity) >= pmsMin)
    if (pfsMin != null) filtered = filtered.filter((r) => (r.physicalForceScore ?? -Infinity) >= pfsMin)
    if (pesMin != null) filtered = filtered.filter((r) => (r.physicalEnergyScore ?? -Infinity) >= pesMin)
    if (accelerationPositive) filtered = filtered.filter((r) => (r.physicalAcceleration ?? -Infinity) > 0)
    if (forcePositive) filtered = filtered.filter((r) => (r.physicalForce ?? -Infinity) > 0)
    if (pmsTrend === 'rising' || pmsTrend === 'falling') {
      filtered = filtered.filter((r) => r.physicalMomentumTrend === pmsTrend)
    }
    if (stage23Candidate) {
      filtered = filtered.filter((r) => (
        (r.daily_a_stage === 2 || r.daily_a_stage === 3)
        && (r.physicalMomentumScore ?? -Infinity) > 0
        && (r.physicalForceScore ?? -Infinity) > 0
      ))
    }

    for (const [key, vals] of Object.entries(stageFilter)) {
      filtered = filtered.filter((r) => {
        const stage = (r as unknown as Record<string, unknown>)[key]
        return typeof stage === 'number' && (vals as number[]).includes(stage)
      })
    }

    const sorted = sortKey
      ? [...filtered].sort((a, b) => {
          const primary = compareNullable(sortValue(a, sortKey, date), sortValue(b, sortKey, date), sortDir)
          if (primary !== 0) return primary
          return a.ticker.localeCompare(b.ticker)
        })
      : filtered
    const paged = limit == null ? sorted.slice(offset) : sorted.slice(offset, offset + limit)

    return NextResponse.json({
      results: paged,
      total: filtered.length,
      universe,
      date,
      cached: true,
      source: 'jquants',
      filters: {
        segment,
        universe: universeFilter,
        marginType: Array.from(marginTypes),
        sector17,
        sector33,
        marketCapMin,
        marketCapMax,
        priceMin,
        priceMax,
        volumeMin,
        volumeMax,
        pmsMin,
        pfsMin,
        pesMin,
        accelerationPositive,
        forcePositive,
        stage23Candidate,
        pmsTrend,
        sort: sortKey,
        dir: sortKey ? (sortDir === 1 ? 'asc' : 'desc') : null,
        limit,
        offset,
        ...stageFilter,
      },
    })
  } catch (error) {
    console.error('Screener API error:', error)
    return NextResponse.json(
      { error: 'Screener failed', message: (error as Error).message },
      { status: 500 },
    )
  }
}
