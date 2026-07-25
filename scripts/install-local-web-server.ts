// scripts/install-local-web-server.ts
//
// Register the production Next.js server and a lightweight health monitor as
// launchd agents. The monitor restarts the server after three consecutive
// failed health checks.

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const webLabel = 'com.stockboard.web'
const analogLabel = 'com.stockboard.analog-search'
const healthLabel = 'com.stockboard.web-health'
const cwd = process.cwd()
const home = os.homedir()
const uid = typeof process.getuid === 'function' ? process.getuid() : Number(process.env.UID)
const launchAgentsDir = path.join(home, 'Library', 'LaunchAgents')
const logDir = path.join(home, 'Library', 'Logs', 'StockBoard')
const stateDir = path.join(home, 'Library', 'Application Support', 'StockBoard')
const webPlistPath = path.join(launchAgentsDir, `${webLabel}.plist`)
const analogPlistPath = path.join(launchAgentsDir, `${analogLabel}.plist`)
const healthPlistPath = path.join(launchAgentsDir, `${healthLabel}.plist`)
const healthScriptPath = path.join(stateDir, 'check-web-health.zsh')
const nextBin = path.join(cwd, 'node_modules', 'next', 'dist', 'bin', 'next')
const liveDistDir = process.env.STOCKBOARD_WEB_DIST_DIR || '.next-live'
const buildIdPath = path.join(cwd, liveDistDir, 'BUILD_ID')
const port = integerEnv('STOCKBOARD_WEB_PORT', 3000, 1, 65535)
const analogPort = integerEnv('STOCKBOARD_ANALOG_PORT', 3105, 1, 65535)
const heapMb = integerEnv('STOCKBOARD_WEB_MAX_OLD_SPACE_MB', 2048, 512, 8192)
const analogHeapMb = integerEnv('STOCKBOARD_ANALOG_MAX_OLD_SPACE_MB', 1536, 512, 4096)
const healthIntervalSeconds = integerEnv('STOCKBOARD_WEB_HEALTH_INTERVAL_SECONDS', 60, 30, 3600)
const healthTimeoutSeconds = integerEnv('STOCKBOARD_WEB_HEALTH_TIMEOUT_SECONDS', 20, 5, 120)
const healthFailureThreshold = integerEnv('STOCKBOARD_WEB_HEALTH_FAILURE_THRESHOLD', 3, 2, 10)
const pathEnv = [
  '/opt/homebrew/bin',
  '/usr/local/bin',
  '/usr/bin',
  '/bin',
  '/usr/sbin',
  '/sbin',
].join(':')

function integerEnv(name: string, fallback: number, min: number, max: number): number {
  const parsed = Number(process.env[name])
  if (!Number.isInteger(parsed)) return fallback
  return Math.max(min, Math.min(max, parsed))
}

function xmlEscape(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;')
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`
}

function bootout(label: string): void {
  try {
    execFileSync('launchctl', ['bootout', `gui/${uid}/${label}`], { stdio: 'ignore' })
  } catch {
    // The service may not be registered yet.
  }
}

function sleep(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

function bootstrap(plistPath: string, attempts = 6): void {
  let lastError: unknown
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      execFileSync('launchctl', ['bootstrap', `gui/${uid}`, plistPath], {
        stdio: attempt === attempts ? 'inherit' : 'ignore',
      })
      return
    } catch (error) {
      lastError = error
      if (attempt < attempts) sleep(500 * attempt)
    }
  }
  throw lastError
}

if (!fs.existsSync(nextBin)) {
  throw new Error(`Next.js executable was not found: ${nextBin}`)
}
if (!fs.existsSync(buildIdPath)) {
  throw new Error(`Production build is missing: ${buildIdPath}. Run npm run web:deploy before web:install.`)
}

fs.mkdirSync(launchAgentsDir, { recursive: true })
fs.mkdirSync(logDir, { recursive: true })
fs.mkdirSync(stateDir, { recursive: true })

const webPlist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${webLabel}</string>
  <key>WorkingDirectory</key>
  <string>${xmlEscape(cwd)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xmlEscape(process.execPath)}</string>
    <string>${xmlEscape(nextBin)}</string>
    <string>start</string>
    <string>-p</string>
    <string>${port}</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>NODE_ENV</key><string>production</string>
    <key>NODE_OPTIONS</key><string>--max-old-space-size=${heapMb}</string>
    <key>NEXT_DIST_DIR</key><string>${liveDistDir}</string>
    <key>ANALOG_SEARCH_PROXY_URL</key><string>http://127.0.0.1:${analogPort}</string>
    <key>PATH</key><string>${xmlEscape(pathEnv)}</string>
    <key>SKIP_SCHEMA_ENSURE</key><string>1</string>
    <key>STOCKBOARD_DB_READ_CONCURRENCY</key><string>2</string>
    <key>SQLITE_BUSY_RETRIES</key><string>3</string>
    <key>SQLITE_BUSY_TIMEOUT_MS</key><string>5000</string>
    <key>US_SQLITE_BUSY_RETRIES</key><string>3</string>
    <key>USE_LOCAL_DB</key><string>1</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>30</integer>
  <key>ProcessType</key>
  <string>Standard</string>
  <key>Nice</key>
  <integer>5</integer>
  <key>SoftResourceLimits</key>
  <dict>
    <key>NumberOfFiles</key><integer>65536</integer>
  </dict>
  <key>StandardOutPath</key>
  <string>${xmlEscape(path.join(logDir, 'web.log'))}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(path.join(logDir, 'web.err'))}</string>
</dict>
</plist>
`

const analogPlist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${analogLabel}</string>
  <key>WorkingDirectory</key>
  <string>${xmlEscape(cwd)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xmlEscape(process.execPath)}</string>
    <string>${xmlEscape(nextBin)}</string>
    <string>start</string>
    <string>-p</string>
    <string>${analogPort}</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>NODE_ENV</key><string>production</string>
    <key>NODE_OPTIONS</key><string>--max-old-space-size=${analogHeapMb}</string>
    <key>NEXT_DIST_DIR</key><string>${liveDistDir}</string>
    <key>ANALOG_SEARCH_WORKER</key><string>1</string>
    <key>ANALOG_SEQUENCE_APPROXIMATE_LIMIT</key><string>400</string>
    <key>ANALOG_SEQUENCE_RECENCY_SHORTLIST_LIMIT</key><string>260</string>
    <key>PATH</key><string>${xmlEscape(pathEnv)}</string>
    <key>SKIP_SCHEMA_ENSURE</key><string>1</string>
    <key>SQLITE_BUSY_RETRIES</key><string>3</string>
    <key>SQLITE_BUSY_TIMEOUT_MS</key><string>5000</string>
    <key>US_SQLITE_BUSY_RETRIES</key><string>3</string>
    <key>USE_LOCAL_DB</key><string>1</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>30</integer>
  <key>ProcessType</key>
  <string>Standard</string>
  <key>Nice</key>
  <integer>12</integer>
  <key>SoftResourceLimits</key>
  <dict>
    <key>NumberOfFiles</key><integer>65536</integer>
  </dict>
  <key>StandardOutPath</key>
  <string>${xmlEscape(path.join(logDir, 'analog-search.log'))}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(path.join(logDir, 'analog-search.err'))}</string>
</dict>
</plist>
`

const healthScript = `#!/bin/zsh
set -u

check_service() {
  local health_url="$1"
  local label="$2"
  local count_file="$3"

  if /usr/bin/curl --silent --fail --max-time ${healthTimeoutSeconds} "$health_url" | /usr/bin/grep --quiet '"status":"ok"'; then
    /bin/echo 0 > "$count_file"
    return
  fi

  local count=0
  if [[ -f "$count_file" ]]; then
    count=$(/bin/cat "$count_file" 2>/dev/null || /bin/echo 0)
  fi
  if ! [[ "$count" =~ ^[0-9]+$ ]]; then
    count=0
  fi
  count=$((count + 1))
  /bin/echo "$count" > "$count_file"
  /bin/echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) $label health check failed count=$count"

  if (( count >= ${healthFailureThreshold} )); then
    /bin/echo 0 > "$count_file"
    /bin/launchctl kickstart -k "gui/$UID/$label"
    /bin/echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) restarted $label after $count failures"
  fi
}

check_service \
  ${shellQuote(`http://127.0.0.1:${port}/api/health`)} \
  ${shellQuote(webLabel)} \
  ${shellQuote(path.join(stateDir, 'web-health-failures'))}
check_service \
  ${shellQuote(`http://127.0.0.1:${analogPort}/api/health`)} \
  ${shellQuote(analogLabel)} \
  ${shellQuote(path.join(stateDir, 'analog-health-failures'))}

exit 0
`

const healthPlist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${healthLabel}</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/zsh</string>
    <string>${xmlEscape(healthScriptPath)}</string>
  </array>
  <key>StartInterval</key>
  <integer>${healthIntervalSeconds}</integer>
  <key>RunAtLoad</key>
  <true/>
  <key>ProcessType</key>
  <string>Background</string>
  <key>StandardOutPath</key>
  <string>${xmlEscape(path.join(logDir, 'web-health.log'))}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(path.join(logDir, 'web-health.err'))}</string>
</dict>
</plist>
`

fs.writeFileSync(webPlistPath, webPlist)
fs.writeFileSync(analogPlistPath, analogPlist)
fs.writeFileSync(healthPlistPath, healthPlist)
fs.writeFileSync(healthScriptPath, healthScript, { mode: 0o755 })

bootout(healthLabel)
bootout(webLabel)
bootout(analogLabel)
sleep(750)

bootstrap(analogPlistPath)
execFileSync('launchctl', ['enable', `gui/${uid}/${analogLabel}`], { stdio: 'inherit' })
bootstrap(webPlistPath)
execFileSync('launchctl', ['enable', `gui/${uid}/${webLabel}`], { stdio: 'inherit' })
bootstrap(healthPlistPath)
execFileSync('launchctl', ['enable', `gui/${uid}/${healthLabel}`], { stdio: 'inherit' })
execFileSync('launchctl', ['kickstart', `gui/${uid}/${webLabel}`], { stdio: 'inherit' })

console.log(`web service: ${webLabel} http://localhost:${port}`)
console.log(
  `analog worker: ${analogLabel} http://127.0.0.1:${analogPort} `
  + `(heap ${analogHeapMb} MB, standard I/O + low CPU priority)`,
)
console.log(
  `health monitor: ${healthLabel} checks web + analog every ${healthIntervalSeconds}s `
  + `(timeout ${healthTimeoutSeconds}s, restart after ${healthFailureThreshold} failures)`,
)
console.log(`heap limit: ${heapMb} MB`)
console.log(`logs: ${path.join(logDir, 'web.log')}`)
