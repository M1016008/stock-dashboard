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

export default function SectorMasterPage() {
  const [stats, setStats] = useState<Stats | null>(null)
  const [diag, setDiag] = useState<Diagnostics | null>(null)

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

  return (
    <div className="flex flex-col gap-5">
      <PageTitle
        title="業種マスター管理"
        subtitle="J-Quants 銘柄マスターを基準に、市場区分・33業種・17業種・貸借属性を診断します。手動補完は停止しています。"
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
                    手動補完は停止中です。必要な補完はCLIまたは定期バッチ側へ集約してください
                  </div>
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: '4px' }}>
                  {diag.unmatchedSample.map((u) => (
                    <div
                      key={u.ticker}
                      style={{
                        padding: '4px 8px',
                        fontSize: '11px',
                        background: 'var(--color-surface-field)',
                        border: '1px solid var(--color-border-soft)',
                        borderRadius: '6px',
                        display: 'flex',
                        gap: '8px',
                        alignItems: 'baseline',
                        textAlign: 'left',
                        width: '100%',
                        fontFamily: 'inherit',
                      }}
                      title="読み取り専用"
                    >
                      <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 700, color: 'var(--accent-primary)' }}>
                        {u.ticker.replace('.T', '')}
                      </span>
                      <span
                        style={{ color: 'var(--text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}
                      >
                        {u.name || '（名称不明）'}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </>
        )}
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
