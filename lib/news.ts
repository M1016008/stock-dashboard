// lib/news.ts
// 銘柄関連ニュースの取得。複数ソースを統合する。
//   - 日本株: yahoo-finance2.search + Google News RSS (hl=ja)
//   - 米国株: Finnhub company-news + yahoo-finance2.search
// 結果は published 降順でマージし、URL で重複排除する。

import yahooFinance from 'yahoo-finance2'
import { findTicker } from '@/lib/master/tickers'

export interface NewsItem {
  title: string
  url: string
  source: string
  publishedAt: string // ISO 8601
  imageUrl?: string
  summary?: string
}

const FINNHUB_API_KEY = process.env.FINNHUB_API_KEY ?? ''

// ─────────────────────────────────────────────────────────────────
// Yahoo Finance 経由（yahoo-finance2 の search モジュール）
// ─────────────────────────────────────────────────────────────────
async function fetchYahooNews(ticker: string): Promise<NewsItem[]> {
  try {
    const res: unknown = await yahooFinance.search(ticker, {
      newsCount: 10,
      quotesCount: 0,
    })
    const news = (res as { news?: unknown[] })?.news ?? []
    const items: NewsItem[] = []
    for (const n of news) {
      const item = n as {
        title?: string
        link?: string
        publisher?: string
        providerPublishTime?: number | string | Date
        thumbnail?: { resolutions?: { url?: string }[] }
      }
      if (!item.title || !item.link) continue
      const t = item.providerPublishTime
      const date = t ? new Date(t) : new Date()
      items.push({
        title: item.title,
        url: item.link,
        source: item.publisher ?? 'Yahoo Finance',
        publishedAt: date.toISOString(),
        imageUrl: item.thumbnail?.resolutions?.[0]?.url,
      })
    }
    return items
  } catch (e) {
    console.error('fetchYahooNews error:', e)
    return []
  }
}

// ─────────────────────────────────────────────────────────────────
// Google News RSS（日本語）
// ─────────────────────────────────────────────────────────────────
async function fetchGoogleNewsJa(query: string): Promise<NewsItem[]> {
  try {
    const url = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=ja&gl=JP&ceid=JP:ja`
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 StockBoard/1.0' },
      next: { revalidate: 1800 },
    })
    if (!res.ok) return []
    const xml = await res.text()
    return parseRssItems(xml).slice(0, 10)
  } catch (e) {
    console.error('fetchGoogleNewsJa error:', e)
    return []
  }
}

/**
 * 簡易 RSS 2.0 パーサ。Google News RSS の <item> 要素のみ処理する。
 * 厳密な XML パーサではない。Google News のフォーマットに依存する。
 */
function parseRssItems(xml: string): NewsItem[] {
  const items: NewsItem[] = []
  const itemRegex = /<item>([\s\S]*?)<\/item>/g
  let match: RegExpExecArray | null
  while ((match = itemRegex.exec(xml)) !== null) {
    const block = match[1]
    const title = extractTag(block, 'title')
    const link = extractTag(block, 'link')
    const pubDate = extractTag(block, 'pubDate')
    const sourceMatch = block.match(/<source[^>]*>([\s\S]*?)<\/source>/)
    const source = sourceMatch ? cleanText(sourceMatch[1]) : 'Google News'
    if (!title || !link) continue
    const date = pubDate ? new Date(pubDate) : new Date()
    items.push({
      title: cleanText(title),
      url: cleanText(link),
      source,
      publishedAt: date.toISOString(),
    })
  }
  return items
}

function extractTag(xml: string, tag: string): string | null {
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`)
  const m = xml.match(re)
  return m ? m[1] : null
}

function cleanText(s: string): string {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/<[^>]+>/g, '')
    .trim()
}

// ─────────────────────────────────────────────────────────────────
// Finnhub company-news（米国株のみ。APIキー必須）
// ─────────────────────────────────────────────────────────────────
async function fetchFinnhubNews(ticker: string): Promise<NewsItem[]> {
  if (!FINNHUB_API_KEY) return []
  try {
    const to = new Date()
    const from = new Date()
    from.setDate(to.getDate() - 14)
    const url =
      `https://finnhub.io/api/v1/company-news` +
      `?symbol=${encodeURIComponent(ticker)}` +
      `&from=${from.toISOString().split('T')[0]}` +
      `&to=${to.toISOString().split('T')[0]}` +
      `&token=${FINNHUB_API_KEY}`
    const res = await fetch(url, { next: { revalidate: 1800 } })
    if (!res.ok) return []
    const data = (await res.json()) as Array<{
      headline?: string
      url?: string
      source?: string
      datetime?: number
      image?: string
      summary?: string
    }>
    return data
      .filter((d) => d.headline && d.url)
      .slice(0, 15)
      .map((d) => ({
        title: d.headline!,
        url: d.url!,
        source: d.source ?? 'Finnhub',
        publishedAt: new Date((d.datetime ?? 0) * 1000).toISOString(),
        imageUrl: d.image && d.image.length > 0 ? d.image : undefined,
        summary: d.summary,
      }))
  } catch (e) {
    console.error('fetchFinnhubNews error:', e)
    return []
  }
}

// ─────────────────────────────────────────────────────────────────
// 統合エントリポイント
// ─────────────────────────────────────────────────────────────────
export async function fetchStockNews(ticker: string): Promise<{
  items: NewsItem[]
  sources: { yahoo: number; googleNews: number; finnhub: number }
  finnhubEnabled: boolean
}> {
  const isJP = ticker.endsWith('.T')
  const master = findTicker(ticker)
  const queryName = master?.name ?? ticker

  const [yahoo, googleNews, finnhub] = await Promise.all([
    fetchYahooNews(ticker),
    isJP ? fetchGoogleNewsJa(queryName) : Promise.resolve([]),
    !isJP ? fetchFinnhubNews(ticker) : Promise.resolve([]),
  ])

  // URL で重複排除
  const seen = new Set<string>()
  const merged: NewsItem[] = []
  for (const arr of [finnhub, yahoo, googleNews]) {
    for (const item of arr) {
      if (seen.has(item.url)) continue
      seen.add(item.url)
      merged.push(item)
    }
  }
  // 日付降順
  merged.sort((a, b) => b.publishedAt.localeCompare(a.publishedAt))

  return {
    items: merged.slice(0, 20),
    sources: {
      yahoo: yahoo.length,
      googleNews: googleNews.length,
      finnhub: finnhub.length,
    },
    finnhubEnabled: !!FINNHUB_API_KEY,
  }
}
