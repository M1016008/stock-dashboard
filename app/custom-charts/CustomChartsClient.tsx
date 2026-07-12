'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowDown,
  ArrowUp,
  Calculator,
  ChevronDown,
  ChevronUp,
  Copy,
  Database,
  Download,
  Eraser,
  GripVertical,
  Heart,
  Save,
  Search,
  SlidersHorizontal,
  Sparkles,
  Trash2,
} from 'lucide-react'
import { CustomFormulaChart } from '@/components/charts/CustomFormulaChart'
import { Card, CardHeader } from '@/components/ui/Card'
import type {
  CustomChartCurrency,
  CustomChartEvaluation,
  CustomChartIndicatorConfig,
  CustomChartMissingPolicy,
  CustomChartMode,
  CustomChartRequest,
  CustomChartSymbolCandidate,
  StoredCustomChart,
} from '@/lib/custom-charts/types'
import type { ChartIntervalCode } from '@/lib/timeframes'

type PeriodCode = CustomChartRequest['period']

type FxStatus = {
  pair: string
  latestDate: string | null
  count: number
}

type SavedChart = StoredCustomChart & {
  source: 'local' | 'shared'
}

const LOCAL_STORAGE_KEY = 'stockboard-custom-charts-v1'

const MODE_OPTIONS: Array<{ value: CustomChartMode; label: string }> = [
  { value: 'valuation', label: '評価額' },
  { value: 'comparison', label: '価格比較' },
  { value: 'normalized', label: '基準化比較' },
]

const MODE_HINT: Record<CustomChartMode, string> = {
  valuation: '保有数量を反映',
  comparison: '差・比率を確認',
  normalized: '100基準で比較',
}

const PERIOD_OPTIONS: Array<{ value: PeriodCode; label: string }> = [
  { value: '3mo', label: '3ヶ月' },
  { value: '6mo', label: '6ヶ月' },
  { value: '1y', label: '1年' },
  { value: '2y', label: '2年' },
  { value: '5y', label: '5年' },
  { value: '10y', label: '10年' },
  { value: 'all', label: '全期間' },
]

const INTERVAL_OPTIONS: Array<{ value: ChartIntervalCode; label: string }> = [
  { value: 'D', label: 'D' },
  { value: '2D', label: '2D' },
  { value: 'W', label: 'W' },
  { value: '2W', label: '2W' },
  { value: 'M', label: 'M' },
  { value: '2M', label: '2M' },
]

const OPERATOR_BUTTONS = [
  { token: '+', label: '+' },
  { token: '-', label: '-' },
  { token: '*', label: '×' },
  { token: '/', label: '÷' },
  { token: '^', label: '^' },
  { token: '(', label: '(' },
  { token: ')', label: ')' },
  { token: '* 100', label: '×100' },
  { token: '* 200', label: '×200' },
  { token: '/ 3', label: '÷3' },
]

const QUICK_TEMPLATES: Array<{
  id: string
  label: string
  badge: string
  name: string
  formula: string
  mode: CustomChartMode
  displayCurrency: CustomChartCurrency
  missingPolicy: CustomChartMissingPolicy
}> = [
  {
    id: 'portfolio',
    label: '保有株評価額',
    badge: '評価額',
    name: '保有株ポートフォリオ',
    formula: '7203 * 100 + 6758 * 200',
    mode: 'valuation',
    displayCurrency: 'LOCAL',
    missingPolicy: 'intersection',
  },
  {
    id: 'ratio',
    label: '銘柄レシオ',
    badge: '比率',
    name: 'トヨタ/ソニー レシオ',
    formula: '7203 / 6758',
    mode: 'comparison',
    displayCurrency: 'LOCAL',
    missingPolicy: 'intersection',
  },
  {
    id: 'spread',
    label: '価格差',
    badge: '差分',
    name: 'トヨタ-ホンダ 価格差',
    formula: '7203 - 7267',
    mode: 'comparison',
    displayCurrency: 'LOCAL',
    missingPolicy: 'intersection',
  },
  {
    id: 'average',
    label: '3銘柄平均',
    badge: '平均',
    name: '大型3銘柄平均',
    formula: '(7203 + 6758 + 9984) / 3',
    mode: 'normalized',
    displayCurrency: 'LOCAL',
    missingPolicy: 'intersection',
  },
]

const DEFAULT_INDICATORS: CustomChartIndicatorConfig = {
  ma: [5, 25, 75],
  bollinger: true,
  rsi: true,
  macd: true,
  volumeMode: 'turnover',
}

function emptyChart(name = '保有株ポートフォリオ'): StoredCustomChart {
  const now = Math.floor(Date.now() / 1000)
  return {
    id: `local-${now}`,
    name,
    formula: '7203 * 100 + 6758 * 200',
    mode: 'valuation',
    baseDate: null,
    displayCurrency: 'LOCAL',
    missingPolicy: 'intersection',
    indicators: DEFAULT_INDICATORS,
    favorite: false,
    sortOrder: now,
    createdAt: now,
    updatedAt: now,
  }
}

async function readJson<T>(response: Response): Promise<T> {
  const json = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(typeof json.error === 'string' ? json.error : 'リクエストに失敗しました。')
  return json as T
}

function normalizeStoredChart(value: unknown): StoredCustomChart | null {
  if (!value || typeof value !== 'object') return null
  const row = value as Partial<StoredCustomChart>
  if (typeof row.id !== 'string' || typeof row.formula !== 'string') return null
  return {
    id: row.id,
    name: row.name || '名称未設定',
    formula: row.formula,
    mode: row.mode === 'comparison' || row.mode === 'normalized' ? row.mode : 'valuation',
    baseDate: row.baseDate ?? null,
    displayCurrency: row.displayCurrency === 'JPY' || row.displayCurrency === 'USD' ? row.displayCurrency : 'LOCAL',
    missingPolicy: row.missingPolicy === 'carry-forward' ? 'carry-forward' : 'intersection',
    indicators: {
      ...DEFAULT_INDICATORS,
      ...(row.indicators ?? {}),
      ma: Array.isArray(row.indicators?.ma) ? row.indicators.ma : DEFAULT_INDICATORS.ma,
      volumeMode: row.indicators?.volumeMode === 'volume' ? 'volume' : 'turnover',
    },
    favorite: Boolean(row.favorite),
    sortOrder: Number(row.sortOrder ?? 0),
    createdAt: Number(row.createdAt ?? 0),
    updatedAt: Number(row.updatedAt ?? 0),
  }
}

function insertAtCursor(text: string, insert: string): string {
  return `${text.trimEnd()} ${insert} `
}

function updatedChartFromState(args: {
  id?: string
  name: string
  formula: string
  mode: CustomChartMode
  baseDate: string | null
  displayCurrency: CustomChartCurrency
  missingPolicy: CustomChartMissingPolicy
  indicators: CustomChartIndicatorConfig
  favorite?: boolean
  sortOrder?: number
  createdAt?: number
}): StoredCustomChart {
  const now = Math.floor(Date.now() / 1000)
  return {
    id: args.id ?? `local-${now}`,
    name: args.name.trim() || '名称未設定',
    formula: args.formula.trim(),
    mode: args.mode,
    baseDate: args.baseDate || null,
    displayCurrency: args.displayCurrency,
    missingPolicy: args.missingPolicy,
    indicators: args.indicators,
    favorite: Boolean(args.favorite),
    sortOrder: Number(args.sortOrder ?? now),
    createdAt: Number(args.createdAt ?? now),
    updatedAt: now,
  }
}

function SavedChartList({
  charts,
  onOpen,
  onDuplicate,
  onDelete,
  onMove,
  onToggleFavorite,
}: {
  charts: SavedChart[]
  onOpen: (chart: SavedChart) => void
  onDuplicate: (chart: SavedChart) => void
  onDelete: (chart: SavedChart) => void
  onMove: (chart: SavedChart, direction: -1 | 1) => void
  onToggleFavorite: (chart: SavedChart) => void
}) {
  return (
      <div className="space-y-2">
        {charts.length === 0 && (
          <div className="rounded-[4px] border border-dashed border-[var(--color-border-default)] bg-[var(--color-surface-subtle)] px-3 py-6 text-center text-[12px] font-bold text-[var(--color-text-secondary)]">
            保存済みはありません
          </div>
        )}
        {charts.map((chart, index) => (
          <div key={`${chart.source}:${chart.id}`} className="rounded-[4px] border border-[var(--color-border-default)] bg-white p-2">
            <button
              type="button"
              onClick={() => onOpen(chart)}
              className="flex w-full items-start gap-2 text-left"
            >
              <GripVertical size={16} className="mt-0.5 shrink-0 text-[var(--color-text-tertiary)]" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13px] font-black text-[var(--color-brand-900)]">{chart.name}</span>
                <span className="mt-1 block truncate font-mono text-[11px] font-semibold text-[var(--color-text-secondary)]">{chart.formula}</span>
              </span>
            </button>
            <div className="mt-2 flex items-center justify-between gap-2 border-t border-[var(--color-border-default)] pt-2">
              <span className="rounded-[3px] bg-[var(--color-brand-50)] px-2 py-0.5 text-[10px] font-black text-[var(--color-brand-800)]">
                {chart.source === 'shared' ? '共有' : 'ブラウザ'}
              </span>
              <div className="flex items-center gap-1">
                <button type="button" title="上へ" disabled={index === 0} onClick={() => onMove(chart, -1)} className="rounded-[3px] p-1.5 text-[var(--color-brand-700)] hover:bg-[var(--color-surface-subtle)] disabled:opacity-35">
                  <ArrowUp size={14} />
                </button>
                <button type="button" title="下へ" disabled={index === charts.length - 1} onClick={() => onMove(chart, 1)} className="rounded-[3px] p-1.5 text-[var(--color-brand-700)] hover:bg-[var(--color-surface-subtle)] disabled:opacity-35">
                  <ArrowDown size={14} />
                </button>
                <button type="button" title="お気に入り" onClick={() => onToggleFavorite(chart)} className="rounded-[3px] p-1.5 text-[var(--color-market-red)] hover:bg-[var(--color-surface-subtle)]">
                  <Heart size={14} fill={chart.favorite ? 'currentColor' : 'none'} />
                </button>
                <button type="button" title="複製" onClick={() => onDuplicate(chart)} className="rounded-[3px] p-1.5 text-[var(--color-brand-700)] hover:bg-[var(--color-surface-subtle)]">
                  <Copy size={14} />
                </button>
                <button type="button" title="削除" onClick={() => onDelete(chart)} className="rounded-[3px] p-1.5 text-[var(--color-price-down)] hover:bg-[var(--color-surface-subtle)]">
                  <Trash2 size={14} />
                </button>
              </div>
            </div>
          </div>
        ))}
      </div>
  )
}

export function CustomChartsClient() {
  const formulaRef = useRef<HTMLTextAreaElement>(null)
  const [name, setName] = useState('保有株ポートフォリオ')
  const [formula, setFormula] = useState('7203 * 100 + 6758 * 200')
  const [mode, setMode] = useState<CustomChartMode>('valuation')
  const [chartType, setChartType] = useState<'line' | 'candlestick'>('line')
  const [period, setPeriod] = useState<PeriodCode>('1y')
  const [interval, setInterval] = useState<ChartIntervalCode>('D')
  const [displayCurrency, setDisplayCurrency] = useState<CustomChartCurrency>('LOCAL')
  const [missingPolicy, setMissingPolicy] = useState<CustomChartMissingPolicy>('intersection')
  const [baseDate, setBaseDate] = useState('')
  const [indicators, setIndicators] = useState<CustomChartIndicatorConfig>(DEFAULT_INDICATORS)
  const [evaluation, setEvaluation] = useState<CustomChartEvaluation | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [suggestions, setSuggestions] = useState<CustomChartSymbolCandidate[]>([])
  const [sharedCharts, setSharedCharts] = useState<StoredCustomChart[]>([])
  const [localCharts, setLocalCharts] = useState<StoredCustomChart[]>([])
  const [activeChart, setActiveChart] = useState<{ source: 'local' | 'shared'; id: string } | null>(null)
  const [fxStatus, setFxStatus] = useState<FxStatus | null>(null)
  const [fxCsv, setFxCsv] = useState('')
  const [libraryTab, setLibraryTab] = useState<'shared' | 'local'>('shared')
  const [savedFilter, setSavedFilter] = useState('')
  const [showFxPanel, setShowFxPanel] = useState(false)

  const requestPayload = useMemo<CustomChartRequest>(() => ({
    formula,
    mode,
    period,
    interval,
    displayCurrency,
    missingPolicy,
    baseDate: mode === 'normalized' && baseDate ? baseDate : null,
    indicators,
  }), [baseDate, displayCurrency, formula, indicators, interval, missingPolicy, mode, period])

  const refreshSharedCharts = useCallback(async () => {
    const json = await fetch('/api/custom-charts', { cache: 'no-store' }).then((response) => readJson<{ charts: StoredCustomChart[] }>(response))
    setSharedCharts(json.charts)
  }, [])

  const refreshFxStatus = useCallback(async () => {
    const json = await fetch('/api/custom-charts/fx-rates', { cache: 'no-store' }).then((response) => readJson<FxStatus>(response))
    setFxStatus(json)
  }, [])

  const persistLocalCharts = useCallback((charts: StoredCustomChart[]) => {
    setLocalCharts(charts)
    window.localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(charts))
  }, [])

  const evaluate = useCallback(async (override?: Partial<CustomChartRequest>) => {
    const payload = { ...requestPayload, ...(override ?? {}) }
    setLoading(true)
    setError(null)
    setNotice(null)
    try {
      const json = await fetch('/api/custom-charts/evaluate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        cache: 'no-store',
        body: JSON.stringify(payload),
      }).then((response) => readJson<CustomChartEvaluation>(response))
      setEvaluation(json)
    } catch (evalError) {
      setEvaluation(null)
      setError(evalError instanceof Error ? evalError.message : '合成チャートの計算に失敗しました。')
    } finally {
      setLoading(false)
    }
  }, [requestPayload])

  useEffect(() => {
    try {
      const parsed = JSON.parse(window.localStorage.getItem(LOCAL_STORAGE_KEY) ?? '[]')
      const charts = Array.isArray(parsed) ? parsed.map(normalizeStoredChart).filter((row): row is StoredCustomChart => Boolean(row)) : []
      setLocalCharts(charts)
    } catch {
      setLocalCharts([])
    }
    refreshSharedCharts().catch((sharedError) => setError(sharedError instanceof Error ? sharedError.message : '共有ライブラリを取得できませんでした。'))
    refreshFxStatus().catch(() => setFxStatus(null))
  }, [refreshFxStatus, refreshSharedCharts])

  useEffect(() => {
    void evaluate()
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const q = query.trim()
    if (!q) {
      setSuggestions([])
      return
    }
    const controller = new AbortController()
    const timer = window.setTimeout(async () => {
      try {
        const params = new URLSearchParams({ q })
        const json = await fetch(`/api/custom-charts/symbols?${params.toString()}`, {
          cache: 'no-store',
          signal: controller.signal,
        }).then((response) => readJson<{ symbols: CustomChartSymbolCandidate[] }>(response))
        setSuggestions(json.symbols)
      } catch (suggestError) {
        if ((suggestError as Error).name !== 'AbortError') setSuggestions([])
      }
    }, 180)
    return () => {
      window.clearTimeout(timer)
      controller.abort()
    }
  }, [query])

  const currentChart = () => updatedChartFromState({
    id: activeChart?.source === 'local' ? activeChart.id : undefined,
    name,
    formula,
    mode,
    baseDate: mode === 'normalized' && baseDate ? baseDate : null,
    displayCurrency,
    missingPolicy,
    indicators,
    favorite: activeChart?.source === 'local'
      ? localCharts.find((chart) => chart.id === activeChart.id)?.favorite
      : activeChart?.source === 'shared'
        ? sharedCharts.find((chart) => chart.id === activeChart.id)?.favorite
        : undefined,
    sortOrder: activeChart?.source === 'local'
      ? localCharts.find((chart) => chart.id === activeChart.id)?.sortOrder
      : activeChart?.source === 'shared'
        ? sharedCharts.find((chart) => chart.id === activeChart.id)?.sortOrder
        : undefined,
    createdAt: activeChart?.source === 'local'
      ? localCharts.find((chart) => chart.id === activeChart.id)?.createdAt
      : activeChart?.source === 'shared'
        ? sharedCharts.find((chart) => chart.id === activeChart.id)?.createdAt
        : undefined,
  })

  const openChart = (chart: SavedChart) => {
    setName(chart.name)
    setFormula(chart.formula)
    setMode(chart.mode)
    setBaseDate(chart.baseDate ?? '')
    setDisplayCurrency(chart.displayCurrency)
    setMissingPolicy(chart.missingPolicy)
    setIndicators(chart.indicators)
    setActiveChart({ source: chart.source, id: chart.id })
    setNotice(`${chart.name}を読み込みました。`)
  }

  const insertToken = (token: string) => {
    const textarea = formulaRef.current
    if (!textarea) {
      setFormula((current) => insertAtCursor(current, token))
      return
    }
    const start = textarea.selectionStart
    const end = textarea.selectionEnd
    const before = formula.slice(0, start).trimEnd()
    const after = formula.slice(end).trimStart()
    const next = `${before}${before ? ' ' : ''}${token}${after ? ' ' : ''}${after}`
    const cursor = `${before}${before ? ' ' : ''}${token}`.length
    setFormula(next)
    requestAnimationFrame(() => {
      textarea.focus()
      textarea.setSelectionRange(cursor, cursor)
    })
  }

  const applyTemplate = (template: (typeof QUICK_TEMPLATES)[number]) => {
    setName(template.name)
    setFormula(template.formula)
    setMode(template.mode)
    setDisplayCurrency(template.displayCurrency)
    setMissingPolicy(template.missingPolicy)
    setBaseDate('')
    setActiveChart(null)
    setNotice(`${template.label}をセットしました。`)
    void evaluate({
      formula: template.formula,
      mode: template.mode,
      displayCurrency: template.displayCurrency,
      missingPolicy: template.missingPolicy,
      baseDate: null,
    })
  }

  const saveLocal = () => {
    const next = currentChart()
    const exists = localCharts.some((chart) => chart.id === next.id)
    const charts = exists
      ? localCharts.map((chart) => (chart.id === next.id ? next : chart))
      : [next, ...localCharts]
    persistLocalCharts(charts)
    setActiveChart({ source: 'local', id: next.id })
    setNotice('ブラウザ保存を更新しました。')
  }

  const saveShared = async () => {
    setError(null)
    setNotice(null)
    try {
      const body = currentChart()
      const response = activeChart?.source === 'shared'
        ? await fetch(`/api/custom-charts/${encodeURIComponent(activeChart.id)}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            cache: 'no-store',
            body: JSON.stringify(body),
          })
        : await fetch('/api/custom-charts', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            cache: 'no-store',
            body: JSON.stringify(body),
          })
      const json = await readJson<{ chart: StoredCustomChart }>(response)
      await refreshSharedCharts()
      setActiveChart({ source: 'shared', id: json.chart.id })
      setNotice('共有ライブラリに保存しました。')
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : '共有保存に失敗しました。')
    }
  }

  const duplicateChart = (chart: SavedChart) => {
    const now = Math.floor(Date.now() / 1000)
    const copy: StoredCustomChart = {
      ...chart,
      id: `local-${Date.now()}`,
      name: `${chart.name} コピー`,
      favorite: false,
      sortOrder: now,
      createdAt: now,
      updatedAt: now,
    }
    persistLocalCharts([copy, ...localCharts])
    setNotice('ブラウザ保存に複製しました。')
  }

  const deleteChart = async (chart: SavedChart) => {
    setError(null)
    setNotice(null)
    try {
      if (chart.source === 'local') {
        persistLocalCharts(localCharts.filter((row) => row.id !== chart.id))
        if (activeChart?.source === 'local' && activeChart.id === chart.id) setActiveChart(null)
      } else {
        await fetch(`/api/custom-charts/${encodeURIComponent(chart.id)}`, { method: 'DELETE', cache: 'no-store' }).then((response) => readJson<{ ok: boolean }>(response))
        await refreshSharedCharts()
        if (activeChart?.source === 'shared' && activeChart.id === chart.id) setActiveChart(null)
      }
      setNotice('削除しました。')
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : '削除に失敗しました。')
    }
  }

  const toggleFavorite = async (chart: SavedChart) => {
    if (chart.source === 'local') {
      persistLocalCharts(localCharts.map((row) => (row.id === chart.id ? { ...row, favorite: !row.favorite, updatedAt: Math.floor(Date.now() / 1000) } : row)))
      return
    }
    try {
      await fetch(`/api/custom-charts/${encodeURIComponent(chart.id)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        cache: 'no-store',
        body: JSON.stringify({ favorite: !chart.favorite }),
      }).then((response) => readJson<{ chart: StoredCustomChart }>(response))
      await refreshSharedCharts()
    } catch (favoriteError) {
      setError(favoriteError instanceof Error ? favoriteError.message : 'お気に入りを更新できませんでした。')
    }
  }

  const moveChart = async (chart: SavedChart, direction: -1 | 1) => {
    const list = chart.source === 'local' ? sortedLocal : sortedShared
    const index = list.findIndex((row) => row.id === chart.id)
    const target = list[index + direction]
    if (index < 0 || !target) return

    if (chart.source === 'local') {
      const now = Math.floor(Date.now() / 1000)
      const next = localCharts.map((row) => {
        if (row.id === chart.id) return { ...row, sortOrder: target.sortOrder, updatedAt: now }
        if (row.id === target.id) return { ...row, sortOrder: chart.sortOrder, updatedAt: now }
        return row
      })
      persistLocalCharts(next)
      return
    }

    try {
      await Promise.all([
        fetch(`/api/custom-charts/${encodeURIComponent(chart.id)}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          cache: 'no-store',
          body: JSON.stringify({ sortOrder: target.sortOrder }),
        }).then((response) => readJson<{ chart: StoredCustomChart }>(response)),
        fetch(`/api/custom-charts/${encodeURIComponent(target.id)}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          cache: 'no-store',
          body: JSON.stringify({ sortOrder: chart.sortOrder }),
        }).then((response) => readJson<{ chart: StoredCustomChart }>(response)),
      ])
      await refreshSharedCharts()
    } catch (moveError) {
      setError(moveError instanceof Error ? moveError.message : '並び順を更新できませんでした。')
    }
  }

  const importFxCsv = async () => {
    setError(null)
    setNotice(null)
    try {
      const result = await fetch('/api/custom-charts/fx-rates/import?source=manual-csv', {
        method: 'POST',
        headers: { 'Content-Type': 'text/csv; charset=utf-8' },
        cache: 'no-store',
        body: fxCsv,
      }).then((response) => readJson<{ imported: number; skipped: number }>(response))
      await refreshFxStatus()
      setNotice(`FX CSVを取り込みました: ${result.imported}件 / スキップ ${result.skipped}件`)
      setFxCsv('')
    } catch (fxError) {
      setError(fxError instanceof Error ? fxError.message : 'FX CSVの取込に失敗しました。')
    }
  }

  const sharedSaved: SavedChart[] = sharedCharts.map((chart) => ({ ...chart, source: 'shared' }))
  const localSaved: SavedChart[] = localCharts.map((chart) => ({ ...chart, source: 'local' }))
  const sortedShared = [...sharedSaved].sort((a, b) => Number(b.favorite) - Number(a.favorite) || a.sortOrder - b.sortOrder || b.updatedAt - a.updatedAt)
  const sortedLocal = [...localSaved].sort((a, b) => Number(b.favorite) - Number(a.favorite) || a.sortOrder - b.sortOrder || b.updatedAt - a.updatedAt)
  const savedQuery = savedFilter.trim().toLowerCase()
  const visibleSaved = (libraryTab === 'shared' ? sortedShared : sortedLocal).filter((chart) => {
    if (!savedQuery) return true
    return `${chart.name} ${chart.formula}`.toLowerCase().includes(savedQuery)
  })

  return (
    <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_360px]">
      <div className="space-y-4">
        <Card size="lg">
          <CardHeader
            title="数式"
            hint="ライン/ロウソク足を切り替えできます。ロウソク足は構成銘柄のOHLCを数式で合成した近似です。"
            action={evaluation ? `${evaluation.series.length.toLocaleString('ja-JP')} points` : null}
          />
          <div className="space-y-4">
            <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-4">
              {QUICK_TEMPLATES.map((template) => (
                <button
                  key={template.id}
                  type="button"
                  onClick={() => applyTemplate(template)}
                  className="group flex min-h-[72px] items-start gap-3 rounded-[4px] border border-[var(--color-border-default)] bg-white px-3 py-3 text-left transition-colors hover:border-[var(--color-brand-700)] hover:bg-[var(--color-brand-50)]"
                >
                  <span className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-[3px] border border-[var(--color-border-default)] bg-[var(--color-surface-subtle)] text-[var(--color-brand-800)] group-hover:border-[var(--color-brand-700)] group-hover:bg-white">
                    <Sparkles size={15} strokeWidth={2.4} />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-2">
                      <span className="truncate text-[13px] font-black text-[var(--color-brand-900)]">{template.label}</span>
                      <span className="shrink-0 rounded-[3px] bg-[var(--color-market-red)] px-1.5 py-0.5 text-[10px] font-black text-white">{template.badge}</span>
                    </span>
                    <span className="mt-1 block truncate font-mono text-[11px] font-semibold text-[var(--color-text-secondary)]">{template.formula}</span>
                  </span>
                </button>
              ))}
            </div>

            <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_260px]">
              <label className="block">
                <span className="mb-1 block text-[11px] font-black text-[var(--color-text-tertiary)]">チャート名</span>
                <input
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  className="h-10 w-full rounded-[4px] border border-[var(--color-border-default)] bg-white px-3 text-[13px] font-bold text-[var(--color-text-primary)] outline-none focus:border-[var(--color-brand-700)]"
                />
              </label>
              <label className="block">
                <span className="mb-1 block text-[11px] font-black text-[var(--color-text-tertiary)]">銘柄候補</span>
                <div className="relative">
                  <Search size={15} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--color-text-tertiary)]" />
                  <input
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    placeholder="コード/社名"
                    className="h-10 w-full rounded-[4px] border border-[var(--color-border-default)] bg-white py-2 pl-8 pr-3 text-[13px] font-bold text-[var(--color-text-primary)] outline-none focus:border-[var(--color-brand-700)]"
                  />
                </div>
              </label>
            </div>

            {suggestions.length > 0 && (
              <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-3">
                {suggestions.map((symbol) => (
                  <button
                    key={symbol.token}
                    type="button"
                    onClick={() => {
                      insertToken(symbol.token)
                      setQuery('')
                      setSuggestions([])
                    }}
                    className="flex min-h-12 items-center gap-2 rounded-[4px] border border-[var(--color-border-default)] bg-white px-3 py-2 text-left hover:border-[var(--color-brand-700)]"
                  >
                    <span className="rounded-[3px] bg-[var(--color-brand-800)] px-2 py-1 text-[11px] font-black text-white">{symbol.token}</span>
                    <span className="min-w-0">
                      <span className="block truncate text-[12px] font-black text-[var(--color-brand-900)]">{symbol.name}</span>
                      <span className="block truncate text-[10px] font-bold text-[var(--color-text-tertiary)]">{symbol.description} / {symbol.currency}</span>
                    </span>
                  </button>
                ))}
              </div>
            )}

            <label className="block">
              <span className="mb-1 block text-[11px] font-black text-[var(--color-text-tertiary)]">計算式</span>
              <textarea
                ref={formulaRef}
                value={formula}
                onChange={(event) => setFormula(event.target.value)}
                rows={3}
                className="w-full rounded-[4px] border border-[var(--color-border-default)] bg-white px-3 py-2 font-mono text-[14px] font-bold text-[var(--color-brand-900)] outline-none focus:border-[var(--color-brand-700)]"
              />
            </label>

            <div className="grid gap-2 lg:grid-cols-[minmax(0,1fr)_auto]">
              <div className="flex flex-wrap items-center gap-2">
                {OPERATOR_BUTTONS.map((operator) => (
                  <button
                    key={operator.token}
                    type="button"
                    onClick={() => insertToken(operator.token)}
                    className="inline-flex h-9 min-w-9 items-center justify-center rounded-[4px] border border-[var(--color-border-default)] bg-white px-3 text-[14px] font-black text-[var(--color-brand-900)] hover:border-[var(--color-brand-700)]"
                    title={operator.token}
                  >
                    {operator.label}
                  </button>
                ))}
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => evaluate()}
                  disabled={loading}
                  className="inline-flex h-9 items-center gap-1.5 rounded-[4px] border border-[var(--color-market-red-dark)] bg-[var(--color-market-red)] px-4 text-[13px] font-black text-white disabled:opacity-60"
                >
                  <Calculator size={15} />
                  {loading ? '計算中...' : '計算'}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setName(emptyChart().name)
                    setFormula(emptyChart().formula)
                    setMode('valuation')
                    setBaseDate('')
                    setDisplayCurrency('LOCAL')
                    setMissingPolicy('intersection')
                    setIndicators(DEFAULT_INDICATORS)
                    setActiveChart(null)
                    setEvaluation(null)
                    setError(null)
                    setNotice(null)
                  }}
                  className="inline-flex h-9 items-center gap-1.5 rounded-[4px] border border-[var(--color-border-default)] bg-white px-3 text-[12px] font-black text-[var(--color-text-secondary)] hover:border-[var(--color-brand-700)]"
                >
                  <Eraser size={14} />
                  クリア
                </button>
              </div>
            </div>

            <div className="rounded-[4px] border border-[var(--color-border-default)] bg-[var(--color-surface-subtle)] p-3">
              <div className="mb-3 flex items-center gap-2 text-[12px] font-black text-[var(--color-brand-900)]">
                <SlidersHorizontal size={15} />
                表示設定
              </div>
              <div className="grid gap-3 lg:grid-cols-[1.35fr_1fr_1fr_1fr]">
                <div>
                  <span className="mb-1 block text-[11px] font-black text-[var(--color-text-tertiary)]">モード</span>
                  <div className="grid grid-cols-3 gap-1.5">
                    {MODE_OPTIONS.map((option) => (
                      <button
                        key={option.value}
                        type="button"
                        onClick={() => setMode(option.value)}
                        className={`min-h-10 rounded-[4px] border px-2 py-1 text-left transition-colors ${
                          mode === option.value
                            ? 'border-[var(--color-brand-800)] bg-[var(--color-brand-800)] text-white'
                            : 'border-[var(--color-border-default)] bg-white text-[var(--color-brand-900)] hover:border-[var(--color-brand-700)]'
                        }`}
                      >
                        <span className="block text-[12px] font-black leading-tight">{option.label}</span>
                        <span className={`mt-0.5 block text-[10px] font-bold leading-tight ${mode === option.value ? 'text-white/75' : 'text-[var(--color-text-tertiary)]'}`}>
                          {MODE_HINT[option.value]}
                        </span>
                      </button>
                    ))}
                  </div>
                </div>
              <label className="block">
                <span className="mb-1 block text-[11px] font-black text-[var(--color-text-tertiary)]">表示通貨</span>
                <select value={displayCurrency} onChange={(event) => setDisplayCurrency(event.target.value as CustomChartCurrency)} className="h-10 w-full rounded-[4px] border border-[var(--color-border-default)] bg-white px-3 text-[13px] font-bold">
                  <option value="LOCAL">単一通貨のみ</option>
                  <option value="JPY">JPY換算</option>
                  <option value="USD">USD換算</option>
                </select>
              </label>
              <label className="block">
                <span className="mb-1 block text-[11px] font-black text-[var(--color-text-tertiary)]">欠損処理</span>
                <select value={missingPolicy} onChange={(event) => setMissingPolicy(event.target.value as CustomChartMissingPolicy)} className="h-10 w-full rounded-[4px] border border-[var(--color-border-default)] bg-white px-3 text-[13px] font-bold">
                  <option value="intersection">共通取引日のみ</option>
                  <option value="carry-forward">直近価格を引き継ぎ</option>
                </select>
              </label>
              <label className="block">
                <span className="mb-1 block text-[11px] font-black text-[var(--color-text-tertiary)]">基準日</span>
                <input
                  type="date"
                  disabled={mode !== 'normalized'}
                  value={baseDate}
                  onChange={(event) => setBaseDate(event.target.value)}
                  className="h-10 w-full rounded-[4px] border border-[var(--color-border-default)] bg-white px-3 text-[13px] font-bold disabled:bg-[var(--color-surface-subtle)] disabled:text-[var(--color-text-tertiary)]"
                />
              </label>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => setChartType('line')}
                className={`h-8 rounded-[4px] border px-3 text-[12px] font-black ${chartType === 'line' ? 'border-[var(--color-brand-800)] bg-[var(--color-brand-800)] text-white' : 'border-[var(--color-border-default)] bg-white text-[var(--color-brand-900)]'}`}
              >
                ライン
              </button>
              <button
                type="button"
                onClick={() => setChartType('candlestick')}
                className={`h-8 rounded-[4px] border px-3 text-[12px] font-black ${chartType === 'candlestick' ? 'border-[var(--color-brand-800)] bg-[var(--color-brand-800)] text-white' : 'border-[var(--color-border-default)] bg-white text-[var(--color-brand-900)]'}`}
              >
                ロウソク足
              </button>
              <span className="mx-1 h-5 w-px bg-[var(--color-border-default)]" />
              {PERIOD_OPTIONS.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  onClick={() => setPeriod(option.value)}
                  className={`h-8 rounded-[4px] border px-3 text-[12px] font-black ${period === option.value ? 'border-[var(--color-market-red)] bg-[var(--color-market-red)] text-white' : 'border-[var(--color-border-default)] bg-white text-[var(--color-brand-900)]'}`}
                >
                  {option.label}
                </button>
              ))}
              <span className="mx-1 h-5 w-px bg-[var(--color-border-default)]" />
              {INTERVAL_OPTIONS.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  onClick={() => setInterval(option.value)}
                  className={`h-8 rounded-[4px] border px-3 text-[12px] font-black ${interval === option.value ? 'border-[var(--color-brand-800)] bg-[var(--color-brand-800)] text-white' : 'border-[var(--color-border-default)] bg-white text-[var(--color-brand-900)]'}`}
                >
                  {option.label}
                </button>
              ))}
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <label className="inline-flex h-8 items-center gap-2 rounded-[4px] border border-[var(--color-border-default)] bg-white px-3 text-[12px] font-bold">
                <input type="checkbox" checked={indicators.bollinger} onChange={(event) => setIndicators((current) => ({ ...current, bollinger: event.target.checked }))} />
                BB
              </label>
              <label className="inline-flex h-8 items-center gap-2 rounded-[4px] border border-[var(--color-border-default)] bg-white px-3 text-[12px] font-bold">
                <input type="checkbox" checked={indicators.rsi} onChange={(event) => setIndicators((current) => ({ ...current, rsi: event.target.checked }))} />
                RSI
              </label>
              <label className="inline-flex h-8 items-center gap-2 rounded-[4px] border border-[var(--color-border-default)] bg-white px-3 text-[12px] font-bold">
                <input type="checkbox" checked={indicators.macd} onChange={(event) => setIndicators((current) => ({ ...current, macd: event.target.checked }))} />
                MACD
              </label>
              <label className="inline-flex h-8 items-center gap-2 rounded-[4px] border border-[var(--color-border-default)] bg-white px-3 text-[12px] font-bold">
                <input
                  type="checkbox"
                  checked={indicators.volumeMode === 'turnover'}
                  onChange={(event) => setIndicators((current) => ({ ...current, volumeMode: event.target.checked ? 'turnover' : 'volume' }))}
                />
                売買代金
              </label>
            </div>
          </div>
        </Card>

        {(error || notice || evaluation?.warnings.length) && (
          <div className="space-y-2">
            {error && <div className="rounded-[4px] border border-[var(--color-price-down)] bg-red-50 px-3 py-2 text-[13px] font-bold text-[var(--color-price-down)]">{error}</div>}
            {notice && <div className="rounded-[4px] border border-[var(--color-pattern-600)] bg-green-50 px-3 py-2 text-[13px] font-bold text-[var(--color-pattern-700)]">{notice}</div>}
            {evaluation?.warnings.map((warning) => (
              <div key={warning} className="rounded-[4px] border border-[var(--color-border-default)] bg-[var(--color-surface-subtle)] px-3 py-2 text-[12px] font-bold text-[var(--color-text-secondary)]">{warning}</div>
            ))}
          </div>
        )}

        <Card size="lg">
          <CardHeader
            title="チャート"
            hint={evaluation?.description ?? '合成後系列に対して、チャートと指標を表示します。'}
            action={evaluation?.effectiveCurrency ?? null}
          />
          <CustomFormulaChart evaluation={evaluation} loading={loading} chartType={chartType} />
        </Card>
      </div>

      <aside className="space-y-4">
        <Card size="sm" className="xl:sticky xl:top-[132px]">
          <CardHeader title="保存" hint={activeChart ? `${activeChart.source}:${activeChart.id}` : '未選択'} />
          <div className="grid gap-2">
            <button type="button" onClick={saveLocal} className="inline-flex h-10 items-center justify-center gap-2 rounded-[4px] border border-[var(--color-border-default)] bg-white px-3 text-[13px] font-black text-[var(--color-brand-900)] hover:border-[var(--color-brand-700)]">
              <Save size={15} />
              ブラウザ保存
            </button>
            <button type="button" onClick={saveShared} className="inline-flex h-10 items-center justify-center gap-2 rounded-[4px] border border-[var(--color-brand-800)] bg-[var(--color-brand-800)] px-3 text-[13px] font-black text-white">
              <Database size={15} />
              共有ライブラリ保存
            </button>
            <button type="button" onClick={() => duplicateChart({ ...currentChart(), source: 'local' })} className="inline-flex h-10 items-center justify-center gap-2 rounded-[4px] border border-[var(--color-border-default)] bg-white px-3 text-[13px] font-black text-[var(--color-brand-900)] hover:border-[var(--color-brand-700)]">
              <Copy size={15} />
              複製して保存
            </button>
          </div>
        </Card>

        <Card size="sm">
          <CardHeader
            title="保存済み"
            hint={libraryTab === 'shared' ? `${sortedShared.length}件` : `${sortedLocal.length}件`}
            action={
              <div className="inline-flex rounded-[3px] border border-[var(--color-border-default)] bg-white p-0.5">
                <button type="button" onClick={() => setLibraryTab('shared')} className={`rounded-[2px] px-2 py-1 text-[10px] font-black ${libraryTab === 'shared' ? 'bg-[var(--color-brand-800)] text-white' : 'text-[var(--color-brand-800)]'}`}>共有</button>
                <button type="button" onClick={() => setLibraryTab('local')} className={`rounded-[2px] px-2 py-1 text-[10px] font-black ${libraryTab === 'local' ? 'bg-[var(--color-brand-800)] text-white' : 'text-[var(--color-brand-800)]'}`}>ブラウザ</button>
              </div>
            }
          />
          <div className="mb-3 relative">
            <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--color-text-tertiary)]" />
            <input
              value={savedFilter}
              onChange={(event) => setSavedFilter(event.target.value)}
              placeholder="保存名/式を検索"
              className="h-9 w-full rounded-[4px] border border-[var(--color-border-default)] bg-white py-1 pl-8 pr-3 text-[12px] font-bold outline-none focus:border-[var(--color-brand-700)]"
            />
          </div>
          <SavedChartList
            charts={visibleSaved}
            onOpen={openChart}
            onDuplicate={duplicateChart}
            onDelete={deleteChart}
            onMove={moveChart}
            onToggleFavorite={toggleFavorite}
          />
        </Card>

        <Card size="sm">
          <CardHeader
            title="FX CSV"
            hint={fxStatus ? `${fxStatus.pair}: ${fxStatus.latestDate ?? '-'} / ${fxStatus.count}件` : '未確認'}
            action={
              <button type="button" onClick={() => setShowFxPanel((value) => !value)} className="inline-flex items-center gap-1 text-[11px] font-black">
                {showFxPanel ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
                {showFxPanel ? '閉じる' : '開く'}
              </button>
            }
          />
          {showFxPanel && (
            <>
              <div className="mb-2 flex justify-end">
                <button type="button" onClick={refreshFxStatus} className="rounded-[3px] border border-[var(--color-border-default)] bg-white px-2 py-1 text-[11px] font-black text-[var(--color-brand-800)]">
                  状態更新
                </button>
              </div>
              <textarea
                value={fxCsv}
                onChange={(event) => setFxCsv(event.target.value)}
                rows={4}
                placeholder={"date,pair,rate\n2026-07-10,USDJPY,160.12"}
                className="w-full rounded-[4px] border border-[var(--color-border-default)] bg-white px-3 py-2 font-mono text-[12px] font-semibold outline-none focus:border-[var(--color-brand-700)]"
              />
              <button
                type="button"
                onClick={importFxCsv}
                disabled={!fxCsv.trim()}
                className="mt-2 inline-flex h-9 w-full items-center justify-center gap-2 rounded-[4px] border border-[var(--color-border-default)] bg-white px-3 text-[12px] font-black text-[var(--color-brand-900)] disabled:opacity-50"
              >
                <Download size={14} />
                CSV取込
              </button>
            </>
          )}
        </Card>

        <Card size="sm">
          <CardHeader title="構成銘柄" hint={evaluation ? `${evaluation.assets.length}銘柄` : '-'} />
          <div className="space-y-2">
            {evaluation?.assets.map((asset) => (
              <div key={asset.key} className="flex items-center justify-between gap-2 rounded-[4px] border border-[var(--color-border-default)] bg-white px-3 py-2">
                <div className="min-w-0">
                  <div className="truncate text-[12px] font-black text-[var(--color-brand-900)]">{asset.name}</div>
                  <div className="font-mono text-[10px] font-semibold text-[var(--color-text-tertiary)]">{asset.key} / {asset.priceBasis}</div>
                </div>
                <span className="shrink-0 rounded-[3px] bg-[var(--color-brand-50)] px-2 py-0.5 text-[10px] font-black text-[var(--color-brand-800)]">{asset.currency}</span>
              </div>
            )) ?? (
              <div className="rounded-[4px] border border-dashed border-[var(--color-border-default)] bg-[var(--color-surface-subtle)] px-3 py-5 text-center text-[12px] font-bold text-[var(--color-text-secondary)]">
                未計算
              </div>
            )}
          </div>
        </Card>
      </aside>
    </div>
  )
}
