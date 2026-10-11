import { spawnSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const WORKFLOW_VERSION = 2
const GIT = '/usr/bin/git'
const MAX_TEXT_CONFIG_BYTES = 16 * 1024 * 1024
const DEFAULT_APPROVAL_TTL_MINUTES = 10
const MAX_APPROVAL_TTL_MINUTES = 30
const VERIFICATION_MAX_AGE_MS = 24 * 60 * 60 * 1000

export type WorktreeRegistration = {
  path: string
  head: string | null
  branch: string | null
  detached: boolean
  bare: boolean
  locked: string | null
  prunable: string | null
}

export type SafetyCategory = 'KEEP' | 'BACKUP' | 'INTEGRATE' | 'REVIEW' | 'REMOVABLE' | 'STALE'

export type SafetyFacts = {
  isRepositoryRoot: boolean
  isCurrentDirectory: boolean
  exists: boolean
  locked: boolean
  prunable: boolean
  dirtyEntries: number
  protectedIgnoredEntries: number
  externalSymlinkEntries: number
  runtimeReferences: number
  sourceReferences: number
  reverseSymlinkReferences: number
  scanErrors: number
  integrated: boolean
  deletionInspectionComplete: boolean
}

type IgnoredItem = {
  path: string
  kind: 'disposable' | 'protected' | 'external-symlink'
  target?: string
}

export type RuntimeInspection = {
  platform: string
  processScan: 'complete' | 'failed'
  openFileScan: 'complete' | 'failed' | 'not-applicable'
  launchdScan: 'complete' | 'failed' | 'not-applicable'
  macosDeletionReady: boolean
}

export type RuntimeSnapshot = {
  processes: Array<{ pid: number; command: string }>
  openPaths: Array<{ pid: number; path: string }>
  launchAgents: Array<{ label: string; text: string }>
  activeConfigs: Array<{ label: string; text: string }>
  errors: string[]
  inspection: RuntimeInspection
}

export type WorktreeAudit = {
  path: string
  branch: string
  head: string | null
  category: SafetyCategory
  reasons: string[]
  exists: boolean
  dirtyEntries: number
  dirtyDigest: string
  ignoredDisposable: string[]
  ignoredProtected: string[]
  externalSymlinks: string[]
  ignoredDigest: string
  runtimeReferences: string[]
  sourceReferences: string[]
  reverseSymlinkReferences: string[]
  integrated: boolean
  ahead: number | null
  behind: number | null
  locked: boolean
  prunable: boolean
  diskKiB: number | null
  scanErrors: string[]
  deletionInspection: RuntimeInspection
  filesystemIdentity: { device: number; inode: number } | null
  auditToken: string | null
}

export type AuditResult = {
  workflowVersion: number
  generatedAt: string
  repositoryRoot: string
  invokedRoot: string
  base: string
  baseSha: string
  worktrees: WorktreeAudit[]
}

type GitHubCheckSummary = {
  status: 'passing' | 'pending' | 'failing' | 'missing'
  total: number
  passing: number
  pending: number
  failing: number
  names: string[]
  failures: string[]
}

export type CliOptions = {
  base: string
  path?: string
  tests: string[]
  json: boolean
  report?: string
  github: boolean
  confirm?: string
  baseSha?: string
  auditToken?: string
  approvalId?: string
  ttlMinutes?: number
  selectTests: boolean
  event?: string
}

export type GitHubIntegrationInput = {
  expectedBase: string
  localHead: string
  localHeadInBase: boolean
  mergeCommitInBase: boolean
  pr: Record<string, unknown> | null
  ci: GitHubCheckSummary
}

export type IntegrationProof = {
  proven: boolean
  method: 'merge-commit' | 'squash-or-rebase' | 'unproven'
  reasons: string[]
  baseRefName: string | null
  headRefOid: string | null
  mergeCommitOid: string | null
}

export type RemovalApproval = {
  schemaVersion: 1
  workflowVersion: number
  approvalId: string
  issuedAt: string
  expiresAt: string
  issuer: {
    mechanism: 'local-interactive-unverified'
    authenticated: false
    uid: number | null
    username: string
  }
  target: string
  branch: string
  head: string
  base: string
  baseSha: string
  auditToken: string
  integrationProof: IntegrationProof
  integrationDigest: string
  signature: string
}

type CommandResult = {
  ok: boolean
  status: number | null
  stdout: string
  stderr: string
  durationMs: number
}

type EslintMessage = {
  ruleId: string | null
  severity: number
  message: string
  line?: number
}

type EslintResult = {
  filePath: string
  source?: string
  messages: EslintMessage[]
}

type LintBaseline = {
  schemaVersion: 1
  entries: Record<string, number>
}

type TestSelectionConfig = {
  schemaVersion: 1
  mandatory: string[]
  ignored: string[]
  rules: Array<{ name: string; paths: string[]; tests: string[] }>
}

export type VerificationStamp = {
  schemaVersion: 1
  workflowVersion: number
  target: string
  head: string
  base: string
  baseSha: string
  statusDigest: string
  changedFilesDigest: string
  tests: string[]
  finishedAt: string
  signature: string
}

function command(command: string, args: string[], cwd?: string, inherit = false): CommandResult {
  const started = Date.now()
  const result = spawnSync(command, args, {
    cwd,
    encoding: inherit ? undefined : 'utf8',
    stdio: inherit ? 'inherit' : 'pipe',
    maxBuffer: 64 * 1024 * 1024,
  })
  return {
    ok: !result.error && result.status === 0,
    status: result.status,
    stdout: typeof result.stdout === 'string' ? result.stdout : '',
    stderr: typeof result.stderr === 'string' ? result.stderr : result.error?.message ?? '',
    durationMs: Date.now() - started,
  }
}

function runText(executable: string, args: string[], cwd?: string): string {
  const result = command(executable, args, cwd)
  if (!result.ok) {
    const detail = (result.stderr || result.stdout).trim()
    throw new Error(`${path.basename(executable)} ${args.join(' ')} failed (${result.status ?? 'spawn'})${detail ? `: ${detail}` : ''}`)
  }
  return result.stdout
}

function runVisible(executable: string, args: string[], cwd: string): { command: string; durationMs: number } {
  const display = [path.basename(executable), ...args].join(' ')
  console.log(`\n> ${display}`)
  const result = command(executable, args, cwd, true)
  if (!result.ok) throw new Error(`${display} failed with status ${result.status ?? 'spawn'}`)
  return { command: display, durationMs: result.durationMs }
}

function canonical(input: string): string {
  const resolved = path.resolve(input)
  try {
    return fs.realpathSync(resolved)
  } catch {
    return resolved
  }
}

function isWithinResolved(candidate: string, parent: string): boolean {
  const relative = path.relative(parent, candidate)
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

function isWithin(candidate: string, parent: string): boolean {
  return isWithinResolved(canonical(candidate), canonical(parent))
}

function digest(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex')
}

function sortedUnique(values: string[]): string[] {
  return [...new Set(values)].sort()
}

function stateDirectory(commonDir: string): string {
  return path.join(commonDir, 'stockboard-workflow')
}

function stateKey(commonDir: string, create: boolean): Buffer {
  const directory = stateDirectory(commonDir)
  const keyFile = path.join(directory, 'state.key')
  if (create) {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
    try {
      fs.writeFileSync(keyFile, crypto.randomBytes(32), { flag: 'wx', mode: 0o600 })
    } catch (error) {
      const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : ''
      if (code !== 'EEXIST') throw error
    }
  }
  const stat = fs.statSync(keyFile)
  if (!stat.isFile() || (stat.mode & 0o077) !== 0) throw new Error(`workflow state key permissions are unsafe: ${keyFile}`)
  return fs.readFileSync(keyFile)
}

function signState(commonDir: string, payload: unknown, createKey: boolean): string {
  return crypto.createHmac('sha256', stateKey(commonDir, createKey)).update(JSON.stringify(payload)).digest('hex')
}

function safeEqualHex(left: string, right: string): boolean {
  if (!/^[0-9a-f]+$/i.test(left) || !/^[0-9a-f]+$/i.test(right) || left.length !== right.length) return false
  return crypto.timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'))
}

export function containsPathReference(text: string, targetPath: string): boolean {
  const target = canonical(targetPath)
  let from = 0
  while (true) {
    const index = text.indexOf(target, from)
    if (index === -1) return false
    const before = index === 0 ? '' : text[index - 1]
    const after = text[index + target.length] ?? ''
    const beforeBoundary = before === '' || /[\s"'=:(>\[]/.test(before)
    const afterBoundary = after === '' || /[\s"'/:),<\]]/.test(after)
    if (beforeBoundary && afterBoundary) return true
    from = index + target.length
  }
}

export function parseWorktreePorcelain(text: string): WorktreeRegistration[] {
  return text.trim().split(/\n\n+/).filter(Boolean).map((block) => {
    const row: WorktreeRegistration = {
      path: '', head: null, branch: null, detached: false, bare: false, locked: null, prunable: null,
    }
    for (const line of block.split('\n')) {
      const [key, ...rest] = line.split(' ')
      const value = rest.join(' ')
      if (key === 'worktree') row.path = canonical(value)
      else if (key === 'HEAD') row.head = value
      else if (key === 'branch') row.branch = value.replace(/^refs\/heads\//, '')
      else if (key === 'detached') row.detached = true
      else if (key === 'bare') row.bare = true
      else if (key === 'locked') row.locked = value || 'locked'
      else if (key === 'prunable') row.prunable = value || 'prunable'
    }
    if (!row.path) throw new Error(`invalid worktree registration: ${block}`)
    return row
  })
}

export function classifySafety(facts: SafetyFacts): { category: SafetyCategory; reasons: string[] } {
  if (!facts.exists || facts.prunable) {
    return {
      category: 'STALE',
      reasons: [!facts.exists ? 'worktree directory is missing' : 'Git marks the registration prunable'],
    }
  }

  const keep: string[] = []
  const backup: string[] = []
  const review: string[] = []
  const integrate: string[] = []
  if (facts.isRepositoryRoot) keep.push('primary repository worktree')
  if (facts.isCurrentDirectory) keep.push('contains the current command directory')
  if (facts.locked) keep.push('Git worktree is locked')
  if (facts.runtimeReferences > 0) keep.push(`${facts.runtimeReferences} runtime/config reference(s)`)
  if (facts.sourceReferences > 0) keep.push(`${facts.sourceReferences} base-source absolute path reference(s)`)
  if (facts.reverseSymlinkReferences > 0) keep.push(`${facts.reverseSymlinkReferences} reverse symlink dependency/dependencies`)
  if (facts.externalSymlinkEntries > 0) keep.push(`${facts.externalSymlinkEntries} external symlink dependency/dependencies`)
  if (facts.dirtyEntries > 0) backup.push(`${facts.dirtyEntries} tracked/untracked change(s)`)
  if (facts.protectedIgnoredEntries > 0) backup.push(`${facts.protectedIgnoredEntries} protected ignored item(s)`)
  if (facts.scanErrors > 0) review.push(`${facts.scanErrors} safety scan error(s)`)
  if (!facts.deletionInspectionComplete) review.push('strict macOS deletion inspection is incomplete or unavailable')
  if (!facts.integrated) integrate.push('HEAD is not an ancestor of the selected base')
  const reasons = [...keep, ...backup, ...review, ...integrate]
  if (keep.length > 0) return { category: 'KEEP', reasons }
  if (backup.length > 0) return { category: 'BACKUP', reasons }
  if (review.length > 0) return { category: 'REVIEW', reasons }
  if (integrate.length > 0) return { category: 'INTEGRATE', reasons }
  return { category: 'REMOVABLE', reasons: ['clean, integrated, unreferenced, and no protected local artifact was detected'] }
}

function repositoryContext(cwd = process.cwd()): {
  invokedRoot: string
  commonDir: string
  repositoryRoot: string
  worktrees: WorktreeRegistration[]
} {
  const invokedRoot = canonical(runText(GIT, ['rev-parse', '--show-toplevel'], cwd).trim())
  const commonRaw = runText(GIT, ['rev-parse', '--git-common-dir'], invokedRoot).trim()
  const commonDir = canonical(path.isAbsolute(commonRaw) ? commonRaw : path.join(invokedRoot, commonRaw))
  const repositoryRoot = path.basename(commonDir) === '.git' ? path.dirname(commonDir) : invokedRoot
  const worktrees = parseWorktreePorcelain(runText(GIT, ['worktree', 'list', '--porcelain'], repositoryRoot))
  return { invokedRoot, commonDir, repositoryRoot, worktrees }
}

function refCommit(repositoryRoot: string, ref: string): string {
  return runText(GIT, ['rev-parse', '--verify', `${ref}^{commit}`], repositoryRoot).trim()
}

function revCount(repositoryRoot: string, range: string): number | null {
  const result = command(GIT, ['rev-list', '--count', range], repositoryRoot)
  return result.ok ? Number(result.stdout.trim()) : null
}

export function isDisposableIgnoredPath(relativePath: string): boolean {
  const normalized = relativePath.replace(/\/$/, '')
  const parts = normalized.split('/')
  const root = parts[0]
  const name = parts.at(-1) ?? normalized
  return root === 'node_modules'
    || root === 'coverage'
    || root === 'out'
    || root === 'build'
    || root === 'tmp'
    || root.startsWith('.next')
    || root.startsWith('.venv')
    || parts.includes('__pycache__')
    || name === '.DS_Store'
    || name === 'next-env.d.ts'
    || name.endsWith('.tsbuildinfo')
    || name.endsWith('.pyc')
    || /^(npm|yarn|pnpm)-debug\.log/.test(name)
}

function inspectIgnored(worktreePath: string): IgnoredItem[] {
  const output = runText(GIT, ['ls-files', '--others', '--ignored', '--exclude-standard', '--directory', '-z'], worktreePath)
  const items: IgnoredItem[] = []
  for (const raw of output.split('\0').filter(Boolean)) {
    const relative = raw.replace(/\/$/, '')
    const absolute = path.join(worktreePath, relative)
    let stats: fs.Stats
    try {
      stats = fs.lstatSync(absolute)
    } catch {
      items.push({ path: relative, kind: 'protected' })
      continue
    }
    if (stats.isSymbolicLink()) {
      try {
        const target = fs.realpathSync(absolute)
        if (!isWithin(target, worktreePath)) {
          items.push({ path: relative, kind: 'external-symlink', target })
          continue
        }
      } catch {
        items.push({ path: relative, kind: 'protected' })
        continue
      }
    }
    items.push({ path: relative, kind: isDisposableIgnoredPath(relative) ? 'disposable' : 'protected' })
  }
  return items.sort((a, b) => a.path.localeCompare(b.path))
}

function inspectExternalSymlinks(worktreePath: string, ignored: IgnoredItem[]): string[] {
  const candidates = new Set<string>()
  const tracked = runText(GIT, ['ls-files', '--stage', '-z'], worktreePath)
  for (const entry of tracked.split('\0').filter(Boolean)) {
    const tab = entry.indexOf('\t')
    if (tab === -1 || !entry.startsWith('120000 ')) continue
    candidates.add(entry.slice(tab + 1))
  }
  const untracked = runText(GIT, ['ls-files', '--others', '--exclude-standard', '-z'], worktreePath)
  for (const relative of untracked.split('\0').filter(Boolean)) candidates.add(relative)
  for (const item of ignored.filter((entry) => entry.kind === 'external-symlink')) candidates.add(item.path)

  const external: string[] = []
  for (const relative of candidates) {
    const absolute = path.join(worktreePath, relative)
    try {
      if (!fs.lstatSync(absolute).isSymbolicLink()) continue
      const destination = fs.realpathSync(absolute)
      if (!isWithin(destination, worktreePath)) external.push(relative)
    } catch {
      // Missing or dangling links are already represented by Git status or tracked history.
    }
  }
  return sortedUnique(external)
}

function processRows(): { rows: Array<{ pid: number; ppid: number; command: string }>; errors: string[] } {
  const result = command('/bin/ps', ['axww', '-o', 'pid=,ppid=,command='])
  if (!result.ok) return { rows: [], errors: ['process list unavailable'] }
  const rows: Array<{ pid: number; ppid: number; command: string }> = []
  for (const line of result.stdout.split('\n')) {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/)
    if (match) rows.push({ pid: Number(match[1]), ppid: Number(match[2]), command: match[3] })
  }
  return { rows, errors: [] }
}

function wrapperPids(rows: Array<{ pid: number; ppid: number }>): Set<number> {
  const parents = new Map(rows.map((row) => [row.pid, row.ppid]))
  const excluded = new Set<number>()
  let current: number | undefined = process.pid
  for (let depth = 0; depth < 4 && current && !excluded.has(current); depth += 1) {
    excluded.add(current)
    current = parents.get(current)
  }
  return excluded
}

function readConfig(file: string, label: string, target: RuntimeSnapshot): void {
  try {
    const stat = fs.statSync(file)
    if (!stat.isFile() || stat.size > MAX_TEXT_CONFIG_BYTES) return
    target.activeConfigs.push({ label, text: fs.readFileSync(file, 'utf8') })
  } catch (error) {
    target.errors.push(`config scan unavailable (${file}): ${error instanceof Error ? error.message : String(error)}`)
  }
}

function executableOnPath(name: string): string | null {
  for (const directory of (process.env.PATH ?? '').split(path.delimiter).filter(Boolean)) {
    const candidate = path.join(directory, name)
    try {
      fs.accessSync(candidate, fs.constants.X_OK)
      return candidate
    } catch {
      // Keep searching PATH.
    }
  }
  return null
}

export function collectRuntimeSnapshot(
  repositoryRoot: string,
  options: { platform?: NodeJS.Platform; homeDirectory?: string } = {},
): RuntimeSnapshot {
  const platform = options.platform ?? process.platform
  const homeDirectory = options.homeDirectory ?? os.homedir()
  const snapshot: RuntimeSnapshot = {
    processes: [],
    openPaths: [],
    launchAgents: [],
    activeConfigs: [],
    errors: [],
    inspection: {
      platform,
      processScan: 'failed',
      openFileScan: platform === 'darwin' ? 'failed' : 'not-applicable',
      launchdScan: platform === 'darwin' ? 'failed' : 'not-applicable',
      macosDeletionReady: false,
    },
  }
  const ps = processRows()
  snapshot.errors.push(...ps.errors)
  snapshot.inspection.processScan = ps.errors.length === 0 ? 'complete' : 'failed'
  const excluded = wrapperPids(ps.rows)
  snapshot.processes = ps.rows.filter((row) => !excluded.has(row.pid)).map(({ pid, command: line }) => ({ pid, command: line }))

  if (platform === 'darwin') {
    const lsofPath = ['/usr/sbin/lsof', '/usr/bin/lsof'].find((candidate) => fs.existsSync(candidate)) ?? executableOnPath('lsof')
    const lsof = lsofPath ? command(lsofPath, ['-nP', '-Fpn']) : null
    if (!lsof?.ok) snapshot.errors.push('macOS open-file scan unavailable')
    else {
      snapshot.inspection.openFileScan = 'complete'
      let pid: number | null = null
      for (const line of lsof.stdout.split('\n')) {
        if (line.startsWith('p')) pid = Number(line.slice(1))
        else if (line.startsWith('n') && line[1] === '/' && pid !== null && !excluded.has(pid)) {
          snapshot.openPaths.push({ pid, path: line.slice(1) })
        }
      }
    }

    const launchDirectories = [
      path.join(homeDirectory, 'Library', 'LaunchAgents'),
      '/Library/LaunchAgents',
      '/Library/LaunchDaemons',
    ]
    let launchdComplete = true
    for (const launchDir of launchDirectories) {
      if (!fs.existsSync(launchDir)) continue
      try {
        for (const name of fs.readdirSync(launchDir).filter((entry) => entry.endsWith('.plist'))) {
          const file = path.join(launchDir, name)
          snapshot.launchAgents.push({ label: file, text: fs.readFileSync(file, 'utf8') })
        }
      } catch (error) {
        launchdComplete = false
        snapshot.errors.push(`LaunchAgent/Daemon scan unavailable (${launchDir}): ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    snapshot.inspection.launchdScan = launchdComplete ? 'complete' : 'failed'
  }

  if (platform !== 'darwin') {
    // Linux/Windows CI can exercise portable analysis, but can never authorize deletion.
    snapshot.inspection.openFileScan = 'not-applicable'
    snapshot.inspection.launchdScan = 'not-applicable'
  }

  snapshot.inspection.macosDeletionReady = platform === 'darwin'
    && snapshot.inspection.processScan === 'complete'
    && snapshot.inspection.openFileScan === 'complete'
    && snapshot.inspection.launchdScan === 'complete'

  const knownConfigs = [
    path.join(repositoryRoot, '.claude', 'launch.json'),
    path.join(repositoryRoot, '.claude', 'settings.json'),
    path.join(repositoryRoot, '.claude', 'settings.local.json'),
    path.join(repositoryRoot, '.codex', 'config.toml'),
    path.join(homeDirectory, '.claude', 'settings.json'),
    path.join(homeDirectory, '.claude', 'settings.local.json'),
    path.join(homeDirectory, '.codex', 'config.toml'),
    path.join(homeDirectory, '.codex', '.codex-global-state.json'),
    path.join(homeDirectory, 'Library', 'Application Support', 'StockBoard', 'check-web-health.zsh'),
  ]
  for (const file of knownConfigs) {
    if (fs.existsSync(file)) readConfig(file, file, snapshot)
  }

  if (platform !== 'darwin') return snapshot

  const applicationSupport = path.join(homeDirectory, 'Library', 'Application Support', 'StockBoard')
  const excludedNames = new Set(['deploy-backups', 'logs', 'storage-incidents', 'large-holder-operations'])
  try {
    for (const entry of fs.readdirSync(applicationSupport, { withFileTypes: true })) {
      if (!entry.isDirectory() || excludedNames.has(entry.name)) continue
      const directory = path.join(applicationSupport, entry.name)
      for (const child of fs.readdirSync(directory, { withFileTypes: true })) {
        if (!child.isFile() || !/\.(?:json|toml|plist|mjs|cjs|js|ts|sh|zsh)$/.test(child.name)) continue
        const file = path.join(directory, child.name)
        readConfig(file, file, snapshot)
      }
    }
  } catch {
    // Application Support is optional; known active files above remain authoritative.
  }
  return snapshot
}

function runtimeReferences(snapshot: RuntimeSnapshot, worktreePath: string): string[] {
  const target = canonical(worktreePath)
  const references: string[] = []
  for (const row of snapshot.processes) {
    if (containsPathReference(row.command, target)) references.push(`process:${row.pid}`)
  }
  for (const row of snapshot.openPaths) {
    if (isWithinResolved(path.resolve(row.path), target)) references.push(`open:${row.pid}`)
  }
  for (const row of snapshot.launchAgents) {
    if (containsPathReference(row.text, target)) references.push(`LaunchAgent:${row.label}`)
  }
  for (const row of snapshot.activeConfigs) {
    if (containsPathReference(row.text, target)) references.push(`config:${row.label}`)
  }
  return sortedUnique(references)
}

function baseSourceReferences(repositoryRoot: string, baseSha: string, targetPath: string): string[] {
  const result = command(GIT, ['grep', '-l', '-F', targetPath, baseSha, '--'], repositoryRoot)
  if (!result.ok && result.status !== 1) throw new Error(`git grep failed while scanning ${targetPath}`)
  return result.stdout.split('\n').filter(Boolean).map((file) => `base:${file}`).sort()
}

function shouldPruneScan(directory: string): boolean {
  const name = path.basename(directory)
  if (name === '.git' || name === 'node_modules' || name === 'data' || name === 'logs' || name === 'tmp') return true
  if (name.startsWith('.next') || name.startsWith('.venv')) return true
  const parent = path.basename(path.dirname(directory))
  return name === 'worktrees' && (parent === '.codex' || parent === '.claude')
}

function reverseSymlinkReferences(worktrees: WorktreeRegistration[], targetPath: string): { references: string[]; errors: string[] } {
  const references: string[] = []
  const errors: string[] = []
  const target = canonical(targetPath)

  function walk(root: string, current: string, depth: number): void {
    if (depth > 8 || shouldPruneScan(current)) return
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(current, { withFileTypes: true })
    } catch (error) {
      errors.push(`${current}: ${error instanceof Error ? error.message : String(error)}`)
      return
    }
    for (const entry of entries) {
      const absolute = path.join(current, entry.name)
      if (entry.isSymbolicLink()) {
        try {
          const destination = fs.realpathSync(absolute)
          if (isWithin(destination, target)) references.push(`${root}:${path.relative(root, absolute)}`)
        } catch {
          // Dangling links do not point into an existing target.
        }
      } else if (entry.isDirectory()) walk(root, absolute, depth + 1)
    }
  }

  for (const worktree of worktrees) {
    const root = canonical(worktree.path)
    if (root === target || worktree.prunable || !fs.existsSync(root)) continue
    walk(root, root, 0)
  }
  return { references: sortedUnique(references), errors }
}

function diskUsageKiB(worktreePath: string): number | null {
  const result = command('/usr/bin/du', ['-sk', worktreePath])
  if (!result.ok) return null
  const value = Number(result.stdout.trim().split(/\s+/)[0])
  return Number.isFinite(value) ? value : null
}

export function buildAuditToken(baseSha: string, audit: Omit<WorktreeAudit, 'auditToken'>): string {
  const payload = {
    workflowVersion: WORKFLOW_VERSION,
    baseSha,
    path: audit.path,
    branch: audit.branch,
    head: audit.head,
    category: audit.category,
    dirtyDigest: audit.dirtyDigest,
    ignoredDigest: audit.ignoredDigest,
    externalSymlinks: audit.externalSymlinks,
    runtimeReferences: audit.runtimeReferences,
    sourceReferences: audit.sourceReferences,
    reverseSymlinkReferences: audit.reverseSymlinkReferences,
    integrated: audit.integrated,
    locked: audit.locked,
    prunable: audit.prunable,
    scanErrors: audit.scanErrors,
    deletionInspection: audit.deletionInspection,
    filesystemIdentity: audit.filesystemIdentity,
  }
  return digest(JSON.stringify(payload))
}

export function auditAll(
  base = 'origin/main',
  cwd = process.cwd(),
  options: { runtime?: RuntimeSnapshot; integrationOverrides?: ReadonlyMap<string, boolean> } = {},
): AuditResult {
  const context = repositoryContext(cwd)
  const baseSha = refCommit(context.repositoryRoot, base)
  const runtime = options.runtime ?? collectRuntimeSnapshot(context.repositoryRoot)
  const currentDirectory = canonical(process.cwd())
  const audits: WorktreeAudit[] = []

  for (const registration of context.worktrees) {
    const worktreePath = canonical(registration.path)
    const exists = fs.existsSync(worktreePath)
    const scanErrors = [...runtime.errors]
    let status = ''
    let ignored: IgnoredItem[] = []
    let runtimeRefs: string[] = []
    let sourceRefs: string[] = []
    let reverse = { references: [] as string[], errors: [] as string[] }
    let integrated = false
    let diskKiB: number | null = null
    let filesystemIdentity: { device: number; inode: number } | null = null

    if (exists) {
      diskKiB = diskUsageKiB(worktreePath)
      try {
        const targetStat = fs.lstatSync(worktreePath)
        if (targetStat.isSymbolicLink() || !targetStat.isDirectory()) {
          scanErrors.push('registered worktree path is not a real directory')
        } else {
          filesystemIdentity = { device: targetStat.dev, inode: targetStat.ino }
        }
      } catch (error) {
        scanErrors.push(`worktree identity scan unavailable: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    if (exists && !registration.prunable && registration.head) {
      try { status = runText(GIT, ['status', '--porcelain=v1', '-z', '--untracked-files=all'], worktreePath) } catch (error) {
        scanErrors.push(error instanceof Error ? error.message : String(error))
      }
      try { ignored = inspectIgnored(worktreePath) } catch (error) {
        scanErrors.push(error instanceof Error ? error.message : String(error))
      }
      runtimeRefs = runtimeReferences(runtime, worktreePath)
      try { sourceRefs = baseSourceReferences(context.repositoryRoot, baseSha, worktreePath) } catch (error) {
        scanErrors.push(error instanceof Error ? error.message : String(error))
      }
      reverse = reverseSymlinkReferences(context.worktrees, worktreePath)
      scanErrors.push(...reverse.errors)
      integrated = options.integrationOverrides?.get(worktreePath)
        ?? command(GIT, ['merge-base', '--is-ancestor', registration.head, baseSha], context.repositoryRoot).ok
    }

    const dirtyEntries = status ? status.split('\0').filter(Boolean).length : 0
    const protectedItems = ignored.filter((item) => item.kind === 'protected').map((item) => item.path)
    const disposableItems = ignored.filter((item) => item.kind === 'disposable').map((item) => item.path)
    let externalItems: string[] = []
    if (exists && !registration.prunable && registration.head) {
      try { externalItems = inspectExternalSymlinks(worktreePath, ignored) } catch (error) {
        scanErrors.push(error instanceof Error ? error.message : String(error))
      }
    }
    const classified = classifySafety({
      isRepositoryRoot: worktreePath === canonical(context.repositoryRoot),
      isCurrentDirectory: isWithin(currentDirectory, worktreePath),
      exists,
      locked: Boolean(registration.locked),
      prunable: Boolean(registration.prunable),
      dirtyEntries,
      protectedIgnoredEntries: protectedItems.length,
      externalSymlinkEntries: externalItems.length,
      runtimeReferences: runtimeRefs.length,
      sourceReferences: sourceRefs.length,
      reverseSymlinkReferences: reverse.references.length,
      scanErrors: scanErrors.length,
      integrated,
      deletionInspectionComplete: runtime.inspection.macosDeletionReady,
    })
    const partial: Omit<WorktreeAudit, 'auditToken'> = {
      path: worktreePath,
      branch: registration.branch ?? (registration.detached ? '(detached)' : '(none)'),
      head: registration.head,
      category: classified.category,
      reasons: classified.reasons,
      exists,
      dirtyEntries,
      dirtyDigest: digest(status),
      ignoredDisposable: disposableItems,
      ignoredProtected: protectedItems,
      externalSymlinks: externalItems,
      ignoredDigest: digest(JSON.stringify(ignored)),
      runtimeReferences: runtimeRefs,
      sourceReferences: sourceRefs,
      reverseSymlinkReferences: reverse.references,
      integrated,
      ahead: registration.head ? revCount(context.repositoryRoot, `${baseSha}..${registration.head}`) : null,
      behind: registration.head ? revCount(context.repositoryRoot, `${registration.head}..${baseSha}`) : null,
      locked: Boolean(registration.locked),
      prunable: Boolean(registration.prunable),
      diskKiB,
      scanErrors: sortedUnique(scanErrors),
      deletionInspection: { ...runtime.inspection },
      filesystemIdentity,
    }
    audits.push({ ...partial, auditToken: classified.category === 'REMOVABLE' ? buildAuditToken(baseSha, partial) : null })
  }

  return {
    workflowVersion: WORKFLOW_VERSION,
    generatedAt: new Date().toISOString(),
    repositoryRoot: context.repositoryRoot,
    invokedRoot: context.invokedRoot,
    base,
    baseSha,
    worktrees: audits,
  }
}

function atomicWriteJson(file: string, value: unknown): void {
  if (!path.isAbsolute(file)) throw new Error(`report path must be absolute: ${file}`)
  const directory = path.dirname(file)
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
  const temporary = path.join(directory, `.${path.basename(file)}.${process.pid}.tmp`)
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
  fs.renameSync(temporary, file)
}

function maybeWriteReport(report: string | undefined, value: unknown): void {
  if (!report) return
  atomicWriteJson(canonical(report), value)
  console.log(`Report written: ${canonical(report)}`)
}

function printAudit(result: AuditResult, json: boolean): void {
  if (json) {
    console.log(JSON.stringify(result, null, 2))
    return
  }
  console.log(`Base (cached local ref): ${result.base} ${result.baseSha}`)
  console.table(result.worktrees.map((row) => ({
    category: row.category,
    branch: row.branch,
    head: row.head?.slice(0, 12) ?? '-',
    ahead: row.ahead ?? '-',
    behind: row.behind ?? '-',
    dirty: row.dirtyEntries,
    protected: row.ignoredProtected.length + row.externalSymlinks.length,
    refs: row.runtimeReferences.length + row.sourceReferences.length + row.reverseSymlinkReferences.length,
    MiB: row.diskKiB === null ? '-' : Math.round(row.diskKiB / 1024),
    path: row.path,
  })))
  for (const row of result.worktrees.filter((entry) => entry.category !== 'REMOVABLE')) {
    console.log(`${row.category} ${row.path}: ${row.reasons.join('; ')}`)
  }
  for (const row of result.worktrees.filter((entry) => entry.category === 'REMOVABLE')) {
    console.log(`REMOVABLE ${row.path}: audit-token=${row.auditToken}`)
  }
  console.log('Dry run only: no fetch, merge, push, deployment, worktree removal, branch deletion, or prune was performed.')
}

function packageScripts(worktreePath: string): Record<string, string> {
  const parsed = JSON.parse(fs.readFileSync(path.join(worktreePath, 'package.json'), 'utf8')) as { scripts?: Record<string, string> }
  return parsed.scripts ?? {}
}

export function collectChangedFiles(target: string, base: string): string[] {
  refCommit(target, base)
  const outputs = [
    runText(GIT, ['diff', '--name-only', '-z', `${base}...HEAD`], target),
    runText(GIT, ['diff', '--name-only', '-z'], target),
    runText(GIT, ['diff', '--cached', '--name-only', '-z'], target),
    runText(GIT, ['ls-files', '--others', '--exclude-standard', '-z'], target),
  ]
  const files: string[] = []
  for (const output of outputs) files.push(...output.split('\0').filter(Boolean))
  // Keep deleted paths so regression-test selection and verification evidence
  // still account for removals. Only tools that require an existing file (for
  // example ESLint) may filter the set later.
  return sortedUnique(files)
}

export function checkUntrackedWhitespace(target: string): { command: string; durationMs: number } {
  const started = Date.now()
  const untracked = runText(GIT, ['ls-files', '--others', '--exclude-standard', '-z'], target)
    .split('\0')
    .filter(Boolean)
  const errors: string[] = []
  for (const file of untracked) {
    const result = command(GIT, ['diff', '--no-index', '--check', '--', '/dev/null', file], target)
    const detail = (result.stdout || result.stderr).trim()
    if (result.status === 3 && detail) {
      errors.push(detail)
      continue
    }
    if (result.status !== 0 && result.status !== 1) {
      throw new Error(`untracked whitespace check failed for ${file} (${result.status ?? 'spawn'}): ${(result.stderr || result.stdout).trim()}`)
    }
    if (detail) errors.push(detail)
  }
  if (errors.length > 0) throw new Error(`untracked files contain whitespace errors:\n${errors.join('\n')}`)
  return { command: 'git diff --no-index --check (untracked files)', durationMs: Date.now() - started }
}

function lintable(file: string): boolean {
  return /\.(?:cjs|mjs|js|jsx|cts|mts|ts|tsx)$/.test(file)
}

function globPattern(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*\//g, '\u0001')
    .replace(/\*\*/g, '\u0000')
    .replace(/\*/g, '[^/]*')
    .replace(/\u0001/g, '(?:.*/)?')
    .replace(/\u0000/g, '.*')
  return new RegExp(`^${escaped}$`)
}

function matchesAny(file: string, patterns: string[]): boolean {
  return patterns.some((pattern) => globPattern(pattern).test(file))
}

export function selectRelevantTests(
  changed: string[],
  config: TestSelectionConfig,
  scripts: Record<string, string>,
): { tests: string[]; unmappedCode: string[] } {
  const selected = new Set(config.mandatory)
  const mapped = new Set<string>()
  for (const rule of config.rules) {
    const matches = changed.filter((file) => matchesAny(file, rule.paths))
    if (matches.length === 0) continue
    matches.forEach((file) => mapped.add(file))
    rule.tests.forEach((test) => selected.add(test))
  }
  const unmappedCode = changed.filter((file) => lintable(file) && !mapped.has(file) && !matchesAny(file, config.ignored))
  for (const test of selected) {
    if (!scripts[test]) throw new Error(`test-selection config references missing package script: ${test}`)
  }
  return { tests: [...selected].sort(), unmappedCode }
}

export function normalizeLintDiagnostic(root: string, message: string): string {
  const rootAliases = sortedUnique([path.resolve(root), canonical(root)]).sort((a, b) => b.length - a.length)
  const portableMessage = rootAliases.reduce((value, alias) => value.split(alias).join('<repo>'), message)
  // React Compiler diagnostics include absolute paths, line numbers, and source
  // excerpts after the first line. Those change when unrelated lines move. The
  // source line is fingerprinted separately, so retain only the stable summary.
  return (portableMessage.split('\n', 1)[0] ?? '').trim()
}

function lintFingerprint(root: string, result: EslintResult, message: EslintMessage): string {
  const relative = path.relative(root, result.filePath).split(path.sep).join('/')
  const sourceLine = result.source && message.line ? (result.source.split('\n')[message.line - 1] ?? '').trim() : ''
  return JSON.stringify([
    relative,
    message.ruleId ?? '(fatal)',
    message.severity,
    normalizeLintDiagnostic(root, message.message),
    sourceLine,
  ])
}

function eslintFindings(root: string, results: EslintResult[]): Array<{ fingerprint: string; display: string }> {
  const findings: Array<{ fingerprint: string; display: string }> = []
  for (const result of results) {
    const relative = path.relative(root, result.filePath).split(path.sep).join('/')
    for (const message of result.messages) {
      findings.push({
        fingerprint: lintFingerprint(root, result, message),
        display: `${relative}:${message.line ?? 0} ${message.ruleId ?? 'fatal'} ${message.message}`,
      })
    }
  }
  return findings
}

function runEslintJson(eslint: string, files: string[], target: string): EslintResult[] {
  const result = command(eslint, ['--format=json', '--no-warn-ignored', ...files], target)
  if (result.status !== 0 && result.status !== 1) {
    throw new Error(`ESLint execution failed (${result.status ?? 'spawn'}): ${(result.stderr || result.stdout).trim()}`)
  }
  try {
    return JSON.parse(result.stdout) as EslintResult[]
  } catch (error) {
    throw new Error(`ESLint returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
}

function readLintBaseline(target: string): LintBaseline {
  const file = path.join(target, '.eslint-baseline.json')
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as LintBaseline
  if (parsed.schemaVersion !== 1 || !parsed.entries || typeof parsed.entries !== 'object') {
    throw new Error(`invalid ESLint baseline: ${file}`)
  }
  return parsed
}

export function compareLintBaseline(
  findings: Array<{ fingerprint: string; display: string }>,
  baseline: LintBaseline,
): { newFindings: string[]; suppressed: number } {
  const remaining = new Map(Object.entries(baseline.entries))
  const newFindings: string[] = []
  let suppressed = 0
  for (const finding of findings) {
    const count = remaining.get(finding.fingerprint) ?? 0
    if (count > 0) {
      remaining.set(finding.fingerprint, count - 1)
      suppressed += 1
    } else {
      newFindings.push(finding.display)
    }
  }
  return { newFindings, suppressed }
}

function verificationStampPath(commonDir: string, target: string): string {
  return path.join(stateDirectory(commonDir), 'verifications', `${digest(canonical(target))}.json`)
}

function unsignedVerification(stamp: VerificationStamp): Omit<VerificationStamp, 'signature'> {
  const payload = { ...stamp } as Partial<VerificationStamp>
  delete payload.signature
  return payload as Omit<VerificationStamp, 'signature'>
}

export function recordVerification(
  commonDir: string,
  input: Omit<VerificationStamp, 'schemaVersion' | 'workflowVersion' | 'signature'>,
): VerificationStamp {
  const unsigned: Omit<VerificationStamp, 'signature'> = {
    schemaVersion: 1,
    workflowVersion: WORKFLOW_VERSION,
    ...input,
  }
  const stamp: VerificationStamp = { ...unsigned, signature: signState(commonDir, unsigned, true) }
  atomicWriteJson(verificationStampPath(commonDir, input.target), stamp)
  return stamp
}

function readVerifiedStamp(commonDir: string, target: string): VerificationStamp | null {
  const file = verificationStampPath(commonDir, target)
  if (!fs.existsSync(file)) return null
  const stamp = JSON.parse(fs.readFileSync(file, 'utf8')) as VerificationStamp
  if (stamp.schemaVersion !== 1 || stamp.workflowVersion !== WORKFLOW_VERSION || !stamp.signature) return null
  const expected = signState(commonDir, unsignedVerification(stamp), false)
  return safeEqualHex(stamp.signature, expected) ? stamp : null
}

function verify(options: CliOptions): void {
  const context = repositoryContext(options.path ?? process.cwd())
  const target = canonical(options.path ?? context.invokedRoot)
  if (!context.worktrees.some((row) => canonical(row.path) === target)) throw new Error(`not a registered worktree: ${target}`)
  const scripts = packageScripts(target)
  const changed = collectChangedFiles(target, options.base)
  let tests = [...options.tests]
  if (options.selectTests) {
    const selectionFile = path.join(target, 'config', 'development-completion-tests.json')
    const selection = JSON.parse(fs.readFileSync(selectionFile, 'utf8')) as TestSelectionConfig
    if (selection.schemaVersion !== 1) throw new Error(`invalid test-selection config: ${selectionFile}`)
    const selected = selectRelevantTests(changed, selection, scripts)
    if (selected.unmappedCode.length > 0) {
      throw new Error(`changed code has no reviewed regression-test mapping: ${selected.unmappedCode.join(', ')}`)
    }
    tests = sortedUnique([...tests, ...selected.tests])
  }
  if (tests.length === 0) throw new Error('verify requires --select-tests or at least one related --test=test:<package-script>')

  for (const test of tests) {
    if (!scripts[test]) throw new Error(`package script does not exist: ${test}`)
    if (!(test.startsWith('test:') || test === 'storage:guard-test')) {
      throw new Error(`related regression must be a test:* script or storage:guard-test: ${test}`)
    }
  }

  const tsc = path.join(target, 'node_modules', '.bin', 'tsc')
  const eslint = path.join(target, 'node_modules', '.bin', 'eslint')
  if (!fs.existsSync(tsc)) throw new Error(`TypeScript compiler is unavailable: ${tsc}`)
  if (!fs.existsSync(eslint)) throw new Error(`ESLint is unavailable: ${eslint}`)
  if (!scripts.build) throw new Error('package.json does not define the required build script')

  const statusBefore = runText(GIT, ['status', '--porcelain=v1', '-z', '--untracked-files=all'], target)
  const started = new Date().toISOString()
  const steps: Array<{ command: string; durationMs: number }> = []
  console.log(`Quality target: ${target}`)
  steps.push(runVisible(GIT, ['diff', '--check'], target))
  steps.push(runVisible(GIT, ['diff', '--cached', '--check'], target))
  steps.push(checkUntrackedWhitespace(target))
  steps.push(runVisible(tsc, ['--noEmit', '--incremental', 'false'], target))

  const lintFiles = changed.filter((file) => lintable(file) && fs.existsSync(path.join(target, file)))
  let baselineSuppressed = 0
  if (lintFiles.length > 0) {
    const lintStarted = Date.now()
    const lintResults = runEslintJson(eslint, lintFiles, target)
    const compared = compareLintBaseline(eslintFindings(target, lintResults), readLintBaseline(target))
    baselineSuppressed = compared.suppressed
    if (compared.newFindings.length > 0) {
      throw new Error(`ESLint found ${compared.newFindings.length} new finding(s):\n${compared.newFindings.join('\n')}`)
    }
    console.log(`\n> eslint changed files: PASS (${baselineSuppressed} existing finding(s) suppressed by reviewed baseline)`)
    steps.push({ command: `eslint-baseline-gate ${lintFiles.join(' ')}`, durationMs: Date.now() - lintStarted })
  } else {
    console.log('\n> eslint: no changed JavaScript/TypeScript files; not applicable')
  }
  for (const test of tests) steps.push(runVisible('npm', ['run', test], target))
  steps.push(runVisible('npm', ['run', 'build'], target))

  const statusAfter = runText(GIT, ['status', '--porcelain=v1', '-z', '--untracked-files=all'], target)
  if (statusAfter !== statusBefore) {
    throw new Error('quality commands changed tracked/untracked state; inspect and preserve generated changes before continuing')
  }
  const baseSha = refCommit(context.repositoryRoot, options.base)
  const head = refCommit(target, 'HEAD')
  const report = {
    workflowVersion: WORKFLOW_VERSION,
    kind: 'quality-verification',
    startedAt: started,
    finishedAt: new Date().toISOString(),
    target,
    branch: command(GIT, ['symbolic-ref', '--quiet', '--short', 'HEAD'], target).stdout.trim() || '(detached)',
    head,
    base: options.base,
    baseSha,
    integrated: command(GIT, ['merge-base', '--is-ancestor', head, baseSha], context.repositoryRoot).ok,
    statusEntries: statusAfter ? statusAfter.split('\0').filter(Boolean).length : 0,
    lintedFiles: lintFiles,
    tests,
    baselineSuppressed,
    build: true,
    steps,
  }
  const verification = recordVerification(context.commonDir, {
    target,
    head,
    base: options.base,
    baseSha,
    statusDigest: digest(statusAfter),
    changedFilesDigest: digest(JSON.stringify(changed)),
    tests,
    finishedAt: report.finishedAt,
  })
  maybeWriteReport(options.report, report)
  console.log(JSON.stringify(report, null, 2))
  console.log(`Verification evidence recorded: ${verificationStampPath(context.commonDir, target)} (${verification.finishedAt})`)
  console.log('Quality verification passed. Commit, push, merge, deployment, and cleanup were not performed.')
}

function generateLintBaseline(options: CliOptions): void {
  const context = repositoryContext(options.path ?? process.cwd())
  const target = canonical(options.path ?? context.invokedRoot)
  const eslint = path.join(target, 'node_modules', '.bin', 'eslint')
  if (!fs.existsSync(eslint)) throw new Error(`ESLint is unavailable: ${eslint}`)
  const results = runEslintJson(eslint, ['.'], target)
  const entries: Record<string, number> = {}
  for (const finding of eslintFindings(target, results)) entries[finding.fingerprint] = (entries[finding.fingerprint] ?? 0) + 1
  const baseline = {
    schemaVersion: 1 as const,
    generatedAt: new Date().toISOString(),
    note: 'Reviewed pre-existing ESLint debt. Updating this file requires code review.',
    entries: Object.fromEntries(Object.entries(entries).sort(([left], [right]) => left.localeCompare(right))),
  }
  const output = path.join(target, '.eslint-baseline.json')
  atomicWriteJson(output, baseline)
  console.log(`ESLint baseline written: ${output} (${Object.values(entries).reduce((sum, count) => sum + count, 0)} findings)`)
}

export function summarizeGitHubChecks(checks: Array<Record<string, unknown>>): GitHubCheckSummary {
  let passing = 0
  let pending = 0
  let failing = 0
  const names: string[] = []
  const failures: string[] = []
  for (const check of checks) {
    const value = String(check.conclusion ?? check.state ?? check.status ?? '').toUpperCase()
    const name = String(check.name ?? check.context ?? check.workflowName ?? check.__typename ?? 'unnamed check')
    names.push(name)
    if (['SUCCESS', 'NEUTRAL', 'SKIPPED'].includes(value)) passing += 1
    else if (['', 'PENDING', 'EXPECTED', 'QUEUED', 'IN_PROGRESS', 'WAITING', 'REQUESTED'].includes(value)) pending += 1
    else {
      failing += 1
      failures.push(`${name}:${value}`)
    }
  }
  const total = checks.length
  const status = total === 0 ? 'missing' : failing > 0 ? 'failing' : pending > 0 ? 'pending' : 'passing'
  return { status, total, passing, pending, failing, names: sortedUnique(names), failures }
}

function mergeCommitOid(pr: Record<string, unknown> | null): string | null {
  const value = pr?.mergeCommit
  if (value && typeof value === 'object' && 'oid' in value && typeof value.oid === 'string') return value.oid
  return typeof value === 'string' ? value : null
}

export function evaluateIntegrationProof(input: GitHubIntegrationInput): IntegrationProof {
  const baseRefName = typeof input.pr?.baseRefName === 'string' ? input.pr.baseRefName : null
  const headRefOid = typeof input.pr?.headRefOid === 'string' ? input.pr.headRefOid : null
  const mergedOid = mergeCommitOid(input.pr)
  const reasons: string[] = []
  if (!input.pr) reasons.push('GitHub PR evidence is unavailable')
  if (input.pr?.state !== 'MERGED') reasons.push('PR is not merged')
  if (baseRefName !== input.expectedBase) reasons.push(`PR base is ${baseRefName ?? 'unknown'}, expected ${input.expectedBase}`)
  if (headRefOid !== input.localHead) reasons.push('PR head OID does not match the inspected worktree HEAD')
  if (input.ci.status !== 'passing') reasons.push(`required PR checks are ${input.ci.status}`)
  if (!input.ci.names.some((name) => name === 'completion-gate' || name.endsWith(' / completion-gate'))) {
    reasons.push('Development completion / completion-gate is missing from PR checks')
  }
  if (!mergedOid || !/^[0-9a-f]{40}$/i.test(mergedOid)) reasons.push('PR merge commit OID is unavailable')

  let method: IntegrationProof['method'] = 'unproven'
  if (reasons.length === 0 && input.localHeadInBase) method = 'merge-commit'
  else if (reasons.length === 0 && input.mergeCommitInBase) method = 'squash-or-rebase'
  else if (reasons.length === 0) reasons.push('neither the original HEAD nor GitHub merge commit is contained in the selected mainline')
  return {
    proven: reasons.length === 0 && method !== 'unproven',
    method,
    reasons,
    baseRefName,
    headRefOid,
    mergeCommitOid: mergedOid,
  }
}

function githubIntegrationProof(
  target: string,
  repositoryRoot: string,
  base: string,
  branch: string,
  head: string,
): { pr: Record<string, unknown>; ci: GitHubCheckSummary; proof: IntegrationProof } {
  if (!/(?:^|\/)main$/.test(base)) throw new Error(`deletion integration proof requires a main base, received: ${base}`)
  const baseSha = refCommit(repositoryRoot, base)
  const gh = command('gh', [
    'pr', 'view', branch,
    '--json', 'number,url,state,isDraft,baseRefName,headRefName,headRefOid,mergeStateStatus,reviewDecision,statusCheckRollup,mergedAt,mergeCommit',
  ], target)
  if (!gh.ok) throw new Error(`GitHub PR check failed: ${(gh.stderr || gh.stdout).trim() || 'gh unavailable or no PR found'}`)
  let pr: Record<string, unknown>
  try {
    pr = JSON.parse(gh.stdout) as Record<string, unknown>
  } catch (error) {
    throw new Error(`GitHub response was invalid JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
  const checks = Array.isArray(pr.statusCheckRollup) ? pr.statusCheckRollup as Array<Record<string, unknown>> : []
  const ci = summarizeGitHubChecks(checks)
  const mergedOid = mergeCommitOid(pr)
  const proof = evaluateIntegrationProof({
    expectedBase: 'main',
    localHead: head,
    localHeadInBase: command(GIT, ['merge-base', '--is-ancestor', head, baseSha], repositoryRoot).ok,
    mergeCommitInBase: Boolean(mergedOid && command(GIT, ['merge-base', '--is-ancestor', mergedOid, baseSha], repositoryRoot).ok),
    pr,
    ci,
  })
  return { pr, ci, proof }
}

function integrationStatus(options: CliOptions): void {
  const context = repositoryContext(options.path ?? process.cwd())
  const target = canonical(options.path ?? context.invokedRoot)
  const branchResult = command(GIT, ['symbolic-ref', '--quiet', '--short', 'HEAD'], target)
  const branch = branchResult.stdout.trim()
  if (!branch) throw new Error('GitHub integration check requires a named branch')
  const head = refCommit(target, 'HEAD')
  const baseSha = refCommit(context.repositoryRoot, options.base)
  const localIntegrated = command(GIT, ['merge-base', '--is-ancestor', head, baseSha], context.repositoryRoot).ok
  const upstream = command(GIT, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], target)
  const local = {
    branch,
    head,
    base: options.base,
    baseSha,
    integrated: localIntegrated,
    upstream: upstream.ok ? upstream.stdout.trim() : null,
    ahead: revCount(context.repositoryRoot, `${baseSha}..${head}`),
    behind: revCount(context.repositoryRoot, `${head}..${baseSha}`),
  }

  let github: Record<string, unknown> | null = null
  const errors: string[] = []
  if (options.github) {
    const gh = command('gh', [
      'pr', 'view', branch,
      '--json', 'number,url,state,isDraft,baseRefName,headRefName,headRefOid,mergeStateStatus,reviewDecision,statusCheckRollup,mergedAt,mergeCommit',
    ], target)
    if (!gh.ok) errors.push(`GitHub PR check failed: ${(gh.stderr || gh.stdout).trim() || 'gh unavailable or no PR found'}`)
    else {
      try {
        const pr = JSON.parse(gh.stdout) as Record<string, unknown>
        const checks = Array.isArray(pr.statusCheckRollup) ? pr.statusCheckRollup as Array<Record<string, unknown>> : []
        const ci = summarizeGitHubChecks(checks)
        const mergedOid = mergeCommitOid(pr)
        const proof = evaluateIntegrationProof({
          expectedBase: 'main',
          localHead: head,
          localHeadInBase: localIntegrated,
          mergeCommitInBase: Boolean(mergedOid && command(GIT, ['merge-base', '--is-ancestor', mergedOid, baseSha], context.repositoryRoot).ok),
          pr,
          ci,
        })
        github = {
          ...pr,
          ci,
          integrationProof: proof,
          readyForCleanup: proof.proven,
        }
      } catch (error) {
        errors.push(`GitHub response was invalid JSON: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }

  const report = {
    workflowVersion: WORKFLOW_VERSION,
    kind: 'integration-status',
    generatedAt: new Date().toISOString(),
    target,
    local,
    github,
    errors,
    note: 'No fetch, push, merge, rebase, deployment, or cleanup was performed.',
  }
  maybeWriteReport(options.report, report)
  console.log(JSON.stringify(report, null, 2))
  if (errors.length > 0) process.exitCode = 1
}

export function evaluateHookGate(
  options: CliOptions,
  nowMs = Date.now(),
): { required: boolean; verified: boolean; reasons: string[]; event: string } {
  const context = repositoryContext(options.path ?? process.cwd())
  const target = canonical(options.path ?? context.invokedRoot)
  const status = runText(GIT, ['status', '--porcelain=v1', '-z', '--untracked-files=all'], target)
  const head = refCommit(target, 'HEAD')
  const baseSha = refCommit(context.repositoryRoot, options.base)
  const changed = collectChangedFiles(target, options.base)
  const event = options.event ?? 'manual'
  if (changed.length === 0 && !status) return { required: false, verified: true, reasons: [], event }
  const stamp = readVerifiedStamp(context.commonDir, target)
  const reasons: string[] = []
  if (!stamp) reasons.push('no valid signed workflow:verify evidence exists')
  else {
    if (stamp.target !== target) reasons.push('verification target changed')
    if (stamp.head !== head) reasons.push('HEAD changed after verification')
    if (stamp.base !== options.base || stamp.baseSha !== baseSha) reasons.push('base changed after verification')
    if (stamp.statusDigest !== digest(status)) reasons.push('tracked/untracked files changed after verification')
    if (stamp.changedFilesDigest !== digest(JSON.stringify(changed))) reasons.push('changed-file set changed after verification')
    if (stamp.tests.length === 0) reasons.push('verification contains no regression tests')
    const finished = Date.parse(stamp.finishedAt)
    if (!Number.isFinite(finished) || nowMs - finished > VERIFICATION_MAX_AGE_MS || finished > nowMs + 60_000) {
      reasons.push('verification evidence is expired or has an invalid timestamp')
    }
  }
  return { required: true, verified: reasons.length === 0, reasons, event }
}

function hookStatus(options: CliOptions): void {
  const result = evaluateHookGate(options)
  if (!result.verified) {
    throw new Error([
      `StockBoard ${result.event} completion gate blocked: ${result.reasons.join('; ')}`,
      'Run npm run workflow:verify -- --select-tests (or explicit related --test values), then retry completion.',
      'The hook never performs merge, push, deployment, approval, or worktree deletion.',
    ].join('\n'))
  }
  if (result.required) console.log(`StockBoard ${result.event} completion gate: verified evidence matches current HEAD and files.`)
}

function removalRecordPath(commonDir: string, auditToken: string): string {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
  return path.join(commonDir, 'stockboard-workflow', 'records', `${timestamp}-${auditToken.slice(0, 12)}.json`)
}

function approvalPath(commonDir: string, state: 'pending' | 'used', approvalId: string): string {
  if (!/^[0-9a-f]{48}$/i.test(approvalId)) throw new Error('approval ID must be 48 hexadecimal characters')
  return path.join(stateDirectory(commonDir), 'approvals', state, `${approvalId}.json`)
}

function unsignedApproval(approval: RemovalApproval): Omit<RemovalApproval, 'signature'> {
  const payload = { ...approval } as Partial<RemovalApproval>
  delete payload.signature
  return payload as Omit<RemovalApproval, 'signature'>
}

export function createRemovalApproval(input: {
  commonDir: string
  auditResult: AuditResult
  audit: WorktreeAudit
  integrationProof: IntegrationProof
  nowMs?: number
  ttlMinutes?: number
}): RemovalApproval {
  const nowMs = input.nowMs ?? Date.now()
  const ttlMinutes = input.ttlMinutes ?? DEFAULT_APPROVAL_TTL_MINUTES
  if (!Number.isInteger(ttlMinutes) || ttlMinutes < 1 || ttlMinutes > MAX_APPROVAL_TTL_MINUTES) {
    throw new Error(`approval TTL must be an integer from 1 to ${MAX_APPROVAL_TTL_MINUTES} minutes`)
  }
  if (input.audit.category !== 'REMOVABLE' || !input.audit.auditToken || !input.audit.head) {
    throw new Error('approval requires a REMOVABLE audit with an audit token and HEAD')
  }
  if (!input.audit.deletionInspection.macosDeletionReady) throw new Error('approval requires a complete strict macOS deletion inspection')
  if (!input.integrationProof.proven) throw new Error(`approval requires proven GitHub integration: ${input.integrationProof.reasons.join('; ')}`)
  const approvalId = crypto.randomBytes(24).toString('hex')
  let username = 'unknown'
  let uid: number | null = typeof process.getuid === 'function' ? process.getuid() : null
  try {
    const info = os.userInfo()
    username = info.username
    uid = typeof info.uid === 'number' ? info.uid : uid
  } catch {
    // Identity is informational only and is explicitly not authentication.
  }
  const unsigned: Omit<RemovalApproval, 'signature'> = {
    schemaVersion: 1,
    workflowVersion: WORKFLOW_VERSION,
    approvalId,
    issuedAt: new Date(nowMs).toISOString(),
    expiresAt: new Date(nowMs + ttlMinutes * 60_000).toISOString(),
    issuer: { mechanism: 'local-interactive-unverified', authenticated: false, uid, username },
    target: input.audit.path,
    branch: input.audit.branch,
    head: input.audit.head,
    base: input.auditResult.base,
    baseSha: input.auditResult.baseSha,
    auditToken: input.audit.auditToken,
    integrationProof: input.integrationProof,
    integrationDigest: digest(JSON.stringify(input.integrationProof)),
  }
  const approval: RemovalApproval = { ...unsigned, signature: signState(input.commonDir, unsigned, true) }
  const pending = approvalPath(input.commonDir, 'pending', approvalId)
  fs.mkdirSync(path.dirname(pending), { recursive: true, mode: 0o700 })
  fs.writeFileSync(pending, `${JSON.stringify(approval, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
  return approval
}

export function validateRemovalApproval(
  commonDir: string,
  approval: RemovalApproval,
  expectedTarget: string,
  nowMs = Date.now(),
): void {
  if (approval.schemaVersion !== 1 || approval.workflowVersion !== WORKFLOW_VERSION) throw new Error('approval schema/version mismatch')
  const expectedSignature = signState(commonDir, unsignedApproval(approval), false)
  if (!safeEqualHex(approval.signature, expectedSignature)) throw new Error('approval signature is invalid; the approval may be corrupted or tampered with')
  if (approval.target !== expectedTarget) throw new Error('approval target does not match the requested worktree')
  if (approval.issuer.authenticated !== false || approval.issuer.mechanism !== 'local-interactive-unverified') {
    throw new Error('unsupported approval issuer')
  }
  const issuedAt = Date.parse(approval.issuedAt)
  const expiresAt = Date.parse(approval.expiresAt)
  if (!Number.isFinite(issuedAt) || !Number.isFinite(expiresAt) || expiresAt <= issuedAt) throw new Error('approval timestamps are invalid')
  if (nowMs < issuedAt - 60_000) throw new Error('approval was issued in the future')
  if (nowMs >= expiresAt) throw new Error('approval has expired; obtain a fresh interactive approval')
  if (!approval.integrationProof.proven || approval.integrationDigest !== digest(JSON.stringify(approval.integrationProof))) {
    throw new Error('approval integration proof is invalid')
  }
}

export function validateApprovalAgainstAudit(
  approval: RemovalApproval,
  result: AuditResult,
  audit: WorktreeAudit | undefined,
  integrationProof: IntegrationProof,
): void {
  if (result.base !== approval.base || result.baseSha !== approval.baseSha) throw new Error('base changed after approval')
  if (!audit) throw new Error('approved worktree is no longer registered')
  if (audit.path !== approval.target || audit.branch !== approval.branch || audit.head !== approval.head) {
    throw new Error('worktree path, branch, or HEAD changed after approval')
  }
  if (audit.category !== 'REMOVABLE' || audit.auditToken !== approval.auditToken) {
    throw new Error(`approval-bound audit changed: ${audit.category}: ${audit.reasons.join('; ')}`)
  }
  if (!audit.deletionInspection.macosDeletionReady) throw new Error('strict macOS deletion inspection is no longer complete')
  if (!integrationProof.proven || digest(JSON.stringify(integrationProof)) !== approval.integrationDigest) {
    throw new Error('GitHub integration proof changed after approval')
  }
}

export function consumeRemovalApproval(
  commonDir: string,
  approvalId: string,
  expectedTarget: string,
  nowMs = Date.now(),
): RemovalApproval {
  const pending = approvalPath(commonDir, 'pending', approvalId)
  const used = approvalPath(commonDir, 'used', approvalId)
  fs.mkdirSync(path.dirname(used), { recursive: true, mode: 0o700 })
  try {
    fs.renameSync(pending, used)
  } catch (error) {
    if (fs.existsSync(used)) throw new Error('approval has already been consumed and cannot be reused')
    throw new Error(`pending approval is unavailable: ${error instanceof Error ? error.message : String(error)}`)
  }
  const approval = JSON.parse(fs.readFileSync(used, 'utf8')) as RemovalApproval
  validateRemovalApproval(commonDir, approval, expectedTarget, nowMs)
  return approval
}

export function withRemovalLock<T>(commonDir: string, target: string, action: () => T): T {
  const lockDirectory = path.join(stateDirectory(commonDir), 'remove.lock')
  fs.mkdirSync(path.dirname(lockDirectory), { recursive: true, mode: 0o700 })
  try {
    fs.mkdirSync(lockDirectory, { mode: 0o700 })
  } catch {
    throw new Error(`another worktree removal is active or requires manual lock review: ${lockDirectory}`)
  }
  const ownerFile = path.join(lockDirectory, 'owner.json')
  try {
    fs.writeFileSync(ownerFile, `${JSON.stringify({ pid: process.pid, target, startedAt: new Date().toISOString() }, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
    return action()
  } finally {
    try { fs.unlinkSync(ownerFile) } catch { /* preserve the original result */ }
    try { fs.rmdirSync(lockDirectory) } catch { /* a stale lock is safer than unsafe automatic cleanup */ }
  }
}

function assertCanonicalWorktreePath(rawPath: string): string {
  if (!path.isAbsolute(rawPath)) throw new Error('path must be absolute')
  const resolved = path.resolve(rawPath)
  const target = canonical(rawPath)
  if (resolved !== target) throw new Error('path aliases and symbolic-link worktree paths are not accepted; use the canonical registered path')
  const stat = fs.lstatSync(rawPath)
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('worktree path must be a real directory, not a symbolic link')
  return target
}

function readInteractiveLine(prompt: string): string {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error('unauthenticated automated approval/removal is disabled; run this command interactively in a trusted terminal')
  }
  process.stdout.write(prompt)
  const bytes: number[] = []
  const buffer = Buffer.alloc(1)
  while (bytes.length < 8192) {
    const count = fs.readSync(process.stdin.fd, buffer, 0, 1, null)
    if (count === 0 || buffer[0] === 10) break
    if (buffer[0] !== 13) bytes.push(buffer[0])
  }
  return Buffer.from(bytes).toString('utf8')
}

function authorizeWorktreeRemoval(options: CliOptions): void {
  if (!options.path) throw new Error('approve requires --path=<canonical absolute worktree path>')
  const target = assertCanonicalWorktreePath(options.path)
  if (options.confirm !== target) throw new Error('--confirm must exactly repeat the canonical absolute --path value')
  if (!options.baseSha || !/^[0-9a-f]{40}$/i.test(options.baseSha)) throw new Error('approve requires --base-sha=<40-character SHA>')
  if (!options.auditToken || !/^[0-9a-f]{64}$/i.test(options.auditToken)) throw new Error('approve requires --audit-token=<64-character token>')
  const context = repositoryContext(target)
  const registration = context.worktrees.find((row) => canonical(row.path) === target)
  if (!registration?.head || !registration.branch) throw new Error('approval requires a registered worktree with a named branch and HEAD')
  const github = githubIntegrationProof(target, context.repositoryRoot, options.base, registration.branch, registration.head)
  if (!github.proof.proven) throw new Error(`GitHub integration is not proven: ${github.proof.reasons.join('; ')}`)
  const integrationOverrides = new Map([[target, true]])
  const result = auditAll(options.base, target, { integrationOverrides })
  if (result.baseSha !== options.baseSha) throw new Error('base SHA differs from the reviewed audit')
  const audit = result.worktrees.find((row) => row.path === target)
  if (!audit || audit.category !== 'REMOVABLE') throw new Error(`worktree is not removable: ${audit?.reasons.join('; ') ?? 'not registered'}`)
  if (audit.auditToken !== options.auditToken) throw new Error('audit token changed; review a fresh strict macOS audit')
  const challenge = `AUTHORIZE ${options.auditToken.slice(0, 12)} ${target}`
  const typed = readInteractiveLine([
    '\nThis is a local human-presence check, not identity authentication.',
    `Approval expires in ${options.ttlMinutes ?? DEFAULT_APPROVAL_TTL_MINUTES} minute(s) and can be consumed once.`,
    `Type exactly: ${challenge}`,
    '> ',
  ].join('\n'))
  if (typed !== challenge) throw new Error('interactive approval challenge did not match')
  const approval = createRemovalApproval({
    commonDir: context.commonDir,
    auditResult: result,
    audit,
    integrationProof: github.proof,
    ttlMinutes: options.ttlMinutes,
  })
  console.log(JSON.stringify({
    approvalId: approval.approvalId,
    target: approval.target,
    expiresAt: approval.expiresAt,
    authenticated: false,
    warning: 'This approval confirms local interactive presence only; it does not prove personal identity.',
  }, null, 2))
}

export function removalGitArguments(target: string): string[] {
  return ['worktree', 'remove', target]
}

export function removeWorktree(options: CliOptions): void {
  if (!options.path) throw new Error('remove requires --path=<canonical absolute worktree path>')
  if (!options.approvalId) throw new Error('remove requires --approval-id=<one-time approval ID>')
  const target = assertCanonicalWorktreePath(options.path)
  if (options.confirm !== target) throw new Error('--confirm must exactly repeat the canonical absolute --path value')
  const typed = readInteractiveLine(`Type exactly to consume the one-time approval and remove the worktree:\nREMOVE ${target}\n> `)
  if (typed !== `REMOVE ${target}`) throw new Error('interactive removal challenge did not match')
  const context = repositoryContext(target)

  withRemovalLock(context.commonDir, target, () => {
    const approval = consumeRemovalApproval(context.commonDir, options.approvalId!, target)
    const recordFile = removalRecordPath(context.commonDir, approval.auditToken)
    const record: Record<string, unknown> = {
      workflowVersion: WORKFLOW_VERSION,
      kind: 'worktree-removal',
      status: 'approval-consumed',
      approvalId: approval.approvalId,
      approvalIssuer: approval.issuer,
      consumedAt: new Date().toISOString(),
      target,
      branch: approval.branch,
      head: approval.head,
      base: approval.base,
      baseSha: approval.baseSha,
      auditToken: approval.auditToken,
      limitation: 'The repository lock coordinates this workflow only; unrelated processes and filesystem writers cannot be fully excluded.',
    }
    atomicWriteJson(recordFile, record)
    try {
      const github = githubIntegrationProof(target, context.repositoryRoot, approval.base, approval.branch, approval.head)
      if (!github.proof.proven) throw new Error(`fresh GitHub integration proof failed: ${github.proof.reasons.join('; ')}`)
      const integrationOverrides = new Map([[target, true]])
      const first = auditAll(approval.base, target, { integrationOverrides })
      const firstAudit = first.worktrees.find((row) => row.path === target)
      validateApprovalAgainstAudit(approval, first, firstAudit, github.proof)
      if (!firstAudit) throw new Error('approved worktree disappeared after validation')

      // Repeat immediately before Git. This narrows, but cannot eliminate, races from non-cooperating processes.
      const final = auditAll(approval.base, target, { integrationOverrides })
      const audit = final.worktrees.find((row) => row.path === target)
      validateApprovalAgainstAudit(approval, final, audit, github.proof)
      if (!audit) throw new Error('approved worktree disappeared before removal')
      if (JSON.stringify(audit.filesystemIdentity) !== JSON.stringify(firstAudit.filesystemIdentity)) {
        throw new Error('worktree filesystem identity changed during locked validation')
      }

      Object.assign(record, { status: 'removing', finalAuditAt: new Date().toISOString(), filesystemIdentity: audit.filesystemIdentity })
      atomicWriteJson(recordFile, record)
      runVisible(GIT, removalGitArguments(target), final.repositoryRoot)
      const after = repositoryContext(final.repositoryRoot)
      if (after.worktrees.some((row) => canonical(row.path) === target)) throw new Error('post-removal verification failed: worktree remains registered')
      if (fs.existsSync(target)) throw new Error('post-removal verification failed: worktree path still exists')
      runText(GIT, ['cat-file', '-e', `${approval.head}^{commit}`], final.repositoryRoot)
      runText(GIT, ['show-ref', '--verify', `refs/heads/${approval.branch}`], final.repositoryRoot)
      Object.assign(record, {
        status: 'completed',
        completedAt: new Date().toISOString(),
        afterCount: after.worktrees.length,
        branchPreserved: approval.branch,
        commitPreserved: approval.head,
      })
      atomicWriteJson(recordFile, record)
      console.log(JSON.stringify({ ...record, recordFile }, null, 2))
      console.log('Removal completed without force. No branch deletion, prune, clean, merge, push, or deployment was performed.')
    } catch (error) {
      Object.assign(record, { status: 'failed', failedAt: new Date().toISOString(), error: error instanceof Error ? error.message : String(error) })
      atomicWriteJson(recordFile, record)
      throw error
    }
  })
}

function parseCli(argv: string[]): { action: string; options: CliOptions } {
  const [action = 'help', ...args] = argv
  const options: CliOptions = { base: 'origin/main', tests: [], json: false, github: true, selectTests: false }
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    const nextValue = (): string => {
      const value = args[index + 1]
      if (!value || value.startsWith('--')) throw new Error(`${arg} requires a value`)
      index += 1
      return value
    }
    const inline = (name: string): string | null => arg.startsWith(`${name}=`) ? arg.slice(name.length + 1) : null
    const assign = (name: string): string | null => arg === name ? nextValue() : inline(name)
    let value: string | null
    if (arg === '--json') options.json = true
    else if (arg === '--no-github') options.github = false
    else if (arg === '--select-tests') options.selectTests = true
    else if ((value = assign('--base')) !== null) options.base = value
    else if ((value = assign('--path')) !== null) options.path = value
    else if ((value = assign('--report')) !== null) options.report = value
    else if ((value = assign('--test')) !== null) options.tests.push(...value.split(',').filter(Boolean))
    else if ((value = assign('--confirm')) !== null) options.confirm = value
    else if ((value = assign('--base-sha')) !== null) options.baseSha = value
    else if ((value = assign('--audit-token')) !== null) options.auditToken = value
    else if ((value = assign('--approval-id')) !== null) options.approvalId = value
    else if ((value = assign('--ttl-minutes')) !== null) options.ttlMinutes = Number(value)
    else if ((value = assign('--event')) !== null) options.event = value
    else throw new Error(`unknown option: ${arg}`)
  }
  return { action, options }
}

function usage(): string {
  return `Usage:
  npm run workflow:verify -- --select-tests [--test=test:<extra>] [--base=origin/main] [--report=/absolute/report.json]
  npm run workflow:lint-baseline
  npm run workflow:integration -- [--path=/absolute/worktree] [--base=origin/main] [--no-github] [--report=/absolute/report.json]
  npm run worktree:audit -- [--base=origin/main] [--json] [--report=/absolute/report.json]
  npm run workflow:hook -- [--path=/absolute/worktree] [--event=Stop|TaskCompleted]
  npm run worktree:approve -- --path=/canonical/absolute/path --confirm=/canonical/absolute/path --base-sha=<40-char SHA> --audit-token=<64-char token> [--ttl-minutes=10]
  npm run worktree:remove -- --path=/canonical/absolute/path --confirm=/canonical/absolute/path --approval-id=<48-char ID>

Audit is always a dry run. Approval and removal require separate trusted-terminal interaction. Approval is single-use and expires.
Local interactive presence is not identity authentication; non-interactive automatic deletion is refused.
Removal takes a Git-common-dir lock, performs two strict macOS re-audits, and refuses if any approval-bound fact changed.
This CLI never fetches, commits, merges, rebases, pushes, deploys, prunes, cleans, deletes branches, or uses force removal.`
}

function main(): void {
  try {
    const { action, options } = parseCli(process.argv.slice(2))
    if (action === 'audit') {
      const result = auditAll(options.base, options.path ?? process.cwd())
      maybeWriteReport(options.report, result)
      printAudit(result, options.json)
    } else if (action === 'verify') verify(options)
    else if (action === 'lint-baseline') generateLintBaseline(options)
    else if (action === 'integration') integrationStatus(options)
    else if (action === 'hook') hookStatus(options)
    else if (action === 'approve') authorizeWorktreeRemoval(options)
    else if (action === 'remove') removeWorktree(options)
    else if (action === 'help' || action === '--help' || action === '-h') console.log(usage())
    else throw new Error(`unknown command: ${action}\n${usage()}`)
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}

const invokedFile = process.argv[1] ? canonical(process.argv[1]) : ''
if (invokedFile === canonical(fileURLToPath(import.meta.url))) main()
