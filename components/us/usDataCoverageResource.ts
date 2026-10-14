'use client'

// /api/us/status を同一画面で 1 回だけ読むための小さな共有リソース。
// - 同じ画面 (scope + ticker) の strip が複数 mount しても fetch は 1 本 (in-flight と結果を共有)
// - 画面 (key) が変わったときだけ読み直す。日付や時計から鮮度を推測して再取得はしない
// - coverage / contracts は server の算出値をそのまま使う。client で再計算しない
// - 失敗は 'error' として保持し、N/A (仕様上非適用) とは区別する

import { useCallback, useEffect, useSyncExternalStore } from 'react'
import type { UsStatusSummary } from '@/lib/us-status'

export const US_STATUS_ENDPOINT = '/api/us/status'

export type UsDataCoverageState =
  | { status: 'loading' }
  | { status: 'ready'; data: UsStatusSummary }
  | { status: 'error' }

const LOADING: UsDataCoverageState = { status: 'loading' }

let currentKey: string | null = null
let snapshot: UsDataCoverageState = LOADING
let inflight: Promise<void> | null = null
const listeners = new Set<() => void>()

function emit(next: UsDataCoverageState) {
  snapshot = next
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

function getSnapshot() {
  return snapshot
}

function getServerSnapshot() {
  return LOADING
}

function isCoverageSummary(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false
  const v = value as Record<string, unknown>
  return typeof v.eligible === 'number'
    && typeof v.covered === 'number'
    && (v.percent === null || typeof v.percent === 'number')
    && (v.status === 'COMPLETE' || v.status === 'PARTIAL' || v.status === 'UNAVAILABLE')
}

// 形が契約と違うレスポンスは「確認できません」として扱う (推測で埋めない)。
export function isUsStatusSummary(value: unknown): value is UsStatusSummary {
  if (!value || typeof value !== 'object') return false
  const v = value as Partial<UsStatusSummary>
  return v.market === 'US'
    && isCoverageSummary(v.coverage?.ohlcv)
    && isCoverageSummary(v.coverage?.snapshots)
    && typeof v.contracts?.priceBasis === 'string'
    && typeof v.contracts?.priceFrequency === 'string'
    && typeof v.contracts?.classification?.effectiveDating === 'string'
    && typeof v.contracts?.fundamentals?.basis === 'string'
}

// テスト・診断用に現在の状態を読む。
export function getUsDataCoverageSnapshot(): UsDataCoverageState {
  return snapshot
}

export function loadUsDataCoverage(key: string, force = false): Promise<void> {
  return load(key, force)
}

function load(key: string, force: boolean): Promise<void> {
  if (!force && key === currentKey) {
    if (inflight) return inflight
    if (snapshot.status === 'ready') return Promise.resolve()
  }
  currentKey = key
  emit(LOADING)
  const request = fetch(US_STATUS_ENDPOINT, { cache: 'no-store', headers: { accept: 'application/json' } })
    .then(async (response) => {
      if (!response.ok) throw new Error(`status ${response.status}`)
      const body: unknown = await response.json()
      if (!isUsStatusSummary(body)) throw new Error('unexpected status payload')
      if (currentKey === key) emit({ status: 'ready', data: body })
    })
    .catch(() => {
      if (currentKey === key) emit({ status: 'error' })
    })
    .finally(() => {
      if (inflight === request) inflight = null
    })
  inflight = request
  return request
}

export function useUsDataCoverage(key: string): { state: UsDataCoverageState; retry: () => void } {
  const state = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot)
  useEffect(() => {
    void load(key, false)
  }, [key])
  const retry = useCallback(() => { void load(key, true) }, [key])
  return { state: currentKey === key ? state : LOADING, retry }
}
