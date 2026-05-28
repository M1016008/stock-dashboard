'use client'

import Link from 'next/link'
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
  change_pct: number | null
  market_cap: number | null
  stage_code: string | null
}

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

function displayMessage(message: string | null) {
  if (!message) {
    return 'USデータが未取得です。`npm run batch:us-universe && npm run batch:us-ohlcv && npm run batch:us-snapshots` を実行してください。'
  }
  if (message.includes('snapshots are not generated')) {
    return 'USステージデータが未生成です。Tiingo取得後に `npm run batch:us-snapshots` を実行してください。'
  }
  return message
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

export function UsScreenerClient() {
  const [rows, setRows] = useState<Row[]>([])
  const [date, setDate] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [sort, setSort] = useState('ticker')
  const [dir, setDir] = useState<'asc' | 'desc'>('asc')
  const [loading, setLoading] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const params = useMemo(() => {
    const sp = new URLSearchParams({ limit: '200', sort, dir })
    if (query.trim()) sp.set('q', query.trim())
    return sp.toString()
  }, [query, sort, dir])

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
          <select value={sort} onChange={(event) => setSort(event.target.value)} className="h-8 rounded-[4px] border border-[var(--color-border-default)] px-2 text-[12px] font-bold">
            <option value="ticker">コード</option>
            <option value="sector">セクター</option>
            <option value="industry">業種</option>
            <option value="price">株価</option>
            <option value="changePct">騰落率</option>
            <option value="volume">出来高</option>
            <option value="marketCap">時価総額</option>
            <option value="stageCode">6桁ステージ</option>
          </select>
          <button type="button" onClick={() => setDir(dir === 'asc' ? 'desc' : 'asc')} className="h-8 rounded-[4px] border border-[var(--color-border-default)] bg-white px-3 text-[12px] font-bold">
            {dir === 'asc' ? '昇順' : '降順'}
          </button>
        </div>
      </div>
      <div className="overflow-x-auto">
        <table className="min-w-[980px] w-full border-collapse text-left text-[12px]">
          <thead>
            <tr className="border-b border-[var(--color-border-default)] bg-white text-[11px] font-bold text-[var(--color-text-secondary)]">
              <th className="px-3 py-2">銘柄</th>
              <th className="px-3 py-2">取引所</th>
              <th className="px-3 py-2">業種</th>
              <th className="px-3 py-2">6桁</th>
              <th className="px-3 py-2 text-right">株価</th>
              <th className="px-3 py-2 text-right">騰落率</th>
              <th className="px-3 py-2 text-right">出来高</th>
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
                <td className="px-3 py-2 text-right font-bold">{fmtMoney(row.price)}</td>
                <td className={`px-3 py-2 text-right font-bold ${(row.change_pct ?? 0) >= 0 ? 'text-red-700' : 'text-blue-700'}`}>{fmtPct(row.change_pct)}</td>
                <td className="px-3 py-2 text-right font-semibold">{row.volume?.toLocaleString('en-US') ?? '-'}</td>
                <td className="px-3 py-2 text-right font-semibold">{fmtCap(row.market_cap)}</td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={8} className="px-3 py-8 text-center text-[12px] font-bold text-[var(--color-text-tertiary)]">
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
