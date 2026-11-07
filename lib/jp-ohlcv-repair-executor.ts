import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  assertBoundFile,
  isJpRepairAbsentService,
  type JpRepairFileBinding,
  type JpRepairPreflightResult,
  type JpRepairProductionApproval,
} from '@/lib/jp-ohlcv-repair-production'
import {
  JP_REPAIR_ANALOG_CONTRACT,
  JP_REPAIR_MAIN_BASENAME,
  JP_REPAIR_SERVING_CACHE_BASENAME,
} from '@/lib/jp-ohlcv-repair-stage-environment'
import type { LaunchdRuntimeIdentity } from '@/lib/storage/launchd-writer-hold-driver'
import { WriterHoldError, withWeeklyWriterHold, type WriterHoldDriver } from '@/lib/storage/weekly-writer-hold'

// The executor is a gate and a seam, not a workflow. It decides whether the
// injected `workflow` may start, holds the approved writers around it, and pins
// a restart to the exact revision, plan, and database identities. The real
// workflow is `jpRepairRehearsalWorkflow` (scripts/rehearse-jp-local-repair-derived.ts):
// the existing repair transaction and 28-stage run, whose rehearsal receipt is
// the only stage checkpoint. The executor implements no stages, receipts, or
// recovery. Execution is only possible on an isolated temporary root; there is
// no production execution path and no bypass.
//
// SYNTHETIC ONLY. Nothing here proves the physical maintenance boundary exists:
// the C-min/B2 verifier has not run for Production and no approval field names
// one. B2 evidence is therefore accepted only when it declares the synthetic
// fixture method, every PASS (dry run included) requires an isolated temporary
// root, and every result carries `productionReady: false`. Hand-written JSON
// cannot make this gate Production-ready; that needs a real verifier identity.
export const JP_REPAIR_B2_BOUNDARY = 'B2_PHYSICAL_EXCLUSION'
export const JP_REPAIR_B2_SYNTHETIC_METHOD = 'SYNTHETIC_ISOLATED_FIXTURE'
export const JP_REPAIR_EXECUTOR_BINDING_NAME = 'executor-binding.json'

// Written by the physical-maintenance-boundary verification (C-min/B2), which
// has not been performed for Production. A PASS must name this exact approval
// and these exact database identities.
export type JpRepairB2Evidence = {
  version: 1
  boundary: typeof JP_REPAIR_B2_BOUNDARY
  status: 'PASS'
  method: typeof JP_REPAIR_B2_SYNTHETIC_METHOD
  approvalSha256: string
  gitCommitSha: string
  planApprovalSha256: string
  databases: { main: JpRepairFileBinding; analog: JpRepairFileBinding; servingCache: JpRepairFileBinding }
}

export type JpRepairExecutionTargets = { database: string; analog: string; servingCache: string }

export type JpRepairExecutorInput<T> = {
  mode: 'DRY_RUN' | 'EXECUTE_ISOLATED'
  // The existing preflight, run unchanged; anything but PASS holds.
  preflight: () => Promise<JpRepairPreflightResult>
  targets: JpRepairExecutionTargets
  b2?: { evidencePath: string; expectedSha256: string }
  // EXECUTE_ISOLATED only: every target and the checkpoint directory must be
  // inside this temporary directory.
  isolatedRoot?: string
  checkpointDirectory?: string
  revision: { sourceTreeSha256: string; nodeModulesLockSha256: string }
  hold?: { driver: WriterHoldDriver; maximumHoldMs: number }
  workflow: (context: JpRepairWorkflowContext) => Promise<T>
}

export type JpRepairWorkflowContext = {
  checkpointDirectory: string
  // The workflow must bind its own checkpoint to this and refuse any other.
  bindingSha256: string
  targets: JpRepairExecutionTargets
  assertHoldValid: () => Promise<void>
}

export type JpRepairExecutorResult<T> = {
  verdict: 'PASS' | 'HOLD' | 'FAILED'
  // Always false: PASS means the synthetic gate passed, never Production readiness.
  productionReady: false
  mode: JpRepairExecutorInput<T>['mode']
  holdReasons: string[]
  // True once the workflow was entered. Nothing is cleaned up on failure: the
  // derived_pending state and the checkpoint evidence stay for the restart.
  workflowStarted: boolean
  result?: T
}

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex')
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function within(root: string, file: string): boolean {
  return file === root || file.startsWith(`${root}${path.sep}`)
}

// The isolated root must be a real temporary directory, never an external
// volume (OWC or otherwise), and every target must resolve inside it.
export function assertJpRepairIsolatedTargets(
  isolatedRoot: string,
  files: readonly string[],
): void {
  // Checked on the literal paths first: an unmounted /Volumes/OWC* path must
  // be rejected as external, not as a missing file.
  for (const file of [isolatedRoot, ...files]) {
    if (path.resolve(file).startsWith('/Volumes/')) throw new Error(`external-volume path is forbidden: ${file}`)
  }
  const root = fs.realpathSync(isolatedRoot)
  const temporary = [fs.realpathSync(os.tmpdir()), fs.realpathSync('/tmp')]
  if (root.startsWith('/Volumes/') || !temporary.some((base) => root !== base && within(base, root))) {
    throw new Error(`isolated root must be a temporary directory outside /Volumes: ${root}`)
  }
  for (const file of files) {
    const real = fs.existsSync(file) ? fs.realpathSync(file) : path.join(fs.realpathSync(path.dirname(file)), path.basename(file))
    if (real.startsWith('/Volumes/') || !within(root, real)) {
      throw new Error(`target is outside the isolated root or on an external volume: ${real}`)
    }
  }
}

export function verifyJpRepairB2Evidence(
  evidence: { evidencePath: string; expectedSha256: string },
  approvalSha256: string,
  approval: JpRepairProductionApproval,
): void {
  const bytes = fs.readFileSync(evidence.evidencePath)
  if (sha256(bytes) !== evidence.expectedSha256) throw new Error('B2 evidence hash differs from the operator-supplied hash')
  const parsed = JSON.parse(bytes.toString('utf8')) as Partial<JpRepairB2Evidence> | null
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('B2 evidence is not a JSON object')
  if (parsed.version !== 1 || parsed.boundary !== JP_REPAIR_B2_BOUNDARY || parsed.status !== 'PASS') {
    throw new Error(`B2 evidence is ${String(parsed.boundary)} ${String(parsed.status)}, not ${JP_REPAIR_B2_BOUNDARY} PASS`)
  }
  if (parsed.method !== JP_REPAIR_B2_SYNTHETIC_METHOD) {
    throw new Error(`B2 evidence method ${String(parsed.method)} is not a verified physical-boundary method; only ${JP_REPAIR_B2_SYNTHETIC_METHOD} is accepted and it is never Production evidence`)
  }
  if (parsed.approvalSha256 !== approvalSha256 || parsed.gitCommitSha !== approval.gitCommitSha
      || parsed.planApprovalSha256 !== approval.plan.approvalSha256) {
    throw new Error('B2 evidence is for another approval, revision, or plan')
  }
  const identity = (file: JpRepairFileBinding | undefined) => JSON.stringify([file?.realpath, file?.dev, file?.inode])
  if (identity(parsed.databases?.main) !== identity(approval.database)
      || identity(parsed.databases?.analog) !== identity(approval.analog)
      || identity(parsed.databases?.servingCache) !== identity(approval.servingCache)) {
    throw new Error('B2 evidence is for other database identities')
  }
}

function assertApprovedFiles(approval: JpRepairProductionApproval, targets: JpRepairExecutionTargets): void {
  assertBoundFile(targets.database, approval.database, JP_REPAIR_MAIN_BASENAME, 'main database')
  assertBoundFile(targets.analog, approval.analog, JP_REPAIR_ANALOG_CONTRACT.basename, 'analog')
  assertBoundFile(targets.servingCache, approval.servingCache, JP_REPAIR_SERVING_CACHE_BASENAME, 'serving cache')
}

function bindingFor(approval: JpRepairProductionApproval, approvalSha256: string,
  revision: JpRepairExecutorInput<unknown>['revision']) {
  return {
    version: 1,
    gitCommitSha: approval.gitCommitSha,
    sourceTreeSha256: revision.sourceTreeSha256,
    nodeModulesLockSha256: revision.nodeModulesLockSha256,
    approvalSha256,
    planApprovalSha256: approval.plan.approvalSha256,
    databases: {
      main: { realpath: approval.database.realpath, dev: approval.database.dev, inode: approval.database.inode },
      analog: { realpath: approval.analog.realpath, dev: approval.analog.dev, inode: approval.analog.inode },
      servingCache: { realpath: approval.servingCache.realpath, dev: approval.servingCache.dev,
        inode: approval.servingCache.inode },
    },
  }
}

// Creates the binding once and never replaces it: the bytes are fsynced in an
// exclusive temporary file that is hard-linked into place (EEXIST keeps the
// existing entry), then the directory is fsynced. A restart must find exactly
// the same bytes; a torn or foreign binding holds.
function pinBinding(directory: string, binding: ReturnType<typeof bindingFor>): string {
  const file = path.join(directory, JP_REPAIR_EXECUTOR_BINDING_NAME)
  const bytes = `${JSON.stringify(binding, null, 2)}\n`
  fs.mkdirSync(directory, { recursive: true })
  if (!fs.existsSync(file)) {
    const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`
    const descriptor = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT
      | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600)
    try {
      fs.writeFileSync(descriptor, bytes)
      fs.fsyncSync(descriptor)
    } finally {
      fs.closeSync(descriptor)
    }
    try {
      fs.linkSync(temporary, file)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    } finally {
      fs.rmSync(temporary, { force: true })
    }
    const handle = fs.openSync(directory, 'r')
    try { fs.fsyncSync(handle) } finally { fs.closeSync(handle) }
  }
  if (fs.readFileSync(file, 'utf8') !== bytes) {
    throw new Error('checkpoint belongs to another revision, plan, or database identity; it is not reused')
  }
  return sha256(bytes)
}

export async function executeJpRepair<T>(input: JpRepairExecutorInput<T>): Promise<JpRepairExecutorResult<T>> {
  const holdReasons: string[] = []
  const hold = (code: string, error: unknown): JpRepairExecutorResult<T> => {
    holdReasons.push(`${code}:${message(error)}`)
    return { verdict: 'HOLD', productionReady: false, mode: input.mode, holdReasons, workflowStarted: false }
  }

  // 1. Every existing preflight gate.
  const preflight = await input.preflight()
  if (preflight.verdict !== 'PASS' || !preflight.approval || !preflight.approvalSha256) {
    holdReasons.push(...preflight.holdReasons.map((reason) => `PREFLIGHT_HOLD:${reason}`))
    if (holdReasons.length === 0) holdReasons.push('PREFLIGHT_HOLD:no approval was verified')
    return { verdict: 'HOLD', productionReady: false, mode: input.mode, holdReasons, workflowStarted: false }
  }
  const approval = preflight.approval
  const approvalSha256 = preflight.approvalSha256

  // 2. Verified B2 physical-maintenance-boundary evidence for this exact identity.
  if (!input.b2) return hold('B2_EVIDENCE_MISSING', 'no verified physical-maintenance-boundary evidence was supplied')
  try {
    verifyJpRepairB2Evidence(input.b2, approvalSha256, approval)
  } catch (error) {
    return hold('B2_EVIDENCE_REJECTED', error)
  }

  // 3. The three files are still the approved ones.
  try {
    assertApprovedFiles(approval, input.targets)
  } catch (error) {
    return hold('DATABASE_IDENTITY_DRIFT', error)
  }

  // 4. Isolation guard for every PASS, then the restart pin. None of this
  // touches a database; any mismatch holds. Stage checkpoints belong to the
  // workflow, which must bind them to `bindingSha256`.
  const execute = input.mode === 'EXECUTE_ISOLATED'
  if (!input.isolatedRoot || (execute && !input.checkpointDirectory)) {
    return hold('ISOLATION_REQUIRED', 'a PASS needs an isolated temporary root (and a checkpoint directory to execute); Production is not executable')
  }
  let bindingSha256 = ''
  try {
    assertJpRepairIsolatedTargets(input.isolatedRoot,
      [...Object.values(input.targets), ...(execute ? [input.checkpointDirectory!] : [])])
    if (execute) {
      bindingSha256 = pinBinding(input.checkpointDirectory!, bindingFor(approval, approvalSha256, input.revision))
    }
  } catch (error) {
    return hold('ISOLATION_OR_CHECKPOINT_REJECTED', error)
  }
  if (!execute) return { verdict: 'PASS', productionReady: false, mode: input.mode, holdReasons, workflowStarted: false }
  if (!input.hold) return hold('WRITER_HOLD_REQUIRED', 'execution needs the approved writer hold driver')

  // 5. Mutation happens only inside the existing writer hold.
  const services = approval.services.filter((service): service is LaunchdRuntimeIdentity =>
    !isJpRepairAbsentService(service))
  const state = { started: false }
  try {
    const { result } = await withWeeklyWriterHold({
      approved: services,
      maximumHoldMs: input.hold.maximumHoldMs,
      driver: input.hold.driver,
      operation: async (assertHoldValid) => {
        assertApprovedFiles(approval, input.targets)
        state.started = true
        return input.workflow({
          checkpointDirectory: input.checkpointDirectory!,
          bindingSha256,
          targets: input.targets,
          assertHoldValid,
        })
      },
    })
    return { verdict: 'PASS', productionReady: false, mode: input.mode, holdReasons, workflowStarted: true, result }
  } catch (error) {
    // A workflow error carrying a hold code (a stage left in flight without a
    // receipt, or a stage with a FAIL receipt) is a HOLD when the writers were restored: nothing was rerun and
    // an operator must decide. A restore failure stays FAILED.
    const holdCode = error instanceof WriterHoldError && error.restoreErrors.length === 0
      ? (error.primaryError as { holdCode?: unknown } | null)?.holdCode
      : undefined
    if (typeof holdCode === 'string') {
      holdReasons.push(`${holdCode}:${message(error)}`)
      return { verdict: 'HOLD', productionReady: false, mode: input.mode, holdReasons, workflowStarted: state.started }
    }
    holdReasons.push(`EXECUTION_FAILED:${message(error)}`)
    return { verdict: 'FAILED', productionReady: false, mode: input.mode, holdReasons, workflowStarted: state.started }
  }
}
