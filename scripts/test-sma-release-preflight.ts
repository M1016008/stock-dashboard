import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  currentPreflightStateSha256,
  sha256File,
  verifySmaReleasePreflightProof,
  type PreflightAttestation,
  type SmaReleasePreflightProof,
} from '@/lib/release/preflight-proof'

const CANDIDATE = '8a780f8d4c962b59a46b41e047d809becb9f6929'
const BASELINE = '034310b72f57163ee4607c05d1057310277a787d'
const BUILD = 'haU9QbrK4mJdgiaOFUA0G'
const ARTIFACT = '6e6a4912dc629cac4f1c7fda8b20a7fb04b97987f994127b32936ca9580965c4'
const RUNTIME = '5dce40ed56648e54d064bd823d7773f71de6159d85a20e95cfa889baa9767f92'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sma-preflight-'))
const state = path.join(root, 'state')
const runtime = path.join(root, 'runtime')
fs.mkdirSync(state)
fs.mkdirSync(path.join(runtime, 'node_modules'), { recursive: true })
fs.symlinkSync(path.join(runtime, 'node_modules'), path.join(root, 'node_modules'))

const file = (name: string, content = name) => {
  const target = path.join(state, name)
  fs.writeFileSync(target, content)
  return target
}
const files = {
  runtimeManifest: file('runtime-manifest.json'),
  jpSource: file('jp-source.json'),
  usSource: file('us-source.json'),
  jpServing: file('jp-serving.json'),
  usServing: file('us-serving.json'),
  priceBasis: file('price-basis.json'),
  storage: file('storage.json'),
  web: file('web-health.json'),
  analog: file('analog-health.json'),
  freshness: file('freshness-health.json'),
}
const failedSafe = path.join(state, 'FAILED_SAFE')
const writerLock = path.join(state, 'writer.lock')
const journal = path.join(state, 'promotion-journal.json')

const attestations: PreflightAttestation[] = [
  { purpose: 'runtime-link', path: path.join(root, 'node_modules'), kind: 'symlink', target: path.join(runtime, 'node_modules') },
  { purpose: 'runtime-manifest', path: files.runtimeManifest, kind: 'file-sha256', sha256: sha256File(files.runtimeManifest) },
  { purpose: 'jp-source-generation', path: files.jpSource, kind: 'file-sha256', sha256: sha256File(files.jpSource) },
  { purpose: 'us-source-generation', path: files.usSource, kind: 'file-sha256', sha256: sha256File(files.usSource) },
  { purpose: 'jp-serving-generation', path: files.jpServing, kind: 'file-sha256', sha256: sha256File(files.jpServing) },
  { purpose: 'us-serving-generation', path: files.usServing, kind: 'file-sha256', sha256: sha256File(files.usServing) },
  { purpose: 'price-basis', path: files.priceBasis, kind: 'file-sha256', sha256: sha256File(files.priceBasis) },
  { purpose: 'storage-guard', path: files.storage, kind: 'file-sha256', sha256: sha256File(files.storage) },
  { purpose: 'failed-safe', path: failedSafe, kind: 'absent' },
  { purpose: 'writer-lock', path: writerLock, kind: 'absent' },
  { purpose: 'promotion-journal', path: journal, kind: 'absent' },
  { purpose: 'web-health', path: files.web, kind: 'file-sha256', sha256: sha256File(files.web) },
  { purpose: 'analog-health', path: files.analog, kind: 'file-sha256', sha256: sha256File(files.analog) },
  { purpose: 'freshness-health', path: files.freshness, kind: 'file-sha256', sha256: sha256File(files.freshness) },
]

function proof(overrides: Partial<SmaReleasePreflightProof> = {}): SmaReleasePreflightProof {
  const issued = new Date('2026-10-28T00:00:00.000Z')
  return {
    version: 1,
    issuedAt: issued.toISOString(),
    expiresAt: new Date(issued.getTime() + 15 * 60_000).toISOString(),
    baselineCommit: BASELINE,
    candidate: { commit: CANDIDATE, buildId: BUILD, artifactTreeSha256: ARTIFACT },
    runtime: {
      nodeModulesTarget: path.join(runtime, 'node_modules'), identitySha256: RUNTIME,
      manifestSha256: sha256File(files.runtimeManifest), lockSha256: '1'.repeat(64),
    },
    priceBasis: 'tiingo_adj_ohlc_ratio_v1',
    sourceGeneration: { JP: 'jp-source-1', US: 'us-source-1' },
    servingGeneration: { JP: 'jp-serving-1', US: 'us-serving-1' },
    lineageStatus: 'PASS',
    storage: {
      guardStatus: 'PASS', failedSafe: false, volumePath: root, volumeUuid: 'fixture-volume',
      freeBytes: 100, minimumFreeBytes: 50,
    },
    health: { web: 'PASS', analog: 'PASS', freshnessGuard: 'PASS' },
    concurrency: { writerLocksClear: true, promotionJournalsClear: true },
    rollback: {
      artifactRoot: path.join(root, '.next-live'), buildId: 'rollback-build', artifactTreeSha256: '2'.repeat(64),
      runtimeNodeModulesTarget: path.join(runtime, 'node_modules'), runtimeIdentitySha256: '3'.repeat(64),
    },
    attestations,
    stateSha256: currentPreflightStateSha256(attestations),
    ...overrides,
  }
}

const proofFile = path.join(root, 'proof.json')
const writeProof = (value: SmaReleasePreflightProof) => {
  fs.writeFileSync(proofFile, `${JSON.stringify(value, null, 2)}\n`)
  return sha256File(proofFile)
}
const verify = (value: SmaReleasePreflightProof, now = new Date('2026-10-28T00:05:00.000Z')) => verifySmaReleasePreflightProof({
  proofPath: proofFile,
  expectedProofSha256: writeProof(value),
  expectedBaselineCommit: BASELINE,
  expectedCandidateCommit: CANDIDATE,
  expectedBuildId: BUILD,
  expectedArtifactTreeSha256: ARTIFACT,
  expectedRuntimeIdentitySha256: RUNTIME,
  now,
})

assert.equal(verify(proof()).candidate.commit, CANDIDATE)
assert.throws(() => verify({ ...proof(), expiresAt: '2026-10-28T00:04:00.000Z' }), /expired_or_invalid_ttl/)
assert.throws(() => verify({ ...proof(), expiresAt: '2026-10-28T00:15:00.001Z' }), /expired_or_invalid_ttl/)

writeProof(proof())
assert.throws(() => verifySmaReleasePreflightProof({
  proofPath: proofFile,
  expectedProofSha256: 'f'.repeat(64),
  expectedBaselineCommit: BASELINE,
  expectedCandidateCommit: CANDIDATE,
  expectedBuildId: BUILD,
  expectedArtifactTreeSha256: ARTIFACT,
  expectedRuntimeIdentitySha256: RUNTIME,
  now: new Date('2026-10-28T00:05:00.000Z'),
}), /proof_hash_mismatch/)

assert.throws(() => verify({ ...proof(), candidate: { ...proof().candidate, commit: 'bad' } }), /candidate_mismatch/)
assert.throws(() => verify({ ...proof(), runtime: { ...proof().runtime, identitySha256: '4'.repeat(64) } }), /runtime_mismatch/)
assert.throws(() => verify({
  ...proof(),
  storage: { ...proof().storage, freeBytes: Number.MAX_SAFE_INTEGER, minimumFreeBytes: Number.MAX_SAFE_INTEGER },
}), /storage_capacity_changed/)

const unchanged = proof()
const unchangedHash = writeProof(unchanged)
fs.writeFileSync(files.jpSource, 'changed')
assert.throws(() => verifySmaReleasePreflightProof({
  proofPath: proofFile,
  expectedProofSha256: unchangedHash,
  expectedBaselineCommit: BASELINE,
  expectedCandidateCommit: CANDIDATE,
  expectedBuildId: BUILD,
  expectedArtifactTreeSha256: ARTIFACT,
  expectedRuntimeIdentitySha256: RUNTIME,
  now: new Date('2026-10-28T00:05:00.000Z'),
}), /attestation_changed:jp-source-generation/)
fs.writeFileSync(files.jpSource, 'jp-source.json')

for (const blocked of [failedSafe, writerLock, journal]) {
  const current = proof()
  const hash = writeProof(current)
  fs.writeFileSync(blocked, 'blocked')
  assert.throws(() => verifySmaReleasePreflightProof({
    proofPath: proofFile,
    expectedProofSha256: hash,
    expectedBaselineCommit: BASELINE,
    expectedCandidateCommit: CANDIDATE,
    expectedBuildId: BUILD,
    expectedArtifactTreeSha256: ARTIFACT,
    expectedRuntimeIdentitySha256: RUNTIME,
    now: new Date('2026-10-28T00:05:00.000Z'),
  }), /expected_absent/)
  fs.unlinkSync(blocked)
}

{
  const current = proof()
  const hash = writeProof(current)
  fs.writeFileSync(writerLock, JSON.stringify({ transactionId: 'owned', pid: process.pid }))
  fs.writeFileSync(journal, JSON.stringify({ transactionId: 'owned', stage: 'PREPARED' }))
  assert.equal(verifySmaReleasePreflightProof({
    proofPath: proofFile,
    expectedProofSha256: hash,
    expectedBaselineCommit: BASELINE,
    expectedCandidateCommit: CANDIDATE,
    expectedBuildId: BUILD,
    expectedArtifactTreeSha256: ARTIFACT,
    expectedRuntimeIdentitySha256: RUNTIME,
    expectedOwnedAbsentPaths: [writerLock, journal],
    now: new Date('2026-10-28T00:05:00.000Z'),
  }).candidate.commit, CANDIDATE)
  fs.writeFileSync(files.jpSource, 'changed-during-owned-transaction')
  assert.throws(() => verifySmaReleasePreflightProof({
    proofPath: proofFile,
    expectedProofSha256: hash,
    expectedBaselineCommit: BASELINE,
    expectedCandidateCommit: CANDIDATE,
    expectedBuildId: BUILD,
    expectedArtifactTreeSha256: ARTIFACT,
    expectedRuntimeIdentitySha256: RUNTIME,
    expectedOwnedAbsentPaths: [writerLock, journal],
    now: new Date('2026-10-28T00:05:00.000Z'),
  }), /attestation_changed:jp-source-generation/)
  fs.writeFileSync(files.jpSource, 'jp-source.json')
  assert.throws(() => verifySmaReleasePreflightProof({
    proofPath: proofFile,
    expectedProofSha256: hash,
    expectedBaselineCommit: BASELINE,
    expectedCandidateCommit: CANDIDATE,
    expectedBuildId: BUILD,
    expectedArtifactTreeSha256: ARTIFACT,
    expectedRuntimeIdentitySha256: RUNTIME,
    expectedOwnedAbsentPaths: [failedSafe],
    now: new Date('2026-10-28T00:05:00.000Z'),
  }), /owned_transition_invalid/)
  fs.unlinkSync(writerLock)
  fs.unlinkSync(journal)
}

fs.rmSync(root, { recursive: true })
console.log('test-sma-release-preflight: ok')
