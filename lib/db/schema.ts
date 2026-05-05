// lib/db/schema.ts
import { sqliteTable, text, integer, real } from 'drizzle-orm/sqlite-core'

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
// 2. スクリーナースナップショット履歴
// ─────────────────────────────────────
export const screenerSnapshots = sqliteTable('screener_snapshots', {
  id:             integer('id').primaryKey({ autoIncrement: true }),
  date:           text('date').notNull(),
  code:           text('code').notNull(),
  name:           text('name').notNull(),
  sector33:       text('sector33'),
  marketSegment:  text('market_segment'),
  close:          real('close').notNull(),
  volume:         integer('volume'),
  changePercent:  real('change_percent'),
  sma5:           real('sma5'),
  sma25:          real('sma25'),
  sma75:          real('sma75'),
  sma5w:          real('sma5w'),
  sma25w:         real('sma25w'),
  rsi14:          real('rsi14'),
  macd:           real('macd'),
  macdSignal:     real('macd_signal'),
  macdHistogram:  real('macd_histogram'),
  bbUpper:        real('bb_upper'),
  bbLower:        real('bb_lower'),
  isYearHigh:     integer('is_year_high', { mode: 'boolean' }),
  isYearLow:      integer('is_year_low', { mode: 'boolean' }),
  maOrderBullish: integer('ma_order_bullish', { mode: 'boolean' }),
  maOrderBearish: integer('ma_order_bearish', { mode: 'boolean' }),
  goldenCross:    integer('golden_cross', { mode: 'boolean' }),
  deadCross:      integer('dead_cross', { mode: 'boolean' }),
  createdAt:      text('created_at').notNull(),
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

