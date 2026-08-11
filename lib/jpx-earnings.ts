// lib/jpx-earnings.ts
//
// JPX公式「決算発表予定日」ページのExcel一覧を取得する。
// J-Quants /equities/earnings-calendar は翌営業日分のみのため、
// 月次予定はJPX公式Excelを補完ソースとして扱う。

import { readSafeSpreadsheetBuffer } from '@/lib/safe-spreadsheet'
import { execFileSync } from 'node:child_process'

export const JPX_EARNINGS_PAGE =
  'https://www.jpx.co.jp/listing/event-schedules/financial-announcement/index.html'

export interface JpxEarningsCalendarRow {
  announceDate: string
  ticker: string
  companyName: string | null
  fiscalPeriod: string | null
  sectorName: string | null
  marketSegment: string | null
  sourceUrl: string
  sourceTitle: string
}

type WorkbookLink = {
  url: string
  title: string
}

type AsOfDate = {
  year: number
  month: number
  day: number
}

const USER_AGENT = 'StockBoard/1.0 (+https://www.jpx.co.jp/)'
const MAX_PAGE_BYTES = 5 * 1024 * 1024
const MAX_WORKBOOK_BYTES = 32 * 1024 * 1024

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function decodeHtml(input: string): string {
  return input
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
}

function cleanCell(value: unknown): string {
  if (value == null) return ''
  return String(value).replace(/\s+/g, ' ').trim()
}

function normalizeTicker(code: string): string | null {
  const raw = cleanCell(code).replace(/\.0$/, '')
  const match = raw.match(/[0-9A-Z]{4,5}/i)
  if (!match) return null
  const ticker = match[0].toUpperCase()
  return ticker.length === 5 && ticker.endsWith('0') ? ticker.slice(0, 4) : ticker
}

function parseAsOf(rows: unknown[][]): AsOfDate | null {
  for (const row of rows.slice(0, 8)) {
    for (const cell of row) {
      const text = cleanCell(cell)
      const jp = text.match(/(\d{4})年(\d{1,2})月(\d{1,2})日/)
      if (jp) {
        return { year: Number(jp[1]), month: Number(jp[2]), day: Number(jp[3]) }
      }
      const en = text.match(/(\d{4})\/(\d{1,2})\/(\d{1,2})/)
      if (en) {
        return { year: Number(en[1]), month: Number(en[2]), day: Number(en[3]) }
      }
    }
  }
  return null
}

function parseAnnouncementDate(value: unknown, asOf: AsOfDate | null): string | null {
  const text = cleanCell(value)
  const iso = text.match(/^(\d{4})-(\d{2})-(\d{2})(?:T|$)/)
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`
  const match = text.match(/(\d{1,2})[\/月](\d{1,2})/)
  if (!match || !asOf) return null
  const month = Number(match[1])
  const day = Number(match[2])
  if (!month || !day) return null

  let year = asOf.year
  if (asOf.month >= 10 && month <= 3) year += 1
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

async function fetchWithFallback(url: string, label: string, maxBytes: number): Promise<Buffer> {
  let lastError: unknown = null
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const res = await fetch(url, {
        headers: { 'user-agent': USER_AGENT },
        signal: AbortSignal.timeout(60_000),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const contentLength = Number(res.headers.get('content-length'))
      if (Number.isFinite(contentLength) && contentLength > maxBytes) {
        throw new Error(`response exceeds ${maxBytes} bytes`)
      }
      const buffer = Buffer.from(await res.arrayBuffer())
      if (buffer.length === 0 || buffer.length > maxBytes) {
        throw new Error(`response size is invalid: ${buffer.length}`)
      }
      return buffer
    } catch (error) {
      lastError = error
      if (attempt < 3) await sleep(attempt * 2_000)
    }
  }

  try {
    const output = execFileSync('curl', [
      '--http1.1',
      '--location',
      '--fail',
      '--silent',
      '--show-error',
      '--retry', '3',
      '--retry-delay', '2',
      '--retry-all-errors',
      '--connect-timeout', '20',
      '--max-time', '90',
      '--max-filesize', String(maxBytes),
      '--user-agent', USER_AGENT,
      url,
    ], { encoding: null, maxBuffer: maxBytes })
    if (output.length === 0 || output.length > maxBytes) {
      throw new Error(`curl response size is invalid: ${output.length}`)
    }
    return output
  } catch (curlError) {
    const nativeMessage = lastError instanceof Error ? lastError.message : String(lastError)
    const curlMessage = curlError instanceof Error ? curlError.message : String(curlError)
    throw new Error(`${label}: fetch=${nativeMessage}; curl=${curlMessage}`)
  }
}

async function fetchText(url: string): Promise<string> {
  return (await fetchWithFallback(url, 'JPX決算予定ページ取得失敗', MAX_PAGE_BYTES)).toString('utf8')
}

async function fetchBuffer(url: string): Promise<Buffer> {
  return fetchWithFallback(url, `JPX決算予定Excel取得失敗: ${url}`, MAX_WORKBOOK_BYTES)
}

export function extractJpxEarningsWorkbookLinks(html: string): WorkbookLink[] {
  const links: WorkbookLink[] = []
  const seen = new Set<string>()
  const rowPattern = /<tr\b[\s\S]*?<\/tr>/gi
  for (const rowMatch of html.matchAll(rowPattern)) {
    const rowHtml = rowMatch[0]
    const href = rowHtml.match(/href="([^"]+\.xlsx)"/i)?.[1]
    if (!href) continue
    const title = decodeHtml(rowHtml.match(/<th[^>]*>([\s\S]*?)<\/th>/i)?.[1] ?? '')
    const url = new URL(href, JPX_EARNINGS_PAGE).toString()
    if (seen.has(url)) continue
    seen.add(url)
    links.push({ url, title })
  }
  return links
}

export async function parseJpxEarningsWorkbook(
  buffer: Buffer,
  source: { url: string; title: string },
): Promise<JpxEarningsCalendarRow[]> {
  const { rows } = await readSafeSpreadsheetBuffer(buffer, {
    maxRows: 10_000,
    maxColumns: 32,
  })
  const asOf = parseAsOf(rows) ?? parseAsOf([[source.title]])
  if (!asOf) return []

  const headerIndex = rows.findIndex(row =>
    row.some(cell => cleanCell(cell).includes('決算発表予定日') || cleanCell(cell).includes('Scheduled Dates')),
  )
  if (headerIndex < 0) return []

  const out: JpxEarningsCalendarRow[] = []
  for (const row of rows.slice(headerIndex + 1)) {
    const announceDate = parseAnnouncementDate(row[0], asOf)
    const ticker = normalizeTicker(cleanCell(row[1]))
    if (!announceDate || !ticker) continue

    const fiscalEnd = cleanCell(row[4])
    const fiscalQuarter = cleanCell(row[7])
    out.push({
      announceDate,
      ticker,
      companyName: cleanCell(row[2]) || null,
      fiscalPeriod: [fiscalEnd, fiscalQuarter].filter(Boolean).join(' ') || null,
      sectorName: cleanCell(row[5]) || null,
      marketSegment: cleanCell(row[9]) || null,
      sourceUrl: source.url,
      sourceTitle: source.title,
    })
  }
  return out
}

export async function fetchJpxEarningsCalendar(): Promise<JpxEarningsCalendarRow[]> {
  const html = await fetchText(JPX_EARNINGS_PAGE)
  const links = extractJpxEarningsWorkbookLinks(html)
  const byKey = new Map<string, JpxEarningsCalendarRow>()

  for (const link of links) {
    const buffer = await fetchBuffer(link.url)
    for (const row of await parseJpxEarningsWorkbook(buffer, link)) {
      byKey.set(`${row.ticker}\t${row.announceDate}`, row)
    }
  }

  if (links.length > 0 && byKey.size === 0) {
    throw new Error('JPX決算予定Excelを解析できましたが、有効な予定行が0件でした。')
  }

  return [...byKey.values()].sort((a, b) =>
    a.announceDate.localeCompare(b.announceDate) || a.ticker.localeCompare(b.ticker),
  )
}
