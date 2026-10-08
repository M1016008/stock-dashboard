// components/hex/stage-screener/filters.ts
// 結果コントロールの追加条件・並び替え。既存 payload の値だけを使う決定的な比較で、新しい計算や判定は作らない。

import type { HexMapStock } from '../HexMap'
import { maAlignment } from './ma-flow'

export type ChangeDir = '' | 'up' | 'down'
export type MaDir = '' | 'up' | 'down'
export type MlFilter = '' | 'any' | 'up' | 'down'
export type StatusFilter = '' | 'ready' | 'pending'

export interface ExtraFilters {
  segment: string
  margin: string
  change: ChangeDir
  ma: MaDir
  ml: MlFilter
  status: StatusFilter
}

export const EMPTY_EXTRA: ExtraFilters = { segment: '', margin: '', change: '', ma: '', ml: '', status: '' }

export type SortKey = 'cap' | 'price' | 'daily' | 'weekly' | 'monthly' | 'months3' | 'months6' | 'ytd' | 'code'
export type SortOrder = 'asc' | 'desc'

export const SORT_OPTIONS: { key: SortKey; label: string }[] = [
  { key: 'cap', label: '時価総額' },
  { key: 'daily', label: '日次騰落率' },
  { key: 'weekly', label: '週次騰落率' },
  { key: 'monthly', label: '月次騰落率' },
  { key: 'months3', label: '3ヶ月騰落率' },
  { key: 'months6', label: '6ヶ月騰落率' },
  { key: 'ytd', label: '年初来騰落率' },
  { key: 'price', label: '現在値' },
  { key: 'code', label: 'コード' },
]

export const DEFAULT_SORT: SortKey = 'cap'
export const DEFAULT_ORDER: SortOrder = 'desc'

export function parseSortKey(v: string | null): SortKey {
  return SORT_OPTIONS.some((o) => o.key === v) ? (v as SortKey) : DEFAULT_SORT
}
export function parseOrder(v: string | null): SortOrder {
  return v === 'asc' || v === 'desc' ? v : DEFAULT_ORDER
}
export function pick<T extends string>(v: string | null, allowed: readonly T[], fallback: T): T {
  return allowed.includes(v as T) ? (v as T) : fallback
}

export function matchesExtra(s: HexMapStock, f: ExtraFilters): boolean {
  if (f.segment && s.market_segment !== f.segment) return false
  if (f.margin && (s.margin_type ?? '') !== f.margin) return false
  if (f.change === 'up' && !((s.daily_change ?? 0) > 0)) return false
  if (f.change === 'down' && !((s.daily_change ?? 0) < 0)) return false
  if (f.ma && maAlignment(s).tone !== f.ma) return false
  if (f.ml === 'any' && !s.ml_candidate_direction) return false
  if (f.ml === 'up' && s.ml_candidate_direction !== 'up') return false
  if (f.ml === 'down' && s.ml_candidate_direction !== 'down') return false
  const pending = s.data_status != null && s.data_status !== 'ready'
  if (f.status === 'ready' && pending) return false
  if (f.status === 'pending' && !pending) return false
  return true
}

function sortValue(s: HexMapStock, key: SortKey): number | string | null {
  switch (key) {
    case 'cap': return s.market_cap > 0 ? s.market_cap : null
    case 'price': return s.price
    case 'daily': return s.daily_change ?? null
    case 'weekly': return s.weekly_change ?? null
    case 'monthly': return s.monthly_change ?? null
    case 'months3': return s.months3_change ?? null
    case 'months6': return s.months6_change ?? null
    case 'ytd': return s.ytd_change ?? null
    case 'code': return s.code
  }
}

/** 欠損値は昇順・降順どちらでも末尾。同値はコード順で安定させる。 */
export function compareStocks(a: HexMapStock, b: HexMapStock, key: SortKey, order: SortOrder): number {
  const av = sortValue(a, key)
  const bv = sortValue(b, key)
  const aMissing = av == null || (typeof av === 'number' && !Number.isFinite(av))
  const bMissing = bv == null || (typeof bv === 'number' && !Number.isFinite(bv))
  if (aMissing && bMissing) return a.code.localeCompare(b.code)
  if (aMissing) return 1
  if (bMissing) return -1
  let diff = 0
  if (typeof av === 'string' && typeof bv === 'string') diff = av.localeCompare(bv, 'en', { numeric: true })
  else diff = (av as number) - (bv as number)
  if (diff === 0) return a.code.localeCompare(b.code)
  return order === 'asc' ? diff : -diff
}
