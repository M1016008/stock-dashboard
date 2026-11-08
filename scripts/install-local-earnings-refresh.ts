// scripts/install-local-earnings-refresh.ts
//
// Register a local launchd job that refreshes the earnings calendar and actual disclosure times.
// The refresh uses J-Quants + JPX official data and warms dashboard cache.

import fs from 'node:fs'
import path from 'node:path'
import { parseEnv } from 'node:util'
import {
  calendarXml, cwd, ensureLaunchAgentDirs, home, installLaunchAgent, launchAgentPlist, logPath, pathEnv, xmlEscape,
} from './lib/launchagent-install'
import { launchAgentStorageEnvironmentXml } from './lib/launchagent-storage-environment'

const label = 'com.stockboard.earnings-refresh'
const supportDir = path.join(home, 'Library', 'Application Support', 'StockBoard')
const deferredPath = path.join(supportDir, 'earnings-refresh-deferred')
const configDir = path.join(supportDir, 'config')
// Scoped credential file: J-Quants only. The job must not inherit unrelated
// secrets (OpenAI, Gmail OAuth, Tiingo) from the shared runtime.env.
const jquantsEnvPath = path.join(configDir, 'jquants.env')
const productionEnvPath = path.join(configDir, 'production.env')
const scheduleHour = Number(process.env.EARNINGS_REFRESH_HOUR ?? '7')
const scheduleMinute = Number(process.env.EARNINGS_REFRESH_MINUTE ?? '10')

function clampHour(value: number): number {
  return Number.isInteger(value) && value >= 0 && value <= 23 ? value : 7
}

function clampMinute(value: number): number {
  return Number.isInteger(value) && value >= 0 && value <= 59 ? value : 10
}

ensureLaunchAgentDirs()
fs.mkdirSync(supportDir, { recursive: true })

// util.parseEnv (the parser behind `node --env-file`) needs Node >= 20.12. Production runs
// /usr/local/bin/node v24.11.1 and CI pins Node 24.
const [nodeMajor, nodeMinor] = process.versions.node.split('.').map(Number)
if (nodeMajor < 20 || (nodeMajor === 20 && nodeMinor < 12) || typeof parseEnv !== 'function') {
  throw new Error(`install-local-earnings-refresh requires Node >= 20.12 (running ${process.versions.node})`)
}

// Value of KEY in one line, parsed exactly as `node --env-file` does (quotes, # comments).
function dotenvValue(line: string | undefined, key: string): string {
  return (line ? parseEnv(line)[key] ?? '' : '').trim()
}

// Keep the scoped file in sync with the canonical runtime.env (owner-only, values never printed).
// A reissued key in runtime.env is propagated here on every install.
const runtimeEnvPath = path.join(configDir, 'runtime.env')
const runtimeLine = fs.existsSync(runtimeEnvPath)
  ? fs.readFileSync(runtimeEnvPath, 'utf8').split('\n').find((entry) => entry.trim().startsWith('JQUANTS_API_KEY='))
  : undefined
if (runtimeLine && dotenvValue(runtimeLine, 'JQUANTS_API_KEY')) {
  const current = fs.existsSync(jquantsEnvPath) ? fs.readFileSync(jquantsEnvPath, 'utf8') : null
  const desired = `${runtimeLine.trim()}\n`
  if (current !== desired) {
    const temporary = `${jquantsEnvPath}.${process.pid}.tmp`
    fs.writeFileSync(temporary, desired, { mode: 0o600, flag: 'wx' })
    fs.renameSync(temporary, jquantsEnvPath)
    console.log(`${current === null ? 'provisioned' : 'synchronized'} ${jquantsEnvPath} from runtime.env (key: JQUANTS_API_KEY)`)
  }
} else if (!fs.existsSync(jquantsEnvPath)) {
  throw new Error(`Cannot provision ${jquantsEnvPath}: runtime.env has no non-empty JQUANTS_API_KEY`)
}
for (const envPath of [jquantsEnvPath, productionEnvPath]) {
  if (!fs.existsSync(envPath)) throw new Error(`Canonical machine env is missing: ${envPath}`)
  if ((fs.statSync(envPath).mode & 0o077) !== 0) {
    throw new Error(`Canonical machine env must be owner-only: ${envPath}`)
  }
}
const jquantsEnvLines = fs.readFileSync(jquantsEnvPath, 'utf8')
  .split('\n')
  .map((line) => line.trim())
  .filter((line) => line && !line.startsWith('#'))
if (jquantsEnvLines.length !== 1 || !dotenvValue(jquantsEnvLines[0], 'JQUANTS_API_KEY')) {
  throw new Error('jquants.env must contain exactly one key: JQUANTS_API_KEY (non-empty)')
}

const hour = clampHour(scheduleHour)
const minute = clampMinute(scheduleMinute)
const retryHour = clampHour(Number(process.env.EARNINGS_REFRESH_RETRY_HOUR ?? '14'))
const retryMinute = clampMinute(Number(process.env.EARNINGS_REFRESH_RETRY_MINUTE ?? '10'))
const closeHour = clampHour(Number(process.env.EARNINGS_REFRESH_CLOSE_HOUR ?? '16'))
const closeMinute = clampMinute(Number(process.env.EARNINGS_REFRESH_CLOSE_MINUTE ?? '30'))
const command = [
  `cd ${JSON.stringify(cwd)}`,
  `export PATH=${JSON.stringify(pathEnv)}`,
  'export USE_LOCAL_DB=1',
  'export SQLITE_BUSY_TIMEOUT_MS=${SQLITE_BUSY_TIMEOUT_MS:-15000}',
  'export SQLITE_BUSY_RETRIES=${SQLITE_BUSY_RETRIES:-8}',
  'export EARNINGS_REFRESH_MAX_ATTEMPTS=${EARNINGS_REFRESH_MAX_ATTEMPTS:-3}',
  'export EARNINGS_REFRESH_RETRY_DELAY_SECONDS=${EARNINGS_REFRESH_RETRY_DELAY_SECONDS:-300}',
  'export EARNINGS_REFRESH_WAIT_FOR_LOCK_SECONDS=${EARNINGS_REFRESH_WAIT_FOR_LOCK_SECONDS:-2700}',
  'export EARNINGS_REFRESH_LOCK_POLL_SECONDS=${EARNINGS_REFRESH_LOCK_POLL_SECONDS:-30}',
  `export EARNINGS_REFRESH_DEFERRED_PATH=${JSON.stringify(deferredPath)}`,
  [
    JSON.stringify(process.execPath),
    `--env-file=${JSON.stringify(jquantsEnvPath)}`,
    `--env-file=${JSON.stringify(productionEnvPath)}`,
    '--import tsx scripts/refresh-earnings.ts',
  ].join(' '),
].join(' && ')

const plist = launchAgentPlist(label, command, `  <key>StartCalendarInterval</key>
  <array>
${[[hour, minute], [retryHour, retryMinute], [closeHour, closeMinute]].map(([h, m]) => calendarXml(h, m)).join('\n')}
  </array>
  <key>StandardOutPath</key>
  <string>${xmlEscape(logPath('earnings-refresh.log'))}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(logPath('earnings-refresh.err'))}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>PathState</key>
    <dict>
      <key>${xmlEscape(deferredPath)}</key>
      <true/>
    </dict>
  </dict>
  <key>ProcessType</key>
  <string>Background</string>
  <key>LowPriorityIO</key>
  <true/>
  <key>Nice</key>
  <integer>10</integer>
  <key>ThrottleInterval</key>
  <integer>300</integer>`, launchAgentStorageEnvironmentXml('  '))

const plistPath = installLaunchAgent(label, plist)

console.log(`launchd registered: ${plistPath}`)
console.log(
  `schedule: daily ${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')} and `
  + `${String(retryHour).padStart(2, '0')}:${String(retryMinute).padStart(2, '0')} and `
  + `${String(closeHour).padStart(2, '0')}:${String(closeMinute).padStart(2, '0')} JST`,
)
console.log('command: node --env-file=jquants.env --env-file=production.env --import tsx scripts/refresh-earnings.ts')
console.log(`logs: ${logPath('earnings-refresh.log')}`)
