import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

type CheckKind = 'html' | 'json'

type Check = {
  name: string
  path: string
  kind: CheckKind
  method?: 'GET' | 'POST'
  body?: unknown
  requiredPaths?: string[]
  nonEmptyPaths?: string[]
  expectedValues?: Record<string, string | number | boolean>
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
const pitAsOf = process.env.STOCKBOARD_SMOKE_PIT_AS_OF ?? '2026-05-29'
const savedSmokeId = 'production-smoke-saved-evaluation'

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
  '/ma25m-monitor',
  '/materials',
  '/period-explorer',
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
    name: 'stock Quick View PIT',
    path: `/api/stock-preview/7203?as_of=${pitAsOf}`,
    kind: 'json',
    requiredPaths: ['name', 'priceDate', 'stages.dailyA', 'stages.dailyB', 'stages.weeklyA', 'stages.weeklyB', 'stages.monthlyA', 'stages.monthlyB'],
    expectedValues: { ticker: '7203', requestedAsOf: pitAsOf },
  },
  {
    name: 'stock Quick Chart PIT',
    path: `/api/stock-preview/7203?as_of=${pitAsOf}&include=chart`,
    kind: 'json',
    requiredPaths: ['chart', 'priceDate', 'stages.dailyA'],
    expectedValues: { ticker: '7203', requestedAsOf: pitAsOf },
  },
  {
    name: 'Phase 2 financial overview PIT',
    path: `/api/financial-overview/7203?as_of=${pitAsOf}`,
    kind: 'json',
    requiredPaths: ['coverage.facts', 'performanceAndGrowth', 'quality', 'valuation', 'shareholderReturns'],
    expectedValues: { contractVersion: 'financial-overview-v1', ticker: '7203', asOf: pitAsOf },
  },
  {
    name: 'Phase 3 performance timeline PIT',
    path: `/api/financial-performance-timeline/7203?as_of=${pitAsOf}`,
    kind: 'json',
    requiredPaths: ['modes.FY.periods', 'modes.YTD.periods', 'modes.STANDALONE.periods', 'modes.LTM.periods'],
    expectedValues: { contractVersion: 'financial-performance-timeline-v1', ticker: '7203', asOf: pitAsOf },
  },
  {
    name: 'Phase 4 performance detail PIT',
    path: `/api/financial-performance-detail/7203?as_of=${pitAsOf}`,
    kind: 'json',
    requiredPaths: ['summary', 'modes.FY', 'forecastHistory'],
    expectedValues: { contractVersion: 'financial-performance-detail-v1', ticker: '7203', asOf: pitAsOf },
  },
  {
    name: 'Phase 5 financial detail PIT',
    path: `/api/financial-detail/7203?as_of=${pitAsOf}`,
    kind: 'json',
    requiredPaths: ['summary', 'profitAndLoss.FY', 'balanceSheet.FY', 'cashFlow.FY'],
    expectedValues: { contractVersion: 'financial-detail-v1', ticker: '7203', asOf: pitAsOf },
  },
  {
    name: 'Phase 6 valuation detail PIT',
    path: `/api/valuation-detail/7203?as_of=${pitAsOf}`,
    kind: 'json',
    requiredPaths: ['current.primary', 'history', 'peers.sector33'],
    expectedValues: { contractVersion: 'valuation-detail-v1', ticker: '7203', asOf: pitAsOf },
  },
  {
    name: 'Phase 7 shareholder returns PIT',
    path: `/api/shareholder-returns/7203?as_of=${pitAsOf}`,
    kind: 'json',
    requiredPaths: ['current', 'history.rows', 'direction', 'forecastRevisions'],
    expectedValues: { contractVersion: 'shareholder-returns-v1', ticker: '7203', asOf: pitAsOf },
  },
  {
    name: 'Phase 8 company information PIT',
    path: `/api/company-information/7203?as_of=${pitAsOf}`,
    kind: 'json',
    requiredPaths: ['identity', 'overview', 'segmentInformation', 'employees', 'officers', 'shareholders'],
    expectedValues: { contractVersion: 'company-information-v1', ticker: '7203', asOf: pitAsOf },
  },
  {
    name: 'Phase 9 similarity comparison PIT',
    path: `/api/similarity-comparison/7203?as_of=${pitAsOf}`,
    kind: 'json',
    requiredPaths: ['candidateGroups', 'companies', 'sectorDistribution', 'coverage'],
    expectedValues: { contractVersion: 'similarity-comparison-v1', ticker: '7203', asOf: pitAsOf },
  },
  {
    name: 'Phase 10 integrated screener PIT',
    path: '/api/integrated-screener',
    kind: 'json',
    method: 'POST',
    body: {
      asOf: pitAsOf,
      conditions: [{ id: 'smoke-market-cap', metric: 'marketCap', operator: 'gte', value: 0 }],
      sort: 'marketCap',
      direction: 'desc',
      limit: 3,
      offset: 0,
    },
    nonEmptyPaths: ['rows'],
    expectedValues: { contractVersion: 'integrated-screener-v1', asOf: pitAsOf },
  },
  {
    name: 'Phase 11 screener reason PIT',
    path: '/api/integrated-screener/reason',
    kind: 'json',
    method: 'POST',
    body: {
      ticker: '7203',
      asOf: pitAsOf,
      conditions: [{ id: 'smoke-market-cap', metric: 'marketCap', operator: 'gte', value: 0 }],
    },
    nonEmptyPaths: ['matchedConditions'],
    expectedValues: { contractVersion: 'screener-reason-v1', ticker: '7203', asOf: pitAsOf },
  },
  {
    name: 'Phase 12 natural-language interpretation',
    path: '/api/integrated-screener/interpret',
    kind: 'json',
    method: 'POST',
    body: { query: 'ROEが10%以上でForward PERが15倍以下' },
    nonEmptyPaths: ['conditions'],
    expectedValues: { contractVersion: 'screener-natural-language-v1', status: 'proposal' },
  },
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
  {
    name: 'JP stage history trading-day range',
    path: '/api/stage-history/7003?market=JP&granularity=weekly&lookbackTradingDays=200',
    kind: 'json',
    requiredPaths: ['range.requestedTradingDays', 'range.sourceTradingDays', 'range.displayPoints', 'history'],
    expectedValues: { 'range.requestedTradingDays': 200 },
  },
  {
    name: 'JP classification search',
    path: `/api/search?q=${encodeURIComponent('コネクター')}`,
    kind: 'json',
    requiredPaths: ['0.majorCategory', '0.subIndustry'],
  },
  { name: 'JP screener', path: '/api/screener?limit=5', kind: 'json' },
  {
    name: 'JP period explorer PIT',
    path: `/api/period-explorer?from=2026-05-01&to=${pitAsOf}&ranking=return_up&limit=5`,
    kind: 'json',
    requiredPaths: ['range.adoptedFrom', 'range.adoptedTo', 'rows', 'total'],
    nonEmptyPaths: ['rows'],
    expectedValues: { 'range.adoptedTo': pitAsOf, resultKind: 'stocks' },
  },
  { name: 'JP monthly MA monitor', path: '/api/ma25m-monitor?period=all&limit=5', kind: 'json', requiredPaths: ['date', 'periods', 'summary.monitored', 'summary.clusters'] },
  { name: 'JP monthly MA detail', path: '/api/ma25m-monitor/7003', kind: 'json', requiredPaths: ['ticker', 'monitors', 'clusters'] },
  { name: 'sector ETFs', path: '/api/sector-etfs', kind: 'json' },
  { name: 'sector ETF detail', path: '/api/sector-etfs/1617', kind: 'json' },
  {
    name: 'sector master classification',
    path: '/api/sector-master/6806',
    kind: 'json',
    requiredPaths: ['master.major_category', 'master.sub_industry'],
  },
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
  {
    name: 'ML reliability status',
    path: '/api/ml/reliability-status',
    kind: 'json',
    requiredPaths: ['modelDate', 'validationRuns', 'validationSamples', 'healthIssueCount'],
  },
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
    const method = check.method ?? 'GET'
    const response = await fetch(`${baseUrl}${check.path}`, {
      method,
      cache: 'no-store',
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        'user-agent': 'StockBoard production smoke audit',
        ...(check.body == null ? {} : { 'content-type': 'application/json' }),
      },
      body: check.body == null ? undefined : JSON.stringify(check.body),
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
      for (const [expectedPath, expectedValue] of Object.entries(check.expectedValues ?? {})) {
        const actualValue = getPath(json, expectedPath)
        if (actualValue !== expectedValue) {
          throw new Error(`Unexpected JSON value at ${expectedPath}: expected=${JSON.stringify(expectedValue)} actual=${JSON.stringify(actualValue)}`)
        }
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

async function runSavedEvaluationCheck(): Promise<CheckResult> {
  const name = 'Phase 13 saved screening evaluation PIT'
  const requestPath = `/api/integrated-screener/saved/${savedSmokeId}`
  const startedAt = performance.now()
  let status: number | null = null
  let bytes = 0
  const request = async (pathName: string, init: RequestInit): Promise<Record<string, unknown>> => {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const response = await fetch(`${baseUrl}${pathName}`, {
        ...init,
        cache: 'no-store',
        signal: controller.signal,
        headers: {
          'user-agent': 'StockBoard production smoke audit',
          ...(init.body == null ? {} : { 'content-type': 'application/json' }),
          ...init.headers,
        },
      })
      status = response.status
      const body = await response.text()
      bytes += Buffer.byteLength(body)
      if (!response.ok) throw new Error(`HTTP ${response.status}: ${body.slice(0, 240)}`)
      const json = JSON.parse(body) as Record<string, unknown>
      if (typeof json.error === 'string' && json.error.trim()) throw new Error(`JSON error: ${json.error}`)
      return json
    } finally {
      clearTimeout(timeout)
    }
  }

  try {
    const saved = await request('/api/integrated-screener/saved', {
      method: 'POST',
      body: JSON.stringify({
        id: savedSmokeId,
        name: '__production_smoke_saved_evaluation__',
        evaluate: false,
        state: {
          asOf: pitAsOf,
          conditions: [{ id: 'smoke-sector', metric: 'sector33', operator: 'eq', value: '輸送用機器' }],
          sort: 'marketCap',
          direction: 'desc',
          columns: ['marketCap', 'forwardPer'],
          page: 0,
        },
      }),
    })
    if (getPath(saved, 'contractVersion') !== 'saved-screen-definitions-v1') throw new Error('Saved definition contract mismatch')
    if (getPath(saved, 'definition.id') !== savedSmokeId) throw new Error('Saved definition ID mismatch')

    const evaluated = await request(requestPath, {
      method: 'POST',
      body: JSON.stringify({ asOf: pitAsOf }),
    })
    if (getPath(evaluated, 'contractVersion') !== 'saved-screen-evaluation-v1') throw new Error('Saved evaluation contract mismatch')
    if (getPath(evaluated, 'evaluation.asOf') !== pitAsOf) throw new Error('Saved evaluation PIT date mismatch')
    const evaluationId = getPath(evaluated, 'evaluation.evaluationId')
    if (typeof evaluationId !== 'string' || !evaluationId) throw new Error('Saved evaluation ID is missing')

    const detail = await request(
      `${requestPath}?evaluation_id=${encodeURIComponent(evaluationId)}&status=STAY&limit=1`,
      { method: 'GET' },
    )
    if (getPath(detail, 'contractVersion') !== 'saved-screen-evaluation-v1') throw new Error('Saved evaluation detail contract mismatch')
    if (getPath(detail, 'evaluation.asOf') !== pitAsOf) throw new Error('Saved evaluation detail PIT date mismatch')
    return {
      name,
      path: requestPath,
      ok: true,
      status,
      elapsedMs: Math.round(performance.now() - startedAt),
      bytes,
      error: null,
    }
  } catch (error) {
    return {
      name,
      path: requestPath,
      ok: false,
      status,
      elapsedMs: Math.round(performance.now() - startedAt),
      bytes,
      error: error instanceof Error ? error.message : String(error),
    }
  } finally {
    try {
      await fetch(`${baseUrl}${requestPath}`, {
        method: 'DELETE',
        cache: 'no-store',
        headers: { 'user-agent': 'StockBoard production smoke audit' },
        signal: AbortSignal.timeout(timeoutMs),
      })
    } catch {
      // The stable fixture is reused on the next run; cleanup failure must not hide the primary result.
    }
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
  const savedEvaluationResult = await runSavedEvaluationCheck()
  results.push(savedEvaluationResult)
  console.log(`${(savedEvaluationResult.ok ? 'ok' : 'FAIL').padEnd(4)} ${String(savedEvaluationResult.elapsedMs).padStart(6)}ms ${savedEvaluationResult.name}`)
  if (savedEvaluationResult.error) console.error(`     ${savedEvaluationResult.error}`)

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
