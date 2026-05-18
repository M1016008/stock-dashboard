// components/hex/PeriodCountTrendMock.tsx
// モック準拠 期間別件数推移カード (本日/今週/今月 + 横バー)

import { getPeriodCountTrend, type Timescale } from '@/lib/queries/hex'

export async function PeriodCountTrendMock({ timescale }: { timescale: Timescale }) {
  const rows = await getPeriodCountTrend(timescale)
  const max = Math.max(...rows.map(r => r.count), 1)
  const SUBS = ['—', '日平均', '日平均']

  return (
    <div>
      <div className="sb-hd">
        <h2 className="sb-h2-sm">期間別 件数推移</h2>
        <span>過去30日</span>
      </div>
      <div className="sb-card sb-card-pad">
        {rows.map((r, i) => {
          const widthPct = (r.count / max) * 100
          const intensity = i === 0 ? 1 : i === 1 ? 0.7 : 0.5
          const sub = i === 1 && r.count > 0 ? `${(r.count / 5).toFixed(1)} / 日 (5 営業日基準)`
                    : i === 2 && r.count > 0 ? `${(r.count / 20).toFixed(1)} / 日 (20 営業日基準)`
                    : '—'
          return (
            <div key={r.label} style={{ marginBottom: i < rows.length - 1 ? 14 : 0 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 4 }}>
                <span style={{ fontSize: 12, color: 'var(--color-text-secondary)' }}>{r.label}</span>
                <span style={{ fontSize: 18, fontWeight: 500, fontVariantNumeric: 'tabular-nums', letterSpacing: '-0.02em' }}>
                  {r.count.toLocaleString()}
                </span>
              </div>
              <div style={{ height: 4, background: 'var(--color-surface-subtle)', borderRadius: 2, overflow: 'hidden', marginBottom: 4 }}>
                <div
                  style={{
                    width: `${widthPct}%`,
                    height: '100%',
                    background: 'var(--color-brand-600)',
                    opacity: intensity,
                  }}
                />
              </div>
              {i > 0 && <div style={{ fontSize: 10, color: 'var(--color-text-tertiary)' }}>{sub}</div>}
            </div>
          )
        })}
      </div>
    </div>
  )
}
