// components/dashboard/NewHighVolume.tsx
// 新高値・新安値・出来高急増を3レーンに分けて全件表示する。

import Link from 'next/link'
import { Card, CardHeader } from '@/components/ui/Card'
import { IndustryBadges } from '@/components/ui/IndustryBadges'
import { MarginBadges } from '@/components/ui/MarginBadges'
import { StageTag } from '@/components/ui/StageTag'
import { getCachedMarketMovers } from '@/lib/queries/dashboard-cache'
import type { NewHighVolumeRow } from '@/lib/queries/dashboard'

const MAX_INITIAL_ROWS_PER_LANE = 40

function fmtPct(v: number | null | undefined) {
  if (v == null) return '---'
  return (v >= 0 ? '+' : '') + v.toFixed(2) + '%'
}

function fmtPrice(v: number | null | undefined) {
  if (v == null) return '---'
  return v.toLocaleString('ja-JP', { maximumFractionDigits: 1 })
}

function fmtRatio(v: number | null | undefined) {
  if (v == null) return '---'
  return v.toFixed(1) + 'x'
}

function laneTone(kind: 'high' | 'low' | 'volume') {
  if (kind === 'high') return 'text-[var(--color-price-up)] bg-[var(--color-price-up-bg)]'
  if (kind === 'low') return 'text-[var(--color-price-down)] bg-[var(--color-price-down-bg)]'
  return 'text-[var(--color-pattern-700)] bg-[var(--color-pattern-50)]'
}

function stageValues(row: NewHighVolumeRow) {
  const stages = [
    row.daily_a_stage,
    row.daily_b_stage,
    row.weekly_a_stage,
    row.weekly_b_stage,
    row.monthly_a_stage,
    row.monthly_b_stage,
  ]
  return stages.every((stage) => typeof stage === 'number') ? stages : null
}

function StageCodeTags({ row }: { row: NewHighVolumeRow }) {
  const stages = stageValues(row)
  if (!stages) {
    return (
      <span className="font-mono text-[11px] font-bold tracking-normal text-[var(--color-text-tertiary)]">
        ------
      </span>
    )
  }
  return (
    <span className="flex items-center justify-end gap-0.5">
      {stages.map((stage, index) => (
        <StageTag key={`${row.ticker}-${index}-${stage}`} stage={stage} size="xs" />
      ))}
    </span>
  )
}

function MoverLane({
  title,
  hint,
  rows,
  kind,
}: {
  title: string
  hint: string
  rows: NewHighVolumeRow[]
  kind: 'high' | 'low' | 'volume'
}) {
  const visibleRows = rows.slice(0, MAX_INITIAL_ROWS_PER_LANE)
  const hiddenCount = Math.max(0, rows.length - visibleRows.length)
  return (
    <div className="min-h-[360px] rounded-[8px] border border-[var(--color-border-soft)] bg-[var(--color-surface-subtle)]">
      <div className="flex items-baseline justify-between border-b border-[var(--color-border-soft)] px-3 py-3">
        <div>
          <div className="text-[13px] font-bold">{title}</div>
          <div className="mt-1 text-[11px] font-semibold text-[var(--color-text-tertiary)]">{hint}</div>
        </div>
        <span className={`rounded-full px-2 py-1 text-[11px] font-bold tabular-nums ${laneTone(kind)}`}>
          {rows.length.toLocaleString()}
        </span>
      </div>
      {rows.length === 0 ? (
        <div className="px-3 py-8 text-center text-[13px] font-medium text-[var(--color-text-tertiary)]">該当なし</div>
      ) : (
        <div className="max-h-[520px] overflow-auto">
          <div className="grid min-w-[800px] grid-cols-[58px_minmax(160px,1fr)_72px_178px_70px_64px_58px_96px] gap-2 px-3 py-2 text-[11px] font-bold text-[var(--color-text-tertiary)]">
            <span>コード</span>
            <span>銘柄</span>
            <span>貸借</span>
            <span>J-Quants業種</span>
            <span className="text-right">株価</span>
            <span className="text-right">前日比</span>
            <span className="text-right">出来高</span>
            <span className="text-right">6軸</span>
          </div>
          <div className="divide-y divide-[var(--color-border-soft)]">
            {visibleRows.map((row) => {
              const tone = row.changePct > 0 ? 'text-[var(--color-price-up)]' : row.changePct < 0 ? 'text-[var(--color-price-down)]' : ''
              return (
                <Link
                  key={`${row.category}-${row.ticker}`}
                  href={`/stock/${row.ticker}`}
                  prefetch={false}
                  className="grid min-w-[800px] grid-cols-[58px_minmax(160px,1fr)_72px_178px_70px_64px_58px_96px] items-center gap-2 px-3 py-2.5 text-[13px] font-medium hover:bg-white"
                >
                  <span className="tabular-nums text-[var(--color-text-secondary)]">{row.ticker}</span>
                  <span className="min-w-0">
                    <span className="block truncate font-semibold">{row.name ?? row.ticker}</span>
                  </span>
                  <MarginBadges
                    marginType={row.marginType}
                    creditRatio={row.creditRatio}
                    shortRatio={row.shortRatio}
                    compact
                  />
                  <IndustryBadges
                    sector17={row.sector17Name}
                    sector33={row.sector33Name ?? row.sectorName}
                    marketSegment={row.marketSegment}
                    compact
                  />
                  <span className="text-right tabular-nums">{fmtPrice(row.price)}</span>
                  <span className={`text-right tabular-nums ${tone}`}>{fmtPct(row.changePct)}</span>
                  <span className="text-right tabular-nums text-[var(--color-text-secondary)]">{fmtRatio(row.volumeRatio)}</span>
                  <StageCodeTags row={row} />
                </Link>
              )
            })}
            {hiddenCount > 0 && (
              <div className="px-3 py-3 text-center text-[11px] font-bold text-[var(--color-text-tertiary)]">
                初期表示は上位 {MAX_INITIAL_ROWS_PER_LANE} 件です。全 {rows.length.toLocaleString()} 件中、残り {hiddenCount.toLocaleString()} 件は条件を絞って確認してください。
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

export async function NewHighVolume({ date }: { date?: string | null }) {
  const movers = await getCachedMarketMovers(date)
  return (
    <Card>
      <CardHeader title="新高値・新安値・出来高急増" hint="252日レンジ / 出来高30日平均比" />
      <div className="grid grid-cols-1 gap-3 xl:grid-cols-3">
        <MoverLane title="新高値" hint="252日高値を更新" rows={movers.newHighs} kind="high" />
        <MoverLane title="新安値" hint="252日安値を更新" rows={movers.newLows} kind="low" />
        <MoverLane title="出来高急増" hint="30日平均の2倍以上" rows={movers.volumeSpikes} kind="volume" />
      </div>
    </Card>
  )
}
