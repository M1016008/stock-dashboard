import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

// Files whose content can change what the JP local repair writes or how its
// receipts are validated: every stage script and its library closure, the
// Python ML stage dependencies, and the package/TypeScript resolution
// contract. UI trees (app/, components/) and test-only files are excluded.
// Stage scripts never import app/, components/, or test files.
//
// The hash binds the content (blob ids and modes) of these paths, which must
// equal HEAD's, not HEAD itself: a test-only or UI-only commit yields the same
// hash. Binding to a specific commit is the separate gitCommitSha check.
export const JP_REPAIR_RUNTIME_SOURCE_PATHSPECS = [
  'lib',
  'scripts',
  'types',
  'requirements',
  'package.json',
  'package-lock.json',
  'tsconfig.json',
  ':(exclude,glob)scripts/**/test-*',
  ':(exclude,glob)scripts/**/test_*',
] as const

const EXECUTABLE_SOURCE = /\.(ts|tsx|js|mjs|cjs|py)$/

export function jpRepairRuntimeSourceTreeSha256(cwd = process.cwd()): string {
  const pathspecs = [...JP_REPAIR_RUNTIME_SOURCE_PATHSPECS]
  try {
    execFileSync('/usr/bin/git', ['diff', '--quiet', '--', ...pathspecs], { cwd })
    execFileSync('/usr/bin/git', ['diff', '--cached', '--quiet', '--', ...pathspecs], { cwd })
  } catch {
    throw new Error('repair runtime source files must exactly match the committed Git revision')
  }
  const untracked = execFileSync('/usr/bin/git', [
    'ls-files', '--others', '--exclude-standard', '-z', '--', ...pathspecs,
  ], { cwd })
  if (untracked.length > 0) {
    throw new Error('repair runtime source tree has untracked files')
  }
  // Ignored files are invisible to the checks above but still importable or
  // runnable, so ignored executable source under lib/ or scripts/ fails closed.
  const ignored = execFileSync('/usr/bin/git', [
    'ls-files', '--others', '--ignored', '--exclude-standard', '-z', '--', 'lib', 'scripts',
  ], { cwd, encoding: 'utf8' }).split('\0').filter((file) => EXECUTABLE_SOURCE.test(file))
  if (ignored.length > 0) {
    throw new Error(`repair runtime source tree has ignored executable source: ${ignored.slice(0, 5).join(',')}`)
  }
  const manifest = execFileSync('/usr/bin/git', ['ls-files', '-s', '-z', '--', ...pathspecs], { cwd })
  return createHash('sha256').update(manifest).digest('hex')
}

// Provenance of a compiled web build. next build also compiles app/ and
// components/, so the whole tracked tree (not only the runtime pathspecs) must
// equal HEAD, no untracked executable source may exist anywhere, and no
// ignored executable source may exist under the source roots.
export type StockboardBuildProvenance = { gitCommitSha: string; runtimeSourceTreeSha256: string }

export function stockboardBuildProvenance(cwd: string): StockboardBuildProvenance {
  const git = (...args: string[]) => execFileSync('/usr/bin/git', args, { cwd, encoding: 'utf8' })
  try {
    git('diff', '--quiet')
    git('diff', '--cached', '--quiet')
  } catch {
    throw new Error('build input must exactly match HEAD (tracked worktree or index is dirty)')
  }
  const untracked = git('ls-files', '--others', '--exclude-standard', '-z').split('\0')
    .filter((file) => EXECUTABLE_SOURCE.test(file))
  if (untracked.length > 0) {
    throw new Error(`build input has untracked executable source: ${untracked.slice(0, 5).join(',')}`)
  }
  // Ignored files under source roots are still compiled by next build or run
  // by scripts, so they fail closed too (node_modules/.next are not scanned).
  const roots = ['app', 'components', 'lib', 'scripts', 'types'].filter((root) => fs.existsSync(path.join(cwd, root)))
  const ignored = roots.length === 0 ? [] : git('ls-files', '--others', '--ignored', '--exclude-standard', '-z',
    '--', ...roots).split('\0').filter((file) => EXECUTABLE_SOURCE.test(file))
  if (ignored.length > 0) {
    throw new Error(`build input has ignored executable source: ${ignored.slice(0, 5).join(',')}`)
  }
  const gitCommitSha = git('rev-parse', 'HEAD').trim()
  if (!/^[0-9a-f]{40}$/.test(gitCommitSha)) throw new Error('HEAD is not a commit')
  return { gitCommitSha, runtimeSourceTreeSha256: jpRepairRuntimeSourceTreeSha256(cwd) }
}

// Written into the staged build by scripts/deploy-local-web-server.ts before
// promotion, so the TREE artifact of .next-live seals it with the build.
export const STOCKBOARD_BUILD_MANIFEST_NAME = 'STOCKBOARD_BUILD_MANIFEST.json'

function stockboardBuildManifestText(provenance: StockboardBuildProvenance, buildId: string): string {
  return `${JSON.stringify({
    version: 1,
    gitCommitSha: provenance.gitCommitSha,
    runtimeSourceTreeSha256: provenance.runtimeSourceTreeSha256,
    buildId,
  })}\n`
}

export function writeStockboardBuildManifest(buildDir: string, provenance: StockboardBuildProvenance): void {
  const buildId = fs.readFileSync(path.join(buildDir, 'BUILD_ID'), 'utf8')
  if (!buildId) throw new Error(`${buildDir}/BUILD_ID is empty`)
  fs.writeFileSync(path.join(buildDir, STOCKBOARD_BUILD_MANIFEST_NAME),
    stockboardBuildManifestText(provenance, buildId), { flag: 'wx' })
}

// Call only after buildDir is verified as an approved TREE artifact.
export function verifyStockboardBuildManifest(buildDir: string, expected: StockboardBuildProvenance): void {
  const buildId = fs.readFileSync(path.join(buildDir, 'BUILD_ID'), 'utf8')
  const text = fs.readFileSync(path.join(buildDir, STOCKBOARD_BUILD_MANIFEST_NAME), 'utf8')
  const manifest = JSON.parse(text) as { version?: unknown; gitCommitSha?: unknown
    runtimeSourceTreeSha256?: unknown; buildId?: unknown }
  if (manifest.version !== 1) throw new Error('unsupported build manifest version')
  if (manifest.gitCommitSha !== expected.gitCommitSha) throw new Error('build was not compiled from the approved commit')
  if (manifest.runtimeSourceTreeSha256 !== expected.runtimeSourceTreeSha256) {
    throw new Error('build was not compiled from the approved runtime source tree')
  }
  if (!buildId || manifest.buildId !== buildId) throw new Error('build manifest names another BUILD_ID')
  if (text !== stockboardBuildManifestText(expected, buildId)) throw new Error('build manifest is not canonical')
}

// Seals a compiled tree (web's .next-live): one JSON line per entry, sorted by
// relative path, of [type, permission bits, path, size, content sha256].
// Every directory is recorded, so empty directories and renames count: a
// rebuild differs anyway, and fail-closed is cheaper than arguing which
// directories Next reads. Symlinks and special files throw (no path escape),
// as do hard-linked files (writable through an alias path) and entries on
// another device (a mount point inside the tree).
// Every entry is re-lstat'ed after hashing; any change of inode, mode, size,
// mtime, or ctime during the walk throws rather than yield a mixed digest.
export function jpRepairCompiledTreeSha256(root: string): string {
  if (fs.realpathSync(root) !== root) throw new Error(`${root} is not its own realpath`)
  const lines: string[] = []
  const seen: Array<[string, fs.BigIntStats]> = []
  const chunk = Buffer.alloc(1 << 20)
  const rootDev = fs.lstatSync(root, { bigint: true }).dev
  const walk = (relative: string): void => {
    const absolute = path.join(root, relative)
    const stat = fs.lstatSync(absolute, { bigint: true })
    seen.push([absolute, stat])
    if (stat.dev !== rootDev) throw new Error(`${absolute} is on another device`)
    const mode = Number(stat.mode & 0o7777n)
    if (stat.isDirectory()) {
      lines.push(JSON.stringify(['D', mode, relative]))
      const names = fs.readdirSync(absolute).sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))
      for (const name of names) walk(relative ? `${relative}/${name}` : name)
      return
    }
    if (!stat.isFile()) throw new Error(`${absolute} is not a regular file or directory`)
    if (stat.nlink !== 1n) throw new Error(`${absolute} has ${stat.nlink} hard links`)
    const fd = fs.openSync(absolute, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
    try {
      if (fs.fstatSync(fd, { bigint: true }).ino !== stat.ino) throw new Error(`${absolute} was replaced`)
      const hash = createHash('sha256')
      for (let read; (read = fs.readSync(fd, chunk, 0, chunk.length, null)) > 0;) hash.update(chunk.subarray(0, read))
      lines.push(JSON.stringify(['F', mode, relative, Number(stat.size), hash.digest('hex')]))
    } finally {
      fs.closeSync(fd)
    }
  }
  walk('')
  for (const [absolute, before] of seen) {
    const after = fs.lstatSync(absolute, { bigint: true, throwIfNoEntry: false })
    if (!after || after.ino !== before.ino || after.mode !== before.mode || after.size !== before.size
        || after.mtimeNs !== before.mtimeNs || after.ctimeNs !== before.ctimeNs) {
      throw new Error(`${absolute} changed while hashing`)
    }
  }
  return createHash('sha256').update(`${lines.join('\n')}\n`).digest('hex')
}
