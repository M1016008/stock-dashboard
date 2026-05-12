// lib/patterns.ts
//
// Phase 3: パターン参照ライブラリ。6 桁コード × horizon から統計を引く、
// MIN_COUNT_THRESHOLD を下回るバケットは段階的に広いパターンへフォールバック。
//
// 4 階層フォールバック:
//   Layer 1: exact         - 完全一致 (例 "123456")
//   Layer 2: one_wildcard  - 1 桁をワイルドカード化、6 種 OR (例 "_23456", "1_3456" ...)
//   Layer 3: monthly_fixed - 月足 (5,6 桁目) のみ固定、日週はワイルド (例 "____56")
//   Layer 4: global        - 全ワイルド ("______")

import { db, client } from './db/client'
import { patternStats } from './db/schema'
import { eq, and } from 'drizzle-orm'

export type FallbackLayer = 'exact' | 'one_wildcard' | 'monthly_fixed' | 'global'

export interface PatternStatsResult {
  pattern_code: string             // 引いたコード (フォールバック時はカンマ区切り or "wildcard")
  horizon_days: number
  count: number
  p05: number | null
  p25: number | null
  p50: number | null
  p75: number | null
  p95: number | null
  category_breakdown: {
    very_up: number
    up: number
    flat: number
    down: number
    very_down: number
  }
  fallback_layer: FallbackLayer
  matched_codes_count: number      // 集約に使ったコード数 (exact なら 1)
}

/** この件数を下回ったらフォールバック発動 (設計推奨値: 30) */
export const MIN_COUNT_THRESHOLD = 30

/**
 * 6 桁コード + horizon から統計を引く。階層フォールバックを自動適用。
 * 該当なしの場合のみ null を返す (Layer 4 でも 0 件は事実上ない)。
 */
export async function getPatternStats(
  code: string,
  horizon: number,
): Promise<PatternStatsResult | null> {
  // Layer 1: 完全一致
  const exact = await fetchExact(code, horizon)
  if (exact && exact.count >= MIN_COUNT_THRESHOLD) {
    return { ...exact, pattern_code: code, horizon_days: horizon, fallback_layer: 'exact', matched_codes_count: 1 }
  }

  // Layer 2: 1 桁ワイルドカード (6 種を OR で集約)
  const oneWild = await fetchAggregated(buildOneWildcardPatterns(code), horizon)
  if (oneWild && oneWild.count >= MIN_COUNT_THRESHOLD) {
    return { ...oneWild, pattern_code: `${code} ±1`, horizon_days: horizon, fallback_layer: 'one_wildcard' }
  }

  // Layer 3: 月足 (5,6 桁目) 固定、日週はワイルドカード
  const monthlyFixed = await fetchAggregated([`____${code.slice(4)}`], horizon)
  if (monthlyFixed && monthlyFixed.count >= MIN_COUNT_THRESHOLD) {
    return { ...monthlyFixed, pattern_code: `____${code.slice(4)}`, horizon_days: horizon, fallback_layer: 'monthly_fixed' }
  }

  // Layer 4: グローバル
  const global = await fetchAggregated(['______'], horizon)
  if (global) {
    return { ...global, pattern_code: '______', horizon_days: horizon, fallback_layer: 'global' }
  }

  return null
}

// ─────────────────────────────────────
// 内部ヘルパー
// ─────────────────────────────────────

interface AggregateOutput {
  count: number
  p05: number | null
  p25: number | null
  p50: number | null
  p75: number | null
  p95: number | null
  category_breakdown: {
    very_up: number
    up: number
    flat: number
    down: number
    very_down: number
  }
  matched_codes_count: number
}

async function fetchExact(code: string, horizon: number): Promise<AggregateOutput | null> {
  const rows = await db
    .select()
    .from(patternStats)
    .where(and(
      eq(patternStats.pattern_code, code),
      eq(patternStats.horizon_days, horizon),
    ))
    .limit(1)

  if (rows.length === 0) return null
  const r = rows[0]
  return {
    count: r.count,
    p05: r.p05,
    p25: r.p25,
    p50: r.p50,
    p75: r.p75,
    p95: r.p95,
    category_breakdown: {
      very_up:   r.very_up_count,
      up:        r.up_count,
      flat:      r.flat_count,
      down:      r.down_count,
      very_down: r.very_down_count,
    },
    matched_codes_count: 1,
  }
}

/**
 * 複数の LIKE パターン (SQLite では "_" = 1 文字ワイルド) で集約取得。
 *
 * 重要な近似: SQLite はパーセンタイル直接サポートなしのため、フォールバック層では
 * 各バケットの p05/25/50/75/95 を件数加重平均で再合成する。これは厳密には正しくないが、
 * 表示用の参考値として十分。厳密値が必要なら forward_returns から再集計する必要あり。
 */
async function fetchAggregated(patterns: string[], horizon: number): Promise<AggregateOutput | null> {
  // OR 条件で LIKE 群を展開
  const likeClauses = patterns.map(() => 'pattern_code LIKE ?').join(' OR ')
  const sql = `
    SELECT pattern_code, count, p05, p25, p50, p75, p95,
           very_up_count, up_count, flat_count, down_count, very_down_count
    FROM pattern_stats
    WHERE horizon_days = ? AND (${likeClauses})
  `
  const args = [horizon, ...patterns]
  const result = await client.execute({ sql, args })

  if (result.rows.length === 0) return null

  const rows = result.rows as unknown as Array<{
    pattern_code: string
    count: number
    p05: number | null
    p25: number | null
    p50: number | null
    p75: number | null
    p95: number | null
    very_up_count: number
    up_count: number
    flat_count: number
    down_count: number
    very_down_count: number
  }>

  const totalCount = rows.reduce((s, r) => s + r.count, 0)
  if (totalCount === 0) return null

  // 件数加重平均 (パーセンタイル近似)
  const weighted = (key: 'p05' | 'p25' | 'p50' | 'p75' | 'p95'): number | null => {
    let sum = 0
    let weight = 0
    for (const r of rows) {
      if (r[key] == null) continue
      sum    += r[key]! * r.count
      weight += r.count
    }
    return weight > 0 ? sum / weight : null
  }

  return {
    count: totalCount,
    p05: weighted('p05'),
    p25: weighted('p25'),
    p50: weighted('p50'),
    p75: weighted('p75'),
    p95: weighted('p95'),
    category_breakdown: {
      very_up:   rows.reduce((s, r) => s + r.very_up_count,   0),
      up:        rows.reduce((s, r) => s + r.up_count,        0),
      flat:      rows.reduce((s, r) => s + r.flat_count,      0),
      down:      rows.reduce((s, r) => s + r.down_count,      0),
      very_down: rows.reduce((s, r) => s + r.very_down_count, 0),
    },
    matched_codes_count: rows.length,
  }
}

/**
 * 6 桁のうち 1 桁を "_" に置き換えたパターン 6 種を返す
 * 例: "123456" → ["_23456", "1_3456", "12_456", "123_56", "1234_6", "12345_"]
 */
function buildOneWildcardPatterns(code: string): string[] {
  const patterns: string[] = []
  for (let i = 0; i < 6; i++) {
    patterns.push(code.slice(0, i) + '_' + code.slice(i + 1))
  }
  return patterns
}
