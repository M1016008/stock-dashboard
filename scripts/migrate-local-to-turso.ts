// scripts/migrate-local-to-turso.ts
// 既存のローカル SQLite (data/stockboard.db) のデータを
// Turso (libsql) に移行するワンショットスクリプト。
//
// 使い方:
//   1. .env.local に TURSO_DATABASE_URL / TURSO_AUTH_TOKEN を設定
//   2. npx tsx scripts/migrate-local-to-turso.ts
//
// 注意:
//   - 既存ローカル DB は file:./data/stockboard.db を直接 libsql で開く
//   - すべてのテーブルを `INSERT OR REPLACE` で転送
//   - 既に Turso 側にデータがある場合は (date, ticker) 等のキーで上書き

import { createClient } from '@libsql/client'
import path from 'path'
import fs from 'fs'

const LOCAL_DB = path.join(process.cwd(), 'data', 'stockboard.db')
const REMOTE_URL = process.env.TURSO_DATABASE_URL
const REMOTE_TOKEN = process.env.TURSO_AUTH_TOKEN

if (!REMOTE_URL) {
  console.error('TURSO_DATABASE_URL が未設定です。.env.local に設定してください。')
  process.exit(1)
}
if (!fs.existsSync(LOCAL_DB)) {
  console.error(`ローカル DB が見つかりません: ${LOCAL_DB}`)
  console.error('ローカルデータが無ければ、移行スクリプトは不要です。')
  process.exit(1)
}

const local = createClient({ url: `file:${LOCAL_DB}` })
const remote = createClient({ url: REMOTE_URL, authToken: REMOTE_TOKEN })

const TABLES = [
  'ohlcv',
  'hex_stages',
  'tv_indicators',
  'tv_daily_snapshots',
  'csv_imports',
]

async function copyTable(name: string): Promise<number> {
  const exists = await local.execute(
    `SELECT name FROM sqlite_master WHERE type='table' AND name = ?`,
    [name],
  )
  if (exists.rows.length === 0) {
    console.log(`  - ${name}: テーブルが存在しません (skip)`)
    return 0
  }

  const rows = await local.execute(`SELECT * FROM ${name}`)
  if (rows.rows.length === 0) {
    console.log(`  - ${name}: 0 行 (skip)`)
    return 0
  }

  const cols = rows.columns
  const placeholders = cols.map(() => '?').join(', ')
  const sql = `INSERT OR REPLACE INTO ${name} (${cols.join(', ')}) VALUES (${placeholders})`

  const CHUNK = 200
  let inserted = 0
  for (let i = 0; i < rows.rows.length; i += CHUNK) {
    const slice = rows.rows.slice(i, i + CHUNK)
    await remote.batch(
      slice.map((r) => ({
        sql,
        args: cols.map((c) => (r as unknown as Record<string, unknown>)[c]) as never[],
      })),
    )
    inserted += slice.length
    process.stdout.write(`\r  - ${name}: ${inserted}/${rows.rows.length}`)
  }
  process.stdout.write('\n')
  return inserted
}

async function main() {
  console.log(`移行元: ${LOCAL_DB}`)
  console.log(`移行先: ${REMOTE_URL}`)
  console.log('---')

  let total = 0
  for (const t of TABLES) {
    try {
      total += await copyTable(t)
    } catch (e) {
      console.error(`  - ${t}: エラー`, (e as Error).message)
    }
  }

  console.log('---')
  console.log(`完了: 合計 ${total} 行を Turso に転送しました`)
  process.exit(0)
}

main().catch((e) => {
  console.error('migration failed:', e)
  process.exit(1)
})
