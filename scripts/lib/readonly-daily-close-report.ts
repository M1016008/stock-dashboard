import { spawn } from 'node:child_process'
import fs from 'node:fs'
import { isValidReportDate, type DailyCloseReport } from '@/lib/daily-close-report'
import { buildDailyCloseReportWith } from '@/lib/server/daily-close-report-core'

// 本番 SQLite から DailyCloseReport 相当を read-only で組み立てる検証用モジュール (scripts 専用)。
//
// 本番 DB はアプリの DB クライアント (lib/db/client) / external-storage-guard / node:sqlite を
// 一切経由せず、`sqlite3 -readonly -json` + `PRAGMA query_only=ON` の SELECT だけで読む。
// 組み立てロジックと SQL は本番と同じ lib/server/daily-close-report-core.ts を使う。
//
// 本番との意図的な差分:
// - execAll / execGet の実体: sqlite3 -readonly CLI
// - loadLargeHolderEvents: 本番 DB / 公開 snapshot を開かないため UNAVAILABLE 固定
//
// DB パスは READONLY_SQLITE_DB_PATH で明示指定する (推測しない)。

const SQLITE_TIMEOUT_MS = 20 * 60_000
const readonlyDbPath = process.env.READONLY_SQLITE_DB_PATH?.trim() ?? ''

export const READONLY_REPORT_CONSTRAINTS = {
  dbAccess: 'sqlite3 -readonly -json + PRAGMA query_only=ON (app DB client / external-storage-guard 不使用)',
  largeHolder: 'UNAVAILABLE 固定 (本番 DB / 公開 snapshot を開かないため。本番レポートとは異なる)',
} as const

function sqlLiteral(value: unknown): string {
  if (value == null) return 'NULL'
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  // 日付・評価 ID のみを想定。CLI の dot-command へ渡すため文字種を制限する
  if (typeof value === 'string' && /^[A-Za-z0-9_\-:. ]*$/.test(value)) return `'${value}'`
  throw new Error('unsupported sqlite parameter')
}

function runSqlite<T>(sql: string, args: readonly unknown[]): Promise<T[]> {
  if (!readonlyDbPath) return Promise.reject(new Error('READONLY_SQLITE_DB_PATH is required'))
  const input = [
    ...args.map((value, index) => `.parameter set ?${index + 1} "${sqlLiteral(value)}"`),
    'PRAGMA query_only=ON;',
    `${sql.trim()};`,
    '',
  ].join('\n')
  return new Promise((resolve, reject) => {
    const child = spawn('sqlite3', ['-readonly', '-json', readonlyDbPath], { shell: false, stdio: ['pipe', 'pipe', 'pipe'] })
    const timer = setTimeout(() => { child.kill('SIGTERM'); reject(new Error('sqlite3 timed out')) }, SQLITE_TIMEOUT_MS)
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => { stdout += chunk })
    child.stderr.on('data', (chunk: string) => { stderr += chunk })
    child.on('error', (error) => { clearTimeout(timer); reject(error) })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (code !== 0 || stderr.trim()) return reject(new Error(`sqlite3 failed (exit=${code}): ${stderr.trim().slice(0, 300)}`))
      const text = stdout.trim()
      try {
        resolve(text ? JSON.parse(text) as T[] : [])
      } catch {
        reject(new Error('sqlite3 returned invalid JSON'))
      }
    })
    child.stdin.end(input, 'utf8')
  })
}

// lib/db/client の execAll / execGet と同じ呼び出し形。実体は sqlite3 -readonly。
async function execAll<T>(sql: string, args: readonly unknown[] = []): Promise<T[]> {
  return runSqlite<T>(sql, args)
}

async function execGet<T>(sql: string, args: readonly unknown[] = []): Promise<T | undefined> {
  return (await runSqlite<T>(sql, args))[0]
}

// 対象 DB の実在・journal_mode=wal・parameter binding を確認する。満たさなければ throw。
export async function precheckReadonlyDatabase(): Promise<void> {
  if (!readonlyDbPath) throw new Error('READONLY_SQLITE_DB_PATH is required')
  if (!fs.existsSync(readonlyDbPath)) throw new Error('READONLY_SQLITE_DB_PATH does not exist')
  const [journal] = await runSqlite<{ journal_mode: string }>('PRAGMA journal_mode', [])
  if (String(journal?.journal_mode ?? '').toLowerCase() !== 'wal') throw new Error('journal_mode is not wal; aborting')
  const [probe] = await runSqlite<{ probe: unknown }>('SELECT ? AS probe', ['2000-01-01'])
  if (probe?.probe !== '2000-01-01') throw new Error('sqlite3 parameter binding probe failed')
}

export function isReportDate(value: string): boolean {
  return isValidReportDate(value)
}

// 意図的な差分: 本番 DB / 公開 snapshot を開かないため Large Holder は UNAVAILABLE 固定
async function loadLargeHolderEvents(): Promise<DailyCloseReport['events']['largeHolder']> {
  return { status: 'UNAVAILABLE', priceDate: null, events: [] }
}

export async function buildDailyCloseReport(input: { requestedDate?: string | null; watchlistTickers?: string[] }): Promise<DailyCloseReport> {
  return buildDailyCloseReportWith({ execAll, execGet, loadLargeHolderEvents }, input)
}
