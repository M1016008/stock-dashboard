'use client'

import { useEffect, useMemo, useState, useTransition } from 'react'
import Link from 'next/link'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import {
  ArrowDownToLine,
  ArrowUpFromLine,
  ChevronDown,
  ChevronUp,
  Filter,
  Layers3,
  Radar,
  RotateCcw,
  SlidersHorizontal,
} from 'lucide-react'
import { StageDots } from '@/components/ui/StageDots'

type FilterOption = {
  value: string
  label: string
  parent: string | null
  count: number
}

type MonitorRow = {
  signalKind: 'ma' | 'cluster'
  ticker: string
  name: string
  period: number | null
  clusterKey: string | null
  clusterPeriods: number[] | null
  isStrongCluster: number | boolean
  date: string
  close: number
  maValue: number
  targetLow: number
  targetHigh: number
  clusterSpreadPct: number | null
  distancePct: number
  absDistancePct: number
  distance5dPct: number | null
  distance10dPct: number | null
  isApproaching: number | boolean
  approachDirection: 'above' | 'below' | 'none'
  approachSpeedPctPerDay: number
  isTouch: number | boolean
  lastTouchDate: string | null
  touchAgeSessions: number | null
  lastCrossDate: string | null
  lastCrossDirection: 'up' | 'down' | null
  crossAgeSessions: number | null
  approachScore: number
  isRapidApproach: number | boolean
  marketSegment: string | null
  sector17Name: string | null
  sector33Name: string | null
  marginType: string | null
  majorCategory: string | null
  subIndustry: string | null
  dailyAStage: number | null
  dailyBStage: number | null
  weeklyAStage: number | null
  weeklyBStage: number | null
  monthlyAStage: number | null
  monthlyBStage: number | null
  stageCode: string | null
  currentVolume: number | null
  avgVolume30: number | null
  volumeObservations: number | null
  volumeRatio30: number | null
}

type MonitorResponse = {
  date: string | null
  period: number | 'all'
  periods: readonly number[]
  rows: MonitorRow[]
  total: number
  offset: number
  limit: number
  contactThreshold: number
  volumeWindow: number
  filterOptions: {
    marketSegments: FilterOption[]
    sector17: FilterOption[]
    sector33: FilterOption[]
    marginTypes: FilterOption[]
    majorCategories: FilterOption[]
    subIndustries: FilterOption[]
  }
  summary: {
    monitored: number
    signals: number
    approaching: number
    contact: number
    touch5: number
    cross5: number
    rapid: number
    clusters: number
    strongClusters: number
  }
  message?: string
}

const PERIOD_OPTIONS = [
  ['all', 'すべて'],
  ['3', '3M'],
  ['5', '5M'],
  ['10', '10M'],
  ['15', '15M'],
  ['20', '20M'],
  ['25', '25M'],
] as const

const STATUS_OPTIONS = [
  ['all', '重要シグナル'],
  ['approaching', '接近中'],
  ['approaching_above', '上から接近'],
  ['approaching_below', '下から接近'],
  ['contact', '接触圏'],
  ['touch_today', '本日タッチ'],
  ['touch_3', '3日以内タッチ'],
  ['touch_5', '5日以内タッチ'],
  ['cross_up', '上抜け'],
  ['cross_down', '下抜け'],
  ['rapid', '3〜10%から急接近'],
  ['cluster', 'MAクラスター'],
  ['cluster_approaching', '集中帯へ接近'],
  ['cluster_touch_today', '集中帯へ本日タッチ'],
  ['cluster_cross_up', '集中帯を上抜け'],
  ['cluster_cross_down', '集中帯を下抜け'],
] as const

const CLUSTER_STATUSES = new Set<string>(
  STATUS_OPTIONS.map(([value]) => value).filter((value) => value.startsWith('cluster')),
)

const SORT_OPTIONS = [
  ['score', '接近スコア'],
  ['distance', '距離が近い'],
  ['speed', '接近速度'],
  ['avgVolume', '30日平均出来高'],
  ['volumeRatio', '出来高倍率'],
  ['touch', 'タッチが新しい'],
  ['cross', 'クロスが新しい'],
  ['ticker', '証券コード'],
] as const

const STAGE_FILTERS = [
  ['dailyA', '日A'],
  ['dailyB', '日B'],
  ['weeklyA', '週A'],
  ['weeklyB', '週B'],
  ['monthlyA', '月A'],
  ['monthlyB', '月B'],
] as const

const EMPTY_OPTIONS: MonitorResponse['filterOptions'] = {
  marketSegments: [],
  sector17: [],
  sector33: [],
  marginTypes: [],
  majorCategories: [],
  subIndustries: [],
}

function boundedParam(value: string | null, fallback: number, min: number, max: number): number {
  if (value == null || value.trim() === '') return fallback
  const parsed = Number(value)
  return Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback
}

function formatPrice(value: number): string {
  return new Intl.NumberFormat('ja-JP', { maximumFractionDigits: value < 100 ? 2 : 1 }).format(value)
}

function formatPct(value: number | null, digits = 2): string {
  if (value == null || !Number.isFinite(value)) return '—'
  return `${value > 0 ? '+' : ''}${value.toFixed(digits)}%`
}

function formatVolume(value: number | null): string {
  if (value == null || !Number.isFinite(value)) return '—'
  return new Intl.NumberFormat('ja-JP', {
    notation: 'compact',
    maximumFractionDigits: value >= 100_000 ? 1 : 0,
  }).format(value)
}

function shortDate(value: string | null): string {
  if (!value) return '—'
  const [, month, day] = value.split('-')
  return month && day ? `${Number(month)}/${Number(day)}` : value
}

function ageLabel(age: number | null): string {
  if (age == null) return '—'
  return age === 0 ? '本日' : `${age}日前`
}

function signalLabel(row: MonitorRow): string {
  if (row.signalKind === 'cluster') {
    return (row.clusterPeriods ?? []).map((period) => `${period}M`).join('・') || 'MA集中帯'
  }
  return `${row.period}M`
}

function targetLabel(row: MonitorRow): string {
  if (row.signalKind === 'cluster') {
    return `¥${formatPrice(row.targetLow)}〜${formatPrice(row.targetHigh)}`
  }
  return `¥${formatPrice(row.maValue)}`
}

function rowStatuses(row: MonitorRow, contactPct: number): Array<{ label: string; tone: string }> {
  const values: Array<{ label: string; tone: string }> = []
  if (row.signalKind === 'cluster') values.push({ label: row.isStrongCluster ? '強クラスタ' : 'MA集中帯', tone: 'cluster' })
  if (row.crossAgeSessions === 0 && row.lastCrossDirection === 'up') values.push({ label: '上抜け', tone: 'red' })
  if (row.crossAgeSessions === 0 && row.lastCrossDirection === 'down') values.push({ label: '下抜け', tone: 'blue' })
  if (row.touchAgeSessions === 0) values.push({ label: '本日タッチ', tone: 'amber' })
  else if (row.touchAgeSessions != null && row.touchAgeSessions <= 10) values.push({ label: `タッチ後${row.touchAgeSessions}日`, tone: 'amber' })
  if (row.absDistancePct <= contactPct) values.push({ label: `±${contactPct}%圏`, tone: 'green' })
  if (row.isApproaching) values.push({ label: row.approachDirection === 'above' ? '上から接近' : '下から接近', tone: 'violet' })
  if (row.isRapidApproach) values.push({ label: '急接近', tone: 'red' })
  return values.length ? values : [{ label: '監視', tone: 'gray' }]
}

function StatusBadge({ label, tone }: { label: string; tone: string }) {
  const classes: Record<string, string> = {
    red: 'border-red-200 bg-red-50 text-red-700',
    blue: 'border-blue-200 bg-blue-50 text-blue-700',
    amber: 'border-amber-200 bg-amber-50 text-amber-800',
    cluster: 'border-yellow-300 bg-yellow-100 text-yellow-900',
    green: 'border-emerald-200 bg-emerald-50 text-emerald-700',
    violet: 'border-violet-200 bg-violet-50 text-violet-700',
    gray: 'border-slate-200 bg-slate-50 text-slate-600',
  }
  return <span className={`inline-flex h-5 items-center whitespace-nowrap border px-1.5 text-[9px] font-black ${classes[tone] ?? classes.gray}`}>{label}</span>
}

function SelectField({
  label,
  value,
  onChange,
  children,
}: {
  label: string
  value: string | number
  onChange: (value: string) => void
  children: React.ReactNode
}) {
  return (
    <label className="grid min-w-0 gap-1 text-[9px] font-bold text-[var(--color-text-tertiary)]">
      {label}
      <select aria-label={label} value={value} onChange={(event) => onChange(event.target.value)} className="h-8 min-w-0 border border-[var(--color-border-default)] bg-white px-2 text-[11px] font-bold text-[var(--color-text-primary)] outline-none focus:border-[var(--color-brand-500)]">
        {children}
      </select>
    </label>
  )
}

function OptionRows({ options, allLabel = 'すべて' }: { options: FilterOption[]; allLabel?: string }) {
  return (
    <>
      <option value="">{allLabel}</option>
      {options.map((option) => <option key={`${option.parent ?? ''}-${option.value}`} value={option.value}>{option.label} ({option.count})</option>)}
    </>
  )
}

function StageCell({ row }: { row: MonitorRow }) {
  const groups = [
    ['日', row.dailyAStage, row.dailyBStage],
    ['週', row.weeklyAStage, row.weeklyBStage],
    ['月', row.monthlyAStage, row.monthlyBStage],
  ] as const
  return (
    <div className="grid grid-cols-3 gap-1" title={row.stageCode ? `6ステージ ${row.stageCode}` : '6ステージ未計算'}>
      {groups.map(([label, a, b]) => (
        <div key={label} className="min-w-0">
          <div className="mb-0.5 text-center text-[8px] font-black text-[var(--color-text-tertiary)]">{label}</div>
          <StageDots values={[a, b]} size={18} />
        </div>
      ))}
    </div>
  )
}

export default function Ma25mMonitorPage() {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const [data, setData] = useState<MonitorResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [isPending, startTransition] = useTransition()
  const queryString = searchParams.toString()
  const period = PERIOD_OPTIONS.some(([value]) => value === searchParams.get('period')) ? searchParams.get('period')! : 'all'
  const status = STATUS_OPTIONS.some(([value]) => value === searchParams.get('status')) ? searchParams.get('status')! : 'all'
  const contactPct = boundedParam(searchParams.get('contactPct'), 2, 0.1, 10)
  const minScore = boundedParam(searchParams.get('minScore'), 0, 0, 100)
  const maxDistance = searchParams.get('maxDistance') ?? ''
  const sort = searchParams.get('sort') ?? 'score'
  const q = searchParams.get('q') ?? ''
  const offset = Math.floor(boundedParam(searchParams.get('offset'), 0, 0, 100_000))
  const market = searchParams.get('market') ?? ''
  const sector17 = searchParams.get('sector17') ?? ''
  const sector33 = searchParams.get('sector33') ?? ''
  const marginType = searchParams.get('marginType') ?? ''
  const majorCategory = searchParams.get('majorCategory') ?? ''
  const subIndustry = searchParams.get('subIndustry') ?? ''
  const avgVolumeMin = searchParams.get('avgVolumeMin') ?? ''
  const volumeRatioMin = searchParams.get('volumeRatioMin') ?? ''
  const [searchDraft, setSearchDraft] = useState(q)
  const advancedActive = Boolean(maxDistance || minScore || majorCategory || subIndustry || STAGE_FILTERS.some(([key]) => searchParams.has(key)))
  const [showAdvanced, setShowAdvanced] = useState(advancedActive)
  const apiQueryString = useMemo(() => {
    const query = new URLSearchParams(queryString)
    if (!query.has('period')) query.set('period', 'all')
    return query.toString()
  }, [queryString])

  useEffect(() => {
    if (advancedActive) setShowAdvanced(true)
  }, [advancedActive])

  useEffect(() => {
    setSearchDraft(q)
  }, [q])

  useEffect(() => {
    const controller = new AbortController()
    setLoading(true)
    setError('')
    fetch(`/api/ma25m-monitor?${apiQueryString}`, { cache: 'no-store', signal: controller.signal })
      .then((response) => response.ok ? response.json() : Promise.reject(new Error(`HTTP ${response.status}`)))
      .then((payload: MonitorResponse) => setData(payload))
      .catch((reason) => {
        if (reason instanceof DOMException && reason.name === 'AbortError') return
        setError(reason instanceof Error ? reason.message : String(reason))
      })
      .finally(() => setLoading(false))
    return () => controller.abort()
  }, [apiQueryString])

  const summaryItems = useMemo(() => [
    ['監視銘柄', data?.summary.monitored ?? 0],
    ['接近中', data?.summary.approaching ?? 0],
    [`±${contactPct}%圏`, data?.summary.contact ?? 0],
    ['5日タッチ', data?.summary.touch5 ?? 0],
    ['5日クロス', data?.summary.cross5 ?? 0],
    ['クラスター', data?.summary.clusters ?? 0],
    ['強クラスタ', data?.summary.strongClusters ?? 0],
  ], [contactPct, data])

  const options = data?.filterOptions ?? EMPTY_OPTIONS
  const sector33Options = useMemo(
    () => sector17 ? options.sector33.filter((option) => option.parent === sector17) : options.sector33,
    [options.sector33, sector17],
  )
  const subIndustryOptions = useMemo(
    () => majorCategory ? options.subIndustries.filter((option) => option.parent === majorCategory) : options.subIndustries,
    [majorCategory, options.subIndustries],
  )

  const updateParams = (changes: Record<string, string | null>, resetOffset = true) => {
    const next = new URLSearchParams(searchParams.toString())
    for (const [key, value] of Object.entries(changes)) {
      if (value == null || value === '' || value === 'all' || (key === 'minScore' && value === '0')) next.delete(key)
      else next.set(key, value)
    }
    if (resetOffset) next.delete('offset')
    startTransition(() => router.replace(next.size ? `${pathname}?${next}` : pathname, { scroll: false }))
  }

  const selectPeriod = (value: string) => {
    const nextStatus = value !== 'all' && CLUSTER_STATUSES.has(status) ? 'all' : status
    updateParams({ period: value, status: nextStatus })
  }

  return (
    <main className="min-w-0 px-3 py-4 sm:px-4">
      <div className="border border-[var(--color-border-default)] bg-white">
        <header className="flex flex-wrap items-center gap-3 border-b border-[var(--color-border-default)] bg-[var(--color-brand-900)] px-3 py-2.5 text-white">
          <span className="inline-flex h-8 w-8 items-center justify-center border border-white/30 bg-white/10"><Radar size={18} /></span>
          <div className="min-w-0">
            <h1 className="text-[17px] font-black leading-tight">Monthly MA Monitor</h1>
            <p className="mt-0.5 text-[10px] font-bold text-blue-100">月足MA接近レーダー</p>
          </div>
          <div className="ml-auto text-right text-[10px] font-bold text-blue-100">
            <div>基準日</div>
            <div className="font-mono text-[12px] text-white">{data?.date ?? '—'}</div>
          </div>
        </header>

        <div className="grid grid-cols-2 border-b border-[var(--color-border-default)] sm:grid-cols-4 lg:grid-cols-7">
          {summaryItems.map(([label, value], index) => (
            <div key={String(label)} className={`px-3 py-2 ${index > 0 ? 'border-l border-[var(--color-border-soft)]' : ''}`}>
              <div className="text-[9px] font-bold text-[var(--color-text-tertiary)]">{label}</div>
              <div className="mt-0.5 font-mono text-[17px] font-black text-[var(--color-brand-900)]">{value}</div>
            </div>
          ))}
        </div>

        <section className="border-b border-[var(--color-border-default)] px-3 py-2.5">
          <div className="mb-1.5 text-[9px] font-black text-[var(--color-text-tertiary)]">対象MA</div>
          <div className="flex flex-wrap gap-1">
            {PERIOD_OPTIONS.map(([value, label]) => (
              <button key={value} type="button" onClick={() => selectPeriod(value)} className={`h-7 min-w-12 border px-2 text-[10px] font-black ${period === value ? 'border-[var(--color-brand-700)] bg-[var(--color-brand-700)] text-white' : 'border-[var(--color-border-default)] bg-white text-[var(--color-text-secondary)]'}`}>
                {label}
              </button>
            ))}
          </div>
        </section>

        <section className="border-b border-[var(--color-border-default)] bg-[var(--color-surface-subtle)] p-3">
          <div className="mb-2 flex items-center gap-1.5 text-[11px] font-black text-[var(--color-brand-900)]"><Filter size={14} /> シグナル</div>
          <div className="flex flex-wrap gap-1.5">
            {STATUS_OPTIONS.map(([value, label]) => {
              const unavailable = period !== 'all' && value.startsWith('cluster')
              return (
                <button key={value} type="button" disabled={unavailable} onClick={() => updateParams({ status: value })} className={`h-7 border px-2 text-[10px] font-black disabled:cursor-not-allowed disabled:opacity-35 ${status === value ? 'border-[var(--color-market-red)] bg-red-50 text-[var(--color-market-red)]' : value.startsWith('cluster') ? 'border-yellow-300 bg-yellow-50 text-yellow-900' : 'border-[var(--color-border-default)] bg-white text-[var(--color-text-secondary)]'}`}>
                  {label}
                </button>
              )
            })}
          </div>

          <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-8">
            <label className="grid gap-1 text-[9px] font-bold text-[var(--color-text-tertiary)] xl:col-span-2">
              銘柄検索
              <input
                value={searchDraft}
                onChange={(event) => setSearchDraft(event.target.value)}
                onBlur={() => searchDraft !== q && updateParams({ q: searchDraft })}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && searchDraft !== q) updateParams({ q: searchDraft })
                }}
                placeholder="コード・銘柄名"
                className="h-8 border border-[var(--color-border-default)] bg-white px-2 text-[11px] text-[var(--color-text-primary)] outline-none focus:border-[var(--color-brand-500)]"
              />
            </label>
            <SelectField label="市場" value={market} onChange={(value) => updateParams({ market: value })}>
              <OptionRows options={options.marketSegments} />
            </SelectField>
            <SelectField label="17業種" value={sector17} onChange={(value) => updateParams({ sector17: value, sector33: null })}>
              <OptionRows options={options.sector17} />
            </SelectField>
            <SelectField label="33業種" value={sector33} onChange={(value) => updateParams({ sector33: value })}>
              <OptionRows options={sector33Options} />
            </SelectField>
            <SelectField label="貸借・信用" value={marginType} onChange={(value) => updateParams({ marginType: value })}>
              <OptionRows options={options.marginTypes} />
            </SelectField>
            <SelectField label="30日平均出来高" value={avgVolumeMin} onChange={(value) => updateParams({ avgVolumeMin: value })}>
              <option value="">指定なし</option>
              <option value="10000">1万株以上</option>
              <option value="50000">5万株以上</option>
              <option value="100000">10万株以上</option>
              <option value="500000">50万株以上</option>
              <option value="1000000">100万株以上</option>
              <option value="5000000">500万株以上</option>
            </SelectField>
            <SelectField label="出来高 / 30日平均" value={volumeRatioMin} onChange={(value) => updateParams({ volumeRatioMin: value })}>
              <option value="">指定なし</option>
              <option value="0.5">0.5倍以上</option>
              <option value="1">1.0倍以上</option>
              <option value="1.5">1.5倍以上</option>
              <option value="2">2.0倍以上</option>
              <option value="3">3.0倍以上</option>
            </SelectField>
          </div>

          <div className="mt-2 flex flex-wrap items-center gap-2">
            <button type="button" onClick={() => setShowAdvanced((value) => !value)} className={`inline-flex h-8 items-center gap-1.5 border px-2.5 text-[10px] font-black ${advancedActive ? 'border-[var(--color-brand-500)] bg-[var(--color-brand-50)] text-[var(--color-brand-800)]' : 'border-[var(--color-border-default)] bg-white text-[var(--color-text-secondary)]'}`}>
              <SlidersHorizontal size={13} /> 詳細条件 {showAdvanced ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
            </button>
            <SelectField label="並び順" value={sort} onChange={(value) => updateParams({ sort: value, dir: null })}>
              {SORT_OPTIONS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </SelectField>
            <button type="button" onClick={() => startTransition(() => router.replace(pathname, { scroll: false }))} className="mt-auto inline-flex h-8 items-center justify-center gap-1.5 border border-[var(--color-border-default)] bg-white px-3 text-[10px] font-black text-[var(--color-text-secondary)]">
              <RotateCcw size={13} /> リセット
            </button>
          </div>

          {showAdvanced && (
            <div className="mt-3 border-t border-[var(--color-border-default)] pt-3">
              <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-5">
                <SelectField label="四季報60分類" value={majorCategory} onChange={(value) => updateParams({ majorCategory: value, subIndustry: null })}>
                  <OptionRows options={options.majorCategories} />
                </SelectField>
                <SelectField label="業種細分類" value={subIndustry} onChange={(value) => updateParams({ subIndustry: value })}>
                  <OptionRows options={subIndustryOptions} />
                </SelectField>
                <SelectField label="接触圏" value={contactPct} onChange={(value) => updateParams({ contactPct: value })}>
                  {[1, 2, 3, 5].map((value) => <option key={value} value={value}>±{value}%</option>)}
                </SelectField>
                <SelectField label="最大乖離率" value={maxDistance} onChange={(value) => updateParams({ maxDistance: value })}>
                  <option value="">指定なし</option>
                  {[1, 2, 3, 5, 10].map((value) => <option key={value} value={value}>{value}%以内</option>)}
                </SelectField>
                <SelectField label="最低スコア" value={minScore} onChange={(value) => updateParams({ minScore: value })}>
                  {[0, 40, 50, 60, 70, 80, 90].map((value) => <option key={value} value={value}>{value}点以上</option>)}
                </SelectField>
              </div>
              <div className="mt-3">
                <div className="mb-1.5 text-[9px] font-black text-[var(--color-text-tertiary)]">6ステージ</div>
                <div className="grid grid-cols-3 gap-2 sm:grid-cols-6 lg:max-w-[650px]">
                  {STAGE_FILTERS.map(([key, label]) => (
                    <SelectField key={key} label={label} value={searchParams.get(key) ?? ''} onChange={(value) => updateParams({ [key]: value })}>
                      <option value="">すべて</option>
                      {[1, 2, 3, 4, 5, 6].map((stage) => <option key={stage} value={stage}>Stage {stage}</option>)}
                    </SelectField>
                  ))}
                </div>
              </div>
            </div>
          )}
        </section>

        <div className="flex items-center justify-between border-b border-[var(--color-border-default)] px-3 py-2 text-[10px] font-bold text-[var(--color-text-tertiary)]">
          <span>{loading || isPending ? '更新中…' : `${data?.total ?? 0}件`}</span>
          {error && <span className="text-red-600">読込エラー: {error}</span>}
        </div>

        <div className="overflow-x-auto">
          <table className="w-full min-w-[1120px] table-fixed border-collapse text-[10px]">
            <colgroup>
              <col className="w-[160px]" />
              <col className="w-[145px]" />
              <col className="w-[135px]" />
              <col className="w-[145px]" />
              <col className="w-[180px]" />
              <col className="w-[125px]" />
              <col className="w-[160px]" />
              <col className="w-[70px]" />
            </colgroup>
            <thead className="sticky top-0 z-10 bg-[var(--color-brand-50)] text-[9px] font-black text-[var(--color-brand-900)]">
              <tr>
                {['銘柄・属性', '6ステージ', 'MAシグナル', '価格・乖離', '接近状態', '出来高', 'タッチ・クロス', 'スコア'].map((label, index) => (
                  <th key={label} className={`whitespace-nowrap border-b border-r border-[var(--color-border-default)] px-2 py-2 text-left last:border-r-0 ${index === 0 ? 'sticky left-0 z-20 bg-[var(--color-brand-50)]' : ''}`}>{label}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {(data?.rows ?? []).map((row) => {
                const isCluster = row.signalKind === 'cluster'
                const key = `${row.ticker}-${row.signalKind}-${row.period ?? row.clusterKey}`
                const statuses = rowStatuses(row, contactPct)
                const volumeRatio = row.volumeRatio30
                const volumeTone = volumeRatio == null ? 'text-[var(--color-text-tertiary)]' : volumeRatio >= 1.5 ? 'text-red-700' : volumeRatio >= 1 ? 'text-emerald-700' : 'text-[var(--color-text-secondary)]'
                const rowBackground = isCluster ? 'bg-yellow-50/80 hover:bg-yellow-100/80' : 'bg-white hover:bg-blue-50/60'
                return (
                  <tr key={key} className={`border-b border-[var(--color-border-soft)] align-top ${rowBackground}`}>
                    <td className={`sticky left-0 z-[1] border-r border-[var(--color-border-soft)] px-2 py-2 ${rowBackground}`}>
                      <Link href={`/stock/${encodeURIComponent(row.ticker)}#chart`} className="block min-w-0" title={`${row.ticker} ${row.name}`}>
                        <div className="flex min-w-0 items-baseline gap-1.5">
                          <span className="shrink-0 font-mono text-[12px] font-black text-[var(--color-brand-700)] hover:underline">{row.ticker}</span>
                          <span className="min-w-0 truncate text-[10px] font-bold text-[var(--color-text-primary)]">{row.name}</span>
                        </div>
                      </Link>
                      <div className="mt-1 truncate text-[9px] font-bold text-[var(--color-text-tertiary)]" title={[row.sector17Name, row.sector33Name, row.subIndustry].filter(Boolean).join(' / ')}>{row.sector33Name ?? row.sector17Name ?? row.subIndustry ?? '業種未分類'}</div>
                      <div className="mt-1 flex items-center gap-1">
                        {row.marginType && <span className={`border px-1 py-0.5 text-[8px] font-black ${row.marginType === '貸借' ? 'border-blue-200 bg-blue-50 text-blue-800' : 'border-slate-200 bg-slate-50 text-slate-600'}`}>{row.marginType}</span>}
                        {row.marketSegment && <span className="max-w-[92px] truncate text-[8px] font-bold text-[var(--color-text-tertiary)]" title={row.marketSegment}>{row.marketSegment}</span>}
                      </div>
                    </td>
                    <td className="border-r border-[var(--color-border-soft)] px-2 py-2"><StageCell row={row} /></td>
                    <td className="border-r border-[var(--color-border-soft)] px-2 py-2">
                      <div className={`flex items-center gap-1 font-mono text-[11px] font-black ${isCluster ? 'text-yellow-900' : 'text-[var(--color-brand-800)]'}`}>{isCluster && <Layers3 size={12} />}{signalLabel(row)}</div>
                      <div className="mt-1 whitespace-nowrap font-mono text-[10px] font-bold text-[var(--color-text-primary)]">{targetLabel(row)}</div>
                      {isCluster && row.clusterSpreadPct != null && <div className="mt-1 text-[9px] font-bold text-yellow-800">帯幅 {row.clusterSpreadPct.toFixed(2)}%</div>}
                    </td>
                    <td className="border-r border-[var(--color-border-soft)] px-2 py-2 text-right">
                      <div className="font-mono text-[12px] font-black">¥{formatPrice(row.close)}</div>
                      <div className={`mt-0.5 font-mono text-[12px] font-black ${row.distancePct >= 0 ? 'text-red-600' : 'text-blue-600'}`}>{formatPct(row.distancePct)}</div>
                      <div className="mt-1 font-mono text-[9px] text-[var(--color-text-tertiary)]">5日 {formatPct(row.distance5dPct)} / 10日 {formatPct(row.distance10dPct)}</div>
                    </td>
                    <td className="border-r border-[var(--color-border-soft)] px-2 py-2">
                      <div className="flex items-center justify-between gap-2">
                        {row.isApproaching ? (
                          <span className="inline-flex items-center gap-1 font-black text-violet-700">{row.approachDirection === 'above' ? <ArrowDownToLine size={13} /> : <ArrowUpFromLine size={13} />}{row.approachDirection === 'above' ? '上から' : '下から'}</span>
                        ) : <span className="text-[var(--color-text-tertiary)]">方向なし</span>}
                        <span className={`font-mono text-[10px] font-black ${row.approachSpeedPctPerDay > 0 ? 'text-emerald-700' : 'text-slate-500'}`}>{formatPct(row.approachSpeedPctPerDay, 3)}/日</span>
                      </div>
                      <div className="mt-1.5 flex flex-wrap gap-1" title={statuses.map((item) => item.label).join(' / ')}>
                        {statuses.slice(0, 3).map((item) => <StatusBadge key={`${item.label}-${item.tone}`} {...item} />)}
                        {statuses.length > 3 && <span className="inline-flex h-5 items-center border border-slate-200 bg-white px-1 text-[9px] font-black text-slate-500">+{statuses.length - 3}</span>}
                      </div>
                    </td>
                    <td className="border-r border-[var(--color-border-soft)] px-2 py-2 text-right">
                      <div className={`font-mono text-[11px] font-black ${volumeTone}`}>{formatVolume(row.currentVolume)}</div>
                      <div className="mt-0.5 font-mono text-[9px] text-[var(--color-text-tertiary)]">30日 {formatVolume(row.avgVolume30)}</div>
                      <div className={`mt-1 font-mono text-[11px] font-black ${volumeTone}`}>{volumeRatio == null ? '—' : `${volumeRatio.toFixed(2)}倍`}</div>
                    </td>
                    <td className="border-r border-[var(--color-border-soft)] px-2 py-2">
                      <div className="grid grid-cols-[38px_38px_1fr] items-center gap-1">
                        <span className="font-bold text-amber-800">タッチ</span>
                        <span className="font-mono text-[9px]">{shortDate(row.lastTouchDate)}</span>
                        <span className="text-right text-[9px] font-bold text-[var(--color-text-tertiary)]">{ageLabel(row.touchAgeSessions)}</span>
                        <span className={`font-black ${row.lastCrossDirection === 'up' ? 'text-red-600' : row.lastCrossDirection === 'down' ? 'text-blue-600' : 'text-[var(--color-text-tertiary)]'}`}>{row.lastCrossDirection === 'up' ? '上抜け' : row.lastCrossDirection === 'down' ? '下抜け' : 'クロス'}</span>
                        <span className="font-mono text-[9px]">{shortDate(row.lastCrossDate)}</span>
                        <span className="text-right text-[9px] font-bold text-[var(--color-text-tertiary)]">{ageLabel(row.crossAgeSessions)}</span>
                      </div>
                    </td>
                    <td className="px-2 py-2 text-center"><span className={`inline-flex h-9 min-w-11 items-center justify-center px-1 font-mono text-[14px] font-black text-white ${isCluster ? 'bg-yellow-700' : 'bg-[var(--color-brand-900)]'}`}>{row.approachScore.toFixed(1)}</span></td>
                  </tr>
                )
              })}
              {!loading && (data?.rows.length ?? 0) === 0 && (
                <tr><td colSpan={8} className="px-3 py-10 text-center text-[12px] font-bold text-[var(--color-text-tertiary)]">該当銘柄はありません</td></tr>
              )}
            </tbody>
          </table>
        </div>

        <div className="flex items-center justify-between border-t border-[var(--color-border-default)] px-3 py-2">
          <button type="button" disabled={offset <= 0} onClick={() => updateParams({ offset: String(Math.max(0, offset - (data?.limit ?? 100))) }, false)} className="h-8 border border-[var(--color-border-default)] bg-white px-3 text-[10px] font-black disabled:opacity-40">前へ</button>
          <span className="font-mono text-[10px] text-[var(--color-text-tertiary)]">{data?.total ? `${offset + 1}–${Math.min(offset + (data?.limit ?? 100), data.total)} / ${data.total}` : '0件'}</span>
          <button type="button" disabled={offset + (data?.limit ?? 100) >= (data?.total ?? 0)} onClick={() => updateParams({ offset: String(offset + (data?.limit ?? 100)) }, false)} className="h-8 border border-[var(--color-border-default)] bg-white px-3 text-[10px] font-black disabled:opacity-40">次へ</button>
        </div>
      </div>
    </main>
  )
}
