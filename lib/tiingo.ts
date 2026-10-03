import type { OHLCV } from '@/types/stock'
import { inflateRawSync } from 'node:zlib'

const TIINGO_BASE_URL = 'https://api.tiingo.com'
const TIINGO_SUPPORTED_TICKERS_ZIP = 'https://apimedia.tiingo.com/docs/tiingo/daily/supported_tickers.zip'
const TIINGO_REQUEST_RETRIES = Math.max(0, Number(process.env.TIINGO_REQUEST_RETRIES ?? 3))
const TIINGO_RETRY_BASE_MS = Math.max(100, Number(process.env.TIINGO_RETRY_BASE_MS ?? 750))
const TIINGO_REQUEST_TIMEOUT_MS = Math.max(5_000, Number(process.env.TIINGO_REQUEST_TIMEOUT_MS ?? 30_000))

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

export class TiingoHttpError extends Error {
  readonly status: number
  readonly retryAfterSeconds: number | null

  constructor(message: string, status: number, retryAfterSeconds: number | null) {
    super(message)
    this.name = 'TiingoHttpError'
    this.status = status
    this.retryAfterSeconds = retryAfterSeconds
  }
}

export function isTiingoRateLimitError(error: unknown): error is TiingoHttpError {
  if (error instanceof TiingoHttpError) return error.status === 429
  if (typeof error === 'object' && error !== null && 'status' in error) {
    return Number((error as { status?: unknown }).status) === 429
  }
  const message = error instanceof Error ? error.message : String(error)
  return /\bHTTP\s+429\b/i.test(message)
}

export type TiingoTickerMeta = {
  ticker: string
  name?: string | null
  exchange?: string | null
  assetType?: string | null
  priceCurrency?: string | null
  startDate?: string | null
  endDate?: string | null
}

export type TiingoPriceRow = {
  date: string
  open: number
  high: number
  low: number
  close: number
  volume: number
  adjOpen?: number | null
  adjHigh?: number | null
  adjLow?: number | null
  adjClose?: number | null
  adjVolume?: number | null
  divCash?: number | null
  splitFactor?: number | null
}

function apiKey(): string {
  const key = process.env.TIINGO_API_KEY?.trim()
  if (!key) throw new Error('TIINGO_API_KEY is not set')
  return key
}

function compactDate(value: string | null | undefined): string | null {
  if (!value) return null
  return value.slice(0, 10)
}

function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = []
  let row: string[] = []
  let cell = ''
  let quoted = false
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]
    const next = text[i + 1]
    if (quoted) {
      if (ch === '"' && next === '"') {
        cell += '"'
        i += 1
      } else if (ch === '"') {
        quoted = false
      } else {
        cell += ch
      }
      continue
    }
    if (ch === '"') {
      quoted = true
    } else if (ch === ',') {
      row.push(cell)
      cell = ''
    } else if (ch === '\n') {
      row.push(cell.replace(/\r$/, ''))
      rows.push(row)
      row = []
      cell = ''
    } else {
      cell += ch
    }
  }
  if (cell || row.length) {
    row.push(cell.replace(/\r$/, ''))
    rows.push(row)
  }
  const [headers = [], ...body] = rows.filter((r) => r.some((v) => v !== ''))
  return body.map((values) => Object.fromEntries(headers.map((header, index) => [header, values[index] ?? ''])))
}

function extractCsvFromZip(bytes: Uint8Array): string {
  const buffer = Buffer.from(bytes)
  const eocdSig = 0x06054b50
  let eocd = -1
  for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 65558); i -= 1) {
    if (buffer.readUInt32LE(i) === eocdSig) {
      eocd = i
      break
    }
  }
  if (eocd < 0) throw new Error('Tiingo supported_tickers zip: EOCD not found')
  const centralDirOffset = buffer.readUInt32LE(eocd + 16)
  const totalEntries = buffer.readUInt16LE(eocd + 10)
  let cursor = centralDirOffset
  for (let i = 0; i < totalEntries; i += 1) {
    if (buffer.readUInt32LE(cursor) !== 0x02014b50) break
    const method = buffer.readUInt16LE(cursor + 10)
    const compressedSize = buffer.readUInt32LE(cursor + 20)
    const fileNameLength = buffer.readUInt16LE(cursor + 28)
    const extraLength = buffer.readUInt16LE(cursor + 30)
    const commentLength = buffer.readUInt16LE(cursor + 32)
    const localHeaderOffset = buffer.readUInt32LE(cursor + 42)
    const fileName = buffer.toString('utf8', cursor + 46, cursor + 46 + fileNameLength)
    if (fileName.endsWith('.csv')) {
      if (buffer.readUInt32LE(localHeaderOffset) !== 0x04034b50) {
        throw new Error('Tiingo supported_tickers zip: local header not found')
      }
      const localNameLength = buffer.readUInt16LE(localHeaderOffset + 26)
      const localExtraLength = buffer.readUInt16LE(localHeaderOffset + 28)
      const dataStart = localHeaderOffset + 30 + localNameLength + localExtraLength
      const data = buffer.subarray(dataStart, dataStart + compressedSize)
      if (method === 0) return data.toString('utf8')
      if (method === 8) return inflateRawSync(data).toString('utf8')
      throw new Error(`Tiingo supported_tickers zip: unsupported compression method ${method}`)
    }
    cursor += 46 + fileNameLength + extraLength + commentLength
  }
  throw new Error('Tiingo supported_tickers zip: csv not found')
}

async function tiingoGet<T>(path: string, params: Record<string, string | number | undefined | null> = {}): Promise<T> {
  const url = new URL(path, TIINGO_BASE_URL)
  for (const [key, value] of Object.entries(params)) {
    if (value != null && value !== '') url.searchParams.set(key, String(value))
  }
  url.searchParams.set('token', apiKey())
  const maxAttempts = TIINGO_REQUEST_RETRIES + 1
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const res = await fetch(url, {
        headers: {
          'accept': 'application/json',
          'content-type': 'application/json',
          'user-agent': 'StockBoard Tiingo ingestion',
        },
        signal: AbortSignal.timeout(TIINGO_REQUEST_TIMEOUT_MS),
      })
      if (!res.ok) {
        const body = await res.text().catch(() => '')
        const retryAfter = Number(res.headers.get('retry-after'))
        const error = new TiingoHttpError(
          `Tiingo ${path} failed: HTTP ${res.status}${body ? ` ${body.slice(0, 240)}` : ''}`,
          res.status,
          Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : null,
        )
        const retryableStatus = [408, 425, 500, 502, 503, 504].includes(res.status)
        if (!retryableStatus || attempt >= maxAttempts) throw error
      } else {
        return await res.json() as T
      }
    } catch (error) {
      if (error instanceof TiingoHttpError) {
        const retryableStatus = [408, 425, 500, 502, 503, 504].includes(error.status)
        if (!retryableStatus || attempt >= maxAttempts) throw error
      } else if (attempt >= maxAttempts) {
        throw error
      }
    }
    const backoffMs = TIINGO_RETRY_BASE_MS * (2 ** (attempt - 1))
    await sleep(backoffMs)
  }
  throw new Error(`Tiingo ${path} failed after ${maxAttempts} attempts`)
}

export async function fetchTiingoSupportedTickers(): Promise<TiingoTickerMeta[]> {
  const res = await fetch(TIINGO_SUPPORTED_TICKERS_ZIP, {
    headers: {
      'accept': 'application/zip,text/csv,*/*',
      'user-agent': 'StockBoard Tiingo ingestion',
    },
  })
  if (!res.ok) throw new Error(`Tiingo supported_tickers.zip failed: HTTP ${res.status}`)
  const csv = extractCsvFromZip(new Uint8Array(await res.arrayBuffer()))
  const rows = parseCsv(csv) as TiingoTickerMeta[]
  return rows
    .filter((row) => typeof row.ticker === 'string' && row.ticker.trim())
    .map((row) => ({
      ...row,
      ticker: row.ticker.trim().toUpperCase(),
      startDate: compactDate(row.startDate),
      endDate: compactDate(row.endDate),
    }))
}

export async function fetchTiingoTickerMeta(ticker: string): Promise<TiingoTickerMeta> {
  const row = await tiingoGet<TiingoTickerMeta>(`/tiingo/daily/${encodeURIComponent(ticker.toUpperCase())}`)
  return {
    ...row,
    ticker: (row.ticker || ticker).toUpperCase(),
    startDate: compactDate(row.startDate),
    endDate: compactDate(row.endDate),
  }
}

export async function fetchTiingoDailyPrices(
  ticker: string,
  startDate: string,
  endDate?: string | null,
): Promise<Array<OHLCV & {
  adjustedOpen: number | null
  adjustedHigh: number | null
  adjustedLow: number | null
  adjustedClose: number | null
  adjustedVolume: number | null
  divCash: number | null
  splitFactor: number | null
}>> {
  const rows = await tiingoGet<TiingoPriceRow[]>(`/tiingo/daily/${encodeURIComponent(ticker.toUpperCase())}/prices`, {
    startDate,
    endDate: endDate ?? undefined,
    format: 'json',
  })
  return rows.map((row) => ({
    date: compactDate(row.date) ?? row.date,
    open: Number(row.open),
    high: Number(row.high),
    low: Number(row.low),
    close: Number(row.close),
    volume: Number(row.volume ?? 0),
    adjustedOpen: row.adjOpen == null ? null : Number(row.adjOpen),
    adjustedHigh: row.adjHigh == null ? null : Number(row.adjHigh),
    adjustedLow: row.adjLow == null ? null : Number(row.adjLow),
    adjustedClose: row.adjClose == null ? null : Number(row.adjClose),
    adjustedVolume: row.adjVolume == null ? null : Number(row.adjVolume),
    divCash: row.divCash == null ? null : Number(row.divCash),
    splitFactor: row.splitFactor == null ? null : Number(row.splitFactor),
  }))
}
