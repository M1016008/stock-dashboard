'use client'

import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import { useEffect, useMemo, useState } from 'react'
import { ArrowDownAZ, ArrowUpAZ, Columns3, Filter, GitCompareArrows, RotateCcw } from 'lucide-react'
import { StageTag } from '@/components/ui/StageTag'
import { SavedViewManager } from '@/components/ui/SavedViewManager'
import { getCompareSymbols, toggleComparedSymbol } from '@/lib/client/stock-workspace'
import { formatShortTermStrength } from '@/lib/short-term-check'

type Row = {
  ticker: string
  name: string | null
  exchange: string | null
  sector: string | null
  industry: string | null
  classification_taxonomy?: string | null
  classification_source?: string | null
  price: number | null
  volume: number | null
  avg_volume_20: number | null
  change_pct: number | null
  market_cap: number | null
  stage_code: string | null
  physical_momentum_score: number | null
  physical_force_score: number | null
  physical_energy_score: number | null
  shortTermCheckLabel?: string | null
  shortTermCheckScore?: number | null
  shortTermCheckReasons?: string[] | null
}

type UsScreenerView = {
  query: string
  exchange: string
  sector: string
  stageCode: string
  avgVolumeMin: string
  priceMin: string
  priceMax: string
  sort: string
  dir: 'asc' | 'desc'
}

type ColumnMode = 'core' | 'all'

const SORT_VALUES = new Set(['ticker', 'exchange', 'sector', 'industry', 'price', 'changePct', 'volume', 'avgVolume20', 'marketCap', 'stageCode', 'pms', 'pfs', 'pes', 'shortTermCheckScore', 'shortTermCheckLabel'])
const COLUMN_MODE_KEY = 'stockboard_us_screener_columns_v1'

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

function displayMessage(message: string | null) {
  if (!message) {
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
  const requestedLimit = parseUrlLimit(searchParams.get('limit'))
  const [rows, setRows] = useState<Row[]>([])
  const [date, setDate] = useState<string | null>(null)
  const [query, setQuery] = useState(searchParams.get('q') || '')
  const [exchange, setExchange] = useState(searchParams.get('exchange') || '')
  const [sector, setSector] = useState(searchParams.get('sector') || '')
  const [stageCode, setStageCode] = useState(searchParams.get('stageCode') || '')
  const [avgVolumeMin, setAvgVolumeMin] = useState(searchParams.get('avgVolumeMin') || '')
  const [priceMin, setPriceMin] = useState(searchParams.get('priceMin') || '')
  const [priceMax, setPriceMax] = useState(searchParams.get('priceMax') || '')
  const [sort, setSort] = useState(initialSort)
  const [dir, setDir] = useState<'asc' | 'desc'>(initialDir)
  const [loading, setLoading] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [filtersOpen, setFiltersOpen] = useState(true)
  const [columnMode, setColumnMode] = useState<ColumnMode>('core')
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const params = useMemo(() => {
    const sp = new URLSearchParams({ limit: String(requestedLimit), sort, dir })
    if (query.trim()) sp.set('q', query.trim())
    if (exchange.trim()) sp.set('exchange', exchange.trim())
    if (sector.trim()) sp.set('sector', sector.trim())
    if (stageCode.trim()) sp.set('stageCode', stageCode.trim())
    if (avgVolumeMin.trim()) sp.set('avgVolumeMin', avgVolumeMin.trim())
    if (priceMin.trim()) sp.set('priceMin', priceMin.trim())
    if (priceMax.trim()) sp.set('priceMax', priceMax.trim())
    return sp.toString()
  }, [query, exchange, sector, stageCode, avgVolumeMin, priceMin, priceMax, sort, dir, requestedLimit])

  useEffect(() => {
    let cancelled = false
    const controller = new AbortController()
    const timer = window.setTimeout(() => {
      setLoading(true)
      fetch(`/api/us/screener?${params}`, { cache: 'no-store', signal: controller.signal })
        .then((res) => res.json())
        .then((data) => {
          if (cancelled) return
          setRows(Array.isArray(data.rows) ? data.rows : [])
          setDate(data.date ?? null)
          setMessage(typeof data.message === 'string' ? data.message : null)
        })
        .catch((error) => {
          if (cancelled || (error instanceof DOMException && error.name === 'AbortError')) return
          setRows([])
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
    stageCode,
    avgVolumeMin,
    priceMin,
    priceMax,
    sort,
    dir,
  }), [query, exchange, sector, stageCode, avgVolumeMin, priceMin, priceMax, sort, dir])

  const applyView = (next: UsScreenerView) => {
    setQuery(next.query ?? '')
    setExchange(next.exchange ?? '')
    setSector(next.sector ?? '')
    setStageCode(next.stageCode ?? '')
    setAvgVolumeMin(next.avgVolumeMin ?? '')
    setPriceMin(next.priceMin ?? '')
    setPriceMax(next.priceMax ?? '')
    setSort(SORT_VALUES.has(next.sort) ? next.sort : 'ticker')
    setDir(next.dir === 'desc' ? 'desc' : 'asc')
  }

  const resetFilters = () => {
    setQuery('')
    setExchange('')
    setSector('')
    setStageCode('')
    setAvgVolumeMin('')
    setPriceMin('')
    setPriceMax('')
    setSort('ticker')
    setDir('asc')
  }

  const activeFilters = [
    query.trim() ? `検索: ${query.trim()}` : '',
    exchange.trim() ? `取引所: ${exchange.trim()}` : '',
    sector.trim() ? `業種: ${sector.trim()}` : '',
    stageCode.trim() ? `6ステージ: ${stageCode.trim()}` : '',
    avgVolumeMin.trim() ? `20日平均出来高 ≥ ${avgVolumeMin}` : '',
    priceMin.trim() ? `価格 ≥ ${priceMin}` : '',
    priceMax.trim() ? `価格 ≤ ${priceMax}` : '',
  ].filter(Boolean)

  return (
    <div className="rounded-[var(--radius-card)] border border-[var(--color-border-default)] bg-white shadow-[var(--shadow-card)]">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--color-border-default)] bg-[var(--color-surface-subtle)] px-4 py-3">
        <div>
          <div className="text-[14px] font-bold text-[var(--color-brand-900)]">USスクリーナー</div>
          <div className="mt-1 text-[11px] font-semibold text-[var(--color-text-tertiary)]">
            基準日 {date ?? '-'} / {loading ? '更新中' : `${rows.length.toLocaleString('ja-JP')}件`}
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
            条件
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
        <div className="grid gap-2 border-b border-[var(--color-border-default)] bg-white px-4 py-3 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-6">
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="AAPL / Microsoft"
            className="h-8 min-w-0 border border-[var(--color-border-default)] px-3 text-[12px] font-semibold"
          />
          <input
            value={exchange}
            onChange={(event) => setExchange(event.target.value.toUpperCase())}
            placeholder="NASDAQ / NYSE"
            className="h-8 min-w-0 border border-[var(--color-border-default)] px-3 text-[12px] font-semibold"
          />
          <input
            value={sector}
            onChange={(event) => setSector(event.target.value)}
            placeholder="セクター"
            className="h-8 min-w-0 border border-[var(--color-border-default)] px-3 text-[12px] font-semibold"
          />
          <input
            value={stageCode}
            onChange={(event) => setStageCode(event.target.value.replace(/[^1-6]/g, '').slice(0, 6))}
            placeholder="6桁ステージ"
            className="h-8 min-w-0 border border-[var(--color-border-default)] px-3 text-[12px] font-semibold"
          />
          <input
            value={avgVolumeMin}
            onChange={(event) => setAvgVolumeMin(event.target.value.replace(/[^\d]/g, ''))}
            placeholder="20日平均出来高"
            className="h-8 min-w-0 border border-[var(--color-border-default)] px-3 text-[12px] font-semibold"
          />
          <input
            value={priceMin}
            onChange={(event) => setPriceMin(event.target.value.replace(/[^\d.]/g, ''))}
            placeholder="価格下限"
            className="h-8 min-w-0 border border-[var(--color-border-default)] px-3 text-[12px] font-semibold"
          />
          <input
            value={priceMax}
            onChange={(event) => setPriceMax(event.target.value.replace(/[^\d.]/g, ''))}
            placeholder="価格上限"
            className="h-8 min-w-0 border border-[var(--color-border-default)] px-3 text-[12px] font-semibold"
          />
          <select value={sort} onChange={(event) => setSort(event.target.value)} className="h-8 min-w-0 border border-[var(--color-border-default)] px-2 text-[12px] font-bold">
            <option value="ticker">コード</option>
            <option value="exchange">取引所</option>
            <option value="sector">セクター</option>
            <option value="industry">業種</option>
            <option value="price">株価</option>
            <option value="changePct">騰落率</option>
            <option value="volume">出来高</option>
            <option value="avgVolume20">20日平均出来高</option>
            <option value="marketCap">時価総額</option>
            <option value="stageCode">6桁ステージ</option>
            <option value="shortTermCheckScore">短期チェック</option>
            <option value="pms">PMS</option>
            <option value="pfs">PFS</option>
            <option value="pes">PES</option>
          </select>
          <button type="button" onClick={() => setDir(dir === 'asc' ? 'desc' : 'asc')} className="inline-flex h-8 items-center justify-center gap-1.5 border border-[var(--color-border-default)] bg-white px-3 text-[12px] font-bold">
            {dir === 'asc' ? <ArrowUpAZ size={14} /> : <ArrowDownAZ size={14} />}
            {dir === 'asc' ? '昇順' : '降順'}
          </button>
        </div>
      )}

      <div className="max-h-[70vh] overflow-auto">
        <table className={`data-table w-full border-collapse text-left text-[12px] ${columnMode === 'all' ? 'min-w-[1280px]' : 'min-w-[920px]'}`}>
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
              <th className="px-3 py-2 text-right">出来高</th>
              {columnMode === 'all' && <th className="px-3 py-2 text-right">20日平均</th>}
              <th className="px-3 py-2 text-right">PMS/PFS/PES</th>
              {columnMode === 'all' && <th className="px-3 py-2 text-right">時価総額</th>}
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
                    {row.ticker} {row.name ?? ''}
                  </Link>
                </td>
                {columnMode === 'all' && <td className="px-3 py-2 font-semibold">{row.exchange ?? '-'}</td>}
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
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={columnMode === 'all' ? 12 : 9} className="px-3 py-8 text-center text-[12px] font-bold text-[var(--color-text-tertiary)]">
                  {loading
                    ? 'USデータを確認しています...'
                    : displayMessage(message)}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}
