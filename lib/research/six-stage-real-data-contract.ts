import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import {
  assertEventPathStoreManifest,
  type EventPathStoreManifest,
} from '@/lib/research/six-stage-event-path-store'

export const SIX_STAGE_REAL_RESEARCH_ROOT = '/Volumes/OWC Express 1M2 80G/stockboard-research/six-stage'
export const SIX_STAGE_SOURCE_ADOPTION_SHA256 = '0818db168c843bb79971b704e66f3a488d9187da4d000d73745ecb9de7a7168c'
export const SIX_STAGE_DISTRIBUTION_SHA256 = '7816ea37f84687178cf652a3e1dbfbad4eddbf7f48bb196720d7ccd28ce6ab6e'

export type SixStageRealMarket = 'JP' | 'US'

export type SixStageRealMarketInput = {
  market: SixStageRealMarket
  eventStoreDirectory: string
  eventStorePath: string
  eventStoreManifestPath: string
  expectedEventStoreSha256: string
  f1Directory: string
  f1Path: string
  f1ManifestPath: string
  expectedEvents: number
}

export const SIX_STAGE_REAL_INPUTS: Record<SixStageRealMarket, SixStageRealMarketInput> = {
  JP: {
    market: 'JP',
    eventStoreDirectory: path.join(SIX_STAGE_REAL_RESEARCH_ROOT, 'event-path-stores', 'E039-JP-event-path-v3-real-20261025'),
    eventStorePath: path.join(SIX_STAGE_REAL_RESEARCH_ROOT, 'event-path-stores', 'E039-JP-event-path-v3-real-20261025', 'event-paths.sqlite'),
    eventStoreManifestPath: path.join(SIX_STAGE_REAL_RESEARCH_ROOT, 'event-path-stores', 'E039-JP-event-path-v3-real-20261025', 'manifest.json'),
    expectedEventStoreSha256: '75c8f0f6c0288904f86a4bb11c909351d6b53c7a5c59c53de08c0cec816f1a42',
    f1Directory: path.join(SIX_STAGE_REAL_RESEARCH_ROOT, 'v5-max-r016', 'F1-JP-feature-only'),
    f1Path: path.join(SIX_STAGE_REAL_RESEARCH_ROOT, 'v5-max-r016', 'F1-JP-feature-only', 'features.sqlite'),
    f1ManifestPath: path.join(SIX_STAGE_REAL_RESEARCH_ROOT, 'v5-max-r016', 'F1-JP-feature-only', 'manifest.json'),
    expectedEvents: 3_301_583,
  },
  US: {
    market: 'US',
    eventStoreDirectory: path.join(SIX_STAGE_REAL_RESEARCH_ROOT, 'event-path-stores', 'E043-US-event-path-v3-real-20261025'),
    eventStorePath: path.join(SIX_STAGE_REAL_RESEARCH_ROOT, 'event-path-stores', 'E043-US-event-path-v3-real-20261025', 'event-paths.sqlite'),
    eventStoreManifestPath: path.join(SIX_STAGE_REAL_RESEARCH_ROOT, 'event-path-stores', 'E043-US-event-path-v3-real-20261025', 'manifest.json'),
    expectedEventStoreSha256: '1eec5dc7115d9928ca90df96756d27a19c51ea0363a6cf8830e606885e860891',
    f1Directory: path.join(SIX_STAGE_REAL_RESEARCH_ROOT, 'v5-max-r016', 'F1-US-feature-only'),
    f1Path: path.join(SIX_STAGE_REAL_RESEARCH_ROOT, 'v5-max-r016', 'F1-US-feature-only', 'features.sqlite'),
    f1ManifestPath: path.join(SIX_STAGE_REAL_RESEARCH_ROOT, 'v5-max-r016', 'F1-US-feature-only', 'manifest.json'),
    expectedEvents: 7_878_096,
  },
}

export const SIX_STAGE_REAL_ANALYSIS_DIRECTORY = path.join(
  SIX_STAGE_REAL_RESEARCH_ROOT,
  'event-path-stores',
  'E039-E043-real-pattern-analysis-v1-20261026',
)

export const SIX_STAGE_REAL_ANALYSIS_SCHEMA_VERSION = 1
export const SIX_STAGE_REAL_ANALYSIS_NAMESPACE = 'SIX_STAGE_REAL_PATTERN_ANALYSIS_V1'

export function sha256File(filePath: string): string {
  const hash = createHash('sha256')
  const file = fs.openSync(filePath, 'r')
  const buffer = Buffer.allocUnsafe(8 * 1024 * 1024)
  try {
    for (;;) {
      const read = fs.readSync(file, buffer, 0, buffer.length, null)
      if (read === 0) break
      hash.update(buffer.subarray(0, read))
    }
  } finally {
    fs.closeSync(file)
  }
  return hash.digest('hex')
}

export function assertSixStageRealInput(market: SixStageRealMarket): EventPathStoreManifest {
  const input = SIX_STAGE_REAL_INPUTS[market]
  for (const requiredPath of [
    input.eventStorePath,
    input.eventStoreManifestPath,
    input.f1Path,
    input.f1ManifestPath,
  ]) {
    if (!fs.existsSync(requiredPath)) throw new Error(`six-stage real input missing: ${requiredPath}`)
  }
  const manifest = JSON.parse(fs.readFileSync(input.eventStoreManifestPath, 'utf8')) as EventPathStoreManifest
  assertEventPathStoreManifest(manifest)
  if (
    manifest.market !== market
    || manifest.rows.events !== input.expectedEvents
    || manifest.file.sha256 !== input.expectedEventStoreSha256
    || manifest.source.reconciliationManifestSha256 !== SIX_STAGE_SOURCE_ADOPTION_SHA256
  ) {
    throw new Error(`six-stage ${market} fixed input mismatch`)
  }
  const stat = fs.statSync(input.eventStorePath)
  if (stat.size !== manifest.file.bytes) throw new Error(`six-stage ${market} event store size mismatch`)
  const f1ManifestSha256 = sha256File(input.f1ManifestPath)
  if (f1ManifestSha256 !== manifest.source.f1ManifestSha256) {
    throw new Error(`six-stage ${market} F1 manifest hash mismatch`)
  }
  return manifest
}

export function assertResearchOnlyExecution(): void {
  if (process.env.SIX_STAGE_REAL_RESEARCH_ONLY !== '1') {
    throw new Error('SIX_STAGE_REAL_RESEARCH_ONLY=1 is required')
  }
  if (!fs.existsSync(SIX_STAGE_REAL_RESEARCH_ROOT)) {
    throw new Error('approved OWC six-stage research root is not mounted')
  }
  const resolved = fs.realpathSync(SIX_STAGE_REAL_RESEARCH_ROOT)
  if (!resolved.startsWith('/Volumes/OWC Express 1M2 80G/')) {
    throw new Error('six-stage research root is outside approved OWC volume')
  }
}
