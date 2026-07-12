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
        await client.execute('PRAGMA busy_timeout=60000')
        await client.execute('PRAGMA synchronous=NORMAL')
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
  const res = await getClient().execute({ sql, args: args as InValue[] })
  return res.rows.map((row) => ({ ...row })) as unknown as T[]
}

export async function execUsAnalyticsGet<T = Record<string, unknown>>(
  sql: string,
  args: UsAnalyticsArgs = [],
): Promise<T | undefined> {
  const rows = await execUsAnalyticsAll<T>(sql, args)
  return rows[0]
}
