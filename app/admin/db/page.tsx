// app/admin/db/page.tsx
'use client'

import { useEffect, useState, useCallback } from 'react'

interface TableStat {
  name: string
  count: number
  latestDate?: string
}

interface DbStats {
  tables: TableStat[]
  totalRecords: number
  dbPath: string
  dbSizeBytes: number
  dbSizeMB: string
  snapshotFiles: string[]
  snapshotCount: number
}

interface BatchRun {
  id: number
  jobType: string
  status: string
  startedAt: number  // unix epoch (Drizzle timestamp mode → Date オブジェクト or number)
  finishedAt: number | null
  totalTickers: number | null
  succeeded: number | null
  failed: number | null
  rowsInserted: number | null
  errorSummary: string | null
}

interface UniverseSummary {
  total: number
  active: number
  inactive: number
  items: { ticker: string; name: string | null; active: boolean; addedAt: number }[]
}

export default function AdminDbPage() {
  const [stats, setStats] = useState<DbStats | null>(null)
  const [runs, setRuns] = useState<BatchRun[]>([])
  const [universe, setUniverse] = useState<UniverseSummary | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [universeFilter, setUniverseFilter] = useState('')
  const [addText, setAddText] = useState('')
  const [adding, setAdding] = useState(false)
  const [batchBusy, setBatchBusy] = useState<'ohlcv' | 'snapshots' | null>(null)

  const loadAll = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const [s, r, u] = await Promise.all([
        fetch('/api/admin/db-stats').then(r => r.ok ? r.json() : Promise.reject(r)),
        fetch('/api/admin/batch/runs').then(r => r.ok ? r.json() : Promise.reject(r)),
        fetch('/api/admin/universe').then(r => r.ok ? r.json() : Promise.reject(r)),
      ])
      setStats(s)
      setRuns(r.runs ?? [])
      setUniverse(u)
    } catch (e: any) {
      setError(e?.message ?? 'load failed')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    loadAll()
    // 走行中のバッチがある間はポーリング
    const interval = setInterval(() => {
      if (runs.some(r => r.status === 'running')) loadAll()
    }, 5000)
    return () => clearInterval(interval)
  }, [loadAll]) // eslint-disable-line react-hooks/exhaustive-deps

  const triggerBatch = async (kind: 'ohlcv' | 'snapshots') => {
    setBatchBusy(kind)
    try {
      const res = await fetch(`/api/admin/batch/${kind}`, { method: 'POST' })
      if (!res.ok) throw new Error(await res.text())
      // 数秒待ってから一覧更新 (起動直後だと running 行がまだ無い)
      setTimeout(loadAll, 1500)
    } catch (e: any) {
      setError(`バッチ起動失敗: ${e?.message ?? e}`)
    } finally {
      setTimeout(() => setBatchBusy(null), 1500)
    }
  }

  const submitAdd = async () => {
    if (!addText.trim()) return
    setAdding(true)
    try {
      const res = await fetch('/api/admin/universe', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ tickers: addText }),
      })
      if (!res.ok) throw new Error(await res.text())
      setAddText('')
      await loadAll()
    } catch (e: any) {
      setError(`追加失敗: ${e?.message ?? e}`)
    } finally {
      setAdding(false)
    }
  }

  const toggleActive = async (ticker: string, active: boolean) => {
    try {
      await fetch(`/api/admin/universe/${ticker}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ active }),
      })
      await loadAll()
    } catch (e: any) {
      setError(`更新失敗: ${e?.message ?? e}`)
    }
  }

  const filteredUniverse = (universe?.items ?? []).filter(it => {
    if (!universeFilter) return false  // 未入力時は表示しない (4165 行は重い)
    const q = universeFilter.toLowerCase()
    return it.ticker.toLowerCase().includes(q) || (it.name ?? '').toLowerCase().includes(q)
  }).slice(0, 50)

  return (
    <div style={{ padding: '16px', display: 'flex', flexDirection: 'column', gap: '16px' }}>
      <div style={headerRow}>
        <div>
          <h1 style={{ fontFamily: 'var(--font-display)', fontSize: '16px', fontWeight: 700 }}>🗄 DB管理</h1>
          <p style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '2px' }}>
            データベース状態 / Phase 2 バッチ実行 / 銘柄ユニバース管理
          </p>
        </div>
        <button onClick={loadAll} style={refreshBtn} disabled={loading}>
          {loading ? '更新中...' : '⟳ 更新'}
        </button>
      </div>

      {error && (
        <div className="card" style={{ padding: '12px', borderLeft: '3px solid var(--price-down)' }}>
          <p style={{ fontSize: '12px', color: 'var(--price-down)', margin: 0 }}>エラー: {error}</p>
        </div>
      )}

      {/* サマリーカード */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '8px' }}>
        <SummaryCard label="総レコード数" value={stats?.totalRecords?.toLocaleString() ?? '---'} unit="件" />
        <SummaryCard label="DB容量" value={stats?.dbSizeMB ?? '---'} unit="MB" />
        <SummaryCard label="ユニバース" value={universe ? String(universe.active) : '---'} unit={`/ ${universe?.total ?? 0} active`} />
      </div>

      {/* ★ Phase 2: バッチ実行 ★ */}
      <section className="card" style={{ overflow: 'hidden' }}>
        <div style={{ ...sectionHead }}>
          <span style={{ fontSize: '12px', fontWeight: 600 }}>Phase 2: バッチ実行</span>
          <span style={{ fontSize: '10px', color: 'var(--text-muted)' }}>
            実行中はポーリング (5秒)
          </span>
        </div>
        <div style={{ padding: '12px', display: 'flex', flexDirection: 'column', gap: '12px' }}>
          <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
            <button
              onClick={() => triggerBatch('ohlcv')}
              disabled={batchBusy !== null || runs.some(r => r.jobType === 'ohlcv_fetch' && r.status === 'running')}
              style={primaryBtn}
            >
              {batchBusy === 'ohlcv' ? '起動中...' : 'OHLCV 取得実行'}
            </button>
            <button
              onClick={() => triggerBatch('snapshots')}
              disabled={batchBusy !== null || runs.some(r => r.jobType === 'snapshot_compute' && r.status === 'running')}
              style={primaryBtn}
            >
              {batchBusy === 'snapshots' ? '起動中...' : 'スナップショット計算実行'}
            </button>
            <span style={{ fontSize: '10px', color: 'var(--text-muted)', alignSelf: 'center' }}>
              ※ 4000 銘柄フル実行は OHLCV 約 30〜40 分、スナップショット 約 5〜10 分
            </span>
          </div>

          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '11px' }}>
            <thead>
              <tr style={{ background: 'var(--bg-elevated)', borderBottom: '1px solid var(--border-dim)' }}>
                <th style={headStyle}>#</th>
                <th style={headStyle}>job</th>
                <th style={headStyle}>status</th>
                <th style={headStyleR}>銘柄数</th>
                <th style={headStyleR}>成功 / 失敗</th>
                <th style={headStyleR}>行数</th>
                <th style={headStyle}>開始</th>
                <th style={headStyle}>所要</th>
              </tr>
            </thead>
            <tbody>
              {runs.length === 0 && (
                <tr><td colSpan={8} style={{ ...cellStyle, textAlign: 'center', color: 'var(--text-muted)' }}>履歴なし</td></tr>
              )}
              {runs.map(run => (
                <tr key={run.id} style={{ borderBottom: '1px solid var(--border-subtle)' }}>
                  <td style={{ ...cellStyle, color: 'var(--text-muted)' }}>{run.id}</td>
                  <td style={cellStyle}>{run.jobType === 'ohlcv_fetch' ? 'OHLCV' : 'Snapshots'}</td>
                  <td style={cellStyle}>
                    <StatusBadge status={run.status} />
                  </td>
                  <td style={cellStyleR}>{run.totalTickers?.toLocaleString() ?? '-'}</td>
                  <td style={cellStyleR}>
                    {run.succeeded ?? '-'} / {run.failed === null ? '-' : run.failed}
                  </td>
                  <td style={cellStyleR}>{run.rowsInserted?.toLocaleString() ?? '-'}</td>
                  <td style={{ ...cellStyle, color: 'var(--text-muted)' }}>{fmtTs(run.startedAt)}</td>
                  <td style={{ ...cellStyle, color: 'var(--text-muted)' }}>{fmtDuration(run.startedAt, run.finishedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* ★ Phase 2: 銘柄ユニバース管理 ★ */}
      <section className="card" style={{ overflow: 'hidden' }}>
        <div style={sectionHead}>
          <span style={{ fontSize: '12px', fontWeight: 600 }}>Phase 2: 銘柄ユニバース ({universe?.total.toLocaleString() ?? '-'} 件 / active {universe?.active.toLocaleString() ?? '-'})</span>
        </div>
        <div style={{ padding: '12px', display: 'flex', flexDirection: 'column', gap: '12px' }}>
          {/* 追加 */}
          <div style={{ display: 'flex', gap: '8px', alignItems: 'flex-start' }}>
            <textarea
              value={addText}
              onChange={(e) => setAddText(e.target.value)}
              placeholder="銘柄コード (4桁数字、改行 or カンマ区切り)&#10;7203&#10;6758&#10;9984"
              style={textareaStyle}
              rows={4}
            />
            <button onClick={submitAdd} disabled={adding || !addText.trim()} style={primaryBtn}>
              {adding ? '追加中...' : '追加'}
            </button>
          </div>

          {/* 検索 + 一覧 */}
          <div>
            <input
              type="text"
              value={universeFilter}
              onChange={(e) => setUniverseFilter(e.target.value)}
              placeholder="銘柄コード or 名前で検索 (空欄時は表示しない、最大50件)"
              style={inputStyle}
            />
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '11px', marginTop: '8px' }}>
              <thead>
                <tr style={{ background: 'var(--bg-elevated)', borderBottom: '1px solid var(--border-dim)' }}>
                  <th style={headStyle}>ticker</th>
                  <th style={headStyle}>name</th>
                  <th style={headStyleR}>active</th>
                </tr>
              </thead>
              <tbody>
                {!universeFilter && (
                  <tr><td colSpan={3} style={{ ...cellStyle, textAlign: 'center', color: 'var(--text-muted)' }}>検索ボックスに何か入力してください</td></tr>
                )}
                {universeFilter && filteredUniverse.length === 0 && (
                  <tr><td colSpan={3} style={{ ...cellStyle, textAlign: 'center', color: 'var(--text-muted)' }}>該当なし</td></tr>
                )}
                {filteredUniverse.map(it => (
                  <tr key={it.ticker} style={{ borderBottom: '1px solid var(--border-subtle)' }}>
                    <td style={{ ...cellStyle, color: 'var(--color-brand-700)' }}>{it.ticker}</td>
                    <td style={cellStyle}>{it.name ?? '-'}</td>
                    <td style={cellStyleR}>
                      <button
                        onClick={() => toggleActive(it.ticker, !it.active)}
                        style={{
                          ...toggleBtn,
                          color: it.active ? 'var(--color-brand-600)' : 'var(--text-muted)',
                          borderColor: it.active ? 'var(--color-brand-600)' : 'var(--border-base)',
                        }}
                      >
                        {it.active ? '● ON' : '○ OFF'}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </section>

      {/* テーブル別レコード数 (既存) */}
      <div className="card" style={{ overflow: 'hidden' }}>
        <div style={sectionHead}>
          <span style={{ fontSize: '12px', fontWeight: 600 }}>テーブル別レコード数</span>
        </div>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '12px' }}>
          <thead>
            <tr style={{ background: 'var(--bg-elevated)', borderBottom: '1px solid var(--border-dim)' }}>
              <th style={headStyle}>テーブル名</th>
              <th style={headStyleR}>レコード数</th>
              <th style={headStyleR}>最新日付</th>
            </tr>
          </thead>
          <tbody>
            {stats?.tables.map((t) => (
              <tr key={t.name} style={{ borderBottom: '1px solid var(--border-subtle)' }}>
                <td style={{ ...cellStyle, color: 'var(--accent-primary)' }}>{t.name}</td>
                <td style={cellStyleR}>{t.count.toLocaleString()}</td>
                <td style={{ ...cellStyleR, color: 'var(--text-muted)' }}>{t.latestDate ?? '---'}</td>
              </tr>
            ))}
            {!stats && !loading && (
              <tr><td colSpan={3} style={{ ...cellStyle, textAlign: 'center', color: 'var(--text-muted)' }}>データなし</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {/* 補足 */}
      <div className="card" style={{ padding: '12px', fontSize: '11px', color: 'var(--text-muted)', lineHeight: 1.6 }}>
        <p style={{ margin: 0 }}>
          📁 DB パス: <code>{stats?.dbPath ?? '---'}</code>
        </p>
      </div>
    </div>
  )
}

// ─── 補助コンポーネント ───

function StatusBadge({ status }: { status: string }) {
  const map: Record<string, { color: string; bg: string; label: string }> = {
    running: { color: '#0e7490', bg: 'var(--color-pattern-50)', label: 'running' },
    success: { color: '#15803d', bg: '#dcfce7', label: 'success' },
    partial: { color: '#a16207', bg: '#fef3c7', label: 'partial' },
    failed:  { color: '#b91c1c', bg: '#fee2e2', label: 'failed' },
  }
  const s = map[status] ?? { color: 'var(--text-muted)', bg: 'var(--bg-elevated)', label: status }
  return (
    <span style={{
      display: 'inline-block',
      padding: '1px 6px',
      borderRadius: '3px',
      fontSize: '10px',
      fontWeight: 500,
      color: s.color,
      background: s.bg,
    }}>{s.label}</span>
  )
}

function SummaryCard({ label, value, unit }: { label: string; value: string; unit: string }) {
  return (
    <div className="card" style={{ padding: '12px' }}>
      <div style={{ fontSize: '10px', color: 'var(--text-muted)', marginBottom: '4px' }}>{label}</div>
      <div style={{ fontFamily: 'var(--font-mono)', fontSize: '20px', fontWeight: 600 }}>
        {value} <span style={{ fontSize: '12px', color: 'var(--text-muted)' }}>{unit}</span>
      </div>
    </div>
  )
}

// ─── ヘルパー ───

function fmtTs(epochOrDate: number | string | null): string {
  if (epochOrDate == null) return '-'
  // Drizzle の timestamp mode は Date オブジェクトとして JSON シリアライズされる (ISO 文字列)
  // または unix epoch (number) で来る場合もある
  let d: Date
  if (typeof epochOrDate === 'number') {
    d = new Date(epochOrDate < 1e12 ? epochOrDate * 1000 : epochOrDate)
  } else {
    d = new Date(epochOrDate)
  }
  if (isNaN(d.getTime())) return '-'
  return d.toLocaleString('ja-JP', {
    month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit',
  })
}

function fmtDuration(start: number | string | null, end: number | string | null): string {
  if (start == null) return '-'
  const s = typeof start === 'number' ? (start < 1e12 ? start * 1000 : start) : new Date(start).getTime()
  const e = end == null
    ? Date.now()
    : (typeof end === 'number' ? (end < 1e12 ? end * 1000 : end) : new Date(end).getTime())
  const sec = Math.max(0, Math.floor((e - s) / 1000))
  if (sec < 60) return `${sec}s`
  const min = Math.floor(sec / 60)
  if (min < 60) return `${min}m ${sec % 60}s`
  const h = Math.floor(min / 60)
  return `${h}h ${min % 60}m`
}

// ─── スタイル ───

const headerRow: React.CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'flex-end',
  borderBottom: '1px solid var(--border-subtle)',
  paddingBottom: '12px',
}

const sectionHead: React.CSSProperties = {
  padding: '8px 12px',
  borderBottom: '1px solid var(--border-subtle)',
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'center',
  background: 'var(--bg-elevated)',
}

const refreshBtn: React.CSSProperties = {
  padding: '6px 14px',
  background: 'transparent',
  border: '1px solid var(--border-base)',
  borderRadius: 'var(--radius-sm)',
  fontSize: '12px',
  fontFamily: 'var(--font-mono)',
  cursor: 'pointer',
  color: 'var(--text-secondary)',
}

const primaryBtn: React.CSSProperties = {
  padding: '6px 14px',
  background: 'var(--color-brand-600)',
  border: 'none',
  borderRadius: 'var(--radius-sm)',
  fontSize: '12px',
  fontWeight: 500,
  cursor: 'pointer',
  color: 'white',
}

const toggleBtn: React.CSSProperties = {
  padding: '2px 8px',
  background: 'transparent',
  border: '1px solid',
  borderRadius: 'var(--radius-sm)',
  fontSize: '10px',
  cursor: 'pointer',
  fontFamily: 'var(--font-mono)',
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

const cellStyle: React.CSSProperties = {
  padding: '6px 12px',
  fontFamily: 'var(--font-mono)',
  fontSize: '11px',
  color: 'var(--text-primary)',
}

const cellStyleR: React.CSSProperties = { ...cellStyle, textAlign: 'right' }

const textareaStyle: React.CSSProperties = {
  flex: 1,
  fontFamily: 'var(--font-mono)',
  fontSize: '12px',
  padding: '6px 8px',
  border: '1px solid var(--border-base)',
  borderRadius: 'var(--radius-sm)',
  background: 'var(--bg-base)',
  color: 'var(--text-primary)',
  resize: 'vertical',
}

const inputStyle: React.CSSProperties = {
  width: '100%',
  fontFamily: 'var(--font-mono)',
  fontSize: '12px',
  padding: '6px 8px',
  border: '1px solid var(--border-base)',
  borderRadius: 'var(--radius-sm)',
  background: 'var(--bg-base)',
  color: 'var(--text-primary)',
}
