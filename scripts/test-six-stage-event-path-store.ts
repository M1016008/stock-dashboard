import assert from 'node:assert/strict'
import {
  EVENT_PATH_STORE_NAMESPACE,
  EVENT_PATH_STORE_SCHEMA_SQL,
  assertEventPathStoreManifest,
  decodeDailyExcursions,
  encodeDailyExcursions,
  type EventPathStoreManifest,
} from '@/lib/research/six-stage-event-path-store'

const { DatabaseSync } = require('node:sqlite') as {
  DatabaseSync: new (path: string) => {
    exec(sql: string): void
    prepare(sql: string): { get(...bindings: unknown[]): unknown; run(...bindings: unknown[]): unknown }
    close(): void
  }
}

const database = new DatabaseSync(':memory:')
database.exec(EVENT_PATH_STORE_SCHEMA_SQL)
database.prepare('INSERT INTO ticker_dictionary(ticker_id,ticker) VALUES(?,?)').run(1, 'TEST')
database.prepare(`INSERT INTO event_paths(
  ticker_id,regime_id_c,feature_key,length,sequence_key,c_age,signal_date,entry_date,entry_open,termination_code,
  close_return_5,mfe_5,mae_5,highest_day_5,lowest_day_5,first_up_day_5,first_down_day_5,excursion_path
) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
  1, 10, 'TEST|2022-01-03', 2, '111111>211111', 1, '2022-01-03', '2022-01-04', 100, 'RIGHT_CENSORED',
  0.02, 0.07, -0.03, 3, 2, 3, null,
  encodeDailyExcursions([{ day: 1, upReturn: 0.07, downReturn: -0.03 }]),
)
const stored = database.prepare('SELECT length,termination_code,first_up_day_5 FROM event_paths').get() as {
  length: number
  termination_code: string
  first_up_day_5: number
}
assert.equal(stored.length, 2)
assert.equal(stored.termination_code, 'RIGHT_CENSORED')
assert.equal(stored.first_up_day_5, 3)
const excursionBlob = encodeDailyExcursions([
  { day: 1, upReturn: 0.01, downReturn: -0.02 },
  { day: 2, upReturn: 0.03, downReturn: -0.04 },
])
assert.deepEqual(decodeDailyExcursions(excursionBlob), [
  { day: 1, upReturn: 0.01, downReturn: -0.02 },
  { day: 2, upReturn: 0.03, downReturn: -0.04 },
])
assert.throws(() => database.prepare(`INSERT INTO event_paths(
  ticker_id,regime_id_c,feature_key,length,sequence_key,c_age,signal_date,termination_code
) VALUES(?,?,?,?,?,?,?,?)`).run(1, 11, 'TEST|2022-01-04', 4, 'X', 1, '2022-01-04', 'COMPLETE'))
assert.throws(() => database.prepare(`INSERT INTO event_paths(
  ticker_id,regime_id_c,feature_key,length,sequence_key,c_age,signal_date,termination_code
) VALUES(?,?,?,?,?,?,?,?)`).run(1, 12, 'TEST|2023-01-03', 2, 'X>Y', 1, '2023-01-03', 'RIGHT_CENSORED'))
for (const [regimeId, malformedDate] of [
  [13, '01/03/2023'],
  [14, '2022-02-30'],
  [15, ''],
  [16, '2022-00-15'],
  [17, '2022-01-00'],
  [18, '2022-01-32'],
  [19, '2021-99-99'],
] as const) {
  assert.throws(() => database.prepare(`INSERT INTO event_paths(
    ticker_id,regime_id_c,feature_key,length,sequence_key,c_age,signal_date,termination_code
  ) VALUES(?,?,?,?,?,?,?,?)`).run(1, regimeId, `TEST|${malformedDate}`, 2, 'X>Y', 1, malformedDate, 'RIGHT_CENSORED'))
}
database.close()

const hash = 'a'.repeat(64)
const manifest: EventPathStoreManifest = {
  schemaVersion: 3,
  namespace: EVENT_PATH_STORE_NAMESPACE,
  market: 'JP',
  status: 'COMPLETE',
  sourceReadOnly: true,
  productionAccess: 0,
  validationAccess: 0,
  holdoutAccess: 0,
  rawOhlcCopied: false,
  smaRowsCopied: false,
  source: {
    foundationManifestSha256: hash,
    foundationLogicalDigest: hash,
    f1ManifestSha256: hash,
    f1LogicalSha256: hash,
    priceSourceIdentityHash: hash,
    priceSourceFileSha256: hash,
    reconciliationManifestSha256: hash,
    lineagePolicySha256: hash,
    priceBasis: 'SPLIT_ONLY_GROSS_PRICE',
    discoveryCutoff: '2022-12-30',
  },
  lineageAudit: {
    boundaryCount: 0,
    affectedEvents: 0,
    crossBoundaryOutcomes: 0,
    quarantinedPhysicalRowsUsed: 0,
  },
  maximumObservedExitDate: '2022-12-30',
  rows: {
    tickers: 1,
    events: 2,
    length2: 1,
    length3: 1,
    complete5: 2,
    complete10: 2,
    complete15: 1,
    complete20: 1,
    missingEntry: 0,
    invalidPrice: 0,
    rightCensored: 1,
  },
  file: { bytes: 4096, sha256: hash },
}
assert.doesNotThrow(() => assertEventPathStoreManifest(manifest))
assert.throws(() => assertEventPathStoreManifest({ ...manifest, rows: { ...manifest.rows, complete20: 3 } }))
assert.throws(() => assertEventPathStoreManifest({ ...manifest, productionAccess: 1 } as unknown as EventPathStoreManifest))
assert.throws(() => assertEventPathStoreManifest({ ...manifest, maximumObservedExitDate: '2023-01-03' }))
assert.throws(() => assertEventPathStoreManifest({ ...manifest, maximumObservedExitDate: null }))
assert.doesNotThrow(() => assertEventPathStoreManifest({ ...manifest, pValue: 0.01, qValue: 0.02 } as EventPathStoreManifest))
assert.throws(() => assertEventPathStoreManifest({ ...manifest, selected: true } as EventPathStoreManifest))

console.log('six-stage event path store tests passed')
