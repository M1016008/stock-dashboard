import { createClient } from '@libsql/client'
import { createRequire } from 'node:module'
import { performance } from 'node:perf_hooks'

/**
 * Observes SQL issued through @libsql/client without touching application code.
 *
 * The probe wraps the prototype methods of the concrete client/transaction
 * classes. Both code trees resolve @libsql/client to the same realpath, so one
 * probe observes whichever tree the worker imported. Plans are captured later
 * (outside any timed region) through a separate read-only connection.
 */

export interface SqlShapeStats {
  readonly sql: string
  count: number
  totalMs: number
  maxMs: number
  rows: number
  firstArgs: readonly unknown[]
}

export interface SqlSnapshot {
  readonly statements: number
  readonly calls: number
  readonly totalMs: number
  readonly shapes: readonly SqlShapeStats[]
}

type AnyFunction = (...args: unknown[]) => unknown

interface Patched {
  readonly target: Record<string, unknown>
  readonly name: string
  readonly original: AnyFunction
}

const patched: Patched[] = []
let shapes = new Map<string, SqlShapeStats>()
let statements = 0
let calls = 0
let totalMs = 0

function normalize(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim()
}

function statementOf(input: unknown): { sql: string; args: readonly unknown[] } {
  if (typeof input === 'string') return { sql: input, args: [] }
  if (input && typeof input === 'object') {
    const candidate = input as { sql?: unknown; args?: unknown }
    const args = Array.isArray(candidate.args) ? candidate.args : candidate.args && typeof candidate.args === 'object'
      ? Object.values(candidate.args as Record<string, unknown>)
      : []
    return { sql: typeof candidate.sql === 'string' ? candidate.sql : '', args }
  }
  return { sql: '', args: [] }
}

function record(sql: string, args: readonly unknown[], ms: number, rows: number): void {
  const key = normalize(sql)
  let entry = shapes.get(key)
  if (!entry) {
    entry = { sql: key, count: 0, totalMs: 0, maxMs: 0, rows: 0, firstArgs: args.slice(0, 64) }
    shapes.set(key, entry)
  }
  entry.count += 1
  entry.totalMs += ms
  entry.maxMs = Math.max(entry.maxMs, ms)
  entry.rows += rows
  statements += 1
  totalMs += ms
}

function rowsOf(result: unknown): number {
  if (result && typeof result === 'object') {
    const rows = (result as { rows?: unknown }).rows
    if (Array.isArray(rows)) return rows.length
  }
  return 0
}

function wrapMethod(target: Record<string, unknown>, name: string, kind: 'single' | 'batch' | 'multiple'): void {
  const original = target[name]
  if (typeof original !== 'function') return
  const wrapped = async function (this: unknown, ...args: unknown[]) {
    const started = performance.now()
    calls += 1
    try {
      const result = await (original as AnyFunction).apply(this, args)
      const elapsed = performance.now() - started
      if (kind === 'single') {
        const statement = statementOf(args[0])
        record(statement.sql, args[1] !== undefined && Array.isArray(args[1]) ? args[1] : statement.args, elapsed, rowsOf(result))
      } else if (kind === 'batch') {
        const list = Array.isArray(args[0]) ? args[0] as unknown[] : []
        const perStatement = list.length > 0 ? elapsed / list.length : elapsed
        const results = Array.isArray(result) ? result : []
        list.forEach((item, index) => {
          const statement = statementOf(item)
          record(statement.sql, statement.args, perStatement, rowsOf(results[index]))
        })
      } else {
        record(typeof args[0] === 'string' ? args[0] : '', [], elapsed, 0)
      }
      return result
    } catch (error) {
      const elapsed = performance.now() - started
      const statement = kind === 'single' ? statementOf(args[0]) : { sql: '', args: [] }
      record(`ERROR ${statement.sql}`, statement.args, elapsed, 0)
      throw error
    }
  }
  patched.push({ target, name, original: original as AnyFunction })
  target[name] = wrapped
}

/** Idempotent. Call before the application creates its first client. */
export async function installSqlProbe(): Promise<void> {
  if (patched.length > 0) return
  const probeClient = createClient({ url: ':memory:' })
  try {
    const clientPrototype = Object.getPrototypeOf(probeClient) as Record<string, unknown>
    wrapMethod(clientPrototype, 'execute', 'single')
    wrapMethod(clientPrototype, 'batch', 'batch')
    wrapMethod(clientPrototype, 'executeMultiple', 'multiple')
    const transaction = await probeClient.transaction('read')
    const transactionPrototype = Object.getPrototypeOf(transaction) as Record<string, unknown>
    wrapMethod(transactionPrototype, 'execute', 'single')
    wrapMethod(transactionPrototype, 'batch', 'batch')
    transaction.close()
  } finally {
    probeClient.close()
  }
}

export function uninstallSqlProbe(): void {
  while (patched.length > 0) {
    const entry = patched.pop()!
    entry.target[entry.name] = entry.original
  }
}

export function resetSqlProbe(): void {
  shapes = new Map()
  statements = 0
  calls = 0
  totalMs = 0
}

export function snapshotSqlProbe(): SqlSnapshot {
  return {
    statements,
    calls,
    totalMs,
    shapes: [...shapes.values()].sort((left, right) => right.totalMs - left.totalMs),
  }
}

export interface PlanFlag {
  readonly sql: string
  readonly plan: readonly string[]
  readonly flags: readonly string[]
  readonly error?: string
}

interface SqliteStatement { all(...values: unknown[]): Array<Record<string, unknown>> }
interface SqliteDatabase { prepare(sql: string): SqliteStatement; close(): void }
interface SqliteModule { DatabaseSync: new (path: string, options?: { readOnly?: boolean }) => SqliteDatabase }

const PLAN_FLAG_PATTERNS: ReadonlyArray<readonly [string, RegExp]> = [
  ['FULL_TABLE_SCAN', /^SCAN (?!CONSTANT ROW)(?!.* USING )/],
  ['FULL_INDEX_SCAN', /^SCAN .* USING (?:COVERING )?INDEX/],
  ['TEMP_BTREE_SORT', /USE TEMP B-TREE FOR (?:ORDER BY|GROUP BY|DISTINCT|RIGHT PART OF ORDER BY)/],
  ['AUTOMATIC_INDEX', /AUTOMATIC (?:COVERING )?INDEX/],
  ['CORRELATED_SUBQUERY', /CORRELATED (?:SCALAR )?SUBQUERY/],
  ['BLOOM_FILTER', /BLOOM FILTER/],
  ['MATERIALIZE', /MATERIALIZE|CO-ROUTINE/],
]

/**
 * Plans every distinct statement shape on a separate read-only connection.
 * Statements that fail to prepare (DDL, writes, temp tables) are skipped.
 */
export function explainShapes(
  databasePath: string,
  snapshot: SqlSnapshot,
  limit = 40,
): PlanFlag[] {
  const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as SqliteModule
  const db = new DatabaseSync(databasePath, { readOnly: true })
  const output: PlanFlag[] = []
  try {
    for (const shape of snapshot.shapes.slice(0, limit)) {
      if (!/^\s*(WITH|SELECT)\b/i.test(shape.sql)) continue
      try {
        const args = shape.firstArgs.map((value) => (typeof value === 'bigint' ? Number(value) : value)) as unknown[]
        const plan = db.prepare(`EXPLAIN QUERY PLAN ${shape.sql}`).all(...args)
          .map((row) => String(row.detail ?? ''))
          .filter(Boolean)
        const flags = new Set<string>()
        for (const line of plan) {
          for (const [flag, pattern] of PLAN_FLAG_PATTERNS) if (pattern.test(line)) flags.add(flag)
        }
        output.push({ sql: shape.sql, plan, flags: [...flags] })
      } catch (error) {
        output.push({
          sql: shape.sql,
          plan: [],
          flags: ['PLAN_UNAVAILABLE'],
          error: error instanceof Error ? error.message.slice(0, 600) : String(error).slice(0, 600),
        })
      }
    }
  } finally {
    db.close()
  }
  return output
}
