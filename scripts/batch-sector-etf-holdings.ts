// 国内上場ETFの構成銘柄を公式/準公式データから取得し、sector_etf_holdings に保存する。
//
// 使い方:
//   npm run batch:sector-etf-holdings
//   SECTOR_ETF_TICKERS=1623,2638 npm run batch:sector-etf-holdings

import { execFileSync } from 'child_process'
import { TextDecoder } from 'util'
import * as XLSX from 'xlsx'
import { client, ensureReady } from '@/lib/db/client'
import { SECTOR_ETF_CATALOG, type SectorEtfCatalogItem } from '@/lib/sector-etfs'

type HoldingInput = {
  holdingTicker: string
  holdingName: string
  weightPct: number | null
  shares: number | null
  marketValue: number | null
  asOfDate: string | null
  raw: Record<string, unknown>
}

const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 StockBoardSectorEtfBot/1.0'

function nowSec() {
  return Math.floor(Date.now() / 1000)
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function normalizeTicker(value: unknown): string {
  const raw = String(value ?? '').trim().toUpperCase().replace(/\.T$/i, '')
  if (/^\d{5}$/.test(raw) && raw.endsWith('0')) return raw.slice(0, 4)
  return raw
}

function cleanName(value: unknown): string {
  return String(value ?? '').replace(/\s+/g, ' ').trim()
}

function parseNumber(value: unknown): number | null {
  if (value == null) return null
  const normalized = String(value)
    .replace(/[,%]/g, '')
    .replace(/−/g, '-')
    .replace(/[^\d.+-]/g, '')
  if (!normalized) return null
  const n = Number(normalized)
  return Number.isFinite(n) ? n : null
}

function formatYmd(year: number, month: number, day: number): string {
  return `${year.toString().padStart(4, '0')}-${month.toString().padStart(2, '0')}-${day.toString().padStart(2, '0')}`
}

function parseJapaneseDate(value: unknown): string | null {
  const text = String(value ?? '')
  const m = text.match(/(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日/)
  if (!m) return null
  return formatYmd(Number(m[1]), Number(m[2]), Number(m[3]))
}

function parseCompactDate(value: unknown): string | null {
  const text = String(value ?? '').trim()
  const compact = text.match(/^(\d{4})(\d{2})(\d{2})$/)
  if (compact) return `${compact[1]}-${compact[2]}-${compact[3]}`
  const slash = text.match(/^(\d{4})[/-](\d{1,2})[/-](\d{1,2})$/)
  if (slash) return formatYmd(Number(slash[1]), Number(slash[2]), Number(slash[3]))
  return null
}

function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let cell = ''
  let inQuotes = false
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]
    const next = text[i + 1]
    if (ch === '"') {
      if (inQuotes && next === '"') {
        cell += '"'
        i += 1
      } else {
        inQuotes = !inQuotes
      }
    } else if (ch === ',' && !inQuotes) {
      row.push(cell)
      cell = ''
    } else if ((ch === '\n' || ch === '\r') && !inQuotes) {
      if (ch === '\r' && next === '\n') i += 1
      row.push(cell)
      if (row.some((v) => v.trim() !== '')) rows.push(row)
      row = []
      cell = ''
    } else {
      cell += ch
    }
  }
  row.push(cell)
  if (row.some((v) => v.trim() !== '')) rows.push(row)
  return rows
}

async function fetchBuffer(url: string): Promise<Buffer> {
  let lastMessage = ''
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetch(url, {
        cache: 'no-store',
        headers: {
          'user-agent': USER_AGENT,
          accept: '*/*',
        },
      })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      return Buffer.from(await response.arrayBuffer())
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      lastMessage = message
      try {
        return execFileSync('curl', [
          '--http1.1',
          '-L',
          '--fail',
          '--silent',
          '--show-error',
          '--retry',
          '3',
          '--retry-delay',
          '2',
          '--retry-all-errors',
          '--connect-timeout',
          '20',
          '--max-time',
          '90',
          '-A',
          USER_AGENT,
          url,
        ])
      } catch (curlError) {
        const curlMessage = curlError instanceof Error ? curlError.message : String(curlError)
        lastMessage = `fetch failed: ${message}; curl fallback failed: ${curlMessage}`
        if (attempt < 3) await sleep(1500 * attempt)
      }
    }
  }
  throw new Error(lastMessage || 'fetch failed')
}

async function fetchText(url: string): Promise<string> {
  const buffer = await fetchBuffer(url)
  const utf8 = buffer.toString('utf8')
  if (!utf8.includes('\uFFFD')) return utf8
  return new TextDecoder('shift_jis').decode(buffer)
}

function rowValue(row: unknown[], index: number): unknown {
  return index >= 0 ? row[index] : undefined
}

function findHeaderIndex(header: unknown[], patterns: RegExp[]): number {
  return header.findIndex((cell) => {
    const text = String(cell ?? '')
    return patterns.some((pattern) => pattern.test(text))
  })
}

function parseNextFundsXlsx(buffer: Buffer): HoldingInput[] {
  const workbook = XLSX.read(buffer, { type: 'buffer', cellDates: false })
  const sheet = workbook.Sheets['保有明細'] ?? workbook.Sheets[workbook.SheetNames[0]]
  if (!sheet) return []
  const rows = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, raw: false, defval: '' })
  const asOfDate = rows.map((row) => parseJapaneseDate(row.join(' '))).find(Boolean) ?? null
  const headerIndex = rows.findIndex((row) => {
    const joined = row.join(' ')
    return /銘柄コード|Code/i.test(joined) && /純資産比率|比率|Weight/i.test(joined)
  })
  if (headerIndex < 0) return []
  const header = rows[headerIndex]
  const codeIdx = findHeaderIndex(header, [/銘柄コード/i, /^Code$/i])
  const jpNameIdx = findHeaderIndex(header, [/銘柄（Name）/i, /^銘柄$/i])
  const enNameIdx = findHeaderIndex(header, [/^Name$/i])
  const sharesIdx = findHeaderIndex(header, [/株数/i, /Shares/i])
  const marketValueIdx = findHeaderIndex(header, [/評価金額/i, /Market Value/i])
  const weightIdx = findHeaderIndex(header, [/純資産比率/i, /Weight/i])
  const holdings: HoldingInput[] = []
  for (const row of rows.slice(headerIndex + 1)) {
    const holdingTicker = normalizeTicker(rowValue(row, codeIdx))
    if (!holdingTicker) continue
    const holdingName = cleanName(rowValue(row, jpNameIdx)) || cleanName(rowValue(row, enNameIdx)) || holdingTicker
    const weightPct = parseNumber(rowValue(row, weightIdx))
    holdings.push({
      holdingTicker,
      holdingName,
      weightPct,
      shares: parseNumber(rowValue(row, sharesIdx)),
      marketValue: parseNumber(rowValue(row, marketValueIdx)),
      asOfDate,
      raw: { row },
    })
  }
  return holdings
}

function parseGlobalXPcfCsv(text: string): HoldingInput[] {
  const rows = parseCsv(text)
  const fundRow = rows.find((row) => row[0]?.trim() && row[0]?.trim() !== 'ETF Code' && row.length >= 5)
  const asOfDate = parseCompactDate(fundRow?.[4])
  const headerIndex = rows.findIndex((row) => row[0]?.trim() === 'Code' && row[1]?.trim() === 'Name')
  if (headerIndex < 0) return []
  const header = rows[headerIndex]
  const codeIdx = header.indexOf('Code')
  const nameIdx = header.indexOf('Name')
  const isinIdx = header.indexOf('ISIN')
  const sharesIdx = header.indexOf('Shares Amount')
  const priceIdx = header.indexOf('Stock Price')
  const parsed = rows.slice(headerIndex + 1)
    .map((row) => {
      const holdingTicker = normalizeTicker(row[codeIdx]) || cleanName(row[isinIdx])
      const holdingName = cleanName(row[nameIdx]) || holdingTicker
      const shares = parseNumber(row[sharesIdx])
      const price = parseNumber(row[priceIdx])
      const marketValue = shares != null && price != null ? shares * price : null
      return { row, holdingTicker, holdingName, shares, marketValue }
    })
    .filter((row) => row.holdingTicker && row.holdingName)
  const totalMarketValue = parsed.reduce((sum, row) => sum + (row.marketValue ?? 0), 0)
  return parsed.map((row) => ({
    holdingTicker: row.holdingTicker,
    holdingName: row.holdingName,
    weightPct: row.marketValue != null && totalMarketValue > 0 ? (row.marketValue / totalMarketValue) * 100 : null,
    shares: row.shares,
    marketValue: row.marketValue,
    asOfDate,
    raw: { row: row.row },
  }))
}

function parseBlackRockCsv(text: string): HoldingInput[] {
  const rows = parseCsv(text)
  const asOfRowIndex = rows.findIndex((row) => /^Fund Holdings as of/i.test(row[0] ?? ''))
  if (asOfRowIndex < 0) return []
  const asOfDate = parseCompactDate(rows[asOfRowIndex][1])
  const headerIndex = rows.findIndex((row, index) => index > asOfRowIndex && row[0]?.trim() === 'Ticker' && row[1]?.trim() === 'Name')
  if (headerIndex < 0) return []
  const header = rows[headerIndex]
  const tickerIdx = header.indexOf('Ticker')
  const nameIdx = header.indexOf('Name')
  const marketValueIdx = header.indexOf('Market Value')
  const weightIdx = header.indexOf('Weight (%)')
  const sharesIdx = header.indexOf('Shares')
  const holdings: HoldingInput[] = []
  for (const row of rows.slice(headerIndex + 1)) {
    if (/^Fund Holdings as of/i.test(row[0] ?? '')) break
    const holdingTicker = normalizeTicker(row[tickerIdx])
    if (!holdingTicker) continue
    holdings.push({
      holdingTicker,
      holdingName: cleanName(row[nameIdx]) || holdingTicker,
      weightPct: parseNumber(row[weightIdx]),
      shares: parseNumber(row[sharesIdx]),
      marketValue: parseNumber(row[marketValueIdx]),
      asOfDate,
      raw: { row },
    })
  }
  return holdings
}

async function fetchHoldings(item: SectorEtfCatalogItem): Promise<HoldingInput[]> {
  if (!item.holdingsUrl) return []
  if (item.provider === 'nextfunds') {
    return parseNextFundsXlsx(await fetchBuffer(item.holdingsUrl))
  }
  if (item.provider === 'globalx') {
    return parseGlobalXPcfCsv(await fetchText(item.holdingsUrl))
  }
  if (item.provider === 'blackrock') {
    return parseBlackRockCsv(await fetchText(item.holdingsUrl))
  }
  return []
}

async function recordRun(
  item: SectorEtfCatalogItem,
  status: 'success' | 'failed' | 'skipped',
  startedAt: number,
  holdingsCount: number,
  errorSummary?: string,
) {
  await client.execute({
    sql: `
      INSERT INTO sector_etf_holding_runs (
        etf_ticker, source, status, started_at, finished_at, holdings_count,
        error_summary, source_url, payload_json
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    args: [
      item.ticker,
      item.provider,
      status,
      startedAt,
      nowSec(),
      holdingsCount,
      errorSummary ?? null,
      item.holdingsUrl ?? item.sourceUrl,
      JSON.stringify({ shortName: item.shortName, group: item.group, theme: item.theme }),
    ],
  })
}

async function saveHoldings(item: SectorEtfCatalogItem, holdings: HoldingInput[]) {
  const updatedAt = nowSec()
  await client.execute({
    sql: `DELETE FROM sector_etf_holdings WHERE etf_ticker = ?`,
    args: [item.ticker],
  })
  const batch = holdings.map((holding) => ({
    sql: `
      INSERT INTO sector_etf_holdings (
        etf_ticker, holding_ticker, holding_name, weight_pct, shares, market_value,
        as_of_date, source, source_url, raw_json, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    args: [
      item.ticker,
      holding.holdingTicker,
      holding.holdingName,
      holding.weightPct,
      holding.shares,
      holding.marketValue,
      holding.asOfDate,
      item.provider,
      item.holdingsUrl ?? item.sourceUrl,
      JSON.stringify(holding.raw),
      updatedAt,
    ],
  }))
  for (let i = 0; i < batch.length; i += 200) {
    await client.batch(batch.slice(i, i + 200))
  }
}

async function processItem(item: SectorEtfCatalogItem) {
  const startedAt = nowSec()
  if (!item.holdingsUrl) {
    await recordRun(item, 'skipped', startedAt, 0, 'holdings source not configured')
    console.log(`[skipped] ${item.ticker} ${item.shortName}: holdings source not configured`)
    return { status: 'skipped' as const, count: 0 }
  }
  try {
    const holdings = await fetchHoldings(item)
    if (holdings.length === 0) throw new Error('no holdings parsed')
    await saveHoldings(item, holdings)
    await recordRun(item, 'success', startedAt, holdings.length)
    console.log(`[success] ${item.ticker} ${item.shortName}: ${holdings.length.toLocaleString()} holdings`)
    return { status: 'success' as const, count: holdings.length }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    await recordRun(item, 'failed', startedAt, 0, message.slice(0, 500))
    console.warn(`[failed] ${item.ticker} ${item.shortName}: ${message}`)
    return { status: 'failed' as const, count: 0 }
  }
}

async function main() {
  await ensureReady()
  const only = new Set(
    (process.env.SECTOR_ETF_TICKERS ?? '')
      .split(',')
      .map((v) => v.trim().toUpperCase())
      .filter(Boolean),
  )
  const targets = SECTOR_ETF_CATALOG.filter((item) => only.size === 0 || only.has(item.ticker))
  console.log(`sector ETF holdings batch: ${targets.length} ETFs`)
  let success = 0
  let failed = 0
  let skipped = 0
  let rows = 0
  for (const item of targets) {
    const result = await processItem(item)
    if (result.status === 'success') success += 1
    if (result.status === 'failed') failed += 1
    if (result.status === 'skipped') skipped += 1
    rows += result.count
    await sleep(700)
  }
  console.log(`done: success=${success}, failed=${failed}, skipped=${skipped}, rows=${rows.toLocaleString()}`)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
