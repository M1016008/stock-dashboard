import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { jpOhlcvValueSha256, type JpOhlcvRepairPlan } from '@/lib/jp-ohlcv-local-repair'
import {
  STOCKBOARD_BUILD_MANIFEST_NAME,
  jpRepairCompiledTreeSha256,
  verifyStockboardBuildManifest,
} from '@/lib/jp-ohlcv-repair-runtime-manifest'
import type { LaunchdRuntimeIdentity } from '@/lib/storage/launchd-writer-hold-driver'
import { WEEKLY_BACKUP_WRITER_LABELS } from '@/lib/storage/weekly-backup-policy'
import type { WriterHoldDriver, WriterRuntimeIdentity } from '@/lib/storage/weekly-writer-hold'

// This module is preflight-only: it reads approval, evidence, the database
// (read-only), and launchd state, and never writes or holds anything.
export const JP_REPAIR_PRODUCTION_PREFLIGHT_ACTION = 'PREFLIGHT_JP_LOCAL_REPAIR'
export const JP_REPAIR_APPROVAL_MAXIMUM_VALIDITY_MS = 12 * 60 * 60 * 1_000

// Every service that can touch the database, in stop order. web-health comes
// first so it cannot kickstart the web server once that is stopped; then the
// online readers, then every known writer. us-earnings writes the database but
// is not a weekly backup writer, so it is added here. dev-capacity-monitor does
// not touch the database; it is listed so every loaded com.stockboard.* label
// is sealed by plist/program identity. Any loaded com.stockboard.* label
// outside the approved set holds the preflight. A future, separately approved
// executor must pass this list, in this order, to the existing
// withWeeklyWriterHold. No executor is implemented here.
export const JP_REPAIR_SERVICE_LABELS: readonly string[] = [
  'com.stockboard.web-health',
  'com.stockboard.web',
  'com.stockboard.analog-search',
  'com.stockboard.friend-readonly-gateway',
  ...WEEKLY_BACKUP_WRITER_LABELS,
  'com.stockboard.us-earnings',
  'com.stockboard.dev-capacity-monitor',
]
export const JP_REPAIR_SERVICE_LABEL_PREFIX = 'com.stockboard.'

// Services whose code interprets Trigger repair results: web (API and read
// model read the supersede semantics), update-latest (daily Trigger evaluation
// and notification composition via refresh-after-ohlcv), and
// data-freshness-guard (the new coverage classification). Their runtime must
// be the approved one, or the repaired database would be read by other code.
export const JP_REPAIR_TRIGGER_RUNTIME_LABELS: readonly string[] = [
  'com.stockboard.web',
  'com.stockboard.update-latest',
  'com.stockboard.data-freshness-guard',
]

// web serves a compiled .next-live build that can differ from its HEAD, so
// the whole compiled tree (not just BUILD_ID) is sealed as a TREE artifact at
// exactly <WorkingDirectory>/.next-live, in addition to the source tree. The
// sealed tree must carry the deploy script's STOCKBOARD_BUILD_MANIFEST.json
// naming the approved commit, runtime source tree, and its own BUILD_ID.
export const JP_REPAIR_RUNTIME_REQUIRED_TREES: Readonly<Record<string, string>> = {
  'com.stockboard.web': '.next-live',
}

// The three columns the Trigger repair needs. The preflight never applies
// them; it only checks the live state against the approved initial state.
export const JP_REPAIR_TRIGGER_SCHEMA_CONTRACT = 'jp-repair-trigger-columns-v1'
export const JP_REPAIR_TRIGGER_SCHEMA_COLUMNS = [
  ['trigger_evaluations', 'superseded_by_evaluation_id'],
  ['trigger_evaluation_batches', 'repair_key'],
  ['trigger_evaluation_batches', 'supersedes_batch_id'],
] as const

export const JP_REPAIR_REHEARSAL_STAGE_COUNT = 28

export const JP_REPAIR_PRODUCTION_LIMITATIONS = [
  'preflight only: no service is held and the production database is not written',
  'non-cooperative raw SQLite connections by the same OS user cannot be physically blocked',
] as const

const TERMINAL_BATCH_STATUSES = ['COMPLETED', 'COMPLETED_WITH_ERRORS']

// Logical database state the approval is bound to. The repair target date
// (e.g. 2026-07-17) is historical; Trigger re-evaluation runs at the derived
// as-of date, MAX(ohlcv_daily.date), so the DAILY batch is looked up there.
export type JpRepairDatabaseLogicalState = {
  latestJpOhlcvDate: string | null
  originalDailyBatch: { id: string; status: string; nonterminalOutboxCount: number } | null
  repairBatchPresent: boolean
  missingTriggerColumns: string[]
}

// FILE: sha256 of the file bytes. TREE: jpRepairCompiledTreeSha256 of a
// directory whose path is its own realpath.
export type JpRepairArtifact = { type: 'FILE' | 'TREE'; path: string; sha256: string }

// A Git worktree runtime is bound to its WorkingDirectory realpath, HEAD (the
// approved gitCommitSha), and
// the approved runtimeSourceTreeSha256 (clean, no untracked runtime files); an
// immutable runtime to artifact hashes. Both are also bound to their plist and
// program through `services`.
export type JpRepairRuntimeIdentity =
  | { label: string; kind: 'GIT_WORKTREE'; workingDirectory: string; gitHead: string; artifacts: JpRepairArtifact[] }
  | { label: string; kind: 'IMMUTABLE'; workingDirectory: string | null; artifacts: JpRepairArtifact[] }

export type JpRepairProductionApproval = {
  version: 3
  action: typeof JP_REPAIR_PRODUCTION_PREFLIGHT_ACTION
  operator: string
  approvedAt: string
  expiresAt: string
  gitCommitSha: string
  runtimeSourceTreeSha256: string
  // The repair key the Trigger re-evaluation writes; it must be the plan hash.
  repairKey: string
  database: {
    realpath: string
    dev: number
    inode: number
    latestJpOhlcvDate: string
    derivedAsOfDate: string
    originalDailyBatch: { id: string; status: string; nonterminalOutboxCount: 0 }
    repairBatchPresent: false
  }
  triggerSchema: {
    contract: typeof JP_REPAIR_TRIGGER_SCHEMA_CONTRACT
    initialState: 'APPLY_ALL_MISSING' | 'ALREADY_PRESENT'
  }
  storage: { volumeUuid: string }
  plan: { targetDate: string; approvalSha256: string; preservedConflictKeys: string[] }
  evidence: {
    providerContentSha256: string
    officialEvidenceSha256: string
    priceBasis: 'jquants-adjusted-ohlcv-v1'
    priceBasisEvidenceSha256: string
    corporateActionEvidenceSha256: string
  }
  // Files written by the final isolated rehearsal of this revision; the final
  // validation receipt is written by its validate-only run.
  rehearsal: {
    executionReceiptSha256: string
    validationReceiptSha256: string
    approvalPackageSha256: string
    finalValidationReceiptSha256: string
  }
  services: LaunchdRuntimeIdentity[]
  runtimes: JpRepairRuntimeIdentity[]
}

export type JpRepairServiceState = Pick<WriterRuntimeIdentity, 'label' | 'loaded' | 'disabled' | 'instances'>

export type JpRepairPreflightInput = {
  approvalPath: string
  expectedApprovalSha256: string
  databasePath: string
  officialEvidencePath: string
  priceBasisEvidencePath: string
  // validation-receipt.json, approval-package.json, and
  // final-validation-receipt.json sit beside it.
  rehearsalReceiptPath: string
  now: number
  gitCommitSha: () => string
  runtimeSourceTreeSha256: () => string
  inspectStorageVolumeUuid: () => string
  // Read-only: regenerates the plan from the live database and reports the
  // logical state.
  inspectDatabase: () => {
    plan: JpOhlcvRepairPlan
    logical: JpRepairDatabaseLogicalState
  }
  // Called only after the approval hash is verified.
  createServiceObserver: (services: readonly LaunchdRuntimeIdentity[]) => Pick<WriterHoldDriver, 'observe'>
  listLoadedServiceLabels: () => string[]
  // Called only for services whose plist identity was verified. For a Git
  // worktree, sourceTreeSha256 is jpRepairRuntimeSourceTreeSha256(cwd).
  inspectRuntime: (service: LaunchdRuntimeIdentity) => {
    workingDirectory: string | null
    gitHead: string | null
    sourceTreeSha256: string | null
  }
}

export type JpRepairPreflightResult = {
  verdict: 'PASS' | 'HOLD'
  holdReasons: string[]
  approvalSha256: string | null
  approval: JpRepairProductionApproval | null
  planApprovalSha256: string | null
  services: JpRepairServiceState[]
  limitations: readonly string[]
}

type SqliteReader = { prepare(sql: string): { get(...args: unknown[]): unknown } }

export function inspectJpRepairDatabaseLogicalState(db: SqliteReader): JpRepairDatabaseLogicalState {
  const latest = (db.prepare('SELECT MAX(date) AS date FROM ohlcv_daily').get() as { date: string | null }).date
  const original = db.prepare(
    "SELECT id, status FROM trigger_evaluation_batches WHERE source='DAILY' AND resolved_as_of=?",
  ).get(latest) as { id: string; status: string } | undefined
  const repair = db.prepare(
    "SELECT 1 AS present FROM trigger_evaluation_batches WHERE source='DAILY_REPAIR' AND resolved_as_of=?",
  ).get(latest)
  // Undelivered notifications of the original batch would be composed from
  // pre-repair evaluations; they must be resolved before the repair.
  const outbox = original ? db.prepare(
    "SELECT COUNT(*) AS count FROM notification_outbox WHERE batch_id=? AND status NOT IN ('SENT','CANCELLED')",
  ).get(original.id) as { count: number } : null
  return {
    latestJpOhlcvDate: latest,
    originalDailyBatch: original && outbox
      ? { id: original.id, status: original.status, nonterminalOutboxCount: Number(outbox.count) }
      : null,
    repairBatchPresent: Boolean(repair),
    missingTriggerColumns: JP_REPAIR_TRIGGER_SCHEMA_COLUMNS
      .filter(([table, column]) => !db.prepare('SELECT 1 FROM pragma_table_info(?) WHERE name=?').get(table, column))
      .map(([table, column]) => `${table}.${column}`),
  }
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

const SHA256 = /^[0-9a-f]{64}$/
const GIT_COMMIT = /^[0-9a-f]{40}$/

export const JP_REPAIR_FINAL_VALIDATION_RECEIPT_NAME = 'final-validation-receipt.json'

// Written by the rehearsal's validate-only PASS. Deterministic (no timestamps)
// so a rerun reproduces it byte for byte.
export type JpRepairFinalValidationReceipt = {
  version: 1
  status: 'PASS'
  gitCommitSha: string
  sourceTreeSha256: string
  repairPlan: { path: string; sha256: string; approvalSha256: string }
  executionReceiptSha256: string
  validationReceiptSha256: string
  approvalPackageSha256: string
  source: unknown
  sourcePhase: 'derived_complete'
  stages: Array<{ name: string; status: string }>
  databaseIdentity: unknown
  analogIdentity: unknown
}

// The rehearsal captures HEAD once, in the execution receipt at
// initialization. A resumed or validate-only run must be at that commit.
export function assertJpRepairExecutionCommit(receipt: { gitCommitSha?: unknown }, currentGitCommitSha: string): string {
  const commit = receipt.gitCommitSha
  if (typeof commit !== 'string' || !GIT_COMMIT.test(commit)) {
    throw new Error('execution receipt has no captured Git commit; rerun with --reset')
  }
  if (commit !== currentGitCommitSha) {
    throw new Error('HEAD differs from the commit captured in the execution receipt; rerun with --reset')
  }
  return commit
}

// Reads repair-plan.json once and checks it is the plan the approval package
// names: same realpath, byte hash, and approvalSha256.
export function verifyJpRepairPlanBinding(
  planPath: string,
  bound: { path?: string; sha256?: string; approvalSha256?: string } | undefined,
  expectedApprovalSha256: string | undefined,
): { binding: JpRepairFinalValidationReceipt['repairPlan']; plan: JpOhlcvRepairPlan } {
  const realpath = fs.realpathSync(planPath)
  const bytes = fs.readFileSync(realpath)
  const plan = JSON.parse(bytes.toString('utf8')) as JpOhlcvRepairPlan
  const binding = { path: realpath, sha256: sha256(bytes), approvalSha256: plan.approvalSha256 }
  if (!SHA256.test(plan.approvalSha256 ?? '') || plan.approvalSha256 !== expectedApprovalSha256
      || bound?.path !== binding.path || bound.sha256 !== binding.sha256
      || bound.approvalSha256 !== binding.approvalSha256) {
    throw new Error('repair plan is not the plan bound by the approval package')
  }
  return { binding, plan }
}

// Returns false when no final receipt exists yet. An existing one must equal
// this validation's receipt exactly; it is never overwritten.
export function verifyExistingJpRepairFinalValidationReceipt(
  filePath: string,
  receipt: JpRepairFinalValidationReceipt,
): boolean {
  // The checked file and the read bytes come from one no-follow descriptor.
  let descriptor: number
  try {
    descriptor = fs.openSync(filePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return false
    if (code === 'ELOOP') throw new Error('final validation receipt is not a regular file')
    throw error
  }
  try {
    if (!fs.fstatSync(descriptor).isFile()) throw new Error('final validation receipt is not a regular file')
    if (!fs.readFileSync(descriptor).equals(Buffer.from(`${JSON.stringify(receipt, null, 2)}\n`))) {
      throw new Error('final validation receipt differs from this validation; it was changed or substituted')
    }
  } finally {
    fs.closeSync(descriptor)
  }
  return true
}

export function corporateActionEvidenceSha256(report: { providerAudit?: unknown }): string {
  if (!report.providerAudit || typeof report.providerAudit !== 'object') {
    throw new Error('price basis report has no provider/corporate-action audit')
  }
  return jpOhlcvValueSha256(report.providerAudit)
}

type PriceBasisReport = {
  status?: string
  targetDate?: string
  priceBasis?: string
  providerAudit?: unknown
  classification?: { approvedMissingKeysSha256?: string }
}

export async function preflightJpRepairProduction(input: JpRepairPreflightInput): Promise<JpRepairPreflightResult> {
  const holdReasons: string[] = []
  const check = async (code: string, body: () => void | Promise<void>): Promise<void> => {
    try { await body() } catch (error) { holdReasons.push(`${code}:${message(error)}`) }
  }
  const result = (approvalSha256: string | null, approval: JpRepairProductionApproval | null,
    planApprovalSha256: string | null, services: JpRepairServiceState[]): JpRepairPreflightResult => ({
    verdict: holdReasons.length === 0 ? 'PASS' : 'HOLD',
    holdReasons,
    approvalSha256,
    approval,
    planApprovalSha256,
    services,
    limitations: JP_REPAIR_PRODUCTION_LIMITATIONS,
  })

  // Nothing derived from the approval (plist paths, artifact paths, launchd
  // labels) is read or executed until its bytes match the operator's hash.
  const loaded: { sha256: string | null; approval: JpRepairProductionApproval | null } = {
    sha256: null, approval: null,
  }
  const bytes: { value: Buffer | null } = { value: null }
  await check('APPROVAL_UNREADABLE', () => {
    bytes.value = fs.readFileSync(input.approvalPath)
    loaded.sha256 = sha256(bytes.value)
    if (!SHA256.test(input.expectedApprovalSha256) || loaded.sha256 !== input.expectedApprovalSha256) {
      holdReasons.push('APPROVAL_TAMPERED:approval file hash differs from the operator-supplied hash')
      bytes.value = null
    }
  })
  // A hash-verified file can still hold null, a primitive, or an array; only
  // a plain JSON object is an approval.
  if (bytes.value) {
    await check('APPROVAL_INVALID', () => {
      const parsed: unknown = JSON.parse(bytes.value!.toString('utf8'))
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('approval is not a JSON object')
      }
      loaded.approval = parsed as JpRepairProductionApproval
    })
  }
  const approvalSha256 = loaded.sha256
  const approved = loaded.approval
  if (!approved || !approvalSha256) {
    if (holdReasons.length === 0) holdReasons.push('APPROVAL_INVALID:approval was not loaded')
    return result(approvalSha256, null, null, [])
  }
  await check('APPROVAL_INVALID', () => {
    if (approved.version !== 3) throw new Error('unsupported approval version')
    if (approved.action !== JP_REPAIR_PRODUCTION_PREFLIGHT_ACTION) throw new Error('unknown approval action')
    if (typeof approved.operator !== 'string' || !approved.operator.trim() || approved.operator.length > 128) {
      throw new Error('operator is required')
    }
  })
  await check('APPROVAL_EXPIRED', () => {
    const approvedAt = Date.parse(approved.approvedAt)
    const expiresAt = Date.parse(approved.expiresAt)
    if (!Number.isFinite(approvedAt) || !Number.isFinite(expiresAt)) throw new Error('approval timestamps are invalid')
    if (approvedAt > input.now) throw new Error('approval is dated in the future')
    if (expiresAt - approvedAt > JP_REPAIR_APPROVAL_MAXIMUM_VALIDITY_MS || expiresAt <= approvedAt) {
      throw new Error('approval validity window is invalid')
    }
    if (input.now >= expiresAt) throw new Error(`approval expired at ${approved.expiresAt}`)
  })
  await check('GIT_REVISION_MISMATCH', () => {
    if (input.gitCommitSha() !== approved.gitCommitSha) throw new Error('HEAD differs from the approved commit')
  })
  await check('RUNTIME_SOURCE_MISMATCH', () => {
    if (input.runtimeSourceTreeSha256() !== approved.runtimeSourceTreeSha256) {
      throw new Error('runtime source tree differs from the approved manifest')
    }
  })
  // Identity only: mtime/size of a live WAL database are volatile and not bound.
  await check('DATABASE_IDENTITY_MISMATCH', () => {
    const realpath = fs.realpathSync(input.databasePath)
    const stat = fs.lstatSync(realpath)
    if (realpath !== approved.database?.realpath || !stat.isFile() || stat.nlink !== 1
        || Number(stat.dev) !== approved.database.dev || Number(stat.ino) !== approved.database.inode) {
      throw new Error('database file identity differs from the approval')
    }
    for (const suffix of ['-wal', '-shm']) {
      // lstat, not exists: a dangling symlink must fail rather than be skipped.
      const companionStat = fs.lstatSync(`${realpath}${suffix}`, { throwIfNoEntry: false })
      if (!companionStat) continue
      if (!companionStat.isFile() || companionStat.nlink !== 1 || Number(companionStat.dev) !== approved.database.dev) {
        throw new Error(`${suffix} is not a single-link regular file on the approved device`)
      }
    }
  })
  await check('STORAGE_GUARD', () => {
    const uuid = input.inspectStorageVolumeUuid()
    if (!approved.storage?.volumeUuid || uuid.toUpperCase() !== approved.storage.volumeUuid.toUpperCase()) {
      throw new Error('storage volume differs from the approval')
    }
  })
  // Each evidence file is read once; its hash and its parsed content come
  // from the same bytes.
  const priceBasis: { report: PriceBasisReport | null } = { report: null }
  await check('EVIDENCE_MISMATCH', () => {
    const evidence = approved.evidence
    const officialBytes = fs.readFileSync(input.officialEvidencePath)
    if (sha256(officialBytes) !== evidence?.officialEvidenceSha256) {
      throw new Error('official evidence hash differs')
    }
    const official = JSON.parse(officialBytes.toString('utf8')) as {
      date?: string
      priceBasis?: string
      sourceContract?: { contentSha256?: string }
    }
    if (official.sourceContract?.contentSha256 !== evidence.providerContentSha256) {
      throw new Error('provider content hash differs')
    }
    if (official.priceBasis !== evidence.priceBasis || official.date !== approved.plan?.targetDate) {
      throw new Error('official price basis or target date differs')
    }
    const reportBytes = fs.readFileSync(input.priceBasisEvidencePath)
    if (sha256(reportBytes) !== evidence.priceBasisEvidenceSha256) {
      throw new Error('price basis evidence hash differs')
    }
    const report = JSON.parse(reportBytes.toString('utf8')) as PriceBasisReport
    if (report.status !== 'PASS' || report.targetDate !== official.date || report.priceBasis !== official.priceBasis) {
      throw new Error('price basis evidence does not pass for the approved target')
    }
    if (corporateActionEvidenceSha256(report) !== evidence.corporateActionEvidenceSha256) {
      throw new Error('corporate-action evidence hash differs')
    }
    priceBasis.report = report
  })

  const inspected: { value: ReturnType<JpRepairPreflightInput['inspectDatabase']> | null } = { value: null }
  await check('PLAN_DRIFT', () => {
    const value = input.inspectDatabase()
    inspected.value = value
    if (value.plan.approvalSha256 !== approved.plan?.approvalSha256
        || value.plan.targetDate !== approved.plan.targetDate
        || JSON.stringify(value.plan.preservedConflictKeys)
          !== JSON.stringify([...(approved.plan.preservedConflictKeys ?? [])].sort())) {
      throw new Error('regenerated repair plan differs from the approved plan')
    }
    // Unverified evidence already holds as EVIDENCE_MISMATCH.
    if (priceBasis.report && priceBasis.report.classification?.approvedMissingKeysSha256
        !== jpOhlcvValueSha256([...value.plan.approvedMissingKeys].sort())) {
      throw new Error('price basis evidence is not bound to the regenerated plan')
    }
  })
  await check('DATABASE_LOGICAL_DRIFT', () => {
    const logical = inspected.value?.logical
    const database = approved.database
    if (!logical) throw new Error('database logical state was not inspected')
    if (!logical.latestJpOhlcvDate || logical.latestJpOhlcvDate !== database?.latestJpOhlcvDate
        || database.derivedAsOfDate !== logical.latestJpOhlcvDate) {
      throw new Error('latest JP OHLCV / derived as-of date differs from the approval')
    }
    const original = logical.originalDailyBatch
    if (!original || !TERMINAL_BATCH_STATUSES.includes(original.status)
        || original.id !== database.originalDailyBatch?.id || original.status !== database.originalDailyBatch.status) {
      throw new Error('original DAILY batch at the derived as-of date differs or is not terminal')
    }
    if (database.repairBatchPresent !== false || logical.repairBatchPresent) {
      throw new Error('a DAILY_REPAIR batch already exists for the derived as-of date')
    }
  })
  // Pending notifications are never silently suppressed: they must be sent
  // or cancelled by their owner before the approval is made.
  await check('NOTIFICATION_OUTBOX_PENDING', () => {
    // A missing batch already holds as DATABASE_LOGICAL_DRIFT.
    const count = inspected.value?.logical.originalDailyBatch?.nonterminalOutboxCount ?? 0
    if (count !== 0 || approved.database?.originalDailyBatch?.nonterminalOutboxCount !== 0) {
      throw new Error(`original DAILY batch has ${count} outbox rows that are not SENT or CANCELLED`)
    }
  })
  // PLAN_DRIFT already binds the approved plan hash to the regenerated one.
  await check('REPAIR_KEY_MISMATCH', () => {
    if (!SHA256.test(approved.repairKey ?? '') || approved.repairKey !== approved.plan?.approvalSha256) {
      throw new Error('repairKey must equal the approved plan approvalSha256')
    }
  })
  await check('SCHEMA_CONTRACT_MISMATCH', () => {
    const missing = inspected.value?.logical.missingTriggerColumns
    const contract = approved.triggerSchema
    if (!missing || contract?.contract !== JP_REPAIR_TRIGGER_SCHEMA_CONTRACT) {
      throw new Error('trigger schema contract is missing or of another version')
    }
    const state = missing.length === JP_REPAIR_TRIGGER_SCHEMA_COLUMNS.length ? 'APPLY_ALL_MISSING'
      : missing.length === 0 ? 'ALREADY_PRESENT' : `PARTIAL:${missing.join(',')}`
    if (state !== contract.initialState) {
      throw new Error(`trigger schema is ${state}; approved ${String(contract.initialState)}`)
    }
  })
  await check('REHEARSAL_RECEIPT_MISMATCH', () => verifyRehearsalReceipts(input, approved))

  // Non-array lists hold as SERVICE_SET_MISMATCH / RUNTIME_SET_MISMATCH.
  const approvedServices = Array.isArray(approved.services) ? approved.services : []
  const approvedRuntimes = Array.isArray(approved.runtimes) ? approved.runtimes : []
  const services: JpRepairServiceState[] = []
  await check('SERVICE_SET_MISMATCH', () => {
    const labels = approvedServices.map((service) => service?.label)
    if (JSON.stringify(labels) !== JSON.stringify(JP_REPAIR_SERVICE_LABELS)) {
      throw new Error(`approval must list exactly the ${JP_REPAIR_SERVICE_LABELS.length} services in stop order`)
    }
  })
  await check('UNKNOWN_LOADED_SERVICE', () => {
    const stopped = new Set(approvedServices.map((service) => service?.label))
    const unknown = input.listLoadedServiceLabels()
      .filter((label) => label.startsWith(JP_REPAIR_SERVICE_LABEL_PREFIX) && !stopped.has(label))
    if (unknown.length > 0) throw new Error(unknown.join(','))
  })
  const verified = new Map<string, LaunchdRuntimeIdentity>()
  const observer = input.createServiceObserver(approvedServices)
  for (const service of approvedServices) {
    await check('SERVICE_IDENTITY_MISMATCH', async () => {
      const observed = await observer.observe(service.label)
      if (observed.definitionSha256 !== service.definitionSha256 || observed.program !== service.program) {
        throw new Error(service.label)
      }
      if (observed.disabled && observed.loaded) throw new Error(`${service.label} is disabled but loaded`)
      verified.set(service.label, service)
      services.push({
        label: service.label, loaded: observed.loaded, disabled: observed.disabled, instances: observed.instances,
      })
    })
  }
  await check('RUNTIME_SET_MISMATCH', () => {
    const labels = approvedRuntimes.map((runtime) => runtime?.label)
    if (JSON.stringify(labels) !== JSON.stringify(JP_REPAIR_TRIGGER_RUNTIME_LABELS)) {
      throw new Error(`approval must bind exactly the runtimes of ${JP_REPAIR_TRIGGER_RUNTIME_LABELS.join(',')}`)
    }
  })
  for (const runtime of approvedRuntimes) {
    await check('RUNTIME_IDENTITY_MISMATCH', () => {
      const service = verified.get(runtime.label)
      if (!service) throw new Error(`${runtime.label}: plist identity is not verified`)
      const observed = input.inspectRuntime(service)
      if (observed.workingDirectory !== runtime.workingDirectory) {
        throw new Error(`${runtime.label}: WorkingDirectory differs`)
      }
      if (runtime.kind === 'GIT_WORKTREE') {
        if (!/^[0-9a-f]{40}$/.test(runtime.gitHead ?? '') || runtime.gitHead !== approved.gitCommitSha
            || observed.gitHead !== runtime.gitHead) {
          throw new Error(`${runtime.label}: HEAD differs from the approved commit`)
        }
        if (observed.sourceTreeSha256 !== approved.runtimeSourceTreeSha256) {
          throw new Error(`${runtime.label}: runtime source tree differs from the approved manifest`)
        }
      } else if (runtime.kind !== 'IMMUTABLE' || !(runtime.artifacts?.length > 0)) {
        throw new Error(`${runtime.label}: an immutable runtime must bind at least one artifact`)
      }
      const required = JP_REPAIR_RUNTIME_REQUIRED_TREES[runtime.label]
      if (required && !(runtime.workingDirectory && (runtime.artifacts ?? []).some((artifact) =>
        artifact.type === 'TREE' && artifact.path === path.join(runtime.workingDirectory!, required)))) {
        throw new Error(`${runtime.label}: ${required} must be sealed as a TREE artifact`)
      }
      for (const artifact of runtime.artifacts ?? []) {
        const actual = !path.isAbsolute(artifact.path) ? null
          : artifact.type === 'FILE' ? sha256(fs.readFileSync(artifact.path))
            : artifact.type === 'TREE' ? jpRepairCompiledTreeSha256(artifact.path) : null
        if (!SHA256.test(artifact.sha256 ?? '') || actual !== artifact.sha256) {
          throw new Error(`${runtime.label}: ${String(artifact.type)} artifact ${artifact.path} differs`)
        }
      }
      if (required) {
        try {
          verifyStockboardBuildManifest(path.join(runtime.workingDirectory!, required), approved)
        } catch (error) {
          throw new Error(`${runtime.label}: ${required}/${STOCKBOARD_BUILD_MANIFEST_NAME}: ${message(error)}`)
        }
      }
    })
  }
  return result(approvalSha256, approved, inspected.value?.plan.approvalSha256 ?? null, services)
}

type RehearsalStage = { name?: string; status?: string }
type RehearsalSource = { approvalSha256?: string }
type DatabaseContentIdentity = { database?: { realpath?: string; inode?: number; sha256?: string }; walBytes?: number }

function assertPassingStages(stages: RehearsalStage[] | undefined, owner: string): string[] {
  const names = (stages ?? []).map((stage) => stage.name ?? '')
  if (names.length !== JP_REPAIR_REHEARSAL_STAGE_COUNT || new Set(names).size !== names.length
      || (stages ?? []).some((stage) => stage.status !== 'PASS')) {
    throw new Error(`${owner} must have ${JP_REPAIR_REHEARSAL_STAGE_COUNT} distinct passing stages`)
  }
  return names
}

function assertContentIdentity(identity: DatabaseContentIdentity | undefined, owner: string): void {
  if (!identity?.database?.realpath || !Number.isInteger(identity.database.inode)
      || !SHA256.test(identity.database.sha256 ?? '') || identity.walBytes !== 0) {
    throw new Error(`${owner} database identity is missing or not sealed`)
  }
}

// Reads the final rehearsal's four receipts (schema of
// scripts/rehearse-jp-local-repair-derived.ts) and checks they are this
// revision's, PASS, and cross-linked. The rehearsal ran on an isolated copy,
// so its database identity is never compared byte-for-byte with production.
function verifyRehearsalReceipts(input: JpRepairPreflightInput, approved: JpRepairProductionApproval): void {
  const bound = approved.rehearsal
  const directory = path.dirname(input.rehearsalReceiptPath)
  const read = <T>(file: string, expected: string | undefined): { sha256: string; value: T } => {
    const bytes = fs.readFileSync(file)
    const digest = sha256(bytes)
    if (!SHA256.test(expected ?? '') || digest !== expected) throw new Error(`${path.basename(file)} hash differs`)
    return { sha256: digest, value: JSON.parse(bytes.toString('utf8')) as T }
  }
  const execution = read<{
    status?: string
    gitCommitSha?: string
    sourceTreeSha256?: string
    source?: RehearsalSource
    stages?: RehearsalStage[]
    approvalPackageSha256?: string
  }>(input.rehearsalReceiptPath, bound?.executionReceiptSha256)
  const validation = read<{
    version?: number
    status?: string
    gitCommitSha?: string
    sourceTreeSha256?: string
    executionReceiptSha256?: string
    approvalPackageSha256?: string
    source?: RehearsalSource
    stageCount?: number
    sourcePhase?: string
    databaseIdentity?: DatabaseContentIdentity
    analogIdentity?: DatabaseContentIdentity
  }>(path.join(directory, 'validation-receipt.json'), bound?.validationReceiptSha256)
  const approvalPackage = read<{
    version?: number
    status?: string
    gitCommitSha?: string
    sourceTreeSha256?: string
    providerContentSha256?: string
    officialEvidence?: { sha256?: string }
    repairPlan?: { path?: string; sha256?: string; approvalSha256?: string }
    sourceIdentity?: RehearsalSource
    stages?: RehearsalStage[]
    databaseIdentity?: { database?: { realpath?: string; inode?: number } }
  }>(path.join(directory, 'approval-package.json'), bound?.approvalPackageSha256)
  const final = read<{
    version?: number
    status?: string
    gitCommitSha?: string
    sourceTreeSha256?: string
    repairPlan?: { path?: string; sha256?: string; approvalSha256?: string }
    executionReceiptSha256?: string
    validationReceiptSha256?: string
    approvalPackageSha256?: string
    source?: RehearsalSource
    sourcePhase?: string
    stages?: RehearsalStage[]
    databaseIdentity?: unknown
    analogIdentity?: unknown
  }>(path.join(directory, JP_REPAIR_FINAL_VALIDATION_RECEIPT_NAME), bound?.finalValidationReceiptSha256)

  const names = assertPassingStages(execution.value.stages, 'execution receipt')
  for (const [owner, stages] of [['approval package', approvalPackage.value.stages],
    ['final validation receipt', final.value.stages]] as const) {
    if (JSON.stringify(assertPassingStages(stages, owner)) !== JSON.stringify(names)) {
      throw new Error(`${owner} stages differ from the execution receipt`)
    }
  }
  for (const [owner, value] of [['execution receipt', execution.value], ['validation receipt', validation.value],
    ['approval package', approvalPackage.value], ['final validation receipt', final.value]] as const) {
    if (value.status !== 'PASS') throw new Error(`${owner} status is ${String(value.status)}`)
    if (value.sourceTreeSha256 !== approved.runtimeSourceTreeSha256) {
      throw new Error(`${owner} is from another runtime source tree`)
    }
  }
  if (validation.value.version !== 1 || approvalPackage.value.version !== 1 || final.value.version !== 1
      || execution.value.gitCommitSha !== approved.gitCommitSha
      || validation.value.gitCommitSha !== approved.gitCommitSha
      || approvalPackage.value.gitCommitSha !== approved.gitCommitSha
      || final.value.gitCommitSha !== approved.gitCommitSha) {
    throw new Error('rehearsal receipts are from another revision')
  }
  if (execution.value.approvalPackageSha256 !== approvalPackage.sha256
      || validation.value.approvalPackageSha256 !== approvalPackage.sha256
      || validation.value.executionReceiptSha256 !== execution.sha256
      || validation.value.stageCount !== names.length
      || validation.value.sourcePhase !== 'derived_complete'
      || JSON.stringify(validation.value.source) !== JSON.stringify(execution.value.source)
      || JSON.stringify(approvalPackage.value.sourceIdentity) !== JSON.stringify(execution.value.source)
      || final.value.executionReceiptSha256 !== execution.sha256
      || final.value.validationReceiptSha256 !== validation.sha256
      || final.value.approvalPackageSha256 !== approvalPackage.sha256
      || final.value.sourcePhase !== 'derived_complete'
      || JSON.stringify(final.value.source) !== JSON.stringify(execution.value.source)) {
    throw new Error('rehearsal receipts do not reference each other')
  }
  // The plan file itself stays with the rehearsal; its binding must agree.
  const plan = approvalPackage.value.repairPlan
  const finalPlan = final.value.repairPlan
  if (execution.value.source?.approvalSha256 !== approved.plan?.approvalSha256
      || plan?.approvalSha256 !== approved.plan?.approvalSha256
      || !plan?.path || !SHA256.test(plan?.sha256 ?? '')
      || finalPlan?.path !== plan?.path || finalPlan?.sha256 !== plan?.sha256
      || finalPlan?.approvalSha256 !== plan?.approvalSha256
      || approvalPackage.value.providerContentSha256 !== approved.evidence?.providerContentSha256
      || approvalPackage.value.officialEvidence?.sha256 !== approved.evidence?.officialEvidenceSha256) {
    throw new Error('rehearsal receipts are for another plan or evidence')
  }
  assertContentIdentity(validation.value.databaseIdentity, 'validation')
  assertContentIdentity(validation.value.analogIdentity, 'validation analog')
  const rehearsed = validation.value.databaseIdentity!.database!
  const packaged = approvalPackage.value.databaseIdentity?.database
  if (!packaged || packaged.realpath !== rehearsed.realpath || packaged.inode !== rehearsed.inode
      || JSON.stringify(final.value.databaseIdentity) !== JSON.stringify(validation.value.databaseIdentity)
      || JSON.stringify(final.value.analogIdentity) !== JSON.stringify(validation.value.analogIdentity)) {
    throw new Error('rehearsal receipts disagree on the rehearsal database identity')
  }
  if (rehearsed.realpath === fs.realpathSync(input.databasePath)) {
    throw new Error('the rehearsal ran on the production database, not an isolated copy')
  }
}
