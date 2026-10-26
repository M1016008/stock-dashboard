'use client'

import Link from 'next/link'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowLeft,
  BrainCircuit,
  ChartCandlestick,
  GitCompareArrows,
  Landmark,
  LayoutDashboard,
  Loader2,
  NotebookPen,
} from 'lucide-react'
import { EmptyState, Notice } from '@/components/ui/EmptyState'
import { PriceDisplay } from '@/components/ui/PriceDisplay'
import { WatchlistButton } from '@/components/ui/WatchlistButton'
import { ScenarioProjectionChart } from '@/components/stock/ScenarioProjectionChart'
import { StockScenarioAiPanel } from '@/components/stock/StockScenarioAiPanel'
import { StockMovePeriods } from '@/components/stock/StockMovePeriods'
import { TradeScenarioNotebook } from '@/components/stock/TradeScenarioNotebook'
import { HistoricalAnalogExplorer } from '@/components/stock/HistoricalAnalogExplorer'
import { StockMlInsights } from '@/components/stock/StockMlInsights'
import {
  HistoricalAnalysisModeBar,
  type StockAnalysisReview,
} from '@/components/stock/HistoricalAnalysisModeBar'
import { UsOverviewWorkspace } from '@/components/us/stock-detail/UsOverviewWorkspace'
import { UsChartWorkspace } from '@/components/us/stock-detail/UsChartWorkspace'
import { UsMlDataStatus } from '@/components/us/stock-detail/UsMlDataStatus'
import {
  UsFundamentalsWorkspace,
  type UsFundamentalView,
} from '@/components/us/stock-detail/UsFundamentalsWorkspace'
import { useUsPhysicalMomentum } from '@/components/us/stock-detail/useUsPhysicalMomentum'
import type { StockQuote } from '@/types/stock'
import type { NextUsEarnings } from '@/lib/queries/us-earnings'
import {
  isComparedSymbol,
  recordRecentSymbol,
  toggleComparedSymbol,
  WORKSPACE_EVENT,
} from '@/lib/client/stock-workspace'

type Status = 'idle' | 'loading' | 'ready' | 'error'
type UsStockDetailTab = 'overview' | 'chart' | 'fundamental' | 'scenario' | 'ml'

// JP と同じハッシュ: #fundamental はサマリー、それ以外のサブビューは個別ハッシュ
const US_FUNDAMENTAL_HASHES: Record<Exclude<UsFundamentalView, 'summary'>, string> = {
  performance: 'performance',
  financial: 'financial',
  valuation: 'valuation',
  returns: 'returns',
}

export function UsStockDetailClient({
  ticker,
  initialQuote,
  initialNextEarnings,
  initialError,
}: {
  ticker: string
  initialQuote?: StockQuote | null
  initialNextEarnings?: NextUsEarnings | null
  initialError?: string | null
}) {
  const normalizedTicker = useMemo(() => ticker.toUpperCase(), [ticker])
  const [status, setStatus] = useState<Status>(initialQuote ? 'ready' : initialError ? 'error' : 'idle')
  const [quote, setQuote] = useState<StockQuote | null>(initialQuote ?? null)
  const [error, setError] = useState<string | null>(initialError ?? null)
  const [analysisDate, setAnalysisDate] = useState<string | null>(null)
  // URL の ?date= を読むまでは最新か過去かが確定しないため、価格の表示とタブ内の取得を待つ
  const [analysisParamsReady, setAnalysisParamsReady] = useState(false)
  const [showActual, setShowActual] = useState(false)
  const [analysisReview, setAnalysisReview] = useState<StockAnalysisReview | null>(null)
  const [activeTab, setActiveTab] = useState<UsStockDetailTab>('overview')
  const [fundamentalView, setFundamentalView] = useState<UsFundamentalView>('summary')
  const [compared, setCompared] = useState(false)

  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const date = params.get('date')
    const validDate = date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : null
    setAnalysisDate(validDate)
    setShowActual(Boolean(validDate && params.get('actual') === '1'))
    setAnalysisParamsReady(true)
  }, [normalizedTicker])

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

  const updateAnalysisDate = useCallback((date: string | null) => {
    // 前の日付の過去終値を新しい日付で一瞬でも表示しないよう、先に破棄する
    setAnalysisReview(null)
    setAnalysisDate(date)
    if (!date) setShowActual(false)
    const url = new URL(window.location.href)
    if (date) {
      url.searchParams.set('date', date)
    } else {
      url.searchParams.delete('date')
      url.searchParams.delete('actual')
    }
    window.history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`)
  }, [])

  const updateShowActual = useCallback((show: boolean) => {
    setShowActual(show)
    const url = new URL(window.location.href)
    if (show && analysisDate) {
      url.searchParams.set('actual', '1')
    } else {
      url.searchParams.delete('actual')
    }
    window.history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`)
  }, [analysisDate])

  // 過去分析モードでは指定日の終値だけを表示する。確認中・該当なしのときに最新の quote へ戻さない
  const displayedQuote = useMemo<StockQuote | null>(() => {
    if (!quote || !analysisParamsReady) return null
    if (!analysisDate) return quote
    if (!analysisReview?.available) return null
    const base = analysisReview.base
    return {
      ...quote,
      price: base.close,
      // StockQuote requires numbers, while Number.NaN preserves "unavailable"
      // for downstream finite-number guards without inventing a zero move.
      change: base.change ?? Number.NaN,
      changePercent: base.changePercent ?? Number.NaN,
      volume: base.volume,
      priceDate: base.date,
      fiftyTwoWeekHigh: base.fiftyTwoWeekHigh ?? undefined,
      fiftyTwoWeekLow: base.fiftyTwoWeekLow ?? undefined,
      marketCap: undefined,
      technicals: undefined,
    }
  }, [analysisDate, analysisParamsReady, analysisReview, quote])

  // 短期チェックの日次騰落: 最新は当日の値、過去分析は指定日の値。指定日の値が未確認なら null(今日の値で代用しない)
  const shortTermChangePercent = analysisDate
    ? analysisReview?.available ? analysisReview.base.changePercent : null
    : quote && !quote.isPriceDiscontinuous ? quote.changePercent : null

  const momentum = useUsPhysicalMomentum(
    quote?.ticker ?? null,
    analysisDate,
    analysisParamsReady && (activeTab === 'overview' || activeTab === 'chart'),
  )

  useEffect(() => {
    if (!quote) return
    const readTab = () => {
      const hash = window.location.hash.replace('#', '')
      if (hash === 'chart' || hash === 'scenario' || hash === 'ml' || hash === 'overview') {
        setActiveTab(hash)
      } else if (hash === 'fundamental') {
        setActiveTab('fundamental')
        setFundamentalView('summary')
      } else if (hash === 'performance' || hash === 'financial' || hash === 'valuation' || hash === 'returns') {
        setActiveTab('fundamental')
        setFundamentalView(hash)
      }
    }
    const syncCompared = () => setCompared(isComparedSymbol('US', quote.ticker))
    readTab()
    syncCompared()
    recordRecentSymbol({ market: 'US', ticker: quote.ticker, name: quote.name })
    window.addEventListener('hashchange', readTab)
    window.addEventListener(WORKSPACE_EVENT, syncCompared)
    return () => {
      window.removeEventListener('hashchange', readTab)
      window.removeEventListener(WORKSPACE_EVENT, syncCompared)
    }
  }, [quote])

  const selectTab = (tab: UsStockDetailTab) => {
    setActiveTab(tab)
    if (tab === 'fundamental') setFundamentalView('summary')
    const url = new URL(window.location.href)
    url.hash = tab
    window.history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`)
  }

  const selectFundamentalView = (view: UsFundamentalView) => {
    setActiveTab('fundamental')
    setFundamentalView(view)
    const url = new URL(window.location.href)
    url.hash = view === 'summary' ? 'fundamental' : US_FUNDAMENTAL_HASHES[view]
    window.history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`)
  }

  if (status === 'loading' || status === 'idle') {
    return (
      <div className="flex min-h-[420px] w-full items-center justify-center" role="status" aria-live="polite">
        <div className="inline-flex items-center gap-2 text-[13px] text-[var(--color-text-secondary)]">
          <Loader2 size={16} className="animate-spin" aria-hidden />
          {normalizedTicker} の米国株データを読み込んでいます…
        </div>
      </div>
    )
  }

  if (status === 'error' || !quote) {
    return (
      <div className="flex w-full min-w-0 flex-col gap-4">
        <Link href="/us/screener" prefetch={false} className="btn self-start" data-variant="ghost" data-size="sm">
          <ArrowLeft size={14} aria-hidden /> USスクリーナーへ戻る
        </Link>
        <div className="rounded-[var(--radius-card)] border border-[var(--color-border-default)] bg-white">
          <EmptyState
            title={`${normalizedTicker} の米国株データが見つかりません。`}
            description={<>{error ?? '米国株の日次データが未取得です。'} ティッカーとデータ更新状況を確認してください。</>}
            action={<Link href="/us/screener" prefetch={false} className="btn" data-size="sm">スクリーナーで探す</Link>}
          />
        </div>
      </div>
    )
  }

  const historicalPricePending = analysisParamsReady && Boolean(analysisDate) && !displayedQuote
  const hidePriceChange = Boolean(quote.isPriceDiscontinuous)

  return (
    <div className="flex w-full min-w-0 flex-col gap-4">
      <header className="stock-detail-sticky border-b border-[var(--color-border-default)] bg-white">
        <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3 pb-3 pt-0.5">
          <div className="flex min-w-0 flex-1 basis-[360px] flex-col gap-1.5">
            <Link href="/us/screener" prefetch={false} className="inline-flex items-center gap-1 self-start text-[12px] font-bold text-[var(--color-brand-700)] hover:underline">
              <ArrowLeft size={13} aria-hidden /> 米国株 / USスクリーナー
            </Link>
            <div className="flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1.5">
              <WatchlistButton ticker={quote.ticker} market="US" size="md" />
              <h1 className="m-0 flex min-w-0 flex-wrap items-baseline gap-x-2.5 gap-y-1">
                <span className="font-mono text-[22px] font-bold leading-none text-[var(--color-brand-800)]">{quote.ticker}</span>
                {quote.name && <span className="min-w-0 break-words text-[18px] font-bold leading-tight text-[var(--color-text-primary)]">{quote.name}</span>}
              </h1>
              <span className="status-tag">{quote.exchange ?? 'US'}</span>
              <span className="status-tag" data-tone="brand">US EOD</span>
            </div>
          </div>
          <div className="flex shrink-0 items-end gap-3">
            {displayedQuote ? (
              <div className="text-right">
                <PriceDisplay
                  value={displayedQuote.price}
                  change={hidePriceChange ? undefined : analysisDate ? analysisReview?.base.change ?? undefined : displayedQuote.change}
                  changePercent={hidePriceChange ? undefined : analysisDate ? analysisReview?.base.changePercent ?? undefined : displayedQuote.changePercent}
                  currency="USD"
                  size="lg"
                />
                <div className="mt-1 font-mono text-[11px] tabular-nums text-[var(--color-text-tertiary)]">
                  {analysisDate
                    ? `過去終値 ${displayedQuote.priceDate ?? analysisDate}`
                    : displayedQuote.priceDate ? `価格日 ${displayedQuote.priceDate}` : '最新価格'}
                </div>
              </div>
            ) : historicalPricePending ? (
              <div className="min-w-[112px] text-right" role="status">
                <div className="font-mono text-lg font-bold text-[var(--color-text-tertiary)]" aria-hidden="true">—</div>
                <div className="mt-1 text-[11px] font-medium text-[var(--color-text-tertiary)]">
                  <span className="font-mono tabular-nums">{analysisDate}</span> の終値を確認中、または該当なし
                </div>
              </div>
            ) : (
              // ?date= の読み取り前: 最新値をまだ見せず、高さだけ確保する
              <div className="invisible text-right" aria-hidden="true">
                <PriceDisplay value={quote.price} currency="USD" size="lg" />
                <div className="mt-1 font-mono text-[11px]">価格日</div>
              </div>
            )}
            <button
              type="button"
              onClick={() => setCompared(toggleComparedSymbol({ market: 'US', ticker: quote.ticker, name: quote.name }))}
              className="btn max-sm:min-h-11! max-sm:min-w-11!"
              data-variant={compared ? 'primary' : undefined}
              aria-pressed={compared}
              aria-label={compared ? '比較から外す' : '比較へ追加'}
              title={compared ? '比較から外す' : '比較へ追加'}
            >
              <GitCompareArrows size={14} aria-hidden />
              <span className="hidden sm:inline">{compared ? '比較中' : '比較に追加'}</span>
            </button>
          </div>
        </div>
        {quote.priceQualityWarning && (
          <Notice tone="warning" className="mb-3">{quote.priceQualityWarning}</Notice>
        )}
        <UsStockDetailTabs active={activeTab} onSelect={selectTab} />
      </header>

      <HistoricalAnalysisModeBar
        ticker={quote.ticker}
        market="US"
        analysisDate={analysisDate}
        latestDate={quote.priceDate}
        showActual={showActual}
        onDateChange={updateAnalysisDate}
        onShowActualChange={updateShowActual}
        onReviewChange={setAnalysisReview}
      />

      {analysisParamsReady && activeTab === 'overview' && (
        <UsOverviewWorkspace
          ticker={quote.ticker}
          quote={quote}
          displayedQuote={displayedQuote}
          analysisDate={analysisDate}
          shortTermChangePercent={shortTermChangePercent}
          nextEarnings={initialNextEarnings ?? null}
          momentum={momentum}
        />
      )}

      {analysisParamsReady && activeTab === 'chart' && (
        <UsChartWorkspace
          ticker={quote.ticker}
          companyName={quote.name ?? null}
          analysisDate={analysisDate}
          showActual={showActual}
          momentum={momentum}
        />
      )}

      {analysisParamsReady && activeTab === 'fundamental' && (
        <UsFundamentalsWorkspace
          ticker={quote.ticker}
          analysisDate={analysisDate}
          view={fundamentalView}
          onViewChange={selectFundamentalView}
        />
      )}

      {/* 読み順: 価格の見通し(投影) → 値動きの区間 → 自分のメモ → AI */}
      {analysisParamsReady && activeTab === 'scenario' && (
        <>
          <ScenarioProjectionChart
            ticker={quote.ticker}
            market="US"
            name={quote.name ?? quote.ticker}
            analysisDate={analysisDate}
            showActual={showActual}
            onUseLatest={() => updateAnalysisDate(null)}
          />
          <StockMovePeriods ticker={quote.ticker} market="US" analysisDate={analysisDate} />
          <TradeScenarioNotebook
            ticker={quote.ticker}
            market="US"
            name={quote.name ?? quote.ticker}
            quote={displayedQuote}
            selectedRange={null}
            context={{
              exchange: quote.exchange,
              currency: quote.currency,
              source: 'US EOD',
            }}
          />
          <StockScenarioAiPanel ticker={quote.ticker} market="US" name={quote.name ?? quote.ticker} analysisDate={analysisDate} />
        </>
      )}

      {/* 読み順: すぐ読める類似銘柄 → 操作して探す過去局面 → データの準備状況(折りたたみ) */}
      {analysisParamsReady && activeTab === 'ml' && (
        <>
          <StockMlInsights ticker={quote.ticker} market="US" analysisDate={analysisDate} />
          <HistoricalAnalogExplorer ticker={quote.ticker} market="US" analysisDate={analysisDate} />
          <UsMlDataStatus ticker={quote.ticker} analysisDate={analysisDate} />
        </>
      )}
    </div>
  )
}

function UsStockDetailTabs({
  active,
  onSelect,
}: {
  active: UsStockDetailTab
  onSelect: (tab: UsStockDetailTab) => void
}) {
  const activeTabRef = useRef<HTMLButtonElement | null>(null)
  // 狭い画面で横スクロールするタブ列でも、選択中のタブを常に見える位置へ寄せる
  useEffect(() => {
    activeTabRef.current?.scrollIntoView({ behavior: 'auto', block: 'nearest', inline: 'center' })
  }, [active])
  const tabs = [
    { id: 'overview' as const, label: '概要', icon: LayoutDashboard },
    { id: 'chart' as const, label: 'チャート・6ステージ', icon: ChartCandlestick },
    { id: 'fundamental' as const, label: 'ファンダメンタル', icon: Landmark },
    { id: 'scenario' as const, label: 'シナリオ', icon: NotebookPen },
    { id: 'ml' as const, label: '類似・ML', icon: BrainCircuit },
  ]
  return (
    <nav className="-mb-px flex gap-1 overflow-x-auto overscroll-x-contain [scrollbar-width:none]" aria-label="US個別銘柄分析">
      {tabs.map((tab) => {
        const Icon = tab.icon
        return (
          <button
            key={tab.id}
            ref={active === tab.id ? activeTabRef : undefined}
            type="button"
            onClick={() => onSelect(tab.id)}
            className={`inline-flex h-11 shrink-0 items-center gap-1.5 border-b-2 px-3 text-[13px] sm:h-10 ${
              active === tab.id
                ? 'border-[var(--color-brand-800)] font-bold text-[var(--color-text-primary)]'
                : 'border-transparent font-semibold text-[var(--color-text-secondary)] hover:border-[var(--color-border-default)] hover:text-[var(--color-text-primary)]'
            }`}
            aria-current={active === tab.id ? 'page' : undefined}
          >
            <Icon size={15} aria-hidden className={active === tab.id ? 'text-[var(--color-brand-700)]' : undefined} />
            {tab.label}
          </button>
        )
      })}
    </nav>
  )
}
