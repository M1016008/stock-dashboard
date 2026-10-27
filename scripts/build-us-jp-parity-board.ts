import fs from 'node:fs'
import path from 'node:path'

const root = process.cwd()
const evidenceRevision = '9d5a95bb054d2ad4b2b37ed9a49768976a8e9919'
const statusFields = ['jp', 'us', 'functional', 'visual', 'data', 'historical', 'responsive', 'performance'] as const
type Status = 'IMPLEMENTED' | 'PARTIAL' | 'MISSING' | 'NOT_APPLICABLE' | 'BLOCKED' | 'UNVERIFIED'
type StatusField = (typeof statusFields)[number]
type Row = Record<StatusField, Status> & {
  wave: string
  feature: string
  remaining: string
  blocker?: string
  nextAction?: string
  implementationPaths: string[]
  testPaths: string[]
}

const complete = {
  jp: 'IMPLEMENTED', us: 'IMPLEMENTED', functional: 'IMPLEMENTED', visual: 'IMPLEMENTED',
  data: 'IMPLEMENTED', historical: 'IMPLEMENTED', responsive: 'IMPLEMENTED', performance: 'IMPLEMENTED',
} as const
const technical = { ...complete, historical: 'NOT_APPLICABLE' } as const

function row(
  wave: string,
  feature: string,
  statuses: Record<StatusField, Status>,
  implementationPaths: string[],
  testPaths: string[],
  remaining = 'None within the implemented contract.',
  blocker?: string,
  nextAction?: string,
): Row {
  return { wave, feature, ...statuses, remaining, blocker, nextAction, implementationPaths, testPaths }
}

const rows: Row[] = [
  row('W0', 'Global navigation and market switching', technical, ['components/layout/navigation.ts', 'components/layout/market-switch.ts'], ['scripts/test-header-navigation.ts']),
  row('W0', 'Loading, empty and error state contracts', technical, ['app/us/error.tsx', 'components/us/UsRouteErrorState.tsx'], ['scripts/test-us-route-states.ts']),
  row('W0', 'Strict API query validation and error semantics', technical, ['app/api/us/screener/route.ts', 'app/api/us/earnings-calendar/route.ts'], ['scripts/test-us-api-error-contracts.ts']),
  row('W0', 'PIT date and future-leakage guards', { ...complete, visual: 'NOT_APPLICABLE', responsive: 'NOT_APPLICABLE' }, ['lib/server/period-explorer-read-model.ts', 'app/api/us/hex/route.ts'], ['scripts/test-us-screener-pit.ts', 'scripts/test-us-dashboard-pit.ts']),
  row('W0', 'Data freshness and coverage disclosure', complete, ['lib/us-status.ts', 'app/api/us/status/route.ts'], ['scripts/test-us-data-coverage-ui.ts', 'scripts/test-data-freshness.ts']),
  row('W0', 'Friend read-only access parity', { ...technical, us: 'PARTIAL', responsive: 'UNVERIFIED' }, ['proxy.ts'], ['scripts/test-remote-access.ts', 'scripts/test-friend-readonly-gateway.ts', 'scripts/test-friend-readonly-ui.ts'], 'Code contract and isolated gateway/UI regressions exist, but this branch was not deployed and authenticated friend-path browser QA was not run.', 'SECURITY: Production deployment and authenticated runtime access require separate approval.', 'Run the approved friend-access route matrix after a future deployment.'),
  row('W0', 'Responsive route coverage', technical, ['app/us/loading.tsx', 'components/layout/Header.tsx'], ['scripts/test-layout-shell.ts', 'scripts/test-us-route-states.ts', 'scripts/bench/browser-plan.json', 'docs/us-stockboard-parity-validation-20261026.md']),
  row('W0', 'Search performance governance', technical, ['scripts/audit-browser-performance.ts', 'scripts/benchmark-search-performance.ts'], ['scripts/test-search-performance-regressions.ts', 'scripts/bench/scenarios/priority-search.ts', 'docs/us-stockboard-parity-validation-20261026.md']),

  row('W1', 'Market dashboard', complete, ['app/us/page.tsx'], ['scripts/test-us-dashboard-pit.ts']),
  row('W1', 'Daily close market report', complete, ['app/us/daily-close/page.tsx', 'lib/server/us-daily-close-report.ts'], ['scripts/test-us-daily-close-report.ts']),
  row('W1', 'Market momentum', complete, ['app/us/market-momentum/page.tsx'], ['scripts/test-us-market-momentum-sector-ui.ts']),
  row('W1', 'Sector and industry analysis', { ...complete, us: 'PARTIAL', data: 'PARTIAL', historical: 'PARTIAL' }, ['app/us/sectors/page.tsx'], ['scripts/test-us-market-momentum-sector-ui.ts'], 'Current SEC SIC analysis is implemented; effective-dated historical classifications are unavailable.', 'DATA: no approved effective-dated US sector/industry source.', 'Ingest an approved effective-dated taxonomy before enabling historical classification filters.'),
  row('W1', 'Sector ETF comparison', complete, ['app/us/sector-etfs/page.tsx', 'lib/server/us-sector-etf-read-model.ts'], ['scripts/test-us-sector-etfs.ts']),
  row('W1', 'Sector ETF detail analysis', { ...complete, us: 'PARTIAL', data: 'PARTIAL' }, ['app/us/sector-etfs/[ticker]/page.tsx', 'lib/server/us-sector-etf-detail-read-model.ts'], ['scripts/test-us-sector-etf-detail.ts'], 'Adjusted price, Stage and SMA analysis are complete; constituent holdings and weights remain unavailable.', 'DATA: no approved ETF holdings source with redistribution rights.', 'Connect an approved holdings source and preserve source date and weight lineage.'),
  row('W1', 'Earnings calendar', { ...complete, us: 'PARTIAL', data: 'BLOCKED', historical: 'BLOCKED' }, ['app/us/earnings/page.tsx', 'lib/queries/us-earnings.ts', 'app/us/screener/UsScreenerClient.tsx'], ['scripts/test-us-earnings-calendar.ts', 'scripts/test-us-screener-pit.ts', 'scripts/test-us-parity-ui-contracts.ts'], 'Fixture UI and current-reference semantics are implemented. Provider dates without actuals remain unverified schedules; historical schedules fail closed because append-only observations do not exist. Live rows require the approved Finnhub credential.', 'API: machine-local Finnhub credential, live ingestion approval, and append-only schedule observations are absent.', 'Configure the credential outside Git, ingest a bounded current calendar, then design append-only observations before enabling historical filters.'),
  row('W1', 'MTF close calendar', complete, ['app/us/mtf-close-calendar/page.tsx'], ['scripts/test-mtf-close-calendar.ts']),

  row('W2', 'Stock detail overview', complete, ['app/us/stock/[ticker]/page.tsx', 'app/us/stock/[ticker]/UsStockDetailClient.tsx'], ['scripts/test-us-stock-detail-parity.ts']),
  row('W2', 'Candlestick chart workspace', complete, ['app/us/stock/[ticker]/UsStockDetailClient.tsx', 'components/charts/CandlestickChart.tsx'], ['scripts/test-us-stock-detail-parity.ts']),
  row('W2', 'SMA Dynamics Lab', complete, ['components/stock/sma-dynamics/SmaDynamicsSection.tsx', 'lib/sma-dynamics-timeframes.ts'], ['scripts/test-sma-dynamics.ts', 'scripts/test-sma-dynamics-ui.ts']),
  row('W2', 'Current six-stage structure', complete, ['app/us/stock/[ticker]/UsStockDetailClient.tsx', 'lib/us-hex-wire.ts'], ['scripts/test-us-stock-detail-parity.ts', 'scripts/test-us-hex-serving.ts']),
  row('W2', 'Stage history timeline', complete, ['app/us/stock/[ticker]/UsStockDetailClient.tsx'], ['scripts/test-stage-history-range.ts']),
  row('W2', 'Physical Momentum and MA slope', complete, ['app/us/stock/[ticker]/UsStockDetailClient.tsx'], ['scripts/test-physical-momentum.ts', 'scripts/test-us-stock-detail-parity.ts']),
  row('W2', 'Forward scenario and inverse analysis', complete, ['components/stock/sma-dynamics/SmaScenarioPanel.tsx', 'components/stock/sma-dynamics/SmaSolverPanel.tsx'], ['scripts/test-sma-dynamics-daily-scenario.ts', 'scripts/test-sma-dynamics-crossing.ts']),
  row('W2', 'Similar historical comparison', complete, ['components/stock/HistoricalAnalogExplorer.tsx', 'app/api/ml/historical-analogs/route.ts'], ['scripts/test-historical-analogs.ts']),
  row('W2', 'Actual fundamentals summary', { ...complete, us: 'PARTIAL', data: 'PARTIAL', historical: 'PARTIAL' }, ['lib/server/us-fundamentals.ts', 'lib/us-fundamentals.ts', 'app/api/us/fundamentals/[ticker]/route.ts', 'components/us/stock-detail/UsFundamentalsWorkspace.tsx'], ['scripts/test-us-sec-companyfacts.ts', 'scripts/test-us-fundamentals.ts', 'scripts/test-us-stock-fundamentals-ui.ts'], 'SEC normalization, immutable-fact conflict detection, section coverage, and five-view UI are implemented; live Companyfacts coverage is not activated in this branch.', 'API: SEC operator contact and Production ingestion are separately controlled.', 'Configure the operator identity and audit live US-GAAP/IFRS concept coverage before activation.'),
  row('W2', 'Valuation', { ...complete, us: 'PARTIAL', data: 'PARTIAL', historical: 'PARTIAL' }, ['lib/us-fundamentals.ts', 'components/us/stock-detail/UsFundamentalsWorkspace.tsx'], ['scripts/test-us-fundamentals.ts', 'scripts/test-us-stock-fundamentals-ui.ts'], 'Trailing PER, PBR, PSR and market capitalization use PIT-eligible SEC facts and adjusted price fixtures; peer distributions and live historical ranges remain unavailable.', 'DATA: live historical shares/facts coverage and an approved peer taxonomy are incomplete.', 'Activate only after live effective-date coverage and split-basis parity pass.'),
  row('W2', 'Shareholder return', { ...complete, us: 'PARTIAL', data: 'PARTIAL', historical: 'PARTIAL' }, ['lib/us-fundamentals.ts', 'components/us/stock-detail/UsFundamentalsWorkspace.tsx'], ['scripts/test-us-fundamentals.ts', 'scripts/test-us-stock-fundamentals-ui.ts'], 'Trailing dividend, payout and buyback presentation distinguish observed zero, missing and not meaningful values; live Tiingo/SEC coverage remains unverified.', 'DATA: Production provider coverage is outside this isolated run.', 'Validate full trailing dividend and repurchase coverage without substituting missing values.'),
  row('W2', 'Forecast fundamentals', { ...complete, us: 'BLOCKED', functional: 'MISSING', visual: 'MISSING', data: 'BLOCKED', historical: 'BLOCKED', responsive: 'NOT_APPLICABLE', performance: 'NOT_APPLICABLE' }, ['app/stock/[ticker]/page.tsx', 'docs/us-stockboard-parity-residual-audit.md'], ['scripts/test-us-fundamentals.ts'], 'No approved US analyst-consensus source exists; estimates are not fabricated.', 'API: an approved consensus/forecast provider or contract is required.', 'Select a source, define as-of revision semantics, then implement ingestion and UI.'),
  row('W2', 'Institutional ownership equivalent', { ...complete, us: 'BLOCKED', functional: 'PARTIAL', visual: 'MISSING', data: 'BLOCKED', historical: 'BLOCKED', responsive: 'MISSING', performance: 'NOT_APPLICABLE' }, ['app/large-holders/page.tsx', 'docs/us-stockboard-parity-residual-audit.md'], ['scripts/test-header-navigation.ts'], 'SEC 13F and Schedule 13D/G are designed as separate products but have no approved complete ticker mapping pipeline.', 'DATA: evidence-backed CUSIP mapping and SEC operator contact are missing.', 'Approve and implement separate 13F manager-position and 13D/G beneficial-owner lineages.'),
  row('W2', 'Short-interest equivalent', { ...complete, us: 'BLOCKED', functional: 'MISSING', visual: 'MISSING', data: 'BLOCKED', historical: 'BLOCKED', responsive: 'MISSING', performance: 'NOT_APPLICABLE' }, ['docs/us-stockboard-parity-residual-audit.md'], ['scripts/test-us-runtime-capabilities.ts'], 'Daily short-sale volume is not substituted for exchange-reported short interest.', 'API: Nasdaq/NYSE listed-universe short-interest license and usage rights are absent.', 'Acquire an approved exchange product or retain the explicit unavailable state.'),

  row('W3', 'Integrated screener', { ...complete, us: 'PARTIAL', data: 'PARTIAL', historical: 'PARTIAL' }, ['app/us/screener/UsScreenerClient.tsx', 'app/api/us/screener/route.ts'], ['scripts/test-us-screener-filters.ts', 'scripts/test-us-screener-pit.ts'], 'Price, Stage, Physical and current classification filters are complete; historical classifications and forecast filters remain unavailable.', 'DATA: effective-dated classifications and approved forecasts are missing.', 'Keep unsupported historical filters fail-closed until their sources exist.'),
  row('W3', 'Period explorer and rankings', { ...complete, us: 'PARTIAL', data: 'PARTIAL', historical: 'PARTIAL' }, ['app/us/period-explorer/page.tsx', 'lib/server/period-explorer-read-model.ts'], ['scripts/test-us-period-explorer.ts'], 'US price, Stage, liquidity and exact-date rankings are implemented; historical classification filters and PIT share-count market cap remain unavailable.', 'DATA: approved effective-dated US classifications and share-count history are absent.', 'Retain the explicit historical limitations until both source families are available.'),
  row('W3', 'Stage screener', complete, ['app/us/stage-screener/page.tsx', 'app/api/us/hex/route.ts'], ['scripts/test-us-stage-screener-transport.ts', 'scripts/test-us-hex-serving.ts']),
  row('W3', 'Stage transition scanner', complete, ['app/us/analysis/transitions/page.tsx', 'app/api/us/hex/transitions/route.ts'], ['scripts/test-us-stage-transition-scanner.ts']),
  row('W3', 'Trigger discovery and saved settings', { ...complete, us: 'PARTIAL', historical: 'PARTIAL' }, ['app/us/trigger-discovery/page.tsx', 'app/api/us/trigger-discovery/search/route.ts'], ['scripts/test-us-trigger-discovery.ts', 'scripts/test-us-trigger-persistence.ts'], 'Current and single-date searches and market-scoped persistence are implemented; period scans using historical classifications remain unavailable.', 'DATA: effective-dated US classifications are absent.', 'Retain explicit limitations until classification history is approved.'),
  row('W3', 'Backtest', complete, ['app/us/analysis/backtest/page.tsx', 'app/api/us/backtest/query/route.ts'], ['scripts/test-us-backtest.ts', 'scripts/test-us-backtest-ui.ts']),
  row('W3', 'MA and physical similarity lens', complete, ['app/us/analysis/ml-lens/page.tsx', 'app/api/us/ml-current-similars/route.ts'], ['scripts/test-us-shared-tools.ts']),
  row('W3', 'AI research', { ...complete, us: 'PARTIAL', data: 'PARTIAL', historical: 'PARTIAL' }, ['app/ai/research/page.tsx', 'lib/assistant/tools.ts'], ['scripts/test-us-shared-tools.ts'], 'US price, Stage, physical and similarity tools are isolated; forecasts, ownership and event history remain unavailable.', 'DATA: the blocked source families are not passed through JP fallback.', 'Add only approved US-native tools as their source contracts become available.'),
  row('W3', 'Trade workbench', { ...complete, us: 'PARTIAL', functional: 'PARTIAL', data: 'PARTIAL', historical: 'PARTIAL' }, ['app/us/trade/workbench/page.tsx', 'lib/queries/us-trade-workbench.ts'], ['scripts/test-us-trade-workbench.ts', 'scripts/test-us-parity-ui-contracts.ts'], 'Long entry drafts and downside watch are implemented; executable short orders and broker-specific historical borrow evidence are unavailable.', 'DATA: broker borrow inventory, locate cost, and historical availability are not available.', 'Connect an approved broker source before presenting executable or historical short orders.'),
  row('W3', 'Monthly MA monitor 3M through 25M', { ...complete, us: 'PARTIAL', performance: 'PARTIAL' }, ['app/us/ma25m-monitor/page.tsx', 'app/api/us/ma25m-monitor/route.ts', 'app/api/us/ma25m-monitor/[ticker]/route.ts', 'lib/us-ma25m-monitor.ts', 'lib/server/us-monthly-ma-generation.ts'], ['scripts/test-us-ma25m-monitor.ts', 'scripts/test-us-parity-ui-contracts.ts'], 'Calculation, lineage attestation, generation-scoped single-flight cache, retry/loading UI, and source-change fail-closed checks are implemented; Production-scale p95, memory and concurrency remain unverified.', 'TECHNICAL: Production-equivalent full-universe load testing is prohibited in this isolated branch.', 'Run the approved read-only performance gate before Production release and retain the bounded generation contract.'),
  row('W3', 'Search and symbol aliases', complete, ['app/api/us/search/route.ts', 'lib/markets.ts'], ['scripts/test-us-symbol-aliases.ts']),

  row('W4', 'Watchlist', complete, ['app/watchlist/page.tsx', 'lib/watchlist-store.ts'], ['scripts/test-us-shared-tools.ts']),
  row('W4', 'Custom and composite charts', { ...complete, us: 'PARTIAL', data: 'PARTIAL' }, ['app/custom-charts/page.tsx', 'lib/custom-charts/formula.ts'], ['scripts/test-custom-charts.ts'], 'US-only formulas are implemented; mixed-market formulas require date-aligned USD/JPY.', 'DATA: approved daily FX lineage is absent.', 'Import an approved PIT FX series before enabling mixed JP/US formulas.'),
  row('W4', 'Chart drill', complete, ['app/chart-drill/page.tsx', 'lib/chart-drill/server.ts'], ['scripts/test-chart-drill.ts']),
  row('W4', 'Stock preview from discovery surfaces', complete, ['components/stock-preview/StockPreviewTrigger.tsx'], ['scripts/test-stock-preview.ts']),
  row('W4', 'Popular themes equivalent', { ...complete, us: 'BLOCKED', functional: 'MISSING', visual: 'MISSING', data: 'BLOCKED', historical: 'BLOCKED', responsive: 'MISSING', performance: 'NOT_APPLICABLE' }, ['app/themes/page.tsx', 'docs/us-stockboard-parity-residual-audit.md'], ['scripts/test-header-navigation.ts'], 'No approved US theme taxonomy with membership history exists; sector ETFs are not mislabeled as themes.', 'DATA: theme membership, effective dates and redistribution terms are missing.', 'Approve a theme taxonomy or build a governed ETF-derived taxonomy with explicit effective dates.'),
  row('W4', 'Materials and news equivalent', { ...complete, us: 'BLOCKED', functional: 'MISSING', visual: 'MISSING', data: 'BLOCKED', historical: 'BLOCKED', responsive: 'MISSING', performance: 'NOT_APPLICABLE' }, ['app/materials/page.tsx', 'docs/us-stockboard-parity-residual-audit.md'], ['scripts/test-header-navigation.ts'], 'No approved US news/materials feed with ticker links and redistribution terms exists.', 'API: a licensed filing/news source and retention contract are required.', 'Approve a source, define ticker mapping and PIT retention, then implement.'),
  row('W4', 'Policy holdings', { jp: 'IMPLEMENTED', us: 'NOT_APPLICABLE', functional: 'NOT_APPLICABLE', visual: 'NOT_APPLICABLE', data: 'NOT_APPLICABLE', historical: 'NOT_APPLICABLE', responsive: 'NOT_APPLICABLE', performance: 'NOT_APPLICABLE' }, ['app/large-holders/page.tsx'], ['scripts/test-header-navigation.ts'], 'US has no direct policy-shareholding analogue; institutional ownership is tracked separately.', 'REGULATORY: the JP concept is market-specific.', 'None; use the separate 13F and 13D/G product definitions.'),

  row('W5', 'Daily US price and analytics jobs', { ...complete, visual: 'NOT_APPLICABLE', responsive: 'NOT_APPLICABLE' }, ['scripts/update-us-latest.ts', 'scripts/build-us-analytics-db.ts'], ['scripts/test-us-market-data-quality.ts']),
  row('W5', 'Historical classification', { ...complete, us: 'BLOCKED', functional: 'PARTIAL', visual: 'PARTIAL', data: 'BLOCKED', historical: 'BLOCKED', responsive: 'IMPLEMENTED', performance: 'IMPLEMENTED' }, ['app/us/sectors/page.tsx', 'docs/us-stockboard-parity-residual-audit.md'], ['scripts/test-us-market-momentum-sector-ui.ts'], 'Current-reference SEC SIC is retained and labeled; historical classification-dependent views fail closed.', 'DATA: no effective-dated classification history is approved.', 'Ingest classification change history before enabling historical aggregates.'),
  row('W5', 'Sector ETF holdings and weights', { ...complete, us: 'BLOCKED', functional: 'PARTIAL', visual: 'PARTIAL', data: 'BLOCKED', historical: 'BLOCKED', responsive: 'IMPLEMENTED', performance: 'IMPLEMENTED' }, ['app/us/sector-etfs/[ticker]/page.tsx', 'docs/us-stockboard-parity-residual-audit.md'], ['scripts/test-us-sector-etf-detail.ts'], 'ETF price, Stage and SMA detail is complete; holdings remain visibly unavailable.', 'DATA: an approved holdings feed with as-of dates is absent.', 'Connect an approved issuer or licensed holdings source.'),
]

for (const item of rows) {
  for (const evidencePath of [...item.implementationPaths, ...item.testPaths]) {
    if (!fs.existsSync(path.join(root, evidencePath))) throw new Error(`${item.feature}: missing ${evidencePath}`)
  }
}

const claudeReviewedFeatures = new Set([
  'Daily close market report',
  'Sector and industry analysis',
  'Sector ETF detail analysis',
  'Earnings calendar',
  'Actual fundamentals summary',
  'Valuation',
  'Shareholder return',
  'Integrated screener',
  'Trade workbench',
  'Monthly MA monitor 3M through 25M',
])

const features = rows.map(({ implementationPaths, testPaths, blocker, nextAction, ...item }) => ({
  ...item,
  claude: claudeReviewedFeatures.has(item.feature)
    ? 'STATIC_REVIEWED_BROWSER_PENDING'
    : 'PRIOR_EVIDENCE_REUSED_NOT_REVIEWED_THIS_REVISION',
  codexQa: item.us === 'BLOCKED' ? 'BLOCKER_DOCUMENTED_EXTERNAL_EVIDENCE_NOT_TESTED' : item.us === 'PARTIAL' ? 'TARGETED_OR_HISTORICAL_EVIDENCE' : 'TARGETED_PASS',
  git: evidenceRevision,
  production: 'NOT_DEPLOYED_THIS_BRANCH',
  ...(blocker ? { blocker } : {}),
  ...(nextAction ? { nextAction } : {}),
  evidence: {
    claims: statusFields.filter((field) => item[field] === 'IMPLEMENTED'),
    implementationPaths,
    testPaths,
  },
}))

const output = {
  schemaVersion: 1,
  updatedAt: '2026-10-26',
  benchmark: 'JP StockBoard',
  target: 'US StockBoard',
  evidenceRevision,
  productionState: 'NOT_DEPLOYED_THIS_BRANCH',
  inventorySnapshot: { pages: 58, apiRoutes: 168, components: 141, calculations: 108, jobs: 221, controlUnits: 1005 },
  statusDefinitions: {
    IMPLEMENTED: '分析意図を満たす実装と対象回帰証拠がある',
    PARTIAL: '利用可能だが機能・データ・履歴・UX・検証の残差がある',
    MISSING: '実装がなく、外部Blockerにも分類できない',
    NOT_APPLICABLE: '市場制度または製品意図上、移植しない合理的差異',
    BLOCKED: '承認済みデータ、契約、Production権限または製品判断が必要',
    UNVERIFIED: '実装証拠はあるが今回の受入検証を完了していない',
  },
  features,
}

fs.writeFileSync(path.join(root, 'docs/us-stockboard-parity-board.json'), `${JSON.stringify(output, null, 2)}\n`)
console.log(`Wrote ${features.length} features at ${evidenceRevision}`)
