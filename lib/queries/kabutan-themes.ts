import { client, execAll, execGet } from '@/lib/db/client'
import { loadKabutanScreenerInfo, type KabutanScreenerInfo } from '@/lib/queries/kabutan-material-news'

export type KabutanThemeStock = {
  ticker: string
  name: string
  marketText: string | null
  priceText: string | null
  changeText: string | null
  changePercentText: string | null
  perText: string | null
  pbrText: string | null
  yieldText: string | null
  screener?: KabutanScreenerInfo | null
}

export type KabutanTheme = {
  themeId: string
  name: string
  rank: number | null
  rankingPeriod: string
  rankingAsOf: string | null
  url: string
  description: string | null
  representativeStocks: KabutanThemeStock[]
  relatedStocks: KabutanThemeStock[]
  stockCount: number | null
  source: string
  fetchedAt: number
  parseStatus: string
  errorSummary: string | null
}

export type KabutanThemeRun = {
  id: number
  status: string
  startedAt: number
  finishedAt: number | null
  fetchedCount: number
  savedCount: number
  errorSummary: string | null
}

type ThemeRow = Omit<KabutanTheme, 'representativeStocks' | 'relatedStocks'> & {
  representativeStocksJson: string
  relatedStocksJson: string
}

const KABUTAN_BASE_URL = 'https://kabutan.jp'

let ensureKabutanThemeTablesPromise: Promise<void> | null = null

export function normalizeKabutanThemeId(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

export function stockboardThemePath(themeId: string): string {
  return `/themes/${encodeURIComponent(themeId)}`
}

export function kabutanThemeUrl(name: string): string {
  return `${KABUTAN_BASE_URL}/themes/?theme=${encodeURIComponent(name)}`
}

export async function ensureKabutanThemeTables(): Promise<void> {
  if (!ensureKabutanThemeTablesPromise) {
    const statements = [
      {
        sql: `CREATE TABLE IF NOT EXISTS kabutan_themes (
          theme_id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          rank INTEGER,
          ranking_period TEXT NOT NULL DEFAULT '3days_access',
          ranking_as_of TEXT,
          url TEXT NOT NULL,
          description TEXT,
          representative_stocks_json TEXT NOT NULL DEFAULT '[]',
          related_stocks_json TEXT NOT NULL DEFAULT '[]',
          stock_count INTEGER,
          source TEXT NOT NULL DEFAULT 'kabutan',
          fetched_at INTEGER NOT NULL DEFAULT (unixepoch()),
          parse_status TEXT NOT NULL DEFAULT 'ok',
          error_summary TEXT
        )`,
        args: [],
      },
      {
        sql: `CREATE INDEX IF NOT EXISTS kabutan_themes_rank_idx ON kabutan_themes(rank, fetched_at DESC)`,
        args: [],
      },
      {
        sql: `CREATE INDEX IF NOT EXISTS kabutan_themes_status_idx ON kabutan_themes(parse_status, fetched_at DESC)`,
        args: [],
      },
      {
        sql: `CREATE TABLE IF NOT EXISTS kabutan_theme_runs (
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
        sql: `CREATE INDEX IF NOT EXISTS kabutan_theme_runs_latest_idx ON kabutan_theme_runs(started_at DESC)`,
        args: [],
      },
    ]

    ensureKabutanThemeTablesPromise = Promise.resolve()
      .then(async () => {
        for (const statement of statements) {
          await client.execute(statement)
        }
      })
      .then(() => undefined)
      .catch((error) => {
        ensureKabutanThemeTablesPromise = null
        throw error
      })
  }
  await ensureKabutanThemeTablesPromise
}

function parseStocks(json: string): KabutanThemeStock[] {
  try {
    const value = JSON.parse(json)
    if (!Array.isArray(value)) return []
    return value
      .map((item): KabutanThemeStock | null => {
        const row = item as Partial<KabutanThemeStock>
        const ticker = String(row.ticker ?? '').trim().toUpperCase()
        const name = String(row.name ?? '').trim()
        if (!/^(?:\d{4}|\d{3}[A-Z])$/.test(ticker) || !name) return null
        return {
          ticker,
          name,
          marketText: row.marketText ? String(row.marketText) : null,
          priceText: row.priceText ? String(row.priceText) : null,
          changeText: row.changeText ? String(row.changeText) : null,
          changePercentText: row.changePercentText ? String(row.changePercentText) : null,
          perText: row.perText ? String(row.perText) : null,
          pbrText: row.pbrText ? String(row.pbrText) : null,
          yieldText: row.yieldText ? String(row.yieldText) : null,
          screener: null,
        }
      })
      .filter((item): item is KabutanThemeStock => item !== null)
  } catch {
    return []
  }
}

function mapThemeRow({ representativeStocksJson, relatedStocksJson, ...row }: ThemeRow): KabutanTheme {
  return {
    ...row,
    representativeStocks: parseStocks(representativeStocksJson),
    relatedStocks: parseStocks(relatedStocksJson),
  }
}

async function attachScreenerInfo(theme: KabutanTheme): Promise<KabutanTheme> {
  const tickers = [
    ...theme.representativeStocks.map((stock) => stock.ticker),
    ...theme.relatedStocks.map((stock) => stock.ticker),
  ]
  const screenerInfo = await loadKabutanScreenerInfo(tickers)
  const attach = (stock: KabutanThemeStock): KabutanThemeStock => ({
    ...stock,
    screener: screenerInfo.get(stock.ticker) ?? null,
  })

  return {
    ...theme,
    representativeStocks: theme.representativeStocks.map(attach),
    relatedStocks: theme.relatedStocks.map(attach),
  }
}

export async function getKabutanThemes(limit = 30): Promise<{
  themes: KabutanTheme[]
  lastRun: KabutanThemeRun | null
}> {
  await ensureKabutanThemeTables()
  const safeLimit = Math.max(1, Math.min(60, Math.floor(limit)))
  const [rows, lastRun] = await Promise.all([
    execAll<ThemeRow>(
      `
        SELECT
          theme_id AS themeId,
          name,
          rank,
          ranking_period AS rankingPeriod,
          ranking_as_of AS rankingAsOf,
          url,
          description,
          representative_stocks_json AS representativeStocksJson,
          related_stocks_json AS relatedStocksJson,
          stock_count AS stockCount,
          source,
          fetched_at AS fetchedAt,
          parse_status AS parseStatus,
          error_summary AS errorSummary
        FROM kabutan_themes
        ORDER BY
          CASE WHEN rank IS NULL THEN 1 ELSE 0 END,
          rank ASC,
          fetched_at DESC,
          name ASC
        LIMIT ?
      `,
      [safeLimit],
    ),
    execGet<KabutanThemeRun>(
      `
        SELECT
          id,
          status,
          started_at AS startedAt,
          finished_at AS finishedAt,
          fetched_count AS fetchedCount,
          saved_count AS savedCount,
          error_summary AS errorSummary
        FROM kabutan_theme_runs
        ORDER BY started_at DESC, id DESC
        LIMIT 1
      `,
    ),
  ])

  return {
    themes: rows.map(mapThemeRow),
    lastRun: lastRun ?? null,
  }
}

export async function getKabutanTheme(themeId: string): Promise<KabutanTheme | null> {
  await ensureKabutanThemeTables()
  const normalized = normalizeKabutanThemeId(themeId)
  const row = await execGet<ThemeRow>(
    `
      SELECT
        theme_id AS themeId,
        name,
        rank,
        ranking_period AS rankingPeriod,
        ranking_as_of AS rankingAsOf,
        url,
        description,
        representative_stocks_json AS representativeStocksJson,
        related_stocks_json AS relatedStocksJson,
        stock_count AS stockCount,
        source,
        fetched_at AS fetchedAt,
        parse_status AS parseStatus,
        error_summary AS errorSummary
      FROM kabutan_themes
      WHERE theme_id = ?
      LIMIT 1
    `,
    [normalized],
  )
  return row ? attachScreenerInfo(mapThemeRow(row)) : null
}
