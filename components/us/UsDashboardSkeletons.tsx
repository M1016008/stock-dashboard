// components/us/UsDashboardSkeletons.tsx
//
// 米国株 Dashboard の読み込み中プレースホルダーとセクション定義。
// 完成形と同じ骨組み (罫線・列・行の高さ) を描き、データが入ったときのずれを抑える。
// サーバー専用の依存を持たないこと (日付切替中ビュー = クライアントからも使うため)。

import {
  AgendaSkeleton,
  DashboardSectionFallback,
  MarketStateSkeleton,
} from '@/components/dashboard/DashboardSectionFallback'
import { SkeletonBlock } from '@/components/dashboard/DashboardPrimitives'

export const US_DASHBOARD_SECTION_META = {
  'us-movers': { label: '値動き', description: '前営業日比の上昇・下落と出来高の上位（株式のみ）' },
  'us-signals': { label: '売買候補', description: 'シナリオを集約した買う/売る候補' },
  'us-ml': { label: '物理ML候補', description: '20営業日先の上昇候補と下落警戒。売買推奨ではありません' },
} as const

export type UsDashboardSectionId = keyof typeof US_DASHBOARD_SECTION_META

export const US_DASHBOARD_SECTION_ORDER: UsDashboardSectionId[] = ['us-movers', 'us-signals', 'us-ml']

/** 値動きレーン・ML 一覧と同じ行の骨組み (順位 / 銘柄 2 段 / 数値) */
function TickerRowsSkeleton({ rows, mobileRows }: { rows: number; mobileRows: number }) {
  return (
    <div>
      {Array.from({ length: rows }, (_, index) => (
        <div
          key={index}
          className={`grid grid-cols-[16px_minmax(0,1fr)_4.5rem] items-center gap-x-2 border-t border-[var(--color-border-soft)] py-2 ${index >= mobileRows ? 'max-md:hidden' : ''}`}
        >
          <SkeletonBlock className="h-2.5 w-3" />
          <div className="grid gap-1.5">
            <SkeletonBlock className={`h-3 ${index % 3 === 0 ? 'w-3/5' : index % 3 === 1 ? 'w-4/5' : 'w-2/3'}`} />
            <SkeletonBlock className="h-2.5 w-2/5" />
          </div>
          <div className="grid justify-items-end gap-1.5">
            <SkeletonBlock className="h-3 w-14" />
            <SkeletonBlock className="h-2.5 w-10" />
          </div>
        </div>
      ))}
    </div>
  )
}

export function UsMoversSkeleton() {
  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-y-5 md:grid-cols-2 md:gap-x-6 lg:grid-cols-3">
      {Array.from({ length: 3 }, (_, lane) => (
        <div key={lane} className={`min-w-0 border-t-2 border-[var(--color-border-default)] ${lane === 2 ? 'md:col-span-2 lg:col-span-1' : ''}`}>
          <SkeletonBlock className="my-2.5 h-3 w-24" />
          <TickerRowsSkeleton rows={8} mobileRows={5} />
        </div>
      ))}
    </div>
  )
}

export function UsMlSkeleton() {
  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-x-8 gap-y-6 md:grid-cols-2">
      {[0, 1].map((panel) => (
        <div key={panel} className="min-w-0 border-t-2 border-[var(--color-border-default)]">
          <SkeletonBlock className="my-2.5 h-3 w-28" />
          <TickerRowsSkeleton rows={8} mobileRows={8} />
        </div>
      ))}
    </div>
  )
}

function SectionBodySkeleton({ section, caption }: { section: UsDashboardSectionId; caption?: string }) {
  if (section === 'us-signals') {
    return <DashboardSectionFallback section="signals" caption={caption} quiet={caption != null} />
  }
  const text = caption ?? `${US_DASHBOARD_SECTION_META[section].label}を読み込み中`
  return (
    <div role={caption != null ? undefined : 'status'} aria-live={caption != null ? undefined : 'polite'} className="min-w-0">
      <span className="sr-only">{text}</span>
      <div className="motion-safe:animate-pulse" aria-hidden="true">
        {section === 'us-movers' ? <UsMoversSkeleton /> : <UsMlSkeleton />}
      </div>
    </div>
  )
}

/** Suspense の fallback 用 (セクション見出しは DashboardWorkspace が描く) */
export function UsDashboardSectionFallback({ section }: { section: UsDashboardSectionId }) {
  return <SectionBodySkeleton section={section} />
}

/** 「今日の市場 / この日の市場」全体の骨組み */
export function UsMarketBriefSkeleton({ caption, historical = false }: { caption?: string; historical?: boolean }) {
  return (
    <section className="overflow-hidden rounded-[var(--radius-card)] border border-[var(--color-border-default)] border-t-[3px] border-t-[var(--color-brand-900)] bg-white">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-b border-[var(--color-border-soft)] px-4 py-2">
        <span className="text-[14px] font-bold text-[var(--color-brand-900)]">{historical ? 'この日の市場' : '今日の市場'}</span>
        {caption && <span className="text-[11px] font-semibold text-[var(--color-text-tertiary)]">{caption}</span>}
      </div>
      <MarketStateSkeleton />
      <div className="grid border-t border-[var(--color-border-default)] bg-[var(--color-surface-subtle)] md:grid-cols-3">
        <AgendaSkeleton />
        <AgendaSkeleton bordered />
        <AgendaSkeleton bordered />
      </div>
    </section>
  )
}

/** 日付切替中の本文。完成形と同じ並び (01〜03) の骨組みだけを出す。targetLabel は「最新」「2026-10-01 時点」など */
export function UsDashboardPendingSections({ targetLabel }: { targetLabel: string }) {
  return (
    <div className="flex flex-col gap-10 pt-11">
      {US_DASHBOARD_SECTION_ORDER.map((id, index) => (
        <section key={id} className="min-w-0">
          <div className="mb-4 flex items-center gap-3 border-b-2 border-[var(--color-border-default)] pb-1.5">
            <span className="font-mono text-[11px] font-bold tabular-nums text-[var(--color-text-tertiary)]">{String(index + 1).padStart(2, '0')}</span>
            <span className="text-[16px] font-bold leading-tight text-[var(--color-brand-900)]">{US_DASHBOARD_SECTION_META[id].label}</span>
            <span className="hidden text-[11px] font-semibold text-[var(--color-text-tertiary)] md:inline">{US_DASHBOARD_SECTION_META[id].description}</span>
            <span className="ml-auto h-7" aria-hidden="true" />
          </div>
          <SectionBodySkeleton section={id} caption={`${targetLabel}の${US_DASHBOARD_SECTION_META[id].label}を確認中`} />
        </section>
      ))}
    </div>
  )
}
