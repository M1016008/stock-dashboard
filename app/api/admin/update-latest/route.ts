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
  if (!process.env.JQUANTS_API_KEY) {
    return NextResponse.json(
      { started: false, error: 'JQUANTS_API_KEY is not set' },
      { status: 412 },
    )
  }

  const freshness = await getDataFreshness()
  if (freshness.running) {
    return NextResponse.json({ started: false, running: true, freshness })
  }
  if (!freshness.needsUpdate) {
    return NextResponse.json({ started: false, running: false, freshness })
  }

  const child = spawn('npx', ['tsx', '--env-file=.env.local', 'scripts/update-latest.ts'], {
    cwd: process.cwd(),
    detached: true,
    stdio: 'ignore',
    env: {
      ...process.env,
      USE_LOCAL_DB: '1',
    },
  })
  child.unref()

  return NextResponse.json({
    started: true,
    pid: child.pid,
    script: path.join('scripts', 'update-latest.ts'),
    freshness,
  })
}
