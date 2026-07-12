import { COMMODITY_INSTRUMENTS, getCommodityInstrument } from '@/lib/commodities'
import { execAll, execGet, execRun } from '@/lib/db/client'
import { calcBollingerBands, calcMACD, calcRSI } from '@/lib/indicators'
import {
  collectAssetRefs,
  evaluateFormulaNode,
  formatFormula,
  normalizeAssetRef,
  normalizeFormula,
  parseFormula,
} from '@/lib/custom-charts/formula'
import type {
  CustomAssetRef,
  CustomChartAssetMeta,
  CustomChartCurrency,
  CustomChartEvaluation,
  CustomChartIndicatorConfig,
  CustomChartMissingPolicy,
  CustomChartMode,
  CustomChartRequest,
  CustomChartSymbolCandidate,
  FormulaNode,
  StoredCustomChart,
} from '@/lib/custom-charts/types'
import type { OHLCV } from '@/types/stock'
import { intervalToSpec, resampleOhlcv, smaSeries } from '@/lib/timeframes'

type PriceRow = {
  date: string
  open: number
  high: number
  low: number
  close: number
  adjClose?: number | null
  volume: number
}

type AssetCandle = {
  open: number
  high: number
  low: number
  close: number
  volume: number
}

type LoadedAsset = {
  meta: CustomChartAssetMeta
  rows: Map<string, AssetCandle>
}

type FxRow = {
  date: string
  rate: number
}

type StoredChartRow = {
  id: string
  name: string
  formula: string
  mode: CustomChartMode
  baseDate: string | null
  displayCurrency: CustomChartCurrency
  missingPolicy: CustomChartMissingPolicy
  indicatorConfigJson: string
  favorite: number
  sortOrder: number
  createdAt: number
  updatedAt: number
}

export const DEFAULT_CUSTOM_CHART_INDICATORS: CustomChartIndicatorConfig = {
  ma: [5, 25, 75],
  bollinger: true,
  rsi: true,
  macd: true,
  volumeMode: 'turnover',
}

const PERIOD_DAYS: Record<CustomChartRequest['period'], number | null> = {
  '1mo': 30,
  '3mo': 90,
  '6mo': 180,
  '1y': 365,
  '2y': 730,
  '5y': 1825,
  '10y': 3650,
  all: null,
}

export function sanitizeCustomChartRequest(input: Partial<CustomChartRequest>): CustomChartRequest {
  const period = input.period && input.period in PERIOD_DAYS ? input.period : '1y'
  const interval = input.interval && ['D', '2D', 'W', '2W', 'M', '2M'].includes(input.interval) ? input.interval : 'D'
  const mode = input.mode === 'comparison' || input.mode === 'normalized' ? input.mode : 'valuation'
  const displayCurrency = input.displayCurrency === 'JPY' || input.displayCurrency === 'USD' ? input.displayCurrency : 'LOCAL'
  const missingPolicy = input.missingPolicy === 'carry-forward' ? 'carry-forward' : 'intersection'
  const volumeMode: CustomChartIndicatorConfig['volumeMode'] = input.indicators?.volumeMode === 'volume' ? 'volume' : 'turnover'
  const indicators: CustomChartIndicatorConfig = {
    ...DEFAULT_CUSTOM_CHART_INDICATORS,
    ...(input.indicators ?? {}),
    ma: normalizeMaPeriods(input.indicators?.ma ?? DEFAULT_CUSTOM_CHART_INDICATORS.ma),
    volumeMode,
  }

  return {
    formula: String(input.formula ?? '').trim(),
    mode,
    period,
    interval,
    displayCurrency,
    missingPolicy,
    baseDate: input.baseDate || null,
    indicators,
  }
}

function normalizeMaPeriods(periods: unknown): number[] {
  const values = Array.isArray(periods) ? periods : []
  const normalized = values
    .map((value) => Math.round(Number(value)))
    .filter((value) => Number.isInteger(value) && value > 0 && value <= 300)
  return Array.from(new Set(normalized)).slice(0, 6)
}

export async function evaluateCustomChart(rawInput: Partial<CustomChartRequest>): Promise<CustomChartEvaluation> {
  const input = sanitizeCustomChartRequest(rawInput)
  const ast = parseFormula(input.formula)
  const refs = collectAssetRefs(ast)
  const assets = await Promise.all(refs.map((ref) => loadAsset(ref, input.period)))
  const missingAssets = assets.filter((asset) => asset.rows.size === 0).map((asset) => asset.meta.name)
  if (missingAssets.length > 0) {
    throw new Error(`価格データが不足しています: ${missingAssets.join(', ')}`)
  }

  const effectiveCurrency = resolveEffectiveCurrency(input.displayCurrency, assets.map((asset) => asset.meta.currency))
  const fxRows = await loadFxRows()
  const warnings: string[] = []
  if (effectiveCurrency !== 'MIXED') {
    for (const asset of assets) {
      if (asset.meta.currency !== effectiveCurrency && fxRows.length === 0) {
        throw new Error('異通貨の数式には日次USDJPYデータが必要です。FX CSVを取り込んでください。')
      }
    }
  }

  const daily = buildDailySeries({
    ast,
    assets,
    mode: input.mode,
    missingPolicy: input.missingPolicy,
    displayCurrency: effectiveCurrency,
    baseDate: input.baseDate ?? null,
    fxRows,
    volumeMode: input.indicators.volumeMode,
    warnings,
  })

  if (daily.length === 0) throw new Error('価格データが不足しています。共通取引日またはFXデータを確認してください。')

  const grouped = resampleOhlcv(daily, intervalToSpec(input.interval))

  const series = grouped.map((row) => ({ date: row.date, value: row.close }))
  const candles = grouped.map((row) => ({
    date: row.date,
    open: row.open,
    high: row.high,
    low: row.low,
    close: row.close,
  }))
  const volume = grouped.map((row) => ({ date: row.date, value: row.volume }))

  return {
    formula: input.formula,
    normalizedFormula: formatFormula(ast),
    description: describeFormula(ast, assets.map((asset) => asset.meta), input.mode),
    mode: input.mode,
    interval: input.interval,
    displayCurrency: input.displayCurrency,
    effectiveCurrency,
    missingPolicy: input.missingPolicy,
    priceBasis: Array.from(new Set(assets.map((asset) => `${asset.meta.key}:${asset.meta.priceBasis}`))).join(', '),
    assets: assets.map((asset) => asset.meta),
    warnings,
    series,
    candles,
    volume,
    indicators: buildIndicators(grouped, input.indicators),
  }
}

function resolveEffectiveCurrency(requested: CustomChartCurrency, currencies: Array<'JPY' | 'USD'>): 'JPY' | 'USD' | 'MIXED' {
  const unique = Array.from(new Set(currencies))
  if (requested === 'JPY' || requested === 'USD') return requested
  if (unique.length === 1) return unique[0]
  throw new Error('異通貨の数式では表示通貨をJPYまたはUSDに指定してください。')
}

async function loadAsset(ref: CustomAssetRef, period: CustomChartRequest['period']): Promise<LoadedAsset> {
  if (ref.kind === 'JP') return loadJpAsset(ref, period)
  if (ref.kind === 'US') return loadUsAsset(ref, period)
  return loadCommodityAsset(ref, period)
}

async function loadJpAsset(ref: Extract<CustomAssetRef, { kind: 'JP' }>, period: CustomChartRequest['period']): Promise<LoadedAsset> {
  const [meta, rows] = await Promise.all([
    execGet<{ name: string | null; marketSegment: string | null }>(
      `SELECT name, market_segment AS marketSegment FROM ticker_universe WHERE ticker = ? LIMIT 1`,
      [ref.ticker],
    ),
    execAll<PriceRow>(
      `
        SELECT date, open, high, low, close, volume
        FROM ohlcv_daily
        WHERE ticker = ?
          ${period === 'all' ? '' : `AND date >= date((SELECT MAX(date) FROM ohlcv_daily WHERE ticker = ?), '-' || ? || ' days')`}
        ORDER BY date
      `,
      period === 'all' ? [ref.ticker] : [ref.ticker, ref.ticker, PERIOD_DAYS[period] ?? 365],
    ),
  ])
  return {
    meta: {
      ...ref,
      name: meta?.name ?? ref.ticker,
      marketLabel: meta?.marketSegment ?? 'JP',
      currency: 'JPY',
      priceBasis: 'close',
    },
    rows: priceRowsToMap(rows, false),
  }
}

async function loadUsAsset(ref: Extract<CustomAssetRef, { kind: 'US' }>, period: CustomChartRequest['period']): Promise<LoadedAsset> {
  const [meta, rows] = await Promise.all([
    execGet<{ name: string | null; exchange: string | null; currency: string | null }>(
      `SELECT name, exchange, currency FROM market_universe WHERE market = 'US' AND ticker = ? LIMIT 1`,
      [ref.ticker],
    ),
    execAll<PriceRow>(
      `
        SELECT date, open, high, low, close, adj_close AS adjClose, volume
        FROM market_ohlcv_daily
        WHERE market = 'US' AND ticker = ?
          ${period === 'all' ? '' : `AND date >= date((SELECT MAX(date) FROM market_ohlcv_daily WHERE market = 'US' AND ticker = ?), '-' || ? || ' days')`}
        ORDER BY date
      `,
      period === 'all' ? [ref.ticker] : [ref.ticker, ref.ticker, PERIOD_DAYS[period] ?? 365],
    ),
  ])
  const hasAdjusted = rows.some((row) => row.adjClose != null)
  return {
    meta: {
      ...ref,
      name: meta?.name ?? ref.ticker,
      marketLabel: meta?.exchange ?? 'US',
      currency: meta?.currency === 'JPY' ? 'JPY' : 'USD',
      priceBasis: hasAdjusted ? 'adj_close' : 'close',
    },
    rows: priceRowsToMap(rows, true),
  }
}

async function loadCommodityAsset(ref: Extract<CustomAssetRef, { kind: 'CMD' }>, period: CustomChartRequest['period']): Promise<LoadedAsset> {
  const instrument = getCommodityInstrument(ref.market.toLowerCase(), ref.ticker)
  if (!instrument) throw new Error(`商品ETF/ETN ${ref.market}:${ref.ticker} が見つかりません。`)
  if (ref.market === 'JP') {
    const loaded = await loadJpAsset({ kind: 'JP', ticker: ref.ticker, key: `JP:${ref.ticker}`, input: ref.input }, period)
    return {
      ...loaded,
      meta: {
        ...ref,
        name: instrument.shortName,
        marketLabel: '商品 JP',
        currency: instrument.currency,
        priceBasis: loaded.meta.priceBasis,
      },
    }
  }
  const loaded = await loadUsAsset({ kind: 'US', ticker: ref.ticker, key: `US:${ref.ticker}`, input: ref.input }, period)
  return {
    ...loaded,
    meta: {
      ...ref,
      name: instrument.shortName,
      marketLabel: '商品 US',
      currency: instrument.currency,
      priceBasis: loaded.meta.priceBasis,
    },
  }
}

function priceRowsToMap(rows: PriceRow[], preferAdjusted: boolean): Map<string, AssetCandle> {
  const map = new Map<string, AssetCandle>()
  for (const row of rows) {
    const close = preferAdjusted ? row.adjClose ?? row.close : row.close
    if (!Number.isFinite(close) || !Number.isFinite(row.open) || !Number.isFinite(row.high) || !Number.isFinite(row.low)) continue
    const adjustment = preferAdjusted && row.adjClose != null && row.close !== 0 ? row.adjClose / row.close : 1
    const open = row.open * adjustment
    const high = row.high * adjustment
    const low = row.low * adjustment
    const normalizedHigh = Math.max(open, high, low, close)
    const normalizedLow = Math.min(open, high, low, close)
    map.set(row.date, {
      open,
      high: normalizedHigh,
      low: normalizedLow,
      close,
      volume: Number(row.volume ?? 0),
    })
  }
  return map
}

async function loadFxRows(): Promise<FxRow[]> {
  return execAll<FxRow>(
    `SELECT date, rate FROM fx_rates_daily WHERE pair = 'USDJPY' ORDER BY date`,
  )
}

function buildDailySeries(args: {
  ast: FormulaNode
  assets: LoadedAsset[]
  mode: CustomChartMode
  missingPolicy: CustomChartMissingPolicy
  displayCurrency: 'JPY' | 'USD' | 'MIXED'
  baseDate: string | null
  fxRows: FxRow[]
  volumeMode: 'turnover' | 'volume'
  warnings: string[]
}): OHLCV[] {
  const dates = args.missingPolicy === 'intersection' ? intersectionDates(args.assets) : unionDates(args.assets)
  const lastByAsset = new Map<string, AssetCandle & { date: string }>()
  const baseByAsset = new Map<string, number>()
  const out: OHLCV[] = []

  for (const date of dates) {
    const candles = new Map<string, AssetCandle>()
    let volumeTotal = 0
    let complete = true

    for (const asset of args.assets) {
      const current = asset.rows.get(date)
      if (current) lastByAsset.set(asset.meta.key, { ...current, date })
      const source = args.missingPolicy === 'carry-forward' ? lastByAsset.get(asset.meta.key) : current ? { ...current, date } : null
      if (!source) {
        complete = false
        break
      }

      let converted: AssetCandle = {
        open: source.open,
        high: source.high,
        low: source.low,
        close: source.close,
        volume: source.volume,
      }
      if (args.displayCurrency !== 'MIXED') {
        converted = convertCandleCurrency(converted, asset.meta.currency, args.displayCurrency, date, args.fxRows)
      }

      if (args.mode === 'normalized') {
        if (!baseByAsset.has(asset.meta.key) && (!args.baseDate || date >= args.baseDate)) {
          if (converted.close !== 0) baseByAsset.set(asset.meta.key, converted.close)
        }
        const base = baseByAsset.get(asset.meta.key)
        if (!base) {
          complete = false
          break
        }
        converted = normalizeCandle(converted, base)
      }

      candles.set(asset.meta.key, converted)
      volumeTotal += args.volumeMode === 'turnover' ? Math.abs(converted.close * source.volume) : source.volume
    }

    if (!complete) continue
    const candle = evaluateSyntheticCandle(args.ast, args.assets, candles)
    if (candle && Number.isFinite(candle.close)) out.push({ date, ...candle, volume: volumeTotal })
  }

  if (args.missingPolicy === 'carry-forward') args.warnings.push('欠損日は直近価格を引き継いでいます。')
  if (args.mode === 'normalized') args.warnings.push('基準化比較では、各銘柄を基準価格=100に変換してから数式を評価しています。')
  args.warnings.push('ロウソク足は構成銘柄のOHLCを同じ数式で合成した近似です。')
  return out
}

function normalizeCandle(candle: AssetCandle, base: number): AssetCandle {
  const open = (candle.open / base) * 100
  const high = (candle.high / base) * 100
  const low = (candle.low / base) * 100
  const close = (candle.close / base) * 100
  return {
    open,
    high: Math.max(open, high, low, close),
    low: Math.min(open, high, low, close),
    close,
    volume: candle.volume,
  }
}

function convertCandleCurrency(
  candle: AssetCandle,
  from: 'JPY' | 'USD',
  to: 'JPY' | 'USD',
  date: string,
  fxRows: FxRow[],
): AssetCandle {
  return {
    open: convertCurrency(candle.open, from, to, date, fxRows),
    high: convertCurrency(candle.high, from, to, date, fxRows),
    low: convertCurrency(candle.low, from, to, date, fxRows),
    close: convertCurrency(candle.close, from, to, date, fxRows),
    volume: candle.volume,
  }
}

function evaluateSyntheticCandle(
  ast: FormulaNode,
  assets: LoadedAsset[],
  candles: Map<string, AssetCandle>,
): Pick<OHLCV, 'open' | 'high' | 'low' | 'close'> | null {
  const open = evaluateByField(ast, assets, candles, 'open')
  const close = evaluateByField(ast, assets, candles, 'close')
  const highDirect = evaluateByField(ast, assets, candles, 'high', true)
  const lowDirect = evaluateByField(ast, assets, candles, 'low', true)
  const extremaCandidates = [open, close, highDirect, lowDirect]
  const comboCandidates = highLowCombinations(ast, assets, candles)
  extremaCandidates.push(...comboCandidates)
  const finite = extremaCandidates.filter((value) => Number.isFinite(value))
  if (!Number.isFinite(open) || !Number.isFinite(close) || finite.length === 0) return null
  return {
    open,
    high: Math.max(...finite),
    low: Math.min(...finite),
    close,
  }
}

function evaluateByField(
  ast: FormulaNode,
  assets: LoadedAsset[],
  candles: Map<string, AssetCandle>,
  field: 'open' | 'high' | 'low' | 'close',
  suppressFormulaErrors = false,
): number {
  const values = new Map<string, number>()
  for (const asset of assets) {
    const candle = candles.get(asset.meta.key)
    if (!candle) return Number.NaN
    values.set(asset.meta.key, candle[field])
  }
  if (!suppressFormulaErrors) return evaluateFormulaNode(ast, values)
  try {
    return evaluateFormulaNode(ast, values)
  } catch {
    return Number.NaN
  }
}

function highLowCombinations(ast: FormulaNode, assets: LoadedAsset[], candles: Map<string, AssetCandle>): number[] {
  if (assets.length === 0 || assets.length > 8) return []
  const out: number[] = []
  const walk = (index: number, values: Map<string, number>) => {
    if (index >= assets.length) {
      try {
        out.push(evaluateFormulaNode(ast, values))
      } catch {
        // 一部の高値/安値組み合わせが0除算になる場合は、その候補だけ除外する。
      }
      return
    }
    const asset = assets[index]
    const candle = candles.get(asset.meta.key)
    if (!candle) return
    values.set(asset.meta.key, candle.low)
    walk(index + 1, values)
    values.set(asset.meta.key, candle.high)
    walk(index + 1, values)
    values.delete(asset.meta.key)
  }
  walk(0, new Map())
  return out
}

function unionDates(assets: LoadedAsset[]): string[] {
  return Array.from(new Set(assets.flatMap((asset) => Array.from(asset.rows.keys())))).sort()
}

function intersectionDates(assets: LoadedAsset[]): string[] {
  if (assets.length === 0) return []
  let dates = new Set(assets[0].rows.keys())
  for (const asset of assets.slice(1)) {
    dates = new Set(Array.from(dates).filter((date) => asset.rows.has(date)))
  }
  return Array.from(dates).sort()
}

function convertCurrency(value: number, from: 'JPY' | 'USD', to: 'JPY' | 'USD', date: string, fxRows: FxRow[]): number {
  if (from === to) return value
  const rate = findUsdJpyRate(date, fxRows)
  if (!rate) throw new Error(`USDJPYの日次レートが不足しています: ${date}`)
  return from === 'USD' && to === 'JPY' ? value * rate : value / rate
}

function findUsdJpyRate(date: string, rows: FxRow[]): number | null {
  let best: FxRow | null = null
  for (const row of rows) {
    if (row.date > date) break
    best = row
  }
  if (!best) return null
  const diffDays = Math.floor((Date.parse(`${date}T00:00:00Z`) - Date.parse(`${best.date}T00:00:00Z`)) / 86_400_000)
  if (diffDays < 0 || diffDays > 7) return null
  return best.rate
}

function buildIndicators(rows: OHLCV[], config: CustomChartIndicatorConfig): CustomChartEvaluation['indicators'] {
  const ma: Record<string, Array<{ date: string; value: number }>> = {}
  for (const period of config.ma) {
    const values = smaSeries(rows, period)
    ma[String(period)] = rows
      .map((row, index) => ({ date: row.date, value: values[index] }))
      .filter((row): row is { date: string; value: number } => row.value != null && Number.isFinite(row.value))
  }

  const bb = config.bollinger ? calcBollingerBands(rows, 20, 2) : null
  const rsi = config.rsi ? calcRSI(rows, 14) : null
  const macd = config.macd ? calcMACD(rows) : null

  return {
    ma,
    bollinger: bb
      ? {
          upper: mapNullableSeries(rows, bb.upper),
          middle: mapNullableSeries(rows, bb.middle),
          lower: mapNullableSeries(rows, bb.lower),
        }
      : null,
    rsi: rsi ? mapNullableSeries(rows, rsi) : null,
    macd: macd
      ? {
          macd: mapNullableSeries(rows, macd.macd),
          signal: mapNullableSeries(rows, macd.signal),
          histogram: mapNullableSeries(rows, macd.histogram),
        }
      : null,
  }
}

function mapNullableSeries(rows: OHLCV[], values: Array<number | null>): Array<{ date: string; value: number }> {
  return rows
    .map((row, index) => ({ date: row.date, value: values[index] }))
    .filter((row): row is { date: string; value: number } => row.value != null && Number.isFinite(row.value))
}

function describeFormula(ast: FormulaNode, assets: CustomChartAssetMeta[], mode: CustomChartMode): string {
  const labels = new Map(assets.map((asset) => [asset.key, asset.name]))
  const formatted = formatFormula(ast).replace(/(JP|US|CMD:JP|CMD:US):[A-Z0-9._-]+/g, (token) => labels.get(normalizeAssetRef(token).key) ?? token)
  if (mode === 'valuation') return `${formatted} の合計評価額推移を表示します。`
  if (mode === 'normalized') return `${formatted} を基準値100に変換した系列で評価します。`
  return `${formatted} の価格差・比率などを表示します。`
}

export async function searchCustomChartSymbols(query: string): Promise<CustomChartSymbolCandidate[]> {
  const q = query.trim()
  if (!q) return []
  const escaped = q.replace(/[%_]/g, (m) => `\\${m}`)
  const upper = q.toUpperCase()
  const pattern = `%${escaped.toUpperCase()}%`
  const [jpRows, usRows] = await Promise.all([
    execAll<{ ticker: string; name: string | null; marketSegment: string | null }>(
      `
        SELECT ticker, name, market_segment AS marketSegment
        FROM ticker_universe
        WHERE active = 1 AND (ticker LIKE ? ESCAPE '\\' OR UPPER(COALESCE(name, '')) LIKE ? ESCAPE '\\')
        ORDER BY CASE WHEN ticker = ? THEN 0 WHEN ticker LIKE ? ESCAPE '\\' THEN 1 ELSE 2 END, ticker
        LIMIT 8
      `,
      [pattern, pattern, upper, `${upper}%`],
    ),
    execAll<{ ticker: string; name: string | null; exchange: string | null; currency: string | null }>(
      `
        SELECT ticker, name, exchange, currency
        FROM market_universe
        WHERE market = 'US' AND active = 1 AND (ticker LIKE ? ESCAPE '\\' OR UPPER(COALESCE(name, '')) LIKE ? ESCAPE '\\')
        ORDER BY CASE WHEN ticker = ? THEN 0 WHEN ticker LIKE ? ESCAPE '\\' THEN 1 ELSE 2 END, ticker
        LIMIT 8
      `,
      [pattern, pattern, upper, `${upper}%`],
    ),
  ])
  const commodityRows = COMMODITY_INSTRUMENTS
    .filter((item) => item.ticker.includes(upper) || item.name.toUpperCase().includes(upper) || item.shortName.toUpperCase().includes(upper) || item.commodity.toUpperCase().includes(upper))
    .slice(0, 8)
    .map((item): CustomChartSymbolCandidate => ({
      token: `CMD:${item.market}:${item.ticker}`,
      label: `${item.ticker} ${item.shortName}`,
      name: item.name,
      market: 'CMD',
      ticker: item.ticker,
      currency: item.currency,
      description: `${item.market} / ${item.commodity}`,
    }))

  return [
    ...jpRows.map((row): CustomChartSymbolCandidate => ({
      token: `JP:${row.ticker}`,
      label: `${row.ticker} ${row.name ?? ''}`.trim(),
      name: row.name ?? row.ticker,
      market: 'JP',
      ticker: row.ticker,
      currency: 'JPY',
      description: row.marketSegment ?? 'JP',
    })),
    ...usRows.map((row): CustomChartSymbolCandidate => ({
      token: `US:${row.ticker}`,
      label: `${row.ticker} ${row.name ?? ''}`.trim(),
      name: row.name ?? row.ticker,
      market: 'US',
      ticker: row.ticker,
      currency: row.currency === 'JPY' ? 'JPY' : 'USD',
      description: row.exchange ?? 'US',
    })),
    ...commodityRows,
  ].slice(0, 20)
}

export async function listSharedCustomCharts(): Promise<StoredCustomChart[]> {
  const rows = await execAll<StoredChartRow>(
    `
      SELECT
        id,
        name,
        formula,
        mode,
        base_date AS baseDate,
        display_currency AS displayCurrency,
        missing_policy AS missingPolicy,
        indicator_config_json AS indicatorConfigJson,
        favorite,
        sort_order AS sortOrder,
        created_at AS createdAt,
        updated_at AS updatedAt
      FROM custom_charts
      ORDER BY favorite DESC, sort_order ASC, updated_at DESC
    `,
  )
  return rows.map(mapStoredChart)
}

export async function getSharedCustomChart(id: string): Promise<StoredCustomChart | null> {
  const row = await execGet<StoredChartRow>(
    `
      SELECT
        id,
        name,
        formula,
        mode,
        base_date AS baseDate,
        display_currency AS displayCurrency,
        missing_policy AS missingPolicy,
        indicator_config_json AS indicatorConfigJson,
        favorite,
        sort_order AS sortOrder,
        created_at AS createdAt,
        updated_at AS updatedAt
      FROM custom_charts
      WHERE id = ?
      LIMIT 1
    `,
    [id],
  )
  return row ? mapStoredChart(row) : null
}

export async function createSharedCustomChart(input: Partial<StoredCustomChart>): Promise<StoredCustomChart> {
  const request = sanitizeCustomChartRequest({ ...input, indicators: input.indicators ?? DEFAULT_CUSTOM_CHART_INDICATORS })
  const ast = parseFormula(request.formula)
  const id = crypto.randomUUID()
  const now = Math.floor(Date.now() / 1000)
  const sortOrder = input.sortOrder ?? now
  await execRun(
    `
      INSERT INTO custom_charts
        (id, name, formula, formula_ast_json, mode, base_date, display_currency, missing_policy,
         indicator_config_json, favorite, sort_order, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    [
      id,
      input.name?.trim() || '名称未設定',
      request.formula,
      JSON.stringify(ast),
      request.mode,
      request.baseDate ?? null,
      request.displayCurrency,
      request.missingPolicy,
      JSON.stringify(request.indicators),
      input.favorite ? 1 : 0,
      sortOrder,
      now,
      now,
    ],
  )
  const stored = await getSharedCustomChart(id)
  if (!stored) throw new Error('保存した合成チャートを読み込めませんでした。')
  return stored
}

export async function updateSharedCustomChart(id: string, input: Partial<StoredCustomChart>): Promise<StoredCustomChart> {
  const current = await getSharedCustomChart(id)
  if (!current) throw new Error('合成チャートが見つかりません。')
  const request = sanitizeCustomChartRequest({
    formula: input.formula ?? current.formula,
    mode: input.mode ?? current.mode,
    baseDate: input.baseDate ?? current.baseDate,
    displayCurrency: input.displayCurrency ?? current.displayCurrency,
    missingPolicy: input.missingPolicy ?? current.missingPolicy,
    indicators: input.indicators ?? current.indicators,
    period: '1y',
    interval: 'D',
  })
  const ast = parseFormula(request.formula)
  const now = Math.floor(Date.now() / 1000)
  await execRun(
    `
      UPDATE custom_charts
      SET name = ?,
          formula = ?,
          formula_ast_json = ?,
          mode = ?,
          base_date = ?,
          display_currency = ?,
          missing_policy = ?,
          indicator_config_json = ?,
          favorite = ?,
          sort_order = ?,
          updated_at = ?
      WHERE id = ?
    `,
    [
      input.name?.trim() || current.name,
      request.formula,
      JSON.stringify(ast),
      request.mode,
      request.baseDate ?? null,
      request.displayCurrency,
      request.missingPolicy,
      JSON.stringify(request.indicators),
      (input.favorite ?? current.favorite) ? 1 : 0,
      input.sortOrder ?? current.sortOrder,
      now,
      id,
    ],
  )
  const stored = await getSharedCustomChart(id)
  if (!stored) throw new Error('更新した合成チャートを読み込めませんでした。')
  return stored
}

export async function deleteSharedCustomChart(id: string): Promise<void> {
  await execRun(`DELETE FROM custom_charts WHERE id = ?`, [id])
}

function mapStoredChart(row: StoredChartRow): StoredCustomChart {
  return {
    id: row.id,
    name: row.name,
    formula: row.formula,
    mode: row.mode,
    baseDate: row.baseDate,
    displayCurrency: row.displayCurrency,
    missingPolicy: row.missingPolicy,
    indicators: parseIndicatorConfig(row.indicatorConfigJson),
    favorite: Boolean(row.favorite),
    sortOrder: Number(row.sortOrder ?? 0),
    createdAt: Number(row.createdAt ?? 0),
    updatedAt: Number(row.updatedAt ?? 0),
  }
}

function parseIndicatorConfig(json: string): CustomChartIndicatorConfig {
  try {
    return sanitizeCustomChartRequest({ formula: '7203', indicators: JSON.parse(json) }).indicators
  } catch {
    return DEFAULT_CUSTOM_CHART_INDICATORS
  }
}

export async function importFxRatesFromCsv(csvText: string, source = 'csv'): Promise<{ imported: number; skipped: number }> {
  const lines = csvText.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
  let imported = 0
  let skipped = 0
  const stmts: Array<{ sql: string; args: Array<string | number> }> = []
  for (const [index, line] of lines.entries()) {
    const cols = line.split(',').map((col) => col.trim())
    if (index === 0 && cols.some((col) => /date|pair|rate|usdjpy/i.test(col))) continue
    const parsed = parseFxCsvColumns(cols)
    if (!parsed) {
      skipped += 1
      continue
    }
    stmts.push({
      sql: `
        INSERT INTO fx_rates_daily (pair, date, rate, source, imported_at)
        VALUES (?, ?, ?, ?, unixepoch())
        ON CONFLICT(pair, date) DO UPDATE SET
          rate = excluded.rate,
          source = excluded.source,
          imported_at = excluded.imported_at
      `,
      args: [parsed.pair, parsed.date, parsed.rate, source],
    })
    imported += 1
  }
  for (const stmt of stmts) await execRun(stmt.sql, stmt.args)
  return { imported, skipped }
}

function parseFxCsvColumns(cols: string[]): { pair: string; date: string; rate: number } | null {
  if (cols.length >= 3) {
    const [date, pair, rawRate] = cols
    const rate = Number(rawRate)
    const normalizedPair = pair.toUpperCase().replace('/', '')
    if (/^\d{4}-\d{2}-\d{2}$/.test(date) && normalizedPair === 'USDJPY' && Number.isFinite(rate) && rate > 0) {
      return { pair: 'USDJPY', date, rate }
    }
  }
  if (cols.length >= 2) {
    const [date, rawRate] = cols
    const rate = Number(rawRate)
    if (/^\d{4}-\d{2}-\d{2}$/.test(date) && Number.isFinite(rate) && rate > 0) {
      return { pair: 'USDJPY', date, rate }
    }
  }
  return null
}

export async function latestFxRateStatus(): Promise<{ pair: string; latestDate: string | null; count: number }> {
  const row = await execGet<{ latestDate: string | null; count: number }>(
    `SELECT MAX(date) AS latestDate, COUNT(*) AS count FROM fx_rates_daily WHERE pair = 'USDJPY'`,
  )
  return { pair: 'USDJPY', latestDate: row?.latestDate ?? null, count: Number(row?.count ?? 0) }
}
