export type StockLargeHolderAvailability =
  | 'CURRENT'
  | 'REFRESHING'
  | 'STALE'
  | 'NOT_CONFIGURED'
  | 'NO_DATA'
  | 'ERROR'

const STALE_REASONS = new Set([
  'certified_snapshot_stale',
  'certified_snapshot_stale_review',
])

const NO_DATA_REASONS = new Set([
  'certified_snapshot_missing',
  'certified_snapshot_pointer_unavailable',
])

export function stockLargeHolderFailureState(reason: string | null | undefined):
  Exclude<StockLargeHolderAvailability, 'CURRENT' | 'REFRESHING'> {
  if (reason && STALE_REASONS.has(reason)) return 'STALE'
  if (reason === 'certified_snapshot_not_configured') return 'NOT_CONFIGURED'
  if (reason && NO_DATA_REASONS.has(reason)) return 'NO_DATA'
  return 'ERROR'
}

export function stockLargeHolderCertifiedState(
  snapshotStatus: 'VALIDATED' | 'VALIDATED_WITH_QUARANTINE',
): 'CURRENT' {
  switch (snapshotStatus) {
    case 'VALIDATED':
    case 'VALIDATED_WITH_QUARANTINE':
      return 'CURRENT'
    default: {
      const exhaustive: never = snapshotStatus
      return exhaustive
    }
  }
}

export function shouldRevalidateStockLargeHolders(state: StockLargeHolderAvailability): boolean {
  return state === 'STALE'
}
