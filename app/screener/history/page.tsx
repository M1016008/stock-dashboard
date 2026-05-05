// app/screener/history/page.tsx
'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'

interface DateEntry {
  date: string
  count: number
}

interface SnapshotRow {
  id: number
  date: string
  code: string
  name: string
  marketSegment: string | null
  close: number
  changePercent: number | null
  rsi14: number | null
  macd: number | null
  isYearHigh: boolean | null
  isYearLow: boolean | null
  maOrderBullish: boolean | null
  maOrderBearish: boolean | null
}

export default function ScreenerHistoryPage() {
  const [dates, setDates] = useState<DateEntry[]>([])
  const [selectedDate, setSelectedDate] = useState<string | null>(null)
  const [rows, setRows] = useState<SnapshotRow[]>([])
  const [filter, setFilter] = useState<'all' | 'yearHigh' | 'yearLow' | 'bullish' | 'bearish'>('all')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  // 利用可能な日付を取得
  useEffect(() => {
    setLoading(true)
    fetch('/api/screener/history')
      .then((r) => r.json())
      .then((d) => {
        setDates(d.dates ?? [])
        if (d.dates && d.dates.length > 0) setSelectedDate(d.dates[0].date)
      })
      .catch((e) => setError((e as Error).message))
      .finally(() => setLoading(false))
  }, [])

  // 選択された日付の詳細を取得
  useEffect(() => {
    if (!selectedDate) return
    setLoading(true)
    fetch(`/api/screener/history?date=${encodeURIComponent(selectedDate)}`)
      .then((r) => r.json())
      .then((d) => setRows(d.results ?? []))
      .catch((e) => setError((e as Error).message))
      .finally(() => setLoading(false))
  }, [selectedDate])

  const filtered = rows.filter((r) => {
    if (filter === 'yearHigh') return r.isYearHigh
    if (filter === 'yearLow') return r.isYearLow
    if (filter === 'bullish') return r.maOrderBullish
    if (filter === 'bearish') return r.maOrderBearish
    return true
  })

  return (
    <div style={{ padding: '16px', display: 'flex', flexDirection: 'column', gap: '16px' }}>
      <div style={{ borderBottom: '1px solid var(--border-subtle)', paddingBottom: '12px' }}>
        <h1 style={{ fontFamily: 'var(--font-display)', fontSize: '16px', fontWeight: 700 }}>📅 スクリーナー履歴</h1>
        <p style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '2px' }}>
          引け後に蓄積したスナップショットを日付指定で参照
        </p>
      </div>

      {dates.length === 0 && !loading && (
        <div className="card" style={{ padding: '24px' }}>
          <h3 style={{ fontSize: '13px', marginBottom: '8px' }}>📦 履歴がありません</h3>
          <p style={{ fontSize: '12px', color: 'var(--text-muted)', lineHeight: 1.6 }}>
            スナップショット収集スクリプトを実行してください:
            <br />
            <code style={{ display: 'inline-block', marginTop: '6px', padding: '6px 8px', background: 'var(--bg-void)', borderRadius: '2px' }}>
              npx tsx scripts/collect-snapshot.ts
            </code>
            <br />
            通常は引け後（16:30 以降）に毎日実行することを想定しています。
          </p>
        </div>
      )}

      {dates.length > 0 && (
        <>
          {/* 日付選択 */}
          <div className="card" style={{ padding: '12px' }}>
            <div className="section-header">日付を選択</div>
            <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
              {dates.map((d) => (
                <button
                  key={d.date}
                  onClick={() => setSelectedDate(d.date)}
                  style={{
                    padding: '5px 10px',
                    fontSize: '11px',
                    fontFamily: 'var(--font-mono)',
                    background: selectedDate === d.date ? 'var(--accent-dim)' : 'var(--bg-surface)',
                    border: `1px solid ${selectedDate === d.date ? 'rgba(245,166,35,0.5)' : 'var(--border-base)'}`,
                    borderRadius: 'var(--radius-sm)',
                    color: selectedDate === d.date ? 'var(--accent-primary)' : 'var(--text-secondary)',
                    cursor: 'pointer',
                  }}
                >
                  {d.date} <span style={{ color: 'var(--text-muted)' }}>({d.count})</span>
                </button>
              ))}
            </div>
          </div>

          {/* フィルタ */}
          <div style={{ display: 'flex', gap: '8px' }}>
            {([
              { key: 'all', label: '全件' },
              { key: 'yearHigh', label: '年初来高値' },
              { key: 'yearLow', label: '年初来安値' },
              { key: 'bullish', label: 'MA上昇配列' },
              { key: 'bearish', label: 'MA下降配列' },
            ] as const).map((f) => (
              <button
                key={f.key}
                onClick={() => setFilter(f.key)}
                style={{
                  padding: '5px 12px',
                  fontSize: '11px',
                  fontFamily: 'var(--font-mono)',
                  background: filter === f.key ? 'var(--accent-dim)' : 'var(--bg-surface)',
                  border: `1px solid ${filter === f.key ? 'rgba(245,166,35,0.5)' : 'var(--border-base)'}`,
                  borderRadius: 'var(--radius-sm)',
                  color: filter === f.key ? 'var(--accent-primary)' : 'var(--text-muted)',
                  cursor: 'pointer',
                }}
              >
                {f.label}
              </button>
            ))}
          </div>

          {/* 結果テーブル */}
          {error && (
            <div className="card" style={{ padding: '12px', borderLeft: '3px solid var(--price-down)' }}>
              <p style={{ fontSize: '12px', color: 'var(--price-down)', margin: 0 }}>エラー: {error}</p>
            </div>
          )}

          {filtered.length > 0 ? (
            <div className="card" style={{ overflow: 'hidden' }}>
              <div style={{ padding: '8px 12px', borderBottom: '1px solid var(--border-subtle)' }}>
                <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
                  {filtered.length}件 / 全 {rows.length}件
                </span>
              </div>
              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '12px' }}>
                  <thead>
                    <tr style={{ background: 'var(--bg-elevated)', borderBottom: '1px solid var(--border-dim)' }}>
                      <th style={headStyle}>銘柄</th>
                      <th style={headStyleR}>終値</th>
                      <th style={headStyleR}>前日比%</th>
                      <th style={headStyleR}>RSI(14)</th>
                      <th style={headStyleR}>MACD</th>
                      <th style={headStyleR}>シグナル</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filtered.map((r) => (
                      <tr key={r.id} style={{ borderBottom: '1px solid var(--border-subtle)' }}>
                        <td style={{ padding: '7px 12px' }}>
                          <Link
                            href={`/stock/${encodeURIComponent(r.code)}`}
                            style={{ color: 'var(--accent-primary)', fontFamily: 'var(--font-mono)', textDecoration: 'none' }}
                          >
                            {r.code.replace('.T', '')}
                          </Link>
                          <span style={{ marginLeft: '6px', fontSize: '11px', color: 'var(--text-secondary)' }}>{r.name}</span>
                        </td>
                        <td style={cellR}>{r.close.toLocaleString()}</td>
                        <td style={{ ...cellR, color: (r.changePercent ?? 0) >= 0 ? 'var(--price-up)' : 'var(--price-down)' }}>
                          {r.changePercent !== null ? `${r.changePercent >= 0 ? '+' : ''}${r.changePercent.toFixed(2)}%` : '---'}
                        </td>
                        <td style={cellR}>{r.rsi14?.toFixed(1) ?? '---'}</td>
                        <td style={cellR}>{r.macd?.toFixed(2) ?? '---'}</td>
                        <td style={{ padding: '7px 12px', textAlign: 'right', fontSize: '11px' }}>
                          {r.isYearHigh && <Badge color="var(--price-up)" label="年高" />}
                          {r.isYearLow && <Badge color="var(--price-down)" label="年安" />}
                          {r.maOrderBullish && <Badge color="var(--price-up)" label="↑配列" />}
                          {r.maOrderBearish && <Badge color="var(--price-down)" label="↓配列" />}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ) : (
            !loading && (
              <div className="card" style={{ padding: '24px', textAlign: 'center' }}>
                <p style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
                  該当する銘柄がありません
                </p>
              </div>
            )
          )}
        </>
      )}
    </div>
  )
}

function Badge({ color, label }: { color: string; label: string }) {
  return (
    <span style={{
      display: 'inline-block',
      marginLeft: '4px',
      padding: '1px 6px',
      fontSize: '10px',
      fontFamily: 'var(--font-mono)',
      color,
      border: `1px solid ${color}`,
      borderRadius: '2px',
    }}>
      {label}
    </span>
  )
}

const headStyle: React.CSSProperties = {
  padding: '8px 12px',
  textAlign: 'left',
  fontFamily: 'var(--font-mono)',
  fontWeight: 500,
  color: 'var(--text-muted)',
  fontSize: '11px',
}

const headStyleR: React.CSSProperties = { ...headStyle, textAlign: 'right' }

const cellR: React.CSSProperties = {
  padding: '7px 12px',
  fontFamily: 'var(--font-mono)',
  fontSize: '12px',
  textAlign: 'right',
  color: 'var(--text-primary)',
}
