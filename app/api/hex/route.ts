// app/api/hex/route.ts
// HEX-app 互換 API。マスタ銘柄を Yahoo Finance から取得し、6 ステージを算出して返す。
//
// HEX-app 本家との違い:
// - データソースは Yahoo Finance（Supabase ではない）
// - 前週/前々週ステージは現状 null（SQLite に履歴蓄積後に対応予定）
// - SMA 角度は当日 OHLCV の T-3 / T-10 / T-20 オフセットから計算

import { NextRequest, NextResponse } from 'next/server'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { ALL_TICKERS, JP_TICKERS, US_TICKERS, getSectorLarge, type MasterTicker } from '@/lib/master/tickers'
import { getQuote, getHistory } from '@/lib/yahoo-finance'
import {
  buildMaValuesFromOhlcv,
  buildMaValuesAtOffset,
  calculateAllStages,
  calculateAngle,
} from '@/lib/hex-stage'

export const dynamic = 'force-dynamic'
export const maxDuration = 300

const SNAPSHOT_DIR = path.join(process.cwd(), 'data', 'snapshots')

function todayStr(): string {
  return new Date().toISOString().split('T')[0]
}

function snapshotPath(market: string): string {
  return path.join(SNAPSHOT_DIR, `hex_${market}_${todayStr()}.json`)
}

interface HexStock {
  code: string
  name: string
  sector_large: string
  sector_small: string | null
  market_cap: number
  price: number
  daily_change: number
  weekly_change: number
  monthly_change: number
  months3_change: number
  months6_change: number
  ytd_change: number
  stage: number
  stage_a: number | null
  stage_b: number | null
  daily_a_stage: number | null
  daily_b_stage: number | null
  weekly_a_stage: number | null
  weekly_b_stage: number | null
  monthly_a_stage: number | null
  monthly_b_stage: number | null
  prev_daily_a_stage: number | null
  prev_daily_b_stage: number | null
  prev_weekly_a_stage: number | null
  prev_weekly_b_stage: number | null
  prev_monthly_a_stage: number | null
  prev_monthly_b_stage: number | null
  prev_prev_daily_a_stage: number | null
  prev_prev_daily_b_stage: number | null
  prev_prev_weekly_a_stage: number | null
  prev_prev_weekly_b_stage: number | null
  prev_prev_monthly_a_stage: number | null
  prev_prev_monthly_b_stage: number | null
  sma_angles: { sma5: number | null; sma25: number | null; sma75: number | null; sma300: number | null }
  prev_sma_angles: { sma5: number | null; sma25: number | null; sma75: number | null; sma300: number | null }
  prev_prev_sma_angles: { sma5: number | null; sma25: number | null; sma75: number | null; sma300: number | null }
}

async function loadSnapshot(market: string): Promise<HexStock[] | null> {
  try {
    const buf = await fs.readFile(snapshotPath(market), 'utf-8')
    return JSON.parse(buf) as HexStock[]
  } catch {
    return null
  }
}

async function saveSnapshot(market: string, rows: HexStock[]): Promise<void> {
  try {
    await fs.mkdir(SNAPSHOT_DIR, { recursive: true })
    await fs.writeFile(snapshotPath(market), JSON.stringify(rows), 'utf-8')
  } catch (e) {
    console.error('saveSnapshot error:', e)
  }
}

function selectTickers(market: 'JP' | 'US' | 'ALL'): MasterTicker[] {
  if (market === 'JP') return JP_TICKERS
  if (market === 'US') return US_TICKERS
  return ALL_TICKERS
}

function pctFromHistory(ohlcv: { close: number }[], periodsBack: number): number {
  if (ohlcv.length <= periodsBack) return 0
  const last = ohlcv[ohlcv.length - 1]?.close
  const prev = ohlcv[ohlcv.length - 1 - periodsBack]?.close
  if (!last || !prev || prev === 0) return 0
  return ((last - prev) / prev) * 100
}

async function fetchOne(t: MasterTicker): Promise<HexStock | null> {
  try {
    const [quote, history] = await Promise.all([
      getQuote(t.ticker),
      getHistory(t.ticker, '2y'),
    ])

    if (!history || history.length < 5) {
      return null
    }

    const maNow = buildMaValuesFromOhlcv(history)
    const stages = calculateAllStages(maNow)

    const ma3 = buildMaValuesAtOffset(history, 3)
    const ma10 = buildMaValuesAtOffset(history, 10)
    const ma20 = buildMaValuesAtOffset(history, 20)

    const smaAngles = {
      sma5: calculateAngle(maNow.ma_5, ma3?.ma_5 ?? null, 3),
      sma25: calculateAngle(maNow.ma_25, ma3?.ma_25 ?? null, 3),
      sma75: calculateAngle(maNow.ma_75, ma3?.ma_75 ?? null, 3),
      sma300: calculateAngle(maNow.ma_300, ma3?.ma_300 ?? null, 3),
    }
    const prevSmaAngles = {
      sma5: calculateAngle(maNow.ma_5, ma10?.ma_5 ?? null, 10),
      sma25: calculateAngle(maNow.ma_25, ma10?.ma_25 ?? null, 10),
      sma75: calculateAngle(maNow.ma_75, ma10?.ma_75 ?? null, 10),
      sma300: calculateAngle(maNow.ma_300, ma10?.ma_300 ?? null, 10),
    }
    const prevPrevSmaAngles = {
      sma5: calculateAngle(maNow.ma_5, ma20?.ma_5 ?? null, 20),
      sma25: calculateAngle(maNow.ma_25, ma20?.ma_25 ?? null, 20),
      sma75: calculateAngle(maNow.ma_75, ma20?.ma_75 ?? null, 20),
      sma300: calculateAngle(maNow.ma_300, ma20?.ma_300 ?? null, 20),
    }

    return {
      code: t.ticker,
      name: t.name,
      sector_large: getSectorLarge(t),
      sector_small: t.sectorSmall ?? null,
      market_cap: quote.marketCap ?? 0,
      price: quote.price,
      daily_change: quote.changePercent,
      weekly_change: pctFromHistory(history, 5),
      monthly_change: pctFromHistory(history, 21),
      months3_change: pctFromHistory(history, 63),
      months6_change: pctFromHistory(history, 126),
      ytd_change: pctFromHistory(history, 252),
      stage: stages.daily_a_stage ?? 1,
      stage_a: stages.daily_a_stage,
      stage_b: stages.daily_b_stage,
      daily_a_stage: stages.daily_a_stage,
      daily_b_stage: stages.daily_b_stage,
      weekly_a_stage: stages.weekly_a_stage,
      weekly_b_stage: stages.weekly_b_stage,
      monthly_a_stage: stages.monthly_a_stage,
      monthly_b_stage: stages.monthly_b_stage,
      // 履歴未蓄積のため null
      prev_daily_a_stage: null,
      prev_daily_b_stage: null,
      prev_weekly_a_stage: null,
      prev_weekly_b_stage: null,
      prev_monthly_a_stage: null,
      prev_monthly_b_stage: null,
      prev_prev_daily_a_stage: null,
      prev_prev_daily_b_stage: null,
      prev_prev_weekly_a_stage: null,
      prev_prev_weekly_b_stage: null,
      prev_prev_monthly_a_stage: null,
      prev_prev_monthly_b_stage: null,
      sma_angles: smaAngles,
      prev_sma_angles: prevSmaAngles,
      prev_prev_sma_angles: prevPrevSmaAngles,
    }
  } catch (e) {
    console.error(`hex fetchOne error for ${t.ticker}:`, e)
    return null
  }
}

async function fetchAll(tickers: MasterTicker[], concurrency = 5): Promise<HexStock[]> {
  const results: HexStock[] = []
  for (let i = 0; i < tickers.length; i += concurrency) {
    const batch = tickers.slice(i, i + concurrency)
    const chunk = await Promise.all(batch.map(fetchOne))
    for (const r of chunk) if (r) results.push(r)
    await new Promise((r) => setTimeout(r, 200))
  }
  return results
}

function applyTimeframeStage(rows: HexStock[], timeframe: 'daily' | 'weekly' | 'monthly'): HexStock[] {
  // HEX-app の API は timeframe に応じて `stage` フィールドを上書き
  return rows.map((r) => {
    let stage = r.stage
    if (timeframe === 'weekly') stage = r.weekly_a_stage ?? r.stage
    else if (timeframe === 'monthly') stage = r.monthly_a_stage ?? r.stage
    else stage = r.daily_a_stage ?? r.stage
    return { ...r, stage }
  })
}

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url)
    const market = (searchParams.get('market') ?? 'JP') as 'JP' | 'US' | 'ALL'
    const timeframe = (searchParams.get('timeframe') ?? 'daily') as 'daily' | 'weekly' | 'monthly'

    let rows = await loadSnapshot(market)
    let cached = true
    if (!rows) {
      cached = false
      const tickers = selectTickers(market)
      rows = await fetchAll(tickers)
      await saveSnapshot(market, rows)
    }

    const data = applyTimeframeStage(rows, timeframe)

    return NextResponse.json({
      success: true,
      data,
      count: data.length,
      cached,
      date: todayStr(),
      timeframe,
      market,
    })
  } catch (error) {
    console.error('Hex API error:', error)
    return NextResponse.json(
      { error: 'Hex map fetch failed', message: (error as Error).message },
      { status: 500 },
    )
  }
}
