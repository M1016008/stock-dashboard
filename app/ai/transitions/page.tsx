// app/ai/transitions/page.tsx
// モック準拠 (stockboard_pattern_transitions_mock):
//   - 検索バー + 「上位パターンから選択」
//   - ヒーローカード (sb-card-pad-lg, bg #fafaf9): 26px パターンコード + 6 ステージタグ + 過去出現
//   - 4 ホライゾン KPI (30/60/90/180 日)
//   - 2 列: 60日後リターン分布 (9 バーヒストグラム + 25/中央/75) / 業種別出現分布 (横バー)
//   - 過去のサンプルケース テーブル

import type { Metadata } from 'next'
import Link from 'next/link'
import { PatternSearchMock } from '@/components/ai/PatternSearchMock'
import {
  getDefaultPatternCode,
  getPatternMeta,
  getHorizonStats,
  getTopPatterns,
  getReturnDistribution,
  getSectorBreakdown,
  getSampleCases,
} from '@/lib/queries/transitions'
import { getUniverseFilterMeta, parseUniverseFilter } from '@/lib/market-universe'

export const metadata: Metadata = {
  title: 'パターン遷移分析 — StockBoard',
  description: '6 タイムスケールの組み合わせから過去の類似ケースを統計的に観察',
}

export const dynamic = 'force-dynamic'
export const revalidate = 0
export const fetchCache = 'force-no-store'

const STAGE_LABEL = ['日A', '日B', '週A', '週B', '月A', '月B']

function toneClass(v: number | null): string {
  if (v == null) return ''
  return v > 0 ? 'sb-r' : v < 0 ? 'sb-b' : ''
}
function fmtPct(v: number | null, decimals = 1): string {
  if (v == null) return '—'
  return (v > 0 ? '+' : '') + v.toFixed(decimals)
}

export default async function TransitionsPage({
  searchParams,
}: {
  searchParams: Promise<{ code?: string; horizon?: string; universe?: string | string[] }>
}) {
  const sp = await searchParams
  const fallback = await getDefaultPatternCode()
  const code = /^\d{6}$/.test(sp.code ?? '') ? sp.code! : (fallback ?? '111111')
  const horizonDays = sp.horizon && /^\d+$/.test(sp.horizon) ? parseInt(sp.horizon, 10) : 60
  const universeFilter = parseUniverseFilter(sp.universe)
  const universeMeta = getUniverseFilterMeta(universeFilter)

  const [meta, horizonRows, top, dist, sectors, samples] = await Promise.all([
    getPatternMeta(code),
    getHorizonStats(code),
    getTopPatterns(12),
    getReturnDistribution(code, horizonDays),
    getSectorBreakdown(code, 7, universeFilter),
    getSampleCases(code, 10, universeFilter),
  ])

  const stages = code.split('').map(c => parseInt(c, 10))
  const sectorMax = sectors.reduce((m, s) => Math.max(m, s.count), 0)
  const distMax = dist.bins.reduce((m, b) => Math.max(m, b.count), 0)

  return (
    <div className="sb-page">
      <div className="sb-page-title">
        <h1>パターン遷移分析</h1>
        <p>
          6 タイムスケールの組み合わせから過去の類似ケースを統計的に観察します
          {universeMeta ? `（${universeMeta.shortLabel}フィルター中）` : ''}
        </p>
        <div style={{ marginTop: 10 }}>
          <PatternSearchMock currentCode={code} topPatterns={top} />
        </div>
      </div>

      {/* ヒーローカード */}
      <div className="sb-section">
        <div
          className="sb-card sb-card-pad-lg"
          style={{ background: 'var(--color-surface-subtle)' }}
        >
          <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 14 }}>
            <div>
              <div className="sb-t" style={{ fontSize: 11, marginBottom: 4 }}>選択中パターン</div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
                <div style={{ fontSize: 26, fontWeight: 500, fontVariantNumeric: 'tabular-nums', letterSpacing: '0.08em' }}>
                  {code}
                </div>
                <div style={{ display: 'flex', gap: 2 }}>
                  {stages.map((s, i) => (
                    <span key={i} className={`sb-ts sb-s${s}`}>{s}</span>
                  ))}
                </div>
              </div>
              <div className="sb-t" style={{ fontSize: 10, marginTop: 4, letterSpacing: 0.5 }}>
                {STAGE_LABEL.join(' · ')}
              </div>
            </div>
            <div style={{ textAlign: 'right' }}>
              <div className="sb-t" style={{ fontSize: 11 }}>過去出現</div>
              <div style={{ fontSize: 22, fontWeight: 500, fontVariantNumeric: 'tabular-nums', letterSpacing: 0 }}>
                {meta?.count_60d.toLocaleString() ?? '—'} 回
              </div>
              {meta?.lastDate && (
                <div className="sb-t" style={{ fontSize: 10, marginTop: 2 }}>
                  直近: {meta.lastDate}
                </div>
              )}
            </div>
          </div>
          <div
            style={{
              fontSize: 11,
              color: 'var(--color-text-secondary)',
              lineHeight: 1.5,
              paddingTop: 12,
              borderTop: '0.5px solid var(--color-border-soft)',
            }}
          >
            特徴: 6 桁のステージ並びは <span style={{ fontWeight: 500 }}>{code}</span>。
            横軸は日足A / 日足B / 週足A / 週足B / 月足A / 月足B の現在ステージを表します。
          </div>
        </div>
      </div>

      {/* 4 ホライゾン KPI */}
      <div className="sb-section">
        <div className="sb-hd">
          <h2>フォワードリターン (出現後)</h2>
          <span>n={meta?.count_60d.toLocaleString() ?? '—'} · 中央値</span>
        </div>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {[30, 60, 90, 180].map(h => {
            const r = horizonRows.find(x => x.horizon_days === h)
            return (
              <div key={h} className="sb-card sb-card-pad">
                <div className="sb-kpi">
                  <span className="sb-kpi-lbl">{h}日後</span>
                  <span className={`sb-kpi-v ${toneClass(r?.p50 ?? null)}`}>
                    {r?.p50 == null ? '—' : (r.p50 > 0 ? '+' : '') + r.p50.toFixed(1) + '%'}
                  </span>
                  <span className="sb-kpi-sub">
                    勝率 {r ? (r.winRate * 100).toFixed(0) : '—'}% · n={r?.count.toLocaleString() ?? '—'}
                  </span>
                </div>
              </div>
            )
          })}
        </div>
      </div>

      {/* 2 列: 分布 + 業種分布 */}
      <div className="sb-section grid grid-cols-1 gap-3.5 md:grid-cols-2">
        <div>
          <div className="sb-hd">
            <h2>{horizonDays}日後リターン分布</h2>
            <span>n={dist.total.toLocaleString()}</span>
          </div>
          <div className="sb-card sb-card-pad">
            <div style={{ display: 'flex', alignItems: 'flex-end', gap: 3, height: 80, fontVariantNumeric: 'tabular-nums' }}>
              {dist.bins.map((b, i) => {
                const h = distMax > 0 ? (b.count / distMax) * 100 : 0
                const isNeg = b.upper <= 0
                const isPos = b.lower >= 10
                const bg = isNeg
                  ? (b.upper <= -10 ? '#dbeafe' : '#fee2e2')  // < -10 青系、-10〜0 薄赤
                  : isPos
                  ? '#dcfce7'   // +10 以上 緑系
                  : '#fee2e2'   // 0〜+10 薄赤
                return (
                  <div
                    key={i}
                    style={{
                      flex: 1,
                      background: bg,
                      height: `${Math.max(2, h)}%`,
                      borderRadius: '2px 2px 0 0',
                    }}
                    title={`${b.lower}〜${b.upper}%: ${b.count}`}
                  />
                )
              })}
            </div>
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                marginTop: 6,
                fontSize: 10,
                color: 'var(--color-text-tertiary)',
                fontVariantNumeric: 'tabular-nums',
              }}
            >
              <span>-30%</span><span>-20%</span><span>-10%</span><span>0</span><span>+10%</span><span>+20%</span><span>+30%</span>
            </div>
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                marginTop: 10,
                paddingTop: 10,
                borderTop: '0.5px solid var(--color-border-soft)',
                fontSize: 11,
                fontVariantNumeric: 'tabular-nums',
              }}
            >
              <span>
                <span className="sb-t" style={{ fontSize: 10 }}>25%分位</span>{' '}
                <span style={{ fontWeight: 500 }}>{fmtPct(dist.p25, 2)}%</span>
              </span>
              <span>
                <span className="sb-t" style={{ fontSize: 10 }}>中央値</span>{' '}
                <span style={{ fontWeight: 500 }} className={toneClass(dist.p50)}>{fmtPct(dist.p50, 2)}%</span>
              </span>
              <span>
                <span className="sb-t" style={{ fontSize: 10 }}>75%分位</span>{' '}
                <span style={{ fontWeight: 500 }}>{fmtPct(dist.p75, 2)}%</span>
              </span>
            </div>
          </div>
        </div>

        <div>
          <div className="sb-hd">
            <h2>業種別出現分布</h2>
            <span>n={sectors.reduce((a, s) => a + s.count, 0).toLocaleString()}</span>
          </div>
          <div className="sb-card" style={{ padding: '12px 14px' }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, fontSize: 11, fontVariantNumeric: 'tabular-nums' }}>
              {sectors.map(s => {
                const widthPct = sectorMax > 0 ? (s.count / sectorMax) * 100 : 0
                return (
                  <div key={s.sector_name} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span
                      style={{
                        width: 110,
                        color: 'var(--color-text-secondary)',
                        whiteSpace: 'nowrap',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                      }}
                      title={s.sector_name}
                    >
                      {s.sector_name}
                    </span>
                    <div
                      style={{
                        flex: 1,
                        height: 6,
                        background: 'var(--color-surface-subtle)',
                        borderRadius: 3,
                        overflow: 'hidden',
                      }}
                    >
                      <div style={{ width: `${widthPct}%`, height: '100%', background: '#0e7490' }} />
                    </div>
                    <span style={{ width: 32, textAlign: 'right', fontWeight: 500 }}>{s.count.toLocaleString()}</span>
                  </div>
                )
              })}
              {sectors.length === 0 && (
                <div style={{ textAlign: 'center', padding: 14, color: 'var(--color-text-tertiary)' }}>データなし</div>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* サンプルケース */}
      <div className="sb-section">
        <div className="sb-hd">
          <h2>過去のサンプルケース</h2>
          <span>+180日まで計算済み {samples.length} 件 · 統計対象 {meta?.count_60d.toLocaleString() ?? '—'} 件</span>
        </div>
        <div className="sb-card">
          <div className="overflow-x-auto">
          <table className="sb-tbl" style={{ minWidth: 600 }}>
            <thead>
              <tr>
                <th style={{ width: 80 }}>出現日</th>
                <th style={{ width: 44 }}>コード</th>
                <th>銘柄</th>
                <th className="sb-t" style={{ fontSize: 11, width: 100 }}>業種</th>
                <th style={{ textAlign: 'right', width: 54 }}>+30日</th>
                <th style={{ textAlign: 'right', width: 54 }}>+60日</th>
                <th style={{ textAlign: 'right', width: 54 }}>+90日</th>
                <th style={{ textAlign: 'right', width: 58 }}>+180日</th>
              </tr>
            </thead>
            <tbody>
              {samples.map(r => (
                <tr key={r.ticker + r.date}>
                  <td className="sb-t">{r.date}</td>
                  <td className="sb-t">{r.ticker}</td>
                  <td>
                    <Link href={`/stock/${r.ticker}`} style={{ color: 'inherit' }}>
                      {r.name ?? r.ticker}
                    </Link>
                  </td>
                  <td className="sb-t" style={{ fontSize: 11 }}>{r.sector ?? '—'}</td>
                  <td className={`right ${toneClass(r.r30)}`}>{fmtPct(r.r30, 1)}</td>
                  <td className={`right ${toneClass(r.r60)}`}>{fmtPct(r.r60, 1)}</td>
                  <td className={`right ${toneClass(r.r90)}`}>{fmtPct(r.r90, 1)}</td>
                  <td className={`right ${toneClass(r.r180)}`}>{fmtPct(r.r180, 1)}</td>
                </tr>
              ))}
              {samples.length === 0 && (
                <tr>
                  <td colSpan={8} style={{ textAlign: 'center', padding: 14, color: 'var(--color-text-tertiary)' }}>
                    サンプルケースなし
                  </td>
                </tr>
              )}
            </tbody>
          </table>
          </div>
        </div>
        {meta && meta.count_60d > samples.length && (
          <div style={{ marginTop: 8, fontSize: 11, color: 'var(--color-text-tertiary)', textAlign: 'right' }}>
            上表はリターンが確定済みの代表ケースです
          </div>
        )}
      </div>
    </div>
  )
}
