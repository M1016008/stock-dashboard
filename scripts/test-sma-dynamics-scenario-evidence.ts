// SMA Dynamics Lab Phase 3B: scenario evidence contract, fail-closed validation,
// claim/origin semantics, adapter parity with projectSmaPath, fixture coverage, UI copy
// and structure. Synthetic fixtures, static render and source checks only.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { findSmaDynamicsFixture } from '@/lib/sma-dynamics-fixtures'
import { computeSmaLab, projectSmaPath, SMA_LAB_PERIODS, type SmaLabAvailable } from '@/lib/sma-dynamics-lab'
import {
  checkGoal,
  convertScenarioUnit,
  evaluateScenario,
  forwardBase,
  freshSimulationState,
  goalFromDraft,
  NO_CONSTRAINTS,
  priceDomain,
  scenarioFromCloses,
  setScenarioInput,
  type ScenarioDraft,
  type ScenarioEvaluation,
} from '@/lib/sma-dynamics-scenario'
import { scenarioResultLead } from '@/components/stock/sma-dynamics/SmaConclusions'
import type { SmaLabTimeframeId } from '@/lib/sma-dynamics-timeframes'
import {
  adaptScenarioToSma,
  describeQuantitativeClaim,
  evaluateScenarioCandidates,
  HANDOFF_NOT_SOLVER_NOTE,
  handoffCheckLabel,
  handoffComparisonLabel,
  handoffScopeText,
  handoffSolverLead,
  isStandardScenarioEntry,
  isViewAlignable,
  ORIGIN_ALLOWED_CLAIMS,
  parseScenarioEvidence,
  presentedScenario,
  QUANTITATIVE_CLAIM_KINDS,
  resolveHandoffPath,
  resolveScenarioPresentation,
  SCENARIO_CLEAR_LABEL,
  SCENARIO_DIRECTION_LABEL,
  SCENARIO_DRAFT_KEPT_NOTE,
  SCENARIO_NOT_PROBABILITY,
  SCENARIO_ORIGIN_COPY,
  SCENARIO_ORIGIN_KINDS,
  SCENARIO_TEMPLATE_LIST_NOTE,
  SCENARIO_TEMPLATE_NOTE,
  SCENARIO_TEMPLATES,
  scenarioDirectionCounts,
  scenarioSelectionHeadline,
  scenarioValidationContext,
  showsUserDraftEditor,
  SOLVER_REPRESENTATIVE_PATH_LABEL,
  validateScenarioEvidence,
  type HandoffPathState,
  type ScenarioEvidenceCandidate,
  type ScenarioEvidenceEnvelope,
  type ScenarioEvidenceIssueCode,
  type ScenarioEvidenceValidation,
  type ScenarioHandoffRecord,
  type ScenarioPresentationState,
  type ScenarioSelectionCause,
  type ScenarioValidationContext,
} from '@/lib/sma-dynamics-scenario-evidence'
import {
  buildScenarioFixtureSets,
  classificationOnlyEnvelope,
  fixtureFutureSessions,
  SMA_SCENARIO_FIXTURE_BASIS,
  SMA_SCENARIO_FIXTURE_CALENDAR_VERSION,
  SMA_SCENARIO_TEMPLATE_HORIZON,
  scenarioFixtureSet,
  templateEnvelope,
} from '@/lib/sma-dynamics-scenario-fixtures'
import { SMA_DYNAMICS_DEFAULT_SETTINGS, SMA_LAB_OVERLAY_LABEL, SmaDynamicsView, type SmaDynamicsLoadState } from '@/components/stock/sma-dynamics/SmaDynamicsView'
import {
  directionCountText,
  SCENARIO_ANALYSIS_KICKER,
  SCENARIO_ANALYSIS_NAME_LABEL,
  ScenarioAnalysisHeader,
  scenarioAnalysisAnnouncement,
  scenarioAnalysisTitle,
  ScenarioAssumedCloses,
  ScenarioEvidenceDetails,
  ScenarioEvidencePicker,
  ScenarioEvidenceStatus,
  ScenarioHandoffNote,
  ScenarioOriginBadge,
  ScenarioSelectionUnavailable,
  SMA_SCENARIO_EVIDENCE_TITLE,
  SolverHandoffCallout,
} from '@/components/stock/sma-dynamics/SmaScenarioEvidence'
import { priceFormatter } from '@/components/stock/sma-dynamics/SmaDynamicsPanels'

const read = (path: string) => readFileSync(path, 'utf8')
const stripComments = (source: string) => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
const clone = <T,>(value: T): T => structuredClone(value)

function lab(priceFixtureId: string, timeframe: SmaLabTimeframeId, horizon: number): SmaLabAvailable {
  const fixture = findSmaDynamicsFixture(priceFixtureId)!
  const result = computeSmaLab({ rows: fixture.rows, market: fixture.market, timeframe, horizon, analysisDate: fixture.analysisDate })
  assert.equal(result.status, 'available', `${priceFixtureId} ${timeframe}`)
  return result as SmaLabAvailable
}
function context(priceFixtureId: string, timeframe: SmaLabTimeframeId = '1D', horizon = SMA_SCENARIO_TEMPLATE_HORIZON): ScenarioValidationContext {
  const fixture = findSmaDynamicsFixture(priceFixtureId)!
  return scenarioValidationContext(
    lab(priceFixtureId, timeframe, horizon),
    { market: fixture.market, ticker: fixture.ticker, permanentId: { status: 'unavailable', reason: '合成Fixtureには恒久IDがありません' } },
    SMA_SCENARIO_FIXTURE_BASIS,
    SMA_SCENARIO_FIXTURE_CALENDAR_VERSION,
  )
}
const codes = (validation: ScenarioEvidenceValidation): ScenarioEvidenceIssueCode[] => (validation.status === 'rejected' ? validation.issues.map((issue) => issue.code) : [])
function rejectedWith(validation: ScenarioEvidenceValidation, code: ScenarioEvidenceIssueCode, label: string) {
  assert.equal(validation.status, 'rejected', `${label}: rejected`)
  assert.ok(codes(validation).includes(code), `${label}: ${code} in ${codes(validation).join(',')}`)
}

const JP_CTX = context('jp-rising')
const US_CTX = context('us-falling')

// ---------------------------------------------------------------------------
// 1. Contract: eight origins, four claim kinds, every origin has copy and a claim policy.
{
  assert.deepEqual([...SCENARIO_ORIGIN_KINDS].sort(), ['deterministic_template', 'explanatory_synthetic', 'historical_analog', 'inverse_solver_result', 'model_classification', 'model_path_distribution', 'price_freeze', 'user_input'])
  assert.deepEqual([...QUANTITATIVE_CLAIM_KINDS].sort(), ['calibrated_class_probability', 'cluster_weight', 'normalized_template_weight', 'raw_model_score'])
  for (const kind of SCENARIO_ORIGIN_KINDS) {
    assert.ok(SCENARIO_ORIGIN_COPY[kind].label && SCENARIO_ORIGIN_COPY[kind].tag && SCENARIO_ORIGIN_COPY[kind].premise, `${kind}: copy`)
    assert.ok(Array.isArray(ORIGIN_ALLOWED_CLAIMS[kind]), `${kind}: claim policy`)
  }
  assert.deepEqual(ORIGIN_ALLOWED_CLAIMS.deterministic_template, ['normalized_template_weight'], 'a template carries only its normalized weight')
  for (const kind of ['user_input', 'price_freeze', 'inverse_solver_result', 'explanatory_synthetic'] as const) assert.deepEqual(ORIGIN_ALLOWED_CLAIMS[kind], [], `${kind}: no quantitative claim`)
  // Required copy rules (audit E2).
  assert.equal(SCENARIO_ORIGIN_COPY.deterministic_template.premise, 'この価格経路を仮定した場合')
  assert.equal(SCENARIO_ORIGIN_COPY.model_classification.premise, '方向スコアのみ。将来価格の経路は未提供')
  assert.equal(SCENARIO_ORIGIN_COPY.historical_analog.premise, '類似状態の集計に基づく軌跡')
  assert.equal(SCENARIO_ORIGIN_COPY.user_input.premise, 'ユーザーが設定した仮定')
  assert.equal(SCENARIO_ORIGIN_COPY.inverse_solver_result.premise, '条件を満たす代表経路')
  for (const kind of SCENARIO_ORIGIN_KINDS) assert.doesNotMatch(Object.values(SCENARIO_ORIGIN_COPY[kind]).join(' '), /予測|予想|確率|信頼度|forecast|predict/i, `${kind}: no forecast/probability wording`)
}

// ---------------------------------------------------------------------------
// 2. All eight templates, JP and US: projectable, direction-consistent, exact SMA parity.
{
  assert.equal(SCENARIO_TEMPLATES.length, 8)
  assert.deepEqual(
    { up: SCENARIO_TEMPLATES.filter((t) => t.direction === 'up').length, down: SCENARIO_TEMPLATES.filter((t) => t.direction === 'down').length, range: SCENARIO_TEMPLATES.filter((t) => t.direction === 'range').length },
    { up: 3, down: 3, range: 2 },
  )
  for (const [priceFixtureId, ctx] of [['jp-rising', JP_CTX], ['us-falling', US_CTX]] as const) {
    const result = lab(priceFixtureId, '1D', SMA_SCENARIO_TEMPLATE_HORIZON)
    const base = forwardBase(result)
    let weightSum = 0
    for (const template of SCENARIO_TEMPLATES) {
      const envelope = templateEnvelope(priceFixtureId, template.id)
      const validation = validateScenarioEvidence(envelope, ctx)
      assert.equal(validation.status, 'projectable', `${priceFixtureId} ${template.id}: ${codes(validation).join(',')}`)
      if (validation.status !== 'projectable') continue
      assert.equal(validation.envelope.direction.status === 'available' && validation.envelope.direction.value, template.direction)
      assert.equal(validation.envelope.quantitativeClaim.status === 'available' && validation.envelope.quantitativeClaim.value.kind, 'normalized_template_weight')
      if (validation.envelope.quantitativeClaim.status === 'available' && validation.envelope.quantitativeClaim.value.kind === 'normalized_template_weight') weightSum += validation.envelope.quantitativeClaim.value.valuePct
      const projection = adaptScenarioToSma(validation, base)
      assert.ok(projection, `${template.id}: adapted`)
      assert.deepEqual(projection!.closes, envelope.futureClosePath.status === 'available' ? envelope.futureClosePath.value.map((p) => p.close) : [], 'closes unchanged by the adapter')
      for (const period of SMA_LAB_PERIODS) {
        assert.deepEqual(projection!.sma[period], projectSmaPath(base.confirmedCloses, projection!.closes, period), `${priceFixtureId} ${template.id} SMA${period}: exact parity with projectSmaPath`)
      }
      // The same closes through the user editor path produce identical SMAs (hand-off is lossless).
      const handed = evaluateScenario(base, scenarioFromCloses(base, projection!.closes, 'price'))
      assert.deepEqual(handed.closes, projection!.closes, `${template.id}: hand-off keeps exact closes`)
      assert.deepEqual(handed.sma, projection!.sma, `${template.id}: hand-off keeps SMAs`)
      assert.equal(projection!.evaluation.state, 'complete')
      // Shape sanity: the final close is on the template's side of the reference.
      const end = projection!.closes.at(-1)! / ctx.referenceClose - 1
      if (template.direction === 'up') assert.ok(end > 0, `${template.id} ends above`)
      if (template.direction === 'down') assert.ok(end < 0, `${template.id} ends below`)
      if (template.direction === 'range') assert.ok(Math.abs(end) < 0.01, `${template.id} ends near`)
    }
    assert.equal(weightSum, 100, `${priceFixtureId}: normalized template weights sum to 100`)
  }
  assert.equal(JP_CTX.market, 'JP')
  assert.equal(US_CTX.market, 'US')
  assert.equal(JP_CTX.calendarId, 'sma-lab:JP')
  assert.equal(US_CTX.calendarId, 'sma-lab:US')
  // US 2026-11-26 (Thanksgiving) is never a path date.
  const usTemplate = templateEnvelope('us-falling', 'range')
  assert.ok(usTemplate.futureClosePath.status === 'available' && !usTemplate.futureClosePath.value.some((p) => p.dateOrPeriod === '2026-11-26'))
  // JP 2026-11-03 (文化の日) is never a path date.
  const jpTemplate = templateEnvelope('jp-rising', 'range')
  assert.ok(jpTemplate.futureClosePath.status === 'available' && !jpTemplate.futureClosePath.value.some((p) => p.dateOrPeriod === '2026-11-03'))
}

// ---------------------------------------------------------------------------
// 3. Classification-only never yields a path; a classification with a path is rejected.
{
  const jp = validateScenarioEvidence(classificationOnlyEnvelope('jp-rising', 'up', 0.62), JP_CTX)
  assert.equal(jp.status, 'no_path')
  assert.equal(jp.status === 'no_path' && jp.reason, 'classification_only')
  assert.equal(adaptScenarioToSma(jp, forwardBase(lab('jp-rising', '1D', 10))), null, 'no SMA projection from a classification')
  const us = validateScenarioEvidence(classificationOnlyEnvelope('us-falling', 'down', 0.41), US_CTX)
  assert.equal(us.status, 'no_path')

  const withPath = clone(classificationOnlyEnvelope('jp-rising', 'up', 0.62)) as ScenarioEvidenceEnvelope
  withPath.futureClosePath = templateEnvelope('jp-rising', 'continuation').futureClosePath
  rejectedWith(validateScenarioEvidence(withPath, JP_CTX), 'classification_with_path', 'classification + path')

  // Non-classification origin without a path: no path either, but a distinct reason.
  const noPath = clone(templateEnvelope('jp-rising', 'continuation')) as ScenarioEvidenceEnvelope
  noPath.futureClosePath = { status: 'unavailable', reason: 'test' }
  const v = validateScenarioEvidence(noPath, JP_CTX)
  assert.equal(v.status === 'no_path' && v.reason, 'path_unavailable')
}

// ---------------------------------------------------------------------------
// 4. Claim / origin semantics: a weight is never a probability, mismatched claims are rejected.
{
  const weight = describeQuantitativeClaim({ kind: 'normalized_template_weight', valuePct: 18 })
  assert.equal(weight.label, '相対ウェイト')
  assert.ok(weight.meaning.includes(SCENARIO_NOT_PROBABILITY))
  assert.doesNotMatch(weight.label + weight.value, /確率|的中|信頼/)
  const cluster = describeQuantitativeClaim({ kind: 'cluster_weight', valuePct: 22 })
  assert.ok(cluster.meaning.includes(SCENARIO_NOT_PROBABILITY))
  assert.match(describeQuantitativeClaim({ kind: 'raw_model_score', value: 0.62 }).meaning, /確率に校正されていない/)
  const calibrated = describeQuantitativeClaim({ kind: 'calibrated_class_probability', valuePct: 41, calibrationVersion: 'cal-v1' })
  assert.match(calibrated.meaning, /cal-v1/)
  assert.match(calibrated.meaning, /価格経路やSMAの確率ではありません/)

  const templateWithScore = clone(templateEnvelope('jp-rising', 'continuation')) as ScenarioEvidenceEnvelope
  templateWithScore.quantitativeClaim = { status: 'available', value: { kind: 'calibrated_class_probability', valuePct: 40, calibrationVersion: 'x' } }
  rejectedWith(validateScenarioEvidence(templateWithScore, JP_CTX), 'claim_not_allowed', 'template + probability')

  const classificationWithWeight = clone(classificationOnlyEnvelope('jp-rising', 'up', 0.5)) as ScenarioEvidenceEnvelope
  classificationWithWeight.quantitativeClaim = { status: 'available', value: { kind: 'normalized_template_weight', valuePct: 30 } }
  rejectedWith(validateScenarioEvidence(classificationWithWeight, JP_CTX), 'claim_not_allowed', 'classification + template weight')

  const userWithClaim = clone(templateEnvelope('jp-rising', 'continuation')) as ScenarioEvidenceEnvelope
  userWithClaim.origin = { kind: 'user_input' }
  userWithClaim.quantitativeClaim = { status: 'available', value: { kind: 'cluster_weight', valuePct: 10 } }
  rejectedWith(validateScenarioEvidence(userWithClaim, JP_CTX), 'claim_not_allowed', 'user input + claim')

  const outOfRange = clone(templateEnvelope('jp-rising', 'continuation')) as ScenarioEvidenceEnvelope
  outOfRange.quantitativeClaim = { status: 'available', value: { kind: 'normalized_template_weight', valuePct: 120 } }
  rejectedWith(validateScenarioEvidence(outOfRange, JP_CTX), 'claim_out_of_range', 'weight > 100')

  const uncalibrated = clone(classificationOnlyEnvelope('jp-rising', 'up', 0.5)) as ScenarioEvidenceEnvelope
  uncalibrated.quantitativeClaim = { status: 'available', value: { kind: 'calibrated_class_probability', valuePct: 40, calibrationVersion: ' ' } }
  rejectedWith(validateScenarioEvidence(uncalibrated, JP_CTX), 'provenance_missing', 'probability without calibration version')

  const calibratedOk = clone(classificationOnlyEnvelope('jp-rising', 'up', 0.5)) as ScenarioEvidenceEnvelope
  calibratedOk.quantitativeClaim = { status: 'available', value: { kind: 'calibrated_class_probability', valuePct: 40, calibrationVersion: 'cal-v1' } }
  assert.equal(validateScenarioEvidence(calibratedOk, JP_CTX).status, 'no_path', 'a calibrated classification still has no path')

  // Other path-capable origins.
  const base = templateEnvelope('jp-rising', 'continuation')
  for (const origin of [
    { kind: 'model_path_distribution', modelVersion: 'synthetic-traj-v0' },
    { kind: 'explanatory_synthetic', ruleVersion: 'demo-v1' },
    { kind: 'user_input' },
    { kind: 'inverse_solver_result', solverVersion: 'phase2-solver' },
  ] as const) {
    const envelope = { ...clone(base), origin, quantitativeClaim: { status: 'unavailable', reason: 'none' } } as ScenarioEvidenceEnvelope
    assert.equal(validateScenarioEvidence(envelope, JP_CTX).status, 'projectable', `${origin.kind}: projectable with an explicit path`)
  }
  const freeze = { ...clone(base), origin: { kind: 'price_freeze' }, quantitativeClaim: { status: 'unavailable', reason: 'none' } } as ScenarioEvidenceEnvelope
  rejectedWith(validateScenarioEvidence(freeze, JP_CTX), 'path_freeze_mismatch', 'price freeze with a moving path')
  if (freeze.futureClosePath.status === 'available') {
    freeze.futureClosePath = { status: 'available', value: freeze.futureClosePath.value.map((p) => ({ ...p, close: JP_CTX.referenceClose })) }
  }
  assert.equal(validateScenarioEvidence(freeze, JP_CTX).status, 'projectable', 'price freeze path = reference close')

  const unknownTemplate = clone(base) as ScenarioEvidenceEnvelope
  unknownTemplate.origin = { kind: 'deterministic_template', templateId: 'moonshot' as never, ruleVersion: 'v1' }
  rejectedWith(validateScenarioEvidence(unknownTemplate, JP_CTX), 'template_unknown', 'unknown template')
  const wrongDirection = clone(base) as ScenarioEvidenceEnvelope
  wrongDirection.direction = { status: 'available', value: 'down' }
  rejectedWith(validateScenarioEvidence(wrongDirection, JP_CTX), 'direction_mismatch', 'template direction')
  const noVersion = clone(base) as ScenarioEvidenceEnvelope
  noVersion.origin = { kind: 'deterministic_template', templateId: 'continuation', ruleVersion: '' }
  rejectedWith(validateScenarioEvidence(noVersion, JP_CTX), 'provenance_missing', 'missing rule version')
}

// ---------------------------------------------------------------------------
// 5. Fixture failure suite and context mismatches fail closed.
{
  const set = scenarioFixtureSet('jp-rising')!
  const byId = (id: string) => set.candidates.find((candidate) => candidate.id === id)!.envelope
  rejectedWith(validateScenarioEvidence(byId('jp-mismatch-market'), JP_CTX), 'market_mismatch', 'market')
  rejectedWith(validateScenarioEvidence(byId('jp-mismatch-ticker'), JP_CTX), 'ticker_mismatch', 'ticker')
  rejectedWith(validateScenarioEvidence(byId('jp-mismatch-asof'), JP_CTX), 'as_of_mismatch', 'as-of')
  rejectedWith(validateScenarioEvidence(byId('jp-mismatch-basis'), JP_CTX), 'price_basis_mismatch', 'basis')
  rejectedWith(validateScenarioEvidence(byId('jp-mismatch-horizon'), JP_CTX), 'path_length', 'horizon vs path length')
  rejectedWith(validateScenarioEvidence(byId('jp-invalid-path'), JP_CTX), 'path_close_invalid', 'invalid close')
  rejectedWith(validateScenarioEvidence(byId('jp-long-horizon'), JP_CTX), 'horizon_unsupported', '90 bars on 1D')
  for (const id of ['jp-mismatch-market', 'jp-mismatch-ticker', 'jp-mismatch-asof', 'jp-mismatch-basis', 'jp-mismatch-horizon', 'jp-invalid-path', 'jp-long-horizon']) {
    const validation = validateScenarioEvidence(byId(id), JP_CTX)
    assert.equal(isViewAlignable(validation), false, `${id}: not fixable by a view change`)
    assert.equal(adaptScenarioToSma(validation, forwardBase(lab('jp-rising', '1D', 10))), null, `${id}: no projection`)
  }
  // Same templates against the other market's history are rejected (identity, as-of, reference, calendar).
  const crossed = validateScenarioEvidence(templateEnvelope('jp-rising', 'continuation'), US_CTX)
  for (const code of ['market_mismatch', 'ticker_mismatch', 'as_of_mismatch', 'reference_price_mismatch', 'calendar_mismatch'] as const) rejectedWith(crossed, code, `JP envelope on US history: ${code}`)

  // Timeframe: a weekly-native path is never converted; it is drawable only on 1W.
  const weekly = byId('jp-weekly-native')
  const onDaily = validateScenarioEvidence(weekly, context('jp-rising', '1D', 5))
  assert.deepEqual(codes(onDaily), ['timeframe_mismatch'], 'weekly path on daily bars: timeframe mismatch only')
  assert.equal(isViewAlignable(onDaily), true, 'resolvable only by explicitly switching the view to 1W')
  const onWeekly = validateScenarioEvidence(weekly, context('jp-rising', '1W', 5))
  assert.equal(onWeekly.status, 'projectable', `weekly path on weekly bars: ${codes(onWeekly).join(',')}`)
  const weeklyBase = forwardBase(lab('jp-rising', '1W', 5))
  const weeklyProjection = adaptScenarioToSma(onWeekly, weeklyBase)!
  for (const period of SMA_LAB_PERIODS) assert.deepEqual(weeklyProjection.sma[period], projectSmaPath(weeklyBase.confirmedCloses, weeklyProjection.closes, period), `1W SMA${period} parity`)
  // A daily path labelled weekly fails on bar dates.
  const relabelled = { ...clone(templateEnvelope('jp-rising', 'continuation', { horizon: 5 })), forecastTimeframe: '1W' } as ScenarioEvidenceEnvelope
  rejectedWith(validateScenarioEvidence(relabelled, context('jp-rising', '1W', 5)), 'path_date_mismatch', 'daily dates on weekly bars')

  // Horizon on screen differs from the scenario: rejected, fixable only by an explicit view change.
  const shorter = validateScenarioEvidence(templateEnvelope('jp-rising', 'continuation'), context('jp-rising', '1D', 5))
  assert.deepEqual(codes(shorter), ['horizon_mismatch'])
  assert.equal(isViewAlignable(shorter), true)
  assert.equal(adaptScenarioToSma(validateScenarioEvidence(templateEnvelope('jp-rising', 'continuation'), JP_CTX), forwardBase(lab('jp-rising', '1D', 5))), null, 'adapter refuses a base with other bars')

  const base = templateEnvelope('jp-rising', 'continuation')
  rejectedWith(validateScenarioEvidence(base, { ...JP_CTX, priceBasis: { kind: 'unknown', reason: 'not declared' } }), 'price_basis_unknown', 'unknown history basis')
  rejectedWith(validateScenarioEvidence({ ...clone(base), priceBasis: { kind: 'unknown', reason: 'x' } }, JP_CTX), 'price_basis_unknown', 'unknown envelope basis')
  rejectedWith(validateScenarioEvidence({ ...clone(base), priceBasis: { kind: 'split_adjusted', adjustmentRevision: 'other' } }, JP_CTX), 'price_basis_mismatch', 'other adjustment revision')
  rejectedWith(validateScenarioEvidence({ ...clone(base), calendar: { id: 'sma-lab:US', version: 'v' } }, JP_CTX), 'calendar_mismatch', 'calendar id')
  rejectedWith(validateScenarioEvidence({ ...clone(base), calendar: { ...base.calendar, version: 'stale-calendar-version' } }, JP_CTX), 'calendar_version_mismatch', 'calendar version')
  rejectedWith(validateScenarioEvidence({
    ...clone(base),
    identity: { ...base.identity, permanentId: { status: 'available', value: 'different-security' } },
  }, JP_CTX), 'permanent_identity_mismatch', 'permanent identity')
  rejectedWith(validateScenarioEvidence({ ...clone(base), predictionReferencePrice: base.predictionReferencePrice + 0.1 }, JP_CTX), 'reference_price_mismatch', 'reference close')
  rejectedWith(validateScenarioEvidence({ ...clone(base), historicalOhlc: { ...base.historicalOhlc, completeness: 'partial' } }, JP_CTX), 'history_incomplete', 'partial history')
  rejectedWith(validateScenarioEvidence({ ...clone(base), historicalOhlc: { ...base.historicalOhlc, availableThrough: '2026-10-20' } }, JP_CTX), 'history_through_mismatch', 'history after as-of')
  rejectedWith(validateScenarioEvidence({ ...clone(base), dataCompleteness: 'partial' }, JP_CTX), 'data_incomplete', 'partial data')
  rejectedWith(validateScenarioEvidence({ ...clone(base), futurePriceRange: { status: 'available', value: { low: 10, high: 5, asOfBar: 3 } } }, JP_CTX), 'range_invalid', 'inverted range')
  const shifted = clone(base) as ScenarioEvidenceEnvelope
  if (shifted.futureClosePath.status === 'available') shifted.futureClosePath = { status: 'available', value: shifted.futureClosePath.value.map((p, i) => ({ ...p, dateOrPeriod: fixtureFutureSessions('JP', '2026-10-19', '1D', 10)[i] })) }
  rejectedWith(validateScenarioEvidence(shifted, JP_CTX), 'path_date_mismatch', 'path dates shifted one session')
  const gap = clone(base) as ScenarioEvidenceEnvelope
  if (gap.futureClosePath.status === 'available') gap.futureClosePath = { status: 'available', value: gap.futureClosePath.value.map((p, i) => ({ ...p, bar: i === 3 ? 9 : p.bar })) }
  rejectedWith(validateScenarioEvidence(gap, JP_CTX), 'path_bar_sequence', 'bar numbers')
  const nan = clone(base) as ScenarioEvidenceEnvelope
  if (nan.futureClosePath.status === 'available') nan.futureClosePath = { status: 'available', value: nan.futureClosePath.value.map((p, i) => ({ ...p, close: i === 0 ? Number.NaN : p.close })) }
  rejectedWith(validateScenarioEvidence(nan, JP_CTX), 'path_close_invalid', 'NaN close')

  // Malformed input never throws and never projects.
  for (const [input, label] of [
    [null, 'null'], [42, 'number'], [{}, 'empty object'],
    [{ ...clone(base), schemaVersion: 'phase3b-v0' }, 'schema'],
    [{ ...clone(base), origin: { kind: 'oracle' } }, 'unknown origin'],
    [{ ...clone(base), quantitativeClaim: { status: 'available', value: { kind: 'probability', valuePct: 50 } } }, 'generic probability claim'],
    [{ ...clone(base), futureClosePath: { status: 'available', value: [{ bar: 1, dateOrPeriod: '2026-10-19', close: '100' }] } }, 'string close'],
    [{ ...clone(base), forecastTimeframe: '4H' }, 'unknown timeframe'],
    [{ ...clone(base), identity: { market: 'EU', symbol: 'X', permanentId: { status: 'unavailable', reason: '' } } }, 'unknown market'],
  ] as const) {
    const validation = validateScenarioEvidence(input, JP_CTX)
    assert.equal(validation.status, 'rejected', `${label}: rejected`)
    assert.equal(validation.status === 'rejected' && validation.envelope, null, `${label}: no envelope surfaces`)
  }
  assert.equal(parseScenarioEvidence(base).ok, true)
}

// ---------------------------------------------------------------------------
// 6. Fixture coverage and list-level evaluation (as the View does it).
{
  const sets = buildScenarioFixtureSets()
  assert.deepEqual(sets.map((set) => set.market).sort(), ['JP', 'US'])
  for (const set of sets) {
    const templateIds = set.candidates.flatMap((candidate) => {
      const parsed = parseScenarioEvidence(candidate.envelope)
      return parsed.ok && parsed.envelope.origin.kind === 'deterministic_template' && parsed.envelope.forecastTimeframe === '1D' && candidate.id.includes('-template-') ? [parsed.envelope.origin.templateId] : []
    })
    assert.deepEqual([...templateIds].sort(), SCENARIO_TEMPLATES.map((t) => t.id).sort(), `${set.market}: all eight templates`)
    const origins = new Set(set.candidates.map((candidate) => parseScenarioEvidence(candidate.envelope)).flatMap((parsed) => (parsed.ok ? [parsed.envelope.origin.kind] : [])))
    for (const kind of ['deterministic_template', 'historical_analog', 'model_classification'] as const) assert.ok(origins.has(kind), `${set.market}: ${kind}`)
  }
  assert.equal(JSON.stringify(buildScenarioFixtureSets()), JSON.stringify(sets), 'fixtures are deterministic')

  // At the default 5-bar view the 10-bar templates are still listed as drawable (their horizon is applied on selection).
  const set = scenarioFixtureSet('jp-rising')!
  const current = context('jp-rising', '1D', 5)
  const entries = evaluateScenarioCandidates(set.candidates, (horizon) => (horizon === 10 ? JP_CTX : current))
  const status = (id: string) => entries.find((entry) => entry.candidate.id === id)!.validation.status
  for (const template of SCENARIO_TEMPLATES) assert.equal(status(`jp-template-${template.id}`), 'projectable', template.id)
  assert.equal(status('jp-analog'), 'projectable')
  assert.equal(status('jp-classification'), 'no_path')
  assert.equal(entries.filter((entry) => entry.direction === 'up' && entry.candidate.id.startsWith('jp-template-')).length, 3)
  assert.equal(entries.filter((entry) => entry.direction === 'range').length, 2)
}

// ---------------------------------------------------------------------------
// 7. UI: copy, structure, origin distinction without colour, defaults unchanged.
const BANNED = /予測|予想|確率|勝率|信頼度|的中率|forecast|predict|probabilit|confidence|\bML\b|機械学習|買い|売り|推奨/i
const visibleText = (markup: string) => markup.replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&')
const fmt = priceFormatter(1)
{
  const set = scenarioFixtureSet('jp-rising')!
  const fixture = findSmaDynamicsFixture('jp-rising')!
  const load: SmaDynamicsLoadState = { status: 'ready', rows: fixture.rows }
  const props = { security: { market: 'JP' as const, ticker: 'FXJ1', name: '合成 上昇基調' }, analysisDate: null, load, dataSource: { label: 'テスト', priceBasis: '合成データ' }, initialSettings: SMA_DYNAMICS_DEFAULT_SETTINGS }

  const plain = renderToStaticMarkup(createElement(SmaDynamicsView, props))
  assert.doesNotMatch(plain, /data-sma-scenario-evidence|data-scenario-/, 'no external input: lab renders exactly as before')

  const scenarioInput = {
    candidates: set.candidates,
    historyBasis: set.historyBasis,
    securityPermanentId: { status: 'unavailable' as const, reason: '合成Fixtureには恒久IDがありません' },
    calendarVersion: SMA_SCENARIO_FIXTURE_CALENDAR_VERSION,
  }
  const markup = renderToStaticMarkup(createElement(SmaDynamicsView, { ...props, externalScenarios: scenarioInput }))
  assert.match(markup, /data-sma-scenario-evidence="true"/)
  assert.ok(markup.includes(SMA_SCENARIO_EVIDENCE_TITLE))
  assert.equal(SMA_SCENARIO_EVIDENCE_TITLE, 'この株価の動きを仮定すると、移動平均線はどうなる？')
  for (const direction of ['up', 'range', 'down']) assert.match(markup, new RegExp(`data-scenario-direction="${direction}"`))
  assert.match(markup, /aria-pressed="true"[^>]*data-scenario-direction="up"/, 'up selected first')
  assert.match(markup, /data-scenario-candidate="jp-template-continuation"[^>]*data-scenario-status="projectable"/)
  assert.match(markup, /data-scenario-candidate="jp-classification"[^>]*data-scenario-status="no_path"/)
  assert.match(markup, /<details[^>]*data-scenario-developer="true"/, 'failing scenarios are collapsed in the developer panel, not mixed in')
  assert.doesNotMatch(markup, /data-scenario-blocked/, 'every normal template is drawable, so no blocked group')
  assert.match(markup, /data-scenario-candidate="jp-weekly-native"[^>]*data-scenario-status="alignable"/)
  assert.ok(markup.includes('経路なし (方向スコアのみ)'))
  assert.match(markup, /data-sma-dynamics-controls/, 'existing controls still rendered')
  assert.match(markup, /data-sma-conclusion-mode="freeze"/, 'nothing selected: Price Freeze default unchanged')
  const pickerText = visibleText(markup.slice(markup.indexOf('data-sma-scenario-evidence'), markup.indexOf('data-sma-dynamics-controls')))
  assert.doesNotMatch(pickerText.replace(/方向スコアのみ/g, ''), BANNED, 'picker copy neutral')

  const loading = renderToStaticMarkup(createElement(SmaDynamicsView, { ...props, load: { status: 'loading' }, externalScenarios: scenarioInput }))
  assert.match(loading, /data-scenario-waiting/, 'no validation before history exists')

  const unknownBasis = renderToStaticMarkup(createElement(SmaDynamicsView, { ...props, externalScenarios: { ...scenarioInput, historyBasis: { kind: 'unknown', reason: 'test' } } }))
  assert.doesNotMatch(unknownBasis, /data-scenario-status="projectable"/, 'unknown history basis: nothing drawable')

  // Picker on the US set.
  const usSet = scenarioFixtureSet('us-falling')!
  const usEntries = evaluateScenarioCandidates(usSet.candidates, () => US_CTX)
  const usPicker = renderToStaticMarkup(createElement(ScenarioEvidencePicker, { entries: usEntries, direction: 'down', selectedId: 'us-template-breakdown', disabled: false, barNoun: '日足', onDirection: () => {}, onSelect: () => {} }))
  assert.match(usPicker, /aria-pressed="true"[^>]*data-scenario-candidate="us-template-breakdown"/)
  assert.ok(usPicker.includes('日足10本'))
  assert.equal((usPicker.match(/data-scenario-candidate="us-template-/g) ?? []).length, 3, 'three down templates')

  // Badges: text + icon + border pattern per family.
  for (const kind of SCENARIO_ORIGIN_KINDS) {
    const badge = renderToStaticMarkup(createElement(ScenarioOriginBadge, { origin: { kind } }))
    assert.ok(badge.includes(SCENARIO_ORIGIN_COPY[kind].tag), `${kind}: text tag`)
    assert.match(badge, /<svg/, `${kind}: icon`)
    assert.match(badge, /border-(dashed|dotted|double|solid)/, `${kind}: border pattern`)
    assert.ok(badge.includes('由来: '), `${kind}: screen-reader label`)
  }
  const families = new Set(SCENARIO_ORIGIN_KINDS.map((kind) => renderToStaticMarkup(createElement(ScenarioOriginBadge, { origin: { kind } })).match(/border-(dashed|dotted|double|solid)/)![1]))
  assert.equal(families.size, 4, 'rule / data / model / user are distinguishable without colour')

  // Selected template: premise, note, hand-off (header) and closes (collapsed table); no forecast/probability wording.
  const envelope = templateEnvelope('jp-rising', 'continuation')
  const closes = envelope.futureClosePath.status === 'available' ? envelope.futureClosePath.value.map((p) => p.close) : []
  const header = renderToStaticMarkup(createElement(ScenarioAnalysisHeader, { titleId: 't', name: '上がり続ける仮定', envelope, barCount: closes.length, barNoun: '日足', fmt, freezeCompared: false, onEdit: () => {}, onSolve: () => {}, onToggleFreeze: () => {}, onClear: () => {} }))
  const table = renderToStaticMarkup(createElement(ScenarioAssumedCloses, { envelope, closes, fmt }))
  const selection = header + table
  assert.ok(header.includes('この価格経路を仮定した場合'))
  assert.ok(header.includes(SCENARIO_TEMPLATE_NOTE))
  assert.match(table, /data-scenario-closes/)
  assert.equal((table.match(/>T\+\d+</g) ?? []).length, 10, 'ten assumed closes listed')
  assert.match(header, /data-scenario-handoff-target="scenario"/)
  assert.match(header, /data-scenario-handoff-target="solver"/)
  assert.ok(header.includes('この経路を編集する') && header.includes('この経路で逆算と比べる') && header.includes('選択を解除'))
  assert.doesNotMatch(visibleText(selection), BANNED, 'template selection: no forecast/probability/confidence wording')

  const details = renderToStaticMarkup(createElement(ScenarioEvidenceDetails, { envelope }))
  assert.match(details, /data-scenario-claim="normalized_template_weight"/)
  assert.ok(details.includes('相対ウェイト 18%'))
  assert.doesNotMatch(visibleText(details).replaceAll(SCENARIO_NOT_PROBABILITY, ''), BANNED, 'weight shown only with its disclaimer')
  for (const copy of ['分割調整済み', 'sma-lab:JP', '2026-10-16', '恒久ID なし', 'template-rules-synthetic-v1']) assert.ok(details.includes(copy), `details: ${copy}`)

  const noPath = renderToStaticMarkup(createElement(ScenarioEvidenceStatus, { entry: { candidate: { id: 'c', label: 'c', envelope: null }, direction: 'up', validation: validateScenarioEvidence(classificationOnlyEnvelope('jp-rising', 'up', 0.62), JP_CTX) }, onAlign: () => {} }))
  assert.ok(noPath.includes('方向スコアのみ。将来価格の経路は未提供'))
  assert.ok(noPath.includes('SMAは計算しません'))
  assert.ok(noPath.includes('確率に校正されていない'))
  const rejected = renderToStaticMarkup(createElement(ScenarioEvidenceStatus, { entry: { candidate: { id: 'c', label: 'c', envelope: null }, direction: 'up', validation: validateScenarioEvidence(scenarioFixtureSet('jp-rising')!.candidates.find((c) => c.id === 'jp-mismatch-basis')!.envelope, JP_CTX) }, onAlign: () => {} }))
  assert.match(rejected, /data-scenario-issue="price_basis_mismatch"/)
  const alignable = renderToStaticMarkup(createElement(ScenarioEvidenceStatus, { entry: { candidate: { id: 'c', label: 'c', envelope: null }, direction: 'up', validation: validateScenarioEvidence(scenarioFixtureSet('jp-rising')!.candidates.find((c) => c.id === 'jp-weekly-native')!.envelope, context('jp-rising', '1D', 5)) }, onAlign: () => {} }))
  assert.match(alignable, /data-scenario-align/)
  assert.ok(alignable.includes('経路は別の時間軸・本数に変換しない'))
  const noteRecord: ScenarioHandoffRecord = { candidateId: 'c', label: '上昇継続', sourceOrigin: 'deterministic_template', timeframe: '1D', horizon: 2, asOfDate: '2026-10-16', sourceCloses: [1, 2], inheritedCloses: [1, 2] }
  const note = renderToStaticMarkup(createElement(ScenarioHandoffNote, { record: noteRecord, path: { status: 'in_scope', currentOrigin: 'inherited', changedK: [] } }))
  assert.ok(note.includes('ユーザーが設定した仮定'))

  // Revision pass: a rejected envelope's disallowed claim is never rendered (no "probability" on a template).
  const probabilityOnTemplate = { ...envelope, quantitativeClaim: { status: 'available' as const, value: { kind: 'calibrated_class_probability' as const, valuePct: 64, calibrationVersion: 'cal-x' } } }
  assert.equal(validateScenarioEvidence(probabilityOnTemplate, JP_CTX).status, 'rejected')
  const withheld = renderToStaticMarkup(createElement(ScenarioEvidenceDetails, { envelope: probabilityOnTemplate }))
  assert.match(withheld, /data-scenario-claim-withheld/)
  assert.doesNotMatch(withheld, /data-scenario-claim=|64%|校正済み/, 'disallowed claim withheld')
  const outOfRange = renderToStaticMarkup(createElement(ScenarioEvidenceDetails, { envelope: { ...envelope, quantitativeClaim: { status: 'available', value: { kind: 'normalized_template_weight', valuePct: 140 } } } }))
  assert.match(outOfRange, /data-scenario-claim-withheld/)
  assert.doesNotMatch(outOfRange, /140%/)

  // Candidates without a readable direction stay visible (fail-closed), on every tab.
  const malformedEntries = evaluateScenarioCandidates([...set.candidates, { id: 'broken', label: '形式不正', envelope: { schemaVersion: 'phase3b-v1' } }], () => JP_CTX)
  for (const direction of ['up', 'range', 'down'] as const) {
    const picker = renderToStaticMarkup(createElement(ScenarioEvidencePicker, { entries: malformedEntries, direction, selectedId: null, disabled: false, barNoun: '日足', onDirection: () => {}, onSelect: () => {} }))
    assert.match(picker, /data-scenario-undirected/, `${direction}: undirected group shown`)
    assert.match(picker, /data-scenario-candidate="broken"[^>]*data-scenario-status="rejected"/)
  }
  assert.ok(usPicker.includes('仮定の終点 T+10 基準日比'), 'end change worded as part of the assumed path')
  assert.match(selection, /<th scope="col"[^>]*>T\+1</, 'bar labels are column headers')
}

// ---------------------------------------------------------------------------
// 8. Source guards: fixture-only mounting, no fetch/DB, no second SMA engine, live pages untouched.
{
  const lib = stripComments(read('lib/sma-dynamics-scenario-evidence.ts'))
  const fixtures = stripComments(read('lib/sma-dynamics-scenario-fixtures.ts'))
  const ui = stripComments(read('components/stock/sma-dynamics/SmaScenarioEvidence.tsx'))
  for (const [source, label] of [[lib, 'evidence lib'], [fixtures, 'scenario fixtures'], [ui, 'evidence UI']] as const) {
    assert.doesNotMatch(source, /fetch\(|\/api\/|@\/lib\/db|@\/lib\/queries|stock-scenarios|ma-trajectory|backtest/, `${label}: no fetch, DB, model or live scenario import`)
  }
  assert.doesNotMatch(lib, /smaAt|function projectSmaPath/, 'no second SMA engine')
  assert.match(lib, /projectAllSma\(base, closes\)/, 'adapter uses the existing projection')
  for (const file of ['components/stock/sma-dynamics/SmaDynamicsView.tsx', 'components/stock/sma-dynamics/SmaDynamicsSection.tsx', 'components/stock/sma-dynamics/SmaScenarioEvidence.tsx']) {
    assert.doesNotMatch(read(file), /sma-dynamics-scenario-fixtures|sma-dynamics-fixtures/, `${file}: fixtures never reach the shared UI`)
  }
  for (const file of ['app/stock/[ticker]/StockDetailClient.tsx', 'components/us/stock-detail/UsChartWorkspace.tsx', 'app/us/stock/[ticker]/UsStockDetailClient.tsx']) {
    assert.doesNotMatch(read(file), /externalScenarios|scenario-evidence|scenario-fixtures/, `${file}: no scenario evidence in live Stock Detail`)
  }
  const view = stripComments(read('components/stock/sma-dynamics/SmaDynamicsView.tsx'))
  assert.match(view, /resolveHandoffPath\(handoff, \{ timeframe: available\.timeframe, horizon: base\.horizon, asOfDate: available\.asOf\.date, closes: draftScenario\.closes \}\)/, 'hand-off scope and origin read from the bars and values on screen')
  assert.match(view, /const selectPurpose = [\s\S]{0,200}?if \(evidence\.selectedId != null\) setEvidence\(\{ selectedId: null \}\)/, 'any purpose change ends the preview selection')
  assert.match(view, /onDirection=\{\(direction\) => setEvidence\(\{ direction, selectedId: null \}\)\}/, 'direction changes end a now-hidden preview selection')
  const preview = read('app/dev/sma-dynamics/SmaDynamicsPreviewClient.tsx')
  assert.match(preview, /externalScenarios=\{externalScenarios\}/, 'mounted in the dev preview')
  assert.match(preview, /scenarioFixtureSet\(fixture\.id\)/)
}

// ---------------------------------------------------------------------------
// 9. Final UX polish: 3/2/3 normal picker, developer fixtures, Scenario Analysis state, hierarchy, a11y.
{
  const ASSUMPTION_BANNED = /支持|抵抗|反発|買い|売り|優勢|過熱|上放れ|\d+\s*%|確率|信頼度|勝率|的中/
  const scenarioInput = (priceFixtureId: string, initialSelectedId?: string) => {
    const set = scenarioFixtureSet(priceFixtureId)!
    return {
      candidates: set.candidates,
      historyBasis: set.historyBasis,
      securityPermanentId: { status: 'unavailable' as const, reason: '合成Fixtureには恒久IDがありません' },
      calendarVersion: SMA_SCENARIO_FIXTURE_CALENDAR_VERSION,
      ...(initialSelectedId ? { initialSelectedId } : {}),
    }
  }
  const viewProps = (priceFixtureId: string, overrides: Partial<typeof SMA_DYNAMICS_DEFAULT_SETTINGS> = {}) => {
    const fixture = findSmaDynamicsFixture(priceFixtureId)!
    return {
      security: { market: fixture.market, ticker: fixture.ticker, name: fixture.name },
      analysisDate: fixture.analysisDate,
      load: { status: 'ready', rows: fixture.rows } as SmaDynamicsLoadState,
      dataSource: { label: 'テスト', priceBasis: '合成データ' },
      initialSettings: { ...SMA_DYNAMICS_DEFAULT_SETTINGS, ...overrides },
    }
  }
  const render = (priceFixtureId: string, initialSelectedId?: string, overrides: Partial<typeof SMA_DYNAMICS_DEFAULT_SETTINGS> = {}) =>
    renderToStaticMarkup(createElement(SmaDynamicsView, { ...viewProps(priceFixtureId, overrides), externalScenarios: scenarioInput(priceFixtureId, initialSelectedId) }))
  const detailsOpen = (markup: string, attr: string) => {
    const tag = markup.match(new RegExp(`<details[^>]*${attr}="true"[^>]*>`))
    assert.ok(tag, `${attr}: rendered as <details>`)
    return /\sopen=""/.test(tag![0])
  }
  const at = (markup: string, needle: string) => {
    const index = markup.indexOf(needle)
    assert.ok(index >= 0, `present: ${needle}`)
    return index
  }

  // 9a. Template copy names the assumption; never support/resistance evidence, likelihood or a trade call.
  for (const template of SCENARIO_TEMPLATES) {
    assert.ok(template.assumption.endsWith('仮定'), `${template.id}: name states an assumption`)
    assert.doesNotMatch(template.assumption + template.shape, ASSUMPTION_BANNED, `${template.id}: no evidence/probability/trade wording`)
  }
  assert.equal(new Set(SCENARIO_TEMPLATES.map((t) => t.assumption)).size, 8, 'eight distinct assumption names')
  assert.match(SCENARIO_TEMPLATE_LIST_NOTE, /起こりやすさを表しません/)

  for (const [priceFixtureId, prefix, otherPrefix] of [['jp-rising', 'jp', 'us'], ['us-falling', 'us', 'jp']] as const) {
    const set = scenarioFixtureSet(priceFixtureId)!
    const ctx = priceFixtureId === 'jp-rising' ? JP_CTX : US_CTX
    const entries = evaluateScenarioCandidates(set.candidates, () => ctx)
    const standard = entries.filter(isStandardScenarioEntry)
    const developer = entries.filter((entry) => !isStandardScenarioEntry(entry))

    // 9b. Exactly the eight deterministic templates, 3 up / 2 range / 3 down; developer fixtures never counted.
    assert.deepEqual(standard.map((entry) => entry.candidate.id).sort(), SCENARIO_TEMPLATES.map((t) => `${prefix}-template-${t.id}`).sort(), `${prefix}: normal list = 8 templates`)
    assert.deepEqual(
      { up: standard.filter((e) => e.direction === 'up').length, range: standard.filter((e) => e.direction === 'range').length, down: standard.filter((e) => e.direction === 'down').length },
      { up: 3, range: 2, down: 3 },
      `${prefix}: 3/2/3`,
    )
    for (const entry of standard) assert.equal(entry.validation.status, 'projectable', `${entry.candidate.id}: drawable`)
    assert.ok(developer.length >= 2, `${prefix}: developer fixtures exist`)
    for (const entry of developer) assert.equal(entry.candidate.audience, 'developer', `${entry.candidate.id}: flagged developer`)
    for (const kind of ['historical_analog', 'model_classification'] as const) {
      assert.ok(developer.some((entry) => entry.validation.envelope?.origin.kind === kind), `${prefix}: ${kind} is developer-only`)
    }
    // A template-shaped envelope flagged developer (mismatch/weekly fixtures) never enters the normal list.
    assert.equal(isStandardScenarioEntry({ ...standard[0], candidate: { ...standard[0].candidate, audience: 'developer' } }), false)

    for (const direction of ['up', 'range', 'down'] as const) {
      const picker = renderToStaticMarkup(createElement(ScenarioEvidencePicker, { entries, direction, selectedId: null, disabled: false, barNoun: '日足', onDirection: () => {}, onSelect: () => {} }))
      const counts = Object.fromEntries([...picker.matchAll(/data-scenario-direction="(\w+)" data-scenario-direction-count="(\d+)"/g)].map((m) => [m[1], Number(m[2])]))
      assert.deepEqual(counts, { up: 3, range: 2, down: 3 }, `${prefix}/${direction}: tab counts 3/2/3`)
      for (const [id, n] of Object.entries({ up: 3, range: 2, down: 3 })) assert.match(picker, new RegExp(`aria-label="${SCENARIO_DIRECTION_LABEL[id as keyof typeof SCENARIO_DIRECTION_LABEL]}の仮定 ${n}件"`), `${id}: count in accessible name`)
      const normalList = picker.slice(at(picker, 'data-scenario-standard-list'), at(picker, 'data-scenario-list-note'))
      const normalIds = [...normalList.matchAll(/data-scenario-candidate="([^"]+)"/g)].map((m) => m[1])
      assert.equal(normalIds.length, direction === 'range' ? 2 : 3, `${prefix}/${direction}: normal list size`)
      assert.ok(normalIds.every((id) => id.startsWith(`${prefix}-template-`)), `${prefix}/${direction}: only templates in the normal list`)
      assert.equal((normalList.match(/data-scenario-shape/g) ?? []).length, normalIds.length, 'every normal option states its assumed shape')
      assert.doesNotMatch(visibleText(normalList), BANNED, `${prefix}/${direction}: normal list copy neutral`)
      // The only percentage allowed is the labelled end point of the assumed path.
      assert.doesNotMatch(visibleText(normalList).replace(/仮定の終点 T\+\d+ 基準日比 [+−-]?[\d.]+%/g, ''), ASSUMPTION_BANNED, `${prefix}/${direction}: no evidence wording in names`)
      // Developer panel: collapsed, clearly labelled, every developer fixture present and selectable.
      assert.equal(detailsOpen(picker, 'data-scenario-developer'), false, `${prefix}/${direction}: developer panel collapsed by default`)
      assert.ok(picker.includes('開発者向け: 検証用のシナリオ') && picker.includes('通常の一覧と件数には含めません'))
      const devPanel = picker.slice(at(picker, 'data-scenario-developer'))
      for (const entry of developer) {
        assert.match(devPanel, new RegExp(`<button type="button" aria-pressed="false" data-scenario-candidate="${entry.candidate.id}"`), `${entry.candidate.id}: selectable in the developer panel`)
      }
      assert.doesNotMatch(devPanel, new RegExp(`data-scenario-candidate="${prefix}-template-`), 'templates are not duplicated in the developer panel')
    }

    // Selecting a developer fixture opens its panel but leaves the normal counts alone.
    const devId = developer[0].candidate.id
    const pickedDev = renderToStaticMarkup(createElement(ScenarioEvidencePicker, { entries, direction: 'up', selectedId: devId, disabled: false, barNoun: '日足', onDirection: () => {}, onSelect: () => {} }))
    assert.equal(detailsOpen(pickedDev, 'data-scenario-developer'), true, 'developer panel open while its fixture is selected')
    assert.match(pickedDev, new RegExp(`aria-pressed="true" data-scenario-candidate="${devId}"`))
    assert.match(pickedDev, /data-scenario-direction="up" data-scenario-direction-count="3"/)

    // 9c. Scenario Analysis state through the real View (selection seeded, horizon as selection applies it).
    const templateId = prefix === 'jp' ? 'continuation' : 'breakdown'
    const template = SCENARIO_TEMPLATES.find((t) => t.id === templateId)!
    const active = render(priceFixtureId, `${prefix}-template-${templateId}`, { analysis: 'scenario', horizon: SMA_SCENARIO_TEMPLATE_HORIZON })
    assert.match(active, /data-scenario-analysis="deterministic_template"/, `${prefix}: Scenario Analysis state on`)
    assert.ok(active.includes(SCENARIO_ANALYSIS_KICKER))
    assert.ok(active.includes(scenarioAnalysisTitle(template.assumption)), 'dynamic title names the assumption')
    assert.match(active, new RegExp(`data-sma-dynamics-subtitle="true" data-mode="scenario" data-scenario-analysis-active="true">${scenarioAnalysisTitle(template.assumption)}<`), 'header subtitle switches to the analysis title')
    assert.match(active, new RegExp(`<dt[^>]*>${SCENARIO_ANALYSIS_NAME_LABEL}</dt><dd[^>]*data-scenario-analysis-name="true">${template.assumption}`), 'explicit 仮定したシナリオ name')
    assert.ok(active.includes(template.shape), 'assumed shape stated')
    assert.ok(active.includes(SCENARIO_TEMPLATE_NOTE), 'rule-not-model disclosure')
    assert.ok(active.includes('この価格経路を仮定した場合'))
    assert.match(active, new RegExp(`aria-live="polite" data-scenario-live="true">${scenarioAnalysisAnnouncement(template.assumption)}<`), 'state change announced')
    const analysisId = active.match(/<section aria-labelledby="([^"]+)"[^>]*data-scenario-analysis=/)![1]
    assert.match(active, new RegExp(`<h3 id="${analysisId}"[^>]*data-scenario-analysis-title`), 'analysis region labelled by its title')
    // Reversible actions: edit (free scenario), solver, Price Freeze compare toggle, clear.
    assert.match(active, /role="group" aria-label="このシナリオで続ける"/)
    for (const marker of ['data-scenario-handoff-target="scenario"', 'data-scenario-handoff-target="solver"', 'data-scenario-clear']) assert.ok(active.includes(marker), marker)
    assert.match(active, new RegExp(`aria-pressed="${SMA_DYNAMICS_DEFAULT_SETTINGS.compare.includes('freeze')}" data-scenario-compare-freeze`), 'Price Freeze compare is a toggle reflecting the compare setting')
    const noFreeze = render(priceFixtureId, `${prefix}-template-${templateId}`, { analysis: 'scenario', horizon: SMA_SCENARIO_TEMPLATE_HORIZON, compare: [] })
    assert.match(noFreeze, /aria-pressed="false" data-scenario-compare-freeze/)
    const analysisText = visibleText(active.slice(at(active, 'data-scenario-analysis='), at(active, 'data-scenario-live')))
    assert.doesNotMatch(analysisText, BANNED, `${prefix}: analysis header copy neutral`)

    // 9d. Hierarchy: analysis header → result (lead first) → full-width chart → collapsed controls
    // ("表示条件を変更") → collapsed closes table → collapsed provenance.
    assert.match(active, /data-sma-dynamics-layout="result-first"/)
    const order = [
      'data-scenario-analysis=',
      'data-sma-dynamics-result',
      'data-sma-conclusion-mode="scenario"',
      'data-scenario-result-lead',
      'data-sma-dynamics-chart',
      'data-sma-dynamics-controls-disclosure',
      'data-sma-dynamics-controls="true"',
      'data-scenario-closes-details',
      'data-sma-scenario-evidence-details',
    ].map((needle) => at(active, needle))
    assert.deepEqual([...order].sort((a, b) => a - b), order, `${prefix}: result-first order`)
    assert.equal((active.match(/data-sma-dynamics-controls="true"/g) ?? []).length, 1, 'controls rendered once')
    assert.equal(detailsOpen(active, 'data-sma-dynamics-controls-disclosure'), false, 'controls collapsed while analysing')
    const disclosure = active.slice(at(active, 'data-sma-dynamics-controls-disclosure'), at(active, 'data-scenario-closes-details'))
    assert.ok(disclosure.includes('表示条件を変更') && disclosure.includes('何を調べますか？'), 'every generic control kept inside the disclosure')
    for (const marker of ['data-sma-steps=', 'data-sma-dynamics-advanced', 'data-sma-dynamics-compare']) assert.ok(disclosure.includes(marker), `disclosure keeps ${marker}`)
    // Lead sits before the conclusion rows, inside the result.
    const conclusion = active.slice(at(active, 'data-sma-conclusion-mode="scenario"'))
    assert.ok(conclusion.indexOf('data-scenario-result-lead') < conclusion.indexOf('<dl'), 'lead before the conclusion rows')
    assert.match(active, /aria-label="シナリオ分析の結果"/)
    assert.match(active, new RegExp(`シナリオ分析の結果 <span[^>]*>「${template.assumption}」を仮定`))
    assert.match(active, /data-sma-conclusion-mode="scenario"/)
    assert.match(active, /data-scenario-conclusion-premise/)
    assert.equal(detailsOpen(active, 'data-scenario-closes-details'), false, 'assumed-close table collapsed')
    assert.equal(detailsOpen(active, 'data-sma-scenario-evidence-details'), false, 'provenance collapsed')
    assert.equal((active.match(/data-scenario-closes="true"/g) ?? []).length, 1, 'table rendered once (inside details)')
    assert.ok(active.indexOf('data-scenario-closes="true"') > at(active, 'data-scenario-closes-details'), 'table lives inside the collapsed block')
    assert.doesNotMatch(active, /data-sma-dynamics-mode-panel="scenario"/, 'user editor replaced while analysing (draft untouched)')
    assert.doesNotMatch(active, /data-sma-dynamics-mode-panel="scenario-details"/)
    // Origin stays in chart labels.
    assert.ok(active.includes(`シナリオ (${SCENARIO_ORIGIN_COPY.deterministic_template.tag})`), 'origin in chart label')
    // JP/US isolation.
    assert.doesNotMatch(active, new RegExp(`data-scenario-candidate="${otherPrefix}-`), `${prefix}: no ${otherPrefix} candidates`)
  }

  // 9e. Not drawable selections never enter the Scenario Analysis state.
  for (const [id, status] of [['jp-classification', 'no_path'], ['jp-mismatch-basis', 'rejected'], ['jp-weekly-native', 'alignable']] as const) {
    const markup = render('jp-rising', id, { analysis: 'scenario', horizon: id === 'jp-weekly-native' ? 5 : SMA_SCENARIO_TEMPLATE_HORIZON })
    assert.match(markup, new RegExp(`data-scenario-selected-status="${status}"`), `${id}: status explained`)
    assert.doesNotMatch(markup, /data-scenario-analysis=|data-scenario-closes-details|data-scenario-analysis-active/, `${id}: no analysis state`)
    assert.match(markup, /data-sma-dynamics-layout="chart-side"/)
    assert.match(markup, /role="status"[^>]*data-scenario-selected-status=/, `${id}: unavailable status announced`)
    assert.match(markup, /aria-live="polite" data-scenario-live="true"><\/p>/, `${id}: analysis live region remains silent`)
    assert.equal(detailsOpen(markup, 'data-scenario-developer'), true, `${id}: its developer panel stays open`)
    // P1-A: the user's draft never stands in for a selection that cannot be drawn.
    assert.doesNotMatch(markup, /data-sma-dynamics-mode-panel="scenario"/, `${id}: no user editor presented as the selection`)
    assert.doesNotMatch(markup, /data-sma-dynamics-mode-panel="scenario-details"/, `${id}: no draft calculation table`)
    assert.doesNotMatch(markup, /data-sma-conclusion-mode="scenario"/, `${id}: no scenario result`)
    assert.match(markup, new RegExp(`data-scenario-result-withheld="evidence_${status === 'alignable' ? 'alignable' : 'unavailable'}"`), `${id}: result withheld with a reason`)
    assert.match(markup, /data-scenario-draft-kept="true"/, `${id}: draft-kept note`)
    assert.match(markup, /<button type="button" class="btn[^"]*" data-size="sm" data-scenario-clear="true">/, `${id}: keyboard-reachable clear button`)
  }
  // Classification-only: provenance shown, still no path anywhere.
  const classification = render('jp-rising', 'jp-classification', { analysis: 'scenario', horizon: SMA_SCENARIO_TEMPLATE_HORIZON })
  assert.ok(classification.includes(SCENARIO_ORIGIN_COPY.model_classification.premise))
  assert.doesNotMatch(classification, /data-scenario-closes=|シナリオ \(方向分類\)/, 'classification-only: no closes, no chart overlay label')

  // Nothing selected: Price Freeze default, live region mounted but silent.
  const idle = render('jp-rising')
  assert.match(idle, /data-sma-conclusion-mode="freeze"/)
  assert.match(idle, /aria-live="polite" data-scenario-live="true"><\/p>/)
  assert.match(idle, /data-sma-dynamics-layout="chart-side"/)

  // 9f. Switching / clearing / hand-off leave no stale state (source contract; static render cannot click).
  const view = stripComments(read('components/stock/sma-dynamics/SmaDynamicsView.tsx'))
  assert.match(view, /const analysisName = evidenceActive && selectedEntry \? selectedEntry\.candidate\.label : null/, 'analysis state is derived from the one selection, never stored separately')
  assert.match(view, /const handoff = evidence\.selectedId == null \? evidence\.handoff : null/, 'a selection hides an older hand-off without discarding its provenance')
  assert.match(view, /setEvidence\(\{ selectedId: id \}\)/, 'switching replaces the single selection while preserving a saved hand-off')
  assert.doesNotMatch(view, /setEvidence\(\{ selectedId: id, handoff: null \}\)/, 'selection does not destroy hand-off provenance')
  assert.match(view, /setEvidence\(\{ selectedId: null, handoff: record \}\)/, 'hand-off ends the preview')
  assert.match(view, /onClear=\{clearEvidenceSelection\}/, 'clear returns to the user editor')
  assert.match(view, /const clearEvidenceSelection = \(\) => \{\s*setEvidence\(\{ selectedId: null \}\)\s*\}/, 'clear restores the prior mode and draft without rewriting either')
  assert.equal((view.match(/mode === 'scenario' && showsUserDraftEditor\(presentation\) && scenario && scenarioDraft/g) ?? []).length, 2, 'editor and its details only in the user-draft state')
  assert.match(view, /onToggleFreeze=\{toggleFreezeCompare\}/)
  assert.match(view, /scenarioValidationContext\(\s*available,/, 'drawn path re-validated against the bars on screen')
  const preview = read('app/dev/sma-dynamics/SmaDynamicsPreviewClient.tsx')
  assert.match(preview, /initialSelectedId: fixture\.id === query\.fixtureId/, 'deep-link selection applies only to its own fixture')
}

// ---------------------------------------------------------------------------
// 10. Final UX revision: dynamic lead, truthful counts with a rejected template, mobile grids, controls placement.
{
  const SLOPE = { up: '上向き', flat: '横ばい', down: '下向き' } as const
  const mean = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / values.length

  // 10a. Lead wording from hand-made series: grouping, mixed directions, unavailable values, missing close.
  {
    const l = lab('jp-rising', '1D', SMA_SCENARIO_TEMPLATE_HORIZON)
    const h = l.projection.bars.length
    const tail = (a: number, b: number) => [...Array(h - 2).fill(100), a, b]
    const evaluation = (pct: number | null, sma: Record<number, Array<number | null>>): ScenarioEvaluation => ({
      cells: Array.from({ length: h }, (_, i) => ({ k: i + 1, raw: '', status: 'ok' as const, close: 1, pctFromAnchor: i === h - 1 ? pct : 0 })),
      closes: Array(h).fill(1),
      sma: sma as ScenarioEvaluation['sma'],
      filled: h,
      missingK: [],
      invalidK: [],
      state: 'complete',
    })
    assert.equal(
      scenarioResultLead({ result: l, evaluation: evaluation(6, { 5: tail(100, 101), 25: tail(99, 100), 75: tail(100, 100) }), periods: [5, 25, 75] }),
      `T+${h}の仮定終値は基準日比 +6.00%。その足では、SMA5・SMA25は上向き、SMA75は横ばいです。`,
      'grouped up + flat',
    )
    assert.equal(
      scenarioResultLead({ result: l, evaluation: evaluation(-3.2, { 5: tail(100, 99), 25: tail(100, 100), 75: tail(100, 101) }), periods: [5, 25, 75] }),
      `T+${h}の仮定終値は基準日比 -3.20%。その足では、SMA5は下向き、SMA25は横ばい、SMA75は上向きです。`,
      'mixed directions, negative move',
    )
    assert.equal(
      scenarioResultLead({ result: l, evaluation: evaluation(6, { 5: tail(100, 101), 25: tail(100, null as unknown as number), 75: tail(100, 101) }), periods: [5, 25, 75] }),
      `T+${h}の仮定終値は基準日比 +6.00%。その足では、SMA5・SMA75は上向きです。SMA25はその足の値を計算できません。`,
      'unavailable value stated, never guessed',
    )
    assert.equal(
      scenarioResultLead({ result: l, evaluation: evaluation(null, { 5: tail(100, 101) }), periods: [5] }),
      `T+${h}の仮定終値はありません。その足では、SMA5は上向きです。`,
      'missing final close',
    )
    assert.equal(scenarioResultLead({ result: l, evaluation: evaluation(0, {}), periods: [] }), `T+${h}の仮定終値は基準日比 0.00%。`, 'no SMA selected: move only')
  }

  // 10b. Real View: the lead is the actual calculation for the selected horizon and periods (JP and US).
  for (const [priceFixtureId, prefix, templateId, ctx, periods] of [
    ['jp-rising', 'jp', 'continuation', JP_CTX, [5, 25, 75]],
    ['us-falling', 'us', 'breakdown', US_CTX, [5, 25, 75]],
    ['jp-rising', 'jp', 'range', JP_CTX, [5, 25]],
  ] as const) {
    const fixture = findSmaDynamicsFixture(priceFixtureId)!
    const l = lab(priceFixtureId, '1D', SMA_SCENARIO_TEMPLATE_HORIZON)
    const base = forwardBase(l)
    const projection = adaptScenarioToSma(validateScenarioEvidence(templateEnvelope(priceFixtureId, templateId), ctx), base)!
    const h = projection.closes.length
    assert.equal(h, SMA_SCENARIO_TEMPLATE_HORIZON)
    // Independent check of the final-bar SMA against a plain mean over confirmed + assumed closes.
    const series = [...base.confirmedCloses.slice(0, base.anchorIndex + 1), ...projection.closes] as number[]
    const groups = new Map<keyof typeof SLOPE, string[]>()
    for (const period of periods) {
      const final = mean(series.slice(series.length - period))
      const previous = mean(series.slice(series.length - 1 - period, series.length - 1))
      const engine: number = projection.sma[period][h - 1]!
      assert.ok(Math.abs(engine - final) <= 1e-9 * Math.max(1, final), `${prefix} SMA${period}: engine value = plain mean`)
      const delta: number = engine - projection.sma[period][h - 2]!
      if (Math.abs(final - previous) > 1e-9 * final) assert.equal(Math.sign(delta), Math.sign(final - previous), `${prefix} SMA${period}: direction`)
      const slope = delta > 0 ? 'up' : delta < 0 ? 'down' : 'flat'
      groups.set(slope, [...(groups.get(slope) ?? []), `SMA${period}`])
    }
    const pct = (projection.closes.at(-1)! / base.anchorClose - 1) * 100
    const expected = `T+${h}の仮定終値は基準日比 ${pct > 0 ? '+' : ''}${(Math.abs(pct) < 0.005 ? 0 : pct).toFixed(2)}%。その足では、${[...groups].map(([slope, names]) => `${names.join('・')}は${SLOPE[slope]}`).join('、')}です。`
    const markup = renderToStaticMarkup(createElement(SmaDynamicsView, {
      security: { market: fixture.market, ticker: fixture.ticker, name: fixture.name },
      analysisDate: fixture.analysisDate,
      load: { status: 'ready', rows: fixture.rows } as SmaDynamicsLoadState,
      dataSource: { label: 'テスト', priceBasis: '合成データ' },
      initialSettings: { ...SMA_DYNAMICS_DEFAULT_SETTINGS, analysis: 'scenario', horizon: SMA_SCENARIO_TEMPLATE_HORIZON, periods: [...periods] },
      externalScenarios: {
        candidates: scenarioFixtureSet(priceFixtureId)!.candidates,
        historyBasis: SMA_SCENARIO_FIXTURE_BASIS,
        securityPermanentId: { status: 'unavailable', reason: '合成Fixtureには恒久IDがありません' },
        calendarVersion: SMA_SCENARIO_FIXTURE_CALENDAR_VERSION,
        initialSelectedId: `${prefix}-template-${templateId}`,
      },
    }))
    const lead = markup.match(/data-scenario-result-lead="true">([^<]+)</)?.[1]
    assert.equal(lead, expected, `${prefix}/${templateId}: lead is the actual final-bar calculation`)
    assert.doesNotMatch(lead!, /ずっと|継続|続け|期間中|一貫|常に|予測|確率/, 'final bar only; no claim about every bar')
    for (const period of [5, 25, 75, 200]) assert.equal(lead!.includes(`SMA${period}は`) || lead!.includes(`SMA${period}・`), (periods as readonly number[]).includes(period), `${prefix}: SMA${period} in lead only when selected`)
  }

  // 10c. One rejected standard template: usable vs total is explicit; ordinary counts stay simple.
  {
    const set = scenarioFixtureSet('jp-rising')!
    const blockedId = 'jp-template-continuation'
    const candidates = set.candidates.map((candidate) => (candidate.id === blockedId
      ? { ...candidate, envelope: { ...templateEnvelope('jp-rising', 'continuation'), priceBasis: { kind: 'raw_as_traded' } } }
      : candidate))
    const entries = evaluateScenarioCandidates(candidates, () => JP_CTX)
    const blocked = entries.find((entry) => entry.candidate.id === blockedId)!
    assert.equal(blocked.validation.status, 'rejected', 'basis mismatch rejects the template')
    assert.equal(isStandardScenarioEntry(blocked), true, 'still a formal standard template (counted in total)')
    assert.deepEqual(scenarioDirectionCounts(entries), {
      up: { total: 3, usable: 2, blocked: 1 },
      range: { total: 2, usable: 2, blocked: 0 },
      down: { total: 3, usable: 3, blocked: 0 },
    })
    assert.deepEqual(directionCountText({ total: 3, usable: 2, blocked: 1 }), { visible: '利用可能2 / 全3、利用不可1', accessible: '利用可能2件 / 全3件、利用不可1件' })
    assert.deepEqual(directionCountText({ total: 2, usable: 2, blocked: 0 }), { visible: '2', accessible: '2件' })
    const picker = renderToStaticMarkup(createElement(ScenarioEvidencePicker, { entries, direction: 'up', selectedId: null, disabled: false, barNoun: '日足', onDirection: () => {}, onSelect: () => {} }))
    assert.match(picker, /aria-label="上昇の仮定 利用可能2件 \/ 全3件、利用不可1件"[^>]*data-scenario-direction="up" data-scenario-direction-count="3" data-scenario-direction-usable="2" data-scenario-direction-blocked="1"/)
    assert.match(picker, /data-scenario-direction="up"[^>]*>.*?data-scenario-direction-count-text="true">利用可能2 \/ 全3、利用不可1</, 'visible copy distinguishes usable from total')
    assert.match(picker, /aria-label="レンジの仮定 2件"[^>]*data-scenario-direction="range" data-scenario-direction-count="2"/, 'all-valid direction keeps the plain count')
    assert.match(picker, /aria-label="下落の仮定 3件"[^>]*data-scenario-direction="down" data-scenario-direction-count="3"/)
    const normalList = picker.slice(picker.indexOf('data-scenario-standard-list'), picker.indexOf('data-scenario-list-note'))
    assert.equal([...normalList.matchAll(/data-scenario-candidate="/g)].length, 2, 'normal list shows the 2 usable')
    assert.doesNotMatch(normalList, new RegExp(blockedId))
    const blockedGroup = picker.slice(picker.indexOf('data-scenario-blocked'), picker.indexOf('data-scenario-developer'))
    assert.match(blockedGroup, new RegExp(`data-scenario-candidate="${blockedId}"[^>]*data-scenario-status="rejected"`), 'blocked template visible in its own collapsed group')
    assert.ok(blockedGroup.includes('表示できないシナリオ (1件)'))
    assert.doesNotMatch(picker.slice(picker.indexOf('data-scenario-developer')), new RegExp(blockedId), 'not moved into the developer panel')

    // Fail closed: audience must be exactly 'standard'; missing/unknown audience is developer-only.
    const template = entries.find((entry) => entry.candidate.id === 'jp-template-rebound')!
    assert.equal(isStandardScenarioEntry({ ...template, candidate: { ...template.candidate, audience: undefined } }), false, 'missing audience is not standard')
    assert.equal(isStandardScenarioEntry({ ...template, candidate: { ...template.candidate, audience: 'other' as 'standard' } }), false, 'unknown audience is not standard')
    const unflagged = evaluateScenarioCandidates(set.candidates.map((candidate) => (candidate.audience === 'standard' ? candidate : { id: candidate.id, label: candidate.label, envelope: candidate.envelope })), () => JP_CTX)
    assert.deepEqual(scenarioDirectionCounts(unflagged), scenarioDirectionCounts(evaluateScenarioCandidates(set.candidates, () => JP_CTX)), 'unflagged fixtures never enter the counts')
    for (const direction of ['up', 'range', 'down'] as const) assert.equal(scenarioDirectionCounts(unflagged)[direction].total, direction === 'range' ? 2 : 3)
  }

  // 10d. Mobile: fact grids are one column at phone width, label/value columns from sm; values wrap.
  {
    const envelope = templateEnvelope('jp-rising', 'continuation')
    const header = renderToStaticMarkup(createElement(ScenarioAnalysisHeader, { titleId: 't', name: '上がり続ける仮定', envelope, barCount: 10, barNoun: '日足', fmt, freezeCompared: false, onEdit: () => {}, onSolve: () => {}, onToggleFreeze: () => {}, onClear: () => {} }))
    const details = renderToStaticMarkup(createElement(ScenarioEvidenceDetails, { envelope }))
    for (const [name, markup, attr] of [['header', header, 'data-scenario-analysis-facts'], ['details', details, 'data-scenario-details']] as const) {
      const dl = markup.match(new RegExp(`<dl class="([^"]+)"[^>]*${attr}`))?.[1]
      assert.ok(dl, `${name}: dl rendered`)
      assert.ok(dl!.split(' ').includes('grid-cols-1') && dl!.split(' ').includes('sm:grid-cols-[7rem_minmax(0,1fr)]'), `${name}: 1 column → label/value from sm`)
      assert.ok(!dl!.split(' ').includes('grid-cols-[7rem_minmax(0,1fr)]'), `${name}: no fixed two-column grid at 390px`)
      for (const dd of markup.matchAll(/<dd class="([^"]+)"/g)) assert.ok(dd[1].includes('[overflow-wrap:anywhere]') && dd[1].includes('min-w-0'), `${name}: dd wraps long labels/provenance`)
    }
    assert.match(header, /<section aria-labelledby="t" tabindex="-1"/, 'header is a programmatic focus target')
    const badge = renderToStaticMarkup(createElement(ScenarioOriginBadge, { origin: { kind: 'deterministic_template' } }))
    assert.ok(!badge.match(/class="([^"]+)"/)![1].split(' ').includes('shrink-0') && badge.includes('max-w-full'), 'badge may shrink/wrap inside narrow rows')
  }

  // 10e. Normal / no-scenario modes keep the controls first and open; no disclosure.
  {
    const fixture = findSmaDynamicsFixture('jp-rising')!
    const set = scenarioFixtureSet('jp-rising')!
    const props = {
      security: { market: fixture.market, ticker: fixture.ticker, name: fixture.name },
      analysisDate: fixture.analysisDate,
      load: { status: 'ready', rows: fixture.rows } as SmaDynamicsLoadState,
      dataSource: { label: 'テスト', priceBasis: '合成データ' },
    }
    const scenarios = { candidates: set.candidates, historyBasis: set.historyBasis, securityPermanentId: { status: 'unavailable' as const, reason: 'x' }, calendarVersion: SMA_SCENARIO_FIXTURE_CALENDAR_VERSION }
    for (const analysis of ['freeze', 'scenario', 'solver'] as const) {
      for (const externalScenarios of [undefined, scenarios]) {
        const markup = renderToStaticMarkup(createElement(SmaDynamicsView, { ...props, initialSettings: { ...SMA_DYNAMICS_DEFAULT_SETTINGS, analysis }, externalScenarios }))
        assert.doesNotMatch(markup, /data-sma-dynamics-controls-disclosure|data-scenario-result-lead/, `${analysis}: no analysis-only UI`)
        assert.ok(markup.indexOf('data-sma-dynamics-controls') < markup.indexOf('data-sma-dynamics-layout'), `${analysis}: controls before the chart`)
        assert.match(markup, /<div tabindex="-1" class="[^"]*" data-sma-dynamics-controls="true">/, `${analysis}: controls not collapsed`)
        assert.ok(markup.includes('上から順に選ぶだけです'), `${analysis}: original intro copy`)
      }
    }
    // Focus is restored only when the focused control unmounted with the state change.
    const view = stripComments(read('components/stock/sma-dynamics/SmaDynamicsView.tsx'))
    assert.match(view, /if \(!focusWithinRef\.current \|\| \(active && active !== document\.body\)\) return/)
    assert.match(view, /analysisOn \? rootRef\.current\?\.querySelector<HTMLElement>\('\[data-scenario-analysis\]'\) : controlsRef\.current/)
  }
}

// ---------------------------------------------------------------------------
// 11. Final integrity: explicit presentation state (P1-A) and hand-off provenance (P1-B).
{
  const at = (markup: string, needle: string) => {
    const index = markup.indexOf(needle)
    assert.ok(index >= 0, `present: ${needle}`)
    return index
  }
  const jpSet = scenarioFixtureSet('jp-rising')!
  const jpEnvelope =(id: string) => jpSet.candidates.find((candidate) => candidate.id === id)!.envelope
  const jpLab = lab('jp-rising', '1D', SMA_SCENARIO_TEMPLATE_HORIZON)
  const jpBase = forwardBase(jpLab)
  // A non-empty user draft: anything leaking from it would be visible.
  const userDraft = evaluateScenario(jpBase, scenarioFromCloses(jpBase, Array.from({ length: jpBase.horizon }, (_, i) => jpBase.anchorClose * (1 - 0.01 * (i + 1))), 'price'))
  assert.equal(userDraft.filled, jpBase.horizon)
  const resolve = (validation: ScenarioEvidenceValidation | null, selectedId: string | null = 'sel', validated = true) =>
    resolveScenarioPresentation({ selectedId, validated, validation, projection: validation ? adaptScenarioToSma(validation, jpBase) : null })
  const seen = new Set<ScenarioPresentationState>()

  // 11a. User draft: no selection → the draft object itself (clear restores it unchanged).
  const none = resolve(null, null)
  seen.add(none.state)
  assert.equal(none.state, 'user_draft')
  assert.equal(presentedScenario(none, userDraft, false), userDraft, 'no selection: the very same draft object')
  assert.equal(showsUserDraftEditor(none), true)

  // 11b. Valid template → projectable; drawn only while shown, never mixed with the draft.
  const projectable = resolve(validateScenarioEvidence(templateEnvelope('jp-rising', 'continuation'), JP_CTX))
  seen.add(projectable.state)
  assert.equal(projectable.state, 'evidence_projectable')
  if (projectable.state === 'evidence_projectable') {
    assert.equal(presentedScenario(projectable, userDraft, true), projectable.projection.evaluation)
    assert.equal(presentedScenario(projectable, userDraft, false), null, 'projectable but not shown: no draft fallback')
  }
  assert.equal(showsUserDraftEditor(projectable), false)
  // Switching to another valid template replaces the projection (no residue of the first).
  const other = resolve(validateScenarioEvidence(templateEnvelope('jp-rising', 'rebound'), JP_CTX), 'other')
  assert.ok(other.state === 'evidence_projectable' && projectable.state === 'evidence_projectable' && other.projection.closes.join() !== projectable.projection.closes.join())

  // 11c. Unavailable: classification-only and every rejection, each with a cause-specific headline.
  const unavailableCases: Array<[string, ScenarioEvidenceValidation | null, boolean, ScenarioSelectionCause['kind'], RegExp]> = [
    ['classification-only', validateScenarioEvidence(classificationOnlyEnvelope('jp-rising', 'up', 0.62), JP_CTX), true, 'classification_only', /方向スコアのみ/],
    ['market', validateScenarioEvidence(jpEnvelope('jp-mismatch-market'), JP_CTX), true, 'rejected', /別の銘柄・市場/],
    ['ticker', validateScenarioEvidence(jpEnvelope('jp-mismatch-ticker'), JP_CTX), true, 'rejected', /別の銘柄・市場/],
    ['as-of', validateScenarioEvidence(jpEnvelope('jp-mismatch-asof'), JP_CTX), true, 'rejected', /基準日が表示中と異なる/],
    ['basis', validateScenarioEvidence(jpEnvelope('jp-mismatch-basis'), JP_CTX), true, 'rejected', /価格の基準/],
    ['invalid close', validateScenarioEvidence(jpEnvelope('jp-invalid-path'), JP_CTX), true, 'rejected', /経路の終値に使えない値/],
    ['candidate disappeared', null, true, 'selection_missing', /一覧に見つからない/],
    ['history pending', null, false, 'not_validated', /価格履歴を読み込むまで/],
  ]
  for (const [label, validation, validated, cause, headline] of unavailableCases) {
    const presentation = resolve(validation, 'sel', validated)
    seen.add(presentation.state)
    assert.equal(presentation.state, 'evidence_unavailable', `${label}: unavailable`)
    if (presentation.state !== 'evidence_unavailable') continue
    assert.equal(presentation.cause.kind, cause, `${label}: cause`)
    assert.match(scenarioSelectionHeadline(presentation.cause), headline, `${label}: cause-specific headline`)
    assert.equal(presentedScenario(presentation, userDraft, true), null, `${label}: no draft path/SMA/result`)
    assert.equal(showsUserDraftEditor(presentation), false, `${label}: no user editor`)
  }
  // Adapter refusal is fail-closed too (validated projectable, but not on these bars).
  const refused = resolveScenarioPresentation({ selectedId: 'sel', validated: true, validation: validateScenarioEvidence(templateEnvelope('jp-rising', 'continuation'), JP_CTX), projection: null })
  assert.ok(refused.state === 'evidence_unavailable' && refused.cause.kind === 'projection_failed')
  assert.equal(presentedScenario(refused, userDraft, true), null)

  // 11d. Alignable (horizon / timeframe): isolated until the user explicitly switches; nothing converted.
  for (const [label, validation, timeframe, horizon] of [
    ['horizon', validateScenarioEvidence(templateEnvelope('jp-rising', 'continuation'), context('jp-rising', '1D', 5)), '1D', SMA_SCENARIO_TEMPLATE_HORIZON],
    ['timeframe', validateScenarioEvidence(jpEnvelope('jp-weekly-native'), context('jp-rising', '1D', 5)), '1W', 5],
  ] as const) {
    const presentation = resolve(validation)
    seen.add(presentation.state)
    assert.equal(presentation.state, 'evidence_alignable', `${label}: alignable`)
    if (presentation.state !== 'evidence_alignable') continue
    assert.deepEqual([presentation.timeframe, presentation.horizon], [timeframe, horizon], `${label}: explicit target view`)
    assert.equal(presentedScenario(presentation, userDraft, true), null, `${label}: no draft fallback`)
    assert.equal(showsUserDraftEditor(presentation), false)
  }
  assert.deepEqual([...seen].sort(), ['evidence_alignable', 'evidence_projectable', 'evidence_unavailable', 'user_draft'], 'all four states exercised')

  // 11e. Clear: from any non-user state, ending the selection gives back the identical draft.
  const draftBefore = structuredClone(userDraft)
  for (const [, validation, validated] of unavailableCases) {
    assert.equal(presentedScenario(resolve(validation, 'sel', validated), userDraft, true), null)
    assert.equal(presentedScenario(resolve(validation, null, validated), userDraft, true), userDraft, 'cleared: the draft returns')
  }
  assert.deepEqual(userDraft, draftBefore, 'the draft is never modified by selection or clearing')

  // 11f. JP/US isolation: a template for the other market never draws and is named as such.
  for (const [envelope, ctx] of [[templateEnvelope('jp-rising', 'continuation'), US_CTX], [templateEnvelope('us-falling', 'breakdown'), JP_CTX]] as const) {
    const presentation = resolveScenarioPresentation({ selectedId: 'x', validated: true, validation: validateScenarioEvidence(envelope, ctx), projection: null })
    assert.ok(presentation.state === 'evidence_unavailable' && presentation.cause.kind === 'rejected')
    if (presentation.state === 'evidence_unavailable') assert.match(scenarioSelectionHeadline(presentation.cause), /別の銘柄・市場/)
  }

  // 11g. Real View: unavailable / alignable selections draw nothing of the draft; clear is reachable.
  const viewFor = (priceFixtureId: string, candidates: ReadonlyArray<ScenarioEvidenceCandidate>, initialSelectedId: string | undefined, overrides: Partial<typeof SMA_DYNAMICS_DEFAULT_SETTINGS> = {}) => {
    const fixture = findSmaDynamicsFixture(priceFixtureId)!
    return renderToStaticMarkup(createElement(SmaDynamicsView, {
      security: { market: fixture.market, ticker: fixture.ticker, name: fixture.name },
      analysisDate: fixture.analysisDate,
      load: { status: 'ready', rows: fixture.rows } as SmaDynamicsLoadState,
      dataSource: { label: 'テスト', priceBasis: '合成データ' },
      initialSettings: { ...SMA_DYNAMICS_DEFAULT_SETTINGS, analysis: 'scenario', horizon: SMA_SCENARIO_TEMPLATE_HORIZON, compare: ['freeze', 'scenario'], ...overrides },
      externalScenarios: { candidates, historyBasis: SMA_SCENARIO_FIXTURE_BASIS, securityPermanentId: { status: 'unavailable', reason: 'x' }, calendarVersion: SMA_SCENARIO_FIXTURE_CALENDAR_VERSION, ...(initialSelectedId ? { initialSelectedId } : {}) },
    }))
  }
  for (const id of ['jp-classification', 'jp-mismatch-market', 'jp-mismatch-ticker', 'jp-mismatch-asof', 'jp-mismatch-basis', 'jp-invalid-path']) {
    const markup = viewFor('jp-rising', jpSet.candidates, id)
    assert.match(markup, /data-scenario-selected-status="(no_path|rejected)"/, `${id}: status shown`)
    assert.doesNotMatch(markup, /data-sma-dynamics-mode-panel="scenario/, `${id}: no editor`)
    assert.doesNotMatch(markup, /data-sma-conclusion-mode="scenario"/, `${id}: no scenario result`)
    assert.doesNotMatch(markup, /仮定 \(シナリオ/, `${id}: no scenario future-region label`)
    assert.ok(markup.includes('仮定 (表示なし)'), `${id}: future region says nothing is drawn`)
    const legend = markup.slice(at(markup, 'data-sma-dynamics-legend'), at(markup, 'data-sma-dynamics-premise'))
    assert.doesNotMatch(legend, /シナリオ/, `${id}: no scenario in legend`)
    const readout = markup.slice(at(markup, `id="${markup.match(/id="([^"]+-readout)"/)![1]}"`), at(markup, 'data-sma-dynamics-legend'))
    assert.doesNotMatch(readout, /シナリオ/, `${id}: no scenario layer in the readout`)
    assert.match(markup, /data-sma-dynamics-premise="true" data-mode="scenario">前提: 選択中のシナリオは表示できないため/, `${id}: premise describes the withheld state, not the draft`)
    assert.match(markup, /data-scenario-result-withheld="evidence_unavailable"/)
    assert.equal((markup.match(/data-scenario-clear="true"/g) ?? []).length, 1, `${id}: one clear action`)
  }
  const aligned = viewFor('jp-rising', jpSet.candidates, 'jp-weekly-native', { horizon: 5 })
  assert.match(aligned, /data-scenario-selected-status="alignable"[^>]*data-scenario-selection-cause="view_mismatch"/)
  assert.match(aligned, /data-scenario-align="true"/, 'explicit switch offered')
  assert.match(aligned, /data-scenario-result-withheld="evidence_alignable"/)
  assert.doesNotMatch(aligned, /data-sma-dynamics-mode-panel="scenario/)
  // Valid template: the drawn path is the template, never the withheld/draft state.
  const valid = viewFor('jp-rising', jpSet.candidates, 'jp-template-continuation')
  assert.doesNotMatch(valid, /data-scenario-result-withheld|data-scenario-selected-status/)
  assert.match(valid, /data-scenario-analysis="deterministic_template"/)
  // US view with a JP template among its candidates: isolated, explained as another security.
  const usSet = scenarioFixtureSet('us-falling')!
  const crossed = viewFor('us-falling', [...usSet.candidates, { id: 'jp-in-us', label: '別市場', envelope: templateEnvelope('jp-rising', 'continuation'), audience: 'developer' }], 'jp-in-us')
  assert.match(crossed, /data-scenario-issue="market_mismatch"/)
  assert.ok(crossed.includes('表示中とは別の銘柄・市場のシナリオのため表示しません'))
  assert.doesNotMatch(crossed, /data-sma-dynamics-mode-panel="scenario/)
  // Unavailable status component: the clear button is a native button with visible text.
  const status = renderToStaticMarkup(createElement(ScenarioSelectionUnavailable, { cause: { kind: 'selection_missing' }, onClear: () => {} }))
  assert.match(status, /data-scenario-selection-cause="selection_missing"/)
  assert.match(status, new RegExp(`<button type="button"[^>]*data-scenario-clear="true"><svg[^]*?</svg>${SCENARIO_CLEAR_LABEL.replace(/[()]/g, '\\$&')}</button>`))
  assert.ok(status.includes(SCENARIO_DRAFT_KEPT_NOTE))

  // 11h. Hand-off: original → edited → restored is read from the values; source kept apart.
  const template = templateEnvelope('jp-rising', 'continuation')
  const projection = adaptScenarioToSma(validateScenarioEvidence(template, JP_CTX), jpBase)!
  const written = scenarioFromCloses(jpBase, projection.closes, 'price')
  const record: ScenarioHandoffRecord = {
    candidateId: 'jp-template-continuation',
    label: '上がり続ける仮定',
    sourceOrigin: 'deterministic_template',
    timeframe: '1D',
    horizon: jpBase.horizon,
    asOfDate: jpLab.asOf.date,
    sourceCloses: projection.closes,
    inheritedCloses: evaluateScenario(jpBase, written).closes,
  }
  assert.deepEqual(record.inheritedCloses, record.sourceCloses, 'the written draft reads back as the exact source closes')
  const here = (draft: ScenarioDraft) => ({ timeframe: '1D' as const, horizon: jpBase.horizon, asOfDate: jpLab.asOf.date, closes: evaluateScenario(jpBase, draft).closes })
  assert.deepEqual(resolveHandoffPath(record, here(written)), { status: 'in_scope', currentOrigin: 'inherited', changedK: [] }, 'original')
  const edited = setScenarioInput(written, 3, String(projection.closes[2] + 5))
  assert.deepEqual(resolveHandoffPath(record, here(edited)), { status: 'in_scope', currentOrigin: 'user_modified', changedK: [3] }, 'edited')
  const cleared = setScenarioInput(written, 7, '')
  assert.deepEqual(resolveHandoffPath(record, here(cleared)), { status: 'in_scope', currentOrigin: 'user_modified', changedK: [7] }, 'a removed value is a change')
  const restored = setScenarioInput(edited, 3, written.inputs[2])
  assert.deepEqual(resolveHandoffPath(record, here(restored)), { status: 'in_scope', currentOrigin: 'inherited', changedK: [] }, 'restored values: inherited again')
  const retyped = setScenarioInput(written, 3, written.inputs[2].includes('.') ? `${written.inputs[2]}0` : `${written.inputs[2]}.0`)
  assert.equal((resolveHandoffPath(record, here(retyped)) as { currentOrigin: string }).currentOrigin, 'inherited', 'same value typed differently: inherited (values, not text)')
  const unitRoundTrip = convertScenarioUnit(jpBase, convertScenarioUnit(jpBase, written, 'pct'), 'price')
  assert.equal((resolveHandoffPath(record, here(unitRoundTrip)) as { currentOrigin: string }).currentOrigin, 'inherited', 'price -> percent -> price does not create a false user edit')
  const highBase = { ...jpBase, anchorClose: 10_000, horizon: 1 }
  const highWritten = scenarioFromCloses(highBase, [10_500], 'price')
  const highRoundTrip = convertScenarioUnit(highBase, convertScenarioUnit(highBase, highWritten, 'pct'), 'price')
  const highRecord: ScenarioHandoffRecord = { ...record, horizon: 1, sourceCloses: [10_500], inheritedCloses: evaluateScenario(highBase, highWritten).closes }
  const highCurrent = { timeframe: '1D' as const, horizon: 1, asOfDate: record.asOfDate, closes: evaluateScenario(highBase, highRoundTrip).closes }
  assert.equal((resolveHandoffPath(highRecord, highCurrent) as { currentOrigin: string }).currentOrigin, 'inherited', 'high-price unit round-trip stays inherited')
  assert.equal((resolveHandoffPath(highRecord, { ...highCurrent, closes: [10_500.001] }) as { currentOrigin: string }).currentOrigin, 'user_modified', 'a real high-price edit remains user-modified')
  // Source origin never changes with the current path origin.
  assert.equal(record.sourceOrigin, 'deterministic_template')

  // 11i. Scope mismatch suppresses the comparison (never resized or converted).
  assert.deepEqual(resolveHandoffPath(record, { ...here(written), horizon: 5, closes: here(written).closes.slice(0, 5) }), { status: 'out_of_scope', mismatches: ['horizon'] })
  assert.deepEqual(resolveHandoffPath(record, { ...here(written), timeframe: '1W' }), { status: 'out_of_scope', mismatches: ['timeframe'] })
  assert.deepEqual(resolveHandoffPath(record, { ...here(written), asOfDate: '2026-10-15' }), { status: 'out_of_scope', mismatches: ['as_of'] })
  assert.match(handoffScopeText(record, ['horizon']), /日足 \(1D\)・10本・基準日 2026-10-16 .*本数が異なるため比較に使いません \(自動で変換・伸縮はしません\)/)

  // 11j. Labels: inherited comparison path vs the solver's representative path; never a solver result.
  assert.equal(handoffComparisonLabel(record, 'inherited'), '比較経路：上がり続ける仮定（テンプレート）')
  assert.equal(handoffComparisonLabel(record, 'user_modified'), '比較経路：上がり続ける仮定を基に変更（ユーザー）')
  assert.equal(SOLVER_REPRESENTATIVE_PATH_LABEL, '逆算による代表経路')
  assert.equal(handoffSolverLead(record.label, 'inherited'), '「上がり続ける仮定」から引き継いだ価格経路と、逆算結果を比較しています。')
  assert.match(handoffSolverLead(record.label, 'user_modified'), /あなたが変更した価格経路と、逆算結果を比較/)
  assert.equal(handoffCheckLabel(record.label, 'inherited'), '引き継いだ「上がり続ける仮定」の経路')
  for (const origin of ['inherited', 'user_modified'] as const) {
    assert.doesNotMatch(handoffComparisonLabel(record, origin) + handoffCheckLabel(record.label, origin), /逆算|代表経路|解|入力した/, `${origin}: inherited path never named as a solver result`)
  }
  assert.match(HANDOFF_NOT_SOLVER_NOTE, /逆算の結果ではなく/)

  const callout = (path: HandoffPathState, onRestoreView?: () => void, comparisonOnChart = true, solverOnChart = true) => renderToStaticMarkup(createElement(SolverHandoffCallout, { record, path, fmt, comparisonOnChart, solverOnChart, onRestoreView }))
  const original = callout({ status: 'in_scope', currentOrigin: 'inherited', changedK: [] })
  assert.match(original, /data-sma-solver-handoff="true" data-handoff-source-origin="deterministic_template" data-handoff-scope="in_scope" data-handoff-path-origin="inherited"/)
  assert.ok(original.includes(handoffSolverLead(record.label, 'inherited')))
  assert.ok(original.includes('比較経路：上がり続ける仮定（テンプレート）') && original.includes('逆算による代表経路'))
  assert.match(original, /チャート:/, 'chart copy is present when the comparison overlay is visible')
  const hiddenComparison = callout({ status: 'in_scope', currentOrigin: 'inherited', changedK: [] }, undefined, false)
  assert.doesNotMatch(hiddenComparison, /チャート:/, 'chart copy is absent when the comparison overlay is hidden')
  assert.match(hiddenComparison, /現在チャートに重ねていません/, 'hidden comparison is described truthfully')
  assert.match(hiddenComparison, /「比較」で「シナリオ」を選ぶ/, 'hidden comparison names the actual control')
  const missingSolver = callout({ status: 'in_scope', currentOrigin: 'inherited', changedK: [] }, undefined, true, false)
  assert.match(missingSolver, /チャート:.*比較経路：上がり続ける仮定/, 'visible comparison remains named')
  assert.match(missingSolver, /逆算による代表経路.*現在表示できる経路がありません/, 'missing solver path is not claimed on the chart')
  const neitherPath = callout({ status: 'in_scope', currentOrigin: 'inherited', changedK: [] }, undefined, false, false)
  assert.doesNotMatch(neitherPath, /チャート:/, 'no chart claim when neither path is visible')
  assert.match(neitherPath, /見つかったときに、2つの経路を見比べられます/, 'comparison is conditional on a solver path')
  for (const marker of ['data-handoff-source-label="true">上がり続ける仮定<', 'data-handoff-source-timeframe="1D"', `data-handoff-source-horizon="${jpBase.horizon}"`, `data-handoff-source-asof="${jpLab.asOf.date}"`]) assert.ok(original.includes(marker), `metadata: ${marker}`)
  const closesList = original.match(/data-handoff-source-closes="true">([\s\S]*?)<\/ol>/)![1]
  assert.equal((closesList.match(/<li>/g) ?? []).length, jpBase.horizon, 'original inherited closes listed')
  assert.ok(closesList.includes(`T+1 ${fmt(record.sourceCloses[0])}`))
  assert.match(original, /<details class="[^"]*" data-handoff-details="true">/, 'technical fields collapsed')
  assert.doesNotMatch(original, /<details[^>]*open/, 'collapsed by default')
  const modified = callout({ status: 'in_scope', currentOrigin: 'user_modified', changedK: [3] })
  assert.match(modified, /data-handoff-source-origin="deterministic_template" data-handoff-scope="in_scope" data-handoff-path-origin="user_modified"/, 'source origin kept while the current path is the user\'s')
  assert.ok(modified.includes('比較経路：上がり続ける仮定を基に変更（ユーザー）'))
  const outside = callout({ status: 'out_of_scope', mismatches: ['horizon'] }, () => {})
  assert.match(outside, /data-handoff-scope="out_of_scope"/)
  assert.doesNotMatch(outside, /data-handoff-path-origin|data-handoff-lead|比較経路：/, 'no comparison claimed out of scope')
  assert.match(outside, /data-handoff-restore-view="true">表示を 1D・10本に戻して比較する</)
  assert.doesNotMatch(callout({ status: 'out_of_scope', mismatches: ['as_of'] }), /data-handoff-restore-view/, 'as-of cannot be switched back: no button')
  for (const markup of [original, modified, outside]) assert.doesNotMatch(visibleText(markup), /唯一|一意|逆算結果です|予測|確率/, 'no solver-result or forecast claims')

  // Editor note follows the same values-based origin.
  const noteEdited = renderToStaticMarkup(createElement(ScenarioHandoffNote, { record, path: { status: 'in_scope', currentOrigin: 'user_modified', changedK: [3] } }))
  assert.match(noteEdited, /data-handoff-path-origin="user_modified"/)
  assert.ok(noteEdited.includes('元の値に戻すと、引き継いだ経路として扱います'))
  const noteOutside = renderToStaticMarkup(createElement(ScenarioHandoffNote, { record, path: { status: 'out_of_scope', mismatches: ['timeframe'] } }))
  assert.match(noteOutside, /data-handoff-scope="out_of_scope"/)
  assert.ok(noteOutside.includes('時間軸が異なるため比較に使いません'))

  // 11k. Numerical contracts unchanged: hand-off SMA = template SMA = projectSmaPath; solver checks equal.
  const handed = evaluateScenario(jpBase, written)
  for (const period of SMA_LAB_PERIODS) {
    assert.deepEqual(handed.sma[period], projection.sma[period], `SMA${period}: hand-off = template`)
    assert.deepEqual(handed.sma[period], projectSmaPath(jpBase.confirmedCloses, projection.closes, period), `SMA${period}: engine parity`)
  }
  const goal = goalFromDraft({ ...freshSimulationState('t').solver }, jpBase.horizon, 25)
  assert.deepEqual(checkGoal(jpBase, goal, handed.closes, priceDomain(NO_CONSTRAINTS)), checkGoal(jpBase, goal, projection.closes, priceDomain(NO_CONSTRAINTS)), 'solver goal check identical on the handed path')

  // 11l. Source contract: suppression, labels, metadata, plain drafts unchanged.
  const view = stripComments(read('components/stock/sma-dynamics/SmaDynamicsView.tsx'))
  assert.match(view, /const comparedScenario = handoff && !handoffInScope && mode !== 'scenario' \? null : scenario/, 'out-of-scope inherited path is not compared')
  assert.match(view, /if \(handoffLabel && id === 'scenario'\) return handoffLabel\s*if \(handoffLabel && id === 'solver'\) return SOLVER_REPRESENTATIVE_PATH_LABEL/, 'chart / readout / legend labels distinguish the paths')
  assert.match(view, /comparisonOnChart=\{shows\('scenario'\) && overlayAvailable\.scenario\}/, 'solver hand-off copy follows the actual comparison overlay')
  assert.match(view, /solverOnChart=\{shows\('solver'\) && overlayAvailable\.solver\}/, 'solver hand-off copy follows the actual solver overlay')
  assert.match(view, /const analysis = analyzeSolverGoal\(base, goal, parsedConstraints\.constraints\)/, 'solver mathematics untouched')
  for (const field of ['candidateId:', 'label:', 'sourceOrigin:', 'timeframe: available.timeframe', 'horizon: base.horizon', 'asOfDate: available.asOf.date', 'sourceCloses: closes', 'inheritedCloses: evaluateScenario(base, written).closes']) {
    assert.ok(view.includes(field), `hand-off record keeps ${field}`)
  }
  assert.match(view, /\/\/ The draft now holds a solver path|if \(evidence\.handoff\) setEvidence\(\{ handoff: null \}\)/, 'copying a solver path ends the hand-off provenance')
  assert.match(view, /const evidence: EvidenceState = evidenceState\.identity === identity \? evidenceState : \{ identity, selectedId: null, direction: 'up', handoff: null \}/, 'identity scope drops a hand-off on another security / date')
  assert.match(view, /setEvidenceState\(\(current\) => current\.identity === identity[\s\S]*?\{ identity, selectedId: null, direction: 'up', handoff: null \}[\s\S]*?\}, \[identity\]\)/, 'identity changes persistently clear old evidence so JP -> US -> JP cannot revive a stale hand-off')
  // Plain drafts (no hand-off): no comparison callout and the original solver label.
  const fixture = findSmaDynamicsFixture('jp-rising')!
  for (const externalScenarios of [undefined, { candidates: jpSet.candidates, historyBasis: SMA_SCENARIO_FIXTURE_BASIS, securityPermanentId: { status: 'unavailable' as const, reason: 'x' }, calendarVersion: SMA_SCENARIO_FIXTURE_CALENDAR_VERSION }]) {
    const solverView = renderToStaticMarkup(createElement(SmaDynamicsView, {
      security: { market: fixture.market, ticker: fixture.ticker, name: fixture.name },
      analysisDate: fixture.analysisDate,
      load: { status: 'ready', rows: fixture.rows } as SmaDynamicsLoadState,
      dataSource: { label: 'テスト', priceBasis: '合成データ' },
      initialSettings: { ...SMA_DYNAMICS_DEFAULT_SETTINGS, analysis: 'solver' },
      externalScenarios,
    }))
    assert.doesNotMatch(solverView, /data-sma-solver-handoff|比較経路：|逆算による代表経路/, 'plain solver view unchanged')
    assert.ok(solverView.includes(`仮定 (${SMA_LAB_OVERLAY_LABEL.solver})`), 'plain solver future label unchanged')
  }
}

console.log('SMA Dynamics Phase 3B scenario evidence tests passed.')
