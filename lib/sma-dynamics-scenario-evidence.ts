// SMA Dynamics Lab Phase 3B: provenance-first scenario evidence → SMA projection.
//
// A scenario reaches the SMA engine only through this file:
//   ScenarioEvidenceEnvelope (unknown input)
//     -> parse (structure) -> semantic checks (origin / claim / completeness / path)
//     -> context checks (market, ticker, as-of, reference close, price basis,
//        calendar, timeframe, horizon, per-bar closing session)
//     -> explicit close path -> projectAllSma (= projectSmaPath, unchanged)
//
// Everything fails closed: any issue rejects the envelope. A classification-only
// output never yields a path, and no path is ever converted between timeframes.
// Quantitative claims stay a discriminated union so a template weight can never be
// rendered through a generic "probability" field.
import { isIsoCalendarDate, type SmaDynamicsMarket } from '@/lib/sma-dynamics'
import { smaLabHorizonOptions, type SmaLabAvailable, type SmaLabSeries } from '@/lib/sma-dynamics-lab'
import { cleanFloat, projectAllSma, type ForwardBase, type ScenarioEvaluation } from '@/lib/sma-dynamics-scenario'
import { isSmaLabTimeframeId, smaLabTimeframe, type SmaLabTimeframeId } from '@/lib/sma-dynamics-timeframes'

export const SCENARIO_EVIDENCE_SCHEMA_VERSION = 'phase3b-v1'

export type ScenarioDirection = 'up' | 'range' | 'down'
export const SCENARIO_DIRECTIONS: readonly ScenarioDirection[] = ['up', 'range', 'down']

export type Availability<T> =
  | { status: 'available'; value: T }
  | { status: 'unavailable'; reason: string }

export interface SecurityIdentity {
  market: SmaDynamicsMarket
  symbol: string
  permanentId: Availability<string>
}

export type ScenarioPriceBasis =
  | { kind: 'raw_as_traded'; corporateActionRevision?: string }
  | { kind: 'split_adjusted'; adjustmentRevision?: string }
  | { kind: 'vendor_adjusted'; vendor: string; dividendPolicy: 'included' | 'excluded' | 'unknown' }
  | { kind: 'unknown'; reason: string }

export type QuantitativeClaim =
  | { kind: 'calibrated_class_probability'; valuePct: number; calibrationVersion: string }
  | { kind: 'raw_model_score'; value: number }
  | { kind: 'normalized_template_weight'; valuePct: number }
  | { kind: 'cluster_weight'; valuePct: number }
export type QuantitativeClaimKind = QuantitativeClaim['kind']
export const QUANTITATIVE_CLAIM_KINDS: readonly QuantitativeClaimKind[] = [
  'calibrated_class_probability',
  'raw_model_score',
  'normalized_template_weight',
  'cluster_weight',
]

export type ScenarioOrigin =
  | { kind: 'deterministic_template'; templateId: ScenarioTemplateId; ruleVersion: string }
  | { kind: 'model_classification'; modelVersion: string }
  | { kind: 'model_path_distribution'; modelVersion: string }
  | { kind: 'historical_analog'; methodVersion: string }
  | { kind: 'explanatory_synthetic'; ruleVersion: string }
  | { kind: 'user_input' }
  | { kind: 'price_freeze' }
  | { kind: 'inverse_solver_result'; solverVersion: string }
export type ScenarioOriginKind = ScenarioOrigin['kind']
export const SCENARIO_ORIGIN_KINDS: readonly ScenarioOriginKind[] = [
  'deterministic_template',
  'model_classification',
  'model_path_distribution',
  'historical_analog',
  'explanatory_synthetic',
  'user_input',
  'price_freeze',
  'inverse_solver_result',
]

/** Which claim may accompany which origin. Anything else is rejected, never relabeled. */
export const ORIGIN_ALLOWED_CLAIMS: Record<ScenarioOriginKind, readonly QuantitativeClaimKind[]> = {
  deterministic_template: ['normalized_template_weight'],
  model_classification: ['calibrated_class_probability', 'raw_model_score'],
  model_path_distribution: ['calibrated_class_probability', 'cluster_weight'],
  historical_analog: ['cluster_weight'],
  explanatory_synthetic: [],
  user_input: [],
  price_freeze: [],
  inverse_solver_result: [],
}

/**
 * The eight templates of the visible scenario chart (3 up, 3 down, 2 range).
 * `label` is the source chart's name (traceability only, shown in details). `assumption`
 * and `shape` are the user-facing copy: they name the assumed price movement and never
 * imply support/resistance evidence, likelihood or a recommendation.
 */
export const SCENARIO_TEMPLATES = [
  { id: 'continuation', direction: 'up', label: '上昇継続', assumption: '上がり続ける仮定', shape: 'ほぼ一定のペースで上がり続ける' },
  { id: 'rebound', direction: 'up', label: '支持線反発', assumption: '下げてから上がる仮定', shape: '最初の数本で小さく下げ、その後上がる' },
  { id: 'squeeze_breakout', direction: 'up', label: '収縮後上放れ', assumption: '小動きの後に上がる仮定', shape: '前半は小幅に上下し、後半に上がる' },
  { id: 'breakdown', direction: 'down', label: '下落転換', assumption: '下げに転じる仮定', shape: '小さく下げた後、下げ幅が広がる' },
  { id: 'pullback_fail', direction: 'down', label: '戻り売り優勢', assumption: '上げた後に下げる仮定', shape: '前半に上がり、後半はそれ以上に下げる' },
  { id: 'overheat_reversal', direction: 'down', label: '過熱反落', assumption: '短く上げて大きく下げる仮定', shape: '最初の数本で上がり、その後大きく下げる' },
  { id: 'range', direction: 'range', label: '横ばいレンジ', assumption: '横ばいが続く仮定', shape: '基準日の終値の上下を小さく往復する' },
  { id: 'support_rebound', direction: 'range', label: '支持線維持', assumption: '下げて少し戻す仮定', shape: '前半に下げ、後半に下げ幅の大半を戻す' },
] as const satisfies ReadonlyArray<{ id: string; direction: ScenarioDirection; label: string; assumption: string; shape: string }>
export type ScenarioTemplateId = (typeof SCENARIO_TEMPLATES)[number]['id']

/** Shown beside the template list: order and count carry no meaning about likelihood. */
export const SCENARIO_TEMPLATE_LIST_NOTE = 'どれも説明用にルールで作った仮定の経路です。並び順や件数は起こりやすさを表しません。'

export function scenarioTemplate(id: string) {
  return SCENARIO_TEMPLATES.find((template) => template.id === id) ?? null
}

export interface FutureClosePoint {
  /** 1-based bar after the as-of bar, on forecastTimeframe. */
  bar: number
  /** Closing session of that bar (YYYY-MM-DD). */
  dateOrPeriod: string
  close: number
}

export interface ScenarioEvidenceEnvelope {
  schemaVersion: typeof SCENARIO_EVIDENCE_SCHEMA_VERSION
  identity: SecurityIdentity
  asOfDate: string
  origin: ScenarioOrigin
  direction: Availability<ScenarioDirection>
  quantitativeClaim: Availability<QuantitativeClaim>
  forecastHorizonBars: number
  forecastTimeframe: SmaLabTimeframeId
  predictionReferencePrice: number
  priceBasis: ScenarioPriceBasis
  futureClosePath: Availability<readonly FutureClosePoint[]>
  futurePriceRange: Availability<{ low: number; high: number; asOfBar: number }>
  historicalOhlc: {
    availableThrough: string
    completeness: 'complete' | 'partial' | 'unknown'
    sourceProvenance: string
  }
  calendar: { id: string; version: string }
  dataCompleteness: 'complete' | 'partial' | 'insufficient'
}

// ---------------------------------------------------------------------------
// Issues

export type ScenarioEvidenceIssueCode =
  | 'malformed'
  | 'schema_version'
  | 'provenance_missing'
  | 'template_unknown'
  | 'claim_not_allowed'
  | 'claim_out_of_range'
  | 'direction_mismatch'
  | 'classification_with_path'
  | 'history_incomplete'
  | 'history_through_mismatch'
  | 'data_incomplete'
  | 'range_invalid'
  | 'path_length'
  | 'path_bar_sequence'
  | 'path_close_invalid'
  | 'path_freeze_mismatch'
  | 'horizon_unsupported'
  | 'market_mismatch'
  | 'ticker_mismatch'
  | 'permanent_identity_mismatch'
  | 'as_of_mismatch'
  | 'reference_price_mismatch'
  | 'price_basis_unknown'
  | 'price_basis_mismatch'
  | 'calendar_mismatch'
  | 'calendar_version_mismatch'
  | 'timeframe_mismatch'
  | 'horizon_mismatch'
  | 'path_date_mismatch'

export interface ScenarioEvidenceIssue {
  code: ScenarioEvidenceIssueCode
  field: string
  detail?: string
}

/** Issues the user can resolve by changing the view (never by converting the path). */
export const VIEW_ALIGNABLE_ISSUES: readonly ScenarioEvidenceIssueCode[] = ['timeframe_mismatch', 'horizon_mismatch']

export const SCENARIO_ISSUE_TEXT: Record<ScenarioEvidenceIssueCode, string> = {
  malformed: 'データ形式が正しくありません',
  schema_version: '形式のバージョンが対応外です',
  provenance_missing: '由来 (ルール・モデル・手法のバージョン) が不明です',
  template_unknown: '既知の8テンプレートに含まれません',
  claim_not_allowed: 'この由来には付けられない数値が含まれています',
  claim_out_of_range: '数値が範囲外です',
  direction_mismatch: '方向がテンプレートと一致しません',
  classification_with_path: '方向分類のみのモデルに価格経路が付いています',
  history_incomplete: '過去データが完全ではありません',
  history_through_mismatch: '過去データの最終日が基準日と一致しません',
  data_incomplete: 'データが不完全です',
  range_invalid: '価格レンジが不正です',
  path_length: '経路の本数が対象本数と一致しません',
  path_bar_sequence: '経路の足番号が連続していません',
  path_close_invalid: '経路に0以下または数値でない終値があります',
  path_freeze_mismatch: '価格固定なのに終値が基準日の終値と異なります',
  horizon_unsupported: 'この時間軸では扱えない本数です',
  market_mismatch: '市場が一致しません',
  ticker_mismatch: '銘柄が一致しません',
  permanent_identity_mismatch: '恒久銘柄IDが一致しないか、照合できません',
  as_of_mismatch: '基準日が一致しません',
  reference_price_mismatch: '基準日の終値が一致しません',
  price_basis_unknown: '価格の基準 (調整方法) が不明です',
  price_basis_mismatch: '価格の基準 (調整方法) が表示中の履歴と異なります',
  calendar_mismatch: '取引カレンダーが一致しません',
  calendar_version_mismatch: '取引カレンダーの版が一致しません',
  timeframe_mismatch: '時間軸が表示中と異なります (自動変換はしません)',
  horizon_mismatch: '本数が表示中と異なります',
  path_date_mismatch: '経路の日付が取引カレンダーの足と一致しません',
}

// ---------------------------------------------------------------------------
// Structural parse of unknown input

type Parsed = { ok: true; envelope: ScenarioEvidenceEnvelope } | { ok: false; issues: ScenarioEvidenceIssue[] }

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
const isText = (value: unknown): value is string => typeof value === 'string'
const isNonEmpty = (value: unknown): value is string => typeof value === 'string' && value.trim() !== ''
const isNumber = (value: unknown): value is number => typeof value === 'number'

function parseAvailability<T>(value: unknown, field: string, issues: ScenarioEvidenceIssue[], inner: (value: unknown) => T | null): Availability<T> | null {
  if (!isRecord(value)) { issues.push({ code: 'malformed', field }); return null }
  if (value.status === 'unavailable') {
    if (!isText(value.reason)) { issues.push({ code: 'malformed', field: `${field}.reason` }); return null }
    return { status: 'unavailable', reason: value.reason }
  }
  if (value.status !== 'available') { issues.push({ code: 'malformed', field: `${field}.status` }); return null }
  const parsed = inner(value.value)
  if (parsed == null) { issues.push({ code: 'malformed', field: `${field}.value` }); return null }
  return { status: 'available', value: parsed }
}

function parseOrigin(value: unknown): ScenarioOrigin | null {
  if (!isRecord(value) || !isText(value.kind)) return null
  const kind = value.kind as ScenarioOriginKind
  switch (kind) {
    case 'deterministic_template':
      return isText(value.templateId) && isText(value.ruleVersion) ? { kind, templateId: value.templateId as ScenarioTemplateId, ruleVersion: value.ruleVersion } : null
    case 'model_classification':
    case 'model_path_distribution':
      return isText(value.modelVersion) ? { kind, modelVersion: value.modelVersion } : null
    case 'historical_analog':
      return isText(value.methodVersion) ? { kind, methodVersion: value.methodVersion } : null
    case 'explanatory_synthetic':
      return isText(value.ruleVersion) ? { kind, ruleVersion: value.ruleVersion } : null
    case 'user_input':
    case 'price_freeze':
      return { kind }
    case 'inverse_solver_result':
      return isText(value.solverVersion) ? { kind, solverVersion: value.solverVersion } : null
    default: {
      const unknownKind: never = kind
      void unknownKind
      return null
    }
  }
}

function parseClaim(value: unknown): QuantitativeClaim | null {
  if (!isRecord(value) || !isText(value.kind)) return null
  const kind = value.kind as QuantitativeClaimKind
  switch (kind) {
    case 'calibrated_class_probability':
      return isNumber(value.valuePct) && isText(value.calibrationVersion) ? { kind, valuePct: value.valuePct, calibrationVersion: value.calibrationVersion } : null
    case 'raw_model_score':
      return isNumber(value.value) ? { kind, value: value.value } : null
    case 'normalized_template_weight':
    case 'cluster_weight':
      return isNumber(value.valuePct) ? { kind, valuePct: value.valuePct } : null
    default: {
      const unknownKind: never = kind
      void unknownKind
      return null
    }
  }
}

function parseBasis(value: unknown): ScenarioPriceBasis | null {
  if (!isRecord(value)) return null
  const optionalText = (raw: unknown) => raw === undefined || isText(raw)
  switch (value.kind) {
    case 'raw_as_traded':
      return optionalText(value.corporateActionRevision) ? { kind: 'raw_as_traded', ...(isText(value.corporateActionRevision) ? { corporateActionRevision: value.corporateActionRevision } : {}) } : null
    case 'split_adjusted':
      return optionalText(value.adjustmentRevision) ? { kind: 'split_adjusted', ...(isText(value.adjustmentRevision) ? { adjustmentRevision: value.adjustmentRevision } : {}) } : null
    case 'vendor_adjusted':
      return isText(value.vendor) && (value.dividendPolicy === 'included' || value.dividendPolicy === 'excluded' || value.dividendPolicy === 'unknown')
        ? { kind: 'vendor_adjusted', vendor: value.vendor, dividendPolicy: value.dividendPolicy }
        : null
    case 'unknown':
      return isText(value.reason) ? { kind: 'unknown', reason: value.reason } : null
    default:
      return null
  }
}

function parsePath(value: unknown): FutureClosePoint[] | null {
  if (!Array.isArray(value)) return null
  const out: FutureClosePoint[] = []
  for (const point of value) {
    // Close values are checked semantically (finite, positive) so they report a precise issue.
    if (!isRecord(point) || !isNumber(point.bar) || !isText(point.dateOrPeriod) || !isNumber(point.close)) return null
    out.push({ bar: point.bar, dateOrPeriod: point.dateOrPeriod, close: point.close })
  }
  return out
}

export function parseScenarioEvidence(input: unknown): Parsed {
  const issues: ScenarioEvidenceIssue[] = []
  if (!isRecord(input)) return { ok: false, issues: [{ code: 'malformed', field: 'envelope' }] }
  if (input.schemaVersion !== SCENARIO_EVIDENCE_SCHEMA_VERSION) return { ok: false, issues: [{ code: 'schema_version', field: 'schemaVersion', detail: String(input.schemaVersion) }] }

  const identityRaw = input.identity
  let identity: SecurityIdentity | null = null
  if (isRecord(identityRaw) && (identityRaw.market === 'JP' || identityRaw.market === 'US') && isText(identityRaw.symbol)) {
    const permanentId = parseAvailability(identityRaw.permanentId, 'identity.permanentId', issues, (value) => (isText(value) ? value : null))
    if (permanentId) identity = { market: identityRaw.market, symbol: identityRaw.symbol, permanentId }
  } else {
    issues.push({ code: 'malformed', field: 'identity' })
  }

  const origin = parseOrigin(input.origin)
  if (!origin) issues.push({ code: 'malformed', field: 'origin' })
  const direction = parseAvailability(input.direction, 'direction', issues, (value) => (SCENARIO_DIRECTIONS.includes(value as ScenarioDirection) ? (value as ScenarioDirection) : null))
  const quantitativeClaim = parseAvailability(input.quantitativeClaim, 'quantitativeClaim', issues, parseClaim)
  const futureClosePath = parseAvailability(input.futureClosePath, 'futureClosePath', issues, parsePath)
  const futurePriceRange = parseAvailability(input.futurePriceRange, 'futurePriceRange', issues, (value) =>
    isRecord(value) && isNumber(value.low) && isNumber(value.high) && isNumber(value.asOfBar) ? { low: value.low, high: value.high, asOfBar: value.asOfBar } : null)
  const priceBasis = parseBasis(input.priceBasis)
  if (!priceBasis) issues.push({ code: 'malformed', field: 'priceBasis' })

  if (!isIsoCalendarDate(input.asOfDate)) issues.push({ code: 'malformed', field: 'asOfDate' })
  if (!isNumber(input.forecastHorizonBars)) issues.push({ code: 'malformed', field: 'forecastHorizonBars' })
  if (!isSmaLabTimeframeId(input.forecastTimeframe)) issues.push({ code: 'malformed', field: 'forecastTimeframe' })
  if (!isNumber(input.predictionReferencePrice)) issues.push({ code: 'malformed', field: 'predictionReferencePrice' })

  const history = input.historicalOhlc
  const historyOk = isRecord(history) && isIsoCalendarDate(history.availableThrough)
    && (history.completeness === 'complete' || history.completeness === 'partial' || history.completeness === 'unknown')
    && isText(history.sourceProvenance)
  if (!historyOk) issues.push({ code: 'malformed', field: 'historicalOhlc' })
  const calendar = input.calendar
  const calendarOk = isRecord(calendar) && isText(calendar.id) && isText(calendar.version)
  if (!calendarOk) issues.push({ code: 'malformed', field: 'calendar' })
  const completeness = input.dataCompleteness
  if (completeness !== 'complete' && completeness !== 'partial' && completeness !== 'insufficient') issues.push({ code: 'malformed', field: 'dataCompleteness' })

  if (issues.length > 0 || !identity || !origin || !direction || !quantitativeClaim || !futureClosePath || !futurePriceRange || !priceBasis || !historyOk || !calendarOk) {
    return { ok: false, issues }
  }
  return {
    ok: true,
    envelope: {
      schemaVersion: SCENARIO_EVIDENCE_SCHEMA_VERSION,
      identity,
      asOfDate: input.asOfDate as string,
      origin,
      direction,
      quantitativeClaim,
      forecastHorizonBars: input.forecastHorizonBars as number,
      forecastTimeframe: input.forecastTimeframe as SmaLabTimeframeId,
      predictionReferencePrice: input.predictionReferencePrice as number,
      priceBasis,
      futureClosePath,
      futurePriceRange,
      historicalOhlc: { availableThrough: history.availableThrough as string, completeness: history.completeness as 'complete' | 'partial' | 'unknown', sourceProvenance: history.sourceProvenance as string },
      calendar: { id: calendar.id as string, version: calendar.version as string },
      dataCompleteness: completeness as ScenarioEvidenceEnvelope['dataCompleteness'],
    },
  }
}

// ---------------------------------------------------------------------------
// Semantic checks (no context needed)

function originVersion(origin: ScenarioOrigin): string | null {
  switch (origin.kind) {
    case 'deterministic_template': return origin.ruleVersion
    case 'model_classification':
    case 'model_path_distribution': return origin.modelVersion
    case 'historical_analog': return origin.methodVersion
    case 'explanatory_synthetic': return origin.ruleVersion
    case 'inverse_solver_result': return origin.solverVersion
    case 'user_input':
    case 'price_freeze': return null
  }
}

const isPct = (value: number) => Number.isFinite(value) && value >= 0 && value <= 100

function claimIssues(claim: QuantitativeClaim): ScenarioEvidenceIssue[] {
  switch (claim.kind) {
    case 'calibrated_class_probability':
      if (!isNonEmpty(claim.calibrationVersion)) return [{ code: 'provenance_missing', field: 'quantitativeClaim.calibrationVersion' }]
      return isPct(claim.valuePct) ? [] : [{ code: 'claim_out_of_range', field: 'quantitativeClaim.valuePct' }]
    case 'raw_model_score':
      return Number.isFinite(claim.value) ? [] : [{ code: 'claim_out_of_range', field: 'quantitativeClaim.value' }]
    case 'normalized_template_weight':
    case 'cluster_weight':
      return isPct(claim.valuePct) ? [] : [{ code: 'claim_out_of_range', field: 'quantitativeClaim.valuePct' }]
  }
}

function semanticIssues(envelope: ScenarioEvidenceEnvelope): ScenarioEvidenceIssue[] {
  const issues: ScenarioEvidenceIssue[] = []
  const { origin } = envelope
  const version = originVersion(origin)
  if (version != null && !isNonEmpty(version)) issues.push({ code: 'provenance_missing', field: 'origin' })
  if (!isNonEmpty(envelope.historicalOhlc.sourceProvenance)) issues.push({ code: 'provenance_missing', field: 'historicalOhlc.sourceProvenance' })
  if (!isNonEmpty(envelope.calendar.version)) issues.push({ code: 'provenance_missing', field: 'calendar.version' })

  if (origin.kind === 'deterministic_template') {
    const template = scenarioTemplate(origin.templateId)
    if (!template) issues.push({ code: 'template_unknown', field: 'origin.templateId', detail: origin.templateId })
    else if (envelope.direction.status !== 'available' || envelope.direction.value !== template.direction) {
      issues.push({ code: 'direction_mismatch', field: 'direction', detail: template.direction })
    }
  }

  if (envelope.quantitativeClaim.status === 'available') {
    const claim = envelope.quantitativeClaim.value
    if (!ORIGIN_ALLOWED_CLAIMS[origin.kind].includes(claim.kind)) issues.push({ code: 'claim_not_allowed', field: 'quantitativeClaim', detail: `${origin.kind}:${claim.kind}` })
    else issues.push(...claimIssues(claim))
  }

  if (envelope.historicalOhlc.completeness !== 'complete') issues.push({ code: 'history_incomplete', field: 'historicalOhlc.completeness', detail: envelope.historicalOhlc.completeness })
  if (envelope.historicalOhlc.availableThrough !== envelope.asOfDate) issues.push({ code: 'history_through_mismatch', field: 'historicalOhlc.availableThrough' })
  if (envelope.dataCompleteness !== 'complete') issues.push({ code: 'data_incomplete', field: 'dataCompleteness', detail: envelope.dataCompleteness })

  const horizon = envelope.forecastHorizonBars
  if (!Number.isInteger(horizon) || !smaLabHorizonOptions(envelope.forecastTimeframe).includes(horizon)) {
    issues.push({ code: 'horizon_unsupported', field: 'forecastHorizonBars', detail: String(horizon) })
  }
  if (!(Number.isFinite(envelope.predictionReferencePrice) && envelope.predictionReferencePrice > 0)) {
    issues.push({ code: 'reference_price_mismatch', field: 'predictionReferencePrice' })
  }

  if (envelope.futurePriceRange.status === 'available') {
    const { low, high, asOfBar } = envelope.futurePriceRange.value
    if (!(Number.isFinite(low) && Number.isFinite(high) && low > 0 && low <= high && Number.isInteger(asOfBar) && asOfBar >= 1 && asOfBar <= horizon)) {
      issues.push({ code: 'range_invalid', field: 'futurePriceRange' })
    }
  }

  const path = envelope.futureClosePath
  if (origin.kind === 'model_classification' && path.status === 'available') {
    issues.push({ code: 'classification_with_path', field: 'futureClosePath' })
  } else if (path.status === 'available') {
    const points = path.value
    if (points.length !== horizon) issues.push({ code: 'path_length', field: 'futureClosePath', detail: `${points.length}/${horizon}` })
    if (points.some((point, index) => point.bar !== index + 1)) issues.push({ code: 'path_bar_sequence', field: 'futureClosePath' })
    if (points.some((point) => !(Number.isFinite(point.close) && point.close > 0))) issues.push({ code: 'path_close_invalid', field: 'futureClosePath' })
    if (points.some((point) => !isIsoCalendarDate(point.dateOrPeriod))) issues.push({ code: 'path_date_mismatch', field: 'futureClosePath' })
    if (origin.kind === 'price_freeze' && points.some((point) => point.close !== envelope.predictionReferencePrice)) {
      issues.push({ code: 'path_freeze_mismatch', field: 'futureClosePath' })
    }
  }
  return issues
}

// ---------------------------------------------------------------------------
// Context checks

export interface ScenarioValidationContext {
  market: SmaDynamicsMarket
  ticker: string
  permanentId: Availability<string>
  asOfDate: string
  referenceClose: number
  /** Machine-readable basis of the history shown in the lab. Unknown always fails closed. */
  priceBasis: ScenarioPriceBasis
  calendarId: string
  calendarVersion: string
  timeframe: SmaLabTimeframeId
  horizon: number
  /** Closing session of each future bar of the lab projection (k = index + 1). */
  futureSessions: readonly string[]
}

export function scenarioValidationContext(
  result: SmaLabAvailable,
  security: { market: SmaDynamicsMarket; ticker: string; permanentId: Availability<string> },
  priceBasis: ScenarioPriceBasis,
  calendarVersion: string,
): ScenarioValidationContext {
  return {
    market: security.market,
    ticker: security.ticker,
    permanentId: security.permanentId,
    asOfDate: result.asOf.date,
    referenceClose: result.asOf.close,
    priceBasis,
    calendarId: result.calendar.id,
    calendarVersion,
    timeframe: result.timeframe,
    horizon: result.projection.bars.length,
    futureSessions: result.projection.bars.map((bar) => bar.lastSession),
  }
}

/** Exact field-by-field equality; any unknown side is never equal. */
export function samePriceBasis(a: ScenarioPriceBasis, b: ScenarioPriceBasis): boolean {
  if (a.kind === 'unknown' || b.kind === 'unknown') return false
  const keys = new Set([...Object.keys(a), ...Object.keys(b)])
  for (const key of keys) {
    if ((a as unknown as Record<string, unknown>)[key] !== (b as unknown as Record<string, unknown>)[key]) return false
  }
  return true
}

/** Relative tolerance for the reference close (binary noise only; no business tolerance). */
export const REFERENCE_PRICE_TOLERANCE = 1e-9

function contextIssues(envelope: ScenarioEvidenceEnvelope, context: ScenarioValidationContext): ScenarioEvidenceIssue[] {
  const issues: ScenarioEvidenceIssue[] = []
  if (envelope.identity.market !== context.market) issues.push({ code: 'market_mismatch', field: 'identity.market', detail: `${envelope.identity.market}≠${context.market}` })
  if (envelope.identity.symbol !== context.ticker) issues.push({ code: 'ticker_mismatch', field: 'identity.symbol', detail: `${envelope.identity.symbol}≠${context.ticker}` })
  const envelopePermanentId = envelope.identity.permanentId
  const contextPermanentId = context.permanentId
  if (
    envelopePermanentId.status !== contextPermanentId.status
    || (envelopePermanentId.status === 'available'
      && contextPermanentId.status === 'available'
      && envelopePermanentId.value !== contextPermanentId.value)
  ) {
    issues.push({ code: 'permanent_identity_mismatch', field: 'identity.permanentId' })
  }
  if (envelope.asOfDate !== context.asOfDate) issues.push({ code: 'as_of_mismatch', field: 'asOfDate', detail: `${envelope.asOfDate}≠${context.asOfDate}` })
  const tolerance = REFERENCE_PRICE_TOLERANCE * Math.max(1, Math.abs(context.referenceClose))
  if (Number.isFinite(envelope.predictionReferencePrice) && Math.abs(envelope.predictionReferencePrice - context.referenceClose) > tolerance) {
    issues.push({ code: 'reference_price_mismatch', field: 'predictionReferencePrice', detail: `${envelope.predictionReferencePrice}≠${context.referenceClose}` })
  }
  if (envelope.priceBasis.kind === 'unknown' || context.priceBasis.kind === 'unknown') issues.push({ code: 'price_basis_unknown', field: 'priceBasis' })
  else if (!samePriceBasis(envelope.priceBasis, context.priceBasis)) issues.push({ code: 'price_basis_mismatch', field: 'priceBasis', detail: `${envelope.priceBasis.kind}≠${context.priceBasis.kind}` })
  if (envelope.calendar.id !== context.calendarId) issues.push({ code: 'calendar_mismatch', field: 'calendar.id', detail: `${envelope.calendar.id}≠${context.calendarId}` })
  if (envelope.calendar.version !== context.calendarVersion) issues.push({ code: 'calendar_version_mismatch', field: 'calendar.version', detail: `${envelope.calendar.version}≠${context.calendarVersion}` })
  const timeframeOk = envelope.forecastTimeframe === context.timeframe
  if (!timeframeOk) issues.push({ code: 'timeframe_mismatch', field: 'forecastTimeframe', detail: `${envelope.forecastTimeframe}≠${context.timeframe}` })
  const horizonOk = envelope.forecastHorizonBars === context.horizon
  if (!horizonOk) issues.push({ code: 'horizon_mismatch', field: 'forecastHorizonBars', detail: `${envelope.forecastHorizonBars}≠${context.horizon}` })
  // Bar dates are comparable only on the same bars; otherwise the timeframe/horizon issue already rejects.
  if (timeframeOk && horizonOk && envelope.futureClosePath.status === 'available') {
    const points = envelope.futureClosePath.value
    if (points.length !== context.futureSessions.length || points.some((point, index) => point.dateOrPeriod !== context.futureSessions[index])) {
      issues.push({ code: 'path_date_mismatch', field: 'futureClosePath' })
    }
  }
  return issues
}

// ---------------------------------------------------------------------------
// Validation result

export type ScenarioEvidenceValidation =
  | { status: 'projectable'; envelope: ScenarioEvidenceEnvelope; closes: number[] }
  | { status: 'no_path'; envelope: ScenarioEvidenceEnvelope; reason: 'classification_only' | 'path_unavailable' }
  | { status: 'rejected'; envelope: ScenarioEvidenceEnvelope | null; issues: ScenarioEvidenceIssue[] }

function dedupe(issues: ScenarioEvidenceIssue[]): ScenarioEvidenceIssue[] {
  const seen = new Set<string>()
  return issues.filter((issue) => {
    const key = `${issue.code}|${issue.field}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

export function validateScenarioEvidence(input: unknown, context: ScenarioValidationContext): ScenarioEvidenceValidation {
  const parsed = parseScenarioEvidence(input)
  if (!parsed.ok) return { status: 'rejected', envelope: null, issues: parsed.issues }
  const { envelope } = parsed
  const issues = dedupe([...semanticIssues(envelope), ...contextIssues(envelope, context)])
  if (issues.length > 0) return { status: 'rejected', envelope, issues }
  if (envelope.futureClosePath.status !== 'available') {
    return { status: 'no_path', envelope, reason: envelope.origin.kind === 'model_classification' ? 'classification_only' : 'path_unavailable' }
  }
  return { status: 'projectable', envelope, closes: envelope.futureClosePath.value.map((point) => point.close) }
}

/** True when the only blockers are view settings (timeframe / horizon) the user may switch to explicitly. */
export function isViewAlignable(validation: ScenarioEvidenceValidation): boolean {
  return validation.status === 'rejected' && validation.envelope != null && validation.issues.length > 0
    && validation.issues.every((issue) => VIEW_ALIGNABLE_ISSUES.includes(issue.code))
}

// ---------------------------------------------------------------------------
// Adapter: explicit close path -> existing SMA projection

export interface ScenarioSmaProjection {
  closes: number[]
  sma: SmaLabSeries
  /** Same shape the scenario conclusion / chart already consume. */
  evaluation: ScenarioEvaluation
}

/**
 * Only a projectable envelope on the lab's own bars is adapted. The SMA comes from
 * projectAllSma (projectSmaPath per period); nothing is interpolated or resampled.
 */
export function adaptScenarioToSma(validation: ScenarioEvidenceValidation, base: ForwardBase): ScenarioSmaProjection | null {
  if (validation.status !== 'projectable') return null
  const closes = [...validation.closes]
  if (closes.length !== base.horizon) return null
  const tolerance = REFERENCE_PRICE_TOLERANCE * Math.max(1, Math.abs(base.anchorClose))
  if (Math.abs(validation.envelope.predictionReferencePrice - base.anchorClose) > tolerance) return null
  const sma = projectAllSma(base, closes)
  return {
    closes,
    sma,
    evaluation: {
      cells: closes.map((close, index) => ({ k: index + 1, raw: String(close), status: 'ok', close, pctFromAnchor: cleanFloat((close / base.anchorClose - 1) * 100) })),
      closes,
      sma,
      filled: closes.length,
      missingK: [],
      invalidK: [],
      state: 'complete',
    },
  }
}

// ---------------------------------------------------------------------------
// Copy: origin and claim semantics (shared by UI and tests)

export const SCENARIO_ORIGIN_COPY: Record<ScenarioOriginKind, { label: string; tag: string; premise: string }> = {
  deterministic_template: { label: 'ルールのテンプレート', tag: 'テンプレート', premise: 'この価格経路を仮定した場合' },
  model_classification: { label: 'モデルの方向分類', tag: '方向分類', premise: '方向スコアのみ。将来価格の経路は未提供' },
  model_path_distribution: { label: 'モデルの経路分布', tag: '経路分布', premise: 'モデルが出した経路分布の代表経路を仮定した場合' },
  historical_analog: { label: '過去の類似ケース', tag: '類似ケース', premise: '類似状態の集計に基づく軌跡' },
  explanatory_synthetic: { label: '説明用の合成経路', tag: '合成', premise: '説明のために作った経路を仮定した場合' },
  user_input: { label: 'ユーザーの仮定', tag: 'ユーザー', premise: 'ユーザーが設定した仮定' },
  price_freeze: { label: '価格固定', tag: '価格固定', premise: '終値が基準日のまま変わらないと仮定した場合' },
  inverse_solver_result: { label: '逆算の代表経路', tag: '逆算', premise: '条件を満たす代表経路' },
}

/** Template paths are rule-made; this note is shown wherever a template path is drawn. */
export const SCENARIO_TEMPLATE_NOTE = 'ルールで作った説明用の経路です。モデルが出した価格経路ではありません。'
/** Appended to every non-calibrated percentage. */
export const SCENARIO_NOT_PROBABILITY = '確率・的中率・信頼度ではありません'

export function originVersionText(origin: ScenarioOrigin): string {
  switch (origin.kind) {
    case 'deterministic_template': return `テンプレート ${origin.templateId} ・ ルール ${origin.ruleVersion}`
    case 'model_classification':
    case 'model_path_distribution': return `モデル ${origin.modelVersion}`
    case 'historical_analog': return `手法 ${origin.methodVersion}`
    case 'explanatory_synthetic': return `ルール ${origin.ruleVersion}`
    case 'inverse_solver_result': return `逆算 ${origin.solverVersion}`
    case 'user_input': return '入力値'
    case 'price_freeze': return '基準日の終値'
  }
}

/** One line per claim kind; a percentage is never shown without its meaning. */
export function describeQuantitativeClaim(claim: QuantitativeClaim): { label: string; value: string; meaning: string } {
  const pct = (value: number) => `${cleanFloat(value)}%`
  switch (claim.kind) {
    case 'normalized_template_weight':
      return { label: '相対ウェイト', value: pct(claim.valuePct), meaning: `8テンプレートの点数を合計100%に揃えた値。${SCENARIO_NOT_PROBABILITY}` }
    case 'cluster_weight':
      return { label: '類似ケースの比重', value: pct(claim.valuePct), meaning: `類似ケースの中での比重。${SCENARIO_NOT_PROBABILITY}` }
    case 'raw_model_score':
      return { label: 'モデルの生スコア', value: String(cleanFloat(claim.value)), meaning: '確率に校正されていない値です' }
    case 'calibrated_class_probability':
      return { label: '校正済みの方向の確率', value: pct(claim.valuePct), meaning: `校正 ${claim.calibrationVersion}。方向についての値で、価格経路やSMAの確率ではありません` }
  }
}

/**
 * The claim only when it may be shown: allowed for the origin and in range. A rejected
 * envelope's disallowed claim (e.g. a "probability" on a template) is never rendered.
 */
export function displayableClaim(envelope: ScenarioEvidenceEnvelope): QuantitativeClaim | null {
  if (envelope.quantitativeClaim.status !== 'available') return null
  const claim = envelope.quantitativeClaim.value
  return ORIGIN_ALLOWED_CLAIMS[envelope.origin.kind].includes(claim.kind) && claimIssues(claim).length === 0 ? claim : null
}

export function describePriceBasis(basis: ScenarioPriceBasis): string {
  switch (basis.kind) {
    case 'raw_as_traded': return `調整なし (取引時の価格)${basis.corporateActionRevision ? ` ・ ${basis.corporateActionRevision}` : ''}`
    case 'split_adjusted': return `分割調整済み${basis.adjustmentRevision ? ` ・ ${basis.adjustmentRevision}` : ''}`
    case 'vendor_adjusted': return `${basis.vendor} 調整済み ・ 配当${basis.dividendPolicy === 'included' ? '込み' : basis.dividendPolicy === 'excluded' ? 'なし' : '不明'}`
    case 'unknown': return `不明 (${basis.reason})`
  }
}

export const SCENARIO_DIRECTION_LABEL: Record<ScenarioDirection, string> = { up: '上昇', range: 'レンジ', down: '下落' }

/** Candidate as supplied by a caller (fixture now; a verified adapter later). */
export interface ScenarioEvidenceCandidate {
  id: string
  label: string
  envelope: unknown
  /** 'developer' keeps verification fixtures out of the normal picker and its counts. */
  audience?: 'standard' | 'developer'
}

/**
 * The normal picker lists only standard deterministic templates. Everything else (other
 * origins, malformed input, developer fixtures) goes to the collapsed developer panel,
 * where it stays visible and selectable but never affects the normal counts.
 * Fail closed: only an explicit audience 'standard' qualifies (missing or unknown = developer).
 */
export function isStandardScenarioEntry(entry: ScenarioEvidenceEntry): boolean {
  if (entry.candidate.audience !== 'standard') return false
  const parsed = parseScenarioEvidence(entry.candidate.envelope)
  return parsed.ok && parsed.envelope.origin.kind === 'deterministic_template'
}

/** Usable = drawable now, or drawable after an explicit view change; blocked = rejected outright. */
export function isUsableScenarioEntry(entry: ScenarioEvidenceEntry): boolean {
  return entry.validation.status !== 'rejected' || isViewAlignable(entry.validation)
}

export interface ScenarioDirectionCount {
  total: number
  usable: number
  blocked: number
}

/** Normal-picker counts per direction: standard templates only, usable and blocked kept apart. */
export function scenarioDirectionCounts(entries: ReadonlyArray<ScenarioEvidenceEntry>): Record<ScenarioDirection, ScenarioDirectionCount> {
  const counts = Object.fromEntries(SCENARIO_DIRECTIONS.map((id) => [id, { total: 0, usable: 0, blocked: 0 }])) as Record<ScenarioDirection, ScenarioDirectionCount>
  for (const entry of entries) {
    if (!isStandardScenarioEntry(entry) || entry.direction == null) continue
    const count = counts[entry.direction]
    count.total += 1
    if (isUsableScenarioEntry(entry)) count.usable += 1
    else count.blocked += 1
  }
  return counts
}

/** Plain description of an assumed template path (null for other origins). */
export function scenarioShapeText(envelope: ScenarioEvidenceEnvelope | null): string | null {
  return envelope?.origin.kind === 'deterministic_template' ? scenarioTemplate(envelope.origin.templateId)?.shape ?? null : null
}

export function candidateDirection(candidate: ScenarioEvidenceCandidate): ScenarioDirection | null {
  const parsed = parseScenarioEvidence(candidate.envelope)
  return parsed.ok && parsed.envelope.direction.status === 'available' ? parsed.envelope.direction.value : null
}

export interface ScenarioEvidenceEntry {
  candidate: ScenarioEvidenceCandidate
  direction: ScenarioDirection | null
  validation: ScenarioEvidenceValidation
}

/**
 * List-level validation. `contextFor` receives the candidate's own horizon so a scenario
 * is listed as selectable when only the horizon differs (selecting it applies that
 * horizon explicitly). The timeframe is never substituted.
 */
export function evaluateScenarioCandidates(
  candidates: ReadonlyArray<ScenarioEvidenceCandidate>,
  contextFor: (horizon: number | null) => ScenarioValidationContext,
): ScenarioEvidenceEntry[] {
  return candidates.map((candidate) => {
    const parsed = parseScenarioEvidence(candidate.envelope)
    const horizon = parsed.ok ? parsed.envelope.forecastHorizonBars : null
    return { candidate, direction: candidateDirection(candidate), validation: validateScenarioEvidence(candidate.envelope, contextFor(horizon)) }
  })
}

/** Percent change of the last assumed close from the reference close (display only). */
export function pathEndChangePct(validation: ScenarioEvidenceValidation): number | null {
  if (validation.status !== 'projectable') return null
  const last = validation.closes.at(-1)
  return last == null ? null : cleanFloat((last / validation.envelope.predictionReferencePrice - 1) * 100)
}

// ---------------------------------------------------------------------------
// Presentation state: what the scenario layer may draw for the current selection.
//
// A selection that cannot be drawn never falls back to the user's draft: no draft path,
// SMA, result, readout or editor is shown as if it belonged to the selected scenario.
// The draft itself is never touched here; clearing the selection shows it unchanged.

/** Why a selected scenario is not drawn. */
export type ScenarioSelectionCause =
  | { kind: 'classification_only' }
  | { kind: 'path_unavailable' }
  | { kind: 'rejected'; issues: readonly ScenarioEvidenceIssue[] }
  /** The selected id no longer matches a candidate (list changed). */
  | { kind: 'selection_missing' }
  /** History is not loaded yet, so nothing could be validated. */
  | { kind: 'not_validated' }
  /** Validated, but the adapter refused the bars on screen. */
  | { kind: 'projection_failed' }

export type ScenarioPresentation =
  | { state: 'user_draft' }
  | { state: 'evidence_projectable'; selectedId: string; envelope: ScenarioEvidenceEnvelope; projection: ScenarioSmaProjection }
  | { state: 'evidence_unavailable'; selectedId: string; cause: ScenarioSelectionCause }
  /** Drawable only after the user explicitly switches the view; never converted silently. */
  | { state: 'evidence_alignable'; selectedId: string; envelope: ScenarioEvidenceEnvelope; timeframe: SmaLabTimeframeId; horizon: number }
export type ScenarioPresentationState = ScenarioPresentation['state']

export function resolveScenarioPresentation(input: {
  selectedId: string | null
  /** False until the history is loaded and candidates were validated against it. */
  validated: boolean
  /** Validation of the selected candidate on the bars on screen; null when the candidate is gone. */
  validation: ScenarioEvidenceValidation | null
  projection: ScenarioSmaProjection | null
}): ScenarioPresentation {
  const { selectedId, validation } = input
  if (selectedId == null) return { state: 'user_draft' }
  if (!input.validated) return { state: 'evidence_unavailable', selectedId, cause: { kind: 'not_validated' } }
  if (!validation) return { state: 'evidence_unavailable', selectedId, cause: { kind: 'selection_missing' } }
  switch (validation.status) {
    case 'projectable':
      return input.projection
        ? { state: 'evidence_projectable', selectedId, envelope: validation.envelope, projection: input.projection }
        : { state: 'evidence_unavailable', selectedId, cause: { kind: 'projection_failed' } }
    case 'no_path':
      return { state: 'evidence_unavailable', selectedId, cause: { kind: validation.reason } }
    case 'rejected':
      return isViewAlignable(validation) && validation.envelope
        ? { state: 'evidence_alignable', selectedId, envelope: validation.envelope, timeframe: validation.envelope.forecastTimeframe, horizon: validation.envelope.forecastHorizonBars }
        : { state: 'evidence_unavailable', selectedId, cause: { kind: 'rejected', issues: validation.issues } }
    default: {
      const unknown: never = validation
      void unknown
      return { state: 'evidence_unavailable', selectedId, cause: { kind: 'selection_missing' } }
    }
  }
}

/**
 * The scenario evaluation the chart, readout, result and solver may use. Only an explicit
 * user draft (no selection) or a drawable selection yields one; every other state yields null.
 */
export function presentedScenario<T>(presentation: ScenarioPresentation, draft: T | null, evidenceShown: boolean): T | ScenarioEvaluation | null {
  switch (presentation.state) {
    case 'user_draft': return draft
    case 'evidence_projectable': return evidenceShown ? presentation.projection.evaluation : null
    case 'evidence_unavailable':
    case 'evidence_alignable': return null
  }
}

/** The user's own editor belongs only to the user-draft state. */
export function showsUserDraftEditor(presentation: ScenarioPresentation): boolean {
  return presentation.state === 'user_draft'
}

const ISSUE_HEADLINES: ReadonlyArray<{ codes: readonly ScenarioEvidenceIssueCode[]; text: string }> = [
  { codes: ['malformed', 'schema_version'], text: 'データ形式を確認できないため表示しません' },
  { codes: ['market_mismatch', 'ticker_mismatch', 'permanent_identity_mismatch'], text: '表示中とは別の銘柄・市場のシナリオのため表示しません' },
  { codes: ['as_of_mismatch', 'history_through_mismatch'], text: '基準日が表示中と異なるシナリオのため表示しません' },
  { codes: ['reference_price_mismatch'], text: '基準日の終値が表示中の履歴と一致しないため表示しません' },
  { codes: ['price_basis_unknown', 'price_basis_mismatch'], text: '価格の基準 (調整方法) が表示中の履歴と同じだと確認できないため表示しません' },
  { codes: ['path_close_invalid', 'path_length', 'path_bar_sequence', 'path_freeze_mismatch', 'classification_with_path'], text: '経路の終値に使えない値があるため表示しません' },
  { codes: ['calendar_mismatch', 'calendar_version_mismatch', 'path_date_mismatch'], text: '取引カレンダーの足と一致しないため表示しません' },
  { codes: ['horizon_unsupported'], text: 'この時間軸では扱えない本数のため表示しません' },
]

/** One cause-specific sentence for a selection that is not drawn (details list every issue). */
export function scenarioSelectionHeadline(cause: ScenarioSelectionCause): string {
  switch (cause.kind) {
    case 'classification_only': return '方向スコアのみで将来価格の経路がないため、SMAは計算しません'
    case 'path_unavailable': return '将来価格の経路が提供されていないため、SMAは計算しません'
    case 'selection_missing': return '選択したシナリオが一覧に見つからないため表示しません'
    case 'not_validated': return '価格履歴を読み込むまで検証できないため表示しません'
    case 'projection_failed': return '表示中の足に合わせられないため表示しません'
    case 'rejected': {
      const codes = cause.issues.map((issue) => issue.code)
      return ISSUE_HEADLINES.find((group) => group.codes.some((code) => codes.includes(code)))?.text ?? '確認できない点があるため表示しません'
    }
  }
}

/** Shown wherever a selection is not drawn: the draft is kept and comes back on clear. */
export const SCENARIO_DRAFT_KEPT_NOTE = 'あなたの入力は保存したままです。選択を解除すると元の入力に戻ります。'
export const SCENARIO_CLEAR_LABEL = '選択を解除 (自分の入力に戻る)'

// ---------------------------------------------------------------------------
// Hand-off provenance: a scenario's closes copied into the user draft (editor or solver).
//
// The source (what the closes came from) is kept apart from the current path origin,
// which is derived from the draft's actual values on every render, never from an event.

export interface ScenarioHandoffRecord {
  candidateId: string
  label: string
  sourceOrigin: ScenarioOriginKind
  timeframe: SmaLabTimeframeId
  horizon: number
  asOfDate: string
  /** Closes exactly as validated in the source scenario (shown as the original). */
  sourceCloses: readonly number[]
  /** The same closes as written into the draft and read back: the "inherited" baseline. */
  inheritedCloses: ReadonlyArray<number | null>
}

export type HandoffScopeMismatch = 'timeframe' | 'horizon' | 'as_of'
export type HandoffPathOrigin = 'inherited' | 'user_modified'
export type HandoffPathState =
  | { status: 'in_scope'; currentOrigin: HandoffPathOrigin; changedK: number[] }
  /** The draft on screen is not on the hand-off's bars: the inherited path is not compared. */
  | { status: 'out_of_scope'; mismatches: HandoffScopeMismatch[] }

// Unit conversion writes percentages at six decimal places, so its price error scales with the
// price level. This tolerance is provenance-only and stays well below a displayed price tick.
const HANDOFF_UNIT_ROUND_TRIP_RELATIVE_TOLERANCE = 1e-8
const HANDOFF_UNIT_ROUND_TRIP_ABSOLUTE_TOLERANCE = 1e-6

function sameHandoffClose(current: number | null | undefined, inherited: number | null | undefined): boolean {
  if (current === inherited) return true
  if (current == null || inherited == null || !Number.isFinite(current) || !Number.isFinite(inherited)) return false
  const tolerance = Math.max(
    HANDOFF_UNIT_ROUND_TRIP_ABSOLUTE_TOLERANCE,
    Math.max(Math.abs(current), Math.abs(inherited)) * HANDOFF_UNIT_ROUND_TRIP_RELATIVE_TOLERANCE,
  )
  return Math.abs(current - inherited) <= tolerance
}

export function resolveHandoffPath(
  record: ScenarioHandoffRecord,
  current: { timeframe: SmaLabTimeframeId; horizon: number; asOfDate: string; closes: ReadonlyArray<number | null> },
): HandoffPathState {
  const mismatches: HandoffScopeMismatch[] = []
  if (record.timeframe !== current.timeframe) mismatches.push('timeframe')
  if (record.horizon !== current.horizon) mismatches.push('horizon')
  if (record.asOfDate !== current.asOfDate) mismatches.push('as_of')
  if (mismatches.length > 0) return { status: 'out_of_scope', mismatches }
  const changedK: number[] = []
  for (let i = 0; i < record.horizon; i += 1) {
    if (!sameHandoffClose(current.closes[i], record.inheritedCloses[i])) changedK.push(i + 1)
  }
  return { status: 'in_scope', currentOrigin: changedK.length === 0 ? 'inherited' : 'user_modified', changedK }
}

export const SOLVER_REPRESENTATIVE_PATH_LABEL = '逆算による代表経路'
export const HANDOFF_NOT_SOLVER_NOTE = '引き継いだ経路は逆算の結果ではなく、比較のための仮定です。逆算による代表経路は、条件を満たす無数の経路のうちの一例です。'

/** Chart / readout / legend label of the inherited comparison path. */
export function handoffComparisonLabel(record: Pick<ScenarioHandoffRecord, 'label' | 'sourceOrigin'>, origin: HandoffPathOrigin): string {
  return origin === 'inherited'
    ? `比較経路：${record.label}（${SCENARIO_ORIGIN_COPY[record.sourceOrigin].tag}）`
    : `比較経路：${record.label}を基に変更（${SCENARIO_ORIGIN_COPY.user_input.tag}）`
}

/** Names the compared path in the solver's goal checks (never "入力した" for an inherited path). */
export function handoffCheckLabel(label: string, origin: HandoffPathOrigin): string {
  return origin === 'inherited' ? `引き継いだ「${label}」の経路` : `「${label}」を基に変更した経路`
}

/** Lead sentence of the solver comparison callout. */
export function handoffSolverLead(label: string, origin: HandoffPathOrigin): string {
  return origin === 'inherited'
    ? `「${label}」から引き継いだ価格経路と、逆算結果を比較しています。`
    : `「${label}」を基にあなたが変更した価格経路と、逆算結果を比較しています。`
}

/** Why the inherited path is not compared; it is never resized or converted. */
export function handoffScopeText(record: ScenarioHandoffRecord, mismatches: readonly HandoffScopeMismatch[]): string {
  const timeframe = smaLabTimeframe(record.timeframe)
  const tf = `${timeframe.name} (${timeframe.label})`
  const reasons = mismatches.map((item) => (item === 'timeframe' ? '時間軸' : item === 'horizon' ? '本数' : '基準日'))
  return `「${record.label}」から引き継いだ経路は ${tf}・${record.horizon}本・基準日 ${record.asOfDate} の足のものです。表示中の${reasons.join('・')}が異なるため比較に使いません (自動で変換・伸縮はしません)。`
}
