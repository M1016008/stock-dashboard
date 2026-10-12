'use client'

// components/us/trigger-discovery/UsTriggerResultCards.tsx
//
// lg (1024px) 未満の結果リスト。1 銘柄 = 1 行 (md 以上は 2 列)。
// - 上段: 銘柄 / Status・Score・ウォッチ
// - 中段: ミニチャート 156×56 を左に固定し、右に判断用の数値 (株価・Zone距離・MA距離・売買代金)
// - 下段: 6ステージと取引所・出来高
// - 外枠 1 枚の中を罫線で区切るだけで、カードを入れ子にしない

import Link from 'next/link'
import { TriggerMiniChart } from '@/components/trigger-discovery/TriggerMiniChart'
import { WatchlistButton } from '@/components/ui/WatchlistButton'
import { fmtPct, fmtUsd, fmtVolume, usStockHref } from '@/components/us/UsMarketMomentumParts'
import {
  StageCells,
  StatusPill,
  UsTriggerScore,
} from '@/components/us/trigger-discovery/UsTriggerControls'
import { fmtUsdCompact, maPeriodCode } from '@/components/us/trigger-discovery/usTriggerDiscoveryShared'
import type { UsTriggerResultListProps } from '@/components/us/trigger-discovery/UsTriggerResultsTable'

export function UsTriggerResultCards({
  response,
  linkDate,
  showExchange,
  chartFor,
  onStockNavigate,
}: Pick<UsTriggerResultListProps, 'response' | 'linkDate' | 'showExchange' | 'chartFor' | 'onStockNavigate'>) {
  const { meta, criteria } = response
  const ma1 = maPeriodCode(criteria.ma1Period, meta.timeframe)
  const ma2 = maPeriodCode(criteria.ma2Period, meta.timeframe)

  return (
    <div className="panel">
      <ol className="-mb-px m-0 grid list-none p-0 md:grid-cols-2" aria-label={`Trigger候補 ${meta.returnedCount}件`}>
        {response.rows.map((row) => {
          const chart = chartFor(row.ticker)
          const footer = [
            showExchange ? row.market : null,
            `平均出来高 ${fmtVolume(row.averageVolume)}株`,
          ].filter(Boolean).join(' · ')
          return (
            <li key={row.ticker} className="flex min-w-0 flex-col gap-2 border-b border-[var(--color-border-soft)] px-3 py-2.5 md:odd:border-r">
              <div className="flex items-start justify-between gap-2">
                <Link href={usStockHref(row.ticker, linkDate)} prefetch={false} onClick={onStockNavigate} className="group min-w-0 flex-1 rounded-[2px] leading-tight outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-brand-200)]">
                  <span className="block font-mono text-[14px] font-bold text-[var(--color-brand-700)] group-hover:underline">{row.ticker}</span>
                  <span className="mt-0.5 block truncate text-[11px] text-[var(--color-text-secondary)]" title={row.companyName}>{row.companyName}</span>
                </Link>
                <div className="flex shrink-0 items-center gap-1">
                  <StatusPill status={row.triggerStatus} />
                  <UsTriggerScore row={row} />
                  <WatchlistButton ticker={row.ticker} market="US" size="sm" />
                </div>
              </div>

              <div className="grid grid-cols-[156px_minmax(0,1fr)] items-center gap-3">
                <TriggerMiniChart
                  chart={chart.chart}
                  loading={chart.loading}
                  failed={chart.failed}
                  timeframe={meta.timeframe}
                  ma1Period={criteria.ma1Period}
                  ma2Period={criteria.ma2Period}
                />
                <dl className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] items-baseline gap-x-2 gap-y-0.5 text-[11px]">
                  <dt className="text-[10px] text-[var(--color-text-tertiary)]">株価</dt>
                  <dd className="truncate text-right font-mono font-medium tabular-nums text-[var(--color-text-primary)]">{fmtUsd(row.price)}</dd>
                  <dt className="text-[10px] text-[var(--color-text-tertiary)]">Zone距離</dt>
                  <dd className="truncate text-right font-mono font-bold tabular-nums text-[var(--color-text-primary)]">{fmtPct(row.zoneDistancePct)}</dd>
                  <dt className="text-[10px] text-[var(--color-text-tertiary)]">{ma1}</dt>
                  <dd className="truncate text-right font-mono tabular-nums text-[var(--color-text-secondary)]">{fmtPct(row.ma1DistancePct)}</dd>
                  <dt className="text-[10px] text-[var(--color-text-tertiary)]">{ma2}</dt>
                  <dd className="truncate text-right font-mono tabular-nums text-[var(--color-text-secondary)]">{fmtPct(row.ma2DistancePct)}</dd>
                  <dt className="text-[10px] text-[var(--color-text-tertiary)]">平均代金</dt>
                  <dd className="truncate text-right font-mono tabular-nums text-[var(--color-text-secondary)]">{fmtUsdCompact(row.averageTradingValue)}</dd>
                  {criteria.spreadExpansionEnabled && (
                    <>
                      <dt className="text-[10px] text-[var(--color-text-tertiary)]">MA間隔</dt>
                      <dd className="truncate text-right font-mono tabular-nums text-[var(--color-text-secondary)]">{row.maSpreadPct == null ? '—' : fmtPct(row.maSpreadPct)}</dd>
                    </>
                  )}
                </dl>
              </div>

              <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
                <StageCells row={row} />
                <span className="min-w-0 truncate text-[10px] text-[var(--color-text-tertiary)]">{footer}</span>
              </div>
              {row.priceFreshness === 'STALE_ACCEPTED' && (
                <p className="text-[10px] text-amber-700">価格は {row.priceDate}（{row.priceStalenessSessions}営業日前）の終値です</p>
              )}
            </li>
          )
        })}
      </ol>
    </div>
  )
}
