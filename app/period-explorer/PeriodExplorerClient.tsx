'use client'

import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  CalendarRange,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CircleHelp,
  Filter,
  LoaderCircle,
  RotateCcw,
  Search,
  SlidersHorizontal,
  X,
} from 'lucide-react'
import { StageTag } from '@/components/ui/StageTag'
import { StockPreviewTrigger } from '@/components/stock-preview/StockPreviewTrigger'
import {
  PERIOD_EXPLORER_AXIS_KEYS,
  PERIOD_EXPLORER_AXIS_LABELS,
  PERIOD_EXPLORER_RANKINGS,
  PERIOD_EXPLORER_RANKING_MAP,
  isPeriodExplorerRankingKey,
  type PeriodExplorerAxisKey,
  type PeriodExplorerRankingCategory,
  type PeriodExplorerRankingKey,
} from '@/lib/period-explorer'
import type {
  PeriodExplorerResponse,
  PeriodExplorerSectorRow,
  PeriodExplorerStockRow,
  PeriodExplorerTaxonomy,
} from '@/lib/server/period-explorer-read-model'

type Props = {
  calendarDates: string[]
  defaultFrom: string
  defaultTo: string
}

const CATEGORY_META: Array<{ key: PeriodExplorerRankingCategory; label: string }> = [
  { key: 'price', label: '値動き' },
  { key: 'technical', label: 'テクニカル' },
  { key: 'liquidity', label: '出来高・流動性' },
  { key: 'highLow', label: '高値・安値' },
  { key: 'volatility', label: 'ボラティリティ' },
  { key: 'industry', label: '業種' },
]

const TAXONOMIES: Array<{ value: PeriodExplorerTaxonomy; label: string }> = [
  { value: 'sector33', label: 'J-Quants 33業種' },
  { value: 'sector17', label: 'J-Quants 17業種' },
  { value: 'major', label: '独自60分類' },
  { value: 'subIndustry', label: '独自細分類' },
]

const QUICK_RANGES = [
  { key: '5d', label: '5営業日', tradingDays: 5 },
  { key: '20d', label: '20営業日', tradingDays: 20 },
  { key: '60d', label: '60営業日', tradingDays: 60 },
  { key: '120d', label: '120営業日', tradingDays: 120 },
  { key: '300d', label: '300営業日', tradingDays: 300 },
  { key: '250d', label: '250営業日', tradingDays: 250 },
  { key: '1m', label: '1か月', months: 1 },
  { key: '3m', label: '3か月', months: 3 },
  { key: '6m', label: '6か月', months: 6 },
  { key: '1y', label: '1年', months: 12 },
  { key: 'ytd', label: '年初来', ytd: true },
] as const

const MARKET_CAP_PRESETS = [
  { value: '5000000000', label: '50億円以上' },
  { value: '10000000000', label: '100億円以上' },
  { value: '30000000000', label: '300億円以上' },
  { value: '100000000000', label: '1,000億円以上' },
  { value: '300000000000', label: '3,000億円以上' },
  { value: '1000000000000', label: '1兆円以上' },
]

const TURNOVER_PRESETS = [
  { value: '10000000', label: '1,000万円以上' },
  { value: '50000000', label: '5,000万円以上' },
  { value: '100000000', label: '1億円以上' },
  { value: '300000000', label: '3億円以上' },
  { value: '1000000000', label: '10億円以上' },
]

const VOLUME_PRESETS = [
  { value: '10000', label: '1万株以上' },
  { value: '50000', label: '5万株以上' },
  { value: '100000', label: '10万株以上' },
  { value: '500000', label: '50万株以上' },
  { value: '1000000', label: '100万株以上' },
]

function fmtDate(value: string): string {
  return value ? value.replaceAll('-', '/') : '—'
}

function fmtNumber(value: number | null, digits = 1): string {
  if (value == null || !Number.isFinite(value)) return '—'
  return value.toLocaleString('ja-JP', { maximumFractionDigits: digits })
}

function fmtPercent(value: number | null, digits = 1): string {
  if (value == null || !Number.isFinite(value)) return '—'
  return `${value > 0 ? '+' : ''}${value.toFixed(digits)}%`
}

function fmtCurrency(value: number | null): string {
  if (value == null || !Number.isFinite(value)) return '—'
  const absolute = Math.abs(value)
  if (absolute >= 1e12) return `${(value / 1e12).toFixed(2)}兆円`
  if (absolute >= 1e8) return `${(value / 1e8).toFixed(1)}億円`
  if (absolute >= 1e4) return `${(value / 1e4).toFixed(1)}万円`
  return `${Math.round(value).toLocaleString('ja-JP')}円`
}

function fmtVolume(value: number | null): string {
  if (value == null || !Number.isFinite(value)) return '—'
  if (Math.abs(value) >= 1e8) return `${(value / 1e8).toFixed(1)}億株`
  if (Math.abs(value) >= 1e4) return `${(value / 1e4).toFixed(1)}万株`
  return `${Math.round(value).toLocaleString('ja-JP')}株`
}

function tone(value: number | null): string {
  if (value == null || value === 0) return 'text-[var(--color-text-secondary)]'
  return value > 0 ? 'text-[var(--color-price-up)]' : 'text-[var(--color-price-down)]'
}

function rankingText(value: number | null, ranking: PeriodExplorerRankingKey): string {
  const definition = PERIOD_EXPLORER_RANKING_MAP.get(ranking)!
  if (value == null) return '—'
  if (definition.unit === 'currency') return fmtCurrency(value)
  if (definition.unit === 'volume') return fmtVolume(value)
  if (definition.unit === 'percent') return fmtPercent(value)
  if (definition.unit === 'axes') return `${Math.round(value)}軸`
  return `${Math.round(value)}件`
}

function GroupedStageCode({ row }: { row: PeriodExplorerStockRow }) {
  const groups: Array<{ label: string; axes: [PeriodExplorerAxisKey, PeriodExplorerAxisKey] }> = [
    { label: '日', axes: ['dailyA', 'dailyB'] },
    { label: '週', axes: ['weeklyA', 'weeklyB'] },
    { label: '月', axes: ['monthlyA', 'monthlyB'] },
  ]
  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap" aria-label={`6軸ステージ ${row.stageCode ?? '未計算'}`}>
      {groups.map((group, groupIndex) => (
        <span key={group.label} className="inline-flex items-center gap-0.5">
          {groupIndex > 0 && <span aria-hidden className="mr-1 text-[9px] text-[var(--color-border-strong)]">｜</span>}
          <span className="mr-0.5 text-[9px] font-black text-[var(--color-text-tertiary)]">{group.label}</span>
          {group.axes.map((axis) => (
            <span key={axis} title={`${PERIOD_EXPLORER_AXIS_LABELS[axis]}: ${row.endStages[axis] == null ? '未計算' : `Stage ${row.endStages[axis]}`}`} tabIndex={0}>
              <StageTag stage={row.endStages[axis]} size="xs" />
            </span>
          ))}
        </span>
      ))}
    </span>
  )
}

function firstIndexAtOrAfter(values: string[], target: string): number {
  const index = values.findIndex((value) => value >= target)
  return index < 0 ? values.length - 1 : index
}

function lastIndexAtOrBefore(values: string[], target: string): number {
  for (let index = values.length - 1; index >= 0; index -= 1) {
    if (values[index] <= target) return index
  }
  return 0
}

function subtractMonths(value: string, months: number): string {
  const date = new Date(`${value}T00:00:00.000Z`)
  date.setUTCMonth(date.getUTCMonth() - months)
  return date.toISOString().slice(0, 10)
}

function chipLabel(key: string, value: string): string {
  if (key === 'market') return `市場 ${value}`
  if (key === 'sector') return `業種 ${value}`
  if (key === 'margin') return `区分 ${value}`
  if (key === 'marketCapMin') return `時価総額 ${fmtCurrency(Number(value))}以上`
  if (key === 'marketCapMax') return `時価総額 ${fmtCurrency(Number(value))}以下`
  if (key === 'avgTurnoverMin') return `平均売買代金 ${fmtCurrency(Number(value))}以上`
  if (key === 'avgTurnoverMax') return `平均売買代金 ${fmtCurrency(Number(value))}以下`
  if (key === 'avgVolumeMin') return `平均出来高 ${fmtVolume(Number(value))}以上`
  if (key === 'avgVolumeMax') return `平均出来高 ${fmtVolume(Number(value))}以下`
  if (key === 'priceMin') return `株価 ${fmtNumber(Number(value), 0)}円以上`
  if (key === 'priceMax') return `株価 ${fmtNumber(Number(value), 0)}円以下`
  if (key === 'ma25') return `25MA ${value === 'above' ? '上' : '下'}`
  if (key === 'ma75') return `75MA ${value === 'above' ? '上' : '下'}`
  if (key === 'high52WithinPct') return `52週高値 ${value}%以内`
  if (key === 'low52WithinPct') return `52週安値 ${value}%以内`
  if (key === 'universe') return value === 'nikkei225' ? '日経225' : value
  if (key.startsWith('stage_')) {
    const axis = key.slice(6) as PeriodExplorerAxisKey
    return `${PERIOD_EXPLORER_AXIS_LABELS[axis]} S${value.split(',').join('/S')}`
  }
  if (key === 'taxonomy') return TAXONOMIES.find((item) => item.value === value)?.label ?? value
  return `${key} ${value}`
}

function activeFilterEntries(params: URLSearchParams): Array<{ key: string; value: string }> {
  const keys = ['market', 'sector', 'margin', 'marketCapMin', 'marketCapMax', 'avgTurnoverMin', 'avgTurnoverMax', 'avgVolumeMin', 'avgVolumeMax', 'priceMin', 'priceMax', 'ma25', 'ma75', 'high52WithinPct', 'low52WithinPct', 'universe', ...PERIOD_EXPLORER_AXIS_KEYS.map((axis) => `stage_${axis}`)]
  return keys.flatMap((key) => {
    const value = params.get(key)
    if (!value) return []
    if (key === 'market') return value.split(',').filter(Boolean).map((market) => ({ key, value: market }))
    return [{ key, value }]
  })
}

export function PeriodExplorerClient({ calendarDates, defaultFrom, defaultTo }: Props) {
  const router = useRouter()
  const searchParams = useSearchParams()
  const query = searchParams.toString()
  const rankingParam = searchParams.get('ranking')
  const ranking = isPeriodExplorerRankingKey(rankingParam) ? rankingParam : 'return_up'
  const definition = PERIOD_EXPLORER_RANKING_MAP.get(ranking)!
  const taxonomy = (['sector17', 'sector33', 'major', 'subIndustry'].includes(searchParams.get('taxonomy') ?? '') ? searchParams.get('taxonomy') : 'sector33') as PeriodExplorerTaxonomy
  const limit = [50, 100, 200, 500].includes(Number(searchParams.get('limit'))) ? Number(searchParams.get('limit')) : 50
  const offset = Math.max(0, Number(searchParams.get('offset') ?? 0) || 0)
  const [draftFrom, setDraftFrom] = useState(searchParams.get('from') ?? defaultFrom)
  const [draftTo, setDraftTo] = useState(searchParams.get('to') ?? defaultTo)
  const [response, setResponse] = useState<PeriodExplorerResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [filtersOpen, setFiltersOpen] = useState(false)
  const requestSequence = useRef(0)

  useEffect(() => {
    setDraftFrom(searchParams.get('from') ?? defaultFrom)
    setDraftTo(searchParams.get('to') ?? defaultTo)
  }, [defaultFrom, defaultTo, query, searchParams])

  useEffect(() => {
    const controller = new AbortController()
    const sequence = ++requestSequence.current
    const params = new URLSearchParams(query)
    if (!params.get('from')) params.set('from', defaultFrom)
    if (!params.get('to')) params.set('to', defaultTo)
    if (!params.get('ranking')) params.set('ranking', ranking)
    if (!params.get('taxonomy')) params.set('taxonomy', taxonomy)
    if (!params.get('limit')) params.set('limit', String(limit))
    setLoading(true)
    setError(null)
    fetch(`/api/period-explorer?${params.toString()}`, { cache: 'no-store', signal: controller.signal })
      .then(async (result) => {
        const payload = await result.json() as PeriodExplorerResponse & { message?: string }
        if (!result.ok) throw new Error(payload.message ?? `HTTP ${result.status}`)
        return payload
      })
      .then((payload) => {
        if (sequence !== requestSequence.current) return
        setResponse(payload)
      })
      .catch((reason) => {
        if (controller.signal.aborted || sequence !== requestSequence.current) return
        setError(reason instanceof Error ? reason.message : String(reason))
      })
      .finally(() => {
        if (!controller.signal.aborted && sequence === requestSequence.current) setLoading(false)
      })
    return () => controller.abort()
  }, [defaultFrom, defaultTo, limit, query, ranking, taxonomy])

  const category = definition.category
  const categoryRankings = PERIOD_EXPLORER_RANKINGS.filter((item) => item.category === category)
  const filterEntries = useMemo(() => activeFilterEntries(new URLSearchParams(query)), [query])

  function replaceParams(mutator: (params: URLSearchParams) => void) {
    const params = new URLSearchParams(query)
    mutator(params)
    const next = params.toString()
    router.replace(`/period-explorer${next ? `?${next}` : ''}`, { scroll: false })
  }

  function applyDates() {
    replaceParams((params) => {
      params.set('from', draftFrom)
      params.set('to', draftTo)
      params.delete('offset')
    })
  }

  function applyQuickRange(option: (typeof QUICK_RANGES)[number]) {
    const endIndex = lastIndexAtOrBefore(calendarDates, draftTo || defaultTo)
    const end = calendarDates[endIndex]
    let startIndex = endIndex
    if ('tradingDays' in option) startIndex = Math.max(0, endIndex - option.tradingDays + 1)
    else if ('months' in option) startIndex = firstIndexAtOrAfter(calendarDates, subtractMonths(end, option.months))
    else startIndex = firstIndexAtOrAfter(calendarDates, `${end.slice(0, 4)}-01-01`)
    setDraftFrom(calendarDates[startIndex])
    setDraftTo(end)
    replaceParams((params) => {
      params.set('from', calendarDates[startIndex])
      params.set('to', end)
      params.delete('offset')
    })
  }

  function chooseCategory(next: PeriodExplorerRankingCategory) {
    const nextRanking = PERIOD_EXPLORER_RANKINGS.find((item) => item.category === next)!
    replaceParams((params) => {
      params.set('ranking', nextRanking.key)
      params.delete('sort')
      params.delete('direction')
      params.delete('offset')
    })
  }

  function setSimpleParam(key: string, value: string) {
    replaceParams((params) => {
      if (value) params.set(key, value)
      else params.delete(key)
      if (key === 'taxonomy') params.delete('sector')
      if (key !== 'offset') params.delete('offset')
    })
  }

  function toggleStage(axis: PeriodExplorerAxisKey, stage: number) {
    replaceParams((params) => {
      const key = `stage_${axis}`
      const current = (params.get(key) ?? '').split(',').map(Number).filter((value) => value >= 1 && value <= 6)
      const next = current.includes(stage) ? current.filter((value) => value !== stage) : [...current, stage].sort()
      if (next.length) params.set(key, next.join(','))
      else params.delete(key)
      params.delete('offset')
    })
  }

  function toggleListParam(key: string, value: string) {
    replaceParams((params) => {
      const current = (params.get(key) ?? '').split(',').filter(Boolean)
      const next = current.includes(value) ? current.filter((item) => item !== value) : [...current, value]
      if (next.length) params.set(key, next.join(','))
      else params.delete(key)
      params.delete('offset')
    })
  }

  function clearFilters(full = false) {
    replaceParams((params) => {
      for (const entry of activeFilterEntries(params)) params.delete(entry.key)
      params.delete('offset')
      if (full) {
        params.set('from', defaultFrom)
        params.set('to', defaultTo)
        params.set('ranking', 'return_up')
        params.set('taxonomy', 'sector33')
        params.delete('sort')
        params.delete('direction')
      }
    })
  }

  function sortBy(key: string) {
    replaceParams((params) => {
      const current = params.get('sort') ?? 'ranking'
      const currentDirection = params.get('direction') ?? definition.defaultDirection
      params.set('sort', key)
      params.set('direction', current === key && currentDirection === 'desc' ? 'asc' : 'desc')
      params.delete('offset')
    })
  }

  const stockRows = response?.resultKind === 'stocks' ? response.rows as PeriodExplorerStockRow[] : []
  const sectorRows = response?.resultKind === 'sectors' ? response.rows as PeriodExplorerSectorRow[] : []
  const duplicateReturn = ranking === 'return_up' || ranking === 'return_down'

  return (
    <div className="space-y-4">
      <header className="flex flex-wrap items-end justify-between gap-3 border-b border-[var(--color-border-strong)] pb-3">
        <div>
          <p className="text-[10px] font-black uppercase tracking-[0.12em] text-[var(--color-brand-700)]">Period Explorer</p>
          <h1 className="mt-0.5 text-[24px] font-black tracking-normal text-[var(--color-brand-950)] sm:text-[28px]">期間分析</h1>
          <p className="mt-1 text-[12px] font-semibold text-[var(--color-text-secondary)]">期間中に起きた値動き・構造変化・流動性から候補を発見</p>
        </div>
        {response && <div className="text-right text-[10px] font-semibold text-[var(--color-text-tertiary)]">
          <div>価格: 調整後 / Stage: PIT</div>
          <div>業種・市場・貸借区分: 現在属性</div>
        </div>}
      </header>

      <section className="border-y border-[var(--color-border-default)] bg-white px-3 py-3">
        <div className="flex flex-wrap items-end gap-2">
          <label className="min-w-[145px] text-[10px] font-black text-[var(--color-text-tertiary)]">開始日
            <input type="date" value={draftFrom} min={calendarDates[0]} max={draftTo || defaultTo} onChange={(event) => setDraftFrom(event.target.value)} className="mt-1 h-9 w-full border border-[var(--color-border-default)] bg-white px-2 text-[12px] font-bold tabular-nums" />
          </label>
          <span className="mb-2 text-[12px] text-[var(--color-text-tertiary)]">→</span>
          <label className="min-w-[145px] text-[10px] font-black text-[var(--color-text-tertiary)]">終了日
            <input type="date" value={draftTo} min={draftFrom || calendarDates[0]} max={defaultTo} onChange={(event) => setDraftTo(event.target.value)} className="mt-1 h-9 w-full border border-[var(--color-border-default)] bg-white px-2 text-[12px] font-bold tabular-nums" />
          </label>
          <button type="button" onClick={applyDates} disabled={!draftFrom || !draftTo || draftFrom > draftTo} className="inline-flex h-9 shrink-0 items-center gap-1 border border-[var(--color-brand-800)] bg-[var(--color-brand-800)] px-3 text-[11px] font-black text-white disabled:opacity-40"><Search size={13} />適用</button>
          <button type="button" onClick={() => clearFilters(true)} className="inline-flex h-9 shrink-0 items-center gap-1 border border-[var(--color-border-default)] bg-white px-3 text-[11px] font-bold text-[var(--color-text-secondary)]"><RotateCcw size={13} />リセット</button>
        </div>
        <div className="mt-2 flex gap-1 overflow-x-auto pb-1">
          {QUICK_RANGES.map((option) => <button key={option.key} type="button" onClick={() => applyQuickRange(option)} className="shrink-0 border border-[var(--color-border-soft)] bg-[var(--color-surface-subtle)] px-2 py-1 text-[10px] font-bold text-[var(--color-text-secondary)] hover:border-[var(--color-brand-300)]">{option.label}</button>)}
        </div>
        {response && <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] font-semibold text-[var(--color-text-tertiary)]">
          <span className="inline-flex items-center gap-1"><CalendarRange size={11} />採用期間 {fmtDate(response.range.adoptedFrom)} ～ {fmtDate(response.range.adoptedTo)}</span>
          <span>{response.range.tradingDays.toLocaleString('ja-JP')}取引日</span>
          {(response.range.requestedFrom && response.range.requestedFrom !== response.range.adoptedFrom) || (response.range.requestedTo && response.range.requestedTo !== response.range.adoptedTo)
            ? <span className="font-bold text-amber-700">非取引日を実取引日へ補正</span> : null}
        </div>}
      </section>

      <section className="border-b border-[var(--color-border-default)] pb-3">
        <div className="flex gap-1 overflow-x-auto pb-2" role="tablist" aria-label="ランキングカテゴリ">
          {CATEGORY_META.map((item) => <button key={item.key} type="button" role="tab" aria-selected={category === item.key} onClick={() => chooseCategory(item.key)} className={`h-8 shrink-0 border px-3 text-[10px] font-black ${category === item.key ? 'border-[var(--color-brand-800)] bg-[var(--color-brand-800)] text-white' : 'border-[var(--color-border-default)] bg-white text-[var(--color-text-secondary)]'}`}>{item.label}</button>)}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <select value={ranking} onChange={(event) => setSimpleParam('ranking', event.target.value)} className="h-9 w-full border border-[var(--color-border-strong)] bg-white px-2 text-[12px] font-black text-[var(--color-brand-950)] sm:w-auto sm:min-w-[210px]">
            {categoryRankings.map((item) => <option key={item.key} value={item.key}>{item.label}</option>)}
          </select>
          <span className="inline-flex min-w-0 flex-1 items-center gap-1 truncate text-[10px] font-semibold text-[var(--color-text-tertiary)]" title={definition.description}><CircleHelp size={12} className="shrink-0" /><span className="truncate">{definition.description}</span></span>
        </div>
      </section>

      <section className="max-w-full overflow-visible border-y border-[var(--color-border-default)] bg-[var(--color-surface-subtle)] px-3 py-2" aria-label="銘柄絞り込み">
        <div className="flex w-full min-w-0 items-center gap-2">
          <span className="hidden shrink-0 text-[10px] font-black text-[var(--color-brand-950)] sm:block">銘柄絞り込み</span>
          <div className="hidden min-w-0 flex-1 items-center gap-1.5 sm:flex">
            <MarketFilterMenu
              options={response?.options.markets ?? []}
              selected={(searchParams.get('market') ?? '').split(',').filter(Boolean)}
              onToggle={(value) => toggleListParam('market', value)}
              onClear={() => setSimpleParam('market', '')}
            />
            <CompactPresetSelect label="時価総額" value={searchParams.get('marketCapMin') ?? ''} presets={MARKET_CAP_PRESETS} onChange={(value) => setSimpleParam('marketCapMin', value)} />
            <CompactPresetSelect label="売買代金" value={searchParams.get('avgTurnoverMin') ?? ''} presets={TURNOVER_PRESETS} onChange={(value) => setSimpleParam('avgTurnoverMin', value)} />
            <CompactPresetSelect label="出来高" value={searchParams.get('avgVolumeMin') ?? ''} presets={VOLUME_PRESETS} onChange={(value) => setSimpleParam('avgVolumeMin', value)} />
            <StageFilterMenu params={searchParams} onToggle={toggleStage} />
          </div>
          <button type="button" aria-expanded={filtersOpen} onClick={() => setFiltersOpen((value) => !value)} className="inline-flex h-8 w-full min-w-0 items-center justify-center gap-1 border border-[var(--color-border-default)] bg-white px-2.5 text-[10px] font-black text-[var(--color-text-secondary)] sm:ml-auto sm:w-auto sm:shrink-0"><Filter size={12} />{filtersOpen ? '閉じる' : '詳細条件'}{filterEntries.length > 0 ? ` ${filterEntries.length}` : ''}</button>
        </div>
      </section>

      {filtersOpen && <section className="border border-[var(--color-border-default)] bg-[var(--color-surface-subtle)] p-3">
        <div className="flex items-center justify-between border-b border-[var(--color-border-soft)] pb-2">
          <h2 className="inline-flex items-center gap-1 text-[12px] font-black text-[var(--color-brand-950)]"><SlidersHorizontal size={14} />絞り込み条件</h2>
          <button type="button" onClick={() => clearFilters(false)} className="text-[10px] font-bold text-[var(--color-brand-700)]">期間を残して全解除</button>
        </div>
        <div className="mt-3 border-b border-[var(--color-border-soft)] pb-3 sm:hidden">
          <p className="mb-1.5 text-[9px] font-black text-[var(--color-text-tertiary)]">市場（複数選択可）</p>
          <MarketOptionButtons options={response?.options.markets ?? []} selected={(searchParams.get('market') ?? '').split(',').filter(Boolean)} onToggle={(value) => toggleListParam('market', value)} />
        </div>
        <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
          <FilterSelect label="分類" value={taxonomy} onChange={(value) => setSimpleParam('taxonomy', value)} options={TAXONOMIES} />
          <FilterSelect label="業種" value={searchParams.get('sector') ?? ''} onChange={(value) => setSimpleParam('sector', value)} options={[{ value: '', label: 'すべて' }, ...(response?.options.sectors ?? []).map((item) => ({ value: item.value, label: `${item.value} (${item.count})` }))]} />
          <FilterSelect label="貸借 / 信用" value={searchParams.get('margin') ?? ''} onChange={(value) => setSimpleParam('margin', value)} options={[{ value: '', label: 'すべて' }, ...(response?.options.marginTypes ?? []).map((item) => ({ value: item.value, label: `${item.value} (${item.count})` }))]} />
          <FilterSelect label="指数" value={searchParams.get('universe') ?? ''} onChange={(value) => setSimpleParam('universe', value)} options={[{ value: '', label: '全銘柄' }, { value: 'nikkei225', label: '日経225 (現在構成)' }]} />
          <FilterSelect label="25MA位置" value={searchParams.get('ma25') ?? ''} onChange={(value) => setSimpleParam('ma25', value)} options={[{ value: '', label: '指定なし' }, { value: 'above', label: '株価が上' }, { value: 'below', label: '株価が下' }]} />
          <FilterNumber label="時価総額下限" value={searchParams.get('marketCapMin') ?? ''} placeholder="円" onApply={(value) => setSimpleParam('marketCapMin', value)} />
          <FilterNumber label="時価総額上限" value={searchParams.get('marketCapMax') ?? ''} placeholder="円" onApply={(value) => setSimpleParam('marketCapMax', value)} />
          <FilterNumber label="平均売買代金下限" value={searchParams.get('avgTurnoverMin') ?? ''} placeholder="円" onApply={(value) => setSimpleParam('avgTurnoverMin', value)} />
          <FilterNumber label="平均売買代金上限" value={searchParams.get('avgTurnoverMax') ?? ''} placeholder="円" onApply={(value) => setSimpleParam('avgTurnoverMax', value)} />
          <FilterNumber label="平均出来高下限" value={searchParams.get('avgVolumeMin') ?? ''} placeholder="株" onApply={(value) => setSimpleParam('avgVolumeMin', value)} />
          <FilterNumber label="平均出来高上限" value={searchParams.get('avgVolumeMax') ?? ''} placeholder="株" onApply={(value) => setSimpleParam('avgVolumeMax', value)} />
          <FilterNumber label="株価下限" value={searchParams.get('priceMin') ?? ''} placeholder="円" onApply={(value) => setSimpleParam('priceMin', value)} />
          <FilterNumber label="株価上限" value={searchParams.get('priceMax') ?? ''} placeholder="円" onApply={(value) => setSimpleParam('priceMax', value)} />
          <FilterSelect label="75MA位置" value={searchParams.get('ma75') ?? ''} onChange={(value) => setSimpleParam('ma75', value)} options={[{ value: '', label: '指定なし' }, { value: 'above', label: '株価が上' }, { value: 'below', label: '株価が下' }]} />
          <FilterSelect label="52週高値" value={searchParams.get('high52WithinPct') ?? ''} onChange={(value) => setSimpleParam('high52WithinPct', value)} options={[{ value: '', label: '指定なし' }, { value: '5', label: '5%以内' }, { value: '10', label: '10%以内' }, { value: '20', label: '20%以内' }]} />
          <FilterSelect label="52週安値" value={searchParams.get('low52WithinPct') ?? ''} onChange={(value) => setSimpleParam('low52WithinPct', value)} options={[{ value: '', label: '指定なし' }, { value: '5', label: '5%以内' }, { value: '10', label: '10%以内' }, { value: '20', label: '20%以内' }]} />
        </div>
        <div className="mt-3 border-t border-[var(--color-border-soft)] pt-3">
          <p className="mb-2 text-[10px] font-black text-[var(--color-text-tertiary)]">終了日時点の6軸Stage</p>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {PERIOD_EXPLORER_AXIS_KEYS.map((axis) => {
              const selected = (searchParams.get(`stage_${axis}`) ?? '').split(',').map(Number)
              return <div key={axis} className="flex items-center gap-1.5"><span className="w-10 text-[10px] font-black text-[var(--color-text-secondary)]">{PERIOD_EXPLORER_AXIS_LABELS[axis].replace('足', '')}</span>{[1, 2, 3, 4, 5, 6].map((stage) => <button key={stage} type="button" aria-label={`${PERIOD_EXPLORER_AXIS_LABELS[axis]} Stage ${stage}`} onClick={() => toggleStage(axis, stage)} aria-pressed={selected.includes(stage)} className={selected.includes(stage) ? 'outline outline-2 outline-[var(--color-brand-700)] outline-offset-1' : ''}><StageTag stage={stage} size="sm" /></button>)}</div>
            })}
          </div>
        </div>
      </section>}

      {filterEntries.length > 0 && <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-[10px] font-black text-[var(--color-text-tertiary)]">条件</span>
        {filterEntries.map((entry) => <button key={`${entry.key}-${entry.value}`} type="button" onClick={() => entry.key === 'market' ? toggleListParam(entry.key, entry.value) : setSimpleParam(entry.key, '')} className="inline-flex items-center gap-1 whitespace-nowrap border border-[var(--color-brand-100)] bg-[var(--color-brand-50)] px-2 py-1 text-[10px] font-bold text-[var(--color-brand-800)]">{chipLabel(entry.key, entry.value)}<X size={10} /></button>)}
        <button type="button" onClick={() => clearFilters(false)} className="ml-auto whitespace-nowrap text-[10px] font-bold text-[var(--color-brand-700)]">条件をクリア</button>
      </div>}

      <section className="min-h-[360px] border-t border-[var(--color-border-strong)] bg-white">
        <div className="flex flex-wrap items-center gap-2 border-b border-[var(--color-border-default)] px-3 py-2">
          <div>
            <h2 className="text-[13px] font-black text-[var(--color-brand-950)]">{definition.label}ランキング</h2>
            <p className="text-[9px] font-semibold text-[var(--color-text-tertiary)]">{response ? `${response.total.toLocaleString('ja-JP')} / ${response.universeTotal.toLocaleString('ja-JP')}${response.resultKind === 'stocks' ? '銘柄' : '業種'}` : '集計中'} ｜ {fmtDate(response?.range.adoptedFrom ?? draftFrom)} ～ {fmtDate(response?.range.adoptedTo ?? draftTo)}</p>
          </div>
          <label className="ml-auto flex items-center gap-1 text-[10px] font-bold text-[var(--color-text-tertiary)]">表示
            <select value={limit} onChange={(event) => setSimpleParam('limit', event.target.value)} className="h-7 border border-[var(--color-border-default)] bg-white px-1 text-[10px] font-bold">{[50, 100, 200, 500].map((value) => <option key={value} value={value}>{value}</option>)}</select>
          </label>
          {response && <span className="text-[9px] text-[var(--color-text-tertiary)]">API {response.elapsedMs}ms{response.cacheHit ? ' / cache' : ''}</span>}
        </div>

        {error && <div className="m-3 border border-rose-200 bg-rose-50 p-3 text-[11px] font-bold text-rose-800">{error}</div>}
        {!error && loading && !response && <div className="flex h-72 items-center justify-center gap-2 text-[11px] font-bold text-[var(--color-text-tertiary)]"><LoaderCircle size={15} className="animate-spin" />期間データを集計しています</div>}
        {!error && response && <div className={loading ? 'pointer-events-none opacity-55' : ''} aria-busy={loading}>
          {response.total === 0 ? <div className="flex h-64 flex-col items-center justify-center gap-2 text-center"><p className="text-[12px] font-black text-[var(--color-text-secondary)]">条件に一致する銘柄がありません</p><button type="button" onClick={() => clearFilters(false)} className="text-[11px] font-bold text-[var(--color-brand-700)]">期間を残して条件を解除</button></div>
            : response.resultKind === 'stocks' ? <StockResults rows={stockRows} ranking={ranking} duplicateReturn={duplicateReturn} adoptedTo={response.range.adoptedTo} onSort={sortBy} />
              : <SectorResults rows={sectorRows} taxonomy={taxonomy} ranking={ranking} onFilter={(sector) => setSimpleParam('sector', sector)} />}
        </div>}

        {response && response.total > limit && <div className="flex items-center justify-between border-t border-[var(--color-border-default)] px-3 py-2">
          <button type="button" disabled={offset <= 0 || loading} onClick={() => setSimpleParam('offset', String(Math.max(0, offset - limit)))} className="inline-flex h-8 items-center gap-1 border border-[var(--color-border-default)] bg-white px-3 text-[10px] font-bold disabled:opacity-35"><ChevronLeft size={12} />前へ</button>
          <span className="text-[10px] font-semibold tabular-nums text-[var(--color-text-tertiary)]">{offset + 1}–{Math.min(offset + limit, response.total)} / {response.total}</span>
          <button type="button" disabled={offset + limit >= response.total || loading} onClick={() => setSimpleParam('offset', String(offset + limit))} className="inline-flex h-8 items-center gap-1 border border-[var(--color-border-default)] bg-white px-3 text-[10px] font-bold disabled:opacity-35">次へ<ChevronRight size={12} /></button>
        </div>}
      </section>

      {response && <p className="text-[9px] leading-5 text-[var(--color-text-tertiary)]">開始・終了価格のない銘柄 {response.excluded.missingEndpoints.toLocaleString('ja-JP')}件、ランキング値不足 {response.excluded.missingRankingValue.toLocaleString('ja-JP')}件。時価総額の株式数がPIT未収録の場合のみ現在株式数を使用し、行上で区別しています。</p>}
    </div>
  )
}

function FilterSelect({ label, value, options, onChange }: { label: string; value: string; options: Array<{ value: string; label: string }>; onChange: (value: string) => void }) {
  return <label className="text-[9px] font-black text-[var(--color-text-tertiary)]">{label}<select value={value} onChange={(event) => onChange(event.target.value)} className="mt-1 h-8 w-full min-w-0 border border-[var(--color-border-default)] bg-white px-1.5 text-[10px] font-bold text-[var(--color-text-secondary)]">{options.map((option) => <option key={`${option.value}-${option.label}`} value={option.value}>{option.label}</option>)}</select></label>
}

function FilterNumber({ label, value, placeholder, onApply }: { label: string; value: string; placeholder: string; onApply: (value: string) => void }) {
  const [draft, setDraft] = useState(value)
  useEffect(() => setDraft(value), [value])
  return <label className="text-[9px] font-black text-[var(--color-text-tertiary)]">{label}<input type="number" min="0" value={draft} placeholder={placeholder} onChange={(event) => setDraft(event.target.value)} onBlur={() => onApply(draft)} onKeyDown={(event) => { if (event.key === 'Enter') onApply(draft) }} className="mt-1 h-8 w-full min-w-0 border border-[var(--color-border-default)] bg-white px-1.5 text-[10px] font-bold tabular-nums" /></label>
}

function CompactPresetSelect({ label, value, presets, onChange }: { label: string; value: string; presets: Array<{ value: string; label: string }>; onChange: (value: string) => void }) {
  const known = !value || presets.some((preset) => preset.value === value)
  return <label className="inline-flex h-8 min-w-0 items-center gap-1 border border-[var(--color-border-default)] bg-white px-2 text-[9px] font-black text-[var(--color-text-tertiary)]">
    <span className="shrink-0">{label}</span>
    <select value={value} onChange={(event) => onChange(event.target.value)} className="min-w-0 max-w-[124px] bg-transparent text-[10px] font-bold text-[var(--color-text-secondary)] outline-none">
      <option value="">指定なし</option>
      {!known && <option value={value}>カスタム設定</option>}
      {presets.map((preset) => <option key={preset.value} value={preset.value}>{preset.label}</option>)}
    </select>
  </label>
}

function MarketOptionButtons({ options, selected, onToggle }: { options: Array<{ value: string; count: number }>; selected: string[]; onToggle: (value: string) => void }) {
  return <div className="flex flex-wrap gap-1">
    {options.map((option) => {
      const active = selected.includes(option.value)
      return <button key={option.value} type="button" aria-pressed={active} onClick={() => onToggle(option.value)} className={`whitespace-nowrap border px-2 py-1 text-[10px] font-bold [word-break:keep-all] ${active ? 'border-[var(--color-brand-700)] bg-[var(--color-brand-50)] text-[var(--color-brand-800)]' : 'border-[var(--color-border-default)] bg-white text-[var(--color-text-secondary)]'}`}>{option.value} <span className="text-[9px] font-semibold text-[var(--color-text-tertiary)]">{option.count}</span></button>
    })}
  </div>
}

function MarketFilterMenu({ options, selected, onToggle, onClear }: { options: Array<{ value: string; count: number }>; selected: string[]; onToggle: (value: string) => void; onClear: () => void }) {
  return <details className="group relative shrink-0 [&_summary::-webkit-details-marker]:hidden">
    <summary className="inline-flex h-8 cursor-pointer list-none items-center gap-1 border border-[var(--color-border-default)] bg-white px-2 text-[10px] font-bold text-[var(--color-text-secondary)]">
      市場 {selected.length > 0 ? `${selected.length}件` : 'すべて'}<ChevronDown size={11} className="transition-transform group-open:rotate-180" />
    </summary>
    <div className="absolute left-0 top-[calc(100%+4px)] z-30 w-[300px] border border-[var(--color-border-strong)] bg-white p-2 shadow-lg">
      <div className="mb-2 flex items-center justify-between"><span className="text-[9px] font-black text-[var(--color-text-tertiary)]">複数選択可</span>{selected.length > 0 && <button type="button" onClick={onClear} className="text-[9px] font-bold text-[var(--color-brand-700)]">全解除</button>}</div>
      <MarketOptionButtons options={options} selected={selected} onToggle={onToggle} />
    </div>
  </details>
}

function StageFilterMenu({ params, onToggle }: { params: URLSearchParams; onToggle: (axis: PeriodExplorerAxisKey, stage: number) => void }) {
  const selectedCount = PERIOD_EXPLORER_AXIS_KEYS.reduce((sum, axis) => sum + (params.get(`stage_${axis}`) ?? '').split(',').filter(Boolean).length, 0)
  return <details className="group relative ml-auto shrink-0 [&_summary::-webkit-details-marker]:hidden">
    <summary className="inline-flex h-8 cursor-pointer list-none items-center gap-1 border border-[var(--color-border-default)] bg-white px-2 text-[10px] font-bold text-[var(--color-text-secondary)]">
      6軸Stage {selectedCount > 0 ? `${selectedCount}件` : '指定なし'}<ChevronDown size={11} className="transition-transform group-open:rotate-180" />
    </summary>
    <div className="absolute right-0 top-[calc(100%+4px)] z-30 w-[340px] border border-[var(--color-border-strong)] bg-white p-3 shadow-lg">
      <p className="mb-2 text-[9px] font-semibold text-[var(--color-text-tertiary)]">同じ軸はOR、軸どうしはAND</p>
      <div className="space-y-2">
        {PERIOD_EXPLORER_AXIS_KEYS.map((axis) => {
          const selected = (params.get(`stage_${axis}`) ?? '').split(',').map(Number)
          return <div key={axis} className="flex items-center gap-1.5"><span className="w-10 shrink-0 text-[10px] font-black text-[var(--color-text-secondary)]">{PERIOD_EXPLORER_AXIS_LABELS[axis].replace('足', '')}</span>{[1, 2, 3, 4, 5, 6].map((stage) => <button key={stage} type="button" aria-label={`${PERIOD_EXPLORER_AXIS_LABELS[axis]} Stage ${stage}`} onClick={() => onToggle(axis, stage)} aria-pressed={selected.includes(stage)} className={selected.includes(stage) ? 'outline outline-2 outline-[var(--color-brand-700)] outline-offset-1' : ''}><StageTag stage={stage} size="sm" /></button>)}</div>
        })}
      </div>
    </div>
  </details>
}

function SortButton({ children, sortKey, onSort, align = 'left' }: { children: ReactNode; sortKey: string; onSort: (key: string) => void; align?: 'left' | 'right' }) {
  return <button type="button" onClick={() => onSort(sortKey)} className={`w-full whitespace-nowrap font-inherit hover:text-[var(--color-brand-800)] ${align === 'right' ? 'text-right' : 'text-left'}`}>{children}</button>
}

function StockResults({ rows, ranking, duplicateReturn, adoptedTo, onSort }: { rows: PeriodExplorerStockRow[]; ranking: PeriodExplorerRankingKey; duplicateReturn: boolean; adoptedTo: string; onSort: (key: string) => void }) {
  return <>
    <div className="hidden overflow-x-auto sm:block">
      <table className="w-full min-w-[1160px] table-fixed border-collapse text-[11px]">
        <colgroup>
          <col className="w-[44px]" /><col className="w-[238px]" /><col className="w-[104px]" /><col className="w-[205px]" /><col className="w-[86px]" />
          {!duplicateReturn && <col className="w-[82px]" />}<col className="w-[150px]" /><col className="w-[96px]" /><col className="hidden w-[64px] min-[1360px]:table-column" /><col className="w-[102px]" /><col className="w-[108px]" /><col className="hidden w-[104px] min-[1360px]:table-column" />
        </colgroup>
        <thead className="sticky top-0 z-10 bg-[var(--color-surface-subtle)] text-[9px] font-black text-[var(--color-text-tertiary)]">
          <tr className="border-b border-[var(--color-border-default)]">
            <th className="whitespace-nowrap px-1.5 py-2 text-right">Rank</th><th className="whitespace-nowrap px-2 py-2 text-left">銘柄</th>
            <th className="whitespace-nowrap px-2 py-2 text-right"><SortButton sortKey="ranking" onSort={onSort} align="right">ランキング値</SortButton></th>
            <th className="whitespace-nowrap px-2 py-2 text-left">6軸Stage</th><th className="whitespace-nowrap px-2 py-2 text-right"><SortButton sortKey="price" onSort={onSort} align="right">株価</SortButton></th>
            {!duplicateReturn && <th className="whitespace-nowrap px-2 py-2 text-right"><SortButton sortKey="periodReturn" onSort={onSort} align="right">期間騰落率</SortButton></th>}
            <th className="whitespace-nowrap px-2 py-2 text-left">業種</th><th className="whitespace-nowrap px-2 py-2 text-left [word-break:keep-all]">市場</th><th className="hidden whitespace-nowrap px-2 py-2 text-left [word-break:keep-all] min-[1360px]:table-cell">貸/信</th>
            <th className="whitespace-nowrap px-2 py-2 text-right"><SortButton sortKey="marketCap" onSort={onSort} align="right">時価総額</SortButton></th>
            <th className="whitespace-nowrap px-2 py-2 text-right"><SortButton sortKey="avgTurnover" onSort={onSort} align="right">平均売買代金</SortButton></th>
            <th className="hidden whitespace-nowrap px-2 py-2 text-right min-[1360px]:table-cell"><SortButton sortKey="avgVolume" onSort={onSort} align="right">平均出来高</SortButton></th>
          </tr>
        </thead>
        <tbody className="divide-y divide-[var(--color-border-subtle)]">
          {rows.map((row) => <tr key={row.ticker} className="h-[58px] hover:bg-[var(--color-surface-subtle)]">
            <td className="whitespace-nowrap px-1.5 py-2 text-right font-black tabular-nums text-[var(--color-text-tertiary)]">{row.rank}</td>
            <td className="overflow-hidden px-2 py-2 text-left"><span className="flex min-w-0 items-center gap-1.5"><Link href={`/stock/${encodeURIComponent(row.ticker)}?date=${encodeURIComponent(adoptedTo)}#overview`} className="flex min-w-0 items-baseline gap-2 text-[var(--color-brand-950)] hover:text-[var(--color-brand-700)] hover:underline"><span className="shrink-0 font-mono text-[10px] font-bold text-[var(--color-brand-800)]">{row.ticker}</span><span className="truncate font-black">{row.name}</span></Link><StockPreviewTrigger ticker={row.ticker} analysisDate={adoptedTo} context="periodExplorer" />{row.historicalOnly && <span className="shrink-0 border border-[var(--color-border-soft)] px-1 py-0.5 text-[8px] font-bold text-[var(--color-text-tertiary)]">履歴</span>}</span></td>
            <td className={`whitespace-nowrap px-2 py-2 text-right font-black tabular-nums ${tone(row.rankingValue)}`}>{rankingText(row.rankingValue, ranking)}</td>
            <td className="overflow-hidden px-2 py-2"><GroupedStageCode row={row} /></td>
            <td className="whitespace-nowrap px-2 py-2 text-right font-bold tabular-nums">{fmtNumber(row.endClose)}円</td>
            {!duplicateReturn && <td className={`whitespace-nowrap px-2 py-2 text-right font-bold tabular-nums ${tone(row.periodReturnPct)}`}>{fmtPercent(row.periodReturnPct)}</td>}
            <td className="truncate px-2 py-2 text-left font-semibold" title={row.selectedSector ?? ''}>{row.selectedSector ?? '未分類'}</td>
            <td className="px-2 py-2 text-left"><span className="inline-flex max-w-full whitespace-nowrap border border-[var(--color-border-soft)] bg-[var(--color-surface-subtle)] px-1.5 py-0.5 text-[9px] font-bold [word-break:keep-all]">{row.marketSegment ?? '未設定'}</span></td><td className="hidden whitespace-nowrap px-2 py-2 text-left text-[10px] font-semibold [word-break:keep-all] min-[1360px]:table-cell">{row.marginType ?? '未設定'}</td>
            <td className="whitespace-nowrap px-2 py-2 text-right font-bold tabular-nums" title={row.marketCapBasis === 'pit' ? '終了日時点で公表済みの株式数' : row.marketCapBasis === 'current' ? '現在株式数による参考値' : '株式数未取得'}>{fmtCurrency(row.marketCap)}{row.marketCapBasis === 'current' && <sup className="ml-0.5 text-[8px] text-amber-700">現</sup>}</td>
            <td className="whitespace-nowrap px-2 py-2 text-right font-bold tabular-nums">{fmtCurrency(row.avgTurnover)}</td><td className="hidden whitespace-nowrap px-2 py-2 text-right font-bold tabular-nums min-[1360px]:table-cell">{fmtVolume(row.avgVolume)}</td>
          </tr>)}
        </tbody>
      </table>
    </div>
    <div className="divide-y divide-[var(--color-border-default)] sm:hidden">
      {rows.map((row) => <article key={row.ticker} className="px-3 py-3">
        <div className="flex items-start gap-2"><span className="w-7 shrink-0 text-right text-[11px] font-black tabular-nums text-[var(--color-text-tertiary)]">{row.rank}</span><div className="min-w-0 flex-1"><div className="flex min-w-0 items-center gap-1"><Link href={`/stock/${encodeURIComponent(row.ticker)}?date=${encodeURIComponent(adoptedTo)}#overview`} className="min-w-0 flex-1 truncate text-[13px] font-black text-[var(--color-brand-950)]"><span className="mr-1.5 font-mono text-[11px] text-[var(--color-brand-700)]">{row.ticker}</span>{row.name}</Link><StockPreviewTrigger ticker={row.ticker} analysisDate={adoptedTo} context="periodExplorer" /></div><p className={`mt-1 text-[20px] font-black tabular-nums ${tone(row.rankingValue)}`}>{rankingText(row.rankingValue, ranking)}</p></div></div>
        <div className="mt-2 overflow-x-auto pl-9"><GroupedStageCode row={row} /></div>
        <p className="mt-2 pl-9 text-[10px] font-semibold text-[var(--color-text-secondary)]">{row.selectedSector ?? '未分類'} ｜ {row.marketSegment ?? '未設定'} ｜ {row.marginType ?? '未設定'}</p>
        <div className="mt-1 grid grid-cols-2 gap-x-3 gap-y-1 pl-9 text-[10px] font-semibold text-[var(--color-text-tertiary)]"><span>株価 <b className="text-[var(--color-text-primary)]">{fmtNumber(row.endClose)}円</b></span>{!duplicateReturn && <span>騰落 <b className={tone(row.periodReturnPct)}>{fmtPercent(row.periodReturnPct)}</b></span>}<span>時価総額 <b className="text-[var(--color-text-primary)]">{fmtCurrency(row.marketCap)}</b></span><span>売買代金 <b className="text-[var(--color-text-primary)]">{fmtCurrency(row.avgTurnover)}</b></span></div>
      </article>)}
    </div>
  </>
}

function SectorResults({ rows, taxonomy, ranking, onFilter }: { rows: PeriodExplorerSectorRow[]; taxonomy: PeriodExplorerTaxonomy; ranking: PeriodExplorerRankingKey; onFilter: (sector: string) => void }) {
  return <div className="overflow-x-auto"><table className="min-w-[760px] w-full border-collapse text-[11px]"><thead className="bg-[var(--color-surface-subtle)] text-[9px] font-black text-[var(--color-text-tertiary)]"><tr className="border-b border-[var(--color-border-default)]"><th className="w-12 px-3 py-2 text-right">Rank</th><th className="px-3 py-2 text-left">{TAXONOMIES.find((item) => item.value === taxonomy)?.label}</th><th className="w-32 px-3 py-2 text-right">ランキング値</th><th className="w-24 px-3 py-2 text-right">銘柄数</th><th className="w-28 px-3 py-2 text-right">平均騰落率</th><th className="w-28 px-3 py-2 text-right">中央値</th><th className="w-28 px-3 py-2 text-right">上昇比率</th><th className="w-32 px-3 py-2 text-right">Stage改善比率</th></tr></thead><tbody className="divide-y divide-[var(--color-border-subtle)]">{rows.map((row) => <tr key={row.sector} className="hover:bg-[var(--color-surface-subtle)]"><td className="px-3 py-2.5 text-right font-black tabular-nums text-[var(--color-text-tertiary)]">{row.rank}</td><td className="px-3 py-2.5 text-left"><button type="button" onClick={() => onFilter(row.sector)} className="font-black text-[var(--color-brand-900)] hover:underline">{row.sector}</button></td><td className={`px-3 py-2.5 text-right font-black tabular-nums ${tone(row.rankingValue)}`}>{rankingText(row.rankingValue, ranking)}</td><td className="px-3 py-2.5 text-right font-bold tabular-nums">{row.stocks}</td><td className={`px-3 py-2.5 text-right font-bold tabular-nums ${tone(row.avgReturnPct)}`}>{fmtPercent(row.avgReturnPct)}</td><td className={`px-3 py-2.5 text-right font-bold tabular-nums ${tone(row.medianReturnPct)}`}>{fmtPercent(row.medianReturnPct)}</td><td className="px-3 py-2.5 text-right font-bold tabular-nums">{fmtPercent(row.advancingRatePct)}</td><td className="px-3 py-2.5 text-right font-bold tabular-nums">{fmtPercent(row.stageImproveRatePct)}</td></tr>)}</tbody></table></div>
}
