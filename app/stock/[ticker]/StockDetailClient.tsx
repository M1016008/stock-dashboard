// app/stock/[ticker]/StockDetailClient.tsx
'use client'

import Link from 'next/link'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'
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
import { FinancialPerformanceTimeline } from '@/components/stock/FinancialPerformanceTimeline'
import { StockDecisionSummary } from '@/components/stock/StockDecisionSummary'
import { StockLargeHolders } from '@/components/large-holders/StockLargeHolders'
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
                <div className="mt-1 text-[9px] font-bold text-[var(--color-text-tertiary)]">過去終値を読み込み中</div>
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
          analysisParamsReady={analysisParamsReady}
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
          <ScenarioProjectionChart
            ticker={ticker}
            name={name}
            analysisDate={analysisDate}
            showActual={showActual}
            onUseLatest={() => updateAnalysisDate(null)}
          />
          <StockMovePeriods ticker={ticker} analysisDate={analysisDate} />
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
  /** buildMaFieldInsight の color(表示専用。未設定なら中立色) */
  maColor?: string | null
  maAngles?: MaAngleSet | null
  /** buildMaFieldInsight の角度幅と前回比(表示専用) */
  maSpreadDeg?: number | null
  maSpreadChangeDeg?: number | null
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

const STAGE_TIMEFRAME_LABELS = ['日足', '週足', '月足'] as const

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

  const chartHeight = useChartHeight()

  // 読み順: 現在の状態(結論) → チャート → 根拠(MA・スコア・Stage) → Stage変遷 → 月足MA → Physical Momentum → 指標の見方
  return (
    <div className="space-y-3 pb-6 sm:space-y-4" aria-label="チャート・6ステージ分析">
      <section className="border border-[var(--color-border-default)] bg-white" aria-labelledby="main-chart-title" data-section="Price &amp; moving averages">
        <TechnicalChartSnapshot
          stage={stageSnapshot}
          momentum={momentumSnapshot}
          analysisDate={analysisDate}
          chart={(
            <>
              <h2 id="main-chart-title" className="m-0 mb-2 text-[14px] font-bold text-[var(--color-text-primary)]">価格と移動平均</h2>
              <CandlestickChart
                ticker={ticker}
                interval="D"
                height={chartHeight}
                historyPeriod="all"
                showTimeframeSelector
                toolbarVariant="segmented"
                summaryVariant="strip"
                maLinesByInterval={{ M: [3, 5, 10, 15, 20, 25] }}
                analysisDate={analysisDate}
                revealAfterAnalysis={showActual}
              />
            </>
          )}
        />
      </section>

      <StageTimeline
        ticker={ticker}
        analysisDate={analysisDate}
        onSnapshotChange={handleStageSnapshot}
      />

      <div id="chart-long-term" className="scroll-mt-28">
        <Ma25mMonitorSummary ticker={ticker} analysisDate={analysisDate} />
      </div>

      <PhysicalMomentumSection
        ticker={ticker}
        analysisDate={analysisDate}
        onSnapshotChange={handleMomentumSnapshot}
      />

      <TechnicalSnapshotGuide momentum={momentumSnapshot} />
    </div>
  )
}

/** チャート高さは画面幅に合わせる(狭い画面でローソクが十分見え、広い画面で縦に伸びすぎない)。表示専用 */
function useChartHeight(): number {
  const [height, setHeight] = useState(460)
  useEffect(() => {
    const phone = window.matchMedia('(max-width: 480px)')
    const tablet = window.matchMedia('(max-width: 1023px)')
    const wide = window.matchMedia('(min-width: 1280px)')
    const update = () => setHeight(phone.matches ? 320 : tablet.matches ? 400 : wide.matches ? 480 : 460)
    update()
    const lists = [phone, tablet, wide]
    lists.forEach((list) => list.addEventListener('change', update))
    return () => lists.forEach((list) => list.removeEventListener('change', update))
  }, [])
  return height
}

function TechnicalChartSnapshot({
  stage,
  momentum,
  analysisDate,
  chart,
}: {
  stage: StageTimelineSnapshot
  momentum: TechnicalMomentumSnapshot
  analysisDate: string | null
  chart: ReactNode
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
    ? '6ステージを読み込み中'
    : stage.status === 'error'
      ? `6ステージを取得できませんでした(${stage.message ?? '詳細不明'})`
      : stage.status === 'missing'
        ? stage.message ?? '6ステージの履歴がありません'
        : '6ステージの値を取得できませんでした'
  const momentumReady = momentum.status === 'available'
  const stateColor = momentumReady ? momentum.maColor ?? 'var(--text-muted)' : 'var(--text-muted)'
  const stateTitle = momentumReady
    ? momentum.maStructure ?? 'MA力場は未判定'
    : momentum.status === 'loading'
      ? '読み込み中'
      : momentum.status === 'error'
        ? 'MA力場を取得できませんでした'
        : 'MA力場は未算出'
  const stateDescription = momentumReady
    ? momentum.maDescription
    : momentum.status === 'loading'
      ? '移動平均の角度を読み込んでいます。'
      : momentum.message ?? '移動平均の角度から状態を判定できませんでした。'

  // 結論(全幅) → チャート ┬ 根拠レール(MA・3スコア) → 6ステージ(全幅の1帯)。DOM順=読み順。
  // xl のレールにはMAと3スコアだけを置き、チャート列との高さ差で余白が生まれないよう6ステージは列の外に出す。各ブロックは内容なりの高さ
  return (
    <section className="bg-white" aria-labelledby="technical-snapshot-title" data-section="Technical snapshot" data-stage-code={stageCode}>
      <div className="space-y-3 p-3 sm:p-4">
        <TechnicalStateHero color={stateColor} title={stateTitle} description={stateDescription} />
        <div className="grid items-start gap-3 xl:grid-cols-[minmax(0,1fr)_minmax(400px,440px)] xl:gap-x-5">
          <div className="min-w-0">{chart}</div>
          <div className="min-w-0">
            <div className="mb-2 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
              <h2 id="technical-snapshot-title" className="m-0 text-[14px] font-bold text-[var(--color-text-primary)]">現在の技術構造</h2>
              <span className="font-mono text-[11px] font-medium text-[var(--color-text-tertiary)]">{referenceDateLabel}</span>
            </div>
            <div className="grid gap-3 lg:grid-cols-2 xl:grid-cols-1">
              <TechnicalMaEvidence momentum={momentum} />
              <TechnicalScorePanel momentum={momentum} className="border-t border-[var(--color-border-soft)] pt-3 lg:border-l lg:border-t-0 lg:pl-4 lg:pt-0 xl:border-l-0 xl:border-t xl:pl-0 xl:pt-3" />
            </div>
          </div>
        </div>
        <TechnicalStageMap stage={stage} stageCode={stageCode} stageMessage={stageMessage} />
      </div>
    </section>
  )
}

type MaSignal = 'up' | 'down' | 'flat'

/** Current State(buildMaFieldInsight)と同じ ±MA_FIELD_THRESHOLD_DEG で向きを分ける */
function maSignalOf(deg: number | null | undefined): MaSignal | null {
  if (deg == null || !Number.isFinite(deg)) return null
  if (deg > MA_FIELD_THRESHOLD_DEG) return 'up'
  if (deg < -MA_FIELD_THRESHOLD_DEG) return 'down'
  return 'flat'
}

function maSignalColor(signal: MaSignal | null): string {
  if (signal === 'up') return 'var(--price-up)'
  if (signal === 'down') return 'var(--price-down)'
  return signal === 'flat' ? 'var(--text-secondary)' : 'var(--text-muted)'
}

function maSignalGlyph(signal: MaSignal | null): string {
  if (signal === 'up') return '↗'
  if (signal === 'down') return '↘'
  return signal === 'flat' ? '→' : '—'
}

/** 本数・平均は maFieldInputs、多数派と逆向きの判定は同じ MA_FIELD_THRESHOLD_DEG を再利用する */
function summarizeMaEvidence(angles: MaAngleSet) {
  const inputs = maFieldInputs(angles)
  const majority: 'up' | 'down' | null = inputs.up > inputs.down ? 'up' : inputs.down > inputs.up ? 'down' : null
  const contrary = MA_ANGLE_KEYS.filter(({ key }) => {
    const signal = maSignalOf(angles[key])
    return majority != null && signal != null && signal !== 'flat' && signal !== majority
  })
  return { inputs, majority, contrary, flat: inputs.total - inputs.up - inputs.down }
}

/** このページ唯一の主結論(20px)。他の結論(運動状態など)は15px以下にして競合させない */
function TechnicalStateHero({ color, title, description }: { color: string; title: string; description: string | null }) {
  const glyph = color === 'var(--price-up)' ? '↗' : color === 'var(--price-down)' ? '↘' : color === 'var(--text-secondary)' ? '→' : '—'
  return (
    <div
      className="flex min-w-0 items-start gap-3 border border-[var(--color-border-soft)] bg-white px-3 py-2"
      style={{ borderLeftWidth: 3, borderLeftColor: color }}
      data-technical-current-state
    >
      <span aria-hidden="true" className="flex h-9 w-9 shrink-0 items-center justify-center text-[28px] font-extrabold leading-none" style={{ color }}>{glyph}</span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-x-2 text-[11px] font-bold text-[var(--color-text-tertiary)]">
          <span>現在の状態 ・ MA力場</span>
          <span className="font-medium">移動平均の角度から判定</span>
        </div>
        {/* 広い画面では結論と説明を1行に並べ、狭い画面では説明が結論の下に回る */}
        <div className="mt-0.5 flex flex-wrap items-baseline gap-x-4 gap-y-0.5">
          <h3 className="m-0 text-[20px] font-extrabold leading-tight [text-wrap:pretty]" style={{ color }}>{title}</h3>
          {description && <p className="m-0 min-w-0 flex-1 basis-[22rem] text-[12px] font-medium leading-5 text-[var(--color-text-secondary)] [text-wrap:pretty]">{description}</p>}
        </div>
      </div>
    </div>
  )
}

const TECHNICAL_MA_GROUPS = [
  { title: '短期', caption: '5・25MA', keys: ['ma5', 'ma25'], avg: 'shortAvg' },
  { title: '長期', caption: '75・200MA', keys: ['ma75', 'ma200'], avg: 'longAvg' },
] as const

/** 角度どおりに傾けた矢印(表示専用。破線は水平) */
function MaTiltArrow({ deg, color }: { deg: number | null; color: string }) {
  if (deg == null) return <span aria-hidden="true" className="w-7 text-center font-mono text-[14px] font-black" style={{ color }}>—</span>
  const tilt = Math.max(-75, Math.min(75, deg))
  return (
    <svg aria-hidden="true" focusable="false" width="28" height="24" viewBox="0 0 28 24" className="shrink-0 overflow-visible">
      <line x1="1" y1="12" x2="27" y2="12" stroke="var(--color-border-default)" strokeWidth="1" strokeDasharray="2 2" />
      <g transform={`rotate(${-tilt} 14 12)`} stroke={color} fill={color}>
        <line x1="4" y1="12" x2="21" y2="12" strokeWidth="2" strokeLinecap="round" />
        <path d="M27 12 L19 7.5 L19 16.5 Z" stroke="none" />
      </g>
    </svg>
  )
}

function TechnicalMaEvidence({ momentum, className = '' }: { momentum: TechnicalMomentumSnapshot; className?: string }) {
  const angles = momentum.maAngles ?? null
  const evidence = angles ? summarizeMaEvidence(angles) : null
  const statusNote = momentum.status === 'loading'
    ? 'MAの角度を読み込み中'
    : momentum.status === 'error'
      ? `MAの角度を取得できませんでした${momentum.message ? `(${momentum.message})` : ''}`
      : momentum.status === 'missing'
        ? momentum.message ?? 'MAの角度は未算出です'
        : 'MAの角度を表示できません'

  const spreadChange = momentum.maSpreadChangeDeg ?? null
  const spread = momentum.maSpreadDeg ?? null

  return (
    <section className={`min-w-0 ${className}`} aria-labelledby="technical-ma-evidence-title" data-technical-ma-evidence>
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <h3 id="technical-ma-evidence-title" className="m-0 text-[12px] font-bold text-[var(--color-text-primary)]">MAの傾き</h3>
        <span className="text-[11px] font-medium text-[var(--color-text-tertiary)]">この銘柄自身の絶対角度</span>
        {spread != null && (
          <span className="ml-auto font-mono text-[11px] font-semibold text-[var(--color-text-secondary)]" title="4本のMA角度の最大と最小の差。前回比は直前の営業日との差です">
            角度幅 <b className="text-[var(--color-text-primary)]">{spread.toFixed(1)}°</b>
            {spreadChange != null && <> 前回比 <b className="text-[var(--color-text-primary)]">{fmtDeg(spreadChange)}</b>({spreadChange > 0 ? '拡大' : spreadChange < 0 ? '縮小' : '不変'})</>}
          </span>
        )}
      </div>
      {evidence ? (
        <p className="m-0 mt-1 text-[12px] font-semibold leading-5 text-[var(--color-text-primary)]">
          {evidence.inputs.total}本のMAのうち、上向き<b className="font-mono" style={{ color: 'var(--price-up)' }}>{evidence.inputs.up}</b>本・下向き<b className="font-mono" style={{ color: 'var(--price-down)' }}>{evidence.inputs.down}</b>本
          <span className="font-medium text-[var(--color-text-tertiary)]">(±{MA_FIELD_THRESHOLD_DEG}°超)</span>
          {evidence.flat > 0 && <span className="font-medium text-[var(--color-text-secondary)]">・横ばい{evidence.flat}本</span>}
          {evidence.contrary.length > 0 && evidence.majority && (
            <>。<b>{evidence.contrary.map(({ label }) => label).join('・')}</b>は多数派({evidence.majority === 'up' ? '上向き' : '下向き'})と逆向き</>
          )}
        </p>
      ) : (
        <p className="m-0 mt-1 text-[11px] font-medium leading-5 text-[var(--color-text-tertiary)]">{statusNote}</p>
      )}
      <div className="mt-2 space-y-2">
        {TECHNICAL_MA_GROUPS.map((group) => {
          const avg = evidence ? evidence.inputs[group.avg] : null
          const avgSignal = maSignalOf(avg)
          const avgColor = maSignalColor(avgSignal)
          return (
            <div key={group.title} role="group" aria-label={`${group.title}(${group.caption})`} className="min-w-0">
              <div className="flex items-baseline justify-between gap-2">
                <span className="text-[11px] font-bold text-[var(--color-text-secondary)]">
                  {group.title} <span className="font-mono font-medium text-[var(--color-text-tertiary)]">{group.caption}</span>
                </span>
                <span className="whitespace-nowrap font-mono text-[11px] font-bold tabular-nums" style={{ color: avgColor }}>
                  <span className="font-sans font-medium text-[var(--color-text-tertiary)]">平均 </span>
                  <span aria-hidden="true">{maSignalGlyph(avgSignal)} </span>{fmtDeg(avg)}
                </span>
              </div>
              <div role="list" className="mt-0.5 divide-y divide-[var(--color-border-soft)]">
                {group.keys.map((key) => {
                  const label = MA_ANGLE_KEYS.find((item) => item.key === key)?.label ?? key
                  const deg = angles?.[key] ?? null
                  const color = angleDirectionColor(deg)
                  const word = angleDirectionLabel(deg)
                  const isContrary = evidence?.contrary.some((item) => item.key === key) ?? false
                  return (
                    <div
                      key={key}
                      role="listitem"
                      aria-label={`${label} ${word}${deg == null ? '' : ` ${fmtDeg(deg)}`}${isContrary ? ' 多数派と逆向き' : ''}`}
                      className="grid min-w-0 grid-cols-[4.75rem_minmax(0,1fr)_3.75rem_3.5rem] items-center gap-x-2 py-1 sm:grid-cols-[5.5rem_1.75rem_minmax(0,1fr)_3.75rem_3.5rem]"
                      title={`${label} ${word}${deg == null ? '' : ` ${fmtDeg(deg)}`}。矢印は角度どおりの傾きで、チャート上の見た目の傾きとは異なります`}
                    >
                      <span className="flex min-w-0 flex-wrap items-center gap-x-1 text-[12px] font-bold text-[var(--color-text-secondary)]">
                        {label}
                        {isContrary && <span className="border border-dashed border-[var(--color-text-secondary)] px-1 text-[11px] font-bold leading-4 text-[var(--color-text-primary)]">逆向き</span>}
                      </span>
                      <span className="flex justify-center max-sm:hidden"><MaTiltArrow deg={deg} color={color} /></span>
                      <MaAngleBar deg={deg} color={color} />
                      <strong className="whitespace-nowrap text-right font-mono text-[13px] font-bold tabular-nums" style={{ color }}>{deg == null ? '—' : fmtDeg(deg)}</strong>
                      <span className="whitespace-nowrap text-[11px] font-semibold" style={{ color }}>{word}</span>
                    </div>
                  )
                })}
              </div>
            </div>
          )
        })}
      </div>
      <p className="m-0 mt-1.5 text-[11px] font-medium leading-4 text-[var(--color-text-tertiary)]">
        バーは±{MA_BAR_SCALE_DEG}°で頭打ち ・ 縦線=±{MA_STRONG_DEG}°(強)
      </p>
    </section>
  )
}

const MA_BAR_SCALE_DEG = 45
const MA_STRONG_DEG = 3

/** 角度の正負・大きさを0中心で示す表示専用バー。±MA_STRONG_DEG(「強」の表示基準)に縦線を引く。強い側は濃く、弱い側は淡く塗る */
function MaAngleBar({ deg, color }: { deg: number | null; color: string }) {
  const numeric = deg != null && Number.isFinite(deg) ? deg : null
  const valid = numeric != null
  const ratio = numeric != null ? Math.min(1, Math.abs(numeric) / MA_BAR_SCALE_DEG) : 0
  const strong = numeric != null && Math.abs(numeric) >= MA_STRONG_DEG
  const tick = (MA_STRONG_DEG / MA_BAR_SCALE_DEG) * 50
  return (
    <span aria-hidden="true" className="relative block h-3 min-w-0 bg-[var(--color-surface-subtle)]">
      {valid && ratio > 0 && (
        <span
          className="absolute inset-y-0"
          style={{
            width: `${Math.max(2, ratio * 50)}%`,
            ...((numeric ?? 0) < 0 ? { right: '50%' } : { left: '50%' }),
            background: color,
            opacity: strong ? 1 : 0.45,
          }}
        />
      )}
      <span className="absolute inset-y-0 w-px bg-black/20" style={{ left: `${50 - tick}%` }} />
      <span className="absolute inset-y-0 w-px bg-black/20" style={{ left: `${50 + tick}%` }} />
      <span className="absolute inset-y-[-2px] left-1/2 w-px bg-[var(--color-border-strong)]" />
    </span>
  )
}

/** 既存の6軸の値だけから、最頻ステージと多数派から異なる軸を表示用に集約する */
function summarizeStageAxes(stages: NonNullable<StageTimelineSnapshot['stages']>) {
  const known = CHART_STAGE_AXES.flatMap(({ key, label }) => {
    const value = stages[key]
    return value == null ? [] : [{ label, value }]
  })
  if (known.length === 0) return null
  const counts: Record<number, number> = {}
  known.forEach(({ value }) => { counts[value] = (counts[value] ?? 0) + 1 })
  const ranked = Object.entries(counts)
    .map(([value, count]) => [Number(value), count] as const)
    .sort((a, b) => b[1] - a[1] || a[0] - b[0])
  const [topStage, topCount] = ranked[0]
  const tied = ranked.length > 1 && ranked[1][1] === topCount
  return {
    known: known.length,
    ranked,
    topStage,
    topCount,
    tied,
    exceptions: tied ? [] : known.filter(({ value }) => value !== topStage),
  }
}

function TechnicalStageMap({
  stage,
  stageCode,
  stageMessage,
  className = '',
}: {
  stage: StageTimelineSnapshot
  stageCode: string
  stageMessage: string
  className?: string
}) {
  const summary = stage.stages ? summarizeStageAxes(stage.stages) : null
  const missingCount = summary ? CHART_STAGE_AXES.length - summary.known : 0
  return (
    <section className={`min-w-0 border-t border-[var(--color-border-soft)] pt-3 ${className}`} aria-labelledby="technical-stage-title" data-technical-stage-map>
      <div className="flex flex-wrap items-baseline gap-x-4 gap-y-0.5">
      <h3 id="technical-stage-title" className="m-0 text-[12px] font-bold text-[var(--color-text-primary)]">
        6ステージ <span className="text-[11px] font-medium text-[var(--color-text-tertiary)]">日・週・月のMAの並び(短期→長期)</span>
      </h3>
      {summary ? (
        <p className="m-0 text-[12px] font-semibold leading-5 text-[var(--color-text-primary)]">
          {summary.tied ? (
            <>{summary.ranked.map(([value, count]) => `S${value} ${STAGE_LABELS[value]} ${count}軸`).join('・')}に分かれています</>
          ) : summary.exceptions.length === 0 ? (
            <>{summary.known}軸すべてが S{summary.topStage} {STAGE_LABELS[summary.topStage]}</>
          ) : (
            <>
              {summary.known}軸中{summary.topCount}軸が S{summary.topStage} {STAGE_LABELS[summary.topStage]}
              <span className="font-medium text-[var(--color-text-secondary)]">
                ・多数派と異なる軸 {summary.exceptions.map(({ label, value }) => `${label} S${value} ${STAGE_LABELS[value]}`).join('・')}
              </span>
            </>
          )}
          {missingCount > 0 && <span className="font-medium text-[var(--color-text-tertiary)]">・未取得{missingCount}軸</span>}
        </p>
      ) : (
        <p className="m-0 text-[11px] font-medium leading-5 text-[var(--color-text-tertiary)]">{stageMessage}</p>
      )}
      </div>
      <div className="mt-2 grid grid-cols-3 gap-1.5 sm:gap-2" aria-label={`6ステージ ${stageCode}`}>
        {[0, 2, 4].map((start) => (
          <div key={start} role="group" aria-label={STAGE_TIMEFRAME_LABELS[start / 2]} className="min-w-0">
            <span className="mb-1 block text-[11px] font-bold text-[var(--color-text-secondary)]">{STAGE_TIMEFRAME_LABELS[start / 2]}</span>
            <div role="list" className="grid grid-cols-1 gap-1 sm:grid-cols-2">
              {CHART_STAGE_AXES.slice(start, start + 2).map(({ key, label }) => {
                const value = stage.stages?.[key] ?? null
                const isException = value != null && summary != null && summary.exceptions.some((item) => item.label === label)
                return (
                  <div
                    key={key}
                    role="listitem"
                    aria-label={value ? `${label} S${value} ${STAGE_LABELS[value]}${isException ? ' 多数派と異なる軸' : ''}` : `${label} 未取得`}
                    data-stage-axis={label}
                    className="flex min-w-0 flex-wrap items-baseline justify-center gap-x-1.5 border px-1.5 py-1 text-center leading-tight"
                    style={{
                      background: value ? STAGE_BG_COLORS[value] : 'var(--color-surface-subtle)',
                      borderColor: value ? STAGE_BORDER_COLORS[value] : 'var(--color-border-default)',
                      borderWidth: isException ? 2 : 1,
                      borderStyle: isException ? 'dashed' : 'solid',
                    }}
                    title={value ? `${label} S${value}: ${STAGE_LABELS[value]}` : stageMessage}
                  >
                    <span className="text-[11px] font-bold text-[var(--color-text-tertiary)]">{label}</span>
                    <strong className="font-mono text-[14px] leading-tight text-[var(--color-text-primary)]">{value ? `S${value}` : '—'}</strong>
                    {isException && <b className="text-[11px] font-bold text-[var(--color-text-primary)]">異なる軸</b>}
                    {value && <span className="break-words text-[11px] font-semibold leading-tight text-[var(--color-text-secondary)]">{STAGE_LABELS[value]}</span>}
                  </div>
                )
              })}
            </div>
          </div>
        ))}
      </div>
      {stage.status !== 'available' && summary && <div className="mt-1 text-[11px] font-medium text-[var(--color-text-tertiary)]">{stageMessage}</div>}
    </section>
  )
}

const TECHNICAL_SCORE_ROWS = [
  { kind: 'pms', code: 'PMS', label: '総合の強さ', neutral: false },
  { kind: 'pfs', code: 'PFS', label: '足元の力の向き', neutral: false },
  { kind: 'pes', code: 'PES', label: '値動きの熱量', neutral: true },
] as const

function TechnicalScorePanel({ momentum, className = '' }: { momentum: TechnicalMomentumSnapshot; className?: string }) {
  const values = { pms: momentum.pms, pfs: momentum.pfs, pes: momentum.pes }
  const statusDetail = momentum.status === 'loading' ? '読み込み中' : momentum.status === 'error' ? '取得できません' : '未算出'
  const rowGrid = 'grid-cols-[6.5rem_minmax(0,1fr)]'
  return (
    <section className={`min-w-0 ${className}`} aria-labelledby="technical-score-title" data-technical-scores>
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <h3 id="technical-score-title" className="m-0 text-[12px] font-bold text-[var(--color-text-primary)]">3スコア</h3>
        <span className="text-[11px] font-medium text-[var(--color-text-tertiary)]">市場全体との差(日足)</span>
      </div>
      <div className="mt-2 space-y-1">
        <div className={`grid gap-x-2 ${rowGrid}`} aria-hidden="true">
          <span />
          <span className="grid grid-cols-[auto_minmax(0,1fr)_auto] pr-[3.25rem] font-mono text-[11px] font-medium text-[var(--color-text-tertiary)]" title="バーは-2.5〜+2.5で頭打ちです">
            <span className="whitespace-nowrap">-2.5</span>
            <span className="whitespace-nowrap text-center">0=市場平均</span>
            <span className="whitespace-nowrap">+2.5</span>
          </span>
        </div>
        {TECHNICAL_SCORE_ROWS.map(({ kind, code, label, neutral }) => {
          const value = values[kind]
          const marks = PHYSICAL_BOUNDARIES.find((item) => item.code === code)?.marks ?? []
          return (
            <div
              key={code}
              className={`grid min-w-0 items-center gap-x-2 gap-y-0.5 ${rowGrid}`}
              data-score={code}
              title={momentum.status === 'available' ? `${label} ${code} ・ 判定境界まで ${nearestBoundaryText(value, marks)}` : undefined}
            >
              <span className="min-w-0 leading-tight">
                <span className="block text-[12px] font-bold text-[var(--color-text-primary)]">{label}</span>
                <span className="font-mono text-[11px] font-medium text-[var(--color-text-tertiary)]">{code}</span>
              </span>
              <ScoreThresholdBar label={`${label} ${code}`} value={value} text={formatDelta(value)} neutral={neutral} marks={marks} />
              <span className="col-start-2 text-[11px] font-medium leading-4 text-[var(--color-text-secondary)]">
                {momentum.status === 'available' ? describePhysicalScore(kind, value) : statusDetail}
              </span>
            </div>
          )
        })}
      </div>
      <p className="m-0 mt-1.5 text-[11px] font-medium leading-4 text-[var(--color-text-tertiary)]">
        縦線=判定の境界({PHYSICAL_BOUNDARIES.map(({ code, marks }) => `${code} ${marks.map(formatDelta).join('/')}`).join(' ・ ')})。熱量(PES)は方向ではなく活動量です。
      </p>
      {momentum.status !== 'available' ? (
        <div className="mt-1 text-[11px] font-medium text-[var(--color-text-tertiary)]">
          {momentum.status === 'loading' ? 'PMS/PFS/PESを読み込み中' : momentum.message ?? 'PMS/PFS/PESは表示できません'}
        </div>
      ) : (momentum.message || (momentum.isScoreFresh === false && momentum.scoreDate)) && (
        <div className="mt-1 text-[11px] font-medium text-[var(--color-text-tertiary)]">
          {momentum.message ?? `スコア算出日 ${momentum.scoreDate}`}
        </div>
      )}
    </section>
  )
}

/**
 * 3スコア共通の0中心バー(±2.5で頭打ち)。判定の境界(marks)に縦線を引き、境界を越えた側は濃く塗る。
 * 方向を持たない量(neutral=PES)は上昇/下落色ではなくスレートで描く。表示専用。
 */
function ScoreThresholdBar({
  value,
  text,
  label,
  neutral = false,
  marks = [],
}: {
  value: number | null | undefined
  text: string
  label: string
  neutral?: boolean
  marks?: number[]
}) {
  const numeric = value != null && Number.isFinite(value) ? value : null
  const valid = numeric != null
  const ratio = numeric != null ? Math.min(1, Math.abs(numeric) / 2.5) : 0
  const negative = numeric != null && numeric < 0
  const color = neutral ? 'var(--color-price-flat)' : negative ? 'var(--price-down)' : 'var(--price-up)'
  const crossed = numeric != null && marks.some((mark) => (mark > 0 ? numeric >= mark : numeric <= mark))
  const at = (point: number) => `${((Math.max(-2.5, Math.min(2.5, point)) + 2.5) / 5) * 100}%`
  return (
    <span className="grid min-w-0 grid-cols-[minmax(28px,1fr)_3.25rem] items-center gap-2" title={`${label} ${text}`}>
      <span
        className="relative block h-3 bg-[var(--color-surface-subtle)]"
        role="img"
        aria-label={`${label} ${text}(-2.5〜+2.5の目盛り${marks.length > 0 ? `、判定境界 ${marks.map(formatDelta).join('と')}` : ''})`}
      >
        {valid && ratio > 0 && (
          <span
            className="absolute inset-y-0"
            style={{
              width: `${Math.max(2, ratio * 50)}%`,
              ...(negative ? { right: '50%' } : { left: '50%' }),
              background: color,
              opacity: crossed ? 1 : 0.5,
            }}
          />
        )}
        {marks.map((mark) => (
          <span key={mark} className="absolute inset-y-[-2px] w-px bg-[var(--color-text-secondary)]/70" style={{ left: at(mark) }} />
        ))}
        <span className="absolute inset-y-[-2px] left-1/2 w-px bg-[var(--color-border-strong)]" />
      </span>
      <strong
        className="text-right font-mono text-[13px] font-bold tabular-nums"
        style={{ color: !valid ? 'var(--color-text-tertiary)' : neutral ? 'var(--color-text-primary)' : color }}
      >{text}</strong>
    </span>
  )
}

function TechnicalSnapshotGuide({ momentum }: { momentum: TechnicalMomentumSnapshot }) {
  const inputs = momentum.maAngles ? maFieldInputs(momentum.maAngles) : null
  const conditions = momentum.status === 'available' && momentum.maStructure && inputs
    ? maFieldChangeConditions(momentum.maStructure, inputs)
    : []
  const t = MA_FIELD_THRESHOLD_DEG
  const items: Array<{ term: string; body: ReactNode }> = [
    {
      term: 'MA力場(現在の状態)',
      body: (
        <>
          4本のMA(5・25・75・200)の角度だけで決まります。短期平均(5・25MA)と長期平均(75・200MA)が±{t}°を超えて同じ向きにそろい、同じ向きが3本以上で「上/下方向へ力が拡散」です。
          {conditions.length > 0 && (
            <ul className="m-0 mt-1 list-disc pl-4">
              {conditions.map((condition) => <li key={condition}>{condition}</li>)}
            </ul>
          )}
        </>
      ),
    },
    {
      term: '逆向きと矢印',
      body: `逆向きは、上向き・下向きの本数が多い側と反対に±${t}°を超えて傾くMAです(同数なら付けません)。セルの語(上向き・横ばいなど)は表示用の別基準(±1.2°で横ばい、±3°で強)なので、本数と一致しない場合があります。矢印は20営業日前のMAからの変化率をもとにした角度で、チャート上の見た目の傾きとは異なります。`,
    },
    {
      term: '6ステージ',
      body: 'S1=短>中>長(安定上昇期)、S2=中>短>長、S3=中>長>短、S4=長>中>短(安定下降期)、S5=長>短>中、S6=短>長>中。使うMAは 日A 5/25/75、日B 75/150/300、週A 5/13/25、週B 25/50/100、月A 3/5/10、月B 10/20/25。',
    },
    {
      term: '3スコア',
      body: 'PMS(総合の強さ)は値動きの速度・加速度・勢い・力・MA角度平均・熱量の6要素、PFS(足元の力の向き)は力と加速度、PES(値動きの熱量)は熱量と勢いを、それぞれ市場全体の平均からの差(標準偏差単位)で平均したものです。バーは±2.5で頭打ちになります。',
    },
    {
      term: '2つの観測の関係',
      body: 'PESは方向を持たない活動量なので、平常圏や低めでもMAが上向きになることがあります。PMSにはMA角度平均が6要素の1つとして含まれるため、MAの傾きと完全に独立ではありません。PFS・PESはMAを含みません。',
    },
    {
      term: '時間軸・算出窓の違い',
      body: '日足のPMS/PFS/PESは市場全体との比較、2日足・週足・月足は銘柄自身の時間軸内の比較で、行どうしの数値は直接比べません。「直近の向き」はAPIの判定、「20日変化」はPMSの20本前との差、PMS推移の「直近方向」は20日変化(なければ60日・全期間)が±0.35を超えるかで決まるため、算出窓が異なり向きが食い違うことがあります。チャート下の要約はその足自体の値動き・MAで、MAの傾きブロックとは別の指標です。',
    },
    {
      term: 'Stageの色と遷移',
      body: 'Stageの色は種別を区別する色で、上昇・下落の赤・青とは別です。Stageが切り替わっても良し悪しは示しません(矢印→に赤・青は使いません)。',
    },
  ]
  return (
    <details className="border border-[var(--color-border-default)] bg-white">
      <summary className="flex min-h-11 cursor-pointer select-none items-center gap-2 px-3 text-[12px] font-bold text-[var(--color-text-secondary)] sm:min-h-9">
        <svg
          aria-hidden="true"
          viewBox="0 0 8 8"
          className="h-2 w-2 shrink-0 text-[var(--color-text-tertiary)] transition-transform [details[open]_&]:rotate-90"
          fill="currentColor"
        >
          <path d="M1.5 0.5 6.5 4 1.5 7.5z" />
        </svg>
        指標の見方
        <span className="text-[11px] font-medium text-[var(--color-text-tertiary)]">MA力場・ステージ・3スコア・算出窓</span>
      </summary>
      <dl className="m-0 grid gap-x-6 gap-y-3 border-t border-[var(--color-border-soft)] px-3 py-3 md:grid-cols-2">
        {items.map(({ term, body }) => (
          <div key={term} className="min-w-0">
            <dt className="text-[12px] font-bold text-[var(--color-text-primary)]">{term}</dt>
            <dd className="m-0 mt-0.5 text-[11px] font-medium leading-5 text-[var(--color-text-secondary)]">{body}</dd>
          </div>
        ))}
      </dl>
    </details>
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
    <section className="space-y-4 bg-white pb-2" aria-labelledby="fundamental-workspace-title">
      <div className="overflow-hidden border-y border-[var(--color-border-soft)] bg-white">
        <header className="flex flex-wrap items-end justify-between gap-2 border-b border-[var(--color-border-soft)] px-4 py-3 sm:px-5">
          <div>
            <h2 id="fundamental-workspace-title" className="text-[15px] font-bold text-[var(--color-text-primary)]">ファンダメンタル</h2>
            <p className="mt-1 text-[12px] font-medium text-[var(--color-text-secondary)]">現在地(サマリー) → 業績・財務の根拠 → 株価の位置 → 株主還元の順に確認</p>
          </div>
          <span className="font-mono text-[11px] font-semibold text-[var(--color-text-tertiary)]">基準日 {analysisDate ?? quote?.priceDate ?? '---'}</span>
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

      {active === 'summary' && (
        <StockDecisionSummary
          ticker={ticker}
          analysisDate={analysisDate}
          quote={quote}
          variant="fundamental"
          onSelectFundamentalTab={onSelect}
        />
      )}
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
  analysisParamsReady,
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
  analysisParamsReady: boolean
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
      <StockLargeHolders ticker={ticker} analysisDate={analysisDate}
        analysisParamsReady={analysisParamsReady} />
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
              <h2 id="company-basic-info-title" className="text-[14px] font-bold text-[var(--color-text-primary)]">サマリー</h2>
              <div className="mt-0.5 text-[10px] font-medium text-[var(--color-text-tertiary)]">
                市場データ J-Quants / 企業情報 会社四季報CSV
              </div>
            </div>
          </div>
          <div className="font-mono text-[10px] font-medium text-[var(--color-text-tertiary)]">
            基準日 {quote?.priceDate ?? analysisDate ?? '---'}
          </div>
        </header>

        <div
          className="grid items-start gap-x-4 gap-y-3 px-3 py-3 sm:px-4 sm:py-4 xl:grid-cols-[minmax(0,1.08fr)_minmax(0,.92fr)] xl:gap-x-8"
          data-overview-basic-grid
        >
          <BasicInfoCard
            ticker={ticker}
            quote={quote}
            analysisDate={analysisDate}
            physical={physicalMomentum}
            physicalLoading={physicalMomentumLoading}
            embedded
            marketSnapshot={(
              <div className="min-w-0 lg:contents" data-overview-market-column>
                <MarketSnapshotCard
                  ticker={ticker}
                  marginInfo={marginInfo}
                  fallbackType={fallbackType}
                  analysisDate={analysisDate}
                  embedded
                />
              </div>
            )}
          />
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
  const item = (label: string, value?: string | null) => (
    value?.trim() ? { label, value } : null
  )
  const classificationGroups = [
    {
      key: 'market',
      label: '市場属性',
      tone: 'market',
      items: [item('市場', marketSegment)],
    },
    {
      key: 'official',
      label: '公式業種分類',
      tone: 'official',
      items: [item('17業種', sector17), item('33業種', sector33)],
    },
    {
      key: 'custom',
      label: '独自分類',
      tone: 'custom',
      items: [item('独自60分類', majorCategory), item('独自細分類', subIndustry)],
    },
  ].map((group) => ({
    ...group,
    items: group.items.filter((entry): entry is { label: string; value: string } => entry !== null),
  })).filter((group) => group.items.length > 0)
  if (classificationGroups.length === 0) return null
  return (
    <div className="flex w-full min-w-0 max-w-full flex-none flex-wrap items-center gap-x-3 gap-y-1.5 sm:w-auto sm:flex-initial" aria-label={`銘柄分類${analysisDate ? '（現在属性）' : ''}`}>
      {classificationGroups.map((group) => (
        <span
          key={group.key}
          className="inline-flex max-w-full flex-wrap items-center gap-1"
          role="group"
          aria-label={group.label}
          data-classification-group={group.key}
        >
          {group.items.map(({ label, value }) => (
            <span
              key={label}
              title={`${label}: ${value}${analysisDate ? '（現在属性）' : ''}`}
              className={`inline-flex max-w-full shrink-0 items-baseline gap-1.5 rounded-[4px] border px-2 py-1 leading-none ${
                group.tone === 'market'
                  ? 'border-[var(--color-border-default)] bg-white'
                  : group.tone === 'official'
                    ? 'border-[var(--color-border-soft)] bg-[var(--color-surface-subtle)]'
                    : 'border-[var(--color-brand-100)] bg-[var(--color-brand-50)]'
              }`}
            >
              <span className="shrink-0 text-[9px] font-medium text-[var(--color-text-tertiary)]">{label}</span>
              <strong className={`min-w-0 whitespace-normal break-words text-[10px] font-bold ${
                group.tone === 'custom' ? 'text-[var(--color-brand-900)]' : 'text-[var(--color-text-primary)]'
              }`}>{value}</strong>
            </span>
          ))}
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

      <div className="mt-2.5 grid sm:mt-4 lg:grid-cols-2">
        <ShikihoNarrativeSection title="会社概要" body={profile.companyFeature} />
        <ShikihoNarrativeSection title="連結事業" body={profile.consolidatedBusiness} bordered />
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
          <div className="mt-1.5 border-t border-[var(--color-border-soft)]">
            <ShikihoArticle headline={profile.headline1} description={profile.description1} />
            <ShikihoArticle headline={profile.headline2} description={profile.description2} bordered />
          </div>
        </section>
      </div>
    </section>
  )
}

function ShikihoNarrativeSection({
  title,
  body,
  bordered = false,
}: {
  title: string
  body: string | null
  bordered?: boolean
}) {
  // 2本目は狭い画面では上罫線、lg の2列では左罫線で区切る(番号やカードは付けない)
  return (
    <section
      className={
        bordered
          ? 'mt-3 border-t border-[var(--color-border-soft)] pt-3 sm:mt-4 sm:pt-4 lg:mt-0 lg:border-l lg:border-t-0 lg:pl-8 lg:pt-0'
          : 'lg:pr-8'
      }
    >
      <h4 className="text-[12px] font-bold text-[var(--color-text-primary)]">{title}</h4>
      <p className="mt-1 whitespace-pre-wrap text-[11px] font-normal leading-[1.65] text-[var(--color-text-primary)] sm:text-[12px] sm:leading-[1.75]">
        {body ?? '---'}
      </p>
    </section>
  )
}

function ShikihoArticle({
  headline,
  description,
  bordered = false,
}: {
  headline: string | null
  description: string | null
  bordered?: boolean
}) {
  return (
    <article className={`min-w-0 py-2 sm:py-2.5 ${bordered ? 'border-t border-[var(--color-border-soft)]' : ''}`}>
      <h5 className="text-[12px] font-bold leading-5 text-[var(--color-text-primary)] sm:text-[13px]">{headline ?? '---'}</h5>
      <p className="mt-1 whitespace-pre-wrap text-[11px] font-normal leading-[1.6] text-[var(--color-text-secondary)] sm:text-[12px] sm:leading-[1.7]">
        {description ?? '---'}
      </p>
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
    maColor: field.color,
    maAngles: maAngleSet(latest),
    maSpreadDeg: field.spreadDeg,
    maSpreadChangeDeg: field.spreadChangeDeg,
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
  const scoreRow = latest && data
    ? selectPhysicalMomentumScoreRow({
      latest,
      history: data.history ?? [],
      latestScoredDate: data.latestScoredDate,
      isScoreFresh: data.isScoreFresh,
    }).scoreRow
    : null
  const velocityMetric = buildPhysicalRawMetricView('velocity', latest?.velocity)
  const accelerationMetric = buildPhysicalRawMetricView('acceleration', latest?.acceleration)
  const forceMetric = buildPhysicalRawMetricView('force', latest?.force)

  // 読み順: 運動状態(結論) → 時間軸比較 → PMS推移・内訳 → 観察プラン(条件)
  return (
    <section className="card p-3 sm:p-4" aria-labelledby="physical-momentum-title">
      <header className="mb-3 flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
        <h2 id="physical-momentum-title" className="m-0 text-[14px] font-bold text-[var(--color-text-primary)]">Physical Momentum</h2>
        <span className="text-[11px] font-medium text-[var(--color-text-tertiary)]">
          方向(PFS)・強さ(PMS)・熱量(PES)を、時間軸ごとに並べた運動状態です。予測ではありません。
        </span>
        {latest && (
          <span className="ml-auto font-mono text-[11px] font-medium text-[var(--color-text-tertiary)]">基準 {latest.date}</span>
        )}
      </header>

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
          {!isMomentumCoverageSparse && (
            <PhysicalStateSummary
              scoreRow={scoreRow}
              history={data?.history ?? []}
              rank={data?.rank ?? null}
              total={data?.totalRanked ?? 0}
              trend={data?.trend ?? null}
              field={fieldInsight}
            />
          )}

          <PhysicalTimeframeConclusionPanel views={data?.timeframeViews ?? []} />

          <PhysicalMomentumSparkline
            history={data?.history ?? []}
            breakdown={(
              <div className="min-w-0">
                <div className="mb-1 flex flex-wrap items-baseline gap-x-2">
                  <strong className="text-[12px] font-bold text-[var(--color-text-primary)]">内訳</strong>
                  <span className="text-[11px] font-medium text-[var(--color-text-tertiary)]">日足の生の運動量(市場内の強弱はPMS/PFS/PES)</span>
                </div>
                <div className="divide-y divide-[var(--color-border-soft)]">
                  <PhysicalBreakdown label={velocityMetric.label} help={velocityMetric.detail} value={velocityMetric.value} tone={latest.velocity} />
                  <PhysicalBreakdown label={accelerationMetric.label} help={accelerationMetric.detail} value={accelerationMetric.value} tone={latest.acceleration} />
                  <PhysicalBreakdown label={forceMetric.label} help={forceMetric.detail} value={forceMetric.value} tone={latest.force} />
                </div>
              </div>
            )}
          />

          <button
            type="button"
            className="mb-2 inline-flex min-h-11 w-full items-center justify-between border border-[var(--color-border-default)] bg-white px-3 text-left text-[12px] font-bold text-[var(--color-text-primary)] sm:hidden"
            onClick={() => setMobileDetailsOpen((open) => !open)}
            aria-expanded={mobileDetailsOpen}
            aria-controls="physical-momentum-details"
          >
            <span>観察プラン(短期・中期・長期)</span>
            <ChevronRight size={15} className={`transition-transform ${mobileDetailsOpen ? 'rotate-90' : ''}`} aria-hidden="true" />
          </button>

          <div id="physical-momentum-details" className={`${mobileDetailsOpen ? 'block' : 'hidden'} sm:block`}>
            <PhysicalTradePlanCards loading={planLoading} error={planError} plan={plan} />
          </div>
        </>
      )}
    </section>
  )
}

function trendText(trend: PhysicalMomentumResponse['trend']): string {
  return trend === 'rising' ? '上昇中' : trend === 'falling' ? '低下中' : trend === 'flat' ? '横ばい' : '推移未判定'
}

function trendArrow(trend: PhysicalMomentumResponse['trend']): string {
  return trend === 'rising' ? '↗' : trend === 'falling' ? '↘' : trend === 'flat' ? '→' : '·'
}

/** 日足の結論 → 根拠 → 変化点 を3行で示す。数値はAPI値と既存の判定関数の出力のみ。 */
function PhysicalStateSummary({
  scoreRow,
  history,
  rank,
  total,
  trend,
  field,
}: {
  scoreRow: PhysicalMomentumApiRow | null
  history: PhysicalMomentumApiRow[]
  rank: number | null
  total: number
  trend: PhysicalMomentumResponse['trend']
  field: PhysicalMaFieldInsight | null
}) {
  const view = buildPhysicalMomentumView({
    pms: scoreRow?.physicalMomentumScore,
    pfs: scoreRow?.physicalForceScore,
    pes: scoreRow?.physicalEnergyScore,
    trend,
    rank,
    total,
    fieldLabel: field?.label,
  })
  const color = physicalToneColor(view.tone)
  // PMS推移チャートの「20日変化」と同じ取り方(スコアのある行の20本前との差)
  const scored = history.filter((row) => row.physicalMomentumScore != null && Number.isFinite(row.physicalMomentumScore))
  const last = scored.at(-1)?.physicalMomentumScore ?? null
  const before20 = scored.length >= 21 ? scored[scored.length - 21].physicalMomentumScore : null
  const delta20 = last != null && before20 != null ? last - before20 : null
  // 算出窓が違う2つの向き(APIの「直近の向き」と、スコアの20本前との差)が食い違うときは、どちらかを選ばず相反として並べる
  const trendDisagrees = delta20 != null && ((trend === 'rising' && delta20 < 0) || (trend === 'falling' && delta20 > 0))
  const details: Array<{ label: string; value: ReactNode; title?: string }> = [
    ...(rank && total
      ? [{ label: 'PMS 市場内', value: <>{rank.toLocaleString('ja-JP')}/{total.toLocaleString('ja-JP')}位</> }]
      : []),
    {
      label: '直近の向き',
      title: 'APIが判定するPMSの直近の向き',
      value: <>{trendArrow(trend)} {trendText(trend)}</>,
    },
    ...(delta20 != null
      ? [{
        label: '20日変化',
        title: 'PMSの20本前との差(PMS推移グラフと同じ取り方)',
        value: <span style={{ color: scoreTone(delta20) }}>{formatDelta(delta20)}</span>,
      }]
      : []),
  ]
  return (
    <section
      className="mb-3 grid gap-x-5 gap-y-1.5 border border-[var(--color-border-default)] bg-white px-3 py-2 md:grid-cols-[minmax(260px,1.3fr)_minmax(0,1fr)]"
      aria-label="日足の運動状態"
      data-physical-state
    >
      <div className="min-w-0">
        <div className="text-[11px] font-bold text-[var(--color-text-tertiary)]">運動状態(日足・20営業日)</div>
        <strong className="mt-0.5 block text-[15px] font-bold leading-tight [text-wrap:pretty]" style={{ color }}>{view.label}</strong>
        <p className="m-0 mt-1 text-[12px] font-medium leading-5 text-[var(--color-text-secondary)] [text-wrap:pretty]">{view.summary}</p>
      </div>
      <dl className="m-0 flex min-w-0 flex-wrap content-start items-baseline gap-x-5 gap-y-1">
        {details.map((item) => (
          <div key={item.label} className="flex items-baseline gap-1.5" title={item.title}>
            <dt className="text-[11px] font-medium text-[var(--color-text-tertiary)]">{item.label}</dt>
            <dd className="m-0 font-mono text-[13px] font-bold tabular-nums text-[var(--color-text-primary)]">{item.value}</dd>
          </div>
        ))}
        {trendDisagrees && (
          <div className="flex items-baseline">
            <dt className="sr-only">注意</dt>
            <dd
              className="m-0 border border-dashed border-[var(--color-text-secondary)] px-1 text-[11px] font-bold leading-4 text-[var(--color-text-primary)]"
              title="直近の向き(API判定)と20日変化(20本前との差)は算出窓が異なり、向きが食い違っています"
            >相反(窓が異なる)</dd>
          </div>
        )}
      </dl>
    </section>
  )
}

function scoreTone(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value) || value === 0) return 'var(--text-primary)'
  return value > 0 ? 'var(--price-up)' : 'var(--price-down)'
}

// buildPhysicalMomentumView の方向判定と同じ閾値(PFS ±0.35、PMS ±1)
const PHYSICAL_FORCE_THRESHOLD = 0.35
const PHYSICAL_STRONG_PMS = 1

function PhysicalTimeframeConclusionPanel({ views }: { views: PhysicalMomentumTimeframeView[] }) {
  if (views.length === 0) return null
  const forceUp = views.filter((view) => (view.physicalForceScore ?? 0) >= PHYSICAL_FORCE_THRESHOLD).length
  const forceDown = views.filter((view) => (view.physicalForceScore ?? 0) <= -PHYSICAL_FORCE_THRESHOLD).length
  const strong = views.filter((view) => (view.physicalMomentumScore ?? 0) >= PHYSICAL_STRONG_PMS).length
  const weak = views.filter((view) => (view.physicalMomentumScore ?? 0) <= -PHYSICAL_STRONG_PMS).length
  const alignment = forceUp === views.length
    ? 'すべての時間軸で上向き'
    : forceDown === views.length
      ? 'すべての時間軸で下向き'
      : forceUp > 0 && forceDown > 0
        ? '時間軸で向きが分かれる'
        : forceUp > 0 || forceDown > 0
          ? '一部の時間軸だけに向き'
          : 'どの時間軸も向きは中立'

  return (
    <section className="mb-3 min-w-0 border border-[var(--color-border-default)] bg-white" aria-labelledby="physical-timeframe-title">
      <header className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 border-b border-[var(--color-border-soft)] px-3 py-2">
        <h3 id="physical-timeframe-title" className="m-0 text-[12px] font-bold text-[var(--color-text-primary)]">時間軸の整合 <span className="font-medium text-[var(--color-text-secondary)]">{alignment}</span></h3>
        <span className="font-mono text-[11px] font-medium text-[var(--color-text-tertiary)]">
          方向PFS ▲{forceUp} ▼{forceDown} ・ 強さPMS 強{strong} 弱{weak} / {views.length}
        </span>
      </header>
      <div className="hidden grid-cols-[6rem_minmax(8rem,1.2fr)_repeat(3,minmax(0,1fr))] gap-x-3 border-b border-[var(--color-border-soft)] px-3 py-1 text-[11px] font-bold text-[var(--color-text-tertiary)] sm:grid">
        <span>時間軸</span>
        <span>判定・PMS推移</span>
        <span>PMS 強さ</span>
        <span>PFS 方向</span>
        <span>PES 熱量</span>
      </div>
      <div className="divide-y divide-[var(--color-border-soft)]">
        {views.map((view) => (
          <PhysicalTimeframeConclusionCard key={view.interval} view={view} />
        ))}
      </div>
      <p className="m-0 border-t border-[var(--color-border-soft)] px-3 py-1 text-[11px] font-medium leading-4 text-[var(--color-text-tertiary)]">
        日足=市場比較、他=銘柄内比較。行どうしの数値は直接比べません ・ 縦線=判定の境界
      </p>
    </section>
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
  const isPrimary = view.interval === 'D'
  return (
    <div
      className={`grid grid-cols-[6rem_minmax(0,1fr)] items-center gap-x-3 gap-y-1 px-3 py-1.5 sm:grid-cols-[6rem_minmax(8rem,1.2fr)_repeat(3,minmax(0,1fr))] ${isPrimary ? 'bg-[var(--color-surface-subtle)] shadow-[inset_3px_0_0_var(--color-brand-900)]' : ''}`}
      data-physical-timeframe={view.interval}
      title={`${view.label} ${view.basis} ${view.latestDate ?? ''} ${view.scoreSource === 'market_z' ? '市場比較' : '時間軸内比較'}`}
    >
      <span className="min-w-0">
        <span className="block whitespace-nowrap text-[12px] font-bold text-[var(--color-text-primary)]">{view.label}</span>
        <span className="block text-[11px] font-medium text-[var(--color-text-tertiary)]">{view.scoreSource === 'market_z' ? '市場比較' : '銘柄内'}</span>
      </span>
      <span className="min-w-0">
        <strong className="block text-[12px] font-bold leading-tight" style={{ color }}>{built.label}</strong>
        <span className="block text-[11px] font-medium text-[var(--color-text-tertiary)]">PMS {trendArrow(view.trend)} {trendText(view.trend)}</span>
      </span>
      {/* 狭い画面は3スコアを縦に積み、バーに十分な幅を渡す。sm以上は表の列 */}
      <span className="col-span-2 grid gap-y-0.5 sm:contents">
        {([
          ['PMS', view.physicalMomentumScore],
          ['PFS', view.physicalForceScore],
          ['PES', view.physicalEnergyScore],
        ] as const).map(([code, value]) => (
          <span key={code} className="grid min-w-0 grid-cols-[2rem_minmax(0,1fr)] items-center gap-x-2 sm:block">
            <span className="text-[11px] font-bold text-[var(--color-text-tertiary)] sm:hidden">{code}</span>
            <ScoreThresholdBar
              label={`${view.label} ${code}`}
              value={value}
              text={formatDelta(value)}
              neutral={code === 'PES'}
              marks={PHYSICAL_BOUNDARIES.find((item) => item.code === code)?.marks ?? []}
            />
          </span>
        ))}
      </span>
    </div>
  )
}

function PhysicalBreakdown({ label, help, value, tone }: { label: string; help: string; value: string; tone?: number | null }) {
  const color = tone == null || !Number.isFinite(tone) ? 'var(--text-primary)' : tone >= 0 ? 'var(--price-up)' : 'var(--price-down)'
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_auto] items-baseline gap-x-3 py-1.5">
      <span className="text-[12px] font-bold text-[var(--color-text-secondary)]">{label}</span>
      <strong className="text-right font-mono text-[13px] font-bold tabular-nums" style={{ color }}>{value}</strong>
      <small className="col-span-2 text-[11px] font-medium leading-4 text-[var(--color-text-tertiary)]">{help}</small>
    </div>
  )
}

/** PMS推移(左)と、最新値・変化・内訳(右)を1枚にまとめる。高さは内容なり(列を引き伸ばさない) */
function PhysicalMomentumSparkline({ history, breakdown }: { history: PhysicalMomentumApiRow[]; breakdown: ReactNode }) {
  // SVGは実寸(px)で描き、軸ラベルの11pxを画面幅によらず保つ(viewBox縮小で文字が潰れない)
  const [plotBox, setPlotBox] = useState<HTMLDivElement | null>(null)
  const [plotWidth, setPlotWidth] = useState(520)
  useEffect(() => {
    if (!plotBox) return
    const measure = () => setPlotWidth(Math.max(260, Math.round(plotBox.clientWidth)))
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(plotBox)
    return () => observer.disconnect()
  }, [plotBox])
  const chart = useMemo(() => {
    const points = history
      .filter((row) => row.physicalMomentumScore != null && Number.isFinite(row.physicalMomentumScore))
      .slice(-160)
    if (points.length === 0) return null
    const scoreMin = -2.5
    const scoreMax = 2.5
    const span = scoreMax - scoreMin
    const width = plotWidth
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
  }, [history, plotWidth])

  if (!chart) {
    return (
      <section className="mb-3 border border-[var(--color-border-default)] bg-white p-3" aria-label="PMS推移と内訳">
        <div className="grid items-start gap-3 lg:grid-cols-[minmax(0,1.7fr)_minmax(0,1fr)]">
          <div style={physicalSparklineEmptyStyle}>PMS時系列はまだ不足しています。</div>
          {breakdown}
        </div>
      </section>
    )
  }

  const sparse = chart.points.length < 20
  const directionDelta = chart.delta20 ?? chart.delta60 ?? chart.deltaAll
  const trendLabel = trendLabelFromDelta(directionDelta)
  const latestTone = chart.latestScore >= 0 ? 'var(--price-up)' : 'var(--price-down)'
  const latestLabelX = chart.latestX > chart.width - 96 ? chart.latestX - 92 : chart.latestX + 8
  const latestLabelAnchor = chart.latestX > chart.width - 96 ? 'end' : 'start'

  return (
    <section className="mb-3 border border-[var(--color-border-default)] bg-white p-3" aria-label="PMS推移と内訳">
     <div className="grid items-start gap-x-5 gap-y-3 lg:grid-cols-[minmax(0,1.7fr)_minmax(0,1fr)]">
      <div className="min-w-0" ref={setPlotBox}>
      <div style={physicalSparklineHeaderStyle}>
        <div>
          <strong className="text-[12px] font-bold text-[var(--color-text-primary)]">PMS推移</strong>
          <small style={physicalTrendHeaderNoteStyle}>固定スケールで市場平均との差を表示</small>
        </div>
        <span className="font-mono text-[11px]">{chart.firstDate} → {chart.lastDate}</span>
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
                fontSize="11"
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
            fontSize="12"
            fontWeight="800"
            fill={latestTone}
            fontFamily="var(--font-mono)"
          >
            {fmtScore(chart.latestScore)}
          </text>
          <text x={chart.pad.left} y={chart.height - 5} fontSize="11" fill="var(--text-muted)" fontFamily="var(--font-mono)">
            {chart.firstDate}
          </text>
          <text x={chart.pad.left + chart.innerWidth} y={chart.height - 5} textAnchor="end" fontSize="11" fill="var(--text-muted)" fontFamily="var(--font-mono)">
            {chart.lastDate}
          </text>
        </svg>
      )}
      <div style={physicalTrendLegendStyle}>
        <span><i style={{ ...physicalTrendLegendMarkerStyle, background: 'rgba(220, 38, 38, 0.16)' }} /> +1以上: 市場より強い</span>
        <span><i style={{ ...physicalTrendLegendMarkerStyle, background: 'rgba(37, 99, 235, 0.16)' }} /> -1以下: 市場より弱い</span>
        <span><i style={{ ...physicalTrendLegendMarkerStyle, background: 'var(--text-muted)' }} /> 0: 市場平均</span>
      </div>
      </div>
      <div className="min-w-0 space-y-2">
        {/* 最新値はグラフ末尾の数値、20日変化は運動状態の行にあるため、ここには推移だけを置く */}
        <dl className="m-0 divide-y divide-[var(--color-border-soft)] border-y border-[var(--color-border-soft)]">
          <PhysicalTrendChip label="全期間" value={formatDelta(chart.deltaAll)} tone={chart.deltaAll} />
          <PhysicalTrendChip
            label="直近方向"
            value={trendLabel}
            tone={directionDelta}
            note={`${chart.delta20 != null ? '20日変化' : chart.delta60 != null ? '60日変化' : '全期間'}が±0.35を超えるかで判定`}
          />
        </dl>
        {breakdown}
      </div>
     </div>
    </section>
  )
}

function PhysicalTrendChip({ label, value, tone, note }: { label: string; value: string; tone: number | null | undefined; note?: string }) {
  const color = tone == null || !Number.isFinite(tone) ? 'var(--text-primary)' : tone >= 0 ? 'var(--price-up)' : 'var(--price-down)'
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-x-3 py-1.5" title={note}>
      <dt className="text-[12px] font-bold text-[var(--color-text-secondary)]">{label}</dt>
      <dd className="m-0 font-mono text-[13px] font-bold tabular-nums" style={{ color }}>{value}</dd>
      {note && <dd className="m-0 basis-full text-[11px] font-medium leading-4 text-[var(--color-text-tertiary)]">{note}</dd>}
    </div>
  )
}

// buildPhysicalMomentumView が使う判定の境界(PMS ±1、PFS ±0.35、PES +1 / -0.35)
const PHYSICAL_BOUNDARIES: Array<{ code: 'PMS' | 'PFS' | 'PES'; label: string; marks: number[] }> = [
  { code: 'PMS', label: '強さ', marks: [-PHYSICAL_STRONG_PMS, PHYSICAL_STRONG_PMS] },
  { code: 'PFS', label: '方向', marks: [-PHYSICAL_FORCE_THRESHOLD, PHYSICAL_FORCE_THRESHOLD] },
  { code: 'PES', label: '熱量', marks: [-0.35, 1] },
]

function nearestBoundaryText(value: number | null, marks: number[]): string {
  if (value == null || !Number.isFinite(value)) return '未算出'
  const below = marks.filter((mark) => mark <= value).sort((a, b) => b - a)[0]
  const above = marks.filter((mark) => mark > value).sort((a, b) => a - b)[0]
  const parts: string[] = []
  if (above != null) parts.push(`${formatDelta(above)}まで +${(above - value).toFixed(2)}`)
  if (below != null) parts.push(`${formatDelta(below)}まで -${(value - below).toFixed(2)}`)
  return parts.join(' / ')
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
  const panelClass = 'min-w-0 border border-[var(--color-border-default)] bg-white'
  const headerClass = 'flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 px-3 py-2'
  const titleClass = 'm-0 text-[12px] font-bold text-[var(--color-text-primary)]'
  const metaClass = 'text-[11px] font-medium text-[var(--color-text-tertiary)]'

  if (loading) {
    return (
      <section className={panelClass} aria-label="観察プラン">
        <div className={headerClass}>
          <h3 className={titleClass}>短期・中期・長期プラン</h3>
          <span className={metaClass}>統計と物理MLを確認中...</span>
        </div>
        <div className="divide-y divide-[var(--color-border-soft)] border-t border-[var(--color-border-soft)]">
          {[0, 1, 2, 3].map((index) => (
            <div key={index} className="h-11 animate-pulse bg-[var(--color-surface-subtle)]/60" />
          ))}
        </div>
      </section>
    )
  }

  if (error) {
    return (
      <section className={panelClass} aria-label="観察プラン">
        <div className={headerClass}>
          <h3 className={titleClass}>短期・中期・長期プラン</h3>
          <span className="text-[11px] font-medium text-[var(--price-down)]">取得エラー: {error}</span>
        </div>
      </section>
    )
  }

  if (!plan?.available || plan.horizons.length === 0) {
    return (
      <section className={panelClass} aria-label="観察プラン">
        <div className={headerClass}>
          <h3 className={titleClass}>短期・中期・長期プラン</h3>
          <span className={metaClass}>物理ML特徴量が不足しています</span>
        </div>
        <p className="m-0 border-t border-[var(--color-border-soft)] px-3 py-2 text-[12px] font-medium text-[var(--color-text-tertiary)]">現時点では時間軸別の統計解釈を作れません。</p>
      </section>
    )
  }

  return (
    <section className={panelClass} aria-label="観察プラン">
      <div className={headerClass}>
        <h3 className={titleClass}>短期・中期・長期の観察プラン</h3>
        <span className={`${metaClass} font-mono`}>{plan.featureAsOfDate ? `特徴量 ${plan.featureAsOfDate}` : '特徴量日付 -'}</span>
      </div>
      <div className="divide-y divide-[var(--color-border-soft)] border-t border-[var(--color-border-soft)]">
        {plan.horizons.map((horizon) => (
          <PhysicalTradePlanCard key={`${horizon.label}-${horizon.horizonDays}`} horizon={horizon} />
        ))}
      </div>
      <p className="m-0 border-t border-[var(--color-border-soft)] px-3 py-2 text-[11px] font-medium leading-4 text-[var(--color-text-tertiary)]">
        {plan.note ?? 'この表示は現在形状と過去検証統計から作る観察メモです。売買を断定するものではありません。'}
      </p>
    </section>
  )
}

function PhysicalTradePlanCard({ horizon }: { horizon: PhysicalPlanHorizon }) {
  const tone = tradePlanToneStyle(horizon.suggestion.tone)
  const topCandidates = horizon.candidates
    .slice()
    .sort((a, b) => a.rank - b.rank)
    .slice(0, 3)
  const decision = horizon.suggestion.decision
  const levels = horizon.levels
  const liftMark = horizon.lift == null || !Number.isFinite(horizon.lift) ? '' : horizon.lift >= 1 ? '▲' : '▼'
  const [open, setOpen] = useState(false)
  const detailsId = `physical-plan-detail-${horizon.horizonDays}`
  const chipClass = 'border border-[var(--color-border-soft)] px-1.5'
  // 狭い画面は縦積み / sm: 左に期間・右に内容 / lg: 期間・結論と構造・統計・価格の4列 + 下段に条件(全幅)。行の高さは内容なり
  return (
    <article className="min-w-0 px-3 py-2" style={{ boxShadow: `inset 3px 0 0 ${tone.color}` }}>
      <div className="grid gap-x-4 gap-y-1.5 sm:grid-cols-[6rem_minmax(0,1fr)] lg:grid-cols-[6rem_minmax(0,1.5fr)_minmax(0,.9fr)_minmax(0,1.3fr)]">
        <div className="flex items-baseline gap-2 sm:col-start-1 sm:row-span-4 sm:row-start-1 sm:block lg:col-start-1 lg:row-span-2 lg:row-start-1">
          <span className="block text-[12px] font-bold text-[var(--color-text-primary)]">{horizon.label}</span>
          <span className="font-mono text-[11px] font-medium text-[var(--color-text-tertiary)]">{horizon.horizonDays}営業日</span>
        </div>
        <div className="min-w-0 sm:col-start-2 sm:row-start-1 lg:col-start-2">
          <strong className="block text-[14px] font-bold leading-snug [text-wrap:pretty]" style={{ color: tone.color }}>{horizon.suggestion.headline}</strong>
          <div className="mt-1 flex flex-wrap items-baseline gap-x-2 gap-y-1 text-[11px] font-semibold text-[var(--color-text-secondary)]">
            <span className={chipClass}>構造 {physicalPlanDirectionLabel(decision.structureDirection)}</span>
            <span className={chipClass}>PMS/PFS {physicalPlanDirectionLabel(decision.momentumDirection)}</span>
            {decision.candidateDirection !== 'wait' && (
              <span className={chipClass}>物理ML {physicalPlanDirectionLabel(decision.candidateDirection)}</span>
            )}
            <span className={chipClass}>{physicalPlanStatisticsLabel(decision.statisticsQuality)}</span>
          </div>
        </div>
        <dl className="m-0 flex flex-wrap gap-x-4 gap-y-0.5 text-[12px] sm:col-start-2 sm:row-start-2 lg:col-start-3 lg:row-start-1 lg:grid lg:grid-cols-1 lg:content-start">
          <div className="flex items-baseline justify-between gap-2">
            <dt className="text-[11px] font-medium text-[var(--color-text-tertiary)]">的中率(同状態)</dt>
            <dd className="m-0 font-mono font-bold tabular-nums text-[var(--color-text-primary)]">{fmtRate(horizon.hitRate)}</dd>
          </div>
          <div className="flex items-baseline justify-between gap-2">
            <dt className="text-[11px] font-medium text-[var(--color-text-tertiary)]">基準率(市場全体)</dt>
            <dd className="m-0 font-mono font-bold tabular-nums text-[var(--color-text-primary)]">{fmtRate(horizon.baseRate)}</dd>
          </div>
          <div className="flex items-baseline justify-between gap-2">
            <dt className="text-[11px] font-medium text-[var(--color-text-tertiary)]">Lift ・ 信頼 {horizon.confidenceLabel}</dt>
            <dd className="m-0 font-mono font-bold tabular-nums text-[var(--color-text-primary)]">{liftMark}{fmtLift(horizon.lift)}</dd>
          </div>
        </dl>
        {levels ? (
          <div className="grid max-w-md grid-cols-3 gap-2 sm:col-start-2 sm:row-start-3 lg:col-start-4 lg:row-start-1 lg:max-w-none">
            <PhysicalPlanLevelChip label="支持" level={levels.support} tone="support" />
            <PhysicalPlanLevelChip label="抵抗" level={levels.resistance} tone="resistance" />
            <PhysicalPlanLevelChip label="割れ注意" level={levels.breakdown} tone="breakdown" />
          </div>
        ) : (
          <span className="text-[11px] font-medium text-[var(--color-text-tertiary)] sm:col-start-2 sm:row-start-3 lg:col-start-4 lg:row-start-1">価格の目安は未算出</span>
        )}
        <div className="flex min-w-0 flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 sm:col-start-2 sm:row-start-4 lg:col-span-3 lg:col-start-2 lg:row-start-2">
          <span className="min-w-0 flex-1 basis-[18rem] text-[12px] font-medium leading-5 text-[var(--color-text-secondary)]">
            <b className="font-bold text-[var(--color-text-primary)]">{horizon.suggestion.conditionLabel}</b> {horizon.suggestion.invalidation}
          </span>
          <button
            type="button"
            onClick={() => setOpen((current) => !current)}
            aria-expanded={open}
            aria-controls={detailsId}
            className="inline-flex min-h-11 shrink-0 items-center gap-1 text-[11px] font-bold text-[var(--color-brand-700)] sm:min-h-6"
          >
            候補・検証日
            <ChevronRight size={12} className={`transition-transform ${open ? 'rotate-90' : ''}`} aria-hidden="true" />
          </button>
        </div>
      </div>
      {open && (
        <div id={detailsId} className="space-y-1.5 pb-1 pt-0.5 text-[12px] font-medium leading-5 text-[var(--color-text-secondary)]">
          <p className="m-0">{horizon.suggestion.stance}</p>
          <div className="flex flex-wrap gap-1.5 text-[11px] font-semibold">
            {topCandidates.length > 0 ? topCandidates.map((candidate) => (
              <span key={`${candidate.direction}-${candidate.rank}`} className="border border-[var(--color-border-soft)] px-1.5">
                {directionLabelJa(candidate.direction)} #{candidate.rank}
              </span>
            )) : (
              <span className="border border-[var(--color-border-soft)] px-1.5">物理ML上位外</span>
            )}
            {horizon.sampleCount != null && (
              <span className="border border-[var(--color-border-soft)] px-1.5">検証 n={horizon.sampleCount.toLocaleString('ja-JP')}</span>
            )}
          </div>
          {horizon.suggestion.checklist.slice(0, 2).map((item) => (
            <div key={item} className="grid grid-cols-[8px_minmax(0,1fr)] items-start gap-1.5">
              <span className="mt-2 h-1.5 w-1.5 rounded-full" style={{ background: tone.color }} />
              <span>{item}</span>
            </div>
          ))}
          <div className="font-mono text-[11px] text-[var(--color-text-tertiary)]">
            {levels ? `基準 ${levels.baseDate} 終値 ${fmtPrice(levels.close)} ・ ` : ''}{horizon.evaluationDate ? `検証 ${horizon.evaluationDate}` : '検証日 -'}
          </div>
        </div>
      )}
    </article>
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
    <div className="min-w-0">
      <span className="block text-[11px] font-medium text-[var(--color-text-tertiary)]">{label}</span>
      <strong className="block whitespace-nowrap font-mono text-[13px] font-bold tabular-nums" style={{ color }}>{fmtPrice(level.value)}</strong>
      <small className="block text-[11px] font-medium leading-tight text-[var(--color-text-tertiary)]">
        {level.label}{level.distancePct != null ? ` ${fmtPct(level.distancePct)}` : ''}
      </small>
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

interface MaAngleSet {
  ma5: number | null
  ma25: number | null
  ma75: number | null
  ma200: number | null
}

const MA_ANGLE_KEYS: Array<{ key: keyof MaAngleSet; label: string }> = [
  { key: 'ma5', label: '5MA' },
  { key: 'ma25', label: '25MA' },
  { key: 'ma75', label: '75MA' },
  { key: 'ma200', label: '200MA' },
]

/** APIのラジアン角を度に直すだけの表示変換 */
function maAngleSet(row: Pick<PhysicalMomentumApiRow, 'ma5Angle' | 'ma25Angle' | 'ma75Angle' | 'ma200Angle'>): MaAngleSet {
  return {
    ma5: angleDeg(row.ma5Angle),
    ma25: angleDeg(row.ma25Angle),
    ma75: angleDeg(row.ma75Angle),
    ma200: angleDeg(row.ma200Angle),
  }
}

function MaAngleStrip({ angles, compact = false }: { angles: MaAngleSet | null; compact?: boolean }) {
  return (
    <div className="grid grid-cols-4 gap-0.5" role="list" aria-label="移動平均線の傾き(短期→長期)">
      {MA_ANGLE_KEYS.map(({ key, label }) => {
        const deg = angles?.[key] ?? null
        const color = angleDirectionColor(deg)
        return (
          <div
            key={key}
            role="listitem"
            className={`flex min-w-0 flex-col items-center justify-center overflow-hidden border bg-white px-1 py-0.5 sm:flex-row sm:gap-1 sm:py-0 ${compact ? 'sm:h-8' : 'sm:h-10'}`}
            style={{ borderColor: deg == null ? 'var(--color-border-default)' : color }}
            title={`${label} ${angleDirectionLabel(deg)}${deg == null ? '' : ` ${deg.toFixed(1)}°`}`}
          >
            <span className="text-[9px] font-bold text-[var(--color-text-tertiary)]">{label}</span>
            <strong className="hidden text-[14px] leading-none sm:inline" style={{ color }} aria-hidden="true">{angleDirectionArrow(deg)}</strong>
            <span className="whitespace-nowrap font-mono text-[10px] font-black" style={{ color }}>
              <span className="sm:hidden" aria-hidden="true">{angleDirectionArrow(deg)} </span>
              <span className="sr-only">{angleDirectionLabel(deg)} </span>{deg == null ? '—' : `${deg >= 0 ? '+' : ''}${deg.toFixed(1)}°`}
            </span>
          </div>
        )
      })}
    </div>
  )
}

interface MaFieldInputs {
  shortAvg: number | null
  longAvg: number | null
  up: number
  down: number
  total: number
}

// buildMaFieldInsight と同じ入力(短期=5・25MA平均、長期=75・200MA平均、±0.2°)を表示用に取り出す
function maFieldInputs(angles: MaAngleSet): MaFieldInputs {
  const all = [angles.ma5, angles.ma25, angles.ma75, angles.ma200].filter((value): value is number => value != null)
  return {
    shortAvg: averageFinite([angles.ma5, angles.ma25]),
    longAvg: averageFinite([angles.ma75, angles.ma200]),
    up: all.filter((value) => value > MA_FIELD_THRESHOLD_DEG).length,
    down: all.filter((value) => value < -MA_FIELD_THRESHOLD_DEG).length,
    total: all.length,
  }
}

const MA_FIELD_THRESHOLD_DEG = 0.2
const MA_FIELD_SPREAD_SHIFT_DEG = 5

function fmtDeg(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '—'
  return `${value >= 0 ? '+' : ''}${value.toFixed(1)}°`
}

/** MA力場ラベルが変わる境界を、現在の入力値と並べて文章化する(判定ロジックの閾値をそのまま使う) */
function maFieldChangeConditions(label: string, inputs: MaFieldInputs): string[] {
  const short = `短期平均(5・25MA)${fmtDeg(inputs.shortAvg)}`
  const long = `長期平均(75・200MA)${fmtDeg(inputs.longAvg)}`
  const t = MA_FIELD_THRESHOLD_DEG
  if (label === '下方向へ力が拡散') {
    return [
      `${short}が-${t}°以上になると外れる(+${t}°超なら「短期上向き・長期収縮」)`,
      `${long}が-${t}°以上になると外れる`,
      `下向きのMA ${inputs.down}/${inputs.total}本(3本未満で外れる)`,
    ]
  }
  if (label === '上方向へ力が拡散') {
    return [
      `${short}が+${t}°以下になると外れる(-${t}°未満なら「短期調整・長期残存」)`,
      `${long}が+${t}°以下になると外れる`,
      `上向きのMA ${inputs.up}/${inputs.total}本(3本未満で外れる)`,
    ]
  }
  if (label === '短期上向き・長期収縮') {
    return [
      `${long}が-${t}°以上になると外れる(+${t}°超・上向き3本以上なら「上方向へ力が拡散」)`,
      `${short}が+${t}°以下になると外れる`,
    ]
  }
  if (label === '短期調整・長期残存') {
    return [
      `${long}が+${t}°以下になると外れる(-${t}°未満・下向き3本以上なら「下方向へ力が拡散」)`,
      `${short}が-${t}°以上になると外れる`,
    ]
  }
  if (label === 'MA力場未判定') return ['MA角度が3本以上そろうと判定されます']
  return [
    `短期・長期の平均がともに±${t}°を超えて同じ向きにそろい、同じ向きが3本以上で「上/下方向へ力が拡散」`,
    `角度幅の前回比が±${MA_FIELD_SPREAD_SHIFT_DEG}°を超えると「拡散中/収縮中」`,
  ]
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
  fontSize: '11px',
  fontWeight: 500,
}

const physicalTrendSvgStyle: CSSProperties = {
  width: '100%',
  height: '184px',
  display: 'block',
  border: '1px solid var(--border-subtle)',
  borderRadius: 'var(--radius-sm)',
  background: '#fff',
}

const physicalTrendLegendStyle: CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  gap: '4px 12px',
  marginTop: '6px',
  color: 'var(--text-muted)',
  fontSize: '11px',
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

const physicalSparseTrendStyle: CSSProperties = {
  border: '1px solid var(--border-subtle)',
  borderRadius: 'var(--radius-sm)',
  background: '#fff',
  padding: '10px',
}

const physicalSparseTrendMainStyle: CSSProperties = {
  display: 'grid',
  gap: '4px',
  color: 'var(--text-secondary)',
  fontSize: '12px',
  lineHeight: 1.55,
}

const physicalSparsePointRowStyle: CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  gap: '5px',
  marginTop: '8px',
}

const physicalSparsePointStyle: CSSProperties = {
  border: '1px solid var(--border-subtle)',
  borderRadius: '999px',
  padding: '3px 7px',
  fontFamily: 'var(--font-mono)',
  fontSize: '11px',
  fontWeight: 700,
}

const physicalSparklineEmptyStyle: CSSProperties = {
  border: '1px solid var(--border-subtle)',
  borderRadius: 'var(--radius-sm)',
  background: '#fff',
  padding: '12px',
  color: 'var(--text-muted)',
  fontSize: '12px',
  textAlign: 'center',
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
    <div className={embedded ? 'lg:contents' : 'card'} style={embedded ? undefined : marketSnapshotCardStyle}>
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
      <div className={`mt-2 border-t border-[var(--color-border-soft)] pt-2 sm:mt-0 sm:border-0 sm:pt-0 ${embedded ? 'min-w-0 lg:order-2' : ''}`}>
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
      <div id={mobileDetailsId} className={`${mobileExpanded ? 'block' : 'hidden'} mt-1 sm:mt-0 sm:block ${embedded ? 'min-w-0 lg:order-2 lg:col-span-2' : ''}`}>
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
    <div
      className={embedded ? '' : 'card'}
      style={embedded ? marginEmbeddedStyle : { padding: '12px' }}
      data-margin-info
    >
      <div className={`flex items-start justify-between gap-2 ${embedded ? 'lg:justify-start lg:gap-3' : ''}`}>
        <div>
          <div className="text-[11px] font-semibold text-[var(--color-text-primary)]">信用取引(週次)</div>
          <div className="mt-0.5 text-[9px] font-medium text-[var(--color-text-tertiary)]">週次信用残</div>
        </div>
        <MarginBadges
          marginType={latest?.marginType ?? fallbackType}
          creditRatio={latest?.creditRatio ?? null}
          shortRatio={latest?.shortRatio ?? null}
          compact
        />
      </div>
      <div className={`mt-1.5 grid grid-cols-1 gap-x-6 gap-y-0 sm:grid-cols-2 ${embedded ? 'lg:grid-flow-col lg:grid-cols-3 lg:grid-rows-2 lg:*:justify-start! lg:[&>*>span:first-child]:min-w-[4em]' : ''}`}>
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
  earnings,
  marketSnapshot,
}: {
  ticker: string
  quote: StockQuote | null
  analysisDate: string | null
  physical: PhysicalMomentumResponse | null
  physicalLoading: boolean
  embedded?: boolean
  /** 判断シート「次回決算」行に置く内容 */
  earnings?: ReactNode
  /** 二次レイヤー「市場データ・需給」に続けて置く行(変化率・信用取引) */
  marketSnapshot?: ReactNode
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
  const rangePosition = quote?.price != null && quote.fiftyTwoWeekHigh != null && quote.fiftyTwoWeekLow != null &&
    quote.fiftyTwoWeekHigh > quote.fiftyTwoWeekLow
    ? Math.min(100, Math.max(0, ((quote.price - quote.fiftyTwoWeekLow) / (quote.fiftyTwoWeekHigh - quote.fiftyTwoWeekLow)) * 100))
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
  ]
  // 52週の高値・安値は判断シートの「52週の位置」行で、位置バー・高値比・安値比と一緒に1回だけ表示する
  const fiftyTwoWeekHighText = quote?.fiftyTwoWeekHigh != null ? `¥${quote.fiftyTwoWeekHigh.toLocaleString('ja-JP', { maximumFractionDigits: 1 })}` : '---'
  const fiftyTwoWeekLowText = quote?.fiftyTwoWeekLow != null ? `¥${quote.fiftyTwoWeekLow.toLocaleString('ja-JP', { maximumFractionDigits: 1 })}` : '---'
  const combinedLoading = summaryLoading || physicalLoading
  const decision = buildBasicDecisionSummary(latestStage, physical, ml, quote)
  const physics = buildBasicPhysicsSummary(ml, summaryLoading)

  const latestPhysical = physical?.latest ?? null
  const previousPhysical = latestPhysical
    ? [...(physical?.history ?? [])].reverse().find((row) => row.date < latestPhysical.date) ?? null
    : null
  const field = latestPhysical ? buildMaFieldInsight(latestPhysical, previousPhysical) : null
  const angles = latestPhysical ? maAngleSet(latestPhysical) : null
  const fieldInputs = angles ? maFieldInputs(angles) : null
  const changeConditions = field && fieldInputs ? maFieldChangeConditions(field.label, fieldInputs) : []
  const stageClose = latestStage?.close ?? null
  const priceVsMa = latestStage && stageClose != null && Number.isFinite(stageClose)
    ? ([
      ['5日', latestStage.ma_5],
      ['25日', latestStage.ma_25],
      ['75日', latestStage.ma_75],
      ['300日', latestStage.ma_300],
    ] as const).map(([label, ma]) => ({
      label,
      position: ma == null || !Number.isFinite(ma)
        ? null
        : stageClose > ma ? 'above' as const : stageClose < ma ? 'below' as const : 'equal' as const,
    }))
    : []
  const shortTerm = buildShortTermEvidence(latestStage, physical, ml, quote, decision)
  const stateLoading = physicalLoading && !latestPhysical

  const rowId = ticker.replace(/[^a-zA-Z0-9_-]/g, '-')
  const signalDetailsId = `overview-signal-details-${rowId}`
  const conditionCount = changeConditions.length + shortTerm.conditions.length
  const evidenceSummary = shortTerm.sides
    .map((side) => `${side.key === 'short' ? '短期' : '中期'} ${directionWord(side.direction)}(▲${side.up} ▼${side.down})`)
    .join(' ・ ')

  return (
    <div className={embedded ? 'contents' : 'card'} style={embedded ? undefined : { padding: '12px' }}>
      <div className="@container min-w-0" data-overview-current-state>
        <SheetRow label="現在の状態" note={latestPhysical?.date ? `MA力場 ${latestPhysical.date}` : 'MA力場'}>
          <div className="grid gap-x-6 gap-y-1 xl:@[42rem]:grid-cols-[minmax(13rem,auto)_minmax(0,1fr)] xl:@[42rem]:items-baseline">
            <p
              id={`overview-current-state-${rowId}`}
              className="m-0 text-[22px] font-black leading-tight"
              style={{ color: field?.color ?? 'var(--color-text-tertiary)' }}
            >
              {field?.label ?? (stateLoading ? '読み込み中' : 'MA力場未判定')}
            </p>
            {fieldInputs && (
              <p className="m-0 text-[12px] font-medium leading-5 text-[var(--color-text-secondary)]">
                4本のMAのうち±{MA_FIELD_THRESHOLD_DEG}°超で上向き<b className="font-mono tabular-nums">{fieldInputs.up}</b>本・下向き<b className="font-mono tabular-nums">{fieldInputs.down}</b>本。
                短期平均<b className="font-mono tabular-nums" style={{ color: angleDirectionColor(fieldInputs.shortAvg) }}>{fmtDeg(fieldInputs.shortAvg)}</b>、
                長期平均<b className="font-mono tabular-nums" style={{ color: angleDirectionColor(fieldInputs.longAvg) }}>{fmtDeg(fieldInputs.longAvg)}</b>
                {field?.spreadChangeDeg != null && (
                  <>。角度幅は前回比<b className="font-mono tabular-nums">{fmtDeg(field.spreadChangeDeg)}</b>({field.spreadChangeDeg > 0 ? '広がる' : field.spreadChangeDeg < 0 ? '狭まる' : '変わらず'})</>
                )}
              </p>
            )}
          </div>
        </SheetRow>

        <SheetRow label="MA" note="短期 → 長期">
          <table className="w-full max-w-[720px] table-fixed border-collapse text-left" aria-label="移動平均線の傾きと終値の位置(短期→長期)">
            <thead>
              <tr className="border-b border-[var(--color-border-soft)]">
                <th scope="col" className="w-10 pb-1 sm:w-14"><span className="sr-only">項目</span></th>
                {MA_SHEET_COLUMNS.map(({ heading }) => (
                  <th key={heading} scope="col" className="pb-1 pr-2 text-[11px] font-bold text-[var(--color-text-tertiary)]">{heading}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              <tr>
                <th scope="row" className="py-1.5 text-[11px] font-bold text-[var(--color-text-tertiary)]">傾き</th>
                {MA_SHEET_COLUMNS.map(({ angleKey, angleLabel }) => {
                  const deg = angles?.[angleKey] ?? null
                  const color = angleDirectionColor(deg)
                  return (
                    <td key={angleKey} className="py-1.5 pr-2" title={`${angleLabel} ${angleDirectionLabel(deg)}${deg == null ? '' : ` ${deg.toFixed(1)}°`}`}>
                      <span className="inline-flex items-baseline gap-0.5 whitespace-nowrap font-mono text-[12px] font-bold tabular-nums xl:text-[13px]" style={{ color }}>
                        <span aria-hidden="true" className="text-[11px]">{angleDirectionArrow(deg)}</span>
                        <span className="sr-only">{angleLabel} {angleDirectionLabel(deg)} </span>
                        {deg == null ? '—' : fmtDeg(deg)}
                      </span>
                    </td>
                  )
                })}
              </tr>
              <tr className="border-t border-[var(--color-border-soft)]">
                <th scope="row" className="py-1.5 text-[11px] font-bold text-[var(--color-text-tertiary)]">終値</th>
                {priceVsMa.length === 0 ? (
                  <td colSpan={4} className="py-1.5 text-[11px] font-semibold text-[var(--color-text-tertiary)]">{combinedLoading ? '読み込み中' : '未取得'}</td>
                ) : priceVsMa.map(({ label, position }) => (
                  <td
                    key={label}
                    className="py-1.5 pr-2"
                    title={`終値は${label}MAの${position === 'above' ? '上' : position === 'below' ? '下' : position === 'equal' ? '同値' : '—'}`}
                  >
                    <b
                      className="text-[13px] font-bold"
                      style={{ color: position === 'above' ? 'var(--price-up)' : position === 'below' ? 'var(--price-down)' : 'var(--color-text-tertiary)' }}
                    >
                      <span className="sr-only">{label}MAの</span>
                      {position === 'above' ? '上' : position === 'below' ? '下' : position === 'equal' ? '同値' : '—'}
                    </b>
                  </td>
                ))}
              </tr>
            </tbody>
          </table>
          <p className="m-0 mt-1 text-[10px] font-medium leading-4 text-[var(--color-text-tertiary)]">
            傾きは5・25・75・200MA、終値の位置は5・25・75・300日MA(長期列のみ期間が異なる)
          </p>
        </SheetRow>

        <SheetRow label="6ステージ" note={latestStage?.date ?? undefined}>
          {latestStage ? (
            <StageRibbon stage={latestStage} />
          ) : (
            <p className="m-0 text-[11px] font-medium text-[var(--color-text-tertiary)]">{combinedLoading ? '最新ステージを確認しています。' : '最新ステージデータがありません。'}</p>
          )}
        </SheetRow>

        <SheetRow label="短期チェック" note="現在">
          <div data-overview-signal-row>
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
              <strong className="text-[15px] font-black leading-tight" style={{ color: decision.color }}>
                {combinedLoading ? '読み込み中' : decision.label}
              </strong>
              {!combinedLoading && (
                <span className="font-mono text-[11px] font-bold tabular-nums" style={{ color: decision.color }}>
                  {formatShortTermStrength(decision.label, decision.score)}
                </span>
              )}
              <span className="text-[11px] font-semibold text-[var(--color-text-secondary)]">
                短期と中期 <b style={{ color: shortTerm.agreement.color }}>{shortTerm.agreement.label}</b>
              </span>
            </div>
            {!combinedLoading && shortTerm.reading && (
              <p className="m-0 mt-1 text-[12px] font-medium leading-5 text-[var(--color-text-secondary)]">{shortTerm.reading}</p>
            )}
          </div>
        </SheetRow>

        <SheetRow label="52週の位置" note="高値・安値レンジ">
          {quote?.fiftyTwoWeekHigh == null && quote?.fiftyTwoWeekLow == null ? (
            <p className="m-0 text-[11px] font-medium text-[var(--color-text-tertiary)]">---</p>
          ) : (
            <div className="max-w-[720px]">
              <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 text-[11px] font-medium text-[var(--color-text-tertiary)]">
                <span>安値 <b className="font-mono text-[13px] font-semibold tabular-nums text-[var(--color-text-primary)]">{fiftyTwoWeekLowText}</b></span>
                {rangePosition != null && (
                  <span>レンジ内の位置 <b className="font-mono text-[15px] font-black tabular-nums text-[var(--color-text-primary)]">{rangePosition.toFixed(0)}%</b></span>
                )}
                <span>高値 <b className="font-mono text-[13px] font-semibold tabular-nums text-[var(--color-text-primary)]">{fiftyTwoWeekHighText}</b></span>
              </div>
              {rangePosition != null && quote?.fiftyTwoWeekLow != null && quote.fiftyTwoWeekHigh != null && (
                <span
                  className="relative mt-1.5 block h-3"
                  role="img"
                  aria-label={`52週安値${quote.fiftyTwoWeekLow}円から高値${quote.fiftyTwoWeekHigh}円の間での現在価格の位置 ${rangePosition.toFixed(0)}%`}
                >
                  <span className="absolute inset-x-0 top-1/2 h-1 -translate-y-1/2 bg-[var(--color-surface-subtle)] ring-1 ring-[var(--color-border-soft)]" />
                  <span className="absolute top-0 h-3 w-[3px] -translate-x-1/2 bg-[var(--color-brand-900)]" style={{ left: `${rangePosition}%` }} />
                </span>
              )}
              <div className="mt-1 flex flex-wrap justify-between gap-x-4 font-mono text-[11px] font-medium tabular-nums text-[var(--color-text-tertiary)]">
                <span>安値比 {lowDistance == null ? '---' : fmtPct(lowDistance)}</span>
                <span>高値比 {highDistance == null ? '---' : fmtPct(highDistance)}</span>
              </div>
            </div>
          )}
        </SheetRow>

        {earnings && (
          <SheetRow label="次回決算" note="前回発表を併記">
            {earnings}
          </SheetRow>
        )}

        <SheetRow label="根拠と条件" note="短期・中期・見方が変わる条件">
          <button
            type="button"
            className="flex min-h-11 w-full flex-wrap items-center gap-x-3 gap-y-0.5 py-1 text-left hover:bg-[var(--color-surface-subtle)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-brand-700)] sm:min-h-9"
            aria-expanded={showSignalDetails}
            aria-controls={signalDetailsId}
            onClick={() => setShowSignalDetails((current) => !current)}
          >
            <span className="min-w-0 text-[11px] font-semibold text-[var(--color-text-secondary)]">
              {combinedLoading ? '読み込み中' : <>{evidenceSummary} ・ 変わる条件 <b className="font-mono tabular-nums">{conditionCount}</b>件</>}
            </span>
            <span className="ml-auto inline-flex shrink-0 items-center gap-1 text-[11px] font-bold text-[var(--color-brand-700)]">
              {showSignalDetails ? '閉じる' : '根拠と条件を見る'}
              <ChevronRight size={13} className={`transition-transform ${showSignalDetails ? 'rotate-90' : ''}`} aria-hidden="true" />
            </span>
          </button>
          <div id={signalDetailsId} hidden={!showSignalDetails} className="mt-2 grid gap-x-8 gap-y-4 md:grid-cols-2 xl:grid-cols-3">
            {shortTerm.sides.map((side) => (
              <section key={side.key} className="min-w-0" aria-label={side.label}>
                <div className="flex items-baseline justify-between gap-2 border-b border-[var(--color-border-soft)] pb-1">
                  <h4 className="text-[11px] font-bold text-[var(--color-text-primary)]">{side.label}</h4>
                  <span className="shrink-0 font-mono text-[11px] font-semibold tabular-nums text-[var(--color-text-tertiary)]">▲{side.up} ▼{side.down}</span>
                </div>
                <ul className="m-0 mt-1 grid gap-0.5 p-0">
                  {side.items.map((item) => (
                    <li key={item.label} className="grid grid-cols-[14px_minmax(0,1fr)_auto] items-baseline gap-1.5 text-[11px] leading-5">
                      <span aria-hidden="true" className="font-mono text-[10px] font-black" style={{ color: directionColor(item.direction) }}>{directionGlyph(item.direction)}</span>
                      <span className="font-medium text-[var(--color-text-tertiary)]">{item.label}</span>
                      <b className="text-right font-mono text-[11px] font-semibold tabular-nums text-[var(--color-text-primary)]">
                        <span className="sr-only">{directionWord(item.direction)} </span>{item.value}
                      </b>
                    </li>
                  ))}
                </ul>
              </section>
            ))}
            <section className="min-w-0 md:col-span-2 xl:col-span-1" aria-label="見方が変わる条件">
              <h4 className="border-b border-[var(--color-border-soft)] pb-1 text-[11px] font-bold text-[var(--color-text-primary)]">見方が変わる条件</h4>
              {changeConditions.length > 0 && (
                <>
                  <div className="mt-1.5 text-[11px] font-semibold text-[var(--color-text-tertiary)]">MA力場「{field?.label}」</div>
                  <ConditionList conditions={changeConditions} />
                </>
              )}
              <div className="mt-1.5 text-[11px] font-semibold text-[var(--color-text-tertiary)]">短期チェック「{decision.label}」</div>
              {shortTerm.conditions.length > 0
                ? <ConditionList conditions={shortTerm.conditions} />
                : <p className="m-0 mt-0.5 text-[11px] font-medium text-[var(--color-text-tertiary)]">—</p>}
            </section>
            <p className="m-0 flex flex-wrap gap-x-4 gap-y-0.5 text-[11px] font-medium text-[var(--color-text-tertiary)] md:col-span-2 xl:col-span-3">
              <span>値動きの近い銘柄 <b className="text-[var(--color-text-secondary)]">{decision.mlText}</b></span>
              {physics.pullbackVerdict && <span>押し目判定 <b className="text-[var(--color-text-secondary)]">{physics.pullbackVerdict}</b></span>}
              <span>物理特徴量 <span className="font-mono tabular-nums">{physics.asOfDate ?? '---'}</span></span>
            </p>
          </div>
        </SheetRow>
      </div>

      <section
        className="@container mt-2 min-w-0 border-t border-[var(--color-border-default)] pt-3"
        aria-labelledby={`overview-market-title-${rowId}`}
        data-overview-market-column
      >
        <h3 id={`overview-market-title-${rowId}`} className="text-[13px] font-bold text-[var(--color-text-primary)]">市場データ・需給</h3>
        <div className="mt-1">
          <SheetRow level={4} label="市場データ">
            <dl className="m-0 grid grid-cols-2 gap-x-6 gap-y-2.5 @[46rem]:grid-cols-4">
              {items.map(({ label, value, detail, color }) => (
                <LedgerItem key={label} label={label} value={value} detail={detail} color={color} />
              ))}
            </dl>
          </SheetRow>
          {marketSnapshot}
        </div>
      </section>
    </div>
  )
}

/** 判断シートの1行。左の共通見出し軸(sm以上は固定幅)と横罫で読む。モバイルは見出しの下に内容を縦に流す */
function SheetRow({
  label,
  note,
  level = 3,
  children,
}: {
  label: string
  note?: string
  level?: 3 | 4
  children: ReactNode
}) {
  const Heading = level === 3 ? 'h3' : 'h4'
  return (
    <div className="grid min-w-0 gap-x-6 gap-y-1.5 border-t border-[var(--color-border-soft)] py-3 first:border-t-0 sm:grid-cols-[7.5rem_minmax(0,1fr)]">
      <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 sm:block">
        <Heading
          className={level === 3
            ? 'text-[12px] font-bold leading-5 text-[var(--color-text-primary)]'
            : 'text-[11px] font-bold leading-5 text-[var(--color-text-secondary)]'}
        >
          {label}
        </Heading>
        {note && <span className="block font-mono text-[10px] font-medium leading-4 text-[var(--color-text-tertiary)]">{note}</span>}
      </div>
      <div className="min-w-0">{children}</div>
    </div>
  )
}

/** 二次レイヤーの値。ラベルを上、数値(mono/tabular)を下に置き、列で比べる */
function LedgerItem({ label, value, detail, color }: { label: string; value: string; detail?: string; color?: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-[11px] font-medium text-[var(--color-text-tertiary)]">{label}</dt>
      <dd className="m-0 font-mono text-[13px] font-semibold tabular-nums" style={{ color: color ?? 'var(--color-text-primary)' }}>
        <span className="whitespace-nowrap">{value}</span>
        {detail && <span className="block text-[10px] font-medium text-[var(--color-text-tertiary)]">{detail}</span>}
      </dd>
    </div>
  )
}

function ConditionList({ conditions }: { conditions: string[] }) {
  return (
    <ul className="m-0 mt-0.5 grid gap-0.5 p-0">
      {conditions.map((condition) => (
        <li key={condition} className="flex gap-1.5 text-[11px] font-medium leading-5 text-[var(--color-text-secondary)]">
          <span className="mt-2 h-1 w-1 shrink-0 bg-[var(--color-text-tertiary)]" aria-hidden="true" />
          <span className="min-w-0">{condition}</span>
        </li>
      ))}
    </ul>
  )
}

/** 傾き(physical のMA角度)と終値の位置(stage-history のMA値)を同じ列で読む列定義。長期列だけ両者の期間が異なる */
const MA_SHEET_COLUMNS: Array<{ heading: string; angleKey: keyof MaAngleSet; angleLabel: string }> = [
  { heading: '5日', angleKey: 'ma5', angleLabel: '5MA' },
  { heading: '25日', angleKey: 'ma25', angleLabel: '25MA' },
  { heading: '75日', angleKey: 'ma75', angleLabel: '75MA' },
  { heading: '長期', angleKey: 'ma200', angleLabel: '200MA' },
]

/** 6軸Stageを日足・週足・月足の順に1本の連続リボンで並べる(区画の間は1px、時間軸の間だけ少し空ける) */
function StageRibbon({ stage }: { stage: SummaryStageEntry }) {
  return (
    <div className="grid max-w-[720px] grid-cols-3 gap-1" role="group" aria-label="6ステージ(日足・週足・月足 × A・B)" data-overview-stage-ribbon>
      {[0, 2, 4].map((start) => (
        <div key={start} role="group" aria-label={STAGE_TIMEFRAME_LABELS[start / 2]} className="min-w-0">
          <span className="mb-1 block text-[11px] font-bold text-[var(--color-text-secondary)]">{STAGE_TIMEFRAME_LABELS[start / 2]}</span>
          <div className="grid grid-cols-2 gap-px">
            {SUMMARY_STAGE_KEYS.slice(start, start + 2).map(({ key, label }) => (
              <SixStageCell key={key} label={label} stage={stage[key]} />
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}

function SixStageCell({ label, stage }: { label: string; stage: number | null }) {
  const validStage = normalizeStage(stage)
  const color = validStage ? STAGE_BORDER_COLORS[validStage] : 'var(--color-border-default)'
  const bg = validStage ? STAGE_BG_COLORS[validStage] : 'var(--color-surface-subtle)'
  const title = validStage ? STAGE_LABELS[validStage] : '未判定'
  return (
    <div
      title={`${label}: ${title}`}
      className="min-w-0 px-1 pb-1.5 pt-2 text-center"
      style={{ background: bg, boxShadow: `inset 0 3px 0 ${color}` }}
    >
      <span className="block text-[10px] font-bold leading-4 text-[var(--color-text-secondary)]">{label}</span>
      <strong className="block font-mono text-[15px] font-black leading-5 text-[var(--color-text-primary)]">
        {validStage ? `S${validStage}` : '-'}
      </strong>
      <span className="block text-[10px] font-semibold leading-tight text-[var(--color-text-secondary)] [word-break:keep-all]">
        <span className="sr-only">{title} </span>
        <span aria-hidden="true">{validStage ? shortStageLabel(validStage) : '不足'}</span>
      </span>
    </div>
  )
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

type EvidenceDirection = 'up' | 'down' | 'flat' | null

interface ShortTermEvidenceItem {
  label: string
  /** 結論文で使う短い名前 */
  name: string
  value: string
  direction: EvidenceDirection
}

interface ShortTermEvidenceSide {
  key: 'short' | 'medium'
  label: string
  items: ShortTermEvidenceItem[]
  up: number
  down: number
  direction: EvidenceDirection
}

// lib/short-term-check と同じ閾値・区分を表示用に参照する(判定そのものは buildShortTermCheck の結果を使う)
const SHORT_TERM_PFS_THRESHOLD = 0.8
const SHORT_TERM_CHANGE_THRESHOLD = 2
const SHORT_TERM_PMS_LEVEL = 0.35
const SHORT_TERM_STRONG_PCT = 40
const SHORT_TERM_LEAN_PCT = 14
const PHYSICS_UP_STATUSES = ['上昇加速', '上昇継続', '押し目形成', '反発準備']
const PHYSICS_DOWN_STATUSES = ['過熱注意', '失速警戒', '下落加速']

function stageSide(stage: number | null | undefined): EvidenceDirection {
  const value = normalizeStage(stage)
  if (value == null) return null
  if (value === 1 || value === 6) return 'up'
  if (value === 3 || value === 4) return 'down'
  return 'flat'
}

function tallyDirection(directions: EvidenceDirection[]): EvidenceDirection {
  const known = directions.filter((direction): direction is Exclude<EvidenceDirection, null> => direction != null)
  if (known.length === 0) return null
  const up = known.filter((direction) => direction === 'up').length
  const down = known.filter((direction) => direction === 'down').length
  return up > down ? 'up' : down > up ? 'down' : 'flat'
}

function thresholdDirection(value: number | null | undefined, threshold: number): EvidenceDirection {
  if (value == null || !Number.isFinite(value)) return null
  return value >= threshold ? 'up' : value <= -threshold ? 'down' : 'flat'
}

function stagePairText(a: number | null | undefined, b: number | null | undefined): string {
  return `S${normalizeStage(a) ?? '-'}・S${normalizeStage(b) ?? '-'}`
}

function directionGlyph(direction: EvidenceDirection): string {
  return direction === 'up' ? '▲' : direction === 'down' ? '▼' : direction === 'flat' ? '–' : '·'
}

function directionWord(direction: EvidenceDirection): string {
  return direction === 'up' ? '上向き' : direction === 'down' ? '下向き' : direction === 'flat' ? '中立' : '未取得'
}

function directionColor(direction: EvidenceDirection): string {
  return direction === 'up' ? 'var(--price-up)' : direction === 'down' ? 'var(--price-down)' : 'var(--color-text-tertiary)'
}

function upperStageText(stage: SummaryStageEntry): string {
  const upper = [stage.weekly_a_stage, stage.weekly_b_stage, stage.monthly_a_stage, stage.monthly_b_stage].map(stageSide)
  const positive = upper.filter((side) => side === 'up').length
  const negative = upper.filter((side) => side === 'down').length
  if (positive >= 3) return '強気整合'
  if (negative >= 3) return '弱気整合'
  if (positive > negative) return 'やや強い'
  if (negative > positive) return 'やや弱い'
  return '混在'
}

/** 短期チェックの入力を短期/中期に分け、向きと一致・不一致、判定が変わる境界を並べる */
function buildShortTermEvidence(
  stage: SummaryStageEntry | null,
  physical: PhysicalMomentumResponse | null,
  ml: BasicMlResponse | null,
  quote: StockQuote | null,
  decision: ReturnType<typeof buildBasicDecisionSummary>,
) {
  const latest = physical?.latest ?? null
  const status = ml?.physicsAnalysis?.physicsStatus ?? null
  const statusDirection: EvidenceDirection = status == null || status === '算出待ち'
    ? null
    : PHYSICS_UP_STATUSES.includes(status) ? 'up' : PHYSICS_DOWN_STATUSES.includes(status) ? 'down' : 'flat'
  const shortItems: ShortTermEvidenceItem[] = [
    {
      label: '日足Stage A・B',
      name: '日足Stage',
      value: stage ? stagePairText(stage.daily_a_stage, stage.daily_b_stage) : '—',
      direction: stage ? tallyDirection([stageSide(stage.daily_a_stage), stageSide(stage.daily_b_stage)]) : null,
    },
    {
      label: 'PFS 足元の力',
      name: 'PFS',
      value: formatDelta(latest?.physicalForceScore),
      direction: thresholdDirection(latest?.physicalForceScore, SHORT_TERM_PFS_THRESHOLD),
    },
    {
      label: '当日騰落',
      name: '当日騰落',
      value: fmtPct(quote?.changePercent),
      direction: thresholdDirection(quote?.changePercent, SHORT_TERM_CHANGE_THRESHOLD),
    },
    { label: '物理分類', name: '物理分類', value: status ?? '—', direction: statusDirection },
  ]
  const mediumItems: ShortTermEvidenceItem[] = [
    {
      label: '週足Stage A・B',
      name: '週足Stage',
      value: stage ? stagePairText(stage.weekly_a_stage, stage.weekly_b_stage) : '—',
      direction: stage ? tallyDirection([stageSide(stage.weekly_a_stage), stageSide(stage.weekly_b_stage)]) : null,
    },
    {
      label: '月足Stage A・B',
      name: '月足Stage',
      value: stage ? stagePairText(stage.monthly_a_stage, stage.monthly_b_stage) : '—',
      direction: stage ? tallyDirection([stageSide(stage.monthly_a_stage), stageSide(stage.monthly_b_stage)]) : null,
    },
    {
      label: 'PMS 20営業日',
      name: 'PMS',
      value: formatDelta(latest?.physicalMomentumScore),
      direction: thresholdDirection(latest?.physicalMomentumScore, SHORT_TERM_PMS_LEVEL),
    },
  ]
  const side = (key: ShortTermEvidenceSide['key'], label: string, items: ShortTermEvidenceItem[]): ShortTermEvidenceSide => ({
    key,
    label,
    items,
    up: items.filter((item) => item.direction === 'up').length,
    down: items.filter((item) => item.direction === 'down').length,
    direction: tallyDirection(items.map((item) => item.direction)),
  })
  const shortSide = side('short', '短期 日足・足元', shortItems)
  const mediumSide = side('medium', stage ? `中期 週・月足(上位足 ${upperStageText(stage)})` : '中期 週・月足', mediumItems)

  const agreement = shortSide.direction == null || mediumSide.direction == null
    ? { label: '判定材料なし', color: 'var(--color-text-tertiary)' }
    : shortSide.direction === mediumSide.direction && shortSide.direction !== 'flat'
      ? { label: `一致(ともに${directionWord(shortSide.direction)})`, color: directionColor(shortSide.direction) }
      : shortSide.direction !== 'flat' && mediumSide.direction !== 'flat'
        ? { label: `不一致(短期${directionGlyph(shortSide.direction)} 中期${directionGlyph(mediumSide.direction)})`, color: '#b45309' }
        : { label: `片方が中立(短期${directionGlyph(shortSide.direction)} 中期${directionGlyph(mediumSide.direction)})`, color: 'var(--color-text-secondary)' }

  const boundary: Record<string, string> = {
    強気優勢: `上昇強度が${SHORT_TERM_STRONG_PCT}%未満で「好転候補」`,
    好転候補: `上昇強度${SHORT_TERM_STRONG_PCT}%以上で「強気優勢」、${SHORT_TERM_LEAN_PCT}%未満で「中立」`,
    中立: `上昇強度${SHORT_TERM_LEAN_PCT}%以上で「好転候補」、下落圧力${SHORT_TERM_LEAN_PCT}%以上で「弱含み注意」`,
    弱含み注意: `下落圧力${SHORT_TERM_STRONG_PCT}%以上で「下落警戒」、${SHORT_TERM_LEAN_PCT}%未満で「中立」`,
    下落警戒: `下落圧力が${SHORT_TERM_STRONG_PCT}%未満で「弱含み注意」`,
  }
  const conditions: string[] = []
  if (boundary[decision.label]) conditions.push(boundary[decision.label])
  if (status && PHYSICS_DOWN_STATUSES.includes(status) && decision.label !== '下落警戒') {
    conditions.push(`物理分類「${status}」の間は上向き側の判定が抑えられる`)
  }
  const bearish = decision.label === '弱含み注意' || decision.label === '下落警戒'
  const bullish = decision.label === '強気優勢' || decision.label === '好転候補'
  if (bearish || bullish) {
    const aligned: EvidenceDirection = bearish ? 'down' : 'up'
    const daily = shortItems[0]
    const pfs = shortItems[1]
    if (daily.direction === aligned) conditions.push(`日足Stageが${bearish ? 'S3/S4' : 'S1/S6'}から外れる`)
    if (pfs.direction === aligned) {
      conditions.push(`PFS ${pfs.value}が${bearish ? `-${SHORT_TERM_PFS_THRESHOLD}を上回る` : `+${SHORT_TERM_PFS_THRESHOLD}を下回る`}`)
    }
    if (statusDirection === aligned && status) conditions.push(`物理分類「${status}」が変わる`)
  }

  const reading = shortSide.direction == null || mediumSide.direction == null
    ? null
    : `${shortTermSideReading('短期', shortSide)}。${shortTermSideReading('中期', mediumSide)}。`

  return { sides: [shortSide, mediumSide], agreement, reading, conditions: conditions.slice(0, 3) }
}

/** 根拠の向きを「何が支え、何が逆向き・中立か」の一文にまとめる(各項目の向き判定をそのまま使う) */
function shortTermSideReading(title: string, side: ShortTermEvidenceSide): string {
  const names = (direction: EvidenceDirection) => side.items.filter((item) => item.direction === direction).map((item) => item.name)
  const up = names('up')
  const down = names('down')
  const flat = names('flat')
  if (side.direction == null) return `${title}は判定材料なし`
  if (side.direction === 'flat') {
    return up.length === 0 && down.length === 0
      ? `${title}は向きを示す材料がなく中立`
      : `${title}は上向き(${up.join('・')})と下向き(${down.join('・')})が拮抗`
  }
  const lead = side.direction === 'up' ? up : down
  const opposite = side.direction === 'up' ? down : up
  const others = opposite.length + flat.length
  let text = `${title}は${lead.join('・')}${lead.length === 1 && others > 0 ? 'のみ' : ''}が${directionWord(side.direction)}`
  if (opposite.length > 0) text += `、${opposite.join('・')}は${directionWord(side.direction === 'up' ? 'down' : 'up')}`
  if (flat.length > 0) text += `、${flat.join('・')}は中立`
  return text
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

const basicStagePairStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
  gap: '3px',
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

const basicSignalEmbeddedStyle: CSSProperties = {
  paddingTop: '10px',
  borderTop: '1px solid var(--border-subtle)',
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

const basicDecisionLabelStyle: CSSProperties = {
  color: 'var(--text-muted)',
  fontSize: '10px',
  fontWeight: 800,
}
