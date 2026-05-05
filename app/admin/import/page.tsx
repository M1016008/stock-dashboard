// app/admin/import/page.tsx
'use client'

import { useEffect, useRef, useState, useCallback } from 'react'
import { detectDateFromFileName } from '@/lib/csv/tradingview-parser'

interface ImportSummary {
  fileName: string
  date: string | null
  detectionMethod: 'manual' | 'filename' | 'today'
  rowsParsed: number
  rowsInserted: number
  errors: string[]
}

interface ImportLog {
  id: number
  date: string
  file_name: string
  row_count: number
  imported_at: string
  detection_method: 'manual' | 'filename' | 'today' | null
}

interface DateSummary {
  date: string
  tickers: number
}

export default function CsvImportPage() {
  const [pendingFiles, setPendingFiles] = useState<File[]>([])
  const [overrideDate, setOverrideDate] = useState('')
  const [busy, setBusy] = useState(false)
  const [results, setResults] = useState<ImportSummary[] | null>(null)
  const [imports, setImports] = useState<ImportLog[]>([])
  const [dates, setDates] = useState<DateSummary[]>([])
  const [dragOver, setDragOver] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  const refreshLogs = useCallback(async () => {
    try {
      const res = await fetch('/api/import/csv')
      const data = await res.json()
      setImports(data.imports ?? [])
      setDates(data.dates ?? [])
    } catch (e) {
      console.error('refreshLogs error', e)
    }
  }, [])

  useEffect(() => {
    refreshLogs()
  }, [refreshLogs])

  function addFiles(list: FileList | File[]) {
    const arr = Array.from(list).filter((f) => /\.(csv|tsv|txt)$/i.test(f.name))
    setPendingFiles((prev) => {
      const existing = new Set(prev.map((f) => f.name + ':' + f.size))
      const merged = [...prev]
      for (const f of arr) {
        const key = f.name + ':' + f.size
        if (!existing.has(key)) merged.push(f)
      }
      return merged
    })
  }

  function removePending(idx: number) {
    setPendingFiles((prev) => prev.filter((_, i) => i !== idx))
  }

  async function uploadAll() {
    if (pendingFiles.length === 0) return
    setBusy(true)
    setResults(null)
    try {
      const fd = new FormData()
      for (const f of pendingFiles) fd.append('files', f)
      if (overrideDate) fd.append('date', overrideDate)
      const res = await fetch('/api/import/csv', { method: 'POST', body: fd })
      const data = await res.json()
      if (!res.ok) throw new Error(data.message ?? data.error ?? 'failed')
      setResults(data.summaries ?? [])
      setPendingFiles([])
      setOverrideDate('')
      refreshLogs()
    } catch (e) {
      alert(`取込失敗: ${(e as Error).message}`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div style={{ padding: '16px', display: 'flex', flexDirection: 'column', gap: '16px' }}>
      <div style={{ borderBottom: '1px solid var(--border-subtle)', paddingBottom: '12px' }}>
        <h1 style={{ fontFamily: 'var(--font-display)', fontSize: '16px', fontWeight: 700 }}>
          📥 CSV取込（TradingView スクリーナー）
        </h1>
        <p style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '2px' }}>
          毎日の引け後に TradingView から書き出した CSV / TSV をドラッグ&ドロップ、または複数日分まとめてインポートできます。
        </p>
        <p style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '6px', lineHeight: 1.5 }}>
          💡 TradingView の列設定に <code>市場区分</code>（プライム/スタンダード/グロース）と <code>貸借区分</code>（貸借/信用）を追加すると、スクリーナー側でも自動表示されます。
        </p>
      </div>

      {/* ドロップエリア */}
      <div
        onDragOver={(e) => {
          e.preventDefault()
          setDragOver(true)
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault()
          setDragOver(false)
          if (e.dataTransfer?.files) addFiles(e.dataTransfer.files)
        }}
        onClick={() => inputRef.current?.click()}
        style={{
          padding: '32px',
          border: `2px dashed ${dragOver ? 'var(--accent-primary)' : 'var(--border-base)'}`,
          background: dragOver ? 'rgba(217,119,6,0.06)' : 'var(--bg-surface)',
          borderRadius: 'var(--radius-md, 8px)',
          textAlign: 'center',
          cursor: 'pointer',
          transition: 'all 0.15s',
        }}
      >
        <div style={{ fontSize: '40px', marginBottom: '8px' }}>📤</div>
        <div style={{ fontSize: '14px', fontWeight: 600, color: 'var(--text-primary)', marginBottom: '4px' }}>
          CSVファイルをドラッグ&ドロップ、またはクリックして選択
        </div>
        <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
          複数ファイルOK。ファイル名から自動で日付を検出します（例: <code>2026-05-05_screener.csv</code>）
        </div>
        <input
          ref={inputRef}
          type="file"
          accept=".csv,.tsv,.txt"
          multiple
          style={{ display: 'none' }}
          onChange={(e) => {
            if (e.target.files) addFiles(e.target.files)
            e.target.value = ''
          }}
        />
      </div>

      {/* 取込待ちファイル */}
      {pendingFiles.length > 0 && (
        <div className="card" style={{ overflow: 'hidden' }}>
          <div style={{ padding: '8px 12px', borderBottom: '1px solid var(--border-subtle)', display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '8px' }}>
            <span style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>
              取込待ち: <strong>{pendingFiles.length}</strong>件
            </span>
            <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' }}>
              <label style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
                日付を一括指定（任意）:&nbsp;
                <input
                  type="date"
                  value={overrideDate}
                  onChange={(e) => setOverrideDate(e.target.value)}
                  style={{
                    padding: '4px 8px',
                    fontSize: '11px',
                    background: 'var(--bg-elevated)',
                    color: 'var(--text-primary)',
                    border: '1px solid var(--border-base)',
                    borderRadius: 'var(--radius-sm)',
                    fontFamily: 'var(--font-mono)',
                  }}
                />
              </label>
              <button
                onClick={uploadAll}
                disabled={busy}
                style={{
                  padding: '6px 14px',
                  fontSize: '12px',
                  background: busy ? 'var(--bg-elevated)' : 'var(--accent-primary)',
                  color: '#fff',
                  border: '1px solid var(--accent-primary)',
                  borderRadius: 'var(--radius-sm)',
                  cursor: busy ? 'wait' : 'pointer',
                  fontWeight: 600,
                }}
              >
                {busy ? '取込中…' : `${pendingFiles.length}件を取込む`}
              </button>
            </div>
          </div>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '12px' }}>
            <thead>
              <tr style={{ background: 'var(--bg-elevated)' }}>
                <th style={th}>ファイル名</th>
                <th style={th}>サイズ</th>
                <th style={th}>検出日付</th>
                <th style={th}></th>
              </tr>
            </thead>
            <tbody>
              {pendingFiles.map((f, i) => {
                const detected = overrideDate || detectDateFromFileName(f.name) || '(今日の日付)'
                return (
                  <tr key={i} style={{ borderBottom: '1px solid var(--border-subtle)' }}>
                    <td style={td}>{f.name}</td>
                    <td style={tdR}>{(f.size / 1024).toFixed(1)} KB</td>
                    <td style={{ ...td, fontFamily: 'var(--font-mono)' }}>{detected}</td>
                    <td style={td}>
                      <button
                        onClick={() => removePending(i)}
                        style={{
                          padding: '2px 8px',
                          fontSize: '11px',
                          background: 'transparent',
                          color: 'var(--text-muted)',
                          border: '1px solid var(--border-base)',
                          borderRadius: 'var(--radius-sm)',
                          cursor: 'pointer',
                        }}
                      >
                        ×
                      </button>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* 取込結果 */}
      {results && (
        <div className="card" style={{ overflow: 'hidden' }}>
          <div style={{ padding: '8px 12px', borderBottom: '1px solid var(--border-subtle)', fontSize: '12px', color: 'var(--text-secondary)' }}>
            ✅ 取込完了: {results.length}件
          </div>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '12px' }}>
            <thead>
              <tr style={{ background: 'var(--bg-elevated)' }}>
                <th style={th}>ファイル名</th>
                <th style={th}>日付</th>
                <th style={th}>検出方法</th>
                <th style={thR}>取込件数</th>
                <th style={th}>エラー</th>
              </tr>
            </thead>
            <tbody>
              {results.map((r, i) => (
                <tr key={i} style={{ borderBottom: '1px solid var(--border-subtle)' }}>
                  <td style={td}>{r.fileName}</td>
                  <td style={{ ...td, fontFamily: 'var(--font-mono)' }}>{r.date ?? '---'}</td>
                  <td style={td}>
                    <span style={methodBadge(r.detectionMethod)}>{methodLabel(r.detectionMethod)}</span>
                  </td>
                  <td style={tdR}>
                    {r.rowsInserted > 0 ? (
                      <span style={{ color: 'var(--price-up, #22c55e)' }}>{r.rowsInserted}</span>
                    ) : (
                      <span style={{ color: 'var(--text-muted)' }}>0</span>
                    )}
                  </td>
                  <td style={{ ...td, color: r.errors.length > 0 ? 'var(--price-down)' : 'var(--text-muted)' }}>
                    {r.errors.length > 0 ? r.errors.join(' / ') : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* 取込済みデータの日付一覧 */}
      <div className="card" style={{ overflow: 'hidden' }}>
        <div style={{ padding: '8px 12px', borderBottom: '1px solid var(--border-subtle)', fontSize: '12px', color: 'var(--text-secondary)' }}>
          📅 取込済みの取引日（{dates.length}日分）
        </div>
        {dates.length === 0 ? (
          <div style={{ padding: '24px', textAlign: 'center', fontSize: '12px', color: 'var(--text-muted)' }}>
            まだデータがありません
          </div>
        ) : (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', padding: '12px' }}>
            {dates.map((d) => (
              <span
                key={d.date}
                style={{
                  padding: '4px 10px',
                  fontSize: '11px',
                  fontFamily: 'var(--font-mono)',
                  background: 'var(--bg-elevated)',
                  border: '1px solid var(--border-base)',
                  borderRadius: '20px',
                  color: 'var(--text-secondary)',
                }}
              >
                {d.date} <span style={{ color: 'var(--text-muted)' }}>({d.tickers}銘柄)</span>
              </span>
            ))}
          </div>
        )}
      </div>

      {/* 取込履歴ログ */}
      <div className="card" style={{ overflow: 'hidden' }}>
        <div style={{ padding: '8px 12px', borderBottom: '1px solid var(--border-subtle)', fontSize: '12px', color: 'var(--text-secondary)' }}>
          🗒 直近の取込履歴
        </div>
        {imports.length === 0 ? (
          <div style={{ padding: '24px', textAlign: 'center', fontSize: '12px', color: 'var(--text-muted)' }}>
            履歴がありません
          </div>
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '12px' }}>
            <thead>
              <tr style={{ background: 'var(--bg-elevated)' }}>
                <th style={th}>取込時刻</th>
                <th style={th}>対象日</th>
                <th style={th}>ファイル名</th>
                <th style={thR}>件数</th>
                <th style={th}>検出方法</th>
              </tr>
            </thead>
            <tbody>
              {imports.map((im) => (
                <tr key={im.id} style={{ borderBottom: '1px solid var(--border-subtle)' }}>
                  <td style={{ ...td, fontFamily: 'var(--font-mono)' }}>{formatDateTime(im.imported_at)}</td>
                  <td style={{ ...td, fontFamily: 'var(--font-mono)' }}>{im.date}</td>
                  <td style={td}>{im.file_name}</td>
                  <td style={tdR}>{im.row_count.toLocaleString('ja-JP')}</td>
                  <td style={td}><span style={methodBadge(im.detection_method)}>{methodLabel(im.detection_method)}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}

function methodLabel(m: 'manual' | 'filename' | 'today' | null): string {
  switch (m) {
    case 'manual': return '手動指定'
    case 'filename': return 'ファイル名'
    case 'today': return '今日'
    default: return '—'
  }
}

function methodBadge(m: 'manual' | 'filename' | 'today' | null): React.CSSProperties {
  const colors: Record<string, string> = {
    manual: 'var(--accent-primary)',
    filename: 'var(--price-up, #22c55e)',
    today: 'var(--text-muted)',
  }
  return {
    display: 'inline-block',
    padding: '1px 8px',
    fontSize: '10px',
    border: `1px solid ${colors[m ?? ''] ?? 'var(--border-base)'}`,
    color: colors[m ?? ''] ?? 'var(--text-muted)',
    borderRadius: '10px',
  }
}

function formatDateTime(iso: string): string {
  try {
    const d = new Date(iso)
    return d.toLocaleString('ja-JP', { hour12: false })
  } catch {
    return iso
  }
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
