// app/api/admin/db-stats/route.ts
import { NextResponse } from 'next/server'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { execGet, isCloud, localDbPath } from '@/lib/db/client'

export const dynamic = 'force-dynamic'

const SNAPSHOT_DIR = path.join(process.cwd(), 'data', 'snapshots')

interface TableStat {
  name: string
  count: number
  latestDate?: string
  estimated?: boolean
}

async function countTable(name: string, dateColumn?: string, latestSql?: string): Promise<TableStat> {
  try {
    const countRes = await execGet<{ c: number }>(`SELECT COUNT(*) AS c FROM ${name}`)
    const count = countRes?.c ?? 0
    let latestDate: string | undefined
    if (dateColumn && count > 0) {
      const r = await execGet<{ d: string | null }>(
        latestSql ?? `SELECT ${dateColumn} AS d FROM ${name} ORDER BY ${dateColumn} DESC LIMIT 1`,
      )
      latestDate = r?.d ?? undefined
    }
    return { name, count, latestDate, estimated: false }
  } catch {
    return { name, count: 0, estimated: false }
  }
}

async function estimateTable(name: string, dateColumn?: string, latestSql?: string): Promise<TableStat> {
  try {
    const statRes = await execGet<{ stat: string | null }>(
      `
      SELECT stat
      FROM sqlite_stat1
      WHERE tbl = ?
      ORDER BY CASE WHEN idx LIKE 'sqlite_autoindex_%' THEN 0 ELSE 1 END
      LIMIT 1
      `,
      [name],
    )
    const estimated = Number(statRes?.stat?.split(/\s+/)[0])
    const usedEstimate = Number.isFinite(estimated) && estimated > 0
    const count = usedEstimate ? estimated : (await countTable(name)).count
    let latestDate: string | undefined
    if (dateColumn && count > 0) {
      const r = await execGet<{ d: string | null }>(
        latestSql ?? `SELECT ${dateColumn} AS d FROM ${name} ORDER BY ${dateColumn} DESC LIMIT 1`,
      )
      latestDate = r?.d ?? undefined
    }
    return { name, count, latestDate, estimated: usedEstimate }
  } catch {
    return countTable(name, dateColumn)
  }
}

async function getLocalDbSize(): Promise<number> {
  try {
    const stat = await fs.stat(localDbPath)
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
      countTable('ticker_universe'),
      estimateTable('ohlcv_daily', 'date'),
      estimateTable('daily_snapshots', 'date'),
      countTable('serving_daily_snapshot_dates', 'date'),
      estimateTable('ml_feature_vectors_v2', 'date'),
      countTable('serving_ml_physics_candidates', 'as_of_date'),
      countTable('serving_backtest_summaries', 'date'),
      countTable('market_universe'),
      estimateTable(
        'market_ohlcv_daily',
        'date',
        `SELECT date AS d
         FROM market_ohlcv_daily INDEXED BY market_ohlcv_market_date_idx
         WHERE market = 'US'
         ORDER BY date DESC
         LIMIT 1`,
      ),
      estimateTable(
        'market_daily_snapshots',
        'date',
        `SELECT date AS d
         FROM market_daily_snapshots INDEXED BY market_snapshots_market_date_idx
         WHERE market = 'US'
         ORDER BY date DESC
         LIMIT 1`,
      ),
      countTable('sector_etf_holdings', 'as_of_date'),
      countTable('earnings_calendar', 'announce_date'),
    ])

    const totalCount = tables.reduce((sum, t) => sum + t.count, 0)
    const dbSize = isCloud ? 0 : await getLocalDbSize()
    const snapshots = await listSnapshots()

    return NextResponse.json({
      tables,
      totalRecords: totalCount,
      totalRecordsEstimated: tables.some((table) => table.estimated),
      dbPath: isCloud ? 'Turso (cloud)' : localDbPath,
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
