// app/screener/page.tsx
'use client'

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import { toTvSymbol, buildTvWatchlistText } from '@/lib/tv-format'
import { WatchlistButton } from '@/components/ui/WatchlistButton'
import { StageDots } from '@/components/ui/StageDots'
import { MarketDateCalendar } from '@/components/ui/MarketDateCalendar'
import { getUniverseFilterMeta, parseUniverseFilter, UNIVERSE_FILTER_PARAM } from '@/lib/market-universe'
import { SHORT_TERM_CHECK_LABELS, type ShortTermCheckLabel } from '@/lib/short-term-check'
import type { PhysicsStatus } from '@/lib/ml/physics-analysis'

type Market = 'JP'
type AxisKey = 'daily_a' | 'daily_b' | 'weekly_a' | 'weekly_b' | 'monthly_a' | 'monthly_b'

// 時価総額レンジ（円）。.minは含む / .maxは含まない。億単位の閾値で設計。
const MCAP_BINS: { label: string; min: number; max: number }[] = [
  { label: '〜100億',     min: 0,           max: 1e10 },
  { label: '100〜500億',  min: 1e10,        max: 5e10 },
  { label: '500〜2,000億', min: 5e10,        max: 2e11 },
  { label: '2,000億〜1兆', min: 2e11,        max: 1e12 },
  { label: '1兆〜5兆',    min: 1e12,        max: 5e12 },
  { label: '5兆〜',       min: 5e12,        max: Number.POSITIVE_INFINITY },
]

const MARGIN_FILTER_ORDER = ['貸借', '信用', 'その他', '未設定']
const PHYSICAL_STATUS_LABELS: PhysicsStatus[] = [
  '上昇加速',
  '上昇継続',
  '押し目形成',
  '反発準備',
  '過熱注意',
  '失速警戒',
  '下落加速',
  '見送り',
  '算出待ち',
]
const PHYSICAL_STATUS_HORIZONS = [5, 10, 20, 40, 60, 90] as const
type PhysicalStatusHorizon = typeof PHYSICAL_STATUS_HORIZONS[number]

const AXES: { key: AxisKey; label: string; color: string }[] = [
  { key: 'daily_a',   label: '日足 A', color: '#ef4444' },
  { key: 'weekly_a',  label: '週足 A', color: '#22c55e' },
  { key: 'monthly_a', label: '月足 A', color: '#a855f7' },
  { key: 'daily_b',   label: '日足 B', color: '#f59e0b' },
  { key: 'weekly_b',  label: '週足 B', color: '#3b82f6' },
  { key: 'monthly_b', label: '月足 B', color: '#ec4899' },
]

interface StockRow {
  ticker: string
  name: string
  market: Market
  marketSegment: string
  marginType?: string
  sectorLarge: string
  sector33?: string | null
  sector17Name?: string | null
  sector33Name?: string | null
  price: number | null
  currency?: string | null
  changePercent: number | null
  changePercentWeek?: number
  changePercentMonth?: number
  perfPct3m?: number | null
  perfPct6m?: number | null
  perfPctYtd?: number | null
  volume: number | null
  avgVolume10d?: number | null
  avgVolume30d?: number | null
  marketCap?: number | null
  marketCapCurrency?: string | null
  marketCapStatus?: 'calculated' | 'not_applicable' | 'shares_missing' | 'price_missing'
  sma5Angle?: number | null
  sma25Angle?: number | null
  sma75Angle?: number | null
  sma200Angle?: number | null
  earningsLastDate?: string | null
  earningsLastDateKind?: 'reported' | 'not_applicable' | 'not_collected' | 'unverified'
  earningsLastDateSource?: string | null
  earningsLastFiscalPeriod?: string | null
  earningsNextDate?: string | null
  earningsNextDateKind?: 'confirmed' | 'estimated' | 'not_announced' | 'not_applicable' | 'no_history'
  earningsNextDateSource?: string | null
  earningsNextFiscalPeriod?: string | null
  daily_a_stage: number | null
  daily_b_stage: number | null
  weekly_a_stage: number | null
  weekly_b_stage: number | null
  monthly_a_stage: number | null
  monthly_b_stage: number | null
  physicalMomentumScore?: number | null
  physicalForceScore?: number | null
  physicalEnergyScore?: number | null
  physicalMomentumRank?: number | null
  physicalMomentumTrend?: 'rising' | 'falling' | 'flat' | null
  physicalAcceleration?: number | null
  physicalForce?: number | null
  physicalStatusLabel: PhysicsStatus
  physicalStatusScore?: number | null
  physicalStatusSourceDate?: string | null
  physicalStatusTargetDirection?: 'up' | 'down' | 'wait' | null
  physicalStatusHitRate?: number | null
  physicalStatusBaseRate?: number | null
  physicalStatusLift?: number | null
  physicalStatusConfidence?: number | null
  physicalStatusSampleCount?: number | null
  physicalStatusHorizonDays?: number | null
  physicalStatusEvaluationDate?: string | null
  shortTermCheckLabel: ShortTermCheckLabel
  shortTermCheckScore: number
  shortTermCheckReasons?: string[]
  shortTermCheckMlText?: string
}

type SortKey =
  | 'ticker'
  | 'marginType'
  | 'marketSegment'
  | 'sector33'
  | 'sectorLarge'
  | 'name'
  | 'price'
  | 'currency'
  | 'changePercent'
  | 'changePercentWeek'
  | 'changePercentMonth'
  | 'perfPct3m'
  | 'perfPct6m'
  | 'perfPctYtd'
  | 'volume'
  | 'avgVolume10d'
  | 'avgVolume30d'
  | 'marketCap'
  | 'marketCapCurrency'
  | 'sma5Angle'
  | 'sma25Angle'
  | 'sma75Angle'
  | 'sma200Angle'
  | 'physicalMomentumScore'
  | 'physicalForceScore'
  | 'physicalEnergyScore'
  | 'physicalMomentumRank'
  | 'physicalStatusScore'
  | 'physicalStatusConfidence'
  | 'physicalStatusHitRate'
  | 'physicalStatusLift'
  | 'shortTermCheckScore'
  | 'earningsLastDate'
  | 'earningsLastElapsedDays'
  | 'earningsNextDate'
  | 'earningsNextBusinessDays'

interface SortState {
  key: SortKey
  dir: 'asc' | 'desc'
}

const SORT_KEY_VALUES: readonly SortKey[] = [
  'ticker',
  'marginType',
  'marketSegment',
  'sector33',
  'sectorLarge',
  'name',
  'price',
  'currency',
  'changePercent',
  'changePercentWeek',
  'changePercentMonth',
  'perfPct3m',
  'perfPct6m',
  'perfPctYtd',
  'volume',
  'avgVolume10d',
  'avgVolume30d',
  'marketCap',
  'marketCapCurrency',
  'sma5Angle',
  'sma25Angle',
  'sma75Angle',
  'sma200Angle',
  'physicalMomentumScore',
  'physicalForceScore',
  'physicalEnergyScore',
  'physicalMomentumRank',
  'physicalStatusScore',
  'physicalStatusConfidence',
  'physicalStatusHitRate',
  'physicalStatusLift',
  'shortTermCheckScore',
  'earningsLastDate',
  'earningsLastElapsedDays',
  'earningsNextDate',
  'earningsNextBusinessDays',
]

function isSortKey(value: string | null): value is SortKey {
  return SORT_KEY_VALUES.includes(value as SortKey)
}

function parsePhysicalStatusHorizon(value: string | null): PhysicalStatusHorizon {
  const parsed = Number(value)
  return PHYSICAL_STATUS_HORIZONS.includes(parsed as PhysicalStatusHorizon)
    ? parsed as PhysicalStatusHorizon
    : 20
}

function initialSortState(searchParams: ReturnType<typeof useSearchParams>): SortState {
  const requested = searchParams.get('sort')
  if (isSortKey(requested)) {
    return {
      key: requested,
      dir: searchParams.get('dir') === 'asc' ? 'asc' : 'desc',
    }
  }
  return { key: 'marketCap', dir: 'desc' }
}

function parseUrlLimit(value: string | null): number | null {
  if (!value) return null
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed <= 0) return null
  return Math.min(5000, Math.max(1, Math.floor(parsed)))
}

interface AvailableDate {
  date: string
  tickers: number
}

export default function ScreenerPage() {
  const searchParams = useSearchParams()
  const activeUniverse = parseUniverseFilter(searchParams.get(UNIVERSE_FILTER_PARAM))
  const activeUniverseMeta = getUniverseFilterMeta(activeUniverse)
  const requestedLimit = parseUrlLimit(searchParams.get('limit'))
  const [stages, setStages] = useState<Partial<Record<AxisKey, number[]>>>({})
  const [results, setResults] = useState<StockRow[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [universe, setUniverse] = useState(0)
  const [cached, setCached] = useState(false)
  const [snapshotDate, setSnapshotDate] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [sort, setSort] = useState<SortState | null>(() => initialSortState(searchParams))
  const [copiedTicker, setCopiedTicker] = useState<string | null>(null)
  const [availableDates, setAvailableDates] = useState<AvailableDate[]>([])
  const [selectedDate, setSelectedDate] = useState<string | null>(null) // null = 最新
  const [selectedSectorLarge, setSelectedSectorLarge] = useState<string>('')
  const [selectedSector33, setSelectedSector33] = useState<string>('')
  const [selectedMarginType, setSelectedMarginType] = useState<string>('')
  const [selectedShortTermCheck, setSelectedShortTermCheck] = useState<string>('')
  const [selectedPhysicalStatus, setSelectedPhysicalStatus] = useState<string>(() => searchParams.get('physicalStatus') ?? '')
  const [selectedMcapBins, setSelectedMcapBins] = useState<Set<number>>(new Set())
  const [pmsMin, setPmsMin] = useState(() => searchParams.get('pmsMin') ?? '')
  const [pfsMin, setPfsMin] = useState(() => searchParams.get('pfsMin') ?? '')
  const [pesMin, setPesMin] = useState(() => searchParams.get('pesMin') ?? '')
  const [accelerationPositive, setAccelerationPositive] = useState(() => searchParams.get('accelerationPositive') === '1')
  const [forcePositive, setForcePositive] = useState(() => searchParams.get('forcePositive') === '1')
  const [stage23Candidate, setStage23Candidate] = useState(() => searchParams.get('stage23Candidate') === '1')
  const [pmsTrend, setPmsTrend] = useState(() => searchParams.get('pmsTrend') ?? '')
  const [selectedPhysicalStatusHorizon, setSelectedPhysicalStatusHorizon] = useState<PhysicalStatusHorizon>(() => (
    parsePhysicalStatusHorizon(searchParams.get('physicalStatusHorizon'))
  ))
  const referenceDate = snapshotDate ?? selectedDate
  const tradingDates = useMemo(
    () => availableDates.map((item) => item.date).filter(Boolean).sort(),
    [availableDates],
  )

  const hasAnyStage = Object.values(stages).some((v) => v && v.length > 0)

  // J-Quants 由来のスナップショット日付リストの取得
  useEffect(() => {
    let cancelled = false
    fetch('/api/hex/available-dates?limit=10000', { cache: 'no-store' })
      .then((r) => r.json())
      .then((d) => {
        if (cancelled) return
        setAvailableDates(d.dates ?? [])
      })
      .catch(() => { /* 無視 */ })
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError('')
    const params = new URLSearchParams({ market: 'JP' })
    if (activeUniverse) params.set(UNIVERSE_FILTER_PARAM, activeUniverse)
    if (selectedDate) params.set('date', selectedDate)
    if (pmsMin.trim()) params.set('pmsMin', pmsMin.trim())
    if (pfsMin.trim()) params.set('pfsMin', pfsMin.trim())
    if (pesMin.trim()) params.set('pesMin', pesMin.trim())
    if (accelerationPositive) params.set('accelerationPositive', '1')
    if (forcePositive) params.set('forcePositive', '1')
    if (stage23Candidate) params.set('stage23Candidate', '1')
    if (pmsTrend) params.set('pmsTrend', pmsTrend)
    if (requestedLimit != null) params.set('limit', String(requestedLimit))
    params.set('physicalStatusHorizon', String(selectedPhysicalStatusHorizon))
    for (const [k, v] of Object.entries(stages)) {
      if (v && v.length > 0) params.set(k, v.join(','))
    }

    fetch(`/api/screener?${params}`, { cache: 'no-store' })
      .then((r) => r.json())
      .then((d) => {
        if (cancelled) return
        if (d.error) throw new Error(d.error)
        setResults(d.results ?? [])
        setUniverse(d.universe ?? 0)
        setCached(d.cached)
        setSnapshotDate(d.date ?? null)
        setNotice(d.notice ?? null)
        setLoading(false)
      })
      .catch((e) => {
        if (!cancelled) {
          setError((e as Error).message)
          setLoading(false)
        }
      })
    return () => { cancelled = true }
  }, [stages, selectedDate, activeUniverse, pmsMin, pfsMin, pesMin, accelerationPositive, forcePositive, stage23Candidate, pmsTrend, selectedPhysicalStatusHorizon, requestedLimit])

  const filterText = useMemo(() => {
    const parts: string[] = []
    for (const ax of AXES) {
      const sel = stages[ax.key]
      if (sel && sel.length > 0) {
        parts.push(`${ax.label} ∈ {${[...sel].sort().join(',')}}`)
      }
    }
    return parts.join(' AND ')
  }, [stages])

  // 業種・時価総額のクライアントサイド絞り込み
  const filteredResults = useMemo(() => {
    return results.filter((r) => {
      if (selectedSectorLarge && r.sectorLarge !== selectedSectorLarge) return false
      if (selectedSector33 && (r.sector33 ?? r.sector33Name) !== selectedSector33) return false
      if (selectedMarginType && (r.marginType ?? '未設定') !== selectedMarginType) return false
      if (selectedShortTermCheck && r.shortTermCheckLabel !== selectedShortTermCheck) return false
      if (selectedPhysicalStatus && r.physicalStatusLabel !== selectedPhysicalStatus) return false
      if (selectedMcapBins.size > 0) {
        const cap = r.marketCap ?? -1
        const matched = Array.from(selectedMcapBins).some((idx) => {
          const bin = MCAP_BINS[idx]
          if (!bin) return false
          return cap >= bin.min && cap < bin.max
        })
        if (!matched) return false
      }
      return true
    })
  }, [results, selectedSectorLarge, selectedSector33, selectedMarginType, selectedShortTermCheck, selectedPhysicalStatus, selectedMcapBins])

  const shortTermOptions = useMemo(() => {
    const counts = new Map<string, number>()
    for (const r of results) {
      counts.set(r.shortTermCheckLabel, (counts.get(r.shortTermCheckLabel) ?? 0) + 1)
    }
    return SHORT_TERM_CHECK_LABELS.map((label) => [label, counts.get(label) ?? 0] as const)
  }, [results])

  const physicalStatusOptions = useMemo(() => {
    const counts = new Map<string, number>()
    for (const r of results) {
      counts.set(r.physicalStatusLabel, (counts.get(r.physicalStatusLabel) ?? 0) + 1)
    }
    return PHYSICAL_STATUS_LABELS.map((label) => [label, counts.get(label) ?? 0] as const)
  }, [results])

  const marginOptions = useMemo(() => {
    const counts = new Map<string, number>()
    for (const r of results) {
      const key = r.marginType?.trim() || '未設定'
      counts.set(key, (counts.get(key) ?? 0) + 1)
    }
    return Array.from(counts.entries())
      .sort(([a], [b]) => {
        const ai = MARGIN_FILTER_ORDER.indexOf(a)
        const bi = MARGIN_FILTER_ORDER.indexOf(b)
        if (ai !== -1 || bi !== -1) return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi)
        return a.localeCompare(b, 'ja')
      })
  }, [results])

  // セクターのドロップダウン候補
  const sectorOptions = useMemo(() => {
    const large: Record<string, number> = {}
    const sector33: Record<string, { count: number; large: string }> = {}
    for (const r of results) {
      const l = r.sectorLarge || '（未分類）'
      large[l] = (large[l] ?? 0) + 1
      const s33 = r.sector33 ?? r.sector33Name
      if (s33) {
        const cur = sector33[s33] ?? { count: 0, large: l }
        cur.count++
        cur.large = l
        sector33[s33] = cur
      }
    }
    const largeArr = Object.entries(large).sort((a, b) => b[1] - a[1])
    // 大分類が選ばれている場合は、小分類はその配下のみ
    const sector33Arr = Object.entries(sector33)
      .filter(([, v]) => !selectedSectorLarge || v.large === selectedSectorLarge)
      .sort((a, b) => b[1].count - a[1].count)
    return { largeArr, sector33Arr, sector33Map: sector33 }
  }, [results, selectedSectorLarge])

  const sortedResults = useMemo(() => {
    if (!sort) return filteredResults
    const copy = [...filteredResults]
    const dir = sort.dir === 'asc' ? 1 : -1
    copy.sort((a, b) => {
      const av = sortValue(a, sort.key, referenceDate, tradingDates)
      const bv = sortValue(b, sort.key, referenceDate, tradingDates)
      // null / undefined は常に末尾
      if (av == null && bv == null) return 0
      if (av == null) return 1
      if (bv == null) return -1
      if (typeof av === 'number' && typeof bv === 'number') {
        return (av - bv) * dir
      }
      return String(av).localeCompare(String(bv), 'ja') * dir
    })
    return copy
  }, [filteredResults, sort, referenceDate, tradingDates])
  const displayLimit = requestedLimit ?? 500
  const displayedResults = useMemo(() => sortedResults.slice(0, Math.min(500, displayLimit)), [sortedResults, displayLimit])
  const marketCapCoverage = useMemo(() => {
    const calculated = filteredResults.filter((r) => r.marketCap != null && r.marketCap > 0).length
    const notApplicable = filteredResults.filter((r) => r.marketCapStatus === 'not_applicable').length
    const missing = filteredResults.length - calculated - notApplicable
    return { calculated, notApplicable, missing }
  }, [filteredResults])

  function toggleSort(key: SortKey) {
    setSort((prev) => {
      if (!prev || prev.key !== key) return { key, dir: 'desc' }
      if (prev.dir === 'desc') return { key, dir: 'asc' }
      return null
    })
  }

  async function copyTvSymbol(ticker: string, ms: string) {
    const sym = toTvSymbol(ticker, ms)
    try {
      await navigator.clipboard.writeText(sym)
      setCopiedTicker(ticker)
      setTimeout(() => setCopiedTicker((c) => (c === ticker ? null : c)), 1200)
    } catch (e) {
      console.error('clipboard write failed', e)
    }
  }

  function downloadTvWatchlist() {
    const symbols = sortedResults.map((r) => toTvSymbol(r.ticker, r.marketSegment))
    const today = new Date().toISOString().split('T')[0]
    const sectionName = `Screener_JP_${today}`
    const text = buildTvWatchlistText(symbols, sectionName)
    const blob = new Blob([text], { type: 'text/plain;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${sectionName}.txt`
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(url)
  }

  return (
    <div className="sb-page">
      <div className="sb-page-title">
        <h1>スクリーナー（マルチ軸ステージフィルタ）</h1>
        <p>J-Quants由来の最新スナップショットを表示。HEXステージで絞り込み（複数系統は AND）</p>
      </div>

      <div style={{ padding: '14px 16px 16px', display: 'flex', flexDirection: 'column', gap: '14px' }}>
      {/* 業種で絞り込み */}
      <Section step={1} label="業種で絞り込み（任意）">
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap' }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '11px', color: 'var(--text-muted)' }}>
            17業種
            <select
              value={selectedSectorLarge}
              onChange={(e) => {
                setSelectedSectorLarge(e.target.value)
                setSelectedSector33('') // 17業種が変わったら33業種はリセット
              }}
              style={mcSelectStyle}
            >
              <option value="">全て（{results.length}）</option>
              {sectorOptions.largeArr.map(([cat, n]) => (
                <option key={cat} value={cat}>{cat}（{n}）</option>
              ))}
            </select>
          </label>

          <label style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '11px', color: 'var(--text-muted)' }}>
            33業種
            <select
              value={selectedSector33}
              onChange={(e) => {
                const v = e.target.value
                setSelectedSector33(v)
                // 33業種を選んだら、対応する17業種も常に上書きする。
                // 「全て」を選んだ場合は大分類はそのまま。
                if (v) {
                  const owner = sectorOptions.sector33Map[v]?.large
                  if (owner && owner !== '（未分類）') setSelectedSectorLarge(owner)
                }
              }}
              style={mcSelectStyle}
            >
              <option value="">全て</option>
              {sectorOptions.sector33Arr.map(([cat, v]) => (
                <option key={cat} value={cat}>{cat}（{v.count}）</option>
              ))}
            </select>
          </label>

          {(selectedSectorLarge || selectedSector33) && (
            <button
              onClick={() => { setSelectedSectorLarge(''); setSelectedSector33('') }}
              style={mcChipStyle(false)}
            >
              × クリア
            </button>
          )}
        </div>
      </Section>

      {/* 貸借/信用で絞り込み */}
      <Section step={2} label="貸借/信用で絞り込み（任意）">
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
          <button
            onClick={() => setSelectedMarginType('')}
            style={mcChipStyle(selectedMarginType === '')}
          >
            全て（{results.length.toLocaleString('ja-JP')}）
          </button>
          {marginOptions.map(([type, count]) => (
            <button
              key={type}
              onClick={() => setSelectedMarginType((current) => current === type ? '' : type)}
              style={mcChipStyle(selectedMarginType === type)}
            >
              {type}（{count.toLocaleString('ja-JP')}）
            </button>
          ))}
        </div>
      </Section>

      {/* 時価総額で絞り込み */}
      <Section step={3} label="時価総額で絞り込み（任意 / 複数選択可）">
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
          {MCAP_BINS.map((bin, idx) => {
            const active = selectedMcapBins.has(idx)
            return (
              <button
                key={bin.label}
                onClick={() => setSelectedMcapBins((prev) => {
                  const next = new Set(prev)
                  if (next.has(idx)) next.delete(idx)
                  else next.add(idx)
                  return next
                })}
                style={mcChipStyle(active)}
              >
                {bin.label}
              </button>
            )
          })}
          {selectedMcapBins.size > 0 && (
            <button onClick={() => setSelectedMcapBins(new Set())} style={mcChipStyle(false)}>
              × クリア
            </button>
          )}
        </div>
      </Section>

      <Section step={4} label="短期チェックで絞り込み（任意）">
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
          <button
            onClick={() => setSelectedShortTermCheck('')}
            style={mcChipStyle(selectedShortTermCheck === '')}
          >
            全て（{results.length.toLocaleString('ja-JP')}）
          </button>
          {shortTermOptions.map(([label, count]) => (
            <button
              key={label}
              onClick={() => setSelectedShortTermCheck((current) => current === label ? '' : label)}
              style={shortTermFilterChipStyle(label, selectedShortTermCheck === label)}
            >
              {label}（{count.toLocaleString('ja-JP')}）
            </button>
          ))}
        </div>
      </Section>

      {/* Physical Momentumで絞り込み */}
      <Section step={5} label="Physical Momentumで絞り込み（任意）">
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: '8px', alignItems: 'end' }}>
          <MomentumNumberInput label="PMS >=" value={pmsMin} onChange={setPmsMin} placeholder="例: 1.0" />
          <MomentumNumberInput label="PFS >=" value={pfsMin} onChange={setPfsMin} placeholder="例: 0.8" />
          <MomentumNumberInput label="PES >=" value={pesMin} onChange={setPesMin} placeholder="例: 0.8" />
          <label style={momentumSelectLabelStyle}>
            PMS方向
            <select value={pmsTrend} onChange={(event) => setPmsTrend(event.target.value)} style={mcSelectStyle}>
              <option value="">全て</option>
              <option value="rising">上昇中</option>
              <option value="falling">低下中</option>
            </select>
          </label>
        </div>
        <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', marginTop: '8px', alignItems: 'center' }}>
          <span style={{ fontSize: '11px', color: 'var(--text-muted)', fontWeight: 700, marginRight: '2px' }}>
            物理状態
          </span>
          <span style={{ fontSize: '11px', color: 'var(--text-muted)', fontWeight: 700, marginLeft: '6px' }}>
            検証期間
          </span>
          {PHYSICAL_STATUS_HORIZONS.map((horizon) => (
            <button
              key={horizon}
              type="button"
              onClick={() => setSelectedPhysicalStatusHorizon(horizon)}
              style={mcChipStyle(selectedPhysicalStatusHorizon === horizon)}
              title={
                horizon === 5
                  ? '超短期の初動・急失速を見ます'
                  : horizon === 10
                    ? '初動が本物か、短期で確認します'
                    : horizon === 20
                      ? '標準の短期〜1か月目線です'
                      : '中期の答え合わせです'
              }
            >
              {horizon}営業日
            </button>
          ))}
        </div>
        <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', marginTop: '8px', alignItems: 'center' }}>
          <span style={{ fontSize: '11px', color: 'var(--text-muted)', fontWeight: 700, marginRight: '2px' }}>
            ラベル
          </span>
          <button
            type="button"
            onClick={() => setSelectedPhysicalStatus('')}
            style={mcChipStyle(selectedPhysicalStatus === '')}
          >
            全て（{results.length.toLocaleString('ja-JP')}）
          </button>
          {physicalStatusOptions.map(([label, count]) => (
            <button
              key={label}
              type="button"
              onClick={() => setSelectedPhysicalStatus((current) => current === label ? '' : label)}
              style={physicalStatusFilterChipStyle(label, selectedPhysicalStatus === label)}
            >
              {label}（{count.toLocaleString('ja-JP')}）
            </button>
          ))}
        </div>
        <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', marginTop: '8px' }}>
          <button type="button" onClick={() => setAccelerationPositive((v) => !v)} style={mcChipStyle(accelerationPositive)}>
            Acceleration &gt; 0
          </button>
          <button type="button" onClick={() => setForcePositive((v) => !v)} style={mcChipStyle(forcePositive)}>
            Force &gt; 0
          </button>
          <button type="button" onClick={() => setStage23Candidate((v) => !v)} style={mcChipStyle(stage23Candidate)}>
            Stage2→3候補
          </button>
          {(pmsMin || pfsMin || pesMin || accelerationPositive || forcePositive || stage23Candidate || pmsTrend || selectedPhysicalStatus) && (
            <button
              type="button"
              onClick={() => {
                setPmsMin('')
                setPfsMin('')
                setPesMin('')
                setAccelerationPositive(false)
                setForcePositive(false)
                setStage23Candidate(false)
                setPmsTrend('')
                setSelectedPhysicalStatus('')
              }}
              style={mcChipStyle(false)}
            >
              × クリア
            </button>
          )}
        </div>
      </Section>

      {/* HEXステージ（任意の絞り込み） */}
      <Section step={6} label="HEXステージで絞り込み（任意 / 複数系統 AND）">
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: '8px' }}>
          <button
            onClick={() => setStages({})}
            disabled={!hasAnyStage}
            style={{
              padding: '4px 10px',
              fontSize: '11px',
              background: 'var(--bg-surface)',
              border: '1px solid var(--border-base)',
              borderRadius: 'var(--radius-sm)',
              cursor: hasAnyStage ? 'pointer' : 'not-allowed',
              opacity: hasAnyStage ? 1 : 0.5,
              color: 'var(--text-secondary)',
            }}
          >
            × 全てクリア
          </button>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 172px), 1fr))', gap: '6px' }}>
          {AXES.map((ax) => (
            <AxisCard
              key={ax.key}
              axis={ax}
              selected={stages[ax.key] ?? []}
              onToggle={(stage) => setStages((prev) => {
                const next = { ...prev }
                const cur = next[ax.key] ?? []
                const after = cur.includes(stage)
                  ? cur.filter((s) => s !== stage)
                  : [...cur, stage]
                if (after.length === 0) delete next[ax.key]
                else next[ax.key] = after
                return next
              })}
              onClear={() => setStages((prev) => {
                const next = { ...prev }
                delete next[ax.key]
                return next
              })}
            />
          ))}
        </div>

        {hasAnyStage && (
          <div style={{
            marginTop: '12px',
            padding: '8px 12px',
            background: 'var(--color-brand-50)',
            border: '1px solid var(--accent-dim)',
            borderRadius: 'var(--radius-sm)',
            fontSize: '11px',
            color: 'var(--text-secondary)',
          }}>
            🔍 フィルタ条件: <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-primary)' }}>{filterText}</span>
          </div>
        )}
      </Section>
      {error && (
        <div className="card" style={{ padding: '12px', borderLeft: '3px solid var(--price-down)' }}>
          <p style={{ fontSize: '12px', color: 'var(--price-down)', margin: 0 }}>エラー: {error}</p>
        </div>
      )}

      {notice && (
        <div className="card" style={{ padding: '12px', borderLeft: '3px solid var(--accent-primary)' }}>
          <p style={{ fontSize: '12px', color: 'var(--text-secondary)', margin: 0 }}>
            ℹ️ {notice}
          </p>
        </div>
      )}

      {loading && results.length === 0 ? (
        <ScreenerLoadingSkeleton />
      ) : (
        <div className="card" style={{ overflow: 'hidden' }}>
          <div style={{ padding: '8px 12px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '1px solid var(--border-subtle)', gap: '8px', flexWrap: 'wrap' }}>
            <span style={{ fontSize: '12px', color: 'var(--text-secondary)', display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
              <span><strong>{sortedResults.length}</strong>件 / 母集団 {universe}銘柄</span>
              {activeUniverseMeta && (
                <span className="rounded-full border border-[var(--color-market-red)] bg-[var(--color-price-up-bg)] px-2 py-0.5 text-[11px] font-bold text-[var(--color-market-red)]">
                  {activeUniverseMeta.shortLabel}
                </span>
              )}
              <span style={{ color: 'var(--text-muted)' }}>
                時価総額 {marketCapCoverage.calculated.toLocaleString()}件算出
                {marketCapCoverage.notApplicable > 0 ? ` / ${marketCapCoverage.notApplicable.toLocaleString()}件対象外` : ''}
                {marketCapCoverage.missing > 0 ? ` / ${marketCapCoverage.missing.toLocaleString()}件未取得` : ''}
              </span>
              {sortedResults.length > displayedResults.length && (
                <span style={{ color: 'var(--text-muted)' }}>
                  表示は先頭 {displayedResults.length} 件
                </span>
              )}
              {availableDates.length > 0 && (
                <MarketDateCalendar
                  dates={availableDates}
                  value={selectedDate}
                  onChange={setSelectedDate}
                  label="スクリーナー日付"
                  align="left"
                  compact
                />
              )}
              {cached && <span style={{ color: 'var(--text-muted)' }}>（DB）</span>}
            </span>
            <button
              onClick={downloadTvWatchlist}
              disabled={sortedResults.length === 0}
              style={{
                padding: '6px 12px',
                fontSize: '11px',
                background: sortedResults.length > 0 ? 'var(--accent-primary)' : 'var(--bg-surface)',
                color: sortedResults.length > 0 ? '#fff' : 'var(--text-muted)',
                border: `1px solid ${sortedResults.length > 0 ? 'var(--accent-primary)' : 'var(--border-base)'}`,
                borderRadius: 'var(--radius-sm)',
                cursor: sortedResults.length > 0 ? 'pointer' : 'not-allowed',
                fontWeight: 600,
                fontFamily: 'var(--font-mono)',
              }}
              title="TradingView の銘柄リストにインポートできる .txt をダウンロード"
            >
              📤 TVリストをダウンロード
            </button>
          </div>
          {sortedResults.length === 0 ? (
            <div style={{ padding: '32px', textAlign: 'center' }}>
              <p style={{ fontSize: '12px', color: 'var(--text-muted)' }}>該当する銘柄がありません</p>
            </div>
          ) : (
            <div style={{ overflowX: 'auto' }}>
              <table style={{ minWidth: '3480px', borderCollapse: 'collapse', fontSize: '12px' }}>
                <thead>
                  <tr style={{ background: 'var(--bg-elevated)', borderBottom: '1px solid var(--border-dim)' }}>
                    <th scope="col" style={th}></th>
                    <SortableTh label="コード"     sortKey="ticker"              current={sort} onClick={toggleSort} />
                    <th scope="col" style={th}>TV形式</th>
                    <SortableTh label="銘柄名"     sortKey="name"                current={sort} onClick={toggleSort} />
                    <SortableTh label="短期チェック" sortKey="shortTermCheckScore" current={sort} onClick={toggleSort} />
                    <SortableTh label="物理状態"   sortKey="physicalStatusScore" current={sort} onClick={toggleSort} />
                    <SortableTh label="貸借/信用"  sortKey="marginType"          current={sort} onClick={toggleSort} />
                    <SortableTh label="市場区分"   sortKey="marketSegment"       current={sort} onClick={toggleSort} />
                    <SortableTh label="33業種" sortKey="sector33"            current={sort} onClick={toggleSort} />
                    <SortableTh label="17業種" sortKey="sectorLarge"         current={sort} onClick={toggleSort} />
                    <SortableTh label="株価"       sortKey="price"               current={sort} onClick={toggleSort} align="right" />
                    <SortableTh label="日%"        sortKey="changePercent"       current={sort} onClick={toggleSort} align="right" />
                    <SortableTh label="週%"        sortKey="changePercentWeek"   current={sort} onClick={toggleSort} align="right" />
                    <SortableTh label="月%"        sortKey="changePercentMonth"  current={sort} onClick={toggleSort} align="right" />
                    <SortableTh label="3ヶ月%"     sortKey="perfPct3m"           current={sort} onClick={toggleSort} align="right" />
                    <SortableTh label="6ヶ月%"     sortKey="perfPct6m"           current={sort} onClick={toggleSort} align="right" />
                    <SortableTh label="年初来%"    sortKey="perfPctYtd"          current={sort} onClick={toggleSort} align="right" />
                    <SortableTh label="出来高"     sortKey="volume"              current={sort} onClick={toggleSort} align="right" />
                    <SortableTh label="平均10日"   sortKey="avgVolume10d"        current={sort} onClick={toggleSort} align="right" />
                    <SortableTh label="平均30日"   sortKey="avgVolume30d"        current={sort} onClick={toggleSort} align="right" />
                    <SortableTh label="時価総額"   sortKey="marketCap"           current={sort} onClick={toggleSort} align="right" />
                    <SortableTh label="SMA5角度"   sortKey="sma5Angle"           current={sort} onClick={toggleSort} align="right" />
                    <SortableTh label="SMA25角度"  sortKey="sma25Angle"          current={sort} onClick={toggleSort} align="right" />
                    <SortableTh label="SMA75角度"  sortKey="sma75Angle"          current={sort} onClick={toggleSort} align="right" />
                    <SortableTh label="SMA200角度" sortKey="sma200Angle"         current={sort} onClick={toggleSort} align="right" />
                    <SortableTh label="PMS"        sortKey="physicalMomentumScore" current={sort} onClick={toggleSort} align="right" />
                    <SortableTh label="PFS"        sortKey="physicalForceScore"  current={sort} onClick={toggleSort} align="right" />
                    <SortableTh label="PES"        sortKey="physicalEnergyScore" current={sort} onClick={toggleSort} align="right" />
                    <SortableTh label="PMS順位"     sortKey="physicalMomentumRank" current={sort} onClick={toggleSort} align="right" />
                    <SortableTh label="前回決算"   sortKey="earningsLastDate"    current={sort} onClick={toggleSort} />
                    <SortableTh label="前回から"   sortKey="earningsLastElapsedDays" current={sort} onClick={toggleSort} align="right" />
                    <SortableTh label="次回決算"   sortKey="earningsNextDate"    current={sort} onClick={toggleSort} />
                    <SortableTh label="残営業日"   sortKey="earningsNextBusinessDays" current={sort} onClick={toggleSort} align="right" />
                    <th scope="col" style={th}>ステージ (日A/B 週A/B 月A/B)</th>
                  </tr>
                </thead>
                <tbody>
                  {displayedResults.map((r) => {
                    const tv = toTvSymbol(r.ticker, r.marketSegment)
                    const copied = copiedTicker === r.ticker
                    const lastElapsedDays = daysSince(r.earningsLastDate, referenceDate)
                    const nextBusinessDays = businessDaysUntil(r.earningsNextDate, referenceDate, tradingDates)
                    const lastEarnings = earningsLastDisplay(r)
                    const nextEarnings = earningsNextDisplay(r)
                    return (
                      <tr key={r.ticker} style={{ borderBottom: '1px solid var(--border-subtle)' }}>
                        <td style={{ ...td, width: '32px' }}>
                          <WatchlistButton ticker={r.ticker} size="sm" />
                        </td>
                        <td style={td}>
                          <Link href={`/stock/${encodeURIComponent(r.ticker)}`} style={{ color: 'var(--accent-primary)', fontFamily: 'var(--font-mono)', textDecoration: 'none', fontWeight: 600 }}>
                            {r.ticker.replace('.T', '')}
                          </Link>
                        </td>
                        <td style={td}>
                          <button
                            onClick={() => copyTvSymbol(r.ticker, r.marketSegment)}
                          title={copied ? 'コピーしました' : `${tv} をクリップボードにコピー`}
                            style={{
                              padding: '2px 8px',
                              fontSize: '11px',
                              fontFamily: 'var(--font-mono)',
                              fontWeight: 600,
                              background: copied ? 'var(--price-up, #22c55e)' : 'var(--bg-elevated)',
                              color: copied ? '#fff' : 'var(--text-secondary)',
                              border: `1px solid ${copied ? 'var(--price-up, #22c55e)' : 'var(--border-base)'}`,
                              borderRadius: 'var(--radius-sm)',
                              cursor: 'pointer',
                              transition: 'all 0.15s',
                            }}
                          >
                            {copied ? '✓ コピー済み' : tv}
                          </button>
                        </td>
                        <td style={td}>{r.name}</td>
                        <td style={td}>
                          <ShortTermCheckBadge row={r} />
                        </td>
                        <td style={td}>
                          <PhysicalStatusBadge row={r} />
                        </td>
                        <td style={td}>
                          {r.marginType ? (
                            <span style={{
                              display: 'inline-block',
                              padding: '1px 6px',
                              fontSize: '10px',
                              border: `1px solid ${r.marginType === '貸借' ? 'var(--accent-primary)' : 'var(--text-muted)'}`,
                              color: r.marginType === '貸借' ? 'var(--accent-primary)' : 'var(--text-muted)',
                              borderRadius: '2px',
                            }}>
                              {r.marginType}
                            </span>
                          ) : '---'}
                        </td>
                        <td style={td}>{r.marketSegment || '---'}</td>
                        <td style={td}>{r.sector33 || '---'}</td>
                        <td style={td}>{r.sectorLarge || '---'}</td>
                        <td style={tdR}>{r.price?.toLocaleString('ja-JP', { maximumFractionDigits: 2 }) ?? '---'}</td>
                        <td style={{ ...tdR, color: pctColor(r.changePercent ?? undefined) }}>{fmtPct(r.changePercent ?? undefined)}</td>
                        <td style={{ ...tdR, color: pctColor(r.changePercentWeek ?? undefined) }}>{fmtPct(r.changePercentWeek ?? undefined)}</td>
                        <td style={{ ...tdR, color: pctColor(r.changePercentMonth ?? undefined) }}>{fmtPct(r.changePercentMonth ?? undefined)}</td>
                        <td style={{ ...tdR, color: pctColor(r.perfPct3m ?? undefined) }}>{fmtPct(r.perfPct3m ?? undefined)}</td>
                        <td style={{ ...tdR, color: pctColor(r.perfPct6m ?? undefined) }}>{fmtPct(r.perfPct6m ?? undefined)}</td>
                        <td style={{ ...tdR, color: pctColor(r.perfPctYtd ?? undefined) }}>{fmtPct(r.perfPctYtd ?? undefined)}</td>
                        <td style={tdR}>{r.volume?.toLocaleString('ja-JP') ?? '---'}</td>
                        <td style={tdR}>{r.avgVolume10d != null ? r.avgVolume10d.toLocaleString('ja-JP') : '---'}</td>
                        <td style={tdR}>{r.avgVolume30d != null ? r.avgVolume30d.toLocaleString('ja-JP') : '---'}</td>
                        <td style={tdR}>{fmtMarketCap(r)}</td>
                        <td style={{ ...tdR, color: pctColor(r.sma5Angle ?? undefined) }}>{fmtAngleWithTrend(r.sma5Angle ?? undefined)}</td>
                        <td style={{ ...tdR, color: pctColor(r.sma25Angle ?? undefined) }}>{fmtAngle(r.sma25Angle ?? undefined)}</td>
                        <td style={{ ...tdR, color: pctColor(r.sma75Angle ?? undefined) }}>{fmtAngle(r.sma75Angle ?? undefined)}</td>
                        <td style={{ ...tdR, minWidth: '74px', color: sma200Tone(r.sma200Angle ?? undefined) }}>{fmtLongSmaAngle(r.sma200Angle ?? undefined)}</td>
                        <td style={{ ...tdR, color: scoreColor(r.physicalMomentumScore) }}>
                          {fmtScore(r.physicalMomentumScore)}
                          <span style={{ marginLeft: '4px', color: 'var(--text-muted)', fontSize: '10px' }}>
                            {pmsTrendSymbol(r.physicalMomentumTrend)}
                          </span>
                        </td>
                        <td style={{ ...tdR, color: scoreColor(r.physicalForceScore) }}>{fmtScore(r.physicalForceScore)}</td>
                        <td style={{ ...tdR, color: scoreColor(r.physicalEnergyScore) }}>{fmtScore(r.physicalEnergyScore)}</td>
                        <td style={tdR}>{r.physicalMomentumRank != null ? r.physicalMomentumRank.toLocaleString('ja-JP') : '---'}</td>
                        <td style={{ ...td, minWidth: '112px', whiteSpace: 'nowrap' }}>
                          <div style={{ display: 'flex', flexDirection: 'column', gap: '2px', alignItems: 'flex-start' }}>
                            <span style={{
                              fontFamily: r.earningsLastDate ? 'var(--font-mono)' : undefined,
                              fontSize: '11px',
                              color: r.earningsLastDate ? 'var(--text-secondary)' : lastEarnings.color,
                              fontWeight: r.earningsLastDate ? 500 : 700,
                            }}>
                              {r.earningsLastDate ?? lastEarnings.label}
                            </span>
                            <span
                              title={lastEarnings.title}
                              style={{
                                display: 'inline-block',
                                padding: '1px 5px',
                                borderRadius: '2px',
                                border: `1px solid ${lastEarnings.border}`,
                                color: lastEarnings.color,
                                background: lastEarnings.background,
                                fontSize: '10px',
                                lineHeight: 1.25,
                                fontWeight: 700,
                              }}
                            >
                              {lastEarnings.badge}
                            </span>
                          </div>
                        </td>
                        <td style={{ ...tdR, color: lastElapsedDays == null ? lastEarnings.color : elapsedDaysColor(lastElapsedDays) }}>
                          {lastElapsedDays == null ? lastEarnings.label : fmtDaysSince(lastElapsedDays)}
                        </td>
                        <td style={{ ...td, minWidth: '116px', whiteSpace: 'nowrap' }}>
                          <div style={{ display: 'flex', flexDirection: 'column', gap: '2px', alignItems: 'flex-start' }}>
                            <span style={{
                              fontFamily: r.earningsNextDate ? 'var(--font-mono)' : undefined,
                              fontSize: '11px',
                              color: r.earningsNextDate ? 'var(--text-secondary)' : 'var(--text-muted)',
                            }}>
                              {r.earningsNextDate ?? nextEarnings.label}
                            </span>
                            <span
                              title={nextEarnings.title}
                              style={{
                                display: 'inline-block',
                                padding: '1px 5px',
                                borderRadius: '2px',
                                border: `1px solid ${nextEarnings.border}`,
                                color: nextEarnings.color,
                                background: nextEarnings.background,
                                fontSize: '10px',
                                lineHeight: 1.25,
                                fontWeight: 700,
                              }}
                            >
                              {nextEarnings.badge}
                            </span>
                          </div>
                        </td>
                        <td style={{ ...tdR, color: daysColor(nextBusinessDays) }}>{fmtBusinessDaysUntil(nextBusinessDays)}</td>
                        <td style={{ ...td, whiteSpace: 'nowrap' }}>
                          <StageDots
                            values={[r.daily_a_stage, r.daily_b_stage, r.weekly_a_stage, r.weekly_b_stage, r.monthly_a_stage, r.monthly_b_stage]}
                          />
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
      </div>
    </div>
  )
}

function ScreenerLoadingSkeleton() {
  return (
    <div className="card" style={{ overflow: 'hidden' }}>
      <div style={{ padding: '10px 12px', borderBottom: '1px solid var(--border-subtle)' }}>
        <div style={{ ...skeletonBlock, width: '180px', height: '14px' }} />
      </div>
      <div style={{ padding: '10px 12px', display: 'grid', gap: '8px' }}>
        {Array.from({ length: 8 }).map((_, index) => (
          <div
            key={index}
            style={{
              display: 'grid',
              gridTemplateColumns: '70px minmax(130px, 1fr) 90px 80px 120px',
              gap: '10px',
              alignItems: 'center',
              minWidth: 0,
            }}
          >
            <div style={{ ...skeletonBlock, height: '12px' }} />
            <div style={{ ...skeletonBlock, height: '12px', width: `${70 + (index % 3) * 8}%` }} />
            <div style={{ ...skeletonBlock, height: '12px' }} />
            <div style={{ ...skeletonBlock, height: '12px' }} />
            <div style={{ ...skeletonBlock, height: '12px' }} />
          </div>
        ))}
      </div>
      <div style={{ padding: '0 12px 12px', fontSize: '11px', color: 'var(--text-muted)' }}>
        初回表示用データを段階ロード中です。
      </div>
    </div>
  )
}

function fmtPct(v: number | undefined): string {
  if (v == null || !Number.isFinite(v)) return '---'
  const sign = v > 0 ? '+' : ''
  return `${sign}${v.toFixed(2)}%`
}

function fmtScore(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return '---'
  return v.toFixed(2)
}

function fmtRate(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return '---'
  return `${(v * 100).toFixed(0)}%`
}

function fmtLift(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return '---'
  return `${v.toFixed(2)}x`
}

function scoreColor(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return 'var(--text-muted)'
  if (v > 0) return 'var(--price-up)'
  if (v < 0) return 'var(--price-down)'
  return 'var(--text-secondary)'
}

function pmsTrendSymbol(trend: StockRow['physicalMomentumTrend']): string {
  if (trend === 'rising') return '↑'
  if (trend === 'falling') return '↓'
  if (trend === 'flat') return '→'
  return ''
}

function shortTermTone(label: ShortTermCheckLabel) {
  switch (label) {
    case '強気優勢':
      return {
        color: 'var(--price-up)',
        border: 'rgba(220, 38, 38, 0.28)',
        background: 'rgba(220, 38, 38, 0.07)',
      }
    case '好転候補':
      return {
        color: '#0f766e',
        border: 'rgba(20, 184, 166, 0.3)',
        background: 'rgba(20, 184, 166, 0.07)',
      }
    case '下落警戒':
      return {
        color: 'var(--price-down)',
        border: 'rgba(37, 99, 235, 0.3)',
        background: 'rgba(37, 99, 235, 0.07)',
      }
    case '弱含み注意':
      return {
        color: '#1d4ed8',
        border: 'rgba(37, 99, 235, 0.22)',
        background: 'rgba(37, 99, 235, 0.05)',
      }
    default:
      return {
        color: 'var(--text-secondary)',
        border: 'var(--border-base)',
        background: 'var(--bg-elevated)',
      }
  }
}

function shortTermFilterChipStyle(label: ShortTermCheckLabel, active: boolean): React.CSSProperties {
  const tone = shortTermTone(label)
  return {
    ...mcChipStyle(false),
    background: active ? tone.color : tone.background,
    color: active ? '#fff' : tone.color,
    border: `1px solid ${active ? tone.color : tone.border}`,
    fontWeight: 700,
  }
}

function ShortTermCheckBadge({ row }: { row: StockRow }) {
  const tone = shortTermTone(row.shortTermCheckLabel)
  const title = [
    `スコア ${row.shortTermCheckScore.toFixed(2)}`,
    ...(row.shortTermCheckReasons ?? []),
    row.shortTermCheckMlText ? `ML類似: ${row.shortTermCheckMlText}` : null,
  ].filter(Boolean).join(' / ')
  return (
    <span
      title={title}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: '5px',
        border: `1px solid ${tone.border}`,
        background: tone.background,
        color: tone.color,
        borderRadius: '999px',
        padding: '3px 8px',
        fontSize: '11px',
        fontWeight: 800,
        whiteSpace: 'nowrap',
      }}
    >
      {row.shortTermCheckLabel}
      <small style={{ fontFamily: 'var(--font-mono)', opacity: 0.8 }}>{row.shortTermCheckScore.toFixed(1)}</small>
    </span>
  )
}

function physicalStatusTone(label: PhysicsStatus) {
  switch (label) {
    case '上昇加速':
    case '上昇継続':
      return {
        color: 'var(--price-up)',
        border: 'rgba(220, 38, 38, 0.28)',
        background: 'rgba(220, 38, 38, 0.07)',
      }
    case '押し目形成':
    case '反発準備':
      return {
        color: '#0f766e',
        border: 'rgba(20, 184, 166, 0.3)',
        background: 'rgba(20, 184, 166, 0.07)',
      }
    case '下落加速':
      return {
        color: 'var(--price-down)',
        border: 'rgba(37, 99, 235, 0.32)',
        background: 'rgba(37, 99, 235, 0.08)',
      }
    case '失速警戒':
      return {
        color: '#1d4ed8',
        border: 'rgba(37, 99, 235, 0.24)',
        background: 'rgba(37, 99, 235, 0.06)',
      }
    case '過熱注意':
      return {
        color: '#b45309',
        border: 'rgba(245, 158, 11, 0.34)',
        background: 'rgba(245, 158, 11, 0.1)',
      }
    default:
      return {
        color: 'var(--text-secondary)',
        border: 'var(--border-base)',
        background: 'var(--bg-elevated)',
      }
  }
}

function physicalStatusFilterChipStyle(label: PhysicsStatus, active: boolean): React.CSSProperties {
  const tone = physicalStatusTone(label)
  return {
    ...mcChipStyle(false),
    background: active ? tone.color : tone.background,
    color: active ? '#fff' : tone.color,
    border: `1px solid ${active ? tone.color : tone.border}`,
    fontWeight: 700,
  }
}

function PhysicalStatusBadge({ row }: { row: StockRow }) {
  const tone = physicalStatusTone(row.physicalStatusLabel)
  const source = row.physicalStatusSourceDate ? `特徴量日付 ${row.physicalStatusSourceDate}` : '特徴量未取得'
  const score = row.physicalStatusScore != null && Number.isFinite(row.physicalStatusScore)
    ? ` / 並び替えスコア ${row.physicalStatusScore.toFixed(1)}`
    : ''
  const target = row.physicalStatusTargetDirection === 'up'
    ? '上昇'
    : row.physicalStatusTargetDirection === 'down'
      ? '下落'
      : row.physicalStatusTargetDirection === 'wait'
        ? '見送り'
        : '未検証'
  const calibration = row.physicalStatusHitRate != null
    ? ` / 過去検証 ${row.physicalStatusHorizonDays ?? '-'}営業日 ${target}: 的中${fmtRate(row.physicalStatusHitRate)} base${fmtRate(row.physicalStatusBaseRate)} lift${fmtLift(row.physicalStatusLift)} 信頼${row.physicalStatusConfidence?.toFixed(0) ?? '-'} n=${row.physicalStatusSampleCount ?? '-'} 評価日${row.physicalStatusEvaluationDate ?? '-'}`
    : ' / 過去検証は次回ML日次後に反映'
  return (
    <span
      title={`${source}${score}${calibration}`}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: '5px',
        border: `1px solid ${tone.border}`,
        background: tone.background,
        color: tone.color,
        borderRadius: '999px',
        padding: '3px 8px',
        fontSize: '11px',
        fontWeight: 800,
        whiteSpace: 'nowrap',
      }}
    >
      {row.physicalStatusLabel}
      {row.physicalStatusHitRate != null && Number.isFinite(row.physicalStatusHitRate) ? (
        <small style={{ fontFamily: 'var(--font-mono)', opacity: 0.82 }}>
          {fmtRate(row.physicalStatusHitRate)}
        </small>
      ) : row.physicalStatusScore != null && Number.isFinite(row.physicalStatusScore) && (
        <small style={{ fontFamily: 'var(--font-mono)', opacity: 0.78 }}>
          {row.physicalStatusScore.toFixed(0)}
        </small>
      )}
    </span>
  )
}

function fmtAngle(v: number | undefined): string {
  if (v == null || !Number.isFinite(v)) return '---'
  const sign = v > 0 ? '+' : ''
  return `${sign}${v.toFixed(2)}°`
}

function fmtAngleWithTrend(v: number | undefined): string {
  if (v == null || !Number.isFinite(v)) return '---'
  return fmtAngle(v)
}

function fmtLongSmaAngle(v: number | undefined): string {
  if (v == null || !Number.isFinite(v)) return '---'
  const label = Math.abs(v) < 0.05 ? '横ばい' : v > 0 ? '上向き' : '下向き'
  return `${label} ${fmtAngle(v)}`
}

function sma200Tone(v: number | undefined): string {
  if (v == null || !Number.isFinite(v)) return 'var(--text-muted)'
  if (Math.abs(v) < 0.05) return 'var(--text-secondary)'
  return pctColor(v)
}

function fmtMarketCap(row: StockRow): string {
  if (row.marketCap != null && row.marketCap > 0) {
    return `${(row.marketCap / 1e8).toLocaleString('ja-JP', { maximumFractionDigits: 0 })} 億`
  }
  if (row.marketCapStatus === 'not_applicable') return '対象外'
  if (row.marketCapStatus === 'shares_missing') return '未取得'
  if (row.marketCapStatus === 'price_missing') return '株価なし'
  return '未取得'
}

function earningsNextDisplay(row: StockRow): {
  label: string
  badge: string
  title: string
  color: string
  border: string
  background: string
} {
  const source = earningsSourceLabel(row.earningsNextDateSource)
  const fiscal = row.earningsNextFiscalPeriod ? ` / ${row.earningsNextFiscalPeriod}` : ''
  switch (row.earningsNextDateKind) {
    case 'confirmed':
      return {
        label: row.earningsNextDate ?? '公式予定',
        badge: source ? `公式 ${source}` : '公式予定',
        title: `公式ソースから取得した決算発表予定です${fiscal}。`,
        color: 'var(--accent-primary)',
        border: 'var(--accent-primary)',
        background: 'var(--bg-elevated)',
      }
    case 'estimated':
      return {
        label: row.earningsNextDate ?? '推定',
        badge: '推定',
        title: '公式予定が未公表のため、直近の決算発表日から約3か月後として推定しています。確定日は決算ページで公式取得後に置き換わります。',
        color: 'var(--text-secondary)',
        border: 'var(--border-base)',
        background: 'var(--bg-surface)',
      }
    case 'not_applicable':
      return {
        label: '対象外',
        badge: '対象外',
        title: 'ETF、REIT、投資法人など、通常の事業会社決算予定として扱わない銘柄です。',
        color: 'var(--text-muted)',
        border: 'var(--border-subtle)',
        background: 'var(--bg-elevated)',
      }
    case 'not_announced':
      return {
        label: '未公表',
        badge: '公式予定なし',
        title: '過去の決算履歴はありますが、基準日以降の公式予定はまだDBにありません。',
        color: 'var(--text-muted)',
        border: 'var(--border-subtle)',
        background: 'var(--bg-elevated)',
      }
    case 'no_history':
    default:
      return {
        label: '未取得',
        badge: '履歴なし',
        title: 'この銘柄の決算発表予定・履歴がDBにありません。JPX公式またはJ-Quants取得後に反映されます。',
        color: 'var(--text-muted)',
        border: 'var(--border-subtle)',
        background: 'var(--bg-elevated)',
      }
  }
}

function earningsLastDisplay(row: StockRow): {
  label: string
  badge: string
  title: string
  color: string
  border: string
  background: string
} {
  const source = earningsSourceLabel(row.earningsLastDateSource)
  const fiscal = row.earningsLastFiscalPeriod ? ` / ${row.earningsLastFiscalPeriod}` : ''
  switch (row.earningsLastDateKind) {
    case 'reported':
      return {
        label: row.earningsLastDate ?? '前回決算',
        badge: source ? source : '実績',
        title: `J-Quants等から取得した決算発表実績です${fiscal}。`,
        color: 'var(--accent-primary)',
        border: 'var(--accent-primary)',
        background: 'var(--bg-elevated)',
      }
    case 'not_applicable':
      return {
        label: '対象外',
        badge: '対象外',
        title: 'ETF、REIT、投資法人など、通常の事業会社決算として扱わない銘柄です。',
        color: 'var(--text-muted)',
        border: 'var(--border-subtle)',
        background: 'var(--bg-elevated)',
      }
    case 'unverified':
      return {
        label: '未検証',
        badge: '未検証',
        title: '表示中の日付が、DBに保存済みのJ-Quants決算実績より古いため、前回決算を検証できません。',
        color: 'var(--text-muted)',
        border: 'var(--border-subtle)',
        background: 'var(--bg-elevated)',
      }
    case 'not_collected':
    default:
      return {
        label: '未取得',
        badge: '未取得',
        title: '普通株ですが、J-Quants fins/summary 由来の決算実績がまだDBにありません。補完バッチの対象です。',
        color: 'var(--text-muted)',
        border: 'var(--border-subtle)',
        background: 'var(--bg-elevated)',
      }
  }
}

function earningsSourceLabel(source: string | null | undefined): string | null {
  if (source === 'jquants_fins_summary') return 'JQ実績'
  if (source === 'jpx') return 'JPX'
  if (source === 'jquants') return 'JQ'
  return null
}

function sortValue(row: StockRow, key: SortKey, referenceDate: string | null, tradingDates: string[]): unknown {
  if (key === 'earningsLastElapsedDays') return daysSince(row.earningsLastDate, referenceDate)
  if (key === 'earningsNextBusinessDays') return businessDaysUntil(row.earningsNextDate, referenceDate, tradingDates)
  return (row as unknown as Record<string, unknown>)[key]
}

function parseDateUtc(dateStr: string | null | undefined): number | null {
  if (!dateStr) return null
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr)
  if (!m) return null
  return Date.UTC(+m[1], +m[2] - 1, +m[3])
}

function referenceDateUtc(referenceDate: string | null): number {
  const parsed = parseDateUtc(referenceDate)
  if (parsed != null) return parsed
  const now = new Date()
  return Date.UTC(now.getFullYear(), now.getMonth(), now.getDate())
}

function referenceDateIso(referenceDate: string | null): string {
  const parsed = parseDateUtc(referenceDate)
  const base = parsed ?? referenceDateUtc(null)
  return formatIsoUtc(base)
}

function formatIsoUtc(time: number): string {
  const d = new Date(time)
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`
}

function addDaysUtc(time: number, days: number): number {
  return time + days * 86400000
}

function isWeekdayUtc(time: number): boolean {
  const day = new Date(time).getUTCDay()
  return day >= 1 && day <= 5
}

/** 前回決算日から基準日までの経過日数。基準日は表示中のスナップショット日付。 */
function daysSince(dateStr: string | null | undefined, referenceDate: string | null): number | null {
  const target = parseDateUtc(dateStr)
  if (target == null) return null
  return Math.round((referenceDateUtc(referenceDate) - target) / 86400000)
}

/** 次回決算日までの残営業日数。DB内取引日を優先し、将来未収録分は平日換算する。 */
function businessDaysUntil(dateStr: string | null | undefined, referenceDate: string | null, tradingDates: string[]): number | null {
  const target = parseDateUtc(dateStr)
  if (target == null) return null
  const from = referenceDateIso(referenceDate)
  const to = formatIsoUtc(target)
  if (from === to) return 0
  if (to < from) return -countBusinessDaysForward(to, from, tradingDates)
  return countBusinessDaysForward(from, to, tradingDates)
}

function countBusinessDaysForward(fromExclusive: string, toInclusive: string, tradingDates: string[]): number {
  let count = tradingDates.filter((date) => date > fromExclusive && date <= toInclusive).length
  const latestTradingDate = tradingDates[tradingDates.length - 1]
  const fallbackStart = latestTradingDate && latestTradingDate > fromExclusive ? latestTradingDate : fromExclusive
  if (toInclusive > fallbackStart) {
    const start = parseDateUtc(fallbackStart)
    const end = parseDateUtc(toInclusive)
    if (start != null && end != null) {
      for (let time = addDaysUtc(start, 1); time <= end; time = addDaysUtc(time, 1)) {
        if (isWeekdayUtc(time)) count += 1
      }
    }
  }
  return count
}

function fmtDaysSince(d: number | null): string {
  if (d == null) return '---'
  if (d === 0) return '本日'
  if (d > 0) return `${d}日経過`
  return `${Math.abs(d)}日後`
}

function fmtBusinessDaysUntil(d: number | null): string {
  if (d == null) return '---'
  if (d === 0) return '本日'
  if (d > 0) return `${d}営業日`
  return `${d}営業日 (過去)`
}

function elapsedDaysColor(d: number | null): string {
  if (d == null) return 'var(--text-muted)'
  if (d < 0) return 'var(--accent-primary)'
  if (d <= 14) return 'var(--accent-primary)'
  if (d <= 45) return 'var(--text-secondary)'
  return 'var(--text-muted)'
}

function daysColor(d: number | null): string {
  if (d == null) return 'var(--text-muted)'
  if (d < 0) return 'var(--text-muted)'
  if (d <= 7) return 'var(--price-down, #ef4444)'    // 1週間以内: 強調赤
  if (d <= 30) return 'var(--accent-primary)'         // 1ヶ月以内: 強調
  return 'var(--text-secondary)'
}

function pctColor(v: number | undefined): string {
  if (v == null || !Number.isFinite(v)) return 'var(--text-muted)'
  if (v > 0) return 'var(--price-up, #22c55e)'
  if (v < 0) return 'var(--price-down, #ef4444)'
  return 'var(--text-secondary)'
}

function SortableTh({
  label, sortKey, current, onClick, align = 'left',
}: {
  label: string
  sortKey: SortKey
  current: SortState | null
  onClick: (k: SortKey) => void
  align?: 'left' | 'right'
}) {
  const isActive = current?.key === sortKey
  const arrow = isActive
    ? (current.dir === 'desc' ? ' ▼' : ' ▲')
    : ' ⇅'
  return (
    <th
      scope="col"
      style={{
        ...(align === 'right' ? thR : th),
        cursor: 'pointer',
        userSelect: 'none',
        color: isActive ? 'var(--accent-primary)' : undefined,
      }}
      onClick={() => onClick(sortKey)}
      title="クリックでソート"
    >
      {label}<span style={{ opacity: isActive ? 1 : 0.4, fontSize: '10px' }}>{arrow}</span>
    </th>
  )
}

function AxisCard({
  axis,
  selected,
  disabled,
  onToggle,
  onClear,
}: {
  axis: { key: AxisKey; label: string; color: string }
  selected: number[]
  disabled?: boolean
  onToggle: (stage: number) => void
  onClear: () => void
}) {
  return (
    <div className="card" style={{ padding: '6px 8px', opacity: disabled ? 0.5 : 1, display: 'flex', alignItems: 'center', gap: '6px', minWidth: 0 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '5px', minWidth: '58px' }}>
        <span style={{
          width: '8px',
          height: '8px',
          borderRadius: '50%',
          background: axis.color,
          flexShrink: 0,
        }} />
        <span style={{ fontSize: '12px', fontWeight: 600, whiteSpace: 'nowrap' }}>{axis.label}</span>
      </div>

      <div style={{ display: 'flex', gap: '3px', flex: 1, minWidth: 0 }}>
        {[1, 2, 3, 4, 5, 6].map((s) => {
          const active = selected.includes(s)
          return (
            <button
              key={s}
              disabled={disabled}
              onClick={() => onToggle(s)}
              style={{
                flex: 1,
                padding: '4px 0',
                fontSize: '12px',
                fontWeight: 700,
                fontFamily: 'var(--font-mono)',
                background: active ? axis.color : 'var(--bg-elevated)',
                color: active ? '#fff' : 'var(--text-secondary)',
                border: `1px solid ${active ? axis.color : 'var(--border-base)'}`,
                borderRadius: 'var(--radius-sm)',
                cursor: disabled ? 'not-allowed' : 'pointer',
              }}
            >
              {s}
            </button>
          )
        })}
      </div>

      {selected.length > 0 && (
        <button
          onClick={onClear}
          disabled={disabled}
          style={{
            padding: '2px 6px',
            fontSize: '10px',
            background: 'transparent',
            border: '1px solid var(--border-base)',
            borderRadius: 'var(--radius-sm)',
            cursor: disabled ? 'not-allowed' : 'pointer',
            color: 'var(--text-muted)',
          }}
          title="この系統の選択をクリア"
        >
          ×
        </button>
      )}
    </div>
  )
}

function Section({ step, label, disabled, children }: { step: number; label: string; disabled?: boolean; children: React.ReactNode }) {
  return (
    <div style={{ opacity: disabled ? 0.5 : 1 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px' }}>
        <span style={{
          width: '20px',
          height: '20px',
          borderRadius: '50%',
          background: 'var(--accent-primary)',
          color: '#fff',
          fontSize: '11px',
          fontWeight: 700,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}>{step}</span>
        <span style={{ fontSize: '12px', fontWeight: 600, color: 'var(--text-primary)' }}>{label}</span>
      </div>
      <div style={{ paddingLeft: '28px' }}>{children}</div>
    </div>
  )
}

function MomentumNumberInput({
  label,
  value,
  onChange,
  placeholder,
}: {
  label: string
  value: string
  onChange: (value: string) => void
  placeholder: string
}) {
  return (
    <label style={momentumSelectLabelStyle}>
      {label}
      <input
        type="number"
        step="0.1"
        value={value}
        placeholder={placeholder}
        onChange={(event) => onChange(event.target.value)}
        style={momentumInputStyle}
      />
    </label>
  )
}

const mcSelectStyle: React.CSSProperties = {
  padding: '5px 8px',
  fontSize: '12px',
  fontFamily: 'var(--font-mono)',
  background: 'var(--bg-elevated)',
  color: 'var(--text-primary)',
  border: '1px solid var(--border-base)',
  borderRadius: 'var(--radius-sm)',
  cursor: 'pointer',
  minWidth: '180px',
}

const momentumSelectLabelStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: '4px',
  fontSize: '11px',
  color: 'var(--text-muted)',
  fontWeight: 600,
}

const momentumInputStyle: React.CSSProperties = {
  ...mcSelectStyle,
  minWidth: 0,
  width: '100%',
  cursor: 'text',
}

const mcChipStyle = (active: boolean): React.CSSProperties => ({
  padding: '6px 12px',
  fontSize: '11px',
  fontFamily: 'var(--font-mono)',
  background: active ? 'var(--accent-primary)' : 'var(--bg-elevated)',
  color: active ? '#fff' : 'var(--text-secondary)',
  border: `1px solid ${active ? 'var(--accent-primary)' : 'var(--border-base)'}`,
  borderRadius: 'var(--radius-sm)',
  cursor: 'pointer',
  whiteSpace: 'nowrap',
  fontWeight: active ? 600 : 400,
})

const skeletonBlock: React.CSSProperties = {
  width: '100%',
  borderRadius: '4px',
  background: 'linear-gradient(90deg, var(--bg-elevated), var(--bg-surface), var(--bg-elevated))',
  border: '1px solid var(--border-subtle)',
}

const th: React.CSSProperties = {
  padding: '8px 12px',
  textAlign: 'left',
  fontFamily: 'var(--font-mono)',
  fontWeight: 500,
  color: 'var(--text-muted)',
  fontSize: '11px',
  whiteSpace: 'nowrap',
}
const thR: React.CSSProperties = { ...th, textAlign: 'right' }
const td: React.CSSProperties = { padding: '8px 12px', fontSize: '12px', color: 'var(--text-primary)', whiteSpace: 'nowrap' }
const tdR: React.CSSProperties = { ...td, textAlign: 'right', fontFamily: 'var(--font-mono)' }
