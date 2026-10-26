import assert from 'node:assert/strict'
import fs, { readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { artifactTreeIdentity, SMA_RELEASE_MANIFEST, verifySmaReleaseManifest } from '@/lib/release/artifact-manifest'
import {
  PRODUCTION_AGENT_INVENTORY,
  WEB_ANALOG_TARGETS,
  assertReleaseLaunchAgentDefinition,
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
