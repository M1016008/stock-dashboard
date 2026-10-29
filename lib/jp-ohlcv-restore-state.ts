export type JpOhlcvRestorePhase =
  | 'PREPARING'
  | 'BACKUP_STAGED'
  | 'PRIMARY_ARCHIVED'
  | 'BACKUP_ACTIVATED'
  | 'SOURCE_GENERATION_RESTORED'
  | 'COMPLETED'

export type JpOhlcvRestoreState = {
  version: 1
  configurationSha256: string
  transactionId: string
  databaseRealpath: string
  backupRealpath: string
  backupSha256: string
  temporaryPath: string
  failedPath: string
  phase: JpOhlcvRestorePhase
  updatedAt: string
}

const INCOMPLETE_PHASES = new Set<JpOhlcvRestorePhase>([
  'PREPARING',
  'BACKUP_STAGED',
  'PRIMARY_ARCHIVED',
  'BACKUP_ACTIVATED',
  'SOURCE_GENERATION_RESTORED',
])

export function assertIncompleteJpOhlcvRestoreState(
  value: unknown,
  expected: Omit<JpOhlcvRestoreState, 'phase' | 'updatedAt'>,
): asserts value is JpOhlcvRestoreState {
  const state = value as Partial<JpOhlcvRestoreState> | null
  if (!state
    || state.version !== expected.version
    || state.configurationSha256 !== expected.configurationSha256
    || state.transactionId !== expected.transactionId
    || state.databaseRealpath !== expected.databaseRealpath
    || state.backupRealpath !== expected.backupRealpath
    || state.backupSha256 !== expected.backupSha256
    || state.temporaryPath !== expected.temporaryPath
    || state.failedPath !== expected.failedPath
    || !state.phase
    || !INCOMPLETE_PHASES.has(state.phase)
    || typeof state.updatedAt !== 'string'
    || !Number.isFinite(Date.parse(state.updatedAt))) {
    throw new Error('repair_incomplete_restore_state_exact_identity_required')
  }
}
