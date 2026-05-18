// components/dashboard/IndicesGrid.tsx
// Phase 4 B3: 6 列の指数カード行。indices_daily 由来 (TOPIX/グロース250/プライム/スタンダード)
// + 騰落レシオ (自前計算) + 日経225 (JPX 配信外なので未接続)

import { getDashboardIndices } from '@/lib/queries/dashboard'

function fmt(v: number | null, label: string): string {
  if (v == null || !Number.isFinite(v)) return '---'
  const decimals = label === '騰落レシオ' ? 1 : 2
  return v.toLocaleString('ja-JP', { minimumFractionDigits: decimals, maximumFractionDigits: decimals })
}

export async function IndicesGrid() {
  const indices = await getDashboardIndices()
  return (
    <div style={{ display: 'grid', gridTemplateColumns: `repeat(${indices.length}, 1fr)`, gap: 8 }}>
      {indices.map(idx => {
        const hasValue = idx.value != null
        const tone =
          idx.changePct == null ? '' :
          idx.changePct > 0 ? 'sb-r' :
          idx.changePct < 0 ? 'sb-b' :
          'sb-t'
        return (
          <div
            key={idx.code}
            style={{
              border: '0.5px solid var(--color-border-soft)',
              borderRadius: 6,
              background: 'var(--color-surface-base)',
              padding: '10px 12px',
            }}
          >
            <div className="sb-t" style={{ fontSize: 11 }}>{idx.label}</div>
            <div
              style={{
                marginTop: 2,
                fontSize: 17,
                fontWeight: 500,
                fontVariantNumeric: 'tabular-nums',
                letterSpacing: '-0.02em',
                lineHeight: 1.1,
              }}
            >
              {hasValue ? fmt(idx.value, idx.label) : '---'}
            </div>
            <div className={`sb-t ${tone}`} style={{ fontSize: 10, fontVariantNumeric: 'tabular-nums', marginTop: 2 }}>
              {idx.changePct == null
                ? <span className="sb-t">{idx.note ?? 'データ未接続'}</span>
                : (idx.changePct > 0 ? '+' : '') + idx.changePct.toFixed(2) + '%'}
            </div>
          </div>
        )
      })}
    </div>
  )
}
