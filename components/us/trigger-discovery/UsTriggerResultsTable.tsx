'use client'

// components/us/trigger-discovery/UsTriggerResultsTable.tsx
//
// lg (1024px) 以上の結果表。ミニチャート (156×56) を銘柄の右に置き、数値列はその右に読む。
// - 1024〜1359px: MA距離と流動性を 1 セル 2 段にまとめ、横スクロールなしで収める
// - 1360px 以上 (1440 を含む): MA1/MA2・売買代金/出来高を別列にし、最新日は取引所列も出す
// - table-fixed で数値列を固定幅にし、余白は銘柄名の列だけが受け持つ (不自然な空白を作らない)
// - 値はすべてサーバーの結果をそのまま整形する

import Link from 'next/link'
import type { MouseEvent as ReactMouseEvent } from 'react'
import { TriggerMiniChart } from '@/components/trigger-discovery/TriggerMiniChart'
import { WatchlistButton } from '@/components/ui/WatchlistButton'
import { fmtPct, fmtUsd, fmtVolume, usStockHref } from '@/components/us/UsMarketMomentumParts'
import {
  SortButton,
  StageCells,
  StatusPill,
  UsTriggerScore,
} from '@/components/us/trigger-discovery/UsTriggerControls'
import {
  STAGE_AXIS_LABELS,
  fmtUsdCompact,
  maPeriodCode,
} from '@/components/us/trigger-discovery/usTriggerDiscoveryShared'
import {
  TRIGGER_DISCOVERY_STAGE_AXES,
  type TriggerDiscoveryMiniChart,
  type TriggerDiscoverySearchRequest,
  type TriggerDiscoverySearchRow,
  type TriggerDiscoverySortKey,
} from '@/lib/trigger-discovery-contract'
import type { UsTriggerDiscoverySearchResponse } from '@/lib/us-trigger-discovery-contract'

export interface UsTriggerChartState {
  chart?: TriggerDiscoveryMiniChart
  loading: boolean
  failed: boolean
}

export interface UsTriggerResultListProps {
  response: UsTriggerDiscoverySearchResponse
  linkDate: string | null
  showExchange: boolean
  activeSort: TriggerDiscoverySearchRequest['sort']
  onSort: (key: TriggerDiscoverySortKey) => void
  sortDisabled: boolean
  chartFor: (ticker: string) => UsTriggerChartState
  onStockNavigate: (event: ReactMouseEvent<HTMLAnchorElement>) => void
}

const TH = 'px-2 py-1.5 align-bottom text-[11px] font-semibold'

function sortAria(activeSort: TriggerDiscoverySearchRequest['sort'], key: TriggerDiscoverySortKey): 'ascending' | 'descending' | undefined {
  if (activeSort?.key !== key) return undefined
  return activeSort.direction === 'asc' ? 'ascending' : 'descending'
}

function spreadText(row: TriggerDiscoverySearchRow): string {
  return row.maSpreadPct == null ? '—' : fmtPct(row.maSpreadPct)
}

export function UsTriggerResultsTable({
  response,
  linkDate,
  showExchange,
  activeSort,
  onSort,
  sortDisabled,
  chartFor,
  onStockNavigate,
}: UsTriggerResultListProps) {
  const { meta, criteria } = response
  const ma1 = maPeriodCode(criteria.ma1Period, meta.timeframe)
  const ma2 = maPeriodCode(criteria.ma2Period, meta.timeframe)
  const spread = criteria.spreadExpansionEnabled
  const sortProps = { activeSort, onSort, disabled: sortDisabled }

  return (
    <div className="table-scroll rounded-[var(--radius-card)] border border-[var(--color-border-default)] bg-white">
      <table className="w-full min-w-[940px] table-fixed border-collapse text-[12px]">
        <caption className="sr-only">
          Trigger候補 {meta.matchedCount}件中 {meta.returnedCount}件。列見出しのボタンで並べ替えます。
        </caption>
        <thead className="border-b border-[var(--color-border-default)] bg-[var(--color-surface-subtle)] text-[var(--color-text-secondary)]">
          <tr>
            <th scope="col" aria-sort={sortAria(activeSort, 'ticker')} className={`${TH} text-left`}>
              <SortButton label="銘柄" ariaLabel="ティッカー" sortKey="ticker" {...sortProps} />
            </th>
            <th scope="col" aria-sort={sortAria(activeSort, 'triggerStatus') ?? sortAria(activeSort, 'triggerScore')} className={`${TH} w-[92px] text-left`}>
              <SortButton label="Status" ariaLabel="Status" sortKey="triggerStatus" {...sortProps} />
              <SortButton label="Score" ariaLabel="Trigger Score" sortKey="triggerScore" {...sortProps} />
            </th>
            <th scope="col" className={`${TH} w-[172px] text-left`}>
              <span className="block">ミニチャート</span>
              <span className="mt-0.5 flex items-center gap-2 text-[9px] font-normal text-[var(--color-text-tertiary)]">
                <span className="inline-flex items-center gap-1"><span className="h-px w-3 bg-[var(--color-text-primary)]" aria-hidden />終値</span>
                <span className="inline-flex items-center gap-1"><span className="h-px w-3 bg-[#2563eb]" aria-hidden />{ma1}</span>
                <span className="inline-flex items-center gap-1"><span className="h-px w-3 bg-[#d97706]" aria-hidden />{ma2}</span>
              </span>
            </th>
            <th scope="col" aria-sort={sortAria(activeSort, 'price')} className={`${TH} w-[88px] text-right`}>
              <SortButton label="株価" ariaLabel="株価" sortKey="price" align="end" {...sortProps} />
            </th>
            <th scope="col" aria-sort={sortAria(activeSort, 'zoneDistance')} className={`${TH} w-[84px] text-right`}>
              <SortButton label="Zone距離" ariaLabel="Zone距離" sortKey="zoneDistance" align="end" {...sortProps} />
            </th>
            {/* 1024–1359: MA距離 2 段 */}
            <th scope="col" aria-sort={sortAria(activeSort, 'ma1Distance') ?? sortAria(activeSort, 'ma2Distance')} className={`${TH} w-[104px] text-right min-[1360px]:hidden`}>
              <span className="block text-[10px] font-normal text-[var(--color-text-tertiary)]">MA距離</span>
              <SortButton label={ma1} ariaLabel={`${ma1}距離`} sortKey="ma1Distance" align="end" {...sortProps} />
              <SortButton label={ma2} ariaLabel={`${ma2}距離`} sortKey="ma2Distance" align="end" {...sortProps} />
            </th>
            {/* 1360+: MA距離を別列 */}
            <th scope="col" aria-sort={sortAria(activeSort, 'ma1Distance')} className={`${TH} hidden w-[80px] text-right min-[1360px]:table-cell`}>
              <SortButton label={`${ma1}距離`} ariaLabel={`${ma1}距離`} sortKey="ma1Distance" align="end" {...sortProps} />
            </th>
            <th scope="col" aria-sort={sortAria(activeSort, 'ma2Distance')} className={`${TH} hidden w-[80px] text-right min-[1360px]:table-cell`}>
              <SortButton label={`${ma2}距離`} ariaLabel={`${ma2}距離`} sortKey="ma2Distance" align="end" {...sortProps} />
            </th>
            {spread && <th scope="col" className={`${TH} hidden w-[84px] text-right min-[1360px]:table-cell`}>MA間隔</th>}
            {/* 1024–1359: 流動性 2 段 */}
            <th scope="col" aria-sort={sortAria(activeSort, 'averageTradingValue') ?? sortAria(activeSort, 'averageVolume')} className={`${TH} w-[100px] text-right min-[1360px]:hidden`}>
              <span className="block text-[10px] font-normal text-[var(--color-text-tertiary)]">平均</span>
              <SortButton label="売買代金" ariaLabel="平均売買代金" sortKey="averageTradingValue" align="end" {...sortProps} />
              <SortButton label="出来高" ariaLabel="平均出来高" sortKey="averageVolume" align="end" {...sortProps} />
            </th>
            <th scope="col" aria-sort={sortAria(activeSort, 'averageTradingValue')} className={`${TH} hidden w-[92px] text-right min-[1360px]:table-cell`}>
              <SortButton label="平均代金" ariaLabel="平均売買代金" sortKey="averageTradingValue" align="end" {...sortProps} />
            </th>
            <th scope="col" aria-sort={sortAria(activeSort, 'averageVolume')} className={`${TH} hidden w-[84px] text-right min-[1360px]:table-cell`}>
              <SortButton label="平均出来高" ariaLabel="平均出来高" sortKey="averageVolume" align="end" {...sortProps} />
            </th>
            {showExchange && <th scope="col" className={`${TH} hidden w-[76px] text-left min-[1360px]:table-cell`}>取引所</th>}
            <th scope="col" className={`${TH} w-[136px] text-left`}>
              <span className="block">6ステージ</span>
              <span className="mt-0.5 flex gap-0.5 text-[9px] font-normal text-[var(--color-text-tertiary)]" aria-hidden>
                {TRIGGER_DISCOVERY_STAGE_AXES.map((axis) => <span key={axis} className="w-[18px] text-center">{STAGE_AXIS_LABELS[axis]}</span>)}
              </span>
            </th>
            <th scope="col" className={`${TH} w-10 text-center`}><span className="sr-only">ウォッチリスト</span></th>
          </tr>
        </thead>
        <tbody className="divide-y divide-[var(--color-border-soft)]">
          {response.rows.map((row) => {
            const chart = chartFor(row.ticker)
            return (
              <tr key={row.ticker} className="align-middle transition-colors hover:bg-[var(--color-surface-subtle)]">
                <td className="min-w-0 px-2 py-1">
                  <Link href={usStockHref(row.ticker, linkDate)} prefetch={false} onClick={onStockNavigate} className={`group block min-w-0 rounded-[2px] leading-tight outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-brand-200)]`}>
                    <span className="block font-mono text-[13px] font-bold text-[var(--color-brand-700)] group-hover:underline">{row.ticker}</span>
                    <span className="mt-0.5 block truncate text-[11px] text-[var(--color-text-secondary)]" title={row.companyName}>{row.companyName}</span>
                  </Link>
                  {showExchange && row.market && (
                    <span className={`mt-1 inline-flex max-w-full truncate rounded-[3px] border border-[var(--color-border-soft)] bg-[var(--color-surface-subtle)] px-1 text-[9px] font-medium text-[var(--color-text-tertiary)] min-[1360px]:hidden`}>{row.market}</span>
                  )}
                  {row.priceFreshness === 'STALE_ACCEPTED' && (
                    <span className="mt-0.5 block truncate text-[9px] text-amber-700" title={`価格は ${row.priceDate}（${row.priceStalenessSessions}営業日前）`}>価格 {row.priceDate}（{row.priceStalenessSessions}営業日前）</span>
                  )}
                </td>
                <td className="px-2 py-1">
                  <span className="flex flex-col items-start gap-1">
                    <StatusPill status={row.triggerStatus} />
                    <UsTriggerScore row={row} />
                  </span>
                </td>
                <td className="px-2 py-1">
                  <TriggerMiniChart
                    chart={chart.chart}
                    loading={chart.loading}
                    failed={chart.failed}
                    timeframe={meta.timeframe}
                    ma1Period={criteria.ma1Period}
                    ma2Period={criteria.ma2Period}
                  />
                </td>
                <td className="px-2 py-1 text-right font-mono font-medium tabular-nums text-[var(--color-text-primary)]">{fmtUsd(row.price)}</td>
                <td className="px-2 py-1 text-right font-mono text-[13px] font-bold tabular-nums text-[var(--color-text-primary)]">{fmtPct(row.zoneDistancePct)}</td>
                <td className={`px-2 py-1 text-right font-mono tabular-nums text-[var(--color-text-secondary)] min-[1360px]:hidden`}>
                  <span className="block"><span className="mr-1 text-[9px] text-[var(--color-text-tertiary)]">{ma1}</span>{fmtPct(row.ma1DistancePct)}</span>
                  <span className="block"><span className="mr-1 text-[9px] text-[var(--color-text-tertiary)]">{ma2}</span>{fmtPct(row.ma2DistancePct)}</span>
                  {spread && <span className="block text-[10px] text-[var(--color-text-tertiary)]">間隔 {spreadText(row)}</span>}
                </td>
                <td className={`hidden px-2 py-1 text-right font-mono tabular-nums text-[var(--color-text-secondary)] min-[1360px]:table-cell`}>{fmtPct(row.ma1DistancePct)}</td>
                <td className={`hidden px-2 py-1 text-right font-mono tabular-nums text-[var(--color-text-secondary)] min-[1360px]:table-cell`}>{fmtPct(row.ma2DistancePct)}</td>
                {spread && (
                  <td className={`hidden px-2 py-1 text-right font-mono tabular-nums min-[1360px]:table-cell`} title={row.maSpreadSlope == null ? undefined : `Slope ${row.maSpreadSlope.toFixed(3)}pt / 観測`}>
                    <span className="block text-[var(--color-text-primary)]">{spreadText(row)}</span>
                    <span className="block text-[9px] text-[var(--color-text-tertiary)]">拡大 {row.maSpreadExpansionRatio == null ? '—' : `${Math.round(row.maSpreadExpansionRatio * 100)}%`}</span>
                  </td>
                )}
                <td className={`px-2 py-1 text-right font-mono tabular-nums min-[1360px]:hidden`}>
                  <span className="block text-[var(--color-text-primary)]">{fmtUsdCompact(row.averageTradingValue)}</span>
                  <span className="block text-[10px] text-[var(--color-text-tertiary)]">{fmtVolume(row.averageVolume)}株</span>
                </td>
                <td className={`hidden px-2 py-1 text-right font-mono tabular-nums text-[var(--color-text-primary)] min-[1360px]:table-cell`}>{fmtUsdCompact(row.averageTradingValue)}</td>
                <td className={`hidden px-2 py-1 text-right font-mono tabular-nums text-[var(--color-text-secondary)] min-[1360px]:table-cell`}>{fmtVolume(row.averageVolume)}</td>
                {showExchange && (
                  <td className={`hidden truncate px-2 py-1 text-[11px] text-[var(--color-text-secondary)] min-[1360px]:table-cell`} title={row.market ?? undefined}>{row.market ?? '—'}</td>
                )}
                <td className="px-2 py-1"><StageCells row={row} /></td>
                <td className="px-1 py-1 text-center"><WatchlistButton ticker={row.ticker} market="US" size="sm" /></td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
