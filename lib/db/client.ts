// lib/db/client.ts
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import * as schema from './schema'
import path from 'path'
import fs from 'fs'

const DB_PATH = path.join(process.cwd(), 'data', 'stockboard.db')

// dataディレクトリが存在しない場合は作成
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true })

// シングルトンパターン（Next.jsのホットリロードで多重接続を防ぐ）
const globalForDb = global as unknown as { db: ReturnType<typeof drizzle> }

export const db = globalForDb.db ?? drizzle(
  new Database(DB_PATH, { verbose: process.env.NODE_ENV === 'development' ? console.log : undefined }),
  { schema }
)

if (process.env.NODE_ENV !== 'production') globalForDb.db = db

export type DB = typeof db
