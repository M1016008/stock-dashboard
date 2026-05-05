// app/screener/page.tsx
'use client'

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'

type Market = 'JP' | 'US'
type AxisKey = 'daily_a' | 'daily_b' | 'weekly_a' | 'weekly_b' | 'monthly_a' | 'monthly_b'

const SEGMENTS: Record<Market, string[]> = {
  JP: ['プライム', 'スタンダード', 'グロース'],
  US: ['NYSE', 'NASDAQ'],
}

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
  price: number
  changePercent: number
  marketCap?: number
  per?: number
  pbr?: number
  roe?: number
  dividendYield?: number
  daily_a_stage: number | null
  daily_b_stage: number | null
  weekly_a_stage: number | null
  weekly_b_stage: number | null
  monthly_a_stage: number | null
  monthly_b_stage: number | null
}

export default function ScreenerPage() {
  const [market, setMarket] = useState<Market>('JP')
  const [segment, setSegment] = useState<string | null>(null)
  const [stages, setStages] = useState<Partial<Record<AxisKey, number[]>>>({})
  const [results, setResults] = useState<StockRow[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [universe, setUniverse] = useState(0)
  const [cached, setCached] = useState(false)

  const hasAnyStage = Object.values(stages).some((v) => v && v.length > 0)

  useEffect(() => {
    if (!segment || !hasAnyStage) {
      setResults([])
      return
    }
    let cancelled = false
    setLoading(true)
    setError('')
    const params = new URLSearchParams({ market, segment })
    for (const [k, v] of Object.entries(stages)) {
      if (v && v.length > 0) params.set(k, v.join(','))
    }

    fetch(`/api/screener?${params}`)
      .then((r) => r.json())
      .then((d) => {
        if (cancelled) return
        if (d.error) throw new Error(d.error)
        setResults(d.results ?? [])
        setUniverse(d.universe ?? 0)
        setCached(d.cached)
      })
      .catch((e) => { if (!cancelled) setError((e as Error).message) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [market, segment, stages, hasAnyStage])

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

  return (
    <div style={{ padding: '16px', display: 'flex', flexDirection: 'column', gap: '16px' }}>
      <div style={{ borderBottom: '1px solid var(--border-subtle)', paddingBottom: '12px' }}>
        <h1 style={{ fontFamily: 'var(--font-display)', fontSize: '16px', fontWeight: 700 }}>
          スクリーナー（マルチ軸ステージフィルタ）
        </h1>
        <p style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '2px' }}>
          市場 → 区分 → 6系統のHEXステージ（AND条件）
        </p>
      </div>

      {/* Step 1: 市場 */}
      <Section step={1} label="市場を選択">
        <ButtonRow
          options={[
            { v: 'JP', label: '日本株' },
            { v: 'US', label: '米国株' },
          ]}
          value={market}
          onChange={(v) => { setMarket(v as Market); setSegment(null); setStages({}) }}
        />
      </Section>

      {/* Step 2: 区分 */}
      <Section step={2} label={market === 'JP' ? '東証区分を選択' : '取引所を選択'}>
        <ButtonRow
          options={SEGMENTS[market].map((s) => ({ v: s, label: s }))}
          value={segment ?? ''}
          onChange={(v) => { setSegment(v); setStages({}) }}
        />
      </Section>

      {/* Step 3: マルチ軸ステージ */}
      <Section step={3} label="HEXステージを選択（複数系統 AND）" disabled={!segment}>
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

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '12px' }}>
          {AXES.map((ax) => (
            <AxisCard
              key={ax.key}
              axis={ax}
              selected={stages[ax.key] ?? []}
              disabled={!segment}
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

        {/* 選択中フィルタ条件表示 */}
        {hasAnyStage && (
          <div style={{
            marginTop: '12px',
            padding: '8px 12px',
            background: 'rgba(217,119,6,0.06)',
            border: '1px solid var(--accent-dim)',
            borderRadius: 'var(--radius-sm)',
            fontSize: '11px',
            color: 'var(--text-secondary)',
          }}>
            🔍 フィルタ条件: <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-primary)' }}>{filterText}</span>
          </div>
        )}
      </Section>

      {/* 結果 */}
      {error && (
        <div className="card" style={{ padding: '12px', borderLeft: '3px solid var(--price-down)' }}>
          <p style={{ fontSize: '12px', color: 'var(--price-down)', margin: 0 }}>エラー: {error}</p>
        </div>
      )}

      {!segment ? (
        <div className="card" style={{ padding: '24px', textAlign: 'center' }}>
          <p style={{ fontSize: '12px', color: 'var(--text-muted)' }}>市場と区分を選んでください</p>
        </div>
      ) : !hasAnyStage ? (
        <div className="card" style={{ padding: '24px', textAlign: 'center' }}>
          <p style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
            少なくとも1つの系統でステージを選択してください
          </p>
        </div>
      ) : loading ? (
        <div className="card" style={{ padding: '32px', textAlign: 'center' }}>
          <p style={{ fontSize: '12px', color: 'var(--text-muted)' }}>計算中…（初回は数十秒）</p>
        </div>
      ) : (
        <div className="card" style={{ overflow: 'hidden' }}>
          <div style={{ padding: '8px 12px', display: 'flex', justifyContent: 'space-between', borderBottom: '1px solid var(--border-subtle)' }}>
            <span style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>
              <strong>{results.length}</strong>件 / 母集団 {universe}銘柄
              {cached && <span style={{ marginLeft: '6px', color: 'var(--accent-primary)' }}>（当日キャッシュ）</span>}
            </span>
          </div>
          {results.length === 0 ? (
            <div style={{ padding: '32px', textAlign: 'center' }}>
              <p style={{ fontSize: '12px', color: 'var(--text-muted)' }}>該当する銘柄がありません</p>
            </div>
          ) : (
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '12px' }}>
                <thead>
                  <tr style={{ background: 'var(--bg-elevated)', borderBottom: '1px solid var(--border-dim)' }}>
                    <th style={th}>コード</th>
                    <th style={th}>銘柄名</th>
                    <th style={thR}>時価総額</th>
                    <th style={th}>区分</th>
                    <th style={thR}>PER</th>
                    <th style={thR}>ROE</th>
                    <th style={thR}>配当利回り</th>
                    <th style={th}>ステージ (日A/B週A/B月A/B)</th>
                  </tr>
                </thead>
                <tbody>
                  {results.map((r) => (
                    <tr key={r.ticker} style={{ borderBottom: '1px solid var(--border-subtle)' }}>
                      <td style={td}>
                        <Link href={`/stock/${encodeURIComponent(r.ticker)}`} style={{ color: 'var(--accent-primary)', fontFamily: 'var(--font-mono)', textDecoration: 'none', fontWeight: 600 }}>
                          {r.ticker.replace('.T', '')}
                        </Link>
                      </td>
                      <td style={td}>{r.name}</td>
                      <td style={tdR}>{r.marketCap ? `${(r.marketCap / 1e8).toLocaleString('ja-JP', { maximumFractionDigits: 0 })} 億` : '---'}</td>
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
                      <td style={tdR}>{r.per != null ? r.per.toFixed(1) : '---'}</td>
                      <td style={tdR}>{r.roe != null ? `${r.roe.toFixed(1)}%` : '---'}</td>
                      <td style={tdR}>{r.dividendYield != null ? `${r.dividendYield.toFixed(2)}%` : '---'}</td>
                      <td style={{ ...td, fontFamily: 'var(--font-mono)', fontSize: '11px', color: 'var(--text-secondary)', whiteSpace: 'nowrap' }}>
                        {r.daily_a_stage ?? '-'}/{r.daily_b_stage ?? '-'} {r.weekly_a_stage ?? '-'}/{r.weekly_b_stage ?? '-'} {r.monthly_a_stage ?? '-'}/{r.monthly_b_stage ?? '-'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
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
  const sortedSelected = [...selected].sort()
  return (
    <div className="card" style={{ padding: '12px', opacity: disabled ? 0.5 : 1 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '8px' }}>
        <span style={{
          width: '10px',
          height: '10px',
          borderRadius: '50%',
          background: axis.color,
          flexShrink: 0,
        }} />
        <span style={{ fontSize: '13px', fontWeight: 600 }}>{axis.label}</span>
        {selected.length > 0 && (
          <button
            onClick={onClear}
            disabled={disabled}
            style={{
              marginLeft: 'auto',
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

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '6px' }}>
        {[1, 2, 3, 4, 5, 6].map((s) => {
          const active = selected.includes(s)
          return (
            <button
              key={s}
              disabled={disabled}
              onClick={() => onToggle(s)}
              style={{
                padding: '8px 0',
                fontSize: '14px',
                fontWeight: 700,
                fontFamily: 'var(--font-mono)',
                background: active ? axis.color : 'var(--bg-elevated)',
                color: active ? '#fff' : 'var(--text-secondary)',
                border: `1px solid ${active ? axis.color : 'var(--border-base)'}`,
                borderRadius: 'var(--radius-sm)',
                cursor: disabled ? 'not-allowed' : 'pointer',
                boxShadow: active ? `0 2px 8px ${axis.color}55` : 'none',
              }}
            >
              {s}
            </button>
          )
        })}
      </div>

      <div style={{ marginTop: '8px', fontSize: '10px', color: 'var(--text-muted)', display: 'flex', flexWrap: 'wrap', gap: '4px', alignItems: 'center' }}>
        <span>選択中:</span>
        {sortedSelected.length > 0 ? (
          sortedSelected.map((s) => (
            <span
              key={s}
              style={{
                display: 'inline-block',
                padding: '2px 8px',
                background: axis.color,
                color: '#fff',
                borderRadius: '10px',
                fontFamily: 'var(--font-mono)',
                fontWeight: 600,
                fontSize: '10px',
              }}
            >
              Stage {s}
            </span>
          ))
        ) : (
          <span style={{ color: 'var(--text-muted)' }}>なし</span>
        )}
      </div>
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

interface ButtonRowProps {
  options: { v: string; label: string }[]
  value: string
  onChange: (v: string) => void
}
function ButtonRow({ options, value, onChange }: ButtonRowProps) {
  return (
    <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
      {options.map((o) => (
        <button
          key={o.v}
          onClick={() => onChange(o.v)}
          style={{
            padding: '8px 16px',
            fontSize: '12px',
            fontFamily: 'var(--font-mono)',
            background: value === o.v ? 'var(--accent-primary)' : 'var(--bg-surface)',
            color: value === o.v ? '#fff' : 'var(--text-secondary)',
            border: `1px solid ${value === o.v ? 'var(--accent-primary)' : 'var(--border-base)'}`,
            borderRadius: 'var(--radius-sm)',
            cursor: 'pointer',
            fontWeight: 500,
          }}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
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
const td: React.CSSProperties = { padding: '8px 12px', fontSize: '12px', color: 'var(--text-primary)' }
const tdR: React.CSSProperties = { ...td, textAlign: 'right', fontFamily: 'var(--font-mono)' }
