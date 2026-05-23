// lib/jpx-earnings.ts
//
// JPX公式「決算発表予定日」ページのExcel一覧を取得する。
// J-Quants /equities/earnings-calendar は翌営業日分のみのため、
// 月次予定はJPX公式Excelを補完ソースとして扱う。

import * as XLSX from 'xlsx'

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

function parseAnnouncementDate(value: unknown, asOf: AsOfDate): string | null {
  const text = cleanCell(value)
  const match = text.match(/(\d{1,2})[\/月](\d{1,2})/)
  if (!match) return null
  const month = Number(match[1])
  const day = Number(match[2])
  if (!month || !day) return null

  let year = asOf.year
  if (asOf.month >= 10 && month <= 3) year += 1
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

async function fetchText(url: string): Promise<string> {
  const res = await fetch(url, {
    headers: {
      'user-agent': 'StockBoard/1.0 (+https://www.jpx.co.jp/)',
    },
  })
  if (!res.ok) {
    throw new Error(`JPX決算予定ページ取得失敗: ${res.status}`)
  }
  return await res.text()
}

async function fetchBuffer(url: string): Promise<Buffer> {
  const res = await fetch(url, {
    headers: {
      'user-agent': 'StockBoard/1.0 (+https://www.jpx.co.jp/)',
    },
  })
  if (!res.ok) {
    throw new Error(`JPX決算予定Excel取得失敗: ${res.status} ${url}`)
  }
  return Buffer.from(await res.arrayBuffer())
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

function parseWorkbookRows(buffer: Buffer, source: WorkbookLink): JpxEarningsCalendarRow[] {
  const wb = XLSX.read(buffer, { type: 'buffer', cellDates: false })
  const sheetName = wb.SheetNames[0]
  if (!sheetName) return []
  const sheet = wb.Sheets[sheetName]
  const rows = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, defval: null, raw: false })
  const asOf = parseAsOf(rows)
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
    for (const row of parseWorkbookRows(buffer, link)) {
      byKey.set(`${row.ticker}\t${row.announceDate}`, row)
    }
  }

  return [...byKey.values()].sort((a, b) =>
    a.announceDate.localeCompare(b.announceDate) || a.ticker.localeCompare(b.ticker),
  )
}
