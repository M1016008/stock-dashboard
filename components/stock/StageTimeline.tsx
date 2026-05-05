// components/stock/StageTimeline.tsx
'use client'

import { useEffect, useState } from 'react'
import { STAGE_BORDER_COLORS, STAGE_LABELS } from '@/lib/hex-stage'

interface StageEntry {
  date: string
  daily_a_stage: number | null
  daily_b_stage: number | null
  weekly_a_stage: number | null
  weekly_b_stage: number | null
  monthly_a_stage: number | null
  monthly_b_stage: number | null
  close: number
}

interface StageTimelineProps {
  ticker: string
}

const SYSTEMS: { key: keyof StageEntry; label: string }[] = [
  { key: 'daily_a_stage', label: '日足A' },
  { key: 'daily_b_stage', label: '日足B' },
  { key: 'weekly_a_stage', label: '週足A' },
  { key: 'weekly_b_stage', label: '週足B' },
  { key: 'monthly_a_stage', label: '月足A' },
  { key: 'monthly_b_stage', label: '月足B' },
]

/**
 * 過去 N 週間の各週末ステージをグリッド表示。
 * 行: 日足A/B、週足A/B、月足A/B
 * 列: 各週末日付
 */
export function StageTimeline({ ticker }: StageTimelineProps) {
  const [entries, setEntries] = useState<StageEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [weeks, setWeeks] = useState(13)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError('')
    fetch(`/api/stage-history/${encodeURIComponent(ticker)}?weeks=${weeks}`)
      .then((r) => r.json())
      .then((d) => {
        if (cancelled) return
        if (d.error) throw new Error(d.error)
        setEntries(d.history ?? [])
      })
      .catch((e) => { if (!cancelled) setError((e as Error).message) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [ticker, weeks])

  return (
    <div className="card" style={{ padding: '12px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
        <div>
          <div style={{ fontSize: '11px', fontWeight: 600 }}>ステージ変遷（週ごと）</div>
          <div style={{ fontSize: '10px', color: 'var(--text-muted)' }}>各週末時点の3本MA配列</div>
        </div>
        <div style={{ display: 'inline-flex', border: '1px solid var(--border-base)', borderRadius: 'var(--radius-sm)', overflow: 'hidden' }}>
          {[13, 26, 52].map((w) => (
            <button
              key={w}
              onClick={() => setWeeks(w)}
              style={{
                padding: '3px 10px',
                fontSize: '10px',
                fontFamily: 'var(--font-mono)',
                background: weeks === w ? 'var(--accent-primary)' : 'transparent',
                color: weeks === w ? '#fff' : 'var(--text-secondary)',
                border: 'none',
                cursor: 'pointer',
              }}
            >
              {w}W
            </button>
          ))}
        </div>
      </div>

      {error && <p style={{ fontSize: '11px', color: 'var(--price-down)' }}>エラー: {error}</p>}

      {loading ? (
        <p style={{ fontSize: '11px', color: 'var(--text-muted)', textAlign: 'center', padding: '16px 0' }}>計算中...</p>
      ) : entries.length === 0 ? (
        <p style={{ fontSize: '11px', color: 'var(--text-muted)', textAlign: 'center', padding: '16px 0' }}>データなし</p>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '10px' }}>
            <thead>
              <tr>
                <th style={{ ...stickyTh, textAlign: 'left' }}>系統</th>
                {entries.map((e) => (
                  <th key={e.date} style={th}>{e.date.slice(5)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {SYSTEMS.map((sys) => (
                <tr key={sys.key}>
                  <td style={{ ...stickyTd, fontWeight: 600 }}>{sys.label}</td>
                  {entries.map((e) => {
                    const v = e[sys.key] as number | null
                    return (
                      <td key={e.date} style={td}>
                        {v ? (
                          <span
                            title={`S${v}: ${STAGE_LABELS[v]}`}
                            style={{
                              display: 'inline-flex',
                              alignItems: 'center',
                              justifyContent: 'center',
                              width: '20px',
                              height: '20px',
                              borderRadius: '3px',
                              background: STAGE_BORDER_COLORS[v],
                              color: '#fff',
                              fontWeight: 700,
                              fontSize: '10px',
                              fontFamily: 'var(--font-mono)',
                            }}
                          >{v}</span>
                        ) : (
                          <span style={{ color: 'var(--text-muted)' }}>-</span>
                        )}
                      </td>
                    )
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

const th: React.CSSProperties = {
  padding: '4px 6px',
  fontFamily: 'var(--font-mono)',
  color: 'var(--text-muted)',
  fontSize: '9px',
  textAlign: 'center',
  fontWeight: 500,
  whiteSpace: 'nowrap',
}

const stickyTh: React.CSSProperties = {
  padding: '4px 8px',
  fontSize: '10px',
  color: 'var(--text-muted)',
  fontWeight: 500,
  position: 'sticky',
  left: 0,
  background: 'var(--bg-elevated)',
  whiteSpace: 'nowrap',
}

const td: React.CSSProperties = {
  padding: '4px 6px',
  textAlign: 'center',
  borderBottom: '1px solid var(--border-subtle)',
}

const stickyTd: React.CSSProperties = {
  padding: '4px 8px',
  fontSize: '11px',
  color: 'var(--text-primary)',
  position: 'sticky',
  left: 0,
  background: 'var(--bg-surface)',
  whiteSpace: 'nowrap',
  borderBottom: '1px solid var(--border-subtle)',
}
