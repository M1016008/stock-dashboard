import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import {
  CURRENT_SERVING_PROJECTION_DEFINITION_VERSION,
  CURRENT_SERVING_PROJECTION_MAX_BYTES,
  CURRENT_SERVING_PROJECTION_MAX_ROWS,
  assertCurrentServingProjectionPayload,
  type CurrentServingMarket,
  type CurrentServingProjectionPayload,
  type CurrentServingProjectionRow,
} from '@/lib/research/six-stage-current-serving-projection'

type ProjectionManifest = {
  kind: 'stockboard-six-stage-current-serving-projection-manifest'
  status: 'COMPLETE'
  generationId: string
  projectionSha256: string
  projectionBytes: number
  rows: number
  definitionVersion: string
  marketWatermarks: CurrentServingProjectionPayload['marketWatermarks']
}

export type CurrentServingMarketStage = {
  kind: 'stockboard-six-stage-current-serving-market-stage'
  status: 'COMPLETE'
  market: CurrentServingMarket
  stagedAt: string
  definitionVersion: typeof CURRENT_SERVING_PROJECTION_DEFINITION_VERSION
  watermark: CurrentServingProjectionPayload['marketWatermarks'][CurrentServingMarket]
  rows: CurrentServingProjectionRow[]
}

export const CURRENT_SERVING_PROJECTION_DEFAULT_MAX_STAGE_AGE_MS = 8 * 24 * 60 * 60 * 1_000
export const CURRENT_SERVING_PROJECTION_DEFAULT_MAX_AS_OF_AGE_MS = 8 * 24 * 60 * 60 * 1_000
export const CURRENT_SERVING_PROJECTION_DEFAULT_MAX_MARKET_SKEW_MS = 4 * 24 * 60 * 60 * 1_000

type MarketStageManifest = {
  kind: 'stockboard-six-stage-current-serving-market-stage-manifest'
  status: 'COMPLETE'
  market: CurrentServingMarket
  sourceGeneration: string
  stageSha256: string
  stageBytes: number
  rows: number
  definitionVersion: string
}

function sha256(value: Buffer | string): string {
  return crypto.createHash('sha256').update(value).digest('hex')
}

function generationDirectory(root: string, generationId: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(generationId)) {
    throw new Error('CURRENT_PROJECTION_INVALID_GENERATION')
  }
  return path.join(path.resolve(root), 'generations', generationId)
}

function marketStageDirectory(root: string, market: CurrentServingMarket, sourceGeneration: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(sourceGeneration)) {
    throw new Error('CURRENT_PROJECTION_INVALID_GENERATION')
  }
  return path.join(path.resolve(root), 'market-stages', market, 'generations', sourceGeneration)
}

function writeDurable(filePath: string, value: string): void {
  const descriptor = fs.openSync(filePath, 'wx', 0o600)
  try {
    fs.writeFileSync(descriptor, value, 'utf8')
    fs.fsyncSync(descriptor)
  } finally {
    fs.closeSync(descriptor)
  }
}

function syncDirectory(directory: string): void {
  const descriptor = fs.openSync(directory, 'r')
  try { fs.fsyncSync(descriptor) } finally { fs.closeSync(descriptor) }
}

function replacePointer(root: string, name: string, value: Record<string, string>): void {
  const temporary = path.join(root, `.${name}.${process.pid}.${crypto.randomUUID()}.tmp`)
  writeDurable(temporary, `${JSON.stringify(value)}\n`)
  fs.renameSync(temporary, path.join(root, name))
  syncDirectory(root)
}

function projectionComparable(payload: CurrentServingProjectionPayload): unknown {
  const { generatedAt: _generatedAt, ...comparable } = payload
  return comparable
}

function stageComparable(stage: CurrentServingMarketStage): unknown {
  const { stagedAt: _stagedAt, ...comparable } = stage
  return comparable
}

function readProjectionGeneration(input: {
  root: string
  generationId: string
  maxRows?: number
  maxBytes?: number
}): { payload: CurrentServingProjectionPayload; manifest: ProjectionManifest } {
  const directory = generationDirectory(input.root, input.generationId)
  const maxBytes = input.maxBytes ?? CURRENT_SERVING_PROJECTION_MAX_BYTES
  const projectionPath = path.join(directory, 'projection.json')
  if (fs.statSync(projectionPath).size > maxBytes) throw new Error('CURRENT_PROJECTION_BYTE_LIMIT')
  const projectionBuffer = fs.readFileSync(projectionPath)
  const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'COMPLETE.manifest.json'), 'utf8')) as ProjectionManifest
  if (
    manifest.kind !== 'stockboard-six-stage-current-serving-projection-manifest'
    || manifest.status !== 'COMPLETE'
    || manifest.generationId !== input.generationId
    || manifest.projectionBytes !== projectionBuffer.byteLength
    || manifest.projectionSha256 !== sha256(projectionBuffer)
  ) {
    throw new Error('CURRENT_PROJECTION_MANIFEST_MISMATCH')
  }
  const payload = JSON.parse(projectionBuffer.toString('utf8')) as CurrentServingProjectionPayload
  assertCurrentServingProjectionPayload(payload, { maxRows: input.maxRows, maxBytes })
  if (
    payload.generationId !== input.generationId
    || manifest.rows !== payload.rows.length
    || manifest.definitionVersion !== payload.definitionVersion
    || JSON.stringify(manifest.marketWatermarks) !== JSON.stringify(payload.marketWatermarks)
  ) {
    throw new Error('CURRENT_PROJECTION_MANIFEST_MISMATCH')
  }
  return { payload, manifest }
}

function readMarketStageGeneration(input: {
  root: string
  market: CurrentServingMarket
  sourceGeneration: string
}): { stage: CurrentServingMarketStage; manifest: MarketStageManifest } {
  const directory = marketStageDirectory(input.root, input.market, input.sourceGeneration)
  const buffer = fs.readFileSync(path.join(directory, 'stage.json'))
  if (buffer.byteLength > CURRENT_SERVING_PROJECTION_MAX_BYTES) throw new Error('CURRENT_PROJECTION_BYTE_LIMIT')
  const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'COMPLETE.manifest.json'), 'utf8')) as MarketStageManifest
  if (
    manifest.kind !== 'stockboard-six-stage-current-serving-market-stage-manifest'
    || manifest.status !== 'COMPLETE'
    || manifest.market !== input.market
    || manifest.sourceGeneration !== input.sourceGeneration
    || manifest.stageBytes !== buffer.byteLength
    || manifest.stageSha256 !== sha256(buffer)
  ) {
    throw new Error('CURRENT_PROJECTION_MARKET_MANIFEST_MISMATCH')
  }
  const stage = JSON.parse(buffer.toString('utf8')) as CurrentServingMarketStage
  assertMarketStage(stage)
  if (
    stage.market !== input.market
    || stage.watermark.sourceGeneration !== input.sourceGeneration
    || stage.rows.length !== manifest.rows
    || stage.definitionVersion !== manifest.definitionVersion
  ) {
    throw new Error('CURRENT_PROJECTION_MARKET_MANIFEST_MISMATCH')
  }
  return { stage, manifest }
}

export function publishCurrentServingProjection(input: {
  root: string
  payload: CurrentServingProjectionPayload
  beforePublish?: () => void
}): { generationDirectory: string; manifest: ProjectionManifest } {
  assertCurrentServingProjectionPayload(input.payload)
  const root = path.resolve(input.root)
  const generations = path.join(root, 'generations')
  fs.mkdirSync(generations, { recursive: true, mode: 0o700 })
  const destination = generationDirectory(root, input.payload.generationId)
  if (fs.existsSync(destination)) {
    const existing = readProjectionGeneration({ root, generationId: input.payload.generationId })
    if (JSON.stringify(projectionComparable(existing.payload)) !== JSON.stringify(projectionComparable(input.payload))) {
      throw new Error('CURRENT_PROJECTION_GENERATION_EXISTS')
    }
    replacePointer(root, 'CURRENT.json', { generationId: input.payload.generationId })
    return { generationDirectory: destination, manifest: existing.manifest }
  }
  const temporary = `${destination}.partial-${process.pid}-${crypto.randomUUID()}`
  fs.mkdirSync(temporary, { mode: 0o700 })
  try {
    const projection = `${JSON.stringify(input.payload)}\n`
    const projectionBytes = Buffer.byteLength(projection)
    if (projectionBytes > CURRENT_SERVING_PROJECTION_MAX_BYTES) throw new Error('CURRENT_PROJECTION_BYTE_LIMIT')
    const manifest: ProjectionManifest = {
      kind: 'stockboard-six-stage-current-serving-projection-manifest',
      status: 'COMPLETE',
      generationId: input.payload.generationId,
      projectionSha256: sha256(projection),
      projectionBytes,
      rows: input.payload.rows.length,
      definitionVersion: input.payload.definitionVersion,
      marketWatermarks: input.payload.marketWatermarks,
    }
    writeDurable(path.join(temporary, 'projection.json'), projection)
    writeDurable(path.join(temporary, 'COMPLETE.manifest.json'), `${JSON.stringify(manifest)}\n`)
    syncDirectory(temporary)
    input.beforePublish?.()
    fs.renameSync(temporary, destination)
    syncDirectory(generations)

    replacePointer(root, 'CURRENT.json', { generationId: input.payload.generationId })
    return { generationDirectory: destination, manifest }
  } catch (error) {
    fs.rmSync(temporary, { recursive: true, force: true })
    throw error
  }
}

function assertMarketStage(stage: CurrentServingMarketStage): void {
  if (stage.kind !== 'stockboard-six-stage-current-serving-market-stage' || stage.status !== 'COMPLETE') {
    throw new Error('CURRENT_PROJECTION_MARKET_STAGE_INCOMPLETE')
  }
  if (stage.definitionVersion !== CURRENT_SERVING_PROJECTION_DEFINITION_VERSION) {
    throw new Error('CURRENT_PROJECTION_DEFINITION_MISMATCH')
  }
  if (stage.rows.length < 1 || stage.rows.length > CURRENT_SERVING_PROJECTION_MAX_ROWS) {
    throw new Error('CURRENT_PROJECTION_ROW_LIMIT')
  }
  if (stage.watermark.rows !== stage.rows.length) throw new Error('CURRENT_PROJECTION_MARKET_ROW_MISMATCH')
  for (const row of stage.rows) {
    if (
      row.market !== stage.market
      || row.asOfTradingDate !== stage.watermark.asOfTradingDate
      || row.sourceGeneration !== stage.watermark.sourceGeneration
      || row.definitionVersion !== stage.definitionVersion
    ) {
      throw new Error('CURRENT_PROJECTION_GENERATION_MISMATCH')
    }
  }
}

export function stageCurrentServingMarket(input: {
  root: string
  stage: CurrentServingMarketStage
  beforeSelect?: () => void
}): { stageDirectory: string; manifest: MarketStageManifest } {
  assertMarketStage(input.stage)
  const root = path.resolve(input.root)
  const stagesRoot = path.join(root, 'market-stages', input.stage.market)
  fs.mkdirSync(path.join(stagesRoot, 'generations'), { recursive: true, mode: 0o700 })
  const destination = marketStageDirectory(root, input.stage.market, input.stage.watermark.sourceGeneration)
  if (fs.existsSync(destination)) {
    const existing = readMarketStageGeneration({
      root,
      market: input.stage.market,
      sourceGeneration: input.stage.watermark.sourceGeneration,
    })
    if (JSON.stringify(stageComparable(existing.stage)) !== JSON.stringify(stageComparable(input.stage))) {
      throw new Error('CURRENT_PROJECTION_MARKET_STAGE_EXISTS')
    }
    replacePointer(stagesRoot, 'CURRENT.json', { sourceGeneration: input.stage.watermark.sourceGeneration })
    return { stageDirectory: destination, manifest: existing.manifest }
  }
  const temporary = `${destination}.partial-${process.pid}-${crypto.randomUUID()}`
  fs.mkdirSync(temporary, { mode: 0o700 })
  try {
    const serialized = `${JSON.stringify(input.stage)}\n`
    const stageBytes = Buffer.byteLength(serialized)
    if (stageBytes > CURRENT_SERVING_PROJECTION_MAX_BYTES) throw new Error('CURRENT_PROJECTION_BYTE_LIMIT')
    const manifest: MarketStageManifest = {
      kind: 'stockboard-six-stage-current-serving-market-stage-manifest',
      status: 'COMPLETE',
      market: input.stage.market,
      sourceGeneration: input.stage.watermark.sourceGeneration,
      stageSha256: sha256(serialized),
      stageBytes,
      rows: input.stage.rows.length,
      definitionVersion: input.stage.definitionVersion,
    }
    writeDurable(path.join(temporary, 'stage.json'), serialized)
    writeDurable(path.join(temporary, 'COMPLETE.manifest.json'), `${JSON.stringify(manifest)}\n`)
    syncDirectory(temporary)
    input.beforeSelect?.()
    fs.renameSync(temporary, destination)
    syncDirectory(path.join(stagesRoot, 'generations'))
    replacePointer(stagesRoot, 'CURRENT.json', { sourceGeneration: input.stage.watermark.sourceGeneration })
    return { stageDirectory: destination, manifest }
  } catch (error) {
    fs.rmSync(temporary, { recursive: true, force: true })
    throw error
  }
}

export function readCurrentServingMarketStage(input: {
  root: string
  market: CurrentServingMarket
}): CurrentServingMarketStage {
  const stagesRoot = path.join(path.resolve(input.root), 'market-stages', input.market)
  const pointer = JSON.parse(fs.readFileSync(path.join(stagesRoot, 'CURRENT.json'), 'utf8')) as {
    sourceGeneration?: unknown
  }
  if (typeof pointer.sourceGeneration !== 'string') throw new Error('CURRENT_PROJECTION_MARKET_POINTER_INVALID')
  return readMarketStageGeneration({
    root: input.root,
    market: input.market,
    sourceGeneration: pointer.sourceGeneration,
  }).stage
}

function combinedGenerationId(stages: CurrentServingMarketStage[]): string {
  const identity = stages.map((stage) => ({
    market: stage.market,
    sourceGeneration: stage.watermark.sourceGeneration,
    asOfTradingDate: stage.watermark.asOfTradingDate,
    priceBasis: stage.watermark.priceBasis,
    featureSet: stage.watermark.featureSet,
  }))
  return `current-${sha256(JSON.stringify(identity)).slice(0, 32)}`
}

function tradingDateMs(value: string): number {
  return Date.parse(`${value}T23:59:59.999Z`)
}

function assertMarketStageFresh(
  stage: CurrentServingMarketStage,
  now: Date,
  maxStageAgeMs: number,
  maxAsOfAgeMs: number,
): void {
  if (
    !Number.isFinite(maxStageAgeMs)
    || maxStageAgeMs <= 0
    || !Number.isFinite(maxAsOfAgeMs)
    || maxAsOfAgeMs <= 0
  ) {
    throw new Error('CURRENT_PROJECTION_INVALID_FRESHNESS_LIMIT')
  }
  const stagedAt = Date.parse(stage.stagedAt)
  const asOf = tradingDateMs(stage.watermark.asOfTradingDate)
  const nowMs = now.getTime()
  if (
    !Number.isFinite(stagedAt)
    || !Number.isFinite(asOf)
    || stagedAt > nowMs + 5 * 60_000
    || asOf > nowMs + 24 * 60 * 60_000
    || nowMs - stagedAt > maxStageAgeMs
    || nowMs - asOf > maxAsOfAgeMs
  ) {
    throw new Error(`CURRENT_PROJECTION_STALE_MARKET_STAGE:${stage.market}`)
  }
}

export function assertCurrentServingProjectionFreshness(
  payload: CurrentServingProjectionPayload,
  options: {
    now?: Date
    maxAsOfAgeMs?: number
    maxMarketSkewMs?: number
  } = {},
): void {
  const now = options.now ?? new Date()
  const maxAsOfAgeMs = options.maxAsOfAgeMs ?? CURRENT_SERVING_PROJECTION_DEFAULT_MAX_AS_OF_AGE_MS
  const maxMarketSkewMs = options.maxMarketSkewMs ?? CURRENT_SERVING_PROJECTION_DEFAULT_MAX_MARKET_SKEW_MS
  if (!Number.isFinite(maxAsOfAgeMs) || maxAsOfAgeMs <= 0 || !Number.isFinite(maxMarketSkewMs) || maxMarketSkewMs < 0) {
    throw new Error('CURRENT_PROJECTION_INVALID_FRESHNESS_LIMIT')
  }
  const dates = (['JP', 'US'] as const).map((market) => ({
    market,
    value: tradingDateMs(payload.marketWatermarks[market].asOfTradingDate),
  }))
  for (const item of dates) {
    if (
      !Number.isFinite(item.value)
      || item.value > now.getTime() + 24 * 60 * 60_000
      || now.getTime() - item.value > maxAsOfAgeMs
    ) {
      throw new Error(`CURRENT_PROJECTION_STALE_MARKET_AS_OF:${item.market}`)
    }
  }
  if (Math.abs(dates[0].value - dates[1].value) > maxMarketSkewMs) {
    throw new Error('CURRENT_PROJECTION_MARKET_AS_OF_SKEW')
  }
}

export function publishCurrentServingProjectionFromStages(input: {
  root: string
  now?: () => Date
  beforePublish?: () => void
  maxStageAgeMs?: number
  maxAsOfAgeMs?: number
  maxMarketSkewMs?: number
}): { generationDirectory: string; manifest: ProjectionManifest; alreadyPublished: boolean } {
  const stages = (['JP', 'US'] as const).map((market) => readCurrentServingMarketStage({ root: input.root, market }))
  const now = (input.now ?? (() => new Date()))()
  const maxStageAgeMs = input.maxStageAgeMs ?? CURRENT_SERVING_PROJECTION_DEFAULT_MAX_STAGE_AGE_MS
  const maxAsOfAgeMs = input.maxAsOfAgeMs ?? CURRENT_SERVING_PROJECTION_DEFAULT_MAX_AS_OF_AGE_MS
  stages.forEach((stage) => assertMarketStageFresh(stage, now, maxStageAgeMs, maxAsOfAgeMs))
  const generationId = combinedGenerationId(stages)
  const currentPointer = path.join(path.resolve(input.root), 'CURRENT.json')
  if (fs.existsSync(currentPointer)) {
    const current = JSON.parse(fs.readFileSync(currentPointer, 'utf8')) as { generationId?: unknown }
    if (current.generationId === generationId) {
      const payload = readCurrentServingProjection({ root: input.root, expectedGenerationId: generationId })
      const manifest = JSON.parse(fs.readFileSync(
        path.join(generationDirectory(input.root, generationId), 'COMPLETE.manifest.json'),
        'utf8',
      )) as ProjectionManifest
      if (payload.rows.length !== manifest.rows) throw new Error('CURRENT_PROJECTION_MANIFEST_MISMATCH')
      return { generationDirectory: generationDirectory(input.root, generationId), manifest, alreadyPublished: true }
    }
  }
  const byMarket = Object.fromEntries(stages.map((stage) => [stage.market, stage])) as Record<CurrentServingMarket, CurrentServingMarketStage>
  const payload: CurrentServingProjectionPayload = {
    kind: 'stockboard-six-stage-current-serving-projection',
    status: 'COMPLETE',
    generationId,
    generatedAt: now.toISOString(),
    definitionVersion: CURRENT_SERVING_PROJECTION_DEFINITION_VERSION,
    source: 'SERVING_UPDATE_CHAIN',
    marketWatermarks: {
      JP: byMarket.JP.watermark,
      US: byMarket.US.watermark,
    },
    rows: [...byMarket.JP.rows, ...byMarket.US.rows],
  }
  assertCurrentServingProjectionFreshness(payload, {
    now,
    maxAsOfAgeMs,
    maxMarketSkewMs: input.maxMarketSkewMs,
  })
  const published = publishCurrentServingProjection({
    root: input.root,
    payload,
    beforePublish: input.beforePublish,
  })
  return { ...published, alreadyPublished: false }
}

export function readCurrentServingProjection(input: {
  root: string
  expectedGenerationId?: string
  maxRows?: number
  maxBytes?: number
}): CurrentServingProjectionPayload {
  const root = path.resolve(input.root)
  const pointer = JSON.parse(fs.readFileSync(path.join(root, 'CURRENT.json'), 'utf8')) as { generationId?: unknown }
  if (typeof pointer.generationId !== 'string') throw new Error('CURRENT_PROJECTION_POINTER_INVALID')
  if (input.expectedGenerationId && pointer.generationId !== input.expectedGenerationId) {
    throw new Error('CURRENT_PROJECTION_GENERATION_MISMATCH')
  }
  return readProjectionGeneration({
    root,
    generationId: pointer.generationId,
    maxRows: input.maxRows,
    maxBytes: input.maxBytes,
  }).payload
}
