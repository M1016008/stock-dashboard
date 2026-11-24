// lib/storage/sqlite-cli-read.ts
//
// Arguments for reading a local SQLite database with the sqlite3 command line tool.
// macOS's /usr/bin/sqlite3 (3.51.0, Apple build) fails with SQLITE_CANTOPEN (14) when it opens a
// WAL database read-only (`-readonly` or `file:…?mode=ro`) while no other connection has it open,
// because the -wal/-shm files are then absent and that build will not create them. This caused the
// 2026-11-08 weekly US failure (the .building shadow between child jobs) and the db-maintenance
// failures since 2026-11-20 (the US analytics DB, no longer held open by any process).
//
// Instead: open the existing file read-write (`mode=rw` never creates a missing file) and make the
// connection query-only, so SQL cannot change the database while SQLite may create the -wal/-shm
// under its normal locks. Callers guard external storage before calling (the -wal/-shm are files).

function sqliteUri(dbPath: string): string {
  return `file:${dbPath.split('/').map(encodeURIComponent).join('/')}?mode=rw`
}

// Put the caller's output options (such as -json) first, then these, then the SQL.
export function sqliteCliReadArgs(dbPath: string, timeoutMs = 30_000): string[] {
  if (!dbPath.startsWith('/')) throw new Error('sqlite_cli_read_requires_absolute_path')
  return ['-cmd', `.timeout ${timeoutMs}`, '-cmd', 'PRAGMA query_only=1', sqliteUri(dbPath)]
}
