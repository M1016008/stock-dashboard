// lib/features.ts
//
// Phase 3: 特徴量計算の数学的プリミティブ群。すべて純関数で副作用なし。

// ─────────────────────────────────────
// 定数
// ─────────────────────────────────────

/**
 * フォワードリターンのカテゴリ閾値 (%)
 * 設計通り: ±5% / ±10%
 */
export const RETURN_CATEGORY_THRESHOLDS = {
  veryUp: 10,    // > +10%
  up: 5,         // > +5% かつ <= +10%
  flat: 5,       // -5% <= x <= +5%
  down: -5,      // < -5% かつ >= -10%
  // 残り (< -10%) は very_down
} as const

export type ReturnCategory = 'very_up' | 'up' | 'flat' | 'down' | 'very_down'

// ─────────────────────────────────────
// 二次回帰: slope (一次係数) と acceleration (二次係数)
// ─────────────────────────────────────

/**
 * MA(t) = a + b·t + c·t² にフィットして末尾点での値を返す。
 *
 * @param series MA 値の配列 (古→新の順、最低 window 個必要)
 * @param window 末尾から何点を回帰に使うか (daily=20, weekly=13, monthly=12)
 * @returns
 *   - slope: 末尾点での導関数を 現在 MA 値で正規化した % rate (b + 2·c·(window-1)) / lastMa * 100
 *   - acceleration: 二次係数 c を 現在 MA 値で正規化したもの (2c / lastMa * 100)
 *   - null: データ不足
 */
export function quadraticTrend(
  series: number[],
  window: number,
): { slope: number; acceleration: number } | null {
  if (series.length < window) return null

  const tail = series.slice(-window)

  // 正規方程式で a, b, c を解く。X = [[1, t, t²]] for t=0..window-1
  // (XᵀX)·[a,b,c]ᵀ = Xᵀ·y
  // 数値安定性のため t を中央化はしない (window が小さく問題なし)
  let sumT = 0, sumT2 = 0, sumT3 = 0, sumT4 = 0
  let sumY = 0, sumTY = 0, sumT2Y = 0
  const n = window
  for (let i = 0; i < n; i++) {
    const t = i
    const y = tail[i]
    sumT  += t
    sumT2 += t * t
    sumT3 += t * t * t
    sumT4 += t * t * t * t
    sumY   += y
    sumTY  += t * y
    sumT2Y += t * t * y
  }

  // 3x3 行列 (左辺) と 3x1 ベクトル (右辺) を Gauss-Jordan で解く
  // [ n      sumT    sumT2 ] [a]   [sumY  ]
  // [ sumT   sumT2   sumT3 ] [b] = [sumTY ]
  // [ sumT2  sumT3   sumT4 ] [c]   [sumT2Y]
  const m = [
    [n,      sumT,   sumT2,   sumY],
    [sumT,   sumT2,  sumT3,   sumTY],
    [sumT2,  sumT3,  sumT4,   sumT2Y],
  ]

  // Gauss elimination
  for (let i = 0; i < 3; i++) {
    // 部分ピボッティング
    let maxRow = i
    let maxAbs = Math.abs(m[i][i])
    for (let r = i + 1; r < 3; r++) {
      if (Math.abs(m[r][i]) > maxAbs) {
        maxAbs = Math.abs(m[r][i])
        maxRow = r
      }
    }
    if (maxAbs < 1e-12) return null  // 特異行列
    if (maxRow !== i) [m[i], m[maxRow]] = [m[maxRow], m[i]]

    // 正規化
    const piv = m[i][i]
    for (let c = i; c < 4; c++) m[i][c] /= piv

    // 他行から消去
    for (let r = 0; r < 3; r++) {
      if (r === i) continue
      const f = m[r][i]
      for (let c = i; c < 4; c++) m[r][c] -= f * m[i][c]
    }
  }

  const _a = m[0][3]
  const b = m[1][3]
  const c = m[2][3]

  const lastMa = tail[tail.length - 1]
  if (lastMa === 0 || !Number.isFinite(lastMa)) return null

  // 末尾点 t = n-1 での導関数: dMA/dt = b + 2c·(n-1)
  const derivative = b + 2 * c * (n - 1)
  // % rate に正規化
  const slope = (derivative / lastMa) * 100
  // 加速度も同様に正規化 (2c / lastMa * 100)
  const acceleration = (2 * c / lastMa) * 100

  if (!Number.isFinite(slope) || !Number.isFinite(acceleration)) return null
  return { slope, acceleration }
}

// ─────────────────────────────────────
// 拡散ダイナミクス
// ─────────────────────────────────────

/** MA 3本の拡散率 (max-min) / mean */
export function divergenceRate(ma1: number, ma2: number, ma3: number): number {
  const values = [ma1, ma2, ma3]
  const mean = (ma1 + ma2 + ma3) / 3
  if (mean === 0) return 0
  return (Math.max(...values) - Math.min(...values)) / mean
}

/**
 * MA 3本の fan uniformity (gap consistency)
 * 大小順に並べて隣接ギャップが均等なら 1、不均等なら 0 に近づく
 */
export function fanUniformity(ma1: number, ma2: number, ma3: number): number {
  const sorted = [ma1, ma2, ma3].sort((a, b) => a - b)
  const gap1 = sorted[1] - sorted[0]
  const gap2 = sorted[2] - sorted[1]
  if (gap1 + gap2 === 0) return 1
  return 1 - Math.abs(gap1 - gap2) / (gap1 + gap2)
}

/**
 * 値 x が、過去 history 配列の中で何分位にあるか (0〜1)
 * 例: history = [1,2,3,4,5], x=3 → 0.4 (x 未満が 2 個)
 */
export function historicalPercentile(x: number, history: number[]): number {
  if (history.length === 0) return 0.5
  let below = 0
  for (const h of history) {
    if (h < x) below++
  }
  return below / history.length
}

// ─────────────────────────────────────
// 角度同期 / その他
// ─────────────────────────────────────

/**
 * 角度同期性: 複数 slope が同方向か
 * 全て正 → +1、全て負 → -1、混在 → 0 に近づく
 */
export function angleSynchrony(slopes: (number | null | undefined)[]): number {
  const valid = slopes.filter((s): s is number => s != null && Number.isFinite(s))
  if (valid.length === 0) return 0
  const positives = valid.filter(s => s > 0).length
  const negatives = valid.filter(s => s < 0).length
  return (positives - negatives) / valid.length
}

/**
 * リターン値からカテゴリ分類
 *   > +10%  → 'very_up'
 *   > +5% かつ <= +10%  → 'up'
 *   -5% 〜 +5%  → 'flat'
 *   -10% <= x < -5%  → 'down'
 *   < -10%  → 'very_down'
 */
export function categorizeReturn(returnPct: number): ReturnCategory {
  if (returnPct > 10) return 'very_up'
  if (returnPct > 5) return 'up'
  if (returnPct >= -5) return 'flat'
  if (returnPct >= -10) return 'down'
  return 'very_down'
}

// ─────────────────────────────────────
// パーセンタイル
// ─────────────────────────────────────

/**
 * パーセンタイル計算 (線形補間あり)
 * @param values 数値配列 (ソート不要)
 * @param p パーセント値 (0〜100)
 */
export function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  if (sorted.length === 1) return sorted[0]
  const idx = (p / 100) * (sorted.length - 1)
  const lo = Math.floor(idx)
  const hi = Math.ceil(idx)
  if (lo === hi) return sorted[lo]
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo)
}

// ─────────────────────────────────────
// ステージ
// ─────────────────────────────────────

/**
 * 6桁パターンコード生成 (日A日B週A週B月A月B の順)
 * いずれかが null なら null を返す
 */
export function patternCode(stages: {
  daily_a: number | null
  daily_b: number | null
  weekly_a: number | null
  weekly_b: number | null
  monthly_a: number | null
  monthly_b: number | null
}): string | null {
  const arr = [
    stages.daily_a, stages.daily_b,
    stages.weekly_a, stages.weekly_b,
    stages.monthly_a, stages.monthly_b,
  ]
  if (arr.some(s => s == null)) return null
  return arr.join('')
}

/**
 * ステージ間の循環距離: ステージ 1〜6 を環状に並べて min(|s1-s2|, 6-|s1-s2|)
 * 例: stageDistance(1, 6) = 1, stageDistance(1, 4) = 3
 */
export function stageDistance(s1: number, s2: number): number {
  const d = Math.abs(s1 - s2)
  return Math.min(d, 6 - d)
}

// ─────────────────────────────────────
// コサイン類似度
// ─────────────────────────────────────

/**
 * 2 つのベクトルのコサイン類似度 (-1 〜 +1)
 * ベクトル長が違う場合は例外
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) throw new Error('vector length mismatch')
  let dot = 0, na = 0, nb = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    na  += a[i] * a[i]
    nb  += b[i] * b[i]
  }
  if (na === 0 || nb === 0) return 0
  return dot / (Math.sqrt(na) * Math.sqrt(nb))
}
