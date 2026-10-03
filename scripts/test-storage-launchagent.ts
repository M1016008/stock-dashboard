import assert from 'node:assert/strict'
import fs from 'node:fs'

// Installer itself changes launchd state, so validate its source without invoking it.
const source = fs.readFileSync('scripts/install-local-web-server.ts', 'utf8')
const packageJson = JSON.parse(fs.readFileSync('package.json', 'utf8')) as {
  scripts?: Record<string, string>
}
const historical = source.split('const historicalScanPlist = ')[1]?.split('const healthScript = ')[0]
assert.ok(historical)
assert.match(historical, /<key>KeepAlive<\/key>\s*<false\/>/)
assert.match(historical, /<key>StartInterval<\/key>\s*<integer>300<\/integer>/)
assert.match(historical, /<key>ThrottleInterval<\/key>/)
assert.equal((source.match(/\$\{storageEnvironment\}/g) ?? []).length, 4)
assert.match(source, /storage-safety\.ts'\)\)} preflight/)
assert.match(source, /storageStatus.*unavailable/)
assert.match(packageJson.scripts?.['web:deploy'] ?? '', /--env-file-if-exists=\.env\.local/)
assert.match(packageJson.scripts?.['web:install'] ?? '', /--env-file-if-exists=\.env\.local/)
console.log('Storage LaunchAgent source: PASS (bounded restart, private config, preflight, degraded health)')
