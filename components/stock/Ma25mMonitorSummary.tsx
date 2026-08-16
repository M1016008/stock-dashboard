'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { ArrowDownToLine, ArrowUpFromLine, Layers3, Radar } from 'lucide-react'

type MonitorPoint = {
  period: number
  date: string
  close: number
  maValue: number
  distancePct: number
  isApproaching: number | boolean
  approachDirection: 'above' | 'below' | 'none'
  approachSpeedPctPerDay: number
  approachScore: number
  touchAgeSessions: number | null
  lastCrossDirection: 'up' | 'down' | null
  crossAgeSessions: number | null
}

type ClusterPoint = {
  clusterKey: string
  periods: number[]
  isStrong: number | boolean
  bandLow: number
  bandHigh: number
  spreadPct: number
  distancePct: number
  isApproaching: number | boolean
  approachDirection: 'above' | 'below' | 'none'
  touchAgeSessions: number | null
  lastCrossDirection: 'up' | 'down' | null
  crossAgeSessions: number | null
}

type DetailResponse = {
  date: string | null
  monitors: MonitorPoint[]
  clusters: ClusterPoint[]
}

function formatPrice(value: number): string {
  return new Intl.NumberFormat('ja-JP', { maximumFractionDigits: value < 100 ? 2 : 1 }).format(value)
}

function formatPct(value: number, digits = 2): string {
  return `${value > 0 ? '+' : ''}${value.toFixed(digits)}%`
}

function monitorState(point: MonitorPoint): string {
  if (point.crossAgeSessions === 0) return point.lastCrossDirection === 'up' ? '本日上抜け' : '本日下抜け'
  if (point.touchAgeSessions === 0) return '本日タッチ'
  if (point.isApproaching) return point.approachDirection === 'above' ? '上から接近' : '下から接近'
  return '監視'
}

export function Ma25mMonitorSummary({ ticker, analysisDate }: { ticker: string; analysisDate: string | null }) {
  const [payload, setPayload] = useState<DetailResponse | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const controller = new AbortController()
    setLoading(true)
    const query = analysisDate ? `?date=${encodeURIComponent(analysisDate)}` : ''
    fetch(`/api/ma25m-monitor/${encodeURIComponent(ticker)}${query}`, { cache: 'no-store', signal: controller.signal })
      .then((response) => response.ok ? response.json() : Promise.reject(new Error(`HTTP ${response.status}`)))
      .then((data: DetailResponse) => setPayload(data))
      .catch((error) => {
        if (!(error instanceof DOMException && error.name === 'AbortError')) setPayload(null)
      })
      .finally(() => setLoading(false))
    return () => controller.abort()
  }, [analysisDate, ticker])

  const monitors = payload?.monitors ?? []
  const clusters = payload?.clusters ?? []

  return (
    <section className="border border-[var(--color-border-default)] bg-white" aria-label="月足移動平均線監視">
      <div className="flex flex-wrap items-center gap-2 border-b border-[var(--color-border-default)] bg-[var(--color-brand-50)] px-3 py-2">
        <Radar size={15} className="text-[var(--color-brand-700)]" />
        <h2 className="text-[11px] font-black text-[var(--color-brand-900)]">月足MA接近レーダー</h2>
        {payload?.date && <span className="font-mono text-[9px] font-bold text-[var(--color-text-tertiary)]">{payload.date}</span>}
        <Link href={`/ma25m-monitor?q=${encodeURIComponent(ticker)}`} className="ml-auto text-[10px] font-black text-[var(--color-brand-700)] hover:underline">監視一覧</Link>
      </div>
      {loading ? (
        <div className="px-3 py-4 text-[11px] font-bold text-[var(--color-text-tertiary)]">読込中…</div>
      ) : monitors.length === 0 ? (
        <div className="px-3 py-4 text-[11px] font-bold text-[var(--color-text-tertiary)]">月足MAの算出履歴が不足しています</div>
      ) : (
        <>
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6">
            {monitors.map((point) => (
              <div key={point.period} className="min-w-0 border-b border-r border-[var(--color-border-soft)] px-3 py-2 lg:border-b-0">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-mono text-[11px] font-black text-[var(--color-brand-800)]">{point.period}M</span>
                  <span className={`text-[9px] font-black ${point.isApproaching ? 'text-violet-700' : point.touchAgeSessions === 0 ? 'text-amber-700' : 'text-[var(--color-text-tertiary)]'}`}>{monitorState(point)}</span>
                </div>
                <div className="mt-1 font-mono text-[12px] font-black text-[var(--color-text-primary)]">¥{formatPrice(point.maValue)}</div>
                <div className={`mt-0.5 font-mono text-[11px] font-black ${point.distancePct >= 0 ? 'text-red-600' : 'text-blue-600'}`}>{formatPct(point.distancePct)}</div>
                <div className="mt-1 flex items-center justify-between gap-2 text-[9px] font-bold text-[var(--color-text-tertiary)]">
                  <span className="inline-flex items-center gap-0.5">{point.isApproaching ? (point.approachDirection === 'above' ? <ArrowDownToLine size={10} /> : <ArrowUpFromLine size={10} />) : null}{formatPct(point.approachSpeedPctPerDay, 3)}/日</span>
                  <span className="font-mono text-[11px] font-black text-[var(--color-brand-900)]">{point.approachScore.toFixed(1)}</span>
                </div>
              </div>
            ))}
          </div>
          {clusters.length > 0 && (
            <div className="border-t border-yellow-200 bg-yellow-50 px-3 py-2">
              <div className="flex flex-wrap items-center gap-2">
                <span className="inline-flex items-center gap-1 text-[10px] font-black text-yellow-900"><Layers3 size={12} /> MA集中帯</span>
                {clusters.map((cluster) => (
                  <span key={cluster.clusterKey} className="inline-flex items-center gap-1 border border-yellow-300 bg-white px-2 py-1 text-[9px] font-black text-yellow-900">
                    {cluster.periods.map((period) => `${period}M`).join('・')}
                    <span className="font-mono font-bold">¥{formatPrice(cluster.bandLow)}〜{formatPrice(cluster.bandHigh)}</span>
                    {cluster.isStrong && <b className="text-red-700">強</b>}
                  </span>
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </section>
  )
}
