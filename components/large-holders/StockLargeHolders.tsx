'use client'

import Link from 'next/link'
import { useEffect, useRef, useState } from 'react'
import { ExternalLink, Users } from 'lucide-react'
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

const basisLabel: Record<HoldingBasis, string> = {
  OWNERSHIP: '所有等', INVESTMENT_AUTHORITY: '運用権限',
  VOTING_AUTHORITY: '議決権', OTHER: 'その他',
}
const officialUrl = (value: string | null) => value?.startsWith('https://disclosure2.edinet-fsa.go.jp/') ? value : null

export function StockLargeHolders({ ticker, analysisDate, analysisParamsReady }: {
  ticker: string; analysisDate: string | null; analysisParamsReady: boolean }) {
  const section = useRef<HTMLElement>(null)
  const [visible, setVisible] = useState(false)
  const [fetchedData, setData] = useState<StockHoldersResponse | null>(null)
  const [error, setError] = useState(false)
  const data = fetchedData?.ticker === ticker ? fetchedData : null

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
    fetch(`/api/large-holders/stocks/${encodeURIComponent(ticker)}`, {
      cache: 'no-store', signal: controller.signal,
    }).then(async (response) => {
      if (!response.ok) throw new Error(`stock_large_holders_${response.status}`)
      return response.json() as Promise<StockHoldersResponse>
    }).then((value) => { setData(value); setError(false) })
      .catch(() => { if (!controller.signal.aborted) setError(true) })
    return () => controller.abort()
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
      ) : error ? (
        <p className="mt-3 text-sm text-[var(--color-text-secondary)]">最新データの再集計が必要です。</p>
      ) : !data ? (
        <p className="mt-3 text-sm text-[var(--color-text-tertiary)]">{visible ? '読み込み中…' : '大口保有の情報を読み込みます。'}</p>
      ) : (
        <>
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
          ) : <p className="py-3 text-sm text-[var(--color-text-tertiary)]">現在の大量保有開示はありません。</p>}
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
        </>
      )}
    </section>
  )
}
