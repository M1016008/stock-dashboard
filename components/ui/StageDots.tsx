// components/ui/StageDots.tsx
// HEX ステージ 6系統（日A/日B/週A/週B/月A/月B）を色付きの小さな四角で並べる。

import { STAGE_BG_COLORS, STAGE_BORDER_COLORS } from '@/lib/hex-stage'

export function StageDots({
  values,
  size = 20,
}: {
  values: (number | null | undefined)[]
  size?: number
}) {
  return (
    <div style={{ display: 'flex', gap: '3px' }}>
      {values.map((v, i) => (
        <span
          key={i}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: `${size}px`,
            height: `${size}px`,
            fontSize: `${Math.max(10, size - 10)}px`,
            fontWeight: 700,
            fontFamily: 'var(--font-mono)',
            background: v ? STAGE_BG_COLORS[v] : 'transparent',
            color: v ? STAGE_BORDER_COLORS[v] : 'var(--text-muted)',
            border: v ? `1px solid ${STAGE_BORDER_COLORS[v]}` : '1px dashed var(--border-base)',
            borderRadius: '4px',
          }}
          title={v ? `Stage ${v}` : '不明'}
        >
          {v ?? '-'}
        </span>
      ))}
    </div>
  )
}
