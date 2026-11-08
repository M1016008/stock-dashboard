// Shared plist rendering and launchctl registration for local StockBoard LaunchAgents.
// Job-specific schedules, preflights and stdout stay in each installer.

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const cwd = process.cwd()
export const home = os.homedir()
export const launchAgentsDir = path.join(home, 'Library', 'LaunchAgents')
export const logDir = path.join(home, 'Library', 'Logs', 'StockBoard')
export const uid = typeof process.getuid === 'function' ? process.getuid() : Number(process.env.UID)
export const pathEnv = [
  '/opt/homebrew/bin',
  '/usr/local/bin',
  '/usr/bin',
  '/bin',
  '/usr/sbin',
  '/sbin',
].join(':')

export function xmlEscape(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;')
}

export function launchAgentPlistPath(label: string): string {
  return path.join(launchAgentsDir, `${label}.plist`)
}

export function ensureLaunchAgentDirs(): void {
  fs.mkdirSync(launchAgentsDir, { recursive: true })
  fs.mkdirSync(logDir, { recursive: true })
}

export function logPath(fileName: string): string {
  return path.join(logDir, fileName)
}

export function calendarXml(hour: number, minute: number, weekday?: number): string {
  return [
    '    <dict>',
    ...(weekday === undefined ? [] : [`      <key>Weekday</key><integer>${weekday}</integer>`]),
    `      <key>Hour</key><integer>${hour}</integer>`,
    `      <key>Minute</key><integer>${minute}</integer>`,
    '    </dict>',
  ].join('\n')
}

// `body` is the job-specific XML after ProgramArguments. Omitting
// `environmentXml` renders no EnvironmentVariables dict.
export function launchAgentPlist(label: string, command: string, body: string, environmentXml?: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${label}</string>
  <key>WorkingDirectory</key>
  <string>${xmlEscape(cwd)}</string>
${environmentXml === undefined ? '' : `${environmentXml}\n`}  <key>ProgramArguments</key>
  <array>
    <string>/bin/zsh</string>
    <string>-lc</string>
    <string>${xmlEscape(command)}</string>
  </array>
${body}
</dict>
</plist>
`
}

function sleep(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

function bootstrap(plistPath: string, attempts: number): void {
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

// Write the plist, then bootout (ignored when unregistered) -> bootstrap -> enable.
// `retryBootstrap` waits 750ms after bootout and retries bootstrap up to 6 times.
export function installLaunchAgent(label: string, plist: string, { retryBootstrap = false } = {}): string {
  const plistPath = launchAgentPlistPath(label)
  fs.writeFileSync(plistPath, plist)
  try {
    execFileSync('launchctl', ['bootout', `gui/${uid}`, plistPath], { stdio: 'ignore' })
  } catch {
    // Not registered yet.
  }
  if (retryBootstrap) sleep(750)
  bootstrap(plistPath, retryBootstrap ? 6 : 1)
  execFileSync('launchctl', ['enable', `gui/${uid}/${label}`], { stdio: 'inherit' })
  return plistPath
}
