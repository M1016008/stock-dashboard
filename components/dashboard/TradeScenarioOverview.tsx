import Link from 'next/link'
import { Card, CardHeader } from '@/components/ui/Card'
import { StageTag } from '@/components/ui/StageTag'
import { getTradeScenarioOverview } from '@/lib/trade-scenarios/server'
import type { TradeScenarioDirection, TradeScenarioOverviewItem } from '@/lib/trade-scenarios/types'

function fmtPct(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '---'
  return `${value >= 0 ? '+' : ''}${value.toFixed(2)}%`
}

function fmtPrice(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '---'
  return value.toLocaleString('ja-JP', { maximumFractionDigits: 1 })
}

function toneClass(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return 'text-[var(--color-text-secondary)]'
  if (value > 0) return 'text-[var(--color-price-up)]'
  if (value < 0) return 'text-[var(--color-price-down)]'
  return 'text-[var(--color-text-secondary)]'
}

function directionLabel(direction: TradeScenarioDirection): string {
  if (direction === 'bullish') return '上昇'
  if (direction === 'bearish') return '下落'
  return '見送り'
}

function directionTone(direction: TradeScenarioDirection): string {
  if (direction === 'bullish') return 'text-[var(--color-price-up)] bg-[var(--color-price-up-bg)] border-[rgba(185,28,28,0.22)]'
  if (direction === 'bearish') return 'text-[var(--color-price-down)] bg-[var(--color-price-down-bg)] border-[rgba(30,64,175,0.22)]'
  return 'text-[var(--color-text-secondary)] bg-[var(--color-surface-subtle)] border-[var(--color-border-soft)]'
}

function priorityToneClass(tone: TradeScenarioOverviewItem['priorityTone']): string {
  if (tone === 'up') return 'border-[rgba(185,28,28,0.28)] bg-[var(--color-price-up-bg)] text-[var(--color-price-up)]'
  if (tone === 'down') return 'border-[rgba(30,64,175,0.28)] bg-[var(--color-price-down-bg)] text-[var(--color-price-down)]'
  if (tone === 'warning') return 'border-[rgba(217,119,6,0.28)] bg-[#fff7ed] text-[#b45309]'
  return 'border-[var(--color-border-soft)] bg-white text-[var(--color-text-secondary)]'
}

function progressColor(item: TradeScenarioOverviewItem): string {
  if (item.outcome.status === 'stop_hit') return 'var(--color-price-down)'
  if (item.outcome.status === 'target_hit') return 'var(--color-price-up)'
  if (item.direction === 'bearish') return 'var(--color-price-down)'
  if (item.direction === 'bullish') return 'var(--color-price-up)'
  return 'var(--color-brand-700)'
}

function progressWidth(item: TradeScenarioOverviewItem): string {
  const value = item.targetProgressPct
  if (value == null || !Number.isFinite(value)) return '12%'
  return `${Math.max(4, Math.min(100, value))}%`
}

function stockHref(ticker: string) {
  return `/stock/${encodeURIComponent(ticker)}`
}

function ScenarioMiniProgress({ item }: { item: TradeScenarioOverviewItem }) {
  const progress = progressWidth(item)
  const color = progressColor(item)
  return (
    <div className="mt-3">
      <div className="mb-1 flex items-center justify-between gap-2 text-[10px] font-bold text-[var(--color-text-tertiary)]">
        <span>撤退 {fmtPrice(item.stopLossPrice)}</span>
        <span>基準 {fmtPrice(item.anchorClose)}</span>
        <span>目標 {fmtPrice(item.targetPrice)}</span>
      </div>
      <div className="relative h-2 overflow-hidden rounded-full border border-[var(--color-border-soft)] bg-white">
        <span className="absolute left-0 top-0 h-full rounded-full" style={{ width: progress, background: color, opacity: 0.76 }} />
        <span className="absolute left-1/2 top-[-2px] h-[12px] w-[2px] bg-[var(--color-text-tertiary)] opacity-50" />
      </div>
      <div className="mt-1 flex items-center justify-between gap-2 text-[10px] font-semibold text-[var(--color-text-tertiary)]">
        <span>{item.currentDate ?? item.anchorDate}</span>
        <span>現在 {fmtPrice(item.currentClose)}</span>
      </div>
    </div>
  )
}

function ScenarioCard({ item }: { item: TradeScenarioOverviewItem }) {
  return (
    <article className="rounded-[8px] border border-[var(--color-border-soft)] bg-[var(--color-surface-subtle)] p-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <Link
              href={stockHref(item.ticker)}
              prefetch={false}
              className="font-mono text-[15px] font-bold text-[var(--color-brand-800)] hover:underline"
            >
              {item.ticker}
            </Link>
            <span className="max-w-[210px] truncate text-[12px] font-bold text-[var(--color-text-primary)]">
              {item.name ?? item.ticker}
            </span>
          </div>
          <div className="mt-1 text-[10px] font-semibold text-[var(--color-text-tertiary)]">
            {item.anchorDate}基準 / {item.horizonDays}営業日 / 残り{item.outcome.remainingDays}営業日
          </div>
        </div>
        <div className="flex flex-wrap justify-end gap-1.5">
          <span className={`rounded-full border px-2 py-1 text-[10px] font-bold ${directionTone(item.direction)}`}>
            {directionLabel(item.direction)}
          </span>
          <span className={`rounded-full border px-2 py-1 text-[10px] font-bold ${priorityToneClass(item.priorityTone)}`}>
            {item.priorityLabel}
          </span>
        </div>
      </div>

      {item.stages.length > 0 && (
        <div className="mt-2 flex items-center gap-1">
          {item.stages.map((stage, index) => (
            <StageTag key={`${item.id}-${index}-${stage ?? 'x'}`} stage={stage} size="xs" />
          ))}
        </div>
      )}

      <div className="mt-3 grid grid-cols-3 gap-2">
        <Metric label="現在変化" value={fmtPct(item.currentReturnPct)} className={toneClass(item.currentReturnPct)} />
        <Metric label="最大上昇" value={fmtPct(item.outcome.maxRisePct)} className={toneClass(item.outcome.maxRisePct)} />
        <Metric label="最大下落" value={fmtPct(item.outcome.maxDrawdownPct)} className={toneClass(item.outcome.maxDrawdownPct)} />
      </div>

      <ScenarioMiniProgress item={item} />

      <p className="mt-3 line-clamp-2 text-[11px] font-medium leading-relaxed text-[var(--color-text-secondary)]">
        {item.outcome.note}
      </p>
    </article>
  )
}

function Metric({ label, value, className }: { label: string; value: string; className?: string }) {
  return (
    <div className="rounded-[6px] border border-[var(--color-border-soft)] bg-white px-2 py-1.5">
      <div className="text-[10px] font-bold text-[var(--color-text-tertiary)]">{label}</div>
      <div className={`mt-0.5 font-mono text-[13px] font-bold ${className ?? ''}`}>{value}</div>
    </div>
  )
}

function SummaryTile({ label, value, tone }: { label: string; value: number; tone?: 'up' | 'down' | 'warning' }) {
  const cls = tone === 'up'
    ? 'text-[var(--color-price-up)]'
    : tone === 'down'
      ? 'text-[var(--color-price-down)]'
      : tone === 'warning'
        ? 'text-[#b45309]'
        : 'text-[var(--color-text-primary)]'
  return (
    <div className="rounded-[8px] border border-[var(--color-border-soft)] bg-[var(--color-surface-subtle)] px-3 py-2">
      <div className="text-[10px] font-bold text-[var(--color-text-tertiary)]">{label}</div>
      <div className={`mt-1 font-mono text-[20px] font-bold ${cls}`}>{value.toLocaleString()}</div>
    </div>
  )
}

export async function TradeScenarioOverview({ date = null }: { date?: string | null }) {
  const overview = await getTradeScenarioOverview(6, date)
  const { summary, items } = overview

  return (
    <Card size="lg" className="border-[var(--color-brand-700)]">
      <CardHeader
        title="売買シナリオ進捗"
        hint="個別銘柄で保存した仮説の現在地。目標到達・撤退条件・期限間近を優先表示します。"
      />

      <div className="mb-3 grid grid-cols-2 gap-2 md:grid-cols-5">
        <SummaryTile label="要確認" value={summary.attention} tone="warning" />
        <SummaryTile label="目標到達" value={summary.targetHit} tone="up" />
        <SummaryTile label="撤退条件" value={summary.stopHit} tone="down" />
        <SummaryTile label="振り返り待ち" value={summary.reviewDue} />
        <SummaryTile label="検証中" value={summary.pending} />
      </div>

      {summary.total === 0 ? (
        <div className="rounded-[8px] border border-dashed border-[var(--color-border-default)] bg-[var(--color-surface-subtle)] px-4 py-6 text-center">
          <div className="text-[13px] font-bold text-[var(--color-text-primary)]">まだ売買シナリオはありません</div>
          <p className="mt-2 text-[12px] font-medium leading-relaxed text-[var(--color-text-tertiary)]">
            個別銘柄ページで「売買シナリオノート」を保存すると、ここに今日確認すべき仮説が表示されます。
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-3 lg:grid-cols-2 xl:grid-cols-3">
          {items.map((item) => (
            <ScenarioCard key={item.id} item={item} />
          ))}
        </div>
      )}
    </Card>
  )
}
