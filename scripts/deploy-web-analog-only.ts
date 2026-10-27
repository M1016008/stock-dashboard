import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { activeArtifactTreeIdentity, artifactTreeIdentity, verifySmaReleaseManifest } from '@/lib/release/artifact-manifest'
import {
  sha256File,
  verifySmaReleasePreflightProof,
  type SmaReleasePreflightProof,
} from '@/lib/release/preflight-proof'
import {
  PRODUCTION_AGENT_INVENTORY,
  WEB_ANALOG_TARGETS,
  assertReleaseLaunchAgentDefinition,
  recoverReleaseWithBestEffortSignals,
  runWebAnalogRelease,
  type AgentSnapshot,
  type ProductionAgentLabel,
  type WebAnalogReleaseAdapter,
} from '@/lib/release/web-analog-only'
import {
  WebAnalogReleaseTransaction,
  assertNoUncertainReleaseTransaction,
  type ReleaseTransactionPaths,
} from '@/lib/release/web-analog-transaction'

const BASELINE_COMMIT = '034310b72f57163ee4607c05d1057310277a787d'
const mode = process.argv[2] ?? '--plan'
const uid = process.getuid?.()
if (uid == null) throw new Error('uid_unavailable')

const webOrigin = `http://127.0.0.1:${process.env.STOCKBOARD_WEB_PORT || '3000'}`
const analogOrigin = `http://127.0.0.1:${process.env.STOCKBOARD_ANALOG_PORT || '3105'}`
const healthUrls = [`${webOrigin}/api/health`, `${analogOrigin}/api/health`] as const

function command(commandName: string, args: string[], cwd?: string, env?: NodeJS.ProcessEnv): string {
  const result = spawnSync(commandName, args, { cwd, encoding: 'utf8', ...(env ? { env } : {}) })
  if (result.error) throw new Error(`command_spawn_failed:${commandName}:${result.error.message}`)
  if (result.status !== 0) throw new Error(`command_failed:${commandName}:${args.join(':')}:${(result.stderr || '').trim()}`)
  return result.stdout.trim()
}

function disabledOverrides(): Set<string> {
  const output = command('/bin/launchctl', ['print-disabled', `gui/${uid}`])
  const disabled = new Set<string>()
  for (const match of output.matchAll(/"([^"]+)"\s*=>\s*true/g)) disabled.add(match[1])
  return disabled
}

function agentState(label: ProductionAgentLabel, disabled: Set<string>) {
  const result = spawnSync('/bin/launchctl', ['print', `gui/${uid}/${label}`], { encoding: 'utf8' })
  const state = result.status === 0 ? result.stdout.match(/\bstate = ([^\n]+)/)?.[1]?.trim() ?? 'loaded' : null
  return { loaded: result.status === 0, disabled: disabled.has(label), state }
}

function snapshotAgents(): AgentSnapshot {
  const disabled = disabledOverrides()
  return Object.fromEntries(PRODUCTION_AGENT_INVENTORY.map((label) => [label, agentState(label, disabled)])) as AgentSnapshot
}

function waitForHealth(url: string, timeoutSeconds = 60): void {
  const deadline = Date.now() + timeoutSeconds * 1_000
  while (Date.now() < deadline) {
    const result = spawnSync('/usr/bin/curl', ['--silent', '--show-error', '--fail', '--max-time', '5', url], { encoding: 'utf8' })
    if (result.status === 0 && result.stdout.includes('"status":"ok"')) return
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1_000)
  }
  throw new Error(`health_timeout:${url}`)
}

function errorEvidence(error: unknown): unknown {
  if (error instanceof AggregateError) {
    return {
      name: error.name,
      message: error.message,
      causes: error.errors.map(errorEvidence),
    }
  }
  if (error instanceof Error) return { name: error.name, message: error.message }
  return { name: 'NonError', message: String(error) }
}

function directoryBytes(root: string): number {
  let bytes = 0
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const file = path.join(root, entry.name)
    if (entry.isDirectory()) bytes += directoryBytes(file)
    else if (entry.isFile()) bytes += fs.statSync(file).size
  }
  return bytes
}

function requiredAbsolute(name: string): string {
  const value = process.env[name]?.trim()
  if (!value || !path.isAbsolute(value)) throw new Error(`${name}_absolute_path_required`)
  return path.resolve(value)
}

function requiredValue(name: string): string {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`${name}_required`)
  return value
}

function requiredSha256(name: string): string {
  const value = requiredValue(name)
  if (!/^[a-f0-9]{64}$/.test(value)) throw new Error(`${name}_sha256_required`)
  return value
}

function readBuildId(root: string): string {
  const file = path.join(root, 'BUILD_ID')
  if (!fs.existsSync(file)) throw new Error(`build_id_missing:${file}`)
  return fs.readFileSync(file, 'utf8').trim()
}

function assertArtifact(artifact: string): void {
  const manifestFile = path.join(artifact, 'server', 'app-paths-manifest.json')
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8')) as Record<string, string>
  const required = ['/stock/[ticker]/page', '/us/stock/[ticker]/page', '/api/history/[ticker]/route', '/api/us/history/[ticker]/route', '/api/health/route']
  const missing = required.filter((route) => !manifest[route])
  if (missing.length > 0) throw new Error(`candidate_routes_missing:${missing.join(',')}`)
}

function assertLaunchAgentDefinitions(
  releaseRoot: string,
  storage: SmaReleasePreflightProof['storage'],
): Record<string, string> {
  const expectedHashes: Record<(typeof WEB_ANALOG_TARGETS)[number], string | undefined> = {
    'com.stockboard.web': process.env.STOCKBOARD_EXPECTED_WEB_PLIST_SHA256?.trim(),
    'com.stockboard.analog-search': process.env.STOCKBOARD_EXPECTED_ANALOG_PLIST_SHA256?.trim(),
  }
  const hashes: Record<string, string> = {}
  for (const label of WEB_ANALOG_TARGETS) {
    const expectedHash = expectedHashes[label]
    if (!expectedHash) throw new Error(`launchagent_hash_required:${label}`)
    const plist = path.join(os.homedir(), 'Library', 'LaunchAgents', `${label}.plist`)
    if (!fs.existsSync(plist)) throw new Error(`launchagent_definition_missing:${label}`)
    const actualHash = sha256File(plist)
    if (actualHash !== expectedHash) throw new Error(`launchagent_definition_hash_mismatch:${label}`)
    const definition = JSON.parse(command('/usr/bin/plutil', ['-convert', 'json', '-o', '-', plist]))
    assertReleaseLaunchAgentDefinition(label, definition, releaseRoot)
    const environment = (definition as { EnvironmentVariables?: Record<string, string> }).EnvironmentVariables ?? {}
    if (path.resolve(environment.STOCK_DATA_MOUNT_PATH ?? '') !== path.resolve(storage.volumePath)) {
      throw new Error(`launchagent_storage_mount_mismatch:${label}`)
    }
    if (environment.STOCK_DATA_VOLUME_UUID !== storage.volumeUuid) {
      throw new Error(`launchagent_storage_uuid_mismatch:${label}`)
    }
    hashes[label] = actualHash
  }
  return hashes
}

interface RuntimeManifest {
  schemaVersion: number
  sourceCommit?: string
  baselineSha: string
  runtimeRealpath: string
  node: { binary: string; version: string; arch: string; platform: string; osRelease: string }
  packages: Record<string, string>
  hashes: {
    lockSha256: string
    dependencyTreeSha256: string
    nativeFilesSha256: string
    runtimeIdentitySha256: string
  }
  install: { nodeModulesPhysicalDirectory: boolean }
}

function sanitizeDependencyTree(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeDependencyTree)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([key]) => !['path', 'problems'].includes(key))
    .map(([key, child]) => [key, sanitizeDependencyTree(child)]))
}

function hashJson(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

function verifyRuntime(runtimeDirectory: string, expectedIdentity: string, expectedManifestHash?: string, expectedLockHash?: string): RuntimeManifest {
  if (fs.lstatSync(runtimeDirectory).isSymbolicLink()) throw new Error('release_runtime_must_be_physical')
  const nodeModules = path.join(runtimeDirectory, 'node_modules')
  if (!fs.statSync(nodeModules).isDirectory() || fs.lstatSync(nodeModules).isSymbolicLink()) throw new Error('release_node_modules_must_be_physical')
  const manifestFile = path.join(runtimeDirectory, 'runtime-manifest.json')
  if (expectedManifestHash && sha256File(manifestFile) !== expectedManifestHash) throw new Error('release_runtime_manifest_hash_mismatch')
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8')) as RuntimeManifest
  const npmBinary = path.join(path.dirname(process.execPath), 'npm')
  if (!fs.existsSync(npmBinary)) throw new Error(`release_runtime_npm_missing:${npmBinary}`)
  const dependencyTree = JSON.parse(command(
    npmBinary,
    ['ls', '--all', '--json'],
    runtimeDirectory,
    { ...process.env, NODE_ENV: 'production' },
  )) as unknown
  const dependencyTreeSha256 = hashJson(sanitizeDependencyTree(dependencyTree))
  const nativeCandidates = [
    'node_modules/@esbuild/darwin-arm64/bin/esbuild',
    'node_modules/@libsql/darwin-arm64/index.node',
    'node_modules/@next/swc-darwin-arm64/next-swc.darwin-arm64.node',
    'node_modules/sharp/src/build/Release/sharp-darwin-arm64.node',
    'node_modules/@img/sharp-darwin-arm64/lib/sharp-darwin-arm64.node',
  ]
  const nativeFiles = Object.fromEntries(nativeCandidates
    .filter((relative) => fs.existsSync(path.join(runtimeDirectory, relative)))
    .map((relative) => [relative, sha256File(path.join(runtimeDirectory, relative))]))
  const nativeFilesSha256 = hashJson(nativeFiles)
  const lockSha256 = sha256File(path.join(runtimeDirectory, 'package-lock.json'))
  const packageVersion = (name: string) => JSON.parse(fs.readFileSync(path.join(nodeModules, ...name.split('/'), 'package.json'), 'utf8')).version as string
  const packages = {
    next: packageVersion('next'), react: packageVersion('react'), reactDom: packageVersion('react-dom'),
    tsx: packageVersion('tsx'), esbuild: packageVersion('esbuild'), libsqlClient: packageVersion('@libsql/client'),
    libsqlNative: packageVersion('@libsql/darwin-arm64'), sharp: packageVersion('sharp'),
  }
  const node = {
    binary: process.execPath, version: process.version, arch: process.arch, platform: process.platform,
    osRelease: os.release(),
  }
  const identityPayload = {
    baselineSha: manifest.baselineSha,
    ...(manifest.sourceCommit ? { sourceCommit: manifest.sourceCommit } : {}),
    node, packages, lockSha256, dependencyTreeSha256, nativeFilesSha256,
  }
  const actualIdentity = hashJson(identityPayload)
  const mismatches: string[] = []
  if (manifest.schemaVersion !== 1) mismatches.push('schemaVersion')
  if (manifest.baselineSha !== BASELINE_COMMIT) mismatches.push('baselineSha')
  if (fs.realpathSync(runtimeDirectory) !== manifest.runtimeRealpath) mismatches.push('runtimeRealpath')
  if (actualIdentity !== expectedIdentity) mismatches.push('expectedIdentity')
  if (manifest.hashes.runtimeIdentitySha256 !== actualIdentity) mismatches.push('manifestIdentity')
  if (lockSha256 !== manifest.hashes.lockSha256) mismatches.push('lockSha256')
  if (expectedLockHash && lockSha256 !== expectedLockHash) mismatches.push('proofLockSha256')
  if (dependencyTreeSha256 !== manifest.hashes.dependencyTreeSha256) mismatches.push('dependencyTreeSha256')
  if (nativeFilesSha256 !== manifest.hashes.nativeFilesSha256) mismatches.push('nativeFilesSha256')
  if (JSON.stringify(packages) !== JSON.stringify(manifest.packages)) mismatches.push('packages')
  if (JSON.stringify(node) !== JSON.stringify(manifest.node)) mismatches.push('node')
  if (manifest.install.nodeModulesPhysicalDirectory !== true) mismatches.push('nodeModulesPhysicalDirectory')
  if (mismatches.length > 0) throw new Error(`release_runtime_manifest_contract_mismatch:${mismatches.join(',')}`)
  return manifest
}

if (mode === '--plan') {
  console.log(JSON.stringify({
    mode: 'plan_only',
    targets: WEB_ANALOG_TARGETS,
    requiredPreflight: { maximumTtlMinutes: 15, hashPinned: true, stateReattestedBeforeMutation: true },
    transaction: { durableJournal: 'STOCKBOARD_RELEASE_STATE_DIR/sma-release-journal.json', runtimeAndArtifactCompensation: true },
    launchctlMutations: [
      ...WEB_ANALOG_TARGETS.map((label) => `kill SIGSTOP gui/${uid}/${label}`),
      ...WEB_ANALOG_TARGETS.map((label) => `kickstart -k gui/${uid}/${label}`),
    ],
    forbidden: ['bootstrap', 'bootout', 'enable', 'disable', 'schema', 'index', 'writer', 'storage-guard', 'failed-safe'],
    healthUrls,
  }, null, 2))
  process.exit(0)
}

if (mode !== '--execute') throw new Error('usage: npm run release:web-analog-only -- --plan|--execute')
if (process.env.STOCKBOARD_WEB_ANALOG_RELEASE_APPROVED !== '1') throw new Error('explicit_release_approval_required')
if (process.env.STOCKBOARD_DEPLOY_SKIP_SCHEMA !== '1') throw new Error('STOCKBOARD_DEPLOY_SKIP_SCHEMA=1_required')

const artifact = requiredAbsolute('STOCKBOARD_RELEASE_ARTIFACT')
const releaseRuntime = requiredAbsolute('STOCKBOARD_RELEASE_RUNTIME')
const proofPath = requiredAbsolute('STOCKBOARD_PREFLIGHT_PROOF')
const releaseRoot = requiredAbsolute('STOCKBOARD_RELEASE_ROOT')
const releaseStateDirectory = requiredAbsolute('STOCKBOARD_RELEASE_STATE_DIR')
const expectedReleaseRoot = requiredAbsolute('STOCKBOARD_EXPECTED_RELEASE_ROOT_REALPATH')
if (fs.realpathSync(releaseRoot) !== expectedReleaseRoot) throw new Error('release_root_identity_mismatch')
if (!fs.statSync(releaseStateDirectory).isDirectory() || fs.lstatSync(releaseStateDirectory).isSymbolicLink()) {
  throw new Error('release_state_directory_must_be_physical')
}
if (command('/usr/bin/git', ['rev-parse', 'HEAD'], releaseRoot) !== BASELINE_COMMIT
  || command('/usr/bin/git', ['status', '--porcelain'], releaseRoot) !== '') throw new Error('release_baseline_identity_mismatch')

const expectedCandidateCommit = requiredValue('STOCKBOARD_EXPECTED_CANDIDATE_COMMIT')
const expectedCandidateBuild = requiredValue('STOCKBOARD_EXPECTED_CANDIDATE_BUILD_ID')
const expectedArtifactTree = requiredSha256('STOCKBOARD_EXPECTED_ARTIFACT_TREE_SHA256')
const expectedRuntimeIdentity = requiredSha256('STOCKBOARD_EXPECTED_RUNTIME_IDENTITY_SHA256')
const expectedProofHash = requiredSha256('STOCKBOARD_PREFLIGHT_PROOF_SHA256')
const proofOptions = {
  proofPath,
  expectedProofSha256: expectedProofHash,
  expectedBaselineCommit: BASELINE_COMMIT,
  expectedCandidateCommit,
  expectedBuildId: expectedCandidateBuild,
  expectedArtifactTreeSha256: expectedArtifactTree,
  expectedRuntimeIdentitySha256: expectedRuntimeIdentity,
}
const proof = verifySmaReleasePreflightProof(proofOptions)
const minimumDataFreeBytes = Number(process.env.STOCKBOARD_DATA_MIN_FREE_BYTES || 50 * 1024 ** 3)
if (!Number.isSafeInteger(minimumDataFreeBytes) || proof.storage.minimumFreeBytes < minimumDataFreeBytes) {
  throw new Error('preflight_storage_minimum_below_release_requirement')
}
const launchAgentDefinitionHashes = assertLaunchAgentDefinitions(releaseRoot, proof.storage)
const live = path.join(releaseRoot, '.next-live')
const previous = path.join(releaseRoot, '.next-live-prev')
const stage = path.join(releaseRoot, '.next-live-next')
const nodeModules = path.join(releaseRoot, 'node_modules')
const runtimePrevious = path.join(releaseRoot, '.node_modules-release-prev')
const runtimeStage = path.join(releaseRoot, '.node_modules-release-next')
const transactionPaths: ReleaseTransactionPaths = {
  releaseRoot, artifact, candidateRuntimeNodeModules: path.join(releaseRuntime, 'node_modules'),
  live, previous, stage, nodeModules, runtimePrevious, runtimeStage,
  journal: path.join(releaseStateDirectory, 'sma-release-journal.json'),
  lock: path.join(releaseStateDirectory, 'sma-release.lock'),
}

function verifyRollbackGeneration(): void {
  if (readBuildId(live) !== proof.rollback.buildId || path.resolve(proof.rollback.artifactRoot) !== live) {
    throw new Error('rollback_artifact_identity_mismatch')
  }
  const rollbackTree = activeArtifactTreeIdentity(live)
  if (rollbackTree.treeSha256 !== proof.rollback.artifactTreeSha256) throw new Error('rollback_artifact_tree_mismatch')
  if (!fs.lstatSync(nodeModules).isSymbolicLink()) throw new Error('production_runtime_link_required')
  const currentRuntimeTarget = path.resolve(releaseRoot, fs.readlinkSync(nodeModules))
  if (currentRuntimeTarget !== path.resolve(proof.rollback.runtimeNodeModulesTarget)) {
    throw new Error('rollback_runtime_target_mismatch')
  }
  verifyRuntime(path.dirname(currentRuntimeTarget), proof.rollback.runtimeIdentitySha256)
}

assertNoUncertainReleaseTransaction(transactionPaths)
if (fs.existsSync(stage) || fs.existsSync(runtimeStage)) throw new Error('release_staging_path_must_not_exist')
verifyRollbackGeneration()

assertArtifact(artifact)
const candidateBuild = readBuildId(artifact)
if (candidateBuild !== expectedCandidateBuild) throw new Error('candidate_build_identity_mismatch')
const releaseManifest = verifySmaReleaseManifest(artifact, expectedCandidateCommit)
if (releaseManifest.buildId !== candidateBuild || releaseManifest.baselineCommit !== BASELINE_COMMIT
  || releaseManifest.treeSha256 !== expectedArtifactTree) throw new Error('candidate_manifest_contract_mismatch')
const runtimeManifest = verifyRuntime(releaseRuntime, expectedRuntimeIdentity, proof.runtime.manifestSha256, proof.runtime.lockSha256)
if (path.resolve(proof.runtime.nodeModulesTarget) !== path.join(releaseRuntime, 'node_modules')) {
  throw new Error('preflight_candidate_runtime_target_mismatch')
}

const artifactBytes = directoryBytes(artifact)
const filesystem = fs.statfsSync(releaseRoot)
const freeBytes = filesystem.bavail * filesystem.bsize
const minimumFreeBytes = Number(process.env.STOCKBOARD_RELEASE_MIN_FREE_BYTES || 50 * 1024 ** 3)
if (!Number.isSafeInteger(minimumFreeBytes) || freeBytes - artifactBytes < minimumFreeBytes) throw new Error('release_capacity_gate_failed')

const transaction = new WebAnalogReleaseTransaction({
  paths: transactionPaths,
  identity: {
    candidateBuildId: candidateBuild,
    candidateArtifactTreeSha256: releaseManifest.treeSha256,
    candidateRuntimeIdentitySha256: runtimeManifest.hashes.runtimeIdentitySha256,
    rollbackBuildId: proof.rollback.buildId,
    rollbackArtifactTreeSha256: proof.rollback.artifactTreeSha256,
    rollbackRuntimeIdentitySha256: proof.rollback.runtimeIdentitySha256,
    rollbackRuntimeNodeModulesTarget: proof.rollback.runtimeNodeModulesTarget,
  },
})
const ownedTransactionAttestationPaths = [transactionPaths.lock, transactionPaths.journal] as const

function verifyProofDuringOwnedTransaction(expectedStage: 'PREPARED' | 'TARGETS_FROZEN'): void {
  transaction.assertOwnedState(expectedStage)
  verifySmaReleasePreflightProof({
    ...proofOptions,
    expectedOwnedAbsentPaths: ownedTransactionAttestationPaths,
  })
}

let targetsFrozen = false
let restartedTargets = 0
let candidateRestartPhase = false
const signalWarnings: string[] = []

function signalTargetsBestEffort(signal: 'SIGSTOP' | 'SIGCONT'): { signaled: number; errors: string[] } {
  const errors: string[] = []
  let signaled = 0
  for (const label of WEB_ANALOG_TARGETS) {
    try {
      command('/bin/launchctl', ['kill', signal, `gui/${uid}/${label}`])
      signaled += 1
    } catch (error) {
      errors.push(`${signal}:${label}:${error instanceof Error ? error.message : String(error)}`)
    }
  }
  signalWarnings.push(...errors)
  return { signaled, errors }
}

const adapter: WebAnalogReleaseAdapter = {
  snapshotAgents,
  assertHealthy: () => { for (const url of healthUrls) waitForHealth(url) },
  promote: () => {
    transaction.prepare()
    if (artifactTreeIdentity(stage).treeSha256 !== releaseManifest.treeSha256) throw new Error('staged_artifact_tree_mismatch')
    verifyRollbackGeneration()
    verifyRuntime(releaseRuntime, expectedRuntimeIdentity, proof.runtime.manifestSha256, proof.runtime.lockSha256)
    verifyRuntime(path.dirname(proof.rollback.runtimeNodeModulesTarget), proof.rollback.runtimeIdentitySha256)
    verifyProofDuringOwnedTransaction('PREPARED')
    const freeze = signalTargetsBestEffort('SIGSTOP')
    targetsFrozen = freeze.signaled > 0
    if (freeze.errors.length > 0) throw new AggregateError(freeze.errors, 'release_target_freeze_failed')
    transaction.markTargetsFrozen()
    verifyProofDuringOwnedTransaction('TARGETS_FROZEN')
    transaction.activate()
    candidateRestartPhase = true
  },
  needsRecovery: () => transaction.ownsMutableState(),
  restore: () => {
    candidateRestartPhase = false
    restartedTargets = 0
    const freezeRequired = targetsFrozen || transaction.generationMayHaveChanged()
    const recovery = recoverReleaseWithBestEffortSignals({
      freezeRequired,
      signal: (signal) => {
        const result = signalTargetsBestEffort(signal)
        if (signal === 'SIGSTOP') targetsFrozen = targetsFrozen || result.signaled > 0
        return result
      },
      rollback: () => {
        return transaction.rollback(() => {
          if (activeArtifactTreeIdentity(live).treeSha256 !== proof.rollback.artifactTreeSha256) {
            throw new Error('restored_artifact_tree_mismatch')
          }
          verifyRuntime(path.dirname(proof.rollback.runtimeNodeModulesTarget), proof.rollback.runtimeIdentitySha256)
        })
      },
    })
    targetsFrozen = recovery.resume.errors.length > 0
    return recovery.restartRequired
  },
  kickstart: (label) => {
    try {
      command('/bin/launchctl', ['kickstart', '-k', `gui/${uid}/${label}`])
    } catch (error) {
      if (targetsFrozen) signalTargetsBestEffort('SIGCONT')
      throw error
    }
    restartedTargets += 1
    if (restartedTargets === WEB_ANALOG_TARGETS.length) {
      targetsFrozen = false
      if (candidateRestartPhase) transaction.markServicesRestarted()
    }
  },
  commit: () => {
    if (activeArtifactTreeIdentity(live).treeSha256 !== releaseManifest.treeSha256) throw new Error('active_artifact_tree_mismatch')
    if (activeArtifactTreeIdentity(previous).treeSha256 !== proof.rollback.artifactTreeSha256) throw new Error('rollback_artifact_tree_changed')
    verifyRuntime(releaseRuntime, expectedRuntimeIdentity, proof.runtime.manifestSha256, proof.runtime.lockSha256)
    verifyRuntime(path.dirname(proof.rollback.runtimeNodeModulesTarget), proof.rollback.runtimeIdentitySha256)
    transaction.commit()
  },
}

runWebAnalogRelease(adapter).then((result) => {
  console.log(JSON.stringify({
    status: 'SUCCESS', candidateBuild, artifactBytes, launchAgentDefinitionHashes,
    runtimeIdentitySha256: runtimeManifest.hashes.runtimeIdentitySha256,
    preflightProofSha256: expectedProofHash,
    agentStatePreserved: true, rolledBack: result.rolledBack,
  }))
}).catch((error) => {
  const recovery = transaction.recoverySummary()
  const unresolvedPaths = [transactionPaths.journal, transactionPaths.lock].filter((target) => fs.existsSync(target))
  const unresolved = unresolvedPaths.length > 0
  console.error(JSON.stringify({
    status: unresolved ? 'HOLD' : recovery?.stage === 'ROLLED_BACK' ? 'ROLLED_BACK_UNHEALTHY' : 'PRECHECK_FAILED',
    error: errorEvidence(error),
    transaction: recovery,
    unresolvedPaths,
    servicesMayBeSigstopped: targetsFrozen,
    signalWarnings,
    automaticRetryAllowed: false,
  }, null, 2))
  process.exitCode = 1
})
