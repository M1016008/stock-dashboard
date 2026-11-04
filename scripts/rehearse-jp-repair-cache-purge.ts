import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
// @ts-expect-error Node 24 ships node:sqlite; the repository pins older Node type declarations.
import { DatabaseSync } from 'node:sqlite'

type CacheRow = { cacheKey: string; payloadJson: string; computedAt: number }

function argument(name: string): string {
  const index = process.argv.indexOf(name)
  const value = index >= 0 ? process.argv[index + 1] : null
  if (!value) throw new Error(`missing ${name}`)
  return value
}

function optionalArgument(name: string): string | null {
  const index = process.argv.indexOf(name)
  const value = index >= 0 ? process.argv[index + 1] : null
  return value ? path.resolve(value) : null
}

const JP_SOURCE_CACHE_NAMESPACES = [
  'ml_pattern_search_v1',
  'historical_analogs_period_v13',
  'backtest_coverage_v2',
  'screener_built_rows_v3',
  'period-explorer',
] as const

function hashRows(rows: readonly string[]): string {
  const hash = createHash('sha256')
  for (const row of [...rows].sort()) hash.update(`${row}\n`)
  return hash.digest('hex')
}

function jpDate(cacheKey: string): string | null {
  if (!cacheKey.startsWith('v5|')) return null
  return cacheKey.split('|').find((part) => part.startsWith('jp:'))?.slice(3) ?? null
}

function main(): void {
  const databasePath = path.resolve(argument('--database'))
  const outputPath = path.resolve(argument('--output'))
  const apiServingCachePath = optionalArgument('--api-serving-cache')
  const targetDate = argument('--target-date')
  const apply = process.argv.includes('--apply')
  if (apply && process.env.JP_REPAIR_REHEARSAL !== '1') {
    throw new Error('cache mutation is restricted to an explicitly isolated rehearsal')
  }
  const db = new DatabaseSync(databasePath, { readOnly: !apply })
  try {
    const dashboardRows = db.prepare(`
      SELECT date || '|' || payload_json AS value
      FROM dashboard_cache WHERE date >= ? ORDER BY date
    `).all(targetDate) as Array<{ value: string }>
    const cacheRows = db.prepare(`
      SELECT cache_key AS cacheKey,payload_json AS payloadJson,computed_at AS computedAt
      FROM dashboard_trade_signal_cache ORDER BY cache_key
    `).all() as CacheRow[]
    const tradeRows = cacheRows.filter((row) => {
      const date = jpDate(row.cacheKey)
      return date != null && date !== 'none' && date >= targetDate
    })
    const generationBoundJpRows = cacheRows.filter((row) => (
      row.cacheKey.startsWith('two-year-line-serving%3Av1:JP:')
    ))
    if (apply) {
      db.exec('BEGIN IMMEDIATE')
      try {
        db.prepare('DELETE FROM dashboard_cache WHERE date >= ?').run(targetDate)
        const remove = db.prepare('DELETE FROM dashboard_trade_signal_cache WHERE cache_key=?')
        for (const row of tradeRows) remove.run(row.cacheKey)
        const dashboardRemaining = Number((db.prepare(
          'SELECT COUNT(*) AS count FROM dashboard_cache WHERE date >= ?',
        ).get(targetDate) as { count: number }).count)
        const keyRemaining = tradeRows.filter((row) => db.prepare(
          'SELECT 1 FROM dashboard_trade_signal_cache WHERE cache_key=?',
        ).get(row.cacheKey)).length
        if (dashboardRemaining !== 0 || keyRemaining !== 0) {
          throw new Error(`cache purge verification failed: dashboard=${dashboardRemaining}, keys=${keyRemaining}`)
        }
        db.exec('COMMIT')
      } catch (error) {
        try { db.exec('ROLLBACK') } catch { /* preserve the original error */ }
        throw error
      }
    }
    let apiServingCache: null | {
      path: string
      deleted: number
      remaining: number
      remainingNamespaces: string[]
    } = null
    if (apiServingCachePath) {
      const cache = new DatabaseSync(apiServingCachePath, { readOnly: !apply })
      try {
        const exists = cache.prepare(
          "SELECT 1 FROM sqlite_master WHERE type='table' AND name='api_serving_cache'",
        ).get()
        if (!exists) throw new Error('api serving cache table is missing')
        const placeholders = JP_SOURCE_CACHE_NAMESPACES.map(() => '?').join(',')
        const before = Number((cache.prepare(
          `SELECT COUNT(*) AS count FROM api_serving_cache WHERE namespace IN (${placeholders})`,
        ).get(...JP_SOURCE_CACHE_NAMESPACES) as { count: number }).count)
        if (apply) {
          cache.exec('BEGIN IMMEDIATE')
          try {
            cache.prepare(`DELETE FROM api_serving_cache WHERE namespace IN (${placeholders})`)
              .run(...JP_SOURCE_CACHE_NAMESPACES)
            cache.exec('COMMIT')
          } catch (error) {
            try { cache.exec('ROLLBACK') } catch { /* preserve the original error */ }
            throw error
          }
        }
        const remaining = Number((cache.prepare(
          `SELECT COUNT(*) AS count FROM api_serving_cache WHERE namespace IN (${placeholders})`,
        ).get(...JP_SOURCE_CACHE_NAMESPACES) as { count: number }).count)
        const remainingNamespaces = (cache.prepare(
          'SELECT DISTINCT namespace FROM api_serving_cache ORDER BY namespace',
        ).all() as Array<{ namespace: string }>).map((row) => row.namespace)
        if (apply && remaining !== 0) throw new Error('JP API serving cache purge is incomplete')
        apiServingCache = {
          path: fs.realpathSync(apiServingCachePath),
          deleted: apply ? before : 0,
          remaining,
          remainingNamespaces,
        }
      } finally {
        cache.close()
      }
    }
    const receipt = {
      version: 1,
      status: 'PASS',
      mode: apply ? 'APPLY_REHEARSAL' : 'READ_ONLY_AUDIT',
      createdAt: new Date().toISOString(),
      database: fs.realpathSync(databasePath),
      targetDate,
      dashboardRows: dashboardRows.length,
      dashboardRowsSha256: hashRows(dashboardRows.map((row) => row.value)),
      reachableTradeSignalKeys: tradeRows.map((row) => row.cacheKey),
      reachableTradeSignalRowsSha256: hashRows(tradeRows.map((row) => (
        `${row.cacheKey}|${row.payloadJson}|${row.computedAt}`
      ))),
      generationBoundJpRowsObserved: generationBoundJpRows.length,
      generationBoundJpRowsDeleted: 0,
      apiServingCache,
    }
    fs.writeFileSync(outputPath, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 })
    console.log(JSON.stringify(receipt, null, 2))
  } finally {
    db.close()
  }
}

main()
