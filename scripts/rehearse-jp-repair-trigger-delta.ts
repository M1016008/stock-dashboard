import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
// @ts-expect-error Node 24 ships node:sqlite; the repository pins older Node type declarations.
import { DatabaseSync } from 'node:sqlite'
import { execAll, execGet } from '@/lib/db/client'
import { runDailyTriggerEvaluations } from '@/lib/server/trigger-daily-evaluations'
import { composeTriggerNotificationsForBatch } from '@/lib/server/trigger-notification-composition'
import { TRIGGER_DAILY_REPAIR_EVALUATION_SOURCE } from '@/lib/trigger-daily-evaluation'

type Row = Record<string, unknown>

function argument(name: string): string {
  const index = process.argv.indexOf(name)
  const value = index >= 0 ? process.argv[index + 1] : null
  if (!value) throw new Error(`missing ${name}`)
  return value
}

function normalized(row: Row): Row {
  return Object.fromEntries(Object.entries(row)
    .filter(([key]) => key !== 'evaluation_id' && key !== 'created_at')
    .sort(([left], [right]) => left.localeCompare(right)))
}

function serialized(row: Row): string {
  return JSON.stringify(normalized(row))
}

function rowsHash(rows: Row[]): string {
  const hash = createHash('sha256')
  for (const row of [...rows].sort((left, right) => String(left.ticker).localeCompare(String(right.ticker)))) {
    hash.update(`${serialized(row)}\n`)
  }
  return hash.digest('hex')
}

async function main(): Promise<void> {
  const baselinePath = path.resolve(argument('--baseline'))
  const outputPath = path.resolve(argument('--output'))
  const requestedAsOf = argument('--as-of')
  const repairKey = argument('--repair-key')
  const startedAt = Date.now()
  const result = await runDailyTriggerEvaluations({ requestedAsOf, repairKey })
  if (!result.batch || result.batch.status !== 'COMPLETED'
      || result.batch.source !== TRIGGER_DAILY_REPAIR_EVALUATION_SOURCE
      || result.batch.repairKey !== repairKey) {
    throw new Error(`isolated trigger repair evaluation did not complete: ${result.batch?.status ?? 'missing'}`)
  }
  const notifications = await composeTriggerNotificationsForBatch({ batchId: result.batch.id })
  const outbox = await execGet<{ count: number }>(
    'SELECT COUNT(*) AS count FROM notification_outbox WHERE batch_id=?',
    [result.batch.id],
  )
  const suppressed = await execGet<{ count: number }>(
    `SELECT COUNT(*) AS count FROM trigger_notification_composition_runs
     WHERE batch_id=? AND status='SUPPRESSED'`,
    [result.batch.id],
  )
  if (notifications.createdCount !== 0 || notifications.notifications.length !== 0
      || Number(outbox?.count ?? 0) !== 0 || Number(suppressed?.count ?? 0) < 1) {
    throw new Error('repair re-evaluation notifications were not suppressed')
  }

  const baseline = new DatabaseSync(baselinePath, { readOnly: true })
  try {
    const definitions: Array<Record<string, unknown>> = []
    let totalAdded = 0
    let totalRemoved = 0
    let totalChanged = 0
    for (const item of result.items) {
      if (!item.evaluationId) throw new Error(`isolated trigger evaluation missing id: ${item.definitionId}`)
      const baselineEvaluation = baseline.prepare(`
        SELECT id FROM trigger_evaluations
        WHERE definition_id=? AND resolved_as_of=? AND status='COMPLETED'
          AND evaluation_version=? AND evaluation_config_signature=?
          AND engine_version=? AND score_version=?
        ORDER BY created_at DESC LIMIT 1
      `).get(
        item.definitionId,
        result.resolvedAsOf,
        item.evaluationVersion,
        item.evaluationConfigSignature,
        item.engineVersion,
        item.scoreVersion,
      ) as { id: string } | undefined
      if (!baselineEvaluation) {
        throw new Error(`baseline trigger evaluation missing: ${item.definitionId}:${result.resolvedAsOf}`)
      }
      const before = baseline.prepare(
        'SELECT * FROM trigger_evaluation_members WHERE evaluation_id=? ORDER BY ticker',
      ).all(baselineEvaluation.id) as Row[]
      const after = await execAll<Row>(
        'SELECT * FROM trigger_evaluation_members WHERE evaluation_id=? ORDER BY ticker',
        [item.evaluationId],
      )
      const beforeByTicker = new Map(before.map((row) => [String(row.ticker), serialized(row)]))
      const afterByTicker = new Map(after.map((row) => [String(row.ticker), serialized(row)]))
      const added = [...afterByTicker.keys()].filter((ticker) => !beforeByTicker.has(ticker))
      const removed = [...beforeByTicker.keys()].filter((ticker) => !afterByTicker.has(ticker))
      const changed = [...afterByTicker.keys()].filter((ticker) => (
        beforeByTicker.has(ticker) && beforeByTicker.get(ticker) !== afterByTicker.get(ticker)
      ))
      totalAdded += added.length
      totalRemoved += removed.length
      totalChanged += changed.length
      definitions.push({
        definitionId: item.definitionId,
        baselineEvaluationId: baselineEvaluation.id,
        repairedEvaluationId: item.evaluationId,
        beforeCount: before.length,
        afterCount: after.length,
        beforeSha256: rowsHash(before),
        afterSha256: rowsHash(after),
        added,
        removed,
        changed,
        lifecycleEventCount: item.lifecycleEventCount,
      })
    }
    const receipt = {
      version: 1,
      status: 'PASS',
      createdAt: new Date().toISOString(),
      requestedAsOf,
      resolvedAsOf: result.resolvedAsOf,
      baselineDatabase: fs.realpathSync(baselinePath),
      notificationCompositionCalled: true,
      notificationSuppressed: true,
      batchId: result.batch.id,
      batchSource: result.batch.source,
      repairKey,
      supersedesBatchId: result.batch.supersedesBatchId,
      durationMs: Date.now() - startedAt,
      totalAdded,
      totalRemoved,
      totalChanged,
      definitions,
    }
    fs.writeFileSync(outputPath, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 })
    console.log(JSON.stringify(receipt, null, 2))
  } finally {
    baseline.close()
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
