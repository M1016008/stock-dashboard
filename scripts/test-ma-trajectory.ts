import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createClient } from '@libsql/client'
import {
  buildMaSpaceFeatureVector,
  deriveMaTrajectoryEvents,
  normalizeMaTrajectoryHorizon,
  normalizeScenarioProbabilities,
  summarizeMaEscapeStates,
  type MaTrajectoryForecastPoint,
  type MaTrajectoryOhlcvRow,
} from '@/lib/ma-trajectory/core'
import { readMaTrajectoryProjection } from '@/lib/ma-trajectory/shadow-store'

const root = process.cwd()
const read = (file: string) => fs.readFileSync(path.join(root, file), 'utf8')

const rows: MaTrajectoryOhlcvRow[] = []
const start = new Date('2023-01-02T00:00:00Z')
let price = 100
for (let index = 0; rows.length < 520; index += 1) {
  const current = new Date(start.getTime() + index * 86_400_000)
  if (current.getUTCDay() === 0 || current.getUTCDay() === 6) continue
  price *= 1 + Math.sin(rows.length / 19) * 0.002 + 0.0003
  rows.push({
    date: current.toISOString().slice(0, 10),
    close: price,
    high: price * 1.008,
    low: price * 0.992,
    volume: 100_000 + rows.length * 31,
  })
}

const vector = buildMaSpaceFeatureVector(rows)
assert.ok(vector, 'MA-space vector should be available with 200+ days of history')
assert.equal(vector.names.length, vector.values.length)
assert.equal(vector.groups.ma_history.length, 7 * 40)
assert.ok(vector.names.includes('ma3_history_39'))
assert.ok(vector.names.includes('ma100_history_39'))
assert.ok(vector.names.includes('ma200_history_39'))
assert.ok(vector.names.includes('contact_time_5_25'))
assert.ok(vector.names.includes('gap_25_100'))
assert.ok(vector.names.includes('gap_velocity_75_100'))
assert.ok(vector.names.includes('relative_angle_25_75'))
assert.ok(vector.values.every(Number.isFinite))
assert.equal(buildMaSpaceFeatureVector(rows.slice(0, 220)), null)
assert.equal(normalizeMaTrajectoryHorizon('90'), 90)
assert.equal(normalizeMaTrajectoryHorizon('45'), 60)

const dates = rows.slice(-20).map((row) => row.date)
const makeLine = (values: number[]): MaTrajectoryForecastPoint[] => values.map((value, index) => ({
  date: dates[index],
  median: value,
  p10: value - 0.5,
  p90: value + 0.5,
}))
const lines = {
  '3': makeLine(dates.map((_, index) => 100 + index * 0.6)),
  '5': makeLine(dates.map((_, index) => 100 + index * 0.45)),
  '10': makeLine(dates.map((_, index) => 102 - index * 0.05)),
  '25': makeLine(dates.map((_, index) => 104 - index * 0.25)),
  '75': makeLine(dates.map((_, index) => 106 - index * 0.05)),
  '100': makeLine(dates.map((_, index) => 107 - index * 0.025)),
  '200': makeLine(dates.map(() => 108)),
}
const events = deriveMaTrajectoryEvents(lines, 62.5)
assert.ok(events.some((event) => event.type === 'cross'), 'crossing paths should emit a cross event')
assert.ok(events.some((event) => event.type === 'closest'))
assert.ok(events.slice(0, 3).every((event) => [25, 75].includes(event.shortPeriod)))
const states = summarizeMaEscapeStates(lines, events)
assert.equal(states.length, 6)
assert.ok(Math.abs(states.reduce((sum, state) => sum + state.probabilityPct, 0) - 100) < 0.001)

const scenarios = normalizeScenarioProbabilities([
  { id: 'a', probabilityPct: 2 },
  { id: 'b', probabilityPct: 1 },
])
assert.equal(scenarios.reduce((sum, scenario) => sum + scenario.probabilityPct, 0), 100)

const route = read('app/api/ma-trajectory-projections/[ticker]/route.ts')
const store = read('lib/ma-trajectory/shadow-store.ts')
const wrapper = read('scripts/run-ma-trajectory-shadow.ts')
const jpDetail = read('app/stock/[ticker]/StockDetailClient.tsx')
const usDetail = read('app/us/stock/[ticker]/UsStockDetailClient.tsx')
const panel = read('components/stock/FutureScenarioPanel.tsx')
const trainer = read('scripts/train-ma-trajectory-shadow.py')
const installer = read('scripts/install-local-ma-trajectory.ts')
const core = read('lib/ma-trajectory/core.ts')
assert.match(route, /params: Promise/)
assert.match(route, /horizon/)
assert.match(route, /Cache-Control.*no-store/)
assert.match(store, /promotionEligible !== 1/)
assert.match(store, /MA_TRAJECTORY_ALLOW_UNPROMOTED/)
assert.match(store, /MA_TRAJECTORY_US_ENABLED/)
assert.match(store, /r\.model_version = \?/)
assert.match(store, /r\.feature_version = \?/)
assert.match(wrapper, /JP_STOCKBOARD_UPDATE_JOB_TYPES/)
assert.match(wrapper, /US_ISOLATED_UPDATE_JOB_TYPES/)
assert.match(wrapper, /ohlcv_price_basis/)
assert.match(wrapper, /derived_price_basis/)
assert.match(wrapper, /analog_index_price_basis/)
assert.match(wrapper, /US_ADJUSTED_PRICE_BASIS/)
assert.match(wrapper, /configured === 'predict' \|\| configured === 'auto'/)
assert.match(wrapper, /automatic refresh selected mode=/)
assert.match(wrapper, /MA_TRAJECTORY_MAX_TICKERS/)
assert.match(wrapper, /boundedPilot.*maxTickers.*300.*maxSamples.*10_000/)
assert.match(wrapper, /bounded_pilot/)
assert.match(wrapper, /trainingProfile.*accuracy/)
assert.match(wrapper, /boundedPilot \? 1_200 : 4_096/)
assert.match(wrapper, /accuracyProfile \? 48 : 28/)
assert.match(wrapper, /accuracyProfile \? 32 : 24/)
assert.match(wrapper, /DeferredExecutionError/)
assert.match(wrapper, /MA_TRAJECTORY_MODEL_VERSION/)
assert.match(core, /ma_trajectory_shadow_v6_relational_25_75_100_leakage_audited/)
assert.match(wrapper, /--purge-days', '300'/)
assert.match(wrapper, /import lightgbm, numpy/)
assert.match(trainer, /offline_contextual_bandit_reinforce/)
assert.match(trainer, /negative_future_ma_trajectory_distance/)
assert.match(trainer, /FEATURE_VERSION = "ma_space_v2_relational_25_75_100"/)
assert.match(trainer, /PRIMARY_PERIODS = \(25,\)/)
assert.match(trainer, /JOINT_TRAJECTORY_PERIODS = \(25, 75, 100\)/)
assert.match(trainer, /STRUCTURAL_PERIODS = \(75, 100, 200\)/)
assert.match(trainer, /RELATIONSHIP_PAIRS = \(\(25, 75\), \(25, 100\), \(75, 100\)\)/)
assert.match(trainer, /EVENT_PAIRS = PAIR_PERIODS/)
assert.match(trainer, /EVENT_TYPES = \("approach", "touch", "cross", "bounce", "follow"\)/)
assert.match(trainer, /approached_without_touch/)
assert.match(trainer, /target_weights/)
assert.match(trainer, /supervised_trajectory_loss_and_gradient/)
assert.match(trainer, /"primaryMaMae"/)
assert.match(trainer, /"primarySlopeMae"/)
assert.match(trainer, /"primaryCurvatureMae"/)
assert.match(trainer, /"primaryGapMae"/)
assert.match(trainer, /"relationshipGapVelocityMae"/)
assert.match(trainer, /"relationshipConvergenceDirectionAgreement"/)
assert.match(trainer, /"primaryMaVsWeighted"/)
assert.match(trainer, /"primaryMaVsLightgbm"/)
assert.match(trainer, /testDataUsedForPolicyUpdates.*False/)
assert.match(trainer, /relative_improvement >= 0\.01 and best_ci\[1\] < 0/)
assert.match(trainer, /relative_improvement_gte_1pct_and_paired_95ci_upper_lt_0/)
assert.match(trainer, /historicalCandidatePurgeDays/)
assert.match(trainer, /selfOrFutureCandidatesAllowed.*False/)
assert.match(trainer, /reference_current_gaps/)
assert.match(trainer, /FEATURE_GROUP_DISTANCE_WEIGHTS/)
assert.match(trainer, /"relationshipEventBrier"/)
assert.match(trainer, /"relationshipEventCalibration"/)
assert.match(trainer, /class DatasetReservoir/)
assert.match(trainer, /guard_runtime_memory/)
assert.match(trainer, /save_encoder_progress/)
assert.match(trainer, /fold-\{fold_index\}-encoder-progress/)
assert.match(trainer, /split_indexes/)
assert.match(trainer, /safe deferral/)
assert.match(installer, /MA_TRAJECTORY_TRAINING_PROFILE.*accuracy/)
assert.match(installer, /MA_TRAJECTORY_MIN_FREE_MB.*4096/)
assert.match(installer, /MA_TRAJECTORY_RUNTIME_MIN_AVAILABLE_MB.*2048/)
assert.match(installer, /MA_TRAJECTORY_MAX_RSS_MB.*3500/)
assert.match(jpDetail, /FutureScenarioPanel/)
assert.match(usDetail, /FutureScenarioPanel/)
assert.match(panel, /MA軌道/)
assert.match(panel, /従来価格/)
assert.match(panel, /if \(!projection\?\.available\) return <ScenarioProjectionChart/)

async function testApiStore(): Promise<void> {
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'ma-trajectory-api-test-'))
  const shadowDb = path.join(temporaryDirectory, 'shadow.db')
  const client = createClient({ url: `file:${shadowDb}` })
  await client.executeMultiple(`
  CREATE TABLE ma_trajectory_runs(
    id INTEGER PRIMARY KEY, market TEXT, model_version TEXT, feature_version TEXT,
    source_date TEXT, status TEXT, selected_method TEXT, promotion_eligible INTEGER,
    artifact_path TEXT, report_json TEXT, created_at TEXT
  );
  CREATE TABLE ma_trajectory_predictions(
    run_id INTEGER, market TEXT, ticker TEXT, as_of_date TEXT,
    horizon_sessions INTEGER, payload_json TEXT, generated_at TEXT
  );
  `)
  const scenario = {
    id: 'main', rank: 1, label: '進路が開いている', probabilityPct: 100,
    analogCount: 12, averageSimilarity: 0.8,
    lines: Object.fromEntries([3, 5, 10, 25, 75, 100, 200].map((period) => [String(period), dates.map((date, index) => ({
      date,
      median: 7000 + period * 2 + index * (period <= 10 ? 9 : 3),
      p10: 6960 + period * 2 + index * (period <= 10 ? 8 : 2),
      p90: 7040 + period * 2 + index * (period <= 10 ? 10 : 4),
    }))])),
    priceAuxiliary: dates.map((date, index) => ({ date, median: 7030 + index * 7, p10: 6960 + index * 5, p90: 7100 + index * 9 })),
    events: [{
      type: 'approach', date: dates[8], shortPeriod: 5, longPeriod: 25,
      probabilityPct: 64, gapPct: 0.22, label: '5日線 / 25日線 接近',
    }],
    escapeStates: [{ state: 'open_path', label: '進路が開いている', probabilityPct: 100 }],
    drivers: [{ key: 'ma5_slope_3', label: '5日線の傾き', contribution: 1.2, direction: 'supports' }],
  }
  await client.execute({
    sql: 'INSERT INTO ma_trajectory_runs VALUES(1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    args: ['JP', 'ma_trajectory_shadow_v6_relational_25_75_100_leakage_audited', 'ma_space_v2_relational_25_75_100', '2026-08-07', 'shadow_passed', 'deep_state_encoder', 1, '/tmp/model.npz', '{}', '2026-08-08T00:00:00Z'],
  })
  await client.execute({
    sql: 'INSERT INTO ma_trajectory_predictions VALUES(1, ?, ?, ?, ?, ?, ?)',
    args: ['JP', '5801', '2026-08-07', 60, JSON.stringify({
      asOfDate: '2026-08-07', featureVersion: 'ma_space_v2_relational_25_75_100',
      history: Object.fromEntries([3, 5, 10, 25, 75, 100, 200].map((period) => [String(period), []])),
      scenarios: [scenario],
      calibration: { ece: 0.03, intervalCoverage80: 0.8, queryCount: 500 },
    }), '2026-08-08T00:00:00Z'],
  })
  await client.execute({
    sql: 'INSERT INTO ma_trajectory_runs VALUES(2, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    args: ['JP', 'ma_trajectory_shadow_v4_old', 'ma_space_v1_old', '2026-08-08', 'shadow_passed', 'deep_state_encoder', 1, '/tmp/old.npz', '{}', '2026-08-09T00:00:00Z'],
  })
  await client.execute({
    sql: 'INSERT INTO ma_trajectory_predictions VALUES(2, ?, ?, ?, ?, ?, ?)',
    args: ['JP', '5801', '2026-08-08', 60, JSON.stringify({
      asOfDate: '2026-08-08', featureVersion: 'ma_space_v1_old', history: {}, scenarios: [scenario],
    }), '2026-08-09T00:00:00Z'],
  })
  client.close()
  const originalShadowPath = process.env.MA_TRAJECTORY_SHADOW_DB_PATH_JP
  process.env.MA_TRAJECTORY_SHADOW_DB_PATH_JP = shadowDb
  const available = await readMaTrajectoryProjection({ market: 'JP', ticker: '5801', horizon: 60 })
  assert.equal(available.available, true)
  if (available.available) assert.equal(available.sourceDate, '2026-08-07')
  const updateClient = createClient({ url: `file:${shadowDb}` })
  await updateClient.execute('UPDATE ma_trajectory_runs SET promotion_eligible=0')
  updateClient.close()
  const rejected = await readMaTrajectoryProjection({ market: 'JP', ticker: '5801', horizon: 60 })
  assert.equal(rejected.available, false)
  if (!rejected.available) assert.equal(rejected.reason, 'shadow_not_promoted')
  const restoreClient = createClient({ url: `file:${shadowDb}` })
  await restoreClient.execute('UPDATE ma_trajectory_runs SET promotion_eligible=1')
  restoreClient.close()
  const unsupportedUs = await readMaTrajectoryProjection({ market: 'US', ticker: 'AAPL', horizon: 60 })
  assert.equal(unsupportedUs.available, false)
  if (originalShadowPath == null) delete process.env.MA_TRAJECTORY_SHADOW_DB_PATH_JP
  else process.env.MA_TRAJECTORY_SHADOW_DB_PATH_JP = originalShadowPath
}

testApiStore()
  .then(() => console.log('MA trajectory domain, API, market isolation, and UI contract tests passed'))
  .catch((error) => {
    console.error(error)
    process.exit(1)
  })
