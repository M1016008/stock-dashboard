import assert from 'node:assert/strict'
import fs, { readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parseBundleArguments } from './create-release-runtime-bundle'
import { JP_FRESHNESS_KEYS, US_FRESHNESS_KEYS, assertOutputDirectory, checkFreshness, checkHealth, checkHistory, parseArguments, parseUsCompletion, writerProcesses } from './create-sma-release-preflight-proof'
import { REHEARSAL_PARENT, REHEARSAL_PORTS, assertRehearsalRoot } from './rehearse-web-analog-release'

const sha = (c: string) => c.repeat(40)

// 束を作る引数
assert.deepEqual(parseBundleArguments([`--commit=${sha('a')}`, `--baseline=${sha('b')}`, '--out=/tmp/x']), { commit: sha('a'), baseline: sha('b'), out: '/tmp/x' })
assert.throws(() => parseBundleArguments([`--commit=${sha('a')}`, '--baseline=034310b', '--out=/tmp/x']), /baseline/)
assert.throws(() => parseBundleArguments([`--commit=${sha('a')}`, `--baseline=${sha('b')}`, '--out=relative']), /out/)

// 証明: 代表の銘柄の履歴
const row = (date: string) => ({ date, open: 10, high: 11, low: 9, close: 10.5, volume: 100 })
const history = { ticker: '1306', period: 'all', count: 2, rows: [row('2026-11-26'), row('2026-11-27')] }
checkHistory(history, '1306', '2026-11-27')
assert.throws(() => checkHistory(history, '1306', '2026-11-28'), /history_date_or_count/)
assert.throws(() => checkHistory({ ...history, rows: [row('2026-11-27'), row('2026-11-26')] }, '1306', '2026-11-26'), /history_order/)
assert.throws(() => checkHistory({ ...history, count: 2, rows: [row('2026-11-26'), { ...row('2026-11-27'), low: 12 }] }, '1306', '2026-11-27'), /history_ohlc/)

// 証明: 健康の確認
checkHealth({ status: 'ok', overall: 'healthy', storageStatus: 'available' }, 'web')
assert.throws(() => checkHealth({ status: 'degraded', overall: 'degraded', storageStatus: 'verifying' }, 'web'), /health:web/)

// 証明: 鮮度 (米国の取り込みが partial なら止まる)
const dates = (day: string) => Object.fromEntries([...new Set([...JP_FRESHNESS_KEYS, ...US_FRESHNESS_KEYS])].map((key) => [key, day]))
const basis = 'tiingo_adj_ohlc_ratio_v1'
const freshness = {
  checkedAt: new Date(Date.now() - 10 * 60_000).toISOString(),
  expected: { jp: '2026-11-27', us: '2026-11-27' }, dates: { jp: dates('2026-11-27'), us: dates('2026-11-27') },
  usAutomation: { priceBasis: basis, derivedPriceBasis: basis, analogPriceBasis: basis, priceBasisCurrent: true, ingestionStatus: 'complete', ingestionNeedsRetry: false },
  actions: [{ key: 'jp-core', state: 'fresh' }, { key: 'us', state: 'fresh' }], activeLocks: ['trigger_historical_worker'],
}
assert.deepEqual(checkFreshness(freshness).usIngestion.status, 'PASS')
assert.equal(checkFreshness(freshness).us, '2026-11-27')
assert.throws(() => checkFreshness({ ...freshness, checkedAt: new Date(Date.now() - 61 * 60_000).toISOString() }), /freshness_report_stale/)
assert.throws(() => checkFreshness({ ...freshness, checkedAt: 'x' }), /freshness_report_stale/)
// 米国株の partial: 足りないのが「その日の行が無い」銘柄だけ、最新日が予定どおり、カバー率 98% 以上、派生のデータが最新なら、記録を残して通す。
const completionLine = (fields: string) => `US OHLCV complete: status=partial, succeeded=11467, failed=0, pendingEmpty=0, ${fields}, providerNotFound=0, temporaryNotFound=0, newlyPermanent=0, revertedFromPermanent=0, promotionGuardTriggered=false, deferred=0, rows=11591, latest=2026-11-27`
const completion = parseUsCompletion(`x\nUS OHLCV complete: status=partial, succeeded=0, pendingTargetMissing=11570, latest=2026-11-26\n${completionLine('pendingTargetMissing=83')}\n`)!
assert.deepEqual(completion, { status: 'partial', failed: 0, pendingEmpty: 0, pendingTargetMissing: 83, temporaryNotFound: 0, deferred: 0, promotionGuardTriggered: 'false', latest: '2026-11-27' })
const partial = { ...freshness, usAutomation: { ...freshness.usAutomation, ingestionStatus: 'partial', ingestionNeedsRetry: true, coveragePct: 99.28 },
  usCoverageHealth: { pmsStatus: 'ok', featureStatus: 'ok', pmsDate: '2026-11-27', featureDate: '2026-11-27' },
  actions: [{ key: 'jp-core', state: 'fresh' }, { key: 'us', state: 'would_trigger', reason: 'expected=2026-11-27, stale=-, ingestion=partial' }] }
assert.deepEqual(checkFreshness(partial, new Date(), completion).usIngestion,
  { status: 'PASS_WITH_RECORDED_PARTIAL_COVERAGE', ingestionStatus: 'partial', coveragePct: 99.28, pendingTargetMissing: 83, completionLatest: '2026-11-27' })
assert.throws(() => checkFreshness({ ...partial, usAutomation: { ...partial.usAutomation, coveragePct: 97.9 } }, new Date(), completion), /us_partial_coverage_below_98/)
assert.throws(() => checkFreshness(partial, new Date(), { ...completion, failed: 1 }), /not_only_target_missing/)
assert.throws(() => checkFreshness(partial, new Date(), { ...completion, deferred: 2 }), /not_only_target_missing/)
assert.throws(() => checkFreshness(partial, new Date(), { ...completion, latest: '2026-11-26' }), /not_only_target_missing/)
assert.throws(() => checkFreshness(partial, new Date(), null), /not_only_target_missing/)
assert.throws(() => checkFreshness(partial, new Date(), { ...completion, promotionGuardTriggered: null }), /not_only_target_missing/)
// 最後の行が 06:30 の止まった回 (最新日が古い) や古い形の行なら止まる。
const stopped = parseUsCompletion(`${completionLine('pendingTargetMissing=83')}\nUS OHLCV complete: status=partial, succeeded=0, failed=0, pendingEmpty=0, pendingTargetMissing=11570, temporaryNotFound=0, promotionGuardTriggered=false, deferred=0, rows=295, latest=2026-11-26\n`)
assert.throws(() => checkFreshness(partial, new Date(), stopped), /not_only_target_missing/)
assert.throws(() => checkFreshness(partial, new Date(), parseUsCompletion('US OHLCV complete: succeeded=447, failed=0, unavailable=0, deferred=0, rows=0, latest=2026-11-27\n')), /not_only_target_missing/)
assert.throws(() => checkFreshness({ ...partial, dates: { ...partial.dates, us: { ...partial.dates.us, mlSimilar: '2026-11-26' } } }, new Date(), completion), /us_freshness:mlSimilar/)
// 代わりの候補は --check でだけ。
const common = ['--release-root=/x', '--artifact=/a', '--runtime=/r', `--baseline=${sha('c')}`]
assert.equal(parseArguments(['--check', '--substitute-candidate', ...common]).substituteCandidate, true)
assert.throws(() => parseArguments(['--write', '--out=/o', '--substitute-candidate', ...common]), /substitute-candidate_is_only_for_--check/)
assert.match(readFileSync('scripts/create-sma-release-preflight-proof.ts', 'utf8'), /candidateKind: args\.substituteCandidate \? 'SUBSTITUTE: 代わりの候補/)
assert.throws(() => checkFreshness({ ...partial, usCoverageHealth: { ...partial.usCoverageHealth, featureDate: '2026-11-26' } }, new Date(), completion), /us_derived_health_not_current/)
assert.throws(() => checkFreshness({ ...partial, actions: [partial.actions[0], { key: 'us', state: 'would_trigger', reason: 'stale=snapshot' }] }, new Date(), completion), /freshness_action:us/)
assert.throws(() => checkFreshness({ ...freshness, usAutomation: { ...freshness.usAutomation, ingestionStatus: 'failed' } }), /us_ingestion:failed/)
assert.throws(() => checkFreshness({ ...freshness, activeLocks: ['weekly'] }), /blocking_active_locks/)
assert.throws(() => checkFreshness({ ...freshness, dates: { ...freshness.dates, jp: dates('2026-11-26') } }), /jp_freshness/)

// 証明: 書き込み中の処理
assert.deepEqual(writerProcesses('1 1 00:01 S node --import tsx scripts/update-latest.ts\n2 1 00:01 S next-server'), ['1 1 00:01 S node --import tsx scripts/update-latest.ts'])
assert.deepEqual(writerProcesses('2 1 00:01 S node scripts/run-trigger-historical-scan-worker.ts'), [])

// 証明の書き先: 本番の場所の中は認めない
const support = path.join(os.homedir(), 'Library', 'Application Support', 'StockBoard')
assert.throws(() => assertOutputDirectory(path.join(support, 'release-state', 'proof'), '/x/release'), /out_inside_production_location/)
assert.throws(() => assertOutputDirectory('/x/release/proof', '/x/release'), /out_inside_production_location/)
assert.throws(() => assertOutputDirectory('/Volumes/OWC Express 1M2 80G/stock-dashboard/proof', '/x/release'), /out_inside_production_location/)
assert.throws(() => assertOutputDirectory('relative/proof', '/x/release'), /normalized_absolute/)
{
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'proof-out-'))
  fs.symlinkSync(support, path.join(scratch, 'link'))  // 本番の場所を指すシンボリックリンクの下は認めない
  assert.throws(() => assertOutputDirectory(path.join(scratch, 'link', 'new'), '/x/release'), /out_inside_production_location/)
  assert.equal(assertOutputDirectory(path.join(scratch, 'new'), '/x/release'), path.join(scratch, 'new'))
  fs.rmSync(scratch, { recursive: true })
}

// --check は何も書かない: ファイルを書く呼び出しは、すべて「--check なら返る」行より後にある。
const proofSource = readFileSync('scripts/create-sma-release-preflight-proof.ts', 'utf8')
const mainBody = proofSource.slice(proofSource.indexOf('async function main()'))
const checkReturn = mainBody.indexOf("status: 'CHECK_PASS', wroteFiles: false")
assert.ok(checkReturn > 0)
const writes = [...mainBody.matchAll(/fs\.(writeFileSync|mkdirSync|appendFileSync|renameSync|rmSync|unlinkSync|cpSync|symlinkSync|copyFileSync)/g)]
assert.ok(writes.length > 0)
for (const write of writes) assert.ok(write.index! > checkReturn, `write before the --check return: ${write[0]}`)
assert.doesNotMatch(proofSource, /launchctl|kickstart|bootout|bootstrap/)
// --check では Web への GET をしない (/api/health は Storage Guard の記録を書くため)。GET は withHttp のときだけ。
const httpBlock = mainBody.indexOf('if (args.withHttp) {')
for (const call of mainBody.matchAll(/getJson\(/g)) assert.ok(call.index! > httpBlock && httpBlock > 0)
assert.match(proofSource, /GIT_OPTIONAL_LOCKS: '0'/)
assert.doesNotMatch(proofSource, /method:\s*'(POST|PUT|PATCH|DELETE)'/)

// 練習: 場所と port
assert.throws(() => assertRehearsalRoot('/Users/yoshio/dev/practice'), /direct child/)
assert.throws(() => assertRehearsalRoot(path.join(REHEARSAL_PARENT, 'a', 'b')), /direct child/)
assert.equal(assertRehearsalRoot(path.join(REHEARSAL_PARENT, '20261121')), path.join(REHEARSAL_PARENT, '20261121'))
assert.deepEqual(Object.values(REHEARSAL_PORTS), [3200, 3205])
const rehearsalSource = readFileSync('scripts/rehearse-web-analog-release.ts', 'utf8')
assert.doesNotMatch(rehearsalSource, /\/bin\/launchctl|'launchctl'/)
assert.doesNotMatch(rehearsalSource, /stock-dashboard-release-7df6c23|Application Support/)
assert.doesNotMatch(rehearsalSource, /'worktree', 'add'/, 'the rehearsal must not register worktrees in the shared repository')
assert.match(rehearsalSource, /assertOwcDevelopmentVolume\(\)/)

console.log('test-release-proof-tools: ok')
