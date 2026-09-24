import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const productionLaunchAgentLabels = [
  'com.stockboard.web',
  'com.stockboard.analog-search',
  'com.stockboard.trigger-historical-scan',
  'com.stockboard.web-health',
  'com.stockboard.update-latest',
  'com.stockboard.classification-sync',
  'com.stockboard.kabutan-material-news',
  'com.stockboard.kabutan-themes',
  'com.stockboard.earnings-refresh',
  'com.stockboard.us-update-latest',
  'com.stockboard.ml-learning',
  'com.stockboard.ml-freshness-guard',
  'com.stockboard.data-freshness-guard',
  'com.stockboard.weekly-optimization',
  'com.stockboard.db-maintenance',
  'com.stockboard.trigger-ml-frozen-monitor',
] as const

type Plist = {
  WorkingDirectory?: string
  EnvironmentVariables?: Record<string, string>
}

type RuntimeRow = {
  label: string
  pid: number | null
  state: string
  loaded: boolean
  configuredCwd: string | null
  actualCwd: string | null
  head: string | null
  buildId: string | null
  environmentKeys: string[]
}

function commandText(command: string, args: string[], cwd?: string): string | null {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8' })
  return result.status === 0 ? result.stdout.trim() : null
}

function readPlist(plistPath: string): Plist {
  const output = execFileSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', plistPath], {
    encoding: 'utf8', maxBuffer: 1_000_000,
  })
  return JSON.parse(output) as Plist
}

function processCwd(pid: number | null): string | null {
  if (!pid) return null
  const output = commandText('/usr/sbin/lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'])
  return output?.split('\n').find((line) => line.startsWith('n'))?.slice(1) || null
}

function runtimeRow(label: string): RuntimeRow {
  const plistPath = path.join(os.homedir(), 'Library', 'LaunchAgents', `${label}.plist`)
  if (!fs.existsSync(plistPath)) {
    return {
      label, pid: null, state: 'missing', loaded: false, configuredCwd: null,
      actualCwd: null, head: null, buildId: null, environmentKeys: [],
    }
  }
  const plist = readPlist(plistPath)
  const configuredCwd = plist.WorkingDirectory ? path.resolve(plist.WorkingDirectory) : null
  const launch = commandText('/bin/launchctl', ['print', `gui/${process.getuid?.()}/${label}`])
  const pidMatch = launch?.match(/\bpid = (\d+)/)
  const stateMatch = launch?.match(/\bstate = ([^\n]+)/)
  const pid = pidMatch ? Number(pidMatch[1]) : null
  const buildPath = configuredCwd ? path.join(configuredCwd, '.next-live', 'BUILD_ID') : null
  return {
    label,
    pid,
    state: stateMatch?.[1]?.trim() ?? (launch ? 'loaded' : 'unloaded'),
    loaded: Boolean(launch),
    configuredCwd,
    actualCwd: processCwd(pid),
    head: configuredCwd ? commandText('/usr/bin/git', ['rev-parse', 'HEAD'], configuredCwd) : null,
    buildId: buildPath && fs.existsSync(buildPath) ? fs.readFileSync(buildPath, 'utf8').trim() : null,
    environmentKeys: Object.keys(plist.EnvironmentVariables ?? {}).sort(),
  }
}

const expectedWorktree = path.resolve(process.env.STOCKBOARD_EXPECTED_WORKTREE?.trim() || process.cwd())
const expectedHead = commandText('/usr/bin/git', ['rev-parse', 'HEAD'], expectedWorktree)
const requireCurrent = process.env.STOCKBOARD_RUNTIME_AUDIT_REQUIRE_CURRENT === '1'
const rows = productionLaunchAgentLabels.map(runtimeRow)

console.table(rows.map((row) => ({
  label: row.label.replace('com.stockboard.', ''),
  pid: row.pid ?? '-',
  state: row.state,
  cwd: row.configuredCwd ?? '-',
  actualCwd: row.actualCwd ?? '-',
  head: row.head?.slice(0, 12) ?? '-',
  build: row.buildId ?? '-',
})))
console.log(JSON.stringify({ expectedWorktree, expectedHead, rows }))

if (requireCurrent) {
  const mismatches = rows.filter((row) => !row.loaded
    || row.configuredCwd !== expectedWorktree
    || row.head !== expectedHead
    || (row.actualCwd !== null && row.actualCwd !== expectedWorktree))
  if (mismatches.length > 0) {
    throw new Error(`production_runtime_version_mismatch:${mismatches.map((row) => row.label).join(',')}`)
  }
}
