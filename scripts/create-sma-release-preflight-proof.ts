// Web・類似の検索の配置 (deploy-web-analog-only.ts) が求める「配置の証明」を作る。10/29 の本番の配置で使った
// repo の外のスクリプトを元に、その時の commit・ビルド・ファイルの決まった値を、引数と記録ファイルからの読み取りに置き換えた。
//
//   確かめるだけ (どこにも書かない):  ... create-sma-release-preflight-proof.ts --check  <共通の引数>
//   証明を作る (--out の新しいフォルダにだけ書く):  ... --write --out=<まだ無い絶対パス>  <共通の引数>
//   共通の引数: --release-root=<release ディレクトリ> --artifact=<候補のビルド> --runtime=<候補の束> --baseline=<40 桁> [--prior-baseline=<40 桁>]
//
// --check は、本番のファイル・記録の読み取りと ps だけを行い、どこにも書かない (git は index を更新しない設定、npm は記録を書かない設定)。
// Web・類似の検索への GET は --check では行わない: /api/health は Storage Guard の確認の記録を書くため。--write (P1 当日) と、
// オーナーが認めたときの --check --with-http でだけ行う。release-state・本番の DB・launchd には書かない。
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
// @ts-expect-error The pinned Node types predate Node 24's built-in SQLite module.
import { DatabaseSync } from 'node:sqlite'
import os from 'node:os'
import path from 'node:path'
import { activeArtifactTreeIdentity, verifySmaReleaseManifest } from '@/lib/release/artifact-manifest'
import { currentPreflightStateSha256, sha256File, type PreflightAttestation, type SmaReleasePreflightProof } from '@/lib/release/preflight-proof'
import { acceptedRuntimeBaselines, assertReleaseRootBaselineStatus } from '@/lib/release/release-root-baseline'
import { resolveThroughExistingAncestor } from '@/lib/runtime/isolation'
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
  usUpdateLog: path.join(home, 'Library', 'Logs', 'StockBoard', 'us-update-latest.log'),
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

// 鮮度の見張りの記録は 60 分以内のものだけ使う。P1 当日は見張りも 07:55 に止めるため、15 分では足りない
// (書き込む処理も止めているので、その間にデータは変わらない)。
export const FRESHNESS_MAX_AGE_MINUTES = 60
// 米国株の取り込みが partial のときに通す条件 (10/29 の配置で実際に使った条件。カバー率は 2026-11-12 オーナー決定で 98% 以上)。
export const US_PARTIAL_MIN_COVERAGE_PCT = 98
export const JP_FRESHNESS_KEYS = ['price', 'snapshot', 'indices', 'dashboardCache', 'physicalScores', 'feature', 'modelFeature', 'mlFeature',
  'mlContext', 'mlPhysicsFeature', 'mlCandidate', 'mlPrediction', 'mlPhysicsCandidate', 'mlSimilar'] as const
export const US_FRESHNESS_KEYS = ['price', 'snapshot', 'dashboardCache', 'physicalScores', 'mlFeature', 'mlContext', 'mlPhysicsFeature',
  'mlCandidate', 'mlPrediction', 'mlPhysicsCandidate', 'mlSimilar'] as const

export type UsCompletion = { status: string | null; failed: number; pendingEmpty: number; pendingTargetMissing: number
  temporaryNotFound: number; deferred: number; promotionGuardTriggered: string | null; latest: string | null }
// us-update-latest.log の最後の「US OHLCV complete:」の行。
export function parseUsCompletion(log: string): UsCompletion | null {
  const line = log.split('\n').filter((row) => row.startsWith('US OHLCV complete:')).at(-1)
  if (!line) return null
  const value = (key: string) => line.match(new RegExp(`\\b${key}=([^, ]+)`))?.[1] ?? null
  const number = (key: string) => { const raw = value(key); return raw != null && /^\d+$/.test(raw) ? Number(raw) : NaN }
  return { status: value('status'), failed: number('failed'), pendingEmpty: number('pendingEmpty'), pendingTargetMissing: number('pendingTargetMissing'),
    temporaryNotFound: number('temporaryNotFound'), deferred: number('deferred'), promotionGuardTriggered: value('promotionGuardTriggered'), latest: value('latest') }
}

// 最後の回のログ: 最後の「US OHLCV complete:」の行と、その前でいちばん近い「US OHLCV fetch start:」の行 (前の回の complete を越えない)。
// 全件の取り込みでは targets と activeInvestable が同じ。succeeded と rows は DB の回の記録 (market_data_runs) と照らすのに使う。
export type UsRunLog = { targets: number; activeInvestable: number; slaTargetDate: string | null; succeeded: number; rows: number }
export function parseUsRunLog(log: string): UsRunLog | null {
  const lines = log.split('\n')
  const fields = (line: string) => {
    const value = (key: string) => line.match(new RegExp(`\\b${key}=([^, ]+)`))?.[1] ?? null
    return { value, number: (key: string) => { const raw = value(key); return raw != null && /^\d+$/.test(raw) ? Number(raw) : NaN } }
  }
  let complete = -1
  for (let i = lines.length - 1; i >= 0; i -= 1) if (lines[i].startsWith('US OHLCV complete:')) { complete = i; break }
  if (complete < 0) return null
  const done = fields(lines[complete])
  for (let i = complete - 1; i >= 0; i -= 1) {
    if (lines[i].startsWith('US OHLCV complete:')) return null
    if (!lines[i].startsWith('US OHLCV fetch start:')) continue
    const start = fields(lines[i])
    return { targets: start.number('targets'), activeInvestable: start.number('activeInvestable'), slaTargetDate: start.value('slaTargetDate'),
      succeeded: done.number('succeeded'), rows: done.number('rows') }
  }
  return null
}

export type UsIngestionEvidence = { status: 'PASS' | 'PASS_WITH_RECORDED_PARTIAL_COVERAGE'; ingestionStatus: string; coveragePct: number | null
  pendingTargetMissing: number; completionLatest: string | null; pendingEmpty?: number; emptyEndedTickers?: UsEmptyEndedTicker[]; emptyEvidenceRunId?: number | null }

// 空で返った銘柄 (pendingEmpty) を通す例外 (2026-11-19 オーナー決定、IBO の件)。
// Tiingo の銘柄情報の取引の最終日 (end_date) が対象の日より前の銘柄は、対象の日の行がそもそも無いので、
// 「その日の行が無い」(pendingTargetMissing) と同じ扱いにできる。数は 1〜2 件まで。銘柄名と end_date を証明に残す。
export const US_EMPTY_ENDED_MAX = 2
// market_source_availability と market_universe の 1 行 (証明を作る時に JP の DB を読み取りだけで開いて読む)。
export type UsEmptyEvidenceRow = { ticker: string; status: string | null; statusReason: string | null; lastObservedTargetDate: string | null
  lastSuccessDataDate: string | null; endDate: string | null }
export type UsEmptyEndedTicker = { ticker: string; endDate: string; lastSuccessDataDate: string | null }
// market_data_runs の最後の米国株の取り込みの回 (Tiingo の OHLCV)。
export type UsOhlcvRunRow = { id: number; status: string; startedAt: number; finishedAt: number | null; totalTickers: number; succeeded: number
  rowsInserted: number; payloadJson: string }
// DB から読む記録: 最後の回と、その回の間に「空」と記録された銘柄 (対象の日)。
export type UsEmptyEvidence = { run: UsOhlcvRunRow | null; rows: readonly UsEmptyEvidenceRow[] }
// 記録は、そのまま渡すか、読む関数で渡す (関数は 1〜2 件で、ほかの安い条件がすべて通った後にだけ呼ぶ)。
export type UsEmptyEvidenceSource = UsEmptyEvidence | ((target: string) => UsEmptyEvidence) | null
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

// 空 0 件は今までどおり通す (DB は見ない)。1〜2 件は、次がすべてそろうときだけ、その一覧を返す。通さないときは null。
// - ログの最後の回が全件の取り込み (始まりの行の targets = activeInvestable、対象の日が同じ)。
// - DB の最後の回 (market_data_runs) が、ログの最後の回と同じ (状態・対象の数・成功の数・行の数・空の数・対象の日が一致) で、
//   TICKERS・US_OHLCV_LIMIT を付けていない (payload の tickers・limit が null)。終わっている。
// - その回の間 (started_at〜finished_at) に「空」と記録された銘柄の数がログと一致し、どれも PENDING・EMPTY_RESPONSE・対象の日で、end_date < 対象の日。
export function acceptEndedEmpties(pendingEmpty: number, target: string, source: UsEmptyEvidenceSource, runLog: UsRunLog | null = null,
  logStatus: string | null = 'partial'): { tickers: UsEmptyEndedTicker[]; runId: number | null } | null {
  if (pendingEmpty === 0) return { tickers: [], runId: null }
  if (!Number.isInteger(pendingEmpty) || pendingEmpty < 1 || pendingEmpty > US_EMPTY_ENDED_MAX || source === null) return null
  if (!runLog || !Number.isInteger(runLog.targets) || runLog.targets <= 0 || runLog.targets !== runLog.activeInvestable
    || runLog.slaTargetDate !== target || !Number.isInteger(runLog.succeeded) || !Number.isInteger(runLog.rows)) return null
  const { run, rows } = typeof source === 'function' ? source(target) : source
  if (!run || run.finishedAt == null || run.status !== logStatus || run.totalTickers !== runLog.targets || run.succeeded !== runLog.succeeded
    || run.rowsInserted !== runLog.rows) return null
  let payload: any
  try { payload = JSON.parse(run.payloadJson) } catch { return null }
  if (payload?.tickers != null || payload?.limit != null || payload?.slaTargetDate !== target || payload?.pendingEmpty !== pendingEmpty) return null
  if (rows.length !== pendingEmpty || new Set(rows.map((row) => row.ticker)).size !== rows.length) return null
  const accepted: UsEmptyEndedTicker[] = []
  for (const row of rows) {
    if (row.status !== 'PENDING' || row.statusReason !== 'EMPTY_RESPONSE' || row.lastObservedTargetDate !== target) return null
    if (typeof row.endDate !== 'string' || !ISO_DATE.test(row.endDate) || !(row.endDate < target)) return null
    accepted.push({ ticker: row.ticker, endDate: row.endDate, lastSuccessDataDate: row.lastSuccessDataDate })
  }
  return { tickers: accepted.sort((a, b) => a.ticker.localeCompare(b.ticker)), runId: run.id }
}

export function checkFreshness(freshness: any, now = new Date(), usCompletion: UsCompletion | null = null,
  usEmptyEvidence: UsEmptyEvidenceSource = null, usRunLog: UsRunLog | null = null): { jp: string; us: string; usIngestion: UsIngestionEvidence } {
  const checkedAt = Date.parse(freshness?.checkedAt ?? '')
  if (!Number.isFinite(checkedAt) || checkedAt > now.getTime() + 5 * 60_000
    || now.getTime() - checkedAt > FRESHNESS_MAX_AGE_MINUTES * 60_000) fail('freshness_report_stale')
  const jp = freshness?.expected?.jp; const us = freshness?.expected?.us
  if (!/^\d{4}-\d{2}-\d{2}$/.test(jp) || !/^\d{4}-\d{2}-\d{2}$/.test(us)) fail('freshness_reference')
  // 確かめる項目は 10/29 の配置と同じ (米国の mlRlPolicy は 10/29 も対象外)。
  for (const key of JP_FRESHNESS_KEYS) if (freshness.dates?.jp?.[key] !== jp) fail(`jp_freshness:${key}`)
  for (const key of US_FRESHNESS_KEYS) if (freshness.dates?.us?.[key] !== us) fail(`us_freshness:${key}`)
  const automation = freshness.usAutomation ?? {}
  if (automation.priceBasis !== PRICE_BASIS.US || automation.derivedPriceBasis !== PRICE_BASIS.US || automation.analogPriceBasis !== PRICE_BASIS.US
    || automation.priceBasisCurrent !== true) fail('us_price_basis')
  // 止める鍵は、米国株の確かめ (空の例外で DB を読むことがある) より前に見る。
  const blocking = (freshness.activeLocks ?? []).filter((lock: string) => lock !== 'trigger_historical_worker')
  if (blocking.length > 0) fail(`blocking_active_locks:${blocking.join(',')}`)
  const usAction = freshness.actions?.find((action: any) => action.key === 'us')
  if (freshness.actions?.find((action: any) => action.key === 'jp-core')?.state !== 'fresh') fail('freshness_action:jp-core')
  let usIngestion: UsIngestionEvidence
  if (automation.ingestionStatus === 'complete' && automation.ingestionNeedsRetry === false) {
    if (usAction?.state !== 'fresh') fail('freshness_action:us')
    usIngestion = { status: 'PASS', ingestionStatus: 'complete', coveragePct: automation.coveragePct ?? null, pendingTargetMissing: 0, completionLatest: usCompletion?.latest ?? null }
  } else if (automation.ingestionStatus === 'partial') {
    // 足りないのが「その日の行が無い」銘柄だけで、最新日が予定どおり、カバー率 98% 以上、派生のデータが最新のときだけ通す。
    const health = freshness.usCoverageHealth ?? {}
    if (health.pmsStatus !== 'ok' || health.featureStatus !== 'ok' || health.pmsDate !== us || health.featureDate !== us) fail('us_derived_health_not_current')
    if (!(Number(automation.coveragePct) >= US_PARTIAL_MIN_COVERAGE_PCT)) fail(`us_partial_coverage_below_${US_PARTIAL_MIN_COVERAGE_PCT}`)
    if (!['fresh', 'would_trigger'].includes(usAction?.state) || !String(usAction?.reason ?? '').includes('stale=-')) fail('freshness_action:us')
    const c = usCompletion
    if (!c || c.status !== 'partial' || c.latest !== us || c.failed !== 0 || c.temporaryNotFound !== 0
      || c.deferred !== 0 || c.promotionGuardTriggered !== 'false' || !(c.pendingTargetMissing > 0)) fail('us_ingestion_failure_not_only_target_missing')
    // ほかの条件がすべて通った後にだけ、空の例外を見る (DB を読むのはこの中で、1〜2 件で全件の回のときだけ)。
    const emptyEnded = acceptEndedEmpties(c.pendingEmpty, us, usEmptyEvidence, usRunLog, c.status)
    if (emptyEnded === null) fail('us_ingestion_failure_not_only_target_missing')
    usIngestion = { status: 'PASS_WITH_RECORDED_PARTIAL_COVERAGE', ingestionStatus: 'partial', coveragePct: automation.coveragePct,
      pendingTargetMissing: c.pendingTargetMissing, completionLatest: c.latest, pendingEmpty: c.pendingEmpty, emptyEndedTickers: emptyEnded.tickers,
      emptyEvidenceRunId: emptyEnded.runId }
  } else fail(`us_ingestion:${automation.ingestionStatus}`)
  return { jp, us, usIngestion }
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
// 本番の DB のフォルダ・LaunchAgents) の中は認めない。シンボリックリンクをたどった実際の場所で判断する。
export function assertOutputDirectory(out: string, releaseRoot: string): string {
  if (!path.isAbsolute(out) || path.resolve(out) !== out) fail('out_must_be_normalized_absolute')
  if (fs.existsSync(out)) fail('out_must_not_exist')
  const real = resolveThroughExistingAncestor(out)
  const forbidden = [releaseRoot, SUPPORT, path.join(home, 'Library', 'LaunchAgents'), path.dirname(DEFAULTS.jpDb), path.dirname(DEFAULTS.usDb)]
  if (forbidden.some((root) => inside(root, out) || inside(resolveThroughExistingAncestor(root), real))) fail('out_inside_production_location')
  return out
}

export function parseArguments(argv: readonly string[]) {
  const value = (name: string) => argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3)
  const mode = argv.includes('--write') ? 'write' as const : argv.includes('--check') ? 'check' as const : fail('mode_--check_or_--write_required')
  const required = (name: string) => value(name) || fail(`--${name}_required`)
  const baseline = required('baseline')
  if (!/^[0-9a-f]{40}$/.test(baseline)) fail('baseline_must_be_40_hex')
  if (argv.includes('--with-http') && mode !== 'check') fail('--with-http_is_only_for_--check')
  // 本当の候補がまだ無いとき、今の本番のビルドと束を「代わりの候補」として確認だけ行う。証明は作らない。
  if (argv.includes('--substitute-candidate') && mode !== 'check') fail('--substitute-candidate_is_only_for_--check')
  return { mode, substituteCandidate: argv.includes('--substitute-candidate'), withHttp: mode === 'write' || argv.includes('--with-http'), releaseRoot: required('release-root'), artifact: required('artifact'), runtime: required('runtime'), baseline,
    priorBaseline: value('prior-baseline'), out: mode === 'write' ? required('out') : null }
}

async function getJson(url: string): Promise<any> {
  const response = await fetch(url, { signal: AbortSignal.timeout(60_000), headers: { 'cache-control': 'no-store' } })
  if (!response.ok) fail(`http_${response.status}:${url}`)
  return response.json()
}

// GIT_OPTIONAL_LOCKS=0: git status が本番の作業用フォルダの index を更新しない。
const command = (file: string, args: string[], cwd?: string) => execFileSync(file, args,
  { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } }).trim()
const statEvidence = (file: string) => { const stat = fs.statSync(file); return { path: file, inode: stat.ino, bytes: stat.size, mtime: stat.mtime.toISOString() } }

// 空で返った銘柄の記録 (読み取りだけ)。対象の日に空で返った銘柄と、Tiingo の銘柄情報の end_date。
export const US_EMPTY_EVIDENCE_SQL = `SELECT a.ticker AS ticker, a.status AS status, a.status_reason AS statusReason,
    a.last_observed_target_date AS lastObservedTargetDate, a.last_success_data_date AS lastSuccessDataDate, u.end_date AS endDate
  FROM market_source_availability a LEFT JOIN market_universe u ON u.market = a.market AND u.ticker = a.ticker
  WHERE a.market = 'US' AND a.source = 'tiingo' AND a.status_reason = 'EMPTY_RESPONSE' AND a.last_observed_target_date = ?
    AND a.updated_at BETWEEN ? AND ?
  ORDER BY a.ticker`
export const US_LATEST_OHLCV_RUN_SQL = `SELECT id, status, started_at AS startedAt, finished_at AS finishedAt, total_tickers AS totalTickers,
    succeeded, rows_inserted AS rowsInserted, payload_json AS payloadJson
  FROM market_data_runs WHERE market = 'US' AND job_type = 'tiingo_ohlcv' ORDER BY id DESC LIMIT 1`
export function readUsEmptyEvidence(dbPath: string, target: string): UsEmptyEvidence {
  const db = new DatabaseSync(dbPath, { readOnly: true, timeout: 30_000 })
  try {
    const run = (db.prepare(US_LATEST_OHLCV_RUN_SQL).get() as UsOhlcvRunRow | undefined) ?? null
    if (!run || run.finishedAt == null) return { run, rows: [] }
    return { run: { ...run }, rows: (db.prepare(US_EMPTY_EVIDENCE_SQL).all(target, run.startedAt, run.finishedAt) as UsEmptyEvidenceRow[]).map((row) => ({ ...row })) }
  } finally { db.close() }
}

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
  // 書き込み中の処理は、鮮度の確かめ (空の例外で DB を読むことがある) より前に見る。
  const processes = command('/bin/ps', ['-axo', 'pid=,ppid=,etime=,state=,command='])
  const writers = writerProcesses(processes)
  if (writers.length > 0) fail(`writer_process:${writers.join('|')}`)
  const freshness = latestFreshness()
  const usLog = fs.readFileSync(DEFAULTS.usUpdateLog, 'utf8')
  // 空で返った銘柄の記録は、checkFreshness の中で、空 1〜2 件・全件の回・ほかの条件が通ったときだけ、JP の DB を読み取りだけで開いて読む。
  const expected = checkFreshness(freshness, new Date(), parseUsCompletion(usLog),
    (target) => readUsEmptyEvidence(DEFAULTS.jpDb, target), parseUsRunLog(usLog))
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

  // Web・類似の検索の状態と、代表の銘柄の株価の履歴 (GET。--check では、--with-http のときだけ)
  const evidence: Record<string, unknown> = {}
  if (args.withHttp) {
    evidence['predeploy-web-health.json'] = await getJson(`${DEFAULTS.web}/api/health`)
    evidence['predeploy-analog-health.json'] = await getJson(`${DEFAULTS.analog}/api/health`)
    evidence['predeploy-1306-period-all.json'] = await getJson(`${DEFAULTS.web}/api/history/1306?period=all&meta=1`)
    evidence['predeploy-SPY-period-all.json'] = await getJson(`${DEFAULTS.web}/api/us/history/SPY?period=all&meta=1`)
    checkHealth(evidence['predeploy-web-health.json'], 'web')
    checkHealth(evidence['predeploy-analog-health.json'], 'analog')
    checkHistory(evidence['predeploy-1306-period-all.json'], '1306', expected.jp)
    checkHistory(evidence['predeploy-SPY-period-all.json'], 'SPY', expected.us)
  }
  evidence['preflight-jp-source.json'] = { status: 'PASS', expectedLatestSession: expected.jp, observedLatestSession: freshness.dates.jp.price,
    source: 'J-Quants daily updater', database: statEvidence(DEFAULTS.jpDb), dailyRunLogSha256: sha256File(DEFAULTS.updateLog) }
  evidence['preflight-us-source.json'] = { expectedLatestSession: expected.us, observedLatestSession: freshness.dates.us.price,
    source: 'Tiingo adjusted OHLC ratio v1', database: statEvidence(DEFAULTS.usDb), universe: freshness.usAutomation.universe,
    covered: freshness.usAutomation.covered, ...expected.usIngestion }
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
    mode: args.mode, candidateKind: args.substituteCandidate ? 'SUBSTITUTE: 代わりの候補 (今の本番のビルドと束) で試した' : 'RELEASE_CANDIDATE',
    usIngestion: expected.usIngestion, candidate: { commit: candidateManifest.candidateCommit, buildId: candidateBuild, artifactTreeSha256: candidateManifest.treeSha256 },
    runtime: { dir: args.runtime, identitySha256: candidateRuntime.hashes.runtimeIdentitySha256, baselineSha: candidateRuntime.baselineSha },
    rollback: { buildId: fs.readFileSync(path.join(live, 'BUILD_ID'), 'utf8').trim(), artifactTreeSha256: activeArtifactTreeIdentity(live).treeSha256,
      runtimeNodeModulesTarget: rollbackTarget, runtimeIdentitySha256: rollbackIdentity },
    expected, storage: { certificationFile, freeBytes }, freshnessCheckedAt: freshness.checkedAt,
  }
  if (!out) {
    console.log(JSON.stringify({ status: 'CHECK_PASS', wroteFiles: false, httpChecked: args.withHttp, ...summary }, null, 2))
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
