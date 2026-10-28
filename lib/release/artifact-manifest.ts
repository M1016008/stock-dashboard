import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

export const SMA_RELEASE_MANIFEST = 'SMA_RELEASE_MANIFEST.json'

export interface SmaReleaseManifest {
  version: 1
  candidateCommit: string
  baselineCommit: string
  buildId: string
  fileCount: number
  contentBytes: number
  treeSha256: string
}

function files(root: string, current = root, ignoreRuntimeCache = false): string[] {
  return fs.readdirSync(current, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(current, entry.name)
    const relative = path.relative(root, full)
    if (ignoreRuntimeCache && relative === path.join('server', 'route-cache')) return []
    if (entry.isDirectory()) return files(root, full, ignoreRuntimeCache)
    if (entry.isFile() && path.relative(root, full) !== SMA_RELEASE_MANIFEST) return [full]
    return []
  })
}

function treeIdentity(root: string, ignoreRuntimeCache: boolean) {
  const digest = createHash('sha256')
  let contentBytes = 0
  const entries = files(root, root, ignoreRuntimeCache).sort((left, right) => left.localeCompare(right))
  for (const file of entries) {
    const relative = path.relative(root, file)
    const content = fs.readFileSync(file)
    digest.update(relative)
    digest.update('\0')
    digest.update(String(content.length))
    digest.update('\0')
    digest.update(content)
    contentBytes += content.length
  }
  return { fileCount: entries.length, contentBytes, treeSha256: digest.digest('hex') }
}

/** Exact immutable artifact identity used to create and verify a release manifest. */
export function artifactTreeIdentity(root: string) {
  return treeIdentity(root, false)
}

/**
 * Active Next.js generations may create server/route-cache after startup.
 * Keep that documented runtime cache outside generation identity while every
 * shipped artifact file remains covered by the release manifest hash.
 */
export function activeArtifactTreeIdentity(root: string) {
  return treeIdentity(root, true)
}

export function verifySmaReleaseManifest(root: string, expectedCommit: string): SmaReleaseManifest {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, SMA_RELEASE_MANIFEST), 'utf8')) as SmaReleaseManifest
  if (manifest.version !== 1 || manifest.candidateCommit !== expectedCommit) throw new Error('candidate_manifest_identity_mismatch')
  const actual = artifactTreeIdentity(root)
  if (actual.fileCount !== manifest.fileCount || actual.contentBytes !== manifest.contentBytes || actual.treeSha256 !== manifest.treeSha256) {
    throw new Error('candidate_manifest_content_mismatch')
  }
  return manifest
}
