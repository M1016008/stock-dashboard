import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { ArrowLeft, ExternalLink } from 'lucide-react'
import { CandlestickChart } from '@/components/charts/CandlestickChart'
import { PageTitle } from '@/components/layout/PageTitle'
import { SectionHeader } from '@/components/ui/SectionHeader'
import { StatStrip } from '@/components/ui/StatStrip'
import { EmptyState, Notice } from '@/components/ui/EmptyState'
import { StageDots } from '@/components/ui/StageDots'
import { isValidTickerForMarket } from '@/lib/markets'
import { getSectorEtfDetail, type SectorEtfHolding, type SectorEtfMetric } from '@/lib/queries/sector-etfs'

export const dynamic = 'force-dynamic'
export const revalidate = 0
export const fetchCache = 'force-no-store'

type PageProps = {
  params: Promise<{ ticker: string }>
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { ticker } = await params
  const detail = await getSectorEtfDetail(ticker)
  if (!detail) return { title: 'ETF詳細 — StockBoard' }
  return {
    title: `${detail.metric.ticker} ${detail.metric.shortName} — 業界ETF分析`,
    description: `${detail.metric.shortName}の構成銘柄、チャート、6ステージ、MA分析`,
  }
}

function fmtPrice(value: number | null | undefined) {
  if (value == null || !Number.isFinite(value)) return '---'
  return value.toLocaleString('ja-JP', { maximumFractionDigits: 1 })
}

function fmtPct(value: number | null | undefined) {
  if (value == null || !Number.isFinite(value)) return '---'
  return `${value > 0 ? '+' : ''}${value.toFixed(2)}%`
}

function fmtPctPoint(value: number | null | undefined) {
  if (value == null || !Number.isFinite(value)) return '---'
  return `${value > 0 ? '+' : ''}${value.toFixed(2)}pt`
}

function fmtAngle(value: number | null | undefined) {
  if (value == null || !Number.isFinite(value)) return '---'
  return `${value > 0 ? '+' : ''}${value}°`
}

function fmtContributionAmount(value: number | null | undefined) {
  if (value == null || !Number.isFinite(value)) return '---'
  const sign = value > 0 ? '+' : value < 0 ? '-' : ''
  return `${sign}¥${Math.abs(value).toLocaleString('ja-JP', { maximumFractionDigits: 2 })}`
}

function pctTone(value: number | null | undefined) {
  if (value == null || !Number.isFinite(value)) return 'text-[var(--color-text-secondary)]'
  if (value > 0) return 'text-[var(--color-price-up)]'
  if (value < 0) return 'text-[var(--color-price-down)]'
  return 'text-[var(--color-text-secondary)]'
}

function trendTone(label: SectorEtfHolding['trendLabel']) {
  if (label === '上昇') return 'border-[#f0b8b8] bg-[var(--color-price-up-bg)] text-[var(--color-price-up-mid)]'
  if (label === '下落') return 'border-[#b9d3f0] bg-[var(--color-price-down-bg)] text-[var(--color-price-down-mid)]'
  if (label === '横ばい') return 'border-[var(--color-border-default)] bg-white text-[var(--color-text-secondary)]'
  return 'border-[var(--color-border-soft)] bg-[var(--color-surface-subtle)] text-[var(--color-text-tertiary)]'
}

function canLinkHolding(ticker: string) {
  return isValidTickerForMarket(ticker, 'JP')
}

function HoldingName({ holding }: { holding: SectorEtfHolding }) {
  if (!canLinkHolding(holding.holdingTicker)) {
    return (
      <span className="font-bold text-[var(--color-text-primary)]">
        {holding.holdingName}
      </span>
    )
  }
  return (
    <Link
      href={`/stock/${encodeURIComponent(holding.holdingTicker)}`}
      className="font-bold text-[var(--color-brand-700)] underline-offset-2 hover:underline"
    >
      {holding.holdingName}
    </Link>
  )
}

function ContributionSummary({ holdings }: { holdings: SectorEtfHolding[] }) {
  const ranked = holdings.filter((holding) => holding.contributionPctPoint != null)
  const leaders = [...ranked]
    .filter((holding) => (holding.contributionPctPoint ?? 0) > 0)
    .sort((a, b) => (b.contributionPctPoint ?? 0) - (a.contributionPctPoint ?? 0))
    .slice(0, 5)
  const laggards = [...ranked]
    .filter((holding) => (holding.contributionPctPoint ?? 0) < 0)
    .sort((a, b) => (a.contributionPctPoint ?? 0) - (b.contributionPctPoint ?? 0))
    .slice(0, 5)
  const blocks = [
    { title: '上昇寄与', rows: leaders, empty: '上昇寄与は未算出' },
    { title: '下落寄与', rows: laggards, empty: '下落寄与は未算出' },
  ]
  return (
    <div className="mb-4 grid grid-cols-1 gap-3 lg:grid-cols-2">
      {blocks.map((block) => (
        <div key={block.title} className="panel">
          <div className="panel-head">
            <h3>{block.title}</h3>
            <span className="text-[11px] text-[var(--color-text-tertiary)]">上位5銘柄</span>
          </div>
          {block.rows.length > 0 ? (
            <div className="divide-y divide-[var(--color-border-soft)]">
              {block.rows.map((holding) => (
                <div key={`${block.title}-${holding.id}`} className="flex items-center justify-between gap-3 px-3 py-2">
                  <div className="min-w-0">
                    <div className="truncate text-[12px] font-bold text-[var(--color-text-primary)]">
                      {holding.holdingTicker} {holding.holdingName}
                    </div>
                    <div className="text-[10px] font-semibold text-[var(--color-text-tertiary)]">
                      組入 {fmtPct(holding.weightPct)} / 騰落 {fmtPct(holding.changePct)}
                    </div>
                  </div>
                  <div className={`shrink-0 text-right font-mono text-[12px] font-bold ${pctTone(holding.contributionPctPoint)}`}>
                    {fmtPctPoint(holding.contributionPctPoint)}
                    <div className="text-[10px] font-semibold">{fmtContributionAmount(holding.contributionAmount)}</div>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="px-3 py-5 text-center text-[12px] text-[var(--color-text-tertiary)]">
              {block.empty}
            </div>
          )}
        </div>
      ))}
    </div>
  )
}

function StageCell({ holding }: { holding: SectorEtfHolding }) {
  const values = [
    holding.stages.dailyA,
    holding.stages.dailyB,
    holding.stages.weeklyA,
    holding.stages.weeklyB,
    holding.stages.monthlyA,
    holding.stages.monthlyB,
  ]
  if (holding.stageCode == null) return <span className="text-[var(--color-text-tertiary)]">---</span>
  return (
    <div className="space-y-1">
      <StageDots values={values} size={18} />
      <div className="font-mono text-[11px] font-bold text-[var(--color-brand-900)]">{holding.stageCode}</div>
    </div>
  )
}

function MaHoldingCell({ holding }: { holding: SectorEtfHolding }) {
  const angles = [
    ['5日', holding.maAngles.daily5],
    ['25日', holding.maAngles.daily25],
    ['75日', holding.maAngles.daily75],
  ] as const
  return (
    <div className="space-y-1">
      <div className="max-w-[210px] truncate text-[11px] font-bold text-[var(--color-text-primary)]">
        {holding.maOrderDaily ?? 'MA不足'}
      </div>
      <div className="flex flex-wrap gap-1">
        {angles.map(([label, angle]) => (
          <span
            key={`${holding.id}-${label}`}
            className={`rounded-[3px] border border-[var(--color-border-soft)] bg-white px-1.5 py-0.5 font-mono text-[10px] font-bold ${pctTone(angle)}`}
          >
            {label} {fmtAngle(angle)}
          </span>
        ))}
      </div>
      <div className="max-w-[210px] truncate text-[10px] font-semibold text-[var(--color-text-tertiary)]">
        週 {holding.maOrderWeekly ?? '-'} / 月 {holding.maOrderMonthly ?? '-'}
      </div>
    </div>
  )
}

function HoldingsTable({ rows }: { rows: SectorEtfHolding[] }) {
  return (
    <>
    <div className="panel hidden md:block">
     <div className="table-scroll">
      <table className="w-full min-w-[1280px] text-[12px]">
        <thead>
          <tr className="border-b border-[var(--color-border-default)] text-left text-[11px] font-bold">
            <th className="py-2 pl-3 pr-2">順位</th>
            <th className="py-2 pr-2">コード</th>
            <th className="py-2 pr-2">構成銘柄</th>
            <th className="py-2 pr-2 text-right">組入比率</th>
            <th className="py-2 pr-2 text-right">騰落率</th>
            <th className="py-2 pr-2">6ステージ</th>
            <th className="py-2 pr-2">直近遷移</th>
            <th className="py-2 pr-2 text-right">ETF寄与</th>
            <th className="py-2 pr-2 text-right">寄与幅</th>
            <th className="py-2 pr-2">トレンド</th>
            <th className="py-2 pr-3">MA並び・角度</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-[var(--color-border-soft)]">
          {rows.map((holding, index) => (
            <tr key={`${holding.id}-${holding.holdingTicker}`} className="align-top hover:bg-[#fff8e6]">
              <td className="py-2 pl-3 pr-2 text-[var(--color-text-tertiary)] tabular-nums">
                {index + 1}
              </td>
              <td className="py-2 pr-2 font-mono font-bold text-[var(--color-text-secondary)]">
                {holding.holdingTicker}
              </td>
              <td className="max-w-[340px] truncate py-2 pr-2">
                <HoldingName holding={holding} />
              </td>
              <td className="py-2 pr-2 text-right font-mono font-bold text-[var(--color-brand-900)]">
                {fmtPct(holding.weightPct)}
              </td>
              <td className={`py-2 pr-2 text-right font-mono font-bold ${pctTone(holding.changePct)}`}>
                {fmtPct(holding.changePct)}
                <div className="text-[10px] font-semibold text-[var(--color-text-tertiary)]">
                  {fmtPrice(holding.price)}
                </div>
              </td>
              <td className="py-2 pr-2">
                <StageCell holding={holding} />
              </td>
              <td className="py-2 pr-2 font-mono text-[12px] font-bold text-[var(--color-text-primary)]">
                {holding.dailyStageTransition ?? '---'}
              </td>
              <td className={`py-2 pr-2 text-right font-mono font-bold ${pctTone(holding.contributionPctPoint)}`}>
                {fmtPctPoint(holding.contributionPctPoint)}
                <div className="text-[10px] font-semibold text-[var(--color-text-tertiary)]">
                  {holding.contributionSharePct == null ? 'ETF比 ---' : `ETF比 ${fmtPct(holding.contributionSharePct)}`}
                </div>
              </td>
              <td className={`py-2 pr-2 text-right font-mono font-bold ${pctTone(holding.contributionAmount)}`}>
                {fmtContributionAmount(holding.contributionAmount)}
              </td>
              <td className="py-2 pr-2">
                <span className={`inline-flex rounded-[4px] border px-1.5 py-0.5 text-[11px] font-bold ${trendTone(holding.trendLabel)}`}>
                  {holding.trendLabel}
                </span>
              </td>
              <td className="py-2 pr-3">
                <MaHoldingCell holding={holding} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
     </div>
    </div>

    <ol className="panel m-0 list-none divide-y divide-[var(--color-border-soft)] p-0 md:hidden" aria-label="構成銘柄">
      {rows.map((holding, index) => (
        <li key={`${holding.id}-${holding.holdingTicker}-m`} className="px-3 py-2.5">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="text-[11px] tabular-nums text-[var(--color-text-tertiary)]">
                {index + 1}位 · <span className="font-mono">{holding.holdingTicker}</span> · 組入 {fmtPct(holding.weightPct)}
              </div>
              <div className="truncate text-[13px]"><HoldingName holding={holding} /></div>
            </div>
            <div className="shrink-0 text-right font-mono tabular-nums">
              <div className={`text-[13px] font-bold ${pctTone(holding.changePct)}`}>{fmtPct(holding.changePct)}</div>
              <div className={`text-[11px] ${pctTone(holding.contributionPctPoint)}`}>寄与 {fmtPctPoint(holding.contributionPctPoint)}</div>
            </div>
          </div>
          <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px]">
            <StageCell holding={holding} />
            <span className={`inline-flex rounded-[4px] border px-1.5 py-0.5 font-bold ${trendTone(holding.trendLabel)}`}>{holding.trendLabel}</span>
            <span className="min-w-0 truncate text-[var(--color-text-secondary)]">{holding.maOrderDaily ?? 'MA不足'}</span>
          </div>
        </li>
      ))}
    </ol>
    </>
  )
}

const STAGE_AXES = ['日足A', '日足B', '週足A', '週足B', '月足A', '月足B'] as const

function StagePanel({ metric }: { metric: SectorEtfMetric }) {
  const values = [
    metric.stages.dailyA,
    metric.stages.dailyB,
    metric.stages.weeklyA,
    metric.stages.weeklyB,
    metric.stages.monthlyA,
    metric.stages.monthlyB,
  ]
  return (
    <section className="min-w-0">
      <SectionHeader
        as="h3"
        title="6ステージ"
        description={<span className="tabular-nums">判定日 {metric.stageDate ?? '—'} · コード {metric.stageCode ?? '—'}</span>}
      />
      <dl className="grid grid-cols-6 gap-1.5">
        {STAGE_AXES.map((label, index) => {
          const value = values[index]
          return (
            <div key={label} className="min-w-0 text-center">
              <dt className="text-[10px] text-[var(--color-text-tertiary)]">{label}</dt>
              <dd
                className="m-0 mt-1 rounded-[4px] py-1.5 font-mono text-[15px] font-bold tabular-nums"
                style={{
                  background: value ? `var(--color-stage-${value}-bg)` : 'var(--color-surface-subtle)',
                  color: value ? `var(--color-stage-${value}-text)` : 'var(--color-text-tertiary)',
                }}
              >
                {value ?? '—'}
              </dd>
            </div>
          )
        })}
      </dl>
      <p className="mt-2 text-[12px] text-[var(--color-text-secondary)]">
        MAトレンド <strong className="text-[var(--color-text-primary)]">{metric.maTrendLabel}</strong>
      </p>
    </section>
  )
}

function MaPanel({ metric }: { metric: SectorEtfMetric }) {
  const rows = [
    { label: '日足', order: metric.maOrderDaily, angles: [metric.maAngles.daily5, metric.maAngles.daily25, metric.maAngles.daily75], names: ['5日', '25日', '75日'] },
    { label: '週足', order: metric.maOrderWeekly, angles: [metric.maAngles.weekly5, metric.maAngles.weekly13, metric.maAngles.weekly25], names: ['5週', '13週', '25週'] },
    { label: '月足', order: metric.maOrderMonthly, angles: [metric.maAngles.monthly3, metric.maAngles.monthly5, metric.maAngles.monthly10], names: ['3月', '5月', '10月'] },
  ]
  return (
    <section className="min-w-0">
      <SectionHeader as="h3" title="移動平均" description="並び順と角度（短期・中期・長期）" />
      <div className="divide-y divide-[var(--color-border-soft)] border-b border-[var(--color-border-soft)]">
        {rows.map((row) => (
          <div key={row.label} className="grid grid-cols-[40px_minmax(0,1fr)] gap-x-3 gap-y-1.5 py-2">
            <span className="text-[12px] font-bold text-[var(--color-text-primary)]">{row.label}</span>
            <span className="min-w-0 truncate text-[12px] text-[var(--color-text-secondary)]" title={row.order ?? undefined}>{row.order ?? 'MA不足'}</span>
            <div className="col-start-2 grid grid-cols-3 gap-1.5">
              {row.angles.map((angle, index) => (
                <span key={`${row.label}-${row.names[index]}`} className="flex items-baseline justify-between gap-1 rounded-[4px] bg-[var(--color-surface-subtle)] px-2 py-1">
                  <span className="text-[10px] text-[var(--color-text-tertiary)]">{row.names[index]}</span>
                  <span className={`font-mono text-[12px] font-bold tabular-nums ${pctTone(angle)}`}>
                    {angle == null ? '---' : `${angle > 0 ? '+' : ''}${angle}°`}
                  </span>
                </span>
              ))}
            </div>
          </div>
        ))}
      </div>
    </section>
  )
}

function ChartBlock({ title, hint, children }: { title: string; hint: string; children: React.ReactNode }) {
  return (
    <div className="panel">
      <div className="panel-head">
        <h3>{title}</h3>
        <span className="text-[11px] text-[var(--color-text-tertiary)]">{hint}</span>
      </div>
      <div className="p-2">{children}</div>
    </div>
  )
}

export default async function SectorEtfDetailPage({ params }: PageProps) {
  const { ticker } = await params
  const detail = await getSectorEtfDetail(ticker)
  if (!detail) notFound()

  const { metric, holdings, sourceGuide } = detail
  const topHoldings = holdings.slice(0, 20)

  return (
    <div className="sb-page">
      <PageTitle
        eyebrow="業界ETF分析"
        title={`${metric.ticker} ${metric.shortName}`}
        subtitle={metric.description ?? metric.displayName}
        meta={<>
          <span>{metric.group} · {metric.theme}</span>
          <span>運用 {metric.provider.toUpperCase()}</span>
          <span>価格 <strong className="font-semibold text-[var(--color-text-primary)]">{metric.priceDate ?? '—'}</strong></span>
          <span>構成 <strong className="font-semibold text-[var(--color-text-primary)]">{metric.holdings.asOfDate ?? '未取得'}</strong></span>
        </>}
        rightSlot={<>
          <Link href="/sector-etfs" className="btn">
            <ArrowLeft size={13} aria-hidden /> 一覧へ
          </Link>
          <Link href={metric.sourceUrl} target="_blank" rel="noreferrer" className="btn">
            公式情報 <ExternalLink size={13} aria-hidden />
          </Link>
        </>}
      />

      <StatStrip
        label="ETFの現況"
        items={[
          { label: '現在価格', value: fmtPrice(metric.price) },
          { label: '前日比', value: fmtPct(metric.changePct), tone: metric.changePct == null ? 'muted' : metric.changePct > 0 ? 'up' : metric.changePct < 0 ? 'down' : undefined },
          { label: '6ステージ', value: <span className="font-mono">{metric.stageCode ?? '—'}</span>, sub: metric.maTrendLabel },
          { label: '構成銘柄', value: `${metric.holdings.count.toLocaleString()}件`, sub: metric.holdings.asOfDate ?? '未取得' },
          { label: '取得ソース', value: <span className="text-[14px]">{sourceGuide}</span> },
        ]}
      />

      {metric.holdings.lastRunStatus === 'failed' && (
        <Notice tone="error" title="構成銘柄の取得に失敗しました">
          {metric.holdings.lastRunError ?? '原因は記録されていません。'}
        </Notice>
      )}
      {metric.holdings.count === 0 && metric.holdings.lastRunStatus !== 'failed' && (
        <Notice tone="neutral">
          構成銘柄は未取得です。チャート・6ステージ・移動平均は価格データから表示します。
        </Notice>
      )}

      <div className="grid min-w-0 grid-cols-1 gap-5 xl:grid-cols-[minmax(0,1fr)_380px]">
        <ChartBlock title="日足" hint="5日 / 25日 / 75日 MA">
          <CandlestickChart ticker={metric.ticker} interval="D" height={420} maLines={[5, 25, 75]} />
        </ChartBlock>
        <div className="flex min-w-0 flex-col gap-5">
          <StagePanel metric={metric} />
          <MaPanel metric={metric} />
        </div>
      </div>

      <section className="min-w-0">
        <SectionHeader
          level={1}
          title="構成銘柄と寄与"
          description={holdings.length > 0 ? `${metric.holdings.asOfDate ?? '日付不明'} · 寄与は組入比率と直近騰落率からの概算` : '構成銘柄未取得'}
          actions={holdings.length > 0 ? <span className="text-[12px] tabular-nums text-[var(--color-text-tertiary)]">{holdings.length.toLocaleString()}件</span> : undefined}
        />
        {topHoldings.length > 0 ? (
          <>
            <ContributionSummary holdings={holdings} />
            <HoldingsTable rows={topHoldings} />
            {holdings.length > topHoldings.length && (
              <details className="group mt-3">
                <summary className="inline-flex min-h-9 cursor-pointer list-none items-center gap-1.5 text-[12px] font-bold text-[var(--color-brand-700)] hover:text-[var(--color-brand-900)] [&::-webkit-details-marker]:hidden">
                  <span aria-hidden className="inline-block transition-transform group-open:rotate-90">▸</span>
                  全{holdings.length.toLocaleString()}件を表示
                </summary>
                <div className="mt-2">
                  <HoldingsTable rows={holdings} />
                </div>
              </details>
            )}
          </>
        ) : (
          <EmptyState
            className="rounded-[6px] border border-dashed border-[var(--color-border-default)] bg-[var(--color-surface-subtle)]"
            title="構成銘柄は未取得です"
            description="取得後に、組入比率・騰落率・寄与を表示します。"
          />
        )}
      </section>

      <section className="min-w-0">
        <SectionHeader level={1} title="中長期チャート" description="個別銘柄と同じローソク足・MAロジック" />
        <div className="grid grid-cols-1 gap-4 2xl:grid-cols-2">
          <ChartBlock title="週足" hint="13週 / 26週 / 52週 MA">
            <CandlestickChart ticker={metric.ticker} interval="W" height={380} maLines={[13, 26, 52]} />
          </ChartBlock>
          <ChartBlock title="月足" hint="12月 / 24月 / 60月 MA">
            <CandlestickChart ticker={metric.ticker} interval="M" height={380} maLines={[12, 24, 60]} />
          </ChartBlock>
        </div>
      </section>
    </div>
  )
}
