import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { createClient, type Client, type InValue } from '@libsql/client'
import {
  adaptCurrentServingRecord,
  assertCurrentServingProjectionUpdateLock,
  currentServingAdapterRowsSql,
  deriveCurrentRegimeTransition,
  loadCurrentServingMarketProjection,
  type CurrentServingQuery,
  type CurrentServingSourceRecord,
} from '@/lib/research/six-stage-current-serving-adapter'
import {
  publishCurrentServingProjectionFromStages,
  readCurrentServingMarketStage,
  readCurrentServingProjection,
  stageCurrentServingMarket,
  type CurrentServingMarketStage,
} from '@/lib/research/six-stage-current-serving-projection-store'
import { CURRENT_SERVING_PROJECTION_DEFINITION_VERSION } from '@/lib/research/six-stage-current-serving-projection'
import { attestCurrentServingProjectionRunner } from '@/lib/research/six-stage-current-serving-runner-attestation'
import {
  currentServingProjectionRunnerInvocation,
  runAttestedCurrentServingProjection,
} from '@/lib/research/six-stage-current-serving-runner-process'

const DATES = ['2026-10-19', '2026-10-20', '2026-10-21', '2026-10-22', '2026-10-23']

async function run(client: Client, sql: string, args: InValue[] = []): Promise<void> {
  await client.execute({ sql, args })
}

async function fixtureDatabase(file: string, market: 'JP' | 'US'): Promise<Client> {
  const client = createClient({ url: `file:${file}` })
  await client.batch([
    `CREATE TABLE ticker_universe(ticker TEXT PRIMARY KEY,name TEXT,active INTEGER NOT NULL)`,
    `CREATE TABLE daily_snapshots(
      ticker TEXT NOT NULL,date TEXT NOT NULL,ma_5 REAL,ma_25 REAL,ma_75 REAL,ma_150 REAL,ma_300 REAL,
      daily_a_stage INTEGER,daily_b_stage INTEGER,weekly_a_stage INTEGER,weekly_b_stage INTEGER,
      monthly_a_stage INTEGER,monthly_b_stage INTEGER,
      computed_at INTEGER NOT NULL,PRIMARY KEY(ticker,date))`,
    `CREATE INDEX snapshots_date_idx ON daily_snapshots(date)`,
    `CREATE TABLE ohlcv_daily(ticker TEXT NOT NULL,date TEXT NOT NULL,close REAL NOT NULL,PRIMARY KEY(ticker,date))`,
    `CREATE TABLE ml_feature_vectors_v2(
      ticker TEXT NOT NULL,date TEXT NOT NULL,feature_set TEXT NOT NULL,stage_code TEXT,
      feature_json TEXT NOT NULL,computed_at INTEGER NOT NULL,PRIMARY KEY(ticker,date,feature_set))`,
    `CREATE INDEX ml_feature_vectors_v2_date_idx ON ml_feature_vectors_v2(feature_set,date)`,
    `CREATE INDEX ml_feature_vectors_v2_feature_ticker_date_idx ON ml_feature_vectors_v2(feature_set,ticker,date)`,
    `CREATE TABLE feature_snapshots(
      ticker TEXT NOT NULL,date TEXT NOT NULL,timescale TEXT NOT NULL,
      slope_m1 REAL,slope_m2 REAL,slope_m3 REAL,slope_m4 REAL,slope_m5 REAL,
      accel_m1 REAL,accel_m2 REAL,accel_m3 REAL,accel_m4 REAL,accel_m5 REAL,
      computed_at INTEGER NOT NULL,
      PRIMARY KEY(ticker,date,timescale))`,
    `CREATE TABLE physical_momentum_metrics(
      market TEXT NOT NULL,symbol TEXT NOT NULL,date TEXT NOT NULL,
      velocity REAL,acceleration REAL,momentum REAL,force REAL,energy REAL,
      physical_momentum_score REAL,physical_force_score REAL,physical_energy_score REAL,
      updated_at INTEGER NOT NULL,PRIMARY KEY(market,symbol,date))`,
    `CREATE INDEX physical_momentum_market_date_idx ON physical_momentum_metrics(market,date)`,
    `CREATE TABLE update_locks(
      job_type TEXT PRIMARY KEY,status TEXT NOT NULL,owner TEXT,lease_expires_at INTEGER NOT NULL)`,
    `CREATE TABLE us_analytics_metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL,updated_at INTEGER NOT NULL)`,
  ])
  await run(client, `INSERT INTO ticker_universe VALUES('AAA','Alpha',1),('BBB','Boundary',1)`)
  const jobType = market === 'JP' ? 'update_latest' : 'us_update_latest'
  await run(client, `INSERT INTO update_locks VALUES(?, 'running', ?, unixepoch() + 3600)`, [
    jobType, `${jobType}:123:fixture`,
  ])
  await run(client, `INSERT INTO us_analytics_metadata VALUES('ohlcv_price_basis','tiingo_adj_ohlc_ratio_v1',unixepoch())`)
  const stages: Record<string, string[]> = {
    AAA: ['111111', '111111', '211111', '311111', '311111'],
    BBB: ['411111', '411111', '------', '------', '511111'],
  }
  for (const ticker of Object.keys(stages)) {
    for (let index = 0; index < DATES.length; index += 1) {
      const date = DATES[index]
      const currentStage = stages[ticker][index]
      const cAge = ticker === 'AAA' && index === 4 ? 2 : 1
      const featureJson = JSON.stringify({
        timeSince: { stageCodeAge: cAge },
        sma: { sma200: 90 + index },
      })
      const stageValues = /^[1-6]{6}$/.test(currentStage)
        ? currentStage.split('').map(Number)
        : [null, null, null, null, null, null]
      await run(client, `INSERT INTO daily_snapshots VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [
        ticker, date, 104 + index, 102 + index, 100 + index, 96 + index, 88 + index,
        ...stageValues, 1000 + index,
      ])
      await run(client, `INSERT INTO ohlcv_daily VALUES(?,?,?)`, [ticker, date, 110 + index])
      await run(client, `INSERT INTO ml_feature_vectors_v2 VALUES(?,?,?,?,?,?)`, [
        ticker, date, 'ma_physics_v4', currentStage, featureJson, 2000 + index,
      ])
    }
    await run(client, `INSERT INTO feature_snapshots VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [
      ticker, DATES.at(-1)!, 'daily', 0.4, 0.3, 0.2, 0.1, -0.1, 0.04, 0.03, 0.02, 0.01, -0.01, 4000,
    ])
    await run(client, `INSERT INTO physical_momentum_metrics VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`, [
      market, ticker, DATES.at(-1)!, 1, 2, 3, 4, 5, 60, 55, 50, 3000,
    ])
  }
  await run(client, `UPDATE ml_feature_vectors_v2
    SET feature_json = json_set(feature_json, '$.timeSince.stageCodeAge', NULL)
    WHERE ticker = 'BBB' AND date = ?`, [DATES.at(-1)!])
  return client
}

function query(client: Client): CurrentServingQuery {
  return async <T extends Record<string, unknown>>(sql: string, args: readonly (string | number | null)[] = []) => {
    const result = await client.execute({ sql, args: [...args] })
    return result.rows.map((row) => ({ ...row }) as unknown as T)
  }
}

function stageFor(
  market: 'JP' | 'US',
  loaded: Awaited<ReturnType<typeof loadCurrentServingMarketProjection>>,
): CurrentServingMarketStage {
  return {
    kind: 'stockboard-six-stage-current-serving-market-stage',
    status: 'COMPLETE',
    market,
    stagedAt: '2026-10-26T00:00:00.000Z',
    definitionVersion: CURRENT_SERVING_PROJECTION_DEFINITION_VERSION,
    watermark: {
      asOfTradingDate: loaded.watermark.asOfTradingDate,
      sourceGeneration: loaded.watermark.sourceGeneration,
      priceBasis: loaded.watermark.priceBasis,
      featureSet: loaded.watermark.featureSet,
      rows: loaded.rows.length,
      coverage: {
        snapshotRows: loaded.watermark.snapshotRows,
        eligibleRows: loaded.watermark.eligibleRows,
        universeRows: loaded.watermark.universeRows,
        universeIdentityRows: loaded.watermark.universeIdentityRows,
        closeRows: loaded.watermark.closeRows,
        mlRows: loaded.watermark.mlRows,
        smaRows: loaded.watermark.smaRows,
        physicalRows: loaded.watermark.physicalRows,
      },
    },
    rows: loaded.rows,
  }
}

async function main(): Promise<void> {
  assert.deepEqual(deriveCurrentRegimeTransition({
    currentStage: '311111', previousStage: '211111', priorStage: '111111', cAge: 4,
  }), {
    current: '311111', sequence2: '211111>311111', sequence3: '111111>211111>311111', cAge: 4,
  })
  assert.deepEqual(deriveCurrentRegimeTransition({
    currentStage: '511111', previousStage: '------', priorStage: '411111', cAge: 1,
  }), {
    current: '511111', sequence2: null, sequence3: null, cAge: 1,
  })

  const source: CurrentServingSourceRecord = {
    market: 'JP', ticker: 'TEST', companyName: 'Test', asOfTradingDate: '2026-10-23',
    sourceGeneration: 'jp-fixture', currentStage: '311111', previousStage: '211111', priorStage: '111111', cAge: 2,
    close: 110,
    sma: Object.fromEntries([5, 25, 75, 150, 200, 300].map((period) => [period, {
      value: period === 200 ? null : 100,
      slope: period === 200 ? null : 0.5,
      curvature: period === 200 ? null : 0.1,
    }])) as CurrentServingSourceRecord['sma'],
    convergence: { sma25To75: null, sma75To150: null, sma150To200: null, sma200To300: null },
    physical: { velocity: 1, acceleration: 2, momentum: 3, force: 4, energy: 5, pms: null, pfs: null, pes: null },
  }
  const adapted = adaptCurrentServingRecord(source)
  assert.equal(adapted.sma[200].available.value, false)
  assert.equal(adapted.physical.available.pms, false)
  assert.equal(adapted.stage.sequence3, '111111>211111>311111')
  assert.ok(Math.abs((adapted.sma[5].normalizedAngle ?? 0) - Math.atan(0.5) * 180 / Math.PI) < 1e-12,
    'F1 parity requires atan(percent-rate slope)')

  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'six-stage-serving-adapter-'))
  const clients: Client[] = []
  try {
    const integrationRoot = path.join(temporary, 'integration')
    const runnerPath = path.join(integrationRoot, 'scripts', 'build-six-stage-current-serving-projection.ts')
    const tsxPath = path.join(integrationRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs')
    const tsconfigPath = path.join(integrationRoot, 'tsconfig.json')
    const packageLockPath = path.join(integrationRoot, 'package-lock.json')
    fs.mkdirSync(path.dirname(runnerPath), { recursive: true })
    fs.mkdirSync(path.dirname(tsxPath), { recursive: true })
    fs.writeFileSync(runnerPath, `import { spawn } from 'node:child_process'
if (process.env.CURRENT_PROJECTION_TEST_HANG === '1') {
  spawn(process.execPath, ['-e', "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"], { stdio: 'ignore' })
  setInterval(() => {}, 1000)
}
export {}
`)
    fs.writeFileSync(tsxPath, `import { pathToFileURL } from 'node:url'
await import(pathToFileURL(process.argv.at(-1)).href)
`)
    fs.writeFileSync(tsconfigPath, '{}\n')
    fs.writeFileSync(packageLockPath, '{}\n')
    execFileSync('/usr/bin/git', ['init', '-q'], { cwd: integrationRoot })
    execFileSync('/usr/bin/git', ['config', 'user.email', 'fixture@example.invalid'], { cwd: integrationRoot })
    execFileSync('/usr/bin/git', ['config', 'user.name', 'Fixture'], { cwd: integrationRoot })
    execFileSync('/usr/bin/git', [
      'add', 'scripts/build-six-stage-current-serving-projection.ts', 'tsconfig.json', 'package-lock.json',
    ], { cwd: integrationRoot })
    execFileSync('/usr/bin/git', ['commit', '-qm', 'fixture'], { cwd: integrationRoot })
    const integrationCommit = execFileSync('/usr/bin/git', ['rev-parse', 'HEAD'], {
      cwd: integrationRoot, encoding: 'utf8',
    }).trim()
    const runnerSha256 = crypto.createHash('sha256').update(fs.readFileSync(runnerPath)).digest('hex')
    const tsxSha256 = crypto.createHash('sha256').update(fs.readFileSync(tsxPath)).digest('hex')
    const tsconfigSha256 = crypto.createHash('sha256').update(fs.readFileSync(tsconfigPath)).digest('hex')
    const packageLockSha256 = crypto.createHash('sha256').update(fs.readFileSync(packageLockPath)).digest('hex')
    const attestationEnvironment: NodeJS.ProcessEnv = {
      NODE_ENV: 'test',
      CURRENT_SERVING_PROJECTION_ENABLED: '1',
      CURRENT_SERVING_PROJECTION_INTEGRATION_ROOT: integrationRoot,
      CURRENT_SERVING_PROJECTION_RUNNER_PATH: runnerPath,
      CURRENT_SERVING_PROJECTION_INTEGRATION_COMMIT: integrationCommit,
      CURRENT_SERVING_PROJECTION_RUNNER_SHA256: runnerSha256,
      CURRENT_SERVING_PROJECTION_TSX_SHA256: tsxSha256,
      CURRENT_SERVING_PROJECTION_TSCONFIG_SHA256: tsconfigSha256,
      CURRENT_SERVING_PROJECTION_PACKAGE_LOCK_SHA256: packageLockSha256,
    }
    const attestation = attestCurrentServingProjectionRunner(attestationEnvironment)
    assert.deepEqual(attestation, {
      root: fs.realpathSync(integrationRoot),
      runnerPath: fs.realpathSync(runnerPath),
      commit: integrationCommit,
      runnerSha256,
      tsxPath: fs.realpathSync(tsxPath),
      tsxSha256,
      tsconfigPath: fs.realpathSync(tsconfigPath),
      tsconfigSha256,
      packageLockSha256,
    })
    assert.deepEqual(currentServingProjectionRunnerInvocation(attestation), {
      command: process.execPath,
      args: [fs.realpathSync(tsxPath), '--tsconfig', fs.realpathSync(tsconfigPath), fs.realpathSync(runnerPath)],
      options: { cwd: fs.realpathSync(integrationRoot), detached: true },
    })
    assert.deepEqual(await runAttestedCurrentServingProjection({
      environment: attestationEnvironment,
      timeoutMs: 2_000,
      terminationGraceMs: 500,
    }), { code: 0, signal: null, timedOut: false })
    const timedOut = await runAttestedCurrentServingProjection({
      environment: { ...attestationEnvironment, CURRENT_PROJECTION_TEST_HANG: '1' },
      timeoutMs: 1_200,
      terminationGraceMs: 400,
    })
    assert.equal(timedOut.code, 124)
    assert.equal(timedOut.timedOut, true)
    assert.throws(() => attestCurrentServingProjectionRunner({
      ...attestationEnvironment,
      CURRENT_SERVING_PROJECTION_RUNNER_SHA256: '0'.repeat(64),
    }), /RUNNER_SHA256_MISMATCH/)
    fs.appendFileSync(runnerPath, '// dirty\n')
    assert.throws(() => attestCurrentServingProjectionRunner(attestationEnvironment), /CHECKOUT_DIRTY/)
    execFileSync('/usr/bin/git', ['checkout', '--', 'scripts/build-six-stage-current-serving-projection.ts'], {
      cwd: integrationRoot,
    })

    const jpClient = await fixtureDatabase(path.join(temporary, 'jp.sqlite'), 'JP')
    const usClient = await fixtureDatabase(path.join(temporary, 'us.sqlite'), 'US')
    clients.push(jpClient, usClient)
    const deadlineMs = Date.now() + 60_000
    await assertCurrentServingProjectionUpdateLock({
      market: 'JP', owner: 'update_latest:123:fixture', query: query(jpClient),
    })
    await assertCurrentServingProjectionUpdateLock({
      market: 'US', owner: 'us_update_latest:123:fixture', query: query(usClient),
    })
    await assert.rejects(() => assertCurrentServingProjectionUpdateLock({
      market: 'JP', owner: 'update_latest:999:not-held', query: query(jpClient),
    }), /UPDATE_LOCK_NOT_HELD/)
    await assert.rejects(() => assertCurrentServingProjectionUpdateLock({
      market: 'US', owner: 'update_latest:123:fixture', query: query(usClient),
    }), /UPDATE_LOCK_OWNER_INVALID/)
    const queryPlan = await query(jpClient)<{ detail: string }>(
      `EXPLAIN QUERY PLAN ${currentServingAdapterRowsSql(20_000)}`,
      [DATES.at(-1)!, 'ma_physics_v4', 'JP'],
    )
    const queryPlanText = queryPlan.map((row) => row.detail).join('\n')
    assert.match(queryPlanText, /snapshots_date_idx/)
    assert.match(queryPlanText, /sqlite_autoindex_daily_snapshots_1/)
    assert.doesNotMatch(queryPlanText, /SCAN prior\b/)
    const jp = await loadCurrentServingMarketProjection({
      market: 'JP', query: query(jpClient), priceBasis: 'jp-split-normalized-v1',
      featureSet: 'ma_physics_v4', deadlineMs,
    })
    const us = await loadCurrentServingMarketProjection({
      market: 'US', query: query(usClient), priceBasis: 'tiingo_adj_ohlc_ratio_v1',
      featureSet: 'ma_physics_v4', deadlineMs,
    })
    assert.equal(jp.rows.length, 2)
    assert.equal(us.rows.length, 2)
    assert.equal(jp.watermark.eligibleRows, jp.rows.length)
    assert.equal(jp.watermark.universeRows, 2)
    assert.equal(jp.watermark.universeIdentityRows, 2)
    assert.equal(jp.watermark.closeRows, 2)
    assert.equal(jp.watermark.mlRows, 2)
    assert.equal(jp.watermark.smaRows, 2)
    assert.equal(jp.watermark.physicalRows, 2)
    assert.equal(jp.rows.find((row) => row.ticker === 'AAA')?.stage.sequence2, '211111>311111')
    assert.equal(jp.rows.find((row) => row.ticker === 'AAA')?.stage.sequence3, '111111>211111>311111')
    assert.equal(jp.rows.find((row) => row.ticker === 'AAA')?.stage.cAge, 2)
    assert.equal(jp.rows.find((row) => row.ticker === 'BBB')?.stage.sequence2, null,
      'an invalid continuity boundary must not be bridged')
    assert.equal(jp.rows.find((row) => row.ticker === 'BBB')?.stage.cAge, null,
      'a current Serving ticker with a missing cAge must remain visible with explicit null coverage')

    await run(jpClient, `UPDATE daily_snapshots
      SET date = CASE date
        WHEN '2026-10-19' THEN '2026-01-01'
        WHEN '2026-10-20' THEN '2026-01-02'
        WHEN '2026-10-21' THEN '2026-01-03'
      END
      WHERE ticker = 'AAA' AND date IN ('2026-10-19','2026-10-20','2026-10-21')`)
    const gapBounded = await loadCurrentServingMarketProjection({
      market: 'JP', query: query(jpClient), priceBasis: 'jp-split-normalized-v1',
      featureSet: 'ma_physics_v4', deadlineMs: Date.now() + 60_000,
    })
    assert.equal(gapBounded.rows.find((row) => row.ticker === 'AAA')?.stage.sequence2, null,
      'a greater-than-60-day continuity boundary must not be bridged')
    await run(jpClient, `UPDATE daily_snapshots
      SET date = CASE date
        WHEN '2026-01-01' THEN '2026-10-19'
        WHEN '2026-01-02' THEN '2026-10-20'
        WHEN '2026-01-03' THEN '2026-10-21'
      END
      WHERE ticker = 'AAA' AND date IN ('2026-01-01','2026-01-02','2026-01-03')`)

    const store = path.join(temporary, 'store')
    stageCurrentServingMarket({ root: store, stage: stageFor('JP', jp) })
    fs.rmSync(path.join(store, 'market-stages', 'JP', 'CURRENT.json'))
    stageCurrentServingMarket({ root: store, stage: stageFor('JP', jp) })
    assert.equal(readCurrentServingMarketStage({ root: store, market: 'JP' }).rows.length, 2,
      'a verified orphan market stage must be selected idempotently after interruption')
    assert.equal(fs.existsSync(path.join(store, 'CURRENT.json')), false,
      'one completed market must not publish a partial combined generation')
    stageCurrentServingMarket({ root: store, stage: stageFor('US', us) })
    const published = publishCurrentServingProjectionFromStages({
      root: store,
      now: () => new Date('2026-10-26T00:00:00.000Z'),
    })
    assert.equal(published.alreadyPublished, false)
    const payload = readCurrentServingProjection({ root: store })
    assert.equal(payload.rows.length, 4)
    assert.equal(payload.marketWatermarks.JP.priceBasis, 'jp-split-normalized-v1')
    assert.equal(payload.marketWatermarks.US.priceBasis, 'tiingo_adj_ohlc_ratio_v1')
    const currentBefore = fs.readFileSync(path.join(store, 'CURRENT.json'), 'utf8')
    fs.rmSync(path.join(store, 'CURRENT.json'))
    const adopted = publishCurrentServingProjectionFromStages({
      root: store,
      now: () => new Date('2026-10-26T00:00:00.000Z'),
    })
    assert.equal(adopted.alreadyPublished, false)
    assert.equal(fs.readFileSync(path.join(store, 'CURRENT.json'), 'utf8'), currentBefore,
      'a verified orphan combined generation must be selected idempotently after interruption')
    const repeated = publishCurrentServingProjectionFromStages({
      root: store,
      now: () => new Date('2026-10-26T00:00:00.000Z'),
    })
    assert.equal(repeated.alreadyPublished, true)
    assert.equal(fs.readFileSync(path.join(store, 'CURRENT.json'), 'utf8'), currentBefore)

    const staleStore = path.join(temporary, 'stale-store')
    const staleJp = stageFor('JP', jp)
    staleJp.stagedAt = '2026-10-01T00:00:00.000Z'
    stageCurrentServingMarket({ root: staleStore, stage: staleJp })
    stageCurrentServingMarket({ root: staleStore, stage: stageFor('US', us) })
    assert.throws(() => publishCurrentServingProjectionFromStages({
      root: staleStore,
      now: () => new Date('2026-10-26T00:00:00.000Z'),
    }), /STALE_MARKET_STAGE:JP/)
    assert.equal(fs.existsSync(path.join(staleStore, 'CURRENT.json')), false,
      'a stale market stage must not publish a combined generation')

    const staleAsOfStore = path.join(temporary, 'stale-as-of-store')
    const staleAsOfJp = stageFor('JP', jp)
    const staleAsOfUs = stageFor('US', us)
    staleAsOfJp.watermark.asOfTradingDate = '2026-10-01'
    staleAsOfJp.rows = staleAsOfJp.rows.map((row) => ({ ...row, asOfTradingDate: '2026-10-01' }))
    staleAsOfUs.watermark.asOfTradingDate = '2026-10-01'
    staleAsOfUs.rows = staleAsOfUs.rows.map((row) => ({ ...row, asOfTradingDate: '2026-10-01' }))
    stageCurrentServingMarket({ root: staleAsOfStore, stage: staleAsOfJp })
    stageCurrentServingMarket({ root: staleAsOfStore, stage: staleAsOfUs })
    assert.throws(() => publishCurrentServingProjectionFromStages({
      root: staleAsOfStore,
      now: () => new Date('2026-10-26T00:00:00.000Z'),
    }), /STALE_MARKET_STAGE:JP/)

    await run(jpClient, `UPDATE ml_feature_vectors_v2 SET stage_code = '611111' WHERE ticker = 'AAA' AND date = ?`, [DATES.at(-1)!])
    await assert.rejects(() => loadCurrentServingMarketProjection({
      market: 'JP', query: query(jpClient), priceBasis: 'jp-split-normalized-v1',
      featureSet: 'ma_physics_v4', deadlineMs: Date.now() + 60_000,
    }), /ML_STAGE_MISMATCH/)
    await run(jpClient, `UPDATE ml_feature_vectors_v2 SET stage_code = '311111' WHERE ticker = 'AAA' AND date = ?`, [DATES.at(-1)!])

    await run(jpClient, `UPDATE ml_feature_vectors_v2
      SET feature_json = json_set(feature_json, '$.timeSince.stageCodeAge', 99)
      WHERE ticker = 'AAA' AND date = ?`, [DATES.at(-1)!])
    await assert.rejects(() => loadCurrentServingMarketProjection({
      market: 'JP', query: query(jpClient), priceBasis: 'jp-split-normalized-v1',
      featureSet: 'ma_physics_v4', deadlineMs: Date.now() + 60_000,
    }), /C_AGE_CONTINUITY_MISMATCH/)
    await run(jpClient, `UPDATE ml_feature_vectors_v2
      SET feature_json = json_set(feature_json, '$.timeSince.stageCodeAge', 2)
      WHERE ticker = 'AAA' AND date = ?`, [DATES.at(-1)!])

    await run(jpClient, `UPDATE ml_feature_vectors_v2
      SET feature_json = json_set(feature_json, '$.timeSince.stageCodeAge', 1)
      WHERE ticker = 'AAA' AND date = ?`, [DATES.at(-1)!])
    await assert.rejects(() => loadCurrentServingMarketProjection({
      market: 'JP', query: query(jpClient), priceBasis: 'jp-split-normalized-v1',
      featureSet: 'ma_physics_v4', deadlineMs: Date.now() + 60_000,
    }), /C_AGE_CONTINUITY_MISMATCH/)
    await run(jpClient, `UPDATE ml_feature_vectors_v2
      SET feature_json = json_set(feature_json, '$.timeSince.stageCodeAge', 2)
      WHERE ticker = 'AAA' AND date = ?`, [DATES.at(-1)!])

    await run(jpClient, `UPDATE ml_feature_vectors_v2
      SET feature_json = json_set(feature_json, '$.timeSince.stageCodeAge', 0)
      WHERE ticker = 'AAA' AND date = ?`, [DATES.at(-1)!])
    await assert.rejects(() => loadCurrentServingMarketProjection({
      market: 'JP', query: query(jpClient), priceBasis: 'jp-split-normalized-v1',
      featureSet: 'ma_physics_v4', deadlineMs: Date.now() + 60_000,
    }), /C_AGE_CONTINUITY_MISMATCH/)
    await run(jpClient, `UPDATE ml_feature_vectors_v2
      SET feature_json = json_set(feature_json, '$.timeSince.stageCodeAge', 2)
      WHERE ticker = 'AAA' AND date = ?`, [DATES.at(-1)!])

    await run(jpClient, `UPDATE ticker_universe SET name = '' WHERE ticker = 'BBB'`)
    await assert.rejects(() => loadCurrentServingMarketProjection({
      market: 'JP', query: query(jpClient), priceBasis: 'jp-split-normalized-v1',
      featureSet: 'ma_physics_v4', deadlineMs: Date.now() + 60_000,
    }), /SOURCE_INCOMPLETE/)
    await run(jpClient, `UPDATE ticker_universe SET name = 'Boundary' WHERE ticker = 'BBB'`)

    await run(jpClient, `INSERT INTO ticker_universe VALUES('CCC','Missing snapshot',1)`)
    await assert.rejects(() => loadCurrentServingMarketProjection({
      market: 'JP', query: query(jpClient), priceBasis: 'jp-split-normalized-v1',
      featureSet: 'ma_physics_v4', deadlineMs: Date.now() + 60_000,
    }), /SOURCE_INCOMPLETE/)
    await run(jpClient, `DELETE FROM ticker_universe WHERE ticker = 'CCC'`)

    await run(jpClient, `DELETE FROM ohlcv_daily WHERE ticker = 'BBB' AND date = ?`, [DATES.at(-1)!])
    await assert.rejects(() => loadCurrentServingMarketProjection({
      market: 'JP', query: query(jpClient), priceBasis: 'jp-split-normalized-v1',
      featureSet: 'ma_physics_v4', deadlineMs: Date.now() + 60_000,
    }), /SOURCE_INCOMPLETE/)
    await run(jpClient, `INSERT INTO ohlcv_daily VALUES('BBB',?,114)`, [DATES.at(-1)!])

    await run(usClient, `UPDATE us_analytics_metadata SET value = 'wrong-basis' WHERE key = 'ohlcv_price_basis'`)
    await assert.rejects(() => loadCurrentServingMarketProjection({
      market: 'US', query: query(usClient), priceBasis: 'tiingo_adj_ohlc_ratio_v1',
      featureSet: 'ma_physics_v4', deadlineMs: Date.now() + 60_000,
    }), /SOURCE_PRICE_BASIS_MISMATCH/)
    await run(usClient, `UPDATE us_analytics_metadata SET value = 'tiingo_adj_ohlc_ratio_v1'
      WHERE key = 'ohlcv_price_basis'`)
    await assert.rejects(() => loadCurrentServingMarketProjection({
      market: 'JP', query: query(jpClient), priceBasis: 'unattested-basis',
      featureSet: 'ma_physics_v4', deadlineMs: Date.now() + 60_000,
    }), /PRICE_BASIS_CONTRACT_MISMATCH/)

    await run(jpClient, `UPDATE physical_momentum_metrics SET date = '2026-10-18' WHERE symbol = 'BBB'`)
    await assert.rejects(() => loadCurrentServingMarketProjection({
      market: 'JP', query: query(jpClient), priceBasis: 'jp-split-normalized-v1',
      featureSet: 'ma_physics_v4', deadlineMs: Date.now() + 60_000,
    }), /SOURCE_INCOMPLETE/)
    await run(jpClient, `UPDATE physical_momentum_metrics SET date = ? WHERE symbol = 'BBB'`, [DATES.at(-1)!])

    await run(jpClient, `UPDATE physical_momentum_metrics SET date = '2026-10-18'`)
    await assert.rejects(() => loadCurrentServingMarketProjection({
      market: 'JP', query: query(jpClient), priceBasis: 'jp-split-normalized-v1',
      featureSet: 'ma_physics_v4', deadlineMs: Date.now() + 60_000,
    }), /SOURCE_DATE_MISMATCH/)
    await run(jpClient, `UPDATE physical_momentum_metrics SET date = ?`, [DATES.at(-1)!])

    let watermarkReads = 0
    const baseQuery = query(jpClient)
    const changingQuery: CurrentServingQuery = async <T extends Record<string, unknown>>(
      sql: string,
      args: readonly (string | number | null)[] = [],
    ): Promise<T[]> => {
      if (sql.includes('WITH snapshot_max')) watermarkReads += 1
      const rows = await baseQuery<T>(sql, args)
      if (watermarkReads === 1 && sql.includes('WITH RECURSIVE')) {
        await run(jpClient, `UPDATE daily_snapshots SET computed_at = computed_at + 1 WHERE date = ?`, [DATES.at(-1)!])
      }
      return rows
    }
    await assert.rejects(() => loadCurrentServingMarketProjection({
      market: 'JP', query: changingQuery, priceBasis: 'jp-split-normalized-v1',
      featureSet: 'ma_physics_v4', deadlineMs: Date.now() + 60_000,
    }), /SOURCE_GENERATION_CHANGED/)

    await assert.rejects(() => loadCurrentServingMarketProjection({
      market: 'JP', query: query(jpClient), priceBasis: 'jp-split-normalized-v1',
      featureSet: 'ma_physics_v4', deadlineMs: Date.now() - 1,
    }), /DEADLINE_EXCEEDED/)
    assert.equal(fs.readFileSync(path.join(store, 'CURRENT.json'), 'utf8'), currentBefore,
      'source changes and timeouts must preserve the prior combined generation')

    console.log(JSON.stringify({
      status: 'PASS',
      markets: { JP: jp.rows.length, US: us.rows.length },
      regimeCompressed: true,
      invalidBoundaryBridged: false,
      atomicCombinedPublication: true,
      oldGenerationProtected: true,
      staleMarketFailsClosed: true,
      sourceGenerationChangeFailsClosed: true,
      auxiliaryGenerationStalenessFailsClosed: true,
      auxiliaryCoverageFailsClosed: true,
      mlStageParityEnforced: true,
      cAgeContinuityEnforced: true,
      longGapContinuityBoundaryEnforced: true,
      interruptionAdoptionIdempotent: true,
      processGroupDeadlineEnforced: true,
      pinnedRunnerAttestation: true,
      updateLockAttested: true,
      boundedQueryPlan: true,
    }, null, 2))
  } finally {
    for (const client of clients) client.close()
    fs.rmSync(temporary, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
