// components/dashboard/DashboardMarketBrief.tsx
//
// Dashboard 冒頭の「今日の市場」。3 秒で次の 3 点が読めることを目的にする。
//   1. 市場の状態   … 既存の全体判定 (PMS分布の判定) とブレッドス 5 指標
//   2. どこが強い/弱い … 市場区分ごとの PMS プラス比率と既存の区分判定
//   3. 今日の変化   … 当日の初動 (PFS上位)・失速 (PFS悪化) と業種の上下端
// 下段の「今日の確認事項」は売買候補・シナリオ・決算の件数だけを並べ、各セクションへ飛ばす。
//
// ここでは新しい判定や数値計算をしない。すべて各セクションと同じローダー
// (React cache で共有) の結果を、並べ方だけ変えて表示する。

import Link from 'next/link'
import { Suspense } from 'react'
import { ArrowDown } from 'lucide-react'
import { marketMomentumHrefForSegment } from '@/lib/market-momentum-groups'
import type { UniverseFilterValue } from '@/lib/market-universe'
import {
  breadthTone,
  fmtCount,
  fmtPct,
  fmtRatio,
  groupReading,
  loadMomentumMarket,
  ratio,
  stockDetailHref,
  type MomentumRankingRow,
} from '@/components/dashboard/PhysicalMomentumMarket'
import { loadDashboardTradeSignals } from '@/components/dashboard/DashboardTradeSignalTable'
import { loadTradeScenarioOverview } from '@/components/dashboard/TradeScenarioOverview'
import {
  daysLeftText,
  loadDashboardEarningsAlerts,
  rankEarningsAlerts,
} from '@/components/dashboard/DashboardEarningsAlerts'
import { AgendaSkeleton, MarketStateSkeleton } from '@/components/dashboard/DashboardSectionFallback'
import {
  GroupLabel,
  MeterBar,
  TONE_FILL,
  TONE_TEXT,
  ToneLabel,
  type DashboardTone,
  signedTextClass,
} from '@/components/dashboard/DashboardPrimitives'

type BriefProps = {
  /** 過去日表示のときだけ日付が入る (最新表示は null)。各セクションと同じ値を渡す */
  date: string | null
  universe: UniverseFilterValue
  scenarioInterval: string | null
  mode: 'latest' | 'historical'
  resolvedDate: string | null
  universeLabel: string | null
}
export function DashboardMarketBrief({ date, universe, scenarioInterval, mode, resolvedDate, universeLabel }: BriefProps) {
  const historical = mode === 'historical'
  return (
    <section
      aria-labelledby="market-brief-heading"
      className="overflow-hidden rounded-[var(--radius-card)] border border-[var(--color-border-default)] border-t-[3px] border-t-[var(--color-brand-900)] bg-white"
    >
      <header className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1 border-b border-[var(--color-border-soft)] px-4 py-2">
        <h2 id="market-brief-heading" className="text-[14px] font-bold text-[var(--color-brand-900)]">
          {historical ? 'この日の市場' : '今日の市場'}
        </h2>
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 text-[11px] font-semibold text-[var(--color-text-tertiary)]">
          <span>
            表示基準日 <span className="font-mono font-bold tabular-nums text-[var(--color-text-primary)]">{resolvedDate ?? '---'}</span> 大引け
          </span>
          <span className={historical ? 'font-bold text-[#b45309]' : ''}>{historical ? '過去日表示' : '最新データ'}</span>
          <span>{universeLabel ?? '日本株全体'}</span>
        </div>
      </header>

      <Suspense fallback={<MarketStateSkeleton />}>
        <MarketState date={date} universe={universe} resolvedDate={resolvedDate} />
      </Suspense>

      <div className="border-t border-[var(--color-border-default)] bg-[var(--color-surface-subtle)]">
        <h3 className="sr-only">今日の確認事項</h3>
        <div className="grid md:grid-cols-3">
          <Suspense fallback={<AgendaSkeleton />}>
            <SignalsAgenda date={date} universe={universe} scenarioInterval={scenarioInterval} />
          </Suspense>
          {historical ? (
            <div className="border-t border-[var(--color-border-soft)] px-4 py-2.5 md:col-span-2 md:border-l md:border-t-0">
              <div className="text-[11px] font-bold text-[var(--color-text-secondary)]">この日付で表示しない項目</div>
              <p className="mt-1 text-[11px] font-semibold leading-relaxed text-[var(--color-text-tertiary)]">
                シナリオ進捗・決算注意・材料・次の分析は現在の情報をもとにした内容のため、過去日では表示しません。
              </p>
            </div>
          ) : (
            <>
              <Suspense fallback={<AgendaSkeleton bordered />}>
                <ScenarioAgenda />
              </Suspense>
              <Suspense fallback={<AgendaSkeleton bordered />}>
                <EarningsAgenda universe={universe} />
              </Suspense>
            </>
          )}
        </div>
      </div>
    </section>
  )
}

/* ---------- 市場の状態 ---------- */

async function MarketState({
  date,
  universe,
  resolvedDate,
}: {
  date: string | null
  universe: UniverseFilterValue
  resolvedDate: string | null
}) {
  const data = await loadMomentumMarket(date, universe)
  const { reading } = data
  const dateMismatch = data.date != null && resolvedDate != null && data.date !== resolvedDate
  const breadth: Array<{ label: string; hint: string; value: number | null; count: number; tone: DashboardTone; mid: boolean }> = [
    { label: 'PMSプラス', hint: 'PMS > 0', value: data.pmsPlusRatio, count: data.positivePms, tone: breadthTone(data.pmsPlusRatio, 52), mid: true },
    { label: '初動プラス', hint: 'PFS > 0', value: data.forcePlusRatio, count: data.positivePfs, tone: breadthTone(data.forcePlusRatio, 55), mid: true },
    { label: '強い勢い', hint: 'PMS ≥ +1', value: data.strongRatio, count: data.strongPms, tone: 'up', mid: false },
    { label: '弱い勢い', hint: 'PMS ≤ −1', value: data.weakRatio, count: data.weakPms, tone: 'down', mid: false },
    { label: '熱量上位', hint: 'PES ≥ +1', value: data.energyHighRatio, count: data.highPes, tone: 'warning', mid: false },
  ]
  const strongSectors = data.sortedSectors.slice(0, 2)
  const weakSectors = data.sortedSectors.length > 2 ? data.sortedSectors.slice(-2).reverse() : []

  return (
    <div className="grid md:grid-cols-2 lg:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)_minmax(0,1fr)]">
      {/* 1. 全体判定 + ブレッドス */}
      <div className="min-w-0 px-4 pb-4 pt-3 md:col-span-2 lg:col-span-1">
        <div className="text-[10px] font-semibold text-[var(--color-text-tertiary)]">全体判定（PMS分布）</div>
        <div className="mt-1 flex items-center gap-2.5">
          <span aria-hidden="true" className="h-[22px] w-[5px] shrink-0 rounded-[1px]" style={{ background: TONE_FILL[reading.tone] }} />
          <p className={`text-[24px] font-bold leading-none sm:text-[28px] ${TONE_TEXT[reading.tone]}`}>{reading.label}</p>
        </div>
        <p className="mt-2 max-w-[44ch] text-[12px] font-medium leading-relaxed text-[var(--color-text-secondary)]">{reading.note}</p>

        <dl className="mt-3 grid gap-y-[7px]">
          {breadth.map((item) => (
            <div key={item.label} className="grid grid-cols-[7.25rem_minmax(0,1fr)_3.25rem_4.75rem] items-center gap-x-3 max-sm:gap-x-2">
              <dt className="min-w-0 truncate text-[11px] font-semibold text-[var(--color-text-secondary)]">
                {item.label}
                <span className="ml-1 font-mono text-[9px] text-[var(--color-text-tertiary)]">{item.hint}</span>
              </dt>
              <dd className="contents">
                <MeterBar value={item.value} tone={item.tone} midTick={item.mid} />
                <span className={`text-right font-mono text-[13px] font-bold tabular-nums ${item.tone === 'neutral' ? 'text-[var(--color-text-primary)]' : TONE_TEXT[item.tone]}`}>
                  {fmtRatio(item.value)}
                </span>
                <span className="text-right font-mono text-[10px] font-semibold tabular-nums text-[var(--color-text-tertiary)]">
                  {fmtCount(item.count)}/{fmtCount(data.count)}
                </span>
              </dd>
            </div>
          ))}
        </dl>
        <div className="mt-2.5 text-[10px] font-semibold tabular-nums text-[var(--color-text-tertiary)]">
          PMS基準日 <span className="font-mono font-bold text-[var(--color-text-secondary)]">{data.date ?? '---'}</span> · {fmtCount(data.count)}銘柄の分布 · 縦線は50%
          {dateMismatch && (
            <span className="ml-1 font-bold text-[#b45309]">（表示基準日と異なります）</span>
          )}
        </div>
      </div>

      {/* 2. 市場区分 */}
      <div className="min-w-0 border-t border-[var(--color-border-soft)] px-4 pb-4 pt-3 lg:border-l lg:border-t-0">
        <GroupLabel meta="PMSプラス比率 · 区分判定" className="mb-1.5">市場区分</GroupLabel>
        {data.sortedSegments.length === 0 ? (
          <p className="py-3 text-[11px] font-semibold text-[var(--color-text-tertiary)]">区分別に集計できる銘柄がありません</p>
        ) : (
          <ol className="divide-y divide-[var(--color-border-soft)] border-y border-[var(--color-border-soft)]">
            {data.sortedSegments.map((segment) => {
              const pmsPlus = ratio(segment.positivePms, segment.count)
              const pfsPlus = ratio(segment.positivePfs, segment.count)
              const segmentReading = groupReading(segment)
              return (
                <li key={segment.label}>
                  <Link
                    href={marketMomentumHrefForSegment(segment.label, segment.code, date)}
                    prefetch={false}
                    className="block py-1.5 transition-colors hover:bg-[var(--color-surface-subtle)]"
                    aria-label={`${segment.label}の銘柄別モメンタムを見る`}
                  >
                    <span className="grid grid-cols-[5.75rem_minmax(0,1fr)_3.25rem_4.25rem] items-center gap-x-3">
                      <span className="min-w-0 truncate text-[12px] font-semibold text-[var(--color-text-primary)]">{segment.label}</span>
                      <MeterBar value={pmsPlus} tone={pmsPlus != null && pmsPlus >= 50 ? 'up' : 'down'} midTick />
                      <span className="text-right font-mono text-[12px] font-bold tabular-nums text-[var(--color-text-primary)]">{fmtRatio(pmsPlus)}</span>
                      <ToneLabel tone={segmentReading.tone} className="justify-self-end">{segmentReading.label}</ToneLabel>
                    </span>
                    <span className="mt-0.5 block pl-[6.5rem] font-mono text-[9px] font-semibold tabular-nums text-[var(--color-text-tertiary)]">
                      初動+ {fmtRatio(pfsPlus)} · 強 {fmtCount(segment.strongPms)} · 弱 {fmtCount(segment.weakPms)} · {fmtCount(segment.count)}銘柄
                    </span>
                  </Link>
                </li>
              )
            })}
          </ol>
        )}
      </div>

      {/* 3. 今日の変化 */}
      <div className="min-w-0 border-t border-[var(--color-border-soft)] px-4 pb-4 pt-3 md:border-l lg:border-t-0">
        <GroupLabel meta="当日のPFS/PMS分布から" className="mb-1.5">今日の変化</GroupLabel>
        <dl className="divide-y divide-[var(--color-border-soft)] border-y border-[var(--color-border-soft)]">
          <ChangeRow label="初動" hint="PFS上位" tone="warning">
            <TickerList rows={data.initialRows.slice(0, 3)} date={date} />
          </ChangeRow>
          <ChangeRow label="失速" hint="PFS悪化" tone="down">
            <TickerList rows={data.stallRows.slice(0, 3)} date={date} />
          </ChangeRow>
          <ChangeRow label="強い業種" hint="PMS+比率 上位" tone="up">
            <SectorList rows={strongSectors} />
          </ChangeRow>
          <ChangeRow label="弱い業種" hint="PMS+比率 下位" tone="down">
            <SectorList rows={weakSectors} />
          </ChangeRow>
        </dl>
        <a href="#dashboard-section-momentum" className="mt-2 inline-flex items-center gap-1 text-[11px] font-bold text-[var(--color-brand-700)] hover:underline">
          市場マップで4レーンと17業種を見る
          <ArrowDown size={12} aria-hidden="true" />
        </a>
      </div>
    </div>
  )
}

function ChangeRow({
  label,
  hint,
  tone,
  children,
}: {
  label: string
  hint: string
  tone: DashboardTone
  children: React.ReactNode
}) {
  return (
    <div className="grid grid-cols-[4.75rem_minmax(0,1fr)] gap-x-3 py-1.5">
      <dt className="min-w-0">
        <div className={`text-[12px] font-bold ${TONE_TEXT[tone]}`}>{label}</div>
        <div className="text-[9px] font-semibold text-[var(--color-text-tertiary)]">{hint}</div>
      </dt>
      <dd className="min-w-0">{children}</dd>
    </div>
  )
}

function TickerList({ rows, date }: { rows: MomentumRankingRow[]; date: string | null }) {
  if (rows.length === 0) {
    return <span className="text-[11px] font-semibold text-[var(--color-text-tertiary)]">該当なし</span>
  }
  return (
    <ul className="grid gap-0.5">
      {rows.map((row) => (
        <li key={row.ticker} className="grid grid-cols-[3rem_minmax(0,1fr)_3.75rem] items-baseline gap-x-2">
          <Link href={stockDetailHref(row.ticker, date)} prefetch={false} className="font-mono text-[11px] font-bold text-[var(--color-brand-800)] hover:underline">
            {row.ticker}
          </Link>
          <span className="min-w-0 truncate text-[11px] font-semibold text-[var(--color-text-primary)]">{row.name ?? row.ticker}</span>
          <span className={`text-right font-mono text-[10px] font-bold tabular-nums ${signedTextClass(row.changePct)}`}>{fmtPct(row.changePct)}</span>
        </li>
      ))}
    </ul>
  )
}

function SectorList({ rows }: { rows: Array<{ label: string; positivePms: number; count: number }> }) {
  if (rows.length === 0) {
    return <span className="text-[11px] font-semibold text-[var(--color-text-tertiary)]">該当なし</span>
  }
  return (
    <ul className="grid gap-0.5">
      {rows.map((row) => (
        <li key={row.label} className="grid grid-cols-[minmax(0,1fr)_3.75rem] items-baseline gap-x-2">
          <span className="min-w-0 truncate text-[11px] font-semibold text-[var(--color-text-primary)]">{row.label}</span>
          <span className="text-right font-mono text-[11px] font-bold tabular-nums text-[var(--color-text-primary)]">{fmtRatio(ratio(row.positivePms, row.count))}</span>
        </li>
      ))}
    </ul>
  )
}

/* ---------- 今日の確認事項 ---------- */

function AgendaCell({
  title,
  meta,
  href,
  linkLabel,
  bordered = false,
  children,
}: {
  title: string
  meta?: React.ReactNode
  href: string
  linkLabel: string
  bordered?: boolean
  children: React.ReactNode
}) {
  return (
    <div className={`min-w-0 px-4 py-2.5 ${bordered ? 'border-t border-[var(--color-border-soft)] md:border-l md:border-t-0' : ''}`}>
      <div className="flex items-baseline justify-between gap-2">
        <div className="flex min-w-0 items-baseline gap-2">
          <span className="text-[12px] font-bold text-[var(--color-brand-900)]">{title}</span>
          {meta != null && <span className="truncate text-[10px] font-semibold text-[var(--color-text-tertiary)]">{meta}</span>}
        </div>
        <a href={href} className="inline-flex shrink-0 items-center gap-0.5 text-[10px] font-bold text-[var(--color-brand-700)] hover:underline">
          {linkLabel}
          <ArrowDown size={11} aria-hidden="true" />
        </a>
      </div>
      <div className="mt-1 flex min-h-[38px] flex-wrap items-end gap-x-5 gap-y-1">{children}</div>
    </div>
  )
}

function AgendaFigure({ label, value, tone }: { label: string; value: number; tone: DashboardTone }) {
  return (
    <div className="min-w-0">
      <div className="text-[10px] font-semibold text-[var(--color-text-tertiary)]">{label}</div>
      <div className={`font-mono text-[18px] font-bold leading-tight tabular-nums ${value > 0 ? TONE_TEXT[tone] : 'text-[var(--color-text-tertiary)]'}`}>
        {value.toLocaleString('ja-JP')}
      </div>
    </div>
  )
}

function AgendaUnavailable({ text }: { text: string }) {
  return <span className="text-[11px] font-semibold text-[var(--color-text-tertiary)]">{text}</span>
}

async function SignalsAgenda({
  date,
  universe,
  scenarioInterval,
}: {
  date: string | null
  universe: UniverseFilterValue
  scenarioInterval: string | null
}) {
  try {
    const data = await loadDashboardTradeSignals(date, universe, scenarioInterval)
    const buy = data.rows.filter((row) => row.side === 'buy').length
    const sell = data.rows.filter((row) => row.side === 'sell').length
    const high = data.rows.filter((row) => row.confidenceBand === 'high').length
    return (
      <AgendaCell title="売買候補" meta={`${data.scenarioIntervalLabel}シナリオ`} href="#trade-signals" linkLabel="一覧">
        <AgendaFigure label="買う" value={buy} tone="up" />
        <AgendaFigure label="売る" value={sell} tone="down" />
        <AgendaFigure label="高確度" value={high} tone="neutral" />
      </AgendaCell>
    )
  } catch {
    return (
      <AgendaCell title="売買候補" href="#trade-signals" linkLabel="一覧">
        <AgendaUnavailable text="件数を取得できませんでした" />
      </AgendaCell>
    )
  }
}

async function ScenarioAgenda() {
  try {
    const { summary } = await loadTradeScenarioOverview(null)
    return (
      <AgendaCell title="シナリオ進捗" meta={`全${summary.total.toLocaleString('ja-JP')}件`} href="#dashboard-section-trade-overview" linkLabel="進捗" bordered>
        <AgendaFigure label="要確認" value={summary.attention} tone="warning" />
        <AgendaFigure label="目標到達" value={summary.targetHit} tone="up" />
        <AgendaFigure label="撤退条件" value={summary.stopHit} tone="down" />
      </AgendaCell>
    )
  } catch {
    return (
      <AgendaCell title="シナリオ進捗" href="#dashboard-section-trade-overview" linkLabel="進捗" bordered>
        <AgendaUnavailable text="件数を取得できませんでした" />
      </AgendaCell>
    )
  }
}

async function EarningsAgenda({ universe }: { universe: UniverseFilterValue }) {
  try {
    const data = await loadDashboardEarningsAlerts(null, universe)
    const { upcoming, signalCount } = rankEarningsAlerts(data.rows, data.completedRows)
    const first = upcoming[0]
    return (
      <AgendaCell title="決算注意" meta={data.windowStart && data.windowEnd ? `${data.windowStart.slice(5)}〜${data.windowEnd.slice(5)}` : undefined} href="#dashboard-section-events" linkLabel="決算・材料" bordered>
        <AgendaFigure label="注意ラベルあり" value={signalCount} tone="warning" />
        <div className="min-w-0 flex-1">
          <div className="text-[10px] font-semibold text-[var(--color-text-tertiary)]">注意順 1位</div>
          {first ? (
            <div className="flex min-w-0 items-baseline gap-1.5 text-[12px]">
              <Link href={`/stock/${encodeURIComponent(first.ticker)}`} prefetch={false} className="shrink-0 font-mono font-bold text-[var(--color-brand-800)] hover:underline">
                {first.ticker}
              </Link>
              <span className="min-w-0 truncate font-semibold text-[var(--color-text-primary)]">{first.name ?? first.ticker}</span>
              <span className={`shrink-0 font-mono text-[11px] font-bold tabular-nums ${first.daysLeft <= 1 ? 'text-[#b45309]' : 'text-[var(--color-text-secondary)]'}`}>
                {daysLeftText(first.daysLeft)}
              </span>
            </div>
          ) : (
            <div className="text-[12px] font-semibold text-[var(--color-text-tertiary)]">予定なし</div>
          )}
        </div>
      </AgendaCell>
    )
  } catch {
    return (
      <AgendaCell title="決算注意" href="#dashboard-section-events" linkLabel="決算・材料" bordered>
        <AgendaUnavailable text="件数を取得できませんでした" />
      </AgendaCell>
    )
  }
}
