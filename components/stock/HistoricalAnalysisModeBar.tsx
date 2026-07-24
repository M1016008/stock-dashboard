'use client'

import { useEffect, useMemo, useState } from 'react'
import {
  CalendarClock,
  ChevronLeft,
  ChevronRight,
  Eye,
  EyeOff,
  RotateCcw,
} from 'lucide-react'
import type { MarketCode } from '@/lib/markets'

export interface StockAnalysisReview {
  ok: boolean
  available: boolean
  ticker: string
  market: MarketCode
  requestedDate: string
  latestAvailableDate: string
  message?: string
  base: {
    date: string
    open: number
    high: number
    low: number
    close: number
    volume: number
    previousDate: string | null
    previousClose: number | null
    change: number | null
    changePercent: number | null
    fiftyTwoWeekHigh: number | null
    fiftyTwoWeekLow: number | null
  }
  adjacent: {
    previousDate: string | null
    nextDate: string | null
  }
  coverage: {
    price: string | null
    stage: string | null
    physicalMomentum: string | null
    feature: string | null
  }
  outcomes: Array<{
    horizonDays: number
    observedDays: number
    complete: boolean
    targetDate: string | null
    close: number | null
    returnPct: number | null
    maxReturnPct: number | null
    minReturnPct: number | null
  }>
}

interface HistoricalAnalysisModeBarProps {
  ticker: string
  market: MarketCode
  analysisDate: string | null
  latestDate?: string | null
  showActual: boolean
  onDateChange: (date: string | null) => void
  onShowActualChange: (show: boolean) => void
  onReviewChange?: (review: StockAnalysisReview | null) => void
}

function fmtPct(value: number | null): string {
  if (value == null || !Number.isFinite(value)) return '-'
  return `${value >= 0 ? '+' : ''}${value.toFixed(1)}%`
}

function outcomeTone(value: number | null): string {
  if (value == null || !Number.isFinite(value)) return 'text-[var(--color-text-tertiary)]'
  return value >= 0 ? 'text-[var(--color-market-red)]' : 'text-[var(--color-market-blue)]'
}

function CoverageItem({ label, date, baseDate }: { label: string; date: string | null; baseDate: string }) {
  const exact = date === baseDate
  return (
    <div className="min-w-0 border-l-2 border-[var(--color-border-default)] pl-2">
      <div className="text-[9px] font-black text-[var(--color-text-tertiary)]">{label}</div>
      <div className={`truncate font-mono text-[11px] font-black ${exact ? 'text-emerald-700' : 'text-amber-700'}`}>
        {date ?? '未取得'}
      </div>
    </div>
  )
}

export function HistoricalAnalysisModeBar({
  ticker,
  market,
  analysisDate,
  latestDate,
  showActual,
  onDateChange,
  onShowActualChange,
  onReviewChange,
}: HistoricalAnalysisModeBarProps) {
  const [draft, setDraft] = useState(analysisDate ?? '')
  const [review, setReview] = useState<StockAnalysisReview | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    setDraft(analysisDate ?? '')
  }, [analysisDate])

  useEffect(() => {
    if (!analysisDate) {
      setReview(null)
      setError('')
      onReviewChange?.(null)
      return
    }
    let cancelled = false
    setLoading(true)
    setError('')
    const params = new URLSearchParams({ market, date: analysisDate })
    fetch(`/api/stock-analysis-review/${encodeURIComponent(ticker)}?${params.toString()}`, { cache: 'no-store' })
      .then((response) => response.ok ? response.json() : Promise.reject(new Error(`HTTP ${response.status}`)))
      .then((payload: StockAnalysisReview) => {
        if (cancelled) return
        setReview(payload)
        onReviewChange?.(payload.available ? payload : null)
      })
      .catch((reason) => {
        if (cancelled) return
        setReview(null)
        setError(reason instanceof Error ? reason.message : String(reason))
        onReviewChange?.(null)
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => { cancelled = true }
  }, [analysisDate, market, onReviewChange, ticker])

  const completedOutcomes = useMemo(
    () => review?.outcomes.filter((outcome) => outcome.complete) ?? [],
    [review],
  )
  const resolvedDate = review?.base?.date ?? analysisDate

  function applyDate(date: string) {
    if (!date) return
    setDraft(date)
    onDateChange(date)
  }

  return (
    <section
      className={`border px-3 py-3 shadow-[0_1px_3px_rgba(16,32,52,0.08)] ${
        analysisDate
          ? 'border-amber-300 bg-amber-50'
          : 'border-[var(--color-border-default)] bg-white'
      }`}
      aria-label="過去時点で再分析"
    >
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex min-w-[220px] flex-1 items-start gap-2">
          <CalendarClock className={analysisDate ? 'mt-0.5 text-amber-700' : 'mt-0.5 text-[var(--color-brand-700)]'} size={18} />
          <div>
            <div className="text-[13px] font-black text-[var(--color-brand-900)]">
              {analysisDate ? '過去分析モード' : '過去時点で再分析'}
            </div>
            <p className="mt-0.5 text-[11px] font-semibold leading-5 text-[var(--color-text-secondary)]">
              {analysisDate
                ? `${resolvedDate}より後の情報を分析から除外しています。`
                : '当時までの価格・MA・6ステージ・PMS・MLだけで判断を再構成します。'}
            </p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          {analysisDate && (
            <button
              type="button"
              title="前の取引日"
              aria-label="前の取引日"
              disabled={!review?.adjacent.previousDate}
              onClick={() => review?.adjacent.previousDate && applyDate(review.adjacent.previousDate)}
              className="inline-flex size-9 items-center justify-center border border-amber-300 bg-white text-amber-800 disabled:cursor-not-allowed disabled:opacity-35"
            >
              <ChevronLeft size={16} />
            </button>
          )}
          <input
            type="date"
            value={draft}
            max={latestDate ?? undefined}
            onChange={(event) => setDraft(event.target.value)}
            className="h-9 border border-[var(--color-border-default)] bg-white px-2.5 font-mono text-[12px] font-bold text-[var(--color-brand-900)]"
            aria-label="分析基準日"
          />
          <button
            type="button"
            disabled={!draft}
            onClick={() => applyDate(draft)}
            className="h-9 border border-[var(--color-brand-900)] bg-[var(--color-brand-900)] px-3 text-[11px] font-black text-white disabled:opacity-40"
          >
            この日で再分析
          </button>
          {analysisDate && (
            <>
              <button
                type="button"
                title="次の取引日"
                aria-label="次の取引日"
                disabled={!review?.adjacent.nextDate}
                onClick={() => review?.adjacent.nextDate && applyDate(review.adjacent.nextDate)}
                className="inline-flex size-9 items-center justify-center border border-amber-300 bg-white text-amber-800 disabled:cursor-not-allowed disabled:opacity-35"
              >
                <ChevronRight size={16} />
              </button>
              <button
                type="button"
                onClick={() => {
                  setDraft('')
                  onShowActualChange(false)
                  onDateChange(null)
                }}
                className="inline-flex h-9 items-center gap-1.5 border border-[var(--color-border-default)] bg-white px-3 text-[11px] font-black text-[var(--color-text-secondary)]"
              >
                <RotateCcw size={14} />
                最新に戻す
              </button>
            </>
          )}
        </div>
      </div>

      {analysisDate && (
        <div className="mt-3 border-t border-amber-200 pt-3">
          {loading ? (
            <div className="text-[11px] font-bold text-amber-800">基準日のデータ整合性を確認中...</div>
          ) : error ? (
            <div className="text-[11px] font-bold text-red-700">基準日データの確認に失敗しました: {error}</div>
          ) : !review?.available ? (
            <div className="text-[11px] font-bold text-amber-800">{review?.message ?? '指定日以前のデータがありません。'}</div>
          ) : (
            <>
              <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
                <CoverageItem label="価格・MA" date={review.coverage.price} baseDate={review.base.date} />
                <CoverageItem label="6ステージ" date={review.coverage.stage} baseDate={review.base.date} />
                <CoverageItem label="PMS / PFS / PES" date={review.coverage.physicalMomentum} baseDate={review.base.date} />
                <CoverageItem label="ML特徴量" date={review.coverage.feature} baseDate={review.base.date} />
              </div>

              <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-amber-200 pt-3">
                <div className="text-[10px] font-bold leading-5 text-amber-900">
                  決算予定・信用残・企業属性は現在情報として分離し、過去分析の判断材料には含めません。
                </div>
                <button
                  type="button"
                  disabled={review.outcomes.every((outcome) => outcome.observedDays === 0)}
                  onClick={() => onShowActualChange(!showActual)}
                  className={`inline-flex h-8 items-center gap-1.5 border px-2.5 text-[10px] font-black ${
                    showActual
                      ? 'border-emerald-400 bg-emerald-700 text-white'
                      : 'border-amber-300 bg-white text-amber-900'
                  } disabled:cursor-not-allowed disabled:opacity-40`}
                >
                  {showActual ? <EyeOff size={13} /> : <Eye size={13} />}
                  {showActual ? '事後実績を隠す' : 'この日以降の実績を開く'}
                </button>
              </div>

              {showActual && (
                <div className="mt-3 overflow-x-auto border border-emerald-200 bg-white">
                  <div className="border-b border-emerald-100 bg-emerald-50 px-3 py-2 text-[10px] font-bold leading-5 text-emerald-900">
                    事後実績は検証専用です。シナリオ、類似局面検索、AI回答の入力には使用していません。
                  </div>
                  <div className="grid min-w-[760px] grid-cols-8">
                    {review.outcomes.map((outcome) => (
                      <div key={outcome.horizonDays} className="border-r border-emerald-100 px-2 py-2 text-center last:border-r-0">
                        <div className="text-[9px] font-black text-[var(--color-text-tertiary)]">{outcome.horizonDays}営業日</div>
                        <div className={`mt-1 font-mono text-[13px] font-black ${outcomeTone(outcome.returnPct)}`}>
                          {fmtPct(outcome.returnPct)}
                        </div>
                        <div className="mt-1 text-[9px] font-bold text-[var(--color-text-tertiary)]">
                          {outcome.complete ? outcome.targetDate : `${outcome.observedDays}日まで`}
                        </div>
                        <div className="mt-1 text-[9px] font-bold text-[var(--color-text-secondary)]">
                          高 {fmtPct(outcome.maxReturnPct)} / 低 {fmtPct(outcome.minReturnPct)}
                        </div>
                      </div>
                    ))}
                  </div>
                  <div className="border-t border-emerald-100 px-3 py-1.5 text-[9px] font-bold text-[var(--color-text-tertiary)]">
                    完了期間 {completedOutcomes.length}/8 / 終値ベース、期間内高値・安値も併記
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      )}
    </section>
  )
}
