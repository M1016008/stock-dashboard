// components/stock/EarningsCard.tsx
'use client'

import { useEffect, useState } from 'react'

interface SnapshotInfo {
  ticker: string
  date: string | null
  earningsLastDate: string | null
  earningsNextDate: string | null
}

interface Props {
  ticker: string
}

export function EarningsCard({ ticker }: Props) {
  const [data, setData] = useState<SnapshotInfo | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    fetch(`/api/stock-snapshot/${encodeURIComponent(ticker)}`, { cache: 'no-store' })
      .then((r) => r.json())
      .then((d) => { if (!cancelled) setData(d) })
      .catch(() => {})
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [ticker])

  if (loading) {
    return (
      <div className="card" style={{ padding: '12px', fontSize: '11px', color: 'var(--text-muted)' }}>
        決算情報読込中…
      </div>
    )
  }

  if (!data || (!data.earningsLastDate && !data.earningsNextDate)) {
    return null
  }

  const today = new Date().toISOString().split('T')[0]
  const daysToNext = data.earningsNextDate ? daysBetween(today, data.earningsNextDate) : null
  const daysSinceLast = data.earningsLastDate ? daysBetween(data.earningsLastDate, today) : null

  return (
    <div className="card" style={{ padding: '12px', display: 'flex', gap: '24px', flexWrap: 'wrap' }}>
      <div>
        <div style={{ fontSize: '10px', color: 'var(--text-muted)', marginBottom: '2px' }}>前回決算日</div>
        <div style={{ fontSize: '14px', fontFamily: 'var(--font-mono)', fontWeight: 600, color: 'var(--text-primary)' }}>
          {formatJapaneseDate(data.earningsLastDate)}
          {daysSinceLast != null && daysSinceLast >= 0 && (
            <span style={{ marginLeft: '8px', fontSize: '11px', color: 'var(--text-secondary)' }}>
              前回決算から: {daysSinceLast}日経過
            </span>
          )}
        </div>
      </div>
      <div>
        <div style={{ fontSize: '10px', color: 'var(--text-muted)', marginBottom: '2px' }}>次回決算日</div>
        <div style={{ fontSize: '14px', fontFamily: 'var(--font-mono)', fontWeight: 600, color: 'var(--accent-primary)' }}>
          {formatJapaneseDate(data.earningsNextDate)}
          {daysToNext != null && (
            <span style={{ marginLeft: '8px', fontSize: '11px', color: daysToNext <= 7 ? 'var(--price-down, #ef4444)' : 'var(--text-secondary)' }}>
              決算まで: {daysToNext === 0 ? '本日' : daysToNext > 0 ? `あと${daysToNext}日` : `${-daysToNext}日経過`}
            </span>
          )}
        </div>
      </div>
      {data.date && (
        <div style={{ marginLeft: 'auto', fontSize: '10px', color: 'var(--text-muted)' }}>
          📅 {data.date} 時点
        </div>
      )}
    </div>
  )
}

function daysBetween(a: string, b: string): number | null {
  try {
    const ms = new Date(b).getTime() - new Date(a).getTime()
    return Math.round(ms / (1000 * 60 * 60 * 24))
  } catch {
    return null
  }
}

function formatJapaneseDate(date: string | null): string {
  if (!date) return '---'
  const [year, month, day] = date.split('-').map(Number)
  if (!year || !month || !day) return date
  return `${year}年${month}月${day}日`
}
