// 配置に使う実行環境の束 (node_modules と、その同一性の記録 runtime-manifest.json) を新しく作る。
// 10/28 は手作業で作った束を、指定した commit の package.json・package-lock.json から同じ形で作る。本番のファイルには触れない。
//
//   /usr/local/bin/node --import tsx scripts/create-release-runtime-bundle.ts \
//     --commit=<40 桁: package ファイルを取る commit> --baseline=<40 桁: 束に付ける release ディレクトリの commit> --out=<まだ無い絶対パス>
import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { computeRuntimeIdentity, verifyRuntimeManifest } from '@/lib/release/runtime-identity'

export const PRODUCTION_NODE = '/usr/local/bin/node'

export function parseBundleArguments(argv: readonly string[]): { commit: string; baseline: string; out: string } {
  const value = (name: string) => argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3) ?? ''
  const commit = value('commit'); const baseline = value('baseline'); const out = value('out')
  for (const [name, sha] of [['commit', commit], ['baseline', baseline]]) {
    if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error(`--${name}=<40-hex commit> required`)
  }
  if (!path.isAbsolute(out) || path.resolve(out) !== out) throw new Error('--out=<normalized absolute path> required')
  return { commit, baseline, out }
}

function run(command: string, args: string[], cwd: string): string {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, env: { ...process.env, NODE_ENV: 'development' } })
  if (result.error || result.status !== 0) throw new Error(`command_failed:${command} ${args.join(' ')}:${(result.stderr || result.error?.message || '').trim().slice(-2000)}`)
  return result.stdout.trim()
}

function main(): void {
  const { commit, baseline, out } = parseBundleArguments(process.argv.slice(2))
  if (process.execPath !== PRODUCTION_NODE) throw new Error(`run with ${PRODUCTION_NODE} (the node the services use); got ${process.execPath}`)
  if (fs.existsSync(out)) throw new Error(`output already exists: ${out}`)
  if (!fs.statSync(path.dirname(out)).isDirectory()) throw new Error('parent of --out must exist')
  const repository = process.cwd()
  fs.mkdirSync(out)
  for (const file of ['package.json', 'package-lock.json']) {
    fs.writeFileSync(path.join(out, file), execFileSync('/usr/bin/git', ['show', `${commit}:${file}`], { cwd: repository, maxBuffer: 64 * 1024 * 1024 }))
  }
  const npm = path.join(path.dirname(process.execPath), 'npm')
  run(npm, ['ci', '--include=dev', '--no-audit', '--no-fund'], out)
  const nextCli = run(process.execPath, [path.join(out, 'node_modules', 'next', 'dist', 'bin', 'next'), '--version'], out)
  const tsxCli = run(path.join(out, 'node_modules', '.bin', 'tsx'), ['--version'], out)
  const identity = computeRuntimeIdentity(out, { baselineSha: baseline, sourceCommit: commit })
  const lock = JSON.parse(fs.readFileSync(path.join(out, 'package-lock.json'), 'utf8')) as { packages?: Record<string, unknown> }
  const manifest = {
    schemaVersion: 1, createdAt: new Date().toISOString(), role: 'release', sourceCommit: commit, baselineSha: baseline,
    runtimeDir: out, runtimeRealpath: fs.realpathSync(out), node: identity.node,
    packageManager: { npm: run(npm, ['--version'], out) }, packages: identity.packages, commands: { nextCli, tsxCli },
    hashes: {
      lockSha256: identity.lockSha256, dependencyTreeSha256: identity.dependencyTreeSha256,
      nativeFilesSha256: identity.nativeFilesSha256, nativeFiles: identity.nativeFiles, runtimeIdentitySha256: identity.runtimeIdentitySha256,
    },
    install: { includesDevDependencies: true, nodeModulesPhysicalDirectory: true },
    lockPackageCount: Object.keys(lock.packages ?? {}).filter((key) => key !== '').length,
  }
  fs.writeFileSync(path.join(out, 'runtime-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' })
  run('/bin/chmod', ['-R', 'a-w', out], out)
  verifyRuntimeManifest(out, { expectedIdentity: identity.runtimeIdentitySha256, acceptedBaselines: [baseline] })
  console.log(JSON.stringify({ status: 'CREATED', out, runtimeIdentitySha256: identity.runtimeIdentitySha256, lockSha256: identity.lockSha256, packages: identity.packages }, null, 2))
}

if (require.main === module) main()
