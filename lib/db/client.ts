// lib/db/client.ts
// Turso (libsql) ベースの DB クライアント。
//
// 接続先は環境変数で切替:
//   - TURSO_DATABASE_URL が設定されていれば Turso (cloud)
//   - USE_LOCAL_DB=1 の場合は Turso を無視してローカルファイル
//   - STOCKBOARD_DB_PATH があればその SQLite を使う
//   - 未設定なら ./data/stockboard.db (ローカルファイル)
//
// すべての DB アクセスは非同期 (await) で行う。
// 既存の sqlite.prepare(...) パターンを await client.execute(...) に置換。

import { createClient, type Client, type InValue } from '@libsql/client'
import { drizzle } from 'drizzle-orm/libsql'
import * as schema from './schema'
import { ensureSchema } from './migrate'
import path from 'path'
import fs from 'fs'

const TURSO_URL = process.env.TURSO_DATABASE_URL
const TURSO_TOKEN = process.env.TURSO_AUTH_TOKEN
// USE_LOCAL_DB=1 で Turso を無視してローカル DB を強制 (バッチ用)
const FORCE_LOCAL = process.env.USE_LOCAL_DB === '1'

const configuredLocalDbPath =
  process.env.STOCKBOARD_DB_ROLE === 'us-analytics' && process.env.US_ANALYTICS_DB_PATH
    ? process.env.US_ANALYTICS_DB_PATH
    : process.env.STOCKBOARD_DB_PATH || process.env.LOCAL_DB_PATH
export const localDbPath = configuredLocalDbPath
  ? path.resolve(configuredLocalDbPath)
  : path.join(process.cwd(), 'data', 'stockboard.db')

function buildClientUrl(): { url: string; authToken?: string; isCloud: boolean } {
  if (TURSO_URL && !FORCE_LOCAL) {
    return { url: TURSO_URL, authToken: TURSO_TOKEN, isCloud: true }
  }
  // ローカルファイル。dataディレクトリを先に作る
  fs.mkdirSync(path.dirname(localDbPath), { recursive: true })
  return { url: `file:${localDbPath}`, isCloud: false }
}

const cfg = buildClientUrl()

// シングルトン (Next.js のホットリロードで多重接続を防ぐ)
const globalForDb = global as unknown as {
  libsql?: Client
  schemaReady?: Promise<void>
  sqlitePragmasReady?: Promise<void>
}

export const client: Client =
  globalForDb.libsql ??
  createClient({ url: cfg.url, authToken: cfg.authToken })

if (process.env.NODE_ENV !== 'production') globalForDb.libsql = client

export const db = drizzle(client, { schema })
export const isCloud = cfg.isCloud

async function ensureLocalSqlitePragmas(): Promise<void> {
  if (cfg.isCloud) return
  if (!globalForDb.sqlitePragmasReady) {
    globalForDb.sqlitePragmasReady = Promise.resolve()
      .then(async () => {
        await client.execute('PRAGMA synchronous=NORMAL')
        await client.execute('PRAGMA busy_timeout=60000')
        const journalMode = await client.execute('PRAGMA journal_mode')
        const mode = String(
          journalMode.rows[0]?.journal_mode
          ?? journalMode.rows[0]?.['journal_mode']
          ?? '',
        ).toLowerCase()
        if (mode !== 'wal') await client.execute('PRAGMA journal_mode=WAL')
      })
      .catch((e) => {
        delete globalForDb.sqlitePragmasReady
        throw e
      })
  }
  await globalForDb.sqlitePragmasReady
}

/**
 * スキーマ初期化を 1 回だけ走らせる。
 * 各 API ルートで `await ensureReady()` を呼ぶことでテーブル存在を担保する。
 */
export async function ensureReady(): Promise<void> {
  await ensureLocalSqlitePragmas()
  if (process.env.SKIP_SCHEMA_ENSURE === '1') return
  if (!globalForDb.schemaReady) {
    globalForDb.schemaReady = ensureSchema(client).catch((e) => {
      // 失敗時はキャッシュをクリアして次回再試行できるようにする
      delete globalForDb.schemaReady
      throw e
    })
  }
  return globalForDb.schemaReady
}

// ─────────────────────────────────────────────────────────
// 簡易クエリヘルパ。raw SQL を扱う場面で利用。
// ─────────────────────────────────────────────────────────

export type Args = readonly InValue[]

function isBusyError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /SQLITE_BUSY|database is locked/i.test(message)
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function withBusyRetry<T>(fn: () => Promise<T>): Promise<T> {
  const max = Number(process.env.SQLITE_BUSY_RETRIES ?? 8)
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn()
    } catch (error) {
      if (!isBusyError(error) || attempt >= max) throw error
      await sleep(Math.min(2500, 120 * 2 ** attempt))
    }
  }
}

export async function execAll<T = Record<string, unknown>>(sql: string, args: Args = []): Promise<T[]> {
  await ensureReady()
  const res = await withBusyRetry(() => client.execute({ sql, args: args as InValue[] }))
  return res.rows.map((row) => ({ ...row })) as unknown as T[]
}

export async function execGet<T = Record<string, unknown>>(sql: string, args: Args = []): Promise<T | undefined> {
  const rows = await execAll<T>(sql, args)
  return rows[0]
}

export async function execRun(sql: string, args: Args = []): Promise<void> {
  await ensureReady()
  await withBusyRetry(() => client.execute({ sql, args: args as InValue[] }))
}

export async function execBatch(stmts: { sql: string; args?: Args }[]): Promise<void> {
  await ensureReady()
  await withBusyRetry(() => client.batch(
    stmts.map((s) => ({ sql: s.sql, args: (s.args ?? []) as InValue[] })),
  ),
  )
}

export type DB = typeof db
