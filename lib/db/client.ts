// lib/db/client.ts
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import * as schema from './schema'
import { ensureSchema } from './migrate'
import path from 'path'
import fs from 'fs'

const DB_PATH = path.join(process.cwd(), 'data', 'stockboard.db')

// dataディレクトリが存在しない場合は作成
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true })

// シングルトンパターン（Next.jsのホットリロードで多重接続を防ぐ）
const globalForDb = global as unknown as { db: ReturnType<typeof drizzle>; sqlite: Database.Database }

function buildClient() {
  const sqlite = new Database(DB_PATH)
  ensureSchema(sqlite)
  return { sqlite, drizzleDb: drizzle(sqlite, { schema }) }
}

let clientPair = globalForDb.db
  ? { sqlite: globalForDb.sqlite, drizzleDb: globalForDb.db }
  : buildClient()

if (process.env.NODE_ENV !== 'production') {
  globalForDb.db = clientPair.drizzleDb
  globalForDb.sqlite = clientPair.sqlite
}

export const db = clientPair.drizzleDb
export const sqlite = clientPair.sqlite
export type DB = typeof db
