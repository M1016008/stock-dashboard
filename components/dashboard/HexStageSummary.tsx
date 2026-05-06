// components/dashboard/HexStageSummary.tsx
'use client'

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'

interface HexRow {
  code: string
  sector_large: string
  daily_a_stage: number | null
  weekly_a_stage: number | null
  monthly_a_stage: number | null
}

const STAGE_META = [
  { stage: 1, label: 'S1', color: 'var(--stage-1)' },
  { stage: 2, label: 'S2', color: 'var(--stage-2)' },
  { stage: 3, label: 'S3', color: 'var(--stage-3)' },
  { stage: 4, label: 'S4', color: 'var(--stage-4)' },
  { stage: 5, label: 'S5', color: 'var(--stage-5)' },
  { stage: 6, label: 'S6', color: 'var(--stage-6)' },
]

const TIMEFRAMES: { key: 'daily' | 'weekly' | 'monthly'; label: string }[] = [
  { key: 'daily', label: '日足' },
  { key: 'weekly', label: '週足' },
  { key: 'monthly', label: '月足' },
]

type Market = 'JP' | 'US' | 'ALL'

/**
 * HEXステージ分布
 * - 日/週/月の3タイムフレームを切替
 * - 市場（JP/US/ALL）切替
 * - 全体分布 + 業種別分布
 */
export function HexStageSummary() {
  const [rows, setRows] = useState<HexRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [market] = useState<Market>('JP')
  const [timeframe, setTimeframe] = useState<'daily' | 'weekly' | 'monthly'>('daily')

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError('')
    fetch(`/api/hex?market=${market}&timeframe=daily`)
      .then((r) => r.json())
      .then((d) => {
        if (cancelled) return
        if (d.error) throw new Error(d.error)
        setRows(d.data ?? [])
      })
      .catch((e) => {
        if (!cancelled) setError((e as Error).message)
      })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [market])

  /** 選択された timeframe に応じた銘柄ステージを返す */
  const stageOf = (row: HexRow): number | null => {
    if (timeframe === 'daily') return row.daily_a_stage
    if (timeframe === 'weekly') return row.weekly_a_stage
    return row.monthly_a_stage
  }

  /** 全体集計 */
  const totalDist = useMemo(() => {
    const tally: Record<number, number> = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0 }
    for (const r of rows) {
      const s = stageOf(r)
      if (s != null && s >= 1 && s <= 6) tally[s] += 1
    }
    return tally
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, timeframe])

  /** 業種別集計 */
  const sectorDist = useMemo(() => {
    const map = new Map<string, Record<number, number>>()
    for (const r of rows) {
      const s = stageOf(r)
      if (s == null || s < 1 || s > 6) continue
      const sec = r.sector_large || 'その他'
      if (!map.has(sec)) map.set(sec, { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0 })
      map.get(sec)![s] += 1
    }
    return Array.from(map.entries())
      .map(([sector, dist]) => ({
        sector,
        dist,
        total: Object.values(dist).reduce((a, b) => a + b, 0),
      }))
      .sort((a, b) => b.total - a.total)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, timeframe])

  const total = rows.length

  return (
    <div className="card" style={{ padding: '12px' }}>
      {/* 切替コントロール（時間軸のみ） */}
      <div style={{ display: 'flex', gap: '8px', marginBottom: '10px', flexWrap: 'wrap' }}>
        <ToggleGroup
          options={TIMEFRAMES.map((t) => ({ v: t.key, label: t.label }))}
          value={timeframe}
          onChange={(v) => setTimeframe(v as 'daily' | 'weekly' | 'monthly')}
        />
      </div>

      {error && (
        <p style={{ fontSize: '11px', color: 'var(--price-down)', margin: '6px 0' }}>エラー: {error}</p>
      )}

      {/* 全体分布 */}
      <div style={{ marginBottom: '12px' }}>
        {STAGE_META.map(({ stage, label, color }) => {
          const count = totalDist[stage] ?? 0
          const ratio = total > 0 ? (count / total) * 100 : 0
          return (
            <div key={stage} style={{
              display: 'flex',
              alignItems: 'center',
              gap: '8px',
              marginBottom: '4px',
            }}>
              <span style={{ width: '8px', height: '8px', borderRadius: '1px', background: color, flexShrink: 0 }} />
              <span style={{ fontSize: '11px', color: 'var(--text-secondary)', width: '24px' }}>{label}</span>
              <div style={{ flex: 1, height: '4px', background: 'var(--border-dim)', borderRadius: '2px' }}>
                <div style={{ width: `${ratio}%`, height: '100%', background: color, borderRadius: '2px' }} />
              </div>
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: '11px', color: 'var(--text-muted)', width: '34px', textAlign: 'right' }}>
                {loading ? '---' : count}
              </span>
            </div>
          )
        })}
      </div>

      <div style={{ fontSize: '10px', color: 'var(--text-muted)', marginBottom: '8px' }}>
        {loading ? '計算中...' : `母集団: ${total}銘柄`}
      </div>

      {/* 業種別分布 */}
      {!loading && sectorDist.length > 0 && (
        <div style={{ marginTop: '10px', borderTop: '1px solid var(--border-subtle)', paddingTop: '10px' }}>
          <div style={{ fontSize: '10px', color: 'var(--text-muted)', marginBottom: '6px', fontWeight: 600 }}>
            業種別ステージ分布
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
            {sectorDist.map(({ sector, dist, total: secTotal }) => (
              <div key={sector} style={{ fontSize: '10px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '2px' }}>
                  <span style={{ color: 'var(--text-secondary)' }}>{sector}</span>
                  <span style={{ color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>{secTotal}</span>
                </div>
                {/* 横並びの色付きバー */}
                <div style={{ display: 'flex', height: '6px', borderRadius: '2px', overflow: 'hidden', background: 'var(--border-dim)' }}>
                  {STAGE_META.map(({ stage, color }) => {
                    const count = dist[stage] ?? 0
                    const w = secTotal > 0 ? (count / secTotal) * 100 : 0
                    return (
                      <div
                        key={stage}
                        title={`S${stage}: ${count}`}
                        style={{ width: `${w}%`, background: color }}
                      />
                    )
                  })}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      <div style={{ marginTop: '10px' }}>
        <Link href="/hex-stage" style={{ fontSize: '10px', color: 'var(--accent-primary)', textDecoration: 'none' }}>
          マップを見る →
        </Link>
      </div>
    </div>
  )
}

interface ToggleGroupProps<T extends string> {
  options: { v: T; label: string }[]
  value: T
  onChange: (v: T) => void
}

function ToggleGroup<T extends string>({ options, value, onChange }: ToggleGroupProps<T>) {
  return (
    <div style={{
      display: 'inline-flex',
      border: '1px solid var(--border-base)',
      borderRadius: 'var(--radius-sm)',
      overflow: 'hidden',
    }}>
      {options.map((o) => (
        <button
          key={o.v}
          onClick={() => onChange(o.v)}
          style={{
            padding: '3px 8px',
            fontSize: '10px',
            fontFamily: 'var(--font-mono)',
            background: value === o.v ? 'var(--accent-primary)' : 'transparent',
            color: value === o.v ? '#fff' : 'var(--text-secondary)',
            border: 'none',
            cursor: 'pointer',
          }}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}
