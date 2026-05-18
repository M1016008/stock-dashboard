// components/dashboard/TodayTransitionsSummary.tsx
// Phase 4 B5: 本日のステージ遷移サマリー (6 軸の件数)

import Link from 'next/link'
import { Card, CardHeader } from '@/components/ui/Card'
import { getTodayTransitionCounts } from '@/lib/queries/dashboard'

const AXES = [
  { key: 'daily_a',   label: '日足 A' },
  { key: 'daily_b',   label: '日足 B' },
  { key: 'weekly_a',  label: '週足 A' },
  { key: 'weekly_b',  label: '週足 B' },
  { key: 'monthly_a', label: '月足 A' },
  { key: 'monthly_b', label: '月足 B' },
] as const

export async function TodayTransitionsSummary() {
  const counts = await getTodayTransitionCounts()
  return (
    <Card size="sm">
      <CardHeader
        title="本日のステージ遷移"
        action={<Link href="/hex-stage" className="hover:text-[var(--color-text-secondary)]">HEX で詳細 ↗</Link>}
      />
      {!counts ? (
        <div className="py-6 text-center text-[11px] text-[var(--color-text-tertiary)]">前日との比較データなし</div>
      ) : (
        <div className="grid grid-cols-3 gap-2">
          {AXES.map(a => {
            const n = (counts as unknown as Record<string, number>)[a.key] ?? 0
            return (
              <div key={a.key} className="rounded-[6px] bg-[var(--color-surface-subtle)] px-2.5 py-2">
                <div className="text-[10px] text-[var(--color-text-tertiary)]">{a.label}</div>
                <div className="tabular-nums text-[17px] font-medium leading-tight">{n.toLocaleString()}</div>
                <div className="text-[10px] text-[var(--color-text-tertiary)]">銘柄が遷移</div>
              </div>
            )
          })}
        </div>
      )}
    </Card>
  )
}
