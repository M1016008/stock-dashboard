// lib/server/transitions.ts
//
// Phase 4: /ai/transitions ページが必要とするデータを返す Server Actions 群。
//
// "use server" 指定で Next.js の RSC アクションとして公開。ブラウザから直接呼べる。

'use server'

import { db, client } from '@/lib/db/client'
import {
  patternStats,
  dailySnapshots,
  stageTransitions,
} from '@/lib/db/schema'
import { eq, and, gte, desc, asc, sql } from 'drizzle-orm'

// ─────────────────────────────────────
// 型
// ─────────────────────────────────────

export type Horizon = 30 | 60 | 90 | 180

export interface PatternListRow {
  pattern_code: string
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
}

export interface PatternHorizonRow {
  pattern_code: string
  horizon_days: number
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
}

export interface SampleCase {
  ticker: string
  date: string
}

export interface TimelinePoint {
  ym: string
  count: number
}

// ─────────────────────────────────────
// API
// ─────────────────────────────────────

/**
 * パターン一覧取得 (指定 horizon、count 降順)
 */
export async function getPatternList(opts: {
  horizon: Horizon
  minCount?: number
}): Promise<PatternListRow[]> {
  const conditions = [eq(patternStats.horizon_days, opts.horizon)]
  if (opts.minCount && opts.minCount > 1) {
    conditions.push(gte(patternStats.count, opts.minCount))
  }
  const rows = await db
    .select()
    .from(patternStats)
    .where(and(...conditions))
    .orderBy(desc(patternStats.count))

  return rows.map(r => ({
    pattern_code: r.pattern_code,
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
  }))
}

/**
 * 単一パターンの全 horizon 統計取得
 */
export async function getPatternAllHorizons(code: string): Promise<PatternHorizonRow[]> {
  const rows = await db
    .select()
    .from(patternStats)
    .where(eq(patternStats.pattern_code, code))
    .orderBy(asc(patternStats.horizon_days))

  return rows.map(r => ({
    pattern_code: r.pattern_code,
    horizon_days: r.horizon_days,
    count: r.count,
    p05: r.p05,
    p25: r.p25,
    p50: r.p50,
    p75: r.p75,
    p95: r.p95,
    very_up_count:   r.very_up_count,
    up_count:        r.up_count,
    flat_count:      r.flat_count,
    down_count:      r.down_count,
    very_down_count: r.very_down_count,
  }))
}

/**
 * 指定パターンに該当する直近の銘柄一覧 (サンプル)
 */
export async function getSampleCases(code: string, limit: number = 30): Promise<SampleCase[]> {
  if (code.length !== 6) return []
  const stages = code.split('').map(Number)
  if (stages.some(s => isNaN(s) || s < 1 || s > 6)) return []
  const [dA, dB, wA, wB, mA, mB] = stages

  const rows = await db
    .select({
      ticker: dailySnapshots.ticker,
      date: dailySnapshots.date,
    })
    .from(dailySnapshots)
    .where(and(
      eq(dailySnapshots.daily_a_stage, dA),
      eq(dailySnapshots.daily_b_stage, dB),
      eq(dailySnapshots.weekly_a_stage, wA),
      eq(dailySnapshots.weekly_b_stage, wB),
      eq(dailySnapshots.monthly_a_stage, mA),
      eq(dailySnapshots.monthly_b_stage, mB),
    ))
    .orderBy(desc(dailySnapshots.date))
    .limit(limit)

  return rows.map(r => ({ ticker: r.ticker, date: r.date }))
}

/**
 * 指定パターンの時系列出現頻度 (年月ごとの件数)
 */
export async function getPatternTimeline(code: string): Promise<TimelinePoint[]> {
  if (code.length !== 6) return []
  const stages = code.split('').map(Number)
  if (stages.some(s => isNaN(s) || s < 1 || s > 6)) return []
  const [dA, dB, wA, wB, mA, mB] = stages

  const result = await client.execute({
    sql: `
      SELECT substr(date, 1, 7) AS ym, COUNT(*) AS count
      FROM daily_snapshots
      WHERE daily_a_stage = ?
        AND daily_b_stage = ?
        AND weekly_a_stage = ?
        AND weekly_b_stage = ?
        AND monthly_a_stage = ?
        AND monthly_b_stage = ?
      GROUP BY ym
      ORDER BY ym ASC
    `,
    args: [dA, dB, wA, wB, mA, mB],
  })

  return (result.rows as unknown as Array<{ ym: string; count: number }>).map(r => ({
    ym: r.ym,
    count: Number(r.count),
  }))
}

/**
 * 部分パターン (ワイルドカード対応) で検索
 * 例: "1?????" → daily_a=1 の全パターン (? を _ に変換して LIKE)
 */
export async function searchPatterns(opts: {
  partial: string
  horizon: Horizon
  minCount?: number
}): Promise<PatternListRow[]> {
  if (opts.partial.length !== 6) return []
  const likePattern = opts.partial.replace(/\?/g, '_')

  const conditions = [
    eq(patternStats.horizon_days, opts.horizon),
    sql`pattern_code LIKE ${likePattern}`,
  ]
  if (opts.minCount && opts.minCount > 1) {
    conditions.push(gte(patternStats.count, opts.minCount))
  }

  const rows = await db
    .select()
    .from(patternStats)
    .where(and(...conditions))
    .orderBy(desc(patternStats.count))

  return rows.map(r => ({
    pattern_code: r.pattern_code,
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
  }))
}

/**
 * ステージ遷移マトリクス取得 (全 6 軸の 6×6 マトリクスをまとめて返す)
 */
export async function getStageTransitionMatrices(): Promise<Record<string, number[][]>> {
  const rows = await db.select().from(stageTransitions)

  const AXES = ['daily_a', 'daily_b', 'weekly_a', 'weekly_b', 'monthly_a', 'monthly_b']
  const matrices: Record<string, number[][]> = {}
  for (const axis of AXES) {
    matrices[axis] = Array.from({ length: 6 }, () => Array(6).fill(0))
  }

  for (const r of rows) {
    if (r.from_stage >= 1 && r.from_stage <= 6 && r.to_stage >= 1 && r.to_stage <= 6) {
      matrices[r.axis][r.from_stage - 1][r.to_stage - 1] = r.count
    }
  }

  return matrices
}
