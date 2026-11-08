// scripts/install-local-ml-learning.ts
//
// ローカルMacの launchd に、日次ML serving更新ジョブを登録する。
// 当日引け後を本実行、翌早朝を自動再試行枠として登録する。

import {
  calendarXml, cwd, ensureLaunchAgentDirs, installLaunchAgent, launchAgentPlist, logPath, pathEnv, xmlEscape,
} from './lib/launchagent-install'
import { launchAgentStorageEnvironmentXml } from './lib/launchagent-storage-environment'

const label = 'com.stockboard.ml-learning'
const scheduleHour = Number(process.env.ML_LEARNING_HOUR ?? '22')
const scheduleMinute = Number(process.env.ML_LEARNING_MINUTE ?? '30')
const retryHour = Number(process.env.ML_LEARNING_RETRY_HOUR ?? '3')
const retryMinute = Number(process.env.ML_LEARNING_RETRY_MINUTE ?? '0')

function weekdaySchedule(): string {
  // launchd Weekday: 1=Monday ... 6=Saturday, 0/7=Sunday.
  // Japanese exchange holidays are handled inside scripts/run-ml-learning.ts.
  return [1, 2, 3, 4, 5]
    .flatMap((weekday) => [
      calendarXml(scheduleHour, scheduleMinute, weekday),
      calendarXml(retryHour, retryMinute, weekday),
    ])
    .join('\n')
}

ensureLaunchAgentDirs()

const command = [
  `cd ${JSON.stringify(cwd)}`,
  `export PATH=${JSON.stringify(pathEnv)}`,
  'export USE_LOCAL_DB=1',
  'export STOCKBOARD_MEMORY_MIN_FREE_PERCENT=${STOCKBOARD_MEMORY_MIN_FREE_PERCENT:-20}',
  'export STOCKBOARD_MEMORY_MIN_AVAILABLE_MB=${STOCKBOARD_MEMORY_MIN_AVAILABLE_MB:-0}',
  'export STOCKBOARD_MEMORY_MAX_COMPRESSOR_MB=${STOCKBOARD_MEMORY_MAX_COMPRESSOR_MB:-8192}',
  'export STOCKBOARD_MEMORY_WAIT_SECONDS=${STOCKBOARD_MEMORY_WAIT_SECONDS:-1800}',
  'export STOCKBOARD_NODE_MAX_OLD_SPACE_MB=${STOCKBOARD_NODE_MAX_OLD_SPACE_MB:-3072}',
  'export SQLITE_BUSY_TIMEOUT_MS=${SQLITE_BUSY_TIMEOUT_MS:-15000}',
  'export SQLITE_BUSY_RETRIES=${SQLITE_BUSY_RETRIES:-12}',
  'export UPDATE_CHILD_TIMEOUT_MINUTES=${UPDATE_CHILD_TIMEOUT_MINUTES:-240}',
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
  'export ML_LEARNING_MAX_ATTEMPTS=${ML_LEARNING_MAX_ATTEMPTS:-2}',
  'export ML_LEARNING_RETRY_DELAY_SECONDS=${ML_LEARNING_RETRY_DELAY_SECONDS:-300}',
  'export ML_LEARNING_LOCK_WAIT_MINUTES=${ML_LEARNING_LOCK_WAIT_MINUTES:-60}',
  'export ML_LEARNING_BATCH_WAIT_MINUTES=${ML_LEARNING_BATCH_WAIT_MINUTES:-60}',
  'npm run batch:ml-learning-daily',
].join(' && ')

const plist = launchAgentPlist(label, command, `  <key>StartCalendarInterval</key>
  <array>
${weekdaySchedule()}
  </array>
  <key>StandardOutPath</key>
  <string>${xmlEscape(logPath('ml-learning.log'))}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(logPath('ml-learning.err'))}</string>
  <key>RunAtLoad</key>
  <false/>`, launchAgentStorageEnvironmentXml('  '))

const plistPath = installLaunchAgent(label, plist)

console.log(`launchd registered: ${plistPath}`)
console.log(
  `schedule: Mon-Fri ${String(scheduleHour).padStart(2, '0')}:${String(scheduleMinute).padStart(2, '0')} JST`
  + ` + retry ${String(retryHour).padStart(2, '0')}:${String(retryMinute).padStart(2, '0')} JST;`
  + ' JP exchange holidays are skipped by the wrapper',
)
console.log(`logs: ${logPath('ml-learning.log')}`)
