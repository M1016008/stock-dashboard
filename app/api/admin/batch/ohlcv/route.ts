// app/api/admin/batch/ohlcv/route.ts
// バックグラウンドで OHLCV フェッチバッチを起動する。
// 子プロセスとして spawn し、Next の HTTP タイムアウトを越えても継続できるよう detached + unref()。
//
// レスポンスはすぐ返り、進行状況は GET /api/admin/batch/runs をポーリングして確認する。

import { NextResponse } from 'next/server'
import { spawn } from 'node:child_process'
import path from 'node:path'

export const dynamic = 'force-dynamic'

export async function POST() {
  const child = spawn('npx', ['tsx', 'scripts/batch-ohlcv.ts'], {
    cwd: process.cwd(),
    detached: true,
    stdio: 'ignore',
    env: process.env,  // .env.local 由来の TURSO_* を子に継承
  })
  child.unref()

  return NextResponse.json({
    started: true,
    pid: child.pid,
    script: path.join('scripts', 'batch-ohlcv.ts'),
  })
}
