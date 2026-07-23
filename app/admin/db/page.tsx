// app/admin/db/page.tsx
'use client'

import { useEffect, useState, useCallback } from 'react'

interface TableStat {
  name: string
  count: number
  latestDate?: string
  estimated?: boolean
}

interface DbStats {
  tables: TableStat[]
  totalRecords: number
  totalRecordsEstimated?: boolean
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
  matched: number
  items: { ticker: string; name: string | null; active: boolean; addedAt: number }[]
}

export default function AdminDbPage() {
  const [stats, setStats] = useState<DbStats | null>(null)
  const [runs, setRuns] = useState<BatchRun[]>([])
  const [universe, setUniverse] = useState<UniverseSummary | null>(null)
  const [loading, setLoading] = useState(true)
  const [universeLoading, setUniverseLoading] = useState(false)
  const [error, setError] = useState('')
  const [universeFilter, setUniverseFilter] = useState('')

  const loadAll = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const [s, r, u] = await Promise.all([
        fetch('/api/admin/db-stats', { cache: 'no-store' }).then(r => r.ok ? r.json() : Promise.reject(r)),
        fetch('/api/admin/batch/runs', { cache: 'no-store' }).then(r => r.ok ? r.json() : Promise.reject(r)),
        fetch('/api/admin/universe?limit=0', { cache: 'no-store' }).then(r => r.ok ? r.json() : Promise.reject(r)),
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
  }, [loadAll])

  useEffect(() => {
    if (!runs.some((run) => run.status === 'running')) return
    const interval = setInterval(() => {
      void loadAll()
    }, 5000)
    return () => clearInterval(interval)
  }, [loadAll, runs])

  useEffect(() => {
    const query = universeFilter.trim()
    if (!query) {
      setUniverse((current) => current ? { ...current, matched: current.total, items: [] } : current)
      setUniverseLoading(false)
      return
    }
    const controller = new AbortController()
    const timer = window.setTimeout(async () => {
      setUniverseLoading(true)
      try {
        const response = await fetch(`/api/admin/universe?q=${encodeURIComponent(query)}&limit=50`, {
          cache: 'no-store',
          signal: controller.signal,
        })
        if (!response.ok) throw new Error(`universe search failed (${response.status})`)
        setUniverse(await response.json())
      } catch (searchError) {
        if ((searchError as Error).name !== 'AbortError') {
          setError((searchError as Error).message)
        }
      } finally {
        if (!controller.signal.aborted) setUniverseLoading(false)
      }
    }, 250)
    return () => {
      controller.abort()
      window.clearTimeout(timer)
    }
  }, [universeFilter])

  const filteredUniverse = universeFilter.trim() ? (universe?.items ?? []) : []

  return (
    <div style={{ padding: '16px', display: 'flex', flexDirection: 'column', gap: '16px' }}>
      <div style={headerRow}>
        <div>
          <h1 style={{ fontFamily: 'var(--font-display)', fontSize: '16px', fontWeight: 700 }}>運用ステータス</h1>
          <p style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '2px' }}>
            データベース状態 / バッチ履歴 / 銘柄ユニバース確認（読み取り専用）
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
        <SummaryCard
          label="総レコード数"
          value={stats?.totalRecords?.toLocaleString() ?? '---'}
          unit={stats?.totalRecordsEstimated ? '件 (概算含む)' : '件'}
        />
        <SummaryCard label="DB容量" value={stats?.dbSizeMB ?? '---'} unit="MB" />
        <SummaryCard label="ユニバース" value={universe ? String(universe.active) : '---'} unit={`/ ${universe?.total ?? 0} active`} />
      </div>

      {/* データ更新バッチ */}
      <section className="card" style={{ overflow: 'hidden' }}>
        <div style={{ ...sectionHead }}>
          <span style={{ fontSize: '12px', fontWeight: 600 }}>データ更新バッチ</span>
          <span style={{ fontSize: '10px', color: 'var(--text-muted)' }}>
            起動操作はCLI/定期バッチに集約
          </span>
        </div>
        <div style={{ padding: '12px', display: 'flex', flexDirection: 'column', gap: '12px' }}>
          <div style={readOnlyNoteStyle}>
            手動実行ボタンは誤操作防止のため停止しました。J-Quants更新、スナップショット計算、ML更新は定期ジョブまたはCLIから実行してください。
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

      {/* 銘柄ユニバース管理 */}
      <section className="card" style={{ overflow: 'hidden' }}>
        <div style={sectionHead}>
          <span style={{ fontSize: '12px', fontWeight: 600 }}>銘柄ユニバース ({universe?.total.toLocaleString() ?? '-'} 件 / active {universe?.active.toLocaleString() ?? '-'})</span>
          <span style={{ fontSize: '10px', color: 'var(--text-muted)' }}>読み取り専用</span>
        </div>
        <div style={{ padding: '12px', display: 'flex', flexDirection: 'column', gap: '12px' }}>
          <div style={readOnlyNoteStyle}>
            銘柄の追加・active切替は画面から停止しました。正規マスターはJ-Quants銘柄マスターと定期バッチで管理します。
          </div>

          <div>
            <input
              type="text"
              value={universeFilter}
              onChange={(e) => setUniverseFilter(e.target.value)}
              placeholder="銘柄コード or 名前で検索 (空欄時は表示しない、最大50件)"
              style={inputStyle}
            />
            {universeLoading && (
              <div style={{ marginTop: '6px', fontSize: '10px', color: 'var(--text-muted)' }}>検索中...</div>
            )}
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
                {universeFilter && !universeLoading && filteredUniverse.length === 0 && (
                  <tr><td colSpan={3} style={{ ...cellStyle, textAlign: 'center', color: 'var(--text-muted)' }}>該当なし</td></tr>
                )}
                {filteredUniverse.map(it => (
                  <tr key={it.ticker} style={{ borderBottom: '1px solid var(--border-subtle)' }}>
                    <td style={{ ...cellStyle, color: 'var(--color-brand-700)' }}>{it.ticker}</td>
                    <td style={cellStyle}>{it.name ?? '-'}</td>
                    <td style={cellStyleR}>
                      <span style={{
                        ...toggleBtn,
                        color: it.active ? 'var(--color-brand-600)' : 'var(--text-muted)',
                        borderColor: it.active ? 'var(--color-brand-600)' : 'var(--border-base)',
                      }}>
                        {it.active ? '● ON' : '○ OFF'}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {universeFilter && !universeLoading && (universe?.matched ?? 0) > filteredUniverse.length && (
              <div style={{ marginTop: '6px', fontSize: '10px', color: 'var(--text-muted)', textAlign: 'right' }}>
                該当 {(universe?.matched ?? 0).toLocaleString()} 件のうち先頭 {filteredUniverse.length.toLocaleString()} 件
              </div>
            )}
          </div>
        </div>
      </section>

      {/* テーブル別レコード数 (既存) */}
      <div className="card" style={{ overflow: 'hidden' }}>
        <div style={sectionHead}>
          <span style={{ fontSize: '12px', fontWeight: 600 }}>テーブル別レコード数</span>
          <span style={{ fontSize: '10px', color: 'var(--text-muted)' }}>
            大規模テーブルはANALYZE統計の概算値を表示
          </span>
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
                <td style={cellStyleR}>
                  {t.count.toLocaleString()}
                  {t.estimated && <span style={estimateBadge}>概算</span>}
                </td>
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

const toggleBtn: React.CSSProperties = {
  padding: '2px 8px',
  background: 'transparent',
  border: '1px solid',
  borderRadius: 'var(--radius-sm)',
  fontSize: '10px',
  fontFamily: 'var(--font-mono)',
}

const readOnlyNoteStyle: React.CSSProperties = {
  padding: '8px 10px',
  border: '1px solid var(--color-border-soft)',
  borderRadius: 'var(--radius-sm)',
  background: 'var(--color-surface-subtle)',
  color: 'var(--text-secondary)',
  fontSize: '11px',
  lineHeight: 1.6,
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

const estimateBadge: React.CSSProperties = {
  display: 'inline-block',
  marginLeft: '6px',
  padding: '1px 5px',
  borderRadius: '3px',
  border: '1px solid var(--border-base)',
  color: 'var(--text-muted)',
  fontSize: '10px',
  fontFamily: 'var(--font-sans)',
}
