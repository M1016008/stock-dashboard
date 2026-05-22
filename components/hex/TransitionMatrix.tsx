// components/hex/TransitionMatrix.tsx
// Phase 4 C5: 6×6 遷移マトリクス (teal opacity ヒートマップ)

import { Card, CardHeader } from '@/components/ui/Card'
import { getTransitionMatrix, type Timescale, type Period } from '@/lib/queries/hex'

export async function TransitionMatrix({ timescale, period }: { timescale: Timescale; period: Period }) {
  const cells = await getTransitionMatrix(timescale, period)
  const max = cells.reduce((m, c) => Math.max(m, c.count), 0)
  const get = (from: number, to: number) => cells.find(c => c.from_stage === from && c.to_stage === to)?.count ?? 0

  // 最大流量メッセージ
  const topCell = [...cells].sort((a, b) => b.count - a.count)[0]
  const rareJumps = cells.filter(c => Math.abs(c.from_stage - c.to_stage) >= 3 && c.count > 0)

  return (
    <Card>
      <CardHeader title="ステージ遷移マトリクス" hint={`合計 ${cells.reduce((a, c) => a + c.count, 0).toLocaleString()} 件`} />
      <div className="grid grid-cols-[28px_repeat(6,1fr)] gap-px text-[11px] tabular-nums">
        <div></div>
        {[1, 2, 3, 4, 5, 6].map(s => (
          <div key={`th-${s}`} className="text-center text-[10px] text-[var(--color-text-tertiary)]">→{s}</div>
        ))}
        {[1, 2, 3, 4, 5, 6].map(from => (
          <>
            <div key={`rh-${from}`} className="flex items-center justify-end pr-1 text-[10px] text-[var(--color-text-tertiary)]">{from}→</div>
            {[1, 2, 3, 4, 5, 6].map(to => {
              const n = get(from, to)
              const isDiag = from === to
              const intensity = max > 0 ? n / max : 0
              return (
                <div
                  key={`cell-${from}-${to}`}
                  className={`flex h-8 items-center justify-center rounded-[3px] ${isDiag ? 'bg-[var(--color-surface-muted)] text-[var(--color-text-tertiary)]' : ''}`}
                  style={isDiag ? undefined : {
                    backgroundColor: `rgba(14, 116, 144, ${0.05 + intensity * 0.35})`,
                    color: intensity > 0.5 ? 'white' : 'var(--color-text-primary)',
                  }}
                  title={`${from}→${to}: ${n}`}
                >
                  {isDiag ? '−' : (n || '')}
                </div>
              )
            })}
          </>
        ))}
      </div>
      <div className="mt-3 flex flex-wrap items-baseline gap-3 text-[11px] text-[var(--color-text-secondary)]">
        {topCell && topCell.count > 0 && (
          <span>最大流量: <span className="tabular-nums font-medium">{topCell.from_stage} → {topCell.to_stage}</span> ({topCell.count.toLocaleString()} 件)</span>
        )}
        {rareJumps.length > 0 && (
          <span className="text-[var(--color-pattern-700)]">
            注目: 大ジャンプ{rareJumps.length} 件 (例 {rareJumps[0].from_stage}→{rareJumps[0].to_stage})
          </span>
        )}
      </div>
    </Card>
  )
}
