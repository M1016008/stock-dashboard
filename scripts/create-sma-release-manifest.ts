import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { artifactTreeIdentity, SMA_RELEASE_MANIFEST, type SmaReleaseManifest } from '@/lib/release/artifact-manifest'

const artifact = path.resolve(process.argv[2] || process.env.STOCKBOARD_RELEASE_ARTIFACT || '')
if (!path.isAbsolute(artifact) || !fs.existsSync(path.join(artifact, 'BUILD_ID'))) {
  throw new Error('usage: npm run release:sma-manifest -- /absolute/path/to/build')
}
const status = execFileSync('/usr/bin/git', ['status', '--porcelain'], { encoding: 'utf8' }).trim()
if (status) throw new Error('candidate_worktree_must_be_clean')
const candidateCommit = execFileSync('/usr/bin/git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
const identity = artifactTreeIdentity(artifact)
const manifest: SmaReleaseManifest = {
  version: 1,
  candidateCommit,
  baselineCommit: '034310b72f57163ee4607c05d1057310277a787d',
  buildId: fs.readFileSync(path.join(artifact, 'BUILD_ID'), 'utf8').trim(),
  ...identity,
}
fs.writeFileSync(path.join(artifact, SMA_RELEASE_MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o444 })
console.log(JSON.stringify(manifest))
