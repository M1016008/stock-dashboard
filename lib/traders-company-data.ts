import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { createClient, type Client, type InValue } from '@libsql/client'

export const TRADERS_COMPANY_SOURCE_NAME = 'トレーダーズ・ウェブ'
export const TRADERS_COMPANY_SOURCE_BASE_URL = 'https://www.traders.co.jp'

export type ParsedTradersCompanyData = {
  pageName: string | null
  featureSummary: string | null
  companyUrl: string | null
  listingDate: string | null
  fields: Record<string, string>
  contentHash: string
}

export type TradersCompanyDataRecord = {
  ticker: string
  name: string | null
  featureSummary: string | null
  companyUrl: string | null
  listingDate: string | null
  fields: Record<string, string>
  sourceUrl: string
  fetchedAt: number
  lastChangedAt: number
  sourceStatus: 'ok' | 'error' | null
  lastAttemptAt: number | null
  stale: boolean
}

type CompanyDataDbRow = {
  ticker: string
  name: string | null
  feature_summary: string | null
  company_url: string | null
  listing_date: string | null
  fields_json: string
  source_url: string
  fetched_at: number
  last_changed_at: number
  source_status: string | null
  last_attempt_at: number | null
}

const globalForCompanyData = globalThis as unknown as {
  tradersCompanyClients?: Map<string, Client>
  tradersCompanySchemas?: Map<string, Promise<void>>
}

export function normalizeJpTicker(value: string): string | null {
  const ticker = value.trim().replace(/\.T$/i, '').toUpperCase()
  return /^(?:\d{4}|\d{3}[A-Z])$/.test(ticker) ? ticker : null
}

export function tradersCompanyDataDbPath(): string {
  const configured = process.env.TRADERS_COMPANY_DB_PATH?.trim()
  if (configured) return path.resolve(configured)

  const stockboardDb = process.env.STOCKBOARD_DB_PATH?.trim() || process.env.LOCAL_DB_PATH?.trim()
  if (stockboardDb) {
    return path.join(path.dirname(path.resolve(stockboardDb)), 'supplemental', 'traders-company.db')
  }

  return path.join(process.cwd(), 'data', 'supplemental', 'traders-company.db')
}

export function tradersCompanyDataClient(): Client {
  const dbPath = tradersCompanyDataDbPath()
  fs.mkdirSync(path.dirname(dbPath), { recursive: true })
  globalForCompanyData.tradersCompanyClients ??= new Map()
  const existing = globalForCompanyData.tradersCompanyClients.get(dbPath)
  if (existing) return existing
  const client = createClient({ url: `file:${dbPath}` })
  globalForCompanyData.tradersCompanyClients.set(dbPath, client)
  return client
}

export async function ensureTradersCompanyDataSchema(client = tradersCompanyDataClient()): Promise<void> {
  const dbPath = tradersCompanyDataDbPath()
  globalForCompanyData.tradersCompanySchemas ??= new Map()
  const existing = globalForCompanyData.tradersCompanySchemas.get(dbPath)
  if (existing) return existing

  const ready = (async () => {
    await client.execute('PRAGMA synchronous=NORMAL')
    await client.execute('PRAGMA busy_timeout=15000')
    await client.execute('PRAGMA journal_mode=WAL')
    await client.batch([
      {
        sql: `CREATE TABLE IF NOT EXISTS traders_company_data (
          ticker TEXT PRIMARY KEY,
          name TEXT,
          feature_summary TEXT,
          company_url TEXT,
          listing_date TEXT,
          fields_json TEXT NOT NULL DEFAULT '{}',
          source_url TEXT NOT NULL,
          content_hash TEXT NOT NULL,
          fetched_at INTEGER NOT NULL,
          first_seen_at INTEGER NOT NULL,
          last_changed_at INTEGER NOT NULL
        )`,
      },
      {
        sql: `CREATE TABLE IF NOT EXISTS traders_company_data_status (
          ticker TEXT PRIMARY KEY,
          status TEXT NOT NULL,
          last_http_status INTEGER,
          last_attempt_at INTEGER NOT NULL,
          last_success_at INTEGER,
          error_summary TEXT
        )`,
      },
      {
        sql: `CREATE INDEX IF NOT EXISTS traders_company_data_status_idx
          ON traders_company_data_status(status, last_attempt_at)`,
      },
      {
        sql: `CREATE TABLE IF NOT EXISTS traders_company_data_runs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          started_at INTEGER NOT NULL,
          finished_at INTEGER,
          status TEXT NOT NULL,
          total_count INTEGER NOT NULL DEFAULT 0,
          processed_count INTEGER NOT NULL DEFAULT 0,
          success_count INTEGER NOT NULL DEFAULT 0,
          skipped_count INTEGER NOT NULL DEFAULT 0,
          failed_count INTEGER NOT NULL DEFAULT 0,
          error_summary_json TEXT NOT NULL DEFAULT '[]'
        )`,
      },
    ], 'write')
  })().catch((error) => {
    globalForCompanyData.tradersCompanySchemas?.delete(dbPath)
    throw error
  })

  globalForCompanyData.tradersCompanySchemas.set(dbPath, ready)
  return ready
}

export async function getTradersCompanyData(tickerInput: string): Promise<TradersCompanyDataRecord | null> {
  const ticker = normalizeJpTicker(tickerInput)
  if (!ticker) return null
  const client = tradersCompanyDataClient()
  await ensureTradersCompanyDataSchema(client)
  const result = await client.execute({
    sql: `SELECT
      d.ticker,
      d.name,
      d.feature_summary,
      d.company_url,
      d.listing_date,
      d.fields_json,
      d.source_url,
      d.fetched_at,
      d.last_changed_at,
      s.status AS source_status,
      s.last_attempt_at
    FROM traders_company_data d
    LEFT JOIN traders_company_data_status s ON s.ticker = d.ticker
    WHERE d.ticker = ?
      AND COALESCE(s.status, 'ok') <> 'unavailable'
    LIMIT 1`,
    args: [ticker],
  })
  const row = result.rows[0] as unknown as CompanyDataDbRow | undefined
  if (!row) return null

  return {
    ticker: row.ticker,
    name: row.name,
    featureSummary: row.feature_summary,
    companyUrl: safeHttpUrl(row.company_url),
    listingDate: row.listing_date,
    fields: parseFieldsJson(row.fields_json),
    sourceUrl: safeHttpUrl(row.source_url) ?? `${TRADERS_COMPANY_SOURCE_BASE_URL}/stocks/${ticker}/`,
    fetchedAt: Number(row.fetched_at),
    lastChangedAt: Number(row.last_changed_at),
    sourceStatus: row.source_status === 'error' ? 'error' : row.source_status === 'ok' ? 'ok' : null,
    lastAttemptAt: row.last_attempt_at == null ? null : Number(row.last_attempt_at),
    stale: row.source_status === 'error',
  }
}

export function parseTradersCompanyDataHtml(html: string): ParsedTradersCompanyData | null {
  const marker = html.search(
    /<div\b[^>]*class=(?:"[^"]*\bregion_title\b[^"]*"|'[^']*\bregion_title\b[^']*')[^>]*>\s*企業データ\s*<\/div>/i,
  )
  if (marker < 0) return null

  const section = html.slice(marker, marker + 20_000)
  const tableMatch = section.match(
    /<table\b[^>]*class=(?:"[^"]*\bdata_table\b[^"]*"|'[^']*\bdata_table\b[^']*')[^>]*>([\s\S]*?)<\/table>/i,
  )
  if (!tableMatch?.[1]) return null

  const fields: Record<string, string> = {}
  for (const row of tableMatch[1].matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const labelMatch = row[1].match(/<th\b[^>]*>([\s\S]*?)<\/th>/i)
    const valueMatch = row[1].match(/<td\b[^>]*>([\s\S]*?)<\/td>/i)
    const label = labelMatch?.[1] ? cleanText(labelMatch[1]) : null
    if (!label || !valueMatch?.[1]) continue

    let value = cleanText(valueMatch[1])
    if (label === 'URL') {
      const href = extractHref(valueMatch[1])
      value = safeHttpUrl(href) ?? safeHttpUrl(value) ?? null
    } else if (label === '上場日') {
      value = value?.match(/\d{4}\/\d{2}\/\d{2}/)?.[0] ?? value
    }
    if (!value) continue
    fields[label] = value
  }

  if (Object.keys(fields).length === 0) return null
  const pageNameMatch = html.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i)
  const pageName = pageNameMatch?.[1] ? cleanText(pageNameMatch[1]) : null
  const featureSummary = fields['特色'] ?? null
  const companyUrl = safeHttpUrl(fields['URL'] ?? null)
  const listingDate = fields['上場日']?.match(/\d{4}\/\d{2}\/\d{2}/)?.[0] ?? null
  const canonicalFields = Object.fromEntries(
    Object.entries(fields).sort(([a], [b]) => a.localeCompare(b, 'ja')),
  )
  const contentHash = createHash('sha256')
    .update(JSON.stringify(canonicalFields))
    .digest('hex')

  return {
    pageName,
    featureSummary,
    companyUrl,
    listingDate,
    fields: canonicalFields,
    contentHash,
  }
}

function parseFieldsJson(value: string): Record<string, string> {
  try {
    const parsed = JSON.parse(value) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    return Object.fromEntries(
      Object.entries(parsed)
        .filter((entry): entry is [string, string] => typeof entry[1] === 'string')
        .map(([key, item]) => [key, item.trim()])
        .filter(([, item]) => item.length > 0),
    )
  } catch {
    return {}
  }
}

function decodeHtml(value: string): string {
  const named: Record<string, string> = {
    amp: '&',
    apos: "'",
    gt: '>',
    lt: '<',
    nbsp: ' ',
    quot: '"',
  }
  return value
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&([a-z]+);/gi, (entity, name) => named[String(name).toLowerCase()] ?? entity)
}

function cleanText(value: string): string | null {
  const text = decodeHtml(
    value
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<(?:br|\/p|\/div|\/span|\/li)\b[^>]*>/gi, ' ')
      .replace(/<[^>]+>/g, ' '),
  )
    .replace(/\s+/g, ' ')
    .trim()
  return !text || /^[-－–—]+$/u.test(text) ? null : text
}

function extractHref(value: string): string | null {
  const match = value.match(/<a\b[^>]*href=(?:"([^"]*)"|'([^']*)')[^>]*>/i)
  return match?.[1] ?? match?.[2] ?? null
}

function safeHttpUrl(value: string | null | undefined): string | null {
  if (!value) return null
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : null
  } catch {
    return null
  }
}

export function asDbArgs(values: Array<string | number | null>): InValue[] {
  return values as InValue[]
}
