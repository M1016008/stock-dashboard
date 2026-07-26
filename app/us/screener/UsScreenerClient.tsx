'use client'

import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import { useEffect, useMemo, useState } from 'react'
import { ArrowDownAZ, ArrowUpAZ, CircleHelp, Columns3, Filter, GitCompareArrows, RotateCcw } from 'lucide-react'
import { StageTag } from '@/components/ui/StageTag'
import { SavedViewManager } from '@/components/ui/SavedViewManager'
import { getCompareSymbols, toggleComparedSymbol } from '@/lib/client/stock-workspace'
import { formatShortTermStrength } from '@/lib/short-term-check'
import {
  normalizeUsClassificationFilters,
  supportsUsSicClassification,
} from '@/lib/us-screener-filters'

type Row = {
  ticker: string
  name: string | null
  exchange: string | null
  asset_type: string | null
  sector: string | null
  industry: string | null
  classification_taxonomy?: string | null
  classification_source?: string | null
  price: number | null
  volume: number | null
  avg_volume_20: number | null
  change_pct: number | null
  return_5d: number | null
  return_20d: number | null
  return_60d: number | null
  return_120d: number | null
  ma_200: number | null
  ma_200_angle?: number | null
  ma_200_gap_pct: number | null
  ma_200_observations: number | null
  qualityFlags?: string[]
  qualityStatus?: 'standard' | 'attention'
  market_cap: number | null
  stage_code: string | null
  physical_momentum_score: number | null
  physical_force_score: number | null
  physical_energy_score: number | null
  acceleration?: number | null
  force?: number | null
  physicalStatusLabel?: string | null
  daily_a_stage?: number | null
  daily_b_stage?: number | null
  weekly_a_stage?: number | null
  weekly_b_stage?: number | null
  monthly_a_stage?: number | null
  monthly_b_stage?: number | null
  shortTermCheckLabel?: string | null
  shortTermCheckScore?: number | null
  shortTermCheckReasons?: string[] | null
}

type AxisKey = 'daily_a' | 'daily_b' | 'weekly_a' | 'weekly_b' | 'monthly_a' | 'monthly_b'
type StageSelection = Partial<Record<AxisKey, number[]>>

type UsScreenerView = {
  query: string
  exchange: string
  sector: string
  industryGroup: string
  industry: string
  stageCode: string
  stages: StageSelection
  avgVolumeMin: string
  priceMin: string
  priceMax: string
  assetType: string
  quality: 'standard' | 'all'
  ma200Trend: '' | 'above' | 'below'
  ma200Direction: '' | 'up' | 'down' | 'flat'
  pmsMin: string
  pfsMin: string
  pesMin: string
  accelerationPositive: boolean
  forcePositive: boolean
  stage23Candidate: boolean
  shortTermCheck: string
  physicalStatus: string
  marketCapBin: string
  sort: string
  dir: 'asc' | 'desc'
}

type ColumnMode = 'core' | 'all'

type ScreenerFacets = {
  exchanges: string[]
  sectors: string[]
  industryGroups: Array<{ sector: string | null; code: string; name: string }>
  industries: Array<{ sector: string | null; industryCode: string | null; industry: string }>
}

const SORT_VALUES = new Set(['ticker', 'exchange', 'sector', 'industry', 'price', 'changePct', 'return5d', 'return20d', 'return60d', 'return120d', 'ma200Gap', 'ma200Angle', 'volume', 'avgVolume20', 'marketCap', 'stageCode', 'pms', 'pfs', 'pes', 'acceleration', 'force', 'shortTermCheckScore', 'shortTermCheckLabel'])
const COLUMN_MODE_KEY = 'stockboard_us_screener_columns_v1'
const AXES: { key: AxisKey; label: string; color: string }[] = [
  { key: 'daily_a', label: '日足A', color: '#ef4444' },
  { key: 'daily_b', label: '日足B', color: '#f59e0b' },
  { key: 'weekly_a', label: '週足A', color: '#22c55e' },
  { key: 'weekly_b', label: '週足B', color: '#3b82f6' },
  { key: 'monthly_a', label: '月足A', color: '#a855f7' },
  { key: 'monthly_b', label: '月足B', color: '#ec4899' },
]
const EXCHANGES = ['NASDAQ', 'NYSE', 'NYSE ARCA', 'NYSE AMERICAN', 'AMEX']
const VOLUME_OPTIONS = [
  { value: '', label: '全て' },
  { value: '100000', label: '10万株以上' },
  { value: '500000', label: '50万株以上' },
  { value: '1000000', label: '100万株以上' },
  { value: '5000000', label: '500万株以上' },
]
const MCAP_BINS = [
  { key: '', label: '全て', min: null, max: null },
  { key: 'mega', label: '$200B以上', min: 200e9, max: null },
  { key: 'large', label: '$10B〜$200B', min: 10e9, max: 200e9 },
  { key: 'mid', label: '$2B〜$10B', min: 2e9, max: 10e9 },
  { key: 'small', label: '$300M〜$2B', min: 300e6, max: 2e9 },
  { key: 'micro', label: '$300M未満', min: null, max: 300e6 },
]
const SHORT_TERM_OPTIONS = ['強気優勢', '好転候補', '中立', '弱含み注意', '下落警戒']
const PHYSICAL_STATUS_OPTIONS = ['上昇加速', '上昇継続', '反発準備', '見送り', '失速警戒', '弱含み', '下落加速', '算出待ち']

function fmtMoney(value: number | null | undefined) {
  if (value == null || !Number.isFinite(value)) return '-'
  return `$${value.toLocaleString('en-US', { maximumFractionDigits: 2 })}`
}

function fmtPct(value: number | null | undefined) {
  if (value == null || !Number.isFinite(value)) return '-'
  return `${value >= 0 ? '+' : ''}${value.toFixed(2)}%`
}

function fmtCap(value: number | null | undefined) {
  if (value == null || !Number.isFinite(value)) return '-'
  if (value >= 1e12) return `$${(value / 1e12).toFixed(2)}T`
  if (value >= 1e9) return `$${(value / 1e9).toFixed(1)}B`
  if (value >= 1e6) return `$${(value / 1e6).toFixed(0)}M`
  return `$${Math.round(value).toLocaleString('en-US')}`
}

function fmtScore(value: number | null | undefined) {
  if (value == null || !Number.isFinite(value)) return '-'
  return value.toFixed(2)
}

function displayMessage(message: string | null, hasScreeningConditions: boolean) {
  if (!message) {
    if (hasScreeningConditions) {
      return '指定した条件に該当する銘柄はありません。条件を変更して再検索してください。'
    }
    return 'USデータが未取得です。データ更新状況を確認してください。'
  }
  if (message.includes('snapshots are not generated')) {
    return 'USステージデータが未生成です。更新ジョブの完了後に再読み込みしてください。'
  }
  return message
}

function parseUrlLimit(value: string | null): number {
  if (!value) return 200
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed <= 0) return 200
  return Math.min(1000, Math.max(1, Math.floor(parsed)))
}

function StageCode({ code }: { code: string | null | undefined }) {
  if (!code) return <span className="text-[11px] font-bold text-[var(--color-text-tertiary)]">------</span>
  return (
    <span className="inline-flex gap-0.5">
      {code.split('').slice(0, 6).map((digit, index) => (
        <StageTag key={`${digit}-${index}`} stage={Number(digit)} size="xs" />
      ))}
    </span>
  )
}

function shortTermClass(label: string | null | undefined) {
  if (label === '強気優勢') return 'border-red-200 bg-red-50 text-red-700'
  if (label === '好転候補') return 'border-rose-200 bg-rose-50 text-rose-700'
  if (label === '弱含み注意') return 'border-blue-200 bg-blue-50 text-blue-700'
  if (label === '下落警戒') return 'border-sky-200 bg-sky-50 text-sky-800'
  return 'border-[var(--color-border-default)] bg-[var(--color-surface-subtle)] text-[var(--color-text-secondary)]'
}

export function UsScreenerClient() {
  const searchParams = useSearchParams()
  const sortParam = searchParams.get('sort') || 'ticker'
  const initialSort = SORT_VALUES.has(sortParam) ? sortParam : 'ticker'
  const initialDir = searchParams.get('dir') === 'desc' ? 'desc' : 'asc'
  const initialLimit = parseUrlLimit(searchParams.get('limit'))
  const [resultLimit, setResultLimit] = useState(initialLimit)
  const [rows, setRows] = useState<Row[]>([])
  const [date, setDate] = useState<string | null>(null)
  const [hasMore, setHasMore] = useState(false)
  const [facets, setFacets] = useState<ScreenerFacets>({
    exchanges: [],
    sectors: [],
    industryGroups: [],
    industries: [],
  })
  const [query, setQuery] = useState(searchParams.get('q') || '')
  const [exchange, setExchange] = useState(searchParams.get('exchange') || '')
  const [sector, setSector] = useState(searchParams.get('sector') || '')
  const [industryGroup, setIndustryGroup] = useState(searchParams.get('industryGroup') || '')
  const [industry, setIndustry] = useState(searchParams.get('industry') || '')
  const [stageCode, setStageCode] = useState(searchParams.get('stageCode') || '')
  const [stages, setStages] = useState<StageSelection>(() => {
    const initial: StageSelection = {}
    for (const axis of AXES) {
      const values = (searchParams.get(axis.key) ?? '')
        .split(',')
        .map(Number)
        .filter((value) => Number.isInteger(value) && value >= 1 && value <= 6)
      if (values.length > 0) initial[axis.key] = values
    }
    return initial
  })
  const [avgVolumeMin, setAvgVolumeMin] = useState(searchParams.get('avgVolumeMin') || '')
  const [priceMin, setPriceMin] = useState(searchParams.get('priceMin') || '')
  const [priceMax, setPriceMax] = useState(searchParams.get('priceMax') || '')
  const [assetType, setAssetType] = useState(searchParams.get('assetType') || '')
  const [quality, setQuality] = useState<'standard' | 'all'>(searchParams.get('quality') === 'all' ? 'all' : 'standard')
  const [ma200Trend, setMa200Trend] = useState<'' | 'above' | 'below'>(
    searchParams.get('ma200Trend') === 'above' || searchParams.get('ma200Trend') === 'below'
      ? searchParams.get('ma200Trend') as 'above' | 'below'
      : '',
  )
  const [ma200Direction, setMa200Direction] = useState<'' | 'up' | 'down' | 'flat'>('')
  const [pmsMin, setPmsMin] = useState('')
  const [pfsMin, setPfsMin] = useState('')
  const [pesMin, setPesMin] = useState('')
  const [accelerationPositive, setAccelerationPositive] = useState(false)
  const [forcePositive, setForcePositive] = useState(false)
  const [stage23Candidate, setStage23Candidate] = useState(false)
  const [shortTermCheck, setShortTermCheck] = useState('')
  const [physicalStatus, setPhysicalStatus] = useState('')
  const [marketCapBin, setMarketCapBin] = useState('')
  const [sort, setSort] = useState(initialSort)
  const [dir, setDir] = useState<'asc' | 'desc'>(initialDir)
  const [loading, setLoading] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [filtersOpen, setFiltersOpen] = useState(true)
  const [columnMode, setColumnMode] = useState<ColumnMode>('core')
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const sicClassificationEnabled = supportsUsSicClassification(assetType)
  const params = useMemo(() => {
    const sp = new URLSearchParams({ limit: String(resultLimit), sort, dir })
    if (query.trim()) sp.set('q', query.trim())
    if (exchange.trim()) sp.set('exchange', exchange.trim())
    if (sicClassificationEnabled && sector.trim()) sp.set('sector', sector.trim())
    if (sicClassificationEnabled && industryGroup.trim()) sp.set('industryGroup', industryGroup.trim())
    if (sicClassificationEnabled && industry.trim()) sp.set('industry', industry.trim())
    if (stageCode.trim()) sp.set('stageCode', stageCode.trim())
    for (const axis of AXES) {
      const values = stages[axis.key]
      if (values?.length) sp.set(axis.key, values.join(','))
    }
    if (avgVolumeMin.trim()) sp.set('avgVolumeMin', avgVolumeMin.trim())
    if (priceMin.trim()) sp.set('priceMin', priceMin.trim())
    if (priceMax.trim()) sp.set('priceMax', priceMax.trim())
    if (assetType.trim()) sp.set('assetType', assetType.trim())
    sp.set('quality', quality)
    if (ma200Trend) sp.set('ma200Trend', ma200Trend)
    if (ma200Direction) sp.set('ma200Direction', ma200Direction)
    if (pmsMin.trim()) sp.set('pmsMin', pmsMin.trim())
    if (pfsMin.trim()) sp.set('pfsMin', pfsMin.trim())
    if (pesMin.trim()) sp.set('pesMin', pesMin.trim())
    if (accelerationPositive) sp.set('accelerationPositive', '1')
    if (forcePositive) sp.set('forcePositive', '1')
    if (stage23Candidate) sp.set('stage23Candidate', '1')
    if (shortTermCheck) sp.set('shortTermCheck', shortTermCheck)
    if (physicalStatus) sp.set('physicalStatus', physicalStatus)
    const capBin = MCAP_BINS.find((bin) => bin.key === marketCapBin)
    if (capBin?.min != null) sp.set('marketCapMin', String(capBin.min))
    if (capBin?.max != null) sp.set('marketCapMax', String(capBin.max))
    return sp.toString()
  }, [query, exchange, sector, industryGroup, industry, stageCode, stages, avgVolumeMin, priceMin, priceMax, assetType, sicClassificationEnabled, quality, ma200Trend, ma200Direction, pmsMin, pfsMin, pesMin, accelerationPositive, forcePositive, stage23Candidate, shortTermCheck, physicalStatus, marketCapBin, sort, dir, resultLimit])

  useEffect(() => {
    if (sicClassificationEnabled || (!sector && !industryGroup && !industry)) return
    setSector('')
    setIndustryGroup('')
    setIndustry('')
  }, [sicClassificationEnabled, sector, industryGroup, industry])

  useEffect(() => {
    let cancelled = false
    const controller = new AbortController()
    setLoading(true)
    setRows([])
    setHasMore(false)
    setMessage(null)
    const timer = window.setTimeout(() => {
      fetch(`/api/us/screener?${params}`, { cache: 'no-store', signal: controller.signal })
        .then(async (res) => {
          const data = await res.json().catch(() => ({}))
          if (!res.ok) {
            throw new Error(
              typeof data.message === 'string'
                ? data.message
                : `USスクリーナーAPIの取得に失敗しました（HTTP ${res.status}）。`,
            )
          }
          return data
        })
        .then((data) => {
          if (cancelled) return
          setRows(Array.isArray(data.rows) ? data.rows : [])
          setDate(data.date ?? null)
          setHasMore(Boolean(data.hasMore))
          setFacets({
            exchanges: Array.isArray(data.facets?.exchanges) ? data.facets.exchanges : [],
            sectors: Array.isArray(data.facets?.sectors) ? data.facets.sectors : [],
            industryGroups: Array.isArray(data.facets?.industryGroups) ? data.facets.industryGroups : [],
            industries: Array.isArray(data.facets?.industries) ? data.facets.industries : [],
          })
          setMessage(typeof data.message === 'string' ? data.message : null)
        })
        .catch((error) => {
          if (cancelled || (error instanceof DOMException && error.name === 'AbortError')) return
          setRows([])
          setHasMore(false)
          setMessage(error instanceof Error ? error.message : 'USスクリーナーAPIの取得に失敗しました。')
        })
        .finally(() => { if (!cancelled) setLoading(false) })
    }, 180)
    return () => {
      cancelled = true
      controller.abort()
      window.clearTimeout(timer)
    }
  }, [params])

  useEffect(() => {
    const saved = window.localStorage.getItem(COLUMN_MODE_KEY)
    if (saved === 'core' || saved === 'all') setColumnMode(saved)
  }, [])

  const updateColumnMode = (next: ColumnMode) => {
    setColumnMode(next)
    window.localStorage.setItem(COLUMN_MODE_KEY, next)
  }

  const toggleSelected = (ticker: string) => {
    setSelected((current) => {
      const next = new Set(current)
      if (next.has(ticker)) next.delete(ticker)
      else if (next.size < 4) next.add(ticker)
      return next
    })
  }

  const addSelectedToComparison = () => {
    const compared = new Set(getCompareSymbols().map((symbol) => `${symbol.market}:${symbol.ticker}`))
    rows
      .filter((row) => selected.has(row.ticker))
      .forEach((row) => {
        if (!compared.has(`US:${row.ticker}`)) {
          toggleComparedSymbol({ market: 'US', ticker: row.ticker, name: row.name })
        }
      })
    setSelected(new Set())
  }

  const view = useMemo<UsScreenerView>(() => ({
    query,
    exchange,
    sector,
    industryGroup,
    industry,
    stageCode,
    stages,
    avgVolumeMin,
    priceMin,
    priceMax,
    assetType,
    quality,
    ma200Trend,
    ma200Direction,
    pmsMin,
    pfsMin,
    pesMin,
    accelerationPositive,
    forcePositive,
    stage23Candidate,
    shortTermCheck,
    physicalStatus,
    marketCapBin,
    sort,
    dir,
  }), [query, exchange, sector, industryGroup, industry, stageCode, stages, avgVolumeMin, priceMin, priceMax, assetType, quality, ma200Trend, ma200Direction, pmsMin, pfsMin, pesMin, accelerationPositive, forcePositive, stage23Candidate, shortTermCheck, physicalStatus, marketCapBin, sort, dir])

  const applyView = (next: UsScreenerView) => {
    const normalizedClassification = normalizeUsClassificationFilters({
      assetType: next.assetType ?? '',
      sector: next.sector ?? '',
      industryGroup: next.industryGroup ?? '',
      industry: next.industry ?? '',
    })
    setQuery(next.query ?? '')
    setExchange(next.exchange ?? '')
    setSector(normalizedClassification.sector)
    setIndustryGroup(normalizedClassification.industryGroup)
    setIndustry(normalizedClassification.industry)
    setStageCode(next.stageCode ?? '')
    setStages(next.stages ?? {})
    setAvgVolumeMin(next.avgVolumeMin ?? '')
    setPriceMin(next.priceMin ?? '')
    setPriceMax(next.priceMax ?? '')
    setAssetType(normalizedClassification.assetType)
    setQuality(next.quality === 'all' ? 'all' : 'standard')
    setMa200Trend(next.ma200Trend === 'above' || next.ma200Trend === 'below' ? next.ma200Trend : '')
    setMa200Direction(next.ma200Direction === 'up' || next.ma200Direction === 'down' || next.ma200Direction === 'flat' ? next.ma200Direction : '')
    setPmsMin(next.pmsMin ?? '')
    setPfsMin(next.pfsMin ?? '')
    setPesMin(next.pesMin ?? '')
    setAccelerationPositive(Boolean(next.accelerationPositive))
    setForcePositive(Boolean(next.forcePositive))
    setStage23Candidate(Boolean(next.stage23Candidate))
    setShortTermCheck(next.shortTermCheck ?? '')
    setPhysicalStatus(next.physicalStatus ?? '')
    setMarketCapBin(next.marketCapBin ?? '')
    setSort(SORT_VALUES.has(next.sort) ? next.sort : 'ticker')
    setDir(next.dir === 'desc' ? 'desc' : 'asc')
  }

  const resetFilters = () => {
    setQuery('')
    setExchange('')
    setSector('')
    setIndustryGroup('')
    setIndustry('')
    setStageCode('')
    setStages({})
    setAvgVolumeMin('')
    setPriceMin('')
    setPriceMax('')
    setAssetType('')
    setQuality('standard')
    setMa200Trend('')
    setMa200Direction('')
    setPmsMin('')
    setPfsMin('')
    setPesMin('')
    setAccelerationPositive(false)
    setForcePositive(false)
    setStage23Candidate(false)
    setShortTermCheck('')
    setPhysicalStatus('')
    setMarketCapBin('')
    setSort('ticker')
    setDir('asc')
    setResultLimit(200)
  }

  const activeFilters = [
    query.trim() ? `検索: ${query.trim()}` : '',
    exchange.trim() ? `取引所: ${exchange.trim()}` : '',
    sector.trim() ? `業種: ${sector.trim()}` : '',
    industryGroup.trim()
      ? `業種グループ: ${facets.industryGroups.find((item) => item.code === industryGroup)?.name ?? industryGroup}`
      : '',
    industry.trim() ? `詳細産業: ${industry.trim()}` : '',
    stageCode.trim() ? `6ステージ: ${stageCode.trim()}` : '',
    ...AXES.flatMap((axis) => stages[axis.key]?.length ? [`${axis.label}: ${stages[axis.key]?.join('/')}`] : []),
    avgVolumeMin.trim() ? `20日平均出来高 ≥ ${avgVolumeMin}` : '',
    priceMin.trim() ? `価格 ≥ ${priceMin}` : '',
    priceMax.trim() ? `価格 ≤ ${priceMax}` : '',
    assetType.trim()
      ? `資産種別: ${assetType === 'Stock' ? '株式' : assetType === 'Mutual Fund' ? '投資信託' : assetType}`
      : '',
    quality === 'standard' ? 'データ品質: 異常値を除外' : 'データ品質: 要確認も表示',
    ma200Trend === 'above' ? '200日線より上' : ma200Trend === 'below' ? '200日線より下' : '',
    ma200Direction ? `200日線: ${ma200Direction === 'up' ? '上向き' : ma200Direction === 'down' ? '下向き' : '横ばい'}` : '',
    marketCapBin ? `時価総額: ${MCAP_BINS.find((bin) => bin.key === marketCapBin)?.label}` : '',
    shortTermCheck ? `短期: ${shortTermCheck}` : '',
    physicalStatus ? `物理状態: ${physicalStatus}` : '',
    pmsMin ? `PMS ≥ ${pmsMin}` : '',
    pfsMin ? `PFS ≥ ${pfsMin}` : '',
    pesMin ? `PES ≥ ${pesMin}` : '',
    accelerationPositive ? 'Acceleration > 0' : '',
    forcePositive ? 'Force > 0' : '',
    stage23Candidate ? 'Stage2→3候補' : '',
  ].filter(Boolean)
  const hasScreeningConditions = activeFilters.some((filter) => !filter.startsWith('データ品質:'))
  const exchangeOptions = Array.from(new Set([
    ...EXCHANGES,
    ...facets.exchanges,
    ...rows.map((row) => row.exchange).filter((value): value is string => Boolean(value)),
  ])).sort()
  const sectorOptions = facets.sectors.length > 0
    ? facets.sectors
    : Array.from(new Set(
        rows.map((row) => row.sector).filter((value): value is string => Boolean(value)),
      )).sort()
  const industryGroupOptions = facets.industryGroups
    .filter((item) => !sector || item.sector === sector)
    .filter((item, index, values) => values.findIndex((value) => value.code === item.code) === index)
  const industryOptions = Array.from(new Set(
    facets.industries.length > 0
      ? facets.industries
          .filter((item) => !sector || item.sector === sector)
          .filter((item) => {
            if (!industryGroup) return true
            const code = item.industryCode?.trim()
            return Boolean(code && code.padStart(4, '0').slice(0, 2) === industryGroup)
          })
          .map((item) => item.industry)
      : rows
          .filter((row) => !sector || row.sector === sector)
          .map((row) => row.industry)
          .filter((value): value is string => Boolean(value)),
  )).sort()
  const hasAnyStage = AXES.some((axis) => Boolean(stages[axis.key]?.length))
  const hasMarketCapData = rows.some((row) => row.market_cap != null)

  return (
    <div className="sb-page">
      <div className="sb-page-title">
        <h1>USスクリーナー（マルチ軸ステージフィルタ）</h1>
        <p>Tiingo由来の株価と最新スナップショットを表示。価格基準の移行状況はデータ鮮度で確認できます。HEXステージで絞り込み（複数系統は AND）</p>
      </div>
      <div className="rounded-[var(--radius-card)] border border-[var(--color-border-default)] bg-white shadow-[var(--shadow-card)]">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--color-border-default)] bg-[var(--color-surface-subtle)] px-4 py-3">
        <div>
          <div className="text-[14px] font-bold text-[var(--color-brand-900)]">検索条件と結果</div>
          <div className="mt-1 text-[11px] font-semibold text-[var(--color-text-tertiary)]">
            基準日 {date ?? '-'} / {loading ? '更新中' : `${rows.length.toLocaleString('ja-JP')}件表示${hasMore ? '・続きあり' : ''}`}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {selected.size > 0 && (
            <button
              type="button"
              onClick={addSelectedToComparison}
              className="inline-flex h-8 items-center gap-1.5 border border-[var(--color-brand-700)] bg-[var(--color-brand-700)] px-2.5 text-[11px] font-black text-white"
            >
              <GitCompareArrows size={14} />
              {selected.size}銘柄を比較
            </button>
          )}
          <div className="inline-flex h-8 border border-[var(--color-border-default)] bg-white" aria-label="表示列">
            <button
              type="button"
              onClick={() => updateColumnMode('core')}
              className={`px-2.5 text-[11px] font-black ${columnMode === 'core' ? 'bg-[var(--color-brand-700)] text-white' : 'text-[var(--color-text-secondary)]'}`}
              aria-pressed={columnMode === 'core'}
            >
              主要列
            </button>
            <button
              type="button"
              onClick={() => updateColumnMode('all')}
              className={`inline-flex items-center gap-1 px-2.5 text-[11px] font-black ${columnMode === 'all' ? 'bg-[var(--color-brand-700)] text-white' : 'text-[var(--color-text-secondary)]'}`}
              aria-pressed={columnMode === 'all'}
            >
              <Columns3 size={13} />
              全列
            </button>
          </div>
          <SavedViewManager
            storageKey="stockboard_us_screener_views"
            value={view}
            onApply={applyView}
          />
          <button
            type="button"
            onClick={resetFilters}
            className="inline-flex h-8 w-8 items-center justify-center border border-[var(--color-border-default)] bg-white text-[var(--color-text-secondary)]"
            title="条件をリセット"
            aria-label="条件をリセット"
          >
            <RotateCcw size={14} />
          </button>
          <button
            type="button"
            onClick={() => setFiltersOpen((current) => !current)}
            className={`inline-flex h-8 items-center gap-1.5 border px-2.5 text-[11px] font-black ${
              filtersOpen
                ? 'border-[var(--color-brand-700)] bg-[var(--color-brand-700)] text-white'
                : 'border-[var(--color-border-default)] bg-white text-[var(--color-text-secondary)]'
            }`}
            aria-expanded={filtersOpen}
          >
            <Filter size={14} />
            条件 {activeFilters.length > 0 ? `(${activeFilters.length})` : ''}
          </button>
        </div>
      </div>

      {activeFilters.length > 0 && (
        <div className="flex flex-wrap gap-1.5 border-b border-[var(--color-border-soft)] px-4 py-2">
          {activeFilters.map((filter) => (
            <span key={filter} className="border border-[var(--color-border-default)] bg-[var(--color-surface-subtle)] px-2 py-1 text-[10px] font-bold text-[var(--color-text-secondary)]">
              {filter}
            </span>
          ))}
        </div>
      )}

      {filtersOpen && (
        <div className="flex flex-col gap-3 border-b border-[var(--color-border-default)] bg-white px-4 py-4">
          <div className="grid gap-2 md:grid-cols-[minmax(220px,1fr)_minmax(180px,280px)_auto]">
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="銘柄コード・企業名を検索（AAPL / Microsoft）" className="h-8 min-w-0 border border-[var(--color-border-default)] px-3 text-[12px] font-semibold" />
            <select value={sort} onChange={(event) => setSort(event.target.value)} className="h-8 min-w-0 border border-[var(--color-border-default)] px-2 text-[12px] font-bold" aria-label="並び順">
              <option value="marketCap">時価総額</option>
              <option value="ticker">コード</option>
              <option value="exchange">取引所</option>
              <option value="sector">セクター</option>
              <option value="industry">詳細産業</option>
              <option value="price">株価</option>
              <option value="changePct">騰落率</option>
              <option value="return20d">1か月騰落率</option>
              <option value="ma200Angle">200日線の角度</option>
              <option value="volume">出来高</option>
              <option value="avgVolume20">20日平均出来高</option>
              <option value="shortTermCheckScore">短期チェック</option>
              <option value="pms">PMS</option>
              <option value="pfs">PFS</option>
              <option value="pes">PES</option>
              <option value="acceleration">Acceleration</option>
              <option value="force">Force</option>
            </select>
            <button type="button" onClick={() => setDir(dir === 'asc' ? 'desc' : 'asc')} className="inline-flex h-8 items-center justify-center gap-1.5 border border-[var(--color-border-default)] bg-white px-3 text-[12px] font-bold">
              {dir === 'asc' ? <ArrowUpAZ size={14} /> : <ArrowDownAZ size={14} />}
              {dir === 'asc' ? '昇順' : '降順'}
            </button>
          </div>

          <Section step={1} label="取引所で絞り込み（任意）">
            <div className="flex flex-wrap gap-1.5">
              <Chip active={!exchange} onClick={() => setExchange('')}>全て</Chip>
              {exchangeOptions.map((value) => <Chip key={value} active={exchange === value} onClick={() => setExchange(exchange === value ? '' : value)}>{value}</Chip>)}
            </div>
          </Section>

          <Section step={2} label="業種で絞り込み（株式）">
            <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-[minmax(180px,0.8fr)_minmax(240px,1fr)_minmax(280px,1.2fr)_auto]">
              <label className="flex min-w-0 flex-col gap-1 text-[11px] font-bold text-[var(--color-text-secondary)]">
                セクター
                <select
                  value={sector}
                  disabled={!sicClassificationEnabled}
                  onChange={(event) => {
                    setSector(event.target.value)
                    setIndustryGroup('')
                    setIndustry('')
                  }}
                  className="h-8 w-full min-w-0 border border-[var(--color-border-default)] px-2 text-[11px] font-bold disabled:cursor-not-allowed disabled:bg-[var(--color-surface-subtle)] disabled:opacity-60"
                >
                  <option value="">全て</option>
                  {sectorOptions.map((value) => <option key={value} value={value}>{value}</option>)}
                </select>
              </label>
              <label className="flex min-w-0 flex-col gap-1 text-[11px] font-bold text-[var(--color-text-secondary)]">
                業種グループ
                <select
                  value={industryGroup}
                  disabled={!sicClassificationEnabled}
                  onChange={(event) => {
                    setIndustryGroup(event.target.value)
                    setIndustry('')
                  }}
                  className="h-8 w-full min-w-0 border border-[var(--color-border-default)] px-2 text-[11px] font-bold disabled:cursor-not-allowed disabled:bg-[var(--color-surface-subtle)] disabled:opacity-60"
                >
                  <option value="">全て</option>
                  {industryGroupOptions.map((item) => (
                    <option key={item.code} value={item.code}>{item.code} {item.name}</option>
                  ))}
                </select>
              </label>
              <label className="flex min-w-0 flex-col gap-1 text-[11px] font-bold text-[var(--color-text-secondary)]">
                詳細産業
                <select
                  value={industry}
                  disabled={!sicClassificationEnabled}
                  onChange={(event) => setIndustry(event.target.value)}
                  className="h-8 w-full min-w-0 border border-[var(--color-border-default)] px-2 text-[11px] font-bold disabled:cursor-not-allowed disabled:bg-[var(--color-surface-subtle)] disabled:opacity-60"
                >
                  <option value="">全て</option>
                  {industryOptions.map((value) => <option key={value} value={value}>{value}</option>)}
                </select>
              </label>
              {(sector || industryGroup || industry) && (
                <div className="self-end">
                  <Chip active={false} onClick={() => {
                    setSector('')
                    setIndustryGroup('')
                    setIndustry('')
                  }}>
                    × クリア
                  </Chip>
                </div>
              )}
              {!sicClassificationEnabled && (
                <div className="border border-[var(--color-border-soft)] bg-[var(--color-surface-subtle)] px-2.5 py-2 text-[10px] font-bold text-[var(--color-text-tertiary)] md:col-span-2 xl:col-span-4">
                  セクター・業種グループ・詳細産業は米国株式のSEC SIC分類です。ETF・投資信託には適用されません。
                </div>
              )}
            </div>
          </Section>

          <Section step={3} label="資産種別・価格データ品質で絞り込み（任意）">
            <div className="flex flex-wrap gap-1.5">
              {[
                { value: '', label: '全ての資産' },
                { value: 'Stock', label: '株式' },
                { value: 'ETF', label: 'ETF' },
                { value: 'Mutual Fund', label: '投資信託' },
              ].map((option) => (
                <Chip
                  key={option.value || 'all'}
                  active={assetType === option.value}
                  onClick={() => {
                    const normalizedClassification = normalizeUsClassificationFilters({
                      assetType: option.value,
                      sector,
                      industryGroup,
                      industry,
                    })
                    setAssetType(normalizedClassification.assetType)
                    setSector(normalizedClassification.sector)
                    setIndustryGroup(normalizedClassification.industryGroup)
                    setIndustry(normalizedClassification.industry)
                  }}
                >
                  {option.label}
                </Chip>
              ))}
              <Chip active={quality === 'standard'} onClick={() => setQuality('standard')}>異常値を除外</Chip>
              <Chip active={quality === 'all'} onClick={() => setQuality('all')}>要確認データも表示</Chip>
            </div>
            <div className="mt-2 flex items-start gap-2 border border-[var(--color-border-soft)] bg-[var(--color-surface-subtle)] px-2.5 py-2">
              <CircleHelp size={14} className="mt-0.5 shrink-0 text-[var(--color-brand-700)]" aria-hidden="true" />
              <div className="min-w-0 text-[10px] font-semibold leading-5 text-[var(--color-text-secondary)]">
                <div className="font-black text-[var(--color-brand-900)]">
                  企業の良し悪しではなく、株価データの信頼性を選ぶ設定です。
                </div>
                <div>
                  {quality === 'standard'
                    ? '0.1ドル未満、出来高0（投資信託を除く）、異常な日次騰落、期間リターンの不連続、ワラント・ユニット・権利などの特殊証券記号を除外しています。'
                    : '異常値候補も検索対象に含めます。該当理由は「全列」表示の品質欄で確認できます。'}
                </div>
                <div>履歴200日未満の銘柄は除外せず、品質欄に注意表示します。</div>
              </div>
            </div>
          </Section>

          <Section step={4} label="出来高下限で絞り込み（任意）">
            <div className="flex flex-wrap gap-1.5">
              {VOLUME_OPTIONS.map((option) => <Chip key={option.value || 'all'} active={avgVolumeMin === option.value} onClick={() => setAvgVolumeMin(option.value)}>{option.label}</Chip>)}
            </div>
          </Section>

          <Section step={5} label="次回決算までで絞り込み・並び替え">
            <div className="border border-amber-200 bg-amber-50 px-3 py-2 text-[11px] font-bold text-amber-900">
              US決算予定データは現在未連携です。正式な外部データソース承認後に有効化します。推定日を確定情報として表示しません。
            </div>
          </Section>

          <Section step={6} label="200日移動平均線で絞り込み・並び替え（任意）">
            <div className="flex flex-wrap gap-1.5">
              <Chip active={!ma200Direction} onClick={() => setMa200Direction('')}>全て</Chip>
              <Chip active={ma200Direction === 'up'} onClick={() => setMa200Direction(ma200Direction === 'up' ? '' : 'up')}>上向き</Chip>
              <Chip active={ma200Direction === 'flat'} onClick={() => setMa200Direction(ma200Direction === 'flat' ? '' : 'flat')}>横ばい</Chip>
              <Chip active={ma200Direction === 'down'} onClick={() => setMa200Direction(ma200Direction === 'down' ? '' : 'down')}>下向き</Chip>
              <Chip active={!ma200Trend} onClick={() => setMa200Trend('')}>株価位置: 全て</Chip>
              <Chip active={ma200Trend === 'above'} onClick={() => setMa200Trend(ma200Trend === 'above' ? '' : 'above')}>200日線より上</Chip>
              <Chip active={ma200Trend === 'below'} onClick={() => setMa200Trend(ma200Trend === 'below' ? '' : 'below')}>200日線より下</Chip>
              <Chip active={sort === 'ma200Angle' && dir === 'desc'} onClick={() => { setSort('ma200Angle'); setDir('desc') }}>上向きが強い順</Chip>
              <Chip active={sort === 'ma200Angle' && dir === 'asc'} onClick={() => { setSort('ma200Angle'); setDir('asc') }}>下向きが強い順</Chip>
            </div>
          </Section>

          <Section step={7} label="時価総額で絞り込み（任意）">
            <div className="flex flex-wrap gap-1.5">
              {MCAP_BINS.map((bin) => <Chip key={bin.key || 'all'} active={marketCapBin === bin.key} disabled={Boolean(bin.key) && !hasMarketCapData} onClick={() => setMarketCapBin(bin.key)}>{bin.label}</Chip>)}
            </div>
            {!hasMarketCapData && rows.length > 0 && (
              <div className="mt-2 text-[10px] font-bold text-amber-800">
                発行済株式数が未連携のため、時価総額フィルターは無効です。価格・ステージ等の検索には影響しません。
              </div>
            )}
          </Section>

          <Section step={8} label="短期チェックで絞り込み（任意）">
            <div className="flex flex-wrap gap-1.5">
              <Chip active={!shortTermCheck} onClick={() => setShortTermCheck('')}>全て</Chip>
              {SHORT_TERM_OPTIONS.map((value) => <Chip key={value} active={shortTermCheck === value} onClick={() => setShortTermCheck(shortTermCheck === value ? '' : value)}>{value}</Chip>)}
            </div>
          </Section>

          <Section step={9} label="Physical Momentumで絞り込み（任意）">
            <div className="grid gap-2 sm:grid-cols-3">
              <NumberFilter label="PMS >=" value={pmsMin} onChange={setPmsMin} />
              <NumberFilter label="PFS >=" value={pfsMin} onChange={setPfsMin} />
              <NumberFilter label="PES >=" value={pesMin} onChange={setPesMin} />
            </div>
            <div className="mt-2 flex flex-wrap gap-1.5">
              <Chip active={!physicalStatus} onClick={() => setPhysicalStatus('')}>物理状態: 全て</Chip>
              {PHYSICAL_STATUS_OPTIONS.map((value) => <Chip key={value} active={physicalStatus === value} onClick={() => setPhysicalStatus(physicalStatus === value ? '' : value)}>{value}</Chip>)}
            </div>
            <div className="mt-2 flex flex-wrap gap-1.5">
              <Chip active={accelerationPositive} onClick={() => setAccelerationPositive(!accelerationPositive)}>Acceleration &gt; 0</Chip>
              <Chip active={forcePositive} onClick={() => setForcePositive(!forcePositive)}>Force &gt; 0</Chip>
              <Chip active={stage23Candidate} onClick={() => setStage23Candidate(!stage23Candidate)}>Stage2→3候補</Chip>
            </div>
          </Section>

          <Section step={10} label="HEXステージで絞り込み（任意 / 複数系統 AND）">
            <div className="mb-2 flex justify-end">
              <Chip active={false} disabled={!hasAnyStage} onClick={() => setStages({})}>× 全てクリア</Chip>
            </div>
            <div className="grid gap-1.5 sm:grid-cols-2 xl:grid-cols-3">
              {AXES.map((axis) => (
                <AxisCard
                  key={axis.key}
                  axis={axis}
                  selected={stages[axis.key] ?? []}
                  onToggle={(stage) => setStages((current) => {
                    const next = { ...current }
                    const selectedStages = next[axis.key] ?? []
                    const values = selectedStages.includes(stage)
                      ? selectedStages.filter((value) => value !== stage)
                      : [...selectedStages, stage].sort()
                    if (values.length > 0) next[axis.key] = values
                    else delete next[axis.key]
                    return next
                  })}
                  onClear={() => setStages((current) => {
                    const next = { ...current }
                    delete next[axis.key]
                    return next
                  })}
                />
              ))}
            </div>
            {hasAnyStage && <div className="mt-2 border border-blue-200 bg-blue-50 px-3 py-2 text-[11px] font-bold text-blue-900">同じ軸の選択はOR、異なる軸はANDで判定します。</div>}
          </Section>
        </div>
      )}

      <div className="max-h-[70vh] overflow-auto">
        <table className={`data-table w-full border-collapse text-left text-[12px] ${columnMode === 'all' ? 'min-w-[1540px]' : 'min-w-[1080px]'}`}>
          <thead>
            <tr className="border-b border-[var(--color-border-default)] bg-white text-[11px] font-bold text-[var(--color-text-secondary)]">
              <th className="sticky left-0 z-[4] w-9 bg-white px-2 py-2">
                <span className="sr-only">比較選択</span>
              </th>
              <th className="sticky left-9 z-[3] bg-white px-3 py-2">銘柄</th>
              {columnMode === 'all' && <th className="px-3 py-2">取引所</th>}
              <th className="px-3 py-2">業種</th>
              <th className="px-3 py-2">6桁</th>
              <th className="px-3 py-2">短期チェック</th>
              <th className="px-3 py-2 text-right">株価</th>
              <th className="px-3 py-2 text-right">騰落率</th>
              <th className="px-3 py-2 text-right">1か月</th>
              {columnMode === 'all' && <th className="px-3 py-2 text-right">5日 / 3か月 / 6か月</th>}
              <th className="px-3 py-2 text-right">200日線</th>
              <th className="px-3 py-2 text-right">出来高</th>
              {columnMode === 'all' && <th className="px-3 py-2 text-right">20日平均</th>}
              <th className="px-3 py-2 text-right">PMS/PFS/PES</th>
              {columnMode === 'all' && <th className="px-3 py-2 text-right">時価総額</th>}
              {columnMode === 'all' && <th className="px-3 py-2">品質</th>}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.ticker} className={`border-b border-[var(--color-border-subtle)] ${selected.has(row.ticker) ? 'bg-blue-50/60' : ''}`}>
                <td className="sticky left-0 z-[2] bg-inherit px-2 py-2">
                  <input
                    type="checkbox"
                    checked={selected.has(row.ticker)}
                    onChange={() => toggleSelected(row.ticker)}
                    aria-label={`${row.ticker}を比較対象にする`}
                    className="h-4 w-4 accent-[var(--color-brand-700)]"
                  />
                </td>
                <td className="sticky left-9 z-[1] bg-inherit px-3 py-2">
                  <Link href={`/us/stock/${row.ticker}`} className="font-bold text-[var(--color-brand-900)] hover:text-[var(--color-market-red)]">
                    {row.ticker}{row.name && row.name.trim().toUpperCase() !== row.ticker.trim().toUpperCase() ? ` ${row.name}` : ''}
                  </Link>
                  {row.asset_type && row.asset_type !== 'Stock' && (
                    <div className="mt-0.5 text-[9px] font-black text-[var(--color-text-tertiary)]">
                      {row.asset_type === 'Mutual Fund' ? '投資信託' : row.asset_type}
                    </div>
                  )}
                </td>
                {columnMode === 'all' && (
                  <td className="px-3 py-2 font-semibold">
                    <div>{row.exchange ?? '-'}</div>
                  </td>
                )}
                <td className="px-3 py-2 font-semibold">
                  <div>{row.sector ?? '-'}</div>
                  {row.industry && <div className="mt-0.5 text-[10px] text-[var(--color-text-tertiary)]">{row.industry}</div>}
                </td>
                <td className="px-3 py-2"><StageCode code={row.stage_code} /></td>
                <td className="px-3 py-2">
                  <div className={`inline-flex items-center rounded-full border px-2 py-1 text-[10px] font-black ${shortTermClass(row.shortTermCheckLabel)}`}>
                    {row.shortTermCheckLabel ?? '中立'}
                    <span className="ml-1 font-mono opacity-80">
                      / {formatShortTermStrength(row.shortTermCheckLabel, row.shortTermCheckScore)}
                    </span>
                  </div>
                  {row.shortTermCheckReasons?.[0] && (
                    <div className="mt-1 max-w-[180px] truncate text-[10px] font-bold text-[var(--color-text-tertiary)]">
                      {row.shortTermCheckReasons.slice(0, 2).join(' / ')}
                    </div>
                  )}
                </td>
                <td className="px-3 py-2 text-right font-bold">{fmtMoney(row.price)}</td>
                <td className={`px-3 py-2 text-right font-bold ${(row.change_pct ?? 0) >= 0 ? 'text-red-700' : 'text-blue-700'}`}>{fmtPct(row.change_pct)}</td>
                <td className={`px-3 py-2 text-right font-bold ${(row.return_20d ?? 0) >= 0 ? 'text-red-700' : 'text-blue-700'}`}>{fmtPct(row.return_20d)}</td>
                {columnMode === 'all' && (
                  <td className="px-3 py-2 text-right font-mono text-[10px] font-semibold">
                    {fmtPct(row.return_5d)} / {fmtPct(row.return_60d)} / {fmtPct(row.return_120d)}
                  </td>
                )}
                <td className={`px-3 py-2 text-right font-bold ${(row.ma_200_gap_pct ?? 0) >= 0 ? 'text-red-700' : 'text-blue-700'}`}>
                  {fmtPct(row.ma_200_gap_pct)}
                  {row.ma_200_observations != null && row.ma_200_observations < 200 && (
                    <div className="text-[9px] text-amber-700">{row.ma_200_observations}日</div>
                  )}
                </td>
                <td className="px-3 py-2 text-right font-semibold">{row.volume?.toLocaleString('en-US') ?? '-'}</td>
                {columnMode === 'all' && <td className="px-3 py-2 text-right font-semibold">{row.avg_volume_20 == null ? '-' : Math.round(row.avg_volume_20).toLocaleString('en-US')}</td>}
                <td className="px-3 py-2 text-right font-semibold">
                  <span className="font-bold text-[var(--color-brand-900)]">{fmtScore(row.physical_momentum_score)}</span>
                  <span className="mx-1 text-[var(--color-text-tertiary)]">/</span>
                  {fmtScore(row.physical_force_score)}
                  <span className="mx-1 text-[var(--color-text-tertiary)]">/</span>
                  {fmtScore(row.physical_energy_score)}
                </td>
                {columnMode === 'all' && <td className="px-3 py-2 text-right font-semibold">{fmtCap(row.market_cap)}</td>}
                {columnMode === 'all' && (
                  <td className="px-3 py-2">
                    {row.qualityFlags?.length
                      ? row.qualityFlags.map((flag) => (
                          <span key={flag} className="mr-1 inline-flex border border-amber-200 bg-amber-50 px-1.5 py-0.5 text-[9px] font-black text-amber-800">
                            {flag}
                          </span>
                        ))
                      : <span className="text-[10px] font-bold text-emerald-700">標準</span>}
                  </td>
                )}
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={columnMode === 'all' ? 16 : 11} className="px-3 py-8 text-center text-[12px] font-bold text-[var(--color-text-tertiary)]">
                  {loading
                    ? 'USデータを確認しています...'
                    : displayMessage(message, hasScreeningConditions)}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {hasMore && (
        <div className="flex flex-wrap items-center justify-center gap-3 border-t border-[var(--color-border-default)] bg-[var(--color-surface-subtle)] px-4 py-3">
          {resultLimit < 1000 ? (
            <button
              type="button"
              onClick={() => setResultLimit(resultLimit < 500 ? 500 : 1000)}
              className="inline-flex h-8 items-center border border-[var(--color-brand-700)] bg-white px-3 text-[11px] font-black text-[var(--color-brand-800)] hover:bg-blue-50"
            >
              {resultLimit < 500 ? '500件まで表示' : '1,000件まで表示'}
            </button>
          ) : (
            <span className="text-[11px] font-bold text-[var(--color-text-tertiary)]">
              1,000件を表示中です。条件を追加すると対象を絞り込めます。
            </span>
          )}
        </div>
      )}
      </div>
    </div>
  )
}

function Section({ step, label, children }: { step: number; label: string; children: React.ReactNode }) {
  return (
    <section>
      <div className="mb-2 flex items-center gap-2">
        <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-[var(--color-brand-700)] text-[11px] font-black text-white">
          {step}
        </span>
        <h2 className="text-[12px] font-bold text-[var(--color-text-primary)]">{label}</h2>
      </div>
      <div className="pl-7">{children}</div>
    </section>
  )
}

function Chip({
  active,
  disabled,
  onClick,
  children,
}: {
  active: boolean
  disabled?: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={`min-h-7 border px-2.5 py-1 text-[11px] font-bold transition-colors ${
        active
          ? 'border-[var(--color-brand-700)] bg-[var(--color-brand-700)] text-white'
          : 'border-[var(--color-border-default)] bg-white text-[var(--color-text-secondary)] hover:border-[var(--color-brand-500)]'
      } disabled:cursor-not-allowed disabled:opacity-40`}
    >
      {children}
    </button>
  )
}

function NumberFilter({
  label,
  value,
  onChange,
}: {
  label: string
  value: string
  onChange: (value: string) => void
}) {
  return (
    <label className="flex items-center gap-2 text-[11px] font-bold text-[var(--color-text-secondary)]">
      {label}
      <input
        type="number"
        step="0.1"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder="例: 1.0"
        className="h-8 min-w-0 flex-1 border border-[var(--color-border-default)] px-2 text-[12px] font-semibold"
      />
    </label>
  )
}

function AxisCard({
  axis,
  selected,
  onToggle,
  onClear,
}: {
  axis: { key: AxisKey; label: string; color: string }
  selected: number[]
  onToggle: (stage: number) => void
  onClear: () => void
}) {
  return (
    <div className="flex min-w-0 items-center gap-1.5 border border-[var(--color-border-default)] bg-white p-1.5">
      <div className="flex min-w-[58px] items-center gap-1.5">
        <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: axis.color }} />
        <span className="whitespace-nowrap text-[12px] font-bold">{axis.label}</span>
      </div>
      <div className="flex min-w-0 flex-1 gap-0.5">
        {[1, 2, 3, 4, 5, 6].map((stage) => {
          const active = selected.includes(stage)
          return (
            <button
              key={stage}
              type="button"
              onClick={() => onToggle(stage)}
              className="h-7 min-w-0 flex-1 border text-[11px] font-black"
              style={{
                background: active ? axis.color : 'var(--color-surface-subtle)',
                color: active ? '#fff' : 'var(--color-text-secondary)',
                borderColor: active ? axis.color : 'var(--color-border-default)',
              }}
              aria-pressed={active}
              aria-label={`${axis.label} ステージ${stage}`}
            >
              {stage}
            </button>
          )
        })}
      </div>
      {selected.length > 0 && (
        <button type="button" onClick={onClear} className="h-7 border border-[var(--color-border-default)] px-1.5 text-[10px] font-bold text-[var(--color-text-tertiary)]" aria-label={`${axis.label}をクリア`}>
          ×
        </button>
      )}
    </div>
  )
}
