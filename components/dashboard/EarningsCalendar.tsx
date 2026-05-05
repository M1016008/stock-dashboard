// components/dashboard/EarningsCalendar.tsx
'use client'

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { STAGE_BG_COLORS, STAGE_BORDER_COLORS } from '@/lib/hex-stage'

interface EarningsEntry {
  date: string
  ticker: string
  displayCode: string
  name: string
  sectorLarge: string | null
  marketSegment: string | null
  price: number | null
  marketCap: number | null
  daily_a_stage: number | null
  daily_b_stage: number | null
  weekly_a_stage: number | null
  weekly_b_stage: number | null
  monthly_a_stage: number | null
  monthly_b_stage: number | null
}

interface ApiResponse {
  entries: EarningsEntry[]
  snapshotDate: string | null
  from: string | null
  to: string | null
  notice?: string
}

type DaysOption = 7 | 14 | 30 | 60

export function EarningsCalendar({ defaultDays = 14 }: { defaultDays?: DaysOption }) {
  const [days, setDays] = useState<DaysOption>(defaultDays)
  const [data, setData] = useState<ApiResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [selectedDate, setSelectedDate] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    fetch(`/api/earnings-calendar?days=${days}`)
      .then((r) => r.json())
      .then((d) => { if (!cancelled) setData(d) })
      .catch(() => {})
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [days])

  const entriesByDate = useMemo(() => {
    const m = new Map<string, EarningsEntry[]>()
    for (const e of data?.entries ?? []) {
      const arr = m.get(e.date) ?? []
      arr.push(e)
      m.set(e.date, arr)
    }
    return m
  }, [data])

  const calendarDates = useMemo(() => {
    if (!data?.from || !data?.to) return []
    const dates: string[] = []
    const start = new Date(data.from)
    const end = new Date(data.to)
    const cur = new Date(start)
    while (cur <= end) {
      dates.push(cur.toISOString().split('T')[0])
      cur.setUTCDate(cur.getUTCDate() + 1)
    }
    return dates
  }, [data])

  const visibleEntries = selectedDate
    ? entriesByDate.get(selectedDate) ?? []
    : data?.entries ?? []

  return (
    <div className="card" style={{ overflow: 'hidden' }}>
      <div style={{
        padding: '8px 12px',
        borderBottom: '1px solid var(--border-subtle)',
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        flexWrap: 'wrap',
        gap: '8px',
      }}>
        <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
          <span style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>
            📅 決算カレンダー
          </span>
          {data?.snapshotDate && (
            <span style={{ fontSize: '10px', color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>
              ({data.snapshotDate} 時点 / {data.entries.length}件)
            </span>
          )}
        </div>
        <div style={{ display: 'flex', gap: '4px' }}>
          {([7, 14, 30, 60] as DaysOption[]).map((d) => (
            <button
              key={d}
              onClick={() => { setDays(d); setSelectedDate(null) }}
              style={{
                padding: '4px 10px',
                fontSize: '11px',
                fontFamily: 'var(--font-mono)',
                background: days === d ? 'var(--accent-primary)' : 'var(--bg-elevated)',
                color: days === d ? '#fff' : 'var(--text-secondary)',
                border: `1px solid ${days === d ? 'var(--accent-primary)' : 'var(--border-base)'}`,
                borderRadius: 'var(--radius-sm)',
                cursor: 'pointer',
              }}
            >
              {d}日
            </button>
          ))}
        </div>
      </div>

      {loading ? (
        <div style={{ padding: '24px', textAlign: 'center', fontSize: '12px', color: 'var(--text-muted)' }}>
          読込中…
        </div>
      ) : data?.notice ? (
        <div style={{ padding: '24px', textAlign: 'center', fontSize: '12px', color: 'var(--text-muted)' }}>
          ℹ️ {data.notice}
          {' '}<Link href="/admin/import" style={{ color: 'var(--accent-primary)' }}>取込ページ →</Link>
        </div>
      ) : calendarDates.length === 0 ? (
        <div style={{ padding: '24px', textAlign: 'center', fontSize: '12px', color: 'var(--text-muted)' }}>
          表示する期間がありません
        </div>
      ) : (
        <>
          {/* カレンダーグリッド */}
          <div style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(7, 1fr)',
            gap: '2px',
            padding: '8px',
            background: 'var(--bg-elevated)',
          }}>
            {['日', '月', '火', '水', '木', '金', '土'].map((d) => (
              <div key={d} style={{
                textAlign: 'center',
                fontSize: '10px',
                color: 'var(--text-muted)',
                padding: '2px',
                fontFamily: 'var(--font-mono)',
              }}>{d}</div>
            ))}
            {(() => {
              if (calendarDates.length === 0) return null
              const firstDow = new Date(calendarDates[0]).getUTCDay()
              const cells: React.ReactNode[] = []
              for (let i = 0; i < firstDow; i++) {
                cells.push(<div key={`pad-${i}`} />)
              }
              for (const d of calendarDates) {
                const list = entriesByDate.get(d) ?? []
                const isSelected = selectedDate === d
                const dayDate = new Date(d)
                const dow = dayDate.getUTCDay()
                const isToday = d === new Date().toISOString().split('T')[0]
                const dayNum = dayDate.getUTCDate()

                cells.push(
                  <button
                    key={d}
                    onClick={() => setSelectedDate(isSelected ? null : d)}
                    style={{
                      padding: '6px 4px',
                      minHeight: '52px',
                      background: isSelected
                        ? 'var(--accent-primary)'
                        : list.length > 0
                          ? 'rgba(217,119,6,0.10)'
                          : 'var(--bg-surface)',
                      color: isSelected
                        ? '#fff'
                        : dow === 0 ? 'var(--price-down, #ef4444)'
                        : dow === 6 ? '#3b82f6'
                        : 'var(--text-primary)',
                      border: `1px solid ${isToday ? 'var(--accent-primary)' : 'var(--border-base)'}`,
                      borderRadius: 'var(--radius-sm)',
                      cursor: 'pointer',
                      fontSize: '11px',
                      fontFamily: 'var(--font-mono)',
                      display: 'flex',
                      flexDirection: 'column',
                      alignItems: 'center',
                      justifyContent: 'flex-start',
                      gap: '2px',
                    }}
                  >
                    <span style={{ fontWeight: 600 }}>{dayNum}</span>
                    {list.length > 0 && (
                      <span style={{
                        fontSize: '9px',
                        padding: '0 4px',
                        background: isSelected ? 'rgba(255,255,255,0.25)' : 'var(--accent-primary)',
                        color: '#fff',
                        borderRadius: '8px',
                      }}>
                        {list.length}
                      </span>
                    )}
                  </button>,
                )
              }
              return cells
            })()}
          </div>

          {/* 選択日のリスト */}
          <div style={{
            padding: '8px 12px',
            borderTop: '1px solid var(--border-subtle)',
            fontSize: '11px',
            color: 'var(--text-muted)',
            display: 'flex',
            justifyContent: 'space-between',
          }}>
            <span>
              {selectedDate ? `📌 ${selectedDate}` : `すべての決算予定 (${visibleEntries.length}件)`}
            </span>
            {selectedDate && (
              <button
                onClick={() => setSelectedDate(null)}
                style={{
                  fontSize: '10px',
                  background: 'transparent',
                  border: 'none',
                  color: 'var(--accent-primary)',
                  cursor: 'pointer',
                }}
              >
                ✕ クリア
              </button>
            )}
          </div>

          {visibleEntries.length === 0 ? (
            <div style={{ padding: '16px', textAlign: 'center', fontSize: '12px', color: 'var(--text-muted)' }}>
              該当銘柄なし
            </div>
          ) : (
            <div style={{ overflowX: 'auto', maxHeight: '420px', overflowY: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '12px' }}>
                <thead style={{ position: 'sticky', top: 0, background: 'var(--bg-elevated)', zIndex: 1 }}>
                  <tr style={{ borderBottom: '1px solid var(--border-dim)' }}>
                    <th style={th}>日付</th>
                    <th style={th}>コード</th>
                    <th style={th}>銘柄名</th>
                    <th style={thR}>株価</th>
                    <th style={thR}>時価総額</th>
                    <th style={th}>ステージ (日A/B 週A/B 月A/B)</th>
                  </tr>
                </thead>
                <tbody>
                  {visibleEntries.map((e) => (
                    <tr key={`${e.date}-${e.ticker}`} style={{ borderBottom: '1px solid var(--border-subtle)' }}>
                      <td style={{ ...td, fontFamily: 'var(--font-mono)' }}>{e.date}</td>
                      <td style={td}>
                        <Link href={`/stock/${encodeURIComponent(e.ticker)}`} style={{ color: 'var(--accent-primary)', fontFamily: 'var(--font-mono)', textDecoration: 'none', fontWeight: 600 }}>
                          {e.displayCode}
                        </Link>
                      </td>
                      <td style={td}>{e.name}</td>
                      <td style={tdR}>{e.price?.toLocaleString('ja-JP', { maximumFractionDigits: 2 }) ?? '---'}</td>
                      <td style={tdR}>{e.marketCap ? `${(e.marketCap / 1e8).toLocaleString('ja-JP', { maximumFractionDigits: 0 })} 億` : '---'}</td>
                      <td style={td}>
                        <StageDots
                          values={[e.daily_a_stage, e.daily_b_stage, e.weekly_a_stage, e.weekly_b_stage, e.monthly_a_stage, e.monthly_b_stage]}
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  )
}

function StageDots({ values }: { values: (number | null)[] }) {
  return (
    <div style={{ display: 'flex', gap: '3px' }}>
      {values.map((v, i) => (
        <span
          key={i}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: '20px',
            height: '20px',
            fontSize: '10px',
            fontWeight: 700,
            fontFamily: 'var(--font-mono)',
            background: v ? STAGE_BG_COLORS[v] : 'transparent',
            color: v ? STAGE_BORDER_COLORS[v] : 'var(--text-muted)',
            border: v ? `1px solid ${STAGE_BORDER_COLORS[v]}` : '1px dashed var(--border-base)',
            borderRadius: '4px',
          }}
          title={v ? `Stage ${v}` : '不明'}
        >
          {v ?? '-'}
        </span>
      ))}
    </div>
  )
}

const th: React.CSSProperties = {
  padding: '6px 10px',
  textAlign: 'left',
  fontFamily: 'var(--font-mono)',
  fontWeight: 500,
  color: 'var(--text-muted)',
  fontSize: '10px',
  whiteSpace: 'nowrap',
}
const thR: React.CSSProperties = { ...th, textAlign: 'right' }
const td: React.CSSProperties = { padding: '6px 10px', fontSize: '12px', color: 'var(--text-primary)' }
const tdR: React.CSSProperties = { ...td, textAlign: 'right', fontFamily: 'var(--font-mono)' }
