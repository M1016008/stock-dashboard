// SMA Dynamics Lab link contract (pure, no I/O).
//
// One URL shape lets any screen open the lab for a security: the stock detail pages
// (JP /stock/[ticker], US /us/stock/[ticker]) and, for development, /dev/sma-dynamics.
// The six-stage current-candidate list is the first producer. It only builds a URL: nothing
// here reads Production data, and the lab never trusts the query beyond validating it.
//
//   /stock/7203?smalab=1&smatf=1D&smap=5,25,75&smamode=freeze&smah=5&smapair=25-75
//       &smasrc=six-stage-current&smaasof=2026-10-16&smagen=gen-001#chart
//
// Everything is optional except the security. Unknown or invalid values are dropped one by
// one (never guessed or rounded), so an old or hand-edited link degrades to the default lab.
import { isValidTickerForMarket } from '@/lib/markets'
import { isIsoCalendarDate, type SmaDynamicsMarket } from '@/lib/sma-dynamics'
import {
  isSmaLabPeriod,
  normalizeSmaLabPeriods,
  smaLabMaxHorizonBars,
  SMA_LAB_MAX_SELECTED_PERIODS,
} from '@/lib/sma-dynamics-lab'
import { isSmaLabTimeframeId, type SmaLabTimeframeId } from '@/lib/sma-dynamics-timeframes'

export const SMA_LINK_PARAMS = {
  open: 'smalab',
  timeframe: 'smatf',
  periods: 'smap',
  mode: 'smamode',
  horizon: 'smah',
  pair: 'smapair',
  origin: 'smasrc',
  asOf: 'smaasof',
  generation: 'smagen',
} as const

/** Producers of links. Only the six-stage current candidates exist today. */
export const SMA_LINK_ORIGINS = ['six-stage-current'] as const
export type SmaLinkOrigin = (typeof SMA_LINK_ORIGINS)[number]
export const SMA_LINK_ORIGIN_LABEL: Record<SmaLinkOrigin, string> = {
  'six-stage-current': '6ステージの現在候補',
}

export const SMA_LINK_MODES = ['freeze', 'scenario', 'solver'] as const
export type SmaLinkMode = (typeof SMA_LINK_MODES)[number]

export type SmaLinkTarget = 'stock-detail' | 'dev-preview'

/** What a link asks for. All fields are validated; absent means "leave the lab's own default". */
export interface SmaLinkIntent {
  origin: SmaLinkOrigin | null
  /** Trading date the producer's numbers belong to; the lab compares it with its own latest bar. */
  asOfTradingDate: string | null
  /** Opaque id of the producer's data generation; shown, never interpreted. */
  sourceGeneration: string | null
  timeframe: SmaLabTimeframeId | null
  periods: number[]
  mode: SmaLinkMode | null
  horizon: number | null
  /** Short and long SMA period to look at first (shape / crossing panels). */
  pair: [number, number] | null
}

export interface SmaLinkRequest {
  market: SmaDynamicsMarket
  ticker: string
  target?: SmaLinkTarget
  /** Fixture id for the dev preview target. */
  fixtureId?: string
  origin?: SmaLinkOrigin
  asOfTradingDate?: string | null
  sourceGeneration?: string | null
  timeframe?: SmaLabTimeframeId | null
  periods?: ReadonlyArray<number>
  mode?: SmaLinkMode | null
  horizon?: number | null
  pair?: readonly [number, number] | null
}

export type SmaLinkResult =
  | { ok: true; href: string; target: SmaLinkTarget; ticker: string }
  | { ok: false; reason: 'invalid_ticker' | 'invalid_fixture' }

const GENERATION = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/
const FIXTURE_ID = /^[a-z0-9][a-z0-9-]{0,47}$/

/** "7203.T" -> "7203", lower-case US symbols upper-cased. Null when it is not a security of that market. */
export function normalizeLinkTicker(market: SmaDynamicsMarket, raw: string): string | null {
  let ticker = raw.trim().toUpperCase()
  if (market === 'JP') ticker = ticker.replace(/\.T$/, '')
  return isValidTickerForMarket(ticker, market) ? ticker : null
}

function validPair(pair: readonly [number, number] | null | undefined): [number, number] | null {
  if (!pair) return null
  const [a, b] = pair
  if (!isSmaLabPeriod(a) || !isSmaLabPeriod(b) || a === b) return null
  return a < b ? [a, b] : [b, a]
}

function validHorizon(timeframe: SmaLabTimeframeId | null, horizon: number | null | undefined): number | null {
  if (horizon == null || !Number.isInteger(horizon) || horizon < 1) return null
  return horizon <= (timeframe ? smaLabMaxHorizonBars(timeframe) : 20) ? horizon : null
}

export function buildSmaDynamicsLink(request: SmaLinkRequest): SmaLinkResult {
  const ticker = normalizeLinkTicker(request.market, request.ticker)
  if (!ticker) return { ok: false, reason: 'invalid_ticker' }
  const target = request.target ?? 'stock-detail'
  const params = new URLSearchParams()
  if (target === 'dev-preview') {
    if (!request.fixtureId || !FIXTURE_ID.test(request.fixtureId)) return { ok: false, reason: 'invalid_fixture' }
    params.set('fixture', request.fixtureId)
  }
  params.set(SMA_LINK_PARAMS.open, '1')
  const timeframe = request.timeframe && isSmaLabTimeframeId(request.timeframe) ? request.timeframe : null
  if (timeframe) params.set(SMA_LINK_PARAMS.timeframe, timeframe)
  const periods = normalizeSmaLabPeriods(request.periods ?? []).slice(0, SMA_LAB_MAX_SELECTED_PERIODS)
  if (periods.length > 0) params.set(SMA_LINK_PARAMS.periods, periods.join(','))
  if (request.mode && (SMA_LINK_MODES as readonly string[]).includes(request.mode)) params.set(SMA_LINK_PARAMS.mode, request.mode)
  const horizon = validHorizon(timeframe, request.horizon)
  if (horizon != null) params.set(SMA_LINK_PARAMS.horizon, String(horizon))
  const pair = validPair(request.pair)
  if (pair) params.set(SMA_LINK_PARAMS.pair, `${pair[0]}-${pair[1]}`)
  if (request.origin && (SMA_LINK_ORIGINS as readonly string[]).includes(request.origin)) params.set(SMA_LINK_PARAMS.origin, request.origin)
  if (request.asOfTradingDate && isIsoCalendarDate(request.asOfTradingDate)) params.set(SMA_LINK_PARAMS.asOf, request.asOfTradingDate)
  if (request.sourceGeneration && GENERATION.test(request.sourceGeneration)) params.set(SMA_LINK_PARAMS.generation, request.sourceGeneration)

  const query = params.toString()
  const path = target === 'dev-preview'
    ? '/dev/sma-dynamics'
    : request.market === 'US' ? `/us/stock/${encodeURIComponent(ticker)}` : `/stock/${encodeURIComponent(ticker)}`
  // Stock detail pages select their tab from the hash.
  return { ok: true, target, ticker, href: `${path}?${query}${target === 'stock-detail' ? '#chart' : ''}` }
}

const EMPTY_INTENT: SmaLinkIntent = {
  origin: null,
  asOfTradingDate: null,
  sourceGeneration: null,
  timeframe: null,
  periods: [],
  mode: null,
  horizon: null,
  pair: null,
}

function parsePeriods(value: string | null): number[] {
  if (!value) return []
  const numbers = value.split(',').map((token) => (/^\d{1,3}$/.test(token.trim()) ? Number(token) : Number.NaN))
  return normalizeSmaLabPeriods(numbers).slice(0, SMA_LAB_MAX_SELECTED_PERIODS)
}

/**
 * Reads the lab parameters from a query string. Returns null when the link does not ask to open the
 * lab (no smalab=1), so unrelated query strings never change the page.
 */
export function parseSmaDynamicsLink(search: string | URLSearchParams): SmaLinkIntent | null {
  const params = typeof search === 'string' ? new URLSearchParams(search) : search
  if (params.get(SMA_LINK_PARAMS.open) !== '1') return null
  const originRaw = params.get(SMA_LINK_PARAMS.origin)
  const timeframeRaw = params.get(SMA_LINK_PARAMS.timeframe)
  const timeframe = isSmaLabTimeframeId(timeframeRaw) ? timeframeRaw : null
  const modeRaw = params.get(SMA_LINK_PARAMS.mode)
  const asOfRaw = params.get(SMA_LINK_PARAMS.asOf)
  const generationRaw = params.get(SMA_LINK_PARAMS.generation)
  const horizonRaw = params.get(SMA_LINK_PARAMS.horizon)
  const pairRaw = params.get(SMA_LINK_PARAMS.pair)?.match(/^(\d{1,3})-(\d{1,3})$/)
  return {
    ...EMPTY_INTENT,
    origin: (SMA_LINK_ORIGINS as readonly string[]).includes(originRaw ?? '') ? (originRaw as SmaLinkOrigin) : null,
    asOfTradingDate: asOfRaw && isIsoCalendarDate(asOfRaw) ? asOfRaw : null,
    sourceGeneration: generationRaw && GENERATION.test(generationRaw) ? generationRaw : null,
    timeframe,
    periods: parsePeriods(params.get(SMA_LINK_PARAMS.periods)),
    mode: (SMA_LINK_MODES as readonly string[]).includes(modeRaw ?? '') ? (modeRaw as SmaLinkMode) : null,
    horizon: validHorizon(timeframe, horizonRaw && /^\d{1,2}$/.test(horizonRaw) ? Number(horizonRaw) : null),
    pair: pairRaw ? validPair([Number(pairRaw[1]), Number(pairRaw[2])]) : null,
  }
}

/** View settings a link implies (only the fields it actually carries). */
export interface SmaLinkSettingsPatch {
  timeframe?: SmaLabTimeframeId
  periods?: number[]
  analysis?: SmaLinkMode
  horizon?: number
}

/**
 * The patch to apply on top of the lab's current settings. Pair periods are always shown so the
 * panel the link points at has both lines.
 */
export function linkIntentToSettingsPatch(intent: SmaLinkIntent): SmaLinkSettingsPatch {
  const patch: SmaLinkSettingsPatch = {}
  if (intent.timeframe) patch.timeframe = intent.timeframe
  const periods = normalizeSmaLabPeriods([...intent.periods, ...(intent.pair ?? [])]).slice(0, SMA_LAB_MAX_SELECTED_PERIODS)
  if (periods.length > 0) patch.periods = periods
  if (intent.mode) patch.analysis = intent.mode
  if (intent.horizon != null) patch.horizon = intent.horizon
  return patch
}

// ---------------------------------------------------------------------------
// Six-stage current candidate -> link request

/**
 * Structural subset of CurrentServingProjectionRow (lib/research/six-stage-current-serving-projection).
 * Declared here so this module has no dependency on the research code; the row type is assignable to it.
 */
export interface SixStageCandidateLike {
  market: SmaDynamicsMarket
  ticker: string
  asOfTradingDate: string
  sourceGeneration: string
  smaShape: {
    pairDistance: {
      sma25To75: number | null
      sma75To150: number | null
      sma150To200: number | null
      sma200To300: number | null
    }
  }
}

/** The six current-serving SMA periods, shortest to longest. */
export const SIX_STAGE_SMA_PERIODS = [5, 25, 75, 150, 200, 300] as const

const PAIR_KEYS: ReadonlyArray<{ key: keyof SixStageCandidateLike['smaShape']['pairDistance']; pair: [number, number] }> = [
  { key: 'sma25To75', pair: [25, 75] },
  { key: 'sma75To150', pair: [75, 150] },
  { key: 'sma150To200', pair: [150, 200] },
  { key: 'sma200To300', pair: [200, 300] },
]

/** The adjacent long-term pair whose SMAs are closest together (smallest |distance|); null if none is known. */
export function closestSmaPair(candidate: Pick<SixStageCandidateLike, 'smaShape'>): [number, number] | null {
  let best: { pair: [number, number]; distance: number } | null = null
  for (const { key, pair } of PAIR_KEYS) {
    const value = candidate.smaShape.pairDistance[key]
    if (value == null || !Number.isFinite(value)) continue
    const distance = Math.abs(value)
    if (!best || distance < best.distance) best = { pair, distance }
  }
  return best?.pair ?? null
}

/**
 * Link for one six-stage current candidate. Daily bars with the six SMAs the candidate list reports, the
 * freeze view, and the closest SMA pair preselected. `fixtureId` is set only for synthetic projections.
 */
export function sixStageCandidateLinkRequest(candidate: SixStageCandidateLike, options: { fixtureId?: string } = {}): SmaLinkRequest {
  return {
    market: candidate.market,
    ticker: candidate.ticker,
    target: options.fixtureId ? 'dev-preview' : 'stock-detail',
    fixtureId: options.fixtureId,
    origin: 'six-stage-current',
    asOfTradingDate: candidate.asOfTradingDate,
    sourceGeneration: candidate.sourceGeneration,
    timeframe: '1D',
    periods: SIX_STAGE_SMA_PERIODS,
    mode: 'freeze',
    pair: closestSmaPair(candidate),
  }
}
