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
const webOrigin = `http://127.0.0.1:${process.env.STOCKBOARD_WEB_PORT || '3000'}`
const healthUrl = `${webOrigin}/api/health`
const analogHealthUrl = `http://127.0.0.1:${process.env.STOCKBOARD_ANALOG_PORT || '3105'}/api/health`
const requiredStagedRoutes = [
  '/api/financial-overview/[ticker]/route',
  '/api/financial-performance-timeline/[ticker]/route',
  '/api/financial-performance-detail/[ticker]/route',
  '/api/financial-detail/[ticker]/route',
  '/api/valuation-detail/[ticker]/route',
  '/api/shareholder-returns/[ticker]/route',
  '/api/company-information/[ticker]/route',
  '/api/similarity-comparison/[ticker]/route',
  '/api/integrated-screener/route',
  '/api/integrated-screener/reason/route',
  '/api/integrated-screener/interpret/route',
  '/api/integrated-screener/saved/route',
  '/api/integrated-screener/saved/[id]/route',
  '/api/integrated-screener/saved/[id]/reason/route',
] as const

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

function assertRequiredRoutes(buildPath: string): void {
  const manifestPath = path.join(buildPath, 'server', 'app-paths-manifest.json')
  if (!fs.existsSync(manifestPath)) throw new Error(`Staged route manifest is missing: ${manifestPath}`)
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as Record<string, string>
  const missing = requiredStagedRoutes.filter((route) => !manifest[route])
  if (missing.length > 0) {
    throw new Error(`Staged build is missing required Phase 1-13 routes: ${missing.join(', ')}`)
  }
}

removeGenerated(stagePath)
runNpm('test:layout-shell')
runNpm('test:status-health')
runNpm('test:ml-reliability')
runNpm('test:remote-access')
runNpm('test:manual-import-removal')
runNpm('test:historical-analogs')
runNpm('test:safe-spreadsheet')
runNpm('test:classification-source')
runNpm('test:quote-technicals')
runNpm('test:us-screener-filters')
runNpm('test:us-screener-period-metrics')
runNpm('test:us-automation-foundation')
runNpm('test:physical-plan')
runNpm('test:timeframes')
runNpm('build', {
  ...process.env,
  NEXT_DIST_DIR: stageName,
})

if (!fs.existsSync(path.join(stagePath, 'BUILD_ID'))) {
  throw new Error(`Staged build is incomplete: ${stagePath}`)
}
assertRequiredRoutes(stagePath)

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
  runNpm('test:site-smoke', {
    ...process.env,
    STOCKBOARD_SMOKE_BASE_URL: webOrigin,
  })
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
