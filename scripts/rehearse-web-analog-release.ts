// 練習用の場所で、Web・類似の検索の入れ替え → 確認 → 戻しを、本番の配置と同じ部品 (WebAnalogReleaseTransaction・
// runWebAnalogRelease・実行環境の束の照合) で通す。本番の :3000・:3105、launchd、本番の DB、release-state には触れない。
// - 練習用の場所は OWC の `StockBoard Development/release-rehearsal/` の下だけ。
// - 練習用のサーバーは 127.0.0.1:3200 (Web) と :3205 (類似の検索)。隔離の実行モード (preview) で動かし、DB は練習用の場所の中の小さな試験用の DB。
// - launchctl の代わりに、練習用のサーバーのプロセスへ直接 SIGSTOP・SIGCONT・再起動を送る。
//
//   prepare --root=<練習用の場所> --baseline=<40 桁> --live-source=<写す元の .next-live> --runtime=<戻し先の束>
//   start | stop | status --root=<...>
//   run --root=<...> --direction=forward --artifact=<候補のビルド> --candidate-runtime=<候補の束> [--prior-baseline=<40 桁>]
//   run --root=<...> --direction=back      (前の世代の写しと戻し先の束に戻す)
//   run --root=<...> --direction=fail --artifact=<...> --candidate-runtime=<...>   (確認の失敗を起こし、自動で戻ることを確かめる)
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { activeArtifactTreeIdentity, artifactTreeIdentity } from '@/lib/release/artifact-manifest'
import { acceptedRuntimeBaselines, assertReleaseRootBaselineStatus } from '@/lib/release/release-root-baseline'
import { verifyRuntimeManifest } from '@/lib/release/runtime-identity'
import {
  PRODUCTION_AGENT_INVENTORY, WEB_ANALOG_TARGETS, recoverReleaseWithBestEffortSignals, runWebAnalogRelease,
  type AgentSnapshot, type WebAnalogReleaseAdapter,
} from '@/lib/release/web-analog-only'
import { WebAnalogReleaseTransaction, assertNoUncertainReleaseTransaction } from '@/lib/release/web-analog-transaction'
import { OWC_WORKTREE_ROOT, assertOwcDevelopmentVolume, createIsolatedRuntimeEnvironment } from '@/lib/runtime/isolation'

export const REHEARSAL_PARENT = path.join(OWC_WORKTREE_ROOT, 'release-rehearsal')
export const REHEARSAL_PORTS: Record<(typeof WEB_ANALOG_TARGETS)[number], number> = { 'com.stockboard.web': 3200, 'com.stockboard.analog-search': 3205 }
const PRODUCTION_PORTS = new Set([3000, 3105, 3136])
type Target = (typeof WEB_ANALOG_TARGETS)[number]
type Config = { root: string; release: string; state: string; isolation: string; previousArtifact: string; rollbackRuntime: string; baseline: string }

export function assertRehearsalRoot(value: string): string {
  const root = path.resolve(value)
  const relative = path.relative(REHEARSAL_PARENT, root)
  if (!value || relative === '' || relative.startsWith('..') || path.isAbsolute(relative) || relative.includes(path.sep)) {
    throw new Error(`--root must be a direct child of ${REHEARSAL_PARENT}`)
  }
  for (const port of Object.values(REHEARSAL_PORTS)) if (PRODUCTION_PORTS.has(port)) throw new Error('rehearsal port collides with production')
  return root
}

const arg = (name: string) => process.argv.find((item) => item.startsWith(`--${name}=`))?.slice(name.length + 3) ?? ''
const required = (name: string) => arg(name) || (() => { throw new Error(`--${name} required`) })()
const configFile = (root: string) => path.join(root, 'rehearsal.json')
const pidFile = (root: string) => path.join(root, 'pids.json')
const loadConfig = (root: string): Config => JSON.parse(fs.readFileSync(configFile(root), 'utf8'))
function record(config: Config, entry: Record<string, unknown>): void {
  fs.appendFileSync(path.join(config.root, 'rehearsal-log.jsonl'), `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`)
}
function git(args: string[], cwd: string): string {
  const result = spawnSync('/usr/bin/git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } })
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr.trim()}`)
  return result.stdout.trim()
}

function prepare(root: string): void {
  assertOwcDevelopmentVolume()  // OWC が外れていて、内蔵ディスクに同じ名前のフォルダがあるときは止める
  if (fs.existsSync(root)) throw new Error(`root already exists: ${root}`)
  const baseline = required('baseline')
  const liveSource = required('live-source')
  const rollbackRuntime = fs.realpathSync(required('runtime'))
  fs.mkdirSync(root, { recursive: true })
  const config: Config = { root, release: path.join(root, 'release'), state: path.join(root, 'release-state'),
    isolation: path.join(root, 'isolation'), previousArtifact: path.join(root, 'previous-artifact'), rollbackRuntime, baseline }
  // 元の repo には書かない (worktree の登録をしない)。OWC の上に独立した複製を作る。
  git(['clone', '--quiet', '--no-hardlinks', '--no-checkout', process.cwd(), config.release], root)
  git(['checkout', '--quiet', '--detach', baseline], config.release)
  // 写す元は読むだけ。写しは「前の世代」として戻しの候補にも使う。
  fs.cpSync(liveSource, config.previousArtifact, { recursive: true, errorOnExist: true, force: false })
  fs.cpSync(config.previousArtifact, path.join(config.release, '.next-live'), { recursive: true, errorOnExist: true, force: false })
  fs.symlinkSync(path.join(rollbackRuntime, 'node_modules'), path.join(config.release, 'node_modules'))
  for (const directory of [config.state, path.join(config.isolation, 'data'), path.join(root, 'logs')]) fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
  fs.writeFileSync(configFile(root), `${JSON.stringify(config, null, 2)}\n`, { flag: 'wx' })
  record(config, { step: 'prepare', baseline, liveSource, rollbackRuntime })
}

function readPids(root: string): Partial<Record<Target, number>> {
  return fs.existsSync(pidFile(root)) ? JSON.parse(fs.readFileSync(pidFile(root), 'utf8')) : {}
}
// 記録した PID が、まだ練習用のサーバー (この練習用の場所の next start、練習用の port) であるときだけ扱う。
// PID が別のプロセスに使い回されていたら、信号を送らない。
let practiceRelease = ''
// 確かめ方: その PID が練習用の port で待ち受けていて、作業フォルダが練習用の release ディレクトリであること (lsof)。
function ownedPid(label: Target, pid?: number): number | null {
  if (!pid || !practiceRelease) return null
  const listening = spawnSync('/usr/sbin/lsof', ['-nP', '-a', '-p', String(pid), `-iTCP:${REHEARSAL_PORTS[label]}`, '-sTCP:LISTEN'], { encoding: 'utf8' })
  const cwd = spawnSync('/usr/sbin/lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'], { encoding: 'utf8' })
  const directory = cwd.stdout.split('\n').find((line) => line.startsWith('n'))?.slice(1)
  return listening.status === 0 && directory === fs.realpathSync(practiceRelease) ? pid : null
}
const alive = (pid?: number, label?: Target) => label ? ownedPid(label, pid) !== null : false

function startTarget(config: Config, label: Target): number {
  const env = { ...createIsolatedRuntimeEnvironment('preview', config.isolation), NEXT_DIST_DIR: '.next-live',
    STOCKBOARD_PROCESS_ROLE: label === 'com.stockboard.web' ? 'web' : 'analog-search', ...(label === 'com.stockboard.analog-search' ? { ANALOG_SEARCH_WORKER: '1' } : {}) }
  const log = fs.openSync(path.join(config.root, 'logs', `${label}.log`), 'a')
  const child = spawn(process.execPath, [path.join(config.release, 'node_modules', 'next', 'dist', 'bin', 'next'), 'start', '-p', String(REHEARSAL_PORTS[label]), '-H', '127.0.0.1'],
    { cwd: config.release, env, detached: true, stdio: ['ignore', log, log] })
  child.unref()
  const pids = { ...readPids(config.root), [label]: child.pid }
  fs.writeFileSync(pidFile(config.root), `${JSON.stringify(pids)}\n`)
  return child.pid!
}

function stopTarget(config: Config, label: Target): void {
  const pid = ownedPid(label, readPids(config.root)[label])
  if (pid !== null) {
    try { process.kill(pid, 'SIGCONT') } catch { /* already running */ }
    process.kill(pid, 'SIGTERM')
    const deadline = Date.now() + 20_000
    while (ownedPid(label, pid) !== null && Date.now() < deadline) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200)
    if (ownedPid(label, pid) !== null) process.kill(pid, 'SIGKILL')
  }
  const pids = readPids(config.root); delete pids[label]
  fs.writeFileSync(pidFile(config.root), `${JSON.stringify(pids)}\n`)
}

async function healthy(label: Target, timeoutSeconds = 90): Promise<void> {
  const deadline = Date.now() + timeoutSeconds * 1000
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${REHEARSAL_PORTS[label]}/api/health`, { signal: AbortSignal.timeout(5000) })
      if (response.ok && (await response.json()).status === 'ok') return
    } catch { /* starting */ }
    await new Promise((resolve) => setTimeout(resolve, 1000))
  }
  throw new Error(`rehearsal_health_timeout:${label}`)
}

async function run(config: Config): Promise<void> {
  const direction = required('direction')
  if (!['forward', 'back', 'fail'].includes(direction)) throw new Error('--direction must be forward, back or fail')
  const release = config.release
  const nodeModules = path.join(release, 'node_modules')
  const live = path.join(release, '.next-live')
  const back = direction === 'back'
  const artifact = back ? config.previousArtifact : required('artifact')
  const candidateRuntime = back ? config.rollbackRuntime : fs.realpathSync(required('candidate-runtime'))
  if (git(['rev-parse', 'HEAD'], release) !== config.baseline) throw new Error('rehearsal_baseline_mismatch')
  const runnerOwned = assertReleaseRootBaselineStatus(release, config.state, git(['status', '--porcelain'], release))
  const baselines = acceptedRuntimeBaselines(config.baseline, arg('prior-baseline') || undefined,
    (older, newer) => spawnSync('/usr/bin/git', ['merge-base', '--is-ancestor', older, newer], { cwd: release }).status === 0)
  const verify = (directory: string) => {
    const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'runtime-manifest.json'), 'utf8'))
    return verifyRuntimeManifest(directory, { expectedIdentity: manifest.hashes.runtimeIdentitySha256, acceptedBaselines: baselines })
  }
  if (runnerOwned) {  // 本番の配置と同じく、確定の記録にある同一性で確かめる
    const manifest = verifyRuntimeManifest(path.dirname(runnerOwned.target), { expectedIdentity: runnerOwned.runtimeIdentitySha256, acceptedBaselines: baselines })
    if (manifest.hashes.runtimeIdentitySha256 !== runnerOwned.runtimeIdentitySha256) throw new Error('rehearsal_runner_owned_identity_mismatch')
  }
  const rollbackTarget = fs.realpathSync(nodeModules)
  const rollbackRuntime = verify(path.dirname(rollbackTarget))
  const candidate = verify(candidateRuntime)
  // 候補の束が今の束と同じだと、確定の後に「戻し先」と「今」が同じになり、次の配置が最初の確認で止まる。練習では別の束を求める。
  if (path.join(candidateRuntime, 'node_modules') === rollbackTarget) throw new Error('rehearsal_candidate_runtime_equals_active_runtime')
  const readBuild = (root: string) => fs.readFileSync(path.join(root, 'BUILD_ID'), 'utf8').trim()
  const paths = {
    releaseRoot: release, artifact, candidateRuntimeNodeModules: path.join(candidateRuntime, 'node_modules'), live,
    previous: path.join(release, '.next-live-prev'), stage: path.join(release, '.next-live-next'), nodeModules,
    runtimePrevious: path.join(release, '.node_modules-release-prev'), runtimeStage: path.join(release, '.node_modules-release-next'),
    journal: path.join(config.state, 'sma-release-journal.json'), lock: path.join(config.state, 'sma-release.lock'),
  }
  assertNoUncertainReleaseTransaction(paths)
  const candidateTree = (back ? activeArtifactTreeIdentity(artifact) : artifactTreeIdentity(artifact)).treeSha256
  const transaction = new WebAnalogReleaseTransaction({ paths, identity: {
    candidateBuildId: readBuild(artifact), candidateArtifactTreeSha256: candidateTree, candidateRuntimeIdentitySha256: candidate.hashes.runtimeIdentitySha256,
    rollbackBuildId: readBuild(live), rollbackArtifactTreeSha256: activeArtifactTreeIdentity(live).treeSha256,
    rollbackRuntimeIdentitySha256: rollbackRuntime.hashes.runtimeIdentitySha256, rollbackRuntimeNodeModulesTarget: rollbackTarget,
  } })
  const before = { build: readBuild(live), runtime: rollbackTarget }
  const signal = (name: 'SIGSTOP' | 'SIGCONT') => {
    const errors: string[] = []; let signaled = 0
    for (const label of WEB_ANALOG_TARGETS) {
      const pid = ownedPid(label, readPids(config.root)[label])
      if (pid === null) { errors.push(`${name}:${label}:not_a_practice_server`); continue }
      try { process.kill(pid, name); signaled += 1 } catch (error) { errors.push(`${name}:${label}:${String(error)}`) }
    }
    return { signaled, errors }
  }
  let postPromotionChecks = 0
  const adapter: WebAnalogReleaseAdapter = {
    // launchd の代わりの状態: 練習用のサーバーが動いているか。ほかの定期処理は練習では扱わない (変わらない値)。
    snapshotAgents: () => Object.fromEntries(PRODUCTION_AGENT_INVENTORY.map((label) => [label, {
      loaded: true, disabled: false, state: (WEB_ANALOG_TARGETS as readonly string[]).includes(label) ? (alive(readPids(config.root)[label as Target], label as Target) ? 'running' : 'stopped') : 'not running',
    }])) as AgentSnapshot,
    assertHealthy: async () => {
      if (transaction.ownsMutableState() && direction === 'fail' && postPromotionChecks++ === 0) throw new Error('rehearsal_injected_health_failure')
      for (const label of WEB_ANALOG_TARGETS) await healthy(label)
    },
    promote: () => {
      transaction.prepare()
      const freeze = signal('SIGSTOP')
      if (freeze.errors.length > 0) throw new AggregateError(freeze.errors, 'rehearsal_freeze_failed')
      transaction.markTargetsFrozen()
      transaction.activate()
    },
    needsRecovery: () => transaction.ownsMutableState(),
    restore: () => recoverReleaseWithBestEffortSignals({ freezeRequired: true, signal, rollback: () => transaction.rollback() }).restartRequired,
    kickstart: (label) => { stopTarget(config, label); startTarget(config, label) },
    commit: () => transaction.commit(),
  }
  let outcome: Record<string, unknown>
  try {
    const result = await runWebAnalogRelease(adapter)
    outcome = { status: 'SUCCESS', rolledBack: result.rolledBack }
  } catch (error) {
    outcome = { status: 'ROLLED_BACK_OR_FAILED', error: error instanceof Error ? error.message : String(error), transaction: transaction.recoverySummary() }
  }
  const after = { build: readBuild(live), runtime: fs.realpathSync(nodeModules) }
  const journals = fs.readdirSync(config.state).filter((name) => name.startsWith('sma-release-journal.json.'))
  const archived = `sma-release-journal.json.${direction === 'fail' ? 'rolled-back' : 'committed'}-${transaction.transactionId}`
  // 合格の条件: forward・back は確定してその記録が残ること。fail は入れ替えの後に自動で戻り、その記録が残ること。
  const passed = direction === 'fail'
    ? outcome.status !== 'SUCCESS' && String(outcome.error).includes('web_analog_release_rolled_back') && journals.includes(archived)
      && after.build === before.build && after.runtime === before.runtime
    : outcome.status === 'SUCCESS' && journals.includes(archived) && after.build === readBuild(artifact)
      && after.runtime === fs.realpathSync(path.join(candidateRuntime, 'node_modules'))
  const entry = { step: `run:${direction}`, passed, ...outcome, before, after, candidateBuild: readBuild(artifact), expectedJournal: archived, journals }
  record(config, entry)
  console.log(JSON.stringify(entry, null, 2))
  if (!passed) process.exitCode = 1
}

async function main(): Promise<void> {
  const mode = process.argv[2]
  const root = assertRehearsalRoot(required('root'))
  if (mode === 'prepare') return prepare(root)
  const config = loadConfig(root)
  practiceRelease = config.release
  if (mode === 'start') {
    for (const label of WEB_ANALOG_TARGETS) if (!alive(readPids(root)[label], label)) startTarget(config, label)
    for (const label of WEB_ANALOG_TARGETS) await healthy(label)
    record(config, { step: 'start', pids: readPids(root) })
  } else if (mode === 'stop') {
    for (const label of WEB_ANALOG_TARGETS) stopTarget(config, label)
    record(config, { step: 'stop' })
  } else if (mode === 'run') {
    await run(config)
  } else if (mode === 'status') {
    const live = path.join(config.release, '.next-live')
    console.log(JSON.stringify({ build: fs.readFileSync(path.join(live, 'BUILD_ID'), 'utf8').trim(), runtime: fs.realpathSync(path.join(config.release, 'node_modules')),
      pids: readPids(root), running: Object.fromEntries(WEB_ANALOG_TARGETS.map((label) => [label, alive(readPids(root)[label], label)])),
      journals: fs.readdirSync(config.state) }, null, 2))
  } else throw new Error('mode must be prepare, start, run, stop or status')
}

if (require.main === module) main().catch((error) => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1 })
