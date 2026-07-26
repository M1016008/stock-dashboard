// scripts/deploy-local-web-server.ts
//
// Build the production site into an isolated staging directory, promote it
// only after a successful build, and restore the previous build if the new
// service does not pass its health check.

import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const cwd = process.cwd()
const liveName = '.next-live'
const stageName = '.next-live-next'
const previousName = '.next-live-prev'
const livePath = path.join(cwd, liveName)
const stagePath = path.join(cwd, stageName)
const previousPath = path.join(cwd, previousName)
const legacyPath = path.join(cwd, '.next')
const healthUrl = `http://127.0.0.1:${process.env.STOCKBOARD_WEB_PORT || '3000'}/api/health`
const analogHealthUrl = `http://127.0.0.1:${process.env.STOCKBOARD_ANALOG_PORT || '3105'}/api/health`

function removeGenerated(pathname: string): void {
  fs.rmSync(pathname, { recursive: true, force: true })
}

function runNpm(script: string, env: NodeJS.ProcessEnv = process.env): void {
  execFileSync('npm', ['run', script], {
    cwd,
    env,
    stdio: 'inherit',
  })
}

function waitForHealth(url: string, timeoutSeconds = 60): boolean {
  const deadline = Date.now() + timeoutSeconds * 1_000
  while (Date.now() < deadline) {
    const result = spawnSync(
      '/usr/bin/curl',
      ['--silent', '--show-error', '--fail', '--max-time', '5', url],
      { encoding: 'utf8' },
    )
    if (result.status === 0 && result.stdout.includes('"status":"ok"')) return true
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1_000)
  }
  return false
}

removeGenerated(stagePath)
runNpm('test:historical-analogs')
runNpm('test:quote-technicals')
runNpm('test:us-screener-filters')
runNpm('test:physical-plan')
runNpm('test:timeframes')
runNpm('build', {
  ...process.env,
  NEXT_DIST_DIR: stageName,
})

if (!fs.existsSync(path.join(stagePath, 'BUILD_ID'))) {
  throw new Error(`Staged build is incomplete: ${stagePath}`)
}

removeGenerated(previousPath)
const hadPreviousBuild = fs.existsSync(livePath)
if (hadPreviousBuild) fs.renameSync(livePath, previousPath)
fs.renameSync(stagePath, livePath)

try {
  runNpm('web:install')
  if (!waitForHealth(healthUrl)) {
    throw new Error(`Health check did not recover within 60 seconds: ${healthUrl}`)
  }
  if (!waitForHealth(analogHealthUrl)) {
    throw new Error(`Analog worker did not recover within 60 seconds: ${analogHealthUrl}`)
  }
  console.log(`deployed: ${livePath}`)
  console.log(`health: ${healthUrl}`)
  console.log(`analog health: ${analogHealthUrl}`)
} catch (error) {
  console.error('New live build failed. Restoring the previous build.')
  removeGenerated(livePath)
  if (hadPreviousBuild && fs.existsSync(previousPath)) {
    fs.renameSync(previousPath, livePath)
    runNpm('web:install')
    if (!waitForHealth(healthUrl)) {
      throw new Error('Rollback completed on disk, but the previous service did not recover.', {
        cause: error,
      })
    }
  } else if (fs.existsSync(path.join(legacyPath, 'BUILD_ID'))) {
    runNpm('web:install', {
      ...process.env,
      STOCKBOARD_WEB_DIST_DIR: '.next',
    })
    if (!waitForHealth(healthUrl)) {
      throw new Error('Legacy rollback was installed, but the previous service did not recover.', {
        cause: error,
      })
    }
  }
  throw error
}
