import assert from 'node:assert/strict'
import { ensureReady, execAll, execGet } from '@/lib/db/client'
import { todayInTokyo } from '@/lib/date-time'
import { evaluateEvEbitda } from '@/lib/financial-metrics'
import { queryIntegratedScreener } from '@/lib/server/integrated-screener-serving'
import { getJpMlPitAvailability } from '@/lib/server/ml-pit'
import { getValuationDetailReadModel } from '@/lib/server/valuation-detail-read-model'

async function main() {
  await ensureReady()

  assert.deepEqual(evaluateEvEbitda(-1, 10), {
    status: 'not_meaningful', value: null, rawCalculationValue: -0.1, reason: 'non_positive_ev',
  })
  assert.deepEqual(evaluateEvEbitda(10, 0), {
    status: 'not_meaningful', value: null, rawCalculationValue: null, reason: 'non_positive_ebitda',
  })
  assert.equal(evaluateEvEbitda(10, -2).reason, 'non_positive_ebitda')
  assert.equal(evaluateEvEbitda(10, 2).value, 5)

  const jstCases = [
    ['2026-08-25T15:30:00.000Z', '2026-08-26'], // JST 00:30
    ['2026-08-25T23:30:00.000Z', '2026-08-26'], // JST 08:30
    ['2026-08-26T00:00:00.000Z', '2026-08-26'], // JST 09:00
  ] as const
  for (const [instant, expected] of jstCases) assert.equal(todayInTokyo(new Date(instant)), expected)

  const dates = await execGet<{ quote_date: string | null; serving_date: string | null }>(`
    SELECT (SELECT MAX(date) FROM ohlcv_daily) AS quote_date,
           (SELECT MAX(valuation_date) FROM valuation_daily_serving) AS serving_date
  `)
  assert.ok(dates?.quote_date)
  assert.equal(dates?.serving_date, dates?.quote_date, 'latest quote and Valuation Serving dates must match')

  const invalidServing = await execGet<{ count: number }>(`
    SELECT COUNT(*) AS count FROM valuation_daily_serving
    WHERE ev_ebitda IS NOT NULL
      AND (enterprise_value <= 0 OR ebitda <= 0 OR ev_ebitda <= 0)
  `)
  assert.equal(Number(invalidServing?.count ?? 0), 0, 'invalid EV/EBITDA must not remain screenable')

  const asOf = dates!.quote_date!
  const lossMakerScreen = await queryIntegratedScreener({
    asOf,
    conditions: [{ id: 'ev-ebitda-contract', metric: 'evEbitda', operator: 'lte', value: 10 }],
    limit: 500,
  })
  assert.equal(lossMakerScreen.rows.some((row) => row.ticker === '4755'), false, '4755 must not pass EV/EBITDA <= 10')

  const invalidRows = await execAll<{ ticker: string }>(`
    SELECT ticker FROM stock_screening_serving
    WHERE as_of = ? AND ev_ebitda IS NOT NULL AND ev_ebitda <= 0
  `, [asOf])
  assert.equal(invalidRows.length, 0)

  for (const ticker of ['7203', '7003']) {
    const model = await getValuationDetailReadModel(ticker)
    const value = model.current.secondary.find((item) => item.metric === 'ev_ebitda')
    if (value?.availability === 'available') assert.ok((value.value ?? 0) > 0, `${ticker}: available EV/EBITDA must be positive`)
    assert.equal(model.coverage.freshnessStatus, 'current', `${ticker}: valuation freshness`)
  }

  const historicalMl = await getJpMlPitAvailability('2025-08-25')
  assert.equal(historicalMl.availability, 'unavailable')
  assert.equal(historicalMl.availabilityReason, 'no_model_as_of')

  console.log(JSON.stringify({
    status: 'ok',
    valuationDate: dates?.serving_date,
    screeningAsOf: lossMakerScreen.asOf,
    screenedCount: lossMakerScreen.total,
    historicalMl,
    jstCases: jstCases.map(([instant, expected]) => ({ instant, expected })),
  }, null, 2))
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
