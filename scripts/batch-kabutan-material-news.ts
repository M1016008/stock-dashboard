// Kabutan 市場ニュース「材料」を低頻度で取得し、ダッシュボード表示用に保存する。
// 本文全文は保存せず、短い抜粋・タイトル・日時・関連銘柄コード・原文URLだけを保存する。

import { client, ensureReady } from '@/lib/db/client'
import {
  type KabutanMaterialNewsStock,
  ensureKabutanMaterialNewsTables,
  isKabutanDashboardTargetTitle,
  pruneKabutanMaterialNewsToPreviousDayMovers,
} from '@/lib/queries/kabutan-material-news'

const BASE_URL = 'https://kabutan.jp'
const CATEGORY_URLS = [
  `${BASE_URL}/news/marketnews/?category=2`,
  `${BASE_URL}/news/marketnews/?category=1`,
] as const
const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 StockBoardKabutanBot/1.0'

type ListItem = {
  articleId: string
  title: string
  publishedAt: string
  url: string
  category: string
}

type DetailResult = {
  title: string
  publishedAt: string
  snippet: string | null
  relatedTickers: string[]
  relatedStocks: KabutanMaterialNewsStock[]
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

function truncateText(value: string, max = 220): string {
  const clean = value.replace(/\s+/g, ' ').trim()
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean
}

function uniqueStockTickersFromHtml(html: string): string[] {
  const linked = Array.from(html.matchAll(/\/stock\/\?code=([0-9]{4}|[0-9]{3}[A-Z])(?![0-9A-Z])/gi))
    .map((match) => match[1].toUpperCase())
  const text = stripTags(html)
  const inline = Array.from(text.matchAll(/[<＜]\s*([0-9]{4}|[0-9]{3}[A-Z])\s*[>＞]/gi))
    .map((match) => match[1].toUpperCase())
  return Array.from(new Set([...linked, ...inline]))
}

function extractArticleBodyHtml(articleHtml: string): string {
  const monoMatch = articleHtml.match(/<div[^>]*class="[^"]*mono[^"]*"[^>]*>([\s\S]*?)<\/div>\s*<!--\/\.mono-->/i)
  if (monoMatch?.[1]) return monoMatch[1]
  return articleHtml
    .replace(/<h1[^>]*>[\s\S]*?<\/h1>/i, ' ')
    .replace(/<time[^>]*>[\s\S]*?<\/time>/i, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
}

function splitArticleBodyLines(bodyHtml: string): string[] {
  return bodyHtml
    .replace(/<\/?(?:div|p|li)[^>]*>/gi, '<br />')
    .split(/<br\s*\/?>/i)
    .map((line) => stripTags(line))
    .map((line) => line.replace(/＜/g, '<').replace(/＞/g, '>').replace(/\s+/g, ' ').trim())
}

function parseRelatedStocksFromBodyHtml(bodyHtml: string): KabutanMaterialNewsStock[] {
  const stockLinePattern = /^■?\s*(.+?)<\s*([0-9]{4}|[0-9]{3}[A-Z])\s*>\s*(?:\[([^\]]+)\])?\s*([0-9,.]+(?:\.\d+)?)?\s*([+-][0-9,.]+(?:\.\d+)?)?/i
  const skipPattern = /^(銘柄名|《|提供：|「株探」|日足|週足|月足)/u
  const rows: KabutanMaterialNewsStock[] = []
  let currentTone: 'good' | 'bad' | 'neutral' | null = null
  let current: (KabutanMaterialNewsStock & { notes: string[] }) | null = null

  const pushCurrent = () => {
    if (!current) return
    rows.push({
      ticker: current.ticker,
      name: current.name,
      closeText: current.closeText,
      changeText: current.changeText,
      comment: truncateText(current.notes.join(' '), 120) || null,
      materialTone: current.materialTone ?? currentTone,
      marketText: current.marketText ?? null,
    })
    current = null
  }

  for (const line of splitArticleBodyLines(bodyHtml)) {
    if (!line) {
      pushCurrent()
      continue
    }
    if (/【好材料】/u.test(line)) {
      pushCurrent()
      currentTone = 'good'
      continue
    }
    if (/【悪材料】/u.test(line)) {
      pushCurrent()
      currentTone = 'bad'
      continue
    }
    if (skipPattern.test(line)) continue
    const match = line.match(stockLinePattern)
    if (match) {
      pushCurrent()
      const next: KabutanMaterialNewsStock & { notes: string[] } = {
        ticker: match[2].toUpperCase(),
        name: match[1].replace(/^■\s*/, '').trim(),
        closeText: match[4] ?? null,
        changeText: match[5] ?? null,
        comment: null,
        materialTone: currentTone,
        marketText: match[3] ?? null,
        notes: [],
      }
      const tail = line.slice(match[0].length).trim()
      if (tail) next.notes.push(tail)
      current = next
      continue
    }
    if (current) current.notes.push(line)
  }
  pushCurrent()

  const seen = new Set<string>()
  return rows.filter((row) => {
    if (seen.has(row.ticker)) return false
    seen.add(row.ticker)
    return true
  })
}

function articleIdFromHref(href: string): string | null {
  const match = href.match(/[?&]b=(n\d{12})/)
  return match?.[1] ?? null
}

function absoluteUrl(href: string): string {
  if (/^https?:\/\//.test(href)) return href
  return `${BASE_URL}${href.startsWith('/') ? href : `/${href}`}`.replace('?&', '?')
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

function parseListItems(html: string): ListItem[] {
  const items: ListItem[] = []
  const seen = new Set<string>()
  const pushItem = (item: ListItem) => {
    if (seen.has(item.articleId)) return
    seen.add(item.articleId)
    items.push(item)
  }
  const tableMatches = html.match(/<table[^>]*class="[^"]*s_news_list[^"]*"[^>]*>[\s\S]*?<\/table>/gi) ?? []
  for (const table of tableMatches) {
    const rowMatches = table.match(/<tr[\s\S]*?<\/tr>/gi) ?? []
    for (const row of rowMatches) {
      const timeMatch = row.match(/<time[^>]*datetime="([^"]+)"[^>]*>/i)
      const categoryMatch = row.match(/<div[^>]*class="[^"]*newslist_ctg[^"]*"[^>]*>([\s\S]*?)<\/div>/i)
      const linkMatch = row.match(/<a\s+href="([^"]*marketnews\/\?[^"]*b=n\d{12}[^"]*)"[^>]*>([\s\S]*?)<\/a>/i)
      if (!timeMatch || !categoryMatch || !linkMatch) continue
      const category = stripTags(categoryMatch[1])
      const title = stripTags(linkMatch[2])
      if (!isKabutanDashboardTargetTitle(title)) continue
      const articleId = articleIdFromHref(linkMatch[1])
      if (!articleId) continue
      pushItem({
        articleId,
        title,
        publishedAt: timeMatch[1],
        url: absoluteUrl(`/news/marketnews/?b=${articleId}`),
        category,
      })
    }
  }
  const linkMatches = html.matchAll(/<a\s+href="([^"]*marketnews\/\?[^"]*b=n\d{12}[^"]*)"[^>]*>([\s\S]*?)<\/a>/gi)
  for (const linkMatch of linkMatches) {
    const title = stripTags(linkMatch[2])
    if (!isKabutanDashboardTargetTitle(title)) continue
    const articleId = articleIdFromHref(linkMatch[1])
    if (!articleId) continue
    pushItem({
      articleId,
      title,
      publishedAt: new Date().toISOString(),
      url: absoluteUrl(`/news/marketnews/?b=${articleId}`),
      category: isKabutanDashboardTargetTitle(title) && /明日の好悪材料/u.test(title) ? '注目' : '材料',
    })
  }
  return items
}

function parseDetail(html: string, fallback: ListItem): DetailResult {
  const articleMatch = html.match(/<article[\s\S]*?<\/article>/i)
  const article = articleMatch?.[0] ?? html
  const dateMatch = article.match(/<time[^>]*class="[^"]*s_news_date[^"]*"[^>]*datetime="([^"]+)"/i)
  const h1Match = article.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)
  const bodyHtml = extractArticleBodyHtml(article)
  const bodyText = stripTags(bodyHtml)
    .replace(/株探ニュース\s*$/u, '')
    .trim()
  const relatedTickers = uniqueStockTickersFromHtml(bodyHtml)

  if (!h1Match && !bodyText) {
    return {
      title: fallback.title,
      publishedAt: fallback.publishedAt,
      snippet: null,
      relatedTickers: [],
      relatedStocks: [],
      parseStatus: 'list_only',
      errorSummary: 'detail parser could not find article body',
    }
  }

  return {
    title: h1Match ? stripTags(h1Match[1]).replace(/^【材料】\s*/, '') : fallback.title,
    publishedAt: dateMatch?.[1] ?? fallback.publishedAt,
    snippet: bodyText ? truncateText(bodyText) : null,
    relatedTickers,
    relatedStocks: parseRelatedStocksFromBodyHtml(bodyHtml),
    parseStatus: 'ok',
    errorSummary: null,
  }
}

async function insertRun(): Promise<number> {
  await client.execute({
    sql: `INSERT INTO kabutan_material_news_runs (status, started_at) VALUES ('running', ?)`,
    args: [nowSec()],
  })
  const result = await client.execute(`SELECT last_insert_rowid() AS id`)
  return Number(result.rows[0]?.id ?? 0)
}

async function finishRun(id: number, status: string, fetchedCount: number, savedCount: number, errorSummary: string | null): Promise<void> {
  await client.execute({
    sql: `
      UPDATE kabutan_material_news_runs
      SET status = ?, finished_at = ?, fetched_count = ?, saved_count = ?, error_summary = ?
      WHERE id = ?
    `,
    args: [status, nowSec(), fetchedCount, savedCount, errorSummary, id],
  })
}

async function saveArticle(item: ListItem, detail: DetailResult): Promise<void> {
  await client.execute({
    sql: `
      INSERT INTO kabutan_material_news (
        article_id,
        title,
        published_at,
        url,
        category,
        snippet,
        related_tickers_json,
        related_stocks_json,
        source,
        fetched_at,
        parse_status,
        error_summary
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'kabutan', ?, ?, ?)
      ON CONFLICT(article_id) DO UPDATE SET
        title = excluded.title,
        published_at = excluded.published_at,
        url = excluded.url,
        category = excluded.category,
        snippet = excluded.snippet,
        related_tickers_json = excluded.related_tickers_json,
        related_stocks_json = excluded.related_stocks_json,
        fetched_at = excluded.fetched_at,
        parse_status = excluded.parse_status,
        error_summary = excluded.error_summary
    `,
    args: [
      item.articleId,
      detail.title,
      detail.publishedAt,
      item.url,
      item.category,
      detail.snippet,
      JSON.stringify(detail.relatedTickers),
      JSON.stringify(detail.relatedStocks),
      nowSec(),
      detail.parseStatus,
      detail.errorSummary,
    ],
  })
}

async function main() {
  await ensureReady()
  await ensureKabutanMaterialNewsTables()
  const pruned = await pruneKabutanMaterialNewsToPreviousDayMovers()
  const runId = await insertRun()
  const pages = envInt('KABUTAN_MATERIAL_NEWS_PAGES', 3, 1, 3)
  const limit = envInt('KABUTAN_MATERIAL_NEWS_LIMIT', 60, 1, 60)
  const delayMs = envInt('KABUTAN_REQUEST_DELAY_MS', 900, 300, 5000)
  const errors: string[] = []
  let saved = 0

  try {
    const byId = new Map<string, ListItem>()
    for (const categoryUrl of CATEGORY_URLS) {
      for (let page = 1; page <= pages && byId.size < limit; page += 1) {
        const url = page === 1 ? categoryUrl : `${categoryUrl}&page=${page}`
        try {
          const html = await fetchHtml(url)
          for (const item of parseListItems(html)) {
            if (byId.size >= limit) break
            byId.set(item.articleId, item)
          }
        } catch (error) {
          errors.push(`list page ${page}: ${(error as Error).message}`)
        }
        await sleep(delayMs)
      }
    }

    const items = Array.from(byId.values())
    for (const item of items) {
      let detail: DetailResult
      try {
        const html = await fetchHtml(item.url)
        detail = parseDetail(html, item)
      } catch (error) {
        detail = {
          title: item.title,
          publishedAt: item.publishedAt,
          snippet: null,
          relatedTickers: [],
          relatedStocks: [],
          parseStatus: 'list_only',
          errorSummary: `detail fetch failed: ${(error as Error).message}`,
        }
        errors.push(`${item.articleId}: ${detail.errorSummary}`)
      }
      await saveArticle(item, detail)
      saved += 1
      await sleep(delayMs)
    }

    const status = items.length === 0 ? 'failed' : errors.length > 0 ? 'partial' : 'success'
    await finishRun(runId, status, items.length, saved, errors.slice(0, 8).join(' / ') || null)
    console.log(`Kabutan material news ${status}: fetched=${items.length} saved=${saved} pruned=${pruned}`)
    if (errors.length > 0) console.log(`Warnings: ${errors.slice(0, 8).join(' / ')}`)
  } catch (error) {
    const message = (error as Error).message
    await finishRun(runId, 'failed', 0, saved, message)
    console.error(`Kabutan material news failed: ${message}`)
  }
}

main()
