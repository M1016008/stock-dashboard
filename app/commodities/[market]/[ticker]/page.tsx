import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { ArrowLeft, ExternalLink, ShieldAlert } from 'lucide-react'
import { CandlestickChart } from '@/components/charts/CandlestickChart'
import { PageTitle } from '@/components/layout/PageTitle'
import { StockMlInsights } from '@/components/stock/StockMlInsights'
import { Card, CardHeader } from '@/components/ui/Card'
import { StageDots } from '@/components/ui/StageDots'
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

function InfoCell({ label, value, tone }: { label: string; value: React.ReactNode; tone?: string }) {
  return (
    <div className="rounded-[6px] border border-[var(--color-border-soft)] bg-[var(--color-surface-subtle)] px-3 py-2">
      <div className="text-[10px] font-bold text-[var(--color-text-tertiary)]">{label}</div>
      <div className={`mt-1 text-[13px] font-bold tabular-nums ${tone ?? 'text-[var(--color-text-primary)]'}`}>{value}</div>
    </div>
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
      <CardHeader title="6ステージ分析" hint={`判定日 ${metric.stageDate ?? '---'} / コード ${metric.stageCode ?? '------'}`} />
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

function MaPanel({ metric }: { metric: CommodityMetric }) {
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
                    {fmtAngle(angle)}
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
  return (
    <Card size="sm">
      <CardHeader
        title="物理特徴量"
        hint={metric.physics.source === 'ml_feature_vectors_v2' ? '既存 ma_physics 特徴量から算出' : 'ステージ/MA角度からの簡易判定'}
      />
      <div className="rounded-[8px] border border-[var(--color-border-soft)] bg-[var(--color-surface-subtle)] p-3">
        <div className="flex flex-wrap items-center gap-2">
          <span className="rounded-full bg-[var(--color-brand-800)] px-3 py-1 text-[12px] font-bold text-white">
            {metric.physics.status}
          </span>
          <span className="rounded-full border border-[var(--color-border-default)] bg-white px-3 py-1 text-[12px] font-bold text-[var(--color-brand-800)]">
            {metric.physics.momentumLabel}
          </span>
        </div>
        <p className="mt-3 text-[12px] font-semibold leading-relaxed text-[var(--color-text-secondary)]">{metric.physics.summary}</p>
      </div>
      <div className="mt-3 grid grid-cols-2 gap-2 md:grid-cols-3 xl:grid-cols-6">
        {rows.map(([label, value]) => (
          <InfoCell key={label} label={label} value={fmtPct(value)} tone={pctTone(value)} />
        ))}
      </div>
      <div className="mt-3 space-y-2">
        {[...metric.physics.riskNotes, ...metric.riskNotes].slice(0, 4).map((note) => (
          <div key={note} className="flex items-start gap-2 rounded-[6px] border border-[var(--color-border-soft)] bg-white px-3 py-2 text-[11px] font-semibold text-[var(--color-text-secondary)]">
            <ShieldAlert size={13} className="mt-0.5 shrink-0 text-amber-600" />
            {note}
          </div>
        ))}
      </div>
    </Card>
  )
}

function RelatedPanel({ related }: { related: CommodityMetric[] }) {
  if (related.length === 0) return null
  return (
    <Card size="sm">
      <CardHeader title="同分類の比較候補" hint="同じ商品分類内のETF/ETNです。" />
      <div className="grid grid-cols-1 gap-2 md:grid-cols-2 xl:grid-cols-4">
        {related.map((metric) => (
          <Link
            key={`${metric.market}-${metric.ticker}`}
            href={`/commodities/${metric.marketSlug}/${metric.ticker}`}
            className="rounded-[6px] border border-[var(--color-border-soft)] bg-[var(--color-surface-subtle)] px-3 py-2 hover:bg-white"
          >
            <div className="font-mono text-[12px] font-bold text-[var(--color-brand-900)]">{metric.market}:{metric.ticker}</div>
            <div className="mt-1 truncate text-[11px] font-bold text-[var(--color-text-secondary)]">{metric.shortName}</div>
            <div className={`mt-1 font-mono text-[11px] font-bold ${pctTone(metric.returns.day20)}`}>20日 {fmtPct(metric.returns.day20)}</div>
          </Link>
        ))}
      </div>
    </Card>
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
    <div className="sb-page">
      <PageTitle
        title={`${metric.market}:${metric.ticker} ${metric.shortName}`}
        subtitle={metric.description}
        badge={`価格 ${metric.priceDate ?? '---'} / ステージ ${metric.stageDate ?? '---'}`}
        rightSlot={
          <div className="flex flex-wrap items-center gap-2">
            <Link
              href="/commodities"
              className="inline-flex h-7 items-center gap-1 rounded-[3px] border border-[var(--color-border-default)] bg-white px-2 text-[11px] font-bold text-[var(--color-brand-800)]"
            >
              <ArrowLeft size={12} /> 一覧へ
            </Link>
            {metric.sourceUrl && (
              <Link
                href={metric.sourceUrl}
                target="_blank"
                rel="noreferrer"
                className="inline-flex h-7 items-center gap-1 rounded-[3px] border border-[var(--color-border-default)] bg-white px-2 text-[11px] font-bold text-[var(--color-brand-800)]"
              >
                公式情報 <ExternalLink size={12} />
              </Link>
            )}
          </div>
        }
      />

      <section className="grid grid-cols-1 gap-4 xl:grid-cols-[1.05fr_1.95fr]">
        <Card size="sm">
          <CardHeader title="商品ETF概要" hint={`${commodityGroupLabel(metric.group)} / ${metric.commodity}`} />
          <div className="grid grid-cols-2 gap-2">
            <InfoCell label="現在価格" value={fmtPrice(metric.price, metric.currency)} />
            <InfoCell label="前日比" value={fmtPct(metric.changePct)} tone={pctTone(metric.changePct)} />
            <InfoCell label="市場" value={metric.market === 'JP' ? '国内上場' : '米国上場'} />
            <InfoCell label="通貨" value={metric.currency} />
            <InfoCell label="商品タイプ" value={COMMODITY_PRODUCT_LABELS[metric.productType]} />
            <InfoCell label="ML" value={metric.ml.label} />
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-3">
            <StageDots values={stageValues} size={22} />
            <span className="rounded-full border border-[var(--color-border-default)] bg-white px-3 py-1 text-[12px] font-bold text-[var(--color-brand-800)]">
              {metric.maTrendLabel}
            </span>
          </div>
          {metric.freshness.warnings.length > 0 && (
            <div className="mt-3 space-y-2">
              {metric.freshness.warnings.map((warning) => (
                <div key={warning} className="rounded-[6px] border border-amber-200 bg-amber-50 px-3 py-2 text-[11px] font-semibold text-amber-800">
                  {warning}
                </div>
              ))}
            </div>
          )}
        </Card>

        <Card size="sm">
          <CardHeader title="騰落率" hint="1日、5日、20日、60日、YTDで比較します。" />
          <div className="grid grid-cols-2 gap-2 md:grid-cols-5">
            <InfoCell label="1日" value={fmtPct(metric.returns.day1)} tone={pctTone(metric.returns.day1)} />
            <InfoCell label="5日" value={fmtPct(metric.returns.day5)} tone={pctTone(metric.returns.day5)} />
            <InfoCell label="20日" value={fmtPct(metric.returns.day20)} tone={pctTone(metric.returns.day20)} />
            <InfoCell label="60日" value={fmtPct(metric.returns.day60)} tone={pctTone(metric.returns.day60)} />
            <InfoCell label="YTD" value={fmtPct(metric.returns.ytd)} tone={pctTone(metric.returns.ytd)} />
          </div>
          <div className="mt-4 grid grid-cols-1 gap-2 md:grid-cols-3">
            <InfoCell label="価格日" value={metric.priceDate ?? '---'} />
            <InfoCell label="ステージ日" value={metric.stageDate ?? '---'} />
            <InfoCell label="物理判定" value={metric.physics.status} />
          </div>
          <div className="mt-3 rounded-[6px] border border-[var(--color-border-soft)] bg-[var(--color-surface-subtle)] px-3 py-2 text-[11px] font-semibold text-[var(--color-text-secondary)]">
            先物そのものではなく、ETF/ETNの価格系列を分析しています。商品専用MLの再学習は初期版には含めず、既存特徴量とチャート分析を優先します。
          </div>
        </Card>
      </section>

      <StagePanel metric={metric} />
      <MaPanel metric={metric} />
      <PhysicsPanel metric={metric} />
      <RelatedPanel related={related} />

      <section className="space-y-4">
        <CardHeader title="価格チャート" hint="既存の個別銘柄分析と同じローソク足・MAロジックをETF/ETNに適用します。" />
        <div className="grid grid-cols-1 gap-4">
          <Card size="sm">
            <CardHeader title="日足チャート" hint="5日 / 25日 / 75日 MA" />
            <CandlestickChart ticker={metric.ticker} interval="D" height={420} maLines={[5, 25, 75]} market={metric.market} />
          </Card>
          <Card size="sm">
            <CardHeader title="週足チャート" hint="13週 / 26週 / 52週 MA" />
            <CandlestickChart ticker={metric.ticker} interval="W" height={420} maLines={[13, 26, 52]} market={metric.market} />
          </Card>
          <Card size="sm">
            <CardHeader title="月足チャート" hint="12月 / 24月 / 60月 MA" />
            <CandlestickChart ticker={metric.ticker} interval="M" height={420} maLines={[12, 24, 60]} market={metric.market} />
          </Card>
        </div>
      </section>

      <section className="space-y-3">
        <CardHeader
          title="ML参考表示"
          hint={metric.market === 'JP' ? '既存の株式向けML特徴量を参考として表示します。商品専用予測ではありません。' : '米国ETFは現状メインDB側に既存MLがないため、MLは未生成です。'}
        />
        {metric.market === 'JP' && metric.ml.available ? (
          <Card size="sm">
            <div className="mb-3 rounded-[6px] border border-amber-200 bg-amber-50 px-3 py-2 text-[11px] font-semibold text-amber-800">
              このカードは既存の日本株向けMLを流用した参考表示です。商品専用モデルではありません。
            </div>
            <StockMlInsights ticker={metric.ticker} />
          </Card>
        ) : (
          <Card size="sm">
            <div className="rounded-[8px] border border-dashed border-[var(--color-border-default)] bg-[var(--color-surface-subtle)] px-4 py-8 text-center text-[13px] font-bold text-[var(--color-text-tertiary)]">
              {metric.market === 'US'
                ? 'US ETFはML未生成です。6ステージ、MA角度、物理特徴量を参考にしてください。'
                : 'この国内ETF/ETNは既存ML特徴量が未生成です。'}
            </div>
          </Card>
        )}
      </section>
    </div>
  )
}
