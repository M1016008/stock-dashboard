// components/stock/PerformanceCard.tsx
'use client'

import { useEffect, useState } from 'react'
import type { OHLCV } from '@/types/stock'

interface PerformanceCardProps {
  ticker: string
  market?: 'JP' | 'US'
  embedded?: boolean
  analysisDate?: string | null
}

interface PerfRow {
  label: string
  value: number | null
}

interface YtdInfo {
  high: number | null
  highDate: string | null
  low: number | null
  lowDate: string | null
  returnPct: number | null
}

function pctFromHistory(ohlcv: OHLCV[], periodsBack: number): number | null {
  if (ohlcv.length <= periodsBack) return null
  const last = ohlcv[ohlcv.length - 1]?.close
  const prev = ohlcv[ohlcv.length - 1 - periodsBack]?.close
  if (last == null || prev == null || prev === 0) return null
  return ((last - prev) / prev) * 100
}

function pctYearToDate(ohlcv: OHLCV[]): number | null {
  const last = ohlcv[ohlcv.length - 1]
  if (!last?.date || last.close == null) return null
  const year = String(last.date).slice(0, 4)
  const first = ohlcv.find((row) => String(row.date).startsWith(year) && row.close != null)
  if (!first?.close) return null
  return ((last.close - first.close) / first.close) * 100
}

function yearToDateInfo(ohlcv: OHLCV[]): YtdInfo {
  const last = ohlcv[ohlcv.length - 1]
  if (!last?.date) return { high: null, highDate: null, low: null, lowDate: null, returnPct: null }
  const year = String(last.date).slice(0, 4)
  const rows = ohlcv.filter((row) => String(row.date).startsWith(year))
  const first = rows[0]
  const high = rows.reduce<OHLCV | null>((best, row) => {
    if (row.high == null) return best
    return !best || row.high > best.high ? row : best
  }, null)
  const low = rows.reduce<OHLCV | null>((best, row) => {
    if (row.low == null) return best
    return !best || row.low < best.low ? row : best
  }, null)
  return {
    high: high?.high ?? null,
    highDate: high?.date ?? null,
    low: low?.low ?? null,
    lowDate: low?.date ?? null,
    returnPct: first?.close && last.close ? ((last.close - first.close) / first.close) * 100 : null,
  }
}

/**
 * 直近の変化率を一目で確認できるカード
 * 1日 / 1週 / 1ヶ月 / 3ヶ月 / 6ヶ月 / 年初来
 */
export function PerformanceCard({
  ticker,
  market = 'JP',
  embedded = false,
  analysisDate = null,
}: PerformanceCardProps) {
  const [perf, setPerf] = useState<PerfRow[]>([])
  const [ytd, setYtd] = useState<YtdInfo | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setPerf([])
    setYtd(null)
    const period = analysisDate ? 'all' : '1y'
    const historyPath = market === 'US' ? '/api/us/history' : '/api/history'
    fetch(`${historyPath}/${encodeURIComponent(ticker)}?period=${period}`, { cache: 'no-store' })
      .then((r) => r.json())
      .then((d: OHLCV[] | { error: string }) => {
        if (cancelled || !Array.isArray(d)) return
        const rows = analysisDate ? d.filter((row) => row.date <= analysisDate).slice(-260) : d
        setPerf([
          { label: '1日', value: pctFromHistory(rows, 1) },
          { label: '1週', value: pctFromHistory(rows, 5) },
          { label: '1ヶ月', value: pctFromHistory(rows, 21) },
          { label: '3ヶ月', value: pctFromHistory(rows, 63) },
          { label: '6ヶ月', value: pctFromHistory(rows, 126) },
          { label: '年初来', value: pctYearToDate(rows) },
        ])
        setYtd(yearToDateInfo(rows))
      })
      .catch(() => { /* ignore */ })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [analysisDate, market, ticker])

  const formatPrice = (value: number | null) => {
    if (value == null) return '---'
    return new Intl.NumberFormat(market === 'US' ? 'en-US' : 'ja-JP', {
      style: 'currency',
      currency: market === 'US' ? 'USD' : 'JPY',
      maximumFractionDigits: market === 'US' ? 2 : 0,
    }).format(value)
  }

  return (
    <div className={embedded ? '' : 'card stock-performance-card'} style={embedded ? { minWidth: 0 } : undefined}>
      <div style={{ fontSize: '11px', fontWeight: 600, marginBottom: '8px' }}>
        {analysisDate ? `${analysisDate}時点の変化率` : '直近の変化率'}
      </div>
      <div className="stock-perf-grid">
        {perf.length === 0 && loading && (
          <div style={{ gridColumn: 'span 6', textAlign: 'center', fontSize: '11px', color: 'var(--text-muted)' }}>計算中...</div>
        )}
        {perf.map(({ label, value }) => {
          const isUp = (value ?? 0) >= 0
          const color = value == null ? 'var(--text-muted)' : isUp ? 'var(--price-up)' : 'var(--price-down)'
          return (
            <div key={label} style={{
              padding: '8px',
              background: 'var(--bg-elevated)',
              borderRadius: 'var(--radius-sm)',
              textAlign: 'center',
              border: '1px solid var(--border-subtle)',
            }}>
              <div style={{ fontSize: '10px', color: 'var(--text-muted)', marginBottom: '2px' }}>{label}</div>
              <div style={{ fontFamily: 'var(--font-mono)', fontSize: '13px', fontWeight: 600, color }}>
                {value == null ? '---' : `${isUp ? '+' : ''}${value.toFixed(2)}%`}
              </div>
            </div>
          )
        })}
      </div>
      {ytd && (
        <div className="stock-ytd-strip">
          <div>
            <span>年初来高値</span>
            <strong>{formatPrice(ytd.high)}</strong>
            <small>{ytd.highDate ?? '-'}</small>
          </div>
          <div>
            <span>年初来安値</span>
            <strong>{formatPrice(ytd.low)}</strong>
            <small>{ytd.lowDate ?? '-'}</small>
          </div>
          <div>
            <span>年初来騰落率</span>
            <strong className={(ytd.returnPct ?? 0) >= 0 ? 'price-up' : 'price-down'}>
              {ytd.returnPct == null ? '---' : `${ytd.returnPct >= 0 ? '+' : ''}${ytd.returnPct.toFixed(2)}%`}
            </strong>
            <small>暦年初の最初の取引日から</small>
          </div>
        </div>
      )}
    </div>
  )
}
