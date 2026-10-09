import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { ExternalLink, ShieldAlert } from 'lucide-react'
import { CandlestickChart } from '@/components/charts/CandlestickChart'
import { PageTitle, StatusTag } from '@/components/layout/PageTitle'
import { StockMlInsights } from '@/components/stock/StockMlInsights'
import { Card, CardHeader } from '@/components/ui/Card'
import { SectionHeader } from '@/components/ui/SectionHeader'
import { StatStrip } from '@/components/ui/StatStrip'
import { StageDots } from '@/components/ui/StageDots'
import { EmptyState, Notice } from '@/components/ui/EmptyState'
import { CommodityNav } from '@/components/commodities/CommodityNav'
import { COMMODITY_PRODUCT_LABELS, commodityGroupLabel } from '@/lib/commodities'
import { getCommodityDetail, type CommodityMetric } from '@/lib/queries/commodities'

export const dynamic = 'force-dynamic'
export const revalidate = 0
export const fetchCache = 'force-no-store'

type PageProps = {
  params: Promise<{ market: string; ticker: string }>
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { market, ticker } = await params
  const detail = await getCommodityDetail(market, ticker)
  if (!detail) return { title: 'コモディティ詳細 — StockBoard' }
  return {
    title: `${detail.metric.market}:${detail.metric.ticker} ${detail.metric.shortName} — コモディティ分析`,
    description: `${detail.metric.shortName}のチャート、6ステージ、MA角度、物理特徴量`,
  }
}

function fmtPrice(value: number | null | undefined, currency: 'JPY' | 'USD') {
  if (value == null || !Number.isFinite(value)) return '---'
  return value.toLocaleString(currency === 'USD' ? 'en-US' : 'ja-JP', {
    maximumFractionDigits: currency === 'USD' ? 2 : 1,
  })
}

function fmtPct(value: number | null | undefined) {
  if (value == null || !Number.isFinite(value)) return '---'
  return `${value > 0 ? '+' : ''}${value.toFixed(2)}%`
}

function fmtAngle(value: number | null | undefined) {
  if (value == null || !Number.isFinite(value)) return '---'
  return `${value > 0 ? '+' : ''}${value}°`
}

function pctTone(value: number | null | undefined) {
  if (value == null || !Number.isFinite(value)) return 'text-[var(--color-text-secondary)]'
  if (value > 0) return 'text-[var(--color-price-up)]'
  if (value < 0) return 'text-[var(--color-price-down)]'
  return 'text-[var(--color-text-secondary)]'
}

function stripTone(value: number | null | undefined): 'up' | 'down' | undefined {
  if (value == null || !Number.isFinite(value) || value === 0) return undefined
  return value > 0 ? 'up' : 'down'
}

/** 罫線で区切る台帳 (枠の中に枠を作らない) */
function Ledger({ items, className = '' }: { items: Array<{ label: string; value: React.ReactNode; tone?: string }>; className?: string }) {
  return (
    <dl className={`m-0 grid gap-px overflow-hidden rounded-[4px] border border-[var(--color-border-soft)] bg-[var(--color-border-soft)] ${className}`}>
      {items.map((item) => (
        <div key={item.label} className="min-w-0 bg-white px-3 py-2">
          <dt className="truncate text-[11px] font-semibold text-[var(--color-text-tertiary)]">{item.label}</dt>
          <dd className={`m-0 mt-0.5 truncate text-[13px] font-semibold tabular-nums ${item.tone ?? 'text-[var(--color-text-primary)]'}`}>{item.value}</dd>
        </div>
      ))}
    </dl>
  )
}

function StagePanel({ metric }: { metric: CommodityMetric }) {
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
      <CardHeader title="6ステージ" hint={`判定日 ${metric.stageDate ?? '---'} / コード ${metric.stageCode ?? '------'}`} />
      <div className="flex flex-wrap items-center gap-3">
        <StageDots values={values.map(([, value]) => value)} size={24} />
        <StatusTag tone="brand">{metric.maTrendLabel}</StatusTag>
      </div>
      <Ledger className="mt-3 grid-cols-3 sm:grid-cols-6" items={values.map(([label, value]) => ({ label, value: value ? `S${value}` : '---' }))} />
    </Card>
  )
}

function MaPanel({ metric }: { metric: CommodityMetric }) {
  const rows = [
    { label: '日足', order: metric.maOrderDaily, angles: [metric.maAngles.daily5, metric.maAngles.daily25, metric.maAngles.daily75], names: ['5日', '25日', '75日'] },
    { label: '週足', order: metric.maOrderWeekly, angles: [metric.maAngles.weekly5, metric.maAngles.weekly13, metric.maAngles.weekly25], names: ['5週', '13週', '25週'] },
    { label: '月足', order: metric.maOrderMonthly, angles: [metric.maAngles.monthly3, metric.maAngles.monthly5, metric.maAngles.monthly10], names: ['3月', '5月', '10月'] },
  ]
  return (
    <Card size="sm" inset>
      <div className="px-4 pt-4"><CardHeader title="MAの並びと角度" hint="移動平均線の並び、向き、角度を日足・週足・月足で確認します。" /></div>
      <div className="table-scroll">
        <table className="w-full min-w-[460px] text-[12px]">
          <thead>
            <tr className="border-b border-[var(--color-border-default)] text-left text-[11px] text-[var(--color-text-tertiary)]">
              <th className="px-4 py-2 font-semibold">時間軸</th>
              <th className="px-3 py-2 font-semibold">並び</th>
              <th className="px-4 py-2 text-right font-semibold" colSpan={3}>角度 (短期 → 長期)</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[var(--color-border-soft)]">
            {rows.map((row) => (
              <tr key={row.label}>
                <th scope="row" className="px-4 py-2 text-left font-semibold text-[var(--color-text-primary)]">{row.label}</th>
                <td className="px-3 py-2 font-semibold text-[var(--color-text-primary)]">{row.order ?? 'MA不足'}</td>
                {row.angles.map((angle, index) => (
                  <td key={`${row.label}-${row.names[index]}`} className="px-2 py-2 text-right last:pr-4">
                    <span className="block text-[11px] text-[var(--color-text-tertiary)]">{row.names[index]}</span>
                    <span className={`font-mono font-semibold tabular-nums ${pctTone(angle)}`}>{fmtAngle(angle)}</span>
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  )
}

function PhysicsPanel({ metric }: { metric: CommodityMetric }) {
  const analysis = metric.physics.analysis
  const rows = analysis
    ? [
        ['5日速度', analysis.metrics.sma5Velocity5],
        ['25日速度', analysis.metrics.sma25Velocity5],
        ['5日加速度', analysis.metrics.sma5Acceleration5],
        ['5-25距離', analysis.metrics.gap5To25Pct],
        ['25-75距離', analysis.metrics.gap25To75Pct],
        ['価格/25日', analysis.metrics.priceToSma25],
      ] as const
    : [
        ['日足5角度', metric.maAngles.daily5],
        ['日足25角度', metric.maAngles.daily25],
        ['週足5角度', metric.maAngles.weekly5],
        ['月足3角度', metric.maAngles.monthly3],
      ] as const
  const notes = [...metric.physics.riskNotes, ...metric.riskNotes].slice(0, 4)
  return (
    <Card size="sm">
      <CardHeader
        title="物理特徴量"
        hint={metric.physics.source === 'ml_feature_vectors_v2' ? '既存 ma_physics 特徴量から算出' : 'ステージ/MA角度からの簡易判定'}
      />
      <Ledger className="grid-cols-2 sm:grid-cols-3" items={rows.map(([label, value]) => ({ label, value: fmtPct(value), tone: pctTone(value) }))} />
      {notes.length > 0 && (
        <ul className="mt-3 flex flex-col gap-1.5">
          {notes.map((note) => (
            <li key={note} className="flex items-start gap-2 text-[12px] leading-5 text-[var(--color-text-secondary)]">
              <ShieldAlert size={13} aria-hidden className="mt-1 shrink-0 text-[#b45309]" />
              {note}
            </li>
          ))}
        </ul>
      )}
    </Card>
  )
}

function RelatedPanel({ related }: { related: CommodityMetric[] }) {
  if (related.length === 0) return null
  return (
    <section aria-labelledby="commodity-related-title" className="flex min-w-0 flex-col gap-3">
      <SectionHeader id="commodity-related-title" level={1} title="同分類の比較候補" description="同じ商品分類内のETF/ETN。20日騰落率で比較" />
      <ul className="grid min-w-0 gap-px overflow-hidden rounded-[var(--radius-card)] border border-[var(--color-border-soft)] bg-[var(--color-border-soft)] sm:grid-cols-2 xl:grid-cols-4">
        {related.map((metric) => (
          <li key={`${metric.market}-${metric.ticker}`} className="min-w-0 bg-white">
            <Link
              href={`/commodities/${metric.marketSlug}/${metric.ticker}`}
              prefetch={false}
              className="flex min-w-0 items-center justify-between gap-3 px-3 py-2.5 hover:bg-[var(--color-surface-subtle)]"
            >
              <span className="min-w-0">
                <span className="block font-mono text-[12px] font-bold text-[var(--color-brand-800)]">{metric.market}:{metric.ticker}</span>
                <span className="block truncate text-[12px] text-[var(--color-text-secondary)]">{metric.shortName}</span>
              </span>
              <span className={`shrink-0 font-mono text-[13px] font-semibold tabular-nums ${pctTone(metric.returns.day20)}`}>{fmtPct(metric.returns.day20)}</span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  )
}

export default async function CommodityDetailPage({ params }: PageProps) {
  const { market, ticker } = await params
  const detail = await getCommodityDetail(market, ticker)
  if (!detail) notFound()

  const { metric, related } = detail
  const stageValues = [
    metric.stages.dailyA,
    metric.stages.dailyB,
    metric.stages.weeklyA,
    metric.stages.weeklyB,
    metric.stages.monthlyA,
    metric.stages.monthlyB,
  ]

  return (
    <div className="flex w-full min-w-0 flex-col gap-5">
      <PageTitle
        eyebrow={`コモディティ ・ ${commodityGroupLabel(metric.group)}`}
        title={`${metric.market}:${metric.ticker} ${metric.shortName}`}
        subtitle={metric.description}
        meta={<>
          <span>価格 {metric.priceDate ?? '---'}</span>
          <span>ステージ {metric.stageDate ?? '---'}</span>
          <span>{metric.market === 'JP' ? '国内上場' : '米国上場'} ・ {metric.currency} ・ {COMMODITY_PRODUCT_LABELS[metric.productType]}</span>
        </>}
        rightSlot={metric.sourceUrl ? (
          <a href={metric.sourceUrl} target="_blank" rel="noreferrer" className="btn" data-variant="ghost">
            公式情報 <ExternalLink size={13} aria-hidden />
          </a>
        ) : undefined}
      >
        <CommodityNav current={null} />
      </PageTitle>

      {metric.freshness.warnings.length > 0 && (
        <Notice tone="warning" title="データ鮮度の注意">
          <ul className="m-0 list-disc pl-4">
            {metric.freshness.warnings.map((warning) => <li key={warning}>{warning}</li>)}
          </ul>
        </Notice>
      )}

      <StatStrip
        label="価格と騰落率"
        items={[
          { label: `現在価格 (${metric.currency})`, value: fmtPrice(metric.price, metric.currency), sub: `前日比 ${fmtPct(metric.changePct)}` },
          { label: '1日', value: fmtPct(metric.returns.day1), tone: stripTone(metric.returns.day1) },
          { label: '5日', value: fmtPct(metric.returns.day5), tone: stripTone(metric.returns.day5) },
          { label: '20日', value: fmtPct(metric.returns.day20), tone: stripTone(metric.returns.day20) },
          { label: '60日', value: fmtPct(metric.returns.day60), tone: stripTone(metric.returns.day60) },
          { label: 'YTD', value: fmtPct(metric.returns.ytd), tone: stripTone(metric.returns.ytd) },
        ]}
      />

      {/* 結論: ステージ・MA方向・物理判定を 1 帯で読む */}
      <section aria-labelledby="commodity-state-title" className="grid min-w-0 gap-4 lg:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)]">
        <div className="min-w-0">
          <h2 id="commodity-state-title" className="text-[12px] font-semibold text-[var(--color-text-tertiary)]">現在の状態</h2>
          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-2">
            <strong className="text-[22px] font-bold leading-tight text-[var(--color-text-primary)]">{metric.physics.status}</strong>
            <StatusTag tone="brand">{metric.physics.momentumLabel}</StatusTag>
            <StatusTag>{metric.maTrendLabel}</StatusTag>
          </div>
          <p className="mt-2 max-w-[760px] text-[13px] leading-6 text-[var(--color-text-secondary)]">{metric.physics.summary}</p>
        </div>
        <div className="min-w-0">
          <div className="flex items-center gap-3">
            <span className="text-[12px] font-semibold text-[var(--color-text-tertiary)]">6ステージ</span>
            <StageDots values={stageValues} size={22} />
          </div>
          <Ledger
            className="mt-2 grid-cols-2"
            items={[
              { label: '分類', value: `${commodityGroupLabel(metric.group)} / ${metric.commodity}` },
              { label: 'ML', value: metric.ml.label },
            ]}
          />
          <p className="mt-2 text-[12px] leading-5 text-[var(--color-text-tertiary)]">
            先物そのものではなく、ETF/ETNの価格系列を分析しています。商品専用MLの再学習は初期版には含めず、既存特徴量とチャート分析を優先します。
          </p>
        </div>
      </section>

      <section aria-labelledby="commodity-chart-title" className="flex min-w-0 flex-col gap-3">
        <SectionHeader
          id="commodity-chart-title"
          level={1}
          title="価格チャート"
          description="個別銘柄分析と同じローソク足・MAロジックをETF/ETNに適用します"
        />
        <Card size="sm">
          <CardHeader title="日足" hint="5日 / 25日 / 75日 MA" />
          <CandlestickChart ticker={metric.ticker} interval="D" height={420} maLines={[5, 25, 75]} market={metric.market} />
        </Card>
        <div className="grid min-w-0 gap-4 xl:grid-cols-2">
          <Card size="sm">
            <CardHeader title="週足" hint="13週 / 26週 / 52週 MA" />
            <CandlestickChart ticker={metric.ticker} interval="W" height={360} maLines={[13, 26, 52]} market={metric.market} />
          </Card>
          <Card size="sm">
            <CardHeader title="月足" hint="12月 / 24月 / 60月 MA" />
            <CandlestickChart ticker={metric.ticker} interval="M" height={360} maLines={[12, 24, 60]} market={metric.market} />
          </Card>
        </div>
      </section>

      <section aria-labelledby="commodity-evidence-title" className="flex min-w-0 flex-col gap-3">
        <SectionHeader id="commodity-evidence-title" level={1} title="判定の根拠" description="ステージ・MA・物理特徴量" />
        <div className="grid min-w-0 gap-4 xl:grid-cols-2">
          <StagePanel metric={metric} />
          <PhysicsPanel metric={metric} />
        </div>
        <MaPanel metric={metric} />
      </section>

      <RelatedPanel related={related} />

      <section aria-labelledby="commodity-ml-title" className="flex min-w-0 flex-col gap-3">
        <SectionHeader
          id="commodity-ml-title"
          level={1}
          title="ML参考表示"
          description={metric.market === 'JP' ? '既存の株式向けML特徴量を参考として表示します。商品専用予測ではありません。' : '米国ETFは現状メインDB側に既存MLがないため、MLは未生成です。'}
        />
        {metric.market === 'JP' && metric.ml.available ? (
          <>
            <Notice tone="warning">このセクションは既存の日本株向けMLを流用した参考表示です。商品専用モデルではありません。</Notice>
            <StockMlInsights ticker={metric.ticker} />
          </>
        ) : (
          <div className="rounded-[var(--radius-card)] border border-dashed border-[var(--color-border-default)]">
            <EmptyState
              title={metric.market === 'US' ? 'US ETFはML未生成です' : 'この国内ETF/ETNは既存ML特徴量が未生成です'}
              description={metric.market === 'US' ? '6ステージ、MA角度、物理特徴量を参考にしてください。' : undefined}
            />
          </div>
        )}
      </section>
    </div>
  )
}
