import assert from 'node:assert/strict'
import { execBatch, execGet } from '@/lib/db/client'
import type { ScreeningCondition } from '@/lib/integrated-screener'
import {
  evaluateSavedScreeningDefinition,
  getSavedScreeningChangeReason,
  getSavedScreeningEvaluationDetail,
  upsertSavedScreeningDefinition,
} from '@/lib/server/saved-screening-evaluations'

const dates = ['2026-05-29', '2026-07-31', '2026-08-25']
const scenarios: Array<{ id: string; name: string; conditions: ScreeningCondition[] }> = [
  {
    id: 'phase13-test-boundary', name: '__phase13_boundary__', conditions: [
      { id: 'roe', metric: 'roe', operator: 'gte', value: 10 },
      { id: 'forward-per', metric: 'forwardPer', operator: 'lte', value: 15 },
    ],
  },
  {
    id: 'phase13-test-stage', name: '__phase13_stage__', conditions: [
      { id: 'weekly-stage', metric: 'weeklyAStage', operator: 'eq', value: 2 },
      { id: 'sector-score', metric: 'sectorStructureScore', operator: 'gte', value: 60 },
    ],
  },
  {
    id: 'phase13-test-revision', name: '__phase13_revision__', conditions: [
      { id: 'revision', metric: 'latestForecastRevisionDirection', operator: 'eq', value: 'up' },
      { id: 'valuation', metric: 'forwardPer', operator: 'lte', value: 20 },
    ],
  },
]

async function clean() {
  for (const scenario of scenarios) {
    await execBatch([
      { sql: 'DELETE FROM saved_screening_evaluation_members WHERE evaluation_id IN (SELECT evaluation_id FROM saved_screening_evaluations WHERE definition_id=?)', args: [scenario.id] },
      { sql: 'DELETE FROM saved_screening_evaluations WHERE definition_id=?', args: [scenario.id] },
      { sql: 'DELETE FROM saved_screening_definitions WHERE id=? OR name=?', args: [scenario.id, scenario.name] },
    ])
  }
}

async function main() {
  await clean()
  const dbBefore = await execGet<{ page_count: number; page_size: number }>('SELECT page_count, page_size FROM pragma_page_count(), pragma_page_size()')
  const report = []
  try {
    for (const scenario of scenarios) {
      await upsertSavedScreeningDefinition({
        id: scenario.id,
        name: scenario.name,
        state: { conditions: scenario.conditions, sort: 'marketCap', direction: 'desc', columns: ['marketCap', 'forwardPer', 'roe', 'weeklyAStage'] },
        evaluate: false,
      })
      const history = []
      for (const asOf of dates) history.push(await evaluateSavedScreeningDefinition(scenario.id, asOf))
      assert.equal(history[0].newCount, 0, '初回評価はNEWを作らない')
      assert.equal(history[0].outCount, 0, '初回評価はOUTを作らない')
      assert.equal(history[0].stayCount, history[0].matchedCount)
      for (const evaluation of history) {
        assert.equal(evaluation.newCount + evaluation.stayCount, evaluation.matchedCount)
        assert.ok(evaluation.asOf <= dates[2])
      }
      const rerun = await evaluateSavedScreeningDefinition(scenario.id, dates[2])
      assert.deepEqual(
        [rerun.matchedCount, rerun.newCount, rerun.stayCount, rerun.outCount],
        [history[2].matchedCount, history[2].newCount, history[2].stayCount, history[2].outCount],
        '同一日再評価は同じ差分になる',
      )
      const evaluationCount = await execGet<{ count: number }>('SELECT COUNT(*) AS count FROM saved_screening_evaluations WHERE definition_id=?', [scenario.id])
      assert.equal(Number(evaluationCount?.count ?? 0), dates.length, '同じ基準日の評価履歴を重複させない')
      let reasonExample = null
      for (const status of ['NEW', 'OUT'] as const) {
        const detail = await getSavedScreeningEvaluationDetail({ definitionId: scenario.id, evaluationId: history[2].evaluationId, status, limit: 3 })
        assert.ok(detail)
        if (!reasonExample && detail.members[0]) {
          const reason = await getSavedScreeningChangeReason({ definitionId: scenario.id, evaluationId: history[2].evaluationId, ticker: detail.members[0].ticker })
          assert.ok(reason)
          assert.equal(reason.currentAsOf, history[2].asOf)
          assert.equal(reason.previousAsOf, history[1].asOf)
          for (const item of [...reason.conditionChanges, ...reason.contextChanges]) {
            assert.equal(item.source.currentAsOf, reason.currentAsOf)
            assert.equal(item.source.previousAsOf, reason.previousAsOf)
          }
          reasonExample = {
            ticker: reason.ticker,
            status: reason.status,
            conditionChanges: reason.conditionChanges.map((item) => item.message),
            contextChanges: reason.contextChanges.slice(0, 3).map((item) => item.message),
            elapsedMs: reason.elapsedMs,
          }
        }
      }
      report.push({ scenario: scenario.name, history, reasonExample })
    }
    assert.ok(report.some((item) => item.history.some((evaluation) => evaluation.newCount > 0)), 'いずれかの条件でNEWが発生する')
    assert.ok(report.some((item) => item.history.some((evaluation) => evaluation.outCount > 0)), 'いずれかの条件でOUTが発生する')
    const dbAfter = await execGet<{ page_count: number; page_size: number }>('SELECT page_count, page_size FROM pragma_page_count(), pragma_page_size()')
    const beforeBytes = Number(dbBefore?.page_count ?? 0) * Number(dbBefore?.page_size ?? 0)
    const afterBytes = Number(dbAfter?.page_count ?? 0) * Number(dbAfter?.page_size ?? 0)
    console.log(JSON.stringify({ dates, report, dbBytesAdded: afterBytes - beforeBytes }))
    console.log('saved screening PIT history, NEW/STAY/OUT, reason, and idempotency tests passed')
  } finally {
    await clean()
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
