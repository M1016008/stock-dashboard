// lib/storage/sqlite-readonly-query.ts
//
// Read-only queries that do not depend on the -wal/-shm files being present.
// macOS's /usr/bin/sqlite3 (3.51.0, Apple build) fails with SQLITE_CANTOPEN (14) when it opens a
// WAL database read-only (`-readonly` or `file:…?mode=ro`) while no other connection has it open,
// because the -wal/-shm files are then absent and that build will not create them. The bundled
// SQLite of node:sqlite creates them for a read-only connection and reads under the normal locks.
// This caused the 2026-11-08 weekly US failure and the db-maintenance failures since 2026-11-20.
// @ts-expect-error The pinned Node types predate Node 24's built-in SQLite module.
import { DatabaseSync } from 'node:sqlite'

export type ReadOnlyQueryOptions = { timeoutMs?: number }

function text(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'bigint') return String(value)
  throw new Error('sqlite_readonly_query_unsupported_value')
}

// Runs each statement on one read-only connection and returns the first column of every row,
// in order (the same lines `sqlite3 db "<statements>"` prints for one-column results).
export function queryReadOnlyFirstColumn(
  dbPath: string,
  statements: readonly string[],
  options: ReadOnlyQueryOptions = {},
): string[] {
  const db = new DatabaseSync(dbPath, { readOnly: true, timeout: options.timeoutMs ?? 30_000 })
  try {
    const lines: string[] = []
    for (const statement of statements) {
      for (const row of db.prepare(statement).all() as Record<string, unknown>[]) lines.push(text(Object.values(row)[0]))
    }
    return lines
  } finally {
    db.close()
  }
}
