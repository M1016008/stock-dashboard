// components/us/UsSectorRankingTable.tsx
//
// StockBoard SIC division / SEC SIC industry の比較表。列見出しで並び順 (指標) を切り替える。
// - md 以上: 表 (1W / 1M / PES は xl 以上で列を足す)
//   table-fixed で数値列の幅を固定し、残りを名称列に回す。名称は最大 2 行で折り返し、全文は title で読む。
//   min-width は各ブレークポイントの本文幅に収まる値にしてあり、横スクロールは本文がさらに狭いときの保険。
// - md 未満: 2 段のリスト
// 値は UsMarketGroup のまま。並べ替えは呼び出し側 (sortUsGroups) で済ませた順に描く。

import Link from 'next/link'
import { ListFilter } from 'lucide-react'
import { MeterBar } from '@/components/dashboard/DashboardPrimitives'
import type { UsMarketGroup } from '@/lib/server/us-market-intelligence'
import {
  fmtCount,
  fmtPct,
  fmtRatio,
  fmtScore,
  signedClass,
} from '@/components/us/UsMarketMomentumParts'
import {
  US_SECTOR_METRICS,
  US_SECTOR_SMALL_SAMPLE,
  fmtMetric,
  metricTextClass,
  type UsSectorMetric,
} from '@/components/us/UsSectorShared'

export type UsGroupRowView = {
  group: UsMarketGroup
  /** 主ラベル */
  title: string
  /** title 属性に出す元の名称 (表示用に整形したとき) */
  rawTitle?: string
  /** 補足 (正式名・SIC コードなど)。省略表示されても title で全文を読めるよう文字列で受ける */
  subtitle?: string
  /** 親階層 (industry 表で sector を出す) */
  parent?: string | null
  /** 同ページ内で下の階層へ */
  drillHref?: string | null
  drillLabel?: string
  screenerHref: string
  muted?: boolean
}

// 幅は 12px mono の想定最大桁 (騰落率 "-123.45%"、スコア "+0.85") + 左右 padding
const RETURN_COL = 'w-[4.75rem]'
const SCORE_COL = 'w-14'

const COLUMNS: Array<{ metric: UsSectorMetric; className: string; width: string }> = [
  { metric: '1d', className: '', width: RETURN_COL },
  { metric: '1w', className: 'hidden xl:table-cell', width: RETURN_COL },
  { metric: '1m', className: 'hidden xl:table-cell', width: RETURN_COL },
  { metric: 'pms', className: '', width: SCORE_COL },
  { metric: 'pfs', className: '', width: SCORE_COL },
  { metric: 'pes', className: 'hidden xl:table-cell', width: SCORE_COL },
]

function SortHeader({
  metric,
  active,
  hrefFor,
  className = '',
  align = 'right',
  children,
}: {
  metric: UsSectorMetric
  active: UsSectorMetric
  hrefFor: (metric: UsSectorMetric) => string
  className?: string
  align?: 'left' | 'right'
  children?: React.ReactNode
}) {
  const isActive = metric === active
  return (
    <th className={`px-2 py-2 font-bold ${align === 'right' ? 'text-right' : 'text-left'} ${className}`} aria-sort={isActive ? 'descending' : undefined}>
      <Link
        href={hrefFor(metric)}
        prefetch={false}
        scroll={false}
        className={`inline-flex items-center gap-0.5 whitespace-nowrap hover:text-[var(--color-brand-900)] ${isActive ? 'text-[var(--color-brand-900)] underline decoration-2 underline-offset-4' : ''}`}
        title={`${US_SECTOR_METRICS[metric].label}の高い順に並べる`}
      >
        {children ?? US_SECTOR_METRICS[metric].short}
        {isActive && <span aria-hidden className="text-[10px]">↓</span>}
      </Link>
    </th>
  )
}

function SampleMark({ count }: { count: number }) {
  if (count >= US_SECTOR_SMALL_SAMPLE) return null
  return <span className="ml-1 shrink-0 whitespace-nowrap text-[9px] font-bold text-[#b45309]" title={`銘柄数 ${count}。平均が少数銘柄に左右されます`}>少数</span>
}

export function UsSectorRankingTable({
  rows,
  metric,
  hrefFor,
  firstLabel,
  showParent = false,
  parentLabel = 'Sector',
  emptyLabel,
  ariaLabel,
}: {
  rows: UsGroupRowView[]
  metric: UsSectorMetric
  hrefFor: (metric: UsSectorMetric) => string
  firstLabel: string
  showParent?: boolean
  parentLabel?: string
  emptyLabel: string
  ariaLabel: string
}) {
  // 固定列の合計 + 名称列の最低 200px。768px 時の本文幅 (約 720px) / 1024px / 1280px で横スクロールが出ない値
  const minWidth = showParent
    ? 'min-w-[704px] lg:min-w-[856px] xl:min-w-[1064px]'
    : 'min-w-[704px] xl:min-w-[912px]'
  return (
    <>
      <div className="panel hidden md:block">
        <div className="table-scroll">
          <table className={`w-full table-fixed border-collapse text-[12px] ${minWidth}`} aria-label={ariaLabel}>
            <thead className="text-[11px]">
              <tr>
                <th className="w-9 py-2 pl-3 pr-1 text-right font-bold">#</th>
                <th className="px-2 py-2 text-left font-bold">{firstLabel}</th>
                {showParent && <th className="hidden w-[9.5rem] px-2 py-2 text-left font-bold lg:table-cell">{parentLabel}</th>}
                <th className="w-14 px-2 py-2 text-right font-bold">銘柄</th>
                {COLUMNS.map((column) => (
                  <SortHeader key={column.metric} metric={column.metric} active={metric} hrefFor={hrefFor} className={`${column.width} ${column.className}`} />
                ))}
                <SortHeader metric="breadth" active={metric} hrefFor={hrefFor} align="left" className="w-24">PMS+比率</SortHeader>
                <SortHeader metric="stage1" active={metric} hrefFor={hrefFor} className="w-16">日A S1</SortHeader>
                <th className="w-16 py-2 pl-2 pr-3 text-right font-bold"><span className="sr-only">操作</span></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--color-border-soft)]">
              {rows.map((row, index) => {
                const { group } = row
                return (
                  <tr key={group.key} className={`hover:bg-[var(--color-surface-subtle)] ${row.muted ? 'text-[var(--color-text-tertiary)]' : ''}`}>
                    <td className="py-1.5 pl-3 pr-1 text-right font-mono text-[11px] tabular-nums text-[var(--color-text-tertiary)]">{index + 1}</td>
                    <td className="px-2 py-1.5">
                      {/* 名称は識別に必要なため 1 行 ellipsis にせず最大 2 行まで出す (モバイルのリストと同じ扱い) */}
                      <div className="flex min-w-0 items-baseline">
                        {row.drillHref ? (
                          <Link href={row.drillHref} prefetch={false} className="line-clamp-2 min-w-0 break-words font-semibold leading-snug text-[var(--color-brand-700)] hover:underline" title={row.drillLabel}>
                            {row.title}
                          </Link>
                        ) : (
                          <span className="line-clamp-2 min-w-0 break-words font-semibold leading-snug text-[var(--color-text-primary)]" title={row.rawTitle ?? row.title}>{row.title}</span>
                        )}
                        <SampleMark count={group.count} />
                      </div>
                      {/* lg 未満は親セクター列を出さないので補足行の頭に付ける */}
                      {(row.subtitle || (showParent && row.parent)) && (
                        <div className="mt-0.5 truncate text-[10px] text-[var(--color-text-tertiary)]" title={[showParent ? row.parent : null, row.subtitle].filter(Boolean).join(' · ')}>
                          {showParent && row.parent && <span className="lg:hidden">{row.parent}{row.subtitle ? ' · ' : ''}</span>}
                          {row.subtitle}
                        </div>
                      )}
                    </td>
                    {showParent && <td className="hidden truncate px-2 py-1.5 text-[11px] text-[var(--color-text-secondary)] lg:table-cell" title={row.parent ?? undefined}>{row.parent ?? '—'}</td>}
                    <td className="px-2 py-1.5 text-right font-mono tabular-nums text-[var(--color-text-secondary)]">{fmtCount(group.count)}</td>
                    {COLUMNS.map((column) => {
                      const value = US_SECTOR_METRICS[column.metric].value(group)
                      const active = column.metric === metric
                      return (
                        <td
                          key={column.metric}
                          className={`px-2 py-1.5 text-right font-mono tabular-nums ${signedClass(value)} ${active ? 'bg-[var(--color-surface-subtle)] font-bold' : 'font-semibold'} ${column.className}`}
                        >
                          {fmtMetric(column.metric, value)}
                        </td>
                      )
                    })}
                    <td className={`px-2 py-1.5 ${metric === 'breadth' ? 'bg-[var(--color-surface-subtle)]' : ''}`}>
                      <span className={`block font-mono text-[11px] tabular-nums ${metricTextClass('breadth', group.positivePmsPct)} ${metric === 'breadth' ? 'font-bold' : 'font-semibold'}`}>{fmtRatio(group.positivePmsPct)}</span>
                      <MeterBar value={group.positivePmsPct} tone={(group.positivePmsPct ?? 0) >= 50 ? 'up' : 'down'} midTick className="mt-0.5" />
                    </td>
                    <td className={`px-2 py-1.5 text-right font-mono tabular-nums text-[var(--color-text-secondary)] ${metric === 'stage1' ? 'bg-[var(--color-surface-subtle)] font-bold text-[var(--color-text-primary)]' : ''}`}>
                      {fmtRatio(group.stage1Pct)}
                    </td>
                    <td className="py-1.5 pl-2 pr-3 text-right">
                      <Link
                        href={row.screenerHref}
                        prefetch={false}
                        className="inline-flex min-h-7 items-center gap-1 whitespace-nowrap text-[11px] font-semibold text-[var(--color-brand-700)] hover:underline"
                        title={`${row.title} の銘柄をスクリーナーで開く`}
                      >
                        <ListFilter size={12} aria-hidden />
                        銘柄
                      </Link>
                    </td>
                  </tr>
                )
              })}
              {rows.length === 0 && (
                <tr>
                  <td colSpan={14} className="px-3 py-8 text-center text-[12px] text-[var(--color-text-tertiary)]">{emptyLabel}</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      <ol className="panel m-0 list-none divide-y divide-[var(--color-border-soft)] p-0 md:hidden" aria-label={ariaLabel}>
        {rows.map((row, index) => {
          const { group } = row
          const value = US_SECTOR_METRICS[metric].value(group)
          return (
            <li key={group.key} className="grid grid-cols-[1.5rem_minmax(0,1fr)_auto] gap-x-2 px-3 py-2">
              <span className="pt-0.5 font-mono text-[11px] tabular-nums text-[var(--color-text-tertiary)]">{index + 1}</span>
              <div className="min-w-0">
                {/* SIC industry 名は識別に必要なため、1 行 ellipsis にせず最大 2 行まで出す */}
                <div className="flex min-w-0 items-baseline">
                  {row.drillHref ? (
                    <Link href={row.drillHref} prefetch={false} className="line-clamp-2 min-w-0 break-words text-[13px] font-semibold leading-snug text-[var(--color-brand-700)]" title={row.drillLabel}>{row.title}</Link>
                  ) : (
                    <span className="line-clamp-2 min-w-0 break-words text-[13px] font-semibold leading-snug text-[var(--color-text-primary)]" title={row.rawTitle ?? row.title}>{row.title}</span>
                  )}
                  <SampleMark count={group.count} />
                </div>
                <div className="truncate text-[10px] text-[var(--color-text-tertiary)]">
                  {fmtCount(group.count)}銘柄{showParent && row.parent ? ` · ${row.parent}` : ''}
                </div>
                <div className="mt-1 flex flex-wrap gap-x-2.5 gap-y-0.5 font-mono text-[11px] tabular-nums">
                  <span className={signedClass(group.avgChangePct)}>1D {fmtPct(group.avgChangePct)}</span>
                  <span className={signedClass(group.avgReturn1w)}>1W {fmtPct(group.avgReturn1w)}</span>
                  <span className={signedClass(group.avgReturn1m)}>1M {fmtPct(group.avgReturn1m)}</span>
                  <span className={signedClass(group.avgPms)}>PMS {fmtScore(group.avgPms)}</span>
                  <span className={signedClass(group.avgPfs)}>PFS {fmtScore(group.avgPfs)}</span>
                  <span className={signedClass(group.avgPes)}>PES {fmtScore(group.avgPes)}</span>
                  <span className="text-[var(--color-text-secondary)]">PMS+ {fmtRatio(group.positivePmsPct)}</span>
                  <span className="text-[var(--color-text-secondary)]">S1 {fmtRatio(group.stage1Pct)}</span>
                </div>
              </div>
              <div className="flex flex-col items-end justify-between gap-1 text-right">
                <span className={`font-mono text-[14px] font-bold tabular-nums ${metricTextClass(metric, value)}`}>{fmtMetric(metric, value)}</span>
                <Link href={row.screenerHref} prefetch={false} className="inline-flex min-h-7 items-center gap-1 text-[11px] font-semibold text-[var(--color-brand-700)]">
                  <ListFilter size={12} aria-hidden />
                  銘柄
                </Link>
              </div>
            </li>
          )
        })}
        {rows.length === 0 && (
          <li className="px-3 py-8 text-center text-[12px] text-[var(--color-text-tertiary)]">{emptyLabel}</li>
        )}
      </ol>
    </>
  )
}
