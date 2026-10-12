// components/us/UsMarketMomentumLanes.tsx
//
// 4 レーン (動き出し / 継続 / 失速 / 下落警戒)。条件と並び順は契約の rankUsMomentumRows に従い、
// ここでは上位の行を並べるだけ。レーンの見出しで「何の順か」を必ず示す。

import Link from 'next/link'
import { ChevronRight, ListFilter } from 'lucide-react'
import { TONE_FILL, type DashboardTone } from '@/components/dashboard/DashboardPrimitives'
import type { UsMarketMomentumRow, UsMomentumLane } from '@/lib/server/us-market-intelligence'
import {
  StageStrip,
  fmtCount,
  fmtPct,
  fmtScore,
  fmtUsd,
  secSectorShort,
  signedClass,
  usScreenerHref,
  usStockHref,
} from '@/components/us/UsMarketMomentumParts'

type ScoreKey = 'pms' | 'pfs'

export const US_LANE_ORDER: UsMomentumLane[] = ['initial', 'continuation', 'stall', 'drop']

export const US_LANE_META: Record<UsMomentumLane, {
  label: string
  rule: string
  description: string
  score: ScoreKey
  secondary: ScoreKey
  tone: DashboardTone
  /** /us/screener の既存クエリで近い並びを開く (しきい値は以上/以下のため完全一致ではない) */
  screener: Record<string, string>
  screenerLabel: string
}> = {
  initial: {
    label: '動き出し',
    rule: 'PFS > 0 · PFS 降順',
    description: '短期の力（PFS）が出始めた銘柄',
    score: 'pfs',
    secondary: 'pms',
    tone: 'warning',
    screener: { sort: 'pfs', dir: 'desc', pfsMin: '0' },
    screenerLabel: 'PFS ≥ 0 · PFS順',
  },
  continuation: {
    label: '継続',
    rule: 'PMS > 0 かつ PFS ≥ 0 · PMS 降順',
    description: '勢い（PMS）があり、PFS も崩れていない銘柄',
    score: 'pms',
    secondary: 'pfs',
    tone: 'up',
    screener: { sort: 'pms', dir: 'desc', pmsMin: '0', pfsMin: '0' },
    screenerLabel: 'PMS ≥ 0 · PFS ≥ 0 · PMS順',
  },
  stall: {
    label: '失速',
    rule: 'PMS > 0 かつ PFS < 0 · PFS 昇順',
    description: 'PMS は残るが PFS が悪化し始めた銘柄',
    score: 'pfs',
    secondary: 'pms',
    tone: 'down',
    screener: { sort: 'pfs', dir: 'asc', pmsMin: '0' },
    screenerLabel: 'PMS ≥ 0 · PFS昇順',
  },
  drop: {
    label: '下落警戒',
    rule: 'PMS < 0 かつ PFS ≤ 0 · PMS 昇順',
    description: 'PMS・PFS ともに弱い銘柄',
    score: 'pms',
    secondary: 'pfs',
    tone: 'down',
    screener: { sort: 'pms', dir: 'asc' },
    screenerLabel: 'PMS昇順',
  },
}

const SCORE_LABEL: Record<ScoreKey, string> = { pms: 'PMS', pfs: 'PFS' }

export function usLaneHref(lane: UsMomentumLane, date: string | null): string {
  const search = new URLSearchParams()
  if (date) search.set('date', date)
  if (lane !== 'initial') search.set('lane', lane)
  const query = search.toString()
  return `/us/market-momentum${query ? `?${query}` : ''}#us-lane-table`
}

export function UsMarketMomentumLanePanel({
  lane,
  rows,
  total,
  linkDate,
  showClassification,
}: {
  lane: UsMomentumLane
  rows: UsMarketMomentumRow[]
  /** 条件を満たす全銘柄数 */
  total: number
  linkDate: string | null
  showClassification: boolean
}) {
  const meta = US_LANE_META[lane]
  return (
    <section className="panel flex min-w-0 flex-col" aria-labelledby={`us-lane-${lane}`}>
      <div className="panel-head">
        <div className="min-w-0">
          <h2 id={`us-lane-${lane}`} className="flex items-center gap-1.5">
            <span aria-hidden className="inline-block h-2.5 w-2.5 rounded-[2px]" style={{ background: TONE_FILL[meta.tone] }} />
            {meta.label}
          </h2>
          <p>{meta.rule}</p>
        </div>
        <span className="text-[11px] tabular-nums text-[var(--color-text-tertiary)]">
          該当 <strong className="font-semibold text-[var(--color-text-secondary)]">{fmtCount(total)}</strong>
        </span>
      </div>
      <ol className="m-0 flex-1 list-none divide-y divide-[var(--color-border-soft)] p-0">
        {rows.map((row, index) => {
          const score = row[meta.score]
          const secondary = row[meta.secondary]
          return (
            <li key={row.ticker} className="grid grid-cols-[1.25rem_minmax(0,1fr)_auto] items-center gap-x-2 px-3 py-1.5">
              <span className="font-mono text-[11px] tabular-nums text-[var(--color-text-tertiary)]">{index + 1}</span>
              <div className="min-w-0">
                <div className="flex min-w-0 items-baseline gap-1.5">
                  <Link href={usStockHref(row.ticker, linkDate)} prefetch={false} className="shrink-0 font-mono text-[12px] font-bold text-[var(--color-brand-700)] hover:underline">
                    {row.ticker}
                  </Link>
                  <span className="min-w-0 truncate text-[11px] font-semibold text-[var(--color-text-primary)] max-sm:line-clamp-2 max-sm:whitespace-normal max-sm:break-words" title={row.name ?? undefined}>{row.name ?? ''}</span>
                </div>
                {/* 狭い幅では 6 Stage の後ろで価格・騰落率を次の行へ折り返し、右端で切らない */}
                <div className="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[10px] tabular-nums text-[var(--color-text-tertiary)] xl:flex-nowrap xl:overflow-hidden">
                  <StageStrip row={row} />
                  <span className="inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap">
                    <span className="font-mono text-[var(--color-text-secondary)]">{fmtUsd(row.price)}</span>
                    <span className={`font-mono font-semibold ${signedClass(row.changePct)}`}>{fmtPct(row.changePct)}</span>
                  </span>
                  {showClassification && (row.exchange || row.sector) && (
                    <span className="hidden min-w-0 whitespace-normal break-words sm:inline xl:truncate xl:whitespace-nowrap" title={[row.exchange, row.sector].filter(Boolean).join(' · ')}>
                      {[row.exchange, row.sectorCode ? secSectorShort(row.sectorCode, row.sector) : null].filter(Boolean).join(' · ')}
                    </span>
                  )}
                </div>
              </div>
              <div className="text-right tabular-nums">
                <div className={`font-mono text-[14px] font-bold leading-tight ${signedClass(score)}`}>{fmtScore(score)}</div>
                <div className="whitespace-nowrap text-[10px] text-[var(--color-text-tertiary)]">
                  {SCORE_LABEL[meta.score]} · {SCORE_LABEL[meta.secondary]} <span className={signedClass(secondary)}>{fmtScore(secondary)}</span>
                </div>
              </div>
            </li>
          )
        })}
        {rows.length === 0 && (
          <li className="px-3 py-6 text-center text-[12px] text-[var(--color-text-tertiary)]">条件を満たす銘柄はありません</li>
        )}
      </ol>
      <div className="grid grid-cols-2 border-t border-[var(--color-border-soft)] text-[12px] font-semibold">
        <Link
          href={usLaneHref(lane, linkDate)}
          prefetch={false}
          className="flex min-h-9 items-center justify-center gap-1 text-[var(--color-brand-700)] hover:bg-[var(--color-surface-subtle)]"
        >
          表で比較
          <ChevronRight size={13} aria-hidden />
        </Link>
        <Link
          href={usScreenerHref(meta.screener, linkDate)}
          prefetch={false}
          title={`スクリーナー: ${meta.screenerLabel}`}
          className="flex min-h-9 items-center justify-center gap-1 border-l border-[var(--color-border-soft)] text-[var(--color-brand-700)] hover:bg-[var(--color-surface-subtle)]"
        >
          <ListFilter size={13} aria-hidden />
          スクリーナー
        </Link>
      </div>
    </section>
  )
}
