// components/hex/stage-screener/ma-flow.ts
// 既存 HexMap の MA 傾き判定ロジックを表示層向けに切り出したもの（しきい値・分類は従来どおり）。

export type FlowTone = 'up' | 'down' | 'flat'
export type Dir = 'up' | 'down' | 'flat' | 'none'

export interface SmaAngles {
  sma5: number | null
  sma25: number | null
  sma75: number | null
  sma300: number | null
}

export interface MaSource {
  sma_angles?: SmaAngles
  prev_sma_angles?: SmaAngles
}

export function angleFlow(angle: number | null | undefined, prev: number | null | undefined) {
  if (angle == null || !Number.isFinite(angle)) {
    return { label: '未計算', tone: 'flat' as FlowTone, dir: 'none' as Dir, pct: '-' }
  }
  const pct = `${angle > 0 ? '+' : ''}${angle.toFixed(2)}%`
  const direction = angle > 0.08 ? '上向き' : angle < -0.08 ? '下向き' : '横ばい'
  const dir: Dir = direction === '上向き' ? 'up' : direction === '下向き' ? 'down' : 'flat'
  const delta = prev == null || !Number.isFinite(prev) ? null : angle - prev
  if (delta == null || Math.abs(delta) < 0.04) {
    return {
      label: direction === '横ばい' ? '横ばい維持' : `${direction}維持`,
      tone: dir as FlowTone,
      dir,
      pct,
    }
  }
  if (delta > 0) {
    return {
      label: direction === '下向き' ? '下げ鈍化' : direction === '横ばい' ? '上向き化' : '上向き加速',
      tone: (direction === '下向き' ? 'flat' : 'up') as FlowTone,
      dir,
      pct,
    }
  }
  return {
    label: direction === '上向き' ? '上げ鈍化' : direction === '横ばい' ? '下向き化' : '下向き加速',
    tone: (direction === '上向き' ? 'flat' : 'down') as FlowTone,
    dir,
    pct,
  }
}

export function maAlignment(stock: MaSource) {
  const values = [stock.sma_angles?.sma5, stock.sma_angles?.sma25, stock.sma_angles?.sma75]
  const up = values.filter((v) => v != null && v > 0.08).length
  const down = values.filter((v) => v != null && v < -0.08).length
  if (up >= 3) return { label: '短中長の上向きが揃う', short: '上向き揃い', tone: 'up' as FlowTone }
  if (down >= 3) return { label: '短中長の下向きが揃う', short: '下向き揃い', tone: 'down' as FlowTone }
  if (up >= 2) return { label: '上向き優勢', short: '上向き優勢', tone: 'up' as FlowTone }
  if (down >= 2) return { label: '下向き優勢', short: '下向き優勢', tone: 'down' as FlowTone }
  return { label: '方向確認中', short: '方向確認中', tone: 'flat' as FlowTone }
}
