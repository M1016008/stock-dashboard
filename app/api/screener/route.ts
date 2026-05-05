// app/api/screener/route.ts
// マルチ軸スクリーナー API:
//   - market: JP/US/ALL
//   - segment: プライム/スタンダード/グロース or NYSE/NASDAQ
//   - daily_a / daily_b / weekly_a / weekly_b / monthly_a / monthly_b:
//       各系統で 1..6 を指定（カンマ区切りで複数指定可、例: daily_a=1,2,3）
// 軸内は OR、軸間は AND で絞り込む。

import { NextRequest, NextResponse } from 'next/server'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { getTickersByMarket, type MasterTicker } from '@/lib/master/tickers'
import { getQuote, getFundamentals, getHistory } from '@/lib/yahoo-finance'
import { buildMaValuesFromOhlcv, calculateAllStages } from '@/lib/hex-stage'
import type { Fundamentals, OHLCV } from '@/types/stock'

export const dynamic = 'force-dynamic'
export const maxDuration = 300

const SNAPSHOT_DIR = path.join(process.cwd(), 'data', 'snapshots')

interface ScreenerStockRow {
  ticker: string
  name: string
  market: 'JP' | 'US'
  marketSegment: string
  marginType?: string
  sectorLarge: string
  price: number
  changePercent: number
  changePercentWeek?: number
  changePercentMonth?: number
  volume: number
  marketCap?: number
  per?: number
  pbr?: number
  roe?: number
  dividendYield?: number
  sma25Angle?: number
  sma75Angle?: number
  daily_a_stage: number | null
  daily_b_stage: number | null
  weekly_a_stage: number | null
  weekly_b_stage: number | null
  monthly_a_stage: number | null
  monthly_b_stage: number | null
}

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

function todayStr(): string {
  return new Date().toISOString().split('T')[0]
}

function snapshotPath(market: string): string {
  return path.join(SNAPSHOT_DIR, `screener_v3_${market}_${todayStr()}.json`)
}

async function loadSnapshot(market: string): Promise<ScreenerStockRow[] | null> {
  try {
    const buf = await fs.readFile(snapshotPath(market), 'utf-8')
    return JSON.parse(buf) as ScreenerStockRow[]
  } catch {
    return null
  }
}

async function saveSnapshot(market: string, rows: ScreenerStockRow[]): Promise<void> {
  try {
    await fs.mkdir(SNAPSHOT_DIR, { recursive: true })
    await fs.writeFile(snapshotPath(market), JSON.stringify(rows), 'utf-8')
  } catch (e) {
    console.error('saveSnapshot error:', e)
  }
}

function pctChange(curr: number | undefined, prev: number | undefined): number | undefined {
  if (curr == null || prev == null || prev === 0) return undefined
  return ((curr - prev) / prev) * 100
}

function sma(values: number[]): number | undefined {
  if (values.length === 0) return undefined
  const sum = values.reduce((s, v) => s + v, 0)
  return sum / values.length
}

/**
 * 直近の終値変化率（％）を計算する。
 * tradingDaysBack 営業日前の終値と、最新終値の差。
 */
function changeOver(history: OHLCV[], tradingDaysBack: number): number | undefined {
  if (history.length <= tradingDaysBack) return undefined
  const latest = history[history.length - 1]?.close
  const past = history[history.length - 1 - tradingDaysBack]?.close
  return pctChange(latest, past)
}

/**
 * SMA の角度（％）を計算する。
 * 直近の SMA 値と lookback 営業日前の SMA 値の差を％で表す。
 * window: SMA の期間（例 25, 75）。
 * lookback: SMA を比較する期間（例 5, 10）。
 */
function smaAngle(history: OHLCV[], window: number, lookback: number): number | undefined {
  if (history.length < window + lookback) return undefined
  const closes = history.map((h) => h.close)
  const latestSma = sma(closes.slice(closes.length - window))
  const pastSma = sma(closes.slice(closes.length - window - lookback, closes.length - lookback))
  return pctChange(latestSma, pastSma)
}

async function fetchOne(t: MasterTicker): Promise<ScreenerStockRow | null> {
  try {
    const [quote, fund, history] = await Promise.all([
      getQuote(t.ticker),
      getFundamentals(t.ticker).catch(() => ({} as Fundamentals)),
      getHistory(t.ticker, '2y').catch(() => [] as OHLCV[]),
    ])

    const ma = buildMaValuesFromOhlcv(history)
    const stages = calculateAllStages(ma)

    return {
      ticker: t.ticker,
      name: t.name,
      market: t.market,
      marketSegment: t.marketSegment,
      marginType: t.marginType,
      sectorLarge: t.sectorLarge,
      price: quote.price,
      changePercent: quote.changePercent,
      changePercentWeek: changeOver(history, 5),
      changePercentMonth: changeOver(history, 21),
      volume: quote.volume,
      marketCap: quote.marketCap,
      per: fund.per,
      pbr: fund.pbr,
      roe: fund.roe,
      dividendYield: fund.dividendYield,
      sma25Angle: smaAngle(history, 25, 5),
      sma75Angle: smaAngle(history, 75, 10),
      daily_a_stage: stages.daily_a_stage,
      daily_b_stage: stages.daily_b_stage,
      weekly_a_stage: stages.weekly_a_stage,
      weekly_b_stage: stages.weekly_b_stage,
      monthly_a_stage: stages.monthly_a_stage,
      monthly_b_stage: stages.monthly_b_stage,
    }
  } catch (e) {
    console.error(`screener fetchOne error for ${t.ticker}:`, e)
    return null
  }
}

async function fetchAll(tickers: MasterTicker[], concurrency = 5): Promise<ScreenerStockRow[]> {
  const results: ScreenerStockRow[] = []
  for (let i = 0; i < tickers.length; i += concurrency) {
    const batch = tickers.slice(i, i + concurrency)
    const chunk = await Promise.all(batch.map(fetchOne))
    for (const r of chunk) if (r) results.push(r)
    await new Promise((r) => setTimeout(r, 200))
  }
  return results
}

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url)
    const market = (searchParams.get('market') ?? 'JP') as 'JP' | 'US' | 'ALL'
    const segment = searchParams.get('segment')

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

    let rows = await loadSnapshot(market)
    let cached = true
    if (!rows) {
      cached = false
      const tickers = getTickersByMarket(market)
      rows = await fetchAll(tickers)
      await saveSnapshot(market, rows)
    }

    let filtered = rows
    if (segment) filtered = filtered.filter((r) => r.marketSegment === segment)

    // ステージフィルタ: 軸内は OR、軸間は AND
    for (const [key, vals] of Object.entries(stageFilter)) {
      filtered = filtered.filter((r) => {
        const stage = (r as unknown as Record<string, unknown>)[key]
        return typeof stage === 'number' && (vals as number[]).includes(stage)
      })
    }

    return NextResponse.json({
      results: filtered,
      total: filtered.length,
      universe: rows.length,
      cached,
      date: todayStr(),
      filters: { market, segment, ...stageFilter },
    })
  } catch (error) {
    console.error('Screener API error:', error)
    return NextResponse.json(
      { error: 'Screener failed', message: (error as Error).message },
      { status: 500 },
    )
  }
}
