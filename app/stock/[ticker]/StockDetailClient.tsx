// app/stock/[ticker]/StockDetailClient.tsx
'use client'

import Link from 'next/link'
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import {
  BrainCircuit,
  BookOpenText,
  Building2,
  ChartCandlestick,
  ChevronRight,
  FileSearch,
  GitCompareArrows,
  LayoutDashboard,
  Landmark,
  NotebookPen,
  Scale,
  TrendingUp,
  Users,
  WalletCards,
} from 'lucide-react'
import { MarketBadge } from '@/components/ui/MarketBadge'
import { MarginBadges } from '@/components/ui/MarginBadges'
import { PriceDisplay } from '@/components/ui/PriceDisplay'
import { CandlestickChart } from '@/components/charts/CandlestickChart'
import { PerformanceCard } from '@/components/stock/PerformanceCard'
import { EarningsCard } from '@/components/stock/EarningsCard'
import { WatchlistButton } from '@/components/ui/WatchlistButton'
import { StageTimeline, type StageTimelineSnapshot } from '@/components/stock/StageTimeline'
import { StockMovePeriods } from '@/components/stock/StockMovePeriods'
import { Ma25mMonitorSummary } from '@/components/stock/Ma25mMonitorSummary'
import { StockMlInsights } from '@/components/stock/StockMlInsights'
import { HistoricalAnalogExplorer } from '@/components/stock/HistoricalAnalogExplorer'
import { ScenarioProjectionChart } from '@/components/stock/ScenarioProjectionChart'
import { TradeScenarioNotebook } from '@/components/stock/TradeScenarioNotebook'
import { StockScenarioAiPanel } from '@/components/stock/StockScenarioAiPanel'
import { StockDecisionSummary } from '@/components/stock/StockDecisionSummary'
import { FinancialPerformanceTimeline } from '@/components/stock/FinancialPerformanceTimeline'
import { FinancialPerformanceDetail } from '@/components/stock/FinancialPerformanceDetail'
import { FinancialDetail } from '@/components/stock/FinancialDetail'
import { ValuationDetail } from '@/components/stock/ValuationDetail'
import { ShareholderReturnsDetail } from '@/components/stock/ShareholderReturnsDetail'
import { CompanyInformationDetail } from '@/components/stock/CompanyInformationDetail'
import { SimilarityComparisonDetail } from '@/components/stock/SimilarityComparisonDetail'
import {
  HistoricalAnalysisModeBar,
  type StockAnalysisReview,
} from '@/components/stock/HistoricalAnalysisModeBar'
import { findTicker } from '@/lib/master/tickers'
import {
  buildStockDecisionSummaryUrls,
  formatTechnicalSnapshotDateLabel,
  selectPhysicalMomentumScoreRow,
} from '@/lib/stock-decision-summary'
import { STAGE_BG_COLORS, STAGE_BORDER_COLORS, STAGE_LABELS } from '@/lib/hex-stage'
import { buildShortTermCheck, formatShortTermStrength, type ShortTermCheckTone } from '@/lib/short-term-check'
import { physicsStatusTone, type PhysicsStatus } from '@/lib/ml/physics-analysis'
import {
  buildPhysicalMomentumView,
  buildPhysicalRawMetricView,
  describePhysicalScore,
  type PhysicalMomentumCheck,
  type PhysicalMomentumTone,
} from '@/lib/physical-momentum-view'
import {
  physicalPlanDirectionLabel,
  physicalPlanStatisticsLabel,
  type PhysicalPlanDecision,
} from '@/lib/physical-plan'
import {
  isComparedSymbol,
  recordRecentSymbol,
  toggleComparedSymbol,
  WORKSPACE_EVENT,
} from '@/lib/client/stock-workspace'
import type { StockQuote } from '@/types/stock'

interface StockDetailClientProps {
  ticker: string
}

interface SectorMasterRow {
  ticker: string
  name?: string | null
  sector_large?: string | null
  sector_small?: string | null
  sector33?: string | null
  major_category?: string | null
  sub_industry?: string | null
  market_segment?: string | null
  margin_type?: string | null
}

interface StockMarginInfo {
  latest: {
    marginType: string | null
    asOfDate: string | null
    longMargin: number | null
    shortMargin: number | null
    longChange: number | null
    shortChange: number | null
    creditRatio: number | null
    shortRatio: number | null
  } | null
  history: Array<{
    date: string
    longMargin: number | null
    shortMargin: number | null
    longChange: number | null
    shortChange: number | null
  }>
}

interface StockOverviewInfo {
  financial: {
    latest: FinancialSummary | null
    previousComparable: FinancialSummary | null
    available: boolean
  }
  shareholders: {
    major: Array<{
      rank: number
      fiscalYearEnd: string | null
      holderName: string
      shares: number | null
      holdingRatio: number | null
      submittedAt: string | null
    }>
    policy: Array<{
      rank: number
      fiscalYearEnd: string | null
      issuerName: string
      shares: number | null
      bookValue: number | null
      purpose: string | null
      quantitativeEffect: string | null
      holdingType: string | null
      submittedAt: string | null
    }>
    largeReports: Array<{
      documentId: string
      submittedAt: string | null
      reportDate: string | null
      holderName: string | null
      shares: number | null
      holdingRatio: number | null
      previousHoldingRatio: number | null
      purpose: string | null
      reportKind: string | null
    }>
    edinetConfigured: boolean
  }
  statuses: Record<string, {
    status: string
    sourceDate: string | null
    message: string | null
    attemptedAt: number
  }>
  sources: {
    financial: string
    margin: string
    shareholders: string
  }
}

interface ShikihoProfile {
  ticker: string
  forecastPer: number | null
  actualPbr: number | null
  forecastRoe: number | null
  dividendYield: number | null
  headline1: string | null
  description1: string | null
  headline2: string | null
  description2: string | null
  issueLabel: string | null
  releaseDate: string | null
  companyFeature: string | null
  consolidatedBusiness: string | null
  updatedAt: number
}

interface ShikihoInfo {
  ticker: string
  profile: ShikihoProfile | null
  source: string
}

interface FinancialSummary {
  disclosureDate: string
  disclosureTime: string | null
  periodType: string | null
  periodStart: string | null
  periodEnd: string | null
  fiscalYearEnd: string | null
  sales: number | null
  operatingProfit: number | null
  ordinaryProfit: number | null
  netProfit: number | null
  eps: number | null
  totalAssets: number | null
  equity: number | null
  equityRatio: number | null
  bps: number | null
  operatingCashFlow: number | null
  investingCashFlow: number | null
  financingCashFlow: number | null
  cashEquivalents: number | null
  annualDividend: number | null
  payoutRatio: number | null
  forecastSales: number | null
  forecastOperatingProfit: number | null
  forecastNetProfit: number | null
  forecastEps: number | null
  forecastAnnualDividend: number | null
}

type StockDetailTab = 'overview' | 'chart' | 'fundamental' | 'scenario' | 'ml'
type FundamentalTab = 'summary' | 'performance' | 'financial' | 'valuation' | 'returns'

const FUNDAMENTAL_HASHES: Record<Exclude<FundamentalTab, 'summary'>, string> = {
  performance: 'performance',
  financial: 'financial',
  valuation: 'valuation',
  returns: 'returns',
}

export function StockDetailClient({ ticker }: StockDetailClientProps) {
  const [quote, setQuote] = useState<StockQuote | null>(null)
  const [smaster, setSmaster] = useState<SectorMasterRow | null>(null)
  const [marginInfo, setMarginInfo] = useState<StockMarginInfo | null>(null)
  const [shikihoInfo, setShikihoInfo] = useState<ShikihoInfo | null>(null)
  const [loading, setLoading] = useState(true)
  const [analysisDate, setAnalysisDate] = useState<string | null>(null)
  const [analysisParamsReady, setAnalysisParamsReady] = useState(false)
  const [showActual, setShowActual] = useState(false)
  const [analysisReview, setAnalysisReview] = useState<StockAnalysisReview | null>(null)
  const [activeTab, setActiveTab] = useState<StockDetailTab>('overview')
  const [fundamentalTab, setFundamentalTab] = useState<FundamentalTab>('summary')
  const [compared, setCompared] = useState(false)

  const hardcoded = findTicker(ticker)

  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const date = params.get('date')
    const validDate = date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : null
    setAnalysisDate(validDate)
    setShowActual(Boolean(validDate && params.get('actual') === '1'))
    setAnalysisParamsReady(true)
  }, [ticker])

  useEffect(() => {
    let cancelled = false
    let pending = 4
    const done = () => {
      pending -= 1
      if (!cancelled && pending <= 0) setLoading(false)
    }
    async function fetchData() {
      setLoading(true)
      setShikihoInfo(null)
      fetch(`/api/quote/${encodeURIComponent(ticker)}`, { cache: 'no-store' })
        .then((res) => res.ok ? res.json() : null)
        .then((data) => { if (!cancelled && data) setQuote(data) })
        .catch((error) => console.error('Failed to fetch quote:', error))
        .finally(done)

      fetch(`/api/sector-master/${encodeURIComponent(ticker)}`, { cache: 'no-store' })
        .then((res) => res.ok ? res.json() : null)
        .then((data) => { if (!cancelled) setSmaster(data?.master ?? null) })
        .catch((error) => console.error('Failed to fetch sector master:', error))
        .finally(done)

      fetch(`/api/stock-margin/${encodeURIComponent(ticker)}`, { cache: 'no-store' })
        .then((res) => res.ok ? res.json() : null)
        .then((data) => { if (!cancelled && data) setMarginInfo(data) })
        .catch((error) => console.error('Failed to fetch stock margin:', error))
        .finally(done)

      fetch(`/api/shikiho/${encodeURIComponent(ticker)}`, { cache: 'no-store' })
        .then((res) => res.ok ? res.json() : null)
        .then((data) => { if (!cancelled && data) setShikihoInfo(data) })
        .catch((error) => console.error('Failed to fetch Shikiho profile:', error))
        .finally(done)
    }
    fetchData()
    return () => { cancelled = true }
  }, [ticker])

  // 表示用にマージ: sector_master(JPX/CSV) → ハードコードマスタ
  const displaySectorLarge   = smaster?.sector_large   ?? hardcoded?.sectorLarge
  const displaySector33      = smaster?.sector33       ?? null
  const displayMajorCategory = smaster?.major_category ?? null
  const displaySubIndustry   = smaster?.sub_industry   ?? null
  const displayMarketSegment = smaster?.market_segment ?? hardcoded?.marketSegment
  const displayMarginType    = smaster?.margin_type    ?? hardcoded?.marginType

  const displayCode = ticker.replace('.T', '')
  const name = smaster?.name ?? hardcoded?.name ?? quote?.name ?? '---'
  const displayedQuote = useMemo<StockQuote | null>(() => {
    if (!analysisParamsReady) return null
    if (!analysisDate) return quote
    if (!analysisReview?.available) return null
    const base = analysisReview.base
    return {
      ticker,
      market: 'JP',
      name,
      currency: 'JPY',
      price: base.close,
      change: base.change ?? 0,
      changePercent: base.changePercent ?? 0,
      volume: base.volume,
      priceDate: base.date,
      fiftyTwoWeekHigh: base.fiftyTwoWeekHigh ?? undefined,
      fiftyTwoWeekLow: base.fiftyTwoWeekLow ?? undefined,
    }
  }, [analysisDate, analysisParamsReady, analysisReview, name, quote, ticker])

  useEffect(() => {
    let legacyFocusTimer: number | null = null
    const readTab = () => {
      const hash = window.location.hash.replace('#', '')
      const legacyQueryTab = new URLSearchParams(window.location.search).get('tab')
      if (hash === 'company' || hash === 'shikiho' || legacyQueryTab === 'company' || legacyQueryTab === 'shikiho') {
        setActiveTab('overview')
        setFundamentalTab('summary')
        const url = new URL(window.location.href)
        url.searchParams.delete('tab')
        url.hash = 'overview'
        window.history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`)
        if (legacyFocusTimer != null) window.clearTimeout(legacyFocusTimer)
        legacyFocusTimer = window.setTimeout(() => {
          document.getElementById('company-basic-info')?.scrollIntoView({ behavior: 'auto', block: 'start' })
        }, 0)
      } else if (hash === 'performance' || hash === 'financial' || hash === 'valuation' || hash === 'returns') {
        setActiveTab('fundamental')
        setFundamentalTab(hash)
      } else if (hash === 'fundamental') {
        setActiveTab('fundamental')
        setFundamentalTab('summary')
      } else if (hash === 'chart' || hash === 'scenario' || hash === 'ml' || hash === 'overview') {
        setActiveTab(hash)
      }
    }
    const syncCompared = () => setCompared(isComparedSymbol('JP', displayCode))
    readTab()
    syncCompared()
    recordRecentSymbol({ market: 'JP', ticker: displayCode, name: name === '---' ? null : name })
    window.addEventListener('hashchange', readTab)
    window.addEventListener(WORKSPACE_EVENT, syncCompared)
    return () => {
      if (legacyFocusTimer != null) window.clearTimeout(legacyFocusTimer)
      window.removeEventListener('hashchange', readTab)
      window.removeEventListener(WORKSPACE_EVENT, syncCompared)
    }
  }, [displayCode, name])

  const selectTab = (tab: StockDetailTab) => {
    setActiveTab(tab)
    if (tab === 'fundamental') setFundamentalTab('summary')
    const url = new URL(window.location.href)
    url.hash = tab
    window.history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`)
  }

  const selectFundamentalTab = (tab: FundamentalTab) => {
    setActiveTab('fundamental')
    setFundamentalTab(tab)
    const url = new URL(window.location.href)
    url.hash = tab === 'summary' ? 'fundamental' : FUNDAMENTAL_HASHES[tab]
    window.history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`)
  }

  const updateAnalysisDate = useCallback((date: string | null) => {
    setAnalysisReview(null)
    setAnalysisDate(date)
    if (!date) {
      setShowActual(false)
      setAnalysisReview(null)
    }
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

  return (
    <div className="flex flex-col gap-3 p-3 sm:gap-4 sm:p-4">

      <div className="stock-detail-sticky border border-[var(--color-border-default)] bg-white shadow-[0_2px_8px_rgba(16,32,52,0.12)]">
        {/* ヘッダー */}
        <div style={{
          display: 'flex',
          alignItems: 'center',
          gap: '12px',
          padding: '10px 12px 8px',
          flexWrap: 'wrap',
        }}>
          <div className="flex w-full min-w-0 flex-none flex-wrap items-center gap-x-3 gap-y-2.5 sm:w-auto sm:flex-1">
            <span style={{ fontSize: '22px', lineHeight: 1 }}>
              <WatchlistButton ticker={ticker} size="md" />
            </span>
            <h1 style={{ display: 'flex', minWidth: 0, alignItems: 'baseline', gap: '8px', margin: 0, flexWrap: 'wrap' }}>
              <span style={{
                fontFamily: 'var(--font-mono)',
                fontSize: '22px',
                fontWeight: 800,
                color: 'var(--accent-primary)',
              }}>
                {displayCode}
              </span>
              <MarketBadge />
              <span className="min-w-0 text-[16px] font-bold leading-tight text-[var(--text-primary)] sm:text-[17px]">
                {name}
              </span>
            </h1>
            <StockHeaderClassifications
              marketSegment={displayMarketSegment}
              sector17={displaySectorLarge}
              sector33={displaySector33}
              majorCategory={displayMajorCategory}
              subIndustry={displaySubIndustry}
              analysisDate={analysisDate}
            />
          </div>

          <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: '8px' }}>
            <button
              type="button"
              onClick={() => setCompared(toggleComparedSymbol({ market: 'JP', ticker: displayCode, name }))}
              className={`inline-flex h-8 items-center gap-1.5 border px-2.5 text-[11px] font-black ${
                compared
                  ? 'border-[var(--color-market-red)] bg-[var(--color-price-up-bg)] text-[var(--color-market-red)]'
                  : 'border-[var(--color-border-default)] bg-white text-[var(--color-text-secondary)]'
              }`}
              title={compared ? '比較から外す' : '比較へ追加'}
            >
              <GitCompareArrows size={14} />
              <span className="hidden sm:inline">{compared ? '比較中' : '比較'}</span>
            </button>
            {displayedQuote && (
              <div className="text-right">
                <PriceDisplay
                  value={displayedQuote.price}
                  change={displayedQuote.change}
                  changePercent={displayedQuote.changePercent}
                  currency={displayedQuote.currency}
                  size="lg"
                />
                <div className="mt-1 text-[9px] font-bold text-[var(--color-text-tertiary)]">
                  {analysisDate ? `過去終値 ${displayedQuote.priceDate ?? analysisDate}` : displayedQuote.priceDate ? `価格日 ${displayedQuote.priceDate}` : '最新価格'}
                </div>
              </div>
            )}
            {analysisParamsReady && analysisDate && !displayedQuote && (
              <div className="min-w-[112px] text-right" aria-label="過去終値を読み込み中">
                <div className="font-mono text-lg font-black text-[var(--color-text-tertiary)]">—</div>
                <div className="mt-1 text-[9px] font-bold text-[var(--color-text-tertiary)]">過去終値を読込中</div>
              </div>
            )}
            {loading && <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>読込中...</span>}
          </div>
        </div>
        <StockDetailTabs active={activeTab} onSelect={selectTab} />
      </div>

      <HistoricalAnalysisModeBar
        ticker={displayCode}
        market="JP"
        analysisDate={analysisDate}
        latestDate={quote?.priceDate}
        showActual={showActual}
        onDateChange={updateAnalysisDate}
        onShowActualChange={updateShowActual}
        onReviewChange={setAnalysisReview}
      />

      {activeTab === 'overview' && (
        <OverviewWorkspace
          ticker={ticker}
          quote={quote}
          displayedQuote={displayedQuote}
          marginInfo={marginInfo}
          fallbackType={displayMarginType}
          analysisDate={analysisDate}
          loading={loading}
          classifications={{
            marketSegment: displayMarketSegment,
            sector17: displaySectorLarge,
            sector33: displaySector33,
            majorCategory: displayMajorCategory,
            subIndustry: displaySubIndustry,
          }}
          shikihoInfo={shikihoInfo}
        />
      )}

      {activeTab === 'chart' && (
        <ChartWorkspace
          ticker={ticker}
          analysisDate={analysisDate}
          showActual={showActual}
        />
      )}

      {activeTab === 'fundamental' && (
        <FundamentalWorkspace
          ticker={ticker}
          analysisDate={analysisDate}
          quote={displayedQuote}
          active={fundamentalTab}
          onSelect={selectFundamentalTab}
        />
      )}

      {activeTab === 'scenario' && (
        <>
          <TradeScenarioNotebook
            ticker={ticker}
            name={name}
            quote={displayedQuote}
            selectedRange={null}
            context={{
              marketSegment: displayMarketSegment,
              marginType: displayMarginType,
              sector17: displaySectorLarge,
              sector33: displaySector33,
            }}
          />
          <StockMovePeriods ticker={ticker} analysisDate={analysisDate} />
          <ScenarioProjectionChart
            ticker={ticker}
            name={name}
            analysisDate={analysisDate}
            showActual={showActual}
            onUseLatest={() => updateAnalysisDate(null)}
          />
          <StockScenarioAiPanel ticker={ticker} name={name} analysisDate={analysisDate} />
        </>
      )}

      {activeTab === 'ml' && (
        <>
          <SimilarityComparisonDetail ticker={ticker} analysisDate={analysisDate} />
          <HistoricalAnalogExplorer ticker={ticker} analysisDate={analysisDate} />
          <StockMlInsights ticker={ticker} analysisDate={analysisDate} />
        </>
      )}

    </div>
  )
}

function StockDetailTabs({
  active,
  onSelect,
}: {
  active: StockDetailTab
  onSelect: (tab: StockDetailTab) => void
}) {
  const activeTabRef = useRef<HTMLButtonElement | null>(null)
  useEffect(() => {
    activeTabRef.current?.scrollIntoView({ behavior: 'auto', block: 'nearest', inline: 'center' })
  }, [active])
  const tabs = [
    { id: 'overview' as const, label: '概要', icon: LayoutDashboard },
    { id: 'chart' as const, label: 'チャート・6ステージ', icon: ChartCandlestick },
    { id: 'fundamental' as const, label: 'ファンダメンタル', icon: Landmark },
    { id: 'scenario' as const, label: 'シナリオ', icon: NotebookPen },
    { id: 'ml' as const, label: '類似・比較', icon: BrainCircuit },
  ]
  return (
    <nav className="flex overflow-x-auto border-t border-[var(--color-border-soft)] bg-[var(--color-surface-subtle)] px-2" aria-label="個別銘柄分析">
      {tabs.map((tab) => {
        const Icon = tab.icon
        return (
          <button
            key={tab.id}
            ref={active === tab.id ? activeTabRef : undefined}
            type="button"
            onClick={() => onSelect(tab.id)}
            className={`inline-flex h-11 shrink-0 items-center gap-1.5 border-b-2 px-3 text-[11px] font-black sm:h-9 ${
              active === tab.id
                ? 'border-[var(--color-market-red)] bg-white text-[var(--color-brand-900)]'
                : 'border-transparent text-[var(--color-text-secondary)] hover:bg-white'
            }`}
            aria-current={active === tab.id ? 'page' : undefined}
          >
            <Icon size={14} />
            {tab.label}
          </button>
        )
      })}
    </nav>
  )
}

type TechnicalMomentumSnapshot = {
  status: 'loading' | 'available' | 'missing' | 'error'
  scoreDate: string | null
  maDate: string | null
  pms: number | null
  pfs: number | null
  pes: number | null
  isScoreFresh: boolean | null
  scoreSource: PhysicalMomentumResponse['scoreSource']
  maStructure: string | null
  maDescription: string | null
  message: string | null
}

const CHART_STAGE_AXES: Array<{
  key: keyof NonNullable<StageTimelineSnapshot['stages']>
  label: string
}> = [
  { key: 'dailyA', label: '日A' },
  { key: 'dailyB', label: '日B' },
  { key: 'weeklyA', label: '週A' },
  { key: 'weeklyB', label: '週B' },
  { key: 'monthlyA', label: '月A' },
  { key: 'monthlyB', label: '月B' },
]

function ChartWorkspace({
  ticker,
  analysisDate,
  showActual,
}: {
  ticker: string
  analysisDate: string | null
  showActual: boolean
}) {
  const [stageSnapshot, setStageSnapshot] = useState<StageTimelineSnapshot>({
    status: 'loading',
    date: null,
    stages: null,
    message: null,
  })
  const [momentumSnapshot, setMomentumSnapshot] = useState<TechnicalMomentumSnapshot>({
    status: 'loading',
    scoreDate: null,
    maDate: null,
    pms: null,
    pfs: null,
    pes: null,
    isScoreFresh: null,
    scoreSource: null,
    maStructure: null,
    maDescription: null,
    message: null,
  })
  const handleStageSnapshot = useCallback((snapshot: StageTimelineSnapshot) => {
    setStageSnapshot(snapshot)
  }, [])
  const handleMomentumSnapshot = useCallback((snapshot: TechnicalMomentumSnapshot) => {
    setMomentumSnapshot(snapshot)
  }, [])

  useEffect(() => {
    setStageSnapshot({ status: 'loading', date: null, stages: null, message: null })
    setMomentumSnapshot({
      status: 'loading',
      scoreDate: null,
      maDate: null,
      pms: null,
      pfs: null,
      pes: null,
      isScoreFresh: null,
      scoreSource: null,
      maStructure: null,
      maDescription: null,
      message: null,
    })
  }, [analysisDate, ticker])

  return (
    <div className="space-y-3" aria-label="チャート・6ステージ分析">
      <TechnicalChartSnapshot stage={stageSnapshot} momentum={momentumSnapshot} analysisDate={analysisDate} />

      <StageTimeline
        ticker={ticker}
        analysisDate={analysisDate}
        onSnapshotChange={handleStageSnapshot}
      />

      <section className="overflow-hidden border border-[var(--color-border-default)] bg-white" aria-labelledby="main-chart-title">
        <header className="flex flex-wrap items-end justify-between gap-2 border-b border-[var(--color-border-soft)] bg-[var(--color-surface-subtle)] px-3 py-2.5">
          <div>
            <div className="text-[9px] font-black uppercase tracking-[0.08em] text-[var(--color-text-tertiary)]">Price &amp; moving averages</div>
            <h2 id="main-chart-title" className="mt-0.5 text-[13px] font-black text-[var(--color-text-primary)]">マルチタイムフレームチャート</h2>
          </div>
          <span className="text-[9px] font-semibold text-[var(--color-text-tertiary)]">Stageの形を価格・MA・出来高で確認</span>
        </header>
        <div className="px-2 pb-2 sm:px-3 sm:pb-3">
          <CandlestickChart
            ticker={ticker}
            interval="D"
            height={460}
            historyPeriod="all"
            showTimeframeSelector
            maLinesByInterval={{ M: [3, 5, 10, 15, 20, 25] }}
            analysisDate={analysisDate}
            revealAfterAnalysis={showActual}
          />
        </div>
      </section>

      <PhysicalMomentumSection
        ticker={ticker}
        analysisDate={analysisDate}
        onSnapshotChange={handleMomentumSnapshot}
      />

      <Ma25mMonitorSummary ticker={ticker} analysisDate={analysisDate} />
    </div>
  )
}

function TechnicalChartSnapshot({
  stage,
  momentum,
  analysisDate,
}: {
  stage: StageTimelineSnapshot
  momentum: TechnicalMomentumSnapshot
  analysisDate: string | null
}) {
  const stageCode = stage.stages
    ? CHART_STAGE_AXES.map(({ key }) => stage.stages?.[key] ?? '-').join('')
    : '------'
  const referenceDateLabel = formatTechnicalSnapshotDateLabel({
    stageDate: stage.date,
    scoreDate: momentum.scoreDate,
    maDate: momentum.maDate,
    analysisDate,
  })
  const stageMessage = stage.status === 'loading'
    ? 'Stageを読込中'
    : stage.status === 'error'
      ? `Stage取得エラー: ${stage.message ?? '詳細不明'}`
      : stage.status === 'missing'
        ? stage.message ?? 'Stage履歴なし'
        : `現在Stage ${stageCode}`
  const stateTitle = momentum.status === 'available'
    ? momentum.maStructure ?? 'MA力場は未判定'
    : momentum.status === 'loading'
      ? '運動状態を読込中'
      : momentum.status === 'error'
        ? 'PMS取得エラー'
        : 'PMS未計算'

  return (
    <section className="overflow-hidden border border-[var(--color-border-default)] bg-white" aria-labelledby="technical-snapshot-title">
      <header className="flex flex-wrap items-start justify-between gap-2 border-b border-[var(--color-border-soft)] bg-[var(--color-surface-subtle)] px-3 py-2.5">
        <div>
          <div className="text-[9px] font-black uppercase tracking-[0.08em] text-[var(--color-text-tertiary)]">Technical snapshot</div>
          <h2 id="technical-snapshot-title" className="mt-0.5 text-[13px] font-black text-[var(--color-text-primary)]">現在のテクニカル構造</h2>
        </div>
        <span className="font-mono text-[9px] font-bold text-[var(--color-text-tertiary)]">{referenceDateLabel}</span>
      </header>

      <div className="grid gap-3 p-3 lg:grid-cols-[minmax(190px,0.8fr)_minmax(380px,1.6fr)_minmax(270px,1fr)] lg:items-stretch">
        <div className="flex min-w-0 flex-col justify-center border-b border-[var(--color-border-soft)] pb-3 lg:border-b-0 lg:border-r lg:pb-0 lg:pr-4">
          <span className="text-[9px] font-bold text-[var(--color-text-tertiary)]">現在地</span>
          <strong className="mt-1 text-[17px] font-black leading-tight text-[var(--color-text-primary)]">{stateTitle}</strong>
          <span className="mt-1 text-[10px] font-semibold leading-4 text-[var(--color-text-secondary)]">{momentum.maDescription ?? stageMessage}</span>
        </div>

        <div className="min-w-0">
          <div className="mb-1.5 flex items-center justify-between gap-2">
            <span className="text-[9px] font-bold text-[var(--color-text-tertiary)]">6 Stage</span>
            <span className="font-mono text-[11px] font-black text-[var(--color-text-primary)]">{stageCode}</span>
          </div>
          <div className="grid grid-cols-6 gap-1" aria-label={`6ステージ ${stageCode}`}>
            {CHART_STAGE_AXES.map(({ key, label }) => {
              const value = stage.stages?.[key] ?? null
              return (
                <div key={key} className="min-w-0 text-center">
                  <div className="text-[9px] font-bold text-[var(--color-text-tertiary)]">{label}</div>
                  <div
                    className="mt-1 flex min-h-10 flex-col items-center justify-center border text-white"
                    style={{
                      background: value ? STAGE_BG_COLORS[value] : 'var(--color-surface-subtle)',
                      borderColor: value ? STAGE_BORDER_COLORS[value] : 'var(--color-border-default)',
                      color: value ? '#fff' : 'var(--color-text-tertiary)',
                    }}
                    title={value ? `S${value}: ${STAGE_LABELS[value]}` : stageMessage}
                  >
                    <strong className="font-mono text-[14px] leading-none">{value ? `S${value}` : '—'}</strong>
                    {value && <span className="mt-0.5 text-[9px] font-bold leading-tight">{STAGE_LABELS[value]}</span>}
                  </div>
                </div>
              )
            })}
          </div>
        </div>

        <div className="grid grid-cols-3 gap-1.5 border-t border-[var(--color-border-soft)] pt-3 lg:border-l lg:border-t-0 lg:pl-4 lg:pt-0">
          {[
            { code: 'PMS', label: '運動状態', value: momentum.pms },
            { code: 'PFS', label: '足元の力', value: momentum.pfs },
            { code: 'PES', label: '熱量', value: momentum.pes },
          ].map((metric) => (
            <div key={metric.code} className="flex min-w-0 flex-col justify-center bg-[var(--color-surface-subtle)] px-2 py-2 text-center">
              <span className="text-[9px] font-black text-[var(--color-text-tertiary)]">{metric.code}</span>
              <strong className="mt-0.5 font-mono text-[15px] font-black text-[var(--color-text-primary)]">{fmtScore(metric.value)}</strong>
              <span className="mt-0.5 text-[9px] font-semibold leading-tight text-[var(--color-text-tertiary)]">{metric.label}</span>
            </div>
          ))}
          {momentum.status !== 'available' && (
            <div className="col-span-3 text-[9px] font-semibold text-[var(--color-text-tertiary)]">
              {momentum.status === 'loading' ? 'PMS/PFS/PESを読込中' : momentum.message ?? 'PMS/PFS/PESは利用できません'}
            </div>
          )}
        </div>
      </div>
    </section>
  )
}

function FundamentalWorkspace({
  ticker,
  analysisDate,
  quote,
  active,
  onSelect,
}: {
  ticker: string
  analysisDate: string | null
  quote: StockQuote | null
  active: FundamentalTab
  onSelect: (tab: FundamentalTab) => void
}) {
  const activeTabRef = useRef<HTMLButtonElement | null>(null)
  useEffect(() => {
    activeTabRef.current?.scrollIntoView({ behavior: 'auto', block: 'nearest', inline: 'center' })
  }, [active])
  const tabs = [
    { id: 'summary' as const, label: 'サマリー', icon: LayoutDashboard },
    { id: 'performance' as const, label: '業績', icon: TrendingUp },
    { id: 'financial' as const, label: '財務', icon: Landmark },
    { id: 'valuation' as const, label: 'バリュエーション', icon: Scale },
    { id: 'returns' as const, label: '株主還元', icon: WalletCards },
  ]

  return (
    <section className="space-y-6 bg-white pb-2" aria-labelledby="fundamental-workspace-title">
      <div className="overflow-hidden border-y border-[var(--color-border-soft)] bg-white">
        <header className="flex flex-wrap items-end justify-between gap-2 border-b border-[var(--color-border-soft)] px-4 py-3 sm:px-5">
          <div>
            <h2 id="fundamental-workspace-title" className="text-[15px] font-bold text-[var(--color-text-primary)]">ファンダメンタル</h2>
            <p className="mt-1 text-[10px] font-medium text-[var(--color-text-tertiary)]">業績から評価、株主還元へ順に読み解く</p>
          </div>
          <span className="font-mono text-[10px] font-semibold text-[var(--color-text-tertiary)]">基準日 {analysisDate ?? quote?.priceDate ?? '---'}</span>
        </header>
        <nav className="flex overflow-x-auto bg-white px-2 sm:px-3" aria-label="ファンダメンタル分析" role="tablist">
          {tabs.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              ref={active === id ? activeTabRef : undefined}
              type="button"
              onClick={() => onSelect(id)}
              className={`inline-flex h-11 shrink-0 items-center gap-1.5 border-b-2 px-3 text-[11px] font-bold sm:h-9 ${
                active === id
                  ? 'border-[var(--color-brand-700)] bg-white text-[var(--color-brand-900)]'
                  : 'border-transparent text-[var(--color-text-secondary)] hover:bg-white'
              }`}
              role="tab"
              aria-selected={active === id}
              aria-current={active === id ? 'page' : undefined}
            >
              <Icon size={13} aria-hidden="true" />
              {label}
            </button>
          ))}
        </nav>
      </div>

      {active === 'summary' && <StockDecisionSummary ticker={ticker} analysisDate={analysisDate} quote={quote} variant="fundamental" />}
      {active === 'performance' && (
        <FinancialPerformanceDetail ticker={ticker} analysisDate={analysisDate} />
      )}
      {active === 'financial' && <FinancialDetail ticker={ticker} analysisDate={analysisDate} />}
      {active === 'valuation' && <ValuationDetail ticker={ticker} analysisDate={analysisDate} />}
      {active === 'returns' && <ShareholderReturnsDetail ticker={ticker} analysisDate={analysisDate} />}
    </section>
  )
}

function OverviewWorkspace({
  ticker,
  quote,
  displayedQuote,
  marginInfo,
  fallbackType,
  analysisDate,
  loading,
  classifications,
  shikihoInfo,
}: {
  ticker: string
  quote: StockQuote | null
  displayedQuote: StockQuote | null
  marginInfo: StockMarginInfo | null
  fallbackType?: string | null
  analysisDate: string | null
  loading: boolean
  classifications: {
    marketSegment?: string | null
    sector17?: string | null
    sector33?: string | null
    majorCategory?: string | null
    subIndustry?: string | null
  }
  shikihoInfo: ShikihoInfo | null
}) {
  const [physicalMomentum, setPhysicalMomentum] = useState<PhysicalMomentumResponse | null>(null)
  const [physicalMomentumLoading, setPhysicalMomentumLoading] = useState(true)

  useEffect(() => {
    const controller = new AbortController()
    const physicalUrl = buildStockDecisionSummaryUrls(ticker, analysisDate).physical
    setPhysicalMomentum(null)
    setPhysicalMomentumLoading(true)
    const requestTimer = window.setTimeout(() => {
      const hash = window.location.hash.replace('#', '')
      if (hash && hash !== 'overview' && hash !== 'company' && hash !== 'shikiho') {
        setPhysicalMomentumLoading(false)
        return
      }
      fetch(physicalUrl, { cache: 'no-store', signal: controller.signal })
        .then((response) => response.ok ? response.json() : Promise.reject(new Error(`HTTP ${response.status}`)))
        .then((value) => {
          if (!controller.signal.aborted) setPhysicalMomentum(value as PhysicalMomentumResponse)
        })
        .catch(() => undefined)
        .finally(() => {
          if (!controller.signal.aborted) setPhysicalMomentumLoading(false)
        })
    }, 0)
    return () => {
      window.clearTimeout(requestTimer)
      controller.abort()
    }
  }, [analysisDate, ticker])

  return (
    <div className="space-y-4 md:space-y-6">
      {!loading && !quote && (
        <div className="card" style={missingPriceNoticeStyle}>
          J-Quants日足の価格データを取得できませんでした。
        </div>
      )}
      <OverviewBasicInfoPanel
        ticker={ticker}
        quote={displayedQuote}
        marginInfo={marginInfo}
        fallbackType={fallbackType}
        analysisDate={analysisDate}
        classifications={classifications}
        physicalMomentum={physicalMomentum}
        physicalMomentumLoading={physicalMomentumLoading}
        shikihoInfo={shikihoInfo}
        loading={loading}
      />
      <StockDecisionSummary
        ticker={ticker}
        analysisDate={analysisDate}
        quote={displayedQuote}
        variant="overview"
        physicalMomentum={physicalMomentum}
      />
      <FinancialPerformanceTimeline ticker={ticker} analysisDate={analysisDate} />
    </div>
  )
}

function OverviewBasicInfoPanel({
  ticker,
  quote,
  marginInfo,
  fallbackType,
  analysisDate,
  classifications,
  physicalMomentum,
  physicalMomentumLoading,
  shikihoInfo,
  loading,
}: {
  ticker: string
  quote: StockQuote | null
  marginInfo: StockMarginInfo | null
  fallbackType?: string | null
  analysisDate: string | null
  classifications: {
    marketSegment?: string | null
    sector17?: string | null
    sector33?: string | null
    majorCategory?: string | null
    subIndustry?: string | null
  }
  physicalMomentum: PhysicalMomentumResponse | null
  physicalMomentumLoading: boolean
  shikihoInfo: ShikihoInfo | null
  loading: boolean
}) {
  return (
    <>
      <section id="company-basic-info" className="scroll-mt-32 overflow-hidden border border-[var(--color-border-default)] bg-white shadow-[0_1px_3px_rgba(16,32,52,0.05)]" aria-labelledby="company-basic-info-title">
        <header className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--color-border-soft)] px-3 py-3 sm:gap-3 sm:px-4 sm:py-3.5">
          <div className="flex items-center gap-2.5">
            <LayoutDashboard size={16} className="text-[var(--color-brand-700)]" aria-hidden="true" />
            <div>
              <h2 id="company-basic-info-title" className="text-[14px] font-bold text-[var(--color-text-primary)]">基本情報</h2>
              <div className="mt-0.5 text-[10px] font-medium text-[var(--color-text-tertiary)]">
                市場データ J-Quants / 企業情報 会社四季報CSV
              </div>
            </div>
          </div>
          <div className="font-mono text-[10px] font-medium text-[var(--color-text-tertiary)]">
            基準日 {quote?.priceDate ?? analysisDate ?? '---'}
          </div>
        </header>

        <div className="grid gap-4 px-3 py-3 sm:px-4 sm:py-4 lg:grid-cols-[minmax(0,1.08fr)_minmax(0,.92fr)] lg:gap-8">
          <div className="min-w-0">
            <BasicInfoCard
              ticker={ticker}
              quote={quote}
              analysisDate={analysisDate}
              physical={physicalMomentum}
              physicalLoading={physicalMomentumLoading}
              embedded
            />
          </div>
          <div className="min-w-0">
            <MarketSnapshotCard
              ticker={ticker}
              marginInfo={marginInfo}
              fallbackType={fallbackType}
              analysisDate={analysisDate}
              embedded
            />
          </div>
        </div>

        <div className="mx-3 border-t border-[var(--color-border-soft)] py-3 sm:mx-4 sm:py-3.5">
          {analysisDate
            ? <CurrentOnlyDataNotice label="決算予定は現在情報のため、過去分析モードでは非表示にしています。" compact />
            : <EarningsCard ticker={ticker} compact />}
        </div>
        {analysisDate
          ? (
            <div className="mx-3 border-t border-[var(--color-border-soft)] py-3 sm:mx-4">
              <CurrentOnlyDataNotice label="会社四季報の会社概要は現在情報のため、過去分析モードでは表示していません。分類は現在属性として表示しています。" compact />
            </div>
          )
          : <ShikihoOverviewSection info={shikihoInfo} loading={loading} />}
        <OverviewCompanyDetails ticker={ticker} analysisDate={analysisDate} />
      </section>
    </>
  )
}

function OverviewCompanyDetails({ ticker, analysisDate }: { ticker: string; analysisDate: string | null }) {
  const [expanded, setExpanded] = useState(false)
  return (
    <>
      <section className="mx-3 overflow-hidden border-t border-[var(--color-border-soft)] sm:mx-4" aria-label="EDINET企業情報詳細">
        <button
          type="button"
          className="flex min-h-11 w-full items-center gap-3 py-2.5 text-left hover:bg-[var(--color-surface-subtle)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-brand-700)]"
          aria-expanded={expanded}
          aria-controls="overview-company-details"
          onClick={() => setExpanded((current) => !current)}
        >
          <FileSearch size={15} className="shrink-0 text-[var(--color-brand-700)]" aria-hidden="true" />
          <span className="min-w-0">
            <strong className="block text-[12px] font-bold text-[var(--color-text-primary)]">EDINET企業情報</strong>
            <span className="mt-0.5 block text-[10px] font-medium text-[var(--color-text-tertiary)]">
              事業・セグメント・従業員・役員・株主情報を法定開示で確認
            </span>
          </span>
          <span className="ml-auto shrink-0 text-[10px] font-bold text-[var(--color-brand-700)]">
            {expanded ? '閉じる' : '詳細を見る'}
          </span>
          <ChevronRight size={14} className={`shrink-0 transition-transform ${expanded ? 'rotate-90' : ''}`} aria-hidden="true" />
        </button>
      </section>
      {expanded && (
        <div id="overview-company-details">
          <CompanyInformationDetail ticker={ticker} analysisDate={analysisDate} />
        </div>
      )}
    </>
  )
}

function StockHeaderClassifications({
  marketSegment,
  sector17,
  sector33,
  majorCategory,
  subIndustry,
  analysisDate,
}: {
  marketSegment?: string | null
  sector17?: string | null
  sector33?: string | null
  majorCategory?: string | null
  subIndustry?: string | null
  analysisDate: string | null
}) {
  const classifications = [
    { label: '市場', value: marketSegment, priority: 'primary' },
    { label: '33業種', value: sector33, priority: 'primary' },
    { label: '独自60分類', value: majorCategory, priority: 'primary' },
    { label: '独自細分類', value: subIndustry, priority: 'primary' },
    { label: '17業種', value: sector17, priority: 'secondary' },
  ].filter((row): row is { label: string; value: string; priority: string } => Boolean(row.value))
  if (classifications.length === 0) return null
  return (
    <div className="flex w-full min-w-0 max-w-full flex-none flex-wrap items-center gap-1.5 sm:w-auto sm:flex-initial" aria-label={`銘柄分類${analysisDate ? '（現在属性）' : ''}`}>
      {classifications.map(({ label, value, priority }) => (
        <span
          key={label}
          title={`${label}: ${value}${analysisDate ? '（現在属性）' : ''}`}
          className={`inline-flex max-w-full shrink-0 items-start gap-1 rounded-[4px] border px-2 py-1 leading-tight ${
            priority === 'primary'
              ? 'border-[var(--color-border-default)] bg-[var(--color-surface-subtle)] text-[var(--color-text-primary)]'
              : 'border-[var(--color-border-soft)] bg-white text-[var(--color-text-tertiary)]'
          }`}
        >
          <span className="shrink-0 text-[9px] font-medium opacity-75">{label}</span>
          <strong className={`min-w-0 whitespace-normal break-words ${priority === 'primary' ? 'text-[10px] font-bold' : 'text-[9px] font-semibold'}`}>{value}</strong>
        </span>
      ))}
      {analysisDate && <span className="text-[9px] font-medium text-[var(--color-text-tertiary)]">現在属性</span>}
    </div>
  )
}

function ShikihoOverviewSection({
  info,
  loading,
}: {
  info: ShikihoInfo | null
  loading: boolean
}) {
  const profile = info?.profile ?? null

  if (!profile) {
    return (
      <section className="flex min-h-20 items-center justify-center border-t border-[var(--color-border-soft)] px-4 text-center">
        <div aria-live="polite" className="flex items-center gap-3">
          <BookOpenText className="text-[var(--color-text-tertiary)]" size={18} aria-hidden="true" />
          <div className="text-left">
            <div className="text-[12px] font-semibold text-[var(--color-text-primary)]">
              {loading ? '会社概要を読み込んでいます' : '四季報の会社概要は未収録です'}
            </div>
            {!loading && (
              <div className="mt-1 text-[10px] font-medium text-[var(--color-text-tertiary)]">
                次回の四季報CSV同期時に更新されます
              </div>
            )}
          </div>
        </div>
      </section>
    )
  }

  const metrics = [
    { label: '予想PER', value: formatShikihoMultiple(profile.forecastPer) },
    { label: '実績PBR', value: formatShikihoMultiple(profile.actualPbr) },
    { label: '予想ROE', value: formatShikihoPercent(profile.forecastRoe) },
    { label: '配当利回り', value: formatShikihoPercent(profile.dividendYield) },
  ]

  return (
    <section className="border-t border-[var(--color-border-soft)] px-3 py-2.5 sm:px-4 sm:py-4">
      <header className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <div className="flex min-w-0 items-center gap-2">
          <BookOpenText size={14} className="shrink-0 text-[var(--color-brand-700)]" aria-hidden="true" />
          <h3 className="text-[13px] font-bold text-[var(--color-text-primary)]">会社四季報</h3>
          <span className="text-[10px] font-normal text-[var(--color-text-tertiary)]">
            {info?.source ?? '会社四季報CSV'}
          </span>
        </div>
        <dl className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-[var(--color-text-tertiary)]">
          <div className="flex items-center gap-1.5">
            <dt>収録号</dt>
            <dd className="font-semibold text-[var(--color-text-primary)]">{profile.issueLabel ?? '---'}</dd>
          </div>
          <div className="flex items-center gap-1.5">
            <dt>発売日</dt>
            <dd className="font-semibold text-[var(--color-text-primary)]">{profile.releaseDate ?? '---'}</dd>
          </div>
        </dl>
      </header>

      <div className="mt-2.5 grid gap-3 sm:mt-4 sm:gap-5 lg:grid-cols-2 lg:gap-8">
        <div>
          <ShikihoNarrativeSection index="01" title="会社概要" body={profile.companyFeature} />
        </div>
        <div>
          <ShikihoNarrativeSection index="02" title="連結事業" body={profile.consolidatedBusiness} />
        </div>
      </div>

      <div className="mt-3 grid gap-3 border-t border-[var(--color-border-soft)] pt-2.5 sm:mt-5 sm:gap-5 sm:pt-4 lg:grid-cols-5 lg:gap-8">
        <section className="lg:col-span-2" aria-labelledby="shikiho-metrics-title">
          <div className="flex items-center justify-between gap-3">
            <h4 id="shikiho-metrics-title" className="text-[11px] font-bold text-[var(--color-text-secondary)]">四季報サマリー</h4>
            <span className="text-[9px] font-medium text-[var(--color-text-tertiary)]">現在情報</span>
          </div>
          <div className="mt-1.5 grid grid-cols-2 gap-x-4 gap-y-1 rounded-[6px] bg-[var(--color-surface-subtle)] px-3 py-2 sm:mt-2 sm:gap-x-5 sm:gap-y-2 sm:py-2.5">
            {metrics.map((metric) => (
              <div key={metric.label} className="flex min-w-0 items-baseline justify-between gap-2 py-1">
                <div className="truncate text-[10px] font-medium text-[var(--color-text-tertiary)]">{metric.label}</div>
                <div className="shrink-0 font-mono text-[14px] font-bold leading-none text-[var(--color-text-primary)]">{metric.value}</div>
              </div>
            ))}
          </div>
        </section>
        <section className="lg:col-span-3" aria-labelledby="shikiho-outlook-title">
          <h4 id="shikiho-outlook-title" className="text-[11px] font-bold text-[var(--color-text-secondary)]">業績展望・注目点</h4>
          <div className="mt-1">
            <ShikihoArticle index="01" headline={profile.headline1} description={profile.description1} />
            <ShikihoArticle index="02" headline={profile.headline2} description={profile.description2} bordered />
          </div>
        </section>
      </div>
    </section>
  )
}

function ShikihoNarrativeSection({
  index,
  title,
  body,
  bordered = false,
}: {
  index: string
  title: string
  body: string | null
  bordered?: boolean
}) {
  return (
    <section className={bordered ? 'border-t border-[var(--color-border-soft)] py-2' : ''}>
      <div className="flex items-center gap-2">
        <span className="font-mono text-[9px] font-semibold text-[var(--color-text-tertiary)]">{index}</span>
        <h4 className="text-[11px] font-bold text-[var(--color-text-secondary)]">{title}</h4>
      </div>
      <p className="mt-1.5 whitespace-pre-wrap text-[11px] font-normal leading-[1.65] text-[var(--color-text-primary)] sm:text-[12px] sm:leading-[1.75]">
        {body ?? '---'}
      </p>
    </section>
  )
}

function ShikihoArticle({
  index,
  headline,
  description,
  bordered = false,
}: {
  index: string
  headline: string | null
  description: string | null
  bordered?: boolean
}) {
  return (
    <article className={`py-1.5 sm:py-2.5 ${bordered ? 'border-t border-[var(--color-border-soft)]' : ''}`}>
      <div className="flex items-start gap-2">
        <span className="shrink-0 pt-0.5 font-mono text-[9px] font-semibold text-[var(--color-text-tertiary)]">{index}</span>
        <div className="min-w-0">
          <h4 className="text-[12px] font-bold leading-5 text-[var(--color-text-primary)] sm:text-[13px]">{headline ?? '---'}</h4>
          <p className="mt-1 whitespace-pre-wrap text-[11px] font-normal leading-[1.6] text-[var(--color-text-secondary)] sm:text-[12px] sm:leading-[1.7]">
            {description ?? '---'}
          </p>
        </div>
      </div>
    </article>
  )
}

function formatShikihoMultiple(value: number | null): string {
  return value == null || !Number.isFinite(value) ? '---' : `${value.toFixed(2)}倍`
}

function formatShikihoPercent(value: number | null): string {
  return value == null || !Number.isFinite(value) ? '---' : `${value.toFixed(2)}%`
}

interface PhysicalMomentumApiRow {
  date: string
  velocity: number | null
  acceleration: number | null
  momentum: number | null
  force: number | null
  ma5Angle: number | null
  ma25Angle: number | null
  ma75Angle: number | null
  ma200Angle: number | null
  maAngleAvg: number | null
  energy: number | null
  physicalMomentumScore: number | null
  physicalForceScore: number | null
  physicalEnergyScore: number | null
}

interface PhysicalMomentumResponse {
  latest: PhysicalMomentumApiRow | null
  history: PhysicalMomentumApiRow[]
  rank: number | null
  totalRanked: number
  trend: 'rising' | 'falling' | 'flat' | null
  latestScoredDate?: string | null
  isScoreFresh?: boolean
  scoreSource?: 'stored' | 'runtime_raw' | null
  isScoreRefreshRunning?: boolean
  timeframeViews?: PhysicalMomentumTimeframeView[]
}

interface PhysicalMomentumTimeframeView {
  interval: 'D' | '2D' | 'W' | 'M'
  label: string
  basis: string
  latestDate: string | null
  lookbackBars: number
  approxTradingDays: number | null
  scoreSource: 'market_z' | 'local_timeframe_z'
  historyCount: number
  physicalMomentumScore: number | null
  physicalForceScore: number | null
  physicalEnergyScore: number | null
  trend: 'rising' | 'falling' | 'flat' | null
}

interface PhysicalPlanCandidate {
  asOfDate: string
  direction: 'up' | 'down' | 'wait'
  rank: number
  score: number
  modelName: string | null
}

interface PhysicalPlanLevel {
  label: string
  value: number | null
  distancePct: number | null
}

interface PhysicalPlanLevels {
  baseDate: string
  close: number
  support: PhysicalPlanLevel
  resistance: PhysicalPlanLevel
  breakdown: PhysicalPlanLevel
}

interface PhysicalPlanHorizon {
  label: string
  horizonDays: number
  description: string
  statusLabel: string
  targetDirection: 'up' | 'down' | 'wait' | null
  hitRate: number | null
  baseRate: number | null
  lift: number | null
  confidenceScore: number | null
  confidenceLabel: string
  sampleCount: number | null
  adverseRate: number | null
  avgReturnPct: number | null
  avgMaxReturnPct: number | null
  avgMinReturnPct: number | null
  medianReturnPct: number | null
  evaluationDate: string | null
  candidates: PhysicalPlanCandidate[]
  levels: PhysicalPlanLevels | null
  suggestion: {
    tone: 'positive' | 'negative' | 'neutral' | 'warning'
    stance: string
    headline: string
    summary: string
    checklist: string[]
    conditionLabel: string
    invalidation: string
    decision: PhysicalPlanDecision
  }
}

interface PhysicalPlanResponse {
  ok: boolean
  available: boolean
  ticker: string
  featureSet?: string
  featureAsOfDate?: string | null
  requestedDate?: string | null
  priceAsOfDate?: string | null
  note?: string
  horizons: PhysicalPlanHorizon[]
}

function technicalMomentumSnapshotFromResponse(payload: PhysicalMomentumResponse): TechnicalMomentumSnapshot {
  const latest = payload.latest
  if (!latest) {
    return {
      status: 'missing',
      scoreDate: null,
      maDate: null,
      pms: null,
      pfs: null,
      pes: null,
      isScoreFresh: payload.isScoreFresh ?? false,
      scoreSource: payload.scoreSource ?? null,
      maStructure: null,
      maDescription: null,
      message: 'PMS/PFS/PESは未計算です',
    }
  }
  const previous = [...(payload.history ?? [])].reverse().find((row) => row.date < latest.date) ?? null
  const field = buildMaFieldInsight(latest, previous)
  const { scoreDate, scoreRow } = selectPhysicalMomentumScoreRow({
    latest,
    history: payload.history,
    latestScoredDate: payload.latestScoredDate,
    isScoreFresh: payload.isScoreFresh,
  })
  return {
    status: 'available',
    scoreDate,
    maDate: latest.date,
    pms: scoreRow?.physicalMomentumScore ?? null,
    pfs: scoreRow?.physicalForceScore ?? null,
    pes: scoreRow?.physicalEnergyScore ?? null,
    isScoreFresh: payload.isScoreFresh ?? (scoreDate === latest.date),
    scoreSource: payload.scoreSource ?? null,
    maStructure: field.label,
    maDescription: field.description,
    message: scoreDate && !scoreRow ? 'PMS/PFS/PESのスコア行を確認できません' : null,
  }
}

function PhysicalMomentumSection({
  ticker,
  analysisDate,
  onSnapshotChange,
}: {
  ticker: string
  analysisDate: string | null
  onSnapshotChange?: (snapshot: TechnicalMomentumSnapshot) => void
}) {
  const [data, setData] = useState<PhysicalMomentumResponse | null>(null)
  const [plan, setPlan] = useState<PhysicalPlanResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [planLoading, setPlanLoading] = useState(true)
  const [planError, setPlanError] = useState('')
  const [mobileDetailsOpen, setMobileDetailsOpen] = useState(false)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError('')
    setPlanLoading(true)
    setPlanError('')
    setMobileDetailsOpen(false)
    onSnapshotChange?.({
      status: 'loading',
      scoreDate: null,
      maDate: null,
      pms: null,
      pfs: null,
      pes: null,
      isScoreFresh: null,
      scoreSource: null,
      maStructure: null,
      maDescription: null,
      message: null,
    })
    const planParams = analysisDate ? `?date=${encodeURIComponent(analysisDate)}` : ''
    Promise.allSettled([
      fetch(`/api/physical-momentum/${encodeURIComponent(ticker)}?market=JP&limit=260${analysisDate ? `&date=${encodeURIComponent(analysisDate)}` : ''}`, { cache: 'no-store' })
        .then((res) => res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`))),
      fetch(`/api/stock-physical-plan/${encodeURIComponent(ticker)}${planParams}`, { cache: 'no-store' })
        .then((res) => res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`))),
    ])
      .then(([momentumResult, planResult]) => {
        if (cancelled) return
        if (momentumResult.status === 'fulfilled') {
          const payload = momentumResult.value as PhysicalMomentumResponse
          setData(payload)
          onSnapshotChange?.(technicalMomentumSnapshotFromResponse(payload))
        } else {
          const message = (momentumResult.reason as Error).message
          setError(message)
          onSnapshotChange?.({
            status: 'error',
            scoreDate: null,
            maDate: null,
            pms: null,
            pfs: null,
            pes: null,
            isScoreFresh: null,
            scoreSource: null,
            maStructure: null,
            maDescription: null,
            message,
          })
        }
        if (planResult.status === 'fulfilled') {
          setPlan(planResult.value)
        } else {
          setPlanError((planResult.reason as Error).message)
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false)
          setPlanLoading(false)
        }
      })
    return () => { cancelled = true }
  }, [ticker, analysisDate, onSnapshotChange])

  const latest = data?.latest ?? null
  const momentumHistoryCount = data?.history?.length ?? 0
  const isMomentumCoverageSparse = momentumHistoryCount < 20
  const isMomentumScoreRuntime = data?.scoreSource === 'runtime_raw'
  const isMomentumScoreStale = Boolean(latest && data?.isScoreFresh === false && !isMomentumScoreRuntime)
  const coverageWarningStyle: CSSProperties = {
    display: 'grid',
    gap: '4px',
    border: '1px solid rgba(245, 158, 11, 0.34)',
    borderRadius: 'var(--radius-sm)',
    background: 'rgba(245, 158, 11, 0.10)',
    color: '#92400e',
    fontSize: '12px',
    fontWeight: 700,
    lineHeight: 1.65,
    padding: '10px 12px',
    marginBottom: '10px',
  }
  const previous = latest
    ? [...(data?.history ?? [])].reverse().find((row) => row.date < latest.date) ?? null
    : null
  const fieldInsight = latest ? buildMaFieldInsight(latest, previous) : null
  const insight = latest && !isMomentumCoverageSparse
    ? buildPhysicalMomentumInsight(latest, data?.rank ?? null, data?.totalRanked ?? 0, data?.trend ?? null, fieldInsight)
    : null
  const velocityMetric = buildPhysicalRawMetricView('velocity', latest?.velocity)
  const accelerationMetric = buildPhysicalRawMetricView('acceleration', latest?.acceleration)
  const forceMetric = buildPhysicalRawMetricView('force', latest?.force)

  return (
    <div className="card" style={physicalCardStyle}>
      <div style={physicalHeaderStyle}>
        <div>
          <div className="section-header" style={{ margin: 0 }}>Physical Momentum</div>
          <div style={physicalSubTextStyle}>
            PMSは買い/売りの予測ではなく、時間軸ごとの運動状態です。日足・2日足・週足・月足で結論を分けて見ます。
          </div>
        </div>
        {latest && (
          <span style={physicalDateBadgeStyle}>
            {latest.date}
          </span>
        )}
      </div>

      {loading ? (
        <p style={summaryEmptyStyle}>PMSを読込中...</p>
      ) : error ? (
        <p style={{ ...summaryEmptyStyle, color: 'var(--price-down)' }}>PMS取得エラー: {error}</p>
      ) : !latest ? (
        <p style={summaryEmptyStyle}>PMS未計算です。`npm run batch:physical-momentum` 実行後に表示されます。</p>
      ) : (
        <>
          {isMomentumCoverageSparse && (
            <div style={coverageWarningStyle}>
              <strong>結論は保留中</strong>
              <span>
                PMS履歴が{momentumHistoryCount}営業日分しかありません。全期間PMSを再生成中または未完了のため、
                いまはPMS/PFS/PESの数値を投資判断の結論として扱わず、チャート・MA・ステージを優先してください。
              </span>
            </div>
          )}
          {isMomentumScoreStale && (
            <div style={coverageWarningStyle}>
              <strong>最新スコア標準化が未完了</strong>
              <span>
                価格・raw物理量は{latest.date}までありますが、PMS/PFS/PESの標準化済みスコアは
                {data?.latestScoredDate ? `${data.latestScoredDate}まで` : 'まだありません'}。
                古い日付を最新扱いせず、標準化完了後に結論を更新します。
              </span>
            </div>
          )}
          <PhysicalTimeframeConclusionPanel views={data?.timeframeViews ?? []} />
          {insight && (
            <div style={physicalHeroStyle}>
              <div style={physicalHeroMainStyle}>
                <div style={{ ...physicalHeroLabelStyle, color: insight.color }}>日足20営業日の結論</div>
                <div style={{ ...physicalHeroTitleStyle, color: insight.color }}>{insight.label}</div>
                <p style={physicalHeroDescriptionStyle}>{insight.description}</p>
              </div>
              <div style={physicalReasonPanelStyle}>
                <div style={physicalReasonPanelTitleStyle}>根拠</div>
                <div style={physicalReasonListStyle}>
                  {insight.reasons.map((reason) => (
                    <span key={reason} style={physicalReasonPillStyle}>{reason}</span>
                  ))}
                </div>
              </div>
              <PhysicalMomentumGauge
                value={latest.physicalMomentumScore}
                rank={data?.rank ?? null}
                total={data?.totalRanked ?? 0}
                trend={data?.trend ?? null}
              />
            </div>
          )}

          <div style={physicalScoreGridStyle}>
            <PhysicalScoreCard
              label="総合的な運動状態"
              code="PMS"
              title="方向+熱量の合成"
              value={latest.physicalMomentumScore}
              sub={data?.rank && data.totalRanked ? `市場順位 ${data.rank}/${data.totalRanked}` : '市場順位 -'}
              guide="高い=買いではなく、20営業日の方向・力・熱量が市場内で強い状態。足元の向きはPFSで確認"
              trend={data?.trend ?? null}
            />
            <PhysicalScoreCard
              label="足元の力"
              code="PFS"
              title="初動/失速"
              value={latest.physicalForceScore}
              sub={physicalSignalText(latest.physicalForceScore, 'force')}
              guide="加速度とForce。上向き/下向きの力が増えているかを見る"
              trend={null}
            />
            <PhysicalScoreCard
              label="動きの熱量"
              code="PES"
              title="値幅/過熱"
              value={latest.physicalEnergyScore}
              sub={physicalSignalText(latest.physicalEnergyScore, 'energy')}
              guide="高いほど大きく動いた状態。方向ではなく、過熱・巻き戻しリスクも含めて見る"
              trend={null}
            />
          </div>

          <PhysicalActionPoints latest={latest} trend={data?.trend ?? null} field={fieldInsight} />

          <div className="mb-2.5">
            <PhysicalMaFieldMap latest={latest} previous={previous} />
          </div>

          <button
            type="button"
            className="mb-2 inline-flex min-h-11 w-full items-center justify-between border border-[var(--color-border-default)] bg-[var(--color-surface-subtle)] px-3 text-left text-[11px] font-black text-[var(--color-text-primary)] sm:hidden"
            onClick={() => setMobileDetailsOpen((open) => !open)}
            aria-expanded={mobileDetailsOpen}
            aria-controls="physical-momentum-details"
          >
            <span>観察プラン・内訳・PMS推移</span>
            <ChevronRight size={15} className={`transition-transform ${mobileDetailsOpen ? 'rotate-90' : ''}`} aria-hidden="true" />
          </button>

          <div id="physical-momentum-details" className={`${mobileDetailsOpen ? 'block' : 'hidden'} sm:block`}>
            <PhysicalTradePlanCards loading={planLoading} error={planError} plan={plan} />

            <div style={physicalBodyGridStyle}>
              <div style={physicalBreakdownPanelStyle}>
                <div style={physicalMiniHeaderStyle}>
                  <strong>内訳</strong>
                  <span>騰落率は%・変化はptで表示。比較不能な生値は出さず、市場内の強弱はPMS/PFS/PESで見ます。</span>
                </div>
                <div style={physicalBreakdownGridStyle}>
                  <PhysicalBreakdown label={velocityMetric.label} help={velocityMetric.detail} value={velocityMetric.value} tone={latest.velocity} />
                  <PhysicalBreakdown label={accelerationMetric.label} help={accelerationMetric.detail} value={accelerationMetric.value} tone={latest.acceleration} />
                  <PhysicalBreakdown label={forceMetric.label} help={forceMetric.detail} value={forceMetric.value} tone={latest.force} />
                </div>
              </div>
              <PhysicalMomentumSparkline history={data?.history ?? []} />
            </div>
          </div>
        </>
      )}
    </div>
  )
}

function PhysicalScoreCard({
  label,
  code,
  title,
  value,
  sub,
  guide,
  trend,
  valueFormatter = fmtScore,
}: {
  label: string
  code: string
  title: string
  value: number | null
  sub: string
  guide: string
  trend: 'rising' | 'falling' | 'flat' | null
  valueFormatter?: (value: number | null | undefined) => string
}) {
  const tone = value == null ? 'var(--text-muted)' : value >= 0 ? 'var(--price-up)' : 'var(--price-down)'
  const pct = scoreBarPercent(value)
  return (
    <div style={physicalScoreCardStyle}>
      <div style={physicalScoreTopStyle}>
        <span style={physicalScoreLabelWrapStyle}>
          <span style={physicalScoreLabelStyle}>{label}</span>
          <span style={physicalScoreCodeStyle}>{code}</span>
        </span>
        <strong style={{ color: tone }}>{valueFormatter(value)}</strong>
      </div>
      <div style={physicalScoreTitleStyle}>{title}</div>
      <div style={physicalMeterTrackStyle}>
        <span style={{ ...physicalMeterFillStyle, width: `${pct}%`, background: tone }} />
      </div>
      <small style={physicalScoreSubStyle}>
        {trend === 'rising' ? '上昇中 / ' : trend === 'falling' ? '低下中 / ' : trend === 'flat' ? '横ばい / ' : ''}
        {sub}
      </small>
      <span style={physicalScoreGuideStyle}>{guide}</span>
    </div>
  )
}

function PhysicalMomentumGauge({
  value,
  rank,
  total,
  trend,
}: {
  value: number | null
  rank: number | null
  total: number
  trend: PhysicalMomentumResponse['trend']
}) {
  const pct = scoreBarPercent(value)
  const tone = value == null ? 'var(--text-muted)' : value >= 0 ? 'var(--price-up)' : 'var(--price-down)'
  const fillLeft = value == null || !Number.isFinite(value) ? 50 : value >= 0 ? 50 : pct
  const fillWidth = value == null || !Number.isFinite(value) ? 0 : Math.abs(pct - 50)
  const rankText = rank && total ? `市場 ${rank.toLocaleString('ja-JP')}位 / ${total.toLocaleString('ja-JP')}銘柄` : '市場順位 -'
  return (
    <div style={physicalGaugeStyle}>
      <div style={physicalGaugeValueRowStyle}>
        <span>PMS</span>
        <strong style={{ color: tone }}>{fmtScore(value)}</strong>
      </div>
      <div style={physicalGaugeTrackStyle}>
        <span style={physicalGaugeZeroStyle} />
        <span style={{ ...physicalGaugeFillStyle, left: `${fillLeft}%`, width: `${fillWidth}%`, background: tone }} />
      </div>
      <div style={physicalGaugeScaleStyle}>
        <span>弱い -2</span>
        <span>平均 0</span>
        <span>強い +2</span>
      </div>
      <div style={physicalGaugeMetaStyle}>
        <span>{rankText}</span>
        <b>{trend === 'rising' ? '上昇中' : trend === 'falling' ? '低下中' : trend === 'flat' ? '横ばい' : '方向未判定'}</b>
      </div>
    </div>
  )
}

function PhysicalTimeframeConclusionPanel({ views }: { views: PhysicalMomentumTimeframeView[] }) {
  if (views.length === 0) return null
  const primary = views.find((view) => view.interval === 'D') ?? views[0]
  const primaryView = buildPhysicalMomentumView({
    pms: primary.physicalMomentumScore,
    pfs: primary.physicalForceScore,
    pes: primary.physicalEnergyScore,
    trend: primary.trend,
  })
  const longerViews = views.filter((view) => view.interval !== 'D')
  const longerLabels = longerViews
    .map((view) => {
      const built = buildPhysicalMomentumView({
        pms: view.physicalMomentumScore,
        pfs: view.physicalForceScore,
        pes: view.physicalEnergyScore,
        trend: view.trend,
      })
      return `${view.interval}:${built.label}`
    })
    .join(' / ')

  return (
    <div style={physicalTimeframePanelStyle}>
      <div style={physicalMiniHeaderStyle}>
        <strong>時間軸別の結論</strong>
        <span>
          総合: 日足は{primaryView.label}
          {longerLabels ? ` / ${longerLabels}` : ''}
        </span>
      </div>
      <div style={physicalTimeframeGridStyle}>
        {views.map((view) => (
          <PhysicalTimeframeConclusionCard key={view.interval} view={view} />
        ))}
      </div>
      <p style={physicalTimeframeNoteStyle}>
        日足は市場横断Z、2日足・週足・月足は銘柄内の時間軸Zです。いずれも分布の裾1%を抑えた標準化で、
        時間軸が違う数値同士は直接比較しません。
      </p>
    </div>
  )
}

function PhysicalTimeframeConclusionCard({ view }: { view: PhysicalMomentumTimeframeView }) {
  const built = buildPhysicalMomentumView({
    pms: view.physicalMomentumScore,
    pfs: view.physicalForceScore,
    pes: view.physicalEnergyScore,
    trend: view.trend,
  })
  const color = physicalToneColor(built.tone)
  const scoreTone = view.physicalMomentumScore == null
    ? 'var(--text-muted)'
    : view.physicalMomentumScore >= 0
      ? 'var(--price-up)'
      : 'var(--price-down)'
  return (
    <div style={{ ...physicalTimeframeCardStyle, borderColor: `${color}66`, background: physicalTimeframeCardBackground(built.tone) }}>
      <div style={physicalTimeframeCardTopStyle}>
        <div>
          <span style={physicalTimeframeLabelStyle}>{view.label}</span>
          <strong style={{ ...physicalTimeframeTitleStyle, color }}>{built.label}</strong>
        </div>
        <span style={{ ...physicalTimeframeBadgeStyle, borderColor: `${color}66`, color }}>{view.interval}</span>
      </div>
      <div style={physicalTimeframeMetricRowStyle}>
        <span>PMS <b style={{ color: scoreTone }}>{describePhysicalScore('pms', view.physicalMomentumScore)} ({fmtScore(view.physicalMomentumScore)})</b></span>
        <span>PFS <b>{describePhysicalScore('pfs', view.physicalForceScore)} ({fmtScore(view.physicalForceScore)})</b></span>
        <span>PES <b>{describePhysicalScore('pes', view.physicalEnergyScore)} ({fmtScore(view.physicalEnergyScore)})</b></span>
      </div>
      <p style={physicalTimeframeStanceStyle}>{built.stance}</p>
      <div style={physicalTimeframeMetaStyle}>
        <span>{view.basis}</span>
        <span>{view.latestDate ?? '-'}</span>
        <span>{view.scoreSource === 'market_z' ? '市場比較' : '時間軸内比較'}</span>
      </div>
    </div>
  )
}

function physicalTimeframeCardBackground(tone: PhysicalMomentumTone): string {
  if (tone === 'up') return 'rgba(220, 38, 38, 0.055)'
  if (tone === 'down') return 'rgba(37, 99, 235, 0.055)'
  if (tone === 'warning') return 'rgba(245, 158, 11, 0.075)'
  return 'var(--bg-elevated)'
}

function PhysicalBreakdown({ label, help, value, tone }: { label: string; help: string; value: string; tone?: number | null }) {
  const color = tone == null || !Number.isFinite(tone) ? 'var(--text-primary)' : tone >= 0 ? 'var(--price-up)' : 'var(--price-down)'
  return (
    <div style={physicalBreakdownStyle}>
      <span>{label}</span>
      <strong style={{ color, lineHeight: 1.4 }}>{value}</strong>
      <small>{help}</small>
    </div>
  )
}

function PhysicalMaFieldMap({ latest, previous }: { latest: PhysicalMomentumApiRow; previous: PhysicalMomentumApiRow | null }) {
  const field = buildMaFieldInsight(latest, previous)
  const angles = [
    { label: '5MA', value: latest.ma5Angle },
    { label: '25MA', value: latest.ma25Angle },
    { label: '75MA', value: latest.ma75Angle },
    { label: '200MA', value: latest.ma200Angle },
  ]
  const angleNodes = angles.map((angle) => {
    const deg = angleDeg(angle.value)
    return {
      ...angle,
      deg,
      arrow: angleDirectionArrow(deg),
      labelText: angleDirectionLabel(deg),
      color: angleDirectionColor(deg),
    }
  })

  return (
    <div style={physicalFieldPanelStyle}>
      <div style={physicalMiniHeaderStyle}>
        <strong>MA力場</strong>
        <span>平均ではなく、短期から長期への力の伝わり方を見ます。</span>
      </div>
      <div style={physicalFieldSummaryStyle}>
        <strong style={{ color: field.color }}>{field.label}</strong>
        <span>{field.description}</span>
      </div>
      <div style={physicalFieldMetaStyle}>
        <span>角度幅 {field.spreadDeg == null ? '-' : `${field.spreadDeg.toFixed(1)}°`}</span>
        <span>{field.spreadChangeDeg == null ? '変化 -' : `前回比 ${field.spreadChangeDeg >= 0 ? '+' : ''}${field.spreadChangeDeg.toFixed(1)}°`}</span>
      </div>
      <div style={physicalFieldFlowStyle}>
        {angleNodes.map((node, index) => (
          <Fragment key={node.label}>
            <div style={{ ...physicalFieldNodeStyle, borderColor: node.color }}>
              <span style={physicalFieldNodeLabelStyle}>{node.label}</span>
              <strong style={{ ...physicalFieldNodeArrowStyle, color: node.color }}>{node.arrow}</strong>
              <span style={physicalFieldNodeMetaStyle}>{node.labelText}</span>
              <small style={physicalFieldNodeDegreeStyle}>{node.deg == null ? '-' : `${node.deg.toFixed(1)}°`}</small>
            </div>
            {index < angleNodes.length - 1 && (
              <span style={physicalFieldConnectorStyle}>→</span>
            )}
          </Fragment>
        ))}
      </div>
      <div style={physicalAngleRowsStyle}>
        {angles.map((angle) => {
          const deg = angleDeg(angle.value)
          const tone = deg == null ? 'var(--text-muted)' : deg >= 0 ? 'var(--price-up)' : 'var(--price-down)'
          const pct = angleBarPercent(deg)
          const left = deg == null ? 50 : deg >= 0 ? 50 : pct
          const width = deg == null ? 0 : Math.abs(pct - 50)
          return (
            <div key={angle.label} style={physicalAngleRowStyle}>
              <span>{angle.label}</span>
              <div style={physicalAngleTrackStyle}>
                <i style={physicalAngleZeroStyle} />
                <b style={{ ...physicalAngleFillStyle, left: `${left}%`, width: `${width}%`, background: tone }} />
              </div>
              <strong style={{ color: tone }}>{deg == null ? '-' : `${deg.toFixed(1)}°`}</strong>
            </div>
          )
        })}
      </div>
    </div>
  )
}

function PhysicalMomentumSparkline({ history }: { history: PhysicalMomentumApiRow[] }) {
  const chart = useMemo(() => {
    const points = history
      .filter((row) => row.physicalMomentumScore != null && Number.isFinite(row.physicalMomentumScore))
      .slice(-160)
    if (points.length === 0) return null
    const scoreMin = -2.5
    const scoreMax = 2.5
    const span = scoreMax - scoreMin
    const width = 520
    const height = 184
    const pad = { left: 40, right: 58, top: 18, bottom: 26 }
    const innerWidth = width - pad.left - pad.right
    const innerHeight = height - pad.top - pad.bottom
    const yFor = (value: number) => {
      const clipped = Math.max(scoreMin, Math.min(scoreMax, value))
      return pad.top + ((scoreMax - clipped) / span) * innerHeight
    }
    const xFor = (index: number) => pad.left + (points.length === 1 ? innerWidth : (index / (points.length - 1)) * innerWidth)
    const polyline = points
      .map((row, index) => {
        const x = xFor(index)
        const y = yFor(row.physicalMomentumScore as number)
        return `${x.toFixed(1)},${y.toFixed(1)}`
      })
      .join(' ')
    const latest = points[points.length - 1]
    const first = points[0]
    const latestScore = latest.physicalMomentumScore as number
    const firstScore = first.physicalMomentumScore as number
    const prev = points.length >= 2 ? points[points.length - 2] : null
    const prevScore = prev?.physicalMomentumScore ?? null
    const point20 = points.length >= 21 ? points[points.length - 21] : null
    const point60 = points.length >= 61 ? points[points.length - 61] : null
    return {
      points,
      polyline,
      width,
      height,
      pad,
      innerWidth,
      innerHeight,
      scoreMin,
      scoreMax,
      yFor,
      xFor,
      latest,
      latestScore,
      firstDate: first.date,
      lastDate: latest.date,
      latestX: xFor(points.length - 1),
      latestY: yFor(latestScore),
      deltaAll: latestScore - firstScore,
      deltaPrev: prevScore == null ? null : latestScore - prevScore,
      delta20: point20?.physicalMomentumScore == null ? null : latestScore - point20.physicalMomentumScore,
      delta60: point60?.physicalMomentumScore == null ? null : latestScore - point60.physicalMomentumScore,
    }
  }, [history])

  if (!chart) {
    return <div style={physicalSparklineEmptyStyle}>PMS時系列はまだ不足しています。</div>
  }

  const sparse = chart.points.length < 20
  const directionDelta = chart.delta20 ?? chart.delta60 ?? chart.deltaAll
  const trendLabel = trendLabelFromDelta(directionDelta)
  const latestTone = chart.latestScore >= 0 ? 'var(--price-up)' : 'var(--price-down)'
  const latestLabelX = chart.latestX > chart.width - 96 ? chart.latestX - 92 : chart.latestX + 8
  const latestLabelAnchor = chart.latestX > chart.width - 96 ? 'end' : 'start'

  return (
    <div style={physicalSparklineBoxStyle}>
      <div style={physicalSparklineHeaderStyle}>
        <div>
          <strong>PMS推移</strong>
          <small style={physicalTrendHeaderNoteStyle}>固定スケールで市場平均との差を表示</small>
        </div>
        <span>{chart.firstDate} → {chart.lastDate}</span>
      </div>
      {sparse ? (
        <div style={physicalSparseTrendStyle}>
          <div style={physicalSparseTrendMainStyle}>
            <strong style={{ color: latestTone }}>{scoreLevelLabel(chart.latestScore)}</strong>
            <span>
              PMS履歴が{chart.points.length}営業日分だけなので、推移チャートとしてはまだ弱いです。
              最新値と直近変化を中心に見てください。
            </span>
          </div>
          <div style={physicalSparsePointRowStyle}>
            {chart.points.map((point) => {
              const score = point.physicalMomentumScore ?? 0
              return (
                <span
                  key={point.date}
                  style={{
                    ...physicalSparsePointStyle,
                    background: score >= 0 ? 'rgba(220, 38, 38, 0.12)' : 'rgba(37, 99, 235, 0.12)',
                    color: score >= 0 ? 'var(--price-up)' : 'var(--price-down)',
                    borderColor: score >= 0 ? 'rgba(220, 38, 38, 0.28)' : 'rgba(37, 99, 235, 0.28)',
                  }}
                >
                  {fmtScore(score)}
                </span>
              )
            })}
          </div>
        </div>
      ) : (
        <svg viewBox={`0 0 ${chart.width} ${chart.height}`} role="img" aria-label="PMS時系列チャート" style={physicalTrendSvgStyle}>
          <rect
            x={chart.pad.left}
            y={chart.pad.top}
            width={chart.innerWidth}
            height={chart.yFor(1) - chart.pad.top}
            fill="rgba(220, 38, 38, 0.07)"
            rx="4"
          />
          <rect
            x={chart.pad.left}
            y={chart.yFor(-1)}
            width={chart.innerWidth}
            height={chart.pad.top + chart.innerHeight - chart.yFor(-1)}
            fill="rgba(37, 99, 235, 0.07)"
            rx="4"
          />
          {[-2, -1, 0, 1, 2].map((line) => (
            <g key={line}>
              <line
                x1={chart.pad.left}
                x2={chart.pad.left + chart.innerWidth}
                y1={chart.yFor(line)}
                y2={chart.yFor(line)}
                stroke={line === 0 ? 'var(--text-muted)' : 'var(--border-subtle)'}
                strokeDasharray={line === 0 ? '4 4' : undefined}
                opacity={line === 0 ? 0.62 : 0.8}
              />
              <text
                x={chart.pad.left - 8}
                y={chart.yFor(line) + 3}
                textAnchor="end"
                fontSize="10"
                fill="var(--text-muted)"
                fontFamily="var(--font-mono)"
              >
                {line > 0 ? `+${line}` : line}
              </text>
            </g>
          ))}
          <polyline
            points={chart.polyline}
            fill="none"
            stroke={latestTone}
            strokeWidth="3"
            strokeLinejoin="round"
            strokeLinecap="round"
          />
          <circle cx={chart.latestX} cy={chart.latestY} r="4.8" fill="#fff" stroke={latestTone} strokeWidth="2.6" />
          <text
            x={latestLabelX}
            y={Math.max(16, chart.latestY - 7)}
            textAnchor={latestLabelAnchor}
            fontSize="11"
            fontWeight="800"
            fill={latestTone}
            fontFamily="var(--font-mono)"
          >
            {fmtScore(chart.latestScore)}
          </text>
          <text x={chart.pad.left} y={chart.height - 5} fontSize="10" fill="var(--text-muted)" fontFamily="var(--font-mono)">
            {chart.firstDate}
          </text>
          <text x={chart.pad.left + chart.innerWidth} y={chart.height - 5} textAnchor="end" fontSize="10" fill="var(--text-muted)" fontFamily="var(--font-mono)">
            {chart.lastDate}
          </text>
        </svg>
      )}
      <div style={physicalTrendLegendStyle}>
        <span><i style={{ ...physicalTrendLegendMarkerStyle, background: 'rgba(220, 38, 38, 0.16)' }} /> +1以上: 市場より強い</span>
        <span><i style={{ ...physicalTrendLegendMarkerStyle, background: 'rgba(37, 99, 235, 0.16)' }} /> -1以下: 市場より弱い</span>
        <span><i style={{ ...physicalTrendLegendMarkerStyle, background: 'var(--text-muted)' }} /> 0: 市場平均</span>
      </div>
      <div style={physicalTrendSummaryGridStyle}>
        <PhysicalTrendChip label="最新" value={fmtScore(chart.latestScore)} tone={chart.latestScore} />
        <PhysicalTrendChip label="全期間" value={formatDelta(chart.deltaAll)} tone={chart.deltaAll} />
        <PhysicalTrendChip label="20日変化" value={formatDelta(chart.delta20)} tone={chart.delta20} />
        <PhysicalTrendChip label="直近方向" value={trendLabel} tone={directionDelta} />
      </div>
    </div>
  )
}

function PhysicalTrendChip({ label, value, tone }: { label: string; value: string; tone: number | null | undefined }) {
  const color = tone == null || !Number.isFinite(tone) ? 'var(--text-primary)' : tone >= 0 ? 'var(--price-up)' : 'var(--price-down)'
  return (
    <div style={physicalTrendChipStyle}>
      <span>{label}</span>
      <strong style={{ color }}>{value}</strong>
    </div>
  )
}

function PhysicalActionPoints({
  latest,
  trend,
  field,
}: {
  latest: PhysicalMomentumApiRow
  trend: PhysicalMomentumResponse['trend']
  field: PhysicalMaFieldInsight | null
}) {
  const points = buildPhysicalActionPoints(latest, trend, field)
  return (
    <div style={physicalActionPanelStyle}>
      <div style={physicalMiniHeaderStyle}>
        <strong>だから、どう見る？</strong>
        <span>買い目線と空売り目線を分けて、次に確認する条件だけを表示します。</span>
      </div>
      <div style={physicalActionListStyle}>
        {points.map((point, index) => (
          <div key={`${point.label}-${point.text}`} style={{ ...physicalActionItemStyle, ...physicalActionToneStyle(point.tone) }}>
            <span style={{ ...physicalActionIndexStyle, ...physicalActionIndexToneStyle(point.tone) }}>{index + 1}</span>
            <span>
              <strong style={physicalActionLabelStyle}>{point.label}</strong>
              <span>{point.text}</span>
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}

function PhysicalTradePlanCards({
  loading,
  error,
  plan,
}: {
  loading: boolean
  error: string
  plan: PhysicalPlanResponse | null
}) {
  if (loading) {
    return (
      <div style={physicalTradePlanPanelStyle}>
        <div style={physicalMiniHeaderStyle}>
          <strong>短期・中期・長期プラン</strong>
          <span>統計と物理MLを確認中...</span>
        </div>
        <div style={physicalTradePlanGridStyle}>
          {['短期', '中期', '長期'].map((label) => (
            <div key={label} style={{ ...physicalTradePlanCardStyle, minHeight: 154, background: 'var(--surface-muted)' }} />
          ))}
        </div>
      </div>
    )
  }

  if (error) {
    return (
      <div style={physicalTradePlanPanelStyle}>
        <div style={physicalMiniHeaderStyle}>
          <strong>短期・中期・長期プラン</strong>
          <span style={{ color: 'var(--price-down)' }}>取得エラー: {error}</span>
        </div>
      </div>
    )
  }

  if (!plan?.available || plan.horizons.length === 0) {
    return (
      <div style={physicalTradePlanPanelStyle}>
        <div style={physicalMiniHeaderStyle}>
          <strong>短期・中期・長期プラン</strong>
          <span>物理ML特徴量が不足しています</span>
        </div>
        <p style={summaryEmptyStyle}>現時点では時間軸別の統計解釈を作れません。</p>
      </div>
    )
  }

  return (
    <div style={physicalTradePlanPanelStyle}>
      <div style={physicalMiniHeaderStyle}>
        <strong>短期・中期・長期の観察プラン</strong>
        <span>{plan.featureAsOfDate ? `特徴量 ${plan.featureAsOfDate}` : '特徴量日付 -'}</span>
      </div>
      <div style={physicalTradePlanGridStyle}>
        {plan.horizons.map((horizon) => (
          <PhysicalTradePlanCard key={`${horizon.label}-${horizon.horizonDays}`} horizon={horizon} />
        ))}
      </div>
      <p style={physicalTradePlanNoteStyle}>
        {plan.note ?? 'この表示は現在形状と過去検証統計から作る観察メモです。売買を断定するものではありません。'}
      </p>
    </div>
  )
}

function PhysicalTradePlanCard({ horizon }: { horizon: PhysicalPlanHorizon }) {
  const tone = tradePlanToneStyle(horizon.suggestion.tone)
  const topCandidates = horizon.candidates
    .slice()
    .sort((a, b) => a.rank - b.rank)
    .slice(0, 3)
  return (
    <div style={{ ...physicalTradePlanCardStyle, borderColor: tone.border, background: tone.background }}>
      <div style={physicalTradePlanTopStyle}>
        <div>
          <span style={physicalTradePlanLabelStyle}>{horizon.label}</span>
          <strong style={{ ...physicalTradePlanHeadlineStyle, color: tone.color }}>{horizon.suggestion.headline}</strong>
        </div>
        <span style={{ ...physicalTradePlanBadgeStyle, borderColor: tone.border, color: tone.color }}>
          {horizon.horizonDays}営業日
        </span>
      </div>
      <p style={physicalTradePlanStanceStyle}>{horizon.suggestion.stance}</p>
      <PhysicalPlanLevelStrip levels={horizon.levels} />
      <div style={physicalTradePlanEvidenceStyle}>
        <span>構造 {physicalPlanDirectionLabel(horizon.suggestion.decision.structureDirection)}</span>
        <span>PMS/PFS {physicalPlanDirectionLabel(horizon.suggestion.decision.momentumDirection)}</span>
        {horizon.suggestion.decision.candidateDirection !== 'wait' && (
          <span>物理ML {physicalPlanDirectionLabel(horizon.suggestion.decision.candidateDirection)}</span>
        )}
        <span>{physicalPlanStatisticsLabel(horizon.suggestion.decision.statisticsQuality)}</span>
      </div>
      <div style={physicalTradePlanMetricGridStyle}>
        <PhysicalPlanMetric label="的中率" value={fmtRate(horizon.hitRate)} sub="同状態の実績" />
        <PhysicalPlanMetric label="基準率" value={fmtRate(horizon.baseRate)} sub="市場全体" />
        <PhysicalPlanMetric label="Lift" value={fmtLift(horizon.lift)} sub={`信頼 ${horizon.confidenceLabel}`} />
      </div>
      <div style={physicalTradePlanCandidatesStyle}>
        {topCandidates.length > 0 ? topCandidates.map((candidate) => (
          <span key={`${candidate.direction}-${candidate.rank}`} style={physicalTradePlanCandidatePillStyle}>
            {directionLabelJa(candidate.direction)} #{candidate.rank}
          </span>
        )) : (
          <span style={physicalTradePlanCandidatePillStyle}>物理ML上位外</span>
        )}
        {horizon.sampleCount != null && (
          <span style={physicalTradePlanCandidatePillStyle}>検証 n={horizon.sampleCount.toLocaleString('ja-JP')}</span>
        )}
      </div>
      <div style={physicalTradePlanChecklistStyle}>
        {horizon.suggestion.checklist.slice(0, 2).map((item) => (
          <div key={item} style={physicalTradePlanCheckItemStyle}>
            <span style={{ ...physicalTradePlanDotStyle, background: tone.color }} />
            <span>{item}</span>
          </div>
        ))}
      </div>
      <div style={physicalTradePlanInvalidationStyle}>
        <strong>{horizon.suggestion.conditionLabel}</strong>
        <span>{horizon.suggestion.invalidation}</span>
      </div>
      <div style={physicalTradePlanFooterStyle}>
        <span>{horizon.evaluationDate ? `検証 ${horizon.evaluationDate}` : '検証日 -'}</span>
      </div>
    </div>
  )
}

function PhysicalPlanLevelStrip({ levels }: { levels: PhysicalPlanLevels | null }) {
  if (!levels) return null
  return (
    <div style={physicalTradePlanLevelsStyle}>
      <div style={physicalTradePlanBaseStyle}>
        <span>基準 {levels.baseDate}</span>
        <strong>{fmtPrice(levels.close)}</strong>
      </div>
      <div style={physicalTradePlanLevelGridStyle}>
        <PhysicalPlanLevelChip label="支持" level={levels.support} tone="support" />
        <PhysicalPlanLevelChip label="抵抗" level={levels.resistance} tone="resistance" />
        <PhysicalPlanLevelChip label="割れ注意" level={levels.breakdown} tone="breakdown" />
      </div>
    </div>
  )
}

function PhysicalPlanLevelChip({
  label,
  level,
  tone,
}: {
  label: string
  level: PhysicalPlanLevel
  tone: 'base' | 'support' | 'resistance' | 'breakdown'
}) {
  const color =
    tone === 'support' ? 'var(--price-up)'
      : tone === 'resistance' || tone === 'breakdown' ? 'var(--price-down)'
        : 'var(--text-primary)'
  return (
    <div style={physicalTradePlanLevelChipStyle}>
      <span style={physicalTradePlanLevelLabelStyle}>{label}</span>
      <strong style={{ ...physicalTradePlanLevelValueStyle, color }}>{fmtPrice(level.value)}</strong>
      <small style={physicalTradePlanLevelSubStyle}>
        {level.label}{level.distancePct != null ? ` ${fmtPct(level.distancePct)}` : ''}
      </small>
    </div>
  )
}

function PhysicalPlanMetric({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <div style={physicalTradePlanMetricStyle}>
      <span>{label}</span>
      <strong>{value}</strong>
      <small>{sub}</small>
    </div>
  )
}

interface PhysicalMaFieldInsight {
  label: string
  description: string
  color: string
  spreadDeg: number | null
  spreadChangeDeg: number | null
}

function buildMaFieldInsight(latest: PhysicalMomentumApiRow, previous: PhysicalMomentumApiRow | null): PhysicalMaFieldInsight {
  const latestAngles = [latest.ma5Angle, latest.ma25Angle, latest.ma75Angle, latest.ma200Angle]
    .map(angleDeg)
    .filter((value): value is number => value != null)
  const previousAngles = previous
    ? [previous.ma5Angle, previous.ma25Angle, previous.ma75Angle, previous.ma200Angle]
      .map(angleDeg)
      .filter((value): value is number => value != null)
    : []

  if (latestAngles.length < 3) {
    return {
      label: 'MA力場未判定',
      description: 'MA角度データが不足しています。',
      color: 'var(--text-muted)',
      spreadDeg: null,
      spreadChangeDeg: null,
    }
  }

  const ma5 = angleDeg(latest.ma5Angle)
  const ma25 = angleDeg(latest.ma25Angle)
  const ma75 = angleDeg(latest.ma75Angle)
  const ma200 = angleDeg(latest.ma200Angle)
  const shortAvg = averageFinite([ma5, ma25])
  const longAvg = averageFinite([ma75, ma200])
  const positive = latestAngles.filter((value) => value > 0.2).length
  const negative = latestAngles.filter((value) => value < -0.2).length
  const spreadDeg = angularSpread(latestAngles)
  const previousSpread = previousAngles.length >= 3 ? angularSpread(previousAngles) : null
  const spreadChangeDeg = spreadDeg != null && previousSpread != null ? spreadDeg - previousSpread : null

  let label = '力場は中立'
  let description = '短期線と長期線の向きがまだ揃っていません。価格の力がどちらへ伝わるか確認する局面です。'
  let color = 'var(--text-secondary)'

  if (shortAvg != null && longAvg != null && shortAvg > 0.2 && longAvg > 0.2 && positive >= 3) {
    label = '上方向へ力が拡散'
    description = '短期線だけでなく長期線側にも上向きの力が伝わっています。上位足との整合を確認したい状態です。'
    color = 'var(--price-up)'
  } else if (shortAvg != null && longAvg != null && shortAvg < -0.2 && longAvg < -0.2 && negative >= 3) {
    label = '下方向へ力が拡散'
    description = '短期線から長期線側まで下向きの力が広がっています。反発よりも下落継続リスクを優先確認します。'
    color = 'var(--price-down)'
  } else if (shortAvg != null && longAvg != null && shortAvg > 0.2 && longAvg < -0.2) {
    label = '短期上向き・長期収縮'
    description = '短期には上向きの力がありますが、長期線はまだ下向きです。力が長期側へ拡散するかが焦点です。'
    color = 'var(--price-up)'
  } else if (shortAvg != null && longAvg != null && shortAvg < -0.2 && longAvg > 0.2) {
    label = '短期調整・長期残存'
    description = '短期線は下向きですが、長期線には上向きの力が残っています。一時調整か崩れ始めかを確認します。'
    color = 'var(--price-down)'
  } else if (spreadChangeDeg != null && spreadChangeDeg >= 5) {
    label = '力場が拡散中'
    description = 'MA角度の幅が広がっています。力が一方向へ揃うか、ねじれとして分散するかを確認します。'
    color = positive >= negative ? 'var(--price-up)' : 'var(--price-down)'
  } else if (spreadChangeDeg != null && spreadChangeDeg <= -5) {
    label = '力場が収縮中'
    description = 'MA角度の幅が狭まっています。方向感はいったん圧縮され、次の拡散方向を待つ局面です。'
    color = 'var(--text-secondary)'
  } else if (positive > 0 && negative > 0) {
    label = '力場がねじれ'
    description = '短期・中期・長期の向きが混在しています。単純な上昇/下落ではなく、時間軸ごとの力の差を見ます。'
    color = 'var(--text-secondary)'
  }

  return { label, description, color, spreadDeg, spreadChangeDeg }
}

function angleDeg(value: number | null | undefined): number | null {
  if (value == null || !Number.isFinite(value)) return null
  return (value * 180) / Math.PI
}

function averageFinite(values: Array<number | null>): number | null {
  const finite = values.filter((value): value is number => value != null && Number.isFinite(value))
  if (finite.length === 0) return null
  return finite.reduce((sum, value) => sum + value, 0) / finite.length
}

function angularSpread(values: number[]): number | null {
  if (values.length === 0) return null
  return Math.max(...values) - Math.min(...values)
}

function angleBarPercent(value: number | null): number {
  if (value == null || !Number.isFinite(value)) return 50
  const clipped = Math.max(-75, Math.min(75, value))
  return ((clipped + 75) / 150) * 100
}

function angleDirectionArrow(value: number | null): string {
  if (value == null || !Number.isFinite(value)) return '-'
  if (value >= 1.2) return '↗'
  if (value <= -1.2) return '↘'
  return '→'
}

function angleDirectionLabel(value: number | null): string {
  if (value == null || !Number.isFinite(value)) return '未判定'
  if (value >= 3) return '上向き強'
  if (value >= 1.2) return '上向き'
  if (value <= -3) return '下向き強'
  if (value <= -1.2) return '下向き'
  return '横ばい'
}

function angleDirectionColor(value: number | null): string {
  if (value == null || !Number.isFinite(value)) return 'var(--text-muted)'
  if (value >= 1.2) return 'var(--price-up)'
  if (value <= -1.2) return 'var(--price-down)'
  return 'var(--text-secondary)'
}

function physicalToneColor(tone: PhysicalMomentumTone): string {
  if (tone === 'up') return 'var(--price-up)'
  if (tone === 'down') return 'var(--price-down)'
  if (tone === 'warning') return '#b45309'
  return 'var(--text-secondary)'
}

function physicalActionToneStyle(tone: PhysicalMomentumTone): CSSProperties {
  if (tone === 'up') {
    return {
      borderColor: 'rgba(220, 38, 38, 0.28)',
      background: 'linear-gradient(135deg, rgba(220, 38, 38, 0.08), #fff 72%)',
      color: 'var(--text-primary)',
    }
  }
  if (tone === 'down') {
    return {
      borderColor: 'rgba(37, 99, 235, 0.30)',
      background: 'linear-gradient(135deg, rgba(37, 99, 235, 0.09), #fff 72%)',
      color: 'var(--text-primary)',
    }
  }
  if (tone === 'warning') {
    return {
      borderColor: 'rgba(245, 158, 11, 0.34)',
      background: 'linear-gradient(135deg, rgba(245, 158, 11, 0.12), #fff 72%)',
      color: 'var(--text-primary)',
    }
  }
  return {}
}

function physicalActionIndexToneStyle(tone: PhysicalMomentumTone): CSSProperties {
  const color = physicalToneColor(tone)
  return {
    color,
    borderColor: color,
    background: tone === 'neutral' ? 'var(--bg-elevated)' : '#fff',
  }
}

function buildPhysicalMomentumInsight(
  latest: PhysicalMomentumApiRow,
  rank: number | null,
  total: number,
  trend: PhysicalMomentumResponse['trend'],
  field: PhysicalMaFieldInsight | null,
) {
  const view = buildPhysicalMomentumView({
    pms: latest.physicalMomentumScore,
    pfs: latest.physicalForceScore,
    pes: latest.physicalEnergyScore,
    trend,
    rank,
    total,
    fieldLabel: field?.label,
  })

  return {
    label: view.label,
    description: view.summary,
    color: physicalToneColor(view.tone),
    reasons: view.badges,
  }
}

function buildPhysicalActionPoints(
  latest: PhysicalMomentumApiRow,
  trend: PhysicalMomentumResponse['trend'],
  field: PhysicalMaFieldInsight | null,
): PhysicalMomentumCheck[] {
  return buildPhysicalMomentumView({
    pms: latest.physicalMomentumScore,
    pfs: latest.physicalForceScore,
    pes: latest.physicalEnergyScore,
    trend,
    fieldLabel: field?.label,
  }).checks
}

function physicalSignalText(value: number | null | undefined, kind: 'force' | 'energy'): string {
  if (value == null || !Number.isFinite(value)) return kind === 'force' ? '力の変化未判定' : 'エネルギー未判定'
  if (kind === 'force') {
    if (value >= 1) return '上向きの力が強い'
    if (value >= 0.35) return '上向きの力あり'
    if (value <= -1) return '下向きの力が強い'
    if (value <= -0.35) return '下向きの力あり'
    return '力の変化は中立'
  }
  if (value >= 1) return '運動エネルギーが高い'
  if (value >= 0.35) return '運動エネルギーあり'
  if (value <= -1) return '運動エネルギーが弱い'
  if (value <= -0.35) return '運動エネルギーはやや弱い'
  return '運動エネルギーは中立'
}

function fmtRate(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '-'
  return `${(value * 100).toFixed(0)}%`
}

function fmtLift(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '-'
  return `${value.toFixed(2)}x`
}

function fmtPctRaw(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '-'
  return `${value >= 0 ? '+' : ''}${value.toFixed(1)}%`
}

function directionLabelJa(direction: 'up' | 'down' | 'wait'): string {
  if (direction === 'up') return '上昇'
  if (direction === 'down') return '下落'
  return '見送り'
}

function tradePlanToneStyle(tone: PhysicalPlanHorizon['suggestion']['tone']) {
  if (tone === 'positive') {
    return { color: 'var(--price-up)', border: 'rgba(22, 163, 74, 0.34)', background: 'rgba(22, 163, 74, 0.06)' }
  }
  if (tone === 'negative') {
    return { color: 'var(--price-down)', border: 'rgba(37, 99, 235, 0.34)', background: 'rgba(37, 99, 235, 0.06)' }
  }
  if (tone === 'warning') {
    return { color: '#b45309', border: 'rgba(245, 158, 11, 0.36)', background: 'rgba(245, 158, 11, 0.08)' }
  }
  return { color: 'var(--text-secondary)', border: 'var(--border-subtle)', background: 'var(--bg-elevated)' }
}

function scoreBarPercent(value: number | null | undefined): number {
  if (value == null || !Number.isFinite(value)) return 50
  const clipped = Math.max(-2.5, Math.min(2.5, value))
  return ((clipped + 2.5) / 5) * 100
}

function fmtScore(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '-'
  return value.toFixed(2)
}

function formatDelta(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '-'
  return `${value >= 0 ? '+' : ''}${value.toFixed(2)}`
}

function trendLabelFromDelta(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '判定保留'
  if (value >= 0.35) return '改善'
  if (value <= -0.35) return '悪化'
  return '横ばい'
}

function scoreLevelLabel(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return 'PMS未判定'
  if (value >= 1) return '市場より強い'
  if (value >= 0.35) return 'やや強い'
  if (value <= -1) return '市場より弱い'
  if (value <= -0.35) return 'やや弱い'
  return '市場平均付近'
}

function fmtDecimal(value: number | null | undefined, digits = 2): string {
  if (value == null || !Number.isFinite(value)) return '-'
  return value.toFixed(digits)
}

function fmtCompact(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '-'
  return new Intl.NumberFormat('ja-JP', {
    notation: 'compact',
    maximumFractionDigits: 2,
  }).format(value)
}

type StageKey =
  | 'daily_a_stage'
  | 'daily_b_stage'
  | 'weekly_a_stage'
  | 'weekly_b_stage'
  | 'monthly_a_stage'
  | 'monthly_b_stage'

interface SummaryStageEntry {
  date: string
  close: number | null
  ma_5: number | null
  ma_25: number | null
  ma_75: number | null
  ma_300: number | null
  daily_a_stage: number | null
  daily_b_stage: number | null
  weekly_a_stage: number | null
  weekly_b_stage: number | null
  monthly_a_stage: number | null
  monthly_b_stage: number | null
}

const SUMMARY_STAGE_KEYS: { key: StageKey; label: string }[] = [
  { key: 'daily_a_stage', label: '日A' },
  { key: 'daily_b_stage', label: '日B' },
  { key: 'weekly_a_stage', label: '週A' },
  { key: 'weekly_b_stage', label: '週B' },
  { key: 'monthly_a_stage', label: '月A' },
  { key: 'monthly_b_stage', label: '月B' },
]

function fmtPrice(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '-'
  return `${Math.round(value).toLocaleString('ja-JP')}円`
}

function fmtPct(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '-'
  return `${value >= 0 ? '+' : ''}${value.toFixed(1)}%`
}

const physicalCardStyle: CSSProperties = {
  padding: '14px',
}

const physicalHeaderStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'flex-start',
  justifyContent: 'space-between',
  gap: '12px',
  flexWrap: 'wrap',
  marginBottom: '10px',
}

const physicalSubTextStyle: CSSProperties = {
  marginTop: '4px',
  color: 'var(--text-muted)',
  fontSize: '11px',
}

const physicalDateBadgeStyle: CSSProperties = {
  border: '1px solid var(--border-base)',
  borderRadius: 'var(--radius-sm)',
  background: 'var(--bg-elevated)',
  color: 'var(--text-secondary)',
  fontFamily: 'var(--font-mono)',
  fontSize: '11px',
  fontWeight: 700,
  padding: '4px 8px',
}

const physicalHeroStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(min(240px, 100%), 1fr))',
  gap: '10px',
  alignItems: 'stretch',
  border: '1px solid var(--border-subtle)',
  borderRadius: 'var(--radius-sm)',
  background: 'linear-gradient(180deg, #fff, var(--bg-elevated))',
  padding: '12px',
  marginBottom: '10px',
}

const physicalHeroMainStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: '6px',
  minWidth: 0,
}

const physicalHeroLabelStyle: CSSProperties = {
  alignSelf: 'flex-start',
  border: '1px solid currentColor',
  borderRadius: '999px',
  background: '#fff',
  color: 'var(--text-muted)',
  fontSize: '10px',
  fontWeight: 800,
  padding: '3px 8px',
}

const physicalHeroTitleStyle: CSSProperties = {
  fontSize: '24px',
  fontWeight: 800,
  lineHeight: 1.15,
}

const physicalHeroDescriptionStyle: CSSProperties = {
  margin: 0,
  color: 'var(--text-secondary)',
  fontSize: '12px',
  lineHeight: 1.65,
}

const physicalTimeframePanelStyle: CSSProperties = {
  border: '1px solid var(--border-subtle)',
  borderRadius: 'var(--radius-sm)',
  background: 'linear-gradient(180deg, #fff, var(--bg-elevated))',
  padding: '12px',
  marginBottom: '10px',
}

const physicalTimeframeGridStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(min(210px, 100%), 1fr))',
  gap: '10px',
}

const physicalTimeframeCardStyle: CSSProperties = {
  border: '1px solid var(--border-subtle)',
  borderRadius: 'var(--radius-sm)',
  padding: '10px',
  display: 'grid',
  gap: '8px',
  minWidth: 0,
}

const physicalTimeframeCardTopStyle: CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  gap: '8px',
  alignItems: 'flex-start',
}

const physicalTimeframeLabelStyle: CSSProperties = {
  display: 'block',
  color: 'var(--text-muted)',
  fontSize: '10px',
  fontWeight: 800,
}

const physicalTimeframeTitleStyle: CSSProperties = {
  display: 'block',
  marginTop: '3px',
  fontSize: '15px',
  lineHeight: 1.25,
}

const physicalTimeframeBadgeStyle: CSSProperties = {
  border: '1px solid currentColor',
  borderRadius: '999px',
  background: '#fff',
  fontFamily: 'var(--font-mono)',
  fontSize: '10px',
  fontWeight: 900,
  padding: '3px 7px',
}

const physicalTimeframeMetricRowStyle: CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  gap: '6px',
  color: 'var(--text-secondary)',
  fontFamily: 'var(--font-mono)',
  fontSize: '11px',
  fontWeight: 800,
}

const physicalTimeframeStanceStyle: CSSProperties = {
  margin: 0,
  color: 'var(--text-primary)',
  fontSize: '12px',
  fontWeight: 700,
  lineHeight: 1.55,
}

const physicalTimeframeMetaStyle: CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  gap: '6px',
  color: 'var(--text-muted)',
  fontSize: '10px',
  fontWeight: 700,
}

const physicalTimeframeNoteStyle: CSSProperties = {
  margin: '10px 0 0',
  color: 'var(--text-muted)',
  fontSize: '11px',
  lineHeight: 1.6,
}

const physicalReasonPanelStyle: CSSProperties = {
  border: '1px solid var(--border-subtle)',
  borderRadius: 'var(--radius-sm)',
  background: 'rgba(255,255,255,0.72)',
  padding: '10px',
  minWidth: 0,
}

const physicalReasonPanelTitleStyle: CSSProperties = {
  color: 'var(--text-muted)',
  fontSize: '10px',
  fontWeight: 800,
  marginBottom: '8px',
}

const physicalReasonListStyle: CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  gap: '6px',
}

const physicalReasonPillStyle: CSSProperties = {
  border: '1px solid var(--border-subtle)',
  borderRadius: '999px',
  background: '#fff',
  color: 'var(--text-secondary)',
  fontSize: '10px',
  fontWeight: 700,
  padding: '4px 8px',
}

const physicalGaugeStyle: CSSProperties = {
  border: '1px solid var(--border-subtle)',
  borderRadius: 'var(--radius-sm)',
  background: '#fff',
  padding: '10px',
  display: 'flex',
  flexDirection: 'column',
  justifyContent: 'center',
  gap: '8px',
  minWidth: 0,
}

const physicalGaugeValueRowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'baseline',
  justifyContent: 'space-between',
  gap: '8px',
}

const physicalGaugeTrackStyle: CSSProperties = {
  position: 'relative',
  height: '10px',
  borderRadius: '999px',
  background: 'var(--bg-surface)',
  border: '1px solid var(--border-subtle)',
  overflow: 'hidden',
}

const physicalGaugeFillStyle: CSSProperties = {
  position: 'absolute',
  left: 0,
  top: 0,
  bottom: 0,
  borderRadius: '999px',
  opacity: 0.85,
}

const physicalGaugeZeroStyle: CSSProperties = {
  position: 'absolute',
  left: '50%',
  top: 0,
  bottom: 0,
  width: '1px',
  background: 'var(--text-muted)',
  opacity: 0.5,
  zIndex: 1,
}

const physicalGaugeScaleStyle: CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  color: 'var(--text-muted)',
  fontFamily: 'var(--font-mono)',
  fontSize: '9px',
}

const physicalGaugeMetaStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'baseline',
  justifyContent: 'space-between',
  gap: '8px',
  color: 'var(--text-secondary)',
  fontSize: '10px',
}

const physicalScoreGridStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))',
  gap: '8px',
  marginBottom: '10px',
}

const physicalScoreCardStyle: CSSProperties = {
  border: '1px solid var(--border-subtle)',
  borderRadius: 'var(--radius-sm)',
  background: 'var(--bg-elevated)',
  padding: '10px',
  display: 'flex',
  flexDirection: 'column',
  gap: '6px',
}

const physicalScoreTopStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'baseline',
  justifyContent: 'space-between',
  gap: '8px',
}

const physicalScoreLabelWrapStyle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: '5px',
  minWidth: 0,
}

const physicalScoreLabelStyle: CSSProperties = {
  color: 'var(--text-primary)',
  fontSize: '11px',
  fontWeight: 800,
}

const physicalScoreCodeStyle: CSSProperties = {
  border: '1px solid var(--border-subtle)',
  borderRadius: '999px',
  background: '#fff',
  color: 'var(--text-muted)',
  fontFamily: 'var(--font-mono)',
  fontSize: '9px',
  fontWeight: 800,
  padding: '1px 5px',
}

const physicalScoreTitleStyle: CSSProperties = {
  color: 'var(--text-primary)',
  fontSize: '12px',
  fontWeight: 800,
}

const physicalMeterTrackStyle: CSSProperties = {
  height: '5px',
  borderRadius: '999px',
  background: 'var(--bg-surface)',
  overflow: 'hidden',
}

const physicalMeterFillStyle: CSSProperties = {
  display: 'block',
  height: '100%',
  borderRadius: '999px',
  opacity: 0.82,
}

const physicalScoreSubStyle: CSSProperties = {
  color: 'var(--text-secondary)',
  fontSize: '10px',
  lineHeight: 1.4,
}

const physicalScoreGuideStyle: CSSProperties = {
  color: 'var(--text-muted)',
  fontSize: '10px',
  lineHeight: 1.45,
}

const physicalActionPanelStyle: CSSProperties = {
  border: '1px solid var(--border-subtle)',
  borderRadius: 'var(--radius-sm)',
  background: 'linear-gradient(180deg, #fff 0%, var(--bg-elevated) 100%)',
  padding: '10px',
  marginBottom: '10px',
}

const physicalActionListStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(min(220px, 100%), 1fr))',
  gap: '7px',
}

const physicalActionItemStyle: CSSProperties = {
  border: '1px solid var(--border-subtle)',
  borderRadius: 'var(--radius-sm)',
  background: '#fff',
  color: 'var(--text-secondary)',
  display: 'grid',
  gridTemplateColumns: '22px minmax(0, 1fr)',
  gap: '7px',
  alignItems: 'start',
  fontSize: '11px',
  lineHeight: 1.55,
  padding: '8px',
}

const physicalActionLabelStyle: CSSProperties = {
  display: 'block',
  color: 'var(--text-primary)',
  fontSize: '11px',
  fontWeight: 900,
  marginBottom: '2px',
}

const physicalActionIndexStyle: CSSProperties = {
  width: '20px',
  height: '20px',
  borderRadius: '999px',
  background: 'var(--bg-elevated)',
  border: '1px solid var(--border-subtle)',
  color: 'var(--text-primary)',
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  fontFamily: 'var(--font-mono)',
  fontSize: '10px',
  fontWeight: 800,
}

const physicalTradePlanPanelStyle: CSSProperties = {
  border: '1px solid var(--border-subtle)',
  borderRadius: 'var(--radius-sm)',
  background: '#fff',
  padding: '8px',
  marginBottom: '8px',
}

const physicalTradePlanGridStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(min(260px, 100%), 1fr))',
  gap: '6px',
}

const physicalTradePlanCardStyle: CSSProperties = {
  border: '1px solid var(--border-subtle)',
  borderRadius: 'var(--radius-sm)',
  padding: '8px',
  display: 'flex',
  flexDirection: 'column',
  gap: '6px',
  minWidth: 0,
}

const physicalTradePlanTopStyle: CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  gap: '8px',
  alignItems: 'flex-start',
}

const physicalTradePlanLabelStyle: CSSProperties = {
  display: 'block',
  color: 'var(--text-muted)',
  fontSize: '10px',
  fontWeight: 900,
  marginBottom: '3px',
}

const physicalTradePlanHeadlineStyle: CSSProperties = {
  display: 'block',
  fontSize: '14px',
  fontWeight: 900,
  lineHeight: 1.35,
}

const physicalTradePlanBadgeStyle: CSSProperties = {
  border: '1px solid var(--border-subtle)',
  borderRadius: '999px',
  background: '#fff',
  fontFamily: 'var(--font-mono)',
  fontSize: '10px',
  fontWeight: 900,
  padding: '3px 7px',
  whiteSpace: 'nowrap',
}

const physicalTradePlanStanceStyle: CSSProperties = {
  margin: 0,
  color: 'var(--text-primary)',
  fontSize: '11px',
  fontWeight: 900,
  lineHeight: 1.5,
}

const physicalTradePlanLevelsStyle: CSSProperties = {
  display: 'grid',
  gap: '5px',
}

const physicalTradePlanBaseStyle: CSSProperties = {
  borderTop: '1px solid var(--border-subtle)',
  borderBottom: '1px solid var(--border-subtle)',
  padding: '4px 1px',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: '6px',
  color: 'var(--text-secondary)',
  fontSize: '9px',
  fontWeight: 800,
}

const physicalTradePlanLevelGridStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(3, minmax(0, 1fr))',
  gap: '4px',
}

const physicalTradePlanLevelChipStyle: CSSProperties = {
  border: '1px solid var(--border-subtle)',
  borderRadius: '5px',
  background: 'rgba(255,255,255,0.72)',
  padding: '5px',
  display: 'grid',
  gap: '2px',
  minWidth: 0,
}

const physicalTradePlanLevelLabelStyle: CSSProperties = {
  color: 'var(--text-muted)',
  fontSize: '9px',
  fontWeight: 900,
  lineHeight: 1.2,
  whiteSpace: 'nowrap',
}

const physicalTradePlanLevelValueStyle: CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: '12px',
  fontWeight: 900,
  lineHeight: 1.2,
  whiteSpace: 'nowrap',
}

const physicalTradePlanLevelSubStyle: CSSProperties = {
  color: 'var(--text-muted)',
  fontSize: '9px',
  fontWeight: 700,
  lineHeight: 1.25,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
}

const physicalTradePlanEvidenceStyle: CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  gap: '4px',
  color: 'var(--text-secondary)',
  fontSize: '9px',
  fontWeight: 900,
}

const physicalTradePlanMetricGridStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(3, minmax(0, 1fr))',
  gap: '4px',
}

const physicalTradePlanMetricStyle: CSSProperties = {
  border: '1px solid var(--border-subtle)',
  borderRadius: '5px',
  background: '#fff',
  padding: '5px',
  display: 'grid',
  gap: '2px',
  minWidth: 0,
}

const physicalTradePlanCandidatesStyle: CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  gap: '4px',
}

const physicalTradePlanCandidatePillStyle: CSSProperties = {
  border: '1px solid var(--border-subtle)',
  borderRadius: '999px',
  background: '#fff',
  color: 'var(--text-secondary)',
  fontSize: '9px',
  fontWeight: 800,
  padding: '2px 6px',
}

const physicalTradePlanChecklistStyle: CSSProperties = {
  display: 'grid',
  gap: '5px',
}

const physicalTradePlanCheckItemStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: '8px minmax(0, 1fr)',
  gap: '6px',
  alignItems: 'start',
  color: 'var(--text-secondary)',
  fontSize: '11px',
  lineHeight: 1.5,
}

const physicalTradePlanDotStyle: CSSProperties = {
  width: '6px',
  height: '6px',
  borderRadius: '999px',
  marginTop: '6px',
  opacity: 0.85,
}

const physicalTradePlanInvalidationStyle: CSSProperties = {
  borderTop: '1px solid var(--border-subtle)',
  paddingTop: '5px',
  display: 'grid',
  gap: '2px',
  color: 'var(--text-secondary)',
  fontSize: '10px',
  lineHeight: 1.5,
}

const physicalTradePlanFooterStyle: CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  gap: '8px',
  flexWrap: 'wrap',
  color: 'var(--text-muted)',
  fontSize: '10px',
  lineHeight: 1.4,
}

const physicalTradePlanNoteStyle: CSSProperties = {
  margin: '6px 0 0',
  color: 'var(--text-muted)',
  fontSize: '10px',
  lineHeight: 1.5,
}

const physicalBodyGridStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(min(280px, 100%), 1fr))',
  gap: '10px',
}

const physicalBreakdownPanelStyle: CSSProperties = {
  border: '1px solid var(--border-subtle)',
  borderRadius: 'var(--radius-sm)',
  background: '#fff',
  padding: '8px',
}

const physicalFieldPanelStyle: CSSProperties = {
  border: '1px solid var(--border-subtle)',
  borderRadius: 'var(--radius-sm)',
  background: '#fff',
  padding: '8px',
  minWidth: 0,
}

const physicalMiniHeaderStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'baseline',
  justifyContent: 'space-between',
  gap: '8px',
  color: 'var(--text-secondary)',
  fontSize: '11px',
  marginBottom: '8px',
}

const physicalFieldSummaryStyle: CSSProperties = {
  border: '1px solid var(--border-subtle)',
  borderRadius: 'var(--radius-sm)',
  background: 'var(--bg-elevated)',
  padding: '8px',
  display: 'flex',
  flexDirection: 'column',
  gap: '4px',
  marginBottom: '8px',
}

const physicalFieldMetaStyle: CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  gap: '8px',
  color: 'var(--text-muted)',
  fontFamily: 'var(--font-mono)',
  fontSize: '10px',
  marginBottom: '8px',
}

const physicalFieldFlowStyle: CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  alignItems: 'center',
  justifyContent: 'center',
  gap: '5px',
  marginBottom: '9px',
}

const physicalFieldNodeStyle: CSSProperties = {
  minWidth: '64px',
  flex: '1 1 64px',
  border: '1px solid var(--border-subtle)',
  borderRadius: 'var(--radius-sm)',
  background: 'var(--bg-elevated)',
  padding: '7px 6px',
  display: 'grid',
  justifyItems: 'center',
  gap: '2px',
}

const physicalFieldNodeLabelStyle: CSSProperties = {
  color: 'var(--text-muted)',
  fontFamily: 'var(--font-mono)',
  fontSize: '9px',
  fontWeight: 800,
}

const physicalFieldNodeArrowStyle: CSSProperties = {
  fontSize: '18px',
  lineHeight: 1,
}

const physicalFieldNodeMetaStyle: CSSProperties = {
  color: 'var(--text-secondary)',
  fontSize: '9px',
  fontWeight: 800,
  whiteSpace: 'nowrap',
}

const physicalFieldNodeDegreeStyle: CSSProperties = {
  color: 'var(--text-muted)',
  fontFamily: 'var(--font-mono)',
  fontSize: '9px',
}

const physicalFieldConnectorStyle: CSSProperties = {
  color: 'var(--text-muted)',
  fontSize: '11px',
  textAlign: 'center',
  opacity: 0.72,
}

const physicalAngleRowsStyle: CSSProperties = {
  display: 'grid',
  gap: '6px',
}

const physicalAngleRowStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: '42px minmax(0, 1fr) 58px',
  alignItems: 'center',
  gap: '8px',
  color: 'var(--text-secondary)',
  fontFamily: 'var(--font-mono)',
  fontSize: '10px',
}

const physicalAngleTrackStyle: CSSProperties = {
  position: 'relative',
  height: '7px',
  borderRadius: '999px',
  background: 'var(--bg-surface)',
  overflow: 'hidden',
}

const physicalAngleZeroStyle: CSSProperties = {
  position: 'absolute',
  left: '50%',
  top: 0,
  bottom: 0,
  width: '1px',
  background: 'var(--text-muted)',
  opacity: 0.5,
  zIndex: 1,
}

const physicalAngleFillStyle: CSSProperties = {
  position: 'absolute',
  top: 0,
  bottom: 0,
  borderRadius: '999px',
  opacity: 0.82,
}

const physicalBreakdownGridStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(126px, 1fr))',
  gap: '6px',
}

const physicalBreakdownStyle: CSSProperties = {
  border: '1px solid var(--border-subtle)',
  borderRadius: 'var(--radius-sm)',
  background: 'var(--bg-elevated)',
  padding: '7px 8px',
  display: 'flex',
  flexDirection: 'column',
  gap: '3px',
}

const physicalSparklineBoxStyle: CSSProperties = {
  border: '1px solid var(--border-subtle)',
  borderRadius: 'var(--radius-sm)',
  background: '#fff',
  padding: '8px',
  minWidth: 0,
}

const physicalSparklineHeaderStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'baseline',
  justifyContent: 'space-between',
  gap: '8px',
  color: 'var(--text-secondary)',
  fontSize: '11px',
  marginBottom: '8px',
}

const physicalTrendHeaderNoteStyle: CSSProperties = {
  display: 'block',
  marginTop: '2px',
  color: 'var(--text-muted)',
  fontSize: '10px',
  fontWeight: 600,
}

const physicalTrendSvgStyle: CSSProperties = {
  width: '100%',
  height: '184px',
  display: 'block',
  border: '1px solid var(--border-subtle)',
  borderRadius: 'var(--radius-sm)',
  background: 'linear-gradient(180deg, #fff 0%, var(--bg-elevated) 100%)',
}

const physicalTrendLegendStyle: CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  gap: '6px 10px',
  marginTop: '7px',
  color: 'var(--text-muted)',
  fontSize: '10px',
  lineHeight: 1.4,
}

const physicalTrendLegendMarkerStyle: CSSProperties = {
  display: 'inline-block',
  width: '9px',
  height: '9px',
  borderRadius: '2px',
  marginRight: '4px',
  verticalAlign: '-1px',
}

const physicalTrendSummaryGridStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(4, minmax(0, 1fr))',
  gap: '6px',
  marginTop: '8px',
}

const physicalTrendChipStyle: CSSProperties = {
  border: '1px solid var(--border-subtle)',
  borderRadius: 'var(--radius-sm)',
  background: 'var(--bg-elevated)',
  padding: '6px 7px',
  display: 'flex',
  flexDirection: 'column',
  gap: '2px',
  minWidth: 0,
}

const physicalSparseTrendStyle: CSSProperties = {
  border: '1px solid var(--border-subtle)',
  borderRadius: 'var(--radius-sm)',
  background: 'linear-gradient(180deg, #fff 0%, var(--bg-elevated) 100%)',
  padding: '10px',
}

const physicalSparseTrendMainStyle: CSSProperties = {
  display: 'grid',
  gap: '4px',
  color: 'var(--text-secondary)',
  fontSize: '11px',
  lineHeight: 1.55,
}

const physicalSparsePointRowStyle: CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  gap: '5px',
  marginTop: '9px',
}

const physicalSparsePointStyle: CSSProperties = {
  border: '1px solid var(--border-subtle)',
  borderRadius: '999px',
  padding: '4px 7px',
  fontFamily: 'var(--font-mono)',
  fontSize: '10px',
  fontWeight: 800,
}

const physicalSparklineScaleStyle: CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  color: 'var(--text-muted)',
  fontFamily: 'var(--font-mono)',
  fontSize: '10px',
}

const physicalSparklineEmptyStyle: CSSProperties = {
  ...physicalSparklineBoxStyle,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  color: 'var(--text-muted)',
  fontSize: '11px',
  minHeight: '150px',
}

const summaryEmptyStyle: CSSProperties = {
  margin: 0,
  color: 'var(--text-muted)',
  fontSize: '11px',
}

function fmtShares(value: number | null | undefined) {
  if (value == null || !Number.isFinite(value)) return '---'
  if (Math.abs(value) >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}百万株`
  return `${Math.round(value).toLocaleString('ja-JP')}株`
}

function fmtChange(value: number | null | undefined) {
  if (value == null || !Number.isFinite(value)) return '---'
  return `${value > 0 ? '+' : ''}${Math.round(value).toLocaleString('ja-JP')}株`
}

type CompanyInfoTab = 'financial' | 'major' | 'policy' | 'large'

function CompanyIntelligencePanel({ info }: { info: StockOverviewInfo | null }) {
  const [tab, setTab] = useState<CompanyInfoTab>('financial')
  const latest = info?.financial.latest ?? null
  const previous = info?.financial.previousComparable ?? null
  const shareholders = info?.shareholders
  const tabs: Array<{
    id: CompanyInfoTab
    label: string
    count?: number
    icon: typeof Building2
  }> = [
    { id: 'financial', label: '財務サマリー', icon: Building2 },
    { id: 'major', label: '大株主', count: shareholders?.major.length, icon: Users },
    { id: 'policy', label: '政策保有', count: shareholders?.policy.length, icon: WalletCards },
    { id: 'large', label: '大量保有報告', count: shareholders?.largeReports.length, icon: FileSearch },
  ]

  return (
    <section className="card overflow-hidden">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-[var(--color-border-default)] bg-[var(--color-surface-subtle)] px-3 py-2.5">
        <div>
          <div className="text-[12px] font-black text-[var(--color-text-primary)]">企業・保有情報</div>
          <div className="mt-0.5 text-[9px] font-bold text-[var(--color-text-tertiary)]">
            財務はJ-Quants、大株主・保有報告はEDINETの公表情報
          </div>
        </div>
        <div className="text-right text-[9px] font-bold text-[var(--color-text-tertiary)]">
          {latest ? `財務開示 ${latest.disclosureDate}` : '財務データ未取得'}
        </div>
      </div>

      <div className="overflow-x-auto border-b border-[var(--color-border-default)]">
        <div className="flex min-w-max">
          {tabs.map(({ id, label, count, icon: Icon }) => (
            <button
              key={id}
              type="button"
              onClick={() => setTab(id)}
              aria-pressed={tab === id}
              className={`inline-flex h-9 items-center gap-1.5 border-r border-[var(--color-border-default)] px-3 text-[10px] font-black ${
                tab === id
                  ? 'bg-white text-[var(--color-brand-700)] shadow-[inset_0_-2px_0_var(--color-brand-600)]'
                  : 'bg-[var(--color-surface-subtle)] text-[var(--color-text-secondary)] hover:bg-white'
              }`}
            >
              <Icon size={13} aria-hidden="true" />
              {label}
              {count != null && (
                <span className="min-w-4 bg-[var(--color-surface-muted)] px-1 py-0.5 font-mono text-[9px] text-[var(--color-text-secondary)]">
                  {count}
                </span>
              )}
            </button>
          ))}
        </div>
      </div>

      <div className="min-h-44 p-3">
        {tab === 'financial' && (
          <FinancialSummaryView latest={latest} previous={previous} />
        )}
        {tab === 'major' && (
          <MajorShareholdersView
            rows={shareholders?.major ?? []}
            edinetConfigured={shareholders?.edinetConfigured ?? false}
            message={info?.statuses.major_shareholders?.message ?? null}
          />
        )}
        {tab === 'policy' && (
          <PolicyHoldingsView
            rows={shareholders?.policy ?? []}
            edinetConfigured={shareholders?.edinetConfigured ?? false}
            message={info?.statuses.policy_holdings?.message ?? null}
          />
        )}
        {tab === 'large' && (
          <LargeHoldingReportsView
            rows={shareholders?.largeReports ?? []}
            edinetConfigured={shareholders?.edinetConfigured ?? false}
            message={info?.statuses.large_holding_reports?.message ?? null}
          />
        )}
      </div>

      <div className="flex flex-wrap gap-x-4 gap-y-1 border-t border-[var(--color-border-soft)] px-3 py-2 text-[9px] font-bold">
        <a
          href={info?.sources.financial ?? 'https://jpx-jquants.com/ja/spec/fins-summary'}
          target="_blank"
          rel="noreferrer"
          className="text-[var(--color-brand-700)] hover:underline"
        >
          財務データ出典
        </a>
        <a
          href={info?.sources.shareholders ?? 'https://disclosure2.edinet-fsa.go.jp/'}
          target="_blank"
          rel="noreferrer"
          className="text-[var(--color-brand-700)] hover:underline"
        >
          株主・保有報告出典
        </a>
      </div>
    </section>
  )
}

function FinancialSummaryView({
  latest,
  previous,
}: {
  latest: FinancialSummary | null
  previous: FinancialSummary | null
}) {
  if (!latest) return <CompanyDataEmpty label="J-Quantsの財務サマリーを取得中です。" />
  const metrics = [
    ['売上高', latest.sales, previous?.sales],
    ['営業利益', latest.operatingProfit, previous?.operatingProfit],
    ['経常利益', latest.ordinaryProfit, previous?.ordinaryProfit],
    ['純利益', latest.netProfit, previous?.netProfit],
    ['営業CF', latest.operatingCashFlow, previous?.operatingCashFlow],
  ] as const
  const forecasts = [
    ['会社予想 売上高', latest.forecastSales],
    ['会社予想 営業利益', latest.forecastOperatingProfit],
    ['会社予想 純利益', latest.forecastNetProfit],
    ['会社予想 EPS', latest.forecastEps],
    ['会社予想 年間配当', latest.forecastAnnualDividend],
  ] as const

  return (
    <div>
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <span className="bg-[var(--color-brand-700)] px-2 py-1 text-[9px] font-black text-white">
          {financialPeriodLabel(latest.periodType)}
        </span>
        <span className="text-[10px] font-bold text-[var(--color-text-secondary)]">
          対象期間 {latest.periodEnd ?? latest.fiscalYearEnd ?? '---'}
        </span>
        <span className="text-[9px] font-bold text-[var(--color-text-tertiary)]">
          前年同区分比
        </span>
      </div>
      <div className="grid grid-cols-2 border-l border-t border-[var(--color-border-soft)] sm:grid-cols-3 lg:grid-cols-5">
        {metrics.map(([label, value, previousValue]) => (
          <FinancialMetric
            key={label}
            label={label}
            value={formatCorporateAmount(value)}
            change={financialChange(value, previousValue)}
          />
        ))}
      </div>
      <div className="mt-3 grid grid-cols-2 gap-x-4 md:grid-cols-4">
        <InfoLine label="EPS" value={latest.eps == null ? '---' : `${latest.eps.toFixed(2)}円`} />
        <InfoLine label="BPS" value={latest.bps == null ? '---' : `${latest.bps.toFixed(2)}円`} />
        <InfoLine label="自己資本比率" value={formatEquityRatio(latest.equityRatio)} />
        <InfoLine label="年間配当" value={latest.annualDividend == null ? '---' : `${latest.annualDividend.toFixed(2)}円`} />
      </div>
      {forecasts.some(([, value]) => value != null) && (
        <div className="mt-3 border-t border-[var(--color-border-default)] pt-2">
          <div className="mb-1.5 text-[10px] font-black text-[var(--color-text-secondary)]">会社予想</div>
          <div className="grid grid-cols-2 gap-x-4 md:grid-cols-5">
            {forecasts.map(([label, value]) => (
              <InfoLine
                key={label}
                label={label}
                value={
                  value == null
                    ? '---'
                    : label.includes('EPS') || label.includes('配当')
                      ? `${value.toFixed(2)}円`
                      : formatCorporateAmount(value)
                }
              />
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

function FinancialMetric({
  label,
  value,
  change,
}: {
  label: string
  value: string
  change: number | null
}) {
  return (
    <div className="min-w-0 border-b border-r border-[var(--color-border-soft)] px-2 py-2">
      <div className="truncate text-[9px] font-bold text-[var(--color-text-tertiary)]">{label}</div>
      <div className="mt-1 truncate font-mono text-[12px] font-black text-[var(--color-text-primary)]">{value}</div>
      <div className={`mt-0.5 font-mono text-[9px] font-bold ${
        change == null
          ? 'text-[var(--color-text-tertiary)]'
          : change >= 0 ? 'text-[var(--color-price-up)]' : 'text-[var(--color-price-down)]'
      }`}>
        {change == null ? '比較なし' : `${change >= 0 ? '+' : ''}${change.toFixed(1)}%`}
      </div>
    </div>
  )
}

function MajorShareholdersView({
  rows,
  edinetConfigured,
  message,
}: {
  rows: StockOverviewInfo['shareholders']['major']
  edinetConfigured: boolean
  message: string | null
}) {
  if (rows.length === 0) {
    return <EdinetEmptyState configured={edinetConfigured} message={message} label="大株主情報" />
  }
  return (
    <CompanyDataTable
      headers={['順位', '株主名', '保有株数', '保有比率']}
      rows={rows.map((row) => [
        `${row.rank}`,
        row.holderName,
        fmtShares(row.shares),
        formatHoldingRatio(row.holdingRatio),
      ])}
      meta={`基準 ${rows[0]?.fiscalYearEnd ?? rows[0]?.submittedAt?.slice(0, 10) ?? '---'}`}
      numericColumns={[0, 2, 3]}
    />
  )
}

function PolicyHoldingsView({
  rows,
  edinetConfigured,
  message,
}: {
  rows: StockOverviewInfo['shareholders']['policy']
  edinetConfigured: boolean
  message: string | null
}) {
  if (rows.length === 0) {
    return <EdinetEmptyState configured={edinetConfigured} message={message} label="政策保有株式" />
  }
  const total = rows.reduce((sum, row) => sum + (row.bookValue ?? 0), 0)
  return (
    <CompanyDataTable
      headers={['銘柄・発行体', '区分', '保有株数', '貸借対照表計上額', '保有目的']}
      rows={rows.map((row) => [
        row.issuerName,
        row.holdingType ?? '---',
        fmtShares(row.shares),
        formatCorporateAmount(row.bookValue),
        row.purpose ?? row.quantitativeEffect ?? '---',
      ])}
      meta={`${rows.length}銘柄 / 計上額合計 ${formatCorporateAmount(total)}`}
      numericColumns={[2, 3]}
    />
  )
}

function LargeHoldingReportsView({
  rows,
  edinetConfigured,
  message,
}: {
  rows: StockOverviewInfo['shareholders']['largeReports']
  edinetConfigured: boolean
  message: string | null
}) {
  if (rows.length === 0) {
    return <EdinetEmptyState configured={edinetConfigured} message={message} label="大量保有報告" />
  }
  return (
    <CompanyDataTable
      headers={['提出日', '提出者', '保有比率', '前回比率', '保有株数', '目的・区分']}
      rows={rows.map((row) => [
        row.submittedAt?.slice(0, 10) ?? row.reportDate ?? '---',
        row.holderName ?? '---',
        formatHoldingRatio(row.holdingRatio),
        formatHoldingRatio(row.previousHoldingRatio),
        fmtShares(row.shares),
        row.purpose ?? row.reportKind ?? '---',
      ])}
      meta={`直近 ${rows.length}件`}
      numericColumns={[0, 2, 3, 4]}
    />
  )
}

function CompanyDataTable({
  headers,
  rows,
  meta,
  numericColumns = [],
}: {
  headers: string[]
  rows: string[][]
  meta: string
  numericColumns?: number[]
}) {
  return (
    <div>
      <div className="mb-2 text-[9px] font-bold text-[var(--color-text-tertiary)]">{meta}</div>
      <div className="overflow-x-auto border border-[var(--color-border-default)]">
        <table className="w-full min-w-[620px] border-collapse text-[10px]">
          <thead className="bg-[var(--color-surface-subtle)] text-[var(--color-text-secondary)]">
            <tr>
              {headers.map((header, index) => (
                <th
                  key={header}
                  className={`border-b border-r border-[var(--color-border-default)] px-2 py-1.5 font-black ${
                    numericColumns.includes(index) ? 'text-right' : 'text-left'
                  }`}
                >
                  {header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, rowIndex) => (
              <tr key={`${row[0]}-${rowIndex}`} className="even:bg-[var(--color-surface-subtle)]">
                {row.map((value, index) => (
                  <td
                    key={`${index}-${value}`}
                    className={`max-w-80 border-b border-r border-[var(--color-border-soft)] px-2 py-1.5 align-top ${
                      numericColumns.includes(index)
                        ? 'whitespace-nowrap text-right font-mono'
                        : index === row.length - 1 ? 'whitespace-normal leading-4' : 'whitespace-nowrap'
                    }`}
                  >
                    {value}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function EdinetEmptyState({
  configured,
  message,
  label,
}: {
  configured: boolean
  message: string | null
  label: string
}) {
  return (
    <CompanyDataEmpty
      label={
        configured
          ? message ?? `${label}の公表データはありません。`
          : `${label}はEDINET APIキー設定後に自動取得されます。`
      }
    />
  )
}

function CompanyDataEmpty({ label }: { label: string }) {
  return (
    <div className="flex min-h-32 items-center justify-center border border-dashed border-[var(--color-border-default)] bg-[var(--color-surface-subtle)] px-4 text-center text-[10px] font-bold leading-5 text-[var(--color-text-secondary)]">
      {label}
    </div>
  )
}

function financialPeriodLabel(period: string | null): string {
  const labels: Record<string, string> = { '1Q': '第1四半期', '2Q': '第2四半期', '3Q': '第3四半期', FY: '通期' }
  return period ? labels[period] ?? period : '最新開示'
}

function financialChange(value: number | null, previous: number | null | undefined): number | null {
  if (value == null || previous == null || previous === 0) return null
  return ((value / previous) - 1) * 100
}

function formatCorporateAmount(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '---'
  const absolute = Math.abs(value)
  if (absolute >= 100_000_000) return `${(value / 100_000_000).toLocaleString('ja-JP', { maximumFractionDigits: 1 })}億円`
  if (absolute >= 10_000) return `${(value / 10_000).toLocaleString('ja-JP', { maximumFractionDigits: 1 })}万円`
  return `${value.toLocaleString('ja-JP', { maximumFractionDigits: 1 })}円`
}

function formatEquityRatio(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '---'
  const percent = Math.abs(value) <= 1 ? value * 100 : value
  return `${percent.toFixed(1)}%`
}

function formatHoldingRatio(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '---'
  const percent = Math.abs(value) <= 1 ? value * 100 : value
  return `${percent.toFixed(2)}%`
}

function MarketSnapshotCard({
  ticker,
  marginInfo,
  fallbackType,
  analysisDate,
  embedded = false,
}: {
  ticker: string
  marginInfo: StockMarginInfo | null
  fallbackType?: string | null
  analysisDate: string | null
  embedded?: boolean
}) {
  const [mobileExpanded, setMobileExpanded] = useState(false)
  const latestMargin = marginInfo?.latest
  const latestMarginHistory = marginInfo?.history?.[0]
  const mobileDetailsId = `market-snapshot-details-${ticker.replace(/[^a-zA-Z0-9_-]/g, '-')}`
  return (
    <div className={embedded ? '' : 'card'} style={embedded ? undefined : marketSnapshotCardStyle}>
      <div className="sm:hidden">
        <div className="flex items-center gap-2">
          <strong className="text-[10px] font-black text-[var(--color-text-primary)]">市場・信用</strong>
          {analysisDate ? (
            <span className="text-[9px] font-bold text-[var(--color-text-tertiary)]">信用残は現在情報のため非表示</span>
          ) : (
            <>
              <MarginBadges
                marginType={latestMargin?.marginType ?? fallbackType}
                creditRatio={latestMargin?.creditRatio ?? null}
                shortRatio={latestMargin?.shortRatio ?? null}
                compact
              />
              <span className="ml-auto font-mono text-[9px] font-bold text-[var(--color-text-secondary)]">
                信用倍率 {latestMargin?.creditRatio == null ? '---' : `${latestMargin.creditRatio.toFixed(2)}倍`}
              </span>
            </>
          )}
        </div>
        {!analysisDate && (
          <div className="mt-1 text-[9px] font-semibold text-[var(--color-text-tertiary)]">
            基準週 {latestMargin?.asOfDate ?? latestMarginHistory?.date ?? '---'}
          </div>
        )}
      </div>
      <div className="mt-2 border-t border-[var(--color-border-soft)] pt-2 sm:mt-0 sm:border-0 sm:pt-0">
        <PerformanceCard ticker={ticker} embedded analysisDate={analysisDate} mobileExpanded={mobileExpanded} />
      </div>
      <button
        type="button"
        className="mt-1 flex min-h-11 w-full items-center border-t border-[var(--color-border-soft)] py-2 text-left text-[10px] font-bold text-[var(--color-brand-700)] sm:hidden"
        aria-expanded={mobileExpanded}
        aria-controls={mobileDetailsId}
        onClick={() => setMobileExpanded((current) => !current)}
      >
        その他の騰落率・信用残
        <ChevronRight size={12} className={`ml-auto transition-transform ${mobileExpanded ? 'rotate-90' : ''}`} aria-hidden="true" />
      </button>
      <div id={mobileDetailsId} className={`${mobileExpanded ? 'block' : 'hidden'} mt-1 sm:mt-0 sm:block`}>
        <div style={marketSnapshotGridStyle}>
          {analysisDate
            ? <CurrentOnlyDataNotice label="信用残は現在情報のため、過去の短期判断には含めていません。" compact />
            : <MarginInfoCard info={marginInfo} fallbackType={fallbackType} embedded />}
        </div>
      </div>
    </div>
  )
}

function CurrentOnlyDataNotice({ label, compact = false }: { label: string; compact?: boolean }) {
  return (
    <div className={`border border-dashed border-[var(--color-border-default)] bg-[var(--color-surface-subtle)] px-3 py-2 text-[10px] font-bold leading-5 text-[var(--color-text-secondary)] ${compact ? 'mt-1' : ''}`}>
      {label}
    </div>
  )
}

function MarginInfoCard({
  info,
  fallbackType,
  embedded = false,
}: {
  info: StockMarginInfo | null
  fallbackType?: string | null
  embedded?: boolean
}) {
  const latest = info?.latest
  const latestHistory = info?.history?.[0]
  return (
    <div className={embedded ? '' : 'card'} style={embedded ? marginEmbeddedStyle : { padding: '12px' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px', marginBottom: '8px' }}>
        <div style={{ fontSize: '11px', fontWeight: 600 }}>貸借/信用</div>
        <MarginBadges
          marginType={latest?.marginType ?? fallbackType}
          creditRatio={latest?.creditRatio ?? null}
          shortRatio={latest?.shortRatio ?? null}
          compact
        />
      </div>
      <div className="mb-1 text-[9px] font-black text-[var(--color-text-tertiary)]">週次信用残</div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: '4px 8px' }}>
        <InfoLine label="基準週" value={latest?.asOfDate ?? latestHistory?.date ?? '---'} />
        <InfoLine label="信用倍率" value={latest?.creditRatio == null ? '---' : `${latest.creditRatio.toFixed(2)}倍`} />
        <InfoLine label="買残" value={fmtShares(latest?.longMargin ?? latestHistory?.longMargin)} />
        <InfoLine label="売残" value={fmtShares(latest?.shortMargin ?? latestHistory?.shortMargin)} />
        <InfoLine label="買残増減" value={fmtChange(latest?.longChange ?? latestHistory?.longChange)} />
        <InfoLine label="売残増減" value={fmtChange(latest?.shortChange ?? latestHistory?.shortChange)} />
      </div>
    </div>
  )
}

const marketSnapshotCardStyle: CSSProperties = {
  padding: '12px',
}

const marketSnapshotGridStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: '10px',
}

const marginEmbeddedStyle: CSSProperties = {
  minWidth: 0,
  borderTop: '1px solid var(--border-subtle)',
  paddingTop: '10px',
}

function InfoLine({ label, value }: { label: string; value: string }) {
  return (
    <div style={{
      display: 'flex',
      justifyContent: 'space-between',
      alignItems: 'baseline',
      padding: '3px 0',
      gap: '8px',
    }}>
      <span style={{ fontSize: '10px', fontWeight: 500, color: 'var(--text-muted)' }}>{label}</span>
      <span style={{ fontFamily: 'var(--font-mono)', fontSize: '11px', fontWeight: 600, color: 'var(--text-primary)', textAlign: 'right' }}>{value}</span>
    </div>
  )
}

type BasicMlSimilar = {
  similarDirection: 'up' | 'down' | null
  similarityScore: number
}

type BasicMlResponse = {
  asOfDate?: string | null
  featureAsOfDate?: string | null
  count?: number
  similars?: BasicMlSimilar[]
  physicsAnalysis?: {
    physicsStatus?: PhysicsStatus | null
    pullbackVerdict?: string | null
    summary?: string | null
    watchPoints?: string[]
    riskNotes?: string[]
  } | null
}

function BasicInfoCard({
  ticker,
  quote,
  analysisDate,
  physical,
  physicalLoading,
  embedded = false,
}: {
  ticker: string
  quote: StockQuote | null
  analysisDate: string | null
  physical: PhysicalMomentumResponse | null
  physicalLoading: boolean
  embedded?: boolean
}) {
  const [latestStage, setLatestStage] = useState<SummaryStageEntry | null>(null)
  const [ml, setMl] = useState<BasicMlResponse | null>(null)
  const [summaryLoading, setSummaryLoading] = useState(true)
  const [showSignalDetails, setShowSignalDetails] = useState(false)

  useEffect(() => {
    let cancelled = false
    const code = ticker.replace(/\.T$/i, '')
    setSummaryLoading(true)

    const stageParams = new URLSearchParams({ granularity: 'daily', count: '1' })
    const mlParams = new URLSearchParams({ ticker: code, limit: '6' })
    if (analysisDate) {
      stageParams.set('startDate', '1900-01-01')
      stageParams.set('endDate', analysisDate)
      mlParams.set('date', analysisDate)
      mlParams.set('fallback', '1')
    }

    Promise.allSettled([
      fetch(`/api/stage-history/${encodeURIComponent(code)}?${stageParams.toString()}`, { cache: 'no-store' }).then((res) => res.ok ? res.json() : null),
      fetch(`/api/ml/current-similars?${mlParams.toString()}`, { cache: 'no-store' }).then((res) => res.ok ? res.json() : null),
    ])
      .then(([stageResult, mlResult]) => {
        if (cancelled) return
        if (stageResult.status === 'fulfilled') {
          const history = Array.isArray(stageResult.value?.history) ? stageResult.value.history : []
          setLatestStage(history[history.length - 1] ?? null)
        } else {
          setLatestStage(null)
        }
        setMl(mlResult.status === 'fulfilled' ? mlResult.value as BasicMlResponse | null : null)
      })
      .finally(() => {
        if (!cancelled) setSummaryLoading(false)
      })

    return () => { cancelled = true }
  }, [analysisDate, ticker])

  const technicals = quote?.technicals
  const macd = technicals?.macd
  const averageVolumeLabel = technicals?.averageVolumeObservationCount &&
    technicals.averageVolumeObservationCount < 30
    ? `${technicals.averageVolumeObservationCount}日平均出来高`
    : '30日平均出来高'
  const macdValue = macd?.relation === 'golden'
    ? 'ゴールデンクロス側'
    : macd?.relation === 'dead'
      ? 'デッドクロス側'
      : macd?.relation === 'neutral'
        ? '中立'
        : '---'
  const macdDetail = macd?.lastCrossDate
    ? `直近${macd.lastCrossType === 'golden' ? 'GC' : 'DC'} ${macd.lastCrossDate}`
    : macd
      ? `MACD ${macd.value.toFixed(2)} / Signal ${macd.signal.toFixed(2)}`
      : '日足データ不足'
  const highDistance = quote?.price != null && quote.fiftyTwoWeekHigh != null && quote.fiftyTwoWeekHigh > 0
    ? ((quote.price / quote.fiftyTwoWeekHigh) - 1) * 100
    : null
  const lowDistance = quote?.price != null && quote.fiftyTwoWeekLow != null && quote.fiftyTwoWeekLow > 0
    ? ((quote.price / quote.fiftyTwoWeekLow) - 1) * 100
    : null
  const items = [
    { label: '時価総額', value: quote?.marketCap != null ? `${(quote.marketCap / 1e8).toLocaleString('ja-JP', { maximumFractionDigits: 0 })} 億円` : '---' },
    { label: '出来高', value: quote?.volume ? quote.volume.toLocaleString('ja-JP') : '---' },
    {
      label: averageVolumeLabel,
      value: technicals?.averageVolume30 != null
        ? `${Math.round(technicals.averageVolume30).toLocaleString('ja-JP')} 株`
        : '---',
      detail: technicals?.asOfDate ? `基準 ${technicals.asOfDate}` : undefined,
    },
    {
      label: 'MACD (12・26・9)',
      value: macdValue,
      detail: macdDetail,
      color: macd?.relation === 'golden'
        ? 'var(--color-market-red)'
        : macd?.relation === 'dead'
          ? 'var(--color-market-blue)'
          : 'var(--text-primary)',
    },
    {
      label: '52週高値',
      value: quote?.fiftyTwoWeekHigh != null ? `¥${quote.fiftyTwoWeekHigh.toLocaleString('ja-JP', { maximumFractionDigits: 1 })}` : '---',
      detail: highDistance == null ? undefined : `高値比 ${fmtPct(highDistance)}`,
    },
    {
      label: '52週安値',
      value: quote?.fiftyTwoWeekLow != null ? `¥${quote.fiftyTwoWeekLow.toLocaleString('ja-JP', { maximumFractionDigits: 1 })}` : '---',
      detail: lowDistance == null ? undefined : `安値比 ${fmtPct(lowDistance)}`,
    },
  ]
  const combinedLoading = summaryLoading || physicalLoading
  const decision = buildBasicDecisionSummary(latestStage, physical, ml, quote)
  const physics = buildBasicPhysicsSummary(ml, summaryLoading)

  return (
    <div className={embedded ? '' : 'card'} style={{ padding: embedded ? 0 : '12px' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: '8px', marginBottom: '10px' }}>
        <div style={{ fontSize: '12px', fontWeight: 700 }}>{embedded ? '市場・テクニカル' : '基本情報'}</div>
        {latestStage?.date && (
          <span style={{ fontSize: '10px', color: 'var(--text-muted)', fontFamily: 'var(--font-mono)', fontWeight: 500 }}>
            基準日 {latestStage.date}
          </span>
        )}
      </div>
      <div className="grid grid-cols-1 gap-x-5 gap-y-1 sm:grid-cols-2">
        {items.map(({ label, value, detail, color }) => (
          <div key={label} className="min-w-0" style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'flex-start',
            padding: '3px 0',
            gap: '8px',
          }}>
            <span style={{ fontSize: '10px', fontWeight: 500, color: 'var(--text-muted)' }}>{label}</span>
            <span style={{ minWidth: 0, textAlign: 'right' }}>
              <span style={{
                display: 'block',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                fontFamily: 'var(--font-mono)',
                fontSize: '11px',
                color: color ?? 'var(--text-primary)',
                fontWeight: color ? 800 : 600,
              }}>
                {value}
              </span>
              {detail && (
                <span style={{
                  display: 'block',
                  marginTop: '1px',
                  fontFamily: 'var(--font-mono)',
                  fontSize: '10px',
                  color: 'var(--text-muted)',
                  whiteSpace: 'nowrap',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                }}>
                  {detail}
                </span>
              )}
            </span>
          </div>
        ))}
      </div>

      <div style={basicStageBlockStyle}>
        <div style={basicSubHeaderStyle}>
          <strong>6ステージ</strong>
          <span>{combinedLoading ? '読込中' : latestStage ? buildStageCode(latestStage) : '未取得'}</span>
        </div>
        {latestStage ? (
          <div style={basicStageGridStyle}>
            {SUMMARY_STAGE_KEYS.map(({ key, label }) => (
              <SixStageCell key={key} label={label} stage={latestStage[key]} />
            ))}
          </div>
        ) : (
          <p style={basicMutedTextStyle}>{combinedLoading ? '最新ステージを確認しています。' : '最新ステージデータがありません。'}</p>
        )}
      </div>

      <div style={basicSignalBlockStyle}>
        <button
          type="button"
          className="flex min-h-11 w-full items-center gap-2 py-2 text-left text-[10px] font-black text-[var(--color-text-primary)] sm:hidden"
          aria-expanded={showSignalDetails}
          aria-controls="basic-signal-details"
          onClick={() => setShowSignalDetails((current) => !current)}
        >
          <span>短期チェック・物理状態</span>
          <span className="ml-auto truncate text-[9px] text-[var(--color-text-tertiary)]">{decision.label} / {physics.label}</span>
          <ChevronRight size={13} className={`shrink-0 transition-transform ${showSignalDetails ? 'rotate-90' : ''}`} aria-hidden="true" />
        </button>
        <div id="basic-signal-details" className={`${showSignalDetails ? 'block' : 'hidden'} sm:block`}>
          <div className="hidden sm:flex" style={basicSignalTitleStyle}>
            <strong>短期チェック・物理状態</strong>
            <span>スクリーナー共通判定</span>
          </div>
          <div style={basicSignalGridStyle}>
          <section
            aria-label="短期チェック"
            style={{ ...basicSignalPaneStyle, borderLeftColor: decision.color, background: decision.background }}
          >
            <div style={basicDecisionHeaderStyle}>
              <span style={basicDecisionLabelStyle}>短期チェック</span>
              <strong style={{ color: decision.color }}>{decision.label}</strong>
              <span style={{ ...basicSignalBadgeStyle, borderColor: decision.border, color: decision.color }}>
                {formatShortTermStrength(decision.label, decision.score)}
              </span>
            </div>
            <p style={basicDecisionDescriptionStyle}>{decision.description}</p>
            <div style={basicReasonRowStyle}>
              {decision.reasons.map((reason) => (
                <span key={reason} style={basicReasonPillStyle}>{reason}</span>
              ))}
            </div>
            {decision.mlText && (
              <div style={basicMlLineStyle}>
                <span>ML類似</span>
                <b>{decision.mlText}</b>
              </div>
            )}
          </section>

          <section
            aria-label="物理状態"
            style={{ ...basicSignalPaneStyle, borderLeftColor: physics.color, background: physics.background }}
          >
            <div style={basicDecisionHeaderStyle}>
              <span style={basicDecisionLabelStyle}>物理状態</span>
              <strong style={{ color: physics.color }}>{physics.label}</strong>
              {physics.pullbackVerdict && (
                <span style={{ ...basicSignalBadgeStyle, borderColor: physics.border, color: physics.color }}>
                  {physics.pullbackVerdict}
                </span>
              )}
            </div>
            <p style={basicDecisionDescriptionStyle}>{physics.description}</p>
            {physics.watchPoint && (
              <div style={basicPhysicsPointStyle}>
                <span>確認点</span>
                <b>{physics.watchPoint}</b>
              </div>
            )}
            <div style={basicMlLineStyle}>
              <span>物理特徴量基準日</span>
              <b>{physics.asOfDate ?? '---'}</b>
            </div>
          </section>
          </div>
        </div>
      </div>
    </div>
  )
}

function SixStageCell({ label, stage }: { label: string; stage: number | null }) {
  const validStage = normalizeStage(stage)
  const color = validStage ? STAGE_BORDER_COLORS[validStage] : 'var(--border-base)'
  const bg = validStage ? STAGE_BG_COLORS[validStage] : 'var(--bg-elevated)'
  const title = validStage ? STAGE_LABELS[validStage] : '未判定'
  return (
    <div title={`${label}: ${title}`} style={{ ...basicStageCellStyle, borderColor: color, background: bg }}>
      <span style={basicStageCellLabelStyle}>{label}</span>
      <strong style={{ ...basicStageCellNumberStyle, color }}>{validStage ?? '-'}</strong>
      <small style={basicStageCellTextStyle}>{validStage ? shortStageLabel(validStage) : '不足'}</small>
    </div>
  )
}

function buildStageCode(row: SummaryStageEntry | null): string {
  if (!row) return '------'
  return SUMMARY_STAGE_KEYS.map(({ key }) => normalizeStage(row[key]) ?? '-').join('')
}

function normalizeStage(stage: number | null | undefined): number | null {
  if (stage == null || !Number.isFinite(stage)) return null
  const rounded = Math.round(stage)
  return rounded >= 1 && rounded <= 6 ? rounded : null
}

function shortStageLabel(stage: number): string {
  if (stage === 1) return '安定上昇'
  if (stage === 2) return '調整'
  if (stage === 3) return '弱気移行'
  if (stage === 4) return '安定下降'
  if (stage === 5) return '反発兆し'
  return '強気初期'
}

function buildBasicDecisionSummary(
  stage: SummaryStageEntry | null,
  physical: PhysicalMomentumResponse | null,
  ml: BasicMlResponse | null,
  quote: StockQuote | null,
) {
  const latestPhysical = physical?.latest ?? null
  const similars = Array.isArray(ml?.similars) ? ml.similars : []
  const upCount = similars.filter((row) => row.similarDirection === 'up').length
  const downCount = similars.filter((row) => row.similarDirection === 'down').length
  const topSimilarity = similars.reduce((max, row) => Math.max(max, Number(row.similarityScore) || 0), 0)
  const check = buildShortTermCheck({
    stages: stage ? {
      dailyA: stage.daily_a_stage,
      dailyB: stage.daily_b_stage,
      weeklyA: stage.weekly_a_stage,
      weeklyB: stage.weekly_b_stage,
      monthlyA: stage.monthly_a_stage,
      monthlyB: stage.monthly_b_stage,
    } : null,
    physicalMomentumScore: latestPhysical?.physicalMomentumScore,
    physicalForceScore: latestPhysical?.physicalForceScore,
    changePercent: quote?.changePercent,
    mlUpCount: upCount,
    mlDownCount: downCount,
    mlSimilarCount: similars.length,
    mlTopSimilarity: topSimilarity || null,
    physicsStatus: ml?.physicsAnalysis?.physicsStatus ?? null,
  })
  const style = shortTermToneStyle(check.tone)

  return {
    ...check,
    ...style,
  }
}

function buildBasicPhysicsSummary(ml: BasicMlResponse | null, loading: boolean) {
  const analysis = ml?.physicsAnalysis ?? null
  const label: PhysicsStatus | '読込中' = loading
    ? '読込中'
    : analysis?.physicsStatus ?? '算出待ち'
  const style = physicsToneStyle(analysis?.physicsStatus ?? '算出待ち')

  return {
    label,
    pullbackVerdict: loading ? null : analysis?.pullbackVerdict ?? null,
    description: loading
      ? '移動平均線の位置、傾き、加速度、乖離の状態を確認しています。'
      : analysis?.summary ?? '物理特徴量が未生成のため、現在の状態を判定できません。',
    watchPoint: loading ? null : analysis?.watchPoints?.[0] ?? analysis?.riskNotes?.[0] ?? null,
    asOfDate: ml?.featureAsOfDate ?? ml?.asOfDate ?? null,
    ...style,
  }
}

function shortTermToneStyle(tone: ShortTermCheckTone) {
  if (tone === 'bullish') {
    return { color: 'var(--price-up)', border: 'rgba(22, 163, 74, 0.32)', background: 'rgba(22, 163, 74, 0.07)' }
  }
  if (tone === 'positive') {
    return { color: '#0f766e', border: 'rgba(20, 184, 166, 0.3)', background: 'rgba(20, 184, 166, 0.07)' }
  }
  if (tone === 'bearish') {
    return { color: 'var(--price-down)', border: 'rgba(37, 99, 235, 0.3)', background: 'rgba(37, 99, 235, 0.07)' }
  }
  if (tone === 'weak') {
    return { color: '#1d4ed8', border: 'rgba(37, 99, 235, 0.24)', background: 'rgba(37, 99, 235, 0.06)' }
  }
  return { color: 'var(--text-secondary)', border: 'var(--border-subtle)', background: 'var(--bg-elevated)' }
}

function physicsToneStyle(status: PhysicsStatus) {
  const tone = physicsStatusTone(status)
  if (tone === 'red') {
    return { color: 'var(--color-market-red)', border: 'rgba(220, 38, 38, 0.3)', background: 'rgba(220, 38, 38, 0.055)' }
  }
  if (tone === 'blue') {
    return { color: 'var(--price-down)', border: 'rgba(37, 99, 235, 0.3)', background: 'rgba(37, 99, 235, 0.055)' }
  }
  if (tone === 'amber') {
    return { color: '#b45309', border: 'rgba(217, 119, 6, 0.3)', background: 'rgba(245, 158, 11, 0.07)' }
  }
  return { color: 'var(--text-secondary)', border: 'var(--border-subtle)', background: 'var(--bg-elevated)' }
}

const basicStageBlockStyle: CSSProperties = {
  marginTop: '12px',
  paddingTop: '12px',
  borderTop: '1px solid var(--border-subtle)',
}

const basicSubHeaderStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'baseline',
  justifyContent: 'space-between',
  gap: '8px',
  marginBottom: '8px',
  color: 'var(--text-primary)',
  fontSize: '11px',
}

const basicStageGridStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(6, minmax(0, 1fr))',
  gap: '5px',
}

const basicStageCellStyle: CSSProperties = {
  minWidth: 0,
  border: '1px solid var(--border-subtle)',
  borderRadius: '6px',
  padding: '6px 3px',
  display: 'grid',
  justifyItems: 'center',
  gap: '1px',
}

const missingPriceNoticeStyle: CSSProperties = {
  padding: '10px 12px',
  borderColor: 'rgba(245, 158, 11, 0.34)',
  background: 'rgba(245, 158, 11, 0.10)',
  color: '#92400e',
  fontSize: '12px',
  fontWeight: 700,
  lineHeight: 1.6,
}

const basicStageCellLabelStyle: CSSProperties = {
  color: 'var(--text-muted)',
  fontSize: '9px',
  fontWeight: 800,
  lineHeight: 1,
}

const basicStageCellNumberStyle: CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: '16px',
  lineHeight: 1.05,
}

const basicStageCellTextStyle: CSSProperties = {
  maxWidth: '100%',
  color: 'var(--text-secondary)',
  fontSize: '9px',
  fontWeight: 700,
  lineHeight: 1.15,
  textAlign: 'center',
  whiteSpace: 'normal',
  wordBreak: 'keep-all',
}

const basicMutedTextStyle: CSSProperties = {
  margin: 0,
  color: 'var(--text-muted)',
  fontSize: '10px',
  lineHeight: 1.5,
}

const basicSignalBlockStyle: CSSProperties = {
  marginTop: '12px',
  paddingTop: '12px',
  borderTop: '1px solid var(--border-subtle)',
}

const basicSignalTitleStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'baseline',
  justifyContent: 'space-between',
  gap: '8px',
  marginBottom: '6px',
  color: 'var(--text-primary)',
  fontSize: '11px',
}

const basicSignalGridStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(min(220px, 100%), 1fr))',
  gap: '8px',
}

const basicSignalPaneStyle: CSSProperties = {
  minWidth: 0,
  borderLeft: '2px solid var(--border-subtle)',
  padding: '8px 10px',
}

const basicSignalBadgeStyle: CSSProperties = {
  marginLeft: 'auto',
  maxWidth: '48%',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  padding: '2px 7px',
  borderRadius: '999px',
  border: '1px solid var(--border-subtle)',
  background: 'rgba(255,255,255,0.72)',
  fontSize: '9px',
  fontFamily: 'var(--font-mono)',
  fontWeight: 900,
  whiteSpace: 'nowrap',
}

const basicDecisionHeaderStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'baseline',
  justifyContent: 'space-between',
  gap: '8px',
}

const basicDecisionLabelStyle: CSSProperties = {
  color: 'var(--text-muted)',
  fontSize: '10px',
  fontWeight: 800,
}

const basicDecisionDescriptionStyle: CSSProperties = {
  margin: '6px 0 0',
  color: 'var(--text-secondary)',
  fontSize: '10px',
  lineHeight: 1.55,
  fontWeight: 650,
}

const basicReasonRowStyle: CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  gap: '4px',
  marginTop: '7px',
}

const basicReasonPillStyle: CSSProperties = {
  border: '1px solid var(--border-subtle)',
  borderRadius: '999px',
  background: '#fff',
  color: 'var(--text-secondary)',
  padding: '2px 6px',
  fontSize: '9px',
  fontWeight: 800,
}

const basicMlLineStyle: CSSProperties = {
  marginTop: '7px',
  display: 'flex',
  justifyContent: 'space-between',
  gap: '8px',
  borderTop: '1px solid var(--border-subtle)',
  paddingTop: '6px',
  color: 'var(--text-muted)',
  fontSize: '10px',
}

const basicPhysicsPointStyle: CSSProperties = {
  marginTop: '7px',
  display: 'grid',
  gridTemplateColumns: 'auto minmax(0, 1fr)',
  gap: '6px',
  alignItems: 'start',
  color: 'var(--text-muted)',
  fontSize: '9px',
  lineHeight: 1.45,
}
