// lib/db/schema.ts
import { sql } from 'drizzle-orm'
import { sqliteTable, text, integer, real, primaryKey, index } from 'drizzle-orm/sqlite-core'

// ─────────────────────────────────────
// 1. 株価・OHLCVデータ
// ─────────────────────────────────────
export const ohlcv = sqliteTable('ohlcv', {
  id:            integer('id').primaryKey({ autoIncrement: true }),
  code:          text('code').notNull(),
  market:        text('market').notNull(),       // "JP" | "US"
  date:          text('date').notNull(),          // "2026-05-05"
  open:          real('open').notNull(),
  high:          real('high').notNull(),
  low:           real('low').notNull(),
  close:         real('close').notNull(),
  volume:        integer('volume').notNull(),
  adjustedClose: real('adjusted_close'),
  source:        text('source').notNull(),        // "jquants" | "yahoo"
  createdAt:     text('created_at').notNull(),
})

// ─────────────────────────────────────
// 3. HEXステージ計算結果
// ─────────────────────────────────────
export const hexStages = sqliteTable('hex_stages', {
  id:          integer('id').primaryKey({ autoIncrement: true }),
  date:        text('date').notNull(),
  code:        text('code').notNull(),
  name:        text('name').notNull(),
  sectorLarge: text('sector_large'),
  marketCap:   real('market_cap'),
  stageA:      integer('stage_a').notNull(),    // System A: 1〜6
  stageB:      integer('stage_b'),              // System B: 1〜6（将来）
  timeframe:   text('timeframe').notNull(),      // "daily" | "weekly" | "monthly"
  close:       real('close'),
  sma5:        real('sma5'),
  sma25:       real('sma25'),
  sma75:       real('sma75'),
  rsi14:       real('rsi14'),
  macd:        real('macd'),
  createdAt:   text('created_at').notNull(),
})

// ─────────────────────────────────────
// 4. TradingView指標データ（MCP取得分）
// ─────────────────────────────────────
export const tvIndicators = sqliteTable('tv_indicators', {
  id:            integer('id').primaryKey({ autoIncrement: true }),
  code:          text('code').notNull(),
  date:          text('date').notNull(),
  timeframe:     text('timeframe').notNull(),    // "1D" | "1W" | "1M"
  close:         real('close'),
  sma5:          real('sma5'),
  sma25:         real('sma25'),
  sma75:         real('sma75'),
  sma200:        real('sma200'),
  ema5:          real('ema5'),
  ema25:         real('ema25'),
  rsi14:         real('rsi14'),
  macd:          real('macd'),
  macdSignal:    real('macd_signal'),
  macdHistogram: real('macd_histogram'),
  bbUpper:       real('bb_upper'),
  bbMiddle:      real('bb_middle'),
  bbLower:       real('bb_lower'),
  volume:        integer('volume'),
  volumeRatio:   real('volume_ratio'),
  source:        text('source').notNull(),       // "tradingview" | "calculated"
  createdAt:     text('created_at').notNull(),
})

// ─────────────────────────────────────
// 5. TradingView CSV からの日次スナップショット
//    (date, ticker) を複合主キーとして同日同銘柄は upsert
// ─────────────────────────────────────
export const tvDailySnapshots = sqliteTable(
  'tv_daily_snapshots',
  {
    date:                text('date').notNull(),       // "2026-05-05"
    ticker:              text('ticker').notNull(),     // "7203.T"
    name:                text('name').notNull(),
    price:               real('price'),
    currency:            text('currency'),             // "JPY" など
    changePercent1d:     real('change_percent_1d'),
    volume1d:            integer('volume_1d'),
    avgVolume10d:        integer('avg_volume_10d'),
    avgVolume30d:        integer('avg_volume_30d'),
    marketCap:           real('market_cap'),
    marketCapCurrency:   text('market_cap_currency'),
    perfPct1w:           real('perf_pct_1w'),
    perfPct1m:           real('perf_pct_1m'),
    perfPct3m:           real('perf_pct_3m'),
    perfPct6m:           real('perf_pct_6m'),
    perfPctYtd:          real('perf_pct_ytd'),
    // Daily SMA
    sma5d:               real('sma_5d'),
    sma25d:              real('sma_25d'),
    sma75d:              real('sma_75d'),
    sma150d:             real('sma_150d'),
    sma300d:             real('sma_300d'),
    // Weekly SMA
    sma5w:               real('sma_5w'),
    sma13w:              real('sma_13w'),
    sma25w:              real('sma_25w'),
    sma50w:              real('sma_50w'),
    sma100w:             real('sma_100w'),
    // Monthly SMA
    sma3m:               real('sma_3m'),
    sma5m:               real('sma_5m'),
    sma10m:              real('sma_10m'),
    sma20m:              real('sma_20m'),
    sma25m:              real('sma_25m'),
    // 決算
    earningsLastDate:    text('earnings_last_date'),   // "2026-02-06"
    earningsNextDate:    text('earnings_next_date'),   // "2026-05-08"
    // 取込メタ
    importedAt:          text('imported_at').notNull(),
    sourceFile:          text('source_file'),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.date, t.ticker] }),
  }),
)

// ─────────────────────────────────────
// 6. CSV取込ログ
// ─────────────────────────────────────
export const csvImports = sqliteTable('csv_imports', {
  id:           integer('id').primaryKey({ autoIncrement: true }),
  date:         text('date').notNull(),         // CSVが対象とする取引日
  fileName:     text('file_name').notNull(),
  rowCount:     integer('row_count').notNull(),
  importedAt:   text('imported_at').notNull(),
  detectionMethod: text('detection_method'),     // "filename" | "manual" | "today"
})

// ─────────────────────────────────────
// 7. Phase 2: 銘柄ユニバース (追跡対象銘柄マスタ)
// ─────────────────────────────────────
export const tickerUniverse = sqliteTable('ticker_universe', {
  ticker:             text('ticker').primaryKey(),                                          // "7203" など、.T サフィックスなし
  name:               text('name'),                                                         // 銘柄名 (任意、後で埋める)
  active:             integer('active', { mode: 'boolean' }).notNull().default(true),
  addedAt:            integer('added_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
  // Phase 3.6: 時価総額計算用にキャッシュ。J-Quants /fins/summary の ShOutFY 由来。
  shares_outstanding: integer('shares_outstanding'),                                        // 発行済株式数 (株)
  shares_updated_at:  integer('shares_updated_at', { mode: 'timestamp' }),                  // 上記の取得時刻
  // Phase 4: J-Quants /listed/info 由来の業種区分
  sector17_code:      text('sector17_code'),
  sector17_name:      text('sector17_name'),
  sector33_code:      text('sector33_code'),
  sector33_name:      text('sector33_name'),
  market_segment:     text('market_segment'),
  margin_code:        text('margin_code'),
  margin_type:        text('margin_type'),
})

export const historicalUniverse = sqliteTable(
  'historical_universe',
  {
    ticker:                    text('ticker').primaryKey(),
    name:                      text('name'),
    firstTradeDate:            text('first_trade_date').notNull(),
    lastTradeDate:             text('last_trade_date').notNull(),
    tradingDays:               integer('trading_days').notNull().default(0),
    latestOhlcvDate:           text('latest_ohlcv_date').notNull(),
    isLatestMember:            integer('is_latest_member', { mode: 'boolean' }).notNull().default(false),
    status:                    text('status').notNull(),
    missingFromTickerUniverse: integer('missing_from_ticker_universe', { mode: 'boolean' }).notNull().default(false),
    marketSegment:             text('market_segment'),
    sector17Code:              text('sector17_code'),
    sector17Name:              text('sector17_name'),
    sector33Code:              text('sector33_code'),
    sector33Name:              text('sector33_name'),
    marginType:                text('margin_type'),
    ohlcvRows:                 integer('ohlcv_rows').notNull().default(0),
    mlPhysicsV2Rows:           integer('ml_physics_v2_rows').notNull().default(0),
    hasMlPhysicsV2:            integer('has_ml_physics_v2', { mode: 'boolean' }).notNull().default(false),
    source:                    text('source').notNull().default('ohlcv_daily'),
    payloadJson:               text('payload_json').notNull().default('{}'),
    computedAt:                integer('computed_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
  },
  (t) => ({
    statusIdx: index('historical_universe_status_idx').on(t.status, t.lastTradeDate),
    latestIdx: index('historical_universe_latest_idx').on(t.isLatestMember, t.lastTradeDate),
  }),
)

export const historicalUniverseAudits = sqliteTable('historical_universe_audits', {
  id:                         integer('id').primaryKey({ autoIncrement: true }),
  runStartedAt:               integer('run_started_at', { mode: 'timestamp' }).notNull(),
  latestOhlcvDate:            text('latest_ohlcv_date'),
  ohlcvTickerCount:           integer('ohlcv_ticker_count').notNull().default(0),
  latestMemberCount:          integer('latest_member_count').notNull().default(0),
  historicalOnlyCount:        integer('historical_only_count').notNull().default(0),
  missingTickerUniverseCount: integer('missing_ticker_universe_count').notNull().default(0),
  mlFeatureCompleteCount:     integer('ml_feature_complete_count').notNull().default(0),
  mlFeatureIncompleteCount:   integer('ml_feature_incomplete_count').notNull().default(0),
  ohlcvRowCount:              integer('ohlcv_row_count').notNull().default(0),
  mlFeatureRowCount:          integer('ml_feature_row_count').notNull().default(0),
  status:                     text('status').notNull(),
  payloadJson:                text('payload_json').notNull(),
  computedAt:                 integer('computed_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
})

// ─────────────────────────────────────
// 8. Phase 2: 日足 OHLCV 履歴 (Yahoo Finance 由来、Phase 2 の単一ソース)
// ─────────────────────────────────────
export const ohlcvDaily = sqliteTable(
  'ohlcv_daily',
  {
    ticker: text('ticker').notNull(),
    date:   text('date').notNull(),               // ISO "YYYY-MM-DD"
    open:   real('open').notNull(),
    high:   real('high').notNull(),
    low:    real('low').notNull(),
    close:  real('close').notNull(),
    volume: integer('volume').notNull(),
  },
  (t) => ({
    pk:      primaryKey({ columns: [t.ticker, t.date] }),
    dateIdx: index('ohlcv_date_idx').on(t.date),
    dateTickerIdx: index('ohlcv_date_ticker_idx').on(t.date, t.ticker),
  }),
)

export const manualOhlcvDaily = sqliteTable(
  'manual_ohlcv_daily',
  {
    market:     text('market').notNull().default('JP'),
    ticker:     text('ticker').notNull(),
    date:       text('date').notNull(),
    open:       real('open').notNull(),
    high:       real('high').notNull(),
    low:        real('low').notNull(),
    close:      real('close').notNull(),
    volume:     integer('volume').notNull().default(0),
    sourceName: text('source_name'),
    sourceNote: text('source_note'),
    importedAt: integer('imported_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.market, t.ticker, t.date] }),
    tickerDateIdx: index('manual_ohlcv_market_ticker_date_idx').on(t.market, t.ticker, t.date),
  }),
)

export const marketUniverse = sqliteTable(
  'market_universe',
  {
    market:            text('market').notNull(),
    ticker:            text('ticker').notNull(),
    name:              text('name'),
    active:            integer('active', { mode: 'boolean' }).notNull().default(true),
    exchange:          text('exchange'),
    currency:          text('currency'),
    assetType:         text('asset_type'),
    sector:            text('sector'),
    industry:          text('industry'),
    startDate:         text('start_date'),
    endDate:           text('end_date'),
    sharesOutstanding: integer('shares_outstanding'),
    source:            text('source').notNull(),
    sourcePayloadJson: text('source_payload_json').notNull().default('{}'),
    updatedAt:         integer('updated_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.market, t.ticker] }),
    activeIdx: index('market_universe_market_active_idx').on(t.market, t.active, t.ticker),
    nameIdx: index('market_universe_market_name_idx').on(t.market, t.name),
  }),
)

export const marketClassifications = sqliteTable(
  'market_classifications',
  {
    market:        text('market').notNull(),
    ticker:        text('ticker').notNull(),
    taxonomy:      text('taxonomy').notNull(),
    effectiveFrom: text('effective_from').notNull().default('0000-01-01'),
    effectiveTo:   text('effective_to'),
    sectorCode:    text('sector_code'),
    sectorName:    text('sector_name'),
    industryCode:  text('industry_code'),
    industryName:  text('industry_name'),
    source:        text('source').notNull(),
    confidence:    real('confidence').notNull().default(1),
    rawJson:       text('raw_json').notNull().default('{}'),
    updatedAt:     integer('updated_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.market, t.ticker, t.taxonomy, t.effectiveFrom] }),
    taxonomySectorIdx: index('market_classifications_taxonomy_sector_idx').on(t.market, t.taxonomy, t.sectorName, t.ticker),
    taxonomyIndustryIdx: index('market_classifications_taxonomy_industry_idx').on(t.market, t.taxonomy, t.industryName, t.ticker),
    tickerIdx: index('market_classifications_ticker_idx').on(t.market, t.ticker),
  }),
)

export const marketOhlcvDaily = sqliteTable(
  'market_ohlcv_daily',
  {
    market:      text('market').notNull(),
    ticker:      text('ticker').notNull(),
    date:        text('date').notNull(),
    open:        real('open').notNull(),
    high:        real('high').notNull(),
    low:         real('low').notNull(),
    close:       real('close').notNull(),
    adjOpen:     real('adj_open'),
    adjHigh:     real('adj_high'),
    adjLow:      real('adj_low'),
    adjClose:    real('adj_close'),
    volume:      integer('volume').notNull(),
    adjVolume:   integer('adj_volume'),
    divCash:     real('div_cash'),
    splitFactor: real('split_factor'),
    source:      text('source').notNull(),
    importedAt:  integer('imported_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.market, t.ticker, t.date] }),
    dateIdx: index('market_ohlcv_market_date_idx').on(t.market, t.date),
    dateTickerIdx: index('market_ohlcv_market_date_ticker_idx').on(t.market, t.date, t.ticker),
    tickerDateIdx: index('market_ohlcv_market_ticker_date_idx').on(t.market, t.ticker, t.date),
  }),
)

export const marketDailySnapshots = sqliteTable(
  'market_daily_snapshots',
  {
    market:          text('market').notNull(),
    ticker:          text('ticker').notNull(),
    date:            text('date').notNull(),
    ma_5:            real('ma_5'),
    ma_25:           real('ma_25'),
    ma_75:           real('ma_75'),
    ma_150:          real('ma_150'),
    ma_300:          real('ma_300'),
    weekly_ma_5:     real('weekly_ma_5'),
    weekly_ma_13:    real('weekly_ma_13'),
    weekly_ma_25:    real('weekly_ma_25'),
    weekly_ma_50:    real('weekly_ma_50'),
    weekly_ma_100:   real('weekly_ma_100'),
    monthly_ma_3:    real('monthly_ma_3'),
    monthly_ma_5:    real('monthly_ma_5'),
    monthly_ma_10:   real('monthly_ma_10'),
    monthly_ma_20:   real('monthly_ma_20'),
    monthly_ma_25:   real('monthly_ma_25'),
    daily_a_stage:   integer('daily_a_stage'),
    daily_b_stage:   integer('daily_b_stage'),
    weekly_a_stage:  integer('weekly_a_stage'),
    weekly_b_stage:  integer('weekly_b_stage'),
    monthly_a_stage: integer('monthly_a_stage'),
    monthly_b_stage: integer('monthly_b_stage'),
    prevClose:        real('prev_close'),
    close5d:          real('close_5d'),
    close20d:         real('close_20d'),
    close60d:         real('close_60d'),
    close120d:        real('close_120d'),
    avgVolume20:      real('avg_volume_20'),
    ma200:            real('ma_200'),
    ma200Prev:        real('ma_200_prev'),
    ma200Observations: integer('ma_200_observations'),
    computedAt:      integer('computed_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.market, t.ticker, t.date] }),
    dateIdx: index('market_snapshots_market_date_idx').on(t.market, t.date),
    dateTickerIdx: index('market_snapshots_market_date_ticker_idx').on(t.market, t.date, t.ticker),
    stageIdx: index('market_snapshots_market_stage_idx').on(
      t.market,
      t.daily_a_stage,
      t.daily_b_stage,
      t.weekly_a_stage,
      t.weekly_b_stage,
      t.monthly_a_stage,
      t.monthly_b_stage,
      t.date,
      t.ticker,
    ),
  }),
)

export const physicalMomentumMetrics = sqliteTable(
  'physical_momentum_metrics',
  {
    market:                text('market').notNull().default('JP'),
    symbol:                text('symbol').notNull(),
    date:                  text('date').notNull(),
    velocity:              real('velocity'),
    acceleration:          real('acceleration'),
    momentum:              real('momentum'),
    force:                 real('force'),
    ma5Angle:              real('ma5_angle'),
    ma25Angle:             real('ma25_angle'),
    ma75Angle:             real('ma75_angle'),
    ma200Angle:            real('ma200_angle'),
    maAngleAvg:            real('ma_angle_avg'),
    energy:                real('energy'),
    zVelocity:             real('z_velocity'),
    zAcceleration:         real('z_acceleration'),
    zMomentum:             real('z_momentum'),
    zForce:                real('z_force'),
    zMaAngleAvg:           real('z_ma_angle_avg'),
    zEnergy:               real('z_energy'),
    physicalMomentumScore: real('physical_momentum_score'),
    physicalForceScore:    real('physical_force_score'),
    physicalEnergyScore:   real('physical_energy_score'),
    createdAt:             integer('created_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
    updatedAt:             integer('updated_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
  },
  (t) => ({
    pk:            primaryKey({ columns: [t.market, t.symbol, t.date] }),
    marketDateIdx: index('physical_momentum_market_date_idx').on(t.market, t.date),
    scoreIdx:      index('physical_momentum_market_score_idx').on(t.market, t.date, t.physicalMomentumScore),
    symbolDateIdx: index('physical_momentum_symbol_date_idx').on(t.market, t.symbol, t.date),
  }),
)

export const tradeScenarios = sqliteTable(
  'trade_scenarios',
  {
    id:                text('id').primaryKey(),
    ticker:            text('ticker').notNull(),
    market:            text('market').notNull().default('JP'),
    name:              text('name'),
    direction:         text('direction').notNull(),
    status:            text('status').notNull().default('open'),
    confidence:        text('confidence').notNull().default('medium'),
    anchorDate:        text('anchor_date').notNull(),
    anchorClose:       real('anchor_close'),
    horizonDays:       integer('horizon_days').notNull(),
    entryPlanPrice:    real('entry_plan_price'),
    targetPrice:       real('target_price'),
    stopLossPrice:     real('stop_loss_price'),
    thesis:            text('thesis').notNull(),
    invalidation:      text('invalidation'),
    reviewMemo:        text('review_memo'),
    selectedStartDate: text('selected_start_date'),
    selectedEndDate:   text('selected_end_date'),
    sourceRangeLabel:  text('source_range_label'),
    contextJson:       text('context_json').notNull().default('{}'),
    createdAt:         text('created_at').notNull(),
    updatedAt:         text('updated_at').notNull(),
  },
  (t) => ({
    tickerUpdatedIdx: index('trade_scenarios_ticker_updated_idx').on(t.market, t.ticker, t.updatedAt),
    statusIdx:        index('trade_scenarios_status_idx').on(t.status, t.updatedAt),
    anchorIdx:        index('trade_scenarios_anchor_idx').on(t.market, t.ticker, t.anchorDate),
  }),
)

export const marketDataRuns = sqliteTable(
  'market_data_runs',
  {
    id:            integer('id').primaryKey({ autoIncrement: true }),
    market:        text('market').notNull(),
    jobType:       text('job_type').notNull(),
    status:        text('status').notNull(),
    startedAt:     integer('started_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
    finishedAt:    integer('finished_at', { mode: 'timestamp' }),
    totalTickers:  integer('total_tickers').notNull().default(0),
    succeeded:     integer('succeeded').notNull().default(0),
    failed:        integer('failed').notNull().default(0),
    rowsInserted:  integer('rows_inserted').notNull().default(0),
    errorSummary:  text('error_summary'),
    payloadJson:   text('payload_json').notNull().default('{}'),
  },
  (t) => ({
    latestIdx: index('market_data_runs_latest_idx').on(t.market, t.jobType, t.startedAt),
  }),
)

export const marketEarningsCalendar = sqliteTable(
  'market_earnings_calendar',
  {
    market:          text('market').notNull(),
    ticker:          text('ticker').notNull(),
    reportDate:      text('report_date').notNull(),
    hour:            text('hour'),
    timeBucket:      text('time_bucket'),
    fiscalYear:      integer('fiscal_year'),
    fiscalQuarter:   integer('fiscal_quarter'),
    epsEstimate:     real('eps_estimate'),
    epsActual:       real('eps_actual'),
    revenueEstimate: real('revenue_estimate'),
    revenueActual:   real('revenue_actual'),
    source:          text('source').notNull(),
    sourceUrl:       text('source_url'),
    rawJson:         text('raw_json').notNull().default('{}'),
    importedAt:      integer('imported_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
  },
  (t) => ({
    pk:            primaryKey({ columns: [t.market, t.ticker, t.reportDate] }),
    dateIdx:       index('market_earnings_market_date_idx').on(t.market, t.reportDate, t.ticker),
    tickerDateIdx: index('market_earnings_market_ticker_date_idx').on(t.market, t.ticker, t.reportDate),
    bucketDateIdx: index('market_earnings_market_bucket_date_idx').on(t.market, t.timeBucket, t.reportDate),
  }),
)

export const sectorEtfHoldings = sqliteTable(
  'sector_etf_holdings',
  {
    id:            integer('id').primaryKey({ autoIncrement: true }),
    etfTicker:     text('etf_ticker').notNull(),
    holdingTicker: text('holding_ticker').notNull(),
    holdingName:   text('holding_name').notNull(),
    weightPct:     real('weight_pct'),
    shares:        real('shares'),
    marketValue:   real('market_value'),
    asOfDate:      text('as_of_date'),
    source:        text('source').notNull(),
    sourceUrl:     text('source_url'),
    rawJson:       text('raw_json').notNull().default('{}'),
    updatedAt:     integer('updated_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
  },
  (t) => ({
    etfWeightIdx: index('sector_etf_holdings_etf_weight_idx').on(t.etfTicker, t.weightPct),
    holdingTickerIdx: index('sector_etf_holdings_ticker_idx').on(t.holdingTicker),
    asOfIdx: index('sector_etf_holdings_as_of_idx').on(t.etfTicker, t.asOfDate),
  }),
)

export const sectorEtfHoldingRuns = sqliteTable(
  'sector_etf_holding_runs',
  {
    id:            integer('id').primaryKey({ autoIncrement: true }),
    etfTicker:     text('etf_ticker').notNull(),
    source:        text('source').notNull(),
    status:        text('status').notNull(),
    startedAt:     integer('started_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
    finishedAt:    integer('finished_at', { mode: 'timestamp' }),
    holdingsCount: integer('holdings_count').notNull().default(0),
    errorSummary:  text('error_summary'),
    sourceUrl:     text('source_url'),
    payloadJson:   text('payload_json').notNull().default('{}'),
  },
  (t) => ({
    latestIdx: index('sector_etf_holding_runs_latest_idx').on(t.etfTicker, t.startedAt),
    statusIdx: index('sector_etf_holding_runs_status_idx').on(t.status, t.startedAt),
  }),
)

export const jquantsDailyCoverage = sqliteTable('jquants_daily_coverage', {
  date:          text('date').primaryKey(),
  expectedRows:  integer('expected_rows').notNull(),
  importedAt:    integer('imported_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
})

export const updateLocks = sqliteTable('update_locks', {
  jobType:        text('job_type').primaryKey(),
  status:         text('status').notNull(),
  owner:          text('owner'),
  startedAt:      integer('started_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
  heartbeatAt:    integer('heartbeat_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
  leaseExpiresAt: integer('lease_expires_at', { mode: 'timestamp' }).notNull(),
})

export const jquantsSyncRuns = sqliteTable(
  'jquants_sync_runs',
  {
    id:             integer('id').primaryKey({ autoIncrement: true }),
    targetDate:     text('target_date').notNull(),
    apiType:        text('api_type').notNull(),
    expectedRows:   integer('expected_rows').notNull().default(0),
    importedRows:   integer('imported_rows').notNull().default(0),
    missingTickers: text('missing_tickers'),
    status:         text('status').notNull(),
    startedAt:      integer('started_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
    finishedAt:     integer('finished_at', { mode: 'timestamp' }),
    errorSummary:   text('error_summary'),
  },
  (t) => ({
    targetIdx: index('jquants_sync_target_idx').on(t.targetDate, t.apiType),
  }),
)

export const computeState = sqliteTable(
  'compute_state',
  {
    jobType:           text('job_type').notNull(),
    ticker:            text('ticker').notNull(),
    lastProcessedDate: text('last_processed_date'),
    updatedAt:         integer('updated_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.jobType, t.ticker] }),
    jobDateIdx: index('compute_state_job_date_idx').on(t.jobType, t.lastProcessedDate),
  }),
)

export const dashboardCache = sqliteTable('dashboard_cache', {
  date:        text('date').primaryKey(),
  payloadJson: text('payload_json').notNull(),
  computedAt:  integer('computed_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
})

export const dashboardTradeSignalCache = sqliteTable(
  'dashboard_trade_signal_cache',
  {
    cacheKey:    text('cache_key').primaryKey(),
    payloadJson: text('payload_json').notNull(),
    computedAt: integer('computed_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
  },
  (t) => ({
    computedIdx: index('dashboard_trade_signal_cache_computed_idx').on(t.computedAt),
  }),
)

export const dashboardEarningsAlertCache = sqliteTable(
  'dashboard_earnings_alert_cache',
  {
    cacheKey:    text('cache_key').primaryKey(),
    payloadJson: text('payload_json').notNull(),
    computedAt: integer('computed_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
  },
  (t) => ({
    computedIdx: index('dashboard_earnings_alert_cache_computed_idx').on(t.computedAt),
  }),
)

export const kabutanMaterialNews = sqliteTable(
  'kabutan_material_news',
  {
    articleId:           text('article_id').primaryKey(),
    title:               text('title').notNull(),
    publishedAt:         text('published_at').notNull(),
    url:                 text('url').notNull(),
    category:            text('category').notNull().default('材料'),
    snippet:             text('snippet'),
    relatedTickersJson:  text('related_tickers_json').notNull().default('[]'),
    relatedStocksJson:   text('related_stocks_json').notNull().default('[]'),
    source:              text('source').notNull().default('kabutan'),
    fetchedAt:           integer('fetched_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
    parseStatus:         text('parse_status').notNull().default('ok'),
    errorSummary:        text('error_summary'),
  },
  (t) => ({
    publishedIdx: index('kabutan_material_news_published_idx').on(t.publishedAt),
    statusIdx: index('kabutan_material_news_status_idx').on(t.parseStatus, t.fetchedAt),
  }),
)

export const kabutanMaterialNewsRuns = sqliteTable(
  'kabutan_material_news_runs',
  {
    id:           integer('id').primaryKey({ autoIncrement: true }),
    status:       text('status').notNull(),
    startedAt:    integer('started_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
    finishedAt:   integer('finished_at', { mode: 'timestamp' }),
    fetchedCount: integer('fetched_count').notNull().default(0),
    savedCount:   integer('saved_count').notNull().default(0),
    errorSummary: text('error_summary'),
  },
  (t) => ({
    latestIdx: index('kabutan_material_news_runs_latest_idx').on(t.startedAt),
  }),
)

export const kabutanThemes = sqliteTable(
  'kabutan_themes',
  {
    themeId:                  text('theme_id').primaryKey(),
    name:                     text('name').notNull(),
    rank:                     integer('rank'),
    rankingPeriod:            text('ranking_period').notNull().default('3days_access'),
    rankingAsOf:              text('ranking_as_of'),
    url:                      text('url').notNull(),
    description:              text('description'),
    representativeStocksJson: text('representative_stocks_json').notNull().default('[]'),
    relatedStocksJson:        text('related_stocks_json').notNull().default('[]'),
    stockCount:               integer('stock_count'),
    source:                   text('source').notNull().default('kabutan'),
    fetchedAt:                integer('fetched_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
    parseStatus:              text('parse_status').notNull().default('ok'),
    errorSummary:             text('error_summary'),
  },
  (t) => ({
    rankIdx: index('kabutan_themes_rank_idx').on(t.rank, t.fetchedAt),
    statusIdx: index('kabutan_themes_status_idx').on(t.parseStatus, t.fetchedAt),
  }),
)

export const kabutanThemeRuns = sqliteTable(
  'kabutan_theme_runs',
  {
    id:           integer('id').primaryKey({ autoIncrement: true }),
    status:       text('status').notNull(),
    startedAt:    integer('started_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
    finishedAt:   integer('finished_at', { mode: 'timestamp' }),
    fetchedCount: integer('fetched_count').notNull().default(0),
    savedCount:   integer('saved_count').notNull().default(0),
    errorSummary: text('error_summary'),
  },
  (t) => ({
    latestIdx: index('kabutan_theme_runs_latest_idx').on(t.startedAt),
  }),
)

export const servingDailySnapshotDates = sqliteTable('serving_daily_snapshot_dates', {
  date:       text('date').primaryKey(),
  tickers:    integer('tickers').notNull(),
  computedAt: integer('computed_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
})

// ─────────────────────────────────────
// 9. Phase 2: 日次スナップショット (MA15本 + ステージ6種を事前計算)
//    NULL 可。クールドスタート期間 (履歴不足) では計算できないため。
// ─────────────────────────────────────
export const dailySnapshots = sqliteTable(
  'daily_snapshots',
  {
    ticker:           text('ticker').notNull(),
    date:             text('date').notNull(),
    // MA 値15本 (lib/hex-stage.ts MaValues と同じ snake_case 名 → スプレッドで挿入可)
    ma_5:             real('ma_5'),
    ma_25:            real('ma_25'),
    ma_75:            real('ma_75'),
    ma_150:           real('ma_150'),
    ma_300:           real('ma_300'),
    weekly_ma_5:      real('weekly_ma_5'),
    weekly_ma_13:     real('weekly_ma_13'),
    weekly_ma_25:     real('weekly_ma_25'),
    weekly_ma_50:     real('weekly_ma_50'),
    weekly_ma_100:    real('weekly_ma_100'),
    monthly_ma_3:     real('monthly_ma_3'),
    monthly_ma_5:     real('monthly_ma_5'),
    monthly_ma_10:    real('monthly_ma_10'),
    monthly_ma_20:    real('monthly_ma_20'),
    monthly_ma_25:    real('monthly_ma_25'),
    // ステージ6種 (lib/hex-stage.ts StageResult と同じ snake_case 名)
    daily_a_stage:    integer('daily_a_stage'),
    daily_b_stage:    integer('daily_b_stage'),
    weekly_a_stage:   integer('weekly_a_stage'),
    weekly_b_stage:   integer('weekly_b_stage'),
    monthly_a_stage:  integer('monthly_a_stage'),
    monthly_b_stage:  integer('monthly_b_stage'),
    computedAt:       integer('computed_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
  },
  (t) => ({
    pk:      primaryKey({ columns: [t.ticker, t.date] }),
    dateIdx: index('snapshots_date_idx').on(t.date),
    dateTickerIdx: index('snapshots_date_ticker_idx').on(t.date, t.ticker),
    stagePatternIdx: index('snapshots_stage_pattern_idx').on(
      t.daily_a_stage,
      t.daily_b_stage,
      t.weekly_a_stage,
      t.weekly_b_stage,
      t.monthly_a_stage,
      t.monthly_b_stage,
      t.date,
      t.ticker,
    ),
  }),
)

// 業種・細分類ごとの6ステージ構造集計。個別銘柄のMA構造を構成比と
// 遷移で集約するため、株価水準の平均は保存しない。
export const sectorStructureDaily = sqliteTable(
  'sector_structure_daily',
  {
    taxonomy:               text('taxonomy').notNull(),
    groupKey:               text('group_key').notNull(),
    groupName:              text('group_name').notNull(),
    parentGroup:            text('parent_group'),
    date:                   text('date').notNull(),
    nStocks:                integer('n_stocks').notNull(),
    validStageCount:        integer('valid_stage_count').notNull(),
    strengthScore:          real('strength_score'),
    transitionChangeScore:  real('transition_change_score').notNull(),
    momentum5d:             real('momentum_5d'),
    momentum10d:            real('momentum_10d'),
    momentum20d:            real('momentum_20d'),
    propagationDirection:   text('propagation_direction').notNull().default('neutral'),
    propagationPhase:       integer('propagation_phase').notNull().default(0),
    propagationLabel:       text('propagation_label').notNull(),
    improvingCount:         integer('improving_count').notNull().default(0),
    deterioratingCount:     integer('deteriorating_count').notNull().default(0),
    stableCount:            integer('stable_count').notNull().default(0),
    axisJson:               text('axis_json').notNull(),
    compositionJson:        text('composition_json').notNull(),
    computedAt:             integer('computed_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.taxonomy, t.groupKey, t.date] }),
    taxonomyDateIdx: index('sector_structure_taxonomy_date_idx').on(t.taxonomy, t.date),
    dateMomentumIdx: index('sector_structure_date_momentum_idx').on(t.date, t.momentum10d),
  }),
)

// 旧25M互換テーブル。新規処理はmonthly_ma_monitor_*へ統合済み。
export const ma25mMonitorDaily = sqliteTable(
  'ma25m_monitor_daily',
  {
    ticker:                    text('ticker').notNull(),
    date:                      text('date').notNull(),
    close:                     real('close').notNull(),
    ma25m:                     real('ma25m').notNull(),
    distancePct:               real('distance_pct').notNull(),
    absDistancePct:            real('abs_distance_pct').notNull(),
    distance1dPct:             real('distance_1d_pct'),
    distance3dPct:             real('distance_3d_pct'),
    distance5dPct:             real('distance_5d_pct'),
    distance10dPct:            real('distance_10d_pct'),
    distance20dPct:            real('distance_20d_pct'),
    positionSide:              text('position_side').notNull(),
    isApproaching:             integer('is_approaching', { mode: 'boolean' }).notNull().default(false),
    approachDirection:         text('approach_direction').notNull().default('none'),
    approachSpeedPctPerDay:    real('approach_speed_pct_per_day').notNull().default(0),
    approachConsistency:       real('approach_consistency').notNull().default(0),
    distanceShrink5Pct:        real('distance_shrink_5_pct'),
    distanceShrink10Pct:       real('distance_shrink_10_pct'),
    isContactDefault:          integer('is_contact_default', { mode: 'boolean' }).notNull().default(false),
    isTouch:                   integer('is_touch', { mode: 'boolean' }).notNull().default(false),
    lastTouchDate:             text('last_touch_date'),
    touchAgeSessions:          integer('touch_age_sessions'),
    crossDirection:            text('cross_direction'),
    lastCrossDate:             text('last_cross_date'),
    lastCrossDirection:        text('last_cross_direction'),
    crossAgeSessions:          integer('cross_age_sessions'),
    primaryStatus:             text('primary_status').notNull(),
    closenessScore:            real('closeness_score').notNull(),
    movementScore:             real('movement_score').notNull(),
    eventScore:                real('event_score').notNull(),
    approachScore:             real('approach_score').notNull(),
    isRapidApproach:           integer('is_rapid_approach', { mode: 'boolean' }).notNull().default(false),
    computedAt:                integer('computed_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.ticker, t.date] }),
    dateScoreIdx: index('ma25m_monitor_date_score_idx').on(t.date, t.approachScore),
    dateDistanceIdx: index('ma25m_monitor_date_distance_idx').on(t.date, t.absDistancePct),
    dateApproachIdx: index('ma25m_monitor_date_approach_idx').on(t.date, t.isApproaching, t.approachScore),
    tickerDateIdx: index('ma25m_monitor_ticker_date_idx').on(t.ticker, t.date),
  }),
)

// 一覧API専用。履歴全体を集計せず、銘柄ごとの最新1行だけを読む。
export const ma25mMonitorLatest = sqliteTable(
  'ma25m_monitor_latest',
  {
    ticker:                    text('ticker').primaryKey(),
    date:                      text('date').notNull(),
    close:                     real('close').notNull(),
    ma25m:                     real('ma25m').notNull(),
    distancePct:               real('distance_pct').notNull(),
    absDistancePct:            real('abs_distance_pct').notNull(),
    distance1dPct:             real('distance_1d_pct'),
    distance3dPct:             real('distance_3d_pct'),
    distance5dPct:             real('distance_5d_pct'),
    distance10dPct:            real('distance_10d_pct'),
    distance20dPct:            real('distance_20d_pct'),
    positionSide:              text('position_side').notNull(),
    isApproaching:             integer('is_approaching', { mode: 'boolean' }).notNull().default(false),
    approachDirection:         text('approach_direction').notNull().default('none'),
    approachSpeedPctPerDay:    real('approach_speed_pct_per_day').notNull().default(0),
    approachConsistency:       real('approach_consistency').notNull().default(0),
    distanceShrink5Pct:        real('distance_shrink_5_pct'),
    distanceShrink10Pct:       real('distance_shrink_10_pct'),
    isContactDefault:          integer('is_contact_default', { mode: 'boolean' }).notNull().default(false),
    isTouch:                   integer('is_touch', { mode: 'boolean' }).notNull().default(false),
    lastTouchDate:             text('last_touch_date'),
    touchAgeSessions:          integer('touch_age_sessions'),
    crossDirection:            text('cross_direction'),
    lastCrossDate:             text('last_cross_date'),
    lastCrossDirection:        text('last_cross_direction'),
    crossAgeSessions:          integer('cross_age_sessions'),
    primaryStatus:             text('primary_status').notNull(),
    closenessScore:            real('closeness_score').notNull(),
    movementScore:             real('movement_score').notNull(),
    eventScore:                real('event_score').notNull(),
    approachScore:             real('approach_score').notNull(),
    isRapidApproach:           integer('is_rapid_approach', { mode: 'boolean' }).notNull().default(false),
    computedAt:                integer('computed_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
  },
  (t) => ({
    dateScoreIdx: index('ma25m_latest_date_score_idx').on(t.date, t.approachScore),
    dateDistanceIdx: index('ma25m_latest_date_distance_idx').on(t.date, t.absDistancePct),
    dateApproachIdx: index('ma25m_latest_date_approach_idx').on(t.date, t.isApproaching, t.approachScore),
  }),
)

// 月足MA監視の共通保存先。periodを主キーへ含め、監視期間の追加に対応する。
export const monthlyMaMonitorDaily = sqliteTable(
  'monthly_ma_monitor_daily',
  {
    ticker:                    text('ticker').notNull(),
    period:                    integer('period').notNull(),
    date:                      text('date').notNull(),
    close:                     real('close').notNull(),
    maValue:                   real('ma_value').notNull(),
    distancePct:               real('distance_pct').notNull(),
    absDistancePct:            real('abs_distance_pct').notNull(),
    distance1dPct:             real('distance_1d_pct'),
    distance3dPct:             real('distance_3d_pct'),
    distance5dPct:             real('distance_5d_pct'),
    distance10dPct:            real('distance_10d_pct'),
    distance20dPct:            real('distance_20d_pct'),
    positionSide:              text('position_side').notNull(),
    isApproaching:             integer('is_approaching', { mode: 'boolean' }).notNull().default(false),
    approachDirection:         text('approach_direction').notNull().default('none'),
    approachSpeedPctPerDay:    real('approach_speed_pct_per_day').notNull().default(0),
    approachConsistency:       real('approach_consistency').notNull().default(0),
    distanceShrink5Pct:        real('distance_shrink_5_pct'),
    distanceShrink10Pct:       real('distance_shrink_10_pct'),
    isContactDefault:          integer('is_contact_default', { mode: 'boolean' }).notNull().default(false),
    isTouch:                   integer('is_touch', { mode: 'boolean' }).notNull().default(false),
    lastTouchDate:             text('last_touch_date'),
    touchAgeSessions:          integer('touch_age_sessions'),
    crossDirection:            text('cross_direction'),
    lastCrossDate:             text('last_cross_date'),
    lastCrossDirection:        text('last_cross_direction'),
    crossAgeSessions:          integer('cross_age_sessions'),
    primaryStatus:             text('primary_status').notNull(),
    closenessScore:            real('closeness_score').notNull(),
    movementScore:             real('movement_score').notNull(),
    eventScore:                real('event_score').notNull(),
    approachScore:             real('approach_score').notNull(),
    isRapidApproach:           integer('is_rapid_approach', { mode: 'boolean' }).notNull().default(false),
    computedAt:                integer('computed_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.ticker, t.period, t.date] }),
    datePeriodScoreIdx: index('monthly_ma_monitor_date_period_score_idx').on(t.date, t.period, t.approachScore),
    datePeriodDistanceIdx: index('monthly_ma_monitor_date_period_distance_idx').on(t.date, t.period, t.absDistancePct),
    tickerPeriodDateIdx: index('monthly_ma_monitor_ticker_period_date_idx').on(t.ticker, t.period, t.date),
  }),
)

export const monthlyMaMonitorLatest = sqliteTable(
  'monthly_ma_monitor_latest',
  {
    ticker:                    text('ticker').notNull(),
    period:                    integer('period').notNull(),
    date:                      text('date').notNull(),
    close:                     real('close').notNull(),
    maValue:                   real('ma_value').notNull(),
    distancePct:               real('distance_pct').notNull(),
    absDistancePct:            real('abs_distance_pct').notNull(),
    distance1dPct:             real('distance_1d_pct'),
    distance3dPct:             real('distance_3d_pct'),
    distance5dPct:             real('distance_5d_pct'),
    distance10dPct:            real('distance_10d_pct'),
    distance20dPct:            real('distance_20d_pct'),
    positionSide:              text('position_side').notNull(),
    isApproaching:             integer('is_approaching', { mode: 'boolean' }).notNull().default(false),
    approachDirection:         text('approach_direction').notNull().default('none'),
    approachSpeedPctPerDay:    real('approach_speed_pct_per_day').notNull().default(0),
    approachConsistency:       real('approach_consistency').notNull().default(0),
    distanceShrink5Pct:        real('distance_shrink_5_pct'),
    distanceShrink10Pct:       real('distance_shrink_10_pct'),
    isContactDefault:          integer('is_contact_default', { mode: 'boolean' }).notNull().default(false),
    isTouch:                   integer('is_touch', { mode: 'boolean' }).notNull().default(false),
    lastTouchDate:             text('last_touch_date'),
    touchAgeSessions:          integer('touch_age_sessions'),
    crossDirection:            text('cross_direction'),
    lastCrossDate:             text('last_cross_date'),
    lastCrossDirection:        text('last_cross_direction'),
    crossAgeSessions:          integer('cross_age_sessions'),
    primaryStatus:             text('primary_status').notNull(),
    closenessScore:            real('closeness_score').notNull(),
    movementScore:             real('movement_score').notNull(),
    eventScore:                real('event_score').notNull(),
    approachScore:             real('approach_score').notNull(),
    isRapidApproach:           integer('is_rapid_approach', { mode: 'boolean' }).notNull().default(false),
    computedAt:                integer('computed_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.ticker, t.period] }),
    datePeriodScoreIdx: index('monthly_ma_latest_date_period_score_idx').on(t.date, t.period, t.approachScore),
    datePeriodDistanceIdx: index('monthly_ma_latest_date_period_distance_idx').on(t.date, t.period, t.absDistancePct),
  }),
)

// 連続する3本以上の月足MA帯。latestには全候補群の状態を保持し、APIはis_maximalを表示する。
export const monthlyMaClusterDaily = sqliteTable(
  'monthly_ma_cluster_daily',
  {
    ticker:                    text('ticker').notNull(),
    clusterKey:                text('cluster_key').notNull(),
    date:                      text('date').notNull(),
    periodsJson:               text('periods_json').notNull(),
    periodCount:               integer('period_count').notNull(),
    clusterType:               text('cluster_type').notNull(),
    isStrong:                  integer('is_strong', { mode: 'boolean' }).notNull().default(false),
    bandLow:                   real('band_low').notNull(),
    bandHigh:                  real('band_high').notNull(),
    bandAverage:               real('band_average').notNull(),
    spreadPct:                 real('spread_pct').notNull(),
    close:                     real('close').notNull(),
    distancePct:               real('distance_pct').notNull(),
    absDistancePct:            real('abs_distance_pct').notNull(),
    approachDirection:         text('approach_direction').notNull().default('none'),
    isApproaching:             integer('is_approaching', { mode: 'boolean' }).notNull().default(false),
    approachSpeedPctPerDay:    real('approach_speed_pct_per_day').notNull().default(0),
    isTouch:                   integer('is_touch', { mode: 'boolean' }).notNull().default(false),
    lastTouchDate:             text('last_touch_date'),
    touchAgeSessions:          integer('touch_age_sessions'),
    crossDirection:            text('cross_direction'),
    lastCrossDate:             text('last_cross_date'),
    lastCrossDirection:        text('last_cross_direction'),
    crossAgeSessions:          integer('cross_age_sessions'),
    primaryStatus:             text('primary_status').notNull(),
    approachScore:             real('approach_score').notNull(),
    computedAt:                integer('computed_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.ticker, t.clusterKey, t.date] }),
    dateScoreIdx: index('monthly_ma_cluster_date_score_idx').on(t.date, t.approachScore),
    tickerDateIdx: index('monthly_ma_cluster_ticker_date_idx').on(t.ticker, t.date),
  }),
)

export const monthlyMaClusterLatest = sqliteTable(
  'monthly_ma_cluster_latest',
  {
    ticker:                    text('ticker').notNull(),
    clusterKey:                text('cluster_key').notNull(),
    date:                      text('date').notNull(),
    periodsJson:               text('periods_json').notNull(),
    periodCount:               integer('period_count').notNull(),
    clusterType:               text('cluster_type').notNull(),
    isStrong:                  integer('is_strong', { mode: 'boolean' }).notNull().default(false),
    bandLow:                   real('band_low').notNull(),
    bandHigh:                  real('band_high').notNull(),
    bandAverage:               real('band_average').notNull(),
    spreadPct:                 real('spread_pct').notNull(),
    close:                     real('close').notNull(),
    distancePct:               real('distance_pct').notNull(),
    absDistancePct:            real('abs_distance_pct').notNull(),
    approachDirection:         text('approach_direction').notNull().default('none'),
    isApproaching:             integer('is_approaching', { mode: 'boolean' }).notNull().default(false),
    approachSpeedPctPerDay:    real('approach_speed_pct_per_day').notNull().default(0),
    isTouch:                   integer('is_touch', { mode: 'boolean' }).notNull().default(false),
    lastTouchDate:             text('last_touch_date'),
    touchAgeSessions:          integer('touch_age_sessions'),
    crossDirection:            text('cross_direction'),
    lastCrossDate:             text('last_cross_date'),
    lastCrossDirection:        text('last_cross_direction'),
    crossAgeSessions:          integer('cross_age_sessions'),
    primaryStatus:             text('primary_status').notNull(),
    approachScore:             real('approach_score').notNull(),
    isCluster:                 integer('is_cluster', { mode: 'boolean' }).notNull().default(false),
    isMaximal:                 integer('is_maximal', { mode: 'boolean' }).notNull().default(false),
    computedAt:                integer('computed_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.ticker, t.clusterKey] }),
    dateClusterScoreIdx: index('monthly_ma_cluster_latest_date_state_idx').on(t.date, t.isCluster, t.isMaximal, t.approachScore),
  }),
)

// ─────────────────────────────────────
// 10. Phase 2: バッチ実行履歴 (OHLCV 取得 / スナップショット計算の成否)
// ─────────────────────────────────────
export const batchRuns = sqliteTable('batch_runs', {
  id:            integer('id').primaryKey({ autoIncrement: true }),
  jobType:       text('job_type').notNull(),       // 'ohlcv_fetch' | 'snapshot_compute' | 'feature_compute' | 'forward_returns' | 'pattern_stats'
  startedAt:     integer('started_at', { mode: 'timestamp' }).notNull(),
  finishedAt:    integer('finished_at', { mode: 'timestamp' }),
  status:        text('status').notNull(),          // 'running' | 'success' | 'failed' | 'partial'
  totalTickers:  integer('total_tickers'),
  succeeded:     integer('succeeded').default(0),
  failed:        integer('failed').default(0),
  rowsInserted:  integer('rows_inserted').default(0),
  errorSummary:  text('error_summary'),             // JSON 文字列、先頭10件のエラー
})

// ─────────────────────────────────────
// 11. Phase 3: 特徴量スナップショット (3 timescale × 30+ 次元の特徴量ベクトル)
//     daily_snapshots と (ticker, date) で対応するが timescale ごとに別行
// ─────────────────────────────────────
export const featureSnapshots = sqliteTable(
  'feature_snapshots',
  {
    ticker:    text('ticker').notNull(),
    date:      text('date').notNull(),
    timescale: text('timescale').notNull(),  // 'daily' | 'weekly' | 'monthly'

    // セクション A: 並び順 (12 次元)
    // Period A: ma1-ma2, ma1-ma3, ma2-ma3 / Period B: ma3-ma4, ma3-ma5, ma4-ma5
    bin_order_a_12: integer('bin_order_a_12'),
    bin_order_a_13: integer('bin_order_a_13'),
    bin_order_a_23: integer('bin_order_a_23'),
    bin_order_b_12: integer('bin_order_b_12'),
    bin_order_b_13: integer('bin_order_b_13'),
    bin_order_b_23: integer('bin_order_b_23'),
    rel_dist_a_12: real('rel_dist_a_12'),
    rel_dist_a_13: real('rel_dist_a_13'),
    rel_dist_a_23: real('rel_dist_a_23'),
    rel_dist_b_12: real('rel_dist_b_12'),
    rel_dist_b_13: real('rel_dist_b_13'),
    rel_dist_b_23: real('rel_dist_b_23'),

    // セクション B: 拡散ダイナミクス (8 次元)
    divergence_a:          real('divergence_a'),
    divergence_b:          real('divergence_b'),
    divergence_a_delta:    real('divergence_a_delta'),
    divergence_b_delta:    real('divergence_b_delta'),
    fan_uniformity:        real('fan_uniformity'),
    divergence_percentile: real('divergence_percentile'),
    stage_a_age:           integer('stage_a_age'),
    stage_b_age:           integer('stage_b_age'),

    // セクション C: トレンドダイナミクス (11 次元)
    slope_m1: real('slope_m1'), accel_m1: real('accel_m1'),
    slope_m2: real('slope_m2'), accel_m2: real('accel_m2'),
    slope_m3: real('slope_m3'), accel_m3: real('accel_m3'),
    slope_m4: real('slope_m4'), accel_m4: real('accel_m4'),
    slope_m5: real('slope_m5'), accel_m5: real('accel_m5'),
    angle_synchrony: real('angle_synchrony'),

    // セクション D: ステージ one-hot (JSON 文字列、展開で 12 次元)
    stage_a_oh: text('stage_a_oh'),
    stage_b_oh: text('stage_b_oh'),

    computed_at: integer('computed_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
  },
  (t) => ({
    pk:           primaryKey({ columns: [t.ticker, t.date, t.timescale] }),
    dateIdx:      index('feat_date_idx').on(t.date),
    timescaleIdx: index('feat_ts_idx').on(t.timescale, t.date),
  }),
)

// ─────────────────────────────────────
// 12. Phase 3: フォワードリターン (各 (ticker, date) で 30/60/90/180 日後の % 変化)
// ─────────────────────────────────────
export const forwardReturns = sqliteTable(
  'forward_returns',
  {
    ticker:          text('ticker').notNull(),
    date:            text('date').notNull(),
    horizon_days:    integer('horizon_days').notNull(),     // 30 | 60 | 90 | 180
    return_pct:      real('return_pct').notNull(),           // 5.2 = +5.2%
    return_category: text('return_category').notNull(),      // 'very_up' | 'up' | 'flat' | 'down' | 'very_down'
    end_date:        text('end_date').notNull(),             // 計算終端日
  },
  (t) => ({
    pk:      primaryKey({ columns: [t.ticker, t.date, t.horizon_days] }),
    dateIdx: index('fwd_date_idx').on(t.date),
    horizonTickerDateIdx: index('fwd_horizon_ticker_date_idx').on(t.horizon_days, t.ticker, t.date),
  }),
)

// ─────────────────────────────────────
// 14. Phase 4: ステージ遷移カウント (6軸 × 6 from × 6 to = 216 行)
// ─────────────────────────────────────
export const stageTransitions = sqliteTable(
  'stage_transitions',
  {
    axis:        text('axis').notNull(),        // 'daily_a' | 'daily_b' | 'weekly_a' | 'weekly_b' | 'monthly_a' | 'monthly_b'
    from_stage:  integer('from_stage').notNull(),  // 1-6
    to_stage:    integer('to_stage').notNull(),    // 1-6
    count:       integer('count').notNull(),
    computed_at: integer('computed_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.axis, t.from_stage, t.to_stage] }),
  }),
)

// ─────────────────────────────────────
// 14b. Phase 4: 主要指数 OHLC (J-Quants /indices/bars/daily)
//      code: 0000=TOPIX, 0070=東証グロース250, 0500=プライム, 0501=スタンダード,
//            0502=グロース, 0503=JPXプライム150
// ─────────────────────────────────────
export const indicesDaily = sqliteTable(
  'indices_daily',
  {
    code:  text('code').notNull(),     // J-Quants 指数コード (TOPIX=0000 等)
    date:  text('date').notNull(),
    open:  real('open'),
    high:  real('high'),
    low:   real('low'),
    close: real('close'),
  },
  (t) => ({
    pk:      primaryKey({ columns: [t.code, t.date] }),
    dateIdx: index('indices_date_idx').on(t.date),
  }),
)

// ─────────────────────────────────────
// 15. Phase 4: 独自分類体系 (大分類 59 × 業種細分類 476)
//     Yoshio さん独自の Excel から取り込む。
// ─────────────────────────────────────
export const stockClassification = sqliteTable(
  'stock_classification',
  {
    ticker:         text('ticker').primaryKey(),    // ticker_universe.ticker と対応
    majorCategory:  text('major_category').notNull(),
    subIndustry:    text('sub_industry').notNull(),
    updatedAt:      integer('updated_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
  },
  (t) => ({
    majorIdx: index('idx_classification_major').on(t.majorCategory),
    subIdx:   index('idx_classification_sub').on(t.subIndustry),
  }),
)

// ─────────────────────────────────────
// 15b. 会社四季報プロフィール
//      分類CSVに同梱される評価指標・企業概要・記事本文。
// ─────────────────────────────────────
export const stockShikihoProfiles = sqliteTable(
  'stock_shikiho_profiles',
  {
    ticker:               text('ticker').primaryKey(),
    forecastPer:          real('forecast_per'),
    actualPbr:            real('actual_pbr'),
    forecastRoe:          real('forecast_roe'),
    dividendYield:        real('dividend_yield'),
    headline1:            text('headline_1'),
    description1:         text('description_1'),
    headline2:            text('headline_2'),
    description2:         text('description_2'),
    issueLabel:           text('issue_label'),
    releaseDate:          text('release_date'),
    companyFeature:       text('company_feature'),
    consolidatedBusiness: text('consolidated_business'),
    updatedAt:            integer('updated_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
  },
  (t) => ({
    issueIdx: index('idx_shikiho_profiles_issue').on(t.issueLabel),
  }),
)

// ─────────────────────────────────────
// 16. Phase 4: 信用残・空売り (J-Quants /markets/weekly_margin_interest)
// ─────────────────────────────────────
export const weeklyMarginInterest = sqliteTable(
  'weekly_margin_interest',
  {
    ticker:        text('ticker').notNull(),
    date:          text('date').notNull(),                     // 報告基準日 "YYYY-MM-DD"
    longMargin:    real('long_margin'),                        // 信用買残 (株数)
    shortMargin:   real('short_margin'),                       // 信用売残 (株数)
    longChange:    real('long_change'),                        // 前週比 (株数差)
    shortChange:   real('short_change'),
    importedAt:    integer('imported_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
  },
  (t) => ({
    pk:      primaryKey({ columns: [t.ticker, t.date] }),
    dateIdx: index('wmi_date_idx').on(t.date),
  }),
)

export const servingMarginLatest = sqliteTable(
  'serving_margin_latest',
  {
    ticker:      text('ticker').primaryKey(),
    asOfDate:    text('as_of_date').notNull(),
    marginType:  text('margin_type'),
    longMargin:  real('long_margin'),
    shortMargin: real('short_margin'),
    longChange:  real('long_change'),
    shortChange: real('short_change'),
    creditRatio: real('credit_ratio'),
    shortRatio:  real('short_ratio'),
    computedAt:  integer('computed_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
  },
  (t) => ({
    dateIdx: index('serving_margin_latest_date_idx').on(t.asOfDate),
    typeIdx: index('serving_margin_latest_type_idx').on(t.marginType, t.asOfDate),
  }),
)

export const stockFinancialSummaries = sqliteTable(
  'stock_financial_summaries',
  {
    ticker:                  text('ticker').notNull(),
    disclosureNo:            text('disclosure_no').notNull(),
    disclosureDate:          text('disclosure_date').notNull(),
    disclosureTime:          text('disclosure_time'),
    documentType:            text('document_type'),
    periodType:              text('period_type'),
    periodStart:             text('period_start'),
    periodEnd:               text('period_end'),
    fiscalYearEnd:           text('fiscal_year_end'),
    sales:                    real('sales'),
    operatingProfit:          real('operating_profit'),
    ordinaryProfit:           real('ordinary_profit'),
    netProfit:                real('net_profit'),
    eps:                      real('eps'),
    totalAssets:              real('total_assets'),
    equity:                   real('equity'),
    equityRatio:              real('equity_ratio'),
    bps:                      real('bps'),
    operatingCashFlow:        real('operating_cash_flow'),
    investingCashFlow:        real('investing_cash_flow'),
    financingCashFlow:        real('financing_cash_flow'),
    cashEquivalents:          real('cash_equivalents'),
    annualDividend:           real('annual_dividend'),
    payoutRatio:              real('payout_ratio'),
    forecastSales:            real('forecast_sales'),
    forecastOperatingProfit:  real('forecast_operating_profit'),
    forecastNetProfit:        real('forecast_net_profit'),
    forecastEps:              real('forecast_eps'),
    forecastAnnualDividend:   real('forecast_annual_dividend'),
    source:                    text('source').notNull().default('jquants'),
    importedAt:               integer('imported_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.ticker, t.disclosureNo] }),
    dateIdx: index('stock_financial_date_idx').on(t.ticker, t.disclosureDate),
  }),
)

// Normalized financial foundation. The legacy summary table above remains for
// existing screens; these tables preserve disclosure-time semantics and lineage.
export const financialDisclosures = sqliteTable(
  'financial_disclosures',
  {
    eventId:             text('event_id').primaryKey(),
    ticker:              text('ticker').notNull(),
    publishedAt:         text('published_at').notNull(),
    source:              text('source').notNull(),
    disclosureId:        text('disclosure_id').notNull(),
    documentType:        text('document_type'),
    accountingStandard:  text('accounting_standard').notNull(),
    correctionStatus:    text('correction_status').notNull(),
    metadataJson:        text('metadata_json').notNull().default('{}'),
    importedAt:          integer('imported_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
  },
  (t) => ({
    tickerPublishedIdx: index('financial_disclosures_ticker_published_idx')
      .on(t.ticker, t.publishedAt),
    sourceDisclosureIdx: index('financial_disclosures_source_disclosure_idx')
      .on(t.source, t.disclosureId),
  }),
)

export const normalizedFinancialFacts = sqliteTable(
  'normalized_financial_facts',
  {
    factId:              text('fact_id').primaryKey(),
    eventId:             text('event_id').notNull(),
    ticker:              text('ticker').notNull(),
    publishedAt:         text('published_at').notNull(),
    periodStart:         text('period_start'),
    periodEnd:           text('period_end').notNull(),
    fiscalYearStart:     text('fiscal_year_start'),
    fiscalYearEnd:       text('fiscal_year_end'),
    targetFiscalYear:    integer('target_fiscal_year'),
    periodKind:          text('period_kind').notNull(),
    accumulationKind:    text('accumulation_kind').notNull(),
    valueKind:           text('value_kind').notNull(),
    metric:              text('metric').notNull(),
    value:               real('value').notNull(),
    unit:                text('unit').notNull(),
    currency:            text('currency'),
    consolidationScope:  text('consolidation_scope').notNull(),
    accountingStandard:  text('accounting_standard').notNull(),
    correctionStatus:    text('correction_status').notNull(),
    source:              text('source').notNull(),
    sourceField:         text('source_field'),
    disclosureId:        text('disclosure_id').notNull(),
    isDerived:           integer('is_derived', { mode: 'boolean' }).notNull().default(false),
    derivationMethod:    text('derivation_method'),
    inputFactIdsJson:    text('input_fact_ids_json').notNull().default('[]'),
    definitionVersion:   text('definition_version'),
    importedAt:          integer('imported_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
  },
  (t) => ({
    tickerMetricPeriodIdx: index('normalized_financial_facts_ticker_metric_period_idx')
      .on(t.ticker, t.metric, t.periodEnd, t.publishedAt),
    eventIdx: index('normalized_financial_facts_event_idx').on(t.eventId),
    derivationIdx: index('normalized_financial_facts_derivation_idx')
      .on(t.ticker, t.isDerived, t.accumulationKind, t.periodEnd),
  }),
)

export const detailedFinancialFacts = sqliteTable(
  'detailed_financial_facts',
  {
    factId:              text('fact_id').primaryKey(),
    eventId:             text('event_id').notNull(),
    ticker:              text('ticker').notNull(),
    publishedAt:         text('published_at').notNull(),
    periodStart:         text('period_start'),
    periodEnd:           text('period_end').notNull(),
    valueKind:           text('value_kind').notNull(),
    metric:              text('metric').notNull(),
    value:               real('value').notNull(),
    unit:                text('unit').notNull(),
    currency:            text('currency'),
    consolidationScope:  text('consolidation_scope').notNull(),
    accountingStandard:  text('accounting_standard').notNull(),
    correctionStatus:    text('correction_status').notNull(),
    source:              text('source').notNull(),
    sourceConcept:       text('source_concept').notNull(),
    sourceNamespace:     text('source_namespace'),
    contextRef:          text('context_ref').notNull(),
    dimensionsJson:      text('dimensions_json').notNull().default('[]'),
    disclosureId:        text('disclosure_id').notNull(),
    documentId:          text('document_id'),
    sourcePriority:      integer('source_priority').notNull(),
    derivationMethod:    text('derivation_method'),
    inputFactIdsJson:    text('input_fact_ids_json').notNull().default('[]'),
    definitionVersion:   text('definition_version'),
    importedAt:          integer('imported_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
  },
  (t) => ({
    tickerMetricPeriodIdx: index('detailed_financial_facts_ticker_metric_period_idx')
      .on(t.ticker, t.metric, t.periodEnd, t.publishedAt),
    disclosureIdx: index('detailed_financial_facts_disclosure_idx').on(t.disclosureId),
    sourceConceptIdx: index('detailed_financial_facts_source_concept_idx')
      .on(t.source, t.sourceConcept),
  }),
)

export const financialForecastSnapshots = sqliteTable(
  'financial_forecast_snapshots',
  {
    snapshotId:          text('snapshot_id').primaryKey(),
    eventId:             text('event_id').notNull(),
    ticker:              text('ticker').notNull(),
    publishedAt:         text('published_at').notNull(),
    targetFiscalYear:    integer('target_fiscal_year').notNull(),
    targetPeriodStart:   text('target_period_start'),
    targetPeriodEnd:     text('target_period_end').notNull(),
    forecastScope:       text('forecast_scope').notNull(),
    forecastPeriod:      text('forecast_period').notNull(),
    metric:              text('metric').notNull(),
    value:               real('value').notNull(),
    unit:                text('unit').notNull(),
    currency:            text('currency'),
    consolidationScope:  text('consolidation_scope').notNull(),
    accountingStandard:  text('accounting_standard').notNull(),
    source:              text('source').notNull(),
    sourceField:         text('source_field').notNull(),
    disclosureId:        text('disclosure_id').notNull(),
    importedAt:          integer('imported_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
  },
  (t) => ({
    pitIdx: index('financial_forecast_snapshots_pit_idx')
      .on(t.ticker, t.metric, t.targetFiscalYear, t.publishedAt),
    eventIdx: index('financial_forecast_snapshots_event_idx').on(t.eventId),
  }),
)

export const calculatedFinancialMetrics = sqliteTable(
  'calculated_financial_metrics',
  {
    valueId:             text('value_id').primaryKey(),
    ticker:              text('ticker').notNull(),
    asOf:                text('as_of').notNull(),
    periodStart:         text('period_start'),
    periodEnd:           text('period_end'),
    metric:              text('metric').notNull(),
    value:               real('value').notNull(),
    unit:                text('unit').notNull(),
    consolidationScope:  text('consolidation_scope').notNull(),
    accountingStandard:  text('accounting_standard').notNull(),
    definitionVersion:   text('definition_version').notNull(),
    derivationMethod:    text('derivation_method').notNull(),
    inputFactIdsJson:    text('input_fact_ids_json').notNull(),
    source:              text('source').notNull().default('calculated'),
    computedAt:          integer('computed_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
  },
  (t) => ({
    tickerMetricAsOfIdx: index('calculated_financial_metrics_ticker_metric_asof_idx')
      .on(t.ticker, t.metric, t.asOf),
  }),
)

export const valuationMetricBases = sqliteTable(
  'valuation_metric_bases',
  {
    basisId:                      text('basis_id').primaryKey(),
    ticker:                       text('ticker').notNull(),
    effectiveDate:                text('effective_date').notNull(),
    transformsJson:               text('transforms_json').notNull(),
    inputFactIdsJson:             text('input_fact_ids_json').notNull(),
    metricDefinitionVersionsJson: text('metric_definition_versions_json').notNull(),
    forecastSnapshotId:           text('forecast_snapshot_id'),
    calculatedAt:                 integer('calculated_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
  },
  (t) => ({
    tickerDateIdx: index('valuation_metric_bases_ticker_date_idx').on(t.ticker, t.effectiveDate),
  }),
)

export const valuationDailyServing = sqliteTable(
  'valuation_daily_serving',
  {
    ticker:             text('ticker').notNull(),
    valuationDate:      text('valuation_date').notNull(),
    priceDate:          text('price_date').notNull(),
    price:              real('price').notNull(),
    isTradingDay:       integer('is_trading_day', { mode: 'boolean' }).notNull().default(true),
    per:                real('per'),
    forwardPer:         real('forward_per'),
    pbr:                real('pbr'),
    psr:                real('psr'),
    fcfYield:           real('fcf_yield'),
    evEbitda:           real('ev_ebitda'),
    netDebt:            real('net_debt'),
    dividendYield:      real('dividend_yield'),
    roe:                real('roe'),
    revenueGrowth:      real('revenue_growth'),
    enterpriseValue:    real('enterprise_value'),
    ebitda:             real('ebitda'),
    peerForwardPer:     real('peer_forward_per'),
    peerPbr:            real('peer_pbr'),
    peerFcfYield:       real('peer_fcf_yield'),
    peerRoe:            real('peer_roe'),
    peerRevenueGrowth:  real('peer_revenue_growth'),
    peerEvEbitda:       real('peer_ev_ebitda'),
    basisId:            text('basis_id').notNull(),
    forecastSnapshotId: text('forecast_snapshot_id'),
    calculatedAt:       integer('calculated_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.ticker, t.valuationDate] }),
    dateTickerIdx: index('valuation_daily_serving_date_ticker_idx').on(t.valuationDate, t.ticker),
  }),
)

export const valuationServingCheckpoints = sqliteTable(
  'valuation_serving_checkpoints',
  {
    ticker:              text('ticker').primaryKey(),
    status:              text('status').notNull(),
    historyStartDate:    text('history_start_date'),
    latestValuationDate: text('latest_valuation_date'),
    latestPriceDate:     text('latest_price_date'),
    sourceImportedAt:    integer('source_imported_at').notNull().default(0),
    sourceRowCount:      integer('source_row_count').notNull().default(0),
    definitionSignature:text('definition_signature').notNull(),
    persistedRows:       integer('persisted_rows').notNull().default(0),
    errorMessage:        text('error_message'),
    calculatedAt:        integer('calculated_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
    updatedAt:           integer('updated_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
  },
  (t) => ({
    statusIdx: index('valuation_serving_checkpoints_status_idx').on(t.status, t.ticker),
  }),
)

// Integrated JP screener serving layer. The latest date is materialized during
// daily updates; historical as-of dates are materialized once on demand.
export const stockScreeningServing = sqliteTable(
  'stock_screening_serving',
  {
    ticker: text('ticker').notNull(),
    asOf: text('as_of').notNull(),
    snapshotDate: text('snapshot_date').notNull(),
    valuationDate: text('valuation_date'),
    name: text('name').notNull(),
    marketSegment: text('market_segment'),
    sector17: text('sector17'),
    sector33: text('sector33'),
    majorCategory: text('major_category'),
    subIndustry: text('sub_industry'),
    price: real('price'),
    marketCap: real('market_cap'),
    revenue: real('revenue'),
    revenueGrowth: real('revenue_growth'),
    epsGrowth: real('eps_growth'),
    revenueCagr3y: real('revenue_cagr_3y'),
    revenueCagr5y: real('revenue_cagr_5y'),
    operatingMargin: real('operating_margin'),
    roe: real('roe'),
    roa: real('roa'),
    equityRatio: real('equity_ratio'),
    standardFcf: real('standard_fcf'),
    fcfYield: real('fcf_yield'),
    netDebt: real('net_debt'),
    roic: real('roic'),
    per: real('per'),
    forwardPer: real('forward_per'),
    pbr: real('pbr'),
    psr: real('psr'),
    evEbitda: real('ev_ebitda'),
    perPercentile5y: real('per_percentile_5y'),
    pbrPercentile5y: real('pbr_percentile_5y'),
    sectorValuationPercentile: real('sector_valuation_percentile'),
    forecastDividendYield: real('forecast_dividend_yield'),
    payoutRatio: real('payout_ratio'),
    forecastDps: real('forecast_dps'),
    dpsYoy: real('dps_yoy'),
    consecutiveIncreaseYears: integer('consecutive_increase_years'),
    consecutiveNonDecreaseYears: integer('consecutive_non_decrease_years'),
    dpsCagr3y: real('dps_cagr_3y'),
    dpsCagr5y: real('dps_cagr_5y'),
    forecastRevenueGrowth: real('forecast_revenue_growth'),
    forecastOperatingProfitGrowth: real('forecast_operating_profit_growth'),
    forecastEpsGrowth: real('forecast_eps_growth'),
    latestForecastRevisionRate: real('latest_forecast_revision_rate'),
    latestForecastRevisionDirection: text('latest_forecast_revision_direction'),
    hasCurrentForecast: integer('has_current_forecast', { mode: 'boolean' }),
    hasNextForecast: integer('has_next_forecast', { mode: 'boolean' }),
    dailyAStage: integer('daily_a_stage'),
    dailyBStage: integer('daily_b_stage'),
    weeklyAStage: integer('weekly_a_stage'),
    weeklyBStage: integer('weekly_b_stage'),
    monthlyAStage: integer('monthly_a_stage'),
    monthlyBStage: integer('monthly_b_stage'),
    stageCode: text('stage_code'),
    sectorStructureScore: real('sector_structure_score'),
    sectorRank: integer('sector_rank'),
    pms: real('pms'),
    pfs: real('pfs'),
    maStructure: text('ma_structure'),
    shortTermCheck: text('short_term_check'),
    shortTermScore: real('short_term_score'),
    creditRatio: real('credit_ratio'),
    longMargin: real('long_margin'),
    shortMargin: real('short_margin'),
    longMarginChange: real('long_margin_change'),
    shortMarginChange: real('short_margin_change'),
    sourceVersion: text('source_version').notNull(),
    calculatedAt: integer('calculated_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.ticker, t.asOf] }),
    asOfTickerIdx: index('stock_screening_serving_asof_ticker_idx').on(t.asOf, t.ticker),
    sortGrowthIdx: index('stock_screening_serving_growth_idx').on(t.asOf, t.revenueGrowth, t.ticker),
    sortRoeIdx: index('stock_screening_serving_roe_idx').on(t.asOf, t.roe, t.ticker),
    sortForwardPerIdx: index('stock_screening_serving_forward_per_idx').on(t.asOf, t.forwardPer, t.ticker),
    sortDividendIdx: index('stock_screening_serving_dividend_idx').on(t.asOf, t.forecastDividendYield, t.ticker),
    sortStructureIdx: index('stock_screening_serving_structure_idx').on(t.asOf, t.sectorStructureScore, t.pms, t.ticker),
  }),
)

export const stockScreeningServingDates = sqliteTable('stock_screening_serving_dates', {
  asOf: text('as_of').primaryKey(),
  snapshotDate: text('snapshot_date').notNull(),
  valuationDate: text('valuation_date'),
  rowCount: integer('row_count').notNull().default(0),
  sourceVersion: text('source_version').notNull(),
  status: text('status').notNull(),
  errorMessage: text('error_message'),
  calculatedAt: integer('calculated_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
})

export const savedScreeningDefinitions = sqliteTable(
  'saved_screening_definitions',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    definitionVersion: integer('definition_version').notNull().default(1),
    stateJson: text('state_json').notNull(),
    conditionsJson: text('conditions_json').notNull(),
    conditionSignature: text('condition_signature').notNull(),
    active: integer('active', { mode: 'boolean' }).notNull().default(true),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
    updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
  },
  (t) => ({
    activeIdx: index('saved_screening_definitions_active_idx').on(t.active, t.updatedAt),
  }),
)

export const savedScreeningEvaluations = sqliteTable(
  'saved_screening_evaluations',
  {
    evaluationId: text('evaluation_id').primaryKey(),
    definitionId: text('definition_id').notNull(),
    definitionVersion: integer('definition_version').notNull(),
    evaluatedAt: integer('evaluated_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
    asOf: text('as_of').notNull(),
    snapshotDate: text('snapshot_date').notNull(),
    previousEvaluationId: text('previous_evaluation_id'),
    previousAsOf: text('previous_as_of'),
    conditionsJson: text('conditions_json').notNull(),
    matchedCount: integer('matched_count').notNull().default(0),
    newCount: integer('new_count').notNull().default(0),
    stayCount: integer('stay_count').notNull().default(0),
    outCount: integer('out_count').notNull().default(0),
    elapsedMs: integer('elapsed_ms').notNull().default(0),
    status: text('status').notNull(),
    errorMessage: text('error_message'),
  },
  (t) => ({
    definitionDateIdx: index('saved_screening_evaluations_definition_date_idx')
      .on(t.definitionId, t.definitionVersion, t.asOf),
  }),
)

export const savedScreeningEvaluationMembers = sqliteTable(
  'saved_screening_evaluation_members',
  {
    evaluationId: text('evaluation_id').notNull(),
    ticker: text('ticker').notNull(),
    name: text('name').notNull(),
    status: text('status').notNull(),
    previousValuesJson: text('previous_values_json'),
    currentValuesJson: text('current_values_json'),
    changesJson: text('changes_json'),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.evaluationId, t.ticker] }),
    statusIdx: index('saved_screening_evaluation_members_status_idx')
      .on(t.evaluationId, t.status, t.ticker),
  }),
)

export const financialFoundationBackfillCheckpoints = sqliteTable(
  'financial_foundation_backfill_checkpoints',
  {
    checkpointType: text('checkpoint_type').notNull(),
    checkpointKey:  text('checkpoint_key').notNull(),
    status:         text('status').notNull(),
    sourceRows:     integer('source_rows').notNull().default(0),
    persistedRows:  integer('persisted_rows').notNull().default(0),
    detailsJson:    text('details_json').notNull().default('{}'),
    errorMessage:   text('error_message'),
    startedAt:      integer('started_at', { mode: 'timestamp' }),
    finishedAt:     integer('finished_at', { mode: 'timestamp' }),
    updatedAt:      integer('updated_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.checkpointType, t.checkpointKey] }),
    statusIdx: index('financial_foundation_backfill_status_idx')
      .on(t.checkpointType, t.status, t.checkpointKey),
  }),
)

export const dailyMarginAlerts = sqliteTable(
  'daily_margin_alerts',
  {
    ticker:                text('ticker').notNull(),
    publicationDate:       text('publication_date').notNull(),
    applicationDate:       text('application_date').notNull(),
    publicationReasonJson: text('publication_reason_json'),
    shortOutstanding:      real('short_outstanding'),
    shortChange:           real('short_change'),
    shortRatio:            real('short_ratio'),
    longOutstanding:       real('long_outstanding'),
    longChange:            real('long_change'),
    longRatio:             real('long_ratio'),
    shortLongRatio:        real('short_long_ratio'),
    shortNegotiable:       real('short_negotiable'),
    shortStandardized:     real('short_standardized'),
    longNegotiable:        real('long_negotiable'),
    longStandardized:      real('long_standardized'),
    regulationClass:       text('regulation_class'),
    source:                 text('source').notNull().default('jquants'),
    importedAt:             integer('imported_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.ticker, t.publicationDate, t.applicationDate] }),
    tickerDateIdx: index('daily_margin_alert_ticker_date_idx').on(t.ticker, t.applicationDate, t.publicationDate),
  }),
)

export const edinetDocuments = sqliteTable(
  'edinet_documents',
  {
    documentId:  text('document_id').primaryKey(),
    ticker:      text('ticker'),
    documentType:text('document_type').notNull(),
    submittedAt: text('submitted_at'),
    periodEnd:   text('period_end'),
    filerName:   text('filer_name'),
    status:      text('status').notNull().default('pending'),
    errorMessage:text('error_message'),
    processedAt: integer('processed_at', { mode: 'timestamp' }),
    importedAt:  integer('imported_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
  },
  (t) => ({
    tickerTypeIdx: index('edinet_documents_ticker_type_idx').on(t.ticker, t.documentType, t.submittedAt),
  }),
)

export const edinetCompanySnapshots = sqliteTable(
  'edinet_company_snapshots',
  {
    documentId:             text('document_id').primaryKey(),
    ticker:                 text('ticker').notNull(),
    edinetCode:              text('edinet_code'),
    documentType:            text('document_type').notNull(),
    filerName:               text('filer_name'),
    publishedAt:             text('published_at').notNull(),
    periodStart:             text('period_start'),
    periodEnd:               text('period_end'),
    fiscalYear:              integer('fiscal_year'),
    accountingStandard:      text('accounting_standard').notNull().default('UNKNOWN'),
    correctionStatus:        text('correction_status').notNull().default('original'),
    consolidationScope:      text('consolidation_scope').notNull().default('mixed'),
    companyOverviewJson:     text('company_overview_json').notNull().default('{}'),
    employeeInformationJson:text('employee_information_json').notNull().default('{}'),
    officerInformationJson: text('officer_information_json').notNull().default('{}'),
    segmentInformationJson: text('segment_information_json').notNull().default('{}'),
    hasCompanyOverview:      integer('has_company_overview', { mode: 'boolean' }).notNull().default(false),
    employeeSnapshotCount:   integer('employee_snapshot_count').notNull().default(0),
    officerCount:            integer('officer_count').notNull().default(0),
    segmentCount:            integer('segment_count').notNull().default(0),
    geographicAreaCount:     integer('geographic_area_count').notNull().default(0),
    majorCustomerCount:      integer('major_customer_count').notNull().default(0),
    majorShareholderCount:   integer('major_shareholder_count').notNull().default(0),
    policyHoldingCount:      integer('policy_holding_count').notNull().default(0),
    xbrlFactCount:           integer('xbrl_fact_count').notNull().default(0),
    parserVersion:           text('parser_version').notNull(),
    source:                  text('source').notNull().default('edinet'),
    importedAt:              integer('imported_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
  },
  (t) => ({
    tickerPitIdx: index('edinet_company_snapshots_ticker_pit_idx')
      .on(t.ticker, t.publishedAt, t.periodEnd),
  }),
)

export const majorShareholders = sqliteTable(
  'major_shareholders',
  {
    ticker:       text('ticker').notNull(),
    documentId:   text('document_id').notNull(),
    rank:         integer('rank').notNull(),
    fiscalYearEnd:text('fiscal_year_end'),
    holderName:   text('holder_name').notNull(),
    shares:       real('shares'),
    holdingRatio: real('holding_ratio'),
    submittedAt:  text('submitted_at'),
    source:       text('source').notNull().default('edinet'),
    importedAt:   integer('imported_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.ticker, t.documentId, t.rank] }),
    tickerDateIdx: index('major_shareholders_ticker_date_idx').on(t.ticker, t.fiscalYearEnd, t.rank),
  }),
)

export const policyHoldings = sqliteTable(
  'policy_holdings',
  {
    ticker:             text('ticker').notNull(),
    documentId:         text('document_id').notNull(),
    rank:               integer('rank').notNull(),
    fiscalYearEnd:      text('fiscal_year_end'),
    issuerName:         text('issuer_name').notNull(),
    shares:             real('shares'),
    bookValue:          real('book_value'),
    purpose:            text('purpose'),
    quantitativeEffect: text('quantitative_effect'),
    holdingType:        text('holding_type'),
    submittedAt:        text('submitted_at'),
    source:             text('source').notNull().default('edinet'),
    importedAt:         integer('imported_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.ticker, t.documentId, t.rank] }),
    tickerDateIdx: index('policy_holdings_ticker_date_idx').on(t.ticker, t.fiscalYearEnd, t.bookValue),
  }),
)

export const largeHoldingReports = sqliteTable(
  'large_holding_reports',
  {
    ticker:              text('ticker').notNull(),
    documentId:          text('document_id').notNull(),
    submittedAt:         text('submitted_at'),
    reportDate:          text('report_date'),
    holderName:          text('holder_name'),
    shares:              real('shares'),
    holdingRatio:        real('holding_ratio'),
    previousHoldingRatio:real('previous_holding_ratio'),
    purpose:             text('purpose'),
    reportKind:          text('report_kind'),
    source:              text('source').notNull().default('edinet'),
    importedAt:          integer('imported_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.ticker, t.documentId] }),
    tickerDateIdx: index('large_holding_reports_ticker_date_idx').on(t.ticker, t.submittedAt),
  }),
)

export const stockExternalDataStatus = sqliteTable(
  'stock_external_data_status',
  {
    ticker:      text('ticker').notNull(),
    dataset:     text('dataset').notNull(),
    status:      text('status').notNull(),
    sourceDate:  text('source_date'),
    message:     text('message'),
    attemptedAt: integer('attempted_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.ticker, t.dataset] }),
  }),
)

// ─────────────────────────────────────
// 17. Phase 4: 空売り残高 (J-Quants /markets/short_selling_positions)
// ─────────────────────────────────────
export const shortSellingPositions = sqliteTable(
  'short_selling_positions',
  {
    ticker:        text('ticker').notNull(),
    date:          text('date').notNull(),
    shortRatio:    real('short_ratio'),    // 空売り比率 %
    reporter:      text('reporter'),       // 報告者
    importedAt:    integer('imported_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
  },
  (t) => ({
    pk:      primaryKey({ columns: [t.ticker, t.date, t.reporter] }),
    dateIdx: index('ssp_date_idx').on(t.date),
  }),
)

// ─────────────────────────────────────
// 18. Phase 4: 決算発表カレンダー (J-Quants /fins/announcement)
// ─────────────────────────────────────
export const earningsCalendar = sqliteTable(
  'earnings_calendar',
  {
    ticker:        text('ticker').notNull(),
    announceDate:  text('announce_date').notNull(),    // "YYYY-MM-DD"
    fiscalPeriod:  text('fiscal_period'),              // 例 "2026Q1"
    companyName:   text('company_name'),
    sectorName:    text('sector_name'),
    marketSegment: text('market_segment'),
    source:        text('source'),
    sourceUrl:     text('source_url'),
    scheduledTime: text('scheduled_time'),
    scheduledTimeKind: text('scheduled_time_kind'),
    scheduledTimeSource: text('scheduled_time_source'),
    scheduledTimeSourceUrl: text('scheduled_time_source_url'),
    predictedTime: text('predicted_time'),
    predictionConfidence: text('prediction_confidence'),
    predictionSampleCount: integer('prediction_sample_count'),
    predictionModeCount: integer('prediction_mode_count'),
    actualDisclosedDate: text('actual_disclosed_date'),
    actualDisclosedTime: text('actual_disclosed_time'),
    actualDisclosedAt: text('actual_disclosed_at'),
    actualSource: text('actual_source'),
    actualSourceUrl: text('actual_source_url'),
    timeBucket: text('time_bucket'),
    timeUpdatedAt: integer('time_updated_at', { mode: 'timestamp' }),
    importedAt:    integer('imported_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
  },
  (t) => ({
    pk:      primaryKey({ columns: [t.ticker, t.announceDate] }),
    dateIdx: index('earn_date_idx').on(t.announceDate),
    importDateIdx: index('earn_import_date_ticker_idx').on(
      t.importedAt,
      t.announceDate,
      t.ticker,
    ),
    timeBucketDateIdx: index('earn_time_bucket_date_idx').on(t.timeBucket, t.announceDate),
  }),
)

// ─────────────────────────────────────
// 13. Phase 3: パターン統計 (6桁ステージコード × horizon ごとに集計)
// ─────────────────────────────────────
export const patternStats = sqliteTable(
  'pattern_stats',
  {
    pattern_code: text('pattern_code').notNull(),    // "111116" 等 (日A日B週A週B月A月B)
    horizon_days: integer('horizon_days').notNull(), // 30 | 60 | 90 | 180
    count:        integer('count').notNull(),
    // 分位 (p05, p25, p50, p75, p95)
    p05: real('p05'),
    p25: real('p25'),
    p50: real('p50'),
    p75: real('p75'),
    p95: real('p95'),
    // カテゴリ別件数
    very_up_count:   integer('very_up_count').notNull().default(0),
    up_count:        integer('up_count').notNull().default(0),
    flat_count:      integer('flat_count').notNull().default(0),
    down_count:      integer('down_count').notNull().default(0),
    very_down_count: integer('very_down_count').notNull().default(0),
    computed_at:     integer('computed_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
  },
  (t) => ({
    pk:      primaryKey({ columns: [t.pattern_code, t.horizon_days] }),
    codeIdx: index('pstat_code_idx').on(t.pattern_code),
  }),
)

// ─────────────────────────────────────
// 19. Phase 5: Backtest / ML-RL readiness
// ─────────────────────────────────────
export const weeklyOhlcv = sqliteTable(
  'weekly_ohlcv',
  {
    ticker:        text('ticker').notNull(),
    date:          text('date').notNull(),
    weekStartDate: text('week_start_date').notNull(),
    weekEndDate:   text('week_end_date').notNull(),
    open:          real('open').notNull(),
    high:          real('high').notNull(),
    low:           real('low').notNull(),
    close:         real('close').notNull(),
    volume:        integer('volume').notNull(),
    ma5:           real('ma_5'),
    ma13:          real('ma_13'),
    ma25:          real('ma_25'),
    ma50:          real('ma_50'),
    ma100:         real('ma_100'),
    computedAt:    integer('computed_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
  },
  (t) => ({
    pk:      primaryKey({ columns: [t.ticker, t.date] }),
    dateIdx: index('weekly_ohlcv_date_idx').on(t.date),
  }),
)

export const technicalSignals = sqliteTable(
  'technical_signals',
  {
    ticker:          text('ticker').notNull(),
    date:            text('date').notNull(),
    timescale:       text('timescale').notNull(),
    maPeriod:        integer('ma_period').notNull().default(0),
    signalCode:      text('signal_code').notNull(),
    signalStrength:  text('signal_strength').notNull(),
    direction:       text('direction').notNull(),
    label:           text('label').notNull(),
    scoreComponent:  real('score_component'),
    valueJson:       text('value_json'),
    computedAt:      integer('computed_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
  },
  (t) => ({
    pk:      primaryKey({ columns: [t.ticker, t.date, t.timescale, t.maPeriod, t.signalCode] }),
    dateIdx: index('tech_signal_date_idx').on(t.date, t.signalCode),
    codeIdx: index('tech_signal_code_idx').on(t.signalCode, t.date),
    dateTickerIdx: index('tech_signal_date_ticker_idx').on(t.date, t.ticker),
    tickerCodeDateIdx: index('tech_signal_ticker_code_date_idx').on(t.ticker, t.signalCode, t.date),
  }),
)

export const forwardExtrema = sqliteTable(
  'forward_extrema',
  {
    ticker:        text('ticker').notNull(),
    date:          text('date').notNull(),
    horizonDays:   integer('horizon_days').notNull(),
    returnPct:     real('return_pct'),
    endDate:       text('end_date'),
    maxReturnPct:  real('max_return_pct'),
    maxReturnDate: text('max_return_date'),
    daysToMax:     integer('days_to_max'),
    minReturnPct:  real('min_return_pct'),
    minReturnDate: text('min_return_date'),
    daysToMin:     integer('days_to_min'),
    hit10:         integer('hit_10').notNull().default(0),
    hit20:         integer('hit_20').notNull().default(0),
    hit40:         integer('hit_40').notNull().default(0),
    daysTo10:      integer('days_to_10'),
    daysTo20:      integer('days_to_20'),
    daysTo40:      integer('days_to_40'),
    computedAt:    integer('computed_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
  },
  (t) => ({
    pk:          primaryKey({ columns: [t.ticker, t.date, t.horizonDays] }),
    dateIdx:     index('fext_date_horizon_idx').on(t.date, t.horizonDays),
    dateTickerIdx: index('fext_date_horizon_ticker_idx').on(t.date, t.horizonDays, t.ticker),
    dateHorizonMaxReturnIdx: index('fext_date_horizon_max_return_idx').on(t.date, t.horizonDays, t.maxReturnPct),
    horizonDateIdx: index('fext_horizon_date_idx').on(t.horizonDays, t.date),
    horizonIdx:  index('fext_horizon_max_idx').on(t.horizonDays, t.maxReturnPct),
  }),
)

export const modelFeatures = sqliteTable(
  'model_features',
  {
    ticker:         text('ticker').notNull(),
    date:           text('date').notNull(),
    patternCode:    text('pattern_code'),
    dailyAStage:    integer('daily_a_stage'),
    dailyBStage:    integer('daily_b_stage'),
    weeklyAStage:   integer('weekly_a_stage'),
    weeklyBStage:   integer('weekly_b_stage'),
    monthlyAStage:  integer('monthly_a_stage'),
    monthlyBStage:  integer('monthly_b_stage'),
    close:          real('close'),
    volume:         integer('volume'),
    volumeRatio20:  real('volume_ratio_20'),
    rangePct:       real('range_pct'),
    atr20Pct:       real('atr20_pct'),
    ma5PosPct:      real('ma5_pos_pct'),
    ma25PosPct:     real('ma25_pos_pct'),
    ma75PosPct:     real('ma75_pos_pct'),
    maSpreadPct:    real('ma_spread_pct'),
    relStrength20:  real('rel_strength_20'),
    signalCodes:    text('signal_codes'),
    featureJson:    text('feature_json'),
    computedAt:     integer('computed_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
  },
  (t) => ({
    pk:         primaryKey({ columns: [t.ticker, t.date] }),
    dateIdx:    index('model_features_date_idx').on(t.date),
    patternIdx: index('model_features_pattern_idx').on(t.patternCode, t.date),
    tickerDateIdx: index('model_features_ticker_date_idx').on(t.ticker, t.date),
  }),
)

export const modelLabels = sqliteTable(
  'model_labels',
  {
    ticker:       text('ticker').notNull(),
    date:         text('date').notNull(),
    horizonDays:  integer('horizon_days').notNull(),
    returnPct:    real('return_pct'),
    maxReturnPct: real('max_return_pct'),
    minReturnPct: real('min_return_pct'),
    daysToMax:    integer('days_to_max'),
    hit10:        integer('hit_10').notNull().default(0),
    hit20:        integer('hit_20').notNull().default(0),
    hit40:        integer('hit_40').notNull().default(0),
    rewardScore:  real('reward_score'),
    labelJson:    text('label_json'),
    computedAt:   integer('computed_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
  },
  (t) => ({
    pk:      primaryKey({ columns: [t.ticker, t.date, t.horizonDays] }),
    dateIdx: index('model_labels_date_idx').on(t.date, t.horizonDays),
  }),
)

export const signalStats = sqliteTable(
  'signal_stats',
  {
    signalCode:      text('signal_code').notNull(),
    patternCode:     text('pattern_code').notNull(),
    horizonDays:     integer('horizon_days').notNull(),
    count:           integer('count').notNull(),
    hit10Rate:       real('hit_10_rate'),
    hit20Rate:       real('hit_20_rate'),
    hit40Rate:       real('hit_40_rate'),
    maxReturnP25:    real('max_return_p25'),
    maxReturnP50:    real('max_return_p50'),
    maxReturnP75:    real('max_return_p75'),
    returnP50:       real('return_p50'),
    minReturnP50:    real('min_return_p50'),
    daysToMaxP50:    real('days_to_max_p50'),
    computedAt:      integer('computed_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
  },
  (t) => ({
    pk:      primaryKey({ columns: [t.signalCode, t.patternCode, t.horizonDays] }),
    codeIdx: index('signal_stats_code_idx').on(t.signalCode, t.horizonDays, t.count),
  }),
)

export const signalReturnStats = sqliteTable(
  'signal_return_stats',
  {
    signalCode:      text('signal_code').notNull(),
    horizonDays:     integer('horizon_days').notNull(),
    count:           integer('count').notNull(),
    upRate:          real('up_rate'),
    downRate:        real('down_rate'),
    medianReturnPct: real('median_return_pct'),
    avgReturnPct:    real('avg_return_pct'),
    computedAt:      integer('computed_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
  },
  (t) => ({
    pk:      primaryKey({ columns: [t.signalCode, t.horizonDays] }),
    codeIdx: index('signal_return_stats_code_idx').on(t.signalCode, t.horizonDays, t.count),
  }),
)

export const servingLatestSignals = sqliteTable(
  'serving_latest_signals',
  {
    date:        text('date').notNull(),
    ticker:      text('ticker').notNull(),
    rank:        integer('rank').notNull(),
    score:       real('score').notNull(),
    signalCodes: text('signal_codes').notNull(),
    summaryJson: text('summary_json').notNull(),
    computedAt:  integer('computed_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
  },
  (t) => ({
    pk:      primaryKey({ columns: [t.date, t.ticker] }),
    rankIdx: index('serving_latest_rank_idx').on(t.date, t.rank),
  }),
)

export const servingSignalStats = sqliteTable(
  'serving_signal_stats',
  {
    signalCode:  text('signal_code').notNull(),
    patternCode: text('pattern_code').notNull(),
    horizonDays: integer('horizon_days').notNull(),
    payloadJson: text('payload_json').notNull(),
    computedAt:  integer('computed_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.signalCode, t.patternCode, t.horizonDays] }),
  }),
)

export const servingBacktestDates = sqliteTable('serving_backtest_dates', {
  date:          text('date').primaryKey(),
  totalTickers:  integer('total_tickers').notNull(),
  signalTickers: integer('signal_tickers').notNull(),
  computedAt:    integer('computed_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
})

export const servingBacktestSummaries = sqliteTable(
  'serving_backtest_summaries',
  {
    date:        text('date').notNull(),
    horizonDays: integer('horizon_days').notNull(),
    conditionKey: text('condition_key').notNull(),
    payloadJson:  text('payload_json').notNull(),
    computedAt:   integer('computed_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
  },
  (t) => ({
    pk:      primaryKey({ columns: [t.date, t.horizonDays, t.conditionKey] }),
    dateIdx: index('serving_summary_date_idx').on(t.date, t.horizonDays),
  }),
)

export const servingSimilarCases = sqliteTable(
  'serving_similar_cases',
  {
    sourceTicker:    text('source_ticker').notNull(),
    sourceDate:      text('source_date').notNull(),
    rank:            integer('rank').notNull(),
    similarTicker:   text('similar_ticker').notNull(),
    similarDate:     text('similar_date').notNull(),
    similarityScore: real('similarity_score').notNull(),
    payloadJson:     text('payload_json').notNull(),
    computedAt:      integer('computed_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.sourceTicker, t.sourceDate, t.rank] }),
  }),
)

export const servingBacktestResults = sqliteTable(
  'serving_backtest_results',
  {
    date:          text('date').notNull(),
    horizonDays:   integer('horizon_days').notNull(),
    ticker:        text('ticker').notNull(),
    name:          text('name'),
    sectorLarge:   text('sector_large'),
    sectorSmall:   text('sector_small'),
    marketSegment: text('market_segment'),
    patternCode:   text('pattern_code'),
    dailyAStage:   integer('daily_a_stage'),
    dailyBStage:   integer('daily_b_stage'),
    weeklyAStage:  integer('weekly_a_stage'),
    weeklyBStage:  integer('weekly_b_stage'),
    monthlyAStage: integer('monthly_a_stage'),
    monthlyBStage: integer('monthly_b_stage'),
    open:          real('open'),
    high:          real('high'),
    low:           real('low'),
    close:         real('close'),
    volume:        integer('volume'),
    volumeRatio20: real('volume_ratio_20'),
    rangePct:      real('range_pct'),
    atr20Pct:      real('atr20_pct'),
    ma5PosPct:     real('ma5_pos_pct'),
    ma25PosPct:    real('ma25_pos_pct'),
    ma75PosPct:    real('ma75_pos_pct'),
    signalCodes:   text('signal_codes'),
    returnPct:     real('return_pct'),
    maxReturnPct:  real('max_return_pct'),
    maxReturnDate: text('max_return_date'),
    daysToMax:     integer('days_to_max'),
    minReturnPct:  real('min_return_pct'),
    minReturnDate: text('min_return_date'),
    daysToMin:     integer('days_to_min'),
    hit10:         integer('hit_10'),
    hit20:         integer('hit_20'),
    hit40:         integer('hit_40'),
    computedAt:    integer('computed_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
  },
  (t) => ({
    pk:        primaryKey({ columns: [t.date, t.horizonDays, t.ticker] }),
    sortIdx:   index('serving_backtest_results_sort_idx').on(t.date, t.horizonDays, t.maxReturnPct),
    horizonDateIdx: index('serving_backtest_results_horizon_date_idx').on(t.horizonDays, t.date),
    tickerIdx: index('serving_backtest_results_ticker_idx').on(t.ticker, t.date),
  }),
)

export const servingBacktestDetails = sqliteTable(
  'serving_backtest_details',
  {
    date:        text('date').notNull(),
    horizonDays: integer('horizon_days').notNull(),
    ticker:      text('ticker').notNull(),
    detailJson:  text('detail_json').notNull(),
    computedAt:  integer('computed_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.date, t.horizonDays, t.ticker] }),
  }),
)

export const servingSignalEvidence = sqliteTable(
  'serving_signal_evidence',
  {
    ticker:     text('ticker').notNull(),
    date:       text('date').notNull(),
    signalCode: text('signal_code').notNull(),
    label:      text('label'),
    reasonJson: text('reason_json').notNull(),
    computedAt: integer('computed_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
  },
  (t) => ({
    pk:      primaryKey({ columns: [t.ticker, t.date, t.signalCode] }),
    dateIdx: index('serving_signal_evidence_date_idx').on(t.date, t.signalCode),
  }),
)

export const servingStockMetrics = sqliteTable('serving_stock_metrics', {
  ticker:      text('ticker').primaryKey(),
  asOfDate:    text('as_of_date').notNull(),
  payloadJson: text('payload_json').notNull(),
  computedAt:  integer('computed_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
})

export const servingStockMovePeriods = sqliteTable(
  'serving_stock_move_periods',
  {
    ticker:        text('ticker').notNull(),
    direction:     text('direction').notNull(),
    rank:          integer('rank').notNull(),
    startDate:     text('start_date').notNull(),
    endDate:       text('end_date').notNull(),
    returnPct:     real('return_pct').notNull(),
    tradingDays:   integer('trading_days').notNull(),
    stagePathJson: text('stage_path_json').notNull(),
    payloadJson:   text('payload_json').notNull(),
    computedAt:    integer('computed_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
  },
  (t) => ({
    pk:        primaryKey({ columns: [t.ticker, t.direction, t.rank] }),
    tickerIdx: index('serving_stock_move_ticker_idx').on(t.ticker, t.direction, t.rank),
  }),
)

export const mlFeatureVectors = sqliteTable(
  'ml_feature_vectors',
  {
    ticker:      text('ticker').notNull(),
    date:        text('date').notNull(),
    stageCode:   text('stage_code'),
    featureJson: text('feature_json').notNull(),
    vectorJson:  text('vector_json').notNull(),
    computedAt:  integer('computed_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
  },
  (t) => ({
    pk:      primaryKey({ columns: [t.ticker, t.date] }),
    dateIdx: index('ml_feature_vectors_date_idx').on(t.date),
  }),
)

export const mlFeatureVectorsV2 = sqliteTable(
  'ml_feature_vectors_v2',
  {
    ticker:      text('ticker').notNull(),
    date:        text('date').notNull(),
    featureSet:  text('feature_set').notNull(),
    version:     integer('version').notNull().default(1),
    stageCode:   text('stage_code'),
    featureJson: text('feature_json').notNull(),
    vectorJson:  text('vector_json').notNull(),
    computedAt:  integer('computed_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
  },
  (t) => ({
    pk:            primaryKey({ columns: [t.ticker, t.date, t.featureSet] }),
    dateIdx:       index('ml_feature_vectors_v2_date_idx').on(t.featureSet, t.date),
    dateOnlyIdx:   index('ml_feature_vectors_v2_date_only_idx').on(t.date),
    tickerDateIdx: index('ml_feature_vectors_v2_ticker_date_idx').on(t.ticker, t.date),
    featureTickerDateIdx: index('ml_feature_vectors_v2_feature_ticker_date_idx').on(t.featureSet, t.ticker, t.date),
  }),
)

export const mlTrainingLabels = sqliteTable(
  'ml_training_labels',
  {
    ticker:       text('ticker').notNull(),
    date:         text('date').notNull(),
    horizonDays:  integer('horizon_days').notNull(),
    returnPct:    real('return_pct'),
    maxReturnPct: real('max_return_pct'),
    minReturnPct: real('min_return_pct'),
    upLabel:      integer('up_label').notNull().default(0),
    downLabel:    integer('down_label').notNull().default(0),
    rewardScore:  real('reward_score'),
    labelJson:    text('label_json'),
    computedAt:   integer('computed_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
  },
  (t) => ({
    pk:      primaryKey({ columns: [t.ticker, t.date, t.horizonDays] }),
    dateIdx: index('ml_training_labels_date_idx').on(t.date, t.horizonDays),
  }),
)

export const mlShortLabels = sqliteTable(
  'ml_short_labels',
  {
    ticker:       text('ticker').notNull(),
    date:         text('date').notNull(),
    horizonDays:  integer('horizon_days').notNull(),
    returnPct:    real('return_pct'),
    maxReturnPct: real('max_return_pct'),
    minReturnPct: real('min_return_pct'),
    upLabel:      integer('up_label').notNull().default(0),
    downLabel:    integer('down_label').notNull().default(0),
    waitLabel:    integer('wait_label').notNull().default(0),
    rewardLong:   real('reward_long'),
    rewardShort:  real('reward_short'),
    rewardWait:   real('reward_wait'),
    labelJson:    text('label_json').notNull(),
    computedAt:   integer('computed_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
  },
  (t) => ({
    pk:         primaryKey({ columns: [t.ticker, t.date, t.horizonDays] }),
    dateIdx:    index('ml_short_labels_date_idx').on(t.date, t.horizonDays),
    horizonIdx: index('ml_short_labels_horizon_idx').on(t.horizonDays, t.date),
  }),
)

export const mlModels = sqliteTable('ml_models', {
  modelName:        text('model_name').primaryKey(),
  modelType:        text('model_type').notNull(),
  direction:        text('direction').notNull(),
  horizonDays:      integer('horizon_days').notNull(),
  featureNamesJson: text('feature_names_json').notNull(),
  weightsJson:      text('weights_json').notNull(),
  intercept:        real('intercept').notNull().default(0),
  metricsJson:      text('metrics_json').notNull(),
  trainedAt:        integer('trained_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
})

export const mlPredictionRuns = sqliteTable(
  'ml_prediction_runs',
  {
    runId:           text('run_id').primaryKey(),
    asOfDate:        text('as_of_date').notNull(),
    horizonDays:     integer('horizon_days').notNull(),
    direction:       text('direction').notNull(),
    modelName:       text('model_name'),
    modelType:       text('model_type').notNull().default('logistic_regression_v1'),
    predictionCount: integer('prediction_count').notNull().default(0),
    source:          text('source').notNull().default('batch'),
    status:          text('status').notNull().default('success'),
    createdAt:       integer('created_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
  },
  (t) => ({
    dateIdx: index('ml_prediction_runs_date_idx').on(t.asOfDate, t.horizonDays, t.direction),
  }),
)

export const mlPredictions = sqliteTable(
  'ml_predictions',
  {
    asOfDate:        text('as_of_date').notNull(),
    horizonDays:     integer('horizon_days').notNull(),
    direction:       text('direction').notNull(),
    ticker:          text('ticker').notNull(),
    runId:           text('run_id').notNull(),
    rank:            integer('rank').notNull(),
    score:           real('score').notNull(),
    modelName:       text('model_name'),
    featureJson:     text('feature_json').notNull(),
    reasonJson:      text('reason_json').notNull(),
    explanationJson: text('explanation_json').notNull(),
    createdAt:       integer('created_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
  },
  (t) => ({
    pk:        primaryKey({ columns: [t.asOfDate, t.horizonDays, t.direction, t.ticker] }),
    rankIdx:   index('ml_predictions_rank_idx').on(t.asOfDate, t.horizonDays, t.direction, t.rank),
    tickerIdx: index('ml_predictions_ticker_idx').on(t.ticker, t.asOfDate),
  }),
)

export const mlPredictionOutcomes = sqliteTable(
  'ml_prediction_outcomes',
  {
    asOfDate:      text('as_of_date').notNull(),
    horizonDays:   integer('horizon_days').notNull(),
    direction:     text('direction').notNull(),
    ticker:        text('ticker').notNull(),
    score:         real('score').notNull(),
    rank:          integer('rank').notNull(),
    returnPct:     real('return_pct'),
    maxReturnPct:  real('max_return_pct'),
    minReturnPct:  real('min_return_pct'),
    hitLabel:      integer('hit_label').notNull().default(0),
    missLabel:     integer('miss_label').notNull().default(0),
    outcomeJson:   text('outcome_json').notNull(),
    evaluatedAt:   integer('evaluated_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
  },
  (t) => ({
    pk:        primaryKey({ columns: [t.asOfDate, t.horizonDays, t.direction, t.ticker] }),
    dateIdx:   index('ml_prediction_outcomes_date_idx').on(t.asOfDate, t.horizonDays, t.direction),
    tickerIdx: index('ml_prediction_outcomes_ticker_idx').on(t.ticker, t.asOfDate),
  }),
)

export const mlModelEvaluations = sqliteTable(
  'ml_model_evaluations',
  {
    evaluationId:        text('evaluation_id').primaryKey(),
    modelName:           text('model_name'),
    modelType:           text('model_type').notNull(),
    direction:           text('direction').notNull(),
    horizonDays:         integer('horizon_days').notNull(),
    evaluationDate:      text('evaluation_date').notNull(),
    trainStartDate:      text('train_start_date'),
    trainEndDate:        text('train_end_date'),
    validationStartDate: text('validation_start_date'),
    validationEndDate:   text('validation_end_date'),
    sampleCount:         integer('sample_count').notNull().default(0),
    precisionAt20:       real('precision_at_20'),
    precisionAt50:       real('precision_at_50'),
    precisionAt80:       real('precision_at_80'),
    hitRate:             real('hit_rate'),
    medianReturnPct:     real('median_return_pct'),
    avgReturnPct:        real('avg_return_pct'),
    maxDrawdownPct:      real('max_drawdown_pct'),
    metricsJson:         text('metrics_json').notNull(),
    createdAt:           integer('created_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
  },
  (t) => ({
    latestIdx: index('ml_model_evaluations_latest_idx').on(t.evaluationDate, t.direction, t.horizonDays),
  }),
)

export const rlTrainingStates = sqliteTable(
  'rl_training_states',
  {
    ticker:        text('ticker').notNull(),
    date:          text('date').notNull(),
    horizonDays:   integer('horizon_days').notNull(),
    action:        text('action').notNull(),
    stateJson:     text('state_json').notNull(),
    reward:        real('reward'),
    nextStateJson: text('next_state_json'),
    computedAt:    integer('computed_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
  },
  (t) => ({
    pk:      primaryKey({ columns: [t.ticker, t.date, t.horizonDays, t.action] }),
    dateIdx: index('rl_training_states_date_idx').on(t.date, t.horizonDays),
  }),
)

export const rlTrainingStatesV2 = sqliteTable(
  'rl_training_states_v2',
  {
    ticker:        text('ticker').notNull(),
    date:          text('date').notNull(),
    horizonDays:   integer('horizon_days').notNull(),
    action:        text('action').notNull(),
    stateJson:     text('state_json').notNull(),
    reward:        real('reward'),
    nextStateJson: text('next_state_json'),
    computedAt:    integer('computed_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
  },
  (t) => ({
    pk:      primaryKey({ columns: [t.ticker, t.date, t.horizonDays, t.action] }),
    dateIdx: index('rl_training_states_v2_date_idx').on(t.date, t.horizonDays),
  }),
)

export const mlRlPolicyEvaluations = sqliteTable(
  'ml_rl_policy_evaluations',
  {
    evaluationId:        text('evaluation_id').primaryKey(),
    policyName:          text('policy_name').notNull(),
    policyType:          text('policy_type').notNull(),
    horizonDays:         integer('horizon_days').notNull(),
    evaluationDate:      text('evaluation_date').notNull(),
    startDate:           text('start_date'),
    endDate:             text('end_date'),
    sampleCount:         integer('sample_count').notNull().default(0),
    longCount:           integer('long_count').notNull().default(0),
    shortCount:          integer('short_count').notNull().default(0),
    waitCount:           integer('wait_count').notNull().default(0),
    winRate:             real('win_rate'),
    oracleMatchRate:     real('oracle_match_rate'),
    avgReward:           real('avg_reward'),
    medianReward:        real('median_reward'),
    avgReturnPct:        real('avg_return_pct'),
    maxDrawdownPct:      real('max_drawdown_pct'),
    actionBreakdownJson: text('action_breakdown_json').notNull(),
    metricsJson:         text('metrics_json').notNull(),
    createdAt:           integer('created_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
  },
  (t) => ({
    latestIdx: index('ml_rl_policy_evaluations_latest_idx').on(t.evaluationDate, t.horizonDays, t.policyName),
  }),
)

export const mlPhysicsStatusEvaluations = sqliteTable(
  'ml_physics_status_evaluations',
  {
    evaluationId:    text('evaluation_id').primaryKey(),
    evaluationDate:  text('evaluation_date').notNull(),
    featureSet:      text('feature_set').notNull(),
    statusLabel:     text('status_label').notNull(),
    targetDirection: text('target_direction').notNull(),
    horizonDays:     integer('horizon_days').notNull(),
    startDate:       text('start_date'),
    endDate:         text('end_date'),
    sampleCount:     integer('sample_count').notNull().default(0),
    hitCount:        integer('hit_count').notNull().default(0),
    adverseCount:    integer('adverse_count').notNull().default(0),
    hitRate:         real('hit_rate'),
    baseRate:        real('base_rate'),
    lift:            real('lift'),
    confidenceScore: real('confidence_score'),
    medianReturnPct: real('median_return_pct'),
    avgReturnPct:    real('avg_return_pct'),
    avgMaxReturnPct: real('avg_max_return_pct'),
    avgMinReturnPct: real('avg_min_return_pct'),
    adverseRate:     real('adverse_rate'),
    metricsJson:     text('metrics_json').notNull(),
    createdAt:       integer('created_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
  },
  (t) => ({
    latestIdx: index('ml_physics_status_evaluations_latest_idx').on(t.evaluationDate, t.horizonDays, t.statusLabel),
    statusIdx: index('ml_physics_status_evaluations_status_idx').on(t.statusLabel, t.horizonDays, t.evaluationDate),
  }),
)

export const servingMlCandidates = sqliteTable(
  'serving_ml_candidates',
  {
    asOfDate:        text('as_of_date').notNull(),
    direction:       text('direction').notNull(),
    rank:            integer('rank').notNull(),
    ticker:          text('ticker').notNull(),
    name:            text('name'),
    sectorLarge:     text('sector_large'),
    candidateScore:  real('candidate_score').notNull(),
    modelName:       text('model_name'),
    featureJson:     text('feature_json').notNull(),
    reasonJson:      text('reason_json').notNull(),
    explanationJson: text('explanation_json').notNull(),
    computedAt:      integer('computed_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
  },
  (t) => ({
    pk:      primaryKey({ columns: [t.asOfDate, t.direction, t.ticker] }),
    rankIdx: index('serving_ml_candidates_rank_idx').on(t.asOfDate, t.direction, t.rank),
  }),
)

export const servingMlPhysicsCandidates = sqliteTable(
  'serving_ml_physics_candidates',
  {
    asOfDate:        text('as_of_date').notNull(),
    direction:       text('direction').notNull(),
    horizonDays:     integer('horizon_days').notNull(),
    rank:            integer('rank').notNull(),
    ticker:          text('ticker').notNull(),
    name:            text('name'),
    sectorLarge:     text('sector_large'),
    candidateScore:  real('candidate_score').notNull(),
    modelName:       text('model_name'),
    featureJson:     text('feature_json').notNull(),
    reasonJson:      text('reason_json').notNull(),
    explanationJson: text('explanation_json').notNull(),
    computedAt:      integer('computed_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
  },
  (t) => ({
    pk:        primaryKey({ columns: [t.asOfDate, t.direction, t.horizonDays, t.ticker] }),
    rankIdx:   index('serving_ml_physics_candidates_rank_idx').on(t.asOfDate, t.horizonDays, t.direction, t.rank),
    tickerIdx: index('serving_ml_physics_candidates_ticker_idx').on(t.ticker, t.asOfDate),
  }),
)

export const servingCurrentSimilars = sqliteTable(
  'serving_current_similars',
  {
    asOfDate:         text('as_of_date').notNull(),
    baseTicker:       text('base_ticker').notNull(),
    rank:             integer('rank').notNull(),
    similarTicker:    text('similar_ticker').notNull(),
    similarityScore:  real('similarity_score').notNull(),
    baseDirection:    text('base_direction'),
    similarDirection: text('similar_direction'),
    payloadJson:      text('payload_json').notNull(),
    reasonJson:       text('reason_json').notNull(),
    computedAt:       integer('computed_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
  },
  (t) => ({
    pk:         primaryKey({ columns: [t.asOfDate, t.baseTicker, t.rank] }),
    baseIdx:    index('serving_current_similars_base_idx').on(t.asOfDate, t.baseTicker),
    scoreIdx:   index('serving_current_similars_score_idx').on(t.asOfDate, t.similarityScore),
    similarIdx: index('serving_current_similars_similar_idx').on(t.asOfDate, t.similarTicker),
  }),
)

export const servingMlSectorRankings = sqliteTable(
  'serving_ml_sector_rankings',
  {
    asOfDate:                  text('as_of_date').notNull(),
    sectorType:                text('sector_type').notNull(),
    sectorName:                text('sector_name').notNull(),
    direction:                 text('direction').notNull(),
    candidateCount:            integer('candidate_count').notNull().default(0),
    avgScore:                  real('avg_score'),
    representativeTickersJson: text('representative_tickers_json').notNull(),
    computedAt:                integer('computed_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
  },
  (t) => ({
    pk:      primaryKey({ columns: [t.asOfDate, t.sectorType, t.sectorName, t.direction] }),
    rankIdx: index('serving_ml_sector_rankings_rank_idx').on(t.asOfDate, t.sectorType, t.direction, t.candidateCount),
  }),
)

export const servingMlPerformance = sqliteTable(
  'serving_ml_performance',
  {
    asOfDate:        text('as_of_date').notNull(),
    direction:       text('direction').notNull(),
    horizonDays:     integer('horizon_days').notNull(),
    sectorType:      text('sector_type').notNull().default('all'),
    sectorName:      text('sector_name').notNull().default('ALL'),
    sampleCount:     integer('sample_count').notNull().default(0),
    upRate:          real('up_rate'),
    downRate:        real('down_rate'),
    medianReturnPct: real('median_return_pct'),
    avgReturnPct:    real('avg_return_pct'),
    payloadJson:     text('payload_json').notNull(),
    computedAt:      integer('computed_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
  },
  (t) => ({
    pk:      primaryKey({ columns: [t.asOfDate, t.direction, t.horizonDays, t.sectorType, t.sectorName] }),
    perfIdx: index('serving_ml_performance_rank_idx').on(t.asOfDate, t.direction, t.horizonDays, t.sampleCount),
  }),
)

export const mlMarketContextFeatures = sqliteTable('ml_market_context_features', {
  date:                 text('date').primaryKey(),
  marketReturn5:        real('market_return_5'),
  marketReturn20:       real('market_return_20'),
  marketAboveSma25Rate: real('market_above_sma25_rate'),
  marketAboveSma75Rate: real('market_above_sma75_rate'),
  advancersRate5:       real('advancers_rate_5'),
  sampleCount:          integer('sample_count').notNull().default(0),
  payloadJson:          text('payload_json').notNull(),
  computedAt:           integer('computed_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
})

export const mlSectorContextFeatures = sqliteTable(
  'ml_sector_context_features',
  {
    date:             text('date').notNull(),
    sectorType:       text('sector_type').notNull(),
    sectorName:       text('sector_name').notNull(),
    return5:          real('return_5'),
    return20:         real('return_20'),
    aboveSma25Rate:   real('above_sma25_rate'),
    rankPct:          real('rank_pct'),
    sampleCount:      integer('sample_count').notNull().default(0),
    payloadJson:      text('payload_json').notNull(),
    computedAt:       integer('computed_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
  },
  (t) => ({
    pk:      primaryKey({ columns: [t.date, t.sectorType, t.sectorName] }),
    rankIdx: index('ml_sector_context_features_rank_idx').on(t.date, t.sectorType, t.rankPct),
  }),
)

export const mlSimilarityEvaluations = sqliteTable(
  'ml_similarity_evaluations',
  {
    asOfDate:        text('as_of_date').notNull(),
    horizonDays:     integer('horizon_days').notNull(),
    source:          text('source').notNull(),
    baseCount:       integer('base_count').notNull().default(0),
    pairCount:       integer('pair_count').notNull().default(0),
    upRate:          real('up_rate'),
    downRate:        real('down_rate'),
    medianReturnPct: real('median_return_pct'),
    avgReturnPct:    real('avg_return_pct'),
    maxDrawdownPct:  real('max_drawdown_pct'),
    payloadJson:     text('payload_json').notNull(),
    computedAt:      integer('computed_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.asOfDate, t.horizonDays, t.source] }),
  }),
)

export const mlFeatureHealthChecks = sqliteTable(
  'ml_feature_health_checks',
  {
    checkDate:     text('check_date').notNull(),
    checkKey:      text('check_key').notNull(),
    status:        text('status').notNull(),
    expectedDate:  text('expected_date'),
    actualDate:    text('actual_date'),
    expectedCount: integer('expected_count'),
    actualCount:   integer('actual_count'),
    payloadJson:   text('payload_json').notNull(),
    computedAt:    integer('computed_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.checkDate, t.checkKey] }),
  }),
)

export const mlPipelineGenerations = sqliteTable(
  'ml_pipeline_generations',
  {
    market:               text('market').notNull(),
    pipeline:             text('pipeline').notNull(),
    generationVersion:    text('generation_version').notNull(),
    status:               text('status').notNull(),
    baselineSourceDate:   text('baseline_source_date').notNull(),
    baselineStartDate:    text('baseline_start_date'),
    lastDeltaSourceDate:  text('last_delta_source_date').notNull(),
    priceBasis:           text('price_basis'),
    featureSet:           text('feature_set').notNull(),
    baselineCompletedAt:  integer('baseline_completed_at', { mode: 'timestamp' }).notNull(),
    lastDeltaCompletedAt: integer('last_delta_completed_at', { mode: 'timestamp' }).notNull(),
    payloadJson:          text('payload_json').notNull().default('{}'),
    updatedAt:            integer('updated_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.market, t.pipeline] }),
  }),
)

export const tursoSyncRuns = sqliteTable('turso_sync_runs', {
  runId:        text('run_id').primaryKey(),
  mode:         text('mode').notNull(),
  status:       text('status').notNull(),
  dryRun:       integer('dry_run').notNull().default(0),
  startedAt:    integer('started_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
  finishedAt:   integer('finished_at', { mode: 'timestamp' }),
  summaryJson:  text('summary_json'),
  errorMessage: text('error_message'),
})

export const tursoSyncPartitions = sqliteTable(
  'turso_sync_partitions',
  {
    mode:         text('mode').notNull(),
    tableName:    text('table_name').notNull(),
    partitionKey: text('partition_key').notNull(),
    rangeStart:   text('range_start'),
    rangeEnd:     text('range_end'),
    rowCount:     integer('row_count').notNull().default(0),
    status:       text('status').notNull(),
    runId:        text('run_id'),
    syncedAt:     integer('synced_at', { mode: 'timestamp' }),
    errorMessage: text('error_message'),
  },
  (t) => ({
    pk:        primaryKey({ columns: [t.mode, t.tableName, t.partitionKey] }),
    statusIdx: index('turso_sync_partitions_status_idx').on(t.mode, t.status, t.tableName),
  }),
)

export const fxRatesDaily = sqliteTable(
  'fx_rates_daily',
  {
    pair:       text('pair').notNull(),
    date:       text('date').notNull(),
    rate:       real('rate').notNull(),
    source:     text('source').notNull().default('csv'),
    importedAt: integer('imported_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
  },
  (t) => ({
    pk:      primaryKey({ columns: [t.pair, t.date] }),
    dateIdx: index('fx_rates_daily_date_idx').on(t.date),
  }),
)

export const customCharts = sqliteTable(
  'custom_charts',
  {
    id:                  text('id').primaryKey(),
    name:                text('name').notNull(),
    formula:             text('formula').notNull(),
    formulaAstJson:      text('formula_ast_json').notNull(),
    mode:                text('mode').notNull().default('valuation'),
    baseDate:            text('base_date'),
    displayCurrency:     text('display_currency').notNull().default('LOCAL'),
    missingPolicy:       text('missing_policy').notNull().default('intersection'),
    indicatorConfigJson: text('indicator_config_json').notNull(),
    favorite:            integer('favorite', { mode: 'boolean' }).notNull().default(false),
    sortOrder:           integer('sort_order').notNull().default(0),
    createdAt:           integer('created_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
    updatedAt:           integer('updated_at', { mode: 'timestamp' }).notNull().default(sql`(unixepoch())`),
  },
  (t) => ({
    sortIdx: index('custom_charts_sort_idx').on(t.favorite, t.sortOrder, t.updatedAt),
  }),
)
