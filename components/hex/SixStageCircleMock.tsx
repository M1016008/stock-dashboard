// components/hex/SixStageCircleMock.tsx
// モック準拠: 6 ステージの大きなカード並び (角丸 8px、padding 12/10、Stage N + ステージ名 + 大数字 + サブ)

import { getStageCircle, type Timescale } from '@/lib/queries/hex'
import { STAGE_LABELS } from '@/lib/hex-stage'

const STAGE_FILL: Record<number, { bg: string; text: string }> = {
  1: { bg: '#dcfce7', text: '#14532d' },
  2: { bg: '#fef3c7', text: '#713f12' },
  3: { bg: '#fee2e2', text: '#7f1d1d' },
  4: { bg: '#fce7f3', text: '#831843' },
  5: { bg: '#dbeafe', text: '#1e3a8a' },
  6: { bg: '#f3e8ff', text: '#581c87' },
}

export async function SixStageCircleMock({ timescale }: { timescale: Timescale }) {
  const rows = await getStageCircle(timescale)
  const total = rows.reduce((a, r) => a + r.count, 0)
  if (total === 0) {
    return <div className="sb-card sb-card-pad sb-t" style={{ textAlign: 'center', fontSize: 12 }}>ステージ分布データなし</div>
  }
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(6, 1fr)', gap: 6 }}>
      {rows.map(r => {
        const fill = STAGE_FILL[r.stage]
        const pct = total > 0 ? (r.count / total) * 100 : 0
        const diffSign = r.diff > 0 ? '+' : r.diff < 0 ? '' : '±'
        return (
          <div
            key={r.stage}
            style={{
              background: fill.bg,
              color: fill.text,
              borderRadius: 8,
              padding: '12px 10px',
            }}
          >
            <div style={{ fontSize: 11, marginBottom: 4 }}>Stage {r.stage}</div>
            <div style={{ fontSize: 13, fontWeight: 500, lineHeight: 1.2, marginBottom: 8 }}>
              {STAGE_LABELS[r.stage]}
            </div>
            <div
              style={{
                fontSize: 22,
                fontWeight: 500,
                fontVariantNumeric: 'tabular-nums',
                letterSpacing: 0,
                lineHeight: 1,
              }}
            >
              {r.count.toLocaleString()}
            </div>
            <div
              style={{
                fontSize: 10,
                marginTop: 3,
                fontVariantNumeric: 'tabular-nums',
              }}
            >
              {pct.toFixed(1)}% · 先週比 {diffSign}{r.diff.toLocaleString()}
            </div>
          </div>
        )
      })}
    </div>
  )
}
