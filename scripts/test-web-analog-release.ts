import assert from 'node:assert/strict'
import fs, { readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { activeArtifactTreeIdentity, artifactTreeIdentity, SMA_RELEASE_MANIFEST, verifySmaReleaseManifest } from '@/lib/release/artifact-manifest'
import {
  PRODUCTION_AGENT_INVENTORY,
  WEB_ANALOG_TARGETS,
  assertReleaseLaunchAgentDefinition,
  recoverReleaseWithBestEffortSignals,
  runWebAnalogRelease,
  type AgentSnapshot,
  type ProductionAgentLabel,
  type ReleaseLaunchAgentDefinition,
  type WebAnalogReleaseAdapter,
} from '@/lib/release/web-analog-only'

function snapshot(): AgentSnapshot {
  return Object.fromEntries(PRODUCTION_AGENT_INVENTORY.map((label) => [label, {
    loaded: !['com.stockboard.weekly-optimization', 'com.stockboard.ml-learning'].includes(label),
    disabled: ['com.stockboard.weekly-optimization', 'com.stockboard.ml-learning'].includes(label),
    state: ['com.stockboard.weekly-optimization', 'com.stockboard.ml-learning'].includes(label) ? null : 'running',
  }])) as AgentSnapshot
}

function clone(value: AgentSnapshot): AgentSnapshot {
  return structuredClone(value)
}

function fixture(options: { candidateHealthFails?: boolean; rollbackFails?: boolean; mutateNonTarget?: boolean } = {}) {
  const before = snapshot()
  let current = clone(before)
  let promoted = false
  let healthChecks = 0
  const calls: string[] = []
  const adapter: WebAnalogReleaseAdapter = {
    snapshotAgents: () => {
      calls.push('snapshot')
      if (promoted && options.mutateNonTarget) current['com.stockboard.weekly-optimization'] = { loaded: true, disabled: false, state: 'running' }
      return clone(current)
    },
    assertHealthy: () => {
      calls.push('health')
      healthChecks += 1
      if (options.candidateHealthFails && promoted && healthChecks === 2) throw new Error('candidate_health_failed')
      if (options.rollbackFails && !promoted && healthChecks > 2) throw new Error('rollback_health_failed')
    },
    promote: () => { calls.push('promote'); promoted = true },
    restore: () => {
      calls.push('restore')
      promoted = false
      current = clone(before)
      if (options.rollbackFails) throw new Error('rollback_failed')
    },
    kickstart: (label) => { calls.push(`kickstart:${label}`) },
  }
  return { adapter, calls, before, get promoted() { return promoted } }
}

async function main(): Promise<void> {
{
  const calls: string[] = []
  const recovery = recoverReleaseWithBestEffortSignals({
    freezeRequired: true,
    signal: (signal) => {
      calls.push(signal)
      return signal === 'SIGSTOP'
        ? { signaled: 1, errors: ['SIGSTOP:fixture:missing_process'] }
        : { signaled: 1, errors: [] }
    },
    rollback: () => { calls.push('rollback'); return false },
  })
  assert.deepEqual(calls, ['SIGSTOP', 'rollback', 'SIGCONT'])
  assert.equal(recovery.restartRequired, true, 'signal failure must force a supervised restart')
}

{
  const calls: string[] = []
  assert.throws(() => recoverReleaseWithBestEffortSignals({
    freezeRequired: true,
    signal: (signal) => { calls.push(signal); return { signaled: 2, errors: [] } },
    rollback: () => { calls.push('rollback'); throw new Error('fixture_rollback_failed') },
  }), /release_rollback_failed_hold/)
  assert.deepEqual(calls, ['SIGSTOP', 'rollback'], 'an unverified generation must remain fail-closed')
}

{
  const releaseRoot = '/fixture/stock-dashboard'
  const definition = (label: (typeof WEB_ANALOG_TARGETS)[number]): ReleaseLaunchAgentDefinition => ({
    Label: label,
    WorkingDirectory: releaseRoot,
    ProgramArguments: ['/fixture/node', `${releaseRoot}/node_modules/next/dist/bin/next`, 'start'],
    EnvironmentVariables: {
      NODE_ENV: 'production',
      STOCKBOARD_PROCESS_ROLE: label === 'com.stockboard.web' ? 'web' : 'analog-search',
      NEXT_DIST_DIR: '.next-live',
      SKIP_SCHEMA_ENSURE: '1',
      USE_LOCAL_DB: '1',
      EXTERNAL_STORAGE_REQUIRED: 'true',
      STOCKBOARD_DB_PATH: '/fixture/owc/stockboard.db',
      STOCK_DATA_MOUNT_PATH: '/fixture/owc',
      STOCK_DATA_VOLUME_UUID: 'fixture-volume',
      STOCK_DATA_MIN_FREE_BYTES: '1',
      STOCK_DATA_MIN_FREE_PERCENT: '1',
    },
  })
  for (const label of WEB_ANALOG_TARGETS) assertReleaseLaunchAgentDefinition(label, definition(label), releaseRoot)
  const wrongRoot = definition('com.stockboard.web')
  wrongRoot.WorkingDirectory = '/wrong/root'
  assert.throws(() => assertReleaseLaunchAgentDefinition('com.stockboard.web', wrongRoot, releaseRoot), /working_directory_mismatch/)
  const missingIdentity = definition('com.stockboard.analog-search')
  delete missingIdentity.EnvironmentVariables!.STOCK_DATA_VOLUME_UUID
  assert.throws(() => assertReleaseLaunchAgentDefinition('com.stockboard.analog-search', missingIdentity, releaseRoot), /storage_identity_missing/)
}

{
  const run = fixture()
  const result = await runWebAnalogRelease(run.adapter)
  assert.equal(result.rolledBack, false)
  assert.deepEqual(run.calls, ['snapshot', 'health', 'promote', ...WEB_ANALOG_TARGETS.map((label) => `kickstart:${label}`), 'health', 'snapshot'])
  assert.equal(run.promoted, true)
}

{
  const run = fixture({ candidateHealthFails: true })
  await assert.rejects(() => runWebAnalogRelease(run.adapter), /web_analog_release_rolled_back/)
  assert.equal(run.promoted, false)
  assert.ok(run.calls.includes('restore'))
  assert.deepEqual(run.before['com.stockboard.weekly-optimization'], { loaded: false, disabled: true, state: null })
}

{
  const run = fixture({ mutateNonTarget: true })
  await assert.rejects(() => runWebAnalogRelease(run.adapter), /web_analog_release_rolled_back/)
  assert.equal(run.promoted, false)
}

{
  const run = fixture({ candidateHealthFails: true, rollbackFails: true })
  await assert.rejects(
    () => runWebAnalogRelease(run.adapter),
    (error: AggregateError) => error instanceof AggregateError && error.errors.length >= 2,
  )
}

// A partial promote must be recovered even when promote() throws before it returns.
{
  const before = snapshot()
  let uncertain = false
  let restored = false
  const calls: string[] = []
  const adapter: WebAnalogReleaseAdapter = {
    snapshotAgents: () => clone(before),
    assertHealthy: () => { calls.push('health') },
    promote: () => {
      calls.push('promote')
      uncertain = true
      throw new Error('crash_during_promote')
    },
    needsRecovery: () => uncertain,
    restore: () => {
      calls.push('restore')
      uncertain = false
      restored = true
      return false
    },
    kickstart: (label) => { calls.push(`kickstart:${label}`) },
  }
  await assert.rejects(() => runWebAnalogRelease(adapter), /rolled_back_or_held/)
  assert.equal(restored, true)
  assert.equal(calls.some((call) => call.startsWith('kickstart:')), false)
}

// A foreign journal or lock must fail closed without touching services or attempting rollback.
{
  const before = snapshot()
  let restoreCalled = false
  const adapter: WebAnalogReleaseAdapter = {
    snapshotAgents: () => clone(before),
    assertHealthy: () => undefined,
    promote: () => { throw new Error('foreign_release_transaction_present') },
    needsRecovery: () => false,
    restore: () => { restoreCalled = true },
    kickstart: () => undefined,
  }
  await assert.rejects(() => runWebAnalogRelease(adapter), /web_analog_release_preflight_failed/)
  assert.equal(restoreCalled, false)
}

// The rehearsal uses real directory renames while all service operations remain synthetic.
{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'web-analog-release-'))
  const live = path.join(root, '.next-live')
  const previous = path.join(root, '.next-live-prev')
  const stage = path.join(root, '.next-live-next')
  fs.mkdirSync(live)
  fs.writeFileSync(path.join(live, 'BUILD_ID'), 'old-build')
  const before = snapshot()
  let promoted = false
  let healthChecks = 0
  const adapter: WebAnalogReleaseAdapter = {
    snapshotAgents: () => clone(before),
    assertHealthy: () => {
      healthChecks += 1
      if (promoted && healthChecks === 2) throw new Error('fixture_candidate_failed')
    },
    promote: () => {
      fs.mkdirSync(stage)
      fs.writeFileSync(path.join(stage, 'BUILD_ID'), 'candidate-build')
      fs.renameSync(live, previous)
      fs.renameSync(stage, live)
      promoted = true
    },
    restore: () => {
      fs.rmSync(live, { recursive: true })
      fs.renameSync(previous, live)
      promoted = false
    },
    kickstart: () => undefined,
  }
  await assert.rejects(() => runWebAnalogRelease(adapter), /web_analog_release_rolled_back/)
  assert.equal(fs.readFileSync(path.join(live, 'BUILD_ID'), 'utf8'), 'old-build')
  assert.equal(fs.existsSync(previous), false)
  fs.rmSync(root, { recursive: true })
}

{
  const source = readFileSync('scripts/deploy-web-analog-only.ts', 'utf8')
  for (const forbidden of ["['bootstrap'", "['bootout'", "['enable'", "['disable'"]) {
    assert.equal(source.includes(`/bin/launchctl', ${forbidden}`), false, `forbidden launchctl mutation: ${forbidden}`)
  }
  assert.doesNotMatch(source, /db:ensure-schema|web:install|auto-daily-refresh|trigger:ml-monitor|storage:recover|FAILED_SAFE/)
  assert.match(source, /STOCKBOARD_EXPECTED_WEB_PLIST_SHA256/)
  assert.match(source, /STOCKBOARD_EXPECTED_ANALOG_PLIST_SHA256/)
  assert.match(source, /STOCKBOARD_EXPECTED_RELEASE_ROOT_REALPATH/)
  assert.match(source, /STOCKBOARD_PREFLIGHT_PROOF_SHA256/)
  assert.match(source, /STOCKBOARD_EXPECTED_RUNTIME_IDENTITY_SHA256/)
  assert.match(source, /STOCKBOARD_RELEASE_STATE_DIR/)
  assert.match(source, /SIGSTOP/)
  assert.match(source, /WebAnalogReleaseTransaction/)
  assert.match(source, /\{ \.\.\.process\.env, NODE_ENV: 'production' \}/,
    'runtime dependency identity must use the same production npm environment as runtime construction')
  assert.ok(source.indexOf('const proof = verifySmaReleasePreflightProof') < source.indexOf('const transaction = new WebAnalogReleaseTransaction'))
  assert.equal(source.match(/verifySmaReleasePreflightProof\(proofOptions\)/g)?.length, 1,
    'the initial proof check must require every attested path to be unchanged')
  assert.match(source, /verifyProofDuringOwnedTransaction\('PREPARED'\)/,
    'the staged recheck must distinguish the runner-owned lock and journal')
  assert.match(source, /verifyProofDuringOwnedTransaction\('TARGETS_FROZEN'\)/,
    'the activation recheck must verify runner ownership immediately before mutation')
  assert.match(source, /transaction\.assertOwnedState\(expectedStage\)/)
  assert.match(source, /errorEvidence\(error\)/, 'nested release failures must remain observable')
  assert.match(source, /WEB_ANALOG_TARGETS/)
  const contract = readFileSync('lib/release/web-analog-only.ts', 'utf8')
  for (const label of WEB_ANALOG_TARGETS) assert.match(contract, new RegExp(label.replaceAll('.', '\\.')))
}

{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sma-release-manifest-'))
  fs.writeFileSync(path.join(root, 'BUILD_ID'), 'fixture-build')
  fs.mkdirSync(path.join(root, 'server'))
  fs.writeFileSync(path.join(root, 'server', 'fixture.js'), 'fixture')
  const identity = artifactTreeIdentity(root)
  fs.writeFileSync(path.join(root, SMA_RELEASE_MANIFEST), JSON.stringify({
    version: 1,
    candidateCommit: 'a'.repeat(40),
    baselineCommit: '034310b72f57163ee4607c05d1057310277a787d',
    buildId: 'fixture-build',
    ...identity,
  }))
  assert.equal(verifySmaReleaseManifest(root, 'a'.repeat(40)).treeSha256, identity.treeSha256)
  fs.mkdirSync(path.join(root, 'server', 'route-cache'), { recursive: true })
  fs.writeFileSync(path.join(root, 'server', 'route-cache', 'runtime-cache.body'), 'runtime-cache')
  assert.equal(activeArtifactTreeIdentity(root).treeSha256, identity.treeSha256,
    'known Next.js runtime cache must not change the active generation identity')
  assert.notEqual(artifactTreeIdentity(root).treeSha256, identity.treeSha256,
    'the immutable artifact manifest must still reject runtime cache in a source artifact')
  fs.rmSync(path.join(root, 'server', 'route-cache'), { recursive: true })
  fs.writeFileSync(path.join(root, 'server', 'fixture.js'), 'tampered')
  assert.throws(() => verifySmaReleaseManifest(root, 'a'.repeat(40)), /candidate_manifest_content_mismatch/)
  fs.rmSync(root, { recursive: true })
}

console.log('test-web-analog-release: ok')
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
