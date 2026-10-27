import { execAll, execGet } from '@/lib/db/client'

export type UsSectorEtfCatalogItem = {
  ticker: string
  sector: string
  shortName: string
  description: string
  sourceUrl: string
}
// Select Sector SPDRs are the established, exchange-traded sector proxies used by
// this bounded view. This catalog identifies instruments only; it is not a
// holdings data source and must not be used to infer constituents or weights.
export const US_SECTOR_ETF_CATALOG: readonly UsSectorEtfCatalogItem[] = [
  { ticker: 'XLB', sector: 'Materials', shortName: 'Materials', description: '米国素材セクターの価格・ステージを確認します。', sourceUrl: 'https://www.sectorspdrs.com/mainfund/xlb' },
  { ticker: 'XLC', sector: 'Communication Services', shortName: 'Communication Services', description: '米国コミュニケーション・サービスの価格・ステージを確認します。', sourceUrl: 'https://www.sectorspdrs.com/mainfund/xlc' },
  { ticker: 'XLE', sector: 'Energy', shortName: 'Energy', description: '米国エネルギーセクターの価格・ステージを確認します。', sourceUrl: 'https://www.sectorspdrs.com/mainfund/xle' },
  { ticker: 'XLF', sector: 'Financials', shortName: 'Financials', description: '米国金融セクターの価格・ステージを確認します。', sourceUrl: 'https://www.sectorspdrs.com/mainfund/xlf' },
  { ticker: 'XLI', sector: 'Industrials', shortName: 'Industrials', description: '米国資本財・産業セクターの価格・ステージを確認します。', sourceUrl: 'https://www.sectorspdrs.com/mainfund/xli' },
  { ticker: 'XLK', sector: 'Technology', shortName: 'Technology', description: '米国情報技術セクターの価格・ステージを確認します。', sourceUrl: 'https://www.sectorspdrs.com/mainfund/xlk' },
  { ticker: 'XLP', sector: 'Consumer Staples', shortName: 'Consumer Staples', description: '米国生活必需品セクターの価格・ステージを確認します。', sourceUrl: 'https://www.sectorspdrs.com/mainfund/xlp' },
  { ticker: 'XLRE', sector: 'Real Estate', shortName: 'Real Estate', description: '米国不動産セクターの価格・ステージを確認します。', sourceUrl: 'https://www.sectorspdrs.com/mainfund/xlre' },
  { ticker: 'XLU', sector: 'Utilities', shortName: 'Utilities', description: '米国公益セクターの価格・ステージを確認します。', sourceUrl: 'https://www.sectorspdrs.com/mainfund/xlu' },
  { ticker: 'XLV', sector: 'Health Care', shortName: 'Health Care', description: '米国ヘルスケアセクターの価格・ステージを確認します。', sourceUrl: 'https://www.sectorspdrs.com/mainfund/xlv' },
  { ticker: 'XLY', sector: 'Consumer Discretionary', shortName: 'Consumer Discretionary', description: '米国一般消費財セクターの価格・ステージを確認します。', sourceUrl: 'https://www.sectorspdrs.com/mainfund/xly' },
] as const

export type UsSectorEtfStages = {
  dailyA: number | null
  dailyB: number | null
  weeklyA: number | null
  weeklyB: number | null
  monthlyA: number | null
  monthlyB: number | null
}

export type UsSectorEtfMetric = UsSectorEtfCatalogItem & {
  price: number | null
  priceDate: string | null
  previousPrice: number | null
  previousPriceDate: string | null
  change: number | null
  changePct: number | null
  priceSource: string | null
  importedAt: number | null
  stageDate: string | null
  stages: UsSectorEtfStages
  stageCode: string | null
  maOrderDaily: string | null
  dataStatus: 'ready' | 'price_missing' | 'stage_partial'
}

export type UsSectorEtfBoard = {
  status: 'ready' | 'empty'
  requestedDate: string | null
  asOfDate: string | null
  metrics: UsSectorEtfMetric[]
  coverage: {
    catalog: number
    priced: number
    adjustedPrice: number
    staged: number
    completeStage: number
    missingPriceTickers: string[]
    missingStageTickers: string[]
  }
  summary: {
    advancing: number
    declining: number
    unchanged: number
    stageOneOrSix: number
    stageFour: number
  }
  lineage: {
    market: 'US'
    priceBasis: 'ADJUSTED_CLOSE'
    stageBasis: 'MARKET_DAILY_SNAPSHOTS_EXACT_AS_OF'
    holdingsBasis: 'UNAVAILABLE'
    sources: string[]
    latestImportedAt: number | null
  }
}
type PriceRow = {
  ticker: string
  date: string
  adj_close: number | null
  source: string | null
  imported_at: number | null
  rn: number
}

type SnapshotRow = {
  ticker: string
  date: string
  ma_5: number | null
  ma_25: number | null
  ma_75: number | null
  daily_a_stage: number | null
  daily_b_stage: number | null
  weekly_a_stage: number | null
  weekly_b_stage: number | null
  monthly_a_stage: number | null
  monthly_b_stage: number | null
}

function placeholders(count: number): string {
  return Array.from({ length: count }, () => '?').join(',')
}

function numeric(value: unknown): number | null {
  if (value == null || value === '') return null
  const parsed = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function stage(value: unknown): number | null {
  const parsed = numeric(value)
  return parsed != null && Number.isInteger(parsed) && parsed >= 1 && parsed <= 6 ? parsed : null
}

function stageCode(stages: UsSectorEtfStages): string | null {
  const values = [stages.dailyA, stages.dailyB, stages.weeklyA, stages.weeklyB, stages.monthlyA, stages.monthlyB]
  return values.every((value) => value != null) ? values.join('') : null
}

function maOrder(row: SnapshotRow | undefined): string | null {
  if (!row) return null
  const entries: Array<[string, number | null]> = [
    ['5日', numeric(row.ma_5)],
    ['25日', numeric(row.ma_25)],
    ['75日', numeric(row.ma_75)],
  ]
  if (entries.some(([, value]) => value == null)) return null
  return entries.sort((left, right) => (right[1] ?? 0) - (left[1] ?? 0)).map(([label]) => label).join(' > ')
}

async function resolveAsOfDate(requestedDate: string | null, tickers: readonly string[]): Promise<string | null> {
  const inSql = placeholders(tickers.length)
  if (requestedDate) {
    const exact = await execGet<{ date: string }>(
      `SELECT date
       FROM market_ohlcv_daily INDEXED BY market_ohlcv_market_date_ticker_idx
       WHERE market = 'US' AND date = ? AND ticker IN (${inSql})
       LIMIT 1`,
      [requestedDate, ...tickers],
    )
    return exact?.date ?? null
  }
  const latest = await execGet<{ date: string | null }>(
    `SELECT MAX(date) AS date
     FROM market_ohlcv_daily INDEXED BY market_ohlcv_market_date_idx
     WHERE market = 'US' AND ticker IN (${inSql})`,
    tickers,
  )
  return latest?.date ?? null
}

export async function loadUsSectorEtfBoard(requestedDate: string | null = null): Promise<UsSectorEtfBoard> {
  const tickers = US_SECTOR_ETF_CATALOG.map((item) => item.ticker)
  const asOfDate = await resolveAsOfDate(requestedDate, tickers)
  const emptyBoard: UsSectorEtfBoard = {
    status: 'empty',
    requestedDate,
    asOfDate: null,
    metrics: [],
    coverage: {
      catalog: tickers.length,
      priced: 0,
      adjustedPrice: 0,
      staged: 0,
      completeStage: 0,
      missingPriceTickers: [...tickers],
      missingStageTickers: [...tickers],
    },
    summary: { advancing: 0, declining: 0, unchanged: 0, stageOneOrSix: 0, stageFour: 0 },
    lineage: {
      market: 'US',
      priceBasis: 'ADJUSTED_CLOSE',
      stageBasis: 'MARKET_DAILY_SNAPSHOTS_EXACT_AS_OF',
      holdingsBasis: 'UNAVAILABLE',
      sources: [],
      latestImportedAt: null,
    },
  }
  if (!asOfDate) return emptyBoard

  const inSql = placeholders(tickers.length)
  const [priceRows, snapshotRows] = await Promise.all([
    execAll<PriceRow>(
      `SELECT ticker, date, adj_close, source, imported_at, rn
       FROM (
         SELECT ticker, date, adj_close, source, imported_at,
                ROW_NUMBER() OVER (PARTITION BY ticker ORDER BY date DESC) AS rn
         FROM market_ohlcv_daily INDEXED BY market_ohlcv_market_ticker_date_idx
         WHERE market = 'US' AND ticker IN (${inSql}) AND date <= ?
       )
       WHERE rn <= 2
       ORDER BY ticker, rn`,
      [...tickers, asOfDate],
    ),
    execAll<SnapshotRow>(
      `SELECT ticker, date, ma_5, ma_25, ma_75,
              daily_a_stage, daily_b_stage, weekly_a_stage, weekly_b_stage,
              monthly_a_stage, monthly_b_stage
       FROM market_daily_snapshots INDEXED BY market_snapshots_market_date_ticker_idx
       WHERE market = 'US' AND date = ? AND ticker IN (${inSql})
       ORDER BY ticker`,
      [asOfDate, ...tickers],
    ),
  ])

  const priceByTicker = new Map<string, PriceRow[]>()
  for (const row of priceRows) {
    const values = priceByTicker.get(row.ticker) ?? []
    values.push(row)
    priceByTicker.set(row.ticker, values)
  }
  const snapshotByTicker = new Map(snapshotRows.map((row) => [row.ticker, row]))

  const metrics = US_SECTOR_ETF_CATALOG.map<UsSectorEtfMetric>((catalog) => {
    const rows = priceByTicker.get(catalog.ticker) ?? []
    const currentRow = rows.find((row) => Number(row.rn) === 1 && row.date === asOfDate)
    const previousRow = currentRow ? rows.find((row) => Number(row.rn) === 2) : undefined
    const snapshot = snapshotByTicker.get(catalog.ticker)
    const price = numeric(currentRow?.adj_close)
    const previousPrice = numeric(previousRow?.adj_close)
    const change = price != null && previousPrice != null ? price - previousPrice : null
    const changePct = change != null && previousPrice != null && previousPrice > 0 ? (change / previousPrice) * 100 : null
    const stages: UsSectorEtfStages = {
      dailyA: stage(snapshot?.daily_a_stage),
      dailyB: stage(snapshot?.daily_b_stage),
      weeklyA: stage(snapshot?.weekly_a_stage),
      weeklyB: stage(snapshot?.weekly_b_stage),
      monthlyA: stage(snapshot?.monthly_a_stage),
      monthlyB: stage(snapshot?.monthly_b_stage),
    }
    const code = stageCode(stages)
    return {
      ...catalog,
      price,
      priceDate: currentRow?.date ?? null,
      previousPrice,
      previousPriceDate: previousRow?.date ?? null,
      change,
      changePct,
      priceSource: currentRow?.source ?? null,
      importedAt: numeric(currentRow?.imported_at),
      stageDate: snapshot?.date ?? null,
      stages,
      stageCode: code,
      maOrderDaily: maOrder(snapshot),
      dataStatus: price == null ? 'price_missing' : code == null ? 'stage_partial' : 'ready',
    }
  })

  const priced = metrics.filter((metric) => metric.price != null)
  const staged = metrics.filter((metric) => metric.stageDate === asOfDate)
  const sources = [...new Set(metrics.map((metric) => metric.priceSource).filter((value): value is string => Boolean(value)))].sort()
  const imported = metrics.map((metric) => metric.importedAt).filter((value): value is number => value != null)
  return {
    status: priced.length > 0 ? 'ready' : 'empty',
    requestedDate,
    asOfDate,
    metrics,
    coverage: {
      catalog: tickers.length,
      priced: priced.length,
      adjustedPrice: priced.length,
      staged: staged.length,
      completeStage: metrics.filter((metric) => metric.stageCode != null).length,
      missingPriceTickers: metrics.filter((metric) => metric.price == null).map((metric) => metric.ticker),
      missingStageTickers: metrics.filter((metric) => metric.stageDate !== asOfDate).map((metric) => metric.ticker),
    },
    summary: {
      advancing: metrics.filter((metric) => (metric.changePct ?? 0) > 0).length,
      declining: metrics.filter((metric) => (metric.changePct ?? 0) < 0).length,
      unchanged: metrics.filter((metric) => metric.changePct === 0).length,
      stageOneOrSix: metrics.filter((metric) => metric.stages.dailyA === 1 || metric.stages.dailyA === 6).length,
      stageFour: metrics.filter((metric) => metric.stages.dailyA === 4).length,
    },
    lineage: {
      market: 'US',
      priceBasis: 'ADJUSTED_CLOSE',
      stageBasis: 'MARKET_DAILY_SNAPSHOTS_EXACT_AS_OF',
      holdingsBasis: 'UNAVAILABLE',
      sources,
      latestImportedAt: imported.length > 0 ? Math.max(...imported) : null,
    },
  }
}
