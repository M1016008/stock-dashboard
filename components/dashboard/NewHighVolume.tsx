// components/dashboard/NewHighVolume.tsx
// Phase 4 B7: 新高値・新安値・出来高急増

import Link from 'next/link'
import { Card, CardHeader } from '@/components/ui/Card'
import { getNewHighVolume } from '@/lib/queries/dashboard'

function fmtPct(v: number | null) {
  if (v == null) return '---'
  return (v >= 0 ? '+' : '') + v.toFixed(2) + '%'
}

function tagStyle(type: string): { bg: string; text: string } {
  if (type === '新高値') return { bg: 'var(--color-price-up-bg)', text: 'var(--color-price-up)' }
  if (type === '新安値') return { bg: 'var(--color-price-down-bg)', text: 'var(--color-price-down)' }
  return { bg: 'var(--color-pattern-50)', text: 'var(--color-pattern-700)' }
}

export async function NewHighVolume() {
  const rows = await getNewHighVolume(6)
  return (
    <Card size="sm">
      <CardHeader title="新高値・出来高急増" hint="252日基準" />
      {rows.length === 0 ? (
        <div className="py-6 text-center text-[11px] text-[var(--color-text-tertiary)]">該当なし</div>
      ) : (
        <div className="divide-y divide-[var(--color-border-soft)]">
          <div className="grid grid-cols-[44px_1fr_64px_56px] gap-2 px-1 pb-1.5 text-[10px] text-[var(--color-text-tertiary)]">
            <span>コード</span><span>銘柄</span><span>タイプ</span><span className="text-right">変化率</span>
          </div>
          {rows.map(r => {
            const styleObj = tagStyle(r.type)
            const tone = r.changePct > 0 ? 'text-[var(--color-price-up)]' : r.changePct < 0 ? 'text-[var(--color-price-down)]' : ''
            // 出来高比率 "2.30x量" を短縮 → "2.3x量"
            const typeLabel = /^\d/.test(r.type)
              ? r.type.replace(/^(\d+(?:\.\d)?).*/, '$1') + 'x 量'
              : r.type
            return (
              <Link
                key={r.ticker + r.type}
                href={`/stock/${r.ticker}`}
                className="grid grid-cols-[44px_1fr_64px_56px] gap-2 px-1 py-1.5 text-[12px] hover:bg-[var(--color-surface-subtle)]"
              >
                <span className="tabular-nums text-[var(--color-text-secondary)]">{r.ticker}</span>
                <span className="truncate">{r.name ?? r.ticker}</span>
                <span
                  className="inline-flex items-center justify-center rounded-[4px] px-1.5 text-[10px] tabular-nums"
                  style={{ backgroundColor: styleObj.bg, color: styleObj.text }}
                >
                  {typeLabel}
                </span>
                <span className={`tabular-nums text-right ${tone}`}>{fmtPct(r.changePct)}</span>
              </Link>
            )
          })}
        </div>
      )}
    </Card>
  )
}
