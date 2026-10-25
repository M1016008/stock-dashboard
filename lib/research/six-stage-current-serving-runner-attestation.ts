import crypto from 'node:crypto'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

export type CurrentServingProjectionRunnerAttestation = {
  root: string
  runnerPath: string
  commit: string
  runnerSha256: string
  tsxPath: string
  tsxSha256: string
  tsconfigPath: string
  tsconfigSha256: string
  packageLockSha256: string
}

function required(environment: NodeJS.ProcessEnv, name: string): string {
  const value = environment[name]?.trim()
  if (!value) throw new Error(`CURRENT_PROJECTION_REQUIRED_ENV:${name}`)
  return value
}

function sha256(filePath: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex')
}

export function attestCurrentServingProjectionRunner(
  environment: NodeJS.ProcessEnv = process.env,
): CurrentServingProjectionRunnerAttestation {
  if (environment.CURRENT_SERVING_PROJECTION_ENABLED !== '1') {
    throw new Error('CURRENT_PROJECTION_DISABLED')
  }
  const configuredRoot = path.resolve(required(environment, 'CURRENT_SERVING_PROJECTION_INTEGRATION_ROOT'))
  const root = fs.realpathSync(configuredRoot)
  const configuredRunner = path.resolve(required(environment, 'CURRENT_SERVING_PROJECTION_RUNNER_PATH'))
  const runnerPath = fs.realpathSync(configuredRunner)
  const relative = path.relative(root, runnerPath)
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('CURRENT_PROJECTION_RUNNER_OUTSIDE_INTEGRATION_ROOT')
  }
  if (relative !== path.join('scripts', 'build-six-stage-current-serving-projection.ts')) {
    throw new Error('CURRENT_PROJECTION_UNEXPECTED_RUNNER_PATH')
  }
  const expectedCommit = required(environment, 'CURRENT_SERVING_PROJECTION_INTEGRATION_COMMIT')
  const commit = execFileSync('/usr/bin/git', ['-C', root, 'rev-parse', 'HEAD'], {
    encoding: 'utf8', timeout: 5_000,
  }).trim()
  if (commit !== expectedCommit) throw new Error('CURRENT_PROJECTION_INTEGRATION_COMMIT_MISMATCH')
  const trackedChanges = execFileSync('/usr/bin/git', [
    '-C', root, 'status', '--porcelain', '--untracked-files=no',
  ], { encoding: 'utf8', timeout: 5_000 }).trim()
  if (trackedChanges) throw new Error('CURRENT_PROJECTION_INTEGRATION_CHECKOUT_DIRTY')
  const expectedRunnerSha256 = required(environment, 'CURRENT_SERVING_PROJECTION_RUNNER_SHA256').toLowerCase()
  if (!/^[0-9a-f]{64}$/.test(expectedRunnerSha256)) {
    throw new Error('CURRENT_PROJECTION_INVALID_RUNNER_SHA256')
  }
  const runnerSha256 = sha256(runnerPath)
  if (runnerSha256 !== expectedRunnerSha256) throw new Error('CURRENT_PROJECTION_RUNNER_SHA256_MISMATCH')
  const tsxPath = fs.realpathSync(path.join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs'))
  const tsconfigPath = fs.realpathSync(path.join(root, 'tsconfig.json'))
  const packageLockPath = fs.realpathSync(path.join(root, 'package-lock.json'))
  for (const [filePath, relativePath] of [
    [tsxPath, path.join('node_modules', 'tsx', 'dist', 'cli.mjs')],
    [tsconfigPath, 'tsconfig.json'],
    [packageLockPath, 'package-lock.json'],
  ] as const) {
    if (path.relative(root, filePath) !== relativePath) {
      throw new Error('CURRENT_PROJECTION_RUNTIME_DEPENDENCY_PATH_MISMATCH')
    }
  }
  const expectedTsxSha256 = required(environment, 'CURRENT_SERVING_PROJECTION_TSX_SHA256').toLowerCase()
  const expectedTsconfigSha256 = required(environment, 'CURRENT_SERVING_PROJECTION_TSCONFIG_SHA256').toLowerCase()
  const expectedPackageLockSha256 = required(environment, 'CURRENT_SERVING_PROJECTION_PACKAGE_LOCK_SHA256').toLowerCase()
  for (const value of [expectedTsxSha256, expectedTsconfigSha256, expectedPackageLockSha256]) {
    if (!/^[0-9a-f]{64}$/.test(value)) throw new Error('CURRENT_PROJECTION_INVALID_DEPENDENCY_SHA256')
  }
  const tsxSha256 = sha256(tsxPath)
  const tsconfigSha256 = sha256(tsconfigPath)
  const packageLockSha256 = sha256(packageLockPath)
  if (tsxSha256 !== expectedTsxSha256) throw new Error('CURRENT_PROJECTION_TSX_SHA256_MISMATCH')
  if (tsconfigSha256 !== expectedTsconfigSha256) throw new Error('CURRENT_PROJECTION_TSCONFIG_SHA256_MISMATCH')
  if (packageLockSha256 !== expectedPackageLockSha256) throw new Error('CURRENT_PROJECTION_PACKAGE_LOCK_SHA256_MISMATCH')
  return {
    root,
    runnerPath,
    commit,
    runnerSha256,
    tsxPath,
    tsxSha256,
    tsconfigPath,
    tsconfigSha256,
    packageLockSha256,
  }
}
