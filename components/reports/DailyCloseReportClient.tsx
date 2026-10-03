'use client'

import { useEffect, useMemo, useState } from 'react'
import { CalendarDays, Download, RefreshCw } from 'lucide-react'
import { useWatchlistStore } from '@/lib/watchlist-store'
import type { DailyCloseReport } from '@/lib/daily-close-report'
import { DailyCloseReportView } from '@/components/reports/DailyCloseReportView'
import styles from './daily-close-report.module.css'

export function DailyCloseReportClient({ requestedDate }: { requestedDate: string | null }) {
  const tickers = useWatchlistStore((state) => state.tickers)
  const [hydrated, setHydrated] = useState(false)
  const [data, setData] = useState<DailyCloseReport | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [reloadKey, setReloadKey] = useState(0)

  useEffect(() => {
    if (useWatchlistStore.persist.hasHydrated()) setHydrated(true)
    return useWatchlistStore.persist.onFinishHydration(() => setHydrated(true))
  }, [])

  const watchlist = useMemo(() => [...tickers].sort().slice(0, 100).join(','), [tickers])
  useEffect(() => {
    if (!hydrated) return
    const controller = new AbortController()
    const params = new URLSearchParams()
    if (requestedDate) params.set('date', requestedDate)
    if (watchlist) params.set('watchlist', watchlist)
    setData(null)
    setError(null)
    fetch(`/api/reports/daily-close?${params}`, { cache: 'no-store', signal: controller.signal })
      .then(async (response) => {
        const body = await response.json()
        if (!response.ok) throw new Error(body.error ?? 'レポートを生成できませんでした')
        return body as DailyCloseReport
      })
      .then(setData)
      .catch((cause) => {
        if ((cause as Error).name !== 'AbortError') setError((cause as Error).message)
      })
    return () => controller.abort()
  }, [hydrated, requestedDate, watchlist, reloadKey])

  const changeDate = (date: string) => {
    const url = new URL(window.location.href)
    if (date) url.searchParams.set('date', date)
    else url.searchParams.delete('date')
    window.location.assign(url.toString())
  }

  return (
    <div className={styles.workspace}>
      <div className={styles.toolbar}>
        <div>
          <div className={styles.toolbarEyebrow}>STOCKBOARD RESEARCH</div>
          <h1>Daily Close Report</h1>
          <p>確定済み日本株終値を基準にしたInstitutional Daily Market Brief</p>
        </div>
        <div className={styles.toolbarActions}>
          <label className={styles.dateField}>
            <CalendarDays size={15} aria-hidden="true" />
            <span className="sr-only">基準日</span>
            <input type="date" value={requestedDate ?? ''} onChange={(event) => changeDate(event.target.value)} />
          </label>
          <button type="button" title="再生成" aria-label="レポートを再生成" onClick={() => setReloadKey((value) => value + 1)}><RefreshCw size={16} /></button>
          <button type="button" title="印刷・PDF" aria-label="印刷・PDFとして保存" onClick={() => window.print()}><Download size={16} /></button>
        </div>
      </div>
      {!hydrated || (!data && !error) ? <div className={styles.state}>Report Datasetを生成しています...</div> : null}
      {error ? <div className={`${styles.state} ${styles.error}`} role="alert">{error}</div> : null}
      {data ? <DailyCloseReportView report={data} /> : null}
    </div>
  )
}
