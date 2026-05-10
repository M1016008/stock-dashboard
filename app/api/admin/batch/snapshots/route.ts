// app/api/admin/batch/snapshots/route.ts
// バックグラウンドで snapshot 計算バッチを起動する。
import { NextResponse } from 'next/server'
import { spawn } from 'node:child_process'
import path from 'node:path'

export const dynamic = 'force-dynamic'

export async function POST() {
  const child = spawn('npx', ['tsx', 'scripts/batch-snapshots.ts'], {
    cwd: process.cwd(),
    detached: true,
    stdio: 'ignore',
    env: process.env,
  })
  child.unref()

  return NextResponse.json({
    started: true,
    pid: child.pid,
    script: path.join('scripts', 'batch-snapshots.ts'),
  })
}
