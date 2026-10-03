'use client'

import Link from 'next/link'
import { useEffect, useMemo, useState } from 'react'
import { X } from 'lucide-react'
import type { HolderActivity, RankedPosition } from '@/lib/large-holders/ranking-core'
import { EVENT_LABEL, TYPE_LABEL, date, exactYen, pct, positionUnits, yen,
  type BasisFilter, type InvestorDetailResponse } from '@/lib/large-holders/ui'
import { AsOfLine, ClassBadge, CompletenessBadge, HolderDisclaimer, HolderError,
  HolderFetchError, HolderPageHeader, HolderSkeleton, Segmented, TableScroll,
  holderFetch, numeric, td, th } from './LargeHoldersShared'

type FilingResponse = { filing: InvestorDetailResponse['filingTimeline'][number];
  evidence: { authority: string; documentId: string; officialReference: string;
    sourceSha256: string | null; hashStatus: string } }

export function InvestorDetailClient({ id }: { id: string }) {
  const [data, setData] = useState<InvestorDetailResponse | null>(null)
  const [error, setError] = useState<HolderFetchError | Error | null>(null)
  const [retryKey, setRetryKey] = useState(0)
  const [basis, setBasis] = useState<BasisFilter>('OWNERSHIP')
  const [taxonomy, setTaxonomy] = useState<'17' | '33'>('17')
  const [selectedDoc, setSelectedDoc] = useState<string | null>(null)
  const [doc, setDoc] = useState<FilingResponse | null>(null)
  const [docError, setDocError] = useState<Error | null>(null)

  useEffect(() => {
    const controller = new AbortController()
    setData(null)
    setError(null)
    holderFetch<InvestorDetailResponse>(`/api/large-holders/investors/${encodeURIComponent(id)}`, controller.signal)
      .then((result) => { if (!controller.signal.aborted) setData(result) })
      .catch((cause: unknown) => { if (!controller.signal.aborted) setError(cause as Error) })
    return () => controller.abort()
  }, [id, retryKey])

  useEffect(() => {
    if (!selectedDoc) return
    const controller = new AbortController()
    setDoc(null)
    setDocError(null)
    holderFetch<FilingResponse>(`/api/large-holders/filings/${encodeURIComponent(selectedDoc)}`, controller.signal)
      .then((result) => { if (!controller.signal.aborted) setDoc(result) })
      .catch((cause: unknown) => { if (!controller.signal.aborted) setDocError(cause as Error) })
    return () => controller.abort()
  }, [selectedDoc])

  useEffect(() => {
    if (!selectedDoc) return
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') setSelectedDoc(null) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [selectedDoc])

  const selected = useMemo(() => data?.positions.filter((position) => position.holdingBasis === basis
    && position.estimatedCurrentValue != null) ?? [], [basis, data])
  const selectedTotal = selected.reduce((sum, position) => sum + position.estimatedCurrentValue!, 0)
  const sortedSelected = [...selected].sort((a, b) => b.estimatedCurrentValue! - a.estimatedCurrentValue!)
  const concentration = (count: number) => selectedTotal > 0
    ? `${((sortedSelected.slice(0, count).reduce((sum, position) => sum + position.estimatedCurrentValue!, 0) / selectedTotal) * 100).toFixed(1)}%`
    : '—'
  const sectorRows = [...selected.reduce((groups, position) => {
    const sector = (taxonomy === '17' ? position.industry17 : position.industry33) ?? '未分類'
    groups.set(sector, (groups.get(sector) ?? 0) + position.estimatedCurrentValue!)
    return groups
  }, new Map<string, number>())].sort((a, b) => b[1] - a[1])

  return <div className="min-w-0 space-y-5">
    <HolderPageHeader title={data?.identity.displayName ?? '投資家'} subtitle="大量保有報告書 · 直近開示ベース" />
    {error ? <HolderError error={error} retry={() => setRetryKey((key) => key + 1)} /> : !data ? <HolderSkeleton /> : <>
      <div className="space-y-2"><div className="flex flex-wrap items-center gap-2">
        <ClassBadge investorClass={data.identity.investorClass} investorType={data.identity.investorType} />
        {data.identity.investorType !== 'UNCLASSIFIED' && <span className="text-[12px] text-[var(--color-text-secondary)]">{TYPE_LABEL[data.identity.investorType] ?? data.identity.investorType}</span>}
        <span className="text-[12px] text-[var(--color-text-secondary)]">直近開示ベース</span>
      </div><AsOfLine meta={data} /></div>

      <section className="border-y border-[var(--border-subtle)] py-4">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
          <Metric label="所有等ベース推定時価" value={yen(data.portfolioSummary.ownershipEstimatedValue)}
            title={exactYen(data.portfolioSummary.ownershipEstimatedValue)} primary />
          {data.identity.investorClass === 'INSTITUTIONAL' && <Metric label="運用権限ベース推定時価" value={yen(data.portfolioSummary.investmentAuthorityEstimatedValue)} title={exactYen(data.portfolioSummary.investmentAuthorityEstimatedValue)} />}
          <Metric label="保有銘柄数" value={String(data.portfolioSummary.totalRelevantPositionCount)} />
          <Metric label="算定可能" value={`${data.portfolioSummary.valuedPositionCount} / ${data.portfolioSummary.totalRelevantPositionCount}`} />
          <Metric label="最大保有銘柄" value={sortedSelected[0]?.ticker ?? '—'} />
          <Metric label="直近報告" value={date(data.filingTimeline[0]?.filingDate)} />
        </div>
        <div className="mt-3"><CompletenessBadge completeness={data.portfolioSummary.portfolioCompleteness}
          valued={data.portfolioSummary.valuedPositionCount} total={data.portfolioSummary.totalRelevantPositionCount} /></div>
        {data.identity.investorClass === 'INSTITUTIONAL' && <p className="mt-2 text-[12px] text-[var(--color-text-secondary)]">運用権限ベースの推定時価は自己資金による投資額を示しません。所有等ベースと合算していません。</p>}
      </section>

      <section className="min-w-0 space-y-3"><div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-[17px] font-semibold">保有明細</h2>
        {data.identity.investorClass === 'INSTITUTIONAL' && <Segmented label="保有評価基準" value={basis}
          options={[{ value: 'OWNERSHIP', label: '所有等ベース' }, { value: 'INVESTMENT_AUTHORITY', label: '運用権限ベース' }]}
          onChange={setBasis} />}
      </div>
        <TableScroll><table className="min-w-[1150px] w-full border-collapse"><thead><tr>{['銘柄', '市場', '17業種', '33業種', '保有比率', '保有株数/口数', '推定現在時価', '法的基準', '直近変化', '直近報告', '元開示'].map((label) => <th key={label} className={th}>{label}</th>)}</tr></thead>
          <tbody>{data.positions.map((position) => <HoldingRow key={position.positionKey} position={position}
            latest={data.recentActivities.find((item) => item.ticker === position.ticker && item.holdingBasis === position.holdingBasis)}
            openDoc={setSelectedDoc} />)}</tbody></table></TableScroll>
      </section>

      <section className="grid gap-8 border-t border-[var(--border-subtle)] pt-5 lg:grid-cols-[minmax(0,2fr)_minmax(240px,1fr)]">
        <div><div className="flex flex-wrap items-center justify-between gap-2"><h2 className="text-[17px] font-semibold">業種構成</h2>
          <Segmented label="業種体系" value={taxonomy} options={[{ value: '17', label: '17業種' }, { value: '33', label: '33業種' }]} onChange={setTaxonomy} />
        </div><p className="mb-3 text-[12px] text-[var(--color-text-secondary)]">算定可能Positionのみ · {basis === 'OWNERSHIP' ? '所有等ベース' : '運用権限ベース'}</p>
          {sectorRows.length === 0 ? <p className="text-[13px] text-[var(--color-text-secondary)]">この基準で算定可能なPositionはありません。</p>
            : <div className="space-y-2">{sectorRows.map(([sector, value]) => <div key={sector} className="grid grid-cols-[minmax(120px,1fr)_minmax(70px,2fr)_auto] items-center gap-2 text-[13px]">
              <span className="truncate" title={sector}>{sector}</span><div className="h-2 bg-slate-100"><div className="h-full bg-[var(--color-brand-600)]" style={{ width: `${selectedTotal ? value / selectedTotal * 100 : 0}%` }} /></div>
              <span className="min-w-20 text-right tabular-nums">{yen(value)}</span>
            </div>)}</div>}
        </div>
        <div><h2 className="text-[17px] font-semibold">集中度</h2><p className="mb-3 text-[12px] text-[var(--color-text-secondary)]">算定可能分内の推定時価構成比 · {basis === 'OWNERSHIP' ? '所有等' : '運用権限'}</p>
          <dl className="space-y-2 text-[13px]">{[[1, 'Top 1'], [3, 'Top 3'], [5, 'Top 5']].map(([count, label]) => <div key={label} className="flex justify-between border-b border-[var(--border-subtle)] pb-1"><dt>{label}</dt><dd className="font-semibold tabular-nums">{concentration(Number(count))}</dd></div>)}</dl>
        </div>
      </section>

      <section className="space-y-3 border-t border-[var(--border-subtle)] pt-5"><h2 className="text-[17px] font-semibold">保有変化</h2>
        {data.recentActivities.length === 0 ? <p className="text-[13px] text-[var(--color-text-secondary)]">認定可能な変化はありません。</p>
          : <TableScroll><table className="min-w-[660px] w-full"><thead><tr>{['義務日', '変化', '銘柄', '保有比率', '数量差', '現在時価換算', '開示'].map((label) => <th key={label} className={th}>{label}</th>)}</tr></thead>
            <tbody>{data.recentActivities.map((event) => <tr key={`${event.documentId}:${event.ticker}:${event.eventType}`}>
              <td className={td}>{date(event.obligationDate)}</td><td className={td}>{EVENT_LABEL[event.eventType]}</td>
              <td className={td}><Link href={`/stock/${event.ticker}`} className="text-[var(--color-brand-600)]">{event.ticker} {event.issuerName}</Link></td>
              <td className={`${td} ${numeric}`}>{pct(event.reportedHoldingPct)}</td><td className={`${td} ${numeric}`}>{positionUnits(event.sharesDelta, event)}</td>
              <td className={`${td} ${numeric}`}>{yen(event.currentValueEquivalent)}</td>
              <td className={td}><button type="button" onClick={() => setSelectedDoc(event.documentId)} className="text-[var(--color-brand-600)] hover:underline">{event.documentId}</button></td>
            </tr>)}</tbody></table></TableScroll>}
      </section>

      <section className="space-y-3 border-t border-[var(--border-subtle)] pt-5"><h2 className="text-[17px] font-semibold">提出書類履歴</h2>
        <TableScroll><table className="min-w-[580px] w-full"><thead><tr>{['提出日', '種別', '銘柄', '報告義務日', 'EDINET'].map((label) => <th key={label} className={th}>{label}</th>)}</tr></thead>
          <tbody>{data.filingTimeline.map((filing) => <tr key={filing.documentId}><td className={td}>{date(filing.filingDate)}</td>
            <td className={td}>{filing.isCorrection ? '訂正' : filing.filingType === 'INITIAL' ? '大量保有' : '変更'}</td>
            <td className={td}>{filing.ticker ?? '—'} {filing.issuerName}</td><td className={td}>{date(filing.obligationDate)}</td>
            <td className={td}><button type="button" onClick={() => setSelectedDoc(filing.documentId)} className="text-[var(--color-brand-600)] hover:underline">{filing.documentId}</button></td>
          </tr>)}</tbody></table></TableScroll>
      </section>
      <HolderDisclaimer />
    </>}
    {selectedDoc && <div className="fixed inset-0 z-[80] flex justify-end bg-black/30" onClick={() => setSelectedDoc(null)}>
      <aside role="dialog" aria-modal="true" aria-label="開示原本" onClick={(event) => event.stopPropagation()} className="h-full w-full max-w-[460px] overflow-y-auto bg-white p-5 shadow-xl">
        <div className="flex justify-between gap-2"><h2 className="text-[19px] font-semibold">開示原本</h2><button type="button" aria-label="閉じる" onClick={() => setSelectedDoc(null)}><X size={20} /></button></div>
        {docError ? <HolderError error={docError} retry={() => { setSelectedDoc(null); window.setTimeout(() => setSelectedDoc(selectedDoc), 0) }} />
          : !doc ? <HolderSkeleton /> : <dl className="mt-5 space-y-3 text-[13px]">
            <SourceDatum label="EDINET document ID" value={doc.evidence.documentId} />
            <SourceDatum label="提出日" value={date(doc.filing.filingDate)} />
            <SourceDatum label="報告義務日" value={date(doc.filing.obligationDate)} />
            <SourceDatum label="情報源" value={doc.evidence.authority} />
            <SourceDatum label="証拠状態" value={doc.evidence.hashStatus === 'VERIFIED_AT_SNAPSHOT_BUILD' ? '原本照合済み' : '未照合'} />
            <SourceDatum label="原本SHA-256" value={doc.evidence.sourceSha256 ?? '—'} />
            <a href={doc.evidence.officialReference} target="_blank" rel="noopener noreferrer" className="inline-block text-[var(--color-brand-600)] hover:underline">EDINET原本を開く ↗</a>
          </dl>}
      </aside>
    </div>}
  </div>
}

function HoldingRow({ position, latest, openDoc }: { position: RankedPosition;
  latest?: HolderActivity; openDoc: (docId: string) => void }) {
  return <tr className="hover:bg-slate-50"><td className={td}><Link href={`/stock/${position.ticker}`} className="font-medium text-[var(--color-brand-600)]">{position.ticker} {position.issuerName}</Link></td>
    <td className={td}>{position.market ?? '—'}</td><td className={td}>{position.industry17 ?? '—'}</td><td className={td}>{position.industry33 ?? '—'}</td>
    <td className={`${td} ${numeric}`}>{pct(position.reportedHoldingPct)}</td><td className={`${td} ${numeric}`}>{positionUnits(position.certifiedUnits ?? position.reportedShares, position)}</td>
    <td className={`${td} ${numeric}`} title={exactYen(position.estimatedCurrentValue)}>{yen(position.estimatedCurrentValue)}</td>
    <td className={td}>{position.holdingBasis === 'OWNERSHIP' ? '所有等' : position.holdingBasis === 'INVESTMENT_AUTHORITY' ? '運用権限' : position.holdingBasis === 'VOTING_AUTHORITY' ? '議決権等' : 'その他'}</td>
    <td className={td}>{latest ? `${EVENT_LABEL[latest.eventType]} · ${pct(latest.previousHoldingPct)} → ${pct(latest.reportedHoldingPct)}` : '—'}</td>
    <td className={td}>{date(position.filingDate)}</td><td className={td}><button type="button" onClick={() => openDoc(position.documentId)} className="text-[var(--color-brand-600)] hover:underline">{position.documentId}</button></td>
  </tr>
}
function Metric({ label, value, title, primary }: { label: string; value: string; title?: string; primary?: boolean }) {
  return <div><div className="text-[12px] text-[var(--color-text-secondary)]">{label}</div><div title={title} className={`${primary ? 'text-[21px]' : 'text-[17px]'} font-semibold tabular-nums`}>{value}</div></div>
}
function SourceDatum({ label, value }: { label: string; value: string }) {
  return <div><dt className="text-[12px] text-[var(--color-text-secondary)]">{label}</dt><dd className="mt-0.5 break-all font-medium">{value}</dd></div>
}
