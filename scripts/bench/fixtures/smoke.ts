import { createRequire } from 'node:module'

/** Pipeline self-check fixture: a tiny ticker universe on top of the application's own schema. */
export const version = 1

interface SqliteDatabase {
  exec(sql: string): void
  prepare(sql: string): { run(...values: Array<string | number>): unknown }
  close(): void
}

export async function build(options: {
  dbPath: string
  params: Record<string, number | string | boolean>
  log(message: string): void
}): Promise<void> {
  const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as {
    DatabaseSync: new (path: string) => SqliteDatabase
  }
  const count = Number(options.params.tickers ?? 2_000)
  const db = new DatabaseSync(options.dbPath)
  try {
    const insert = db.prepare('INSERT OR REPLACE INTO ticker_universe (ticker, name, active) VALUES (?, ?, 1)')
    db.exec('BEGIN')
    for (let index = 0; index < count; index += 1) insert.run(String(1000 + index), `Smoke Company ${index}`)
    db.exec('COMMIT')
  } finally {
    db.close()
  }
  options.log(`inserted ${count} tickers`)
}
