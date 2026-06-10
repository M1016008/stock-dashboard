import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { ArrowLeft, ExternalLink } from 'lucide-react'
import { CandlestickChart } from '@/components/charts/CandlestickChart'
import { PageTitle } from '@/components/layout/PageTitle'
import { Card, CardHeader } from '@/components/ui/Card'
import { StageDots } from '@/components/ui/StageDots'
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

function fmtNumber(value: number | null | undefined) {
  if (value == null || !Number.isFinite(value)) return '---'
  return Math.round(value).toLocaleString('ja-JP')
}

function pctTone(value: number | null | undefined) {
  if (value == null || !Number.isFinite(value)) return 'text-[var(--color-text-secondary)]'
  if (value > 0) return 'text-[var(--color-price-up)]'
  if (value < 0) return 'text-[var(--color-price-down)]'
  return 'text-[var(--color-text-secondary)]'
}

function canLinkHolding(ticker: string) {
  return /^\d{4}[A-Z]?$/.test(ticker)
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
      className="font-bold text-[var(--color-brand-800)] underline-offset-2 hover:text-[var(--color-market-red)] hover:underline"
    >
      {holding.holdingName}
    </Link>
  )
}

function HoldingsTable({ rows, compact = false }: { rows: SectorEtfHolding[]; compact?: boolean }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[720px] text-[12px]">
        <thead>
          <tr className="border-b border-[var(--color-border-soft)] bg-[var(--color-surface-subtle)] text-left text-[10px] font-bold text-[var(--color-text-tertiary)]">
            <th className="py-2 pl-3 pr-2">順位</th>
            <th className="py-2 pr-2">コード</th>
            <th className="py-2 pr-2">構成銘柄</th>
            <th className="py-2 pr-2 text-right">組入比率</th>
            <th className="py-2 pr-2 text-right">株数</th>
            <th className="py-2 pr-3 text-right">評価額</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-[var(--color-border-soft)]">
          {rows.map((holding, index) => (
            <tr key={`${holding.id}-${holding.holdingTicker}`}>
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
              <td className="py-2 pr-2 text-right font-mono text-[var(--color-text-secondary)]">
                {compact ? '---' : fmtNumber(holding.shares)}
              </td>
              <td className="py-2 pr-3 text-right font-mono text-[var(--color-text-secondary)]">
                {compact ? '---' : fmtNumber(holding.marketValue)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function InfoCell({ label, value, tone }: { label: string; value: React.ReactNode; tone?: string }) {
  return (
    <div className="rounded-[6px] border border-[var(--color-border-soft)] bg-[var(--color-surface-subtle)] px-3 py-2">
      <div className="text-[10px] font-bold text-[var(--color-text-tertiary)]">{label}</div>
      <div className={`mt-1 text-[13px] font-bold tabular-nums ${tone ?? 'text-[var(--color-text-primary)]'}`}>{value}</div>
    </div>
  )
}

function StagePanel({ metric }: { metric: SectorEtfMetric }) {
  const values = [
    ['日足A', metric.stages.dailyA],
    ['日足B', metric.stages.dailyB],
    ['週足A', metric.stages.weeklyA],
    ['週足B', metric.stages.weeklyB],
    ['月足A', metric.stages.monthlyA],
    ['月足B', metric.stages.monthlyB],
  ] as const
  return (
    <Card size="sm">
      <CardHeader title="6ステージ分析" hint={`判定日 ${metric.stageDate ?? '---'} / コード ${metric.stageCode ?? '---'}`} />
      <div className="flex flex-wrap items-center gap-3">
        <StageDots values={values.map(([, value]) => value)} size={26} />
        <span className="rounded-full border border-[var(--color-border-default)] bg-white px-3 py-1 text-[12px] font-bold text-[var(--color-brand-800)]">
          {metric.maTrendLabel}
        </span>
      </div>
      <div className="mt-4 grid grid-cols-2 gap-2 md:grid-cols-3 xl:grid-cols-6">
        {values.map(([label, value]) => (
          <InfoCell key={label} label={label} value={value ?? '---'} />
        ))}
      </div>
    </Card>
  )
}

function MaPanel({ metric }: { metric: SectorEtfMetric }) {
  const rows = [
    { label: '日足', order: metric.maOrderDaily, angles: [metric.maAngles.daily5, metric.maAngles.daily25, metric.maAngles.daily75], names: ['5日', '25日', '75日'] },
    { label: '週足', order: metric.maOrderWeekly, angles: [metric.maAngles.weekly5, metric.maAngles.weekly13, metric.maAngles.weekly25], names: ['5週', '13週', '25週'] },
    { label: '月足', order: metric.maOrderMonthly, angles: [metric.maAngles.monthly3, metric.maAngles.monthly5, metric.maAngles.monthly10], names: ['3月', '5月', '10月'] },
  ]
  return (
    <Card size="sm">
      <CardHeader title="MA分析" hint="移動平均線の並び、向き、角度を日足・週足・月足で確認します。" />
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-3">
        {rows.map((row) => (
          <div key={row.label} className="rounded-[8px] border border-[var(--color-border-soft)] bg-[var(--color-surface-subtle)] p-3">
            <h3 className="text-[13px] font-bold text-[var(--color-brand-900)]">{row.label}</h3>
            <div className="mt-2 text-[12px] font-bold text-[var(--color-text-primary)]">{row.order ?? 'MA不足'}</div>
            <div className="mt-3 grid grid-cols-3 gap-2">
              {row.angles.map((angle, index) => (
                <div key={`${row.label}-${row.names[index]}`} className="rounded-[6px] border border-[var(--color-border-soft)] bg-white px-2 py-2 text-center">
                  <div className="text-[10px] font-bold text-[var(--color-text-tertiary)]">{row.names[index]}</div>
                  <div className={`mt-1 font-mono text-[12px] font-bold ${pctTone(angle)}`}>
                    {angle == null ? '---' : `${angle > 0 ? '+' : ''}${angle}°`}
                  </div>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </Card>
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
        title={`${metric.ticker} ${metric.shortName}`}
        subtitle={metric.description ?? metric.displayName}
        badge={`価格 ${metric.priceDate ?? '---'} / 構成 ${metric.holdings.asOfDate ?? '未取得'}`}
        rightSlot={
          <div className="flex flex-wrap items-center gap-2">
            <Link
              href="/sector-etfs"
              className="inline-flex h-7 items-center gap-1 rounded-[3px] border border-[var(--color-border-default)] bg-white px-2 text-[11px] font-bold text-[var(--color-brand-800)]"
            >
              <ArrowLeft size={12} /> 一覧へ
            </Link>
            <Link
              href={metric.sourceUrl}
              target="_blank"
              rel="noreferrer"
              className="inline-flex h-7 items-center gap-1 rounded-[3px] border border-[var(--color-border-default)] bg-white px-2 text-[11px] font-bold text-[var(--color-brand-800)]"
            >
              公式情報 <ExternalLink size={12} />
            </Link>
          </div>
        }
      />

      <section className="grid grid-cols-1 gap-4 xl:grid-cols-[1.1fr_1.9fr]">
        <Card size="sm">
          <CardHeader title="ETF概要" hint={`${metric.group} / ${metric.theme}`} />
          <div className="grid grid-cols-2 gap-2">
            <InfoCell label="現在価格" value={fmtPrice(metric.price)} />
            <InfoCell label="前日比" value={fmtPct(metric.changePct)} tone={pctTone(metric.changePct)} />
            <InfoCell label="運用会社" value={metric.provider.toUpperCase()} />
            <InfoCell label="構成銘柄" value={`${metric.holdings.count.toLocaleString()}件`} />
            <InfoCell label="構成取得日" value={metric.holdings.asOfDate ?? '未取得'} />
            <InfoCell label="取得ソース" value={sourceGuide} />
          </div>
          {metric.holdings.lastRunStatus === 'failed' && (
            <div className="mt-3 rounded-[6px] border border-[var(--color-market-red)] bg-red-50 px-3 py-2 text-[11px] font-semibold text-[var(--color-market-red)]">
              構成銘柄取得に失敗しました: {metric.holdings.lastRunError ?? '原因未記録'}
            </div>
          )}
          {metric.holdings.count === 0 && metric.holdings.lastRunStatus !== 'failed' && (
            <div className="mt-3 rounded-[6px] border border-[var(--color-border-soft)] bg-[var(--color-surface-subtle)] px-3 py-2 text-[11px] font-semibold text-[var(--color-text-tertiary)]">
              構成銘柄は未取得です。チャート、6ステージ、MA分析は価格データから表示します。
            </div>
          )}
        </Card>

        <Card size="sm" inset>
          <CardHeader
            title="構成銘柄・組入比率"
            hint={holdings.length > 0 ? `${metric.holdings.asOfDate ?? '日付不明'} · 上位20件を表示` : '構成銘柄未取得'}
          />
          <div className="px-3 pb-3">
            {topHoldings.length > 0 ? (
              <>
                <HoldingsTable rows={topHoldings} />
                {holdings.length > topHoldings.length && (
                  <details className="mt-3 rounded-[8px] border border-[var(--color-border-soft)] bg-[var(--color-surface-subtle)]">
                    <summary className="cursor-pointer px-3 py-2 text-[12px] font-bold text-[var(--color-brand-800)]">
                      全{holdings.length.toLocaleString()}件を表示
                    </summary>
                    <div className="p-3">
                      <HoldingsTable rows={holdings} compact />
                    </div>
                  </details>
                )}
              </>
            ) : (
              <div className="rounded-[8px] border border-dashed border-[var(--color-border-default)] bg-[var(--color-surface-subtle)] px-4 py-8 text-center text-[13px] font-bold text-[var(--color-text-tertiary)]">
                構成銘柄未取得
              </div>
            )}
          </div>
        </Card>
      </section>

      <StagePanel metric={metric} />
      <MaPanel metric={metric} />

      <section className="space-y-4">
        <CardHeader title="価格チャート" hint="既存の個別銘柄分析と同じローソク足・MAロジックをETFに適用します。" />
        <div className="grid grid-cols-1 gap-4">
          <Card size="sm">
            <CardHeader title="日足チャート" hint="5日 / 25日 / 75日 MA" />
            <CandlestickChart ticker={metric.ticker} interval="D" height={420} maLines={[5, 25, 75]} />
          </Card>
          <Card size="sm">
            <CardHeader title="週足チャート" hint="13週 / 26週 / 52週 MA" />
            <CandlestickChart ticker={metric.ticker} interval="W" height={420} maLines={[13, 26, 52]} />
          </Card>
          <Card size="sm">
            <CardHeader title="月足チャート" hint="12月 / 24月 / 60月 MA" />
            <CandlestickChart ticker={metric.ticker} interval="M" height={420} maLines={[12, 24, 60]} />
          </Card>
        </div>
      </section>
    </div>
  )
}
