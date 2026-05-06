// app/admin/sector-master/page.tsx
'use client'

import { useEffect, useState } from 'react'

interface Stats {
  totals: { total: number; large_count: number; latest: string | null } | null
  byLarge: { sector_large: string | null; n: number }[]
}

interface ImportSummary {
  fileName: string
  totalRows: number
  inserted: number
  skipped: number
  detectedColumns: {
    code: string | null
    name: string | null
    sectorLarge: string | null
    sectorSmall: string | null
  }
  errors: string[]
}

export default function SectorMasterPage() {
  const [dragOver, setDragOver] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [summary, setSummary] = useState<ImportSummary | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [stats, setStats] = useState<Stats | null>(null)

  const loadStats = async () => {
    try {
      const res = await fetch('/api/admin/sector-master')
      const json = await res.json()
      if (res.ok) setStats(json)
    } catch { /* 無視 */ }
  }

  useEffect(() => { loadStats() }, [])

  const upload = async (file: File) => {
    setUploading(true)
    setSummary(null)
    setError(null)
    try {
      const fd = new FormData()
      fd.append('file', file)
      const res = await fetch('/api/admin/sector-master', { method: 'POST', body: fd })
      const json = await res.json()
      if (!res.ok) {
        const detail = json.message ? `${json.error ?? 'Import failed'}: ${json.message}` : (json.error ?? 'failed')
        throw new Error(detail)
      }
      setSummary(json.summary)
      loadStats()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setUploading(false)
    }
  }

  return (
    <div style={{ padding: '16px', display: 'flex', flexDirection: 'column', gap: '16px' }}>
      <div style={{ borderBottom: '1px solid var(--border-subtle)', paddingBottom: '12px' }}>
        <h1 style={{ fontFamily: 'var(--font-display)', fontSize: '16px', fontWeight: 700 }}>
          🏷 業種マスタ取込（Excel）
        </h1>
        <p style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '2px', lineHeight: 1.6 }}>
          Excel ファイル（.xlsx）から「コード」「銘柄名」「大分類」「業種細分類」の4列を取込み、
          全銘柄の業種情報を更新します。月数回の運用想定。再アップロードで上書きされます。
        </p>
      </div>

      {/* ドロップ */}
      <div
        onDragOver={(e) => { e.preventDefault(); setDragOver(true) }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault()
          setDragOver(false)
          const file = e.dataTransfer.files[0]
          if (file) upload(file)
        }}
        style={{
          border: `2px dashed ${dragOver ? 'var(--accent-primary)' : 'var(--border-base)'}`,
          borderRadius: 'var(--radius-md)',
          padding: '32px',
          textAlign: 'center',
          background: dragOver ? 'rgba(217,119,6,0.06)' : 'transparent',
          transition: 'all 0.15s',
        }}
      >
        <p style={{ fontSize: '13px', color: 'var(--text-secondary)', marginBottom: '8px' }}>
          {uploading ? 'アップロード中…' : 'ここに .xlsx ファイルをドラッグ&ドロップ'}
        </p>
        <p style={{ fontSize: '11px', color: 'var(--text-muted)' }}>または</p>
        <label style={{
          display: 'inline-block',
          marginTop: '8px',
          padding: '6px 14px',
          background: 'var(--bg-elevated)',
          border: '1px solid var(--border-base)',
          borderRadius: 'var(--radius-sm)',
          fontSize: '12px',
          cursor: 'pointer',
        }}>
          ファイルを選択
          <input
            type="file"
            accept=".xlsx,.xls"
            onChange={(e) => {
              const f = e.target.files?.[0]
              if (f) upload(f)
              e.target.value = ''
            }}
            style={{ display: 'none' }}
          />
        </label>
      </div>

      {/* エラー */}
      {error && (
        <div className="card" style={{ padding: '12px', borderLeft: '3px solid var(--price-down)' }}>
          <p style={{ fontSize: '12px', color: 'var(--price-down)', margin: 0 }}>エラー: {error}</p>
        </div>
      )}

      {/* 取込結果 */}
      {summary && (
        <div className="card" style={{ padding: '12px' }}>
          <div style={{ fontSize: '12px', fontWeight: 600, marginBottom: '8px' }}>
            ✅ {summary.fileName}
          </div>
          <div style={{ fontSize: '11px', color: 'var(--text-secondary)', display: 'flex', gap: '16px', flexWrap: 'wrap' }}>
            <span>合計 <strong>{summary.totalRows}</strong> 行</span>
            <span style={{ color: 'var(--price-up, #22c55e)' }}>取込 <strong>{summary.inserted}</strong> 件</span>
            <span style={{ color: 'var(--text-muted)' }}>スキップ {summary.skipped} 件</span>
          </div>
          <div style={{ marginTop: '8px', fontSize: '11px', color: 'var(--text-muted)', display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '4px' }}>
            <span>コード列: <code>{summary.detectedColumns.code ?? '---'}</code></span>
            <span>銘柄名列: <code>{summary.detectedColumns.name ?? '---'}</code></span>
            <span>大分類列: <code>{summary.detectedColumns.sectorLarge ?? '---'}</code></span>
            <span>小分類列: <code>{summary.detectedColumns.sectorSmall ?? '---'}</code></span>
          </div>
        </div>
      )}

      {/* 現在の登録状況 */}
      <div className="card" style={{ overflow: 'hidden' }}>
        <div style={{ padding: '8px 12px', borderBottom: '1px solid var(--border-subtle)', fontSize: '12px', color: 'var(--text-secondary)' }}>
          📊 現在の登録状況
        </div>
        {!stats || !stats.totals ? (
          <div style={{ padding: '24px', textAlign: 'center', fontSize: '12px', color: 'var(--text-muted)' }}>
            まだデータがありません
          </div>
        ) : (
          <>
            <div style={{ padding: '12px', display: 'flex', gap: '24px', flexWrap: 'wrap', fontSize: '12px' }}>
              <div>
                <div style={{ fontSize: '10px', color: 'var(--text-muted)' }}>登録銘柄数</div>
                <div style={{ fontSize: '18px', fontFamily: 'var(--font-mono)', fontWeight: 600 }}>
                  {stats.totals.total.toLocaleString('ja-JP')}
                </div>
              </div>
              <div>
                <div style={{ fontSize: '10px', color: 'var(--text-muted)' }}>大分類数</div>
                <div style={{ fontSize: '18px', fontFamily: 'var(--font-mono)', fontWeight: 600 }}>
                  {stats.totals.large_count}
                </div>
              </div>
              <div>
                <div style={{ fontSize: '10px', color: 'var(--text-muted)' }}>最終更新</div>
                <div style={{ fontSize: '12px', fontFamily: 'var(--font-mono)' }}>
                  {stats.totals.latest?.replace('T', ' ').slice(0, 16) ?? '---'}
                </div>
              </div>
            </div>
            <div style={{ borderTop: '1px solid var(--border-subtle)', padding: '12px', display: 'flex', flexWrap: 'wrap', gap: '4px' }}>
              {stats.byLarge.map((row) => (
                <span key={row.sector_large ?? '_'} style={{
                  padding: '3px 8px',
                  fontSize: '11px',
                  fontFamily: 'var(--font-mono)',
                  background: 'var(--bg-elevated)',
                  border: '1px solid var(--border-base)',
                  borderRadius: '12px',
                  color: 'var(--text-secondary)',
                }}>
                  {row.sector_large ?? '（未分類）'}（{row.n}）
                </span>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  )
}
