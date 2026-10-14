// W0G: US daily EOD coverage SLA and reversible provider-unavailable classification.
// Pure contract/source assertions plus an isolated temporary-SQLite integration check.

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  applyUsSourceObservation,
  evaluateUsPermanentPromotionGuard,
  isProviderTickerNotFoundError,
  planUsSourceAvailabilityRun,
  resolveUsPermanentPromotionLimits,
  summarizeUsDailyCoverageSla,
  summarizeUsOhlcvOutcomes,
  usOhlcvRunStatus,
  US_PERMANENT_PROMOTION_MAX_SYMBOLS_DEFAULT,
  US_PERMANENT_PROMOTION_MAX_SYMBOLS_ENV,
  US_PERMANENT_PROMOTION_MAX_UNIVERSE_PCT_DEFAULT,
  US_PERMANENT_PROMOTION_MAX_UNIVERSE_PCT_ENV,
  US_PERMANENT_UNAVAILABLE_MIN_EVIDENCE,
  US_SOURCE_TIINGO,
  type UsOhlcvTickerOutcome,
  type UsSourceAvailabilityRecord,
  type UsSourceObservation,
} from '@/lib/us-source-availability'

const D1 = '2026-10-08'
const D2 = '2026-10-09'
const D3 = '2026-10-12'
const D4 = '2026-10-13'
const NOT_FOUND: UsSourceObservation = { kind: 'NOT_FOUND', httpStatus: 404 }
const LIMITS = resolveUsPermanentPromotionLimits({})

function observe(
  prev: UsSourceAvailabilityRecord | null,
  observation: UsSourceObservation,
  runId: number,
  targetDate: string,
  ticker = 'GONE',
) {
  return applyUsSourceObservation(prev, observation, {
    market: 'US',
    source: US_SOURCE_TIINGO,
    ticker,
    runId,
    targetDate,
    updatedAt: 1_700_000_000 + runId,
  })
}

function runPlan(
  existing: Map<string, UsSourceAvailabilityRecord>,
  observations: Array<[string, UsSourceObservation]>,
  runId: number,
  targetDate: string,
  options: { activeUniverse?: number; allowPromotion?: boolean; limits?: typeof LIMITS } = {},
) {
  const plan = planUsSourceAvailabilityRun({
    market: 'US',
    source: US_SOURCE_TIINGO,
    runId,
    targetDate,
    activeUniverse: options.activeUniverse ?? 12_004,
    limits: options.limits ?? LIMITS,
    updatedAt: 1_700_000_000 + runId,
    existing,
    observations: observations.map(([ticker, observation]) => ({ ticker, observation })),
    allowPromotion: options.allowPromotion,
  })
  const next = new Map(existing)
  for (const row of plan.rows) next.set(row.ticker, row)
  return { plan, next }
}

/** Build a row with N valid distinct-date/distinct-run NOT_FOUND observations. */
function withEvidence(count: number, ticker = 'GONE'): UsSourceAvailabilityRecord {
  const dates = [D1, D2, D3, D4]
  let row: UsSourceAvailabilityRecord | null = null
  for (let i = 0; i < count; i += 1) row = observe(row, NOT_FOUND, 100 + i, dates[i], ticker).next
  assert.ok(row)
  return row
}

// ── Defaults are explicit and env-overridable ────────────────────────
assert.equal(US_PERMANENT_UNAVAILABLE_MIN_EVIDENCE, 3)
assert.equal(US_PERMANENT_PROMOTION_MAX_SYMBOLS_DEFAULT, 25)
assert.equal(US_PERMANENT_PROMOTION_MAX_UNIVERSE_PCT_DEFAULT, 0.25)
assert.deepEqual(LIMITS, { maxSymbols: 25, maxUniversePercent: 0.25 })
assert.deepEqual(
  resolveUsPermanentPromotionLimits({
    [US_PERMANENT_PROMOTION_MAX_SYMBOLS_ENV]: '5',
    [US_PERMANENT_PROMOTION_MAX_UNIVERSE_PCT_ENV]: '1.5',
  }),
  { maxSymbols: 5, maxUniversePercent: 1.5 },
)
assert.deepEqual(
  resolveUsPermanentPromotionLimits({
    [US_PERMANENT_PROMOTION_MAX_SYMBOLS_ENV]: 'abc',
    [US_PERMANENT_PROMOTION_MAX_UNIVERSE_PCT_ENV]: '-1',
  }),
  LIMITS,
  'invalid overrides fall back to the defaults',
)

// ── Only the exact Tiingo terminal ticker-not-found shape is terminal ─
assert.equal(isProviderTickerNotFoundError(new Error('Tiingo /tiingo/daily/GONE/prices failed: HTTP 404 {"detail":"Error: Ticker \'GONE\' not found"}')), true)
assert.equal(isProviderTickerNotFoundError(new Error('Tiingo /tiingo/daily/X/prices failed: HTTP 404 Not Found')), false)
assert.equal(isProviderTickerNotFoundError(new Error('Tiingo failed: HTTP 500 ticker X not found')), false)

// ── Three same-date 404s count once ──────────────────────────────────
{
  let row = observe(null, NOT_FOUND, 1, D1).next
  row = observe(row, NOT_FOUND, 2, D1).next
  row = observe(row, NOT_FOUND, 3, D1).next
  assert.equal(row.terminalEvidenceCount, 1)
  assert.equal(row.status, 'TEMPORARILY_UNAVAILABLE')
  assert.equal(row.statusReason, 'PROVIDER_NOT_FOUND')
  assert.equal(row.firstTerminalTargetDate, D1)
  assert.equal(row.lastTerminalRunId, 1)
}

// ── Same run never advances (even with a different target date) ──────
{
  let row = observe(null, NOT_FOUND, 7, D1).next
  row = observe(row, NOT_FOUND, 7, D2).next
  row = observe(row, NOT_FOUND, 7, D3).next
  assert.equal(row.terminalEvidenceCount, 1)
  // An older target date in a newer run does not advance either.
  row = observe(row, NOT_FOUND, 8, '2026-10-01').next
  assert.equal(row.terminalEvidenceCount, 1)
}

// ── Three distinct dates AND runs promote ────────────────────────────
{
  let state = new Map<string, UsSourceAvailabilityRecord>()
  let result = runPlan(state, [['GONE', NOT_FOUND]], 11, D1)
  assert.deepEqual(result.plan.newlyPermanent, [])
  assert.equal(result.plan.counts.temporaryNotFound, 1)
  state = result.next
  result = runPlan(state, [['GONE', NOT_FOUND]], 12, D2)
  assert.deepEqual(result.plan.newlyPermanent, [])
  state = result.next
  result = runPlan(state, [['GONE', NOT_FOUND]], 13, D3)
  assert.deepEqual(result.plan.newlyEligible, ['GONE'])
  assert.deepEqual(result.plan.newlyPermanent, ['GONE'])
  assert.equal(result.plan.promotionGuardTriggered, false)
  const row = result.next.get('GONE')!
  assert.equal(row.status, 'PERMANENTLY_UNAVAILABLE')
  assert.equal(row.statusReason, 'PROVIDER_NOT_FOUND_CONFIRMED')
  assert.equal(row.terminalEvidenceCount, 3)
  assert.equal(row.firstTerminalTargetDate, D1)
  assert.equal(row.lastTerminalTargetDate, D3)
  assert.equal(row.lastTerminalRunId, 13)

  // A further 404 keeps it permanent and is not "newly" permanent.
  const again = runPlan(result.next, [['GONE', NOT_FOUND]], 14, D4)
  assert.deepEqual(again.plan.newlyPermanent, [])
  assert.equal(again.next.get('GONE')!.status, 'PERMANENTLY_UNAVAILABLE')
  assert.equal(again.plan.counts.temporaryNotFound, 0)

  // Three runs on the same date never promote.
  let sameDate = new Map<string, UsSourceAvailabilityRecord>()
  for (const runId of [21, 22, 23]) sameDate = runPlan(sameDate, [['GONE', NOT_FOUND]], runId, D1).next
  assert.equal(sameDate.get('GONE')!.terminalEvidenceCount, 1)
  assert.equal(sameDate.get('GONE')!.status, 'TEMPORARILY_UNAVAILABLE')
}

// ── HTTP 200 empty resets evidence and is PENDING/EMPTY_RESPONSE ─────
{
  const prev = withEvidence(2)
  assert.equal(prev.terminalEvidenceCount, 2)
  const { next, revertedFromPermanent, eligibleForPermanent } = observe(prev, { kind: 'EMPTY' }, 200, D3)
  assert.equal(next.status, 'PENDING')
  assert.equal(next.statusReason, 'EMPTY_RESPONSE')
  assert.equal(next.terminalEvidenceCount, 0)
  assert.equal(next.firstTerminalTargetDate, null)
  assert.equal(next.lastTerminalRunId, null)
  assert.equal(next.lastHttpStatus, 200)
  assert.equal(revertedFromPermanent, false)
  assert.equal(eligibleForPermanent, false)
  // After the reset, the next 404 starts a fresh chain at 1.
  assert.equal(observe(next, NOT_FOUND, 201, D4).next.terminalEvidenceCount, 1)
  // An ambiguous empty response cannot overturn an already-confirmed classification.
  const fromPermanent = observe({ ...withEvidence(3), status: 'PERMANENTLY_UNAVAILABLE' }, { kind: 'EMPTY' }, 300, D4)
  assert.equal(fromPermanent.next.status, 'PERMANENTLY_UNAVAILABLE')
  assert.equal(fromPermanent.next.statusReason, 'PROVIDER_NOT_FOUND_CONFIRMED')
  assert.equal(fromPermanent.next.terminalEvidenceCount, 0)
  assert.equal(fromPermanent.revertedFromPermanent, false)
}

// ── Empty responses cannot produce success (12020/12020 regression) ──
{
  const outcomes: UsOhlcvTickerOutcome[] = []
  for (let i = 0; i < 11_760; i += 1) outcomes.push({ inScope: true, observation: { kind: 'DATA', latestDataDate: D4 } })
  for (let i = 0; i < 260; i += 1) outcomes.push({ inScope: true, observation: { kind: 'EMPTY' } })
  const acc = summarizeUsOhlcvOutcomes(12_020, outcomes, D4)
  assert.equal(acc.succeeded, 11_760, 'empty arrays must not increment succeeded')
  assert.equal(acc.emptyResponses, 260)
  assert.equal(acc.processed, 12_020)
  assert.equal(acc.deferred, 0)
  assert.equal(
    acc.dataResponses + acc.emptyResponses + acc.notRequested + acc.providerNotFound + acc.transientFailed + acc.deferred,
    acc.targets,
    'processed accounting is exhaustive',
  )
  assert.equal(usOhlcvRunStatus({
    succeeded: acc.succeeded,
    failed: acc.transientFailed,
    deferred: acc.deferred,
    pendingEmpty: acc.emptyResponses,
    pendingTargetMissing: 0,
    temporaryNotFound: 0,
    promotionGuardTriggered: false,
  }), 'partial')

  const allEmpty = summarizeUsOhlcvOutcomes(3, [
    { inScope: true, observation: { kind: 'EMPTY' } },
    { inScope: true, observation: { kind: 'EMPTY' } },
    { inScope: false, observation: { kind: 'EMPTY' } },
  ], D4)
  assert.equal(allEmpty.succeeded, 0)
  assert.notEqual(usOhlcvRunStatus({
    succeeded: allEmpty.succeeded,
    failed: 0,
    deferred: 0,
    pendingEmpty: allEmpty.emptyResponses,
    pendingTargetMissing: 0,
    temporaryNotFound: 0,
    promotionGuardTriggered: false,
  }), 'success')

  // Older-only data is not target-date coverage; up-to-date stored data is.
  const mixed = summarizeUsOhlcvOutcomes(4, [
    { inScope: true, observation: { kind: 'DATA', latestDataDate: D3 } },
    { inScope: true, observation: { kind: 'STORED', latestDataDate: D4 } },
    { inScope: true, observation: { kind: 'STORED', latestDataDate: null } },
  ], D4)
  assert.equal(mixed.succeeded, 1)
  assert.equal(mixed.notRequested, 2)
  assert.equal(mixed.deferred, 1)
}

// ── Non-empty responses: target present vs older-only ───────────────
{
  const prev = withEvidence(2)
  const present = observe(prev, { kind: 'DATA', latestDataDate: D4 }, 400, D4).next
  assert.equal(present.status, 'AVAILABLE')
  assert.equal(present.statusReason, 'TARGET_DATE_PRESENT')
  assert.equal(present.terminalEvidenceCount, 0)
  assert.equal(present.lastSuccessDataDate, D4)

  const older = observe(prev, { kind: 'DATA', latestDataDate: D2 }, 401, D4).next
  assert.equal(older.status, 'PENDING')
  assert.equal(older.statusReason, 'TARGET_DATE_MISSING')
  assert.equal(older.terminalEvidenceCount, 0)
  assert.equal(older.lastSuccessDataDate, D2)
  // last success date never moves backwards
  assert.equal(observe(present, { kind: 'DATA', latestDataDate: D1 }, 402, D4).next.lastSuccessDataDate, D4)
}

// ── Transient failures ───────────────────────────────────────────────
{
  const prev = withEvidence(2)
  const transient = observe(prev, { kind: 'TRANSIENT', httpStatus: 503 }, 500, D3).next
  assert.equal(transient.status, 'TEMPORARILY_UNAVAILABLE')
  assert.equal(transient.statusReason, 'TRANSIENT_FAILURE')
  assert.equal(transient.terminalEvidenceCount, 2, 'transient failures neither advance nor reset evidence')
  assert.equal(transient.lastHttpStatus, 503)
  // A later valid 404 continues the existing chain.
  assert.equal(observe(transient, NOT_FOUND, 501, D3).next.terminalEvidenceCount, 3)

  const permanent: UsSourceAvailabilityRecord = { ...withEvidence(3), status: 'PERMANENTLY_UNAVAILABLE', statusReason: 'PROVIDER_NOT_FOUND_CONFIRMED' }
  const kept = observe(permanent, { kind: 'TRANSIENT', httpStatus: null }, 502, D4)
  assert.equal(kept.next.status, 'PERMANENTLY_UNAVAILABLE', 'transient failures do not clear permanence')
  assert.equal(kept.next.terminalEvidenceCount, 3)
  assert.equal(kept.revertedFromPermanent, false)

  const { plan } = runPlan(new Map(), [['FLAKY', { kind: 'TRANSIENT', httpStatus: 502 }]], 503, D4)
  assert.equal(plan.counts.temporaryTransient, 1)
  assert.equal(plan.counts.temporaryNotFound, 0)
  assert.equal(usOhlcvRunStatus({
    succeeded: 10, failed: 1, deferred: 0, pendingEmpty: 0, pendingTargetMissing: 0, temporaryNotFound: 0, promotionGuardTriggered: false,
  }), 'partial')
  assert.equal(usOhlcvRunStatus({
    succeeded: 0, failed: 1, deferred: 0, pendingEmpty: 0, pendingTargetMissing: 0, temporaryNotFound: 0, promotionGuardTriggered: false,
  }), 'failed')
}

// ── Later non-empty reverses permanent ───────────────────────────────
{
  const permanent: UsSourceAvailabilityRecord = { ...withEvidence(3), status: 'PERMANENTLY_UNAVAILABLE', statusReason: 'PROVIDER_NOT_FOUND_CONFIRMED' }
  const existing = new Map([['BACK', { ...permanent, ticker: 'BACK' }], ['OLDBACK', { ...permanent, ticker: 'OLDBACK' }]])
  const { plan, next } = runPlan(existing, [
    ['BACK', { kind: 'DATA', latestDataDate: D4 }],
    ['OLDBACK', { kind: 'DATA', latestDataDate: D2 }],
  ], 600, D4)
  assert.deepEqual(plan.revertedFromPermanent, ['BACK', 'OLDBACK'])
  assert.equal(next.get('BACK')!.status, 'AVAILABLE')
  assert.equal(next.get('BACK')!.terminalEvidenceCount, 0)
  assert.equal(next.get('OLDBACK')!.status, 'PENDING')
  assert.equal(next.get('OLDBACK')!.statusReason, 'TARGET_DATE_MISSING')
  assert.equal(plan.counts.pendingTargetMissing, 1)

  // Stored data without a provider request keeps permanence when the target is still missing.
  const storedMissing = observe(permanent, { kind: 'STORED', latestDataDate: D1 }, 601, D4)
  assert.equal(storedMissing.next.status, 'PERMANENTLY_UNAVAILABLE')
  assert.equal(storedMissing.revertedFromPermanent, false)
}

// ── Mass-404 promotion guard ─────────────────────────────────────────
{
  const tickers = Array.from({ length: 26 }, (_, i) => `M${String(i).padStart(2, '0')}`)
  const existing = new Map<string, UsSourceAvailabilityRecord>(tickers.map((ticker) => [ticker, withEvidence(2, ticker)]))
  const alreadyPermanent: UsSourceAvailabilityRecord = {
    ...withEvidence(3, 'OLDPERM'),
    status: 'PERMANENTLY_UNAVAILABLE',
    statusReason: 'PROVIDER_NOT_FOUND_CONFIRMED',
  }
  existing.set('OLDPERM', alreadyPermanent)
  const { plan, next } = runPlan(existing, tickers.map((ticker) => [ticker, NOT_FOUND]), 700, D3)
  assert.equal(plan.newlyEligible.length, 26)
  assert.equal(plan.promotionGuardTriggered, true)
  assert.deepEqual(plan.newlyPermanent, [])
  for (const ticker of tickers) {
    const row = next.get(ticker)!
    assert.equal(row.status, 'TEMPORARILY_UNAVAILABLE')
    assert.equal(row.statusReason, 'PROMOTION_GUARD_HELD')
    assert.equal(row.terminalEvidenceCount, 3, 'guard keeps the evidence count intact')
  }
  assert.equal(next.get('OLDPERM'), alreadyPermanent, 'existing permanent rows remain unchanged')
  assert.equal(plan.counts.temporaryNotFound, 26)
  assert.equal(usOhlcvRunStatus({
    succeeded: 11_000, failed: 0, deferred: 0, pendingEmpty: 0, pendingTargetMissing: 0, temporaryNotFound: 0, promotionGuardTriggered: true,
  }), 'partial')

  // Exactly 25 at a 12,004 universe (cap 30.01) promotes.
  const ok = runPlan(
    new Map(tickers.slice(0, 25).map((ticker) => [ticker, withEvidence(2, ticker)])),
    tickers.slice(0, 25).map((ticker) => [ticker, NOT_FOUND]),
    701,
    D3,
  )
  assert.equal(ok.plan.promotionGuardTriggered, false)
  assert.equal(ok.plan.newlyPermanent.length, 25)

  // The 0.25% universe limit binds independently: 1,000 tickers → 2.5 symbols.
  assert.equal(evaluateUsPermanentPromotionGuard(2, 1_000, LIMITS).triggered, false)
  assert.equal(evaluateUsPermanentPromotionGuard(3, 1_000, LIMITS).triggered, true)
  assert.equal(evaluateUsPermanentPromotionGuard(1, 0, LIMITS).triggered, true, 'an empty universe never promotes')
  assert.equal(evaluateUsPermanentPromotionGuard(0, 0, LIMITS).triggered, false)

  // Env override raises the cap.
  const raised = runPlan(existing, tickers.map((ticker) => [ticker, NOT_FOUND]), 702, D3, {
    limits: resolveUsPermanentPromotionLimits({ [US_PERMANENT_PROMOTION_MAX_SYMBOLS_ENV]: '30' }),
  })
  assert.equal(raised.plan.promotionGuardTriggered, false)
  assert.equal(raised.plan.newlyPermanent.length, 26)

  // Interrupted runs record evidence but never promote.
  const interrupted = runPlan(new Map([['GONE', withEvidence(2)]]), [['GONE', NOT_FOUND]], 703, D3, { allowPromotion: false })
  assert.deepEqual(interrupted.plan.newlyPermanent, [])
  assert.equal(interrupted.next.get('GONE')!.terminalEvidenceCount, 3)
  assert.equal(interrupted.next.get('GONE')!.status, 'TEMPORARILY_UNAVAILABLE')
  assert.equal(interrupted.next.get('GONE')!.statusReason, 'PROVIDER_NOT_FOUND')
}

// ── Confirmed permanent exclusions may coexist with success ──────────
assert.equal(usOhlcvRunStatus({
  succeeded: 11_900, failed: 0, deferred: 0, pendingEmpty: 0, pendingTargetMissing: 0, temporaryNotFound: 0, promotionGuardTriggered: false,
}), 'success')
for (const blocker of ['deferred', 'pendingEmpty', 'pendingTargetMissing', 'temporaryNotFound'] as const) {
  assert.equal(usOhlcvRunStatus({
    succeeded: 11_900, failed: 0, deferred: 0, pendingEmpty: 0, pendingTargetMissing: 0, temporaryNotFound: 0, promotionGuardTriggered: false,
    [blocker]: 1,
  }), 'partial', `${blocker} must block success`)
}

// ── Raw / effective coverage formulas ────────────────────────────────
{
  const sla = summarizeUsDailyCoverageSla(D4, {
    rawUniverse: 12_004,
    covered: 11_760,
    permanentExcluded: 100,
    pending: 90,
    temporary: 30,
  })
  assert.equal(sla.rawUniverse, 12_004)
  assert.equal(sla.covered, 11_760)
  assert.equal(sla.rawPercent, 100 * 11_760 / 12_004)
  assert.equal(sla.rawPercent?.toFixed(2), '97.97')
  assert.equal(sla.permanentExcluded, 100)
  assert.equal(sla.effectiveUniverse, 11_904)
  assert.equal(sla.effectivePercent, 100 * 11_760 / 11_904)
  assert.equal(sla.missing, 244)
  assert.equal(sla.pending, 90)
  assert.equal(sla.temporary, 30)
  assert.equal(sla.unclassifiedMissing, 24)
  assert.equal(sla.permanentExcluded + sla.pending + sla.temporary + sla.unclassifiedMissing, sla.missing)

  // Clamping: buckets never exceed the missing set, covered never exceeds the universe.
  const clamped = summarizeUsDailyCoverageSla(D4, {
    rawUniverse: 10, covered: 12, permanentExcluded: 5, pending: -3, temporary: Number.NaN,
  })
  assert.equal(clamped.covered, 10)
  assert.equal(clamped.permanentExcluded, 0)
  assert.equal(clamped.effectivePercent, 100)
  const overBuckets = summarizeUsDailyCoverageSla(D4, {
    rawUniverse: 10, covered: 6, permanentExcluded: 3, pending: 5, temporary: 5,
  })
  assert.equal(overBuckets.permanentExcluded, 3)
  assert.equal(overBuckets.pending, 1)
  assert.equal(overBuckets.temporary, 0)
  assert.equal(overBuckets.unclassifiedMissing, 0)
  assert.ok(overBuckets.effectivePercent! <= 100)

  // Everything permanent and nothing covered fails closed (null → treated as 0 by the orchestrator).
  const allGone = summarizeUsDailyCoverageSla(D4, { rawUniverse: 5, covered: 0, permanentExcluded: 5 })
  assert.equal(allGone.effectiveUniverse, 0)
  assert.equal(allGone.effectivePercent, null)
  assert.equal(summarizeUsDailyCoverageSla(null, { rawUniverse: 5, covered: 5 }).rawPercent, null)

  // Unreadable classification: raw only, every gap unclassified.
  const fallback = summarizeUsDailyCoverageSla(D4, { rawUniverse: 100, covered: 90, permanentExcluded: 9 }, false)
  assert.equal(fallback.permanentExcluded, 0)
  assert.equal(fallback.effectivePercent, fallback.rawPercent)
  assert.equal(fallback.unclassifiedMissing, 10)
  assert.equal(fallback.classificationAvailable, false)
}

// ── Source contracts ─────────────────────────────────────────────────
const read = (file: string) => fs.readFileSync(path.join(process.cwd(), file), 'utf8')

const ingestion = read('scripts/batch-us-ohlcv.ts')
assert.match(ingestion, /isProviderTickerNotFoundError/)
assert.doesNotMatch(ingestion, /function isProviderUnavailableTicker/, 'one shared 404 classifier')
assert.doesNotMatch(ingestion, /succeeded \+= 1/, 'succeeded is derived from classified outcomes')
assert.match(ingestion, /if \(rows\.length === 0\) return \{ requested: true, rows: 0, latestDate: null \}/)
assert.match(ingestion, /return \{ kind: 'EMPTY' \}/)
assert.match(ingestion, /planUsSourceAvailabilityRun\(/)
assert.match(ingestion, /resolveUsPermanentPromotionLimits\(\)/)
assert.match(ingestion, /usOhlcvRunStatus\(\{/)
assert.match(ingestion, /availabilityPlan = await persistAvailability\(false\)/, 'interrupted runs never promote')
assert.match(ingestion, /availabilityPlan = await persistAvailability\(true\)/)
assert.match(ingestion, /loadUsDailyCoverageSla\(SLA_TARGET_DATE\)/)
for (const field of ['pendingEmpty', 'providerNotFound', 'newlyPermanent', 'revertedFromPermanent', 'promotionGuardTriggered', 'coverageSla', 'processed']) {
  assert.match(ingestion, new RegExp(`\\b${field}[,:]`), `run telemetry exposes ${field}`)
}
assert.doesNotMatch(ingestion, /PERMANENTLY_UNAVAILABLE/, 'permanent tickers are still requested this wave')
assert.match(ingestion, /adjOpen: row\.adjustedOpen/)
assert.match(ingestion, /AND \(\? = 1 OR u\.active = 1\)/)

const store = read('lib/server/us-source-availability-store.ts')
assert.match(store, /o\.ticker IS NULL AND a\.status = 'PERMANENTLY_UNAVAILABLE'/)
assert.match(store, /a\.status = 'PENDING' AND a\.last_observed_target_date = \?/)
assert.match(store, /a\.status = 'TEMPORARILY_UNAVAILABLE' AND a\.last_observed_target_date = \?/)
assert.match(store, /usInvestableSymbolSql\('u\.ticker'\)/)
assert.match(store, /u\.active = 1/)
assert.match(store, /ON CONFLICT\(market, ticker, source\) DO UPDATE SET/)

const migrate = read('lib/db/migrate.ts')
assert.match(migrate, /CREATE TABLE IF NOT EXISTS market_source_availability \([\s\S]*?PRIMARY KEY \(market, ticker, source\)\s*\)/)
assert.match(read('lib/db/schema.ts'), /sqliteTable\(\s*'market_source_availability'/)

const updater = read('scripts/update-us-latest.ts')
assert.match(updater, /loadUsDailyCoverageSla\(date\)/)
assert.match(updater, /coveragePct: sla\.effectivePercent \?\? 0/, 'gates use effective coverage and fail closed')
assert.match(updater, /formatUsDailyCoverageSla\(coverage\)/, 'logs show raw and effective coverage')
assert.match(updater, /coverage\.coveragePct < minimumCoveragePct/)
assert.match(updater, /coverageBeforeFetch\.coveragePct < retryCoveragePct/)
assert.match(updater, /numberEnv\('US_DAILY_MIN_PRICE_COVERAGE_PCT', 95\)/)

const status = read('lib/us-status.ts')
assert.match(status, /ohlcv: summarizeUsCoverage\(latestDate\?\.date \?\? null, ohlcvCoverage\?\.eligible, ohlcvCoverage\?\.covered\)/)
assert.match(status, /ohlcvSla\?: UsDailyCoverageSla/)
assert.match(status, /loadUsDailyCoverageSla\(latestDate\.date\)\.catch\(\(\) => null\)/)

const packageData = JSON.parse(read('package.json')) as { scripts?: Record<string, string> }
assert.equal(packageData.scripts?.['test:us-daily-coverage-sla'], 'tsx scripts/test-us-daily-coverage-sla.ts')

async function fixtureDatabaseTest() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'stockboard-us-coverage-sla-'))
  const dbPath = path.join(tmp, 'fixture.db')
  process.env.USE_LOCAL_DB = '1'
  process.env.LOCAL_DB_PATH = dbPath
  delete process.env.STOCKBOARD_DB_PATH
  delete process.env.TURSO_DATABASE_URL
  delete process.env.TURSO_AUTH_TOKEN
  try {
    const [{ client, ensureReady, execBatch, execGet }, store] = await Promise.all([
      import('@/lib/db/client'),
      import('@/lib/server/us-source-availability-store'),
    ])
    await ensureReady()
    const table = await execGet<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'market_source_availability'",
    )
    assert.equal(table?.name, 'market_source_availability', 'fixture migration creates the availability table')
    await execBatch([
      {
        sql: `INSERT INTO market_universe (market, ticker, active, source)
              VALUES ('US', 'COVERED', 1, 'fixture'), ('US', 'PERM', 1, 'fixture'),
                     ('US', 'PENDING', 1, 'fixture'), ('US', 'TEMP', 1, 'fixture')`,
      },
      {
        sql: `INSERT INTO market_ohlcv_daily
              (market, ticker, date, open, high, low, close, volume, source)
              VALUES ('US', 'COVERED', ?, 1, 1, 1, 1, 1, 'fixture')`,
        args: [D4],
      },
    ])
    const base = withEvidence(3)
    await store.upsertUsSourceAvailability([
      { ...base, ticker: 'PERM', status: 'PERMANENTLY_UNAVAILABLE', statusReason: 'PROVIDER_NOT_FOUND_CONFIRMED' },
      {
        ...base,
        ticker: 'PENDING',
        status: 'PENDING',
        statusReason: 'EMPTY_RESPONSE',
        terminalEvidenceCount: 0,
        firstTerminalTargetDate: null,
        lastTerminalTargetDate: null,
        lastTerminalRunId: null,
        lastObservationType: 'EMPTY',
        lastObservedTargetDate: D4,
        lastHttpStatus: 200,
      },
      {
        ...base,
        ticker: 'TEMP',
        status: 'TEMPORARILY_UNAVAILABLE',
        statusReason: 'TRANSIENT_FAILURE',
        terminalEvidenceCount: 0,
        firstTerminalTargetDate: null,
        lastTerminalTargetDate: null,
        lastTerminalRunId: null,
        lastObservationType: 'TRANSIENT',
        lastObservedTargetDate: D4,
        lastHttpStatus: 503,
      },
    ])
    const loaded = await store.loadUsSourceAvailability()
    assert.equal(loaded.get('PERM')?.status, 'PERMANENTLY_UNAVAILABLE')
    const sla = await store.loadUsDailyCoverageSla(D4)
    assert.deepEqual(sla, {
      date: D4,
      rawUniverse: 4,
      covered: 1,
      rawPercent: 25,
      permanentExcluded: 1,
      effectiveUniverse: 3,
      effectivePercent: 100 / 3,
      missing: 3,
      pending: 1,
      temporary: 1,
      unclassifiedMissing: 0,
      classificationAvailable: true,
    })
    client.close()
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
}

fixtureDatabaseTest().then(() => {
  console.log('US daily coverage SLA tests passed')
}).catch((error) => {
  console.error(error)
  process.exit(1)
})
