import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { ML_PRIMARY_HORIZON_LIST, ML_PRIMARY_HORIZONS } from '@/lib/backtest/ml-horizons'
import { ML_PHYSICS_DEFAULT_HORIZONS } from '@/lib/backtest/ml-physics'

const expected = [5, 10, 20, 40, 60, 90, 200]
assert.deepEqual([...ML_PRIMARY_HORIZONS], expected)
assert.deepEqual([...ML_PHYSICS_DEFAULT_HORIZONS], expected)
const packageJson = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf8')) as {
  scripts: Record<string, string>
}
const criticalScripts = [
  'batch:forward-returns:ml',
  'batch:forward-extrema:ml',
  'batch:forward-extrema:ml-recent',
  'batch:ml-rl-daily',
  'batch:ml-weekly-train',
  'batch:ml-weekly-efficient',
  'batch:ml-full',
  'batch:us-ml-daily-serving-chain-recent',
  'batch:us-ml-full-history-chain',
  'batch:ml-physics-early',
  'batch:ml-physics-v4-full',
]

for (const scriptName of criticalScripts) {
  const command = packageJson.scripts[scriptName]
  assert.ok(command, `${scriptName} is missing`)
  assert.ok(command.includes(ML_PRIMARY_HORIZON_LIST), `${scriptName} does not include ${ML_PRIMARY_HORIZON_LIST}`)
}

const dailyServingCommand = packageJson.scripts['batch:ml-daily-serving-recent']
assert.ok(dailyServingCommand.includes('batch:ml-physics-status-evaluate'), 'daily serving must refresh physics status evaluations')
assert.ok(
  dailyServingCommand.includes(`ML_PHYSICS_STATUS_HORIZONS=${ML_PRIMARY_HORIZON_LIST}`),
  'daily serving physics status evaluation must include every primary horizon',
)
assert.ok(
  packageJson.scripts['batch:ml-weekly-train'].includes(`ML_PHYSICS_STATUS_HORIZONS=${ML_PRIMARY_HORIZON_LIST}`),
  'weekly training must refresh physics status evaluations for every primary horizon',
)

const backfillSource = fs.readFileSync(path.join(process.cwd(), 'scripts/run-ml-horizon-backfill.ts'), 'utf8')
const shortLabelsStep = backfillSource.indexOf("await step('200-day short labels'")
const physicsModelStep = backfillSource.indexOf("await step('200-day physics model'")
const physicsCandidatesStep = backfillSource.indexOf("await step('200-day physics candidates'")
assert.ok(shortLabelsStep >= 0, '200-day backfill must generate short labels')
assert.ok(physicsModelStep > shortLabelsStep, '200-day physics model must run after short labels')
assert.ok(physicsCandidatesStep > physicsModelStep, '200-day physics candidates must run after the trained physics model')

const readinessSource = fs.readFileSync(path.join(process.cwd(), 'scripts/check-ml-accuracy-readiness.ts'), 'utf8')
assert.ok(
  readinessSource.includes("mode === 'yearly'"),
  'accuracy readiness must recognize the memory-bounded yearly full-history sampler',
)
assert.ok(
  readinessSource.includes('MIN_FEATURE_HISTORY_DAYS'),
  'accuracy readiness must compare feature coverage against the eligible history universe',
)
assert.ok(
  readinessSource.includes('ohlcv_daily current INDEXED BY ohlcv_date_ticker_idx')
    && readinessSource.includes('us_analytics_copy_state copy')
    && readinessSource.includes('LIMIT 1 OFFSET ?'),
  'accuracy readiness must use the indexed hybrid history eligibility check',
)

const statusEvaluationSource = fs.readFileSync(path.join(process.cwd(), 'scripts/batch-ml-physics-status-evaluate.ts'), 'utf8')
assert.ok(statusEvaluationSource.includes('cutoffDate(horizon: number)'), 'status evaluation must calculate a cutoff per horizon')
assert.ok(
  statusEvaluationSource.includes('await execBatch([deleteHorizonStatement, ...horizonStatements])'),
  'status evaluation must replace one completed horizon atomically',
)

const scenarioProjectionSource = fs.readFileSync(path.join(process.cwd(), 'lib/stock-scenarios/projections.ts'), 'utf8')
assert.ok(
  scenarioProjectionSource.includes('Math.min(200, Math.floor(params.horizonDays))'),
  'stock scenario projections must preserve the 200-day horizon',
)

const backtestCoverageSource = fs.readFileSync(path.join(process.cwd(), 'app/api/backtest/coverage/route.ts'), 'utf8')
const backtestQuerySource = fs.readFileSync(path.join(process.cwd(), 'app/api/backtest/query/route.ts'), 'utf8')
for (const [name, source] of [
  ['backtest coverage', backtestCoverageSource],
  ['backtest query', backtestQuerySource],
] as const) {
  assert.ok(source.includes('90, 180, 200'), `${name} must accept the 200-day horizon`)
}

const historicalPatternSource = fs.readFileSync(path.join(process.cwd(), 'components/ai/HistoricalPatternSearchPanel.tsx'), 'utf8')
assert.ok(
  historicalPatternSource.includes('90, 180, 200'),
  'historical pattern search must expose the 200-day horizon',
)

const chartDrillSource = fs.readFileSync(path.join(process.cwd(), 'lib/chart-drill/server.ts'), 'utf8')
assert.ok(chartDrillSource.includes('const MAX_HORIZON = 200'), 'chart drill must accept the 200-day horizon')

console.log(`ML horizon consistency tests passed: ${ML_PRIMARY_HORIZON_LIST}`)
