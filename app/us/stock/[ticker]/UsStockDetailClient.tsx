'use client'

import Link from 'next/link'
import { useEffect, useMemo, useState } from 'react'
import { ArrowLeft, Database, LineChart, Loader2, TrendingUp } from 'lucide-react'
import { CandlestickChart } from '@/components/charts/CandlestickChart'
import { Card, CardHeader } from '@/components/ui/Card'
import { PriceDisplay } from '@/components/ui/PriceDisplay'
import type { StockQuote } from '@/types/stock'

type Status = 'idle' | 'loading' | 'ready' | 'error'

function fmtNumber(value: number | null | undefined) {
  if (value == null || !Number.isFinite(value)) return '-'
  return value.toLocaleString('en-US')
}

function fmtMoney(value: number | null | undefined) {
  if (value == null || !Number.isFinite(value)) return '-'
  if (value >= 1e12) return `$${(value / 1e12).toFixed(2)}T`
  if (value >= 1e9) return `$${(value / 1e9).toFixed(2)}B`
  if (value >= 1e6) return `$${(value / 1e6).toFixed(1)}M`
  return `$${Math.round(value).toLocaleString('en-US')}`
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-[4px] border border-[var(--color-border-default)] bg-[var(--color-surface-subtle)] px-3 py-2">
      <div className="text-[10px] font-bold text-[var(--color-text-tertiary)]">{label}</div>
      <div className="mt-1 text-[14px] font-bold text-[var(--color-brand-900)]">{value}</div>
    </div>
  )
}

export function UsStockDetailClient({
  ticker,
  initialQuote,
  initialError,
}: {
  ticker: string
  initialQuote?: StockQuote | null
  initialError?: string | null
}) {
  const normalizedTicker = useMemo(() => ticker.toUpperCase(), [ticker])
  const [status, setStatus] = useState<Status>(initialQuote ? 'ready' : initialError ? 'error' : 'idle')
  const [quote, setQuote] = useState<StockQuote | null>(initialQuote ?? null)
  const [error, setError] = useState<string | null>(initialError ?? null)

  useEffect(() => {
    if (initialQuote || initialError) return
    let cancelled = false
    setStatus('loading')
    setError(null)
    fetch(`/api/us/quote/${encodeURIComponent(normalizedTicker)}`, { cache: 'no-store' })
      .then(async (res) => {
        if (!res.ok) {
          const body = await res.json().catch(() => null)
          throw new Error(body?.message ?? `HTTP ${res.status}`)
        }
        return res.json()
      })
      .then((data: StockQuote) => {
        if (cancelled) return
        setQuote(data)
        setStatus('ready')
      })
      .catch((err) => {
        if (cancelled) return
        setError(err instanceof Error ? err.message : String(err))
        setStatus('error')
      })
    return () => { cancelled = true }
  }, [normalizedTicker, initialQuote, initialError])

  if (status === 'loading' || status === 'idle') {
    return (
      <div className="mx-auto flex min-h-[420px] w-full max-w-[1480px] items-center justify-center">
        <div className="inline-flex items-center gap-2 text-[13px] font-bold text-[var(--color-text-secondary)]">
          <Loader2 size={16} className="animate-spin" />
          US銘柄データを読み込み中...
        </div>
      </div>
    )
  }

  if (status === 'error' || !quote) {
    return (
      <div className="mx-auto flex w-full max-w-[1480px] flex-col gap-4">
        <Link href="/us/screener" className="inline-flex items-center gap-2 text-[12px] font-bold text-[var(--color-brand-700)] hover:text-[var(--color-market-red)]">
          <ArrowLeft size={14} /> USスクリーナーへ戻る
        </Link>
        <Card>
          <CardHeader title={`${normalizedTicker} のUSデータが見つかりません`} hint="market_ohlcv_daily / US" />
          <p className="text-[13px] font-semibold text-[var(--color-text-secondary)]">
            {error ?? 'Tiingoデータが未取得です。'} `npm run batch:us-ohlcv` と `npm run batch:us-snapshots` の実行状況を確認してください。
          </p>
        </Card>
      </div>
    )
  }

  return (
    <div className="mx-auto flex w-full max-w-[1480px] flex-col gap-5">
      <div className="flex flex-wrap items-start justify-between gap-4 rounded-[var(--radius-card)] border border-[var(--color-border-default)] bg-white p-4 shadow-[var(--shadow-card)]">
        <div className="min-w-0">
          <Link href="/us/screener" className="mb-3 inline-flex items-center gap-2 text-[12px] font-bold text-[var(--color-brand-700)] hover:text-[var(--color-market-red)]">
            <ArrowLeft size={14} /> USスクリーナー
          </Link>
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-[26px] font-bold leading-none text-[var(--color-brand-900)]">{quote.ticker}</h1>
            <span className="rounded-[3px] border border-[var(--color-border-default)] bg-[var(--color-surface-subtle)] px-2 py-1 text-[11px] font-bold text-[var(--color-text-secondary)]">
              {quote.exchange ?? 'US'}
            </span>
            <span className="rounded-[3px] border border-[var(--color-border-default)] bg-white px-2 py-1 text-[11px] font-bold text-[var(--color-brand-700)]">
              Tiingo EOD
            </span>
          </div>
          <div className="mt-2 text-[14px] font-semibold text-[var(--color-text-secondary)]">{quote.name}</div>
        </div>
        <div className="text-right">
          <PriceDisplay
            value={quote.price}
            change={quote.change}
            changePercent={quote.changePercent}
            currency="USD"
            size="xl"
          />
          <div className="mt-1 text-[11px] font-semibold text-[var(--color-text-tertiary)]">米国株ワークスペース</div>
        </div>
      </div>

      <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="出来高" value={fmtNumber(quote.volume)} />
        <Stat label="時価総額" value={fmtMoney(quote.marketCap)} />
        <Stat label="52週高値" value={quote.fiftyTwoWeekHigh == null ? '-' : `$${quote.fiftyTwoWeekHigh.toFixed(2)}`} />
        <Stat label="52週安値" value={quote.fiftyTwoWeekLow == null ? '-' : `$${quote.fiftyTwoWeekLow.toFixed(2)}`} />
      </section>

      <Card size="lg">
        <CardHeader title="チャート" hint="日足・週足・月足 / 5・25・75・200MA" />
        <div className="grid gap-5 xl:grid-cols-3">
          <div className="xl:col-span-3">
            <div className="mb-2 inline-flex items-center gap-2 text-[12px] font-bold text-[var(--color-brand-900)]">
              <LineChart size={15} /> 日足
            </div>
            <CandlestickChart ticker={quote.ticker} market="US" interval="D" height={460} maLines={[5, 25, 75, 200]} />
          </div>
          <div className="xl:col-span-3">
            <div className="mb-2 inline-flex items-center gap-2 text-[12px] font-bold text-[var(--color-brand-900)]">
              <TrendingUp size={15} /> 週足
            </div>
            <CandlestickChart ticker={quote.ticker} market="US" interval="W" height={360} maLines={[5, 25, 75, 200]} />
          </div>
          <div className="xl:col-span-3">
            <div className="mb-2 inline-flex items-center gap-2 text-[12px] font-bold text-[var(--color-brand-900)]">
              <Database size={15} /> 月足
            </div>
            <CandlestickChart ticker={quote.ticker} market="US" interval="M" height={340} maLines={[5, 25, 75, 200]} />
          </div>
        </div>
      </Card>

      <Card>
        <CardHeader title="US ML連携" hint="US分析DBを生成すると、既存MLパイプラインを市場別に再利用できます。" />
        <div className="grid gap-3 text-[12px] font-semibold text-[var(--color-text-secondary)] md:grid-cols-3">
          <div className="rounded-[4px] border border-[var(--color-border-default)] bg-[var(--color-surface-subtle)] p-3">
            1. `npm run batch:us-full` でTiingoデータとUSスナップショットを生成します。
          </div>
          <div className="rounded-[4px] border border-[var(--color-border-default)] bg-[var(--color-surface-subtle)] p-3">
            2. `npm run batch:us-analytics-db` でUS専用SQLiteを作成します。
          </div>
          <div className="rounded-[4px] border border-[var(--color-border-default)] bg-[var(--color-surface-subtle)] p-3">
            3. `npm run batch:us-ml-full` で既存MLをUS市場だけに対して学習できます。
          </div>
        </div>
      </Card>
    </div>
  )
}
