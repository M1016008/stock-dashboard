import { ML_PHYSICS_FEATURE_SET } from '@/lib/backtest/ml-physics'
import {
  COMMODITY_GROUPS,
  COMMODITY_INSTRUMENTS,
  COMMODITY_PRODUCT_LABELS,
  CORE_COMMODITY_INSTRUMENTS,
  LEVERAGED_COMMODITY_INSTRUMENTS,
  RELATED_COMMODITY_INSTRUMENTS,
  commodityGroupLabel,
  getCommodityInstrument,
  normalizeCommodityMarketSlug,
  normalizeCommodityTicker,
  type CommodityGroupId,
  type CommodityInstrument,
  type CommodityMarket,
  type CommodityMarketSlug,
  type CommodityProductType,
} from '@/lib/commodities'
import { execAll } from '@/lib/db/client'
import { calculateAngle } from '@/lib/hex-stage'
import { analyzePhysicsProfile, type PhysicsAnalysis } from '@/lib/ml/physics-analysis'

export interface CommodityStages {
  dailyA: number | null
  dailyB: number | null
  weeklyA: number | null
  weeklyB: number | null
  monthlyA: number | null
  monthlyB: number | null
}

export interface CommodityMaAngles {
  daily5: number | null
  daily25: number | null
  daily75: number | null
  weekly5: number | null
  weekly13: number | null
  weekly25: number | null
  monthly3: number | null
  monthly5: number | null
  monthly10: number | null
}

export interface CommodityReturns {
  day1: number | null
  day5: number | null
  day20: number | null
  day60: number | null
  ytd: number | null
}

export interface CommodityMlStatus {
  available: boolean
  label: string
  featureCount: number
  latestFeatureDate: string | null
  similarCount: number
  latestSimilarDate: string | null
  source: 'jp_stock_ml_reference' | 'us_not_generated' | 'not_ready'
}

export interface CommodityPhysicsSummary {
  source: 'ml_feature_vectors_v2' | 'snapshot'
  status: string
  momentumLabel: string
  summary: string
  riskNotes: string[]
  analysis: PhysicsAnalysis | null
}

export interface CommodityMetric extends CommodityInstrument {
  dbName: string | null
  exchange: string | null
  price: number | null
  priceDate: string | null
  prevClose: number | null
  change: number | null
  changePct: number | null
  volume: number | null
  returns: CommodityReturns
  stageDate: string | null
  stageCode: string | null
  stages: CommodityStages
  maOrderDaily: string | null
  maOrderWeekly: string | null
  maOrderMonthly: string | null
  maAngles: CommodityMaAngles
  maTrendLabel: string
  ml: CommodityMlStatus
  physics: CommodityPhysicsSummary
  physicalMomentum: {
    pms: number | null
    pfs: number | null
    pes: number | null
  }
  freshness: {
    isStale: boolean
    latestPriceDate: string | null
    latestStageDate: string | null
    warnings: string[]
  }
  riskNotes: string[]
}

export interface CommodityBoard {
  latestPriceDate: string | null
  latestStageDate: string | null
  metrics: CommodityMetric[]
  core: CommodityMetric[]
  leveraged: CommodityMetric[]
  relatedThemes: CommodityMetric[]
  groups: Array<{
    id: CommodityGroupId
    label: string
    description: string
    items: CommodityMetric[]
    advancing: number
    declining: number
  }>
  summary: {
    total: number
    core: number
    jp: number
    us: number
    priced: number
    advancing: number
    declining: number
    stageOneOrSix: number
    stageFour: number
    mlReady: number
    stale: number
  }
}

export interface CommodityDetail {
  metric: CommodityMetric
  related: CommodityMetric[]
}

export interface CommodityScreenerParams {
  market?: CommodityMarket | 'ALL'
  group?: CommodityGroupId | 'all'
  productType?: CommodityProductType | 'all'
  leverage?: 'core' | 'leveraged' | 'all'
  stage?: string
  q?: string
  sort?: string
  dir?: 'asc' | 'desc'
  limit?: number
}

export interface CommodityScreenerResult {
  rows: CommodityMetric[]
  count: number
  date: string | null
  params: Required<CommodityScreenerParams>
}

interface PriceHistoryRow {
  market: CommodityMarket
  ticker: string
  date: string
  close: number
  volume: number | null
  rn: number
}

interface SnapshotRankRow {
  market: CommodityMarket
  ticker: string
  date: string
  ma_5: number | null
  ma_25: number | null
  ma_75: number | null
  ma_150: number | null
  ma_300: number | null
  weekly_ma_5: number | null
  weekly_ma_13: number | null
  weekly_ma_25: number | null
  weekly_ma_50: number | null
  weekly_ma_100: number | null
  monthly_ma_3: number | null
  monthly_ma_5: number | null
  monthly_ma_10: number | null
  monthly_ma_20: number | null
  monthly_ma_25: number | null
  daily_a_stage: number | null
  daily_b_stage: number | null
  weekly_a_stage: number | null
  weekly_b_stage: number | null
  monthly_a_stage: number | null
  monthly_b_stage: number | null
  rn: number
}

interface NameRow {
  market: CommodityMarket
  ticker: string
  name: string | null
  exchange: string | null
}

interface FeatureRow {
  ticker: string
  featureCount: number
  latestFeatureDate: string | null
  featureJson: string | null
}

interface SimilarRow {
  ticker: string
  similarCount: number
  latestSimilarDate: string | null
}

interface PhysicalMomentumMetricRow {
  market: CommodityMarket
  ticker: string
  pms: number | null
  pfs: number | null
  pes: number | null
}

function key(market: CommodityMarket, ticker: string) {
  return `${market}:${ticker}`
}

function inClause(items: readonly string[]) {
  return items.map(() => '?').join(',')
}

function toNumber(value: unknown): number | null {
  if (value == null) return null
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) ? n : null
}

function returnPct(latest: number | null, base: number | null): number | null {
  if (latest == null || base == null || base <= 0) return null
  return ((latest - base) / base) * 100
}

function byTradingDays(rows: PriceHistoryRow[], days: number): PriceHistoryRow | undefined {
  return rows.find((row) => Number(row.rn) === days + 1)
}

function ytdBase(rows: PriceHistoryRow[], latest: PriceHistoryRow | undefined): PriceHistoryRow | undefined {
  if (!latest) return undefined
  const yearStart = `${latest.date.slice(0, 4)}-01-01`
  return rows.find((row) => row.date < yearStart)
}

function buildReturns(rows: PriceHistoryRow[]): CommodityReturns {
  const latest = rows.find((row) => Number(row.rn) === 1)
  const latestClose = toNumber(latest?.close)
  return {
    day1: returnPct(latestClose, toNumber(byTradingDays(rows, 1)?.close)),
    day5: returnPct(latestClose, toNumber(byTradingDays(rows, 5)?.close)),
    day20: returnPct(latestClose, toNumber(byTradingDays(rows, 20)?.close)),
    day60: returnPct(latestClose, toNumber(byTradingDays(rows, 60)?.close)),
    ytd: returnPct(latestClose, toNumber(ytdBase(rows, latest)?.close)),
  }
}

function stageCode(stages: CommodityStages): string | null {
  const values = [stages.dailyA, stages.dailyB, stages.weeklyA, stages.weeklyB, stages.monthlyA, stages.monthlyB]
  if (values.some((v) => v == null)) return null
  return values.join('')
}

function orderedLabel(entries: Array<[string, number | null]>): string | null {
  if (entries.some(([, value]) => value == null || !Number.isFinite(value))) return null
  return [...entries]
    .sort((a, b) => (b[1] ?? 0) - (a[1] ?? 0))
    .map(([label]) => label)
    .join(' > ')
}

function directionFromAngle(angle: number | null): 'up' | 'down' | 'flat' {
  if (angle == null || !Number.isFinite(angle)) return 'flat'
  if (angle > 3) return 'up'
  if (angle < -3) return 'down'
  return 'flat'
}

function maTrendLabel(angles: CommodityMaAngles, stages: CommodityStages): string {
  const daily = [angles.daily5, angles.daily25, angles.daily75].map(directionFromAngle)
  const weekly = [angles.weekly5, angles.weekly13, angles.weekly25].map(directionFromAngle)
  const monthly = [angles.monthly3, angles.monthly5, angles.monthly10].map(directionFromAngle)
  const upCount = [...daily, ...weekly, ...monthly].filter((d) => d === 'up').length
  const downCount = [...daily, ...weekly, ...monthly].filter((d) => d === 'down').length
  if ((stages.dailyA === 1 || stages.dailyA === 6) && upCount >= 4) return '上昇優勢'
  if (stages.dailyA === 4 && downCount >= 4) return '下落優勢'
  if (upCount > downCount + 1) return '上向き'
  if (downCount > upCount + 1) return '下向き'
  return '中立'
}

function parseFeatureJson(value: string | null): Record<string, unknown> | null {
  if (!value) return null
  try {
    const parsed = JSON.parse(value)
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : null
  } catch {
    return null
  }
}

function fallbackPhysics(label: string, angles: CommodityMaAngles, stages: CommodityStages): CommodityPhysicsSummary {
  const upward = [angles.daily5, angles.daily25, angles.weekly5, angles.weekly13, angles.monthly3]
    .filter((angle) => (angle ?? 0) > 3).length
  const downward = [angles.daily5, angles.daily25, angles.weekly5, angles.weekly13, angles.monthly3]
    .filter((angle) => (angle ?? 0) < -3).length
  const status = upward >= 3 && (stages.dailyA === 1 || stages.dailyA === 6)
    ? '上昇継続'
    : downward >= 3 && stages.dailyA === 4
      ? '下落加速'
      : label
  return {
    source: 'snapshot',
    status,
    momentumLabel: upward > downward ? '上向き優勢' : downward > upward ? '下向き優勢' : '中立',
    summary: `ステージとMA角度から見ると「${status}」です。商品専用MLではなく、価格系列の物理特徴量として確認します。`,
    riskNotes: ['商品ETF/ETNは需給、為替、ロールコスト、商品固有イベントの影響を受けます。'],
    analysis: null,
  }
}

function buildRiskNotes(item: CommodityInstrument): string[] {
  const notes: string[] = []
  if (item.productType === 'futures' || item.productType === 'basket') {
    notes.push('先物型・バスケット型はロールコストや限月構成の影響を受けます。')
  }
  if (item.leveragedInverse) {
    notes.push('レバレッジ/インバース型は日次リバランスの影響が大きく、長期保有には向きません。')
  }
  if (item.market === 'US') {
    notes.push('米国ETFはドル建てのため、円ベースでは為替変動も成績に影響します。')
  }
  if (item.relatedTheme) {
    notes.push('関連株テーマETFは商品価格そのものではなく、関連企業株の値動きです。')
  }
  return notes
}

function daysBetweenToday(date: string | null): number | null {
  if (!date) return null
  const parsed = new Date(`${date}T00:00:00Z`)
  if (Number.isNaN(parsed.getTime())) return null
  return Math.floor((Date.now() - parsed.getTime()) / 86_400_000)
}

function freshnessWarnings(item: CommodityInstrument, prices: PriceHistoryRow[], priceDate: string | null, stageDate: string | null): string[] {
  const warnings: string[] = []
  const age = daysBetweenToday(priceDate)
  if (!priceDate) warnings.push('価格データが未取得です。')
  else if (age != null && age > 10) warnings.push(`最新価格日が${priceDate}で、鮮度が古い可能性があります。`)
  if (!stageDate) warnings.push('6ステージ判定が未生成です。')
  if (prices.length > 0 && prices.length < 65) warnings.push('履歴が短く、60営業日騰落率や月足分析は参考度が下がります。')
  if (item.ticker === '569A' || item.ticker === '579A' || item.ticker === '580A') warnings.push('上場後の履歴が短いため、ステージ・MA分析は参考表示です。')
  return warnings
}

async function loadPriceRows(market: CommodityMarket, tickers: readonly string[]): Promise<PriceHistoryRow[]> {
  if (tickers.length === 0) return []
  if (market === 'JP') {
    const rows = await Promise.all(tickers.map((ticker) => execAll<PriceHistoryRow>(
      `
        SELECT 'JP' AS market, ticker, date, close, volume, rn
        FROM (
          SELECT
            ticker,
            date,
            close,
            volume,
            ROW_NUMBER() OVER (ORDER BY date DESC) AS rn
          FROM ohlcv_daily
          WHERE ticker = ?
          ORDER BY date DESC
          LIMIT 260
        )
      `,
      [ticker],
    )))
    return rows.flat()
  }
  const rows = await Promise.all(tickers.map((ticker) => execAll<PriceHistoryRow>(
    `
      SELECT market, ticker, date, close, volume, rn
      FROM (
        SELECT
          market,
          ticker,
          date,
          close,
          volume,
          ROW_NUMBER() OVER (ORDER BY date DESC) AS rn
        FROM market_ohlcv_daily
        WHERE market = 'US' AND ticker = ?
        ORDER BY date DESC
        LIMIT 260
      )
    `,
    [ticker],
  )))
  return rows.flat()
}

async function loadSnapshotRows(market: CommodityMarket, tickers: readonly string[]): Promise<SnapshotRankRow[]> {
  if (tickers.length === 0) return []
  const columns = `
    ticker,
    date,
    ma_5, ma_25, ma_75, ma_150, ma_300,
    weekly_ma_5, weekly_ma_13, weekly_ma_25, weekly_ma_50, weekly_ma_100,
    monthly_ma_3, monthly_ma_5, monthly_ma_10, monthly_ma_20, monthly_ma_25,
    daily_a_stage, daily_b_stage, weekly_a_stage, weekly_b_stage, monthly_a_stage, monthly_b_stage,
    ROW_NUMBER() OVER (PARTITION BY ticker ORDER BY date DESC) AS rn
  `
  if (market === 'JP') {
    const rows = await Promise.all(tickers.map((ticker) => execAll<SnapshotRankRow>(
      `
        SELECT 'JP' AS market, *
        FROM (
          SELECT ${columns}
          FROM daily_snapshots
          WHERE ticker = ?
          ORDER BY date DESC
          LIMIT 6
        )
      `,
      [ticker],
    )))
    return rows.flat()
  }
  const rows = await Promise.all(tickers.map((ticker) => execAll<SnapshotRankRow>(
    `
      SELECT 'US' AS market, *
      FROM (
        SELECT ${columns}
        FROM market_daily_snapshots
        WHERE market = 'US' AND ticker = ?
        ORDER BY date DESC
        LIMIT 6
      )
    `,
    [ticker],
  )))
  return rows.flat()
}

async function loadNameRows(market: CommodityMarket, tickers: readonly string[]): Promise<NameRow[]> {
  if (tickers.length === 0) return []
  const placeholders = inClause(tickers)
  if (market === 'JP') {
    return execAll<NameRow>(
      `SELECT 'JP' AS market, ticker, name, NULL AS exchange FROM ticker_universe WHERE ticker IN (${placeholders})`,
      tickers,
    )
  }
  return execAll<NameRow>(
    `
      SELECT market, ticker, name, exchange
      FROM market_universe
      WHERE market = 'US' AND ticker IN (${placeholders})
    `,
    tickers,
  )
}

async function loadFeatureRows(tickers: readonly string[]): Promise<FeatureRow[]> {
  if (tickers.length === 0) return []
  const rows = await Promise.all(tickers.map((ticker) => execAll<FeatureRow>(
    `
      SELECT
        ? AS ticker,
        (SELECT COUNT(*) FROM ml_feature_vectors_v2 WHERE ticker = ? AND feature_set = ?) AS featureCount,
        date AS latestFeatureDate,
        feature_json AS featureJson
      FROM ml_feature_vectors_v2
      WHERE ticker = ? AND feature_set = ?
      ORDER BY date DESC
      LIMIT 1
    `,
    [ticker, ticker, ML_PHYSICS_FEATURE_SET, ticker, ML_PHYSICS_FEATURE_SET],
  )))
  return rows.flat()
}

async function loadSimilarRows(tickers: readonly string[]): Promise<SimilarRow[]> {
  void tickers
  // serving_current_similars is indexed by as_of_date first in older DBs, so the
  // broad board intentionally avoids scanning it. The detail page still renders
  // the existing StockMlInsights client for JP ETFs when feature vectors exist.
  return []
}

async function loadPhysicalMomentumRows(market: CommodityMarket, tickers: readonly string[]): Promise<PhysicalMomentumMetricRow[]> {
  if (tickers.length === 0) return []
  const placeholders = inClause(tickers)
  return execAll<PhysicalMomentumMetricRow>(
    `
      WITH latest AS (
        SELECT market, symbol, MAX(date) AS date
        FROM physical_momentum_metrics
        WHERE market = ?
          AND symbol IN (${placeholders})
        GROUP BY market, symbol
      )
      SELECT
        pm.market AS market,
        pm.symbol AS ticker,
        pm.physical_momentum_score AS pms,
        pm.physical_force_score AS pfs,
        pm.physical_energy_score AS pes
      FROM physical_momentum_metrics pm
      JOIN latest ON latest.market = pm.market AND latest.symbol = pm.symbol AND latest.date = pm.date
    `,
    [market, ...tickers],
  )
}

function buildMetric(
  item: CommodityInstrument,
  dbName: string | null,
  exchange: string | null,
  prices: PriceHistoryRow[],
  snapshots: SnapshotRankRow[],
  feature: FeatureRow | undefined,
  similar: SimilarRow | undefined,
  physicalMomentum: PhysicalMomentumMetricRow | undefined,
): CommodityMetric {
  const latestPrice = prices.find((row) => Number(row.rn) === 1)
  const prevPrice = prices.find((row) => Number(row.rn) === 2)
  const latestSnapshot = snapshots.find((row) => Number(row.rn) === 1)
  const angleBase = [...snapshots].reverse().find((row) => Number(row.rn) > 1) ?? null
  const angleDays = angleBase ? Math.max(1, Number(angleBase.rn) - 1) : 1
  const stages: CommodityStages = {
    dailyA: toNumber(latestSnapshot?.daily_a_stage),
    dailyB: toNumber(latestSnapshot?.daily_b_stage),
    weeklyA: toNumber(latestSnapshot?.weekly_a_stage),
    weeklyB: toNumber(latestSnapshot?.weekly_b_stage),
    monthlyA: toNumber(latestSnapshot?.monthly_a_stage),
    monthlyB: toNumber(latestSnapshot?.monthly_b_stage),
  }
  const maAngles: CommodityMaAngles = {
    daily5: calculateAngle(toNumber(latestSnapshot?.ma_5), toNumber(angleBase?.ma_5), angleDays),
    daily25: calculateAngle(toNumber(latestSnapshot?.ma_25), toNumber(angleBase?.ma_25), angleDays),
    daily75: calculateAngle(toNumber(latestSnapshot?.ma_75), toNumber(angleBase?.ma_75), angleDays),
    weekly5: calculateAngle(toNumber(latestSnapshot?.weekly_ma_5), toNumber(angleBase?.weekly_ma_5), angleDays),
    weekly13: calculateAngle(toNumber(latestSnapshot?.weekly_ma_13), toNumber(angleBase?.weekly_ma_13), angleDays),
    weekly25: calculateAngle(toNumber(latestSnapshot?.weekly_ma_25), toNumber(angleBase?.weekly_ma_25), angleDays),
    monthly3: calculateAngle(toNumber(latestSnapshot?.monthly_ma_3), toNumber(angleBase?.monthly_ma_3), angleDays),
    monthly5: calculateAngle(toNumber(latestSnapshot?.monthly_ma_5), toNumber(angleBase?.monthly_ma_5), angleDays),
    monthly10: calculateAngle(toNumber(latestSnapshot?.monthly_ma_10), toNumber(angleBase?.monthly_ma_10), angleDays),
  }
  const price = toNumber(latestPrice?.close)
  const prevClose = toNumber(prevPrice?.close)
  const change = price != null && prevClose != null ? price - prevClose : null
  const changePct = returnPct(price, prevClose)
  const label = maTrendLabel(maAngles, stages)
  const featureCount = Number(feature?.featureCount ?? 0)
  const similarCount = Number(similar?.similarCount ?? 0)
  const profile = parseFeatureJson(feature?.featureJson ?? null)
  const analysis = profile ? analyzePhysicsProfile(profile) : null
  const physics: CommodityPhysicsSummary = analysis
    ? {
        source: 'ml_feature_vectors_v2',
        status: analysis.physicsStatus,
        momentumLabel: analysis.momentumLabel,
        summary: analysis.summary,
        riskNotes: analysis.riskNotes,
        analysis,
      }
    : fallbackPhysics(label, maAngles, stages)
  const priceDate = latestPrice?.date ?? null
  const stageDate = latestSnapshot?.date ?? null
  const warnings = freshnessWarnings(item, prices, priceDate, stageDate)
  return {
    ...item,
    dbName,
    exchange,
    price,
    priceDate,
    prevClose,
    change,
    changePct,
    volume: toNumber(latestPrice?.volume),
    returns: buildReturns(prices),
    stageDate,
    stageCode: stageCode(stages),
    stages,
    maOrderDaily: orderedLabel([
      ['5日', toNumber(latestSnapshot?.ma_5)],
      ['25日', toNumber(latestSnapshot?.ma_25)],
      ['75日', toNumber(latestSnapshot?.ma_75)],
    ]),
    maOrderWeekly: orderedLabel([
      ['5週', toNumber(latestSnapshot?.weekly_ma_5)],
      ['13週', toNumber(latestSnapshot?.weekly_ma_13)],
      ['25週', toNumber(latestSnapshot?.weekly_ma_25)],
    ]),
    maOrderMonthly: orderedLabel([
      ['3月', toNumber(latestSnapshot?.monthly_ma_3)],
      ['5月', toNumber(latestSnapshot?.monthly_ma_5)],
      ['10月', toNumber(latestSnapshot?.monthly_ma_10)],
    ]),
    maAngles,
    maTrendLabel: label,
    ml: item.market === 'US'
      ? {
          available: false,
          label: 'US ETFはML未生成',
          featureCount: 0,
          latestFeatureDate: null,
          similarCount: 0,
          latestSimilarDate: null,
          source: 'us_not_generated',
        }
      : {
          available: featureCount > 0,
          label: featureCount > 0 ? '既存株式MLを参考表示' : 'ML未生成',
          featureCount,
          latestFeatureDate: feature?.latestFeatureDate ?? null,
          similarCount,
          latestSimilarDate: similar?.latestSimilarDate ?? null,
          source: featureCount > 0 ? 'jp_stock_ml_reference' : 'not_ready',
        },
    physics,
    physicalMomentum: {
      pms: physicalMomentum?.pms ?? null,
      pfs: physicalMomentum?.pfs ?? null,
      pes: physicalMomentum?.pes ?? null,
    },
    freshness: {
      isStale: warnings.some((warning) => warning.includes('鮮度') || warning.includes('未取得') || warning.includes('未生成')),
      latestPriceDate: priceDate,
      latestStageDate: stageDate,
      warnings,
    },
    riskNotes: buildRiskNotes(item),
  }
}

async function loadMetrics(items: readonly CommodityInstrument[]): Promise<CommodityMetric[]> {
  if (items.length === 0) return []
  const jpTickers = items.filter((item) => item.market === 'JP').map((item) => item.ticker)
  const usTickers = items.filter((item) => item.market === 'US').map((item) => item.ticker)
  const [
    jpPrices,
    usPrices,
    jpSnapshots,
    usSnapshots,
    jpNames,
    usNames,
    featureRows,
    similarRows,
    jpPhysicalRows,
    usPhysicalRows,
  ] = await Promise.all([
    loadPriceRows('JP', jpTickers),
    loadPriceRows('US', usTickers),
    loadSnapshotRows('JP', jpTickers),
    loadSnapshotRows('US', usTickers),
    loadNameRows('JP', jpTickers),
    loadNameRows('US', usTickers),
    loadFeatureRows(jpTickers),
    loadSimilarRows(jpTickers),
    loadPhysicalMomentumRows('JP', jpTickers),
    loadPhysicalMomentumRows('US', usTickers),
  ])

  const pricesByKey = new Map<string, PriceHistoryRow[]>()
  const snapshotsByKey = new Map<string, SnapshotRankRow[]>()
  const namesByKey = new Map<string, NameRow>()
  const featuresByTicker = new Map<string, FeatureRow>()
  const similarsByTicker = new Map<string, SimilarRow>()
  const physicalByKey = new Map<string, PhysicalMomentumMetricRow>()

  for (const row of [...jpPrices, ...usPrices]) {
    const list = pricesByKey.get(key(row.market, row.ticker)) ?? []
    list.push(row)
    pricesByKey.set(key(row.market, row.ticker), list)
  }
  for (const row of [...jpSnapshots, ...usSnapshots]) {
    const list = snapshotsByKey.get(key(row.market, row.ticker)) ?? []
    list.push(row)
    snapshotsByKey.set(key(row.market, row.ticker), list)
  }
  for (const row of [...jpNames, ...usNames]) namesByKey.set(key(row.market, row.ticker), row)
  for (const row of featureRows) featuresByTicker.set(row.ticker, row)
  for (const row of similarRows) similarsByTicker.set(row.ticker, row)
  for (const row of [...jpPhysicalRows, ...usPhysicalRows]) physicalByKey.set(key(row.market, row.ticker), row)

  return items.map((item) => {
    const nameRow = namesByKey.get(key(item.market, item.ticker))
    return buildMetric(
      item,
      nameRow?.name ?? null,
      nameRow?.exchange ?? null,
      pricesByKey.get(key(item.market, item.ticker)) ?? [],
      snapshotsByKey.get(key(item.market, item.ticker)) ?? [],
      item.market === 'JP' ? featuresByTicker.get(item.ticker) : undefined,
      item.market === 'JP' ? similarsByTicker.get(item.ticker) : undefined,
      physicalByKey.get(key(item.market, item.ticker)),
    )
  })
}

function latestDate(metrics: CommodityMetric[], selector: (metric: CommodityMetric) => string | null): string | null {
  return metrics.map(selector).filter(Boolean).sort().at(-1) ?? null
}

export async function getCommodityBoard(): Promise<CommodityBoard> {
  const metrics = await loadMetrics(COMMODITY_INSTRUMENTS)
  const core = metrics.filter((item) => !item.leveragedInverse && !item.relatedTheme)
  const leveraged = metrics.filter((item) => item.leveragedInverse)
  const relatedThemes = metrics.filter((item) => item.relatedTheme)
  const groups = COMMODITY_GROUPS
    .filter((group) => group.id !== 'leveraged_inverse' && group.id !== 'related_equity')
    .map((group) => {
      const items = core.filter((item) => item.group === group.id)
      return {
        id: group.id,
        label: group.label,
        description: group.description,
        items,
        advancing: items.filter((item) => (item.changePct ?? 0) > 0).length,
        declining: items.filter((item) => (item.changePct ?? 0) < 0).length,
      }
    })

  return {
    latestPriceDate: latestDate(metrics, (metric) => metric.priceDate),
    latestStageDate: latestDate(metrics, (metric) => metric.stageDate),
    metrics,
    core,
    leveraged,
    relatedThemes,
    groups,
    summary: {
      total: metrics.length,
      core: core.length,
      jp: metrics.filter((item) => item.market === 'JP').length,
      us: metrics.filter((item) => item.market === 'US').length,
      priced: metrics.filter((item) => item.price != null).length,
      advancing: core.filter((item) => (item.changePct ?? 0) > 0).length,
      declining: core.filter((item) => (item.changePct ?? 0) < 0).length,
      stageOneOrSix: core.filter((item) => item.stages.dailyA === 1 || item.stages.dailyA === 6).length,
      stageFour: core.filter((item) => item.stages.dailyA === 4).length,
      mlReady: metrics.filter((item) => item.ml.available).length,
      stale: metrics.filter((item) => item.freshness.isStale).length,
    },
  }
}

function normalizeScreenerParams(params: CommodityScreenerParams = {}): Required<CommodityScreenerParams> {
  return {
    market: params.market === 'JP' || params.market === 'US' ? params.market : 'ALL',
    group: params.group && params.group !== 'all' ? params.group : 'all',
    productType: params.productType && params.productType !== 'all' ? params.productType : 'all',
    leverage: params.leverage === 'leveraged' || params.leverage === 'all' ? params.leverage : 'core',
    stage: params.stage ?? 'all',
    q: params.q?.trim() ?? '',
    sort: params.sort ?? 'return20',
    dir: params.dir === 'asc' ? 'asc' : 'desc',
    limit: Math.min(300, Math.max(1, Number(params.limit ?? 200))),
  }
}

function metricSortValue(metric: CommodityMetric, sort: string): string | number | null {
  const values: Record<string, string | number | null> = {
    ticker: `${metric.market}:${metric.ticker}`,
    market: metric.market,
    group: commodityGroupLabel(metric.group),
    price: metric.price,
    changePct: metric.changePct,
    return1: metric.returns.day1,
    return5: metric.returns.day5,
    return20: metric.returns.day20,
    return60: metric.returns.day60,
    ytd: metric.returns.ytd,
    stageCode: metric.stageCode,
    maTrend: metric.maTrendLabel,
    ml: metric.ml.available ? 1 : 0,
    pms: metric.physicalMomentum.pms,
    pfs: metric.physicalMomentum.pfs,
    pes: metric.physicalMomentum.pes,
  }
  return values[sort] ?? values.return20
}

function compareMetric(a: CommodityMetric, b: CommodityMetric, sort: string, dir: 'asc' | 'desc') {
  const av = metricSortValue(a, sort)
  const bv = metricSortValue(b, sort)
  const missing = av == null ? 1 : bv == null ? -1 : 0
  if (missing !== 0) return missing
  let diff = 0
  if (typeof av === 'number' && typeof bv === 'number') diff = av - bv
  else diff = String(av).localeCompare(String(bv), 'ja')
  if (diff === 0) diff = a.ticker.localeCompare(b.ticker)
  return dir === 'asc' ? diff : -diff
}

export async function getCommodityScreener(params: CommodityScreenerParams = {}): Promise<CommodityScreenerResult> {
  const normalized = normalizeScreenerParams(params)
  const board = await getCommodityBoard()
  const q = normalized.q.toUpperCase()
  let rows = board.metrics
  if (normalized.leverage === 'core') rows = rows.filter((item) => !item.leveragedInverse && !item.relatedTheme)
  if (normalized.leverage === 'leveraged') rows = rows.filter((item) => item.leveragedInverse)
  if (normalized.market !== 'ALL') rows = rows.filter((item) => item.market === normalized.market)
  if (normalized.group !== 'all') rows = rows.filter((item) => item.group === normalized.group)
  if (normalized.productType !== 'all') rows = rows.filter((item) => item.productType === normalized.productType)
  if (normalized.stage !== 'all') rows = rows.filter((item) => item.stageCode?.startsWith(normalized.stage) || item.stageCode?.includes(normalized.stage))
  if (q) {
    rows = rows.filter((item) => (
      item.ticker.includes(q)
      || item.shortName.toUpperCase().includes(q)
      || item.name.toUpperCase().includes(q)
      || item.commodity.toUpperCase().includes(q)
      || (item.dbName ?? '').toUpperCase().includes(q)
    ))
  }
  rows = [...rows].sort((a, b) => compareMetric(a, b, normalized.sort, normalized.dir)).slice(0, normalized.limit)
  return {
    rows,
    count: rows.length,
    date: board.latestPriceDate,
    params: normalized,
  }
}

export async function getCommodityDetail(marketSlug: string, rawTicker: string): Promise<CommodityDetail | null> {
  const slug = normalizeCommodityMarketSlug(marketSlug)
  if (!slug) return null
  const ticker = normalizeCommodityTicker(rawTicker)
  const instrument = getCommodityInstrument(slug, ticker)
  if (!instrument) return null
  const [metric] = await loadMetrics([instrument])
  if (!metric) return null
  const sameGroup = COMMODITY_INSTRUMENTS
    .filter((item) => item.group === instrument.group && !(item.marketSlug === slug && item.ticker === instrument.ticker))
    .slice(0, 8)
  const related = await loadMetrics(sameGroup)
  return { metric, related }
}

export function commodityMarketFromSearchParam(value: string | null): CommodityMarket | 'ALL' {
  const upper = value?.toUpperCase()
  if (upper === 'JP' || upper === 'US') return upper
  return 'ALL'
}

export function commodityGroupFromSearchParam(value: string | null): CommodityGroupId | 'all' {
  if (COMMODITY_GROUPS.some((group) => group.id === value)) return value as CommodityGroupId
  return 'all'
}

export function commodityProductFromSearchParam(value: string | null): CommodityProductType | 'all' {
  if (Object.keys(COMMODITY_PRODUCT_LABELS).includes(value ?? '')) return value as CommodityProductType
  return 'all'
}

export function commodityLeverageFromSearchParam(value: string | null): 'core' | 'leveraged' | 'all' {
  if (value === 'leveraged' || value === 'all') return value
  return 'core'
}

export const COMMODITY_SCREENER_GROUP_OPTIONS = COMMODITY_GROUPS
export const COMMODITY_SCREENER_PRODUCT_OPTIONS = COMMODITY_PRODUCT_LABELS
export const COMMODITY_CORE_COUNT = CORE_COMMODITY_INSTRUMENTS.length
export const COMMODITY_LEVERAGED_COUNT = LEVERAGED_COMMODITY_INSTRUMENTS.length
export const COMMODITY_RELATED_COUNT = RELATED_COMMODITY_INSTRUMENTS.length
export type { CommodityMarketSlug }
