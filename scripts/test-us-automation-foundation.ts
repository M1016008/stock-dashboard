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
assert.match(updater, /US_ANALYTICS_SOURCE_WRITER_JOB_TO_IGNORE: 'us_update_latest'/)
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
assert.match(mlJob, /acquireUsMlProcessLock/)
assert.match(mlJob, /us-ml-job\.lock/)
assert.match(mlJob, /another US ML job is active/)
assert.match(mlJob, /exactForwardExtremaRecomputeBars/)
assert.match(mlJob, /US_ML_WEEKLY_EXTREMA_RECALC_DAYS/)
assert.match(mlJob, /baseline && !requestedExtremaRecalcDays/)
assert.match(mlJob, /batch:forward-extrema:ml-recent/)
assert.match(mlJob, /FORWARD_EXTREMA_ACTIVE_ONLY: baseline && !requestedExtremaRecalcDays \? '0' : '1'/)
assert.match(mlJob, /ML_FEATURE_ACTIVE_ONLY: baseline && featureRecentDays === '0' \? '0' : '1'/)
assert.match(mlJob, /ML_PHYSICS_ACTIVE_ONLY: baseline && physicsFeatureRecentDays === '0' \? '0' : '1'/)
assert.match(mlJob, /env\.US_PMS_RECENT_DAYS \?\? \(baseline \? '0'/)
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
assert.match(mlJob, /runFeatureJobInTickerChunks/)
assert.match(mlJob, /US_ML_FEATURE_TICKER_CHUNK_SIZE/)
assert.match(mlJob, /chunkCheckpointSignature/)
assert.match(mlJob, /checkpoint complete, skipped/)
assert.match(mlJob, /defaultChunkSize: 200/)
assert.match(mlJob, /US_ML_PHYSICS_TICKER_CHUNK_SIZE/)
assert.match(mlJob, /earliestPhysicsTrainingDate/)
assert.match(mlJob, /baseline \? earliestPhysicsTrainingDate\(env\) : physicsEvalWindow\.trainStartDate/)
assert.match(mlJob, /type Mode = 'daily' \| 'weekly' \| 'full' \| 'after-pms'/)
assert.match(mlJob, /includeInactive: baseline/)
assert.match(mlJob, /baseline \? 'all_paged' : 'yearly'/)
assert.match(mlJob, /US_ML_PHYSICS_TRAIN_SAMPLE_MODE \?\? 'yearly'/)
assert.match(mlJob, /US_ML_PHYSICS_TRAIN_EPOCHS \?\? \(baseline \? '8' : '6'\)/)
assert.match(mlJob, /US_ML_PHYSICS_TRAIN_FAST_YEARLY_MODULO \?\? \(baseline \? '2' : '10'\)/)
assert.match(mlJob, /ML_PIPELINE_ACTION: 'verify-or-adopt'/)
assert.match(mlJob, /ML_PIPELINE_ACTION: mode === 'full' \|\| mode === 'after-pms' \? 'mark-baseline' : 'mark-delta'/)
assert.match(read('scripts/manage-ml-pipeline-generation.ts'), /includeCounts: process\.env\.ML_PIPELINE_INCLUDE_COUNTS === '1'/)
assert.ok(
  mlJob.indexOf("ML_SHORT_WRITE_RL_STATES: '0'") < mlJob.indexOf("await runNpm('batch:ml-physics-train'"),
  'physics labels must be generated before physics model training',
)
assert.ok(
  mlJob.indexOf("await runNpm('batch:ml-physics-train'") < mlJob.indexOf("ML_SHORT_SKIP_LABEL_SYNC: '1'"),
  'RL states must be generated after refreshed physics training and candidates',
)

const usPmsRunner = read('scripts/run-us-physical-momentum-full.ts')
assert.match(usPmsRunner, /US_PMS_CHECKPOINT_ENABLED/)
assert.match(usPmsRunner, /checkpointInputKey/)
assert.match(usPmsRunner, /writeCheckpoint/)
assert.match(usPmsRunner, /waitForMemoryHeadroom/)
assert.match(usPmsRunner, /US_PMS_TICKER_CHUNK \?\? 250/)
assert.match(usPmsRunner, /US_PMS_DATE_CHUNK \?\? 250/)
assert.match(usPmsRunner, /PMS_START_DATE: dateChunk\[0\]/)
assert.match(usPmsRunner, /PMS_END_DATE: dateChunk\[dateChunk\.length - 1\]/)

const patternStats = read('scripts/batch-pattern-stats.ts')
assert.match(patternStats, /DELETE FROM pattern_stats WHERE horizon_days = \?/)
assert.doesNotMatch(patternStats, /DELETE FROM pattern_stats WHERE horizon_days IN/)

const stageTransitions = read('scripts/batch-stage-transitions.ts')
assert.match(stageTransitions, /全6軸の集計完了。既存値を原子的に置換/)
assert.match(stageTransitions, /client\.batch\(\[/)

const forwardExtremaBatch = read('scripts/batch-forward-extrema.ts')
assert.match(forwardExtremaBatch, /waitForMemoryHeadroom/)
assert.match(forwardExtremaBatch, /forward_extrema \$\{completed\}\/\$\{codes\.length\}/)
assert.match(forwardExtremaBatch, /FORWARD_EXTREMA_INCREMENTAL_UPSERT/)
assert.match(forwardExtremaBatch, /ON CONFLICT\(ticker, date, horizon_days\) DO UPDATE SET/)
assert.match(forwardExtremaBatch, /ROW_NUMBER\(\) OVER \(PARTITION BY ticker ORDER BY date DESC\)/)
assert.match(forwardExtremaBatch, /incrementalCoverageDates\.add/)
assert.match(forwardExtremaBatch, /ON CONFLICT\(horizon_days, date\) DO UPDATE SET updated_at/)
assert.match(read('scripts/ensure-us-adjusted-foundation.ts'), /FORWARD_EXTREMA_INCREMENTAL_UPSERT: extremaBaselineExists \? '1' : '0'/)

const mlFeaturesBatch = read('scripts/batch-ml-features.ts')
assert.match(mlFeaturesBatch, /ML_FEATURE_INCREMENTAL_UPSERT/)
assert.match(mlFeaturesBatch, /AND date >= \?/)
assert.match(mlFeaturesBatch, /ON CONFLICT\(ticker, date\) DO UPDATE SET/)
assert.match(mlFeaturesBatch, /ML_FEATURE_WRITE_LABELS/)
assert.match(mlFeaturesBatch, /ML_FEATURE_WRITE_RL_STATES/)
assert.match(read('scripts/ensure-us-adjusted-foundation.ts'), /ML_FEATURE_INCREMENTAL_UPSERT: derivedBaselineExists \? '1' : '0'/)
assert.match(read('scripts/ensure-us-adjusted-foundation.ts'), /ML_FEATURE_WRITE_LABELS: derivedBaselineExists \? '0' : '1'/)

const mlLabelsBatch = read('scripts/batch-ml-labels.ts')
assert.match(mlLabelsBatch, /ML_LABEL_INCREMENTAL_UPSERT/)
assert.match(mlLabelsBatch, /ON CONFLICT\(ticker, date, horizon_days\) DO UPDATE SET/)
assert.match(mlLabelsBatch, /ML_LABEL_CHANGED_ONLY/)
assert.match(mlLabelsBatch, /SELECT MIN\(started_at\)/)
assert.match(read('scripts/ensure-us-adjusted-foundation.ts'), /ML_LABEL_INCREMENTAL_UPSERT: derivedBaselineExists \? '1' : '0'/)
assert.match(read('scripts/ensure-us-adjusted-foundation.ts'), /ML_LABEL_CHANGED_ONLY: derivedBaselineExists \? '1' : '0'/)

const mlPhysicsFeaturesBatch = read('scripts/batch-ml-physics-features.ts')
assert.match(mlPhysicsFeaturesBatch, /ML_PHYSICS_INCREMENTAL_UPSERT/)
assert.match(mlPhysicsFeaturesBatch, /ON CONFLICT\(ticker, date, feature_set\) DO UPDATE SET/)
assert.match(read('scripts/ensure-us-adjusted-foundation.ts'), /ML_PHYSICS_INCREMENTAL_UPSERT: derivedBaselineExists \? '1' : '0'/)

const mlPhysicsTrain = read('scripts/batch-ml-physics-train.ts')
assert.match(mlPhysicsTrain, /ML_PHYSICS_TRAIN_FAST_YEARLY_MODULO \?\? 50/)
assert.match(mlPhysicsTrain, /ml_feature_vectors_v2_date_idx/)

const mlShortLabels = read('scripts/batch-ml-short-labels.ts')
assert.match(mlShortLabels, /ON CONFLICT\(ticker, date, horizon_days\) DO UPDATE SET/)
assert.doesNotMatch(mlShortLabels, /INSERT OR REPLACE INTO ml_short_labels/)

const mlRlPolicy = read('scripts/batch-ml-rl-policy.ts')
assert.match(mlRlPolicy, /ML_RL_POLICY_CACHE_PAGE_DATES \?\? 60/)
assert.match(mlRlPolicy, /\.\.\.args, POLICY_CACHE_PAGE_DATES/)

const mlPhysicsStatus = read('scripts/batch-ml-physics-status-evaluate.ts')
assert.match(mlPhysicsStatus, /ML_PHYSICS_STATUS_CACHE_PAGE_ROWS \?\? 1000/)
assert.match(mlPhysicsStatus, /\.\.\.args, STATUS_CACHE_PAGE_ROWS/)

const weeklyInstaller = read('scripts/install-local-us-ml-weekly.ts')
assert.match(weeklyInstaller, /US_ML_WEEKLY_EXTREMA_RECALC_DAYS.*201/)
assert.match(weeklyInstaller, /FORWARD_EXTREMA_RESUME.*1/)
assert.doesNotMatch(weeklyInstaller, /US_ML_WEEKLY_EXTREMA_RECENT_DAYS/)

const usWeeklyRunner = read('scripts/run-us-ml-weekly-efficient.ts')
assert.match(usWeeklyRunner, /foundationWasCurrent/)
assert.match(usWeeklyRunner, /auditedFullHistoryBaselineExists/)
assert.match(usWeeklyRunner, /batch:us-ml-weekly-replay/)
assert.match(usWeeklyRunner, /runNpm\('batch:us-ml-full-history'\)/)
assert.match(usWeeklyRunner, /audited full-history baseline proof is missing/)
assert.match(usWeeklyRunner, /full-history ML already completed inside the newly promoted adjusted generation/)
assert.match(usWeeklyRunner, /pruneValidatedPromotedBackups/)
assert.match(usWeeklyRunner, /US_PROMOTED_BACKUP_RETENTION/)
assert.match(usWeeklyRunner, /DB_MAINT_TARGETS: 'us'/)
const packageJson = read('package.json')
assert.match(packageJson, /run-us-ml-weekly-efficient\.ts/)
const packageData = JSON.parse(packageJson) as { scripts?: Record<string, string> }
assert.equal(
  packageData.scripts?.['batch:us-ml-weekly-replay'],
  'tsx --env-file=.env.local scripts/run-us-ml-job.ts weekly',
)
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
assert.match(analyticsValidation, /US_ANALYTICS_DEEP_COUNTS/)
assert.match(analyticsValidation, /FROM us_analytics_copy_state/)
assert.match(analyticsValidation, /countMode=/)
assert.match(analyticsValidation, /ohlcv_daily INDEXED BY ohlcv_date_idx ORDER BY date DESC LIMIT 1/)
assert.match(analyticsValidation, /derivedPriceDate/)
assert.match(analyticsValidation, /backtestFeatureDate/)
assert.match(analyticsValidation, /patternStatsRows/)
assert.match(analyticsValidation, /transitionAxes/)
assert.match(analyticsValidation, /servingBacktestDate/)
assert.match(analyticsValidation, /latestModelEvaluationDate/)
assert.match(analyticsValidation, /latestPhysicsEvaluationDate/)
assert.match(analyticsValidation, /latestRlEvaluationDate/)
assert.match(analyticsValidation, /latestModelTrainDate/)
assert.match(analyticsValidation, /latestPhysicsDataDate/)
assert.match(analyticsValidation, /latestRlDataDate/)
assert.match(analyticsValidation, /evaluation_date <= \(SELECT MAX\(date\) FROM ohlcv_daily\)/)

const adjustedFoundation = read('scripts/ensure-us-adjusted-foundation.ts')
assert.match(adjustedFoundation, /resumableAdjustedShadowExists/)
assert.match(adjustedFoundation, /resuming validated shadow generation/)
assert.match(adjustedFoundation, /seedAdjustedAnalyticsShadow/)
assert.match(adjustedFoundation, /seeded shadow from current adjusted analytics baseline/)
assert.match(adjustedFoundation, /adjustedForwardExtremaBaselineExists/)
assert.match(adjustedFoundation, /US_FOUNDATION_EXTREMA_RECALC_DAYS/)
assert.match(adjustedFoundation, /US_FOUNDATION_EXTREMA_WRITE_BATCH_TICKERS \?\? '100'/)
assert.match(adjustedFoundation, /US_FOUNDATION_SKIP_FORWARD_EXTREMA \?\? '0'/)
assert.match(adjustedFoundation, /reusableAdjustedDerivedBaselineExists/)
assert.match(adjustedFoundation, /US_FOUNDATION_DERIVED_RECENT_DAYS/)
assert.match(adjustedFoundation, /US_FOUNDATION_PMS_NORMALIZE_RECENT_DAYS/)
assert.match(adjustedFoundation, /US_PMS_RECENT_DAYS: derivedRecentDays/)
assert.match(adjustedFoundation, /US_ML_SKIP_FORWARD_RETURNS: derivedBaselineExists \? '1' : '0'/)

const usPmsFull = read('scripts/run-us-physical-momentum-full.ts')
assert.match(usPmsFull, /US_PMS_NORMALIZE_RECENT_DAYS/)
assert.match(usPmsFull, /profile\.dateValues\.slice\(-NORMALIZE_RECENT_DAYS\)/)
assert.match(usPmsFull, /rawComplete: saved\.rawComplete/)
assert.match(adjustedFoundation, /currentFamilyPids/)
assert.match(adjustedFoundation, /!currentFamilyPids\.has\(row\.pid\)/)

const weeklyMl = read('scripts/run-us-ml-weekly-efficient.ts')
assert.match(weeklyMl, /databaseRole: 'source' \| 'us-analytics'/)
assert.match(weeklyMl, /STOCKBOARD_DB_PATH: databaseRole === 'source' \? sourceDbPath : usAnalyticsDbPath/)
assert.match(weeklyMl, /runNpm\('batch:us-adjusted-foundation', \{\}, 'source'\)/)
assert.match(weeklyMl, /derivedDate === priceDate/)
assert.match(weeklyMl, /analogDate === priceDate/)
assert.match(weeklyMl, /analogGenerationIsCurrent\(priceDate\)/)
const weeklyOptimizationPipeline = read('scripts/run-weekly-optimization.ts')
assert.doesNotMatch(weeklyOptimizationPipeline, /jp-ma-trajectory-shadow/)
assert.doesNotMatch(weeklyOptimizationPipeline, /run-ma-trajectory-shadow/)
assert.match(adjustedFoundation, /adjustedShadowDbPath/)
assert.match(adjustedFoundation, /derived_price_basis/)
assert.match(adjustedFoundation, /derivedDate === priceDate/)
assert.match(adjustedFoundation, /analog_index_price_basis/)
assert.match(adjustedFoundation, /analogDate === priceDate/)
assert.match(adjustedFoundation, /promoteAdjustedShadow/)
assert.match(adjustedFoundation, /adjustedAnalogShadowDbPath/)
assert.match(adjustedFoundation, /analogGenerationIsCurrent/)
assert.match(adjustedFoundation, /promoteAdjustedAnalogShadow/)
assert.match(adjustedFoundation, /ANALOG_US_DB_PATH: adjustedAnalogShadowDbPath/)
assert.match(adjustedFoundation, /previous generation retained/)
assert.match(adjustedFoundation, /COPYFILE_FICLONE_FORCE/)
assert.match(adjustedFoundation, /execFileSync\('\/bin\/cp', \['-c'/)
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

const analogIndexBuilder = read('scripts/build-analog-sequence-index.ts')
assert.match(analogIndexBuilder, /reuseIdenticalFullHistory/)
assert.match(analogIndexBuilder, /sameIndexValue/)
assert.match(analogIndexBuilder, /changedOnly: mode === 'full'/)
assert.match(analogIndexBuilder, /fullTickers: mode === 'full'/)
assert.match(analogIndexBuilder, /FROM us_analytics_copy_state/)
assert.match(analogIndexBuilder, /ANALOG_HIGH_PRIORITY/)

const maSequence = read('lib/ml/ma-sequence.ts')
assert.match(maSequence, /MA_SEQUENCE_SIGNATURE_SIGNS/)
assert.doesNotMatch(
  maSequence.match(/function signatureBands[\s\S]*?\n}/)?.[0] ?? '',
  /projectionHash\(/,
)

const servingBacktest = read('scripts/build-serving-backtest.ts')
assert.match(servingBacktest, /SERVING_ONLY_SIMILAR/)
assert.match(servingBacktest, /FROM serving_backtest_results result/)
assert.doesNotMatch(servingBacktest, /FROM model_features mf[\s\S]*?LIMIT 8/)

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
assert.match(freshnessGuard, /ml_pipeline_generations/)
assert.match(freshnessGuard, /last_delta_completed_at AS lastDeltaCompletedAt/)
assert.match(freshnessGuard, /superseded_by_pipeline_delta/)
assert.match(freshnessGuard, /optional source disabled/)
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
assert.match(usMlStatusRoute, /FROM ohlcv_daily INDEXED BY ohlcv_date_idx/)
assert.doesNotMatch(usMlStatusRoute, /market_ohlcv_daily/)
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
assert.match(usAnalyticsBuilder, /US_ANALYTICS_SOURCE_WRITER_JOB_TO_IGNORE/)
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
assert.match(updateLock, /currentProcessFamilyPids/)
assert.match(updateLock, /!currentFamily\.has\(row\.pid\)/)
assert.doesNotMatch(
  updateLock,
  /refresh-earnings/,
  'ロック待機中のrefresh-earnings自体をSQLite writerと誤認しないこと',
)
assert.match(updateLock, /batch-earnings/)
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
assert.match(updateLock, /export async function acquireUsStockboardUpdateLock/)

assert.match(adjustedFoundation, /acquireUsStockboardUpdateLock/)
assert.match(adjustedFoundation, /scripts\\\/run-ml-learning/)

const usLatestUpdate = read('scripts/update-us-latest.ts')
assert.match(usLatestUpdate, /acquireUsStockboardUpdateLock/)
assert.doesNotMatch(usLatestUpdate, /acquireExclusiveUpdateLock/)

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
assert.match(kabutanMaterialNews, /const CATEGORY_IDS = \[2, 9\]/)
assert.match(kabutanMaterialNews, /KABUTAN_MATERIAL_NEWS_LOOKBACK_DAYS/)
assert.match(kabutanMaterialNews, /const healthyListScan = successfulListFetches > 0 && discoveredArticleLinks > 0/)
assert.match(kabutanMaterialNews, /if \(status !== 'success'\) process\.exitCode = 1/)
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
assert.match(earningsRefresh, /markDeferred\(\)/)
assert.match(earningsRefresh, /clearDeferred\(\)/)
assert.match(earningsRefresh, /process\.exitCode = 75/)
assert.match(earningsRefresh, /completedWhileWaiting/)
assert.match(earningsRefresh, /another refresh completed while this job waited/)
assert.match(earningsRefresh, /process\.once\('SIGTERM'/)
assert.match(earningsRefresh, /activeChild\?\.kill\(signal\)/)
assert.match(earningsRefresh, /if \(shutdownSignal\) throw error/)

const earningsRefreshInstaller = read('scripts/install-local-earnings-refresh.ts')
assert.match(earningsRefreshInstaller, /earnings-refresh-deferred/)
assert.match(earningsRefreshInstaller, /<key>PathState<\/key>/)

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
assert.match(webInstaller, /<key>US_ANALYTICS_DB_PATH<\/key>/)
assert.match(webInstaller, /stockboard-data\/us\/stockboard-us\.db/)

const usAnalyticsDb = read('lib/db/us-analytics.ts')
assert.match(usAnalyticsDb, /EXTERNAL_US_ANALYTICS_PATH/)
assert.match(usAnalyticsDb, /CURRENT_STORAGE_ROOT/)
assert.match(usAnalyticsDb, /fs\.existsSync\(localPath\)/)

const usMlHealth = read('scripts/check-us-ml-health.ts')
assert.match(usMlHealth, /US_ML_HEALTH_ALLOW_NON_OK/)
assert.match(usMlHealth, /US ML health gate failed/)
assert.match(usMlHealth, /strictCoverage/)
assert.match(usMlHealth, /latest_price_with_hybrid_minimum_history_check/)
assert.match(
  usMlHealth,
  /const pmsDate = await maxDate\(\s*'physical_momentum_metrics',\s*'date',\s*'WHERE market = \?'/,
)
assert.match(usMlHealth, /ohlcv_daily current INDEXED BY ohlcv_date_ticker_idx/)
assert.match(usMlHealth, /LIMIT 1 OFFSET \?/)
assert.match(usMlHealth, /MAX\(end_date\) OVER \(PARTITION BY horizon_days\)/)
const usMlRunner = read('scripts/run-us-ml-job.ts')
assert.match(usMlRunner, /US_ML_HEALTH_WRITE: '1'/)
assert.match(usMlRunner, /runNpm\('batch:dashboard-cache'/)

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
