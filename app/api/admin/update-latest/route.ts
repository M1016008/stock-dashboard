import { spawn } from 'node:child_process'
import path from 'node:path'
import { NextResponse } from 'next/server'
import { getDataFreshness } from '@/lib/server/data-freshness'

export const dynamic = 'force-dynamic'
export const revalidate = 0

export async function GET() {
  const freshness = await getDataFreshness()
  return NextResponse.json(freshness, {
    headers: {
      'Cache-Control': 'no-store',
    },
  })
}

export async function POST() {
  const freshness = await getDataFreshness()
  if (freshness.running) {
    return NextResponse.json({ started: false, running: true, freshness })
  }
  const needsCriticalRepair =
    freshness.needsSnapshotUpdate
    || freshness.needsDashboardCacheUpdate
    || freshness.needsFeatureUpdate
    || freshness.needsModelFeatureUpdate
  const needsCriticalUpdate = freshness.needsOhlcvUpdate || needsCriticalRepair

  if (!needsCriticalUpdate) {
    return NextResponse.json({
      started: false,
      running: false,
      nonCriticalStale: freshness.needsUpdate,
      freshness,
    })
  }

  const repairOnly = !freshness.needsOhlcvUpdate && needsCriticalRepair
  if (!repairOnly && !process.env.JQUANTS_API_KEY) {
    return NextResponse.json(
      { started: false, error: 'JQUANTS_API_KEY is not set', freshness },
      { status: 412 },
    )
  }

  const script = repairOnly ? 'scripts/refresh-after-ohlcv.ts' : 'scripts/update-latest.ts'
  const child = spawn('npx', ['tsx', '--env-file=.env.local', script], {
    cwd: process.cwd(),
    detached: true,
    stdio: 'ignore',
    env: {
      ...process.env,
      USE_LOCAL_DB: '1',
      UPDATE_LATEST_CRITICAL_ONLY: '1',
      REFRESH_AFTER_OHLCV_CRITICAL_ONLY: '1',
      SKIP_DAILY_ML: '1',
      SKIP_SERVING_BACKTEST: '1',
      BACKTEST_REBUILD_STATS: '0',
    },
  })
  child.unref()

  return NextResponse.json({
    started: true,
    pid: child.pid,
    script: path.join(script),
    repairOnly,
    freshness,
  })
}
