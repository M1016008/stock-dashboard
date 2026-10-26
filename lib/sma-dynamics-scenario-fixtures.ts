// Synthetic, deterministic scenario-evidence fixtures for Phase 3B tests and the dev preview.
// Identities, as-of dates, reference closes and bar dates come from the synthetic price
// fixtures and the lab calendar only. No model, database, API or market data is read.
import type { SmaDynamicsMarket } from '@/lib/sma-dynamics'
import { computeSmaLab } from '@/lib/sma-dynamics-lab'
import { findSmaDynamicsFixture, fixtureSessionDates } from '@/lib/sma-dynamics-fixtures'
import {
  SCENARIO_EVIDENCE_SCHEMA_VERSION,
  SCENARIO_TEMPLATES,
  type ScenarioDirection,
  type ScenarioEvidenceCandidate,
  type ScenarioEvidenceEnvelope,
  type ScenarioOrigin,
  type ScenarioPriceBasis,
  type ScenarioTemplateId,
} from '@/lib/sma-dynamics-scenario-evidence'
import { futureBuckets, smaLabCalendar, smaLabTimeframe, type SmaLabTimeframeId } from '@/lib/sma-dynamics-timeframes'

/** Basis declared by the synthetic price fixtures (the preview's history source). */
export const SMA_SCENARIO_FIXTURE_BASIS: ScenarioPriceBasis = { kind: 'split_adjusted', adjustmentRevision: 'synthetic-fixture-v1' }
export const SMA_SCENARIO_FIXTURE_CALENDAR_VERSION = 'sma-lab-calendar-synthetic-v1'
export const SMA_SCENARIO_FIXTURE_RULE_VERSION = 'template-rules-synthetic-v1'
export const SMA_SCENARIO_TEMPLATE_HORIZON = 10
/** Normalized template weights per market (sum 100). Synthetic; not probabilities. */
const TEMPLATE_WEIGHTS: Record<ScenarioTemplateId, number> = {
  continuation: 18, rebound: 12, squeeze_breakout: 9, breakdown: 14, pullback_fail: 10, overheat_reversal: 8, range: 17, support_rebound: 12,
}

/** Percent change from the reference close at t = k / H (0 < t ≤ 1). Piecewise-linear, deterministic. */
const TEMPLATE_SHAPES: Record<ScenarioTemplateId, (t: number, k: number) => number> = {
  continuation: (t) => 6 * t,
  rebound: (t) => (t <= 0.2 ? -2.5 * (t / 0.2) : -2.5 + 8 * ((t - 0.2) / 0.8)),
  squeeze_breakout: (t, k) => (t <= 0.5 ? (k % 2 === 0 ? 0.3 : -0.3) : 0.3 + 8.7 * ((t - 0.5) / 0.5)),
  breakdown: (t) => (t <= 0.3 ? -0.5 * (t / 0.3) : -0.5 - 7.5 * ((t - 0.3) / 0.7)),
  pullback_fail: (t) => (t <= 0.4 ? 3 * (t / 0.4) : 3 - 8 * ((t - 0.4) / 0.6)),
  overheat_reversal: (t) => (t <= 0.2 ? 2 * (t / 0.2) : 2 - 9 * ((t - 0.2) / 0.8)),
  range: (t) => 1.5 * Math.sin(3 * Math.PI * t),
  support_rebound: (t) => (t <= 0.5 ? -3 * (t / 0.5) : -3 + 2.5 * ((t - 0.5) / 0.5)),
}

interface Anchor {
  market: SmaDynamicsMarket
  ticker: string
  asOfDate: string
  referenceClose: number
  decimals: number
}

function anchorFor(priceFixtureId: string): Anchor {
  const fixture = findSmaDynamicsFixture(priceFixtureId)
  if (!fixture) throw new Error(`unknown price fixture ${priceFixtureId}`)
  const result = computeSmaLab({ rows: fixture.rows, market: fixture.market, timeframe: '1D', horizon: 1, analysisDate: fixture.analysisDate })
  if (result.status !== 'available') throw new Error(`price fixture ${priceFixtureId} unavailable`)
  return { market: fixture.market, ticker: fixture.ticker, asOfDate: result.asOf.date, referenceClose: result.asOf.close, decimals: fixture.market === 'US' ? 2 : 1 }
}

/** Closing session of each future bar on the lab calendar (same buckets as the lab projection). */
export function fixtureFutureSessions(market: SmaDynamicsMarket, asOfDate: string, timeframe: SmaLabTimeframeId, count: number): string[] {
  return futureBuckets(smaLabCalendar(market), smaLabTimeframe(timeframe).spec, asOfDate, count).map((bucket) => bucket.sessions.at(-1)!)
}

function round(value: number, decimals: number): number {
  const scale = 10 ** decimals
  return Math.round(value * scale) / scale
}

function shapedCloses(anchor: Anchor, shape: (t: number, k: number) => number, count: number): number[] {
  return Array.from({ length: count }, (_, i) => round(anchor.referenceClose * (1 + shape((i + 1) / count, i + 1) / 100), anchor.decimals))
}

function envelope(anchor: Anchor, args: {
  origin: ScenarioOrigin
  direction: ScenarioDirection | null
  claim: ScenarioEvidenceEnvelope['quantitativeClaim']
  timeframe?: SmaLabTimeframeId
  horizon?: number
  closes: number[] | null
  pathUnavailableReason?: string
}): ScenarioEvidenceEnvelope {
  const timeframe = args.timeframe ?? '1D'
  const horizon = args.horizon ?? SMA_SCENARIO_TEMPLATE_HORIZON
  const sessions = args.closes ? fixtureFutureSessions(anchor.market, anchor.asOfDate, timeframe, args.closes.length) : []
  return {
    schemaVersion: SCENARIO_EVIDENCE_SCHEMA_VERSION,
    identity: { market: anchor.market, symbol: anchor.ticker, permanentId: { status: 'unavailable', reason: '合成Fixtureには恒久IDがありません' } },
    asOfDate: anchor.asOfDate,
    origin: args.origin,
    direction: args.direction ? { status: 'available', value: args.direction } : { status: 'unavailable', reason: '方向の情報なし' },
    quantitativeClaim: args.claim,
    forecastHorizonBars: horizon,
    forecastTimeframe: timeframe,
    predictionReferencePrice: anchor.referenceClose,
    priceBasis: SMA_SCENARIO_FIXTURE_BASIS,
    futureClosePath: args.closes
      ? { status: 'available', value: args.closes.map((close, i) => ({ bar: i + 1, dateOrPeriod: sessions[i], close })) }
      : { status: 'unavailable', reason: args.pathUnavailableReason ?? '経路の提供なし' },
    futurePriceRange: { status: 'unavailable', reason: '価格レンジの提供なし' },
    historicalOhlc: { availableThrough: anchor.asOfDate, completeness: 'complete', sourceProvenance: '合成Fixture (lib/sma-dynamics-fixtures)' },
    calendar: { id: smaLabCalendar(anchor.market).id, version: SMA_SCENARIO_FIXTURE_CALENDAR_VERSION },
    dataCompleteness: 'complete',
  }
}

export function templateEnvelope(priceFixtureId: string, templateId: ScenarioTemplateId, options: { timeframe?: SmaLabTimeframeId; horizon?: number } = {}): ScenarioEvidenceEnvelope {
  const anchor = anchorFor(priceFixtureId)
  const template = SCENARIO_TEMPLATES.find((item) => item.id === templateId)!
  const horizon = options.horizon ?? SMA_SCENARIO_TEMPLATE_HORIZON
  return envelope(anchor, {
    origin: { kind: 'deterministic_template', templateId, ruleVersion: SMA_SCENARIO_FIXTURE_RULE_VERSION },
    direction: template.direction,
    claim: { status: 'available', value: { kind: 'normalized_template_weight', valuePct: TEMPLATE_WEIGHTS[templateId] } },
    timeframe: options.timeframe,
    horizon,
    closes: shapedCloses(anchor, TEMPLATE_SHAPES[templateId], horizon),
  })
}

export function classificationOnlyEnvelope(priceFixtureId: string, direction: ScenarioDirection, score: number): ScenarioEvidenceEnvelope {
  return envelope(anchorFor(priceFixtureId), {
    origin: { kind: 'model_classification', modelVersion: 'synthetic-physics-classifier-v0' },
    direction,
    claim: { status: 'available', value: { kind: 'raw_model_score', value: score } },
    closes: null,
    pathUnavailableReason: 'モデルは方向スコアのみを出力し、価格経路を出しません',
  })
}

export function historicalAnalogEnvelope(priceFixtureId: string, direction: ScenarioDirection): ScenarioEvidenceEnvelope {
  const anchor = anchorFor(priceFixtureId)
  const sign = direction === 'down' ? -1 : 1
  return envelope(anchor, {
    origin: { kind: 'historical_analog', methodVersion: 'analog-median-synthetic-v1' },
    direction,
    claim: { status: 'available', value: { kind: 'cluster_weight', valuePct: 22 } },
    closes: shapedCloses(anchor, (t) => sign * (t <= 0.3 ? -0.8 * (t / 0.3) : -0.8 + 4.3 * ((t - 0.3) / 0.7)), SMA_SCENARIO_TEMPLATE_HORIZON),
  })
}

export interface ScenarioFixtureSet {
  priceFixtureId: string
  market: SmaDynamicsMarket
  ticker: string
  historyBasis: ScenarioPriceBasis
  candidates: ScenarioEvidenceCandidate[]
}

/** The normal picker: exactly the eight deterministic templates (3 up / 2 range / 3 down). */
function templateCandidates(priceFixtureId: string, prefix: string): ScenarioEvidenceCandidate[] {
  return SCENARIO_TEMPLATES.map((template) => ({ id: `${prefix}-template-${template.id}`, label: template.assumption, envelope: templateEnvelope(priceFixtureId, template.id), audience: 'standard' }))
}

const developer = (candidate: ScenarioEvidenceCandidate): ScenarioEvidenceCandidate => ({ ...candidate, audience: 'developer' })

/** Fail-closed examples, each differing from a valid template envelope in exactly one respect. */
function jpFailureCandidates(): ScenarioEvidenceCandidate[] {
  const id = 'jp-rising'
  const base = () => templateEnvelope(id, 'continuation')
  const anchor = anchorFor(id)
  const previousSession = fixtureSessionDates(anchor.market, anchor.asOfDate, 2)[0]
  const longSessions = fixtureFutureSessions(anchor.market, anchor.asOfDate, '1D', 90)
  const longCloses = shapedCloses(anchor, TEMPLATE_SHAPES.continuation, 90)
  const twelve = templateEnvelope(id, 'continuation', { horizon: 12 })
  const invalid = base()
  const name = SCENARIO_TEMPLATES[0].assumption
  return [
    { id: 'jp-weekly-native', label: `${name} ・ 検証用: 週足で作成`, envelope: templateEnvelope(id, 'continuation', { timeframe: '1W', horizon: 5 }) },
    { id: 'jp-mismatch-market', label: `${name} ・ 検証用: 市場違い`, envelope: { ...base(), identity: { ...base().identity, market: 'US' } } },
    { id: 'jp-mismatch-ticker', label: `${name} ・ 検証用: 銘柄違い`, envelope: { ...base(), identity: { ...base().identity, symbol: 'FXJ9' } } },
    { id: 'jp-mismatch-asof', label: `${name} ・ 検証用: 基準日違い`, envelope: { ...base(), asOfDate: previousSession, historicalOhlc: { ...base().historicalOhlc, availableThrough: previousSession } } },
    { id: 'jp-mismatch-basis', label: `${name} ・ 検証用: 価格基準違い`, envelope: { ...base(), priceBasis: { kind: 'raw_as_traded' } } },
    { id: 'jp-mismatch-horizon', label: `${name} ・ 検証用: 本数と経路の不一致`, envelope: { ...base(), futureClosePath: twelve.futureClosePath } },
    {
      id: 'jp-invalid-path',
      label: `${name} ・ 検証用: 不正な終値`,
      envelope: {
        ...invalid,
        futureClosePath: invalid.futureClosePath.status === 'available'
          ? { status: 'available', value: invalid.futureClosePath.value.map((point) => (point.bar === 4 ? { ...point, close: -1 } : point)) }
          : invalid.futureClosePath,
      },
    },
    {
      id: 'jp-long-horizon',
      label: `${name} ・ 検証用: 90本 (対応外)`,
      envelope: {
        ...base(),
        forecastHorizonBars: 90,
        futureClosePath: { status: 'available', value: longCloses.map((close, i) => ({ bar: i + 1, dateOrPeriod: longSessions[i], close })) },
      },
    },
  ].map(developer)
}

export function buildScenarioFixtureSets(): ScenarioFixtureSet[] {
  const jp = anchorFor('jp-rising')
  const us = anchorFor('us-falling')
  return [
    {
      priceFixtureId: 'jp-rising',
      market: jp.market,
      ticker: jp.ticker,
      historyBasis: SMA_SCENARIO_FIXTURE_BASIS,
      candidates: [
        ...templateCandidates('jp-rising', 'jp'),
        developer({ id: 'jp-analog', label: '過去の類似ケース (中央値)', envelope: historicalAnalogEnvelope('jp-rising', 'up') }),
        developer({ id: 'jp-classification', label: '方向分類モデル', envelope: classificationOnlyEnvelope('jp-rising', 'up', 0.62) }),
        ...jpFailureCandidates(),
      ],
    },
    {
      priceFixtureId: 'us-falling',
      market: us.market,
      ticker: us.ticker,
      historyBasis: SMA_SCENARIO_FIXTURE_BASIS,
      candidates: [
        ...templateCandidates('us-falling', 'us'),
        developer({ id: 'us-analog', label: '過去の類似ケース (中央値)', envelope: historicalAnalogEnvelope('us-falling', 'down') }),
        developer({ id: 'us-classification', label: '方向分類モデル', envelope: classificationOnlyEnvelope('us-falling', 'down', 0.41) }),
      ],
    },
  ]
}

let cachedSets: ScenarioFixtureSet[] | null = null

/** Built on first use so importing the module stays cheap. */
export function scenarioFixtureSet(priceFixtureId: string): ScenarioFixtureSet | null {
  cachedSets ??= buildScenarioFixtureSets()
  return cachedSets.find((set) => set.priceFixtureId === priceFixtureId) ?? null
}
