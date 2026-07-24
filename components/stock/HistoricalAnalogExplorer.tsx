'use client'

import Link from 'next/link'
import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  BarChart3,
  CheckCircle2,
  Clock3,
  GitCompareArrows,
  RefreshCw,
  ScanSearch,
} from 'lucide-react'
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

type StructurePoint = {
  relativeDay: number
  date: string
  close: number
  ma5: number | null
  ma10: number | null
  ma20: number | null
  ma40: number | null
  ma60: number | null
  ma90: number | null
  ma200: number | null
}

type StagePoint = {
  relativeDay: number
  date: string
  stageCode: string
}

type OutcomePoint = {
  afterDays: number
  date: string
  value: number
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
  approximationScore: number
  bandMatches: number
  components: Array<{
    key: string
    label: string
    score: number
    weight: number
  }>
  preWindow: StructurePoint[]
  stagePath: StagePoint[]
  outcome: {
    horizonDays: number
    complete: boolean
    availableDays: number
    returnPct: number | null
    maxReturnPct: number | null
    minReturnPct: number | null
    path: OutcomePoint[]
  }
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
    preWindow: StructurePoint[]
    stagePath: StagePoint[]
  }
  horizon: number
  sort: HistoricalAnalogSort
  minScore: number
  summary: {
    sampleCount: number
    partialCount: number
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
    maPeriods: number[]
    dailyWindows: number[]
    higherTimeframes: string[]
    monthlyPeriods: number[]
    longTermPeriods: number[]
    scoringProfile: {
      key: string
      label: string
    }
    mlRerankWeight: number
    indexedCandidateCount: number
    coverageRejectedCount: number
    exactCoverageRejectedCount: number
    requiredComponents: string[]
    approximateCount: number
    stageCandidateCount: number
    stageShortlistCount: number
    candidateRangeCount: number
    candidatePriceRowCount: number
    alignedCount: number
    dtwRerankCount: number
    scoredCount: number
    coverageFrom: string | null
    coverageTo: string | null
    indexSourceDate: string | null
    indexRows: number
    indexVersion: number
    truncated: boolean
  }
}

const HORIZONS = [
  { days: 5, label: '1週' },
  { days: 10, label: '2週' },
  { days: 15, label: '3週' },
  { days: 20, label: '1か月' },
  { days: 40, label: '2か月' },
  { days: 60, label: '3か月' },
  { days: 90, label: '4.5か月' },
  { days: 200, label: '10か月' },
] as const

const SORT_OPTIONS: Array<{ value: HistoricalAnalogSort; label: string }> = [
  { value: 'similarity', label: '類似度' },
  { value: 'return_desc', label: 'その後の上昇率' },
  { value: 'return_asc', label: 'その後の下落率' },
  { value: 'max_return', label: '期間内最大上昇' },
  { value: 'min_return', label: '期間内最大下落' },
]

const MA_LINES = [
  { key: 'ma5', label: '5', color: '#dc2626', width: 1.4 },
  { key: 'ma10', label: '10', color: '#ea580c', width: 1.4 },
  { key: 'ma20', label: '20', color: '#ca8a04', width: 1.4 },
  { key: 'ma40', label: '40', color: '#16a34a', width: 1.4 },
  { key: 'ma60', label: '60', color: '#0d9488', width: 1.4 },
  { key: 'ma90', label: '90', color: '#2563eb', width: 1.4 },
  { key: 'ma200', label: '200', color: '#9333ea', width: 1.8 },
] as const

function fmtPct(value: number | null | undefined, digits = 1): string {
  if (value == null || !Number.isFinite(value)) return '-'
  return `${value >= 0 ? '+' : ''}${value.toFixed(digits)}%`
}

function fmtScore(value: number): string {
  return `${Math.round(value * 100)}%`
}

function stageTags(code: string | null | undefined) {
  if (!code) {
    return <span className="text-[10px] font-bold text-[var(--color-text-tertiary)]">-----</span>
  }
  return (
    <span className="inline-flex gap-0.5">
      {code.split('').map((value, index) => {
        const stage = Number(value)
        return stage >= 1 && stage <= 6
          ? <StageTag key={`${value}-${index}`} stage={stage} size="xs" />
          : null
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

function chartDomain(...groups: StructurePoint[][]): [number, number] {
  const values = groups.flatMap((points) =>
    points.flatMap((point) => [
      point.close,
      point.ma5,
      point.ma10,
      point.ma20,
      point.ma40,
      point.ma60,
      point.ma90,
      point.ma200,
    ]),
  ).filter((value): value is number => value != null && Number.isFinite(value))
  if (values.length === 0) return [80, 120]
  const min = Math.min(...values)
  const max = Math.max(...values)
  const padding = Math.max(1.5, (max - min) * 0.08)
  return [Math.floor((min - padding) * 10) / 10, Math.ceil((max + padding) * 10) / 10]
}

function StructureChart({
  points,
  domain,
  showMa,
  label,
}: {
  points: StructurePoint[]
  domain: [number, number]
  showMa: boolean
  label: string
}) {
  return (
    <div className="h-[248px] min-w-0" aria-label={label}>
      <ResponsiveContainer width="100%" height="100%" initialDimension={{ width: 420, height: 248 }}>
        <LineChart data={points} margin={{ top: 8, right: 8, bottom: 0, left: -14 }}>
          <CartesianGrid stroke="var(--color-border-soft)" strokeDasharray="3 3" vertical={false} />
          <XAxis
            dataKey="relativeDay"
            tick={{ fontSize: 9, fill: 'var(--color-text-tertiary)' }}
            tickLine={false}
            axisLine={false}
            minTickGap={24}
          />
          <YAxis
            domain={domain}
            tick={{ fontSize: 9, fill: 'var(--color-text-tertiary)' }}
            tickLine={false}
            axisLine={false}
            width={42}
          />
          <Tooltip
            formatter={(value, name) => [Number(value).toFixed(2), String(name)]}
            labelFormatter={(value, payload) => {
              const date = payload?.[0]?.payload?.date
              return `${date ?? ''} (${value}営業日)`
            }}
            contentStyle={{ borderRadius: 4, border: '1px solid var(--color-border-default)', fontSize: 10 }}
          />
          <ReferenceLine y={100} stroke="var(--color-text-tertiary)" strokeDasharray="3 3" />
          {showMa && MA_LINES.map((line) => (
            <Line
              key={line.key}
              type="linear"
              dataKey={line.key}
              name={`MA${line.label}`}
              stroke={line.color}
              strokeWidth={line.width}
              dot={false}
              connectNulls
              isAnimationActive={false}
            />
          ))}
          <Line
            type="linear"
            dataKey="close"
            name="終値"
            stroke="#111827"
            strokeWidth={2.2}
            dot={false}
            isAnimationActive={false}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  )
}

function OutcomeChart({ row }: { row: AnalogRow }) {
  if (row.outcome.path.length < 2) {
    return (
      <div className="grid h-[180px] place-items-center text-[11px] font-bold text-[var(--color-text-tertiary)]">
        事後データなし
      </div>
    )
  }
  return (
    <div className="h-[180px] min-w-0" aria-label={`${row.ticker}の類似局面後チャート`}>
      <ResponsiveContainer width="100%" height="100%" initialDimension={{ width: 420, height: 180 }}>
        <LineChart data={row.outcome.path} margin={{ top: 8, right: 8, bottom: 0, left: -14 }}>
          <CartesianGrid stroke="var(--color-border-soft)" strokeDasharray="3 3" vertical={false} />
          <XAxis
            dataKey="afterDays"
            tick={{ fontSize: 9, fill: 'var(--color-text-tertiary)' }}
            tickLine={false}
            axisLine={false}
            minTickGap={24}
          />
          <YAxis
            domain={['auto', 'auto']}
            tick={{ fontSize: 9, fill: 'var(--color-text-tertiary)' }}
            tickLine={false}
            axisLine={false}
            width={42}
          />
          <Tooltip
            formatter={(value) => [Number(value).toFixed(2), '基準化値']}
            labelFormatter={(value) => `${value}営業日後`}
            contentStyle={{ borderRadius: 4, border: '1px solid var(--color-border-default)', fontSize: 10 }}
          />
          <ReferenceLine y={100} stroke="var(--color-text-tertiary)" strokeDasharray="3 3" />
          <Line
            type="linear"
            dataKey="value"
            stroke="#0f766e"
            strokeWidth={2.2}
            dot={false}
            isAnimationActive={false}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  )
}

function StageTimeline({ points }: { points: StagePoint[] }) {
  if (points.length === 0) {
    return <span className="text-[10px] font-bold text-[var(--color-text-tertiary)]">遷移なし</span>
  }
  return (
    <div className="flex max-w-full items-center gap-1 overflow-x-auto pb-1">
      {points.map((point, index) => (
        <div key={`${point.date}-${point.stageCode}`} className="inline-flex shrink-0 items-center gap-1">
          {index > 0 && <span className="text-[10px] text-[var(--color-text-tertiary)]">→</span>}
          <span className="border border-[var(--color-border-soft)] bg-white px-1.5 py-1">
            <span className="mr-1 text-[9px] font-bold text-[var(--color-text-tertiary)]">{point.relativeDay}</span>
            {stageTags(point.stageCode)}
          </span>
        </div>
      ))}
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
  const [minScore, setMinScore] = useState(0.35)
  const [showMa, setShowMa] = useState(true)
  const [data, setData] = useState<AnalogResponse | null>(null)
  const [selectedKey, setSelectedKey] = useState('')
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
      limit: '30',
    })
    if (analysisDate) params.set('date', analysisDate)
    try {
      const response = await fetch(`/api/ml/historical-analogs?${params.toString()}`, {
        cache: 'no-store',
        signal,
      })
      const json = await response.json()
      if (!response.ok) throw new Error(json.error ?? '過去局面検索に失敗しました。')
      const next = json as AnalogResponse
      setData(next)
      setSelectedKey((current) => {
        if (next.analogs.some((row) => `${row.ticker}-${row.caseDate}` === current)) return current
        const first = next.analogs[0]
        return first ? `${first.ticker}-${first.caseDate}` : ''
      })
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
    setSelectedKey('')
    setError('')
  }, [analysisDate, market, ticker])

  const selected = useMemo(
    () => data?.analogs.find((row) => `${row.ticker}-${row.caseDate}` === selectedKey)
      ?? data?.analogs[0]
      ?? null,
    [data, selectedKey],
  )
  const sharedDomain = useMemo(
    () => chartDomain(data?.base.preWindow ?? [], selected?.preWindow ?? []),
    [data, selected],
  )
  const horizonLabel = HORIZONS.find((item) => item.days === horizon)?.label ?? `${horizon}日`

  return (
    <section className="min-w-0 border-y border-[var(--color-border-default)] bg-white py-4" aria-labelledby="historical-analog-title">
      <div className="flex flex-wrap items-start justify-between gap-3 px-3 sm:px-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <GitCompareArrows size={18} className="text-teal-700" aria-hidden="true" />
            <h2 id="historical-analog-title" className="text-[15px] font-black text-[var(--color-brand-900)]">
              本質類似局面
            </h2>
          </div>
          <div className="mt-1 flex flex-wrap gap-1.5 text-[10px] font-bold text-[var(--color-text-secondary)]">
            <span className="border border-teal-200 bg-teal-50 px-2 py-1 text-teal-800">10・20・40日軌跡</span>
            <span className="border border-blue-200 bg-blue-50 px-2 py-1 text-blue-800">週足・月足・長期</span>
            <span className="border border-violet-200 bg-violet-50 px-2 py-1 text-violet-800">MA 5〜200</span>
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

      <div className="mt-4 grid gap-3 border-y border-[var(--color-border-soft)] bg-[var(--color-surface-subtle)] px-3 py-3 sm:px-4 lg:grid-cols-[minmax(0,1fr)_170px_132px_110px]">
        <div className="min-w-0">
          <div className="mb-1.5 text-[10px] font-black text-[var(--color-text-tertiary)]">事後期間</div>
          <div className="flex max-w-full gap-1 overflow-x-auto pb-1" role="tablist" aria-label="事後リターン期間">
            {HORIZONS.map((item) => (
              <button
                key={item.days}
                type="button"
                role="tab"
                aria-selected={horizon === item.days}
                onClick={() => setHorizon(item.days)}
                disabled={loading}
                className={`h-8 shrink-0 rounded-[3px] border px-2.5 text-[11px] font-black ${
                  horizon === item.days
                    ? 'border-teal-700 bg-teal-700 text-white'
                    : 'border-[var(--color-border-default)] bg-white text-[var(--color-text-secondary)] hover:border-teal-400'
                } disabled:cursor-not-allowed disabled:opacity-50`}
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
            disabled={loading}
            className="h-8 min-w-0 rounded-[3px] border border-[var(--color-border-default)] bg-white px-2 text-[11px] font-bold text-[var(--color-text-primary)] disabled:cursor-not-allowed disabled:opacity-50"
          >
            {SORT_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
          </select>
        </label>
        <label className="grid content-start gap-1.5 text-[10px] font-black text-[var(--color-text-tertiary)]">
          最低類似度
          <select
            value={minScore}
            onChange={(event) => setMinScore(Number(event.target.value))}
            disabled={loading}
            className="h-8 min-w-0 rounded-[3px] border border-[var(--color-border-default)] bg-white px-2 text-[11px] font-bold text-[var(--color-text-primary)] disabled:cursor-not-allowed disabled:opacity-50"
          >
            {[0.25, 0.3, 0.35, 0.4, 0.45, 0.5].map((value) => (
              <option key={value} value={value}>{Math.round(value * 100)}%</option>
            ))}
          </select>
        </label>
        <label className="flex h-8 self-end items-center justify-between gap-2 border border-[var(--color-border-default)] bg-white px-2 text-[10px] font-black text-[var(--color-text-secondary)]">
          MA表示
          <input
            type="checkbox"
            checked={showMa}
            onChange={(event) => setShowMa(event.target.checked)}
            disabled={loading}
            className="h-4 w-4 accent-teal-700 disabled:cursor-not-allowed disabled:opacity-50"
          />
        </label>
      </div>

      {!started && (
        <div className="mx-3 mt-4 grid min-h-[132px] place-items-center border border-dashed border-[var(--color-border-default)] bg-[var(--color-surface-subtle)] px-4 text-center sm:mx-4">
          <div>
            <BarChart3 size={24} className="mx-auto text-teal-700" aria-hidden="true" />
            <div className="mt-2 text-[13px] font-black text-[var(--color-text-primary)]">現在と同じ構造変化を全履歴から検索</div>
            <div className="mt-1 text-[11px] font-bold text-[var(--color-text-tertiary)]">日足・週足・月足・長期のMA軌跡を厳密再評価</div>
          </div>
        </div>
      )}

      {loading && !data && (
        <div className="mx-3 mt-4 grid gap-2 sm:mx-4 sm:grid-cols-2">
          <div className="h-[360px] animate-pulse border border-[var(--color-border-soft)] bg-[var(--color-surface-subtle)]" />
          <div className="h-[360px] animate-pulse border border-[var(--color-border-soft)] bg-[var(--color-surface-subtle)]" />
        </div>
      )}

      {error && (
        <div role="alert" className="mx-3 mt-4 border border-rose-200 bg-rose-50 px-3 py-2 text-[12px] font-bold text-rose-800 sm:mx-4">
          {error}
        </div>
      )}

      {data && (
        <>
          <div className="mx-3 mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] font-bold text-[var(--color-text-tertiary)] sm:mx-4">
            <span>基準日 {data.asOfDate}</span>
            <span className="inline-flex items-center gap-1">現在 {stageTags(data.base.stageCode)}</span>
            <span>履歴 {data.search.coverageFrom ?? '-'}〜{data.search.coverageTo ?? '-'}</span>
            <span>索引 {data.search.indexRows.toLocaleString('ja-JP')}局面</span>
            <span>DTW再評価 {data.search.dtwRerankCount.toLocaleString('ja-JP')}局面</span>
            <span>ステージ経路 {data.search.stageShortlistCount.toLocaleString('ja-JP')}局面</span>
            <span>全時間軸一致 {data.search.requiredComponents.length}要素必須</span>
            <span>検証済み重み {data.search.scoringProfile.label}</span>
            <span>学習特徴量 {Math.round(data.search.mlRerankWeight * 100)}%寄与・内訳表示</span>
            {data.search.truncated && <span className="font-black text-amber-700">候補上限到達</span>}
          </div>

          <div className="mx-3 mt-3 grid grid-cols-2 border border-[var(--color-border-default)] bg-[var(--color-surface-subtle)] sm:mx-4 sm:grid-cols-3 lg:grid-cols-6">
            {[
              { label: '確定標本', value: `${data.summary.sampleCount}件`, tone: 'text-[var(--color-text-primary)]' },
              { label: '途中標本', value: `${data.summary.partialCount}件`, tone: 'text-amber-700' },
              { label: '上昇率', value: data.summary.upRate == null ? '-' : `${Math.round(data.summary.upRate * 100)}%`, tone: 'text-teal-700' },
              { label: '中央値', value: fmtPct(data.summary.medianReturnPct), tone: outcomeTone(data.summary.medianReturnPct) },
              { label: '平均最大上昇', value: fmtPct(data.summary.averageMaxReturnPct), tone: 'text-[var(--color-market-red)]' },
              { label: '平均最大下落', value: fmtPct(data.summary.averageMinReturnPct), tone: 'text-[var(--color-market-blue)]' },
            ].map((item) => (
              <div key={item.label} className="min-w-0 border-b border-r border-[var(--color-border-soft)] px-2 py-2.5 text-center last:border-r-0 sm:border-b-0">
                <div className="truncate text-[9px] font-black text-[var(--color-text-tertiary)]">{item.label}</div>
                <div className={`mt-1 text-[14px] font-black ${item.tone}`}>{item.value}</div>
              </div>
            ))}
          </div>

          {selected && (
            <div className="mx-3 mt-4 border border-[var(--color-border-default)] bg-white sm:mx-4">
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--color-border-soft)] px-3 py-2.5">
                <div className="flex min-w-0 items-center gap-2">
                  <GitCompareArrows size={15} className="shrink-0 text-teal-700" />
                  <span className="text-[12px] font-black text-[var(--color-text-primary)]">構造比較</span>
                  <span className="text-[10px] font-bold text-[var(--color-text-tertiary)]">終点=100・共通スケール</span>
                </div>
                <div className="flex flex-wrap gap-2 text-[9px] font-black">
                  <span className="text-[#111827]">終値</span>
                  {showMa && MA_LINES.map((line) => (
                    <span key={line.key} style={{ color: line.color }}>MA{line.label}</span>
                  ))}
                </div>
              </div>
              <div className="grid min-w-0 lg:grid-cols-2">
                <div className="min-w-0 border-b border-[var(--color-border-soft)] p-2 lg:border-b-0 lg:border-r">
                  <div className="flex items-center justify-between gap-2 px-1">
                    <div className="text-[11px] font-black text-[var(--color-text-primary)]">
                      現在 {data.base.ticker} {data.base.name ?? ''}
                    </div>
                    <span className="text-[9px] font-bold text-[var(--color-text-tertiary)]">{data.base.date}</span>
                  </div>
                  <StructureChart
                    points={data.base.preWindow}
                    domain={sharedDomain}
                    showMa={showMa}
                    label={`${data.base.ticker}の現在までのMA構造`}
                  />
                  <div className="border-t border-[var(--color-border-soft)] px-1 pt-2">
                    <StageTimeline points={data.base.stagePath} />
                  </div>
                </div>
                <div className="min-w-0 p-2">
                  <div className="flex items-center justify-between gap-2 px-1">
                    <Link
                      href={market === 'US'
                        ? `/us/stock/${encodeURIComponent(selected.ticker)}?date=${selected.caseDate}`
                        : `/stock/${encodeURIComponent(selected.ticker)}?date=${selected.caseDate}`}
                      className="min-w-0 truncate text-[11px] font-black text-[var(--color-brand-700)] hover:text-[var(--color-market-red)]"
                    >
                      過去 {selected.ticker} {selected.name ?? ''}
                    </Link>
                    <span className="text-[9px] font-bold text-[var(--color-text-tertiary)]">{selected.caseDate}</span>
                  </div>
                  <StructureChart
                    points={selected.preWindow}
                    domain={sharedDomain}
                    showMa={showMa}
                    label={`${selected.ticker}の${selected.caseDate}までのMA構造`}
                  />
                  <div className="border-t border-[var(--color-border-soft)] px-1 pt-2">
                    <StageTimeline points={selected.stagePath} />
                  </div>
                </div>
              </div>

              <div className="grid border-t border-[var(--color-border-default)] lg:grid-cols-[minmax(0,1.35fr)_minmax(280px,.65fr)]">
                <div className="min-w-0 border-b border-[var(--color-border-soft)] p-3 lg:border-b-0 lg:border-r">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="text-[11px] font-black text-[var(--color-text-primary)]">
                      {selected.caseDate} 以後 {horizonLabel}
                    </div>
                    <div className="flex items-center gap-1 text-[10px] font-black">
                      {selected.outcome.complete
                        ? <CheckCircle2 size={13} className="text-teal-700" />
                        : <Clock3 size={13} className="text-amber-700" />}
                      <span className={selected.outcome.complete ? 'text-teal-700' : 'text-amber-700'}>
                        {selected.outcome.complete ? '確定' : `${selected.outcome.availableDays}営業日まで`}
                      </span>
                    </div>
                  </div>
                  <OutcomeChart row={selected} />
                  <div className="grid grid-cols-3 border-t border-[var(--color-border-soft)] text-center">
                    <div className="px-2 py-2">
                      <div className="text-[9px] font-black text-[var(--color-text-tertiary)]">期末</div>
                      <div className={`mt-1 text-[13px] font-black ${outcomeTone(selected.outcome.returnPct)}`}>{fmtPct(selected.outcome.returnPct)}</div>
                    </div>
                    <div className="border-x border-[var(--color-border-soft)] px-2 py-2">
                      <div className="text-[9px] font-black text-[var(--color-text-tertiary)]">最大上昇</div>
                      <div className="mt-1 text-[13px] font-black text-[var(--color-market-red)]">{fmtPct(selected.outcome.maxReturnPct)}</div>
                    </div>
                    <div className="px-2 py-2">
                      <div className="text-[9px] font-black text-[var(--color-text-tertiary)]">最大下落</div>
                      <div className="mt-1 text-[13px] font-black text-[var(--color-market-blue)]">{fmtPct(selected.outcome.minReturnPct)}</div>
                    </div>
                  </div>
                </div>
                <div className="min-w-0 p-3">
                  <div className="flex items-end justify-between gap-2 border-b border-[var(--color-border-soft)] pb-2">
                    <div>
                      <div className="text-[9px] font-black text-[var(--color-text-tertiary)]">総合類似度</div>
                      <div className="mt-1 text-[26px] font-black leading-none text-teal-700">{fmtScore(selected.similarityScore)}</div>
                    </div>
                    <div className="text-right text-[9px] font-bold text-[var(--color-text-tertiary)]">
                      {selected.sector17Name ?? selected.marketSegment ?? '分類なし'}
                    </div>
                  </div>
                  <div className="mt-3 grid gap-2">
                    {selected.components.map((component) => (
                      <div key={component.key}>
                        <div className="mb-1 flex items-center justify-between gap-2 text-[10px] font-black">
                          <span className="text-[var(--color-text-secondary)]">{component.label}</span>
                          <span className="text-teal-700">{fmtScore(component.score)}</span>
                        </div>
                        <div className="h-1.5 bg-[var(--color-surface-muted)]">
                          <div className="h-full bg-teal-600" style={{ width: `${Math.max(2, component.score * 100)}%` }} />
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          )}

          {data.analogs.length === 0 ? (
            <div className="mx-3 mt-4 border border-[var(--color-border-default)] bg-[var(--color-surface-subtle)] px-3 py-5 text-center text-[12px] font-bold text-[var(--color-text-tertiary)] sm:mx-4">
              指定条件に合う過去局面は見つかりませんでした。
            </div>
          ) : (
            <div className="mx-3 mt-4 overflow-x-auto border border-[var(--color-border-default)] sm:mx-4">
              <table className="w-full min-w-[1040px] border-collapse text-left">
                <thead className="bg-[var(--color-surface-subtle)] text-[9px] font-black text-[var(--color-text-tertiary)]">
                  <tr>
                    <th className="w-10 px-2 py-2 text-center">順位</th>
                    <th className="px-2 py-2">銘柄・局面</th>
                    <th className="px-2 py-2 text-center">ステージ</th>
                    <th className="px-2 py-2 text-right">類似度</th>
                    <th className="px-2 py-2 text-right">10日</th>
                    <th className="px-2 py-2 text-right">20日</th>
                    <th className="px-2 py-2 text-right">40日</th>
                    <th className="px-2 py-2 text-right">週足</th>
                    <th className="px-2 py-2 text-right">月足</th>
                    <th className="px-2 py-2 text-right">長期</th>
                    <th className="px-2 py-2 text-right">学習</th>
                    <th className="px-2 py-2 text-right">{horizonLabel}後</th>
                    <th className="px-2 py-2 text-right">期間最大</th>
                  </tr>
                </thead>
                <tbody>
                  {data.analogs.map((row) => {
                    const key = `${row.ticker}-${row.caseDate}`
                    const component = new Map(row.components.map((item) => [item.key, item.score]))
                    const active = key === `${selected?.ticker}-${selected?.caseDate}`
                    return (
                      <tr
                        key={key}
                        onClick={() => setSelectedKey(key)}
                        className={`cursor-pointer border-t border-[var(--color-border-soft)] text-[10px] font-bold ${
                          active ? 'bg-teal-50' : 'bg-white hover:bg-[var(--color-surface-subtle)]'
                        }`}
                      >
                        <td className="px-2 py-2.5 text-center">
                          <span className={`inline-grid h-5 min-w-5 place-items-center rounded-full px-1 text-[9px] font-black ${
                            active ? 'bg-teal-700 text-white' : 'bg-[var(--color-surface-muted)] text-[var(--color-text-secondary)]'
                          }`}>
                            {row.rank}
                          </span>
                        </td>
                        <td className="px-2 py-2.5">
                          <div className="font-black text-[var(--color-brand-800)]">{row.ticker} {row.name ?? ''}</div>
                          <div className="mt-0.5 text-[9px] text-[var(--color-text-tertiary)]">{row.caseDate}</div>
                        </td>
                        <td className="px-2 py-2.5 text-center">{stageTags(row.stageCode)}</td>
                        <td className="px-2 py-2.5 text-right text-[12px] font-black text-teal-700">{fmtScore(row.similarityScore)}</td>
                        {['daily10', 'daily20', 'daily40', 'weekly', 'monthly', 'longTerm', 'mlFeatures'].map((name) => (
                          <td key={name} className="px-2 py-2.5 text-right text-[var(--color-text-secondary)]">
                            {component.has(name) ? fmtScore(component.get(name)!) : '-'}
                          </td>
                        ))}
                        <td className={`px-2 py-2.5 text-right font-black ${outcomeTone(row.outcome.returnPct)}`}>
                          {row.outcome.complete ? fmtPct(row.outcome.returnPct) : `${row.outcome.availableDays}日途中`}
                        </td>
                        <td className="px-2 py-2.5 text-right font-black text-[var(--color-market-red)]">{fmtPct(row.outcome.maxReturnPct)}</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </section>
  )
}
