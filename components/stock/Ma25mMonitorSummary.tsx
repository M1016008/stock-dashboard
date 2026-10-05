'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { ArrowDownToLine, ArrowUpFromLine, Layers3 } from 'lucide-react'

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
  const [failed, setFailed] = useState<string | null>(null)
  const [reloadKey, setReloadKey] = useState(0)

  useEffect(() => {
    const controller = new AbortController()
    setLoading(true)
    setFailed(null)
    const query = analysisDate ? `?date=${encodeURIComponent(analysisDate)}` : ''
    fetch(`/api/ma25m-monitor/${encodeURIComponent(ticker)}${query}`, { cache: 'no-store', signal: controller.signal })
      .then((response) => response.ok ? response.json() : Promise.reject(new Error(`HTTP ${response.status}`)))
      .then((data: DetailResponse) => setPayload(data))
      .catch((error) => {
        if (error instanceof DOMException && error.name === 'AbortError') return
        // 取得失敗は「履歴不足」ではないので別状態として持つ
        setPayload(null)
        setFailed(error instanceof Error ? error.message : '取得失敗')
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false)
      })
    return () => controller.abort()
  }, [analysisDate, ticker, reloadKey])

  const monitors = payload?.monitors ?? []
  const clusters = payload?.clusters ?? []

  return (
    <section className="@container border border-[var(--color-border-default)] bg-white" aria-labelledby="monthly-ma-structure-title">
      <header className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 px-3 pb-2 pt-3">
        <h2 id="monthly-ma-structure-title" className="text-[14px] font-bold text-[var(--color-text-primary)]">月足MAの位置</h2>
        <span className="text-[11px] font-medium text-[var(--color-text-tertiary)]">MA値 ・ 終値比 ・ 接近スコアと日あたり速度(月A・月Bの月足ステージを補う)</span>
        <span className="ml-auto inline-flex items-center gap-3">
          {payload?.date && <span className="font-mono text-[11px] font-medium text-[var(--color-text-tertiary)]">基準 {payload.date}</span>}
          <Link href={`/ma25m-monitor?q=${encodeURIComponent(ticker)}`} className="inline-flex min-h-11 items-center text-[11px] font-bold text-[var(--color-brand-700)] hover:underline sm:min-h-8">監視一覧</Link>
        </span>
      </header>
      {loading ? (
        <div className="border-t border-[var(--color-border-soft)] px-3 py-3 text-[11px] font-semibold text-[var(--color-text-tertiary)]">読込中…</div>
      ) : failed ? (
        <div role="alert" className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-[var(--color-border-soft)] px-3 py-2 text-[12px] font-semibold text-[var(--color-text-secondary)]">
          <span>月足MAを取得できませんでした({failed})。履歴不足ではなく通信・取得の失敗です。</span>
          <button
            type="button"
            onClick={() => setReloadKey((key) => key + 1)}
            className="inline-flex min-h-11 items-center border border-[var(--color-border-default)] bg-white px-3 text-[12px] font-bold text-[var(--color-brand-900)] hover:bg-[var(--color-surface-subtle)] sm:min-h-8"
          >再読込</button>
        </div>
      ) : monitors.length === 0 ? (
        <div className="border-t border-[var(--color-border-soft)] px-3 py-3 text-[12px] font-semibold text-[var(--color-text-tertiary)]">月足MAの算出履歴が不足しています</div>
      ) : (
        <>
          <div className="grid grid-cols-2 border-t border-[var(--color-border-soft)] @[30rem]:grid-cols-3 @[56rem]:grid-cols-6">
            {monitors.map((point) => {
              const score = Math.max(0, Math.min(100, point.approachScore))
              return (
                <div key={point.period} className="min-w-0 border-b border-r border-[var(--color-border-soft)] px-3 py-2 @[56rem]:border-b-0">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-mono text-[12px] font-bold text-[var(--color-brand-800)]">{point.period}M</span>
                    <span className={`inline-flex items-center gap-0.5 text-[11px] font-bold ${point.isApproaching || point.touchAgeSessions === 0 ? 'text-[var(--color-text-primary)]' : 'text-[var(--color-text-tertiary)]'}`}>
                      {point.isApproaching ? (point.approachDirection === 'above' ? <ArrowDownToLine size={11} aria-hidden="true" /> : <ArrowUpFromLine size={11} aria-hidden="true" />) : null}
                      {monitorState(point)}
                    </span>
                  </div>
                  <div className="mt-1 flex flex-wrap items-baseline justify-between gap-x-2 font-mono tabular-nums" title="月足MA値 ・ 終値比">
                    <span className="text-[13px] font-bold text-[var(--color-text-primary)]">¥{formatPrice(point.maValue)}</span>
                    <span className={`text-[12px] font-bold ${point.distancePct >= 0 ? 'text-[var(--price-up)]' : 'text-[var(--price-down)]'}`}>
                      <span className="sr-only">終値比 </span>{formatPct(point.distancePct)}
                    </span>
                  </div>
                  <div className="mt-1 flex flex-wrap items-baseline justify-between gap-x-2 text-[11px]" title={`接近スコア ${point.approachScore.toFixed(1)}(0〜100) ・ 接近速度 ${formatPct(point.approachSpeedPctPerDay, 3)}/日`}>
                    <span>
                      <span className="font-medium text-[var(--color-text-tertiary)]">接近 </span>
                      <span className="font-mono font-bold tabular-nums text-[var(--color-brand-900)]">{point.approachScore.toFixed(1)}</span>
                    </span>
                    <span className="font-mono font-medium tabular-nums text-[var(--color-text-tertiary)]">{formatPct(point.approachSpeedPctPerDay, 3)}/日</span>
                  </div>
                  <span role="img" aria-label={`接近スコア ${point.approachScore.toFixed(1)}(0〜100)`} className="relative mt-1 block h-1.5 bg-[var(--color-surface-muted)]">
                    <span className="absolute inset-y-0 left-0 bg-[var(--color-brand-700)]" style={{ width: `${score}%` }} />
                  </span>
                </div>
              )
            })}
          </div>
          {clusters.length > 0 && (
            <div className="border-t border-[var(--color-border-soft)] bg-[var(--color-surface-subtle)] px-3 py-2">
              <div className="flex flex-wrap items-center gap-2">
                <span className="inline-flex items-center gap-1 text-[11px] font-bold text-[var(--color-text-secondary)]"><Layers3 size={12} aria-hidden="true" /> MA集中帯</span>
                {clusters.map((cluster) => (
                  <span key={cluster.clusterKey} className="inline-flex items-center gap-1 border border-[var(--color-border-default)] bg-white px-2 py-1 text-[11px] font-bold text-[var(--color-text-secondary)]">
                    {cluster.periods.map((period) => `${period}M`).join('・')}
                    <span className="font-mono font-medium">¥{formatPrice(cluster.bandLow)}〜{formatPrice(cluster.bandHigh)}</span>
                    {cluster.isStrong && <b className="border border-dashed border-[var(--color-text-secondary)] px-1 text-[var(--color-text-primary)]">強</b>}
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
