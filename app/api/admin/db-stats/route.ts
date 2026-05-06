// app/api/admin/db-stats/route.ts
import { NextResponse } from 'next/server'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { execGet, isCloud } from '@/lib/db/client'

export const dynamic = 'force-dynamic'

const LOCAL_DB_PATH = path.join(process.cwd(), 'data', 'stockboard.db')
const SNAPSHOT_DIR = path.join(process.cwd(), 'data', 'snapshots')

interface TableStat {
  name: string
  count: number
  latestDate?: string
}

async function countTable(name: string, dateColumn?: string): Promise<TableStat> {
  try {
    const countRes = await execGet<{ c: number }>(`SELECT COUNT(*) AS c FROM ${name}`)
    const count = countRes?.c ?? 0
    let latestDate: string | undefined
    if (dateColumn && count > 0) {
      const r = await execGet<{ d: string | null }>(`SELECT MAX(${dateColumn}) AS d FROM ${name}`)
      latestDate = r?.d ?? undefined
    }
    return { name, count, latestDate }
  } catch {
    return { name, count: 0 }
  }
}

async function getLocalDbSize(): Promise<number> {
  try {
    const stat = await fs.stat(LOCAL_DB_PATH)
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
      countTable('ohlcv', 'date'),
      countTable('hex_stages', 'date'),
      countTable('tv_indicators', 'date'),
      countTable('tv_daily_snapshots', 'date'),
      countTable('csv_imports', 'date'),
    ])

    const totalCount = tables.reduce((sum, t) => sum + t.count, 0)
    const dbSize = isCloud ? 0 : await getLocalDbSize()
    const snapshots = await listSnapshots()

    return NextResponse.json({
      tables,
      totalRecords: totalCount,
      dbPath: isCloud ? 'Turso (cloud)' : LOCAL_DB_PATH,
      dbSizeBytes: dbSize,
      dbSizeMB: (dbSize / 1024 / 1024).toFixed(2),
      isCloud,
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
