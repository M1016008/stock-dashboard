export const LARGE_HOLDER_EXPECTED_SNAPSHOT_STATUSES = [
  'VALIDATED',
  'VALIDATED_WITH_QUARANTINE',
] as const

export type LargeHolderSnapshotStatus = typeof LARGE_HOLDER_EXPECTED_SNAPSHOT_STATUSES[number]

export type LargeHolderIdentity = {
  snapshotId: string
  snapshotStatus: LargeHolderSnapshotStatus
  certificationAsOf: string
  priceDate: string
}

export type LargeHolderInvariant = LargeHolderIdentity & {
  currentPositionCount: number
  investorCount: number
  activityCount: number
  quarantinedDocumentCount: number
  publicCurrentValuationReadyCount: number
}

type JsonObject = Record<string, unknown>

function object(value: unknown, label: string): JsonObject {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} is not an object`)
  }
  return value as JsonObject
}

function text(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value) throw new Error(`${label} is missing`)
  return value
}

function count(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw new Error(`${label} is invalid`)
  return Number(value)
}

export function largeHolderIdentity(payload: unknown, expectedPriceDate: string): LargeHolderIdentity {
  const value = object(payload, 'Large Holder response')
  if (typeof value.error === 'string' && value.error) throw new Error(`Large Holder error: ${value.error}`)
  const snapshotStatus = text(value.snapshotStatus, 'snapshotStatus')
  if (!LARGE_HOLDER_EXPECTED_SNAPSHOT_STATUSES.includes(snapshotStatus as LargeHolderSnapshotStatus)) {
    throw new Error(`snapshotStatus is not certified: ${snapshotStatus}`)
  }
  const identity = {
    snapshotId: text(value.snapshotId, 'snapshotId'),
    snapshotStatus: snapshotStatus as LargeHolderSnapshotStatus,
    certificationAsOf: text(value.certificationAsOf, 'certificationAsOf'),
    priceDate: text(value.priceDate, 'priceDate'),
  }
  if (identity.priceDate !== expectedPriceDate) {
    throw new Error(`Large Holder priceDate is stale: expected=${expectedPriceDate} actual=${identity.priceDate}`)
  }
  if (identity.certificationAsOf !== identity.priceDate) {
    throw new Error(`Large Holder certification is not current: certificationAsOf=${identity.certificationAsOf} priceDate=${identity.priceDate}`)
  }
  return identity
}

export function assertLargeHolderIdentity(payload: unknown, expected: LargeHolderIdentity,
  expectedPriceDate: string): void {
  const actual = largeHolderIdentity(payload, expectedPriceDate)
  for (const key of ['snapshotId', 'snapshotStatus', 'certificationAsOf', 'priceDate'] as const) {
    if (actual[key] !== expected[key]) {
      throw new Error(`Large Holder ${key} changed: expected=${expected[key]} actual=${actual[key]}`)
    }
  }
}

export function largeHolderInvariant(payload: unknown, expectedPriceDate: string): LargeHolderInvariant {
  const value = object(payload, 'Large Holder overview')
  const activityCounts = object(value.activityCounts, 'activityCounts')
  const activityCount = ['NEW_5PCT', 'INCREASE', 'DECREASE', 'EXIT_5PCT']
    .reduce((sum, key) => sum + count(activityCounts[key], `activityCounts.${key}`), 0)
  return {
    ...largeHolderIdentity(value, expectedPriceDate),
    currentPositionCount: count(value.currentPositionCount, 'currentPositionCount'),
    investorCount: count(value.investorCount, 'investorCount'),
    activityCount,
    quarantinedDocumentCount: count(value.quarantinedDocumentCount, 'quarantinedDocumentCount'),
    publicCurrentValuationReadyCount: count(
      value.publicCurrentValuationReadyCount,
      'publicCurrentValuationReadyCount',
    ),
  }
}

export function assertLargeHolderInvariant(before: LargeHolderInvariant,
  afterPayload: unknown, expectedPriceDate: string): void {
  const after = largeHolderInvariant(afterPayload, expectedPriceDate)
  for (const key of Object.keys(before) as (keyof LargeHolderInvariant)[]) {
    if (after[key] !== before[key]) {
      throw new Error(`Large Holder invariant changed at ${key}: expected=${before[key]} actual=${after[key]}`)
    }
  }
}
