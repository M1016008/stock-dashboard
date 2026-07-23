'use client'

import Link from 'next/link'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { BarChart3, RefreshCw, ScanSearch } from 'lucide-react'
import {
  CartesianGrid,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import { StageTag } from '@/components/ui/StageTag'
import type { HistoricalAnalogSort } from '@/lib/ml/historical-analogs'

type Market = 'JP' | 'US'

type AnalogPoint = {
  afterDays: number
  date: string
  value: number
  stageCode: string | null
}

type AnalogRow = {
  rank: number
  ticker: string
  name: string | null
  marketSegment: string | null
  sector17Name: string | null
  sector33Name: string | null
  caseDate: string
  stageCode: string | null
  similarityScore: number
  structuralScore: number
  vectorScore: number
  outcome: {
    horizonDays: number
    returnPct: number | null
    maxReturnPct: number | null
    minReturnPct: number | null
  }
  components: Array<{
    key: string
    label: string
    score: number
    weight: number
  }>
  path: AnalogPoint[]
  stagePath: string[]
}

type AnalogResponse = {
  market: Market
  ticker: string
  asOfDate: string
  featureSet: string
  base: {
    ticker: string
    name: string | null
    date: string
    stageCode: string | null
  }
  horizon: number
  sort: HistoricalAnalogSort
  minScore: number
  summary: {
    sampleCount: number
    upRate: number | null
    averageReturnPct: number | null
    medianReturnPct: number | null
    lowerQuartileReturnPct: number | null
    upperQuartileReturnPct: number | null
    averageMaxReturnPct: number | null
    averageMinReturnPct: number | null
  }
  analogs: AnalogRow[]
  search: {
    method: string
    stageDistance: number
    stageNeighborCount: number
    candidateCount: number
    scoredCount: number
    coverageFrom: string | null
    coverageTo: string | null
    matchedFrom: string | null
    matchedTo: string | null
    truncated: boolean
  }
}

const HORIZONS = [
  { days: 5, label: '1週間' },
  { days: 10, label: '2週間' },
  { days: 15, label: '3週間' },
  { days: 20, label: '1か月' },
  { days: 40, label: '2か月' },
  { days: 60, label: '3か月' },
  { days: 90, label: '約4.5か月' },
  { days: 200, label: '約10か月' },
] as const

const SORT_OPTIONS: Array<{ value: HistoricalAnalogSort; label: string }> = [
  { value: 'similarity', label: '類似度が高い順' },
  { value: 'return_desc', label: 'その後の上昇率順' },
  { value: 'return_asc', label: 'その後の下落率順' },
  { value: 'max_return', label: '期間内最大上昇順' },
  { value: 'min_return', label: '期間内最大下落順' },
]

function fmtPct(value: number | null | undefined, digits = 1): string {
  if (value == null || !Number.isFinite(value)) return '-'
  return `${value >= 0 ? '+' : ''}${value.toFixed(digits)}%`
}

function fmtScore(value: number): string {
  return `${Math.round(value * 100)}%`
}

function stageTags(code: string | null | undefined) {
  if (!code) return <span className="text-[11px] font-bold text-[var(--color-text-tertiary)]">------</span>
  return (
    <span className="inline-flex gap-0.5">
      {code.split('').slice(0, 6).map((value, index) => {
        const stage = Number(value)
        return stage >= 1 && stage <= 6
          ? <StageTag key={`${value}-${index}`} stage={stage} size="xs" />
          : <span key={`${value}-${index}`} className="grid h-4 w-4 place-items-center rounded-full border border-[var(--color-border-soft)] text-[9px] text-[var(--color-text-tertiary)]">-</span>
      })}
    </span>
  )
}

function outcomeTone(value: number | null) {
  if (value == null) return 'text-[var(--color-text-tertiary)]'
  if (value > 0) return 'text-[var(--color-market-red)]'
  if (value < 0) return 'text-[var(--color-market-blue)]'
  return 'text-[var(--color-text-secondary)]'
}

function AnalogPathChart({ row }: { row: AnalogRow }) {
  if (row.path.length < 2) {
    return <div className="grid h-[156px] place-items-center text-[11px] font-bold text-[var(--color-text-tertiary)]">価格経路なし</div>
  }
  return (
    <div className="h-[156px] min-w-0" aria-label={`${row.ticker}の類似局面後の基準化チャート`}>
      <ResponsiveContainer width="100%" height="100%" initialDimension={{ width: 300, height: 156 }}>
        <LineChart data={row.path} margin={{ top: 10, right: 8, bottom: 2, left: -20 }}>
          <CartesianGrid stroke="var(--color-border-soft)" strokeDasharray="3 3" vertical={false} />
          <XAxis
            dataKey="afterDays"
            tick={{ fontSize: 9, fill: 'var(--color-text-tertiary)' }}
            tickLine={false}
            axisLine={false}
            minTickGap={22}
          />
          <YAxis
            domain={['auto', 'auto']}
            tick={{ fontSize: 9, fill: 'var(--color-text-tertiary)' }}
            tickLine={false}
            axisLine={false}
            width={42}
          />
          <Tooltip
            formatter={(value) => [`${Number(value).toFixed(1)}`, '基準化値']}
            labelFormatter={(value) => `${value}営業日後`}
            contentStyle={{ borderRadius: 6, border: '1px solid var(--color-border-default)', fontSize: 11 }}
          />
          <ReferenceLine y={100} stroke="var(--color-text-tertiary)" strokeDasharray="3 3" />
          <Line type="monotone" dataKey="value" stroke="#0f766e" strokeWidth={2} dot={false} isAnimationActive={false} />
        </LineChart>
      </ResponsiveContainer>
    </div>
  )
}

export function HistoricalAnalogExplorer({
  ticker,
  market = 'JP',
  analysisDate = null,
}: {
  ticker: string
  market?: Market
  analysisDate?: string | null
}) {
  const [horizon, setHorizon] = useState(20)
  const [sort, setSort] = useState<HistoricalAnalogSort>('similarity')
  const [minScore, setMinScore] = useState(0.7)
  const [data, setData] = useState<AnalogResponse | null>(null)
  const [started, setStarted] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const runSearch = useCallback(async (signal?: AbortSignal) => {
    setLoading(true)
    setError('')
    const params = new URLSearchParams({
      ticker: ticker.replace(/\.T$/i, ''),
      market,
      horizon: String(horizon),
      sort,
      minScore: String(minScore),
      limit: '10',
    })
    if (analysisDate) params.set('date', analysisDate)
    try {
      const response = await fetch(`/api/ml/historical-analogs?${params.toString()}`, { cache: 'no-store', signal })
      const json = await response.json()
      if (!response.ok) throw new Error(json.error ?? '過去局面検索に失敗しました。')
      setData(json as AnalogResponse)
    } catch (searchError) {
      if ((searchError as Error).name !== 'AbortError') {
        setData(null)
        setError(searchError instanceof Error ? searchError.message : '過去局面検索に失敗しました。')
      }
    } finally {
      if (!signal?.aborted) setLoading(false)
    }
  }, [analysisDate, horizon, market, minScore, sort, ticker])

  useEffect(() => {
    if (!started) return
    const controller = new AbortController()
    void runSearch(controller.signal)
    return () => controller.abort()
  }, [runSearch, started])

  useEffect(() => {
    setStarted(false)
    setData(null)
    setError('')
  }, [analysisDate, market, ticker])

  const horizonLabel = useMemo(
    () => HORIZONS.find((item) => item.days === horizon)?.label ?? `${horizon}日`,
    [horizon],
  )

  return (
    <section className="min-w-0 border-y border-[var(--color-border-default)] bg-white py-4" aria-labelledby="historical-analog-title">
      <div className="flex flex-wrap items-start justify-between gap-3 px-3 sm:px-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <ScanSearch size={18} className="text-teal-700" aria-hidden="true" />
            <h2 id="historical-analog-title" className="text-[15px] font-black text-[var(--color-brand-900)]">
              特徴量ベース過去局面検索
            </h2>
          </div>
          <div className="mt-1 flex flex-wrap gap-1.5 text-[10px] font-bold text-[var(--color-text-secondary)]">
            <span className="rounded-[3px] border border-teal-200 bg-teal-50 px-2 py-1 text-teal-800">構造類似 85%</span>
            <span className="rounded-[3px] border border-blue-200 bg-blue-50 px-2 py-1 text-blue-800">MLベクトル 15%</span>
            <span className="rounded-[3px] border border-[var(--color-border-default)] bg-[var(--color-surface-subtle)] px-2 py-1">全履歴</span>
          </div>
        </div>
        <button
          type="button"
          onClick={() => {
            if (!started) setStarted(true)
            else void runSearch()
          }}
          disabled={loading}
          className="inline-flex h-9 items-center gap-2 rounded-[4px] bg-teal-700 px-3 text-[12px] font-black text-white hover:bg-teal-800 disabled:opacity-60"
        >
          {started ? <RefreshCw size={14} className={loading ? 'animate-spin' : ''} /> : <ScanSearch size={14} />}
          {loading ? '検索中' : started ? '再検索' : '全期間を検索'}
        </button>
      </div>

      <div className="mt-4 grid gap-3 border-y border-[var(--color-border-soft)] bg-[var(--color-surface-subtle)] px-3 py-3 sm:px-4 lg:grid-cols-[minmax(0,1fr)_180px_150px]">
        <div className="min-w-0">
          <div className="mb-1.5 text-[10px] font-black text-[var(--color-text-tertiary)]">その後の期間</div>
          <div className="flex max-w-full gap-1 overflow-x-auto pb-1" role="tablist" aria-label="事後リターン期間">
            {HORIZONS.map((item) => (
              <button
                key={item.days}
                type="button"
                role="tab"
                aria-selected={horizon === item.days}
                onClick={() => setHorizon(item.days)}
                className={`h-8 shrink-0 rounded-[3px] border px-2.5 text-[11px] font-black ${
                  horizon === item.days
                    ? 'border-teal-700 bg-teal-700 text-white'
                    : 'border-[var(--color-border-default)] bg-white text-[var(--color-text-secondary)] hover:border-teal-400'
                }`}
              >
                {item.label}
              </button>
            ))}
          </div>
        </div>
        <label className="grid content-start gap-1.5 text-[10px] font-black text-[var(--color-text-tertiary)]">
          並び順
          <select
            value={sort}
            onChange={(event) => setSort(event.target.value as HistoricalAnalogSort)}
            className="h-8 min-w-0 rounded-[3px] border border-[var(--color-border-default)] bg-white px-2 text-[11px] font-bold text-[var(--color-text-primary)]"
          >
            {SORT_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
          </select>
        </label>
        <label className="grid content-start gap-1.5 text-[10px] font-black text-[var(--color-text-tertiary)]">
          最低類似度
          <select
            value={minScore}
            onChange={(event) => setMinScore(Number(event.target.value))}
            className="h-8 min-w-0 rounded-[3px] border border-[var(--color-border-default)] bg-white px-2 text-[11px] font-bold text-[var(--color-text-primary)]"
          >
            {[0.7, 0.75, 0.8, 0.85, 0.9].map((value) => <option key={value} value={value}>{Math.round(value * 100)}%</option>)}
          </select>
        </label>
      </div>

      {!started && (
        <div className="mx-3 mt-4 grid min-h-[132px] place-items-center border border-dashed border-[var(--color-border-default)] bg-[var(--color-surface-subtle)] px-4 text-center sm:mx-4">
          <div>
            <BarChart3 size={24} className="mx-auto text-teal-700" aria-hidden="true" />
            <div className="mt-2 text-[13px] font-black text-[var(--color-text-primary)]">現在と本質的に近い過去局面を検索</div>
            <div className="mt-1 text-[11px] font-bold text-[var(--color-text-tertiary)]">6ステージ・MA位置・距離・角度・全ML特徴量を使用</div>
          </div>
        </div>
      )}

      {loading && !data && (
        <div className="mx-3 mt-4 grid gap-2 sm:mx-4 sm:grid-cols-2">
          {Array.from({ length: 4 }).map((_, index) => <div key={index} className="h-[260px] animate-pulse border border-[var(--color-border-soft)] bg-[var(--color-surface-subtle)]" />)}
        </div>
      )}

      {error && (
        <div role="alert" className="mx-3 mt-4 border border-rose-200 bg-rose-50 px-3 py-2 text-[12px] font-bold text-rose-800 sm:mx-4">{error}</div>
      )}

      {data && (
        <>
          <div className="mx-3 mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] font-bold text-[var(--color-text-tertiary)] sm:mx-4">
            <span>基準日 {data.asOfDate}</span>
            <span className="inline-flex items-center gap-1">現在 {stageTags(data.base.stageCode)}</span>
            <span>検索対象 {data.search.coverageFrom ?? '-'} 〜 {data.search.coverageTo ?? '-'}</span>
            <span>適合候補 {data.search.matchedFrom ?? '-'} 〜 {data.search.matchedTo ?? '-'}</span>
            <span>候補 {data.search.candidateCount.toLocaleString('ja-JP')}局面</span>
            <span>{horizonLabel}後で評価</span>
            {data.search.truncated && <span className="font-black text-amber-700">候補上限到達</span>}
          </div>
          <div className="mx-3 mt-3 grid grid-cols-2 border border-[var(--color-border-default)] bg-[var(--color-surface-subtle)] sm:mx-4 sm:grid-cols-3 lg:grid-cols-6">
            {[
              { label: '類似局面', value: `${data.summary.sampleCount.toLocaleString('ja-JP')}件`, tone: 'text-[var(--color-text-primary)]' },
              { label: '上昇率', value: data.summary.upRate == null ? '-' : `${Math.round(data.summary.upRate * 100)}%`, tone: 'text-teal-700' },
              { label: '中央値', value: fmtPct(data.summary.medianReturnPct), tone: outcomeTone(data.summary.medianReturnPct) },
              { label: '平均', value: fmtPct(data.summary.averageReturnPct), tone: outcomeTone(data.summary.averageReturnPct) },
              { label: '平均最大上昇', value: fmtPct(data.summary.averageMaxReturnPct), tone: 'text-[var(--color-market-red)]' },
              { label: '平均最大下落', value: fmtPct(data.summary.averageMinReturnPct), tone: 'text-[var(--color-market-blue)]' },
            ].map((item) => (
              <div key={item.label} className="min-w-0 border-b border-r border-[var(--color-border-soft)] px-2 py-2.5 text-center last:border-r-0 sm:border-b-0">
                <div className="truncate text-[9px] font-black text-[var(--color-text-tertiary)]">{item.label}</div>
                <div className={`mt-1 text-[14px] font-black ${item.tone}`}>{item.value}</div>
              </div>
            ))}
          </div>
          {data.analogs.length === 0 ? (
            <div className="mx-3 mt-4 border border-[var(--color-border-default)] bg-[var(--color-surface-subtle)] px-3 py-5 text-center text-[12px] font-bold text-[var(--color-text-tertiary)] sm:mx-4">
              指定した類似度以上の過去局面は見つかりませんでした。
            </div>
          ) : (
            <div className="mx-3 mt-4 grid min-w-0 gap-3 sm:mx-4 xl:grid-cols-2">
              {data.analogs.map((row) => {
                const href = market === 'US'
                  ? `/us/stock/${encodeURIComponent(row.ticker)}?date=${row.caseDate}`
                  : `/stock/${encodeURIComponent(row.ticker)}?date=${row.caseDate}`
                return (
                  <article key={`${row.ticker}-${row.caseDate}`} className="min-w-0 border border-[var(--color-border-default)] bg-white p-3 shadow-[var(--shadow-card)]">
                    <div className="flex min-w-0 flex-wrap items-start justify-between gap-2">
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="grid h-6 min-w-6 place-items-center rounded-full bg-teal-700 px-1 text-[11px] font-black text-white">{row.rank}</span>
                          <Link href={href} className="min-w-0 truncate text-[13px] font-black text-[var(--color-brand-700)] hover:text-[var(--color-market-red)]">
                            {row.ticker} {row.name ?? ''}
                          </Link>
                        </div>
                        <div className="mt-1.5 flex flex-wrap items-center gap-2 text-[10px] font-bold text-[var(--color-text-tertiary)]">
                          <span>{row.caseDate}</span>
                          <span>{row.sector17Name ?? row.marketSegment ?? '分類なし'}</span>
                          {stageTags(row.stageCode)}
                        </div>
                      </div>
                      <div className="text-right">
                        <div className="text-[20px] font-black leading-none text-teal-700">{fmtScore(row.similarityScore)}</div>
                        <div className="mt-1 text-[9px] font-black text-[var(--color-text-tertiary)]">総合類似度</div>
                      </div>
                    </div>

                    <div className="mt-3 grid grid-cols-3 gap-1.5 text-center">
                      <div className="border border-[var(--color-border-soft)] bg-[var(--color-surface-subtle)] px-1 py-2">
                        <div className="text-[9px] font-black text-[var(--color-text-tertiary)]">構造</div>
                        <div className="mt-0.5 text-[12px] font-black text-[var(--color-text-primary)]">{fmtScore(row.structuralScore)}</div>
                      </div>
                      <div className="border border-[var(--color-border-soft)] bg-[var(--color-surface-subtle)] px-1 py-2">
                        <div className="text-[9px] font-black text-[var(--color-text-tertiary)]">ML全特徴量</div>
                        <div className="mt-0.5 text-[12px] font-black text-[var(--color-text-primary)]">{fmtScore(row.vectorScore)}</div>
                      </div>
                      <div className="border border-[var(--color-border-soft)] bg-[var(--color-surface-subtle)] px-1 py-2">
                        <div className="text-[9px] font-black text-[var(--color-text-tertiary)]">{horizonLabel}後</div>
                        <div className={`mt-0.5 text-[12px] font-black ${outcomeTone(row.outcome.returnPct)}`}>{fmtPct(row.outcome.returnPct)}</div>
                      </div>
                    </div>

                    <div className="mt-2 border border-[var(--color-border-soft)] bg-[var(--color-surface-subtle)] p-2">
                      <AnalogPathChart row={row} />
                    </div>

                    <div className="mt-2 flex flex-wrap gap-1.5 text-[10px] font-black">
                      <span className="border border-red-200 bg-red-50 px-2 py-1 text-red-700">最大 {fmtPct(row.outcome.maxReturnPct)}</span>
                      <span className="border border-blue-200 bg-blue-50 px-2 py-1 text-blue-700">最小 {fmtPct(row.outcome.minReturnPct)}</span>
                      {row.stagePath.length > 0 && <span className="border border-[var(--color-border-default)] bg-white px-2 py-1 text-[var(--color-text-secondary)]">遷移 {row.stagePath.slice(0, 4).join(' → ')}</span>}
                    </div>

                    <div className="mt-3 grid gap-1.5 sm:grid-cols-2">
                      {row.components.map((component) => (
                        <div key={component.key} className="min-w-0 border-l-2 border-teal-600 bg-teal-50 px-2 py-1.5">
                          <div className="flex items-center justify-between gap-2 text-[10px] font-black">
                            <span className="truncate text-teal-900">{component.label}</span>
                            <span className="shrink-0 text-teal-700">{fmtScore(component.score)}</span>
                          </div>
                        </div>
                      ))}
                    </div>
                  </article>
                )
              })}
            </div>
          )}
        </>
      )}
    </section>
  )
}
