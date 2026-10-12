import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

type DirectPrice = { date: string; close: number }
type DirectStages = {
  daily_a_stage: number | null
  daily_b_stage: number | null
  weekly_a_stage: number | null
  weekly_b_stage: number | null
  monthly_a_stage: number | null
  monthly_b_stage: number | null
}

async function main() {
  // A failed local probe must never create or mutate Production's global incident latch.
  const incidentDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'stockboard-stock-preview-incidents-'),
  )
  process.env.STOCK_DATA_INCIDENT_DIR = incidentDir
  process.once('exit', () => fs.rmSync(incidentDir, { recursive: true, force: true }))
  const [{ execGet }, { getStockPreview }, { STOCK_PREVIEW_STAGE_ORDER }] = await Promise.all([
    import('@/lib/db/client'),
    import('@/lib/server/stock-preview-read-model'),
    import('@/lib/stock-preview'),
  ])
  const ticker = '7203'
  const pitDate = '2025-08-25'
  const [latest, pit, usLatest, directPitPrice, directPitStages] = await Promise.all([
    getStockPreview({ ticker }),
    getStockPreview({ ticker, asOf: pitDate, includeChart: true }),
    getStockPreview({ ticker: 'AAPL', market: 'US', includeChart: true }),
    execGet<DirectPrice>('SELECT date, close FROM ohlcv_daily WHERE ticker = ? AND date <= ? ORDER BY date DESC LIMIT 1', [ticker, pitDate]),
    execGet<DirectStages>(`
      SELECT daily_a_stage, daily_b_stage, weekly_a_stage, weekly_b_stage, monthly_a_stage, monthly_b_stage
      FROM daily_snapshots WHERE ticker = ? AND date <= ? ORDER BY date DESC LIMIT 1
    `, [ticker, pitDate]),
  ])

  assert.ok(latest, 'latest preview must exist')
  assert.ok(pit, 'PIT preview must exist')
  assert.ok(usLatest, 'US preview must exist')
  assert.ok(directPitPrice, 'direct PIT price must exist')
  assert.ok(directPitStages, 'direct PIT stages must exist')
  assert.equal(latest.requestedAsOf, null)
  assert.equal(latest.chart, undefined, 'Quick View must not include chart payload')
  assert.equal(pit.requestedAsOf, pitDate)
  assert.equal(pit.priceDate, directPitPrice.date)
  assert.equal(pit.price, Number(directPitPrice.close))
  assert.ok(pit.priceDate <= pitDate)
  assert.ok((pit.chart?.length ?? 0) > 1200, 'Quick Chart should include enough warm-up history for the monthly 60MA')
  assert.ok((pit.chart?.length ?? 0) <= 1400)
  assert.equal(pit.chart?.at(-1)?.date, pit.priceDate)
  assert.ok(pit.chart?.every((row) => row.date <= pitDate))
  assert.deepEqual(pit.stages, {
    dailyA: directPitStages.daily_a_stage,
    dailyB: directPitStages.daily_b_stage,
    weeklyA: directPitStages.weekly_a_stage,
    weeklyB: directPitStages.weekly_b_stage,
    monthlyA: directPitStages.monthly_a_stage,
    monthlyB: directPitStages.monthly_b_stage,
  })
  assert.deepEqual(STOCK_PREVIEW_STAGE_ORDER, ['dailyA', 'dailyB', 'weeklyA', 'weeklyB', 'monthlyA', 'monthlyB'])
  assert.equal(usLatest.market, 'US')
  assert.notEqual(usLatest.name, usLatest.ticker, 'US preview should use the registered display name')
  assert.ok((usLatest.chart?.length ?? 0) > 250)
  assert.equal(usLatest.chart?.at(-1)?.date, usLatest.priceDate)
  assert.equal(usLatest.stageDate, usLatest.priceDate)

  const usPit = await getStockPreview({
    ticker: 'AAPL',
    market: 'US',
    asOf: usLatest.priceDate,
  })
  assert.ok(usPit, 'US PIT preview must exist')
  assert.equal(usPit.requestedAsOf, usLatest.priceDate)
  assert.equal(usPit.priceDate, usLatest.priceDate)
  assert.equal(usPit.marketCap, null, 'US PIT preview must not combine historical price with current shares')
  assert.equal(usPit.marketCapBasis, 'missing')

  const hookSource = fs.readFileSync(path.join(process.cwd(), 'lib/client/use-stock-preview-data.ts'), 'utf8')
  assert.match(hookSource, /if \(!input\.enabled\) return/, 'preview must remain lazy until opened')
  assert.match(hookSource, /controller\.abort\(\)/, 'stale requests must be aborted')
  assert.match(hookSource, /LATEST_TTL_MS = 60_000/)
  assert.match(hookSource, /PIT_TTL_MS = 24 \* 60 \* 60 \* 1000/)
  assert.match(hookSource, /state\.key === key/, 'a ticker change must invalidate stale preview data synchronously')
  assert.match(hookSource, /MAX_CACHE_ENTRIES = 80/, 'preview LRU must remain bounded')

  const integrationFiles = [
    'app/period-explorer/PeriodExplorerClient.tsx',
    'app/screener/page.tsx',
    'components/screener/IntegratedScreener.tsx',
    'app/sectors/page.tsx',
    'components/sectors/SectorStructureBoard.tsx',
    'app/watchlist/page.tsx',
    'app/backtest/page.tsx',
    'components/dashboard/DashboardTradeSignalTableClient.tsx',
    'components/dashboard/PhysicalMomentumMarket.tsx',
    'components/dashboard/DashboardEarningsAlerts.tsx',
    'components/dashboard/KabutanMaterialNews.tsx',
  ]
  for (const file of integrationFiles) {
    const source = fs.readFileSync(path.join(process.cwd(), file), 'utf8')
    assert.match(source, /StockPreviewTrigger/, `${file} must use the shared stock preview trigger`)
  }
  const stockDetailSource = fs.readFileSync(path.join(process.cwd(), 'app/stock/[ticker]/StockDetailClient.tsx'), 'utf8')
  assert.doesNotMatch(stockDetailSource, /StockPreviewTrigger/, 'individual stock pages must not mount quick previews')
  const previewSource = fs.readFileSync(path.join(process.cwd(), 'components/stock-preview/StockPreviewTrigger.tsx'), 'utf8')
  assert.match(
    previewSource,
    /us \? \([\s\S]*label="52週レンジ"[\s\S]*\) : \([\s\S]*label="信用区分"/,
    'US preview must replace the JP-only margin classification with a US-relevant price range',
  )
  assert.match(
    previewSource,
    /株価・ステージ・出来高は基準日（米国時間の終値）時点/,
    'US dated preview must explain which values are point-in-time',
  )

  console.log(JSON.stringify({
    ok: true,
    ticker,
    latest: { priceDate: latest.priceDate, stages: latest.stages, elapsedMs: latest.elapsedMs },
    pit: {
      requestedAsOf: pitDate,
      priceDate: pit.priceDate,
      chartRows: pit.chart?.length ?? 0,
      chartStart: pit.chart?.at(0)?.date ?? null,
      chartEnd: pit.chart?.at(-1)?.date ?? null,
      stages: pit.stages,
      elapsedMs: pit.elapsedMs,
    },
    us: {
      ticker: usLatest.ticker,
      name: usLatest.name,
      priceDate: usLatest.priceDate,
      pitMarketCap: usPit.marketCap,
      pitMarketCapBasis: usPit.marketCapBasis,
      chartRows: usLatest.chart?.length ?? 0,
      stages: usLatest.stages,
      elapsedMs: usLatest.elapsedMs,
    },
    integrationsChecked: integrationFiles.length,
  }, null, 2))
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
