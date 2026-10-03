'use client'

import Link from 'next/link'
import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { Activity, CheckCircle2, ChevronDown, CircleHelp, Columns3, Filter, GitCompareArrows, History, LoaderCircle, Plus, RefreshCw, RotateCcw, Save, ScanLine, Search, SlidersHorizontal, Sparkles, Trash2, TriangleAlert, X } from 'lucide-react'
import {
  DEFAULT_SCREENING_COLUMNS,
  SCREENING_CATEGORY_LABELS,
  SCREENING_METRICS,
  SCREENING_METRIC_MAP,
  SCREENING_PRESETS,
  type IntegratedScreeningResponse,
  type IntegratedScreeningRow,
  type ScreeningCondition,
  type ScreeningMetricKey,
  type ScreeningOperator,
} from '@/lib/integrated-screener'
import type { ScreenerReasonContract, ScreenerReasonItem } from '@/lib/screener-reason'
import type {
  SavedScreenChangeReasonContract,
  SavedScreenDefinitionContract,
  SavedScreenEvaluationDetail,
  SavedScreenEvaluationStatus,
} from '@/lib/screener-evaluation'
import {
  isCompleteScreeningCondition,
  type ScreenerNaturalLanguageProposal,
} from '@/lib/screener-natural-language'
import { getCompareSymbols, toggleComparedSymbol } from '@/lib/client/stock-workspace'
import { StockPreviewTrigger } from '@/components/stock-preview/StockPreviewTrigger'

const STATE_KEY = 'stockboard_integrated_screener_state_v1'
const SAVED_KEY = 'stockboard_integrated_screener_saved_v1'
const SCROLL_KEY = 'stockboard_integrated_screener_scroll_v1'
const MAX_COMPARE = 8

interface ScreenState {
  asOf: string
  conditions: ScreeningCondition[]
  sort: ScreeningMetricKey
  direction: 'asc' | 'desc'
  columns: ScreeningMetricKey[]
  page: number
}

interface LegacySavedScreen {
  id: string
  name: string
  state: ScreenState
}

const defaultState: ScreenState = {
  asOf: '', conditions: [], sort: 'marketCap', direction: 'desc', columns: DEFAULT_SCREENING_COLUMNS, page: 0,
}

const OPERATOR_LABELS: Record<ScreeningOperator, string> = {
  gte: '以上', gt: 'より大きい', lte: '以下', lt: '未満', eq: '一致', between: '範囲', in: 'いずれか', has_data: 'データあり',
}

function newId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

function encodeState(state: ScreenState): string {
  return encodeURIComponent(JSON.stringify({ ...state, asOf: state.asOf || undefined }))
}

function parseState(value: string | null): ScreenState | null {
  if (!value) return null
  try {
    const parsed = JSON.parse(decodeURIComponent(value)) as Partial<ScreenState>
    const conditions = Array.isArray(parsed.conditions)
      ? parsed.conditions.filter((condition) => condition && SCREENING_METRIC_MAP.has(condition.metric))
      : []
    const columns = Array.isArray(parsed.columns) ? parsed.columns.filter((column) => SCREENING_METRIC_MAP.has(column)) : DEFAULT_SCREENING_COLUMNS
    return {
      asOf: typeof parsed.asOf === 'string' ? parsed.asOf : '', conditions,
      sort: parsed.sort && SCREENING_METRIC_MAP.has(parsed.sort) ? parsed.sort : 'marketCap',
      direction: parsed.direction === 'asc' ? 'asc' : 'desc', columns: columns.length > 0 ? columns : DEFAULT_SCREENING_COLUMNS,
      page: Number.isInteger(parsed.page) && Number(parsed.page) >= 0 ? Number(parsed.page) : 0,
    }
  } catch {
    return null
  }
}

function fmtNumber(value: number | null, digits = 1): string {
  if (value == null || !Number.isFinite(value)) return '—'
  return value.toLocaleString('ja-JP', { maximumFractionDigits: digits })
}

function fmtCurrency(value: number | null): string {
  if (value == null || !Number.isFinite(value)) return '—'
  const abs = Math.abs(value)
  if (abs >= 1e12) return `${(value / 1e12).toFixed(2)}兆円`
  if (abs >= 1e8) return `${(value / 1e8).toFixed(1)}億円`
  if (abs >= 1e4) return `${(value / 1e4).toFixed(1)}万円`
  return `${value.toLocaleString('ja-JP')}円`
}

function formatValue(row: IntegratedScreeningRow, key: ScreeningMetricKey): string {
  const definition = SCREENING_METRIC_MAP.get(key)!
  const value = row[key as keyof IntegratedScreeningRow]
  if (value == null || value === '') return '—'
  if (definition.valueType === 'currency') return fmtCurrency(Number(value))
  if (definition.valueType === 'percent') return `${fmtNumber(Number(value))}%`
  if (definition.valueType === 'stage') return `S${value}`
  if (definition.valueType === 'boolean') return value ? 'あり' : 'なし'
  if (definition.valueType === 'number') return `${fmtNumber(Number(value))}${definition.unit ?? ''}`
  return String(value)
}

function stageTone(stage: number): string {
  if (stage === 1 || stage === 6) return 'border-emerald-300 bg-emerald-50 text-emerald-800'
  if (stage === 2 || stage === 5) return 'border-amber-300 bg-amber-50 text-amber-800'
  return 'border-rose-300 bg-rose-50 text-rose-800'
}

function StageCode({ value }: { value: string | null }) {
  if (!value || value.length !== 6) return <span className="text-[var(--color-text-muted)]">—</span>
  return <span className="inline-flex gap-0.5" aria-label={`6ステージ ${value}`}>
    {[...value].map((digit, index) => <span key={`${digit}-${index}`} className={`inline-flex h-5 w-5 items-center justify-center border text-[10px] font-black ${stageTone(Number(digit))}`}>{digit}</span>)}
  </span>
}

function conditionSummary(condition: ScreeningCondition): string {
  const metric = SCREENING_METRIC_MAP.get(condition.metric)
  if (!metric) return ''
  const operator = OPERATOR_LABELS[condition.operator]
  const format = (value: unknown): string => {
    if (value == null) return ''
    const option = metric.options?.find((item) => String(item.value) === String(value))
    if (option) return option.label
    if (metric.valueType === 'currency') return fmtCurrency(Number(value))
    if (metric.valueType === 'percent') return `${fmtNumber(Number(value))}%`
    if (metric.valueType === 'stage') return `Stage ${value}`
    if (metric.valueType === 'boolean') return value ? 'あり' : 'なし'
    if (metric.valueType === 'number') return `${fmtNumber(Number(value))}${metric.unit ?? ''}`
    return String(value)
  }
  const value = Array.isArray(condition.value) ? condition.value.map(format).join(', ') : format(condition.value)
  return condition.operator === 'has_data' ? `${metric.label}: ${operator}` : `${metric.label} ${operator} ${value}${condition.valueTo != null ? `〜${format(condition.valueTo)}` : ''}`
}

function coverageFor(response: IntegratedScreeningResponse | null, metric: ScreeningMetricKey): number | null {
  return response?.coverage.find((item) => item.metric === metric)?.percent ?? null
}

function ReasonList({ items, empty }: { items: ScreenerReasonItem[]; empty: string }) {
  if (items.length === 0) return <p className="py-2 text-[10px] leading-5 text-[var(--color-text-muted)]">{empty}</p>
  return <ul className="divide-y divide-[var(--color-border-subtle)]">
    {items.map((item) => <li key={item.id} className="py-2 first:pt-1">
      <p className="text-[11px] font-bold leading-5 text-[var(--color-text-primary)]">{item.message}</p>
      <p className="mt-0.5 text-[9px] leading-4 text-[var(--color-text-muted)]">
        {item.source.sourceMetric} / 基準 {item.source.asOf}{item.source.sourceDate ? ` / データ ${item.source.sourceDate.slice(0, 10)}` : ''}
      </p>
    </li>)}
  </ul>
}

function ReasonPanel({ reason, loading, error, onClose }: {
  reason: ScreenerReasonContract | null
  loading: boolean
  error: string | null
  onClose?: () => void
}) {
  return <div className="bg-sky-50/45 px-3 py-3 max-[640px]:px-3">
    <div className="flex items-start justify-between gap-3 border-b border-[var(--color-border-default)] pb-2">
      <div className="min-w-0">
        <div className="flex items-baseline gap-2">
          <h3 className="truncate text-[12px] font-black text-[var(--color-brand-900)]">{reason ? `${reason.ticker} ${reason.name}` : '通過理由を確認'}</h3>
          {reason && <span className="shrink-0 text-[9px] text-[var(--color-text-muted)]">基準 {reason.asOf}</span>}
        </div>
        <p className="mt-0.5 text-[9px] text-[var(--color-text-muted)]">条件判定と同じServing値による再現可能な事実説明</p>
      </div>
      {onClose && <button type="button" onClick={onClose} className="inline-flex h-7 w-7 shrink-0 items-center justify-center border border-[var(--color-border-default)] bg-white" aria-label="理由を閉じる"><X size={13} /></button>}
    </div>
    {loading && <div className="flex h-24 items-center justify-center gap-2 text-[11px] text-[var(--color-text-muted)]"><LoaderCircle size={14} className="animate-spin" />理由を取得しています…</div>}
    {error && <div className="my-3 border border-rose-200 bg-rose-50 p-2 text-[10px] text-rose-800">{error}</div>}
    {reason && !loading && !error && <>
      <div className="grid grid-cols-3 divide-x divide-[var(--color-border-default)] max-[640px]:grid-cols-1 max-[640px]:divide-x-0 max-[640px]:divide-y">
        <section className="pr-3 max-[640px]:py-2 max-[640px]:pr-0">
          <h4 className="flex items-center gap-1 text-[10px] font-black text-emerald-800"><CheckCircle2 size={12} />条件に該当した理由</h4>
          <ReasonList items={reason.matchedConditions} empty="抽出条件は設定されていません。" />
        </section>
        <section className="px-3 max-[640px]:px-0 max-[640px]:py-2">
          <h4 className="flex items-center gap-1 text-[10px] font-black text-sky-800"><ScanLine size={12} />条件外の参考情報</h4>
          <ReasonList items={reason.supportingFacts} empty="比較可能な追加事実はありません。" />
        </section>
        <section className="pl-3 max-[640px]:py-2 max-[640px]:pl-0">
          <h4 className="flex items-center gap-1 text-[10px] font-black text-amber-800"><TriangleAlert size={12} />注意すべき事実</h4>
          <ReasonList items={reason.cautions} empty="今回のルールで追加表示する注意事実はありません。" />
        </section>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-1 border-t border-[var(--color-border-default)] pt-2 text-[9px] text-[var(--color-text-muted)]">
        <span>{reason.disclaimer}</span><span>Reason API {reason.elapsedMs}ms{reason.cacheHit ? ' / cache' : ''}</span>
      </div>
    </>}
  </div>
}

function ChangeReasonPanel({ reason, loading, error, onClose }: {
  reason: SavedScreenChangeReasonContract | null
  loading: boolean
  error: string | null
  onClose?: () => void
}) {
  return <div className="bg-sky-50/45 px-3 py-3">
    <div className="flex items-start justify-between gap-3 border-b border-[var(--color-border-default)] pb-2">
      <div className="min-w-0">
        <div className="flex flex-wrap items-baseline gap-2">
          <h3 className="truncate text-[12px] font-black text-[var(--color-brand-900)]">{reason ? `${reason.ticker} ${reason.name}` : '変化理由を確認'}</h3>
          {reason && <span className={`border px-1.5 py-0.5 text-[9px] font-black ${reason.status === 'NEW' ? 'border-emerald-300 bg-emerald-50 text-emerald-800' : 'border-rose-300 bg-rose-50 text-rose-800'}`}>{reason.status}</span>}
        </div>
        <p className="mt-0.5 text-[9px] text-[var(--color-text-muted)]">{reason ? `${reason.previousAsOf ?? '初回'} → ${reason.currentAsOf} / ${reason.summary}` : '前回と今回を同じPIT条件で比較'}</p>
      </div>
      {onClose && <button type="button" onClick={onClose} className="inline-flex h-7 w-7 shrink-0 items-center justify-center border border-[var(--color-border-default)] bg-white" aria-label="変化理由を閉じる"><X size={13} /></button>}
    </div>
    {loading && <div className="flex h-24 items-center justify-center gap-2 text-[11px] text-[var(--color-text-muted)]"><LoaderCircle size={14} className="animate-spin" />差分を取得しています…</div>}
    {error && <div className="my-3 border border-rose-200 bg-rose-50 p-2 text-[10px] text-rose-800">{error}</div>}
    {reason && !loading && !error && <>
      <div className="grid grid-cols-2 divide-x divide-[var(--color-border-default)] max-[640px]:grid-cols-1 max-[640px]:divide-x-0 max-[640px]:divide-y">
        <section className="pr-3 max-[640px]:pb-2 max-[640px]:pr-0">
          <h4 className="text-[10px] font-black text-[var(--color-brand-900)]">条件の成立変化</h4>
          {reason.conditionChanges.length === 0
            ? <p className="py-2 text-[10px] text-[var(--color-text-muted)]">条件値または対象データの変化で集合が変わりました。</p>
            : <ul className="divide-y divide-[var(--color-border-subtle)]">{reason.conditionChanges.map((item) => <li key={item.id} className="py-2"><p className="text-[11px] font-bold leading-5">{item.message}</p><p className="text-[9px] text-[var(--color-text-muted)]">{item.source.sourceMetric} / {item.source.previousAsOf ?? 'データなし'} → {item.source.currentAsOf}</p></li>)}</ul>}
        </section>
        <section className="pl-3 max-[640px]:pt-2 max-[640px]:pl-0">
          <h4 className="text-[10px] font-black text-[var(--color-brand-900)]">参考になる構造変化</h4>
          {reason.contextChanges.length === 0
            ? <p className="py-2 text-[10px] text-[var(--color-text-muted)]">主要な構造・予想・Valuation差分はありません。</p>
            : <ul className="divide-y divide-[var(--color-border-subtle)]">{reason.contextChanges.slice(0, 6).map((item) => <li key={item.id} className="py-2 text-[10px] font-bold leading-5">{item.message}</li>)}</ul>}
        </section>
      </div>
      {reason.reason && <div className="mt-2 border-t border-[var(--color-border-default)] pt-2">
        <h4 className="text-[10px] font-black text-[var(--color-brand-900)]">{reason.status === 'NEW' ? '今回の条件一致理由' : '前回時点の一致理由'}</h4>
        <ReasonList items={reason.reason.matchedConditions} empty="一致理由がありません。" />
      </div>}
      <div className="mt-2 flex flex-wrap justify-between gap-1 border-t border-[var(--color-border-default)] pt-2 text-[9px] text-[var(--color-text-muted)]"><span>{reason.disclaimer}</span><span>Reason API {reason.elapsedMs}ms</span></div>
    </>}
  </div>
}

function ConditionEditor({
  condition, response, onChange, onRemove,
}: {
  condition: ScreeningCondition
  response: IntegratedScreeningResponse | null
  onChange: (next: ScreeningCondition) => void
  onRemove: () => void
}) {
  const metric = SCREENING_METRIC_MAP.get(condition.metric) ?? SCREENING_METRICS[0]
  const serverOptions = response?.options[condition.metric] ?? []
  const options = metric.options ?? serverOptions.map((option) => ({ value: option.value, label: `${option.value}（${option.count}）` }))
  const coverage = coverageFor(response, condition.metric)
  const warning = metric.coverageWarningBelow != null && coverage != null && coverage < metric.coverageWarningBelow
  const value = Array.isArray(condition.value) ? condition.value.join(',') : String(condition.value ?? '')
  return <div className="border border-[var(--color-border-default)] bg-white p-2">
    <div className="grid grid-cols-[minmax(0,1.45fr)_minmax(92px,0.75fr)_minmax(88px,1fr)_32px] gap-1.5 max-[640px]:grid-cols-[1fr_92px_32px]">
      <select value={condition.metric} onChange={(event) => {
        const nextMetric = event.target.value as ScreeningMetricKey
        const nextDefinition = SCREENING_METRIC_MAP.get(nextMetric)!
        onChange({ id: condition.id, metric: nextMetric, operator: nextDefinition.operators[0], value: nextDefinition.valueType === 'boolean' ? true : '' })
      }} className="h-8 min-w-0 border border-[var(--color-border-default)] bg-white px-2 text-[11px] font-bold">
        {Object.entries(SCREENING_CATEGORY_LABELS).map(([category, label]) => <optgroup key={category} label={label}>
          {SCREENING_METRICS.filter((item) => item.category === category).map((item) => <option key={item.key} value={item.key}>{item.label}</option>)}
        </optgroup>)}
      </select>
      <select value={condition.operator} onChange={(event) => onChange({ ...condition, operator: event.target.value as ScreeningOperator })} className="h-8 border border-[var(--color-border-default)] bg-white px-1.5 text-[11px]">
        {metric.operators.map((operator) => <option key={operator} value={operator}>{OPERATOR_LABELS[operator]}</option>)}
      </select>
      {condition.operator !== 'has_data' && condition.operator === 'in' ? (
        <input
          type="text"
          value={value}
          onChange={(event) => onChange({
            ...condition,
            value: event.target.value.split(',').map((item) => item.trim()).filter(Boolean).map((item) => metric.valueType === 'stage' ? Number(item) : item),
          })}
          className="h-8 min-w-0 border border-[var(--color-border-default)] px-2 text-[11px] max-[640px]:col-span-2"
          placeholder="例: 2,3"
        />
      ) : condition.operator !== 'has_data' && (options.length > 0 ? (
        <select value={value} onChange={(event) => onChange({ ...condition, value: metric.valueType === 'stage' ? Number(event.target.value) : metric.valueType === 'boolean' ? event.target.value === 'true' : event.target.value })} className="h-8 min-w-0 border border-[var(--color-border-default)] bg-white px-2 text-[11px] max-[640px]:col-span-2">
          <option value="">選択</option>
          {options.map((option) => <option key={String(option.value)} value={String(option.value)}>{option.label}</option>)}
        </select>
      ) : (
        <div className="flex min-w-0 gap-1 max-[640px]:col-span-2">
          <input type={metric.valueType === 'text' ? 'text' : 'number'} value={value} onChange={(event) => onChange({ ...condition, value: metric.valueType === 'text' ? event.target.value : event.target.value === '' ? '' : Number(event.target.value) })} className="h-8 min-w-0 flex-1 border border-[var(--color-border-default)] px-2 text-[11px]" placeholder="値" />
          {condition.operator === 'between' && <input type="number" value={condition.valueTo ?? ''} onChange={(event) => onChange({ ...condition, valueTo: event.target.value === '' ? undefined : Number(event.target.value) })} className="h-8 min-w-0 flex-1 border border-[var(--color-border-default)] px-2 text-[11px]" placeholder="上限" />}
        </div>
      ))}
      {condition.operator === 'has_data' && <div className="flex h-8 items-center px-2 text-[11px] text-[var(--color-text-muted)] max-[640px]:col-span-2">欠損・N/A・N/Mを除外</div>}
      <button type="button" onClick={onRemove} className="inline-flex h-8 w-8 items-center justify-center border border-[var(--color-border-default)] text-[var(--color-text-muted)]" aria-label={`${metric.label}条件を削除`}><Trash2 size={13} /></button>
    </div>
    <div className={`mt-1 text-[10px] ${warning ? 'font-bold text-amber-700' : 'text-[var(--color-text-muted)]'}`}>
      {coverage == null ? 'カバレッジ計算中' : `利用可能 ${coverage.toFixed(1)}%`}{warning ? '：低カバレッジのため母数に注意' : ''}
    </div>
  </div>
}

export function IntegratedScreener() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const initialised = useRef(false)
  const [state, setState] = useState<ScreenState>(defaultState)
  const [ready, setReady] = useState(false)
  const [response, setResponse] = useState<IntegratedScreeningResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [conditionsOpen, setConditionsOpen] = useState(false)
  const [columnsOpen, setColumnsOpen] = useState(false)
  const [saved, setSaved] = useState<SavedScreenDefinitionContract[]>([])
  const [savedLoading, setSavedLoading] = useState(false)
  const [savedError, setSavedError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [evaluatingId, setEvaluatingId] = useState<string | null>(null)
  const [openSavedId, setOpenSavedId] = useState<string | null>(null)
  const [savedStatus, setSavedStatus] = useState<SavedScreenEvaluationStatus>('NEW')
  const [savedEvaluationId, setSavedEvaluationId] = useState<string | null>(null)
  const [savedOffset, setSavedOffset] = useState(0)
  const [savedDetail, setSavedDetail] = useState<SavedScreenEvaluationDetail | null>(null)
  const [savedDetailLoading, setSavedDetailLoading] = useState(false)
  const [openChangeReasonKey, setOpenChangeReasonKey] = useState<string | null>(null)
  const [changeReasonByKey, setChangeReasonByKey] = useState<Record<string, SavedScreenChangeReasonContract>>({})
  const [changeReasonLoadingKey, setChangeReasonLoadingKey] = useState<string | null>(null)
  const [changeReasonErrorByKey, setChangeReasonErrorByKey] = useState<Record<string, string>>({})
  const [saveName, setSaveName] = useState('')
  const [compared, setCompared] = useState<Set<string>>(new Set())
  const [openReasonKey, setOpenReasonKey] = useState<string | null>(null)
  const [reasonByKey, setReasonByKey] = useState<Record<string, ScreenerReasonContract>>({})
  const [reasonLoadingKey, setReasonLoadingKey] = useState<string | null>(null)
  const [reasonErrorByKey, setReasonErrorByKey] = useState<Record<string, string>>({})
  const [naturalQuery, setNaturalQuery] = useState('')
  const [naturalProposal, setNaturalProposal] = useState<ScreenerNaturalLanguageProposal | null>(null)
  const [naturalLoading, setNaturalLoading] = useState(false)
  const [naturalError, setNaturalError] = useState<string | null>(null)
  const [naturalEditing, setNaturalEditing] = useState(false)

  useEffect(() => {
    if (initialised.current) return
    const fromUrl = parseState(searchParams.get('screen'))
    const fromStorage = parseState(window.localStorage.getItem(STATE_KEY))
    setState(fromUrl ?? fromStorage ?? defaultState)
    setCompared(new Set(getCompareSymbols().filter((item) => item.market === 'JP').map((item) => item.ticker)))
    initialised.current = true
    setReady(true)
    const restore = Number(window.sessionStorage.getItem(SCROLL_KEY) ?? 0)
    if (restore > 0) requestAnimationFrame(() => window.scrollTo(0, restore))
  }, [searchParams])

  useEffect(() => {
    if (!ready) return
    let cancelled = false
    const load = async () => {
      setSavedLoading(true)
      setSavedError(null)
      try {
        let legacy: LegacySavedScreen[] = []
        try { legacy = JSON.parse(window.localStorage.getItem(SAVED_KEY) ?? '[]') as LegacySavedScreen[] } catch { legacy = [] }
        const first = await fetch('/api/integrated-screener/saved', { cache: 'no-store' })
        const firstPayload = await first.json() as { definitions?: SavedScreenDefinitionContract[]; message?: string }
        if (!first.ok) throw new Error(firstPayload.message ?? '保存条件を取得できませんでした。')
        const knownNames = new Set((firstPayload.definitions ?? []).map((item) => item.name))
        for (const item of legacy.filter((entry) => entry?.name && entry?.state && !knownNames.has(entry.name))) {
          await fetch('/api/integrated-screener/saved', {
            method: 'POST', cache: 'no-store', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: item.id, name: item.name, state: item.state, evaluate: false }),
          })
        }
        const result = legacy.some((entry) => entry?.name && !knownNames.has(entry.name))
          ? await fetch('/api/integrated-screener/saved', { cache: 'no-store' })
          : first
        const payload = result === first ? firstPayload : await result.json() as { definitions?: SavedScreenDefinitionContract[]; message?: string }
        if (!result.ok) throw new Error(payload.message ?? '保存条件を取得できませんでした。')
        if (!cancelled) setSaved(payload.definitions ?? [])
      } catch (cause) {
        if (!cancelled) setSavedError(cause instanceof Error ? cause.message : String(cause))
      } finally {
        if (!cancelled) setSavedLoading(false)
      }
    }
    void load()
    return () => { cancelled = true }
  }, [ready])

  useEffect(() => {
    if (!ready) return
    const encoded = encodeState(state)
    window.localStorage.setItem(STATE_KEY, encoded)
    const params = new URLSearchParams(window.location.search)
    params.set('screen', encoded)
    router.replace(`/screener?${params.toString()}`, { scroll: false })
    const controller = new AbortController()
    const timer = window.setTimeout(() => {
      setLoading(true)
      setError(null)
      fetch('/api/integrated-screener', {
        method: 'POST', cache: 'no-store', signal: controller.signal,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ asOf: state.asOf || null, conditions: state.conditions, sort: state.sort, direction: state.direction, limit: 100, offset: state.page * 100 }),
      }).then(async (result) => {
        const payload = await result.json() as IntegratedScreeningResponse & { message?: string }
        if (!result.ok) throw new Error(payload.message ?? '統合スクリーナーの取得に失敗しました。')
        setResponse(payload)
      }).catch((cause) => {
        if ((cause as Error).name !== 'AbortError') setError(cause instanceof Error ? cause.message : String(cause))
      }).finally(() => setLoading(false))
    }, 180)
    return () => { window.clearTimeout(timer); controller.abort() }
  }, [ready, router, state])

  const addCondition = (metric: ScreeningMetricKey = 'roe') => {
    const definition = SCREENING_METRIC_MAP.get(metric)!
    setState((current) => ({ ...current, page: 0, conditions: [...current.conditions, { id: newId(), metric, operator: definition.operators[0], value: definition.valueType === 'boolean' ? true : '' }] }))
    setConditionsOpen(true)
  }

  const applyPreset = (presetId: string) => {
    const preset = SCREENING_PRESETS.find((item) => item.id === presetId)
    if (!preset) return
    setState((current) => ({ ...current, page: 0, conditions: preset.conditions.map((condition) => ({ ...condition, id: newId() })) }))
    setConditionsOpen(true)
  }

  const generateNaturalProposal = async () => {
    const query = naturalQuery.trim()
    if (!query || naturalLoading) return
    setNaturalLoading(true)
    setNaturalError(null)
    try {
      const result = await fetch('/api/integrated-screener/interpret', {
        method: 'POST', cache: 'no-store', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query }),
      })
      const payload = await result.json() as ScreenerNaturalLanguageProposal & { message?: string }
      if (!result.ok) throw new Error(payload.message ?? '条件候補を作成できませんでした。')
      setNaturalProposal(payload)
      setNaturalEditing(false)
    } catch (cause) {
      setNaturalError(cause instanceof Error ? cause.message : String(cause))
      setNaturalProposal(null)
    } finally {
      setNaturalLoading(false)
    }
  }

  const applyNaturalProposal = () => {
    if (!naturalProposal || naturalProposal.conditions.length === 0) return
    if (!naturalProposal.conditions.every(isCompleteScreeningCondition)) {
      setNaturalError('未入力または不正な条件があります。条件を編集してください。')
      setNaturalEditing(true)
      return
    }
    setState((current) => ({
      ...current,
      page: 0,
      conditions: naturalProposal.conditions.map((condition) => ({ ...condition, id: newId() })),
    }))
    setConditionsOpen(false)
    setNaturalProposal(null)
    setNaturalEditing(false)
    setNaturalError(null)
  }

  const saveCurrent = async () => {
    const name = saveName.trim()
    if (!name || saving) return
    setSaving(true)
    setSavedError(null)
    try {
      const existing = saved.find((item) => item.name === name)
      const result = await fetch('/api/integrated-screener/saved', {
        method: 'POST', cache: 'no-store', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: existing?.id ?? newId(), name, state, evaluate: true }),
      })
      const payload = await result.json() as { definition?: SavedScreenDefinitionContract; message?: string }
      if (!result.ok || !payload.definition) throw new Error(payload.message ?? '保存条件を保存できませんでした。')
      const next = [payload.definition, ...saved.filter((item) => item.id !== payload.definition!.id && item.name !== name)]
      setSaved(next)
      window.localStorage.setItem(SAVED_KEY, JSON.stringify(next.map((item) => ({ id: item.id, name: item.name, state: item.state }))))
      setSaveName('')
      setOpenSavedId(payload.definition.id)
      const preferred = (payload.definition.latestEvaluation?.newCount ?? 0) > 0 ? 'NEW' : 'STAY'
      setSavedStatus(preferred)
      setSavedEvaluationId(payload.definition.latestEvaluation?.evaluationId ?? null)
      if (payload.definition.latestEvaluation) await fetchSavedDetail(payload.definition.id, preferred, payload.definition.latestEvaluation.evaluationId, 0)
    } catch (cause) {
      setSavedError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setSaving(false)
    }
  }

  const fetchSavedDetail = async (definitionId: string, status: SavedScreenEvaluationStatus, evaluationId?: string | null, offset = 0) => {
    setSavedDetailLoading(true)
    setSavedError(null)
    setOpenChangeReasonKey(null)
    try {
      const params = new URLSearchParams({ status, limit: '50', offset: String(offset) })
      if (evaluationId) params.set('evaluation_id', evaluationId)
      const result = await fetch(`/api/integrated-screener/saved/${encodeURIComponent(definitionId)}?${params}`, { cache: 'no-store' })
      const payload = await result.json() as SavedScreenEvaluationDetail & { message?: string }
      if (!result.ok) throw new Error(payload.message ?? '評価履歴を取得できませんでした。')
      setSavedDetail(payload)
      setSavedEvaluationId(payload.evaluation.evaluationId)
      setSavedOffset(payload.offset)
    } catch (cause) {
      setSavedDetail(null)
      setSavedError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setSavedDetailLoading(false)
    }
  }

  const openSavedDefinition = (definition: SavedScreenDefinitionContract) => {
    if (openSavedId === definition.id) {
      setOpenSavedId(null)
      setSavedDetail(null)
      return
    }
    setOpenSavedId(definition.id)
    if (!definition.latestEvaluation) {
      setSavedDetail(null)
      return
    }
    const status: SavedScreenEvaluationStatus = definition.latestEvaluation.newCount > 0 ? 'NEW' : 'STAY'
    setSavedStatus(status)
    setSavedEvaluationId(definition.latestEvaluation.evaluationId)
    void fetchSavedDetail(definition.id, status, definition.latestEvaluation.evaluationId, 0)
  }

  const evaluateSaved = async (definitionId: string) => {
    if (evaluatingId) return
    setEvaluatingId(definitionId)
    setSavedError(null)
    try {
      const result = await fetch(`/api/integrated-screener/saved/${encodeURIComponent(definitionId)}`, {
        method: 'POST', cache: 'no-store', headers: { 'Content-Type': 'application/json' }, body: '{}',
      })
      const payload = await result.json() as { message?: string }
      if (!result.ok) throw new Error(payload.message ?? '保存条件を再評価できませんでした。')
      const listResult = await fetch('/api/integrated-screener/saved', { cache: 'no-store' })
      const listPayload = await listResult.json() as { definitions?: SavedScreenDefinitionContract[]; message?: string }
      if (!listResult.ok) throw new Error(listPayload.message ?? '保存条件を再取得できませんでした。')
      const definitions = listPayload.definitions ?? []
      setSaved(definitions)
      const target = definitions.find((item) => item.id === definitionId)
      if (target?.latestEvaluation) {
        const status: SavedScreenEvaluationStatus = target.latestEvaluation.newCount > 0 ? 'NEW' : 'STAY'
        setOpenSavedId(definitionId)
        setSavedStatus(status)
        await fetchSavedDetail(definitionId, status, target.latestEvaluation.evaluationId, 0)
      }
    } catch (cause) {
      setSavedError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setEvaluatingId(null)
    }
  }

  const selectSavedStatus = (status: SavedScreenEvaluationStatus) => {
    if (!openSavedId || !savedEvaluationId) return
    setSavedStatus(status)
    void fetchSavedDetail(openSavedId, status, savedEvaluationId, 0)
  }

  const toggleChangeReason = async (ticker: string) => {
    if (!openSavedId || !savedEvaluationId) return
    const key = `${savedEvaluationId}:${ticker}`
    if (openChangeReasonKey === key) {
      setOpenChangeReasonKey(null)
      return
    }
    setOpenChangeReasonKey(key)
    if (changeReasonByKey[key]) return
    setChangeReasonLoadingKey(key)
    setChangeReasonErrorByKey((current) => ({ ...current, [key]: '' }))
    try {
      const params = new URLSearchParams({ evaluation_id: savedEvaluationId, ticker })
      const result = await fetch(`/api/integrated-screener/saved/${encodeURIComponent(openSavedId)}/reason?${params}`, { cache: 'no-store' })
      const payload = await result.json() as SavedScreenChangeReasonContract & { message?: string }
      if (!result.ok) throw new Error(payload.message ?? '変化理由を取得できませんでした。')
      setChangeReasonByKey((current) => ({ ...current, [key]: payload }))
    } catch (cause) {
      setChangeReasonErrorByKey((current) => ({ ...current, [key]: cause instanceof Error ? cause.message : String(cause) }))
    } finally {
      setChangeReasonLoadingKey((current) => current === key ? null : current)
    }
  }

  const toggleCompare = (row: IntegratedScreeningRow) => {
    if (!compared.has(row.ticker) && compared.size >= MAX_COMPARE) return
    toggleComparedSymbol({ market: 'JP', ticker: row.ticker, name: row.name })
    setCompared((current) => {
      const next = new Set(current)
      if (next.has(row.ticker)) next.delete(row.ticker)
      else next.add(row.ticker)
      return next
    })
  }

  const reasonKeyFor = (ticker: string) => JSON.stringify({ ticker, asOf: response?.asOf ?? state.asOf, conditions: state.conditions })

  const toggleReason = async (row: IntegratedScreeningRow) => {
    const key = reasonKeyFor(row.ticker)
    if (openReasonKey === key) {
      setOpenReasonKey(null)
      return
    }
    setOpenReasonKey(key)
    if (reasonByKey[key]) return
    setReasonLoadingKey(key)
    setReasonErrorByKey((current) => ({ ...current, [key]: '' }))
    try {
      const result = await fetch('/api/integrated-screener/reason', {
        method: 'POST', cache: 'no-store', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ticker: row.ticker, asOf: (response?.asOf ?? state.asOf) || null, conditions: state.conditions }),
      })
      const payload = await result.json() as ScreenerReasonContract & { message?: string }
      if (!result.ok) throw new Error(payload.message ?? '理由の取得に失敗しました。')
      setReasonByKey((current) => ({ ...current, [key]: payload }))
    } catch (cause) {
      setReasonErrorByKey((current) => ({ ...current, [key]: cause instanceof Error ? cause.message : String(cause) }))
    } finally {
      setReasonLoadingKey((current) => current === key ? null : current)
    }
  }

  const visibleColumns = state.columns.filter((column) => SCREENING_METRIC_MAP.has(column))
  const selectedCompareTicker = [...compared][0] ?? response?.rows[0]?.ticker ?? null
  const pageCount = response ? Math.max(1, Math.ceil(response.total / response.limit)) : 1

  return <div className="sb-page">
    <div className="sb-page-title">
      <h1>統合スクリーナー</h1>
      <p>Fundamental × Valuation × 株主還元 × 市場構造 × テクニカルを同じ基準日で横断検索</p>
    </div>
    <div className="flex flex-col gap-3 px-4 pb-5 pt-3 max-[640px]:px-2.5">
      <section className="border border-[var(--color-border-default)] bg-white">
        <div className="border-b border-[var(--color-border-default)] bg-[var(--color-surface-muted)] px-3 py-2">
          <h2 className="text-[13px] font-black text-[var(--color-brand-900)]">何を探しますか</h2>
          <p className="mt-0.5 text-[10px] text-[var(--color-text-muted)]">自然文またはプリセットから条件候補を作り、確認してから検索します。</p>
        </div>
        <form onSubmit={(event) => { event.preventDefault(); void generateNaturalProposal() }} className="border-b border-[var(--color-border-default)] px-3 py-2.5">
          <label htmlFor="natural-screener-query" className="mb-1.5 flex items-center gap-1 text-[11px] font-black text-[var(--color-brand-900)]"><Sparkles size={13} />どんな銘柄を探しますか？</label>
          <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-1.5">
            <input id="natural-screener-query" value={naturalQuery} onChange={(event) => setNaturalQuery(event.target.value)} maxLength={500}
              placeholder="例：ROEが高くて、割安で、週足構造が上向きの大型株"
              className="h-9 min-w-0 border border-[var(--color-border-default)] bg-white px-2.5 text-[11px] outline-none focus:border-[var(--color-brand-600)]" />
            <button type="submit" disabled={!naturalQuery.trim() || naturalLoading} className="inline-flex h-9 items-center gap-1 border border-[var(--color-brand-700)] bg-[var(--color-brand-700)] px-3 text-[11px] font-black text-white disabled:opacity-40">
              {naturalLoading ? <LoaderCircle size={13} className="animate-spin" /> : <Sparkles size={13} />}<span className="max-[480px]:hidden">条件候補を作る</span><span className="hidden max-[480px]:inline">候補化</span>
            </button>
          </div>
          {naturalError && <p className="mt-1.5 text-[10px] font-bold text-rose-700">{naturalError}</p>}
        </form>
        {naturalProposal && <div className="relative border-b border-[var(--color-border-default)] bg-sky-50/40 px-3 py-2.5" data-natural-language-proposal>
          <div className="flex items-start gap-2 pr-9">
            <div>
              <div className="flex items-center gap-1.5">
                <h3 className="text-[12px] font-black text-[var(--color-brand-900)]">{naturalProposal.conditions.length > 0 ? 'この条件で検索します' : '条件候補を作成できませんでした'}</h3>
                <span className="border border-[var(--color-border-default)] bg-white px-1.5 py-0.5 text-[9px] text-[var(--color-text-muted)]">{naturalProposal.source === 'openai' ? 'AI候補' : 'ローカル候補'}</span>
              </div>
              <p className="mt-0.5 text-[9px] text-[var(--color-text-muted)]">まだ検索は実行されていません。条件を確認・修正してください。</p>
            </div>
            <button type="button" onClick={() => { setNaturalProposal(null); setNaturalEditing(false) }} className="absolute right-3 top-2.5 inline-flex h-7 w-7 items-center justify-center border border-[var(--color-border-default)] bg-white" aria-label="条件候補を破棄"><X size={12} /></button>
          </div>
          {naturalProposal.conditions.length > 0 && <div className="mt-2 flex flex-wrap gap-1.5">
            {naturalProposal.conditions.map((condition) => <span key={condition.id} className="inline-flex min-h-7 items-center gap-1 border border-[var(--color-brand-300)] bg-white px-2 text-[10px] font-bold text-[var(--color-brand-900)]">
              {conditionSummary(condition)}
              <button type="button" onClick={() => setNaturalProposal((current) => current ? { ...current, conditions: current.conditions.filter((item) => item.id !== condition.id) } : current)} className="inline-flex h-5 w-5 items-center justify-center text-[var(--color-text-muted)]" aria-label={`${SCREENING_METRIC_MAP.get(condition.metric)?.label}候補を削除`}><X size={10} /></button>
            </span>)}
          </div>}
          {naturalProposal.assumptions.length > 0 && <div className="mt-2 border-l-2 border-sky-400 pl-2">
            <div className="text-[9px] font-black text-sky-900">曖昧語の推奨解釈</div>
            {naturalProposal.assumptions.map((assumption) => <p key={`${assumption.term}:${assumption.interpretation}`} className="mt-0.5 text-[10px] leading-4 text-[var(--color-text-secondary)]"><strong>{assumption.term}</strong> → {assumption.interpretation}</p>)}
          </div>}
          {naturalProposal.unsupportedConcepts.length > 0 && <div className="mt-2 border-l-2 border-amber-500 pl-2">
            <div className="text-[9px] font-black text-amber-900">条件化できない内容</div>
            {naturalProposal.unsupportedConcepts.map((item) => <p key={`${item.text}:${item.reason}`} className="mt-0.5 text-[10px] leading-4 text-amber-900"><strong>{item.text}</strong>：{item.reason}</p>)}
          </div>}
          {naturalProposal.clarificationQuestions.length > 0 && <div className="mt-2 border-l-2 border-[var(--color-border-strong)] pl-2">
            {naturalProposal.clarificationQuestions.map((question) => <p key={question} className="text-[10px] leading-5 text-[var(--color-text-secondary)]">確認：{question}</p>)}
          </div>}
          {naturalProposal.validationErrors.length > 0 && <p className="mt-2 text-[9px] font-bold text-amber-800">schema validationで不正な候補 {naturalProposal.validationErrors.length}件を除外しました。</p>}
          {naturalEditing && naturalProposal.conditions.length > 0 && <div className="mt-2 grid gap-2 border-t border-[var(--color-border-default)] pt-2 lg:grid-cols-2">
            {naturalProposal.conditions.map((condition) => <ConditionEditor key={condition.id} condition={condition} response={response}
              onChange={(next) => setNaturalProposal((current) => current ? { ...current, conditions: current.conditions.map((item) => item.id === next.id ? next : item) } : current)}
              onRemove={() => setNaturalProposal((current) => current ? { ...current, conditions: current.conditions.filter((item) => item.id !== condition.id) } : current)} />)}
          </div>}
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            <button type="button" onClick={applyNaturalProposal} disabled={naturalProposal.conditions.length === 0 || !naturalProposal.conditions.every(isCompleteScreeningCondition)} className="inline-flex h-8 items-center gap-1 border border-[var(--color-brand-700)] bg-[var(--color-brand-700)] px-2.5 text-[11px] font-black text-white disabled:opacity-35"><Search size={12} />この条件で検索</button>
            {naturalProposal.conditions.length > 0 && <button type="button" onClick={() => setNaturalEditing((current) => !current)} className="inline-flex h-8 items-center gap-1 border border-[var(--color-border-default)] bg-white px-2.5 text-[11px] font-bold"><SlidersHorizontal size={12} />{naturalEditing ? '編集を閉じる' : '条件を編集'}</button>}
            <span className="ml-auto text-[9px] text-[var(--color-text-muted)]">候補生成 {naturalProposal.elapsedMs}ms</span>
          </div>
        </div>}
        <div className="grid grid-cols-5 gap-px bg-[var(--color-border-default)] max-[900px]:grid-cols-3 max-[520px]:grid-cols-2">
          {SCREENING_PRESETS.map((preset) => <button key={preset.id} type="button" onClick={() => applyPreset(preset.id)} className="min-h-[54px] bg-white px-2.5 py-2 text-left hover:bg-sky-50">
            <span className="block text-[11px] font-black text-[var(--color-brand-800)]">{preset.label}</span>
            <span className="mt-0.5 block text-[9px] leading-4 text-[var(--color-text-muted)]">{preset.description}</span>
          </button>)}
        </div>
      </section>

      <section className="border border-[var(--color-border-default)] bg-white">
        <div className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
          <div className="flex min-w-0 items-center gap-2">
            <SlidersHorizontal size={15} className="shrink-0 text-[var(--color-brand-700)]" />
            <div>
              <div className="text-[12px] font-black text-[var(--color-brand-900)]">条件 {state.conditions.length}件</div>
              <div className="line-clamp-1 text-[10px] text-[var(--color-text-muted)]">{state.conditions.length > 0 ? state.conditions.map(conditionSummary).join(' / ') : '全銘柄から検索'}</div>
            </div>
          </div>
          <div className="flex items-center gap-1.5">
            <label className="flex h-8 items-center gap-1 border border-[var(--color-border-default)] px-2 text-[10px] font-bold">
              基準日<input type="date" value={state.asOf} onChange={(event) => setState((current) => ({ ...current, asOf: event.target.value, page: 0 }))} className="min-w-0 bg-transparent text-[11px]" />
            </label>
            <button type="button" onClick={() => setState(defaultState)} className="inline-flex h-8 w-8 items-center justify-center border border-[var(--color-border-default)]" title="条件をリセット"><RotateCcw size={13} /></button>
            <button type="button" onClick={() => setConditionsOpen((current) => !current)} className={`inline-flex h-8 items-center gap-1 border px-2.5 text-[11px] font-black ${conditionsOpen ? 'border-[var(--color-brand-700)] bg-[var(--color-brand-700)] text-white' : 'border-[var(--color-border-default)]'}`}><Filter size={13} />条件を編集<ChevronDown size={12} /></button>
          </div>
        </div>
        {conditionsOpen && <div className="border-t border-[var(--color-border-default)] bg-[var(--color-surface-muted)] p-2.5">
          <div className="grid gap-2 lg:grid-cols-2">
            {state.conditions.map((condition) => <ConditionEditor key={condition.id} condition={condition} response={response}
              onChange={(next) => setState((current) => ({ ...current, page: 0, conditions: current.conditions.map((item) => item.id === next.id ? next : item) }))}
              onRemove={() => setState((current) => ({ ...current, page: 0, conditions: current.conditions.filter((item) => item.id !== condition.id) }))} />)}
          </div>
          <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
            <button type="button" onClick={() => addCondition()} className="inline-flex h-8 items-center gap-1 border border-[var(--color-brand-500)] bg-white px-2.5 text-[11px] font-black text-[var(--color-brand-800)]"><Plus size={13} />条件を追加</button>
            <div className="flex items-center gap-1">
              <select onChange={(event) => {
                const screen = saved.find((item) => item.id === event.target.value)
                if (screen) setState({ ...screen.state, asOf: screen.state.asOf ?? '', page: 0 })
                event.currentTarget.value = ''
              }} defaultValue="" className="h-8 max-w-[180px] border border-[var(--color-border-default)] bg-white px-2 text-[11px]">
                <option value="">保存条件を開く</option>{saved.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
              </select>
              <input value={saveName} onChange={(event) => setSaveName(event.target.value)} placeholder="条件名" className="h-8 w-32 border border-[var(--color-border-default)] bg-white px-2 text-[11px]" />
              <button type="button" onClick={() => void saveCurrent()} disabled={!saveName.trim() || saving} className="inline-flex h-8 items-center gap-1 border border-[var(--color-border-default)] bg-white px-2 text-[11px] font-bold disabled:opacity-40">{saving ? <LoaderCircle size={12} className="animate-spin" /> : <Save size={12} />}保存</button>
            </div>
          </div>
        </div>}
      </section>

      <section className="border border-[var(--color-border-default)] bg-white" data-saved-screen-evaluations>
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--color-border-default)] px-3 py-2">
          <div className="flex items-center gap-2">
            <History size={14} className="text-[var(--color-brand-700)]" />
            <div>
              <h2 className="text-[12px] font-black text-[var(--color-brand-900)]">保存条件の変化</h2>
              <p className="text-[9px] text-[var(--color-text-muted)]">日次更新後のPIT再評価 / 初回は基準作成としてSTAY</p>
            </div>
          </div>
          {savedLoading && <span className="inline-flex items-center gap-1 text-[10px] text-[var(--color-text-muted)]"><LoaderCircle size={12} className="animate-spin" />更新中</span>}
        </div>
        {savedError && <div className="border-b border-rose-200 bg-rose-50 px-3 py-2 text-[10px] text-rose-800">{savedError}</div>}
        <div className="grid gap-px bg-[var(--color-border-subtle)] lg:grid-cols-2">
          {saved.length === 0 && !savedLoading && !savedError && <div className="col-span-full bg-white px-3 py-4 text-center text-[10px] text-[var(--color-text-muted)]">条件を名前付き保存すると、日次更新後のNEW / STAY / OUTをここで追跡します。</div>}
          {saved.map((definition) => {
            const summary = definition.latestEvaluation
            const open = openSavedId === definition.id
            const fillLastRow = saved.length % 2 === 1 && saved[saved.length - 1]?.id === definition.id
            return <button key={definition.id} type="button" onClick={() => openSavedDefinition(definition)} className={`flex min-h-[58px] items-center gap-3 bg-white px-3 py-2 text-left hover:bg-sky-50/60 ${fillLastRow ? 'lg:col-span-2' : ''} ${open ? 'outline-2 -outline-offset-2 outline-[var(--color-brand-600)]' : ''}`} aria-expanded={open}>
              <span className="inline-flex h-7 w-7 shrink-0 items-center justify-center border border-[var(--color-border-default)] bg-[var(--color-surface-muted)]"><Activity size={13} className="text-[var(--color-brand-700)]" /></span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[11px] font-black text-[var(--color-brand-900)]">{definition.name}</span>
                <span className="mt-0.5 block truncate text-[9px] text-[var(--color-text-muted)]">{summary ? `基準 ${summary.asOf}${summary.previousAsOf ? ` / 前回 ${summary.previousAsOf}` : ' / 初回基準'}` : '未評価'}</span>
              </span>
              {summary ? <span className="grid shrink-0 grid-cols-3 gap-2 text-center max-[480px]:gap-1">
                <span><strong className="block font-mono text-[13px] text-[var(--color-brand-900)]">{summary.matchedCount}</strong><small className="text-[8px] text-[var(--color-text-muted)]">今回</small></span>
                <span><strong className="block font-mono text-[13px] text-emerald-700">{summary.newCount}</strong><small className="text-[8px] text-[var(--color-text-muted)]">NEW</small></span>
                <span><strong className="block font-mono text-[13px] text-rose-700">{summary.outCount}</strong><small className="text-[8px] text-[var(--color-text-muted)]">OUT</small></span>
              </span> : <span className="shrink-0 text-[9px] font-bold text-amber-700">要評価</span>}
            </button>
          })}
        </div>
        {openSavedId && (() => {
          const definition = saved.find((item) => item.id === openSavedId)
          if (!definition) return null
          const selectedEvaluation = definition.history.find((item) => item.evaluationId === savedEvaluationId) ?? definition.latestEvaluation
          const counts: Record<SavedScreenEvaluationStatus, number> = {
            NEW: selectedEvaluation?.newCount ?? 0,
            STAY: selectedEvaluation?.stayCount ?? 0,
            OUT: selectedEvaluation?.outCount ?? 0,
          }
          return <div className="border-t-2 border-[var(--color-brand-600)] bg-[var(--color-surface-muted)]" data-saved-screen-detail>
            <div className="flex flex-wrap items-center gap-2 border-b border-[var(--color-border-default)] px-3 py-2">
              <strong className="mr-auto text-[11px] text-[var(--color-brand-900)]">{definition.name}</strong>
              {definition.history.length > 0 && <label className="inline-flex h-7 items-center gap-1 border border-[var(--color-border-default)] bg-white px-1.5 text-[9px] font-bold">
                評価日<select value={selectedEvaluation?.evaluationId ?? ''} onChange={(event) => {
                  const evaluation = definition.history.find((item) => item.evaluationId === event.target.value)
                  if (!evaluation) return
                  const status: SavedScreenEvaluationStatus = evaluation.newCount > 0 ? 'NEW' : 'STAY'
                  setSavedEvaluationId(evaluation.evaluationId)
                  setSavedStatus(status)
                  void fetchSavedDetail(definition.id, status, evaluation.evaluationId, 0)
                }} className="bg-transparent text-[10px]">
                  {definition.history.map((item) => <option key={item.evaluationId} value={item.evaluationId}>{item.asOf}</option>)}
                </select>
              </label>}
              <button type="button" onClick={() => void evaluateSaved(definition.id)} disabled={evaluatingId != null} className="inline-flex h-7 items-center gap-1 border border-[var(--color-border-default)] bg-white px-2 text-[10px] font-bold disabled:opacity-40">{evaluatingId === definition.id ? <LoaderCircle size={11} className="animate-spin" /> : <RefreshCw size={11} />}再評価</button>
            </div>
            {selectedEvaluation ? <>
              <div className="grid grid-cols-3 border-b border-[var(--color-border-default)] bg-white">
                {(['NEW', 'STAY', 'OUT'] as SavedScreenEvaluationStatus[]).map((status) => <button key={status} type="button" onClick={() => selectSavedStatus(status)} className={`h-9 border-r border-[var(--color-border-default)] text-[10px] font-black last:border-r-0 ${savedStatus === status ? 'bg-[var(--color-brand-700)] text-white' : status === 'NEW' ? 'text-emerald-700' : status === 'OUT' ? 'text-rose-700' : 'text-[var(--color-text-secondary)]'}`}>{status} <span className="font-mono">{counts[status]}</span></button>)}
              </div>
              {savedDetailLoading && <div className="flex h-20 items-center justify-center gap-2 text-[10px] text-[var(--color-text-muted)]"><LoaderCircle size={13} className="animate-spin" />評価銘柄を取得中…</div>}
              {!savedDetailLoading && savedDetail && <div className="bg-white">
                {savedDetail.members.map((member) => {
                  const key = `${savedDetail.evaluation.evaluationId}:${member.ticker}`
                  const reasonOpen = openChangeReasonKey === key
                  return <Fragment key={member.ticker}>
                    <div className={`flex min-h-10 items-center gap-2 border-b border-[var(--color-border-subtle)] px-3 py-1.5 ${reasonOpen ? 'bg-sky-50/70' : ''}`}>
                      <span className={`w-10 shrink-0 text-[9px] font-black ${member.status === 'NEW' ? 'text-emerald-700' : member.status === 'OUT' ? 'text-rose-700' : 'text-[var(--color-text-muted)]'}`}>{member.status}</span>
                      <Link href={`/stock/${member.ticker}#overview`} className="min-w-0 flex-1 truncate text-[11px] font-black text-[var(--color-brand-800)] hover:underline">{member.ticker} {member.name}</Link>
                      {member.status !== 'STAY' && <button type="button" onClick={() => void toggleChangeReason(member.ticker)} className={`inline-flex h-6 shrink-0 items-center gap-1 border px-1.5 text-[9px] font-bold ${reasonOpen ? 'border-[var(--color-brand-700)] bg-[var(--color-brand-700)] text-white' : 'border-[var(--color-border-default)] bg-white text-[var(--color-brand-800)]'}`}><CircleHelp size={10} />理由を見る</button>}
                    </div>
                    {reasonOpen && <div className="border-b border-[var(--color-brand-200)] max-[640px]:hidden"><ChangeReasonPanel reason={changeReasonByKey[key] ?? null} loading={changeReasonLoadingKey === key} error={changeReasonErrorByKey[key] || null} /></div>}
                  </Fragment>
                })}
                {savedDetail.members.length === 0 && <div className="flex h-20 items-center justify-center text-[10px] text-[var(--color-text-muted)]">{savedStatus}に該当する銘柄はありません。</div>}
                {savedDetail.total > savedDetail.limit && <div className="flex items-center justify-between border-t border-[var(--color-border-default)] px-3 py-2 text-[9px] text-[var(--color-text-muted)]">
                  <span>{savedDetail.offset + 1}〜{Math.min(savedDetail.offset + savedDetail.members.length, savedDetail.total)}件 / 全{savedDetail.total.toLocaleString('ja-JP')}件</span>
                  <span className="flex gap-1">
                    <button type="button" disabled={savedOffset <= 0 || savedDetailLoading} onClick={() => void fetchSavedDetail(definition.id, savedStatus, savedDetail.evaluation.evaluationId, Math.max(0, savedOffset - savedDetail.limit))} className="h-6 border border-[var(--color-border-default)] bg-white px-2 font-bold disabled:opacity-35">前へ</button>
                    <button type="button" disabled={savedOffset + savedDetail.limit >= savedDetail.total || savedDetailLoading} onClick={() => void fetchSavedDetail(definition.id, savedStatus, savedDetail.evaluation.evaluationId, savedOffset + savedDetail.limit)} className="h-6 border border-[var(--color-border-default)] bg-white px-2 font-bold disabled:opacity-35">次へ</button>
                  </span>
                </div>}
              </div>}
            </> : <div className="flex h-20 items-center justify-center gap-3 text-[10px] text-[var(--color-text-muted)]"><span>まだ評価履歴がありません。</span><button type="button" onClick={() => void evaluateSaved(definition.id)} className="font-bold text-[var(--color-brand-700)] hover:underline">今すぐ基準を作成</button></div>}
          </div>
        })()}
      </section>

      <section className="border border-[var(--color-border-default)] bg-white">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--color-border-default)] px-3 py-2">
          <div className="flex items-baseline gap-2">
            <h2 className="text-[13px] font-black text-[var(--color-brand-900)]">検索結果</h2>
            <span className="font-mono text-[18px] font-black text-[var(--color-brand-800)]">{loading ? '—' : (response?.total ?? 0).toLocaleString('ja-JP')}</span>
            <span className="text-[10px] text-[var(--color-text-muted)]">銘柄 / 母数 {response?.universe.toLocaleString('ja-JP') ?? '—'}</span>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="hidden text-[10px] text-[var(--color-text-muted)] sm:inline">基準 {response?.asOf ?? '—'} / 構造 {response?.snapshotDate ?? '—'}</span>
            {selectedCompareTicker && compared.size > 0 && <Link href={`/stock/${selectedCompareTicker}#ml`} className="inline-flex h-8 items-center gap-1 border border-[var(--color-brand-600)] px-2 text-[11px] font-black text-[var(--color-brand-800)]"><GitCompareArrows size={13} />比較 {compared.size}</Link>}
            <button type="button" onClick={() => setColumnsOpen((current) => !current)} className="inline-flex h-8 items-center gap-1 border border-[var(--color-border-default)] px-2 text-[11px] font-bold"><Columns3 size={13} />列</button>
          </div>
        </div>
        {columnsOpen && <div className="flex flex-wrap gap-1.5 border-b border-[var(--color-border-default)] bg-[var(--color-surface-muted)] p-2">
          {SCREENING_METRICS.filter((metric) => ['company', 'growth', 'quality', 'valuation', 'shareholder', 'structure'].includes(metric.category)).map((metric) => {
            const selected = state.columns.includes(metric.key)
            return <label key={metric.key} className={`inline-flex h-7 items-center gap-1 border px-2 text-[10px] ${selected ? 'border-[var(--color-brand-500)] bg-white font-bold text-[var(--color-brand-800)]' : 'border-[var(--color-border-default)] text-[var(--color-text-muted)]'}`}>
              <input type="checkbox" checked={selected} onChange={() => setState((current) => ({ ...current, columns: selected ? current.columns.filter((key) => key !== metric.key) : [...current.columns, metric.key] }))} />{metric.label}
            </label>
          })}
        </div>}
        {error && <div className="m-3 border border-rose-200 bg-rose-50 p-3 text-[11px] text-rose-800">{error}</div>}
        <div className="overflow-x-auto" data-integrated-screener-table>
          <table className="w-full min-w-[980px] border-collapse text-[11px]">
            <thead className="sticky top-0 z-10 bg-[var(--color-surface-muted)] text-[10px] text-[var(--color-text-secondary)]">
              <tr>
                <th className="sticky left-0 z-20 w-9 border-b border-r border-[var(--color-border-default)] bg-[var(--color-surface-muted)] p-2">比較</th>
                <th className="sticky left-9 z-20 min-w-[180px] border-b border-r border-[var(--color-border-default)] bg-[var(--color-surface-muted)] p-2 text-left">銘柄</th>
                <th className="border-b border-[var(--color-border-default)] p-2 text-right">株価</th>
                {visibleColumns.map((key) => <th key={key} className="whitespace-nowrap border-b border-[var(--color-border-default)] p-2 text-right">
                  <button type="button" onClick={() => setState((current) => ({ ...current, page: 0, sort: key, direction: current.sort === key && current.direction === 'desc' ? 'asc' : 'desc' }))} className="font-bold hover:text-[var(--color-brand-700)]">
                    {SCREENING_METRIC_MAP.get(key)?.label}{state.sort === key ? (state.direction === 'desc' ? ' ↓' : ' ↑') : ''}
                  </button>
                </th>)}
              </tr>
            </thead>
            <tbody>
              {loading && !response && <tr><td colSpan={visibleColumns.length + 3} className="h-28 text-center text-[var(--color-text-muted)]">Servingデータを準備しています…</td></tr>}
              {response?.rows.map((row) => {
                const reasonKey = reasonKeyFor(row.ticker)
                const reasonOpen = openReasonKey === reasonKey
                return <Fragment key={row.ticker}>
                  <tr className={`border-b border-[var(--color-border-subtle)] hover:bg-sky-50/60 ${reasonOpen ? 'bg-sky-50/70' : ''}`}>
                    <td className="sticky left-0 z-[2] border-r border-[var(--color-border-default)] bg-white p-2 text-center"><input type="checkbox" checked={compared.has(row.ticker)} onChange={() => toggleCompare(row)} disabled={!compared.has(row.ticker) && compared.size >= MAX_COMPARE} aria-label={`${row.ticker}を比較`} /></td>
                    <td className="sticky left-9 z-[2] border-r border-[var(--color-border-default)] bg-white p-2">
                      <div className="flex min-w-0 items-center gap-1">
                        <Link href={`/stock/${row.ticker}#overview`} onClick={() => window.sessionStorage.setItem(SCROLL_KEY, String(window.scrollY))} className="min-w-0 truncate font-black text-[var(--color-brand-800)] hover:underline">{row.ticker} {row.name}</Link>
                        <StockPreviewTrigger ticker={row.ticker} analysisDate={response.asOf} context="screener" />
                      </div>
                      <div className="mt-0.5 flex items-center gap-1 text-[9px] text-[var(--color-text-muted)]">
                        {row.marketSegment && <span>{row.marketSegment}</span>}
                        {row.sector33 && <Link href={`/sectors?view=structure&structureTaxonomy=33&structureGroup=${encodeURIComponent(row.sector33)}`} className="hover:underline">{row.sector33}</Link>}
                        <button type="button" onClick={() => void toggleReason(row)} className={`ml-auto inline-flex h-6 items-center gap-1 border px-1.5 text-[9px] font-bold ${reasonOpen ? 'border-[var(--color-brand-700)] bg-[var(--color-brand-700)] text-white' : 'border-[var(--color-border-default)] bg-white text-[var(--color-brand-800)]'}`} aria-expanded={reasonOpen}><CircleHelp size={10} />理由を見る</button>
                      </div>
                    </td>
                    <td className="whitespace-nowrap p-2 text-right font-mono font-bold">{row.price == null ? '—' : `¥${fmtNumber(row.price, 0)}`}</td>
                    {visibleColumns.map((key) => <td key={key} className="whitespace-nowrap p-2 text-right font-mono">{key === 'stageCode' ? <StageCode value={row.stageCode} /> : formatValue(row, key)}</td>)}
                  </tr>
                  {reasonOpen && <tr className="max-[640px]:hidden"><td colSpan={visibleColumns.length + 3} className="border-b border-[var(--color-brand-200)] p-0"><ReasonPanel reason={reasonByKey[reasonKey] ?? null} loading={reasonLoadingKey === reasonKey} error={reasonErrorByKey[reasonKey] || null} /></td></tr>}
                </Fragment>
              })}
              {!loading && response?.rows.length === 0 && <tr><td colSpan={visibleColumns.length + 3} className="h-28 text-center text-[var(--color-text-muted)]">条件に一致する銘柄はありません。</td></tr>}
            </tbody>
          </table>
        </div>
        {response && response.total > response.limit && <div className="flex items-center justify-between border-t border-[var(--color-border-default)] px-3 py-2 text-[10px]">
          <span className="text-[var(--color-text-muted)]">{response.offset + 1}〜{Math.min(response.offset + response.rows.length, response.total)}件 / {response.total.toLocaleString('ja-JP')}件</span>
          <div className="flex items-center gap-1.5">
            <button type="button" disabled={state.page <= 0 || loading} onClick={() => setState((current) => ({ ...current, page: Math.max(0, current.page - 1) }))} className="h-7 border border-[var(--color-border-default)] px-2 font-bold disabled:opacity-35">前へ</button>
            <span className="min-w-14 text-center font-mono">{Math.min(state.page + 1, pageCount)} / {pageCount}</span>
            <button type="button" disabled={state.page >= pageCount - 1 || loading} onClick={() => setState((current) => ({ ...current, page: Math.min(pageCount - 1, current.page + 1) }))} className="h-7 border border-[var(--color-border-default)] px-2 font-bold disabled:opacity-35">次へ</button>
          </div>
        </div>}
        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-[var(--color-border-default)] px-3 py-2 text-[10px] text-[var(--color-text-muted)]">
          <span>欠損・N/A・N/Mは0へ置き換えず、数値条件の対象外です。</span>
          <span>API {response?.elapsedMs ?? '—'}ms{response?.cacheHit ? ' / cache' : ''}</span>
        </div>
      </section>
    </div>
    {openReasonKey && <div className="fixed inset-x-0 bottom-0 z-[70] hidden max-h-[74vh] overflow-y-auto border-t-2 border-[var(--color-brand-700)] bg-white shadow-2xl max-[640px]:block" data-screener-reason-sheet>
      <ReasonPanel reason={reasonByKey[openReasonKey] ?? null} loading={reasonLoadingKey === openReasonKey} error={reasonErrorByKey[openReasonKey] || null} onClose={() => setOpenReasonKey(null)} />
    </div>}
    {openChangeReasonKey && <div className="fixed inset-x-0 bottom-0 z-[71] hidden max-h-[78vh] overflow-y-auto border-t-2 border-[var(--color-brand-700)] bg-white shadow-2xl max-[640px]:block" data-saved-screen-change-reason-sheet>
      <ChangeReasonPanel reason={changeReasonByKey[openChangeReasonKey] ?? null} loading={changeReasonLoadingKey === openChangeReasonKey} error={changeReasonErrorByKey[openChangeReasonKey] || null} onClose={() => setOpenChangeReasonKey(null)} />
    </div>}
  </div>
}
