import {
  type EventSimilarityVector,
  type EventSmaSimilarityFeature,
} from '@/lib/research/six-stage-event-analysis'

export const CURRENT_SERVING_PROJECTION_DEFINITION_VERSION = 'six_stage_current_serving_projection_v1'
export const CURRENT_SERVING_PROJECTION_MAX_ROWS = 20_000
export const CURRENT_SERVING_PROJECTION_MAX_BYTES = 64 * 1024 * 1024
export const CURRENT_SERVING_PROJECTION_MIN_AUXILIARY_COVERAGE = 0.95
export const CURRENT_SERVING_SMA_PERIODS = [5, 25, 75, 150, 200, 300] as const

export type CurrentServingMarket = 'JP' | 'US'
export type CurrentServingSmaPeriod = typeof CURRENT_SERVING_SMA_PERIODS[number]
export type CurrentServingPosition = 'ABOVE' | 'BELOW' | 'TOUCH' | null

export type CurrentServingSmaFeature = {
  value: number | null
  closeGap: number | null
  slope: number | null
  normalizedAngle: number | null
  curvature: number | null
  position: CurrentServingPosition
  available: {
    value: boolean
    closeGap: boolean
    slope: boolean
    normalizedAngle: boolean
    curvature: boolean
    position: boolean
  }
}

export type CurrentServingProjectionRow = {
  market: CurrentServingMarket
  ticker: string
  companyName: string
  asOfTradingDate: string
  sourceGeneration: string
  definitionVersion: typeof CURRENT_SERVING_PROJECTION_DEFINITION_VERSION
  stage: {
    current: string
    sequence2: string | null
    sequence3: string | null
    cAge: number | null
  }
  close: number | null
  sma: Record<CurrentServingSmaPeriod, CurrentServingSmaFeature>
  smaShape: {
    order: CurrentServingSmaPeriod[]
    pairDistance: {
      sma25To75: number | null
      sma75To150: number | null
      sma150To200: number | null
      sma200To300: number | null
    }
    convergence: {
      sma25To75: number | null
      sma75To150: number | null
      sma150To200: number | null
      sma200To300: number | null
    }
  }
  physical: {
    raw: {
      velocity: number | null
      acceleration: number | null
      momentum: number | null
      force: number | null
      energy: number | null
    }
    official: {
      pms: number | null
      pfs: number | null
      pes: number | null
    }
    available: {
      velocity: boolean
      acceleration: boolean
      momentum: boolean
      force: boolean
      energy: boolean
      pms: boolean
      pfs: boolean
      pes: boolean
    }
  }
}

export type CurrentServingProjectionPayload = {
  kind: 'stockboard-six-stage-current-serving-projection'
  status: 'COMPLETE'
  generationId: string
  generatedAt: string
  definitionVersion: typeof CURRENT_SERVING_PROJECTION_DEFINITION_VERSION
  source: 'SERVING_UPDATE_CHAIN' | 'SYNTHETIC_SERVING_UPDATE_CHAIN_FIXTURE'
  marketWatermarks: Record<CurrentServingMarket, {
    asOfTradingDate: string
    sourceGeneration: string
    priceBasis: string
    featureSet: string
    rows: number
    coverage: {
      snapshotRows: number
      eligibleRows: number
      universeRows: number
      universeIdentityRows: number
      closeRows: number
      mlRows: number
      smaRows: number
      physicalRows: number
    }
  }>
  rows: CurrentServingProjectionRow[]
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/
const STAGE = /^\d{6}$/
const GENERATION = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const FORBIDDEN_FIELD = /outcome|return|forward|target|label|mfe|mae/i

function finiteOrNull(value: unknown): value is number | null {
  return value === null || (typeof value === 'number' && Number.isFinite(value))
}

function assertSequence(value: string | null, length: 2 | 3, current: string): void {
  if (value === null) return
  const states = value.split('>')
  if (
    states.length !== length
    || states.some((state) => !STAGE.test(state))
    || states.some((state, index) => index > 0 && state === states[index - 1])
    || states.at(-1) !== current
  ) {
    throw new Error(`CURRENT_PROJECTION_INVALID_SEQUENCE_${length}`)
  }
}

function assertNoOutcomeFields(value: unknown, path = 'payload'): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoOutcomeFields(item, `${path}[${index}]`))
    return
  }
  if (!value || typeof value !== 'object') return
  for (const [key, nested] of Object.entries(value)) {
    if (FORBIDDEN_FIELD.test(key)) throw new Error(`CURRENT_PROJECTION_FORBIDDEN_FIELD:${path}.${key}`)
    assertNoOutcomeFields(nested, `${path}.${key}`)
  }
}

function assertAvailability(value: number | null, available: boolean, name: string): void {
  if (!finiteOrNull(value) || available !== (value !== null)) {
    throw new Error(`CURRENT_PROJECTION_AVAILABILITY_MISMATCH:${name}`)
  }
}

function assertRow(row: CurrentServingProjectionRow): void {
  if (row.market !== 'JP' && row.market !== 'US') throw new Error('CURRENT_PROJECTION_INVALID_MARKET')
  if (!row.ticker.trim() || !row.companyName.trim()) throw new Error('CURRENT_PROJECTION_MISSING_IDENTITY')
  if (!ISO_DATE.test(row.asOfTradingDate)) throw new Error('CURRENT_PROJECTION_INVALID_AS_OF')
  if (!GENERATION.test(row.sourceGeneration)) throw new Error('CURRENT_PROJECTION_INVALID_SOURCE_GENERATION')
  if (row.definitionVersion !== CURRENT_SERVING_PROJECTION_DEFINITION_VERSION) {
    throw new Error('CURRENT_PROJECTION_DEFINITION_MISMATCH')
  }
  if (
    !STAGE.test(row.stage.current)
    || (row.stage.cAge !== null && (!Number.isInteger(row.stage.cAge) || row.stage.cAge < 1))
  ) {
    throw new Error('CURRENT_PROJECTION_INVALID_STAGE')
  }
  assertSequence(row.stage.sequence2, 2, row.stage.current)
  assertSequence(row.stage.sequence3, 3, row.stage.current)
  if (row.stage.sequence3 !== null && row.stage.sequence2 !== row.stage.sequence3.split('>').slice(-2).join('>')) {
    throw new Error('CURRENT_PROJECTION_SEQUENCE_MISMATCH')
  }
  if (!finiteOrNull(row.close)) throw new Error('CURRENT_PROJECTION_INVALID_CLOSE')

  for (const period of CURRENT_SERVING_SMA_PERIODS) {
    const feature = row.sma[period]
    if (!feature) throw new Error(`CURRENT_PROJECTION_MISSING_SMA:${period}`)
    assertAvailability(feature.value, feature.available.value, `sma${period}.value`)
    assertAvailability(feature.closeGap, feature.available.closeGap, `sma${period}.closeGap`)
    assertAvailability(feature.slope, feature.available.slope, `sma${period}.slope`)
    assertAvailability(feature.normalizedAngle, feature.available.normalizedAngle, `sma${period}.normalizedAngle`)
    assertAvailability(feature.curvature, feature.available.curvature, `sma${period}.curvature`)
    if (feature.available.position !== (feature.position !== null)) {
      throw new Error(`CURRENT_PROJECTION_AVAILABILITY_MISMATCH:sma${period}.position`)
    }
  }
  const order = row.smaShape.order
  if (new Set(order).size !== order.length || order.some((period) => !CURRENT_SERVING_SMA_PERIODS.includes(period))) {
    throw new Error('CURRENT_PROJECTION_INVALID_SMA_ORDER')
  }
  for (const [name, value] of Object.entries({ ...row.smaShape.pairDistance, ...row.smaShape.convergence })) {
    if (!finiteOrNull(value)) throw new Error(`CURRENT_PROJECTION_INVALID_SMA_SHAPE:${name}`)
  }
  for (const [name, value] of Object.entries(row.physical.raw)) {
    assertAvailability(value, row.physical.available[name as keyof typeof row.physical.raw], `physical.${name}`)
  }
  for (const [name, value] of Object.entries(row.physical.official)) {
    assertAvailability(value, row.physical.available[name as keyof typeof row.physical.official], `physical.${name}`)
  }
}

export function assertCurrentServingProjectionPayload(
  payload: CurrentServingProjectionPayload,
  limits: { maxRows?: number; maxBytes?: number } = {},
): void {
  if (payload.kind !== 'stockboard-six-stage-current-serving-projection' || payload.status !== 'COMPLETE') {
    throw new Error('CURRENT_PROJECTION_INCOMPLETE')
  }
  if (!GENERATION.test(payload.generationId)) throw new Error('CURRENT_PROJECTION_INVALID_GENERATION')
  if (!Number.isFinite(Date.parse(payload.generatedAt))) throw new Error('CURRENT_PROJECTION_INVALID_GENERATED_AT')
  if (payload.definitionVersion !== CURRENT_SERVING_PROJECTION_DEFINITION_VERSION) {
    throw new Error('CURRENT_PROJECTION_DEFINITION_MISMATCH')
  }
  if (payload.source !== 'SERVING_UPDATE_CHAIN' && payload.source !== 'SYNTHETIC_SERVING_UPDATE_CHAIN_FIXTURE') {
    throw new Error('CURRENT_PROJECTION_INVALID_SOURCE')
  }
  const maxRows = limits.maxRows ?? CURRENT_SERVING_PROJECTION_MAX_ROWS
  if (payload.rows.length === 0 || payload.rows.length > maxRows) throw new Error('CURRENT_PROJECTION_ROW_LIMIT')
  const maxBytes = limits.maxBytes ?? CURRENT_SERVING_PROJECTION_MAX_BYTES
  if (new TextEncoder().encode(JSON.stringify(payload)).byteLength > maxBytes) throw new Error('CURRENT_PROJECTION_BYTE_LIMIT')
  assertNoOutcomeFields(payload)

  const identities = new Set<string>()
  for (const row of payload.rows) {
    assertRow(row)
    const identity = `${row.market}:${row.ticker}`
    if (identities.has(identity)) throw new Error('CURRENT_PROJECTION_DUPLICATE_TICKER')
    identities.add(identity)
    const watermark = payload.marketWatermarks[row.market]
    if (row.asOfTradingDate !== watermark.asOfTradingDate || row.sourceGeneration !== watermark.sourceGeneration) {
      throw new Error('CURRENT_PROJECTION_GENERATION_MISMATCH')
    }
  }
  for (const market of ['JP', 'US'] as const) {
    const watermark = payload.marketWatermarks[market]
    if (
      !ISO_DATE.test(watermark.asOfTradingDate)
      || !GENERATION.test(watermark.sourceGeneration)
      || !watermark.priceBasis.trim()
      || !watermark.featureSet.trim()
    ) {
      throw new Error('CURRENT_PROJECTION_INVALID_WATERMARK')
    }
    if (payload.rows.filter((row) => row.market === market).length !== watermark.rows || watermark.rows < 1) {
      throw new Error('CURRENT_PROJECTION_MARKET_ROW_MISMATCH')
    }
    const coverage = watermark.coverage
    if (
      !coverage
      || !Number.isSafeInteger(coverage.snapshotRows)
      || !Number.isSafeInteger(coverage.eligibleRows)
      || !Number.isSafeInteger(coverage.universeRows)
      || !Number.isSafeInteger(coverage.universeIdentityRows)
      || !Number.isSafeInteger(coverage.closeRows)
      || !Number.isSafeInteger(coverage.mlRows)
      || !Number.isSafeInteger(coverage.smaRows)
      || !Number.isSafeInteger(coverage.physicalRows)
      || coverage.snapshotRows < coverage.eligibleRows
      || coverage.eligibleRows !== watermark.rows
      || coverage.universeRows !== coverage.eligibleRows
      || coverage.universeIdentityRows !== coverage.eligibleRows
      || coverage.closeRows !== coverage.eligibleRows
      || coverage.mlRows < Math.ceil(coverage.eligibleRows * CURRENT_SERVING_PROJECTION_MIN_AUXILIARY_COVERAGE)
      || coverage.smaRows < Math.ceil(coverage.eligibleRows * CURRENT_SERVING_PROJECTION_MIN_AUXILIARY_COVERAGE)
      || coverage.physicalRows < Math.ceil(coverage.eligibleRows * CURRENT_SERVING_PROJECTION_MIN_AUXILIARY_COVERAGE)
    ) {
      throw new Error('CURRENT_PROJECTION_INVALID_COVERAGE')
    }
  }
}

export function currentProjectionRowToSimilarityVector(row: CurrentServingProjectionRow): EventSimilarityVector {
  const sma = (period: CurrentServingSmaPeriod, field: keyof Pick<CurrentServingSmaFeature, 'closeGap' | 'normalizedAngle' | 'curvature'>) => row.sma[period][field]
  const shape: Partial<Record<EventSmaSimilarityFeature, number | null>> = {
    sma5CloseGap: sma(5, 'closeGap'),
    sma25CloseGap: sma(25, 'closeGap'),
    sma75CloseGap: sma(75, 'closeGap'),
    sma150CloseGap: sma(150, 'closeGap'),
    sma200CloseGap: sma(200, 'closeGap'),
    sma300CloseGap: sma(300, 'closeGap'),
    sma5Angle: sma(5, 'normalizedAngle'),
    sma25Angle: sma(25, 'normalizedAngle'),
    sma75Angle: sma(75, 'normalizedAngle'),
    sma150Angle: sma(150, 'normalizedAngle'),
    sma200Angle: sma(200, 'normalizedAngle'),
    sma300Angle: sma(300, 'normalizedAngle'),
    sma5Curvature: sma(5, 'curvature'),
    sma25Curvature: sma(25, 'curvature'),
    sma75Curvature: sma(75, 'curvature'),
    sma150Curvature: sma(150, 'curvature'),
    sma200Curvature: sma(200, 'curvature'),
    sma300Curvature: sma(300, 'curvature'),
    sma25To75Distance: row.smaShape.pairDistance.sma25To75,
    sma75To150Distance: row.smaShape.pairDistance.sma75To150,
    sma150To200Distance: row.smaShape.pairDistance.sma150To200,
    sma200To300Distance: row.smaShape.pairDistance.sma200To300,
    sma25To75Convergence: row.smaShape.convergence.sma25To75,
    sma75To150Convergence: row.smaShape.convergence.sma75To150,
    sma150To200Convergence: row.smaShape.convergence.sma150To200,
    sma200To300Convergence: row.smaShape.convergence.sma200To300,
  }
  return {
    eventId: `current:${row.market}:${row.ticker}:${row.sourceGeneration}`,
    ticker: row.ticker,
    signalDate: row.asOfTradingDate,
    sequenceKey: row.stage.sequence3 ?? row.stage.sequence2 ?? row.stage.current,
    cAge: row.stage.cAge,
    sma: shape,
    physical: { ...row.physical.raw, ...row.physical.official },
  }
}
