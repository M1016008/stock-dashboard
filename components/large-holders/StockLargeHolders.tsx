'use client'

import Link from 'next/link'
import { useCallback, useEffect, useRef, useState } from 'react'
import { ExternalLink, RefreshCw, Users } from 'lucide-react'
import { HolderFetchError, holderFetch } from '@/components/large-holders/LargeHoldersShared'
import {
  shouldRevalidateStockLargeHolders,
  stockLargeHolderCertifiedState,
  stockLargeHolderFailureState,
  type StockLargeHolderAvailability,
} from '@/lib/large-holders/stock-overview-availability'
import { CLASS_LABEL, EVENT_LABEL, date, pct, positionUnits, yen } from '@/lib/large-holders/ui'
import type { HolderActivity, HoldingBasis, InvestorClass, RankedPosition } from '@/lib/large-holders/ranking-core'

type StockHolder = RankedPosition & {
  investorName: string
  investorClass: InvestorClass
  investorType: string
  previousChange: HolderActivity | null
  filingSourceUrl: string | null
}
type StockActivity = HolderActivity & { investorName: string; filingSourceUrl: string | null }
type StockHoldersResponse = {
  ticker: string
  snapshotStatus: 'VALIDATED' | 'VALIDATED_WITH_QUARANTINE'
  currentState?: 'CURRENT' | 'CURRENT_STATE_BLOCKED_BY_SOURCE'
  blockedSourceDocuments?: { documentId: string; issuerName: string | null; reasonCode: string }[]
  certificationAsOf: string
  priceDate: string
  activityWindowEnd: string
  totalObservedHolders: number
  zeroPositionCount: number
  holderCountByClass: Record<InvestorClass, number>
  activityCounts: Record<HolderActivity['eventType'], number>
  latestDisclosedLargeHolders: StockHolder[]
  recentActivities: StockActivity[]
}

type HolderResult =
  | { ticker: string; kind: 'data'; data: StockHoldersResponse }
  | { ticker: string; kind: 'failure'; state: Exclude<StockLargeHolderAvailability, 'CURRENT' | 'REFRESHING'> }

const REVALIDATE_INTERVAL_MS = 30_000

const basisLabel: Record<HoldingBasis, string> = {
  OWNERSHIP: '所有等', INVESTMENT_AUTHORITY: '運用権限',
  VOTING_AUTHORITY: '議決権', OTHER: 'その他',
}
const officialUrl = (value: string | null) => value?.startsWith('https://disclosure2.edinet-fsa.go.jp/') ? value : null

export function StockLargeHolders({ ticker, analysisDate, analysisParamsReady }: {
  ticker: string; analysisDate: string | null; analysisParamsReady: boolean }) {
  const section = useRef<HTMLElement>(null)
  const [visible, setVisible] = useState(false)
  const [result, setResult] = useState<HolderResult | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const current = result?.ticker === ticker ? result : null
  const data = current?.kind === 'data' ? current.data : null
  const stateRef = useRef<StockLargeHolderAvailability | null>(null)
  const loadRef = useRef<((background: boolean) => void) | null>(null)
  const baseState: StockLargeHolderAvailability | null = !current ? null
    : current.kind === 'failure' ? current.state
      : stockLargeHolderCertifiedState(
        current.data.snapshotStatus,
      )
  const state: StockLargeHolderAvailability | null = baseState === 'STALE' && refreshing ? 'REFRESHING' : baseState
  stateRef.current = baseState
  const retry = useCallback(() => {
    const background = stateRef.current === 'STALE'
    if (!background) setResult(null)
    loadRef.current?.(background)
  }, [])

  useEffect(() => {
    if (!analysisParamsReady || analysisDate) return
    const node = section.current
    if (!node) return
    if (!('IntersectionObserver' in window)) { setVisible(true); return }
    const observer = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting) { setVisible(true); observer.disconnect() }
    }, { rootMargin: '240px' })
    observer.observe(node)
    return () => observer.disconnect()
  }, [analysisDate, analysisParamsReady, ticker])

  useEffect(() => {
    if (!analysisParamsReady || !visible || analysisDate) return
    if (new URLSearchParams(window.location.search).has('date')) return
    const controller = new AbortController()
    let inflight = false
    const load = async (background: boolean) => {
      if (inflight) return
      inflight = true
      if (background) setRefreshing(true)
      try {
        const value = await holderFetch<StockHoldersResponse>(
          `/api/large-holders/stocks/${encodeURIComponent(ticker)}`, controller.signal)
        if (controller.signal.aborted) return
        if (!Array.isArray(value?.latestDisclosedLargeHolders)
          || !Array.isArray(value.recentActivities)
          || !['VALIDATED', 'VALIDATED_WITH_QUARANTINE'].includes(value.snapshotStatus)) {
          throw new HolderFetchError('invalid_response', 200)
        }
        setResult({ ticker, kind: 'data', data: value })
      } catch (cause) {
        if (controller.signal.aborted) return
        const reason = cause instanceof HolderFetchError ? cause.reason : null
        setResult({ ticker, kind: 'failure', state: stockLargeHolderFailureState(reason) })
      } finally {
        inflight = false
        if (!controller.signal.aborted) setRefreshing(false)
      }
    }
    const revalidate = () => {
      if (document.visibilityState === 'hidden') return
      const latest = stateRef.current
      if (latest && shouldRevalidateStockLargeHolders(latest)) void load(true)
    }
    loadRef.current = (background) => { void load(background) }
    void load(false)
    const timer = window.setInterval(revalidate, REVALIDATE_INTERVAL_MS)
    window.addEventListener('focus', revalidate)
    document.addEventListener('visibilitychange', revalidate)
    return () => {
      controller.abort()
      loadRef.current = null
      window.clearInterval(timer)
      window.removeEventListener('focus', revalidate)
      document.removeEventListener('visibilitychange', revalidate)
      setRefreshing(false)
    }
  }, [analysisDate, analysisParamsReady, ticker, visible])

  return (
    <section ref={section} aria-labelledby="stock-large-holders-title" className="border-t border-[var(--color-border-soft)] bg-white pt-5" data-stock-large-holders>
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div className="flex items-center gap-2">
          <Users size={17} className="text-[var(--color-brand-700)]" aria-hidden="true" />
          <h2 id="stock-large-holders-title" className="text-[15px] font-bold text-[var(--color-text-primary)]">大口保有</h2>
        </div>
        {!analysisDate && data && <span className="text-xs text-[var(--color-text-tertiary)]">開示基準 {date(data.certificationAsOf)} / 価格 {date(data.priceDate)}</span>}
      </div>
      {!analysisParamsReady ? (
        <p className="mt-3 text-sm text-[var(--color-text-tertiary)]">読み込み中…</p>
      ) : analysisDate ? (
        <p className="mt-3 text-sm text-[var(--color-text-secondary)]">現在の大量保有開示は過去時点分析に表示していません。</p>
      ) : current?.kind === 'failure' ? (
        <div role="status" className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2 text-sm text-[var(--color-text-secondary)]" data-holder-state={state}>
          <p>{state === 'REFRESHING' ? '最新の認定状態を確認しています…'
            : current.state === 'STALE' ? '最新の認定データを待っています。30秒ごとに自動で再確認します。'
              : current.state === 'NOT_CONFIGURED' ? '大口保有データはまだ設定されていません。設定後に再試行してください。'
                : current.state === 'NO_DATA' ? '大口保有データはまだありません。時間をおいて再試行してください。'
                  : '大口保有を読み込めませんでした。時間をおいて再試行してください。'}</p>
          <button type="button" onClick={retry} disabled={state === 'REFRESHING'} className="inline-flex items-center gap-1.5 border border-[var(--border-subtle)] px-2.5 py-1 text-xs font-semibold text-[var(--color-text-primary)] hover:bg-slate-50 disabled:opacity-50">
            <RefreshCw size={12} className={state === 'REFRESHING' ? 'animate-spin' : undefined} aria-hidden="true" />再試行
          </button>
        </div>
      ) : !data ? (
        <p className="mt-3 text-sm text-[var(--color-text-tertiary)]">{visible ? '読み込み中…' : '大口保有の情報を読み込みます。'}</p>
      ) : (
        <div data-holder-state="CURRENT">
          {data.currentState === 'CURRENT_STATE_BLOCKED_BY_SOURCE' && <p role="status" className="mt-3 border-l-2 border-amber-500 pl-2 text-sm text-amber-900">
            最新提出書類に整合性未解決のため、大口保有情報の更新を保留しています。
            {data.blockedSourceDocuments?.map((item) => <span key={item.documentId} className="ml-2 font-medium">{item.documentId}</span>)}
          </p>}
          <div className="mt-3 flex flex-wrap items-baseline gap-x-5 gap-y-1 border-b border-[var(--color-border-soft)] pb-3 text-sm" data-holder-summary>
            <span><strong className="font-semibold text-[var(--color-text-primary)]">{data.totalObservedHolders}人・社</strong> <span className="text-[var(--color-text-tertiary)]">開示保有者（0株除外）</span></span>
            {(['INDIVIDUAL', 'INSTITUTIONAL', 'OTHER', 'UNCLASSIFIED'] as const).map((kind) => (
              <span key={kind} className="text-[var(--color-text-secondary)]">{CLASS_LABEL[kind]} <strong className="font-semibold text-[var(--color-text-primary)]">{data.holderCountByClass[kind] ?? 0}</strong></span>
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-x-5 gap-y-1 border-b border-[var(--color-border-soft)] py-2 text-xs text-[var(--color-text-secondary)]" data-holder-activity-summary>
            <span className="text-[var(--color-text-tertiary)]">直近90日（{date(data.activityWindowEnd)}まで）</span>
            {(['NEW_5PCT', 'INCREASE', 'DECREASE', 'EXIT_5PCT'] as const).map((kind) => (
              <span key={kind}>{EVENT_LABEL[kind]} <strong className="font-semibold text-[var(--color-text-primary)]">{data.activityCounts[kind] ?? 0}</strong></span>
            ))}
          </div>
          {data.latestDisclosedLargeHolders.length ? (
            <div className="overflow-x-auto" data-holder-table-scroll>
              <table className="w-full min-w-[920px] border-collapse text-left text-[13px]">
                <thead className="border-b border-[var(--color-border-default)] text-xs text-[var(--color-text-tertiary)]">
                  <tr>
                    <th className="py-2 pr-3 font-semibold">投資家</th><th className="py-2 pr-3 font-semibold">種別</th>
                    <th className="py-2 pr-3 text-right font-semibold">保有比率</th><th className="py-2 pr-3 text-right font-semibold">保有株数 / 口数</th>
                    <th className="py-2 pr-3 text-right font-semibold">推定現在時価</th><th className="py-2 pr-3 font-semibold">Holding Basis</th>
                    <th className="py-2 pr-3 text-right font-semibold">前回比率</th><th className="py-2 pr-3 text-right font-semibold">株数 / 口数差</th>
                    <th className="py-2 pr-3 font-semibold">Activity</th><th className="py-2 font-semibold">直近報告</th>
                  </tr>
                </thead>
                <tbody>
                  {data.latestDisclosedLargeHolders.map((holder) => (
                    <tr key={holder.positionKey} className="border-b border-[var(--color-border-soft)] align-top">
                      <td className="py-2 pr-3 font-semibold"><Link className="text-[var(--color-brand-700)] hover:underline" href={`/large-holders/investors/${encodeURIComponent(holder.investorEntityId)}`}>{holder.investorName}</Link></td>
                      <td className="py-2 pr-3 text-[var(--color-text-secondary)]">{CLASS_LABEL[holder.investorClass]}</td>
                      <td className="py-2 pr-3 text-right tabular-nums">{pct(holder.reportedHoldingPct)}</td>
                      <td className="py-2 pr-3 text-right tabular-nums">{positionUnits(holder.certifiedUnits ?? holder.reportedShares, holder)}</td>
                      <td className="py-2 pr-3 text-right font-semibold tabular-nums">{yen(holder.estimatedCurrentValue)}</td>
                      <td className="py-2 pr-3 text-[var(--color-text-secondary)]">{basisLabel[holder.holdingBasis]}</td>
                      <td className="py-2 pr-3 text-right tabular-nums">{pct(holder.previousChange?.previousHoldingPct)}</td>
                      <td className="py-2 pr-3 text-right tabular-nums">{positionUnits(holder.previousChange?.sharesDelta, holder)}</td>
                      <td className="py-2 pr-3">{holder.previousChange ? EVENT_LABEL[holder.previousChange.eventType] : '—'}</td>
                      <td className="py-2 whitespace-nowrap">{officialUrl(holder.filingSourceUrl) ? <a className="inline-flex items-center gap-1 text-[var(--color-brand-700)] hover:underline" href={holder.filingSourceUrl!} target="_blank" rel="noopener noreferrer">{date(holder.filingDate)}<ExternalLink size={12} aria-hidden="true" /></a> : date(holder.filingDate)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {data.zeroPositionCount > 0 && <p className="py-1 text-xs text-[var(--color-text-tertiary)]">表には保有0の最終開示 {data.zeroPositionCount}件を含みます。</p>}
            </div>
          ) : <p className="py-3 text-sm text-[var(--color-text-tertiary)]" data-holder-content="EMPTY">{date(data.certificationAsOf)}時点の認定データでは、この銘柄の大量保有開示はありません。</p>}
          {data.recentActivities.length > 0 && (
            <div className="pt-4" data-holder-activity-timeline>
              <h3 className="text-sm font-semibold text-[var(--color-text-primary)]">最近の開示変化</h3>
              <ol className="mt-2 space-y-1.5">
                {data.recentActivities.map((activity) => (
                  <li key={`${activity.documentId}:${activity.investorEntityId}:${activity.eventType}`} className="flex flex-wrap gap-x-3 gap-y-0.5 border-b border-[var(--color-border-soft)] py-1.5 text-[13px]">
                    <span className="w-[88px] shrink-0 tabular-nums text-[var(--color-text-tertiary)]">{date(activity.obligationDate)}</span>
                    <span className="w-[65px] shrink-0 font-semibold">{EVENT_LABEL[activity.eventType]}</span>
                    <Link className="text-[var(--color-brand-700)] hover:underline" href={`/large-holders/investors/${encodeURIComponent(activity.investorEntityId)}`}>{activity.investorName}</Link>
                    <span className="text-[var(--color-text-secondary)]">{pct(activity.previousHoldingPct)} → {pct(activity.reportedHoldingPct)}</span>
                    {officialUrl(activity.filingSourceUrl) && <a className="inline-flex items-center gap-1 text-[var(--color-brand-700)] hover:underline" href={activity.filingSourceUrl!} target="_blank" rel="noopener noreferrer">EDINET {date(activity.filingDate)}<ExternalLink size={12} aria-hidden="true" /></a>}
                  </li>
                ))}
              </ol>
            </div>
          )}
        </div>
      )}
    </section>
  )
}
