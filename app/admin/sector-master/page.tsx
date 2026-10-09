// app/admin/sector-master/page.tsx
'use client'

import { useEffect, useState } from 'react'
import { CircleCheck, RefreshCw, TriangleAlert } from 'lucide-react'
import { PageTitle } from '@/components/layout/PageTitle'
import { EmptyState, Notice } from '@/components/ui/EmptyState'

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
  const [statsLoaded, setStatsLoaded] = useState(false)
  const [diagLoading, setDiagLoading] = useState(true)

  const loadStats = async () => {
    try {
      const res = await fetch('/api/admin/sector-master', { cache: 'no-store' })
      const json = await res.json()
      if (res.ok) setStats(json)
    } catch { /* 無視 */ } finally {
      setStatsLoaded(true)
    }
  }

  const loadDiag = async () => {
    setDiagLoading(true)
    try {
      const res = await fetch('/api/admin/sector-master/diagnostics', { cache: 'no-store' })
      const json = await res.json()
      if (res.ok) setDiag(json)
    } catch { /* 無視 */ } finally {
      setDiagLoading(false)
    }
  }

  useEffect(() => { loadStats(); loadDiag() }, [])

  return (
    <div className="flex w-full min-w-0 flex-col gap-5">
      <PageTitle
        eyebrow="管理"
        title="業種マスター管理"
        subtitle="J-Quants 銘柄マスターを基準に、市場区分・33業種・17業種・貸借属性を診断します。手動補完は停止しています。"
        badge="読み取り専用"
        badgeTone="neutral"
        meta={stats?.totals?.latest ? <span>マスター最終更新 {stats.totals.latest.replace('T', ' ').slice(0, 16)}</span> : undefined}
      />

      {/* 網羅率 (結論) を先に置き、登録状況の内訳はその下で確認する */}
      <section className="panel" aria-labelledby="sector-master-coverage-title">
        <div className="panel-head">
          <div className="min-w-0">
            <h2 id="sector-master-coverage-title">最新スナップショット × マスター網羅率</h2>
            <p>紐付 95%以上・業種 90%以上を目安に確認します</p>
          </div>
          <button type="button" onClick={loadDiag} className="btn" data-size="sm" disabled={diagLoading} aria-busy={diagLoading}>
            <RefreshCw size={13} aria-hidden className={diagLoading ? 'animate-spin' : undefined} />
            再取得
          </button>
        </div>
        {!diag || !diag.snapshotDate ? (
          diagLoading
            ? <p className="px-4 py-8 text-center text-[13px] text-[var(--color-text-tertiary)]" role="status">診断を読み込んでいます…</p>
            : <EmptyState title="スナップショットデータがありません" description="日次スナップショットの生成後に網羅率を確認できます。" />
        ) : (
          <>
            <dl className="m-0 grid grid-cols-2 gap-px border-b border-[var(--color-border-soft)] bg-[var(--color-border-soft)] sm:grid-cols-3 lg:grid-cols-5">
              <DiagStat label="スナップショット日" value={diag.snapshotDate} />
              <DiagStat label="銘柄数" value={diag.totalTickers.toLocaleString()} />
              <DiagStat label="マスター紐付" value={`${diag.coveragePct.master.toFixed(1)}%`} ok={diag.coveragePct.master >= 95} />
              <DiagStat label="33業種" value={`${diag.coveragePct.sector33.toFixed(1)}%`} ok={diag.coveragePct.sector33 >= 90} />
              <DiagStat label="17業種" value={`${diag.coveragePct.large.toFixed(1)}%`} ok={diag.coveragePct.large >= 90} />
            </dl>

            {diag.unmatchedCount === 0 ? (
              <p className="m-0 flex items-center gap-2 px-4 py-3 text-[13px] font-semibold text-[var(--color-pattern-700)]">
                <CircleCheck size={15} aria-hidden />
                未分類銘柄なし（最新スナップショットの全銘柄がマスターに存在）
              </p>
            ) : (
              <div className="flex flex-col gap-3 p-4">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <p className="m-0 text-[13px] text-[var(--color-text-secondary)]">
                    マスター未登録 <strong className="font-mono tabular-nums text-[var(--color-price-up-strong)]">{diag.unmatchedCount.toLocaleString()}</strong> 件
                    {diag.unmatchedSample.length < diag.unmatchedCount && (
                      <span className="ml-1.5 text-[var(--color-text-tertiary)]">（上位 {diag.unmatchedSample.length} 件を表示）</span>
                    )}
                  </p>
                  <p className="m-0 text-[12px] text-[var(--color-text-tertiary)]">
                    手動補完は停止中です。必要な補完はCLIまたは定期バッチ側へ集約してください
                  </p>
                </div>
                <ul className="grid gap-px overflow-hidden rounded-[4px] border border-[var(--color-border-soft)] bg-[var(--color-border-soft)] [grid-template-columns:repeat(auto-fill,minmax(220px,1fr))]">
                  {diag.unmatchedSample.map((u) => (
                    <li key={u.ticker} className="flex min-w-0 items-baseline gap-2 bg-white px-3 py-1.5 text-[12px]" title="読み取り専用">
                      <span className="shrink-0 font-mono font-bold text-[var(--color-brand-800)]">{u.ticker.replace('.T', '')}</span>
                      <span className="min-w-0 truncate text-[var(--color-text-secondary)]">{u.name || '（名称不明）'}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </>
        )}
      </section>

      {/* 現在の登録状況 */}
      <section className="panel" aria-labelledby="sector-master-registry-title">
        <div className="panel-head">
          <div className="min-w-0">
            <h2 id="sector-master-registry-title">現在の登録状況</h2>
            <p>市場区分と17業種区分の内訳</p>
          </div>
        </div>
        {!stats || !stats.totals ? (
          statsLoaded
            ? <EmptyState title="まだデータがありません" description="J-Quants 銘柄マスターの同期後に表示されます。" />
            : <p className="px-4 py-8 text-center text-[13px] text-[var(--color-text-tertiary)]" role="status">登録状況を読み込んでいます…</p>
        ) : (
          <>
            <dl className="m-0 grid grid-cols-2 gap-px border-b border-[var(--color-border-soft)] bg-[var(--color-border-soft)] sm:grid-cols-4">
              <DiagStat label="登録銘柄数" value={stats.totals.total.toLocaleString('ja-JP')} />
              <DiagStat label="17業種数" value={String(stats.totals.large_count)} />
              <DiagStat label="市場区分数" value={String(stats.totals.segment_count)} />
              <DiagStat label="最終更新" value={stats.totals.latest?.replace('T', ' ').slice(0, 16) ?? '---'} small />
            </dl>
            <div className="grid min-w-0 gap-6 p-4 lg:grid-cols-2">
              {stats.bySegment.length > 0 && (
                <Distribution
                  title="市場区分"
                  rows={stats.bySegment.map((row) => ({ label: row.market_segment ?? '（未分類）', n: row.n }))}
                />
              )}
              <Distribution
                title="17業種区分"
                rows={stats.byLarge.map((row) => ({ label: row.sector_large ?? '（未分類）', n: row.n }))}
              />
            </div>
          </>
        )}
      </section>

      <Notice tone="neutral">
        この画面は診断専用です。業種マスターの更新は J-Quants 銘柄マスターの定期同期で行います。
      </Notice>
    </div>
  )
}

/** 件数の内訳を横棒付きの行で並べる (最大件数を 100% とした相対幅) */
function Distribution({ title, rows }: { title: string; rows: { label: string; n: number }[] }) {
  const max = Math.max(1, ...rows.map((row) => row.n))
  return (
    <section className="min-w-0">
      <h3 className="mb-2 border-b border-[var(--color-border-soft)] pb-1.5 text-[13px] font-bold text-[var(--color-text-primary)]">
        {title}
        <span className="ml-2 text-[12px] font-normal text-[var(--color-text-tertiary)]">{rows.length}区分</span>
      </h3>
      <ul className="flex flex-col gap-1">
        {rows.map((row) => (
          <li key={row.label} className="grid grid-cols-[minmax(0,10rem)_minmax(0,1fr)_4rem] items-center gap-2 text-[12px]">
            <span className="truncate text-[var(--color-text-secondary)]" title={row.label}>{row.label}</span>
            <span className="h-2 rounded-[2px] bg-[var(--color-surface-muted)]" aria-hidden>
              <span className="block h-full rounded-[2px] bg-[var(--color-brand-400)]" style={{ width: `${(row.n / max) * 100}%` }} />
            </span>
            <span className="text-right font-mono tabular-nums text-[var(--color-text-primary)]">{row.n.toLocaleString('ja-JP')}</span>
          </li>
        ))}
      </ul>
    </section>
  )
}

function DiagStat({ label, value, ok, small = false }: { label: string; value: string; ok?: boolean; small?: boolean }) {
  // 網羅率は「基準を満たす / 満たさない」の判定色 (価格の赤・青とは分ける)
  const valueColor = ok === undefined
    ? 'text-[var(--color-text-primary)]'
    : ok
      ? 'text-[var(--color-pattern-700)]'
      : 'text-[#9a5b00]'
  return (
    <div className="min-w-0 bg-white px-4 py-3">
      <dt className="flex items-center gap-1 truncate text-[12px] font-semibold text-[var(--color-text-tertiary)]">
        {label}
        {ok === false && <TriangleAlert size={12} aria-label="基準未満" className="text-[#b45309]" />}
      </dt>
      <dd className={`m-0 mt-1 truncate font-mono font-bold tabular-nums ${small ? 'text-[13px]' : 'text-[18px]'} ${valueColor}`}>
        {value}
      </dd>
    </div>
  )
}
