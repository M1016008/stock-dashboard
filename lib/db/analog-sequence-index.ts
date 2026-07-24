import { createClient, type Client, type InValue } from '@libsql/client'
import fs from 'node:fs'
import path from 'node:path'
import { localDbPath } from '@/lib/db/client'
import { resolveUsAnalyticsDbPath } from '@/lib/db/us-analytics'
import {
  MA_SEQUENCE_BAND_COUNT,
  MA_SEQUENCE_VERSION,
  maSequenceBandNeighbors,
} from '@/lib/ml/ma-sequence'

export type AnalogSequenceMarket = 'JP' | 'US'

export type AnalogSequenceIndexRow = {
  ticker: string
  date: string
  stageCode: string | null
  embedding: Uint8Array
  coverageMask: number
  bandMatches: number
}

export type AnalogSequenceIndexMeta = {
  market: AnalogSequenceMarket
  version: number
  sourceDate: string | null
  coverageFrom: string | null
  coverageTo: string | null
  rowCount: number
  completed: boolean
  updatedAt: string | null
}

type RawIndexRow = {
  ticker: string
  date: string
  stage_code: string | null
  embedding: ArrayBuffer | Uint8Array
  coverage_mask: number
}

type RawMetaRow = {
  value: string
}

const globalForAnalogIndex = global as unknown as {
  analogSequenceClients?: Partial<Record<AnalogSequenceMarket, Client>>
  analogSequencePaths?: Partial<Record<AnalogSequenceMarket, string>>
  analogSequenceReady?: Partial<Record<AnalogSequenceMarket, Promise<void>>>
}

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback
}

function realDirectory(filePath: string): string {
  try {
    return path.dirname(fs.realpathSync(filePath))
  } catch {
    return path.dirname(filePath)
  }
}

export function resolveAnalogSequenceIndexPath(market: AnalogSequenceMarket): string {
  if (market === 'US') {
    const configured = process.env.ANALOG_US_DB_PATH?.trim()
    return configured
      ? path.resolve(configured)
      : path.join(realDirectory(resolveUsAnalyticsDbPath()), 'analog-sequence-us.db')
  }
  const configured = process.env.ANALOG_JP_DB_PATH?.trim()
  return configured
    ? path.resolve(configured)
    : path.join(realDirectory(localDbPath), 'analog-sequence-jp.db')
}

export function hasAnalogSequenceIndex(market: AnalogSequenceMarket): boolean {
  return fs.existsSync(resolveAnalogSequenceIndexPath(market))
}

function getClient(market: AnalogSequenceMarket): Client {
  const dbPath = resolveAnalogSequenceIndexPath(market)
  globalForAnalogIndex.analogSequenceClients ??= {}
  globalForAnalogIndex.analogSequencePaths ??= {}
  if (
    !globalForAnalogIndex.analogSequenceClients[market]
    || globalForAnalogIndex.analogSequencePaths[market] !== dbPath
  ) {
    globalForAnalogIndex.analogSequenceClients[market] = createClient({ url: `file:${dbPath}` })
    globalForAnalogIndex.analogSequencePaths[market] = dbPath
    if (globalForAnalogIndex.analogSequenceReady) delete globalForAnalogIndex.analogSequenceReady[market]
  }
  return globalForAnalogIndex.analogSequenceClients[market]!
}

async function ensureReady(market: AnalogSequenceMarket): Promise<void> {
  globalForAnalogIndex.analogSequenceReady ??= {}
  if (!globalForAnalogIndex.analogSequenceReady[market]) {
    const client = getClient(market)
    globalForAnalogIndex.analogSequenceReady[market] = Promise.resolve()
      .then(async () => {
        await client.execute(`PRAGMA busy_timeout=${positiveInteger(process.env.SQLITE_BUSY_TIMEOUT_MS, 60_000)}`)
        await client.execute('PRAGMA query_only=ON')
      })
      .catch((error) => {
        if (globalForAnalogIndex.analogSequenceReady) {
          delete globalForAnalogIndex.analogSequenceReady[market]
        }
        throw error
      })
  }
  await globalForAnalogIndex.analogSequenceReady[market]
}

async function execute<T>(
  market: AnalogSequenceMarket,
  sql: string,
  args: readonly InValue[] = [],
): Promise<T[]> {
  await ensureReady(market)
  const result = await getClient(market).execute({ sql, args: [...args] })
  return result.rows.map((row) => ({ ...row })) as unknown as T[]
}

function decodeBlob(value: ArrayBuffer | Uint8Array): Uint8Array {
  if (value instanceof Uint8Array) return value
  return new Uint8Array(value)
}

function yearWindows(fromDate: string, toDate: string, spanYears = 5): Array<[string, string]> {
  const fromYear = Number(fromDate.slice(0, 4))
  const toYear = Number(toDate.slice(0, 4))
  if (!Number.isFinite(fromYear) || !Number.isFinite(toYear)) return [[fromDate, toDate]]
  const windows: Array<[string, string]> = []
  for (let year = fromYear; year <= toYear; year += spanYears) {
    const start = year === fromYear ? fromDate : `${year}-01-01`
    const endYear = Math.min(toYear + 1, year + spanYears)
    const end = endYear > toYear ? toDate : `${endYear}-01-01`
    if (start < end) windows.push([start, end])
  }
  return windows.length > 0 ? windows : [[fromDate, toDate]]
}

async function metadataValue(
  market: AnalogSequenceMarket,
  key: string,
): Promise<string | null> {
  const [row] = await execute<RawMetaRow>(
    market,
    `SELECT value FROM analog_sequence_meta WHERE key = ? LIMIT 1`,
    [key],
  )
  return row?.value ?? null
}

export async function readAnalogSequenceIndexMeta(
  market: AnalogSequenceMarket,
): Promise<AnalogSequenceIndexMeta | null> {
  if (!hasAnalogSequenceIndex(market)) return null
  try {
    const [
      version,
      sourceDate,
      coverageFrom,
      coverageTo,
      rowCount,
      completed,
      updatedAt,
    ] = await Promise.all([
      metadataValue(market, 'version'),
      metadataValue(market, 'source_date'),
      metadataValue(market, 'coverage_from'),
      metadataValue(market, 'coverage_to'),
      metadataValue(market, 'row_count'),
      metadataValue(market, 'completed'),
      metadataValue(market, 'updated_at'),
    ])
    return {
      market,
      version: Number(version ?? 0),
      sourceDate,
      coverageFrom,
      coverageTo,
      rowCount: Number(rowCount ?? 0),
      completed: completed === '1',
      updatedAt,
    }
  } catch {
    return null
  }
}

export async function searchAnalogSequenceIndex(args: {
  market: AnalogSequenceMarket
  bands: number[]
  beforeDate: string
  excludeTicker?: string | null
  excludeAfterDate?: string | null
  perBandLimit?: number
  maxBitDistance?: number
}): Promise<AnalogSequenceIndexRow[]> {
  if (args.bands.length !== MA_SEQUENCE_BAND_COUNT) return []
  const perBandLimit = Math.min(
    50_000,
    Math.max(1_000, args.perBandLimit ?? positiveInteger(process.env.ANALOG_SEQUENCE_PER_BAND_LIMIT, 15_000)),
  )
  const maxBitDistance = Math.min(1, Math.max(0, args.maxBitDistance ?? 0))
  const meta = await readAnalogSequenceIndexMeta(args.market)
  const windows = yearWindows(meta?.coverageFrom || '1980-01-01', args.beforeDate)
  const perWindowLimit = Math.max(500, Math.ceil(perBandLimit / windows.length))
  const byKey = new Map<string, AnalogSequenceIndexRow>()
  for (let bandIndex = 0; bandIndex < MA_SEQUENCE_BAND_COUNT; bandIndex += 1) {
    const neighbors = maSequenceBandNeighbors(args.bands[bandIndex], maxBitDistance)
    const placeholders = neighbors.map(() => '?').join(', ')
    for (const [fromDate, toDate] of windows) {
      const rows = await execute<RawIndexRow>(
        args.market,
        `
        SELECT ticker, date, stage_code, embedding, coverage_mask
        FROM analog_sequence_index INDEXED BY analog_sequence_band${bandIndex}_idx
        WHERE band${bandIndex} IN (${placeholders})
          AND date >= ?
          AND date < ?
          ${args.excludeTicker && args.excludeAfterDate ? 'AND NOT (ticker = ? AND date >= ?)' : ''}
        ORDER BY date DESC
        LIMIT ?
        `,
        [
          ...neighbors,
          fromDate,
          toDate,
          ...(args.excludeTicker && args.excludeAfterDate ? [args.excludeTicker, args.excludeAfterDate] : []),
          perWindowLimit,
        ],
      )
      for (const row of rows) {
        const key = `${row.ticker}\u0000${row.date}`
        const existing = byKey.get(key)
        if (existing) {
          existing.bandMatches += 1
          continue
        }
        byKey.set(key, {
          ticker: row.ticker,
          date: row.date,
          stageCode: row.stage_code,
          embedding: decodeBlob(row.embedding),
          coverageMask: Number(row.coverage_mask),
          bandMatches: 1,
        })
      }
    }
  }
  return [...byKey.values()]
}

export async function searchAnalogSequenceIndexByStage(args: {
  market: AnalogSequenceMarket
  stageCodes: string[]
  beforeDate: string
  excludeTicker?: string | null
  excludeAfterDate?: string | null
  limitPerWindow?: number
}): Promise<AnalogSequenceIndexRow[]> {
  const stageCodes = [...new Set(args.stageCodes.filter((code) => /^[1-6]{5,6}$/.test(code)))]
  if (stageCodes.length === 0) return []
  const meta = await readAnalogSequenceIndexMeta(args.market)
  const windows = yearWindows(meta?.coverageFrom || '1980-01-01', args.beforeDate)
  const limitPerWindow = Math.min(5_000, Math.max(250, args.limitPerWindow ?? 1_200))
  const placeholders = stageCodes.map(() => '?').join(', ')
  const byKey = new Map<string, AnalogSequenceIndexRow>()
  for (const [fromDate, toDate] of windows) {
    const rows = await execute<RawIndexRow>(
      args.market,
      `
      SELECT ticker, date, stage_code, embedding, coverage_mask
      FROM analog_sequence_index INDEXED BY analog_sequence_stage_idx
      WHERE stage_code IN (${placeholders})
        AND date >= ?
        AND date < ?
        ${args.excludeTicker && args.excludeAfterDate ? 'AND NOT (ticker = ? AND date >= ?)' : ''}
      ORDER BY date DESC
      LIMIT ?
      `,
      [
        ...stageCodes,
        fromDate,
        toDate,
        ...(args.excludeTicker && args.excludeAfterDate ? [args.excludeTicker, args.excludeAfterDate] : []),
        limitPerWindow,
      ],
    )
    for (const row of rows) {
      const key = `${row.ticker}\u0000${row.date}`
      if (byKey.has(key)) continue
      byKey.set(key, {
        ticker: row.ticker,
        date: row.date,
        stageCode: row.stage_code,
        embedding: decodeBlob(row.embedding),
        coverageMask: Number(row.coverage_mask),
        bandMatches: 0,
      })
    }
  }
  return [...byKey.values()]
}

export async function assertAnalogSequenceIndexReady(
  market: AnalogSequenceMarket,
): Promise<AnalogSequenceIndexMeta> {
  const meta = await readAnalogSequenceIndexMeta(market)
  if (!meta || meta.version !== MA_SEQUENCE_VERSION || !meta.completed) {
    throw new Error(`${market}の局面検索索引が未構築です。`)
  }
  return meta
}
