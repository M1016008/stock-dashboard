import { createHash } from 'node:crypto'
import { mkdir, open, readFile } from 'node:fs/promises'
import { join } from 'node:path'

export type RawEvidence = {
  authority: 'EDINET' | 'JQUANTS' | 'FSA' | 'JPX'
  reference: string
  sha256: string
  byteLength: number
  archivePath: string
}

export type DerivedFact = {
  kind: string
  locator: string
  value: unknown
  rawSourceSha256: string
  factsSha256: string
}

export type PositionLineage = {
  positionKey: string
  decision: unknown
  decisionSha256: string
  facts: DerivedFact[]
}

export const sha256 = (bytes: Uint8Array | string): string =>
  createHash('sha256').update(bytes).digest('hex')

// Content-addressed, create-only storage: a repeated audit verifies bytes instead of replacing them.
export async function archiveOfficialRaw(root: string, authority: RawEvidence['authority'],
  reference: string, bytes: Uint8Array, extension: 'zip' | 'json' | 'html' | 'pdf'): Promise<RawEvidence> {
  if (!bytes.byteLength || bytes.byteLength > 80 * 1024 * 1024) throw new Error('official_raw_size_invalid')
  const digest = sha256(bytes)
  const directory = join(root, authority.toLowerCase())
  const archivePath = join(directory, `${digest}.${extension}`)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  let handle
  try {
    handle = await open(archivePath, 'wx', 0o600)
    await handle.writeFile(bytes)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  } finally {
    await handle?.close()
  }
  const stored = await readFile(archivePath)
  if (sha256(stored) !== digest || stored.byteLength !== bytes.byteLength)
    throw new Error(`official_raw_archive_mismatch:${digest}`)
  return { authority, reference, sha256: digest, byteLength: bytes.byteLength, archivePath }
}

export function derivedFact(kind: string, locator: string, value: unknown,
  source: RawEvidence): DerivedFact {
  if (!kind || !locator || !/^[a-f0-9]{64}$/.test(source.sha256))
    throw new Error('derived_fact_source_invalid')
  return { kind, locator, value, rawSourceSha256: source.sha256,
    factsSha256: sha256(JSON.stringify({ kind, locator, value, rawSourceSha256: source.sha256 })) }
}

export function decisionHash(positionKey: string, decision: unknown,
  facts: readonly DerivedFact[]): string {
  if (!positionKey || !facts.length || facts.some((fact) => fact.factsSha256 !== sha256(JSON.stringify({
    kind: fact.kind, locator: fact.locator, value: fact.value, rawSourceSha256: fact.rawSourceSha256,
  })))) throw new Error('evidence_lineage_broken')
  return sha256(JSON.stringify({ positionKey, decision, factHashes: facts.map((fact) => fact.factsSha256) }))
}

export async function verifyArchivedLineage(sources: readonly RawEvidence[],
  lineages: readonly PositionLineage[]): Promise<boolean> {
  const byHash = new Map<string, RawEvidence>()
  for (const source of sources) {
    const bytes = await readFile(source.archivePath)
    if (!/^[a-f0-9]{64}$/.test(source.sha256) || source.byteLength <= 0
      || bytes.byteLength !== source.byteLength || sha256(bytes) !== source.sha256) return false
    byHash.set(source.sha256, source)
  }
  if (byHash.size === 0 || lineages.length === 0) return false
  const positions = new Set<string>()
  for (const lineage of lineages) {
    if (positions.has(lineage.positionKey) || lineage.facts.some((fact) =>
      !byHash.has(fact.rawSourceSha256))) return false
    positions.add(lineage.positionKey)
    try {
      if (decisionHash(lineage.positionKey, lineage.decision, lineage.facts)
        !== lineage.decisionSha256) return false
    } catch { return false }
  }
  return true
}
