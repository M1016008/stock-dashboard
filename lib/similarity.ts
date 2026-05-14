// lib/similarity.ts
//
// Phase 3: feature_snapshots ベースのコサイン類似度検索ライブラリ。
//
// 設計:
//   - インデックス事前構築なし、検索時に全候補を DB から読んでメモリで cosine 計算
//   - 50K〜500K 件規模ならミリ秒〜数秒で返せる
//   - timescale を指定して、その timescale の特徴量ベクトルだけで比較
//   - デフォルト k = 30

import { db, client } from './db/client'
import { featureSnapshots } from './db/schema'
import { eq, and } from 'drizzle-orm'
import { cosineSimilarity } from './features'

export type Timescale = 'daily' | 'weekly' | 'monthly'

export interface SimilarCase {
  ticker: string
  date: string
  similarity: number
}

export interface FindSimilarOptions {
  excludeSelfTicker?: boolean  // 同一銘柄を除外 (デフォルト false)
  maxDate?: string             // 検索対象の最大日付 (デフォルト query date より前)
}

/**
 * 指定 (ticker, date) のスナップショットに類似する過去ケースを返す。
 *
 * @param ticker      クエリ銘柄
 * @param date        クエリ日付 (YYYY-MM-DD)
 * @param timescale   比較する timescale
 * @param k           上位 k 件 (デフォルト 30)
 * @param options.excludeSelfTicker  同一銘柄を除外
 * @param options.maxDate            検索対象の最大日付 (含まない)
 */
/** 1 ページのサイズ (メモリと速度のバランス) */
const PAGE_SIZE = 50_000

export async function findSimilarSnapshots(
  ticker: string,
  date: string,
  timescale: Timescale,
  k: number = 30,
  options: FindSimilarOptions = {},
): Promise<SimilarCase[]> {
  // 1. クエリ点の特徴量取得
  const queryRows = await db
    .select()
    .from(featureSnapshots)
    .where(and(
      eq(featureSnapshots.ticker, ticker),
      eq(featureSnapshots.date, date),
      eq(featureSnapshots.timescale, timescale),
    ))
    .limit(1)

  if (queryRows.length === 0) return []
  const queryVec = featureRowToVector(queryRows[0])

  // 2. 候補をページ単位でストリーミング読み込み、top-k を維持
  //    全行をメモリに載せると 20M 行スケールで OOM するため、libsql の raw SQL で
  //    1 ページずつ読んで都度 cosine 計算 → top-k だけ保持。
  const cutoffDate = options.maxDate ?? date
  const excludeSelf = options.excludeSelfTicker ? 1 : 0

  const topK: SimilarCase[] = []  // 類似度降順、長さ k 以下
  let offset = 0

  while (true) {
    const sqlText = `
      SELECT *
      FROM feature_snapshots
      WHERE timescale = ?
        AND date < ?
        ${excludeSelf ? 'AND ticker <> ?' : ''}
      LIMIT ${PAGE_SIZE} OFFSET ${offset}
    `
    const args: (string | number)[] = excludeSelf
      ? [timescale, cutoffDate, ticker]
      : [timescale, cutoffDate]

    const page = await client.execute({ sql: sqlText, args })
    if (page.rows.length === 0) break

    for (const row of page.rows) {
      const r = row as unknown as typeof featureSnapshots.$inferSelect
      const sim = cosineSimilarity(queryVec, featureRowToVector(r))

      // top-k に挿入 (k 件未満は無条件追加、満杯なら最小値より大きい時のみ)
      if (topK.length < k) {
        topK.push({ ticker: r.ticker, date: r.date, similarity: sim })
        topK.sort((a, b) => b.similarity - a.similarity)
      } else if (sim > topK[topK.length - 1].similarity) {
        topK[topK.length - 1] = { ticker: r.ticker, date: r.date, similarity: sim }
        topK.sort((a, b) => b.similarity - a.similarity)
      }
    }

    if (page.rows.length < PAGE_SIZE) break  // 最終ページ
    offset += PAGE_SIZE
  }

  return topK
}

/**
 * 3 つの timescale すべてで類似する「立体的類似」ケース。
 * 各 timescale で top N を取り、(ticker, date) が 3 集合の交差にあるものを返す。
 * 最終ランキングは 3 timescale の類似度平均で降順。
 */
export async function findStereoscopicallySimilar(
  ticker: string,
  date: string,
  perTimescaleK: number = 100,
  finalK: number = 20,
  options: FindSimilarOptions = {},
): Promise<SimilarCase[]> {
  const [dailyTop, weeklyTop, monthlyTop] = await Promise.all([
    findSimilarSnapshots(ticker, date, 'daily',   perTimescaleK, options),
    findSimilarSnapshots(ticker, date, 'weekly',  perTimescaleK, options),
    findSimilarSnapshots(ticker, date, 'monthly', perTimescaleK, options),
  ])

  const keyOf = (c: SimilarCase) => `${c.ticker}|${c.date}`
  const dailyMap   = new Map(dailyTop.map(c => [keyOf(c), c.similarity]))
  const weeklyMap  = new Map(weeklyTop.map(c => [keyOf(c), c.similarity]))
  const monthlyMap = new Map(monthlyTop.map(c => [keyOf(c), c.similarity]))

  // 3 集合の積集合
  const intersection = monthlyTop.filter(c => {
    const k = keyOf(c)
    return dailyMap.has(k) && weeklyMap.has(k)
  })

  return intersection
    .map(c => {
      const k = keyOf(c)
      return {
        ticker: c.ticker,
        date: c.date,
        similarity: (dailyMap.get(k)! + weeklyMap.get(k)! + monthlyMap.get(k)!) / 3,
      }
    })
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, finalK)
}

// ─────────────────────────────────────
// feature_snapshots 1 行 → 数値ベクトルに変換
// ─────────────────────────────────────

type FeatureRow = typeof featureSnapshots.$inferSelect

function featureRowToVector(row: FeatureRow): number[] {
  const stageAOh = parseOneHot(row.stage_a_oh)
  const stageBOh = parseOneHot(row.stage_b_oh)

  return [
    // セクション A: 並び順 (12 次元)
    row.bin_order_a_12 ?? 0,
    row.bin_order_a_13 ?? 0,
    row.bin_order_a_23 ?? 0,
    row.bin_order_b_12 ?? 0,
    row.bin_order_b_13 ?? 0,
    row.bin_order_b_23 ?? 0,
    row.rel_dist_a_12 ?? 0,
    row.rel_dist_a_13 ?? 0,
    row.rel_dist_a_23 ?? 0,
    row.rel_dist_b_12 ?? 0,
    row.rel_dist_b_13 ?? 0,
    row.rel_dist_b_23 ?? 0,
    // セクション B: 拡散ダイナミクス (8 次元)
    row.divergence_a ?? 0,
    row.divergence_b ?? 0,
    row.divergence_a_delta ?? 0,
    row.divergence_b_delta ?? 0,
    row.fan_uniformity ?? 0,
    row.divergence_percentile ?? 0,
    row.stage_a_age ?? 0,
    row.stage_b_age ?? 0,
    // セクション C: トレンドダイナミクス (11 次元)
    row.slope_m1 ?? 0,
    row.accel_m1 ?? 0,
    row.slope_m2 ?? 0,
    row.accel_m2 ?? 0,
    row.slope_m3 ?? 0,
    row.accel_m3 ?? 0,
    row.slope_m4 ?? 0,
    row.accel_m4 ?? 0,
    row.slope_m5 ?? 0,
    row.accel_m5 ?? 0,
    row.angle_synchrony ?? 0,
    // セクション D: ステージ one-hot (12 次元)
    ...stageAOh,
    ...stageBOh,
  ]
}

function parseOneHot(s: string | null): number[] {
  if (!s) return [0, 0, 0, 0, 0, 0]
  try {
    const arr = JSON.parse(s)
    if (!Array.isArray(arr) || arr.length !== 6) return [0, 0, 0, 0, 0, 0]
    return arr.map(v => (typeof v === 'number' ? v : 0))
  } catch {
    return [0, 0, 0, 0, 0, 0]
  }
}
