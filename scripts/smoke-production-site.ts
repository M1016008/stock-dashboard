import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

type CheckKind = 'html' | 'json'

type Check = {
  name: string
  path: string
  kind: CheckKind
  requiredPaths?: string[]
  nonEmptyPaths?: string[]
}

type CheckResult = {
  name: string
  path: string
  ok: boolean
  status: number | null
  elapsedMs: number
  bytes: number
  error: string | null
}

const baseUrl = (process.env.STOCKBOARD_SMOKE_BASE_URL ?? 'http://127.0.0.1:3000').replace(/\/+$/, '')
const timeoutMs = Math.max(5_000, Number(process.env.STOCKBOARD_SMOKE_TIMEOUT_MS ?? 45_000))
const supportDir = path.join(os.homedir(), 'Library', 'Application Support', 'StockBoard')
const reportPath = process.env.STOCKBOARD_SMOKE_REPORT_PATH
  ?? path.join(supportDir, 'production-smoke-latest.json')

const pages: Check[] = [
  '/',
  '/admin/db',
  '/admin/sector-master',
  '/ai/ma-lens',
  '/ai/research',
  '/ai/transitions',
  '/backtest',
  '/chart-drill',
  '/commodities',
  '/commodities/jp/1328',
  '/commodities/screener',
  '/custom-charts',
  '/earnings',
  '/hex-stage',
  '/market-momentum',
  '/materials',
  '/screener',
  '/sector-etfs',
  '/sector-etfs/1617',
  '/sectors',
  '/stage-screener',
  '/stock/7003',
  `/themes/${encodeURIComponent('フィジカルAI')}`,
  '/themes',
  '/trade/workbench',
  '/us',
  '/us/analysis/backtest',
  '/us/analysis/ml-lens',
  '/us/analysis/transitions',
  '/us/screener',
  '/us/stage-screener',
  '/us/stock/AAPL',
  '/watchlist',
].map((pagePath) => ({ name: `page ${pagePath}`, path: pagePath, kind: 'html' }))

const apiChecks: Check[] = [
  { name: 'health', path: '/api/health', kind: 'json', requiredPaths: ['status'] },
  {
    name: 'freshness overview',
    path: '/api/status/overview',
    kind: 'json',
    requiredPaths: ['jp.price', 'jp.pms', 'us.price', 'us.pms', 'sources.themes.updatedAt'],
  },
  { name: 'assistant status', path: '/api/assistant/status', kind: 'json' },
  { name: 'admin batch runs', path: '/api/admin/batch/runs', kind: 'json' },
  { name: 'admin db stats', path: '/api/admin/db-stats', kind: 'json' },
  { name: 'sector diagnostics', path: '/api/admin/sector-master/diagnostics', kind: 'json' },
  { name: 'sector master admin', path: '/api/admin/sector-master', kind: 'json' },
  { name: 'universe admin', path: '/api/admin/universe?limit=5', kind: 'json' },
  { name: 'update status', path: '/api/admin/update-latest', kind: 'json' },
  { name: 'dashboard dates', path: '/api/dashboard/dates?limit=5', kind: 'json', nonEmptyPaths: ['dates'] },
  { name: 'material news', path: '/api/dashboard/kabutan-material-news?limit=5', kind: 'json' },
  { name: 'new high volume', path: '/api/dashboard/new-high-volume?date=2026-07-24', kind: 'json' },
  { name: 'themes', path: '/api/kabutan-themes?limit=5', kind: 'json' },
  { name: 'earnings calendar', path: '/api/earnings-calendar?days=30&limit=5', kind: 'json' },
  { name: 'JP quote', path: '/api/quote/7003', kind: 'json' },
  { name: 'JP history', path: '/api/history/7003?period=1y&meta=1', kind: 'json' },
  { name: 'JP overview', path: '/api/stock-overview/7003', kind: 'json' },
  { name: 'JP snapshot', path: '/api/stock-snapshot/7003', kind: 'json' },
  { name: 'JP margin', path: '/api/stock-margin/7003', kind: 'json' },
  { name: 'JP physical momentum', path: '/api/physical-momentum/7003?market=JP&limit=20', kind: 'json' },
  { name: 'JP physical plan', path: '/api/stock-physical-plan/7003?market=JP', kind: 'json' },
  {
    name: 'JP analysis review',
    path: '/api/stock-analysis-review/7003?market=JP&date=2026-07-24',
    kind: 'json',
  },
  { name: 'JP move periods', path: '/api/stock-move-periods/7003?market=JP&limit=3', kind: 'json' },
  {
    name: 'JP scenario projections',
    path: '/api/stock-scenario-projections/7003?market=JP&interval=daily&limit=3&llm=0',
    kind: 'json',
  },
  { name: 'JP stage history', path: '/api/stage-history/7003?market=JP&granularity=daily&count=20', kind: 'json' },
  { name: 'JP search', path: '/api/search?q=7003', kind: 'json' },
  { name: 'JP screener', path: '/api/screener?limit=5', kind: 'json' },
  { name: 'sector ETFs', path: '/api/sector-etfs', kind: 'json' },
  { name: 'sector ETF detail', path: '/api/sector-etfs/1617', kind: 'json' },
  { name: 'sector master', path: '/api/sector-master/7003', kind: 'json' },
  { name: 'JP hex dates', path: '/api/hex/available-dates?limit=5', kind: 'json', nonEmptyPaths: ['dates'] },
  { name: 'JP hex', path: '/api/hex?timeframe=daily', kind: 'json' },
  { name: 'commodities', path: '/api/commodities', kind: 'json', nonEmptyPaths: ['metrics'] },
  { name: 'commodity detail', path: '/api/commodities/jp/1328', kind: 'json' },
  { name: 'commodity screener', path: '/api/commodities/screener?limit=5', kind: 'json' },
  { name: 'custom charts', path: '/api/custom-charts', kind: 'json' },
  { name: 'custom chart symbols', path: '/api/custom-charts/symbols?q=7003', kind: 'json' },
  { name: 'custom chart FX', path: '/api/custom-charts/fx-rates', kind: 'json' },
  { name: 'backtest coverage', path: '/api/backtest/coverage?horizon=40', kind: 'json' },
  { name: 'backtest dates', path: '/api/backtest/dates?horizon=40', kind: 'json', nonEmptyPaths: ['dates'] },
  { name: 'backtest query', path: '/api/backtest/query?date=2026-05-27&horizon=40&limit=5', kind: 'json' },
  { name: 'backtest signals', path: '/api/backtest/signals?date=2026-05-27&limit=5', kind: 'json' },
  { name: 'backtest similar', path: '/api/backtest/similar?ticker=7003&date=2026-05-27', kind: 'json' },
  {
    name: 'backtest detail',
    path: '/api/backtest/detail?ticker=7003&date=2026-05-27&horizon=40&move=up',
    kind: 'json',
  },
  {
    name: 'backtest ML candidates',
    path: '/api/backtest/ml-candidates?date=2026-05-27&horizon=40&direction=up&limit=5',
    kind: 'json',
  },
  { name: 'chart drill question', path: '/api/chart-drill/question', kind: 'json' },
  { name: 'ML model status', path: '/api/ml/model-status', kind: 'json' },
  { name: 'ML current similars', path: '/api/ml/current-similars?ticker=7003&limit=3', kind: 'json' },
  {
    name: 'JP historical analogs',
    path: '/api/ml/historical-analogs?market=JP&ticker=7003&startDate=2026-06-01&endDate=2026-07-24&limit=3&minScore=0.15',
    kind: 'json',
  },
  {
    name: 'US historical analogs',
    path: '/api/ml/historical-analogs?market=US&ticker=AAPL&startDate=2026-06-01&endDate=2026-07-24&limit=3&minScore=0.15',
    kind: 'json',
  },
  {
    name: 'ML objective validation',
    path: '/api/ml/objective-validation?horizon=20&direction=up&split=test&variant=baseline&limit=5',
    kind: 'json',
  },
  {
    name: 'ML pattern events',
    path: '/api/ml/pattern-events?direction=up&horizon=20&threshold=5&limit=5',
    kind: 'json',
  },
  {
    name: 'ML pattern search',
    path: '/api/ml/pattern-search?ticker=7003&startDate=2026-06-01&endDate=2026-07-24&limit=3',
    kind: 'json',
  },
  { name: 'ML performance', path: '/api/ml/performance?horizon=20&direction=up&limit=5', kind: 'json' },
  { name: 'ML prediction history', path: '/api/ml/prediction-history?ticker=7003&limit=5', kind: 'json' },
  {
    name: 'ML sector candidates',
    path: `/api/ml/sector-candidates?sectorType=33&sectorName=${encodeURIComponent('電気機器')}&direction=up&limit=5`,
    kind: 'json',
  },
  { name: 'ML sector rankings', path: '/api/ml/sector-rankings?sectorType=33&direction=up&limit=5', kind: 'json' },
  { name: 'trade scenarios', path: '/api/trade/scenarios?ticker=7003&market=JP', kind: 'json' },
  { name: 'trade overview', path: '/api/trade/scenarios/overview?limit=5', kind: 'json' },
  { name: 'trade candidates', path: '/api/trade/workbench-candidates?horizon=20&limit=5', kind: 'json' },
  { name: 'US status', path: '/api/us/status', kind: 'json' },
  { name: 'US quote', path: '/api/us/quote/AAPL', kind: 'json' },
  { name: 'US history', path: '/api/us/history/AAPL?period=1y&meta=1', kind: 'json' },
  { name: 'US search', path: '/api/us/search?q=AAPL', kind: 'json' },
  {
    name: 'US screener',
    path: '/api/us/screener?limit=5&quality=all',
    kind: 'json',
    requiredPaths: ['market', 'date'],
    nonEmptyPaths: ['rows'],
  },
  {
    name: 'US ML physics candidates',
    path: '/api/us/ml-physics-candidates?horizon=20&direction=up&limit=5',
    kind: 'json',
  },
  {
    name: 'US ML current similars',
    path: '/api/us/ml-current-similars?ticker=AAPL&limit=3',
    kind: 'json',
    requiredPaths: ['asOfDate', 'featureAsOfDate', 'physicsAnalysis'],
    nonEmptyPaths: ['similars'],
  },
  { name: 'US ML status', path: '/api/us/ml-status/AAPL', kind: 'json' },
  { name: 'US hex dates', path: '/api/us/hex/available-dates?limit=5', kind: 'json', nonEmptyPaths: ['dates'] },
  { name: 'US hex', path: '/api/us/hex?timeframe=daily', kind: 'json' },
]

function getPath(value: unknown, dottedPath: string): unknown {
  return dottedPath.split('.').reduce<unknown>((current, key) => {
    if (current == null || typeof current !== 'object') return undefined
    return (current as Record<string, unknown>)[key]
  }, value)
}

function isNonEmpty(value: unknown): boolean {
  if (Array.isArray(value) || typeof value === 'string') return value.length > 0
  if (value != null && typeof value === 'object') return Object.keys(value).length > 0
  return value != null
}

async function runCheck(check: Check): Promise<CheckResult> {
  const startedAt = performance.now()
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  let status: number | null = null
  try {
    const response = await fetch(`${baseUrl}${check.path}`, {
      cache: 'no-store',
      redirect: 'follow',
      signal: controller.signal,
      headers: { 'user-agent': 'StockBoard production smoke audit' },
    })
    status = response.status
    const body = await response.text()
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${body.slice(0, 240)}`)

    if (check.kind === 'html') {
      if (!body.toLowerCase().includes('<!doctype html')) throw new Error('HTML document marker is missing')
    } else {
      let json: unknown
      try {
        json = JSON.parse(body)
      } catch {
        throw new Error('Response is not valid JSON')
      }
      const topLevelError = getPath(json, 'error')
      if (typeof topLevelError === 'string' && topLevelError.trim()) {
        throw new Error(`JSON error: ${topLevelError}`)
      }
      for (const requiredPath of check.requiredPaths ?? []) {
        if (getPath(json, requiredPath) == null) throw new Error(`Missing JSON path: ${requiredPath}`)
      }
      for (const nonEmptyPath of check.nonEmptyPaths ?? []) {
        if (!isNonEmpty(getPath(json, nonEmptyPath))) throw new Error(`Empty JSON path: ${nonEmptyPath}`)
      }
    }

    return {
      name: check.name,
      path: check.path,
      ok: true,
      status,
      elapsedMs: Math.round(performance.now() - startedAt),
      bytes: Buffer.byteLength(body),
      error: null,
    }
  } catch (error) {
    return {
      name: check.name,
      path: check.path,
      ok: false,
      status,
      elapsedMs: Math.round(performance.now() - startedAt),
      bytes: 0,
      error: error instanceof Error ? error.message : String(error),
    }
  } finally {
    clearTimeout(timeout)
  }
}

function writeReport(report: unknown): void {
  fs.mkdirSync(path.dirname(reportPath), { recursive: true })
  const temporaryPath = `${reportPath}.${process.pid}.tmp`
  fs.writeFileSync(temporaryPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 })
  fs.renameSync(temporaryPath, reportPath)
}

async function main(): Promise<void> {
  const results: CheckResult[] = []
  for (const check of [...pages, ...apiChecks]) {
    const result = await runCheck(check)
    results.push(result)
    const marker = result.ok ? 'ok' : 'FAIL'
    console.log(`${marker.padEnd(4)} ${String(result.elapsedMs).padStart(6)}ms ${check.name}`)
    if (result.error) console.error(`     ${result.error}`)
  }

  const failed = results.filter((result) => !result.ok)
  const report = {
    status: failed.length === 0 ? 'ok' : 'failed',
    checkedAt: new Date().toISOString(),
    baseUrl,
    timeoutMs,
    totals: {
      checks: results.length,
      passed: results.length - failed.length,
      failed: failed.length,
      slow: results.filter((result) => result.elapsedMs >= 5_000).length,
    },
    slowest: [...results]
      .sort((left, right) => right.elapsedMs - left.elapsedMs)
      .slice(0, 12)
      .map(({ name, path: requestPath, elapsedMs }) => ({ name, path: requestPath, elapsedMs })),
    failures: failed,
    results,
  }
  writeReport(report)
  console.log(JSON.stringify({ ...report, results: undefined }, null, 2))
  if (failed.length > 0) process.exitCode = 1
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
