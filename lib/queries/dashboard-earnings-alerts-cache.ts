import { client, execGet } from '@/lib/db/client'
import { getEarningsCalendarDashboard, getLatestDate, type EarningsCalendarDashboard } from '@/lib/queries/dashboard'
import type { UniverseFilterValue } from '@/lib/market-universe'

const EARNINGS_ALERT_CACHE_TTL_SEC = 30 * 60

type EarningsAlertCacheRow = {
  payloadJson: string
  computedAt: number
}

let ensureEarningsAlertCachePromise: Promise<void> | null = null

async function ensureEarningsAlertCacheTable(): Promise<void> {
  if (!ensureEarningsAlertCachePromise) {
    ensureEarningsAlertCachePromise = Promise.resolve()
      .then(async () => {
        await client.execute({
          sql: `
            CREATE TABLE IF NOT EXISTS dashboard_earnings_alert_cache (
              cache_key TEXT PRIMARY KEY,
              payload_json TEXT NOT NULL,
              computed_at INTEGER NOT NULL DEFAULT (unixepoch())
            )
          `,
          args: [],
        })
        await client.execute({
          sql: `CREATE INDEX IF NOT EXISTS dashboard_earnings_alert_cache_computed_idx ON dashboard_earnings_alert_cache(computed_at DESC)`,
          args: [],
        })
      })
      .catch((error) => {
        ensureEarningsAlertCachePromise = null
        throw error
      })
  }
  await ensureEarningsAlertCachePromise
}

function isIsoDate(value: string | null | undefined): value is string {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
}

async function readCache(cacheKey: string): Promise<EarningsCalendarDashboard | null> {
  await ensureEarningsAlertCacheTable()
  const row = await execGet<EarningsAlertCacheRow>(
    `
      SELECT payload_json AS payloadJson, computed_at AS computedAt
      FROM dashboard_earnings_alert_cache
      WHERE cache_key = ?
      LIMIT 1
    `,
    [cacheKey],
  )
  if (!row) return null
  const age = Math.floor(Date.now() / 1000) - Number(row.computedAt ?? 0)
  if (age > EARNINGS_ALERT_CACHE_TTL_SEC) return null
  try {
    return JSON.parse(row.payloadJson) as EarningsCalendarDashboard
  } catch {
    return null
  }
}

async function writeCache(cacheKey: string, payload: EarningsCalendarDashboard): Promise<void> {
  await ensureEarningsAlertCacheTable()
  await client.execute({
    sql: `
      INSERT INTO dashboard_earnings_alert_cache (cache_key, payload_json, computed_at)
      VALUES (?, ?, unixepoch())
      ON CONFLICT(cache_key) DO UPDATE SET
        payload_json = excluded.payload_json,
        computed_at = excluded.computed_at
    `,
    args: [cacheKey, JSON.stringify(payload)],
  })
}

export async function getDashboardEarningsAlertsCached(
  date: string | null,
  universe: UniverseFilterValue,
): Promise<EarningsCalendarDashboard> {
  const resolvedDate = isIsoDate(date) ? date : await getLatestDate()
  const cacheKey = `v1|date:${resolvedDate ?? 'none'}|u:${universe ?? 'all'}`
  const cached = await readCache(cacheKey)
  if (cached) return cached

  const data = await getEarningsCalendarDashboard(21, resolvedDate, {
    preferLatestImport: false,
    includeCompleted: true,
    filters: { limit: 80, universe },
  })
  await writeCache(cacheKey, data)
  return data
}
