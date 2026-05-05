// scripts/collect-snapshot.ts
// 全銘柄のスクリーナー情報を取得し SQLite の screener_snapshots テーブルに保存する。
//
// 使い方:
//   npx tsx scripts/collect-snapshot.ts
//   npx tsx scripts/collect-snapshot.ts --market JP
//   npx tsx scripts/collect-snapshot.ts --market US
//
// 推奨: 引け後に cron 等から自動実行
//   30 16 * * 1-5 cd /path/to/stock-dashboard && npx tsx scripts/collect-snapshot.ts >> logs/snapshot.log 2>&1

import { db } from '../lib/db/client'
import { screenerSnapshots } from '../lib/db/schema'
import { ALL_TICKERS, JP_TICKERS, US_TICKERS, MasterTicker } from '../lib/master/tickers'
import { getQuote, getFundamentals, getHistory } from '../lib/yahoo-finance'
import { calcSMA, calcRSI, calcMACD, calcBollingerBands } from '../lib/indicators'

function todayStr(): string {
  return new Date().toISOString().split('T')[0]
}

function nowIso(): string {
  return new Date().toISOString()
}

function parseArgs(): { market: 'JP' | 'US' | 'ALL' } {
  const args = process.argv.slice(2)
  let market: 'JP' | 'US' | 'ALL' = 'ALL'
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--market' && args[i + 1]) {
      const v = args[i + 1].toUpperCase()
      if (v === 'JP' || v === 'US' || v === 'ALL') market = v
    }
  }
  return { market }
}

function selectTickers(market: 'JP' | 'US' | 'ALL'): MasterTicker[] {
  if (market === 'JP') return JP_TICKERS
  if (market === 'US') return US_TICKERS
  return ALL_TICKERS
}

async function processOne(t: MasterTicker, date: string, createdAt: string): Promise<typeof screenerSnapshots.$inferInsert | null> {
  try {
    const [quote, fund, history] = await Promise.all([
      getQuote(t.ticker),
      getFundamentals(t.ticker).catch(() => ({})),
      getHistory(t.ticker, '1y').catch(() => []),
    ])

    // 指標計算
    const sma5 = calcSMA(history, 5)
    const sma25 = calcSMA(history, 25)
    const sma75 = calcSMA(history, 75)
    const rsi = calcRSI(history, 14)
    const { macd, signal, histogram } = calcMACD(history)
    const { upper, lower } = calcBollingerBands(history, 20, 2)

    const last = history.length - 1
    const v5 = sma5[last]
    const v25 = sma25[last]
    const v75 = sma75[last]
    const yearWindow = history.slice(-252)
    const yearHigh = yearWindow.length ? Math.max(...yearWindow.map((d) => d.high)) : null
    const yearLow = yearWindow.length ? Math.min(...yearWindow.map((d) => d.low)) : null

    return {
      date,
      code: t.ticker,
      name: t.name,
      sector33: undefined,
      marketSegment: t.market,
      close: quote.price,
      volume: quote.volume,
      changePercent: quote.changePercent,
      sma5: v5 ?? undefined,
      sma25: v25 ?? undefined,
      sma75: v75 ?? undefined,
      sma5w: undefined,
      sma25w: undefined,
      rsi14: rsi[last] ?? undefined,
      macd: macd[last] ?? undefined,
      macdSignal: signal[last] ?? undefined,
      macdHistogram: histogram[last] ?? undefined,
      bbUpper: upper[last] ?? undefined,
      bbLower: lower[last] ?? undefined,
      isYearHigh: yearHigh != null ? quote.price >= yearHigh : false,
      isYearLow: yearLow != null ? quote.price <= yearLow : false,
      maOrderBullish: v5 != null && v25 != null && v75 != null ? v5 > v25 && v25 > v75 : false,
      maOrderBearish: v5 != null && v25 != null && v75 != null ? v5 < v25 && v25 < v75 : false,
      goldenCross: false,
      deadCross: false,
      createdAt,
    }
  } catch (e) {
    console.error(`  ❌ ${t.ticker} (${t.name}): ${(e as Error).message}`)
    return null
  }
}

async function main() {
  const { market } = parseArgs()
  const tickers = selectTickers(market)
  const date = todayStr()
  const createdAt = nowIso()

  console.log(`📊 スナップショット収集開始 (market=${market}, ${tickers.length}銘柄, date=${date})`)

  const concurrency = 5
  const records: (typeof screenerSnapshots.$inferInsert)[] = []
  let done = 0

  for (let i = 0; i < tickers.length; i += concurrency) {
    const batch = tickers.slice(i, i + concurrency)
    const results = await Promise.all(batch.map((t) => processOne(t, date, createdAt)))
    for (const r of results) if (r) records.push(r)
    done += batch.length
    process.stdout.write(`\r  進捗: ${done}/${tickers.length}`)
    await new Promise((r) => setTimeout(r, 200))
  }
  process.stdout.write('\n')

  console.log(`💾 ${records.length}件をDBに INSERT 中...`)
  if (records.length > 0) {
    db.insert(screenerSnapshots).values(records).run()
  }

  console.log(`✅ 完了: ${records.length}件 / ${tickers.length}銘柄`)
}

main().catch((e) => {
  console.error('Fatal:', e)
  process.exit(1)
})
