// app/admin/db/page.tsx
'use client'

import { useEffect, useState } from 'react'

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

export default function AdminDbPage() {
  const [stats, setStats] = useState<DbStats | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const load = async () => {
    setLoading(true)
    setError('')
    try {
      const res = await fetch('/api/admin/db-stats')
      if (!res.ok) {
        const e = await res.json()
        throw new Error(e.message ?? 'failed')
      }
      setStats(await res.json())
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    load()
  }, [])

  return (
    <div style={{ padding: '16px', display: 'flex', flexDirection: 'column', gap: '16px' }}>
      <div style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'flex-end',
        borderBottom: '1px solid var(--border-subtle)',
        paddingBottom: '12px',
      }}>
        <div>
          <h1 style={{ fontFamily: 'var(--font-display)', fontSize: '16px', fontWeight: 700 }}>🗄 DB管理</h1>
          <p style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '2px' }}>
            SQLite3 データベースの状態確認
          </p>
        </div>
        <button onClick={load} style={refreshBtn} disabled={loading}>
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
          unit="件"
        />
        <SummaryCard
          label="DB容量"
          value={stats?.dbSizeMB ?? '---'}
          unit="MB"
        />
        <SummaryCard
          label="スナップショット"
          value={String(stats?.snapshotCount ?? '---')}
          unit="ファイル"
        />
      </div>

      {/* テーブル別レコード数 */}
      <div className="card" style={{ overflow: 'hidden' }}>
        <div style={{ padding: '8px 12px', borderBottom: '1px solid var(--border-subtle)' }}>
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
                <td style={{ ...cellStyleR, color: 'var(--text-muted)' }}>
                  {t.latestDate ?? '---'}
                </td>
              </tr>
            ))}
            {!stats && !loading && (
              <tr><td colSpan={3} style={{ ...cellStyle, textAlign: 'center', color: 'var(--text-muted)' }}>データなし</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {/* スナップショットファイル */}
      <div className="card" style={{ overflow: 'hidden' }}>
        <div style={{ padding: '8px 12px', borderBottom: '1px solid var(--border-subtle)' }}>
          <span style={{ fontSize: '12px', fontWeight: 600 }}>キャッシュファイル（data/snapshots/）</span>
        </div>
        <div style={{ padding: '8px 12px' }}>
          {stats?.snapshotFiles && stats.snapshotFiles.length > 0 ? (
            <ul style={{ margin: 0, padding: '0 0 0 16px', fontSize: '11px', fontFamily: 'var(--font-mono)', color: 'var(--text-secondary)' }}>
              {stats.snapshotFiles.map((f) => (
                <li key={f}>{f}</li>
              ))}
            </ul>
          ) : (
            <p style={{ fontSize: '11px', color: 'var(--text-muted)', margin: 0 }}>
              スナップショットなし。スクリーナーを実行すると当日キャッシュが作成されます。
            </p>
          )}
        </div>
      </div>

      {/* 補足 */}
      <div className="card" style={{ padding: '12px', fontSize: '11px', color: 'var(--text-muted)', lineHeight: 1.6 }}>
        <p style={{ margin: 0 }}>
          📁 DB パス: <code>{stats?.dbPath ?? '---'}</code>
        </p>
        <p style={{ margin: '4px 0 0' }}>
          スナップショット収集スクリプト: <code>npx tsx scripts/collect-snapshot.ts</code>
        </p>
      </div>
    </div>
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
  padding: '8px 12px',
  fontFamily: 'var(--font-mono)',
  fontSize: '12px',
  color: 'var(--text-primary)',
}

const cellStyleR: React.CSSProperties = { ...cellStyle, textAlign: 'right' }
