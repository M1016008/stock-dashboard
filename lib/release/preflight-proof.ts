import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

export const MAX_PREFLIGHT_TTL_MS = 15 * 60 * 1_000

export type PreflightAttestationPurpose =
  | 'runtime-link'
  | 'runtime-manifest'
  | 'jp-source-generation'
  | 'us-source-generation'
  | 'jp-serving-generation'
  | 'us-serving-generation'
  | 'price-basis'
  | 'storage-guard'
  | 'failed-safe'
  | 'writer-lock'
  | 'promotion-journal'
  | 'web-health'
  | 'analog-health'
  | 'freshness-health'

export type PreflightAttestation = {
  purpose: PreflightAttestationPurpose
  path: string
} & (
  | { kind: 'file-sha256'; sha256: string }
  | { kind: 'symlink'; target: string }
  | { kind: 'absent' }
)

export interface SmaReleasePreflightProof {
  version: 1
  issuedAt: string
  expiresAt: string
  baselineCommit: string
  candidate: {
    commit: string
    buildId: string
    artifactTreeSha256: string
  }
  runtime: {
    nodeModulesTarget: string
    identitySha256: string
    manifestSha256: string
    lockSha256: string
  }
  priceBasis: string
  sourceGeneration: { JP: string; US: string }
  servingGeneration: { JP: string; US: string }
  lineageStatus: 'PASS'
  storage: {
    guardStatus: 'PASS'
    failedSafe: false
    volumePath: string
    volumeUuid: string
    freeBytes: number
    minimumFreeBytes: number
  }
  health: {
    web: 'PASS'
    analog: 'PASS'
    freshnessGuard: 'PASS'
  }
  concurrency: {
    writerLocksClear: true
    promotionJournalsClear: true
  }
  rollback: {
    artifactRoot: string
    buildId: string
    artifactTreeSha256: string
    runtimeNodeModulesTarget: string
    runtimeIdentitySha256: string
  }
  attestations: PreflightAttestation[]
  stateSha256: string
}

export interface VerifyPreflightProofOptions {
  proofPath: string
  expectedProofSha256: string
  expectedBaselineCommit: string
  expectedCandidateCommit: string
  expectedBuildId: string
  expectedArtifactTreeSha256: string
  expectedRuntimeIdentitySha256: string
  expectedOwnedAbsentPaths?: readonly string[]
  now?: Date
}

const REQUIRED_PURPOSES: readonly PreflightAttestationPurpose[] = [
  'runtime-link',
  'runtime-manifest',
  'jp-source-generation',
  'us-source-generation',
  'jp-serving-generation',
  'us-serving-generation',
  'price-basis',
  'storage-guard',
  'failed-safe',
  'writer-lock',
  'promotion-journal',
  'web-health',
  'analog-health',
  'freshness-health',
]

export function sha256File(file: string): string {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}

function requiredText(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`preflight_field_invalid:${field}`)
  return value
}

function requiredSha256(value: unknown, field: string): string {
  const text = requiredText(value, field)
  if (!/^[a-f0-9]{64}$/.test(text)) throw new Error(`preflight_sha256_invalid:${field}`)
  return text
}

function requiredAbsolute(value: unknown, field: string): string {
  const text = requiredText(value, field)
  if (!path.isAbsolute(text)) throw new Error(`preflight_path_not_absolute:${field}`)
  return path.resolve(text)
}

function assertProofShape(value: unknown): asserts value is SmaReleasePreflightProof {
  if (!value || typeof value !== 'object') throw new Error('preflight_proof_invalid')
  const proof = value as Partial<SmaReleasePreflightProof>
  if (proof.version !== 1) throw new Error('preflight_version_invalid')
  requiredText(proof.issuedAt, 'issuedAt')
  requiredText(proof.expiresAt, 'expiresAt')
  requiredText(proof.baselineCommit, 'baselineCommit')
  requiredText(proof.candidate?.commit, 'candidate.commit')
  requiredText(proof.candidate?.buildId, 'candidate.buildId')
  requiredSha256(proof.candidate?.artifactTreeSha256, 'candidate.artifactTreeSha256')
  requiredAbsolute(proof.runtime?.nodeModulesTarget, 'runtime.nodeModulesTarget')
  requiredSha256(proof.runtime?.identitySha256, 'runtime.identitySha256')
  requiredSha256(proof.runtime?.manifestSha256, 'runtime.manifestSha256')
  requiredSha256(proof.runtime?.lockSha256, 'runtime.lockSha256')
  requiredText(proof.priceBasis, 'priceBasis')
  requiredText(proof.sourceGeneration?.JP, 'sourceGeneration.JP')
  requiredText(proof.sourceGeneration?.US, 'sourceGeneration.US')
  requiredText(proof.servingGeneration?.JP, 'servingGeneration.JP')
  requiredText(proof.servingGeneration?.US, 'servingGeneration.US')
  if (proof.lineageStatus !== 'PASS') throw new Error('preflight_lineage_not_pass')
  if (proof.storage?.guardStatus !== 'PASS' || proof.storage.failedSafe !== false) throw new Error('preflight_storage_not_pass')
  const volumePath = requiredAbsolute(proof.storage.volumePath, 'storage.volumePath')
  if (!fs.statSync(volumePath).isDirectory()) throw new Error('preflight_storage_volume_not_directory')
  requiredText(proof.storage.volumeUuid, 'storage.volumeUuid')
  if (!Number.isSafeInteger(proof.storage.freeBytes) || !Number.isSafeInteger(proof.storage.minimumFreeBytes)
    || proof.storage.freeBytes < 0 || proof.storage.minimumFreeBytes <= 0
    || proof.storage.freeBytes < proof.storage.minimumFreeBytes) throw new Error('preflight_storage_capacity_invalid')
  const filesystem = fs.statfsSync(volumePath)
  const currentFreeBytes = filesystem.bavail * filesystem.bsize
  if (currentFreeBytes < proof.storage.minimumFreeBytes) throw new Error('preflight_storage_capacity_changed')
  if (proof.health?.web !== 'PASS' || proof.health.analog !== 'PASS' || proof.health.freshnessGuard !== 'PASS') {
    throw new Error('preflight_health_not_pass')
  }
  if (proof.concurrency?.writerLocksClear !== true || proof.concurrency.promotionJournalsClear !== true) {
    throw new Error('preflight_concurrency_not_clear')
  }
  requiredAbsolute(proof.rollback?.artifactRoot, 'rollback.artifactRoot')
  requiredText(proof.rollback?.buildId, 'rollback.buildId')
  requiredSha256(proof.rollback?.artifactTreeSha256, 'rollback.artifactTreeSha256')
  requiredAbsolute(proof.rollback?.runtimeNodeModulesTarget, 'rollback.runtimeNodeModulesTarget')
  requiredSha256(proof.rollback?.runtimeIdentitySha256, 'rollback.runtimeIdentitySha256')
  if (!Array.isArray(proof.attestations) || proof.attestations.length === 0) throw new Error('preflight_attestations_missing')
  requiredSha256(proof.stateSha256, 'stateSha256')
}

function attestationObservation(attestation: PreflightAttestation): Record<string, string> {
  const absolute = requiredAbsolute(attestation.path, `attestation.${attestation.purpose}.path`)
  if (attestation.kind === 'absent') {
    if (fs.existsSync(absolute)) throw new Error(`preflight_attestation_changed:${attestation.purpose}:expected_absent`)
    return { purpose: attestation.purpose, path: absolute, kind: attestation.kind }
  }
  if (attestation.kind === 'symlink') {
    const expectedTarget = requiredAbsolute(attestation.target, `attestation.${attestation.purpose}.target`)
    if (!fs.lstatSync(absolute).isSymbolicLink()) throw new Error(`preflight_attestation_changed:${attestation.purpose}:not_symlink`)
    const actualTarget = path.resolve(path.dirname(absolute), fs.readlinkSync(absolute))
    if (actualTarget !== expectedTarget) throw new Error(`preflight_attestation_changed:${attestation.purpose}:symlink_target`)
    return { purpose: attestation.purpose, path: absolute, kind: attestation.kind, target: actualTarget }
  }
  const expectedHash = requiredSha256(attestation.sha256, `attestation.${attestation.purpose}.sha256`)
  if (!fs.statSync(absolute).isFile()) throw new Error(`preflight_attestation_changed:${attestation.purpose}:not_file`)
  const actualHash = sha256File(absolute)
  if (actualHash !== expectedHash) throw new Error(`preflight_attestation_changed:${attestation.purpose}:sha256`)
  return { purpose: attestation.purpose, path: absolute, kind: attestation.kind, sha256: actualHash }
}

export function currentPreflightStateSha256(
  attestations: PreflightAttestation[],
  expectedOwnedAbsentPaths: readonly string[] = [],
): string {
  const seenPaths = new Set<string>()
  const ownedPaths = new Set(expectedOwnedAbsentPaths.map((entry) => path.resolve(entry)))
  const observedOwnedPaths = new Set<string>()
  const observations = attestations.map((attestation) => {
    if (!REQUIRED_PURPOSES.includes(attestation.purpose)) throw new Error(`preflight_attestation_purpose_invalid:${attestation.purpose}`)
    const key = path.resolve(attestation.path)
    if (seenPaths.has(key)) throw new Error(`preflight_attestation_duplicate_path:${key}`)
    seenPaths.add(key)
    if (ownedPaths.has(key)) {
      if (attestation.kind !== 'absent'
        || !['writer-lock', 'promotion-journal'].includes(attestation.purpose)) {
        throw new Error(`preflight_owned_transition_invalid:${attestation.purpose}:${key}`)
      }
      observedOwnedPaths.add(key)
      return { purpose: attestation.purpose, path: key, kind: attestation.kind }
    }
    return attestationObservation(attestation)
  }).sort((left, right) => `${left.purpose}:${left.path}`.localeCompare(`${right.purpose}:${right.path}`))
  for (const ownedPath of ownedPaths) {
    if (!observedOwnedPaths.has(ownedPath)) throw new Error(`preflight_owned_transition_not_attested:${ownedPath}`)
  }
  const purposes = new Set(observations.map((observation) => observation.purpose))
  for (const purpose of REQUIRED_PURPOSES) {
    if (!purposes.has(purpose)) throw new Error(`preflight_attestation_missing:${purpose}`)
  }
  return createHash('sha256').update(JSON.stringify(observations)).digest('hex')
}

export function verifySmaReleasePreflightProof(options: VerifyPreflightProofOptions): SmaReleasePreflightProof {
  const expectedProofHash = requiredSha256(options.expectedProofSha256, 'expectedProofSha256')
  const actualProofHash = sha256File(options.proofPath)
  if (actualProofHash !== expectedProofHash) {
    throw new Error(`preflight_proof_hash_mismatch:expected=${expectedProofHash}:actual=${actualProofHash}`)
  }
  const parsed: unknown = JSON.parse(fs.readFileSync(options.proofPath, 'utf8'))
  assertProofShape(parsed)
  const proof = parsed
  const issuedAt = Date.parse(proof.issuedAt)
  const expiresAt = Date.parse(proof.expiresAt)
  const now = (options.now ?? new Date()).getTime()
  if (!Number.isFinite(issuedAt) || !Number.isFinite(expiresAt)) throw new Error('preflight_proof_expired_or_invalid_ttl:timestamp_invalid')
  if (expiresAt <= issuedAt) throw new Error('preflight_proof_expired_or_invalid_ttl:expires_not_after_issue')
  if (expiresAt - issuedAt > MAX_PREFLIGHT_TTL_MS) throw new Error('preflight_proof_expired_or_invalid_ttl:ttl_exceeds_15_minutes')
  if (issuedAt > now + 5_000) throw new Error(`preflight_proof_expired_or_invalid_ttl:issued_in_future:issuedAt=${proof.issuedAt}`)
  if (now >= expiresAt) throw new Error(`preflight_proof_expired_or_invalid_ttl:expired:expiresAt=${proof.expiresAt}`)
  if (proof.baselineCommit !== options.expectedBaselineCommit) throw new Error('preflight_baseline_mismatch')
  if (proof.candidate.commit !== options.expectedCandidateCommit) throw new Error('preflight_candidate_mismatch')
  if (proof.candidate.buildId !== options.expectedBuildId) throw new Error('preflight_build_mismatch')
  if (proof.candidate.artifactTreeSha256 !== options.expectedArtifactTreeSha256) throw new Error('preflight_artifact_mismatch')
  if (proof.runtime.identitySha256 !== options.expectedRuntimeIdentitySha256) throw new Error('preflight_runtime_mismatch')
  const actualStateHash = currentPreflightStateSha256(proof.attestations, options.expectedOwnedAbsentPaths)
  if (actualStateHash !== proof.stateSha256) throw new Error('preflight_state_hash_mismatch')
  return proof
}
