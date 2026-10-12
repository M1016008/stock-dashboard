'use client'

import { useEffect, useRef, useState } from 'react'
import type { UsPhysicalMomentumResponse } from './technical-view'

export interface UsPhysicalMomentumState {
  status: 'idle' | 'loading' | 'ready' | 'error'
  data: UsPhysicalMomentumResponse | null
  error: string
}

/**
 * 概要タブとチャートタブが同じ physical-momentum 応答を読むため、親で1回だけ取得して共有する。
 * 銘柄・分析日ごとに1リクエスト。enabled になるまで(=どちらかのタブを開くまで)取得しない。
 */
export function useUsPhysicalMomentum(ticker: string | null, analysisDate: string | null, enabled: boolean): UsPhysicalMomentumState {
  const key = ticker ? `${ticker}|${analysisDate ?? ''}` : null
  const [state, setState] = useState<UsPhysicalMomentumState & { key: string | null }>({
    key: null,
    status: 'idle',
    data: null,
    error: '',
  })
  const requestedKey = useRef<string | null>(null)

  useEffect(() => {
    if (!enabled || !ticker || !key || requestedKey.current === key) return
    requestedKey.current = key
    setState({ key, status: 'loading', data: null, error: '' })
    const params = new URLSearchParams({ market: 'US', limit: '260' })
    if (analysisDate) params.set('date', analysisDate)
    fetch(`/api/physical-momentum/${encodeURIComponent(ticker)}?${params.toString()}`, { cache: 'no-store' })
      .then((res) => res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`)))
      .then((payload: UsPhysicalMomentumResponse) => {
        if (requestedKey.current === key) setState({ key, status: 'ready', data: payload, error: '' })
      })
      .catch((e) => {
        if (requestedKey.current === key) setState({ key, status: 'error', data: null, error: e instanceof Error ? e.message : String(e) })
      })
  }, [analysisDate, enabled, key, ticker])

  if (state.key !== key) return { status: enabled ? 'loading' : 'idle', data: null, error: '' }
  return state
}
