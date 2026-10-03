'use client'

import { useEffect, useMemo, useState } from 'react'
import type { StockPreviewData, StockPreviewMarket } from '@/lib/stock-preview'

interface CacheEntry {
  data: StockPreviewData
  expiresAt: number
  usedAt: number
}

interface PreviewState {
  key: string
  data: StockPreviewData | null
  loading: boolean
  error: string | null
}

const previewCache = new Map<string, CacheEntry>()
const MAX_CACHE_ENTRIES = 80
const LATEST_TTL_MS = 60_000
const PIT_TTL_MS = 24 * 60 * 60 * 1000

function cacheKey(ticker: string, market: StockPreviewMarket, asOf: string | null, includeChart: boolean): string {
  return `${market}|${ticker}|${asOf ?? 'latest'}|${includeChart ? 'chart' : 'view'}`
}

function pruneCache(): void {
  if (previewCache.size <= MAX_CACHE_ENTRIES) return
  const entries = [...previewCache.entries()].sort((a, b) => a[1].usedAt - b[1].usedAt)
  for (const [key] of entries.slice(0, previewCache.size - MAX_CACHE_ENTRIES)) previewCache.delete(key)
}

export function clearStockPreviewCache(): void {
  previewCache.clear()
}

export function useStockPreviewData(input: {
  ticker: string
  market: StockPreviewMarket
  asOf?: string | null
  includeChart?: boolean
  enabled: boolean
}) {
  const asOf = input.asOf || null
  const key = useMemo(
    () => cacheKey(input.ticker, input.market, asOf, Boolean(input.includeChart)),
    [asOf, input.includeChart, input.market, input.ticker],
  )
  const [state, setState] = useState<PreviewState>(() => {
    const cached = previewCache.get(key)
    return {
      key,
      data: cached && cached.expiresAt > Date.now() ? cached.data : null,
      loading: false,
      error: null,
    }
  })

  useEffect(() => {
    if (!input.enabled) return
    const hit = previewCache.get(key)
    if (hit && hit.expiresAt > Date.now()) {
      hit.usedAt = Date.now()
      setState({ key, data: hit.data, loading: false, error: null })
      return
    }

    const controller = new AbortController()
    setState({ key, data: null, loading: true, error: null })
    const params = new URLSearchParams({ market: input.market })
    if (asOf) params.set('as_of', asOf)
    if (input.includeChart) params.set('include', 'chart')
    fetch(`/api/stock-preview/${encodeURIComponent(input.ticker)}?${params.toString()}`, {
      cache: 'no-store',
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) {
          const payload = await response.json().catch(() => null) as { message?: string } | null
          throw new Error(payload?.message ?? `HTTP ${response.status}`)
        }
        return response.json() as Promise<StockPreviewData>
      })
      .then((next) => {
        const now = Date.now()
        previewCache.set(key, { data: next, expiresAt: now + (asOf ? PIT_TTL_MS : LATEST_TTL_MS), usedAt: now })
        pruneCache()
        setState({ key, data: next, loading: false, error: null })
      })
      .catch((reason: unknown) => {
        if (controller.signal.aborted) return
        setState({
          key,
          data: null,
          loading: false,
          error: reason instanceof Error ? reason.message : 'データを取得できませんでした。',
        })
      })
    return () => controller.abort()
  }, [asOf, input.enabled, input.includeChart, input.market, input.ticker, key])

  const current = state.key === key
    ? state
    : { key, data: null, loading: input.enabled, error: null }
  return { data: current.data, loading: current.loading, error: current.error, cacheKey: key }
}
