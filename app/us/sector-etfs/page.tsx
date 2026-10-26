import type { Metadata } from 'next'
import Link from 'next/link'
import { ExternalLink } from 'lucide-react'
import { PageTitle } from '@/components/layout/PageTitle'
import { EmptyState, Notice } from '@/components/ui/EmptyState'
import { SectionHeader } from '@/components/ui/SectionHeader'
import { StageDots } from '@/components/ui/StageDots'
import { StatStrip } from '@/components/ui/StatStrip'
import { loadUsSectorEtfBoard, type UsSectorEtfMetric } from '@/lib/server/us-sector-etf-read-model'

export const metadata: Metadata = {
  title: 'USセクターETF分析 — StockBoard',
  description: '米国の主要11セクターETFを、調整済み価格と6ステージで比較',
}
export const dynamic = 'force-dynamic'
export const revalidate = 0
export const fetchCache = 'force-no-store'

function first(value: string | string[] | undefined): string | null {
  return Array.isArray(value) ? (value.length === 1 ? value[0] : null) : value ?? null
}

function isIsoCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const [year, month, day] = value.split('-').map(Number)
  const parsed = new Date(Date.UTC(year, month - 1, day))
  return parsed.getUTCFullYear() === year
    && parsed.getUTCMonth() === month - 1
    && parsed.getUTCDate() === day
}

function price(value: number | null): string {
  return value == null ? '---' : `$${value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

function percent(value: number | null): string {
  return value == null ? '---' : `${value > 0 ? '+' : ''}${value.toFixed(2)}%`
}

function tone(value: number | null): string {
  if (value == null || value === 0) return 'text-[var(--color-text-secondary)]'
  return value > 0 ? 'text-[var(--color-price-up)]' : 'text-[var(--color-price-down)]'
}

function EtfCard({ metric, asOfDate }: { metric: UsSectorEtfMetric; asOfDate: string | null }) {
  const stages = [
    metric.stages.dailyA,
    metric.stages.dailyB,
    metric.stages.weeklyA,
    metric.stages.weeklyB,
    metric.stages.monthlyA,
    metric.stages.monthlyB,
  ]
  return (
    <article className="flex min-w-0 flex-col rounded-[6px] border border-[var(--color-border-default)] bg-white p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <Link href={`/us/stock/${encodeURIComponent(metric.ticker)}`} prefetch={false} className="font-mono text-[14px] font-black text-[var(--color-brand-800)] hover:underline">
            {metric.ticker}
          </Link>
          <h3 className="mt-0.5 text-[14px] font-bold text-[var(--color-text-primary)]">{metric.shortName}</h3>
          <p className="text-[11px] text-[var(--color-text-tertiary)]">{metric.sector}</p>
        </div>
        <div className="shrink-0 text-right">
          <div className="font-mono text-[15px] font-bold tabular-nums text-[var(--color-text-primary)]">{price(metric.price)}</div>
          <div className={`font-mono text-[13px] font-bold tabular-nums ${tone(metric.changePct)}`}>{percent(metric.changePct)}</div>
        </div>
      </div>

      <p className="mt-2 min-h-[36px] text-[12px] leading-relaxed text-[var(--color-text-secondary)]">{metric.description}</p>

      <div className="mt-auto border-t border-[var(--color-border-soft)] pt-2.5">
        <div className="flex flex-wrap items-end justify-between gap-2">
          <div>
            <div className="mb-1 text-[10px] font-semibold text-[var(--color-text-tertiary)]">6ステージ</div>
            <StageDots values={stages} size={18} />
          </div>
          <div className="max-w-[180px] text-right text-[11px]">
            <div className="font-semibold text-[var(--color-text-secondary)]">{metric.maOrderDaily ?? 'MA不足'}</div>
            <div className="font-mono text-[var(--color-text-tertiary)]">{metric.stageCode ?? '------'}</div>
          </div>
        </div>
        <div className="mt-2 flex flex-wrap items-center justify-between gap-2 text-[10px] text-[var(--color-text-tertiary)]">
          <span>{metric.dataStatus === 'ready' ? '価格・ステージ完備' : metric.dataStatus === 'price_missing' ? '調整価格なし' : 'ステージ一部欠損'}</span>
          <span className="inline-flex items-center gap-2">
            {metric.dataStatus === 'price_missing' ? (
              <span aria-disabled="true" className="font-semibold text-[var(--color-text-tertiary)]" title="指定日の調整済み価格がないため詳細分析を表示できません">
                詳細データなし
              </span>
            ) : (
              <Link
                href={asOfDate
                  ? `/us/sector-etfs/${encodeURIComponent(metric.ticker)}?date=${encodeURIComponent(asOfDate)}`
                  : `/us/sector-etfs/${encodeURIComponent(metric.ticker)}`}
                prefetch={false}
                className="font-bold text-[var(--color-brand-700)] hover:underline"
              >
                詳細分析
              </Link>
            )}
            <Link href={metric.sourceUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 hover:text-[var(--color-brand-700)]">
              ETF情報 <ExternalLink size={11} aria-hidden />
            </Link>
          </span>
        </div>
      </div>
    </article>
  )
}
export default async function UsSectorEtfsPage({
  searchParams,
}: {
  searchParams: Promise<{ date?: string | string[] }>
}) {
  const rawDate = (await searchParams).date
  const date = first(rawDate)
  const invalidDate = rawDate != null && (date == null || !isIsoCalendarDate(date))
  let board = null
  let loadFailed = false
  if (!invalidDate) {
    try {
      board = await loadUsSectorEtfBoard(date)
    } catch (error) {
      console.error('[us/sector-etfs] failed to load sector ETF board', error)
      loadFailed = true
    }
  }

  return (
    <div className="sb-page">
      <PageTitle
        eyebrow="米国株"
        title="USセクターETF分析"
        subtitle="Select Sector SPDR 11本を、同一基準日の調整済み終値と6ステージで比較します。"
        badge={board?.asOfDate ? (date ? '指定日' : '最新データ') : undefined}
        badgeTone={date ? 'warning' : 'positive'}
        meta={board?.asOfDate ? (
          <>
            <span>基準日 <strong className="font-semibold text-[var(--color-text-primary)]">{board.asOfDate}</strong>（米国時間終値）</span>
            <span>価格基準 <strong className="font-semibold text-[var(--color-text-primary)]">調整済み終値</strong></span>
          </>
        ) : undefined}
        rightSlot={<Link href="/sector-etfs" prefetch={false} className="btn">日本株ETF分析</Link>}
      />

      <form action="/us/sector-etfs" method="get" className="flex flex-wrap items-end gap-2 border-b border-[var(--color-border-default)] pb-4" aria-label="USセクターETFの基準日">
        <label className="flex min-w-[180px] flex-col gap-1 text-[11px] font-semibold text-[var(--color-text-secondary)]">
          基準日
          <input name="date" type="date" defaultValue={date ?? board?.asOfDate ?? ''} className="input h-10" />
        </label>
        <button className="btn" data-variant="primary" type="submit">指定日を表示</button>
        {date && <Link href="/us/sector-etfs" prefetch={false} className="btn">最新日に戻す</Link>}
      </form>

      {invalidDate && (
        <Notice tone="error" role="alert" title="指定した日付を読み取れません">
          日付は実在する YYYY-MM-DD を1つだけ指定してください。別の日付へ自動的に置き換えません。
        </Notice>
      )}
      {loadFailed && (
        <Notice tone="error" role="alert" title="USセクターETFを読み込めませんでした">
          既存のUS価格・ステージデータを確認できませんでした。別のデータを推測表示しません。
        </Notice>
      )}

      {!invalidDate && !loadFailed && board?.status === 'empty' && (
        <EmptyState
          title={date ? `${date} のUSセクターETFデータはありません` : 'USセクターETFデータがまだありません'}
          description="対象日の調整済み価格が存在しない場合、別日へフォールバックせず空として表示します。"
          action={date ? <Link href="/us/sector-etfs" prefetch={false} className="btn">最新日に戻す</Link> : undefined}
        />
      )}

      {board?.status === 'ready' && (
        <>
          <StatStrip
            label="USセクターETF集計"
            items={[
              { label: '対象ETF', value: board.coverage.catalog.toLocaleString(), sub: 'Select Sector SPDR' },
              { label: '調整価格あり', value: board.coverage.adjustedPrice.toLocaleString(), sub: `${board.coverage.catalog}本中` },
              { label: '上昇', value: board.summary.advancing.toLocaleString(), sub: '前営業日比', tone: 'up' },
              { label: '下落', value: board.summary.declining.toLocaleString(), sub: '前営業日比', tone: 'down' },
              { label: '6ステージ完備', value: board.coverage.completeStage.toLocaleString(), sub: `${board.coverage.staged}本に同日Snapshot` },
            ]}
          />

          <Notice tone="info" title="この画面のデータ境界">
            値動きは既存US OHLCVの調整済み終値、ステージは同じ基準日の既存Snapshotです。ETF構成銘柄・組入比率の契約は未接続のため、保有銘柄や寄与度は表示しません。
          </Notice>

          <section className="min-w-0">
            <SectionHeader
              level={1}
              title="Select Sector SPDR"
              description="同一基準日に揃わない価格・ステージは欠損のまま表示します。前営業日比は各ETFの直前の調整済み終値との比較です。"
              actions={<span className="text-[12px] tabular-nums text-[var(--color-text-tertiary)]">Source {board.lineage.sources.join(', ') || '不明'}</span>}
            />
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
              {board.metrics.map((metric) => (
                <EtfCard key={metric.ticker} metric={metric} asOfDate={board.asOfDate} />
              ))}
            </div>
          </section>

          {(board.coverage.missingPriceTickers.length > 0 || board.coverage.missingStageTickers.length > 0) && (
            <Notice tone="warning" title="Coverageに欠損があります">
              {board.coverage.missingPriceTickers.length > 0 && <>調整価格なし: {board.coverage.missingPriceTickers.join(', ')}。 </>}
              {board.coverage.missingStageTickers.length > 0 && <>同日ステージなし: {board.coverage.missingStageTickers.join(', ')}。</>}
            </Notice>
          )}
        </>
      )}
    </div>
  )
}
