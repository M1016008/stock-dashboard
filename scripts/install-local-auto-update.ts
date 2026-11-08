// scripts/install-local-auto-update.ts
//
// ローカルMacの launchd に StockBoard の日次自動更新を登録する。
// J-Quantsの日次株価更新を16:30以降とみなし、17:00までにサイト基準日を最新化する。

import fs from 'node:fs'
import path from 'node:path'
import {
  calendarXml, cwd, ensureLaunchAgentDirs, home, installLaunchAgent, launchAgentPlist, logPath, pathEnv, xmlEscape,
} from './lib/launchagent-install'
import { launchAgentStorageEnvironmentXml } from './lib/launchagent-storage-environment'

const label = 'com.stockboard.update-latest'
const configDir = path.join(home, 'Library', 'Application Support', 'StockBoard', 'config')
const runtimeEnvPath = path.join(configDir, 'runtime.env')
const productionEnvPath = path.join(configDir, 'production.env')

function marketDayRetrySchedule(): string {
  // launchd Weekday: 1=Monday ... 5=Friday.
  // Exchange holidays are harmless no-op runs in the updater, but weekends
  // must not consume memory or contend with weekly ML governance.
  const weekdays = [1, 2, 3, 4, 5]
  const times = [
    [16, 40],
    [16, 55],
    [17, 20],
    [18, 10],
    [21, 10],
  ] as const
  return weekdays.flatMap((weekday) => times.map(([hour, minute]) => calendarXml(hour, minute, weekday))).join('\n')
}

ensureLaunchAgentDirs()

for (const envPath of [runtimeEnvPath, productionEnvPath]) {
  if (!fs.existsSync(envPath)) throw new Error(`Canonical machine env is missing: ${envPath}`)
  if ((fs.statSync(envPath).mode & 0o077) !== 0) {
    throw new Error(`Canonical machine env must be owner-only: ${envPath}`)
  }
}
if (!/^JQUANTS_API_KEY=.+$/m.test(fs.readFileSync(runtimeEnvPath, 'utf8'))) {
  throw new Error('Canonical runtime env is missing JQUANTS_API_KEY')
}

const command = [
  `cd ${JSON.stringify(cwd)}`,
  `export PATH=${JSON.stringify(pathEnv)}`,
  'export USE_LOCAL_DB=1',
  'export STOCKBOARD_MEMORY_MIN_FREE_PERCENT=${STOCKBOARD_MEMORY_MIN_FREE_PERCENT:-20}',
  'export STOCKBOARD_MEMORY_MIN_AVAILABLE_MB=${STOCKBOARD_MEMORY_MIN_AVAILABLE_MB:-0}',
  'export STOCKBOARD_MEMORY_MAX_COMPRESSOR_MB=${STOCKBOARD_MEMORY_MAX_COMPRESSOR_MB:-8192}',
  'export STOCKBOARD_MEMORY_WAIT_SECONDS=${STOCKBOARD_MEMORY_WAIT_SECONDS:-1800}',
  'export STOCKBOARD_NODE_MAX_OLD_SPACE_MB=${STOCKBOARD_NODE_MAX_OLD_SPACE_MB:-3072}',
  // A busy optional writer must fail fast enough for the next scheduled
  // repair to run. Required refreshes still retry through their own jobs.
  'export SQLITE_BUSY_TIMEOUT_MS=${SQLITE_BUSY_TIMEOUT_MS:-15000}',
  'export SQLITE_BUSY_RETRIES=${SQLITE_BUSY_RETRIES:-6}',
  'export UPDATE_LOCK_BUSY_RETRIES=${UPDATE_LOCK_BUSY_RETRIES:-20}',
  'export UPDATE_LOCK_WAIT_SECONDS=${UPDATE_LOCK_WAIT_SECONDS:-1800}',
  'export UPDATE_LOCK_POLL_SECONDS=${UPDATE_LOCK_POLL_SECONDS:-30}',
  'export UPDATE_CHILD_TIMEOUT_MINUTES=75',
  'export UPDATE_OPTIONAL_CHILD_TIMEOUT_MINUTES=${UPDATE_OPTIONAL_CHILD_TIMEOUT_MINUTES:-30}',
  'export UPDATE_LATEST_OPTIONAL_AFTER_HOUR=${UPDATE_LATEST_OPTIONAL_AFTER_HOUR:-21}',
  'export SKIP_DAILY_ML=1',
  'export SERVING_DATE_LIMIT=${SERVING_DATE_LIMIT:-60}',
  'export SERVING_SUMMARY_DATE_CHUNK=${SERVING_SUMMARY_DATE_CHUNK:-30}',
  'export SERVING_RESULT_DATE_CHUNK=${SERVING_RESULT_DATE_CHUNK:-10}',
  'export SERVING_EVIDENCE_DATE_CHUNK=${SERVING_EVIDENCE_DATE_CHUNK:-10}',
  // 夕方の差分更新は全期間再計算に倒さない。全期間ML/PMSは週次ジョブへ分離する。
  'export PMS_DAILY_RECENT_DAYS=${PMS_DAILY_RECENT_DAYS:-30}',
  'export ML_DAILY_RECENT_DAYS=${ML_DAILY_RECENT_DAYS:-5}',
  'export ML_DAILY_MIN_HISTORY_DAYS=${ML_DAILY_MIN_HISTORY_DAYS:-220}',
  'export ML_DAILY_LABEL_RECENT_DAYS=${ML_DAILY_LABEL_RECENT_DAYS:-30}',
  'export ML_DAILY_EXTREMA_RECENT_DAYS=${ML_DAILY_EXTREMA_RECENT_DAYS:-60}',
  'export ML_DAILY_RL_RECENT_DAYS=${ML_DAILY_RL_RECENT_DAYS:-60}',
  'export ML_DAILY_STATUS_RECENT_DAYS=${ML_DAILY_STATUS_RECENT_DAYS:-60}',
  'export ML_CONTEXT_DAILY_RECENT_DAYS=${ML_CONTEXT_DAILY_RECENT_DAYS:-5}',
  'export ML_PHYSICS_DAILY_RECENT_DAYS=${ML_PHYSICS_DAILY_RECENT_DAYS:-5}',
  'export ML_PHYSICS_DAILY_MIN_HISTORY_DAYS=${ML_PHYSICS_DAILY_MIN_HISTORY_DAYS:-220}',
  [
    JSON.stringify(process.execPath),
    `--env-file=${JSON.stringify(runtimeEnvPath)}`,
    `--env-file=${JSON.stringify(productionEnvPath)}`,
    '--import tsx scripts/update-latest.ts',
  ].join(' '),
].join(' && ')

const plist = launchAgentPlist(label, command, `  <key>StartCalendarInterval</key>
  <array>
${marketDayRetrySchedule()}
  </array>
  <key>StandardOutPath</key>
  <string>${xmlEscape(logPath('update-latest.log'))}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(logPath('update-latest.err'))}</string>
  <key>RunAtLoad</key>
  <false/>`, launchAgentStorageEnvironmentXml('  '))

const plistPath = installLaunchAgent(label, plist, { retryBootstrap: true })

console.log(`launchd registered: ${plistPath}`)
console.log('schedule: Mon-Fri 16:40, 16:55, 17:20, 18:10, 21:10 JST')
console.log(`logs: ${logPath('update-latest.log')}`)
