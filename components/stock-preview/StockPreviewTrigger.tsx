'use client'

import * as Popover from '@radix-ui/react-popover'
import { ArrowUpRight, ChartCandlestick, Eye, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { CandlestickChart } from '@/components/charts/CandlestickChart'
import { StageTag } from '@/components/ui/StageTag'
import { WatchlistButton } from '@/components/ui/WatchlistButton'
import { useStockPreviewData } from '@/lib/client/use-stock-preview-data'
import {
  STOCK_PREVIEW_STAGE_ORDER,
  type StockPreviewContext,
  type StockPreviewData,
  type StockPreviewMarket,
} from '@/lib/stock-preview'

interface StockPreviewTriggerProps {
  ticker: string
  market?: StockPreviewMarket
  analysisDate?: string | null
  context?: StockPreviewContext
  className?: string
}

type PreviewMode = 'view' | 'chart'

const OPEN_DELAY_MS = 160
const CLOSE_DELAY_MS = 120
const STAGE_LABELS: Record<(typeof STOCK_PREVIEW_STAGE_ORDER)[number], string> = {
  dailyA: '日A',
  dailyB: '日B',
  weeklyA: '週A',
  weeklyB: '週B',
  monthlyA: '月A',
  monthlyB: '月B',
}

export function StockPreviewTrigger({
  ticker,
  market = 'JP',
  analysisDate = null,
  context = 'latest',
  className = '',
}: StockPreviewTriggerProps) {
  return (
    <span
      className={`inline-flex shrink-0 items-center gap-0.5 align-middle ${className}`}
      data-stock-preview-context={context}
    >
      <PreviewPopover mode="view" ticker={ticker} market={market} analysisDate={analysisDate} />
      <PreviewPopover mode="chart" ticker={ticker} market={market} analysisDate={analysisDate} />
    </span>
  )
}

function PreviewPopover({
  mode,
  ticker,
  market,
  analysisDate,
}: {
  mode: PreviewMode
  ticker: string
  market: StockPreviewMarket
  analysisDate: string | null
}) {
  const [open, setOpen] = useState(false)
  const openTimer = useRef<number | null>(null)
  const closeTimer = useRef<number | null>(null)
  const includeChart = mode === 'chart'
  const { data, loading, error } = useStockPreviewData({
    ticker,
    market,
    asOf: analysisDate,
    includeChart,
    enabled: open,
  })
  const label = mode === 'view' ? `${ticker}のクイック情報` : `${ticker}のクイックチャート`

  useEffect(() => () => {
    if (openTimer.current != null) window.clearTimeout(openTimer.current)
    if (closeTimer.current != null) window.clearTimeout(closeTimer.current)
  }, [])

  function clearTimers() {
    if (openTimer.current != null) window.clearTimeout(openTimer.current)
    if (closeTimer.current != null) window.clearTimeout(closeTimer.current)
    openTimer.current = null
    closeTimer.current = null
  }

  function scheduleOpen() {
    if (typeof window === 'undefined' || !window.matchMedia('(hover: hover)').matches) return
    if (closeTimer.current != null) window.clearTimeout(closeTimer.current)
    openTimer.current = window.setTimeout(() => setOpen(true), OPEN_DELAY_MS)
  }

  function scheduleClose() {
    if (typeof window === 'undefined' || !window.matchMedia('(hover: hover)').matches) return
    if (openTimer.current != null) window.clearTimeout(openTimer.current)
    closeTimer.current = window.setTimeout(() => setOpen(false), CLOSE_DELAY_MS)
  }

  return (
    <Popover.Root open={open} onOpenChange={(next) => {
      clearTimers()
      setOpen(next)
    }}>
      <Popover.Trigger asChild>
        <button
          type="button"
          data-stock-preview-mode={mode}
          aria-label={label}
          title={label}
          className="inline-flex h-6 w-6 items-center justify-center rounded-[var(--radius-sm)] border border-transparent text-[var(--color-text-tertiary)] transition-colors hover:border-[var(--color-border-default)] hover:bg-[var(--color-surface-muted)] hover:text-[var(--color-text-primary)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--color-brand-500)]"
          onPointerEnter={scheduleOpen}
          onPointerLeave={scheduleClose}
          onClick={(event) => event.stopPropagation()}
        >
          {mode === 'view' ? <Eye size={14} /> : <ChartCandlestick size={14} />}
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          data-stock-preview-content={mode}
          side="bottom"
          align="start"
          sideOffset={8}
          collisionPadding={12}
          avoidCollisions
          sticky="always"
          hideWhenDetached
          onPointerEnter={() => {
            if (closeTimer.current != null) window.clearTimeout(closeTimer.current)
          }}
          onPointerLeave={scheduleClose}
          onOpenAutoFocus={(event) => event.preventDefault()}
          className={`${mode === 'chart' ? 'w-[min(480px,calc(100vw-24px))]' : 'w-[min(390px,calc(100vw-24px))]'} z-[80] overflow-hidden rounded-[6px] border border-[var(--color-border-default)] bg-[var(--color-surface-base)] shadow-[0_16px_40px_rgba(15,23,42,0.18)]`}
        >
          <PreviewHeader data={data} ticker={ticker} market={market} analysisDate={analysisDate} mode={mode} />
          <div className="max-h-[min(620px,calc(100vh-96px))] overflow-y-auto p-3">
            {loading && <PreviewSkeleton mode={mode} />}
            {!loading && error && (
              <div role="alert" className="rounded-[4px] border border-[var(--color-danger-200,#fecaca)] bg-[var(--color-danger-50,#fef2f2)] px-3 py-4 text-xs text-[var(--color-danger-700,#b91c1c)]">
                取得できませんでした: {error}
              </div>
            )}
            {!loading && data && (mode === 'view'
              ? <StockQuickView data={data} />
              : <StockQuickChart data={data} />)}
          </div>
          <Popover.Close asChild>
            <button
              type="button"
              aria-label="閉じる"
              title="閉じる"
              className="absolute right-2 top-2 inline-flex h-7 w-7 items-center justify-center rounded-[var(--radius-sm)] text-[var(--color-text-tertiary)] hover:bg-[var(--color-surface-muted)] hover:text-[var(--color-text-primary)]"
            >
              <X size={15} />
            </button>
          </Popover.Close>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  )
}

function PreviewHeader({
  data,
  ticker,
  market,
  analysisDate,
  mode,
}: {
  data: StockPreviewData | null
  ticker: string
  market: StockPreviewMarket
  analysisDate: string | null
  mode: PreviewMode
}) {
  const normalizedTicker = ticker.replace(/\.T$/i, '')
  const detailHref = market === 'US'
    ? `/us/stock/${encodeURIComponent(normalizedTicker)}${analysisDate ? `?date=${encodeURIComponent(analysisDate)}` : ''}`
    : `/stock/${encodeURIComponent(normalizedTicker)}${analysisDate ? `?date=${encodeURIComponent(analysisDate)}` : ''}${mode === 'chart' ? '#chart' : '#overview'}`
  return (
    <div className="flex min-h-12 items-center gap-2 border-b border-[var(--color-border-soft)] bg-[var(--color-surface-muted)] px-3 pr-10">
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-baseline gap-2">
          <span className="shrink-0 font-mono text-[11px] font-semibold text-[var(--color-text-secondary)]">{normalizedTicker}</span>
          <span className="truncate text-[13px] font-semibold text-[var(--color-text-primary)]">{data?.name ?? '銘柄情報'}</span>
        </div>
        <div className="mt-0.5 text-[10px] text-[var(--color-text-tertiary)]">
          {analysisDate ? `基準日 ${data?.priceDate ?? analysisDate}` : `株価基準日 ${data?.priceDate ?? '取得中'}`}
        </div>
      </div>
      <WatchlistButton ticker={normalizedTicker} market={market} size="sm" />
      <a
        href={detailHref}
        className="inline-flex h-7 items-center gap-1 rounded-[var(--radius-sm)] px-1.5 text-[11px] font-semibold text-[var(--color-brand-600)] hover:bg-[var(--color-surface-base)]"
      >
        {mode === 'chart' ? '詳細チャート' : '詳細'} <ArrowUpRight size={13} />
      </a>
    </div>
  )
}

function StockQuickView({ data }: { data: StockPreviewData }) {
  const changeTone = data.change == null ? 'var(--color-text-secondary)' : data.change >= 0 ? 'var(--price-up)' : 'var(--price-down)'
  return (
    <div className="space-y-3">
      <section className="flex items-end justify-between gap-3">
        <div>
          <div className="font-mono text-xl font-semibold tabular-nums text-[var(--color-text-primary)]">{formatPrice(data.price, data.market)}</div>
          <div className="mt-0.5 font-mono text-[11px] font-semibold tabular-nums" style={{ color: changeTone }}>
            {data.change == null ? '前日比 —' : `${formatSigned(data.change, data.market)} (${formatSignedPercent(data.changePercent)})`}
          </div>
        </div>
        <div className="text-right text-[10px] leading-4 text-[var(--color-text-tertiary)]">
          <div>{data.marketSegment ?? data.market}</div>
          <div className="max-w-48 truncate">{data.sector ?? data.sector17 ?? '業種未登録'}</div>
        </div>
      </section>

      <section aria-label="6ステージ" className="rounded-[4px] border border-[var(--color-border-soft)] p-2.5">
        <div className="mb-2 flex items-center justify-between">
          <h3 className="text-[11px] font-semibold text-[var(--color-text-primary)]">6ステージ</h3>
          <span className="font-mono text-[9px] text-[var(--color-text-tertiary)]">基準 {data.stageDate ?? '—'}</span>
        </div>
        <div className="grid grid-cols-3 gap-2">
          {([['dailyA', 'dailyB'], ['weeklyA', 'weeklyB'], ['monthlyA', 'monthlyB']] as const).map((keys) => (
            <div key={keys[0]} className="grid grid-cols-2 gap-1 rounded-[4px] bg-[var(--color-surface-muted)] p-1">
              {keys.map((key) => (
                <div key={key} className="flex min-w-0 flex-col items-center gap-1">
                  <StageTag stage={data.stages[key]} size="md" className="w-full max-w-10" />
                  <span className="text-[9px] text-[var(--color-text-tertiary)]">{STAGE_LABELS[key]}</span>
                </div>
              ))}
            </div>
          ))}
        </div>
      </section>

      <section className="grid grid-cols-2 gap-x-4 gap-y-2 text-[11px]">
        <QuickMetric label="時価総額" value={formatLargeMoney(data.marketCap, data.market)} note={data.marketCapBasis === 'current' && data.requestedAsOf ? '株数は現在値' : undefined} />
        <QuickMetric label="20日平均売買代金" value={formatLargeMoney(data.avgTradingValue20, data.market)} />
        <QuickMetric label="52週高値比" value={formatSignedPercent(data.high52DistancePercent)} />
        <QuickMetric label="52週安値比" value={formatSignedPercent(data.low52DistancePercent)} />
        <QuickMetric label="信用区分" value={data.marginType ?? '—'} />
        <QuickMetric label="20日平均出来高" value={formatCompactNumber(data.avgVolume20)} />
      </section>

      {data.description && (
        <p className="line-clamp-2 border-t border-[var(--color-border-soft)] pt-2 text-[10px] leading-4 text-[var(--color-text-secondary)]">
          {data.description}
        </p>
      )}
      {data.requestedAsOf && (
        <p className="text-[9px] leading-4 text-[var(--color-text-tertiary)]">
          株価・ステージは基準日時点。市場区分・業種・信用区分・企業説明は現在登録値です。
        </p>
      )}
    </div>
  )
}

function StockQuickChart({ data }: { data: StockPreviewData }) {
  return (
    <div>
      <CandlestickChart
        ticker={data.ticker}
        market={data.market}
        height={250}
        historyData={data.chart ?? []}
        interval="D"
        showTimeframeSelector
        timeframeOptions={['D', 'W', 'M']}
        compact
      />
      <div className="mt-2 flex flex-wrap items-center justify-between gap-2 border-t border-[var(--color-border-soft)] pt-2 text-[10px] text-[var(--color-text-tertiary)]">
        <span>ローソク足・主要MA・出来高</span>
        <span>{data.chart?.at(0)?.date ?? '—'} ～ {data.chart?.at(-1)?.date ?? data.priceDate}</span>
      </div>
    </div>
  )
}

function QuickMetric({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div className="min-w-0 border-b border-[var(--color-border-soft)] pb-1.5">
      <div className="truncate text-[9px] text-[var(--color-text-tertiary)]">{label}</div>
      <div className="mt-0.5 truncate font-mono font-semibold tabular-nums text-[var(--color-text-primary)]">{value}</div>
      {note && <div className="truncate text-[8px] text-[var(--color-text-tertiary)]">{note}</div>}
    </div>
  )
}

function PreviewSkeleton({ mode }: { mode: PreviewMode }) {
  return (
    <div aria-label="読み込み中" role="status" className="animate-pulse space-y-3">
      <div className="h-8 w-32 rounded bg-[var(--color-surface-muted)]" />
      <div className={`${mode === 'chart' ? 'h-[250px]' : 'h-20'} rounded bg-[var(--color-surface-muted)]`} />
      <div className="grid grid-cols-2 gap-2">
        <div className="h-8 rounded bg-[var(--color-surface-muted)]" />
        <div className="h-8 rounded bg-[var(--color-surface-muted)]" />
      </div>
    </div>
  )
}

function formatPrice(value: number, market: StockPreviewMarket): string {
  return market === 'US'
    ? `$${value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
    : `¥${value.toLocaleString('ja-JP', { maximumFractionDigits: 1 })}`
}

function formatSigned(value: number, market: StockPreviewMarket): string {
  const sign = value > 0 ? '+' : ''
  return market === 'US' ? `${sign}$${value.toFixed(2)}` : `${sign}${value.toLocaleString('ja-JP', { maximumFractionDigits: 1 })}`
}

function formatSignedPercent(value: number | null): string {
  if (value == null || !Number.isFinite(value)) return '—'
  return `${value > 0 ? '+' : ''}${value.toFixed(1)}%`
}

function formatCompactNumber(value: number | null): string {
  if (value == null || !Number.isFinite(value)) return '—'
  return `${new Intl.NumberFormat('ja-JP', { notation: 'compact', maximumFractionDigits: 1 }).format(value)}株`
}

function formatLargeMoney(value: number | null, market: StockPreviewMarket): string {
  if (value == null || !Number.isFinite(value)) return '—'
  if (market === 'JP') {
    const absolute = Math.abs(value)
    if (absolute >= 1e12) return `${(value / 1e12).toFixed(2)}兆円`
    if (absolute >= 1e8) return `${(value / 1e8).toFixed(1)}億円`
    if (absolute >= 1e4) return `${(value / 1e4).toFixed(1)}万円`
    return `${Math.round(value).toLocaleString('ja-JP')}円`
  }
  return `$${new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(value)}`
}
