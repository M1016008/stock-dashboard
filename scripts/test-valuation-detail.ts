import assert from 'node:assert/strict'
import { normalizeAsOf } from '@/lib/financial-foundation'
import { loadFinancialForecastSnapshotsForTickers } from '@/lib/server/financial-foundation-store'
import { getValuationDetailReadModel } from '@/lib/server/valuation-detail-read-model'
import type { ValuationDetailReadModel, ValuationValue } from '@/lib/valuation-detail'

const TICKERS = ['7203', '7003', '8306', '4755', '4502', '7974'] as const
const PIT_DATES = ['2024-06-28', '2025-06-30'] as const

function currentValue(model: ValuationDetailReadModel, metric: string): ValuationValue {
  const values = [...model.current.primary, ...model.current.secondary]
  const value = values.find((candidate) => candidate.metric === metric)
  assert.ok(value, `${model.ticker}: missing current contract for ${metric}`)
  return value
}

async function assertForecastTrace(model: ValuationDetailReadModel): Promise<void> {
  const snapshots = await loadFinancialForecastSnapshotsForTickers([model.ticker])
  const publishedAt = new Map(snapshots.map((snapshot) => [snapshot.snapshotId, snapshot.publishedAt]))
  for (const history of Object.values(model.history)) {
    for (const point of history.points) {
      if (!point.forecastSnapshotId) continue
      const timestamp = publishedAt.get(point.forecastSnapshotId)
      assert.ok(timestamp, `${model.ticker}: unknown forecast snapshot ${point.forecastSnapshotId}`)
      assert.ok(timestamp! <= normalizeAsOf(point.date), `${model.ticker}: PIT forecast leak at ${point.date}`)
    }
  }
}

async function main() {
  const models = new Map<string, ValuationDetailReadModel>()
  for (const ticker of TICKERS) {
    const startedAt = performance.now()
    const model = await getValuationDetailReadModel(ticker)
    models.set(ticker, model)
    assert.equal(model.contractVersion, 'valuation-detail-v1')
    assert.equal(model.ticker, ticker)
    assert.ok(model.price != null && model.price > 0, `${ticker}: price is required`)
    assert.ok(model.coverage.priceObservations > 0, `${ticker}: price history is required`)
    assert.ok(model.current.primary.length === 4, `${ticker}: four primary metrics are required`)
    assert.ok(model.current.secondary.length === 4, `${ticker}: four secondary contracts are required`)
    assert.ok(Object.values(model.history).every((history) => history.sampling === 'month_end_and_latest'))
    assert.ok(Object.values(model.history).every((history) => Object.values(history.statistics).every((stats) => stats.observationCount >= 0)))
    assert.ok(Object.values(model.peers).every((peer) => peer.peerCount >= 0))
    assert.ok(Object.values(model.definitions).every((definition) => definition.version && definition.dataSource))
    await assertForecastTrace(model)
    console.log(JSON.stringify({
      ticker,
      elapsedMs: Math.round(performance.now() - startedAt),
      asOf: model.asOf,
      current: Object.fromEntries([...model.current.primary, ...model.current.secondary].map((value) => [value.metric, {
        availability: value.availability,
        value: value.value,
        reason: value.reason,
      }])),
      peers: {
        sector33: { name: model.peers.sector33.groupName, count: model.peers.sector33.peerCount },
        custom60: { name: model.peers.custom60.groupName, count: model.peers.custom60.peerCount },
      },
    }))
  }

  const bank = models.get('8306')!
  assert.equal(bank.isFinancialSector, true)
  for (const metric of ['fcf_yield', 'psr', 'ev_ebitda', 'net_debt']) {
    assert.equal(currentValue(bank, metric).availability, 'not_applicable', `8306: ${metric} must be N/A`)
  }

  const lossMaker = models.get('4755')!
  assert.notEqual(currentValue(lossMaker, 'ev_ebitda').availability, 'available', '4755: non-positive EV/EBITDA must not be displayed as a normal multiple')

  const nintendo = models.get('7974')!
  const nintendoDebt = currentValue(nintendo, 'net_debt')
  if (nintendoDebt.availability === 'missing') {
    assert.match(nintendoDebt.reason ?? '', /必要入力|揃っていません/)
  }

  for (const asOf of PIT_DATES) {
    const model = await getValuationDetailReadModel('7203', asOf)
    assert.equal(model.asOf, asOf)
    assert.ok((model.priceDate ?? '') <= asOf)
    assert.equal(model.coverage.peerCalculationMode, 'pit_recalculated')
    await assertForecastTrace(model)
    for (const value of [...model.current.primary, ...model.current.secondary]) {
      if (!value.forecastSnapshotId) continue
      const snapshots = await loadFinancialForecastSnapshotsForTickers(['7203'])
      const snapshot = snapshots.find((candidate) => candidate.snapshotId === value.forecastSnapshotId)
      assert.ok(snapshot && snapshot.publishedAt <= normalizeAsOf(asOf), `7203: current forecast leak at ${asOf}`)
    }
  }

  const cachedStartedAt = performance.now()
  const cached = await getValuationDetailReadModel('7203')
  const cachedElapsedMs = performance.now() - cachedStartedAt
  assert.equal(cached.coverage.cacheHit, true)
  assert.ok(cachedElapsedMs < 100, `cache read took ${cachedElapsedMs.toFixed(1)}ms`)

  console.log(`Valuation detail tests passed; cached 7203 read ${cachedElapsedMs.toFixed(1)}ms`)
}

main().catch((error) => {
  console.error('Valuation detail tests failed:', error instanceof Error ? error.stack : String(error))
  process.exit(1)
})
