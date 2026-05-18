// app/sectors/page.tsx
// モック準拠 (stockboard_sectors_mock):
//   - 本日/今週/今月 + ヒートマップ/ランキング タブ + 右上に銘柄数
//   - 59 大分類の 6 列ヒートマップ (背景色 = 騰落率、内側に大分類名 + 騰落率)
//   - 上昇トップ / 下落トップ 2 列テーブル
//   - 選択中 (?selected=) 大分類のドリルダウン (業種細分類一覧)

import type { Metadata } from 'next'
import Link from 'next/link'
import { getSectorRows, getSubSectorsFor } from '@/lib/queries/sectors'

export const metadata: Metadata = {
  title: '業種別 — StockBoard',
  description: '59 大分類で市場全体の流れを把握',
}

export const dynamic = 'force-dynamic'
export const revalidate = 0
export const fetchCache = 'force-no-store'

function cellColor(pct: number): { bg: string; color: string; muted: boolean } {
  // intensity を 0〜0.32 の rgba opacity に。±0.05 未満は中立色
  const abs = Math.abs(pct)
  if (abs < 0.05) {
    return { bg: 'var(--color-surface-subtle)', color: 'var(--color-text-tertiary)', muted: true }
  }
  const intensity = Math.min(0.32, abs / 3 * 0.30)
  if (pct > 0) {
    return {
      bg: `rgba(220, 38, 38, ${intensity.toFixed(2)})`,
      color: abs >= 1.5 ? '#7f1d1d' : '#991b1b',
      muted: false,
    }
  }
  return {
    bg: `rgba(37, 99, 235, ${intensity.toFixed(2)})`,
    color: abs >= 1.5 ? '#1e3a8a' : '#1e40af',
    muted: false,
  }
}

export default async function SectorsPage({
  searchParams,
}: {
  searchParams: Promise<{ selected?: string }>
}) {
  const sp = await searchParams
  const selected = sp.selected ?? null

  const [{ rows }, subRows] = await Promise.all([
    getSectorRows(),
    selected ? getSubSectorsFor(selected) : Promise.resolve([]),
  ])

  const sorted = [...rows].sort((a, b) => b.avg_change - a.avg_change)
  const totalStocks = sorted.reduce((a, r) => a + r.n_stocks, 0)
  const top = sorted.slice(0, 5)
  const bottom = sorted.slice(-5).reverse()

  return (
    <div className="sb-page">
      <div className="sb-page-title">
        <h1>業種別 (大分類)</h1>
        <p>59 大分類で市場全体の流れを把握。クリックで業種細分類へドリルダウン</p>
      </div>

      {/* タブ + 銘柄数 */}
      <div className="sb-section" style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
        <span className="sb-tab sb-on">本日</span>
        <span className="sb-tab" style={{ opacity: 0.5, cursor: 'not-allowed' }}>今週</span>
        <span className="sb-tab" style={{ opacity: 0.5, cursor: 'not-allowed' }}>今月</span>
        <span className="sb-tab sb-on" style={{ marginLeft: 8 }}>ヒートマップ</span>
        <span className="sb-tab" style={{ opacity: 0.5, cursor: 'not-allowed' }}>ランキング</span>
        <span className="sb-t" style={{ fontSize: 11, marginLeft: 'auto' }}>
          {totalStocks.toLocaleString()} 銘柄
        </span>
      </div>

      {/* ヒートマップ */}
      <div className="sb-section">
        <div className="sb-hd">
          <h2>{rows.length} 大分類ヒートマップ</h2>
          <span>セル色 = 騰落率 · 数字 = 騰落率(%)</span>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(6, 1fr)', gap: 3 }}>
          {sorted.map(r => {
            const c = cellColor(r.avg_change ?? 0)
            const isSelected = selected === r.sector_name
            const params = new URLSearchParams({ selected: r.sector_name })
            return (
              <Link
                key={r.sector_name}
                href={`/sectors?${params.toString()}`}
                className="sb-cell"
                style={{
                  background: c.bg,
                  outline: isSelected ? `1.5px solid var(--color-brand-600)` : undefined,
                  outlineOffset: isSelected ? '1px' : undefined,
                }}
              >
                <div className="sb-cell-nm" title={r.sector_name}>{r.sector_name}</div>
                <div className={`sb-cell-v ${c.muted ? 'sb-t' : ''}`} style={!c.muted ? { color: c.color } : undefined}>
                  {(r.avg_change > 0 ? '+' : '') + (r.avg_change ?? 0).toFixed(2)}
                </div>
              </Link>
            )
          })}
        </div>
      </div>

      {/* 上昇/下落 トップ */}
      <div className="sb-section" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
        <RankingTable title="上昇トップ" rows={top} kind="up" />
        <RankingTable title="下落トップ" rows={bottom} kind="down" />
      </div>

      {/* 選択中ドリルダウン */}
      {selected && (
        <div className="sb-section">
          <div className="sb-hd">
            <h2>選択中: {selected}</h2>
            <span>
              {subRows.length} 業種細分類 ·{' '}
              {subRows.reduce((a, r) => a + r.n_stocks, 0).toLocaleString()} 銘柄
            </span>
          </div>
          <div className="sb-card">
            <table className="sb-tbl">
              <thead>
                <tr>
                  <th>業種細分類</th>
                  <th style={{ textAlign: 'right', width: 50 }}>銘柄数</th>
                  <th style={{ textAlign: 'right', width: 54 }}>騰落率</th>
                  <th style={{ textAlign: 'right', width: 70 }}>ステ1+2 比率</th>
                  <th style={{ width: 120 }}>代表銘柄</th>
                </tr>
              </thead>
              <tbody>
                {subRows.map(r => {
                  const tone = r.avg_change > 0 ? 'sb-r' : r.avg_change < 0 ? 'sb-b' : ''
                  const params = new URLSearchParams({ selected: r.sub_industry })
                  const top3 = (r.topTickers ?? '').split(',').filter(Boolean).slice(0, 3)
                  return (
                    <tr key={r.sub_industry}>
                      <td>
                        <Link
                          href={`/industries?${params.toString()}`}
                          style={{ color: 'inherit', fontWeight: 500 }}
                        >
                          {r.sub_industry}
                        </Link>
                      </td>
                      <td className="right sb-t">{r.n_stocks.toLocaleString()}</td>
                      <td className={`right ${tone}`} style={{ fontWeight: 500 }}>
                        {(r.avg_change > 0 ? '+' : '') + r.avg_change.toFixed(2)}
                      </td>
                      <td className="right sb-t">{(r.upRatio * 100).toFixed(0)}%</td>
                      <td className="sb-t" style={{ fontSize: 11 }}>
                        {top3.map(t => (
                          <Link key={t} href={`/stock/${t}`} style={{ marginRight: 6, color: 'inherit' }}>
                            {t}
                          </Link>
                        ))}
                      </td>
                    </tr>
                  )
                })}
                {subRows.length === 0 && (
                  <tr>
                    <td colSpan={5} style={{ textAlign: 'center', padding: 14, color: 'var(--color-text-tertiary)' }}>
                      業種細分類データなし
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  )
}

function RankingTable({
  title,
  rows,
  kind,
}: {
  title: string
  rows: { sector_name: string; n_stocks: number; avg_change: number; stage_up_count: number; stage_down_count: number }[]
  kind: 'up' | 'down'
}) {
  const stageLabel = kind === 'up' ? 'ステ1+2' : 'ステ4+5'
  return (
    <div>
      <div className="sb-hd">
        <h2 className="sb-h2-sm">{title}</h2>
        <span className={kind === 'up' ? 'sb-r' : 'sb-b'}>本日</span>
      </div>
      <div className="sb-card">
        <table className="sb-tbl">
          <thead>
            <tr>
              <th>大分類</th>
              <th style={{ textAlign: 'right', width: 50 }}>騰落率</th>
              <th style={{ textAlign: 'right', width: 50 }}>銘柄数</th>
              <th style={{ textAlign: 'right', width: 56 }}>{stageLabel}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(r => {
              const tone = r.avg_change > 0 ? 'sb-r' : r.avg_change < 0 ? 'sb-b' : ''
              const stageCount = kind === 'up' ? r.stage_up_count : r.stage_down_count
              const params = new URLSearchParams({ selected: r.sector_name })
              return (
                <tr key={r.sector_name}>
                  <td>
                    <Link href={`/sectors?${params.toString()}`} style={{ color: 'inherit' }}>
                      {r.sector_name}
                    </Link>
                  </td>
                  <td className={`right ${tone}`} style={{ fontWeight: 500 }}>
                    {(r.avg_change > 0 ? '+' : '') + r.avg_change.toFixed(2)}
                  </td>
                  <td className="right sb-t">{r.n_stocks.toLocaleString()}</td>
                  <td className="right sb-t">{stageCount.toLocaleString()}</td>
                </tr>
              )
            })}
            {rows.length === 0 && (
              <tr>
                <td colSpan={4} style={{ textAlign: 'center', padding: 14, color: 'var(--color-text-tertiary)' }}>
                  データなし
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}
