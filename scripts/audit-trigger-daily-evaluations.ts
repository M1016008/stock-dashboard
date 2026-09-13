import { execAll, execGet, execRun } from '@/lib/db/client'
import { runDailyTriggerEvaluations } from '@/lib/server/trigger-daily-evaluations'
import { createSavedTriggerDefinition } from '@/lib/server/saved-trigger-definitions'
import { savedTriggerConfigsFromSearchRequest, type SavedTriggerDefinition } from '@/lib/trigger-definition'
import type { TriggerDiscoveryTimeframe } from '@/lib/trigger-discovery-timeframe'

const prefix = '__phase8b2_performance__'

async function cleanup(date?: string): Promise<void> {
  const definitions = await execAll<{ id: string }>('SELECT id FROM trigger_definitions WHERE name LIKE ?', [`${prefix}%`])
  if (date) {
    await execRun(`DELETE FROM trigger_evaluation_batch_items
      WHERE batch_id IN (SELECT id FROM trigger_evaluation_batches WHERE source='DAILY' AND resolved_as_of=?)`, [date])
    await execRun("DELETE FROM trigger_evaluation_batches WHERE source='DAILY' AND resolved_as_of=?", [date])
  }
  for (const definition of definitions) {
    await execRun('DELETE FROM trigger_lifecycle_events WHERE definition_id=?', [definition.id])
    await execRun('DELETE FROM trigger_evaluation_observations WHERE evaluation_id IN (SELECT id FROM trigger_evaluations WHERE definition_id=?)', [definition.id])
    await execRun('DELETE FROM trigger_evaluation_members WHERE evaluation_id IN (SELECT id FROM trigger_evaluations WHERE definition_id=?)', [definition.id])
    await execRun('DELETE FROM trigger_evaluations WHERE definition_id=?', [definition.id])
    await execRun('DELETE FROM trigger_definitions WHERE id=?', [definition.id])
  }
}

async function create(
  name: string,
  timeframe: TriggerDiscoveryTimeframe,
  ma1Period: number,
  ma2Period: number,
): Promise<SavedTriggerDefinition> {
  const configs = savedTriggerConfigsFromSearchRequest({
    requestedAsOf: '2026-01-01', timeframe, ma1Period, ma2Period,
  })
  return createSavedTriggerDefinition({ name: `${prefix}${name}`, ...configs })
}

type AuditDefinition = [timeframe: TriggerDiscoveryTimeframe, ma1Period: number, ma2Period: number]

async function measure(date: string, inputs: AuditDefinition[]) {
  const definitions: SavedTriggerDefinition[] = []
  for (const [index, input] of inputs.entries()) {
    definitions.push(await create(`${index}-${input[0]}-${input[1]}-${input[2]}`, ...input))
  }
  const startedAt = performance.now()
  const result = await runDailyTriggerEvaluations(
    { requestedAsOf: date, resolvedAsOf: date },
    { listDefinitions: async () => definitions },
  )
  const totalMs = performance.now() - startedAt
  const evaluationIds = result.items.flatMap((item) => item.evaluationId ? [item.evaluationId] : [])
  const evaluations = evaluationIds.length === 0 ? [] : await execAll<{
    id: string
    discovery_duration_ms: number
    persistence_duration_ms: number
    discovery_query_count: number
    discovery_db_query_ms: number
  }>(`SELECT id, discovery_duration_ms, persistence_duration_ms,
      discovery_query_count, discovery_db_query_ms
    FROM trigger_evaluations
    WHERE id IN (${evaluationIds.map(() => '?').join(',')}) ORDER BY started_at, id`, evaluationIds)
  const storage = await execAll<{ batches: number; items: number; logical_text_bytes: number }>(`
    SELECT
      (SELECT COUNT(*) FROM trigger_evaluation_batches WHERE id=?) AS batches,
      COUNT(*) AS items,
      COALESCE(SUM(LENGTH(definition_id) + LENGTH(evaluation_config_signature)
        + LENGTH(COALESCE(evaluation_id, '')) + LENGTH(status)
        + LENGTH(COALESCE(error_category, ''))), 0) AS logical_text_bytes
    FROM trigger_evaluation_batch_items WHERE batch_id=?
  `, [result.batch?.id ?? '', result.batch?.id ?? ''])
  return { totalMs: Math.round(totalMs), batch: result.batch, items: result.items, evaluations, storage }
}

async function main(): Promise<void> {
  const available = await execGet<{ date: string | null }>(`
    SELECT MAX(prices.date) AS date
    FROM (SELECT DISTINCT date FROM ohlcv_daily) AS prices
    WHERE EXISTS (SELECT 1 FROM daily_snapshots WHERE date=prices.date)
      AND EXISTS (SELECT 1 FROM monthly_ma_monitor_daily WHERE date=prices.date)
      AND NOT EXISTS (
        SELECT 1 FROM trigger_evaluation_batches
        WHERE source='DAILY' AND resolved_as_of=prices.date
      )
  `)
  const date = available?.date
  if (!date) throw new Error('no safe data date without an existing Daily Batch is available')
  await cleanup()
  try {
    const monthlyOne = await measure(date, [['MONTHLY', 20, 25]])
    await cleanup(date)
    const biweeklyOne = await measure(date, [['BIWEEKLY', 20, 25]])
    await cleanup(date)
    const mixed = await measure(date, [['MONTHLY', 20, 25], ['BIWEEKLY', 20, 25]])
    await cleanup(date)
    const biweeklyThree = await measure(date, [
      ['BIWEEKLY', 20, 25],
      ['BIWEEKLY', 10, 20],
      ['BIWEEKLY', 20, 50],
    ])
    console.log(JSON.stringify({ date, monthlyOne, biweeklyOne, mixed, biweeklyThree }, null, 2))
  } finally {
    await cleanup(date)
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
