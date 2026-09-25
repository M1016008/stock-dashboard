import assert from 'node:assert/strict'
import fs from 'node:fs'

const read = (filePath: string): string => fs.readFileSync(filePath, 'utf8')
const deploy = read('scripts/deploy-local-web-server.ts')
const daily = read('scripts/install-local-daily-refresh.ts')
const monitor = read('scripts/install-local-trigger-ml-monitor.ts')
const audit = read('scripts/audit-local-production-runtime.ts')

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

console.log('Production storage runtime topology: PASS (16 managed LaunchAgents, unified worktree audit)')
