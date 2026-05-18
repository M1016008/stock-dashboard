// app/industries/page.tsx
// モック準拠 (stockboard_industries_mock):
//   - 検索バー (placeholder) + chip フィルタ + 「+ 絞り込み」
//   - 注目業界テーブル (絞り込み結果): 業界 / 大分類 / 銘柄数 / 騰落率 / ステ分布 (3 個 ts)
//   - 選択中業界 (?selected=) の銘柄詳細テーブル: コード / 銘柄名 / 6 ステージ / 株価 / 前日比 / 時価総額

import type { Metadata } from 'next'
import Link from 'next/link'
import { IndustriesFilterMock } from '@/components/industries/IndustriesFilterMock'
import { getIndustryList, getMajorList, getIndustryStocks } from '@/lib/queries/industries'

export const metadata: Metadata = {
  title: '業界別 — StockBoard',
  description: '476 業界 (AI / クラウド / バイオ / 半導体 等) でテーマ的に深掘り',
}

export const dynamic = 'force-dynamic'
export const revalidate = 0
export const fetchCache = 'force-no-store'

function fmtMarketCap(v: number | null): string {
  if (v == null) return '—'
  if (v >= 1e12) return (v / 1e12).toFixed(2) + '兆'
  if (v >= 1e8) return Math.round(v / 1e8).toLocaleString() + '億'
  return v.toLocaleString()
}

function topStageTags(r: { stage1Count: number; stage2Count: number; stage4Count: number }): { stage: number; count: number }[] {
  // モックは上位 3 ステージを表示するので、stage1/2/4 のうち上位 3 個を出す。
  // (集計は今は 1/2/4 のみだが、足りなければ 0 を出さない)
  const arr = [
    { stage: 1, count: r.stage1Count },
    { stage: 2, count: r.stage2Count },
    { stage: 4, count: r.stage4Count },
  ]
  return arr.filter(a => a.count > 0).sort((a, b) => b.count - a.count).slice(0, 3)
}

export default async function IndustriesPage({
  searchParams,
}: {
  searchParams: Promise<{ selected?: string; major?: string; q?: string; sort?: string }>
}) {
  const sp = await searchParams
  const selected = sp.selected ?? null
  const major = sp.major ?? null
  const q = sp.q ?? ''
  const sort = sp.sort ?? 'change_desc'

  const [{ rows }, majorList, stocks] = await Promise.all([
    getIndustryList({ q, major: major ?? undefined, sort }),
    getMajorList(),
    selected ? getIndustryStocks(selected, 80) : Promise.resolve([]),
  ])

  const SORT_LABEL: Record<string, string> = {
    change_desc: '騰落率 ↓',
    change_asc:  '騰落率 ↑',
    count_desc:  '銘柄数 ↓',
    name_asc:    '名前順',
  }
  const filterCount = [major, q].filter(Boolean).length

  return (
    <div className="sb-page">
      <div className="sb-page-title">
        <h1>業界別 (業種細分類)</h1>
        <p>476 業界 (AI / クラウド / バイオ / 半導体 など) でテーマ的に深掘り</p>
      </div>

      {/* 検索 + フィルタ */}
      <div className="sb-section">
        <IndustriesFilterMock q={q} majorFilter={major} sort={sort} majorList={majorList} />
      </div>

      {/* 注目業界テーブル */}
      <div className="sb-section">
        <div className="sb-hd">
          <h2>
            {filterCount > 0
              ? `注目業界 (絞り込み結果: ${rows.length} 業界)`
              : `全業界一覧 (${rows.length} 業界)`}
          </h2>
          <span>並べ替え: {SORT_LABEL[sort]}</span>
        </div>
        <div className="sb-card">
          <table className="sb-tbl">
            <thead>
              <tr>
                <th>業界</th>
                <th className="sb-t" style={{ fontSize: 11 }}>大分類</th>
                <th style={{ textAlign: 'right', width: 50 }}>銘柄数</th>
                <th style={{ textAlign: 'right', width: 54 }}>騰落率</th>
                <th style={{ textAlign: 'right', width: 84 }}>ステ分布</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(r => {
                const tone = r.avg_change > 0 ? 'sb-r' : r.avg_change < 0 ? 'sb-b' : ''
                const params = new URLSearchParams({ selected: r.sub_industry })
                const tags = topStageTags(r)
                return (
                  <tr key={r.sub_industry + '_' + r.major_category}>
                    <td>
                      <Link href={`/industries?${params.toString()}`} style={{ color: 'inherit', fontWeight: 500 }}>
                        {r.sub_industry}
                      </Link>
                    </td>
                    <td className="sb-t" style={{ fontSize: 11 }}>{r.major_category}</td>
                    <td className="right">{r.n_stocks.toLocaleString()}</td>
                    <td className={`right ${tone}`} style={{ fontWeight: 500 }}>
                      {(r.avg_change > 0 ? '+' : '') + r.avg_change.toFixed(2)}
                    </td>
                    <td className="right">
                      {tags.length === 0 ? (
                        <span className="sb-t">—</span>
                      ) : (
                        tags.map(t => (
                          <span key={t.stage} className={`sb-ts sb-s${t.stage}`}>{t.stage}</span>
                        ))
                      )}
                    </td>
                  </tr>
                )
              })}
              {rows.length === 0 && (
                <tr>
                  <td colSpan={5} style={{ textAlign: 'center', padding: 14, color: 'var(--color-text-tertiary)' }}>
                    該当業界なし
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* 選択中ドリルダウン */}
      {selected && (
        <div className="sb-section">
          <div className="sb-hd">
            <h2>選択中: {selected} 業界</h2>
            <span>
              {stocks.length} 銘柄
              {stocks.length >= 80 ? ' (上位 80 件)' : ''}
            </span>
          </div>
          <div className="sb-card">
            <table className="sb-tbl">
              <thead>
                <tr>
                  <th style={{ width: 44 }}>コード</th>
                  <th>銘柄名</th>
                  <th style={{ width: 110 }}>6 ステージ</th>
                  <th style={{ textAlign: 'right', width: 60 }}>株価</th>
                  <th style={{ textAlign: 'right', width: 54 }}>前日比</th>
                  <th style={{ textAlign: 'right', width: 60 }}>時価総額</th>
                </tr>
              </thead>
              <tbody>
                {stocks.slice(0, 30).map(r => {
                  const tone = r.changePct == null ? '' : r.changePct > 0 ? 'sb-r' : r.changePct < 0 ? 'sb-b' : ''
                  return (
                    <tr key={r.ticker}>
                      <td className="sb-t">{r.ticker}</td>
                      <td>
                        <Link href={`/stock/${r.ticker}`} style={{ color: 'inherit' }}>
                          {r.name ?? r.ticker}
                        </Link>
                      </td>
                      <td>
                        {[r.daily_a, r.daily_b, r.weekly_a, r.weekly_b, r.monthly_a, r.monthly_b].map((s, i) => (
                          <span key={i} className={`sb-ts ${s ? `sb-s${s}` : ''}`}>{s ?? '−'}</span>
                        ))}
                      </td>
                      <td className="right" style={{ fontWeight: 500 }}>{r.price?.toLocaleString() ?? '—'}</td>
                      <td className={`right ${tone}`}>
                        {r.changePct == null ? '—' : (r.changePct > 0 ? '+' : '') + r.changePct.toFixed(2)}
                      </td>
                      <td className="right">{fmtMarketCap(r.marketCap)}</td>
                    </tr>
                  )
                })}
                {stocks.length === 0 && (
                  <tr>
                    <td colSpan={6} style={{ textAlign: 'center', padding: 14, color: 'var(--color-text-tertiary)' }}>
                      該当銘柄なし
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          {stocks.length > 30 && (
            <div style={{ marginTop: 8, fontSize: 11, color: 'var(--color-text-tertiary)', textAlign: 'right' }}>
              残り {stocks.length - 30} 銘柄 ↗
            </div>
          )}
        </div>
      )}
    </div>
  )
}
