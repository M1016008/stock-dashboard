'use client'

import Link from 'next/link'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { ArrowLeft, BarChart3, CalendarDays, Loader2 } from 'lucide-react'
import { CandlestickChart } from '@/components/charts/CandlestickChart'
import { Card, CardHeader } from '@/components/ui/Card'
import { PriceDisplay } from '@/components/ui/PriceDisplay'
import { StageTimeline } from '@/components/stock/StageTimeline'
import { ScenarioProjectionChart } from '@/components/stock/ScenarioProjectionChart'
import { StockScenarioAiPanel } from '@/components/stock/StockScenarioAiPanel'
import { StockMovePeriods } from '@/components/stock/StockMovePeriods'
import { TradeScenarioNotebook } from '@/components/stock/TradeScenarioNotebook'
import type { StockQuote } from '@/types/stock'
import { buildPhysicalMomentumView, type PhysicalMomentumTone } from '@/lib/physical-momentum-view'
import { buildShortTermCheck, type ShortTermCheckResult } from '@/lib/short-term-check'

type Status = 'idle' | 'loading' | 'ready' | 'error'

interface PhysicalMomentumApiRow {
  date: string
  physicalMomentumScore: number | null
  physicalForceScore: number | null
  physicalEnergyScore: number | null
  velocity: number | null
  acceleration: number | null
  momentum?: number | null
  force: number | null
  ma5Angle?: number | null
  ma25Angle?: number | null
  ma75Angle?: number | null
  ma200Angle?: number | null
  maAngleAvg?: number | null
  energy: number | null
}

interface PhysicalMomentumResponse {
  latest: PhysicalMomentumApiRow | null
  history: PhysicalMomentumApiRow[]
  rank: number | null
  totalRanked: number
  trend: 'rising' | 'falling' | 'flat' | null
  source?: 'main' | 'us_analytics'
  requestedDate?: string | null
}

interface UsPhysicalPlanLevel {
  label: string
  value: number | null
  distancePct: number | null
}

interface UsPhysicalPlanLevels {
  baseDate: string
  close: number
  support: UsPhysicalPlanLevel
  resistance: UsPhysicalPlanLevel
  breakdown: UsPhysicalPlanLevel
}

interface UsPhysicalPlanCandidate {
  direction: 'up' | 'down' | 'wait'
  rank: number
  score: number
  asOfDate: string
}

interface UsPhysicalPlanHorizon {
  label: string
  horizonDays: number
  description: string
  statusLabel: string
  targetDirection: 'up' | 'down' | 'wait' | null
  hitRate: number | null
  baseRate: number | null
  lift: number | null
  avgMaxReturnPct: number | null
  avgMinReturnPct: number | null
  sampleCount: number | null
  evaluationDate: string | null
  confidenceLabel: string
  candidates: UsPhysicalPlanCandidate[]
  levels: UsPhysicalPlanLevels | null
  suggestion: {
    tone: 'positive' | 'negative' | 'neutral' | 'warning'
    stance: string
    headline: string
    summary: string
    checklist: string[]
    invalidation: string
  }
}

interface UsPhysicalPlanResponse {
  ok: boolean
  available: boolean
  market?: string
  ticker: string
  featureAsOfDate?: string | null
  priceAsOfDate?: string | null
  note?: string
  horizons: UsPhysicalPlanHorizon[]
}

interface StageHistoryEntry {
  daily_a_stage: number | null
  daily_b_stage: number | null
  weekly_a_stage: number | null
  weekly_b_stage: number | null
  monthly_a_stage: number | null
  monthly_b_stage: number | null
}

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

function fmtScore(value: number | null | undefined) {
  if (value == null || !Number.isFinite(value)) return '-'
  return value.toFixed(2)
}

function fmtRate(value: number | null | undefined) {
  if (value == null || !Number.isFinite(value)) return '-'
  return `${(value * 100).toFixed(1)}%`
}

function fmtPctRaw(value: number | null | undefined) {
  if (value == null || !Number.isFinite(value)) return '-'
  return `${value >= 0 ? '+' : ''}${value.toFixed(1)}%`
}

function fmtUsd(value: number | null | undefined) {
  if (value == null || !Number.isFinite(value)) return '-'
  return `$${value.toLocaleString('en-US', { maximumFractionDigits: value >= 100 ? 1 : 2 })}`
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-[4px] border border-[var(--color-border-default)] bg-[var(--color-surface-subtle)] px-3 py-2">
      <div className="text-[10px] font-bold text-[var(--color-text-tertiary)]">{label}</div>
      <div className="mt-1 text-[14px] font-bold text-[var(--color-brand-900)]">{value}</div>
    </div>
  )
}

function momentumTonePanelClass(tone: PhysicalMomentumTone) {
  if (tone === 'up') return 'border-red-200 bg-red-50 text-red-700'
  if (tone === 'down') return 'border-blue-200 bg-blue-50 text-blue-700'
  if (tone === 'warning') return 'border-amber-200 bg-amber-50 text-amber-800'
  return 'border-[var(--color-border-default)] bg-[var(--color-surface-subtle)] text-[var(--color-text-secondary)]'
}

function momentumToneMiniClass(tone: PhysicalMomentumTone) {
  if (tone === 'up') return 'border-red-200 bg-red-50 text-red-800'
  if (tone === 'down') return 'border-blue-200 bg-blue-50 text-blue-800'
  if (tone === 'warning') return 'border-amber-200 bg-amber-50 text-amber-800'
  return 'border-[var(--color-border-default)] bg-white text-[var(--color-text-secondary)]'
}

function shortTermPanelClass(label: string) {
  if (label === '強気優勢') return 'border-red-200 bg-white/70 text-red-800'
  if (label === '好転候補') return 'border-rose-200 bg-white/70 text-rose-800'
  if (label === '弱含み注意') return 'border-blue-200 bg-white/70 text-blue-800'
  if (label === '下落警戒') return 'border-sky-200 bg-white/70 text-sky-900'
  return 'border-[var(--color-border-default)] bg-white/70 text-[var(--color-text-secondary)]'
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
  const [analysisDate, setAnalysisDate] = useState<string | null>(null)

  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const date = params.get('date')
    setAnalysisDate(date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : null)
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
    setAnalysisDate(date)
    const url = new URL(window.location.href)
    if (date) {
      url.searchParams.set('date', date)
    } else {
      url.searchParams.delete('date')
    }
    window.history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`)
  }, [])

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
            change={quote.isPriceDiscontinuous ? undefined : quote.change}
            changePercent={quote.isPriceDiscontinuous ? undefined : quote.changePercent}
            currency="USD"
            size="xl"
          />
          <div className="mt-1 text-[11px] font-semibold text-[var(--color-text-tertiary)]">
            米国株ワークスペース{quote.priceDate ? ` / 価格日 ${quote.priceDate}` : ''}
          </div>
          {quote.priceQualityWarning && (
            <div className="mt-2 max-w-[360px] rounded-[4px] border border-amber-200 bg-amber-50 px-3 py-2 text-left text-[11px] font-bold leading-5 text-amber-800">
              {quote.priceQualityWarning}
            </div>
          )}
        </div>
      </div>

      <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="出来高" value={fmtNumber(quote.volume)} />
        <Stat label="時価総額" value={fmtMoney(quote.marketCap)} />
        <Stat label="52週高値" value={quote.fiftyTwoWeekHigh == null ? '-' : `$${quote.fiftyTwoWeekHigh.toFixed(2)}`} />
        <Stat label="52週安値" value={quote.fiftyTwoWeekLow == null ? '-' : `$${quote.fiftyTwoWeekLow.toFixed(2)}`} />
      </section>

      <UsAnalysisDateControl analysisDate={analysisDate} onChange={updateAnalysisDate} />

      <UsPhysicalMomentumSection
        ticker={quote.ticker}
        analysisDate={analysisDate}
        changePercent={quote.isPriceDiscontinuous ? null : quote.changePercent}
      />

      <UsPhysicalPlanSection ticker={quote.ticker} analysisDate={analysisDate} />

      <TradeScenarioNotebook
        ticker={quote.ticker}
        market="US"
        name={quote.name ?? quote.ticker}
        quote={quote}
        selectedRange={null}
        context={{
          exchange: quote.exchange,
          currency: quote.currency,
          source: 'Tiingo EOD',
        }}
      />

      <Card size="lg">
        <CardHeader title="ステージ変遷" hint="日足A/B・週足A/B・月足A/B" />
        <StageTimeline ticker={quote.ticker} market="US" />
      </Card>

      <Card size="lg">
        <CardHeader title="マルチタイムフレームチャート" hint="日足・2日足・週足・2週足・月足・2ヶ月足" />
        <CandlestickChart
          ticker={quote.ticker}
          market="US"
          interval="D"
          height={460}
          historyPeriod="all"
          showTimeframeSelector
          maLinesByInterval={{
            D: [5, 25, 75, 200],
            '2D': [5, 25, 75, 200],
            W: [5, 25, 75, 200],
            '2W': [5, 25, 75, 200],
            M: [5, 25, 75, 200],
            '2M': [5, 25, 75, 200],
          }}
        />
      </Card>

      <ScenarioProjectionChart ticker={quote.ticker} market="US" name={quote.name ?? quote.ticker} analysisDate={analysisDate} />

      <StockMovePeriods ticker={quote.ticker} market="US" />

      <StockScenarioAiPanel ticker={quote.ticker} market="US" name={quote.name ?? quote.ticker} analysisDate={analysisDate} />

      <Card>
        <CardHeader title="US ML連携ステータス" hint="日本株と同じUI枠で、US分析データがあるものから順次表示します。" />
        <div className="grid gap-3 text-[12px] font-semibold text-[var(--color-text-secondary)] md:grid-cols-3">
          <div className="rounded-[4px] border border-[var(--color-border-default)] bg-[var(--color-surface-subtle)] p-3">
            価格・チャート・6ステージは `market_ohlcv_daily` / `market_daily_snapshots` のUSデータを直接参照します。
          </div>
          <div className="rounded-[4px] border border-[var(--color-border-default)] bg-[var(--color-surface-subtle)] p-3">
            PMS/PFS/PESはUS分析DBで日本株ML互換パイプラインを回した結果を優先表示します。
          </div>
          <div className="rounded-[4px] border border-[var(--color-border-default)] bg-[var(--color-surface-subtle)] p-3">
            類似候補・物理MLランキング・観察プランはUS特徴量生成済みの範囲から反映します。未生成時も価格・MA・ステージ表示は維持します。
          </div>
        </div>
      </Card>
    </div>
  )
}

function UsAnalysisDateControl({
  analysisDate,
  onChange,
}: {
  analysisDate: string | null
  onChange: (date: string | null) => void
}) {
  const [draft, setDraft] = useState(analysisDate ?? '')

  useEffect(() => {
    setDraft(analysisDate ?? '')
  }, [analysisDate])

  return (
    <Card>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="inline-flex items-center gap-2 text-[13px] font-black text-[var(--color-brand-900)]">
            <CalendarDays size={15} /> シナリオ・AI分析基準日
          </div>
          <p className="mt-1 text-[12px] font-semibold leading-6 text-[var(--color-text-secondary)]">
            日付を指定すると、その日付以前のUS価格・PMS・ステージでシナリオとAI回答を再構成します。
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <input
            type="date"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            className="h-9 rounded-[4px] border border-[var(--color-border-default)] bg-white px-3 text-[12px] font-bold text-[var(--color-brand-900)]"
          />
          <button
            type="button"
            onClick={() => onChange(draft || null)}
            className="h-9 rounded-[4px] bg-[var(--color-brand-900)] px-3 text-[12px] font-black text-white"
          >
            反映
          </button>
          <button
            type="button"
            onClick={() => {
              setDraft('')
              onChange(null)
            }}
            className="h-9 rounded-[4px] border border-[var(--color-border-default)] bg-white px-3 text-[12px] font-black text-[var(--color-text-secondary)]"
          >
            最新
          </button>
          <span className="rounded-full border border-[var(--color-border-default)] bg-[var(--color-surface-subtle)] px-3 py-2 text-[11px] font-black text-[var(--color-text-secondary)]">
            {analysisDate ? `${analysisDate}時点` : '最新時点'}
          </span>
        </div>
      </div>
    </Card>
  )
}

function UsPhysicalMomentumSection({
  ticker,
  analysisDate,
  changePercent,
}: {
  ticker: string
  analysisDate: string | null
  changePercent: number | null | undefined
}) {
  const [data, setData] = useState<PhysicalMomentumResponse | null>(null)
  const [stageLatest, setStageLatest] = useState<StageHistoryEntry | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError('')
    const params = new URLSearchParams({ market: 'US', limit: '260' })
    if (analysisDate) params.set('date', analysisDate)
    const stageParams = new URLSearchParams({ market: 'US', granularity: 'daily', count: '1' })
    if (analysisDate) {
      stageParams.set('startDate', '1900-01-01')
      stageParams.set('endDate', analysisDate)
    }
    Promise.allSettled([
      fetch(`/api/physical-momentum/${encodeURIComponent(ticker)}?${params.toString()}`, { cache: 'no-store' })
        .then((res) => res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`))),
      fetch(`/api/stage-history/${encodeURIComponent(ticker)}?${stageParams.toString()}`, { cache: 'no-store' })
        .then((res) => res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`))),
    ])
      .then(([momentumResult, stageResult]) => {
        if (cancelled) return
        if (momentumResult.status === 'fulfilled') {
          setData(momentumResult.value)
        } else {
          setError((momentumResult.reason as Error).message)
        }
        if (stageResult.status === 'fulfilled') {
          const history = Array.isArray(stageResult.value?.history) ? stageResult.value.history : []
          setStageLatest(history[history.length - 1] ?? null)
        } else {
          setStageLatest(null)
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => { cancelled = true }
  }, [ticker, analysisDate])

  const latest = data?.latest ?? null
  const view = latest ? buildPhysicalMomentumView({
    pms: latest.physicalMomentumScore,
    pfs: latest.physicalForceScore,
    pes: latest.physicalEnergyScore,
    trend: data?.trend ?? null,
    rank: data?.rank ?? null,
    total: data?.totalRanked ?? 0,
  }) : null
  const shortTermCheck: ShortTermCheckResult | null = latest ? buildShortTermCheck({
    stages: stageLatest ? {
      dailyA: stageLatest.daily_a_stage,
      dailyB: stageLatest.daily_b_stage,
      weeklyA: stageLatest.weekly_a_stage,
      weeklyB: stageLatest.weekly_b_stage,
      monthlyA: stageLatest.monthly_a_stage,
      monthlyB: stageLatest.monthly_b_stage,
    } : null,
    physicalMomentumScore: latest.physicalMomentumScore,
    physicalForceScore: latest.physicalForceScore,
    changePercent,
  }) : null

  return (
    <Card>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="inline-flex items-center gap-2 text-[13px] font-black text-[var(--color-brand-900)]">
            <BarChart3 size={15} /> Physical Momentum
          </div>
          <p className="mt-1 text-[12px] font-semibold leading-6 text-[var(--color-text-secondary)]">
            US市場内で標準化した速度・加速度・力・熱量から、現在の運動状態を読みます。
            {data?.source === 'us_analytics' ? ' US分析DBの学習用データを参照しています。' : ''}
          </p>
        </div>
        {latest && <span className="rounded-full border border-[var(--color-border-default)] bg-white px-3 py-1 text-[11px] font-black text-[var(--color-text-secondary)]">{latest.date}</span>}
      </div>
      {loading ? (
        <p className="mt-3 text-[12px] font-bold text-[var(--color-text-tertiary)]">PMSを読込中...</p>
      ) : error ? (
        <p className="mt-3 text-[12px] font-bold text-[var(--color-market-blue)]">PMS取得エラー: {error}</p>
      ) : !latest ? (
        <p className="mt-3 text-[12px] font-bold text-[var(--color-text-tertiary)]">
          US PMSは未計算です。US physical momentum バッチ生成後にここへ表示されます。
        </p>
      ) : (
        <div className="mt-3 grid gap-3 lg:grid-cols-[1.15fr_1.85fr]">
          <div className={`rounded-[6px] border p-4 ${momentumTonePanelClass(view?.tone ?? 'neutral')}`}>
            <div className="text-[11px] font-black opacity-75">総合判定</div>
            <div className="mt-1 text-[20px] font-black">{view?.label ?? '方向待ち'}</div>
            <p className="mt-2 text-[12px] font-bold leading-6">
              {view?.summary}
            </p>
            <div className="mt-3 flex flex-wrap gap-1.5">
              {view?.badges.map((badge) => (
                <span key={badge} className="rounded-full border border-current/20 bg-white/70 px-2 py-1 text-[10px] font-black">
                  {badge}
                </span>
              ))}
            </div>
            {shortTermCheck && (
              <div className={`mt-3 rounded-[5px] border px-3 py-2 ${shortTermPanelClass(shortTermCheck.label)}`}>
                <div className="text-[10px] font-black opacity-75">短期チェック</div>
                <div className="mt-0.5 text-[14px] font-black">{shortTermCheck.label}</div>
                <p className="mt-1 text-[11px] font-bold leading-5">{shortTermCheck.description}</p>
              </div>
            )}
          </div>
          <div className="grid gap-3">
            <div className="grid gap-2 sm:grid-cols-3">
              <Stat label="PMS 総合の力" value={fmtScore(latest.physicalMomentumScore)} />
              <Stat label="PFS 初動/失速" value={fmtScore(latest.physicalForceScore)} />
              <Stat label="PES 熱量" value={fmtScore(latest.physicalEnergyScore)} />
            </div>
            <div>
              <div className="text-[13px] font-black text-[var(--color-text-primary)]">だから、どう見る？</div>
              <p className="mt-1 text-[11px] font-bold leading-5 text-[var(--color-text-tertiary)]">
                数字をそのまま読ませず、次に確認する行動条件へ変換しています。
              </p>
            </div>
            <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
              {view?.checks.map((check) => (
                <div key={`${check.label}-${check.text}`} className={`rounded-[6px] border p-3 ${momentumToneMiniClass(check.tone)}`}>
                  <div className="text-[10px] font-black opacity-75">{check.label}</div>
                  <div className="mt-1 text-[12px] font-black leading-5">{check.text}</div>
                </div>
              ))}
            </div>
            <div className="grid gap-2 sm:grid-cols-3">
              <Stat label="Velocity" value={fmtScore(latest.velocity)} />
              <Stat label="Acceleration" value={fmtScore(latest.acceleration)} />
              <Stat label="Force" value={fmtScore(latest.force)} />
            </div>
          </div>
        </div>
      )}
    </Card>
  )
}

function UsPhysicalPlanSection({ ticker, analysisDate }: { ticker: string; analysisDate: string | null }) {
  const [plan, setPlan] = useState<UsPhysicalPlanResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError('')
    const params = new URLSearchParams({ market: 'US' })
    if (analysisDate) params.set('date', analysisDate)
    fetch(`/api/stock-physical-plan/${encodeURIComponent(ticker)}?${params.toString()}`, { cache: 'no-store' })
      .then((res) => res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`)))
      .then((payload) => {
        if (!cancelled) setPlan(payload)
      })
      .catch((e) => {
        if (!cancelled) setError((e as Error).message)
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => { cancelled = true }
  }, [ticker, analysisDate])

  return (
    <Card size="lg">
      <CardHeader
        title="短期・中期・長期の観察プラン"
        hint="US物理ML・PMS・過去検証から、価格ラインと確認条件に変換"
      />
      {loading ? (
        <div className="grid gap-3 lg:grid-cols-3">
          {['短期', '中期', '長期'].map((label) => (
            <div key={label} className="min-h-[180px] rounded-[6px] border border-[var(--color-border-default)] bg-[var(--color-surface-subtle)] p-4">
              <div className="text-[12px] font-black text-[var(--color-text-tertiary)]">{label}</div>
            </div>
          ))}
        </div>
      ) : error ? (
        <p className="text-[12px] font-bold text-[var(--color-market-blue)]">観察プラン取得エラー: {error}</p>
      ) : !plan?.available || plan.horizons.length === 0 ? (
        <div className="rounded-[6px] border border-[var(--color-border-default)] bg-[var(--color-surface-subtle)] p-4 text-[12px] font-bold leading-6 text-[var(--color-text-secondary)]">
          US物理ML特徴量がまだ不足しています。US MLバッチ完了後に、短期・中期・長期の観察プランを表示します。
        </div>
      ) : (
        <div className="grid gap-3 lg:grid-cols-3">
          {plan.horizons.map((horizon) => (
            <UsPhysicalPlanCard key={`${horizon.label}-${horizon.horizonDays}`} horizon={horizon} />
          ))}
        </div>
      )}
      {plan?.available && (
        <div className="mt-3 flex flex-wrap items-center gap-2 text-[11px] font-bold text-[var(--color-text-tertiary)]">
          <span>特徴量: {plan.featureAsOfDate ?? '-'}</span>
          <span>価格: {plan.priceAsOfDate ?? '-'}</span>
          <span>{analysisDate ? `${analysisDate}時点で再構成` : '最新データで再構成'}</span>
        </div>
      )}
    </Card>
  )
}

function UsPhysicalPlanCard({ horizon }: { horizon: UsPhysicalPlanHorizon }) {
  const toneClass =
    horizon.suggestion.tone === 'positive'
      ? 'border-red-200 bg-red-50'
      : horizon.suggestion.tone === 'negative'
        ? 'border-blue-200 bg-blue-50'
        : horizon.suggestion.tone === 'warning'
          ? 'border-amber-200 bg-amber-50'
          : 'border-[var(--color-border-default)] bg-white'
  const headlineClass =
    horizon.suggestion.tone === 'positive'
      ? 'text-red-700'
      : horizon.suggestion.tone === 'negative'
        ? 'text-blue-700'
        : horizon.suggestion.tone === 'warning'
          ? 'text-amber-700'
          : 'text-[var(--color-brand-900)]'
  const dotClass =
    horizon.suggestion.tone === 'positive'
      ? 'bg-red-600'
      : horizon.suggestion.tone === 'negative'
        ? 'bg-blue-600'
        : horizon.suggestion.tone === 'warning'
          ? 'bg-amber-600'
          : 'bg-[var(--color-brand-900)]'
  const topCandidates = horizon.candidates.slice().sort((a, b) => a.rank - b.rank).slice(0, 3)

  return (
    <article className={`rounded-[6px] border p-4 ${toneClass}`}>
      <div className="flex items-start justify-between gap-2">
        <div>
          <div className="text-[11px] font-black text-[var(--color-text-tertiary)]">{horizon.label}</div>
          <h3 className={`mt-1 text-[16px] font-black leading-6 ${headlineClass}`}>
            {horizon.suggestion.headline}
          </h3>
        </div>
        <span className="shrink-0 rounded-full border border-current bg-white/70 px-2 py-1 text-[10px] font-black text-[var(--color-text-secondary)]">
          {horizon.horizonDays}営業日
        </span>
      </div>
      <p className="mt-2 text-[12px] font-bold leading-6 text-[var(--color-brand-900)]">{horizon.suggestion.stance}</p>
      <UsPhysicalPlanLevels levels={horizon.levels} />
      <div className="mt-3 grid grid-cols-3 gap-2">
        <Stat label="的中率" value={fmtRate(horizon.hitRate)} />
        <Stat label="Lift" value={horizon.lift == null ? '-' : horizon.lift.toFixed(2)} />
        <Stat label="順行/逆行" value={`${fmtPctRaw(horizon.avgMaxReturnPct)} / ${fmtPctRaw(horizon.avgMinReturnPct)}`} />
      </div>
      <p className="mt-3 text-[12px] font-semibold leading-6 text-[var(--color-text-secondary)]">
        {horizon.suggestion.summary}
      </p>
      <div className="mt-3 space-y-2">
        {horizon.suggestion.checklist.slice(0, 3).map((item) => (
          <div key={item} className="flex gap-2 text-[12px] font-bold leading-6 text-[var(--color-brand-900)]">
            <span className={`mt-[9px] h-2 w-2 shrink-0 rounded-full ${dotClass}`} />
            <span>{item}</span>
          </div>
        ))}
      </div>
      <div className="mt-3 rounded-[4px] border border-[var(--color-border-default)] bg-white/80 p-3 text-[11px] font-bold leading-5 text-[var(--color-text-secondary)]">
        <strong className="block text-[var(--color-brand-900)]">崩れる条件</strong>
        {horizon.suggestion.invalidation}
      </div>
      <div className="mt-3 flex flex-wrap gap-2">
        {topCandidates.length > 0 ? topCandidates.map((candidate) => (
          <span key={`${candidate.direction}-${candidate.rank}`} className="rounded-full border border-[var(--color-border-default)] bg-white px-2 py-1 text-[10px] font-black text-[var(--color-text-secondary)]">
            {candidate.direction === 'up' ? '上昇' : candidate.direction === 'down' ? '下落' : '待機'} #{candidate.rank}
          </span>
        )) : (
          <span className="rounded-full border border-[var(--color-border-default)] bg-white px-2 py-1 text-[10px] font-black text-[var(--color-text-secondary)]">
            物理ML上位外
          </span>
        )}
        {horizon.sampleCount != null && (
          <span className="rounded-full border border-[var(--color-border-default)] bg-white px-2 py-1 text-[10px] font-black text-[var(--color-text-secondary)]">
            検証 n={horizon.sampleCount.toLocaleString('en-US')}
          </span>
        )}
      </div>
      <div className="mt-3 flex justify-between gap-2 text-[10px] font-bold text-[var(--color-text-tertiary)]">
        <span>{horizon.confidenceLabel}</span>
        <span>{horizon.evaluationDate ? `検証 ${horizon.evaluationDate}` : '検証日 -'}</span>
      </div>
    </article>
  )
}

function UsPhysicalPlanLevels({ levels }: { levels: UsPhysicalPlanLevels | null }) {
  if (!levels) return null
  return (
    <div className="mt-3 grid grid-cols-2 gap-2">
      <UsPhysicalPlanLevel label="基準" level={{ label: levels.baseDate, value: levels.close, distancePct: 0 }} />
      <UsPhysicalPlanLevel label="支持/反発" level={levels.support} />
      <UsPhysicalPlanLevel label="抵抗/反落" level={levels.resistance} />
      <UsPhysicalPlanLevel label="割れ注意" level={levels.breakdown} />
    </div>
  )
}

function UsPhysicalPlanLevel({ label, level }: { label: string; level: UsPhysicalPlanLevel }) {
  return (
    <div className="rounded-[4px] border border-[var(--color-border-default)] bg-white/80 px-3 py-2">
      <div className="text-[10px] font-black text-[var(--color-text-tertiary)]">{label}</div>
      <div className="mt-1 text-[14px] font-black text-[var(--color-brand-900)]">{fmtUsd(level.value)}</div>
      <div className="mt-0.5 truncate text-[10px] font-bold text-[var(--color-text-secondary)]">
        {level.label}{level.distancePct != null ? ` ${fmtPctRaw(level.distancePct)}` : ''}
      </div>
    </div>
  )
}
