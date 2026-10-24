import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { isSyntheticPath } from '../../lib/synthetic-isolation'

/**
 * Fixture plumbing shared by benchmark generators.
 *
 * Master fixtures are content-addressed by (generator id, generator version,
 * parameters) and live in a stable directory under the internal temp root so a
 * baseline run and an after run read byte-identical data. Workers always run
 * against a copy-on-write clone, never against the master.
 */

export type FixtureParams = Readonly<Record<string, number | string | boolean>>

export interface FixtureSpec {
  /** Generator module name under scripts/bench/fixtures/<id>.ts */
  readonly id: string
  readonly params: FixtureParams
}

export function fixtureRoot(): string {
  const configured = process.env.STOCKBOARD_BENCH_FIXTURE_ROOT?.trim()
  const root = configured
    ? path.resolve(configured)
    : path.join(fs.realpathSync(os.tmpdir()), 'stockboard-bench-fixtures')
  if (configured) assertDevelopmentArtifactRoot(root)
  else if (!isSyntheticPath(root)) throw new Error('fixture root must live on the internal volume')
  fs.mkdirSync(root, { recursive: true })
  return root
}

/** Persistent benchmark artifacts may use only the dedicated OWC development tree. */
export function assertDevelopmentArtifactRoot(candidate: string): void {
  const allowed = '/Volumes/OWC Express 1M2 80G/development'
  const resolved = path.resolve(candidate)
  const relative = path.relative(allowed, resolved)
  if (relative === '' || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`benchmark artifact root must be a child of ${allowed}`)
  }
}

export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right))
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`).join(',')}}`
  }
  return JSON.stringify(value)
}

export function fixtureKey(spec: FixtureSpec, generatorVersion: number): string {
  const digest = createHash('sha256')
    .update(stableStringify({ id: spec.id, version: generatorVersion, params: spec.params }))
    .digest('hex')
    .slice(0, 16)
  return `${spec.id}-v${generatorVersion}-${digest}`
}

export function masterFixturePath(spec: FixtureSpec, generatorVersion: number): string {
  return path.join(fixtureRoot(), fixtureKey(spec, generatorVersion), 'master.db')
}

/** APFS clone (copy-on-write, instant) with a plain-copy fallback. Never follows into /Volumes. */
export function cloneDatabase(source: string, destination: string): void {
  const sourceIsSynthetic = isSyntheticPath(source)
  const sourceIsPersistentFixture = (() => {
    try {
      const relative = path.relative(fixtureRoot(), path.resolve(source))
      return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
    } catch { return false }
  })()
  if ((!sourceIsSynthetic && !sourceIsPersistentFixture) || !isSyntheticPath(destination)) {
    throw new Error('refusing to clone outside the synthetic runtime or dedicated benchmark fixture root')
  }
  fs.mkdirSync(path.dirname(destination), { recursive: true })
  for (const suffix of ['', '-wal', '-shm']) fs.rmSync(`${destination}${suffix}`, { force: true })
  try {
    execFileSync('/bin/cp', ['-c', source, destination], { stdio: 'ignore' })
  } catch {
    fs.copyFileSync(source, destination)
  }
}

/** Deterministic PRNG (mulberry32). Same seed ⇒ same stream on every machine. */
export function createRandom(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export function seedFromString(value: string): number {
  return createHash('sha256').update(value).digest().readUInt32LE(0)
}

export function fileSizeMb(file: string): number {
  return Math.round((fs.statSync(file).size / 1024 ** 2) * 10) / 10
}
