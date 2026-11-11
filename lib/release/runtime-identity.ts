// 実行環境の束 (node_modules を持つディレクトリ) の同一性。配置の仕組み (deploy-web-analog-only.ts)、束を作るスクリプト、
// 配置の証明を作るスクリプト、練習用の試しが、同じ計算を使う。計算は 10/28 の本番の配置のときと同じ (中身は変えていない)。
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { sha256File } from '@/lib/release/preflight-proof'

export interface RuntimeManifest {
  schemaVersion: number
  sourceCommit?: string
  baselineSha: string
  runtimeRealpath: string
  node: { binary: string; version: string; arch: string; platform: string; osRelease: string }
  packages: Record<string, string>
  hashes: {
    lockSha256: string
    dependencyTreeSha256: string
    nativeFilesSha256: string
    runtimeIdentitySha256: string
  }
  install: { nodeModulesPhysicalDirectory: boolean }
}

const NATIVE_CANDIDATES = [
  'node_modules/@esbuild/darwin-arm64/bin/esbuild',
  'node_modules/@libsql/darwin-arm64/index.node',
  'node_modules/@next/swc-darwin-arm64/next-swc.darwin-arm64.node',
  'node_modules/sharp/src/build/Release/sharp-darwin-arm64.node',
  'node_modules/@img/sharp-darwin-arm64/lib/sharp-darwin-arm64.node',
]

function sanitizeDependencyTree(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeDependencyTree)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([key]) => !['path', 'problems'].includes(key))
    .map(([key, child]) => [key, sanitizeDependencyTree(child)]))
}

export function hashJson(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

export type RuntimeIdentityParts = Pick<RuntimeManifest, 'node' | 'packages'> & {
  lockSha256: string
  dependencyTreeSha256: string
  nativeFilesSha256: string
  nativeFiles: Record<string, string>
  runtimeIdentitySha256: string
}

// 束の今の中身から同一性を計算する。baselineSha と sourceCommit は束の記録 (runtime-manifest.json) の値を使う。
export function computeRuntimeIdentity(runtimeDirectory: string, stamp: { baselineSha: string; sourceCommit?: string }): RuntimeIdentityParts {
  const nodeModules = path.join(runtimeDirectory, 'node_modules')
  const npmBinary = path.join(path.dirname(process.execPath), 'npm')
  if (!fs.existsSync(npmBinary)) throw new Error(`release_runtime_npm_missing:${npmBinary}`)
  // npm の cache と記録は、この確認のためだけの一時フォルダに書かせ、終わったら消す (~/.npm や本番の場所には書かない)。
  // 更新の確認もしない。npm ls の結果 (同一性の計算に使う) は、これらの設定で変わらない。
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'stockboard-npm-ls-'))
  let listed: ReturnType<typeof spawnSync>
  try {
    listed = spawnSync(npmBinary, ['ls', '--all', '--json'], {
      cwd: runtimeDirectory, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024,
      env: { ...process.env, NODE_ENV: 'production', npm_config_cache: scratch, npm_config_logs_dir: scratch, npm_config_update_notifier: 'false' },
    })
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true })
  }
  if (listed.error || listed.status !== 0) throw new Error(`release_runtime_npm_ls_failed:${String(listed.stderr || listed.error?.message || '').trim()}`)
  const dependencyTreeSha256 = hashJson(sanitizeDependencyTree(JSON.parse(String(listed.stdout))))
  const nativeFiles = Object.fromEntries(NATIVE_CANDIDATES
    .filter((relative) => fs.existsSync(path.join(runtimeDirectory, relative)))
    .map((relative) => [relative, sha256File(path.join(runtimeDirectory, relative))]))
  const nativeFilesSha256 = hashJson(nativeFiles)
  const lockSha256 = sha256File(path.join(runtimeDirectory, 'package-lock.json'))
  const packageVersion = (name: string) => JSON.parse(fs.readFileSync(path.join(nodeModules, ...name.split('/'), 'package.json'), 'utf8')).version as string
  const packages = {
    next: packageVersion('next'), react: packageVersion('react'), reactDom: packageVersion('react-dom'),
    tsx: packageVersion('tsx'), esbuild: packageVersion('esbuild'), libsqlClient: packageVersion('@libsql/client'),
    libsqlNative: packageVersion('@libsql/darwin-arm64'), sharp: packageVersion('sharp'),
  }
  const node = { binary: process.execPath, version: process.version, arch: process.arch, platform: process.platform, osRelease: os.release() }
  const runtimeIdentitySha256 = hashJson({
    baselineSha: stamp.baselineSha,
    ...(stamp.sourceCommit ? { sourceCommit: stamp.sourceCommit } : {}),
    node, packages, lockSha256, dependencyTreeSha256, nativeFilesSha256,
  })
  return { node, packages, lockSha256, dependencyTreeSha256, nativeFilesSha256, nativeFiles, runtimeIdentitySha256 }
}

// 束の記録と今の中身が一致することを確かめる。束の印 (baselineSha) は acceptedBaselines のどれかであること。
export function verifyRuntimeManifest(runtimeDirectory: string, options: {
  expectedIdentity: string
  acceptedBaselines: readonly string[]
  expectedManifestHash?: string
  expectedLockHash?: string
}): RuntimeManifest {
  if (fs.lstatSync(runtimeDirectory).isSymbolicLink()) throw new Error('release_runtime_must_be_physical')
  const nodeModules = path.join(runtimeDirectory, 'node_modules')
  if (!fs.statSync(nodeModules).isDirectory() || fs.lstatSync(nodeModules).isSymbolicLink()) throw new Error('release_node_modules_must_be_physical')
  const manifestFile = path.join(runtimeDirectory, 'runtime-manifest.json')
  if (options.expectedManifestHash && sha256File(manifestFile) !== options.expectedManifestHash) throw new Error('release_runtime_manifest_hash_mismatch')
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8')) as RuntimeManifest
  const actual = computeRuntimeIdentity(runtimeDirectory, manifest)
  const mismatches: string[] = []
  if (manifest.schemaVersion !== 1) mismatches.push('schemaVersion')
  if (!options.acceptedBaselines.includes(manifest.baselineSha)) mismatches.push('baselineSha')
  if (fs.realpathSync(runtimeDirectory) !== manifest.runtimeRealpath) mismatches.push('runtimeRealpath')
  if (actual.runtimeIdentitySha256 !== options.expectedIdentity) mismatches.push('expectedIdentity')
  if (manifest.hashes.runtimeIdentitySha256 !== actual.runtimeIdentitySha256) mismatches.push('manifestIdentity')
  if (actual.lockSha256 !== manifest.hashes.lockSha256) mismatches.push('lockSha256')
  if (options.expectedLockHash && actual.lockSha256 !== options.expectedLockHash) mismatches.push('proofLockSha256')
  if (actual.dependencyTreeSha256 !== manifest.hashes.dependencyTreeSha256) mismatches.push('dependencyTreeSha256')
  if (actual.nativeFilesSha256 !== manifest.hashes.nativeFilesSha256) mismatches.push('nativeFilesSha256')
  if (JSON.stringify(actual.packages) !== JSON.stringify(manifest.packages)) mismatches.push('packages')
  if (JSON.stringify(actual.node) !== JSON.stringify(manifest.node)) mismatches.push('node')
  if (manifest.install.nodeModulesPhysicalDirectory !== true) mismatches.push('nodeModulesPhysicalDirectory')
  if (mismatches.length > 0) throw new Error(`release_runtime_manifest_contract_mismatch:${mismatches.join(',')}`)
  return manifest
}
