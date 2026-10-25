import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import {
  CURRENT_SERVING_PROJECTION_MAX_BYTES,
  assertCurrentServingProjectionPayload,
  type CurrentServingProjectionPayload,
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

function sha256(value: Buffer | string): string {
  return crypto.createHash('sha256').update(value).digest('hex')
}

function generationDirectory(root: string, generationId: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(generationId)) {
    throw new Error('CURRENT_PROJECTION_INVALID_GENERATION')
  }
  return path.join(path.resolve(root), 'generations', generationId)
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
  if (fs.existsSync(destination)) throw new Error('CURRENT_PROJECTION_GENERATION_EXISTS')
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

    const pointerTemporary = path.join(root, `.CURRENT.${process.pid}.${crypto.randomUUID()}.tmp`)
    writeDurable(pointerTemporary, `${JSON.stringify({ generationId: input.payload.generationId })}\n`)
    fs.renameSync(pointerTemporary, path.join(root, 'CURRENT.json'))
    syncDirectory(root)
    return { generationDirectory: destination, manifest }
  } catch (error) {
    fs.rmSync(temporary, { recursive: true, force: true })
    throw error
  }
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
  const directory = generationDirectory(root, pointer.generationId)
  const maxBytes = input.maxBytes ?? CURRENT_SERVING_PROJECTION_MAX_BYTES
  const projectionPath = path.join(directory, 'projection.json')
  if (fs.statSync(projectionPath).size > maxBytes) throw new Error('CURRENT_PROJECTION_BYTE_LIMIT')
  const projectionBuffer = fs.readFileSync(projectionPath)
  if (projectionBuffer.byteLength > maxBytes) throw new Error('CURRENT_PROJECTION_BYTE_LIMIT')
  const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'COMPLETE.manifest.json'), 'utf8')) as ProjectionManifest
  if (manifest.kind !== 'stockboard-six-stage-current-serving-projection-manifest'
    || manifest.status !== 'COMPLETE'
    || manifest.generationId !== pointer.generationId
    || manifest.projectionBytes !== projectionBuffer.byteLength
    || manifest.projectionSha256 !== sha256(projectionBuffer)) {
    throw new Error('CURRENT_PROJECTION_MANIFEST_MISMATCH')
  }
  const payload = JSON.parse(projectionBuffer.toString('utf8')) as CurrentServingProjectionPayload
  assertCurrentServingProjectionPayload(payload, { maxRows: input.maxRows, maxBytes })
  if (payload.generationId !== pointer.generationId
    || manifest.rows !== payload.rows.length
    || manifest.definitionVersion !== payload.definitionVersion
    || JSON.stringify(manifest.marketWatermarks) !== JSON.stringify(payload.marketWatermarks)) {
    throw new Error('CURRENT_PROJECTION_MANIFEST_MISMATCH')
  }
  return payload
}
