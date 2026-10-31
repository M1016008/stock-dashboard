import {
  JP_OHLCV_PRICE_BASIS,
  buildJpOhlcvBackfillPlan,
  normalizeJpOhlcvTicker,
  sameJpOhlcvValue,
  sortJpOhlcvRows,
  stableSha256,
  type JpOfficialOhlcvValue,
  type JpOhlcvValue,
} from '@/lib/jp-ohlcv-data-quality'

export type JpOhlcvCoverageIssueKind = 'MISSING' | 'VALUE_CONFLICT'
export type JpOhlcvCoverageIssueStatus = 'OPEN' | 'RESOLVED'

export type JpOhlcvCoverageIssue = {
  version: 1
  date: string
  ticker: string
  kind: JpOhlcvCoverageIssueKind
  status: JpOhlcvCoverageIssueStatus
  priceBasis: typeof JP_OHLCV_PRICE_BASIS
  officialValueSha256: string
  existingValueSha256: string | null
  firstObservedRunId: number
  lastObservedRunId: number
  resolvedRunId: number | null
  issueSha256: string
}

export type JpOhlcvCoverageProjection = {
  version: 1
  sourceRunId: number
  targetDate: string
  previousProjectionSha256: string | null
  status: 'READY' | 'HOLD'
  publicationStatus: 'PUBLISHABLE' | 'PARTIAL_HOLD' | 'EVIDENCE_HOLD'
  officialSha256: string
  openMissing: number
  openConflicts: number
  issues: JpOhlcvCoverageIssue[]
  reasons: string[]
  projectionSha256: string
}

export type JpOhlcvPriorIssueObservation = {
  date: string
  ticker: string
  existing: JpOhlcvValue | null
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function value(row: JpOhlcvValue): JpOhlcvValue {
  return {
    ticker: normalizeJpOhlcvTicker(row.ticker),
    date: row.date,
    open: row.open,
    high: row.high,
    low: row.low,
    close: row.close,
    volume: row.volume,
  }
}

function rowKey(row: Pick<JpOhlcvValue, 'ticker' | 'date'>): string {
  return `${normalizeJpOhlcvTicker(row.ticker)}:${row.date}`
}

function issueKey(issue: Pick<JpOhlcvCoverageIssue, 'date' | 'ticker' | 'kind'>): string {
  return `${issue.date}:${normalizeJpOhlcvTicker(issue.ticker)}:${issue.kind}`
}

function sealIssue(body: Omit<JpOhlcvCoverageIssue, 'issueSha256'>): JpOhlcvCoverageIssue {
  return { ...body, issueSha256: stableSha256(body) }
}

function isSha256(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
}

export function assertJpOhlcvCoverageIssue(issue: JpOhlcvCoverageIssue): void {
  const { issueSha256, ...body } = issue
  const runsValid = Number.isSafeInteger(issue.firstObservedRunId)
    && Number.isSafeInteger(issue.lastObservedRunId)
    && issue.firstObservedRunId > 0
    && issue.firstObservedRunId <= issue.lastObservedRunId
  const resolvedValid = issue.status === 'RESOLVED'
    ? Number.isSafeInteger(issue.resolvedRunId) && issue.resolvedRunId! >= issue.lastObservedRunId
    : issue.resolvedRunId === null
  const existingHashValid = issue.kind === 'MISSING'
    ? issue.existingValueSha256 === null || (issue.status === 'RESOLVED' && isSha256(issue.existingValueSha256))
    : isSha256(issue.existingValueSha256)
  if (issue.version !== 1
    || !/^\d{4}-\d{2}-\d{2}$/.test(issue.date)
    || normalizeJpOhlcvTicker(issue.ticker) !== issue.ticker
    || !['MISSING', 'VALUE_CONFLICT'].includes(issue.kind)
    || !['OPEN', 'RESOLVED'].includes(issue.status)
    || (issue.kind === 'VALUE_CONFLICT' && issue.status !== 'OPEN')
    || issue.priceBasis !== JP_OHLCV_PRICE_BASIS
    || !isSha256(issue.officialValueSha256)
    || !existingHashValid
    || !runsValid
    || !resolvedValid
    || stableSha256(body) !== issueSha256) {
    throw new Error(`jp_ohlcv_coverage_issue_invalid:${issueKey(issue)}`)
  }
}

export function assertJpOhlcvCoverageProjection(projection: JpOhlcvCoverageProjection): void {
  const { projectionSha256, ...body } = projection
  const keys = new Set<string>()
  for (const issue of projection.issues) {
    assertJpOhlcvCoverageIssue(issue)
    const key = issueKey(issue)
    if (keys.has(key)) throw new Error(`jp_ohlcv_coverage_projection_duplicate_issue:${key}`)
    keys.add(key)
  }
  const open = projection.issues.filter((issue) => issue.status === 'OPEN')
  const openMissing = open.filter((issue) => issue.kind === 'MISSING').length
  const openConflicts = open.filter((issue) => issue.kind === 'VALUE_CONFLICT').length
  const reasonsSorted = [...new Set(projection.reasons)].sort(compareText)
  const requiredOpenReasons = open.map((issue) => (
    `${issue.kind === 'MISSING' ? 'open_missing' : 'open_conflict'}:${issue.date}:${issue.ticker}`
  ))
  const runBoundsValid = projection.issues.every((issue) => (
    issue.firstObservedRunId <= projection.sourceRunId
      && issue.lastObservedRunId <= projection.sourceRunId
      && (issue.resolvedRunId === null || issue.resolvedRunId <= projection.sourceRunId)
  ))
  const statusValid = projection.publicationStatus === 'PUBLISHABLE'
    ? projection.status === 'READY' && open.length === 0 && projection.reasons.length === 0
    : projection.publicationStatus === 'PARTIAL_HOLD'
      ? projection.status === 'HOLD'
        && open.length > 0
        && projection.reasons.every((reason) => reason.startsWith('open_') || reason.startsWith('issue_reopened:'))
      : projection.publicationStatus === 'EVIDENCE_HOLD' && projection.status === 'HOLD'
  if (projection.version !== 1
    || !Number.isSafeInteger(projection.sourceRunId)
    || projection.sourceRunId <= 0
    || !/^\d{4}-\d{2}-\d{2}$/.test(projection.targetDate)
    || (projection.previousProjectionSha256 !== null && !isSha256(projection.previousProjectionSha256))
    || !isSha256(projection.officialSha256)
    || openMissing !== projection.openMissing
    || openConflicts !== projection.openConflicts
    || !runBoundsValid
    || projection.reasons.length !== reasonsSorted.length
    || projection.reasons.some((reason, index) => reason !== reasonsSorted[index])
    || requiredOpenReasons.some((reason) => !projection.reasons.includes(reason))
    || !statusValid
    || stableSha256(body) !== projectionSha256) {
    throw new Error('jp_ohlcv_coverage_projection_invalid')
  }
}

export function reconcileJpOhlcvCoverageLedger(input: {
  sourceRunId: number
  targetDate: string
  officialRows: readonly JpOfficialOhlcvValue[]
  existingRows: readonly JpOhlcvValue[]
  previousProjection: JpOhlcvCoverageProjection | null
  expectedPreviousProjectionSha256: string | null
  priorIssueObservations: readonly JpOhlcvPriorIssueObservation[]
}): JpOhlcvCoverageProjection {
  const officialRows = sortJpOhlcvRows(input.officialRows)
  const existingRows = sortJpOhlcvRows(input.existingRows)
  const plan = buildJpOhlcvBackfillPlan({
    date: input.targetDate,
    officialRows,
    existingRows,
  })
  const evidenceReasons = new Set<string>()
  const issueReasons = new Set<string>()
  if (!Number.isSafeInteger(input.sourceRunId) || input.sourceRunId <= 0) {
    evidenceReasons.add('source_run_id_invalid')
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.targetDate)) evidenceReasons.add('target_date_invalid')
  if (officialRows.length === 0) evidenceReasons.add('official_rows_empty')

  let previousIssues: readonly JpOhlcvCoverageIssue[] = []
  if (input.previousProjection) {
    let previousProjectionValid = true
    try {
      assertJpOhlcvCoverageProjection(input.previousProjection)
    } catch {
      previousProjectionValid = false
      evidenceReasons.add('previous_projection_invalid')
    }
    if (input.expectedPreviousProjectionSha256 === null
      || input.previousProjection.projectionSha256 !== input.expectedPreviousProjectionSha256) {
      evidenceReasons.add('previous_projection_identity_mismatch')
    }
    if (input.previousProjection.publicationStatus === 'EVIDENCE_HOLD') {
      evidenceReasons.add('previous_projection_not_continuable')
    }
    if (Number.isSafeInteger(input.sourceRunId)
      && input.sourceRunId <= input.previousProjection.sourceRunId) {
      evidenceReasons.add('source_run_id_not_monotonic')
    }
    previousIssues = previousProjectionValid ? input.previousProjection.issues : []
  } else if (input.expectedPreviousProjectionSha256 !== null) {
    evidenceReasons.add('previous_projection_missing')
  }

  const previous = new Map<string, JpOhlcvCoverageIssue>()
  for (const issue of previousIssues) {
    const key = issueKey(issue)
    if (previous.has(key)) evidenceReasons.add(`previous_issue_duplicate:${key}`)
    previous.set(key, issue)
  }
  const unsupportedConflicts = plan.conflicts.filter((conflict) => conflict.reason !== 'EXISTING_VALUE_CONFLICT')
  for (const conflict of unsupportedConflicts) {
    evidenceReasons.add(`coverage_input_invalid:${conflict.ticker}:${conflict.date}:${conflict.reason}`)
  }

  const officialByKey = new Map(officialRows.map((row) => [rowKey(row), row]))
  const existingByKey = new Map(existingRows.map((row) => [rowKey(row), row]))
  const requiredObservationKeys = new Set(
    previousIssues
      .filter((issue) => issue.status === 'OPEN' && issue.date !== input.targetDate)
      .map((issue) => rowKey(issue)),
  )
  const observations = new Map<string, JpOhlcvValue | null>()
  for (const observation of input.priorIssueObservations) {
    const key = rowKey(observation)
    if (!requiredObservationKeys.has(key)) evidenceReasons.add(`prior_issue_observation_unexpected:${key}`)
    if (observations.has(key)) evidenceReasons.add(`prior_issue_observation_duplicate:${key}`)
    if (observation.existing
      && (rowKey(observation.existing) !== key || observation.existing.date !== observation.date)) {
      evidenceReasons.add(`prior_issue_observation_row_mismatch:${key}`)
    }
    observations.set(key, observation.existing ? value(observation.existing) : null)
  }
  for (const key of requiredObservationKeys) {
    if (!observations.has(key)) evidenceReasons.add(`prior_issue_observation_missing:${key}`)
  }

  const current = new Map<string, JpOhlcvCoverageIssue>()
  const observe = (inputIssue: {
    ticker: string
    kind: JpOhlcvCoverageIssueKind
    official: JpOfficialOhlcvValue
    existing: JpOhlcvValue | null
  }) => {
    const key = `${input.targetDate}:${normalizeJpOhlcvTicker(inputIssue.ticker)}:${inputIssue.kind}`
    const prior = previous.get(key)
    const officialValueSha256 = stableSha256(value(inputIssue.official))
    const existingValueSha256 = inputIssue.existing ? stableSha256(value(inputIssue.existing)) : null
    if (prior && prior.officialValueSha256 !== officialValueSha256) {
      evidenceReasons.add(`issue_official_value_changed:${key}`)
      current.set(key, prior)
      return
    }
    if (prior?.kind === 'VALUE_CONFLICT' && prior.existingValueSha256 !== existingValueSha256) {
      evidenceReasons.add(`protected_conflict_value_changed:${key}`)
      current.set(key, prior)
      return
    }
    if (prior?.status === 'RESOLVED') issueReasons.add(`issue_reopened:${key}`)
    current.set(key, sealIssue({
      version: 1,
      date: input.targetDate,
      ticker: normalizeJpOhlcvTicker(inputIssue.ticker),
      kind: inputIssue.kind,
      status: 'OPEN',
      priceBasis: JP_OHLCV_PRICE_BASIS,
      officialValueSha256,
      existingValueSha256,
      firstObservedRunId: prior?.firstObservedRunId ?? input.sourceRunId,
      lastObservedRunId: input.sourceRunId,
      resolvedRunId: null,
    }))
  }
  for (const row of plan.missingRows) observe({ ticker: row.ticker, kind: 'MISSING', official: row, existing: null })
  for (const conflict of plan.conflicts) {
    if (conflict.reason === 'EXISTING_VALUE_CONFLICT' && conflict.official && conflict.existing) {
      observe({
        ticker: conflict.ticker,
        kind: 'VALUE_CONFLICT',
        official: conflict.official,
        existing: conflict.existing,
      })
    }
  }

  const next = new Map(previous)
  for (const [key, issue] of current) next.set(key, issue)
  for (const [key, issue] of previous) {
    if (issue.status === 'RESOLVED' || current.has(key)) continue
    const keyForRow = rowKey(issue)
    const currentOfficial = issue.date === input.targetDate ? officialByKey.get(keyForRow) : undefined
    if (currentOfficial && stableSha256(value(currentOfficial)) !== issue.officialValueSha256) {
      evidenceReasons.add(`issue_official_value_changed:${key}`)
      continue
    }
    const observed = issue.date === input.targetDate
      ? existingByKey.get(keyForRow) ?? null
      : observations.get(keyForRow)
    if (observed === undefined) continue
    if (issue.kind === 'VALUE_CONFLICT') {
      if (!observed || stableSha256(value(observed)) !== issue.existingValueSha256) {
        evidenceReasons.add(`protected_conflict_value_changed:${key}`)
      }
      continue
    }
    if (observed === null) continue
    if (stableSha256(value(observed)) !== issue.officialValueSha256) {
      evidenceReasons.add(`issue_resolution_value_mismatch:${key}`)
      continue
    }
    const { issueSha256: _previousSha256, ...previousBody } = issue
    next.set(key, sealIssue({
      ...previousBody,
      status: 'RESOLVED',
      existingValueSha256: stableSha256(value(observed)),
      lastObservedRunId: input.sourceRunId,
      resolvedRunId: input.sourceRunId,
    }))
  }

  const issues = [...next.values()].sort((left, right) => compareText(issueKey(left), issueKey(right)))
  const open = issues.filter((issue) => issue.status === 'OPEN')
  for (const issue of open) {
    issueReasons.add(`${issue.kind === 'MISSING' ? 'open_missing' : 'open_conflict'}:${issue.date}:${issue.ticker}`)
  }
  const reasons = [...evidenceReasons, ...issueReasons].sort(compareText)
  const body = {
    version: 1 as const,
    sourceRunId: input.sourceRunId,
    targetDate: input.targetDate,
    previousProjectionSha256: input.previousProjection?.projectionSha256 ?? null,
    status: reasons.length === 0 ? 'READY' as const : 'HOLD' as const,
    publicationStatus: evidenceReasons.size > 0
      ? 'EVIDENCE_HOLD' as const
      : open.length === 0 ? 'PUBLISHABLE' as const : 'PARTIAL_HOLD' as const,
    officialSha256: plan.officialSha256,
    openMissing: open.filter((issue) => issue.kind === 'MISSING').length,
    openConflicts: open.filter((issue) => issue.kind === 'VALUE_CONFLICT').length,
    issues,
    reasons,
  }
  return { ...body, projectionSha256: stableSha256(body) }
}

export function assertJpOhlcvWriteAllowedByIssue(input: {
  issue: JpOhlcvCoverageIssue
  current: JpOhlcvValue | null
  incoming: JpOhlcvValue
}): 'OFFICIAL_MISSING_INSERT' | 'EXISTING_NOOP' {
  assertJpOhlcvCoverageIssue(input.issue)
  if (input.issue.status !== 'OPEN') {
    throw new Error(`jp_ohlcv_issue_not_open:${issueKey(input.issue)}`)
  }
  const incomingSha = stableSha256(value(input.incoming))
  if (input.issue.kind === 'MISSING' && input.current === null
    && incomingSha === input.issue.officialValueSha256) {
    return 'OFFICIAL_MISSING_INSERT'
  }
  if (input.issue.kind === 'VALUE_CONFLICT' && input.current
    && sameJpOhlcvValue(value(input.current), value(input.incoming))
    && stableSha256(value(input.current)) === input.issue.existingValueSha256) {
    return 'EXISTING_NOOP'
  }
  throw new Error(`jp_ohlcv_open_issue_write_blocked:${issueKey(input.issue)}`)
}
