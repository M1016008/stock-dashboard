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

function files(root: string, current = root): string[] {
  return fs.readdirSync(current, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(current, entry.name)
    if (entry.isDirectory()) return files(root, full)
    if (entry.isFile() && path.relative(root, full) !== SMA_RELEASE_MANIFEST) return [full]
    return []
  })
}

export function artifactTreeIdentity(root: string) {
  const digest = createHash('sha256')
  let contentBytes = 0
  const entries = files(root).sort((left, right) => left.localeCompare(right))
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

export function verifySmaReleaseManifest(root: string, expectedCommit: string): SmaReleaseManifest {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, SMA_RELEASE_MANIFEST), 'utf8')) as SmaReleaseManifest
  if (manifest.version !== 1 || manifest.candidateCommit !== expectedCommit) throw new Error('candidate_manifest_identity_mismatch')
  const actual = artifactTreeIdentity(root)
  if (actual.fileCount !== manifest.fileCount || actual.contentBytes !== manifest.contentBytes || actual.treeSha256 !== manifest.treeSha256) {
    throw new Error('candidate_manifest_content_mismatch')
  }
  return manifest
}
