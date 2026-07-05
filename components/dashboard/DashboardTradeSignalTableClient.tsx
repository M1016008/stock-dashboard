'use client'

import Link from 'next/link'
import { useMemo, useState } from 'react'
import { StageTag } from '@/components/ui/StageTag'
import type {
  DashboardTradeSignalMarket,
  DashboardTradeSignalResult,
  DashboardTradeSignalRow,
  DashboardTradeSignalSide,
} from '@/lib/queries/dashboard-trade-signals'

type SideFilter = 'all' | DashboardTradeSignalSide
type MarketFilter = 'all' | DashboardTradeSignalMarket
type SortKey = 'confidence' | 'avgVolume' | 'industry' | 'changePct' | 'pms' | 'pfs' | 'physicalStatus'

const SORT_OPTIONS: { value: SortKey; label: string }[] = [
  { value: 'confidence', label: '確度スコア' },
  { value: 'avgVolume', label: '平均出来高' },
  { value: 'industry', label: '業種' },
  { value: 'changePct', label: '騰落率' },
  { value: 'pms', label: 'PMS' },
  { value: 'pfs', label: 'PFS' },
  { value: 'physicalStatus', label: '物理状態' },
]

function fmtNumber(value: number | null | undefined, digits = 2): string {
  if (value == null || !Number.isFinite(value)) return '-'
  return value.toLocaleString('ja-JP', { maximumFractionDigits: digits })
}

function fmtCompact(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '-'
  if (value >= 100_000_000) return `${(value / 100_000_000).toFixed(1)}億`
  if (value >= 10_000) return `${(value / 10_000).toFixed(1)}万`
  return value.toLocaleString('ja-JP', { maximumFractionDigits: 0 })
}

function fmtPct(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '-'
  return `${value >= 0 ? '+' : ''}${value.toFixed(2)}%`
}

function sideLabel(side: DashboardTradeSignalSide): string {
  return side === 'buy' ? '買い候補' : '空売り候補'
}

function sideToneClass(side: DashboardTradeSignalSide): string {
  return side === 'buy'
    ? 'border-[rgba(220,38,38,0.22)] bg-[rgba(254,226,226,0.72)] text-[var(--color-price-up)]'
    : 'border-[rgba(37,99,235,0.24)] bg-[rgba(219,234,254,0.76)] text-[var(--color-price-down)]'
}

function scoreClass(score: number): string {
  if (score >= 75) return 'bg-[var(--color-brand-900)] text-white'
  return 'bg-[var(--color-surface-subtle)] text-[var(--color-brand-900)]'
}

function labelClass(row: DashboardTradeSignalRow): string {
  if (row.side === 'short') return 'bg-[rgba(37,99,235,0.09)] text-[var(--color-price-down)] border-[rgba(37,99,235,0.2)]'
  if (row.shortTermCheckLabel === '強気優勢') return 'bg-[rgba(220,38,38,0.09)] text-[var(--color-price-up)] border-[rgba(220,38,38,0.2)]'
  if (row.shortTermCheckLabel === '好転候補') return 'bg-[rgba(245,158,11,0.12)] text-[#b45309] border-[rgba(245,158,11,0.24)]'
  return 'bg-[var(--color-surface-subtle)] text-[var(--color-text-secondary)] border-[var(--color-border-soft)]'
}

function signedClass(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return 'text-[var(--color-text-tertiary)]'
  if (value > 0) return 'text-[var(--color-price-up)]'
  if (value < 0) return 'text-[var(--color-price-down)]'
  return 'text-[var(--color-text-secondary)]'
}

function sortValue(row: DashboardTradeSignalRow, sort: SortKey): number | string {
  switch (sort) {
    case 'avgVolume': return row.avgVolume ?? -Infinity
    case 'industry': return row.industryName
    case 'changePct': return row.changePct ?? -Infinity
    case 'pms': return row.pms ?? -Infinity
    case 'pfs': return row.pfs ?? -Infinity
    case 'physicalStatus': return row.physicalStatusScore ?? -Infinity
    case 'confidence':
    default:
      return row.confidenceScore
  }
}

function compareRows(a: DashboardTradeSignalRow, b: DashboardTradeSignalRow, sort: SortKey): number {
  const av = sortValue(a, sort)
  const bv = sortValue(b, sort)
  if (typeof av === 'string' || typeof bv === 'string') {
    const cmp = String(av).localeCompare(String(bv), 'ja')
    if (cmp !== 0) return cmp
    return b.confidenceScore - a.confidenceScore
  }
  if (av !== bv) return Number(bv) - Number(av)
  return a.ticker.localeCompare(b.ticker)
}

function StageStrip({ row }: { row: DashboardTradeSignalRow }) {
  const stages = [
    ['日A', row.stages.dailyA],
    ['日B', row.stages.dailyB],
    ['週A', row.stages.weeklyA],
    ['週B', row.stages.weeklyB],
    ['月A', row.stages.monthlyA],
    ['月B', row.stages.monthlyB],
  ] as const
  return (
    <div className="flex items-center gap-1 whitespace-nowrap">
      {stages.map(([label, stage]) => (
        <span key={label} className="inline-flex items-center gap-0.5 rounded-full border border-[var(--color-border-soft)] bg-white px-1 py-0.5">
          <span className="text-[8px] font-black text-[var(--color-text-tertiary)]">{label}</span>
          <StageTag stage={stage} size="xs" />
        </span>
      ))}
    </div>
  )
}

function SignalRow({ row, index }: { row: DashboardTradeSignalRow; index: number }) {
  return (
    <tr className="border-b border-[var(--color-border-soft)] last:border-0 hover:bg-[var(--color-surface-subtle)]">
      <td className="px-3 py-3 align-top">
        <div className="font-mono text-[12px] font-black text-[var(--color-text-tertiary)]">{index + 1}</div>
      </td>
      <td className="px-3 py-3 align-top">
        <div className={`inline-flex whitespace-nowrap rounded-full border px-2 py-1 text-[11px] font-black ${sideToneClass(row.side)}`}>
          {sideLabel(row.side)}
        </div>
        <div className="mt-1 text-[10px] font-bold text-[var(--color-text-tertiary)]">{row.market}</div>
      </td>
      <td className="min-w-[220px] px-3 py-3 align-top">
        <div className="flex min-w-0 items-center gap-2">
          <Link href={row.href} prefetch={false} className="font-mono text-[13px] font-black text-[var(--color-brand-800)] hover:underline">
            {row.ticker}
          </Link>
          <span className="truncate text-[12px] font-bold text-[var(--color-text-primary)]">{row.name}</span>
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[10px] font-bold text-[var(--color-text-tertiary)]">
          <span>{row.marketSegment ?? '市場未分類'}</span>
          {row.marginType && <span>{row.marginType}</span>}
        </div>
      </td>
      <td className="px-3 py-3 align-top">
        <div className={`inline-flex min-w-[46px] justify-center rounded-full px-2 py-1 font-mono text-[13px] font-black ${scoreClass(row.confidenceScore)}`}>
          {row.confidenceScore}
        </div>
        <div className="mt-1 text-[10px] font-bold text-[var(--color-text-tertiary)]">
          {row.confidenceBand === 'high' ? '高確度' : '候補'}
        </div>
      </td>
      <td className="min-w-[150px] px-3 py-3 align-top">
        <span className={`inline-flex rounded-full border px-2 py-1 text-[11px] font-black ${labelClass(row)}`}>
          {row.primaryLabel}
        </span>
        <div className="mt-1 text-[10px] font-bold text-[var(--color-text-tertiary)]">{row.physicalStatusLabel}</div>
      </td>
      <td className="min-w-[140px] px-3 py-3 align-top">
        <div className="text-[12px] font-bold text-[var(--color-text-primary)]">{row.industryName}</div>
        {row.industryDetail && row.industryDetail !== row.industryName && (
          <div className="mt-1 text-[10px] font-bold text-[var(--color-text-tertiary)]">{row.industryDetail}</div>
        )}
      </td>
      <td className="px-3 py-3 text-right align-top">
        <div className="font-mono text-[12px] font-black text-[var(--color-text-primary)]">{fmtCompact(row.avgVolume)}</div>
        <div className="mt-1 text-[10px] font-bold text-[var(--color-text-tertiary)]">{row.avgVolumeLabel}</div>
      </td>
      <td className="px-3 py-3 text-right align-top">
        <div className="font-mono text-[12px] font-black text-[var(--color-text-primary)]">{fmtNumber(row.price, row.market === 'US' ? 2 : 1)}</div>
        <div className={`mt-1 font-mono text-[11px] font-black ${signedClass(row.changePct)}`}>{fmtPct(row.changePct)}</div>
      </td>
      <td className="min-w-[210px] px-3 py-3 align-top">
        <StageStrip row={row} />
        <div className="mt-1 grid grid-cols-3 gap-1 font-mono text-[10px] font-black">
          <span className={signedClass(row.pms)}>PMS {fmtNumber(row.pms, 2)}</span>
          <span className={signedClass(row.pfs)}>PFS {fmtNumber(row.pfs, 2)}</span>
          <span className={signedClass(row.pes)}>PES {fmtNumber(row.pes, 2)}</span>
        </div>
      </td>
      <td className="min-w-[220px] px-3 py-3 align-top">
        <div className="flex flex-wrap gap-1">
          {row.evidenceChips.map((chip) => (
            <span key={chip} className="rounded-full bg-[var(--color-surface-subtle)] px-2 py-0.5 text-[10px] font-black text-[var(--color-brand-900)]">
              {chip}
            </span>
          ))}
        </div>
        {row.riskChips.length > 0 && (
          <div className="mt-1 flex flex-wrap gap-1">
            {row.riskChips.map((chip) => (
              <span key={chip} className="rounded-full bg-[#fff7ed] px-2 py-0.5 text-[10px] font-black text-[#b45309]">
                {chip}
              </span>
            ))}
          </div>
        )}
      </td>
    </tr>
  )
}

export function DashboardTradeSignalTableClient({ data }: { data: DashboardTradeSignalResult }) {
  const [side, setSide] = useState<SideFilter>('all')
  const [market, setMarket] = useState<MarketFilter>('all')
  const [industry, setIndustry] = useState('all')
  const [minVolume, setMinVolume] = useState('0')
  const [sort, setSort] = useState<SortKey>('confidence')

  const industries = useMemo(() => {
    const values = new Set<string>()
    for (const row of data.rows) values.add(row.industryName)
    return Array.from(values).sort((a, b) => a.localeCompare(b, 'ja'))
  }, [data.rows])

  const filteredRows = useMemo(() => {
    const min = Number(minVolume)
    return data.rows
      .filter((row) => side === 'all' || row.side === side)
      .filter((row) => market === 'all' || row.market === market)
      .filter((row) => industry === 'all' || row.industryName === industry)
      .filter((row) => !Number.isFinite(min) || min <= 0 || (row.avgVolume ?? 0) >= min)
      .sort((a, b) => compareRows(a, b, sort))
  }, [data.rows, industry, market, minVolume, side, sort])
  const visibleRows = filteredRows.slice(0, 60)

  const buyCount = data.rows.filter((row) => row.side === 'buy').length
  const shortCount = data.rows.filter((row) => row.side === 'short').length
  const highCount = data.rows.filter((row) => row.confidenceBand === 'high').length

  return (
    <section className="rounded-[8px] border border-[var(--color-border-default)] bg-white p-4 shadow-[var(--shadow-card)]">
      <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-[15px] font-bold text-[var(--color-brand-900)]">高確度 売買候補</h2>
            <span className="rounded-full border border-[var(--color-border-soft)] bg-[var(--color-surface-subtle)] px-2 py-0.5 text-[10px] font-black text-[var(--color-text-secondary)]">
              {data.horizonDays}営業日目線
            </span>
          </div>
          <p className="mt-1 max-w-[820px] text-[11px] font-semibold leading-relaxed text-[var(--color-text-tertiary)]">
            既存の短期チェック、物理ステータス、PMS/PFS/PES、6ステージ、ML候補、平均出来高を合成した候補一覧です。表示は売買助言ではなく、データに基づく監視候補です。
          </p>
        </div>
        <div className="flex flex-wrap gap-2 text-[11px] font-black">
          <span className="rounded-full bg-[rgba(254,226,226,0.75)] px-2.5 py-1 text-[var(--color-price-up)]">買い {buyCount}</span>
          <span className="rounded-full bg-[rgba(219,234,254,0.82)] px-2.5 py-1 text-[var(--color-price-down)]">空売り {shortCount}</span>
          <span className="rounded-full bg-[var(--color-brand-900)] px-2.5 py-1 text-white">高確度 {highCount}</span>
        </div>
      </div>

      <div className="mb-3 grid gap-2 rounded-[8px] border border-[var(--color-border-soft)] bg-[var(--color-surface-subtle)] p-3 md:grid-cols-5">
        <label className="grid gap-1 text-[11px] font-bold text-[var(--color-text-secondary)]">
          候補
          <select value={side} onChange={(event) => setSide(event.target.value as SideFilter)} className="rounded-[6px] border border-[var(--color-border-default)] bg-white px-2 py-2 text-[12px] font-bold text-[var(--color-text-primary)]">
            <option value="all">買い・空売り</option>
            <option value="buy">買い候補</option>
            <option value="short">空売り候補</option>
          </select>
        </label>
        <label className="grid gap-1 text-[11px] font-bold text-[var(--color-text-secondary)]">
          市場
          <select value={market} onChange={(event) => setMarket(event.target.value as MarketFilter)} className="rounded-[6px] border border-[var(--color-border-default)] bg-white px-2 py-2 text-[12px] font-bold text-[var(--color-text-primary)]">
            <option value="all">JP + US</option>
            <option value="JP">日本株</option>
            <option value="US">米国株</option>
          </select>
        </label>
        <label className="grid gap-1 text-[11px] font-bold text-[var(--color-text-secondary)]">
          業種
          <select value={industry} onChange={(event) => setIndustry(event.target.value)} className="rounded-[6px] border border-[var(--color-border-default)] bg-white px-2 py-2 text-[12px] font-bold text-[var(--color-text-primary)]">
            <option value="all">すべて</option>
            {industries.map((value) => (
              <option key={value} value={value}>{value}</option>
            ))}
          </select>
        </label>
        <label className="grid gap-1 text-[11px] font-bold text-[var(--color-text-secondary)]">
          平均出来高下限
          <select value={minVolume} onChange={(event) => setMinVolume(event.target.value)} className="rounded-[6px] border border-[var(--color-border-default)] bg-white px-2 py-2 text-[12px] font-bold text-[var(--color-text-primary)]">
            <option value="0">指定なし</option>
            <option value="100000">10万株以上</option>
            <option value="300000">30万株以上</option>
            <option value="1000000">100万株以上</option>
            <option value="3000000">300万株以上</option>
          </select>
        </label>
        <label className="grid gap-1 text-[11px] font-bold text-[var(--color-text-secondary)]">
          並び替え
          <select value={sort} onChange={(event) => setSort(event.target.value as SortKey)} className="rounded-[6px] border border-[var(--color-border-default)] bg-white px-2 py-2 text-[12px] font-bold text-[var(--color-text-primary)]">
            {SORT_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>{option.label}</option>
            ))}
          </select>
        </label>
      </div>

      <div className="mb-2 flex flex-wrap items-center justify-between gap-2 text-[10px] font-bold text-[var(--color-text-tertiary)]">
        <span>表示 {visibleRows.length.toLocaleString('ja-JP')}件 / 候補 {filteredRows.length.toLocaleString('ja-JP')}件 / JP {data.jpDate ?? '-'} / US {data.usDate ?? '-'}</span>
        <span>空売り候補は日本株の貸借銘柄のみ</span>
      </div>

      <div className="overflow-x-auto rounded-[8px] border border-[var(--color-border-soft)]">
        <table className="min-w-[1180px] w-full border-collapse bg-white text-left">
          <thead className="bg-[var(--color-surface-subtle)] text-[10px] font-black uppercase tracking-wide text-[var(--color-text-tertiary)]">
            <tr>
              <th className="px-3 py-2">#</th>
              <th className="px-3 py-2">方向</th>
              <th className="px-3 py-2">銘柄</th>
              <th className="px-3 py-2">確度</th>
              <th className="px-3 py-2">ラベル</th>
              <th className="px-3 py-2">業種</th>
              <th className="px-3 py-2 text-right">平均出来高</th>
              <th className="px-3 py-2 text-right">価格</th>
              <th className="px-3 py-2">6ステージ / PMS</th>
              <th className="px-3 py-2">根拠</th>
            </tr>
          </thead>
          <tbody>
            {visibleRows.map((row, index) => (
              <SignalRow key={row.id} row={row} index={index} />
            ))}
          </tbody>
        </table>
        {filteredRows.length === 0 && (
          <div className="bg-white px-4 py-8 text-center text-[12px] font-bold text-[var(--color-text-tertiary)]">
            条件に合う候補がありません。
          </div>
        )}
      </div>
    </section>
  )
}
