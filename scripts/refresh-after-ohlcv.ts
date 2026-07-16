// scripts/refresh-after-ohlcv.ts
//
// OHLCV 取得後に、画面が参照する daily_snapshots と dashboard_cache を即時更新する。
// 株価だけ 1 日進んでステージ/ダッシュボードが前営業日のまま残る状態を防ぐ。

import { spawn } from 'node:child_process'
import { eq } from 'drizzle-orm'
import { db } from '@/lib/db/client'
import { batchRuns } from '@/lib/db/schema'
import { getDataFreshness } from '@/lib/server/data-freshness'
import { acquireUpdateLock } from '@/lib/server/update-lock'

type RunResult = {
  code: number | null
  signal: NodeJS.Signals | null
}

type FreshnessSummary = {
  expectedTradingDate: string
  latestOhlcvDate: string | null
  latestSnapshotDate: string | null
  latestFeatureDate: string | null
  latestModelFeatureDate: string | null
  latestMlFeatureDate: string | null
  latestMlCandidateDate: string | null
  latestMlPredictionDate: string | null
  latestMlPhysicsFeatureDate: string | null
  latestMlPhysicsCandidateDate: string | null
  latestMlSimilarDate: string | null
  latestDashboardCacheDate: string | null
  latestPhysicalMomentumDate: string | null
  latestPhysicalMomentumScoreDate: string | null
  needsSnapshotUpdate: boolean
  needsPhysicalMomentumUpdate: boolean
  needsFeatureUpdate: boolean
  needsModelFeatureUpdate: boolean
  needsMlFeatureUpdate: boolean
  needsMlCandidateUpdate: boolean
  needsMlPredictionUpdate: boolean
  needsMlPhysicsFeatureUpdate: boolean
  needsMlPhysicsCandidateUpdate: boolean
  needsMlSimilarUpdate: boolean
  needsDashboardCacheUpdate: boolean
}

function summarizeFreshness(freshness: Awaited<ReturnType<typeof getDataFreshness>>): FreshnessSummary {
  return {
    expectedTradingDate: freshness.expectedTradingDate,
    latestOhlcvDate: freshness.latestOhlcvDate,
    latestSnapshotDate: freshness.latestSnapshotDate,
    latestFeatureDate: freshness.latestFeatureDate,
    latestModelFeatureDate: freshness.latestModelFeatureDate,
    latestMlFeatureDate: freshness.latestMlFeatureDate,
    latestMlCandidateDate: freshness.latestMlCandidateDate,
    latestMlPredictionDate: freshness.latestMlPredictionDate,
    latestMlPhysicsFeatureDate: freshness.latestMlPhysicsFeatureDate,
    latestMlPhysicsCandidateDate: freshness.latestMlPhysicsCandidateDate,
    latestMlSimilarDate: freshness.latestMlSimilarDate,
    latestDashboardCacheDate: freshness.latestDashboardCacheDate,
    latestPhysicalMomentumDate: freshness.latestPhysicalMomentumDate,
    latestPhysicalMomentumScoreDate: freshness.latestPhysicalMomentumScoreDate,
    needsSnapshotUpdate: freshness.needsSnapshotUpdate,
    needsPhysicalMomentumUpdate: freshness.needsPhysicalMomentumUpdate,
    needsFeatureUpdate: freshness.needsFeatureUpdate,
    needsModelFeatureUpdate: freshness.needsModelFeatureUpdate,
    needsMlFeatureUpdate: freshness.needsMlFeatureUpdate,
    needsMlCandidateUpdate: freshness.needsMlCandidateUpdate,
    needsMlPredictionUpdate: freshness.needsMlPredictionUpdate,
    needsMlPhysicsFeatureUpdate: freshness.needsMlPhysicsFeatureUpdate,
    needsMlPhysicsCandidateUpdate: freshness.needsMlPhysicsCandidateUpdate,
    needsMlSimilarUpdate: freshness.needsMlSimilarUpdate,
    needsDashboardCacheUpdate: freshness.needsDashboardCacheUpdate,
  }
}

type EnvOverrides = Record<string, string | undefined>

function envOrDefault(name: string, fallback: string): string {
  const value = process.env[name]?.trim()
  return value && value.length > 0 ? value : fallback
}

function runScript(script: string, envOverrides: EnvOverrides = {}): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn('npx', ['tsx', '--env-file=.env.local', script], {
      cwd: process.cwd(),
      stdio: 'inherit',
      env: {
        ...process.env,
        USE_LOCAL_DB: '1',
        BACKTEST_RECENT_DAYS: process.env.BACKTEST_RECENT_DAYS ?? '0',
        ...envOverrides,
      },
    })

    child.on('error', reject)
    child.on('close', (code, signal) => resolve({ code, signal }))
  })
}

async function runRequired(script: string, envOverrides: EnvOverrides = {}): Promise<void> {
  console.log(`\n▶ ${script}`)
  const result = await runScript(script, envOverrides)
  if (result.code !== 0) {
    throw new Error(`${script} failed: code=${result.code}, signal=${result.signal ?? 'none'}`)
  }
}

async function main(): Promise<void> {
  if (process.env.POST_OHLCV_REFRESH === '0') {
    console.log('Post-OHLCV refresh skipped: POST_OHLCV_REFRESH=0')
    return
  }

  const criticalOnly = process.env.REFRESH_AFTER_OHLCV_CRITICAL_ONLY === '1'
  const skipLock = process.env.REFRESH_AFTER_OHLCV_SKIP_LOCK === '1'
  const lock = skipLock ? null : await acquireUpdateLock('post_ohlcv_refresh')
  if (!skipLock && !lock) {
    console.log('Post-OHLCV refresh skipped: post_ohlcv_refresh lock is already active')
    return
  }

  const [run] = await db
    .insert(batchRuns)
    .values({
      jobType: 'post_ohlcv_refresh',
      startedAt: new Date(),
      status: 'running',
    })
    .returning({ id: batchRuns.id })

  const runId = run.id

  try {
    const before = await getDataFreshness()
    console.log('Post-OHLCV freshness before:', summarizeFreshness(before))

    if (before.needsSnapshotUpdate) {
      await runRequired('scripts/batch-snapshots.ts')
      await lock?.heartbeat()
    } else {
      console.log('Snapshots are already fresh after OHLCV fetch')
    }

    await runRequired('scripts/batch-physical-momentum.ts', {
      // OHLCV直後の追随更新は直近日数に限定する。全期間再計算は週次ML/メンテナンスへ分離。
      PMS_RECENT_DAYS: envOrDefault('PMS_DAILY_RECENT_DAYS', '420'),
    })
    await lock?.heartbeat()

    const afterSnapshots = await getDataFreshness()
    if (afterSnapshots.needsFeatureUpdate) {
      await runRequired('scripts/batch-features.ts')
      await lock?.heartbeat()
    } else {
      console.log('Feature snapshots are already fresh after OHLCV fetch')
    }

    const afterFeatures = await getDataFreshness()
    let rebuiltModelFeatures = false
    if (afterFeatures.needsModelFeatureUpdate) {
      await runRequired('scripts/batch-weekly-ohlcv.ts')
      await lock?.heartbeat()
      await runRequired('scripts/batch-technical-signals.ts')
      await lock?.heartbeat()
      if (criticalOnly) {
        console.log('serving backtest build skipped in critical-only refresh')
      } else {
        await runRequired('scripts/build-serving-backtest.ts')
        await lock?.heartbeat()
      }
      rebuiltModelFeatures = true
    } else {
      console.log('Model features and technical signals are already fresh after OHLCV fetch')
    }

    const afterModelFeatures = await getDataFreshness()
    const needsAnyMlRefresh =
      afterModelFeatures.needsMlFeatureUpdate
      || afterModelFeatures.needsMlCandidateUpdate
      || afterModelFeatures.needsMlPredictionUpdate
      || afterModelFeatures.needsMlPhysicsFeatureUpdate
      || afterModelFeatures.needsMlPhysicsCandidateUpdate
      || afterModelFeatures.needsMlSimilarUpdate
    if (criticalOnly) {
      console.log('ML refresh skipped in critical-only refresh')
    } else if (needsAnyMlRefresh) {
      await runRequired('scripts/batch-ml-features.ts', {
        ML_RECENT_DAYS: envOrDefault('ML_DAILY_RECENT_DAYS', '5'),
        ML_MIN_HISTORY_DAYS: envOrDefault('ML_DAILY_MIN_HISTORY_DAYS', '220'),
        ML_START_DATE: process.env.ML_FULL_START_DATE ?? '1900-01-01',
      })
      await lock?.heartbeat()
      await runRequired('scripts/batch-ml-labels.ts', {
        ML_LABEL_RECENT_DAYS: envOrDefault('ML_DAILY_LABEL_RECENT_DAYS', '30'),
      })
      await lock?.heartbeat()
      await runRequired('scripts/batch-ml-outcomes.ts')
      await lock?.heartbeat()
      await runRequired('scripts/batch-ml-train.ts', {
        ML_TRAIN_START_DATE: process.env.ML_DAILY_TRAIN_START_DATE ?? '1900-01-01',
        ML_TRAIN_SAMPLE_MODE: process.env.ML_DAILY_TRAIN_SAMPLE_MODE ?? 'all_paged',
        ML_TRAIN_LABEL_SOURCE: process.env.ML_DAILY_TRAIN_LABEL_SOURCE ?? 'extrema',
        ML_TRAIN_LIMIT: process.env.ML_DAILY_TRAIN_LIMIT ?? process.env.ML_TRAIN_LIMIT ?? '0',
      })
      await lock?.heartbeat()
      await runRequired('scripts/batch-ml-candidates.ts')
      await lock?.heartbeat()
      await runRequired('scripts/batch-ml-predict.ts')
      await lock?.heartbeat()
      await runRequired('scripts/batch-forward-extrema.ts', {
        FORWARD_EXTREMA_HORIZONS: process.env.ML_PHYSICS_EXTREMA_HORIZONS ?? '5,10,15,20,40,60,90',
        BACKTEST_RECENT_DAYS: process.env.ML_PHYSICS_EXTREMA_RECENT_DAYS ?? process.env.BACKTEST_RECENT_DAYS ?? '60',
        FORWARD_EXTREMA_START_DATE: process.env.ML_FULL_START_DATE ?? '1900-01-01',
        FORWARD_EXTREMA_WRITE_MODEL_LABELS: '0',
      })
      await lock?.heartbeat()
      await runRequired('scripts/batch-ml-context-features.ts', {
        ML_CONTEXT_RECENT_DAYS: envOrDefault('ML_CONTEXT_DAILY_RECENT_DAYS', '5'),
        ML_CONTEXT_START_DATE: process.env.ML_FULL_START_DATE ?? '1900-01-01',
      })
      await lock?.heartbeat()
      await runRequired('scripts/batch-ml-physics-features.ts', {
        ML_PHYSICS_RECENT_DAYS: envOrDefault('ML_PHYSICS_DAILY_RECENT_DAYS', '5'),
        ML_PHYSICS_MIN_HISTORY_DAYS: envOrDefault('ML_PHYSICS_DAILY_MIN_HISTORY_DAYS', '220'),
        ML_PHYSICS_START_DATE: process.env.ML_FULL_START_DATE ?? '1900-01-01',
      })
      await lock?.heartbeat()
      await runRequired('scripts/batch-ml-short-labels.ts', {
        ML_SHORT_LABEL_RECENT_DAYS: envOrDefault('ML_DAILY_RL_RECENT_DAYS', '60'),
        ML_SHORT_LABEL_START_DATE: process.env.ML_FULL_START_DATE ?? '1900-01-01',
        ML_SHORT_WRITE_RL_STATES: process.env.ML_SHORT_DAILY_WRITE_RL_STATES ?? '1',
      })
      await lock?.heartbeat()
      await runRequired('scripts/batch-ml-physics-train.ts', {
        ML_PHYSICS_TRAIN_START_DATE: process.env.ML_PHYSICS_DAILY_TRAIN_START_DATE ?? '1900-01-01',
        ML_PHYSICS_TRAIN_SAMPLE_MODE: process.env.ML_PHYSICS_DAILY_TRAIN_SAMPLE_MODE ?? 'all_paged',
        ML_PHYSICS_TRAIN_LIMIT: process.env.ML_PHYSICS_DAILY_TRAIN_LIMIT ?? process.env.ML_PHYSICS_TRAIN_LIMIT ?? '0',
      })
      await lock?.heartbeat()
      await runRequired('scripts/batch-ml-physics-candidates.ts')
      await lock?.heartbeat()
      await runRequired('scripts/build-serving-ml-insights.ts')
      await lock?.heartbeat()
      await runRequired('scripts/batch-ml-similarity-evaluate.ts')
      await lock?.heartbeat()
      await runRequired('scripts/batch-ml-rl-policy.ts', {
        ML_RL_RECENT_DAYS: envOrDefault('ML_DAILY_RL_RECENT_DAYS', '60'),
        ML_RL_START_DATE: process.env.ML_FULL_START_DATE ?? '1900-01-01',
      })
      await lock?.heartbeat()
      await runRequired('scripts/batch-ml-feature-health.ts')
      await lock?.heartbeat()
    } else {
      console.log('ML feature vectors and candidates are already fresh after OHLCV fetch')
    }

    const afterMl = await getDataFreshness()
    if (
      afterMl.needsMlCandidateUpdate
      || afterMl.needsMlPredictionUpdate
      || afterMl.needsMlSimilarUpdate
      || afterMl.needsMlPhysicsCandidateUpdate
    ) {
      await runRequired('scripts/batch-ml-candidates.ts')
      await lock?.heartbeat()
      await runRequired('scripts/batch-ml-predict.ts')
      await lock?.heartbeat()
      await runRequired('scripts/batch-ml-physics-candidates.ts')
      await lock?.heartbeat()
      await runRequired('scripts/build-serving-ml-insights.ts')
      await lock?.heartbeat()
      await runRequired('scripts/batch-ml-similarity-evaluate.ts')
      await lock?.heartbeat()
      await runRequired('scripts/batch-ml-rl-policy.ts', {
        ML_RL_RECENT_DAYS: envOrDefault('ML_DAILY_RL_RECENT_DAYS', '60'),
        ML_RL_START_DATE: process.env.ML_FULL_START_DATE ?? '1900-01-01',
      })
      await lock?.heartbeat()
      await runRequired('scripts/batch-ml-feature-health.ts')
      await lock?.heartbeat()
    }

    const beforeCache = await getDataFreshness()
    if (beforeCache.needsDashboardCacheUpdate || rebuiltModelFeatures) {
      await runRequired('scripts/build-dashboard-cache.ts')
      await lock?.heartbeat()
    } else {
      console.log('Dashboard cache is already fresh after OHLCV fetch')
    }

    const after = await getDataFreshness()
    console.log('Post-OHLCV freshness after:', summarizeFreshness(after))

    if (
      after.needsSnapshotUpdate
      || after.needsFeatureUpdate
      || after.needsModelFeatureUpdate
      || after.needsDashboardCacheUpdate
      || (!criticalOnly && (
        after.needsMlFeatureUpdate
        || after.needsMlCandidateUpdate
        || after.needsMlPredictionUpdate
        || after.needsMlPhysicsFeatureUpdate
        || after.needsMlPhysicsCandidateUpdate
        || after.needsMlSimilarUpdate
      ))
    ) {
      throw new Error('Post-OHLCV refresh did not complete snapshot/feature/cache freshness')
    }

    await db
      .update(batchRuns)
      .set({
        finishedAt: new Date(),
        status: 'success',
        succeeded: 1,
        rowsInserted: Number(before.latestSnapshotDate !== after.latestSnapshotDate),
        errorSummary: null,
      })
      .where(eq(batchRuns.id, runId))
  } catch (err) {
    await db
      .update(batchRuns)
      .set({
        finishedAt: new Date(),
        status: 'failed',
        failed: 1,
        errorSummary: err instanceof Error ? err.message : String(err),
      })
      .where(eq(batchRuns.id, runId))
    throw err
  } finally {
    await lock?.release()
  }
}

main().catch((err) => {
  console.error('Fatal:', err)
  process.exit(1)
})
