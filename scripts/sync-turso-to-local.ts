// scripts/sync-turso-to-local.ts
//
// Turso 本番のデータをローカル SQLite (./data/stockboard.db) にコピーする。
// 用途: Turso 書込みクォータ超過時に、ローカルで計算を続けるため。
//
// 使い方:
//   tsx --env-file=.env.local scripts/sync-turso-to-local.ts          # 全テーブル
//   TABLES=ohlcv_daily,ticker_universe tsx --env-file=.env.local scripts/sync-turso-to-local.ts
//
// 動作:
//   - ローカル DB に Phase 2 テーブルを CREATE TABLE IF NOT EXISTS
//   - 各テーブルについて Turso から SELECT、ローカルへ INSERT OR REPLACE
//   - 大量データは offset/limit ページングで取得

import { createClient } from '@libsql/client'
import { ensureSchema } from '@/lib/db/migrate'
import path from 'node:path'
import fs from 'node:fs'

const TURSO_URL = process.env.TURSO_DATABASE_URL
const TURSO_TOKEN = process.env.TURSO_AUTH_TOKEN
const LOCAL_DB = path.join(process.cwd(), 'data', 'stockboard.db')

if (!TURSO_URL) {
  console.error('TURSO_DATABASE_URL が未設定です。.env.local が読まれていない可能性。')
  process.exit(1)
}

// data ディレクトリを先に作る
fs.mkdirSync(path.dirname(LOCAL_DB), { recursive: true })

const turso = createClient({ url: TURSO_URL, authToken: TURSO_TOKEN })
const local = createClient({ url: `file:${LOCAL_DB}` })

// テーブルごとのコピー定義
interface TableSpec {
  name: string
  columns: string[]
  pageSize: number   // SELECT 1ページのサイズ
}

const DEFAULT_TABLES: TableSpec[] = [
  {
    name: 'ticker_universe',
    columns: ['ticker', 'name', 'active', 'added_at'],
    pageSize: 5000,
  },
  {
    name: 'ohlcv_daily',
    columns: ['ticker', 'date', 'open', 'high', 'low', 'close', 'volume'],
    pageSize: 5000,
  },
  {
    name: 'daily_snapshots',
    columns: [
      'ticker', 'date',
      'ma_5', 'ma_25', 'ma_75', 'ma_150', 'ma_300',
      'weekly_ma_5', 'weekly_ma_13', 'weekly_ma_25', 'weekly_ma_50', 'weekly_ma_100',
      'monthly_ma_3', 'monthly_ma_5', 'monthly_ma_10', 'monthly_ma_20', 'monthly_ma_25',
      'daily_a_stage', 'daily_b_stage',
      'weekly_a_stage', 'weekly_b_stage',
      'monthly_a_stage', 'monthly_b_stage',
      'computed_at',
    ],
    pageSize: 2000,  // 列数が多いので少なめ
  },
]

async function copyTable(spec: TableSpec) {
  console.log(`\n─── ${spec.name} ───`)

  // 件数確認
  const countRes = await turso.execute(`SELECT COUNT(*) AS c FROM ${spec.name}`)
  const total = Number((countRes.rows[0] as any).c ?? 0)
  if (total === 0) {
    console.log(`(Turso 側に行なし、スキップ)`)
    return
  }
  console.log(`Turso 件数: ${total.toLocaleString()}`)

  const colList = spec.columns.map(c => `"${c}"`).join(', ')
  const placeholders = spec.columns.map(() => '?').join(', ')
  const insertSql = `INSERT OR REPLACE INTO "${spec.name}" (${colList}) VALUES (${placeholders})`

  let offset = 0
  let imported = 0
  const startTime = Date.now()

  while (offset < total) {
    // Turso から1ページ取得
    const page = await turso.execute({
      sql: `SELECT ${colList} FROM ${spec.name} ORDER BY rowid LIMIT ? OFFSET ?`,
      args: [spec.pageSize, offset],
    })

    if (page.rows.length === 0) break

    // ローカルへバッチ INSERT (batch でまとめて投入)
    const stmts = page.rows.map(row => ({
      sql: insertSql,
      args: spec.columns.map(c => (row as any)[c] ?? null),
    }))
    await local.batch(stmts, 'write')

    imported += page.rows.length
    offset += spec.pageSize

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1)
    const pct = ((imported / total) * 100).toFixed(1)
    console.log(`  ${imported.toLocaleString()} / ${total.toLocaleString()} (${pct}%) — ${elapsed}s`)
  }

  console.log(`✓ ${spec.name}: ${imported.toLocaleString()} 行 (${((Date.now() - startTime) / 1000).toFixed(1)}s)`)
}

async function main() {
  console.log(`Sync: ${TURSO_URL} → file:${LOCAL_DB}`)

  // ローカル DB にスキーマを用意
  await ensureSchema(local)
  console.log('ローカル DB スキーマ OK')

  // フィルタ
  const filter = process.env.TABLES?.split(',').map(s => s.trim()).filter(Boolean)
  const tables = filter
    ? DEFAULT_TABLES.filter(t => filter.includes(t.name))
    : DEFAULT_TABLES

  for (const spec of tables) {
    await copyTable(spec)
  }

  console.log('\n完了')
}

main().catch(err => {
  console.error('Fatal:', err)
  process.exit(1)
})
