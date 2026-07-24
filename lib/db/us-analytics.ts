import { createClient, type Client, type InValue } from '@libsql/client'
import fs from 'fs'
import path from 'path'

const DEFAULT_US_ANALYTICS_PATH = 'data/stockboard-us.db'

const globalForUsAnalytics = global as unknown as {
  usAnalyticsClient?: Client
  usAnalyticsPath?: string
  usAnalyticsPragmasReady?: Promise<void>
}

export type UsAnalyticsArgs = readonly InValue[]

export function resolveUsAnalyticsDbPath(): string {
  const configured = process.env.US_ANALYTICS_DB_PATH?.trim()
  return configured
    ? path.resolve(configured)
    : path.join(/* turbopackIgnore: true */ process.cwd(), DEFAULT_US_ANALYTICS_PATH)
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

function getClient(): Client {
  const dbPath = resolveUsAnalyticsDbPath()
  if (!globalForUsAnalytics.usAnalyticsClient || globalForUsAnalytics.usAnalyticsPath !== dbPath) {
    globalForUsAnalytics.usAnalyticsClient = createClient({ url: `file:${dbPath}` })
    globalForUsAnalytics.usAnalyticsPath = dbPath
    delete globalForUsAnalytics.usAnalyticsPragmasReady
  }
  return globalForUsAnalytics.usAnalyticsClient
}

async function ensurePragmas(): Promise<void> {
  if (!globalForUsAnalytics.usAnalyticsPragmasReady) {
    const client = getClient()
    globalForUsAnalytics.usAnalyticsPragmasReady = Promise.resolve()
      .then(async () => {
        const busyTimeoutMs = Math.max(1_000, numberEnv('SQLITE_BUSY_TIMEOUT_MS', 60_000))
        await client.execute(`PRAGMA busy_timeout=${busyTimeoutMs}`)
        await client.execute('PRAGMA synchronous=NORMAL')
        const journalMode = await client.execute('PRAGMA journal_mode')
        const mode = String(
          journalMode.rows[0]?.journal_mode
          ?? journalMode.rows[0]?.['journal_mode']
          ?? '',
        ).toLowerCase()
        if (mode !== 'wal') {
          try {
            await client.execute('PRAGMA journal_mode=WAL')
          } catch (error) {
            if (!isBusyError(error)) throw error
          }
        }
        await client.execute('PRAGMA query_only=ON')
      })
      .catch((error) => {
        delete globalForUsAnalytics.usAnalyticsPragmasReady
        throw error
      })
  }
  await globalForUsAnalytics.usAnalyticsPragmasReady
}

export async function execUsAnalyticsAll<T = Record<string, unknown>>(
  sql: string,
  args: UsAnalyticsArgs = [],
): Promise<T[]> {
  if (!hasUsAnalyticsDb()) {
    throw new Error(`US analytics DB not found: ${resolveUsAnalyticsDbPath()}`)
  }
  await ensurePragmas()
  const res = await withBusyRetry(() => getClient().execute({ sql, args: args as InValue[] }))
  return res.rows.map((row) => ({ ...row })) as unknown as T[]
}

export async function execUsAnalyticsGet<T = Record<string, unknown>>(
  sql: string,
  args: UsAnalyticsArgs = [],
): Promise<T | undefined> {
  const rows = await execUsAnalyticsAll<T>(sql, args)
  return rows[0]
}
