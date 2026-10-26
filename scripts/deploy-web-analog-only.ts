import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { verifySmaReleaseManifest } from '@/lib/release/artifact-manifest'
import {
  PRODUCTION_AGENT_INVENTORY,
  WEB_ANALOG_TARGETS,
  assertReleaseLaunchAgentDefinition,
  runWebAnalogRelease,
  type AgentSnapshot,
  type ProductionAgentLabel,
  type WebAnalogReleaseAdapter,
} from '@/lib/release/web-analog-only'

const mode = process.argv[2] ?? '--plan'
const uid = process.getuid?.()
if (uid == null) throw new Error('uid_unavailable')

const webOrigin = `http://127.0.0.1:${process.env.STOCKBOARD_WEB_PORT || '3000'}`
const analogOrigin = `http://127.0.0.1:${process.env.STOCKBOARD_ANALOG_PORT || '3105'}`
const healthUrls = [`${webOrigin}/api/health`, `${analogOrigin}/api/health`] as const

function command(command: string, args: string[]): string {
  const result = spawnSync(command, args, { encoding: 'utf8' })
  if (result.status !== 0) throw new Error(`command_failed:${command}:${args.join(':')}:${result.stderr.trim()}`)
  return result.stdout
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

function sha256File(file: string): string {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}

function assertLaunchAgentDefinitions(releaseRoot: string): Record<string, string> {
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
    hashes[label] = actualHash
  }
  return hashes
}

if (mode === '--plan') {
  console.log(JSON.stringify({
    mode: 'plan_only',
    targets: WEB_ANALOG_TARGETS,
    launchctlMutations: WEB_ANALOG_TARGETS.map((label) => `kickstart -k gui/${uid}/${label}`),
    forbidden: ['bootstrap', 'bootout', 'enable', 'disable', 'schema', 'index', 'writer', 'storage-guard', 'failed-safe'],
    healthUrls,
  }, null, 2))
  process.exit(0)
}

if (mode !== '--execute') throw new Error('usage: npm run release:web-analog-only -- --plan|--execute')
if (process.env.STOCKBOARD_WEB_ANALOG_RELEASE_APPROVED !== '1') throw new Error('explicit_release_approval_required')
if (process.env.STOCKBOARD_DEPLOY_SKIP_SCHEMA !== '1') throw new Error('STOCKBOARD_DEPLOY_SKIP_SCHEMA=1_required')

const artifact = requiredAbsolute('STOCKBOARD_RELEASE_ARTIFACT')
const releaseRoot = requiredAbsolute('STOCKBOARD_RELEASE_ROOT')
const expectedReleaseRoot = requiredAbsolute('STOCKBOARD_EXPECTED_RELEASE_ROOT_REALPATH')
if (fs.realpathSync(releaseRoot) !== expectedReleaseRoot) throw new Error('release_root_identity_mismatch')
const launchAgentDefinitionHashes = assertLaunchAgentDefinitions(releaseRoot)
const live = path.join(releaseRoot, '.next-live')
const stage = path.join(releaseRoot, '.next-live-next')
const previous = path.join(releaseRoot, '.next-live-prev')
const expectedLiveBuild = process.env.STOCKBOARD_EXPECTED_LIVE_BUILD_ID?.trim()
if (!expectedLiveBuild || readBuildId(live) !== expectedLiveBuild) throw new Error('live_build_identity_mismatch')
assertArtifact(artifact)
const candidateBuild = readBuildId(artifact)
if (candidateBuild !== process.env.STOCKBOARD_EXPECTED_CANDIDATE_BUILD_ID?.trim()) throw new Error('candidate_build_identity_mismatch')
const expectedCandidateCommit = process.env.STOCKBOARD_EXPECTED_CANDIDATE_COMMIT?.trim()
if (!expectedCandidateCommit) throw new Error('candidate_commit_required')
const releaseManifest = verifySmaReleaseManifest(artifact, expectedCandidateCommit)
if (releaseManifest.buildId !== candidateBuild || releaseManifest.baselineCommit !== '034310b72f57163ee4607c05d1057310277a787d') {
  throw new Error('candidate_manifest_contract_mismatch')
}
if (fs.existsSync(stage)) throw new Error('staging_path_must_not_exist')

const artifactBytes = directoryBytes(artifact)
const filesystem = fs.statfsSync(releaseRoot)
const freeBytes = filesystem.bavail * filesystem.bsize
const minimumFreeBytes = Number(process.env.STOCKBOARD_RELEASE_MIN_FREE_BYTES || 50 * 1024 ** 3)
if (!Number.isSafeInteger(minimumFreeBytes) || freeBytes - artifactBytes < minimumFreeBytes) throw new Error('release_capacity_gate_failed')

let promoted = false
let handlingSignal = false

function promoteBuild(): void {
  let copiedStage = false
  try {
    fs.cpSync(artifact, stage, { recursive: true, errorOnExist: true, force: false })
    copiedStage = true
    if (readBuildId(stage) !== candidateBuild) throw new Error('staged_build_identity_mismatch')
    fs.rmSync(previous, { recursive: true, force: true })
    fs.renameSync(live, previous)
    try {
      fs.renameSync(stage, live)
      promoted = true
    } catch (error) {
      fs.renameSync(previous, live)
      throw error
    }
  } catch (error) {
    if (copiedStage && fs.existsSync(stage)) fs.rmSync(stage, { recursive: true, force: true })
    throw error
  }
}

function restoreBuild(): void {
  if (!promoted || !fs.existsSync(previous)) throw new Error('rollback_source_missing')
  fs.rmSync(live, { recursive: true, force: true })
  fs.renameSync(previous, live)
  promoted = false
}

const adapter: WebAnalogReleaseAdapter = {
  snapshotAgents,
  assertHealthy: () => { for (const url of healthUrls) waitForHealth(url) },
  promote: promoteBuild,
  restore: restoreBuild,
  kickstart: (label) => { command('/bin/launchctl', ['kickstart', '-k', `gui/${uid}/${label}`]) },
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    if (handlingSignal) return
    handlingSignal = true
    try {
      if (promoted) {
        restoreBuild()
        for (const label of WEB_ANALOG_TARGETS) adapter.kickstart(label)
        adapter.assertHealthy()
      }
    } catch (error) {
      console.error(`signal_rollback_failed:${signal}`, error)
    } finally {
      process.exit(signal === 'SIGINT' ? 130 : 143)
    }
  })
}

runWebAnalogRelease(adapter).then((result) => {
  console.log(JSON.stringify({
    status: 'SUCCESS', candidateBuild, artifactBytes, launchAgentDefinitionHashes,
    agentStatePreserved: true, rolledBack: result.rolledBack,
  }))
}).catch((error) => {
  console.error(error)
  process.exitCode = 1
})
