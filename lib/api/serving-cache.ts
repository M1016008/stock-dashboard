import { createHash } from 'node:crypto'
import { execGet, execRun } from '@/lib/db/client'

type CacheRow = {
  payload_json: string
  generated_at_ms: number
}

let ready: Promise<void> | null = null

function ensureReady() {
  if (!ready) {
    ready = (async () => {
      await execRun(`
        CREATE TABLE IF NOT EXISTS api_serving_cache (
          namespace TEXT NOT NULL,
          cache_key TEXT NOT NULL,
          payload_json TEXT NOT NULL,
          generated_at_ms INTEGER NOT NULL,
          expires_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          PRIMARY KEY (namespace, cache_key)
        )
      `)
      await execRun(`
        CREATE INDEX IF NOT EXISTS api_serving_cache_expires_idx
        ON api_serving_cache(namespace, expires_at)
      `)
    })().catch((error) => {
      ready = null
      throw error
    })
  }
  return ready
}

export function stableCacheKey(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

export async function readServingCache<T>(
  namespace: string,
  cacheKey: string,
  ttlMs: number,
): Promise<{ payload: T; generatedAt: number } | null> {
  await ensureReady()
  const minGeneratedAt = Date.now() - ttlMs
  const row = await execGet<CacheRow>(
    `
    SELECT payload_json, generated_at_ms
    FROM api_serving_cache
    WHERE namespace = ?
      AND cache_key = ?
      AND generated_at_ms >= ?
      AND expires_at > ?
    LIMIT 1
    `,
    [namespace, cacheKey, minGeneratedAt, Math.floor(Date.now() / 1000)],
  )
  if (!row) return null
  try {
    return {
      payload: JSON.parse(row.payload_json) as T,
      generatedAt: Number(row.generated_at_ms),
    }
  } catch {
    return null
  }
}

export async function writeServingCache<T>(
  namespace: string,
  cacheKey: string,
  payload: T,
  ttlMs: number,
  generatedAt = Date.now(),
): Promise<void> {
  await ensureReady()
  const now = Math.floor(Date.now() / 1000)
  const expiresAt = Math.floor((generatedAt + ttlMs) / 1000)
  await execRun(
    `
    INSERT INTO api_serving_cache (
      namespace,
      cache_key,
      payload_json,
      generated_at_ms,
      expires_at,
      updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(namespace, cache_key) DO UPDATE SET
      payload_json = excluded.payload_json,
      generated_at_ms = excluded.generated_at_ms,
      expires_at = excluded.expires_at,
      updated_at = excluded.updated_at
    `,
    [namespace, cacheKey, JSON.stringify(payload), generatedAt, expiresAt, now],
  )
}
