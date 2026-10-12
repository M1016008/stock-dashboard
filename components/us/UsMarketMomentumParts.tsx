// components/us/UsMarketMomentumParts.tsx
//
// /us/market-momentum と /us/sectors で共有する表示部品。
// - 値は lib/server/us-market-intelligence の結果をそのまま整形するだけで、再計算しない
// - 取引所・SEC SIC は現在の登録値しかないため、過去日では呼び出し側で表示しない
// - リンクは same-origin の相対パスのみ

import Link from 'next/link'
import { History } from 'lucide-react'
import { StageTag } from '@/components/ui/StageTag'
import type { UsMarketMomentumRow } from '@/lib/server/us-market-intelligence'

/* ---------- 日付 ---------- */

export type UsDateParam =
  | { kind: 'none' }
  | { kind: 'valid'; date: string }
  | { kind: 'invalid'; raw: string }

/** ?date=YYYY-MM-DD だけを受け付ける。複数指定・実在しない日付は不正として扱い、黙って最新へ落とさない */
export function parseUsDateParam(value: string | string[] | undefined): UsDateParam {
  if (value == null) return { kind: 'none' }
  const raw = (Array.isArray(value) ? value.join(',') : value).trim()
  if (!raw) return { kind: 'none' }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return { kind: 'invalid', raw }
  const parsed = new Date(`${raw}T00:00:00Z`)
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== raw) return { kind: 'invalid', raw }
  return { kind: 'valid', date: raw }
}

export function firstParam(value: string | string[] | undefined): string | null {
  return Array.isArray(value) ? value[0] ?? null : value ?? null
}

/* ---------- 書式 ---------- */

export function fmtUsd(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '—'
  return `$${value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: value < 1 ? 4 : 2 })}`
}

export function fmtPct(value: number | null | undefined, digits = 2): string {
  if (value == null || !Number.isFinite(value)) return '—'
  return `${value > 0 ? '+' : ''}${value.toFixed(digits)}%`
}

export function fmtScore(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '—'
  return `${value > 0 ? '+' : ''}${value.toFixed(2)}`
}

export function fmtRatio(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '—'
  return `${value.toFixed(1)}%`
}

/** 出来高は米国株の慣習どおり K / M / B (単位は株) */
export function fmtVolume(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '—'
  if (value >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(2)}B`
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`
  if (value >= 1_000) return `${Math.round(value / 1_000).toLocaleString('en-US')}K`
  return Math.round(value).toLocaleString('en-US')
}

export function fmtCount(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '—'
  return value.toLocaleString('en-US')
}

/** 割合 (表示用)。件数は契約の値をそのまま使い、分母 0 は欠損にする */
export function share(part: number, total: number): number | null {
  return total > 0 ? (part / total) * 100 : null
}

export function signedClass(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return 'text-[var(--color-text-tertiary)]'
  if (value > 0) return 'text-[var(--color-price-up)]'
  if (value < 0) return 'text-[var(--color-price-down)]'
  return 'text-[var(--color-text-secondary)]'
}

/* ---------- リンク ---------- */

export function usStockHref(ticker: string, date: string | null): string {
  return `/us/stock/${encodeURIComponent(ticker)}${date ? `?date=${encodeURIComponent(date)}` : ''}`
}

/** /us/screener の既存クエリ (sort, dir, pmsMin, pfsMin, exchange, sector, industryGroup, industry, date) だけを使う */
export function usScreenerHref(params: Record<string, string | null | undefined>, date: string | null = null): string {
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value != null && value !== '') search.set(key, value)
  }
  if (date) search.set('date', date)
  const query = search.toString()
  return `/us/screener${query ? `?${query}` : ''}`
}

/* ---------- SEC broad sector の短縮名 (表示専用) ---------- */

const SEC_SECTOR_SHORT: Record<string, string> = {
  AGR: 'Agriculture',
  MINING: 'Mining',
  CONSTRUCTION: 'Construction',
  MANUFACTURING: 'Manufacturing',
  TRANSPORT_UTIL: 'Transport & Utilities',
  WHOLESALE: 'Wholesale',
  RETAIL: 'Retail',
  FINANCE: 'Finance & Real Estate',
  SERVICES: 'Services',
  PUBLIC_ADMIN: 'Public Admin',
  UNKNOWN: 'SIC不明',
}

export function secSectorShort(code: string | null | undefined, label: string | null | undefined): string {
  if (code && SEC_SECTOR_SHORT[code]) return SEC_SECTOR_SHORT[code]
  return label ?? '—'
}

/** SEC 登録に SIC がない銘柄の受け皿。分類済みに数えられるが、業種としては読まない */
export const UNKNOWN_SECTOR_CODE = 'UNKNOWN'

/* ---------- 6ステージ ---------- */

const STAGE_AXES = [
  ['日A', 'dailyAStage'],
  ['日B', 'dailyBStage'],
  ['週A', 'weeklyAStage'],
  ['週B', 'weeklyBStage'],
  ['月A', 'monthlyAStage'],
  ['月B', 'monthlyBStage'],
] as const

export function StageStrip({ row }: { row: UsMarketMomentumRow }) {
  const label = STAGE_AXES.map(([name, key]) => `${name}${row[key] ?? '−'}`).join(' ')
  return (
    <span className="inline-flex shrink-0 items-center gap-0.5 whitespace-nowrap" aria-label={`6ステージ ${label}`} title={label}>
      {STAGE_AXES.map(([name, key]) => (
        <StageTag key={name} stage={row[key]} size="xs" />
      ))}
    </span>
  )
}

/* ---------- 分類の開示 ---------- */

/** SEC SIC は GICS ではなく、現在の登録値。過去日の分類 (PIT) ではないことを短く示す */
export function UsSecSicDisclosure({ className = '' }: { className?: string }) {
  return (
    <p
      className={`text-[11px] leading-relaxed text-[var(--color-text-tertiary)] ${className}`}
    >
      <strong className="font-semibold text-[var(--color-text-secondary)]">SEC SIC current classification</strong>
      ：SEC EDGAR に登録された現在の SIC コードによる分類です。GICS ではなく、過去時点の分類（historical PIT）でもないため、最新日のみ集計します。
    </p>
  )
}

/* ---------- 過去日の基準帯 ---------- */

export function UsAsOfBanner({
  requestedDate,
  resolvedDate,
  latestDate,
  shown,
  hidden,
  note,
}: {
  requestedDate: string | null
  resolvedDate: string
  latestDate: string | null
  shown: string[]
  hidden: string[]
  note?: React.ReactNode
}) {
  const adjusted = requestedDate != null && requestedDate !== resolvedDate
  const dates = [
    { label: 'AS OF（米国市場日）', value: `${resolvedDate} 終値`, strong: true },
    { label: '指定日', value: requestedDate ?? '—', strong: false },
    { label: '最新データ日', value: latestDate ?? '—', strong: false },
  ]
  return (
    <section
      role="note"
      aria-label="過去日表示の基準"
      className="overflow-hidden rounded-[var(--radius-card)] border border-[var(--color-border-default)] border-l-[4px] border-l-[var(--color-market-amber)] bg-white"
    >
      <div className="grid gap-x-8 gap-y-2 px-4 py-3 lg:grid-cols-[auto_minmax(0,1fr)] lg:items-center">
        <div className="flex items-center gap-2 text-[14px] font-bold text-[var(--color-brand-900)]">
          <History size={16} aria-hidden="true" className="text-[#b45309]" />
          過去日を表示中
        </div>
        <dl className="grid grid-cols-1 gap-x-8 gap-y-1.5 sm:grid-cols-3">
          {dates.map((item) => (
            <div key={item.label} className="min-w-0">
              <dt className="text-[10px] font-semibold text-[var(--color-text-tertiary)]">{item.label}</dt>
              <dd className={`font-mono tabular-nums ${item.strong ? 'text-[15px] font-bold text-[var(--color-text-primary)]' : 'text-[13px] font-semibold text-[var(--color-text-secondary)]'}`}>
                {item.value}
              </dd>
            </div>
          ))}
        </dl>
      </div>
      {adjusted && (
        <p className="border-t border-[var(--color-border-soft)] px-4 py-2 text-[12px] font-semibold text-[#92400e]">
          指定日 <span className="font-mono tabular-nums">{requestedDate}</span> は PMS 算出済みの米国市場データがないため（休場日・週末など）、直前の取引日 <span className="font-mono tabular-nums">{resolvedDate}</span> で表示しています。
        </p>
      )}
      <div className="grid gap-x-8 gap-y-2 border-t border-[var(--color-border-soft)] bg-[var(--color-surface-subtle)] px-4 py-2.5 md:grid-cols-2">
        <div className="min-w-0">
          <div className="text-[10px] font-semibold text-[var(--color-text-tertiary)]">この日付で表示</div>
          <div className="mt-0.5 text-[12px] font-bold text-[var(--color-text-primary)]">{shown.join(' · ')}</div>
        </div>
        <div className="min-w-0">
          <div className="text-[10px] font-semibold text-[var(--color-text-tertiary)]">表示・集計・絞り込みに使わない（現在の登録値のみで、当時の分類ではないため）</div>
          <div className="mt-0.5 text-[12px] font-bold text-[var(--color-text-secondary)]">{hidden.join(' · ')}</div>
        </div>
      </div>
      {note && (
        <p className="border-t border-[var(--color-border-soft)] px-4 py-2 text-[11px] font-semibold leading-relaxed text-[var(--color-text-tertiary)]">{note}</p>
      )}
    </section>
  )
}

/* ---------- 日付指定 (JS なしで動く GET フォーム) ---------- */

export function UsDateForm({
  action,
  date,
  latestDate,
  isLatest,
  hidden = {},
}: {
  action: string
  date: string | null
  latestDate: string | null
  isLatest: boolean
  hidden?: Record<string, string | null | undefined>
}) {
  const latestHref = (() => {
    const search = new URLSearchParams()
    for (const [key, value] of Object.entries(hidden)) if (value) search.set(key, value)
    const query = search.toString()
    return `${action}${query ? `?${query}` : ''}`
  })()
  return (
    <form action={action} method="get" className="toolbar" aria-label="基準日">
      {Object.entries(hidden).map(([key, value]) => (value ? <input key={key} type="hidden" name={key} value={value} /> : null))}
      <label className="flex items-center gap-2 text-[12px] font-semibold text-[var(--color-text-secondary)]">
        基準日
        <input
          type="date"
          name="date"
          defaultValue={date ?? ''}
          max={latestDate ?? undefined}
          className="h-8 rounded-[4px] border border-[var(--color-border-default)] bg-white px-2 font-mono text-[12px] tabular-nums text-[var(--color-text-primary)]"
        />
      </label>
      <button type="submit" className="btn" data-size="sm">表示</button>
      {!isLatest && (
        <Link href={latestHref} prefetch={false} className="btn" data-size="sm" data-variant="ghost">
          最新日へ戻る
        </Link>
      )}
    </form>
  )
}
