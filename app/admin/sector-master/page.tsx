// app/admin/sector-master/page.tsx
'use client'

import { useEffect, useState } from 'react'
import { PageTitle } from '@/components/layout/PageTitle'

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

export default function SectorMasterPage() {
  const [stats, setStats] = useState<Stats | null>(null)
  const [diag, setDiag] = useState<Diagnostics | null>(null)
  const [editingTicker, setEditingTicker] = useState<string | null>(null)
  const [draft, setDraft] = useState<EditDraft>(EMPTY_DRAFT)
  const [savingTicker, setSavingTicker] = useState(false)
  const [editError, setEditError] = useState<string | null>(null)

  const loadStats = async () => {
    try {
      const res = await fetch('/api/admin/sector-master', { cache: 'no-store' })
      const json = await res.json()
      if (res.ok) setStats(json)
    } catch { /* 無視 */ }
  }

  const loadDiag = async () => {
    try {
      const res = await fetch('/api/admin/sector-master/diagnostics', { cache: 'no-store' })
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
        cache: 'no-store',
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

  return (
    <div className="flex flex-col gap-5">
      <PageTitle
        title="業種マスター管理"
        subtitle="J-Quants 銘柄マスターを基準に、市場区分・33業種・17業種・貸借属性を診断・補完します。"
        badge="Admin"
      />

      {/* 現在の登録状況 */}
      <div className="card overflow-hidden">
        <div className="border-b border-[var(--color-border-soft)] px-4 py-3 text-[13px] font-bold text-[var(--color-text-primary)]">
          現在の登録状況
        </div>
        {!stats || !stats.totals ? (
          <div className="p-6 text-center text-[12px] font-medium text-[var(--color-text-tertiary)]">
            まだデータがありません
          </div>
        ) : (
          <>
            <div className="flex flex-wrap gap-8 p-4 text-[12px]">
              <div>
                <div className="text-[10px] font-bold text-[var(--color-text-tertiary)]">登録銘柄数</div>
                <div className="font-mono text-[20px] font-bold">
                  {stats.totals.total.toLocaleString('ja-JP')}
                </div>
              </div>
              <div>
                <div className="text-[10px] font-bold text-[var(--color-text-tertiary)]">17業種数</div>
                <div className="font-mono text-[20px] font-bold">
                  {stats.totals.large_count}
                </div>
              </div>
              <div>
                <div className="text-[10px] font-bold text-[var(--color-text-tertiary)]">市場区分数</div>
                <div className="font-mono text-[20px] font-bold">
                  {stats.totals.segment_count}
                </div>
              </div>
              <div>
                <div className="text-[10px] font-bold text-[var(--color-text-tertiary)]">最終更新</div>
                <div className="font-mono text-[12px] font-semibold">
                  {stats.totals.latest?.replace('T', ' ').slice(0, 16) ?? '---'}
                </div>
              </div>
            </div>

            {/* 市場区分の分布 */}
            {stats.bySegment.length > 0 && (
              <div className="border-t border-[var(--color-border-soft)] p-4">
                <div className="mb-2 text-[10px] font-bold text-[var(--color-text-tertiary)]">市場区分</div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px' }}>
                  {stats.bySegment.map((row) => (
                    <span key={row.market_segment ?? '_'} style={{
                      padding: '3px 10px',
                      fontSize: '11px',
                      fontFamily: 'var(--font-mono)',
                      background: 'var(--color-surface-field)',
                      border: '1px solid var(--color-border-soft)',
                      borderRadius: '6px',
                      color: 'var(--color-text-secondary)',
                    }}>
                      {row.market_segment ?? '（未分類）'}（{row.n}）
                    </span>
                  ))}
                </div>
              </div>
            )}

            {/* 大分類の分布 */}
            <div className="border-t border-[var(--color-border-soft)] p-4">
              <div className="mb-2 text-[10px] font-bold text-[var(--color-text-tertiary)]">17業種区分</div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px' }}>
                {stats.byLarge.map((row) => (
                  <span key={row.sector_large ?? '_'} style={{
                    padding: '3px 8px',
                    fontSize: '11px',
                    fontFamily: 'var(--font-mono)',
                    background: 'var(--color-surface-field)',
                    border: '1px solid var(--color-border-soft)',
                    borderRadius: '6px',
                    color: 'var(--color-text-secondary)',
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
      <div className="card overflow-hidden">
        <div className="flex items-center justify-between border-b border-[var(--color-border-soft)] px-4 py-3 text-[13px] font-bold text-[var(--color-text-primary)]">
          <span>最新スナップショット x マスタ網羅率</span>
          <button
            onClick={loadDiag}
            className="h-7 rounded-[6px] border border-[var(--color-border-default)] px-2.5 text-[11px] font-bold text-[var(--color-text-secondary)] transition-colors hover:bg-[var(--color-surface-subtle)]"
          >
            再取得
          </button>
        </div>
        {!diag || !diag.snapshotDate ? (
          <div className="p-6 text-center text-[12px] font-medium text-[var(--color-text-tertiary)]">
            スナップショットデータがありません
          </div>
        ) : (
          <>
            <div className="flex flex-wrap gap-6 p-4 text-[12px]">
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
              <div className="border-t border-[var(--color-border-soft)] p-4 text-[12px] font-semibold text-[var(--color-pattern-600)]">
                未分類銘柄なし（最新スナップショットの全銘柄がマスタに存在）
              </div>
            ) : (
              <div className="border-t border-[var(--color-border-soft)] p-4">
                <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: '8px', flexWrap: 'wrap', gap: '8px' }}>
                  <div style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>
                    マスタ未登録: <strong style={{ color: 'var(--price-down)' }}>{diag.unmatchedCount.toLocaleString()}</strong> 件
                    {diag.unmatchedSample.length < diag.unmatchedCount && (
                      <span style={{ color: 'var(--text-muted)', marginLeft: '6px' }}>
                        （上位 {diag.unmatchedSample.length} 件を表示）
                      </span>
                    )}
                  </div>
                  <div style={{ fontSize: '10px', color: 'var(--text-muted)' }}>
                    J-Quants マスターで補完できない銘柄（ETF/REIT/新規上場など）は手動で sector_master に追加してください
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
                          background: 'var(--color-surface-field)',
                          border: '1px solid var(--color-border-soft)',
                          borderRadius: '6px',
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
                        <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 700, color: 'var(--accent-primary)' }}>
                          {u.ticker.replace('.T', '')}
                        </span>
                        <span style={{ color: 'var(--text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>
                          {u.name || '（名称不明）'}
                        </span>
                        <span style={{ fontSize: '10px', color: 'var(--text-muted)' }}>+</span>
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
      borderRadius: 'var(--radius-card)',
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
          {error}
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
      <div style={{ fontSize: '10px', fontWeight: 700, color: 'var(--text-muted)' }}>{label}</div>
      <div style={{ fontSize: '15px', fontFamily: 'var(--font-mono)', fontWeight: 700, color: valueColor }}>
        {value}
      </div>
    </div>
  )
}
