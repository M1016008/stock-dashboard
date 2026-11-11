// Web・類似の検索の配置 (deploy-web-analog-only.ts) が求める「配置の証明」を作る。10/29 の本番の配置で使った
// repo の外のスクリプトを元に、その時の commit・ビルド・ファイルの決まった値を、引数と記録ファイルからの読み取りに置き換えた。
//
//   確かめるだけ (どこにも書かない):  ... create-sma-release-preflight-proof.ts --check  <共通の引数>
//   証明を作る (--out の新しいフォルダにだけ書く):  ... --write --out=<まだ無い絶対パス>  <共通の引数>
//   共通の引数: --release-root=<release ディレクトリ> --artifact=<候補のビルド> --runtime=<候補の束> --baseline=<40 桁> [--prior-baseline=<40 桁>]
//
// 本番に対して行うのは、ファイル・記録の読み取り、ps、Web・類似の検索への GET (/api/health と、
// force-dynamic の /api/history・/api/us/history) だけ。release-state・本番の DB・launchd には書かない。
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { activeArtifactTreeIdentity, verifySmaReleaseManifest } from '@/lib/release/artifact-manifest'
import { currentPreflightStateSha256, sha256File, type PreflightAttestation, type SmaReleasePreflightProof } from '@/lib/release/preflight-proof'
import { acceptedRuntimeBaselines, assertReleaseRootBaselineStatus } from '@/lib/release/release-root-baseline'
import { verifyRuntimeManifest, type RuntimeManifest } from '@/lib/release/runtime-identity'

const home = os.homedir()
const SUPPORT = path.join(home, 'Library', 'Application Support', 'StockBoard')
export const DEFAULTS = {
  releaseState: path.join(SUPPORT, 'release-state'),
  storageIncidents: path.join(SUPPORT, 'storage-incidents'),
  volume: '/Volumes/OWC Express 1M2 80G',
  volumeUuid: '11FDA3F5-D89E-414D-9B95-C2069FF0B204',
  jpDb: '/Volumes/OWC Express 1M2 80G/stock-dashboard/stockboard.db',
  usDb: '/Volumes/OWC Express 1M2 80G/stockboard-data/us/stockboard-us.db',
  web: 'http://127.0.0.1:3000',
  analog: 'http://127.0.0.1:3105',
  freshnessLog: path.join(home, 'Library', 'Logs', 'StockBoard', 'data-freshness-guard.log'),
  updateLog: path.join(home, 'Library', 'Logs', 'StockBoard', 'update-latest.log'),
  minimumFreeBytes: 50 * 1024 ** 3,
  ttlMinutes: 12,
}
const PRICE_BASIS = { JP: 'jp-split-normalized-v1', US: 'tiingo_adj_ohlc_ratio_v1' }

function fail(message: string): never {
  throw new Error(`preflight_generation_failed:${message}`)
}

// --- データに依らない確認 (テストで直接確かめる) ---
export function checkHistory(payload: any, ticker: string, expectedDate: string): void {
  if (payload?.ticker !== ticker || payload.period !== 'all' || !Array.isArray(payload.rows) || payload.rows.length === 0) fail(`history_shape:${ticker}`)
  if (payload.count !== payload.rows.length || payload.rows.at(-1)?.date !== expectedDate) fail(`history_date_or_count:${ticker}`)
  payload.rows.forEach((row: any, index: number) => {
    if (index > 0 && payload.rows[index - 1].date >= row.date) fail(`history_order:${ticker}:${index}`)
    if (![row.open, row.high, row.low, row.close, row.volume].every(Number.isFinite)) fail(`history_nonfinite:${ticker}:${index}`)
    if (row.low > row.high || row.open < row.low || row.open > row.high || row.close < row.low || row.close > row.high) fail(`history_ohlc:${ticker}:${index}`)
  })
}

export function checkHealth(health: any, role: string): void {
  if (health?.status !== 'ok' || health.overall !== 'healthy' || health.storageStatus !== 'available') fail(`health:${role}`)
}

export function checkFreshness(freshness: any): { jp: string; us: string } {
  const jp = freshness?.expected?.jp; const us = freshness?.expected?.us
  if (!/^\d{4}-\d{2}-\d{2}$/.test(jp) || !/^\d{4}-\d{2}-\d{2}$/.test(us)) fail('freshness_reference')
  for (const key of ['price', 'snapshot', 'dashboardCache', 'physicalScores', 'feature', 'mlFeature', 'mlPrediction']) {
    if (freshness.dates?.jp?.[key] !== jp) fail(`jp_freshness:${key}`)
  }
  for (const key of ['price', 'snapshot', 'dashboardCache', 'physicalScores', 'mlFeature', 'mlPrediction']) {
    if (freshness.dates?.us?.[key] !== us) fail(`us_freshness:${key}`)
  }
  const automation = freshness.usAutomation ?? {}
  if (automation.priceBasis !== PRICE_BASIS.US || automation.derivedPriceBasis !== PRICE_BASIS.US || automation.analogPriceBasis !== PRICE_BASIS.US
    || automation.priceBasisCurrent !== true || automation.ingestionStatus !== 'complete' || automation.ingestionNeedsRetry !== false) {
    fail('us_price_basis_or_ingestion')
  }
  for (const key of ['jp-core', 'us']) if (freshness.actions?.find((action: any) => action.key === key)?.state !== 'fresh') fail(`freshness_action:${key}`)
  const blocking = (freshness.activeLocks ?? []).filter((lock: string) => lock !== 'trigger_historical_worker')
  if (blocking.length > 0) fail(`blocking_active_locks:${blocking.join(',')}`)
  return { jp, us }
}

export function writerProcesses(psOutput: string): string[] {
  return psOutput.split('\n').filter((line) => (
    /scripts\/(?:update-latest|update-us-latest|run-weekly-optimization|run-us-ml-job|ensure-us-adjusted-foundation|build-us-analytics-db)\.ts/.test(line)
    || /npm (?:run )?batch:weekly-optimize/.test(line)
  ))
}

const inside = (parent: string, child: string) => {
  const relative = path.relative(parent, child)
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

// 書く先は、まだ無い新しいフォルダだけ。本番の場所 (release ディレクトリ・release-state・StockBoard の App Support・
// 本番の DB のフォルダ・LaunchAgents) の中は認めない。
export function assertOutputDirectory(out: string, releaseRoot: string): string {
  if (!path.isAbsolute(out) || path.resolve(out) !== out) fail('out_must_be_normalized_absolute')
  if (fs.existsSync(out)) fail('out_must_not_exist')
  const forbidden = [releaseRoot, SUPPORT, path.join(home, 'Library', 'LaunchAgents'), path.dirname(DEFAULTS.jpDb), path.dirname(DEFAULTS.usDb)]
  if (forbidden.some((root) => inside(root, out))) fail('out_inside_production_location')
  return out
}

function parseArguments(argv: readonly string[]) {
  const value = (name: string) => argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3)
  const mode = argv.includes('--write') ? 'write' as const : argv.includes('--check') ? 'check' as const : fail('mode_--check_or_--write_required')
  const required = (name: string) => value(name) || fail(`--${name}_required`)
  const baseline = required('baseline')
  if (!/^[0-9a-f]{40}$/.test(baseline)) fail('baseline_must_be_40_hex')
  return { mode, releaseRoot: required('release-root'), artifact: required('artifact'), runtime: required('runtime'), baseline,
    priorBaseline: value('prior-baseline'), out: mode === 'write' ? required('out') : null }
}

async function getJson(url: string): Promise<any> {
  const response = await fetch(url, { signal: AbortSignal.timeout(60_000), headers: { 'cache-control': 'no-store' } })
  if (!response.ok) fail(`http_${response.status}:${url}`)
  return response.json()
}

const command = (file: string, args: string[], cwd?: string) => execFileSync(file, args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).trim()
const statEvidence = (file: string) => { const stat = fs.statSync(file); return { path: file, inode: stat.ino, bytes: stat.size, mtime: stat.mtime.toISOString() } }

function latestFreshness(): any {
  const text = fs.readFileSync(DEFAULTS.freshnessLog, 'utf8').trim()
  const offset = text.lastIndexOf('\n{\n  "status"')
  return JSON.parse(offset >= 0 ? text.slice(offset + 1) : text)
}

// 本番の volume の確認の記録のうち、UUID が一致する最新のもの。
function latestStorageCertification(): string {
  const files = fs.readdirSync(DEFAULTS.storageIncidents).filter((name) => /^volume-certification-.*\.json$/.test(name))
    .map((name) => path.join(DEFAULTS.storageIncidents, name))
    .filter((file) => JSON.parse(fs.readFileSync(file, 'utf8')).volume?.uuid === DEFAULTS.volumeUuid)
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)
  return files[0] ?? fail('storage_certification_missing')
}

async function main(): Promise<void> {
  const args = parseArguments(process.argv.slice(2))
  const releaseRoot = fs.realpathSync(args.releaseRoot)
  const out = args.out ? assertOutputDirectory(args.out, releaseRoot) : null
  if (!fs.statSync(DEFAULTS.releaseState).isDirectory() || fs.lstatSync(DEFAULTS.releaseState).isSymbolicLink()) fail('release_state_must_be_physical')

  // release ディレクトリと候補
  if (command('/usr/bin/git', ['rev-parse', 'HEAD'], releaseRoot) !== args.baseline) fail('baseline_identity')
  assertReleaseRootBaselineStatus(releaseRoot, DEFAULTS.releaseState, command('/usr/bin/git', ['status', '--porcelain'], releaseRoot))
  const candidateBuild = fs.readFileSync(path.join(args.artifact, 'BUILD_ID'), 'utf8').trim()
  const candidateManifest = JSON.parse(fs.readFileSync(path.join(args.artifact, 'SMA_RELEASE_MANIFEST.json'), 'utf8'))
  verifySmaReleaseManifest(args.artifact, candidateManifest.candidateCommit)
  if (candidateManifest.buildId !== candidateBuild || candidateManifest.baselineCommit !== args.baseline) fail('candidate_manifest')
  const baselines = acceptedRuntimeBaselines(args.baseline, args.priorBaseline,
    (older, newer) => { try { command('/usr/bin/git', ['merge-base', '--is-ancestor', older, newer], releaseRoot); return true } catch { return false } })
  const runtimeManifestFile = path.join(args.runtime, 'runtime-manifest.json')
  const candidateRuntime: RuntimeManifest = JSON.parse(fs.readFileSync(runtimeManifestFile, 'utf8'))
  verifyRuntimeManifest(args.runtime, { expectedIdentity: candidateRuntime.hashes.runtimeIdentitySha256, acceptedBaselines: baselines })

  // データの鮮度・書き込み中の処理・ロック
  const freshness = latestFreshness()
  const expected = checkFreshness(freshness)
  const processes = command('/bin/ps', ['-axo', 'pid=,ppid=,etime=,state=,command='])
  const writers = writerProcesses(processes)
  if (writers.length > 0) fail(`writer_process:${writers.join('|')}`)
  const failedSafe = path.join(DEFAULTS.storageIncidents, 'FAILED_SAFE')
  const building = `${DEFAULTS.usDb}.tiingo_adj_ohlc_ratio_v1.building`
  const writerLocks = [path.join(SUPPORT, 'weekly-optimization.lock'), path.join(SUPPORT, 'us-ml-job.lock'), `${building}.process-lock`,
    path.join(DEFAULTS.releaseState, 'sma-release.lock')]
  const journals = [`${building}.promotion-journal.json`, `${DEFAULTS.usDb}.weekly-ml.building.promotion-journal.json`,
    path.join(DEFAULTS.releaseState, 'sma-release-journal.json')]
  for (const absent of [failedSafe, ...writerLocks, ...journals]) if (fs.existsSync(absent)) fail(`unsafe_path_present:${absent}`)
  const certificationFile = latestStorageCertification()
  const certification = JSON.parse(fs.readFileSync(certificationFile, 'utf8'))
  const statfs = fs.statfsSync(DEFAULTS.volume)
  const freeBytes = statfs.bavail * statfs.bsize
  if (certification.volume?.writable !== true || freeBytes < DEFAULTS.minimumFreeBytes || certification.volume.freeBytes < DEFAULTS.minimumFreeBytes) fail('storage')

  // Web・類似の検索の状態と、代表の銘柄の株価の履歴 (GET だけ)
  const evidence: Record<string, unknown> = {
    'predeploy-web-health.json': await getJson(`${DEFAULTS.web}/api/health`),
    'predeploy-analog-health.json': await getJson(`${DEFAULTS.analog}/api/health`),
    'predeploy-1306-period-all.json': await getJson(`${DEFAULTS.web}/api/history/1306?period=all`),
    'predeploy-SPY-period-all.json': await getJson(`${DEFAULTS.web}/api/us/history/SPY?period=all`),
  }
  checkHealth(evidence['predeploy-web-health.json'], 'web')
  checkHealth(evidence['predeploy-analog-health.json'], 'analog')
  checkHistory(evidence['predeploy-1306-period-all.json'], '1306', expected.jp)
  checkHistory(evidence['predeploy-SPY-period-all.json'], 'SPY', expected.us)
  evidence['preflight-jp-source.json'] = { status: 'PASS', expectedLatestSession: expected.jp, observedLatestSession: freshness.dates.jp.price,
    source: 'J-Quants daily updater', database: statEvidence(DEFAULTS.jpDb), dailyRunLogSha256: sha256File(DEFAULTS.updateLog) }
  evidence['preflight-us-source.json'] = { status: 'PASS', expectedLatestSession: expected.us, observedLatestSession: freshness.dates.us.price,
    source: 'Tiingo adjusted OHLC ratio v1', database: statEvidence(DEFAULTS.usDb), coveragePct: freshness.usAutomation.coveragePct,
    ingestionStatus: freshness.usAutomation.ingestionStatus }
  evidence['preflight-price-basis.json'] = { status: 'PASS', ...PRICE_BASIS }
  evidence['preflight-sma-freshness.json'] = { status: 'PASS', checkedAt: freshness.checkedAt, dryRun: freshness.dryRun, expected: freshness.expected,
    jp: freshness.dates.jp, us: freshness.dates.us, nonBlockingAttention: (freshness.actions ?? []).filter((action: any) => action.state !== 'fresh') }
  evidence['preflight-writer-processes.json'] = { status: 'PASS', checkedAt: new Date().toISOString(), forbiddenProcesses: [],
    activeLocks: freshness.activeLocks, building: fs.existsSync(building) ? statEvidence(building) : null }

  // 戻し先 (今の本番の世代)
  const nodeModules = path.join(releaseRoot, 'node_modules')
  if (!fs.lstatSync(nodeModules).isSymbolicLink()) fail('production_runtime_not_symlink')
  const rollbackTarget = fs.realpathSync(nodeModules)
  const rollbackIdentity = JSON.parse(fs.readFileSync(path.join(path.dirname(rollbackTarget), 'runtime-manifest.json'), 'utf8')).hashes.runtimeIdentitySha256
  const live = path.join(releaseRoot, '.next-live')
  const summary = {
    mode: args.mode, candidate: { commit: candidateManifest.candidateCommit, buildId: candidateBuild, artifactTreeSha256: candidateManifest.treeSha256 },
    runtime: { dir: args.runtime, identitySha256: candidateRuntime.hashes.runtimeIdentitySha256, baselineSha: candidateRuntime.baselineSha },
    rollback: { buildId: fs.readFileSync(path.join(live, 'BUILD_ID'), 'utf8').trim(), artifactTreeSha256: activeArtifactTreeIdentity(live).treeSha256,
      runtimeNodeModulesTarget: rollbackTarget, runtimeIdentitySha256: rollbackIdentity },
    expected, storage: { certificationFile, freeBytes }, freshnessCheckedAt: freshness.checkedAt,
  }
  if (!out) {
    console.log(JSON.stringify({ status: 'CHECK_PASS', wroteFiles: false, ...summary }, null, 2))
    return
  }

  // ここから下は --write のときだけ。書くのは --out の新しいフォルダの中だけ。
  fs.mkdirSync(out, { mode: 0o700 })
  const file = (name: string) => path.join(out, name)
  for (const [name, value] of Object.entries(evidence)) fs.writeFileSync(file(name), `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
  const attest = (purpose: PreflightAttestation['purpose'], target: string): PreflightAttestation => ({ purpose, path: target, kind: 'file-sha256', sha256: sha256File(target) })
  const attestations: PreflightAttestation[] = [
    { purpose: 'runtime-link', path: nodeModules, kind: 'symlink', target: rollbackTarget },
    attest('runtime-manifest', runtimeManifestFile),
    attest('jp-source-generation', file('preflight-jp-source.json')),
    attest('us-source-generation', file('preflight-us-source.json')),
    attest('jp-serving-generation', file('predeploy-1306-period-all.json')),
    attest('us-serving-generation', file('predeploy-SPY-period-all.json')),
    attest('price-basis', file('preflight-price-basis.json')),
    attest('storage-guard', certificationFile),
    { purpose: 'failed-safe', path: failedSafe, kind: 'absent' },
    ...writerLocks.map((target): PreflightAttestation => ({ purpose: 'writer-lock', path: target, kind: 'absent' })),
    ...journals.map((target): PreflightAttestation => ({ purpose: 'promotion-journal', path: target, kind: 'absent' })),
    attest('web-health', file('predeploy-web-health.json')),
    attest('analog-health', file('predeploy-analog-health.json')),
    attest('freshness-health', file('preflight-sma-freshness.json')),
    attest('writer-lock', file('preflight-writer-processes.json')),
  ]
  const history = (name: string) => evidence[name] as { count: number }
  const issued = new Date()
  const proof: SmaReleasePreflightProof = {
    version: 1, issuedAt: issued.toISOString(), expiresAt: new Date(issued.getTime() + DEFAULTS.ttlMinutes * 60_000).toISOString(),
    baselineCommit: args.baseline, candidate: summary.candidate,
    runtime: { nodeModulesTarget: path.join(args.runtime, 'node_modules'), identitySha256: candidateRuntime.hashes.runtimeIdentitySha256,
      manifestSha256: sha256File(runtimeManifestFile), lockSha256: candidateRuntime.hashes.lockSha256 },
    priceBasis: `JP:${PRICE_BASIS.JP};US:${PRICE_BASIS.US}`,
    sourceGeneration: { JP: `jp-source:${expected.jp}:${sha256File(file('preflight-jp-source.json'))}`, US: `us-source:${expected.us}:${sha256File(file('preflight-us-source.json'))}` },
    servingGeneration: {
      JP: `jp-serving:1306:${expected.jp}:${history('predeploy-1306-period-all.json').count}:${sha256File(file('predeploy-1306-period-all.json'))}`,
      US: `us-serving:SPY:${expected.us}:${history('predeploy-SPY-period-all.json').count}:${sha256File(file('predeploy-SPY-period-all.json'))}`,
    },
    lineageStatus: 'PASS',
    storage: { guardStatus: 'PASS', failedSafe: false, volumePath: DEFAULTS.volume, volumeUuid: DEFAULTS.volumeUuid, freeBytes, minimumFreeBytes: DEFAULTS.minimumFreeBytes },
    health: { web: 'PASS', analog: 'PASS', freshnessGuard: 'PASS' },
    concurrency: { writerLocksClear: true, promotionJournalsClear: true },
    rollback: { artifactRoot: live, ...summary.rollback },
    attestations, stateSha256: currentPreflightStateSha256(attestations),
  }
  fs.writeFileSync(file('sma-release-preflight-proof.json'), `${JSON.stringify(proof, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
  console.log(JSON.stringify({ status: 'PROOF_WRITTEN', proofFile: file('sma-release-preflight-proof.json'),
    proofSha256: sha256File(file('sma-release-preflight-proof.json')), expiresAt: proof.expiresAt, ...summary }, null, 2))
}

if (require.main === module) main().catch((error) => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1 })
