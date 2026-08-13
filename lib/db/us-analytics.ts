import { createClient, type Client, type InValue } from '@libsql/client'
import fs from 'fs'
import path from 'path'
import { CURRENT_STORAGE_ROOT } from '@/lib/storage-paths'

const DEFAULT_US_ANALYTICS_PATH = 'data/stockboard-us.db'
const EXTERNAL_US_ANALYTICS_PATH = path.join(
  CURRENT_STORAGE_ROOT,
  'stockboard-data',
  'us',
  'stockboard-us.db',
)

type UsAnalyticsGeneration = {
  client: Client
  identity: string
  path: string
  pragmasReady?: Promise<void>
}

const globalForUsAnalytics = global as unknown as {
  usAnalyticsGeneration?: UsAnalyticsGeneration
}

export type UsAnalyticsArgs = readonly InValue[]

export function resolveUsAnalyticsDbPath(): string {
  const configured = process.env.US_ANALYTICS_DB_PATH?.trim()
  if (configured) return path.resolve(configured)

  const localPath = path.join(/* turbopackIgnore: true */ process.cwd(), DEFAULT_US_ANALYTICS_PATH)
  if (fs.existsSync(localPath)) return localPath
  return fs.existsSync(EXTERNAL_US_ANALYTICS_PATH) ? EXTERNAL_US_ANALYTICS_PATH : localPath
}

export function hasUsAnalyticsDb(): boolean {
  return fs.existsSync(resolveUsAnalyticsDbPath())
}

function numberEnv(name: string, fallback: number): number {
  const value = Number(process.env[name])
  return Number.isFinite(value) && value > 0 ? value : fallback
}

function isBusyError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /SQLITE_BUSY|database is locked/i.test(message)
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function fileIdentity(dbPath: string): string {
  const stat = fs.statSync(dbPath)
  return `${stat.dev}:${stat.ino}`
}

async function withBusyRetry<T>(operation: () => Promise<T>): Promise<T> {
  const maxRetries = Math.max(0, numberEnv('US_SQLITE_BUSY_RETRIES', numberEnv('SQLITE_BUSY_RETRIES', 8)))
  for (let attempt = 0; ; attempt++) {
    try {
      return await operation()
    } catch (error) {
      if (!isBusyError(error) || attempt >= maxRetries) throw error
      await sleep(Math.min(2_000, 100 * 2 ** attempt))
    }
  }
}

function retireClient(client: Client): void {
  const timer = setTimeout(() => {
    try {
      client.close()
    } catch {
      // The retired generation is already detached from new requests.
    }
  }, 120_000)
  timer.unref()
}

function getGeneration(): UsAnalyticsGeneration {
  const dbPath = resolveUsAnalyticsDbPath()
  const identity = fileIdentity(dbPath)
  const current = globalForUsAnalytics.usAnalyticsGeneration
  if (!current || current.path !== dbPath || current.identity !== identity) {
    const next = {
      client: createClient({ url: `file:${dbPath}` }),
      identity,
      path: dbPath,
    }
    globalForUsAnalytics.usAnalyticsGeneration = next
    if (current) retireClient(current.client)
    return next
  }
  return current
}

async function ensurePragmas(generation: UsAnalyticsGeneration): Promise<void> {
  if (!generation.pragmasReady) {
    const ready = Promise.resolve()
      .then(async () => {
        const busyTimeoutMs = Math.max(1_000, numberEnv('SQLITE_BUSY_TIMEOUT_MS', 60_000))
        await generation.client.execute(`PRAGMA busy_timeout=${busyTimeoutMs}`)
        await generation.client.execute('PRAGMA synchronous=NORMAL')
        const journalMode = await generation.client.execute('PRAGMA journal_mode')
        const mode = String(
          journalMode.rows[0]?.journal_mode
          ?? journalMode.rows[0]?.['journal_mode']
          ?? '',
        ).toLowerCase()
        if (mode !== 'wal') {
          try {
            await generation.client.execute('PRAGMA journal_mode=WAL')
          } catch (error) {
            if (!isBusyError(error)) throw error
          }
        }
        await generation.client.execute('PRAGMA query_only=ON')
      })
      .catch((error) => {
        if (generation.pragmasReady === ready) delete generation.pragmasReady
        throw error
      })
    generation.pragmasReady = ready
  }
  await generation.pragmasReady
}

export async function execUsAnalyticsAll<T = Record<string, unknown>>(
  sql: string,
  args: UsAnalyticsArgs = [],
): Promise<T[]> {
  if (!hasUsAnalyticsDb()) {
    throw new Error(`US analytics DB not found: ${resolveUsAnalyticsDbPath()}`)
  }
  const generation = getGeneration()
  await ensurePragmas(generation)
  const res = await withBusyRetry(
    () => generation.client.execute({ sql, args: args as InValue[] }),
  )
  return res.rows.map((row) => ({ ...row })) as unknown as T[]
}

export async function execUsAnalyticsGet<T = Record<string, unknown>>(
  sql: string,
  args: UsAnalyticsArgs = [],
): Promise<T | undefined> {
  const rows = await execUsAnalyticsAll<T>(sql, args)
  return rows[0]
}
