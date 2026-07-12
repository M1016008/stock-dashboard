import { client, execAll, execGet } from '@/lib/db/client'
import { buildShortTermCheck, formatShortTermStrength, type ShortTermCheckLabel } from '@/lib/short-term-check'

export type KabutanMaterialNewsArticle = {
  articleId: string
  title: string
  publishedAt: string
  url: string
  category: string
  snippet: string | null
  relatedTickers: string[]
  relatedStocks: KabutanMaterialNewsStock[]
  source: string
  fetchedAt: number
  parseStatus: string
  errorSummary: string | null
}

export type KabutanMaterialNewsStock = {
  ticker: string
  name: string
  closeText: string | null
  changeText: string | null
  comment: string | null
  materialTone?: 'good' | 'bad' | 'neutral' | null
  marketText?: string | null
  screener?: KabutanScreenerInfo | null
}

export type KabutanScreenerInfo = {
  asOfDate: string
  price: number | null
  volume: number | null
  marketSegment: string | null
  sector17Name: string | null
  sector33Name: string | null
  marginType: string | null
  stages: {
    dailyA: number | null
    dailyB: number | null
    weeklyA: number | null
    weeklyB: number | null
    monthlyA: number | null
    monthlyB: number | null
  }
  stageCode: string
  shortTermCheckLabel: ShortTermCheckLabel
  shortTermCheckScore: number
  shortTermCheckStrength: string
}

export type KabutanMaterialNewsRun = {
  id: number
  status: string
  startedAt: number
  finishedAt: number | null
  fetchedCount: number
  savedCount: number
  errorSummary: string | null
}

type ArticleRow = Omit<KabutanMaterialNewsArticle, 'relatedTickers' | 'relatedStocks'> & {
  relatedTickersJson: string
  relatedStocksJson: string
}

const PREVIOUS_DAY_MOVERS_SQL_FILTER = `
  (
    REPLACE(REPLACE(title, ' ', ''), '　', '') LIKE '%前日に動いた銘柄%'
    OR REPLACE(REPLACE(title, ' ', ''), '　', '') LIKE '%前日動いた銘柄%'
  )
`

const GOOD_BAD_DISCLOSURE_SQL_FILTER = `
  (
    REPLACE(REPLACE(title, ' ', ''), '　', '') LIKE '%明日の好悪材料%'
    AND REPLACE(REPLACE(title, ' ', ''), '　', '') LIKE '%開示情報でチェック%'
  )
`

const DASHBOARD_TARGET_SQL_FILTER = `(${PREVIOUS_DAY_MOVERS_SQL_FILTER} OR ${GOOD_BAD_DISCLOSURE_SQL_FILTER})`
const NOT_DASHBOARD_TARGET_SQL_FILTER = `(NOT ${DASHBOARD_TARGET_SQL_FILTER})`

let ensureKabutanTablesPromise: Promise<void> | null = null

export function isKabutanPreviousDayMoversTitle(title: string): boolean {
  const normalized = title.replace(/[\s　]+/g, '')
  return /前日(?:に)?動いた銘柄/u.test(normalized)
}

export function isKabutanGoodBadDisclosureTitle(title: string): boolean {
  const normalized = title.replace(/[\s　]+/g, '')
  return /明日の好悪材料/u.test(normalized) && /開示情報でチェック/u.test(normalized)
}

export function isKabutanDashboardTargetTitle(title: string): boolean {
  return isKabutanPreviousDayMoversTitle(title) || isKabutanGoodBadDisclosureTitle(title)
}

export async function ensureKabutanMaterialNewsTables(): Promise<void> {
  if (!ensureKabutanTablesPromise) {
    const statements = [
      {
        sql: `CREATE TABLE IF NOT EXISTS kabutan_material_news (
          article_id TEXT PRIMARY KEY,
          title TEXT NOT NULL,
          published_at TEXT NOT NULL,
          url TEXT NOT NULL,
          category TEXT NOT NULL DEFAULT '材料',
          snippet TEXT,
          related_tickers_json TEXT NOT NULL DEFAULT '[]',
          related_stocks_json TEXT NOT NULL DEFAULT '[]',
          source TEXT NOT NULL DEFAULT 'kabutan',
          fetched_at INTEGER NOT NULL DEFAULT (unixepoch()),
          parse_status TEXT NOT NULL DEFAULT 'ok',
          error_summary TEXT
        )`,
        args: [],
      },
      {
        sql: `ALTER TABLE kabutan_material_news ADD COLUMN related_stocks_json TEXT NOT NULL DEFAULT '[]'`,
        args: [],
      },
      {
        sql: `CREATE INDEX IF NOT EXISTS kabutan_material_news_published_idx ON kabutan_material_news(published_at DESC)`,
        args: [],
      },
      {
        sql: `CREATE INDEX IF NOT EXISTS kabutan_material_news_status_idx ON kabutan_material_news(parse_status, fetched_at DESC)`,
        args: [],
      },
      {
        sql: `CREATE TABLE IF NOT EXISTS kabutan_material_news_runs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          status TEXT NOT NULL,
          started_at INTEGER NOT NULL DEFAULT (unixepoch()),
          finished_at INTEGER,
          fetched_count INTEGER NOT NULL DEFAULT 0,
          saved_count INTEGER NOT NULL DEFAULT 0,
          error_summary TEXT
        )`,
        args: [],
      },
      {
        sql: `CREATE INDEX IF NOT EXISTS kabutan_material_news_runs_latest_idx ON kabutan_material_news_runs(started_at DESC)`,
        args: [],
      },
    ]

    ensureKabutanTablesPromise = Promise.resolve()
      .then(async () => {
        for (const statement of statements) {
          try {
            await client.execute(statement)
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            if (!/duplicate column name/i.test(message)) throw error
          }
        }
      })
      .then(() => undefined)
      .catch((error) => {
        ensureKabutanTablesPromise = null
        throw error
      })
  }
  await ensureKabutanTablesPromise
}

export async function pruneKabutanMaterialNewsToPreviousDayMovers(): Promise<number> {
  await ensureKabutanMaterialNewsTables()
  const result = await client.execute({
    sql: `DELETE FROM kabutan_material_news WHERE ${NOT_DASHBOARD_TARGET_SQL_FILTER}`,
    args: [],
  })
  return Number(result.rowsAffected ?? 0)
}

function parseTickers(json: string): string[] {
  try {
    const value = JSON.parse(json)
    return Array.isArray(value)
      ? value.map((item) => String(item).trim().toUpperCase()).filter((item) => /^(?:\d{4}|\d{3}[A-Z])$/.test(item))
      : []
  } catch {
    return []
  }
}

function parseStocks(json: string): KabutanMaterialNewsStock[] {
  try {
    const value = JSON.parse(json)
    if (!Array.isArray(value)) return []
    return value
      .map((item): KabutanMaterialNewsStock | null => {
        const row = item as Partial<KabutanMaterialNewsStock>
        const ticker = String(row.ticker ?? '').trim().toUpperCase()
        const name = String(row.name ?? '').trim()
        if (!/^(?:\d{4}|\d{3}[A-Z])$/.test(ticker) || !name) return null
        return {
          ticker,
          name,
          closeText: row.closeText ? String(row.closeText) : null,
          changeText: row.changeText ? String(row.changeText) : null,
          comment: row.comment ? String(row.comment) : null,
          materialTone: row.materialTone === 'good' || row.materialTone === 'bad' || row.materialTone === 'neutral'
            ? row.materialTone
            : null,
          marketText: row.marketText ? String(row.marketText) : null,
        }
      })
      .filter((item): item is KabutanMaterialNewsStock => item !== null)
  } catch {
    return []
  }
}

type ScreenerInfoRow = {
  ticker: string
  asOfDate: string
  price: number | null
  volume: number | null
  marketSegment: string | null
  sector17Name: string | null
  sector33Name: string | null
  marginType: string | null
  dailyAStage: number | null
  dailyBStage: number | null
  weeklyAStage: number | null
  weeklyBStage: number | null
  monthlyAStage: number | null
  monthlyBStage: number | null
}

type ArticlePriceRow = {
  ticker: string
  priceDate: string
  close: number | null
  prevClose: number | null
  changePct: number | null
}

function stageChar(value: number | null): string {
  return value == null || !Number.isFinite(value) ? '-' : String(Math.round(value))
}

function isoDateInTokyo(value: string | null | undefined): string | null {
  if (!value) return null
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) {
    const match = value.match(/^(\d{4}-\d{2}-\d{2})/)
    return match?.[1] ?? null
  }
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date)
}

function disclosureTargetDate(article: Pick<KabutanMaterialNewsArticle, 'title' | 'publishedAt'>): string | null {
  const publishedDate = isoDateInTokyo(article.publishedAt)
  if (!publishedDate) return null
  const match = article.title.match(/(\d{1,2})月(\d{1,2})日発表分/u)
  if (!match) return publishedDate

  const publishedYear = Number(publishedDate.slice(0, 4))
  const month = Number(match[1])
  const day = Number(match[2])
  if (!Number.isFinite(month) || !Number.isFinite(day)) return publishedDate

  let year = publishedYear
  const publishedMonth = Number(publishedDate.slice(5, 7))
  if (publishedMonth === 1 && month === 12) year -= 1
  const candidate = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
  return /^\d{4}-\d{2}-\d{2}$/.test(candidate) ? candidate : publishedDate
}

function formatArticleClose(value: number | null | undefined): string | null {
  if (value == null || !Number.isFinite(value)) return null
  return value.toLocaleString('ja-JP', {
    maximumFractionDigits: value >= 1000 ? 0 : 1,
    minimumFractionDigits: 0,
  })
}

function formatArticleChangePct(value: number | null | undefined): string | null {
  if (value == null || !Number.isFinite(value)) return null
  return `${value >= 0 ? '+' : ''}${value.toFixed(2)}%`
}

async function loadArticlePriceFallbacks(
  articles: Array<Pick<KabutanMaterialNewsArticle, 'articleId' | 'title' | 'publishedAt' | 'relatedTickers' | 'relatedStocks'>>,
): Promise<Map<string, { closeText: string | null; changeText: string | null; priceDate: string | null }>> {
  const byDate = new Map<string, Set<string>>()
  for (const article of articles) {
    const targetDate = disclosureTargetDate(article)
    if (!targetDate) continue
    const tickers = [
      ...article.relatedTickers,
      ...article.relatedStocks.map((stock) => stock.ticker),
    ].filter((ticker) => /^(?:\d{4}|\d{3}[A-Z])$/.test(ticker))
    if (tickers.length === 0) continue
    const set = byDate.get(targetDate) ?? new Set<string>()
    for (const ticker of tickers) set.add(ticker)
    byDate.set(targetDate, set)
  }

  const fallbackByDateTicker = new Map<string, { closeText: string | null; changeText: string | null; priceDate: string | null }>()
  for (const [targetDate, tickerSet] of byDate.entries()) {
    const tickers = Array.from(tickerSet)
    if (tickers.length === 0) continue
    const placeholders = tickers.map(() => '?').join(', ')
    const rows = await execAll<ArticlePriceRow>(
      `
        WITH price_date AS (
          SELECT MAX(date) AS date
          FROM ohlcv_daily
          WHERE date <= ?
        ),
        prev_date AS (
          SELECT MAX(date) AS date
          FROM ohlcv_daily
          WHERE date < (SELECT date FROM price_date)
        )
        SELECT
          cur.ticker,
          cur.date AS priceDate,
          cur.close,
          prev.close AS prevClose,
          CASE
            WHEN prev.close IS NOT NULL AND prev.close > 0 THEN 100.0 * (cur.close - prev.close) / prev.close
          END AS changePct
        FROM ohlcv_daily cur
        LEFT JOIN ohlcv_daily prev
          ON prev.ticker = cur.ticker
         AND prev.date = (SELECT date FROM prev_date)
        WHERE cur.date = (SELECT date FROM price_date)
          AND cur.ticker IN (${placeholders})
      `,
      [targetDate, ...tickers],
    )
    for (const row of rows) {
      fallbackByDateTicker.set(`${targetDate}:${row.ticker}`, {
        closeText: formatArticleClose(row.close),
        changeText: formatArticleChangePct(row.changePct),
        priceDate: row.priceDate,
      })
    }
  }

  const map = new Map<string, { closeText: string | null; changeText: string | null; priceDate: string | null }>()
  for (const article of articles) {
    const targetDate = disclosureTargetDate(article)
    if (!targetDate) continue
    for (const stock of article.relatedStocks) {
      const fallback = fallbackByDateTicker.get(`${targetDate}:${stock.ticker}`)
      if (fallback) map.set(`${article.articleId}:${stock.ticker}`, fallback)
    }
    for (const ticker of article.relatedTickers) {
      const fallback = fallbackByDateTicker.get(`${targetDate}:${ticker}`)
      if (fallback) map.set(`${article.articleId}:${ticker}`, fallback)
    }
  }
  return map
}

export async function loadKabutanScreenerInfo(tickers: string[]): Promise<Map<string, KabutanScreenerInfo>> {
  const uniqueTickers = Array.from(new Set(tickers.filter((ticker) => /^(?:\d{4}|\d{3}[A-Z])$/.test(ticker))))
  if (uniqueTickers.length === 0) return new Map()

  const placeholders = uniqueTickers.map(() => '?').join(', ')
  const rows = await execAll<ScreenerInfoRow>(
    `
      WITH latest AS (SELECT MAX(date) AS date FROM daily_snapshots)
      SELECT
        s.ticker,
        s.date AS asOfDate,
        cur.close AS price,
        cur.volume AS volume,
        u.market_segment AS marketSegment,
        u.sector17_name AS sector17Name,
        u.sector33_name AS sector33Name,
        u.margin_type AS marginType,
        s.daily_a_stage AS dailyAStage,
        s.daily_b_stage AS dailyBStage,
        s.weekly_a_stage AS weeklyAStage,
        s.weekly_b_stage AS weeklyBStage,
        s.monthly_a_stage AS monthlyAStage,
        s.monthly_b_stage AS monthlyBStage
      FROM daily_snapshots s
      JOIN latest ON latest.date = s.date
      LEFT JOIN ohlcv_daily cur ON cur.ticker = s.ticker AND cur.date = s.date
      LEFT JOIN ticker_universe u ON u.ticker = s.ticker
      WHERE s.ticker IN (${placeholders})
    `,
    uniqueTickers,
  )

  const map = new Map<string, KabutanScreenerInfo>()
  for (const row of rows) {
    const shortTermCheck = buildShortTermCheck({
      stages: {
        dailyA: row.dailyAStage,
        dailyB: row.dailyBStage,
        weeklyA: row.weeklyAStage,
        weeklyB: row.weeklyBStage,
        monthlyA: row.monthlyAStage,
        monthlyB: row.monthlyBStage,
      },
      physicalMomentumScore: null,
      physicalForceScore: null,
      changePercent: null,
    })
    map.set(row.ticker, {
      asOfDate: row.asOfDate,
      price: row.price,
      volume: row.volume,
      marketSegment: row.marketSegment,
      sector17Name: row.sector17Name,
      sector33Name: row.sector33Name,
      marginType: row.marginType,
      stages: {
        dailyA: row.dailyAStage,
        dailyB: row.dailyBStage,
        weeklyA: row.weeklyAStage,
        weeklyB: row.weeklyBStage,
        monthlyA: row.monthlyAStage,
        monthlyB: row.monthlyBStage,
      },
      stageCode: [
        row.dailyAStage,
        row.dailyBStage,
        row.weeklyAStage,
        row.weeklyBStage,
        row.monthlyAStage,
        row.monthlyBStage,
      ].map(stageChar).join(''),
      shortTermCheckLabel: shortTermCheck.label,
      shortTermCheckScore: shortTermCheck.score,
      shortTermCheckStrength: formatShortTermStrength(shortTermCheck.label, shortTermCheck.score),
    })
  }
  return map
}

async function getKabutanArticlesByFilter(filterSql: string, limit = 12): Promise<{
  articles: KabutanMaterialNewsArticle[]
  lastRun: KabutanMaterialNewsRun | null
}> {
  await ensureKabutanMaterialNewsTables()
  const safeLimit = Math.max(1, Math.min(30, Math.floor(limit)))
  const [rows, lastRun] = await Promise.all([
    execAll<ArticleRow>(
      `
        SELECT
          article_id AS articleId,
          title,
          published_at AS publishedAt,
          url,
          category,
          snippet,
          related_tickers_json AS relatedTickersJson,
          related_stocks_json AS relatedStocksJson,
          source,
          fetched_at AS fetchedAt,
          parse_status AS parseStatus,
          error_summary AS errorSummary
        FROM kabutan_material_news
        WHERE ${filterSql}
        ORDER BY published_at DESC, fetched_at DESC
        LIMIT ?
      `,
      [safeLimit],
    ),
    execGet<KabutanMaterialNewsRun>(
      `
        SELECT
          id,
          status,
          started_at AS startedAt,
          finished_at AS finishedAt,
          fetched_count AS fetchedCount,
          saved_count AS savedCount,
          error_summary AS errorSummary
        FROM kabutan_material_news_runs
        ORDER BY started_at DESC, id DESC
        LIMIT 1
      `,
    ),
  ])

  const articles = rows.map(({ relatedTickersJson, relatedStocksJson, ...row }) => ({
    ...row,
    relatedTickers: parseTickers(relatedTickersJson),
    relatedStocks: parseStocks(relatedStocksJson),
  }))
  const tickers = articles.flatMap((article) => [
    ...article.relatedTickers,
    ...article.relatedStocks.map((stock) => stock.ticker),
  ])
  const [screenerInfo, priceFallbacks] = await Promise.all([
    loadKabutanScreenerInfo(tickers),
    loadArticlePriceFallbacks(articles),
  ])

  return {
    articles: articles.map((article) => ({
      ...article,
      relatedStocks: article.relatedStocks.map((stock) => {
        const fallback = priceFallbacks.get(`${article.articleId}:${stock.ticker}`)
        return {
          ...stock,
          closeText: stock.closeText ?? fallback?.closeText ?? null,
          changeText: stock.changeText ?? fallback?.changeText ?? null,
          screener: screenerInfo.get(stock.ticker) ?? null,
        }
      }),
    })),
    lastRun: lastRun ?? null,
  }
}

export async function getKabutanMaterialNews(limit = 12): Promise<{
  articles: KabutanMaterialNewsArticle[]
  lastRun: KabutanMaterialNewsRun | null
}> {
  return getKabutanArticlesByFilter(PREVIOUS_DAY_MOVERS_SQL_FILTER, limit)
}

export async function getKabutanGoodBadDisclosureNews(limit = 6): Promise<{
  articles: KabutanMaterialNewsArticle[]
  lastRun: KabutanMaterialNewsRun | null
}> {
  return getKabutanArticlesByFilter(GOOD_BAD_DISCLOSURE_SQL_FILTER, limit)
}
