import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  US_TRIGGER_DEFAULTS,
  buildUsTriggerRequest,
  defaultUsTriggerDraft,
  isPastUsTriggerDate,
  usdFromMillions,
  usMiniChartKey,
  usTriggerStateFromRequest,
  type UsTriggerDraft,
} from '@/components/us/trigger-discovery/usTriggerDiscoveryShared'
import { parseTriggerDiscoveryMiniChartsRequest } from '@/lib/server/trigger-discovery-mini-charts'
import {
  savedTriggerConfigsFromSearchRequest,
  searchRequestFromSavedTrigger,
} from '@/lib/trigger-definition'
import { runUsTriggerDiscoveryMaParityTests } from './test-us-trigger-discovery-ma-parity'

const LATEST_AS_OF = '2026-10-09'

const latestDraft = defaultUsTriggerDraft(LATEST_AS_OF)
latestDraft.exchanges = ['NASDAQ', 'NYSE']
const latestRequest = buildUsTriggerRequest(latestDraft, {
  sort: null,
  pageSize: US_TRIGGER_DEFAULTS.pageSize,
  statusFilter: null,
}, LATEST_AS_OF)

assert.equal(latestRequest.requestedAsOf, LATEST_AS_OF)
assert.equal(latestRequest.timeframe, 'MONTHLY')
assert.deepEqual(latestRequest.markets, ['NASDAQ', 'NYSE'])
assert.equal(latestRequest.averageTradingValueMin, 5_000_000)
assert.equal(latestRequest.page, 1)
assert.equal(latestRequest.pageSize, 50)

const unclassifiedDraft = defaultUsTriggerDraft(LATEST_AS_OF)
unclassifiedDraft.exchanges = ['UNCLASSIFIED']
assert.deepEqual(buildUsTriggerRequest(unclassifiedDraft, {
  sort: null,
  pageSize: US_TRIGGER_DEFAULTS.pageSize,
  statusFilter: null,
}, LATEST_AS_OF).markets, [null], 'unclassified exchange must match null candidate market')

const historicalDraft = { ...latestDraft, asOf: '2025-12-31' }
const historicalRequest = buildUsTriggerRequest(historicalDraft, {
  sort: { key: 'triggerScore', direction: 'desc' },
  pageSize: 25,
  statusFilter: 'NEAR',
}, LATEST_AS_OF)

assert.equal(isPastUsTriggerDate(historicalDraft.asOf, LATEST_AS_OF), true)
assert.equal(historicalRequest.markets, undefined, 'historical requests must not reuse current exchange membership')
assert.deepEqual(historicalRequest.sort, { key: 'triggerScore', direction: 'desc' })
assert.equal(historicalRequest.statusFilter, 'NEAR')
assert.equal(historicalRequest.pageSize, 25)
assert.equal(usdFromMillions(1.25), 1_250_000)
assert.equal(usdFromMillions(null), null)

const monthlyChartKey = usMiniChartKey({
  ticker: 'brk.b',
  timeframe: 'MONTHLY',
  date: LATEST_AS_OF,
  ma1Period: 20,
  ma2Period: 25,
})
assert.equal(monthlyChartKey, `BRK.B|MONTHLY|${LATEST_AS_OF}|20|25`)
assert.notEqual(monthlyChartKey, usMiniChartKey({
  ticker: 'BRK.B',
  timeframe: 'BIWEEKLY',
  date: LATEST_AS_OF,
  ma1Period: 20,
  ma2Period: 25,
}))

for (const ticker of ['F', 'GM', 'BRK.B', 'BRK-B', 'A1']) {
  const parsed = parseTriggerDiscoveryMiniChartsRequest({
    tickers: [ticker],
    requestedAsOf: LATEST_AS_OF,
    timeframe: 'MONTHLY',
    ma1Period: 20,
    ma2Period: 25,
  })
  assert.deepEqual(parsed.tickers, [ticker])
}
for (const ticker of ['.ABC', 'ABC.', 'A..B', 'A--B', 'A/B', 'A B', 'ABCDEFGHIJKLM']) {
  assert.throws(() => parseTriggerDiscoveryMiniChartsRequest({
    tickers: [ticker],
    requestedAsOf: LATEST_AS_OF,
    timeframe: 'MONTHLY',
    ma1Period: 20,
    ma2Period: 25,
  }))
}

/* ---------- Saved US Trigger: date-free persistence round trip ---------- */

const NEXT_LATEST_AS_OF = '2026-10-16'
const savedViewDefaults = { sort: null, pageSize: US_TRIGGER_DEFAULTS.pageSize, statusFilter: null } as const
const latestSaved = savedTriggerConfigsFromSearchRequest(latestRequest)
assert.equal('requestedAsOf' in latestSaved.evaluationConfig, false, 'saved definitions must not persist the as-of date')
assert.deepEqual(latestSaved.evaluationConfig.universe.markets, ['NASDAQ', 'NYSE'])
assert.equal(latestSaved.evaluationConfig.universe.averageTradingValueMin, 5_000_000, 'USD amounts are saved as USD, not $M')

const reloadedRequest = searchRequestFromSavedTrigger(latestSaved, NEXT_LATEST_AS_OF)
assert.equal(reloadedRequest.requestedAsOf, NEXT_LATEST_AS_OF, 'saved triggers load at the latest date, not the save date')
const reloadedState = usTriggerStateFromRequest(reloadedRequest, NEXT_LATEST_AS_OF)
assert.equal(reloadedState.draft.asOf, NEXT_LATEST_AS_OF)
assert.deepEqual(reloadedState.draft.exchanges, ['NASDAQ', 'NYSE'])
assert.equal(reloadedState.draft.tradingValueMinM, '5')
assert.deepEqual(
  savedTriggerConfigsFromSearchRequest(buildUsTriggerRequest(reloadedState.draft, reloadedState.view, NEXT_LATEST_AS_OF)),
  latestSaved,
  'a freshly loaded US trigger must compare equal (no phantom unsaved changes)',
)

const richDraft: UsTriggerDraft = {
  ...defaultUsTriggerDraft(LATEST_AS_OF),
  timeframe: 'BIWEEKLY',
  spreadExpansionEnabled: true,
  belowZoneToleranceEnabled: true,
  tradingValueMinM: '12.5',
  volumeMax: '2500000',
  exchanges: ['UNCLASSIFIED', 'NYSE'],
  stageFilters: { monthAStage: [2, 1] },
}
const richSaved = savedTriggerConfigsFromSearchRequest(buildUsTriggerRequest(richDraft, {
  sort: { key: 'triggerScore', direction: 'desc' },
  pageSize: 25,
  statusFilter: 'NEAR',
}, LATEST_AS_OF))
assert.deepEqual(richSaved.evaluationConfig.universe.markets, [null, 'NYSE'])
assert.deepEqual(richSaved.viewConfig, { sort: { key: 'triggerScore', direction: 'desc' }, pageSize: 25, statusFilter: 'NEAR' })
const richState = usTriggerStateFromRequest(searchRequestFromSavedTrigger(richSaved, NEXT_LATEST_AS_OF), NEXT_LATEST_AS_OF)
assert.equal(richState.draft.timeframe, 'BIWEEKLY')
assert.equal(richState.draft.tradingValueMinM, '12.5')
assert.deepEqual(richState.view, { sort: { key: 'triggerScore', direction: 'desc' }, pageSize: 25, statusFilter: 'NEAR' })
assert.deepEqual(
  savedTriggerConfigsFromSearchRequest(buildUsTriggerRequest(richState.draft, richState.view, NEXT_LATEST_AS_OF)),
  richSaved,
)

// 過去日を入力中でも、保存・比較は最新データ日の request で組む (取引所の条件を落とさない)
const pastDraftWithExchanges: UsTriggerDraft = { ...latestDraft, asOf: '2025-12-31' }
assert.equal(buildUsTriggerRequest(pastDraftWithExchanges, savedViewDefaults, LATEST_AS_OF).markets, undefined)
assert.deepEqual(
  savedTriggerConfigsFromSearchRequest(buildUsTriggerRequest({ ...pastDraftWithExchanges, asOf: LATEST_AS_OF }, savedViewDefaults, LATEST_AS_OF)),
  latestSaved,
)

const searchRoute = readFileSync('app/api/us/trigger-discovery/search/route.ts', 'utf8')
const miniRoute = readFileSync('app/api/us/trigger-discovery/mini-charts/route.ts', 'utf8')
const serverSource = readFileSync('lib/server/us-trigger-discovery.ts', 'utf8')
const clientSource = readFileSync('app/us/trigger-discovery/UsTriggerDiscoveryClient.tsx', 'utf8')
const builderSource = readFileSync('components/us/trigger-discovery/UsTriggerConditionBuilder.tsx', 'utf8')
const tableSource = readFileSync('components/us/trigger-discovery/UsTriggerResultsTable.tsx', 'utf8')
const cardsSource = readFileSync('components/us/trigger-discovery/UsTriggerResultCards.tsx', 'utf8')
const savedBarSource = readFileSync('components/us/trigger-discovery/UsSavedTriggerBar.tsx', 'utf8')
const navigationSource = readFileSync('components/layout/navigation.ts', 'utf8')
const usNavigationSource = readFileSync('components/us/UsAnalysisNav.tsx', 'utf8')

assert.match(searchRoute, /const key = `US:\$\{triggerDiscoveryBaseSearchKey/)
assert.match(searchRoute, /maPath: 'generic'/)
assert.match(searchRoute, /historical_exchange_unavailable/)
assert.match(searchRoute, /classificationAvailability: isLatest \? 'CURRENT' : 'UNAVAILABLE'/)
assert.match(searchRoute, /universeBasis: isLatest \? 'CURRENT_ACTIVE' : 'TRADING_COVERAGE'/)
assert.match(searchRoute, /averageTradingValue: row\.averageTradingValue/)
assert.match(searchRoute, /currency: 'USD'/)

assert.match(serverSource, /WHERE market = 'US'/)
assert.match(serverSource, /COALESCE\(o\.adj_close, o\.close\)/)
assert.match(serverSource, /COALESCE\(u\.start_date, '0000-01-01'\) <= params\.as_of/)
assert.match(serverSource, /COALESCE\(u\.end_date, params\.latest_as_of\) >= params\.as_of/)
assert.match(serverSource, /CASE WHEN params\.as_of = params\.latest_as_of THEN u\.exchange ELSE NULL END/)
assert.match(serverSource, /json_extract\(raw_json, '\$\.submission\.name'\)/)
assert.match(serverSource, /LEFT JOIN current_company_names ON current_company_names\.ticker = u\.ticker/)
assert.match(serverSource, /buildContinuousBiweeklyMaSeriesFromWeekly/)
assert.doesNotMatch(serverSource, /weekly_ohlcv/)
assert.doesNotMatch(serverSource, /monthly_ma_/, 'generic MA must not read materialized monthly MA values')
assert.match(serverSource, /month_edges AS \(/, 'legacy generic SQL remains as the per-candidate fallback')
assert.match(serverSource, /INDEXED BY market_ohlcv_market_date_idx\s+WHERE o\.market = 'US'\s+AND o\.date BETWEEN months\.from_date AND months\.through_date/)
assert.match(serverSource, /INDEXED BY market_ohlcv_market_date_ticker_idx\s+ON o\.market = 'US'\s+AND o\.ticker = c\.ticker\s+AND o\.date = m\.date/)
assert.match(serverSource, /\[ma1Period, ma2Period\],\s+\{ adjustSplits: false \}/)

assert.match(clientSource, /fetch\('\/api\/us\/trigger-discovery\/search'/)
assert.match(clientSource, /fetch\('\/api\/us\/trigger-discovery\/mini-charts'/)
assert.match(clientSource, /role="status" aria-live="polite"/)
assert.match(clientSource, /extraCardSortOption/)
assert.match(clientSource, /aria-controls="us-trigger-builder-region"/)
assert.doesNotMatch(clientSource, /aria-current="page"/)
assert.doesNotMatch(clientSource, /localhost|127\.0\.0\.1/)
assert.doesNotMatch(clientSource, /\/api\/trigger-discovery\/|notification-settings|historical-scan/, 'US client must not call JP Trigger APIs')

// US 保存導線: 検索フォームと結果の間に置き、US 専用 API だけを使う
assert.match(clientSource, /<UsSavedTriggerBar[\s\S]*?\/>\s*\n\s*\{\/\* aria-busy の領域の外/, 'saved bar sits between the builder and the results')
assert.ok(
  clientSource.indexOf('id="us-trigger-builder-region"') < clientSource.indexOf('<UsSavedTriggerBar')
    && clientSource.indexOf('<UsSavedTriggerBar') < clientSource.indexOf('ref={resultsRef}'),
  'saved bar order: builder → saved bar → results',
)
assert.match(clientSource, /searchRequestFromSavedTrigger\(definition, options\.latestAsOf \?\? draft\.asOf\)/, 'load uses the latest date, never a saved date')
assert.match(clientSource, /usTriggerStateFromRequest\(request, options\.latestAsOf\)/)
assert.match(clientSource, /void runSearch\(request, \{ collapse: true \}\)/, 'loading a saved trigger searches immediately')
assert.match(clientSource, /savedTriggerConfigsFromSearchRequest\(buildUsTriggerRequest\(draftForSave, view, options\.latestAsOf\)\)/)
assert.match(clientSource, /const draftForSave = \{ \.\.\.draft, asOf: options\.latestAsOf \?\? draft\.asOf \}/)
assert.match(clientSource, /activeSavedId,\n\s+\}/, 'navigation snapshot keeps the active saved trigger')

assert.match(savedBarSource, /US_SAVED_TRIGGER_API_BASE = '\/api\/us\/trigger-discovery\/saved'/)
assert.doesNotMatch(savedBarSource, /['"`]\/api\/trigger-discovery\//, 'US saved bar must not call the JP saved Trigger API')
assert.doesNotMatch(savedBarSource, /localhost|127\.0\.0\.1|gmail|sendMail/i)
assert.match(savedBarSource, /fetch\(url, \{ cache: 'no-store', \.\.\.init \}\)/)
assert.match(savedBarSource, /method: isRename \? 'PATCH' : 'POST'/, 'create / save-as / rename')
assert.match(savedBarSource, /method: 'PATCH',\s+headers: \{ 'Content-Type': 'application\/json' \},\s+body: JSON\.stringify\(currentConfigs\)/, 'overwrite')
assert.match(savedBarSource, /method: 'DELETE'/, 'archive')
assert.match(savedBarSource, /\$\{US_SAVED_TRIGGER_API_BASE\}\/\$\{encodeURIComponent\(target\.id\)\}\/evaluate/)
assert.match(savedBarSource, /body: JSON\.stringify\(\{ requestedAsOf: latestAsOf \}\)/)
assert.match(savedBarSource, /onClick=\{\(\) => void evaluateLatest\(\)\}/, 'evaluation runs only from the explicit button')
assert.doesNotMatch(savedBarSource, /useEffect\(\(\) => \{[^}]*evaluateLatest/, 'evaluation must never run automatically')
assert.match(savedBarSource, /<TriggerNotificationSettingsPanel key=\{activeDefinition\.id\} definition=\{activeDefinition\} apiBase=\{US_SAVED_TRIGGER_API_BASE\} \/>/)
assert.match(savedBarSource, /最新を評価/)
assert.match(savedBarSource, /reused/)
assert.match(savedBarSource, /role="status" aria-live="polite"/)
assert.match(savedBarSource, /role="alert"/)
assert.match(builderSource, /過去日は取引所で絞り込めません/)
assert.match(builderSource, /\$M = 百万ドル/)
assert.match(tableSource, /market="US"/)
assert.match(tableSource, /sortAria\(activeSort, 'ma1Distance'\) \?\? sortAria\(activeSort, 'ma2Distance'\)/)
assert.match(tableSource, /sortAria\(activeSort, 'averageTradingValue'\) \?\? sortAria\(activeSort, 'averageVolume'\)/)
assert.match(cardsSource, /market="US"/)
assert.match(miniRoute, /createUsTriggerDiscoveryMiniChartDataSource/)
assert.match(navigationSource, /href: '\/us\/trigger-discovery'/)
assert.match(navigationSource, /'usScreener', 'usPeriodExplorer', 'usStageScreener'/)
assert.match(navigationSource, /'watchlist', 'usMa25mMonitor', 'usTriggerDiscovery'/)
assert.match(usNavigationSource, /href: '\/us\/trigger-discovery'/)

runUsTriggerDiscoveryMaParityTests()
  .then(() => console.log('US Trigger Discovery contract tests passed'))
  .catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
