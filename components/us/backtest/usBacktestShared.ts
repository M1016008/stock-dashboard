// components/us/backtest/usBacktestShared.ts
//
// /us/analysis/backtest の Historical Outcome Explorer で共有する型・定数・純関数。
// - 型は lib/server/us-backtest.ts の戻り値から導出する (type-only import。サーバーコードはバンドルしない)
// - 数値はサーバー値を整形するだけで再計算しない。0 は実測ゼロ、null は未取得として区別する
// - 過去分類 (Sector/Industry/Exchange) は PIT を保証できないため扱わない

import type {
  getUsBacktestDates,
  getUsBacktestDetail,
  queryUsBacktest,
  UsBacktestHorizon,
  UsBacktestQuery,
  UsBacktestResult,
} from '@/lib/server/us-backtest'

export type { UsBacktestHorizon, UsBacktestResult }

export type UsBacktestDatesResponse = Awaited<ReturnType<typeof getUsBacktestDates>>
export type UsBacktestQueryResponse = Awaited<ReturnType<typeof queryUsBacktest>>
export type UsBacktestDetailResponse = NonNullable<Awaited<ReturnType<typeof getUsBacktestDetail>>>
export type UsBacktestMove = 'up' | 'down'
export type UsBacktestReturnMetric = NonNullable<UsBacktestQuery['returnMetric']>
export type UsBacktestSort = NonNullable<UsBacktestQuery['sort']>

export const US_BACKTEST_PAGE_SIZE = 100

export const FOCUS_RING = 'outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-brand-200)]'
export const FIELD_LABEL = 'text-[11px] font-medium text-[var(--color-text-secondary)]'
export const CONTROL = `h-8 w-full min-w-0 rounded-[4px] border border-[var(--color-border-default)] bg-white px-2 text-[12px] text-[var(--color-text-primary)] ${FOCUS_RING} focus-visible:border-[var(--color-brand-500)]`
export const UP_TEXT = 'text-[var(--color-price-up)]'
export const DOWN_TEXT = 'text-[var(--color-price-down)]'
export const MUTED_TEXT = 'text-[var(--color-text-tertiary)]'

/* ---------- フィルター ---------- */

export interface UsBacktestFilterState {
  search: string
  stageCode: string
  signal: string
  returnMetric: UsBacktestReturnMetric
  returnMin: string
  returnMax: string
  targetPct: '' | '10' | '20' | '40'
}

export const EMPTY_FILTERS: UsBacktestFilterState = {
  search: '',
  stageCode: '',
  signal: '',
  returnMetric: 'max',
  returnMin: '',
  returnMax: '',
  targetPct: '',
}

export const RETURN_METRIC_LABELS: Record<UsBacktestReturnMetric, string> = {
  max: '最大上昇',
  period: '期間騰落',
  min: '最大下落',
}

export const SORT_OPTIONS: ReadonlyArray<{ value: UsBacktestSort; label: string }> = [
  { value: 'maxReturn', label: '最大上昇 大きい順' },
  { value: 'minReturn', label: '最大下落 深い順' },
  { value: 'periodReturn', label: '期間騰落 高い順' },
  { value: 'volume', label: '出来高倍率 高い順' },
  { value: 'ticker', label: 'ティッカー順' },
]

const STAGE_CODE = /^[1-6]{6}$/

/** 空欄は null、数値でなければ undefined (入力エラー) */
export function parseOptionalNumber(raw: string): number | null | undefined {
  const value = raw.trim()
  if (value === '') return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

export interface UsBacktestFilterErrors {
  stageCode?: string
  returnMin?: string
  returnMax?: string
  range?: string
}

export function validateFilters(filters: UsBacktestFilterState): UsBacktestFilterErrors {
  const errors: UsBacktestFilterErrors = {}
  const stage = filters.stageCode.trim()
  if (stage && !STAGE_CODE.test(stage)) errors.stageCode = '1〜6の数字を6桁で入力してください'
  const min = parseOptionalNumber(filters.returnMin)
  const max = parseOptionalNumber(filters.returnMax)
  if (min === undefined) errors.returnMin = '数値で入力してください'
  if (max === undefined) errors.returnMax = '数値で入力してください'
  if (typeof min === 'number' && typeof max === 'number' && min > max) errors.range = '下限が上限を超えています'
  return errors
}

export function hasFilterErrors(errors: UsBacktestFilterErrors): boolean {
  return Object.values(errors).some(Boolean)
}

export function sameFilters(a: UsBacktestFilterState, b: UsBacktestFilterState): boolean {
  return (Object.keys(a) as Array<keyof UsBacktestFilterState>).every((key) => a[key].trim() === b[key].trim())
}

export function activeFilterCount(filters: UsBacktestFilterState): number {
  let count = 0
  if (filters.search.trim()) count += 1
  if (filters.stageCode.trim()) count += 1
  if (filters.signal.trim()) count += 1
  if (filters.returnMin.trim() || filters.returnMax.trim()) count += 1
  if (filters.targetPct) count += 1
  return count
}

export function buildQueryUrl(input: {
  date: string
  horizon: UsBacktestHorizon
  filters: UsBacktestFilterState
  sort: UsBacktestSort
  page: number
}): string {
  const { filters } = input
  const params = new URLSearchParams({
    date: input.date,
    horizon: String(input.horizon),
    sort: input.sort,
    page: String(input.page),
    pageSize: String(US_BACKTEST_PAGE_SIZE),
    returnMetric: filters.returnMetric,
  })
  if (filters.search.trim()) params.set('search', filters.search.trim())
  if (filters.stageCode.trim()) params.set('stageCode', filters.stageCode.trim())
  if (filters.signal.trim()) params.set('signal', filters.signal.trim())
  const min = parseOptionalNumber(filters.returnMin)
  const max = parseOptionalNumber(filters.returnMax)
  if (typeof min === 'number') params.set('returnMin', String(min))
  if (typeof max === 'number') params.set('returnMax', String(max))
  if (filters.targetPct) params.set('targetPct', filters.targetPct)
  return `/api/us/backtest/query?${params}`
}

/* ---------- 取得 ---------- */

const ERROR_MESSAGES: Record<string, string> = {
  invalid_horizon: '検証期間の指定が正しくありません。',
  invalid_date: '基準日の指定が正しくありません。',
  invalid_ticker: 'ティッカーの指定が正しくありません。',
  invalid_stage_code: '6桁Stageは1〜6の数字6桁で指定してください。',
  not_found: 'この条件の検証結果は見つかりませんでした。',
  us_backtest_dates_failed: '基準日の一覧を取得できませんでした。',
  us_backtest_query_failed: '検証結果を取得できませんでした。',
  us_backtest_detail_failed: '詳細データを取得できませんでした。',
}

export async function fetchJson<T>(url: string, signal: AbortSignal): Promise<T> {
  const response = await fetch(url, { cache: 'no-store', signal })
  let body: unknown = null
  try { body = await response.json() } catch { body = null }
  if (!response.ok) {
    const payload = body as { error?: string; message?: string } | null
    const known = payload?.error ? ERROR_MESSAGES[payload.error] : undefined
    throw new Error(payload?.message ?? known ?? `取得に失敗しました (HTTP ${response.status})`)
  }
  return body as T
}

export function isAbortError(error: unknown): boolean {
  return (error as { name?: string } | null)?.name === 'AbortError'
}

/* ---------- 表示 ---------- */

export const STAGE_AXIS_LABELS = ['日A', '日B', '週A', '週B', '月A', '月B'] as const

export function stageAriaLabel(stages: Array<number | null>): string {
  return `6ステージ ${stages.map((value, index) => `${STAGE_AXIS_LABELS[index]}${value ?? '未取得'}`).join(' ')}`
}

/** 0..1 の比率を %。null は呼び出し側で N/A を出す */
export function fmtRate(value: number | null): string | null {
  if (value == null || !Number.isFinite(value)) return null
  return `${(value * 100).toFixed(1)}%`
}

export function signedToneClass(value: number | null | undefined): string {
  if (value == null || value === 0) return 'text-[var(--color-text-primary)]'
  return value > 0 ? UP_TEXT : DOWN_TEXT
}

export function fmtCount(value: number): string {
  return value.toLocaleString('en-US')
}

export function fmtRatio(value: number | null): string | null {
  if (value == null || !Number.isFinite(value)) return null
  return `${value.toFixed(2)}x`
}

/** reason_json の値。丸めは表示桁の整理だけで、値は作らない */
export function fmtReasonValue(value: unknown): string {
  if (value == null) return '未取得'
  if (typeof value === 'number') return Number.isFinite(value) ? value.toLocaleString('en-US', { maximumFractionDigits: 4 }) : String(value)
  if (typeof value === 'string') return value
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  try { return JSON.stringify(value) } catch { return String(value) }
}
