// app/capital-flow/page.tsx
// Capital Flow Map: 業種別 / 銘柄別の時価総額変化を可視化する分析ページ。
// データソース: tv_daily_snapshots + sector_master

'use client'

import { useEffect, useMemo, useState } from 'react'
import { CapitalFlowTreemap } from '@/components/capital-flow/Treemap'
import { CapitalFlowWaterfall } from '@/components/capital-flow/Waterfall'
import { CapitalFlowSankey } from '@/components/capital-flow/SankeyFlow'
import { CapitalFlowTimeSeries } from '@/components/capital-flow/TimeSeries'

type GroupBy = 'large' | 'sector33' | 'small' | 'ticker'
type Period = 'day' | 'week' | 'month' | 'custom'
type ViewMode = 'rank' | 'treemap' | 'waterfall' | 'sankey' | 'timeseries'

const VIEW_OPTIONS: { v: ViewMode; label: string; emoji: string }[] = [
  { v: 'rank',       label: 'ランキング',     emoji: '📊' },
  { v: 'treemap',    label: 'ヒートマップ',   emoji: '🟩' },
  { v: 'waterfall',  label: 'ウォーターフォール', emoji: '💧' },
  { v: 'sankey',     label: 'フロー図',       emoji: '🔄' },
  { v: 'timeseries', label: '推移',           emoji: '📈' },
]

interface Contributor {
  ticker: string
  name: string
  mcapFrom: number
  mcapTo: number
  delta: number
  deltaPct: number | null
}

interface GroupResult {
  label: string
  countTickers: number
  mcapFrom: number
  mcapTo: number
  mcapDelta: number
  mcapDeltaPct: number | null
  topContributors: Contributor[]
  bottomContributors: Contributor[]
}

interface ApiResponse {
  fromDate: string | null
  toDate: string | null
  totalMcapFrom: number
  totalMcapTo: number
  totalDelta: number
  totalDeltaPct: number | null
  groups: GroupResult[]
  notice?: string
}

const GROUPBY_OPTIONS: { v: GroupBy; label: string }[] = [
  { v: 'large',    label: '業種大分類' },
  { v: 'sector33', label: '33業種区分' },
  { v: 'small',    label: '業種小分類' },
]

const PERIOD_OPTIONS: { v: Period; label: string }[] = [
  { v: 'day',    label: '前日比' },
  { v: 'week',   label: '前週比' },
  { v: 'month',  label: '前月比' },
  { v: 'custom', label: 'カスタム' },
]

function fmtMoney(yen: number): string {
  // 億単位で整形。1兆以上は「N,NNN兆」も表示。
  if (Math.abs(yen) >= 1e12) {
    return `${(yen / 1e12).toLocaleString('ja-JP', { maximumFractionDigits: 2 })} 兆`
  }
  if (Math.abs(yen) >= 1e8) {
    return `${(yen / 1e8).toLocaleString('ja-JP', { maximumFractionDigits: 0 })} 億`
  }
  return `${yen.toLocaleString('ja-JP')}`
}

function fmtSignedMoney(yen: number): string {
  const sign = yen > 0 ? '+' : yen < 0 ? '-' : ''
  return `${sign}${fmtMoney(Math.abs(yen))}`
}

function fmtPct(pct: number | null | undefined): string {
  if (pct == null) return '---'
  const sign = pct > 0 ? '+' : ''
  return `${sign}${pct.toFixed(2)}%`
}

function color(delta: number): string {
  if (delta > 0) return 'var(--price-up, #16a34a)'
  if (delta < 0) return 'var(--price-down, #ef4444)'
  return 'var(--text-muted)'
}

export default function CapitalFlowPage() {
  const [view, setView] = useState<ViewMode>('rank')
  const [period, setPeriod] = useState<Period>('week')
  const [groupBy, setGroupBy] = useState<GroupBy>('large')
  const [customFrom, setCustomFrom] = useState<string>('')
  const [customTo, setCustomTo]     = useState<string>('')
  const [drillField, setDrillField] = useState<'large' | 'sector33' | 'small' | null>(null)
  const [drillValue, setDrillValue] = useState<string | null>(null)
  const [data, setData] = useState<ApiResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)

    const params = new URLSearchParams()
    if (drillField && drillValue) {
      params.set('groupBy', 'ticker')
      params.set('filterField', drillField)
      params.set('filterValue', drillValue)
    } else {
      params.set('groupBy', groupBy)
    }
    if (period !== 'custom') {
      params.set('period', period)
    } else {
      if (customFrom) params.set('from', customFrom)
      if (customTo)   params.set('to',   customTo)
    }

    fetch(`/api/capital-flow?${params}`)
      .then(async (r) => {
        const j = await r.json()
        if (!r.ok) throw new Error(j.message ?? j.error ?? 'failed')
        if (!cancelled) setData(j)
      })
      .catch((e) => { if (!cancelled) setError((e as Error).message) })
      .finally(() => { if (!cancelled) setLoading(false) })

    return () => { cancelled = true }
  }, [period, groupBy, customFrom, customTo, drillField, drillValue])

  // バー幅を決めるための最大絶対値
  const maxAbs = useMemo(() => {
    if (!data) return 1
    return Math.max(1, ...data.groups.map((g) => Math.abs(g.mcapDelta)))
  }, [data])

  const days = useMemo(() => {
    if (!data?.fromDate || !data?.toDate) return null
    const a = new Date(`${data.fromDate}T00:00:00Z`).getTime()
    const b = new Date(`${data.toDate}T00:00:00Z`).getTime()
    return Math.round((b - a) / 86400000)
  }, [data])

  const inDrill = !!(drillField && drillValue)

  return (
    <div style={{ padding: '16px', display: 'flex', flexDirection: 'column', gap: '16px' }}>
      {/* ヘッダ */}
      <div style={{ borderBottom: '1px solid var(--border-subtle)', paddingBottom: '10px' }}>
        <h1 style={{ fontFamily: 'var(--font-display)', fontSize: '16px', fontWeight: 700, margin: 0 }}>
          💰 Capital Flow Map
        </h1>
        <p style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '4px', lineHeight: 1.5 }}>
          時価総額の増減から業種・銘柄ごとの「資金の流れ」を可視化。
          流入が多い業種は緑、流出が多い業種は赤で表示します。
        </p>
      </div>

      {/* ビュータブ */}
      <div style={{ display: 'flex', gap: '4px', flexWrap: 'wrap', borderBottom: '1px solid var(--border-subtle)' }}>
        {VIEW_OPTIONS.map((v) => (
          <button
            key={v.v}
            onClick={() => setView(v.v)}
            style={{
              padding: '8px 14px',
              fontSize: '12px',
              fontWeight: view === v.v ? 700 : 500,
              background: view === v.v ? '#fff' : 'transparent',
              color: view === v.v ? 'var(--accent-primary)' : 'var(--text-secondary)',
              border: 'none',
              borderBottom: view === v.v ? '2px solid var(--accent-primary)' : '2px solid transparent',
              cursor: 'pointer',
              marginBottom: '-1px',
              fontFamily: 'var(--font-mono)',
            }}
          >
            <span style={{ marginRight: 4 }}>{v.emoji}</span>
            {v.label}
          </button>
        ))}
      </div>

      {/* フィルタバー */}
      <div style={{
        display: 'flex',
        flexWrap: 'wrap',
        gap: '10px',
        alignItems: 'center',
        padding: '10px 12px',
        background: 'var(--bg-elevated)',
        border: '1px solid var(--border-subtle)',
        borderRadius: 'var(--radius-md)',
      }}>
        {/* 期間 */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
          <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>期間</span>
          <div style={{ display: 'inline-flex', border: '1px solid var(--border-base)', borderRadius: 'var(--radius-sm)', overflow: 'hidden' }}>
            {PERIOD_OPTIONS.map((p) => (
              <button
                key={p.v}
                onClick={() => setPeriod(p.v)}
                style={{
                  padding: '5px 12px',
                  fontSize: '11px',
                  fontFamily: 'var(--font-mono)',
                  background: period === p.v ? 'var(--accent-primary)' : 'transparent',
                  color: period === p.v ? '#fff' : 'var(--text-secondary)',
                  border: 'none',
                  cursor: 'pointer',
                  fontWeight: period === p.v ? 600 : 400,
                }}
              >
                {p.label}
              </button>
            ))}
          </div>
        </div>

        {/* カスタム日付 */}
        {period === 'custom' && (
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '11px' }}>
            <input type="date" value={customFrom} onChange={(e) => setCustomFrom(e.target.value)} style={dateInputStyle} />
            <span>→</span>
            <input type="date" value={customTo}   onChange={(e) => setCustomTo(e.target.value)}   style={dateInputStyle} />
          </div>
        )}

        {/* グループ分け（ドリルダウン中は無効） */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '6px', opacity: inDrill ? 0.4 : 1 }}>
          <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>集計単位</span>
          <div style={{ display: 'inline-flex', border: '1px solid var(--border-base)', borderRadius: 'var(--radius-sm)', overflow: 'hidden' }}>
            {GROUPBY_OPTIONS.map((g) => (
              <button
                key={g.v}
                onClick={() => setGroupBy(g.v)}
                disabled={inDrill}
                style={{
                  padding: '5px 12px',
                  fontSize: '11px',
                  fontFamily: 'var(--font-mono)',
                  background: groupBy === g.v ? 'var(--accent-primary)' : 'transparent',
                  color: groupBy === g.v ? '#fff' : 'var(--text-secondary)',
                  border: 'none',
                  cursor: inDrill ? 'not-allowed' : 'pointer',
                  fontWeight: groupBy === g.v ? 600 : 400,
                }}
              >
                {g.label}
              </button>
            ))}
          </div>
        </div>

        {/* ドリルダウン中の表示 + 解除ボタン */}
        {inDrill && (
          <span style={{
            display: 'inline-flex', alignItems: 'center', gap: '6px',
            fontSize: '11px', padding: '4px 10px',
            background: 'rgba(217,119,6,0.1)',
            border: '1px solid var(--accent-primary)',
            borderRadius: '20px',
            color: 'var(--accent-primary)',
          }}>
            🔍 {drillValue} の銘柄
            <button
              onClick={() => { setDrillField(null); setDrillValue(null) }}
              style={{
                marginLeft: 4, color: 'var(--accent-primary)',
                background: 'transparent', border: 'none', cursor: 'pointer', fontSize: '12px',
              }}
              title="ドリルダウンを解除"
            >
              ×
            </button>
          </span>
        )}
      </div>

      {/* エラー / ローディング */}
      {error && (
        <div className="card" style={{ padding: '12px', borderLeft: '3px solid var(--price-down)' }}>
          <p style={{ fontSize: '12px', color: 'var(--price-down)', margin: 0 }}>エラー: {error}</p>
        </div>
      )}

      {loading && (
        <div className="card" style={{ padding: '32px', textAlign: 'center' }}>
          <p style={{ fontSize: '12px', color: 'var(--text-muted)' }}>計算中…</p>
        </div>
      )}

      {!loading && !error && data && (
        <>
          {/* 期間サマリ + 全体合計 */}
          <div className="card" style={{ padding: '14px 16px' }}>
            {data.notice ? (
              <p style={{ fontSize: '12px', color: 'var(--text-muted)', margin: 0 }}>
                ⚠ {data.notice}
              </p>
            ) : (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '20px', alignItems: 'baseline' }}>
                <div>
                  <div style={{ fontSize: '10px', color: 'var(--text-muted)' }}>集計期間</div>
                  <div style={{ fontFamily: 'var(--font-mono)', fontSize: '14px', fontWeight: 600 }}>
                    {data.fromDate} → {data.toDate}
                    {days != null && <span style={{ color: 'var(--text-muted)', marginLeft: 6, fontSize: '11px' }}>（{days} 日間）</span>}
                  </div>
                </div>
                <div>
                  <div style={{ fontSize: '10px', color: 'var(--text-muted)' }}>市場全体時価総額</div>
                  <div style={{ fontFamily: 'var(--font-mono)', fontSize: '14px', fontWeight: 600 }}>
                    {fmtMoney(data.totalMcapFrom)} → {fmtMoney(data.totalMcapTo)}
                  </div>
                </div>
                <div>
                  <div style={{ fontSize: '10px', color: 'var(--text-muted)' }}>変化額</div>
                  <div style={{
                    fontFamily: 'var(--font-mono)', fontSize: '16px', fontWeight: 700,
                    color: color(data.totalDelta),
                  }}>
                    {fmtSignedMoney(data.totalDelta)} ({fmtPct(data.totalDeltaPct)})
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* ビュー別の本体 */}
          {view === 'rank' && (
            <>
              {!inDrill && data.groups.length > 0 && (
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: '12px' }}>
                  <RankList title="📈 流入トップ" items={[...data.groups].sort((a, b) => b.mcapDelta - a.mcapDelta).slice(0, 5)} flowKind="in" />
                  <RankList title="📉 流出トップ" items={[...data.groups].sort((a, b) => a.mcapDelta - b.mcapDelta).slice(0, 5)} flowKind="out" />
                </div>
              )}

              <div className="card" style={{ overflow: 'hidden' }}>
                <div style={{
                  padding: '10px 12px',
                  borderBottom: '1px solid var(--border-subtle)',
                  fontSize: '12px',
                  fontWeight: 600,
                  display: 'flex', justifyContent: 'space-between', alignItems: 'baseline',
                }}>
                  <span>{inDrill ? `${drillValue} 内の銘柄別資金フロー` : '全グループの資金フロー（変化額順）'}</span>
                  <span style={{ fontSize: '10px', color: 'var(--text-muted)' }}>
                    {data.groups.length} {inDrill ? '銘柄' : 'グループ'}
                  </span>
                </div>
                <div>
                  {data.groups.map((g) => (
                    <FlowBar
                      key={g.label}
                      label={g.label}
                      count={g.countTickers}
                      delta={g.mcapDelta}
                      deltaPct={g.mcapDeltaPct}
                      mcapFrom={g.mcapFrom}
                      mcapTo={g.mcapTo}
                      maxAbs={maxAbs}
                      drillable={!inDrill}
                      onDrillDown={() => {
                        if (inDrill) return
                        const map: Record<GroupBy, 'large' | 'sector33' | 'small' | null> = {
                          large: 'large', sector33: 'sector33', small: 'small', ticker: null,
                        }
                        const f = map[groupBy]
                        if (!f) return
                        setDrillField(f)
                        setDrillValue(g.label)
                      }}
                    />
                  ))}
                  {data.groups.length === 0 && (
                    <div style={{ padding: '32px', textAlign: 'center', fontSize: '12px', color: 'var(--text-muted)' }}>
                      該当データがありません
                    </div>
                  )}
                </div>
              </div>
            </>
          )}

          {view === 'treemap' && data.groups.length > 0 && (
            <div className="card" style={{ padding: '12px' }}>
              <CapitalFlowTreemap
                items={data.groups}
                onClickItem={inDrill ? undefined : (label) => {
                  const map: Record<GroupBy, 'large' | 'sector33' | 'small' | null> = {
                    large: 'large', sector33: 'sector33', small: 'small', ticker: null,
                  }
                  const f = map[groupBy]
                  if (!f) return
                  setDrillField(f)
                  setDrillValue(label)
                }}
              />
            </div>
          )}

          {view === 'waterfall' && data.groups.length > 0 && (
            <div className="card" style={{ padding: '12px' }}>
              <CapitalFlowWaterfall items={data.groups} />
            </div>
          )}

          {view === 'sankey' && data.groups.length > 0 && (
            <div className="card" style={{ padding: '12px' }}>
              <CapitalFlowSankey items={data.groups} />
            </div>
          )}

          {view === 'timeseries' && (
            <div className="card" style={{ padding: '12px' }}>
              {/* ドリルダウン中は ticker 単位で見せたいが時系列は業種粒度のみ対応 */}
              <CapitalFlowTimeSeries groupBy={(groupBy === 'ticker' ? 'large' : (groupBy as 'large' | 'sector33' | 'small'))} />
            </div>
          )}
        </>
      )}
    </div>
  )
}

// ───────────────────────────────────────────────────────────────────

function RankList({ title, items, flowKind }: { title: string; items: GroupResult[]; flowKind: 'in' | 'out' }) {
  const accent = flowKind === 'in' ? 'var(--price-up, #16a34a)' : 'var(--price-down, #ef4444)'
  return (
    <div className="card" style={{ overflow: 'hidden' }}>
      <div style={{ padding: '10px 12px', borderBottom: '1px solid var(--border-subtle)', fontSize: '12px', fontWeight: 600 }}>
        {title}
      </div>
      <div>
        {items.map((g, i) => (
          <div
            key={g.label}
            style={{
              display: 'flex', justifyContent: 'space-between', alignItems: 'center',
              padding: '8px 12px',
              borderBottom: i < items.length - 1 ? '1px solid var(--border-subtle)' : 'none',
              fontSize: '12px',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'baseline', gap: '6px', minWidth: 0 }}>
              <span style={{ color: 'var(--text-muted)', fontFamily: 'var(--font-mono)', fontSize: '10px', width: 18 }}>
                {i + 1}
              </span>
              <span style={{ fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {g.label}
              </span>
              <span style={{ fontSize: '10px', color: 'var(--text-muted)' }}>{g.countTickers}銘柄</span>
            </div>
            <div style={{ textAlign: 'right', whiteSpace: 'nowrap', fontFamily: 'var(--font-mono)' }}>
              <div style={{ color: accent, fontWeight: 700 }}>{fmtSignedMoney(g.mcapDelta)}</div>
              <div style={{ fontSize: '10px', color: 'var(--text-muted)' }}>{fmtPct(g.mcapDeltaPct)}</div>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

function FlowBar({
  label, count, delta, deltaPct, mcapFrom, mcapTo, maxAbs, drillable, onDrillDown,
}: {
  label: string
  count: number
  delta: number
  deltaPct: number | null
  mcapFrom: number
  mcapTo: number
  maxAbs: number
  drillable: boolean
  onDrillDown: () => void
}) {
  const widthPct = (Math.abs(delta) / maxAbs) * 50 // 中央線から左右に最大 50%
  const isUp = delta >= 0
  const c = color(delta)
  return (
    <div
      onClick={drillable ? onDrillDown : undefined}
      style={{
        display: 'grid',
        gridTemplateColumns: '180px 1fr 120px 80px',
        alignItems: 'center',
        gap: '8px',
        padding: '6px 12px',
        borderBottom: '1px solid var(--border-subtle)',
        cursor: drillable ? 'pointer' : 'default',
        fontSize: '12px',
      }}
      title={
        `${label}\n` +
        `  ${fmtMoney(mcapFrom)} → ${fmtMoney(mcapTo)}\n` +
        `  ${fmtSignedMoney(delta)} (${fmtPct(deltaPct)})\n` +
        `  ${count} 銘柄`
      }
    >
      <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        <span style={{ fontWeight: 600 }}>{label}</span>
        <span style={{ fontSize: '10px', color: 'var(--text-muted)', marginLeft: 6 }}>{count}</span>
      </div>
      <div style={{
        position: 'relative', height: '18px',
        borderLeft: '1px solid var(--border-base)',
        borderRight: '1px solid var(--border-base)',
        background: 'linear-gradient(to right, transparent calc(50% - 0.5px), var(--border-base) calc(50% - 0.5px), var(--border-base) calc(50% + 0.5px), transparent calc(50% + 0.5px))',
      }}>
        <div style={{
          position: 'absolute',
          top: 2, bottom: 2,
          left: isUp ? '50%' : `${50 - widthPct}%`,
          width: `${widthPct}%`,
          background: c,
          opacity: 0.85,
          borderRadius: '2px',
        }} />
      </div>
      <div style={{ textAlign: 'right', fontFamily: 'var(--font-mono)', color: c, fontWeight: 700 }}>
        {fmtSignedMoney(delta)}
      </div>
      <div style={{ textAlign: 'right', fontFamily: 'var(--font-mono)', color: c, fontSize: '11px' }}>
        {fmtPct(deltaPct)}
      </div>
    </div>
  )
}

const dateInputStyle: React.CSSProperties = {
  padding: '4px 6px',
  fontSize: '11px',
  fontFamily: 'var(--font-mono)',
  background: 'var(--bg-surface)',
  color: 'var(--text-primary)',
  border: '1px solid var(--border-base)',
  borderRadius: 'var(--radius-sm)',
}
