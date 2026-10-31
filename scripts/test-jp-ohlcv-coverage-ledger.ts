import assert from 'node:assert/strict'
import {
  assertJpOhlcvCoverageProjection,
  assertJpOhlcvWriteAllowedByIssue,
  reconcileJpOhlcvCoverageLedger,
  type JpOhlcvCoverageProjection,
} from '@/lib/jp-ohlcv-coverage-ledger'
import type { JpOfficialOhlcvValue, JpOhlcvValue } from '@/lib/jp-ohlcv-data-quality'

const july = '2026-07-17'
const october = '2026-10-30'
const official: JpOfficialOhlcvValue[] = [
  { ticker: '1306', date: july, open: 400, high: 410, low: 399, close: 407.9, volume: 10, adjustmentFactor: 1 },
  { ticker: '7003', date: july, open: 4400, high: 4500, low: 4300, close: 4434, volume: 20, adjustmentFactor: 1 },
  { ticker: '1447', date: july, open: 273.7, high: 285.1, low: 267, close: 270.4, volume: 30, adjustmentFactor: 1 },
  { ticker: '2164', date: july, open: 113, high: 113, low: 105, close: 108.3, volume: 40, adjustmentFactor: 1 },
]
const exact = (row: JpOfficialOhlcvValue): JpOhlcvValue => {
  const { adjustmentFactor: _factor, ...projected } = row
  return projected
}
const existing: JpOhlcvValue[] = [
  exact(official[0]),
  { ...exact(official[2]), close: 270.2 },
  { ...exact(official[3]), close: 108.2 },
]
const initial = {
  previousProjection: null,
  expectedPreviousProjectionSha256: null,
  priorIssueObservations: [],
} as const
const continueFrom = (projection: JpOhlcvCoverageProjection, observations: Array<{
  date: string
  ticker: string
  existing: JpOhlcvValue | null
}>) => ({
  previousProjection: projection,
  expectedPreviousProjectionSha256: projection.projectionSha256,
  priorIssueObservations: observations,
})

const first = reconcileJpOhlcvCoverageLedger({
  sourceRunId: 10,
  targetDate: july,
  officialRows: official,
  existingRows: existing,
  ...initial,
})
assertJpOhlcvCoverageProjection(first)
assert.equal(first.status, 'HOLD')
assert.equal(first.publicationStatus, 'PARTIAL_HOLD')
assert.equal(first.openMissing, 1)
assert.equal(first.openConflicts, 2)
assert.ok(first.reasons.includes('open_missing:2026-07-17:7003'))
assert.ok(first.reasons.includes('open_conflict:2026-07-17:1447'))

const julyObservations = [
  { ticker: '7003', date: july, existing: null },
  { ticker: '1447', date: july, existing: existing[1] },
  { ticker: '2164', date: july, existing: existing[2] },
]
const currentOfficial = official.map((row) => ({ ...row, date: october }))
const currentComplete = currentOfficial.map(exact)
const outsideWindow = reconcileJpOhlcvCoverageLedger({
  sourceRunId: 11,
  targetDate: october,
  officialRows: currentOfficial,
  existingRows: currentComplete,
  ...continueFrom(first, julyObservations),
})
assert.equal(outsideWindow.status, 'HOLD')
assert.equal(outsideWindow.publicationStatus, 'PARTIAL_HOLD')
assert.equal(outsideWindow.openMissing, 1)
assert.equal(outsideWindow.openConflicts, 2)
assert.equal(outsideWindow.issues.filter((issue) => issue.date === july && issue.status === 'OPEN').length, 3)

const oldConflictChanged = reconcileJpOhlcvCoverageLedger({
  sourceRunId: 12,
  targetDate: october,
  officialRows: currentOfficial,
  existingRows: currentComplete,
  ...continueFrom(first, julyObservations.map((observation) => observation.ticker === '1447'
    ? { ...observation, existing: { ...existing[1], close: 269.9 } }
    : observation)),
})
assert.equal(oldConflictChanged.publicationStatus, 'EVIDENCE_HOLD')
assert.ok(oldConflictChanged.reasons.some((reason) => reason.startsWith('protected_conflict_value_changed:')))

const omittedLedger = reconcileJpOhlcvCoverageLedger({
  sourceRunId: 12,
  targetDate: october,
  officialRows: currentOfficial,
  existingRows: currentComplete,
  previousProjection: null,
  expectedPreviousProjectionSha256: first.projectionSha256,
  priorIssueObservations: [],
})
assert.equal(omittedLedger.publicationStatus, 'EVIDENCE_HOLD')
assert.ok(omittedLedger.reasons.includes('previous_projection_missing'))

const missingObservation = reconcileJpOhlcvCoverageLedger({
  sourceRunId: 12,
  targetDate: october,
  officialRows: currentOfficial,
  existingRows: currentComplete,
  ...continueFrom(first, []),
})
assert.equal(missingObservation.publicationStatus, 'EVIDENCE_HOLD')
assert.ok(missingObservation.reasons.some((reason) => reason.startsWith('prior_issue_observation_missing:')))

const missingRepaired = reconcileJpOhlcvCoverageLedger({
  sourceRunId: 13,
  targetDate: july,
  officialRows: official,
  existingRows: [...existing, exact(official[1])],
  ...continueFrom(outsideWindow, []),
})
assert.equal(missingRepaired.status, 'HOLD')
assert.equal(missingRepaired.publicationStatus, 'PARTIAL_HOLD')
assert.equal(missingRepaired.openMissing, 0)
assert.equal(missingRepaired.openConflicts, 2)

const conflictIssue = first.issues.find((issue) => issue.ticker === '1447')!
const overwrittenConflict = reconcileJpOhlcvCoverageLedger({
  sourceRunId: 14,
  targetDate: july,
  officialRows: official,
  existingRows: official.map(exact),
  ...continueFrom(outsideWindow, []),
})
assert.equal(overwrittenConflict.publicationStatus, 'EVIDENCE_HOLD')
assert.equal(overwrittenConflict.openConflicts, 2)
assert.ok(overwrittenConflict.reasons.some((reason) => reason.startsWith('protected_conflict_value_changed:')))

const differentlyOverwrittenConflict = reconcileJpOhlcvCoverageLedger({
  sourceRunId: 15,
  targetDate: july,
  officialRows: official,
  existingRows: existing.map((row) => row.ticker === '1447' ? { ...row, close: 269.9 } : row),
  ...continueFrom(first, []),
})
assert.equal(differentlyOverwrittenConflict.publicationStatus, 'EVIDENCE_HOLD')
assert.equal(
  differentlyOverwrittenConflict.issues.find((issue) => issue.ticker === '1447')?.existingValueSha256,
  conflictIssue.existingValueSha256,
)

const clean = reconcileJpOhlcvCoverageLedger({
  sourceRunId: 16,
  targetDate: october,
  officialRows: currentOfficial,
  existingRows: currentComplete,
  ...initial,
})
assert.equal(clean.status, 'READY')
assert.equal(clean.publicationStatus, 'PUBLISHABLE')

const missingIssue = first.issues.find((issue) => issue.kind === 'MISSING')!
assert.equal(assertJpOhlcvWriteAllowedByIssue({
  issue: missingIssue,
  current: null,
  incoming: exact(official[1]),
}), 'OFFICIAL_MISSING_INSERT')
assert.throws(() => assertJpOhlcvWriteAllowedByIssue({
  issue: missingIssue,
  current: null,
  incoming: { ...exact(official[1]), close: 999 },
}), /open_issue_write_blocked/)

const resolvedMissing = missingRepaired.issues.find((issue) => issue.kind === 'MISSING')!
assert.throws(() => assertJpOhlcvWriteAllowedByIssue({
  issue: resolvedMissing,
  current: exact(official[1]),
  incoming: exact(official[1]),
}), /issue_not_open/)

const revisedOfficial = official.map((row) => row.ticker === '7003' ? { ...row, close: 4435 } : row)
const revised = reconcileJpOhlcvCoverageLedger({
  sourceRunId: 17,
  targetDate: july,
  officialRows: revisedOfficial,
  existingRows: [...existing, exact(revisedOfficial[1])],
  ...continueFrom(first, []),
})
assert.equal(revised.publicationStatus, 'EVIDENCE_HOLD')
assert.equal(revised.openMissing, 1)
assert.ok(revised.reasons.some((reason) => reason.startsWith('issue_official_value_changed:')))

const conflictExisting = existing.find((row) => row.ticker === '1447')!
assert.equal(assertJpOhlcvWriteAllowedByIssue({
  issue: conflictIssue,
  current: conflictExisting,
  incoming: conflictExisting,
}), 'EXISTING_NOOP')
assert.throws(() => assertJpOhlcvWriteAllowedByIssue({
  issue: conflictIssue,
  current: conflictExisting,
  incoming: exact(official[2]),
}), /open_issue_write_blocked/)

const tamperedProjection = {
  ...first,
  issues: first.issues.map((issue, index) => index === 0 ? { ...issue, lastObservedRunId: 999 } : issue),
} as JpOhlcvCoverageProjection
const tampered = reconcileJpOhlcvCoverageLedger({
  sourceRunId: 18,
  targetDate: october,
  officialRows: currentOfficial,
  existingRows: currentComplete,
  previousProjection: tamperedProjection,
  expectedPreviousProjectionSha256: first.projectionSha256,
  priorIssueObservations: julyObservations,
})
assert.equal(tampered.publicationStatus, 'EVIDENCE_HOLD')
assert.ok(tampered.reasons.includes('previous_projection_invalid'))
assert.equal(tampered.issues.length, 0)
assertJpOhlcvCoverageProjection(tampered)

const replayedRun = reconcileJpOhlcvCoverageLedger({
  sourceRunId: 9,
  targetDate: october,
  officialRows: currentOfficial,
  existingRows: currentComplete,
  ...continueFrom(first, julyObservations),
})
assert.equal(replayedRun.publicationStatus, 'EVIDENCE_HOLD')
assert.ok(replayedRun.reasons.includes('source_run_id_not_monotonic'))

const reopened = reconcileJpOhlcvCoverageLedger({
  sourceRunId: 19,
  targetDate: july,
  officialRows: official,
  existingRows: existing,
  ...continueFrom(missingRepaired, []),
})
assert.equal(reopened.publicationStatus, 'PARTIAL_HOLD')
assert.ok(reopened.reasons.some((reason) => reason.startsWith('issue_reopened:')))

console.log('JP OHLCV coverage ledger tests: PASS')
