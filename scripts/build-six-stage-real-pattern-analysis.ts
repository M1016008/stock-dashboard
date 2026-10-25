import fs from 'node:fs'
import path from 'node:path'
import {
  SIX_STAGE_REAL_ANALYSIS_DIRECTORY,
  SIX_STAGE_REAL_ANALYSIS_NAMESPACE,
  SIX_STAGE_REAL_ANALYSIS_SCHEMA_VERSION,
  SIX_STAGE_REAL_INPUTS,
  SIX_STAGE_REAL_RESEARCH_ROOT,
  SIX_STAGE_SOURCE_ADOPTION_SHA256,
  assertResearchOnlyExecution,
  assertSixStageRealInput,
  sha256File,
  type SixStageRealMarket,
} from '@/lib/research/six-stage-real-data-contract'
import { EVENT_PATH_HORIZONS, EVENT_PATH_THRESHOLDS } from '@/lib/research/six-stage-event-path-research'

type Statement = {
  iterate(...bindings: unknown[]): Iterable<Record<string, unknown>>
  run(...bindings: unknown[]): { changes: number | bigint }
  get(...bindings: unknown[]): Record<string, unknown> | undefined
}
type Database = { exec(sql: string): void; prepare(sql: string): Statement; close(): void }
const { DatabaseSync } = require('node:sqlite') as {
  DatabaseSync: new (databasePath: string, options?: { readOnly?: boolean }) => Database
}

type PassageCounts = { upHit: number; downHit: number; upFirst: number; downFirst: number; same: number; neither: number }
type HorizonAccumulator = {
  returns: number[]
  mfe: number[]
  mae: number[]
  passages: Record<number, PassageCounts>
}
type PatternAccumulator = {
  length: number
  sequenceKey: string
  population: number
  missingEntry: number
  invalidPrice: number
  rightCensored: number
  tickers: Map<number, number>
  years: Map<string, number>
  horizons: Record<number, HorizonAccumulator>
}

const COLUMNS = [
  'length', 'sequence_key', 'horizon', 'population_events', 'observed_events',
  'missing_entry', 'invalid_price', 'right_censored', 'ticker_count', 'year_count',
  'top_ticker_share', 'top_year_share', 'mean_return', 'median_return', 'q25_return',
  'q75_return', 'trimmed_mean_return', 'top_abs_1_contribution', 'top_abs_5_contribution',
  'mfe_median', 'mfe_q25', 'mfe_q75', 'mae_median', 'mae_q25', 'mae_q75',
  'positive_count', 'negative_count', 'zero_count',
  ...EVENT_PATH_THRESHOLDS.flatMap((threshold) => [
    `up_hit_${threshold}`, `down_hit_${threshold}`, `up_first_${threshold}`,
    `down_first_${threshold}`, `same_session_${threshold}`, `neither_${threshold}`,
    `up_hit_${threshold}_rate`, `down_hit_${threshold}_rate`, `up_first_${threshold}_rate`,
    `down_first_${threshold}_rate`,
  ]),
] as const

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function quantile(sorted: readonly number[], probability: number): number | null {
  if (!sorted.length) return null
  const position = (sorted.length - 1) * probability
  const lower = Math.floor(position)
  const upper = Math.ceil(position)
  return lower === upper
    ? sorted[lower]
    : sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower)
}

function mean(values: readonly number[]): number | null {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null
}

function trimmedMean(sorted: readonly number[], ratio = 0.01): number | null {
  if (!sorted.length) return null
  const trim = Math.floor(sorted.length * ratio)
  const values = trim * 2 < sorted.length ? sorted.slice(trim, sorted.length - trim) : sorted
  return mean(values)
}

function topContribution(values: readonly number[], ratio: number): number | null {
  if (!values.length) return null
  const absolute = values.map(Math.abs).sort((left, right) => right - left)
  const total = absolute.reduce((sum, value) => sum + value, 0)
  if (total === 0) return 0
  const count = Math.max(1, Math.ceil(absolute.length * ratio))
  return absolute.slice(0, count).reduce((sum, value) => sum + value, 0) / total
}

function concentration(values: Map<unknown, number>, total: number): number | null {
  if (!total || !values.size) return null
  return Math.max(...values.values()) / total
}

function emptyPassage(): PassageCounts {
  return { upHit: 0, downHit: 0, upFirst: 0, downFirst: 0, same: 0, neither: 0 }
}

function createAccumulator(length: number, sequenceKey: string): PatternAccumulator {
  return {
    length,
    sequenceKey,
    population: 0,
    missingEntry: 0,
    invalidPrice: 0,
    rightCensored: 0,
    tickers: new Map(),
    years: new Map(),
    horizons: Object.fromEntries(EVENT_PATH_HORIZONS.map((horizon) => [horizon, {
      returns: [],
      mfe: [],
      mae: [],
      passages: Object.fromEntries(EVENT_PATH_THRESHOLDS.map((threshold) => [threshold, emptyPassage()])),
    }])) as Record<number, HorizonAccumulator>,
  }
}

function addRow(group: PatternAccumulator, row: Record<string, unknown>): void {
  group.population += 1
  const tickerId = Number(row.ticker_id)
  const year = String(row.signal_year)
  group.tickers.set(tickerId, (group.tickers.get(tickerId) ?? 0) + 1)
  group.years.set(year, (group.years.get(year) ?? 0) + 1)
  const termination = String(row.termination_code)
  if (termination === 'MISSING_ENTRY') group.missingEntry += 1
  else if (termination === 'INVALID_PRICE') group.invalidPrice += 1
  else if (termination === 'RIGHT_CENSORED') group.rightCensored += 1

  for (const horizon of EVENT_PATH_HORIZONS) {
    const closeReturn = row[`close_return_${horizon}`]
    if (!finite(closeReturn)) continue
    const summary = group.horizons[horizon]
    summary.returns.push(closeReturn)
    const mfe = row[`mfe_${horizon}`]
    const mae = row[`mae_${horizon}`]
    if (finite(mfe)) summary.mfe.push(mfe)
    if (finite(mae)) summary.mae.push(mae)
    for (const threshold of EVENT_PATH_THRESHOLDS) {
      const upDay = row[`first_up_day_${threshold}`]
      const downDay = row[`first_down_day_${threshold}`]
      const up = finite(upDay) && upDay <= horizon
      const down = finite(downDay) && downDay <= horizon
      const passage = summary.passages[threshold]
      if (up) passage.upHit += 1
      if (down) passage.downHit += 1
      if (up && down && upDay === downDay) passage.same += 1
      else if (up && (!down || upDay < downDay)) passage.upFirst += 1
      else if (down && (!up || downDay < upDay)) passage.downFirst += 1
      else passage.neither += 1
    }
  }
}

function outputValues(group: PatternAccumulator, horizon: number): unknown[] {
  const summary = group.horizons[horizon]
  const returns = [...summary.returns].sort((left, right) => left - right)
  const mfe = [...summary.mfe].sort((left, right) => left - right)
  const mae = [...summary.mae].sort((left, right) => left - right)
  const observed = returns.length
  const values: unknown[] = [
    group.length,
    group.sequenceKey,
    horizon,
    group.population,
    observed,
    group.missingEntry,
    group.invalidPrice,
    group.population - observed - group.missingEntry - group.invalidPrice,
    group.tickers.size,
    group.years.size,
    concentration(group.tickers, group.population),
    concentration(group.years, group.population),
    mean(returns),
    quantile(returns, 0.5),
    quantile(returns, 0.25),
    quantile(returns, 0.75),
    trimmedMean(returns),
    topContribution(returns, 0.01),
    topContribution(returns, 0.05),
    quantile(mfe, 0.5),
    quantile(mfe, 0.25),
    quantile(mfe, 0.75),
    quantile(mae, 0.5),
    quantile(mae, 0.25),
    quantile(mae, 0.75),
    returns.filter((value) => value > 0).length,
    returns.filter((value) => value < 0).length,
    returns.filter((value) => value === 0).length,
  ]
  for (const threshold of EVENT_PATH_THRESHOLDS) {
    const passage = summary.passages[threshold]
    values.push(
      passage.upHit,
      passage.downHit,
      passage.upFirst,
      passage.downFirst,
      passage.same,
      passage.neither,
      observed ? passage.upHit / observed : null,
      observed ? passage.downHit / observed : null,
      observed ? passage.upFirst / observed : null,
      observed ? passage.downFirst / observed : null,
    )
  }
  return values
}

function schemaSql(): string {
  const passageColumns = EVENT_PATH_THRESHOLDS.flatMap((threshold) => [
    `up_hit_${threshold} INTEGER NOT NULL`,
    `down_hit_${threshold} INTEGER NOT NULL`,
    `up_first_${threshold} INTEGER NOT NULL`,
    `down_first_${threshold} INTEGER NOT NULL`,
    `same_session_${threshold} INTEGER NOT NULL`,
    `neither_${threshold} INTEGER NOT NULL`,
    `up_hit_${threshold}_rate REAL`,
    `down_hit_${threshold}_rate REAL`,
    `up_first_${threshold}_rate REAL`,
    `down_first_${threshold}_rate REAL`,
  ]).join(',\n')
  return `
    PRAGMA journal_mode=WAL;
    PRAGMA synchronous=NORMAL;
    PRAGMA temp_store=FILE;
    PRAGMA cache_size=-262144;
    CREATE TABLE metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL);
    CREATE TABLE pattern_summary(
      length INTEGER NOT NULL CHECK(length IN (2,3)),
      sequence_key TEXT NOT NULL,
      horizon INTEGER NOT NULL CHECK(horizon IN (5,10,15,20)),
      population_events INTEGER NOT NULL,
      observed_events INTEGER NOT NULL,
      missing_entry INTEGER NOT NULL,
      invalid_price INTEGER NOT NULL,
      right_censored INTEGER NOT NULL,
      ticker_count INTEGER NOT NULL,
      year_count INTEGER NOT NULL,
      top_ticker_share REAL,
      top_year_share REAL,
      mean_return REAL,median_return REAL,q25_return REAL,q75_return REAL,trimmed_mean_return REAL,
      top_abs_1_contribution REAL,top_abs_5_contribution REAL,
      mfe_median REAL,mfe_q25 REAL,mfe_q75 REAL,mae_median REAL,mae_q25 REAL,mae_q75 REAL,
      positive_count INTEGER NOT NULL,negative_count INTEGER NOT NULL,zero_count INTEGER NOT NULL,
      ${passageColumns},
      PRIMARY KEY(length,sequence_key,horizon)
    ) WITHOUT ROWID;
  `
}

function setMetadata(db: Database, key: string, value: unknown): void {
  db.prepare('INSERT INTO metadata(key,value) VALUES(?,?)').run(key, typeof value === 'string' ? value : JSON.stringify(value))
}

function buildMarket(market: SixStageRealMarket): { market: SixStageRealMarket; file: string; sha256: string; patterns: number; rows: number; elapsedMs: number } {
  const input = SIX_STAGE_REAL_INPUTS[market]
  const manifest = assertSixStageRealInput(market)
  const startedAt = Date.now()
  fs.mkdirSync(SIX_STAGE_REAL_ANALYSIS_DIRECTORY, { recursive: true })
  const finalPath = path.join(SIX_STAGE_REAL_ANALYSIS_DIRECTORY, `${market.toLowerCase()}-pattern-analysis.sqlite`)
  const temporaryPath = `${finalPath}.incomplete`
  if (fs.existsSync(finalPath)) {
    const existing = new DatabaseSync(finalPath, { readOnly: true })
    try {
      const status = existing.prepare("SELECT value FROM metadata WHERE key='status'").get()?.value
      const sourceHash = existing.prepare("SELECT value FROM metadata WHERE key='event_store_sha256'").get()?.value
      if (status === 'COMPLETE' && sourceHash === input.expectedEventStoreSha256) {
        const patterns = Number(existing.prepare('SELECT COUNT(DISTINCT length || char(31) || sequence_key) AS count FROM pattern_summary').get()?.count ?? 0)
        const rows = Number(existing.prepare('SELECT COUNT(*) AS count FROM pattern_summary').get()?.count ?? 0)
        return { market, file: finalPath, sha256: sha256File(finalPath), patterns, rows, elapsedMs: 0 }
      }
    } finally {
      existing.close()
    }
    throw new Error(`${market} analysis index exists but does not match fixed input`)
  }
  if (fs.existsSync(temporaryPath)) fs.rmSync(temporaryPath)

  const source = new DatabaseSync(input.eventStorePath, { readOnly: true })
  const output = new DatabaseSync(temporaryPath)
  try {
    source.exec('PRAGMA query_only=ON; PRAGMA trusted_schema=OFF;')
    output.exec(schemaSql())
    setMetadata(output, 'namespace', SIX_STAGE_REAL_ANALYSIS_NAMESPACE)
    setMetadata(output, 'schema_version', SIX_STAGE_REAL_ANALYSIS_SCHEMA_VERSION)
    setMetadata(output, 'market', market)
    setMetadata(output, 'status', 'BUILDING')
    setMetadata(output, 'event_store_sha256', input.expectedEventStoreSha256)
    setMetadata(output, 'source_adoption_sha256', SIX_STAGE_SOURCE_ADOPTION_SHA256)
    setMetadata(output, 'price_basis', manifest.source.priceBasis)
    const insert = output.prepare(`INSERT INTO pattern_summary(${COLUMNS.join(',')}) VALUES(${COLUMNS.map(() => '?').join(',')})`)
    const selectColumns = [
      'length', 'sequence_key', 'ticker_id', "substr(signal_date,1,4) AS signal_year", 'termination_code',
      ...EVENT_PATH_HORIZONS.flatMap((horizon) => [`close_return_${horizon}`, `mfe_${horizon}`, `mae_${horizon}`]),
      ...EVENT_PATH_THRESHOLDS.flatMap((threshold) => [`first_up_day_${threshold}`, `first_down_day_${threshold}`]),
    ]
    const rows = source.prepare(`SELECT ${selectColumns.join(',')} FROM event_paths ORDER BY length,sequence_key,c_age`).iterate()
    let current: PatternAccumulator | null = null
    let patterns = 0
    let written = 0
    let transactionRows = 0
    output.exec('BEGIN IMMEDIATE')
    const flush = () => {
      if (!current) return
      for (const horizon of EVENT_PATH_HORIZONS) {
        insert.run(...outputValues(current, horizon))
        written += 1
        transactionRows += 1
      }
      patterns += 1
      if (transactionRows >= 20_000) {
        output.exec('COMMIT; BEGIN IMMEDIATE')
        transactionRows = 0
      }
    }
    for (const row of rows) {
      const length = Number(row.length)
      const sequenceKey = String(row.sequence_key)
      if (!current || current.length !== length || current.sequenceKey !== sequenceKey) {
        flush()
        current = createAccumulator(length, sequenceKey)
      }
      addRow(current, row)
    }
    flush()
    output.exec('COMMIT')
    output.exec(`
      CREATE INDEX pattern_summary_population_idx ON pattern_summary(length,horizon,population_events DESC);
      CREATE INDEX pattern_summary_up_first_5_idx ON pattern_summary(length,horizon,up_first_5_rate DESC);
      CREATE INDEX pattern_summary_down_first_5_idx ON pattern_summary(length,horizon,down_first_5_rate DESC);
      CREATE INDEX pattern_summary_up_hit_10_idx ON pattern_summary(length,horizon,up_hit_10_rate DESC);
      CREATE INDEX pattern_summary_down_hit_10_idx ON pattern_summary(length,horizon,down_hit_10_rate DESC);
      CREATE INDEX pattern_summary_median_idx ON pattern_summary(length,horizon,median_return DESC);
      CREATE INDEX pattern_summary_mfe_idx ON pattern_summary(length,horizon,mfe_median DESC);
      CREATE INDEX pattern_summary_mae_idx ON pattern_summary(length,horizon,mae_median ASC);
    `)
    output.prepare("UPDATE metadata SET value='COMPLETE' WHERE key='status'").run()
    setMetadata(output, 'patterns', patterns)
    setMetadata(output, 'summary_rows', written)
    setMetadata(output, 'completed_at', new Date().toISOString())
    const check = output.prepare('PRAGMA quick_check').get()
    if (String(Object.values(check ?? {})[0]) !== 'ok') throw new Error(`${market} analysis quick_check failed`)
    output.exec('PRAGMA wal_checkpoint(TRUNCATE)')
  } finally {
    source.close()
    output.close()
  }
  fs.renameSync(temporaryPath, finalPath)
  const verify = new DatabaseSync(finalPath, { readOnly: true })
  try {
    const patterns = Number(verify.prepare('SELECT COUNT(DISTINCT length || char(31) || sequence_key) AS count FROM pattern_summary').get()?.count ?? 0)
    const rows = Number(verify.prepare('SELECT COUNT(*) AS count FROM pattern_summary').get()?.count ?? 0)
    return { market, file: finalPath, sha256: sha256File(finalPath), patterns, rows, elapsedMs: Date.now() - startedAt }
  } finally {
    verify.close()
  }
}

function main(): void {
  assertResearchOnlyExecution()
  const stat = fs.statfsSync(SIX_STAGE_REAL_RESEARCH_ROOT)
  const freeBytes = Number(stat.bavail) * Number(stat.bsize)
  if (freeBytes < 50 * 1024 ** 3) throw new Error(`OWC free space below 50 GiB: ${freeBytes}`)
  const requested = process.argv.slice(2).map((value) => value.toUpperCase())
  const markets = (requested.length ? requested : ['JP', 'US']).map((value) => {
    if (value !== 'JP' && value !== 'US') throw new Error(`invalid market: ${value}`)
    return value
  }) as SixStageRealMarket[]
  const resultMap = new Map(markets.map((market) => [market, buildMarket(market)]))
  for (const market of ['JP', 'US'] as const) {
    if (resultMap.has(market)) continue
    const completedPath = path.join(SIX_STAGE_REAL_ANALYSIS_DIRECTORY, `${market.toLowerCase()}-pattern-analysis.sqlite`)
    if (fs.existsSync(completedPath)) resultMap.set(market, buildMarket(market))
  }
  const results = [...resultMap.values()].sort((left, right) => left.market.localeCompare(right.market))
  const manifest = {
    schemaVersion: SIX_STAGE_REAL_ANALYSIS_SCHEMA_VERSION,
    namespace: SIX_STAGE_REAL_ANALYSIS_NAMESPACE,
    status: 'COMPLETE',
    sourceAdoptionSha256: SIX_STAGE_SOURCE_ADOPTION_SHA256,
    productionAccess: 0,
    validationAccess: 0,
    holdoutAccess: 0,
    generatedAt: new Date().toISOString(),
    results,
  }
  const manifestPath = path.join(SIX_STAGE_REAL_ANALYSIS_DIRECTORY, 'manifest.json')
  const temporary = `${manifestPath}.tmp-${process.pid}`
  fs.writeFileSync(temporary, `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' })
  fs.renameSync(temporary, manifestPath)
  console.log(JSON.stringify({ ...manifest, manifestSha256: sha256File(manifestPath) }, null, 2))
}

main()
