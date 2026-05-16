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
    per:                 real('per'),
    dividendYieldPct:    real('dividend_yield_pct'),
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
  }),
)

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

