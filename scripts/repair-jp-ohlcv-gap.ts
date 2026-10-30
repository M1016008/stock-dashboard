import type { Client } from '@libsql/client'
import fs from 'node:fs'
import path from 'node:path'
import {
  buildJpOhlcvBackfillPlan,
  JP_OHLCV_PRICE_BASIS,
  stableSha256,
  type JpOfficialOhlcvValue,
  type JpOhlcvBackfillPlan,
  type JpOhlcvValue,
} from '@/lib/jp-ohlcv-data-quality'
import { fetchJQuantsDailyByDateWithEvidence, type JQuantsDailyByDateEvidence } from '@/lib/jquants'
import { assertIsolatedRuntimeEnvironment, resolveThroughExistingAncestor } from '@/lib/runtime/isolation'
import { openExistingGuardedClient } from '@/lib/storage/guarded-libsql-client'

type CliOptions = {
  date: string
  officialFile: string | null
  existingFile: string | null
  outputFile: string
  officialOutputFile: string | null
  fetchJquants: boolean
  applyIsolatedDb: string | null
}

function valueAfter(flag: string): string | null {
  const index = process.argv.indexOf(flag)
  const value = index >= 0 ? process.argv[index + 1] ?? null : null
  return value?.startsWith('--') ? null : value
}

function requiredAbsolute(flag: string, value: string | null): string {
  if (!value || !path.isAbsolute(value)) throw new Error(`${flag}_absolute_path_required`)
  return path.resolve(value)
}

function options(): CliOptions {
  const date = valueAfter('--date')
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('--date=YYYY-MM-DD_required')
  const official = valueAfter('--official-json')
  const existing = valueAfter('--existing-json')
  const fetchJquants = process.argv.includes('--fetch-jquants')
  if ((official ? 1 : 0) + (fetchJquants ? 1 : 0) !== 1) {
    throw new Error('exactly_one_of_--official-json_or_--fetch-jquants_required')
  }
  const apply = valueAfter('--apply-isolated-db')
  if (!apply && !existing) throw new Error('--existing-json_required_for_dry_run')
  return {
    date,
    officialFile: official ? requiredAbsolute('--official-json', official) : null,
    existingFile: existing ? requiredAbsolute('--existing-json', existing) : null,
    outputFile: requiredAbsolute('--output', valueAfter('--output')),
    officialOutputFile: valueAfter('--official-output')
      ? requiredAbsolute('--official-output', valueAfter('--official-output'))
      : null,
    fetchJquants,
    applyIsolatedDb: apply ? requiredAbsolute('--apply-isolated-db', apply) : null,
  }
}

function rowsFromJson<T>(file: string): T[] {
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown
  const rows = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === 'object' && Array.isArray((parsed as { rows?: unknown }).rows)
      ? (parsed as { rows: unknown[] }).rows
      : parsed && typeof parsed === 'object'
          && Array.isArray((parsed as { reconstructedRows?: unknown }).reconstructedRows)
        ? (parsed as { reconstructedRows: unknown[] }).reconstructedRows
        : null
  if (!rows) throw new Error(`rows_array_required:${file}`)
  return rows as T[]
}

function assertIsolatedDbPath(dbPath: string): void {
  const kind = assertIsolatedRuntimeEnvironment()
  if (kind !== 'test' && kind !== 'development') throw new Error('isolated_apply_requires_test_or_development_scope')
  const root = resolveThroughExistingAncestor(process.env.STOCKBOARD_ISOLATION_ROOT!)
  const resolved = resolveThroughExistingAncestor(dbPath)
  const relative = path.relative(root, resolved)
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('isolated_apply_db_outside_isolation_root')
  }
  if (fs.existsSync(dbPath) && fs.lstatSync(dbPath).isSymbolicLink()) throw new Error('isolated_apply_db_symlink_forbidden')
}

async function loadExisting(client: Client, date: string): Promise<JpOhlcvValue[]> {
  const result = await client.execute({
    sql: 'SELECT ticker, date, open, high, low, close, volume FROM ohlcv_daily WHERE date = ? ORDER BY ticker',
    args: [date],
  })
  return result.rows.map((row) => ({
    ticker: String(row.ticker),
    date: String(row.date),
    open: Number(row.open),
    high: Number(row.high),
    low: Number(row.low),
    close: Number(row.close),
    volume: Number(row.volume),
  }))
}

async function applyPlanToIsolatedDb(
  client: Client,
  plan: JpOhlcvBackfillPlan,
  officialRows: readonly JpOfficialOhlcvValue[],
): Promise<{ insertedRows: number; afterSha256: string }> {
  if (plan.status !== 'READY') throw new Error('backfill_plan_hold')
  const transaction = await client.transaction('write')
  let insertedRows = 0
  try {
    for (const row of plan.missingRows) {
      const result = await transaction.execute({
        sql: `INSERT INTO ohlcv_daily (ticker, date, open, high, low, close, volume)
              VALUES (?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT(ticker, date) DO NOTHING`,
        args: [row.ticker, row.date, row.open, row.high, row.low, row.close, row.volume],
      })
      insertedRows += Number(result.rowsAffected ?? 0)
      const failAfter = Number(process.env.JP_OHLCV_REPAIR_FAIL_AFTER_INSERTS ?? 0)
      if (Number.isSafeInteger(failAfter) && failAfter > 0 && insertedRows >= failAfter) {
        throw new Error('isolated_apply_injected_failure')
      }
    }
    if (insertedRows !== plan.missingRows.length) throw new Error('isolated_apply_concurrent_row_change')
    const after = await transaction.execute({
      sql: 'SELECT ticker, date, open, high, low, close, volume FROM ohlcv_daily WHERE date = ? ORDER BY ticker',
      args: [plan.date],
    })
    const afterRows = after.rows.map((row) => ({
      ticker: String(row.ticker), date: String(row.date), open: Number(row.open), high: Number(row.high),
      low: Number(row.low), close: Number(row.close), volume: Number(row.volume),
    }))
    const verification = buildJpOhlcvBackfillPlan({
      date: plan.date,
      officialRows,
      existingRows: afterRows,
    })
    if (
      verification.status !== 'READY'
      || verification.missingRows.length !== 0
      || verification.matchingRows !== verification.officialRows
    ) {
      throw new Error('isolated_apply_post_verification_failed')
    }
    await transaction.commit()
    return { insertedRows, afterSha256: stableSha256(afterRows) }
  } catch (error) {
    try { await transaction.rollback() } catch { /* the original failure is more useful */ }
    throw error
  }
}

async function main(): Promise<void> {
  const args = options()
  let acquisition: Pick<JQuantsDailyByDateEvidence,
    'endpoint' | 'requestedDate' | 'requestedAt' | 'completedAt' | 'pages' | 'providerRows' | 'acceptedRows' | 'rejectedRows' | 'contentSha256'>
    | { endpoint: 'file'; requestedDate: string; requestedAt: string; completedAt: string; pages: 1; providerRows: number; acceptedRows: number; rejectedRows: 0; contentSha256: string }
  let officialRows: JpOfficialOhlcvValue[]
  if (args.fetchJquants) {
    const evidence = await fetchJQuantsDailyByDateWithEvidence(args.date)
    officialRows = evidence.rows
    const { rows: _rows, ...metadata } = evidence
    acquisition = metadata
  } else {
    officialRows = rowsFromJson<JpOfficialOhlcvValue>(args.officialFile!)
    const now = new Date().toISOString()
    acquisition = {
      endpoint: 'file', requestedDate: args.date, requestedAt: now, completedAt: now, pages: 1,
      providerRows: officialRows.length, acceptedRows: officialRows.length, rejectedRows: 0,
      contentSha256: stableSha256(officialRows),
    }
  }
  if (args.officialOutputFile) {
    fs.mkdirSync(path.dirname(args.officialOutputFile), { recursive: true })
    fs.writeFileSync(args.officialOutputFile, `${JSON.stringify({
      version: 1,
      date: args.date,
      priceBasis: JP_OHLCV_PRICE_BASIS,
      officialSha256: stableSha256(officialRows),
      rows: officialRows,
    }, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
  }

  let client: Client | null = null
  try {
    let existingRows: JpOhlcvValue[]
    if (args.applyIsolatedDb) {
      assertIsolatedDbPath(args.applyIsolatedDb)
      client = openExistingGuardedClient(args.applyIsolatedDb, 'jp-ohlcv-gap-repair-isolated')
      existingRows = await loadExisting(client, args.date)
    } else {
      existingRows = rowsFromJson<JpOhlcvValue>(args.existingFile!)
    }

    const plan = buildJpOhlcvBackfillPlan({ date: args.date, officialRows, existingRows })
    const mode = args.applyIsolatedDb ? 'ISOLATED_APPLY' : 'DRY_RUN'
    const manifestBase = {
      version: 1,
      mode,
      date: args.date,
      priceBasis: JP_OHLCV_PRICE_BASIS,
      acquisition,
      plan,
      productionMutationAuthorized: false,
      productionApplyStatus: 'HOLD',
      derivedRecalculationStatus: 'NOT_STARTED',
    }
    fs.mkdirSync(path.dirname(args.outputFile), { recursive: true })
    fs.writeFileSync(args.outputFile, `${JSON.stringify({
      ...manifestBase,
      execution: null,
      state: 'PREPARED',
      preparedAt: new Date().toISOString(),
    }, null, 2)}\n`, { flag: 'wx', mode: 0o600 })

    let execution: { insertedRows: number; afterSha256: string } | null = null
    try {
      execution = client && plan.status === 'READY'
        ? await applyPlanToIsolatedDb(client, plan, officialRows)
        : null
      const manifest = {
        ...manifestBase,
        state: plan.status === 'READY' ? 'COMPLETE' : 'HOLD',
        generatedAt: new Date().toISOString(),
        execution,
      }
      fs.writeFileSync(args.outputFile, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 })
      console.log(JSON.stringify({
        status: plan.status,
        mode,
        officialRows: plan.officialRows,
        existingRows: plan.existingRows,
        matchingRows: plan.matchingRows,
        missingRows: plan.missingRows.length,
        conflicts: plan.conflicts.length,
        conflictSamples: plan.conflicts.slice(0, 5).map((conflict) => ({
          ticker: conflict.ticker,
          reason: conflict.reason,
          validationReason: conflict.validationReason ?? null,
        })),
        planSha256: plan.planSha256,
        output: args.outputFile,
      }))
      if (plan.status !== 'READY') process.exitCode = 2
    } catch (error) {
      fs.writeFileSync(args.outputFile, `${JSON.stringify({
        ...manifestBase,
        state: execution ? 'COMMITTED_MANIFEST_FAILED' : 'FAILED',
        failedAt: new Date().toISOString(),
        execution,
        failure: {
          name: error instanceof Error ? error.name : 'Error',
          message: error instanceof Error ? error.message : String(error),
        },
      }, null, 2)}\n`, { mode: 0o600 })
      throw error
    }
  } finally {
    client?.close()
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? `${error.name}: ${error.message}` : String(error))
  process.exitCode = 1
})
