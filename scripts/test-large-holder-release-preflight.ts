import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { assertLargeHolderReleaseConfiguration } from '@/lib/large-holders/release-preflight'
import { launchAgentLargeHolderEnvironmentXml } from './lib/launchagent-large-holder-environment'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stockboard-large-holder-release-'))
try {
  const operations = path.join(root, 'operations')
  const current = path.join(root, 'current.json')
  const snapshot = path.join(root, 'snapshot.json')
  const ledger = path.join(root, 'review.ndjson')
  fs.mkdirSync(operations)
  for (const filePath of [current, snapshot, ledger]) fs.writeFileSync(filePath, '{}\n')

  const environment: NodeJS.ProcessEnv = {
    NODE_ENV: 'test',
    LARGE_HOLDER_OPERATIONS_DIR: operations,
    LARGE_HOLDER_RANKING_CURRENT_PATH: current,
    LARGE_HOLDER_RANKING_SNAPSHOT_PATH: snapshot,
    LARGE_HOLDER_REVIEW_LEDGER_PATH: ledger,
  }
  const result = assertLargeHolderReleaseConfiguration(environment)
  assert.equal(result.configured, true)
  assert.equal(result.checkedKeys.length, 4)
  assert.deepEqual(result.environment, {
    LARGE_HOLDER_OPERATIONS_DIR: operations,
    LARGE_HOLDER_RANKING_CURRENT_PATH: current,
    LARGE_HOLDER_RANKING_SNAPSHOT_PATH: snapshot,
    LARGE_HOLDER_REVIEW_LEDGER_PATH: ledger,
  })
  const launchAgentXml = launchAgentLargeHolderEnvironmentXml(environment)
  for (const key of result.checkedKeys) {
    assert.match(launchAgentXml, new RegExp(`<key>${key}</key>`))
  }
  assert.ok(!launchAgentXml.includes('NODE_ENV'), 'Only approved non-secret Large Holder paths are forwarded')

  for (const key of result.checkedKeys) {
    const missing = { ...environment }
    delete missing[key]
    assert.throws(() => assertLargeHolderReleaseConfiguration(missing),
      new RegExp(`LARGE_HOLDER_RELEASE_CONFIG_MISSING:${key}`))
  }

  assert.throws(() => assertLargeHolderReleaseConfiguration({
    ...environment,
    LARGE_HOLDER_RANKING_CURRENT_PATH: 'relative/current.json',
  }), /LARGE_HOLDER_RELEASE_PATH_NOT_ABSOLUTE:LARGE_HOLDER_RANKING_CURRENT_PATH/)
  assert.throws(() => assertLargeHolderReleaseConfiguration({
    ...environment,
    LARGE_HOLDER_RANKING_CURRENT_PATH: path.join(root, 'missing.json'),
  }), /LARGE_HOLDER_RELEASE_PATH_UNAVAILABLE:LARGE_HOLDER_RANKING_CURRENT_PATH/)
  assert.throws(() => assertLargeHolderReleaseConfiguration({
    ...environment,
    LARGE_HOLDER_OPERATIONS_DIR: current,
  }), /LARGE_HOLDER_RELEASE_PATH_TYPE_MISMATCH:LARGE_HOLDER_OPERATIONS_DIR/)

  const deploySource = fs.readFileSync(path.join(process.cwd(), 'scripts/deploy-local-web-server.ts'), 'utf8')
  const preflightIndex = deploySource.indexOf('assertLargeHolderReleaseConfiguration()')
  const stageRemovalIndex = deploySource.indexOf('removeGenerated(stagePath)')
  const previousRemovalIndex = deploySource.indexOf('removeGenerated(previousPath)')
  assert.ok(preflightIndex >= 0 && preflightIndex < stageRemovalIndex,
    'Large Holder config must fail before a staging build starts')
  assert.ok(preflightIndex < previousRemovalIndex,
    'Large Holder config must fail before the prior Production build is touched')
  const installSource = fs.readFileSync(path.join(process.cwd(), 'scripts/install-local-web-server.ts'), 'utf8')
  assert.equal((installSource.match(/\$\{largeHolderEnvironment\}/g) ?? []).length, 2,
    'Web and Analog LaunchAgents must both receive the verified Large Holder paths')

  console.log('Large Holder release configuration preflight: PASS')
} finally {
  fs.rmSync(root, { recursive: true, force: true })
}
