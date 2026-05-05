// lib/db/client.ts
import { createClient } from '@libsql/client'
import { drizzle } from 'drizzle-orm/libsql'
import * as schema from './schema'

const url = process.env.TURSO_DATABASE_URL
const authToken = process.env.TURSO_AUTH_TOKEN

if (!url) {
  throw new Error(
    'TURSO_DATABASE_URL is not set. Copy .env.local.example to .env.local and fill in your Turso credentials.',
  )
}

// libsql:// (remote) と file: (ローカル) のどちらにも対応する。
// remote では authToken が必須、ローカルファイルでは不要。
const isRemote = url.startsWith('libsql://') || url.startsWith('https://') || url.startsWith('wss://')
if (isRemote && !authToken) {
  throw new Error('TURSO_AUTH_TOKEN is required when using a remote Turso URL.')
}

// Next.js のホットリロードで多重接続を防ぐためのシングルトン。
const globalForDb = global as unknown as { db?: ReturnType<typeof drizzle> }

export const db =
  globalForDb.db ??
  drizzle(createClient({ url, authToken }), { schema })

if (process.env.NODE_ENV !== 'production') globalForDb.db = db

export type DB = typeof db
