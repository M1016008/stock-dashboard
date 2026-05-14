// lib/db/client.ts
// Turso (libsql) ベースの DB クライアント。
//
// 接続先は環境変数で切替:
//   - TURSO_DATABASE_URL が設定されていれば Turso (cloud)
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

const LOCAL_DB_PATH = path.join(process.cwd(), 'data', 'stockboard.db')

function buildClientUrl(): { url: string; authToken?: string; isCloud: boolean } {
  if (TURSO_URL && !FORCE_LOCAL) {
    return { url: TURSO_URL, authToken: TURSO_TOKEN, isCloud: true }
  }
  // ローカルファイル。dataディレクトリを先に作る
  fs.mkdirSync(path.dirname(LOCAL_DB_PATH), { recursive: true })
  return { url: `file:${LOCAL_DB_PATH}`, isCloud: false }
}

const cfg = buildClientUrl()

// シングルトン (Next.js のホットリロードで多重接続を防ぐ)
const globalForDb = global as unknown as {
  libsql?: Client
  schemaReady?: Promise<void>
}

export const client: Client =
  globalForDb.libsql ??
  createClient({ url: cfg.url, authToken: cfg.authToken })

if (process.env.NODE_ENV !== 'production') globalForDb.libsql = client

export const db = drizzle(client, { schema })
export const isCloud = cfg.isCloud

/**
 * スキーマ初期化を 1 回だけ走らせる。
 * 各 API ルートで `await ensureReady()` を呼ぶことでテーブル存在を担保する。
 */
export async function ensureReady(): Promise<void> {
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

export async function execAll<T = Record<string, unknown>>(sql: string, args: Args = []): Promise<T[]> {
  await ensureReady()
  const res = await client.execute({ sql, args: args as InValue[] })
  return res.rows as unknown as T[]
}

export async function execGet<T = Record<string, unknown>>(sql: string, args: Args = []): Promise<T | undefined> {
  const rows = await execAll<T>(sql, args)
  return rows[0]
}

export async function execRun(sql: string, args: Args = []): Promise<void> {
  await ensureReady()
  await client.execute({ sql, args: args as InValue[] })
}

export async function execBatch(stmts: { sql: string; args?: Args }[]): Promise<void> {
  await ensureReady()
  await client.batch(
    stmts.map((s) => ({ sql: s.sql, args: (s.args ?? []) as InValue[] })),
  )
}

export type DB = typeof db
