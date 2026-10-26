import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { ArrowLeft, ExternalLink } from 'lucide-react'
import { CandlestickChart } from '@/components/charts/CandlestickChart'
import { PageTitle } from '@/components/layout/PageTitle'
import { EmptyState, Notice } from '@/components/ui/EmptyState'
import { SectionHeader } from '@/components/ui/SectionHeader'
import { StageDots } from '@/components/ui/StageDots'
import { StatStrip } from '@/components/ui/StatStrip'
import {
  loadUsSectorEtfDetail,
  resolveUsSectorEtfTicker,
  type UsSectorEtfMovingAverageGroup,
} from '@/lib/server/us-sector-etf-detail-read-model'

export const dynamic = 'force-dynamic'
export const revalidate = 0
export const fetchCache = 'force-no-store'

type PageProps = {
  params: Promise<{ ticker: string }>
  searchParams: Promise<Record<string, string | string[] | undefined>>
}

function isIsoCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const [year, month, day] = value.split('-').map(Number)
  const parsed = new Date(Date.UTC(year, month - 1, day))
  return parsed.getUTCFullYear() === year
    && parsed.getUTCMonth() === month - 1
    && parsed.getUTCDate() === day
}

function parseRequestedDate(params: Record<string, string | string[] | undefined>): string | null | undefined {
  if (Object.keys(params).some((key) => key !== 'date')) return undefined
  const value = params.date
  if (Array.isArray(value)) return undefined
  if (value == null) return null
  return isIsoCalendarDate(value) ? value : undefined
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { ticker: rawTicker } = await params
  const resolution = resolveUsSectorEtfTicker(rawTicker)
  if (resolution.status !== 'valid') return { title: 'US Sector ETF — StockBoard' }
  return {
    title: `${resolution.ticker} ${resolution.catalog.shortName} — US Sector ETF`,
    description: `${resolution.catalog.shortName}の調整済み価格、チャート、6ステージ、移動平均分析`,
  }
}

function fmtPrice(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '---'
  return `$${value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

function fmtPct(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '---'
  return `${value > 0 ? '+' : ''}${value.toFixed(2)}%`
}

function fmtAngle(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '---'
  return `${value > 0 ? '+' : ''}${value}°`
}

function tone(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return 'text-[var(--color-text-tertiary)]'
  if (value > 0) return 'text-[var(--color-price-up)]'
  if (value < 0) return 'text-[var(--color-price-down)]'
  return 'text-[var(--color-text-secondary)]'
}

function MovingAverageRows({ title, group }: { title: string; group: UsSectorEtfMovingAverageGroup }) {
  return (
    <section className="min-w-0">
      <SectionHeader
        as="h3"
        title={title}
        description={group.angleObservationSteps == null
          ? '角度は比較スナップショット不足'
          : `${group.angleObservationSteps}観測ステップで正規化した角度`}
      />
      <div className="overflow-x-auto border-b border-[var(--color-border-soft)]">
        <table className="w-full min-w-[420px] text-[12px]">
          <thead>
            <tr className="border-b border-[var(--color-border-soft)] text-left text-[10px] text-[var(--color-text-tertiary)]">
              <th className="py-1.5 pr-3">期間</th>
              <th className="py-1.5 pr-3 text-right">SMA</th>
              <th className="py-1.5 text-right">角度</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[var(--color-border-soft)]">
            {group.labels.map((label, index) => (
              <tr key={`${title}-${label}`}>
                <th className="py-2 pr-3 text-left font-bold text-[var(--color-text-primary)]">{label}</th>
                <td className="py-2 pr-3 text-right font-mono tabular-nums text-[var(--color-text-secondary)]">
                  {fmtPrice(group.values[index])}
                </td>
                <td className={`py-2 text-right font-mono font-bold tabular-nums ${tone(group.angles[index])}`}>
                  {fmtAngle(group.angles[index])}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-2 truncate text-[11px] text-[var(--color-text-secondary)]" title={group.order ?? undefined}>
        並び順 <strong className="text-[var(--color-text-primary)]">{group.order ?? '算出不可'}</strong>
      </p>
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

export default async function UsSectorEtfDetailPage({ params, searchParams }: PageProps) {
  const [{ ticker: rawTicker }, rawSearchParams] = await Promise.all([params, searchParams])
  const tickerResolution = resolveUsSectorEtfTicker(rawTicker)
  const requestedDate = parseRequestedDate(rawSearchParams)
  if (tickerResolution.status !== 'valid' || requestedDate === undefined) notFound()

  const detail = await loadUsSectorEtfDetail(tickerResolution.ticker, requestedDate)
  if (!detail) {
    return (
      <div className="sb-page">
        <PageTitle
          eyebrow="US Sector ETF"
          title={`${tickerResolution.ticker} ${tickerResolution.catalog.shortName}`}
          subtitle={tickerResolution.catalog.description}
          rightSlot={<Link href="/us/sector-etfs" className="btn"><ArrowLeft size={13} aria-hidden /> 一覧へ</Link>}
        />
        <EmptyState
          title="価格データがありません"
          description={requestedDate
            ? `${requestedDate}時点の調整済み価格を確認できないため、詳細分析を表示していません。`
            : '調整済み価格を確認できないため、詳細分析を表示していません。'}
        />
      </div>
    )
  }

  const stageValues = [
    detail.stages.dailyA,
    detail.stages.dailyB,
    detail.stages.weeklyA,
    detail.stages.weeklyB,
    detail.stages.monthlyA,
    detail.stages.monthlyB,
  ]
  const stageLabels = ['日足A', '日足B', '週足A', '週足B', '月足A', '月足B']
  const changeTone = detail.price.changePct == null
    ? 'muted'
    : detail.price.changePct > 0
      ? 'up'
      : detail.price.changePct < 0
        ? 'down'
        : undefined

  return (
    <div className="sb-page">
      <PageTitle
        eyebrow="US Sector ETF"
        title={`${detail.catalog.ticker} ${detail.catalog.shortName}`}
        subtitle={detail.catalog.description}
        meta={<>
          <span>{detail.catalog.sector}</span>
          <span>基準日 <strong className="font-semibold text-[var(--color-text-primary)]">{detail.asOfDate}</strong></span>
          <span>価格基準 <strong className="font-semibold text-[var(--color-text-primary)]">Adjusted OHLC</strong></span>
        </>}
        rightSlot={<>
          <Link href="/us/sector-etfs" className="btn">
            <ArrowLeft size={13} aria-hidden /> 一覧へ
          </Link>
          <Link href={detail.catalog.sourceUrl} target="_blank" rel="noreferrer" className="btn">
            公式情報 <ExternalLink size={13} aria-hidden />
          </Link>
        </>}
      />

      <StatStrip
        label="ETFの現況"
        items={[
          { label: '調整済み終値', value: fmtPrice(detail.price.value) },
          { label: '前営業日比', value: fmtPct(detail.price.changePct), tone: changeTone },
          { label: '6ステージ', value: <span className="font-mono">{detail.stageCode ?? '—'}</span>, sub: detail.stageDate ?? '当日判定なし' },
          { label: '履歴', value: `${detail.historyCoverage.rows.toLocaleString()}本`, sub: `${detail.historyCoverage.firstDate} — ${detail.historyCoverage.lastDate}` },
          { label: '価格Source', value: detail.price.source ?? '不明', sub: detail.lineage.priceBasis },
        ]}
      />

      <Notice tone="warning" title="構成銘柄・組入比率は利用できません">
        {detail.holdings.reason}
      </Notice>

      <div className="grid min-w-0 grid-cols-1 gap-5 xl:grid-cols-[minmax(0,1fr)_420px]">
        <ChartBlock title="日足" hint="Adjusted OHLC · 5日 / 25日 / 75日 MA">
          <CandlestickChart
            ticker={detail.catalog.ticker}
            market="US"
            interval="D"
            height={420}
            maLines={[5, 25, 75]}
            historyData={detail.history}
            marketAsOfDate={detail.asOfDate}
          />
        </ChartBlock>

        <div className="min-w-0 space-y-5">
          <section>
            <SectionHeader
              as="h3"
              title="6ステージ"
              description={`判定日 ${detail.stageDate ?? '—'} · ${detail.stageCode ?? '未算出'}`}
            />
            <StageDots values={stageValues} size={24} />
            <dl className="mt-3 grid grid-cols-3 gap-x-3 gap-y-2 sm:grid-cols-6 xl:grid-cols-3">
              {stageLabels.map((label, index) => (
                <div key={label}>
                  <dt className="text-[10px] text-[var(--color-text-tertiary)]">{label}</dt>
                  <dd className="m-0 font-mono text-[14px] font-bold text-[var(--color-text-primary)]">
                    {stageValues[index] ?? '—'}
                  </dd>
                </div>
              ))}
            </dl>
          </section>
          <MovingAverageRows title="日足移動平均" group={detail.movingAverages.daily} />
        </div>
      </div>

      <section className="min-w-0">
        <SectionHeader
          level={1}
          title="時間足別チャート"
          description="同じ調整済み日足系列から週足・月足を再構成"
        />
        <div className="grid grid-cols-1 gap-4 2xl:grid-cols-2">
          <ChartBlock title="週足" hint="13週 / 26週 / 52週 MA">
            <CandlestickChart
              ticker={detail.catalog.ticker}
              market="US"
              interval="W"
              height={380}
              maLines={[13, 26, 52]}
              historyData={detail.history}
              marketAsOfDate={detail.asOfDate}
            />
          </ChartBlock>
          <ChartBlock title="月足" hint="12月 / 24月 / 60月 MA">
            <CandlestickChart
              ticker={detail.catalog.ticker}
              market="US"
              interval="M"
              height={380}
              maLines={[12, 24, 60]}
              historyData={detail.history}
              marketAsOfDate={detail.asOfDate}
            />
          </ChartBlock>
        </div>
      </section>

      <section className="grid min-w-0 grid-cols-1 gap-5 xl:grid-cols-2">
        <MovingAverageRows title="週足移動平均" group={detail.movingAverages.weekly} />
        <MovingAverageRows title="月足移動平均" group={detail.movingAverages.monthly} />
      </section>
    </div>
  )
}
