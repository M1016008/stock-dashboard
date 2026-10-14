// US日次EODのソース可用性分類とカバレッジSLA。
//
// DBに触れない純粋関数のみ。永続化は lib/server/us-source-availability-store.ts。
//
// 契約:
// - Tiingoの「ticker not found」404だけが終端エビデンスを進める。
// - 恒久除外には「異なる要求対象営業日3つ」かつ「異なるrun ID 3つ」が必要。
//   同じ対象日・同じrunの404は何度来ても進まない。
// - HTTP 200の空配列は PENDING/EMPTY_RESPONSE。エビデンスを0に戻し、成功には数えない。
//   ただし曖昧な空応答だけで既存の恒久除外は解除しない。
// - 非空レスポンスはエビデンスを0に戻し、恒久除外も取り消す。
// - 一時的な失敗はエビデンスを進めず、既存の恒久除外も消さない。
// - 1回のrunで新規恒久除外が上限を超えたら、そのrunでは誰も昇格させない。

export const US_SOURCE_AVAILABILITY_STATUSES = [
  'AVAILABLE',
  'PENDING',
  'TEMPORARILY_UNAVAILABLE',
  'PERMANENTLY_UNAVAILABLE',
] as const

export type UsSourceAvailabilityStatus = typeof US_SOURCE_AVAILABILITY_STATUSES[number]

export type UsSourceAvailabilityReason =
  | 'TARGET_DATE_PRESENT'
  | 'TARGET_DATE_MISSING'
  | 'EMPTY_RESPONSE'
  | 'PROVIDER_NOT_FOUND'
  | 'PROVIDER_NOT_FOUND_CONFIRMED'
  | 'PROMOTION_GUARD_HELD'
  | 'TRANSIENT_FAILURE'

export type UsSourceObservation =
  /** HTTP 200 non-empty. latestDataDate is the newest bar known after the response. */
  | { kind: 'DATA'; latestDataDate: string }
  /** No provider request was needed; stored bars were evaluated instead. */
  | { kind: 'STORED'; latestDataDate: string | null }
  /** HTTP 200 with an empty array. */
  | { kind: 'EMPTY' }
  /** Exact provider terminal ticker-not-found (Tiingo 404 classifier). */
  | { kind: 'NOT_FOUND'; httpStatus: number }
  /** Final non-terminal failure after retries. */
  | { kind: 'TRANSIENT'; httpStatus: number | null }

export type UsSourceObservationType = UsSourceObservation['kind']

export type UsSourceAvailabilityRecord = {
  market: string
  ticker: string
  source: string
  status: UsSourceAvailabilityStatus
  statusReason: UsSourceAvailabilityReason
  terminalEvidenceCount: number
  firstTerminalTargetDate: string | null
  lastTerminalTargetDate: string | null
  lastTerminalRunId: number | null
  lastObservationType: UsSourceObservationType
  lastObservedTargetDate: string | null
  lastSuccessDataDate: string | null
  lastHttpStatus: number | null
  updatedAt: number
}

export const US_SOURCE_TIINGO = 'tiingo'
export const US_PERMANENT_UNAVAILABLE_MIN_EVIDENCE = 3
export const US_PERMANENT_PROMOTION_MAX_SYMBOLS_DEFAULT = 25
/** Percent of the active investable universe (0.25 = 0.25%). */
export const US_PERMANENT_PROMOTION_MAX_UNIVERSE_PCT_DEFAULT = 0.25
export const US_PERMANENT_PROMOTION_MAX_SYMBOLS_ENV = 'US_SOURCE_PERMANENT_PROMOTION_MAX_SYMBOLS'
export const US_PERMANENT_PROMOTION_MAX_UNIVERSE_PCT_ENV = 'US_SOURCE_PERMANENT_PROMOTION_MAX_UNIVERSE_PCT'

/** The exact Tiingo terminal ticker-not-found shape already used by batch-us-ohlcv. */
export function isProviderTickerNotFoundError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /HTTP 404/i.test(message) && /ticker .* not found/i.test(message)
}

export function httpStatusOf(error: unknown): number | null {
  if (typeof error === 'object' && error !== null && 'status' in error) {
    const status = Number((error as { status?: unknown }).status)
    if (Number.isInteger(status) && status > 0) return status
  }
  const match = (error instanceof Error ? error.message : String(error)).match(/HTTP (\d{3})/)
  return match ? Number(match[1]) : null
}

export type UsPermanentPromotionLimits = {
  maxSymbols: number
  maxUniversePercent: number
}

function nonNegativeEnv(value: string | undefined, fallback: number): number {
  if (value == null || value.trim() === '') return fallback
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback
}

export function resolveUsPermanentPromotionLimits(
  env: Record<string, string | undefined> = process.env,
): UsPermanentPromotionLimits {
  return {
    maxSymbols: Math.floor(nonNegativeEnv(env[US_PERMANENT_PROMOTION_MAX_SYMBOLS_ENV], US_PERMANENT_PROMOTION_MAX_SYMBOLS_DEFAULT)),
    maxUniversePercent: nonNegativeEnv(
      env[US_PERMANENT_PROMOTION_MAX_UNIVERSE_PCT_ENV],
      US_PERMANENT_PROMOTION_MAX_UNIVERSE_PCT_DEFAULT,
    ),
  }
}

export type UsSourceObservationContext = {
  market: string
  source: string
  ticker: string
  runId: number
  targetDate: string
  updatedAt: number
}

export type UsSourceTransition = {
  next: UsSourceAvailabilityRecord
  /** Evidence reached the permanent threshold and the row is not already permanent. */
  eligibleForPermanent: boolean
  revertedFromPermanent: boolean
}

function laterDate(a: string | null, b: string | null): string | null {
  if (!a) return b
  if (!b) return a
  return a > b ? a : b
}

function clearedEvidence() {
  return {
    terminalEvidenceCount: 0,
    firstTerminalTargetDate: null,
    lastTerminalTargetDate: null,
    lastTerminalRunId: null,
  }
}

/**
 * One final observation for one ticker in one run. Evidence advances only when both the
 * requested target date and the run ID are strictly newer than the last recorded terminal
 * evidence, which keeps every counted date and run distinct across the evidence chain.
 */
export function applyUsSourceObservation(
  prev: UsSourceAvailabilityRecord | null,
  observation: UsSourceObservation,
  ctx: UsSourceObservationContext,
): UsSourceTransition {
  const wasPermanent = prev?.status === 'PERMANENTLY_UNAVAILABLE'
  const base = {
    market: ctx.market,
    ticker: ctx.ticker,
    source: ctx.source,
    lastObservationType: observation.kind,
    lastObservedTargetDate: ctx.targetDate,
    updatedAt: ctx.updatedAt,
  }
  const evidence = {
    terminalEvidenceCount: Math.max(0, Number(prev?.terminalEvidenceCount ?? 0)),
    firstTerminalTargetDate: prev?.firstTerminalTargetDate ?? null,
    lastTerminalTargetDate: prev?.lastTerminalTargetDate ?? null,
    lastTerminalRunId: prev?.lastTerminalRunId ?? null,
  }
  const lastSuccessDataDate = prev?.lastSuccessDataDate ?? null

  switch (observation.kind) {
    case 'DATA': {
      const present = observation.latestDataDate >= ctx.targetDate
      return {
        next: {
          ...base,
          ...clearedEvidence(),
          status: present ? 'AVAILABLE' : 'PENDING',
          statusReason: present ? 'TARGET_DATE_PRESENT' : 'TARGET_DATE_MISSING',
          lastSuccessDataDate: laterDate(lastSuccessDataDate, observation.latestDataDate),
          lastHttpStatus: 200,
        },
        eligibleForPermanent: false,
        revertedFromPermanent: wasPermanent,
      }
    }
    case 'STORED': {
      const present = observation.latestDataDate != null && observation.latestDataDate >= ctx.targetDate
      if (present) {
        // Target-date bars already exist: the ticker is demonstrably available.
        return {
          next: {
            ...base,
            ...clearedEvidence(),
            status: 'AVAILABLE',
            statusReason: 'TARGET_DATE_PRESENT',
            lastSuccessDataDate: laterDate(lastSuccessDataDate, observation.latestDataDate),
            lastHttpStatus: prev?.lastHttpStatus ?? null,
          },
          eligibleForPermanent: false,
          revertedFromPermanent: wasPermanent,
        }
      }
      // No provider evidence either way: keep evidence and any permanent classification.
      return {
        next: {
          ...base,
          ...evidence,
          status: wasPermanent ? 'PERMANENTLY_UNAVAILABLE' : 'PENDING',
          statusReason: wasPermanent ? prev!.statusReason : 'TARGET_DATE_MISSING',
          lastSuccessDataDate: laterDate(lastSuccessDataDate, observation.latestDataDate),
          lastHttpStatus: prev?.lastHttpStatus ?? null,
        },
        eligibleForPermanent: false,
        revertedFromPermanent: false,
      }
    }
    case 'EMPTY':
      return {
        next: {
          ...base,
          ...clearedEvidence(),
          status: wasPermanent ? 'PERMANENTLY_UNAVAILABLE' : 'PENDING',
          statusReason: wasPermanent ? 'PROVIDER_NOT_FOUND_CONFIRMED' : 'EMPTY_RESPONSE',
          lastSuccessDataDate,
          lastHttpStatus: 200,
        },
        eligibleForPermanent: false,
        revertedFromPermanent: false,
      }
    case 'TRANSIENT':
      return {
        next: {
          ...base,
          ...evidence,
          status: wasPermanent ? 'PERMANENTLY_UNAVAILABLE' : 'TEMPORARILY_UNAVAILABLE',
          statusReason: wasPermanent ? prev!.statusReason : 'TRANSIENT_FAILURE',
          lastSuccessDataDate,
          lastHttpStatus: observation.httpStatus,
        },
        eligibleForPermanent: false,
        revertedFromPermanent: false,
      }
    case 'NOT_FOUND': {
      const advanced = { ...evidence }
      if (advanced.terminalEvidenceCount === 0) {
        advanced.terminalEvidenceCount = 1
        advanced.firstTerminalTargetDate = ctx.targetDate
        advanced.lastTerminalTargetDate = ctx.targetDate
        advanced.lastTerminalRunId = ctx.runId
      } else if (
        (advanced.lastTerminalTargetDate == null || ctx.targetDate > advanced.lastTerminalTargetDate)
        && (advanced.lastTerminalRunId == null || ctx.runId > advanced.lastTerminalRunId)
      ) {
        advanced.terminalEvidenceCount += 1
        advanced.lastTerminalTargetDate = ctx.targetDate
        advanced.lastTerminalRunId = ctx.runId
      }
      const eligible = !wasPermanent && advanced.terminalEvidenceCount >= US_PERMANENT_UNAVAILABLE_MIN_EVIDENCE
      return {
        next: {
          ...base,
          ...advanced,
          status: wasPermanent ? 'PERMANENTLY_UNAVAILABLE' : 'TEMPORARILY_UNAVAILABLE',
          statusReason: wasPermanent ? 'PROVIDER_NOT_FOUND_CONFIRMED' : 'PROVIDER_NOT_FOUND',
          lastSuccessDataDate,
          lastHttpStatus: observation.httpStatus,
        },
        eligibleForPermanent: eligible,
        revertedFromPermanent: false,
      }
    }
  }
}

export type UsPromotionGuard = {
  triggered: boolean
  eligible: number
  maxSymbols: number
  maxUniversePercent: number
  maxByUniverse: number
  activeUniverse: number
}

export function evaluateUsPermanentPromotionGuard(
  eligible: number,
  activeUniverse: number,
  limits: UsPermanentPromotionLimits,
): UsPromotionGuard {
  const universe = Math.max(0, Math.floor(Number(activeUniverse) || 0))
  const maxByUniverse = universe * limits.maxUniversePercent / 100
  return {
    triggered: eligible > 0 && (eligible > limits.maxSymbols || eligible > maxByUniverse),
    eligible,
    maxSymbols: limits.maxSymbols,
    maxUniversePercent: limits.maxUniversePercent,
    maxByUniverse,
    activeUniverse: universe,
  }
}

export type UsSourceAvailabilityPlanInput = {
  market: string
  source: string
  runId: number
  targetDate: string
  activeUniverse: number
  limits: UsPermanentPromotionLimits
  updatedAt: number
  existing: ReadonlyMap<string, UsSourceAvailabilityRecord>
  observations: ReadonlyArray<{ ticker: string; observation: UsSourceObservation }>
  /** Interrupted runs record evidence but never promote. */
  allowPromotion?: boolean
}

export type UsSourceAvailabilityPlan = {
  rows: UsSourceAvailabilityRecord[]
  newlyEligible: string[]
  newlyPermanent: string[]
  revertedFromPermanent: string[]
  promotionGuard: UsPromotionGuard
  promotionGuardTriggered: boolean
  counts: Record<UsSourceAvailabilityStatus, number> & {
    pendingEmpty: number
    pendingTargetMissing: number
    temporaryNotFound: number
    temporaryTransient: number
  }
}

export function planUsSourceAvailabilityRun(input: UsSourceAvailabilityPlanInput): UsSourceAvailabilityPlan {
  const transitions = input.observations.map(({ ticker, observation }) => ({
    ticker,
    ...applyUsSourceObservation(input.existing.get(ticker) ?? null, observation, {
      market: input.market,
      source: input.source,
      ticker,
      runId: input.runId,
      targetDate: input.targetDate,
      updatedAt: input.updatedAt,
    }),
  }))
  const newlyEligible = transitions.filter((t) => t.eligibleForPermanent).map((t) => t.ticker).sort()
  const promotionGuard = evaluateUsPermanentPromotionGuard(newlyEligible.length, input.activeUniverse, input.limits)
  const promote = (input.allowPromotion ?? true) && !promotionGuard.triggered
  const newlyPermanent: string[] = []
  const rows = transitions.map((t) => {
    if (!t.eligibleForPermanent) return t.next
    if (promote) {
      newlyPermanent.push(t.ticker)
      return { ...t.next, status: 'PERMANENTLY_UNAVAILABLE' as const, statusReason: 'PROVIDER_NOT_FOUND_CONFIRMED' as const }
    }
    // Keep the evidence without promotion. Only an actual blast-radius guard gets
    // the guard reason; interrupted runs retain the provider observation reason.
    return {
      ...t.next,
      statusReason: promotionGuard.triggered
        ? 'PROMOTION_GUARD_HELD' as const
        : t.next.statusReason,
    }
  })
  const counts: UsSourceAvailabilityPlan['counts'] = {
    AVAILABLE: 0,
    PENDING: 0,
    TEMPORARILY_UNAVAILABLE: 0,
    PERMANENTLY_UNAVAILABLE: 0,
    pendingEmpty: 0,
    pendingTargetMissing: 0,
    temporaryNotFound: 0,
    temporaryTransient: 0,
  }
  for (const row of rows) {
    counts[row.status] += 1
    if (row.status === 'PENDING' && row.statusReason === 'EMPTY_RESPONSE') counts.pendingEmpty += 1
    if (row.status === 'PENDING' && row.statusReason === 'TARGET_DATE_MISSING') counts.pendingTargetMissing += 1
    if (row.status === 'TEMPORARILY_UNAVAILABLE' && row.lastObservationType === 'NOT_FOUND') counts.temporaryNotFound += 1
    if (row.status === 'TEMPORARILY_UNAVAILABLE' && row.lastObservationType === 'TRANSIENT') counts.temporaryTransient += 1
  }
  return {
    rows,
    newlyEligible,
    newlyPermanent: newlyPermanent.sort(),
    revertedFromPermanent: transitions.filter((t) => t.revertedFromPermanent).map((t) => t.ticker).sort(),
    promotionGuard,
    promotionGuardTriggered: promotionGuard.triggered,
    counts,
  }
}

// ─────────────────────────────────────
// Run accounting
// ─────────────────────────────────────

export type UsOhlcvTickerOutcome = {
  observation: UsSourceObservation
  /** Ticker belongs to the current active investable universe. */
  inScope: boolean
}

export type UsOhlcvProcessedAccounting = {
  targets: number
  processed: number
  dataResponses: number
  emptyResponses: number
  notRequested: number
  providerNotFound: number
  transientFailed: number
  deferred: number
  /** Target-date coverage for in-scope tickers; any usable data for out-of-scope tickers. Never includes empties. */
  succeeded: number
}

export function coversTargetDate(observation: UsSourceObservation, targetDate: string): boolean {
  if (observation.kind !== 'DATA' && observation.kind !== 'STORED') return false
  return observation.latestDataDate != null && observation.latestDataDate >= targetDate
}

export function summarizeUsOhlcvOutcomes(
  targets: number,
  outcomes: Iterable<UsOhlcvTickerOutcome>,
  targetDate: string,
): UsOhlcvProcessedAccounting {
  const acc: UsOhlcvProcessedAccounting = {
    targets: Math.max(0, targets),
    processed: 0,
    dataResponses: 0,
    emptyResponses: 0,
    notRequested: 0,
    providerNotFound: 0,
    transientFailed: 0,
    deferred: 0,
    succeeded: 0,
  }
  for (const { observation, inScope } of outcomes) {
    acc.processed += 1
    if (observation.kind === 'DATA') acc.dataResponses += 1
    else if (observation.kind === 'STORED') acc.notRequested += 1
    else if (observation.kind === 'EMPTY') acc.emptyResponses += 1
    else if (observation.kind === 'NOT_FOUND') acc.providerNotFound += 1
    else acc.transientFailed += 1
    if (
      (observation.kind === 'DATA' || observation.kind === 'STORED')
      && (!inScope || coversTargetDate(observation, targetDate))
    ) {
      acc.succeeded += 1
    }
  }
  acc.deferred = Math.max(0, acc.targets - acc.processed)
  return acc
}

export type UsOhlcvRunStatusInput = {
  succeeded: number
  failed: number
  deferred: number
  pendingEmpty: number
  pendingTargetMissing: number
  temporaryNotFound: number
  promotionGuardTriggered: boolean
}

/**
 * success only when every non-permanent target is complete. Confirmed permanent exclusions
 * may coexist with success; empties, missing target dates, transient failures, deferred work,
 * temporary NOT_FOUND classifications and a triggered promotion guard all keep the run partial.
 */
export function usOhlcvRunStatus(input: UsOhlcvRunStatusInput): 'success' | 'partial' | 'failed' {
  const complete = input.failed === 0
    && input.deferred === 0
    && input.pendingEmpty === 0
    && input.pendingTargetMissing === 0
    && input.temporaryNotFound === 0
    && !input.promotionGuardTriggered
  if (complete) return 'success'
  if (input.failed > 0 && input.succeeded === 0 && input.deferred === 0) return 'failed'
  return 'partial'
}

// ─────────────────────────────────────
// Coverage SLA
// ─────────────────────────────────────

export type UsDailyCoverageSla = {
  date: string | null
  rawUniverse: number
  covered: number
  /** covered / rawUniverse (0-100). */
  rawPercent: number | null
  permanentExcluded: number
  effectiveUniverse: number
  /** covered / (rawUniverse - permanentExcluded) (0-100). */
  effectivePercent: number | null
  missing: number
  pending: number
  temporary: number
  unclassifiedMissing: number
  /** False when the availability table could not be read; buckets then fall back to unclassified. */
  classificationAvailable: boolean
}

export type UsDailyCoverageCounts = {
  rawUniverse: unknown
  covered: unknown
  permanentExcluded?: unknown
  pending?: unknown
  temporary?: unknown
}

function safeCount(value: unknown): number {
  const parsed = Math.floor(Number(value ?? 0))
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0
}

export function summarizeUsDailyCoverageSla(
  date: string | null,
  counts: UsDailyCoverageCounts,
  classificationAvailable = true,
): UsDailyCoverageSla {
  const rawUniverse = safeCount(counts.rawUniverse)
  const covered = Math.min(rawUniverse, safeCount(counts.covered))
  const missing = rawUniverse - covered
  const permanentExcluded = classificationAvailable ? Math.min(missing, safeCount(counts.permanentExcluded)) : 0
  const pending = classificationAvailable ? Math.min(missing - permanentExcluded, safeCount(counts.pending)) : 0
  const temporary = classificationAvailable
    ? Math.min(missing - permanentExcluded - pending, safeCount(counts.temporary))
    : 0
  const effectiveUniverse = rawUniverse - permanentExcluded
  return {
    date,
    rawUniverse,
    covered,
    rawPercent: date && rawUniverse > 0 ? 100 * covered / rawUniverse : null,
    permanentExcluded,
    effectiveUniverse,
    effectivePercent: date && effectiveUniverse > 0 ? 100 * covered / effectiveUniverse : null,
    missing,
    pending,
    temporary,
    unclassifiedMissing: missing - permanentExcluded - pending - temporary,
    classificationAvailable,
  }
}

export function formatUsDailyCoverageSla(sla: UsDailyCoverageSla): string {
  const pct = (value: number | null) => (value == null ? '-' : `${value.toFixed(2)}%`)
  return `raw=${sla.covered}/${sla.rawUniverse} (${pct(sla.rawPercent)}), `
    + `effective=${sla.covered}/${sla.effectiveUniverse} (${pct(sla.effectivePercent)}), `
    + `permanentExcluded=${sla.permanentExcluded}, pending=${sla.pending}, temporary=${sla.temporary}, `
    + `unclassifiedMissing=${sla.unclassifiedMissing}`
}
