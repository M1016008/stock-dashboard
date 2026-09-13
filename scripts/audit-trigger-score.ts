import { getTriggerDiscovery } from '@/lib/server/trigger-discovery-read-model'

const asOf = process.argv[2] ?? '2026-09-10'

function median(values: number[]): number | null {
  if (values.length === 0) return null
  const sorted = values.slice().sort((left, right) => left - right)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle]
}

async function main() {
  const result = await getTriggerDiscovery({
    asOf,
    triggerConfig: { ma1Period: 20, ma2Period: 25 },
    limit: 10_000,
  })
  const ranked = result.rows.slice().sort((left, right) => (
    right.triggerScore - left.triggerScore || left.ticker.localeCompare(right.ticker)
  ))
  const scores = ranked.map((row) => row.triggerScore)
  const sample = (rows: typeof ranked) => rows.map((row) => ({
    ticker: row.ticker,
    companyName: row.companyName,
    status: row.triggerStatus,
    score: row.triggerScore,
    zoneDistancePct: row.zoneDistancePct,
    approachVelocity: row.approachVelocityPctPointsPerSession,
    maSlopes: [row.ma1SlopePct, row.ma2SlopePct],
    stages: [row.dayAStage, row.dayBStage, row.weekAStage, row.weekBStage, row.monthAStage, row.monthBStage],
    breakdown: row.scoreBreakdown,
  }))
  console.log(JSON.stringify({
    requestedAsOf: result.requestedAsOf,
    resolvedAsOf: result.resolvedAsOf,
    matched: result.totalTriggerMatched,
    scoreCalculationMs: result.diagnostics.performance.scoreCalculationMs,
    queryCount: result.diagnostics.performance.queryCount,
    performance: result.diagnostics.performance,
    distribution: {
      min: scores.length ? Math.min(...scores) : null,
      median: median(scores),
      max: scores.length ? Math.max(...scores) : null,
    },
    top10: sample(ranked.slice(0, 10)),
    bottom10: sample(ranked.slice(-10).reverse()),
  }, null, 2))
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
