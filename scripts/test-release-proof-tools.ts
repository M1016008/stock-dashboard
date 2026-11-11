import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parseBundleArguments } from './create-release-runtime-bundle'
import { assertOutputDirectory, checkFreshness, checkHealth, checkHistory, writerProcesses } from './create-sma-release-preflight-proof'
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
const dates = (day: string) => Object.fromEntries(['price', 'snapshot', 'dashboardCache', 'physicalScores', 'feature', 'mlFeature', 'mlPrediction'].map((key) => [key, day]))
const basis = 'tiingo_adj_ohlc_ratio_v1'
const freshness = {
  expected: { jp: '2026-11-27', us: '2026-11-27' }, dates: { jp: dates('2026-11-27'), us: dates('2026-11-27') },
  usAutomation: { priceBasis: basis, derivedPriceBasis: basis, analogPriceBasis: basis, priceBasisCurrent: true, ingestionStatus: 'complete', ingestionNeedsRetry: false },
  actions: [{ key: 'jp-core', state: 'fresh' }, { key: 'us', state: 'fresh' }], activeLocks: ['trigger_historical_worker'],
}
assert.deepEqual(checkFreshness(freshness), { jp: '2026-11-27', us: '2026-11-27' })
assert.throws(() => checkFreshness({ ...freshness, usAutomation: { ...freshness.usAutomation, ingestionStatus: 'partial', ingestionNeedsRetry: true } }), /us_price_basis_or_ingestion/)
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

// --check は何も書かない: ファイルを書く呼び出しは、すべて「--check なら返る」行より後にある。
const proofSource = readFileSync('scripts/create-sma-release-preflight-proof.ts', 'utf8')
const mainBody = proofSource.slice(proofSource.indexOf('async function main()'))
const checkReturn = mainBody.indexOf("status: 'CHECK_PASS', wroteFiles: false")
assert.ok(checkReturn > 0)
const writes = [...mainBody.matchAll(/fs\.(writeFileSync|mkdirSync|appendFileSync|renameSync|rmSync|unlinkSync|cpSync|symlinkSync|copyFileSync)/g)]
assert.ok(writes.length > 0)
for (const write of writes) assert.ok(write.index! > checkReturn, `write before the --check return: ${write[0]}`)
assert.doesNotMatch(proofSource, /launchctl|kickstart|bootout|bootstrap/)
assert.doesNotMatch(proofSource, /method:\s*'(POST|PUT|PATCH|DELETE)'/)

// 練習: 場所と port
assert.throws(() => assertRehearsalRoot('/Users/yoshio/dev/practice'), /direct child/)
assert.throws(() => assertRehearsalRoot(path.join(REHEARSAL_PARENT, 'a', 'b')), /direct child/)
assert.equal(assertRehearsalRoot(path.join(REHEARSAL_PARENT, '20261121')), path.join(REHEARSAL_PARENT, '20261121'))
assert.deepEqual(Object.values(REHEARSAL_PORTS), [3200, 3205])
const rehearsalSource = readFileSync('scripts/rehearse-web-analog-release.ts', 'utf8')
assert.doesNotMatch(rehearsalSource, /\/bin\/launchctl|'launchctl'/)
assert.doesNotMatch(rehearsalSource, /stock-dashboard-release-7df6c23|Application Support/)

console.log('test-release-proof-tools: ok')
