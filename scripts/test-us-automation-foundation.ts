import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import {
  US_ADJUSTED_PRICE_BASIS,
  toAdjustedUsOhlcv,
} from '@/lib/us-adjusted-ohlcv'
import { isTiingoRateLimitError, TiingoHttpError } from '@/lib/tiingo'
import { getUsSecondaryName } from '@/lib/us-symbol-aliases'
import {
  isUsInvestableSymbol,
  isUsTestSymbol,
  usInvestableSymbolSql,
  usTestSymbolExclusionSql,
} from '@/lib/us-symbol-quality'

const adjusted = toAdjustedUsOhlcv({
  date: '2026-01-02',
  open: 100,
  high: 120,
  low: 90,
  close: 110,
  volume: 1_000,
  adjustedClose: 55,
})
assert.equal(adjusted.open, 50)
assert.equal(adjusted.high, 60)
assert.equal(adjusted.low, 45)
assert.equal(adjusted.close, 55)

const direct = toAdjustedUsOhlcv({
  date: '2026-01-03',
  open: 100,
  high: 120,
  low: 90,
  close: 110,
  volume: 1_000,
  adjustedOpen: 49,
  adjustedHigh: 61,
  adjustedLow: 44,
  adjustedClose: 55,
  adjustedVolume: 2_000,
})
assert.deepEqual(
  { open: direct.open, high: direct.high, low: direct.low, close: direct.close, volume: direct.volume },
  { open: 49, high: 61, low: 44, close: 55, volume: 2_000 },
)
assert.equal(isTiingoRateLimitError(new TiingoHttpError('rate limited', 429, 60)), true)
assert.equal(isTiingoRateLimitError(new Error('provider failed: HTTP 429 allocation exhausted')), true)
assert.equal(isTiingoRateLimitError(new Error('provider failed: HTTP 500')), false)
assert.equal(isUsTestSymbol('ATEST-C'), true)
assert.equal(isUsTestSymbol('NTEST-P'), true)
assert.equal(isUsTestSymbol('ZVZZT'), true)
assert.equal(isUsTestSymbol('AAPL'), false)
assert.equal(isUsInvestableSymbol('AAPL'), true)
assert.equal(isUsInvestableSymbol('BRK-B'), true)
assert.equal(isUsInvestableSymbol('ZVZZT'), false)
assert.equal(isUsInvestableSymbol('-P-H'), false)
assert.equal(isUsInvestableSymbol('0001753539'), false)
assert.equal(getUsSecondaryName('AAPL', 'AAPL'), 'Apple Inc.')
assert.equal(getUsSecondaryName('DBGI', 'DBGI'), null)
assert.match(usTestSymbolExclusionSql('s.ticker'), /ATEST/)
assert.match(usInvestableSymbolSql('s.ticker'), /A-Z0-9/)

const read = (file: string) => fs.readFileSync(path.join(process.cwd(), file), 'utf8')
const ingestion = read('scripts/batch-us-ohlcv.ts')
assert.match(ingestion, /US_TARGET_END_DATE/)
assert.match(ingestion, /CASE WHEN MAX\(o\.date\) IS NULL THEN 0 ELSE 1 END/)
assert.match(ingestion, /adjOpen: row\.adjustedOpen/)
assert.match(ingestion, /usInvestableSymbolSql\('u\.ticker'\)/)

const universeIngestion = read('scripts/batch-us-universe.ts')
assert.match(universeIngestion, /isUsInvestableSymbol\(row\.ticker\) && isActive\(row\.endDate\)/)

const updater = read('scripts/update-us-latest.ts')
assert.match(updater, /US_DAILY_MIN_PRICE_COVERAGE_PCT/)
assert.match(updater, /US_DAILY_RETRY_PRICE_COVERAGE_PCT/)
assert.match(updater, /US_DAILY_REQUIRE_DATE_RANGE/)
assert.match(updater, /source price refresh will continue/)
assert.match(updater, /US_ADJUSTED_PRICE_BASIS/)
assert.match(updater, /coverageNeedsRetry/)
assert.match(updater, /US_DAILY_MIN_SNAPSHOT_COVERAGE_PCT/)
assert.match(updater, /snapshotCoverageNeedsRepair/)
assert.match(updater, /row\.status === 'partial'/)
assert.equal(US_ADJUSTED_PRICE_BASIS, 'tiingo_adj_ohlc_ratio_v1')

const analytics = read('scripts/build-us-analytics-db.ts')
assert.match(analytics, /US_ANALYTICS_REBUILD_PRICE_BASIS/)
assert.match(analytics, /us_analytics_metadata/)
assert.match(analytics, /COALESCE\(m\.adj_close, m\.close\)/)
assert.match(analytics, /isUsInvestableSymbol\(row\.ticker\) \? row\.active : 0/)

const mlJob = read('scripts/run-us-ml-job.ts')
assert.match(mlJob, /exactForwardExtremaRecomputeBars/)
assert.match(mlJob, /US_ML_WEEKLY_EXTREMA_RECALC_DAYS/)
assert.match(mlJob, /FORWARD_EXTREMA_RESUME/)
assert.match(mlJob, /ML_ACCURACY_STRICT/)
assert.match(mlJob, /US_ML_SKIP_ANALYSIS_FOUNDATION/)
assert.match(mlJob, /batch:weekly-ohlcv/)
assert.match(mlJob, /batch:pattern-stats/)
assert.match(mlJob, /batch:stage-transitions/)
assert.match(mlJob, /batch:serving-backtest:full/)

const patternStats = read('scripts/batch-pattern-stats.ts')
assert.match(patternStats, /DELETE FROM pattern_stats WHERE horizon_days = \?/)
assert.doesNotMatch(patternStats, /DELETE FROM pattern_stats WHERE horizon_days IN/)

const stageTransitions = read('scripts/batch-stage-transitions.ts')
assert.match(stageTransitions, /全6軸の集計完了。既存値を原子的に置換/)
assert.match(stageTransitions, /client\.batch\(\[/)

const forwardExtremaBatch = read('scripts/batch-forward-extrema.ts')
assert.match(forwardExtremaBatch, /waitForMemoryHeadroom/)
assert.match(forwardExtremaBatch, /forward_extrema \$\{completed\}\/\$\{codes\.length\}/)

const weeklyInstaller = read('scripts/install-local-us-ml-weekly.ts')
assert.match(weeklyInstaller, /US_ML_WEEKLY_EXTREMA_RECALC_DAYS.*201/)
assert.match(weeklyInstaller, /FORWARD_EXTREMA_RESUME.*1/)
assert.doesNotMatch(weeklyInstaller, /US_ML_WEEKLY_EXTREMA_RECENT_DAYS/)

const analyticsValidation = read('scripts/validate-us-analytics-db.ts')
assert.match(analyticsValidation, /US_ANALYTICS_MIN_LATEST_COVERAGE_PCT/)
assert.match(analyticsValidation, /expectedLatestUsTradingDate/)
assert.match(analyticsValidation, /latestSnapshotCoveragePct/)
assert.match(analyticsValidation, /US_ADJUSTED_PRICE_BASIS/)
assert.match(analyticsValidation, /US_ANALYTICS_REQUIRE_DERIVED_BASIS/)
assert.match(analyticsValidation, /derivedPriceDate/)
assert.match(analyticsValidation, /backtestFeatureDate/)
assert.match(analyticsValidation, /patternStatsRows/)
assert.match(analyticsValidation, /transitionAxes/)
assert.match(analyticsValidation, /servingBacktestDate/)
assert.match(analyticsValidation, /latestModelEvaluationDate/)
assert.match(analyticsValidation, /latestPhysicsEvaluationDate/)
assert.match(analyticsValidation, /latestRlEvaluationDate/)

const adjustedFoundation = read('scripts/ensure-us-adjusted-foundation.ts')
assert.match(adjustedFoundation, /adjustedShadowDbPath/)
assert.match(adjustedFoundation, /derived_price_basis/)
assert.match(adjustedFoundation, /analog_index_price_basis/)
assert.match(adjustedFoundation, /promoteAdjustedShadow/)
assert.match(adjustedFoundation, /previous generation retained/)

const freshnessGuard = read('scripts/guard-data-freshness.ts')
assert.match(freshnessGuard, /heavyMlProcessIsActive/)
assert.match(freshnessGuard, /derivedPriceBasis/)
assert.match(freshnessGuard, /analogPriceBasis/)
assert.match(freshnessGuard, /priceBasisCurrent:[\s\S]*US_ADJUSTED_PRICE_BASIS/)
assert.doesNotMatch(freshnessGuard, /com\.stockboard\.us-ml-weekly/)

const weeklyOptimization = read('scripts/run-weekly-optimization.ts')
assert.match(weeklyOptimization, /buildRunKey/)
assert.match(weeklyOptimization, /implementationFingerprint/)
assert.match(weeklyOptimization, /same week, data dates, and implementation/)
assert.match(weeklyOptimization, /downstream publication was not started/)
assert.match(weeklyOptimization, /ML_FEATURE_HEALTH_STRICT/)
assert.match(weeklyOptimization, /ML_ACCURACY_STRICT/)

const analogRoute = read('app/api/ml/historical-analogs/route.ts')
assert.match(analogRoute, /response\.arrayBuffer\(\)/)
assert.doesNotMatch(analogRoute, /new NextResponse\(response\.body/)

const usMlStatusRoute = read('app/api/us/ml-status/[ticker]/route.ts')
assert.match(usMlStatusRoute, /derived_price_basis/)
assert.match(usMlStatusRoute, /analog_index_price_basis/)
assert.match(
  usMlStatusRoute,
  /adjustedFoundationReady = adjustedOhlcvReady && adjustedDerivedReady && adjustedAnalogReady/,
)

const usScreener = read('app/us/screener/UsScreenerClient.tsx')
assert.doesNotMatch(usScreener, /Tiingo由来の調整後株価/)
assert.match(usScreener, /価格基準の移行状況はデータ鮮度で確認できます/)

const usHexRoute = read('app/api/us/hex/route.ts')
assert.match(usHexRoute, /FROM market_universe u INDEXED BY market_universe_market_active_idx/)
assert.doesNotMatch(usHexRoute, /asset_type, 'Stock'\) IN \('Stock', 'ETF'\)/)
assert.doesNotMatch(usHexRoute, /COALESCE\(cur\.adj_close, cur\.close\) >= 0\.1/)
const usSnapshotBuilder = read('scripts/build-us-snapshots.ts')
assert.match(usSnapshotBuilder, /usInvestableSymbolSql\('u\.ticker'\)/)

const header = read('components/layout/Header.tsx')
assert.match(header, /\/us\/analysis\/ml-lens/)
assert.match(header, /\/us\/analysis\/transitions/)
assert.match(header, /\/us\/analysis\/backtest/)
const usAnalysisData = read('lib/server/us-analysis-dashboard.ts')
assert.match(usAnalysisData, /execUsAnalyticsAll/)
assert.doesNotMatch(usAnalysisData, /execAll.*@\/lib\/db\/client/)
assert.match(usAnalysisData, /evaluation_date <= \(SELECT MAX\(date\) FROM ohlcv_daily\)/)
assert.match(usAnalysisData, /usInvestableSymbolSql/)

const webInstaller = read('scripts/install-local-web-server.ts')
assert.match(webInstaller, /<key>Nice<\/key>\n  <integer>0<\/integer>/)

const usMlHealth = read('scripts/check-us-ml-health.ts')
assert.match(usMlHealth, /US_ML_HEALTH_ALLOW_NON_OK/)
assert.match(usMlHealth, /US ML health gate failed/)

const featureHealth = read('scripts/batch-ml-feature-health.ts')
assert.match(featureHealth, /ML_FEATURE_HEALTH_STRICT/)
assert.match(featureHealth, /ML feature health gate failed/)

const servingCache = read('lib/api/serving-cache.ts')
assert.match(servingCache, /serializeWrite/)
assert.match(servingCache, /warnBusyOnce\('read'\)/)
assert.match(servingCache, /warnBusyOnce\('cleanup'\)/)

console.log('US automation foundation tests passed')
