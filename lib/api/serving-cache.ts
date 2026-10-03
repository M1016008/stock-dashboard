import { createHash } from 'node:crypto'
import path from 'node:path'
import { type Client, type InValue } from '@libsql/client'
import { localDbPath } from '@/lib/db/client'
import { openOptionalGuardedReadOnlyClient, openRebuildableGuardedClient } from '@/lib/storage/guarded-libsql-client'

type CacheRow = {
  payload_json: string
  generated_at_ms: number
}

const globalForServingCache = global as unknown as {
  servingCacheClient?: Client
  servingCachePath?: string
  servingCacheAccess?: 'READ' | 'WRITE'
  servingCacheReady?: Promise<void>
  servingCacheLastCleanupAt?: number
  servingCacheWriteQueue?: Promise<void>
  servingCacheLastBusyWarningAt?: number
}

function numberEnv(name: string, fallback: number): number {
  const value = Number(process.env[name])
  return Number.isFinite(value) && value >= 0 ? value : fallback
}

function isBusyError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /SQLITE_BUSY|database is locked/i.test(message)
}

function isCacheLocalFailure(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  const code = error && typeof error === 'object'
    ? String((error as { code?: unknown; rawCode?: unknown }).code ?? (error as { rawCode?: unknown }).rawCode ?? '')
    : ''
  return /^(ENOENT|SQLITE_CORRUPT|SQLITE_NOTADB|SQLITE_SCHEMA|SQLITE_NOTFOUND)$/.test(code)
    || /no such table|database disk image is malformed|file is not a database|schema (?:has )?changed/i.test(message)
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function warnBusyOnce(operation: 'read' | 'write' | 'cleanup'): void {
  const now = Date.now()
  const lastWarningAt = globalForServingCache.servingCacheLastBusyWarningAt ?? 0
  if (now - lastWarningAt < 60_000) return
  globalForServingCache.servingCacheLastBusyWarningAt = now
  console.warn(`Serving cache ${operation} skipped because the optional cache database is busy.`)
}

async function withBusyRetry<T>(operation: () => Promise<T>): Promise<T> {
  const maxRetries = Math.max(0, numberEnv('SERVING_CACHE_BUSY_RETRIES', 8))
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await operation()
    } catch (error) {
      if (!isBusyError(error) || attempt >= maxRetries) throw error
      await sleep(Math.min(1_500, 80 * 2 ** attempt))
    }
  }
}

async function serializeWrite(operation: () => Promise<void>): Promise<void> {
  const queued = (globalForServingCache.servingCacheWriteQueue ?? Promise.resolve())
    .catch(() => undefined)
    .then(operation)
  globalForServingCache.servingCacheWriteQueue = queued.catch(() => undefined)
  await queued
}

export function resolveServingCacheDbPath(): string {
  const configured = process.env.SERVING_CACHE_DB_PATH?.trim()
  return configured
    ? path.resolve(configured)
    : path.join(path.dirname(localDbPath), 'stockboard-serving-cache.db')
}

function resetClient(): void {
  try { globalForServingCache.servingCacheClient?.close() } catch { /* best effort */ }
  delete globalForServingCache.servingCacheClient
  delete globalForServingCache.servingCachePath
  delete globalForServingCache.servingCacheAccess
  delete globalForServingCache.servingCacheReady
}

function preparePath(dbPath: string): void {
  if (globalForServingCache.servingCachePath && globalForServingCache.servingCachePath !== dbPath) resetClient()
}

function getReadClient(): Client | null {
  const dbPath = resolveServingCacheDbPath()
  preparePath(dbPath)
  if (!globalForServingCache.servingCacheClient) {
    const client = openOptionalGuardedReadOnlyClient(dbPath, 'serving-cache-read')
    if (!client) return null
    globalForServingCache.servingCacheClient = client
    globalForServingCache.servingCachePath = dbPath
    globalForServingCache.servingCacheAccess = 'READ'
  }
  return globalForServingCache.servingCacheClient
}

function getWriteClient(): Client {
  const dbPath = resolveServingCacheDbPath()
  preparePath(dbPath)
  if (!globalForServingCache.servingCacheClient || globalForServingCache.servingCacheAccess !== 'WRITE') {
    resetClient()
    globalForServingCache.servingCacheClient = openRebuildableGuardedClient(dbPath, 'serving-cache-write')
    globalForServingCache.servingCachePath = dbPath
    globalForServingCache.servingCacheAccess = 'WRITE'
  }
  return globalForServingCache.servingCacheClient
}

async function ensureServingCacheReady(): Promise<Client> {
  if (!globalForServingCache.servingCacheReady) {
    globalForServingCache.servingCacheReady = Promise.resolve()
      .then(async () => {
        const client = getWriteClient()
        const busyTimeoutMs = Math.max(1_000, numberEnv('SERVING_CACHE_BUSY_TIMEOUT_MS', 15_000))
        await client.execute(`PRAGMA busy_timeout=${busyTimeoutMs}`)
        await client.execute('PRAGMA synchronous=NORMAL')
        await withBusyRetry(async () => {
          const journalMode = await client.execute('PRAGMA journal_mode')
          const mode = String(
            journalMode.rows[0]?.journal_mode
            ?? journalMode.rows[0]?.['journal_mode']
            ?? '',
          ).toLowerCase()
          if (mode !== 'wal') await client.execute('PRAGMA journal_mode=WAL')
        })
        await withBusyRetry(() => client.batch([
          {
            sql: `
              CREATE TABLE IF NOT EXISTS api_serving_cache (
                namespace TEXT NOT NULL,
                cache_key TEXT NOT NULL,
                payload_json TEXT NOT NULL,
                generated_at_ms INTEGER NOT NULL,
                expires_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL,
                PRIMARY KEY (namespace, cache_key)
              )
            `,
            args: [],
          },
          {
            sql: `
              CREATE INDEX IF NOT EXISTS api_serving_cache_expires_idx
              ON api_serving_cache(namespace, expires_at)
            `,
            args: [],
          },
        ]))
      })
      .catch((error) => {
        delete globalForServingCache.servingCacheReady
        throw error
      })
  }
  await globalForServingCache.servingCacheReady
  return getWriteClient()
}

export function stableCacheKey(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

export async function readServingCache<T>(
  namespace: string,
  cacheKey: string,
  ttlMs: number,
): Promise<{ payload: T; generatedAt: number } | null> {
  try {
    const client = getReadClient()
    if (!client) return null
    const minGeneratedAt = Date.now() - ttlMs
    const result = await withBusyRetry(() => client.execute({
      sql: `
        SELECT payload_json, generated_at_ms
        FROM api_serving_cache
        WHERE namespace = ?
          AND cache_key = ?
          AND generated_at_ms >= ?
          AND expires_at > ?
        LIMIT 1
      `,
      args: [namespace, cacheKey, minGeneratedAt, Math.floor(Date.now() / 1000)],
    }))
    const row = result.rows[0] as unknown as CacheRow | undefined
    if (!row) return null
    try {
      return {
        payload: JSON.parse(row.payload_json) as T,
        generatedAt: Number(row.generated_at_ms),
      }
    } catch {
      return null
    }
  } catch (error) {
    if (isBusyError(error)) {
      warnBusyOnce('read')
      return null
    }
    if (isCacheLocalFailure(error)) {
      resetClient()
      return null
    }
    throw error
  }
}

export async function writeServingCache<T>(
  namespace: string,
  cacheKey: string,
  payload: T,
  ttlMs: number,
  generatedAt = Date.now(),
): Promise<void> {
  await serializeWrite(async () => {
    try {
      const client = await ensureServingCacheReady()
      const now = Math.floor(Date.now() / 1000)
      const expiresAt = Math.floor((generatedAt + ttlMs) / 1000)
      await withBusyRetry(() => client.execute({
        sql: `
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
        args: [
          namespace,
          cacheKey,
          JSON.stringify(payload),
          generatedAt,
          expiresAt,
          now,
        ] as InValue[],
      }))

      const cleanupIntervalMs = Math.max(
        60_000,
        numberEnv('SERVING_CACHE_CLEANUP_INTERVAL_MS', 60 * 60 * 1_000),
      )
      const lastCleanupAt = globalForServingCache.servingCacheLastCleanupAt ?? 0
      if (Date.now() - lastCleanupAt < cleanupIntervalMs) return
      globalForServingCache.servingCacheLastCleanupAt = Date.now()
      try {
        await withBusyRetry(() => client.execute({
          sql: 'DELETE FROM api_serving_cache WHERE expires_at <= ?',
          args: [now],
        }))
      } catch (error) {
        if (!isBusyError(error)) throw error
        warnBusyOnce('cleanup')
      }
    } catch (error) {
      if (isBusyError(error)) {
        warnBusyOnce('write')
        return
      }
      if (isCacheLocalFailure(error)) {
        resetClient()
        return
      }
      throw error
    }
  })
}
