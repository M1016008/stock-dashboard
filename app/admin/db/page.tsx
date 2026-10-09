// app/admin/db/page.tsx
'use client'

import { useEffect, useState, useCallback } from 'react'
import { FolderOpen, RefreshCw, Search } from 'lucide-react'
import { PageTitle } from '@/components/layout/PageTitle'
import { Notice } from '@/components/ui/EmptyState'

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

  const runningCount = runs.filter((run) => run.status === 'running').length
  const failedCount = runs.filter((run) => run.status === 'failed').length

  return (
    <div className="flex w-full min-w-0 max-w-full flex-col gap-5">
      <PageTitle
        eyebrow="管理"
        title="運用ステータス"
        subtitle="データベース状態・バッチ履歴・銘柄ユニバースを確認します。この画面からの書き込み操作はありません。"
        badge="読み取り専用"
        badgeTone="neutral"
        meta={runningCount > 0 || failedCount > 0 ? <>
          {runningCount > 0 && <span className="text-[var(--color-pattern-700)]">実行中 {runningCount}件 ・ 5秒ごとに自動更新</span>}
          {failedCount > 0 && <span className="text-[var(--color-price-up-strong)]">直近の失敗 {failedCount}件</span>}
        </> : undefined}
        rightSlot={(
          <button type="button" onClick={loadAll} className="btn" disabled={loading} aria-busy={loading}>
            <RefreshCw size={14} aria-hidden className={loading ? 'animate-spin' : undefined} />
            {loading ? '更新中…' : '再読み込み'}
          </button>
        )}
      />

      {error && (
        <Notice tone="error" role="alert" title="読み込みに失敗しました">{error}</Notice>
      )}

      {/* サマリー: 狭い画面では縦積み、sm 以上で 3 列 */}
      <div className="grid min-w-0 grid-cols-1 gap-2 sm:grid-cols-3">
        <SummaryCard
          label="総レコード数"
          value={stats?.totalRecords?.toLocaleString() ?? '---'}
          unit={stats?.totalRecordsEstimated ? '件 (概算含む)' : '件'}
        />
        <SummaryCard label="DB容量" value={stats?.dbSizeMB ?? '---'} unit="MB" />
        <SummaryCard label="ユニバース (active)" value={universe ? universe.active.toLocaleString() : '---'} unit={`/ ${(universe?.total ?? 0).toLocaleString()}`} />
      </div>

      {/* データ更新バッチ */}
      <section className="panel" aria-labelledby="admin-batch-title">
        <div className="panel-head">
          <div className="min-w-0">
            <h2 id="admin-batch-title">データ更新バッチ</h2>
            <p>起動操作はCLI/定期バッチに集約しています</p>
          </div>
        </div>
        <div className="flex flex-col gap-3 p-3 sm:p-4">
          <Notice tone="neutral">
            手動実行ボタンは誤操作防止のため停止しました。J-Quants更新、スナップショット計算、ML更新は定期ジョブまたはCLIから実行してください。
          </Notice>

          <div className="min-w-0 max-w-full overflow-x-auto">
            <table style={{ width: '100%', minWidth: '560px', borderCollapse: 'collapse', fontSize: '12px' }}>
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
        </div>
      </section>

      {/* 銘柄ユニバース管理 */}
      <section className="panel" aria-labelledby="admin-universe-title">
        <div className="panel-head">
          <div className="min-w-0">
            <h2 id="admin-universe-title">銘柄ユニバース</h2>
            <p>{universe?.total.toLocaleString() ?? '-'}件 / active {universe?.active.toLocaleString() ?? '-'}件</p>
          </div>
        </div>
        <div className="flex flex-col gap-3 p-3 sm:p-4">
          <Notice tone="neutral">
            銘柄の追加・active切替は画面から停止しました。正規マスターはJ-Quants銘柄マスターと定期バッチで管理します。
          </Notice>

          <div>
            <label className="relative block max-w-[520px]">
              <span className="sr-only">銘柄コードまたは名前で検索</span>
              <Search size={14} aria-hidden className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--color-text-tertiary)]" />
              <input
                type="text"
                value={universeFilter}
                onChange={(e) => setUniverseFilter(e.target.value)}
                placeholder="銘柄コード or 名前で検索 (最大50件)"
                style={inputStyle}
              />
            </label>
            {universeLoading && (
              <div role="status" style={{ marginTop: '6px', fontSize: '12px', color: 'var(--text-muted)' }}>検索中…</div>
            )}
            <div className="min-w-0 max-w-full overflow-x-auto">
              <table style={{ width: '100%', minWidth: '420px', borderCollapse: 'collapse', fontSize: '12px', marginTop: '8px' }}>
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
                      <span className="status-tag" data-tone={it.active ? 'positive' : undefined}>
                        {it.active ? 'active' : 'inactive'}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
              </table>
            </div>
            {universeFilter && !universeLoading && (universe?.matched ?? 0) > filteredUniverse.length && (
              <div style={{ marginTop: '6px', fontSize: '12px', color: 'var(--text-muted)', textAlign: 'right' }}>
                該当 {(universe?.matched ?? 0).toLocaleString()} 件のうち先頭 {filteredUniverse.length.toLocaleString()} 件
              </div>
            )}
          </div>
        </div>
      </section>

      {/* テーブル別レコード数 (既存) */}
      <section className="panel" aria-labelledby="admin-tables-title">
        <div className="panel-head">
          <div className="min-w-0">
            <h2 id="admin-tables-title">テーブル別レコード数</h2>
            <p>大規模テーブルはANALYZE統計の概算値を表示</p>
          </div>
          <span className="text-[12px] tabular-nums text-[var(--color-text-tertiary)]">{stats ? `${stats.tables.length}テーブル` : ''}</span>
        </div>
        <div className="min-w-0 max-w-full overflow-x-auto">
          <table style={{ width: '100%', minWidth: '460px', borderCollapse: 'collapse', fontSize: '12px' }}>
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
            {!stats && loading && (
              <tr><td colSpan={3} style={{ ...cellStyle, textAlign: 'center', color: 'var(--text-muted)' }}>読み込み中…</td></tr>
            )}
            {!stats && !loading && (
              <tr><td colSpan={3} style={{ ...cellStyle, textAlign: 'center', color: 'var(--text-muted)' }}>データなし</td></tr>
            )}
          </tbody>
          </table>
        </div>
      </section>

      {/* 補足 */}
      <p className="m-0 flex items-start gap-2 text-[12px] leading-5 text-[var(--color-text-tertiary)]" style={{ overflowWrap: 'anywhere' }}>
        <FolderOpen size={14} aria-hidden className="mt-0.5 shrink-0" />
        <span>DB パス: <code className="font-mono text-[var(--color-text-secondary)]">{stats?.dbPath ?? '---'}</code></span>
      </p>
    </div>
  )
}

// ─── 補助コンポーネント ───

function StatusBadge({ status }: { status: string }) {
  const map: Record<string, { tone?: 'brand' | 'positive' | 'warning' | 'danger'; label: string }> = {
    running: { tone: 'brand', label: '実行中' },
    success: { tone: 'positive', label: '完了' },
    partial: { tone: 'warning', label: '一部完了' },
    failed:  { tone: 'danger', label: '失敗' },
  }
  const s = map[status] ?? { label: status }
  return <span className="status-tag" data-tone={s.tone}>{s.label}</span>
}

function SummaryCard({ label, value, unit }: { label: string; value: string; unit: string }) {
  return (
    <div className="min-w-0 rounded-[var(--radius-card)] border border-[var(--color-border-soft)] bg-[var(--color-surface-subtle)] px-4 py-3">
      <div className="text-[12px] font-semibold text-[var(--color-text-tertiary)]">{label}</div>
      <div className="mt-1 truncate font-mono text-[20px] font-bold tabular-nums text-[var(--color-text-primary)]">
        {value} <span className="font-sans text-[12px] font-normal text-[var(--color-text-tertiary)]">{unit}</span>
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

// 運用表は等幅で桁を揃え、見出しは表の地色 (surface-subtle) で本文と分ける
const headStyle: React.CSSProperties = {
  padding: '8px 12px',
  textAlign: 'left',
  fontWeight: 600,
  color: 'var(--color-text-tertiary)',
  background: 'var(--color-surface-subtle)',
  borderBottom: '1px solid var(--color-border-default)',
  fontSize: '12px',
  whiteSpace: 'nowrap',
}

const headStyleR: React.CSSProperties = { ...headStyle, textAlign: 'right' }

const cellStyle: React.CSSProperties = {
  padding: '7px 12px',
  fontFamily: 'var(--font-mono)',
  fontSize: '12px',
  color: 'var(--text-primary)',
  fontVariantNumeric: 'tabular-nums',
}

const cellStyleR: React.CSSProperties = { ...cellStyle, textAlign: 'right' }

const inputStyle: React.CSSProperties = {
  width: '100%',
  height: '36px',
  fontFamily: 'var(--font-mono)',
  fontSize: '13px',
  padding: '0 10px 0 30px',
}

const estimateBadge: React.CSSProperties = {
  display: 'inline-block',
  marginLeft: '6px',
  padding: '0 5px',
  borderRadius: '3px',
  border: '1px solid var(--color-border-default)',
  color: 'var(--color-text-tertiary)',
  fontSize: '11px',
  fontFamily: 'var(--font-sans)',
}
