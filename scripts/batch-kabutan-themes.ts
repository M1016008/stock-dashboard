// Kabutan「人気テーマ」ランキングを低頻度で取得し、テーマページ表示用に保存する。
// 画面表示時には株探へ直接アクセスせず、保存済みデータだけを読む。

import { client, ensureReady } from '@/lib/db/client'
import {
  ensureKabutanThemeTables,
  kabutanThemeUrl,
  normalizeKabutanThemeId,
  type KabutanThemeStock,
} from '@/lib/queries/kabutan-themes'

const BASE_URL = 'https://kabutan.jp'
const RANKING_URL = `${BASE_URL}/info/accessranking/3_2`
const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 StockBoardKabutanThemesBot/1.0'

type RankingTheme = {
  themeId: string
  name: string
  rank: number | null
  rankingAsOf: string | null
  url: string
  representativeStocks: KabutanThemeStock[]
}

type ThemeDetail = {
  description: string | null
  relatedStocks: KabutanThemeStock[]
  stockCount: number | null
  parseStatus: 'ok' | 'list_only'
  errorSummary: string | null
}

function nowSec(): number {
  return Math.floor(Date.now() / 1000)
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function envInt(name: string, fallback: number, min: number, max: number): number {
  const raw = Number(process.env[name] ?? fallback)
  if (!Number.isFinite(raw)) return fallback
  return Math.max(min, Math.min(max, Math.floor(raw)))
}

function decodeHtml(value: string): string {
  return value
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)))
}

function stripTags(value: string): string {
  return decodeHtml(value.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim()
}

function truncateText(value: string, max = 360): string {
  const clean = value.replace(/\s+/g, ' ').trim()
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean
}

function absoluteUrl(href: string): string {
  if (/^https?:\/\//.test(href)) return href
  if (href.startsWith('?')) return `${BASE_URL}/themes/${href}`
  return `${BASE_URL}${href.startsWith('/') ? href : `/${href}`}`.replace('?&', '?')
}

function compactCell(value: string): string | null {
  const text = stripTags(value)
    .replace(/^[-－]$/u, '')
    .replace(/^%$/, '')
    .trim()
  return text || null
}

function normalizePercent(value: string | null): string | null {
  if (!value) return null
  return value.endsWith('%') ? value : `${value}%`
}

async function fetchHtml(url: string): Promise<string> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), envInt('KABUTAN_FETCH_TIMEOUT_MS', 15000, 3000, 30000))
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'ja,en-US;q=0.8,en;q=0.6',
      },
    })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    return await response.text()
  } finally {
    clearTimeout(timeout)
  }
}

function parseStockLinks(html: string): KabutanThemeStock[] {
  const stocks: KabutanThemeStock[] = []
  const seen = new Set<string>()
  for (const match of html.matchAll(/<a\s+href="[^"]*\/stock\/\?code=([0-9]{4}|[0-9]{3}[A-Z])[^"]*"[^>]*>([\s\S]*?)<\/a>/gi)) {
    const ticker = match[1].toUpperCase()
    const name = stripTags(match[2])
    if (seen.has(ticker) || !name) continue
    seen.add(ticker)
    stocks.push({
      ticker,
      name,
      marketText: null,
      priceText: null,
      changeText: null,
      changePercentText: null,
      perText: null,
      pbrText: null,
      yieldText: null,
    })
  }
  return stocks
}

function parseRankingAsOf(html: string): string | null {
  const headerMatch = html.match(/<div[^>]*class="[^"]*warning_contents_title-2[^"]*"[^>]*>([\s\S]*?)<\/div>/i)
  const header = headerMatch?.[1] ?? html
  const candidates = Array.from(header.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/gi))
    .map((match) => stripTags(match[1]))
  return candidates.find((text) => /\d{4}年\d{2}月\d{2}日\s+\d{2}時\d{2}分/u.test(text)) ?? null
}

function parseRanking(html: string): RankingTheme[] {
  const rankingAsOf = parseRankingAsOf(html)
  const tableMatch = html.match(/<div[^>]*class="[^"]*acrank[^"]*acrank_theme[^"]*"[^>]*>([\s\S]*?)<\/div>\s*<!--\/acrank-->/i)
  const tableHtml = tableMatch?.[1] ?? html
  const rows = tableHtml.match(/<tr[\s\S]*?<\/tr>/gi) ?? []
  const themes: RankingTheme[] = []
  const seen = new Set<string>()

  for (const row of rows) {
    const cells = Array.from(row.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)).map((match) => match[1])
    if (cells.length < 3) continue
    const themeLink = cells[1].match(/<a\s+href="([^"]*\/themes\/\?theme=[^"]*)"[^>]*>([\s\S]*?)<\/a>/i)
    if (!themeLink) continue
    const name = stripTags(themeLink[2])
    const themeId = normalizeKabutanThemeId(name)
    if (!themeId || seen.has(themeId)) continue
    seen.add(themeId)

    const rankClass = cells[0].match(/acrank_num(\d+)/i)
    const rankText = stripTags(cells[0]).match(/\d+/)?.[0]
    const rank = Number(rankClass?.[1] ?? rankText)

    themes.push({
      themeId,
      name,
      rank: Number.isFinite(rank) ? rank : null,
      rankingAsOf,
      url: absoluteUrl(themeLink[1]),
      representativeStocks: parseStockLinks(cells[2]),
    })
  }

  return themes
}

function parseRelatedStockTable(html: string): KabutanThemeStock[] {
  const tableMatch = html.match(/<table[^>]*class="[^"]*stock_table[^"]*st_market[^"]*"[^>]*>([\s\S]*?)<\/table>/i)
  if (!tableMatch?.[1]) return []
  const rows = tableMatch[1].match(/<tr[\s\S]*?<\/tr>/gi) ?? []
  const stocks: KabutanThemeStock[] = []
  const seen = new Set<string>()

  for (const row of rows) {
    const cells = Array.from(row.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)).map((match) => match[1])
    if (cells.length < 9) continue
    const tickerMatch = cells[0].match(/\/stock\/\?code=([0-9]{4}|[0-9]{3}[A-Z])/i)
    if (!tickerMatch) continue
    const ticker = tickerMatch[1].toUpperCase()
    if (seen.has(ticker)) continue
    seen.add(ticker)

    stocks.push({
      ticker,
      name: compactCell(cells[1]) ?? '名称未取得',
      marketText: compactCell(cells[2]),
      priceText: compactCell(cells[5]),
      changeText: compactCell(cells[7]),
      changePercentText: normalizePercent(compactCell(cells[8])),
      perText: compactCell(cells[10]),
      pbrText: compactCell(cells[11]),
      yieldText: normalizePercent(compactCell(cells[12])),
    })
  }

  return stocks
}

function parseStockCount(html: string): number | null {
  const match = html.match(/<li[^>]*>\s*([0-9,]+)銘柄\s*<\/li>/u) ?? html.match(/([0-9,]+)銘柄/u)
  if (!match?.[1]) return null
  const value = Number(match[1].replace(/,/g, ''))
  return Number.isFinite(value) ? value : null
}

function parseMetaDescription(html: string): string | null {
  const match = html.match(/<meta\s+name="description"\s+content="([^"]*)"/i)
  return match?.[1] ? truncateText(decodeHtml(match[1]), 240) : null
}

function parseDetail(html: string): ThemeDetail {
  const descriptionMatch = html.match(/<div[^>]*class="[^"]*theme_text[^"]*"[^>]*>([\s\S]*?)<\/div>/i)
  const description = descriptionMatch?.[1]
    ? truncateText(stripTags(descriptionMatch[1]), 520)
    : parseMetaDescription(html)
  const relatedStocks = parseRelatedStockTable(html)

  return {
    description,
    relatedStocks,
    stockCount: parseStockCount(html),
    parseStatus: relatedStocks.length > 0 || description ? 'ok' : 'list_only',
    errorSummary: relatedStocks.length > 0 || description ? null : 'theme detail parser found no description or stock table',
  }
}

function themePageUrlsFromDetail(html: string, maxPages: number): string[] {
  if (maxPages <= 1) return []
  const byPage = new Map<number, string>()
  for (const match of html.matchAll(/<a\s+href="([^"]*page=(\d+)[^"]*)"[^>]*>/gi)) {
    const page = Number(match[2])
    if (!Number.isFinite(page) || page <= 1) continue
    byPage.set(page, absoluteUrl(decodeHtml(match[1])))
  }
  return Array.from(byPage.entries())
    .sort(([a], [b]) => a - b)
    .slice(0, maxPages - 1)
    .map(([, url]) => url)
}

function mergeStocks(...groups: KabutanThemeStock[][]): KabutanThemeStock[] {
  const rows: KabutanThemeStock[] = []
  const seen = new Set<string>()
  for (const group of groups) {
    for (const stock of group) {
      if (seen.has(stock.ticker)) continue
      seen.add(stock.ticker)
      rows.push(stock)
    }
  }
  return rows
}

async function insertRun(): Promise<number> {
  await client.execute({
    sql: `INSERT INTO kabutan_theme_runs (status, started_at) VALUES ('running', ?)`,
    args: [nowSec()],
  })
  const result = await client.execute(`SELECT last_insert_rowid() AS id`)
  return Number(result.rows[0]?.id ?? 0)
}

async function finishRun(id: number, status: string, fetchedCount: number, savedCount: number, errorSummary: string | null): Promise<void> {
  await client.execute({
    sql: `
      UPDATE kabutan_theme_runs
      SET status = ?, finished_at = ?, fetched_count = ?, saved_count = ?, error_summary = ?
      WHERE id = ?
    `,
    args: [status, nowSec(), fetchedCount, savedCount, errorSummary, id],
  })
}

async function saveTheme(item: RankingTheme, detail: ThemeDetail): Promise<void> {
  await client.execute({
    sql: `
      INSERT INTO kabutan_themes (
        theme_id,
        name,
        rank,
        ranking_period,
        ranking_as_of,
        url,
        description,
        representative_stocks_json,
        related_stocks_json,
        stock_count,
        source,
        fetched_at,
        parse_status,
        error_summary
      )
      VALUES (?, ?, ?, '3days_access', ?, ?, ?, ?, ?, ?, 'kabutan', ?, ?, ?)
      ON CONFLICT(theme_id) DO UPDATE SET
        name = excluded.name,
        rank = excluded.rank,
        ranking_period = excluded.ranking_period,
        ranking_as_of = excluded.ranking_as_of,
        url = excluded.url,
        description = excluded.description,
        representative_stocks_json = excluded.representative_stocks_json,
        related_stocks_json = excluded.related_stocks_json,
        stock_count = excluded.stock_count,
        fetched_at = excluded.fetched_at,
        parse_status = excluded.parse_status,
        error_summary = excluded.error_summary
    `,
    args: [
      item.themeId,
      item.name,
      item.rank,
      item.rankingAsOf,
      item.url,
      detail.description,
      JSON.stringify(item.representativeStocks),
      JSON.stringify(detail.relatedStocks.length > 0 ? detail.relatedStocks : item.representativeStocks),
      detail.stockCount,
      nowSec(),
      detail.parseStatus,
      detail.errorSummary,
    ],
  })
}

async function main() {
  await ensureReady()
  await ensureKabutanThemeTables()
  const runId = await insertRun()
  const limit = envInt('KABUTAN_THEME_LIMIT', 30, 1, 30)
  const detailLimit = envInt('KABUTAN_THEME_DETAIL_LIMIT', limit, 1, 30)
  const stockPageLimit = envInt('KABUTAN_THEME_STOCK_PAGES', 8, 1, 8)
  const delayMs = envInt('KABUTAN_REQUEST_DELAY_MS', 900, 300, 5000)
  const errors: string[] = []
  let saved = 0
  let themes: RankingTheme[] = []

  try {
    const rankingHtml = await fetchHtml(RANKING_URL)
    themes = parseRanking(rankingHtml).slice(0, limit)
    if (themes.length === 0) errors.push('ranking parser found no theme rows')

    for (const [index, item] of themes.entries()) {
      let detail: ThemeDetail = {
        description: null,
        relatedStocks: item.representativeStocks,
        stockCount: item.representativeStocks.length || null,
        parseStatus: 'list_only',
        errorSummary: null,
      }
      if (index < detailLimit) {
        try {
          await sleep(delayMs)
          const html = await fetchHtml(kabutanThemeUrl(item.name))
          detail = parseDetail(html)
          const pageUrls = themePageUrlsFromDetail(html, stockPageLimit)
          for (const pageUrl of pageUrls) {
            try {
              await sleep(delayMs)
              const pageHtml = await fetchHtml(pageUrl)
              const pageDetail = parseDetail(pageHtml)
              detail = {
                description: detail.description ?? pageDetail.description,
                relatedStocks: mergeStocks(detail.relatedStocks, pageDetail.relatedStocks),
                stockCount: detail.stockCount ?? pageDetail.stockCount,
                parseStatus: detail.parseStatus === 'ok' || pageDetail.parseStatus === 'ok' ? 'ok' : 'list_only',
                errorSummary: detail.errorSummary ?? pageDetail.errorSummary,
              }
            } catch (error) {
              const pageError = `detail page failed: ${(error as Error).message}`
              detail.errorSummary = detail.errorSummary ? `${detail.errorSummary} / ${pageError}` : pageError
              errors.push(`${item.name}: ${pageError}`)
            }
          }
        } catch (error) {
          detail.errorSummary = `detail fetch failed: ${(error as Error).message}`
          errors.push(`${item.name}: ${(error as Error).message}`)
        }
      }
      await saveTheme(item, detail)
      saved += 1
    }

    const status = errors.length > 0 ? 'partial' : 'success'
    await finishRun(runId, status, themes.length, saved, errors.length > 0 ? errors.slice(0, 6).join(' / ') : null)
    console.log(JSON.stringify({ status, fetched: themes.length, saved, errors, rankingUrl: RANKING_URL }, null, 2))
  } catch (error) {
    const message = (error as Error).message
    await finishRun(runId, 'failed', themes.length, saved, message)
    console.error(JSON.stringify({ status: 'failed', fetched: themes.length, saved, error: message }, null, 2))
    process.exitCode = 1
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
