'use client'

import Link from 'next/link'
import { AlertTriangle, DatabaseZap, RefreshCw } from 'lucide-react'
import type { ReactNode } from 'react'
import { CLASS_LABEL, date, type ClassFilter, type ResponseMeta } from '@/lib/large-holders/ui'
import type { Completeness, InvestorClass } from '@/lib/large-holders/ranking-core'

export class HolderFetchError extends Error {
  constructor(public readonly reason: string, public readonly status: number) { super(reason) }
}

export async function holderFetch<T>(url: string, signal: AbortSignal): Promise<T> {
  const response = await fetch(url, { signal, cache: 'no-store' })
  const payload = await response.json().catch(() => ({})) as { error?: string }
  if (!response.ok) throw new HolderFetchError(payload.error ?? 'unknown_error', response.status)
  return payload as T
}

export function HolderError({ error, retry }: { error: HolderFetchError | Error; retry: () => void }) {
  const stale = error instanceof HolderFetchError && error.reason === 'certified_snapshot_stale'
  const storage = error instanceof HolderFetchError && [
    'certified_snapshot_not_configured', 'certified_snapshot_missing', 'snapshot_digest_mismatch',
    'large_holder_read_model_unavailable',
  ].includes(error.reason)
  return <section role="alert" className="border-y border-[var(--border-subtle)] bg-white px-4 py-12 text-center">
    <div className="mx-auto mb-2 w-fit text-[var(--color-text-secondary)]">{storage ? <DatabaseZap size={22} /> : <AlertTriangle size={22} />}</div>
    <h2 className="text-[18px] font-semibold">{stale ? '最新データの再集計が必要です'
      : storage ? '大口投資家データを安全に読み込めません' : 'データを読み込めませんでした'}</h2>
    <p className="mt-2 text-[13px] text-[var(--color-text-secondary)]">{stale
      ? '開示または株価が認定済みSnapshotより更新されました。古い順位は表示しません。'
      : storage ? '保存領域または認定済みSnapshotを確認してください。古いデータへの自動切替は行いません。'
        : '時間をおいて再試行してください。'}</p>
    <button type="button" onClick={retry} className="mt-4 inline-flex items-center gap-2 border border-[var(--border-subtle)] px-3 py-1.5 text-[13px] font-semibold hover:bg-slate-50"><RefreshCw size={14} />再試行</button>
  </section>
}

export function HolderSkeleton() {
  return <div role="status" aria-label="読み込み中" className="animate-pulse space-y-3 py-6">
    <div className="h-5 w-2/5 bg-slate-200" />
    <div className="h-9 bg-slate-100" />
    {[0, 1, 2, 3, 4].map((item) => <div key={item} className="h-12 bg-slate-100" />)}
  </div>
}

export function ClassBadge({ investorClass, investorType }: { investorClass: InvestorClass; investorType?: string }) {
  const tone = investorClass === 'INDIVIDUAL' ? 'bg-emerald-50 text-emerald-800'
    : investorClass === 'INSTITUTIONAL' ? 'bg-sky-50 text-sky-800' : 'bg-slate-100 text-slate-700'
  return <span className={`inline-flex whitespace-nowrap px-1.5 py-0.5 text-[12px] font-medium ${tone}`} title={investorType ?? CLASS_LABEL[investorClass]}>{CLASS_LABEL[investorClass]}</span>
}

export function CompletenessBadge({ completeness, valued, total }: {
  completeness: Completeness; valued: number; total: number
}) {
  const label = completeness === 'COMPLETE' ? '完全算定' : completeness === 'PARTIAL' ? '一部算定' : '算定不可'
  return <span title={`算定可能 ${valued} / ${total}銘柄`} className={`whitespace-nowrap text-[12px] font-medium ${completeness === 'COMPLETE' ? 'text-emerald-800' : 'text-amber-800'}`}>
    {label}<span className="ml-1 font-normal text-[var(--color-text-secondary)]">{valued}/{total}</span>
  </span>
}

export function AsOfLine({ meta }: { meta: ResponseMeta }) {
  return <div className="text-[12px] text-[var(--color-text-secondary)]">
    {meta.snapshotStatus === 'VALIDATED_WITH_QUARANTINE' && <details className="mb-2 border-l-2 border-amber-500 pl-2 text-amber-900">
      <summary className="cursor-pointer">最新開示のうち{meta.quarantinedDocumentCount}件は原資料内の不整合により集計対象外です</summary>
      <ul className="mt-1 space-y-0.5">{meta.quarantines?.map((item) => <li key={item.documentId}>
        {item.documentId} / {item.issuerName ?? item.ticker} / {item.reasonCode}
      </li>)}</ul>
    </details>}
    <div className="flex flex-wrap gap-x-5 gap-y-1">
    <span>保有情報 <strong className="font-medium text-[var(--color-text-primary)]">{date(meta.latestPositionDate ?? meta.certificationAsOf)}</strong> 直近開示ベース</span>
    <span>価格 <strong className="font-medium text-[var(--color-text-primary)]">{date(meta.priceDate)}</strong> 終値</span>
    <span>認定 <strong className="font-medium text-[var(--color-text-primary)]">{date(meta.certificationAsOf)}</strong></span>
    <span>EDINET最終提出 <strong className="font-medium text-[var(--color-text-primary)]">{meta.latestEdinetDataAt ? new Date(meta.latestEdinetDataAt).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' }) : '—'}</strong></span>
    <span>Snapshot生成 <strong className="font-medium text-[var(--color-text-primary)]">{meta.snapshotGeneratedAt ? new Date(meta.snapshotGeneratedAt).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' }) : '—'}</strong></span>
    </div>
  </div>
}

export function HolderDisclaimer() {
  return <p className="border-t border-[var(--border-subtle)] pt-3 text-[12px] leading-relaxed text-[var(--color-text-secondary)]">
    本ランキングは大量保有報告書で確認可能な直近開示ポジションを基にした参考値です。5%未満の保有等は含まれない場合があります。原資料内の不整合により認定できない開示は集計対象外となる場合があります。推定時価は取得原価や実際の投資元本を示しません。
  </p>
}

export function HolderPageHeader({ title, subtitle, children }: { title: string; subtitle?: string; children?: ReactNode }) {
  return <header className="flex flex-wrap items-end justify-between gap-3 border-b border-[var(--border-subtle)] pb-3">
    <div><h1 className="text-[24px] font-semibold leading-tight">{title}</h1>{subtitle && <p className="mt-1 text-[13px] text-[var(--color-text-secondary)]">{subtitle}</p>}</div>
    <nav aria-label="大口投資家の画面" className="flex flex-wrap gap-1 text-[13px] font-medium">
      <Link className="px-2 py-1 hover:text-[var(--color-brand-600)]" href="/large-holders">概要</Link>
      <Link className="px-2 py-1 hover:text-[var(--color-brand-600)]" href="/large-holders/rankings">ランキング</Link>
      <Link className="px-2 py-1 hover:text-[var(--color-brand-600)]" href="/large-holders/activity">保有変化</Link>
    </nav>{children}
  </header>
}

export function TableScroll({ children }: { children: ReactNode }) {
  return <div className="max-w-full overflow-x-auto border-y border-[var(--border-subtle)] bg-white">{children}</div>
}

export const th = 'sticky top-0 z-10 whitespace-nowrap border-b border-[var(--border-subtle)] bg-slate-50 px-3 py-2 text-left text-[12px] font-semibold text-[var(--color-text-secondary)]'
export const td = 'whitespace-nowrap border-b border-[var(--border-subtle)] px-3 py-2.5 text-[13px]'
export const numeric = 'text-right tabular-nums'

export function TablePager({ page, totalPages, total, go }: { page: number; totalPages: number; total: number; go: (page: number) => void }) {
  return <div className="flex items-center justify-end gap-3 py-3 text-[13px] text-[var(--color-text-secondary)]">
    <span>{total}件</span><button type="button" disabled={page <= 1} onClick={() => go(page - 1)} className="disabled:opacity-40">前へ</button>
    <span className="tabular-nums">{page} / {Math.max(1, totalPages)}</span>
    <button type="button" disabled={page >= totalPages} onClick={() => go(page + 1)} className="disabled:opacity-40">次へ</button>
  </div>
}

export function Segmented<T extends string>({ label, value, options, onChange }: {
  label: string; value: T; options: { value: T; label: string }[]; onChange: (next: T) => void
}) {
  return <div role="group" aria-label={label} className="inline-flex max-w-full flex-wrap gap-1 border-b border-[var(--border-subtle)]">
    {options.map((option) => <button key={option.value} type="button" aria-pressed={option.value === value}
      onClick={() => onChange(option.value)}
      className={`border-b-2 px-3 py-2 text-[13px] font-medium ${option.value === value
        ? 'border-[var(--color-brand-600)] text-[var(--color-brand-600)]' : 'border-transparent text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]'}`}>
      {option.label}
    </button>)}
  </div>
}

export const CLASS_OPTIONS: { value: ClassFilter; label: string }[] = [
  { value: 'ALL', label: 'すべて' }, { value: 'INDIVIDUAL', label: '個人' }, { value: 'INSTITUTIONAL', label: '機関' },
]
