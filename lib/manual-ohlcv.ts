import { execAll, execGet, execRun, type Args } from '@/lib/db/client'
import type { OHLCV } from '@/types/stock'

export interface ManualOhlcvParseResult {
  rows: OHLCV[]
  errors: string[]
}

export interface ManualOhlcvSummary {
  market: 'JP'
  ticker: string
  count: number
  firstDate: string | null
  latestDate: string | null
  importedAt: number | null
  sourceName: string | null
  sourceNote: string | null
}

interface ManualOhlcvRawRow {
  date: string
  open: number
  high: number
  low: number
  close: number
  volume: number
}

interface ManualSummaryRawRow {
  count: number
  firstDate: string | null
  latestDate: string | null
  importedAt: number | null
}

interface ManualSourceRawRow {
  sourceName: string | null
  sourceNote: string | null
}

type ManualColumnKey = 'date' | 'open' | 'high' | 'low' | 'close' | 'volume'
type HeaderMap = Record<ManualColumnKey, number>

const REQUIRED_COLUMNS: ManualColumnKey[] = ['date', 'open', 'high', 'low', 'close', 'volume']
const HEADER_ALIASES: Record<ManualColumnKey, Set<string>> = {
  date: new Set(['date', 'pricedate', 'tradedate', '日付', '年月日', '取引日']),
  open: new Set(['open', 'openprice', '始値']),
  high: new Set(['high', 'highprice', '高値']),
  low: new Set(['low', 'lowprice', '安値']),
  close: new Set(['close', 'closeprice', '終値']),
  volume: new Set(['volume', '出来高', '売買高']),
}

let schemaReady: Promise<void> | null = null

export function normalizeManualTicker(rawTicker: string): string {
  const ticker = rawTicker.trim().replace(/\.T$/i, '').toUpperCase()
  if (!ticker) throw new Error('ticker is required')
  return ticker
}

export async function ensureManualOhlcvSchema(): Promise<void> {
  if (!schemaReady) {
    schemaReady = (async () => {
      await execRun(`
        CREATE TABLE IF NOT EXISTS manual_ohlcv_daily (
          market TEXT NOT NULL DEFAULT 'JP',
          ticker TEXT NOT NULL,
          date TEXT NOT NULL,
          open REAL NOT NULL,
          high REAL NOT NULL,
          low REAL NOT NULL,
          close REAL NOT NULL,
          volume INTEGER NOT NULL DEFAULT 0,
          source_name TEXT,
          source_note TEXT,
          imported_at INTEGER NOT NULL DEFAULT (unixepoch()),
          PRIMARY KEY (market, ticker, date)
        )
      `)
      await execRun(`
        CREATE INDEX IF NOT EXISTS manual_ohlcv_market_ticker_date_idx
        ON manual_ohlcv_daily(market, ticker, date)
      `)
    })()
  }
  return schemaReady
}

export function parseManualOhlcvCsv(csv: string): ManualOhlcvParseResult {
  const records = csv
    .replace(/^\uFEFF/, '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line, index) => ({
      lineNumber: index + 1,
      raw: line,
      columns: splitDelimitedLine(line, line.includes('\t') && !line.includes(',') ? '\t' : ','),
    }))
    .filter((record) => {
      const trimmed = record.raw.trim()
      return trimmed.length > 0 && !trimmed.startsWith('#')
    })

  if (records.length === 0) {
    return { rows: [], errors: ['CSVに有効な行がありません'] }
  }

  const first = records[0]
  const headerMap = buildHeaderMap(first.columns)
  const dataRecords = headerMap ? records.slice(1) : records
  const columnMap = headerMap ?? {
    date: 0,
    open: 1,
    high: 2,
    low: 3,
    close: 4,
    volume: 5,
  }

  const errors: string[] = []
  const rowsByDate = new Map<string, OHLCV>()

  for (const record of dataRecords) {
    try {
      const row = parseRecord(record.columns, columnMap, record.lineNumber)
      rowsByDate.set(row.date, row)
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error))
    }
  }

  const rows = [...rowsByDate.values()].sort((a, b) => a.date.localeCompare(b.date))
  if (rows.length === 0 && errors.length === 0) {
    errors.push('取り込める価格行がありません')
  }

  return { rows, errors: errors.slice(0, 30) }
}

export async function upsertManualOhlcvRows(params: {
  ticker: string
  rows: OHLCV[]
  sourceName?: string | null
  sourceNote?: string | null
}): Promise<ManualOhlcvSummary> {
  await ensureManualOhlcvSchema()
  const ticker = normalizeManualTicker(params.ticker)
  const importedAt = Math.floor(Date.now() / 1000)
  const sourceName = cleanOptionalText(params.sourceName, 80)
  const sourceNote = cleanOptionalText(params.sourceNote, 240)
  const chunks = chunk(params.rows, 200)

  for (const part of chunks) {
    const placeholders = part.map(() => '(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').join(', ')
    const args: Array<string | number | null> = []
    for (const row of part) {
      args.push(
        'JP',
        ticker,
        row.date,
        row.open,
        row.high,
        row.low,
        row.close,
        Math.trunc(row.volume ?? 0),
        sourceName,
        sourceNote,
        importedAt,
      )
    }
    await execRun(
      `
        INSERT INTO manual_ohlcv_daily (
          market, ticker, date, open, high, low, close, volume, source_name, source_note, imported_at
        )
        VALUES ${placeholders}
        ON CONFLICT(market, ticker, date) DO UPDATE SET
          open = excluded.open,
          high = excluded.high,
          low = excluded.low,
          close = excluded.close,
          volume = excluded.volume,
          source_name = excluded.source_name,
          source_note = excluded.source_note,
          imported_at = excluded.imported_at
      `,
      args as Args,
    )
  }

  return getManualOhlcvSummary(ticker)
}

export async function getManualOhlcvSummary(rawTicker: string): Promise<ManualOhlcvSummary> {
  await ensureManualOhlcvSchema()
  const ticker = normalizeManualTicker(rawTicker)
  const summary = await execGet<ManualSummaryRawRow>(
    `
      SELECT
        COUNT(*) AS count,
        MIN(date) AS firstDate,
        MAX(date) AS latestDate,
        MAX(imported_at) AS importedAt
      FROM manual_ohlcv_daily
      WHERE market = 'JP'
        AND ticker = ?
    `,
    [ticker],
  )
  const source = await execGet<ManualSourceRawRow>(
    `
      SELECT source_name AS sourceName, source_note AS sourceNote
      FROM manual_ohlcv_daily
      WHERE market = 'JP'
        AND ticker = ?
      ORDER BY imported_at DESC, date DESC
      LIMIT 1
    `,
    [ticker],
  )

  return {
    market: 'JP',
    ticker,
    count: Number(summary?.count ?? 0),
    firstDate: summary?.firstDate ?? null,
    latestDate: summary?.latestDate ?? null,
    importedAt: summary?.importedAt ?? null,
    sourceName: source?.sourceName ?? null,
    sourceNote: source?.sourceNote ?? null,
  }
}

export async function loadManualOhlcvRows(
  rawTicker: string,
  options: { fromDate?: string | null; asOfDate?: string | null } = {},
): Promise<OHLCV[]> {
  await ensureManualOhlcvSchema()
  const ticker = normalizeManualTicker(rawTicker)
  const where = ["market = 'JP'", 'ticker = ?']
  const args: Array<string | number> = [ticker]
  if (options.fromDate) {
    where.push('date >= ?')
    args.push(options.fromDate)
  }
  if (options.asOfDate) {
    where.push('date <= ?')
    args.push(options.asOfDate)
  }
  const rows = await execAll<ManualOhlcvRawRow>(
    `
      SELECT date, open, high, low, close, volume
      FROM manual_ohlcv_daily
      WHERE ${where.join(' AND ')}
      ORDER BY date
    `,
    args as Args,
  )
  return rows.map(toOhlcv)
}

export async function loadManualLatestOhlcvRows(rawTicker: string, limit = 2): Promise<OHLCV[]> {
  await ensureManualOhlcvSchema()
  const ticker = normalizeManualTicker(rawTicker)
  const rows = await execAll<ManualOhlcvRawRow>(
    `
      SELECT date, open, high, low, close, volume
      FROM manual_ohlcv_daily
      WHERE market = 'JP'
        AND ticker = ?
      ORDER BY date DESC
      LIMIT ?
    `,
    [ticker, limit],
  )
  return rows.map(toOhlcv)
}

export async function getManualOhlcvHiLo(rawTicker: string, sinceDate: string): Promise<{ hi?: number; lo?: number }> {
  await ensureManualOhlcvSchema()
  const ticker = normalizeManualTicker(rawTicker)
  const row = await execGet<{ hi: number | null; lo: number | null }>(
    `
      SELECT MAX(high) AS hi, MIN(low) AS lo
      FROM manual_ohlcv_daily
      WHERE market = 'JP'
        AND ticker = ?
        AND date >= ?
    `,
    [ticker, sinceDate],
  )
  return {
    hi: row?.hi ?? undefined,
    lo: row?.lo ?? undefined,
  }
}

function splitDelimitedLine(line: string, delimiter: ',' | '\t'): string[] {
  const columns: string[] = []
  let current = ''
  let inQuotes = false

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index]
    const next = line[index + 1]
    if (char === '"') {
      if (inQuotes && next === '"') {
        current += '"'
        index += 1
      } else {
        inQuotes = !inQuotes
      }
      continue
    }
    if (char === delimiter && !inQuotes) {
      columns.push(current.trim())
      current = ''
      continue
    }
    current += char
  }
  columns.push(current.trim())
  return columns
}

function buildHeaderMap(columns: string[]): HeaderMap | null {
  const map: Partial<HeaderMap> = {}
  columns.forEach((column, index) => {
    const normalized = normalizeHeader(column)
    for (const key of REQUIRED_COLUMNS) {
      if (HEADER_ALIASES[key].has(normalized)) {
        map[key] = index
      }
    }
  })
  return REQUIRED_COLUMNS.every((key) => map[key] !== undefined) ? map as HeaderMap : null
}

function normalizeHeader(value: string): string {
  return value
    .replace(/^\uFEFF/, '')
    .trim()
    .toLowerCase()
    .replace(/[()\[\]（）【】\s_・]/g, '')
    .replace(/[円株]/g, '')
}

function parseRecord(columns: string[], map: HeaderMap, lineNumber: number): OHLCV {
  for (const key of REQUIRED_COLUMNS) {
    if (columns[map[key]] === undefined || columns[map[key]].trim() === '') {
      throw new Error(`${lineNumber}行目: ${key} が空です`)
    }
  }
  const date = parseDate(columns[map.date])
  const open = parseNumber(columns[map.open], lineNumber, 'open')
  const high = parseNumber(columns[map.high], lineNumber, 'high')
  const low = parseNumber(columns[map.low], lineNumber, 'low')
  const close = parseNumber(columns[map.close], lineNumber, 'close')
  const volume = parseVolume(columns[map.volume], lineNumber)

  if (open <= 0 || high <= 0 || low <= 0 || close <= 0) {
    throw new Error(`${lineNumber}行目: 価格は0より大きい値にしてください`)
  }
  if (high < low) {
    throw new Error(`${lineNumber}行目: 高値が安値を下回っています`)
  }
  if (open > high || open < low || close > high || close < low) {
    throw new Error(`${lineNumber}行目: 始値または終値が高値/安値の範囲外です`)
  }

  return { date, open, high, low, close, volume }
}

function parseDate(value: string): string {
  const trimmed = value.trim()
  const match = trimmed.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/)
    ?? trimmed.match(/^(\d{4})年(\d{1,2})月(\d{1,2})日$/)
  if (!match) throw new Error(`日付形式が不正です: ${value}`)
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const date = new Date(Date.UTC(year, month - 1, day))
  if (
    date.getUTCFullYear() !== year
    || date.getUTCMonth() !== month - 1
    || date.getUTCDate() !== day
  ) {
    throw new Error(`日付が存在しません: ${value}`)
  }
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

function parseNumber(value: string, lineNumber: number, label: string): number {
  const normalized = value.replace(/[,\s￥¥円株]/g, '')
  const number = Number(normalized)
  if (!Number.isFinite(number)) {
    throw new Error(`${lineNumber}行目: ${label} が数値ではありません`)
  }
  return number
}

function parseVolume(value: string, lineNumber: number): number {
  const volume = parseNumber(value, lineNumber, 'volume')
  if (volume < 0) throw new Error(`${lineNumber}行目: volume がマイナスです`)
  return Math.trunc(volume)
}

function cleanOptionalText(value: string | null | undefined, maxLength: number): string | null {
  const text = value?.trim()
  if (!text) return null
  return text.slice(0, maxLength)
}

function toOhlcv(row: ManualOhlcvRawRow): OHLCV {
  return {
    date: row.date,
    open: Number(row.open),
    high: Number(row.high),
    low: Number(row.low),
    close: Number(row.close),
    volume: Number(row.volume),
  }
}

function chunk<T>(values: T[], size: number): T[][] {
  const chunks: T[][] = []
  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size))
  }
  return chunks
}
