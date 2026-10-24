import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  ExternalStorageGuard,
  configForDatabase,
  type StorageProbe,
  type VolumeIdentity,
} from '@/lib/storage/external-storage-guard'
import {
  SCRUBBED_RUNTIME_CREDENTIALS,
  assertIsolatedRuntimeEnvironment,
  createIsolatedRuntimeEnvironment,
} from '@/lib/runtime/isolation'

const scriptPath = fileURLToPath(import.meta.url)
const probeMode = process.argv[2]

async function runDatabaseProbe(): Promise<void> {
  const { client } = await import('@/lib/db/client')
  if (probeMode === '--probe-db-open') await client.execute('SELECT 1')
}

function mismatchProbe(mountPath: string, dbPath: string): StorageProbe {
  const observed: VolumeIdentity = {
    mountPoint: mountPath,
    uuid: 'wrong-volume-uuid',
    filesystem: 'apfs',
    writable: true,
    freeBytes: 1_000,
    totalBytes: 2_000,
  }
  return {
    volume: () => observed,
    mountPresent: () => true,
    realpath: (value) => value,
    stat: (value) => ({
      dev: 42,
      isFile: () => value === dbPath,
      isDirectory: () => value === mountPath,
    }),
    exists: (value) => value === mountPath || value === dbPath,
  }
}

const MUTATING_TEST_COMMANDS = [
  'test:saved-triggers',
  'test:saved-trigger-api',
  'test:saved-trigger-search-equivalence',
  'test:trigger-evaluations',
  'test:trigger-evaluation-integration',
  'test:trigger-lifecycle-integration',
  'test:trigger-lifecycle-real',
  'test:trigger-daily-evaluations',
  'test:trigger-notifications',
  'test:trigger-notification-api',
  'test:trigger-gmail-delivery',
  'test:trigger-discovery-historical',
  'test:trigger-discovery-historical-scan',
  'test:trigger-discovery-historical-scan-jobs',
  'test:trigger-path-research-worker',
  'test:trigger-discovery-outcomes',
  'test:trigger-worker-recovery',
  'test:trigger-discovery-outcome-segments',
  'test:trigger-discovery-outcome-robustness',
  'test:financial-overview',
  'test:valuation-serving',
  'test:release-fix-2',
  'test:saved-screening-evaluations',
  'test:stock-sector-context',
  'test:historical-sector-universe',
  'test:historical-analogs:calibrate',
  'test:sector-structure-universe',
  'test:sector-constituent-filters',
] as const

async function main(): Promise<void> {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'stockboard-runtime-isolation-'))
  const originalEnvironment = { ...process.env }
  try {
    const isolationRoot = path.join(temporary, 'isolated')
    const poisoned: NodeJS.ProcessEnv = {
      ...process.env,
      NODE_ENV: 'production',
      TURSO_DATABASE_URL: 'libsql://production.invalid',
      TURSO_AUTH_TOKEN: 'production-token',
      STOCKBOARD_DB_PATH: '/Volumes/Production/stockboard.db',
      LOCAL_DB_PATH: '/Volumes/Production/stockboard.db',
      US_ANALYTICS_DB_PATH: '/Volumes/Production/stockboard-us.db',
      STOCK_DATA_MOUNT_PATH: '/Volumes/Production',
      STOCK_DATA_VOLUME_UUID: 'production-volume-uuid',
      STOCK_DATA_INCIDENT_DIR: path.join(temporary, 'production-incidents'),
      JQUANTS_API_KEY: 'production-jquants-key',
      OPENAI_API_KEY: 'production-openai-key',
    }
    const isolated = createIsolatedRuntimeEnvironment('test', isolationRoot, poisoned)
    assert.equal(assertIsolatedRuntimeEnvironment(isolated), 'test')
    assert.equal(isolated.NODE_ENV, 'test')
    assert.equal(isolated.USE_LOCAL_DB, '1')
    assert.equal(isolated.STOCKBOARD_DB_PATH, path.join(isolationRoot, 'data', 'stockboard.db'))
    assert.equal(isolated.STOCK_DATA_INCIDENT_DIR, path.join(isolationRoot, 'storage-incidents'))
    for (const name of SCRUBBED_RUNTIME_CREDENTIALS) assert.equal(isolated[name], '', `${name} must be scrubbed`)

    const invalid = { ...isolated, TURSO_DATABASE_URL: poisoned.TURSO_DATABASE_URL }
    assert.throws(
      () => assertIsolatedRuntimeEnvironment(invalid),
      /TURSO_DATABASE_URL must be pinned/,
      'poisoned credentials must be refused before a DB client can be created',
    )

    const poisonedDbPath = path.join(temporary, 'must-not-open.db')
    const refused = spawnSync(process.execPath, ['--import', 'tsx', scriptPath, '--probe-import'], {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: {
        ...isolated,
        STOCKBOARD_DB_PATH: poisonedDbPath,
        TURSO_DATABASE_URL: 'libsql://127.0.0.1:9',
      },
    })
    assert.notEqual(refused.status, 0)
    assert.match(`${refused.stderr}${refused.stdout}`, /Unsafe isolated runtime environment/)
    assert.equal(fs.existsSync(poisonedDbPath), false, 'refusal must happen before opening a DB')

    const buildRoot = path.join(temporary, 'build')
    const buildEnvironment = createIsolatedRuntimeEnvironment('build', buildRoot, poisoned)
    const buildDbPath = buildEnvironment.STOCKBOARD_DB_PATH as string
    const blockedBuildOpen = spawnSync(process.execPath, ['--import', 'tsx', scriptPath, '--probe-db-open'], {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: buildEnvironment,
    })
    assert.notEqual(blockedBuildOpen.status, 0)
    assert.match(`${blockedBuildOpen.stderr}${blockedBuildOpen.stdout}`, /Database opens are forbidden/)
    assert.equal(fs.existsSync(buildDbPath), false, 'isolated builds must not open even their synthetic DB')

    const rejectedEnvFile = spawnSync(process.execPath, [
      '--import', 'tsx', 'scripts/run-isolated-runtime.ts', 'test', '--',
      process.execPath, '--env-file=.env.local', '-e', 'process.exit(0)',
    ], { cwd: process.cwd(), encoding: 'utf8', env: process.env })
    assert.notEqual(rejectedEnvFile.status, 0)
    assert.match(`${rejectedEnvFile.stderr}${rejectedEnvFile.stdout}`, /must never load \.env\.local/)

    const packageJson = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf8')) as {
      scripts: Record<string, string>
    }
    for (const name of ['dev', 'dev:3000']) {
      assert.match(packageJson.scripts[name], /run-isolated-runtime\.ts development -- next dev/)
    }
    assert.match(packageJson.scripts['build:isolated'], /run-isolated-runtime\.ts build -- next build/)
    for (const name of MUTATING_TEST_COMMANDS) {
      const command = packageJson.scripts[name]
      assert.ok(command?.includes('scripts/run-isolated-runtime.ts test --'), `${name} must use test isolation`)
      assert.equal(command.includes('.env.local'), false, `${name} must not load .env.local`)
    }
    assert.match(packageJson.scripts['test:site-smoke'], /smoke-production-site\.ts/)
    assert.equal(packageJson.scripts['test:site-smoke'].includes('run-isolated-runtime'), false)
    assert.match(packageJson.scripts['test:large-holder-production-smoke'], /test-large-holder-production-smoke\.ts/)

    const productionIncidentDir = path.join(temporary, 'production-incidents')
    fs.mkdirSync(productionIncidentDir, { recursive: true })
    fs.writeFileSync(path.join(productionIncidentDir, 'FAILED_SAFE'), 'existing production latch\n')
    const developmentRoot = path.join(temporary, 'development')
    Object.assign(process.env, {
      NODE_ENV: 'development',
      STOCKBOARD_RUNTIME_SCOPE: 'development',
      STOCKBOARD_ISOLATION_ROOT: developmentRoot,
      STOCKBOARD_DB_OPEN_FORBIDDEN: '0',
      STOCK_DATA_INCIDENT_DIR: productionIncidentDir,
      STOCK_DATA_MOUNT_PATH: '/Volumes/fixture-production',
      STOCK_DATA_VOLUME_UUID: 'expected-volume-uuid',
    })
    const externalDb = '/Volumes/fixture-production/stockboard.db'
    const developmentConfig = configForDatabase(externalDb, 'development-regression')
    assert.equal(developmentConfig.incidentDir, path.join(developmentRoot, 'storage-incidents'))
    const developmentGuard = new ExternalStorageGuard(
      developmentConfig,
      mismatchProbe('/Volumes/fixture-production', externalDb),
    )
    assert.throws(
      () => developmentGuard.assertWritable(true),
      (error: { storageCode?: string }) => error.storageCode === 'VOLUME_UUID_MISMATCH',
      'development must ignore the pre-existing Production latch and evaluate its own guard',
    )
    assert.equal(fs.readFileSync(path.join(productionIncidentDir, 'FAILED_SAFE'), 'utf8'), 'existing production latch\n')
    assert.equal(fs.existsSync(path.join(developmentRoot, 'storage-incidents', 'FAILED_SAFE')), true)

    const productionMismatchDir = path.join(temporary, 'production-mismatch')
    Reflect.set(process.env, 'NODE_ENV', 'production')
    delete process.env.STOCKBOARD_RUNTIME_SCOPE
    delete process.env.STOCKBOARD_ISOLATION_ROOT
    delete process.env.STOCKBOARD_DB_OPEN_FORBIDDEN
    process.env.STOCK_DATA_INCIDENT_DIR = productionMismatchDir
    const productionConfig = configForDatabase(externalDb, 'production-regression')
    const productionGuard = new ExternalStorageGuard(
      productionConfig,
      mismatchProbe('/Volumes/fixture-production', externalDb),
    )
    assert.throws(
      () => productionGuard.assertWritable(true),
      (error: { storageCode?: string }) => error.storageCode === 'VOLUME_UUID_MISMATCH',
    )
    assert.equal(fs.existsSync(path.join(productionMismatchDir, 'FAILED_SAFE')), true,
      'configured Production mismatch must remain fail-closed')

    console.log('Runtime isolation test passed')
  } finally {
    for (const name of Object.keys(process.env)) {
      if (!(name in originalEnvironment)) delete process.env[name]
    }
    Object.assign(process.env, originalEnvironment)
    fs.rmSync(temporary, { recursive: true, force: true })
  }
}

if (probeMode?.startsWith('--probe-')) {
  runDatabaseProbe().catch((error) => {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  })
} else {
  main().catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
}
