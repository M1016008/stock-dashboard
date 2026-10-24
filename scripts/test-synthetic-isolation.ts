import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import {
  FORBIDDEN_ENVIRONMENT_VARIABLES,
  PATH_ENVIRONMENT_VARIABLES,
  applySyntheticEnvironment,
  assertSyntheticEnvironment,
  createSyntheticRuntime,
  findIsolationViolations,
  internalTempRoot,
  isSyntheticPath,
  syntheticChildEnv,
} from './lib/synthetic-isolation'

const savedEnv = { ...process.env }
const runtime = createSyntheticRuntime('isolation-selftest')

try {
  // The runtime lives under the internal temp root, never on an external volume.
  assert.ok(isSyntheticPath(runtime.root), 'runtime root must be inside the internal temp root')
  assert.equal(runtime.root.startsWith('/Volumes/'), false)
  assert.ok(fs.existsSync(runtime.incidentDir))
  for (const name of PATH_ENVIRONMENT_VARIABLES) {
    const value = runtime.env[name]
    if (value) assert.ok(isSyntheticPath(value), `${name} must be bound to the runtime`)
  }

  // Path classification: traversal, external volumes and symlink escapes are rejected.
  assert.equal(isSyntheticPath('/Volumes/OWC Express 1M2 80G/stock-dashboard/stockboard.db'), false)
  assert.equal(isSyntheticPath('/Volumes/anything'), false)
  assert.equal(isSyntheticPath(path.join(runtime.root, '..', '..', 'etc', 'hosts')), false)
  assert.equal(isSyntheticPath(path.join(runtime.root, 'nested', 'new.db')), true, 'not-yet-created children are allowed')
  assert.equal(isSyntheticPath(path.join(internalTempRoot(), 'sibling-outside-runtime')), true, 'temp root siblings are internal')
  assert.equal(isSyntheticPath(path.resolve('data', 'stockboard.db')), false, 'repo-relative default DB path is rejected')
  const escape = path.join(runtime.root, 'escape-link')
  fs.symlinkSync(path.resolve('.'), escape)
  assert.equal(isSyntheticPath(path.join(escape, 'stockboard.db')), false, 'a symlink out of the temp root must be rejected')

  // A clean synthetic environment passes.
  const clean: NodeJS.ProcessEnv = { NODE_ENV: 'test', ...runtime.env }
  assert.deepEqual(findIsolationViolations(clean), [])
  assertSyntheticEnvironment(clean)

  // Each category of violation is detected, and secrets are never echoed.
  const secretValue = 'SUPER-SECRET-VALUE-9f3c'
  const dirty: NodeJS.ProcessEnv = {
    ...clean,
    NODE_ENV: 'production',
    EXTERNAL_STORAGE_REQUIRED: 'true',
    STOCK_DATA_MOUNT_PATH: '/Volumes/OWC Express 1M2 80G',
    STOCK_DATA_VOLUME_UUID: secretValue,
    TURSO_AUTH_TOKEN: secretValue,
    JQUANTS_API_KEY: secretValue,
    STOCKBOARD_DB_PATH: '/Volumes/OWC Express 1M2 80G/stock-dashboard/stockboard.db',
    US_ANALYTICS_DB_PATH: path.resolve('data', 'stockboard-us.db'),
  }
  const violationNames = new Set(findIsolationViolations(dirty).map((violation) => violation.variable))
  for (const expected of [
    'NODE_ENV', 'EXTERNAL_STORAGE_REQUIRED', 'STOCK_DATA_MOUNT_PATH', 'STOCK_DATA_VOLUME_UUID',
    'TURSO_AUTH_TOKEN', 'JQUANTS_API_KEY', 'STOCKBOARD_DB_PATH', 'US_ANALYTICS_DB_PATH',
  ]) assert.ok(violationNames.has(expected), `${expected} must be reported`)
  assert.throws(
    () => assertSyntheticEnvironment(dirty),
    (error: unknown) => error instanceof Error
      && /Synthetic isolation violated/.test(error.message)
      && !error.message.includes(secretValue)
      && !error.message.includes('/Volumes/OWC Express 1M2 80G/stock-dashboard'),
    'violations name variables only and never echo values',
  )
  for (const name of FORBIDDEN_ENVIRONMENT_VARIABLES) {
    assert.ok(findIsolationViolations({ ...clean, [name]: 'x' }).some((violation) => violation.variable === name),
      `${name} must be forbidden`)
  }

  // applySyntheticEnvironment scrubs the live process environment.
  Object.assign(process.env, {
    NODE_ENV: 'production',
    STOCK_DATA_MOUNT_PATH: '/Volumes/fake',
    STOCK_DATA_VOLUME_UUID: secretValue,
    TURSO_DATABASE_URL: 'libsql://fake.example',
    OPENAI_API_KEY: secretValue,
    STOCKBOARD_DB_ROLE: 'primary',
    LOCAL_DB_PATH: '/Volumes/fake/db',
    STOCKBOARD_DB_PATH: '/Volumes/fake/db',
  })
  applySyntheticEnvironment(runtime)
  assert.equal(process.env.NODE_ENV, 'test')
  assert.equal(process.env.STOCKBOARD_DB_PATH, runtime.dbPath)
  assert.equal(process.env.EXTERNAL_STORAGE_REQUIRED, 'false')
  assert.equal(process.env.USE_LOCAL_DB, '1')
  for (const name of FORBIDDEN_ENVIRONMENT_VARIABLES) assert.equal(process.env[name], undefined, `${name} must be scrubbed`)
  assert.equal(process.env.STOCKBOARD_DB_ROLE, undefined)
  assert.equal(process.env.LOCAL_DB_PATH, undefined)
  assert.deepEqual(findIsolationViolations(process.env), [])

  // Child environments are allowlist based: unrelated parent variables never leak.
  process.env.UNRELATED_PARENT_SECRET = secretValue
  const child = syntheticChildEnv(runtime, { EXTRA_FLAG: '1' }, 'development')
  assert.equal(child.UNRELATED_PARENT_SECRET, undefined)
  assert.equal(child.NODE_ENV, 'development')
  assert.equal(child.EXTRA_FLAG, '1')
  assert.equal(child.STOCKBOARD_DB_PATH, runtime.dbPath)
  assert.equal(child.STOCK_DATA_MOUNT_PATH, undefined)
  assert.deepEqual(findIsolationViolations(child), [])
  assert.throws(
    () => syntheticChildEnv(runtime, { STOCK_DATA_VOLUME_UUID: secretValue }),
    /Synthetic isolation violated/,
    'a child override that reintroduces production identity must fail closed',
  )

  console.log('synthetic isolation envelope: all assertions passed')
} finally {
  for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key]
  Object.assign(process.env, savedEnv)
  runtime.cleanup()
}
