import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const label = 'com.stockboard.friend-readonly-gateway'
const cwd = process.cwd()
const home = os.homedir()
const launchAgentsDir = path.join(home, 'Library', 'LaunchAgents')
const logDir = path.join(home, 'Library', 'Logs', 'StockBoard')
const plistPath = path.join(launchAgentsDir, `${label}.plist`)
const uid = typeof process.getuid === 'function' ? process.getuid() : Number(process.env.UID)
const host = '127.0.0.1'
const port = '3136'
const origin = 'http://127.0.0.1:3000'

function xmlEscape(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;')
}

fs.mkdirSync(launchAgentsDir, { recursive: true })
fs.mkdirSync(logDir, { recursive: true })

const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${label}</string>
  <key>WorkingDirectory</key><string>${xmlEscape(cwd)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xmlEscape(process.execPath)}</string>
    <string>--import</string><string>tsx</string>
    <string>scripts/run-friend-readonly-gateway.ts</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    <key>STOCKBOARD_FRIEND_GATEWAY_HOST</key><string>${host}</string>
    <key>STOCKBOARD_FRIEND_GATEWAY_PORT</key><string>${port}</string>
    <key>STOCKBOARD_FRIEND_ORIGIN</key><string>${origin}</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>${xmlEscape(path.join(logDir, 'friend-readonly-gateway.log'))}</string>
  <key>StandardErrorPath</key><string>${xmlEscape(path.join(logDir, 'friend-readonly-gateway.err'))}</string>
</dict>
</plist>
`

fs.writeFileSync(plistPath, plist)
try {
  execFileSync('launchctl', ['bootout', `gui/${uid}`, plistPath], { stdio: 'ignore' })
} catch {
  // A missing prior registration is expected on first install.
}
execFileSync('launchctl', ['bootstrap', `gui/${uid}`, plistPath], { stdio: 'inherit' })
execFileSync('launchctl', ['enable', `gui/${uid}/${label}`], { stdio: 'inherit' })

console.log(`friend read-only gateway registered: ${plistPath}`)
console.log(`listen: http://${host}:${port}`)
console.log(`origin: ${origin}`)
