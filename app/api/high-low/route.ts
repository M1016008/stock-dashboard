// app/api/high-low/route.ts
// 銘柄マスタを走査して 52週新高値/新安値 を更新中の銘柄を返す。
// しきい値: 新高値 = price >= 52w high * (1 - tolerance), 新安値 = price <= 52w low * (1 + tolerance)
// tolerance のデフォルトは 0.1% (0.001)。

import { NextRequest, NextResponse } from 'next/server'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { getTickersByMarket } from '@/lib/master/tickers'
import { getQuote } from '@/lib/yahoo-finance'

export const dynamic = 'force-dynamic'
export const maxDuration = 300

interface HighLowRow {
  ticker: string
  name: string
  market: 'JP' | 'US'
  price: number
  changePercent: number
  volume: number
  fiftyTwoWeekHigh?: number
  fiftyTwoWeekLow?: number
  /** 52週高値（または安値）からの距離（%）。正なら高値より上、負なら下 */
  distanceFromHigh?: number
  distanceFromLow?: number
}

const SNAPSHOT_DIR = path.join(process.cwd(), 'data', 'snapshots')

function todayStr(): string {
  return new Date().toISOString().split('T')[0]
}

function snapshotPath(market: string): string {
  return path.join(SNAPSHOT_DIR, `high-low_${market}_${todayStr()}.json`)
}

async function loadSnapshot(market: string): Promise<HighLowRow[] | null> {
  try {
    const buf = await fs.readFile(snapshotPath(market), 'utf-8')
    return JSON.parse(buf) as HighLowRow[]
  } catch {
    return null
  }
}

async function saveSnapshot(market: string, rows: HighLowRow[]): Promise<void> {
  try {
    await fs.mkdir(SNAPSHOT_DIR, { recursive: true })
    await fs.writeFile(snapshotPath(market), JSON.stringify(rows, null, 2), 'utf-8')
  } catch (e) {
    console.error('saveSnapshot error:', e)
  }
}

async function fetchOne(t: { ticker: string; name: string; market: 'JP' | 'US' }): Promise<HighLowRow | null> {
  try {
    const q = await getQuote(t.ticker)
    const high = q.fiftyTwoWeekHigh
    const low = q.fiftyTwoWeekLow
    return {
      ticker: t.ticker,
      name: t.name,
      market: t.market,
      price: q.price,
      changePercent: q.changePercent,
      volume: q.volume,
      fiftyTwoWeekHigh: high,
      fiftyTwoWeekLow: low,
      distanceFromHigh: high ? ((q.price - high) / high) * 100 : undefined,
      distanceFromLow: low ? ((q.price - low) / low) * 100 : undefined,
    }
  } catch {
    return null
  }
}

async function fetchAll(
  tickers: { ticker: string; name: string; market: 'JP' | 'US' }[],
  concurrency = 5,
): Promise<HighLowRow[]> {
  const results: HighLowRow[] = []
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
    const market = (searchParams.get('market') ?? 'ALL') as 'JP' | 'US' | 'ALL'
    const type = (searchParams.get('type') ?? 'high') as 'high' | 'low'
    const tolerance = Number(searchParams.get('tolerance') ?? '0.001') // 0.1%
    const minVolume = Number(searchParams.get('minVolume') ?? '0')

    let rows = await loadSnapshot(market)
    let cached = true
    if (!rows) {
      cached = false
      const tickers = getTickersByMarket(market)
      rows = await fetchAll(tickers)
      await saveSnapshot(market, rows)
    }

    let filtered: HighLowRow[]
    if (type === 'high') {
      // 新高値: price が 52週高値の (1 - tolerance) 以上
      filtered = rows.filter((r) =>
        r.fiftyTwoWeekHigh !== undefined &&
        r.price >= r.fiftyTwoWeekHigh * (1 - tolerance) &&
        r.volume >= minVolume,
      )
      filtered.sort((a, b) => (a.distanceFromHigh ?? -Infinity) > (b.distanceFromHigh ?? -Infinity) ? -1 : 1)
    } else {
      filtered = rows.filter((r) =>
        r.fiftyTwoWeekLow !== undefined &&
        r.price <= r.fiftyTwoWeekLow * (1 + tolerance) &&
        r.volume >= minVolume,
      )
      filtered.sort((a, b) => (a.distanceFromLow ?? Infinity) < (b.distanceFromLow ?? Infinity) ? -1 : 1)
    }

    return NextResponse.json({
      type,
      results: filtered,
      total: filtered.length,
      universe: rows.length,
      cached,
      date: todayStr(),
    })
  } catch (error) {
    console.error('High-low API error:', error)
    return NextResponse.json(
      { error: 'High-low failed', message: (error as Error).message },
      { status: 500 },
    )
  }
}
