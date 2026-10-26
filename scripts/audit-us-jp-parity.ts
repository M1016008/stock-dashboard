import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const STATUS_FIELDS = [
  'jp', 'us', 'functional', 'visual', 'data', 'historical', 'responsive', 'performance',
] as const
const DETAIL_FIELDS = [
  'functional', 'visual', 'data', 'historical', 'responsive', 'performance',
] as const
const REQUIRED_STRING_FIELDS = [
  'wave', 'feature', ...STATUS_FIELDS, 'claude', 'codexQa', 'git', 'production', 'remaining',
] as const
const ALLOWED_PARITY = new Set([
  'IMPLEMENTED', 'PARTIAL', 'MISSING', 'NOT_APPLICABLE', 'BLOCKED', 'UNVERIFIED', 'IN_PROGRESS',
])
const IMMUTABLE_REVISION = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i
const EXTERNAL_EVIDENCE = /^EXTERNAL_EVIDENCE:[A-Za-z0-9][A-Za-z0-9._:/-]{7,}$/

type StatusField = (typeof STATUS_FIELDS)[number]
type FeatureEvidence = {
  claims: StatusField[]
  implementationPaths: string[]
  testPaths: string[]
}
type Feature = Record<string, unknown> & { evidence?: FeatureEvidence }
type Board = { schemaVersion: number; updatedAt: string; features: Feature[] }
type AuditIssue = { code: string; feature: string; field?: string; message: string }
type AuditResult = { issues: AuditIssue[]; counts: Map<string, number>; unresolved: Feature[] }

function text(feature: Feature, field: string): string {
  const value = feature[field]
  return typeof value === 'string' ? value.trim() : ''
}

function git(root: string, args: string[]): string {
  return execFileSync('git', ['-C', root, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()
}

function gitSucceeds(root: string, args: string[]): boolean {
  try {
    git(root, args)
    return true
  } catch {
    return false
  }
}

function isNone(value: string): boolean {
  return /^none(?:\b|[.;,:])/i.test(value.trim())
}

function normalizeEvidencePath(root: string, rawPath: unknown): { path?: string; error?: string } {
  if (typeof rawPath !== 'string' || !rawPath.trim()) return { error: 'must be a non-empty string' }
  const candidate = rawPath.trim()
  if (candidate.includes('\\') || candidate.includes('\0') || candidate.includes(':')) {
    return { error: `must be a portable repository-relative path: ${candidate}` }
  }
  if (path.posix.isAbsolute(candidate)) return { error: `must not be absolute: ${candidate}` }
  const normalized = path.posix.normalize(candidate)
  if (normalized === '..' || normalized.startsWith('../') || normalized === '.') {
    return { error: `escapes or does not identify a file in the repository: ${candidate}` }
  }
  const absolute = path.resolve(root, normalized)
  const relative = path.relative(root, absolute)
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    return { error: `escapes the repository: ${candidate}` }
  }
  return { path: normalized }
}

function validateEvidencePath(
  root: string,
  revision: string,
  featureName: string,
  field: 'implementationPaths' | 'testPaths',
  rawPath: unknown,
  issues: AuditIssue[],
): void {
  const normalized = normalizeEvidencePath(root, rawPath)
  if (!normalized.path) {
    issues.push({ code: 'EVIDENCE_PATH_INVALID', feature: featureName, field, message: normalized.error ?? 'invalid evidence path' })
    return
  }

  const repoPath = normalized.path
  const absolute = path.join(root, repoPath)
  if (!fs.existsSync(absolute)) {
    issues.push({ code: 'EVIDENCE_PATH_MISSING', feature: featureName, field, message: `${repoPath} does not exist in the current checkout` })
    return
  }
  if (!fs.lstatSync(absolute).isFile()) {
    issues.push({ code: 'EVIDENCE_PATH_NOT_FILE', feature: featureName, field, message: `${repoPath} is not a regular file` })
    return
  }
  if (!gitSucceeds(root, ['cat-file', '-e', `HEAD:${repoPath}`])) {
    issues.push({ code: 'EVIDENCE_PATH_UNTRACKED', feature: featureName, field, message: `${repoPath} is not tracked at HEAD` })
    return
  }

  if (IMMUTABLE_REVISION.test(revision)) {
    if (!gitSucceeds(root, ['cat-file', '-e', `${revision}:${repoPath}`])) {
      issues.push({ code: 'EVIDENCE_PATH_MISSING_AT_REVISION', feature: featureName, field, message: `${repoPath} does not exist at ${revision}` })
      return
    }
    const revisionBlob = git(root, ['rev-parse', `${revision}:${repoPath}`])
    const headBlob = git(root, ['rev-parse', `HEAD:${repoPath}`])
    if (revisionBlob !== headBlob) {
      issues.push({ code: 'EVIDENCE_PATH_STALE', feature: featureName, field, message: `${repoPath} changed after evidence revision ${revision}` })
    }
  }
}

function validateCrossFieldInvariants(feature: Feature, featureName: string, issues: AuditIssue[]): void {
  const us = text(feature, 'us')
  const details = DETAIL_FIELDS.map((field) => [field, text(feature, field)] as const)
  const incompleteDetails = details.filter(([, value]) => !['IMPLEMENTED', 'NOT_APPLICABLE'].includes(value))

  if (us === 'IMPLEMENTED' && text(feature, 'functional') !== 'IMPLEMENTED') {
    issues.push({ code: 'STATUS_INVARIANT', feature: featureName, field: 'functional', message: 'us=IMPLEMENTED requires functional=IMPLEMENTED' })
  }
  if (us === 'IMPLEMENTED') {
    for (const [field, value] of details) {
      if (['MISSING', 'BLOCKED', 'UNVERIFIED', 'IN_PROGRESS'].includes(value)) {
        issues.push({ code: 'STATUS_INVARIANT', feature: featureName, field, message: `us=IMPLEMENTED is incompatible with ${field}=${value}` })
      }
    }
  }
  if (us === 'PARTIAL' && incompleteDetails.length === 0) {
    issues.push({ code: 'STATUS_INVARIANT', feature: featureName, field: 'us', message: 'us=PARTIAL requires at least one incomplete detail' })
  }
  if (us === 'BLOCKED' && !details.some(([, value]) => value === 'BLOCKED')) {
    issues.push({ code: 'STATUS_INVARIANT', feature: featureName, field: 'us', message: 'us=BLOCKED requires at least one BLOCKED detail' })
  }
  if (us === 'NOT_APPLICABLE') {
    for (const [field, value] of details) {
      if (value !== 'NOT_APPLICABLE') {
        issues.push({ code: 'STATUS_INVARIANT', feature: featureName, field, message: `us=NOT_APPLICABLE requires ${field}=NOT_APPLICABLE` })
      }
    }
  }
  if (isNone(text(feature, 'remaining')) && incompleteDetails.length > 0) {
    issues.push({
      code: 'STATUS_INVARIANT', feature: featureName, field: 'remaining',
      message: `remaining cannot be None while ${incompleteDetails.map(([field, value]) => `${field}=${value}`).join(', ')}`,
    })
  }
  if (text(feature, 'production') === 'LIVE' && ['MISSING', 'BLOCKED', 'UNVERIFIED', 'IN_PROGRESS'].includes(us)) {
    issues.push({ code: 'STATUS_INVARIANT', feature: featureName, field: 'production', message: `production=LIVE is incompatible with us=${us}` })
  }
  if (text(feature, 'production') === 'NOT_APPLICABLE' && us !== 'NOT_APPLICABLE') {
    issues.push({ code: 'STATUS_INVARIANT', feature: featureName, field: 'production', message: 'production=NOT_APPLICABLE requires us=NOT_APPLICABLE' })
  }
  if (text(feature, 'codexQa') === 'PASS' && ['MISSING', 'UNVERIFIED', 'IN_PROGRESS'].includes(us)) {
    issues.push({ code: 'STATUS_INVARIANT', feature: featureName, field: 'codexQa', message: `codexQa=PASS is incompatible with us=${us}` })
  }
}

function validateFeatureEvidence(root: string, feature: Feature, featureName: string, issues: AuditIssue[]): void {
  const implementedClaims = STATUS_FIELDS.filter((field) => text(feature, field) === 'IMPLEMENTED')
  if (implementedClaims.length === 0) return

  const revision = text(feature, 'git')
  const external = EXTERNAL_EVIDENCE.test(revision)
  if (!IMMUTABLE_REVISION.test(revision) && !external) {
    issues.push({
      code: 'REVISION_IMMUTABLE_REQUIRED', feature: featureName, field: 'git',
      message: `git must be a full commit SHA or EXTERNAL_EVIDENCE:<stable-id>; received ${JSON.stringify(revision)}`,
    })
  } else if (!external) {
    if (!gitSucceeds(root, ['cat-file', '-e', `${revision}^{commit}`])) {
      issues.push({ code: 'REVISION_NOT_FOUND', feature: featureName, field: 'git', message: `${revision} is not a commit in this repository` })
    } else if (!gitSucceeds(root, ['merge-base', '--is-ancestor', revision, 'HEAD'])) {
      issues.push({ code: 'REVISION_NOT_ANCESTOR', feature: featureName, field: 'git', message: `${revision} is not an ancestor of HEAD` })
    }
  }

  const evidence = feature.evidence
  if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)) {
    issues.push({ code: 'EVIDENCE_MISSING', feature: featureName, field: 'evidence', message: `IMPLEMENTED claims require evidence for: ${implementedClaims.join(', ')}` })
    return
  }

  const claims = Array.isArray(evidence.claims) ? evidence.claims : []
  const invalidClaims = claims.filter((claim) => !STATUS_FIELDS.includes(claim as StatusField))
  for (const claim of invalidClaims) {
    issues.push({ code: 'EVIDENCE_CLAIM_INVALID', feature: featureName, field: 'evidence.claims', message: `${JSON.stringify(claim)} is not a parity status field` })
  }
  for (const claim of claims.filter((claim): claim is StatusField => STATUS_FIELDS.includes(claim as StatusField))) {
    if (text(feature, claim) !== 'IMPLEMENTED') {
      issues.push({ code: 'EVIDENCE_CLAIM_NOT_IMPLEMENTED', feature: featureName, field: `evidence.claims.${claim}`, message: `${claim} is covered by evidence but has status ${text(feature, claim)}` })
    }
  }
  for (const claim of implementedClaims) {
    if (!claims.includes(claim)) {
      issues.push({ code: 'EVIDENCE_CLAIM_UNCOVERED', feature: featureName, field: claim, message: `${claim}=IMPLEMENTED is not covered by evidence.claims` })
    }
  }

  for (const field of ['implementationPaths', 'testPaths'] as const) {
    const paths = evidence[field]
    if (!Array.isArray(paths) || paths.length === 0) {
      issues.push({ code: 'EVIDENCE_PATHS_MISSING', feature: featureName, field: `evidence.${field}`, message: `${field} must contain at least one repository file` })
      continue
    }
    const seen = new Set<string>()
    for (const evidencePath of paths) {
      const key = typeof evidencePath === 'string' ? evidencePath.trim() : JSON.stringify(evidencePath)
      if (seen.has(key)) {
        issues.push({ code: 'EVIDENCE_PATH_DUPLICATE', feature: featureName, field: `evidence.${field}`, message: `duplicate evidence path: ${key}` })
        continue
      }
      seen.add(key)
      validateEvidencePath(root, revision, featureName, field, evidencePath, issues)
    }
  }
}

export function auditBoard(board: Board, root: string): AuditResult {
  const issues: AuditIssue[] = []
  if (board.schemaVersion !== 1) {
    issues.push({ code: 'SCHEMA_VERSION', feature: '<board>', field: 'schemaVersion', message: `unsupported board schema: ${board.schemaVersion}` })
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(board.updatedAt)) {
    issues.push({ code: 'UPDATED_AT', feature: '<board>', field: 'updatedAt', message: 'updatedAt must be YYYY-MM-DD' })
  }
  if (!Array.isArray(board.features) || board.features.length === 0) {
    issues.push({ code: 'BOARD_EMPTY', feature: '<board>', field: 'features', message: 'parity board is empty' })
    return { issues, counts: new Map(), unresolved: [] }
  }

  const names = new Set<string>()
  for (const [index, feature] of board.features.entries()) {
    const fallbackName = `<feature ${index + 1}>`
    for (const field of REQUIRED_STRING_FIELDS) {
      if (!text(feature, field)) {
        issues.push({ code: 'REQUIRED_FIELD', feature: text(feature, 'feature') || fallbackName, field, message: `missing ${field}` })
      }
    }
    const featureName = text(feature, 'feature') || fallbackName
    if (names.has(featureName)) {
      issues.push({ code: 'FEATURE_DUPLICATE', feature: featureName, field: 'feature', message: `duplicate feature: ${featureName}` })
    }
    names.add(featureName)
    for (const field of STATUS_FIELDS) {
      const value = text(feature, field)
      if (!ALLOWED_PARITY.has(value)) {
        issues.push({ code: 'STATUS_INVALID', feature: featureName, field, message: `invalid ${field}=${value}` })
      }
    }
    validateCrossFieldInvariants(feature, featureName, issues)
    validateFeatureEvidence(root, feature, featureName, issues)
  }

  const counts = new Map<string, number>()
  for (const feature of board.features) {
    const status = text(feature, 'us')
    counts.set(status, (counts.get(status) ?? 0) + 1)
  }
  const unresolved = board.features.filter((feature) => !['IMPLEMENTED', 'NOT_APPLICABLE'].includes(text(feature, 'us')))
  return { issues, counts, unresolved }
}

function printResult(board: Board, result: AuditResult): void {
  console.log('US STOCKBOARD PARITY BOARD')
  console.log(`Updated: ${board.updatedAt}`)
  console.log(`Features: ${board.features.length}`)
  for (const status of ['IMPLEMENTED', 'PARTIAL', 'MISSING', 'BLOCKED', 'UNVERIFIED', 'NOT_APPLICABLE']) {
    console.log(`${status}: ${result.counts.get(status) ?? 0}`)
  }
  console.log(`Remaining: ${result.unresolved.length}`)
  for (const wave of [...new Set(board.features.map((feature) => text(feature, 'wave')))].sort()) {
    const rows = board.features.filter((feature) => text(feature, 'wave') === wave)
    if (!rows.length) continue
    const pending = rows.filter((feature) => !['IMPLEMENTED', 'NOT_APPLICABLE'].includes(text(feature, 'us')))
    console.log(`${wave}: ${rows.length - pending.length}/${rows.length} closed`)
  }

  if (result.issues.length === 0) {
    console.log('Audit: PASS')
    return
  }
  console.error(`Audit: FAIL (${result.issues.length} issues across ${new Set(result.issues.map((issue) => issue.feature)).size} rows)`)
  for (const issue of result.issues) {
    const field = issue.field ? ` [${issue.field}]` : ''
    console.error(`- ${issue.code} ${issue.feature}${field}: ${issue.message}`)
  }
}

function selfTest(): void {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stockboard-parity-audit-'))
  try {
    git(root, ['init', '-q'])
    git(root, ['config', 'user.email', 'parity-audit@example.invalid'])
    git(root, ['config', 'user.name', 'Parity Audit'])
    fs.mkdirSync(path.join(root, 'src'), { recursive: true })
    fs.mkdirSync(path.join(root, 'scripts'), { recursive: true })
    fs.writeFileSync(path.join(root, 'src', 'feature.ts'), 'export const feature = true\n')
    fs.writeFileSync(path.join(root, 'scripts', 'test-feature.ts'), 'export const tested = true\n')
    git(root, ['add', '.'])
    git(root, ['commit', '-qm', 'fixture evidence'])
    const evidenceRevision = git(root, ['rev-parse', 'HEAD'])

    const makeFeature = (): Feature => ({
      wave: 'W1', feature: 'Fixture feature', jp: 'IMPLEMENTED', us: 'IMPLEMENTED',
      functional: 'IMPLEMENTED', visual: 'IMPLEMENTED', data: 'IMPLEMENTED', historical: 'IMPLEMENTED',
      responsive: 'IMPLEMENTED', performance: 'IMPLEMENTED', claude: 'REVIEWED', codexQa: 'PASS',
      git: evidenceRevision, production: 'PENDING', remaining: 'None',
      evidence: {
        claims: [...STATUS_FIELDS],
        implementationPaths: ['src/feature.ts'],
        testPaths: ['scripts/test-feature.ts'],
      },
    })
    const makeBoard = (feature = makeFeature()): Board => ({ schemaVersion: 1, updatedAt: '2026-10-26', features: [feature] })
    const assertCodes = (label: string, board: Board, expected: string[]) => {
      const codes = auditBoard(board, root).issues.map((issue) => issue.code)
      for (const code of expected) {
        if (!codes.includes(code)) throw new Error(`${label}: expected ${code}; received ${codes.join(', ') || 'PASS'}`)
      }
    }
    if (auditBoard(makeBoard(), root).issues.length !== 0) throw new Error('valid fixture did not pass')

    const missing = makeFeature()
    missing.evidence = { ...missing.evidence!, implementationPaths: ['src/missing.ts'] }
    assertCodes('missing path', makeBoard(missing), ['EVIDENCE_PATH_MISSING'])

    const uncovered = makeFeature()
    uncovered.evidence = { ...uncovered.evidence!, claims: ['us', 'functional'] }
    assertCodes('uncovered claim', makeBoard(uncovered), ['EVIDENCE_CLAIM_UNCOVERED'])

    const mutable = makeFeature()
    mutable.git = 'MAIN'
    assertCodes('mutable revision', makeBoard(mutable), ['REVISION_IMMUTABLE_REQUIRED'])

    const invalidStatus = makeFeature()
    invalidStatus.us = 'IMPLEMENTED'
    invalidStatus.functional = 'BLOCKED'
    invalidStatus.remaining = 'None'
    invalidStatus.evidence = { ...invalidStatus.evidence!, claims: STATUS_FIELDS.filter((field) => field !== 'functional') }
    assertCodes('cross-field invariant', makeBoard(invalidStatus), ['STATUS_INVARIANT'])

    fs.writeFileSync(path.join(root, 'src', 'feature.ts'), 'export const feature = false\n')
    git(root, ['add', '.'])
    git(root, ['commit', '-qm', 'change implementation'])
    assertCodes('stale revision', makeBoard(), ['EVIDENCE_PATH_STALE'])

    const external = makeFeature()
    external.git = 'EXTERNAL_EVIDENCE:fixture-dashboard-2026-10-26'
    if (auditBoard(makeBoard(external), root).issues.length !== 0) throw new Error('external evidence fixture did not pass')
    console.log('US/JP parity auditor self-test: PASS (valid, missing, uncovered, mutable, invariant, stale, external)')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
}

function parseArgs(argv: string[]): { boardPath: string; root: string; selfTest: boolean } {
  let root = process.cwd()
  let boardPath = ''
  let runSelfTest = false
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--self-test') runSelfTest = true
    else if (arg === '--root') root = path.resolve(argv[++index] ?? '')
    else if (arg === '--board') boardPath = path.resolve(argv[++index] ?? '')
    else throw new Error(`Unknown argument: ${arg}`)
  }
  return { root, boardPath: boardPath || path.join(root, 'docs/us-stockboard-parity-board.json'), selfTest: runSelfTest }
}

const options = parseArgs(process.argv.slice(2))
if (options.selfTest) {
  selfTest()
} else {
  const board = JSON.parse(fs.readFileSync(options.boardPath, 'utf8')) as Board
  const result = auditBoard(board, options.root)
  printResult(board, result)
  if (result.issues.length > 0) process.exitCode = 1
}
