// scripts/test-us-stage-screener-transport.ts
//
// US Stage Screener の columnar wire (lib/us-hex-wire.ts) の契約テスト。
// - 列順 / 列名 / 型の drift 検知 (snapshot + 旧 compact 行のキー集合との一致)
// - null / 負値 / 0 の保持と、旧 compact 行への完全復元
// - 不正な wire を fail closed で拒否
// - 決定的 fixture (12,451 行) での payload 削減量の下限
// - route / view の配線 (format 別 cache key・単一 request・旧形式維持)

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { gzipSync } from 'node:zlib'
import {
  buildUsHexRow,
  compactUsHexRow,
  type UsHexRawRow,
  type UsHexRow,
} from '@/lib/server/us-hex-serving'
import {
  US_HEX_WIRE_COLUMN_NAMES,
  US_HEX_WIRE_COLUMNS,
  US_HEX_WIRE_FORMAT,
  US_HEX_WIRE_PARAM,
  US_HEX_WIRE_REQUEST,
  US_HEX_WIRE_VERSION,
  UsHexWireError,
  decodeUsHexColumnar,
  encodeUsHexColumnar,
} from '@/lib/us-hex-wire'

// ── 1. schema snapshot: 列の追加・削除・並べ替え・型変更はここで落ちる (変更時は version を上げる) ──
assert.equal(US_HEX_WIRE_FORMAT, 'us-hex-columnar')
assert.equal(US_HEX_WIRE_VERSION, 2)
assert.equal(US_HEX_WIRE_PARAM, 'wire')
assert.equal(US_HEX_WIRE_REQUEST, 'us-hex-columnar.v2')
assert.deepStrictEqual(
  US_HEX_WIRE_COLUMNS.map(([name, kind]) => `${name}:${kind}`),
  [
    'code:text', 'name:text',
    'sector_large:dict', 'sector_small:dict?', 'market_segment:dict?', 'margin_type:dict?',
    'market_cap:num?', 'price:num?',
    'daily_change:num?', 'weekly_change:num?', 'monthly_change:num?',
    'months3_change:num?', 'months6_change:num?', 'ytd_change:num?',
    'data_status:dict', 'stage:num?',
    'daily_a_stage:num?', 'daily_b_stage:num?', 'weekly_a_stage:num?',
    'weekly_b_stage:num?', 'monthly_a_stage:num?', 'monthly_b_stage:num?',
    'sma_angles.sma5:num?', 'sma_angles.sma25:num?', 'sma_angles.sma75:num?', 'sma_angles.sma300:num?',
    'prev_sma_angles.sma5:num?', 'prev_sma_angles.sma25:num?', 'prev_sma_angles.sma75:num?', 'prev_sma_angles.sma300:num?',
    'physical_momentum_score:num?',
  ],
)

// ── 決定的 fixture ──
function mulberry32(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const random = mulberry32(20261014)
const pickOne = <T,>(values: readonly T[]): T => values[Math.floor(random() * values.length)]
const maybe = <T,>(probability: number, value: () => T): T | null => (random() < probability ? null : value())

const SECTORS = [
  'Technology', 'Healthcare', 'Financial Services', 'Consumer Cyclical', 'Industrials', 'Energy',
  'Basic Materials', 'Real Estate', 'Utilities', 'Communication Services', 'Consumer Defensive', 'Unclassified',
]
const INDUSTRIES = Array.from({ length: 220 }, (_, i) => `${pickOne(['Services', 'Manufacturing', 'Wholesale', 'Retail', 'Holding'])}-${pickOne(['Prepackaged Software', 'Pharmaceutical Preparations', 'State Commercial Banks', 'Electronic Computers', 'Real Estate Investment Trusts', 'Crude Petroleum & Natural Gas'])} ${i}`)
const EXCHANGES = ['NASDAQ', 'NYSE', 'NYSE ARCA', 'BATS', 'NYSE MKT']
const NAME_WORDS = ['Global', 'American', 'Capital', 'Holdings', 'Technologies', 'Pharma', 'Energy', 'Trust', 'Income', 'Growth', 'Partners', 'Systems', 'Bancorp', 'Realty', 'Index', 'Fund']
const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'
// 末尾に null / edge の2行を足し、Production実測と同じ12,451行にする。
const ROW_COUNT = 12_449

const tickers = new Set<string>()
while (tickers.size < ROW_COUNT) {
  const length = 1 + Math.floor(random() * 5)
  tickers.add(Array.from({ length }, () => pickOne(LETTERS.split(''))).join(''))
}

// SQL と同じ式で騰落率を作り、実データ同様の full-precision double を生成する
const perf = (current: number | null, base: number | null) =>
  current != null && base != null && base > 0 ? 100.0 * (current - base) / base : null
const roundPrice = (value: number) => Math.round(value * 100) / 100
const stageValue = () => maybe(0.08, () => 1 + Math.floor(random() * 6))
const average = (base: number, n: number) => {
  let sum = 0
  for (let i = 0; i < n; i += 1) sum += roundPrice(base * (0.9 + random() * 0.2))
  return sum / n
}

const rawRows: UsHexRawRow[] = [...tickers].sort().map((ticker) => {
  const price = maybe(0.03, () => roundPrice(Math.exp(random() * 7)))
  const hasSnapshot = price != null && random() > 0.02
  const anchor = (drift: number) => (price == null ? null : maybe(0.05, () => roundPrice(price * (1 + (random() - 0.5) * drift))))
  const ma = () => (price == null || !hasSnapshot ? null : maybe(0.05, () => average(price, 5)))
  const assetRoll = random()
  return {
    ticker,
    snapshot_ticker: hasSnapshot ? ticker : null,
    name: `${pickOne(NAME_WORDS)} ${pickOne(NAME_WORDS)} ${pickOne(['Inc.', 'Corp.', 'Ltd.', 'ETF', 'Co.'])}`,
    exchange: maybe(0.02, () => pickOne(EXCHANGES)),
    asset_type: assetRoll < 0.7 ? 'Stock' : assetRoll < 0.95 ? 'ETF' : 'Mutual Fund',
    sector: pickOne(SECTORS),
    industry: maybe(0.1, () => pickOne(INDUSTRIES)),
    shares_outstanding: maybe(0.25, () => Math.floor(random() * 5e9)),
    price,
    perf_1d: perf(price, anchor(0.06)),
    perf_1w: perf(price, anchor(0.12)),
    perf_1m: perf(price, anchor(0.25)),
    perf_3m: perf(price, anchor(0.4)),
    perf_6m: perf(price, anchor(0.6)),
    perf_ytd: perf(price, anchor(0.8)),
    daily_a_stage: hasSnapshot ? stageValue() : null,
    daily_b_stage: hasSnapshot ? stageValue() : null,
    weekly_a_stage: hasSnapshot ? stageValue() : null,
    weekly_b_stage: hasSnapshot ? stageValue() : null,
    monthly_a_stage: hasSnapshot ? stageValue() : null,
    monthly_b_stage: hasSnapshot ? stageValue() : null,
    ma_5: ma(), ma_25: ma(), ma_75: ma(), ma_300: ma(),
    prev_ma_5: ma(), prev_ma_25: ma(), prev_ma_75: ma(), prev_ma_300: ma(),
    prev2_ma_5: ma(), prev2_ma_25: ma(), prev2_ma_75: ma(), prev2_ma_300: ma(),
  }
})

// null / 0 / 負値 / -0 / 境界値を明示的に含む行
const nullRow: UsHexRawRow = {
  ticker: 'ZZNULL', snapshot_ticker: null, name: null, exchange: null, asset_type: null, sector: null, industry: null,
  shares_outstanding: null, price: null, perf_1d: null, perf_1w: null, perf_1m: null, perf_3m: null, perf_6m: null, perf_ytd: null,
  daily_a_stage: null, daily_b_stage: null, weekly_a_stage: null, weekly_b_stage: null, monthly_a_stage: null, monthly_b_stage: null,
  ma_5: null, ma_25: null, ma_75: null, ma_300: null, prev_ma_5: null, prev_ma_25: null, prev_ma_75: null, prev_ma_300: null,
  prev2_ma_5: null, prev2_ma_25: null, prev2_ma_75: null, prev2_ma_300: null,
}
const edgeRow: UsHexRawRow = {
  ...nullRow,
  ticker: 'ZZZERO', snapshot_ticker: 'ZZZERO', name: 'Zero Edge', exchange: 'NYSE', asset_type: 'ETF', sector: 'Energy', industry: 'Oil',
  shares_outstanding: 0, price: 0, perf_1d: 0, perf_1w: -0, perf_1m: -12.5, perf_3m: -0.000001, perf_6m: 1e-12, perf_ytd: -99.99999999999999,
  daily_a_stage: 1, daily_b_stage: 6, weekly_a_stage: 3, weekly_b_stage: null, monthly_a_stage: 4, monthly_b_stage: 5,
  ma_5: 10, prev_ma_5: 10, prev2_ma_5: 12, ma_25: 9, prev_ma_25: 10, prev2_ma_25: 0, ma_75: 0, prev_ma_75: 1, prev2_ma_75: -1,
}
rawRows.push(nullRow, edgeRow)

const momentum = new Map<string, number | null>()
rawRows.forEach((row, i) => {
  if (i % 5 !== 0) momentum.set(row.ticker, i % 7 === 0 ? null : (random() - 0.5) * 6)
})
momentum.set('ZZNULL', null)
momentum.set('ZZZERO', 0)

const legacyRows: UsHexRow[] = rawRows.map((row) => buildUsHexRow(row, 'daily', momentum))
const compactRows = legacyRows.map(compactUsHexRow)
const meta = {
  count: compactRows.length,
  date: '2026-10-09',
  timeframe: 'daily' as const,
  source: 'tiingo' as const,
  universe: { activeAll: 13002, productionActive: 12451, stocks: 8700, etfs: 3100, mutualFunds: 651, testSymbols: 12, excludedArtifacts: 539 },
  coverage: { prices: 12000, snapshots: 11800, dailyAStage: 11000, dailyStage: 10500, weeklyStage: 10000, monthlyStage: 9000 },
  cache: 'miss' as const,
  attributeBasis: {
    membership: 'CURRENT_UNIVERSE' as const,
    profiles: 'CURRENT_REFERENCE' as const,
    classifications: 'CURRENT_REFERENCE' as const,
    shares: 'CURRENT_REFERENCE' as const,
  },
}
const compactJson = JSON.stringify({ success: true, data: compactRows, ...meta })
const wireJson = JSON.stringify({ success: true, ...encodeUsHexColumnar(compactRows), ...meta })

// ── 2. 完全復元: decode(wire) は旧 compact=1 の JSON と deepStrictEqual (値・null・型すべて) ──
const expectedRows = JSON.parse(compactJson).data
const decoded = decodeUsHexColumnar(JSON.parse(wireJson))
assert.deepStrictEqual(decoded.rows, expectedRows)
assert.equal(decoded.count, compactRows.length)
assert.equal(decoded.date, meta.date)
assert.equal(decoded.timeframe, meta.timeframe)
assert.equal(decoded.source, meta.source)
assert.deepStrictEqual(decoded.universe, meta.universe)
assert.deepStrictEqual(decoded.coverage, meta.coverage)
assert.equal(decoded.cache, 'miss')
assert.deepStrictEqual(decoded.attributeBasis, meta.attributeBasis)

// 数値は bit 単位で同一 (丸めない)
compactRows.forEach((row, i) => {
  const out = decoded.rows[i]
  for (const key of ['market_cap', 'price', 'daily_change', 'ytd_change', 'physical_momentum_score'] as const) {
    const a = JSON.parse(JSON.stringify(row[key]))
    assert.ok(Object.is(a, out[key]), `${row.code}.${key} must round-trip exactly`)
  }
})

// 旧 compact 行のキー集合 (ネストは平坦化) == wire 列集合。サーバ行にフィールドが増えたら落ちる
const flatKeys = (row: Record<string, unknown>) => Object.entries(row).flatMap(([key, value]) =>
  value != null && typeof value === 'object' ? Object.keys(value).map((child) => `${key}.${child}`) : [key])
for (const row of [expectedRows[0], expectedRows.at(-1), expectedRows.at(-2)]) {
  assert.deepStrictEqual(flatKeys(row).sort(), [...US_HEX_WIRE_COLUMN_NAMES].sort())
}

// null / 0 / 負値の保持
const nullOut = decoded.rows.find((row) => row.code === 'ZZNULL')
const edgeOut = decoded.rows.find((row) => row.code === 'ZZZERO')
assert.ok(nullOut && edgeOut)
assert.equal(nullOut.price, null)
assert.equal(nullOut.market_cap, null)
assert.equal(nullOut.sector_small, null)
assert.equal(nullOut.market_segment, null)
assert.equal(nullOut.margin_type, null)
assert.equal(nullOut.sector_large, 'Unclassified')
assert.equal(nullOut.daily_change, null)
assert.equal(nullOut.stage, null)
assert.equal(nullOut.physical_momentum_score, null)
assert.deepStrictEqual(nullOut.sma_angles, { sma5: null, sma25: null, sma75: null, sma300: null })
assert.equal(nullOut.data_status, 'price_pending')
assert.equal(edgeOut.price, 0)
assert.equal(edgeOut.market_cap, null)
assert.equal(edgeOut.daily_change, 0)
assert.equal(edgeOut.weekly_change, 0, '-0 serializes as 0 in both legacy JSON and wire')
assert.equal(edgeOut.monthly_change, -12.5)
assert.equal(edgeOut.months3_change, -0.000001)
assert.equal(edgeOut.months6_change, 1e-12)
assert.equal(edgeOut.ytd_change, -99.99999999999999)
assert.equal(edgeOut.weekly_b_stage, null)
assert.equal(edgeOut.data_status, 'partial_stage')
assert.equal(edgeOut.sma_angles.sma5, 0)
assert.equal(edgeOut.sma_angles.sma25, -10)
assert.equal(edgeOut.sma_angles.sma75, -100)
assert.equal(edgeOut.prev_sma_angles.sma25, null, 'previous <= 0 stays null')
assert.equal(edgeOut.physical_momentum_score, 0)

// 空レスポンス (日付なし) も decode できる
const empty = decodeUsHexColumnar(JSON.parse(JSON.stringify({
  success: true, ...encodeUsHexColumnar([]), count: 0, date: null, timeframe: 'daily', source: 'tiingo', notice: 'none',
})))
assert.deepStrictEqual(empty.rows, [])
assert.equal(empty.universe, null)
assert.equal(empty.notice, 'none')

// ── 3. fail closed ──
const base = () => JSON.parse(wireJson)
const rejects = (label: string, mutate: (body: Record<string, any>) => unknown) => {
  const body = base()
  const replaced = mutate(body)
  assert.throws(() => decodeUsHexColumnar(replaced === undefined ? body : replaced), UsHexWireError, label)
}
const col = (name: string) => US_HEX_WIRE_COLUMN_NAMES.indexOf(name as never)
rejects('non-object', () => null)
rejects('array payload', () => [])
rejects('legacy compact payload', () => JSON.parse(compactJson))
rejects('success false', (b) => { b.success = false })
rejects('missing wire', (b) => { delete b.wire })
rejects('wrong format', (b) => { b.wire.format = 'us-hex-rows' })
rejects('future version', (b) => { b.wire.version = 3 })
rejects('string version', (b) => { b.wire.version = '1' })
rejects('reordered columns', (b) => { [b.wire.columns[8], b.wire.columns[9]] = [b.wire.columns[9], b.wire.columns[8]] })
rejects('missing column name', (b) => { b.wire.columns.pop() })
rejects('extra column name', (b) => { b.wire.columns.push('extra') })
rejects('missing column data', (b) => { b.columns.pop() })
rejects('column too short', (b) => { b.columns[col('price')].pop() })
rejects('count mismatch', (b) => { b.count += 1 })
rejects('negative count', (b) => { b.count = -1 })
rejects('null in non-null text', (b) => { b.columns[col('code')][0] = null })
rejects('number in text', (b) => { b.columns[col('name')][0] = 1 })
rejects('string in number', (b) => { b.columns[col('price')][0] = '12.5' })
rejects('string in nullable number', (b) => { b.columns[col('market_cap')][0] = 'unknown' })
rejects('non-finite number', (b) => { b.columns[col('daily_change')][0] = Number.POSITIVE_INFINITY })
rejects('dict index out of range', (b) => { b.columns[col('sector_large')][0] = b.dictionaries.sector_large.length })
rejects('fractional dict index', (b) => { b.columns[col('sector_large')][0] = 0.5 })
rejects('null in non-null dict', (b) => { b.columns[col('sector_large')][0] = null })
rejects('missing dictionary', (b) => { delete b.dictionaries.sector_small })
rejects('non-string dictionary', (b) => { b.dictionaries.market_segment[0] = 3 })
rejects('unknown data_status', (b) => { b.dictionaries.data_status[0] = 'stale' })
rejects('invalid timeframe', (b) => { b.timeframe = 'hourly' })
rejects('invalid date', (b) => { b.date = '20261009' })
rejects('invalid source', (b) => { b.source = 'yahoo' })
rejects('invalid coverage', (b) => { b.coverage.prices = null })
rejects('invalid universe', (b) => { b.universe = [] })
rejects('invalid cache', (b) => { b.cache = 'stale' })
rejects('invalid attribute basis', (b) => { b.attributeBasis.shares = 'INFERRED' })
assert.throws(() => encodeUsHexColumnar([{ ...compactRows[0], sector_large: null as never }]), UsHexWireError)

// ── 4. payload 削減量 (決定的 fixture。閾値を割ったら transport の後退) ──
const compactBytes = Buffer.byteLength(compactJson)
const wireBytes = Buffer.byteLength(wireJson)
const compactGzip = gzipSync(compactJson).length
const wireGzip = gzipSync(wireJson).length
const plainReduction = 1 - wireBytes / compactBytes
const gzipReduction = 1 - wireGzip / compactGzip
console.log(
  `fixture ${compactRows.length} rows: compact JSON ${compactBytes.toLocaleString()} B / gzip ${compactGzip.toLocaleString()} B`
  + ` → columnar ${wireBytes.toLocaleString()} B / gzip ${wireGzip.toLocaleString()} B`
  + ` (plain -${(plainReduction * 100).toFixed(1)}%, gzip -${(gzipReduction * 100).toFixed(1)}%)`,
)
assert.ok(plainReduction >= 0.5, `plain payload must shrink by >= 50% (got ${(plainReduction * 100).toFixed(1)}%)`)
assert.ok(gzipReduction >= 0.2, `gzip payload must shrink by >= 20% (got ${(gzipReduction * 100).toFixed(1)}%)`)

// ── 5. route / view 配線 ──
const routeSource = readFileSync('app/api/us/hex/route.ts', 'utf8')
const viewSource = readFileSync('components/hex/HexStageMapView.tsx', 'utf8')
const smokeSource = readFileSync('scripts/smoke-production-site.ts', 'utf8')
assert.match(routeSource, /const cacheKey = `all-investable-v5:current:\$\{date\}:\$\{timeframe\}:\$\{format\}:\$\{generationKey\(startingGeneration\)\}`/, 'current cache must include the attested source generation')
assert.match(routeSource, /const cached = historical \? null : cache\.get\(cacheKey\)/, 'historical PIT responses must not use the mutable in-process cache')
assert.match(routeSource, /sameGeneration\(startingGeneration, completedGeneration\)/, 'source generation must be rechecked after the query')
assert.match(routeSource, /CACHE_MAX_ENTRIES = 4/)
assert.match(routeSource, /CACHE_MAX_BYTES = 64 \* 1024 \* 1024/)
assert.match(routeSource, /wire != null \? 'columnar-v1' : compact \? 'compact-v1' : 'legacy-v1'/, 'legacy and compact responses must remain')
assert.match(routeSource, /wire != null && wire !== US_HEX_WIRE_REQUEST[\s\S]{0,300}status: 400/, 'unknown wire versions must be rejected')
assert.match(routeSource, /content-encoding', 'gzip'/)
assert.match(routeSource, /serializedJsonResponse\(request, cached\.hitResponse\)/)
assert.equal((viewSource.match(/fetch\(`\$\{isUs \? '\/api\/us\/hex' : '\/api\/hex'\}\?/g) ?? []).length, 1, 'one data request per load')
assert.match(viewSource, /params\.set\(US_HEX_WIRE_PARAM, US_HEX_WIRE_REQUEST\)/)
assert.match(viewSource, /const decoded = decodeUsHexColumnar\(json\)/)
assert.doesNotMatch(viewSource, /compact', '1'/)
assert.match(
  viewSource,
  /\.catch\(\(e\) => \{\s*if \(cancelled\) return\s*setError\(\(e as Error\)\.message\)\s*\/\/[^\n]*\n\s*if \(isUs\) \{\s*setData\(\[\]\)/,
  'decode failures must surface as UI errors without stale US rows',
)
assert.match(
  smokeSource,
  /\/api\/us\/hex\?timeframe=daily&wire=us-hex-columnar\.v2/,
  'Production smoke must exercise the transport used by the US Stage Screener client.',
)

console.log('US Stage Screener transport tests: PASS')
