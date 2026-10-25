import {
  EVENT_PATH_HORIZONS,
  EVENT_PATH_DISCOVERY_CUTOFF,
  assertNoLegacyH10DecisionFields,
  type DailyExcursionPoint,
} from '@/lib/research/six-stage-event-path-research'

export const EVENT_PATH_STORE_SCHEMA_VERSION = 3
export const EVENT_PATH_STORE_NAMESPACE = 'SIX_STAGE_ALL_EVENT_PATH_V3'

export const EVENT_PATH_STORE_SCHEMA_SQL = `
PRAGMA foreign_keys=ON;
CREATE TABLE metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL);
CREATE TABLE ticker_dictionary(
  ticker_id INTEGER PRIMARY KEY,
  ticker TEXT NOT NULL UNIQUE
);
CREATE TABLE event_paths(
  ticker_id INTEGER NOT NULL,
  regime_id_c INTEGER NOT NULL,
  feature_key TEXT NOT NULL,
  length INTEGER NOT NULL CHECK(length IN (2,3)),
  sequence_key TEXT NOT NULL,
  c_age INTEGER NOT NULL CHECK(c_age>=1),
  signal_date TEXT NOT NULL CHECK(
    signal_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
    AND coalesce(date(signal_date)=signal_date,0)
    AND signal_date <= '${EVENT_PATH_DISCOVERY_CUTOFF}'
  ),
  entry_date TEXT CHECK(entry_date IS NULL OR (
    entry_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
    AND coalesce(date(entry_date)=entry_date,0)
    AND entry_date <= '${EVENT_PATH_DISCOVERY_CUTOFF}'
  )),
  entry_open REAL,
  termination_code TEXT NOT NULL CHECK(termination_code IN ('COMPLETE','MISSING_ENTRY','INVALID_PRICE','RIGHT_CENSORED')),
  close_return_5 REAL,close_return_10 REAL,close_return_15 REAL,close_return_20 REAL,
  exit_date_5 TEXT CHECK(exit_date_5 IS NULL OR (
    exit_date_5 GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
    AND coalesce(date(exit_date_5)=exit_date_5,0)
    AND exit_date_5 <= '${EVENT_PATH_DISCOVERY_CUTOFF}'
  )),
  exit_date_10 TEXT CHECK(exit_date_10 IS NULL OR (
    exit_date_10 GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
    AND coalesce(date(exit_date_10)=exit_date_10,0)
    AND exit_date_10 <= '${EVENT_PATH_DISCOVERY_CUTOFF}'
  )),
  exit_date_15 TEXT CHECK(exit_date_15 IS NULL OR (
    exit_date_15 GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
    AND coalesce(date(exit_date_15)=exit_date_15,0)
    AND exit_date_15 <= '${EVENT_PATH_DISCOVERY_CUTOFF}'
  )),
  exit_date_20 TEXT CHECK(exit_date_20 IS NULL OR (
    exit_date_20 GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
    AND coalesce(date(exit_date_20)=exit_date_20,0)
    AND exit_date_20 <= '${EVENT_PATH_DISCOVERY_CUTOFF}'
  )),
  mfe_5 REAL,mfe_10 REAL,mfe_15 REAL,mfe_20 REAL,
  mae_5 REAL,mae_10 REAL,mae_15 REAL,mae_20 REAL,
  highest_day_5 INTEGER,highest_day_10 INTEGER,highest_day_15 INTEGER,highest_day_20 INTEGER,
  lowest_day_5 INTEGER,lowest_day_10 INTEGER,lowest_day_15 INTEGER,lowest_day_20 INTEGER,
  first_up_day_5 INTEGER,first_up_day_10 INTEGER,first_up_day_15 INTEGER,first_up_day_20 INTEGER,
  first_down_day_5 INTEGER,first_down_day_10 INTEGER,first_down_day_15 INTEGER,first_down_day_20 INTEGER,
  excursion_path BLOB,
  PRIMARY KEY(ticker_id,regime_id_c,length),
  FOREIGN KEY(ticker_id) REFERENCES ticker_dictionary(ticker_id)
) WITHOUT ROWID;
CREATE INDEX event_paths_termination_idx ON event_paths(termination_code,length);
CREATE INDEX event_paths_sequence_idx ON event_paths(length,sequence_key,c_age);
CREATE INDEX event_paths_feature_key_idx ON event_paths(feature_key);
CREATE INDEX event_paths_signal_date_idx ON event_paths(signal_date,length);
CREATE TABLE ticker_checkpoints(
  ticker_id INTEGER PRIMARY KEY,
  source_rows INTEGER NOT NULL,
  entry_events INTEGER NOT NULL,
  complete_5 INTEGER NOT NULL,
  complete_10 INTEGER NOT NULL,
  complete_15 INTEGER NOT NULL,
  complete_20 INTEGER NOT NULL,
  missing_entry INTEGER NOT NULL,
  invalid_price INTEGER NOT NULL,
  right_censored INTEGER NOT NULL,
  FOREIGN KEY(ticker_id) REFERENCES ticker_dictionary(ticker_id)
);
`

export type EventPathStoreSourceBinding = {
  foundationManifestSha256: string
  foundationLogicalDigest: string
  f1ManifestSha256: string
  f1LogicalSha256: string
  priceSourceIdentityHash: string
  priceSourceFileSha256: string
  reconciliationManifestSha256: string
  lineagePolicySha256: string
  priceBasis: string
  discoveryCutoff: typeof EVENT_PATH_DISCOVERY_CUTOFF
}

export type EventPathStoreManifest = {
  schemaVersion: typeof EVENT_PATH_STORE_SCHEMA_VERSION
  namespace: typeof EVENT_PATH_STORE_NAMESPACE
  market: 'JP' | 'US'
  status: 'COMPLETE'
  sourceReadOnly: true
  productionAccess: 0
  validationAccess: 0
  holdoutAccess: 0
  rawOhlcCopied: false
  smaRowsCopied: false
  source: EventPathStoreSourceBinding
  lineageAudit: {
    boundaryCount: number
    affectedEvents: number
    crossBoundaryOutcomes: 0
    quarantinedPhysicalRowsUsed: 0
  }
  maximumObservedExitDate: string | null
  rows: {
    tickers: number
    events: number
    length2: number
    length3: number
    complete5: number
    complete10: number
    complete15: number
    complete20: number
    missingEntry: number
    invalidPrice: number
    rightCensored: number
  }
  file: { bytes: number; sha256: string }
}

const EXCURSION_HEADER_BYTES = 1
const EXCURSION_POINT_BYTES = 16

/**
 * Compact derived path only: cumulative-free daily high/low returns from Entry.
 * This is sufficient for arbitrary first-passage thresholds without duplicating
 * source OHLC, dates, volume, or prices.
 */
export function encodeDailyExcursions(points: readonly DailyExcursionPoint[]): Uint8Array {
  if (points.length > EVENT_PATH_HORIZONS.at(-1)!) throw new Error('excursion path exceeds 20 sessions')
  const bytes = new Uint8Array(EXCURSION_HEADER_BYTES + points.length * EXCURSION_POINT_BYTES)
  const view = new DataView(bytes.buffer)
  view.setUint8(0, points.length)
  points.forEach((point, index) => {
    if (point.day !== index + 1 || !Number.isFinite(point.upReturn) || !Number.isFinite(point.downReturn)) {
      throw new Error('invalid excursion point')
    }
    const offset = EXCURSION_HEADER_BYTES + index * EXCURSION_POINT_BYTES
    view.setFloat64(offset, point.upReturn, true)
    view.setFloat64(offset + 8, point.downReturn, true)
  })
  return bytes
}

export function decodeDailyExcursions(value: Uint8Array): DailyExcursionPoint[] {
  if (value.byteLength < EXCURSION_HEADER_BYTES) throw new Error('invalid excursion blob')
  const view = new DataView(value.buffer, value.byteOffset, value.byteLength)
  const count = view.getUint8(0)
  if (count > EVENT_PATH_HORIZONS.at(-1)! || value.byteLength !== EXCURSION_HEADER_BYTES + count * EXCURSION_POINT_BYTES) {
    throw new Error('invalid excursion blob')
  }
  return Array.from({ length: count }, (_, index) => {
    const offset = EXCURSION_HEADER_BYTES + index * EXCURSION_POINT_BYTES
    const upReturn = view.getFloat64(offset, true)
    const downReturn = view.getFloat64(offset + 8, true)
    if (!Number.isFinite(upReturn) || !Number.isFinite(downReturn)) throw new Error('invalid excursion blob')
    return { day: index + 1, upReturn, downReturn }
  })
}

function sha256(value: string, field: string): void {
  if (!/^[0-9a-f]{64}$/.test(value)) throw new Error(`invalid ${field}`)
}

function isoDate(value: string, field: string): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error(`invalid ${field}`)
  const parsed = new Date(`${value}T00:00:00.000Z`)
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new Error(`invalid ${field}`)
  }
}

export function assertEventPathStoreManifest(value: EventPathStoreManifest): void {
  assertNoLegacyH10DecisionFields(value)
  if (value.schemaVersion !== EVENT_PATH_STORE_SCHEMA_VERSION || value.namespace !== EVENT_PATH_STORE_NAMESPACE) {
    throw new Error('event path store schema mismatch')
  }
  if (value.market !== 'JP' && value.market !== 'US') throw new Error('event path store market mismatch')
  if (value.status !== 'COMPLETE' || !value.sourceReadOnly) throw new Error('event path store is incomplete')
  if (value.productionAccess !== 0 || value.validationAccess !== 0 || value.holdoutAccess !== 0) {
    throw new Error('protected source access is forbidden')
  }
  if (value.rawOhlcCopied !== false || value.smaRowsCopied !== false) {
    throw new Error('duplicated source data is forbidden')
  }
  sha256(value.source.foundationManifestSha256, 'foundation manifest hash')
  sha256(value.source.foundationLogicalDigest, 'foundation logical digest')
  sha256(value.source.f1ManifestSha256, 'F1 manifest hash')
  sha256(value.source.f1LogicalSha256, 'F1 logical hash')
  sha256(value.source.priceSourceIdentityHash, 'price source identity hash')
  sha256(value.source.priceSourceFileSha256, 'price source file hash')
  sha256(value.source.reconciliationManifestSha256, 'reconciliation manifest hash')
  sha256(value.source.lineagePolicySha256, 'lineage policy hash')
  sha256(value.file.sha256, 'event path store hash')
  if (
    !Number.isSafeInteger(value.lineageAudit.boundaryCount)
    || !Number.isSafeInteger(value.lineageAudit.affectedEvents)
    || value.lineageAudit.boundaryCount < 0
    || value.lineageAudit.affectedEvents < 0
    || value.lineageAudit.crossBoundaryOutcomes !== 0
    || value.lineageAudit.quarantinedPhysicalRowsUsed !== 0
  ) {
    throw new Error('lineage audit failed')
  }
  if (value.source.discoveryCutoff !== EVENT_PATH_DISCOVERY_CUTOFF) throw new Error('discovery cutoff mismatch')
  if (value.rows.complete5 > 0 && value.maximumObservedExitDate == null) {
    throw new Error('maximum observed exit date is required')
  }
  if (value.maximumObservedExitDate != null) {
    isoDate(value.maximumObservedExitDate, 'maximum observed exit date')
    if (value.maximumObservedExitDate > EVENT_PATH_DISCOVERY_CUTOFF) {
      throw new Error('outcome date exceeds discovery cutoff')
    }
  }
  const counts = value.rows
  for (const [key, count] of Object.entries(counts)) {
    if (!Number.isSafeInteger(count) || count < 0) throw new Error(`invalid row count: ${key}`)
  }
  if (counts.events !== counts.length2 + counts.length3) throw new Error('event length totals mismatch')
  if (counts.events !== counts.complete20 + counts.missingEntry + counts.invalidPrice + counts.rightCensored) {
    throw new Error('termination totals mismatch')
  }
  for (const complete of [counts.complete5, counts.complete10, counts.complete15, counts.complete20]) {
    if (complete > counts.events) throw new Error('complete horizon count exceeds events')
  }
  if (!(counts.complete5 >= counts.complete10 && counts.complete10 >= counts.complete15 && counts.complete15 >= counts.complete20)) {
    throw new Error('horizon completeness must be monotone')
  }
}
