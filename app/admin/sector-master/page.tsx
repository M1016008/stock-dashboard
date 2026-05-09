// app/admin/sector-master/page.tsx
'use client'

import { useEffect, useState } from 'react'

interface Stats {
  totals: { total: number; large_count: number; segment_count: number; latest: string | null } | null
  byLarge: { sector_large: string | null; n: number }[]
  bySegment: { market_segment: string | null; n: number }[]
}

interface Diagnostics {
  snapshotDate: string | null
  totalTickers: number
  withSectorMaster: number
  withSector33: number
  withLarge: number
  withSmall: number
  coveragePct: { master: number; sector33: number; large: number; small: number }
  bySector33: { label: string; n: number }[]
  byLarge: { label: string; n: number }[]
  unmatchedSample: { ticker: string; name: string }[]
  unmatchedCount: number
}

const MARKET_SEGMENTS = ['プライム', 'スタンダード', 'グロース'] as const
const MARGIN_TYPES = ['貸借', '信用'] as const

interface EditDraft {
  name: string
  sector_large: string
  sector_small: string
  sector33: string
  market_segment: string
  margin_type: string
}

const EMPTY_DRAFT: EditDraft = {
  name: '', sector_large: '', sector_small: '', sector33: '', market_segment: '', margin_type: '',
}

interface ImportSummary {
  fileName: string
  totalRows: number
  inserted: number
  skipped: number
  detectedColumns: {
    code: string | null
    name: string | null
    marketSegment: string | null
    sector33: string | null
    sectorLarge: string | null
    sectorSmall: string | null
    marginType: string | null
  }
  errors: string[]
}

export default function SectorMasterPage() {
  const [dragOver, setDragOver] = useState(false)
  const [working, setWorking] = useState<'idle' | 'upload' | 'jpx'>('idle')
  const [summary, setSummary] = useState<ImportSummary | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [stats, setStats] = useState<Stats | null>(null)
  const [diag, setDiag] = useState<Diagnostics | null>(null)
  const [editingTicker, setEditingTicker] = useState<string | null>(null)
  const [draft, setDraft] = useState<EditDraft>(EMPTY_DRAFT)
  const [savingTicker, setSavingTicker] = useState(false)
  const [editError, setEditError] = useState<string | null>(null)

  const loadStats = async () => {
    try {
      const res = await fetch('/api/admin/sector-master')
      const json = await res.json()
      if (res.ok) setStats(json)
    } catch { /* 無視 */ }
  }

  const loadDiag = async () => {
    try {
      const res = await fetch('/api/capital-flow/diagnostics')
      const json = await res.json()
      if (res.ok) setDiag(json)
    } catch { /* 無視 */ }
  }

  useEffect(() => { loadStats(); loadDiag() }, [])

  const startEdit = (ticker: string, name: string) => {
    setEditingTicker(ticker)
    setDraft({ ...EMPTY_DRAFT, name })
    setEditError(null)
  }
  const cancelEdit = () => {
    setEditingTicker(null)
    setDraft(EMPTY_DRAFT)
    setEditError(null)
  }
  const saveEdit = async () => {
    if (!editingTicker) return
    setSavingTicker(true)
    setEditError(null)
    try {
      const res = await fetch(`/api/admin/sector-master/${encodeURIComponent(editingTicker)}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(draft),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.message ?? json.error ?? `HTTP ${res.status}`)
      cancelEdit()
      await Promise.all([loadStats(), loadDiag()])
    } catch (e) {
      setEditError((e as Error).message)
    } finally {
      setSavingTicker(false)
    }
  }

  const finishImport = async (res: Response) => {
    const json = await res.json()
    if (!res.ok) {
      const detail = json.message ? `${json.error ?? 'Import failed'}: ${json.message}` : (json.error ?? 'failed')
      throw new Error(detail)
    }
    setSummary(json.summary)
    loadStats()
    loadDiag()
  }

  const upload = async (file: File) => {
    setWorking('upload')
    setSummary(null)
    setError(null)
    try {
      const fd = new FormData()
      fd.append('file', file)
      await finishImport(await fetch('/api/admin/sector-master', { method: 'POST', body: fd }))
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setWorking('idle')
    }
  }

  const fetchJpx = async () => {
    setWorking('jpx')
    setSummary(null)
    setError(null)
    try {
      await finishImport(await fetch('/api/admin/sector-master?source=jpx', { method: 'POST' }))
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setWorking('idle')
    }
  }

  return (
    <div style={{ padding: '16px', display: 'flex', flexDirection: 'column', gap: '16px' }}>
      <div style={{ borderBottom: '1px solid var(--border-subtle)', paddingBottom: '12px' }}>
        <h1 style={{ fontFamily: 'var(--font-display)', fontSize: '16px', fontWeight: 700 }}>
          🏷 業種マスタ取込（Excel / JPX 公式）
        </h1>
        <p style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '4px', lineHeight: 1.6 }}>
          JPX 公式の「上場銘柄一覧」から <code>市場区分（プライム/スタンダード/グロース）</code>・
          <code>33業種区分</code>・<code>17業種区分</code>・<code>銘柄名</code> を取込みます。
          <strong>「JPX から取得」ボタン</strong>で公式の <code>data_j.xls</code> を直接ダウンロード&取込み（推奨）、
          または手元の Excel ファイルをドラッグ&ドロップで取込めます。
        </p>
      </div>

      {/* JPX 自動取得ボタン */}
      <div className="card" style={{ padding: '12px', display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap' }}>
        <div style={{ flex: 1, minWidth: '240px' }}>
          <div style={{ fontSize: '12px', fontWeight: 600, marginBottom: '2px' }}>
            🟢 JPX 公式から自動取得
          </div>
          <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
            <code>data_j.xls</code> を <code>jpx.co.jp</code> から直接ダウンロードして全銘柄を更新します。
          </div>
        </div>
        <button
          onClick={fetchJpx}
          disabled={working !== 'idle'}
          style={{
            padding: '8px 16px',
            fontSize: '12px',
            fontWeight: 600,
            background: working === 'jpx' ? 'var(--bg-elevated)' : 'var(--accent-primary)',
            color: working === 'jpx' ? 'var(--text-muted)' : '#fff',
            border: '1px solid var(--accent-primary)',
            borderRadius: 'var(--radius-sm)',
            cursor: working !== 'idle' ? 'wait' : 'pointer',
            whiteSpace: 'nowrap',
          }}
        >
          {working === 'jpx' ? '取得中…' : 'JPX から取得'}
        </button>
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
          {working === 'upload' ? 'アップロード中…' : '手元の .xlsx をドラッグ&ドロップで取込み'}
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
          cursor: working === 'idle' ? 'pointer' : 'wait',
        }}>
          ファイルを選択
          <input
            type="file"
            accept=".xlsx,.xls"
            disabled={working !== 'idle'}
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
          <div style={{ marginTop: '8px', fontSize: '11px', color: 'var(--text-muted)', display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '4px' }}>
            <span>コード列: <code>{summary.detectedColumns.code ?? '---'}</code></span>
            <span>銘柄名列: <code>{summary.detectedColumns.name ?? '---'}</code></span>
            <span>市場区分列: <code>{summary.detectedColumns.marketSegment ?? '---'}</code></span>
            <span>貸借/信用列: <code>{summary.detectedColumns.marginType ?? '---'}</code></span>
            <span>33業種列: <code>{summary.detectedColumns.sector33 ?? '---'}</code></span>
            <span>業種大分類列: <code>{summary.detectedColumns.sectorLarge ?? '---'}</code></span>
            <span>業種小分類列: <code>{summary.detectedColumns.sectorSmall ?? '---'}</code></span>
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
                <div style={{ fontSize: '10px', color: 'var(--text-muted)' }}>17業種数</div>
                <div style={{ fontSize: '18px', fontFamily: 'var(--font-mono)', fontWeight: 600 }}>
                  {stats.totals.large_count}
                </div>
              </div>
              <div>
                <div style={{ fontSize: '10px', color: 'var(--text-muted)' }}>市場区分数</div>
                <div style={{ fontSize: '18px', fontFamily: 'var(--font-mono)', fontWeight: 600 }}>
                  {stats.totals.segment_count}
                </div>
              </div>
              <div>
                <div style={{ fontSize: '10px', color: 'var(--text-muted)' }}>最終更新</div>
                <div style={{ fontSize: '12px', fontFamily: 'var(--font-mono)' }}>
                  {stats.totals.latest?.replace('T', ' ').slice(0, 16) ?? '---'}
                </div>
              </div>
            </div>

            {/* 市場区分の分布 */}
            {stats.bySegment.length > 0 && (
              <div style={{ borderTop: '1px solid var(--border-subtle)', padding: '12px' }}>
                <div style={{ fontSize: '10px', color: 'var(--text-muted)', marginBottom: '6px' }}>市場区分</div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px' }}>
                  {stats.bySegment.map((row) => (
                    <span key={row.market_segment ?? '_'} style={{
                      padding: '3px 10px',
                      fontSize: '11px',
                      fontFamily: 'var(--font-mono)',
                      background: 'var(--bg-elevated)',
                      border: '1px solid var(--border-base)',
                      borderRadius: '12px',
                      color: 'var(--text-secondary)',
                    }}>
                      {row.market_segment ?? '（未分類）'}（{row.n}）
                    </span>
                  ))}
                </div>
              </div>
            )}

            {/* 大分類の分布 */}
            <div style={{ borderTop: '1px solid var(--border-subtle)', padding: '12px' }}>
              <div style={{ fontSize: '10px', color: 'var(--text-muted)', marginBottom: '6px' }}>17業種区分</div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px' }}>
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
            </div>
          </>
        )}
      </div>

      {/* 網羅率 + 未分類銘柄リスト（最新スナップショット x sector_master） */}
      <div className="card" style={{ overflow: 'hidden' }}>
        <div style={{ padding: '8px 12px', borderBottom: '1px solid var(--border-subtle)', fontSize: '12px', color: 'var(--text-secondary)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span>🔎 最新スナップショット x マスタ網羅率</span>
          <button
            onClick={loadDiag}
            style={{
              padding: '2px 8px',
              fontSize: '10px',
              background: 'transparent',
              color: 'var(--text-muted)',
              border: '1px solid var(--border-base)',
              borderRadius: 'var(--radius-sm)',
              cursor: 'pointer',
            }}
          >
            再取得
          </button>
        </div>
        {!diag || !diag.snapshotDate ? (
          <div style={{ padding: '24px', textAlign: 'center', fontSize: '12px', color: 'var(--text-muted)' }}>
            CSV スナップショットがありません（/admin/import から取込んでください）
          </div>
        ) : (
          <>
            <div style={{ padding: '12px', display: 'flex', gap: '16px', flexWrap: 'wrap', fontSize: '12px' }}>
              <DiagStat label="スナップショット日"  value={diag.snapshotDate} />
              <DiagStat label="銘柄数"             value={diag.totalTickers.toLocaleString()} />
              <DiagStat
                label="マスタ紐付"
                value={`${diag.coveragePct.master.toFixed(1)}%`}
                ok={diag.coveragePct.master >= 95}
              />
              <DiagStat
                label="33業種"
                value={`${diag.coveragePct.sector33.toFixed(1)}%`}
                ok={diag.coveragePct.sector33 >= 90}
              />
              <DiagStat
                label="17業種"
                value={`${diag.coveragePct.large.toFixed(1)}%`}
                ok={diag.coveragePct.large >= 90}
              />
            </div>

            {diag.unmatchedCount === 0 ? (
              <div style={{ borderTop: '1px solid var(--border-subtle)', padding: '12px', fontSize: '12px', color: 'var(--price-up, #22c55e)' }}>
                ✅ 未分類銘柄なし（最新スナップショットの全銘柄がマスタに存在）
              </div>
            ) : (
              <div style={{ borderTop: '1px solid var(--border-subtle)', padding: '12px' }}>
                <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: '8px', flexWrap: 'wrap', gap: '8px' }}>
                  <div style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>
                    ⚠️ マスタ未登録: <strong style={{ color: 'var(--price-down)' }}>{diag.unmatchedCount.toLocaleString()}</strong> 件
                    {diag.unmatchedSample.length < diag.unmatchedCount && (
                      <span style={{ color: 'var(--text-muted)', marginLeft: '6px' }}>
                        （上位 {diag.unmatchedSample.length} 件を表示）
                      </span>
                    )}
                  </div>
                  <div style={{ fontSize: '10px', color: 'var(--text-muted)' }}>
                    JPX 公式に無い銘柄（ETF/REIT/新規上場）は手動で sector_master に追加してください
                  </div>
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: '4px' }}>
                  {diag.unmatchedSample.map((u) => {
                    const isEditing = editingTicker === u.ticker
                    if (isEditing) {
                      return (
                        <div key={u.ticker} style={{ gridColumn: '1 / -1' }}>
                          <UnmatchedEditor
                            ticker={u.ticker}
                            name={u.name}
                            draft={draft}
                            setDraft={setDraft}
                            saving={savingTicker}
                            error={editError}
                            largeOptions={diag.byLarge.map((x) => x.label)}
                            sector33Options={diag.bySector33.map((x) => x.label)}
                            onCancel={cancelEdit}
                            onSave={saveEdit}
                          />
                        </div>
                      )
                    }
                    return (
                      <button
                        key={u.ticker}
                        onClick={() => startEdit(u.ticker, u.name)}
                        style={{
                          padding: '4px 8px',
                          fontSize: '11px',
                          background: 'var(--bg-elevated)',
                          border: '1px solid var(--border-base)',
                          borderRadius: 'var(--radius-sm)',
                          display: 'flex',
                          gap: '8px',
                          alignItems: 'baseline',
                          cursor: 'pointer',
                          textAlign: 'left',
                          width: '100%',
                          fontFamily: 'inherit',
                        }}
                        title="クリックでマスタ補完"
                      >
                        <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 600, color: 'var(--accent-primary)' }}>
                          {u.ticker.replace('.T', '')}
                        </span>
                        <span style={{ color: 'var(--text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>
                          {u.name || '（名称不明）'}
                        </span>
                        <span style={{ fontSize: '10px', color: 'var(--text-muted)' }}>＋</span>
                      </button>
                    )
                  })}
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}

interface UnmatchedEditorProps {
  ticker: string
  name: string
  draft: EditDraft
  setDraft: (d: EditDraft) => void
  saving: boolean
  error: string | null
  largeOptions: string[]
  sector33Options: string[]
  onCancel: () => void
  onSave: () => void
}

function UnmatchedEditor({
  ticker, name, draft, setDraft, saving, error, largeOptions, sector33Options, onCancel, onSave,
}: UnmatchedEditorProps) {
  const update = (k: keyof EditDraft, v: string) => setDraft({ ...draft, [k]: v })
  const labelStyle = { fontSize: '10px', color: 'var(--text-muted)', display: 'block', marginBottom: '2px' } as const
  const inputStyle = {
    width: '100%',
    padding: '4px 6px',
    fontSize: '11px',
    background: 'var(--bg-base)',
    border: '1px solid var(--border-base)',
    borderRadius: 'var(--radius-sm)',
    color: 'var(--text-primary)',
    fontFamily: 'inherit',
  } as const
  const isValid = !!(draft.sector_large || draft.sector_small || draft.sector33 || draft.market_segment || draft.margin_type)

  return (
    <div style={{
      padding: '12px',
      background: 'var(--bg-base)',
      border: '1px solid var(--accent-primary)',
      borderRadius: 'var(--radius-md)',
    }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: '8px', marginBottom: '10px' }}>
        <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 700, color: 'var(--accent-primary)', fontSize: '13px' }}>
          {ticker.replace('.T', '')}
        </span>
        <span style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>{name || '（名称不明）'}</span>
        <span style={{ fontSize: '10px', color: 'var(--text-muted)', marginLeft: 'auto' }}>
          sector_master に手動追加
        </span>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: '8px', marginBottom: '10px' }}>
        <div>
          <label style={labelStyle}>銘柄名（任意・上書き）</label>
          <input
            style={inputStyle}
            value={draft.name}
            onChange={(e) => update('name', e.target.value)}
            placeholder={name}
          />
        </div>
        <div>
          <label style={labelStyle}>市場区分</label>
          <select style={inputStyle} value={draft.market_segment} onChange={(e) => update('market_segment', e.target.value)}>
            <option value="">（未指定）</option>
            {MARKET_SEGMENTS.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </div>
        <div>
          <label style={labelStyle}>17業種（大分類）</label>
          <input
            style={inputStyle}
            list={`large-options-${ticker}`}
            value={draft.sector_large}
            onChange={(e) => update('sector_large', e.target.value)}
            placeholder="例: 情報通信・サービスその他"
          />
          <datalist id={`large-options-${ticker}`}>
            {largeOptions.map((s) => <option key={s} value={s} />)}
          </datalist>
        </div>
        <div>
          <label style={labelStyle}>33業種</label>
          <input
            style={inputStyle}
            list={`sector33-options-${ticker}`}
            value={draft.sector33}
            onChange={(e) => update('sector33', e.target.value)}
            placeholder="例: サービス業"
          />
          <datalist id={`sector33-options-${ticker}`}>
            {sector33Options.map((s) => <option key={s} value={s} />)}
          </datalist>
        </div>
        <div>
          <label style={labelStyle}>業種小分類（任意）</label>
          <input
            style={inputStyle}
            value={draft.sector_small}
            onChange={(e) => update('sector_small', e.target.value)}
            placeholder="自由記述"
          />
        </div>
        <div>
          <label style={labelStyle}>貸借/信用</label>
          <select style={inputStyle} value={draft.margin_type} onChange={(e) => update('margin_type', e.target.value)}>
            <option value="">（未指定）</option>
            {MARGIN_TYPES.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </div>
      </div>

      {error && (
        <div style={{ fontSize: '11px', color: 'var(--price-down)', marginBottom: '8px' }}>
          ⚠️ {error}
        </div>
      )}

      <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end' }}>
        <button
          onClick={onCancel}
          disabled={saving}
          style={{
            padding: '4px 12px', fontSize: '11px', background: 'transparent',
            color: 'var(--text-secondary)', border: '1px solid var(--border-base)',
            borderRadius: 'var(--radius-sm)', cursor: saving ? 'wait' : 'pointer',
          }}
        >
          キャンセル
        </button>
        <button
          onClick={onSave}
          disabled={saving || !isValid}
          style={{
            padding: '4px 12px', fontSize: '11px', fontWeight: 600,
            background: isValid && !saving ? 'var(--accent-primary)' : 'var(--bg-elevated)',
            color: isValid && !saving ? '#fff' : 'var(--text-muted)',
            border: '1px solid var(--accent-primary)',
            borderRadius: 'var(--radius-sm)',
            cursor: saving ? 'wait' : (isValid ? 'pointer' : 'not-allowed'),
          }}
        >
          {saving ? '保存中…' : '保存'}
        </button>
      </div>
    </div>
  )
}

function DiagStat({ label, value, ok }: { label: string; value: string; ok?: boolean }) {
  const valueColor = ok === undefined
    ? 'var(--text-primary)'
    : ok
      ? 'var(--price-up, #22c55e)'
      : 'var(--price-down)'
  return (
    <div>
      <div style={{ fontSize: '10px', color: 'var(--text-muted)' }}>{label}</div>
      <div style={{ fontSize: '14px', fontFamily: 'var(--font-mono)', fontWeight: 600, color: valueColor }}>
        {value}
      </div>
    </div>
  )
}
