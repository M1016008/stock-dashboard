// components/hex/TransitionDetailTableMock.tsx
// モック準拠 詳細テーブル: コード / 銘柄 / 6 タイムスケール現在ステージ / 前→今 / 株価 / 前日比 / 出来高

import Link from 'next/link'
import { getTransitionDetail, type Timescale, type Period } from '@/lib/queries/hex'

const AXIS_ORDER: Array<{ key: 'daily_a' | 'daily_b' | 'weekly_a' | 'weekly_b' | 'monthly_a' | 'monthly_b'; col: 'daily_a' | 'daily_b' | 'weekly_a' | 'weekly_b' | 'monthly_a' | 'monthly_b' }> = [
  { key: 'daily_a',   col: 'daily_a' },
  { key: 'daily_b',   col: 'daily_b' },
  { key: 'weekly_a',  col: 'weekly_a' },
  { key: 'weekly_b',  col: 'weekly_b' },
  { key: 'monthly_a', col: 'monthly_a' },
  { key: 'monthly_b', col: 'monthly_b' },
]

function fmtVol(v: number | null) {
  if (v == null) return '—'
  if (v >= 1_000_000) return (v / 1_000_000).toFixed(1) + 'M'
  if (v >= 1_000) return (v / 1_000).toFixed(0) + 'K'
  return v.toLocaleString()
}

export async function TransitionDetailTableMock({ timescale, period }: { timescale: Timescale; period: Period }) {
  const rows = await getTransitionDetail(timescale, period, 30)
  const total = rows.length
  const PERIOD_LABEL: Record<string, string> = { today: '本日', week: '今週', month: '今月' }

  return (
    <div>
      <div className="sb-hd">
        <h2>{PERIOD_LABEL[period]}のステージ変化 詳細</h2>
        <span>{timescale} · {total.toLocaleString()} 銘柄</span>
      </div>
      <div className="sb-card">
        <div className="overflow-x-auto">
        <table className="sb-tbl" style={{ minWidth: 600 }}>
          <thead>
            <tr>
              <th style={{ width: 44 }}>コード</th>
              <th>銘柄名</th>
              <th style={{ width: 130 }}>
                6 タイムスケール現在ステージ
                <br />
                <span style={{ fontSize: 9, letterSpacing: '0.5px', color: 'var(--color-text-tertiary)' }}>
                  日A 日B 週A 週B 月A 月B
                </span>
              </th>
              <th style={{ width: 78, textAlign: 'center' }}>前日→本日</th>
              <th style={{ width: 60, textAlign: 'right' }}>株価</th>
              <th style={{ width: 54, textAlign: 'right' }}>前日比</th>
              <th style={{ width: 54, textAlign: 'right' }}>出来高</th>
            </tr>
          </thead>
          <tbody>
            {rows.slice(0, 12).map(r => {
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
                    {AXIS_ORDER.map(a => {
                      const stage = (r as unknown as Record<string, number | null>)[a.col]
                      const sel = a.key === timescale
                      const cls = stage == null ? '' : `sb-s${stage}`
                      return (
                        <span
                          key={a.key}
                          className={`sb-ts ${cls}${sel ? ' sb-ts-sel' : ''}`}
                        >
                          {stage ?? '−'}
                        </span>
                      )
                    })}
                  </td>
                  <td style={{ textAlign: 'center', fontSize: 11 }}>
                    <span className={`sb-tag ${r.from_stage ? `sb-s${r.from_stage}` : ''}`}>{r.from_stage ?? '−'}</span>{' '}
                    →{' '}
                    <span className={`sb-tag ${r.to_stage ? `sb-s${r.to_stage}` : ''}`}>{r.to_stage ?? '−'}</span>
                  </td>
                  <td className="right" style={{ fontWeight: 500 }}>{r.price?.toLocaleString() ?? '—'}</td>
                  <td className={`right ${tone}`}>
                    {r.changePct == null ? '—' : (r.changePct > 0 ? '+' : '') + r.changePct.toFixed(2)}
                  </td>
                  <td className="right sb-t">{fmtVol(r.volume)}</td>
                </tr>
              )
            })}
            {total === 0 && (
              <tr><td colSpan={7} style={{ textAlign: 'center', padding: 18, color: 'var(--color-text-tertiary)' }}>該当銘柄なし</td></tr>
            )}
          </tbody>
        </table>
        </div>
      </div>
      {total > 12 && (
        <div style={{ marginTop: 8, fontSize: 11, color: 'var(--color-text-tertiary)', textAlign: 'right' }}>
          残り {(total - 12).toLocaleString()} 銘柄 ↗
        </div>
      )}
    </div>
  )
}
