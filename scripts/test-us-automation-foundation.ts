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
assert.match(ingestion, /US_OHLCV_FAILED_RETRY_ROUNDS/)
assert.match(ingestion, /US OHLCV failed retry round/)
assert.match(ingestion, /errorsByTicker\.delete\(target\.ticker\)/)
assert.match(ingestion, /US OHLCV incomplete after targeted retries/)

const tiingoClient = read('lib/tiingo.ts')
assert.match(tiingoClient, /TIINGO_REQUEST_RETRIES/)
assert.match(tiingoClient, /AbortSignal\.timeout\(TIINGO_REQUEST_TIMEOUT_MS\)/)
assert.match(tiingoClient, /408, 425, 500, 502, 503, 504/)

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

const usAutoUpdateInstaller = read('scripts/install-local-us-auto-update.ts')
assert.match(usAutoUpdateInstaller, /US_PMS_DAILY_RECENT_DAYS=.*:-30/)
assert.doesNotMatch(usAutoUpdateInstaller, /US_PMS_DAILY_RECENT_DAYS=.*:-420/)

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
assert.match(mlJob, /US_PMS_DAILY_RECENT_DAYS \?\? '30'/)
assert.match(mlJob, /US_PMS_DAILY_TICKER_CHUNK \?\? '250'/)
assert.match(mlJob, /US_PMS_DAILY_DATE_CHUNK \?\? '50'/)

const usPmsRunner = read('scripts/run-us-physical-momentum-full.ts')
assert.match(usPmsRunner, /US_PMS_CHECKPOINT_ENABLED/)
assert.match(usPmsRunner, /checkpointInputKey/)
assert.match(usPmsRunner, /writeCheckpoint/)
assert.match(usPmsRunner, /waitForMemoryHeadroom/)
assert.match(usPmsRunner, /US_PMS_TICKER_CHUNK \?\? 250/)
assert.match(usPmsRunner, /US_PMS_DATE_CHUNK \?\? 50/)

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

const usWeeklyRunner = read('scripts/run-us-ml-weekly-efficient.ts')
assert.match(usWeeklyRunner, /foundationWasCurrent/)
assert.match(usWeeklyRunner, /full-history ML already completed inside the newly promoted adjusted generation/)
assert.match(usWeeklyRunner, /DB_MAINT_TARGETS: 'us'/)
const packageJson = read('package.json')
assert.match(packageJson, /run-us-ml-weekly-efficient\.ts/)
const packageData = JSON.parse(packageJson) as { scripts?: Record<string, string> }
assert.equal(
  packageData.scripts?.['auto-us-ml-weekly:install'],
  'npm run auto-weekly-optimization:install',
)
assert.equal(
  packageData.scripts?.['auto-ml-weekly:install'],
  'npm run auto-weekly-optimization:install',
)

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
assert.match(adjustedFoundation, /COPYFILE_FICLONE_FORCE/)
assert.match(adjustedFoundation, /foundationProcessLockPath/)
assert.match(adjustedFoundation, /72 \* 60 \* 60/)
assert.match(adjustedFoundation, /enqueueStatusWrite/)
assert.match(adjustedFoundation, /Superseded after the previous foundation owner exited/)
assert.match(adjustedFoundation, /SOURCE_SNAPSHOT_LOCK_JOB/)
assert.match(adjustedFoundation, /SOURCE_SNAPSHOT_CONFLICTS/)
assert.match(adjustedFoundation, /sourceSnapshotLock\?\.release/)
assert.doesNotMatch(adjustedFoundation, /Promise\.all\(\[\s*lock\.heartbeat\(\)/)
assert.doesNotMatch(adjustedFoundation, /stopServingServices/)
assert.doesNotMatch(adjustedFoundation, /bootout/)

const freshnessGuard = read('scripts/guard-data-freshness.ts')
assert.match(freshnessGuard, /cliArgs\.has\(['"]--dry-run['"]\)/)
assert.match(freshnessGuard, /cliArgs\.has\(['"]--force['"]\)/)
assert.match(freshnessGuard, /heavyMlProcessReservations/)
assert.match(freshnessGuard, /derivedPriceBasis/)
assert.match(freshnessGuard, /analogPriceBasis/)
assert.match(freshnessGuard, /priceBasisCurrent:[\s\S]*US_ADJUSTED_PRICE_BASIS/)
assert.match(freshnessGuard, /enforceWeeklySchedulePolicy/)
assert.match(freshnessGuard, /disabled schedule was re-enabled/)
assert.match(freshnessGuard, /setLaunchdEnabled\(label, false\)/)
assert.doesNotMatch(freshnessGuard, /kickstart\(['"]com\.stockboard\.us-ml-weekly/)

const weeklyOptimization = read('scripts/run-weekly-optimization.ts')
assert.match(weeklyOptimization, /buildRunKey/)
assert.match(weeklyOptimization, /implementationFingerprint/)
assert.match(weeklyOptimization, /same week, data dates, and implementation/)
assert.match(weeklyOptimization, /downstream publication was not started/)
assert.match(weeklyOptimization, /ML_FEATURE_HEALTH_STRICT/)
assert.match(weeklyOptimization, /ML_ACCURACY_STRICT/)
assert.match(weeklyOptimization, /heartbeatAt/)
assert.match(weeklyOptimization, /ML_MODEL_DETERIORATION_STRICT/)
assert.match(weeklyOptimization, /restoreValidatedModels/)
assert.match(weeklyOptimization, /rollback publication/)

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
const statusOverviewRoute = read('app/api/status/overview/route.ts')
assert.match(statusOverviewRoute, /fs\.realpathSync\(configuredPath\)/)
assert.match(statusOverviewRoute, /us_adjusted_foundation:shadow/)
assert.match(statusOverviewRoute, /progressBaseline/)
assert.match(statusOverviewRoute, /rateStartedAt/)
assert.match(statusOverviewRoute, /execFileAsync\('sqlite3'/)
assert.doesNotMatch(statusOverviewRoute, /createClient/)
assert.match(statusOverviewRoute, /latestUsSourceJobs/)

const usAnalyticsBuilder = read('scripts/build-us-analytics-db.ts')
assert.match(usAnalyticsBuilder, /US_ANALYTICS_NATIVE_BUSY_RETRIES/)
assert.match(usAnalyticsBuilder, /US analytics copy lock retry/)
assert.match(usAnalyticsBuilder, /waitForSharedSourceWriter/)
assert.match(usAnalyticsBuilder, /US analytics copy yielding to shared source writer/)
assert.match(usAnalyticsBuilder, /job_type <> 'us_adjusted_foundation'/)
assert.match(usAnalyticsBuilder, /\.timeout 5000/)
assert.doesNotMatch(usAnalyticsBuilder, /PRAGMA busy_timeout = 5000;\s*SELECT job_type/)
assert.match(usAnalyticsBuilder, /PRAGMA temp_store = FILE/)
assert.doesNotMatch(
  usAnalyticsBuilder,
  /BEGIN IMMEDIATE;/,
  'US analytics copy must not reserve a write lock on the attached source DB',
)
assert.match(usAnalyticsBuilder, /if \(nativeCopyAvailable\) target\.close\(\)\s+const synced = nativeSyncLatest/)
assert.match(usAnalyticsBuilder, /if \(nativeCopyAvailable\) target\.close\(\)\s+if \(nativeCopyPending/)

const updateLock = read('lib/server/update-lock.ts')
assert.match(updateLock, /localOwnerPid/)
assert.match(updateLock, /hasActiveSqliteWriterProcess/)
assert.match(updateLock, /await cleanupOrphanedUpdateLocks\(blockers\)[\s\S]*active = await execGet/)
assert.match(updateLock, /export async function cleanupOrphanedUpdateLocks/)
assert.match(updateLock, /hasActiveUsAdjustedFoundationProcess/)
assert.match(updateLock, /foundationJobTypes/)
assert.match(updateLock, /const reclaimable = orphaned\.filter/)
assert.match(updateLock, /us_adjusted_source_snapshots/)
assert.match(updateLock, /UPDATE_LOCK_BUSY_RETRIES/)
assert.match(updateLock, /waiting for SQLite writer slot/)
assert.match(updateLock, /export const JP_STOCKBOARD_UPDATE_JOB_TYPES/)
assert.match(updateLock, /export const US_ISOLATED_UPDATE_JOB_TYPES/)
assert.match(updateLock, /export async function acquireJpStockboardUpdateLock/)

const jpLatestUpdate = read('scripts/update-latest.ts')
assert.match(jpLatestUpdate, /JP_DAILY_UPDATE_CONFLICTS/)
assert.match(jpLatestUpdate, /jobType !== 'us_adjusted_foundation'/)
assert.match(jpLatestUpdate, /acquireDailyUpdateLock/)
assert.match(jpLatestUpdate, /UPDATE_LOCK_WAIT_SECONDS/)
assert.match(jpLatestUpdate, /process\.exitCode = 75/)

const jpMlLearning = read('scripts/run-ml-learning.ts')
assert.match(jpMlLearning, /acquireJpStockboardUpdateLock/)
assert.doesNotMatch(jpMlLearning, /acquireExclusiveUpdateLock/)

const jpMlFreshnessGuard = read('scripts/guard-ml-freshness.ts')
assert.match(jpMlFreshnessGuard, /acquireJpStockboardUpdateLock/)
assert.doesNotMatch(jpMlFreshnessGuard, /acquireExclusiveUpdateLock/)

const dataFreshnessGuard = read('scripts/guard-data-freshness.ts')
assert.match(dataFreshnessGuard, /ignoredWriterJobTypes: \['us_adjusted_foundation'\]/)
assert.match(dataFreshnessGuard, /cooldownSeconds: 15 \* 60/)
assert.match(dataFreshnessGuard, /const blockingLocks = activeLocks\.filter/)
assert.match(dataFreshnessGuard, /cleanupOrphanedUpdateLocks\(EXCLUSIVE_UPDATE_JOB_TYPES\)/)
assert.match(dataFreshnessGuard, /jpSupplementalIgnoredWriters/)
assert.match(dataFreshnessGuard, /heavy_us_ml_process/)

const kabutanMaterialNews = read('scripts/batch-kabutan-material-news.ts')
assert.match(kabutanMaterialNews, /acquireJpStockboardUpdateLock/)
assert.match(kabutanMaterialNews, /KABUTAN_MATERIAL_NEWS_WAIT_FOR_LOCK_SECONDS/)
assert.match(kabutanMaterialNews, /process\.exitCode = 75/)

const kabutanThemes = read('scripts/batch-kabutan-themes.ts')
assert.match(kabutanThemes, /acquireJpStockboardUpdateLock/)
assert.match(kabutanThemes, /if \(windowStartMs > nowMs\)/)

const kabutanThemeQueries = read('lib/queries/kabutan-themes.ts')
assert.match(kabutanThemeQueries, /WITH latest_success AS/)
assert.match(
  kabutanThemeQueries,
  /fetched_at BETWEEN latest_success\.started_at AND latest_success\.finished_at/,
)

const earningsRefresh = read('scripts/refresh-earnings.ts')
assert.match(earningsRefresh, /acquireJpStockboardUpdateLock/)
assert.match(earningsRefresh, /EARNINGS_REFRESH_WAIT_FOR_LOCK_SECONDS/)
assert.match(earningsRefresh, /process\.exitCode = 75/)

const dataFreshnessInstaller = read('scripts/install-local-data-freshness-guard.ts')
assert.match(dataFreshnessInstaller, /DATA_FRESHNESS_GUARD_INTERVAL_SECONDS \?\? '900'/)

const jpAutoUpdateInstaller = read('scripts/install-local-auto-update.ts')
assert.match(jpAutoUpdateInstaller, /UPDATE_LOCK_BUSY_RETRIES/)
assert.match(jpAutoUpdateInstaller, /UPDATE_LOCK_WAIT_SECONDS/)
assert.match(jpAutoUpdateInstaller, /UPDATE_LOCK_POLL_SECONDS/)

const jpMlInstaller = read('scripts/install-local-ml-learning.ts')
assert.match(jpMlInstaller, /ML_LEARNING_HOUR \?\? '22'/)
assert.match(jpMlInstaller, /ML_LEARNING_MINUTE \?\? '30'/)
assert.match(jpMlInstaller, /ML_LEARNING_RETRY_HOUR \?\? '3'/)
assert.match(jpMlInstaller, /ML_LEARNING_RETRY_MINUTE \?\? '0'/)
assert.match(jpMlInstaller, /flatMap/)

const usAnalyticsClient = read('lib/db/us-analytics.ts')
assert.match(usAnalyticsClient, /stat\.dev.*stat\.ino/)
assert.match(usAnalyticsClient, /retireClient/)

const usScreener = read('app/us/screener/UsScreenerClient.tsx')
assert.doesNotMatch(usScreener, /Tiingo由来の調整後株価/)
assert.match(usScreener, /価格基準の移行状況はデータ鮮度で確認できます/)

const usHexRoute = read('app/api/us/hex/route.ts')
assert.match(usHexRoute, /FROM market_universe u INDEXED BY market_universe_market_active_idx/)
assert.doesNotMatch(usHexRoute, /asset_type, 'Stock'\) IN \('Stock', 'ETF'\)/)
assert.doesNotMatch(usHexRoute, /COALESCE\(cur\.adj_close, cur\.close\) >= 0\.1/)
const usSnapshotBuilder = read('scripts/build-us-snapshots.ts')
assert.match(usSnapshotBuilder, /usInvestableSymbolSql\('u\.ticker'\)/)
assert.match(usSnapshotBuilder, /US snapshots progress/)
assert.match(usSnapshotBuilder, /priceBasis: US_ADJUSTED_PRICE_BASIS/)
assert.match(usSnapshotBuilder, /US_SNAPSHOT_TICKER_START/)
assert.match(usSnapshotBuilder, /lastCompletedTicker/)

assert.match(
  adjustedFoundation,
  /US_ANALYTICS_DB_PATH: usAnalyticsDbPath,\s*\.\.\.env,\s*USE_LOCAL_DB: '1'/,
)
assert.match(adjustedFoundation, /completedSnapshotRebuildCanRecoverBasis/)
assert.match(adjustedFoundation, /resumableSnapshotTicker/)
assert.match(adjustedFoundation, /jobType: 'us_adjusted_foundation'/)

const header = read('components/layout/Header.tsx')
assert.match(header, /\/us\/analysis\/ml-lens/)
assert.match(header, /\/us\/analysis\/transitions/)
assert.match(header, /\/us\/analysis\/backtest/)
const usAnalysisData = read('lib/server/us-analysis-dashboard.ts')
assert.match(usAnalysisData, /execUsAnalyticsAll/)
assert.doesNotMatch(usAnalysisData, /execAll.*@\/lib\/db\/client/)
assert.match(usAnalysisData, /evaluation_date <= \(SELECT MAX\(date\) FROM ohlcv_daily\)/)
assert.match(usAnalysisData, /usInvestableSymbolSql/)
assert.match(usAnalysisData, /INDEXED BY serving_current_similars_score_idx/)
assert.match(usAnalysisData, /NOT EXISTS \(/)
assert.doesNotMatch(usAnalysisData, /ROW_NUMBER\(\) OVER/)
const usMlLensPage = read('app/us/analysis/ml-lens/page.tsx')
assert.match(usMlLensPage, /検証区間終端/)
assert.match(usMlLensPage, /年次ウォークフォワード検証/)
assert.match(usMlLensPage, /PhysicsMlCandidatesPanel/)
assert.doesNotMatch(usMlLensPage, /20・40・60営業日/)
const jpMlLensPage = read('app/ai/ma-lens/page.tsx')
assert.match(jpMlLensPage, /PhysicsMlCandidatesPanel market="JP"/)
const sharedPhysicsPanel = read('components/ml/PhysicsMlCandidatesPanel.tsx')
assert.match(sharedPhysicsPanel, /ML_PHYSICS_DEFAULT_HORIZONS/)
for (const horizon of [5, 10, 20, 40, 60, 90, 200]) {
  assert.match(sharedPhysicsPanel, new RegExp(`horizonDays: ${horizon}`))
}
assert.match(sharedPhysicsPanel, /上昇候補/)
assert.match(sharedPhysicsPanel, /下落候補/)
assert.match(sharedPhysicsPanel, /見送り候補/)
const usStockDetail = read('app/us/stock/[ticker]/UsStockDetailClient.tsx')
assert.match(usStockDetail, /StockMlInsights ticker=\{quote\.ticker\} market="US"/)
assert.doesNotMatch(usStockDetail, /UsPhysicalMlRanking/)
const stockMlInsights = read('components/stock/StockMlInsights.tsx')
assert.match(stockMlInsights, /market === 'US' \? '\/api\/us\/ml-current-similars'/)
assert.match(stockMlInsights, /market === 'US' \? `\/us\/stock\//)
const usCurrentSimilarsApi = read('app/api/us/ml-current-similars/route.ts')
assert.match(usCurrentSimilarsApi, /serving_current_similars/)
assert.match(usCurrentSimilarsApi, /MIN_DISPLAY_SIMILARITY_SCORE/)
assert.match(usCurrentSimilarsApi, /analyzePhysicsProfile/)
assert.match(usAnalysisData, /c\.horizon_days IN \(5, 10, 20, 40, 60, 90, 200\)/)
assert.match(usAnalysisData, /c\.direction IN \('up', 'down', 'wait'\)/)

const webInstaller = read('scripts/install-local-web-server.ts')
assert.match(webInstaller, /<key>Nice<\/key>\n  <integer>0<\/integer>/)

const usMlHealth = read('scripts/check-us-ml-health.ts')
assert.match(usMlHealth, /US_ML_HEALTH_ALLOW_NON_OK/)
assert.match(usMlHealth, /US ML health gate failed/)
assert.match(usMlHealth, /strictCoverage/)
assert.match(usMlHealth, /latest_snapshot_with_minimum_history/)
const usMlRunner = read('scripts/run-us-ml-job.ts')
assert.match(usMlRunner, /US_ML_HEALTH_WRITE: '1'/)

const featureHealth = read('scripts/batch-ml-feature-health.ts')
assert.match(featureHealth, /ML_FEATURE_HEALTH_STRICT/)
assert.match(featureHealth, /ML_FEATURE_HEALTH_STRICT_SCOPE/)
assert.match(featureHealth, /SERVING_CHECK_KEYS/)

const jpFastMlServing = read('scripts/run-ml-serving-fast.ts')
assert.match(jpFastMlServing, /ML_FEATURE_HEALTH_STRICT_SCOPE: 'serving'/)
assert.match(featureHealth, /ML feature health gate failed/)

const memoryGuard = read('lib/system/memory-guard.ts')
assert.match(memoryGuard, /headroom\.freePercent === null[\s\S]*headroom\.compressorMb <= maxCompressorMb/)
assert.match(memoryGuard, /STOCKBOARD_MEMORY_MIN_FREE_PERCENT', 20/)
assert.match(memoryGuard, /memory_pressure is the authoritative current-pressure signal/)

const servingCache = read('lib/api/serving-cache.ts')
assert.match(servingCache, /serializeWrite/)
assert.match(servingCache, /warnBusyOnce\('read'\)/)
assert.match(servingCache, /warnBusyOnce\('cleanup'\)/)

console.log('US automation foundation tests passed')
