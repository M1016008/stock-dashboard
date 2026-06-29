'use client'

import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import { useEffect, useMemo, useState } from 'react'
import { StageTag } from '@/components/ui/StageTag'

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

const SORT_VALUES = new Set(['ticker', 'exchange', 'sector', 'industry', 'price', 'changePct', 'volume', 'avgVolume20', 'marketCap', 'stageCode', 'pms', 'pfs', 'pes', 'shortTermCheckScore', 'shortTermCheckLabel'])

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
    return 'USデータが未取得です。`npm run batch:us-universe && npm run batch:us-ohlcv && npm run batch:us-snapshots` を実行してください。'
  }
  if (message.includes('snapshots are not generated')) {
    return 'USステージデータが未生成です。Tiingo取得後に `npm run batch:us-snapshots` を実行してください。'
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
    setLoading(true)
    fetch(`/api/us/screener?${params}`, { cache: 'no-store' })
      .then((res) => res.json())
      .then((data) => {
        if (cancelled) return
        setRows(Array.isArray(data.rows) ? data.rows : [])
        setDate(data.date ?? null)
        setMessage(typeof data.message === 'string' ? data.message : null)
      })
      .catch((error) => {
        if (cancelled) return
        setRows([])
        setMessage(error instanceof Error ? error.message : 'USスクリーナーAPIの取得に失敗しました。')
      })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [params])

  return (
    <div className="rounded-[var(--radius-card)] border border-[var(--color-border-default)] bg-white shadow-[var(--shadow-card)]">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--color-border-default)] bg-[var(--color-surface-subtle)] px-4 py-3">
        <div>
          <div className="text-[14px] font-bold text-[var(--color-brand-900)]">USスクリーナー</div>
          <div className="mt-1 text-[11px] font-semibold text-[var(--color-text-tertiary)]">基準日 {date ?? '-'} / Tiingo EOD</div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="AAPL / Microsoft"
            className="h-8 rounded-[4px] border border-[var(--color-border-default)] px-3 text-[12px] font-semibold"
          />
          <input
            value={exchange}
            onChange={(event) => setExchange(event.target.value.toUpperCase())}
            placeholder="NASDAQ / NYSE"
            className="h-8 w-[130px] rounded-[4px] border border-[var(--color-border-default)] px-3 text-[12px] font-semibold"
          />
          <input
            value={sector}
            onChange={(event) => setSector(event.target.value)}
            placeholder="セクター"
            className="h-8 w-[130px] rounded-[4px] border border-[var(--color-border-default)] px-3 text-[12px] font-semibold"
          />
          <input
            value={stageCode}
            onChange={(event) => setStageCode(event.target.value.replace(/[^1-6]/g, '').slice(0, 6))}
            placeholder="6桁 prefix"
            className="h-8 w-[100px] rounded-[4px] border border-[var(--color-border-default)] px-3 text-[12px] font-semibold"
          />
          <input
            value={avgVolumeMin}
            onChange={(event) => setAvgVolumeMin(event.target.value.replace(/[^\d]/g, ''))}
            placeholder="20日平均出来高"
            className="h-8 w-[130px] rounded-[4px] border border-[var(--color-border-default)] px-3 text-[12px] font-semibold"
          />
          <input
            value={priceMin}
            onChange={(event) => setPriceMin(event.target.value.replace(/[^\d.]/g, ''))}
            placeholder="価格下限"
            className="h-8 w-[90px] rounded-[4px] border border-[var(--color-border-default)] px-3 text-[12px] font-semibold"
          />
          <input
            value={priceMax}
            onChange={(event) => setPriceMax(event.target.value.replace(/[^\d.]/g, ''))}
            placeholder="価格上限"
            className="h-8 w-[90px] rounded-[4px] border border-[var(--color-border-default)] px-3 text-[12px] font-semibold"
          />
          <select value={sort} onChange={(event) => setSort(event.target.value)} className="h-8 rounded-[4px] border border-[var(--color-border-default)] px-2 text-[12px] font-bold">
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
          <button type="button" onClick={() => setDir(dir === 'asc' ? 'desc' : 'asc')} className="h-8 rounded-[4px] border border-[var(--color-border-default)] bg-white px-3 text-[12px] font-bold">
            {dir === 'asc' ? '昇順' : '降順'}
          </button>
        </div>
      </div>
      <div className="overflow-x-auto">
        <table className="min-w-[1280px] w-full border-collapse text-left text-[12px]">
          <thead>
            <tr className="border-b border-[var(--color-border-default)] bg-white text-[11px] font-bold text-[var(--color-text-secondary)]">
              <th className="px-3 py-2">銘柄</th>
              <th className="px-3 py-2">取引所</th>
              <th className="px-3 py-2">業種</th>
              <th className="px-3 py-2">6桁</th>
              <th className="px-3 py-2">短期チェック</th>
              <th className="px-3 py-2 text-right">株価</th>
              <th className="px-3 py-2 text-right">騰落率</th>
              <th className="px-3 py-2 text-right">出来高</th>
              <th className="px-3 py-2 text-right">20日平均</th>
              <th className="px-3 py-2 text-right">PMS/PFS/PES</th>
              <th className="px-3 py-2 text-right">時価総額</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.ticker} className="border-b border-[var(--color-border-subtle)]">
                <td className="px-3 py-2">
                  <Link href={`/us/stock/${row.ticker}`} className="font-bold text-[var(--color-brand-900)] hover:text-[var(--color-market-red)]">
                    {row.ticker} {row.name ?? ''}
                  </Link>
                </td>
                <td className="px-3 py-2 font-semibold">{row.exchange ?? '-'}</td>
                <td className="px-3 py-2 font-semibold">
                  <div>{row.sector ?? '-'}</div>
                  {row.industry && <div className="mt-0.5 text-[10px] text-[var(--color-text-tertiary)]">{row.industry}</div>}
                </td>
                <td className="px-3 py-2"><StageCode code={row.stage_code} /></td>
                <td className="px-3 py-2">
                  <div className={`inline-flex items-center rounded-full border px-2 py-1 text-[10px] font-black ${shortTermClass(row.shortTermCheckLabel)}`}>
                    {row.shortTermCheckLabel ?? '中立'}
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
                <td className="px-3 py-2 text-right font-semibold">{row.avg_volume_20 == null ? '-' : Math.round(row.avg_volume_20).toLocaleString('en-US')}</td>
                <td className="px-3 py-2 text-right font-semibold">
                  <span className="font-bold text-[var(--color-brand-900)]">{fmtScore(row.physical_momentum_score)}</span>
                  <span className="mx-1 text-[var(--color-text-tertiary)]">/</span>
                  {fmtScore(row.physical_force_score)}
                  <span className="mx-1 text-[var(--color-text-tertiary)]">/</span>
                  {fmtScore(row.physical_energy_score)}
                </td>
                <td className="px-3 py-2 text-right font-semibold">{fmtCap(row.market_cap)}</td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={11} className="px-3 py-8 text-center text-[12px] font-bold text-[var(--color-text-tertiary)]">
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
