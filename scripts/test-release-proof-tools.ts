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
  { status: 'PASS_WITH_RECORDED_PARTIAL_COVERAGE', ingestionStatus: 'partial', coveragePct: 99.28, pendingTargetMissing: 83, completionLatest: '2026-11-27',
    pendingEmpty: 0, emptyEndedTickers: [] })
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
import { US_EMPTY_EVIDENCE_SQL, acceptEndedEmpties, parseUsFetchStart, readUsEmptyEvidence } from './create-sma-release-preflight-proof'
// @ts-expect-error The pinned Node types predate Node 24's built-in SQLite module.
import { DatabaseSync } from 'node:sqlite'
// 空で返った銘柄 (pendingEmpty) の例外 (11/19 の IBO): 全件の回で、Tiingo の end_date が対象の日より前の銘柄だけ、1〜2 件まで、DB の記録と数が一致するときだけ通す。
{
  const ibo = { ticker: 'IBO', status: 'PENDING', statusReason: 'EMPTY_RESPONSE', lastObservedTargetDate: '2026-11-27', lastSuccessDataDate: '2026-11-20', endDate: '2026-11-26' }
  const full = { targets: 11571, activeInvestable: 11571, slaTargetDate: '2026-11-27' }
  const withEmpty = (n: number) => ({ ...completion, pendingEmpty: n })
  const second = { ...ibo, ticker: 'ZZZ', endDate: '2026-11-25' }
  const ok = (c: any, rows: any, start: any = full) => checkFreshness(partial, new Date(), c, rows, start).usIngestion
  const stop = (c: any, rows: any, start: any = full) => assert.throws(() => checkFreshness(partial, new Date(), c, rows, start), /not_only_target_missing/)
  assert.deepEqual(ok(withEmpty(1), [ibo]),
    { status: 'PASS_WITH_RECORDED_PARTIAL_COVERAGE', ingestionStatus: 'partial', coveragePct: 99.28, pendingTargetMissing: 83, completionLatest: '2026-11-27',
      pendingEmpty: 1, emptyEndedTickers: [{ ticker: 'IBO', endDate: '2026-11-26', lastSuccessDataDate: '2026-11-20' }] })
  assert.deepEqual(ok(withEmpty(2), [second, ibo]).emptyEndedTickers?.map((row) => row.ticker), ['IBO', 'ZZZ'])
  // 止まるもの: 記録を渡していない・記録が無い・数が合わない、3 件以上、end_date が対象の日以降・無い・形が違う、別の日の記録、空でない状態、同じ銘柄の重複。
  stop(withEmpty(1), null); stop(withEmpty(1), []); stop(withEmpty(1), [ibo, second]); stop(withEmpty(2), [ibo])
  stop(withEmpty(3), [ibo, second, { ...ibo, ticker: 'YYY' }])
  for (const endDate of ['2026-11-27', '2026-11-28', null, '2026/11/26']) stop(withEmpty(1), [{ ...ibo, endDate }])
  stop(withEmpty(1), [{ ...ibo, lastObservedTargetDate: '2026-11-26' }]); stop(withEmpty(1), [{ ...ibo, status: 'PERMANENTLY_UNAVAILABLE' }])
  stop(withEmpty(1), [{ ...ibo, statusReason: 'TARGET_DATE_MISSING' }]); stop(withEmpty(2), [ibo, ibo])
  // 一部だけの回 (TICKERS・US_OHLCV_LIMIT・US_INCLUDE_INACTIVE で targets と activeInvestable が違う)、始まりの行が無い、対象の日が違う回は止まる。
  stop(withEmpty(1), [ibo], { ...full, targets: 1 }); stop(withEmpty(1), [ibo], { ...full, targets: 12000 }); stop(withEmpty(1), [ibo], null)
  stop(withEmpty(1), [ibo], { ...full, slaTargetDate: '2026-11-26' }); stop(withEmpty(1), [ibo], { targets: NaN, activeInvestable: NaN, slaTargetDate: '2026-11-27' })
  // 空の例外があっても、ほかの失敗は今までどおり止まる (取り込みの失敗・残り・一時的な 404・昇格の歯止め・最新日・その日の行が無い 0 件・状態)。
  for (const change of [{ failed: 1 }, { deferred: 1 }, { temporaryNotFound: 1 }, { promotionGuardTriggered: 'true' }, { latest: '2026-11-26' }, { pendingTargetMissing: 0 }, { status: 'failed' }])
    stop({ ...withEmpty(1), ...change }, [ibo])
  assert.throws(() => checkFreshness({ ...partial, usAutomation: { ...partial.usAutomation, coveragePct: 97.9 } }, new Date(), withEmpty(1), [ibo], full), /us_partial_coverage_below_98/)
  // DB を読む関数は、空 1〜2 件・全件の回・ほかの安い条件が通ったときにだけ呼ばれる。
  let calls = 0
  const loader = (target: string) => { calls += 1; assert.equal(target, '2026-11-27'); return [ibo] }
  checkFreshness(partial, new Date(), completion, loader, full); assert.equal(calls, 0, 'empty 0: no DB read')
  stop(withEmpty(3), loader); stop({ ...withEmpty(1), failed: 1 }, loader); stop({ ...withEmpty(1), latest: '2026-11-26' }, loader); stop(withEmpty(1), loader, { ...full, targets: 1 })
  assert.equal(calls, 0, 'no DB read when another condition already fails')
  assert.deepEqual(ok(withEmpty(1), loader).emptyEndedTickers, [{ ticker: 'IBO', endDate: '2026-11-26', lastSuccessDataDate: '2026-11-20' }]); assert.equal(calls, 1)
  // 空 0 件の日は今までどおり。古い形の行 (pendingEmpty が読めない) は止まる。
  assert.deepEqual(acceptEndedEmpties(0, '2026-11-27', null), [])
  assert.equal(acceptEndedEmpties(Number.NaN, '2026-11-27', [ibo], full), null)
  // 始まりの行: 最後の「complete」の行に対応する、いちばん近い前の「fetch start」の行を読む (11/19 の本番のログの 2 回分を書き写し)。
  const log = ['US OHLCV fetch start: targets=11566, concurrency=2, slaTargetDate=2026-11-18, activeInvestable=11566',
    'US OHLCV complete: status=partial, succeeded=0, failed=0, pendingEmpty=0, pendingTargetMissing=11566, providerNotFound=0, temporaryNotFound=0, newlyPermanent=0, revertedFromPermanent=0, promotionGuardTriggered=false, deferred=0, rows=303, latest=2026-11-17',
    'US latest update started: expected=2026-11-18, ohlcv=2026-11-17, snapshots=2026-11-17',
    'US OHLCV fetch start: targets=11571, concurrency=2, slaTargetDate=2026-11-18, activeInvestable=11571',
    '[11571/11571] rows=11657, failed=0, empty=1, notFound=0',
    'US OHLCV complete: status=partial, succeeded=11498, failed=0, pendingEmpty=1, pendingTargetMissing=72, providerNotFound=0, temporaryNotFound=0, newlyPermanent=0, revertedFromPermanent=0, promotionGuardTriggered=false, deferred=0, rows=11657, latest=2026-11-18', ''].join('\n')
  assert.deepEqual(parseUsFetchStart(log), { targets: 11571, activeInvestable: 11571, slaTargetDate: '2026-11-18' })
  assert.equal(parseUsFetchStart(log.split('\n').filter((row) => !row.startsWith('US OHLCV fetch start: targets=11571')).join('\n')), null, 'must not reach across the previous run')
  assert.equal(parseUsFetchStart('nothing\n'), null)
  // 本物の SQLite で、11/19 の本番の値そのもの (IBO・対象の日 2026-11-18・end_date 2026-11-17・最後の値 2026-11-11) を読み、そのまま通ることを確かめる。
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'proof-us-empty-'))
  const dbPath = path.join(dir, 'stockboard.db')
  const setup = new DatabaseSync(dbPath)
  setup.exec(`CREATE TABLE market_source_availability (market TEXT, ticker TEXT, source TEXT, status TEXT, status_reason TEXT, terminal_evidence_count INTEGER,
      first_terminal_target_date TEXT, last_terminal_target_date TEXT, last_terminal_run_id INTEGER, last_observation_type TEXT, last_observed_target_date TEXT,
      last_success_data_date TEXT, last_http_status INTEGER, updated_at INTEGER, PRIMARY KEY (market, ticker, source));
    CREATE TABLE market_universe (market TEXT, ticker TEXT, name TEXT, active INTEGER, end_date TEXT, PRIMARY KEY (market, ticker));
    INSERT INTO market_source_availability VALUES ('US','IBO','tiingo','PENDING','EMPTY_RESPONSE',0,NULL,NULL,NULL,'EMPTY','2026-11-18','2026-11-11',200,1795056707);
    INSERT INTO market_source_availability VALUES ('US','OLD','tiingo','PENDING','EMPTY_RESPONSE',0,NULL,NULL,NULL,'EMPTY','2026-11-17','2026-11-01',200,1);
    INSERT INTO market_source_availability VALUES ('US','AAPL','tiingo','AVAILABLE','TARGET_DATE_PRESENT',0,NULL,NULL,NULL,'DATA','2026-11-18','2026-11-18',200,1);
    INSERT INTO market_source_availability VALUES ('JP','IBO','tiingo','PENDING','EMPTY_RESPONSE',0,NULL,NULL,NULL,'EMPTY','2026-11-18',NULL,200,1);
    INSERT INTO market_universe VALUES ('US','IBO','IBO',1,'2026-11-17'), ('US','OLD','OLD',0,'2026-11-01'), ('US','AAPL','AAPL',1,'2026-11-18');`)
  setup.close()
  const rows = readUsEmptyEvidence(dbPath, '2026-11-18')
  assert.deepEqual(rows.map((row) => ({ ...row })), [{ ticker: 'IBO', status: 'PENDING', statusReason: 'EMPTY_RESPONSE', lastObservedTargetDate: '2026-11-18', lastSuccessDataDate: '2026-11-11', endDate: '2026-11-17' }])
  const day = (d: string) => ({ ...partial, expected: { jp: d, us: d }, dates: { jp: dates(d), us: dates(d) },
    usCoverageHealth: { ...partial.usCoverageHealth, pmsDate: d, featureDate: d },
    actions: [{ key: 'jp-core', state: 'fresh' }, { key: 'us', state: 'would_trigger', reason: `expected=${d}, price=${d}, stale=-, coverage=99.37%, ingestion=partial` }] })
  const real = checkFreshness(day('2026-11-18'), new Date(), parseUsCompletion(log), (target) => readUsEmptyEvidence(dbPath, target), parseUsFetchStart(log))
  assert.deepEqual(real.usIngestion.emptyEndedTickers, [{ ticker: 'IBO', endDate: '2026-11-17', lastSuccessDataDate: '2026-11-11' }])
  assert.equal(real.usIngestion.pendingEmpty, 1); assert.equal(real.usIngestion.pendingTargetMissing, 72)
  // 読み取りの開き方では書けない (同じ開き方で書き込みを試すと失敗する)。
  const readOnly = new DatabaseSync(dbPath, { readOnly: true, timeout: 30_000 })
  assert.throws(() => readOnly.exec("UPDATE market_universe SET active = 0 WHERE ticker = 'IBO'"), /readonly|read-only/i)
  readOnly.close()
  fs.rmSync(dir, { recursive: true })
  // 記録を読む SQL は読み取りだけ (SELECT) で、対象の日・空の理由・Tiingo の米国株だけに絞る。証明の米国株の記録のファイルに usIngestion (銘柄名と end_date) が入る。
  assert.match(US_EMPTY_EVIDENCE_SQL, /^SELECT /)
  assert.doesNotMatch(US_EMPTY_EVIDENCE_SQL, /\b(INSERT|UPDATE|DELETE|REPLACE|CREATE|DROP|ALTER|PRAGMA|ATTACH)\b/i)
  const proofSource = readFileSync('scripts/create-sma-release-preflight-proof.ts', 'utf8')
  assert.match(proofSource, /new DatabaseSync\(dbPath, \{ readOnly: true/)
  assert.match(proofSource, /evidence\['preflight-us-source\.json'\] = \{[^}]*\.\.\.expected\.usIngestion \}/)
}
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
