// app/api/admin/db-stats/route.ts
import { NextResponse } from 'next/server'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { db } from '@/lib/db/client'
import {
  ohlcv,
  screenerSnapshots,
  hexStages,
  tvIndicators,
  practiceSessions,
  tradeRecords,
} from '@/lib/db/schema'
import { sql } from 'drizzle-orm'

export const dynamic = 'force-dynamic'

const DB_PATH = path.join(process.cwd(), 'data', 'stockboard.db')
const SNAPSHOT_DIR = path.join(process.cwd(), 'data', 'snapshots')

interface TableStat {
  name: string
  count: number
  latestDate?: string
}

async function countTable(name: string, table: any, dateColumn?: string): Promise<TableStat> {
  try {
    const countResult = (db
      .select({ c: sql<number>`count(*)` })
      .from(table)
      .all() as { c: number }[])[0]
    const count = countResult?.c ?? 0

    let latestDate: string | undefined
    if (dateColumn && count > 0) {
      const latest = (db
        .select({ d: sql<string>`max(${sql.identifier(dateColumn)})` })
        .from(table)
        .all() as { d: string | null }[])[0]
      latestDate = latest?.d ?? undefined
    }
    return { name, count, latestDate }
  } catch {
    return { name, count: 0 }
  }
}

async function getDbSize(): Promise<number> {
  try {
    const stat = await fs.stat(DB_PATH)
    return stat.size
  } catch {
    return 0
  }
}

async function listSnapshots(): Promise<string[]> {
  try {
    const files = await fs.readdir(SNAPSHOT_DIR)
    return files.filter((f) => f.endsWith('.json'))
  } catch {
    return []
  }
}

export async function GET() {
  try {
    const tables: TableStat[] = await Promise.all([
      countTable('ohlcv', ohlcv, 'date'),
      countTable('screener_snapshots', screenerSnapshots, 'date'),
      countTable('hex_stages', hexStages, 'date'),
      countTable('tv_indicators', tvIndicators, 'date'),
      countTable('practice_sessions', practiceSessions),
      countTable('trade_records', tradeRecords),
    ])

    const totalCount = tables.reduce((sum, t) => sum + t.count, 0)
    const dbSize = await getDbSize()
    const snapshots = await listSnapshots()

    return NextResponse.json({
      tables,
      totalRecords: totalCount,
      dbPath: DB_PATH,
      dbSizeBytes: dbSize,
      dbSizeMB: (dbSize / 1024 / 1024).toFixed(2),
      snapshotFiles: snapshots,
      snapshotCount: snapshots.length,
    })
  } catch (error) {
    console.error('DB stats API error:', error)
    return NextResponse.json(
      { error: 'Failed to get DB stats', message: (error as Error).message },
      { status: 500 },
    )
  }
}
