// FinnhubのUS決算予定を毎日同期するlaunchdジョブを登録する。

import {
  cwd, ensureLaunchAgentDirs, installLaunchAgent, launchAgentPlist, logPath, pathEnv, xmlEscape,
} from './lib/launchagent-install'

const label = 'com.stockboard.us-earnings'

if (!process.env.FINNHUB_API_KEY?.trim()) {
  throw new Error('FINNHUB_API_KEY is required before installing the US earnings schedule')
}

ensureLaunchAgentDirs()

const command = [
  `cd ${JSON.stringify(cwd)}`,
  `export PATH=${JSON.stringify(pathEnv)}`,
  'export USE_LOCAL_DB=1',
  'export SQLITE_BUSY_TIMEOUT_MS=${SQLITE_BUSY_TIMEOUT_MS:-15000}',
  'export SQLITE_BUSY_RETRIES=${SQLITE_BUSY_RETRIES:-12}',
  'npm run batch:us-earnings',
].join(' && ')

// No EnvironmentVariables dict: this job has never carried the storage environment.
const plist = launchAgentPlist(label, command, `  <key>StartCalendarInterval</key>
  <dict>
    <key>Hour</key><integer>18</integer>
    <key>Minute</key><integer>30</integer>
  </dict>
  <key>StandardOutPath</key>
  <string>${xmlEscape(logPath('us-earnings.log'))}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(logPath('us-earnings.err'))}</string>
  <key>RunAtLoad</key>
  <false/>`)

const plistPath = installLaunchAgent(label, plist)

console.log(`launchd registered: ${plistPath}`)
console.log('schedule: daily 18:30 JST')
console.log(`logs: ${logPath('us-earnings.log')}`)
