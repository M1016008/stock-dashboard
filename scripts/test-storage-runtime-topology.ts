import assert from 'node:assert/strict'
import fs from 'node:fs'
import {
  launchAgentStorageEnvironmentXml,
  launchAgentStorageIdentityKeys,
} from './lib/launchagent-storage-environment'

const read = (filePath: string): string => fs.readFileSync(filePath, 'utf8')
const deploy = read('scripts/deploy-local-web-server.ts')
const daily = read('scripts/install-local-daily-refresh.ts')
const monitor = read('scripts/install-local-trigger-ml-monitor.ts')
const audit = read('scripts/audit-local-production-runtime.ts')
const storageEnvironment = read('scripts/lib/launchagent-storage-environment.ts')

assert.match(deploy, /auto-daily-refresh:install/)
assert.match(deploy, /trigger:ml-monitor-install/)
assert.match(deploy, /STOCKBOARD_FORCE_REINSTALL: '1'/)
assert.match(deploy, /storage:runtime-audit/)
assert.match(deploy, /STOCKBOARD_RUNTIME_AUDIT_REQUIRE_CURRENT: '1'/)
assert.match(daily, /STOCKBOARD_FORCE_REINSTALL === '1'/)
assert.match(monitor, /STOCKBOARD_FORCE_REINSTALL === '1'/)

const labels = [
  'web', 'analog-search', 'trigger-historical-scan', 'web-health', 'update-latest',
  'classification-sync', 'kabutan-material-news', 'kabutan-themes', 'earnings-refresh',
  'us-update-latest', 'ml-learning', 'ml-freshness-guard', 'data-freshness-guard',
  'weekly-optimization', 'db-maintenance', 'trigger-ml-frozen-monitor',
]
for (const label of labels) assert.match(audit, new RegExp(`com\\.stockboard\\.${label.replace('-', '\\-')}`))
assert.match(audit, /configuredCwd !== expectedWorktree/)
assert.match(audit, /row\.head !== expectedHead/)
assert.match(audit, /actualCwd !== expectedWorktree/)
assert.match(audit, /environmentKeys/)
assert.match(audit, /missingStorageEnvironmentKeys/)
assert.match(audit, /launchAgentStorageIdentityKeys/)

const scheduledInstallers = [
  'install-local-auto-update.ts',
  'install-local-classification-sync.ts',
  'install-local-kabutan-material-news.ts',
  'install-local-kabutan-themes.ts',
  'install-local-earnings-refresh.ts',
  'install-local-us-auto-update.ts',
  'install-local-ml-learning.ts',
  'install-local-ml-freshness-guard.ts',
  'install-local-data-freshness-guard.ts',
  'install-local-weekly-optimization.ts',
  'install-local-db-maintenance.ts',
  'install-local-trigger-ml-monitor.ts',
]
for (const installer of scheduledInstallers) {
  assert.match(read(`scripts/${installer}`), /launchAgentStorageEnvironmentXml/)
}
for (const key of [
  'EXTERNAL_STORAGE_REQUIRED',
  'STOCKBOARD_DB_PATH',
  'STOCK_DATA_MOUNT_PATH',
  'STOCK_DATA_VOLUME_UUID',
  'STOCK_DATA_MIN_FREE_BYTES',
  'STOCK_DATA_MIN_FREE_PERCENT',
]) {
  assert.match(storageEnvironment, new RegExp(`'${key}'`))
}

const originalEnvironment = { ...process.env }
Object.assign(process.env, {
  EXTERNAL_STORAGE_REQUIRED: 'true',
  STOCKBOARD_DB_PATH: '/Volumes/fixture/stockboard.db',
  STOCK_DATA_MOUNT_PATH: '/Volumes/fixture',
  STOCK_DATA_VOLUME_UUID: 'fixture-volume-uuid',
  STOCK_DATA_MIN_FREE_BYTES: '1000',
  STOCK_DATA_MIN_FREE_PERCENT: '5',
  US_ANALYTICS_DB_PATH: '/Volumes/fixture/us.db',
})
const environmentXml = launchAgentStorageEnvironmentXml()
for (const key of launchAgentStorageIdentityKeys) {
  assert.match(environmentXml, new RegExp(`<key>${key}</key>`))
}
assert.match(environmentXml, /<key>US_ANALYTICS_DB_PATH<\/key>/)
process.env = originalEnvironment

console.log('Production storage runtime topology: PASS (16 managed LaunchAgents, unified worktree and storage identity audit)')
