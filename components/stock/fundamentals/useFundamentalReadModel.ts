import { useEffect, useState } from 'react'

/**
 * 業績・財務・バリュエーション・株主還元パネル共通の read model 取得。
 * ticker / analysisDate の変更中は直前の model を保持したまま再取得する。
 */
export function useFundamentalReadModel<T>(endpoint: string, ticker: string, analysisDate: string | null) {
  const [model, setModel] = useState<T | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [reloadKey, setReloadKey] = useState(0)

  useEffect(() => {
    const controller = new AbortController()
    setLoading(true)
    setError('')
    const query = analysisDate ? `?as_of=${encodeURIComponent(analysisDate)}` : ''
    fetch(`${endpoint}${encodeURIComponent(ticker)}${query}`, { cache: 'no-store', signal: controller.signal })
      .then((response) => response.ok ? response.json() : Promise.reject(new Error(`HTTP ${response.status}`)))
      .then((payload: T) => {
        if (!controller.signal.aborted) setModel(payload)
      })
      .catch((reason) => {
        if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : String(reason))
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false)
      })
    return () => controller.abort()
  }, [analysisDate, endpoint, ticker, reloadKey])

  return { model, loading, error, retry: () => setReloadKey((value) => value + 1) }
}
